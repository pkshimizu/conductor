/**
 * Issue #68: 管理画面：設定 の受け入れテスト
 *
 * 決めたこと（実装役はこれに合わせて作る）:
 * - 画面とサーバーで共有する型は新しいモジュール `src/settings-data.ts`（型だけ。web からも import type する）
 *   ```ts
 *   /** フォームの値。項目名は src/config.ts と同じ。数は入力どおりの文字列で持つ *\/
 *   export interface SettingsForm {
 *     github: {
 *       notify: string;
 *       columns: { ready: string; testing: string; implementing: string; reviewing: string; done: string; blocked: string };
 *     };
 *     limits: { rejections: string; objections: string; reviewers: string };
 *     merge: { approval: "human" | "auto" };
 *     poll_interval: string;
 *     language: string;
 *     screenshots: string;          // 空なら config.yaml に書かない（撮影しない）
 *     commands: { setup: string; test: string; acceptance: string; typecheck: string; build: string; format: string }; // format は空なら書かない
 *     protected: string[];
 *     roles: Record<Role, { allow: string[] }>;
 *     /** enabled は「Discord を使う」。false のときも channels・allowed_users は入力中の値として持つ *\/
 *     chat: { enabled: boolean; channels: { requirements: string; questions: string; notices: string }; allowed_users: string[] };
 *   }
 *   export interface SettingsData {
 *     repo: string;                 // config.github.repo（見るだけ）
 *     project: number;              // config.github.project（見るだけ）
 *     form: SettingsForm;           // config.yaml の値（既定値で埋めたもの）
 *     token: "set" | "unset";       // Discord のトークンがあるか。値そのものは入れない
 *     /** 役ごとの指示ファイル（.conductor/<役>/*.md）。name は "acceptance.md" のようにファイル名、ファイル名の順 *\/
 *     prompts: Record<Role, { name: string; text: string }[]>;
 *   }
 *   ```
 * - 読み書きは新しいモジュール `src/settings.ts`
 *   ```ts
 *   /** repoDir の .conductor/config.yaml と指示ファイルを読む。token は env の CONDUCTOR_DISCORD_TOKEN で決める *\/
 *   export function loadSettings(repoDir: string, env?: Readonly<Record<string, string | undefined>>): Promise<SettingsData>;
 *   /**
 *    * config.yaml の文（source）を form の値に書き換えた文を返す。github.repo・github.project はそのまま残す。
 *    * chat.enabled が false なら chat を丸ごと消し、true なら chat.type: discord も書く
 *    *\/
 *   export function applySettings(source: string, form: SettingsForm): string;
 *   export interface SaveSettingsDeps {
 *     repoDir: string;
 *     github: { createPullRequest(input: { head: string; title: string; body: string; base?: string }): Promise<{ number: number; url: string }> };
 *     base?: string;                // PR の向き先。省略したら "main"
 *   }
 *   /**
 *    * origin の base から新しいブランチを作り、origin の base の config.yaml に applySettings したものをコミットして push し、
 *    * PR を作る。repoDir のいまのブランチ・作業中のファイル（未コミットの変更・追跡外のファイル）には触らない。
 *    * form が config.ts の決まりに合わなければ、何もせずに reject する
 *    *\/
 *   export function saveSettings(deps: SaveSettingsDeps, form: SettingsForm): Promise<{ number: number; url: string; branch: string }>;
 *   ```
 * - `src/admin-server.ts` の AdminServerOptions に `settings?: { load(): Promise<SettingsData>; save(form: SettingsForm): Promise<{ number: number; url: string }> }` を足す
 *   - `GET /api/settings` は load() の結果を JSON で返す
 *   - `POST /api/settings`（本文は JSON `{ "form": SettingsForm }`）は save(form) を呼び、終わったら 200 で JSON `{ number, url }` を返す。
 *     save が失敗したら 2xx 以外。Origin の決まりは停止・再起動と同じ（ほかの Origin は 403 にして何もしない）
 * - 画面の状態は新しいモジュール `web/src/settings-state.ts`（ブラウザの globals に触らない）
 *   ```ts
 *   export type SettingsTab = "general" | "commands" | "perms" | "discord" | "prompts";
 *   export interface SettingsState {
 *     form: SettingsForm;                         // 入力中の値
 *     tab: SettingsTab;                           // 出しているタブ
 *     dialog?: "diff";                            // 差分の確認ダイアログ
 *     saved?: { number: number; url: string };    // 保存して作った PR
 *     prompt?: { role: Role; file?: string };     // 指示ファイルのタブで出している役とファイル（省略時は最初の役・最初のファイル）
 *   }
 *   export const SETTINGS_PATH: string;           // "/api/settings"
 *   export function initSettings(data: SettingsData): SettingsState;                     // form は data.form、tab は "general"
 *   export function discardSettings(state: SettingsState, data: SettingsData): SettingsState; // 「変更を取り消す」。form を data.form に戻す
 *   export function reviewSettings(state: SettingsState, data: SettingsData): SettingsState;  // 「差分を確認して保存」。誤りが無く変更があるときだけ dialog: "diff"
 *   export function cancelSettings(state: SettingsState): SettingsState;                 // ダイアログの「キャンセル」。閉じるだけ
 *   /**
 *    * ダイアログの「保存して PR を作成」。ダイアログを閉じて update を呼び、post(SETTINGS_PATH, state.form) で頼み、
 *    * ok なら返った JSON の { number, url } を saved に入れて update を呼ぶ。最後の状態を返す。
 *    * 画面は post に (p, form) => fetch(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ form }) }) を渡す
 *    *\/
 *   export function confirmSettings(
 *     state: SettingsState,
 *     post: (path: string, form: SettingsForm) => Promise<{ ok: boolean; json(): Promise<unknown> }>,
 *     update: (state: SettingsState) => void,
 *   ): Promise<SettingsState>;
 *   ```
 * - 画面は `web/src/Settings.tsx`。react-dom/server で描けること
 *   ```ts
 *   export interface SettingsProps {
 *     data: SettingsData;            // 読み込んだ値（変更の有無はこれと state.form を比べる）
 *     state: SettingsState;
 *     lang: "ja" | "en";
 *     onState?: (state: SettingsState) => void;
 *     onSave?: () => void;           // ダイアログの「保存して PR を作成」
 *     onRestart?: () => void;        // 保存後の案内の「再起動」
 *   }
 *   export function Settings(props: SettingsProps): ReactElement;
 *   ```
 *   - タブは `<button role="tab" aria-selected>`（基本・コマンドとファイル・役の許可・窓口（Discord）・指示ファイル）。
 *     出すのは選んでいるタブの項目だけ。誤りがあるタブには「<件数>件の誤り」（aria-label でも文でもよい）、
 *     誤りが無く変更があるタブには「変更あり」を、そのタブのボタンの中に出す
 *   - 入力欄（input・select・textarea）には、辞書の文言の名前を付ける（`<label for>`、入力欄を包む `<label>`、aria-label のどれか）。
 *     列の名前の欄は列名（Ready・Testing・Implementing・Reviewing・Done・Blocked）、コマンドの欄は項目名（setup など）、
 *     protected の追加欄は「glob を追加」、役ごとの追加欄は「<役>に操作を追加」（例「実装役に操作を追加」）、
 *     受け付ける人の追加欄は「受け付ける人のユーザー ID」。リストの各要素には `<button aria-label="削除 <値>">`
 *   - 承認のしかたは `<input type="radio" value="auto|human">`。「Discord を使う」は aria-pressed の `<button>`（またはチェックボックス）
 *   - 誤りの文は、その入力欄の後ろ（次の入力欄・次の `<label>` より前）に出し、入力欄に aria-invalid="true" を付ける
 *   - 「差分を確認して保存」は誤りがあるとき disabled
 *   - 差分の確認ダイアログは Settings が role="dialog" で出す。変更点は src/config.ts の項目名（limits.rejections など）と前後の値。
 *     chat を消すときは「chat」と「（まるごと削除）」
 *   - saved があれば「PR #<番号> を作りました」と、案内「PR をマージしてから再起動してください。マージ前に再起動しても反映されません。」、
 *     PR への `<a href="<url>">`、`<button>再起動</button>` を出す（辞書に postSaveNote などのキーで足す）
 *
 * seed: 対象リポジトリは一時フォルダ（.conductor/config.yaml と指示ファイル）。保存するテストは本物の git の一時リポジトリ
 * （origin も一時フォルダの bare リポジトリ。ネットワークには出ない）。GitHub は作った PR を覚えるだけの偽物。
 * Discord のトークンは env の引数で渡す（process.env には書かない）。管理画面の HTTP だけ 127.0.0.1 につなぐ。
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { type ComponentType, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import { type AdminServer, startAdminServer } from "../admin-server.js";
import {
  CONDUCTOR_DIR,
  CONFIG_FILE,
  DISCORD_TOKEN_ENV,
  parseConfig,
  type Role,
} from "../config.js";
import type { SettingsData, SettingsForm } from "../settings-data.js";
import { applySettings, loadSettings, saveSettings } from "../settings.js";

// ---- seed ----

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REPO = "pkshimizu/wordcards";
const PROJECT = 3;
const PR_NUMBER = 81;
const PR_URL = `https://github.com/${REPO}/pull/${PR_NUMBER}`;
const ISSUE_BRANCH = "conductor/issue-12";
const SECRET = "discord-token-value-must-not-leak";
const INDEX_HTML = "<!doctype html><title>conductor</title>";
const POST_SAVE_NOTE =
  "PR をマージしてから再起動してください。マージ前に再起動しても反映されません。";

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function configYaml(options: { chat: boolean }): string {
  const lines = [
    "github:",
    `  repo: ${REPO}`,
    `  project: ${PROJECT}`,
    "  notify: someone",
    "  columns:",
    "    ready: Todo",
    "protected:",
    '  - "src/acceptance/**"',
    '  - "e2e/**"',
    "commands:",
    "  setup: npm ci",
    "  test: npm test",
    "  acceptance: npx vitest run src/acceptance",
    "  typecheck: npm run typecheck",
    "  build: npm run build",
    "  format: npm run format",
    "limits:",
    "  rejections: 4",
    "  objections: 2",
    "  reviewers: 5",
    "merge:",
    "  approval: auto",
    "poll_interval: 45",
    "language: English",
    "screenshots: shots/acceptance",
    "roles:",
    "  implementer:",
    '    allow: ["Bash(npm run lint)"]',
    "  reviewer:",
    '    allow: ["Bash(npx playwright test *)"]',
  ];
  if (options.chat) {
    lines.push(
      "chat:",
      "  type: discord",
      "  channels:",
      '    requirements: "1000000000000000001"',
      '    questions: "1000000000000000002"',
      '    notices: "1000000000000000003"',
      "  allowed_users:",
      '    - "2000000000000000001"',
    );
  }
  return lines.join("\n") + "\n";
}

const PROMPT_FILES: Record<string, string> = {
  "tester/acceptance.md":
    "# 受け入れテストの書き方\n\nAC ごとに受け入れテストを書きます。\n",
  "tester/objection.md":
    "# 異議の出し方\n\n決められないときは異議を出します。\n",
  "implementer/rules.md": "# 実装ルール\n\n関数は小さく保ちます。\n",
};

/** 対象リポジトリ（.conductor/config.yaml と指示ファイル）。git は使わない */
async function seedRepo(options: { chat: boolean }) {
  const dir = await mkdtemp(join(tmpdir(), "conductor-68-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, CONDUCTOR_DIR), { recursive: true });
  const source = configYaml(options);
  await writeFile(join(dir, CONDUCTOR_DIR, CONFIG_FILE), source);
  for (const [path, text] of Object.entries(PROMPT_FILES)) {
    await mkdir(join(dir, CONDUCTOR_DIR, path, ".."), { recursive: true });
    await writeFile(join(dir, CONDUCTOR_DIR, path), text);
  }
  return { dir, source };
}

/**
 * 本物の git の一時リポジトリ（origin は bare）。main に config.yaml を置いて push 済み。
 * 作業フォルダは #12 の処理中（conductor/issue-12 に切り替えてコミット・push 済みで、さらに未コミットの変更と追跡外のファイルがある）
 */
async function seedGit(options: { chat: boolean }) {
  const origin = await mkdtemp(join(tmpdir(), "conductor-68-origin-"));
  const dir = await mkdtemp(join(tmpdir(), "conductor-68-work-"));
  cleanups.push(() => rm(origin, { recursive: true, force: true }));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  // 保存のコミットがどこで作られても名前が要るので、子プロセスに渡す（後で戻す）
  const saved = {
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME,
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL,
  };
  process.env.GIT_AUTHOR_NAME ??= "test";
  process.env.GIT_AUTHOR_EMAIL ??= "test@example.com";
  process.env.GIT_COMMITTER_NAME ??= "test";
  process.env.GIT_COMMITTER_EMAIL ??= "test@example.com";
  cleanups.push(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const sh = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  const bare = (...args: string[]) =>
    execFileSync("git", [`--git-dir=${origin}`, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  const put = async (path: string, text: string) => {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), text);
  };
  execFileSync("git", ["init", "-q", "--bare", "-b", "main"], { cwd: origin });
  sh("init", "-q", "-b", "main");
  sh("config", "user.email", "test@example.com");
  sh("config", "user.name", "test");
  sh("config", "core.autocrlf", "false");
  sh("remote", "add", "origin", origin);
  const source = configYaml(options);
  await put(`${CONDUCTOR_DIR}/${CONFIG_FILE}`, source);
  for (const [path, text] of Object.entries(PROMPT_FILES)) {
    await put(`${CONDUCTOR_DIR}/${path}`, text);
  }
  await put("src/app.ts", "export const app = 1;\n");
  sh("add", "-A");
  sh("commit", "-q", "-m", "init");
  sh("push", "-q", "-u", "origin", "main");
  // #12 の処理中
  sh("switch", "-q", "-c", ISSUE_BRANCH);
  await put("src/acceptance/12-sort.test.ts", "// 受け入れテスト\n");
  await put("src/app.ts", "export const app = 2;\n");
  sh("add", "-A");
  sh("commit", "-q", "-m", "test: #12 の受け入れテスト");
  sh("push", "-q", "-u", "origin", ISSUE_BRANCH);
  await put("src/app.ts", "export const app = 3; // 作業中\n");
  await put("src/sort.ts", "export const sortWords = 1; // 作業中\n");

  const branchesOnOrigin = () =>
    bare("for-each-ref", "--format=%(refname:short)", "refs/heads")
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s !== "")
      .sort();
  const showOnOrigin = (ref: string, path: string) =>
    bare("show", `${ref}:${path}`);
  const revOnOrigin = (ref: string) => bare("rev-parse", ref).trim();
  return {
    dir,
    origin,
    source,
    sh,
    bare,
    branchesOnOrigin,
    showOnOrigin,
    revOnOrigin,
  };
}

/** 作った PR を覚えるだけの GitHub */
class FakePulls {
  readonly created: {
    head: string;
    title: string;
    body: string;
    base?: string;
  }[] = [];

  createPullRequest(input: {
    head: string;
    title: string;
    body: string;
    base?: string;
  }): Promise<{ number: number; url: string }> {
    this.created.push({ ...input });
    return Promise.resolve({ number: PR_NUMBER, url: PR_URL });
  }
}

/** 管理画面を起動する（設定の読み書きをつなぐ） */
async function seedServer(settings: {
  load(): Promise<SettingsData>;
  save(form: SettingsForm): Promise<{ number: number; url: string }>;
}): Promise<AdminServer> {
  const assets = await mkdtemp(join(tmpdir(), "conductor-admin-68-"));
  cleanups.push(() => rm(assets, { recursive: true, force: true }));
  await writeFile(join(assets, "index.html"), INDEX_HTML);
  const server = await startAdminServer({
    repo: REPO,
    project: PROJECT,
    status: "idle",
    log: () => {},
    assetsDir: assets,
    settings,
  });
  cleanups.push(() => server.close());
  return server;
}

/** 画面と同じく、管理画面そのものの Origin で設定を POST する */
function poster(server: AdminServer, origin = new URL(server.url).origin) {
  const paths: string[] = [];
  const post = async (path: string, form: SettingsForm) => {
    paths.push(path);
    return fetch(new URL(path, server.url), {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ form }),
    });
  };
  return { post, paths };
}

const clone = <T>(v: T): T => structuredClone(v);

// ---- 画面のソース（src の外にあるので、実行時に import する） ----

type Lang = "ja" | "en";
type SettingsTab = "general" | "commands" | "perms" | "discord" | "prompts";
interface SettingsState {
  form: SettingsForm;
  tab: SettingsTab;
  dialog?: "diff";
  saved?: { number: number; url: string };
  prompt?: { role: Role; file?: string };
}

interface SettingsStateModule {
  SETTINGS_PATH: string;
  initSettings(data: SettingsData): SettingsState;
  discardSettings(state: SettingsState, data: SettingsData): SettingsState;
  reviewSettings(state: SettingsState, data: SettingsData): SettingsState;
  cancelSettings(state: SettingsState): SettingsState;
  confirmSettings(
    state: SettingsState,
    post: (
      path: string,
      form: SettingsForm,
    ) => Promise<{ ok: boolean; json(): Promise<unknown> }>,
    update: (state: SettingsState) => void,
  ): Promise<SettingsState>;
}

interface SettingsProps {
  data: SettingsData;
  state: SettingsState;
  lang: Lang;
}

interface SettingsModule {
  Settings: ComponentType<SettingsProps>;
}

async function importWeb<T>(file: string): Promise<T> {
  const url = pathToFileURL(join(ROOT, "web", "src", file)).href;
  return (await import(/* @vite-ignore */ url)) as T;
}

const settingsState = () => importWeb<SettingsStateModule>("settings-state.ts");

async function renderSettings(
  data: SettingsData,
  state: Partial<SettingsState>,
  lang: Lang = "ja",
): Promise<string> {
  const { Settings } = await importWeb<SettingsModule>("Settings.tsx");
  const { initSettings } = await settingsState();
  return renderToStaticMarkup(
    createElement(Settings, {
      data,
      state: { ...initSettings(data), ...state },
      lang,
    }),
  );
}

// ---- HTML を読む ----

function decode(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** タグを除いた文 */
function textOf(html: string): string {
  return decode(html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ")).trim();
}

function attrOf(attrs: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}="([^"]*)"`, "i").exec(attrs);
  return m === null ? undefined : decode(m[1]!);
}

const hasFlag = (attrs: string, name: string) =>
  new RegExp(`\\s${name}(=""|\\s|/|$)`, "i").test(attrs);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface Control {
  tag: string;
  attrs: string;
  start: number;
  end: number;
  label: string | undefined;
  value: string | undefined;
  enabled: boolean;
  checked: boolean;
  invalid: boolean;
}

/** 入力欄（input・select・textarea）と、その名前（aria-label・label for・包む label） */
function controlsOf(html: string): Control[] {
  const list: Control[] = [];
  for (const m of html.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
    const attrs = m[2]!;
    const start = m.index;
    const end = start + m[0].length;
    let label = attrOf(attrs, "aria-label");
    const id = attrOf(attrs, "id");
    if (label === undefined && id !== undefined) {
      const lm = new RegExp(
        `<label\\b[^>]*\\sfor="${escapeRe(id)}"[^>]*>([\\s\\S]*?)</label>`,
      ).exec(html);
      if (lm !== null) label = textOf(lm[1]!);
    }
    if (label === undefined) {
      const open = html.lastIndexOf("<label", start);
      const close = html.lastIndexOf("</label>", start);
      if (open >= 0 && open > close) {
        const until = html.indexOf("</label>", start);
        label = textOf(html.slice(open, until < 0 ? undefined : until));
      }
    }
    list.push({
      tag: m[1]!,
      attrs,
      start,
      end,
      label,
      value: attrOf(attrs, "value"),
      enabled: !hasFlag(attrs, "disabled") && !hasFlag(attrs, "readonly"),
      checked: hasFlag(attrs, "checked"),
      invalid: attrOf(attrs, "aria-invalid") === "true",
    });
  }
  return list;
}

/** その名前の入力欄（1つ以上ある。最初のもの） */
function control(html: string, label: string): Control {
  const found = controlsOf(html).filter((c) => c.label === label);
  expect(found.length, `「${label}」の入力欄`).toBeGreaterThanOrEqual(1);
  return found[0]!;
}

function hasControl(html: string, label: string): boolean {
  return controlsOf(html).some((c) => c.label === label);
}

/** 入力欄の後ろ（次の入力欄・次の label より前）の文 */
function textBelow(html: string, c: Control): string {
  const next = controlsOf(html).find((o) => o.start >= c.end);
  const nextLabel = html.indexOf("<label", c.end);
  const ends = [next?.start, nextLabel >= 0 ? nextLabel : undefined].filter(
    (n): n is number => n !== undefined,
  );
  return textOf(
    html.slice(c.end, ends.length > 0 ? Math.min(...ends) : undefined),
  );
}

function radio(html: string, value: string): Control {
  const found = controlsOf(html).filter(
    (c) => attrOf(c.attrs, "type") === "radio" && c.value === value,
  );
  expect(found, `承認のしかた ${value} の選択肢`).toHaveLength(1);
  return found[0]!;
}

function buttonsOf(html: string) {
  return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(
    (m) => ({
      attrs: m[1]!,
      inner: m[2]!,
      text: textOf(m[2]!),
      disabled: hasFlag(m[1]!, "disabled"),
    }),
  );
}

function button(html: string, label: string) {
  const found = buttonsOf(html).filter((b) => b.text === label);
  expect(found.length, `「${label}」のボタン`).toBeGreaterThanOrEqual(1);
  return found[0]!;
}

/** 「削除 <値>」のボタンがあるか */
function hasRemove(html: string, value: string): boolean {
  return buttonsOf(html).some(
    (b) => attrOf(b.attrs, "aria-label") === `削除 ${value}` && !b.disabled,
  );
}

function tabsOf(html: string) {
  return [
    ...html.matchAll(/<button\b([^>]*\srole="tab"[^>]*)>([\s\S]*?)<\/button>/g),
  ].map((m) => ({
    inner: m[2]!,
    text: textOf(m[2]!),
    selected: attrOf(m[1]!, "aria-selected") === "true",
  }));
}

function tab(html: string, label: string) {
  const found = tabsOf(html).filter(
    (t) => t.text === label || t.text.startsWith(`${label} `),
  );
  expect(found, `タブ「${label}」`).toHaveLength(1);
  return found[0]!;
}

/** 「Discord を使う」がオンか */
function discordOn(html: string): boolean {
  const b = buttonsOf(html).find((x) => x.text.includes("Discord を使う"));
  if (b !== undefined) {
    return (
      attrOf(b.attrs, "aria-pressed") === "true" ||
      attrOf(b.attrs, "aria-checked") === "true"
    );
  }
  return control(html, "Discord を使う").checked;
}

/** role="dialog" の要素（閉じタグまで） */
function dialogOf(html: string): string | undefined {
  const i = html.search(/role="dialog"/);
  if (i < 0) return undefined;
  const start = html.lastIndexOf("<", i);
  const name = /^<([a-zA-Z0-9]+)/.exec(html.slice(start))?.[1];
  if (name === undefined) return html.slice(start);
  const tags = new RegExp(`<(/?)${name}\\b[^>]*?(/?)>`, "g");
  tags.lastIndex = start;
  let depth = 0;
  for (let m = tags.exec(html); m !== null; m = tags.exec(html)) {
    if (m[2] === "/") continue;
    depth += m[1] === "/" ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + m[0].length);
  }
  return html.slice(start);
}

const TAB_LABELS = {
  general: "基本",
  commands: "コマンドとファイル",
  perms: "エージェントの許可",
  discord: "窓口（Discord）",
  prompts: "指示ファイル",
} as const;

const COLUMN_LABELS = {
  ready: "Ready",
  testing: "Testing",
  implementing: "Implementing",
  reviewing: "Reviewing",
  done: "Done",
  blocked: "Blocked",
} as const;

const COMMAND_KEYS = [
  "setup",
  "test",
  "acceptance",
  "typecheck",
  "build",
  "format",
] as const;

const ROLE_LABELS: Record<Role, string> = {
  tester: "テストエージェント",
  implementer: "実装エージェント",
  reviewer: "レビューエージェント",
  specifier: "仕様化エージェント",
  decomposer: "分解エージェント",
};

describe("Issue #68: 管理画面：設定", () => {
  it("AC1: 設定を開くと、config.yaml の値をタブ（基本、コマンドとファイル、役の許可、窓口（Discord）、指示ファイル）に分けて出し、リポジトリと Project 番号は「見るだけ」", async () => {
    // Given: 設定を開いた
    const repo = await seedRepo({ chat: true });
    const data = await loadSettings(repo.dir, { [DISCORD_TOKEN_ENV]: SECRET });
    expect(data.repo).toBe(REPO);
    expect(data.project).toBe(PROJECT);
    const ss = await settingsState();
    const first = ss.initSettings(data);
    expect(first.tab).toBe("general");
    expect(first.form).toEqual(data.form);

    // When: 表示する
    // Then: 5つのタブに分けて出す（選んでいるのは基本）
    const general = await renderSettings(data, { tab: "general" });
    expect(tabsOf(general).map((t) => t.text)).toEqual(
      Object.values(TAB_LABELS),
    );
    expect(tab(general, "基本").selected).toBe(true);
    expect(tab(general, "コマンドとファイル").selected).toBe(false);
    const en = await renderSettings(data, { tab: "general" }, "en");
    expect(tabsOf(en).map((t) => t.text)).toEqual([
      "General",
      "Commands & files",
      "Role permissions",
      "Intake (Discord)",
      "Instruction files",
    ]);

    // Then: 基本のタブ
    expect(textOf(general)).toContain(
      "対象リポジトリの .conductor/config.yaml を編集します。保存すると変更をコミットして PR を作ります。",
    );
    expect(control(general, "Blocked のときに知らせる人").value).toBe(
      "someone",
    );
    expect(control(general, "Ready").value).toBe("Todo");
    expect(control(general, "Testing").value).toBe("Testing");
    expect(control(general, "Blocked").value).toBe("Blocked");
    expect(control(general, "差し戻しの上限").value).toBe("4");
    expect(control(general, "異議の上限").value).toBe("2");
    expect(control(general, "レビューエージェントを同時に動かす数").value).toBe(
      "5",
    );
    expect(radio(general, "auto").checked).toBe(true);
    expect(radio(general, "human").checked).toBe(false);
    expect(control(general, "GitHub を確認する間隔").value).toBe("45");
    expect(control(general, "エージェントが書く文章の言語").value).toBe(
      "English",
    );
    expect(control(general, "画面の撮影を保存するフォルダ").value).toBe(
      "shots/acceptance",
    );
    // ほかのタブの項目は出さない
    expect(hasControl(general, "setup")).toBe(false);
    expect(hasControl(general, "要件のチャンネル ID")).toBe(false);

    // Then: リポジトリと Project 番号は「見るだけ」（入力欄にしない）
    const generalText = textOf(general);
    expect(generalText).toContain("リポジトリ");
    expect(generalText).toContain(REPO);
    expect(generalText.split("見るだけ").length - 1).toBeGreaterThanOrEqual(2);
    for (const c of controlsOf(general)) {
      expect(c.value, `${c.label} の値`).not.toBe(REPO);
      expect(c.label).not.toBe("リポジトリ");
      expect(c.label).not.toBe("Project");
    }

    // Then: コマンドとファイルのタブ
    const commands = await renderSettings(data, { tab: "commands" });
    expect(tab(commands, "コマンドとファイル").selected).toBe(true);
    expect(control(commands, "setup").value).toBe("npm ci");
    expect(control(commands, "test").value).toBe("npm test");
    expect(control(commands, "acceptance").value).toBe(
      "npx vitest run src/acceptance",
    );
    expect(control(commands, "typecheck").value).toBe("npm run typecheck");
    expect(control(commands, "build").value).toBe("npm run build");
    expect(control(commands, "format").value).toBe("npm run format");
    expect(textOf(commands)).toContain("src/acceptance/**");
    expect(textOf(commands)).toContain("e2e/**");
    expect(hasControl(commands, "差し戻しの上限")).toBe(false);

    // Then: 役の許可のタブ
    const perms = await renderSettings(data, { tab: "perms" });
    expect(tab(perms, "エージェントの許可").selected).toBe(true);
    const permsText = textOf(perms);
    for (const label of Object.values(ROLE_LABELS)) {
      expect(permsText).toContain(label);
    }
    expect(permsText).toContain("Bash(npm run lint)");
    expect(permsText).toContain("Bash(npx playwright test *)");
    expect(hasControl(perms, "setup")).toBe(false);

    // Then: 窓口（Discord）のタブ
    const discord = await renderSettings(data, { tab: "discord" });
    expect(tab(discord, "窓口（Discord）").selected).toBe(true);
    expect(discordOn(discord)).toBe(true);
    expect(control(discord, "要件のチャンネル ID").value).toBe(
      "1000000000000000001",
    );
    expect(control(discord, "質問のチャンネル ID").value).toBe(
      "1000000000000000002",
    );
    expect(control(discord, "お知らせのチャンネル ID").value).toBe(
      "1000000000000000003",
    );
    expect(textOf(discord)).toContain("2000000000000000001");
    expect(hasControl(discord, "Blocked のときに知らせる人")).toBe(false);

    // Then: 指示ファイルのタブ
    const prompts = await renderSettings(data, { tab: "prompts" });
    expect(tab(prompts, "指示ファイル").selected).toBe(true);
    expect(textOf(prompts)).toContain("acceptance.md");
    expect(textOf(prompts)).toContain("AC ごとに受け入れテストを書きます。");
    expect(hasControl(prompts, "setup")).toBe(false);
  });

  it("AC2: フォームで、知らせる人・列の名前・各上限・承認のしかた・確認の間隔・言語・撮影のフォルダ・コマンド・protected・役ごとの追加許可・Discord のチャンネル ID と受け付ける人を変更できる", async () => {
    // Given: フォーム
    const repo = await seedRepo({ chat: true });
    const data = await loadSettings(repo.dir, {});

    // When: 項目を見る
    // Then: 変更できる項目は、入力欄（無効・読み取り専用でない）として出し、入力中の値を出す
    const form = clone(data.form);
    form.github.notify = "another-user";
    form.github.columns = {
      ready: "Up next",
      testing: "In test",
      implementing: "Doing",
      reviewing: "In review",
      done: "Shipped",
      blocked: "Stuck",
    };
    form.limits = { rejections: "6", objections: "4", reviewers: "2" };
    form.merge.approval = "human";
    form.poll_interval = "120";
    form.language = "日本語";
    form.screenshots = "";
    form.commands = {
      setup: "pnpm i",
      test: "pnpm test",
      acceptance: "pnpm acceptance",
      typecheck: "pnpm typecheck",
      build: "pnpm build",
      format: "",
    };
    form.protected = ["src/acceptance/**", "tests/e2e/**"];
    form.roles.tester.allow = ["Bash(npx playwright test *)"];
    form.roles.implementer.allow = [];
    form.roles.reviewer.allow = ["Bash(npm run lint)"];
    form.roles.specifier.allow = ["Bash(gh issue view *)"];
    form.roles.decomposer.allow = ["Bash(gh issue list *)"];
    form.chat.channels = {
      requirements: "1000000000000000004",
      questions: "1000000000000000005",
      notices: "1000000000000000006",
    };
    form.chat.allowed_users = ["2000000000000000001", "2000000000000000002"];

    const general = await renderSettings(data, { tab: "general", form });
    const generalFields: [string, string][] = [
      ["Blocked のときに知らせる人", "another-user"],
      ...Object.entries(COLUMN_LABELS).map(
        ([k, label]) =>
          [label, form.github.columns[k as keyof typeof COLUMN_LABELS]] as [
            string,
            string,
          ],
      ),
      ["差し戻しの上限", "6"],
      ["異議の上限", "4"],
      ["レビューエージェントを同時に動かす数", "2"],
      ["GitHub を確認する間隔", "120"],
      ["エージェントが書く文章の言語", "日本語"],
      ["画面の撮影を保存するフォルダ", ""],
    ];
    for (const [label, value] of generalFields) {
      const c = control(general, label);
      expect(c.enabled, `${label} を変更できる`).toBe(true);
      expect(c.value ?? "", label).toBe(value);
    }
    expect(radio(general, "auto").enabled).toBe(true);
    expect(radio(general, "human").enabled).toBe(true);
    expect(radio(general, "human").checked).toBe(true);
    expect(textOf(general)).toContain("列の名前");
    expect(textOf(general)).toContain("承認のしかた");

    const commands = await renderSettings(data, { tab: "commands", form });
    for (const k of COMMAND_KEYS) {
      const c = control(commands, k);
      expect(c.enabled, `${k} を変更できる`).toBe(true);
      expect(c.value ?? "", k).toBe(form.commands[k]);
    }
    expect(textOf(commands)).toContain(
      "実装エージェントに変えさせないファイル",
    );
    expect(control(commands, "glob を追加").enabled).toBe(true);
    expect(hasRemove(commands, "src/acceptance/**")).toBe(true);
    expect(hasRemove(commands, "tests/e2e/**")).toBe(true);

    const perms = await renderSettings(data, { tab: "perms", form });
    expect(textOf(perms)).toContain("エージェントごとの追加許可");
    for (const label of Object.values(ROLE_LABELS)) {
      expect(control(perms, `${label}に操作を追加`).enabled, label).toBe(true);
    }
    expect(hasRemove(perms, "Bash(npx playwright test *)")).toBe(true);
    expect(hasRemove(perms, "Bash(gh issue list *)")).toBe(true);

    const discord = await renderSettings(data, { tab: "discord", form });
    for (const [label, value] of [
      ["要件のチャンネル ID", "1000000000000000004"],
      ["質問のチャンネル ID", "1000000000000000005"],
      ["お知らせのチャンネル ID", "1000000000000000006"],
    ] as const) {
      const c = control(discord, label);
      expect(c.enabled, `${label} を変更できる`).toBe(true);
      expect(c.value, label).toBe(value);
    }
    expect(control(discord, "受け付ける人のユーザー ID").enabled).toBe(true);
    expect(hasRemove(discord, "2000000000000000002")).toBe(true);

    // Then: 変えた値は、src/config.ts の項目として config.yaml に書ける
    const written = applySettings(repo.source, form);
    const config = parseConfig(written);
    expect(config.github.repo).toBe(REPO);
    expect(config.github.project).toBe(PROJECT);
    expect(config.github.notify).toBe("another-user");
    expect(config.github.columns).toEqual(form.github.columns);
    expect(config.limits).toEqual({
      rejections: 6,
      objections: 4,
      reviewers: 2,
    });
    expect(config.merge.approval).toBe("human");
    expect(config.poll_interval).toBe(120);
    expect(config.language).toBe("日本語");
    expect(config.screenshots).toBeUndefined();
    expect(config.commands).toEqual({
      setup: "pnpm i",
      test: "pnpm test",
      acceptance: "pnpm acceptance",
      typecheck: "pnpm typecheck",
      build: "pnpm build",
    });
    expect(config.protected).toEqual(["src/acceptance/**", "tests/e2e/**"]);
    expect(config.roles.tester.allow).toEqual(["Bash(npx playwright test *)"]);
    expect(config.roles.implementer.allow).toEqual([]);
    expect(config.roles.reviewer.allow).toEqual(["Bash(npm run lint)"]);
    expect(config.roles.specifier.allow).toEqual(["Bash(gh issue view *)"]);
    expect(config.roles.decomposer.allow).toEqual(["Bash(gh issue list *)"]);
    expect(config.chat?.channels).toEqual(form.chat.channels);
    expect(config.chat?.allowed_users).toEqual([
      "2000000000000000001",
      "2000000000000000002",
    ]);
  });

  it("AC3: 「Discord を使う」をオフにして保存すると config.yaml から chat を丸ごと消し、オンにしたときは chat.type: discord も書く", async () => {
    // ---- Given: 「Discord を使う」をオフにした ----
    {
      const git = await seedGit({ chat: true });
      const data = await loadSettings(git.dir, {});
      expect(data.form.chat.enabled).toBe(true);
      const form = clone(data.form);
      form.chat.enabled = false;

      // 画面ではオフに見え、差分の確認では chat を丸ごと消すと出す
      const discord = await renderSettings(data, { tab: "discord", form });
      expect(discordOn(discord)).toBe(false);
      const dialogPage = await renderSettings(data, { form, dialog: "diff" });
      const dialog = dialogOf(dialogPage);
      expect(dialog, "差分の確認ダイアログ").toBeDefined();
      expect(textOf(dialog!)).toContain("chat");
      expect(textOf(dialog!)).toContain("（まるごと削除）");

      // When: 保存する
      const pulls = new FakePulls();
      const res = await saveSettings({ repoDir: git.dir, github: pulls }, form);

      // Then: config.yaml から chat を丸ごと消す
      const saved = git.showOnOrigin(
        res.branch,
        `${CONDUCTOR_DIR}/${CONFIG_FILE}`,
      );
      const raw = parseYaml(saved) as Record<string, unknown>;
      expect(Object.keys(raw)).not.toContain("chat");
      expect(saved).not.toMatch(/^chat\s*:/m);
      const config = parseConfig(saved);
      expect(config.chat).toBeUndefined();
      expect(config.github.repo).toBe(REPO);
      expect(config.poll_interval).toBe(45);
    }

    // ---- Given: 「Discord を使う」をオンにした（もとは chat が無い） ----
    {
      const git = await seedGit({ chat: false });
      const data = await loadSettings(git.dir, {});
      expect(data.form.chat.enabled).toBe(false);
      const form = clone(data.form);
      form.chat = {
        enabled: true,
        channels: {
          requirements: "1000000000000000011",
          questions: "1000000000000000012",
          notices: "1000000000000000013",
        },
        allowed_users: ["2000000000000000011"],
      };
      expect(
        discordOn(await renderSettings(data, { tab: "discord", form })),
      ).toBe(true);

      // When: 保存する
      const res = await saveSettings(
        { repoDir: git.dir, github: new FakePulls() },
        form,
      );

      // Then: chat.type: discord も書く
      const saved = git.showOnOrigin(
        res.branch,
        `${CONDUCTOR_DIR}/${CONFIG_FILE}`,
      );
      const raw = parseYaml(saved) as { chat?: { type?: unknown } };
      expect(raw.chat?.type).toBe("discord");
      expect(parseConfig(saved).chat).toEqual({
        type: "discord",
        channels: {
          requirements: "1000000000000000011",
          questions: "1000000000000000012",
          notices: "1000000000000000013",
        },
        allowed_users: ["2000000000000000011"],
      });
    }
  });

  it("AC4: Discord のトークンは「設定済み」か「未設定」だけを出し、値は出さない", async () => {
    const repo = await seedRepo({ chat: true });

    // ---- Given: Discord のトークンがある ----
    {
      const env = { [DISCORD_TOKEN_ENV]: SECRET };
      const server = await seedServer({
        load: () => loadSettings(repo.dir, env),
        save: () => Promise.reject(new Error("このテストでは保存しない")),
      });

      // When: 表示する（画面は GET /api/settings で読む）
      const res = await fetch(new URL("/api/settings", server.url));
      expect(res.status).toBe(200);
      const body = await res.text();

      // Then: 値は画面に届けない
      expect(body).not.toContain(SECRET);
      const data = JSON.parse(body) as SettingsData;
      expect(data.token).toBe("set");
      expect(data.repo).toBe(REPO);

      // Then: 「設定済み」だけを出す
      const page = await renderSettings(data, { tab: "discord" });
      const text = textOf(page);
      expect(text).toContain("トークン");
      expect(text).toContain("設定済み");
      expect(text).toContain("値は画面に表示しません");
      expect(text).not.toContain("未設定");
      expect(page).not.toContain(SECRET);
      for (const c of controlsOf(page)) {
        expect(c.value).not.toBe(SECRET);
      }
    }

    // ---- Given: Discord のトークンが無い ----
    {
      const data = await loadSettings(repo.dir, {});
      expect(data.token).toBe("unset");
      const text = textOf(await renderSettings(data, { tab: "discord" }));
      expect(text).toContain("未設定");
      expect(text).not.toContain("設定済み");
    }
  });

  it("AC5: 役ごとの指示ファイル（.conductor/<役>/*.md）は中身を見るだけで、編集はできない", async () => {
    // Given: 役ごとの指示ファイル
    const repo = await seedRepo({ chat: false });
    const data = await loadSettings(repo.dir, {});
    expect(data.prompts.tester.map((p) => p.name)).toEqual([
      "acceptance.md",
      "objection.md",
    ]);
    expect(data.prompts.implementer.map((p) => p.name)).toEqual(["rules.md"]);
    expect(data.prompts.reviewer).toEqual([]);
    expect(data.prompts.tester[0]!.text).toContain(
      "AC ごとに受け入れテストを書きます。",
    );

    // When: 表示する（最初は最初の役の最初のファイル）
    const first = await renderSettings(data, { tab: "prompts" });
    const firstText = textOf(first);

    // Then: 中身を見られる
    expect(firstText).toContain("エージェントごとの指示ファイル");
    expect(firstText).toContain("見るだけ");
    expect(firstText).toContain("acceptance.md");
    expect(firstText).toContain("objection.md");
    expect(firstText).toContain("受け入れテストの書き方");
    expect(firstText).toContain("AC ごとに受け入れテストを書きます。");
    for (const label of Object.values(ROLE_LABELS)) {
      expect(firstText).toContain(label);
    }

    // ほかの役・ファイルを選んでも見るだけ
    const rules = await renderSettings(data, {
      tab: "prompts",
      prompt: { role: "implementer", file: "rules.md" },
    });
    expect(textOf(rules)).toContain("rules.md");
    expect(textOf(rules)).toContain("関数は小さく保ちます。");
    expect(textOf(rules)).not.toContain("AC ごとに受け入れテストを書きます。");

    // Then: 編集はできない（入力欄も編集できる要素も無い）
    for (const page of [first, rules]) {
      expect(controlsOf(page)).toEqual([]);
      expect(page).not.toMatch(/contenteditable/i);
    }

    // Then: フォームの値に指示ファイルは無く、config.yaml に書くものにも入らない
    expect(Object.keys(data.form)).not.toContain("prompts");
    const written = applySettings(repo.source, data.form);
    expect(written).not.toContain("AC ごとに受け入れテストを書きます。");
    expect(written).not.toContain("関数は小さく保ちます。");
  });

  it("AC6: 正しくない値は src/config.ts と同じ決まりで項目の下に誤りを出し、タブに誤りの件数を出し、保存できない（protected が0件、Discord を使うときに chat.allowed_users が0件なら「1件以上必要です」）", async () => {
    const repo = await seedRepo({ chat: true });
    const data = await loadSettings(repo.dir, {});
    const ss = await settingsState();

    /** config.ts の決まりで、その値を config.yaml に書いて読めるか */
    const acceptedByConfig = (form: SettingsForm): boolean => {
      try {
        parseConfig(applySettings(repo.source, form));
        return true;
      } catch {
        return false;
      }
    };

    const cases: {
      name: string;
      tab: SettingsTab;
      label: string;
      message: string;
      list?: boolean;
      edit: (f: SettingsForm) => void;
    }[] = [
      {
        name: "limits.rejections が 0",
        tab: "general",
        label: "差し戻しの上限",
        message: "1 以上の整数を入れてください",
        edit: (f) => (f.limits.rejections = "0"),
      },
      {
        name: "limits.objections が数でない",
        tab: "general",
        label: "異議の上限",
        message: "1 以上の整数を入れてください",
        edit: (f) => (f.limits.objections = "abc"),
      },
      {
        name: "limits.reviewers が整数でない",
        tab: "general",
        label: "レビューエージェントを同時に動かす数",
        message: "1 以上の整数を入れてください",
        edit: (f) => (f.limits.reviewers = "2.5"),
      },
      {
        name: "poll_interval が 10 より小さい",
        tab: "general",
        label: "GitHub を確認する間隔",
        message: "10 以上の整数を入れてください",
        edit: (f) => (f.poll_interval = "5"),
      },
      {
        name: "github.notify に @ がある",
        tab: "general",
        label: "Blocked のときに知らせる人",
        message: "GitHub のユーザー名を入れてください",
        edit: (f) => (f.github.notify = "@someone"),
      },
      {
        name: "language が空白だけ",
        tab: "general",
        label: "エージェントが書く文章の言語",
        message: "入力してください",
        edit: (f) => (f.language = "  "),
      },
      {
        name: "github.columns.done が空",
        tab: "general",
        label: "Done",
        message: "入力してください",
        edit: (f) => (f.github.columns.done = ""),
      },
      {
        name: "commands.build が空",
        tab: "commands",
        label: "build",
        message: "入力してください",
        edit: (f) => (f.commands.build = ""),
      },
      {
        name: "protected が0件",
        tab: "commands",
        label: "glob を追加",
        message: "1件以上必要です",
        list: true,
        edit: (f) => {
          f.protected = [];
        },
      },
      {
        name: "chat.channels.questions が空",
        tab: "discord",
        label: "質問のチャンネル ID",
        message: "入力してください",
        edit: (f) => (f.chat.channels.questions = ""),
      },
      {
        name: "Discord を使うのに chat.allowed_users が0件",
        tab: "discord",
        label: "受け付ける人のユーザー ID",
        message: "1件以上必要です",
        list: true,
        edit: (f) => {
          f.chat.allowed_users = [];
        },
      },
    ];

    for (const c of cases) {
      // Given: 正しくない値を入れた
      const form = clone(data.form);
      c.edit(form);
      // config.ts でも読めない値であること（同じ決まり）
      expect(acceptedByConfig(form), `${c.name}: config.ts でも誤り`).toBe(
        false,
      );

      // When: 入力する
      const page = await renderSettings(data, { tab: c.tab, form });

      // Then: 誤りを項目の下に出す
      const field = control(page, c.label);
      expect(textBelow(page, field), c.name).toContain(c.message);
      // リストの追加欄は空のままでよいので、aria-invalid は1つの値を入れる欄だけで確かめる
      if (c.list !== true) {
        expect(field.invalid, `${c.name}: aria-invalid`).toBe(true);
      }

      // Then: 保存できない
      expect(button(page, "差分を確認して保存").disabled, c.name).toBe(true);
      const reviewed = ss.reviewSettings(
        { ...ss.initSettings(data), form },
        data,
      );
      expect(reviewed.dialog, c.name).toBeUndefined();
    }

    // Then: config.ts で正しい値は誤りにしない（境目の値・空でよい項目・Discord を使わないとき）
    const ok = clone(data.form);
    ok.limits.rejections = "1";
    ok.poll_interval = "10";
    ok.github.notify = "some-one";
    ok.screenshots = "";
    ok.commands.format = "";
    expect(acceptedByConfig(ok)).toBe(true);
    for (const t of ["general", "commands", "discord"] as const) {
      const page = await renderSettings(data, { tab: t, form: ok });
      expect(
        controlsOf(page).filter((c) => c.invalid),
        t,
      ).toEqual([]);
      expect(page).not.toContain("件の誤り");
      expect(button(page, "差分を確認して保存").disabled, t).toBe(false);
    }
    const noChat = clone(data.form);
    noChat.chat = {
      enabled: false,
      channels: { requirements: "", questions: "", notices: "" },
      allowed_users: [],
    };
    expect(acceptedByConfig(noChat)).toBe(true);
    const noChatPage = await renderSettings(data, {
      tab: "discord",
      form: noChat,
    });
    expect(noChatPage).not.toContain("1件以上必要です");
    expect(tab(noChatPage, "窓口（Discord）").inner).not.toContain("件の誤り");

    // Then: タブに誤りの件数を出す
    const all = clone(data.form);
    for (const c of cases) c.edit(all);
    const page = await renderSettings(data, { tab: "general", form: all });
    expect(tab(page, "基本").inner).toContain("7件の誤り");
    expect(tab(page, "コマンドとファイル").inner).toContain("2件の誤り");
    expect(tab(page, "窓口（Discord）").inner).toContain("2件の誤り");
    expect(tab(page, "エージェントの許可").inner).not.toContain("件の誤り");
    expect(tab(page, "指示ファイル").inner).not.toContain("件の誤り");
    expect(button(page, "差分を確認して保存").disabled).toBe(true);

    // Then: 画面を通さずに送っても保存しない（PR を作らない）
    const git = await seedGit({ chat: true });
    const pulls = new FakePulls();
    const server = await seedServer({
      load: () => loadSettings(git.dir, {}),
      save: (form) => saveSettings({ repoDir: git.dir, github: pulls }, form),
    });
    const before = git.branchesOnOrigin();
    const bad = clone((await loadSettings(git.dir, {})).form);
    bad.protected = [];
    const res = await poster(server).post(ss.SETTINGS_PATH, bad);
    expect(res.ok).toBe(false);
    await expect(
      saveSettings({ repoDir: git.dir, github: pulls }, bad),
    ).rejects.toThrow();
    expect(pulls.created).toEqual([]);
    expect(git.branchesOnOrigin()).toEqual(before);
  });

  it("AC7: 値を変えて「差分を確認して保存」を押すと変更点を src/config.ts の項目名で出し、「保存して PR を作成」で新しいブランチにコミットして PR を作り「PR #<番号> を作りました」と知らせる。変更のあるタブには印を出し、「変更を取り消す」で元に戻せる", async () => {
    const git = await seedGit({ chat: true });
    const pulls = new FakePulls();
    const server = await seedServer({
      load: () => loadSettings(git.dir, {}),
      save: (form) => saveSettings({ repoDir: git.dir, github: pulls }, form),
    });
    const ss = await settingsState();
    const res = await fetch(new URL(ss.SETTINGS_PATH, server.url));
    expect(res.status).toBe(200);
    const data = (await res.json()) as SettingsData;
    const mainBefore = git.revOnOrigin("main");

    // Given: 値を変えた
    const form = clone(data.form);
    form.limits.rejections = "5";
    form.github.columns.ready = "Up next";
    form.roles.implementer.allow = [
      ...form.roles.implementer.allow,
      "Bash(npm run e2e)",
    ];
    const changed: SettingsState = { ...ss.initSettings(data), form };

    // Then: 変更のあるタブには印を出す
    const page = await renderSettings(data, changed);
    expect(tab(page, "基本").inner).toContain("変更あり");
    expect(tab(page, "エージェントの許可").inner).toContain("変更あり");
    expect(tab(page, "コマンドとファイル").inner).not.toContain("変更あり");
    expect(tab(page, "窓口（Discord）").inner).not.toContain("変更あり");
    expect(tab(page, "指示ファイル").inner).not.toContain("変更あり");
    expect(button(page, "変更を取り消す").disabled).toBe(false);
    expect(button(page, "差分を確認して保存").disabled).toBe(false);
    const untouched = await renderSettings(data, {});
    expect(untouched).not.toContain("変更あり");

    // Then: 「変更を取り消す」で元に戻せる
    const discarded = ss.discardSettings(changed, data);
    expect(discarded.form).toEqual(data.form);
    expect(discarded.dialog).toBeUndefined();
    const discardedPage = await renderSettings(data, discarded);
    expect(discardedPage).not.toContain("変更あり");
    expect(control(discardedPage, "差し戻しの上限").value).toBe("4");
    expect(control(discardedPage, "Ready").value).toBe("Todo");

    // When: 「差分を確認して保存」を押す
    const reviewed = ss.reviewSettings(changed, data);
    expect(reviewed.dialog).toBe("diff");
    expect(reviewed.form).toEqual(form);

    // Then: config.yaml の変更点を src/config.ts の項目名で出す
    const dialogPage = await renderSettings(data, reviewed);
    const dialog = dialogOf(dialogPage);
    expect(dialog, "差分の確認ダイアログ").toBeDefined();
    const dialogText = textOf(dialog!);
    expect(dialogText).toContain("変更内容の確認");
    expect(dialogText).toContain("次の変更をコミットして PR を作ります。");
    expect(dialogText).toContain(".conductor/config.yaml");
    for (const path of [
      "limits.rejections",
      "github.columns.ready",
      "roles.implementer.allow",
    ]) {
      expect(dialogText).toContain(path);
    }
    expect(dialogText).toContain("Up next");
    expect(dialogText).toContain("Bash(npm run e2e)");
    for (const path of [
      "poll_interval",
      "github.notify",
      "limits.objections",
      "chat",
      "protected",
    ]) {
      expect(dialogText, `変えていない ${path} は出さない`).not.toContain(path);
    }
    const dialogButtons = buttonsOf(dialog!).map((b) => b.text);
    expect(dialogButtons).toContain("保存して PR を作成");
    expect(dialogButtons).toContain("キャンセル");

    // 「キャンセル」は閉じるだけ
    const cancelled = ss.cancelSettings(reviewed);
    expect(cancelled.dialog).toBeUndefined();
    expect(cancelled.form).toEqual(form);

    // 別のサイトからの POST は受け付けない
    const foreign = await poster(server, "http://evil.example").post(
      ss.SETTINGS_PATH,
      form,
    );
    expect(foreign.status).toBe(403);
    expect(pulls.created).toEqual([]);

    // When: 「保存して PR を作成」を押す
    const { post, paths } = poster(server);
    const updates: SettingsState[] = [];
    const final = await ss.confirmSettings(reviewed, post, (s) =>
      updates.push(s),
    );

    // Then: 新しいブランチにコミットして PR を作る
    expect(paths).toEqual([ss.SETTINGS_PATH]);
    expect(pulls.created).toHaveLength(1);
    const pr = pulls.created[0]!;
    expect(pr.base ?? "main").toBe("main");
    expect(pr.head).not.toBe("main");
    expect(pr.head).not.toBe(ISSUE_BRANCH);
    expect(git.branchesOnOrigin()).toContain(pr.head);
    expect(git.revOnOrigin("main")).toBe(mainBefore);
    const saved = parseConfig(
      git.showOnOrigin(pr.head, `${CONDUCTOR_DIR}/${CONFIG_FILE}`),
    );
    expect(saved.limits.rejections).toBe(5);
    expect(saved.github.columns.ready).toBe("Up next");
    expect(saved.roles.implementer.allow).toEqual([
      "Bash(npm run lint)",
      "Bash(npm run e2e)",
    ]);
    // 変えていない値はそのまま
    expect(saved.github.repo).toBe(REPO);
    expect(saved.github.project).toBe(PROJECT);
    expect(saved.limits.objections).toBe(2);
    expect(saved.poll_interval).toBe(45);
    expect(saved.merge.approval).toBe("auto");
    expect(saved.chat?.allowed_users).toEqual(["2000000000000000001"]);

    // Then: 「PR #<番号> を作りました」と知らせる
    expect(updates[0]?.dialog).toBeUndefined();
    expect(final.dialog).toBeUndefined();
    expect(final.saved).toEqual({ number: PR_NUMBER, url: PR_URL });
    expect(updates.at(-1)?.saved).toEqual({ number: PR_NUMBER, url: PR_URL });
    const done = await renderSettings(data, final);
    expect(textOf(done)).toContain(`PR #${PR_NUMBER} を作りました`);
    expect(dialogOf(done)).toBeUndefined();
  });

  it("AC8: 保存して PR を作ったら、PR をマージしてから再起動する必要があること（マージ前に再起動しても反映されないこと）と一緒に再起動の案内を出す", async () => {
    const repo = await seedRepo({ chat: true });
    const data = await loadSettings(repo.dir, {});
    const ss = await settingsState();

    // 保存する前は案内を出さない
    const before = await renderSettings(data, {});
    expect(textOf(before)).not.toContain(POST_SAVE_NOTE);

    // Given: 保存して PR を作った
    const form = clone(data.form);
    form.poll_interval = "60";
    const reviewed = ss.reviewSettings(
      { ...ss.initSettings(data), form },
      data,
    );
    expect(reviewed.dialog).toBe("diff");
    const posted: { path: string; form: SettingsForm }[] = [];
    const final = await ss.confirmSettings(
      reviewed,
      (path, f) => {
        posted.push({ path, form: f });
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ number: PR_NUMBER, url: PR_URL }),
        });
      },
      () => {},
    );
    expect(posted).toEqual([{ path: ss.SETTINGS_PATH, form }]);
    expect(final.saved).toEqual({ number: PR_NUMBER, url: PR_URL });

    // When: 画面を見る
    const page = await renderSettings(data, final);

    // Then: マージしてから再起動する必要があることと一緒に、再起動の案内を出す
    const text = textOf(page);
    expect(text).toContain(POST_SAVE_NOTE);
    expect(page).toContain(`href="${PR_URL}"`);
    expect(button(page, "再起動").disabled).toBe(false);
  });

  it("AC9: Issue の処理中に設定を保存しても、処理中の Issue のブランチや作業中のファイルには影響しない", async () => {
    // Given: Issue の処理中（#12 のブランチに切り替えていて、未コミットの変更と追跡外のファイルがある）
    const git = await seedGit({ chat: true });
    const head = git.sh("rev-parse", "--abbrev-ref", "HEAD").trim();
    expect(head).toBe(ISSUE_BRANCH);
    const headSha = git.sh("rev-parse", "HEAD").trim();
    const status = git.sh("status", "--porcelain", "--untracked-files=all");
    expect(status).toContain("src/app.ts");
    expect(status).toContain("src/sort.ts");
    const files = async () => ({
      app: await readFile(join(git.dir, "src/app.ts"), "utf8"),
      sort: await readFile(join(git.dir, "src/sort.ts"), "utf8"),
      config: await readFile(join(git.dir, CONDUCTOR_DIR, CONFIG_FILE), "utf8"),
      test: await readFile(
        join(git.dir, "src/acceptance/12-sort.test.ts"),
        "utf8",
      ),
    });
    const filesBefore = await files();
    const issueOnOrigin = git.revOnOrigin(ISSUE_BRANCH);
    const mainOnOrigin = git.revOnOrigin("main");

    // When: 設定を保存する
    const data = await loadSettings(git.dir, {});
    const form = clone(data.form);
    form.limits.reviewers = "1";
    const pulls = new FakePulls();
    const res = await saveSettings({ repoDir: git.dir, github: pulls }, form);
    expect(res).toMatchObject({ number: PR_NUMBER, url: PR_URL });
    expect(pulls.created.map((p) => p.head)).toEqual([res.branch]);

    // Then: 処理中の Issue のブランチと作業中のファイルはそのまま
    expect(git.sh("rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(
      ISSUE_BRANCH,
    );
    expect(git.sh("rev-parse", "HEAD").trim()).toBe(headSha);
    expect(git.sh("status", "--porcelain", "--untracked-files=all")).toBe(
      status,
    );
    expect(git.sh("stash", "list").trim()).toBe("");
    expect(await files()).toEqual(filesBefore);
    expect(git.revOnOrigin(ISSUE_BRANCH)).toBe(issueOnOrigin);
    expect(git.revOnOrigin("main")).toBe(mainOnOrigin);

    // Then: 保存は main から作った別のブランチに、config.yaml だけを変えるコミットとして入る
    expect(res.branch).not.toBe(ISSUE_BRANCH);
    expect(res.branch).not.toBe("main");
    expect(git.revOnOrigin(`${res.branch}^`)).toBe(mainOnOrigin);
    const changedFiles = git
      .bare("diff", "--name-only", "main", res.branch)
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s !== "");
    expect(changedFiles).toEqual([`${CONDUCTOR_DIR}/${CONFIG_FILE}`]);
    expect(
      parseConfig(
        git.showOnOrigin(res.branch, `${CONDUCTOR_DIR}/${CONFIG_FILE}`),
      ).limits.reviewers,
    ).toBe(1);
    // 処理中の Issue の作業（受け入れテスト・作業中のファイル）は保存のブランチに入らない
    expect(() =>
      git.showOnOrigin(res.branch, "src/acceptance/12-sort.test.ts"),
    ).toThrow();
    expect(() => git.showOnOrigin(res.branch, "src/sort.ts")).toThrow();
  });
});

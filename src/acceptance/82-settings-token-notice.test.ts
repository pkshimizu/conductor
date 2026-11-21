/**
 * Issue #82: 設定画面：Discord のトークンが未設定のとき、環境変数に設定するよう案内を出す の受け入れテスト
 *
 * 決めたこと（実装役はこれに合わせて作る）:
 * - API は変えない。判定は SettingsData.token（"set" / "unset"、src/settings.ts の loadSettings）と
 *   画面の入力中の値 state.form.chat.enabled（保存前の値）で行う
 * - 案内は web/src/Settings.tsx の「窓口（Discord）」タブのトークンの Row（ラベル「トークン」/「Token」）の中、
 *   ラベルより後ろ（次の入力欄・ボタンより前）に出す
 * - 文言は web/src/i18n.ts に日本語と英語を足す。変数名 CONDUCTOR_DISCORD_TOKEN は等幅の要素
 *   （<code>・<kbd>・<samp>、または style に monospace を含む要素）の中だけに入れて出す
 * - 既存の文言（「トークン」「設定済み」「未設定」「値は画面に表示しません」）は変えない
 *
 * seed: 対象リポジトリは一時フォルダ（.conductor/config.yaml。chat ブロックの有無を選ぶ）。
 * Discord のトークンは env の引数で渡す（process.env には書かない）。管理画面の HTTP だけ 127.0.0.1 につなぐ。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { type ComponentType, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { startAdminServer } from "../admin-server.js";
import { CONDUCTOR_DIR, CONFIG_FILE, DISCORD_TOKEN_ENV } from "../config.js";
import type { SettingsData, SettingsForm } from "../settings-data.js";
import { loadSettings } from "../settings.js";

// ---- seed ----

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REPO = "pkshimizu/wordcards";
const PROJECT = 3;
const SECRET = "discord-token-value-must-not-leak-82";
const INDEX_HTML = "<!doctype html><title>conductor</title>";

const NOTICE_JA =
  "Discord のトークンが未設定です。環境変数 CONDUCTOR_DISCORD_TOKEN に設定し、conductor start を起動し直してください（管理画面の「再起動」では反映されません）。";
const NOTICE_EN =
  "The Discord token is not set. Set the environment variable CONDUCTOR_DISCORD_TOKEN and start conductor start again (the Restart button in this screen does not pick it up).";
/** 案内の書き出し（HTML の中で案内の位置を探すのに使う。タグを挟まない部分） */
const NOTICE_HEAD_JA = "Discord のトークンが未設定です。";
const NOTICE_HEAD_EN = "The Discord token is not set.";

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
    "protected:",
    '  - "src/acceptance/**"',
    "commands:",
    "  setup: npm ci",
    "  test: npm test",
    "  acceptance: npx vitest run src/acceptance",
    "  typecheck: npm run typecheck",
    "  build: npm run build",
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

/** 対象リポジトリ（.conductor/config.yaml）。git は使わない */
async function seedRepo(options: { chat: boolean }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "conductor-82-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, CONDUCTOR_DIR), { recursive: true });
  await writeFile(join(dir, CONDUCTOR_DIR, CONFIG_FILE), configYaml(options));
  return dir;
}

/** 管理画面を起動する（設定の読み込みだけつなぐ） */
async function seedServer(load: () => Promise<SettingsData>) {
  const assets = await mkdtemp(join(tmpdir(), "conductor-admin-82-"));
  cleanups.push(() => rm(assets, { recursive: true, force: true }));
  await writeFile(join(assets, "index.html"), INDEX_HTML);
  const server = await startAdminServer({
    repo: REPO,
    project: PROJECT,
    status: "idle",
    log: () => {},
    assetsDir: assets,
    settings: {
      load,
      save: () => Promise.reject(new Error("このテストでは保存しない")),
    },
  });
  cleanups.push(() => server.close());
  return server;
}

// ---- 画面のソース（src の外にあるので、実行時に import する） ----

type Lang = "ja" | "en";
type SettingsTab = "general" | "commands" | "perms" | "discord" | "prompts";
interface SettingsState {
  form: SettingsForm;
  tab: SettingsTab;
}

interface SettingsStateModule {
  initSettings(data: SettingsData): SettingsState;
  editForm(
    state: SettingsState,
    edit: (form: SettingsForm) => void,
  ): SettingsState;
}

interface SettingsModule {
  Settings: ComponentType<{
    data: SettingsData;
    state: SettingsState;
    lang: Lang;
  }>;
}

async function importWeb<T>(file: string): Promise<T> {
  const url = pathToFileURL(join(ROOT, "web", "src", file)).href;
  return (await import(/* @vite-ignore */ url)) as T;
}

const settingsState = () => importWeb<SettingsStateModule>("settings-state.ts");

/** 「窓口（Discord）」タブを開いた画面。edit で入力中の値を変える（保存前） */
async function renderDiscord(
  data: SettingsData,
  lang: Lang = "ja",
  edit?: (form: SettingsForm) => void,
): Promise<string> {
  const { Settings } = await importWeb<SettingsModule>("Settings.tsx");
  const ss = await settingsState();
  let state: SettingsState = { ...ss.initSettings(data), tab: "discord" };
  if (edit !== undefined) state = ss.editForm(state, edit);
  return renderToStaticMarkup(createElement(Settings, { data, state, lang }));
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

/** 空白を全部除く（タグの境目に入る空白の差を無視して文言を比べる） */
const squash = (s: string) => s.replace(/\s+/g, "");

function hasNotice(html: string, lang: Lang): boolean {
  return squash(textOf(html)).includes(
    squash(lang === "ja" ? NOTICE_JA : NOTICE_EN),
  );
}

/** どちらの言語の案内も出ていない */
function noNotice(html: string): boolean {
  const text = textOf(html);
  return (
    !text.includes(NOTICE_HEAD_JA) &&
    !text.includes(NOTICE_HEAD_EN) &&
    !hasNotice(html, "ja") &&
    !hasNotice(html, "en")
  );
}

/** 案内がトークンの欄の近く（ラベルより後ろで、次の入力欄・ボタンより前）にある */
function expectNoticeNearToken(html: string, lang: Lang) {
  const label = lang === "ja" ? "トークン" : "Token";
  const labelAt = html.search(new RegExp(`>\\s*${label}\\s*<`));
  expect(labelAt, `ラベル「${label}」`).toBeGreaterThanOrEqual(0);
  const noticeAt = html.indexOf(
    lang === "ja" ? NOTICE_HEAD_JA : NOTICE_HEAD_EN,
    labelAt,
  );
  expect(noticeAt, "トークンのラベルより後ろの案内").toBeGreaterThan(labelAt);
  const between = html.slice(labelAt, noticeAt);
  expect(between, "トークンの欄と案内のあいだに別の欄が無い").not.toMatch(
    /<(input|select|textarea|button)\b/,
  );
}

/** CONDUCTOR_DISCORD_TOKEN を等幅の要素で出している */
function expectMonospaceEnvName(html: string) {
  const name = DISCORD_TOKEN_ENV;
  expect(name).toBe("CONDUCTOR_DISCORD_TOKEN");
  const re = new RegExp(`<([a-zA-Z0-9]+)\\b([^>]*)>\\s*${name}\\s*</\\1>`, "g");
  const mono = [...html.matchAll(re)].some(
    (m) =>
      ["code", "kbd", "samp", "tt"].includes(m[1]!.toLowerCase()) ||
      /font-family:[^"]*monospace/i.test(decode(m[2]!)),
  );
  expect(mono, `${name} を等幅の要素で出す`).toBe(true);
}

describe("Issue #82: 設定画面：Discord のトークンが未設定のときの案内", () => {
  it("AC1: トークンが未設定（空白だけも含む）で chat ブロックがあるとき、「窓口（Discord）」タブのトークンの欄の近くに案内を出す", async () => {
    // Given: config.yaml に chat ブロックがあり、CONDUCTOR_DISCORD_TOKEN が未設定 / 空白だけ
    const dir = await seedRepo({ chat: true });
    for (const env of [{}, { [DISCORD_TOKEN_ENV]: "   " }]) {
      const data = await loadSettings(dir, env);
      expect(data.token).toBe("unset");
      expect(data.form.chat.enabled).toBe(true);

      // When: 「窓口（Discord）」タブを開く
      const page = await renderDiscord(data);

      // Then: トークンの欄の近くに案内を出す
      expect(hasNotice(page, "ja"), JSON.stringify(env)).toBe(true);
      expectNoticeNearToken(page, "ja");
      expectMonospaceEnvName(page);
      // 既存の文言は今のまま
      const text = textOf(page);
      expect(text).toContain("トークン");
      expect(text).toContain("未設定");
      expect(text).toContain("値は画面に表示しません");
      expect(text).not.toContain("設定済み");
    }
  });

  it("AC2: トークンが未設定で chat ブロックが無いとき、「Discord を使う」をオンにすると保存前でも案内を出し、オフに戻すと消す", async () => {
    // Given: config.yaml に chat ブロックが無く、トークンが未設定
    const dir = await seedRepo({ chat: false });
    const data = await loadSettings(dir, {});
    expect(data.token).toBe("unset");
    expect(data.form.chat.enabled).toBe(false);
    const before = await renderDiscord(data);
    expect(noNotice(before)).toBe(true);

    // When: 「Discord を使う」をオンにする（保存する前）
    const on = await renderDiscord(data, "ja", (f) => {
      f.chat.enabled = true;
    });

    // Then: その場で案内を出す
    expect(hasNotice(on, "ja")).toBe(true);
    expectNoticeNearToken(on, "ja");
    expectMonospaceEnvName(on);

    // When: オフに戻す
    const off = await renderDiscord(data, "ja", (f) => {
      f.chat.enabled = true;
      f.chat.enabled = false;
    });

    // Then: 案内は消える
    expect(noNotice(off)).toBe(true);
    expect(textOf(off)).toContain("未設定");
  });

  it("AC3: トークンが未設定でも「Discord を使う」がオフなら案内は出さない（トークンの欄の「未設定」は出す）", async () => {
    // Given: トークンが未設定
    // chat ブロックが無い（オフのまま）
    const noChat = await loadSettings(await seedRepo({ chat: false }), {});
    expect(noChat.token).toBe("unset");
    // chat ブロックがあるが、画面でオフにした（保存前）
    const withChat = await loadSettings(await seedRepo({ chat: true }), {
      [DISCORD_TOKEN_ENV]: " ",
    });
    expect(withChat.token).toBe("unset");

    const pages = [
      await renderDiscord(noChat),
      await renderDiscord(withChat, "ja", (f) => {
        f.chat.enabled = false;
      }),
    ];
    for (const page of pages) {
      // When: 「Discord を使う」がオフ
      // Then: 案内は出さない。「未設定」は今のまま出す
      expect(noNotice(page)).toBe(true);
      const text = textOf(page);
      expect(text).toContain("トークン");
      expect(text).toContain("未設定");
      expect(text).toContain("値は画面に表示しません");
    }
  });

  it("AC4: トークンが設定済みなら「Discord を使う」がオンでもオフでも案内は出さない（「設定済み」のまま）", async () => {
    // Given: トークンが設定済み
    const env = { [DISCORD_TOKEN_ENV]: SECRET };
    const withChat = await loadSettings(await seedRepo({ chat: true }), env);
    const noChat = await loadSettings(await seedRepo({ chat: false }), env);
    expect(withChat.token).toBe("set");
    expect(noChat.token).toBe("set");

    const pages: [string, string][] = [
      ["chat あり・オン", await renderDiscord(withChat)],
      [
        "chat あり・オフにした",
        await renderDiscord(withChat, "ja", (f) => {
          f.chat.enabled = false;
        }),
      ],
      ["chat なし・オフ", await renderDiscord(noChat)],
      [
        "chat なし・オンにした",
        await renderDiscord(noChat, "ja", (f) => {
          f.chat.enabled = true;
        }),
      ],
      ["English・オン", await renderDiscord(withChat, "en")],
    ];
    for (const [name, page] of pages) {
      // Then: 案内は出さない
      expect(noNotice(page), name).toBe(true);
    }
    for (const [name, page] of pages.slice(0, 4)) {
      // Then: トークンの欄は今のまま「設定済み」
      const text = textOf(page);
      expect(text, name).toContain("トークン");
      expect(text, name).toContain("設定済み");
      expect(text, name).not.toContain("未設定");
    }
  });

  it("AC5: 言語が English なら、AC1 と同じ状態で案内を英語の文言で出す", async () => {
    // Given: 言語を English に切り替えている。chat ブロックがあり、トークンが未設定
    const data = await loadSettings(await seedRepo({ chat: true }), {});
    expect(data.token).toBe("unset");

    // When: 「窓口（Discord）」タブを開く
    const page = await renderDiscord(data, "en");

    // Then: 案内を英語の文言で出す（日本語の案内は出さない）
    expect(hasNotice(page, "en")).toBe(true);
    expect(textOf(page)).not.toContain(NOTICE_HEAD_JA);
    expectNoticeNearToken(page, "en");
    expectMonospaceEnvName(page);
    expect(textOf(page)).toContain("Not set");
  });

  it('AC6: どの状態でも、トークンの値は画面にも GET /api/settings の応答にも出さない（"set" か "unset" だけ）', async () => {
    const token = (value: string) => ({ [DISCORD_TOKEN_ENV]: value });
    const cases: {
      name: string;
      chat: boolean;
      env: Record<string, string>;
    }[] = [
      { name: "設定済み・chat あり", chat: true, env: token(SECRET) },
      { name: "設定済み・chat なし", chat: false, env: token(SECRET) },
      { name: "前後に空白", chat: true, env: token(`  ${SECRET}  `) },
      { name: "未設定・chat あり", chat: true, env: {} },
      { name: "空白だけ・chat あり", chat: true, env: token("   ") },
      { name: "未設定・chat なし", chat: false, env: {} },
    ];
    for (const c of cases) {
      // Given: その状態
      const dir = await seedRepo({ chat: c.chat });
      const server = await seedServer(() => loadSettings(dir, c.env));

      // When: 設定画面を開く（画面は GET /api/settings で読む）
      const res = await fetch(new URL("/api/settings", server.url));
      expect(res.status, c.name).toBe(200);
      const body = await res.text();

      // Then: 応答にトークンの値は無く、token は "set" か "unset" だけ
      expect(body, c.name).not.toContain(SECRET);
      const data = JSON.parse(body) as SettingsData;
      expect(["set", "unset"], c.name).toContain(data.token);
      expect(data.token, c.name).toBe(
        (c.env[DISCORD_TOKEN_ENV] ?? "").trim() === "" ? "unset" : "set",
      );

      // Then: 画面にも出さない（オン・オフどちらでも、日本語・English どちらでも）
      for (const lang of ["ja", "en"] as const) {
        for (const enabled of [true, false]) {
          const page = await renderDiscord(data, lang, (f) => {
            f.chat.enabled = enabled;
          });
          expect(page, `${c.name}・${lang}・${enabled}`).not.toContain(SECRET);
        }
      }
    }
  });
});

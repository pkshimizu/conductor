/**
 * Issue #102: 管理画面の「～役」の表示を「～エージェント」に変える の受け入れテスト
 *
 * 決めたこと（実装エージェントはこれに合わせて作る）:
 * - 文言は web/src/i18n.ts の MESSAGES.ja を docs/specs/agent-naming.md の「2. 変える場所 / 管理画面」の表のとおりにする。
 *   roles: tester→テストエージェント、implementer→実装エージェント、reviewer→レビューエージェント、
 *   specifier→仕様化エージェント、decomposer→分解エージェント（ci・merge はそのまま）。
 *   someRole→エージェント、role→エージェント、tabPerms→エージェントの許可、secPerms→エージェントごとの追加許可、
 *   secPrompts→エージェントごとの指示ファイル、concurrency→レビューエージェントを同時に動かす数、
 *   autoDesc→レビューエージェントが承認したらすぐマージ、language2→エージェントが書く文章の言語、
 *   secProtected→実装エージェントに変えさせないファイル、protectedHelp・permsHelp・restartBody・stopBody も「～エージェント」に。
 * - 画面の部品（Settings.tsx・TaskDetail.tsx・Layout.tsx・control.ts）の形は今までどおり（#65・#67・#68 のテストと同じ）。
 * - 英語（en）は変えない。
 *
 * seed: 対象リポジトリは一時フォルダ（.conductor/config.yaml と、5つの役それぞれの指示ファイル）。
 * 記録は MemoryStore、GitHub は列ごとの Issue を覚えるだけの偽物。ネットワークには出ない。
 * seed の値（タイトル・要約・指示ファイルの中身など）には「役」の字を入れない（画面に「役」が残っていないかを確かめるため）。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { type ComponentType, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import {
  CONDUCTOR_DIR,
  CONFIG_FILE,
  type Config,
  parseConfig,
  type Role,
} from "../config.js";
import type { LoopActivity } from "../loop.js";
import { type IssueKey, MemoryStore } from "../store.js";
import type { SettingsData, SettingsForm } from "../settings-data.js";
import { loadSettings } from "../settings.js";
import { type TaskDetailData, loadTaskDetail } from "../task-detail.js";
import type { TaskIssue } from "../tasks.js";

// ---- seed ----

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REPO = "pkshimizu/wordcards";
const PROJECT = 3;
const ISSUE = 12;
const START = Date.parse("2026-11-20T02:28:00.000Z");

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

const ROLE_LABELS: Record<Role, string> = {
  tester: "テストエージェント",
  implementer: "実装エージェント",
  reviewer: "レビューエージェント",
  specifier: "仕様化エージェント",
  decomposer: "分解エージェント",
};

const OLD_ROLE_LABELS = [
  "テスト役",
  "実装役",
  "レビュー役",
  "仕様化役",
  "分解役",
] as const;

const CONFIG_YAML =
  [
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
    "limits:",
    "  rejections: 4",
    "  objections: 2",
    "  reviewers: 3",
    "merge:",
    "  approval: auto",
    "poll_interval: 45",
    "language: 日本語",
    "roles:",
    "  tester:",
    '    allow: ["Bash(npx playwright test *)"]',
    "  implementer:",
    '    allow: ["Bash(npm run lint)"]',
    "  reviewer:",
    '    allow: ["Bash(npm run typecheck)"]',
    "  specifier:",
    '    allow: ["Bash(gh issue view *)"]',
    "  decomposer:",
    '    allow: ["Bash(gh issue list *)"]',
  ].join("\n") + "\n";

/** 5つの役それぞれの指示ファイル（中身に「役」の字は入れない） */
const PROMPT_FILES: Record<string, string> = {
  "tester/acceptance.md": "# テスト\n\nAC ごとに書きます。\n",
  "implementer/rules.md": "# 実装ルール\n\n関数は小さく保ちます。\n",
  "reviewer/points.md": "# 観点\n\n読みやすさを確かめます。\n",
  "specifier/spec.md": "# 仕様の書き方\n\n要件を表にします。\n",
  "decomposer/split.md": "# 分け方\n\n小さく分けます。\n",
};

/** 対象リポジトリ（.conductor/config.yaml と指示ファイル）を一時フォルダに置き、設定を読む */
async function seedSettings(): Promise<SettingsData> {
  const dir = await mkdtemp(join(tmpdir(), "conductor-102-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, CONDUCTOR_DIR), { recursive: true });
  await writeFile(join(dir, CONDUCTOR_DIR, CONFIG_FILE), CONFIG_YAML);
  for (const [path, text] of Object.entries(PROMPT_FILES)) {
    await mkdir(join(dir, CONDUCTOR_DIR, path, ".."), { recursive: true });
    await writeFile(join(dir, CONDUCTOR_DIR, path), text);
  }
  return loadSettings(dir, {});
}

function makeConfig(): Config {
  return parseConfig(
    [
      `github: { repo: ${REPO}, project: ${PROJECT}, notify: someone }`,
      "protected: [src/acceptance/**]",
      "commands: { setup: s, test: t, acceptance: a, typecheck: c, build: b }",
      "merge: { approval: human }",
      "poll_interval: 30",
      "limits: { rejections: 3, objections: 2 }",
    ].join("\n"),
  );
}

/** 列ごとの Issue を覚えるだけの GitHub */
class FakeBoard {
  readonly columns: Record<string, TaskIssue[]>;

  constructor(columns: Record<string, TaskIssue[]>) {
    this.columns = columns;
  }

  issuesByColumn(): Promise<Map<string, TaskIssue[]>> {
    return Promise.resolve(new Map(Object.entries(this.columns)));
  }

  isMerged(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

/** #12 が実装の段階にあり、5つの役それぞれの結果が経過に記録されている */
async function seedTaskDetail(activity: LoopActivity): Promise<TaskDetailData> {
  let t = START;
  const clock = () => new Date(t);
  const store = new MemoryStore(clock);
  const key: IssueKey = { repo: REPO, issue: ISSUE };
  await store.update(key, {
    branch: `conductor/issue-${ISSUE}`,
    checkpoint: { stage: "implementing" },
  });
  const summaries: [Role, string, string][] = [
    ["specifier", "done", "仕様を書きました"],
    ["decomposer", "done", "作業を2件に分けました"],
    ["tester", "approve", "テストを3件書きました"],
    ["implementer", "objection", "AC2 が読めません"],
    ["reviewer", "reject", "名前が分かりにくいです"],
  ];
  for (const [role, verdict, text] of summaries) {
    t += 60_000;
    await store.addSummary(key, { role, verdict, text });
  }
  const board = new FakeBoard({
    Ready: [],
    Testing: [],
    Implementing: [{ number: ISSUE, title: "並べ替え", body: "本文" }],
    Reviewing: [],
    Done: [],
    Blocked: [],
  });
  const config = makeConfig();
  return loadTaskDetail({ config, store, board, activity }, ISSUE);
}

// ---- 画面のソース（src の外にあるので、実行時に import する） ----

type Lang = "ja" | "en";
type SettingsTab = "general" | "commands" | "perms" | "discord" | "prompts";
interface SettingsState {
  form: SettingsForm;
  tab: SettingsTab;
  prompt?: { role: Role; file?: string };
}

interface ControlState {
  dialog?: string;
  abort?: { issue: number; role?: string };
}

async function importWeb<T>(file: string): Promise<T> {
  const url = pathToFileURL(join(ROOT, "web", "src", file)).href;
  return (await import(/* @vite-ignore */ url)) as T;
}

async function renderSettings(
  data: SettingsData,
  state: Partial<SettingsState>,
  lang: Lang = "ja",
): Promise<string> {
  const { Settings } = await importWeb<{
    Settings: ComponentType<{
      data: SettingsData;
      state: SettingsState;
      lang: Lang;
    }>;
  }>("Settings.tsx");
  const { initSettings } = await importWeb<{
    initSettings(data: SettingsData): SettingsState;
  }>("settings-state.ts");
  return renderToStaticMarkup(
    createElement(Settings, {
      data,
      state: { ...initSettings(data), ...state },
      lang,
    }),
  );
}

async function renderTaskDetail(data: TaskDetailData, lang: Lang = "ja") {
  const { TaskDetail } = await importWeb<{
    TaskDetail: ComponentType<Record<string, unknown>>;
  }>("TaskDetail.tsx");
  const sent = JSON.parse(JSON.stringify(data)) as TaskDetailData;
  return renderToStaticMarkup(
    createElement(TaskDetail, {
      data: sent,
      lang,
      now: new Date(START + 3_600_000),
      order: "oldest",
      expanded: [],
    }),
  );
}

/** 共通の枠を描いて、ダイアログ（role="dialog" の要素から後ろ）を返す */
async function renderDialog(control: ControlState, lang: Lang = "ja") {
  const { Layout } = await importWeb<{
    Layout: ComponentType<Record<string, unknown>>;
  }>("Layout.tsx");
  const html = renderToStaticMarkup(
    createElement(Layout, {
      path: "/",
      lang,
      scheme: "light",
      repo: REPO,
      project: PROJECT,
      status: "running",
      control,
    }),
  );
  const i = html.search(/role="dialog"/);
  return i < 0 ? undefined : html.slice(html.lastIndexOf("<", i));
}

/** 「この作業を中断」を押したときの状態（web/src/control.ts の askAbort） */
async function askAbort(issue: number, role?: string): Promise<ControlState> {
  const control = await importWeb<{
    askAbort(state: ControlState, issue: number, role?: string): ControlState;
  }>("control.ts");
  return control.askAbort({}, issue, role);
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

/** タグを除いた文（aria-label などの属性の文は含めない） */
function textOf(html: string): string {
  return decode(html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ")).trim();
}

/** 属性の値（aria-label・title・placeholder など）も含めた、画面に出る文すべて */
function allTextOf(html: string): string {
  const attrs = [
    ...html.matchAll(/\s(?:aria-label|title|placeholder|alt)="([^"]*)"/g),
  ].map((m) => decode(m[1]!));
  return [textOf(html), ...attrs].join(" ");
}

function tabsOf(html: string): string[] {
  return [
    ...html.matchAll(/<button\b([^>]*\srole="tab"[^>]*)>([\s\S]*?)<\/button>/g),
  ].map((m) => textOf(m[2]!));
}

/** 入力欄の名前（aria-label・label for・包む label） */
function controlLabels(html: string): string[] {
  const labels: string[] = [];
  for (const m of html.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
    const attrs = m[2]!;
    const aria = /\saria-label="([^"]*)"/.exec(attrs)?.[1];
    if (aria !== undefined) {
      labels.push(decode(aria));
      continue;
    }
    const id = /\sid="([^"]*)"/.exec(attrs)?.[1];
    if (id !== undefined) {
      const forId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const lm = new RegExp(
        `<label\\b[^>]*\\sfor="${forId}"[^>]*>([\\s\\S]*?)</label>`,
      ).exec(html);
      if (lm !== null) {
        labels.push(textOf(lm[1]!));
        continue;
      }
    }
    const open = html.lastIndexOf("<label", m.index);
    const close = html.lastIndexOf("</label>", m.index);
    if (open >= 0 && open > close) {
      const until = html.indexOf("</label>", m.index);
      labels.push(textOf(html.slice(open, until < 0 ? undefined : until)));
    }
  }
  return labels;
}

function articles(html: string): string[] {
  return [...html.matchAll(/<article\b[\s\S]*?<\/article>/g)].map((m) =>
    textOf(m[0]),
  );
}

describe("Issue #102: 管理画面の「～役」の表示を「～エージェント」に変える", () => {
  it("AC1: 設定画面の役の名前が出る欄（エージェントの許可・指示ファイル）で、5つの役が「～エージェント」と出る", async () => {
    // Given: 管理画面の設定画面を開いている（5つの役それぞれに追加許可と指示ファイルがある）
    const data = await seedSettings();

    // When: 「エージェントごとの追加許可」の欄を見る
    const perms = await renderSettings(data, { tab: "perms" });
    const permsText = allTextOf(perms);
    // Then: 各役の名前が「～エージェント」と出て、追加欄の名前も「<～エージェント>に操作を追加」になる
    const permLabels = controlLabels(perms);
    for (const [role, label] of Object.entries(ROLE_LABELS)) {
      expect(permsText, `${role} の名前`).toContain(label);
      const add = `${label}に操作を追加`;
      expect(permLabels, `${role} の追加欄`).toContain(add);
    }
    for (const old of OLD_ROLE_LABELS) {
      expect(permsText).not.toContain(old);
    }

    // When: 「エージェントごとの指示ファイル」の欄を見る
    const prompts = await renderSettings(data, { tab: "prompts" });
    const promptsText = allTextOf(prompts);
    // Then: 役を選ぶボタンなどに「～エージェント」と出て、「～役」は出ない
    for (const [role, label] of Object.entries(ROLE_LABELS)) {
      expect(promptsText, `${role} の名前`).toContain(label);
    }
    for (const old of OLD_ROLE_LABELS) {
      expect(promptsText).not.toContain(old);
    }

    // ほかの役を選んでも同じ
    const decomposer = await renderSettings(data, {
      tab: "prompts",
      prompt: { role: "decomposer" },
    });
    expect(allTextOf(decomposer)).toContain("分解エージェント");
    expect(allTextOf(decomposer)).not.toContain("分解役");

    // 英語は今までどおり
    const en = allTextOf(await renderSettings(data, { tab: "perms" }, "en"));
    for (const label of [
      "Tester",
      "Implementer",
      "Reviewer",
      "Specifier",
      "Decomposer",
    ]) {
      expect(en).toContain(label);
    }
  });

  it("AC2: エージェントが動いているとき、タスクの詳細と中断のダイアログで動いているものの名前が「～エージェント」と出て、「～役」は出ない", async () => {
    // Given: #12 の実装エージェントが動いている（経過には5つのエージェントの結果がある）
    const detail = await seedTaskDetail({
      running: { issue: ISSUE, role: "implementer" },
    });

    // When: タスクの詳細を開く
    const page = await renderTaskDetail(detail);
    const pageText = allTextOf(page);
    // Then: 経過の各件に「～エージェント」と出る
    const list = articles(page);
    for (const [role, label] of Object.entries(ROLE_LABELS)) {
      const shown = list.some((a) => a.includes(label));
      expect(shown, `経過の ${role}`).toBe(true);
    }
    // Then: 「～役」は出ない（「役」の字も残っていない）
    expect(pageText).not.toContain("役");

    // When: 中断のダイアログを開く（動いているのは実装エージェント）
    const dialog = await renderDialog(await askAbort(ISSUE, "implementer"));
    expect(dialog, "中断のダイアログ").toBeDefined();
    // Then: 動いているものの名前が「実装エージェント」と出て、「～役」は出ない
    expect(textOf(dialog!)).toContain(
      "動作中の実装エージェントを止め、Issue を Blocked 列に移します。",
    );
    expect(allTextOf(dialog!)).not.toContain("役");

    // ほかのエージェントが動いているときも同じ
    for (const [role, label] of Object.entries(ROLE_LABELS)) {
      const d = (await renderDialog(await askAbort(ISSUE, role))) ?? "";
      const body = `動作中の${label}を止め`;
      expect(textOf(d), `${role} の中断`).toContain(body);
      expect(allTextOf(d)).not.toContain("役");
    }

    // 動いているものがわからないときは「エージェント」と出す
    const unknown = await renderDialog(await askAbort(ISSUE));
    expect(textOf(unknown ?? "")).toContain(
      "動作中のエージェントを止め、Issue を Blocked 列に移します。",
    );
    expect(allTextOf(unknown ?? "")).not.toContain("役");

    // 英語は今までどおり
    const en = await renderDialog(await askAbort(ISSUE, "implementer"), "en");
    expect(textOf(en ?? "")).toContain(
      "This stops the running Implementer and moves the issue to the Blocked column.",
    );
  });

  it("AC3: 設定画面の各項目の見出しや説明の「～役」が「～エージェント」になっている", async () => {
    // Given: 設定画面を開いている
    const data = await seedSettings();

    // When: 各タブの見出しや説明を読む
    const general = await renderSettings(data, { tab: "general" });
    const commands = await renderSettings(data, { tab: "commands" });
    const perms = await renderSettings(data, { tab: "perms" });
    const discord = await renderSettings(data, { tab: "discord" });
    const prompts = await renderSettings(data, { tab: "prompts" });

    // Then: タブ名
    expect(tabsOf(general)).toEqual([
      "基本",
      "コマンドとファイル",
      "エージェントの許可",
      "窓口（Discord）",
      "指示ファイル",
    ]);

    // Then: 基本のタブの見出し・説明
    const generalLabels = controlLabels(general);
    expect(generalLabels).toContain("レビューエージェントを同時に動かす数");
    expect(generalLabels).toContain("エージェントが書く文章の言語");
    expect(allTextOf(general)).toContain(
      "レビューエージェントが承認したらすぐマージ",
    );

    // Then: コマンドとファイルのタブの見出し・説明
    expect(textOf(commands)).toContain(
      "実装エージェントに変えさせないファイル",
    );
    expect(textOf(commands)).toContain(
      "glob で指定します。実装エージェントはここに当てはまるファイルを変更できません。",
    );

    // Then: エージェントの許可のタブの見出し・説明
    expect(textOf(perms)).toContain("エージェントごとの追加許可");
    expect(textOf(perms)).toContain(
      "エージェントごとに、追加で許可する操作を指定します（例: Bash(npm run lint)）",
    );

    // Then: 指示ファイルのタブの見出し
    expect(textOf(prompts)).toContain("エージェントごとの指示ファイル");
    expect(textOf(prompts)).toContain("エージェント");

    // Then: どのタブにも「役」の字は残っていない
    for (const [name, page] of Object.entries({
      general,
      commands,
      perms,
      discord,
      prompts,
    })) {
      expect(allTextOf(page), `${name} のタブ`).not.toContain("役");
    }

    // Then: 停止・再起動のダイアログの本文も「エージェント」になっている
    const stop = await renderDialog({ dialog: "stop" });
    expect(textOf(stop ?? "")).toContain(
      "GitHub の確認とエージェントの実行を止めます。再開するには「再起動」を押してください。",
    );
    const restart = await renderDialog({ dialog: "restart" });
    expect(textOf(restart ?? "")).toContain(
      "動作中のエージェントはいったん止まります。設定の変更は再起動のあとに反映されます。",
    );

    // 英語は今までどおり
    const en = await renderSettings(data, { tab: "general" }, "en");
    expect(tabsOf(en)).toContain("Role permissions");
    expect(controlLabels(en)).toContain("Reviewers running at the same time");
    expect(controlLabels(en)).toContain("Language roles write in");
  });
});

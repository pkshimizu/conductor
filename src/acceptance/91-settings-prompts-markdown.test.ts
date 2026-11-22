/**
 * Issue #91: 設定画面の「指示ファイル」タブで Markdown を整形して見せ、「整形」「原文」を切り替えられるようにする の受け入れテスト
 *
 * 決めたこと（実装役はこれに合わせて作る）:
 * - `web/src/settings-state.ts` の `SettingsState.prompt` を `{ role: Role; file?: string; source?: true }` にする。
 *   `source: true` のときは「原文」、無いときは「整形」（既定）
 * - `web/src/Settings.tsx` の `PromptsTab` は、ファイル名のボタンの並びの後ろ（右または下）・中身の前に、
 *   `aria-label`（ja「表示のしかた」／en「View」）を付けた要素を置き、その中に `<button type="button" aria-pressed>` の
 *   「整形」（viewRendered）・「原文」（viewSource）を出す。見た目は `tabStyle(選んでいるか)` と同じ
 *   （height 28px・padding 0 10px・border-radius 6px、選んでいれば background var(--panel)、でなければ transparent）
 * - 「整形」のときは中身を `MarkdownView` で描く。「原文」のときは今までどおり `<pre style={PRE}>{file.text}</pre>`
 * - 「原文」のボタンを押すと onState に `prompt.source === true` の状態を渡す。
 *   役・ファイルのボタンを押すと onState に `prompt` を `{ role, file }`（役を選んだときは `{ role }`）で置き換えた状態を渡す（source は残さない）
 * - `web/src/i18n.ts` の `Messages` に `viewRendered`・`viewSource`・`viewMode` を足す（ja: 整形・原文・表示のしかた／en: Formatted・Source・View）
 * - Settings はフックを使わない（state は props で受け取る）。このテストは要素の木を関数として展開してボタンの onClick を呼ぶ
 *
 * seed: 対象リポジトリは一時フォルダ（.conductor/config.yaml と指示ファイル）。DB・ネットワークは使わない。
 * 描くのは `renderToStaticMarkup`。
 */
import { execSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  type ComponentType,
  createElement,
  isValidElement,
  type ReactElement,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { CONDUCTOR_DIR, CONFIG_FILE, type Role } from "../config.js";
import type { SettingsData, SettingsForm } from "../settings-data.js";
import { loadSettings } from "../settings.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

// ---- seed ----

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

const CONFIG_YAML =
  [
    "github:",
    "  repo: pkshimizu/wordcards",
    "  project: 3",
    "  notify: someone",
    "protected:",
    '  - "src/acceptance/**"',
    "commands:",
    "  setup: npm ci",
    "  test: npm test",
    "  acceptance: npx vitest run src/acceptance",
    "  typecheck: npm run typecheck",
    "  build: npm run build",
  ].join("\n") + "\n";

/** 見出し・箇条書き・コードブロック・表がある指示ファイル（テスト役の最初のファイル） */
const ACCEPTANCE_MD = [
  "# 受け入れテストの書き方",
  "",
  "AC ごとに受け入れテストを書きます。",
  "",
  "- 一つ目の決まり",
  "- 二つ目の決まり",
  "",
  "```ts",
  'const x = "コードブロック";',
  "```",
  "",
  "| 列A | 列B |",
  "| --- | --- |",
  "| 値1 | 値2 |",
  "",
].join("\n");

/** タスクリストがある指示ファイル（テスト役の2つ目のファイル） */
const TASKS_MD = "- [ ] a\n- [x] b\n";

const RULES_MD = "# 実装ルール\n\n関数は小さく保ちます。\n";

const PROMPT_FILES: Record<string, string> = {
  "tester/acceptance.md": ACCEPTANCE_MD,
  "tester/tasks.md": TASKS_MD,
  "implementer/rules.md": RULES_MD,
};

/** 対象リポジトリ（.conductor/config.yaml と指示ファイル）を作って読む */
async function seedData(): Promise<SettingsData> {
  const dir = await mkdtemp(join(tmpdir(), "conductor-91-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, CONDUCTOR_DIR), { recursive: true });
  await writeFile(join(dir, CONDUCTOR_DIR, CONFIG_FILE), CONFIG_YAML);
  for (const [path, text] of Object.entries(PROMPT_FILES)) {
    await mkdir(join(dir, CONDUCTOR_DIR, path, ".."), { recursive: true });
    await writeFile(join(dir, CONDUCTOR_DIR, path), text);
  }
  const data = await loadSettings(dir, {});
  expect(data.prompts.tester.map((p) => p.name)).toEqual([
    "acceptance.md",
    "tasks.md",
  ]);
  return data;
}

// ---- 画面のソース（src の外にあるので、実行時に import する） ----

type Lang = "ja" | "en";
type SettingsTab = "general" | "commands" | "perms" | "discord" | "prompts";
interface PromptState {
  role: Role;
  file?: string;
  source?: true;
}
interface SettingsState {
  form: SettingsForm;
  tab: SettingsTab;
  prompt?: PromptState;
}
interface SettingsProps {
  data: SettingsData;
  state: SettingsState;
  lang: Lang;
  onState?: (state: SettingsState) => void;
}
interface SettingsModule {
  Settings: ComponentType<SettingsProps>;
}
interface SettingsStateModule {
  initSettings(data: SettingsData): SettingsState;
}
interface I18nModule {
  MESSAGES: Record<Lang, Record<string, unknown>>;
}

async function importWeb<T>(file: string): Promise<T> {
  const url = pathToFileURL(join(ROOT, "web", "src", file)).href;
  return (await import(/* @vite-ignore */ url)) as T;
}

async function propsOf(
  data: SettingsData,
  prompt: PromptState | undefined,
  lang: Lang,
  onState?: (state: SettingsState) => void,
): Promise<SettingsProps> {
  const { initSettings } =
    await importWeb<SettingsStateModule>("settings-state.ts");
  const state: SettingsState = { ...initSettings(data), tab: "prompts" };
  if (prompt !== undefined) state.prompt = prompt;
  const props: SettingsProps = { data, state, lang };
  if (onState !== undefined) props.onState = onState;
  return props;
}

/** 「指示ファイル」タブを描いた HTML */
async function renderPrompts(
  data: SettingsData,
  prompt?: PromptState,
  lang: Lang = "ja",
): Promise<string> {
  const { Settings } = await importWeb<SettingsModule>("Settings.tsx");
  return renderToStaticMarkup(
    createElement(Settings, await propsOf(data, prompt, lang)),
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

const squash = (s: string) => s.replace(/\s+/g, "");

function attrOf(attrs: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}="([^"]*)"`, "i").exec(attrs);
  return m === null ? undefined : decode(m[1]!);
}

type Style = Record<string, string>;

function styleOf(attrs: string): Style {
  const style: Style = {};
  for (const part of (attrOf(attrs, "style") ?? "").split(";")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    style[part.slice(0, i).trim().toLowerCase()] = part
      .slice(i + 1)
      .replace(/\s+/g, " ")
      .trim();
  }
  return style;
}

/** index にある開きタグの要素（閉じタグまで） */
function elementAt(html: string, start: number): string {
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

/** aria-label がその値の要素（1つだけ）と、出力中の位置 */
function labelled(
  html: string,
  label: string,
): { html: string; index: number } {
  const re = new RegExp(
    `<[a-zA-Z0-9]+\\b[^>]*\\saria-label="${label}"[^>]*>`,
    "g",
  );
  const found = [...html.matchAll(re)];
  expect(found, `aria-label="${label}" の要素`).toHaveLength(1);
  const index = found[0]!.index;
  return { html: elementAt(html, index), index };
}

interface Button {
  attrs: string;
  text: string;
  index: number;
}

function buttonsOf(html: string): Button[] {
  return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(
    (m) => ({ attrs: m[1]!, text: textOf(m[2]!), index: m.index }),
  );
}

function buttonIn(html: string, label: string): Button {
  const found = buttonsOf(html).filter((b) => b.text === label);
  expect(found, `「${label}」のボタン`).toHaveLength(1);
  return found[0]!;
}

const pressed = (b: Button) => attrOf(b.attrs, "aria-pressed");

/** 表示のしかたのボタンの並び */
function viewGroup(html: string, label = "表示のしかた") {
  return labelled(html, label);
}

/** タブの中に編集できる要素が無いこと */
function expectNoEditable(html: string) {
  expect(html).not.toMatch(/<(input|select|textarea)\b/i);
  expect(html).not.toMatch(/contenteditable/i);
}

// ---- 要素の木をたどってボタンを押す（Settings はフックを使わない） ----

type Props = Record<string, unknown>;
type Render = (props: Props) => unknown;

function asElement(node: unknown): ReactElement<Props> | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  return isValidElement<Props>(node) ? node : undefined;
}

/** 関数の部品を描いた結果。フックを使う部品（Markdown の描画など）は undefined */
function renderComponent(el: ReactElement<Props>): unknown {
  try {
    return (el.type as unknown as Render)(el.props);
  } catch {
    return undefined;
  }
}

/** 関数の部品を展開して、出てくる HTML の要素を順に集める */
function hostElements(node: unknown, out: ReactElement<Props>[] = []) {
  if (Array.isArray(node)) {
    for (const n of node) hostElements(n, out);
    return out;
  }
  const el = asElement(node);
  if (el === undefined) return out;
  if (typeof el.type === "function") {
    hostElements(renderComponent(el), out);
    return out;
  }
  if (typeof el.type === "string") out.push(el);
  hostElements(el.props.children, out);
  return out;
}

function nodeText(node: unknown): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  const el = asElement(node);
  if (el === undefined) return "";
  if (typeof el.type === "function") return nodeText(renderComponent(el));
  return nodeText(el.props.children);
}

/**
 * その文のボタンを押して、onState に渡った状態を返す。
 * 役のボタンはファイルの数も出すので、文の後ろに数が付くものも同じボタンとみなす
 */
async function click(
  data: SettingsData,
  prompt: PromptState | undefined,
  label: string,
): Promise<SettingsState> {
  const { Settings } = await importWeb<SettingsModule>("Settings.tsx");
  const updates: SettingsState[] = [];
  const props = await propsOf(data, prompt, "ja", (s) => updates.push(s));
  const tree = (Settings as unknown as (p: SettingsProps) => unknown)(props);
  const matches = (el: ReactElement<Props>) => {
    if (el.type !== "button") return false;
    const text = nodeText(el.props.children).replace(/\s+/g, "");
    return text === label || new RegExp(`^${label}\\d+$`).test(text);
  };
  const found = hostElements(tree).filter(matches);
  expect(found, `「${label}」のボタン`).toHaveLength(1);
  const onClick = found[0]!.props.onClick;
  expect(typeof onClick, `「${label}」の onClick`).toBe("function");
  (onClick as () => void)();
  expect(
    updates.length,
    `「${label}」を押したときの onState`,
  ).toBeGreaterThanOrEqual(1);
  return updates[updates.length - 1]!;
}

function run(command: string): string {
  return execSync(command, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("Issue #91: 指示ファイルのタブで Markdown を整形して見せ、「整形」「原文」を切り替える", () => {
  it("AC1: 既定の状態では、見出し・箇条書き・コードブロック・表を HTML の要素として描き、本文の文字が読める（68 の AC5 も通る）", async () => {
    // Given: 指示ファイルに見出し・箇条書き・コードブロック・表がある
    const data = await seedData();

    // When: 「指示ファイル」タブを既定の状態で描く
    const html = await renderPrompts(data);

    // Then: 見出しは <h1>、箇条書きは <ul><li>、コードブロックは <pre><code>、表は <table>
    expect(html).toMatch(/<h1\b[^>]*>\s*受け入れテストの書き方\s*<\/h1>/);
    expect(html).toMatch(/<ul\b[^>]*>\s*<li\b[^>]*>[\s\S]*?一つ目の決まり/);
    expect(html).toMatch(/<li\b[^>]*>[\s\S]*?二つ目の決まり/);
    expect(html).toMatch(/<pre\b[^>]*>\s*<code\b[^>]*>[\s\S]*?コードブロック/);
    expect(html).toMatch(
      /<table\b[^>]*>[\s\S]*?列A[\s\S]*?値2[\s\S]*?<\/table>/,
    );
    // 本文の文字が画面の文字として読める（Markdown の記号はそのまま出さない）
    const text = textOf(html);
    expect(text).toContain("AC ごとに受け入れテストを書きます。");
    expect(text).not.toContain("# 受け入れテストの書き方");
    expect(text).not.toContain("| --- |");
    expect(text).not.toContain("```");

    // Then: 既存の 68 の AC5 が通る（失敗すると execSync が例外を投げる）
    run('npx vitest run src/acceptance/68-settings.test.ts -t "AC5"');
  }, 120_000);

  it("AC2: タスクリストは ☐ a・☑ b の文字で見え、タブの中に input・select・textarea・contenteditable が無い", async () => {
    // Given: 指示ファイルにタスクリスト - [ ] a・- [x] b がある
    const data = await seedData();

    // When: 「指示ファイル」タブを描く
    const tasks = await renderPrompts(data, {
      role: "tester",
      file: "tasks.md",
    });
    const first = await renderPrompts(data);

    // Then: ☐ a・☑ b が見える
    const text = squash(textOf(tasks));
    expect(text).toContain("☐a");
    expect(text).toContain("☑b");
    expect(textOf(tasks)).not.toContain("[ ]");
    expect(textOf(tasks)).not.toContain("[x]");

    // Then: タブの中に編集できる要素が無い
    expectNoEditable(tasks);
    expectNoEditable(first);
  });

  it('AC3: 既定では中身の上に aria-label="表示のしかた" のボタンの並びがあり、「整形」「原文」の <button type="button"> の「整形」に aria-pressed="true" が付く（見た目は tabStyle）', async () => {
    // Given: 「指示ファイル」タブを開いた状態（prompt.source が無い）
    const data = await seedData();

    // When: タブを描く
    const html = await renderPrompts(data);

    // Then: ボタンの並びがあり、その中に「整形」「原文」がある
    const group = viewGroup(html);
    const buttons = buttonsOf(group.html);
    expect(buttons.map((b) => b.text)).toEqual(["整形", "原文"]);
    for (const b of buttons) {
      expect(attrOf(b.attrs, "type"), `「${b.text}」の type`).toBe("button");
    }
    const rendered = buttonIn(group.html, "整形");
    const source = buttonIn(group.html, "原文");
    expect(pressed(rendered)).toBe("true");
    expect(pressed(source)).toBe("false");

    // Then: ファイル名のボタンの並びの後ろ（右または下）、中身の上にある
    const fileButton = buttonIn(html, "tasks.md");
    expect(group.index).toBeGreaterThan(fileButton.index);
    // 画面の見出し（<h1>設定</h1>）ではなく、中身の見出し
    const heading = html.search(/<h1\b[^>]*>\s*受け入れテストの書き方/);
    expect(heading, "中身の見出し").toBeGreaterThanOrEqual(0);
    expect(group.index).toBeLessThan(heading);

    // Then: 見た目は既存の tabStyle にならう
    const on = styleOf(rendered.attrs);
    const off = styleOf(source.attrs);
    for (const s of [on, off]) {
      expect(s["height"]).toBe("28px");
      expect(s["padding"]).toBe("0 10px");
      expect(s["border-radius"]).toBe("6px");
      expect(s["cursor"]).toBe("pointer");
    }
    expect(on["background"]).toBe("var(--panel)");
    expect(on["color"]).toBe("var(--fg)");
    expect(on["box-shadow"]).toBe("var(--shadow)");
    expect(off["background"]).toBe("transparent");
    expect(off["color"]).toBe("var(--muted)");
  });

  it('AC4: prompt が { role, file, source: true } なら「原文」に aria-pressed="true" が付き、<pre style={PRE}> に Markdown の原文がそのまま出る', async () => {
    // Given: SettingsState の prompt が { role, file, source: true }
    const data = await seedData();

    // When: タブを描く
    const html = await renderPrompts(data, {
      role: "tester",
      file: "acceptance.md",
      source: true,
    });

    // Then: 「原文」に aria-pressed="true"
    const group = viewGroup(html);
    expect(pressed(buttonIn(group.html, "原文"))).toBe("true");
    expect(pressed(buttonIn(group.html, "整形"))).toBe("false");

    // Then: <pre style={PRE}> に原文（# などの記号を含む）がそのまま出る
    const pres = [...html.matchAll(/<pre\b([^>]*)>([\s\S]*?)<\/pre>/g)];
    const raw = pres.filter(
      (m) => decode(m[2]!).trim() === ACCEPTANCE_MD.trim(),
    );
    expect(raw, "原文の <pre>").toHaveLength(1);
    const style = styleOf(raw[0]![1]!);
    expect(style["margin"]).toBe("0");
    expect(style["padding"]).toBe("14px 16px");
    expect(style["border-radius"]).toBe("8px");
    expect(style["border"]).toBe("1px solid var(--border)");
    expect(style["background"]).toBe("var(--subtle)");
    expect(style["font-size"]).toBe("12px");
    expect(style["white-space"]).toBe("pre-wrap");
    expect(decode(raw[0]![2]!)).toContain("# 受け入れテストの書き方");
    expect(decode(raw[0]![2]!)).toContain("| --- | --- |");

    // 整形した要素は出さない
    expect(html).not.toMatch(/<h1\b[^>]*>\s*受け入れテストの書き方/);
    expect(html).not.toMatch(/<table\b/);
  });

  it("AC5: 「原文」を選んだ状態で役またはファイルを選び直すと、prompt が { role, file } で置き換わり「整形」に戻る", async () => {
    const data = await seedData();

    // Given: 「原文」を選んでいる状態（既定から「原文」を押す）
    const chosen = await click(data, undefined, "原文");
    expect(chosen.tab).toBe("prompts");
    expect(chosen.prompt?.source).toBe(true);
    const sourceState: PromptState = {
      role: "tester",
      file: "acceptance.md",
      source: true,
    };

    // When: ファイルを選び直す
    const byFile = await click(data, sourceState, "tasks.md");
    // Then: prompt が { role, file } で置き換わる
    expect(byFile.prompt).toStrictEqual({ role: "tester", file: "tasks.md" });
    // Then: 「整形」に戻る
    const fileHtml = await renderPrompts(data, byFile.prompt);
    expect(pressed(buttonIn(viewGroup(fileHtml).html, "整形"))).toBe("true");
    expect(pressed(buttonIn(viewGroup(fileHtml).html, "原文"))).toBe("false");
    expect(squash(textOf(fileHtml))).toContain("☐a");

    // When: 役を選び直す
    const byRole = await click(data, sourceState, "実装役");
    // Then: prompt がその役で置き換わり、source は残らない
    expect(byRole.prompt?.role).toBe("implementer");
    expect(byRole.prompt).not.toHaveProperty("source");
    expect([undefined, "rules.md"]).toContain(byRole.prompt?.file);
    // Then: 「整形」に戻る
    const roleHtml = await renderPrompts(data, byRole.prompt);
    expect(pressed(buttonIn(viewGroup(roleHtml).html, "整形"))).toBe("true");
    expect(roleHtml).toMatch(/<h1\b[^>]*>\s*実装ルール\s*<\/h1>/);
  });

  it("AC6: 英語では「Formatted」「Source」、ボタンの並びの aria-label は「View」と出る（i18n に viewRendered・viewSource・viewMode がある）", async () => {
    // Given: 画面の言語を英語にしている
    const data = await seedData();
    const { MESSAGES } = await importWeb<I18nModule>("i18n.ts");
    expect(MESSAGES.ja["viewRendered"]).toBe("整形");
    expect(MESSAGES.ja["viewSource"]).toBe("原文");
    expect(MESSAGES.ja["viewMode"]).toBe("表示のしかた");
    expect(MESSAGES.en["viewRendered"]).toBe("Formatted");
    expect(MESSAGES.en["viewSource"]).toBe("Source");
    expect(MESSAGES.en["viewMode"]).toBe("View");

    // When: 「指示ファイル」タブを描く
    const html = await renderPrompts(data, undefined, "en");

    // Then: ボタンは「Formatted」「Source」、並びの aria-label は「View」
    const group = viewGroup(html, "View");
    expect(buttonsOf(group.html).map((b) => b.text)).toEqual([
      "Formatted",
      "Source",
    ]);
    expect(pressed(buttonIn(group.html, "Formatted"))).toBe("true");
    expect(html).not.toContain('aria-label="表示のしかた"');
    expect(textOf(html)).not.toContain("整形");
    expect(textOf(html)).not.toContain("原文");
  });

  it("AC7: lint・format:check・typecheck・テスト・build がすべて通り、サーバー側（src/settings.ts・SettingsData）に変更が無い", () => {
    // When / Then: それぞれ通る（失敗すると execSync が例外を投げる）
    run("npm run lint");
    run("npm run format:check");
    run("npm run typecheck");
    // npm test はこのテスト自身を含むので、受け入れテスト以外を流す（受け入れテストはこの実行で確かめる）
    run('npx vitest run --exclude "src/acceptance/**"');
    run("npm run build");

    // Then: main から分かれたところと比べて、src/settings.ts と src/settings-data.ts（SettingsData）に変更が無い
    let base: string | undefined;
    for (const ref of ["origin/main", "main"]) {
      try {
        base = run(`git merge-base HEAD ${ref}`).trim();
        break;
      } catch {
        // 次の候補
      }
    }
    expect(base, "main との分かれ目").toBeDefined();
    const diff = run(
      `git diff ${base!} -- src/settings.ts src/settings-data.ts`,
    );
    expect(diff).toBe("");
  }, 600_000);
});

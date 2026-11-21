/**
 * Issue #90: 共通の部品 MarkdownView を作る（react-markdown・remark-gfm で安全に整形する）の受け入れテスト
 *
 * 決めたこと（実装役はこれに合わせて作る）:
 * - `web/src/MarkdownView.tsx` が `MarkdownView` を名前付きで export する。
 *   props は `{ text: string; t: Messages }`（`t` は `web/src/i18n.ts` の `Messages`。この Issue では使わなくてよい）
 * - 描画は `react-markdown` と `remark-gfm`。`rehype-raw` は使わない
 * - スタイルは既存の部品と同じく要素の inline style（`style={...}`）で付ける。
 *   色はすべて `var(--xxx)` で、`web/src/palette.ts` の `themeStyle` が出す変数だけを使う
 * - 外枠は出力のいちばん外の要素。表は1つの要素（表を包む要素）の直下に置き、その要素に横スクロールを付ける
 * - コードブロックの横スクロール・背景は `<pre>` に付ける
 * - 画像は alt（空なら URL）を斜体（`<em>`・`<i>`、または `font-style: italic`）で見せる
 * - タスクリストの印は `☐`（未）／`☑`（済）の文字
 *
 * seed: Markdown の文字だけ（DB・ネットワークは使わない）。描くのは `renderToStaticMarkup`。
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { type ComponentType, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const VIEW_FILE = join(ROOT, "web", "src", "MarkdownView.tsx");

// ---- seed ----

/** AC1・AC6 で使う、見せるものを一通り含む Markdown */
const FULL = [
  "# 受け入れテストの書き方",
  "",
  "AC ごとに受け入れテストを書きます。",
  "**強調** と *斜体* と ~~取り消し~~ と `npm test` を使います。",
  "",
  "## 手順",
  "",
  "- 一つ目",
  "  - 入れ子の一つ目",
  "  - 入れ子の二つ目",
  "- 二つ目",
  "",
  "1. 番号の一",
  "2. 番号の二",
  "",
  "### コード",
  "",
  "```ts",
  'const x = "コードブロック";',
  "```",
  "",
  "#### 表",
  "",
  "| 列A | 列B |",
  "| --- | --- |",
  "| 値1 | 値2 |",
  "",
  "##### 引用",
  "",
  "> 引用の文",
  "",
  "###### 横線",
  "",
  "---",
  "",
  "[リンク](https://example.com/docs)",
  "",
].join("\n");

// ---- 画面のソース（src の外にあるので、実行時に import する） ----

type Props = { text: string; t: unknown };
type ViewModule = { MarkdownView: ComponentType<Props> };
type I18nModule = { MESSAGES: Record<"ja" | "en", unknown> };
type Theme = Record<string, unknown>;
type PaletteModule = { themeStyle(scheme: "light" | "dark"): Theme };

async function importWeb<T>(file: string): Promise<T> {
  const url = pathToFileURL(join(ROOT, "web", "src", file)).href;
  return (await import(/* @vite-ignore */ url)) as T;
}

async function render(text: string): Promise<string> {
  const view = await importWeb<ViewModule>("MarkdownView.tsx");
  const i18n = await importWeb<I18nModule>("i18n.ts");
  const props: Props = { text, t: i18n.MESSAGES.ja };
  return renderToStaticMarkup(createElement(view.MarkdownView, props));
}

function run(command: string): string {
  return execSync(command, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
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

/** 空白を全部除く */
const squash = (s: string) => s.replace(/\s+/g, "");

/** 空白の差を無視して値を比べる */
const norm = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/** 開きタグ（属性の文字列と出力中の位置） */
interface Tag {
  attrs: string;
  index: number;
  end: number;
}

function tags(html: string, name: string): Tag[] {
  const re = new RegExp(`<${name}\\b([^>]*)>`, "g");
  const found: Tag[] = [];
  for (const m of html.matchAll(re)) {
    const end = m.index + m[0].length;
    found.push({ attrs: m[1]!, index: m.index, end });
  }
  return found;
}

type Style = Record<string, string>;

/** style 属性を { プロパティ: 値 } にする */
function styleOf(attrs: string): Style {
  const m = /\bstyle="([^"]*)"/.exec(attrs);
  const out: Style = {};
  if (m === null) return out;
  for (const part of decode(m[1]!).split(";")) {
    const at = part.indexOf(":");
    if (at < 0) continue;
    const prop = part.slice(0, at).trim().toLowerCase();
    out[prop] = part.slice(at + 1).trim();
  }
  return out;
}

function expectStyle(style: Style, prop: string, value: string, what: string) {
  expect(norm(style[prop]), `${what} の ${prop}`).toBe(value);
}

function backgroundOf(style: Style): string {
  return norm(style["background"] ?? style["background-color"]);
}

/** 開きタグの直後から、閉じタグまでの中身（入れ子の同名タグは考えない） */
function innerOf(html: string, name: string, tag: Tag): string {
  const close = html.indexOf(`</${name}>`, tag.end);
  return html.slice(tag.end, close < 0 ? undefined : close);
}

/** テーマの CSS 変数の名前（--bg など） */
async function themeVariables(): Promise<Set<string>> {
  const palette = await importWeb<PaletteModule>("palette.ts");
  const names = new Set<string>();
  for (const scheme of ["light", "dark"] as const) {
    for (const key of Object.keys(palette.themeStyle(scheme))) {
      if (key.startsWith("--")) names.add(key);
    }
  }
  return names;
}

/** 文字の中の var(--xxx) の名前 */
function usedVariables(s: string): string[] {
  const names: string[] = [];
  for (const m of decode(s).matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)) {
    names.push(m[1]!);
  }
  return names;
}

/** 中身が shown だけの要素が斜体（<em>・<i>・font-style: italic）か */
function isItalic(html: string, shown: string): boolean {
  const re = /<([a-zA-Z0-9]+)\b([^>]*)>([^<]*)<\/\1>/g;
  for (const m of html.matchAll(re)) {
    if (decode(m[3]!).trim() !== shown) continue;
    const name = m[1]!.toLowerCase();
    if (name === "em" || name === "i") return true;
    if (norm(styleOf(m[2]!)["font-style"]) === "italic") return true;
  }
  return false;
}

type Pkg = { [field: string]: Record<string, string> | undefined };
type LockEntry = { version?: string; devDependencies?: Pkg[string] };
type Lock = { packages: Record<string, LockEntry | undefined> };

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(join(ROOT, file), "utf8")) as T;
}

describe("Issue #90: 共通の部品 MarkdownView", () => {
  it("AC1: react-markdown・remark-gfm を版を固定して devDependencies に足し、見出し・箇条書き・コードブロック・表・引用・取り消し線を HTML の要素として描く", async () => {
    // Given: package.json の devDependencies に版を固定して足し、package-lock.json も更新してある
    const pkg = readJson<Pkg>("package.json");
    const lock = readJson<Lock>("package-lock.json");
    for (const name of ["react-markdown", "remark-gfm"]) {
      const version = pkg["devDependencies"]?.[name];
      expect(version, `${name} は devDependencies にある`).toBeDefined();
      expect(version, `${name} の版は固定する`).toMatch(/^\d+\.\d+\.\d+$/);
      const inDeps = pkg["dependencies"]?.[name];
      expect(inDeps, `${name} は dependencies に入れない`).toBeUndefined();
      const root = lock.packages[""]?.devDependencies?.[name];
      expect(root, `lock の ${name}`).toBe(version);
      const installed = lock.packages[`node_modules/${name}`]?.version;
      expect(installed, `lock の node_modules/${name}`).toBe(version);
    }

    // When: 見せるものを一通り含む text を描く
    const html = await render(FULL);
    const text = textOf(html);

    // Then: 見出しは <h1>
    expect(html).toMatch(/<h1\b[^>]*>\s*受け入れテストの書き方\s*<\/h1>/);
    // 箇条書きは <ul><li>（入れ子を含む）
    expect(html).toMatch(/<ul\b[^>]*>\s*<li\b/);
    expect(html).toMatch(/<li\b[^>]*>(?:(?!<\/li>)[\s\S])*<ul\b/);
    expect(text).toContain("入れ子の一つ目");
    // 番号付きリスト
    expect(html).toMatch(/<ol\b[^>]*>\s*<li\b/);
    // コードブロックは <pre><code>
    expect(html).toMatch(/<pre\b[^>]*>\s*<code\b/);
    expect(text).toContain('const x = "コードブロック";');
    // 表は <table>
    expect(html).toMatch(/<table\b/);
    expect(text).toContain("列A");
    expect(text).toContain("値2");
    // 引用は <blockquote>
    expect(html).toMatch(/<blockquote\b[^>]*>[\s\S]*引用の文/);
    // 取り消し線は <del>
    expect(html).toMatch(/<del\b[^>]*>\s*取り消し\s*<\/del>/);
    // 横線・強調・斜体・インラインコード・リンク
    expect(html).toMatch(/<hr\b/);
    expect(html).toMatch(/<strong\b[^>]*>\s*強調\s*<\/strong>/);
    expect(html).toMatch(/<em\b[^>]*>\s*斜体\s*<\/em>/);
    expect(html).toMatch(/<code\b[^>]*>\s*npm test\s*<\/code>/);
    expect(html).toMatch(/<a\b[^>]*href="https:\/\/example\.com\/docs"/);
    expect(text).toContain("AC ごとに受け入れテストを書きます。");
  });

  it("AC2: 生の HTML（<script>・<b>）はタグとして出さず、その文字が見える（rehype-raw を使わない）", async () => {
    // Given: text に <script>alert(1)</script> と <b>x</b> がある
    const text = [
      "前の文",
      "",
      "<script>alert(1)</script>",
      "",
      "太字にしない <b>x</b> の文",
      "",
    ].join("\n");

    // When: 描く
    const html = await render(text);

    // Then: タグは出ない
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/<b\b/i);
    // Then: その文字が見える
    const shown = squash(textOf(html));
    expect(shown).toContain(squash("<script>alert(1)</script>"));
    expect(shown).toContain(squash("<b>x</b>"));
    expect(shown).toContain("前の文");

    // Then: rehype-raw を使っていない
    const source = readFileSync(VIEW_FILE, "utf8");
    expect(source).not.toContain("rehype-raw");
    const pkg = readFileSync(join(ROOT, "package.json"), "utf8");
    expect(pkg).not.toContain("rehype-raw");
  });

  it('AC3: javascript: のリンクには href を付けず、https のリンクは target="_blank" と rel="noopener noreferrer" で開く', async () => {
    // Given: text に [x](javascript:alert(1)) と [y](https://example.com) がある
    const text = "[x](javascript:alert(1)) と [y](https://example.com)\n";

    // When: 描く
    const html = await render(text);

    // Then: javascript: の href は付かない
    const lower = decode(html).toLowerCase();
    expect(lower).not.toMatch(/href="\s*javascript:/);
    expect(lower).not.toContain("javascript:alert");
    expect(textOf(html)).toContain("x");

    // Then: https のリンクには target と rel が付く
    const href = /href="https:\/\/example\.com\/?"/;
    const links = tags(html, "a").filter((t) => href.test(t.attrs));
    expect(links, "https://example.com のリンク").toHaveLength(1);
    const link = links[0]!;
    expect(link.attrs).toMatch(/\btarget="_blank"/);
    expect(link.attrs).toMatch(/\brel="noopener noreferrer"/);
    expect(textOf(innerOf(html, "a", link))).toBe("y");
  });

  it("AC4: 画像は <img> を出さず、alt（空なら URL）を斜体で見せる", async () => {
    // Given: text に ![図](https://example.com/a.png) と ![](https://example.com/b.png) がある
    const text = [
      "![図](https://example.com/a.png)",
      "",
      "![](https://example.com/b.png)",
      "",
    ].join("\n");

    // When: 描く
    const html = await render(text);

    // Then: <img> は出ず、画像を読み込まない
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toMatch(/\bsrc=/i);

    // Then: 「図」と、alt が空のほうは URL が斜体で見える
    expect(isItalic(html, "図"), "「図」を斜体で見せる").toBe(true);
    const url = "https://example.com/b.png";
    expect(isItalic(html, url), "alt が空なら URL を斜体で見せる").toBe(true);
  });

  it("AC5: タスクリストは <input> にせず ☐ / ☑ の文字で見せ、input・select・textarea・contenteditable を出さない", async () => {
    // Given: text にタスクリスト - [ ] a と - [x] b がある
    const text = "- [ ] a\n- [x] b\n";

    // When: 描く
    const html = await render(text);

    // Then: <input> は出ず、☐ a と ☑ b が見える
    expect(html).not.toMatch(/<input\b/i);
    const shown = squash(textOf(html));
    expect(shown).toContain("☐a");
    expect(shown).toContain("☑b");
    expect(shown).not.toContain("[]");
    expect(shown).not.toContain("[x]");

    // Then: 出力に input・select・textarea・contenteditable が無い
    const lower = html.toLowerCase();
    for (const word of ["input", "select", "textarea", "contenteditable"]) {
      expect(lower, word).not.toContain(word);
    }
  });

  it("AC6: 外枠・見出し・インラインコード・コードブロック・引用・表のスタイルが仕様 3 のとおりで、使う CSS 変数はすべてテーマにあるもの", async () => {
    // Given: 見せるものを一通り含む text を描いたもの
    const html = await render(FULL);

    // 外枠：今の PRE と同じ枠・角丸・背景・余白。通常のフォント 13px・行の高さ 1.7・長い語の折り返し
    const outer = /^\s*<([a-zA-Z0-9]+)\b([^>]*)>/.exec(html);
    expect(outer, "外枠の要素").not.toBeNull();
    const frame = styleOf(outer![2]!);
    expectStyle(frame, "border", "1px solid var(--border)", "外枠");
    expectStyle(frame, "border-radius", "8px", "外枠");
    expect(backgroundOf(frame), "外枠の背景").toBe("var(--subtle)");
    expectStyle(frame, "padding", "14px 16px", "外枠");
    expectStyle(frame, "font-size", "13px", "外枠");
    expectStyle(frame, "line-height", "1.7", "外枠");
    expectStyle(frame, "overflow-wrap", "anywhere", "外枠");
    const frameFont = norm(frame["font-family"]);
    expect(frameFont, "外枠は等幅にしない").not.toMatch(/monospace/i);

    // 見出し：大きさ・太字 600。h1・h2 は下線
    const sizes: Record<string, string> = {
      h1: "18px",
      h2: "16px",
      h3: "14px",
      h4: "13px",
      h5: "13px",
      h6: "13px",
    };
    for (const [name, size] of Object.entries(sizes)) {
      const found = tags(html, name);
      expect(found, name).toHaveLength(1);
      const style = styleOf(found[0]!.attrs);
      expectStyle(style, "font-size", size, name);
      expectStyle(style, "font-weight", "600", name);
      if (name === "h1" || name === "h2") {
        const line = "1px solid var(--border)";
        expectStyle(style, "border-bottom", line, name);
      }
    }

    // コードブロック：<pre><code>。等幅 12px・行の高さ 1.6・外枠と違う背景・横スクロール
    const block = /<pre\b([^>]*)>\s*<code\b([^>]*)>/.exec(html);
    expect(block, "コードブロック").not.toBeNull();
    const pre = styleOf(block![1]!);
    const blockStyle = { ...styleOf(block![2]!), ...pre };
    const blockFont = norm(blockStyle["font-family"]);
    expect(blockFont, "コードブロックは等幅").toMatch(/monospace/i);
    expectStyle(blockStyle, "font-size", "12px", "コードブロック");
    expectStyle(blockStyle, "line-height", "1.6", "コードブロック");
    expectStyle(pre, "overflow-x", "auto", "コードブロックの <pre>");
    const preBg = backgroundOf(pre);
    expect(preBg, "コードブロックの背景はテーマの変数").toMatch(/^var\(--/);
    expect(preBg, "外枠と違う背景").not.toBe("var(--subtle)");
    const wrapping = ["pre-wrap", "pre-line", "normal", "break-spaces"];
    const whiteSpace = norm(pre["white-space"]);
    expect(wrapping, "コードブロックは折り返さない").not.toContain(whiteSpace);

    // インラインコード：<pre> の中ではない <code>。MONO・12px・var(--border) の枠・小さな角丸
    const blockCodeAt = block!.index + block![0].lastIndexOf("<code");
    const codes = tags(html, "code");
    const inline = codes.filter((t) => t.index !== blockCodeAt);
    expect(inline.length, "インラインコード").toBeGreaterThanOrEqual(1);
    const code = styleOf(inline[0]!.attrs);
    const codeFont = norm(code["font-family"]);
    expect(codeFont, "インラインコードは MONO").toMatch(/JetBrains Mono/);
    expect(codeFont, "インラインコードは MONO").toMatch(/monospace/i);
    expectStyle(code, "font-size", "12px", "インラインコード");
    const codeBorder = norm(code["border"]);
    expect(codeBorder, "インラインコードの枠").toMatch(/var\(--border\)/);
    const radius = Number.parseFloat(norm(code["border-radius"]));
    expect(radius, "インラインコードの角丸").toBeGreaterThan(0);
    expect(radius, "インラインコードの角丸は小さい").toBeLessThan(8);

    // 引用：左に 3px の var(--border2) の線、文字色 var(--muted)
    const quote = tags(html, "blockquote");
    expect(quote, "引用").toHaveLength(1);
    const q = styleOf(quote[0]!.attrs);
    expectStyle(q, "border-left", "3px solid var(--border2)", "引用");
    expectStyle(q, "color", "var(--muted)", "引用");

    // 表：border-collapse、セルの枠、見出しの行は太字、包む要素で横スクロール
    const table = tags(html, "table");
    expect(table, "表").toHaveLength(1);
    const tableStyle = styleOf(table[0]!.attrs);
    expectStyle(tableStyle, "border-collapse", "collapse", "表");
    const wrapper = /<([a-zA-Z0-9]+)\b([^>]*)>\s*<table\b/.exec(html);
    expect(wrapper, "表を包む要素").not.toBeNull();
    const wrap = styleOf(wrapper![2]!);
    const scroll = norm(wrap["overflow-x"] ?? wrap["overflow"]);
    expect(scroll, "表を包む要素は横スクロール").toBe("auto");
    const heads = tags(html, "th");
    const cells = [...heads, ...tags(html, "td")];
    expect(cells.length, "表のセル").toBe(4);
    for (const cell of cells) {
      const style = styleOf(cell.attrs);
      expectStyle(style, "border", "1px solid var(--border)", "セル");
    }
    for (const th of heads) {
      const weight = norm(styleOf(th.attrs)["font-weight"]);
      const bold = weight === "" || weight === "bold" || Number(weight) >= 600;
      expect(bold, `見出しの行は太字（font-weight: ${weight}）`).toBe(true);
    }

    // 使っている CSS 変数はすべてテーマ（palette.ts の themeStyle）にあるもの
    const known = await themeVariables();
    expect(known.has("--subtle")).toBe(true);
    const source = readFileSync(VIEW_FILE, "utf8");
    const used = new Set([...usedVariables(html), ...usedVariables(source)]);
    expect(used.size, "CSS 変数を使っている").toBeGreaterThan(0);
    for (const name of used) {
      expect(known.has(name), `${name} はテーマにある変数`).toBe(true);
    }
    // 色を直に書かない（明るいテーマ・暗いテーマの両方で読めるように）
    expect(decode(html)).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  });

  it("AC7: lint・format:check・typecheck・テスト・build がすべて通る", () => {
    // When / Then: それぞれ通る（失敗すると execSync が例外を投げる）
    run("npm run lint");
    run("npm run format:check");
    run("npm run typecheck");
    // npm test はこのテスト自身を含むので、受け入れテスト以外を流す（受け入れテストはこの実行で確かめる）
    run('npx vitest run --exclude "src/acceptance/**"');
    run("npm run build");
  }, 600_000);
});

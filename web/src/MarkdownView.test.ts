import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MESSAGES } from "./i18n.js";
import { MarkdownView } from "./MarkdownView.js";

function render(text: string): string {
  return renderToStaticMarkup(
    createElement(MarkdownView, { text, t: MESSAGES.ja }),
  );
}

describe("MarkdownView", () => {
  it("最初の要素は上の余白を 0 にし、次の要素には余白を付ける", () => {
    const html = render("\n\n# 見出し\n\n本文\n");
    expect(html).toMatch(/<h1 style="margin:0px 0 0;/);
    expect(html).toMatch(/<p style="margin:12px 0 0">本文<\/p>/);
  });

  it("h3 には下線を付けない", () => {
    const html = render("### 小見出し\n");
    expect(html).not.toContain("border-bottom");
  });

  it("コードブロックの中身は文字のまま見せ、末尾の改行を落とす", () => {
    const html = render("```\n<b>x</b>\n```\n");
    expect(html).toContain("<pre");
    expect(html).toContain("<code>&lt;b&gt;x&lt;/b&gt;</code>");
  });

  it("番号付きリストの始まりの番号を保つ", () => {
    const html = render("3. 三\n4. 四\n");
    expect(html).toMatch(/<ol start="3"/);
  });

  it("タスクリストは印を見せ、リストの点を消す", () => {
    const html = render("- [x] 済み\n");
    expect(html).toContain("list-style:none");
    expect(html).toContain("☑");
  });

  it("危ない URL のリンクは <a> にしない", () => {
    const html = render("[x](javascript:alert(1))\n");
    expect(html).not.toContain("<a");
    expect(html).toContain("<span>x</span>");
  });

  it("空の文字でも外枠だけを描く", () => {
    const html = render("");
    expect(html).toMatch(/^<div style="[^"]*"><\/div>$/);
  });
});

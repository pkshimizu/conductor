/**
 * Markdown の文字を読みやすく整形して見せる共通の部品（仕様 docs/specs/markdown-viewer.md の 1〜3）。
 * react-markdown と remark-gfm で描く。安全のため次のようにする:
 * - 生の HTML は描かず文字として見せる（rehype を足さない）
 * - リンクは react-markdown の既定の URL の検査を通し、新しいタブで開く
 * - 画像は読み込まず、alt（空なら URL）を斜体で見せる
 * - タスクリストの印は入力欄にせず ☐ / ☑ の文字で見せる
 * 色はすべてテーマの CSS 変数（palette.ts の themeStyle）を使う
 */
import type { CSSProperties, ReactElement } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Messages } from "./i18n.js";

export interface MarkdownViewProps {
  /** Markdown の文字 */
  text: string;
  /** 文言（今は使わない。既存の部品にならって受け取る） */
  t: Messages;
}

const MONO = "'JetBrains Mono', ui-monospace, monospace";

const FRAME: CSSProperties = {
  margin: 0,
  padding: "14px 16px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--subtle)",
  color: "var(--fg)",
  fontSize: 13,
  lineHeight: 1.7,
  overflowWrap: "anywhere",
};

const HEADING_SIZES = {
  h1: 18,
  h2: 16,
  h3: 14,
  h4: 13,
  h5: 13,
  h6: 13,
} as const;

/** 上の余白（最初の要素は 0） */
const GAP = 12;

const INLINE_CODE: CSSProperties = {
  fontFamily: MONO,
  fontSize: 12,
  padding: "1px 5px",
  border: "1px solid var(--border)",
  borderRadius: 4,
  background: "var(--panel)",
};

const CODE_BLOCK: CSSProperties = {
  margin: `${GAP}px 0 0`,
  padding: "10px 12px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--bg)",
  fontFamily: MONO,
  fontSize: 12,
  lineHeight: 1.6,
  whiteSpace: "pre",
  overflowX: "auto",
  overflowWrap: "normal",
};

const QUOTE: CSSProperties = {
  margin: `${GAP}px 0 0`,
  padding: "0 0 0 12px",
  borderLeft: "3px solid var(--border2)",
  color: "var(--muted)",
};

const TABLE_WRAP: CSSProperties = {
  margin: `${GAP}px 0 0`,
  overflowX: "auto",
};

const TABLE: CSSProperties = {
  borderCollapse: "collapse",
};

const CELL: CSSProperties = {
  border: "1px solid var(--border)",
  padding: "4px 10px",
  textAlign: "left",
  overflowWrap: "normal",
};

const LINK: CSSProperties = {
  color: "var(--accentText)",
};

/** hast の節点のうち、位置だけを使う */
interface Positioned {
  position?: { start: { line: number } } | undefined;
}

/** 中の文字をつなげる（コードブロックの中身を取り出す） */
function plainText(node: unknown): string {
  if (typeof node !== "object" || node === null) return "";
  if ("value" in node && typeof node.value === "string") return node.value;
  if ("children" in node && Array.isArray(node.children)) {
    return node.children.map((child: unknown) => plainText(child)).join("");
  }
  return "";
}

/** 最初の文字がある行（1 から数える）。文字が無ければ 0 */
function firstLineOf(text: string): number {
  const at = text.search(/\S/);
  if (at < 0) return 0;
  return text.slice(0, at).split("\n").length;
}

function components(firstLine: number): Components {
  /** 最初の要素は上の余白を 0 にする */
  const top = (node: Positioned | undefined, gap: number): number =>
    node?.position?.start.line === firstLine ? 0 : gap;

  const heading =
    (Tag: keyof typeof HEADING_SIZES): Components["h1"] =>
    ({ node, children }) => {
      const underline = Tag === "h1" || Tag === "h2";
      const style: CSSProperties = {
        margin: `${top(node, 20)}px 0 0`,
        fontSize: HEADING_SIZES[Tag],
        fontWeight: 600,
        lineHeight: 1.4,
        ...(underline
          ? { paddingBottom: 4, borderBottom: "1px solid var(--border)" }
          : {}),
      };
      return <Tag style={style}>{children}</Tag>;
    };

  return {
    h1: heading("h1"),
    h2: heading("h2"),
    h3: heading("h3"),
    h4: heading("h4"),
    h5: heading("h5"),
    h6: heading("h6"),
    p: ({ node, children }) => (
      <p style={{ margin: `${top(node, GAP)}px 0 0` }}>{children}</p>
    ),
    ul: ({ node, className, children }) => {
      const tasks = className?.includes("contains-task-list") === true;
      const style: CSSProperties = {
        margin: `${top(node, GAP)}px 0 0`,
        paddingLeft: tasks ? 4 : 22,
        ...(tasks ? { listStyle: "none" } : {}),
      };
      return <ul style={style}>{children}</ul>;
    },
    ol: ({ node, start, children }) => (
      <ol
        start={start}
        style={{ margin: `${top(node, GAP)}px 0 0`, paddingLeft: 22 }}
      >
        {children}
      </ol>
    ),
    li: ({ children }) => <li style={{ marginTop: 2 }}>{children}</li>,
    // タスクリストの印は入力欄にしない
    input: ({ checked }) => (
      <span aria-hidden="true">{checked === true ? "☑" : "☐"}</span>
    ),
    blockquote: ({ node, children }) => (
      <blockquote style={{ ...QUOTE, marginTop: top(node, GAP) }}>
        {children}
      </blockquote>
    ),
    hr: ({ node }) => (
      <hr
        style={{
          margin: `${top(node, 16)}px 0 0`,
          border: 0,
          borderTop: "1px solid var(--border)",
        }}
      />
    ),
    // コードブロックは <pre> で受け、中身を文字のまま <code> に入れる
    pre: ({ node }) => (
      <pre style={{ ...CODE_BLOCK, marginTop: top(node, GAP) }}>
        <code>{plainText(node).replace(/\n$/, "")}</code>
      </pre>
    ),
    // <pre> の外の <code> だけがここに来る（インラインコード）
    code: ({ children }) => <code style={INLINE_CODE}>{children}</code>,
    table: ({ node, children }) => (
      <div style={{ ...TABLE_WRAP, marginTop: top(node, GAP) }}>
        <table style={TABLE}>{children}</table>
      </div>
    ),
    th: ({ children }) => (
      <th style={{ ...CELL, fontWeight: 600 }}>{children}</th>
    ),
    td: ({ children }) => <td style={CELL}>{children}</td>,
    // 既定の URL の検査で危ない URL は空になる。そのときはリンクにしない
    a: ({ href, children }) =>
      href === undefined || href === "" ? (
        <span>{children}</span>
      ) : (
        <a href={href} target="_blank" rel="noopener noreferrer" style={LINK}>
          {children}
        </a>
      ),
    // 画像は読み込まず、alt（空なら URL）を斜体で見せる
    img: ({ alt, src }) => {
      const shown =
        alt !== undefined && alt !== ""
          ? alt
          : typeof src === "string"
            ? src
            : "";
      return <em>{shown}</em>;
    },
  };
}

export function MarkdownView(props: MarkdownViewProps): ReactElement {
  return (
    <div style={FRAME}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={components(firstLineOf(props.text))}
      >
        {props.text}
      </Markdown>
    </div>
  );
}

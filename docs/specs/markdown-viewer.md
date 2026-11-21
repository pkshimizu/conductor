# 指示ファイルを Markdown として整形して見せる

## 要件

> markdownファイルを表示している箇所は、markdown viewerを使用して読みやすくしたい

## 対象の箇所

管理画面で Markdown ファイルの中身を見せているのは、設定の画面の「指示ファイル」タブ（`web/src/Settings.tsx` の `PromptsTab`）だけである。ここでは `.conductor/<役>/*.md` の中身を `<pre>` でそのまま出している（`Settings.tsx` の `{file !== undefined && <pre style={PRE}>{file.text}</pre>}`）。

これを Markdown として整形して見せる。

対象外（ファイルではないため）：

- タスク詳細のタイムラインの要約（`TaskDetail.tsx` の `Entry`）
- 止まった理由（`TaskDetail.tsx`・`Dashboard.tsx` の `blockedReason`・`reason`）

## 仕様

### 1. 共通の部品 `MarkdownView`

`web/src/MarkdownView.tsx` を新しく作り、`MarkdownView` を出す（方針「Markdown 表示」により判断）。

- props：`text: string`（Markdown の文字）と、ボタンの文言（`t: Messages` など、既存の部品にならう）
- 描画には `react-markdown` と `remark-gfm` を使う。`package.json` の `devDependencies` に版を固定して足す（`react` と同じく画面のビルドに入るだけのため。方針「Markdown 表示」により判断）。`package-lock.json` も更新する。
- 見せるもの：見出し（h1〜h6）、段落、強調・斜体・取り消し線、箇条書き・番号付きリスト（入れ子を含む）、タスクリスト、インラインコード、コードブロック、引用、表、横線、リンク。

### 2. 安全（方針「Markdown 表示」により判断）

- 文中の生の HTML は描画せず、文字として見せる。`rehype-raw` は使わない。
- リンクは `react-markdown` の既定の URL の検査を使う。`target="_blank" rel="noopener noreferrer"` で開く。
- 画像は読み込まない。`![alt](url)` は alt の文字（alt が空なら URL）を斜体で見せる。`<img>` を出さない。
- タスクリストのチェックボックスは `<input>` にせず、`☐`（未）／`☑`（済）の文字で見せる。指示ファイルのタブは見るだけで、入力欄があってはならない（既存の受け入れテスト `src/acceptance/68-settings.test.ts` の AC5 が `input`・`select`・`textarea` の無いことを確かめている）。
- `contenteditable` は付けない。

### 3. 見た目（方針「Markdown 表示」により判断）

- 外枠は今の `PRE` と同じ枠・角丸・背景（`1px solid var(--border)`、角丸 8px、`var(--subtle)`、内側の余白 14px 16px）。本文は等幅ではなく画面の通常のフォント、13px、行の高さ 1.7。長い語は `overflowWrap: "anywhere"` で折り返す。
- 見出し：h1 18px・h2 16px・h3 14px・h4〜h6 13px、いずれも太字 600。h1・h2 は下に `1px solid var(--border)` の線。最初の要素の上の余白は 0。
- インラインコード：`MONO`、12px、`var(--border)` の枠と小さな角丸。
- コードブロック：`MONO`、12px、行の高さ 1.6、`var(--bg)` など外枠と違う背景、`overflowX: "auto"`（折り返さず横スクロール）。
- 引用：左に 3px の `var(--border2)` の線、文字色 `var(--muted)`。
- 表：`border-collapse: collapse`、セルに `1px solid var(--border)`、見出しの行は太字。表が広いときは表を包む要素で横スクロール。
- 色はすべてテーマの CSS 変数を使い、明るいテーマ・暗いテーマの両方で読めること。実在しない変数名は使わない（`web/src/theme.ts`・`palette.ts` にあるものを使う）。

### 4. 「整形」「原文」の切り替え（方針「Markdown 表示」により判断）

- 中身の上（ファイル名のボタンの並びの右、または下）に「整形」「原文」の2つのボタンを出す。`<button type="button">` で、選んでいるほうに `aria-pressed="true"`。見た目は既存の `tabStyle` にならう。
- 既定は「整形」。「原文」を選ぶと、今までどおり `<pre style={PRE}>{file.text}</pre>` で見せる。
- 切り替えの状態は `SettingsState` に足す：`prompt?: { role: Role; file?: string; source?: true }`（`source` が `true` のとき原文）。役やファイルを選び直したときは「整形」に戻す（今の `pick` が `{ role, file }` で置き換えるので、そのままで戻る）。
- 文言は `web/src/i18n.ts` に足す：
  - `viewRendered`：日本語「整形」、英語「Formatted」
  - `viewSource`：日本語「原文」、英語「Source」
- ボタンの並びには `aria-label`（日本語「表示のしかた」、英語「View」。キー名 `viewMode`）を付ける。

### 5. 変えないもの

- サーバー側（`src/settings.ts` の `loadPrompts`、`SettingsData`）は変えない。中身はそのまま文字で渡す。
- 指示ファイルは見るだけのまま（編集はできない）。

## 受け入れ条件

1. 指示ファイルのタブで、見出し（`# 受け入れテストの書き方`）は `<h1>`、箇条書きは `<ul><li>`、コードブロックは `<pre><code>`、表は `<table>` として描かれる。
2. 「整形」で見せているときも、本文の文字（例：「AC ごとに受け入れテストを書きます。」）は画面の文字として読める（既存の AC5 が通る）。
3. 中身に `<script>alert(1)</script>` や `<b>x</b>` があっても、タグとして描かれず文字として見える。
4. `[x](javascript:alert(1))` のリンクに `javascript:` の `href` が付かない。`https://` のリンクは `target="_blank"` と `rel="noopener noreferrer"` が付く。
5. 画像の記法があっても `<img>` は出ず、alt の文字が見える。
6. タスクリスト（`- [ ] a`・`- [x] b`）があっても `<input>` は出ず、`☐ a`・`☑ b` が見える。指示ファイルのタブに `input`・`select`・`textarea`・`contenteditable` が無い。
7. 「整形」「原文」のボタンがあり、既定は「整形」に `aria-pressed="true"`。`prompt.source` が `true` の状態では `<pre>` に Markdown の原文（`# ` などの記号を含む）がそのまま出る。
8. 英語表示では「Formatted」「Source」と出る。
9. lint・整形・型・テスト・ビルドが通る。

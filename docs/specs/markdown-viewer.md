# 管理画面：Markdown ファイルを読みやすく表示する

## 要件

> markdownファイルを表示している箇所は、markdown viewerを使用して読みやすくしたい

## 対象の箇所

管理画面で Markdown ファイルの中身を見せているのは、**設定画面の「指示ファイル」タブ**（`web/src/Settings.tsx` の `PromptsTab`）だけ。今は `.conductor/<役>/*.md` の中身を `<pre>` でそのまま（原文の文字として）出している。

これを Markdown として整形して表示する。

### 対象にしないもの

- タスク詳細の役の summary・止まった理由（`web/src/TaskDetail.tsx`）、ダッシュボードの文章（`web/src/Dashboard.tsx`）。これらは Markdown ファイルではなく、Markdown で書かれるとも決まっていないので、今までどおり文字で出す（方針「Markdown の表示」により判断）。
- 原文表示への切り替えボタン。要件は「読みやすくしたい」だけなので付けない。原文はリポジトリのファイルで見られる。

## 仕様

### 1. Markdown を表示する部品を作る

- 新しいファイル `web/src/Markdown.tsx` に `Markdown` 部品を作る。受け取るのは `{ text: string }`。
- `react-markdown` と `remark-gfm` で描く。2つを `package.json` の `devDependencies` にバージョン固定で足す（方針「Markdown の表示」により判断）。
- 表示できる書き方：見出し（h1〜h6）、段落、太字・斜体・取り消し線、箇条書き・番号付きリスト（入れ子も）、チェックボックス、引用、インラインコード、コードブロック、表、水平線、リンク、URL の自動リンク。
- 生の HTML は表示しない（`rehype-raw` を使わない・`dangerouslySetInnerHTML` を使わない）。`<script>` などのタグを含むファイルでも、スクリプトは動かない（方針「Markdown の表示」により判断）。
- リンクは `target="_blank"`・`rel="noopener noreferrer"` で開く（方針「Markdown の表示」により判断）。
- 見た目は方針「Markdown の表示」の 5 に従い、`var(--…)` の色の変数だけを使う。明るい表示・暗い表示のどちらでも読める。
- `renderToStaticMarkup` で同期に描ける（方針「Markdown の表示」により判断）。

### 2. 指示ファイルのタブで使う

- `PromptsTab` の `<pre style={PRE}>{file.text}</pre>` を、`<Markdown text={file.text} />` に置き換える。
- 外側の枠（角丸 8px・枠線 `var(--border)`・内側の余白 14px 16px）は今と同じにする。背景は本文を読みやすくするため `var(--panel)`（カードの地の色）にし、コードブロックだけ `var(--subtle)` にする。
- 使わなくなった `PRE` のスタイルは消す（他で使っていなければ）。
- 役の切り替え・ファイルの切り替え・「指示ファイルはありません」の表示・「見るだけ」の表示は今のまま変えない。

## 受け入れ条件

1. 指示ファイルのタブで、`# 見出し` を含むファイルを選ぶと、見出しが `<h1>` として描かれる（`#` の文字は出ない）。
2. `- 項目` は `<ul><li>`、`1. 項目` は `<ol><li>` として描かれる。
3. `` `code` `` は `<code>`、```` ``` ```` で囲んだ部分は `<pre><code>` として描かれる。
4. GFM の表（`| a | b |` と `|---|---|`）は `<table>` として描かれる。`- [ ] やること` はチェックボックスとして描かれる。
5. `[リンク](https://example.com)` は `href="https://example.com"`・`target="_blank"`・`rel="noopener noreferrer"` の `<a>` として描かれる。
6. ファイルに `<script>alert(1)</script>` が書かれていても、描いた HTML に `<script>` 要素は含まれない。`[x](javascript:alert(1))` のリンクの `href` に `javascript:` は含まれない。
7. 今の受け入れテスト（`src/acceptance/68-settings.test.ts`）の指示ファイルのタブの確かめ（ファイル名 `acceptance.md` と本文の文字が見える、保存などの操作が無い）はそのまま通る。
8. `npm run lint`・`npm run format:check`・`npm run typecheck`・`npm test`・`npm run build` が通る。

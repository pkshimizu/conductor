# 方針「Markdown の表示」

管理画面（`web/`）で Markdown の文章を見せるときの決まり。どの画面でも同じ見た目・同じ安全さにする。

## 決まり

1. **部品は1つにまとめる。** Markdown の表示は `web/src/Markdown.tsx` の `Markdown` 部品（`<Markdown text={...} />`）だけで行う。画面ごとに別の仕組みを作らない。
2. **ライブラリは `react-markdown` と `remark-gfm`。** GitHub と同じ書き方（表・チェックボックス・取り消し線・URL の自動リンク）を表示できるようにする。`package.json` の他の依存と同じく、バージョンは固定（`^` を付けない）で `devDependencies` に入れる（画面は vite で束ねるので、実行時の依存にはしない）。
3. **生の HTML は表示しない。** `rehype-raw` は使わず、`dangerouslySetInnerHTML` も使わない。Markdown 内の HTML タグは文字のまま出す（または捨てる。react-markdown の既定どおり）。リンクの URL は react-markdown の既定（`defaultUrlTransform`）で `javascript:` などを取り除く。
4. **リンクは別タブで開く。** `<a>` には `target="_blank"` と `rel="noopener noreferrer"` を付ける（管理画面から離れないようにする）。
5. **見た目は画面の色（`var(--…)`）に合わせる。** 文字色・枠線・背景は `palette.ts` の色の変数（`--border`・`--subtle`・`--muted`・`--accentText` など）を使い、明るい／暗い表示の両方で読めるようにする。色を直に書かない。
   - 見出しは画面の見出しより小さく（h1 でも 18px 程度まで）、段落・リストの行間は 1.7 程度。
   - コード（`code`・`pre`）は等幅（`MONO`）・背景 `var(--subtle)`。長い行は `pre` の中で横にスクロールする。
   - 表は枠線 `var(--border)`、はみ出すときは表の外側で横にスクロールする。
   - 長い URL や単語で画面がはみ出さないよう、`overflowWrap: "anywhere"` を付ける。
6. **サーバーでも描ける形にする。** テストは `react-dom/server` の `renderToStaticMarkup` で画面を描いて確かめるので、`Markdown` 部品は同期で描ける（`useEffect` で後から描かない）こと。
7. **Markdown の文章にだけ使う。** 役の summary・止まった理由のような、Markdown と決まっていない文章には使わない（今までどおり `whiteSpace: "pre-line"` の文字で出す）。

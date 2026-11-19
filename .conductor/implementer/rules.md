## 技術の前提

- TypeScript（Node 22、ESM、NodeNext）。import は `.js` 拡張子を付ける。
- `tsconfig.json` は strict・`noUncheckedIndexedAccess`・`exactOptionalPropertyTypes` が有効。`any` や `as` での型のごまかしで通さない。
- 設定は `src/config.ts` の zod の定義に足す。設定の誤りは `conductor check` で項目名つきで示せるようにする。
- 進み具合の記録は `src/store.ts` の型（`MemoryStore` と `sqlite-store.ts`）に足す。既存の SQLite のファイルを壊さずに表や列を足せるようにする。

## 書き方

- 外部（Discord・GitHub・claude・SQLite）に触る部品はインターフェースで受け取り、テストでは差し替えられるようにする（`CLAUDE.md` の決まり）。
- Discord との通信は Node の `fetch` で REST API を呼ぶ。依存パッケージは増やさない。どうしても必要なときは、その理由を結果に書く。
- トークンなどの秘密の値は環境変数から読む。ログや Issue・PR・チャットへの書き込みに出さない。
- 変えた部分には Vitest の単体テストを足す。テストは対象のファイルの隣に `*.test.ts` で置く。
- `src/acceptance/` はテスト役のもの。変えてはいけない。受け入れテストが使う名前・型・置き場所に合わせて作る。
- Issue の「対象外」に書かれたことはしない。
- 使い方が変わったら README を更新する。

## 終える前に

- `npm run format` で整形し、`npm run lint`・`npm run typecheck`・`npm test`・`npm run build` が通ることを確かめる（CI で点検される）。

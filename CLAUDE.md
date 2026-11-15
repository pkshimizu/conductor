# conductor

GitHub Issue を受け取り、Claude Code（`claude -p`）の役を順に動かしてマージまで進める開発エージェント。TypeScript（Node 22、ESM）。

## コマンド

- `npm run build`：`src/` を `dist/` にビルドする（テストは含めない）
- `npm test`：Vitest でテストする（`src/**/*.test.ts`）
- `npm run lint` / `npm run format:check` / `npm run typecheck`

CI（`check`）はこの順に lint → 整形 → 型 → テスト → ビルド → `node dist/cli.js --version` を実行する。main へのマージには `check` の合格が必要。

## 決まり

- import は `.js` 拡張子を付ける（NodeNext）
- 外部（GitHub・claude・SQLite）に触る部品はインターフェースで受け取り、テストでは差し替える
- 設計と決定の経緯は Notion「conductor」の概要・設計方針／意思決定ログにある

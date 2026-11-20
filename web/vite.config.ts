/**
 * 管理画面のビルド。web/ を root にして dist/admin に出す（conductor に同梱して配信する）
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const outDir = fileURLToPath(new URL("../dist/admin", import.meta.url));

export default defineConfig({
  root,
  oxc: { jsx: { runtime: "automatic" } },
  build: {
    outDir,
    emptyOutDir: true,
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  // 画面（web/src の .tsx）をテストから import できるよう、JSX を React の形に変える
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    include: ["src/**/*.test.ts", "web/src/**/*.test.ts"],
  },
});

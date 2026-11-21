import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SettingsData } from "../../src/settings-data.js";
import { Settings } from "./Settings.js";
import { initSettings, type SettingsState } from "./settings-state.js";

const BASE: SettingsData = {
  repo: "o/n",
  project: 1,
  token: "unset",
  form: {
    github: {
      notify: "someone",
      columns: {
        ready: "Ready",
        testing: "Testing",
        implementing: "Implementing",
        reviewing: "Reviewing",
        done: "Done",
        blocked: "Blocked",
      },
    },
    limits: { rejections: "3", objections: "2", reviewers: "3" },
    merge: { approval: "human" },
    poll_interval: "90",
    language: "日本語",
    screenshots: "",
    commands: {
      setup: "npm ci",
      test: "npm test",
      acceptance: "npm run acceptance",
      typecheck: "npm run typecheck",
      build: "npm run build",
      format: "",
    },
    protected: [],
    roles: {
      tester: { allow: [] },
      implementer: { allow: [] },
      reviewer: { allow: [] },
      specifier: { allow: [] },
      decomposer: { allow: [] },
    },
    chat: {
      enabled: false,
      channels: { requirements: "", questions: "", notices: "" },
      allowed_users: [],
    },
  },
  prompts: {
    tester: [{ name: "a.md", text: "# 見出し\n\n本文\n" }],
    implementer: [],
    reviewer: [],
    specifier: [],
    decomposer: [],
  },
};

function render(prompt?: SettingsState["prompt"]): string {
  const state: SettingsState = { ...initSettings(BASE), tab: "prompts" };
  if (prompt !== undefined) state.prompt = prompt;
  return renderToStaticMarkup(
    createElement(Settings, { data: BASE, state, lang: "ja" }),
  );
}

describe("Settings の指示ファイルのタブ", () => {
  it("既定では整形して見せ、「整形」が押された状態", () => {
    const html = render();
    expect(html).toMatch(/<h1 [^>]*>見出し<\/h1>/);
    expect(html).toMatch(/aria-pressed="true"[^>]*>整形<\/button>/);
    expect(html).toMatch(/aria-pressed="false"[^>]*>原文<\/button>/);
  });

  it("source が true なら原文をそのまま見せる", () => {
    const html = render({ role: "tester", file: "a.md", source: true });
    expect(html).toContain("# 見出し");
    expect(html).not.toMatch(/<h1 [^>]*>見出し<\/h1>/);
    expect(html).toMatch(/aria-pressed="true"[^>]*>原文<\/button>/);
  });

  it("指示ファイルが無い役では表示のしかたのボタンを出さない", () => {
    const html = render({ role: "implementer" });
    expect(html).not.toContain('aria-label="表示のしかた"');
  });
});

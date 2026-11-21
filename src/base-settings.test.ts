import { describe, expect, it } from "vitest";
import { loadBaseSettings } from "./base-settings.js";
import type { Exec } from "./exec.js";
import { Git } from "./git.js";

const SOURCE = [
  "github:",
  "  repo: o/n",
  "  project: 2",
  "  notify: other",
  "protected:",
  '  - "src/acceptance/**"',
  "commands:",
  "  setup: npm ci",
  "  test: npm test",
  "  acceptance: npm run acceptance",
  "  typecheck: npm run typecheck",
  "  build: npm run build",
  "roles:",
  "  implementer:",
  '    allow: ["Bash(ls *)"]',
  "",
].join("\n");

describe("loadBaseSettings", () => {
  it("origin の base を取り込み、その config.yaml をフォームの値にする", async () => {
    const calls: string[][] = [];
    const exec: Exec = (args) => {
      calls.push(args);
      return Promise.resolve({
        code: 0,
        stdout: args[0] === "show" ? SOURCE : "",
        stderr: "",
      });
    };
    const form = await loadBaseSettings({
      repoDir: "/repo",
      base: "develop",
      git: new Git("/repo", exec),
    });
    expect(form.github.notify).toBe("other");
    expect(form.roles.implementer.allow).toContain("Bash(ls *)");
    expect(calls).toEqual([
      ["fetch", "-q", "origin", "develop"],
      ["show", "origin/develop:.conductor/config.yaml"],
    ]);
  });
});

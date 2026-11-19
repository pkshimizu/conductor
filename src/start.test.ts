import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type ClaudeDeps, commonOutputSchema, type Exec } from "./claude.js";
import { roleRunner } from "./start.js";

describe("roleRunner", () => {
  it("どの役にも、設定した言語の指示を足す", async () => {
    const prompts: string[] = [];
    const exec: Exec = (args) => {
      const file = args[args.indexOf("--append-system-prompt-file") + 1]!;
      prompts.push(readFileSync(file, "utf8"));
      const structured_output = {
        verdict: "approve",
        summary: "",
        findings: [],
      };
      return Promise.resolve({
        code: 0,
        stdout: JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          permission_denials: [],
          structured_output,
        }),
        stderr: "",
      });
    };
    const claude: ClaudeDeps = {
      exec,
      now: () => new Date(),
      sleep: () => Promise.resolve(),
      onLimit: () => {},
    };
    const run = roleRunner({ language: "English" }, claude);
    for (const role of ["tester", "implementer", "reviewer"]) {
      await run({
        role,
        cwd: "/repo",
        systemPrompt: `あなたは${role}です`,
        prompt: "依頼",
        schema: commonOutputSchema,
        allow: [],
      });
    }
    expect(prompts).toHaveLength(3);
    for (const p of prompts) expect(p).toContain("すべてEnglishで書きます");
  });
});

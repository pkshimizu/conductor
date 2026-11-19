import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type ClaudeDeps, commonOutputSchema, type Exec } from "./claude.js";
import { DISCORD_TOKEN_ENV } from "./config.js";
import { DiscordChat } from "./discord.js";
import { chatFromConfig, roleRunner } from "./start.js";

describe("chatFromConfig", () => {
  const chat = {
    type: "discord" as const,
    channels: { requirements: "1", questions: "2", notices: "3" },
    allowed_users: ["u1"],
  };

  it("config.chat が無ければ窓口を作らない", () => {
    expect(chatFromConfig({}, {})).toBeUndefined();
  });

  it("config.chat があれば、環境変数のトークンで Discord の窓口を作る", () => {
    const env = { [DISCORD_TOKEN_ENV]: "secret" };
    expect(chatFromConfig({ chat }, env)).toBeInstanceOf(DiscordChat);
  });

  it("トークンが無ければ環境変数の名前を示して失敗する", () => {
    expect(() => chatFromConfig({ chat }, {})).toThrow(DISCORD_TOKEN_ENV);
  });
});

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

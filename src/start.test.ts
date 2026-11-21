import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type ClaudeDeps, commonOutputSchema, type Exec } from "./claude.js";
import { DISCORD_TOKEN_ENV, parseConfig } from "./config.js";
import type { DashboardData } from "./dashboard.js";
import { DiscordChat } from "./discord.js";
import type { LoopIssue } from "./loop.js";
import { chatFromConfig, dashboardRefresher, roleRunner } from "./start.js";
import { MemoryStore } from "./store.js";

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

describe("dashboardRefresher", () => {
  const config = parseConfig(
    [
      "github: { repo: me/app, project: 3, notify: me }",
      "protected: [e2e/**]",
      "commands: { setup: s, test: t, acceptance: a, typecheck: y, build: b }",
    ].join("\n"),
  );

  it("読み直しを重ねず、途中で変わったら最後の状態でもう1回だけ読み直す", async () => {
    let reads = 0;
    let release: () => void = () => {};
    const board = {
      issuesByColumn: async () => {
        reads++;
        if (reads === 1) await new Promise<void>((r) => (release = r));
        return new Map<string, LoopIssue[]>();
      },
    };
    const published: DashboardData[] = [];
    const refresher = dashboardRefresher(
      { config, store: new MemoryStore(), board },
      (data) => published.push(data),
      () => {},
    );
    refresher.update({ status: "running" });
    refresher.update({ activity: { lastCheckedAt: "2026-11-21T00:00:00Z" } });
    refresher.update({ status: "idle" });
    release();
    await refresher.idle();
    expect(reads).toBe(2);
    expect(published.map((d) => d.status)).toEqual(["running", "idle"]);
    expect(published.at(-1)?.lastCheckedAt).toBe("2026-11-21T00:00:00Z");
  });

  it("読めなくても止まらず、書き残す", async () => {
    const logs: string[] = [];
    const refresher = dashboardRefresher(
      {
        config,
        store: new MemoryStore(),
        board: { issuesByColumn: () => Promise.reject(new Error("落ちた")) },
      },
      () => {},
      (text) => logs.push(text),
    );
    refresher.update({ status: "running" });
    await refresher.idle();
    expect(logs).toEqual(["ダッシュボードの内容を読めませんでした: 落ちた"]);
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

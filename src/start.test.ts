import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type ClaudeDeps, commonOutputSchema, type Exec } from "./claude.js";
import { DISCORD_TOKEN_ENV, parseConfig } from "./config.js";
import type { DashboardData } from "./dashboard.js";
import { DiscordChat } from "./discord.js";
import type { LoopIssue } from "./loop.js";
import {
  chatFromConfig,
  dashboardRefresher,
  roleRunner,
  snapshotBoard,
  tasksBoard,
  tasksRefresher,
} from "./start.js";
import { MemoryStore } from "./store.js";
import type { TaskDetailData } from "./task-detail.js";
import type { TaskIssue, TasksData } from "./tasks.js";

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

describe("tasksRefresher", () => {
  const config = parseConfig(
    [
      "github: { repo: me/app, project: 3, notify: me }",
      "protected: [e2e/**]",
      "commands: { setup: s, test: t, acceptance: a, typecheck: y, build: b }",
    ].join("\n"),
  );

  it("読み直しを重ねず、途中で頼まれたらもう1回だけ読み直す", async () => {
    let reads = 0;
    let release: () => void = () => {};
    const board = {
      issuesByColumn: async () => {
        reads++;
        if (reads === 1) await new Promise<void>((r) => (release = r));
        return new Map<string, TaskIssue[]>([
          ["Ready", [{ number: reads, title: "t", body: "" }]],
        ]);
      },
      isMerged: () => Promise.resolve(false),
    };
    const published: TasksData[] = [];
    const refresher = tasksRefresher(
      { config, store: new MemoryStore(), board },
      { tasks: (data) => published.push(data), details: () => {} },
      () => {},
    );
    refresher.update();
    refresher.update();
    refresher.update();
    release();
    await refresher.idle();
    expect(reads).toBe(2);
    expect(published.map((d) => d.issues[0]?.number)).toEqual([1, 2]);
  });

  it("1回の読み直しで、Issue の一覧と PR のマージ済みかは1度ずつだけ問い合わせ、詳細は全件を1度だけ知らせる。作業中の役も入れる", async () => {
    const store = new MemoryStore();
    await store.update({ repo: "me/app", issue: 1 }, { pr: 10 });
    await store.update({ repo: "me/app", issue: 3 }, { pr: 30 });
    let reads = 0;
    const asked: number[] = [];
    const board = {
      issuesByColumn: () => {
        reads++;
        return Promise.resolve(
          new Map<string, TaskIssue[]>([
            ["Ready", [{ number: 3, title: "c", body: "" }]],
            ["Implementing", [{ number: 1, title: "a", body: "" }]],
          ]),
        );
      },
      isMerged: (pr: number) => {
        asked.push(pr);
        return Promise.resolve(pr === 30);
      },
    };
    const tasks: TasksData[] = [];
    const details: TaskDetailData[][] = [];
    const refresher = tasksRefresher(
      { config, store, board },
      {
        tasks: (data) => tasks.push(data),
        details: (list) => details.push(list),
      },
      () => {},
    );
    refresher.update({
      activity: { running: { issue: 1, role: "implementer" } },
    });
    await refresher.idle();
    expect(reads).toBe(1);
    expect(asked.sort((a, b) => a - b)).toEqual([10, 30]);
    expect(tasks).toHaveLength(1);
    expect(details).toHaveLength(1);
    expect(
      details[0]?.map((d) => [d.number, d.title, d.working, d.merged]),
    ).toEqual([
      [1, "a", "implementer", undefined],
      [3, "c", undefined, true],
    ]);
  });

  it("読めなくても止まらず、書き残す", async () => {
    const logs: string[] = [];
    const refresher = tasksRefresher(
      {
        config,
        store: new MemoryStore(),
        board: {
          issuesByColumn: () => Promise.reject(new Error("落ちた")),
          isMerged: () => Promise.resolve(false),
        },
      },
      { tasks: () => {}, details: () => {} },
      (text) => logs.push(text),
    );
    refresher.update();
    await refresher.idle();
    expect(logs).toEqual([
      "タスク一覧の内容を読めませんでした: 落ちた",
      "タスク詳細の内容を読めませんでした: 落ちた",
    ]);
  });
});

describe("snapshotBoard", () => {
  it("Issue の一覧と PR ごとのマージ済みかを、それぞれ1度だけ問い合わせる", async () => {
    let reads = 0;
    const asked: number[] = [];
    const board = snapshotBoard({
      issuesByColumn: () => {
        reads++;
        return Promise.resolve(new Map());
      },
      isMerged: (pr) => {
        asked.push(pr);
        return Promise.resolve(false);
      },
    });
    await Promise.all([board.issuesByColumn(), board.issuesByColumn()]);
    expect(await board.isMerged(6)).toBe(false);
    expect(await board.isMerged(6)).toBe(false);
    expect(reads).toBe(1);
    expect(asked).toEqual([6]);
  });
});

describe("tasksBoard", () => {
  it("閉じた Issue も含めて取り、マージ済みとわかった PR は再び確かめない", async () => {
    const options: unknown[] = [];
    const asked: number[] = [];
    const board = tasksBoard({
      issuesByColumn: (o) => {
        options.push(o);
        return Promise.resolve(new Map());
      },
      isMerged: (pr) => {
        asked.push(pr);
        return Promise.resolve(pr === 5);
      },
    });
    await board.issuesByColumn();
    expect(options).toEqual([{ includeClosed: true }]);
    expect(await board.isMerged(5)).toBe(true);
    expect(await board.isMerged(5)).toBe(true);
    expect(await board.isMerged(6)).toBe(false);
    expect(await board.isMerged(6)).toBe(false);
    expect(asked).toEqual([5, 6, 6]);
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

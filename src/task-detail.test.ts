import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";
import { MemoryStore } from "./store.js";
import { loadTaskDetail, resultOf } from "./task-detail.js";
import type { TaskIssue, TasksBoard } from "./tasks.js";

const config = parseConfig(
  [
    "github: { repo: me/app, project: 3, notify: me }",
    "protected: [e2e/**]",
    "commands: { setup: s, test: t, acceptance: a, typecheck: y, build: b }",
    "limits: { rejections: 3, objections: 2 }",
  ].join("\n"),
);
const REPO = "me/app";
const clock = () => new Date("2026-11-20T00:00:00.000Z");

function board(
  columns: Record<string, TaskIssue[]>,
  merged: number[] = [],
): TasksBoard {
  return {
    issuesByColumn: () => Promise.resolve(new Map(Object.entries(columns))),
    isMerged: (pr) => Promise.resolve(merged.includes(pr)),
  };
}

const issue = (number: number, title = "t"): TaskIssue => ({
  number,
  title,
  body: "",
});

describe("resultOf", () => {
  it("記録の verdict を役の結果にする。知らなければ undefined", () => {
    expect(resultOf("approve")).toBe("approved");
    expect(resultOf("reject")).toBe("changes");
    expect(resultOf("objection")).toBe("objection");
    expect(resultOf("done")).toBe("done");
    expect(resultOf("failed")).toBe("failed");
    expect(resultOf("passed")).toBe("passed");
    expect(resultOf("toString")).toBeUndefined();
    expect(resultOf("maybe")).toBeUndefined();
  });
});

describe("loadTaskDetail", () => {
  it("記録の無い Issue は回数 0、段階・ブランチ・PR なし", async () => {
    const data = await loadTaskDetail(
      {
        config,
        store: new MemoryStore(clock),
        board: board({ Ready: [issue(5, "五")] }),
        activity: {},
      },
      5,
    );
    expect(data).toEqual({
      number: 5,
      title: "五",
      column: "Ready",
      repo: REPO,
      columns: [
        "Ready",
        "Testing",
        "Implementing",
        "Reviewing",
        "Done",
        "Blocked",
      ],
      rejections: 0,
      objections: 0,
      limits: { rejections: 3, objections: 2 },
      timeline: [],
    });
  });

  it("処理中の列なら段階を入れ、PR がマージ済みかを確かめ、経過は記録した順", async () => {
    const store = new MemoryStore(clock);
    const key = { repo: REPO, issue: 7 };
    await store.update(key, {
      branch: "b",
      pr: 9,
      checkpoint: { stage: "ci" },
    });
    await store.addSummary(key, { role: "ci", verdict: "failed", text: "x" });
    await store.addSummary(key, { role: "human", verdict: "odd", text: "y" });
    const data = await loadTaskDetail(
      {
        config,
        store,
        board: board({ Reviewing: [issue(7)] }, [9]),
        activity: { running: { issue: 7, role: "ci" } },
      },
      7,
    );
    expect(data.stage).toBe("ci");
    expect(data.stageStartedAt).toBe(clock().toISOString());
    expect(data.branch).toBe("b");
    expect(data.pr).toBe(9);
    expect(data.merged).toBe(true);
    expect(data.working).toBe("ci");
    expect(data.blocked).toBeUndefined();
    expect(data.timeline).toEqual([
      {
        role: "ci",
        verdict: "failed",
        result: "failed",
        text: "x",
        at: clock().toISOString(),
      },
      { role: "human", verdict: "odd", text: "y", at: clock().toISOString() },
    ]);
  });

  it("記録の段階が無くても、処理中の列から段階を決める", async () => {
    const data = await loadTaskDetail(
      {
        config,
        store: new MemoryStore(clock),
        board: board({ Implementing: [issue(2)] }),
        activity: {},
      },
      2,
    );
    expect(data.stage).toBe("implementing");
  });

  it("Blocked なら止まった段階・理由・日時を入れる。理由の記録が無ければスレッドの記録を見る", async () => {
    const store = new MemoryStore(clock);
    await store.update(
      { repo: REPO, issue: 4 },
      { checkpoint: { stage: "reviewing" } },
    );
    await store.setBlockedThread(
      { repo: REPO, issue: 4 },
      { reason: "古い理由" },
    );
    const data = await loadTaskDetail(
      {
        config,
        store,
        board: board({ Blocked: [issue(4)] }),
        activity: { running: { issue: 8, role: "tester" } },
      },
      4,
    );
    expect(data.blocked).toBe(true);
    expect(data.stage).toBe("reviewing");
    expect(data.blockedReason).toBe("古い理由");
    expect(data.working).toBeUndefined();
  });

  it("Project に無い Issue はタイトルと列を空にする", async () => {
    const data = await loadTaskDetail(
      {
        config,
        store: new MemoryStore(clock),
        board: board({}),
        activity: {},
      },
      99,
    );
    expect(data.title).toBe("");
    expect(data.column).toBe("");
    expect(data.stage).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";
import { MemoryStore } from "./store.js";
import { laterOf, loadTasks, type TaskIssue } from "./tasks.js";

const config = parseConfig(
  [
    "github: { repo: me/app, project: 3, notify: me }",
    "protected: [e2e/**]",
    "commands: { setup: s, test: t, acceptance: a, typecheck: y, build: b }",
    "limits: { rejections: 3, objections: 2 }",
  ].join("\n"),
);

function board(columns: Record<string, TaskIssue[]>, merged: number[] = []) {
  const asked: number[] = [];
  return {
    asked,
    issuesByColumn: () => Promise.resolve(new Map(Object.entries(columns))),
    isMerged: (pr: number) => {
      asked.push(pr);
      return Promise.resolve(merged.includes(pr));
    },
  };
}

describe("laterOf", () => {
  it("新しいほうを返す。読めないものは使わない", () => {
    const a = "2026-11-20T00:00:00.000Z";
    const b = "2026-11-20T01:00:00.000Z";
    expect(laterOf(a, b)).toBe(b);
    expect(laterOf(b, a)).toBe(b);
    expect(laterOf(undefined, a)).toBe(a);
    expect(laterOf(a, "壊れた")).toBe(a);
    expect(laterOf(undefined, undefined)).toBeUndefined();
  });
});

describe("loadTasks", () => {
  it("列は board から、回数・段階・PR は記録から読み、番号の順に並べる", async () => {
    const clock = () => new Date("2026-11-20T03:00:00.000Z");
    const store = new MemoryStore(clock);
    await store.update(
      { repo: "me/app", issue: 7 },
      { rejections: 1, objections: 2, pr: 9, checkpoint: { stage: "ci" } },
    );
    // 別のリポジトリの記録は使わない
    await store.update({ repo: "me/other", issue: 3 }, { rejections: 2 });
    const b = board(
      {
        Ready: [
          {
            number: 3,
            title: "三",
            body: "",
            updatedAt: "2026-11-19T00:00:00.000Z",
          },
        ],
        Implementing: [
          {
            number: 7,
            title: "七",
            body: "",
            updatedAt: "2026-11-20T01:00:00.000Z",
          },
        ],
        "": [{ number: 5, title: "列なし", body: "" }],
      },
      [9],
    );
    const data = await loadTasks({ config, store, board: b });
    expect(data.repo).toBe("me/app");
    expect(data.columns).toEqual([
      "Ready",
      "Testing",
      "Implementing",
      "Reviewing",
      "Done",
      "Blocked",
    ]);
    expect(data.doneColumn).toBe("Done");
    expect(data.limits).toEqual({ rejections: 3, objections: 2 });
    expect(data.issues).toEqual([
      {
        number: 3,
        title: "三",
        column: "Ready",
        rejections: 0,
        objections: 0,
        updatedAt: "2026-11-19T00:00:00.000Z",
      },
      { number: 5, title: "列なし", column: "", rejections: 0, objections: 0 },
      {
        number: 7,
        title: "七",
        column: "Implementing",
        stage: "ci",
        rejections: 1,
        objections: 2,
        pr: 9,
        merged: true,
        updatedAt: "2026-11-20T03:00:00.000Z",
      },
    ]);
    // PR のある Issue だけ確かめる
    expect(b.asked).toEqual([9]);
  });
});

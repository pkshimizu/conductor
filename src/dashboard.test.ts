import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";
import { loadDashboard } from "./dashboard.js";
import type { LoopIssue } from "./loop.js";
import { MemoryStore } from "./store.js";

const REPO = "me/app";
const config = parseConfig(
  [
    `github: { repo: ${REPO}, project: 3, notify: me }`,
    "protected: [e2e/**]",
    "commands: { setup: s, test: t, acceptance: a, typecheck: y, build: b }",
    "merge: { approval: auto }",
    "poll_interval: 45",
  ].join("\n"),
);
const issue = (number: number): LoopIssue => ({
  number,
  title: `Issue ${number}`,
  body: "",
});
const boardOf = (columns: Record<string, number[]>) => ({
  issuesByColumn: () =>
    Promise.resolve(
      new Map(Object.entries(columns).map(([c, ns]) => [c, ns.map(issue)])),
    ),
});
const clock = () => new Date("2026-11-21T00:00:00.000Z");

describe("loadDashboard", () => {
  it("承認待ちの Issue を飛ばし、番号のいちばん小さい作業中の Issue を処理中とする", async () => {
    const store = new MemoryStore(clock);
    await store.update(
      { repo: REPO, issue: 3 },
      { checkpoint: { stage: "approving" } },
    );
    await store.update(
      { repo: REPO, issue: 7 },
      { branch: "b7", pr: 70, rejections: 2, checkpoint: { stage: "ci" } },
    );
    const data = await loadDashboard({
      config,
      store,
      board: boardOf({ Reviewing: [3, 7], Testing: [9] }),
      status: "running",
      activity: {
        lastCheckedAt: "2026-11-21T00:00:00.000Z",
        running: { issue: 7, role: "ci" },
      },
    });
    expect(data.active).toEqual({
      number: 7,
      title: "Issue 7",
      branch: "b7",
      pr: 70,
      stage: "ci",
      stageStartedAt: "2026-11-21T00:00:00.000Z",
      role: "ci",
      rejections: 2,
      objections: 0,
    });
    expect(data.pollInterval).toBe(45);
    expect(data.merge).toBe("auto");
    expect(data.lastCheckedAt).toBe("2026-11-21T00:00:00.000Z");
    expect(data).not.toHaveProperty("nextCheckAt");
  });

  it("記録が無ければ列から段階を決め、別の Issue の役は出さない", async () => {
    const data = await loadDashboard({
      config,
      store: new MemoryStore(clock),
      board: boardOf({ Implementing: [5] }),
      status: "idle",
      activity: { running: { issue: 6, role: "tester" } },
    });
    expect(data.active).toEqual({
      number: 5,
      title: "Issue 5",
      stage: "implementing",
      rejections: 0,
      objections: 0,
    });
  });

  it("Blocked の Issue は番号の順に、理由（無ければスレッドの記録）・日時・段階を出す", async () => {
    const store = new MemoryStore(clock);
    await store.update(
      { repo: REPO, issue: 8 },
      { checkpoint: { stage: "testing" }, blockedReason: "曖昧" },
    );
    await store.setBlockedThread({ repo: REPO, issue: 4 }, { reason: "古い" });
    const data = await loadDashboard({
      config,
      store,
      board: boardOf({ Blocked: [8, 4, 2] }),
      status: "idle",
      activity: {},
    });
    expect(data.blocked).toEqual([
      { number: 2, title: "Issue 2" },
      { number: 4, title: "Issue 4", reason: "古い" },
      {
        number: 8,
        title: "Issue 8",
        reason: "曖昧",
        blockedAt: "2026-11-21T00:00:00.000Z",
        stage: "testing",
      },
    ]);
    expect(data.active).toBeUndefined();
    expect(data.counts).toEqual([
      { column: "Ready", count: 0 },
      { column: "Testing", count: 0 },
      { column: "Implementing", count: 0 },
      { column: "Reviewing", count: 0 },
      { column: "Done", count: 0 },
      { column: "Blocked", count: 3 },
    ]);
  });
});

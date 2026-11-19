import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";
import { recordRejection } from "./rejection.js";
import { MemoryStore } from "./store.js";

const KEY = { repo: "me/app", issue: 7 };

function setup(options: { chat?: boolean } = {}) {
  const lines = [
    "github: { repo: me/app, project: 3, notify: me }",
    "protected: [e2e/**]",
    "commands: { setup: s, test: t, acceptance: a, typecheck: y, build: b }",
    "limits: { rejections: 1 }",
  ];
  if (options.chat === true) {
    lines.push(
      "chat:",
      "  type: discord",
      '  channels: { requirements: "100", questions: "200", notices: "300" }',
      '  allowed_users: ["u1"]',
    );
  }
  const store = new MemoryStore();
  const moves: [number, string][] = [];
  const comments: { issue: number; body: string; mention?: boolean }[] = [];
  const deps = {
    config: parseConfig(lines.join("\n")),
    store,
    board: {
      moveIssue: (n: number, column: string) => {
        moves.push([n, column]);
        return Promise.resolve();
      },
      comment: (n: number, body: string, o?: { mention?: boolean }) => {
        comments.push({ issue: n, body, ...o });
        return Promise.resolve();
      },
    },
  };
  return { deps, store, moves, comments };
}

describe("recordRejection", () => {
  it("上限までは実装役の列に戻し、記録は作らない", async () => {
    const t = setup({ chat: true });
    const r = await recordRejection(t.deps, 7, "ci", "CI", ["型が合わない"]);
    expect(r).toEqual({ rejections: 1, blocked: false });
    expect(t.moves).toEqual([[7, "Implementing"]]);
    expect(await t.store.getBlockedThread(KEY)).toBeUndefined();
  });

  it("上限を超えたら、窓口が無ければ Issue でメンションする", async () => {
    const t = setup();
    await recordRejection(t.deps, 7, "ci", "CI", ["型が合わない"]);
    const r = await recordRejection(t.deps, 7, "ci", "CI", ["まだ合わない"]);
    expect(r.blocked).toBe(true);
    expect(t.moves.at(-1)).toEqual([7, "Blocked"]);
    expect(t.comments.at(-1)?.mention).toBe(true);
    expect(await t.store.getBlockedThread(KEY)).toBeUndefined();
  });

  it("上限を超えたら、窓口があればメンションせずに最後の指摘を理由として記録する", async () => {
    const t = setup({ chat: true });
    await recordRejection(t.deps, 7, "ci", "CI", ["型が合わない"]);
    const r = await recordRejection(t.deps, 7, "ci", "CI", ["まだ合わない"]);
    expect(r.blocked).toBe(true);
    expect(t.moves.at(-1)).toEqual([7, "Blocked"]);
    expect(t.comments.at(-1)?.mention).toBeUndefined();
    expect(t.comments.at(-1)?.body).toContain("スレッド");
    const record = await t.store.getBlockedThread(KEY);
    expect(record?.reason).toContain("まだ合わない");
  });
});

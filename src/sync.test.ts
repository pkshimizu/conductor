import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";
import { pendingFindings } from "./rejection.js";
import { MemoryStore } from "./store.js";
import {
  conflictFinding,
  protectedConflictFinding,
  syncMain,
  type SyncDeps,
} from "./sync.js";

const REPO = "me/app";
const KEY = { repo: REPO, issue: 4 };

const config = parseConfig(
  [
    "github: { repo: me/app, project: 3, notify: me }",
    "protected: [e2e/**, supabase/seed.sql]",
    "commands: { setup: a, test: b, acceptance: c, typecheck: d, build: e }",
  ].join("\n"),
);

function setup(conflicts: string[]) {
  const log: string[] = [];
  const moves: [number, string][] = [];
  const comments: string[] = [];
  const store = new MemoryStore();
  const deps: SyncDeps = {
    config,
    store,
    board: {
      moveIssue: (issue, column) => {
        moves.push([issue, column]);
        return Promise.resolve();
      },
      comment: (_issue, body) => {
        comments.push(body);
        return Promise.resolve();
      },
    },
    git: {
      mergeBase: (branch) => {
        log.push(`mergeBase ${branch}`);
        return Promise.resolve(conflicts);
      },
      abortMerge: () => {
        log.push("abort");
        return Promise.resolve();
      },
      commitMerge: () => {
        log.push("commitMerge");
        return Promise.resolve("abc");
      },
      push: (branch) => {
        log.push(`push ${branch}`);
        return Promise.resolve();
      },
      treeHash: () => Promise.resolve("newhash"),
    },
  };
  return { deps, store, log, moves, comments };
}

describe("syncMain", () => {
  it("衝突が無ければ push して CI からやり直す", async () => {
    const t = setup([]);
    await t.store.update(KEY, {
      branch: "conductor/issue-4",
      protectedHash: "old",
      checkpoint: { stage: "reviewing" },
    });
    expect(await syncMain(t.deps, 4, 12)).toEqual({ status: "synced" });
    expect(t.log).toEqual([
      "mergeBase conductor/issue-4",
      "push conductor/issue-4",
    ]);
    const record = await t.store.get(KEY);
    expect(record?.checkpoint?.stage).toBe("ci");
    expect(record?.protectedHash).toBe("newhash");
    expect(t.moves).toEqual([]);
  });

  it("保護対象の外が衝突したら、しるしごとコミットして実装役に回す", async () => {
    const t = setup(["src/app.ts"]);
    expect(await syncMain(t.deps, 4, 12)).toEqual({
      status: "conflict",
      files: ["src/app.ts"],
    });
    expect(t.log).toEqual([
      "mergeBase conductor/issue-4",
      "commitMerge",
      "push conductor/issue-4",
    ]);
    const record = await t.store.get(KEY);
    expect(record?.checkpoint).toEqual({
      stage: "implementing",
      reason: "conflict",
    });
    expect(record?.protectedHash).toBe("newhash");
    expect(record?.rejections ?? 0).toBe(0);
    expect(t.moves).toEqual([[4, "Implementing"]]);
    expect(await pendingFindings(t.store, KEY)).toEqual([
      conflictFinding(12, ["src/app.ts"]),
    ]);
  });

  it("保護ファイルが衝突したら、マージをやめてテスト役に回す", async () => {
    const t = setup(["src/app.ts", "supabase/seed.sql"]);
    expect(await syncMain(t.deps, 4, 12)).toEqual({
      status: "protected-conflict",
      files: ["supabase/seed.sql"],
    });
    expect(t.log).toEqual(["mergeBase conductor/issue-4", "abort"]);
    const record = await t.store.get(KEY);
    expect(record?.checkpoint).toEqual({
      stage: "testing",
      reason: "conflict",
    });
    expect(record?.rejections ?? 0).toBe(0);
    expect(t.moves).toEqual([[4, "Testing"]]);
    expect(t.comments[0]).toContain(
      protectedConflictFinding(12, ["supabase/seed.sql"]),
    );
  });
});

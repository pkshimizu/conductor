import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryChat } from "./chat.js";
import { parseConfig } from "./config.js";
import {
  MAX_FAILURES,
  runLoop,
  newLoopState,
  tick,
  type LoopDeps,
  type LoopIssue,
  type StepResult,
} from "./loop.js";
import { storeFile } from "./start.js";
import { MemoryStore, type Stage } from "./store.js";

const REPO = "me/app";
const issue = (number: number): LoopIssue => ({
  number,
  title: `Issue ${number}`,
  body: "本文",
});

function setup(
  columns: Record<string, number[]>,
  options: { conflict?: boolean; pickUp?: boolean } = {},
) {
  const config = parseConfig(
    [
      `github: { repo: ${REPO}, project: 3, notify: me }`,
      "protected: [e2e/**]",
      "commands: { setup: s, test: t, acceptance: a, typecheck: y, build: b }",
    ].join("\n"),
  );
  const store = new MemoryStore(() => new Date("2026-11-15T00:00:00.000Z"));
  const board = new Map(
    Object.entries(columns).map(([c, ns]) => [c, ns.map(issue)]),
  );
  const calls: string[] = [];
  const moves: [number, string][] = [];
  const comments: { issue: number; body: string; mention?: boolean }[] = [];
  const logs: string[] = [];
  const results: Partial<Record<string, () => Promise<StepResult>>> = {};
  const step =
    (name: string) =>
    (i: LoopIssue, ...rest: unknown[]): Promise<StepResult> => {
      calls.push(
        `${name} #${i.number}${rest.length ? ` ${JSON.stringify(rest[0])}` : ""}`,
      );
      return results[name]?.() ?? Promise.resolve({ status: "ok" });
    };
  const deps: LoopDeps = {
    config,
    store,
    board: {
      issuesByColumn: () => Promise.resolve(board),
      moveIssue: (n, column) => {
        moves.push([n, column]);
        return Promise.resolve();
      },
      comment: (n, body, o) => {
        comments.push({ issue: n, body, ...o });
        return Promise.resolve();
      },
      hasConflict: () => Promise.resolve(options.conflict ?? false),
    },
    pickUp: (i) => {
      calls.push(`pickUp #${i.number}`);
      return Promise.resolve({ accepted: options.pickUp ?? true });
    },
    test: step("test"),
    implement: step("implement"),
    checkCi: (i) => {
      calls.push(`checkCi #${i.number}`);
      return results.checkCi?.() ?? Promise.resolve({ status: "passed" });
    },
    review: step("review"),
    merge: step("merge"),
    syncMain: step("syncMain"),
    log: (text) => logs.push(text),
  };
  const setStage = (n: number, stage: Stage, pr = 10 + n) =>
    store.update({ repo: REPO, issue: n }, { pr, checkpoint: { stage } });
  return { deps, store, calls, moves, comments, logs, results, setStage };
}

describe("tick の要件の受け取り", () => {
  const chatConfig = parseConfig(
    [
      `github: { repo: ${REPO}, project: 3, notify: me }`,
      "protected: [e2e/**]",
      "commands: { setup: s, test: t, acceptance: a, typecheck: y, build: b }",
      "chat:",
      "  type: discord",
      '  channels: { requirements: "1", questions: "2", notices: "3" }',
      '  allowed_users: ["u1"]',
    ].join("\n"),
  ).chat;

  it("窓口が失敗しても、Issue の処理は止めずに失敗を書き残す", async () => {
    const t = setup({ Ready: [3] });
    const chat = new MemoryChat();
    chat.readMessages = () => Promise.reject(new Error("Discord が落ちた"));
    const config = { ...t.deps.config };
    if (chatConfig) config.chat = chatConfig;
    const deps: LoopDeps = { ...t.deps, config, chat };
    await tick(deps, newLoopState());
    expect(t.calls).toEqual(["pickUp #3", "test #3"]);
    expect(t.logs.some((l) => l.includes("Discord が落ちた"))).toBe(true);
  });

  it("config.chat が無ければ、窓口があっても要件を読まない", async () => {
    const t = setup({});
    const chat = new MemoryChat();
    let read = 0;
    chat.readMessages = () => {
      read++;
      return Promise.resolve([]);
    };
    await tick({ ...t.deps, chat }, newLoopState());
    expect(read).toBe(0);
  });
});

describe("tick の仕様の承認", () => {
  it("スレッドがあり承認待ちの要件だけに approveSpec を呼び、失敗しても Issue の処理は止めない", async () => {
    const t = setup({ Ready: [3] });
    await t.store.updateRequirement("10", {
      threadId: "t10",
      state: "awaiting_approval",
      specPr: 1,
    });
    await t.store.updateRequirement("11", { threadId: "t11" });
    await t.store.updateRequirement("12", { state: "awaiting_approval" });
    await t.store.updateRequirement("13", {
      threadId: "t13",
      state: "awaiting_approval",
    });
    const seen: string[] = [];
    const deps: LoopDeps = {
      ...t.deps,
      approveSpec: (r) => {
        seen.push(r.messageId);
        return r.messageId === "10"
          ? Promise.reject(new Error("CI を読めない"))
          : Promise.resolve({ status: "waiting" });
      },
    };
    await tick(deps, newLoopState());
    expect(seen).toEqual(["10", "13"]);
    expect(t.calls).toEqual(["pickUp #3", "test #3"]);
    expect(t.logs.some((l) => l.includes("CI を読めない"))).toBe(true);
  });

  it("仕様化役が状態を変えた後の記録で承認を確かめる", async () => {
    const t = setup({});
    await t.store.updateRequirement("10", { threadId: "t10" });
    const seen: string[] = [];
    const deps: LoopDeps = {
      ...t.deps,
      specify: async (r) => {
        await t.store.updateRequirement(r.messageId, {
          state: "awaiting_approval",
          specPr: 1,
        });
        return { status: "specified" };
      },
      approveSpec: (r) => {
        seen.push(`${r.messageId} ${r.state} ${r.specPr}`);
        return Promise.resolve({ status: "waiting" });
      },
    };
    await tick(deps, newLoopState());
    expect(seen).toEqual(["10 awaiting_approval 1"]);
  });
});

describe("tick の分解", () => {
  it("スレッドがあり作業中で作業用 Issue が無い要件だけに decompose を呼び、失敗しても Issue の処理は止めない", async () => {
    const t = setup({ Ready: [3] });
    await t.store.updateRequirement("10", {
      threadId: "t10",
      state: "working",
    });
    await t.store.updateRequirement("11", {
      threadId: "t11",
      state: "working",
      workIssues: [5],
    });
    await t.store.updateRequirement("12", { state: "working" });
    await t.store.updateRequirement("13", {
      threadId: "t13",
      state: "blocked",
    });
    await t.store.updateRequirement("14", {
      threadId: "t14",
      state: "working",
    });
    const seen: string[] = [];
    const deps: LoopDeps = {
      ...t.deps,
      decompose: (r) => {
        seen.push(r.messageId);
        return r.messageId === "10"
          ? Promise.reject(new Error("PR を読めない"))
          : Promise.resolve({ status: "decomposed" });
      },
    };
    await tick(deps, newLoopState());
    expect(seen).toEqual(["10", "14"]);
    expect(t.calls).toEqual(["pickUp #3", "test #3"]);
    expect(t.logs.some((l) => l.includes("PR を読めない"))).toBe(true);
  });

  it("仕様の承認で作業中になった要件を、同じ確認で分解する", async () => {
    const t = setup({});
    await t.store.updateRequirement("10", {
      threadId: "t10",
      state: "awaiting_approval",
      specPr: 1,
    });
    const seen: string[] = [];
    const deps: LoopDeps = {
      ...t.deps,
      approveSpec: async (r) => {
        await t.store.updateRequirement(r.messageId, { state: "working" });
        return { status: "approved" };
      },
      decompose: (r) => {
        seen.push(`${r.messageId} ${r.state}`);
        return Promise.resolve({ status: "decomposed" });
      },
    };
    await tick(deps, newLoopState());
    expect(seen).toEqual(["10 working"]);
  });
});

describe("tick", () => {
  it("作業中の Issue が無ければ、Ready の番号が小さいものを1件拾って進める", async () => {
    const t = setup({ Ready: [5, 3] });
    await tick(t.deps, newLoopState());
    expect(t.calls).toEqual(["pickUp #3", "test #3"]);
  });

  it("入口確認で断られたら、テスト役を動かさない", async () => {
    const t = setup({ Ready: [3] }, { pickUp: false });
    await tick(t.deps, newLoopState());
    expect(t.calls).toEqual(["pickUp #3"]);
  });

  it("作業中の Issue があれば、それだけを1段階進め、Ready は拾わない", async () => {
    const t = setup({ Ready: [1], Implementing: [4] });
    await t.setStage(4, "implementing");
    await tick(t.deps, newLoopState());
    expect(t.calls).toEqual(["implement #4 []"]);
  });

  it("記録が無ければ、列から段階を決める", async () => {
    const t = setup({ Reviewing: [7] });
    await tick(t.deps, newLoopState());
    expect(t.calls).toEqual(["review #7"]);
  });

  it("ci の段階では、CI が通っていればそのままレビューする", async () => {
    const t = setup({ Implementing: [2] });
    await t.setStage(2, "ci");
    await tick(t.deps, newLoopState());
    expect(t.calls).toEqual(["checkCi #2", "review #2"]);
  });

  it("CI が実行中ならレビューしない", async () => {
    const t = setup({ Implementing: [2] });
    await t.setStage(2, "ci");
    t.results.checkCi = () => Promise.resolve({ status: "pending" });
    await tick(t.deps, newLoopState());
    expect(t.calls).toEqual(["checkCi #2"]);
  });

  it("承認待ちは作業中に数えず、毎回確かめたうえで次の Issue に取りかかる", async () => {
    const t = setup({ Ready: [9], Reviewing: [2] });
    await t.setStage(2, "approving");
    await tick(t.deps, newLoopState());
    expect(t.calls).toEqual(["review #2", "pickUp #9", "test #9"]);
  });

  it("途中で止まったマージは続きから行う", async () => {
    const t = setup({ Reviewing: [2] });
    await t.setStage(2, "merging");
    await tick(t.deps, newLoopState());
    expect(t.calls).toEqual(["merge #2"]);
  });

  it("レビュー待ちで衝突していたら、レビューせずに main を取り込む", async () => {
    const t = setup({ Reviewing: [2] }, { conflict: true });
    await t.setStage(2, "reviewing", 12);
    await tick(t.deps, newLoopState());
    expect(t.calls).toEqual(["syncMain #2 12"]);
  });

  it("CI 待ちで衝突していたら、CI を見ずに main を取り込む", async () => {
    const t = setup({ Reviewing: [2] }, { conflict: true });
    await t.setStage(2, "ci", 12);
    await tick(t.deps, newLoopState());
    expect(t.calls).toEqual(["syncMain #2 12"]);
  });

  it("衝突していなければ main を取り込まない", async () => {
    const t = setup({ Reviewing: [2] });
    await t.setStage(2, "reviewing", 12);
    await tick(t.deps, newLoopState());
    expect(t.calls).toEqual(["review #2"]);
  });

  it(`${MAX_FAILURES} 回続けて失敗したら Blocked にしてメンションする`, async () => {
    const t = setup({ Testing: [3] });
    t.results.test = () => Promise.reject(new Error("壊れた"));
    const state = newLoopState();
    for (let i = 1; i < MAX_FAILURES; i++) await tick(t.deps, state);
    expect(t.moves).toEqual([]);
    await tick(t.deps, state);
    expect(t.moves).toEqual([[3, "Blocked"]]);
    expect(t.comments).toHaveLength(1);
    expect(t.comments[0]?.mention).toBe(true);
    expect(t.comments[0]?.body).toContain("壊れた");
    expect(t.comments[0]?.body).toContain("Ready");
  });

  it("途中で成功したら、失敗の回数を数え直す", async () => {
    const t = setup({ Testing: [3] });
    const state = newLoopState();
    t.results.test = () => Promise.reject(new Error("x"));
    for (let i = 1; i < MAX_FAILURES; i++) await tick(t.deps, state);
    t.results.test = () => Promise.resolve({ status: "ok" });
    await tick(t.deps, state);
    t.results.test = () => Promise.reject(new Error("x"));
    for (let i = 1; i < MAX_FAILURES; i++) await tick(t.deps, state);
    expect(t.moves).toEqual([]);
  });
});

describe("runLoop", () => {
  it("止める合図を受けたら、今の確認を終えてから止まる", async () => {
    const t = setup({ Testing: [3] });
    const controller = new AbortController();
    t.results.test = () => {
      controller.abort();
      return Promise.resolve({ status: "ok" });
    };
    const sleeps: number[] = [];
    t.deps.sleep = (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    };
    await runLoop(t.deps, controller.signal, { intervalMs: 1000 });
    expect(t.calls).toEqual(["test #3"]);
    expect(sleeps).toEqual([]);
    expect(t.logs.at(-1)).toBe("止まりました");
  });

  it("確認そのものが失敗しても止まらず、間隔をあけて続ける", async () => {
    const t = setup({});
    const controller = new AbortController();
    let n = 0;
    t.deps.board.issuesByColumn = () => {
      n++;
      return Promise.reject(new Error("通信エラー"));
    };
    t.deps.sleep = (ms) => {
      if (n >= 2) controller.abort();
      expect(ms).toBe(1000);
      return Promise.resolve();
    };
    await runLoop(t.deps, controller.signal, { intervalMs: 1000 });
    expect(n).toBe(2);
    expect(t.logs.filter((l) => l.includes("通信エラー"))).toHaveLength(2);
  });
});

describe("storeFile", () => {
  it("ホームの下に、リポジトリごとの記録ファイルを置く", () => {
    expect(storeFile("me/app", "/home/u")).toBe(
      join("/home/u", ".conductor", "state", "me__app.db"),
    );
  });
});

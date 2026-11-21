import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryChat } from "./chat.js";
import { parseConfig } from "./config.js";
import { PartialWorkAbortError } from "./partial-work.js";
import {
  abortComment,
  abortReason,
  MAX_FAILURES,
  runLoop,
  newLoopState,
  tick,
  type LoopActivity,
  type LoopDeps,
  type LoopIssue,
  type StepResult,
  waitingMessage,
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
  options: {
    conflict?: boolean;
    pickUp?: boolean;
    /** Issue ごとの、まだ開いている「先に済ませる Issue」（あれば入口確認は待つ） */
    waiting?: Record<number, number[]>;
  } = {},
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
    (i: LoopIssue, ...args: unknown[]): Promise<StepResult> => {
      // 最後の引数の中断の signal（StepContext）は記録しない
      const rest = args.filter(
        (a) => !(typeof a === "object" && a !== null && "signal" in a),
      );
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
      const waiting = options.waiting?.[i.number];
      if (waiting !== undefined) {
        return Promise.resolve({ accepted: false, waiting });
      }
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

describe("tick の着手と完了", () => {
  it("スレッドがあり作業中で作業用 Issue がある要件だけに progress を呼び、失敗しても Issue の処理は止めない", async () => {
    const t = setup({ Ready: [3] });
    await t.store.updateRequirement("10", {
      threadId: "t10",
      state: "working",
      workIssues: [5],
    });
    await t.store.updateRequirement("11", {
      threadId: "t11",
      state: "working",
    });
    await t.store.updateRequirement("12", {
      state: "working",
      workIssues: [6],
    });
    await t.store.updateRequirement("13", {
      threadId: "t13",
      state: "done",
      workIssues: [7],
    });
    await t.store.updateRequirement("14", {
      threadId: "t14",
      state: "working",
      workIssues: [8],
    });
    const seen: string[] = [];
    const deps: LoopDeps = {
      ...t.deps,
      progress: (r) => {
        seen.push(r.messageId);
        return r.messageId === "10"
          ? Promise.reject(new Error("Issue を読めない"))
          : Promise.resolve({ status: "waiting" });
      },
    };
    await tick(deps, newLoopState());
    expect(seen).toEqual(["10", "14"]);
    expect(t.calls).toEqual(["pickUp #3", "test #3"]);
    expect(t.logs.some((l) => l.includes("Issue を読めない"))).toBe(true);
  });

  it("分解した要件を、同じ確認で確かめる", async () => {
    const t = setup({});
    await t.store.updateRequirement("10", {
      threadId: "t10",
      state: "working",
    });
    const seen: string[] = [];
    const deps: LoopDeps = {
      ...t.deps,
      decompose: async (r) => {
        await t.store.updateRequirement(r.messageId, { workIssues: [5] });
        return { status: "decomposed" };
      },
      progress: (r) => {
        seen.push(`${r.messageId} ${r.workIssues.join(",")}`);
        return Promise.resolve({ status: "started" });
      },
    };
    await tick(deps, newLoopState());
    expect(seen).toEqual(["10 5"]);
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

  it("入口確認で断られたら（Blocked にしたら）、次の Ready はこの確認では拾わない", async () => {
    const t = setup({ Ready: [3, 4] }, { pickUp: false });
    await tick(t.deps, newLoopState());
    expect(t.calls).toEqual(["pickUp #3"]);
  });

  it("先に済ませる Issue を待つ Issue は Ready に残し、並び順で次の Issue を確かめて始める", async () => {
    const t = setup({ Ready: [5, 3, 4] }, { waiting: { 3: [1] } });
    const state = newLoopState();
    await tick(t.deps, state);
    expect(t.calls).toEqual(["pickUp #3", "pickUp #4", "test #4"]);
    // 待っている Issue は処理中に数えない（中断を受け付けない）
    expect(state.steps.abort(3)).toBe(false);
    expect(
      t.logs.some((l) => l.includes("着手できる Issue がありません")),
    ).toBe(false);
  });

  it("どれも着手できなければ何も始めず、待っている Issue と開いている番号をログに出す", async () => {
    const t = setup({ Ready: [3, 4] }, { waiting: { 3: [1], 4: [1, 2] } });
    await tick(t.deps, newLoopState());
    expect(t.calls).toEqual(["pickUp #3", "pickUp #4"]);
    expect(t.moves).toEqual([]);
    expect(t.comments).toEqual([]);
    expect(t.logs).toContain(
      waitingMessage("Ready", [
        { issue: 3, waiting: [1] },
        { issue: 4, waiting: [1, 2] },
      ]),
    );
    expect(waitingMessage("Ready", [{ issue: 4, waiting: [1, 2] }])).toContain(
      "#4: #1、#2 がまだ開いています",
    );
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

  it("窓口があれば、Blocked にしてもメンションせず、止まった理由を記録して次の確認でスレッドを作る", async () => {
    const t = setup({ Testing: [3] });
    t.results.test = () => Promise.reject(new Error("壊れた"));
    const config = parseConfig(
      [
        `github: { repo: ${REPO}, project: 3, notify: me }`,
        "protected: [e2e/**]",
        "commands: { setup: s, test: t, acceptance: a, typecheck: y, build: b }",
        "chat:",
        "  type: discord",
        '  channels: { requirements: "1", questions: "2", notices: "3" }',
        '  allowed_users: ["u1"]',
      ].join("\n"),
    );
    const chat = new MemoryChat();
    const board = new Map<string, LoopIssue[]>([["Testing", [issue(3)]]]);
    const deps: LoopDeps = {
      ...t.deps,
      config,
      chat,
      board: {
        ...t.deps.board,
        issuesByColumn: () => Promise.resolve(board),
        moveIssue: (n, column) => {
          t.moves.push([n, column]);
          board.delete("Testing");
          board.set(column, [issue(n)]);
          return Promise.resolve();
        },
      },
    };
    const state = newLoopState();
    for (let i = 0; i < MAX_FAILURES; i++) await tick(deps, state);
    expect(t.moves).toEqual([[3, "Blocked"]]);
    expect(t.comments).toHaveLength(1);
    expect(t.comments[0]?.mention).toBeUndefined();
    const noted = await t.store.getBlockedThread({ repo: REPO, issue: 3 });
    expect(noted?.reason).toBe("壊れた");

    await tick(deps, state);
    const channels = [...chat.threads.values()].map((th) => th.channelId);
    expect(channels).toEqual(["2"]);
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

describe("管理画面からの中断（StepAborter）", () => {
  it("動いている段階に signal を渡し、中断されたら失敗に数えずに Blocked にする", async () => {
    const t = setup({ Testing: [3] });
    const state = newLoopState();
    t.results.test = () => {
      expect(state.steps.running()).toBe(3);
      expect(state.steps.abort(4)).toBe(false);
      expect(state.steps.abort(3)).toBe(true);
      return Promise.reject(new Error("中断しました"));
    };
    await tick(t.deps, state);
    expect(t.moves).toEqual([[3, "Blocked"]]);
    expect(t.comments).toHaveLength(1);
    expect(t.comments[0]?.mention).toBe(true);
    expect(t.comments[0]?.body).toContain("管理画面から中断しました");
    expect(t.comments[0]?.body).not.toContain("失敗");
    const record = await t.store.get({ repo: REPO, issue: 3 });
    expect(record?.blockedReason).toBe("管理画面から中断しました。");
    expect(state.failures.size).toBe(0);
    expect(state.steps.running()).toBeUndefined();
  });

  it("段階の関数に中断の signal（StepContext）を渡す", async () => {
    const t = setup({ Testing: [3] });
    const seen: unknown[] = [];
    t.deps.test = (_i, ctx) => {
      seen.push(ctx?.signal);
      return Promise.resolve({ status: "ok" });
    };
    await tick(t.deps, newLoopState());
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(AbortSignal);
  });

  it("役の名前を中断の理由に入れる", () => {
    expect(abortReason("implementer")).toBe(
      "管理画面から中断しました（実装役の作業中）。",
    );
    expect(abortReason(undefined)).toBe("管理画面から中断しました。");
  });

  it("変更の残し方に合わせてコメントの文を変える", () => {
    expect(abortComment("implementer", "Ready", { kind: "pushed" })).toContain(
      "それまでの変更は Issue のブランチに残しています。",
    );
    expect(abortComment("implementer", "Ready", { kind: "nothing" })).toContain(
      "ブランチに残す変更はありませんでした。",
    );
    expect(
      abortComment("implementer", "Ready", { kind: "discarded" }),
    ).not.toContain("残しています");
    // 変更を残さない役では、残したとは書かない
    const tester = abortComment("tester", "Ready");
    expect(tester).not.toContain("残しています");
    expect(tester).toContain("最初からやり直します");
    for (const role of ["reviewer", "ci", "merge"] as const) {
      expect(abortComment(role, "Ready")).not.toContain("残しています");
    }
    expect(abortComment("reviewer", "Ready")).toContain(
      "続けるときは Ready 列に戻してください。",
    );
  });

  it("変更をブランチに残せなかったら、理由をコメント・止まった理由・ログに出す", async () => {
    const t = setup({ Implementing: [3] });
    await t.setStage(3, "implementing");
    const state = newLoopState();
    t.results.implement = () => {
      state.steps.abort(3);
      return Promise.reject(
        new PartialWorkAbortError({ kind: "failed", reason: "通信に失敗" }),
      );
    };
    await tick(t.deps, state);
    expect(t.moves).toEqual([[3, "Blocked"]]);
    const body = t.comments[0]?.body ?? "";
    expect(body).toContain(
      "変更をブランチに残せませんでした（理由: 通信に失敗）",
    );
    expect(body).not.toContain("残しています");
    const record = await t.store.get({ repo: REPO, issue: 3 });
    expect(record?.blockedReason).toContain("通信に失敗");
    expect(t.logs.some((l) => l.includes("通信に失敗"))).toBe(true);
  });

  it("中断されても段階が最後まで進んだ（マージした）ら、Blocked に移さず中断のコメントも付けない", async () => {
    const t = setup({ Reviewing: [3] });
    await t.setStage(3, "merging");
    const state = newLoopState();
    t.results.merge = () => {
      expect(state.steps.abort(3)).toBe(true);
      return Promise.resolve({ status: "merged" });
    };
    await tick(t.deps, state);
    expect(t.calls).toEqual(["merge #3"]);
    expect(t.moves.filter(([, c]) => c === "Blocked")).toEqual([]);
    expect(t.comments.filter((c) => c.body.includes("中断"))).toEqual([]);
    expect(t.logs).toContain("#3: merged");
    expect(state.failures.size).toBe(0);
  });

  it("段階の合間に中断を頼まれたら、次の確認で段階を始めずに Blocked に移す", async () => {
    const t = setup({ Reviewing: [3], Ready: [5] });
    await t.setStage(3, "ci");
    const state = newLoopState();
    t.results.checkCi = () => Promise.resolve({ status: "pending" });
    await tick(t.deps, state);
    expect(t.calls).toEqual(["checkCi #3"]);
    // CI の結果待ちの間（段階は動いていない）に中断する
    expect(state.steps.running()).toBeUndefined();
    expect(state.steps.abort(3)).toBe(true);
    // 処理中でない Issue は受け付けない
    expect(state.steps.abort(5)).toBe(false);
    await tick(t.deps, state);
    expect(t.calls).toEqual(["checkCi #3"]);
    expect(t.moves).toEqual([[3, "Blocked"]]);
    expect(t.comments).toHaveLength(1);
    expect(t.comments[0]?.mention).toBe(true);
    expect(t.comments[0]?.body).toContain("管理画面から中断しました。");
    const record = await t.store.get({ repo: REPO, issue: 3 });
    expect(record?.blockedReason).toBe("管理画面から中断しました。");
  });

  it("中断の予約は、その Issue が処理中でなくなったら捨てる", () => {
    const state = newLoopState();
    state.steps.setWorking([3]);
    expect(state.steps.abort(3)).toBe(true);
    state.steps.setWorking([]);
    expect(state.steps.takePending(3)).toBe(false);
    expect(state.steps.abort(3)).toBe(false);
  });

  it("中断のほかに失敗していたら、その内容をログに出す", async () => {
    const t = setup({ Testing: [3] });
    const state = newLoopState();
    t.results.test = () => {
      state.steps.abort(3);
      return Promise.reject(new Error("git が壊れた"));
    };
    await tick(t.deps, state);
    expect(t.moves).toEqual([[3, "Blocked"]]);
    expect(t.logs.some((l) => l.includes("git が壊れた"))).toBe(true);
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

  it("確認している間は running、次の確認を待つ間は idle を知らせる", async () => {
    const t = setup({});
    const controller = new AbortController();
    const statuses: string[] = [];
    t.deps.onStatus = (status) => statuses.push(status);
    t.deps.sleep = () => {
      statuses.push("sleep");
      if (statuses.filter((s) => s === "sleep").length >= 2) {
        controller.abort();
      }
      return Promise.resolve();
    };
    await runLoop(t.deps, controller.signal, { intervalMs: 1000 });
    expect(statuses).toEqual([
      "running",
      "idle",
      "sleep",
      "running",
      "idle",
      "sleep",
    ]);
  });

  it("動いている役と確認した時刻を、変わるたびに知らせる（CI の後はレビュー役）", async () => {
    const t = setup({ Reviewing: [4] });
    await t.setStage(4, "ci");
    const controller = new AbortController();
    const activities: LoopActivity[] = [];
    t.deps.onActivity = (a) => activities.push(a);
    t.deps.sleep = () => {
      controller.abort();
      return Promise.resolve();
    };
    const before = Date.now();
    await runLoop(t.deps, controller.signal, { intervalMs: 1000 });

    expect(activities.map((a) => a.running?.role ?? "-")).toEqual([
      "-",
      "ci",
      "-",
      "reviewer",
      "-",
      "-",
    ]);
    expect(activities.map((a) => a.running?.issue)).toContain(4);
    const last = activities.at(-1);
    const checked = Date.parse(last?.lastCheckedAt ?? "");
    expect(checked).toBeGreaterThanOrEqual(before);
    expect(Date.parse(last?.nextCheckAt ?? "")).toBe(checked + 1000);
    // 確認している間は、次の確認の時刻を持たない
    expect(activities[0]?.nextCheckAt).toBeUndefined();
  });
});

describe("storeFile", () => {
  it("ホームの下に、リポジトリごとの記録ファイルを置く", () => {
    expect(storeFile("me/app", "/home/u")).toBe(
      join("/home/u", ".conductor", "state", "me__app.db"),
    );
  });
});

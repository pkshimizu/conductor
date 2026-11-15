import { describe, expect, it } from "vitest";
import type { RoleRun } from "./claude.js";
import { parseConfig } from "./config.js";
import type { CiResult } from "./github.js";
import { pendingFindings } from "./rejection.js";
import {
  checkCi,
  ciFindings,
  combineReviews,
  DIFF_LIMIT,
  mapLimit,
  reviewerAllow,
  reviewerDeny,
  reviewerSystemPrompts,
  runReviewer,
  type ReviewerDeps,
  type ReviewerOutput,
  type reviewerOutputSchema,
} from "./reviewer.js";
import { MemoryStore } from "./store.js";

const BODY = `### 受け入れ条件（AC）

- AC1
  - Given カードが無い
  - When /cards を開く
  - Then 「カードがありません」と出る
`;
const ISSUE = { number: 2, title: "カード一覧", body: BODY };
const KEY = { repo: "me/app", issue: 2 };

function makeConfig(extra: string[] = []) {
  return parseConfig(
    [
      "github: { repo: me/app, project: 3, notify: me }",
      "protected: [e2e/**, supabase/seed.sql]",
      "commands: { setup: npm run db:reset, test: npm test, acceptance: npm run e2e, typecheck: npm run typecheck, build: npm run build }",
      ...extra,
    ].join("\n"),
  );
}

const approve = (summary = "AC を満たしています"): ReviewerOutput => ({
  verdict: "approve",
  summary,
  findings: [],
});

type Reply =
  | ReviewerOutput
  | ((run: RoleRun<typeof reviewerOutputSchema>) => ReviewerOutput);

function setup(
  replies: Reply[],
  options: {
    perspectives?: { name: string; text: string }[];
    ci?: CiResult;
    diff?: string;
    extraConfig?: string[];
    existing?: string[];
    /** 既存の試験はマージまでを見るので、既定は auto */
    approval?: "human" | "auto";
  } = {},
) {
  const config = makeConfig([
    `merge: { approval: ${options.approval ?? "auto"} }`,
    ...(options.extraConfig ?? []),
  ]);
  const store = new MemoryStore(() => new Date("2026-11-15T00:00:00Z"));
  const log: string[] = [];
  const moves: [number, string][] = [];
  const comments: { issue: number; body: string; mention?: boolean }[] = [];
  const merged: [number, number, string][] = [];
  const commands: string[] = [];
  const runs: RoleRun<typeof reviewerOutputSchema>[] = [];
  let running = 0;
  let maxRunning = 0;

  const deps: ReviewerDeps = {
    config,
    repoDir: "/repo",
    store,
    perspectives: options.perspectives ?? [],
    git: {
      startBranch: (b, base) => {
        log.push(`branch ${b} from ${base}`);
        return Promise.resolve();
      },
      discardAll: () => {
        log.push("discardAll");
        return Promise.resolve();
      },
      changedFiles: () => Promise.resolve([]),
      diffFrom: (base, o = {}) => {
        log.push(`diff ${base}${o.stat ? " stat" : ""}`);
        return Promise.resolve(
          o.stat ? " src/a.ts | 2 +-" : (options.diff ?? "+new line"),
        );
      },
    },
    board: {
      moveIssue: (issue, column) => {
        moves.push([issue, column]);
        return Promise.resolve();
      },
      comment: (issue, body, o) => {
        comments.push({ issue, body, ...o });
        return Promise.resolve();
      },
      ciStatus: () =>
        Promise.resolve(options.ci ?? { state: "success", checks: [] }),
      merge: (pr, issue, done) => {
        merged.push([pr, issue, done]);
        return Promise.resolve();
      },
      baseBranch: () => Promise.resolve("main"),
      headSha: () => Promise.resolve("abc"),
      prComments: () => Promise.resolve([]),
      canWrite: () => Promise.resolve(true),
    },
    shell: (cmd) => {
      commands.push(cmd);
      return Promise.resolve({ code: 0, stdout: "ok", stderr: "" });
    },
    exists: (path) => Promise.resolve((options.existing ?? []).includes(path)),
    run: async (run) => {
      const i = runs.length;
      runs.push(run);
      running++;
      maxRunning = Math.max(maxRunning, running);
      // 並列に動いていることを確かめるため、少し待つ
      await new Promise((r) => setTimeout(r, 5));
      running--;
      const reply = replies[i]!;
      return {
        output: typeof reply === "function" ? reply(run) : reply,
        denials: [],
        costUsd: 0,
        turns: 1,
        sessionId: "s",
      };
    },
  };
  const init = () =>
    store.update(KEY, {
      branch: "conductor/issue-2",
      pr: 7,
      checkpoint: { stage: "ci" },
    });
  return {
    deps,
    store,
    log,
    moves,
    comments,
    merged,
    commands,
    runs,
    init,
    maxRunning: () => maxRunning,
  };
}

describe("許可・依頼文", () => {
  it("レビュー役は読むだけ", () => {
    const allow = reviewerAllow(makeConfig());
    expect(allow).toContain("Read");
    expect(allow).not.toContain("Edit");
    expect(reviewerDeny()).toEqual(["Edit", "Write", "NotebookEdit"]);
  });

  it("観点が無ければ全体を見る1人、あれば観点ごとに1人", () => {
    expect(reviewerSystemPrompts([])).toHaveLength(1);
    const ps = reviewerSystemPrompts([
      { name: "a11y", text: "ラベルがある" },
      { name: "security", text: "秘密を書かない" },
    ]);
    expect(ps.map((p) => p.name)).toEqual(["a11y", "security"]);
    expect(ps[0]!.prompt).toContain("# レビュー観点: a11y");
    expect(ps[0]!.prompt).toContain("ラベルがある");
    expect(ps[0]!.prompt).not.toContain("秘密を書かない");
  });

  it("CI の失敗を指摘にする", () => {
    const f = ciFindings({
      state: "failure",
      checks: [
        { name: "check", bucket: "fail", link: "" },
        { name: "lint", bucket: "pass", link: "" },
      ],
      failureLog: "1 failed",
    });
    expect(f).toEqual(["CI が失敗しました（check）。ログの要点:\n1 failed"]);
  });
});

describe("combineReviews", () => {
  const reject: ReviewerOutput = {
    verdict: "reject",
    summary: "ラベルが無い",
    findings: [{ file: "src/a.tsx", line: 3, message: "label を付ける" }],
  };
  it("全員が承認なら承認", () => {
    const out = combineReviews([
      { name: "a", output: approve("ok1") },
      { name: "b", output: approve("ok2") },
    ]);
    expect(out.verdict).toBe("approve");
    expect(out.summary).toBe("［a］approve: ok1\n［b］approve: ok2");
  });
  it("1つでも差し戻しなら差し戻し。指摘には観点の名前が付く", () => {
    const out = combineReviews([
      { name: "a11y", output: reject },
      { name: "b", output: approve() },
    ]);
    expect(out.verdict).toBe("reject");
    expect(out.findings).toEqual([
      { file: "src/a.tsx", line: 3, message: "［a11y］label を付ける" },
    ]);
  });
  it("異議は差し戻しより優先する", () => {
    const out = combineReviews([
      { name: "a", output: reject },
      {
        name: "b",
        output: { verdict: "objection", summary: "AC と逆", findings: [] },
      },
    ]);
    expect(out.verdict).toBe("objection");
    expect(out.findings).toEqual([
      { file: "（全体）", line: null, message: "［b］AC と逆" },
    ]);
  });
});

describe("mapLimit", () => {
  it("同時に動かす数を守り、順番どおりに返す", async () => {
    let running = 0;
    let max = 0;
    const r = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
      running++;
      max = Math.max(max, running);
      await new Promise((res) => setTimeout(res, 5));
      running--;
      return n * 10;
    });
    expect(r).toEqual([10, 20, 30, 40, 50]);
    expect(max).toBe(2);
  });
  it("失敗があれば全部を終えてから投げる", async () => {
    const done: number[] = [];
    await expect(
      mapLimit([1, 2, 3], 3, async (n) => {
        await new Promise((res) => setTimeout(res, n));
        done.push(n);
        if (n === 1) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
    expect(done.sort()).toEqual([1, 2, 3]);
  });
});

describe("checkCi", () => {
  it("実行中なら pending", async () => {
    const s = setup([], { ci: { state: "pending", checks: [] } });
    await s.init();
    expect(await checkCi(s.deps, 2)).toEqual({ status: "pending" });
  });
  it("通ればレビューへ進む", async () => {
    const s = setup([]);
    await s.init();
    expect(await checkCi(s.deps, 2)).toEqual({ status: "passed" });
    expect((await s.store.get(KEY))?.checkpoint?.stage).toBe("reviewing");
  });
  it("失敗したらログの要点を指摘として差し戻す", async () => {
    const s = setup([], {
      ci: {
        state: "failure",
        checks: [{ name: "check", bucket: "fail", link: "" }],
        failureLog: "expected 1",
      },
    });
    await s.init();
    const r = await checkCi(s.deps, 2);
    expect(r).toMatchObject({
      status: "rejected",
      rejections: 1,
      blocked: false,
    });
    expect(s.moves).toContainEqual([2, "Implementing"]);
    expect(await pendingFindings(s.store, KEY)).toEqual([
      "CI が失敗しました（check）。ログの要点:\nexpected 1",
    ]);
  });
  it("PR が無ければ待つ", async () => {
    const s = setup([]);
    expect(await checkCi(s.deps, 2)).toEqual({ status: "waiting" });
  });
});

describe("runReviewer", () => {
  it("merge.approval が human なら、全員が承認してもマージせず承認待ちにする", async () => {
    const s = setup([approve()], { approval: "human" });
    await s.init();
    const r = await runReviewer(s.deps, ISSUE);
    expect(r).toEqual({ status: "awaiting-approval", pr: 7 });
    expect(s.merged).toEqual([]);
    // Reviewing 列のまま
    expect(s.moves.at(-1)).toEqual([2, "Reviewing"]);
    expect(s.comments.at(-1)).toMatchObject({ issue: 7, mention: true });
    expect(s.comments.at(-1)!.body).toContain("/conductor approve");
    const cp = (await s.store.get(KEY))?.checkpoint;
    expect(cp?.stage).toBe("approving");
    expect(cp?.approval?.sha).toBe("abc");
  });

  it("承認待ちなら、レビュー役を動かさずに /conductor approve を見てマージする", async () => {
    const s = setup([], { approval: "human" });
    await s.init();
    const since = new Date(0).toISOString();
    await s.store.update(KEY, {
      checkpoint: {
        stage: "approving",
        approval: { since, checked: since, sha: "abc" },
      },
    });
    s.deps.board.prComments = () =>
      Promise.resolve([
        {
          author: "me",
          body: "/conductor approve",
          createdAt: new Date(1000).toISOString(),
        },
      ]);
    const r = await runReviewer(s.deps, ISSUE);
    expect(r).toEqual({ status: "merged", pr: 7 });
    expect(s.merged).toHaveLength(1);
  });

  it("観点ごとに並列でレビューし、全員が承認ならマージする", async () => {
    const s = setup([approve("a ok"), approve("b ok"), approve("c ok")], {
      perspectives: [
        { name: "a", text: "観点A" },
        { name: "b", text: "観点B" },
        { name: "c", text: "観点C" },
      ],
    });
    await s.init();
    const r = await runReviewer(s.deps, ISSUE);
    expect(r).toEqual({ status: "merged", pr: 7 });
    expect(s.runs).toHaveLength(3);
    expect(s.maxRunning()).toBe(3);
    expect(s.runs.map((x) => x.systemPrompt)).toEqual([
      expect.stringContaining("観点A"),
      expect.stringContaining("観点B"),
      expect.stringContaining("観点C"),
    ]);
    // 依頼文（差分）は全員同じ
    expect(new Set(s.runs.map((x) => x.prompt)).size).toBe(1);
    expect(s.runs[0]!.prompt).toContain("+new line");
    expect(s.merged).toEqual([[7, 2, "Done"]]);
    expect(s.log.at(-1)).toBe("discardAll");
    expect((await s.store.get(KEY))?.checkpoint).toBeUndefined();
    const sums = await s.store.summaries(KEY);
    expect(sums.at(-1)?.text).toContain("［b］approve: b ok");
  });

  it("同時に動かす数は limits.reviewers まで", async () => {
    const s = setup([approve(), approve(), approve(), approve()], {
      perspectives: ["a", "b", "c", "d"].map((name) => ({ name, text: name })),
      extraConfig: ["limits: { reviewers: 2 }"],
    });
    await s.init();
    await runReviewer(s.deps, ISSUE);
    expect(s.runs).toHaveLength(4);
    expect(s.maxRunning()).toBe(2);
  });

  it("観点が無ければ1人でレビューする", async () => {
    const s = setup([approve()]);
    await s.init();
    expect(await runReviewer(s.deps, ISSUE)).toEqual({
      status: "merged",
      pr: 7,
    });
    expect(s.runs).toHaveLength(1);
  });

  it("1つの観点でも差し戻しなら、観点名付きの指摘で差し戻す", async () => {
    const s = setup(
      [
        approve(),
        {
          verdict: "reject",
          summary: "ラベルが無い",
          findings: [{ file: "src/a.tsx", line: 3, message: "label を付ける" }],
        },
      ],
      {
        perspectives: [
          { name: "a", text: "A" },
          { name: "a11y", text: "B" },
        ],
      },
    );
    await s.init();
    const r = await runReviewer(s.deps, ISSUE);
    expect(r).toEqual({
      status: "rejected",
      findings: ["src/a.tsx:3: ［a11y］label を付ける"],
      rejections: 1,
      blocked: false,
    });
    expect(s.merged).toEqual([]);
    expect(await pendingFindings(s.store, KEY)).toEqual([
      "src/a.tsx:3: ［a11y］label を付ける",
    ]);
  });

  it("異議なら Blocked に移してメンションする", async () => {
    const s = setup([
      { verdict: "objection", summary: "テストが AC と逆", findings: [] },
    ]);
    await s.init();
    const r = await runReviewer(s.deps, ISSUE);
    expect(r).toEqual({ status: "objection", objections: 1 });
    expect(s.moves.at(-1)).toEqual([2, "Blocked"]);
    expect(s.comments.at(-1)?.mention).toBe(true);
    expect(s.merged).toEqual([]);
  });

  it("差分が長ければ変更の一覧だけを渡す", async () => {
    const s = setup([approve()], { diff: "x".repeat(DIFF_LIMIT + 1) });
    await s.init();
    await runReviewer(s.deps, ISSUE);
    expect(s.log).toContain("diff main stat");
    expect(s.runs[0]!.prompt).toContain("src/a.ts | 2 +-");
    expect(s.runs[0]!.prompt).not.toContain("xxxx");
  });

  it("撮影の設定があれば受け入れテストを流し、撮れた画像を渡す", async () => {
    const s = setup([approve()], {
      extraConfig: ["screenshots: shots"],
      existing: ["shots/issue-2/AC1.png"],
    });
    await s.init();
    await runReviewer(s.deps, ISSUE);
    expect(s.commands).toEqual(["npm run db:reset", "npm run e2e"]);
    expect(s.runs[0]!.prompt).toContain("- shots/issue-2/AC1.png");
  });

  it("レビュー役が失敗しても変更を捨てる", async () => {
    const s = setup([
      () => {
        throw new Error("usage limit");
      },
    ]);
    await s.init();
    await expect(runReviewer(s.deps, ISSUE)).rejects.toThrow("usage limit");
    expect(s.log.at(-1)).toBe("discardAll");
  });
});

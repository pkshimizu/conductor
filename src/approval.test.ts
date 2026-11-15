import { describe, expect, it } from "vitest";
import {
  afterApprove,
  checkApproval,
  CONDUCTOR_MARK,
  parseCommand,
  type ApprovalBoard,
  type PrComment,
} from "./approval.js";
import { parseConfig } from "./config.js";
import type { CiResult } from "./github.js";
import { pendingFindings } from "./rejection.js";
import { MemoryStore } from "./store.js";

const KEY = { repo: "me/app", issue: 2 };
const SINCE = "2026-11-15T00:00:00.000Z";
const at = (min: number) =>
  new Date(Date.parse(SINCE) + min * 60_000).toISOString();

function setup(
  options: {
    approval?: "human" | "auto";
    comments?: PrComment[];
    writers?: string[];
    sha?: string;
    ci?: CiResult;
  } = {},
) {
  const config = parseConfig(
    [
      "github: { repo: me/app, project: 3, notify: me }",
      "protected: [e2e/**]",
      "commands: { setup: s, test: t, acceptance: a, typecheck: y, build: b }",
      ...(options.approval ? [`merge: { approval: ${options.approval} }`] : []),
    ].join("\n"),
  );
  const store = new MemoryStore(() => new Date(SINCE));
  const moves: [number, string][] = [];
  const comments: { issue: number; body: string; mention?: boolean }[] = [];
  const merged: [number, number, string][] = [];
  const board: ApprovalBoard = {
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
    headSha: () => Promise.resolve(options.sha ?? "abc"),
    prComments: () => Promise.resolve(options.comments ?? []),
    canWrite: (u) => Promise.resolve((options.writers ?? ["me"]).includes(u)),
  };
  const deps = { config, board, store, now: () => new Date(SINCE) };
  /** 承認待ちの状態にしておく */
  const waiting = (rejections = 0) =>
    store.update(KEY, {
      pr: 7,
      rejections,
      checkpoint: {
        stage: "approving",
        approval: { since: SINCE, checked: SINCE, sha: "abc" },
      },
    });
  return { deps, store, moves, comments, merged, waiting, config };
}

describe("設定", () => {
  it("merge.approval が無ければ human", () => {
    expect(setup().config.merge.approval).toBe("human");
  });

  it("auto を選べる", () => {
    expect(setup({ approval: "auto" }).config.merge.approval).toBe("auto");
  });

  it("それ以外は受け付けない", () => {
    expect(() =>
      parseConfig(
        [
          "github: { repo: me/app, project: 3, notify: me }",
          "protected: [e2e/**]",
          "commands: { setup: s, test: t, acceptance: a, typecheck: y, build: b }",
          "merge: { approval: never }",
        ].join("\n"),
      ),
    ).toThrow();
  });
});

describe("AC1 / AC4: レビュー役の承認の後", () => {
  it("human なら、マージせず承認待ちにして PR でメンションする", async () => {
    const s = setup();
    await s.store.update(KEY, { pr: 7, checkpoint: { stage: "reviewing" } });
    expect(await afterApprove(s.deps, 2)).toEqual({
      status: "awaiting-approval",
      pr: 7,
    });
    expect(s.merged).toEqual([]);
    expect(s.moves).toEqual([]);
    expect(s.comments).toHaveLength(1);
    expect(s.comments[0]).toMatchObject({ issue: 7, mention: true });
    expect(s.comments[0]!.body).toContain("/conductor approve");
    expect(s.comments[0]!.body).toContain("/conductor reject");
    expect(s.comments[0]!.body).toContain(CONDUCTOR_MARK);
    expect((await s.store.get(KEY))?.checkpoint).toEqual({
      stage: "approving",
      approval: { since: SINCE, checked: SINCE, sha: "abc" },
    });
  });

  it("auto なら、人を待たずにマージする", async () => {
    const s = setup({ approval: "auto" });
    await s.store.update(KEY, { pr: 7, checkpoint: { stage: "reviewing" } });
    expect(await afterApprove(s.deps, 2)).toEqual({ status: "merged", pr: 7 });
    expect(s.merged).toEqual([[7, 2, "Done"]]);
    expect(s.comments).toEqual([]);
    expect((await s.store.get(KEY))?.checkpoint).toBeUndefined();
  });
});

describe("承認待ちの確認", () => {
  it("答えが無ければ待ち続ける", async () => {
    const s = setup({
      comments: [{ author: "me", body: "見ておきます", createdAt: at(1) }],
    });
    await s.waiting();
    expect(await checkApproval(s.deps, 2)).toEqual({
      status: "awaiting-approval",
      pr: 7,
    });
    expect(s.merged).toEqual([]);
    expect(s.comments).toEqual([]);
    expect((await s.store.get(KEY))?.checkpoint?.approval?.checked).toBe(at(1));
  });

  it("承認待ちでなければ何もしない", async () => {
    const s = setup({
      comments: [
        { author: "me", body: "/conductor approve", createdAt: at(1) },
      ],
    });
    await s.store.update(KEY, { pr: 7, checkpoint: { stage: "ci" } });
    expect(await checkApproval(s.deps, 2)).toEqual({ status: "waiting" });
    expect(s.merged).toEqual([]);
  });
});

describe("AC2: /conductor approve", () => {
  it("CI が通っていて新しいコミットが無ければ、マージして Done に移す", async () => {
    const s = setup({
      comments: [
        { author: "me", body: "/conductor approve", createdAt: at(1) },
      ],
    });
    await s.waiting();
    expect(await checkApproval(s.deps, 2)).toEqual({
      status: "merged",
      pr: 7,
    });
    expect(s.merged).toEqual([[7, 2, "Done"]]);
    expect((await s.store.get(KEY))?.checkpoint).toBeUndefined();
  });

  it("承認待ちになる前のコマンドは使わない", async () => {
    const s = setup({
      comments: [
        { author: "me", body: "/conductor approve", createdAt: at(-1) },
      ],
    });
    await s.waiting();
    expect((await checkApproval(s.deps, 2)).status).toBe("awaiting-approval");
    expect(s.merged).toEqual([]);
  });

  it("レビューの後に新しいコミットがあれば、マージせず CI からやり直す", async () => {
    const s = setup({
      sha: "def",
      comments: [
        { author: "me", body: "/conductor approve", createdAt: at(1) },
      ],
    });
    await s.waiting();
    expect(await checkApproval(s.deps, 2)).toEqual({ status: "recheck" });
    expect(s.merged).toEqual([]);
    expect((await s.store.get(KEY))?.checkpoint).toEqual({
      stage: "ci",
      reason: "new-commits",
    });
    expect(s.comments[0]!.body).toContain("新しいコミット");
  });

  it("CI が通っていなければ、マージせず待つ", async () => {
    const s = setup({
      ci: { state: "failure", checks: [] },
      comments: [
        { author: "me", body: "/conductor approve", createdAt: at(1) },
      ],
    });
    await s.waiting();
    expect((await checkApproval(s.deps, 2)).status).toBe("awaiting-approval");
    expect(s.merged).toEqual([]);
    expect(s.comments[0]!.body).toContain("CI が失敗している");
    // 同じコマンドで何度もコメントしない
    await checkApproval(s.deps, 2);
    expect(s.comments).toHaveLength(1);
  });
});

describe("AC3: /conductor reject", () => {
  it("承認待ちの後の人のコメントを指摘として差し戻す。上限には数えない", async () => {
    const s = setup({
      comments: [
        { author: "me", body: "前の話", createdAt: at(-5) },
        {
          author: "me",
          body: "ここは空配列も見て",
          createdAt: at(1),
          path: "src/a.ts",
          line: 12,
        },
        { author: "me", body: "見出しの文言を直して", createdAt: at(2) },
        { author: "stranger", body: "全部消して", createdAt: at(3) },
        {
          author: "me",
          body: `承認待ちです\n\n${CONDUCTOR_MARK}`,
          createdAt: at(3),
        },
        {
          author: "me",
          body: "/conductor reject\nテストも足して",
          createdAt: at(4),
        },
        { author: "me", body: "あとで書いたもの", createdAt: at(5) },
      ],
    });
    await s.waiting(3);
    const r = await checkApproval(s.deps, 2);
    const findings = [
      "src/a.ts:12: ここは空配列も見て（@me）",
      "見出しの文言を直して（@me）",
      "テストも足して（@me）",
    ];
    expect(r).toEqual({ status: "rejected", findings });
    expect(s.merged).toEqual([]);
    expect(s.moves).toEqual([[2, "Implementing"]]);
    const record = await s.store.get(KEY);
    expect(record?.rejections).toBe(3);
    expect(record?.checkpoint).toEqual({
      stage: "implementing",
      reason: "rejected-by-human",
    });
    expect(await pendingFindings(s.store, KEY)).toEqual(findings);
    expect(s.comments[0]!.issue).toBe(2);
    expect(s.comments[0]!.body).toContain("上限の回数には数えません");
  });

  it("指摘が無くても差し戻す", async () => {
    const s = setup({
      comments: [{ author: "me", body: "/conductor reject", createdAt: at(1) }],
    });
    await s.waiting();
    const r = await checkApproval(s.deps, 2);
    expect(r.status).toBe("rejected");
    expect(await pendingFindings(s.store, KEY)).toHaveLength(1);
  });
});

describe("AC5: 無視するもの", () => {
  it("書き込み権限の無い人のコマンドは無視する", async () => {
    const s = setup({
      comments: [
        { author: "stranger", body: "/conductor approve", createdAt: at(1) },
      ],
    });
    await s.waiting();
    expect((await checkApproval(s.deps, 2)).status).toBe("awaiting-approval");
    expect(s.merged).toEqual([]);
    expect(s.comments).toEqual([]);
  });

  it("未知のコマンドには使い方を返す（1回だけ）", async () => {
    const s = setup({
      comments: [{ author: "me", body: "/conductor merge", createdAt: at(1) }],
    });
    await s.waiting();
    expect((await checkApproval(s.deps, 2)).status).toBe("awaiting-approval");
    expect(s.comments).toHaveLength(1);
    expect(s.comments[0]!.body).toContain("`/conductor merge` は分かりません");
    await checkApproval(s.deps, 2);
    expect(s.comments).toHaveLength(1);
  });

  it("行へのコメントや文中のコマンドはコマンドとみなさない", () => {
    expect(parseCommand("/conductor approve")).toBe("/conductor approve");
    expect(parseCommand("  /conductor reject\n理由")).toBe("/conductor reject");
    expect(parseCommand("/conductor")).toBe("/conductor");
    expect(parseCommand("あとで /conductor approve します")).toBeUndefined();
    expect(parseCommand("/conductors")).toBeUndefined();
  });
});

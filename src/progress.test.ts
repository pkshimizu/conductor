import { describe, expect, it } from "vitest";
import { MemoryChat } from "./chat.js";
import { parseConfig } from "./config.js";
import {
  cachedStatusOf,
  checkProgress,
  completedMessage,
  isDone,
  prerequisiteState,
  prerequisitesOf,
  type ProgressBoard,
  type WorkIssueStatus,
} from "./progress.js";
import { MemoryStore } from "./store.js";

const NOTICES = "3";

const config = parseConfig(
  [
    "github: { repo: me/app, project: 3, notify: me }",
    "protected: [e2e/**]",
    "commands: { setup: s, test: t, acceptance: a, typecheck: y, build: b }",
    "chat:",
    "  type: discord",
    `  channels: { requirements: "1", questions: "2", notices: "${NOTICES}" }`,
    '  allowed_users: ["u1"]',
  ].join("\n"),
);

const body = (prerequisites: number[]) =>
  [
    "## 目的",
    "#99 を参考に作る",
    "",
    "## 先に済ませる Issue",
    prerequisites.length === 0
      ? "なし"
      : prerequisites.map((n) => `- #${n}`).join("\n"),
    "",
    "## 仕様",
    "- https://example.com/#1",
  ].join("\n");

function fakeBoard(issues: Record<number, WorkIssueStatus>) {
  const moved: [number, string][] = [];
  const board: ProgressBoard = {
    workIssueStatus: (n) => {
      const s = issues[n];
      return s === undefined
        ? Promise.reject(new Error(`#${n} は無い`))
        : Promise.resolve(s);
    },
    moveIssue: (n, column) => {
      moved.push([n, column]);
      return Promise.resolve();
    },
  };
  return { board, moved };
}

async function setup(
  issues: Record<number, WorkIssueStatus>,
  workIssues: number[],
) {
  const chat = new MemoryChat("bot");
  const store = new MemoryStore();
  // 要件チャンネル（"1"）の元の投稿からスレッドを作る
  const posted = chat.addMessage("1", {
    authorId: "u1",
    text: "検索をつけたい\n前方一致で",
  });
  const threadId = await chat.createThread("1", posted.id, "検索");
  const requirement = await store.updateRequirement(posted.id, {
    threadId,
    state: "working",
    workIssues,
  });
  const { board, moved } = fakeBoard(issues);
  const deps = { config, chat, store, board, log: () => {} };
  return { deps, chat, store, requirement, moved };
}

describe("prerequisitesOf", () => {
  it("「先に済ませる Issue」の見出しの下の #番号 だけを読む", () => {
    expect(prerequisitesOf(body([3, 4, 3]))).toEqual([3, 4]);
    expect(prerequisitesOf(body([]))).toEqual([]);
    expect(prerequisitesOf("本文だけ #5")).toEqual([]);
  });

  it("Issue フォームの「### 見出し」（行末の # 付きも）でも読む", () => {
    expect(
      prerequisitesOf(
        "### 目的\n#9 を参照\n\n### 先に済ませる Issue ###\n- #7\r\n- #8\n\n### 対象外\n#10",
      ),
    ).toEqual([7, 8]);
  });
});

describe("isDone", () => {
  it("閉じていれば（マージした PR があっても無くても）済んだとみなす", () => {
    expect(isDone({ body: "", closed: true })).toBe(true);
    expect(isDone({ body: "", merged: { number: 1, url: "u" } })).toBe(true);
    expect(isDone({ body: "", closed: false })).toBe(false);
    expect(isDone({ body: "" })).toBe(false);
  });
});

describe("prerequisiteState", () => {
  it("まだ開いている番号と、リポジトリに無い番号を分ける。自分自身は無視し、Issue ごとに1回だけ問い合わせる", async () => {
    const queried: number[] = [];
    const statuses: Record<number, WorkIssueStatus> = {
      5: { body: "", closed: true },
      6: { body: "" },
      10: { body: "" },
    };
    const statusOf = cachedStatusOf({
      workIssueStatus: (n) => {
        queried.push(n);
        return Promise.resolve(statuses[n]);
      },
    });
    expect(await prerequisiteState(10, body([10, 5, 6, 99]), statusOf)).toEqual(
      { open: [6], missing: [99] },
    );
    expect(await prerequisiteState(11, body([5, 6, 99]), statusOf)).toEqual({
      open: [6],
      missing: [99],
    });
    expect(queried).toEqual([5, 6, 99]);
  });
});

describe("completedMessage", () => {
  it("要件の要約と PR の一覧を書く", () => {
    const text = completedMessage("検索をつけたい", [
      { issue: 5, number: 11, url: "https://x/pull/11" },
    ]);
    expect(text).toContain("検索をつけたい");
    expect(text).toContain("#11");
    expect(text).toContain("https://x/pull/11");
  });
});

describe("checkProgress", () => {
  it("先に済ませる Issue がすべてマージされた、列が未設定の Issue だけを Ready に移す", async () => {
    const t = await setup(
      {
        5: {
          body: body([]),
          merged: { number: 11, url: "u11" },
          column: "Done",
        },
        6: { body: body([5]) },
        7: { body: body([5, 6]) },
        8: { body: body([5]), column: "Blocked" },
        9: { body: body([20]) },
        20: { body: body([]), merged: { number: 21, url: "u21" } },
      },
      [5, 6, 7, 8, 9],
    );
    expect(await checkProgress(t.deps, t.requirement)).toEqual({
      status: "started",
    });
    expect(t.moved).toEqual([
      [6, "Ready"],
      [9, "Ready"],
    ]);
  });

  it("動かす Issue が無ければ waiting", async () => {
    const t = await setup(
      { 5: { body: body([]), column: "Testing" }, 6: { body: body([5]) } },
      [5, 6],
    );
    expect(await checkProgress(t.deps, t.requirement)).toEqual({
      status: "waiting",
    });
    expect(t.moved).toEqual([]);
  });

  it("すべてマージされたら、お知らせチャンネルに完了を書いて要件を完了にする", async () => {
    const t = await setup(
      {
        5: { body: body([]), merged: { number: 11, url: "u11" } },
        6: { body: body([5]), merged: { number: 12, url: "u12" } },
      },
      [5, 6],
    );
    expect(await checkProgress(t.deps, t.requirement)).toEqual({
      status: "done",
    });
    const notices = t.chat.messages.get(NOTICES) ?? [];
    expect(notices).toHaveLength(1);
    expect(notices[0]?.text).toContain("検索をつけたい");
    expect(notices[0]?.text).not.toContain("前方一致");
    expect(notices[0]?.text).toContain("#12");
    expect((await t.store.getRequirement(t.requirement.messageId))?.state).toBe(
      "done",
    );
    expect(t.moved).toEqual([]);
  });

  it("先に済ませる Issue がマージされずに閉じていても Ready に移す（完了の知らせは書かない）", async () => {
    const t = await setup(
      {
        5: { body: body([]), closed: true, column: "Done" },
        6: { body: body([5]) },
      },
      [5, 6],
    );
    expect(await checkProgress(t.deps, t.requirement)).toEqual({
      status: "started",
    });
    expect(t.moved).toEqual([[6, "Ready"]]);
    expect(t.chat.messages.get(NOTICES) ?? []).toEqual([]);
  });

  it("作業中でない要件や、作業用 Issue が無い要件は何もしない", async () => {
    const t = await setup({}, []);
    expect(await checkProgress(t.deps, t.requirement)).toEqual({
      status: "skipped",
    });
    const done = { ...t.requirement, state: "done" as const, workIssues: [5] };
    expect(await checkProgress(t.deps, done)).toEqual({ status: "skipped" });
  });
});

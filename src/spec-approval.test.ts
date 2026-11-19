import { describe, expect, it } from "vitest";
import { MemoryChat } from "./chat.js";
import { parseConfig } from "./config.js";
import type { CiResult } from "./github.js";
import {
  checkSpecApproval,
  ciFailedHead,
  ciFailedMessage,
  isApproved,
  latestSummary,
  type SpecApprovalBoard,
} from "./spec-approval.js";
import { summaryMessage } from "./specifier.js";
import { MemoryStore } from "./store.js";

const ALLOWED = "u1";
const OTHER = "u2";
const PR = { number: 7, url: "https://github.com/me/app/pull/7" };

const config = parseConfig(
  [
    "github: { repo: me/app, project: 3, notify: me }",
    "protected: [e2e/**]",
    "commands: { setup: s, test: t, acceptance: a, typecheck: y, build: b }",
    "chat:",
    "  type: discord",
    '  channels: { requirements: "1", questions: "2", notices: "3" }',
    `  allowed_users: ["${ALLOWED}"]`,
  ].join("\n"),
);

const FAILURE: CiResult = {
  state: "failure",
  checks: [
    { name: "check", bucket: "fail", link: "https://example.com/job/1" },
    { name: "lint", bucket: "pass", link: "" },
  ],
  failureLog: "## check\nエラー",
};

class Board implements SpecApprovalBoard {
  ci: CiResult = { state: "success", checks: [] };
  readonly merged: number[] = [];
  ciStatus(): Promise<CiResult> {
    return Promise.resolve(this.ci);
  }
  mergePullRequest(pr: number): Promise<void> {
    this.merged.push(pr);
    return Promise.resolve();
  }
}

async function setup() {
  const chat = new MemoryChat();
  const store = new MemoryStore(() => new Date("2026-11-19T00:00:00.000Z"));
  const head = await chat.post("2", "要件を受け取りました");
  const threadId = await chat.createThread("2", head, "要件");
  await chat.post(threadId, "> 要件");
  const first = await chat.post(threadId, summaryMessage("要約1", PR, false));
  const latest = await chat.post(threadId, summaryMessage("要約2", PR, true));
  const record = await store.updateRequirement("100", {
    threadId,
    state: "awaiting_approval",
    specPr: PR.number,
  });
  const board = new Board();
  const logs: string[] = [];
  const log = (t: string) => {
    logs.push(t);
  };
  const deps = { config, chat, store, board, log };
  return { chat, store, board, deps, record, threadId, first, latest, logs };
}

describe("isApproved", () => {
  const allowed = new Set([ALLOWED]);
  it("許可した人の ✅ だけを承認とする", () => {
    expect(
      isApproved([{ emoji: "✅", userIds: [OTHER, ALLOWED] }], allowed),
    ).toBe(true);
    expect(isApproved([{ emoji: "✅", userIds: [OTHER] }], allowed)).toBe(
      false,
    );
    expect(
      isApproved(
        [
          { emoji: "👍", userIds: [ALLOWED] },
          { emoji: "✔️", userIds: [ALLOWED] },
          { emoji: "white_check_mark", userIds: [ALLOWED] },
        ],
        allowed,
      ),
    ).toBe(false);
  });
});

describe("latestSummary", () => {
  it("Bot が書いた最後の要約を返し、人の書き込みや他の Bot の書き込みは見ない", () => {
    const thread = [
      { id: "1", authorId: "bot", text: summaryMessage("a", PR, false) },
      { id: "2", authorId: "bot", text: summaryMessage("b", PR, true) },
      { id: "3", authorId: "bot", text: ciFailedHead(7) },
      { id: "4", authorId: ALLOWED, text: summaryMessage("c", PR, true) },
    ];
    expect(latestSummary(thread, "bot")?.id).toBe("2");
    expect(latestSummary([], "bot")).toBeUndefined();
  });
});

describe("ciFailedMessage", () => {
  it("失敗したチェックとログの要点を書く", () => {
    const text = ciFailedMessage(7, FAILURE);
    expect(text.startsWith(ciFailedHead(7))).toBe(true);
    expect(text).toContain("- check（https://example.com/job/1）");
    expect(text).not.toContain("- lint");
    expect(text).toContain("エラー");
  });

  it("長いログは末尾だけを書く", () => {
    const text = ciFailedMessage(7, {
      ...FAILURE,
      failureLog: "x".repeat(5000),
    });
    expect(text.length).toBeLessThan(2000);
  });
});

describe("checkSpecApproval", () => {
  it("承認が無ければ何もしない", async () => {
    const s = await setup();
    expect(await checkSpecApproval(s.deps, s.record)).toEqual({
      status: "waiting",
    });
    expect(s.board.merged).toEqual([]);
  });

  it("古い要約への ✅ は承認にしない", async () => {
    const s = await setup();
    s.chat.addReaction(s.threadId, s.first, "✅", ALLOWED);
    expect((await checkSpecApproval(s.deps, s.record)).status).toBe("waiting");
  });

  it("承認待ちでない要件や、仕様の PR が無い要件は確かめない", async () => {
    const s = await setup();
    s.chat.addReaction(s.threadId, s.latest, "✅", ALLOWED);
    expect(
      (await checkSpecApproval(s.deps, { ...s.record, state: "working" }))
        .status,
    ).toBe("skipped");
    const noPr = await s.store.updateRequirement("100", { specPr: undefined });
    expect((await checkSpecApproval(s.deps, noPr)).status).toBe("skipped");
    expect(s.board.merged).toEqual([]);
  });

  it("CI が実行中なら書き込まずに待つ", async () => {
    const s = await setup();
    s.chat.addReaction(s.threadId, s.latest, "✅", ALLOWED);
    s.board.ci = { state: "pending", checks: [] };
    const before = (await s.chat.readMessages(s.threadId)).length;
    expect((await checkSpecApproval(s.deps, s.record)).status).toBe(
      "ci_pending",
    );
    expect(await s.chat.readMessages(s.threadId)).toHaveLength(before);
    expect(s.board.merged).toEqual([]);
  });

  it("CI の失敗は同じ要約に対して1回だけ書く", async () => {
    const s = await setup();
    s.chat.addReaction(s.threadId, s.latest, "✅", ALLOWED);
    s.board.ci = FAILURE;
    const before = (await s.chat.readMessages(s.threadId)).length;
    expect((await checkSpecApproval(s.deps, s.record)).status).toBe(
      "ci_failed",
    );
    expect((await checkSpecApproval(s.deps, s.record)).status).toBe(
      "ci_failed",
    );
    const after = await s.chat.readMessages(s.threadId);
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)?.text.startsWith(ciFailedHead(PR.number))).toBe(true);
    expect(s.board.merged).toEqual([]);
    expect((await s.store.getRequirement("100"))?.state).toBe(
      "awaiting_approval",
    );
  });

  it("承認されて CI が通っていれば、マージしてスレッドを閉じ、要件を作業中にする", async () => {
    const s = await setup();
    s.chat.addReaction(s.threadId, s.latest, "✅", ALLOWED);
    expect((await checkSpecApproval(s.deps, s.record)).status).toBe("approved");
    expect(s.board.merged).toEqual([PR.number]);
    expect(s.chat.threads.get(s.threadId)).toEqual(
      expect.objectContaining({ archived: true, locked: true }),
    );
    const record = await s.store.getRequirement("100");
    expect(record?.state).toBe("working");
    expect(record?.specPr).toBe(PR.number);
  });
});

/**
 * Issue #43: 仕様の承認の受け入れテスト
 *
 * 決めた名前（実装役はこれに合わせて作る）:
 * - 新しいモジュール `src/spec-approval.ts`
 *   ```ts
 *   export interface SpecApprovalBoard {
 *     // 仕様の PR の CI の結果（github.ts の GitHub.ciStatus と同じ形）
 *     ciStatus(pr: number): Promise<CiResult>;
 *     // 仕様の PR をマージする（Issue に紐づかないので列は動かさない）
 *     mergePullRequest(pr: number): Promise<void>;
 *   }
 *
 *   export interface SpecApprovalDeps {
 *     config: Config;   // config.chat がある前提（allowed_users が許可した人）
 *     chat: Chat;
 *     store: Store;
 *     board: SpecApprovalBoard;
 *     log(text: string): void;
 *   }
 *
 *   // 承認待ちの要件1件を1回分確かめる（承認が無ければ何もしない）
 *   export function checkSpecApproval(deps: SpecApprovalDeps, requirement: RequirementRecord):
 *     Promise<{ status: string }>;
 *   ```
 * - 承認の判定（LLM を使わずプログラムで行う）
 *   - 承認は「最新の要約」（仕様化役が最後に書いた要約の書き込み）に付いた ✅ のリアクション
 *   - ✅ を付けた人が config.chat.allowed_users にいるときだけ承認として扱う
 *   - 古い要約への ✅、✅ 以外の絵文字は承認として扱わない
 *   - 承認されたら仕様の PR の CI を確かめ、合格ならマージし、スレッドをアーカイブしてロックし、
 *     要件の状態を "working"（分解に進めた状態）にする
 *   - CI が合格していなければマージせず、理由（CI が通っていないこと）をスレッドに書いて待つ。
 *     承認は取り消さず、CI が合格すれば次の確認でマージする
 * - `src/loop.ts` の `LoopDeps` に、省略できる項目を足す
 *   ```ts
 *   approveSpec?: (requirement: RequirementRecord) => Promise<StepResult>;
 *   ```
 *   `tick` は、スレッドがあり状態が awaiting_approval の要件ごとに `approveSpec` を呼ぶ
 *   （失敗しても Issue の処理は止めない）
 *
 * Given の「要約」は #42 の仕様化役（runSpecifier）を偽の役で動かして作る。
 * 窓口は MemoryChat、GitHub と git と claude は偽物、記録は MemoryStore を使う。
 */
import { describe, expect, it } from "vitest";

import { MemoryChat } from "../chat.js";
import type { RoleResult, RoleRun } from "../claude.js";
import { type Config, parseConfig } from "../config.js";
import type { CiResult } from "../github.js";
import { type LoopDeps, newLoopState, tick } from "../loop.js";
import {
  checkSpecApproval,
  type SpecApprovalBoard,
  type SpecApprovalDeps,
} from "../spec-approval.js";
import {
  runSpecifier,
  type SpecifierDeps,
  type SpecifierOutput,
  type specifierOutputSchema,
} from "../specifier.js";
import { MemoryStore, type Store } from "../store.js";

// ---- seed ----

const REPO = "pkshimizu/wordcards";
const REQUIREMENTS = "1000000000000000001";
const QUESTIONS = "1000000000000000002";
const NOTICES = "1000000000000000003";
const ALLOWED = "2000000000000000001";
const STRANGER = "2000000000000000099";
const BOT = "3000000000000000001";

const APPROVE = "✅";

function makeConfig(): Config {
  return parseConfig(
    [
      `github: { repo: ${REPO}, project: 3, notify: someone }`,
      "protected: [src/acceptance/**]",
      "commands: { setup: s, test: t, acceptance: a, typecheck: c, build: b }",
      "chat:",
      "  type: discord",
      "  channels:",
      `    requirements: "${REQUIREMENTS}"`,
      `    questions: "${QUESTIONS}"`,
      `    notices: "${NOTICES}"`,
      "  allowed_users:",
      `    - "${ALLOWED}"`,
    ].join("\n"),
  );
}

const REQUIREMENT_TEXT = "単語帳に検索をつけたい\n前方一致で探せるように";
const SPEC_FILE = "docs/specs/word-search.md";
const KNOWLEDGE_FILE = ".conductor/knowledge/search-policy.md";

const clock = () => new Date("2026-11-19T00:00:00.000Z");

/** 受け取り済みの要件（#41 の受け取りが済んだ状態）を作る */
async function seedRequirement(chat: MemoryChat, store: Store) {
  const posted = chat.addMessage(REQUIREMENTS, {
    authorId: ALLOWED,
    text: REQUIREMENT_TEXT,
  });
  await store.setReadPosition(REQUIREMENTS, posted.id);
  const head = await chat.post(
    QUESTIONS,
    `要件を受け取りました（<@${ALLOWED}>）: 単語帳に検索をつけたい`,
  );
  const threadId = await chat.createThread(
    QUESTIONS,
    head,
    "単語帳に検索をつけたい",
  );
  await chat.post(
    threadId,
    REQUIREMENT_TEXT.split("\n")
      .map((l) => `> ${l}`)
      .join("\n"),
  );
  await store.updateRequirement(posted.id, { threadId });
  return { messageId: posted.id, threadId };
}

// ---- 偽物 ----

/** 作業ツリーとコミット・push を覚えるだけの git */
class FakeGit {
  readonly files = new Set<string>();
  readonly commits: { branch: string; paths: string[] }[] = [];
  private branch = "main";

  startBranch(branch: string): Promise<void> {
    this.branch = branch;
    this.files.clear();
    return Promise.resolve();
  }
  changedFiles(): Promise<string[]> {
    return Promise.resolve([...this.files].sort());
  }
  discard(paths: readonly string[]): Promise<void> {
    for (const p of paths) this.files.delete(p);
    return Promise.resolve();
  }
  discardAll(): Promise<void> {
    this.files.clear();
    return Promise.resolve();
  }
  commit(paths: readonly string[]): Promise<string> {
    this.commits.push({ branch: this.branch, paths: [...paths] });
    for (const p of paths) this.files.delete(p);
    return Promise.resolve(`commit-${this.commits.length}`);
  }
  push(): Promise<void> {
    return Promise.resolve();
  }
}

/** PR・CI・マージを覚えるだけの GitHub */
class FakeBoard implements SpecApprovalBoard {
  readonly created: { number: number; url: string; head: string }[] = [];
  /** PR 番号 → CI の結果。無ければ合格 */
  readonly ci = new Map<number, CiResult>();
  readonly ciChecks: number[] = [];
  readonly merged: number[] = [];

  findPullRequest(head: string) {
    const pr = this.created.find((p) => p.head === head);
    return Promise.resolve(pr && { number: pr.number, url: pr.url });
  }
  createPullRequest(input: { head: string; title: string; body: string }) {
    const number = 101 + this.created.length;
    const url = `https://github.com/${REPO}/pull/${number}`;
    this.created.push({ number, url, head: input.head });
    return Promise.resolve({ number, url });
  }
  ciStatus(pr: number): Promise<CiResult> {
    this.ciChecks.push(pr);
    return Promise.resolve(
      this.ci.get(pr) ?? {
        state: "success",
        checks: [{ name: "check", bucket: "pass", link: "" }],
      },
    );
  }
  mergePullRequest(pr: number): Promise<void> {
    this.merged.push(pr);
    return Promise.resolve();
  }
}

const CI_FAILURE: CiResult = {
  state: "failure",
  checks: [
    {
      name: "check",
      bucket: "fail",
      link: `https://github.com/${REPO}/actions/runs/1/job/2`,
    },
  ],
  failureLog: "## check\nmarkdownlint: docs/specs/word-search.md:3 MD001",
};

type SpecRun = RoleRun<typeof specifierOutputSchema>;
type Reply = () => SpecifierOutput;

/** 決めた順に答える偽の仕様化役 */
function fakeRole() {
  const replies: Reply[] = [];
  const runs: SpecRun[] = [];
  const run = (r: SpecRun): Promise<RoleResult<SpecifierOutput>> => {
    runs.push(r);
    const reply = replies.shift();
    if (reply === undefined)
      throw new Error("仕様化役の答えを用意していません");
    return Promise.resolve({
      output: reply(),
      denials: [],
      costUsd: 0,
      turns: 1,
      sessionId: `session-${runs.length}`,
    });
  };
  return { run, runs, replies };
}

/** 仕様を書く役（作業ツリーにファイルを置く） */
function write(git: FakeGit, files: string[], summary: string): Reply {
  return () => {
    for (const f of files) git.files.add(f);
    return { verdict: "approve", summary, findings: [], questions: [] };
  };
}

/**
 * 常駐ループの部品。Issue の列は空で、Issue の各役は呼ばれない。
 * 仕様化役（specify）と仕様の承認（approveSpec）をつなぐ
 */
function setup(chat: MemoryChat, store: Store) {
  const config = makeConfig();
  const git = new FakeGit();
  const board = new FakeBoard();
  const role = fakeRole();
  const specifierDeps: SpecifierDeps = {
    config,
    repoDir: "/repo",
    chat,
    store,
    git,
    board,
    run: role.run,
    instructions: "",
    log: () => {},
  };
  const approvalDeps: SpecApprovalDeps = {
    config,
    chat,
    store,
    board,
    log: () => {},
  };
  const never = () => Promise.reject(new Error("Issue の処理は呼ばれない"));
  const deps: LoopDeps = {
    config,
    store,
    chat,
    board: {
      issuesByColumn: () => Promise.resolve(new Map()),
      moveIssue: () => Promise.resolve(),
      comment: () => Promise.resolve(),
      hasConflict: () => Promise.resolve(false),
    },
    pickUp: never,
    test: never,
    implement: never,
    checkCi: never,
    review: never,
    merge: never,
    syncMain: never,
    specify: (requirement) => runSpecifier(specifierDeps, requirement),
    approveSpec: (requirement) => checkSpecApproval(approvalDeps, requirement),
    log: () => {},
  };
  return { deps, git, board, role };
}

/** スレッドに Bot が書いた書き込み */
function botMessages(chat: MemoryChat, threadId: string) {
  return (chat.messages.get(threadId) ?? []).filter(
    (m) => m.authorId === chat.botId,
  );
}

/** スレッドにある要約（PR の URL を含む Bot の書き込み）の ID。古い順 */
function summaryIds(chat: MemoryChat, threadId: string, prUrl: string) {
  return botMessages(chat, threadId)
    .filter((m) => m.text.includes(prUrl))
    .map((m) => m.id);
}

/**
 * 承認待ちの要件を作る（仕様化役が仕様の PR を作り、スレッドに要約を書いた状態）。
 * fixes を渡すと、その数だけ修正の依頼をして要約を書き直させる
 */
async function seedAwaitingApproval(options: { fixes?: number } = {}) {
  const chat = new MemoryChat(BOT);
  const store = new MemoryStore(clock);
  const { messageId, threadId } = await seedRequirement(chat, store);
  const ctx = setup(chat, store);
  const { deps, git, board, role } = ctx;

  // 仕様化役がまず疑問を聞き、人が「全部おすすめでよい」と返して仕様の PR ができる
  role.replies.push(() => ({
    verdict: "objection",
    summary: "疑問があります",
    findings: [],
    questions: [
      {
        question: "検索は前方一致だけでよいですか",
        recommendation: "前方一致だけにする",
      },
    ],
  }));
  role.replies.push(
    write(git, [SPEC_FILE, KNOWLEDGE_FILE], "前方一致の検索の仕様を書きました"),
  );
  await tick(deps, newLoopState());
  chat.addMessage(threadId, { authorId: ALLOWED, text: "全部おすすめでよい" });
  await tick(deps, newLoopState());

  // 修正の依頼と要約の書き直し
  for (let i = 0; i < (options.fixes ?? 0); i++) {
    role.replies.push(
      write(git, [SPEC_FILE], `検索の仕様を直しました（${i + 1} 回目）`),
    );
    chat.addMessage(threadId, {
      authorId: ALLOWED,
      text: `直してください（${i + 1} 回目）`,
    });
    await tick(deps, newLoopState());
  }

  expect(board.created).toHaveLength(1);
  const pr = board.created[0]!;
  const record = await store.getRequirement(messageId);
  expect(record?.state).toBe("awaiting_approval");
  expect(record?.specPr).toBe(pr.number);
  const summaries = summaryIds(chat, threadId, pr.url);
  expect(summaries).toHaveLength(1 + (options.fixes ?? 0));
  return {
    ...ctx,
    chat,
    store,
    messageId,
    threadId,
    pr,
    /** 最新の要約 */
    latestSummary: summaries.at(-1)!,
    /** 古い要約（書き直す前のもの） */
    oldSummaries: summaries.slice(0, -1),
  };
}

/** 承認として扱われていない（マージせず、スレッドもそのまま、要件は承認待ちのまま） */
async function expectNotApproved(
  s: Awaited<ReturnType<typeof seedAwaitingApproval>>,
) {
  expect(s.board.merged).toEqual([]);
  const thread = s.chat.threads.get(s.threadId)!;
  expect(thread.archived).toBe(false);
  expect(thread.locked).toBe(false);
  const record = await s.store.getRequirement(s.messageId);
  expect(record?.state).toBe("awaiting_approval");
  expect(record?.specPr).toBe(s.pr.number);
}

describe("Issue #43: 仕様の承認", () => {
  it("AC1: 最新の要約に許可した人が ✅ を付けると、次の確認で仕様の PR の CI の合格を確かめてマージし、スレッドをアーカイブしてロックし、要件を分解に進める", async () => {
    // Given: 最新の要約に、許可した人が ✅ を付けた（要約は1回書き直してある）
    const s = await seedAwaitingApproval({ fixes: 1 });
    s.chat.addReaction(s.threadId, s.latestSummary, APPROVE, ALLOWED);
    const runsBefore = s.role.runs.length;

    // When: 次の確認
    await tick(s.deps, newLoopState());

    // Then: 仕様の PR の CI を確かめてからマージする
    expect(s.board.ciChecks).toContain(s.pr.number);
    expect(s.board.merged).toEqual([s.pr.number]);

    // Then: スレッドをアーカイブしてロックする
    const thread = s.chat.threads.get(s.threadId)!;
    expect(thread.archived).toBe(true);
    expect(thread.locked).toBe(true);

    // Then: 要件を分解に進める（承認待ちを抜けて作業中にする）
    const record = await s.store.getRequirement(s.messageId);
    expect(record?.state).toBe("working");
    expect(record?.specPr).toBe(s.pr.number);

    // 承認は LLM に任せない（仕様化役は起動しない）
    expect(s.role.runs).toHaveLength(runsBefore);

    // もう一度確認しても、二度マージしない
    await tick(s.deps, newLoopState());
    expect(s.board.merged).toEqual([s.pr.number]);
  });

  it("AC2: ✅ が付いたが仕様の PR の CI が失敗していると、次の確認でマージせず、理由をスレッドに書いて待つ", async () => {
    // Given: ✅ が付いたが、仕様の PR の CI が失敗している
    const s = await seedAwaitingApproval();
    s.chat.addReaction(s.threadId, s.latestSummary, APPROVE, ALLOWED);
    s.board.ci.set(s.pr.number, CI_FAILURE);
    const before = botMessages(s.chat, s.threadId).length;

    // When: 次の確認
    await tick(s.deps, newLoopState());

    // Then: CI を確かめたうえで、マージしない
    expect(s.board.ciChecks).toContain(s.pr.number);
    await expectNotApproved(s);

    // Then: 理由（CI が通っていないこと）をスレッドに書く
    const added = botMessages(s.chat, s.threadId).slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]!.text).toContain("CI");
    expect(added[0]!.text).toMatch(/失敗|通っていない|通らない/);

    // Then: 待つ（CI が合格すれば、次の確認でマージして分解に進める）
    s.board.ci.delete(s.pr.number);
    await tick(s.deps, newLoopState());
    expect(s.board.merged).toEqual([s.pr.number]);
    expect((await s.store.getRequirement(s.messageId))?.state).toBe("working");
  });

  it("AC3: 許可していない人の ✅、または古い要約への ✅ は、次の確認で承認として扱わない", async () => {
    // Given: 最新の要約に許可していない人の ✅、古い要約に許可した人の ✅
    const s = await seedAwaitingApproval({ fixes: 1 });
    expect(s.oldSummaries).toHaveLength(1);
    s.chat.addReaction(s.threadId, s.latestSummary, APPROVE, STRANGER);
    s.chat.addReaction(s.threadId, s.oldSummaries[0]!, APPROVE, ALLOWED);

    // When: 次の確認
    await tick(s.deps, newLoopState());

    // Then: 承認として扱わない
    await expectNotApproved(s);
  });

  it("AC4: ✅ 以外の絵文字は、次の確認で承認として扱わない", async () => {
    // Given: 最新の要約に、許可した人が ✅ 以外の絵文字を付けた
    const s = await seedAwaitingApproval();
    for (const emoji of ["👍", "✔️", "☑️", "🆗", "white_check_mark"]) {
      s.chat.addReaction(s.threadId, s.latestSummary, emoji, ALLOWED);
    }

    // When: 次の確認
    await tick(s.deps, newLoopState());

    // Then: 承認として扱わない
    await expectNotApproved(s);
  });
});

/**
 * Issue #46: 止まったときのスレッドの受け入れテスト
 *
 * 決めたこと（実装役はこれに合わせて作る）:
 * - 新しい名前は使わない。すでにある `tick`（src/loop.ts）の振る舞いとして確かめる
 *   - `LoopDeps` に「必ず渡す」項目は足さない（足すなら省略できる項目にする）。
 *     スレッドは `deps.chat` と `config.chat` があるときに作る
 *   - 記録（どの Issue のスレッドか・止まった理由・読んだ位置）は `Store` に持たせてよい（テストは MemoryStore を使う）
 * - 振る舞い
 *   - chat を設定しているとき、Issue が Blocked になったら（続けて MAX_FAILURES 回失敗したときなど）、
 *     Issue でのメンション（`comment(..., { mention: true })`）はしない。
 *     代わりに、次の確認までに、質問チャンネル（config.chat.channels.questions）に新しいスレッドを1つ作り、
 *     止まった理由（最後のエラー）と Issue へのリンク（`https://github.com/<repo>/issues/<番号>`）を書いて、
 *     許可した人（config.chat.allowed_users）に `<@ユーザー ID>` でメンションする。
 *     文はスレッドのもとの投稿とスレッドの中のどちらに書いてもよい。同じ Issue のスレッドを作り直さない
 *   - 許可した人がスレッドに方針を書いたら、次の確認で、方針を Issue にコメントで書き写し（本文に方針の文を含める）、
 *     Issue を config.github.columns.ready に移し、スレッドをアーカイブする
 *   - 人が GitHub で直接 Issue を Ready に戻したら（Blocked の列から出ていたら）、次の確認でスレッドをアーカイブする
 *   - chat を設定していないときは、今までどおり Issue でメンションする（Lv1 と同じ）
 *   - 要件の作業用 Issue の1件が Blocked のとき、それを先に済ませる Issue にしている Issue は Ready に移さず、
 *     関係のない Issue（先に済ませる Issue に含めていないもの）は Ready に移して処理を進める
 *
 * Given の「Blocked」は、偽のテスト役を続けて失敗させ、常駐ループ自身に Blocked へ移させて作る。
 * 窓口は MemoryChat、GitHub・claude は偽物、記録は MemoryStore を使う。
 */
import { describe, expect, it } from "vitest";

import { MemoryChat } from "../chat.js";
import type { RoleResult, RoleRun } from "../claude.js";
import { type Config, parseConfig } from "../config.js";
import {
  type DecomposerBoard,
  type DecomposerOutput,
  type decomposerOutputSchema,
  runDecomposer,
} from "../decomposer.js";
import {
  type LoopDeps,
  type LoopIssue,
  type LoopState,
  MAX_FAILURES,
  newLoopState,
  tick,
} from "../loop.js";
import {
  checkProgress,
  type ProgressBoard,
  type WorkIssueStatus,
} from "../progress.js";
import { approvedMessage } from "../spec-approval.js";
import { summaryMessage } from "../specifier.js";
import { MemoryStore, type RequirementRecord, type Store } from "../store.js";

// ---- seed ----

const REPO = "pkshimizu/wordcards";
const REQUIREMENTS = "1000000000000000001";
const QUESTIONS = "1000000000000000002";
const NOTICES = "1000000000000000003";
const ALLOWED = "2000000000000000001";
const BOT = "3000000000000000001";

const STUCK_ISSUE = 12;
const STUCK_TITLE = "単語の一覧に並べ替えをつける";
const REASON =
  "受け入れテストの実行に失敗しました: 並べ替えのボタンが見つかりません";
const POLICY =
  "並べ替えのボタンは一覧の上ではなく右上のメニューに置く方針にしてください";

const SPEC_PR = 101;
const SPEC_PR_URL = `https://github.com/${REPO}/pull/${SPEC_PR}`;
const SPEC_FILE = "docs/specs/word-search.md";
const REQUIREMENT_TITLE = "単語帳に検索をつけたい";
const REQUIREMENT_TEXT = `${REQUIREMENT_TITLE}\n前方一致で探せるように`;

const clock = () => new Date("2026-11-20T00:00:00.000Z");

const issueUrl = (n: number) => `https://github.com/${REPO}/issues/${n}`;

function makeConfig(options: { chat?: boolean } = {}): Config {
  const lines = [
    `github: { repo: ${REPO}, project: 3, notify: someone }`,
    "protected: [src/acceptance/**]",
    "commands: { setup: s, test: t, acceptance: a, typecheck: c, build: b }",
  ];
  if (options.chat ?? true) {
    lines.push(
      "chat:",
      "  type: discord",
      "  channels:",
      `    requirements: "${REQUIREMENTS}"`,
      `    questions: "${QUESTIONS}"`,
      `    notices: "${NOTICES}"`,
      "  allowed_users:",
      `    - "${ALLOWED}"`,
    );
  }
  return parseConfig(lines.join("\n"));
}

// ---- 偽物 ----

interface FakeIssue {
  number: number;
  url: string;
  title: string;
  body: string;
  column?: string;
  merged?: { number: number; url: string };
}

interface FakeComment {
  issue: number;
  body: string;
  mention: boolean;
}

/** Issue・Project の列・コメントを覚えるだけの GitHub */
class FakeBoard implements DecomposerBoard, ProgressBoard {
  readonly issues: FakeIssue[] = [];
  readonly moved: { issue: number; column: string }[] = [];
  readonly comments: FakeComment[] = [];

  // ---- 分解（#44） ----
  pullRequestFiles(pr: number): Promise<string[]> {
    if (pr !== SPEC_PR) return Promise.reject(new Error(`PR #${pr} は無い`));
    return Promise.resolve([SPEC_FILE]);
  }
  createIssue(input: { title: string; body: string }) {
    const number = 201 + this.issues.filter((i) => i.number > 200).length;
    const url = issueUrl(number);
    this.issues.push({ number, url, ...input });
    return Promise.resolve({ number, url });
  }
  addToProject(): Promise<void> {
    return Promise.resolve();
  }

  // ---- 着手と完了（#45） ----
  workIssueStatus(issue: number): Promise<WorkIssueStatus> {
    const found = this.find(issue);
    return Promise.resolve({
      body: found.body,
      ...(found.column === undefined ? {} : { column: found.column }),
      ...(found.merged === undefined ? {} : { merged: { ...found.merged } }),
    });
  }
  moveIssue(issue: number, column: string): Promise<void> {
    this.moved.push({ issue, column });
    this.find(issue).column = column;
    return Promise.resolve();
  }

  // ---- 常駐ループ ----
  issuesByColumn(): Promise<Map<string, LoopIssue[]>> {
    const map = new Map<string, LoopIssue[]>();
    for (const i of this.issues) {
      if (i.column === undefined) continue;
      const list = map.get(i.column) ?? [];
      list.push({ number: i.number, title: i.title, body: i.body });
      map.set(i.column, list);
    }
    return Promise.resolve(map);
  }
  comment(
    issue: number,
    body: string,
    options: { mention?: boolean } = {},
  ): Promise<void> {
    this.find(issue);
    this.comments.push({ issue, body, mention: options.mention === true });
    return Promise.resolve();
  }
  hasConflict(): Promise<boolean> {
    return Promise.resolve(false);
  }

  // ---- テストの準備用 ----
  /** Issue を置く（人が GitHub で作った Issue） */
  addIssue(issue: Omit<FakeIssue, "url">): FakeIssue {
    const added = { ...issue, url: issueUrl(issue.number) };
    this.issues.push(added);
    return added;
  }
  byTitle(title: string): FakeIssue {
    const found = this.issues.find((i) => i.title === title);
    if (found === undefined) throw new Error(`Issue がありません: ${title}`);
    return found;
  }
  /** 列を置く（記録に残さない。人が GitHub で列を動かしたことにする） */
  place(issue: number, column: string): void {
    this.find(issue).column = column;
  }
  find(issue: number): FakeIssue {
    const found = this.issues.find((i) => i.number === issue);
    if (found === undefined) throw new Error(`Issue #${issue} は無い`);
    return found;
  }
}

/**
 * 常駐ループの部品。入口確認はテスト役の列へ移すだけ。
 * テスト役は failing に入れた Issue なら REASON で失敗し、そうでなければ呼ばれた Issue を覚える。
 * テスト役以外の役は呼ばれない
 */
function setup(
  board: FakeBoard,
  store: Store,
  config: Config,
  options: { chat?: MemoryChat; progress?: boolean } = {},
) {
  const failing = new Set<number>();
  const tested: number[] = [];
  const pickedUp: number[] = [];
  const never = () => Promise.reject(new Error("この役は呼ばれない"));
  const { chat } = options;
  const deps: LoopDeps = {
    config,
    store,
    board,
    pickUp: (issue) => {
      pickedUp.push(issue.number);
      board.place(issue.number, config.github.columns.testing);
      return Promise.resolve({ accepted: true });
    },
    test: (issue) => {
      if (failing.has(issue.number)) return Promise.reject(new Error(REASON));
      tested.push(issue.number);
      return Promise.resolve({ status: "tested" });
    },
    implement: never,
    checkCi: never,
    review: never,
    merge: never,
    syncMain: never,
    log: () => {},
    ...(chat === undefined ? {} : { chat }),
    ...(chat !== undefined && options.progress
      ? {
          progress: (requirement: RequirementRecord) =>
            checkProgress(
              { config, chat, store, board, log: () => {} },
              requirement,
            ),
        }
      : {}),
  };
  return { deps, failing, tested, pickedUp };
}

/** 失敗を続けて、常駐ループ自身に Issue を Blocked へ移させる */
async function blockByFailures(
  deps: LoopDeps,
  state: LoopState,
  board: FakeBoard,
  issue: number,
  config: Config,
) {
  for (let i = 0; i < MAX_FAILURES; i++) {
    await tick(deps, state);
  }
  expect(board.find(issue).column).toBe(config.github.columns.blocked);
}

/** 止まった Issue（#12。Ready から拾われ、テスト役が続けて失敗して Blocked になった） */
async function seedBlocked(options: { chat?: boolean } = {}) {
  const config = makeConfig(options);
  const chat = new MemoryChat(BOT);
  const store = new MemoryStore(clock);
  const board = new FakeBoard();
  board.addIssue({
    number: STUCK_ISSUE,
    title: STUCK_TITLE,
    body: `## 目的\n${STUCK_TITLE}`,
    column: config.github.columns.ready,
  });
  const parts = setup(
    board,
    store,
    config,
    options.chat === false ? {} : { chat },
  );
  parts.failing.add(STUCK_ISSUE);
  const state = newLoopState();
  await blockByFailures(parts.deps, state, board, STUCK_ISSUE, config);
  return { config, chat, store, board, state, ...parts };
}

/** 質問チャンネルに作ったスレッド */
function questionThreads(chat: MemoryChat) {
  return [...chat.threads.entries()]
    .filter(([, t]) => t.channelId === QUESTIONS)
    .map(([id, t]) => ({ id, ...t }));
}

/** チャンネル（またはスレッド）に Bot が書いた文 */
function botTexts(chat: MemoryChat, channelId: string): string[] {
  return (chat.messages.get(channelId) ?? [])
    .filter((m) => m.authorId === chat.botId)
    .map((m) => m.text);
}

/** スレッドのもとの投稿と、スレッドの中に Bot が書いた文をまとめたもの */
function threadText(
  chat: MemoryChat,
  thread: { id: string; messageId: string },
): string {
  const head =
    chat.messages.get(QUESTIONS)?.find((m) => m.id === thread.messageId)
      ?.text ?? "";
  return [head, ...botTexts(chat, thread.id)].join("\n");
}

// ---- 要件の作業用 Issue（AC2） ----

type WorkIssue = DecomposerOutput["issues"][number];

function workIssue(key: string, title: string, dependsOn: string[]): WorkIssue {
  return {
    key,
    title,
    purpose: `${title}。単語を前方一致で探せるようにする`,
    acceptance: [
      "- AC1",
      "  - Given 単語「apple」「apricot」「banana」がある",
      "  - When 「ap」で検索する",
      "  - Then 「apple」「apricot」だけが出る",
    ].join("\n"),
    screens: "なし",
    outOfScope: "部分一致の検索",
    dependsOn,
  };
}

/** index → api の順。csv は index にも api にも関係しない */
const INDEX = workIssue("search-index", "検索の索引を作る", []);
const CSV = workIssue("search-csv", "検索の結果を CSV で書き出す", []);
const API = workIssue("search-api", "検索の API を作る", ["search-index"]);

const quote = (text: string) =>
  text
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");

/** 仕様が承認され、分解で作業用 Issue（列は未設定）を作った要件（#43・#44 の済んだ状態） */
async function seedDecomposed(
  chat: MemoryChat,
  store: Store,
  board: FakeBoard,
  config: Config,
) {
  const posted = chat.addMessage(REQUIREMENTS, {
    authorId: ALLOWED,
    text: REQUIREMENT_TEXT,
  });
  await store.setReadPosition(REQUIREMENTS, posted.id);
  const head = await chat.post(
    QUESTIONS,
    `要件を受け取りました（<@${ALLOWED}>）: ${REQUIREMENT_TITLE}`,
  );
  const threadId = await chat.createThread(QUESTIONS, head, REQUIREMENT_TITLE);
  await chat.post(threadId, quote(REQUIREMENT_TEXT));
  const summary = await chat.post(
    threadId,
    summaryMessage(
      "前方一致の検索の仕様を書きました",
      { url: SPEC_PR_URL },
      false,
    ),
  );
  chat.addReaction(threadId, summary, "✅", ALLOWED);
  const approved = await chat.post(threadId, approvedMessage(SPEC_PR));
  await store.setReadPosition(threadId, approved);
  await chat.archiveThread(threadId);
  await chat.lockThread(threadId);
  await store.updateRequirement(posted.id, {
    threadId,
    specPr: SPEC_PR,
    state: "working",
  });

  const run: (
    r: RoleRun<typeof decomposerOutputSchema>,
  ) => Promise<RoleResult<DecomposerOutput>> = () =>
    Promise.resolve({
      output: {
        verdict: "approve",
        summary: "3 件に分けました",
        findings: [],
        issues: [INDEX, CSV, API],
      },
      denials: [],
      costUsd: 0,
      turns: 1,
      sessionId: "session-decomposer",
    });
  const requirement = await store.getRequirement(posted.id);
  await runDecomposer(
    {
      config,
      repoDir: "/repo",
      chat,
      store,
      board,
      run,
      instructions: "",
      log: () => {},
    },
    requirement!,
  );
  expect((await store.getRequirement(posted.id))?.workIssues).toHaveLength(3);
  const index = board.byTitle(INDEX.title);
  const csv = board.byTitle(CSV.title);
  const api = board.byTitle(API.title);
  // 番号の小さい順に拾われるので、index を先に拾わせる
  expect(index.number).toBeLessThan(csv.number);
  return { messageId: posted.id, index, csv, api };
}

describe("Issue #46: 止まったときのスレッド", () => {
  it("AC1: chat を設定していて Issue が Blocked になると、次の確認で、質問チャンネルに新しいスレッドを作り、止まった理由と Issue へのリンクを書いて、許可した人にメンションする", async () => {
    // Given: chat を設定していて、Issue（#12）が Blocked になった
    const { chat, board, deps, state } = await seedBlocked();
    // Issue でのメンションはしない（スレッドに代える）
    expect(board.comments.filter((c) => c.mention)).toEqual([]);

    // When: 次の確認
    await tick(deps, state);

    // Then: 質問チャンネルに新しいスレッドを1つ作る
    const threads = questionThreads(chat);
    expect(threads).toHaveLength(1);
    const thread = threads[0]!;
    expect(thread.archived).toBe(false);
    const text = threadText(chat, thread);
    // 止まった理由
    expect(text).toContain(REASON);
    // Issue へのリンク
    expect(text).toContain(issueUrl(STUCK_ISSUE));
    // 許可した人へのメンション
    expect(text).toContain(`<@${ALLOWED}>`);

    // Issue は Blocked のまま。Issue でのメンションもしない
    expect(board.find(STUCK_ISSUE).column).toBe("Blocked");
    expect(board.comments.filter((c) => c.mention)).toEqual([]);

    // 次の確認でも、同じ Issue のスレッドを作り直さない
    await tick(deps, state);
    expect(questionThreads(chat)).toHaveLength(1);
  });

  it("AC2: 要件の Issue の1件が Blocked のとき、次の確認で、その Issue の後に進める Issue だけを待たせ、関係のない Issue は進める", async () => {
    const config = makeConfig();
    const chat = new MemoryChat(BOT);
    const store = new MemoryStore(clock);
    const board = new FakeBoard();
    const { messageId, index, csv, api } = await seedDecomposed(
      chat,
      store,
      board,
      config,
    );
    const { deps, failing, tested } = setup(board, store, config, {
      chat,
      progress: true,
    });

    // Given: 要件の Issue の1件（index）が Blocked（拾われてテスト役が続けて失敗した）
    failing.add(index.number);
    const state = newLoopState();
    await blockByFailures(deps, state, board, index.number, config);
    expect(csv.column).toBe("Ready");
    expect(tested).toEqual([]);

    // When: 次の確認
    await tick(deps, state);

    // Then: 関係のない Issue（csv）は進める
    expect(tested).toEqual([csv.number]);
    // Then: Blocked の Issue の後に進める Issue（api）は待たせる
    expect(api.column).toBeUndefined();
    expect(board.moved.filter((m) => m.issue === api.number)).toEqual([]);
    expect(index.column).toBe("Blocked");
    expect((await store.getRequirement(messageId))?.state).toBe("working");

    // 次の確認でも、api は待たせたまま
    await tick(deps, state);
    expect(api.column).toBeUndefined();
  });

  it("AC3: 人がスレッドに方針を書くと、次の確認で、方針を Issue にコメントで書き写し、Ready に戻し、スレッドをアーカイブする", async () => {
    const { chat, board, deps, state, failing } = await seedBlocked();
    await tick(deps, state);
    const [thread] = questionThreads(chat);
    expect(thread).toBeDefined();
    // 人が書くまでは Issue を動かさない
    await tick(deps, state);
    expect(board.find(STUCK_ISSUE).column).toBe("Blocked");
    expect(thread!.archived).toBe(false);
    const movedBefore = board.moved.length;
    const commentsBefore = board.comments.length;

    // Given: 人がスレッドに方針を書いた
    chat.addMessage(thread!.id, { authorId: ALLOWED, text: POLICY });
    failing.delete(STUCK_ISSUE); // 方針どおりに直れば、次は通る

    // When: 次の確認
    await tick(deps, state);

    // Then: 方針を Issue にコメントで書き写す
    const added = board.comments.slice(commentsBefore);
    expect(
      added.some((c) => c.issue === STUCK_ISSUE && c.body.includes(POLICY)),
    ).toBe(true);
    // Then: Ready に戻す
    expect(board.moved.slice(movedBefore)).toContainEqual({
      issue: STUCK_ISSUE,
      column: "Ready",
    });
    // Then: スレッドをアーカイブする
    expect(chat.threads.get(thread!.id)?.archived).toBe(true);

    // 次の確認で、同じ方針を書き写し直さず、スレッドも作り直さない
    await tick(deps, state);
    expect(
      board.comments.filter(
        (c) => c.issue === STUCK_ISSUE && c.body.includes(POLICY),
      ),
    ).toHaveLength(1);
    expect(questionThreads(chat)).toHaveLength(1);
  });

  it("AC4: 人が GitHub で直接 Issue を Ready に戻すと、次の確認で、そのスレッドをアーカイブする", async () => {
    const { chat, board, deps, state, failing } = await seedBlocked();
    await tick(deps, state);
    const [thread] = questionThreads(chat);
    expect(thread).toBeDefined();
    expect(thread!.archived).toBe(false);

    // Given: 人が GitHub で直接 Issue を Ready に戻した
    board.place(STUCK_ISSUE, "Ready");
    failing.delete(STUCK_ISSUE);

    // When: 次の確認
    await tick(deps, state);

    // Then: そのスレッドをアーカイブする
    expect(chat.threads.get(thread!.id)?.archived).toBe(true);

    // 次の確認で、スレッドを作り直さない
    await tick(deps, state);
    expect(questionThreads(chat)).toHaveLength(1);
  });

  it("AC5: chat を設定していないとき、Issue が Blocked になると、Lv1 と同じく Issue でメンションする", async () => {
    // Given: chat を設定していない
    // When: Issue が Blocked になる（テスト役が続けて失敗する）
    const { board } = await seedBlocked({ chat: false });

    // Then: Issue でメンションする（止まった理由を書く）
    const mentions = board.comments.filter((c) => c.mention);
    expect(mentions).toHaveLength(1);
    expect(mentions[0]!.issue).toBe(STUCK_ISSUE);
    expect(mentions[0]!.body).toContain(REASON);
    expect(board.moved).toContainEqual({
      issue: STUCK_ISSUE,
      column: "Blocked",
    });
  });
});

/**
 * Issue #86: 要件のスレッドを要件チャンネルの投稿から作り、PR のタイトルに要件の1行目を使う
 *
 * 決めたこと（実装役はこれに合わせて作る）:
 * - 新しい名前は使わない。すでにある `tick`（src/loop.ts）・`runSpecifier`（src/specifier.ts）・
 *   `checkSpecApproval`（src/spec-approval.ts）・`runDecomposer`（src/decomposer.ts）の振る舞いとして確かめる
 * - 要件を受け取ると、要件チャンネルのその投稿（記録の messageId）からスレッドを作る。
 *   質問チャンネルには何も書かず、要件の本文の引用も書かない
 * - 要件の本文は、要件チャンネルの元の投稿から読む（Chat に1件読む操作を足すなら MemoryChat にも足す）
 * - 止まった Issue のスレッドは、今までどおり質問チャンネルに作る
 *
 * Discord は、投稿からスレッドを作るとスレッドの先頭に中身が空の「スレッドの元の書き込み」を
 * Bot の書き込みとして入れる。これを再現するため、MemoryChat を少しだけ変えた DiscordLikeChat を使う。
 * GitHub・git・claude は偽物、記録は MemoryStore を使う。
 */
import { describe, expect, it } from "vitest";
import type { z } from "zod";

import { MemoryChat } from "../chat.js";
import type { RoleResult, RoleRun } from "../claude.js";
import { type Config, parseConfig } from "../config.js";
import {
  type DecomposerBoard,
  type DecomposerOutput,
  type decomposerOutputSchema,
  runDecomposer,
} from "../decomposer.js";
import type { CiResult } from "../github.js";
import {
  type LoopDeps,
  type LoopIssue,
  MAX_FAILURES,
  newLoopState,
  tick,
} from "../loop.js";
import { checkSpecApproval, type SpecApprovalBoard } from "../spec-approval.js";
import {
  questionsMessage,
  runSpecifier,
  type SpecifierBoard,
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
const BOT = "3000000000000000001";

const REQUIREMENT_TITLE = "単語帳に検索をつけたい";
const REQUIREMENT_TEXT = `${REQUIREMENT_TITLE}\n前方一致で探せるように\n大文字と小文字は区別しない`;
/** PR #85 で「仕様: 要件」になった要件の1行目 */
const MARKDOWN_TITLE =
  "markdownファイルを表示している箇所は、markdown viewerを使用して読みやすくしたい";
const MARKDOWN_TEXT = `${MARKDOWN_TITLE}\n仕様の画面と Issue の画面の両方で使う`;

const SPEC_FILE = "docs/specs/word-search.md";
const KNOWLEDGE_FILE = ".conductor/knowledge/search-policy.md";
const APPROVE = "✅";

const clock = () => new Date("2026-11-21T00:00:00.000Z");

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

/**
 * Discord のように、スレッドを作るとスレッドの先頭に中身が空の「スレッドの元の書き込み」が
 * Bot の書き込みとして入る窓口
 */
class DiscordLikeChat extends MemoryChat {
  override async createThread(
    channelId: string,
    messageId: string,
    name: string,
  ): Promise<string> {
    const id = await super.createThread(channelId, messageId, name);
    this.addMessage(id, { authorId: this.botId, text: "" });
    return id;
  }
}

/** 許可した人が要件チャンネルに要件を投稿する */
function postRequirement(chat: MemoryChat, text: string) {
  return chat.addMessage(REQUIREMENTS, { authorId: ALLOWED, text });
}

/**
 * この変更より前に受け取った要件（スレッドが質問チャンネルにある）。
 * 質問チャンネルの「要件を受け取りました」からスレッドを作り、引用を書き、仕様化役が疑問を1つ聞き、
 * 人が「全部おすすめでよい」と返した状態
 */
async function seedLegacyRequirement(chat: MemoryChat, store: Store) {
  const posted = postRequirement(chat, REQUIREMENT_TEXT);
  await store.setReadPosition(REQUIREMENTS, posted.id);
  const head = await chat.post(
    QUESTIONS,
    `要件を受け取りました（<@${ALLOWED}>）: ${REQUIREMENT_TITLE}`,
  );
  const threadId = await chat.createThread(QUESTIONS, head, REQUIREMENT_TITLE);
  await chat.post(
    threadId,
    REQUIREMENT_TEXT.split("\n")
      .map((l) => `> ${l}`)
      .join("\n"),
  );
  const asked = await chat.post(
    threadId,
    questionsMessage([
      {
        question: "検索は前方一致だけでよいですか",
        recommendation: "前方一致だけにする",
      },
    ]),
  );
  await store.setReadPosition(threadId, asked);
  await store.updateRequirement(posted.id, { threadId, questions: 1 });
  chat.addMessage(threadId, { authorId: ALLOWED, text: "全部おすすめでよい" });
  return { messageId: posted.id, threadId };
}

// ---- 偽物 ----

/** 作業ツリーとコミット・push を覚えるだけの git */
class FakeGit {
  readonly files = new Set<string>();
  readonly commits: { branch: string; paths: string[]; message: string }[] = [];
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
  commit(paths: readonly string[], message: string): Promise<string> {
    this.commits.push({ branch: this.branch, paths: [...paths], message });
    for (const p of paths) this.files.delete(p);
    return Promise.resolve(`commit-${this.commits.length}`);
  }
  push(): Promise<void> {
    return Promise.resolve();
  }
}

/** 仕様の PR・CI・マージ・作業用 Issue を覚えるだけの GitHub */
class FakeBoard implements SpecifierBoard, SpecApprovalBoard, DecomposerBoard {
  readonly created: {
    number: number;
    url: string;
    head: string;
    title: string;
    body: string;
  }[] = [];
  /** PR 番号 → CI の結果。無ければ合格 */
  readonly ci = new Map<number, CiResult>();
  readonly merged: number[] = [];
  readonly issues: { number: number; url: string; title: string }[] = [];

  findPullRequest(head: string) {
    const pr = this.created.find((p) => p.head === head);
    return Promise.resolve(pr && { number: pr.number, url: pr.url });
  }
  createPullRequest(input: { head: string; title: string; body: string }) {
    const number = 101 + this.created.length;
    const url = `https://github.com/${REPO}/pull/${number}`;
    this.created.push({ number, url, ...input });
    return Promise.resolve({ number, url });
  }
  ciStatus(pr: number): Promise<CiResult> {
    return Promise.resolve(
      this.ci.get(pr) ?? {
        state: "success",
        checks: [{ name: "check", bucket: "pass", link: "" }],
      },
    );
  }
  mergePullRequest(pr: number): Promise<void> {
    if (!this.merged.includes(pr)) this.merged.push(pr);
    return Promise.resolve();
  }
  pullRequestFiles(): Promise<string[]> {
    return Promise.resolve([SPEC_FILE, KNOWLEDGE_FILE]);
  }
  createIssue(input: { title: string; body: string }) {
    const number = 201 + this.issues.length;
    const url = `https://github.com/${REPO}/issues/${number}`;
    this.issues.push({ number, url, title: input.title });
    return Promise.resolve({ number, url });
  }
  addToProject(): Promise<void> {
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

/** 決めた順に答える偽の役。呼ばれた依頼を覚える */
function fakeRole<S extends z.ZodType, O>(name: string) {
  const replies: (() => O)[] = [];
  const runs: RoleRun<S>[] = [];
  const run = (r: RoleRun<S>): Promise<RoleResult<O>> => {
    runs.push(r);
    const reply = replies.shift();
    if (reply === undefined) throw new Error(`${name}の答えを用意していません`);
    return Promise.resolve({
      output: reply(),
      denials: [],
      costUsd: 0,
      turns: 1,
      sessionId: `${name}-${runs.length}`,
    });
  };
  return { run, runs, replies };
}

type WorkIssue = DecomposerOutput["issues"][number];
const WORK_ISSUE: WorkIssue = {
  key: "search-index",
  title: "検索の索引を作る",
  purpose: "単語を前方一致で探せるようにする",
  acceptance: [
    "- AC1",
    "  - Given 単語「apple」「apricot」「banana」がある",
    "  - When 「ap」で検索する",
    "  - Then 「apple」「apricot」だけが出る",
  ].join("\n"),
  screens: "なし",
  outOfScope: "部分一致の検索",
  dependsOn: [],
};

/**
 * 常駐ループの部品。Issue の列は空で、Issue の各役は呼ばれない。
 * 要件の受け取り・仕様化役・仕様の承認・分解役をつなぐ（intakeOnly なら受け取りだけ）
 */
function setup(
  chat: MemoryChat,
  store: Store,
  options: { intakeOnly?: boolean } = {},
) {
  const config = makeConfig();
  const git = new FakeGit();
  const board = new FakeBoard();
  const specifier = fakeRole<typeof specifierOutputSchema, SpecifierOutput>(
    "仕様化役",
  );
  const decomposer = fakeRole<typeof decomposerOutputSchema, DecomposerOutput>(
    "分解役",
  );
  const never = () => Promise.reject(new Error("Issue の処理は呼ばれない"));
  const base: LoopDeps = {
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
    log: () => {},
  };
  const full: LoopDeps = {
    ...base,
    specify: (requirement) =>
      runSpecifier(
        {
          config,
          repoDir: "/repo",
          chat,
          store,
          git,
          board,
          run: specifier.run,
          instructions: "",
          log: () => {},
        },
        requirement,
      ),
    approveSpec: (requirement) =>
      checkSpecApproval(
        { config, chat, store, board, log: () => {} },
        requirement,
      ),
    decompose: (requirement) =>
      runDecomposer(
        {
          config,
          repoDir: "/repo",
          chat,
          store,
          board,
          run: decomposer.run,
          instructions: "",
          log: () => {},
        },
        requirement,
      ),
  };
  const deps = options.intakeOnly ? base : full;
  /** 確認を何回か続ける（受け取り・仕様化・承認・分解が1回の確認に収まらなくてもよいように） */
  const settle = async (times = 3) => {
    for (let i = 0; i < times; i++) await tick(deps, newLoopState());
  };
  return { deps, git, board, specifier, decomposer, settle };
}

/** 疑問を返す */
const ask = (): SpecifierOutput => ({
  verdict: "objection",
  summary: "疑問があります",
  findings: [],
  questions: [
    {
      question: "検索は前方一致だけでよいですか",
      recommendation: "前方一致だけにする",
    },
  ],
});

/** 仕様を書く（作業ツリーにファイルを置く） */
const write =
  (git: FakeGit, summary: string, files = [SPEC_FILE, KNOWLEDGE_FILE]) =>
  (): SpecifierOutput => {
    for (const f of files) git.files.add(f);
    return { verdict: "approve", summary, findings: [], questions: [] };
  };

const decomposition = (): DecomposerOutput => ({
  verdict: "approve",
  summary: "1 件に分けました",
  findings: [],
  issues: [WORK_ISSUE],
});

/** スレッド（またはチャンネル）に Bot が書いた、中身のある書き込み */
function botMessages(chat: MemoryChat, channelId: string) {
  return (chat.messages.get(channelId) ?? []).filter(
    (m) => m.authorId === chat.botId && m.text.trim() !== "",
  );
}

/** 作られたスレッド（ID つき） */
function threadsIn(chat: MemoryChat, channelId: string) {
  return [...chat.threads]
    .filter(([, t]) => t.channelId === channelId)
    .map(([id, t]) => ({ id, ...t }));
}

describe("Issue #86: 要件のスレッドを要件チャンネルの投稿から作る", () => {
  it("AC1: 許可した人が要件チャンネルに投稿すると、その投稿からスレッドを作り、質問チャンネルにも引用にも何も書かない", async () => {
    const chat = new DiscordLikeChat(BOT);
    const store = new MemoryStore(clock);
    // 受け取りだけを確かめる（仕様化役などはつながない）
    const { deps } = setup(chat, store, { intakeOnly: true });

    // Given: 許可した人が要件チャンネルに要件を投稿した
    const posted = postRequirement(chat, REQUIREMENT_TEXT);

    // When: conductor が要件を受け取る
    await tick(deps, newLoopState());
    await tick(deps, newLoopState());

    // Then: 要件チャンネルのその投稿からスレッドが1つ作られる（名前は要件の1行目）
    expect(chat.threads.size).toBe(1);
    const threads = threadsIn(chat, REQUIREMENTS);
    expect(threads).toHaveLength(1);
    const thread = threads[0]!;
    expect(thread.messageId).toBe(posted.id);
    expect(thread.name).toBe(REQUIREMENT_TITLE);
    expect(await store.listRequirements()).toEqual([
      expect.objectContaining({
        messageId: posted.id,
        threadId: thread.id,
        state: "specifying",
      }),
    ]);

    // Then: 質問チャンネルには何も書かない
    expect(chat.messages.get(QUESTIONS) ?? []).toEqual([]);

    // Then: 要件の本文を引用する書き込みもしない（Bot の中身のある書き込みはどこにも無い）
    for (const [channelId] of chat.messages) {
      expect(botMessages(chat, channelId), channelId).toEqual([]);
    }
  });

  it("AC2: 仕様化役に疑問があると、疑問は要件チャンネルの投稿から作ったスレッドに書かれる", async () => {
    const chat = new DiscordLikeChat(BOT);
    const store = new MemoryStore(clock);
    const { settle, specifier } = setup(chat, store);
    specifier.replies.push(ask);

    // Given: AC1 のスレッドがある
    const posted = postRequirement(chat, REQUIREMENT_TEXT);

    // When: 仕様化役に疑問がある
    await settle();
    expect(specifier.runs).toHaveLength(1);

    // Then: 疑問は AC1 のスレッドに書かれる
    const [thread] = threadsIn(chat, REQUIREMENTS);
    expect(thread?.messageId).toBe(posted.id);
    expect((await store.getRequirement(posted.id))?.threadId).toBe(thread!.id);
    const written = botMessages(chat, thread!.id);
    expect(written).toHaveLength(1);
    expect(written[0]!.text).toContain("検索は前方一致だけでよいですか");
    expect(written[0]!.text).toContain("おすすめ: 前方一致だけにする");

    // 質問チャンネルには書かず、スレッドもほかに作らない
    expect(chat.messages.get(QUESTIONS) ?? []).toEqual([]);
    expect(chat.threads.size).toBe(1);
  });

  it("AC3: 仕様の PR の要約とリンク、✅ による承認、修正の依頼、マージ・CI の失敗・分解の結果の知らせは、すべて要件チャンネルの投稿から作ったスレッドで行う", async () => {
    const chat = new DiscordLikeChat(BOT);
    const store = new MemoryStore(clock);
    const { settle, specifier, decomposer, git, board } = setup(chat, store);
    specifier.replies.push(
      ask,
      write(git, "前方一致の検索の仕様を書きました"),
      write(git, "検索を部分一致に直しました", [SPEC_FILE]),
    );
    decomposer.replies.push(decomposition);

    // Given: AC1 のスレッドがある（仕様化役が疑問を書いた）
    const posted = postRequirement(chat, REQUIREMENT_TEXT);
    await settle();
    const [thread] = threadsIn(chat, REQUIREMENTS);
    expect(thread?.messageId).toBe(posted.id);
    const threadId = thread!.id;

    // When: 疑問がすべて解消され、仕様の PR を作った
    chat.addMessage(threadId, {
      authorId: ALLOWED,
      text: "全部おすすめでよい",
    });
    await settle();

    // Then: 要約と PR のリンクが AC1 のスレッドに書かれる
    expect(board.created).toHaveLength(1);
    const pr = board.created[0]!;
    const summaries = () =>
      botMessages(chat, threadId).filter((m) => m.text.includes(pr.url));
    expect(summaries()).toHaveLength(1);
    expect(summaries()[0]!.text).toContain("前方一致の検索の仕様を書きました");

    // Then: 修正の依頼も AC1 のスレッドで受け、直した要約も AC1 のスレッドに書く
    chat.addMessage(threadId, {
      authorId: ALLOWED,
      text: "検索は部分一致にしてください",
    });
    await settle();
    expect(specifier.runs).toHaveLength(3);
    expect(specifier.runs[2]!.prompt).toContain("検索は部分一致にしてください");
    expect(board.created).toHaveLength(1);
    expect(summaries()).toHaveLength(2);
    expect(summaries()[1]!.text).toContain("検索を部分一致に直しました");

    // Then: ✅ による承認は AC1 のスレッドで行う。CI の失敗の知らせも AC1 のスレッドに書く
    board.ci.set(pr.number, CI_FAILURE);
    chat.addReaction(threadId, summaries()[1]!.id, APPROVE, ALLOWED);
    const beforeCi = botMessages(chat, threadId).length;
    await settle();
    expect(board.merged).toEqual([]);
    const ciTold = botMessages(chat, threadId).slice(beforeCi);
    expect(ciTold).toHaveLength(1);
    expect(ciTold[0]!.text).toContain("CI");
    expect(ciTold[0]!.text).toContain(`#${pr.number}`);

    // Then: マージの知らせと分解の結果も AC1 のスレッドに書く。スレッドはアーカイブしてロックする
    board.ci.delete(pr.number);
    const beforeMerge = botMessages(chat, threadId).length;
    await settle();
    expect(board.merged).toEqual([pr.number]);
    const record = await store.getRequirement(posted.id);
    expect(record?.state).toBe("working");
    expect(record?.threadId).toBe(threadId);
    expect(decomposer.runs).toHaveLength(1);
    expect(board.issues).toHaveLength(1);
    const after = botMessages(chat, threadId)
      .slice(beforeMerge)
      .map((m) => m.text);
    const merged = after.filter(
      (t) => t.includes(`#${pr.number}`) && t.includes("マージ"),
    );
    expect(merged.length).toBeGreaterThan(0);
    expect(after.some((t) => t.includes(board.issues[0]!.url))).toBe(true);
    const archived = chat.threads.get(threadId)!;
    expect(archived.archived).toBe(true);
    expect(archived.locked).toBe(true);

    // 質問チャンネルには最後まで何も書かず、スレッドもほかに作らない
    expect(chat.messages.get(QUESTIONS) ?? []).toEqual([]);
    expect(chat.threads.size).toBe(1);
  });

  it("AC4: 要件の1行目が「markdownファイルを…読みやすくしたい」のとき、仕様の PR のタイトルとコミットの文言に要件の1行目を使う（「仕様: 要件」にならない）", async () => {
    const chat = new DiscordLikeChat(BOT);
    const store = new MemoryStore(clock);
    const { settle, specifier, git, board } = setup(chat, store);
    specifier.replies.push(write(git, "markdown viewer の仕様を書きました"));

    // Given: 要件の1行目が「markdownファイルを表示している箇所は、markdown viewerを使用して読みやすくしたい」
    postRequirement(chat, MARKDOWN_TEXT);

    // When: 仕様の PR を作る
    await settle();

    // Then: PR のタイトルが「仕様: <要件の1行目>」になる
    expect(board.created).toHaveLength(1);
    expect(board.created[0]!.title).toBe(`仕様: ${MARKDOWN_TITLE}`);
    expect(board.created[0]!.title).not.toBe("仕様: 要件");

    // Then: コミットの文言「docs: 仕様「…」」も要件の1行目を使う
    expect(git.commits).toHaveLength(1);
    expect(git.commits[0]!.message).toBe(`docs: 仕様「${MARKDOWN_TITLE}」`);
  });

  it("AC5: 仕様化役と分解役に渡す要件の本文は、要件チャンネルの元の投稿の本文と同じ（空にならない）", async () => {
    const chat = new DiscordLikeChat(BOT);
    const store = new MemoryStore(clock);
    const { settle, specifier, decomposer, git, board } = setup(chat, store);
    specifier.replies.push(write(git, "前方一致の検索の仕様を書きました"));
    decomposer.replies.push(decomposition);

    // Given: 要件（3行）
    const posted = postRequirement(chat, REQUIREMENT_TEXT);

    // When: 仕様化役に要件の本文を渡す
    await settle();
    expect(specifier.runs).toHaveLength(1);

    // Then: 仕様化役に渡す本文は、元の投稿の本文と同じ
    expect(specifier.runs[0]!.prompt).toContain(posted.text);

    // When: 承認して分解役に要件の本文を渡す
    const pr = board.created[0]!;
    const [thread] = threadsIn(chat, REQUIREMENTS);
    const summary = botMessages(chat, thread!.id).find((m) =>
      m.text.includes(pr.url),
    )!;
    chat.addReaction(thread!.id, summary.id, APPROVE, ALLOWED);
    await settle();

    // Then: 分解役に渡す本文も、元の投稿の本文と同じ
    expect(decomposer.runs).toHaveLength(1);
    expect(decomposer.runs[0]!.prompt).toContain(posted.text);
  });

  it("AC6: この変更より前に受け取った要件（スレッドが質問チャンネルにある）は、記録にあるスレッドをそのまま使って承認と分解まで進み、本文も元の投稿から正しく読める", async () => {
    const chat = new DiscordLikeChat(BOT);
    const store = new MemoryStore(clock);
    // Given: この変更より前に受け取った要件（スレッドが質問チャンネルにある）
    const { messageId, threadId } = await seedLegacyRequirement(chat, store);
    const { settle, specifier, decomposer, git, board } = setup(chat, store);
    specifier.replies.push(write(git, "前方一致の検索の仕様を書きました"));
    decomposer.replies.push(decomposition);

    // When: 変更後の conductor が処理を続ける（仕様の PR を作る）
    await settle();

    // Then: 要件の本文は元の投稿から正しく読める（PR のタイトルも1行目）
    expect(specifier.runs).toHaveLength(1);
    expect(specifier.runs[0]!.prompt).toContain(REQUIREMENT_TEXT);
    expect(board.created).toHaveLength(1);
    const pr = board.created[0]!;
    expect(pr.title).toBe(`仕様: ${REQUIREMENT_TITLE}`);

    // Then: 要約は記録にあるスレッド（質問チャンネル）に書く
    const summary = botMessages(chat, threadId).find((m) =>
      m.text.includes(pr.url),
    );
    expect(summary).toBeDefined();

    // When: 記録にあるスレッドで ✅ を付ける
    chat.addReaction(threadId, summary!.id, APPROVE, ALLOWED);
    await settle();

    // Then: 承認されてマージし、記録にあるスレッドをアーカイブしてロックする
    expect(board.merged).toEqual([pr.number]);
    const thread = chat.threads.get(threadId)!;
    expect(thread.channelId).toBe(QUESTIONS);
    expect(thread.archived).toBe(true);
    expect(thread.locked).toBe(true);

    // Then: 分解まで進み、分解役にも元の投稿の本文を渡し、結果は記録にあるスレッドに書く
    expect(decomposer.runs).toHaveLength(1);
    expect(decomposer.runs[0]!.prompt).toContain(REQUIREMENT_TEXT);
    expect(board.issues).toHaveLength(1);
    expect(
      botMessages(chat, threadId).some((m) =>
        m.text.includes(board.issues[0]!.url),
      ),
    ).toBe(true);
    const record = await store.getRequirement(messageId);
    expect(record?.threadId).toBe(threadId);
    expect(record?.state).toBe("working");
    expect(record?.workIssues).toEqual([board.issues[0]!.number]);

    // 新しいスレッドは作らない
    expect(chat.threads.size).toBe(1);
  });

  it("AC7: 作業が止まった Issue のスレッドは、今までどおり質問チャンネルに作る", async () => {
    const config = makeConfig();
    const chat = new DiscordLikeChat(BOT);
    const store = new MemoryStore(clock);
    const STUCK = 12;
    const issues = new Map<number, { title: string; column: string }>();
    issues.set(STUCK, {
      title: "単語の一覧に並べ替えをつける",
      column: config.github.columns.ready,
    });
    const board: LoopDeps["board"] = {
      issuesByColumn: () => {
        const map = new Map<string, LoopIssue[]>();
        for (const [number, i] of issues) {
          const list = map.get(i.column) ?? [];
          list.push({ number, title: i.title, body: `## 目的\n${i.title}` });
          map.set(i.column, list);
        }
        return Promise.resolve(map);
      },
      moveIssue: (issue, column) => {
        issues.get(issue)!.column = column;
        return Promise.resolve();
      },
      comment: () => Promise.resolve(),
      hasConflict: () => Promise.resolve(false),
    };
    const never = () => Promise.reject(new Error("この役は呼ばれない"));
    const deps: LoopDeps = {
      config,
      store,
      chat,
      board,
      pickUp: (issue) => {
        issues.get(issue.number)!.column = config.github.columns.testing;
        return Promise.resolve({ accepted: true });
      },
      test: () =>
        Promise.reject(new Error("受け入れテストの実行に失敗しました")),
      implement: never,
      checkCi: never,
      review: never,
      merge: never,
      syncMain: never,
      log: () => {},
    };
    // 要件も1件受け取っておく（要件のスレッドは要件チャンネル）
    const posted = postRequirement(chat, REQUIREMENT_TEXT);

    // Given: 作業が止まった Issue がある（テスト役が続けて失敗して Blocked になった）
    const state = newLoopState();
    for (let i = 0; i < MAX_FAILURES; i++) await tick(deps, state);
    expect(issues.get(STUCK)!.column).toBe(config.github.columns.blocked);

    // When: 止まった理由のスレッドを作る（次の確認までに）
    await tick(deps, state);

    // Then: 止まった Issue のスレッドは質問チャンネルに作る
    const blocked = threadsIn(chat, QUESTIONS);
    expect(blocked).toHaveLength(1);
    const headId = blocked[0]!.messageId;
    const head =
      chat.messages.get(QUESTIONS)?.find((m) => m.id === headId)?.text ?? "";
    const inThread = botMessages(chat, blocked[0]!.id).map((m) => m.text);
    const text = [head, ...inThread].join("\n");
    expect(text).toContain(`https://github.com/${REPO}/issues/${STUCK}`);

    // 要件のスレッドは要件チャンネルの投稿から作られている
    const requirementThreads = threadsIn(chat, REQUIREMENTS);
    expect(requirementThreads.map((t) => t.messageId)).toEqual([posted.id]);
    expect(chat.threads.size).toBe(2);
  });
});

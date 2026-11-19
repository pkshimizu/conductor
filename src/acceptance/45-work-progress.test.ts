/**
 * Issue #45: 順番どおりの着手と完了の知らせの受け入れテスト
 *
 * 決めた名前（実装役はこれに合わせて作る）:
 * - 新しいモジュール `src/progress.ts`
 *   ```ts
 *   // 作業用 Issue 1件の今の様子
 *   export interface WorkIssueStatus {
 *     column?: string;   // Project の状態欄。Project に追加しただけで未設定なら undefined
 *     body: string;      // Issue の本文（「## 先に済ませる Issue」の #番号 を読むのに使ってよい）
 *     merged?: { number: number; url: string }; // この Issue の、マージ済みの PR。無ければ undefined
 *   }
 *
 *   export interface ProgressBoard {
 *     workIssueStatus(issue: number): Promise<WorkIssueStatus>;
 *     moveIssue(issue: number, column: string): Promise<void>;
 *   }
 *
 *   export interface ProgressDeps {
 *     config: Config;   // config.chat がある前提
 *     chat: Chat;
 *     store: Store;
 *     board: ProgressBoard;
 *     log(text: string): void;
 *   }
 *
 *   // 分解済みの要件1件の作業用 Issue を1回分確かめる
 *   export function checkProgress(deps: ProgressDeps, requirement: RequirementRecord):
 *     Promise<{ status: string }>;
 *   ```
 * - 振る舞い
 *   - 「マージされた」は WorkIssueStatus.merged があること
 *   - 先に済ませる Issue（分解役の dependsOn。作った Issue の「先に済ませる Issue」に #番号 で書いたもの）が
 *     すべてマージされた Issue を、config.github.columns.ready に移す
 *   - 移すのは列が未設定（Project に追加しただけ）の Issue だけ。Ready・作業中・Done・Blocked の Issue は動かさない
 *     （次の確認で同じ Issue を移し直さない）
 *   - 要件の作業用 Issue（workIssues）がすべてマージされたら、お知らせチャンネル（config.chat.channels.notices）に
 *     要件の完了を1つの書き込みで書き、要件の状態を "done" にする。書き込みには
 *     - 要件の要約として、要件の本文の最初の行（スレッドの名前。例:「単語帳に検索をつけたい」）
 *     - マージした PR の一覧（作業用 Issue ごとの PR の `#番号` と URL）
 *     を入れる。完了にした要件は、次の確認で書き直さない
 * - `src/loop.ts` の `LoopDeps` に、省略できる項目を足す
 *   ```ts
 *   progress?: (requirement: RequirementRecord) => Promise<StepResult>;
 *   ```
 *   `tick` は、スレッドがあり状態が working で workIssues が空でない要件ごとに `progress` を呼ぶ
 *   （失敗しても Issue の処理は止めない）。仕様化（specify）と Issue の処理は、同じ確認の中でどちらも進める
 *
 * Given の「分解で作った Issue」は、#44 の分解役（runDecomposer）を偽の役で動かして作る（seedDecomposed）。
 * 「マージされた」は、偽の GitHub で PR をマージ済みにし、Issue を Done に移して作る（#14 の mergeApproved と同じ形で、
 * 記録の pr にも PR 番号を入れる）。
 * 窓口は MemoryChat、GitHub・git・claude は偽物、記録は MemoryStore を使う。
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
import { type LoopDeps, type LoopIssue, newLoopState, tick } from "../loop.js";
import {
  checkProgress,
  type ProgressBoard,
  type ProgressDeps,
  type WorkIssueStatus,
} from "../progress.js";
import { approvedMessage } from "../spec-approval.js";
import {
  questionsMessage,
  runSpecifier,
  type SpecifierDeps,
  type SpecifierOutput,
  type specifierOutputSchema,
  summaryMessage,
} from "../specifier.js";
import { MemoryStore, type Store } from "../store.js";

// ---- seed ----

const REPO = "pkshimizu/wordcards";
const REQUIREMENTS = "1000000000000000001";
const QUESTIONS = "1000000000000000002";
const NOTICES = "1000000000000000003";
const ALLOWED = "2000000000000000001";
const BOT = "3000000000000000001";

const SPEC_PR = 101;
const SPEC_PR_URL = `https://github.com/${REPO}/pull/${SPEC_PR}`;
const SPEC_FILE = "docs/specs/word-search.md";
const REQUIREMENT_TITLE = "単語帳に検索をつけたい";
const REQUIREMENT_TEXT = `${REQUIREMENT_TITLE}\n前方一致で探せるように`;
const OTHER_TITLE = "単語帳を CSV で書き出したい";

const clock = () => new Date("2026-11-19T00:00:00.000Z");

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

const quote = (text: string) =>
  text
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");

/** 仕様が承認された要件（#43 の承認が済んだ状態）を作る */
async function seedApprovedSpec(chat: MemoryChat, store: Store) {
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
  return { messageId: posted.id, threadId };
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

/** Issue・Project の列・マージを覚えるだけの GitHub */
class FakeBoard implements DecomposerBoard, ProgressBoard {
  readonly issues: FakeIssue[] = [];
  readonly moved: { issue: number; column: string }[] = [];
  private nextPr = 301;

  // ---- 分解（#44） ----
  pullRequestFiles(pr: number): Promise<string[]> {
    if (pr !== SPEC_PR) return Promise.reject(new Error(`PR #${pr} は無い`));
    return Promise.resolve([SPEC_FILE]);
  }
  createIssue(input: { title: string; body: string }) {
    const number = 201 + this.issues.length;
    const url = `https://github.com/${REPO}/issues/${number}`;
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

  // ---- 常駐ループの列 ----
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

  // ---- テストの準備用 ----
  byTitle(title: string): FakeIssue {
    const found = this.issues.find((i) => i.title === title);
    if (found === undefined) throw new Error(`Issue がありません: ${title}`);
    return found;
  }
  /** 列を置く（記録に残さない） */
  place(issue: number, column: string): void {
    this.find(issue).column = column;
  }
  /** Issue の PR をマージ済みにして Done に移す（mergeApproved と同じく記録の pr にも入れる） */
  async mergeIssue(store: Store, issue: number) {
    const found = this.find(issue);
    const number = this.nextPr++;
    found.merged = { number, url: `https://github.com/${REPO}/pull/${number}` };
    found.column = "Done";
    await store.update({ repo: REPO, issue }, { pr: number });
    return found.merged;
  }

  private find(issue: number): FakeIssue {
    const found = this.issues.find((i) => i.number === issue);
    if (found === undefined) throw new Error(`Issue #${issue} は無い`);
    return found;
  }
}

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

/** 作業の順番は index → api → ui（ui は index と api の両方を待つ） */
const INDEX = workIssue("search-index", "検索の索引を作る", []);
const API = workIssue("search-api", "検索の API を作る", ["search-index"]);
const UI = workIssue("search-ui", "検索の画面を作る", [
  "search-index",
  "search-api",
]);

/** 分解で作った Issue（#44 の分解役を偽の役で動かす）。Issue は Project に追加しただけで列は未設定 */
async function seedDecomposed(
  chat: MemoryChat,
  store: Store,
  board: FakeBoard,
  config: Config,
) {
  const seeded = await seedApprovedSpec(chat, store);
  const run: (
    r: RoleRun<typeof decomposerOutputSchema>,
  ) => Promise<RoleResult<DecomposerOutput>> = () =>
    Promise.resolve({
      output: {
        verdict: "approve",
        summary: "3 件に分けました",
        findings: [],
        issues: [UI, API, INDEX],
      },
      denials: [],
      costUsd: 0,
      turns: 1,
      sessionId: "session-decomposer",
    });
  const requirement = await store.getRequirement(seeded.messageId);
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
  const record = await store.getRequirement(seeded.messageId);
  expect(record?.workIssues).toHaveLength(3);
  return {
    ...seeded,
    index: board.byTitle(INDEX.title),
    api: board.byTitle(API.title),
    ui: board.byTitle(UI.title),
  };
}

/** 作業ツリーとコミット・push を覚えるだけの git（仕様化役用） */
class FakeGit {
  readonly files = new Set<string>();
  startBranch(): Promise<void> {
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
  commit(): Promise<string> {
    return Promise.resolve("commit-1");
  }
  push(): Promise<void> {
    return Promise.resolve();
  }
}

type SpecRun = RoleRun<typeof specifierOutputSchema>;

/** 疑問を返す偽の仕様化役 */
function fakeSpecifier(replies: SpecifierOutput[]) {
  const runs: SpecRun[] = [];
  const run = (r: SpecRun): Promise<RoleResult<SpecifierOutput>> => {
    runs.push(r);
    const output = replies.shift();
    if (output === undefined)
      throw new Error("仕様化役の答えを用意していません");
    return Promise.resolve({
      output,
      denials: [],
      costUsd: 0,
      turns: 1,
      sessionId: `session-${runs.length}`,
    });
  };
  return { run, runs };
}

/**
 * 常駐ループの部品。列は偽の GitHub の列を使う。着手と完了（progress）をつなぐ。
 * Issue の各役は、test 以外は呼ばれない。test は呼ばれた Issue を覚える
 */
function setup(
  chat: MemoryChat,
  store: Store,
  board: FakeBoard,
  config: Config,
  options: { specify?: LoopDeps["specify"] } = {},
) {
  const progressDeps: ProgressDeps = {
    config,
    chat,
    store,
    board,
    log: () => {},
  };
  const tested: number[] = [];
  const never = () => Promise.reject(new Error("Issue の処理は呼ばれない"));
  const deps: LoopDeps = {
    config,
    store,
    chat,
    board: {
      issuesByColumn: () => board.issuesByColumn(),
      moveIssue: (issue, column) => board.moveIssue(issue, column),
      comment: () => Promise.resolve(),
      hasConflict: () => Promise.resolve(false),
    },
    pickUp: never,
    test: (issue) => {
      tested.push(issue.number);
      return Promise.resolve({ status: "tested" });
    },
    implement: never,
    checkCi: never,
    review: never,
    merge: never,
    syncMain: never,
    ...(options.specify === undefined ? {} : { specify: options.specify }),
    progress: (requirement) => checkProgress(progressDeps, requirement),
    log: () => {},
  };
  return { deps, tested };
}

/** チャンネル（またはスレッド）に Bot が書いた文 */
function botTexts(chat: MemoryChat, channelId: string): string[] {
  return (chat.messages.get(channelId) ?? [])
    .filter((m) => m.authorId === chat.botId)
    .map((m) => m.text);
}

describe("Issue #45: 順番どおりの着手と完了の知らせ", () => {
  it("AC1: 分解で作った Issue は、次の確認で、先に済ませる Issue が無いものを Ready に移す", async () => {
    const config = makeConfig();
    const chat = new MemoryChat(BOT);
    const store = new MemoryStore(clock);
    const board = new FakeBoard();
    // Given: 分解で作った Issue（index → api → ui。どれも列は未設定）
    const { messageId, index, api, ui } = await seedDecomposed(
      chat,
      store,
      board,
      config,
    );
    expect(board.moved).toEqual([]);
    const { deps } = setup(chat, store, board, config);

    // When: 次の確認
    await tick(deps, newLoopState());

    // Then: 先に済ませる Issue が無いもの（index）だけを Ready に移す
    expect(board.moved).toEqual([{ issue: index.number, column: "Ready" }]);
    expect(index.column).toBe("Ready");
    // 先に済ませる Issue がまだマージされていないものは動かさない
    expect(api.column).toBeUndefined();
    expect(ui.column).toBeUndefined();

    // 要件は作業中のまま。お知らせチャンネルには何も書かない
    expect((await store.getRequirement(messageId))?.state).toBe("working");
    expect(botTexts(chat, NOTICES)).toEqual([]);

    // 次の確認でも、同じ Issue を移し直さない
    await tick(deps, newLoopState());
    expect(board.moved).toEqual([{ issue: index.number, column: "Ready" }]);
  });

  it("AC2: 前の Issue がマージされると、次の確認で、それを待っていた Issue を Ready に移す", async () => {
    const config = makeConfig();
    const chat = new MemoryChat(BOT);
    const store = new MemoryStore(clock);
    const board = new FakeBoard();
    const { messageId, index, api, ui } = await seedDecomposed(
      chat,
      store,
      board,
      config,
    );
    const { deps } = setup(chat, store, board, config);
    await tick(deps, newLoopState());
    expect(index.column).toBe("Ready");

    // Given: 前の Issue（index）がマージされた
    await board.mergeIssue(store, index.number);
    const before = board.moved.length;

    // When: 次の確認
    await tick(deps, newLoopState());

    // Then: index だけを待っていた api を Ready に移す
    expect(board.moved.slice(before)).toEqual([
      { issue: api.number, column: "Ready" },
    ]);
    // ui は api もまだなので動かさない。マージ済みの index も動かさない
    expect(ui.column).toBeUndefined();
    expect(index.column).toBe("Done");
    expect((await store.getRequirement(messageId))?.state).toBe("working");

    // Given: api もマージされた → When: 次の確認 → Then: 両方を待っていた ui を Ready に移す
    await board.mergeIssue(store, api.number);
    const before2 = board.moved.length;
    await tick(deps, newLoopState());
    expect(board.moved.slice(before2)).toEqual([
      { issue: ui.number, column: "Ready" },
    ]);
    expect(botTexts(chat, NOTICES)).toEqual([]);
  });

  it("AC3: 要件の Issue がすべてマージされると、次の確認で、お知らせチャンネルに要件の完了（要件の要約とマージした PR の一覧）を書き、要件を完了にする", async () => {
    const config = makeConfig();
    const chat = new MemoryChat(BOT);
    const store = new MemoryStore(clock);
    const board = new FakeBoard();
    const { messageId, index, api, ui } = await seedDecomposed(
      chat,
      store,
      board,
      config,
    );
    const { deps } = setup(chat, store, board, config);

    // まだ残りがあるうちは完了にしない
    const prIndex = await board.mergeIssue(store, index.number);
    const prApi = await board.mergeIssue(store, api.number);
    await tick(deps, newLoopState());
    expect(botTexts(chat, NOTICES)).toEqual([]);
    expect((await store.getRequirement(messageId))?.state).toBe("working");

    // Given: 要件の Issue がすべてマージされた
    const prUi = await board.mergeIssue(store, ui.number);

    // When: 次の確認
    await tick(deps, newLoopState());

    // Then: お知らせチャンネルに要件の完了を1つの書き込みで書く
    const notices = botTexts(chat, NOTICES);
    expect(notices).toHaveLength(1);
    const text = notices[0]!;
    // 要件の要約
    expect(text).toContain(REQUIREMENT_TITLE);
    // マージした PR の一覧
    for (const pr of [prIndex, prApi, prUi]) {
      expect(text).toContain(`#${pr.number}`);
      expect(text).toContain(pr.url);
    }

    // Then: 要件を完了にする
    expect((await store.getRequirement(messageId))?.state).toBe("done");

    // 次の確認で、完了の知らせを書き直さない
    await tick(deps, newLoopState());
    expect(botTexts(chat, NOTICES)).toHaveLength(1);
  });

  it("AC4: Issue の作業中に別の要件の返事が来ると、次の確認で、Issue の処理と要件の質問を並行して進める", async () => {
    const config = makeConfig();
    const chat = new MemoryChat(BOT);
    const store = new MemoryStore(clock);
    const board = new FakeBoard();

    // Given: 分解した要件の Issue（index）が作業中（テスト役の列）
    const { index, api, ui } = await seedDecomposed(chat, store, board, config);
    board.place(index.number, "Testing");

    // Given: 別の要件で質問を書いたところに、人の返事が来た
    const other = chat.addMessage(REQUIREMENTS, {
      authorId: ALLOWED,
      text: OTHER_TITLE,
    });
    await store.setReadPosition(REQUIREMENTS, other.id);
    const head = await chat.post(
      QUESTIONS,
      `要件を受け取りました（<@${ALLOWED}>）: ${OTHER_TITLE}`,
    );
    const otherThread = await chat.createThread(QUESTIONS, head, OTHER_TITLE);
    await chat.post(otherThread, quote(OTHER_TITLE));
    const asked = await chat.post(
      otherThread,
      questionsMessage([
        {
          question: "書き出す項目は単語と意味だけですか",
          recommendation: "単語と意味だけにする",
        },
      ]),
    );
    await store.setReadPosition(otherThread, asked);
    await store.updateRequirement(other.id, {
      threadId: otherThread,
      questions: 1,
    });
    chat.addMessage(otherThread, {
      authorId: ALLOWED,
      text: "例文も入れてください",
    });
    const beforeOther = botTexts(chat, otherThread).length;

    const specifier = fakeSpecifier([
      {
        verdict: "objection",
        summary: "疑問があります",
        findings: [],
        questions: [
          {
            question: "文字コードは UTF-8 でよいですか",
            recommendation: "UTF-8 にする",
          },
        ],
      },
    ]);
    const specifierDeps: SpecifierDeps = {
      config,
      repoDir: "/repo",
      chat,
      store,
      git: new FakeGit(),
      board: {
        findPullRequest: () => Promise.resolve(undefined),
        createPullRequest: () =>
          Promise.reject(new Error("PR は作らない（疑問を返すだけ）")),
      },
      run: specifier.run,
      instructions: "",
      log: () => {},
    };
    const { deps, tested } = setup(chat, store, board, config, {
      specify: (requirement) => runSpecifier(specifierDeps, requirement),
    });
    const movedBefore = board.moved.length;

    // When: 次の確認
    await tick(deps, newLoopState());

    // Then: 作業中の Issue の処理を進める
    expect(tested).toEqual([index.number]);

    // Then: 同じ確認で、別の要件の質問も進める（返事を渡して仕様化役を起動し、次の疑問を書く）
    expect(specifier.runs).toHaveLength(1);
    expect(specifier.runs[0]!.prompt).toContain("例文も入れてください");
    const added = botTexts(chat, otherThread).slice(beforeOther);
    expect(added).toHaveLength(1);
    expect(added[0]).toContain("文字コードは UTF-8 でよいですか");

    // 作業中の Issue を待っている Issue は動かさない
    expect(board.moved.slice(movedBefore)).toEqual([]);
    expect(api.column).toBeUndefined();
    expect(ui.column).toBeUndefined();
  });
});

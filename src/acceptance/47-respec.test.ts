/**
 * Issue #47: 仕様の作り直しの受け入れテスト
 *
 * 決めたこと（実装役はこれに合わせて作る）:
 * - 新しいモジュール `src/respec.ts`
 *   ```ts
 *   // 仕様化役の、止まった作業用 Issue の方針を受けたときの出力
 *   export const respecOutputSchema = roleOutput({
 *     specChange: z.boolean(), // 仕様の変更が要るか。要るときは docs/specs/ などを直してから true を返す
 *   });
 *   export type RespecOutput = z.infer<typeof respecOutputSchema>;
 *
 *   export interface RespecBoard {
 *     pullRequestFiles(pr: number): Promise<string[]>;           // 前の仕様の PR のファイル（渡す仕様を決める）
 *     findPullRequest(head: string): Promise<{ number: number; url: string } | undefined>;
 *     createPullRequest(input: { head: string; title: string; body: string }): Promise<{ number: number; url: string }>;
 *     ciStatus(pr: number): Promise<CiResult>;
 *     mergePullRequest(pr: number): Promise<void>;
 *   }
 *
 *   export interface RespecDeps {
 *     config: Config;  // config.chat がある前提
 *     repoDir: string;
 *     chat: Chat;
 *     store: Store;
 *     git: Pick<Git, "startBranch" | "changedFiles" | "discard" | "discardAll" | "commit" | "push">;
 *     board: RespecBoard;
 *     run: (run: RoleRun<typeof respecOutputSchema>) => Promise<RoleResult<RespecOutput>>;
 *     instructions: string;
 *     log(text: string): void;
 *   }
 *   ```
 * - `src/loop.ts` の `LoopDeps` に、省略できる項目 `respec?: RespecDeps` を足す。
 *   無ければ今までどおり（#46 のとおり方針を書き写して Ready に戻す）
 * - 振る舞い（止まった Issue が、要件の作業用 Issue（RequirementRecord.workIssues）のときだけ）
 *   - 許可した人が止まったときのスレッドに方針を書いたら、次の確認で仕様化役（respec.run）を起動する。
 *     依頼文（prompt）に、方針の文と、前の仕様の PR のファイル（docs/specs/ の下）を含める
 *   - specChange が false なら、#46 と同じく方針を Issue にコメントで書き写し、Ready に戻し、スレッドをアーカイブする
 *   - specChange が true なら、直した仕様のファイルを新しいブランチにコミットして push し、仕様の PR を作り、
 *     止まったときのスレッドに要約（役の summary）と PR のリンクを書いて ✅ を待つ。
 *     その間 Issue は Blocked のまま、スレッドはアーカイブしない。仕様化役を起動し直さない
 *   - その要約に許可した人が ✅ を付けたら、次の確認で仕様の PR をマージし、変更点（要約）を Issue にコメントで書き写し、
 *     Ready に戻し、スレッドをアーカイブする
 *   - 仕様化役の起動は1回でも2回（判断と作り直し）でもよい。テストの偽の役はどちらにも同じ答えを返す
 *
 * Given の「Blocked」は、要件の作業用 Issue を偽のテスト役で続けて失敗させ、常駐ループ自身に Blocked へ移させて作る。
 * 窓口は MemoryChat、GitHub・git・claude は偽物、記録は MemoryStore を使う。
 */
import { describe, expect, it } from "vitest";

import { MemoryChat } from "../chat.js";
import type { RoleResult, RoleRun } from "../claude.js";
import { type Config, parseConfig } from "../config.js";
import type { CiResult } from "../github.js";
import {
  type LoopDeps,
  type LoopIssue,
  MAX_FAILURES,
  newLoopState,
  tick,
} from "../loop.js";
import type {
  RespecBoard,
  RespecDeps,
  RespecOutput,
  respecOutputSchema,
} from "../respec.js";
import { MemoryStore } from "../store.js";

// ---- seed ----

const REPO = "pkshimizu/wordcards";
const REQUIREMENTS = "1000000000000000001";
const QUESTIONS = "1000000000000000002";
const NOTICES = "1000000000000000003";
const ALLOWED = "2000000000000000001";
const BOT = "3000000000000000001";

const REQUIREMENT_ID = "1000000000000000500";
const REQUIREMENT_TEXT = "単語帳に検索をつけたい\n前方一致で探せるように";
const SPEC_PR = 101;
const SPEC_FILE = "docs/specs/word-search.md";

const STUCK_ISSUE = 12;
const STUCK_TITLE = "検索の API を作る";
const REASON =
  "受け入れテストの実行に失敗しました: 大文字の「AP」で何も出ません";
const POLICY =
  "大文字と小文字を区別せずに探す方針にしてください。仕様にもそう書いてください";
const RESPEC_SUMMARY =
  "検索は大文字と小文字を区別しないことを仕様に書き足しました";

const APPROVE = "✅";

const clock = () => new Date("2026-11-20T00:00:00.000Z");
const prUrl = (n: number) => `https://github.com/${REPO}/pull/${n}`;

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

// ---- 偽物 ----

interface FakeIssue {
  number: number;
  title: string;
  body: string;
  column?: string;
}

/** Issue・列・コメント・PR・マージを覚えるだけの GitHub */
class FakeBoard implements RespecBoard {
  readonly issues: FakeIssue[] = [];
  readonly moved: { issue: number; column: string }[] = [];
  readonly comments: { issue: number; body: string; mention: boolean }[] = [];
  readonly created: {
    number: number;
    url: string;
    head: string;
    body: string;
  }[] = [];
  readonly merged: number[] = [];

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
  moveIssue(issue: number, column: string): Promise<void> {
    this.moved.push({ issue, column });
    this.find(issue).column = column;
    return Promise.resolve();
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

  // ---- 仕様の作り直し ----
  pullRequestFiles(pr: number): Promise<string[]> {
    if (pr !== SPEC_PR) return Promise.reject(new Error(`PR #${pr} は無い`));
    return Promise.resolve([SPEC_FILE]);
  }
  findPullRequest(head: string) {
    const pr = this.created.find((p) => p.head === head);
    return Promise.resolve(pr && { number: pr.number, url: pr.url });
  }
  createPullRequest(input: { head: string; title: string; body: string }) {
    const number = 301 + this.created.length;
    const url = prUrl(number);
    this.created.push({ number, url, head: input.head, body: input.body });
    return Promise.resolve({ number, url });
  }
  ciStatus(): Promise<CiResult> {
    return Promise.resolve({
      state: "success",
      checks: [{ name: "check", bucket: "pass", link: "" }],
    });
  }
  mergePullRequest(pr: number): Promise<void> {
    this.merged.push(pr);
    return Promise.resolve();
  }

  // ---- テストの準備用 ----
  find(issue: number): FakeIssue {
    const found = this.issues.find((i) => i.number === issue);
    if (found === undefined) throw new Error(`Issue #${issue} は無い`);
    return found;
  }
}

/** 作業ツリーとコミット・push を覚えるだけの git */
class FakeGit {
  readonly files = new Set<string>();
  readonly commits: { branch: string; paths: string[] }[] = [];
  readonly pushed: string[] = [];
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
  push(branch: string): Promise<void> {
    this.pushed.push(branch);
    return Promise.resolve();
  }
}

type RespecRun = RoleRun<typeof respecOutputSchema>;

/**
 * 偽の仕様化役。何度呼ばれても同じ答えを返す。
 * specChange が true のときは、呼ばれるたびに仕様のファイルを直す（作業ツリーに置く）
 */
function fakeRole(git: FakeGit, specChange: boolean) {
  const runs: RespecRun[] = [];
  const run = (r: RespecRun): Promise<RoleResult<RespecOutput>> => {
    runs.push(r);
    if (specChange) git.files.add(SPEC_FILE);
    return Promise.resolve({
      output: {
        verdict: "approve",
        summary: specChange
          ? RESPEC_SUMMARY
          : "方針は今の仕様の範囲で直せます。仕様の変更は要りません",
        findings: [],
        specChange,
      },
      denials: [],
      costUsd: 0,
      turns: 1,
      sessionId: `session-${runs.length}`,
    });
  };
  return { run, runs };
}

/**
 * 仕様が承認され、作業用 Issue（#12）に分けた要件があり、
 * #12 を Ready から拾ってテスト役が続けて失敗し、Blocked になって止まったときのスレッドができた状態
 */
async function seedBlockedWorkIssue(options: { specChange: boolean }) {
  const config = makeConfig();
  const chat = new MemoryChat(BOT);
  const store = new MemoryStore(clock);
  const board = new FakeBoard();
  const git = new FakeGit();
  const role = fakeRole(git, options.specChange);

  // 承認済みの要件のスレッド（#42・#43 の済んだ状態。アーカイブしてロック済み）
  const head = await chat.post(
    QUESTIONS,
    `要件を受け取りました（<@${ALLOWED}>）: 単語帳に検索をつけたい`,
  );
  const requirementThread = await chat.createThread(
    QUESTIONS,
    head,
    "単語帳に検索をつけたい",
  );
  await chat.post(
    requirementThread,
    REQUIREMENT_TEXT.split("\n")
      .map((l) => `> ${l}`)
      .join("\n"),
  );
  await chat.archiveThread(requirementThread);
  await chat.lockThread(requirementThread);
  await store.updateRequirement(REQUIREMENT_ID, {
    threadId: requirementThread,
    specPr: SPEC_PR,
    state: "working",
    workIssues: [STUCK_ISSUE],
  });

  board.issues.push({
    number: STUCK_ISSUE,
    title: STUCK_TITLE,
    body: [
      "## 目的",
      STUCK_TITLE,
      "",
      "## 仕様",
      `https://github.com/${REPO}/blob/main/${SPEC_FILE}`,
    ].join("\n"),
    column: config.github.columns.ready,
  });

  let failing = true;
  const never = () => Promise.reject(new Error("この役は呼ばれない"));
  const respec: RespecDeps = {
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
  const deps: LoopDeps = {
    config,
    store,
    board,
    chat,
    pickUp: (issue) => {
      board.find(issue.number).column = config.github.columns.testing;
      return Promise.resolve({ accepted: true });
    },
    test: () =>
      failing
        ? Promise.reject(new Error(REASON))
        : Promise.resolve({ status: "tested" }),
    implement: never,
    checkCi: never,
    review: never,
    merge: never,
    syncMain: never,
    respec,
    log: () => {},
  };
  const state = newLoopState();
  for (let i = 0; i < MAX_FAILURES; i++) await tick(deps, state);
  expect(board.find(STUCK_ISSUE).column).toBe(config.github.columns.blocked);

  // 次の確認で止まったときのスレッドができる（#46）
  await tick(deps, state);
  const threads = [...chat.threads.entries()]
    .filter(([id, t]) => t.channelId === QUESTIONS && id !== requirementThread)
    .map(([id]) => id);
  expect(threads).toHaveLength(1);
  const threadId = threads[0]!;
  expect(chat.threads.get(threadId)?.archived).toBe(false);

  return {
    config,
    chat,
    store,
    board,
    git,
    role,
    deps,
    state,
    threadId,
    /** 方針どおりに直れば、次からテスト役は通る */
    fix: () => {
      failing = false;
    },
  };
}

type Seeded = Awaited<ReturnType<typeof seedBlockedWorkIssue>>;

/** スレッドに Bot が書いた書き込み */
function botMessages(chat: MemoryChat, threadId: string) {
  return (chat.messages.get(threadId) ?? []).filter(
    (m) => m.authorId === chat.botId,
  );
}

/** 人がスレッドに方針を書いた */
function writePolicy(s: Seeded) {
  s.chat.addMessage(s.threadId, { authorId: ALLOWED, text: POLICY });
  s.fix();
}

/** 仕様の変更が要るとき、作り直した仕様の PR と要約を書いたところまで進める */
async function seedRespecified() {
  const s = await seedBlockedWorkIssue({ specChange: true });
  writePolicy(s);
  await tick(s.deps, s.state);
  expect(s.board.created).toHaveLength(1);
  const pr = s.board.created[0]!;
  const summary = botMessages(s.chat, s.threadId).findLast((m) =>
    m.text.includes(pr.url),
  );
  expect(summary).toBeDefined();
  return { ...s, pr, summaryId: summary!.id };
}

describe("Issue #47: 仕様の作り直し", () => {
  it("AC1: Blocked のスレッドに人が方針を書くと、仕様化役に方針と仕様を渡して仕様の変更が要るかを判断させ、要らなければ方針を Issue に書き写して Ready に戻す", async () => {
    // Given: 要件の作業用 Issue（#12）が Blocked で、止まったときのスレッドに人が方針を書いた
    const s = await seedBlockedWorkIssue({ specChange: false });
    expect(s.role.runs).toHaveLength(0);
    const commentsBefore = s.board.comments.length;
    const movedBefore = s.board.moved.length;
    writePolicy(s);

    // When: 次の確認で、仕様化役に方針と仕様を渡す
    await tick(s.deps, s.state);

    // Then: 仕様化役に、方針と仕様（前の仕様の PR のファイル）を渡して判断させる
    expect(s.role.runs.length).toBeGreaterThanOrEqual(1);
    const prompt = s.role.runs[0]!.prompt;
    expect(prompt).toContain(POLICY);
    expect(prompt).toContain(SPEC_FILE);

    // Then: 仕様の変更が要らないので、仕様の PR は作らない
    expect(s.board.created).toEqual([]);
    expect(s.git.commits).toEqual([]);
    expect(s.board.merged).toEqual([]);

    // Then: 前の Issue（#46）のとおり、方針を Issue にコメントで書き写し、Ready に戻し、スレッドをアーカイブする
    const added = s.board.comments.slice(commentsBefore);
    expect(
      added.some((c) => c.issue === STUCK_ISSUE && c.body.includes(POLICY)),
    ).toBe(true);
    expect(s.board.moved.slice(movedBefore)).toContainEqual({
      issue: STUCK_ISSUE,
      column: "Ready",
    });
    expect(s.chat.threads.get(s.threadId)?.archived).toBe(true);

    // 次の確認で、同じ方針を書き写し直さず、仕様化役も起動し直さない
    const runs = s.role.runs.length;
    await tick(s.deps, s.state);
    expect(
      s.board.comments.filter(
        (c) => c.issue === STUCK_ISSUE && c.body.includes(POLICY),
      ),
    ).toHaveLength(1);
    expect(s.role.runs).toHaveLength(runs);
  });

  it("AC2: 仕様の変更が要るとき、仕様化役が作り直して仕様の PR を作り、要約と PR のリンクをスレッドに書いて ✅ を待つ", async () => {
    // Given: 仕様の変更が要る（仕様化役が仕様を直して specChange: true を返す）
    const s = await seedBlockedWorkIssue({ specChange: true });
    const commentsBefore = s.board.comments.length;
    const movedBefore = s.board.moved.length;
    const botBefore = botMessages(s.chat, s.threadId).length;
    writePolicy(s);

    // When: 次の確認で、仕様化役が作り直す
    await tick(s.deps, s.state);

    // Then: 直した仕様をコミットして push し、仕様の PR を作る
    expect(s.git.commits).toHaveLength(1);
    expect(s.git.commits[0]!.paths).toContain(SPEC_FILE);
    expect(s.git.pushed).toContain(s.git.commits[0]!.branch);
    expect(s.board.created).toHaveLength(1);
    const pr = s.board.created[0]!;
    expect(pr.head).toBe(s.git.commits[0]!.branch);

    // Then: 止まったときのスレッドに、要約と PR のリンクを書く
    const added = botMessages(s.chat, s.threadId).slice(botBefore);
    expect(
      added.some(
        (m) => m.text.includes(RESPEC_SUMMARY) && m.text.includes(pr.url),
      ),
    ).toBe(true);

    // Then: ✅ を待つ（マージせず、Issue は Blocked のまま、スレッドも開いたまま、方針の書き写しもしない）
    const waiting = async () => {
      expect(s.board.merged).toEqual([]);
      expect(s.board.find(STUCK_ISSUE).column).toBe("Blocked");
      expect(s.board.moved.slice(movedBefore)).toEqual([]);
      expect(s.chat.threads.get(s.threadId)?.archived).toBe(false);
      expect(
        s.board.comments
          .slice(commentsBefore)
          .filter((c) => c.issue === STUCK_ISSUE),
      ).toEqual([]);
    };
    await waiting();

    // ✅ が付くまでは、次の確認でも待ったまま（PR を作り直さず、仕様化役も起動し直さない）
    const runs = s.role.runs.length;
    await tick(s.deps, s.state);
    await waiting();
    expect(s.board.created).toHaveLength(1);
    expect(s.role.runs).toHaveLength(runs);
  });

  it("AC3: 作り直した仕様の要約に ✅ が付くと、次の確認で仕様の PR をマージし、変更点を Issue にコメントで書き写して Ready に戻し、スレッドをアーカイブする", async () => {
    const s = await seedRespecified();
    const commentsBefore = s.board.comments.length;
    const movedBefore = s.board.moved.length;
    expect(s.board.merged).toEqual([]);

    // Given: 作り直した仕様の要約に、許可した人が ✅ を付けた
    s.chat.addReaction(s.threadId, s.summaryId, APPROVE, ALLOWED);

    // When: 次の確認
    await tick(s.deps, s.state);

    // Then: 仕様の PR をマージする
    expect(s.board.merged).toEqual([s.pr.number]);

    // Then: 変更点を Issue にコメントで書き写す
    const added = s.board.comments.slice(commentsBefore);
    expect(
      added.some(
        (c) => c.issue === STUCK_ISSUE && c.body.includes(RESPEC_SUMMARY),
      ),
    ).toBe(true);

    // Then: Ready に戻す
    expect(s.board.moved.slice(movedBefore)).toContainEqual({
      issue: STUCK_ISSUE,
      column: "Ready",
    });

    // Then: スレッドをアーカイブする
    expect(s.chat.threads.get(s.threadId)?.archived).toBe(true);

    // 次の確認で、二度マージせず、変更点も書き写し直さない
    await tick(s.deps, s.state);
    expect(s.board.merged).toEqual([s.pr.number]);
    expect(
      s.board.comments.filter(
        (c) => c.issue === STUCK_ISSUE && c.body.includes(RESPEC_SUMMARY),
      ),
    ).toHaveLength(1);
  });
});

/**
 * Issue #42: 仕様化役の受け入れテスト
 *
 * 決めた名前（実装役はこれに合わせて作る）:
 * - 新しいモジュール `src/specifier.ts`
 *   ```ts
 *   // 役の結果の形。共通の項目（verdict・summary・findings）に questions を足す
 *   export const specifierOutputSchema = roleOutput({
 *     questions: z.array(
 *       z.object({
 *         question: z.string(),       // 疑問
 *         recommendation: z.string(), // おすすめの答え
 *       }).strict(),
 *     ),
 *   });
 *   export type SpecifierOutput = z.infer<typeof specifierOutputSchema>;
 *
 *   // 仕様化役に必ず守らせる決まり。追加指示（instructions）はこの後に足す
 *   export const SPECIFIER_RULES: string;
 *
 *   export interface SpecifierBoard {
 *     findPullRequest(head: string): Promise<{ number: number; url: string } | undefined>;
 *     // 仕様の PR は Issue に紐づかないので issue は渡さない
 *     createPullRequest(input: { head: string; title: string; body: string }):
 *       Promise<{ number: number; url: string }>;
 *   }
 *
 *   export interface SpecifierDeps {
 *     config: Config;               // config.chat がある前提
 *     repoDir: string;
 *     chat: Chat;
 *     store: Store;
 *     git: Pick<Git, "startBranch" | "changedFiles" | "discard" | "discardAll" | "commit" | "push">;
 *     board: SpecifierBoard;
 *     run: (run: RoleRun<typeof specifierOutputSchema>) => Promise<RoleResult<SpecifierOutput>>;
 *     instructions: string;         // .conductor/specifier/*.md をまとめたもの
 *     model?: string;
 *     log(text: string): void;
 *   }
 *
 *   // 要件1件を1回分進める（やることが無ければ何もしない）
 *   export function runSpecifier(deps: SpecifierDeps, requirement: RequirementRecord):
 *     Promise<{ status: string }>;
 *   ```
 * - 仕様化役の振る舞い
 *   - 役の結果の questions が空でなければ「疑問がある」。1つの書き込みにまとめてスレッドに書く。
 *     各疑問は `1. <question>` の行で始め、その後に `おすすめ: <recommendation>` を書く。
 *     「全部おすすめでよい」と1行で返せることも書く。質問の数を `questions` に足して記録する
 *   - questions が空なら「仕様を書いた」。役が書いた docs/specs/ と .conductor/knowledge/ の変更を
 *     要件ごとのブランチ1本にコミット・push して PR を作り（既にあれば作らない）、
 *     要件の記録の specPr に PR 番号を入れ、要約（summary）と PR の URL をスレッドに書く
 *   - Bot の最後の書き込みより後に、許可した人の書き込みが無ければ何もしない（役も起動しない・催促しない）
 *   - 要約の後の ✅ 以外の書き込みは修正の依頼。同じブランチ・同じ PR を直し、要約を書き直す
 * - `src/config.ts` の `ROLES` に "specifier" を足す（`loadRoleInstructions(repoDir, "specifier")` で
 *   `.conductor/specifier/*.md` を読む）。言語の指示は start.ts の `roleRunner` を通して入る
 * - `src/loop.ts` の `LoopDeps` に、省略できる項目を足す
 *   ```ts
 *   specify?: (requirement: RequirementRecord) => Promise<StepResult>;
 *   ```
 *   `tick` は要件の受け取りの後、スレッドがあり状態が specifying または awaiting_approval の要件ごとに
 *   `specify` を呼ぶ（失敗しても Issue の処理は止めない）
 *
 * 窓口は MemoryChat、GitHub と git と claude は偽物、記録は MemoryStore（AC6 は SQLite を一時フォルダに作る）を使う。
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MemoryChat } from "../chat.js";
import {
  type ClaudeDeps,
  languageRule,
  type RoleResult,
  type RoleRun,
} from "../claude.js";
import { type Config, loadRoleInstructions, parseConfig } from "../config.js";
import { type LoopDeps, newLoopState, tick } from "../loop.js";
import {
  runSpecifier,
  SPECIFIER_RULES,
  type SpecifierDeps,
  type SpecifierOutput,
  type specifierOutputSchema,
} from "../specifier.js";
import { SqliteStore } from "../sqlite-store.js";
import { roleRunner } from "../start.js";
import { MemoryStore, type Store } from "../store.js";

// ---- seed ----

const REPO = "pkshimizu/wordcards";
const REQUIREMENTS = "1000000000000000001";
const QUESTIONS = "1000000000000000002";
const NOTICES = "1000000000000000003";
const ALLOWED = "2000000000000000001";
const BOT = "3000000000000000001";

function makeConfig(extra: string[] = []): Config {
  return parseConfig(
    [
      `github: { repo: ${REPO}, project: 3, notify: someone }`,
      "protected: [src/acceptance/**]",
      "commands: { setup: s, test: t, acceptance: a, typecheck: c, build: b }",
      ...extra,
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

/** 時刻は止めておき、必要なときだけ進める */
let now = new Date("2026-11-19T00:00:00.000Z");
const clock = () => now;
const advanceDays = (days: number) => {
  now = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
};

/**
 * 受け取り済みの要件（#41 の受け取りが済んだ状態）を作る。
 * 要件チャンネルの投稿・質問チャンネルのスレッド・スレッドへの引用・要件の記録
 */
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
  readonly commits: { branch: string; paths: string[]; message: string }[] = [];
  readonly pushes: string[] = [];
  readonly starts: { branch: string; base?: string }[] = [];
  private branch = "main";

  startBranch(branch: string, base?: string): Promise<void> {
    this.starts.push({ branch, ...(base === undefined ? {} : { base }) });
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
    this.commits.push({
      branch: this.branch,
      paths: [...paths].sort(),
      message,
    });
    for (const p of paths) this.files.delete(p);
    return Promise.resolve(`commit-${this.commits.length}`);
  }
  push(branch: string): Promise<void> {
    this.pushes.push(branch);
    return Promise.resolve();
  }
}

/** PR を覚えるだけの GitHub */
class FakeBoard {
  readonly created: {
    number: number;
    url: string;
    head: string;
    title: string;
    body: string;
  }[] = [];

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
}

type SpecRun = RoleRun<typeof specifierOutputSchema>;
type Reply = (run: SpecRun) => SpecifierOutput;

/** 疑問を返す役 */
function ask(questions: { question: string; recommendation: string }[]): Reply {
  return () => ({
    verdict: "objection",
    summary: "疑問があります",
    findings: [],
    questions,
  });
}

/** 仕様を書く役（作業ツリーにファイルを置く） */
function write(git: FakeGit, files: string[], summary: string): Reply {
  return () => {
    for (const f of files) git.files.add(f);
    return { verdict: "approve", summary, findings: [], questions: [] };
  };
}

/** 決めた順（replies に足した順）に答える偽の役。呼ばれた依頼を覚える */
function fakeRole(replies: Reply[] = []) {
  const runs: SpecRun[] = [];
  const run = (r: SpecRun): Promise<RoleResult<SpecifierOutput>> => {
    runs.push(r);
    const reply = replies.shift();
    if (reply === undefined)
      throw new Error("仕様化役の答えを用意していません");
    return Promise.resolve({
      output: reply(r),
      denials: [],
      costUsd: 0,
      turns: 1,
      sessionId: `session-${runs.length}`,
    });
  };
  return { run, runs, replies };
}

/**
 * 常駐ループの部品。Issue の列は空で、Issue の各役は呼ばれない。
 * run を渡さなければ偽の仕様化役（role）を使う。答えは role.replies に足す
 */
function setup(options: {
  chat: MemoryChat;
  store: Store;
  run?: SpecifierDeps["run"];
  config?: Config;
  instructions?: string;
}) {
  const config = options.config ?? makeConfig();
  const git = new FakeGit();
  const board = new FakeBoard();
  const role = fakeRole();
  const specifierDeps: SpecifierDeps = {
    config,
    repoDir: "/repo",
    chat: options.chat,
    store: options.store,
    git,
    board,
    run: options.run ?? role.run,
    instructions: options.instructions ?? "",
    log: () => {},
  };
  const never = () => Promise.reject(new Error("Issue の処理は呼ばれない"));
  const deps: LoopDeps = {
    config,
    store: options.store,
    chat: options.chat,
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
    log: () => {},
  };
  return { deps, git, board, role };
}

/** スレッドに Bot が書いた文 */
function botTexts(chat: MemoryChat, threadId: string): string[] {
  return (chat.messages.get(threadId) ?? [])
    .filter((m) => m.authorId === chat.botId)
    .map((m) => m.text);
}

/** スレッド以外（チャンネル）に Bot が書いた数 */
function botPostsOutsideThreads(chat: MemoryChat): number {
  return [REQUIREMENTS, QUESTIONS, NOTICES]
    .flatMap((c) => chat.messages.get(c) ?? [])
    .filter((m) => m.authorId === chat.botId).length;
}

const Q1 = {
  question: "検索は前方一致だけでよいですか",
  recommendation: "前方一致だけにする",
};
const Q2 = {
  question: "検索の対象は単語だけですか、意味も含めますか",
  recommendation: "単語だけにする",
};
const Q3 = {
  question: "検索結果が0件のときに何を出しますか",
  recommendation: "「見つかりませんでした」と出す",
};

let dir: string;

beforeEach(() => {
  now = new Date("2026-11-19T00:00:00.000Z");
  dir = mkdtempSync(join(tmpdir(), "conductor-42-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("Issue #42: 仕様化役", () => {
  it("AC1: 新しい要件で仕様化役を起動すると、疑問を番号とおすすめの答えつきで1つにまとめてスレッドに書き、「全部おすすめでよい」と1行で返せることも書く", async () => {
    const chat = new MemoryChat(BOT);
    const store = new MemoryStore(clock);
    // Given: 新しい要件
    const { threadId } = await seedRequirement(chat, store);
    const before = botTexts(chat, threadId).length;
    const { deps, role } = setup({ chat, store });
    role.replies.push(ask([Q1, Q2]));

    // When: 仕様化役を起動する（次の確認）
    await tick(deps, newLoopState());

    // Then: 仕様化役に要件を渡して起動する
    expect(role.runs).toHaveLength(1);
    expect(role.runs[0]!.prompt).toContain("単語帳に検索をつけたい");
    expect(role.runs[0]!.prompt).toContain("前方一致で探せるように");

    // Then: 疑問を1つの書き込みにまとめてスレッドに書く
    const added = botTexts(chat, threadId).slice(before);
    expect(added).toHaveLength(1);
    const text = added[0]!;

    // 番号とおすすめの答えつき（1. 疑問 → おすすめ → 2. 疑問 → おすすめ の順）
    const q1 = text.search(/1\.\s*検索は前方一致だけでよいですか/);
    const r1 = text.indexOf("おすすめ: 前方一致だけにする");
    const q2 = text.search(
      /2\.\s*検索の対象は単語だけですか、意味も含めますか/,
    );
    const r2 = text.indexOf("おすすめ: 単語だけにする");
    expect(q1).toBeGreaterThanOrEqual(0);
    expect(r1).toBeGreaterThan(q1);
    expect(q2).toBeGreaterThan(r1);
    expect(r2).toBeGreaterThan(q2);

    // 「全部おすすめでよい」と1行で返せることも書く
    expect(text).toContain("全部おすすめでよい");

    // スレッドの外には書かない
    expect(botPostsOutsideThreads(chat)).toBe(1); // seed の受け取りの書き込みだけ
  });

  it("AC2: 人がスレッドに返事を書くと、次の確認で仕様化役を新しく起動して要件とやり取りをすべて渡し、新しい疑問をまたまとめて書く", async () => {
    const chat = new MemoryChat(BOT);
    const store = new MemoryStore(clock);
    const { threadId } = await seedRequirement(chat, store);
    const { deps, role } = setup({ chat, store });
    role.replies.push(ask([Q1, Q2]), ask([Q3]));
    await tick(deps, newLoopState());
    expect(role.runs).toHaveLength(1);

    // Given: 人がスレッドに返事を書いた
    chat.addMessage(threadId, {
      authorId: ALLOWED,
      text: "1 は部分一致にしてください",
    });
    chat.addMessage(threadId, { authorId: ALLOWED, text: "2 はおすすめで" });
    const before = botTexts(chat, threadId).length;

    // When: 次の確認
    await tick(deps, newLoopState());

    // Then: 仕様化役を新しく起動する（2回目の起動）
    expect(role.runs).toHaveLength(2);

    // Then: 要件とスレッドのやり取りをすべて渡す
    const prompt = role.runs[1]!.prompt;
    expect(prompt).toContain("単語帳に検索をつけたい");
    expect(prompt).toContain("前方一致で探せるように");
    expect(prompt).toContain(Q1.question);
    expect(prompt).toContain(Q1.recommendation);
    expect(prompt).toContain(Q2.question);
    expect(prompt).toContain("1 は部分一致にしてください");
    expect(prompt).toContain("2 はおすすめで");

    // Then: 新しい疑問を、またまとめて書く
    const added = botTexts(chat, threadId).slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]).toContain(Q3.question);
    expect(added[0]).toContain(`おすすめ: ${Q3.recommendation}`);
    expect(added[0]).toContain("全部おすすめでよい");
  });

  it("AC3: 疑問がなくなると、仕様を docs/specs/ に、方針を .conductor/knowledge/ に入れて1本の PR にし、要約と PR のリンクをスレッドに書く", async () => {
    const chat = new MemoryChat(BOT);
    const store = new MemoryStore(clock);
    const { messageId, threadId } = await seedRequirement(chat, store);
    const { deps, git, board, role: scripted } = setup({ chat, store });
    const summary = "単語帳の前方一致の検索の仕様を書きました";
    scripted.replies.push(
      ask([Q1, Q2]),
      write(git, [SPEC_FILE, KNOWLEDGE_FILE], summary),
    );
    await tick(deps, newLoopState());

    // Given: 疑問がなくなった（人が「全部おすすめでよい」と返した）
    chat.addMessage(threadId, {
      authorId: ALLOWED,
      text: "全部おすすめでよい",
    });
    const before = botTexts(chat, threadId).length;

    // When: 仕様化役が仕様を書く（次の確認）
    await tick(deps, newLoopState());
    expect(scripted.runs).toHaveLength(2);
    expect(scripted.runs[1]!.prompt).toContain("全部おすすめでよい");

    // Then: 仕様（docs/specs/）と方針（.conductor/knowledge/）を1本のブランチにコミットして push する
    const committed = git.commits.flatMap((c) => c.paths);
    expect(committed).toContain(SPEC_FILE);
    expect(committed).toContain(KNOWLEDGE_FILE);
    const branches = new Set(git.commits.map((c) => c.branch));
    expect(branches.size).toBe(1);
    const [branch] = [...branches];
    expect(branch).not.toBe("main");
    expect(git.pushes).toContain(branch);

    // Then: 1本の PR にする
    expect(board.created).toHaveLength(1);
    const pr = board.created[0]!;
    expect(pr.head).toBe(branch);

    // Then: PR の番号を要件の記録に残す
    expect((await store.getRequirement(messageId))?.specPr).toBe(pr.number);

    // Then: 要約と PR のリンクをスレッドに書く
    const added = botTexts(chat, threadId).slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]).toContain(summary);
    expect(added[0]).toContain(pr.url);

    // Then: 仕様化役には、置き場所と「方針○○により判断」と書くことを指示している
    const system = scripted.runs[1]!.systemPrompt;
    expect(system).toContain(SPECIFIER_RULES);
    expect(SPECIFIER_RULES).toContain("docs/specs/");
    expect(SPECIFIER_RULES).toContain(".conductor/knowledge/");
    expect(SPECIFIER_RULES).toMatch(/方針.*により判断/);
  });

  it("AC4: 要約のあとに ✅ 以外の書き込みがあると、次の確認で修正の依頼として仕様化役に渡し、同じ PR を直して要約を書き直す", async () => {
    const chat = new MemoryChat(BOT);
    const store = new MemoryStore(clock);
    const { messageId, threadId } = await seedRequirement(chat, store);
    const { deps, git, board, role: scripted } = setup({ chat, store });
    scripted.replies.push(
      ask([Q1]),
      write(
        git,
        [SPEC_FILE, KNOWLEDGE_FILE],
        "前方一致の検索の仕様を書きました",
      ),
      write(git, [SPEC_FILE], "検索を部分一致に直しました"),
    );
    await tick(deps, newLoopState());
    chat.addMessage(threadId, {
      authorId: ALLOWED,
      text: "全部おすすめでよい",
    });
    await tick(deps, newLoopState());
    expect(board.created).toHaveLength(1);
    const pr = board.created[0]!;
    const commitsBefore = git.commits.length;

    // Given: 要約のあとに ✅ 以外の書き込みがあった
    chat.addMessage(threadId, {
      authorId: ALLOWED,
      text: "検索は部分一致にしてください",
    });
    const before = botTexts(chat, threadId).length;

    // When: 次の確認
    await tick(deps, newLoopState());

    // Then: 修正の依頼として仕様化役に渡す
    expect(scripted.runs).toHaveLength(3);
    expect(scripted.runs[2]!.prompt).toContain("検索は部分一致にしてください");

    // Then: 同じ PR（同じブランチ）を直す。PR は新しく作らない
    const fixes = git.commits.slice(commitsBefore);
    expect(fixes.length).toBeGreaterThan(0);
    expect(fixes.flatMap((c) => c.paths)).toContain(SPEC_FILE);
    expect(new Set(fixes.map((c) => c.branch))).toEqual(new Set([pr.head]));
    expect(git.pushes.at(-1)).toBe(pr.head);
    expect(board.created).toHaveLength(1);
    expect((await store.getRequirement(messageId))?.specPr).toBe(pr.number);

    // Then: 要約を書き直す（新しい要約と同じ PR のリンク）
    const added = botTexts(chat, threadId).slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]).toContain("検索を部分一致に直しました");
    expect(added[0]).toContain(pr.url);

    // ✅ の書き込みは修正の依頼にしない（承認の判定は次の Issue）
    chat.addMessage(threadId, { authorId: ALLOWED, text: "✅" });
    const afterFix = botTexts(chat, threadId).length;
    const commitsAfterFix = git.commits.length;
    await tick(deps, newLoopState());
    expect(scripted.runs).toHaveLength(3);
    expect(git.commits).toHaveLength(commitsAfterFix);
    expect(botTexts(chat, threadId)).toHaveLength(afterFix);
  });

  it("AC5: 返事が来ないまま確認を続けても催促しない", async () => {
    const chat = new MemoryChat(BOT);
    const store = new MemoryStore(clock);
    const { threadId } = await seedRequirement(chat, store);
    const { deps, git, board, role: scripted } = setup({ chat, store });
    scripted.replies.push(
      ask([Q1]),
      write(git, [SPEC_FILE, KNOWLEDGE_FILE], "仕様を書きました"),
    );

    // Given: 疑問を書いたが、返事が来ない
    await tick(deps, newLoopState());
    expect(scripted.runs).toHaveLength(1);
    const asked = botTexts(chat, threadId).length;
    const outside = botPostsOutsideThreads(chat);

    // When: 日をまたいで確認を続ける
    for (let i = 0; i < 5; i++) {
      advanceDays(1);
      await tick(deps, newLoopState());
    }

    // Then: 催促しない（役も起動せず、どこにも書かない）
    expect(scripted.runs).toHaveLength(1);
    expect(botTexts(chat, threadId)).toHaveLength(asked);
    expect(botPostsOutsideThreads(chat)).toBe(outside);

    // 要約を書いた後も、返事が来なければ催促しない
    chat.addMessage(threadId, {
      authorId: ALLOWED,
      text: "全部おすすめでよい",
    });
    await tick(deps, newLoopState());
    expect(scripted.runs).toHaveLength(2);
    expect(board.created).toHaveLength(1);
    const summarized = botTexts(chat, threadId).length;
    const commits = git.commits.length;
    for (let i = 0; i < 5; i++) {
      advanceDays(1);
      await tick(deps, newLoopState());
    }
    expect(scripted.runs).toHaveLength(2);
    expect(botTexts(chat, threadId)).toHaveLength(summarized);
    expect(botPostsOutsideThreads(chat)).toBe(outside);
    expect(git.commits).toHaveLength(commits);
    expect(board.created).toHaveLength(1);
  });

  it("AC6: 仕様化役が質問すると、要件ごとの質問の数が SQLite に残る", async () => {
    const file = join(dir, "conductor.db");
    const chat = new MemoryChat(BOT);
    const store = new SqliteStore(file, clock);
    const { messageId, otherId } = await (async () => {
      try {
        // Given: 要件が2件（質問するのは片方だけ）
        const seeded = await seedRequirement(chat, store);
        const other = chat.addMessage(REQUIREMENTS, {
          authorId: ALLOWED,
          text: "CSV で書き出したい",
        });
        await store.updateRequirement(other.id, {});
        await store.setReadPosition(REQUIREMENTS, other.id);

        const { deps, role: scripted } = setup({ chat, store });
        scripted.replies.push(ask([Q1, Q2, Q3]), ask([Q1, Q2]));

        // When: 仕様化役が質問した（3問）→ 返事 → また質問した（2問）
        await tick(deps, newLoopState());
        const first = await store.getRequirement(seeded.messageId);
        expect(first?.questions).toBe(3);
        chat.addMessage(seeded.threadId, {
          authorId: ALLOWED,
          text: "全部おすすめでよい",
        });
        await tick(deps, newLoopState());
        expect(scripted.runs).toHaveLength(2);
        return { messageId: seeded.messageId, otherId: other.id };
      } finally {
        await store.close();
      }
    })();

    // Then: 開き直しても、要件ごとの質問の数が残っている
    const reopened = new SqliteStore(file, clock);
    try {
      expect((await reopened.getRequirement(messageId))?.questions).toBe(5);
      expect((await reopened.getRequirement(otherId))?.questions).toBe(0);
    } finally {
      await reopened.close();
    }
  });

  it("AC7: roles/ の追加指示と language の設定があると、仕様化役を起動したとき他の役と同じく追加指示と言語の指示が入る", async () => {
    // Given: 仕様化役の追加指示（.conductor/specifier/*.md）と language: English
    const repoDir = join(dir, "repo");
    mkdirSync(join(repoDir, ".conductor", "specifier"), { recursive: true });
    writeFileSync(
      join(repoDir, ".conductor", "specifier", "screens.md"),
      "仕様には必ず画面の URL を書く",
      "utf8",
    );
    const instructions = await loadRoleInstructions(repoDir, "specifier");
    expect(instructions).toContain("仕様には必ず画面の URL を書く");
    const config = makeConfig(["language: English"]);

    // claude は偽物。渡された決まり（--append-system-prompt-file）を読んで覚える
    const systemPrompts: string[] = [];
    const claude: ClaudeDeps = {
      exec: (args) => {
        const i = args.indexOf("--append-system-prompt-file");
        systemPrompts.push(readFileSync(args[i + 1]!, "utf8"));
        const output: SpecifierOutput = {
          verdict: "objection",
          summary: "There are open questions",
          findings: [],
          questions: [Q1],
        };
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({
            type: "result",
            subtype: "success",
            is_error: false,
            result: "",
            structured_output: output,
            session_id: "s1",
            total_cost_usd: 0,
            num_turns: 1,
            permission_denials: [],
          }),
          stderr: "",
        });
      },
      sleep: () => Promise.resolve(),
      now: clock,
    };

    const chat = new MemoryChat(BOT);
    const store = new MemoryStore(clock);
    const { threadId } = await seedRequirement(chat, store);
    const { deps } = setup({
      chat,
      store,
      config,
      instructions,
      // start.ts と同じく、すべての役が通る roleRunner で起動する
      run: roleRunner(config, claude),
    });

    // When: 仕様化役を起動する
    await tick(deps, newLoopState());

    // Then: 他の役と同じく、決まりに追加指示と言語の指示が入る
    expect(systemPrompts).toHaveLength(1);
    const system = systemPrompts[0]!;
    expect(system).toContain(SPECIFIER_RULES);
    expect(system).toContain(instructions);
    expect(system).toContain(languageRule("English"));
    expect(system.indexOf(SPECIFIER_RULES)).toBeLessThan(
      system.indexOf(instructions),
    );

    // 役の結果どおり、疑問をスレッドに書いている
    expect(botTexts(chat, threadId).join("\n")).toContain(Q1.question);
  });
});

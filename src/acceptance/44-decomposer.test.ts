/**
 * Issue #44: 分解役の受け入れテスト
 *
 * 決めた名前（実装役はこれに合わせて作る）:
 * - 新しいモジュール `src/decomposer.ts`
 *   ```ts
 *   // 作業用 Issue 1件分。D8（入口確認の書式）の見出しに合わせた項目を持つ
 *   export const workIssueSchema = z.object({
 *     key: z.string(),          // 分解役が付ける仮の名前（dependsOn で指す。Issue 番号はまだ無い）
 *     title: z.string(),        // Issue のタイトル
 *     purpose: z.string(),      // 「目的」
 *     acceptance: z.string(),   // 「受け入れ条件（AC）」。"- AC1\n  - Given …\n  - When …\n  - Then …" の形
 *     screens: z.string(),      // 「画面の URL・文言」（無ければ「なし」）
 *     outOfScope: z.string(),   // 「対象外」
 *     dependsOn: z.array(z.string()), // 先に済ませる Issue の key
 *   }).strict();
 *
 *   // 役の結果の形。共通の項目（verdict・summary・findings）に issues を足す
 *   export const decomposerOutputSchema = roleOutput({ issues: z.array(workIssueSchema) });
 *   export type DecomposerOutput = z.infer<typeof decomposerOutputSchema>;
 *
 *   export interface DecomposerBoard {
 *     // 仕様の PR で変えたファイル（仕様ファイル docs/specs/ を探すのに使う）
 *     pullRequestFiles(pr: number): Promise<string[]>;
 *     // Issue を作る
 *     createIssue(input: { title: string; body: string }): Promise<{ number: number; url: string }>;
 *     // Issue を Project に追加する（列は動かさない。Ready に移すのは次の Issue）
 *     addToProject(issue: number): Promise<void>;
 *   }
 *
 *   export interface DecomposerDeps {
 *     config: Config;   // config.chat がある前提
 *     repoDir: string;
 *     chat: Chat;
 *     store: Store;
 *     board: DecomposerBoard;
 *     run: (run: RoleRun<typeof decomposerOutputSchema>) => Promise<RoleResult<DecomposerOutput>>;
 *     instructions: string;
 *     model?: string;
 *     log(text: string): void;
 *   }
 *
 *   // 分解に進めた要件1件を分解する（作業用 Issue を作り終えていれば何もしない）
 *   export function runDecomposer(deps: DecomposerDeps, requirement: RequirementRecord):
 *     Promise<{ status: string }>;
 *   ```
 * - 分解役の振る舞い
 *   - 役の名前は "decomposer"。依頼文に仕様ファイル（仕様の PR で変えた docs/specs/ のファイル）のパスを入れる
 *   - 分解役は Issue を作らない・ファイルを書かない（許可は読むだけ。Edit・Write・Bash は渡さない）
 *   - conductor は各 Issue の本文を「## 目的」「## 受け入れ条件（AC）」「## 画面の URL・文言」「## 対象外」
 *     「## 先に済ませる Issue」の見出しで組み立て、intake.ts の checkIssueBody（D8）で確かめる
 *   - 本文には仕様ファイルへのリンク（https://github.com/<repo>/blob/<ブランチ>/docs/specs/…）を入れる
 *   - 「先に済ませる Issue」には、dependsOn の Issue を `#番号` で書く（先に済ませる Issue から作る）
 *   - 作った Issue を Project に追加し、要件の記録の workIssues に作業の順番（先に済ませるものが前）で入れる
 *   - 書式の誤り（checkIssueBody の誤り、無い key を dependsOn で指す）や dependsOn の循環があれば、
 *     Issue を1件も作らずに、誤りを依頼文に入れて分解役をやり直させる（1回の runDecomposer の中で）
 *   - やり直しは config.limits.rejections 回まで（最初の1回と合わせて rejections + 1 回起動する）。
 *     それでも誤りがあれば、要件のスレッドに理由を書き、要件の状態を "blocked" にして止める
 *   - Issue を作り終えたら、Issue の一覧（`#番号`・タイトル・URL）を作業の順番に並べてスレッドに書く。
 *     一覧の承認は取らない（✅ を求めず、そのまま次へ進む）
 * - `src/store.ts` の `REQUIREMENT_STATES` に "blocked"（止めた）を足す
 * - `src/loop.ts` の `LoopDeps` に、省略できる項目を足す
 *   ```ts
 *   decompose?: (requirement: RequirementRecord) => Promise<StepResult>;
 *   ```
 *   `tick` は仕様の承認の確認の後、スレッドがあり状態が working で workIssues が空の要件ごとに
 *   `decompose` を呼ぶ（失敗しても Issue の処理は止めない）
 *
 * Given の「承認された仕様」は、#43 の承認が済んだ状態（仕様の PR はマージ済み、スレッドはアーカイブして
 * ロック済み、要件は working）を直接 seed する。
 * 窓口は MemoryChat、GitHub と claude は偽物、記録は MemoryStore（AC2 は SQLite を一時フォルダに作る）を使う。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MemoryChat } from "../chat.js";
import type { RoleResult, RoleRun } from "../claude.js";
import { type Config, parseConfig } from "../config.js";
import {
  type DecomposerBoard,
  type DecomposerDeps,
  type DecomposerOutput,
  decomposerOutputSchema,
  runDecomposer,
} from "../decomposer.js";
import { checkIssueBody } from "../intake.js";
import { type LoopDeps, newLoopState, tick } from "../loop.js";
import { approvedMessage } from "../spec-approval.js";
import { summaryMessage } from "../specifier.js";
import { SqliteStore } from "../sqlite-store.js";
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
const KNOWLEDGE_FILE = ".conductor/knowledge/search-policy.md";
const REQUIREMENT_TEXT = "単語帳に検索をつけたい\n前方一致で探せるように";

const clock = () => new Date("2026-11-19T00:00:00.000Z");

function makeConfig(options: { rejections?: number } = {}): Config {
  return parseConfig(
    [
      `github: { repo: ${REPO}, project: 3, notify: someone }`,
      "protected: [src/acceptance/**]",
      "commands: { setup: s, test: t, acceptance: a, typecheck: c, build: b }",
      ...(options.rejections === undefined
        ? []
        : [`limits: { rejections: ${options.rejections} }`]),
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
 * 仕様が承認された要件（#43 の承認が済んだ状態）を作る。
 * スレッドには要件の引用・要約・承認の書き込みがあり、スレッドはアーカイブしてロック済み。
 * 要件は working（分解に進めた）で、作業用 Issue はまだ無い
 */
async function seedApprovedSpec(chat: MemoryChat, store: Store) {
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

interface CreatedIssue {
  number: number;
  url: string;
  title: string;
  body: string;
}

/** Issue の作成と Project への追加を覚えるだけの GitHub */
class FakeBoard implements DecomposerBoard {
  readonly issues: CreatedIssue[] = [];
  readonly projectAdded: number[] = [];
  readonly moved: { issue: number; column: string }[] = [];

  pullRequestFiles(pr: number): Promise<string[]> {
    if (pr !== SPEC_PR) return Promise.reject(new Error(`PR #${pr} は無い`));
    return Promise.resolve([SPEC_FILE, KNOWLEDGE_FILE]);
  }
  createIssue(input: { title: string; body: string }) {
    const number = 201 + this.issues.length;
    const url = `https://github.com/${REPO}/issues/${number}`;
    this.issues.push({ number, url, ...input });
    return Promise.resolve({ number, url });
  }
  addToProject(issue: number): Promise<void> {
    this.projectAdded.push(issue);
    return Promise.resolve();
  }
  /** 常駐ループの列の移動（Ready に移すのは次の Issue なので呼ばれない） */
  moveIssue(issue: number, column: string): Promise<void> {
    this.moved.push({ issue, column });
    return Promise.resolve();
  }
}

type DecomposeRun = RoleRun<typeof decomposerOutputSchema>;
type WorkIssue = DecomposerOutput["issues"][number];

/** 決めた順に答える偽の分解役 */
function fakeRole() {
  const replies: (() => DecomposerOutput)[] = [];
  const runs: DecomposeRun[] = [];
  const run = (r: DecomposeRun): Promise<RoleResult<DecomposerOutput>> => {
    runs.push(r);
    const reply = replies.shift();
    if (reply === undefined) throw new Error("分解役の答えを用意していません");
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

/** 書式どおりの作業用 Issue */
function workIssue(
  key: string,
  title: string,
  dependsOn: string[],
  override: Partial<WorkIssue> = {},
): WorkIssue {
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
    ...override,
  };
}

/**
 * 分解の結果（順番が一意に決まる）。わざと順番どおりでない並びで返す。
 * 作業の順番は index → api → ui
 */
const UI = workIssue("search-ui", "検索の画面を作る", [
  "search-index",
  "search-api",
]);
const API = workIssue("search-api", "検索の API を作る", ["search-index"]);
const INDEX = workIssue("search-index", "検索の索引を作る", []);
const ORDERED_TITLES = [INDEX.title, API.title, UI.title];

function decomposition(issues: WorkIssue[]): () => DecomposerOutput {
  return () => ({
    verdict: "approve",
    summary: `${issues.length} 件に分けました`,
    findings: [],
    issues,
  });
}

/** 常駐ループの部品。Issue の列は空で、Issue の各役は呼ばれない。分解（decompose）をつなぐ */
function setup(chat: MemoryChat, store: Store, config = makeConfig()) {
  const board = new FakeBoard();
  const role = fakeRole();
  const decomposerDeps: DecomposerDeps = {
    config,
    repoDir: "/repo",
    chat,
    store,
    board,
    run: role.run,
    instructions: "",
    log: () => {},
  };
  const never = () => Promise.reject(new Error("Issue の処理は呼ばれない"));
  const deps: LoopDeps = {
    config,
    store,
    chat,
    board: {
      issuesByColumn: () => Promise.resolve(new Map()),
      moveIssue: (issue, column) => board.moveIssue(issue, column),
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
    decompose: (requirement) => runDecomposer(decomposerDeps, requirement),
    log: () => {},
  };
  return { deps, board, role };
}

/** スレッドに Bot が書いた書き込み */
function botMessages(chat: MemoryChat, threadId: string) {
  return (chat.messages.get(threadId) ?? []).filter(
    (m) => m.authorId === chat.botId,
  );
}

/** 「先に済ませる Issue」の見出しの中身 */
function prerequisiteSection(body: string): string {
  const m = /^##\s*先に済ませる Issue\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(
    body,
  );
  return m?.[1] ?? "";
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "conductor-44-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("Issue #44: 分解役", () => {
  it("AC1: 承認された仕様で分解役を起動すると、作業用 Issue の中身（目的・AC・画面の URL と文言・対象外）と順番（先に済ませる Issue）を JSON で返させる", async () => {
    // Given: 承認された仕様
    const chat = new MemoryChat(BOT);
    const store = new MemoryStore(clock);
    await seedApprovedSpec(chat, store);
    const { deps, role } = setup(chat, store);
    role.replies.push(decomposition([UI, API, INDEX]));

    // When: 分解役を起動する（次の確認）
    await tick(deps, newLoopState());

    // Then: 分解役を1回起動し、仕様ファイルを読ませる
    expect(role.runs).toHaveLength(1);
    const run = role.runs[0]!;
    expect(run.role).toBe("decomposer");
    expect(run.prompt).toContain(SPEC_FILE);

    // Then: 結果は JSON（決めた形）で返させる
    expect(run.schema).toBe(decomposerOutputSchema);
    const sample = decomposition([UI, API, INDEX])();
    expect(decomposerOutputSchema.safeParse(sample).success).toBe(true);
    // 中身の項目（目的・AC・画面の URL と文言・対象外）と順番（先に済ませる Issue）が欠けた JSON は受け付けない
    for (const field of [
      "title",
      "purpose",
      "acceptance",
      "screens",
      "outOfScope",
      "dependsOn",
    ] as const) {
      const broken = structuredClone(sample) as unknown as {
        issues: Record<string, unknown>[];
      };
      delete broken.issues[0]![field];
      expect(
        decomposerOutputSchema.safeParse(broken).success,
        `${field} が無い JSON`,
      ).toBe(false);
    }

    // Then: Issue の作成は conductor が行う（分解役に書き込み・コマンドの許可を渡さない）
    for (const allowed of run.allow) {
      expect(allowed).not.toMatch(/^(Edit|Write|MultiEdit|Bash)\b/);
    }
  });

  it("AC2: conductor が分解役の JSON を受け取ると、D8 の書式を確かめ、仕様ファイルへのリンクを付けて Issue を作り、Project に追加し、順番を SQLite に記録する", async () => {
    const file = join(dir, "conductor.db");
    const chat = new MemoryChat(BOT);
    const store = new SqliteStore(file, clock);
    const { messageId, board } = await (async () => {
      try {
        // Given: 分解役の JSON（順番どおりでない並びで返す）
        const seeded = await seedApprovedSpec(chat, store);
        const ctx = setup(chat, store);
        ctx.role.replies.push(decomposition([UI, API, INDEX]));

        // When: conductor が受け取る
        await tick(ctx.deps, newLoopState());
        return { messageId: seeded.messageId, board: ctx.board };
      } finally {
        await store.close();
      }
    })();

    // Then: 3件の Issue を作る
    expect(board.issues).toHaveLength(3);
    const byTitle = new Map(board.issues.map((i) => [i.title, i]));
    expect([...byTitle.keys()].sort()).toEqual([...ORDERED_TITLES].sort());

    for (const issue of board.issues) {
      // Then: 入口確認と同じ書式（D8）になっている
      expect(checkIssueBody(issue.body), issue.title).toEqual([]);
      // Then: 仕様ファイルへのリンクが付いている
      expect(issue.body).toMatch(
        /https:\/\/github\.com\/pkshimizu\/wordcards\/blob\/[^\s)]+\/docs\/specs\/word-search\.md/,
      );
    }
    // 中身は分解役の JSON のとおり
    const ui = byTitle.get(UI.title)!;
    expect(ui.body).toContain(UI.purpose);
    expect(ui.body).toContain("「ap」で検索する");
    expect(ui.body).toContain(UI.outOfScope);

    // Then: 先に済ませる Issue を番号で書く
    const index = byTitle.get(INDEX.title)!;
    const api = byTitle.get(API.title)!;
    const uiPrereq = prerequisiteSection(ui.body);
    expect(uiPrereq).toContain(`#${index.number}`);
    expect(uiPrereq).toContain(`#${api.number}`);
    const apiPrereq = prerequisiteSection(api.body);
    expect(apiPrereq).toContain(`#${index.number}`);
    expect(apiPrereq).not.toContain(`#${ui.number}`);

    // Then: Project に追加する（Ready には移さない）
    expect([...board.projectAdded].sort()).toEqual(
      board.issues.map((i) => i.number).sort(),
    );
    expect(board.moved).toEqual([]);

    // Then: 順番（先に済ませるものが前）を SQLite に記録する。開き直しても残っている
    const reopened = new SqliteStore(file, clock);
    try {
      const record = await reopened.getRequirement(messageId);
      expect(record?.workIssues).toEqual([index.number, api.number, ui.number]);
      expect(record?.state).toBe("working");
    } finally {
      await reopened.close();
    }
  });

  it("AC3: 書式の誤り、または順番が循環している JSON を受け取ると、誤りを示して分解役にやり直させ、上限回数を超えたら要件のスレッドに理由を書いて要件を止める", async () => {
    // ---- 書式の誤り → やり直しで直る ----
    {
      // Given: 書式の誤り（AC に Then が無い）がある JSON
      const chat = new MemoryChat(BOT);
      const store = new MemoryStore(clock);
      const { messageId } = await seedApprovedSpec(chat, store);
      const { deps, board, role } = setup(
        chat,
        store,
        makeConfig({ rejections: 2 }),
      );
      const broken = workIssue("search-api", "検索の API を作る", [
        "search-index",
      ]);
      broken.acceptance = [
        "- AC1",
        "  - Given 単語「apple」がある",
        "  - When 「ap」で検索する",
      ].join("\n");
      role.replies.push(
        decomposition([UI, broken, INDEX]),
        decomposition([UI, API, INDEX]),
      );

      // When: conductor が受け取る
      await tick(deps, newLoopState());

      // Then: 誤りを示して分解役にやり直させる
      expect(role.runs).toHaveLength(2);
      const retry = role.runs[1]!.prompt;
      expect(retry).toContain("Then がありません");
      expect(retry).toMatch(/search-api|検索の API を作る/);

      // 誤りのある JSON からは Issue を作らず、やり直した JSON から作る
      expect(board.issues).toHaveLength(3);
      for (const issue of board.issues) {
        expect(checkIssueBody(issue.body)).toEqual([]);
      }
      const record = await store.getRequirement(messageId);
      expect(record?.workIssues).toHaveLength(3);
      expect(record?.state).toBe("working");
    }

    // ---- 順番の循環 → 上限を超えて止まる ----
    {
      // Given: 順番が循環している JSON（何度やり直しても循環している）
      const chat = new MemoryChat(BOT);
      const store = new MemoryStore(clock);
      const { messageId, threadId } = await seedApprovedSpec(chat, store);
      const { deps, board, role } = setup(
        chat,
        store,
        makeConfig({ rejections: 2 }),
      );
      const cyclic = decomposition([
        workIssue("search-index", "検索の索引を作る", ["search-ui"]),
        workIssue("search-api", "検索の API を作る", ["search-index"]),
        workIssue("search-ui", "検索の画面を作る", ["search-api"]),
      ]);
      role.replies.push(cyclic, cyclic, cyclic);
      const before = botMessages(chat, threadId).length;

      // When: conductor が受け取る
      await tick(deps, newLoopState());

      // Then: 循環していることを示してやり直させる（最初の1回 + やり直し2回）
      expect(role.runs).toHaveLength(3);
      for (const r of role.runs.slice(1)) {
        expect(r.prompt).toContain("循環");
        expect(r.prompt).toContain("search-index");
      }

      // Then: 上限を超えたら Issue を作らず、要件のスレッドに理由を書く
      expect(board.issues).toEqual([]);
      expect(board.projectAdded).toEqual([]);
      const added = botMessages(chat, threadId).slice(before);
      expect(added).toHaveLength(1);
      expect(added[0]!.text).toContain("循環");

      // Then: その要件を止める
      const record = await store.getRequirement(messageId);
      expect(record?.state).toBe("blocked");
      expect(record?.workIssues).toEqual([]);

      // 止めた要件は、次の確認でも分解役を起動しない
      await tick(deps, newLoopState());
      expect(role.runs).toHaveLength(3);
      expect(botMessages(chat, threadId).slice(before)).toHaveLength(1);
    }
  });

  it("AC4: Issue を作り終えたら、Issue の一覧と順番を要件のスレッドに書く（一覧の承認は取らない）", async () => {
    // Given: 承認された仕様と分解役の JSON
    const chat = new MemoryChat(BOT);
    const store = new MemoryStore(clock);
    const { messageId, threadId } = await seedApprovedSpec(chat, store);
    const { deps, board, role } = setup(chat, store);
    role.replies.push(decomposition([UI, API, INDEX]));
    const before = botMessages(chat, threadId).length;

    // When: Issue を作り終えて一覧を書く
    await tick(deps, newLoopState());
    expect(board.issues).toHaveLength(3);

    // Then: Issue の一覧を1つの書き込みにまとめて要件のスレッドに書く
    const added = botMessages(chat, threadId).slice(before);
    expect(added).toHaveLength(1);
    const text = added[0]!.text;
    const byTitle = new Map(board.issues.map((i) => [i.title, i]));
    const ordered = ORDERED_TITLES.map((t) => byTitle.get(t)!);
    for (const issue of ordered) {
      expect(text).toContain(`#${issue.number}`);
      expect(text).toContain(issue.title);
      expect(text).toContain(issue.url);
    }

    // Then: 作業の順番（先に済ませるものが前）に並べて書く
    const positions = ordered.map((i) => text.indexOf(i.url));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));

    // Then: 一覧の承認は取らない（✅ を求めず、要件は作業中のまま進む）
    expect(text).not.toContain("✅");
    const record = await store.getRequirement(messageId);
    expect(record?.state).toBe("working");
    expect(record?.workIssues).toEqual(ordered.map((i) => i.number));

    // 次の確認でも、分解役を起動し直したり一覧を書き直したりしない
    await tick(deps, newLoopState());
    expect(role.runs).toHaveLength(1);
    expect(board.issues).toHaveLength(3);
    expect(botMessages(chat, threadId).slice(before)).toHaveLength(1);
  });
});

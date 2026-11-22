/**
 * Issue #103: GitHub・Discord に投稿する文の「～役」を「～エージェント」に変える の受け入れテスト
 *
 * 決めたこと（実装エージェントはこれに合わせて作る）:
 * - 呼び名は docs/specs/agent-naming.md の「1. 呼び名を変える」の表のとおり。
 *   テスト役→テストエージェント、実装役→実装エージェント、レビュー役→レビューエージェント、
 *   仕様化役→仕様化エージェント、分解役→分解エージェント、指揮役→指揮エージェント。
 *   （Issue では「指揮役」を変えるかが未定だったが、仕様の表で「指揮エージェント」に決まっている）
 * - 文の他の部分は変えない。新しいモジュールは作らず、すでにある関数の振る舞いとして確かめる
 *   （runImplementer・runTester・syncMain・afterApprove・checkApproval・runDecomposer・
 *    followPermissionRequests・followBlockedThreads）。
 * - claude に渡す指示文（各役の RULES など）・ログ（deps.log）は対象外なので確かめない。
 *
 * seed: 記録は MemoryStore、窓口は MemoryChat、GitHub・git・claude はテスト用の偽物。ネットワークには出ない。
 * seed の値（タイトル・本文・要約・指摘など）には「役」の字を入れない（投稿文に「役」が残っていないかを確かめるため）。
 */
import { describe, expect, it } from "vitest";

import {
  afterApprove,
  type ApprovalBoard,
  checkApproval,
  type PrComment,
} from "../approval.js";
import { followBlockedThreads } from "../blocked-thread.js";
import { MemoryChat } from "../chat.js";
import type { RoleResult } from "../claude.js";
import { type Config, parseConfig } from "../config.js";
import {
  type DecomposerDeps,
  type DecomposerOutput,
  runDecomposer,
} from "../decomposer.js";
import type { ExecResult } from "../exec.js";
import type { CiResult } from "../github.js";
import {
  type ImplementerDeps,
  type ImplementerOutput,
  runImplementer,
} from "../implementer.js";
import {
  followPermissionRequests,
  type PermissionRequestDeps,
} from "../permission-request.js";
import { type SyncDeps, syncMain } from "../sync.js";
import { type TesterDeps, type TesterOutput, runTester } from "../tester.js";
import { type IssueKey, MemoryStore } from "../store.js";

// ---- seed ----

const REPO = "pkshimizu/wordcards";
const REQUIREMENTS = "1000000000000000001";
const QUESTIONS = "1000000000000000002";
const NOTICES = "1000000000000000003";
const ALLOWED = "2000000000000000001";
const BOT = "3000000000000000001";

const ISSUE = 12;
const TITLE = "単語の説明を Markdown で見せる";
const BODY = [
  "## 目的",
  TITLE,
  "",
  "## 受け入れ条件（AC）",
  "",
  "- AC1",
  "  - Given 説明に **太字** がある単語がある",
  "  - When 単語を開く",
  "  - Then 太字で出る",
].join("\n");
const KEY: IssueKey = { repo: REPO, issue: ISSUE };
const BRANCH = `conductor/issue-${ISSUE}`;
const PR = 77;
const PROTECTED_HASH = "h1";
const TYPECHECK = "c";
const DENIED_COMMAND = "npm install --save-dev react-markdown";
const SPEC_PR = 101;

/** 呼び名を変えた後 */
const NAMES = {
  tester: "テストエージェント",
  implementer: "実装エージェント",
  reviewer: "レビューエージェント",
  conductor: "指揮エージェント",
  decomposer: "分解エージェント",
} as const;

/** 投稿文に残っていてはいけない字（「～役」も「役」単独も） */
const OLD = /役/;

const clock = () => new Date("2026-11-21T00:00:00.000Z");

const LIMIT_REJECTIONS = 2;
const LIMIT_OBJECTIONS = 1;

function makeConfig(options: { chat?: boolean } = {}): Config {
  const lines = [
    `github: { repo: ${REPO}, project: 3, notify: someone }`,
    "protected: [src/acceptance/**]",
    `commands: { setup: s, test: t, acceptance: a, typecheck: ${TYPECHECK}, build: b }`,
    `limits: { rejections: ${LIMIT_REJECTIONS}, objections: ${LIMIT_OBJECTIONS} }`,
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

/** Issue の列・コメント・PR を覚えるだけの GitHub */
class FakeBoard implements ApprovalBoard {
  readonly columns = new Map<number, string>();
  readonly comments: { issue: number; body: string }[] = [];
  readonly createdPrs: { head: string; title: string; body: string }[] = [];
  readonly merged: number[] = [];
  prCommentList: PrComment[] = [];

  moveIssue(issue: number, column: string): Promise<void> {
    this.columns.set(issue, column);
    return Promise.resolve();
  }
  comment(issue: number, body: string): Promise<void> {
    this.comments.push({ issue, body });
    return Promise.resolve();
  }
  findPullRequest(): Promise<{ number: number; url: string } | undefined> {
    return Promise.resolve(undefined);
  }
  createPullRequest(input: {
    issue: number;
    head: string;
    title: string;
    body: string;
  }): Promise<{ number: number; url: string }> {
    this.createdPrs.push({
      head: input.head,
      title: input.title,
      body: input.body,
    });
    return Promise.resolve({
      number: PR,
      url: `https://github.com/${REPO}/pull/${PR}`,
    });
  }
  mergePullRequest(pr: number): Promise<void> {
    this.merged.push(pr);
    return Promise.resolve();
  }
  ciStatus(): Promise<CiResult> {
    return Promise.resolve({ state: "success", checks: [] });
  }
  merge(pr: number): Promise<void> {
    this.merged.push(pr);
    return Promise.resolve();
  }
  headSha(): Promise<string> {
    return Promise.resolve("sha1");
  }
  prComments(): Promise<PrComment[]> {
    return Promise.resolve(this.prCommentList);
  }
  canWrite(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

const git = {
  startBranch: () => Promise.resolve(),
  changedFiles: () => Promise.resolve([] as string[]),
  discard: () => Promise.resolve(),
  discardAll: () => Promise.resolve(),
  commit: () => Promise.resolve("c0ffee"),
  push: () => Promise.resolve(),
  treeHash: () => Promise.resolve(PROTECTED_HASH),
};

type Denial = RoleResult<ImplementerOutput>["denials"][number];

function result<T>(output: T, denials: Denial[] = []): RoleResult<T> {
  return { output, denials, costUsd: 0, turns: 1, sessionId: "session-1" };
}

/** 1つの場面ごとの記録・GitHub・窓口 */
function world(options: { chat?: boolean } = {}) {
  const config = makeConfig(options);
  const store = new MemoryStore(clock);
  const board = new FakeBoard();
  const chat = new MemoryChat(BOT);
  return { config, store, board, chat };
}

type World = ReturnType<typeof world>;

/** Issue #12 が実装の段階にある状態（テストは済んでいる） */
async function seedImplementing(w: World, extra: { objections?: number } = {}) {
  await w.store.update(KEY, {
    branch: BRANCH,
    protectedHash: PROTECTED_HASH,
    checkpoint: { stage: "implementing" },
    ...(extra.objections === undefined ? {} : { objections: extra.objections }),
  });
  w.board.columns.set(ISSUE, w.config.github.columns.implementing);
}

function implementerDeps(
  w: World,
  output: ImplementerOutput,
  options: { failing?: string; denials?: Denial[] } = {},
): ImplementerDeps {
  return {
    config: w.config,
    repoDir: "/repo",
    store: w.store,
    board: w.board,
    instructions: "",
    git,
    shell: (cmd): Promise<ExecResult> =>
      Promise.resolve(
        cmd === options.failing
          ? {
              code: 1,
              stdout: "Cannot find module 'react-markdown'",
              stderr: "",
            }
          : { code: 0, stdout: "ok", stderr: "" },
      ),
    run: () => Promise.resolve(result(output, options.denials ?? [])),
  };
}

function testerDeps(
  w: World,
  output: TesterOutput,
  denials: Denial[] = [],
): TesterDeps {
  return {
    config: w.config,
    repoDir: "/repo",
    store: w.store,
    board: w.board,
    instructions: "",
    git,
    readFile: () => Promise.resolve(""),
    shell: () => Promise.resolve({ code: 0, stdout: "ok", stderr: "" }),
    run: () => Promise.resolve(result(output, denials)),
  };
}

function permissionDeps(w: World): PermissionRequestDeps {
  return {
    config: w.config,
    store: w.store,
    board: w.board,
    chat: w.chat,
    saveSettings: () =>
      Promise.resolve({
        number: 120,
        url: `https://github.com/${REPO}/pull/120`,
      }),
    log: () => {},
  };
}

/** Blocked にした Issue の、質問チャンネルのスレッドを作らせる */
async function followBlocked(w: World) {
  await followBlockedThreads(
    {
      config: w.config,
      chatConfig: w.config.chat!,
      chat: w.chat,
      store: w.store,
      board: w.board,
      log: () => {},
    },
    () => Promise.resolve([{ number: ISSUE, title: TITLE }]),
  );
}

/** Bot が Discord に書いたすべての文 */
function botTexts(chat: MemoryChat): string[] {
  return [...chat.messages.values()]
    .flat()
    .filter((m) => m.authorId === BOT)
    .map((m) => m.text);
}

/** conductor が GitHub に書いたすべての文（コメントと PR の本文） */
function githubTexts(board: FakeBoard): string[] {
  return [
    ...board.comments.map((c) => c.body),
    ...board.createdPrs.map((p) => p.body),
  ];
}

/** 投稿文に新しい名前の文があり、「役」の字が残っていないことを確かめる */
function expectRenamed(
  scene: string,
  texts: readonly string[],
  expected: readonly string[],
) {
  const all = texts.join("\n----\n");
  for (const e of expected) {
    expect(all, `${scene}: 「${e}」が投稿文にない`).toContain(e);
  }
  for (const t of texts) {
    expect(t, `${scene}: 投稿文に「役」が残っている`).not.toMatch(OLD);
  }
}

const approveImpl: ImplementerOutput = {
  verdict: "approve",
  summary: "説明を Markdown で整形して見せるようにしました",
  findings: [],
};

const objectionImpl: ImplementerOutput = {
  verdict: "objection",
  summary: "受け入れテストが AC と食い違っています",
  findings: [
    {
      file: "src/acceptance/12-markdown.test.ts",
      line: 10,
      message: "太字ではなく斜体を期待しています",
    },
  ],
};

const testerBase = { summary: "", findings: [], tests: [], questions: [] };

// ---- テスト ----

describe("Issue #103: GitHub・Discord に投稿する文の呼び名", () => {
  it("AC1: 実装エージェントが実装し終えたら、PR に「Issue #N を conductor の実装エージェントが実装しました。」と書き、「実装役」とは書かない", async () => {
    // Given: Issue #12 の受け入れテストが済み、実装エージェントがすべての確認を通して実装し終える
    const w = world();
    await seedImplementing(w);

    // When: conductor が PR を作る
    const res = await runImplementer(implementerDeps(w, approveImpl), {
      number: ISSUE,
      title: TITLE,
      body: BODY,
    });

    // Then: PR の本文は「Issue #12 を conductor の実装エージェントが実装しました。」で始まる
    expect(res.status).toBe("submitted");
    expect(w.board.createdPrs).toHaveLength(1);
    const body = w.board.createdPrs[0]!.body;
    expect(body.split("\n")[0]).toBe(
      `Issue #${ISSUE} を conductor の実装エージェントが実装しました。`,
    );
    // Then: PR・Issue に書いたどの文にも「実装役」（「役」の字）は無い
    for (const t of githubTexts(w.board)) {
      expect(t).not.toContain("実装役");
      expect(t).not.toMatch(OLD);
    }
  });

  it("AC2: 許可リストで操作を拒否されたとき、質問チャンネルで許可を確かめる質問文の名前が「～エージェント」になっている", async () => {
    const lead = (name: string) =>
      `${name} が許可リストにない操作を拒否されました。次の規則を許可リストに足してよければ ✅、足さないなら ❌ を付けてください。別の規則にするときは、このスレッドに書いてください。`;
    const denial: Denial = {
      tool: "Bash",
      input: { command: DENIED_COMMAND, description: "依存を入れる" },
    };

    // ---- 実装エージェントが拒否された ----
    {
      // Given: 実装エージェントが npm install を拒否された
      const w = world();
      await seedImplementing(w);
      await runImplementer(
        implementerDeps(w, approveImpl, {
          failing: TYPECHECK,
          denials: [denial],
        }),
        { number: ISSUE, title: TITLE, body: BODY },
      );
      expect(await w.store.getPermissionRequest(KEY)).toBeDefined();

      // When: 質問チャンネルで許可するかを確かめる
      await followPermissionRequests(permissionDeps(w));

      // Then: 質問文の名前が「実装エージェント」で、「役」の字が無い
      const texts = botTexts(w.chat);
      expect(texts.length).toBeGreaterThan(0);
      expectRenamed("実装エージェントの許可の確認", texts, [
        lead(NAMES.implementer),
      ]);
    }

    // ---- テストエージェントが拒否された ----
    {
      // Given: テストエージェントが npm install を拒否された
      const w = world();
      w.board.columns.set(ISSUE, w.config.github.columns.testing);
      await runTester(
        testerDeps(
          w,
          { ...testerBase, verdict: "approve", summary: "テストを書きました" },
          [denial],
        ),
        { number: ISSUE, title: TITLE, body: BODY },
        1,
      );
      expect(await w.store.getPermissionRequest(KEY)).toBeDefined();

      // When: 質問チャンネルで許可するかを確かめる
      await followPermissionRequests(permissionDeps(w));

      // Then: 質問文の名前が「テストエージェント」で、「役」の字が無い
      const texts = botTexts(w.chat);
      expect(texts.length).toBeGreaterThan(0);
      expectRenamed("テストエージェントの許可の確認", texts, [
        lead(NAMES.tester),
      ]);
    }
  });

  it("AC3: 差し戻し・異議・衝突の取り込みなどで conductor が投稿する文の、役の名前がすべて「～エージェント」になっている", async () => {
    const issue = { number: ISSUE, title: TITLE, body: BODY };

    // ---- ローカルの確認で差し戻した ----
    {
      const w = world();
      await seedImplementing(w);
      await runImplementer(
        implementerDeps(w, approveImpl, { failing: TYPECHECK }),
        issue,
      );
      expectRenamed("ローカルの確認の差し戻し", githubTexts(w.board), [
        `ローカルの確認で差し戻しました（1/${LIMIT_REJECTIONS} 回目）。${NAMES.implementer}に次の指摘を渡します。`,
      ]);
    }

    // ---- 実装エージェントが approve 以外を返した ----
    {
      const w = world();
      await seedImplementing(w);
      await runImplementer(
        implementerDeps(w, {
          verdict: "reject",
          summary: "途中で止めました",
          findings: [],
        }),
        issue,
      );
      expectRenamed("実装エージェントの判定の差し戻し", githubTexts(w.board), [
        `${NAMES.implementer}に次の指摘を渡します。`,
        `${NAMES.implementer}が reject を返しました: 途中で止めました`,
      ]);
    }

    // ---- 実装エージェントの異議（上限まで） ----
    {
      const w = world();
      await seedImplementing(w);
      await runImplementer(implementerDeps(w, objectionImpl), issue);
      expectRenamed("実装エージェントの異議", githubTexts(w.board), [
        `${NAMES.implementer}が受け入れテストの不備を指摘しました（異議 1/${LIMIT_OBJECTIONS} 回目）。${NAMES.tester}に次の指摘を渡して、テストを書き直します。`,
      ]);
    }

    // ---- 実装エージェントの異議が上限を超えた（Issue と Discord） ----
    {
      const w = world();
      await seedImplementing(w, { objections: LIMIT_OBJECTIONS });
      await runImplementer(implementerDeps(w, objectionImpl), issue);
      await followBlocked(w);
      expectRenamed("異議の上限（Issue）", githubTexts(w.board), [
        `異議が上限（${LIMIT_OBJECTIONS} 回）を超えたため、Blocked に移しました。最後の${NAMES.implementer}の指摘:`,
      ]);
      const discord = botTexts(w.chat);
      expect(discord.length).toBeGreaterThan(0);
      expectRenamed("異議の上限（Discord）", discord, [
        `${NAMES.implementer}の異議が上限（${LIMIT_OBJECTIONS} 回）を超えました。`,
      ]);
    }

    // ---- テストエージェントの異議（Discord） ----
    {
      const w = world();
      await runTester(
        testerDeps(w, {
          ...testerBase,
          verdict: "objection",
          summary: "AC が曖昧です",
          questions: ["太字の範囲はどこまでですか"],
        }),
        issue,
        1,
      );
      await followBlocked(w);
      expectRenamed(
        "テストエージェントの異議（Issue）",
        githubTexts(w.board),
        [],
      );
      const discord = botTexts(w.chat);
      expect(discord.length).toBeGreaterThan(0);
      expectRenamed("テストエージェントの異議（Discord）", discord, [
        `受け入れ条件が曖昧で、${NAMES.tester}が受け入れテストを書けませんでした。次の点を教えてください。`,
      ]);
    }

    // ---- テストエージェントが受け入れテストを書けなかった（Issue と Discord） ----
    {
      const w = world();
      await runTester(
        testerDeps(w, {
          ...testerBase,
          verdict: "reject",
          summary: "書けませんでした",
        }),
        issue,
        1,
      );
      await followBlocked(w);
      expectRenamed("テストの失敗（Issue）", githubTexts(w.board), [
        `${NAMES.tester}が reject を返しました: 書けませんでした`,
      ]);
      const discord = botTexts(w.chat);
      expect(discord.length).toBeGreaterThan(0);
      expectRenamed("テストの失敗（Discord）", discord, [
        `${NAMES.tester}が受け入れテストを正しく書けませんでした。`,
      ]);
    }

    // ---- main との衝突を取り込んだ（保護ファイル以外が衝突） ----
    {
      const w = world();
      await w.store.update(KEY, {
        branch: BRANCH,
        protectedHash: PROTECTED_HASH,
        pr: PR,
        checkpoint: { stage: "ci" },
      });
      const deps: SyncDeps = {
        config: w.config,
        store: w.store,
        board: w.board,
        git: {
          mergeBase: () => Promise.resolve(["src/words.ts"]),
          abortMerge: () => Promise.resolve(),
          commitMerge: () => Promise.resolve("c0ffee"),
          push: () => Promise.resolve(),
          treeHash: () => Promise.resolve(PROTECTED_HASH),
        },
      };
      await syncMain(deps, ISSUE, PR);
      expectRenamed("衝突の取り込み", githubTexts(w.board), [
        `PR #${PR} が main と衝突したため、${NAMES.conductor}が main を取り込みました。`,
        `${NAMES.implementer}に直させます（差し戻しの上限には数えません）。`,
      ]);
    }

    // ---- main との衝突（保護ファイルが衝突） ----
    {
      const w = world();
      await w.store.update(KEY, {
        branch: BRANCH,
        protectedHash: PROTECTED_HASH,
        pr: PR,
        checkpoint: { stage: "ci" },
      });
      const deps: SyncDeps = {
        config: w.config,
        store: w.store,
        board: w.board,
        git: {
          mergeBase: () =>
            Promise.resolve(["src/acceptance/12-markdown.test.ts"]),
          abortMerge: () => Promise.resolve(),
          commitMerge: () => Promise.resolve("c0ffee"),
          push: () => Promise.resolve(),
          treeHash: () => Promise.resolve(PROTECTED_HASH),
        },
      };
      await syncMain(deps, ISSUE, PR);
      expectRenamed("保護ファイルの衝突", githubTexts(w.board), [
        `${NAMES.tester}に戻します（差し戻しの上限には数えません）。`,
      ]);
    }

    // ---- レビューエージェントが承認し、承認待ちにした → 人が差し戻した ----
    {
      const w = world();
      await w.store.update(KEY, {
        branch: BRANCH,
        protectedHash: PROTECTED_HASH,
        pr: PR,
        checkpoint: { stage: "reviewing" },
      });
      const deps = {
        config: w.config,
        board: w.board,
        store: w.store,
        now: clock,
      };
      await afterApprove(deps, ISSUE);
      expectRenamed("承認待ち", githubTexts(w.board), [
        `PR #${PR} は${NAMES.reviewer}が承認しました。マージしてよいか確認してください。`,
      ]);

      w.board.prCommentList = [
        {
          author: "someone",
          body: "見出しの大きさを揃えてください",
          createdAt: "2026-11-21T01:00:00.000Z",
        },
        {
          author: "someone",
          body: "/conductor reject",
          createdAt: "2026-11-21T01:01:00.000Z",
        },
      ];
      const res = await checkApproval(deps, ISSUE);
      expect(res.status).toBe("rejected");
      expectRenamed("人の差し戻し", githubTexts(w.board), [
        `人の差し戻しを受け付けました（上限の回数には数えません）。${NAMES.implementer}に次の指摘を渡します。`,
      ]);
    }

    // ---- 分解エージェントが作業用 Issue に分けられなかった（Discord） ----
    {
      const w = world();
      const posted = w.chat.addMessage(REQUIREMENTS, {
        authorId: ALLOWED,
        text: "単語帳に検索をつけたい",
      });
      const head = await w.chat.post(QUESTIONS, "要件を受け取りました");
      const threadId = await w.chat.createThread(
        QUESTIONS,
        head,
        "単語帳に検索をつけたい",
      );
      await w.store.updateRequirement(posted.id, {
        threadId,
        specPr: SPEC_PR,
        state: "working",
      });
      const requirement = await w.store.getRequirement(posted.id);
      expect(requirement).toBeDefined();
      const before = botTexts(w.chat).length;
      const empty: DecomposerOutput = {
        verdict: "approve",
        summary: "分けました",
        findings: [],
        issues: [],
      };
      const deps: DecomposerDeps = {
        config: w.config,
        repoDir: "/repo",
        chat: w.chat,
        store: w.store,
        board: {
          pullRequestFiles: () =>
            Promise.resolve(["docs/specs/word-search.md"]),
          createIssue: () => Promise.reject(new Error("作らないはず")),
          addToProject: () => Promise.resolve(),
        },
        run: () => Promise.resolve(result(empty)),
        instructions: "",
        log: () => {},
      };
      const res = await runDecomposer(deps, requirement!);
      expect(res.status).toBe("blocked");
      const discord = botTexts(w.chat).slice(before);
      expect(discord.length).toBeGreaterThan(0);
      expectRenamed("分解の失敗", discord, [
        `${NAMES.decomposer}を ${LIMIT_REJECTIONS + 1} 回起動しても作業用 Issue に分けられなかったため、この要件を止めました。`,
      ]);
    }
  });
});

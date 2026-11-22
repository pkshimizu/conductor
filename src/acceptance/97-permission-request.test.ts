/**
 * Issue #97: 許可リストで拒否された操作を、質問チャンネルで確かめて許可を足し、続きから再開する
 *
 * 決めたこと（実装役はこれに合わせて作る）:
 * - 拒否の検出は、すでにある `runImplementer`（src/implementer.ts）の振る舞いとして確かめる。
 *   偽の claude（deps.run）が `denials` を返したときの、store・GitHub の偽物に残ったものを見る
 * - 規則の形: `{ tool: "Bash", input: { command: "<コマンド>" } }` は `Bash(<コマンド>)`
 * - 記録は Store に足す（MemoryStore も実装する）:
 *     getPermissionRequest(key: IssueKey): Promise<PermissionRequestRecord | undefined>
 *     （少なくとも `role`（例: "implementer"）と `rules`（拒否された操作の規則の配列）を持つ。
 *      題名・スレッドの ID・案の書き込みの ID などは実装役が足してよい）
 *   許可が済んだ（✅・人の規則で足した／❌ で Blocked にした）ら記録を消す
 * - 許可を待つ間は、`runImplementer` を呼んでも claude を起動しない（deps.run を呼ばない）
 * - 許可の確認は新しいモジュール src/permission-request.ts の
 *     followPermissionRequests(deps: PermissionRequestDeps): Promise<void>
 *   で1回分行う（記録のある Issue をすべて確かめる。src/blocked-thread.ts の followBlockedThreads に合わせる）。
 *   PermissionRequestDeps は
 *     { config: Config; chat?: Chat; store: Store;
 *       board: { moveIssue(issue, column); comment(issue, body, options?); mergePullRequest(pr: number): Promise<void> };
 *       saveSettings(form: SettingsForm): Promise<{ number: number; url: string }>;
 *       log(text: string): void }
 *   - saveSettings は src/settings.ts の saveSettings を start.ts でつなぐもの（PR を作るだけ）。
 *     足すときは今の設定のフォームの値（formOf など）の roles.<役>.allow に規則を足して渡し、
 *     返った PR を board.mergePullRequest でマージする
 *   - chat が無い（config.chat が無い）ときは、拒否を記録した時点か followPermissionRequests のどちらかで
 *     Blocked にし、規則の案を Issue にコメントする（どちらでもよい）
 * - 案の書き込み（✅・❌ を付ける書き込み）は、スレッドのもとの投稿でもスレッドの中の書き込みでもよい。
 *   テストは「拒否された操作そのものの規則を含む Bot の書き込み」に ✅・❌ を付ける。
 *   ✅ で足すのは、拒否された操作そのもの（引数つき）の規則
 * - 回数を戻すのは、すでにある followBlockedThreads（src/blocked-thread.ts）の振る舞いとして確かめる
 *
 * 窓口は MemoryChat、GitHub・claude・設定の保存は偽物、記録は MemoryStore を使う。
 */
import { describe, expect, it } from "vitest";

import { blockIssue, followBlockedThreads } from "../blocked-thread.js";
import { MemoryChat } from "../chat.js";
import type { RoleResult, RoleRun } from "../claude.js";
import { type Config, parseConfig } from "../config.js";
import type { ExecResult } from "../exec.js";
import {
  type ImplementerDeps,
  type ImplementerOutput,
  type implementerOutputSchema,
  runImplementer,
} from "../implementer.js";
import {
  followPermissionRequests,
  type PermissionRequestDeps,
} from "../permission-request.js";
import type { SettingsForm } from "../settings-data.js";
import { type IssueKey, MemoryStore } from "../store.js";

// ---- seed ----

const REPO = "pkshimizu/wordcards";
const REQUIREMENTS = "1000000000000000001";
const QUESTIONS = "1000000000000000002";
const NOTICES = "1000000000000000003";
const ALLOWED = "2000000000000000001";
const STRANGER = "2000000000000000009";
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

/** 拒否された操作 */
const DENIED_COMMAND = "npm install --save-dev react-markdown";
/** 拒否された操作そのものの規則（基本の案） */
const EXACT = `Bash(${DENIED_COMMAND})`;
/** 最初の 2 語に ` *` を付けた広い案 */
const BROAD = "Bash(npm install *)";
/** 人がスレッドに書く、別の規則 */
const HUMAN_RULE = "Bash(npm install -D react-markdown)";

const SAVED_PR = 120;
const PROTECTED_HASH = "h1";
/** 型チェックのコマンド（react-markdown を入れられず失敗する） */
const TYPECHECK = "c";

const clock = () => new Date("2026-11-21T00:00:00.000Z");
const issueUrl = (n: number) => `https://github.com/${REPO}/issues/${n}`;

function makeConfig(options: { chat?: boolean } = {}): Config {
  const lines = [
    `github: { repo: ${REPO}, project: 3, notify: someone }`,
    "protected: [src/acceptance/**]",
    `commands: { setup: s, test: t, acceptance: a, typecheck: ${TYPECHECK}, build: b }`,
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

type Denial = RoleResult<ImplementerOutput>["denials"][number];

const bashDenial = (command: string): Denial => ({
  tool: "Bash",
  input: { command, description: "依存を入れる" },
});

/** 実装役の偽物の1回分 */
interface Step {
  denials: Denial[];
  /** 確認のコマンドのうち失敗させるもの */
  failing?: string;
}

const approve: ImplementerOutput = {
  verdict: "approve",
  summary: "説明を Markdown で整形して見せるようにしました",
  findings: [],
};

/** Issue の列・コメント・PR を覚えるだけの GitHub */
class FakeBoard {
  readonly columns = new Map<number, string>();
  readonly moved: { issue: number; column: string }[] = [];
  readonly comments: { issue: number; body: string; mention: boolean }[] = [];
  readonly merged: number[] = [];
  readonly created: { head: string; title: string }[] = [];

  moveIssue(issue: number, column: string): Promise<void> {
    this.moved.push({ issue, column });
    this.columns.set(issue, column);
    return Promise.resolve();
  }
  comment(
    issue: number,
    body: string,
    options: { mention?: boolean } = {},
  ): Promise<void> {
    this.comments.push({ issue, body, mention: options.mention === true });
    return Promise.resolve();
  }
  mergePullRequest(pr: number): Promise<void> {
    this.merged.push(pr);
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
    this.created.push({ head: input.head, title: input.title });
    return Promise.resolve({
      number: 77,
      url: `https://github.com/${REPO}/pull/77`,
    });
  }
}

/** Issue #12 が実装役の段階にある状態（テスト役は済んでいる） */
async function seed(options: { chat?: boolean; steps: Step[] }) {
  const config = makeConfig(options);
  const store = new MemoryStore(clock);
  const board = new FakeBoard();
  const chat = new MemoryChat(BOT);
  await store.update(KEY, {
    branch: `conductor/issue-${ISSUE}`,
    protectedHash: PROTECTED_HASH,
    checkpoint: { stage: "implementing" },
  });
  board.columns.set(ISSUE, config.github.columns.implementing);

  const runs: RoleRun<typeof implementerOutputSchema>[] = [];
  let failing: string | undefined;
  const implementer: ImplementerDeps = {
    config,
    repoDir: "/repo",
    store,
    board,
    instructions: "",
    git: {
      startBranch: () => Promise.resolve(),
      changedFiles: () => Promise.resolve([]),
      discard: () => Promise.resolve(),
      discardAll: () => Promise.resolve(),
      commit: () => Promise.resolve("c0ffee"),
      push: () => Promise.resolve(),
      treeHash: () => Promise.resolve(PROTECTED_HASH),
    },
    shell: (cmd): Promise<ExecResult> =>
      Promise.resolve(
        cmd === failing
          ? {
              code: 1,
              stdout: "Cannot find module 'react-markdown'",
              stderr: "",
            }
          : { code: 0, stdout: "ok", stderr: "" },
      ),
    run: (run) => {
      runs.push(run);
      const step = options.steps[runs.length - 1];
      if (step === undefined) {
        return Promise.reject(new Error("実装役の呼び出しが多すぎる"));
      }
      failing = step.failing;
      return Promise.resolve({
        output: approve,
        denials: step.denials,
        costUsd: 0,
        turns: 1,
        sessionId: `session-${runs.length}`,
      });
    },
  };

  const saved: SettingsForm[] = [];
  const permission: PermissionRequestDeps = {
    config,
    store,
    board,
    saveSettings: (form) => {
      saved.push(structuredClone(form));
      return Promise.resolve({
        number: SAVED_PR,
        url: `https://github.com/${REPO}/pull/${SAVED_PR}`,
      });
    },
    log: () => {},
    ...(options.chat === false ? {} : { chat }),
  };
  const implement = () =>
    runImplementer(implementer, { number: ISSUE, title: TITLE, body: BODY });
  return { config, store, board, chat, runs, saved, permission, implement };
}

/** npm install を拒否された（型チェックが通らない）実装役の1回目 */
const deniedStep: Step = {
  denials: [bashDenial(DENIED_COMMAND)],
  failing: TYPECHECK,
};
/** 許可を足したあとの実装役（すべて通る） */
const passingStep: Step = { denials: [] };

/** 質問チャンネルに作った、許可の確認のスレッド */
function permissionThreads(chat: MemoryChat) {
  return [...chat.threads.entries()]
    .filter(([, t]) => t.channelId === QUESTIONS)
    .filter(([, t]) => t.name.startsWith("許可の確認:"))
    .map(([id, t]) => ({ id, ...t }));
}

type Thread = ReturnType<typeof permissionThreads>[number];

/** スレッドのもとの投稿と、スレッドの中の Bot の書き込み（場所つき） */
function botMessages(chat: MemoryChat, thread: Thread) {
  const head = chat.messages
    .get(QUESTIONS)
    ?.find((m) => m.id === thread.messageId);
  const inside = (chat.messages.get(thread.id) ?? []).filter(
    (m) => m.authorId === BOT,
  );
  return [
    ...(head === undefined ? [] : [{ channelId: QUESTIONS, ...head }]),
    ...inside.map((m) => ({ channelId: thread.id, ...m })),
  ];
}

function threadText(chat: MemoryChat, thread: Thread): string {
  return botMessages(chat, thread)
    .map((m) => m.text)
    .join("\n");
}

/** 案の書き込み（拒否された操作そのものの規則を含む Bot の書き込みのうち最後のもの） */
function proposal(chat: MemoryChat, thread: Thread) {
  const found = botMessages(chat, thread)
    .filter((m) => m.text.includes(EXACT))
    .at(-1);
  if (found === undefined) throw new Error("案の書き込みがありません");
  return found;
}

/** 拒否を検出させて、許可の確認のスレッドを作らせる（AC4 まで済んだ状態） */
async function seedAsked() {
  const parts = await seed({ steps: [deniedStep, passingStep] });
  await parts.implement();
  await followPermissionRequests(parts.permission);
  const threads = permissionThreads(parts.chat);
  expect(threads).toHaveLength(1);
  return { ...parts, thread: threads[0]! };
}

const allowOf = (form: SettingsForm) => form.roles.implementer.allow;

describe("Issue #97: 拒否された操作の許可の確認", () => {
  it("AC1: 役の claude の結果の denials が空でないとき、拒否された操作を許可の規則の形にして記録する", async () => {
    // Given: 実装役が claude を実行し、npm install を拒否された
    const { store, implement } = await seed({ steps: [deniedStep] });

    // When: その回の結果を扱う
    await implement();

    // Then: 拒否された操作を「許可の規則」の形にして記録する
    const record = await store.getPermissionRequest(KEY);
    expect(record).toBeDefined();
    expect(record!.role).toBe("implementer");
    expect(record!.rules).toEqual([EXACT]);
  });

  it("AC2: 拒否された操作を記録した回は、差し戻しを数えず、Blocked にせず、許可を待つ", async () => {
    // Given: 実装役が npm install を拒否され、そのせいで型チェックも通らない
    const { config, store, board, runs, implement } = await seed({
      steps: [deniedStep, passingStep],
    });

    // When: その回の結果を扱う
    await implement();

    // Then: 差し戻しは数えない
    expect((await store.get(KEY))?.rejections).toBe(0);
    expect(board.comments.some((c) => c.body.includes("差し戻し"))).toBe(false);
    // Then: Blocked にしない
    expect(board.columns.get(ISSUE)).not.toBe(config.github.columns.blocked);
    expect(board.moved.map((m) => m.column)).not.toContain(
      config.github.columns.blocked,
    );
    // Then: 許可を待つ（もう一度呼んでも claude を起動しない）
    expect(await store.getPermissionRequest(KEY)).toBeDefined();
    await implement();
    expect(runs).toHaveLength(1);
    expect((await store.get(KEY))?.rejections).toBe(0);
  });

  it("AC3: 拒否された操作が役の deny に当てはまるときは、許可を聞かずに差し戻しとして扱う", async () => {
    // Given: 実装役が、変えてはいけない受け入れテスト（deny: Edit(./src/acceptance/**)）の書き換えを拒否された
    const { store, board, chat, permission, implement } = await seed({
      steps: [
        {
          denials: [
            {
              tool: "Edit",
              input: {
                file_path: "/repo/src/acceptance/12-markdown.test.ts",
                old_string: "expect(a)",
                new_string: "expect(b)",
              },
            },
          ],
          failing: "a",
        },
      ],
    });

    // When: その回の結果を扱う
    await implement();
    await followPermissionRequests(permission);

    // Then: 許可を聞かない
    expect(await store.getPermissionRequest(KEY)).toBeUndefined();
    expect(permissionThreads(chat)).toEqual([]);
    // Then: いまと同じく差し戻しとして扱う
    expect((await store.get(KEY))?.rejections).toBe(1);
    expect(
      board.comments.some(
        (c) => c.issue === ISSUE && c.body.includes("差し戻しました"),
      ),
    ).toBe(true);
  });

  it("AC4: 窓口があるとき、許可の確認を始めると、質問チャンネルにスレッドを作り、Issue へのリンク・役の名前・拒否された操作・規則の案を書いて許可した人にメンションする", async () => {
    // Given: 窓口があり、Issue が許可を待つ状態になった
    const { chat, permission, implement } = await seed({
      steps: [deniedStep],
    });
    await implement();

    // When: 指揮役が許可の確認を始める
    await followPermissionRequests(permission);

    // Then: 質問チャンネルにスレッドを作る
    const threads = permissionThreads(chat);
    expect(threads).toHaveLength(1);
    const thread = threads[0]!;
    expect(thread.name).toBe(`許可の確認: #${ISSUE} ${TITLE}`);
    expect(thread.archived).toBe(false);
    const text = threadText(chat, thread);
    // Issue へのリンク
    expect(text).toContain(issueUrl(ISSUE));
    // 役の名前と最初の書き込みの文
    expect(text).toMatch(
      /(実装エージェント|implementer) が許可リストにない操作を拒否されました。次の規則を許可リストに足してよければ ✅、足さないなら ❌ を付けてください。別の規則にするときは、このスレッドに書いてください。/,
    );
    // 拒否された操作の一覧と、足す規則の案
    expect(text).toContain(DENIED_COMMAND);
    expect(text).toContain(EXACT);
    // 許可した人へのメンション
    expect(text).toContain(`<@${ALLOWED}>`);

    // 次の確認でも、スレッドを作り直さない
    await followPermissionRequests(permission);
    expect(permissionThreads(chat)).toHaveLength(1);
  });

  it("AC5: 規則の案は、拒否された操作そのもの（引数つき）を基本にし、最初の 2 語に ` *` を付けた広い案も併記する", async () => {
    // Given / When: AC4 のスレッドに規則の案を書く
    const { chat, thread } = await seedAsked();

    // Then: 拒否された操作そのものの案と、広い案の両方がある
    const text = threadText(chat, thread);
    expect(text).toContain(EXACT);
    expect(text).toContain(BROAD);
  });

  it("AC6: 許可した人が案の書き込みに ✅ を付けると、roles.<役>.allow に規則を足す PR を作ってマージし、Issue を続きから再開する", async () => {
    const {
      config,
      store,
      board,
      chat,
      runs,
      saved,
      permission,
      implement,
      thread,
    } = await seedAsked();
    // ✅ が付くまでは足さない
    await followPermissionRequests(permission);
    expect(saved).toEqual([]);
    // 許可した人でない人の ✅ では足さない
    const target = proposal(chat, thread);
    chat.addReaction(target.channelId, target.id, "✅", STRANGER);
    await followPermissionRequests(permission);
    expect(saved).toEqual([]);

    // Given: 許可した人が案の書き込みに ✅ を付けた
    chat.addReaction(target.channelId, target.id, "✅", ALLOWED);

    // When: 次の確認
    await followPermissionRequests(permission);

    // Then: roles.implementer.allow に規則を足す PR を作る（設定の保存と同じ仕組み）
    expect(saved).toHaveLength(1);
    expect(allowOf(saved[0]!)).toContain(EXACT);
    // Then: その PR をマージする
    expect(board.merged).toEqual([SAVED_PR]);
    // Then: Issue を続きから再開する（Blocked にせず、許可の待ちを解いて実装役を動かす）
    expect(await store.getPermissionRequest(KEY)).toBeUndefined();
    expect(board.columns.get(ISSUE)).not.toBe(config.github.columns.blocked);
    await implement();
    expect(runs).toHaveLength(2);
    expect((await store.get(KEY))?.rejections).toBe(0);

    // 次の確認で、同じ規則を足し直さない
    await followPermissionRequests(permission);
    expect(saved).toHaveLength(1);
  });

  it("AC7: 許可した人がスレッドに規則を書くと、案の代わりにその規則を許可リストに足す", async () => {
    const { store, board, chat, saved, permission, thread } = await seedAsked();

    // Given: 許可した人がスレッドに規則を書いた
    chat.addMessage(thread.id, { authorId: ALLOWED, text: HUMAN_RULE });

    // When: 次の確認
    await followPermissionRequests(permission);

    // Then: 案の代わりにその規則を許可リストに足す
    expect(saved).toHaveLength(1);
    const allow = allowOf(saved[0]!);
    expect(allow).toContain(HUMAN_RULE);
    expect(allow).not.toContain(EXACT);
    expect(allow).not.toContain(BROAD);
    expect(board.merged).toEqual([SAVED_PR]);
    expect(await store.getPermissionRequest(KEY)).toBeUndefined();
  });

  it("AC8: 許可した人が案の書き込みに ❌ を付けると、許可せず、Issue を Blocked にして止まったときのスレッドに引き継ぐ", async () => {
    const { config, store, board, chat, saved, permission, thread } =
      await seedAsked();

    // Given: 許可した人が案の書き込みに ❌ を付けた
    const target = proposal(chat, thread);
    chat.addReaction(target.channelId, target.id, "❌", ALLOWED);

    // When: 次の確認
    await followPermissionRequests(permission);

    // Then: 許可しない
    expect(saved).toEqual([]);
    expect(board.merged).toEqual([]);
    expect(await store.getPermissionRequest(KEY)).toBeUndefined();
    // Then: Issue を Blocked にする
    expect(board.columns.get(ISSUE)).toBe(config.github.columns.blocked);
    // Then: 止まったときのスレッド（src/blocked-thread.ts）に引き継ぐ
    expect(await store.getBlockedThread(KEY)).toBeDefined();
  });

  it("AC9: 規則を足して Issue を再開したら、スレッドに結果を書いてアーカイブする", async () => {
    const { chat, permission, thread } = await seedAsked();

    // Given: 許可した人が ✅ を付けた（AC6）
    const target = proposal(chat, thread);
    chat.addReaction(target.channelId, target.id, "✅", ALLOWED);

    // When: 規則を足して Issue を再開する
    await followPermissionRequests(permission);

    // Then: スレッドに結果を書く
    expect(
      (chat.messages.get(thread.id) ?? [])
        .filter((m) => m.authorId === BOT)
        .map((m) => m.text),
    ).toContain(
      `${EXACT} を許可リストに足しました（PR #${SAVED_PR}）。Issue #${ISSUE} を再開します。このスレッドは閉じます。`,
    );
    // Then: スレッドをアーカイブする
    expect(chat.threads.get(thread.id)?.archived).toBe(true);
  });

  it("AC10: 窓口がないとき、Issue が許可を待つ状態になると、Blocked にし、拒否された操作と config.yaml に足す規則の案を Issue にコメントする", async () => {
    // Given: 窓口（Discord）が設定されていない
    const { config, store, board, permission, implement } = await seed({
      chat: false,
      steps: [deniedStep],
    });

    // When: 実装役が npm install を拒否され、Issue が許可を待つ状態になった
    await implement();
    await followPermissionRequests(permission);

    // Then: Issue を Blocked にする
    expect(board.columns.get(ISSUE)).toBe(config.github.columns.blocked);
    // Then: 拒否された操作と、config.yaml に足す規則の案を Issue にコメントする
    const comment = board.comments.find(
      (c) => c.issue === ISSUE && c.body.includes(EXACT),
    );
    expect(comment).toBeDefined();
    expect(comment!.body).toContain(DENIED_COMMAND);
    expect(comment!.body).toContain(BROAD);
    expect(comment!.body).toContain("config.yaml");
    // Then: 差し戻しとしては数えない
    expect((await store.get(KEY))?.rejections).toBe(0);
  });
});

// ---- 差し戻しの回数を戻す（AC11・AC12） ----

/** 差し戻し・反論が数えられて Blocked になり、止まったときのスレッドがある Issue */
async function seedBlockedWithCounts() {
  const config = makeConfig();
  const store = new MemoryStore(clock);
  const board = new FakeBoard();
  const chat = new MemoryChat(BOT);
  await store.update(KEY, {
    branch: `conductor/issue-${ISSUE}`,
    protectedHash: PROTECTED_HASH,
    rejections: config.limits.rejections + 1,
    objections: 1,
    checkpoint: { stage: "implementing", reason: "rejection-limit" },
  });
  await blockIssue({ config, store, board }, ISSUE, {
    body: "差し戻しが上限を超えたため、Blocked に移しました。",
    reason: "差し戻しが上限を超えました。",
  });
  const deps = {
    config,
    chatConfig: config.chat!,
    chat,
    store,
    board,
    log: () => {},
  };
  const blockedList = [{ number: ISSUE, title: TITLE }];
  // 止まったときのスレッドを作る
  await followBlockedThreads(deps, () => Promise.resolve(blockedList));
  const threads = [...chat.threads.entries()].filter(
    ([, t]) => t.channelId === QUESTIONS,
  );
  expect(threads).toHaveLength(1);
  const before = await store.get(KEY);
  expect(before?.rejections).toBeGreaterThan(0);
  expect(before?.objections).toBeGreaterThan(0);
  return { config, store, board, chat, deps, threadId: threads[0]![0] };
}

describe("Issue #97: 差し戻しの回数を戻す", () => {
  it("AC11: 人が GitHub で Issue を Blocked の列から直接動かすと、差し戻しの回数と反論の回数を 0 に戻す", async () => {
    // Given: 回数が 1 以上で、Issue が Blocked の列にある
    const { store, board, config, deps } = await seedBlockedWithCounts();

    // When: 人が GitHub で Issue を Blocked の列から直接動かした
    board.columns.set(ISSUE, config.github.columns.ready);
    await followBlockedThreads(deps, () => Promise.resolve([]));

    // Then: 差し戻しの回数と反論の回数を 0 に戻す
    const record = await store.get(KEY);
    expect(record?.rejections).toBe(0);
    expect(record?.objections).toBe(0);
  });

  it("AC12: 人がスレッドに方針を書き、指揮役が書き写して Blocked の列から出すと、差し戻しの回数と反論の回数を 0 に戻す", async () => {
    // Given: 回数が 1 以上で、止まったときのスレッドがある
    const { store, board, config, chat, deps, threadId } =
      await seedBlockedWithCounts();

    // When: 人がスレッドに方針を書き、指揮役がそれを書き写して Blocked の列から出した
    chat.addMessage(threadId, {
      authorId: ALLOWED,
      text: "react-markdown の代わりに marked を使う方針にしてください",
    });
    await followBlockedThreads(deps, () =>
      Promise.resolve([{ number: ISSUE, title: TITLE }]),
    );
    expect(board.columns.get(ISSUE)).toBe(config.github.columns.ready);

    // Then: 差し戻しの回数と反論の回数を 0 に戻す
    const record = await store.get(KEY);
    expect(record?.rejections).toBe(0);
    expect(record?.objections).toBe(0);
  });
});

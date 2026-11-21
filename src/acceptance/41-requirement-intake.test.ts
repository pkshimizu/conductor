/**
 * Issue #41: 要件の受け取りの受け入れテスト
 *
 * 決めた名前（実装役はこれに合わせて作る）:
 * - `src/loop.ts` の `LoopDeps` に、省略できる窓口を足す
 *   ```ts
 *   interface LoopDeps {
 *     // 既存の項目はそのまま
 *     /** 窓口。config.chat があるときに start.ts がつなぐ。無ければ要件を受け取らない *\/
 *     chat?: Chat;
 *   }
 *   ```
 * - `tick(deps, state)`（1回分の確認）は、`config.chat` と `deps.chat` があれば、
 *   作業中の Issue の処理とは別に、要件チャンネル（`config.chat.channels.requirements`）の
 *   新しい投稿を受け取る
 *   - 許可した人（`config.chat.allowed_users`）の投稿1つを要件1件とする
 *   - 要件は `store.updateRequirement(投稿 ID, { threadId })` で記録する（状態は仕様化中のまま）
 *   - 要件チャンネルのその投稿から要件のスレッドを作る（#86 で変更。以前は質問チャンネルに
 *     スレッドを作って本文を引用していたが、質問チャンネルには何も書かず、引用もしない）
 *   - 許可していない人・Bot 自身の投稿は無視する
 *   - 受け取った投稿は、再起動しても二重に受け取らない（記録は Store に残す）
 *
 * 窓口は MemoryChat、GitHub の列は偽物、記録は MemoryStore（再起動は SQLite を一時フォルダに作る）を使う。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MemoryChat } from "../chat.js";
import { parseConfig } from "../config.js";
import {
  type LoopDeps,
  type LoopIssue,
  newLoopState,
  type StepResult,
  tick,
} from "../loop.js";
import { SqliteStore } from "../sqlite-store.js";
import { MemoryStore, type Store } from "../store.js";

// ---- seed ----

const REPO = "pkshimizu/wordcards";
const REQUIREMENTS = "1000000000000000001";
const QUESTIONS = "1000000000000000002";
const NOTICES = "1000000000000000003";
const ALLOWED = "2000000000000000001";
const ALLOWED_2 = "2000000000000000002";
const STRANGER = "2000000000000000099";
const BOT = "3000000000000000001";

const config = parseConfig(
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
    `    - "${ALLOWED_2}"`,
  ].join("\n"),
);

const clock = () => new Date("2026-11-19T00:00:00.000Z");

function issue(number: number): LoopIssue {
  return { number, title: `Issue ${number}`, body: "本文" };
}

/** 常駐ループの部品。GitHub の列と各役は偽物 */
function setup(
  chat: MemoryChat,
  store: Store,
  columns: Record<string, number[]> = {},
) {
  const calls: string[] = [];
  const board = new Map(
    Object.entries(columns).map(([c, ns]) => [c, ns.map(issue)]),
  );
  const step =
    (name: string) =>
    (i: LoopIssue): Promise<StepResult> => {
      calls.push(`${name} #${i.number}`);
      return Promise.resolve({ status: "ok" });
    };
  const deps: LoopDeps = {
    config,
    store,
    chat,
    board: {
      issuesByColumn: () => Promise.resolve(board),
      moveIssue: () => Promise.resolve(),
      comment: () => Promise.resolve(),
      hasConflict: () => Promise.resolve(false),
    },
    pickUp: (i) => {
      calls.push(`pickUp #${i.number}`);
      return Promise.resolve({ accepted: true });
    },
    test: step("test"),
    implement: step("implement"),
    checkCi: (i) => {
      calls.push(`checkCi #${i.number}`);
      return Promise.resolve({ status: "passed" });
    },
    review: step("review"),
    merge: step("merge"),
    syncMain: step("syncMain"),
    log: () => {},
  };
  return { deps, calls };
}

/** 要件チャンネルに作られたスレッド（ID つき）。#86 で要件のスレッドは要件チャンネルの投稿から作る */
function requirementThreads(chat: MemoryChat) {
  return [...chat.threads]
    .filter(([, t]) => t.channelId === REQUIREMENTS)
    .map(([id, t]) => ({ id, ...t }));
}

/** スレッドに Bot が書いた文 */
function botTexts(chat: MemoryChat, threadId: string): string[] {
  return (chat.messages.get(threadId) ?? [])
    .filter((m) => m.authorId === chat.botId)
    .map((m) => m.text);
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "conductor-41-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("Issue #41: 要件の受け取り", () => {
  it("AC1: 許可した人が要件チャンネルに投稿すると、次の確認で要件1件として記録し、その投稿からスレッドを作る（#86 により質問チャンネルには書かず、引用もしない）", async () => {
    const chat = new MemoryChat(BOT);
    const store = new MemoryStore(clock);
    // Given: 許可した人が要件チャンネルに投稿した
    const posted = chat.addMessage(REQUIREMENTS, {
      authorId: ALLOWED,
      text: "単語帳に検索をつけたい\n前方一致で探せるように",
    });
    const { deps } = setup(chat, store);

    // When: 次の確認
    await tick(deps, newLoopState());

    // Then: 要件チャンネルのその投稿からスレッドが1つできる（#86）
    expect(chat.threads.size).toBe(1);
    const threads = requirementThreads(chat);
    expect(threads).toHaveLength(1);
    const thread = threads[0]!;
    expect(thread.messageId).toBe(posted.id);

    // Then: 要件1件として、投稿 ID とスレッドで記録する（仕様化中）
    expect(await store.listRequirements()).toEqual([
      expect.objectContaining({
        messageId: posted.id,
        threadId: thread.id,
        state: "specifying",
      }),
    ]);

    // Then: 質問チャンネルには何も書かず、スレッドに要件の本文の引用も書かない（#86）
    expect(chat.messages.get(QUESTIONS) ?? []).toEqual([]);
    const written = botTexts(chat, thread.id).join("\n");
    expect(written).not.toContain("> 単語帳に検索をつけたい");
    expect(written).not.toContain("> 前方一致で探せるように");
  });

  it("AC2: 許可していない人の投稿や Bot 自身の投稿は、次の確認で無視する", async () => {
    const chat = new MemoryChat(BOT);
    const store = new MemoryStore(clock);
    // Given: 許可していない人の投稿と、Bot 自身の投稿
    chat.addMessage(REQUIREMENTS, {
      authorId: STRANGER,
      text: "勝手に機能を足してほしい",
    });
    await chat.post(REQUIREMENTS, "要件を受け取りました");
    const { deps } = setup(chat, store);

    // When: 次の確認
    await tick(deps, newLoopState());

    // Then: 要件として記録せず、スレッドも作らず、何も書かない
    expect(await store.listRequirements()).toEqual([]);
    expect(chat.threads.size).toBe(0);
    expect(chat.messages.get(QUESTIONS) ?? []).toEqual([]);
    expect(
      (chat.messages.get(REQUIREMENTS) ?? []).filter((m) => m.authorId === BOT),
    ).toHaveLength(1);

    // その後に許可した人が投稿すれば、それだけを受け取る
    const allowed = chat.addMessage(REQUIREMENTS, {
      authorId: ALLOWED,
      text: "CSV で書き出したい",
    });
    await tick(deps, newLoopState());
    const requirements = await store.listRequirements();
    expect(requirements.map((r) => r.messageId)).toEqual([allowed.id]);
    expect(chat.threads.size).toBe(1);
    expect(requirementThreads(chat).map((t) => t.messageId)).toEqual([
      allowed.id,
    ]);
  });

  it("AC3: 要件チャンネルに2回投稿すると、次の確認で2件の要件として扱う", async () => {
    const chat = new MemoryChat(BOT);
    const store = new MemoryStore(clock);
    // Given: 要件チャンネルに2回投稿した（同じ人でも別の要件）
    const first = chat.addMessage(REQUIREMENTS, {
      authorId: ALLOWED,
      text: "単語帳に検索をつけたい",
    });
    const second = chat.addMessage(REQUIREMENTS, {
      authorId: ALLOWED,
      text: "あと CSV で書き出したい",
    });
    const { deps } = setup(chat, store);

    // When: 次の確認
    await tick(deps, newLoopState());

    // Then: 2件の要件として、それぞれのスレッドで記録する
    const requirements = await store.listRequirements();
    expect(requirements.map((r) => r.messageId)).toEqual([first.id, second.id]);
    expect(chat.threads.size).toBe(2);
    const threads = requirementThreads(chat);
    expect(threads).toHaveLength(2);
    const threadOf = (messageId: string) =>
      requirements.find((r) => r.messageId === messageId)?.threadId;
    expect(threadOf(first.id)).toBeDefined();
    expect(threadOf(second.id)).toBeDefined();
    expect(threadOf(first.id)).not.toBe(threadOf(second.id));
    expect(threads.map((t) => t.id).sort()).toEqual(
      [threadOf(first.id)!, threadOf(second.id)!].sort(),
    );

    // それぞれのスレッドは、その要件の投稿から作る（#86。引用は書かない）
    const byId = new Map(threads.map((t) => [t.id, t]));
    expect(byId.get(threadOf(first.id)!)?.messageId).toBe(first.id);
    expect(byId.get(threadOf(second.id)!)?.messageId).toBe(second.id);
    expect(chat.messages.get(QUESTIONS) ?? []).toEqual([]);
    const firstText = botTexts(chat, threadOf(first.id)!).join("\n");
    const secondText = botTexts(chat, threadOf(second.id)!).join("\n");
    expect(firstText).not.toContain("> 単語帳に検索をつけたい");
    expect(secondText).not.toContain("> あと CSV で書き出したい");
  });

  it("AC4: 受け取り済みの投稿は、conductor を再起動して確認しても二重に受け取らない", async () => {
    const file = join(dir, "conductor.db");
    const chat = new MemoryChat(BOT);
    const posted = chat.addMessage(REQUIREMENTS, {
      authorId: ALLOWED,
      text: "単語帳に検索をつけたい",
    });

    // Given: 受け取り済みの投稿（1回目の起動で受け取った）
    const received = await (async () => {
      const before: Store = new SqliteStore(file, clock);
      try {
        await tick(setup(chat, before).deps, newLoopState());
        const list = await before.listRequirements();
        expect(list.map((r) => r.messageId)).toEqual([posted.id]);
        expect(requirementThreads(chat)).toHaveLength(1);
        return list;
      } finally {
        await before.close();
      }
    })();
    const questionMessages = (chat.messages.get(QUESTIONS) ?? []).length;
    const threadMessages = botTexts(chat, received[0]!.threadId!).length;

    // When: conductor を再起動して（記録を開き直し、ループの状態も新しく）確認する
    const after: Store = new SqliteStore(file, clock);
    try {
      const { deps } = setup(chat, after);
      await tick(deps, newLoopState());
      await tick(deps, newLoopState());

      // Then: 二重に受け取らない（記録・スレッド・書き込みは増えない）
      expect(await after.listRequirements()).toEqual(received);
      expect(chat.threads.size).toBe(1);
      expect(requirementThreads(chat)).toHaveLength(1);
      expect((chat.messages.get(QUESTIONS) ?? []).length).toBe(
        questionMessages,
      );
      expect(botTexts(chat, received[0]!.threadId!)).toHaveLength(
        threadMessages,
      );

      // 再起動の後に来た新しい投稿は受け取る
      const next = chat.addMessage(REQUIREMENTS, {
        authorId: ALLOWED_2,
        text: "CSV で書き出したい",
      });
      await tick(deps, newLoopState());
      const requirements = await after.listRequirements();
      expect(requirements.map((r) => r.messageId)).toEqual([
        posted.id,
        next.id,
      ]);
      expect(chat.threads.size).toBe(2);
      expect(requirementThreads(chat)).toHaveLength(2);
    } finally {
      await after.close();
    }
  });

  it("AC5: 作業中の Issue があるときに新しい要件が投稿されると、Issue の処理を止めずに要件も受け取る", async () => {
    const chat = new MemoryChat(BOT);
    const store = new MemoryStore(clock);
    // Given: 作業中の Issue がある（実装中）
    await store.update(
      { repo: REPO, issue: 4 },
      { pr: 14, checkpoint: { stage: "implementing" } },
    );
    const { deps, calls } = setup(chat, store, {
      Ready: [9],
      Implementing: [4],
    });

    // When: 新しい要件が投稿された
    const posted = chat.addMessage(REQUIREMENTS, {
      authorId: ALLOWED,
      text: "単語帳に検索をつけたい",
    });
    await tick(deps, newLoopState());

    // Then: Issue の処理はいつもどおり1段階進む（Ready は拾わない）
    expect(calls).toEqual(["implement #4"]);
    const record = await store.get({ repo: REPO, issue: 4 });
    expect(record?.checkpoint?.stage).toBe("implementing");

    // Then: 要件も受け取る
    const requirements = await store.listRequirements();
    expect(requirements.map((r) => r.messageId)).toEqual([posted.id]);
    expect(chat.threads.size).toBe(1);
    expect(requirementThreads(chat)).toHaveLength(1);
    expect(requirements[0]!.threadId).toBe(requirementThreads(chat)[0]!.id);

    // 次の確認でも Issue は進み続ける
    await tick(deps, newLoopState());
    expect(calls).toEqual(["implement #4", "implement #4"]);
    expect(await store.listRequirements()).toHaveLength(1);
  });
});

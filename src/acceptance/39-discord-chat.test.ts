/**
 * Issue #39: Discord の窓口 の受け入れテスト
 *
 * 決めた名前（実装役はこれに合わせて作る）:
 * - `src/discord.ts` の `DiscordChat`（`Chat` を実装する）
 *   ```ts
 *   new DiscordChat({
 *     token: string,                     // Bot のトークン（Authorization: Bot <token> で送る）
 *     channels: ChatConfig["channels"],  // 要件・質問・お知らせのチャンネル ID
 *     fetch?: typeof fetch,              // Discord の REST API（v10）を呼ぶ関数。省略時は globalThis.fetch
 *   })
 *   ```
 * - `Chat.readMessages(channelId, after?)`：`after`（投稿 ID）を渡すと、その投稿より後の投稿だけを古い順に返す
 *   （`src/chat.ts` の `Chat` の `readMessages` に省略できる第2引数 `after?: string` を足す）
 * - 要件・質問・お知らせのチャンネルと、その下のスレッド以外の投稿は返さない（空の配列を返す）
 * - 書き込みは Discord の上限（2000 文字）ごとに分けて書く
 * - Discord の API は `https://discord.com/api/v10/...` の REST だけを使う（ポーリング。Gateway・Webhook は使わない）
 *
 * Discord の API は `./39-fake-discord.ts` の `FakeDiscord` に差し替える。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Chat, ChatMessage, ChatReaction } from "../chat.js";
import type { ChatConfig } from "../config.js";
import { DiscordChat } from "../discord.js";
import {
  DISCORD_HOST,
  FakeDiscord,
  MESSAGE_MAX_LENGTH,
} from "./39-fake-discord.js";

// ---- seed ----

const TOKEN = "test-bot-token";
const BOT_ID = "3000000000000000001";

const CHANNELS: ChatConfig["channels"] = {
  requirements: "1000000000000000001",
  questions: "1000000000000000002",
  notices: "1000000000000000003",
};
const OTHER_CHANNEL = "1000000000000000009";

const ALICE = "2000000000000000001";
const BOB = "2000000000000000002";
const CAROL = "2000000000000000003";

function seed(): FakeDiscord {
  const fake = new FakeDiscord(TOKEN, BOT_ID);
  fake.addChannel(CHANNELS.requirements, { name: "要件" });
  fake.addChannel(CHANNELS.questions, { name: "質問" });
  fake.addChannel(CHANNELS.notices, { name: "お知らせ" });
  fake.addChannel(OTHER_CHANNEL, { name: "雑談" });
  return fake;
}

function connect(fake: FakeDiscord): Chat {
  return new DiscordChat({
    token: TOKEN,
    channels: CHANNELS,
    fetch: fake.fetch,
  });
}

function pick(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(({ id, authorId, text }) => ({ id, authorId, text }));
}

function normalize(reactions: ChatReaction[]): ChatReaction[] {
  return reactions
    .map((r) => ({ emoji: r.emoji, userIds: [...r.userIds].sort() }))
    .sort((a, b) => a.emoji.localeCompare(b.emoji));
}

let realFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // 実際の Discord（ネットワーク）には出さない
  realFetch = vi.fn(async () => {
    throw new Error("実際のネットワークに接続しようとしました");
  });
  vi.stubGlobal("fetch", realFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Issue #39: Discord の窓口", () => {
  it("AC1: 要件チャンネルを前回の続きから読み出すと、前回より後の投稿だけが投稿者・本文・ID つきで古い順に得られる", async () => {
    const fake = seed();
    // Given: 前回までに読んだ投稿
    fake.addMessage(CHANNELS.requirements, {
      authorId: ALICE,
      content: "古い要件1",
    });
    const lastRead = fake.addMessage(CHANNELS.requirements, {
      authorId: BOB,
      content: "古い要件2",
    });
    // Given: その後の新しい投稿（Discord が1回で返す件数より多い）
    const expected: ChatMessage[] = [];
    for (let i = 0; i < 120; i++) {
      const authorId = i % 2 === 0 ? ALICE : BOB;
      const text = `新しい要件${i}`;
      const id = fake.addMessage(CHANNELS.requirements, {
        authorId,
        content: text,
      });
      expected.push({ id, authorId, text });
    }
    // ほかのチャンネルの投稿は混ざらない
    fake.addMessage(CHANNELS.questions, {
      authorId: ALICE,
      content: "別チャンネル",
    });

    const chat = connect(fake);
    const got = await chat.readMessages(CHANNELS.requirements, lastRead);

    expect(pick(got)).toEqual(expected);
  });

  it("AC2: 要件・質問・お知らせ以外のチャンネルの投稿は読み出しても捨てられ、返らない", async () => {
    const fake = seed();
    const first = fake.addMessage(OTHER_CHANNEL, {
      authorId: ALICE,
      content: "雑談0",
    });
    fake.addMessage(OTHER_CHANNEL, { authorId: ALICE, content: "雑談1" });
    // ほかのチャンネルの下のスレッドも対象外
    const otherThread = fake.addMessage(OTHER_CHANNEL, {
      authorId: BOB,
      content: "雑談のスレッドのもと",
    });
    fake.addChannel(otherThread, {
      parentId: OTHER_CHANNEL,
      name: "雑談スレッド",
    });
    fake.addMessage(otherThread, {
      authorId: BOB,
      content: "雑談スレッドの中",
    });

    // 対象のチャンネルの投稿は返る（比べるため）
    const notice = fake.addMessage(CHANNELS.notices, {
      authorId: CAROL,
      content: "お知らせ",
    });

    const chat = connect(fake);

    expect(await chat.readMessages(OTHER_CHANNEL)).toEqual([]);
    expect(await chat.readMessages(OTHER_CHANNEL, first)).toEqual([]);
    expect(await chat.readMessages(otherThread)).toEqual([]);
    expect(pick(await chat.readMessages(CHANNELS.notices))).toEqual([
      { id: notice, authorId: CAROL, text: "お知らせ" },
    ]);
  });

  it("AC3: 質問チャンネルにスレッドを作って書き込むと、スレッドができて書き込みが表示され、2000 文字を超える文は分けて書かれる", async () => {
    const fake = seed();
    const chat = connect(fake);

    // 質問チャンネルに質問のもとの投稿を書き、そこからスレッドを作る
    const rootId = await chat.post(
      CHANNELS.questions,
      "Issue #39 について質問があります",
    );
    expect(fake.messagesIn(CHANNELS.questions).map((m) => m.content)).toEqual([
      "Issue #39 について質問があります",
    ]);
    const threadId = await chat.createThread(
      CHANNELS.questions,
      rootId,
      "質問: Issue #39",
    );

    const thread = fake.channels.get(threadId);
    expect(thread).toEqual(
      expect.objectContaining({
        parentId: CHANNELS.questions,
        name: "質問: Issue #39",
        archived: false,
        locked: false,
      }),
    );

    // 短い文は1件で書かれる
    const shortId = await chat.post(threadId, "対象の画面はどれですか");
    expect(
      fake.messagesIn(threadId).map((m) => ({ id: m.id, content: m.content })),
    ).toEqual([{ id: shortId, content: "対象の画面はどれですか" }]);

    // 上限を超える文は分けて書かれ、つなぐともとの文になる
    const long = "質問".repeat(2250); // 4500 文字（改行・空白なし）
    const longId = await chat.post(threadId, long);
    const parts = fake.messagesIn(threadId).slice(1);
    expect(parts.length).toBeGreaterThanOrEqual(3);
    for (const part of parts) {
      expect([...part.content].length).toBeLessThanOrEqual(MESSAGE_MAX_LENGTH);
      expect(part.bot).toBe(true);
    }
    expect(parts.map((p) => p.content).join("")).toBe(long);
    expect(parts.map((p) => p.id)).toContain(longId);
  });

  it("AC4: スレッドのメッセージに付いたリアクションを読み出すと、誰がどの絵文字を付けたかが得られる", async () => {
    const fake = seed();
    const chat = connect(fake);

    const rootId = await chat.post(CHANNELS.questions, "質問のもと");
    const threadId = await chat.createThread(
      CHANNELS.questions,
      rootId,
      "質問: 承認",
    );
    const askId = await chat.post(threadId, "この方針でよいですか");

    // Given: スレッドのメッセージに人がリアクションを付けている
    fake.addReaction(askId, "👍", ALICE);
    fake.addReaction(askId, "👍", BOB);
    fake.addReaction(askId, "❌", CAROL);
    // ほかの投稿のリアクションは混ざらない
    fake.addReaction(rootId, "🎉", ALICE);

    const got = await chat.readReactions(threadId, askId);

    expect(normalize(got)).toEqual(
      normalize([
        { emoji: "👍", userIds: [ALICE, BOB] },
        { emoji: "❌", userIds: [CAROL] },
      ]),
    );
  });

  it("AC5: スレッドをアーカイブしてロックすると、スレッドが閉じて人が書き込めなくなる", async () => {
    const fake = seed();
    const chat = connect(fake);

    const rootId = await chat.post(CHANNELS.questions, "質問のもと");
    const threadId = await chat.createThread(
      CHANNELS.questions,
      rootId,
      "質問: 終わり",
    );
    await chat.post(threadId, "回答ありがとうございました");
    expect(fake.humanCanPost(threadId)).toBe(true);

    await chat.archiveThread(threadId);
    await chat.lockThread(threadId);

    expect(fake.channels.get(threadId)).toEqual(
      expect.objectContaining({ archived: true, locked: true }),
    );
    expect(fake.humanCanPost(threadId)).toBe(false);
  });

  it("AC6: Discord の API を偽物に置き換えると、上の動きが実際の Discord に接続せずに確かめられる", async () => {
    const fake = seed();
    const chat = connect(fake);

    // 読み出し・スレッドの作成・書き込み・リアクション・アーカイブとロックを通しで行う
    const req = fake.addMessage(CHANNELS.requirements, {
      authorId: ALICE,
      content: "要件",
    });
    expect(pick(await chat.readMessages(CHANNELS.requirements))).toEqual([
      { id: req, authorId: ALICE, text: "要件" },
    ]);
    const rootId = await chat.post(CHANNELS.questions, "質問のもと");
    const threadId = await chat.createThread(
      CHANNELS.questions,
      rootId,
      "質問",
    );
    const askId = await chat.post(threadId, "x".repeat(MESSAGE_MAX_LENGTH + 1));
    fake.addReaction(askId, "👍", ALICE);
    await chat.readReactions(threadId, askId);
    await chat.archiveThread(threadId);
    await chat.lockThread(threadId);

    // 実際のネットワーク（globalThis.fetch）は一度も呼ばれていない
    expect(realFetch).not.toHaveBeenCalled();
    // 要求はすべて偽の Discord の REST API に、Bot のトークンつきで届いている
    expect(fake.requests.length).toBeGreaterThan(0);
    for (const r of fake.requests) {
      const url = new URL(r.url);
      expect(url.host).toBe(DISCORD_HOST);
      expect(url.pathname).toMatch(/^\/api\/v10\//);
      expect(r.authorization).toBe(`Bot ${TOKEN}`);
    }
  });
});

import { describe, expect, it, vi } from "vitest";

import { FakeDiscord } from "./acceptance/39-fake-discord.js";
import { DiscordApiError, DiscordChat, splitMessage } from "./discord.js";

const TOKEN = "secret-token";
const CHANNELS = { requirements: "11", questions: "12", notices: "13" };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function setup(): { fake: FakeDiscord; chat: DiscordChat } {
  const fake = new FakeDiscord(TOKEN, "99");
  fake.addChannel(CHANNELS.requirements);
  fake.addChannel(CHANNELS.questions);
  fake.addChannel(CHANNELS.notices);
  const chat = new DiscordChat({
    token: TOKEN,
    channels: CHANNELS,
    fetch: fake.fetch,
  });
  return { fake, chat };
}

describe("splitMessage", () => {
  it("上限以下ならそのまま1件", () => {
    expect(splitMessage("abc", 3)).toEqual(["abc"]);
  });

  it("空の文は0件", () => {
    expect(splitMessage("", 3)).toEqual([]);
  });

  it("上限の後ろ半分に改行があれば改行の後ろで分ける", () => {
    expect(splitMessage("abc\ndefgh", 6)).toEqual(["abc\n", "defgh"]);
  });

  it("改行が前すぎるときは上限で分ける", () => {
    expect(splitMessage("a\nbcdefgh", 6)).toEqual(["a\nbcde", "fgh"]);
  });

  it("サロゲートペアの文字を途中で切らない", () => {
    const text = "😀".repeat(5);
    const parts = splitMessage(text, 2);
    expect(parts).toEqual(["😀😀", "😀😀", "😀"]);
  });
});

describe("DiscordChat", () => {
  it("after を省くと最初から全部を古い順に読む", async () => {
    const { fake, chat } = setup();
    const ids = Array.from({ length: 205 }, (_, i) =>
      fake.addMessage(CHANNELS.requirements, {
        authorId: "1",
        content: `m${i}`,
      }),
    );
    const got = await chat.readMessages(CHANNELS.requirements);
    expect(got.map((m) => m.id)).toEqual(ids);
  });

  it("対象のチャンネルの下のスレッドは読める", async () => {
    const { fake, chat } = setup();
    const root = await chat.post(CHANNELS.questions, "もと");
    const thread = await chat.createThread(CHANNELS.questions, root, "t");
    const id = fake.addMessage(thread, { authorId: "1", content: "答え" });
    expect(await chat.readMessages(thread)).toEqual([
      { id, authorId: "1", text: "答え" },
    ]);
  });

  it("投稿を1件読む。無い投稿・対象外のチャンネルは undefined", async () => {
    const { fake, chat } = setup();
    const id = fake.addMessage(CHANNELS.requirements, {
      authorId: "1",
      content: "要件\n続き",
    });
    expect(await chat.readMessage(CHANNELS.requirements, id)).toEqual({
      id,
      authorId: "1",
      text: "要件\n続き",
    });
    expect(
      await chat.readMessage(CHANNELS.requirements, "123456"),
    ).toBeUndefined();
    expect(await chat.readMessage("404", id)).toBeUndefined();
  });

  it("無いチャンネルは対象外として空を返す", async () => {
    const { chat } = setup();
    expect(await chat.readMessages("404")).toEqual([]);
    expect(await chat.readReactions("404", "1")).toEqual([]);
  });

  it("空の文は書き込めない", async () => {
    const { chat } = setup();
    await expect(chat.post(CHANNELS.notices, "")).rejects.toThrow("空");
  });

  it("書き込みでは人を呼び出さない（allowed_mentions）", async () => {
    const { fake, chat } = setup();
    await chat.post(CHANNELS.notices, "@everyone");
    const last = fake.requests.at(-1);
    expect(last?.body).toEqual({
      content: "@everyone",
      allowed_mentions: { parse: [] },
    });
  });

  it("スレッドの名前は 100 文字に切り詰める", async () => {
    const { fake, chat } = setup();
    const root = await chat.post(CHANNELS.questions, "もと");
    const thread = await chat.createThread(
      CHANNELS.questions,
      root,
      "あ".repeat(150),
    );
    expect(fake.channels.get(thread)?.name).toBe("あ".repeat(100));
  });

  it("リアクションの人が多くても全員を読む", async () => {
    const { fake, chat } = setup();
    const m = await chat.post(CHANNELS.notices, "x");
    const users = Array.from({ length: 130 }, (_, i) => String(5000 + i));
    for (const u of users) fake.addReaction(m, "👍", u);
    expect(await chat.readReactions(CHANNELS.notices, m)).toEqual([
      { emoji: "👍", userIds: users },
    ]);
  });

  it("アーカイブ済みのスレッドもロックでき、アーカイブされたままになる", async () => {
    const { fake, chat } = setup();
    const root = await chat.post(CHANNELS.questions, "もと");
    const thread = await chat.createThread(CHANNELS.questions, root, "t");
    await chat.archiveThread(thread);
    await chat.lockThread(thread);
    expect(fake.channels.get(thread)).toEqual(
      expect.objectContaining({ archived: true, locked: true }),
    );
    const patches = fake.requests
      .filter((r) => r.method === "PATCH")
      .map((r) => r.body);
    expect(patches).toEqual([
      { archived: true },
      { archived: false, locked: true },
      { archived: true },
    ]);
  });

  it("独自の絵文字は name:id で読む", async () => {
    const calls: string[] = [];
    const fetchStub: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/reactions/")) return json(200, [{ id: "7" }]);
      return json(200, {
        id: "2",
        content: "x",
        author: { id: "1" },
        reactions: [{ emoji: { id: "55", name: "ok" } }],
      });
    };
    const chat = new DiscordChat({
      token: TOKEN,
      channels: CHANNELS,
      fetch: fetchStub,
    });
    expect(await chat.readReactions(CHANNELS.notices, "2")).toEqual([
      { emoji: "ok:55", userIds: ["7"] },
    ]);
    expect(calls[1]).toContain("/reactions/ok%3A55?");
  });

  it("Bot 自身の ID は /users/@me から取り、一度取ったら覚える", async () => {
    const calls: string[] = [];
    const fetchStub: typeof fetch = async (input) => {
      calls.push(String(input));
      return json(200, { id: "3000" });
    };
    const chat = new DiscordChat({
      token: TOKEN,
      channels: CHANNELS,
      fetch: fetchStub,
    });
    expect(await chat.selfId()).toBe("3000");
    expect(await chat.selfId()).toBe("3000");
    expect(calls).toEqual(["https://discord.com/api/v10/users/@me"]);
  });

  it("429 のときは retry_after だけ待ってやり直す", async () => {
    let n = 0;
    const fetchStub: typeof fetch = async () => {
      n++;
      if (n === 1) return json(429, { retry_after: 1.5, message: "limited" });
      return json(200, { id: "9", content: "x", author: { id: "1" } });
    };
    const sleep = vi.fn(async () => {});
    const chat = new DiscordChat({
      token: TOKEN,
      channels: CHANNELS,
      fetch: fetchStub,
      sleep,
    });
    expect(await chat.post(CHANNELS.notices, "x")).toBe("9");
    expect(sleep).toHaveBeenCalledWith(1500);
  });

  it("失敗はトークンを含めずにエラーにする", async () => {
    const fetchStub: typeof fetch = async () =>
      json(500, { message: "Internal" });
    const chat = new DiscordChat({
      token: TOKEN,
      channels: CHANNELS,
      fetch: fetchStub,
    });
    const error: unknown = await chat
      .post(CHANNELS.notices, "x")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DiscordApiError);
    expect(String(error)).toContain("500 Internal");
    expect(String(error)).not.toContain(TOKEN);
  });

  it("対象のチャンネル以外の 403・404 以外の失敗はそのまま投げる", async () => {
    const fetchStub: typeof fetch = async () => json(500, { message: "x" });
    const chat = new DiscordChat({
      token: TOKEN,
      channels: CHANNELS,
      fetch: fetchStub,
    });
    await expect(chat.readMessages("77")).rejects.toThrow(DiscordApiError);
  });
});

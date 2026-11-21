import { describe, expect, it } from "vitest";

import { MemoryChat } from "./chat.js";
import type { ChatConfig } from "./config.js";
import { receiveRequirements, threadName } from "./requirements.js";
import { MemoryStore } from "./store.js";

const chatConfig: ChatConfig = {
  type: "discord",
  channels: { requirements: "100", questions: "200", notices: "300" },
  allowed_users: ["u1"],
};

function deps(chat: MemoryChat, store = new MemoryStore()) {
  const logs: string[] = [];
  return {
    deps: { chat, chatConfig, store, log: (t: string) => logs.push(t) },
    store,
    logs,
  };
}

describe("threadName", () => {
  it("最初の空でない行を名前にする", () => {
    expect(threadName("\n  検索  \n前方一致")).toBe("検索");
  });
  it("本文が空なら「要件」", () => {
    expect(threadName("  \n")).toBe("要件");
  });
});

describe("receiveRequirements", () => {
  it("許可した人の投稿だけを受け取り、読んだ位置を進める", async () => {
    const chat = new MemoryChat("bot");
    chat.addMessage("100", { authorId: "other", text: "勝手に" });
    const posted = chat.addMessage("100", { authorId: "u1", text: "検索" });
    const last = chat.addMessage("100", { authorId: "bot", text: "Bot" });
    const { deps: d, store, logs } = deps(chat);

    expect(await receiveRequirements(d)).toBe(1);

    const [req] = await store.listRequirements();
    expect(req?.messageId).toBe(posted.id);
    const thread = chat.threads.get(req!.threadId!);
    // 要件チャンネルのその投稿からスレッドを作り、何も書かない
    expect(thread?.channelId).toBe("100");
    expect(thread?.messageId).toBe(posted.id);
    expect(thread?.name).toBe("検索");
    expect(chat.messages.get(req!.threadId!)).toBeUndefined();
    expect(chat.messages.get("200")).toBeUndefined();
    expect(await store.getReadPosition("100")).toBe(last.id);
    expect(logs).toHaveLength(1);

    // 次の確認では何も受け取らない
    expect(await receiveRequirements(d)).toBe(0);
    expect(chat.threads.size).toBe(1);
  });

  it("途中で失敗したら、失敗した投稿から次の確認でやり直す", async () => {
    const chat = new MemoryChat("bot");
    const first = chat.addMessage("100", { authorId: "u1", text: "一つ目" });
    const second = chat.addMessage("100", { authorId: "u1", text: "二つ目" });
    const { deps: d, store } = deps(chat);
    const original = chat.createThread.bind(chat);
    let calls = 0;
    chat.createThread = (c, m, n) => {
      calls++;
      if (calls === 2) return Promise.reject(new Error("落ちた"));
      return original(c, m, n);
    };

    await expect(receiveRequirements(d)).rejects.toThrow("落ちた");
    expect(await store.getReadPosition("100")).toBe(first.id);

    expect(await receiveRequirements(d)).toBe(1);
    expect((await store.listRequirements()).map((r) => r.messageId)).toEqual([
      first.id,
      second.id,
    ]);
  });

  it("記録済みの投稿は、読んだ位置が無くても受け取り直さない", async () => {
    const chat = new MemoryChat("bot");
    const posted = chat.addMessage("100", { authorId: "u1", text: "検索" });
    const { deps: d, store } = deps(chat);
    await store.updateRequirement(posted.id, { threadId: "t" });

    expect(await receiveRequirements(d)).toBe(0);
    expect(chat.threads.size).toBe(0);
  });
});

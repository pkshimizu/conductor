import { describe, expect, it } from "vitest";
import { MEMORY_BOT_ID, MemoryChat } from "./chat.js";

describe("MemoryChat", () => {
  it("書き込みは古い順に読め、書き手は bot になる", async () => {
    const chat = new MemoryChat();
    const first = await chat.post("c", "1つ目");
    const second = await chat.post("c", "2つ目");
    expect(first).not.toBe(second);
    expect(await chat.readMessages("c")).toEqual([
      { id: first, authorId: MEMORY_BOT_ID, text: "1つ目" },
      { id: second, authorId: MEMORY_BOT_ID, text: "2つ目" },
    ]);
    expect(await chat.readMessages("none")).toEqual([]);
  });

  it("after を渡すと、その投稿より後の投稿だけが古い順に読める", async () => {
    const chat = new MemoryChat();
    const first = await chat.post("c", "1つ目");
    const second = await chat.post("c", "2つ目");
    const third = await chat.post("c", "3つ目");
    expect((await chat.readMessages("c", first)).map((m) => m.id)).toEqual([
      second,
      third,
    ]);
    expect(await chat.readMessages("c", third)).toEqual([]);
  });

  it("リアクションは絵文字ごとにまとまり、同じ人は重ならない", async () => {
    const chat = new MemoryChat();
    const m = chat.addMessage("c", { authorId: "u1", text: "x" });
    chat.addReaction("c", m.id, "👍", "u1");
    chat.addReaction("c", m.id, "👍", "u1");
    chat.addReaction("c", m.id, "👍", "u2");
    chat.addReaction("c", m.id, "✅", "u1");
    expect(await chat.readReactions("c", m.id)).toEqual([
      { emoji: "👍", userIds: ["u1", "u2"] },
      { emoji: "✅", userIds: ["u1"] },
    ]);
  });

  it("リアクションの無い投稿は空", async () => {
    const chat = new MemoryChat();
    const m = chat.addMessage("c", { authorId: "u1", text: "x" });
    expect(await chat.readReactions("c", m.id)).toEqual([]);
  });

  it("無い投稿・無いスレッドへの操作は失敗する", async () => {
    const chat = new MemoryChat();
    await expect(chat.createThread("c", "9", "t")).rejects.toThrow("投稿");
    await expect(chat.readReactions("c", "9")).rejects.toThrow("投稿");
    await expect(chat.archiveThread("9")).rejects.toThrow("スレッド");
    await expect(chat.lockThread("9")).rejects.toThrow("スレッド");
  });

  it("読み出した投稿を変えても中身は変わらない", async () => {
    const chat = new MemoryChat();
    await chat.post("c", "元");
    const [m] = await chat.readMessages("c");
    m!.text = "変更";
    expect((await chat.readMessages("c"))[0]!.text).toBe("元");
  });
});

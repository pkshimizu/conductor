import { describe, expect, it } from "vitest";
import { MemoryChat } from "./chat.js";
import { requirementText, threadConversation } from "./requirement-text.js";

const config = {
  channels: { requirements: "req", questions: "q", notices: "n" },
};

describe("requirementText", () => {
  it("要件チャンネルの元の投稿の本文を返す", async () => {
    const chat = new MemoryChat("bot");
    const posted = chat.addMessage("req", {
      authorId: "u",
      text: "要件\n続き",
    });
    // スレッドに Bot の空の書き込みがあっても、元の投稿から読む
    const thread = await chat.createThread("req", posted.id, "要件");
    chat.addMessage(thread, { authorId: "bot", text: "" });
    expect(await requirementText(chat, config, posted.id)).toBe("要件\n続き");
  });

  it("投稿が無い・本文が空なら undefined", async () => {
    const chat = new MemoryChat("bot");
    const empty = chat.addMessage("req", { authorId: "u", text: "  " });
    expect(await requirementText(chat, config, empty.id)).toBeUndefined();
    expect(await requirementText(chat, config, "999")).toBeUndefined();
  });
});

describe("threadConversation", () => {
  it("中身が空の書き込みを除く", () => {
    expect(
      threadConversation([
        { id: "1", authorId: "bot", text: "" },
        { id: "2", authorId: "u", text: "答え" },
      ]),
    ).toEqual([{ id: "2", authorId: "u", text: "答え" }]);
  });
});

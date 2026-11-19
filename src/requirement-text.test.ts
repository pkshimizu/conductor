import { describe, expect, it } from "vitest";
import type { Chat } from "./chat.js";
import {
  requirementText,
  requirementTextFrom,
  unquote,
} from "./requirement-text.js";

describe("unquote", () => {
  it("行頭の引用の形を外す", () => {
    expect(unquote("> a\r\n>b\nc")).toBe("a\nb\nc");
  });
});

describe("requirementTextFrom", () => {
  it("Bot の最初の書き込みを要件の本文にする", () => {
    const thread = [
      { id: "1", authorId: "u", text: "> 人" },
      { id: "2", authorId: "bot", text: "> 要件\n> 続き" },
      { id: "3", authorId: "bot", text: "> 後" },
    ];
    expect(requirementTextFrom(thread, "bot")).toBe("要件\n続き");
  });

  it("Bot の書き込みが無ければ undefined", () => {
    expect(
      requirementTextFrom([{ id: "1", authorId: "u", text: "x" }], "bot"),
    ).toBeUndefined();
  });
});

describe("requirementText", () => {
  it("スレッドを読んで取り出す", async () => {
    const chat: Pick<Chat, "selfId" | "readMessages"> = {
      selfId: () => Promise.resolve("bot"),
      readMessages: (id) =>
        Promise.resolve([{ id: "1", authorId: "bot", text: `> ${id}` }]),
    };
    expect(await requirementText(chat, "t1")).toBe("t1");
  });
});

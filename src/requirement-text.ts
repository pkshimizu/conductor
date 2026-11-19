/**
 * 要件の本文の取り出し。要件の本文は、スレッドで Bot が最初に書いた投稿（受け取りのときに書いた引用）。
 * 引用の形や書く場所が変わったら、ここだけを直す。
 */
import type { Chat, ChatMessage } from "./chat.js";

/** 引用の形（"> "）を外す */
export function unquote(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/^> ?/, ""))
    .join("\n");
}

/** 読んだスレッドの投稿から要件の本文を取り出す。Bot の書き込みが無ければ undefined */
export function requirementTextFrom(
  thread: readonly ChatMessage[],
  botId: string,
): string | undefined {
  const quoted = thread.find((m) => m.authorId === botId);
  return quoted === undefined ? undefined : unquote(quoted.text);
}

/** スレッドを読んで要件の本文を取り出す。Bot の書き込みが無ければ undefined */
export async function requirementText(
  chat: Pick<Chat, "selfId" | "readMessages">,
  threadId: string,
): Promise<string | undefined> {
  const botId = await chat.selfId();
  const thread = await chat.readMessages(threadId);
  return requirementTextFrom(thread, botId);
}

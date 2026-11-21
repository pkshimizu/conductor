/**
 * 要件の本文の取り出し。要件の本文は、要件チャンネルの元の投稿（記録の messageId）。
 * スレッドがどのチャンネルにあっても（以前の要件は質問チャンネル）、同じ読み方で取れる。
 * 読む場所が変わったら、ここだけを直す。
 */
import type { Chat, ChatMessage } from "./chat.js";
import type { ChatConfig } from "./config.js";

/**
 * 要件チャンネルの元の投稿を読んで要件の本文を取り出す。
 * 投稿が無い・本文が空なら undefined
 */
export async function requirementText(
  chat: Pick<Chat, "readMessage">,
  chatConfig: Pick<ChatConfig, "channels">,
  messageId: string,
): Promise<string | undefined> {
  const posted = await chat.readMessage(
    chatConfig.channels.requirements,
    messageId,
  );
  if (posted === undefined || posted.text.trim() === "") return undefined;
  return posted.text;
}

/**
 * スレッドのやり取りから、中身が空の書き込みを除く。
 * Discord は投稿からスレッドを作ると、先頭に中身が空の「スレッドの元の書き込み」を入れる
 */
export function threadConversation(
  thread: readonly ChatMessage[],
): ChatMessage[] {
  return thread.filter((m) => m.text.trim() !== "");
}

/**
 * 要件の受け取り。要件チャンネルの新しい投稿を読み、許可した人の投稿1つを要件1件として記録し、
 * 質問チャンネルにその要件のスレッドを作って本文を引用して書く。
 * どこまで読んだかは Store に残すので、再起動しても二重に受け取らない。
 */
import type { Chat, ChatMessage } from "./chat.js";
import type { ChatConfig } from "./config.js";
import type { Store } from "./store.js";

/** 本文が空の投稿（添付だけなど）のスレッドの名前 */
const DEFAULT_THREAD_NAME = "要件";

export interface RequirementIntakeDeps {
  chat: Chat;
  chatConfig: ChatConfig;
  store: Store;
  log(text: string): void;
}

/** スレッドの名前。本文の最初の空でない行 */
export function threadName(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() !== "") return line.trim();
  }
  return DEFAULT_THREAD_NAME;
}

/** 本文を引用の形（各行の先頭に "> "）にする */
export function quote(text: string): string {
  const body = text.trim() === "" ? "（本文なし）" : text;
  const lines = body.split(/\r?\n/);
  return lines.map((l) => `> ${l}`).join("\n");
}

/** 質問チャンネルに書く、スレッドのもとになる文 */
export function headline(message: ChatMessage): string {
  return `要件を受け取りました（<@${message.authorId}>）: ${threadName(message.text)}`;
}

/**
 * 要件チャンネルの新しい投稿を受け取る。受け取った要件の数を返す。
 * 1件ごとに読んだ位置を記録するので、途中で失敗しても次の確認で続きから読む。
 */
export async function receiveRequirements(
  deps: RequirementIntakeDeps,
): Promise<number> {
  const { chat, chatConfig, store } = deps;
  const { requirements, questions } = chatConfig.channels;
  const allowed = new Set(chatConfig.allowed_users);
  const after = await store.getReadPosition(requirements);
  const messages = await chat.readMessages(requirements, after);
  let received = 0;
  for (const message of messages) {
    if (
      allowed.has(message.authorId) &&
      (await store.getRequirement(message.id)) === undefined
    ) {
      const head = await chat.post(questions, headline(message));
      const threadId = await chat.createThread(
        questions,
        head,
        threadName(message.text),
      );
      await chat.post(threadId, quote(message.text));
      await store.updateRequirement(message.id, { threadId });
      deps.log(`要件を受け取りました（投稿 ${message.id}）`);
      received++;
    }
    await store.setReadPosition(requirements, message.id);
  }
  return received;
}

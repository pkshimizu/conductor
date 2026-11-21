/**
 * 要件の受け取り。要件チャンネルの新しい投稿を読み、許可した人の投稿1つを要件1件として記録し、
 * 要件チャンネルのその投稿から要件のスレッドを作る（要件のやり取りはすべてそのスレッドで行う）。
 * どこまで読んだかは Store に残すので、再起動しても二重に受け取らない。
 */
import type { Chat } from "./chat.js";
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

/**
 * 要件チャンネルの新しい投稿を受け取る。受け取った要件の数を返す。
 * 1件ごとに読んだ位置を記録するので、途中で失敗しても次の確認で続きから読む。
 */
export async function receiveRequirements(
  deps: RequirementIntakeDeps,
): Promise<number> {
  const { chat, chatConfig, store } = deps;
  const { requirements } = chatConfig.channels;
  const allowed = new Set(chatConfig.allowed_users);
  const after = await store.getReadPosition(requirements);
  const messages = await chat.readMessages(requirements, after);
  let received = 0;
  for (const message of messages) {
    if (
      allowed.has(message.authorId) &&
      (await store.getRequirement(message.id)) === undefined
    ) {
      // 要件チャンネルのその投稿からスレッドを作る（質問チャンネルにも引用にも書かない）
      const threadId = await chat.createThread(
        requirements,
        message.id,
        threadName(message.text),
      );
      await store.updateRequirement(message.id, { threadId });
      deps.log(`要件を受け取りました（投稿 ${message.id}）`);
      received++;
    }
    await store.setReadPosition(requirements, message.id);
  }
  return received;
}

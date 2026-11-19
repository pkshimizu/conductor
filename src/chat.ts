/**
 * 窓口（要件の受け取りと人への質問を行うチャット）の共通の型。
 * Discord などの実装はこの型に合わせて作り、テストでは MemoryChat に差し替える。
 * チャンネルとスレッドはどちらも ID（文字列）で指す。
 */

/** チャンネルまたはスレッドの投稿 */
export interface ChatMessage {
  id: string;
  /** 書いた人のユーザー ID */
  authorId: string;
  text: string;
}

/** 投稿に付いたリアクション（絵文字ごと） */
export interface ChatReaction {
  emoji: string;
  /** その絵文字を付けた人のユーザー ID */
  userIds: string[];
}

export interface Chat {
  /** Bot 自身のユーザー ID（Bot の書き込みを見分けるのに使う） */
  selfId(): Promise<string>;
  /**
   * チャンネルまたはスレッドの投稿を、古い順に読む。
   * `after`（投稿 ID）を渡すと、その投稿より後の投稿だけを返す（前回の続きから読む）
   */
  readMessages(channelId: string, after?: string): Promise<ChatMessage[]>;
  /** 投稿からスレッドを作り、スレッドの ID を返す */
  createThread(
    channelId: string,
    messageId: string,
    name: string,
  ): Promise<string>;
  /** チャンネルまたはスレッドに書き込み、投稿の ID を返す */
  post(channelId: string, text: string): Promise<string>;
  /** 投稿に付いたリアクションを読む */
  readReactions(channelId: string, messageId: string): Promise<ChatReaction[]>;
  /** スレッドをアーカイブする */
  archiveThread(threadId: string): Promise<void>;
  /** スレッドをロックする（人が書き込めないようにする） */
  lockThread(threadId: string): Promise<void>;
}

/** MemoryChat のスレッド */
export interface MemoryThread {
  /** 作ったもとのチャンネル */
  channelId: string;
  /** 作ったもとの投稿 */
  messageId: string;
  name: string;
  archived: boolean;
  locked: boolean;
}

/** MemoryChat が書き込むときの書き手 */
export const MEMORY_BOT_ID = "conductor";

/** メモリ上の偽の窓口（テスト用）。Discord なしで窓口の操作を試せる */
export class MemoryChat implements Chat {
  /** チャンネル（またはスレッド）ID → 投稿（古い順） */
  readonly messages = new Map<string, ChatMessage[]>();
  /** スレッド ID → スレッド */
  readonly threads = new Map<string, MemoryThread>();
  /** "チャンネル ID/投稿 ID" → 絵文字 → 付けた人 */
  private readonly reactions = new Map<string, Map<string, string[]>>();
  private nextId = 1;

  constructor(readonly botId: string = MEMORY_BOT_ID) {}

  /** 人の投稿を置く（テストの準備用） */
  addMessage(
    channelId: string,
    message: { authorId: string; text: string },
  ): ChatMessage {
    const posted: ChatMessage = { id: this.newId(), ...message };
    const list = this.messages.get(channelId) ?? [];
    list.push(posted);
    this.messages.set(channelId, list);
    return posted;
  }

  /** 投稿にリアクションを付ける（テストの準備用） */
  addReaction(
    channelId: string,
    messageId: string,
    emoji: string,
    userId: string,
  ): void {
    this.findMessage(channelId, messageId);
    const key = reactionKey(channelId, messageId);
    const byEmoji = this.reactions.get(key) ?? new Map<string, string[]>();
    const users = byEmoji.get(emoji) ?? [];
    if (!users.includes(userId)) users.push(userId);
    byEmoji.set(emoji, users);
    this.reactions.set(key, byEmoji);
  }

  async selfId(): Promise<string> {
    return this.botId;
  }

  async readMessages(
    channelId: string,
    after?: string,
  ): Promise<ChatMessage[]> {
    const list = this.messages.get(channelId) ?? [];
    // ID は作った順に大きくなる（Discord の投稿 ID と同じ）ので、大小で比べる
    return list
      .filter((m) => after === undefined || BigInt(m.id) > BigInt(after))
      .map((m) => ({ ...m }));
  }

  async createThread(
    channelId: string,
    messageId: string,
    name: string,
  ): Promise<string> {
    this.findMessage(channelId, messageId);
    const id = this.newId();
    this.threads.set(id, {
      channelId,
      messageId,
      name,
      archived: false,
      locked: false,
    });
    return id;
  }

  async post(channelId: string, text: string): Promise<string> {
    return this.addMessage(channelId, { authorId: this.botId, text }).id;
  }

  async readReactions(
    channelId: string,
    messageId: string,
  ): Promise<ChatReaction[]> {
    this.findMessage(channelId, messageId);
    const byEmoji = this.reactions.get(reactionKey(channelId, messageId));
    return [...(byEmoji ?? [])].map(([emoji, userIds]) => ({
      emoji,
      userIds: [...userIds],
    }));
  }

  async archiveThread(threadId: string): Promise<void> {
    this.findThread(threadId).archived = true;
  }

  async lockThread(threadId: string): Promise<void> {
    this.findThread(threadId).locked = true;
  }

  private newId(): string {
    return String(this.nextId++);
  }

  private findMessage(channelId: string, messageId: string): ChatMessage {
    const found = this.messages.get(channelId)?.find((m) => m.id === messageId);
    if (found === undefined) {
      throw new Error(`投稿がありません: ${channelId}/${messageId}`);
    }
    return found;
  }

  private findThread(threadId: string): MemoryThread {
    const found = this.threads.get(threadId);
    if (found === undefined) {
      throw new Error(`スレッドがありません: ${threadId}`);
    }
    return found;
  }
}

function reactionKey(channelId: string, messageId: string): string {
  return `${channelId}/${messageId}`;
}

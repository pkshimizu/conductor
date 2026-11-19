/**
 * 窓口（Chat）の Discord による実装。
 * PC から Discord の REST API（v10）を読みにいくだけ（ポーリング）で、Gateway・Webhook は使わない。
 */
import { z } from "zod";

import type { Chat, ChatMessage, ChatReaction } from "./chat.js";
import type { ChatConfig } from "./config.js";

export const DISCORD_API_BASE = "https://discord.com/api/v10";
/** Discord の1件の投稿の文字数の上限 */
export const DISCORD_MESSAGE_MAX_LENGTH = 2000;
/** スレッドの名前の文字数の上限 */
export const DISCORD_THREAD_NAME_MAX_LENGTH = 100;
/** 1回の要求で読む件数（Discord の上限） */
const PAGE_LIMIT = 100;
/** 429（回数の制限）のときにやり直す回数 */
const MAX_RATE_LIMIT_RETRIES = 5;
const USER_AGENT = "DiscordBot (conductor, 1.0)";

export interface DiscordChatOptions {
  /** Bot のトークン（Authorization: Bot <token> で送る） */
  token: string;
  /** 要件・質問・お知らせのチャンネル ID */
  channels: ChatConfig["channels"];
  /** Discord の REST API を呼ぶ関数。省略時は globalThis.fetch */
  fetch?: typeof fetch;
  /** 待つ関数（429 のとき）。省略時は setTimeout */
  sleep?: (ms: number) => Promise<void>;
}

/** Discord の API が失敗したとき（トークンは含めない） */
export class DiscordApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    detail: string,
  ) {
    super(
      `Discord の API が失敗しました（${method} ${path}: ${status} ${detail}）`,
    );
    this.name = "DiscordApiError";
  }
}

const channelSchema = z.object({
  id: z.string(),
  parent_id: z.string().nullable().optional(),
  thread_metadata: z.object({ archived: z.boolean() }).optional(),
});

const messageSchema = z.object({
  id: z.string(),
  content: z.string(),
  author: z.object({ id: z.string() }),
  reactions: z
    .array(
      z.object({
        emoji: z.object({
          id: z.string().nullable().optional(),
          name: z.string().nullable().optional(),
        }),
      }),
    )
    .optional(),
});

const userSchema = z.object({ id: z.string() });

const errorSchema = z.object({ message: z.string() }).partial();
const rateLimitSchema = z.object({ retry_after: z.number() });

type ChatChannels = ChatConfig["channels"];

export class DiscordChat implements Chat {
  private readonly token: string;
  private readonly targets: ReadonlySet<string>;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  /** チャンネル ID → 対象（要件・質問・お知らせか、その下のスレッド）か */
  private readonly allowed = new Map<string, boolean>();

  constructor(options: DiscordChatOptions) {
    this.token = options.token;
    const channels: ChatChannels = options.channels;
    this.targets = new Set([
      channels.requirements,
      channels.questions,
      channels.notices,
    ]);
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async readMessages(
    channelId: string,
    after?: string,
  ): Promise<ChatMessage[]> {
    if (!(await this.isTarget(channelId))) return [];
    const result: ChatMessage[] = [];
    let cursor = after ?? "0";
    for (;;) {
      const query = new URLSearchParams({
        after: cursor,
        limit: String(PAGE_LIMIT),
      });
      const page = await this.request(
        "GET",
        `/channels/${seg(channelId)}/messages?${query.toString()}`,
        z.array(messageSchema),
      );
      const sorted = [...page].sort((a, b) => compareId(a.id, b.id));
      for (const m of sorted) {
        result.push({ id: m.id, authorId: m.author.id, text: m.content });
      }
      const last = sorted.at(-1);
      if (last === undefined || page.length < PAGE_LIMIT) break;
      cursor = last.id;
    }
    return result;
  }

  async createThread(
    channelId: string,
    messageId: string,
    name: string,
  ): Promise<string> {
    const thread = await this.request(
      "POST",
      `/channels/${seg(channelId)}/messages/${seg(messageId)}/threads`,
      channelSchema,
      { name: truncate(name, DISCORD_THREAD_NAME_MAX_LENGTH) },
    );
    return thread.id;
  }

  async post(channelId: string, text: string): Promise<string> {
    const parts = splitMessage(text, DISCORD_MESSAGE_MAX_LENGTH);
    let firstId: string | undefined;
    for (const content of parts) {
      const created = await this.request(
        "POST",
        `/channels/${seg(channelId)}/messages`,
        messageSchema,
        // @everyone などで人を呼び出さない
        { content, allowed_mentions: { parse: [] } },
      );
      firstId ??= created.id;
    }
    if (firstId === undefined) {
      throw new Error("空の文は書き込めません");
    }
    return firstId;
  }

  async readReactions(
    channelId: string,
    messageId: string,
  ): Promise<ChatReaction[]> {
    if (!(await this.isTarget(channelId))) return [];
    const base = `/channels/${seg(channelId)}/messages/${seg(messageId)}`;
    const message = await this.request("GET", base, messageSchema);
    const result: ChatReaction[] = [];
    for (const reaction of message.reactions ?? []) {
      const emoji = emojiName(reaction.emoji);
      if (emoji === undefined) continue;
      const userIds: string[] = [];
      let cursor: string | undefined;
      for (;;) {
        const query = new URLSearchParams({ limit: String(PAGE_LIMIT) });
        if (cursor !== undefined) query.set("after", cursor);
        const users = await this.request(
          "GET",
          `${base}/reactions/${seg(emoji)}?${query.toString()}`,
          z.array(userSchema),
        );
        userIds.push(...users.map((u) => u.id));
        const last = users.at(-1);
        if (last === undefined || users.length < PAGE_LIMIT) break;
        cursor = last.id;
      }
      result.push({ emoji, userIds });
    }
    return result;
  }

  async archiveThread(threadId: string): Promise<void> {
    await this.request("PATCH", `/channels/${seg(threadId)}`, channelSchema, {
      archived: true,
    });
  }

  async lockThread(threadId: string): Promise<void> {
    const path = `/channels/${seg(threadId)}`;
    const thread = await this.request("GET", path, channelSchema);
    if (thread.thread_metadata?.archived === true) {
      // アーカイブ済みのスレッドは archived: false と一緒でないと変えられないので、
      // ロックしてからアーカイブし直す
      await this.request("PATCH", path, channelSchema, {
        archived: false,
        locked: true,
      });
      await this.request("PATCH", path, channelSchema, { archived: true });
      return;
    }
    await this.request("PATCH", path, channelSchema, { locked: true });
  }

  /** 要件・質問・お知らせのチャンネルか、その下のスレッドか */
  private async isTarget(channelId: string): Promise<boolean> {
    if (this.targets.has(channelId)) return true;
    const cached = this.allowed.get(channelId);
    if (cached !== undefined) return cached;
    let ok: boolean;
    try {
      const channel = await this.request(
        "GET",
        `/channels/${seg(channelId)}`,
        channelSchema,
      );
      const parent = channel.parent_id;
      ok = parent !== undefined && parent !== null && this.targets.has(parent);
    } catch (error) {
      // 見えない・無いチャンネルは対象外
      if (
        error instanceof DiscordApiError &&
        (error.status === 403 || error.status === 404)
      ) {
        ok = false;
      } else {
        throw error;
      }
    }
    this.allowed.set(channelId, ok);
    return ok;
  }

  private async request<T>(
    method: string,
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bot ${this.token}`,
      "User-Agent": USER_AGENT,
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    for (let attempt = 0; ; attempt++) {
      const response = await this.fetchFn(`${DISCORD_API_BASE}${path}`, init);
      if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
        const limited = rateLimitSchema.safeParse(await readJson(response));
        const seconds = limited.success ? limited.data.retry_after : 1;
        await this.sleep(Math.ceil(seconds * 1000));
        continue;
      }
      const data = await readJson(response);
      if (!response.ok) {
        const parsed = errorSchema.safeParse(data);
        const detail =
          parsed.success && parsed.data.message !== undefined
            ? parsed.data.message
            : response.statusText;
        throw new DiscordApiError(response.status, method, path, detail);
      }
      return schema.parse(data);
    }
  }
}

/**
 * 文を上限の文字数ごとに分ける。つなぐともとの文になる。
 * 上限の後ろ半分に改行があれば、改行の後ろで分ける。
 */
export function splitMessage(text: string, max: number): string[] {
  const chars = [...text];
  const parts: string[] = [];
  let start = 0;
  while (chars.length - start > max) {
    let end = start + max;
    for (let i = end - 1; i >= start + Math.floor(max / 2); i--) {
      if (chars[i] === "\n") {
        end = i + 1;
        break;
      }
    }
    parts.push(chars.slice(start, end).join(""));
    start = end;
  }
  if (start < chars.length) parts.push(chars.slice(start).join(""));
  return parts;
}

/** 文字（UTF-16 の長さ）が max を超えないように切り詰める */
function truncate(text: string, max: number): string {
  let out = "";
  for (const ch of text) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

/** リアクションの絵文字の名前（独自の絵文字は name:id） */
function emojiName(emoji: {
  id?: string | null | undefined;
  name?: string | null | undefined;
}): string | undefined {
  if (emoji.name === undefined || emoji.name === null) return undefined;
  if (emoji.id === undefined || emoji.id === null) return emoji.name;
  return `${emoji.name}:${emoji.id}`;
}

function seg(value: string): string {
  return encodeURIComponent(value);
}

function compareId(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === "") return undefined;
  try {
    const data: unknown = JSON.parse(text);
    return data;
  } catch {
    return text;
  }
}

/**
 * Issue #39 の受け入れテスト用：Discord の REST API（v10）の偽物。
 *
 * `fetch` と同じ形の関数（`fake.fetch`）を DiscordChat に渡すと、
 * 実際の Discord に接続せずに、次の API がメモリ上で動く。
 *
 * - GET    /channels/{channel.id}
 * - PATCH  /channels/{channel.id}                      （archived・locked）
 * - GET    /channels/{channel.id}/messages             （after・before・limit。新しい順で返す。limit は既定 50・最大 100）
 * - GET    /channels/{channel.id}/messages/{message.id}
 * - POST   /channels/{channel.id}/messages             （content は 1〜2000 文字。超えると 400）
 * - POST   /channels/{channel.id}/messages/{message.id}/threads （スレッドの ID は投稿の ID と同じ）
 * - GET    /channels/{channel.id}/messages/{message.id}/reactions/{emoji}（after・limit。既定 25・最大 100）
 *
 * どの要求も `Authorization: Bot <token>` が無いと 401 を返す。
 */

export const DISCORD_HOST = "discord.com";
export const MESSAGE_MAX_LENGTH = 2000;

export interface FakeChannel {
  id: string;
  /** 0 = テキストチャンネル、11 = 公開スレッド */
  type: number;
  name: string;
  parentId: string | null;
  archived: boolean;
  locked: boolean;
}

export interface FakeMessage {
  id: string;
  channelId: string;
  authorId: string;
  bot: boolean;
  content: string;
}

export interface FakeRequest {
  method: string;
  url: string;
  authorization: string | null;
  body: unknown;
}

export class FakeDiscord {
  readonly channels = new Map<string, FakeChannel>();
  /** 投稿（全チャンネル、作った順） */
  readonly messages: FakeMessage[] = [];
  /** 受けた要求（受けた順） */
  readonly requests: FakeRequest[] = [];
  /** "投稿 ID" → 絵文字 → 付けた人（付けた順） */
  private readonly reactions = new Map<string, Map<string, string[]>>();
  private nextId = 1_300_000_000_000_000_000n;

  constructor(
    readonly token: string,
    readonly botId: string,
  ) {}

  /** `fetch` の代わりに渡す関数 */
  readonly fetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const text = request.method === "GET" ? "" : await request.text();
    let body: unknown = undefined;
    if (text !== "") {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    const authorization = request.headers.get("authorization");
    this.requests.push({
      method: request.method,
      url: request.url,
      authorization,
      body,
    });
    const url = new URL(request.url);
    if (url.host !== DISCORD_HOST) {
      throw new TypeError(`偽の Discord 以外への接続です: ${request.url}`);
    }
    if (authorization !== `Bot ${this.token}`) {
      return json(401, { message: "401: Unauthorized", code: 0 });
    }
    const match = /^\/api\/v\d+(\/.*)$/.exec(url.pathname);
    if (match === null) return notFound();
    const segments = match[1]!
      .split("/")
      .filter((s) => s !== "")
      .map((s) => decodeURIComponent(s));
    return this.route(request.method, segments, url.searchParams, body);
  };

  // ---- seed（テストの準備用） ----

  addChannel(
    id: string,
    options: { name?: string; parentId?: string } = {},
  ): FakeChannel {
    const channel: FakeChannel = {
      id,
      type: options.parentId === undefined ? 0 : 11,
      name: options.name ?? `channel-${id}`,
      parentId: options.parentId ?? null,
      archived: false,
      locked: false,
    };
    this.channels.set(id, channel);
    return channel;
  }

  /** 人（または bot）の投稿を置き、投稿の ID を返す */
  addMessage(
    channelId: string,
    message: { authorId: string; content: string; bot?: boolean },
  ): string {
    if (!this.channels.has(channelId)) {
      throw new Error(`チャンネルがありません: ${channelId}`);
    }
    const id = this.newId();
    this.messages.push({
      id,
      channelId,
      authorId: message.authorId,
      bot: message.bot ?? false,
      content: message.content,
    });
    return id;
  }

  addReaction(messageId: string, emoji: string, userId: string): void {
    if (!this.messages.some((m) => m.id === messageId)) {
      throw new Error(`投稿がありません: ${messageId}`);
    }
    const byEmoji =
      this.reactions.get(messageId) ?? new Map<string, string[]>();
    const users = byEmoji.get(emoji) ?? [];
    if (!users.includes(userId)) users.push(userId);
    byEmoji.set(emoji, users);
    this.reactions.set(messageId, byEmoji);
  }

  /** チャンネル（またはスレッド）の投稿（古い順） */
  messagesIn(channelId: string): FakeMessage[] {
    return this.messages.filter((m) => m.channelId === channelId);
  }

  /** 人（bot でない人）がそのスレッドに書き込めるか */
  humanCanPost(threadId: string): boolean {
    const channel = this.channels.get(threadId);
    if (channel === undefined) return false;
    return !channel.locked;
  }

  // ---- API ----

  private route(
    method: string,
    s: string[],
    query: URLSearchParams,
    body: unknown,
  ): Response {
    if (s[0] !== "channels" || s[1] === undefined) return notFound();
    const channel = this.channels.get(s[1]);
    if (channel === undefined) return unknown("Unknown Channel", 10003);

    // /channels/{id}
    if (s.length === 2) {
      if (method === "GET") return json(200, channelJson(channel));
      if (method === "PATCH") {
        const b = (body ?? {}) as { archived?: unknown; locked?: unknown };
        if (typeof b.archived === "boolean") channel.archived = b.archived;
        if (typeof b.locked === "boolean") channel.locked = b.locked;
        return json(200, channelJson(channel));
      }
      return methodNotAllowed();
    }
    if (s[2] !== "messages") return notFound();

    // /channels/{id}/messages
    if (s.length === 3) {
      if (method === "GET") return this.listMessages(channel, query);
      if (method === "POST") return this.createMessage(channel, body);
      return methodNotAllowed();
    }

    const message = this.messages.find(
      (m) => m.id === s[3] && m.channelId === channel.id,
    );
    if (message === undefined) return unknown("Unknown Message", 10008);

    // /channels/{id}/messages/{mid}
    if (s.length === 4) {
      if (method === "GET") return json(200, this.messageJson(message));
      return methodNotAllowed();
    }

    // /channels/{id}/messages/{mid}/threads
    if (s.length === 5 && s[4] === "threads") {
      if (method !== "POST") return methodNotAllowed();
      const name = (body as { name?: unknown } | undefined)?.name;
      if (typeof name !== "string" || name.length < 1 || name.length > 100) {
        return invalidForm("name");
      }
      if (this.channels.has(message.id)) {
        return json(400, {
          message: "A thread has already been created for this message",
          code: 160004,
        });
      }
      const thread = this.addChannel(message.id, {
        name,
        parentId: channel.id,
      });
      return json(201, channelJson(thread));
    }

    // /channels/{id}/messages/{mid}/reactions/{emoji}
    if (s.length === 6 && s[4] === "reactions" && method === "GET") {
      const users = this.reactions.get(message.id)?.get(s[5]!) ?? [];
      const after = query.get("after");
      const limit = clampLimit(query.get("limit"), 25);
      const list = users
        .filter((u) => after === null || BigInt(u) > BigInt(after))
        .sort((a, b) => compareId(a, b))
        .slice(0, limit);
      return json(
        200,
        list.map((id) => ({ id, username: `user-${id}` })),
      );
    }
    return notFound();
  }

  private listMessages(channel: FakeChannel, query: URLSearchParams): Response {
    const after = query.get("after");
    const before = query.get("before");
    const limit = clampLimit(query.get("limit"), 50);
    let list = this.messagesIn(channel.id);
    if (after !== null) {
      // after を付けると、その直後から limit 件（返す並びは新しい順）
      list = list
        .filter((m) => BigInt(m.id) > BigInt(after))
        .sort((a, b) => compareId(a.id, b.id))
        .slice(0, limit);
    } else {
      if (before !== null) {
        list = list.filter((m) => BigInt(m.id) < BigInt(before));
      }
      list = list.sort((a, b) => compareId(a.id, b.id)).slice(-limit);
    }
    return json(
      200,
      [...list].reverse().map((m) => this.messageJson(m)),
    );
  }

  private createMessage(channel: FakeChannel, body: unknown): Response {
    const content = (body as { content?: unknown } | undefined)?.content;
    if (typeof content !== "string" || content.length === 0) {
      return json(400, {
        message: "Cannot send an empty message",
        code: 50006,
      });
    }
    if ([...content].length > MESSAGE_MAX_LENGTH) {
      return invalidForm("content", "Must be 2000 or fewer in length.");
    }
    const id = this.addMessage(channel.id, {
      authorId: this.botId,
      content,
      bot: true,
    });
    const created = this.messages.find((m) => m.id === id)!;
    return json(200, this.messageJson(created));
  }

  private messageJson(m: FakeMessage): Record<string, unknown> {
    const byEmoji = this.reactions.get(m.id);
    const reactions = [...(byEmoji ?? [])].map(([name, users]) => ({
      count: users.length,
      me: users.includes(this.botId),
      emoji: { id: null, name },
    }));
    return {
      id: m.id,
      channel_id: m.channelId,
      type: 0,
      content: m.content,
      author: {
        id: m.authorId,
        username: `user-${m.authorId}`,
        ...(m.bot ? { bot: true } : {}),
      },
      timestamp: new Date(0).toISOString(),
      ...(reactions.length > 0 ? { reactions } : {}),
    };
  }

  private newId(): string {
    return String(this.nextId++);
  }
}

function channelJson(c: FakeChannel): Record<string, unknown> {
  return {
    id: c.id,
    type: c.type,
    name: c.name,
    parent_id: c.parentId,
    ...(c.type === 11
      ? {
          thread_metadata: {
            archived: c.archived,
            locked: c.locked,
            auto_archive_duration: 1440,
          },
        }
      : {}),
  };
}

function compareId(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function clampLimit(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return Math.min(n, 100);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function notFound(): Response {
  return json(404, { message: "404: Not Found", code: 0 });
}

function unknown(message: string, code: number): Response {
  return json(404, { message, code });
}

function methodNotAllowed(): Response {
  return json(405, { message: "405: Method Not Allowed", code: 0 });
}

function invalidForm(field: string, detail = "Invalid value"): Response {
  return json(400, {
    message: "Invalid Form Body",
    code: 50035,
    errors: {
      [field]: { _errors: [{ code: "BASE_TYPE_INVALID", message: detail }] },
    },
  });
}

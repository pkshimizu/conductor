import { describe, expect, it } from "vitest";
import {
  type BlockedIssue,
  type BlockedThreadDeps,
  blockedMessage,
  blockedThreadName,
  followBlockedThread,
  followBlockedThreads,
  noteBlocked,
} from "./blocked-thread.js";
import { MemoryChat } from "./chat.js";
import { parseConfig } from "./config.js";
import { MemoryStore } from "./store.js";

const REPO = "me/app";
const KEY = { repo: REPO, issue: 7 };
const ISSUE: BlockedIssue = { number: 7, title: "並べ替え" };

function setup() {
  const config = parseConfig(
    [
      `github: { repo: ${REPO}, project: 3, notify: me }`,
      "protected: [e2e/**]",
      "commands: { setup: s, test: t, acceptance: a, typecheck: y, build: b }",
      "chat:",
      "  type: discord",
      '  channels: { requirements: "100", questions: "200", notices: "300" }',
      '  allowed_users: ["u1", "u2"]',
    ].join("\n"),
  );
  const chatConfig = config.chat;
  if (chatConfig === undefined) throw new Error("chat が無い");
  const chat = new MemoryChat("bot");
  const store = new MemoryStore(() => new Date("2026-11-20T00:00:00.000Z"));
  const moves: [number, string][] = [];
  const comments: { issue: number; body: string; mention?: boolean }[] = [];
  const logs: string[] = [];
  const deps: BlockedThreadDeps = {
    config,
    chatConfig,
    chat,
    store,
    board: {
      moveIssue: (n, column) => {
        moves.push([n, column]);
        return Promise.resolve();
      },
      comment: (n, body, o) => {
        comments.push({ issue: n, body, ...o });
        return Promise.resolve();
      },
    },
    log: (t) => logs.push(t),
  };
  const record = async () => {
    const r = await store.getBlockedThread(KEY);
    if (r === undefined) throw new Error("記録が無い");
    return r;
  };
  return { deps, chat, store, moves, comments, logs, record };
}

describe("blockedMessage", () => {
  it("許可した人へのメンション・Issue へのリンク・理由を含み、長い理由は切り詰める", () => {
    const text = blockedMessage({
      repo: REPO,
      issue: ISSUE,
      reason: "x".repeat(5000),
      allowedUsers: ["u1", "u2"],
      ready: "Ready",
    });
    expect(text).toContain("<@u1> <@u2>");
    expect(text).toContain("https://github.com/me/app/issues/7");
    expect(text.length).toBeLessThan(2000);
  });

  it("スレッドの名前は 100 文字に収める", () => {
    const name = blockedThreadName({ number: 1, title: "あ".repeat(200) });
    expect(name.length).toBeLessThanOrEqual(100);
  });
});

describe("followBlockedThread", () => {
  it("スレッドが無ければ、質問チャンネルに作って記録する", async () => {
    const t = setup();
    await noteBlocked(t.store, KEY, "壊れた");
    const r = await followBlockedThread(t.deps, await t.record(), ISSUE);
    expect(r.status).toBe("asked");
    const threads = [...t.chat.threads.entries()];
    expect(threads).toHaveLength(1);
    const [id, thread] = threads[0]!;
    expect(thread.channelId).toBe("200");
    expect((await t.record()).threadId).toBe(id);
    expect(t.chat.messages.get("200")?.[0]?.text).toContain("壊れた");
  });

  it("許可していない人や Bot の書き込みは方針にしない", async () => {
    const t = setup();
    await noteBlocked(t.store, KEY, "壊れた");
    await followBlockedThread(t.deps, await t.record(), ISSUE);
    const { threadId } = await t.record();
    if (threadId === undefined) throw new Error("スレッドが無い");
    t.chat.addMessage(threadId, { authorId: "stranger", text: "こうして" });
    await t.chat.post(threadId, "Bot の書き込み");
    const r = await followBlockedThread(t.deps, await t.record(), ISSUE);
    expect(r.status).toBe("waiting");
    expect(t.comments).toEqual([]);
    expect(t.moves).toEqual([]);
  });

  it("許可した人の方針を書き写し、Ready に戻し、スレッドをアーカイブして記録を消す", async () => {
    const t = setup();
    await noteBlocked(t.store, KEY, "壊れた");
    await followBlockedThread(t.deps, await t.record(), ISSUE);
    const { threadId } = await t.record();
    if (threadId === undefined) throw new Error("スレッドが無い");
    t.chat.addMessage(threadId, { authorId: "u2", text: "右上に置く" });
    const r = await followBlockedThread(t.deps, await t.record(), ISSUE);
    expect(r.status).toBe("resumed");
    expect(t.comments).toHaveLength(1);
    expect(t.comments[0]?.body).toContain("> 右上に置く");
    expect(t.comments[0]?.mention).toBeUndefined();
    expect(t.moves).toEqual([[7, "Ready"]]);
    expect(t.chat.threads.get(threadId)?.archived).toBe(true);
    expect(await t.store.getBlockedThread(KEY)).toBeUndefined();
  });

  it("Blocked の列から出ていれば、スレッドをアーカイブして記録を消す", async () => {
    const t = setup();
    await noteBlocked(t.store, KEY, "壊れた");
    await followBlockedThread(t.deps, await t.record(), ISSUE);
    const { threadId } = await t.record();
    if (threadId === undefined) throw new Error("スレッドが無い");
    const r = await followBlockedThread(t.deps, await t.record(), undefined);
    expect(r.status).toBe("closed");
    expect(t.chat.threads.get(threadId)?.archived).toBe(true);
    expect(await t.store.getBlockedThread(KEY)).toBeUndefined();
    expect(t.moves).toEqual([]);
  });
});

describe("followBlockedThreads", () => {
  it("記録が無ければ列を読まない", async () => {
    const t = setup();
    let read = 0;
    await followBlockedThreads(t.deps, () => {
      read++;
      return Promise.resolve([]);
    });
    expect(read).toBe(0);
  });

  it("1件が失敗しても、他の Issue は確かめる", async () => {
    const t = setup();
    await noteBlocked(t.store, { repo: REPO, issue: 1 }, "a");
    await noteBlocked(t.store, KEY, "b");
    const post = t.chat.post.bind(t.chat);
    t.chat.post = (channelId, text) =>
      text.includes("#1 ")
        ? Promise.reject(new Error("Discord が落ちた"))
        : post(channelId, text);
    await followBlockedThreads(t.deps, () =>
      Promise.resolve([{ number: 1, title: "一" }, ISSUE]),
    );
    expect(t.logs.some((l) => l.includes("Discord が落ちた"))).toBe(true);
    expect((await t.record()).threadId).toBeDefined();
  });
});

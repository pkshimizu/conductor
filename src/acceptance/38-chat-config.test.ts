/**
 * Issue #38: 窓口の部品と設定（chat）の受け入れテスト
 *
 * 決めた名前（実装役はこれに合わせて作る）:
 * - config.yaml の chat
 *   ```yaml
 *   chat:
 *     type: discord            # 種類（今は discord のみ）
 *     channels:
 *       requirements: "..."    # 要件のチャンネル ID（文字列）
 *       questions: "..."       # 質問のチャンネル ID（文字列）
 *       notices: "..."         # お知らせのチャンネル ID（文字列）
 *     allowed_users: ["..."]   # 許可する人（ユーザー ID の文字列の並び）
 *   ```
 *   - 型は `src/config.ts` の `ChatConfig`（`Config["chat"]` は `ChatConfig | undefined`）
 *   - トークンは config.yaml に書かない（chat.token は誤り）。環境変数 CONDUCTOR_DISCORD_TOKEN で渡す
 * - 窓口の共通の型は `src/chat.ts` の `Chat`、メモリ上の偽の窓口は `MemoryChat`
 * - トークンの点検は `conductor start`（`main(["start", フォルダ])`）が `start()` を呼ぶ前に行う
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// conductor start の常駐（GitHub・claude・SQLite に触る）は偽物に差し替える
vi.mock("../start.js", () => ({
  start: vi.fn(async () => {}),
}));

import { type Chat, MemoryChat } from "../chat.js";
import {
  type ChatConfig,
  type Config,
  ConfigError,
  parseConfig,
} from "../config.js";
import { main, type Output } from "../main.js";
import { start } from "../start.js";

const startMock = vi.mocked(start);

// ---- seed（config.yaml の中身） ----

const BASE = [
  "github: { repo: a/b, project: 1, notify: someone }",
  "protected: [src/acceptance/**]",
  "commands: { setup: s, test: t, acceptance: a, typecheck: c, build: b }",
];

const CHAT = [
  "chat:",
  "  type: discord",
  "  channels:",
  '    requirements: "1000000000000000001"',
  '    questions: "1000000000000000002"',
  '    notices: "1000000000000000003"',
  "  allowed_users:",
  '    - "2000000000000000001"',
  '    - "2000000000000000002"',
];

const withChat = [...BASE, ...CHAT].join("\n");
const withoutChat = BASE.join("\n");

function capture(): Output & { outs: string[]; errs: string[] } {
  const outs: string[] = [];
  const errs: string[] = [];
  return { outs, errs, out: (t) => outs.push(t), err: (t) => errs.push(t) };
}

function issuesOf(source: string): { path: string; message: string }[] {
  try {
    parseConfig(source);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as ConfigError).issues;
  }
  throw new Error("ConfigError になりませんでした");
}

let dir: string;

async function seedRepo(source: string): Promise<string> {
  await mkdir(join(dir, ".conductor"), { recursive: true });
  await writeFile(join(dir, ".conductor", "config.yaml"), source);
  return dir;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "conductor-38-"));
  startMock.mockClear();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe("Issue #38: 窓口の部品と設定（chat）", () => {
  it("AC1: chat（discord・3つのチャンネル ID・許可する人）を書いた config.yaml を読むと型付きで得られる", () => {
    const config: Config = parseConfig(withChat);
    const chat: ChatConfig | undefined = config.chat;
    expect(chat).toEqual({
      type: "discord",
      channels: {
        requirements: "1000000000000000001",
        questions: "1000000000000000002",
        notices: "1000000000000000003",
      },
      allowed_users: ["2000000000000000001", "2000000000000000002"],
    });
  });

  it("AC2: chat のチャンネル ID や許可する人が欠けた・型が違う config.yaml は、どの項目がなぜ誤りかを示して起動を止める", async () => {
    // チャンネル ID が欠けている
    const missingChannel = [
      ...BASE,
      "chat:",
      "  type: discord",
      "  channels:",
      '    requirements: "1000000000000000001"',
      '    notices: "1000000000000000003"',
      '  allowed_users: ["2000000000000000001"]',
    ].join("\n");
    expect(issuesOf(missingChannel)).toContainEqual({
      path: "chat.channels.questions",
      message: "必須項目がありません",
    });

    // 許可する人が欠けている
    const missingUsers = [
      ...BASE,
      "chat:",
      "  type: discord",
      "  channels:",
      '    requirements: "1000000000000000001"',
      '    questions: "1000000000000000002"',
      '    notices: "1000000000000000003"',
    ].join("\n");
    expect(issuesOf(missingUsers)).toContainEqual({
      path: "chat.allowed_users",
      message: "必須項目がありません",
    });

    // チャンネル ID の型が違う（文字列でなく数）
    const wrongType = [
      ...BASE,
      "chat:",
      "  type: discord",
      "  channels:",
      "    requirements: 1000",
      '    questions: "1000000000000000002"',
      '    notices: "1000000000000000003"',
      '  allowed_users: ["2000000000000000001"]',
    ].join("\n");
    const wrong = issuesOf(wrongType).find(
      (i) => i.path === "chat.channels.requirements",
    );
    expect(wrong).toBeDefined();
    expect(wrong!.message).not.toBe("");

    // conductor start は誤りの項目を示して止まる（常駐は始めない）
    vi.stubEnv("CONDUCTOR_DISCORD_TOKEN", "dummy-token");
    const o = capture();
    expect(await main(["start", await seedRepo(missingChannel)], o)).toBe(1);
    expect(o.errs.join("\n")).toContain("chat.channels.questions");
    expect(o.errs.join("\n")).toContain("必須項目がありません");
    expect(startMock).not.toHaveBeenCalled();
  });

  it("AC3: chat を書いていない config.yaml で conductor start を実行すると、窓口を使わず Lv1 と同じに動く", async () => {
    // トークンが無くても止まらない（窓口を使わない）
    vi.stubEnv("CONDUCTOR_DISCORD_TOKEN", undefined);
    const o = capture();
    const repoDir = await seedRepo(withoutChat);
    expect(await main(["start", repoDir], o)).toBe(0);
    expect(o.errs).toEqual([]);
    expect(startMock).toHaveBeenCalledTimes(1);
    const [calledDir, config] = startMock.mock.calls[0]!;
    expect(calledDir).toBe(repoDir);
    expect(config.chat).toBeUndefined();
    expect(config.github.repo).toBe("a/b");
  });

  it("AC4: chat を書いた config.yaml で CONDUCTOR_DISCORD_TOKEN が無いと、トークンが無いことを示して起動を止める", async () => {
    vi.stubEnv("CONDUCTOR_DISCORD_TOKEN", undefined);
    const ng = capture();
    expect(await main(["start", await seedRepo(withChat)], ng)).toBe(1);
    expect(ng.errs.join("\n")).toContain("CONDUCTOR_DISCORD_TOKEN");
    expect(startMock).not.toHaveBeenCalled();

    // トークンがあれば起動する
    vi.stubEnv("CONDUCTOR_DISCORD_TOKEN", "dummy-token");
    const ok = capture();
    expect(await main(["start", dir], ok)).toBe(0);
    expect(startMock).toHaveBeenCalledTimes(1);

    // トークンは config.yaml に書かない（書いたら誤り）
    const withToken = [...BASE, ...CHAT, "  token: secret"].join("\n");
    expect(issuesOf(withToken).some((i) => i.path.startsWith("chat"))).toBe(
      true,
    );
  });

  it("AC5: メモリ上の偽の窓口で、投稿の読み出し・スレッドの作成・書き込み・リアクションの読み出し・アーカイブとロックを Discord なしで試せる", async () => {
    const memory = new MemoryChat();
    const chat: Chat = memory;

    // Given: 要件のチャンネルに人の投稿とリアクションがある
    const posted = memory.addMessage("requirements", {
      authorId: "2000000000000000001",
      text: "ログイン画面を作りたい",
    });
    memory.addReaction("requirements", posted.id, "👍", "2000000000000000001");

    // 投稿の読み出し
    const messages = await chat.readMessages("requirements");
    expect(messages).toEqual([
      expect.objectContaining({
        id: posted.id,
        authorId: "2000000000000000001",
        text: "ログイン画面を作りたい",
      }),
    ]);

    // スレッドの作成
    const threadId = await chat.createThread(
      "requirements",
      posted.id,
      "要件: ログイン画面",
    );
    expect(threadId).toEqual(expect.any(String));
    expect(memory.threads.get(threadId)).toEqual(
      expect.objectContaining({
        channelId: "requirements",
        messageId: posted.id,
        name: "要件: ログイン画面",
        archived: false,
        locked: false,
      }),
    );

    // 書き込み（スレッドに書いた文を読み出せる）
    const replyId = await chat.post(threadId, "質問: 対象の画面はどれですか");
    expect(replyId).toEqual(expect.any(String));
    expect(await chat.readMessages(threadId)).toEqual([
      expect.objectContaining({
        id: replyId,
        text: "質問: 対象の画面はどれですか",
      }),
    ]);

    // リアクションの読み出し
    expect(await chat.readReactions("requirements", posted.id)).toEqual([
      { emoji: "👍", userIds: ["2000000000000000001"] },
    ]);

    // アーカイブとロック
    await chat.archiveThread(threadId);
    await chat.lockThread(threadId);
    expect(memory.threads.get(threadId)).toEqual(
      expect.objectContaining({ archived: true, locked: true }),
    );
  });
});

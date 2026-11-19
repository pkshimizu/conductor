/**
 * 止まったときのスレッド（窓口があるときだけ）。
 * Issue を Blocked にしたら（どの経路でも blockIssue を通す）、Issue でのメンションに代えて、質問チャンネルのスレッドで人に対応を確かめる。
 * - Blocked にしたとき、止まった理由を記録する（noteBlocked）
 * - 次の確認で、質問チャンネルにスレッドを作り、止まった理由と Issue へのリンクを書いて、許可した人にメンションする
 * - 許可した人がスレッドに方針を書いたら、方針を Issue にコメントで書き写し、Ready に戻し、スレッドをアーカイブする
 * - 人が GitHub で直接 Issue を Blocked の列から出したら、スレッドをアーカイブする
 */
import type { Chat } from "./chat.js";
import type { ChatConfig, Config } from "./config.js";
import type {
  BlockedThreadInput,
  BlockedThreadRecord,
  IssueKey,
  Store,
} from "./store.js";

/** Blocked の列にある Issue（番号と題名） */
export interface BlockedIssue {
  number: number;
  title: string;
}

export interface BlockedThreadBoard {
  moveIssue(issue: number, column: string): Promise<void>;
  comment(
    issue: number,
    body: string,
    options?: { mention?: boolean },
  ): Promise<void>;
}

export interface BlockedThreadDeps {
  config: Config;
  chatConfig: ChatConfig;
  chat: Chat;
  store: Store;
  board: BlockedThreadBoard;
  log(text: string): void;
}

export type BlockedThreadStatus =
  /** スレッドを作った */
  | "asked"
  /** 人の書き込みを待っている */
  | "waiting"
  /** 方針を書き写して Ready に戻した */
  | "resumed"
  /** Blocked の列から出ていたのでスレッドを閉じた */
  | "closed";

/** スレッドに書く止まった理由の最大の文字数（Discord の書き込みは 2000 文字まで） */
const REASON_LIMIT = 1200;
/** スレッドの名前の最大の文字数（Discord は 100 文字まで） */
const THREAD_NAME_LIMIT = 90;

export function issueUrl(repo: string, issue: number): string {
  return `https://github.com/${repo}/issues/${issue}`;
}

/** 質問チャンネルに書く、止まったことの知らせ（スレッドのもとの投稿） */
export function blockedMessage(input: {
  repo: string;
  issue: BlockedIssue;
  reason: string;
  allowedUsers: readonly string[];
  ready: string;
}): string {
  const { repo, issue, allowedUsers, ready } = input;
  const reason = input.reason.trim();
  const cut = reason.length > REASON_LIMIT;
  const shown = cut ? `${reason.slice(0, REASON_LIMIT)}…` : reason;
  return [
    `${allowedUsers.map((u) => `<@${u}>`).join(" ")} Issue #${issue.number} が止まりました（Blocked）: ${issue.title}`,
    issueUrl(repo, issue.number),
    "",
    "止まった理由:",
    "```",
    shown.replaceAll("```", "'''"),
    "```",
    "",
    `このスレッドに方針を書いてください。Issue にコメントで書き写し、${ready} に戻します（GitHub で直接 ${ready} に戻してもかまいません）。`,
  ].join("\n");
}

/** スレッドの名前 */
export function blockedThreadName(issue: BlockedIssue): string {
  const name = `#${issue.number} ${issue.title}`;
  return name.length > THREAD_NAME_LIMIT
    ? `${name.slice(0, THREAD_NAME_LIMIT - 1)}…`
    : name;
}

/** 方針を Issue に書き写すコメント */
export function policyComment(policy: string, ready: string): string {
  return [
    `Discord のスレッドで方針をもらいました。${ready} に戻して続けます。`,
    "",
    ...policy.split("\n").map((l) => `> ${l}`),
  ].join("\n");
}

/** Blocked にしたことを記録する。次の確認でスレッドを作る */
export async function noteBlocked(
  store: Store,
  key: IssueKey,
  reason: string,
): Promise<void> {
  await store.setBlockedThread(key, { reason });
}

export interface BlockDeps {
  config: Config;
  store: Store;
  /** Blocked にするときに使う GitHub の操作 */
  board: BlockedThreadBoard;
}

/** 窓口があるときに、Blocked にしたことのコメントの最後に足す案内 */
export function threadNote(ready: string): string {
  return `窓口の質問チャンネルのスレッドで対応を確かめます。方針をスレッドに書くか、確認したら ${ready} 列に戻してください。`;
}

/** 止まったときに、Issue でのメンションに代えてスレッドで確かめるか（窓口を設定しているとき） */
export function usesBlockedThreads(config: Pick<Config, "chat">): boolean {
  return config.chat !== undefined;
}

/**
 * Issue を Blocked にする（Blocked にするどの経路もこれを使う）。
 * - 窓口があれば、メンションせずに止まった理由をコメントし、記録する（次の確認でスレッドを作る）
 * - 窓口が無ければ、Issue でメンションする（Lv1 と同じ）
 */
export async function blockIssue(
  deps: BlockDeps,
  issue: number,
  input: {
    /** Issue に書くコメント */
    body: string;
    /** スレッドに書く止まった理由 */
    reason: string;
  },
): Promise<void> {
  const { config, store, board } = deps;
  const { columns, repo } = config.github;
  await board.moveIssue(issue, columns.blocked);
  if (usesBlockedThreads(config)) {
    await noteBlocked(store, { repo, issue }, input.reason);
    await board.comment(
      issue,
      [input.body, "", threadNote(columns.ready)].join("\n"),
    );
  } else {
    await board.comment(issue, input.body, { mention: true });
  }
}

/**
 * 記録のある Issue のスレッドを1回分確かめる。
 * blocked は今 Blocked の列にある Issue（列から出ていれば undefined）
 */
export async function followBlockedThread(
  deps: BlockedThreadDeps,
  record: BlockedThreadRecord,
  blocked: BlockedIssue | undefined,
): Promise<{ status: BlockedThreadStatus }> {
  const { config, chatConfig, chat, store, board } = deps;
  const { columns } = config.github;
  const key: IssueKey = { repo: record.repo, issue: record.issue };
  const name = `#${record.issue}`;

  // 人が GitHub で Blocked の列から出した
  if (blocked === undefined) {
    if (record.threadId !== undefined) {
      await chat.archiveThread(record.threadId);
    }
    await store.deleteBlockedThread(key);
    deps.log(
      `${name}: Blocked の列から出ていたので、スレッドを閉じました（記録を消しました）`,
    );
    return { status: "closed" };
  }

  // まだスレッドが無い
  if (record.threadId === undefined) {
    const questions = chatConfig.channels.questions;
    // 前の確認でもとの投稿を書いていたら、書き直さずにスレッドを作るところから続ける（メンションを重ねない）
    let head = record.headId;
    if (head === undefined) {
      head = await chat.post(
        questions,
        blockedMessage({
          repo: record.repo,
          issue: blocked,
          reason: record.reason,
          allowedUsers: chatConfig.allowed_users,
          ready: columns.ready,
        }),
      );
      await store.setBlockedThread(key, {
        reason: record.reason,
        headId: head,
      });
    }
    const threadId = await chat.createThread(
      questions,
      head,
      blockedThreadName(blocked),
    );
    await store.setBlockedThread(key, {
      reason: record.reason,
      headId: head,
      threadId,
    });
    deps.log(`${name}: 質問チャンネルにスレッドを作りました`);
    return { status: "asked" };
  }

  const { threadId } = record;
  // 前の確認で方針を書き写したが、Ready に戻す途中で失敗していたら、書き写しは繰り返さない
  if (record.copied !== true) {
    // 許可した人の書き込みを読む
    const after = await store.getReadPosition(threadId);
    const messages = await chat.readMessages(threadId, after);
    const self = await chat.selfId();
    const policy = messages
      .filter(
        (m) =>
          m.authorId !== self && chatConfig.allowed_users.includes(m.authorId),
      )
      .map((m) => m.text.trim())
      .filter((t) => t !== "");
    const last = messages.at(-1);
    if (policy.length === 0) {
      if (last !== undefined) await store.setReadPosition(threadId, last.id);
      return { status: "waiting" };
    }

    await board.comment(
      record.issue,
      policyComment(policy.join("\n\n"), columns.ready),
    );
    // 書き写したことをすぐ記録する（この後で失敗しても、次の確認で同じ方針を二重に書かない）
    const copied: BlockedThreadInput = {
      reason: record.reason,
      threadId,
      copied: true,
    };
    if (record.headId !== undefined) copied.headId = record.headId;
    await store.setBlockedThread(key, copied);
    if (last !== undefined) await store.setReadPosition(threadId, last.id);
  }

  await board.moveIssue(record.issue, columns.ready);
  await chat.post(
    threadId,
    `方針を Issue #${record.issue} に書き写し、${columns.ready} に戻しました。このスレッドは閉じます。`,
  );
  await chat.archiveThread(threadId);
  // 記録はアーカイブの後で消す（途中で失敗しても、次の確認でやり直せるように）
  await store.deleteBlockedThread(key);
  deps.log(`${name}: スレッドの方針を書き写し、${columns.ready} に戻しました`);
  return { status: "resumed" };
}

/** 記録のある Issue のスレッドを、すべて1回分ずつ確かめる。1件の失敗で他を止めない */
export async function followBlockedThreads(
  deps: BlockedThreadDeps,
  blockedIssues: () => Promise<BlockedIssue[]>,
): Promise<void> {
  const records = await deps.store.listBlockedThreads(deps.config.github.repo);
  if (records.length === 0) return;
  const blocked = new Map((await blockedIssues()).map((i) => [i.number, i]));
  for (const r of records) {
    try {
      await followBlockedThread(deps, r, blocked.get(r.issue));
    } catch (e) {
      deps.log(
        `#${r.issue}: 止まったときのスレッドの確認に失敗しました（次の確認でやり直します）: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

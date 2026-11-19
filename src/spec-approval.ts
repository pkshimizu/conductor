/**
 * 仕様の承認。判定は LLM に任せず、プログラムで行う。
 * - 承認は「最新の要約」（仕様化役が最後に書いた要約の書き込み）に付いた ✅ のリアクション
 * - ✅ を付けた人が config.chat.allowed_users にいるときだけ承認として扱う
 * - 古い要約への ✅、✅ 以外の絵文字は承認として扱わない
 * - 承認されたら仕様の PR の CI を確かめ、合格ならマージし、スレッドをアーカイブしてロックし、要件を分解に進める（working）
 * - CI が失敗していればマージせず、理由をスレッドに書いて待つ（同じ要約に対しては1回だけ書く）。
 *   承認は取り消さないので、CI が合格すれば次の確認でマージする
 */
import type { Chat, ChatMessage, ChatReaction } from "./chat.js";
import type { Config } from "./config.js";
import type { CiResult } from "./github.js";
import { APPROVAL_MARK, isSummaryMessage } from "./specifier.js";
import {
  compareMessageIds,
  type RequirementRecord,
  type Store,
} from "./store.js";

export interface SpecApprovalBoard {
  /** 仕様の PR の CI の結果（github.ts の GitHub.ciStatus と同じ形） */
  ciStatus(pr: number): Promise<CiResult>;
  /** 仕様の PR をマージする（Issue に紐づかないので列は動かさない） */
  mergePullRequest(pr: number): Promise<void>;
}

export interface SpecApprovalDeps {
  /** config.chat がある前提（allowed_users が許可した人） */
  config: Config;
  chat: Chat;
  store: Store;
  board: SpecApprovalBoard;
  log(text: string): void;
}

export type SpecApprovalStatus =
  | "skipped"
  /** 承認がまだ無い */
  | "waiting"
  /** 承認されたが CI がまだ終わっていない */
  | "ci_pending"
  /** 承認されたが CI が失敗している */
  | "ci_failed"
  /** マージして分解に進めた */
  | "approved";

/** CI の失敗を伝える書き込みの1行目 */
export function ciFailedHead(pr: number): string {
  return `仕様の PR #${pr} の CI が失敗しているため、まだマージしません。`;
}

/** 失敗のログとして書き込みに含める最大の文字数（Discord の書き込みは 2000 文字まで） */
const FAILURE_LOG_LIMIT = 800;

/** CI が失敗しているときの書き込み */
export function ciFailedMessage(pr: number, ci: CiResult): string {
  const failed = ci.checks.filter(
    (c) => c.bucket === "fail" || c.bucket === "cancel",
  );
  const lines = [ciFailedHead(pr)];
  if (failed.length > 0) {
    lines.push(
      "",
      "通っていないチェック:",
      ...failed.map((c) => `- ${c.name}${c.link ? `（${c.link}）` : ""}`),
    );
  }
  const log = ci.failureLog?.trim();
  if (log) {
    const tail =
      log.length > FAILURE_LOG_LIMIT
        ? `…${log.slice(log.length - FAILURE_LOG_LIMIT)}`
        : log;
    lines.push("", "```", tail.replaceAll("```", "'''"), "```");
  }
  lines.push(
    "",
    "CI が通ったら、次の確認でマージします（✅ を付け直す必要はありません）。",
  );
  return lines.join("\n");
}

/** マージしたときの書き込み */
export function approvedMessage(pr: number): string {
  return `仕様が承認されたので、仕様の PR #${pr} をマージしました。作業の分解に進みます。このスレッドはアーカイブしてロックします。`;
}

/** 許可した人の ✅ があるか。絵文字は ✅ と完全に一致するものだけを見る */
export function isApproved(
  reactions: readonly ChatReaction[],
  allowed: ReadonlySet<string>,
): boolean {
  return reactions.some(
    (r) => r.emoji === APPROVAL_MARK && r.userIds.some((id) => allowed.has(id)),
  );
}

/** Bot が書いた要約のうち最新のもの */
export function latestSummary(
  thread: readonly ChatMessage[],
  botId: string,
): ChatMessage | undefined {
  return thread.findLast(
    (m) => m.authorId === botId && isSummaryMessage(m.text),
  );
}

/** 承認待ちの要件1件を1回分確かめる（承認が無ければ何もしない） */
export async function checkSpecApproval(
  deps: SpecApprovalDeps,
  requirement: RequirementRecord,
): Promise<{ status: SpecApprovalStatus }> {
  const { config, chat, store, board } = deps;
  const chatConfig = config.chat;
  const { threadId, specPr } = requirement;
  if (
    chatConfig === undefined ||
    threadId === undefined ||
    specPr === undefined ||
    requirement.state !== "awaiting_approval"
  ) {
    return { status: "skipped" };
  }
  const allowed = new Set(chatConfig.allowed_users);
  const name = `要件 ${requirement.messageId}`;

  const botId = await chat.selfId();
  const thread = await chat.readMessages(threadId);
  const summary = latestSummary(thread, botId);
  if (summary === undefined) return { status: "waiting" };
  const reactions = await chat.readReactions(threadId, summary.id);
  if (!isApproved(reactions, allowed)) return { status: "waiting" };

  const ci = await board.ciStatus(specPr);
  if (ci.state === "pending") {
    deps.log(`${name}: 承認済み。仕様の PR #${specPr} の CI を待っています`);
    return { status: "ci_pending" };
  }
  if (ci.state === "failure") {
    // 同じ要約に対しては1回だけ書く（確認のたびに書かない）
    const head = ciFailedHead(specPr);
    const told = thread.some(
      (m) =>
        m.authorId === botId &&
        compareMessageIds(m.id, summary.id) > 0 &&
        m.text.startsWith(head),
    );
    if (!told) await chat.post(threadId, ciFailedMessage(specPr, ci));
    deps.log(`${name}: 仕様の PR #${specPr} の CI が失敗しているので待ちます`);
    return { status: "ci_failed" };
  }

  await board.mergePullRequest(specPr);
  await store.updateRequirement(requirement.messageId, { state: "working" });
  deps.log(`${name}: 仕様の PR #${specPr} をマージしました`);
  await chat.post(threadId, approvedMessage(specPr));
  await chat.archiveThread(threadId);
  await chat.lockThread(threadId);
  return { status: "approved" };
}

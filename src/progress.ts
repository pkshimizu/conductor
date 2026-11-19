/**
 * 着手と完了の知らせ。分解した要件の作業用 Issue を、確認のたびに1回分確かめる。
 * - 先に済ませる Issue（本文の「先に済ませる Issue」の節の #番号）がすべてマージされた Issue を Ready に移す
 * - 移すのは列が未設定（Project に追加しただけ）の Issue だけ。Ready・作業中・Done・Blocked の Issue は動かさない
 * - 要件の作業用 Issue がすべてマージされたら、お知らせチャンネルに要件の完了（要約とマージした PR の一覧）を書き、
 *   要件を完了（done）にする
 * Issue を1件ずつ進める常駐ループ（loop.ts）とは別に、要件ごとに呼ばれる。
 */
import type { Chat } from "./chat.js";
import type { Config } from "./config.js";
import { SECTION } from "./decomposer.js";
import { parseSections } from "./intake.js";
import { requirementText } from "./requirement-text.js";
import type { RequirementRecord, Store } from "./store.js";

/** 作業用 Issue 1件の今の様子 */
export interface WorkIssueStatus {
  /** Project の状態欄。Project に追加しただけで未設定なら undefined */
  column?: string;
  /** Issue の本文 */
  body: string;
  /** この Issue の、マージ済みの PR。無ければ undefined */
  merged?: { number: number; url: string };
}

export interface ProgressBoard {
  workIssueStatus(issue: number): Promise<WorkIssueStatus>;
  moveIssue(issue: number, column: string): Promise<void>;
}

export interface ProgressDeps {
  /** config.chat がある前提 */
  config: Config;
  chat: Chat;
  store: Store;
  board: ProgressBoard;
  log(text: string): void;
}

export type ProgressStatus =
  | "skipped"
  /** 動かす Issue が無かった */
  | "waiting"
  /** Issue を Ready に移した */
  | "started"
  /** すべてマージされたので要件を完了にした */
  | "done";

/**
 * 本文の「先に済ませる Issue」の節（`##` でも Issue フォームの `###` でもよい）に
 * #番号 で書いた Issue（重なりは除く）
 */
export function prerequisitesOf(body: string): number[] {
  const section = parseSections(body).get(SECTION.prerequisites) ?? "";
  const numbers: number[] = [];
  for (const m of section.matchAll(/#(\d+)/g)) {
    const n = Number(m[1]);
    if (!numbers.includes(n)) numbers.push(n);
  }
  return numbers;
}

/** 要件の完了の書き込み */
export function completedMessage(
  title: string,
  prs: readonly { issue: number; number: number; url: string }[],
): string {
  return [
    `要件が完了しました: ${title}`,
    "",
    "マージした PR:",
    ...prs.map((p) => `- #${p.number}（Issue #${p.issue}） ${p.url}`),
  ].join("\n");
}

/** 要件の要約（要件の本文の最初の行）。見つからなければ要件の投稿 ID で示す */
async function requirementTitle(
  chat: Chat,
  requirement: RequirementRecord,
): Promise<string> {
  const fallback = `要件 ${requirement.messageId}`;
  if (requirement.threadId === undefined) return fallback;
  const text = await requirementText(chat, requirement.threadId);
  if (text === undefined) return fallback;
  const first = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  return first ?? fallback;
}

/** 分解済みの要件1件の作業用 Issue を1回分確かめる */
export async function checkProgress(
  deps: ProgressDeps,
  requirement: RequirementRecord,
): Promise<{ status: ProgressStatus }> {
  const { config, chat, store, board } = deps;
  const chatConfig = config.chat;
  if (
    chatConfig === undefined ||
    requirement.state !== "working" ||
    requirement.workIssues.length === 0
  ) {
    return { status: "skipped" };
  }
  const name = `要件 ${requirement.messageId}`;

  // 同じ確認の中では、Issue ごとに1回だけ読む
  const statuses = new Map<number, WorkIssueStatus>();
  const statusOf = async (n: number): Promise<WorkIssueStatus> => {
    const cached = statuses.get(n);
    if (cached) return cached;
    const s = await board.workIssueStatus(n);
    statuses.set(n, s);
    return s;
  };

  const work: { number: number; status: WorkIssueStatus }[] = [];
  for (const n of requirement.workIssues) {
    work.push({ number: n, status: await statusOf(n) });
  }

  // すべてマージされたら完了を知らせる
  const merged = work.flatMap((w) =>
    w.status.merged === undefined
      ? []
      : [{ issue: w.number, ...w.status.merged }],
  );
  if (merged.length === work.length) {
    const title = await requirementTitle(chat, requirement);
    await chat.post(
      chatConfig.channels.notices,
      completedMessage(title, merged),
    );
    await store.updateRequirement(requirement.messageId, { state: "done" });
    deps.log(`${name}: 作業用 Issue がすべてマージされたので完了にしました`);
    return { status: "done" };
  }

  // 先に済ませる Issue がすべてマージされた、列が未設定の Issue を Ready に移す
  const { ready } = config.github.columns;
  let moved = 0;
  for (const w of work) {
    if (w.status.merged !== undefined || w.status.column !== undefined) {
      continue;
    }
    let satisfied = true;
    for (const p of prerequisitesOf(w.status.body)) {
      if (p === w.number) continue;
      if ((await statusOf(p)).merged === undefined) {
        satisfied = false;
        break;
      }
    }
    if (!satisfied) continue;
    await board.moveIssue(w.number, ready);
    moved++;
    deps.log(`${name}: #${w.number} を ${ready} に移しました`);
  }
  return { status: moved > 0 ? "started" : "waiting" };
}

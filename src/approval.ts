/**
 * マージの承認（.conductor/config.yaml の merge.approval）。
 * - auto: レビュー役が承認したらすぐマージする
 * - human（既定）: Reviewing 列のまま承認待ちにし、人が PR にコメントで答えるのを待つ
 *   - /conductor approve: CI の合格とレビュー後に新しいコミットが無いことを確かめてマージする
 *   - /conductor reject: 承認待ちになった後の人のコメントを指摘として実装役に差し戻す（上限に数えない）
 *   書き込み権限の無い人のコメントは無視する。未知のコマンドには使い方を返す。
 */
import type { Config } from "./config.js";
import type { CiResult } from "./github.js";
import { REJECT, type Board } from "./rejection.js";
import type { ApprovalWait, IssueKey, Store } from "./store.js";

/** PR へのコメント（会話・行へのコメント・レビュー本文） */
export interface PrComment {
  author: string;
  body: string;
  /** 書いた時刻（ISO 8601） */
  createdAt: string;
  /** 行へのコメントなら、そのファイルと行 */
  path?: string;
  line?: number | null;
}

export interface ApprovalBoard extends Board {
  ciStatus(pr: number): Promise<CiResult>;
  merge(pr: number, issue: number, doneColumn: string): Promise<void>;
  /** PR の先頭コミット */
  headSha(pr: number): Promise<string>;
  prComments(pr: number): Promise<PrComment[]>;
  /** リポジトリに書き込み権限があるか */
  canWrite(user: string): Promise<boolean>;
}

export interface ApprovalDeps {
  config: Config;
  board: ApprovalBoard;
  store: Store;
  now?: () => Date;
}

/** 指揮役が書いたコメントの目印。承認待ちのコメントを指摘に混ぜないために使う */
export const CONDUCTOR_MARK = "<!-- conductor -->";

export const APPROVE_COMMAND = "/conductor approve";
export const REJECT_COMMAND = "/conductor reject";

export type ApprovalResult =
  | { status: "merged"; pr: number }
  | { status: "awaiting-approval"; pr: number }
  | { status: "rejected"; findings: string[] }
  /** レビュー後に新しいコミットがあったので、CI からやり直す */
  | { status: "recheck" }
  | { status: "waiting" };

export function approvalRequestComment(pr: number): string {
  return [
    `PR #${pr} はレビュー役が承認しました。マージしてよいか確認してください。`,
    "",
    `- マージする: PR に \`${APPROVE_COMMAND}\` とコメント`,
    `- 差し戻す: 直してほしい点を PR にコメント（行へのコメントも可）してから \`${REJECT_COMMAND}\` とコメント`,
    "",
    CONDUCTOR_MARK,
  ].join("\n");
}

export function usageComment(command: string): string {
  return [
    `\`${command}\` は分かりません。使えるコマンド:`,
    "",
    `- \`${APPROVE_COMMAND}\`: マージする`,
    `- \`${REJECT_COMMAND}\`: それまでのコメントを指摘として差し戻す`,
    "",
    CONDUCTOR_MARK,
  ].join("\n");
}

/** コメントの先頭行が /conductor で始まれば、そのコマンドを返す */
export function parseCommand(body: string): string | undefined {
  const first = body.trim().split("\n")[0]!.trim();
  if (!/^\/conductor(\s|$)/.test(first)) return undefined;
  return first.split(/\s+/).slice(0, 2).join(" ");
}

function formatComment(c: PrComment): string {
  const where = c.path
    ? `${c.path}${c.line === null || c.line === undefined ? "" : `:${c.line}`}: `
    : "";
  return `${where}${c.body.trim().replace(/\n/g, "\n  ")}（@${c.author}）`;
}

/** 承認された PR をマージし、Issue を完了列に移す */
export async function mergeApproved(
  deps: Pick<ApprovalDeps, "config" | "board" | "store">,
  issue: number,
): Promise<{ status: "merged"; pr: number } | { status: "waiting" }> {
  const { config, board, store } = deps;
  const key: IssueKey = { repo: config.github.repo, issue };
  const record = await store.get(key);
  if (record?.pr === undefined) return { status: "waiting" };
  await store.update(key, { checkpoint: { stage: "merging" } });
  await board.merge(record.pr, issue, config.github.columns.done);
  await store.update(key, { checkpoint: undefined });
  return { status: "merged", pr: record.pr };
}

/** レビュー役が承認した後の処理。設定に応じて、すぐマージするか承認待ちにする */
export async function afterApprove(
  deps: ApprovalDeps,
  issue: number,
): Promise<ApprovalResult> {
  const { config, board, store } = deps;
  if (config.merge.approval === "auto") return mergeApproved(deps, issue);
  const key: IssueKey = { repo: config.github.repo, issue };
  const record = await store.get(key);
  if (record?.pr === undefined) return { status: "waiting" };
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const sha = await board.headSha(record.pr);
  await store.update(key, {
    checkpoint: {
      stage: "approving",
      approval: { since: now, checked: now, sha },
    },
  });
  await board.comment(record.pr, approvalRequestComment(record.pr), {
    mention: true,
  });
  return { status: "awaiting-approval", pr: record.pr };
}

/** 承認待ちの PR のコメントを1回確かめる。答えが無ければ awaiting-approval を返す */
export async function checkApproval(
  deps: ApprovalDeps,
  issue: number,
): Promise<ApprovalResult> {
  const { config, board, store } = deps;
  const key: IssueKey = { repo: config.github.repo, issue };
  const record = await store.get(key);
  const wait = record?.checkpoint?.approval;
  if (
    record?.pr === undefined ||
    record.checkpoint?.stage !== "approving" ||
    !wait
  ) {
    return { status: "waiting" };
  }
  const pr = record.pr;
  const all = (await board.prComments(pr))
    .filter((c) => !c.body.includes(CONDUCTOR_MARK))
    .filter((c) => Date.parse(c.createdAt) > Date.parse(wait.since))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

  const writers = new Map<string, boolean>();
  const canWrite = async (user: string) => {
    if (!writers.has(user)) writers.set(user, await board.canWrite(user));
    return writers.get(user)!;
  };

  let checked = wait.checked;
  const save = (next: Partial<ApprovalWait>) =>
    store.update(key, {
      checkpoint: { stage: "approving", approval: { ...wait, ...next } },
    });

  for (const c of all) {
    if (Date.parse(c.createdAt) <= Date.parse(checked)) continue;
    checked = c.createdAt;
    const command = c.path ? undefined : parseCommand(c.body);
    if (command === undefined) continue;
    if (!(await canWrite(c.author))) continue;

    if (command === APPROVE_COMMAND) {
      await save({ checked });
      return approve(deps, issue, pr, wait);
    }
    if (command === REJECT_COMMAND) {
      const notes: PrComment[] = [];
      for (const n of all) {
        if (Date.parse(n.createdAt) > Date.parse(c.createdAt)) break;
        const cmd = n.path ? undefined : parseCommand(n.body);
        const body = cmd
          ? n.body.trim().split("\n").slice(1).join("\n")
          : n.body;
        if (body.trim() === "") continue;
        if (!(await canWrite(n.author))) continue;
        notes.push({ ...n, body });
      }
      return rejectByHuman(deps, issue, notes.map(formatComment));
    }
    await save({ checked });
    await board.comment(pr, usageComment(command));
  }
  if (checked !== wait.checked) await save({ checked });
  return { status: "awaiting-approval", pr };
}

async function approve(
  deps: ApprovalDeps,
  issue: number,
  pr: number,
  wait: ApprovalWait,
): Promise<ApprovalResult> {
  const { config, board, store } = deps;
  const key: IssueKey = { repo: config.github.repo, issue };
  const sha = await board.headSha(pr);
  if (sha !== wait.sha) {
    await store.update(key, {
      checkpoint: { stage: "ci", reason: "new-commits" },
    });
    await board.comment(
      pr,
      `レビューの後に新しいコミットがあるため、まだマージしません。CI とレビューをやり直してから、もう一度承認をお願いします。\n\n${CONDUCTOR_MARK}`,
    );
    return { status: "recheck" };
  }
  const ci = await board.ciStatus(pr);
  if (ci.state !== "success") {
    await board.comment(
      pr,
      `CI が${ci.state === "pending" ? "まだ終わっていない" : "失敗している"}ため、マージしません。CI が通ってから、もう一度 \`${APPROVE_COMMAND}\` とコメントしてください。\n\n${CONDUCTOR_MARK}`,
    );
    return { status: "awaiting-approval", pr };
  }
  return mergeApproved(deps, issue);
}

/** 人の差し戻し。指摘を記録して実装役に戻す。差し戻しの上限には数えない */
async function rejectByHuman(
  deps: ApprovalDeps,
  issue: number,
  findings: string[],
): Promise<ApprovalResult> {
  const { config, board, store } = deps;
  const key: IssueKey = { repo: config.github.repo, issue };
  const list =
    findings.length > 0
      ? findings
      : ["人が差し戻しました（具体的な指摘はありません）。"];
  await store.update(key, {
    checkpoint: { stage: "implementing", reason: "rejected-by-human" },
  });
  await store.addSummary(key, {
    role: "human",
    verdict: REJECT,
    text: list.join("\n\n"),
  });
  await board.moveIssue(issue, config.github.columns.implementing);
  await board.comment(
    issue,
    [
      "人の差し戻しを受け付けました（上限の回数には数えません）。実装役に次の指摘を渡します。",
      "",
      ...list.map((f) => `- ${f.replace(/\n/g, "\n  ")}`),
      "",
      CONDUCTOR_MARK,
    ].join("\n"),
  );
  return { status: "rejected", findings: list };
}

/**
 * 差し戻し。CI の失敗・レビューの指摘・ハッシュの不一致・ローカル確認の失敗を合算して数える。
 * 上限を超えたら Blocked に移し、メンションして人の対応を待つ。
 * 指摘は要約として記録し、次の実装役に渡す（再起動しても失われない）。
 */
import type { Config } from "./config.js";
import type { IssueKey, Store } from "./store.js";

export interface Board {
  moveIssue(issue: number, column: string): Promise<void>;
  comment(
    issue: number,
    body: string,
    options?: { mention?: boolean },
  ): Promise<void>;
}

export interface RejectDeps {
  config: Config;
  store: Store;
  board: Board;
}

export interface RejectResult {
  rejections: number;
  /** 上限を超えて Blocked にしたか */
  blocked: boolean;
}

/** 差し戻しの記録に使う判定の名前 */
export const REJECT = "reject";

export function rejectionComment(
  source: string,
  findings: readonly string[],
  rejections: number,
  limit: number,
): string {
  return [
    `${source}で差し戻しました（${rejections}/${limit} 回目）。実装役に次の指摘を渡します。`,
    "",
    ...findings.map((f) => `- ${f.replace(/\n/g, "\n  ")}`),
  ].join("\n");
}

export function rejectionLimitComment(
  findings: readonly string[],
  limit: number,
  ready: string,
): string {
  return [
    `差し戻しが上限（${limit} 回）を超えたため、Blocked に移しました。最後の指摘:`,
    "",
    ...findings.map((f) => `- ${f.replace(/\n/g, "\n  ")}`),
    "",
    `確認したら ${ready} 列に戻してください。`,
  ].join("\n");
}

/** 差し戻しを1回数え、指摘を記録してコメントする */
export async function recordRejection(
  deps: RejectDeps,
  issue: number,
  /** 差し戻した役（記録用。例: "implementer"、"ci"、"reviewer"） */
  role: string,
  /** コメントに出す名前（例: "CI"） */
  source: string,
  findings: readonly string[],
): Promise<RejectResult> {
  const { config, store, board } = deps;
  const key: IssueKey = { repo: config.github.repo, issue };
  const limit = config.limits.rejections;
  const rejections = ((await store.get(key))?.rejections ?? 0) + 1;
  const blocked = rejections > limit;
  await store.update(key, {
    rejections,
    checkpoint: {
      stage: "implementing",
      reason: blocked ? "rejection-limit" : `rejected-by-${role}`,
    },
  });
  await store.addSummary(key, {
    role,
    verdict: REJECT,
    text: findings.join("\n\n"),
  });
  if (blocked) {
    await board.moveIssue(issue, config.github.columns.blocked);
    await board.comment(
      issue,
      rejectionLimitComment(findings, limit, config.github.columns.ready),
      { mention: true },
    );
  } else {
    await board.moveIssue(issue, config.github.columns.implementing);
    await board.comment(
      issue,
      rejectionComment(source, findings, rejections, limit),
    );
  }
  return { rejections, blocked };
}

/** 次の実装役に渡す指摘。最後の記録が差し戻しなら、その指摘を返す */
export async function pendingFindings(
  store: Store,
  key: IssueKey,
): Promise<string[]> {
  const last = (await store.summaries(key)).at(-1);
  if (!last || last.verdict !== REJECT) return [];
  return last.text.split("\n\n").filter((s) => s.trim() !== "");
}

/** 次のテスト役に渡す指摘。最後の記録が実装役の異議なら、その中身を返す */
export async function pendingObjection(
  store: Store,
  key: IssueKey,
): Promise<string[]> {
  const last = (await store.summaries(key)).at(-1);
  if (!last || last.role !== "implementer" || last.verdict !== "objection") {
    return [];
  }
  return last.text
    .split("\n\n")
    .filter((s) => s.trim() !== "")
    .map((s) => `実装役の指摘: ${s}`);
}

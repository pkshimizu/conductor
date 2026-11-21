/**
 * 管理画面のダッシュボードに出す内容を集める。
 * 列と件数は GitHub Projects（board）を正とし、回数・段階・段階を始めた時刻・止まった理由と日時は
 * 記録（store）から読む。動いている役と確認した時刻は常駐ループの状態（activity）から読む
 */
import type { AdminStatus } from "./admin-server.js";
import type { Config } from "./config.js";
import type {
  DashboardActive,
  DashboardBlocked,
  DashboardData,
} from "./dashboard-data.js";
import { type LoopActivity, type LoopIssue, stageOf } from "./loop.js";
import type { IssueRecord, Store } from "./store.js";

export type {
  DashboardActive,
  DashboardBlocked,
  DashboardData,
} from "./dashboard-data.js";

export interface DashboardBoard {
  issuesByColumn(): Promise<Map<string, LoopIssue[]>>;
}

export interface DashboardDeps {
  config: Config;
  store: Store;
  board: DashboardBoard;
  /** 稼働状態（動作中・待機中・停止中） */
  status: AdminStatus;
  /** 常駐ループの状態 */
  activity: LoopActivity;
}

const byNumber = (a: LoopIssue, b: LoopIssue) => a.number - b.number;

/**
 * 処理中の Issue。常駐ループと同じく、Testing・Implementing・Reviewing の列にある
 * 承認待ちでない Issue のうち番号のいちばん小さいもの
 */
async function activeIssue(
  deps: DashboardDeps,
  byColumn: Map<string, LoopIssue[]>,
): Promise<DashboardActive | undefined> {
  const { config, store, activity } = deps;
  const { columns, repo } = config.github;
  const working = [columns.testing, columns.implementing, columns.reviewing]
    .flatMap((column) =>
      (byColumn.get(column) ?? []).map((issue) => ({ issue, column })),
    )
    .sort((a, b) => byNumber(a.issue, b.issue));
  for (const { issue, column } of working) {
    const record = await store.get({ repo, issue: issue.number });
    if (record?.checkpoint?.stage === "approving") continue;
    return activeOf(issue, column, record, deps, activity);
  }
  return undefined;
}

function activeOf(
  issue: LoopIssue,
  column: string,
  record: IssueRecord | undefined,
  deps: DashboardDeps,
  activity: LoopActivity,
): DashboardActive {
  const active: DashboardActive = {
    number: issue.number,
    title: issue.title,
    stage: stageOf(record, column, deps.config.github.columns),
    rejections: record?.rejections ?? 0,
    objections: record?.objections ?? 0,
  };
  if (record?.branch !== undefined) active.branch = record.branch;
  if (record?.pr !== undefined) active.pr = record.pr;
  if (record?.stageStartedAt !== undefined) {
    active.stageStartedAt = record.stageStartedAt;
  }
  if (activity.running?.issue === issue.number) {
    active.role = activity.running.role;
  }
  return active;
}

/** Blocked の列にある Issue（番号の順）。止まった理由・日時・段階は記録から読む */
async function blockedIssues(
  deps: DashboardDeps,
  byColumn: Map<string, LoopIssue[]>,
): Promise<DashboardBlocked[]> {
  const { config, store } = deps;
  const { columns, repo } = config.github;
  const list = [...(byColumn.get(columns.blocked) ?? [])].sort(byNumber);
  const result: DashboardBlocked[] = [];
  for (const issue of list) {
    const key = { repo, issue: issue.number };
    const record = await store.get(key);
    const b: DashboardBlocked = { number: issue.number, title: issue.title };
    // 前の版で止めた Issue には理由の記録が無いので、スレッドの記録を見る
    const reason =
      record?.blockedReason ?? (await store.getBlockedThread(key))?.reason;
    if (reason !== undefined) b.reason = reason;
    if (record?.blockedAt !== undefined) b.blockedAt = record.blockedAt;
    if (record?.checkpoint !== undefined) b.stage = record.checkpoint.stage;
    result.push(b);
  }
  return result;
}

export async function loadDashboard(
  deps: DashboardDeps,
): Promise<DashboardData> {
  const { config, status, activity } = deps;
  const { columns, repo } = config.github;
  const byColumn = await deps.board.issuesByColumn();
  const order = [
    columns.ready,
    columns.testing,
    columns.implementing,
    columns.reviewing,
    columns.done,
    columns.blocked,
  ];
  const data: DashboardData = {
    status,
    repo,
    pollInterval: config.poll_interval,
    merge: config.merge.approval,
    limits: {
      rejections: config.limits.rejections,
      objections: config.limits.objections,
    },
    blocked: await blockedIssues(deps, byColumn),
    counts: order.map((column) => ({
      column,
      count: byColumn.get(column)?.length ?? 0,
    })),
  };
  if (activity.lastCheckedAt !== undefined) {
    data.lastCheckedAt = activity.lastCheckedAt;
  }
  if (activity.nextCheckAt !== undefined) {
    data.nextCheckAt = activity.nextCheckAt;
  }
  const active = await activeIssue(deps, byColumn);
  if (active !== undefined) data.active = active;
  return data;
}

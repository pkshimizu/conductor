/**
 * 管理画面のタスク詳細に出す内容を集める。
 * タイトルと列は GitHub Projects（board）を正とし、ブランチ・PR・回数・段階・止まった理由と日時は記録（store）から、
 * 経過は記録の summaries から読む。役が作業中かは常駐ループの状態（activity）から決める
 */
import type { Config } from "./config.js";
import { type LoopActivity, stageOf } from "./loop.js";
import type { Store, Summary } from "./store.js";
import type {
  TaskDetailData,
  TimelineEntry,
  TimelineResult,
} from "./task-detail-data.js";
import type { TaskIssue, TasksBoard } from "./tasks.js";

export type {
  TaskDetailData,
  TimelineEntry,
  TimelineResult,
} from "./task-detail-data.js";

export interface TaskDetailDeps {
  config: Config;
  store: Store;
  board: TasksBoard;
  /** 常駐ループの状態（今動いている役と Issue） */
  activity: LoopActivity;
}

const RESULTS: ReadonlyMap<string, TimelineResult> = new Map<
  string,
  TimelineResult
>([
  ["approve", "approved"],
  ["reject", "changes"],
  ["objection", "objection"],
  ["done", "done"],
  ["failed", "failed"],
  ["passed", "passed"],
]);

/** 記録の verdict を、役の結果にする。知らない verdict なら undefined */
export function resultOf(verdict: string): TimelineResult | undefined {
  return RESULTS.get(verdict);
}

function entryOf(summary: Summary): TimelineEntry {
  const entry: TimelineEntry = {
    role: summary.role,
    verdict: summary.verdict,
    text: summary.text,
    at: summary.at,
  };
  const result = resultOf(summary.verdict);
  if (result !== undefined) entry.result = result;
  return entry;
}

/** board の中から Issue と列を探す */
function findIssue(
  byColumn: Map<string, TaskIssue[]>,
  issue: number,
): { issue: TaskIssue; column: string } | undefined {
  for (const [column, list] of byColumn) {
    const found = list.find((i) => i.number === issue);
    if (found !== undefined) return { issue: found, column };
  }
  return undefined;
}

export async function loadTaskDetail(
  deps: TaskDetailDeps,
  issue: number,
): Promise<TaskDetailData> {
  const { config, store, board, activity } = deps;
  const { columns, repo } = config.github;
  const key = { repo, issue };
  const found = findIssue(await board.issuesByColumn(), issue);
  const column = found?.column ?? "";
  const record = await store.get(key);

  const data: TaskDetailData = {
    number: issue,
    title: found?.issue.title ?? "",
    column,
    repo,
    columns: [
      columns.ready,
      columns.testing,
      columns.implementing,
      columns.reviewing,
      columns.done,
      columns.blocked,
    ],
    rejections: record?.rejections ?? 0,
    objections: record?.objections ?? 0,
    limits: {
      rejections: config.limits.rejections,
      objections: config.limits.objections,
    },
    timeline: (await store.summaries(key)).map(entryOf),
  };
  if (record?.branch !== undefined) data.branch = record.branch;
  if (record?.pr !== undefined) {
    data.pr = record.pr;
    if (await board.isMerged(record.pr)) data.merged = true;
  }

  const working = [columns.testing, columns.implementing, columns.reviewing];
  if (column === columns.blocked) {
    data.blocked = true;
    if (record?.checkpoint !== undefined) data.stage = record.checkpoint.stage;
    // 前の版で止めた Issue には理由の記録が無いので、スレッドの記録を見る
    const reason =
      record?.blockedReason ?? (await store.getBlockedThread(key))?.reason;
    if (reason !== undefined) data.blockedReason = reason;
    if (record?.blockedAt !== undefined) data.blockedAt = record.blockedAt;
  } else if (working.includes(column)) {
    data.stage = stageOf(record, column, columns);
    if (record?.stageStartedAt !== undefined) {
      data.stageStartedAt = record.stageStartedAt;
    }
  }

  if (activity.running?.issue === issue) data.working = activity.running.role;
  return data;
}

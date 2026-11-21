/**
 * 管理画面のタスク一覧に出す内容を集める。
 * 列は GitHub Projects（board）を正とし、差し戻し・異議・途中の段階・PR は記録（store）から読む。
 * PR がマージ済みかは board に確かめる
 */
import type { Config } from "./config.js";
import type { LoopIssue } from "./loop.js";
import type { Store } from "./store.js";
import type { TaskRow, TasksData } from "./tasks-data.js";

export type { TaskRow, TasksData } from "./tasks-data.js";

/** GitHub Projects の Issue。updatedAt は GitHub の更新日時（ISO 8601。取れなければ省く） */
export interface TaskIssue extends LoopIssue {
  updatedAt?: string;
}

export interface TasksBoard {
  /** Project のすべての Issue（列の名前ごと） */
  issuesByColumn(): Promise<Map<string, TaskIssue[]>>;
  /** PR がマージ済みか */
  isMerged(pr: number): Promise<boolean>;
}

export interface TasksDeps {
  config: Config;
  store: Store;
  board: TasksBoard;
}

/** 2つの ISO 8601 の時刻の新しいほう（読めないものは使わない） */
export function laterOf(
  a: string | undefined,
  b: string | undefined,
): string | undefined {
  const ta = a === undefined ? NaN : Date.parse(a);
  const tb = b === undefined ? NaN : Date.parse(b);
  if (Number.isNaN(ta)) return Number.isNaN(tb) ? undefined : b;
  if (Number.isNaN(tb)) return a;
  return tb > ta ? b : a;
}

export async function loadTasks(deps: TasksDeps): Promise<TasksData> {
  const { config, store, board } = deps;
  const { columns, repo } = config.github;
  const byColumn = await board.issuesByColumn();
  const records = new Map(
    (await store.list(repo)).map((r) => [r.issue, r] as const),
  );

  const issues: TaskRow[] = [];
  for (const [column, list] of byColumn) {
    for (const issue of list) {
      const record = records.get(issue.number);
      const row: TaskRow = {
        number: issue.number,
        title: issue.title,
        column,
        rejections: record?.rejections ?? 0,
        objections: record?.objections ?? 0,
      };
      if (record?.checkpoint !== undefined) {
        row.stage = record.checkpoint.stage;
      }
      if (record?.pr !== undefined) {
        row.pr = record.pr;
        if (await board.isMerged(record.pr)) row.merged = true;
      }
      const updatedAt = laterOf(record?.updatedAt, issue.updatedAt);
      if (updatedAt !== undefined) row.updatedAt = updatedAt;
      issues.push(row);
    }
  }
  issues.sort((a, b) => a.number - b.number);

  return {
    repo,
    columns: [
      columns.ready,
      columns.testing,
      columns.implementing,
      columns.reviewing,
      columns.done,
      columns.blocked,
    ],
    doneColumn: columns.done,
    limits: {
      rejections: config.limits.rejections,
      objections: config.limits.objections,
    },
    issues,
  };
}

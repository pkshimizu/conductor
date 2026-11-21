/** タスク一覧の絞り込み（列と検索欄） */
import type { TaskRow, TasksData } from "../../src/tasks-data.js";

/** 列の選択肢の「すべて」 */
export const ALL_COLUMNS = "all";

/** 検索欄の文字に当てはまるか（番号の一部かタイトルの一部。先頭の # は除く。大文字小文字は区別しない） */
export function matchesQuery(row: TaskRow, query: string): boolean {
  const q = query.trim().toLowerCase().replace(/^#/, "");
  if (q === "") return true;
  return String(row.number).includes(q) || row.title.toLowerCase().includes(q);
}

/** 選んだ列（"all" ならすべて）に当てはまるか */
export function matchesColumn(row: TaskRow, filter: string): boolean {
  return filter === ALL_COLUMNS || row.column === filter;
}

/** 列と検索欄の両方に当てはまる行 */
export function filterTasks(
  data: TasksData,
  filter: string,
  query: string,
): TaskRow[] {
  return data.issues.filter(
    (row) => matchesColumn(row, filter) && matchesQuery(row, query),
  );
}

export interface ColumnOption {
  /** "all" か列の名前 */
  value: string;
  count: number;
}

/** 列の選択肢と件数（「すべて」と config の列の順。件数は検索欄に左右されない） */
export function columnOptions(data: TasksData): ColumnOption[] {
  return [
    { value: ALL_COLUMNS, count: data.issues.length },
    ...data.columns.map((column) => ({
      value: column,
      count: data.issues.filter((row) => row.column === column).length,
    })),
  ];
}

/**
 * 管理画面のタスク一覧に出す内容の形。サーバー（src/tasks.ts）が作り、SSE で画面（web/src/TaskList.tsx）に送る。
 * 画面からも読むので、Node に頼るものを import しない（JSON にできる値だけ）
 */
import type { DashboardStage } from "./dashboard-data.js";

/** 一覧の1行（Issue 1件） */
export interface TaskRow {
  number: number;
  title: string;
  /** GitHub Projects の列の名前（列が未設定なら ""） */
  column: string;
  /** 途中の段階（記録の checkpoint.stage）。記録が無ければ省く */
  stage?: DashboardStage;
  rejections: number;
  objections: number;
  pr?: number;
  /** PR がマージ済みなら true */
  merged?: true;
  /** 更新日時（ISO 8601）。記録と GitHub の新しいほう。どちらも無ければ省く */
  updatedAt?: string;
}

export interface TasksData {
  /** owner/name */
  repo: string;
  /** 列の選択肢（config の列の順） */
  columns: string[];
  /** 完了の列（config.github.columns.done）。この列の Issue には途中の段階を出さない */
  doneColumn: string;
  limits: { rejections: number; objections: number };
  /** Project のすべての Issue（番号の順） */
  issues: TaskRow[];
}

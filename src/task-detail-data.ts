/**
 * 管理画面のタスク詳細に出す内容の形。サーバー（src/task-detail.ts）が作り、SSE で画面（web/src/TaskDetail.tsx）に送る。
 * 画面からも読むので、Node に頼るものを import しない（JSON にできる値だけ）
 */
import type { DashboardRole, DashboardStage } from "./dashboard-data.js";

/** 役の結果（デザインの辞書 results のキー） */
export type TimelineResult =
  "approved" | "changes" | "objection" | "done" | "failed" | "passed";

/** 経過の1件（記録の summaries の1行） */
export interface TimelineEntry {
  /** 役（summary の role をそのまま。tester・implementer・ci・reviewer・merge など） */
  role: string;
  /** 結果。知らない verdict なら省く（画面は verdict をそのまま出す） */
  result?: TimelineResult;
  /** summary の verdict をそのまま */
  verdict: string;
  /** 要約 */
  text: string;
  /** 記録した時刻（ISO 8601） */
  at: string;
}

export interface TaskDetailData {
  number: number;
  /** タイトル（GitHub Projects に無ければ ""） */
  title: string;
  /** GitHub Projects の列の名前（見つからなければ ""） */
  column: string;
  /** owner/name */
  repo: string;
  /** config の列（Ready・Testing・Implementing・Reviewing・Done・Blocked の順。列の色に使う） */
  columns: string[];
  branch?: string;
  pr?: number;
  /** PR がマージ済みなら true */
  merged?: true;
  rejections: number;
  objections: number;
  limits: { rejections: number; objections: number };
  /**
   * 進み具合に出す段階。処理中の列（Testing・Implementing・Reviewing）か Blocked の Issue だけ。
   * Blocked なら止まった段階
   */
  stage?: DashboardStage;
  /** 今の段階を始めた時刻（ISO 8601） */
  stageStartedAt?: string;
  /** Blocked の列にあるなら true */
  blocked?: true;
  /** 止まった理由 */
  blockedReason?: string;
  /** 止まった日時（ISO 8601） */
  blockedAt?: string;
  /** この Issue で今動いている役。動いていなければ省く */
  working?: DashboardRole;
  /** 経過（記録した順。0 がいちばん古い） */
  timeline: TimelineEntry[];
}

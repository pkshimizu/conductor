/**
 * 管理画面のダッシュボードに出す内容の形。サーバー（src/dashboard.ts）が作り、SSE で画面（web/src/Dashboard.tsx）に送る。
 * 画面からも読むので、Node に頼るものを import しない（JSON にできる値だけ）
 */

/** 稼働状態（動作中・待機中・停止しています・停止中）。src/admin-server.ts の AdminStatus と同じ */
export type DashboardStatus = "running" | "idle" | "stopping" | "stopped";

/** 段階（src/store.ts の Stage と同じ） */
export type DashboardStage =
  "testing" | "implementing" | "ci" | "reviewing" | "approving" | "merging";

/** 動いている役（src/loop.ts の ActiveRole と同じ） */
export type DashboardRole =
  | "tester"
  | "implementer"
  | "ci"
  | "reviewer"
  | "merge"
  | "specifier"
  | "decomposer";

/** 処理中の Issue */
export interface DashboardActive {
  number: number;
  title: string;
  branch?: string;
  pr?: number;
  stage: DashboardStage;
  /** 今の段階を始めた時刻（ISO 8601）。経過時間はここから数える */
  stageStartedAt?: string;
  /** 今動いている役。動いていなければ省く */
  role?: DashboardRole;
  rejections: number;
  objections: number;
}

/** 人の判断を待っている（Blocked の列にある）Issue */
export interface DashboardBlocked {
  number: number;
  title: string;
  /** 止まった理由 */
  reason?: string;
  /** 止まった日時（ISO 8601） */
  blockedAt?: string;
  /** 止まった段階 */
  stage?: DashboardStage;
}

export interface DashboardData {
  status: DashboardStatus;
  /** owner/name */
  repo: string;
  /** 確認の間隔（秒。config.poll_interval） */
  pollInterval: number;
  /** マージ方法（config.merge.approval をそのまま） */
  merge: "auto" | "human";
  limits: { rejections: number; objections: number };
  /** 最後に GitHub を確認した時刻（ISO 8601） */
  lastCheckedAt?: string;
  /** 次に GitHub を確認する時刻（ISO 8601） */
  nextCheckAt?: string;
  active?: DashboardActive;
  blocked: DashboardBlocked[];
  /** GitHub Projects の列ごとの件数（列の順） */
  counts: { column: string; count: number }[];
}

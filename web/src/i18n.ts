/** 画面の言語と文言（デザインの辞書 ja・en のうち、共通の枠で使うもの） */
export type Lang = "ja" | "en";

/** 稼働状態（動作中・待機中・停止中）。src/admin-server.ts の AdminStatus と同じ */
export type Status = "running" | "idle" | "stopped";

export interface Messages {
  menu: string;
  navDashboard: string;
  navTasks: string;
  navSettings: string;
  runsOn: string;
  project: string;
  language: string;
  stRunning: string;
  stIdle: string;
  stStopped: string;
  blockedTitle: string;
  blockedNote: string;
  blockedReason: string;
  stoppedAt: string;
  openGitHub: string;
  viewDetail: string;
  activeTitle: string;
  elapsed: string;
  progress: string;
  branch: string;
  rejections: string;
  objections: string;
  pausedNote: string;
  emptyTitle: string;
  emptyBody: string;
  statusTitle: string;
  lastChecked: string;
  nextCheck: string;
  interval: string;
  mergeMode: string;
  countsTitle: string;
  all: string;
  searchPh: string;
  colIssue: string;
  colTitle: string;
  colColumn: string;
  colStage: string;
  colRej: string;
  colObj: string;
  colUpdated: string;
  noResults: string;
  merged: string;
  back: string;
  timeline: string;
  sortOrder: string;
  newest: string;
  oldest: string;
  showMore: string;
  showLess: string;
  workingNow: string;
  workingNote: string;
  noTimeline: string;
  /** 役の結果 */
  results: Readonly<Record<ResultKey, string>>;
  /** 進み具合の段階 */
  stage: Readonly<Record<StageKey, string>>;
  /** 動いている役 */
  roles: Readonly<Record<RoleKey, string>>;
}

/** 進み具合の段階（テスト→実装→CI→レビュー→マージ） */
export const STAGE_KEYS = ["test", "impl", "ci", "review", "merge"] as const;
export type StageKey = (typeof STAGE_KEYS)[number];

/** 役の結果（src/task-detail-data.ts の TimelineResult と同じ） */
export type ResultKey =
  "approved" | "changes" | "objection" | "done" | "failed" | "passed";

/** 動いている役（src/loop.ts の ActiveRole と同じ） */
export type RoleKey =
  | "tester"
  | "implementer"
  | "ci"
  | "reviewer"
  | "merge"
  | "specifier"
  | "decomposer";

export const MESSAGES: Readonly<Record<Lang, Messages>> = {
  ja: {
    menu: "メニュー",
    navDashboard: "ダッシュボード",
    navTasks: "タスク一覧",
    navSettings: "設定",
    runsOn: "この PC で動作中（localhost）",
    project: "Project",
    language: "言語",
    stRunning: "動作中",
    stIdle: "待機中",
    stStopped: "停止中",
    blockedTitle: "人の判断を待っています",
    blockedNote: "GitHub で内容を確認して判断してください",
    blockedReason: "止まった理由",
    stoppedAt: "止まった日時",
    openGitHub: "GitHub で開く",
    viewDetail: "詳細を見る",
    activeTitle: "処理中の Issue",
    elapsed: "経過",
    progress: "進み具合",
    branch: "ブランチ",
    rejections: "差し戻し",
    objections: "異議",
    pausedNote:
      "conductor を停止しているため、この作業は止まっています。再起動すると続きから動きます。",
    emptyTitle: "Ready の Issue を待っています",
    emptyBody:
      "GitHub Projects の「Ready」列に Issue を移すと、ここで処理が始まります。",
    statusTitle: "稼働状況",
    lastChecked: "最後に GitHub を確認",
    nextCheck: "次の確認まで",
    interval: "確認の間隔",
    mergeMode: "マージ",
    countsTitle: "列ごとの件数",
    all: "すべて",
    searchPh: "番号・タイトルで検索",
    colIssue: "Issue",
    colTitle: "タイトル",
    colColumn: "列",
    colStage: "途中の段階",
    colRej: "差し戻し",
    colObj: "異議",
    colUpdated: "更新日時",
    noResults: "該当する Issue はありません",
    merged: "マージ済み",
    back: "タスク一覧へ戻る",
    timeline: "経過",
    sortOrder: "並び順",
    newest: "新しい順",
    oldest: "古い順",
    showMore: "続きを表示",
    showLess: "折りたたむ",
    workingNow: "作業中",
    workingNote: "作業中の出力は表示しません。終わると結果がここに並びます。",
    noTimeline: "まだ経過はありません。",
    results: {
      approved: "承認",
      changes: "差し戻し",
      objection: "異議",
      done: "完了",
      failed: "失敗",
      passed: "成功",
    },
    stage: {
      test: "テスト",
      impl: "実装",
      ci: "CI",
      review: "レビュー",
      merge: "マージ",
    },
    roles: {
      tester: "テスト役",
      implementer: "実装役",
      ci: "CI",
      reviewer: "レビュー役",
      merge: "マージ",
      specifier: "仕様化役",
      decomposer: "分解役",
    },
  },
  en: {
    menu: "Menu",
    navDashboard: "Dashboard",
    navTasks: "Tasks",
    navSettings: "Settings",
    runsOn: "Running on this machine (localhost)",
    project: "Project",
    language: "Language",
    stRunning: "Running",
    stIdle: "Idle",
    stStopped: "Stopped",
    blockedTitle: "Waiting for your decision",
    blockedNote: "Review the issue on GitHub and decide how to proceed",
    blockedReason: "Why it stopped",
    stoppedAt: "Blocked at",
    openGitHub: "Open on GitHub",
    viewDetail: "View details",
    activeTitle: "In progress",
    elapsed: "Elapsed",
    progress: "Progress",
    branch: "Branch",
    rejections: "Rejections",
    objections: "Objections",
    pausedNote:
      "conductor is stopped, so this run is paused. It resumes from here after a restart.",
    emptyTitle: "Waiting for a Ready issue",
    emptyBody:
      "Move an issue to the “Ready” column in GitHub Projects and conductor will pick it up here.",
    statusTitle: "Status",
    lastChecked: "Last checked GitHub",
    nextCheck: "Next check in",
    interval: "Poll interval",
    mergeMode: "Merge",
    countsTitle: "Issues by column",
    all: "All",
    searchPh: "Search by number or title",
    colIssue: "Issue",
    colTitle: "Title",
    colColumn: "Column",
    colStage: "Current stage",
    colRej: "Rejections",
    colObj: "Objections",
    colUpdated: "Updated",
    noResults: "No matching issues",
    merged: "Merged",
    back: "Back to tasks",
    timeline: "Timeline",
    sortOrder: "Sort order",
    newest: "Newest first",
    oldest: "Oldest first",
    showMore: "Show more",
    showLess: "Show less",
    workingNow: "Working",
    workingNote:
      "Output from a running role is not shown. Its result appears here when it finishes.",
    noTimeline: "Nothing has happened yet.",
    results: {
      approved: "Approved",
      changes: "Changes requested",
      objection: "Objection",
      done: "Done",
      failed: "Failed",
      passed: "Passed",
    },
    stage: {
      test: "Test",
      impl: "Implement",
      ci: "CI",
      review: "Review",
      merge: "Merge",
    },
    roles: {
      tester: "Tester",
      implementer: "Implementer",
      ci: "CI",
      reviewer: "Reviewer",
      merge: "Merge",
      specifier: "Specifier",
      decomposer: "Decomposer",
    },
  },
};

/** 稼働状態の文言 */
export function statusLabel(t: Messages, status: Status): string {
  if (status === "running") return t.stRunning;
  if (status === "idle") return t.stIdle;
  return t.stStopped;
}

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
}

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
  },
};

/** 稼働状態の文言 */
export function statusLabel(t: Messages, status: Status): string {
  if (status === "running") return t.stRunning;
  if (status === "idle") return t.stIdle;
  return t.stStopped;
}

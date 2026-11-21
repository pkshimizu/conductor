/** 画面の URL と、メニューのどれにあたるか */
export type Menu = "dashboard" | "tasks" | "settings";

export const MENU_PATHS: Readonly<Record<Menu, string>> = {
  dashboard: "/",
  tasks: "/tasks",
  settings: "/settings",
};

/** タスク詳細の URL（/tasks/<番号>）なら Issue の番号。違えば undefined */
export function detailIssueOf(path: string): number | undefined {
  const m = /^\/tasks\/(\d+)\/?$/.exec(path);
  if (m === null || m[1] === undefined) return undefined;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** URL のメニュー（/tasks/<番号> はタスク一覧）。知らない URL はダッシュボード */
export function menuOf(path: string): Menu {
  if (path === "/tasks" || path.startsWith("/tasks/")) return "tasks";
  if (path === "/settings" || path.startsWith("/settings/")) return "settings";
  return "dashboard";
}

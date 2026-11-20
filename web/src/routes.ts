/** 画面の URL と、メニューのどれにあたるか */
export type Menu = "dashboard" | "tasks" | "settings";

export const MENU_PATHS: Readonly<Record<Menu, string>> = {
  dashboard: "/",
  tasks: "/tasks",
  settings: "/settings",
};

/** URL のメニュー（/tasks/<番号> はタスク一覧）。知らない URL はダッシュボード */
export function menuOf(path: string): Menu {
  if (path === "/tasks" || path.startsWith("/tasks/")) return "tasks";
  if (path === "/settings" || path.startsWith("/settings/")) return "settings";
  return "dashboard";
}

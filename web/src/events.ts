/** サーバーから SSE（/api/events）で届く知らせ */
import type { DashboardData } from "../../src/dashboard-data.js";
import type { TasksData } from "../../src/tasks-data.js";
import type { Status } from "./i18n.js";

export const EVENTS_URL = "/api/events";

export interface AdminInfo {
  status: Status;
  repo: string;
  project: number;
  /** ダッシュボードの内容。まだ届いていなければ省く */
  dashboard?: DashboardData;
  /** タスク一覧の内容。まだ届いていなければ省く */
  tasks?: TasksData;
}

function isStatus(value: unknown): value is Status {
  return value === "running" || value === "idle" || value === "stopped";
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

/** ダッシュボードの内容か（画面が使う項目の形だけを確かめる） */
export function isDashboardData(value: unknown): value is DashboardData {
  if (!isObject(value)) return false;
  const status: unknown = "status" in value ? value.status : undefined;
  const repo: unknown = "repo" in value ? value.repo : undefined;
  const poll: unknown =
    "pollInterval" in value ? value.pollInterval : undefined;
  const merge: unknown = "merge" in value ? value.merge : undefined;
  const limits: unknown = "limits" in value ? value.limits : undefined;
  const blocked: unknown = "blocked" in value ? value.blocked : undefined;
  const counts: unknown = "counts" in value ? value.counts : undefined;
  return (
    isStatus(status) &&
    typeof repo === "string" &&
    typeof poll === "number" &&
    (merge === "auto" || merge === "human") &&
    isObject(limits) &&
    Array.isArray(blocked) &&
    Array.isArray(counts)
  );
}

/** タスク一覧の内容か（画面が使う項目の形だけを確かめる） */
export function isTasksData(value: unknown): value is TasksData {
  if (!isObject(value)) return false;
  const repo: unknown = "repo" in value ? value.repo : undefined;
  const columns: unknown = "columns" in value ? value.columns : undefined;
  const done: unknown = "doneColumn" in value ? value.doneColumn : undefined;
  const limits: unknown = "limits" in value ? value.limits : undefined;
  const issues: unknown = "issues" in value ? value.issues : undefined;
  return (
    typeof repo === "string" &&
    Array.isArray(columns) &&
    typeof done === "string" &&
    isObject(limits) &&
    Array.isArray(issues)
  );
}

/** 1件の data を読む。形が違えば undefined */
export function parseEvent(data: string): AdminInfo | undefined {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (!isObject(value)) return undefined;
  const status: unknown = "status" in value ? value.status : undefined;
  const repo: unknown = "repo" in value ? value.repo : undefined;
  const project: unknown = "project" in value ? value.project : undefined;
  const dashboard: unknown = "dashboard" in value ? value.dashboard : undefined;
  const tasks: unknown = "tasks" in value ? value.tasks : undefined;
  if (!isStatus(status) || typeof repo !== "string") return undefined;
  if (typeof project !== "number") return undefined;
  const info: AdminInfo = { status, repo, project };
  if (isDashboardData(dashboard)) info.dashboard = dashboard;
  if (isTasksData(tasks)) info.tasks = tasks;
  return info;
}

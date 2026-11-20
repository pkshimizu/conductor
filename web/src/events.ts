/** サーバーから SSE（/api/events）で届く知らせ */
import type { Status } from "./i18n.js";

export const EVENTS_URL = "/api/events";

export interface AdminInfo {
  status: Status;
  repo: string;
  project: number;
}

function isStatus(value: unknown): value is Status {
  return value === "running" || value === "idle" || value === "stopped";
}

/** 1件の data を読む。形が違えば undefined */
export function parseEvent(data: string): AdminInfo | undefined {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const status: unknown = "status" in value ? value.status : undefined;
  const repo: unknown = "repo" in value ? value.repo : undefined;
  const project: unknown = "project" in value ? value.project : undefined;
  if (!isStatus(status) || typeof repo !== "string") return undefined;
  if (typeof project !== "number") return undefined;
  return { status, repo, project };
}

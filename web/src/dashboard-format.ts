/** ダッシュボードの時刻・秒数の書き方（デザインの Main.dc.html と同じ形） */
import type { DashboardStage } from "../../src/dashboard-data.js";
import type { Lang, StageKey } from "./i18n.js";

/** 秒数を「4分12秒」「12秒」（英語は「4m 12s」「12s」）にする */
export function formatDuration(seconds: number, lang: Lang): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (lang === "ja") return m > 0 ? `${m}分${r}秒` : `${r}秒`;
  return m > 0 ? `${m}m ${r}s` : `${r}s`;
}

/** 何秒前か（10 秒未満は「たった今」、1 分以上は「3分前」） */
export function formatAgo(seconds: number, lang: Lang): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 10) return lang === "ja" ? "たった今" : "just now";
  if (s < 60) return lang === "ja" ? `${s}秒前` : `${s}s ago`;
  const m = Math.floor(s / 60);
  return lang === "ja" ? `${m}分前` : `${m}m ago`;
}

/** 「18 秒」「18s」 */
export function formatSeconds(seconds: number, lang: Lang): string {
  return lang === "ja" ? `${seconds} 秒` : `${seconds}s`;
}

/** 確認の間隔「30 秒」「30 seconds」 */
export function formatInterval(seconds: number, lang: Lang): string {
  return lang === "ja" ? `${seconds} 秒` : `${seconds} seconds`;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 日時を、この PC の時刻で「11/21 11:28」にする */
export function formatStamp(date: Date): string {
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** ISO 8601 の時刻から now までの秒数。読めなければ undefined */
export function secondsSince(
  iso: string | undefined,
  now: Date,
): number | undefined {
  if (iso === undefined) return undefined;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return undefined;
  return Math.max(0, Math.floor((now.getTime() - t) / 1000));
}

/** now から ISO 8601 の時刻までの秒数（過ぎていれば 0）。読めなければ undefined */
export function secondsUntil(
  iso: string | undefined,
  now: Date,
): number | undefined {
  if (iso === undefined) return undefined;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return undefined;
  return Math.max(0, Math.ceil((t - now.getTime()) / 1000));
}

/** 記録の段階を、進み具合の段階にする（承認待ちはレビュー） */
export function stageKeyOf(stage: DashboardStage): StageKey {
  switch (stage) {
    case "testing":
      return "test";
    case "implementing":
      return "impl";
    case "ci":
      return "ci";
    case "reviewing":
    case "approving":
      return "review";
    case "merging":
      return "merge";
  }
}

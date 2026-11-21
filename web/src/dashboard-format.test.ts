import { describe, expect, it } from "vitest";
import {
  formatAgo,
  formatDuration,
  formatInterval,
  formatSeconds,
  formatStamp,
  secondsSince,
  secondsUntil,
  stageKeyOf,
} from "./dashboard-format.js";

describe("formatDuration", () => {
  it("デザインと同じく、分があれば「4分12秒」、無ければ「12秒」", () => {
    expect(formatDuration(252, "ja")).toBe("4分12秒");
    expect(formatDuration(60, "ja")).toBe("1分0秒");
    expect(formatDuration(12, "ja")).toBe("12秒");
    expect(formatDuration(252, "en")).toBe("4m 12s");
    expect(formatDuration(12, "en")).toBe("12s");
    expect(formatDuration(-3, "ja")).toBe("0秒");
  });
});

describe("formatAgo", () => {
  it("10 秒未満は「たった今」、1 分以上は分で示す", () => {
    expect(formatAgo(3, "ja")).toBe("たった今");
    expect(formatAgo(12, "ja")).toBe("12秒前");
    expect(formatAgo(125, "ja")).toBe("2分前");
    expect(formatAgo(3, "en")).toBe("just now");
    expect(formatAgo(12, "en")).toBe("12s ago");
  });
});

describe("秒数の書き方", () => {
  it("次の確認までと、確認の間隔", () => {
    expect(formatSeconds(18, "ja")).toBe("18 秒");
    expect(formatSeconds(18, "en")).toBe("18s");
    expect(formatInterval(30, "ja")).toBe("30 秒");
    expect(formatInterval(30, "en")).toBe("30 seconds");
  });
});

describe("formatStamp", () => {
  it("この PC の時刻で「月/日 時:分」", () => {
    expect(formatStamp(new Date(2026, 10, 21, 9, 5))).toBe("11/21 09:05");
  });
});

describe("secondsSince と secondsUntil", () => {
  const now = new Date("2026-11-21T00:00:30.000Z");
  it("時刻との差を秒で返す。無いか読めなければ undefined", () => {
    expect(secondsSince("2026-11-21T00:00:18.000Z", now)).toBe(12);
    expect(secondsUntil("2026-11-21T00:00:48.000Z", now)).toBe(18);
    expect(secondsUntil("2026-11-21T00:00:10.000Z", now)).toBe(0);
    expect(secondsSince(undefined, now)).toBeUndefined();
    expect(secondsUntil("壊れた", now)).toBeUndefined();
  });
});

describe("stageKeyOf", () => {
  it("承認待ちはレビューの段階", () => {
    expect(stageKeyOf("testing")).toBe("test");
    expect(stageKeyOf("implementing")).toBe("impl");
    expect(stageKeyOf("ci")).toBe("ci");
    expect(stageKeyOf("approving")).toBe("review");
    expect(stageKeyOf("merging")).toBe("merge");
  });
});

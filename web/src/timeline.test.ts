import { describe, expect, it } from "vitest";
import {
  foldSummary,
  isLongSummary,
  orderTimeline,
  toggleExpanded,
} from "./timeline.js";

describe("isLongSummary", () => {
  it("180 文字より長いか、5 行以上なら長い", () => {
    expect(isLongSummary("あ".repeat(180))).toBe(false);
    expect(isLongSummary("あ".repeat(181))).toBe(true);
    expect(isLongSummary("1\n2\n3\n4")).toBe(false);
    expect(isLongSummary("1\n2\n3\n4\n5")).toBe(true);
  });
});

describe("foldSummary", () => {
  it("180 文字までにして「…」を付ける", () => {
    const text = "あ".repeat(200);
    expect(foldSummary(text)).toBe(`${"あ".repeat(180)}…`);
  });

  it("4 行までにする", () => {
    expect(foldSummary("1\n2\n3\n4\n5\n6")).toBe("1\n2\n3\n4…");
  });

  it("短ければそのまま", () => {
    expect(foldSummary("短い")).toBe("短い");
  });
});

describe("orderTimeline", () => {
  it("新しい順は逆に、古い順は記録した順に並べ、記録した順の番号を添える", () => {
    expect(orderTimeline(["a", "b", "c"], "newest")).toEqual([
      { entry: "c", index: 2 },
      { entry: "b", index: 1 },
      { entry: "a", index: 0 },
    ]);
    expect(orderTimeline(["a", "b"], "oldest")).toEqual([
      { entry: "a", index: 0 },
      { entry: "b", index: 1 },
    ]);
  });
});

describe("toggleExpanded", () => {
  it("開いていなければ足し、開いていれば除く", () => {
    expect(toggleExpanded([1], 3)).toEqual([1, 3]);
    expect(toggleExpanded([1, 3], 1)).toEqual([3]);
  });
});

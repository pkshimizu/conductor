import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TaskDetailData } from "../../src/task-detail-data.js";
import { TaskDetail } from "./TaskDetail.js";

const base: TaskDetailData = {
  number: 3,
  title: "t",
  column: "Ready",
  repo: "o/r",
  columns: ["Ready"],
  rejections: 0,
  objections: 0,
  limits: { rejections: 3, objections: 2 },
  timeline: [],
};

function render(data: TaskDetailData): string {
  return renderToStaticMarkup(
    createElement(TaskDetail, {
      data,
      lang: "ja",
      now: new Date("2026-11-20T00:00:00.000Z"),
      order: "newest",
      expanded: [],
    }),
  );
}

describe("TaskDetail", () => {
  it("辞書に無い役と結果は記録のまま出す", () => {
    const html = render({
      ...base,
      timeline: [
        {
          role: "human",
          verdict: "odd",
          text: "人の指摘",
          at: "2026-11-20T00:00:00.000Z",
        },
      ],
    });
    expect(html).toContain("human");
    expect(html).toContain("odd");
    expect(html).toContain("人の指摘");
  });

  it("段階が無ければ進み具合を出さない。マージ済みの PR には印を出す", () => {
    const html = render({ ...base, pr: 4, merged: true });
    expect(html).not.toContain("<ol");
    expect(html).toContain("マージ済み");
  });
});

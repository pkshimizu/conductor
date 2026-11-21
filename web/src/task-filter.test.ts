import { describe, expect, it } from "vitest";
import type { TaskRow, TasksData } from "../../src/tasks-data.js";
import {
  columnOptions,
  filterTasks,
  matchesColumn,
  matchesQuery,
} from "./task-filter.js";

const row = (number: number, title: string, column: string): TaskRow => ({
  number,
  title,
  column,
  rejections: 0,
  objections: 0,
});

const data: TasksData = {
  repo: "o/r",
  columns: ["Ready", "Testing", "Done"],
  doneColumn: "Done",
  limits: { rejections: 3, objections: 2 },
  issues: [
    row(1, "Read the dictionary", "Done"),
    row(12, "単語の一覧", "Ready"),
    row(20, "単語を検索する", "Ready"),
    row(48, "Export", ""),
  ],
};

describe("matchesQuery", () => {
  it("空なら当てはまる", () => {
    expect(matchesQuery(row(1, "a", "Ready"), "  ")).toBe(true);
  });

  it("番号の一部（先頭の # は除く）かタイトルの一部（大文字小文字を区別しない）", () => {
    const r = row(48, "Export words", "Ready");
    expect(matchesQuery(r, "48")).toBe(true);
    expect(matchesQuery(r, "#4")).toBe(true);
    expect(matchesQuery(r, "8")).toBe(true);
    expect(matchesQuery(r, "export")).toBe(true);
    expect(matchesQuery(r, "WORDS")).toBe(true);
    expect(matchesQuery(r, "49")).toBe(false);
  });
});

describe("matchesColumn", () => {
  it("all ならすべて、それ以外は列の名前が同じもの", () => {
    expect(matchesColumn(row(1, "a", "Ready"), "all")).toBe(true);
    expect(matchesColumn(row(1, "a", "Ready"), "Ready")).toBe(true);
    expect(matchesColumn(row(1, "a", "Ready"), "Done")).toBe(false);
  });
});

describe("filterTasks", () => {
  it("列と検索欄の両方に当てはまる行だけ", () => {
    expect(filterTasks(data, "Ready", "単語").map((r) => r.number)).toEqual([
      12, 20,
    ]);
    expect(filterTasks(data, "Ready", "検索").map((r) => r.number)).toEqual([
      20,
    ]);
    expect(filterTasks(data, "all", "nothing")).toEqual([]);
  });
});

describe("columnOptions", () => {
  it("「すべて」と config の列の件数（列の無い Issue は「すべて」にだけ数える）", () => {
    expect(columnOptions(data)).toEqual([
      { value: "all", count: 4 },
      { value: "Ready", count: 2 },
      { value: "Testing", count: 0 },
      { value: "Done", count: 1 },
    ]);
  });
});

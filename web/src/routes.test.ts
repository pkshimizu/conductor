import { describe, expect, it } from "vitest";
import { detailIssueOf, menuOf } from "./routes.js";

describe("detailIssueOf", () => {
  it("/tasks/<番号> から Issue の番号を読む", () => {
    expect(detailIssueOf("/tasks/12")).toBe(12);
    expect(detailIssueOf("/tasks/12/")).toBe(12);
    expect(detailIssueOf("/tasks")).toBeUndefined();
    expect(detailIssueOf("/tasks/abc")).toBeUndefined();
    expect(detailIssueOf("/tasks/0")).toBeUndefined();
    expect(detailIssueOf("/tasks/12/x")).toBeUndefined();
  });
});

describe("menuOf", () => {
  it("URL からメニューを決める", () => {
    expect(menuOf("/")).toBe("dashboard");
    expect(menuOf("/tasks")).toBe("tasks");
    expect(menuOf("/tasks/12")).toBe("tasks");
    expect(menuOf("/settings")).toBe("settings");
    expect(menuOf("/tasksx")).toBe("dashboard");
    expect(menuOf("/unknown")).toBe("dashboard");
  });
});

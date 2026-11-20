import { describe, expect, it } from "vitest";
import { menuOf } from "./routes.js";

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

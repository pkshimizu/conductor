import { describe, expect, it } from "vitest";
import { parseEvent } from "./events.js";

describe("parseEvent", () => {
  it("稼働状態・リポジトリ・Project を読む", () => {
    const data = '{"status":"idle","repo":"o/r","project":3,"extra":1}';
    expect(parseEvent(data)).toEqual({
      status: "idle",
      repo: "o/r",
      project: 3,
    });
  });

  it("形が違えば undefined", () => {
    expect(parseEvent("not json")).toBeUndefined();
    expect(parseEvent("null")).toBeUndefined();
    const busy = '{"status":"busy","repo":"o/r","project":3}';
    expect(parseEvent(busy)).toBeUndefined();
    expect(parseEvent('{"status":"idle","project":3}')).toBeUndefined();
    expect(parseEvent('{"status":"idle","repo":"o/r"}')).toBeUndefined();
  });
});

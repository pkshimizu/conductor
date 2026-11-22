import { describe, expect, it } from "vitest";

import { MESSAGES } from "./i18n.js";

/** 文言の値をすべて（入れ子の roles・stage・results も）並べる */
function valuesOf(o: object): string[] {
  return Object.values(o).flatMap((v: unknown) =>
    typeof v === "string"
      ? [v]
      : v !== null && typeof v === "object"
        ? valuesOf(v)
        : [],
  );
}

describe("MESSAGES", () => {
  it("日本語の役の名前は「～エージェント」と出す", () => {
    expect(MESSAGES.ja.roles).toMatchObject({
      tester: "テストエージェント",
      implementer: "実装エージェント",
      reviewer: "レビューエージェント",
      specifier: "仕様化エージェント",
      decomposer: "分解エージェント",
      ci: "CI",
      merge: "マージ",
    });
    expect(MESSAGES.ja.someRole).toBe("エージェント");
    expect(MESSAGES.ja.tabPerms).toBe("エージェントの許可");
  });

  it("日本語の文言に「役」の字は残っていない", () => {
    expect(valuesOf(MESSAGES.ja).filter((s) => s.includes("役"))).toEqual([]);
  });

  it("英語は変えない", () => {
    expect(MESSAGES.en.roles.implementer).toBe("Implementer");
  });
});

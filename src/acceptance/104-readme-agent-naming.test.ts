/**
 * Issue #104: README と Issue テンプレートの「～役」を「～エージェント」に変える の受け入れテスト
 *
 * 決めたこと（実装エージェントはこれに合わせて作る）:
 * - 呼び名は docs/specs/agent-naming.md の「1. 呼び名を変える」の表のとおり。
 * - 「役の説明の節」は README.md の各役を説明している箇所（冒頭の説明・「対象リポジトリに置くもの」・
 *   「仕様化」「分解」「許可の確認」「マージの承認」など）を指す。役の名前は README の複数の節に
 *   散らばっているため、README.md 全体で確かめる。
 * - 5つの役（テスト・実装・レビュー・仕様化・分解）それぞれについて、
 *   「～エージェント」が書かれていて、「～役」が残っていないことを確かめる。
 * - 設定のキーや置き場所（`roles.<役>.allow`・`.conductor/<役>/*.md`）は変えないので、
 *   この5つの呼び名には当たらず、確かめる対象にならない。
 * - Issue テンプレートは対象外（仕様の「3. 変えないもの」）なので確かめない。
 *
 * seed: なし（リポジトリにある README.md をそのまま読む。DB は使わない）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const readmePath = fileURLToPath(new URL("../../README.md", import.meta.url));

const NAMES = [
  { before: "テスト役", after: "テストエージェント" },
  { before: "実装役", after: "実装エージェント" },
  { before: "レビュー役", after: "レビューエージェント" },
  { before: "仕様化役", after: "仕様化エージェント" },
  { before: "分解役", after: "分解エージェント" },
] as const;

describe("Issue #104: README の役の呼び名", () => {
  it("AC1: README.md でテスト役・実装役・レビュー役・仕様化役・分解役が、それぞれ「～エージェント」と書かれている", () => {
    // Given README.md を開く
    const readme = readFileSync(readmePath, "utf8");

    // When 役の説明の節を読む
    const found = NAMES.map(({ before, after }) => ({
      name: after,
      written: readme.includes(after),
      leftover: readme.includes(before),
    }));

    // Then それぞれ「～エージェント」と書かれていて、「～役」は残っていない
    expect(found).toEqual(
      NAMES.map(({ after }) => ({
        name: after,
        written: true,
        leftover: false,
      })),
    );
  });
});

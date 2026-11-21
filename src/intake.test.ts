import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { parseConfig } from "./config.js";
import { MemoryStore } from "./store.js";
import {
  checkIssueBody,
  missingPrerequisiteProblem,
  parseSections,
  pickUp,
  REQUIRED_SECTIONS,
  type IntakeBoard,
} from "./intake.js";
import type { WorkIssueStatus } from "./progress.js";

const log = () => {};

const COMPLETE = `### 目的

カードを登録できるようにする。

### 受け入れ条件（AC）

- AC1
  - Given カードが1枚もない
  - When /cards を開く
  - Then 「カードがありません」と表示される
- AC2
  - Given /cards を開いている
  - When 「カードを追加」を押す
  - Then /cards/new に移動する

### 画面の URL・文言

- /cards：見出し「カード一覧」

### 対象外

- ログイン
`;

function makeConfig(options: { chat?: boolean; testing?: string } = {}) {
  const lines = [
    "github:",
    "  repo: me/app",
    "  project: 3",
    "  notify: me",
    ...(options.testing === undefined
      ? []
      : [`  columns: { testing: ${options.testing} }`]),
    "protected: [e2e/**]",
    "commands: { setup: s, test: t, acceptance: a, typecheck: y, build: b }",
  ];
  if (options.chat === true) {
    lines.push(
      "chat:",
      "  type: discord",
      '  channels: { requirements: "100", questions: "200", notices: "300" }',
      '  allowed_users: ["u1"]',
    );
  }
  return parseConfig(lines.join("\n"));
}

function fakeBoard(statuses: Record<number, WorkIssueStatus> = {}) {
  const calls: string[] = [];
  const board: IntakeBoard = {
    workIssueStatus: (n) => {
      calls.push(`status #${n}`);
      return Promise.resolve(statuses[n]);
    },
    moveIssue: (n, column) => {
      calls.push(`move #${n} ${column}`);
      return Promise.resolve();
    },
    comment: (n, body, options) => {
      calls.push(`comment #${n} ${options?.mention ? "@" : ""}${body}`);
      return Promise.resolve();
    },
  };
  return { board, calls };
}

describe("AC1: Issue フォームのテンプレート", () => {
  it.each([
    "templates/ISSUE_TEMPLATE/feature.yml",
    ".github/ISSUE_TEMPLATE/feature.yml",
  ])("%s は必須の見出しをすべて必須項目にしている", async (path) => {
    const form = parseYaml(await readFile(path, "utf8")) as {
      body: {
        attributes: { label: string };
        validations?: { required?: boolean };
      }[];
    };
    const required = form.body
      .filter((f) => f.validations?.required)
      .map((f) => f.attributes.label);
    expect(required).toEqual([...REQUIRED_SECTIONS]);
  });

  it("配布用と自分用のテンプレートは同じ", async () => {
    for (const name of ["feature.yml", "config.yml"]) {
      expect(await readFile(`.github/ISSUE_TEMPLATE/${name}`, "utf8")).toBe(
        await readFile(`templates/ISSUE_TEMPLATE/${name}`, "utf8"),
      );
    }
  });
});

describe("見出しの読み取り", () => {
  it("## と ### の見出しで区切る", () => {
    const s = parseSections("前置き\n## 目的\na\n\n### 対象外 ###\nb\r\nc\n");
    expect([...s]).toEqual([
      ["目的", "a"],
      ["対象外", "b\nc"],
    ]);
  });
});

describe("書き漏れの確認", () => {
  it("そろっていれば空", () => {
    expect(checkIssueBody(COMPLETE)).toEqual([]);
  });

  it("見出しが無い項目を挙げる", () => {
    const body = COMPLETE.replace(/### 対象外[\s\S]*$/, "");
    expect(checkIssueBody(body)).toEqual(["「対象外」の見出しがありません"]);
  });

  it("フォームで空欄だった項目を挙げる", () => {
    const body = COMPLETE.replace(
      "- /cards：見出し「カード一覧」",
      "_No response_",
    );
    expect(checkIssueBody(body)).toEqual(["「画面の URL・文言」が空です"]);
  });

  it("テンプレートのままの AC を挙げる", () => {
    const body = COMPLETE.replace(
      /- AC1[\s\S]*?(?=### 画面)/,
      "- AC1\n  - Given\n  - When /cards を開く\n  - Then：\n\n",
    );
    expect(checkIssueBody(body)).toEqual([
      "AC1 の Given が空です",
      "AC1 の Then が空です",
    ]);
  });

  it("Given/When/Then が欠けた AC を挙げる", () => {
    const body = COMPLETE.replace("  - When 「カードを追加」を押す\n", "");
    expect(checkIssueBody(body)).toEqual(["AC2 に When がありません"]);
  });

  it("番号付きの AC が無ければ挙げる", () => {
    const body = COMPLETE.replace(
      /- AC1[\s\S]*?(?=### 画面)/,
      "カードを表示できること\n\n",
    );
    expect(checkIssueBody(body)).toEqual([
      "「受け入れ条件（AC）」に AC1 のような番号付きの項目がありません",
    ]);
  });

  it("空の本文はすべての見出しを挙げる", () => {
    expect(checkIssueBody("")).toEqual(
      REQUIRED_SECTIONS.map((s) => `「${s}」の見出しがありません`),
    );
  });
});

describe("AC2: 書き漏れのある Issue を拾おうとする", () => {
  it("Blocked に移し、欠けた項目をメンション付きでコメントする", async () => {
    const { board, calls } = fakeBoard();
    const store = new MemoryStore();
    const body = COMPLETE.replace(/### 目的[\s\S]*?(?=### 受け入れ)/, "");
    const result = await pickUp(
      { config: makeConfig(), store, board, log },
      { number: 7, body },
    );
    expect(result).toEqual({
      accepted: false,
      problems: ["「目的」の見出しがありません"],
    });
    expect(calls).toEqual([
      "move #7 Blocked",
      "comment #7 @書き漏れがあるため、作業を始めずに Blocked に移しました。\n\n" +
        "- 「目的」の見出しがありません\n\n直したら Ready 列に戻してください。",
    ]);
    expect(await store.listBlockedThreads("me/app")).toEqual([]);
  });

  it("窓口があれば、メンションせずに欠けた項目を理由として記録する", async () => {
    const { board, calls } = fakeBoard();
    const store = new MemoryStore();
    const body = COMPLETE.replace(/### 目的[\s\S]*?(?=### 受け入れ)/, "");
    await pickUp(
      { config: makeConfig({ chat: true }), store, board, log },
      { number: 7, body },
    );
    expect(calls[0]).toBe("move #7 Blocked");
    expect(calls[1]).toMatch(/^comment #7 書き漏れがあるため/);
    expect(calls[1]).toContain("スレッド");
    const record = await store.getBlockedThread({ repo: "me/app", issue: 7 });
    expect(record?.reason).toContain("「目的」の見出しがありません");
  });
});

describe("AC3: そろった Issue を拾う", () => {
  it("テスト役の列に進め、コメントはしない", async () => {
    const { board, calls } = fakeBoard();
    const result = await pickUp(
      {
        config: makeConfig({ testing: "テスト中" }),
        store: new MemoryStore(),
        board,
        log,
      },
      { number: 3, body: COMPLETE },
    );
    expect(result).toEqual({ accepted: true });
    expect(calls).toEqual(["move #3 テスト中"]);
  });
});

describe("先に済ませる Issue の確認", () => {
  const withPrerequisites = (list: string) =>
    `${COMPLETE}\n\n### 先に済ませる Issue\n\n${list}\n`;

  it("まだ開いている Issue があれば、動かさずコメントもせずに待つ（自分自身は無視する）", async () => {
    const { board, calls } = fakeBoard({
      5: { body: "", closed: true },
      6: { body: "" },
    });
    const logs: string[] = [];
    const result = await pickUp(
      {
        config: makeConfig(),
        store: new MemoryStore(),
        board,
        log: (t) => logs.push(t),
      },
      { number: 3, body: withPrerequisites("- #3\n- #5\n- #6") },
    );
    expect(result).toEqual({ accepted: false, waiting: [6] });
    expect(calls).toEqual(["status #5", "status #6"]);
    expect(logs.some((l) => l.includes("#3") && l.includes("#6"))).toBe(true);
  });

  it("すべて閉じていればテスト役の列に進める", async () => {
    const { board, calls } = fakeBoard({
      5: { body: "", closed: true },
      6: { body: "", merged: { number: 9, url: "u" } },
    });
    const result = await pickUp(
      { config: makeConfig(), store: new MemoryStore(), board, log },
      { number: 3, body: withPrerequisites("- #5\n- #6") },
    );
    expect(result).toEqual({ accepted: true });
    expect(calls).toEqual(["status #5", "status #6", "move #3 Testing"]);
  });

  it("リポジトリに無い番号があれば、開いている Issue があっても Blocked に移してその番号をコメントする", async () => {
    const { board, calls } = fakeBoard({ 6: { body: "" } });
    const result = await pickUp(
      { config: makeConfig(), store: new MemoryStore(), board, log },
      { number: 3, body: withPrerequisites("- #6\n- #99") },
    );
    expect(result).toEqual({
      accepted: false,
      problems: [missingPrerequisiteProblem(99)],
    });
    expect(calls[2]).toBe("move #3 Blocked");
    expect(calls[3]).toContain("#99");
  });

  it("書き漏れがあれば、先に済ませる Issue を問い合わせずに Blocked に移す", async () => {
    const { board, calls } = fakeBoard({ 6: { body: "" } });
    const body = withPrerequisites("- #6").replace(
      /### 目的[\s\S]*?(?=### 受け入れ)/,
      "",
    );
    const result = await pickUp(
      { config: makeConfig(), store: new MemoryStore(), board, log },
      { number: 3, body },
    );
    expect(result).toEqual({
      accepted: false,
      problems: ["「目的」の見出しがありません"],
    });
    expect(calls[0]).toBe("move #3 Blocked");
  });
});

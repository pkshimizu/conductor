import { describe, expect, it } from "vitest";
import { MemoryChat } from "./chat.js";
import type { RoleResult, RoleRun } from "./claude.js";
import { parseConfig } from "./config.js";
import {
  checkDecomposition,
  type DecomposerBoard,
  type DecomposerOutput,
  decomposerAllow,
  decomposerPrompt,
  type decomposerOutputSchema,
  findCycle,
  runDecomposer,
  specLink,
  type WorkIssue,
  workIssueBody,
  workIssuesMessage,
  workOrder,
} from "./decomposer.js";
import { checkIssueBody, parseSections } from "./intake.js";
import { MemoryStore } from "./store.js";

const config = parseConfig(
  [
    "github: { repo: me/app, project: 3, notify: me }",
    "protected: [e2e/**]",
    "commands: { setup: s, test: t, acceptance: a, typecheck: y, build: b }",
    "limits: { rejections: 1 }",
    "roles: { decomposer: { allow: ['WebSearch'] } }",
    "chat:",
    "  type: discord",
    '  channels: { requirements: "1", questions: "2", notices: "3" }',
    '  allowed_users: ["u1"]',
  ].join("\n"),
);

function work(key: string, dependsOn: string[] = []): WorkIssue {
  return {
    key,
    title: `${key} を作る`,
    purpose: "目的",
    acceptance: "- AC1\n  - Given 前提\n  - When 操作\n  - Then 結果",
    screens: "なし",
    outOfScope: "なし",
    dependsOn,
  };
}

describe("workIssueBody", () => {
  it("D8 の書式で組み立て、先に済ませる Issue と仕様へのリンクを書く", () => {
    const body = workIssueBody(work("a"), [3, 4], ["https://x/spec.md"]);
    expect(checkIssueBody(body)).toEqual([]);
    const sections = parseSections(body);
    expect(sections.get("先に済ませる Issue")).toBe("- #3\n- #4");
    expect(sections.get("仕様")).toBe("- https://x/spec.md");
  });

  it("先に済ませる Issue が無ければ「なし」", () => {
    const body = workIssueBody(work("a"), [], []);
    expect(parseSections(body).get("先に済ませる Issue")).toBe("なし");
  });
});

describe("specLink", () => {
  it("ブランチとパスを区切りごとに符号化する", () => {
    expect(specLink("me/app", "release/1", "docs/specs/検索.md")).toBe(
      "https://github.com/me/app/blob/release/1/docs/specs/%E6%A4%9C%E7%B4%A2.md",
    );
  });
});

describe("findCycle と workOrder", () => {
  it("循環を key の並びで返す", () => {
    expect(findCycle([work("a", ["b"]), work("b", ["a"])])).toEqual([
      "a",
      "b",
      "a",
    ]);
    expect(findCycle([work("a", ["a"])])).toEqual(["a", "a"]);
    expect(findCycle([work("a"), work("b", ["a"])])).toBeUndefined();
  });

  it("先に済ませるものを前に、同じ段は返した順に並べる", () => {
    const order = workOrder([
      work("c", ["a", "b"]),
      work("b"),
      work("a"),
      work("d", ["a"]),
    ]);
    expect(order.map((i) => i.key)).toEqual(["b", "a", "c", "d"]);
  });
});

describe("checkDecomposition", () => {
  it("空・重なった key・無い key・書式の誤りを示す", () => {
    expect(checkDecomposition([])).toEqual(["作業用 Issue が1件もありません"]);
    const broken = { ...work("b", ["z"]), screens: " " };
    expect(checkDecomposition([work("a"), work("a"), broken])).toEqual([
      "「a」（a を作る）: key が重なっています",
      "「b」（b を作る）: 「画面の URL・文言」が空です",
      "「b」（b を作る）: 先に済ませる Issue「z」がありません",
    ]);
  });

  it("循環を示す", () => {
    expect(checkDecomposition([work("a", ["b"]), work("b", ["a"])])).toEqual([
      "先に済ませる Issue が循環しています: a → b → a",
    ]);
  });
});

describe("decomposerAllow と decomposerPrompt", () => {
  it("読むだけの操作に設定の allow を足す", () => {
    expect(decomposerAllow(config)).toEqual([
      "Read",
      "Glob",
      "Grep",
      "WebSearch",
    ]);
  });

  it("やり直しでは誤りと前回の結果を入れる", () => {
    const text = decomposerPrompt({
      requirement: "検索したい",
      specPr: 9,
      specFiles: ["docs/specs/a.md"],
      retry: { issues: [work("a")], problems: ["誤り1"] },
    });
    expect(text).toContain("検索したい");
    expect(text).toContain("- docs/specs/a.md");
    expect(text).toContain("- 誤り1");
    expect(text).toContain('"key": "a"');
  });
});

describe("workIssuesMessage", () => {
  it("番号・タイトル・URL・先に済ませる Issue を順に書く", () => {
    const text = workIssuesMessage([
      { number: 1, title: "A", url: "https://x/1", prerequisites: [] },
      { number: 2, title: "B", url: "https://x/2", prerequisites: [1] },
    ]);
    expect(text).toContain(
      "1. #1 A\n   https://x/1\n   先に済ませる Issue: なし",
    );
    expect(text).toContain(
      "2. #2 B\n   https://x/2\n   先に済ませる Issue: #1",
    );
  });
});

describe("runDecomposer", () => {
  class Board implements DecomposerBoard {
    files = ["docs/specs/a.md", "src/x.ts"];
    readonly created: { title: string; body: string }[] = [];
    pullRequestFiles(): Promise<string[]> {
      return Promise.resolve(this.files);
    }
    createIssue(input: { title: string; body: string }) {
      this.created.push(input);
      const number = 10 + this.created.length;
      return Promise.resolve({ number, url: `https://x/${number}` });
    }
    addToProject(): Promise<void> {
      return Promise.resolve();
    }
    baseBranch(): Promise<string> {
      return Promise.resolve("main");
    }
  }

  async function setup(replies: DecomposerOutput["issues"][]) {
    const chat = new MemoryChat();
    const store = new MemoryStore(() => new Date("2026-11-19T00:00:00.000Z"));
    const head = await chat.post("2", "要件を受け取りました");
    const threadId = await chat.createThread("2", head, "要件");
    await chat.post(threadId, "> 検索したい");
    const record = await store.updateRequirement("100", {
      threadId,
      specPr: 9,
      state: "working",
    });
    const board = new Board();
    const runs: RoleRun<typeof decomposerOutputSchema>[] = [];
    const deps = {
      config,
      repoDir: "/repo",
      chat,
      store,
      board,
      instructions: "",
      log: () => {},
      run: (r: RoleRun<typeof decomposerOutputSchema>) => {
        runs.push(r);
        const issues = replies.shift() ?? [];
        return Promise.resolve<RoleResult<DecomposerOutput>>({
          output: { verdict: "approve", summary: "", findings: [], issues },
          denials: [],
          costUsd: 0,
          turns: 1,
          sessionId: "s",
        });
      },
    };
    return { chat, store, record, board, runs, deps, threadId };
  }

  it("要件の本文と仕様ファイルだけを依頼に入れ、書き込みを拒否する。リンクは既定のブランチ", async () => {
    const t = await setup([[work("a")]]);
    expect(await runDecomposer(t.deps, t.record)).toEqual({
      status: "decomposed",
    });
    const run = t.runs[0]!;
    expect(run.prompt).toContain("検索したい");
    expect(run.prompt).toContain("docs/specs/a.md");
    expect(run.prompt).not.toContain("src/x.ts");
    expect(run.deny).toEqual(expect.arrayContaining(["Edit", "Write"]));
    expect(t.board.created[0]!.body).toContain(
      "https://github.com/me/app/blob/main/docs/specs/a.md",
    );
    expect((await t.store.getRequirement("100"))?.workIssues).toEqual([11]);
  });

  it("作業中でない要件・作業用 Issue がある要件は何もしない", async () => {
    const t = await setup([[work("a")]]);
    const done = { ...t.record, workIssues: [1] };
    expect(await runDecomposer(t.deps, done)).toEqual({ status: "skipped" });
    const blocked = { ...t.record, state: "blocked" as const };
    expect(await runDecomposer(t.deps, blocked)).toEqual({ status: "skipped" });
    expect(t.runs).toEqual([]);
  });

  it("仕様の PR に仕様ファイルが無ければ、分解役を起動せずに止める", async () => {
    const t = await setup([]);
    t.board.files = ["src/x.ts"];
    expect(await runDecomposer(t.deps, t.record)).toEqual({
      status: "blocked",
    });
    expect(t.runs).toEqual([]);
    expect((await t.store.getRequirement("100"))?.state).toBe("blocked");
    const last = (t.chat.messages.get(t.threadId) ?? []).at(-1);
    expect(last?.text).toContain("仕様ファイル");
  });

  it("上限（rejections + 1 回）までやり直し、直らなければ止める", async () => {
    const t = await setup([[], [work("a", ["z"])], [work("a")]]);
    expect(await runDecomposer(t.deps, t.record)).toEqual({
      status: "blocked",
    });
    expect(t.runs).toHaveLength(2);
    expect(t.runs[1]!.prompt).toContain("作業用 Issue が1件もありません");
    expect(t.board.created).toEqual([]);
    const last = (t.chat.messages.get(t.threadId) ?? []).at(-1);
    expect(last?.text).toContain("「z」がありません");
  });
});

import { describe, expect, it } from "vitest";
import type { RoleRun } from "./claude.js";
import { parseConfig } from "./config.js";
import { matchesAny } from "./git.js";
import { listAcceptance } from "./intake.js";
import { MemoryStore } from "./store.js";
import {
  runTester,
  testerAllow,
  testerPrompt,
  type TesterDeps,
  type TesterOutput,
  type testerOutputSchema,
} from "./tester.js";

const BODY = `### 目的

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

- /cards

### 対象外

- ログイン
`;

const ISSUE = { number: 2, title: "カード一覧", body: BODY };

function makeConfig(extra: string[] = []) {
  return parseConfig(
    [
      "github: { repo: me/app, project: 3, notify: me }",
      "protected: [e2e/**, supabase/seed.sql]",
      // extra に commands があれば、そちらを使う（YAML のキー重複を避ける）
      ...(extra.some((l) => l.startsWith("commands:"))
        ? []
        : [
            "commands: { setup: npm run db:reset, test: a, acceptance: npm run e2e, typecheck: d, build: e }",
          ]),
      ...extra,
    ].join("\n"),
  );
}

const SPEC = `test("AC1: 空", async () => { await page.screenshot({ path: "shots/issue-2/AC1.png" }) });
test("AC2: 追加", async () => { await page.screenshot({ path: "shots/issue-2/AC2.png" }) });`;

/** 偽物の作業ツリー。ファイル → 中身 */
function fakeGit() {
  const files = new Map<string, string>();
  const log: string[] = [];
  const committed = new Map<string, string>();
  return {
    files,
    log,
    committed,
    git: {
      startBranch: (b: string) => {
        log.push(`branch ${b}`);
        return Promise.resolve();
      },
      changedFiles: () => Promise.resolve([...files.keys()].sort()),
      discard: (paths: readonly string[]) => {
        for (const p of paths) files.delete(p);
        if (paths.length) log.push(`discard ${paths.join(",")}`);
        return Promise.resolve();
      },
      discardAll: () => {
        files.clear();
        log.push("discardAll");
        return Promise.resolve();
      },
      commit: (paths: readonly string[], message: string) => {
        for (const p of paths) committed.set(p, files.get(p)!);
        files.clear();
        log.push(`commit ${paths.join(",")} ${message}`);
        return Promise.resolve("c0ffee");
      },
      push: (b: string) => {
        log.push(`push ${b}`);
        return Promise.resolve();
      },
      treeHash: (_ref: string, globs: readonly string[]) => {
        log.push(`hash ${globs.join(",")}`);
        return Promise.resolve("h1");
      },
    },
  };
}

function fakeBoard() {
  const moves: [number, string][] = [];
  const comments: {
    issue: number;
    body: string;
    mention: boolean | undefined;
  }[] = [];
  return {
    moves,
    comments,
    board: {
      moveIssue: (issue: number, column: string) => {
        moves.push([issue, column]);
        return Promise.resolve();
      },
      comment: (issue: number, body: string, o?: { mention?: boolean }) => {
        comments.push({ issue, body, mention: o?.mention });
        return Promise.resolve();
      },
    },
  };
}

type Step = { output: TesterOutput; write?: Record<string, string> };

/** 整形の偽物。呼ばれたコマンドを記録し、中身を書き換える */
type FakeFormat = (files: Map<string, string>) => number;

function setup(
  steps: Step[],
  configExtra: string[] = [],
  format: FakeFormat = () => 0,
) {
  const config = makeConfig(configExtra);
  const g = fakeGit();
  const b = fakeBoard();
  const store = new MemoryStore(() => new Date("2026-11-15T00:00:00Z"));
  const runs: RoleRun<typeof testerOutputSchema>[] = [];
  const shellCalls: string[] = [];
  const deps: TesterDeps = {
    shell: (cmd) => {
      shellCalls.push(cmd);
      const code = format(g.files);
      return Promise.resolve({
        code,
        stdout: "",
        stderr: code ? "SyntaxError: x" : "",
      });
    },
    config,
    repoDir: "/repo",
    git: g.git,
    board: b.board,
    store,
    instructions: "seed は SQL で書く",
    readFile: (p) => Promise.resolve(g.files.get(p) ?? ""),
    run: (run) => {
      runs.push(run);
      const step = steps[runs.length - 1]!;
      for (const [f, t] of Object.entries(step.write ?? {})) g.files.set(f, t);
      return Promise.resolve({
        output: step.output,
        denials: [],
        costUsd: 0,
        turns: 1,
        sessionId: "s",
      });
    },
  };
  return { config, g, b, store, runs, deps, shellCalls };
}

const approve = (tests: TesterOutput["tests"]): TesterOutput => ({
  verdict: "approve",
  summary: "書きました",
  findings: [],
  tests,
  questions: [],
});

const TESTS = [
  { ac: "AC1", file: "e2e/cards.spec.ts", title: "AC1: 空" },
  { ac: "AC2", file: "e2e/cards.spec.ts", title: "AC2: 追加" },
];

describe("listAcceptance", () => {
  it("AC 番号を順に返す", () => {
    expect(listAcceptance(BODY)).toEqual(["AC1", "AC2"]);
  });
});

describe("testerAllow / testerPrompt", () => {
  it("保護対象だけ Edit を許す", () => {
    const allow = testerAllow(makeConfig());
    expect(allow).toContain("Edit(./e2e/**)");
    expect(allow).toContain("Edit(./supabase/seed.sql)");
    expect(allow.some((a) => a.startsWith("Edit(./src"))).toBe(false);
  });

  it("依頼文に AC・書いてよいファイル・撮影先・前回の問題が入る", () => {
    const p = testerPrompt(
      makeConfig(["screenshots: shots"]),
      ISSUE,
      ["AC1", "AC2"],
      ["AC2 のテストがありません"],
    );
    expect(p).toContain("AC1、AC2");
    expect(p).toContain("- e2e/**");
    expect(p).toContain("shots/issue-2/AC2.png");
    expect(p).toContain("文字列のまま");
    expect(p).toContain("- AC2 のテストがありません");
    expect(p).toContain("npm run e2e");
  });
});

describe("runTester", () => {
  it("書けたらコミット・push し、ハッシュを記録して Implementing へ移す", async () => {
    const s = setup([
      {
        output: approve(TESTS),
        write: {
          "e2e/cards.spec.ts": SPEC,
          "supabase/seed.sql": "insert ...",
          "src/app.ts": "勝手な実装",
          ".conductor/config.yaml": "改変",
        },
      },
    ]);
    const r = await runTester(s.deps, ISSUE);
    expect(r).toEqual({
      status: "committed",
      branch: "conductor/issue-2",
      commit: "c0ffee",
      hash: "h1",
    });
    // 保護対象の外は捨て、保護対象だけコミット
    expect(s.g.log).toContain("discard .conductor/config.yaml,src/app.ts");
    expect([...s.g.committed.keys()]).toEqual([
      "e2e/cards.spec.ts",
      "supabase/seed.sql",
    ]);
    expect(s.g.log).toContain("push conductor/issue-2");
    expect(s.g.log).toContain("hash e2e/**,supabase/seed.sql,.conductor/**");
    const rec = await s.store.get({ repo: "me/app", issue: 2 });
    expect(rec).toMatchObject({
      protectedHash: "h1",
      branch: "conductor/issue-2",
      checkpoint: { stage: "implementing" },
    });
    expect(s.b.moves).toEqual([[2, "Implementing"]]);
    expect(s.runs[0]!.systemPrompt).toContain("seed は SQL で書く");
    expect(s.runs[0]!.role).toBe("tester");
    // 許可リストの Edit は保護対象だけ
    const edits = s.runs[0]!.allow.filter((a) => a.startsWith("Edit(")).map(
      (a) => a.slice("Edit(./".length, -1),
    );
    expect(edits).toEqual(["e2e/**", "supabase/seed.sql"]);
    expect(matchesAny("src/app.ts", edits)).toBe(false);
  });

  it("AC が足りなければ問題を伝えて書き直させ、2回目で通す", async () => {
    const s = setup([
      { output: approve([TESTS[0]!]), write: { "e2e/cards.spec.ts": SPEC } },
      { output: approve(TESTS), write: { "e2e/cards.spec.ts": SPEC } },
    ]);
    const r = await runTester(s.deps, ISSUE);
    expect(r.status).toBe("committed");
    expect(s.runs).toHaveLength(2);
    expect(s.runs[1]!.prompt).toContain("AC2 のテストがありません");
    expect(s.g.log).toContain("discardAll");
  });

  it("実装役の異議で戻ったら、その指摘を最初の依頼から渡し続ける", async () => {
    const s = setup([
      { output: approve([TESTS[0]!]), write: { "e2e/cards.spec.ts": SPEC } },
      { output: approve(TESTS), write: { "e2e/cards.spec.ts": SPEC } },
    ]);
    await s.store.addSummary(
      { repo: "me/app", issue: 2 },
      {
        role: "implementer",
        verdict: "objection",
        text: "AC3 のデータが別の spec と衝突する\n\ne2e/a.spec.ts:9: apple-AC3 が重複",
      },
    );
    const r = await runTester(s.deps, ISSUE);
    expect(r.status).toBe("committed");
    for (const run of s.runs) {
      expect(run.prompt).toContain(
        "- 実装役の指摘: AC3 のデータが別の spec と衝突する",
      );
      expect(run.prompt).toContain(
        "- 実装役の指摘: e2e/a.spec.ts:9: apple-AC3 が重複",
      );
    }
    expect(s.runs[1]!.prompt).toContain("AC2 のテストがありません");
  });

  it("撮影の指定があるのに撮っていなければ問題にする", async () => {
    const bad = 'test("AC1: 空", () => {}); test("AC2: 追加", () => {});';
    const s = setup(
      [
        { output: approve(TESTS), write: { "e2e/cards.spec.ts": bad } },
        { output: approve(TESTS), write: { "e2e/cards.spec.ts": bad } },
      ],
      ["screenshots: shots"],
    );
    const r = await runTester(s.deps, ISSUE);
    expect(r.status).toBe("failed");
    if (r.status !== "failed") return;
    expect(r.problems).toContain(
      "e2e/cards.spec.ts に AC1 の撮影（AC1.png）がありません（パスを文字列のまま書いてください）",
    );
    expect(s.b.moves).toEqual([[2, "Blocked"]]);
    expect(s.b.comments[0]).toMatchObject({ issue: 2, mention: true });
  });

  it("2回とも書けなければ Blocked に移してコメントする", async () => {
    const s = setup([
      { output: approve(TESTS), write: { "src/app.ts": "x" } },
      { output: approve(TESTS), write: {} },
    ]);
    const r = await runTester(s.deps, ISSUE);
    expect(r.status).toBe("failed");
    expect(s.b.moves).toEqual([[2, "Blocked"]]);
    expect(s.b.comments[0]!.body).toContain(
      "保護対象のファイルが1つも書かれていません",
    );
    expect(s.b.comments[0]!.body).toContain("Ready 列に戻してください");
    expect(s.g.committed.size).toBe(0);
  });

  it("異議なら質問をコメントして Blocked に移し、回数を数える", async () => {
    const objection: TesterOutput = {
      verdict: "objection",
      summary: "AC2 の移動先が曖昧",
      findings: [],
      tests: [],
      questions: ["AC2 の「追加」ボタンはどこにありますか"],
    };
    const s = setup([
      { output: objection },
      { output: objection },
      { output: objection },
    ]);
    const r1 = await runTester(s.deps, ISSUE);
    expect(r1).toEqual({
      status: "objection",
      questions: ["AC2 の「追加」ボタンはどこにありますか"],
      objections: 1,
    });
    expect(s.b.comments[0]!.body).toContain(
      "- AC2 の「追加」ボタンはどこにありますか",
    );
    expect(s.b.moves).toEqual([[2, "Blocked"]]);

    await runTester(s.deps, ISSUE);
    const r3 = await runTester(s.deps, ISSUE);
    expect(r3).toMatchObject({ objections: 3 });
    expect(s.b.comments[2]!.body).toContain("異議が上限（2 回）を超えた");

    // 上限を超えたら役を起動しない
    const r4 = await runTester(s.deps, ISSUE);
    expect(r4).toEqual({ status: "waiting" });
    expect(s.runs).toHaveLength(3);
  });

  it("commands.format が無ければ整形しない", async () => {
    const s = setup([
      { output: approve(TESTS), write: { "e2e/cards.spec.ts": SPEC } },
    ]);
    await runTester(s.deps, ISSUE);
    expect(s.shellCalls).toEqual([]);
  });

  it("commands.format があれば整形してからコミットし、保護対象の外の変更は捨てる", async () => {
    const s = setup(
      [{ output: approve(TESTS), write: { "e2e/cards.spec.ts": SPEC } }],
      [
        "commands: { setup: s, test: a, acceptance: e, typecheck: d, build: b, format: npm run format }",
      ],
      (files) => {
        files.set("e2e/cards.spec.ts", `${SPEC}\n// 整形済み`);
        files.set("src/other.ts", "ついでに整形");
        return 0;
      },
    );
    const r = await runTester(s.deps, ISSUE);
    expect(r.status).toBe("committed");
    expect(s.shellCalls).toEqual(["npm run format"]);
    expect(s.g.committed.get("e2e/cards.spec.ts")).toContain("// 整形済み");
    expect([...s.g.committed.keys()]).toEqual(["e2e/cards.spec.ts"]);
    expect(s.g.log).toContain("discard src/other.ts");
  });

  it("整形が失敗したら問題として書き直させる", async () => {
    let n = 0;
    const s = setup(
      [
        { output: approve(TESTS), write: { "e2e/cards.spec.ts": SPEC } },
        { output: approve(TESTS), write: { "e2e/cards.spec.ts": SPEC } },
      ],
      [
        "commands: { setup: s, test: a, acceptance: e, typecheck: d, build: b, format: npm run format }",
      ],
      () => (++n === 1 ? 2 : 0),
    );
    const r = await runTester(s.deps, ISSUE);
    expect(r.status).toBe("committed");
    expect(s.runs).toHaveLength(2);
    expect(s.runs[1]!.prompt).toContain("整形（npm run format）が失敗しました");
    expect(s.runs[1]!.prompt).toContain("SyntaxError: x");
  });

  it("Issue に無い AC のテストは問題にする", async () => {
    const extra = [
      ...TESTS,
      { ac: "AC9", file: "e2e/cards.spec.ts", title: "AC9" },
    ];
    const s = setup([
      { output: approve(extra), write: { "e2e/cards.spec.ts": SPEC + "AC9" } },
      { output: approve(extra), write: { "e2e/cards.spec.ts": SPEC + "AC9" } },
    ]);
    const r = await runTester(s.deps, ISSUE);
    expect(r.status === "failed" && r.problems).toContain(
      "Issue に無い AC9 のテストがあります",
    );
  });
});

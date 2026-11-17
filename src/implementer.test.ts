import { describe, expect, it } from "vitest";
import type { RoleRun } from "./claude.js";
import { parseConfig } from "./config.js";
import type { ExecResult } from "./exec.js";
import {
  implementerAllow,
  implementerDeny,
  implementerPrompt,
  outputTail,
  runImplementer,
  type ImplementerDeps,
  type ImplementerOutput,
  type implementerOutputSchema,
} from "./implementer.js";
import { pendingFindings, recordRejection } from "./rejection.js";
import { MemoryStore } from "./store.js";

const BODY = `### 受け入れ条件（AC）

- AC1
  - Given カードが無い
  - When /cards を開く
  - Then 「カードがありません」と出る
`;
const ISSUE = { number: 2, title: "カード一覧", body: BODY };
const KEY = { repo: "me/app", issue: 2 };

function makeConfig(format?: string) {
  const fmt = format ? `, format: ${format}` : "";
  return parseConfig(
    [
      "github: { repo: me/app, project: 3, notify: me }",
      "protected: [e2e/**, supabase/seed.sql]",
      `commands: { setup: npm run db:reset, test: npm test, acceptance: npm run e2e, typecheck: npm run typecheck, build: npm run build${fmt} }`,
    ].join("\n"),
  );
}

type Step = {
  output: ImplementerOutput;
  write?: Record<string, string>;
  /** 実装役が自分でコミットして保護対象を変えた */
  breakHash?: boolean;
};

function setup(
  steps: Step[],
  options: {
    failing?: string;
    noRecord?: boolean;
    /** 整形の偽物。作業中のファイルを書き換え、終了コードを返す */
    format?: (files: Map<string, string>) => number;
  } = {},
) {
  const config = makeConfig(options.format ? "npm run format" : undefined);
  const store = new MemoryStore(() => new Date("2026-11-15T00:00:00Z"));
  const files = new Map<string, string>();
  const log: string[] = [];
  let hash = "h1";
  const moves: [number, string][] = [];
  const comments: { issue: number; body: string; mention?: boolean }[] = [];
  const created: { head: string; title: string; body: string }[] = [];
  const commands: string[] = [];
  const runs: RoleRun<typeof implementerOutputSchema>[] = [];
  let existingPr: { number: number; url: string } | undefined;

  const deps: ImplementerDeps = {
    config,
    repoDir: "/repo",
    store,
    instructions: "Next.js の App Router で書く",
    git: {
      startBranch: (b, base) => {
        log.push(`branch ${b} from ${base}`);
        hash = "h1";
        return Promise.resolve();
      },
      changedFiles: () => Promise.resolve([...files.keys()].sort()),
      discard: (paths) => {
        for (const p of paths) files.delete(p);
        log.push(`discard ${paths.join(",")}`);
        return Promise.resolve();
      },
      discardAll: () => {
        files.clear();
        log.push("discardAll");
        return Promise.resolve();
      },
      commit: (paths, message) => {
        for (const p of paths) files.delete(p);
        log.push(`commit ${paths.join(",")} ${message}`);
        return Promise.resolve("c0ffee");
      },
      push: (b) => {
        log.push(`push ${b}`);
        return Promise.resolve();
      },
      treeHash: (_ref, globs) => {
        log.push(`hash ${globs.join(",")}`);
        return Promise.resolve(hash);
      },
    },
    board: {
      moveIssue: (issue, column) => {
        moves.push([issue, column]);
        return Promise.resolve();
      },
      comment: (issue, body, o) => {
        comments.push({ issue, body, ...o });
        return Promise.resolve();
      },
      findPullRequest: () => Promise.resolve(existingPr),
      createPullRequest: (input) => {
        created.push(input);
        return Promise.resolve({ number: 7, url: "https://x/pull/7" });
      },
    },
    shell: (cmd): Promise<ExecResult> => {
      commands.push(cmd);
      if (cmd === "npm run format" && options.format) {
        const code = options.format(files);
        return Promise.resolve({
          code,
          stdout: "",
          stderr: code ? "SyntaxError: x" : "",
        });
      }
      return Promise.resolve(
        cmd === options.failing
          ? { code: 1, stdout: "\u001b[31m1 failed\u001b[0m\n", stderr: "" }
          : { code: 0, stdout: "ok", stderr: "" },
      );
    },
    run: (run) => {
      runs.push(run);
      const step = steps[runs.length - 1]!;
      for (const [f, t] of Object.entries(step.write ?? {})) files.set(f, t);
      if (step.breakHash) hash = "changed";
      return Promise.resolve({
        output: step.output,
        denials: [],
        costUsd: 0,
        turns: 1,
        sessionId: "s",
      });
    },
  };
  const init = async () => {
    if (!options.noRecord) {
      await store.update(KEY, {
        branch: "conductor/issue-2",
        protectedHash: "h1",
        checkpoint: { stage: "implementing" },
      });
    }
  };
  return {
    deps,
    store,
    files,
    log,
    moves,
    comments,
    created,
    commands,
    runs,
    init,
    setPr: (pr: { number: number; url: string }) => (existingPr = pr),
  };
}

const approve: ImplementerOutput = {
  verdict: "approve",
  summary: "一覧画面を作りました",
  findings: [],
};

describe("許可・禁止と依頼文", () => {
  it("書き換えは許すが、受け入れテスト・seed・.conductor/ は禁止する", () => {
    const config = makeConfig();
    const allow = implementerAllow(config);
    expect(allow).toContain("Edit");
    expect(allow).toContain("Write");
    expect(allow).toContain("Bash(npm run e2e)");
    expect(allow).toContain("Bash(npm test *)");
    expect(implementerDeny(config)).toEqual([
      "Edit(./e2e/**)",
      "Edit(./supabase/seed.sql)",
      "Edit(./.conductor/**)",
    ]);
  });

  it("依頼文に AC・禁止のファイル・確認のコマンド・指摘が入る", () => {
    const p = implementerPrompt(makeConfig(), ISSUE, ["CI が失敗\n詳細"]);
    expect(p).toContain("AC1 の受け入れテストを通してください");
    expect(p).toContain("- .conductor/**");
    expect(p).toContain("- 準備: npm run db:reset");
    expect(p).toContain("- 受け入れテスト: npm run e2e");
    expect(p).toContain("- CI が失敗\n  詳細");
  });

  it("出力の末尾から色を外す", () => {
    const tail = outputTail(
      { code: 1, stdout: "a\n\u001b[31mb\u001b[0m", stderr: "c" },
      2,
    );
    expect(tail).toBe("b\nc");
  });
});

describe("runImplementer", () => {
  it("AC1: 実装をコミットし、ローカルで確認してから PR を作る", async () => {
    const s = setup([
      { output: approve, write: { "src/app/cards/page.tsx": "x" } },
    ]);
    await s.init();
    const r = await runImplementer(s.deps, ISSUE);
    expect(r).toEqual({ status: "submitted", pr: 7, url: "https://x/pull/7" });
    expect(s.log).toContain("branch conductor/issue-2 from conductor/issue-2");
    expect(s.log).toContain("commit src/app/cards/page.tsx feat: #2 の実装");
    expect(s.log).toContain("push conductor/issue-2");
    expect(s.commands).toEqual([
      "npm run db:reset",
      "npm run typecheck",
      "npm test",
      "npm run e2e",
    ]);
    expect(s.created[0]).toMatchObject({
      head: "conductor/issue-2",
      title: "カード一覧",
    });
    expect(s.created[0]!.body).toContain("一覧画面を作りました");
    expect(await s.store.get(KEY)).toMatchObject({
      pr: 7,
      checkpoint: { stage: "ci" },
    });
    expect(s.moves.at(-1)).toEqual([2, "Reviewing"]);
    const run = s.runs[0]!;
    expect(run.role).toBe("implementer");
    expect(run.deny).toContain("Edit(./e2e/**)");
    expect(run.systemPrompt).toContain("App Router");
  });

  it("commands.format があれば整形してからコミットし、整形で変わった保護対象は黙って戻す", async () => {
    const s = setup([{ output: approve, write: { "src/a.ts": "x" } }], {
      format: (files) => {
        files.set("src/a.ts", "x // 整形済み");
        files.set("src/b.ts", "ついでに整形");
        files.set("e2e/cards.spec.ts", "整形で変わった");
        return 0;
      },
    });
    await s.init();
    const r = await runImplementer(s.deps, ISSUE);
    expect(r).toEqual({ status: "submitted", pr: 7, url: "https://x/pull/7" });
    expect(s.commands[0]).toBe("npm run format");
    expect(s.log).toContain("discard e2e/cards.spec.ts");
    expect(s.log).toContain("commit src/a.ts,src/b.ts feat: #2 の実装");
    expect(s.log.indexOf("discard e2e/cards.spec.ts")).toBeLessThan(
      s.log.findIndex((l) => l.startsWith("commit")),
    );
  });

  it("実装役が変えた保護対象は、整形があっても差し戻しの対象になる", async () => {
    const s = setup(
      [
        {
          output: approve,
          write: { "e2e/x.spec.ts": "改変", "src/a.ts": "x" },
        },
      ],
      { format: () => 0 },
    );
    await s.init();
    const r = await runImplementer(s.deps, ISSUE);
    expect(r.status).toBe("rejected");
    if (r.status !== "rejected") return;
    expect(r.findings).toEqual([
      "変えてはいけないファイルを変えたので戻しました: e2e/x.spec.ts",
    ]);
  });

  it("整形が失敗したら、変更は push したうえで出力の末尾を指摘にして差し戻す", async () => {
    const s = setup([{ output: approve, write: { "src/a.ts": "x" } }], {
      format: () => 2,
    });
    await s.init();
    const r = await runImplementer(s.deps, ISSUE);
    expect(r.status).toBe("rejected");
    if (r.status !== "rejected") return;
    expect(r.findings[0]).toContain("整形（npm run format）が失敗しました");
    expect(r.findings[0]).toContain("SyntaxError: x");
    expect(s.log).toContain("push conductor/issue-2");
    expect(s.commands).toEqual(["npm run format"]);
  });

  it("変更が無ければ整形しない", async () => {
    const s = setup([{ output: approve }], { format: () => 0 });
    await s.init();
    await runImplementer(s.deps, ISSUE);
    expect(s.commands).not.toContain("npm run format");
  });

  it("PR が既にあれば作らずに使う", async () => {
    const s = setup([{ output: approve, write: { "src/a.ts": "x" } }]);
    await s.init();
    s.setPr({ number: 5, url: "u5" });
    const r = await runImplementer(s.deps, ISSUE);
    expect(r).toEqual({ status: "submitted", pr: 5, url: "u5" });
    expect(s.created).toHaveLength(0);
  });

  it("AC2: 受け入れテストを変えたら戻して差し戻す（他の変更は push して残す）", async () => {
    const s = setup([
      {
        output: approve,
        write: { "e2e/cards.spec.ts": "改変", "src/a.ts": "x" },
      },
    ]);
    await s.init();
    const r = await runImplementer(s.deps, ISSUE);
    expect(r.status).toBe("rejected");
    expect(s.log).toContain("discard e2e/cards.spec.ts");
    expect(s.log).toContain("commit src/a.ts feat: #2 の実装");
    expect(s.log).toContain("push conductor/issue-2");
    expect(s.commands).toEqual([]);
    expect(s.created).toHaveLength(0);
    const rec = await s.store.get(KEY);
    expect(rec?.rejections).toBe(1);
    expect(await pendingFindings(s.store, KEY)).toEqual([
      "変えてはいけないファイルを変えたので戻しました: e2e/cards.spec.ts",
    ]);
    expect(s.comments[0]!.body).toContain("1/3 回目");
  });

  it("AC2: コミットの時点でハッシュが違えば、すべて戻して差し戻す", async () => {
    const s = setup([{ output: approve, breakHash: true }]);
    await s.init();
    const r = await runImplementer(s.deps, ISSUE);
    expect(r.status).toBe("rejected");
    expect(s.log.filter((l) => l.startsWith("branch"))).toHaveLength(2);
    expect(s.log).not.toContain("push conductor/issue-2");
  });

  it("ローカルの確認に失敗したら、出力の末尾を指摘にして差し戻す", async () => {
    const s = setup([{ output: approve, write: { "src/a.ts": "x" } }], {
      failing: "npm test",
    });
    await s.init();
    const r = await runImplementer(s.deps, ISSUE);
    expect(r.status).toBe("rejected");
    if (r.status !== "rejected") return;
    expect(r.findings[0]).toBe(
      "テスト（npm test）が失敗しました（終了コード 1）:\n1 failed",
    );
    expect(s.commands).toEqual([
      "npm run db:reset",
      "npm run typecheck",
      "npm test",
    ]);
    expect(s.log).toContain("push conductor/issue-2");
  });

  it("AC3: 指摘は新しいセッションの依頼文に渡る", async () => {
    const s = setup([{ output: approve, write: { "src/a.ts": "x" } }]);
    await s.init();
    await runImplementer(s.deps, ISSUE, ["AC1 の文言が違う"]);
    expect(s.runs[0]!.prompt).toContain("- AC1 の文言が違う");
  });

  it("AC3: 差し戻しが上限を超えたら Blocked にしてメンションし、以後は動かない", async () => {
    const s = setup([
      { output: approve, write: { "e2e/x.spec.ts": "x" } },
      { output: approve, write: { "e2e/x.spec.ts": "x" } },
    ]);
    await s.init();
    await s.store.update(KEY, { rejections: 3 });
    const r = await runImplementer(s.deps, ISSUE);
    expect(r).toMatchObject({
      status: "rejected",
      rejections: 4,
      blocked: true,
    });
    expect(s.moves.at(-1)).toEqual([2, "Blocked"]);
    expect(s.comments.at(-1)).toMatchObject({ mention: true });
    expect(s.comments.at(-1)!.body).toContain("上限（3 回）");
    expect(await runImplementer(s.deps, ISSUE)).toEqual({ status: "waiting" });
    expect(s.runs).toHaveLength(1);
  });

  it("異議なら変更を捨てて Blocked にし、メンションする", async () => {
    const s = setup([
      {
        output: {
          verdict: "objection",
          summary: "AC1 とテストの文言が違う",
          findings: [
            { file: "e2e/cards.spec.ts", line: 3, message: "「ありません」" },
          ],
        },
        write: { "src/a.ts": "x" },
      },
    ]);
    await s.init();
    const r = await runImplementer(s.deps, ISSUE);
    expect(r).toEqual({ status: "objection", objections: 1 });
    expect(s.files.size).toBe(0);
    expect(s.moves.at(-1)).toEqual([2, "Blocked"]);
    expect(s.comments[0]!.body).toContain(
      "e2e/cards.spec.ts:3: 「ありません」",
    );
    expect(s.comments[0]!.mention).toBe(true);
  });

  it("テスト役の記録（ハッシュ）が無ければ動かない", async () => {
    const s = setup([{ output: approve }], { noRecord: true });
    await s.init();
    expect(await runImplementer(s.deps, ISSUE)).toEqual({ status: "waiting" });
    expect(s.runs).toHaveLength(0);
  });
});

describe("recordRejection / pendingFindings", () => {
  it("CI などの差し戻しも合算し、最後の記録が差し戻しのときだけ指摘を返す", async () => {
    const s = setup([]);
    await s.init();
    const r = await recordRejection(s.deps, 2, "ci", "CI", [
      "lint が失敗",
      "型が違う",
    ]);
    expect(r).toEqual({ rejections: 1, blocked: false });
    expect(s.moves).toEqual([[2, "Implementing"]]);
    expect(s.comments[0]!.body).toContain("CIで差し戻しました（1/3 回目）");
    expect(await pendingFindings(s.store, KEY)).toEqual([
      "lint が失敗",
      "型が違う",
    ]);
    await s.store.addSummary(KEY, {
      role: "implementer",
      verdict: "approve",
      text: "直した",
    });
    expect(await pendingFindings(s.store, KEY)).toEqual([]);
  });
});

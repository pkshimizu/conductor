import { describe, expect, it } from "vitest";
import type { Exec, ExecResult } from "./exec.js";
import { parseConfig } from "./config.js";
import {
  GitHub,
  githubFromConfig,
  summarizeChecks,
  tailLog,
  untilLastError,
} from "./github.js";

type Handler = (args: string[], input: string) => ExecResult | undefined;

/** gh の偽物。呼び出しを記録し、handler の答えを返す */
function fakeGh(handler: Handler) {
  const calls: { args: string[]; input: string }[] = [];
  const exec: Exec = (args, { input }) => {
    calls.push({ args, input: input ?? "" });
    const r = handler(args, input ?? "");
    if (!r) throw new Error(`想定外の呼び出し: ${args.join(" ")} ${input}`);
    return Promise.resolve(r);
  };
  const gh = new GitHub({
    repo: "me/app",
    project: 3,
    notify: "me",
    exec,
  });
  return { gh, calls };
}

const ok = (data: unknown): ExecResult => ({
  code: 0,
  stdout: JSON.stringify(data),
  stderr: "",
});

const META = {
  user: {
    projectV2: {
      id: "P1",
      field: {
        id: "F1",
        options: [
          { id: "o-ready", name: "Ready" },
          { id: "o-test", name: "Testing" },
          { id: "o-done", name: "Done" },
        ],
      },
    },
  },
};

function query(input: string): {
  query: string;
  variables: Record<string, unknown>;
} {
  return JSON.parse(input);
}

function issueNode(n: number, extra: Record<string, unknown> = {}) {
  return {
    number: n,
    title: `t${n}`,
    body: `b${n}`,
    state: "OPEN",
    repository: { nameWithOwner: "me/app" },
    labels: { nodes: [{ name: "bug" }] },
    ...extra,
  };
}

describe("AC1: 列ごとの Issue", () => {
  it("このリポジトリの開いた Issue だけを、列つきで全ページ取る", async () => {
    const { gh } = fakeGh((_, input) => {
      const { query: q, variables } = query(input);
      if (q.includes("projectV2(number")) return ok({ data: META });
      if (q.includes("items(first")) {
        const first = variables.after === null;
        return ok({
          data: {
            node: {
              items: {
                pageInfo: { hasNextPage: first, endCursor: "c1" },
                nodes: first
                  ? [
                      {
                        fieldValueByName: { name: "Ready" },
                        content: issueNode(1),
                      },
                      {
                        fieldValueByName: { name: "Ready" },
                        content: issueNode(2, {
                          repository: { nameWithOwner: "me/other" },
                        }),
                      },
                      { fieldValueByName: null, content: {} }, // 下書き
                    ]
                  : [
                      {
                        fieldValueByName: { name: "Testing" },
                        content: issueNode(3),
                      },
                      {
                        fieldValueByName: { name: "Done" },
                        content: issueNode(4, { state: "CLOSED" }),
                      },
                      { fieldValueByName: null, content: issueNode(5) },
                    ],
              },
            },
          },
        });
      }
      return undefined;
    });
    const byColumn = await gh.issuesByColumn();
    expect([...byColumn.keys()]).toEqual(["Ready", "Testing", ""]);
    expect(byColumn.get("Ready")).toEqual([
      { number: 1, title: "t1", body: "b1", labels: ["bug"], column: "Ready" },
    ]);
    expect(byColumn.get("Testing")?.map((i) => i.number)).toEqual([3]);
  });

  it("includeClosed なら閉じた Issue も取り、更新日時を付ける", async () => {
    const { gh } = fakeGh((_, input) => {
      const { query: q } = query(input);
      if (q.includes("projectV2(number")) return ok({ data: META });
      if (q.includes("items(first")) {
        expect(q).toContain("updatedAt");
        return ok({
          data: {
            node: {
              items: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    fieldValueByName: { name: "Ready" },
                    content: issueNode(1, {
                      updatedAt: "2026-11-20T00:00:00Z",
                    }),
                  },
                  {
                    fieldValueByName: { name: "Done" },
                    content: issueNode(4, { state: "CLOSED" }),
                  },
                ],
              },
            },
          },
        });
      }
      return undefined;
    });
    const byColumn = await gh.issuesByColumn({ includeClosed: true });
    expect(byColumn.get("Ready")?.[0]?.updatedAt).toBe("2026-11-20T00:00:00Z");
    expect(byColumn.get("Done")?.map((i) => i.number)).toEqual([4]);
    expect((await gh.issuesByColumn()).get("Done")).toBeUndefined();
  });

  it("Projects が無ければ分かるエラーにする", async () => {
    const { gh } = fakeGh(() =>
      ok({ data: { user: null }, errors: [{ message: "not found" }] }),
    );
    await expect(gh.listIssues()).rejects.toThrow(
      "Projects #3（me）が見つかりません",
    );
  });
});

describe("AC2: 列の移動とコメント", () => {
  function moveHandler(items: { id: string; project: { id: string } }[]) {
    return (_: string[], input: string) => {
      const { query: q } = query(input);
      if (q.includes("projectV2(number")) return ok({ data: META });
      if (q.includes("projectItems"))
        return ok({
          data: {
            repository: {
              issue: { id: "I7", projectItems: { nodes: items } },
            },
          },
        });
      if (q.includes("addProjectV2ItemById"))
        return ok({
          data: { addProjectV2ItemById: { item: { id: "new-item" } } },
        });
      if (q.includes("updateProjectV2ItemFieldValue"))
        return ok({ data: { updateProjectV2ItemFieldValue: {} } });
      return undefined;
    };
  }

  it("列の選択肢 ID で状態欄を書き換える", async () => {
    const { gh, calls } = fakeGh(
      moveHandler([
        { id: "other", project: { id: "P9" } },
        { id: "item7", project: { id: "P1" } },
      ]),
    );
    await gh.moveIssue(7, "Testing");
    const move = query(calls.at(-1)!.input);
    expect(move.variables).toEqual({
      project: "P1",
      item: "item7",
      field: "F1",
      option: "o-test",
    });
  });

  it("Projects に無い Issue は追加してから移す", async () => {
    const { gh, calls } = fakeGh(moveHandler([]));
    await gh.moveIssue(7, "Ready");
    expect(query(calls.at(-2)!.input).variables).toEqual({
      project: "P1",
      content: "I7",
    });
    expect(query(calls.at(-1)!.input).variables.item).toBe("new-item");
  });

  it("無い列名はエラー", async () => {
    const { gh } = fakeGh(moveHandler([]));
    await expect(gh.moveIssue(7, "Blocked")).rejects.toThrow(
      "Projects の Status に「Blocked」がありません",
    );
  });

  it("コメントは本文を標準入力で渡す。メンションも付けられる", async () => {
    const { gh, calls } = fakeGh(() => ok({ id: 1 }));
    await gh.comment(7, "進めます");
    await gh.comment(7, "止まりました", { mention: true });
    expect(calls[0]!.args).toEqual([
      "api",
      "repos/me/app/issues/7/comments",
      "--method",
      "POST",
      "--input",
      "-",
    ]);
    expect(JSON.parse(calls[0]!.input)).toEqual({ body: "進めます" });
    expect(JSON.parse(calls[1]!.input)).toEqual({ body: "@me 止まりました" });
  });
});

describe("AC3: PR", () => {
  it("既定ブランチに向けて Closes #番号 付きの PR を作る", async () => {
    const { gh, calls } = fakeGh((args) => {
      if (args[1] === "repos/me/app") return ok({ default_branch: "main" });
      if (args[1] === "repos/me/app/pulls")
        return ok({ number: 12, html_url: "https://x/pull/12" });
      return undefined;
    });
    const pr = await gh.createPullRequest({
      issue: 7,
      head: "conductor/7",
      title: "単語を追加する",
      body: "説明\n",
    });
    expect(pr).toEqual({ number: 12, url: "https://x/pull/12" });
    expect(JSON.parse(calls[1]!.input)).toEqual({
      title: "単語を追加する",
      head: "conductor/7",
      base: "main",
      body: "説明\n\nCloses #7\n",
    });
  });

  it("issue を渡さなければ Closes を付けない（仕様の PR）", async () => {
    const { gh, calls } = fakeGh((args) => {
      if (args[1] === "repos/me/app") return ok({ default_branch: "main" });
      if (args[1] === "repos/me/app/pulls")
        return ok({ number: 13, html_url: "https://x/pull/13" });
      return undefined;
    });
    await gh.createPullRequest({
      head: "conductor/spec-1",
      title: "仕様: 検索",
      body: "要約\n",
    });
    expect(JSON.parse(calls[1]!.input)).toEqual({
      title: "仕様: 検索",
      head: "conductor/spec-1",
      base: "main",
      body: "要約\n",
    });
  });

  it("ブランチの開いた PR を探す", async () => {
    const { gh, calls } = fakeGh(() => ok([]));
    expect(await gh.findPullRequest("conductor/7")).toBeUndefined();
    expect(calls[0]!.args[1]).toBe(
      "repos/me/app/pulls?state=open&head=me%3Aconductor%2F7",
    );
  });
});

describe("分解役に使う API", () => {
  it("PR で変えたファイルを全ページ取る", async () => {
    const { gh, calls } = fakeGh((args) => {
      const page = /page=(\d+)$/.exec(args[1] ?? "")?.[1];
      if (page === "1")
        return ok(
          Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}` })),
        );
      if (page === "2") return ok([{ filename: "docs/specs/a.md" }]);
      return undefined;
    });
    const files = await gh.pullRequestFiles(5);
    expect(files).toHaveLength(101);
    expect(files.at(-1)).toBe("docs/specs/a.md");
    expect(calls[0]!.args[1]).toBe(
      "repos/me/app/pulls/5/files?per_page=100&page=1",
    );
  });

  it("Issue を作る", async () => {
    const { gh, calls } = fakeGh((args) => {
      if (args[1] === "repos/me/app/issues")
        return ok({ number: 21, html_url: "https://x/issues/21" });
      return undefined;
    });
    expect(await gh.createIssue({ title: "T", body: "B" })).toEqual({
      number: 21,
      url: "https://x/issues/21",
    });
    expect(JSON.parse(calls[0]!.input)).toEqual({ title: "T", body: "B" });
  });

  it("Project に追加するだけで、列は動かさない", async () => {
    const { gh, calls } = fakeGh((_, input) => {
      const { query: q } = query(input);
      if (q.includes("projectV2(number")) return ok({ data: META });
      if (q.includes("projectItems"))
        return ok({
          data: {
            repository: { issue: { id: "I7", projectItems: { nodes: [] } } },
          },
        });
      if (q.includes("addProjectV2ItemById"))
        return ok({ data: { addProjectV2ItemById: { item: { id: "n" } } } });
      return undefined;
    });
    await gh.addToProject(7);
    expect(query(calls.at(-1)!.input).variables).toEqual({
      project: "P1",
      content: "I7",
    });
    expect(
      calls.some((c) => c.input.includes("updateProjectV2ItemFieldValue")),
    ).toBe(false);
  });
});

describe("着手と完了に使う API", () => {
  function statusHandler(issue: unknown) {
    return (_: string[], input: string) => {
      const { query: q } = query(input);
      if (q.includes("projectV2(number")) return ok({ data: META });
      if (q.includes("closedByPullRequestsReferences"))
        return ok({ data: { repository: { issue } } });
      return undefined;
    };
  }

  it("この Project の列・本文・マージ済みの PR を返す", async () => {
    const { gh, calls } = fakeGh(
      statusHandler({
        body: "本文",
        projectItems: {
          nodes: [
            { project: { id: "P9" }, fieldValueByName: { name: "Testing" } },
            { project: { id: "P1" }, fieldValueByName: { name: "Done" } },
          ],
        },
        closedByPullRequestsReferences: {
          nodes: [
            { number: 30, url: "https://x/pull/30", merged: false },
            { number: 31, url: "https://x/pull/31", merged: true },
          ],
        },
      }),
    );
    expect(await gh.workIssueStatus(7)).toEqual({
      body: "本文",
      column: "Done",
      merged: { number: 31, url: "https://x/pull/31" },
    });
    expect(query(calls.at(-1)!.input).variables).toEqual({
      owner: "me",
      name: "app",
      number: 7,
      field: "Status",
    });
  });

  it("列が未設定でマージ済みの PR が無ければ、どちらも返さない", async () => {
    const { gh } = fakeGh(
      statusHandler({
        body: "本文",
        projectItems: {
          nodes: [{ project: { id: "P1" }, fieldValueByName: null }],
        },
        closedByPullRequestsReferences: { nodes: [] },
      }),
    );
    expect(await gh.workIssueStatus(7)).toEqual({ body: "本文" });
  });

  it("Issue が無ければ失敗する", async () => {
    const { gh } = fakeGh(statusHandler(null));
    await expect(gh.workIssueStatus(7)).rejects.toThrow("#7");
  });
});

describe("AC4: CI", () => {
  const checks = (...buckets: string[]) =>
    buckets.map((bucket, i) => ({
      name: `c${i}`,
      bucket,
      link: `https://github.com/me/app/actions/runs/1/job/${100 + i}`,
    }));

  it("成功・失敗・実行中を区別する", () => {
    expect(summarizeChecks(checks("pass", "skipping"))).toBe("success");
    expect(summarizeChecks(checks("pass", "pending"))).toBe("pending");
    expect(summarizeChecks(checks("pending", "fail"))).toBe("failure");
    expect(summarizeChecks(checks("cancel"))).toBe("failure");
    expect(summarizeChecks([])).toBe("pending");
  });

  it("終了コードが 0 以外でも出力から判断する", async () => {
    const { gh } = fakeGh(() => ({
      code: 8,
      stdout: JSON.stringify(checks("pending")),
      stderr: "",
    }));
    expect((await gh.ciStatus(12)).state).toBe("pending");
  });

  it("チェックがまだ無ければ実行中", async () => {
    const { gh } = fakeGh(() => ({
      code: 1,
      stdout: "",
      stderr: "no checks reported on the 'x' branch",
    }));
    expect(await gh.ciStatus(12)).toEqual({ state: "pending", checks: [] });
  });

  it("失敗したらジョブのログの要点を取る", async () => {
    const { gh, calls } = fakeGh((args) => {
      if (args[0] === "pr")
        return {
          code: 1,
          stdout: JSON.stringify(checks("pass", "fail")),
          stderr: "",
        };
      if (args[0] === "run")
        return {
          code: 0,
          stdout:
            "check\tRun npm test\t2026-11-15T01:02:03.4567890Z \x1b[31mFAIL\x1b[0m src/a.test.ts\n" +
            "check\tRun npm test\t2026-11-15T01:02:04.0000000Z expected 1 to be 2\n",
          stderr: "",
        };
      return undefined;
    });
    const r = await gh.ciStatus(12);
    expect(r.state).toBe("failure");
    expect(r.failureLog).toBe("## c1\nFAIL src/a.test.ts\nexpected 1 to be 2");
    expect(calls[1]!.args).toEqual([
      "run",
      "view",
      "--job",
      "101",
      "--log-failed",
      "-R",
      "me/app",
    ]);
  });

  it("run が実行中で --log-failed が使えなければ、API でジョブのログを取る", async () => {
    const { gh, calls } = fakeGh((args) => {
      if (args[0] === "pr")
        return {
          code: 1,
          stdout: JSON.stringify(checks("pass", "fail")),
          stderr: "",
        };
      if (args[0] === "run")
        return {
          code: 1,
          stdout: "",
          stderr:
            "run 1 is still in progress; logs will be available when it is complete",
        };
      if (args[0] === "api")
        return {
          code: 0,
          stdout:
            "2026-11-15T01:02:03.0000000Z Error: env が無い\n" +
            "2026-11-15T01:02:03.1000000Z ##[error]Process completed with exit code 1.\n" +
            "2026-11-15T01:02:04.0000000Z Post job cleanup.\n",
          stderr: "",
        };
      return undefined;
    });
    const r = await gh.ciStatus(12);
    expect(r.failureLog).toBe(
      "## c1\nError: env が無い\n##[error]Process completed with exit code 1.",
    );
    expect(calls[2]!.args).toEqual([
      "api",
      "--allow-escape-sequences",
      "repos/me/app/actions/jobs/101/logs",
    ]);
  });

  it("##[error] が無ければログをそのまま残す", () => {
    expect(untilLastError("a\nb")).toBe("a\nb");
  });

  it("ログは末尾だけ残す", () => {
    const log = Array.from({ length: 10 }, (_, i) => `j\ts\tline${i}`).join(
      "\n",
    );
    expect(tailLog(log, 2)).toBe("line8\nline9");
  });
});

describe("AC5: マージ", () => {
  it("squash でマージし、Issue を完了列に移す", async () => {
    const { gh, calls } = fakeGh((args, input) => {
      if (args[0] === "pr") return { code: 0, stdout: "", stderr: "" };
      const { query: q } = query(input);
      if (q.includes("projectV2(number")) return ok({ data: META });
      if (q.includes("projectItems"))
        return ok({
          data: {
            repository: {
              issue: {
                id: "I7",
                projectItems: {
                  nodes: [{ id: "item7", project: { id: "P1" } }],
                },
              },
            },
          },
        });
      return ok({ data: {} });
    });
    await gh.merge(12, 7, "Done");
    expect(calls[0]!.args).toEqual([
      "pr",
      "merge",
      "12",
      "--squash",
      "-R",
      "me/app",
    ]);
    expect(query(calls.at(-1)!.input).variables.option).toBe("o-done");
  });

  it("マージできなければエラーにし、列は動かさない", async () => {
    const { gh, calls } = fakeGh(() => ({
      code: 1,
      stdout: "",
      stderr: "Required status check is expected",
    }));
    await expect(gh.merge(12, 7, "Done")).rejects.toThrow(
      "PR #12 をマージできませんでした",
    );
    // マージ済みかを確かめる呼び出しだけで、列を動かす GraphQL は呼ばない
    expect(calls.map((c) => c.args.slice(0, 2))).toEqual([
      ["pr", "merge"],
      ["api", "repos/me/app/pulls/12"],
    ]);
  });

  it("マージ済みの PR は成功として扱う", async () => {
    const { gh } = fakeGh((args) => {
      if (args[0] === "pr")
        return {
          code: 1,
          stdout: "",
          stderr: "Pull request is already merged",
        };
      if (args[1] === "repos/me/app/pulls/12") return ok({ merged: true });
      return undefined;
    });
    await expect(gh.mergePullRequest(12)).resolves.toBeUndefined();
  });

  it("マージされていない PR のマージの失敗はエラーにする", async () => {
    const { gh } = fakeGh((args) => {
      if (args[0] === "pr")
        return { code: 1, stdout: "", stderr: "Required status check" };
      if (args[1] === "repos/me/app/pulls/12") return ok({ merged: false });
      return undefined;
    });
    await expect(gh.mergePullRequest(12)).rejects.toThrow(
      "PR #12 をマージできませんでした",
    );
  });
});

describe("設定から作る", () => {
  it("github の repo・project・notify を使う", async () => {
    const config = parseConfig(
      [
        "github: { repo: me/app, project: 3, notify: me }",
        "protected: [e2e/**]",
        "commands: { setup: a, test: b, acceptance: c, typecheck: d, build: e }",
      ].join("\n"),
    );
    const calls: string[] = [];
    const gh = githubFromConfig(config, (_, { input }) => {
      calls.push(input ?? "");
      return Promise.resolve({ code: 0, stdout: "{}", stderr: "" });
    });
    expect(gh.repo).toBe("me/app");
    await gh.comment(1, "x", { mention: true });
    expect(JSON.parse(calls[0]!)).toEqual({ body: "@me x" });
  });
});

describe("マージの承認に使う API", () => {
  it("PR の先頭コミットを取る", async () => {
    const { gh, calls } = fakeGh(() => ok({ head: { sha: "abc" } }));
    expect(await gh.headSha(7)).toBe("abc");
    expect(calls[0]!.args).toEqual([
      "api",
      "repos/me/app/pulls/7",
      "--method",
      "GET",
    ]);
  });

  it("会話・行へのコメント・レビュー本文をまとめ、空のものは除く", async () => {
    const { gh } = fakeGh((args) => {
      const path = args[1]!;
      if (path.startsWith("repos/me/app/issues/7/comments"))
        return ok([
          {
            user: { login: "me" },
            body: "/conductor approve",
            created_at: "t1",
          },
          { user: null, body: "消えたユーザー", created_at: "t1" },
        ]);
      if (path.startsWith("repos/me/app/pulls/7/comments"))
        return ok([
          {
            user: { login: "me" },
            body: "ここ",
            created_at: "t2",
            path: "src/a.ts",
            line: 3,
          },
        ]);
      if (path.startsWith("repos/me/app/pulls/7/reviews"))
        return ok([
          { user: { login: "me" }, body: "", submitted_at: "t3" },
          { user: { login: "me" }, body: "全体の感想", submitted_at: "t4" },
        ]);
      return undefined;
    });
    expect(await gh.prComments(7)).toEqual([
      { author: "me", body: "/conductor approve", createdAt: "t1" },
      {
        author: "me",
        body: "ここ",
        createdAt: "t2",
        path: "src/a.ts",
        line: 3,
      },
      { author: "me", body: "全体の感想", createdAt: "t4" },
    ]);
  });

  it("書き込み権限は write 以上。共同作業者でなければ false", async () => {
    const { gh } = fakeGh((args) => {
      if (args[1]!.includes("collaborators/me/"))
        return ok({ permission: "admin" });
      if (args[1]!.includes("collaborators/reader/"))
        return ok({ permission: "read" });
      return { code: 1, stdout: "", stderr: "HTTP 404" };
    });
    expect(await gh.canWrite("me")).toBe(true);
    expect(await gh.canWrite("reader")).toBe(false);
    expect(await gh.canWrite("stranger")).toBe(false);
  });
});

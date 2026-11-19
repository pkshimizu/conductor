import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  buildArgs,
  type ClaudeDeps,
  commonOutputSchema,
  detectLimit,
  type Exec,
  type ExecResult,
  RoleError,
  roleOutput,
  runRole,
  toJsonSchema,
  withLanguage,
} from "./claude.js";

const OK = {
  verdict: "approve",
  summary: "テストを書いた",
  findings: [{ file: "src/a.ts", line: 3, message: "名前が曖昧" }],
};

function cliJson(extra: Record<string, unknown>): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: "s1",
    total_cost_usd: 0.01,
    num_turns: 2,
    permission_denials: [],
    ...extra,
  });
}

interface Call {
  args: string[];
  cwd: string;
  input: string;
  systemPrompt: string;
}

function fakeDeps(results: ExecResult[], start = "2026-11-15T03:00:00Z") {
  let t = Date.parse(start);
  const calls: Call[] = [];
  const exec: Exec = (args, { cwd, input }) => {
    const file = args[args.indexOf("--append-system-prompt-file") + 1]!;
    calls.push({
      args,
      cwd: cwd ?? "",
      input: input ?? "",
      systemPrompt: readFileSync(file, "utf8"),
    });
    const r = results.shift();
    if (!r) throw new Error("呼び出しが多すぎる");
    return Promise.resolve(r);
  };
  const sleeps: number[] = [];
  const deps: ClaudeDeps = {
    exec,
    now: () => new Date(t),
    sleep: (ms) => {
      sleeps.push(ms);
      t += ms;
      return Promise.resolve();
    },
    onLimit: vi.fn(),
  };
  return { deps, calls, sleeps };
}

const RUN = {
  role: "tester",
  cwd: "/repo",
  systemPrompt: "あなたはテスト役です",
  prompt: "Issue #2 の本文",
  schema: commonOutputSchema,
  allow: ["Read", "Bash(npm test)"],
};

describe("AC1: 決まりと依頼文の渡し方", () => {
  it("決まりは --append-system-prompt-file、依頼文は標準入力、毎回新しいセッション", async () => {
    const { deps, calls } = fakeDeps([
      { code: 0, stdout: cliJson({ structured_output: OK }), stderr: "" },
    ]);
    await runRole(RUN, deps);
    const [c] = calls;
    expect(c!.systemPrompt).toBe("あなたはテスト役です");
    expect(c!.input).toBe("Issue #2 の本文");
    expect(c!.cwd).toBe("/repo");
    expect(c!.args).toContain("-p");
    expect(c!.args).toContain("--no-session-persistence");
    expect(c!.args).not.toContain("--resume");
    expect(c!.args).not.toContain("--continue");
    // 依頼文は引数に含めない（長文・記号で壊れないように）
    expect(c!.args.join(" ")).not.toContain("Issue #2 の本文");
  });
});

describe("出力の言語", () => {
  it("決まりのファイルの最後に言語の指示が入る", async () => {
    const { deps, calls } = fakeDeps([
      { code: 0, stdout: cliJson({ structured_output: OK }), stderr: "" },
    ]);
    await runRole(withLanguage(RUN, "English"), deps);
    const prompt = calls[0]!.systemPrompt;
    expect(prompt.startsWith("あなたはテスト役です\n\n")).toBe(true);
    expect(prompt).toMatch(/すべてEnglishで書きます。[^\n]*$/);
  });

  it("元の決まりは書き換えない", () => {
    const run = { ...RUN };
    withLanguage(run, "日本語");
    expect(run.systemPrompt).toBe("あなたはテスト役です");
  });
});

describe("AC2: 結果の形", () => {
  const reviewer = roleOutput({
    tests_untouched: z.boolean().describe("受け入れテストに手が入っていない"),
  });

  it("共通の項目と役ごとの項目を JSON Schema にして渡す", () => {
    const args = buildArgs({ schema: reviewer, allow: [] }, "f.md");
    const schema = JSON.parse(args[args.indexOf("--json-schema") + 1]!);
    expect(schema).toEqual(toJsonSchema(reviewer));
    expect(schema.required).toEqual([
      "verdict",
      "summary",
      "findings",
      "tests_untouched",
    ]);
    expect(schema.properties.verdict.enum).toEqual([
      "approve",
      "reject",
      "objection",
    ]);
    expect(schema.properties.findings.items.required).toEqual([
      "file",
      "line",
      "message",
    ]);
    expect(schema.additionalProperties).toBe(false);
  });

  it("点検済みの結果を返す", async () => {
    const { deps } = fakeDeps([
      {
        code: 0,
        stdout: cliJson({
          structured_output: { ...OK, tests_untouched: true },
        }),
        stderr: "",
      },
    ]);
    const r = await runRole({ ...RUN, schema: reviewer }, deps);
    expect(r.output).toEqual({ ...OK, tests_untouched: true });
    expect(r.costUsd).toBe(0.01);
    expect(r.turns).toBe(2);
  });

  it("形が違えばエラーで止める", async () => {
    const { deps } = fakeDeps([
      {
        code: 0,
        stdout: cliJson({ structured_output: { verdict: "maybe" } }),
        stderr: "",
      },
    ]);
    await expect(runRole(RUN, deps)).rejects.toThrow(
      /tester: 結果が決めた形になっていません/,
    );
  });

  it("claude が失敗したらエラーで止める（上限以外）", async () => {
    const { deps } = fakeDeps([
      { code: 1, stdout: "", stderr: "Error: Invalid API key" },
    ]);
    const err = await runRole(RUN, deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RoleError);
    expect((err as RoleError).detail).toContain("Invalid API key");
  });
});

describe("AC3: 許可リスト", () => {
  it("dontAsk と許可リストを渡す", () => {
    const args = buildArgs(
      { schema: commonOutputSchema, allow: ["Read", "Bash(npm test)"] },
      "f.md",
    );
    const i = args.indexOf("--permission-mode");
    expect(args[i + 1]).toBe("dontAsk");
    const j = args.indexOf("--allowedTools");
    expect(args.slice(j + 1, j + 3)).toEqual(["Read", "Bash(npm test)"]);
  });

  it("Bash の規則には PowerShell の規則も足す（Windows 用）", () => {
    const args = buildArgs(
      {
        schema: commonOutputSchema,
        allow: ["Read", "Bash(npm test)", "Bash(npm test *)"],
        deny: ["Bash(git push *)"],
      },
      "f.md",
    );
    const j = args.indexOf("--allowedTools");
    expect(args.slice(j + 1, j + 6)).toEqual([
      "Read",
      "Bash(npm test)",
      "PowerShell(npm test)",
      "Bash(npm test *)",
      "PowerShell(npm test *)",
    ]);
    const i = args.indexOf("--disallowedTools");
    expect(args.slice(i + 1)).toEqual([
      "Bash(git push *)",
      "PowerShell(git push *)",
    ]);
  });

  it("許可リストが空なら道具を使わせない", () => {
    const args = buildArgs({ schema: commonOutputSchema, allow: [] }, "f.md");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).not.toContain("--allowedTools");
  });

  it("禁止の操作は --disallowedTools で渡す", () => {
    const args = buildArgs(
      { schema: commonOutputSchema, allow: ["Edit"], deny: ["Edit(./e2e/**)"] },
      "f.md",
    );
    const i = args.indexOf("--disallowedTools");
    expect(args.slice(i + 1)).toEqual(["Edit(./e2e/**)"]);
    expect(
      buildArgs({ schema: commonOutputSchema, allow: ["Read"] }, "f.md"),
    ).not.toContain("--disallowedTools");
  });

  it("拒否された操作を結果に含める", async () => {
    const { deps } = fakeDeps([
      {
        code: 0,
        stdout: cliJson({
          structured_output: OK,
          permission_denials: [
            {
              tool_name: "Bash",
              tool_use_id: "x",
              tool_input: { command: "rm -rf ." },
            },
          ],
        }),
        stderr: "",
      },
    ]);
    const r = await runRole(RUN, deps);
    expect(r.denials).toEqual([
      { tool: "Bash", input: { command: "rm -rf ." } },
    ]);
  });
});

describe("AC4: 利用上限", () => {
  it("リセット時刻まで待ち、同じ依頼をやり直す", async () => {
    const { deps, calls, sleeps } = fakeDeps(
      [
        {
          code: 1,
          stdout: cliJson({
            is_error: true,
            subtype: "error_during_execution",
            result: "You've hit your limit · resets 5pm (Asia/Tokyo)",
          }),
          stderr: "",
        },
        { code: 0, stdout: cliJson({ structured_output: OK }), stderr: "" },
      ],
      "2026-11-15T06:30:00Z", // 東京 15:30
    );
    const r = await runRole(RUN, deps);
    expect(r.output.verdict).toBe("approve");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.input).toBe(calls[0]!.input);
    // 17:00 JST = 08:00Z、余裕 1 分
    expect(sleeps).toEqual([(90 + 1) * 60 * 1000]);
    expect(deps.onLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "tester",
        resumeAt: new Date("2026-11-15T08:01:00Z"),
      }),
    );
  });
});

describe("detectLimit", () => {
  const now = new Date("2026-11-15T06:30:00Z");
  it("上限でなければ undefined", () => {
    expect(detectLimit("Invalid API key", now)).toBeUndefined();
  });
  it("旧形式（UNIX 時刻）", () => {
    expect(
      detectLimit("Claude AI usage limit reached|1763200000", now),
    ).toEqual(new Date(1763200000 * 1000 + 60_000));
  });
  it("時刻が過ぎていれば翌日", () => {
    expect(
      detectLimit("hit your limit · resets 3am (Asia/Tokyo)", now),
    ).toEqual(new Date("2026-11-15T18:01:00Z"));
  });
  it("時刻が読めなければ 15 分後", () => {
    expect(detectLimit("Usage limit reached", now)).toEqual(
      new Date("2026-11-15T06:45:00Z"),
    );
  });
});

/**
 * 実装役。テスト役が書いた受け入れテストが通るように実装させ、PR を作る。
 * - 受け入れテスト・seed・.conductor/ は許可リストで禁止し、さらにハッシュで改変を確かめる
 * - コミットと push は指揮役が行う。ローカルで準備→型→テスト→受け入れテストを通してから PR を作る
 * - 通らなければ差し戻し（回数を数える）。途中の実装は push しておき、次の実装役が続きから直す
 */
import type { z } from "zod";
import { blockIssue } from "./blocked-thread.js";
import { roleOutput, type RoleResult, type RoleRun } from "./claude.js";
import type { Config } from "./config.js";
import { type ExecResult, isAbortError, type Shell } from "./exec.js";
import type { Git } from "./git.js";
import { matchesAny } from "./git.js";
import { listAcceptance } from "./intake.js";
import { PartialWorkAbortError } from "./partial-work.js";
import { recordRejection, type Board } from "./rejection.js";
import type { IssueKey, Store } from "./store.js";
import {
  formatWritten,
  hashTargets,
  testBranch,
  type TesterIssue,
} from "./tester.js";

export const implementerOutputSchema = roleOutput({});
export type ImplementerOutput = z.infer<typeof implementerOutputSchema>;

export const IMPLEMENTER_RULES = `あなたは実装役です。テスト役が先に書いた受け入れテストが通るように実装します。

- 依頼文で示す「変えてはいけないファイル」（受け入れテスト・seed・.conductor/）は変えません。変えると差し戻しになり、変更は戻されます。
- 受け入れテストに不備がある（Issue の受け入れ条件（AC）と食い違う、テスト同士がデータを取り合う など）と思ったら、テストは変えずに verdict を "objection" にし、どのテストのどこが問題かを findings に書きます。テスト役がその指摘を受けてテストを書き直します。
- 単体テストは、変えてはいけないファイルの外に自由に足してかまいません。
- 終わる前に、依頼文の確認のコマンドを自分で実行し、通ることを確かめます。
- git のコミット・push・ブランチの操作はしません。指揮役が行います。
- 終わったら verdict を "approve" にし、summary にやったことを書きます。`;

/** ローカルの確認で、1つのコマンドに許す時間 */
const CHECK_TIMEOUT_MS = 20 * 60 * 1000;
/** 失敗したコマンドの出力として残す行数 */
const OUTPUT_TAIL_LINES = 60;

export interface ImplementerBoard extends Board {
  findPullRequest(
    head: string,
  ): Promise<{ number: number; url: string } | undefined>;
  createPullRequest(input: {
    issue: number;
    head: string;
    title: string;
    body: string;
  }): Promise<{ number: number; url: string }>;
}

export interface ImplementerDeps {
  config: Config;
  repoDir: string;
  git: Pick<
    Git,
    | "startBranch"
    | "changedFiles"
    | "discard"
    | "discardAll"
    | "commit"
    | "push"
    | "treeHash"
  >;
  board: ImplementerBoard;
  store: Store;
  run: (
    run: RoleRun<typeof implementerOutputSchema>,
  ) => Promise<RoleResult<ImplementerOutput>>;
  /** 設定のコマンドをリポジトリで実行する */
  shell: Shell;
  /** .conductor/roles/implementer.md の中身 */
  instructions: string;
  model?: string;
  /** 中断の signal。来たらそれまでの変更をブランチに push してから AbortError を投げる */
  signal?: AbortSignal;
}

export type ImplementerResult =
  | { status: "submitted"; pr: number; url: string }
  | {
      status: "rejected";
      findings: string[];
      rejections: number;
      blocked: boolean;
    }
  | { status: "objection"; objections: number }
  | { status: "waiting" };

/** 実装役が変えてはいけないファイル */
export function forbiddenGlobs(config: Config): string[] {
  return hashTargets(config);
}

/** ローカルの確認の順番。[名前, コマンド] */
export function checkSteps(config: Config): [string, string][] {
  const c = config.commands;
  return [
    ["準備", c.setup],
    ["型チェック", c.typecheck],
    ["テスト", c.test],
    ["受け入れテスト", c.acceptance],
  ];
}

function bashRules(command: string): string[] {
  return [`Bash(${command})`, `Bash(${command} *)`];
}

export function implementerAllow(config: Config): string[] {
  const commands = Object.values(config.commands).filter(
    (c): c is string => c !== undefined,
  );
  return [
    "Read",
    "Glob",
    "Grep",
    "Edit",
    // 新しいファイルを作るため。保護対象は implementerDeny の Edit(...) で Write も止まる
    "Write",
    ...[...new Set(commands)].flatMap(bashRules),
    ...config.roles.implementer.allow,
  ];
}

export function implementerDeny(config: Config): string[] {
  return forbiddenGlobs(config).map((g) => `Edit(./${g})`);
}

export function implementerPrompt(
  config: Config,
  issue: TesterIssue,
  findings: readonly string[] = [],
): string {
  const acs = listAcceptance(issue.body);
  const lines = [
    `# Issue #${issue.number}: ${issue.title}`,
    "",
    issue.body.trim(),
    "",
    "# 依頼",
    `上の Issue を実装し、${acs.join("、")} の受け入れテストを通してください。`,
    "",
    "変えてはいけないファイル（glob）:",
    ...forbiddenGlobs(config).map((g) => `- ${g}`),
    "",
    "確認のコマンド（この順に実行します）:",
    ...checkSteps(config).map(([name, cmd]) => `- ${name}: ${cmd}`),
  ];
  if (findings.length > 0) {
    lines.push(
      "",
      "# 前回までの指摘（直してください）",
      ...findings.map((f) => `- ${f.replace(/\n/g, "\n  ")}`),
    );
  }
  return lines.join("\n");
}

/** 色付けの制御文字 */
const ANSI_COLOR = new RegExp(String.raw`\u001b\[[0-9;]*m`, "g");

/** コマンドの出力の末尾 */
export function outputTail(res: ExecResult, lines = OUTPUT_TAIL_LINES): string {
  const text = `${res.stdout}\n${res.stderr}`.replace(ANSI_COLOR, "");
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .slice(-lines)
    .join("\n");
}

/** 確認のコマンドを順に実行し、最初に失敗したものの指摘を返す */
export async function runChecks(
  config: Config,
  repoDir: string,
  shell: Shell,
): Promise<string | undefined> {
  for (const [name, cmd] of checkSteps(config)) {
    const res = await shell(cmd, {
      cwd: repoDir,
      timeoutMs: CHECK_TIMEOUT_MS,
    });
    if (res.code !== 0) {
      return `${name}（${cmd}）が失敗しました（終了コード ${String(res.code)}）:\n${outputTail(res)}`;
    }
  }
  return undefined;
}

/** 実装役の異議を、テスト役に渡す指摘にする（要約と、ファイル・行ごとの指摘） */
export function objectionFindings(out: ImplementerOutput): string[] {
  return [
    out.summary,
    ...out.findings.map(
      (f) => `${f.file}${f.line === null ? "" : `:${f.line}`}: ${f.message}`,
    ),
  ].filter((s) => s.trim() !== "");
}

function bullets(lines: string[]): string[] {
  return lines.map((l) => `- ${l.replace(/\n+/g, " ")}`);
}

export function objectionComment(
  out: ImplementerOutput,
  objections: number,
  limit: number,
): string {
  return [
    `実装役が受け入れテストの不備を指摘しました（異議 ${objections}/${limit} 回目）。テスト役に次の指摘を渡して、テストを書き直します。`,
    "",
    ...bullets(objectionFindings(out)),
  ].join("\n");
}

export function objectionLimitComment(
  out: ImplementerOutput,
  limit: number,
  ready: string,
): string {
  return [
    `異議が上限（${limit} 回）を超えたため、Blocked に移しました。最後の実装役の指摘:`,
    "",
    ...bullets(objectionFindings(out)),
    "",
    `Issue か受け入れテストを確かめたら ${ready} 列に戻してください。`,
  ].join("\n");
}

export function pullRequestBody(issue: TesterIssue, out: ImplementerOutput) {
  return [
    `Issue #${issue.number} を conductor の実装役が実装しました。`,
    "",
    "## 実装の要約",
    "",
    out.summary,
  ].join("\n");
}

/**
 * 中断されたときの後始末。変えてはいけないファイルの変更は戻し、
 * 残りをコミットして Issue のブランチに push する
 */
export async function keepPartialWork(
  deps: {
    config: Config;
    git: Pick<
      Git,
      | "changedFiles"
      | "discard"
      | "commit"
      | "treeHash"
      | "push"
      | "startBranch"
    >;
  },
  issue: TesterIssue,
  branch: string,
  protectedHash: string,
): Promise<KeepResult> {
  const { git } = deps;
  const forbidden = forbiddenGlobs(deps.config);
  const changed = await git.changedFiles();
  const touched = changed.filter((f) => matchesAny(f, forbidden));
  if (touched.length > 0) await git.discard(touched);
  const rest = changed.filter((f) => !touched.includes(f));
  if (rest.length > 0) {
    await git.commit(rest, `wip: #${issue.number} の実装（中断）`);
  }
  // 実装役が自分でコミットした場合も含め、HEAD で照合する
  if ((await git.treeHash("HEAD", forbidden)) !== protectedHash) {
    // 保護対象が変わってしまったら残さない
    await git.startBranch(branch, branch);
    return "discarded";
  }
  if (rest.length === 0) return "nothing";
  await git.push(branch);
  return "pushed";
}

/** keepPartialWork の結果。pushed=ブランチに push した、nothing=残す変更が無い、discarded=保護対象が変わっていたので捨てた */
export type KeepResult = "pushed" | "nothing" | "discarded";

/** 中断されたときに変更を残し、その結果を付けた中断のエラーを返す（残すのに失敗しても中断として返す） */
async function abortWithPartialWork(
  deps: ImplementerDeps,
  issue: TesterIssue,
  branch: string,
  protectedHash: string,
  cause: unknown,
): Promise<PartialWorkAbortError> {
  try {
    const kind = await keepPartialWork(deps, issue, branch, protectedHash);
    return new PartialWorkAbortError({ kind }, { cause });
  } catch (e) {
    return new PartialWorkAbortError(
      { kind: "failed", reason: e instanceof Error ? e.message : String(e) },
      { cause: e },
    );
  }
}

/** 実装役を1回分進める。指摘（findings）があれば渡す */
export async function runImplementer(
  deps: ImplementerDeps,
  issue: TesterIssue,
  findings: readonly string[] = [],
): Promise<ImplementerResult> {
  const { config, git, board, store } = deps;
  const { columns } = config.github;
  const key: IssueKey = { repo: config.github.repo, issue: issue.number };

  const record = await store.get(key);
  if (!record?.protectedHash) return { status: "waiting" };
  if (record.rejections > config.limits.rejections)
    return { status: "waiting" };
  if (record.objections > config.limits.objections)
    return { status: "waiting" };

  const branch = record.branch ?? testBranch(issue.number);
  const reject = (problems: string[]) =>
    rejectLocally(deps, issue.number, problems);

  // 前回の続きから始める（途中の実装は origin のブランチにある）
  await git.discardAll();
  await git.startBranch(branch, branch);
  await store.update(key, { branch, checkpoint: { stage: "implementing" } });
  await board.moveIssue(issue.number, columns.implementing);

  let pushed: Awaited<ReturnType<typeof implementAndPush>>;
  try {
    // 実装役の実行から push までの間に中断されたら、それまでの変更をブランチに残す
    pushed = await implementAndPush(
      deps,
      issue,
      findings,
      { protectedHash: record.protectedHash, objections: record.objections },
      branch,
    );
  } catch (e) {
    if (isAbortError(e) || deps.signal?.aborted === true) {
      // 中断されたら、それまでの変更をブランチに残す（人が Ready に戻したら続きから）。
      // 残せたかどうかは中断のエラーに付けて、ループの知らせの文に使う
      throw await abortWithPartialWork(
        deps,
        issue,
        branch,
        record.protectedHash,
        e,
      );
    }
    throw e;
  }
  if ("result" in pushed) return pushed.result;
  const { out } = pushed;

  // push のあとの確認で中断されても、変更はもう push してある
  const failure = await runChecks(config, deps.repoDir, deps.shell);
  // 確認で作られたファイル（撮影など）は残さない
  await git.discardAll();
  if (failure) return reject([failure]);

  const pr =
    (await board.findPullRequest(branch)) ??
    (await board.createPullRequest({
      issue: issue.number,
      head: branch,
      title: issue.title,
      body: pullRequestBody(issue, out),
    }));
  await store.update(key, { pr: pr.number, checkpoint: { stage: "ci" } });
  await store.addSummary(key, {
    role: "implementer",
    verdict: "approve",
    text: out.summary,
  });
  await board.moveIssue(issue.number, columns.reviewing);
  return { status: "submitted", pr: pr.number, url: pr.url };
}

async function rejectLocally(
  deps: ImplementerDeps,
  issue: number,
  problems: string[],
): Promise<ImplementerResult> {
  const r = await recordRejection(
    deps,
    issue,
    "implementer",
    "ローカルの確認",
    problems,
  );
  return { status: "rejected", findings: problems, ...r };
}

/**
 * 実装役を動かし、変更を整形・コミットして push する。
 * 確認に進めるなら実装役の出力を、ここで終わるなら（異議・差し戻し）結果を返す
 */
async function implementAndPush(
  deps: ImplementerDeps,
  issue: TesterIssue,
  findings: readonly string[],
  record: { protectedHash: string; objections: number },
  branch: string,
): Promise<{ result: ImplementerResult } | { out: ImplementerOutput }> {
  const { config, git, board, store } = deps;
  const { columns } = config.github;
  const key: IssueKey = { repo: config.github.repo, issue: issue.number };
  const reject = async (problems: string[]) => ({
    result: await rejectLocally(deps, issue.number, problems),
  });

  const result = await deps.run({
    role: "implementer",
    cwd: deps.repoDir,
    systemPrompt: [IMPLEMENTER_RULES, deps.instructions]
      .filter(Boolean)
      .join("\n\n"),
    prompt: implementerPrompt(config, issue, findings),
    schema: implementerOutputSchema,
    allow: implementerAllow(config),
    deny: implementerDeny(config),
    ...(deps.model ? { model: deps.model } : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
  const out = result.output;

  if (out.verdict === "objection") {
    await git.discardAll();
    const objections = record.objections + 1;
    const limit = config.limits.objections;
    const over = objections > limit;
    // 上限までは、テスト役に指摘を渡してテストを書き直させる
    await store.update(key, {
      objections,
      checkpoint: over
        ? { stage: "implementing", reason: "objection" }
        : { stage: "testing", reason: "objection" },
    });
    await store.addSummary(key, {
      role: "implementer",
      verdict: "objection",
      text: objectionFindings(out).join("\n\n"),
    });
    if (over) {
      await blockIssue(deps, issue.number, {
        body: objectionLimitComment(out, limit, columns.ready),
        reason: [
          `実装役の異議が上限（${limit} 回）を超えました。受け入れテストの問題:`,
          ...objectionFindings(out).map((f) => `- ${f}`),
        ].join("\n"),
      });
    } else {
      await board.moveIssue(issue.number, columns.testing);
      await board.comment(
        issue.number,
        objectionComment(out, objections, limit),
      );
    }
    return { result: { status: "objection", objections } };
  }

  const problems: string[] = [];
  // 変えてはいけないファイルの変更は戻す
  const changed = await git.changedFiles();
  const forbidden = forbiddenGlobs(config);
  const touched = changed.filter((f) => matchesAny(f, forbidden));
  if (touched.length > 0) {
    await git.discard(touched);
    problems.push(
      `変えてはいけないファイルを変えたので戻しました: ${touched.join("、")}`,
    );
  }
  let rest = changed.filter((f) => !touched.includes(f));
  if (rest.length > 0) {
    // 整形してからコミットする（CI の整形チェックで落ちないように）。
    // 整形で変わった保護対象は戻す（ハッシュを変えないため。実装役の誤りではない）
    const formatProblem = await formatWritten(
      deps,
      (f) => !matchesAny(f, forbidden),
    );
    if (formatProblem) problems.push(formatProblem);
    rest = await git.changedFiles();
  }
  if (rest.length > 0) {
    await git.commit(rest, `feat: #${issue.number} の実装`);
  }
  // 自分でコミットした場合も含め、コミットの時点で照合する
  if ((await git.treeHash("HEAD", forbidden)) !== record.protectedHash) {
    await git.startBranch(branch, branch);
    problems.push(
      "受け入れテスト・seed・.conductor/ のハッシュが一致しないので、今回の変更をすべて戻しました",
    );
    return reject(problems);
  }
  if (rest.length > 0) await git.push(branch);
  if (problems.length > 0) return reject(problems);
  if (out.verdict !== "approve") {
    return reject([`実装役が ${out.verdict} を返しました: ${out.summary}`]);
  }
  return { out };
}

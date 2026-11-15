/**
 * CI 待ちとレビュー役。
 * - CI が失敗したら、失敗ログの要点を指摘として実装役に差し戻す
 * - CI が通ったら、レビュー役が差分・Issue・スクリーンショットを読んで判定する（読むだけ）
 *   .conductor/reviewer/*.md のレビュー観点ごとにレビュー役を並列で動かし、判定をまとめる
 * - 承認されたら squash でマージし、Issue を完了列に移す
 */
import type { z } from "zod";
import {
  roleOutput,
  type Finding,
  type RoleResult,
  type RoleRun,
} from "./claude.js";
import type { Config, RoleDoc } from "./config.js";
import type { Shell } from "./exec.js";
import type { Git } from "./git.js";
import type { CiResult } from "./github.js";
import { outputTail } from "./implementer.js";
import { listAcceptance } from "./intake.js";
import { recordRejection, type Board } from "./rejection.js";
import type { IssueKey, Store } from "./store.js";
import { screenshotPath, testBranch, type TesterIssue } from "./tester.js";

export const reviewerOutputSchema = roleOutput({});
export type ReviewerOutput = z.infer<typeof reviewerOutputSchema>;

export const REVIEWER_RULES = `あなたはレビュー役です。CI を通った PR を、Issue の受け入れ条件（AC）に照らして確認します。

- ファイルは読むだけです。変更・コミット・push はしません（変更は捨てられます）。
- 依頼文の差分と Issue を読み、必要なら Read・Glob・Grep でリポジトリのコードも確かめます。
- スクリーンショットの一覧があれば Read で画像を開き、AC どおりの画面かを確かめます。
- 直すべき点があれば verdict を "reject" にし、findings に「どのファイルの何をどう直すか」を書きます。
- 受け入れテストそのものが AC と食い違っていると思ったら、verdict を "objection" にし、理由を findings に書きます。
- 問題がなければ verdict を "approve" にし、summary に確認したことを書きます。`;

/** レビュー役に渡す差分の上限（文字数）。超えたら変更の一覧だけを渡す */
export const DIFF_LIMIT = 60_000;
/** スクリーンショットの撮影で、1つのコマンドに許す時間 */
const SHOT_TIMEOUT_MS = 20 * 60 * 1000;

export interface ReviewBoard extends Board {
  ciStatus(pr: number): Promise<CiResult>;
  merge(pr: number, issue: number, doneColumn: string): Promise<void>;
  baseBranch(): Promise<string>;
}

export interface ReviewerDeps {
  config: Config;
  repoDir: string;
  git: Pick<Git, "startBranch" | "discardAll" | "changedFiles" | "diffFrom">;
  board: ReviewBoard;
  store: Store;
  run: (
    run: RoleRun<typeof reviewerOutputSchema>,
  ) => Promise<RoleResult<ReviewerOutput>>;
  /** 設定のコマンドをリポジトリで実行する（撮影用） */
  shell: Shell;
  /** リポジトリからの相対パスのファイルがあるか */
  exists: (path: string) => Promise<boolean>;
  /** .conductor/reviewer/*.md のレビュー観点。1つにつき1つのレビュー役を動かす */
  perspectives: readonly RoleDoc[];
  model?: string;
}

export type CiWaitResult =
  | { status: "pending" }
  | { status: "passed" }
  | {
      status: "rejected";
      findings: string[];
      rejections: number;
      blocked: boolean;
    }
  | { status: "waiting" };

export type ReviewerResult =
  | { status: "merged"; pr: number }
  | {
      status: "rejected";
      findings: string[];
      rejections: number;
      blocked: boolean;
    }
  | { status: "objection"; objections: number }
  | { status: "waiting" };

/** レビュー役は読むだけ。git も読む操作だけを許す */
export function reviewerAllow(config: Config): string[] {
  return [
    "Read",
    "Glob",
    "Grep",
    "Bash(git diff *)",
    "Bash(git log *)",
    "Bash(git show *)",
    ...config.roles.reviewer.allow,
  ];
}

export function reviewerDeny(): string[] {
  return ["Edit", "Write", "NotebookEdit"];
}

export function ciFindings(ci: CiResult): string[] {
  const failed = ci.checks
    .filter((c) => c.bucket === "fail" || c.bucket === "cancel")
    .map((c) => c.name);
  const head = `CI が失敗しました（${failed.join("、") || "不明"}）。ログの要点:`;
  return [`${head}\n${ci.failureLog?.trim() || "（ログを取れませんでした）"}`];
}

export function formatFinding(f: Finding): string {
  return `${f.file}${f.line === null ? "" : `:${f.line}`}: ${f.message}`;
}

/** CI の結果を1回確かめる。実行中なら pending を返す（呼び出し側が待って再確認する） */
export async function checkCi(
  deps: Pick<ReviewerDeps, "config" | "board" | "store">,
  issue: number,
): Promise<CiWaitResult> {
  const { config, board, store } = deps;
  const key: IssueKey = { repo: config.github.repo, issue };
  const record = await store.get(key);
  if (record?.pr === undefined) return { status: "waiting" };

  const ci = await board.ciStatus(record.pr);
  if (ci.state === "pending") return { status: "pending" };
  if (ci.state === "failure") {
    const findings = ciFindings(ci);
    const r = await recordRejection(deps, issue, "ci", "CI", findings);
    return { status: "rejected", findings, ...r };
  }
  await store.update(key, { checkpoint: { stage: "reviewing" } });
  return { status: "passed" };
}

export function reviewerPrompt(
  issue: TesterIssue,
  pr: number,
  diff: string,
  screenshots: readonly string[],
): string {
  return [
    `# Issue #${issue.number}: ${issue.title}`,
    "",
    issue.body.trim(),
    "",
    "# 依頼",
    `PR #${pr} が上の Issue を満たしているか確認してください。CI は通っています。`,
    "",
    "## スクリーンショット",
    ...(screenshots.length > 0
      ? screenshots.map((s) => `- ${s}`)
      : ["（なし）"]),
    "",
    "## 差分",
    "```diff",
    diff.trim(),
    "```",
  ].join("\n");
}

export function reviewObjectionComment(
  out: ReviewerOutput,
  ready: string,
): string {
  return [
    "レビュー役が、受け入れテストと受け入れ条件の食い違いを指摘しました。確認してください。",
    "",
    out.summary,
    ...out.findings.map((f) => `- ${formatFinding(f)}`),
    "",
    `直したら ${ready} 列に戻してください。`,
  ].join("\n");
}

/** 観点ごとのレビュー役への指示。観点が無ければ全体を見る1人だけ */
export function reviewerSystemPrompts(
  perspectives: readonly RoleDoc[],
): { name: string | undefined; prompt: string }[] {
  if (perspectives.length === 0) {
    return [{ name: undefined, prompt: REVIEWER_RULES }];
  }
  return perspectives.map((p) => ({
    name: p.name,
    prompt: [
      REVIEWER_RULES,
      `# レビュー観点: ${p.name}`,
      "この観点に絞って確認してください。ほかの観点は別のレビュー役が確認します。",
      p.text,
    ].join("\n\n"),
  }));
}

export interface PerspectiveReview {
  name: string | undefined;
  output: ReviewerOutput;
}

/**
 * 観点ごとの判定を1つにまとめる。
 * 異議が1つでもあれば異議（受け入れテストを直すのが先）、次に差し戻し、全員が承認なら承認。
 */
export function combineReviews(
  reviews: readonly PerspectiveReview[],
): ReviewerOutput {
  const verdict = reviews.some((r) => r.output.verdict === "objection")
    ? "objection"
    : reviews.some((r) => r.output.verdict === "reject")
      ? "reject"
      : "approve";
  const label = (r: PerspectiveReview) => (r.name ? `［${r.name}］` : "");
  return {
    verdict,
    summary: reviews
      .map((r) => `${label(r)}${r.output.verdict}: ${r.output.summary}`)
      .join("\n"),
    findings: reviews
      .filter((r) => r.output.verdict === verdict)
      .flatMap((r) =>
        r.output.findings.length > 0
          ? r.output.findings.map((f) => ({
              ...f,
              message: `${label(r)}${f.message}`,
            }))
          : [
              {
                file: "（全体）",
                line: null,
                message: `${label(r)}${r.output.summary}`,
              },
            ],
      ),
  };
}

/** 同時に limit 個まで fn を動かす。失敗があっても全部を終えてから、最初の失敗を投げる */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i]!) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  const failed = results.find((r) => r.status === "rejected");
  if (failed) throw failed.reason;
  return results.map((r) => (r as PromiseFulfilledResult<R>).value);
}

/** 受け入れテストを流して、各 AC の画面を撮る。撮れたものの一覧を返す */
async function takeScreenshots(
  deps: ReviewerDeps,
  issue: TesterIssue,
): Promise<string[]> {
  const dir = deps.config.screenshots;
  if (!dir) return [];
  const { setup, acceptance } = deps.config.commands;
  for (const cmd of [setup, acceptance]) {
    const res = await deps.shell(cmd, {
      cwd: deps.repoDir,
      timeoutMs: SHOT_TIMEOUT_MS,
    });
    // CI は通っているので、ここでの失敗は撮影できなかったものとして扱う
    if (res.code !== 0) {
      console.warn(
        `撮影のためのコマンドが失敗しました: ${cmd}\n${outputTail(res, 20)}`,
      );
      break;
    }
  }
  const shots: string[] = [];
  for (const ac of listAcceptance(issue.body)) {
    const path = screenshotPath(dir, issue.number, ac);
    if (await deps.exists(path)) shots.push(path);
  }
  return shots;
}

async function reviewDiff(deps: ReviewerDeps, base: string): Promise<string> {
  const diff = await deps.git.diffFrom(base);
  if (diff.length <= DIFF_LIMIT) return diff;
  const stat = await deps.git.diffFrom(base, { stat: true });
  return `（差分が長いので変更の一覧だけ示します。中身は git diff origin/${base}...HEAD や Read で確かめてください）\n${stat}`;
}

/** 承認された PR をマージし、Issue を完了列に移す */
export async function mergeApproved(
  deps: Pick<ReviewerDeps, "config" | "board" | "store">,
  issue: number,
): Promise<{ status: "merged"; pr: number } | { status: "waiting" }> {
  const { config, board, store } = deps;
  const key: IssueKey = { repo: config.github.repo, issue };
  const record = await store.get(key);
  if (record?.pr === undefined) return { status: "waiting" };
  await store.update(key, { checkpoint: { stage: "merging" } });
  await board.merge(record.pr, issue, config.github.columns.done);
  await store.update(key, { checkpoint: undefined });
  return { status: "merged", pr: record.pr };
}

/** CI が通った PR をレビュー役に確認させ、承認ならマージまで進める */
export async function runReviewer(
  deps: ReviewerDeps,
  issue: TesterIssue,
): Promise<ReviewerResult> {
  const { config, git, board, store } = deps;
  const { columns } = config.github;
  const key: IssueKey = { repo: config.github.repo, issue: issue.number };
  const record = await store.get(key);
  if (record?.pr === undefined) return { status: "waiting" };
  const pr = record.pr;
  const branch = record.branch ?? testBranch(issue.number);

  await git.discardAll();
  await git.startBranch(branch, branch);
  await store.update(key, { checkpoint: { stage: "reviewing" } });
  await board.moveIssue(issue.number, columns.reviewing);

  const base = await board.baseBranch();
  const diff = await reviewDiff(deps, base);
  const screenshots = await takeScreenshots(deps, issue);

  const prompt = reviewerPrompt(issue, pr, diff, screenshots);
  let reviews: PerspectiveReview[];
  try {
    reviews = await mapLimit(
      reviewerSystemPrompts(deps.perspectives),
      config.limits.reviewers,
      async ({ name, prompt: systemPrompt }) => {
        const result = await deps.run({
          role: "reviewer",
          cwd: deps.repoDir,
          systemPrompt,
          prompt,
          schema: reviewerOutputSchema,
          allow: reviewerAllow(config),
          deny: reviewerDeny(),
          ...(deps.model ? { model: deps.model } : {}),
        });
        return { name, output: result.output };
      },
    );
  } finally {
    // 撮影やレビュー役が作ったファイルは残さない（レビュー役は読むだけ）
    await git.discardAll();
  }
  const out = combineReviews(reviews);
  await store.addSummary(key, {
    role: "reviewer",
    verdict: out.verdict,
    text: out.summary,
  });

  if (out.verdict === "objection") {
    const objections = record.objections + 1;
    await store.update(key, {
      objections,
      checkpoint: { stage: "reviewing", reason: "objection" },
    });
    await board.moveIssue(issue.number, columns.blocked);
    await board.comment(
      issue.number,
      reviewObjectionComment(out, columns.ready),
      { mention: true },
    );
    return { status: "objection", objections };
  }

  if (out.verdict === "reject") {
    const findings =
      out.findings.length > 0 ? out.findings.map(formatFinding) : [out.summary];
    const r = await recordRejection(
      deps,
      issue.number,
      "reviewer",
      "レビュー",
      findings,
    );
    return { status: "rejected", findings, ...r };
  }

  return mergeApproved(deps, issue.number);
}

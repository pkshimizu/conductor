/**
 * テスト役。Issue の AC から受け入れテストと seed を書かせ、テスト用ブランチにコミットする。
 * 書いてよいのは保護対象（config.protected）だけ。それ以外の変更は捨てる。
 * 保護対象と .conductor/ のハッシュを記録し、実装役が変えていないかを後で確かめる。
 */
import { z } from "zod";
import { blockIssue } from "./blocked-thread.js";
import { roleOutput, type RoleResult, type RoleRun } from "./claude.js";
import { CONDUCTOR_DIR, type Config } from "./config.js";
import type { Shell } from "./exec.js";
import type { Git } from "./git.js";
import { matchesAny } from "./git.js";
import { listAcceptance } from "./intake.js";
import {
  permissionDenials,
  recordPermissionRequest,
} from "./permission-request.js";
import { pendingObjection } from "./rejection.js";
import type { IssueKey, Store } from "./store.js";

export const testerOutputSchema = roleOutput({
  tests: z
    .array(
      z
        .object({
          ac: z.string().describe("AC 番号（例: AC1）"),
          file: z
            .string()
            .describe("テストのファイル（リポジトリからの相対パス）"),
          title: z.string().describe("テストの名前。先頭に AC 番号を付ける"),
        })
        .strict(),
    )
    .describe("書いた受け入れテスト。AC 1つにつき1件"),
  questions: z
    .array(z.string())
    .describe(
      "異議のときの質問。AC が曖昧で書けない点を具体的に。無ければ空配列",
    ),
});
export type TesterOutput = z.infer<typeof testerOutputSchema>;

/** テスト役に必ず守らせる決まり。.conductor/roles/tester.md はこの後に足す */
export const TESTER_RULES = `あなたはテスト役です。実装より先に、Issue の受け入れ条件（AC）を確かめる受け入れテストを書きます。

- 書いてよいのは、依頼文で示す保護対象のファイルだけです。実装コードは書きません。
- 受け入れテストは Playwright で書き、AC 1つにつきテスト1件にします。テスト名の先頭に AC 番号を付けます（例: "AC1: ..."）。
- Given の状態は seed で作ります。DB は毎回空にしてから seed を入れる前提です。
- まだ実装が無いので、テストが失敗するのは正常です。通るまで直そうとしないでください。
- AC が曖昧で、どう確かめればよいか決められないときは、推測で書かずに verdict を "objection" にし、質問を questions に書きます。
- 書けたら verdict を "approve" にし、書いたテストを tests に並べます。`;

const BASE_ALLOW = ["Read", "Glob", "Grep"];

export interface TesterBoard {
  moveIssue(issue: number, column: string): Promise<void>;
  comment(
    issue: number,
    body: string,
    options?: { mention?: boolean },
  ): Promise<void>;
}

export interface TesterDeps {
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
  board: TesterBoard;
  store: Store;
  /** runRole に依存関係を渡したもの */
  run: (
    run: RoleRun<typeof testerOutputSchema>,
  ) => Promise<RoleResult<TesterOutput>>;
  /** リポジトリからの相対パスでファイルを読む */
  readFile: (path: string) => Promise<string>;
  /** commands.format の実行に使う */
  shell: Shell;
  /** .conductor/roles/tester.md の中身 */
  instructions: string;
  model?: string;
}

export interface TesterIssue {
  number: number;
  title: string;
  body: string;
}

export type TesterResult =
  | { status: "committed"; branch: string; commit: string; hash: string }
  | { status: "objection"; questions: string[]; objections: number }
  | { status: "waiting" }
  /** 許可リストにない操作を拒否されたので、許可を待つ（rules は足す規則の案） */
  | { status: "waiting_permission"; rules: string[] }
  | { status: "failed"; problems: string[] };

/** テスト用ブランチの名前 */
export const testBranch = (issue: number) => `conductor/issue-${issue}`;

/** 撮影した画面の保存先（リポジトリからの相対パス） */
export function screenshotPath(dir: string, issue: number, ac: string): string {
  return `${dir.replace(/\/+$/, "")}/issue-${issue}/${ac}.png`;
}

/** ハッシュの対象。受け入れテスト・seed と .conductor/ */
export function hashTargets(config: Config): string[] {
  return [...config.protected, `${CONDUCTOR_DIR}/**`];
}

/** 保護対象のファイルだけ書き換えを許す（Edit は Write も含む） */
export function testerAllow(config: Config): string[] {
  return [
    ...BASE_ALLOW,
    ...config.protected.map((g) => `Edit(./${g})`),
    ...config.roles.tester.allow,
  ];
}

/**
 * テスト役の拒否リスト。conductor 自身の設定・役の指示（.conductor/）は書き換えさせない。
 * claude にも渡し、拒否されても許可を聞かない（差し戻しと同じく扱う）
 */
export function testerDeny(): string[] {
  return [`Edit(./${CONDUCTOR_DIR}/**)`];
}

export function testerPrompt(
  config: Config,
  issue: TesterIssue,
  acs: string[],
  feedback: string[] = [],
): string {
  const lines = [
    `# Issue #${issue.number}: ${issue.title}`,
    "",
    issue.body.trim(),
    "",
    "# 依頼",
    `上の Issue の ${acs.join("、")} について、受け入れテストと seed を書いてください。`,
    "",
    "書いてよいファイル（glob）:",
    ...config.protected.map((g) => `- ${g}`),
    "",
    `受け入れテストの実行コマンド: ${config.commands.acceptance}`,
    `準備（DB を空にして seed を入れる）のコマンド: ${config.commands.setup}`,
  ];
  if (config.screenshots) {
    lines.push(
      "",
      "各テストの最後に、AC を確かめた画面を撮影してください。保存先:",
      ...acs.map(
        (ac) =>
          `- ${ac}: ${screenshotPath(config.screenshots!, issue.number, ac)}`,
      ),
      "保存先のパスは変数や関数で組み立てず、各テストの中に上の文字列のまま書いてください（conductor は文字列で撮影の有無を確かめます）。",
    );
  }
  if (feedback.length > 0) {
    lines.push(
      "",
      "# 前回の結果の問題（直してください）",
      ...feedback.map((f) => `- ${f}`),
    );
  }
  return lines.join("\n");
}

/** AC とテストが1対1か、ファイルの中身に AC 番号と撮影があるかを確かめる */
export async function verifyTests(
  config: Config,
  issue: number,
  acs: string[],
  output: TesterOutput,
  written: string[],
  readFile: (path: string) => Promise<string>,
): Promise<string[]> {
  const problems: string[] = [];
  const byAc = new Map<string, TesterOutput["tests"]>();
  for (const t of output.tests) {
    byAc.set(t.ac, [...(byAc.get(t.ac) ?? []), t]);
  }
  for (const ac of acs) {
    const n = byAc.get(ac)?.length ?? 0;
    if (n === 0) problems.push(`${ac} のテストがありません`);
    if (n > 1)
      problems.push(`${ac} のテストが ${n} 件あります（1件にしてください）`);
  }
  for (const ac of byAc.keys()) {
    if (!acs.includes(ac))
      problems.push(`Issue に無い ${ac} のテストがあります`);
  }
  const contents = new Map<string, string>();
  for (const t of output.tests) {
    if (!written.includes(t.file)) {
      problems.push(`${t.ac} のテスト ${t.file} が書かれていません`);
      continue;
    }
    if (!contents.has(t.file)) contents.set(t.file, await readFile(t.file));
    const text = contents.get(t.file)!;
    if (!new RegExp(`\\b${t.ac}\\b`).test(text)) {
      problems.push(`${t.file} のテスト名に ${t.ac} がありません`);
    }
    if (config.screenshots) {
      const shot = `${t.ac}.png`;
      if (!text.includes(shot)) {
        problems.push(
          `${t.file} に ${t.ac} の撮影（${shot}）がありません（パスを文字列のまま書いてください）`,
        );
      }
    }
  }
  return problems;
}

export function objectionComment(questions: string[], ready: string): string {
  return [
    "受け入れ条件が曖昧で、受け入れテストを書けませんでした。次の点を教えてください。",
    "",
    ...questions.map((q) => `- ${q}`),
    "",
    `Issue を直したら ${ready} 列に戻してください。`,
  ].join("\n");
}

export function objectionLimitComment(limit: number): string {
  return `異議が上限（${limit} 回）を超えたため、自動では進めません。人の対応を待ちます。`;
}

export function failedComment(problems: string[], ready: string): string {
  return [
    "受け入れテストを正しく書けなかったため、Blocked に移しました。",
    "",
    ...problems.map((p) => `- ${p}`),
    "",
    `確認したら ${ready} 列に戻してください。`,
  ].join("\n");
}

/** 整形の待ち時間の上限 */
const FORMAT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * commands.format があれば実行する。keep に当たらないファイルの変更は捨てる
 * （既定は保護対象だけを残す＝テスト役用）。失敗したら、役への指摘を返す
 */
export async function formatWritten(
  deps: {
    config: Config;
    repoDir: string;
    git: Pick<Git, "changedFiles" | "discard">;
    shell: Shell;
  },
  keep: (path: string) => boolean = (f) => matchesAny(f, deps.config.protected),
): Promise<string | undefined> {
  const cmd = deps.config.commands.format;
  if (!cmd) return undefined;
  const res = await deps.shell(cmd, {
    cwd: deps.repoDir,
    timeoutMs: FORMAT_TIMEOUT_MS,
  });
  const changed = await deps.git.changedFiles();
  const drop = changed.filter((f) => !keep(f));
  if (drop.length > 0) await deps.git.discard(drop);
  if (res.code === 0) return undefined;
  const tail = `${res.stdout}\n${res.stderr}`
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .slice(-20)
    .join("\n");
  return `整形（${cmd}）が失敗しました（終了コード ${String(res.code)}）。構文の誤りがないか確かめてください:\n${tail}`;
}

/** テスト役を1回分進める。失敗時の書き直しは1回まで */
export async function runTester(
  deps: TesterDeps,
  issue: TesterIssue,
  maxAttempts = 2,
): Promise<TesterResult> {
  const { config, git, board, store } = deps;
  const { columns } = config.github;
  const key: IssueKey = { repo: config.github.repo, issue: issue.number };
  const limit = config.limits.objections;

  const record = await store.get(key);
  if (record && record.objections > limit) return { status: "waiting" };
  // 許可の確認を待つ間は役を起動しない
  const permission = await store.getPermissionRequest(key);
  if (permission !== undefined) {
    return { status: "waiting_permission", rules: permission.rules };
  }

  // 実装役の異議で戻ってきたときは、その指摘を最初から渡す
  const objection = await pendingObjection(store, key);
  const acs = listAcceptance(issue.body);
  const branch = testBranch(issue.number);
  await git.startBranch(branch);
  await store.update(key, { branch, checkpoint: { stage: "testing" } });

  let feedback: string[] = objection;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await deps.run({
      role: "tester",
      cwd: deps.repoDir,
      systemPrompt: [TESTER_RULES, deps.instructions]
        .filter(Boolean)
        .join("\n\n"),
      prompt: testerPrompt(config, issue, acs, feedback),
      schema: testerOutputSchema,
      allow: testerAllow(config),
      deny: testerDeny(),
      ...(deps.model ? { model: deps.model } : {}),
    });
    const out = result.output;

    // 保護対象の外の変更は捨てる（.conductor/ も含む）
    const changed = await git.changedFiles();
    const written = changed.filter((f) => matchesAny(f, config.protected));
    await git.discard(changed.filter((f) => !written.includes(f)));
    // 許可リストにない操作を拒否されたら（deny に当てはまるものは除く）、失敗にせず許可を確かめる
    const asked = permissionDenials(result.denials, testerDeny(), deps.repoDir);

    if (out.verdict === "objection") {
      await git.discardAll();
      const objections = (record?.objections ?? 0) + 1;
      const over = objections > limit;
      await store.update(key, {
        objections,
        checkpoint: {
          stage: "testing",
          reason: over ? "objection-limit" : "objection",
        },
      });
      await store.addSummary(key, {
        role: "tester",
        verdict: "objection",
        text: out.summary,
      });
      const questions =
        out.questions.length > 0 ? out.questions : [out.summary];
      const body = [objectionComment(questions, columns.ready)];
      if (over) body.push("", objectionLimitComment(limit));
      // 窓口があれば、質問をスレッドで確かめる
      await blockIssue(deps, issue.number, {
        body: body.join("\n"),
        reason: [
          "受け入れ条件が曖昧で、テスト役が受け入れテストを書けませんでした。次の点を教えてください。",
          ...questions.map((q) => `- ${q}`),
        ].join("\n"),
      });
      return { status: "objection", questions, objections };
    }

    if (asked.rules.length > 0) {
      // 許可を足したら書き直すので、途中のテストは捨てる（失敗としては数えない）
      await git.discardAll();
      await recordPermissionRequest(store, key, {
        role: "tester",
        title: issue.title,
        ...asked,
      });
      return { status: "waiting_permission", rules: asked.rules };
    }

    // 整形してから保護する。実装役が後で整形しても、保護対象が変わらないように
    const formatProblem =
      out.verdict === "approve" && written.length > 0
        ? await formatWritten(deps)
        : undefined;

    const problems =
      out.verdict === "approve"
        ? await verifyTests(
            config,
            issue.number,
            acs,
            out,
            written,
            deps.readFile,
          )
        : [`テスト役が ${out.verdict} を返しました: ${out.summary}`];
    if (written.length === 0)
      problems.push("保護対象のファイルが1つも書かれていません");
    if (formatProblem) problems.push(formatProblem);

    if (problems.length === 0) {
      const commit = await git.commit(
        written,
        `test: #${issue.number} の受け入れテストと seed`,
      );
      await git.push(branch);
      const hash = await git.treeHash("HEAD", hashTargets(config));
      await store.update(key, {
        branch,
        protectedHash: hash,
        checkpoint: { stage: "implementing" },
      });
      await store.addSummary(key, {
        role: "tester",
        verdict: "approve",
        text: out.summary,
      });
      await board.moveIssue(issue.number, columns.implementing);
      return { status: "committed", branch, commit, hash };
    }

    await git.discardAll();
    feedback = [...objection, ...problems];
    if (attempt === maxAttempts) {
      await store.update(key, {
        checkpoint: { stage: "testing", reason: "failed" },
      });
      await store.addSummary(key, {
        role: "tester",
        verdict: "failed",
        text: problems.join("\n"),
      });
      await blockIssue(deps, issue.number, {
        body: failedComment(problems, columns.ready),
        reason: [
          "テスト役が受け入れテストを正しく書けませんでした。",
          ...problems.map((p) => `- ${p}`),
        ].join("\n"),
      });
      return { status: "failed", problems };
    }
  }
  /* c8 ignore next */
  throw new Error("unreachable");
}

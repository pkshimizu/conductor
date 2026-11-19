/**
 * 仕様の作り直し（止まった理由が仕様にあるとき）。
 * 要件の作業用 Issue が Blocked になり、止まったときのスレッドに人が方針を書いたら、
 * 仕様化役に方針と仕様を渡して、仕様の変更が要るかを判断させる。
 * - 要らなければ（specChange: false）、今までどおり方針を Issue に書き写して Ready に戻す（blocked-thread.ts）
 * - 要るなら（specChange: true）、仕様化役が直した docs/specs/ などをブランチにコミットして push し、仕様の PR を作り、
 *   スレッドに要約と PR のリンクを書いて ✅ を待つ（Issue は Blocked のまま）
 * - 要約に許可した人が ✅ を付けたら、仕様の PR をマージする（変更点の書き写しと Ready に戻すのは blocked-thread.ts）
 * 作業用 Issue の作り直し・追加はしない（変更点は Issue への書き写しで伝える）
 */
import { z } from "zod";
import type { Chat } from "./chat.js";
import { roleOutput, type RoleResult, type RoleRun } from "./claude.js";
import type { Config } from "./config.js";
import type { CiResult } from "./github.js";
import type { Git } from "./git.js";
import { matchesAny } from "./git.js";
import { ciFailedHead, ciFailedMessage, isApproved } from "./spec-approval.js";
import { SPEC_DIR, SPECIFIER_WRITABLE, specifierAllow } from "./specifier.js";
import {
  compareMessageIds,
  type RequirementRecord,
  type RespecProgress,
  type Store,
} from "./store.js";

const SPEC_CHANGE_DESCRIPTION =
  "仕様の変更が要るか。要るときは仕様のファイルを直してから true を返す";

/** 仕様化役の、止まった作業用 Issue の方針を受けたときの出力 */
export const respecOutputSchema = roleOutput({
  specChange: z.boolean().describe(SPEC_CHANGE_DESCRIPTION),
});
export type RespecOutput = z.infer<typeof respecOutputSchema>;

export interface RespecBoard {
  /** 前の仕様の PR のファイル（渡す仕様を決める） */
  pullRequestFiles(pr: number): Promise<string[]>;
  findPullRequest(
    head: string,
  ): Promise<{ number: number; url: string } | undefined>;
  /** 仕様の PR は Issue に紐づかないので issue は渡さない */
  createPullRequest(input: {
    head: string;
    title: string;
    body: string;
  }): Promise<{ number: number; url: string }>;
  ciStatus(pr: number): Promise<CiResult>;
  /** マージ済みなら成功として扱う */
  mergePullRequest(pr: number): Promise<void>;
}

export interface RespecDeps {
  /** config.chat がある前提 */
  config: Config;
  repoDir: string;
  chat: Chat;
  store: Store;
  git: Pick<
    Git,
    | "startBranch"
    | "changedFiles"
    | "discard"
    | "discardAll"
    | "commit"
    | "push"
  >;
  board: RespecBoard;
  run: (
    run: RoleRun<typeof respecOutputSchema>,
  ) => Promise<RoleResult<RespecOutput>>;
  /** .conductor/specifier/*.md をまとめたもの */
  instructions: string;
  model?: string;
  log(text: string): void;
}

/** 仕様化役に必ず守らせる決まり（方針を受けて仕様を作り直すとき）。追加指示はこの後に足す */
export const RESPEC_RULES = `あなたは仕様化役です。作業用 Issue が止まり、人が方針を書きました。方針と今の仕様を読み、仕様の変更が要るかを判断します。

- 依頼文に示した仕様ファイルと、必要なら対象リポジトリのコードや文書を読みます。
- 方針が今の仕様の範囲で実装を直せば済むものなら、ファイルを書かずに specChange を false にし、summary に判断の理由を書きます。
- 方針が仕様を変える（仕様に書かれたことと違う、仕様に足りない）ものなら、仕様のファイル（${SPEC_DIR}）を方針どおりに直し、specChange を true にし、summary に変更点の要約を書きます。summary は作業用 Issue にそのまま書き写します。
- 書いてよいのは ${SPECIFIER_WRITABLE.join("・")} だけです。実装コードは書きません。作業用 Issue を作り直したり足したりしません。
- git のコミット・push・ブランチの操作はしません。指揮役が行います。`;

/** 作り直した仕様のブランチ（止まったときのスレッドごとに1本） */
export const respecBranch = (issue: number, threadId: string) =>
  `conductor/respec-${issue}-${threadId}`;

/** 止まった作業用 Issue */
export interface RespecIssue {
  number: number;
  title: string;
}

export function respecPrompt(input: {
  repo: string;
  issue: RespecIssue;
  reason: string;
  policy: string;
  specPr: number;
  specFiles: readonly string[];
}): string {
  return [
    "# 止まった作業用 Issue",
    "",
    `#${input.issue.number} ${input.issue.title}`,
    `https://github.com/${input.repo}/issues/${input.issue.number}`,
    "",
    "# 止まった理由",
    "",
    input.reason.trim(),
    "",
    "# 人が書いた方針",
    "",
    input.policy.trim(),
    "",
    "# 仕様",
    "",
    `仕様の PR #${input.specPr} で承認された仕様ファイルです。読んでください。`,
    "",
    ...input.specFiles.map((f) => `- ${f}`),
    "",
    "# 依頼",
    "",
    "上の方針を受けて、仕様の変更が要るかを判断してください。",
    "- 要らなければ、ファイルを書かずに specChange を false にしてください。",
    "- 要るなら、仕様のファイルを方針どおりに直し、specChange を true にして、summary に変更点の要約を書いてください。",
    "",
    "書いてよいファイル（glob）:",
    ...SPECIFIER_WRITABLE.map((g) => `- ${g}`),
  ].join("\n");
}

/** 作り直した仕様の要約の書き込み（この書き込みへの ✅ を承認とする） */
export function respecSummaryMessage(
  summary: string,
  pr: { url: string },
  issue: number,
  ready: string,
): string {
  return [
    "方針を受けて仕様を作り直しました。",
    "",
    summary.trim(),
    "",
    `PR: ${pr.url}`,
    "",
    `この内容でよければ、この書き込みに ✅ を付けてください。仕様の PR をマージし、変更点を Issue #${issue} に書き写して ${ready} に戻します。直してほしい点は PR に書いてください。`,
  ].join("\n");
}

/** 作り直した仕様の変更点を Issue に書き写すコメント */
export function respecComment(progress: RespecProgress, ready: string): string {
  const quote = (text: string) =>
    text
      .trim()
      .split("\n")
      .map((l) => `> ${l}`);
  return [
    `Discord のスレッドでもらった方針を受けて、仕様を作り直しました（仕様の PR #${progress.pr} をマージしました）。${ready} に戻して続けます。`,
    progress.url,
    "",
    "変更点:",
    "",
    ...quote(progress.summary),
    "",
    "方針:",
    "",
    ...quote(progress.policy),
  ].join("\n");
}

/** Issue を作業用 Issue にしている要件（仕様の PR があるもの） */
async function requirementOf(
  store: Store,
  issue: number,
): Promise<RequirementRecord | undefined> {
  const requirements = await store.listRequirements();
  return requirements.find(
    (r) => r.specPr !== undefined && r.workIssues.includes(issue),
  );
}

export type RespecStart =
  /** 要件の作業用 Issue ではない（今までどおり方針を書き写す） */
  | { status: "skipped" }
  /** 仕様の変更は要らない（今までどおり方針を書き写す） */
  | { status: "unchanged" }
  /** 仕様の PR を作り、要約をスレッドに書いた（✅ を待つ） */
  | { status: "respecified"; progress: RespecProgress };

/** 方針を受けて、仕様化役に仕様の変更が要るかを判断させ、要れば仕様の PR を作って要約をスレッドに書く */
export async function startRespec(
  deps: RespecDeps,
  input: {
    issue: RespecIssue;
    reason: string;
    threadId: string;
    policy: string;
  },
): Promise<RespecStart> {
  const { config, chat, store, git, board } = deps;
  const { issue, threadId, policy } = input;
  const name = `#${issue.number}`;
  const requirement = await requirementOf(store, issue.number);
  const specPr = requirement?.specPr;
  if (specPr === undefined) return { status: "skipped" };

  const changedInSpecPr = await board.pullRequestFiles(specPr);
  const specFiles = changedInSpecPr.filter((f) => f.startsWith(SPEC_DIR));
  const branch = respecBranch(issue.number, threadId);
  // 前の Issue や役の変更を持ち越さないよう、切り替える前に作業ツリーを片付ける
  await git.discardAll();
  try {
    await git.startBranch(branch);
    const result = await deps.run({
      role: "specifier",
      cwd: deps.repoDir,
      systemPrompt: [RESPEC_RULES, deps.instructions]
        .filter(Boolean)
        .join("\n\n"),
      prompt: respecPrompt({
        repo: config.github.repo,
        issue,
        reason: input.reason,
        policy,
        specPr,
        specFiles,
      }),
      schema: respecOutputSchema,
      allow: specifierAllow(config),
      ...(deps.model ? { model: deps.model } : {}),
    });
    const out = result.output;

    // 書いてよいファイルの外の変更は捨てる
    const changed = await git.changedFiles();
    const written = changed.filter((f) => matchesAny(f, SPECIFIER_WRITABLE));
    if (!out.specChange) {
      deps.log(`${name}: 仕様の変更は要らないと判断しました`);
      return { status: "unchanged" };
    }
    if (written.length === 0) {
      deps.log(
        `${name}: 仕様の変更が要ると判断しましたが、仕様のファイルが書かれなかったので、方針を書き写します`,
      );
      return { status: "unchanged" };
    }
    await git.discard(changed.filter((f) => !written.includes(f)));
    await git.commit(written, `docs: #${issue.number} の方針で仕様を直す`);
    await git.push(branch);
    const pr =
      (await board.findPullRequest(branch)) ??
      (await board.createPullRequest({
        head: branch,
        title: `仕様の作り直し: #${issue.number} ${issue.title}`,
        body: [
          `#${issue.number} が止まり、Discord のスレッドでもらった方針を受けて仕様を作り直しました。`,
          "",
          out.summary.trim(),
        ].join("\n"),
      }));
    const summaryId = await chat.post(
      threadId,
      respecSummaryMessage(
        out.summary,
        pr,
        issue.number,
        config.github.columns.ready,
      ),
    );
    deps.log(`${name}: 仕様を作り直し、仕様の PR #${pr.number} を作りました`);
    return {
      status: "respecified",
      progress: {
        policy,
        summary: out.summary.trim(),
        pr: pr.number,
        url: pr.url,
        summaryId,
      },
    };
  } finally {
    // 失敗したときも、作業ツリーに変更を残さない
    await git.discardAll();
  }
}

export type RespecCheckStatus =
  /** ✅ がまだ無い */
  | "waiting"
  /** 承認されたが CI がまだ終わっていない */
  | "ci_pending"
  /** 承認されたが CI が失敗している */
  | "ci_failed"
  /** 仕様の PR をマージした */
  | "merged";

/** 作り直した仕様の要約への ✅ を確かめ、承認されていれば仕様の PR をマージする */
export async function checkRespec(
  deps: RespecDeps,
  threadId: string,
  progress: RespecProgress,
): Promise<{ status: RespecCheckStatus }> {
  const { config, chat, board } = deps;
  const allowed = new Set(config.chat?.allowed_users ?? []);
  const reactions = await chat.readReactions(threadId, progress.summaryId);
  if (!isApproved(reactions, allowed)) return { status: "waiting" };

  const ci = await board.ciStatus(progress.pr);
  if (ci.state === "pending") return { status: "ci_pending" };
  if (ci.state === "failure") {
    // 同じ要約に対しては1回だけ書く（確認のたびに書かない）
    const botId = await chat.selfId();
    const head = ciFailedHead(progress.pr);
    const thread = await chat.readMessages(threadId);
    const told = thread.some(
      (m) =>
        m.authorId === botId &&
        compareMessageIds(m.id, progress.summaryId) > 0 &&
        m.text.startsWith(head),
    );
    if (!told) await chat.post(threadId, ciFailedMessage(progress.pr, ci));
    return { status: "ci_failed" };
  }
  await board.mergePullRequest(progress.pr); // マージ済みなら成功として扱う
  deps.log(`作り直した仕様の PR #${progress.pr} をマージしました`);
  return { status: "merged" };
}

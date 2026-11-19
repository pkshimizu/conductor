/**
 * 仕様化役。要件の疑問を人にスレッドで聞き、疑問がなくなったら仕様を対象リポジトリの Markdown にして PR を作る。
 * - 疑問があれば、番号とおすすめの答えつきで1つの書き込みにまとめてスレッドに書く（質問の数を記録する）
 * - 疑問がなければ、docs/specs/ と .conductor/knowledge/ の変更を要件ごとのブランチ1本にコミットして PR にする
 * - 要約の後の ✅ 以外の書き込みは修正の依頼。同じブランチ・同じ PR を直して要約を書き直す
 * - 前回読んだ位置より後に、許可した人の書き込みが無ければ何もしない（催促しない）
 * - 毎回新しく起動し、要件とスレッドのやり取りをすべて渡す
 */
import { z } from "zod";
import type { Chat, ChatMessage } from "./chat.js";
import { roleOutput, type RoleResult, type RoleRun } from "./claude.js";
import type { Config } from "./config.js";
import type { Git } from "./git.js";
import { matchesAny } from "./git.js";
import { threadName } from "./requirements.js";
import {
  compareMessageIds,
  type RequirementRecord,
  type Store,
} from "./store.js";

export const specifierOutputSchema = roleOutput({
  questions: z
    .array(
      z
        .object({
          question: z.string().describe("疑問"),
          recommendation: z.string().describe("おすすめの答え"),
        })
        .strict(),
    )
    .describe("人に聞きたい疑問。無ければ空配列（そのときは仕様を書く）"),
});
export type SpecifierOutput = z.infer<typeof specifierOutputSchema>;

/** 仕様を置くフォルダ */
export const SPEC_DIR = "docs/specs/";
/** 他の機能にも使える方針を置くフォルダ */
export const KNOWLEDGE_DIR = ".conductor/knowledge/";

/** 仕様化役が書いてよいファイル */
export const SPECIFIER_WRITABLE = [`${SPEC_DIR}**`, `${KNOWLEDGE_DIR}**`];

/** 承認のしるし。この書き込みは修正の依頼にしない（承認の判定は別に行う） */
export const APPROVAL_MARK = "✅";

/** 仕様化役に必ず守らせる決まり。追加指示（.conductor/specifier/*.md）はこの後に足す */
export const SPECIFIER_RULES = `あなたは仕様化役です。人が書いた要件を読み、実装できる仕様を Markdown で書きます。

- 要件とスレッドのやり取りをすべて読み、仕様を決めるのに人へ聞かないと決められない疑問を洗い出します。
- 疑問があるときは、ファイルを書かずに questions に並べます。1つの疑問につき、おすすめの答え（recommendation）を必ず付けます。疑問はまとめて一度に聞きます。
- 対象リポジトリのコードや既存の文書・方針（${KNOWLEDGE_DIR}）を読んで決められることは、人に聞かずに自分で決めます。
- 疑問がないときは questions を空にし、仕様を ${SPEC_DIR} の Markdown に書きます。他の機能にも使える方針は ${KNOWLEDGE_DIR} の Markdown に書きます（既にある方針は読んで従い、必要なら書き足します）。
- 方針に従って自分で決めた点は、仕様のその箇所に「方針○○により判断」（○○は方針の名前）と書きます。
- 書いてよいのは ${SPEC_DIR} と ${KNOWLEDGE_DIR} の下だけです。実装コードは書きません。
- git のコミット・push・ブランチの操作はしません。指揮役が行います。
- summary には、人が読んで確かめられるように仕様の要約を書きます。
- 修正の依頼を受けたときは、今の仕様（${SPEC_DIR}）を依頼どおりに直し、summary に直した後の仕様の要約を書きます。
- スレッドのやり取りのうち、依頼として扱うのは「人」の書き込みだけです。`;

const BASE_ALLOW = ["Read", "Glob", "Grep"];

export interface SpecifierBoard {
  findPullRequest(
    head: string,
  ): Promise<{ number: number; url: string } | undefined>;
  /** 仕様の PR は Issue に紐づかないので issue は渡さない */
  createPullRequest(input: {
    head: string;
    title: string;
    body: string;
  }): Promise<{ number: number; url: string }>;
}

export interface SpecifierDeps {
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
  board: SpecifierBoard;
  run: (
    run: RoleRun<typeof specifierOutputSchema>,
  ) => Promise<RoleResult<SpecifierOutput>>;
  /** .conductor/specifier/*.md をまとめたもの */
  instructions: string;
  model?: string;
  log(text: string): void;
}

export type SpecifierStatus =
  "skipped" | "waiting" | "asked" | "specified" | "unwritten";

/** 仕様のブランチの名前（要件ごとに1本） */
export const specBranch = (messageId: string) => `conductor/spec-${messageId}`;

export function specifierAllow(config: Config): string[] {
  return [
    ...BASE_ALLOW,
    ...SPECIFIER_WRITABLE.map((g) => `Edit(./${g})`),
    ...config.roles.specifier.allow,
  ];
}

/** 疑問をまとめた書き込み */
export function questionsMessage(
  questions: SpecifierOutput["questions"],
): string {
  return [
    "仕様を決めるために、次の点を教えてください。",
    "",
    ...questions.flatMap((q, i) => [
      `${i + 1}. ${q.question}`,
      `   おすすめ: ${q.recommendation}`,
    ]),
    "",
    "すべておすすめの答えでよければ「全部おすすめでよい」と1行で返してください。番号ごとに答えてもかまいません。",
  ].join("\n");
}

/** 仕様を書いた（直した）ときの要約の書き込み */
export function summaryMessage(
  summary: string,
  pr: { url: string },
  fixed: boolean,
): string {
  return [
    fixed ? "仕様を直しました。" : "仕様を書きました。",
    "",
    summary.trim(),
    "",
    `PR: ${pr.url}`,
    "",
    "直してほしい点があれば、このスレッドに書いてください。",
  ].join("\n");
}

/** 仕様のファイルが書かれなかったときの書き込み */
export function unwrittenMessage(summary: string): string {
  return [
    `仕様のファイル（${SPEC_DIR}）が書かれませんでした。`,
    "",
    summary.trim(),
    "",
    "補足があればこのスレッドに書いてください。もう一度仕様化します。",
  ].join("\n");
}

/** 引用の形（"> "）を外す */
function unquote(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/^> ?/, ""))
    .join("\n");
}

function speaker(message: ChatMessage, allowed: ReadonlySet<string>): string {
  return allowed.has(message.authorId)
    ? `人（<@${message.authorId}>）`
    : "conductor";
}

export function specifierPrompt(input: {
  requirement: string;
  thread: readonly ChatMessage[];
  allowed: ReadonlySet<string>;
  /** 仕様の PR があれば修正の依頼 */
  pr?: { number: number; url?: string };
  /** 前回の確認より後の人の書き込み */
  requests: readonly ChatMessage[];
}): string {
  const lines = [
    "# 要件",
    "",
    input.requirement.trim(),
    "",
    "# スレッドのやり取り（古い順）",
  ];
  for (const m of input.thread) {
    lines.push("", `## ${speaker(m, input.allowed)}`, "", m.text.trim());
  }
  lines.push("", "# 依頼");
  if (input.pr) {
    lines.push(
      `仕様の PR #${input.pr.number}${input.pr.url ? `（${input.pr.url}）` : ""}への修正の依頼です。次の書き込みのとおりに、今の仕様を直してください。`,
      "",
      ...input.requests.map((m) => `- ${m.text.trim()}`),
      "",
      "直すために人に聞かないと決められない疑問があれば、ファイルを書かずに questions に並べてください。",
    );
  } else {
    lines.push(
      "上の要件とやり取りをもとに、疑問があれば questions に並べてください（ファイルは書かない）。",
      `疑問がなければ、仕様を ${SPEC_DIR} に、他の機能にも使える方針を ${KNOWLEDGE_DIR} に書いてください。`,
    );
  }
  lines.push(
    "",
    "書いてよいファイル（glob）:",
    ...SPECIFIER_WRITABLE.map((g) => `- ${g}`),
  );
  return lines.join("\n");
}

/** 要件1件を1回分進める。やることが無ければ何もしない */
export async function runSpecifier(
  deps: SpecifierDeps,
  requirement: RequirementRecord,
): Promise<{ status: SpecifierStatus }> {
  const { config, chat, store, git, board } = deps;
  const chatConfig = config.chat;
  const threadId = requirement.threadId;
  if (chatConfig === undefined || threadId === undefined) {
    return { status: "skipped" };
  }
  const allowed = new Set(chatConfig.allowed_users);

  // 前回読んだ位置より後の、許可した人の書き込みだけを見る。無ければ何もしない（催促しない）
  const position = await store.getReadPosition(threadId);
  const thread = await chat.readMessages(threadId);
  const fresh =
    position === undefined
      ? []
      : thread.filter(
          (m) =>
            compareMessageIds(m.id, position) > 0 && allowed.has(m.authorId),
        );
  // 要約の後の ✅ は修正の依頼にしない
  const requests =
    requirement.specPr === undefined
      ? fresh
      : fresh.filter((m) => m.text.trim() !== APPROVAL_MARK);
  if (position !== undefined && requests.length === 0) {
    return { status: "waiting" };
  }

  // 要件の本文はスレッドの最初の引用（受け取りのときに書いたもの）
  const requirementText = unquote(thread[0]?.text ?? "");
  const branch = specBranch(requirement.messageId);
  const pr =
    requirement.specPr === undefined
      ? undefined
      : await board.findPullRequest(branch);
  // PR があればそのブランチの続きから、無ければ main から作る
  if (requirement.specPr === undefined) await git.startBranch(branch);
  else await git.startBranch(branch, branch);

  const result = await deps.run({
    role: "specifier",
    cwd: deps.repoDir,
    systemPrompt: [SPECIFIER_RULES, deps.instructions]
      .filter(Boolean)
      .join("\n\n"),
    prompt: specifierPrompt({
      requirement: requirementText,
      thread,
      allowed,
      ...(requirement.specPr === undefined
        ? {}
        : {
            pr: {
              number: requirement.specPr,
              ...(pr === undefined ? {} : { url: pr.url }),
            },
          }),
      requests,
    }),
    schema: specifierOutputSchema,
    allow: specifierAllow(config),
    ...(deps.model ? { model: deps.model } : {}),
  });
  const out = result.output;

  // 書いてよいファイルの外の変更は捨てる
  const changed = await git.changedFiles();
  const written = changed.filter((f) => matchesAny(f, SPECIFIER_WRITABLE));
  await git.discard(changed.filter((f) => !written.includes(f)));

  const readUpTo = async (posted: string) => {
    // 役が動いている間に書かれた人の書き込みを取りこぼさないよう、起動前に読んだ最後の位置にする
    await store.setReadPosition(threadId, thread.at(-1)?.id ?? posted);
  };

  if (out.questions.length > 0) {
    await git.discardAll();
    const posted = await chat.post(threadId, questionsMessage(out.questions));
    const current = await store.getRequirement(requirement.messageId);
    await store.updateRequirement(requirement.messageId, {
      questions: (current?.questions ?? 0) + out.questions.length,
    });
    await readUpTo(posted);
    deps.log(
      `要件 ${requirement.messageId}: 疑問を ${out.questions.length} 件書きました`,
    );
    return { status: "asked" };
  }

  if (written.length === 0 && pr === undefined) {
    await git.discardAll();
    const posted = await chat.post(threadId, unwrittenMessage(out.summary));
    await readUpTo(posted);
    deps.log(
      `要件 ${requirement.messageId}: 仕様のファイルが書かれませんでした`,
    );
    return { status: "unwritten" };
  }

  const name = threadName(requirementText);
  if (written.length > 0) {
    await git.commit(
      written,
      pr === undefined
        ? `docs: 仕様「${name}」`
        : `docs: 仕様「${name}」を直す`,
    );
    await git.push(branch);
  }
  const specPr =
    pr ??
    (await board.findPullRequest(branch)) ??
    (await board.createPullRequest({
      head: branch,
      title: `仕様: ${name}`,
      body: out.summary,
    }));
  await store.updateRequirement(requirement.messageId, {
    specPr: specPr.number,
    state: "awaiting_approval",
  });
  const posted = await chat.post(
    threadId,
    summaryMessage(out.summary, specPr, pr !== undefined),
  );
  await readUpTo(posted);
  deps.log(
    `要件 ${requirement.messageId}: 仕様の PR #${specPr.number} を${pr === undefined ? "作りました" : "直しました"}`,
  );
  return { status: "specified" };
}

/**
 * 分解役。承認された仕様を作業用 Issue に分ける。
 * - 分解役は Issue の中身（目的・AC・画面の URL と文言・対象外）と順番（先に済ませる Issue）を JSON で返すだけ。
 *   Issue を作らない・ファイルを書かない（許可は読むだけ）
 * - conductor が JSON を入口確認と同じ書式（D8）で組み立てて確かめ、仕様ファイルへのリンクを付けて Issue を作り、
 *   Project に追加し、作業の順番を記録する（列は動かさない。Ready に移すのは別の段階）
 * - 書式の誤り・無い key・順番の循環があれば、Issue を1件も作らずに誤りを示してやり直させる。
 *   やり直しは config.limits.rejections 回まで。それでも誤りがあれば、スレッドに理由を書いて要件を止める（blocked）
 * - 作り終えたら、Issue の一覧を作業の順番でスレッドに書く（一覧の承認は取らない）
 * - 確かめた結果と作り終えた Issue は1件ごとに記録する。途中で失敗したら、次の確認で
 *   分解役を起動し直さずに残りだけを作り、一覧を書く（一覧を書き終えてから workIssues を入れる）
 */
import { z } from "zod";
import type { Chat } from "./chat.js";
import { roleOutput, type RoleResult, type RoleRun } from "./claude.js";
import type { Config } from "./config.js";
import { checkIssueBody } from "./intake.js";
import { SPEC_DIR } from "./specifier.js";
import type {
  CreatedWorkIssue,
  Decomposition,
  RequirementRecord,
  Store,
} from "./store.js";

const KEY_DESCRIPTION =
  "この Issue の仮の名前（dependsOn で指す。Issue 番号はまだ無い）";
const ACCEPTANCE_DESCRIPTION =
  "「受け入れ条件（AC）」。AC ごとに '- AC1' の下に '  - Given …'・'  - When …'・'  - Then …' を書く";

/** 作業用 Issue 1件分。D8（入口確認の書式）の見出しに合わせた項目を持つ */
export const workIssueSchema = z
  .object({
    key: z.string().describe(KEY_DESCRIPTION),
    title: z.string().describe("Issue のタイトル"),
    purpose: z.string().describe("「目的」"),
    acceptance: z.string().describe(ACCEPTANCE_DESCRIPTION),
    screens: z.string().describe("「画面の URL・文言」。無ければ「なし」"),
    outOfScope: z.string().describe("「対象外」"),
    dependsOn: z.array(z.string()).describe("先に済ませる Issue の key"),
  })
  .strict();
export type WorkIssue = z.infer<typeof workIssueSchema>;

export const decomposerOutputSchema = roleOutput({
  issues: z.array(workIssueSchema).describe("作業用 Issue（1件以上）"),
});
export type DecomposerOutput = z.infer<typeof decomposerOutputSchema>;

export interface DecomposerBoard {
  /** 仕様の PR で変えたファイル（仕様ファイル docs/specs/ を探すのに使う） */
  pullRequestFiles(pr: number): Promise<string[]>;
  /** Issue を作る */
  createIssue(input: {
    title: string;
    body: string;
  }): Promise<{ number: number; url: string }>;
  /** Issue を Project に追加する（列は動かさない。Ready に移すのは次の Issue） */
  addToProject(issue: number): Promise<void>;
  /** 既定のブランチ（仕様ファイルへのリンクに使う）。無ければ HEAD へのリンクにする */
  baseBranch?(): Promise<string>;
}

export interface DecomposerDeps {
  /** config.chat がある前提 */
  config: Config;
  repoDir: string;
  chat: Chat;
  store: Store;
  board: DecomposerBoard;
  run: (
    run: RoleRun<typeof decomposerOutputSchema>,
  ) => Promise<RoleResult<DecomposerOutput>>;
  /** .conductor/decomposer/*.md をまとめたもの */
  instructions: string;
  model?: string;
  log(text: string): void;
}

export type DecomposerStatus =
  | "skipped"
  /** 作業用 Issue を作った */
  | "decomposed"
  /** 上限までやり直しても誤りが残ったので要件を止めた */
  | "blocked";

/** 分解役に必ず守らせる決まり。追加指示（.conductor/decomposer/*.md）はこの後に足す */
export const DECOMPOSER_RULES = `あなたは分解役です。承認された仕様を読み、実装の単位ごとの作業用 Issue に分けます。

- 依頼文に示した仕様ファイルを読みます。必要なら対象リポジトリのコードや文書も読みます。
- ファイルは書きません。Issue も作りません。結果の issues に Issue の中身を並べるだけです（Issue の作成は指揮役が行います）。
- 1つの Issue は、1つの PR で実装してレビューできる大きさにします。
- 各 Issue には、目的（purpose）・受け入れ条件（acceptance）・画面の URL と文言（screens）・対象外（outOfScope）を書きます。どれも空にしません。画面を作らない Issue の screens は「なし」と書きます。
- 受け入れ条件は "- AC1" のように番号を付け、その下に "  - Given …"・"  - When …"・"  - Then …" を必ず1つずつ書きます。
- 各 Issue に key（仮の名前）を付けます。key は issues の中で重ならないようにします。
- 先に済ませる必要のある Issue があれば、その key を dependsOn に書きます。順番が循環しないようにします。
- summary には、どう分けたかの要約を書きます。`;

const BASE_ALLOW = ["Read", "Glob", "Grep"];
/** 分解役に渡さない操作（書き込み・コマンド） */
const DENY = ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"];

export function decomposerAllow(config: Config): string[] {
  return [...BASE_ALLOW, ...config.roles.decomposer.allow];
}

/** Issue の本文の見出し（intake.ts の REQUIRED_SECTIONS と同じ名前） */
const SECTION = {
  purpose: "目的",
  acceptance: "受け入れ条件（AC）",
  screens: "画面の URL・文言",
  outOfScope: "対象外",
  prerequisites: "先に済ませる Issue",
  specs: "仕様",
} as const;

/** 作業用 Issue の本文を D8 の見出しで組み立てる */
export function workIssueBody(
  issue: WorkIssue,
  prerequisites: readonly number[],
  specLinks: readonly string[],
): string {
  return [
    `## ${SECTION.purpose}`,
    issue.purpose.trim(),
    "",
    `## ${SECTION.acceptance}`,
    issue.acceptance.trim(),
    "",
    `## ${SECTION.screens}`,
    issue.screens.trim(),
    "",
    `## ${SECTION.outOfScope}`,
    issue.outOfScope.trim(),
    "",
    `## ${SECTION.prerequisites}`,
    prerequisites.length === 0
      ? "なし"
      : prerequisites.map((n) => `- #${n}`).join("\n"),
    "",
    `## ${SECTION.specs}`,
    specLinks.map((l) => `- ${l}`).join("\n"),
    "",
  ].join("\n");
}

/** 仕様ファイルへのリンク */
export function specLink(repo: string, branch: string, file: string): string {
  const encode = (p: string) => p.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${repo}/blob/${encode(branch)}/${encode(file)}`;
}

/** 依存の循環を1つ探す。見つかれば key の並び（最初と最後が同じ）、無ければ undefined */
export function findCycle(issues: readonly WorkIssue[]): string[] | undefined {
  const deps = new Map(issues.map((i) => [i.key, i.dependsOn]));
  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];
  const visit = (key: string): string[] | undefined => {
    const s = state.get(key);
    if (s === "done") return undefined;
    if (s === "visiting") return [...path.slice(path.indexOf(key)), key];
    state.set(key, "visiting");
    path.push(key);
    for (const d of deps.get(key) ?? []) {
      if (!deps.has(d)) continue;
      const found = visit(d);
      if (found) return found;
    }
    path.pop();
    state.set(key, "done");
    return undefined;
  };
  for (const i of issues) {
    const found = visit(i.key);
    if (found) return found;
  }
  return undefined;
}

/**
 * 作業の順番（先に済ませるものが前）に並べる。同じ段では分解役が返した順を保つ。
 * 循環が無く、dependsOn がすべて issues の key を指している前提
 */
export function workOrder(issues: readonly WorkIssue[]): WorkIssue[] {
  const ordered: WorkIssue[] = [];
  const placed = new Set<string>();
  const rest = [...issues];
  while (rest.length > 0) {
    const index = rest.findIndex((i) =>
      i.dependsOn.every((d) => placed.has(d)),
    );
    if (index < 0) throw new Error("先に済ませる Issue が循環しています");
    const [next] = rest.splice(index, 1);
    if (next === undefined) break;
    ordered.push(next);
    placed.add(next.key);
  }
  return ordered;
}

/** 誤りの一覧を返す。空なら Issue を作ってよい */
export function checkDecomposition(issues: readonly WorkIssue[]): string[] {
  if (issues.length === 0) return ["作業用 Issue が1件もありません"];
  const problems: string[] = [];
  const keys = new Set<string>();
  for (const i of issues) {
    const name = `「${i.key}」（${i.title}）`;
    if (i.key.trim() === "") problems.push(`${name}: key が空です`);
    else if (keys.has(i.key)) problems.push(`${name}: key が重なっています`);
    keys.add(i.key);
    if (i.title.trim() === "") problems.push(`${name}: タイトルが空です`);
    // 番号はまだ無いので、本文の形だけを確かめる
    for (const p of checkIssueBody(workIssueBody(i, [], []))) {
      problems.push(`${name}: ${p}`);
    }
  }
  for (const i of issues) {
    for (const d of i.dependsOn) {
      if (!keys.has(d)) {
        problems.push(
          `「${i.key}」（${i.title}）: 先に済ませる Issue「${d}」がありません`,
        );
      }
    }
  }
  const cycle = findCycle(issues);
  if (cycle) {
    problems.push(`先に済ませる Issue が循環しています: ${cycle.join(" → ")}`);
  }
  return problems;
}

export function decomposerPrompt(input: {
  requirement?: string;
  specPr: number;
  specFiles: readonly string[];
  /** やり直しのときの、前回の結果と誤り */
  retry?: { issues: readonly WorkIssue[]; problems: readonly string[] };
}): string {
  const lines: string[] = [];
  if (input.requirement !== undefined) {
    lines.push("# 要件", "", input.requirement.trim(), "");
  }
  lines.push(
    "# 仕様",
    "",
    `仕様の PR #${input.specPr} で承認された仕様ファイルです。読んでください。`,
    "",
    ...input.specFiles.map((f) => `- ${f}`),
    "",
    "# 依頼",
    "",
    "上の仕様を作業用 Issue に分け、issues に並べてください。ファイルは書かず、Issue も作りません。",
  );
  if (input.retry) {
    lines.push(
      "",
      "# やり直し",
      "",
      "前回の結果に次の誤りがありました。直した結果をすべて返してください（作業用 Issue はまだ1件も作っていません）。",
      "",
      ...input.retry.problems.map((p) => `- ${p}`),
      "",
      "前回の issues:",
      "",
      "```json",
      JSON.stringify(input.retry.issues, null, 2),
      "```",
    );
  }
  return lines.join("\n");
}

/** 作った Issue の一覧の書き込み（作業の順番） */
export function workIssuesMessage(
  created: readonly {
    number: number;
    title: string;
    url: string;
    prerequisites: readonly number[];
  }[],
): string {
  const prerequisites = (numbers: readonly number[]) =>
    numbers.length === 0 ? "なし" : numbers.map((n) => `#${n}`).join("、");
  return [
    `仕様を作業用 Issue ${created.length} 件に分けました。作業の順番に並べています。`,
    "",
    ...created.flatMap((c, i) => [
      `${i + 1}. #${c.number} ${c.title}`,
      `   ${c.url}`,
      `   先に済ませる Issue: ${prerequisites(c.prerequisites)}`,
    ]),
  ].join("\n");
}

/** 分けられなかったので止めたときの書き込み。attempts が 0 なら分解役を起動する前に止めた */
export function blockedMessage(
  attempts: number,
  problems: readonly string[],
): string {
  return [
    attempts === 0
      ? "作業用 Issue に分けられないため、この要件を止めました。理由:"
      : `分解役を ${attempts} 回起動しても作業用 Issue に分けられなかったため、この要件を止めました。最後の誤り:`,
    "",
    ...problems.map((p) => `- ${p}`),
    "",
    "仕様を確かめてください。",
  ].join("\n");
}

/** 引用の形（"> "）を外す */
function unquote(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/^> ?/, ""))
    .join("\n");
}

/** 分解に進めた要件1件を分解する（作業用 Issue を作り終えていれば何もしない） */
export async function runDecomposer(
  deps: DecomposerDeps,
  requirement: RequirementRecord,
): Promise<{ status: DecomposerStatus }> {
  const { config, chat, store, board } = deps;
  const { threadId, specPr } = requirement;
  if (
    config.chat === undefined ||
    threadId === undefined ||
    specPr === undefined ||
    requirement.state !== "working" ||
    requirement.workIssues.length > 0
  ) {
    return { status: "skipped" };
  }
  const name = `要件 ${requirement.messageId}`;

  // 前の確認で作りかけていれば、分解役を起動し直さずに続きから作る
  if (requirement.decomposition !== undefined) {
    deps.log(`${name}: 作りかけの作業用 Issue の続きを作ります`);
    await finishDecomposition(
      deps,
      requirement,
      threadId,
      requirement.decomposition,
    );
    return { status: "decomposed" };
  }

  const changed = await board.pullRequestFiles(specPr);
  const specFiles = changed.filter((f) => f.startsWith(SPEC_DIR));
  if (specFiles.length === 0) {
    return block(threadId, 0, [
      `仕様の PR #${specPr} に仕様ファイル（${SPEC_DIR}）がありません`,
    ]);
  }

  // 要件の本文は、スレッドの Bot の最初の書き込み（受け取りのときに書いた引用）
  const botId = await chat.selfId();
  const thread = await chat.readMessages(threadId);
  const quoted = thread.find((m) => m.authorId === botId);
  const requirementText = quoted && unquote(quoted.text);

  const attempts = config.limits.rejections + 1;
  let retry: { issues: WorkIssue[]; problems: string[] } | undefined;
  for (let n = 1; n <= attempts; n++) {
    const result = await deps.run({
      role: "decomposer",
      cwd: deps.repoDir,
      systemPrompt: [DECOMPOSER_RULES, deps.instructions]
        .filter(Boolean)
        .join("\n\n"),
      prompt: decomposerPrompt({
        ...(requirementText === undefined
          ? {}
          : { requirement: requirementText }),
        specPr,
        specFiles,
        ...(retry === undefined ? {} : { retry }),
      }),
      schema: decomposerOutputSchema,
      allow: decomposerAllow(config),
      deny: DENY,
      ...(deps.model ? { model: deps.model } : {}),
    });
    const issues = result.output.issues;
    const problems = checkDecomposition(issues);
    if (problems.length === 0) {
      const branch = board.baseBranch ? await board.baseBranch() : "HEAD";
      const decomposition: Decomposition = {
        issues: workOrder(issues),
        specLinks: specFiles.map((f) =>
          specLink(config.github.repo, branch, f),
        ),
        created: [],
      };
      // 作り始める前に結果を残す（途中で失敗しても、分解役を起動し直さずに続きから作る）
      await store.updateRequirement(requirement.messageId, { decomposition });
      await finishDecomposition(deps, requirement, threadId, decomposition);
      return { status: "decomposed" };
    }
    deps.log(
      `${name}: 分解役の結果に誤りがあります（${n}/${attempts} 回目）: ${problems.join(" / ")}`,
    );
    retry = { issues, problems };
  }
  return block(threadId, attempts, retry?.problems ?? []);

  async function block(
    threadId: string,
    count: number,
    problems: readonly string[],
  ): Promise<{ status: DecomposerStatus }> {
    await chat.post(threadId, blockedMessage(count, problems));
    // 書き込むとアーカイブが外れるので、アーカイブし直す
    await chat.archiveThread(threadId);
    await store.updateRequirement(requirement.messageId, { state: "blocked" });
    deps.log(`${name}: 作業用 Issue に分けられないので止めました`);
    return { status: "blocked" };
  }
}

/**
 * 記録した分解の結果から、まだ作っていない Issue を作り、Project に追加し、一覧を書く。
 * 1件ごとに記録を残すので、途中で失敗しても次の確認で続きからやり直せる。
 * 一覧を書き終えてから workIssues を入れる（入っていれば分解済み）
 */
async function finishDecomposition(
  deps: DecomposerDeps,
  requirement: RequirementRecord,
  threadId: string,
  start: Decomposition,
): Promise<void> {
  const { chat, store, board } = deps;
  const name = `要件 ${requirement.messageId}`;
  const created: CreatedWorkIssue[] = start.created.map((c) => ({ ...c }));
  const save = () =>
    store.updateRequirement(requirement.messageId, {
      decomposition: { ...start, created },
    });
  const numbers = new Map(created.map((c) => [c.key, c.number]));
  const prerequisitesOf = (issue: WorkIssue) =>
    issue.dependsOn.flatMap((d) => {
      const n = numbers.get(d);
      return n === undefined ? [] : [n];
    });

  // 先に済ませる Issue から作る（本文に番号を書くため）。issues は作業の順番に並べてある
  for (const issue of start.issues) {
    let made = created.find((c) => c.key === issue.key);
    if (made === undefined) {
      const result = await board.createIssue({
        title: issue.title.trim(),
        body: workIssueBody(issue, prerequisitesOf(issue), start.specLinks),
      });
      made = { key: issue.key, ...result, inProject: false };
      created.push(made);
      numbers.set(issue.key, made.number);
      await save();
      deps.log(`${name}: 作業用 Issue #${made.number} を作りました`);
    }
    if (!made.inProject) {
      await board.addToProject(made.number);
      made.inProject = true;
      await save();
    }
  }

  const ordered = start.issues.flatMap((issue) => {
    const c = created.find((x) => x.key === issue.key);
    return c === undefined
      ? []
      : [
          {
            number: c.number,
            title: issue.title.trim(),
            url: c.url,
            prerequisites: prerequisitesOf(issue),
          },
        ];
  });
  await chat.post(threadId, workIssuesMessage(ordered));
  await store.updateRequirement(requirement.messageId, {
    workIssues: ordered.map((c) => c.number),
    decomposition: undefined,
  });
  // 書き込むとアーカイブが外れるので、アーカイブし直す
  await chat.archiveThread(threadId);
}

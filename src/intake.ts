import { blockIssue } from "./blocked-thread.js";
import type { Config } from "./config.js";
import type { GitHub } from "./github.js";
import {
  cachedStatusOf,
  type ProgressBoard,
  prerequisiteState,
  type WorkIssueStatus,
} from "./progress.js";
import type { Store } from "./store.js";

/**
 * Issue の入口確認。書き漏れのある Issue を、テスト役に渡す前に止める。
 * 中身の曖昧さは見ない（テスト役の異議で扱う）。見るのは形だけ。
 */

/** Issue に必須の見出し。templates/issue-form.yml の label と同じ */
export const REQUIRED_SECTIONS = [
  "目的",
  "受け入れ条件（AC）",
  "画面の URL・文言",
  "対象外",
] as const;

const AC_SECTION = "受け入れ条件（AC）";

/** Issue フォームで空欄だったときに GitHub が入れる文字 */
const NO_RESPONSE = "_No response_";

/** 本文を「## 見出し」「### 見出し」で区切る。見出しより前の文は捨てる */
export function parseSections(body: string): Map<string, string> {
  const sections = new Map<string, string>();
  let current: string | undefined;
  let lines: string[] = [];
  const flush = () => {
    if (current !== undefined && !sections.has(current)) {
      sections.set(current, lines.join("\n").trim());
    }
  };
  for (const line of body.replace(/\r\n?/g, "\n").split("\n")) {
    const m = /^#{2,3}\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      flush();
      current = m[1]!;
      lines = [];
    } else {
      lines.push(line);
    }
  }
  flush();
  return sections;
}

function isEmpty(text: string | undefined): boolean {
  return text === undefined || text === "" || text === NO_RESPONSE;
}

/** 受け入れ条件の形を確かめる。AC ごとに Given/When/Then の中身があること */
function checkAcceptance(text: string): string[] {
  const problems: string[] = [];
  const acs: { name: string; lines: string[] }[] = [];
  for (const line of text.split("\n")) {
    const ac = /^\s*[-*]\s*(AC\d+)\b/.exec(line);
    if (ac) {
      acs.push({ name: ac[1]!, lines: [] });
    } else {
      acs.at(-1)?.lines.push(line);
    }
  }
  if (acs.length === 0) {
    return [`「${AC_SECTION}」に AC1 のような番号付きの項目がありません`];
  }
  for (const { name, lines } of acs) {
    for (const key of ["Given", "When", "Then"]) {
      const found = lines
        .map((l) => new RegExp(`^\\s*[-*]\\s*${key}\\b(.*)$`).exec(l))
        .find((m) => m !== null);
      if (!found) {
        problems.push(`${name} に ${key} がありません`);
      } else if (found[1]!.replace(/^[\s:：]+/, "").trim() === "") {
        problems.push(`${name} の ${key} が空です`);
      }
    }
  }
  return problems;
}

/** 受け入れ条件の AC 番号（例: ["AC1", "AC2"]）を書かれた順に返す */
export function listAcceptance(body: string): string[] {
  const text = parseSections(body).get(AC_SECTION) ?? "";
  const ids: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*[-*]\s*(AC\d+)\b/.exec(line);
    if (m && !ids.includes(m[1]!)) ids.push(m[1]!);
  }
  return ids;
}

/** 書き漏れの一覧を返す。空ならそろっている */
export function checkIssueBody(body: string): string[] {
  const sections = parseSections(body);
  const problems: string[] = [];
  for (const name of REQUIRED_SECTIONS) {
    const text = sections.get(name);
    if (text === undefined) {
      problems.push(`「${name}」の見出しがありません`);
    } else if (isEmpty(text)) {
      problems.push(`「${name}」が空です`);
    }
  }
  const ac = sections.get(AC_SECTION);
  if (!isEmpty(ac)) problems.push(...checkAcceptance(ac!));
  return problems;
}

/** 入口確認で使う GitHub の操作 */
export type IntakeBoard = Pick<GitHub, "moveIssue" | "comment"> &
  Pick<ProgressBoard, "workIssueStatus">;

export type IntakeResult =
  /** 始めた（テスト役の列に移した） */
  | { accepted: true }
  /** Blocked にした */
  | { accepted: false; problems: string[] }
  /** 待つ（Ready に残す）。waiting はまだ開いている「先に済ませる Issue」 */
  | { accepted: false; waiting: number[] };

export interface IntakeDeps {
  config: Config;
  store: Store;
  board: IntakeBoard;
  log(text: string): void;
}

/** リポジトリに無い「先に済ませる Issue」の書き漏れ */
export function missingPrerequisiteProblem(issue: number): string {
  return `「先に済ませる Issue」の #${issue} がリポジトリに見つかりません`;
}

/**
 * Ready の Issue を拾う。
 * - 書き漏れがあれば（「先に済ませる Issue」の状態にかかわらず）Blocked に移し、欠けた項目をコメントする
 *   （窓口があればメンションせずスレッドで、無ければメンションして確かめる）
 * - 「先に済ませる Issue」にリポジトリに無い番号があれば、書き漏れと同じく Blocked に移す
 * - 「先に済ませる Issue」にまだ開いている Issue があれば、動かさずコメントもせずに待つ
 * - そろっていればテスト役の列へ移す
 * statusOf を渡せば、同じ確認の中で Issue ごとの問い合わせを1回にできる
 */
export async function pickUp(
  deps: IntakeDeps,
  issue: { number: number; body: string },
  statusOf: (
    issue: number,
  ) => Promise<WorkIssueStatus | undefined> = cachedStatusOf(deps.board),
): Promise<IntakeResult> {
  const { columns } = deps.config.github;
  const problems = checkIssueBody(issue.body);
  if (problems.length === 0) {
    const prereq = await prerequisiteState(issue.number, issue.body, statusOf);
    problems.push(...prereq.missing.map(missingPrerequisiteProblem));
    if (problems.length === 0) {
      if (prereq.open.length > 0) {
        deps.log(
          `#${issue.number}: 先に済ませる Issue（${prereq.open.map((n) => `#${n}`).join("、")}）がまだ開いているため、${columns.ready} に残して待ちます`,
        );
        return { accepted: false, waiting: prereq.open };
      }
      await deps.board.moveIssue(issue.number, columns.testing);
      return { accepted: true };
    }
  }
  await blockIssue(deps, issue.number, {
    body: blockedComment(problems, columns.ready),
    reason: [
      "Issue の本文に書き漏れがあるため、作業を始めませんでした。",
      ...problems.map((p) => `- ${p}`),
    ].join("\n"),
  });
  return { accepted: false, problems };
}

export function blockedComment(problems: string[], ready: string): string {
  return [
    "書き漏れがあるため、作業を始めずに Blocked に移しました。",
    "",
    ...problems.map((p) => `- ${p}`),
    "",
    `直したら ${ready} 列に戻してください。`,
  ].join("\n");
}

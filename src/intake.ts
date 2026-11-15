import type { Config } from "./config.js";
import type { GitHub } from "./github.js";

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
export type IntakeBoard = Pick<GitHub, "moveIssue" | "comment">;

export type IntakeResult =
  { accepted: true } | { accepted: false; problems: string[] };

/**
 * Ready の Issue を拾う。そろっていればテスト役の列へ、
 * 書き漏れがあれば Blocked に移し、欠けた項目をメンション付きでコメントする
 */
export async function pickUp(
  board: IntakeBoard,
  issue: { number: number; body: string },
  columns: Config["github"]["columns"],
): Promise<IntakeResult> {
  const problems = checkIssueBody(issue.body);
  if (problems.length === 0) {
    await board.moveIssue(issue.number, columns.testing);
    return { accepted: true };
  }
  await board.moveIssue(issue.number, columns.blocked);
  await board.comment(issue.number, blockedComment(problems, columns.ready), {
    mention: true,
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

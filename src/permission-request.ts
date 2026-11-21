/**
 * 許可の確認。役（claude -p）が許可リストにない操作を拒否されたとき、差し戻しとして数えずに、人に許可を足すかを確かめる。
 * - 拒否された操作（src/claude.ts の denials）を「許可の規則」の形（例: `Bash(npm install --save-dev react-markdown)`）にして記録する。
 *   役の deny（拒否リスト）に当てはまる操作は許可を聞かない（いまと同じく差し戻しにする）
 * - 窓口があれば、質問チャンネルにスレッドを作り、規則の案を書いて許可した人にメンションする。
 *   ✅ なら案（拒否された操作そのもの）を、スレッドに規則が書かれたらその規則を、roles.<役>.allow に足す PR を作ってマージし、
 *   Issue を続きから再開する（記録を消すと、次の確認で役が動く）。❌ なら Blocked にし、止まったときのスレッドに引き継ぐ
 * - 窓口が無ければ、Blocked にして、拒否された操作と config.yaml に足す規則の案を Issue にコメントする
 */
import { isAbsolute, relative } from "node:path";
import { blockIssue, issueUrl } from "./blocked-thread.js";
import type { Chat, ChatReaction } from "./chat.js";
import { type Config, type Role, ROLES } from "./config.js";
import { globToRegExp } from "./git.js";
import type { SettingsForm } from "./settings-data.js";
import { formOf } from "./settings-rules.js";
import type {
  IssueKey,
  PermissionRequestInput,
  PermissionRequestRecord,
  Store,
} from "./store.js";

/** 拒否された操作（src/claude.ts の RoleResult の denials の1件） */
export interface Denial {
  tool: string;
  input: unknown;
}

/** 許可する印 */
export const ALLOW_MARK = "✅";
/** 許可しない印 */
export const REFUSE_MARK = "❌";

/** スレッドの名前の最大の文字数（Discord は 100 文字まで） */
const THREAD_NAME_LIMIT = 90;
/** 拒否された操作の説明の最大の文字数 */
const DENIED_LIMIT = 300;

/** 書き込みに出す役の名前 */
export const ROLE_NAMES: Readonly<Record<string, string>> = {
  tester: "テスト役",
  implementer: "実装役",
  reviewer: "レビュー役",
  specifier: "仕様化役",
  decomposer: "分解役",
};

export function roleName(role: string): string {
  return ROLE_NAMES[role] ?? role;
}

/** シェルの道具（Windows では PowerShell。許可の規則は Bash(...) に PowerShell(...) を足して渡している） */
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
/** Edit(...) の規則が当てはまる道具（Claude Code の決まり） */
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function stringField(input: unknown, name: string): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const value: unknown = (input as Record<string, unknown>)[name];
  return typeof value === "string" ? value : undefined;
}

function commandOf(denial: Denial): string | undefined {
  if (!SHELL_TOOLS.has(denial.tool)) return undefined;
  return stringField(denial.input, "command")?.trim();
}

function filePathOf(denial: Denial): string | undefined {
  return (
    stringField(denial.input, "file_path") ??
    stringField(denial.input, "notebook_path") ??
    stringField(denial.input, "path")
  );
}

/** cwd からの相対パス（/ 区切り）。cwd の外なら undefined */
function relativePath(cwd: string, path: string): string | undefined {
  const rel = isAbsolute(path) ? relative(cwd, path) : path;
  const normalized = rel.replaceAll("\\", "/").replace(/^\.\//, "");
  if (normalized === "" || normalized.startsWith("../")) return undefined;
  if (isAbsolute(normalized)) return undefined;
  return normalized;
}

/** 拒否された操作を、許可の規則の形にする */
export function ruleOfDenial(denial: Denial, cwd: string): string {
  const command = commandOf(denial);
  if (command !== undefined && command !== "") return `Bash(${command})`;
  const path = filePathOf(denial);
  if (
    path !== undefined &&
    (EDIT_TOOLS.has(denial.tool) || denial.tool === "Read")
  ) {
    const tool = EDIT_TOOLS.has(denial.tool) ? "Edit" : "Read";
    const rel = relativePath(cwd, path);
    return rel === undefined ? `${tool}(${path})` : `${tool}(./${rel})`;
  }
  const url = stringField(denial.input, "url");
  if (denial.tool === "WebFetch" && url !== undefined) {
    try {
      return `WebFetch(domain:${new URL(url).hostname})`;
    } catch {
      return "WebFetch";
    }
  }
  return denial.tool;
}

/** 拒否された操作の説明（コマンド・ファイルなど） */
export function describeDenial(denial: Denial): string {
  const command = commandOf(denial);
  const path = filePathOf(denial);
  const text =
    command ??
    (path === undefined
      ? `${denial.tool} ${JSON.stringify(denial.input) ?? ""}`.trim()
      : `${denial.tool} ${path}`);
  const oneLine = text.replace(/\s*\n\s*/g, " ");
  return oneLine.length > DENIED_LIMIT
    ? `${oneLine.slice(0, DENIED_LIMIT)}…`
    : oneLine;
}

/** 規則を [道具, 中身] に分ける。中身が無ければ undefined */
function parseRule(rule: string): { tool: string; spec?: string } {
  const m = /^([^(]+)\((.*)\)$/s.exec(rule.trim());
  if (m === null) return { tool: rule.trim() };
  return { tool: m[1]!.trim(), spec: m[2]! };
}

/** Bash(...) の中身（* は何にでも当てはまる。末尾の :* は前方一致）がコマンドに当てはまるか */
function commandMatches(spec: string, command: string): boolean {
  const pattern = spec.endsWith(":*") ? `${spec.slice(0, -2)}*` : spec;
  const re = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${re}$`, "s").test(command.trim());
}

/** 拒否された操作が規則（deny の1件）に当てはまるか */
export function matchesRule(
  denial: Denial,
  rule: string,
  cwd: string,
): boolean {
  const { tool, spec } = parseRule(rule);
  if (SHELL_TOOLS.has(tool)) {
    if (!SHELL_TOOLS.has(denial.tool)) return false;
    if (spec === undefined) return true;
    const command = commandOf(denial);
    return command !== undefined && commandMatches(spec, command);
  }
  if (tool === "Edit" || tool === "Read") {
    const tools = tool === "Edit" ? EDIT_TOOLS : new Set(["Read"]);
    if (!tools.has(denial.tool)) return false;
    if (spec === undefined) return true;
    const path = filePathOf(denial);
    if (path === undefined) return false;
    const rel = relativePath(cwd, path);
    const glob = spec.replace(/^\.\//, "");
    if (rel !== undefined && globToRegExp(glob).test(rel)) return true;
    return globToRegExp(spec).test(path.replaceAll("\\", "/"));
  }
  if (tool !== denial.tool) return false;
  return spec === undefined || ruleOfDenial(denial, cwd) === rule;
}

/** 許可を聞く拒否（deny に当てはまるものは除く）。無ければ rules は空 */
export function permissionDenials(
  denials: readonly Denial[],
  deny: readonly string[],
  cwd: string,
): { rules: string[]; denied: string[] } {
  const asked = denials.filter(
    (d) => !deny.some((rule) => matchesRule(d, rule, cwd)),
  );
  return {
    rules: [...new Set(asked.map((d) => ruleOfDenial(d, cwd)))],
    denied: [...new Set(asked.map(describeDenial))],
  };
}

/** 広い案。Bash(...) の最初の 2 語に ` *` を付ける（例: Bash(npm install *)）。作れなければ undefined */
export function broadRule(rule: string): string | undefined {
  const { tool, spec } = parseRule(rule);
  if (tool !== "Bash" || spec === undefined) return undefined;
  const words = spec.trim().split(/\s+/).slice(0, 2);
  if (words.length === 0 || words[0] === "") return undefined;
  const broad = `Bash(${words.join(" ")} *)`;
  return broad === rule ? undefined : broad;
}

/** 規則の案のうち、広い案（基本の案と重ならないもの） */
export function broadRules(rules: readonly string[]): string[] {
  const out: string[] = [];
  for (const r of rules) {
    const b = broadRule(r);
    if (
      b !== undefined &&
      isProposable(b) &&
      !rules.includes(b) &&
      !out.includes(b)
    )
      out.push(b);
  }
  return out;
}

/** スレッドの名前 */
export function permissionThreadName(issue: number, title: string): string {
  const name = `許可の確認: #${issue} ${title}`.trim();
  return name.length > THREAD_NAME_LIMIT
    ? `${name.slice(0, THREAD_NAME_LIMIT - 1)}…`
    : name;
}

/** 文の中で最も長いバッククォートの連なりの長さ */
function longestBackticks(s: string): number {
  return Math.max(0, ...(s.match(/`+/g) ?? []).map((m) => m.length));
}

/**
 * インラインのコードとして、文を書き換えずに表示する。
 * バッククォートを含むときは、最も長い連なりより長いフェンスで囲む（Markdown の決まり）
 */
export function code(s: string): string {
  const n = longestBackticks(s);
  if (n === 0) return `\`${s}\``;
  const fence = "`".repeat(n + 1);
  return `${fence} ${s} ${fence}`;
}

/** 複数行でも、文を書き換えずにコードのブロックとして表示する */
export function codeBlock(s: string): string {
  const fence = "`".repeat(Math.max(3, longestBackticks(s) + 1));
  return `${fence}\n${s}\n${fence}`;
}

/**
 * ✅ で足す案にしてよい規則か。
 * バッククォート・改行・`$(` を含む規則は、表示で読み違えやすく、コマンドの置換も含みうるので、✅ の案にしない
 * （人がスレッドに規則を書いたときだけ足す）
 */
export function isProposable(rule: string): boolean {
  return !/[`\r\n]|\$\(/.test(rule);
}

/** 規則の案の一覧の行。✅ の案にしない規則は、そのまま見える形（コードのブロック）で示す */
function ruleLines(rules: readonly string[]): string[] {
  return rules.map((r) =>
    isProposable(r)
      ? `- ${code(r)}`
      : `- 次の規則（バッククォート・改行・\`$(\` を含むため、${ALLOW_MARK} では足しません）:\n${codeBlock(r)}`,
  );
}

/** 最初の書き込みの文 */
export function permissionLead(role: string): string {
  return `${roleName(role)} が許可リストにない操作を拒否されました。次の規則を許可リストに足してよければ ${ALLOW_MARK}、足さないなら ${REFUSE_MARK} を付けてください。別の規則にするときは、このスレッドに書いてください。`;
}

/** 質問チャンネルに書く、案の書き込み（スレッドのもとの投稿） */
export function permissionMessage(input: {
  repo: string;
  record: Pick<
    PermissionRequestRecord,
    "issue" | "role" | "rules" | "denied" | "title"
  >;
  allowedUsers: readonly string[];
}): string {
  const { repo, record, allowedUsers } = input;
  const broad = broadRules(record.rules);
  const lines = [
    `${allowedUsers.map((u) => `<@${u}>`).join(" ")} ${permissionLead(record.role)}`.trim(),
    "",
    `Issue #${record.issue}${record.title ? `: ${record.title}` : ""}`,
    issueUrl(repo, record.issue),
    "",
    "拒否された操作:",
    ...record.denied.map((d) => `- ${code(d)}`),
    "",
    `足す規則の案（${ALLOW_MARK} でこれを足します）:`,
    ...ruleLines(record.rules),
  ];
  if (!record.rules.some(isProposable)) {
    lines.push(
      "",
      `${ALLOW_MARK} で足せる案はありません。足すときは、規則をこのスレッドに書いてください。`,
    );
  }
  if (broad.length > 0) {
    lines.push(
      "",
      "広い案（こちらにするときは、このスレッドに書いてください）:",
      ...broad.map((r) => `- ${code(r)}`),
    );
  }
  return lines.join("\n");
}

/** 規則を足したあとの書き込み */
export function grantedMessage(
  rules: readonly string[],
  pr: number | undefined,
  issue: number,
): string {
  const prText =
    pr === undefined ? "すでに許可リストにありました" : `PR #${pr}`;
  return `${rules.join("、")} を許可リストに足しました（${prText}）。Issue #${issue} を再開します。このスレッドは閉じます。`;
}

/** ❌ が付いたときの書き込み */
export function refusedMessage(issue: number): string {
  return `許可しませんでした。Issue #${issue} を Blocked にし、止まったときのスレッドで方針を確かめます。このスレッドは閉じます。`;
}

/** 規則の形で書いてもらう案内 */
export const RULE_HINT =
  "規則の形（例: `Bash(npm install *)`）で書いてください。1 行に 1 つの規則を書けます。";

/** 窓口が無いときに Issue に書くコメント */
export function noChatComment(
  record: Pick<PermissionRequestRecord, "role" | "rules" | "denied">,
  ready: string,
): string {
  const broad = broadRules(record.rules);
  return [
    `${roleName(record.role)} が許可リストにない操作を拒否されたため、Blocked に移しました（差し戻しとしては数えていません）。`,
    "",
    "拒否された操作:",
    ...record.denied.map((d) => `- ${code(d)}`),
    "",
    `許可するときは、\`.conductor/config.yaml\` の \`roles.${record.role}.allow\` に次の規則を足してください:`,
    ...record.rules.map((r) =>
      isProposable(r)
        ? `- ${code(r)}`
        : `- 次の規則（バッククォート・改行・\`$(\` を含みます。中身をよく確かめてください）:\n${codeBlock(r)}`,
    ),
    ...(broad.length > 0
      ? ["", "広く許可するときの案:", ...broad.map((r) => `- ${code(r)}`)]
      : []),
    "",
    `足したら（または方針を決めたら）${ready} 列に戻してください。`,
  ].join("\n");
}

/** 人が書いた書き込みから規則を取り出す（1 行に 1 つ。箇条書きの印・` は外す） */
export function rulesInText(text: string): string[] {
  const rules: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw
      .trim()
      .replace(/^[-*・]\s+/, "")
      .replace(/^`+|`+$/g, "")
      .trim();
    if (/^[A-Za-z][\w-]*(?:\(.+\))?$/s.test(line) && !rules.includes(line)) {
      rules.push(line);
    }
  }
  return rules;
}

export interface PermissionRequestBoard {
  moveIssue(issue: number, column: string): Promise<void>;
  comment(
    issue: number,
    body: string,
    options?: { mention?: boolean },
  ): Promise<void>;
  /** 設定の PR をマージする。マージ済みなら成功として扱う */
  mergePullRequest(pr: number): Promise<void>;
}

export interface PermissionRequestDeps {
  config: Config;
  /** 窓口。無ければ Blocked にして Issue にコメントする */
  chat?: Chat;
  store: Store;
  board: PermissionRequestBoard;
  /** 設定の保存（src/settings.ts の saveSettings。PR を作るだけ） */
  saveSettings(form: SettingsForm): Promise<{ number: number; url: string }>;
  log(text: string): void;
}

export type PermissionRequestStatus =
  /** スレッドを作った */
  | "asked"
  /** ✅・❌・規則の書き込みを待っている */
  | "waiting"
  /** 規則を足して再開した */
  | "granted"
  /** 許可せず Blocked にした（窓口が無いときも） */
  | "blocked";

function isRole(role: string): role is Role {
  return (ROLES as readonly string[]).includes(role);
}

/** 記録を書き直すときの、今の記録の項目 */
function inputOf(record: PermissionRequestRecord): PermissionRequestInput {
  const input: PermissionRequestInput = {
    role: record.role,
    rules: record.rules,
    denied: record.denied,
  };
  if (record.title !== undefined) input.title = record.title;
  if (record.headId !== undefined) input.headId = record.headId;
  if (record.threadId !== undefined) input.threadId = record.threadId;
  if (record.granted !== undefined) input.granted = record.granted;
  if (record.pr !== undefined) input.pr = record.pr;
  return input;
}

function hasMark(
  reactions: readonly ChatReaction[],
  mark: string,
  allowed: ReadonlySet<string>,
): boolean {
  return reactions.some(
    (r) => r.emoji === mark && r.userIds.some((id) => allowed.has(id)),
  );
}

/** 拒否された操作を記録する（次の確認で許可を確かめる） */
export async function recordPermissionRequest(
  store: Store,
  key: IssueKey,
  input: { role: string; title?: string; rules: string[]; denied: string[] },
): Promise<void> {
  await store.setPermissionRequest(key, {
    role: input.role,
    rules: input.rules,
    denied: input.denied,
    ...(input.title === undefined ? {} : { title: input.title }),
  });
}

/** 許可の確認の記録1件を1回分確かめる */
export async function followPermissionRequest(
  deps: PermissionRequestDeps,
  record: PermissionRequestRecord,
): Promise<{ status: PermissionRequestStatus }> {
  const { config, store } = deps;
  const { columns } = config.github;
  const key: IssueKey = { repo: record.repo, issue: record.issue };
  const name = `#${record.issue}`;
  const chatConfig = config.chat;
  const chat = deps.chat;

  // 窓口が無い: Blocked にして Issue に案を書く
  if (chat === undefined || chatConfig === undefined) {
    await blockIssue(deps, record.issue, {
      body: noChatComment(record, columns.ready),
      reason: `${roleName(record.role)} が許可リストにない操作を拒否されました: ${record.rules.join("、")}`,
    });
    await store.deletePermissionRequest(key);
    deps.log(
      `${name}: 許可リストにない操作を拒否されたので、Blocked にして規則の案を Issue に書きました`,
    );
    return { status: "blocked" };
  }

  // 足す規則が決まっていれば（前の確認の途中で失敗していても）、足すところから続ける
  if (record.granted !== undefined)
    return grant(deps, chat, record, record.granted);

  const questions = chatConfig.channels.questions;
  // 前の確認で案を書いていたら、書き直さずにスレッドを作るところから続ける（メンションを重ねない）
  let headId = record.headId;
  if (headId === undefined) {
    headId = await chat.post(
      questions,
      permissionMessage({
        repo: record.repo,
        record,
        allowedUsers: chatConfig.allowed_users,
      }),
    );
    record = await store.setPermissionRequest(key, {
      ...inputOf(record),
      headId,
    });
  }
  if (record.threadId === undefined) {
    const threadId = await chat.createThread(
      questions,
      headId,
      permissionThreadName(record.issue, record.title ?? ""),
    );
    await store.setPermissionRequest(key, { ...inputOf(record), threadId });
    deps.log(`${name}: 質問チャンネルに許可の確認のスレッドを作りました`);
    return { status: "asked" };
  }
  const { threadId } = record;
  const allowed = new Set(chatConfig.allowed_users);

  const reactions = await chat.readReactions(questions, headId);
  if (hasMark(reactions, REFUSE_MARK, allowed)) {
    return refuse(deps, chat, record, threadId);
  }

  // 許可した人がスレッドに書いた規則
  const after = await store.getReadPosition(threadId);
  const messages = await chat.readMessages(threadId, after);
  const self = await chat.selfId();
  const written = messages.filter(
    (m) => m.authorId !== self && allowed.has(m.authorId),
  );
  const humanRules = written.flatMap((m) => rulesInText(m.text));
  const last = messages.at(-1);
  if (humanRules.length > 0) {
    const granted = [...new Set(humanRules)];
    record = await store.setPermissionRequest(key, {
      ...inputOf(record),
      granted,
    });
    if (last !== undefined) await store.setReadPosition(threadId, last.id);
    return grant(deps, chat, record, granted);
  }
  if (written.length > 0) {
    // 規則の形でない書き込みには案内を返す
    await chat.post(threadId, RULE_HINT);
  }
  if (last !== undefined) await store.setReadPosition(threadId, last.id);

  // ✅ で足すのは、表示どおりに読める案だけ（読み違えやすい規則は人が書いたときだけ足す）
  const proposable = record.rules.filter(isProposable);
  if (hasMark(reactions, ALLOW_MARK, allowed) && proposable.length > 0) {
    const granted = proposable;
    record = await store.setPermissionRequest(key, {
      ...inputOf(record),
      granted,
    });
    return grant(deps, chat, record, granted);
  }
  return { status: "waiting" };
}

/** 規則を足す PR を作ってマージし、Issue を再開する（記録を消す）。スレッドに結果を書いてアーカイブする */
async function grant(
  deps: PermissionRequestDeps,
  chat: Chat,
  record: PermissionRequestRecord,
  granted: readonly string[],
): Promise<{ status: PermissionRequestStatus }> {
  const { config, store, board } = deps;
  const key: IssueKey = { repo: record.repo, issue: record.issue };
  const name = `#${record.issue}`;
  const role = record.role;
  if (!isRole(role)) {
    throw new Error(`役の名前が設定にありません: ${role}`);
  }
  const allow = config.roles[role].allow;
  let pr = record.pr;
  const missing = granted.filter((r) => !allow.includes(r));
  if (pr === undefined && missing.length > 0) {
    const form = formOf(config);
    form.roles[role].allow = [...form.roles[role].allow, ...missing];
    const saved = await deps.saveSettings(form);
    pr = saved.number;
    // PR を作ったことをすぐ記録する（マージで失敗しても、次の確認で作り直さない）
    await store.setPermissionRequest(key, { ...inputOf(record), pr });
    deps.log(`${name}: 許可リストに規則を足す PR #${pr} を作りました`);
  }
  if (pr !== undefined) await board.mergePullRequest(pr);
  // 動いている指揮役の設定にも足す（次の役の起動から使う。再起動では config.yaml を読み直す）
  for (const r of missing) if (!allow.includes(r)) allow.push(r);

  if (record.threadId !== undefined) {
    await chat.post(record.threadId, grantedMessage(granted, pr, record.issue));
    await chat.archiveThread(record.threadId);
  }
  // 記録はアーカイブの後で消す（途中で失敗しても、次の確認でやり直せるように）
  await store.deletePermissionRequest(key);
  deps.log(
    `${name}: ${granted.join("、")} を許可リストに足しました。続きから再開します`,
  );
  return { status: "granted" };
}

/** 許可せず Blocked にし、止まったときのスレッドに引き継ぐ */
async function refuse(
  deps: PermissionRequestDeps,
  chat: Chat,
  record: PermissionRequestRecord,
  threadId: string,
): Promise<{ status: PermissionRequestStatus }> {
  const { config, store } = deps;
  const { columns } = config.github;
  const key: IssueKey = { repo: record.repo, issue: record.issue };
  const operations = record.denied.map((d) => `- ${d}`);
  await blockIssue(deps, record.issue, {
    body: [
      `${roleName(record.role)} が拒否された操作を許可しないことになったため、Blocked に移しました。拒否された操作:`,
      "",
      ...record.denied.map((d) => `- ${code(d)}`),
    ].join("\n"),
    reason: [
      `${roleName(record.role)} が許可リストにない操作を拒否され、許可しないことになりました。拒否された操作:`,
      ...operations,
      `この操作を使わずに進める方針を書いてください（方針を書くと ${columns.ready} に戻します）。`,
    ].join("\n"),
  });
  await chat.post(threadId, refusedMessage(record.issue));
  await chat.archiveThread(threadId);
  await store.deletePermissionRequest(key);
  deps.log(`#${record.issue}: 許可しなかったので Blocked にしました`);
  return { status: "blocked" };
}

/** 記録のある Issue の許可の確認を、すべて1回分ずつ確かめる。1件の失敗で他を止めない */
export async function followPermissionRequests(
  deps: PermissionRequestDeps,
): Promise<void> {
  const records = await deps.store.listPermissionRequests(
    deps.config.github.repo,
  );
  for (const r of records) {
    try {
      await followPermissionRequest(deps, r);
    } catch (e) {
      deps.log(
        `#${r.issue}: 許可の確認に失敗しました（次の確認でやり直します）: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

/**
 * 常駐ループ（conductor start）。
 * 一定の間隔で GitHub を確かめ、作業中の Issue を1段階進める。作業中の Issue が無ければ Ready から1件拾う。
 * 承認待ちの Issue は作業中に数えず、毎回コメントだけを確かめる。
 * 窓口（chat）があれば、Issue の処理とは別に要件チャンネルの新しい投稿も毎回受け取る。
 * 既存の各役とは、このファイルで定めた LoopDeps を通してつなぐ（つなぎ方は start.ts）。
 */
import { setTimeout as delay } from "node:timers/promises";
import type { Chat } from "./chat.js";
import type { Config } from "./config.js";
import { pendingFindings } from "./rejection.js";
import { receiveRequirements } from "./requirements.js";
import type { IssueKey, IssueRecord, Stage, Store } from "./store.js";

/** 確認の間隔 */
export const LOOP_INTERVAL_MS = 90_000;
/** 同じ Issue がこの回数続けて失敗したら Blocked にする */
export const MAX_FAILURES = 3;

export interface LoopIssue {
  number: number;
  title: string;
  body: string;
}

/** 各段階の結果。status だけを見る */
export interface StepResult {
  status: string;
}

export interface LoopBoard {
  /** 列の名前ごとの Issue */
  issuesByColumn(): Promise<Map<string, LoopIssue[]>>;
  moveIssue(issue: number, column: string): Promise<void>;
  comment(
    issue: number,
    body: string,
    options?: { mention?: boolean },
  ): Promise<void>;
  /** PR が main と衝突しているか */
  hasConflict(pr: number): Promise<boolean>;
}

export interface LoopDeps {
  config: Config;
  store: Store;
  board: LoopBoard;
  /** 入口確認。そろっていればテスト役の列へ移す */
  pickUp(issue: LoopIssue): Promise<{ accepted: boolean }>;
  test(issue: LoopIssue): Promise<StepResult>;
  implement(issue: LoopIssue, findings: string[]): Promise<StepResult>;
  /** CI の結果を1回確かめる。通っていれば status は "passed" */
  checkCi(issue: LoopIssue): Promise<StepResult>;
  /** レビュー。承認待ちのときは PR のコメントだけを確かめる */
  review(issue: LoopIssue): Promise<StepResult>;
  /** マージの途中で止まったときの続き */
  merge(issue: LoopIssue): Promise<StepResult>;
  /** PR が main と衝突したとき、main を取り込む（衝突の内容に応じてテスト役・実装役に回す） */
  syncMain(issue: LoopIssue, pr: number): Promise<StepResult>;
  log(text: string): void;
  /** 窓口。config.chat があるときに start.ts がつなぐ。無ければ要件を受け取らない */
  chat?: Chat;
  /** 待つ。signal が来たらすぐ戻る（テストで差し替える） */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** ループの間だけ持つ状態 */
export interface LoopState {
  /** Issue ごとの、続けて失敗した回数 */
  failures: Map<number, number>;
}

export function newLoopState(): LoopState {
  return { failures: new Map() };
}

export function failureComment(
  message: string,
  count: number,
  ready: string,
): string {
  return [
    `${count} 回続けて失敗したため、Blocked に移しました。最後のエラー:`,
    "",
    "```",
    message,
    "```",
    "",
    `確認したら ${ready} 列に戻してください。`,
  ].join("\n");
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 記録が無いときは列から段階を決める */
function stageOf(
  record: IssueRecord | undefined,
  column: string,
  columns: Config["github"]["columns"],
): Stage {
  const stage = record?.checkpoint?.stage;
  if (stage) return stage;
  if (column === columns.implementing) return "implementing";
  if (column === columns.reviewing) return "reviewing";
  return "testing";
}

/** 衝突していれば指揮役が main を取り込む。取り込んだら結果を返す */
async function syncIfConflict(
  deps: LoopDeps,
  issue: LoopIssue,
): Promise<StepResult | undefined> {
  const { config, store, board } = deps;
  const key: IssueKey = { repo: config.github.repo, issue: issue.number };
  const pr = (await store.get(key))?.pr;
  if (pr === undefined || !(await board.hasConflict(pr))) return undefined;
  return deps.syncMain(issue, pr);
}

/** 1段階進める */
async function advance(
  deps: LoopDeps,
  issue: LoopIssue,
  stage: Stage,
): Promise<StepResult> {
  const key: IssueKey = { repo: deps.config.github.repo, issue: issue.number };
  switch (stage) {
    case "testing":
      return deps.test(issue);
    case "implementing":
      return deps.implement(issue, await pendingFindings(deps.store, key));
    case "ci": {
      const synced = await syncIfConflict(deps, issue);
      if (synced) return synced;
      const ci = await deps.checkCi(issue);
      return ci.status === "passed" ? deps.review(issue) : ci;
    }
    case "reviewing":
    case "approving":
      return (await syncIfConflict(deps, issue)) ?? deps.review(issue);
    case "merging":
      return deps.merge(issue);
  }
}

/** 失敗を数える。続けて MAX_FAILURES 回失敗したら Blocked にしてメンションする */
async function attempt(
  deps: LoopDeps,
  state: LoopState,
  issue: LoopIssue,
  step: () => Promise<StepResult>,
): Promise<void> {
  const n = issue.number;
  try {
    const r = await step();
    state.failures.delete(n);
    deps.log(`#${n}: ${r.status}`);
  } catch (e) {
    const message = errorMessage(e);
    const count = (state.failures.get(n) ?? 0) + 1;
    deps.log(`#${n}: 失敗（${count}/${MAX_FAILURES} 回目）: ${message}`);
    if (count < MAX_FAILURES) {
      state.failures.set(n, count);
      return;
    }
    state.failures.delete(n);
    const { columns } = deps.config.github;
    try {
      await deps.board.moveIssue(n, columns.blocked);
      await deps.board.comment(
        n,
        failureComment(message, count, columns.ready),
        { mention: true },
      );
    } catch (e2) {
      deps.log(`#${n}: Blocked への移動に失敗: ${errorMessage(e2)}`);
    }
  }
}

/**
 * 要件チャンネルの新しい投稿を受け取る（窓口があるときだけ）。
 * 失敗しても Issue の処理は止めない（次の確認で続きから読む）
 */
async function intakeRequirements(deps: LoopDeps): Promise<void> {
  const { chat } = deps;
  const chatConfig = deps.config.chat;
  if (chat === undefined || chatConfig === undefined) return;
  try {
    await receiveRequirements({
      chat,
      chatConfig,
      store: deps.store,
      log: deps.log,
    });
  } catch (e) {
    deps.log(
      `要件の受け取りに失敗しました（次の確認でやり直します）: ${errorMessage(e)}`,
    );
  }
}

/** 1回分の確認。要件の受け取りと、作業中の Issue の処理を行う */
export async function tick(deps: LoopDeps, state: LoopState): Promise<void> {
  const { config, store, board } = deps;
  await intakeRequirements(deps);
  const { columns, repo } = config.github;
  const byColumn = await board.issuesByColumn();
  const inColumn = (column: string) =>
    [...(byColumn.get(column) ?? [])]
      .map((issue) => ({ issue, column }))
      .sort((a, b) => a.issue.number - b.issue.number);

  const working = [columns.testing, columns.implementing, columns.reviewing]
    .flatMap(inColumn)
    .sort((a, b) => a.issue.number - b.issue.number);
  const records = new Map<number, IssueRecord | undefined>();
  for (const { issue } of working) {
    records.set(issue.number, await store.get({ repo, issue: issue.number }));
  }
  const isApproving = (n: number) =>
    records.get(n)?.checkpoint?.stage === "approving";

  // 承認待ちは作業中に数えず、毎回コメントだけを確かめる
  for (const { issue } of working.filter((w) => isApproving(w.issue.number))) {
    await attempt(deps, state, issue, () => advance(deps, issue, "approving"));
  }

  const active = working.find((w) => !isApproving(w.issue.number));
  if (active) {
    const { issue, column } = active;
    const stage = stageOf(records.get(issue.number), column, columns);
    await attempt(deps, state, issue, () => advance(deps, issue, stage));
    return;
  }

  const ready = inColumn(columns.ready)[0]?.issue;
  if (!ready) return;
  await attempt(deps, state, ready, async () => {
    const r = await deps.pickUp(ready);
    if (!r.accepted) return { status: "blocked" };
    const record = await store.get({ repo, issue: ready.number });
    return advance(deps, ready, record?.checkpoint?.stage ?? "testing");
  });
}

async function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await delay(ms, undefined, { signal });
  } catch (e) {
    if (!signal.aborted) throw e;
  }
}

/** signal が来るまで確認を続ける。段階の途中では止めず、終わってから止まる */
export async function runLoop(
  deps: LoopDeps,
  signal: AbortSignal,
  options: { intervalMs?: number } = {},
): Promise<void> {
  const state = newLoopState();
  const interval = options.intervalMs ?? LOOP_INTERVAL_MS;
  const sleep = deps.sleep ?? abortableSleep;
  deps.log(`開始しました（${Math.round(interval / 1000)} 秒ごとに確認）`);
  while (!signal.aborted) {
    try {
      await tick(deps, state);
    } catch (e) {
      deps.log(
        `確認に失敗しました（次の確認でやり直します）: ${errorMessage(e)}`,
      );
    }
    if (signal.aborted) break;
    await sleep(interval, signal);
  }
  deps.log("止まりました");
}

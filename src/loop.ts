/**
 * 常駐ループ（conductor start）。
 * 一定の間隔で GitHub を確かめ、作業中の Issue を1段階進める。作業中の Issue が無ければ Ready から1件拾う。
 * 承認待ちの Issue は作業中に数えず、毎回コメントだけを確かめる。
 * 窓口（chat）があれば、Issue の処理とは別に要件チャンネルの新しい投稿も毎回受け取る。
 * 既存の各役とは、このファイルで定めた LoopDeps を通してつなぐ（つなぎ方は start.ts）。
 */
import { setTimeout as delay } from "node:timers/promises";
import { blockIssue, followBlockedThreads } from "./blocked-thread.js";
import type { Chat } from "./chat.js";
import type { Config } from "./config.js";
import { abortError, isAbortError } from "./exec.js";
import { type PartialWork, partialWorkOf } from "./partial-work.js";
import { pendingFindings } from "./rejection.js";
import { receiveRequirements } from "./requirements.js";
import type { RespecDeps } from "./respec.js";
import type {
  IssueKey,
  IssueRecord,
  RequirementRecord,
  Stage,
  Store,
} from "./store.js";

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

/** 段階の関数に渡す、その段階の中断の signal（管理画面から中断されたら abort する） */
export interface StepContext {
  signal: AbortSignal;
}

export interface LoopDeps {
  config: Config;
  store: Store;
  board: LoopBoard;
  /** 入口確認。そろっていればテスト役の列へ移す */
  pickUp(issue: LoopIssue): Promise<{ accepted: boolean }>;
  test(issue: LoopIssue, ctx?: StepContext): Promise<StepResult>;
  implement(
    issue: LoopIssue,
    findings: string[],
    ctx?: StepContext,
  ): Promise<StepResult>;
  /** CI の結果を1回確かめる。通っていれば status は "passed" */
  checkCi(issue: LoopIssue, ctx?: StepContext): Promise<StepResult>;
  /** レビュー。承認待ちのときは PR のコメントだけを確かめる */
  review(issue: LoopIssue, ctx?: StepContext): Promise<StepResult>;
  /** マージの途中で止まったときの続き */
  merge(issue: LoopIssue, ctx?: StepContext): Promise<StepResult>;
  /** PR が main と衝突したとき、main を取り込む（衝突の内容に応じてテスト役・実装役に回す） */
  syncMain(
    issue: LoopIssue,
    pr: number,
    ctx?: StepContext,
  ): Promise<StepResult>;
  log(text: string): void;
  /** 窓口。config.chat があるときに start.ts がつなぐ。無ければ要件を受け取らない */
  chat?: Chat;
  /** 仕様化役で要件1件を1回分進める。窓口があるときに start.ts がつなぐ。無ければ仕様化しない */
  specify?: (requirement: RequirementRecord) => Promise<StepResult>;
  /** 承認待ちの要件1件の承認（要約への ✅）を1回分確かめる。窓口があるときに start.ts がつなぐ。無ければ承認を確かめない */
  approveSpec?: (requirement: RequirementRecord) => Promise<StepResult>;
  /** 分解に進めた要件1件を作業用 Issue に分ける。窓口があるときに start.ts がつなぐ。無ければ分解しない */
  decompose?: (requirement: RequirementRecord) => Promise<StepResult>;
  /** 分解済みの要件1件の作業用 Issue を確かめ、着手できる Issue を Ready に移し、すべてマージされたら完了を知らせる。窓口があるときに start.ts がつなぐ。無ければ確かめない */
  progress?: (requirement: RequirementRecord) => Promise<StepResult>;
  /** 仕様の作り直し。要件の作業用 Issue が止まり、スレッドに方針が書かれたら仕様化役に判断させる。窓口があるときに start.ts がつなぐ。無ければ方針をそのまま書き写す */
  respec?: RespecDeps;
  /** 待つ。signal が来たらすぐ戻る（テストで差し替える） */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** 稼働状態が変わったときに呼ぶ（確認している間は "running"、次の確認を待つ間は "idle"）。管理画面に知らせるために start.ts がつなぐ */
  onStatus?: (status: "running" | "idle") => void;
  /** 常駐ループの状態が変わるたびに、今の状態の全体を渡して呼ぶ。管理画面に知らせるために start.ts がつなぐ */
  onActivity?: (activity: LoopActivity) => void;
}

/** 動いている役（管理画面の辞書 roles のキー） */
export type ActiveRole =
  | "tester"
  | "implementer"
  | "ci"
  | "reviewer"
  | "merge"
  | "specifier"
  | "decomposer";

/** メモリにしかない、常駐ループの状態。起動した直後は {} */
export interface LoopActivity {
  /** 最後に GitHub を確認した時刻（ISO 8601） */
  lastCheckedAt?: string;
  /** 次に GitHub を確認する時刻（ISO 8601） */
  nextCheckAt?: string;
  /** 今動いている役と、その Issue。動いていなければ undefined */
  running?: { issue: number; role: ActiveRole };
}

/** 常駐ループの状態を持ち、変わるたびに onActivity に知らせる */
class ActivityTracker {
  private activity: LoopActivity = {};

  constructor(
    private readonly notify: ((activity: LoopActivity) => void) | undefined,
  ) {}

  private set(next: LoopActivity): void {
    this.activity = next;
    this.notify?.(structuredClone(next));
  }

  /** GitHub を確認し始めた（確認の間は次の確認の時刻を持たない） */
  checked(at: Date): void {
    const next: LoopActivity = { lastCheckedAt: at.toISOString() };
    if (this.activity.running !== undefined) {
      next.running = this.activity.running;
    }
    this.set(next);
  }

  running(issue: number, role: ActiveRole): void {
    this.set({ ...this.activity, running: { issue, role } });
  }

  stopped(): void {
    if (this.activity.running === undefined) return;
    this.set(withoutRunning(this.activity));
  }

  /** 次の確認を待つ（役は動いていない） */
  waiting(intervalMs: number): void {
    const last = this.activity.lastCheckedAt ?? new Date().toISOString();
    const nextCheckAt = new Date(Date.parse(last) + intervalMs).toISOString();
    this.set({ lastCheckedAt: last, nextCheckAt });
  }
}

function withoutRunning(activity: LoopActivity): LoopActivity {
  const next: LoopActivity = {};
  if (activity.lastCheckedAt !== undefined) {
    next.lastCheckedAt = activity.lastCheckedAt;
  }
  if (activity.nextCheckAt !== undefined) {
    next.nextCheckAt = activity.nextCheckAt;
  }
  return next;
}

/** 役を動かす間、その役と Issue（最初の引数）を running に入れる */
function withRole<A extends [LoopIssue, ...unknown[]], R>(
  tracker: ActivityTracker,
  steps: StepAborter,
  role: ActiveRole,
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args: A) => {
    tracker.running(args[0].number, role);
    steps.noteRole(args[0].number, role);
    try {
      return await fn(...args);
    } finally {
      tracker.stopped();
    }
  };
}

/** 各役に、動いている間の状態の知らせを付ける */
function trackRoles(
  deps: LoopDeps,
  tracker: ActivityTracker,
  steps: StepAborter,
): LoopDeps {
  return {
    ...deps,
    test: withRole(tracker, steps, "tester", deps.test),
    implement: withRole(tracker, steps, "implementer", deps.implement),
    checkCi: withRole(tracker, steps, "ci", deps.checkCi),
    review: withRole(tracker, steps, "reviewer", deps.review),
    merge: withRole(tracker, steps, "merge", deps.merge),
    syncMain: withRole(tracker, steps, "implementer", deps.syncMain),
  };
}

/** 中断の文に出す役の名前 */
export const ROLE_LABELS: Readonly<Record<ActiveRole, string>> = {
  tester: "テスト役",
  implementer: "実装役",
  ci: "CI の確認",
  reviewer: "レビュー役",
  merge: "マージ",
  specifier: "仕様化役",
  decomposer: "分解役",
};

/**
 * いま動いている段階と、その中断の signal を持つ（管理画面からの中断を受け付ける）。
 * 段階ごとに begin で signal を作り、終わったら end で外す。
 * 段階が動いていない処理中の Issue（CI の結果待ちの間など）への中断は予約しておき、
 * 次の確認で常駐ループが Blocked に移す
 */
export class StepAborter {
  private current:
    | { issue: number; controller: AbortController; role?: ActiveRole }
    | undefined;
  /** 直近の確認で処理中だった Issue（Testing・Implementing・Reviewing 列） */
  private working = new Set<number>();
  /** 段階の外で中断を頼まれた Issue */
  private pending = new Set<number>();

  /** 直近の確認で処理中だった Issue を覚える。処理中でなくなった Issue の中断の予約は捨てる */
  setWorking(issues: readonly number[]): void {
    this.working = new Set(issues);
    for (const n of this.pending) {
      if (!this.working.has(n)) this.pending.delete(n);
    }
  }

  /** 段階を終えた Issue を処理中として覚える（Ready から始めた Issue は次の確認まで列を読み直さないため） */
  noteWorking(issue: number): void {
    this.working.add(issue);
  }

  /** 中断の予約があれば取り出す。予約があったら true */
  takePending(issue: number): boolean {
    return this.pending.delete(issue);
  }

  /** 中断を予約する（次の確認で、まだ処理中なら Blocked に移す） */
  reserve(issue: number): void {
    this.pending.add(issue);
  }

  /** Issue の段階を始める。返した controller の signal を段階の関数に渡す */
  begin(issue: number): AbortController {
    const controller = new AbortController();
    this.current = { issue, controller };
    return controller;
  }

  end(controller: AbortController): void {
    if (this.current?.controller === controller) this.current = undefined;
  }

  /** 段階の中で動き始めた役を覚える（中断の文に出す） */
  noteRole(issue: number, role: ActiveRole): void {
    if (this.current?.issue === issue) this.current.role = role;
  }

  /** 中断したときに動いていた役 */
  roleOf(controller: AbortController): ActiveRole | undefined {
    return this.current?.controller === controller
      ? this.current.role
      : undefined;
  }

  /** いま動いている Issue の番号。無ければ undefined */
  running(): number | undefined {
    return this.current?.issue;
  }

  /**
   * issue の段階が動いていればすぐ中断する。段階の合間の処理中の Issue なら中断を予約する。
   * 受け付けたら true（処理中でなければ false）
   */
  abort(issue: number): boolean {
    const current = this.current;
    if (current?.issue === issue) {
      current.controller.abort(abortError("管理画面から中断しました"));
      return true;
    }
    if (!this.working.has(issue)) return false;
    this.pending.add(issue);
    return true;
  }
}

/** ループの間だけ持つ状態 */
export interface LoopState {
  /** Issue ごとの、続けて失敗した回数 */
  failures: Map<number, number>;
  /** いま動いている段階（管理画面からの中断を受け付ける） */
  steps: StepAborter;
}

export function newLoopState(
  steps: StepAborter = new StepAborter(),
): LoopState {
  return { failures: new Map(), steps };
}

/** 管理画面から中断したときの、止まった理由 */
export function abortReason(role: ActiveRole | undefined): string {
  return role === undefined
    ? "管理画面から中断しました。"
    : `管理画面から中断しました（${ROLE_LABELS[role]}の作業中）。`;
}

/**
 * 管理画面から中断したときの、それまでの変更についての一文。
 * work は変更を残す役（実装役）が残し方を伝えたときだけ渡る
 */
export function abortWorkNote(
  role: ActiveRole | undefined,
  work: PartialWork | undefined,
): string | undefined {
  switch (work?.kind) {
    case "pushed":
      return "それまでの変更は Issue のブランチに残しています。";
    case "nothing":
      return "ブランチに残す変更はありませんでした。";
    case "discarded":
      return "受け入れテスト・seed・.conductor/ が変わっていたため、それまでの変更はブランチに残していません。";
    case "failed":
      return `それまでの変更をブランチに残せませんでした（理由: ${work.reason}）。`;
    case undefined:
      // テスト役は書きかけのテストを残さない（続けるときは最初から書き直す）
      return role === "tester"
        ? "テスト役の書きかけの変更は残していません。続けるときはテスト役が最初からやり直します。"
        : undefined;
  }
}

/** 管理画面から中断したときの Issue のコメント */
export function abortComment(
  role: ActiveRole | undefined,
  ready: string,
  work?: PartialWork,
): string {
  const note = abortWorkNote(role, work);
  return [
    abortReason(role),
    "",
    `${note === undefined ? "" : note}続けるときは ${ready} 列に戻してください。`,
  ].join("\n");
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

/**
 * Blocked にした Issue のスレッドを確かめる（窓口があるときだけ）。
 * 失敗しても Issue の処理は止めない（次の確認でやり直す）
 */
async function blockedThreads(deps: LoopDeps): Promise<void> {
  const { chat } = deps;
  const chatConfig = deps.config.chat;
  if (chat === undefined || chatConfig === undefined) return;
  const { blocked } = deps.config.github.columns;
  try {
    await followBlockedThreads(
      {
        config: deps.config,
        chatConfig,
        chat,
        store: deps.store,
        board: deps.board,
        ...(deps.respec === undefined ? {} : { respec: deps.respec }),
        log: deps.log,
      },
      async () => (await deps.board.issuesByColumn()).get(blocked) ?? [],
    );
  } catch (e) {
    deps.log(
      `止まったときのスレッドの確認に失敗しました（次の確認でやり直します）: ${errorMessage(e)}`,
    );
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 記録が無いときは列から段階を決める */
export function stageOf(
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
  ctx: StepContext,
): Promise<StepResult | undefined> {
  const { config, store, board } = deps;
  const key: IssueKey = { repo: config.github.repo, issue: issue.number };
  const pr = (await store.get(key))?.pr;
  if (pr === undefined || !(await board.hasConflict(pr))) return undefined;
  return deps.syncMain(issue, pr, ctx);
}

/** 1段階進める */
async function advance(
  deps: LoopDeps,
  issue: LoopIssue,
  stage: Stage,
  ctx: StepContext,
): Promise<StepResult> {
  const key: IssueKey = { repo: deps.config.github.repo, issue: issue.number };
  switch (stage) {
    case "testing":
      return deps.test(issue, ctx);
    case "implementing":
      return deps.implement(issue, await pendingFindings(deps.store, key), ctx);
    case "ci": {
      const synced = await syncIfConflict(deps, issue, ctx);
      if (synced) return synced;
      const ci = await deps.checkCi(issue, ctx);
      if (ci.status !== "passed") return ci;
      if (ctx.signal.aborted) throw abortError();
      return deps.review(issue, ctx);
    }
    case "reviewing":
    case "approving":
      return (
        (await syncIfConflict(deps, issue, ctx)) ?? deps.review(issue, ctx)
      );
    case "merging":
      return deps.merge(issue, ctx);
  }
}

/** 管理画面から中断された段階を、失敗に数えずに Blocked にする */
async function blockAborted(
  deps: LoopDeps,
  state: LoopState,
  issue: number,
  role: ActiveRole | undefined,
  error: { e: unknown } | undefined,
): Promise<void> {
  state.failures.delete(issue);
  deps.log(`#${issue}: ${abortReason(role)}`);
  const work = partialWorkOf(error?.e);
  if (error !== undefined && !isAbortError(error.e)) {
    // 中断のほかに失敗していたら、その内容も残す
    deps.log(`#${issue}: 中断の間に失敗: ${errorMessage(error.e)}`);
  }
  if (work?.kind === "failed") {
    deps.log(`#${issue}: 変更をブランチに残せませんでした: ${work.reason}`);
  }
  try {
    await blockIssue(deps, issue, {
      body: abortComment(role, deps.config.github.columns.ready, work),
      // 変更を残せなかったときは、止まった理由にも書く（人が Ready に戻す前に気づけるように）
      reason:
        work?.kind === "failed"
          ? `${abortReason(role)}${abortWorkNote(role, work) ?? ""}`
          : abortReason(role),
    });
  } catch (e) {
    deps.log(`#${issue}: Blocked への移動に失敗: ${errorMessage(e)}`);
  }
}

/**
 * 失敗を数える。続けて MAX_FAILURES 回失敗したら Blocked にしてメンションする。
 * 管理画面から中断されたら、失敗に数えずに Blocked にする
 */
async function attempt(
  deps: LoopDeps,
  state: LoopState,
  issue: LoopIssue,
  step: (ctx: StepContext) => Promise<StepResult>,
): Promise<void> {
  const n = issue.number;
  const controller = state.steps.begin(n);
  const ctx: StepContext = { signal: controller.signal };
  let result: StepResult | undefined;
  let error: { e: unknown } | undefined;
  try {
    result = await step(ctx);
  } catch (e) {
    error = { e };
  }
  const role = state.steps.roleOf(controller);
  state.steps.end(controller);
  if (error === undefined) {
    // 中断されても最後まで進んだ段階（マージなど）は成功として扱う
    state.failures.delete(n);
    state.steps.noteWorking(n);
    deps.log(`#${n}: ${result?.status ?? ""}`);
    if (controller.signal.aborted) {
      // まだ処理中なら次の確認で Blocked に移す（マージして Done に移ったら予約は捨てる）
      state.steps.reserve(n);
      deps.log(
        `#${n}: 中断の前に段階が終わりました。次の確認でまだ処理中なら Blocked に移します`,
      );
    }
    return;
  }
  if (controller.signal.aborted) {
    await blockAborted(deps, state, n, role, error);
    return;
  }
  const message = errorMessage(error.e);
  const count = (state.failures.get(n) ?? 0) + 1;
  deps.log(`#${n}: 失敗（${count}/${MAX_FAILURES} 回目）: ${message}`);
  if (count < MAX_FAILURES) {
    state.failures.set(n, count);
    return;
  }
  state.failures.delete(n);
  try {
    // 窓口があればメンションせず、次の確認で質問チャンネルのスレッドで確かめる
    await blockIssue(deps, n, {
      body: failureComment(message, count, deps.config.github.columns.ready),
      reason: message,
    });
  } catch (e2) {
    deps.log(`#${n}: Blocked への移動に失敗: ${errorMessage(e2)}`);
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

/** 仕様化役が受け持つ要件の状態 */
const SPECIFYING_STATES: readonly RequirementRecord["state"][] = [
  "specifying",
  "awaiting_approval",
];

/**
 * スレッドがあり、仕様化中か承認待ちの要件を、仕様化役で1回分ずつ進める（specify があるときだけ）。
 * 失敗しても Issue の処理は止めない（次の確認でやり直す）
 */
async function specifyRequirements(deps: LoopDeps): Promise<void> {
  const { specify } = deps;
  if (specify === undefined) return;
  let requirements: RequirementRecord[];
  try {
    requirements = await deps.store.listRequirements();
  } catch (e) {
    deps.log(`要件の一覧を読めませんでした: ${errorMessage(e)}`);
    return;
  }
  for (const r of requirements) {
    if (r.threadId === undefined || !SPECIFYING_STATES.includes(r.state)) {
      continue;
    }
    try {
      const result = await specify(r);
      if (result.status !== "waiting") {
        deps.log(`要件 ${r.messageId}: ${result.status}`);
      }
    } catch (e) {
      deps.log(
        `要件 ${r.messageId} の仕様化に失敗しました（次の確認でやり直します）: ${errorMessage(e)}`,
      );
    }
  }
}

/**
 * スレッドがあり承認待ちの要件の、仕様の承認を1回分ずつ確かめる（approveSpec があるときだけ）。
 * 仕様化役が要約を書き直した後の状態で確かめるよう、仕様化の後に一覧を読み直す。
 * 失敗しても Issue の処理は止めない（次の確認でやり直す）
 */
async function approveSpecs(deps: LoopDeps): Promise<void> {
  const { approveSpec } = deps;
  if (approveSpec === undefined) return;
  let requirements: RequirementRecord[];
  try {
    requirements = await deps.store.listRequirements();
  } catch (e) {
    deps.log(`要件の一覧を読めませんでした: ${errorMessage(e)}`);
    return;
  }
  for (const r of requirements) {
    if (r.threadId === undefined || r.state !== "awaiting_approval") continue;
    try {
      const result = await approveSpec(r);
      if (result.status !== "waiting") {
        deps.log(`要件 ${r.messageId}: ${result.status}`);
      }
    } catch (e) {
      deps.log(
        `要件 ${r.messageId} の承認の確認に失敗しました（次の確認でやり直します）: ${errorMessage(e)}`,
      );
    }
  }
}

/**
 * スレッドがあり作業中で、作業用 Issue がまだ無い要件を分解する（decompose があるときだけ）。
 * 承認した直後の要件も拾うよう、仕様の承認の後に一覧を読み直す。
 * 失敗しても Issue の処理は止めない（次の確認でやり直す）
 */
async function decomposeRequirements(deps: LoopDeps): Promise<void> {
  const { decompose } = deps;
  if (decompose === undefined) return;
  let requirements: RequirementRecord[];
  try {
    requirements = await deps.store.listRequirements();
  } catch (e) {
    deps.log(`要件の一覧を読めませんでした: ${errorMessage(e)}`);
    return;
  }
  for (const r of requirements) {
    if (
      r.threadId === undefined ||
      r.state !== "working" ||
      r.workIssues.length > 0
    ) {
      continue;
    }
    try {
      const result = await decompose(r);
      deps.log(`要件 ${r.messageId}: ${result.status}`);
    } catch (e) {
      deps.log(
        `要件 ${r.messageId} の分解に失敗しました（次の確認でやり直します）: ${errorMessage(e)}`,
      );
    }
  }
}

/**
 * スレッドがあり作業中で、作業用 Issue がある要件の進み具合を確かめる（progress があるときだけ）。
 * 分解した直後の要件も拾うよう、分解の後に一覧を読み直す。Ready に移した Issue は同じ確認で拾う。
 * 失敗しても Issue の処理は止めない（次の確認でやり直す）
 */
async function progressRequirements(deps: LoopDeps): Promise<void> {
  const { progress } = deps;
  if (progress === undefined) return;
  let requirements: RequirementRecord[];
  try {
    requirements = await deps.store.listRequirements();
  } catch (e) {
    deps.log(`要件の一覧を読めませんでした: ${errorMessage(e)}`);
    return;
  }
  for (const r of requirements) {
    if (
      r.threadId === undefined ||
      r.state !== "working" ||
      r.workIssues.length === 0
    ) {
      continue;
    }
    try {
      const result = await progress(r);
      if (result.status !== "waiting") {
        deps.log(`要件 ${r.messageId}: ${result.status}`);
      }
    } catch (e) {
      deps.log(
        `要件 ${r.messageId} の作業用 Issue の確認に失敗しました（次の確認でやり直します）: ${errorMessage(e)}`,
      );
    }
  }
}

/** 1回分の確認。要件の受け取り・仕様化・仕様の承認・分解・作業用 Issue の着手と完了と、作業中の Issue の処理を行う */
export async function tick(deps: LoopDeps, state: LoopState): Promise<void> {
  const { config, store, board } = deps;
  await intakeRequirements(deps);
  await specifyRequirements(deps);
  await approveSpecs(deps);
  await decomposeRequirements(deps);
  await progressRequirements(deps);
  // Ready に戻した Issue を同じ確認で拾うよう、列を読む前に確かめる
  await blockedThreads(deps);
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

  // 段階の合間に中断を頼まれた Issue は、段階を始めずに Blocked に移す（次の Ready は次の確認で始める）
  state.steps.setWorking(working.map((w) => w.issue.number));
  const aborted = working.filter((w) =>
    state.steps.takePending(w.issue.number),
  );
  for (const { issue } of aborted) {
    await blockAborted(deps, state, issue.number, undefined, undefined);
  }
  if (aborted.length > 0) return;

  // 承認待ちは作業中に数えず、毎回コメントだけを確かめる
  for (const { issue } of working.filter((w) => isApproving(w.issue.number))) {
    await attempt(deps, state, issue, (ctx) =>
      advance(deps, issue, "approving", ctx),
    );
  }

  const active = working.find((w) => !isApproving(w.issue.number));
  if (active) {
    const { issue, column } = active;
    const stage = stageOf(records.get(issue.number), column, columns);
    await attempt(deps, state, issue, (ctx) =>
      advance(deps, issue, stage, ctx),
    );
    return;
  }

  const ready = inColumn(columns.ready)[0]?.issue;
  if (!ready) return;
  await attempt(deps, state, ready, async (ctx) => {
    const r = await deps.pickUp(ready);
    if (!r.accepted) return { status: "blocked" };
    if (ctx.signal.aborted) throw abortError();
    const record = await store.get({ repo, issue: ready.number });
    return advance(deps, ready, record?.checkpoint?.stage ?? "testing", ctx);
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
  options: {
    intervalMs?: number;
    /** 管理画面からの中断を受け付ける（supervisor.ts が渡す）。省略したら中から作る */
    steps?: StepAborter;
  } = {},
): Promise<void> {
  const state = newLoopState(options.steps);
  const interval = options.intervalMs ?? LOOP_INTERVAL_MS;
  const sleep = deps.sleep ?? abortableSleep;
  const tracker = new ActivityTracker(deps.onActivity);
  const tracked = trackRoles(deps, tracker, state.steps);
  deps.log(`開始しました（${Math.round(interval / 1000)} 秒ごとに確認）`);
  while (!signal.aborted) {
    deps.onStatus?.("running");
    tracker.checked(new Date());
    try {
      await tick(tracked, state);
    } catch (e) {
      deps.log(
        `確認に失敗しました（次の確認でやり直します）: ${errorMessage(e)}`,
      );
    }
    tracker.stopped();
    if (signal.aborted) break;
    deps.onStatus?.("idle");
    tracker.waiting(interval);
    await sleep(interval, signal);
  }
  deps.log("止まりました");
}

/**
 * Issue #67: 管理画面：処理中の作業の中断 の受け入れテスト
 *
 * 決めたこと（実装役はこれに合わせて作る）:
 * - 外部コマンドの中断 `src/exec.ts`
 *   ```ts
 *   export interface ExecOptions {
 *     // 既存の項目はそのまま
 *     /** 中断の signal。来たら子プロセスとその子孫をすべて終わらせ（Windows でも残さない）、
 *      *  終わってから name が "AbortError" の Error で reject する *\/
 *     signal?: AbortSignal;
 *   }
 *   ```
 * - 役の中断 `src/claude.ts`
 *   - RoleRun に `signal?: AbortSignal` を足す。runRole はそれを exec の options.signal に渡す
 *   - 中断されたら、やり直さず（利用上限の待ちにもせず）name が "AbortError" の Error で reject する
 * - 常駐ループの段階の関数は、最後の引数で中断の signal を受け取る（`src/loop.ts`）
 *   ```ts
 *   export interface StepContext { signal: AbortSignal }
 *   // LoopDeps の段階の関数に、最後の引数として足す
 *   test(issue, ctx?: StepContext); implement(issue, findings, ctx?: StepContext);
 *   checkCi(issue, ctx?); review(issue, ctx?); merge(issue, ctx?); syncMain(issue, pr, ctx?);
 *   ```
 *   start.ts は ctx.signal を各役の RoleRun.signal（実装役は ImplementerDeps.signal）につなぐ
 * - 中断を受け付けるのは `src/supervisor.ts` の Supervisor
 *   ```ts
 *   /** 処理中の Issue の作業を中断する。いま動いている段階の signal をすぐ abort し、受け付けたら resolve（役が終わるのは待たない） *\/
 *   abort(issue: number): Promise<void>;
 *   ```
 *   - 中断した段階が終わったら（役が AbortError で終わったら）、失敗には数えず、blockIssue で Blocked に移す。
 *     止まった理由（blockedReason）とコメントは、画面から中断したことがわかる文（「中断」を含む。
 *     例「管理画面から中断しました（実装役の作業中）。」）。Blocked にする前の段階（checkpoint.stage）はそのまま
 *   - そのあとはいつもどおり次の確認を待ち（sleep）、次の確認で次の Ready の Issue を始める
 * - 実装役 `src/implementer.ts`
 *   - ImplementerDeps に `signal?: AbortSignal` を足し、deps.run に渡す RoleRun.signal に入れる
 *   - 中断されたら、それまでの変更（変えてはいけないファイルを除く）をコミットして Issue のブランチに push してから、
 *     AbortError をそのまま投げる。人が Ready に戻すと、いつもどおり origin のブランチから続ける
 * - 管理画面 `src/admin-server.ts`
 *   - AdminControl に `abort?(issue: number): Promise<void>` を足す（start.ts が Supervisor をつなぐ）
 *   - `POST /api/abort/<番号>` で control.abort(番号) を呼び、終わってから 2xx を返す。
 *     Origin の決まりは停止・再起動と同じ（ほかの Origin は 403 にして何もしない）
 * - 画面の流れ `web/src/control.ts`
 *   - ControlKind に "abort" を足す（CONTROL_PATHS.abort は "/api/abort"）。ControlState に
 *     `abort?: { issue: number; role?: DashboardRole }`（中断のダイアログに出す Issue と役）を足す
 *   - `askAbort(state, issue: number, role?: DashboardRole): ControlState` … 中断のダイアログを出す（dialog: "abort"）
 *   - confirmControl は dialog が "abort" なら `/api/abort/<番号>` に POST する（ほかは今のまま）
 * - 画面 `web/src/Dashboard.tsx`
 *   - DashboardProps に `onAbort?: (issue: number, role: DashboardRole | undefined) => void` を足す
 *   - 処理中の Issue の欄（data.active があるとき）に `<button>この作業を中断</button>`（辞書 abort）。無ければ出さない
 * - 画面 `web/src/Layout.tsx`
 *   - control.dialog が "abort" なら role="dialog" の要素に、見出し「#<番号> の作業を中断しますか？」、
 *     本文「動作中の<役>を止め、Issue を Blocked 列に移します。」（役は辞書 roles）、
 *     `<button>キャンセル</button>` と `<button>中断する</button>`（辞書 abortOk）を出す。英語は辞書 en
 *
 * seed: 記録は MemoryStore、GitHub は列とコメントを覚える偽物、claude は偽物（実装役の実行は中断されるまで戻らない）。
 * ブランチは一時フォルダの本物の git（origin も一時フォルダの bare リポジトリ。ネットワークには出ない）。
 * 子プロセスまで残らないことは、孫プロセスを起こす node のスクリプトで確かめる。
 * 待ち（sleep）は wake を呼ぶまで戻らない偽物で、時刻に頼らない（管理画面の HTTP だけ 127.0.0.1 につなぐ）。
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { type ComponentType, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { startAdminServer } from "../admin-server.js";
import {
  type ClaudeDeps,
  commonOutputSchema,
  type ExecResult,
  runRole,
} from "../claude.js";
import { type Config, parseConfig } from "../config.js";
import { type DashboardData, loadDashboard } from "../dashboard.js";
import { commandExec, type ExecOptions } from "../exec.js";
import { Git } from "../git.js";
import {
  forbiddenGlobs,
  type ImplementerOutput,
  runImplementer,
} from "../implementer.js";
import type { LoopDeps, LoopIssue, StepContext } from "../loop.js";
import { type IssueKey, MemoryStore, type Stage } from "../store.js";
import { type Supervisor, startSupervisor } from "../supervisor.js";

// ---- seed ----

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REPO = "pkshimizu/wordcards";
const PROJECT = 3;
const BRANCH = "conductor/issue-12";
const INDEX_HTML = "<!doctype html><title>conductor</title>";
const ISSUE: LoopIssue = {
  number: 12,
  title: "単語の一覧に並べ替えをつける",
  body: "本文",
};
const NEXT: LoopIssue = {
  number: 13,
  title: "単語帳を書き出す",
  body: "本文",
};
const key = (issue: number): IssueKey => ({ repo: REPO, issue });

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function configYaml(options: { chat?: boolean } = {}): string {
  const lines = [
    `github: { repo: ${REPO}, project: ${PROJECT}, notify: someone }`,
    "protected: [src/acceptance/**]",
    "commands: { setup: s, test: t, acceptance: a, typecheck: c, build: b }",
    "merge: { approval: human }",
    "poll_interval: 30",
    "limits: { rejections: 3, objections: 2 }",
  ];
  if (options.chat === true) {
    lines.push(
      "chat:",
      "  type: discord",
      "  channels:",
      '    requirements: "1000000000000000001"',
      '    questions: "1000000000000000002"',
      '    notices: "1000000000000000003"',
      "  allowed_users:",
      '    - "2000000000000000001"',
    );
  }
  return lines.join("\n");
}

function abortError(): Error {
  const e = new Error("中断しました");
  e.name = "AbortError";
  return e;
}

/** 呼ばれたことを順に覚える。when で、その呼び出しが n 回目に届くまで待てる */
class Calls {
  readonly list: string[] = [];
  private waiters: { name: string; nth: number; done: () => void }[] = [];

  push(name: string): void {
    this.list.push(name);
    this.waiters = this.waiters.filter((w) => {
      if (this.count(w.name) < w.nth) return true;
      w.done();
      return false;
    });
  }

  count(name: string): number {
    return this.list.filter((x) => x === name).length;
  }

  when(name: string, nth = 1): Promise<void> {
    if (this.count(name) >= nth) return Promise.resolve();
    return new Promise((done) => this.waiters.push({ name, nth, done }));
  }
}

interface FakeComment {
  issue: number;
  body: string;
  mention: boolean;
}

/** 列・コメント・PR を覚える GitHub。動かしたら "move#<番号>:<列>" と記録する */
class FakeBoard {
  readonly columns = new Map<string, LoopIssue[]>();
  readonly comments: FakeComment[] = [];
  readonly pulls: { issue: number; head: string }[] = [];

  constructor(
    private readonly calls: Calls,
    columns: Record<string, LoopIssue[]>,
  ) {
    for (const [c, list] of Object.entries(columns)) {
      this.columns.set(c, [...list]);
    }
  }

  columnOf(issue: number): string | undefined {
    for (const [c, list] of this.columns) {
      if (list.some((i) => i.number === issue)) return c;
    }
    return undefined;
  }

  issuesByColumn(): Promise<Map<string, LoopIssue[]>> {
    return Promise.resolve(
      new Map([...this.columns].map(([c, list]) => [c, [...list]])),
    );
  }

  /** 人が GitHub で列を動かす（conductor の呼び出しとしては記録しない） */
  humanMove(issue: number, column: string): void {
    this.place(issue, column);
  }

  moveIssue(issue: number, column: string): Promise<void> {
    this.place(issue, column);
    this.calls.push(`move#${issue}:${column}`);
    return Promise.resolve();
  }

  private place(issue: number, column: string): void {
    let found: LoopIssue | undefined;
    for (const list of this.columns.values()) {
      const i = list.findIndex((x) => x.number === issue);
      if (i >= 0) found = list.splice(i, 1)[0];
    }
    const target = this.columns.get(column) ?? [];
    target.push(found ?? { number: issue, title: "", body: "" });
    this.columns.set(column, target);
  }

  comment(
    issue: number,
    body: string,
    options?: { mention?: boolean },
  ): Promise<void> {
    this.comments.push({ issue, body, mention: options?.mention === true });
    return Promise.resolve();
  }

  hasConflict(): Promise<boolean> {
    return Promise.resolve(false);
  }

  findPullRequest(): Promise<{ number: number; url: string } | undefined> {
    return Promise.resolve(undefined);
  }

  createPullRequest(input: {
    issue: number;
    head: string;
  }): Promise<{ number: number; url: string }> {
    this.pulls.push({ issue: input.issue, head: input.head });
    this.calls.push(`pr#${input.issue}`);
    return Promise.resolve({
      number: 21,
      url: `https://github.com/${REPO}/pull/21`,
    });
  }
}

/** 本物の git の一時リポジトリ（origin は bare）。#12 のブランチに受け入れテストを置いて push 済み */
async function seedGit(config: Config) {
  const origin = await mkdtemp(join(tmpdir(), "conductor-67-origin-"));
  const dir = await mkdtemp(join(tmpdir(), "conductor-67-work-"));
  cleanups.push(() => rm(origin, { recursive: true, force: true }));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const sh = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  const put = async (path: string, text: string) => {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), text);
  };
  execFileSync("git", ["init", "-q", "--bare", "-b", "main"], { cwd: origin });
  sh("init", "-q", "-b", "main");
  sh("config", "user.email", "test@example.com");
  sh("config", "user.name", "test");
  sh("config", "core.autocrlf", "false");
  sh("remote", "add", "origin", origin);
  await put("src/app.ts", "export const app = 1;\n");
  sh("add", "-A");
  sh("commit", "-q", "-m", "init");
  sh("push", "-q", "-u", "origin", "main");
  sh("switch", "-q", "-c", BRANCH);
  await put("src/acceptance/12-sort.test.ts", "// 受け入れテスト\n");
  sh("add", "-A");
  sh("commit", "-q", "-m", "test: #12 の受け入れテスト");
  sh("push", "-q", "-u", "origin", BRANCH);
  const protectedHash = await new Git(dir).treeHash(
    "HEAD",
    forbiddenGlobs(config),
  );
  /** origin のブランチにあるファイルの中身。無ければ undefined */
  const onOrigin = (path: string): string | undefined => {
    try {
      return execFileSync(
        "git",
        [`--git-dir=${origin}`, "show", `${BRANCH}:${path}`],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
    } catch {
      return undefined;
    }
  };
  return { dir, origin, sh, protectedHash, onOrigin };
}

type GitSeed = Awaited<ReturnType<typeof seedGit>>;

const FIRST = "export const sortWords = (w: string[]) => [...w];\n";
const SECOND = "export const sortOrder = 'asc';\n";

/**
 * conductor の外側（GitHub・各役・待ち）の偽物。#12 は実装の段階で Implementing の列にある。
 * implement:
 * - "hold": 実装役（偽物）は中断されるまで終わらない
 * - "real": 本物の runImplementer を、claude の偽物（1回目は src/sort.ts を書いて中断を待つ。
 *   2回目はそのときの src/sort.ts を覚えて書き足し、approve を返す）と本物の git でつなぐ
 */
async function seedWorld(options: {
  implement: "hold" | "real";
  chat?: boolean;
  ready?: LoopIssue[];
}) {
  const config = parseConfig(configYaml({ chat: options.chat === true }));
  const calls = new Calls();
  const store = new MemoryStore();
  const board = new FakeBoard(calls, {
    Ready: [...(options.ready ?? [])],
    Testing: [],
    Implementing: [ISSUE],
    Reviewing: [],
    Done: [],
    Blocked: [],
  });
  const git: GitSeed | undefined =
    options.implement === "real" ? await seedGit(config) : undefined;
  await store.update(key(ISSUE.number), {
    branch: BRANCH,
    checkpoint: { stage: "implementing" as Stage },
    ...(git === undefined ? {} : { protectedHash: git.protectedHash }),
  });

  /** 中断されるまで終わらない処理の、終わらせ方（テストが失敗したときの後片付け用） */
  const pending: (() => void)[] = [];
  const release = () => {
    for (const fail of pending.splice(0)) fail();
  };
  const waitForAbort = (signal: AbortSignal | undefined, what: string) => {
    if (signal === undefined) {
      return Promise.reject(
        new Error(`${what}に中断の signal が渡されていない`),
      );
    }
    return new Promise<never>((_, reject) => {
      const fail = () => reject(abortError());
      pending.push(fail);
      if (signal.aborted) fail();
      else signal.addEventListener("abort", fail, { once: true });
    });
  };

  /** 段階の関数が受け取った中断の signal */
  const signals: AbortSignal[] = [];
  /** claude の偽物に渡った RoleRun.signal と、2回目に見えた src/sort.ts */
  const roleRuns: { signal?: AbortSignal; saw?: string | undefined }[] = [];
  const logs: string[] = [];

  const holdImplement = async (
    issue: LoopIssue,
    _findings: string[],
    ctx?: StepContext,
  ) => {
    calls.push(`implement#${issue.number}`);
    if (ctx?.signal !== undefined) signals.push(ctx.signal);
    try {
      return await waitForAbort(ctx?.signal, "実装の段階");
    } finally {
      calls.push(`implemented#${issue.number}`);
    }
  };

  const realImplement = async (
    issue: LoopIssue,
    findings: string[],
    ctx?: StepContext,
  ) => {
    calls.push(`implement#${issue.number}`);
    if (ctx?.signal !== undefined) signals.push(ctx.signal);
    try {
      return await runImplementer(
        {
          config,
          repoDir: git!.dir,
          git: new Git(git!.dir),
          board,
          store,
          shell: (): Promise<ExecResult> =>
            Promise.resolve({ code: 0, stdout: "", stderr: "" }),
          instructions: "",
          ...(ctx?.signal === undefined ? {} : { signal: ctx.signal }),
          run: async (run) => {
            const n = roleRuns.length + 1;
            const file = join(run.cwd, "src", "sort.ts");
            const signal = (run as { signal?: AbortSignal }).signal;
            if (n === 1) {
              roleRuns.push(signal === undefined ? {} : { signal });
              await writeFile(file, FIRST);
              calls.push("role#1");
              return await waitForAbort(signal, "実装役の実行");
            }
            const saw = await readFile(file, "utf8").catch(() => undefined);
            roleRuns.push({ saw });
            await writeFile(file, `${saw ?? ""}${SECOND}`);
            calls.push(`role#${n}`);
            const output: ImplementerOutput = {
              verdict: "approve",
              summary: "続きから実装しました",
              findings: [],
            };
            return {
              output,
              denials: [],
              costUsd: 0,
              turns: 1,
              sessionId: `s${n}`,
            };
          },
        },
        issue,
        findings,
      );
    } finally {
      calls.push(`implemented#${issue.number}`);
    }
  };

  // 待ち（sleep）は wake を呼ぶまで戻らない（止められたら戻る）
  const sleepers: (() => void)[] = [];
  const wake = () => {
    for (const done of sleepers.splice(0)) done();
  };

  const buildDeps = (c: Config): Promise<LoopDeps> =>
    Promise.resolve({
      config: c,
      store,
      board,
      pickUp: async (issue) => {
        calls.push(`pickUp#${issue.number}`);
        await board.moveIssue(issue.number, c.github.columns.testing);
        return { accepted: true };
      },
      test: (issue) => {
        calls.push(`test#${issue.number}`);
        return Promise.resolve({ status: "tested" });
      },
      implement: options.implement === "real" ? realImplement : holdImplement,
      checkCi: (issue) => {
        calls.push(`checkCi#${issue.number}`);
        return Promise.resolve({ status: "pending" });
      },
      review: (issue) => {
        calls.push(`review#${issue.number}`);
        return Promise.resolve({ status: "reviewed" });
      },
      merge: (issue) => {
        calls.push(`merge#${issue.number}`);
        return Promise.resolve({ status: "merged" });
      },
      syncMain: (issue) => {
        calls.push(`syncMain#${issue.number}`);
        return Promise.resolve({ status: "synced" });
      },
      log: (text) => logs.push(text),
      sleep: (_ms, signal) => {
        calls.push("sleep");
        return new Promise<void>((done) => {
          sleepers.push(done);
          if (signal.aborted) done();
          else signal.addEventListener("abort", () => done(), { once: true });
        });
      },
    });

  return {
    config,
    calls,
    store,
    board,
    git,
    signals,
    roleRuns,
    logs,
    wake,
    release,
    buildDeps,
  };
}

type World = Awaited<ReturnType<typeof seedWorld>>;

/** 管理画面と、中断を受け持つ部品をつないで起動する */
async function seedConductor(world: World) {
  const assets = await mkdtemp(join(tmpdir(), "conductor-admin-67-"));
  cleanups.push(() => rm(assets, { recursive: true, force: true }));
  await writeFile(join(assets, "index.html"), INDEX_HTML);
  const server = await startAdminServer({
    repo: REPO,
    project: PROJECT,
    status: "running",
    log: () => {},
    assetsDir: assets,
    control: {
      stop: () => supervisor.stop(),
      restart: () => supervisor.restart(),
      abort: (issue: number) => supervisor.abort(issue),
    },
  });
  cleanups.push(() => server.close());
  const supervisor: Supervisor = startSupervisor({
    repoDir: world.git?.dir ?? ROOT,
    config: world.config,
    buildDeps: world.buildDeps,
    onStatus: (s) => server.setStatus(s),
    log: (text) => world.logs.push(text),
  });
  cleanups.push(() => supervisor.shutdown());
  // 終わっていない役を先に終わらせてから止める（テストが失敗したときに後片付けで止まらないように）
  cleanups.push(() => world.release());
  const posts: string[] = [];
  /** 画面と同じく、管理画面そのものの Origin で POST する */
  const post = async (path: string) => {
    posts.push(path);
    const res = await fetch(new URL(path, server.url), {
      method: "POST",
      headers: { origin: new URL(server.url).origin },
    });
    await res.text();
    return { ok: res.ok, status: res.status };
  };
  return { server, supervisor, post, posts };
}

/** すでに届いている処理を流す（時刻には頼らない） */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((done) => setImmediate(done));
  }
}

// ---- 画面のソース（src の外にあるので、実行時に import する） ----

type Lang = "ja" | "en";
type Role =
  | "tester"
  | "implementer"
  | "ci"
  | "reviewer"
  | "merge"
  | "specifier"
  | "decomposer";
type ControlKind = "restart" | "stop" | "abort";
interface ControlState {
  dialog?: ControlKind;
  toast?: ControlKind;
  failed?: ControlKind;
  abort?: { issue: number; role?: Role };
}

interface ControlModule {
  CONTROL_PATHS: Readonly<Record<ControlKind, string>>;
  askAbort(state: ControlState, issue: number, role?: Role): ControlState;
  cancelControl(state: ControlState): ControlState;
  confirmControl(
    state: ControlState,
    post: (path: string) => Promise<{ ok: boolean }>,
    update: (state: ControlState) => void,
  ): Promise<ControlState>;
}

interface DashboardProps {
  data: DashboardData;
  lang: Lang;
  now: Date;
  onNavigate?: (path: string) => void;
  onAbort?: (issue: number, role: Role | undefined) => void;
}

async function importWeb<T>(file: string): Promise<T> {
  const url = pathToFileURL(join(ROOT, "web", "src", file)).href;
  return (await import(/* @vite-ignore */ url)) as T;
}

const control = () => importWeb<ControlModule>("control.ts");

/** タグを除いた文 */
function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function buttonsOf(html: string): string[] {
  return [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((m) =>
    textOf(m[1]!),
  );
}

/** 見出しの文を含む <section>。無ければ undefined */
function sectionOf(html: string, title: string): string | undefined {
  const sections = html.match(/<section\b[\s\S]*?<\/section>/g) ?? [];
  return sections.find((s) => textOf(s).includes(title));
}

async function renderDashboard(data: DashboardData, lang: Lang = "ja") {
  const { Dashboard } = await importWeb<{
    Dashboard: ComponentType<DashboardProps>;
  }>("Dashboard.tsx");
  // 画面には SSE（JSON）で届くので、JSON を通したものを描く
  const sent = JSON.parse(JSON.stringify(data)) as DashboardData;
  return renderToStaticMarkup(
    createElement(Dashboard, {
      data: sent,
      lang,
      now: new Date(),
      onAbort: () => {},
    }),
  );
}

/** 共通の枠を描いて、ダイアログ（role="dialog" の要素から後ろ）を返す */
async function renderDialog(control: ControlState, lang: Lang = "ja") {
  const { Layout } = await importWeb<{
    Layout: ComponentType<Record<string, unknown>>;
  }>("Layout.tsx");
  const html = renderToStaticMarkup(
    createElement(Layout, {
      path: "/",
      lang,
      scheme: "light",
      repo: REPO,
      project: PROJECT,
      status: "running",
      control,
    }),
  );
  const i = html.search(/role="dialog"/);
  return i < 0 ? undefined : html.slice(html.lastIndexOf("<", i));
}

async function dashboardOf(world: World, running?: Role) {
  return loadDashboard({
    config: world.config,
    store: world.store,
    board: world.board,
    status: "running",
    activity:
      running === undefined
        ? {}
        : { running: { issue: ISSUE.number, role: running } },
  });
}

// ---- 子プロセス ----

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 外のプロセスの様子が変わるまで確かめ直す（回数で打ち切る） */
async function eventually(check: () => Promise<boolean> | boolean) {
  for (let i = 0; i < 400; i++) {
    if (await check()) return true;
    await new Promise((done) => setTimeout(done, 25));
  }
  return false;
}

/** 孫プロセスを起こし、親と孫の PID をファイルに書いて、終わらずに待つ node のスクリプト */
const TREE_SCRIPT = `
const { spawn } = require("node:child_process");
const { renameSync, writeFileSync } = require("node:fs");
const out = process.argv[2];
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
child.on("spawn", () => {
  writeFileSync(out + ".tmp", JSON.stringify({ parent: process.pid, child: child.pid }));
  renameSync(out + ".tmp", out);
});
setInterval(() => {}, 1000);
`;

describe("Issue #67: 管理画面：処理中の作業の中断", () => {
  it(
    "AC1: ダッシュボードの「この作業を中断」→「中断する」で、動いている役（claude -p）をすぐ終わらせ、子プロセスまで残さない",
    { timeout: 30_000 },
    async () => {
      // Given: 処理中の Issue がある（#12 の実装役が動いている）
      const world = await seedWorld({ implement: "hold" });
      const c = await seedConductor(world);
      await world.calls.when("implement#12");
      expect(world.signals).toHaveLength(1);
      const signal = world.signals[0]!;
      expect(signal.aborted).toBe(false);

      // When: ダッシュボードの「この作業を中断」を押す
      const data = await dashboardOf(world, "implementer");
      const active = sectionOf(await renderDashboard(data), "処理中の Issue");
      expect(active, "「処理中の Issue」の <section>").toBeDefined();
      expect(buttonsOf(active!)).toContain("この作業を中断");
      const ctl = await control();
      const asked = ctl.askAbort({}, ISSUE.number, data.active?.role);
      expect(asked.dialog).toBe("abort");

      // 確認のダイアログ（デザインの文言）
      const dialog = await renderDialog(asked);
      expect(dialog, "中断のダイアログ").toBeDefined();
      expect(textOf(dialog!)).toContain("#12 の作業を中断しますか？");
      expect(textOf(dialog!)).toContain(
        "動作中の実装役を止め、Issue を Blocked 列に移します。",
      );
      expect(buttonsOf(dialog!)).toEqual(
        expect.arrayContaining(["キャンセル", "中断する"]),
      );
      const dialogEn = await renderDialog(asked, "en");
      expect(textOf(dialogEn ?? "")).toContain("Abort the run for #12?");
      expect(textOf(dialogEn ?? "")).toContain(
        "This stops the running Implementer and moves the issue to the Blocked column.",
      );
      expect(buttonsOf(dialogEn ?? "")).toEqual(
        expect.arrayContaining(["Cancel", "Abort run"]),
      );

      // 別のサイトからの POST は受け付けない（何もしない）
      const foreign = await fetch(new URL("/api/abort/12", c.server.url), {
        method: "POST",
        headers: { origin: "http://evil.example" },
      });
      expect(foreign.status).toBe(403);
      await flush();
      expect(signal.aborted).toBe(false);

      // When: 確認で「中断する」を押す
      const final = await ctl.confirmControl(asked, c.post, () => {});

      // Then: /api/abort/12 に頼み、動いている役をすぐ終わらせる（段階の終わりを待たない）
      expect(c.posts).toEqual(["/api/abort/12"]);
      expect(final.dialog).toBeUndefined();
      expect(final.failed).toBeUndefined();
      expect(signal.aborted).toBe(true);
      await world.calls.when("implemented#12");
      expect(c.supervisor.status()).not.toBe("stopping");
      expect(c.supervisor.status()).not.toBe("stopped");

      // Then: 役（claude -p）には中断の signal を渡し、中断されたらやり直さずに終わる
      const execs: ExecOptions[] = [];
      const claude: ClaudeDeps = {
        exec: (_args, options) => {
          execs.push(options);
          const s = options.signal;
          if (s === undefined) {
            return Promise.reject(new Error("exec に signal が渡されていない"));
          }
          return new Promise<ExecResult>((_, reject) => {
            if (s.aborted) reject(abortError());
            else s.addEventListener("abort", () => reject(abortError()));
          });
        },
        sleep: () => Promise.reject(new Error("待たないはず")),
        now: () => new Date(),
      };
      const roleController = new AbortController();
      const role = runRole(
        {
          role: "implementer",
          cwd: tmpdir(),
          systemPrompt: "決まり",
          prompt: "依頼",
          schema: commonOutputSchema,
          allow: [],
          signal: roleController.signal,
        } as Parameters<typeof runRole>[0],
        claude,
      );
      await flush();
      expect(execs).toHaveLength(1);
      roleController.abort();
      await expect(role).rejects.toMatchObject({ name: "AbortError" });
      expect(execs).toHaveLength(1);

      // Then: 子プロセスを中断すると、その子（孫プロセス）まで残らない（Windows でも）
      const work = await mkdtemp(join(tmpdir(), "conductor-67-exec-"));
      cleanups.push(() => rm(work, { recursive: true, force: true }));
      const script = join(work, "tree.cjs");
      const pidFile = join(work, "pids.json");
      await writeFile(script, TREE_SCRIPT);
      const execController = new AbortController();
      const running = commandExec(process.execPath)([script, pidFile], {
        cwd: work,
        signal: execController.signal,
      } as ExecOptions);
      running.catch(() => {});
      const started = await eventually(() =>
        readFile(pidFile, "utf8").then(
          () => true,
          () => false,
        ),
      );
      expect(started, "孫プロセスが起動した").toBe(true);
      const pids = JSON.parse(await readFile(pidFile, "utf8")) as {
        parent: number;
        child: number;
      };
      cleanups.push(() => {
        for (const pid of [pids.parent, pids.child]) {
          try {
            process.kill(pid);
          } catch {
            // もう終わっている
          }
        }
      });
      expect(isAlive(pids.parent)).toBe(true);
      expect(isAlive(pids.child)).toBe(true);

      execController.abort();
      await expect(running).rejects.toMatchObject({ name: "AbortError" });
      expect(
        await eventually(() => !isAlive(pids.parent)),
        "子プロセスが終わる",
      ).toBe(true);
      expect(
        await eventually(() => !isAlive(pids.child)),
        "孫プロセスも終わる",
      ).toBe(true);
    },
  );

  it(
    "AC2: 中断した役が終わったら、それまでの変更を Issue のブランチに残し、Blocked 列に移して、中断したことがわかる理由といつもの知らせを出す",
    { timeout: 30_000 },
    async () => {
      // ---- 窓口が無いとき：Issue でメンションする ----
      {
        // Given: 中断した（実装役が src/sort.ts を書いている途中）
        const world = await seedWorld({ implement: "real" });
        const git = world.git!;
        const c = await seedConductor(world);
        await world.calls.when("role#1");
        expect(
          world.roleRuns[0]?.signal,
          "実装役の実行に中断の signal を渡す",
        ).toBeDefined();
        expect(git.onOrigin("src/sort.ts")).toBeUndefined();
        await c.supervisor.abort(ISSUE.number);

        // When: 役が終わる
        await world.calls.when("implemented#12");
        await world.calls.when("move#12:Blocked");
        await world.calls.when("sleep");

        // Then: それまでの変更は Issue のブランチ（origin）に残す。受け入れテストはそのまま
        expect(git.onOrigin("src/sort.ts")).toBe(FIRST);
        expect(git.onOrigin("src/acceptance/12-sort.test.ts")).toBe(
          "// 受け入れテスト\n",
        );

        // Then: Issue を Blocked 列に移す（失敗としてやり直さない）
        expect(world.board.columnOf(ISSUE.number)).toBe("Blocked");
        expect(world.calls.count("implement#12")).toBe(1);
        const record = await world.store.get(key(ISSUE.number));
        expect(record?.checkpoint?.stage).toBe("implementing");

        // Then: 止まった理由は、画面から中断したことがわかる文
        const reason = record?.blockedReason ?? "";
        expect(reason).toMatch(/中断/);
        expect(reason).not.toMatch(/失敗/);
        const data = await loadDashboard({
          config: world.config,
          store: world.store,
          board: world.board,
          status: "idle",
          activity: {},
        });
        const blocked = sectionOf(
          await renderDashboard(data),
          "人の判断を待っています",
        );
        expect(blocked, "「人の判断を待っています」の欄").toBeDefined();
        expect(textOf(blocked!)).toContain("#12");
        expect(textOf(blocked!)).toMatch(/中断/);

        // Then: いつもの知らせ（窓口が無いので Issue でメンションする）
        const notes = world.board.comments.filter(
          (x) => x.issue === ISSUE.number && /中断/.test(x.body),
        );
        expect(notes, "中断したことのコメント").toHaveLength(1);
        expect(notes[0]!.mention).toBe(true);
      }

      // ---- 窓口があるとき：Discord のスレッドで確かめる ----
      {
        // Given: 中断した
        const world = await seedWorld({ implement: "hold", chat: true });
        const c = await seedConductor(world);
        await world.calls.when("implement#12");
        await c.supervisor.abort(ISSUE.number);

        // When: 役が終わる
        await world.calls.when("implemented#12");
        await world.calls.when("move#12:Blocked");
        await world.calls.when("sleep");

        // Then: Blocked に移し、メンションせずに、次の確認でスレッドを作るよう理由を記録する
        expect(world.board.columnOf(ISSUE.number)).toBe("Blocked");
        const thread = await world.store.getBlockedThread(key(ISSUE.number));
        expect(thread, "スレッドの記録").toBeDefined();
        expect(thread!.reason).toMatch(/中断/);
        const notes = world.board.comments.filter(
          (x) => x.issue === ISSUE.number && /中断/.test(x.body),
        );
        expect(notes, "中断したことのコメント").toHaveLength(1);
        expect(world.board.comments.some((x) => x.mention)).toBe(false);
      }
    },
  );

  it("AC3: 中断して Blocked に移したあと、次の確認で次の Ready の Issue を始める", async () => {
    // Given: 中断して Blocked に移した（Ready に #13 がある）
    const world = await seedWorld({ implement: "hold", ready: [NEXT] });
    const c = await seedConductor(world);
    await world.calls.when("implement#12");
    await c.supervisor.abort(ISSUE.number);
    await world.calls.when("move#12:Blocked");
    await world.calls.when("sleep");
    expect(world.calls.count("pickUp#13")).toBe(0);

    // When: 次の確認
    world.wake();

    // Then: 次の Ready の Issue（#13）を始める。中断した #12 には手を付けない
    await world.calls.when("pickUp#13");
    await world.calls.when("test#13");
    expect(world.board.columnOf(NEXT.number)).toBe("Testing");
    expect(world.board.columnOf(ISSUE.number)).toBe("Blocked");
    expect(world.calls.count("implement#12")).toBe(1);
    expect(world.calls.count("pickUp#12")).toBe(0);
  });

  it(
    "AC4: 人が中断した Issue を Ready に戻すと、ブランチに残した変更から続ける",
    { timeout: 30_000 },
    async () => {
      // Given: 実装役の途中で中断して Blocked に移した
      const world = await seedWorld({ implement: "real" });
      const git = world.git!;
      const c = await seedConductor(world);
      await world.calls.when("role#1");
      await c.supervisor.abort(ISSUE.number);
      await world.calls.when("move#12:Blocked");
      await world.calls.when("sleep");
      // 手元の作業コピーには残っていない（origin のブランチにだけある）
      git.sh("switch", "-q", "-f", "main");
      git.sh("branch", "-q", "-D", BRANCH);

      // Given: 人が Ready に戻した
      world.board.humanMove(ISSUE.number, "Ready");

      // When: その Issue を始める（次の確認）
      world.wake();
      await world.calls.when("pickUp#12");
      await world.calls.when("role#2");
      await world.calls.when("implemented#12", 2);

      // Then: ブランチに残した変更から続ける（テストからやり直さず、実装役が前の変更を見て書き足す）
      expect(world.calls.count("test#12")).toBe(0);
      expect(world.roleRuns[1]?.saw).toBe(FIRST);
      expect(git.onOrigin("src/sort.ts")).toBe(`${FIRST}${SECOND}`);
      expect(world.board.pulls).toEqual([
        { issue: ISSUE.number, head: BRANCH },
      ]);
      expect(
        (await world.store.get(key(ISSUE.number)))?.checkpoint?.stage,
      ).toBe("ci");
    },
  );

  it("AC5: 処理中の Issue がないとき、ダッシュボードに「この作業を中断」を出さない", async () => {
    // Given: 処理中の Issue がない（Ready は空、Blocked と Done だけ）
    const config = parseConfig(configYaml());
    const store = new MemoryStore();
    const calls = new Calls();
    const board = new FakeBoard(calls, {
      Ready: [],
      Done: [{ number: 3, title: "終わった Issue", body: "" }],
      Blocked: [{ number: 48, title: "止まった Issue", body: "" }],
    });
    await store.update(key(48), {
      checkpoint: { stage: "testing" },
      blockedReason: "受け入れ条件が曖昧です",
    });

    // When: ダッシュボードを見る
    const data = await loadDashboard({
      config,
      store,
      board,
      status: "idle",
      activity: {},
    });
    expect(data.active).toBeUndefined();
    const ja = await renderDashboard(data);
    const en = await renderDashboard(data, "en");

    // Then: 「この作業を中断」は出さない
    expect(textOf(ja)).toContain("Ready の Issue を待っています");
    expect(buttonsOf(ja)).not.toContain("この作業を中断");
    expect(textOf(ja)).not.toContain("この作業を中断");
    expect(textOf(en)).not.toContain("Abort this run");

    // 処理中の Issue があれば出す（くらべるため）
    board.humanMove(ISSUE.number, "Implementing");
    await store.update(key(ISSUE.number), {
      branch: BRANCH,
      checkpoint: { stage: "implementing" },
    });
    const withActive = await loadDashboard({
      config,
      store,
      board,
      status: "running",
      activity: { running: { issue: ISSUE.number, role: "implementer" } },
    });
    expect(buttonsOf(await renderDashboard(withActive))).toContain(
      "この作業を中断",
    );
    expect(buttonsOf(await renderDashboard(withActive, "en"))).toContain(
      "Abort this run",
    );
  });
});

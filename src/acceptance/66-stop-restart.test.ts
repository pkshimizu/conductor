/**
 * Issue #66: 管理画面：conductor の停止と再起動 の受け入れテスト
 *
 * 決めたこと（実装役はこれに合わせて作る）:
 * - 稼働状態に「停止しています」を足す。`src/admin-server.ts` の AdminStatus と `web/src/i18n.ts` の Status は
 *   `"running" | "idle" | "stopping" | "stopped"`（動作中・待機中・停止しています・停止中）。
 *   辞書に stStopping（ja「停止しています」、en「Stopping」）を足す。`web/src/events.ts` の parseEvent も "stopping" を読む
 * - 常駐ループの停止・再起動を受け持つのは新しいモジュール `src/supervisor.ts`
 *   ```ts
 *   export interface SupervisorOptions {
 *     repoDir: string;                                // 対象リポジトリ（再起動のたびに .conductor/config.yaml を読み直す）
 *     config: Config;                                 // 起動したときの設定（main が読んだもの）
 *     buildDeps(config: Config): Promise<LoopDeps>;   // 設定から常駐ループの部品を作る（再起動のたびに、読み直した設定で呼ぶ）
 *     onStatus(status: AdminStatus): void;            // 稼働状態が変わるたびに呼ぶ
 *     log(text: string): void;
 *   }
 *   export interface Supervisor {
 *     status(): AdminStatus;
 *     /** 今の段階を終えてから止める（Ctrl+C と同じ。runLoop の signal で止める）。止まったら resolve *\/
 *     stop(): Promise<void>;
 *     /** 動作中なら今の段階を終えてから止め、config.yaml を読み直して常駐ループを動かし直す。動かし直したら resolve *\/
 *     restart(): Promise<void>;
 *     /** すべて終える（Ctrl+C のとき start.ts が呼ぶ）。今の段階を終えてから止まったら resolve *\/
 *     shutdown(): Promise<void>;
 *   }
 *   export function startSupervisor(options: SupervisorOptions): Supervisor; // すぐに常駐ループを動かし始める
 *   ```
 *   - 常駐ループは runLoop（src/loop.ts）で動かし、間隔は config.poll_interval 秒。buildDeps が返した sleep はそのまま使う
 *   - runLoop の onStatus（running・idle）は options.onStatus に渡す。stop を頼んでから止まるまでは "stopping"、
 *     止まったら "stopped"
 *   - start.ts の start() はこれを使い、onStatus を管理画面（setStatus）とダッシュボードにつなぎ、Ctrl+C で shutdown を呼ぶ
 *     （このテストでは start() 自体は動かさない。GitHub・claude に触るため）
 * - `src/admin-server.ts` の AdminServerOptions に足す
 *   ```ts
 *   /** 停止と再起動（start.ts が Supervisor をつなぐ） *\/
 *   control?: { stop(): Promise<void>; restart(): Promise<void> };
 *   ```
 *   - `POST /api/stop` は control.stop()、`POST /api/restart` は control.restart() を呼び、それが終わってから 2xx を返す
 *   - POST は Origin が管理画面そのもの（http://127.0.0.1:<ポート> か http://localhost:<ポート>）のときだけ受け付ける。
 *     ほかの Origin（別のサイトからの送信）や Origin の無い POST は 403 にして何もしない
 *   - 再起動しても管理画面は閉じない（同じ URL のまま、開いている SSE もつないだまま）
 * - 画面の停止・再起動の流れは新しいモジュール `web/src/control.ts`（ブラウザの globals に触らない）
 *   ```ts
 *   export type ControlKind = "restart" | "stop";
 *   export interface ControlState {
 *     dialog?: ControlKind;  // 出している確認のダイアログ
 *     toast?: ControlKind;   // 出している知らせ（再起動しました・停止しました）
 *   }
 *   export const CONTROL_PATHS: Readonly<Record<ControlKind, string>>; // { restart: "/api/restart", stop: "/api/stop" }
 *   /** ヘッダーの「再起動」「停止」を押した。そのダイアログを出す *\/
 *   export function askControl(state: ControlState, kind: ControlKind): ControlState;
 *   /** ダイアログの「キャンセル」。ダイアログを閉じるだけ *\/
 *   export function cancelControl(state: ControlState): ControlState;
 *   /**
 *    * ダイアログの確認のボタン（再起動する・停止する）。ダイアログを閉じて update を呼び、
 *    * post(CONTROL_PATHS[kind]) で頼み、ok なら toast: kind にして update を呼ぶ。最後の状態を返す。
 *    * 画面は post に (path) => fetch(path, { method: "POST" }) を渡す
 *    *\/
 *   export function confirmControl(
 *     state: ControlState,
 *     post: (path: string) => Promise<{ ok: boolean }>,
 *     update: (state: ControlState) => void,
 *   ): Promise<ControlState>;
 *   ```
 * - `web/src/Layout.tsx` の LayoutProps に足す
 *   ```ts
 *   control?: ControlState;                 // 出しているダイアログと知らせ
 *   onAsk?: (kind: ControlKind) => void;    // ヘッダーの「再起動」「停止」
 *   onCancel?: () => void;                  // ダイアログの「キャンセル」
 *   onConfirm?: () => void;                 // ダイアログの「再起動する」「停止する」
 *   ```
 *   - `<header>` に `<button>再起動</button>` と `<button>停止</button>`（デザインどおり）。停止中は「停止」に disabled を付ける
 *     （「再起動」は押せる）
 *   - control.dialog があれば role="dialog" の要素に、見出し（restartTitle・stopTitle）、本文（restartBody・stopBody）、
 *     `<button>キャンセル</button>` と確認のボタン（restartOk・stopOk）を出す。無ければ role="dialog" を出さない
 *   - control.toast があれば role="status" の要素に知らせ（toastRestart・toastStop）を出す
 *
 * seed: 対象リポジトリは一時フォルダ（.conductor/config.yaml を書く）、記録は MemoryStore、
 * GitHub と各役は呼ばれたことを覚えるだけの偽物（実装役は止めておける）。待ち（sleep）は止められるまで戻らない偽物で、
 * 時刻に頼らない。ネットワークには出ない（管理画面の HTTP と SSE だけ 127.0.0.1 につなぐ）。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { type ComponentType, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import {
  type AdminServer,
  type AdminStatus,
  startAdminServer,
} from "../admin-server.js";
import {
  CONDUCTOR_DIR,
  CONFIG_FILE,
  type Config,
  parseConfig,
} from "../config.js";
import type { LoopDeps, LoopIssue } from "../loop.js";
import { type IssueKey, MemoryStore, type Stage } from "../store.js";
import { type Supervisor, startSupervisor } from "../supervisor.js";

// ---- seed ----

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REPO = "pkshimizu/wordcards";
const PROJECT = 3;
const INDEX_HTML = "<!doctype html><title>conductor</title>";
const ISSUE: LoopIssue = {
  number: 12,
  title: "単語の一覧に並べ替えをつける",
  body: "本文",
};
const key = (issue: number): IssueKey => ({ repo: REPO, issue });

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function configYaml(poll: number): string {
  return [
    `github: { repo: ${REPO}, project: ${PROJECT}, notify: someone }`,
    "protected: [src/acceptance/**]",
    "commands: { setup: s, test: t, acceptance: a, typecheck: c, build: b }",
    "merge: { approval: human }",
    `poll_interval: ${poll}`,
    "limits: { rejections: 3, objections: 2 }",
  ].join("\n");
}

/** 対象リポジトリ（.conductor/config.yaml だけ）。writeConfig で書き換えられる */
async function seedRepo(poll: number) {
  const dir = await mkdtemp(join(tmpdir(), "conductor-66-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, CONDUCTOR_DIR));
  const writeConfig = (p: number) =>
    writeFile(join(dir, CONDUCTOR_DIR, CONFIG_FILE), configYaml(p));
  await writeConfig(poll);
  return { dir, writeConfig };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
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

/** 列ごとの Issue を覚え、読まれたら "github" と記録する GitHub */
class FakeBoard {
  readonly columns = new Map<string, LoopIssue[]>();

  constructor(
    private readonly calls: Calls,
    columns: Record<string, LoopIssue[]>,
  ) {
    for (const [c, list] of Object.entries(columns)) {
      this.columns.set(c, [...list]);
    }
  }

  issuesByColumn(): Promise<Map<string, LoopIssue[]>> {
    this.calls.push("github");
    return Promise.resolve(
      new Map([...this.columns].map(([c, list]) => [c, [...list]])),
    );
  }

  moveIssue(): Promise<void> {
    return Promise.resolve();
  }

  comment(): Promise<void> {
    return Promise.resolve();
  }

  hasConflict(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

/**
 * conductor の外側（GitHub・各役・待ち）の偽物。
 * 実装役は gate を開けるまで終わらず、終わったら Issue を CI の段階に進める
 */
async function seedWorld(
  seed: { column: string; stage: Stage; holdImplement?: boolean } | undefined,
) {
  const calls = new Calls();
  const store = new MemoryStore();
  const board = new FakeBoard(
    calls,
    seed === undefined
      ? { Ready: [], Done: [{ number: 3, title: "済み", body: "" }] }
      : { Ready: [], [seed.column]: [ISSUE] },
  );
  if (seed !== undefined) {
    await store.update(key(ISSUE.number), {
      branch: `conductor/issue-${ISSUE.number}`,
      checkpoint: { stage: seed.stage },
    });
  }
  const gate = seed?.holdImplement === true ? deferred() : undefined;
  cleanups.push(() => gate?.resolve());
  const configs: Config[] = [];
  const sleeps: number[] = [];
  const logs: string[] = [];
  const step =
    (name: string, status: string) =>
    (issue: LoopIssue): Promise<{ status: string }> => {
      calls.push(`${name}#${issue.number}`);
      return Promise.resolve({ status });
    };

  const buildDeps = (config: Config): Promise<LoopDeps> => {
    configs.push(config);
    calls.push("build");
    return Promise.resolve({
      config,
      store,
      board,
      pickUp: (issue) => {
        calls.push(`pickUp#${issue.number}`);
        return Promise.resolve({ accepted: false });
      },
      test: step("test", "tested"),
      implement: async (issue) => {
        calls.push(`implement#${issue.number}`);
        await gate?.promise;
        await store.update(key(issue.number), { checkpoint: { stage: "ci" } });
        calls.push(`implemented#${issue.number}`);
        return { status: "implemented" };
      },
      checkCi: step("checkCi", "pending"),
      review: step("review", "reviewed"),
      merge: step("merge", "merged"),
      syncMain: step("syncMain", "synced"),
      log: (text) => logs.push(text),
      // 止められるまで戻らない（時刻に頼らない）
      sleep: (ms, signal) => {
        sleeps.push(ms);
        calls.push("sleep");
        return new Promise<void>((done) => {
          if (signal.aborted) done();
          else signal.addEventListener("abort", () => done(), { once: true });
        });
      },
    });
  };
  return { calls, store, board, gate, configs, sleeps, logs, buildDeps };
}

type World = Awaited<ReturnType<typeof seedWorld>>;

/** 管理画面と、停止・再起動を受け持つ部品をつないで起動する */
async function seedConductor(world: World, repoDir: string, poll: number) {
  const assets = await mkdtemp(join(tmpdir(), "conductor-admin-66-"));
  cleanups.push(() => rm(assets, { recursive: true, force: true }));
  await writeFile(join(assets, "index.html"), INDEX_HTML);
  const statuses: AdminStatus[] = [];
  // control の stop・restart は supervisor を作ったあと（POST が届いたとき）に呼ばれる
  const server = await startAdminServer({
    repo: REPO,
    project: PROJECT,
    status: "running",
    log: () => {},
    assetsDir: assets,
    control: {
      stop: () => supervisor.stop(),
      restart: () => supervisor.restart(),
    },
  });
  cleanups.push(() => server.close());
  const supervisor: Supervisor = startSupervisor({
    repoDir,
    config: parseConfig(configYaml(poll)),
    buildDeps: world.buildDeps,
    onStatus: (s) => {
      statuses.push(s);
      server.setStatus(s);
    },
    log: (text) => world.logs.push(text),
  });
  cleanups.push(() => supervisor.shutdown());
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
  return { server, supervisor, statuses, post, posts };
}

/** すでに届いている処理を流す（時刻には頼らない） */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((done) => setImmediate(done));
  }
}

function track(p: Promise<unknown>): { settled: boolean } {
  const s = { settled: false };
  p.then(
    () => (s.settled = true),
    () => (s.settled = true),
  );
  return s;
}

// ---- 画面のソース（src の外にあるので、実行時に import する） ----

type Lang = "ja" | "en";
type ControlKind = "restart" | "stop";
interface ControlState {
  dialog?: ControlKind;
  toast?: ControlKind;
}

interface ControlModule {
  CONTROL_PATHS: Readonly<Record<ControlKind, string>>;
  askControl(state: ControlState, kind: ControlKind): ControlState;
  cancelControl(state: ControlState): ControlState;
  confirmControl(
    state: ControlState,
    post: (path: string) => Promise<{ ok: boolean }>,
    update: (state: ControlState) => void,
  ): Promise<ControlState>;
}

interface LayoutProps {
  path: string;
  lang: Lang;
  scheme: "light" | "dark";
  repo: string;
  project: number;
  status: AdminStatus;
  control?: ControlState;
  onAsk?: (kind: ControlKind) => void;
  onCancel?: () => void;
  onConfirm?: () => void;
}

interface LayoutModule {
  Layout: ComponentType<LayoutProps>;
}

interface EventsModule {
  parseEvent(data: string): { status: string } | undefined;
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

function buttonsOf(html: string): { text: string; disabled: boolean }[] {
  return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(
    (m) => ({ text: textOf(m[2]!), disabled: /\bdisabled\b/.test(m[1]!) }),
  );
}

/** 共通の枠を描いて、ヘッダー・ダイアログ・知らせを返す */
async function renderLayout(props: Partial<LayoutProps>) {
  const { Layout } = await importWeb<LayoutModule>("Layout.tsx");
  const html = renderToStaticMarkup(
    createElement(Layout, {
      path: "/",
      lang: "ja",
      scheme: "light",
      repo: REPO,
      project: PROJECT,
      status: "running",
      ...props,
    }),
  );
  const header = /<header\b[\s\S]*?<\/header>/.exec(html);
  expect(header, "<header> がある").not.toBeNull();
  const at = (pattern: RegExp) => {
    const i = html.search(pattern);
    return i < 0 ? undefined : html.slice(html.lastIndexOf("<", i));
  };
  return {
    html,
    header: { html: header![0], text: textOf(header![0]) },
    dialog: at(/role="dialog"/),
    toast: at(/role="status"/),
  };
}

/** ヘッダーにある、その文言のボタン（1つだけある） */
function headerButton(
  page: Awaited<ReturnType<typeof renderLayout>>,
  label: string,
) {
  const found = buttonsOf(page.header.html).filter((b) => b.text === label);
  expect(found, `ヘッダーの「${label}」`).toHaveLength(1);
  return found[0]!;
}

function expectDialog(
  page: Awaited<ReturnType<typeof renderLayout>>,
  want: { title: string; body: string; cancel: string; ok: string },
) {
  expect(page.dialog, "確認のダイアログ").toBeDefined();
  const text = textOf(page.dialog!);
  expect(text).toContain(want.title);
  expect(text).toContain(want.body);
  const labels = buttonsOf(page.dialog!).map((b) => b.text);
  expect(labels).toContain(want.cancel);
  expect(labels).toContain(want.ok);
}

const STOP_DIALOG = {
  title: "conductor を停止しますか？",
  body: "GitHub の確認とエージェントの実行を止めます。再開するには「再起動」を押してください。",
  cancel: "キャンセル",
  ok: "停止する",
};
const RESTART_DIALOG = {
  title: "conductor を再起動しますか？",
  body: "動作中のエージェントはいったん止まります。設定の変更は再起動のあとに反映されます。",
  cancel: "キャンセル",
  ok: "再起動する",
};

// ---- SSE ----

async function openEvents(server: AdminServer) {
  const controller = new AbortController();
  cleanups.push(() => controller.abort());
  const res = await fetch(new URL("api/events", server.url), {
    headers: { accept: "text/event-stream" },
    signal: controller.signal,
  });
  expect(res.status).toBe(200);
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  const next = async (): Promise<{ raw: string; status: unknown }> => {
    for (;;) {
      buffer = buffer.replace(/\r\n/g, "\n");
      const end = buffer.indexOf("\n\n");
      if (end >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const raw = block
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("\n");
        if (raw === "") continue;
        return {
          raw,
          status: (JSON.parse(raw) as { status?: unknown }).status,
        };
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("SSE が閉じた");
      buffer += value;
    }
  };
  /** その稼働状態の知らせが届くまで読む */
  const waitFor = async (want: AdminStatus) => {
    for (;;) {
      const event = await next();
      if (event.status === want) return event;
    }
  };
  return { next, waitFor };
}

describe("Issue #66: 管理画面：conductor の停止と再起動", () => {
  it("AC1: 「停止」→「停止する」で、今の段階が終わってから GitHub の確認と役の実行を止め、止まるまでは「停止しています」、止まったら「停止中」と「停止しました」を出す", async () => {
    // Given: conductor が動作中（#12 の実装役が動いている）
    const repo = await seedRepo(30);
    const world = await seedWorld({
      column: "Implementing",
      stage: "implementing",
      holdImplement: true,
    });
    const c = await seedConductor(world, repo.dir, 30);
    await world.calls.when("implement#12");
    const events = await openEvents(c.server);
    await events.waitFor("running");

    // 別のサイトからの POST は受け付けない（何もしない）
    const foreign = await fetch(new URL("/api/stop", c.server.url), {
      method: "POST",
      headers: { origin: "http://evil.example" },
    });
    expect(foreign.status).toBe(403);
    await flush();
    expect(c.supervisor.status()).toBe("running");

    // When: ヘッダーの「停止」を押す
    const ctl = await control();
    const running = await renderLayout({ status: "running" });
    expect(headerButton(running, "停止").disabled).toBe(false);
    const asked = ctl.askControl({}, "stop");
    expect(asked.dialog).toBe("stop");
    expectDialog(await renderLayout({ control: asked }), STOP_DIALOG);

    // When: 確認で「停止する」を押す
    const updates: ControlState[] = [];
    const confirming = ctl.confirmControl(asked, c.post, (s) =>
      updates.push(s),
    );
    const confirmed = track(confirming);

    // Then: ダイアログを閉じ、/api/stop に頼む
    await events.waitFor("stopping");
    expect(updates[0]?.dialog).toBeUndefined();
    expect(updates[0]?.toast).toBeUndefined();
    expect(c.posts).toEqual([ctl.CONTROL_PATHS.stop]);

    // Then: 今の段階（実装役）が終わるまでは止めず、状態を「停止しています」と出す
    await flush();
    expect(confirmed.settled).toBe(false);
    expect(world.calls.count("implemented#12")).toBe(0);
    expect(c.supervisor.status()).toBe("stopping");
    const stoppingEvent = await importWeb<EventsModule>("events.ts");
    const parsed = stoppingEvent.parseEvent(
      JSON.stringify({ status: "stopping", repo: REPO, project: PROJECT }),
    );
    expect(parsed?.status).toBe("stopping");
    const stopping = await renderLayout({ status: "stopping" });
    expect(stopping.header.text).toContain("停止しています");
    expect(stopping.header.text).not.toContain("動作中");
    expect(stopping.header.text).not.toContain("停止中");
    expect(stopping.toast).toBeUndefined();
    const stoppingEn = await renderLayout({ status: "stopping", lang: "en" });
    expect(stoppingEn.header.text).toContain("Stopping");

    // When: 実装役が終わる
    world.gate!.resolve();

    // Then: 段階を最後まで終えてから止まり、「停止中」にして「停止しました」と知らせる
    await events.waitFor("stopped");
    const final = await confirming;
    expect(world.calls.count("implemented#12")).toBe(1);
    expect((await world.store.get(key(12)))?.checkpoint?.stage).toBe("ci");
    expect(c.supervisor.status()).toBe("stopped");
    expect(c.statuses.indexOf("stopping")).toBeGreaterThanOrEqual(0);
    expect(c.statuses.at(-1)).toBe("stopped");
    expect(final).toEqual({ toast: "stop" });
    expect(updates.at(-1)).toEqual({ toast: "stop" });
    const stopped = await renderLayout({ status: "stopped", control: final });
    expect(stopped.header.text).toContain("停止中");
    expect(stopped.header.text).not.toContain("停止しています");
    expect(stopped.dialog).toBeUndefined();
    expect(stopped.toast, "知らせ").toBeDefined();
    expect(textOf(stopped.toast!)).toContain("停止しました");

    // Then: 止まったあとは、GitHub の確認も役の実行もしない
    const seen = world.calls.list.length;
    await flush();
    expect(world.calls.list.slice(seen)).toEqual([]);
    expect(world.calls.count("checkCi#12")).toBe(0);
    expect(world.logs).toContain("止まりました");
  });

  it("AC2: 停止したあとも画面はそのまま使え、「停止」は押せない", async () => {
    // Given: conductor を停止した
    const repo = await seedRepo(30);
    const world = await seedWorld({ column: "Reviewing", stage: "ci" });
    const c = await seedConductor(world, repo.dir, 30);
    await world.calls.when("sleep");
    const ctl = await control();
    const done = await ctl.confirmControl(
      ctl.askControl({}, "stop"),
      c.post,
      () => {},
    );
    expect(done.toast).toBe("stop");
    expect(c.supervisor.status()).toBe("stopped");

    // When: 画面を見る（開き直す・ほかの画面に移る）
    // Then: 画面はそのまま配信していて使える
    for (const path of ["/", "/tasks", "/tasks/12", "/settings"]) {
      const res = await fetch(new URL(path, c.server.url));
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).toBe(INDEX_HTML);
    }
    const events = await openEvents(c.server);
    expect((await events.next()).status).toBe("stopped");

    // Then: 「停止」は押せない（「再起動」は押せる）
    const page = await renderLayout({ status: "stopped" });
    expect(page.header.text).toContain("停止中");
    expect(headerButton(page, "停止").disabled).toBe(true);
    expect(headerButton(page, "再起動").disabled).toBe(false);
    const en = await renderLayout({ status: "stopped", lang: "en" });
    expect(headerButton(en, "Stop").disabled).toBe(true);
    expect(headerButton(en, "Restart").disabled).toBe(false);
  });

  it("AC3: 「再起動」→「再起動する」で、（動作中なら今の段階を終えてから）config.yaml を読み直して再開し、「再起動しました」と知らせる。止めていた Issue は続きから動く", async () => {
    const ctl = await control();

    // ---- Given: 停止中（#12 は CI の段階で止めている） ----
    {
      const repo = await seedRepo(30);
      const world = await seedWorld({ column: "Reviewing", stage: "ci" });
      const c = await seedConductor(world, repo.dir, 30);
      await world.calls.when("sleep");
      expect(world.sleeps).toEqual([30_000]);
      await ctl.confirmControl(ctl.askControl({}, "stop"), c.post, () => {});
      expect(c.supervisor.status()).toBe("stopped");
      await repo.writeConfig(45);

      // When: 「再起動」を押し、確認で「再起動する」を押す
      const asked = ctl.askControl({ toast: "stop" }, "restart");
      expect(asked.dialog).toBe("restart");
      expectDialog(await renderLayout({ control: asked }), RESTART_DIALOG);
      const final = await ctl.confirmControl(asked, c.post, () => {});

      // Then: config.yaml を読み直して処理を再開し、「再起動しました」と知らせる
      expect(c.posts.at(-1)).toBe(ctl.CONTROL_PATHS.restart);
      expect(final.dialog).toBeUndefined();
      expect(final.toast).toBe("restart");
      const page = await renderLayout({ control: final });
      expect(textOf(page.toast ?? "")).toContain("再起動しました");
      expect(world.configs).toHaveLength(2);
      expect(world.configs[1]!.poll_interval).toBe(45);
      expect(c.supervisor.status()).not.toBe("stopped");

      // Then: 止めていた Issue は続きから（CI の段階から）動く
      await world.calls.when("checkCi#12", 2);
      await world.calls.when("sleep", 2);
      expect(world.sleeps).toEqual([30_000, 45_000]);
      expect(world.calls.count("pickUp#12")).toBe(0);
      expect(world.calls.count("test#12")).toBe(0);
      expect(world.calls.count("implement#12")).toBe(0);
    }

    // ---- Given: 動作中（#12 の実装役が動いている） ----
    {
      const repo = await seedRepo(30);
      const world = await seedWorld({
        column: "Implementing",
        stage: "implementing",
        holdImplement: true,
      });
      const c = await seedConductor(world, repo.dir, 30);
      await world.calls.when("implement#12");
      await repo.writeConfig(60);

      // When: 「再起動」を押し、確認で「再起動する」を押す
      const confirming = ctl.confirmControl(
        ctl.askControl({}, "restart"),
        c.post,
        () => {},
      );
      const confirmed = track(confirming);

      // Then: 今の段階が終わるまでは待つ（設定もまだ読み直さない）
      await flush();
      expect(confirmed.settled).toBe(false);
      expect(world.configs).toHaveLength(1);
      expect(world.calls.count("implemented#12")).toBe(0);

      // When: 実装役が終わる
      world.gate!.resolve();

      // Then: config.yaml を読み直して再開し、「再起動しました」と知らせる
      const final = await confirming;
      expect(final.toast).toBe("restart");
      expect(world.configs).toHaveLength(2);
      expect(world.configs[1]!.poll_interval).toBe(60);

      // Then: Issue は続きから動く（実装をやり直さず、CI に進む）
      await world.calls.when("checkCi#12");
      await world.calls.when("sleep");
      expect(world.sleeps).toEqual([60_000]);
      expect(world.calls.count("implement#12")).toBe(1);
      expect(world.calls.count("pickUp#12")).toBe(0);
    }
  });

  it("AC4: 再起動しても画面の URL は変わらず、そのまま使える", async () => {
    // Given: 画面を開いている（待機中）
    const repo = await seedRepo(30);
    const world = await seedWorld(undefined);
    const c = await seedConductor(world, repo.dir, 30);
    await world.calls.when("sleep");
    const url = c.server.url;
    const port = c.server.port;
    const events = await openEvents(c.server);
    expect((await events.next()).status).toBe("idle");

    // When: 再起動した
    const ctl = await control();
    const final = await ctl.confirmControl(
      ctl.askControl({}, "restart"),
      c.post,
      () => {},
    );
    expect(final.toast).toBe("restart");
    expect(world.configs).toHaveLength(2);

    // Then: 画面の URL は変わらない
    expect(c.server.url).toBe(url);
    expect(c.server.port).toBe(port);

    // Then: 開いていた画面はつながったまま、再起動のあとの稼働状態が届く
    await events.waitFor("running");
    await world.calls.when("sleep", 2);
    await events.waitFor("idle");

    // Then: 同じ URL で、そのまま画面を開ける
    for (const path of ["/", "/tasks/12"]) {
      const res = await fetch(new URL(path, url));
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).toBe(INDEX_HTML);
    }
  });

  it("AC5: 確認のダイアログで「キャンセル」を押すと、何もしない", async () => {
    // Given: conductor が動作中（待機中）
    const repo = await seedRepo(30);
    const world = await seedWorld(undefined);
    const c = await seedConductor(world, repo.dir, 30);
    await world.calls.when("sleep");
    const ctl = await control();
    const before = c.supervisor.status();

    for (const [kind, dialog] of [
      ["stop", STOP_DIALOG],
      ["restart", RESTART_DIALOG],
    ] as const) {
      // Given: 確認のダイアログ
      const asked = ctl.askControl({}, kind);
      expectDialog(await renderLayout({ control: asked }), dialog);

      // When: 「キャンセル」を押す
      const cancelled = ctl.cancelControl(asked);

      // Then: ダイアログを閉じるだけで、知らせも出さない
      expect(cancelled.dialog, kind).toBeUndefined();
      expect(cancelled.toast, kind).toBeUndefined();
      const page = await renderLayout({ control: cancelled });
      expect(page.dialog, kind).toBeUndefined();
      expect(page.toast, kind).toBeUndefined();
    }

    // Then: 停止も再起動もしない（サーバーに頼まない）
    await flush();
    expect(c.posts).toEqual([]);
    expect(c.supervisor.status()).toBe(before);
    expect(c.statuses).not.toContain("stopping");
    expect(c.statuses).not.toContain("stopped");
    expect(world.configs).toHaveLength(1);
  });
});

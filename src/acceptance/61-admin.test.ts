/**
 * Issue #61: 管理画面の土台の受け入れテスト
 *
 * 決めたこと（実装役はこれに合わせて作る）:
 * - 配信は新しいモジュール `src/admin-server.ts`（Node 標準の http）
 *   ```ts
 *   export type AdminStatus = "running" | "idle" | "stopped"; // 動作中・待機中・停止中
 *
 *   export interface AdminServerOptions {
 *     repo: string;          // config.github.repo
 *     project: number;       // config.github.project
 *     status: AdminStatus;   // 起動したときの稼働状態
 *     log(text: string): void;
 *     assetsDir?: string;    // 画面のビルド結果のフォルダ。省略したら同梱のもの（dist/admin）
 *   }
 *
 *   export interface AdminServer {
 *     url: string;           // "http://127.0.0.1:<ポート>/"
 *     port: number;
 *     setStatus(status: AdminStatus): void; // 変わったら開いている画面に SSE で push する
 *     close(): Promise<void>;
 *   }
 *
 *   export function startAdminServer(options: AdminServerOptions): Promise<AdminServer>;
 *   ```
 *   - 127.0.0.1 だけで、空いているポート（listen(0)）で待ち受け、
 *     「管理画面: http://127.0.0.1:<ポート>/」を log に1回書く
 *   - `GET /api/events` は SSE（content-type: text/event-stream）。稼働状態が変わるたびに
 *     `data: {"status":"idle"}` のように、status を含む JSON を1件送る（ほかの項目があってもよい）
 *   - 画面の URL（/、/tasks、/tasks/<番号>、/settings）は、どれも assetsDir の index.html を
 *     content-type: text/html で返す。assetsDir の中のファイル（/assets/... など）はそのまま返す
 *   - `src/start.ts` の start() は、常駐ループの前にこれを起動する（このテストでは start() 自体は動かさない。
 *     GitHub・claude に触るため）
 * - 画面のソースは `web/`（src の外。Vite の root）に置き、`npm run build` で `dist/admin/` にビルドする
 *   - `web/src/Layout.tsx`：全画面に共通する枠
 *     ```ts
 *     export interface LayoutProps {
 *       path: string;                      // "/"・"/tasks"・"/tasks/12"・"/settings"
 *       lang: "ja" | "en";
 *       scheme: "light" | "dark";
 *       repo: string;
 *       project: number;
 *       status: AdminStatus;
 *       onLanguage?: (lang: "ja" | "en") => void;
 *       onNavigate?: (path: string) => void;
 *     }
 *     export function Layout(props: LayoutProps): ReactElement;
 *     ```
 *     ブラウザの globals（window など）に触らずに react-dom/server で描けること。
 *     デザインどおり、左に `<nav aria-label="メニュー">`（ダッシュボード・タスク一覧・設定）、上に `<header>`
 *     （リポジトリ名・Project 番号・稼働状態・言語の切り替え（aria-label="言語" と 日本語／English のボタン））を出す。
 *     `<nav>` は `<header>` より前に書く。いまの画面のメニュー（a か button）には aria-current="page" を付ける
 *     （/tasks/<番号> はタスク一覧）。
 *     配色はデザインと同じく、外側の要素の inline style に CSS 変数（--bg など。値はデザインの色）と
 *     color-scheme で入れる
 *   - `web/src/language.ts`：言語を覚える
 *     ```ts
 *     export function loadLanguage(storage: Pick<Storage, "getItem">): "ja" | "en"; // 無ければ "ja"
 *     export function saveLanguage(storage: Pick<Storage, "setItem">, lang: "ja" | "en"): void;
 *     ```
 *     画面は localStorage を渡し、切り替えたら saveLanguage、開いたら loadLanguage を使う
 *   - `web/src/theme.ts`：PC の配色に従う
 *     ```ts
 *     export function watchColorScheme(
 *       matchMedia: (query: string) => MediaQueryListLike, // 画面は window.matchMedia を渡す
 *       onChange: (scheme: "light" | "dark") => void,
 *     ): { scheme: "light" | "dark"; stop(): void };
 *     ```
 *     "(prefers-color-scheme: dark)" を見て、今の配色を返し、change で onChange を呼ぶ
 *   - Vitest から `web/src/*.tsx` を import できるようにする（JSX の変換の設定など）
 * - React・React DOM・Vite は devDependencies に入れ、dependencies は増やさない
 *   （このテストは react と react-dom/server を import するので、型の検査には @types/react・@types/react-dom も要る）
 *
 * seed: 画面のビルド結果の代わりに、一時フォルダに index.html と script を置いて assetsDir に渡す。
 * DB は使わない。ネットワークには出ない（127.0.0.1 と、この PC 自身のアドレスにだけつなぐ）。
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { type ComponentType, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import {
  type AdminServer,
  type AdminServerOptions,
  type AdminStatus,
  startAdminServer,
} from "../admin-server.js";

// ---- seed ----

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REPO = "pkshimizu/wordcards";
const PROJECT = 3;
const INDEX_HTML =
  '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>conductor</title></head><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

/** 画面のビルド結果の代わり（index.html と script を1つ置く） */
async function seedAssets(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "conductor-admin-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "index.html"), INDEX_HTML);
  await mkdir(join(dir, "assets"));
  await writeFile(join(dir, "assets", "app.js"), "console.log(1);\n");
  return dir;
}

/** 管理画面を起動する。テストの終わりに閉じる */
async function seedServer(
  options: Partial<AdminServerOptions> = {},
): Promise<{ server: AdminServer; logs: string[] }> {
  const logs: string[] = [];
  const server = await startAdminServer({
    repo: REPO,
    project: PROJECT,
    status: "running",
    log: (text) => logs.push(text),
    assetsDir: await seedAssets(),
    ...options,
  });
  cleanups.push(() => server.close());
  return { server, logs };
}

// ---- 画面のソース（src の外にあるので、型の検査に入れないよう実行時に import する） ----

type Lang = "ja" | "en";
type Scheme = "light" | "dark";

interface LayoutProps {
  path: string;
  lang: Lang;
  scheme: Scheme;
  repo: string;
  project: number;
  status: AdminStatus;
  onLanguage?: (lang: Lang) => void;
  onNavigate?: (path: string) => void;
}

interface LayoutModule {
  Layout: ComponentType<LayoutProps>;
}

interface LanguageModule {
  loadLanguage(storage: Pick<Storage, "getItem">): Lang;
  saveLanguage(storage: Pick<Storage, "setItem">, lang: Lang): void;
}

type Listener = (e: { matches: boolean }) => void;

interface MediaQueryListLike {
  readonly matches: boolean;
  addEventListener(type: "change", listener: Listener): void;
  removeEventListener(type: "change", listener: Listener): void;
}

interface ThemeModule {
  watchColorScheme(
    matchMedia: (query: string) => MediaQueryListLike,
    onChange: (scheme: Scheme) => void,
  ): { scheme: Scheme; stop(): void };
}

async function importWeb<T>(file: string): Promise<T> {
  const url = pathToFileURL(join(ROOT, "web", "src", file)).href;
  return (await import(/* @vite-ignore */ url)) as T;
}

const DEFAULT_PROPS: LayoutProps = {
  path: "/",
  lang: "ja",
  scheme: "light",
  repo: REPO,
  project: PROJECT,
  status: "running",
};

/** 共通の枠を描いて、全体・メニュー・ヘッダーの文と、今の画面のメニューを返す */
async function renderLayout(props: Partial<LayoutProps> = {}) {
  const { Layout } = await importWeb<LayoutModule>("Layout.tsx");
  const element = createElement(Layout, { ...DEFAULT_PROPS, ...props });
  const html = renderToStaticMarkup(element);
  return {
    html,
    text: textOf(html),
    nav: textOf(part(html, "nav")),
    header: textOf(part(html, "header")),
    current: currentMenu(html),
  };
}

/** タグを除いた文 */
function textOf(html: string): string {
  const noTags = html.replace(/<[^>]*>/g, " ");
  return noTags.replace(/\s+/g, " ").trim();
}

/** 最初の <tag ...>...</tag> */
function part(html: string, tag: string): string {
  const m = new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>`).exec(html);
  expect(m, `<${tag}> がある`).not.toBeNull();
  return m![0];
}

/** aria-current="page" の付いたメニューの文言 */
function currentMenu(html: string): string[] {
  const item = /<(a|button)\b[^>]*aria-current="page"[^>]*>([\s\S]*?)<\/\1>/g;
  return [...part(html, "nav").matchAll(item)].map((m) => textOf(m[2]!));
}

// ---- SSE ----

type StatusEvent = { status?: unknown };

/** /api/events を開く。waitFor で、その稼働状態の知らせが届くまで読む */
async function openEvents(server: AdminServer) {
  const controller = new AbortController();
  cleanups.push(async () => controller.abort());
  const res = await fetch(new URL("api/events", server.url), {
    headers: { accept: "text/event-stream" },
    signal: controller.signal,
  });
  expect(res.status).toBe(200);
  const type = res.headers.get("content-type") ?? "";
  expect(type).toMatch(/^text\/event-stream/);
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  const next = async (): Promise<StatusEvent> => {
    for (;;) {
      buffer = buffer.replace(/\r\n/g, "\n");
      const end = buffer.indexOf("\n\n");
      if (end >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("\n");
        if (data !== "") return JSON.parse(data) as StatusEvent;
        continue;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("SSE が閉じた");
      buffer += value;
    }
  };
  const waitFor = async (want: AdminStatus): Promise<StatusEvent> => {
    for (;;) {
      const event = await next();
      if (event.status === want) return event;
    }
  };
  return { waitFor };
}

// ---- 外のアドレス ----

/** この PC の、127.0.0.1 以外の IPv4 アドレス（別の PC から見えるアドレス） */
function externalAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((list) => list ?? [])
    .filter((a) => a.family === "IPv4" && !a.internal)
    .map((a) => a.address);
}

/** 接続できたら "connected"、できなければエラーのコード */
function tryConnect(host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.once("connect", () => {
      socket.destroy();
      resolve("connected");
    });
    socket.once("error", (e: NodeJS.ErrnoException) => {
      socket.destroy();
      resolve(e.code ?? e.message);
    });
  });
}

// ---- ビルド ----

type AdminModule = { startAdminServer: typeof startAdminServer };
type PackResult = { files: { path: string }[] }[];
type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

/** リポジトリで npm のコマンドを動かす。失敗したら例外になる */
function run(command: string): string {
  return execSync(command, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("Issue #61: 管理画面の土台", () => {
  it("AC1: 起動すると 127.0.0.1 の空いているポートで管理画面を配信し、「管理画面: http://127.0.0.1:<ポート>/」をログに出す", async () => {
    // Given / When: 管理画面を起動する
    const { server, logs } = await seedServer();

    // Then: 127.0.0.1 の、空いているポート（固定ではない）で配信する
    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/`);
    const res = await fetch(server.url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX_HTML);

    // Then: URL をログに出す
    expect(logs).toEqual([`管理画面: http://127.0.0.1:${server.port}/`]);

    // 同時にもう1つ起動しても、別の空いているポートで配信する
    const other = await seedServer();
    expect(other.server.port).not.toBe(server.port);
    expect((await fetch(other.server.url)).status).toBe(200);
  });

  it("AC2: 左にメニュー（ダッシュボード、タスク一覧、設定）、上にヘッダー（この PC で動作中（localhost）、リポジトリ名、Project 番号、稼働状態、言語の切り替え）を出す", async () => {
    // Given / When: 管理画面（ダッシュボード）を開いて表示する
    const page = await renderLayout({ path: "/", status: "running" });

    // Then: 左にメニュー（ヘッダーより前にある <nav>）
    const navAt = page.html.indexOf("<nav");
    const headerAt = page.html.indexOf("<header");
    expect(navAt).toBeGreaterThanOrEqual(0);
    expect(navAt).toBeLessThan(headerAt);
    expect(part(page.html, "nav")).toContain("メニュー");
    const dash = page.nav.indexOf("ダッシュボード");
    const tasks = page.nav.indexOf("タスク一覧");
    const settings = page.nav.indexOf("設定");
    expect(dash).toBeGreaterThanOrEqual(0);
    expect(tasks).toBeGreaterThan(dash);
    expect(settings).toBeGreaterThan(tasks);

    // Then: 上にヘッダー（リポジトリ名、Project 番号、稼働状態、言語の切り替え）
    expect(page.header).toContain(REPO);
    expect(page.header).toMatch(new RegExp(`Project\\s*#?${PROJECT}\\b`));
    expect(page.header).toContain("動作中");
    expect(page.header).toContain("日本語");
    expect(page.header).toContain("English");
    expect(part(page.html, "header")).toContain("言語");

    // Then: この PC で動作中（localhost）
    expect(page.text).toContain("この PC で動作中（localhost）");
  });

  it("AC3: English に切り替えてから再読み込みしても、英語（辞書 en の文言）のまま表示する", async () => {
    const language = await importWeb<LanguageModule>("language.ts");
    const items = new Map<string, string>();
    const storage = {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
    };

    // 何も覚えていなければ日本語
    expect(language.loadLanguage(storage)).toBe("ja");

    // Given: 言語を English に切り替えた
    language.saveLanguage(storage, "en");

    // When: 画面を再読み込みする（覚えた言語で開き直す）
    const lang = language.loadLanguage(storage);
    expect(lang).toBe("en");
    const page = await renderLayout({ lang, status: "idle" });

    // Then: 辞書 en の文言で表示する
    expect(page.nav).toContain("Dashboard");
    expect(page.nav).toContain("Tasks");
    expect(page.nav).toContain("Settings");
    expect(part(page.html, "nav")).toContain("Menu");
    expect(page.text).toContain("Running on this machine (localhost)");
    expect(page.header).toContain("Idle");
    expect(part(page.html, "header")).toContain("Language");
    const japanese = [
      "メニュー",
      "ダッシュボード",
      "タスク一覧",
      "設定",
      "この PC で動作中（localhost）",
      "言語",
      "待機中",
    ];
    for (const ja of japanese) expect(page.html).not.toContain(ja);
  });

  it("AC4: PC の配色がダークならダークで表示し、PC の配色の切り替えにすぐ追従する", async () => {
    const theme = await importWeb<ThemeModule>("theme.ts");

    // Given: PC の配色がダーク
    let dark = true;
    const listeners = new Set<Listener>();
    const queries: string[] = [];
    const matchMedia = (query: string): MediaQueryListLike => {
      queries.push(query);
      const isDark = /prefers-color-scheme:\s*dark/.test(query);
      return {
        get matches() {
          return isDark ? dark : !dark;
        },
        addEventListener: (_type, listener) => {
          if (isDark) listeners.add(listener);
        },
        removeEventListener: (_type, listener) => {
          listeners.delete(listener);
        },
      };
    };
    const changes: Scheme[] = [];

    // When: 画面を開く
    const watch = theme.watchColorScheme(matchMedia, (s) => changes.push(s));

    // Then: ダークの配色で表示する
    expect(queries.some((q) => /prefers-color-scheme/.test(q))).toBe(true);
    expect(watch.scheme).toBe("dark");
    const darkPage = await renderLayout({ scheme: "dark" });
    const darkHtml = darkPage.html.toUpperCase();
    expect(darkHtml).toMatch(/COLOR-SCHEME:\s*DARK/);
    expect(darkHtml).toContain("#0C0C0F");
    expect(darkHtml).not.toContain("#FAFAFB");

    // When: PC の配色をライトに切り替える
    dark = false;
    for (const l of [...listeners]) l({ matches: false });

    // Then: すぐ追従してライトにする
    expect(changes).toEqual(["light"]);
    const lightPage = await renderLayout({ scheme: "light" });
    const lightHtml = lightPage.html.toUpperCase();
    expect(lightHtml).toMatch(/COLOR-SCHEME:\s*LIGHT/);
    expect(lightHtml).toContain("#FAFAFB");
    expect(lightHtml).not.toContain("#0C0C0F");

    // ダークに戻しても追従する
    dark = true;
    for (const l of [...listeners]) l({ matches: true });
    expect(changes).toEqual(["light", "dark"]);
    watch.stop();
  });

  it("AC5: 稼働状態（動作中、待機中、停止中）が変わると、再読み込みしなくてもサーバーから SSE で push し、表示が変わる", async () => {
    // Given: 画面を開いている（SSE を受けている）
    const { server } = await seedServer({ status: "running" });
    const events = await openEvents(server);

    // When / Then: 稼働状態が変わるたびに push する
    server.setStatus("idle");
    expect((await events.waitFor("idle")).status).toBe("idle");
    server.setStatus("stopped");
    expect((await events.waitFor("stopped")).status).toBe("stopped");
    server.setStatus("running");
    expect((await events.waitFor("running")).status).toBe("running");

    // Then: 届いた稼働状態をヘッダーに表示する
    const idle = await renderLayout({ status: "idle" });
    expect(idle.header).toContain("待機中");
    expect(idle.header).not.toContain("停止中");
    const stopped = await renderLayout({ status: "stopped" });
    expect(stopped.header).toContain("停止中");
    expect(stopped.header).not.toContain("待機中");
    const running = await renderLayout({ status: "running" });
    expect(running.header).toContain("動作中");
    expect(running.header).not.toContain("待機中");
    expect(running.header).not.toContain("停止中");
  });

  it("AC6: /tasks や /settings を直接開いても、再読み込みしても、404 にせずその画面を表示する", async () => {
    // Given: 管理画面を配信している
    const { server } = await seedServer();
    const screens = [
      { path: "/", menu: "ダッシュボード" },
      { path: "/tasks", menu: "タスク一覧" },
      { path: "/tasks/12", menu: "タスク一覧" },
      { path: "/settings", menu: "設定" },
    ];

    for (const { path, menu } of screens) {
      // When: 画面の URL を直接開き、もう一度読み込む
      for (let i = 0; i < 2; i++) {
        const res = await fetch(new URL(path, server.url));
        // Then: 404 にせず、画面（index.html）を返す
        expect(res.status, path).toBe(200);
        const type = res.headers.get("content-type") ?? "";
        expect(type, path).toMatch(/^text\/html/);
        expect(await res.text(), path).toBe(INDEX_HTML);
      }

      // Then: URL どおりの画面を表示する（メニューで今の画面を示す）
      const page = await renderLayout({ path });
      expect(page.current, path).toEqual([menu]);
    }

    // 画面の script も配信する
    const script = await fetch(new URL("/assets/app.js", server.url));
    expect(script.status).toBe(200);
  });

  it("AC7: 別の PC から管理画面のポートに接続しても、接続できない（127.0.0.1 だけで待ち受ける）", async () => {
    // Given: 管理画面を配信している
    const { server } = await seedServer();
    expect(await tryConnect("127.0.0.1", server.port)).toBe("connected");

    // When: 別の PC から見えるアドレス（この PC の LAN 側のアドレス）でポートに接続する
    // Then: 接続できない
    for (const address of externalAddresses()) {
      const result = await tryConnect(address, server.port);
      expect(result, address).not.toBe("connected");
    }
    // IPv6（:: で待ち受けたとき）からも接続できない
    expect(await tryConnect("::1", server.port)).not.toBe("connected");
  });

  it("AC8: npm run build で画面もビルドして dist に入り、npm でインストールした conductor でも配信できる。lint、format:check、typecheck が通る", async () => {
    // When: ビルドする
    run("npm run build");

    // Then: 画面のビルド結果が dist/admin に入る
    const indexFile = join(ROOT, "dist", "admin", "index.html");
    expect(existsSync(indexFile)).toBe(true);
    const index = readFileSync(indexFile, "utf8");
    const scriptTag = /<script\b[^>]*\bsrc="([^"]+)"/g;
    const scripts = [...index.matchAll(scriptTag)].map((m) => m[1]!);
    expect(scripts.length).toBeGreaterThan(0);

    // Then: ビルドした conductor（dist）が、同梱の画面を配信できる（assetsDir を渡さない）
    const builtFile = join(ROOT, "dist", "admin-server.js");
    const builtUrl = pathToFileURL(builtFile).href;
    const built = (await import(/* @vite-ignore */ builtUrl)) as AdminModule;
    const server = await built.startAdminServer({
      repo: REPO,
      project: PROJECT,
      status: "running",
      log: () => {},
    });
    cleanups.push(() => server.close());
    for (const path of ["/", "/tasks", "/settings"]) {
      const res = await fetch(new URL(path, server.url));
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).toBe(index);
    }
    for (const src of scripts) {
      const res = await fetch(new URL(src, server.url));
      expect(res.status, src).toBe(200);
      const type = res.headers.get("content-type") ?? "";
      expect(type, src).toMatch(/javascript/);
    }

    // Then: npm のパッケージに画面が入る（npm でインストールした conductor でも配信できる）
    const packed = JSON.parse(run("npm pack --dry-run --json")) as PackResult;
    const files = packed[0]!.files.map((f) => f.path.replace(/\\/g, "/"));
    expect(files).toContain("dist/admin/index.html");
    expect(files).toContain("dist/admin-server.js");

    // Then: React と Vite は devDependencies。実行時の依存は増やさない
    const pkgText = readFileSync(join(ROOT, "package.json"), "utf8");
    const pkg = JSON.parse(pkgText) as PackageJson;
    const runtime = Object.keys(pkg.dependencies ?? {}).sort();
    expect(runtime).toEqual(["yaml", "zod"]);
    for (const name of ["react", "react-dom", "vite"]) {
      expect(pkg.devDependencies, name).toHaveProperty([name]);
    }

    // Then: lint、format:check、typecheck が通る（test はこのテスト自身を含むので CI に任せる）
    run("npm run lint");
    run("npm run format:check");
    run("npm run typecheck");
  }, 600_000);
});

/**
 * Issue #63: 管理画面：ダッシュボード の受け入れテスト
 *
 * 決めたこと（実装役はこれに合わせて作る）:
 * - 常駐ループの状態（メモリにしかないもの）は `src/loop.ts` に足す
 *   ```ts
 *   /** 動いている役（辞書 roles のキー） *\/
 *   export type ActiveRole =
 *     | "tester" | "implementer" | "ci" | "reviewer" | "merge" | "specifier" | "decomposer";
 *
 *   /** メモリにしかない、常駐ループの状態。起動した直後は {} *\/
 *   export interface LoopActivity {
 *     /** 最後に GitHub を確認した時刻（ISO 8601） *\/
 *     lastCheckedAt?: string;
 *     /** 次に GitHub を確認する時刻（ISO 8601） *\/
 *     nextCheckAt?: string;
 *     /** 今動いている役と、その Issue。動いていなければ undefined *\/
 *     running?: { issue: number; role: ActiveRole };
 *   }
 *
 *   export interface LoopDeps {
 *     // 既存の項目はそのまま
 *     /** 常駐ループの状態が変わるたびに、今の状態の全体を渡して呼ぶ。管理画面に知らせるために start.ts がつなぐ *\/
 *     onActivity?: (activity: LoopActivity) => void;
 *   }
 *   ```
 *   - 段階と役の対応: testing→tester、implementing→implementer、ci→ci、reviewing→reviewer、merging→merge
 *   - runLoop は、次の確認を待つ（sleep を呼ぶ）ときには running を消し、
 *     lastCheckedAt（その確認で GitHub を見た時刻）と nextCheckAt（lastCheckedAt + 間隔）を入れておく
 *   - 時刻は Date（new Date()）から取る。このテストは vi.setSystemTime で時刻を決める
 * - ダッシュボードに出す内容を集めるのは新しいモジュール `src/dashboard.ts`
 *   ```ts
 *   export interface DashboardBoard {
 *     issuesByColumn(): Promise<Map<string, LoopIssue[]>>;
 *   }
 *   export interface DashboardDeps {
 *     config: Config;
 *     store: Store;
 *     board: DashboardBoard;
 *     status: AdminStatus;      // 稼働状態（動作中・待機中・停止中）
 *     activity: LoopActivity;   // 常駐ループの状態
 *   }
 *   /** 画面に渡す内容。JSON にできる値だけにする（SSE でそのまま送る）。形は実装役が決めてよい *\/
 *   export type DashboardData = ...;
 *   export function loadDashboard(deps: DashboardDeps): Promise<DashboardData>;
 *   ```
 *   - 列と件数は board（GitHub Projects）が正。回数・段階・段階を始めた時刻（stageStartedAt）・
 *     止まった理由・止まった日時・止まった段階は store（SQLite）から読む
 *   - 処理中の Issue は、常駐ループと同じく Testing・Implementing・Reviewing の列にある
 *     承認待ちでない Issue のうち番号のいちばん小さいもの（conductor を停止していても出す）
 *   - 確認の間隔は config.poll_interval（秒）、マージ方法は config.merge.approval をそのまま出す
 * - Blocked にしたときの記録: `blockIssue`（src/blocked-thread.ts）は、窓口（config.chat）が無くても、
 *   止まった理由と止まった日時（store の Clock の時刻）を store に残す。止まった段階は、その Issue の
 *   checkpoint.stage（Blocked にする前の段階）
 * - 画面の配信 `src/admin-server.ts` の AdminServer に足す
 *   ```ts
 *   /** ダッシュボードの内容を変える。開いている画面に SSE で push する *\/
 *   setDashboard(data: DashboardData): void;
 *   ```
 *   SSE の1件は `{ status, repo, project, dashboard }`（dashboard は最後に setDashboard したもの）。
 *   画面を開いた直後の1件にも、それまでに setDashboard したものを入れる
 * - 画面は `web/src/Dashboard.tsx`
 *   ```ts
 *   export interface DashboardProps {
 *     data: DashboardData;
 *     lang: "ja" | "en";
 *     /** 今の時刻。経過時間と次の確認までの秒数はこれから計算する（画面は1秒ごとに新しい now で描き直す） *\/
 *     now: Date;
 *     onNavigate?: (path: string) => void;
 *   }
 *   export function Dashboard(props: DashboardProps): ReactElement;
 *   ```
 *   ブラウザの globals に触らずに react-dom/server で描けること。デザインどおり、欄ごとに `<section>` を使い、
 *   見出し（辞書の statusTitle・activeTitle・blockedTitle・countsTitle）をその中に書く（section は入れ子にしない）。
 *   - 進み具合は `<ol aria-label="進み具合">` に5つの `<li>`（テスト→実装→CI→レビュー→マージ）。
 *     今の段階の `<li>` に aria-current="step" を付ける
 *   - 「GitHub で開く」は `<a href="https://github.com/<repo>/issues/<番号>">`、
 *     「詳細を見る」は `<a href="/tasks/<番号>">`
 *   - 経過時間はデザインと同じ形（4分12秒、12秒）。次の確認までは「18 秒」、確認の間隔は「30 秒」
 *   - 最後に GitHub を確認した時刻は、デザインと同じ「12秒前」の形か、時刻（HH:MM または HH:MM:SS）
 *   - 止まった日時は、月/日 時:分（年が付いてもよい。「11月21日 11:28」の形でもよい）
 *
 * seed: 記録は MemoryStore（AC2 は再起動を確かめるため、一時フォルダの SqliteStore）、
 * GitHub は列ごとの Issue を覚えるだけの偽物。Blocked は blockIssue で作る。ネットワークには出ない
 * （AC7 の SSE だけ 127.0.0.1 につなぐ）。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { type ComponentType, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type AdminServer,
  type AdminStatus,
  startAdminServer,
} from "../admin-server.js";
import { blockIssue } from "../blocked-thread.js";
import { type Config, parseConfig } from "../config.js";
import { type DashboardData, loadDashboard } from "../dashboard.js";
import {
  type LoopActivity,
  type LoopDeps,
  type LoopIssue,
  runLoop,
} from "../loop.js";
import { SqliteStore } from "../sqlite-store.js";
import {
  type Clock,
  type IssueKey,
  MemoryStore,
  type Stage,
  type Store,
} from "../store.js";

// ---- seed ----

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REPO = "pkshimizu/wordcards";
const PROJECT = 3;
const START = Date.parse("2026-11-21T02:28:00.000Z");

const at = (ms: number) => new Date(START + ms);
const iso = (ms: number) => at(ms).toISOString();
const issueUrl = (n: number) => `https://github.com/${REPO}/issues/${n}`;
const key = (issue: number): IssueKey => ({ repo: REPO, issue });

const ACTIVE: LoopIssue = {
  number: 12,
  title: "単語の一覧に並べ替えをつける",
  body: "本文",
};
const BLOCKED_A: LoopIssue = {
  number: 48,
  title: "単語帳を書き出す",
  body: "本文",
};
const BLOCKED_B: LoopIssue = {
  number: 51,
  title: "単語を読み上げる",
  body: "本文",
};
const REASON_A = "受け入れ条件が曖昧です。書き出す形式を教えてください。";
const REASON_B = "3 回続けて失敗しました: 音声の再生が始まりません";

function makeConfig(
  options: { merge?: "auto" | "human"; poll?: number } = {},
): Config {
  return parseConfig(
    [
      `github: { repo: ${REPO}, project: ${PROJECT}, notify: someone }`,
      "protected: [src/acceptance/**]",
      "commands: { setup: s, test: t, acceptance: a, typecheck: c, build: b }",
      `merge: { approval: ${options.merge ?? "human"} }`,
      `poll_interval: ${options.poll ?? 30}`,
      "limits: { rejections: 3, objections: 2 }",
    ].join("\n"),
  );
}

/** 時刻を進められる Clock */
function fixedClock(ms = 0): Clock & { set: (ms: number) => void } {
  let t = START + ms;
  const clock = () => new Date(t);
  clock.set = (next: number) => {
    t = START + next;
  };
  return clock;
}

/** 列ごとの Issue を覚えるだけの GitHub */
class FakeBoard {
  readonly columns = new Map<string, LoopIssue[]>();

  constructor(columns: Record<string, LoopIssue[]> = {}) {
    for (const [c, list] of Object.entries(columns)) {
      this.columns.set(c, [...list]);
    }
  }

  issuesByColumn(): Promise<Map<string, LoopIssue[]>> {
    return Promise.resolve(
      new Map([...this.columns].map(([c, list]) => [c, [...list]])),
    );
  }

  moveIssue(issue: number, column: string): Promise<void> {
    let found: LoopIssue | undefined;
    for (const list of this.columns.values()) {
      const i = list.findIndex((x) => x.number === issue);
      if (i >= 0) found = list.splice(i, 1)[0];
    }
    const target = this.columns.get(column) ?? [];
    target.push(found ?? { number: issue, title: "", body: "" });
    this.columns.set(column, target);
    return Promise.resolve();
  }

  comment(): Promise<void> {
    return Promise.resolve();
  }

  hasConflict(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

/** 処理中の Issue（#12、実装の段階、差し戻し1・異議1） */
async function seedActive(store: Store, stage: Stage = "implementing") {
  await store.update(key(ACTIVE.number), {
    branch: `conductor/issue-${ACTIVE.number}`,
    rejections: 1,
    objections: 1,
    checkpoint: { stage },
  });
}

/** Issue をその段階で Blocked にする（conductor 自身の経路 blockIssue で） */
async function seedBlocked(
  config: Config,
  store: Store,
  board: FakeBoard,
  issue: LoopIssue,
  stage: Stage,
  reason: string,
) {
  await store.update(key(issue.number), { checkpoint: { stage } });
  await blockIssue({ config, store, board }, issue.number, {
    body: `止まりました\n\n${reason}`,
    reason,
  });
}

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  while (cleanups.length > 0) await cleanups.pop()!();
});

// ---- 画面のソース（src の外にあるので、実行時に import する） ----

type Lang = "ja" | "en";

interface DashboardProps {
  data: DashboardData;
  lang: Lang;
  now: Date;
  onNavigate?: (path: string) => void;
}

interface DashboardModule {
  Dashboard: ComponentType<DashboardProps>;
}

async function render(data: DashboardData, now: Date, lang: Lang = "ja") {
  const url = pathToFileURL(join(ROOT, "web", "src", "Dashboard.tsx")).href;
  const { Dashboard } = (await import(
    /* @vite-ignore */ url
  )) as DashboardModule;
  // 画面には SSE（JSON）で届くので、JSON を通したものを描く
  const sent = JSON.parse(JSON.stringify(data)) as DashboardData;
  const html = renderToStaticMarkup(
    createElement(Dashboard, { data: sent, lang, now }),
  );
  return { html, text: textOf(html) };
}

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

/** 見出しの文を含む <section>。無ければ undefined */
function sectionOf(html: string, title: string): string | undefined {
  const sections = html.match(/<section\b[\s\S]*?<\/section>/g) ?? [];
  return sections.find((s) => textOf(s).includes(title));
}

function section(html: string, title: string): { html: string; text: string } {
  const s = sectionOf(html, title);
  expect(s, `「${title}」の <section> がある`).toBeDefined();
  return { html: s!, text: textOf(s!) };
}

/** <a> の href と文 */
function links(html: string): { href: string; text: string }[] {
  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({
    href: /\bhref="([^"]*)"/.exec(m[1]!)?.[1]?.replace(/&amp;/g, "&") ?? "",
    text: textOf(m[2]!),
  }));
}

function expectLinks(html: string, n: number) {
  const list = links(html);
  expect(
    list.some(
      (l) => l.href === issueUrl(n) && l.text.includes("GitHub で開く"),
    ),
    `#${n} の「GitHub で開く」`,
  ).toBe(true);
  expect(
    list.some((l) => l.href === `/tasks/${n}` && l.text.includes("詳細を見る")),
    `#${n} の「詳細を見る」`,
  ).toBe(true);
}

/** 進み具合の段階の文と、今の段階（aria-current="step"）の文 */
function progressOf(html: string): { steps: string[]; current: string[] } {
  const ol = /<ol\b[^>]*aria-label="進み具合"[^>]*>([\s\S]*?)<\/ol>/.exec(html);
  expect(ol, "進み具合の <ol>").not.toBeNull();
  const items = [...ol![1]!.matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li>/g)];
  return {
    steps: items.map((m) => textOf(m[2]!)),
    current: items
      .filter((m) => /aria-current="step"/.test(m[1]!))
      .map((m) => textOf(m[2]!)),
  };
}

const STAGE_LABELS = ["テスト", "実装", "CI", "レビュー", "マージ"];

function expectProgress(html: string, current: string) {
  const { steps, current: now } = progressOf(html);
  expect(steps).toHaveLength(5);
  steps.forEach((s, i) => expect(s.startsWith(STAGE_LABELS[i]!), s).toBe(true));
  expect(now).toHaveLength(1);
  expect(now[0]!.startsWith(current)).toBe(true);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 最後に GitHub を確認した時刻（「12秒前」の形か、その時刻） */
function checkedPattern(checked: Date, agoText: string): RegExp {
  const hm = `${pad(checked.getHours())}:${pad(checked.getMinutes())}`;
  return new RegExp(
    `最後に GitHub を確認\\s*(${agoText}|${hm}(:${pad(checked.getSeconds())})?)`,
  );
}

/** 止まった日時（この PC の時刻で、月/日 時:分） */
function stampPattern(d: Date): RegExp {
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return new RegExp(
    `((${d.getFullYear()}[/-])?0?${m}[/-]0?${day}|(${d.getFullYear()}年)?${m}月${day}日)\\s*${hm}`,
  );
}

// ---- SSE ----

type Event = { status?: unknown; dashboard?: unknown };

async function openEvents(server: AdminServer) {
  const controller = new AbortController();
  cleanups.push(async () => controller.abort());
  const res = await fetch(new URL("api/events", server.url), {
    headers: { accept: "text/event-stream" },
    signal: controller.signal,
  });
  expect(res.status).toBe(200);
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  const next = async (): Promise<Event> => {
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
        if (data !== "") return JSON.parse(data) as Event;
        continue;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("SSE が閉じた");
      buffer += value;
    }
  };
  /** その内容のダッシュボードが届くまで読む */
  const waitForDashboard = async (want: DashboardData): Promise<Event> => {
    const json = JSON.stringify(JSON.parse(JSON.stringify(want)));
    for (;;) {
      const event = await next();
      if (JSON.stringify(event.dashboard) === json) return event;
    }
  };
  return { waitForDashboard };
}

describe("Issue #63: 管理画面：ダッシュボード", () => {
  it("AC1: 稼働状況として、状態、最後に GitHub を確認した時刻、次の確認までの秒数（1秒ごとに減る）、確認の間隔、マージ方法（auto または human をそのまま）を出す", async () => {
    // Given: ダッシュボードを開いた（30 秒ごとに確認、マージは human）
    const store = new MemoryStore(fixedClock());
    const board = new FakeBoard({ Ready: [], Implementing: [ACTIVE] });
    await seedActive(store);
    const activity: LoopActivity = {
      lastCheckedAt: iso(0),
      nextCheckAt: iso(30_000),
      running: { issue: ACTIVE.number, role: "implementer" },
    };
    const data = await loadDashboard({
      config: makeConfig({ merge: "human", poll: 30 }),
      store,
      board,
      status: "running",
      activity,
    });

    // When: 確認から 12 秒後に表示する
    const page = await render(data, at(12_000));

    // Then: 稼働状況の欄に、状態・確認した時刻・次の確認まで・間隔・マージ方法を出す
    const status = section(page.html, "稼働状況");
    expect(status.text).toContain("動作中");
    expect(status.text).toMatch(checkedPattern(at(0), "12秒前"));
    expect(status.text).toMatch(/次の確認まで\s*18\s*秒/);
    expect(status.text).toMatch(/確認の間隔\s*30\s*秒/);
    expect(status.text).toMatch(/マージ\s*human/);

    // Then: 次の確認までの秒数は1秒ごとに減る
    const later = section((await render(data, at(13_000))).html, "稼働状況");
    expect(later.text).toMatch(/次の確認まで\s*17\s*秒/);
    const later2 = section((await render(data, at(14_000))).html, "稼働状況");
    expect(later2.text).toMatch(/次の確認まで\s*16\s*秒/);

    // Then: 状態（待機中・停止中）とマージ方法（auto）も、そのまま出す
    const statuses: [AdminStatus, string, string[]][] = [
      ["idle", "待機中", ["動作中", "停止中"]],
      ["stopped", "停止中", ["動作中", "待機中"]],
    ];
    for (const [s, label, others] of statuses) {
      const d = await loadDashboard({
        config: makeConfig({ merge: "auto", poll: 90 }),
        store,
        board,
        status: s,
        activity: { lastCheckedAt: iso(0), nextCheckAt: iso(90_000) },
      });
      const p = section((await render(d, at(5_000))).html, "稼働状況");
      expect(p.text, s).toContain(label);
      for (const o of others) expect(p.text, s).not.toContain(o);
      expect(p.text, s).toMatch(/確認の間隔\s*90\s*秒/);
      expect(p.text, s).toMatch(/マージ\s*auto/);
      expect(p.text, s).not.toMatch(/マージ\s*human/);
    }

    // English は辞書 en の文言で出す
    const en = await render(data, at(12_000), "en");
    expect(sectionOf(en.html, "稼働状況")).toBeUndefined();
    const enStatus = section(en.html, "Status");
    expect(enStatus.text).toContain("Running");
    expect(enStatus.text).toContain("Last checked GitHub");
    expect(enStatus.text).toContain("Next check in");
    expect(enStatus.text).toContain("Poll interval");
    expect(enStatus.text).toMatch(/Merge\s*human/);
  });

  it("AC2: 処理中の Issue の番号、タイトル、ブランチ、進み具合、動いている役、今の段階の経過時間（再起動しても正しい）、差し戻しと異議の回数、「GitHub で開く」「詳細を見る」を出す", async () => {
    const dir = await mkdtemp(join(tmpdir(), "conductor-63-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, "conductor.db");
    const config = makeConfig();
    const board = new FakeBoard({ Implementing: [ACTIVE], Ready: [] });

    // Given: 処理中の Issue がある（実装の段階を START に始めた）
    const clock = fixedClock();
    const before: Store = new SqliteStore(file, clock);
    await before.update(key(ACTIVE.number), {
      checkpoint: { stage: "testing" },
    });
    await seedActive(before, "implementing");
    const running: LoopActivity = {
      lastCheckedAt: iso(0),
      nextCheckAt: iso(30_000),
      running: { issue: ACTIVE.number, role: "implementer" },
    };

    // When: 表示する
    const data = await loadDashboard({
      config,
      store: before,
      board,
      status: "running",
      activity: running,
    });
    const page = await render(data, at(60_000));

    // Then: 番号、タイトル、ブランチ、進み具合、動いている役、経過時間、回数、リンクを出す
    const active = section(page.html, "処理中の Issue");
    expect(active.text).toMatch(/#\s*12\b/);
    expect(active.text).toContain(ACTIVE.title);
    expect(active.text).toMatch(/ブランチ\s*conductor\/issue-12/);
    expectProgress(active.html, "実装");
    expect(active.text).toContain("実装役");
    expect(active.text).toMatch(/経過\s*1分0{1,2}秒/);
    expect(active.text).toMatch(/差し戻し\s*1(\s*\/\s*3)?/);
    expect(active.text).toMatch(/異議\s*1(\s*\/\s*2)?/);
    expectLinks(active.html, ACTIVE.number);

    // When: conductor を止めて再起動し、同じ段階を続きから動かす
    await before.close();
    clock.set(200_000);
    const after: Store = new SqliteStore(file, clock);
    cleanups.push(() => after.close());
    await after.update(key(ACTIVE.number), {
      checkpoint: { stage: "implementing" },
    });
    const restarted = await loadDashboard({
      config,
      store: after,
      board,
      status: "running",
      activity: {
        lastCheckedAt: iso(200_000),
        nextCheckAt: iso(230_000),
        running: { issue: ACTIVE.number, role: "implementer" },
      },
    });

    // Then: 経過時間は段階を始めた時刻（START）から数える
    const again = section(
      (await render(restarted, at(252_000))).html,
      "処理中の Issue",
    );
    expect(again.text).toMatch(/経過\s*4分12秒/);
    expect(again.text).not.toMatch(/経過\s*52秒/);
    expectProgress(again.html, "実装");
  });

  it("AC3: 処理中の Issue がないとき、「Ready の Issue を待っています」と、Ready 列に移すと処理が始まる旨の案内を出す", async () => {
    // Given: 処理中の Issue がない（Ready・Done だけ）
    const store = new MemoryStore(fixedClock());
    const board = new FakeBoard({
      Ready: [],
      Done: [{ number: 3, title: "終わった Issue", body: "" }],
    });
    const data = await loadDashboard({
      config: makeConfig(),
      store,
      board,
      status: "idle",
      activity: { lastCheckedAt: iso(0), nextCheckAt: iso(30_000) },
    });

    // When: 表示する
    const page = await render(data, at(5_000));

    // Then: 待っている旨と案内を出す
    const active = section(page.html, "処理中の Issue");
    expect(active.text).toContain("Ready の Issue を待っています");
    expect(active.text).toContain(
      "GitHub Projects の「Ready」列に Issue を移すと、ここで処理が始まります。",
    );
    expect(active.html).not.toMatch(/aria-label="進み具合"/);
    expect(active.text).not.toContain("終わった Issue");
  });

  it("AC4: Blocked 列に Issue があるとき、「人の判断を待っています」の欄に、止まった理由、止まった日時、止まった段階、「GitHub で開く」「詳細を見る」を出す", async () => {
    // Given: Blocked 列に Issue が2件ある（テストの段階と、レビューの段階で止まった）
    const config = makeConfig();
    const clock = fixedClock();
    const store = new MemoryStore(clock);
    const board = new FakeBoard({
      Ready: [],
      Testing: [BLOCKED_A],
      Reviewing: [BLOCKED_B],
      Blocked: [],
    });
    clock.set(0);
    await seedBlocked(config, store, board, BLOCKED_A, "testing", REASON_A);
    clock.set(3_600_000);
    await seedBlocked(config, store, board, BLOCKED_B, "reviewing", REASON_B);
    expect(board.columns.get("Blocked")?.map((i) => i.number)).toEqual([
      48, 51,
    ]);

    // When: しばらく後に表示する
    clock.set(7_200_000);
    const data = await loadDashboard({
      config,
      store,
      board,
      status: "idle",
      activity: { lastCheckedAt: iso(7_200_000), nextCheckAt: iso(7_230_000) },
    });
    const page = await render(data, at(7_210_000));

    // Then: 「人の判断を待っています」の欄に、Issue ごとに出す
    const blocked = section(page.html, "人の判断を待っています");
    expect(blocked.text).toContain("GitHub で内容を確認して判断してください");
    const a = blocked.text.search(/#\s*48\b/);
    const b = blocked.text.search(/#\s*51\b/);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThan(a);
    const partA = blocked.text.slice(a, b);
    const partB = blocked.text.slice(b);

    expect(partA).toContain(BLOCKED_A.title);
    expect(partA).toContain("止まった理由");
    expect(partA).toContain(REASON_A);
    expect(partA).toContain("止まった日時");
    expect(partA).toMatch(stampPattern(at(0)));
    expect(partA).toContain("テスト");
    expect(partA).not.toContain("レビュー");

    expect(partB).toContain(BLOCKED_B.title);
    expect(partB).toContain(REASON_B);
    expect(partB).toMatch(stampPattern(at(3_600_000)));
    expect(partB).toContain("レビュー");
    expect(partB).not.toContain("テスト");

    expectLinks(blocked.html, BLOCKED_A.number);
    expectLinks(blocked.html, BLOCKED_B.number);

    // Blocked が無ければ、この欄は出さない
    const none = await loadDashboard({
      config,
      store: new MemoryStore(clock),
      board: new FakeBoard({ Ready: [] }),
      status: "idle",
      activity: {},
    });
    const empty = await render(none, at(7_210_000));
    expect(empty.text).not.toContain("人の判断を待っています");
  });

  it("AC5: GitHub Projects の列ごとの件数を出す", async () => {
    // Given: 列ごとに Issue がある
    const issue = (n: number): LoopIssue => ({
      number: n,
      title: `Issue ${n}`,
      body: "",
    });
    const board = new FakeBoard({
      Ready: [issue(20), issue(21)],
      Implementing: [issue(12)],
      Done: [issue(1), issue(2), issue(3)],
      Blocked: [issue(48)],
    });
    const data = await loadDashboard({
      config: makeConfig(),
      store: new MemoryStore(fixedClock()),
      board,
      status: "running",
      activity: { lastCheckedAt: iso(0), nextCheckAt: iso(30_000) },
    });

    // When: 表示する
    const page = await render(data, at(1_000));

    // Then: 列ごとの件数を、列の順に出す（Issue の無い列は 0）
    const counts = section(page.html, "列ごとの件数");
    const want: [string, number][] = [
      ["Ready", 2],
      ["Testing", 0],
      ["Implementing", 1],
      ["Reviewing", 0],
      ["Done", 3],
      ["Blocked", 1],
    ];
    let from = 0;
    for (const [column, count] of want) {
      const m = new RegExp(`${column}\\s*${count}(?!\\d)`).exec(
        counts.text.slice(from),
      );
      expect(m, `${column} ${count}`).not.toBeNull();
      from += m!.index + m![0].length;
    }

    // Then: GitHub の列が変われば件数も変わる
    await board.moveIssue(20, "Testing");
    const moved = await loadDashboard({
      config: makeConfig(),
      store: new MemoryStore(fixedClock()),
      board,
      status: "running",
      activity: { lastCheckedAt: iso(0), nextCheckAt: iso(30_000) },
    });
    const movedCounts = section(
      (await render(moved, at(1_000))).html,
      "列ごとの件数",
    );
    expect(movedCounts.text).toMatch(/Ready\s*1(?!\d)/);
    expect(movedCounts.text).toMatch(/Testing\s*1(?!\d)/);
  });

  it("AC6: conductor を停止していて処理中の Issue があるとき、「conductor を停止しているため、この作業は止まっています。再起動すると続きから動きます。」を出す", async () => {
    const PAUSED =
      "conductor を停止しているため、この作業は止まっています。再起動すると続きから動きます。";
    const config = makeConfig();
    const store = new MemoryStore(fixedClock());
    await seedActive(store);
    const board = new FakeBoard({ Implementing: [ACTIVE] });

    // Given: conductor を停止している / When: 処理中の Issue がある
    const stopped = await loadDashboard({
      config,
      store,
      board,
      status: "stopped",
      activity: { lastCheckedAt: iso(0) },
    });
    const page = await render(stopped, at(60_000));

    // Then: 作業が止まっている旨を、処理中の Issue の欄に出す
    const active = section(page.html, "処理中の Issue");
    expect(active.text).toMatch(/#\s*12\b/);
    expect(active.text).toContain(PAUSED);

    // 動作中・待機中なら出さない
    for (const status of ["running", "idle"] as const) {
      const d = await loadDashboard({
        config,
        store,
        board,
        status,
        activity: {
          lastCheckedAt: iso(0),
          nextCheckAt: iso(30_000),
          ...(status === "running"
            ? {
                running: { issue: ACTIVE.number, role: "implementer" as const },
              }
            : {}),
        },
      });
      expect((await render(d, at(10_000))).text, status).not.toContain(PAUSED);
    }

    // 停止していても、処理中の Issue が無ければ出さない
    const idle = await loadDashboard({
      config,
      store: new MemoryStore(fixedClock()),
      board: new FakeBoard({ Ready: [] }),
      status: "stopped",
      activity: {},
    });
    expect((await render(idle, at(10_000))).text).not.toContain(PAUSED);
  });

  it("AC7: 段階、動いている役、確認した時刻などが変わると、再読み込みしなくても表示が変わる", async () => {
    // ---- 常駐ループは、動いている役と確認した時刻が変わるたびに知らせる ----
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(0));
    const config = makeConfig();
    const store = new MemoryStore();
    await seedActive(store);
    const board = new FakeBoard({ Implementing: [ACTIVE], Ready: [] });
    const activities: LoopActivity[] = [];
    const last = () => structuredClone(activities.at(-1));
    let duringImplement: LoopActivity | undefined;
    let atSleep: LoopActivity | undefined;
    const controller = new AbortController();
    const unexpected = () => Promise.reject(new Error("呼ばれないはず"));
    const deps: LoopDeps = {
      config,
      store,
      board,
      pickUp: unexpected,
      test: unexpected,
      implement: () => {
        duringImplement = last();
        return Promise.resolve({ status: "implemented" });
      },
      checkCi: unexpected,
      review: unexpected,
      merge: unexpected,
      syncMain: unexpected,
      log: () => {},
      sleep: () => {
        atSleep = last();
        controller.abort();
        return Promise.resolve();
      },
      onActivity: (a) => activities.push(structuredClone(a)),
    };
    await runLoop(deps, controller.signal, { intervalMs: 30_000 });

    // Then: 役が動いている間は、その役と Issue を知らせる
    expect(duringImplement?.running).toEqual({
      issue: ACTIVE.number,
      role: "implementer",
    });
    // Then: 次の確認を待つ間は、役を消し、確認した時刻と次の確認の時刻を知らせる
    expect(atSleep?.running).toBeUndefined();
    expect(atSleep?.lastCheckedAt).toBe(iso(0));
    expect(atSleep?.nextCheckAt).toBe(iso(30_000));
    vi.useRealTimers();

    // ---- 管理画面は、変わった内容を開いている画面に SSE で push する ----
    const assets = await mkdtemp(join(tmpdir(), "conductor-admin-63-"));
    cleanups.push(() => rm(assets, { recursive: true, force: true }));
    await writeFile(
      join(assets, "index.html"),
      "<!doctype html><title>c</title>",
    );
    const server = await startAdminServer({
      repo: REPO,
      project: PROJECT,
      status: "running",
      log: () => {},
      assetsDir: assets,
    });
    cleanups.push(() => server.close());

    const clock = fixedClock();
    const live = new MemoryStore(clock);
    await seedActive(live, "implementing");
    const first = await loadDashboard({
      config,
      store: live,
      board,
      status: "running",
      activity: {
        lastCheckedAt: iso(0),
        nextCheckAt: iso(30_000),
        running: { issue: ACTIVE.number, role: "implementer" },
      },
    });
    server.setDashboard(first);

    // Given: 画面を開いている（開いた直後に今の内容が届く）
    const events = await openEvents(server);
    const opened = await events.waitForDashboard(first);
    const shown1 = await render(opened.dashboard as DashboardData, at(5_000));
    const active1 = section(shown1.html, "処理中の Issue");
    expectProgress(active1.html, "実装");
    expect(active1.text).toContain("実装役");
    expect(section(shown1.html, "稼働状況").text).toMatch(
      /次の確認まで\s*25\s*秒/,
    );

    // When: 段階（CI へ）、動いている役、確認した時刻が変わる
    clock.set(40_000);
    await live.update(key(ACTIVE.number), {
      pr: 21,
      checkpoint: { stage: "ci" },
    });
    const second = await loadDashboard({
      config,
      store: live,
      board,
      status: "running",
      activity: {
        lastCheckedAt: iso(40_000),
        nextCheckAt: iso(70_000),
        running: { issue: ACTIVE.number, role: "ci" },
      },
    });
    server.setDashboard(second);

    // Then: 再読み込みしなくても、新しい内容が届いて表示が変わる
    const pushed = await events.waitForDashboard(second);
    const shown2 = await render(pushed.dashboard as DashboardData, at(50_000));
    const active2 = section(shown2.html, "処理中の Issue");
    expectProgress(active2.html, "CI");
    expect(active2.text).not.toContain("実装役");
    expect(active2.text).toMatch(/経過\s*10秒/);
    const status2 = section(shown2.html, "稼働状況");
    expect(status2.text).toMatch(/次の確認まで\s*20\s*秒/);
    expect(status2.text).toMatch(checkedPattern(at(40_000), "10秒前"));
  });
});

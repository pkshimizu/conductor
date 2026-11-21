/**
 * Issue #64: 管理画面：タスク一覧 の受け入れテスト
 *
 * 決めたこと（実装役はこれに合わせて作る）:
 * - タスク一覧に出す内容を集めるのは新しいモジュール `src/tasks.ts`
 *   ```ts
 *   /** GitHub Projects の Issue。updatedAt は GitHub の更新日時（ISO 8601。取れなければ省く） *\/
 *   export interface TaskIssue extends LoopIssue { updatedAt?: string }
 *   export interface TasksBoard {
 *     /** Project のすべての Issue（列の名前ごと） *\/
 *     issuesByColumn(): Promise<Map<string, TaskIssue[]>>;
 *     /** PR がマージ済みか *\/
 *     isMerged(pr: number): Promise<boolean>;
 *   }
 *   export interface TasksDeps { config: Config; store: Store; board: TasksBoard }
 *   /** 画面に渡す内容。JSON にできる値だけにする（SSE でそのまま送る）。形は実装役が決めてよい *\/
 *   export type TasksData = ...;
 *   export function loadTasks(deps: TasksDeps): Promise<TasksData>;
 *   ```
 *   - 列は board（GitHub Projects）が正。差し戻し・異議・途中の段階（checkpoint.stage）・PR は store（SQLite）から読む
 *   - マージ済みかは board.isMerged で確かめる
 *   - 更新日時は store の updatedAt か、GitHub の updatedAt（このテストでは、記録のある Issue は両方を同じ時刻にしてある）
 * - 画面の配信 `src/admin-server.ts` の AdminServer に足す
 *   ```ts
 *   /** タスク一覧の内容を変える。開いている画面に SSE で push する *\/
 *   setTasks(data: TasksData): void;
 *   ```
 *   SSE の1件は `{ status, repo, project, dashboard, tasks }`（tasks は最後に setTasks したもの）。
 *   画面を開いた直後の1件にも、それまでに setTasks したものを入れる
 * - 画面は `web/src/TaskList.tsx`
 *   ```ts
 *   export interface TaskListProps {
 *     data: TasksData;
 *     lang: "ja" | "en";
 *     /** 選んだ列。"all"（すべて）か列の名前 *\/
 *     filter: string;
 *     /** 検索欄の文字 *\/
 *     query: string;
 *     onFilter?: (filter: string) => void;
 *     onQuery?: (query: string) => void;
 *     onNavigate?: (path: string) => void;
 *   }
 *   export function TaskList(props: TaskListProps): ReactElement;
 *   ```
 *   ブラウザの globals に触らずに react-dom/server で描けること。
 *   - 表は `<table>`。見出しは `<thead>` の `<th>` で、順に Issue・タイトル・列・途中の段階・差し戻し・異議・PR・更新日時。
 *     Issue 1件は `<tbody>` の `<tr>` 1行で、`<td>` を見出しと同じ順に並べる
 *   - Issue の欄は「#12」の形。差し戻し・異議は回数（「1」か「1/3」の形）。途中の段階は辞書 stage の文言（実装など）、
 *     段階の記録が無ければ段階の文言を出さない。PR の欄は「#21」の形（無ければ「—」など番号を出さない）。
 *     更新日時は、この PC の時刻で 月/日 時:分（ダッシュボードの止まった日時と同じ形）
 *   - 列の選択肢は `<button>` で、文は「選択肢の名前 件数」（例:「すべて 7」「Ready 2」）。
 *     選択肢は「すべて」と、config の列（Ready・Testing・Implementing・Reviewing・Done・Blocked）。
 *     選んでいる選択肢の button に aria-pressed="true"
 *   - 検索は、番号の一部かタイトルの一部で当てはめる
 *   - 行には、その Issue のタスク詳細への `<a href="/tasks/<番号>">` を置く（クリックで開く）
 *
 * seed: 記録は MemoryStore（時刻は進められる Clock）、GitHub は列ごとの Issue と、マージ済みの PR を覚えるだけの偽物。
 * ネットワークには出ない（AC6 の SSE だけ 127.0.0.1 につなぐ）。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { type ComponentType, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { type AdminServer, startAdminServer } from "../admin-server.js";
import { type Config, parseConfig } from "../config.js";
import {
  type Clock,
  type IssueKey,
  MemoryStore,
  type Store,
} from "../store.js";
import { type TaskIssue, type TasksData, loadTasks } from "../tasks.js";

// ---- seed ----

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REPO = "pkshimizu/wordcards";
const PROJECT = 3;
const START = Date.parse("2026-11-20T02:28:00.000Z");
const HOUR = 3_600_000;

const at = (ms: number) => new Date(START + ms);
const iso = (ms: number) => at(ms).toISOString();
const key = (issue: number): IssueKey => ({ repo: REPO, issue });

function makeConfig(): Config {
  return parseConfig(
    [
      `github: { repo: ${REPO}, project: ${PROJECT}, notify: someone }`,
      "protected: [src/acceptance/**]",
      "commands: { setup: s, test: t, acceptance: a, typecheck: c, build: b }",
      "merge: { approval: human }",
      "poll_interval: 30",
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

/** 列ごとの Issue と、マージ済みの PR を覚えるだけの GitHub */
class FakeBoard {
  readonly columns = new Map<string, TaskIssue[]>();
  readonly merged = new Set<number>();

  constructor(columns: Record<string, TaskIssue[]>, merged: number[] = []) {
    for (const [c, list] of Object.entries(columns)) {
      this.columns.set(
        c,
        list.map((i) => ({ ...i })),
      );
    }
    for (const pr of merged) this.merged.add(pr);
  }

  issuesByColumn(): Promise<Map<string, TaskIssue[]>> {
    return Promise.resolve(
      new Map(
        [...this.columns].map(([c, list]) => [c, list.map((i) => ({ ...i }))]),
      ),
    );
  }

  isMerged(pr: number): Promise<boolean> {
    return Promise.resolve(this.merged.has(pr));
  }

  /** Issue を別の列に移す（GitHub の更新日時も変わる） */
  move(issue: number, column: string, updatedAt: string): void {
    let found: TaskIssue | undefined;
    for (const list of this.columns.values()) {
      const i = list.findIndex((x) => x.number === issue);
      if (i >= 0) found = list.splice(i, 1)[0];
    }
    const target = this.columns.get(column) ?? [];
    target.push({ ...found!, updatedAt });
    this.columns.set(column, target);
  }
}

interface Seeded {
  config: Config;
  clock: ReturnType<typeof fixedClock>;
  store: Store;
  board: FakeBoard;
}

/**
 * Project に 7 件の Issue がある状態:
 * - #1  Done（conductor の記録なし・PR なし）
 * - #3  Done（PR #5 はマージ済み、差し戻し 2）
 * - #12 Implementing（実装の段階、差し戻し 1・異議 1、PR なし）
 * - #20 Ready（記録なし）
 * - #21 Ready（記録なし）
 * - #30 Reviewing（レビューの段階、PR #31 は未マージ、異議 2）
 * - #48 Blocked（テストの段階で止まった）
 */
async function seed(): Promise<Seeded> {
  const config = makeConfig();
  const clock = fixedClock();
  const store = new MemoryStore(clock);

  clock.set(1 * HOUR);
  await store.update(key(3), {
    branch: "conductor/issue-3",
    pr: 5,
    rejections: 2,
    objections: 0,
  });
  clock.set(2 * HOUR);
  await store.update(key(48), {
    branch: "conductor/issue-48",
    checkpoint: { stage: "testing" },
    blockedReason: "受け入れ条件が曖昧です",
  });
  clock.set(3 * HOUR);
  await store.update(key(30), {
    branch: "conductor/issue-30",
    pr: 31,
    rejections: 0,
    objections: 2,
    checkpoint: { stage: "reviewing" },
  });
  clock.set(4 * HOUR);
  await store.update(key(12), {
    branch: "conductor/issue-12",
    rejections: 1,
    objections: 1,
    checkpoint: { stage: "implementing" },
  });

  const issue = (n: number, title: string, ms: number): TaskIssue => ({
    number: n,
    title,
    body: "本文",
    updatedAt: iso(ms),
  });
  const board = new FakeBoard(
    {
      Ready: [
        issue(20, "単語を検索する", 0),
        issue(21, "ログイン画面を作る", 0),
      ],
      Testing: [],
      Implementing: [issue(12, "単語の一覧に並べ替えをつける", 4 * HOUR)],
      Reviewing: [issue(30, "通知を送る", 3 * HOUR)],
      Done: [
        issue(1, "辞書を読み込む", 0),
        issue(3, "設定画面を作る", 1 * HOUR),
      ],
      Blocked: [issue(48, "書き出しをつける", 2 * HOUR)],
    },
    [5],
  );
  return { config, clock, store, board };
}

const ALL = [1, 3, 12, 20, 21, 30, 48];

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

// ---- 画面のソース（src の外にあるので、実行時に import する） ----

type Lang = "ja" | "en";

interface TaskListProps {
  data: TasksData;
  lang: Lang;
  filter: string;
  query: string;
  onFilter?: (filter: string) => void;
  onQuery?: (query: string) => void;
  onNavigate?: (path: string) => void;
}

interface TaskListModule {
  TaskList: ComponentType<TaskListProps>;
}

async function render(
  data: TasksData,
  options: { filter?: string; query?: string; lang?: Lang } = {},
) {
  const url = pathToFileURL(join(ROOT, "web", "src", "TaskList.tsx")).href;
  const { TaskList } = (await import(/* @vite-ignore */ url)) as TaskListModule;
  // 画面には SSE（JSON）で届くので、JSON を通したものを描く
  const sent = JSON.parse(JSON.stringify(data)) as TasksData;
  const html = renderToStaticMarkup(
    createElement(TaskList, {
      data: sent,
      lang: options.lang ?? "ja",
      filter: options.filter ?? "all",
      query: options.query ?? "",
    }),
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

/** 表の見出し（<thead> の <th> の文） */
function headersOf(html: string): string[] {
  const table = /<table\b[\s\S]*?<\/table>/.exec(html);
  expect(table, "<table> がある").not.toBeNull();
  const thead = /<thead\b[\s\S]*?<\/thead>/.exec(table![0]);
  expect(thead, "<thead> がある").not.toBeNull();
  return [...thead![0].matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map((m) =>
    textOf(m[1]!),
  );
}

interface Row {
  html: string;
  cells: { html: string; text: string }[];
}

/** 表の行（<tbody> の <tr>）。行が無ければ [] */
function rowsOf(html: string): Row[] {
  const table = /<table\b[\s\S]*?<\/table>/.exec(html);
  if (table === null) return [];
  const tbody = /<tbody\b[\s\S]*?<\/tbody>/.exec(table[0]);
  if (tbody === null) return [];
  return [...tbody[0].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)]
    .map((m) => ({
      html: m[0],
      cells: [...m[1]!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((c) => ({
        html: c[0],
        text: textOf(c[1]!),
      })),
    }))
    .filter((r) => r.cells.length > 0);
}

/** 行の Issue の番号（Issue の欄の「#12」） */
function numberOf(row: Row): number {
  const m = /^#\s*(\d+)$/.exec(row.cells[0]?.text ?? "");
  expect(m, `Issue の欄「${row.cells[0]?.text}」`).not.toBeNull();
  return Number(m![1]);
}

function numbersOf(html: string): number[] {
  return rowsOf(html)
    .map(numberOf)
    .sort((a, b) => a - b);
}

function rowOf(html: string, n: number): Row {
  const row = rowsOf(html).find((r) => numberOf(r) === n);
  expect(row, `#${n} の行`).toBeDefined();
  expect(row!.cells).toHaveLength(8);
  return row!;
}

const COL = {
  issue: 0,
  title: 1,
  column: 2,
  stage: 3,
  rejections: 4,
  objections: 5,
  pr: 6,
  updated: 7,
} as const;

const cell = (row: Row, c: keyof typeof COL) => row.cells[COL[c]]!;

/** 回数の欄（「1」か「1/3」） */
function countPattern(n: number, limit: number): RegExp {
  return new RegExp(`^${n}(\\s*/\\s*${limit})?$`);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 更新日時（この PC の時刻で、月/日 時:分） */
function stampPattern(d: Date): RegExp {
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return new RegExp(
    `((${d.getFullYear()}[/-])?0?${m}[/-]0?${day}|(${d.getFullYear()}年)?${m}月${day}日)\\s*${hm}`,
  );
}

const STAGE_WORDS = ["テスト", "実装", "CI", "レビュー", "マージ"];

/** 列の選択肢（<button>）の文と aria-pressed */
function buttonsOf(html: string): { text: string; pressed: boolean }[] {
  return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(
    (m) => ({
      text: textOf(m[2]!),
      pressed: /aria-pressed="true"/.test(m[1]!),
    }),
  );
}

function expectOption(
  html: string,
  label: string,
  count: number,
  pressed?: boolean,
) {
  const re = new RegExp(`^${label}\\s*${count}$`);
  const b = buttonsOf(html).find((x) => re.test(x.text));
  expect(b, `選択肢「${label} ${count}」`).toBeDefined();
  if (pressed !== undefined) expect(b!.pressed, label).toBe(pressed);
}

/** <a> の href */
function hrefsOf(html: string): string[] {
  return [...html.matchAll(/<a\b([^>]*)>/g)].map(
    (m) => /\bhref="([^"]*)"/.exec(m[1]!)?.[1]?.replace(/&amp;/g, "&") ?? "",
  );
}

// ---- SSE ----

type Event = { status?: unknown; tasks?: unknown };

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
  /** その内容のタスク一覧が届くまで読む */
  const waitForTasks = async (want: TasksData): Promise<Event> => {
    const json = JSON.stringify(JSON.parse(JSON.stringify(want)));
    for (;;) {
      const event = await next();
      if (JSON.stringify(event.tasks) === json) return event;
    }
  };
  return { waitForTasks };
}

describe("Issue #64: 管理画面：タスク一覧", () => {
  it("AC1: Project のすべての Issue を表で出す。列は Issue（番号）、タイトル、列、途中の段階、差し戻し、異議、PR、更新日時", async () => {
    // Given: タスク一覧を開いた（Project に 7 件の Issue がある）
    const { config, store, board } = await seed();
    const data = await loadTasks({ config, store, board });

    // When: 表示する
    const page = await render(data);

    // Then: 見出しはこの順
    expect(headersOf(page.html)).toEqual([
      "Issue",
      "タイトル",
      "列",
      "途中の段階",
      "差し戻し",
      "異議",
      "PR",
      "更新日時",
    ]);

    // Then: Project のすべての Issue を1行ずつ出す
    expect(numbersOf(page.html)).toEqual(ALL);

    // Then: 処理中の Issue（#12）の行
    const r12 = rowOf(page.html, 12);
    expect(cell(r12, "title").text).toBe("単語の一覧に並べ替えをつける");
    expect(cell(r12, "column").text).toBe("Implementing");
    expect(cell(r12, "stage").text).toContain("実装");
    expect(cell(r12, "rejections").text).toMatch(countPattern(1, 3));
    expect(cell(r12, "objections").text).toMatch(countPattern(1, 2));
    expect(cell(r12, "pr").text).not.toMatch(/#\s*\d/);
    expect(cell(r12, "updated").text).toMatch(stampPattern(at(4 * HOUR)));

    // Then: レビュー中の Issue（#30）の行（PR あり）
    const r30 = rowOf(page.html, 30);
    expect(cell(r30, "title").text).toBe("通知を送る");
    expect(cell(r30, "column").text).toBe("Reviewing");
    expect(cell(r30, "stage").text).toContain("レビュー");
    expect(cell(r30, "rejections").text).toMatch(countPattern(0, 3));
    expect(cell(r30, "objections").text).toMatch(countPattern(2, 2));
    expect(cell(r30, "pr").text).toMatch(/#\s*31\b/);
    expect(cell(r30, "updated").text).toMatch(stampPattern(at(3 * HOUR)));

    // Then: Blocked の Issue（#48）の行
    const r48 = rowOf(page.html, 48);
    expect(cell(r48, "column").text).toBe("Blocked");
    expect(cell(r48, "stage").text).toContain("テスト");
    expect(cell(r48, "updated").text).toMatch(stampPattern(at(2 * HOUR)));

    // Then: conductor の記録が無い Issue（#20）も出す。回数は 0、段階と PR は出さない
    const r20 = rowOf(page.html, 20);
    expect(cell(r20, "title").text).toBe("単語を検索する");
    expect(cell(r20, "column").text).toBe("Ready");
    for (const w of STAGE_WORDS) {
      expect(cell(r20, "stage").text).not.toContain(w);
    }
    expect(cell(r20, "rejections").text).toMatch(countPattern(0, 3));
    expect(cell(r20, "objections").text).toMatch(countPattern(0, 2));
    expect(cell(r20, "pr").text).not.toMatch(/#\s*\d/);

    // English は辞書 en の文言で出す
    const en = await render(data, { lang: "en" });
    expect(headersOf(en.html)).toEqual([
      "Issue",
      "Title",
      "Column",
      "Current stage",
      "Rejections",
      "Objections",
      "PR",
      "Updated",
    ]);
  });

  it("AC2: 列を選んで絞り込むと、その列の Issue だけを出し、選択肢ごとに件数を出す", async () => {
    // Given: Project に Issue がある
    const { config, store, board } = await seed();
    const data = await loadTasks({ config, store, board });

    // When: 「Ready」を選んで絞り込む
    const ready = await render(data, { filter: "Ready" });

    // Then: Ready の Issue だけを出す
    expect(numbersOf(ready.html)).toEqual([20, 21]);
    for (const r of rowsOf(ready.html)) {
      expect(cell(r, "column").text).toBe("Ready");
    }

    // Then: 選択肢ごとに件数を出す（Issue の無い列は 0）。選んでいる選択肢がわかる
    const want: [string, number][] = [
      ["すべて", 7],
      ["Ready", 2],
      ["Testing", 0],
      ["Implementing", 1],
      ["Reviewing", 1],
      ["Done", 2],
      ["Blocked", 1],
    ];
    for (const [label, count] of want) {
      expectOption(ready.html, label, count, label === "Ready");
    }

    // When: 「Done」を選ぶ / Then: Done の Issue だけ。件数は絞り込みで変わらない
    const done = await render(data, { filter: "Done" });
    expect(numbersOf(done.html)).toEqual([1, 3]);
    for (const [label, count] of want) {
      expectOption(done.html, label, count, label === "Done");
    }

    // When: 「すべて」を選ぶ / Then: すべての Issue
    const all = await render(data, { filter: "all" });
    expect(numbersOf(all.html)).toEqual(ALL);
    expectOption(all.html, "すべて", 7, true);
  });

  it("AC3: 検索欄に番号かタイトルの一部を入れて絞り込むと、当てはまる Issue だけを出し、なければ「該当する Issue はありません」を出す", async () => {
    // Given: Project に Issue がある
    const { config, store, board } = await seed();
    const data = await loadTasks({ config, store, board });
    const NO_RESULTS = "該当する Issue はありません";

    // When: 番号を入れる / Then: その Issue だけ
    const byNumber = await render(data, { query: "48" });
    expect(numbersOf(byNumber.html)).toEqual([48]);
    expect(byNumber.text).not.toContain(NO_RESULTS);

    // When: タイトルの一部を入れる / Then: タイトルに含む Issue だけ
    const byTitle = await render(data, { query: "単語" });
    expect(numbersOf(byTitle.html)).toEqual([12, 20]);
    expect(byTitle.text).not.toContain(NO_RESULTS);

    const byTitle2 = await render(data, { query: "画面" });
    expect(numbersOf(byTitle2.html)).toEqual([3, 21]);

    // When: 列の絞り込みと合わせる / Then: 両方に当てはまる Issue だけ
    const both = await render(data, { filter: "Ready", query: "単語" });
    expect(numbersOf(both.html)).toEqual([20]);

    // When: 当てはまらない文字を入れる / Then: 行を出さず「該当する Issue はありません」
    const none = await render(data, { query: "存在しないタイトル" });
    expect(rowsOf(none.html)).toEqual([]);
    expect(none.text).toContain(NO_RESULTS);

    const noneEn = await render(data, {
      query: "存在しないタイトル",
      lang: "en",
    });
    expect(noneEn.text).toContain("No matching issues");

    // 検索欄が空なら出さない
    expect((await render(data)).text).not.toContain(NO_RESULTS);
  });

  it("AC4: PR がマージ済みなら、PR の欄に「マージ済み」とわかる表示を出す", async () => {
    // Given: #3 の PR #5 はマージ済み、#30 の PR #31 は未マージ
    const { config, store, board } = await seed();
    const data = await loadTasks({ config, store, board });

    // When: 表示する
    const page = await render(data);

    // Then: #3 の PR の欄に PR の番号と「マージ済み」を出す
    const pr3 = cell(rowOf(page.html, 3), "pr");
    expect(pr3.text).toMatch(/#\s*5\b/);
    expect(pr3.html).toContain("マージ済み");

    // Then: 未マージの PR には出さない
    const pr30 = cell(rowOf(page.html, 30), "pr");
    expect(pr30.text).toMatch(/#\s*31\b/);
    expect(pr30.html).not.toContain("マージ済み");

    // English
    const en = await render(data, { lang: "en" });
    expect(cell(rowOf(en.html, 3), "pr").html).toContain("Merged");
    expect(cell(rowOf(en.html, 30), "pr").html).not.toContain("Merged");

    // When: PR #31 がマージされる / Then: #30 の PR の欄にも出す
    board.merged.add(31);
    const after = await render(await loadTasks({ config, store, board }));
    expect(cell(rowOf(after.html, 30), "pr").html).toContain("マージ済み");
  });

  it("AC5: 一覧の行をクリックすると、その Issue のタスク詳細（/tasks/<番号>）を開く", async () => {
    // Given: 一覧の行がある
    const { config, store, board } = await seed();
    const data = await loadTasks({ config, store, board });
    const page = await render(data);
    const rows = rowsOf(page.html);
    expect(rows).toHaveLength(ALL.length);

    // When: 行をクリックする / Then: その Issue のタスク詳細を開く（行に /tasks/<番号> へのリンクがある）
    for (const row of rows) {
      const n = numberOf(row);
      const hrefs = hrefsOf(row.html);
      expect(hrefs, `#${n}`).toContain(`/tasks/${n}`);
      for (const other of ALL.filter((x) => x !== n)) {
        expect(hrefs, `#${n} の行に #${other} のリンクは無い`).not.toContain(
          `/tasks/${other}`,
        );
      }
    }

    // タスク詳細の URL は、直接開いても画面（index.html）を返す
    const assets = await mkdtemp(join(tmpdir(), "conductor-admin-64-"));
    cleanups.push(() => rm(assets, { recursive: true, force: true }));
    await writeFile(
      join(assets, "index.html"),
      "<!doctype html><title>c</title>",
    );
    const server = await startAdminServer({
      repo: REPO,
      project: PROJECT,
      status: "idle",
      log: () => {},
      assetsDir: assets,
    });
    cleanups.push(() => server.close());
    const res = await fetch(new URL("tasks/12", server.url));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>c</title>");
  });

  it("AC6: 画面を開いているとき、Issue の列や回数が変わると、再読み込みしなくても表示が変わる", async () => {
    const { config, clock, store, board } = await seed();

    const assets = await mkdtemp(join(tmpdir(), "conductor-admin-64-"));
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

    const first = await loadTasks({ config, store, board });
    server.setTasks(first);

    // Given: 画面を開いている（開いた直後に今の内容が届く）
    const events = await openEvents(server);
    const opened = await events.waitForTasks(first);
    const shown1 = await render(opened.tasks as TasksData);
    expect(cell(rowOf(shown1.html, 20), "column").text).toBe("Ready");
    expect(cell(rowOf(shown1.html, 12), "rejections").text).toMatch(
      countPattern(1, 3),
    );
    expectOption(shown1.html, "Ready", 2);
    expectOption(shown1.html, "Testing", 0);

    // When: #20 が Testing の列に移り、#12 の差し戻しが 2 回になる
    clock.set(5 * HOUR);
    board.move(20, "Testing", iso(5 * HOUR));
    await store.update(key(12), { rejections: 2 });
    const second = await loadTasks({ config, store, board });
    server.setTasks(second);

    // Then: 再読み込みしなくても、新しい内容が届いて表示が変わる
    const pushed = await events.waitForTasks(second);
    const shown2 = await render(pushed.tasks as TasksData);
    expect(cell(rowOf(shown2.html, 20), "column").text).toBe("Testing");
    expect(cell(rowOf(shown2.html, 12), "rejections").text).toMatch(
      countPattern(2, 3),
    );
    expectOption(shown2.html, "Ready", 1);
    expectOption(shown2.html, "Testing", 1);
    expectOption(shown2.html, "すべて", 7);
  });
});

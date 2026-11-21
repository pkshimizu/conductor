/**
 * Issue #65: 管理画面：タスク詳細 の受け入れテスト
 *
 * 決めたこと（実装役はこれに合わせて作る）:
 * - タスク詳細に出す内容を集めるのは新しいモジュール `src/task-detail.ts`
 *   ```ts
 *   export interface TaskDetailDeps {
 *     config: Config;
 *     store: Store;
 *     board: TasksBoard;        // src/tasks.ts のもの（issuesByColumn・isMerged）
 *     activity: LoopActivity;   // src/loop.ts のもの（今動いている役と Issue）
 *   }
 *   /** 画面に渡す内容。JSON にできる値だけにする（SSE でそのまま送る）。number（Issue の番号）は必ず入れる。ほかの形は実装役が決めてよい *\/
 *   export type TaskDetailData = { number: number; ... };
 *   export function loadTaskDetail(deps: TaskDetailDeps, issue: number): Promise<TaskDetailData>;
 *   ```
 *   - タイトルと列は board（GitHub Projects）が正。ブランチ・PR・回数・段階・止まった理由と日時は store、
 *     経過は store.summaries（SQLite の summaries）から読む
 *   - 役が作業中かは activity.running（その Issue の番号のとき）で決める
 * - 役の結果（summary の verdict）と辞書 results の対応:
 *   approve→承認（approved）、reject→差し戻し（changes）、objection→異議、done→完了、failed→失敗、passed→成功
 *   役（summary の role）は辞書 roles の文言（tester→テスト役、implementer→実装役、ci→CI、reviewer→レビュー役、merge→マージ）
 * - 画面の配信 `src/admin-server.ts` の AdminServer に足す
 *   ```ts
 *   /** タスク詳細の内容を変える（Issue の番号ごとに最後のものを覚える）。開いている画面に SSE で push する *\/
 *   setTaskDetail(data: TaskDetailData): void;
 *   ```
 *   SSE の1件は `{ status, repo, project, dashboard, tasks, details }`。
 *   details は Issue の番号（文字列）をキーにした、最後に setTaskDetail したもの。画面を開いた直後の1件にも入れる
 * - 画面は `web/src/TaskDetail.tsx`
 *   ```ts
 *   export interface TaskDetailProps {
 *     data: TaskDetailData;
 *     lang: "ja" | "en";
 *     /** 今の時刻（作業中の経過時間などに使ってよい） *\/
 *     now: Date;
 *     /** 経過の並び順 *\/
 *     order: "newest" | "oldest";
 *     /** 全文を出している経過。記録した順の番号（0 がいちばん古い記録）。並び順を変えても同じ番号 *\/
 *     expanded: number[];
 *     onOrder?: (order: "newest" | "oldest") => void;
 *     onToggle?: (index: number) => void;
 *     onNavigate?: (path: string) => void;
 *   }
 *   export function TaskDetail(props: TaskDetailProps): ReactElement;
 *   ```
 *   ブラウザの globals に触らずに react-dom/server で描けること。
 *   - 「タスク一覧へ戻る」は `<a href="/tasks">`、「GitHub で開く」は `<a href="https://github.com/<repo>/issues/<番号>">`、
 *     PR は `<a href="https://github.com/<repo>/pull/<PR>">#21</a>`
 *   - 進み具合はダッシュボードと同じ `<ol aria-label="進み具合">` に5つの `<li>`（テスト→実装→CI→レビュー→マージ）。
 *     今の段階（Blocked なら止まった段階）の `<li>` に aria-current="step"
 *   - 経過は1件ずつ `<article>`（デザインどおり）。並び順の選択は `<button>`（「新しい順」「古い順」）で、
 *     選んでいるほうに aria-pressed="true"
 *   - 長い要約（デザインと同じく、180 文字より長いか 5 行以上）は、畳んでいるときは途中までの文だけを出し（全文を HTML に入れない）、
 *     `<button aria-expanded="false">続きを表示</button>` を置く。開いているときは全文と `<button aria-expanded="true">折りたたむ</button>`。
 *     短い要約にはこのボタンを置かない
 *   - 作業中の案内（作業中・作業中の出力は表示しません…）は `<article>` にしない
 *
 * seed: 記録は MemoryStore（時刻は進められる Clock）、GitHub は列ごとの Issue と、マージ済みの PR を覚えるだけの偽物。
 * ネットワークには出ない（AC7 の SSE だけ 127.0.0.1 につなぐ）。
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
import type { LoopActivity } from "../loop.js";
import {
  type Clock,
  type IssueKey,
  MemoryStore,
  type Store,
} from "../store.js";
import { type TaskDetailData, loadTaskDetail } from "../task-detail.js";
import type { TaskIssue } from "../tasks.js";

// ---- seed ----

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REPO = "pkshimizu/wordcards";
const PROJECT = 3;
const START = Date.parse("2026-11-20T02:28:00.000Z");
const MIN = 60_000;
const HOUR = 3_600_000;

const at = (ms: number) => new Date(START + ms);
const key = (issue: number): IssueKey => ({ repo: REPO, issue });
const issueUrl = (n: number) => `https://github.com/${REPO}/issues/${n}`;
const pullUrl = (n: number) => `https://github.com/${REPO}/pull/${n}`;

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
}

const ACTIVE = 12;
const ACTIVE_TITLE = "単語の一覧に並べ替えをつける";
const BLOCKED = 48;
const BLOCKED_TITLE = "書き出しをつける";
const BLOCKED_REASON = "受け入れ条件が曖昧です。書き出す形式を教えてください。";
const READY = 20;
const READY_TITLE = "単語を検索する";

/** 長い要約（180 文字より長い） */
const LONG_TEXT = Array.from(
  { length: 30 },
  (_, i) => `手順${i + 1}を確かめました。`,
).join("");
const LONG_HEAD = "手順1を確かめました。手順2を確かめました。";
const LONG_TAIL = "手順30を確かめました。";

/** #12 の経過（記録した順）。結果の文言が要約に混ざらないようにしてある */
const TIMELINE = [
  {
    role: "tester",
    verdict: "approve",
    text: "受け入れテストを3件書きました",
    roleLabel: "テスト役",
    result: "承認",
  },
  {
    role: "implementer",
    verdict: "objection",
    text: "AC2 の並び順の決め方が読み取れません",
    roleLabel: "実装役",
    result: "異議",
  },
  {
    role: "ci",
    verdict: "failed",
    text: "型の検査で2件の誤りがありました",
    roleLabel: "CI",
    result: "失敗",
  },
  {
    role: "reviewer",
    verdict: "reject",
    text: LONG_TEXT,
    roleLabel: "レビュー役",
    result: "差し戻し",
  },
  {
    role: "ci",
    verdict: "passed",
    text: "すべての検査を通りました",
    roleLabel: "CI",
    result: "成功",
  },
  {
    role: "merge",
    verdict: "done",
    text: "main に取り込みました",
    roleLabel: "マージ",
    result: "完了",
  },
] as const;
/** 記録した時刻（記録した順） */
const TIMELINE_AT = TIMELINE.map((_, i) => (i + 1) * 7 * MIN);
const LONG_INDEX = 3;
const RESULT_WORDS = ["承認", "差し戻し", "異議", "完了", "失敗", "成功"];

interface Seeded {
  config: Config;
  clock: ReturnType<typeof fixedClock>;
  store: Store;
  board: FakeBoard;
}

/**
 * Project の Issue:
 * - #12 Implementing（実装の段階、ブランチあり、PR #21、差し戻し 1・異議 1）。経過は TIMELINE を入れるかどうか選べる
 * - #48 Blocked（テストの段階で止まった。止まった理由あり、経過なし）
 * - #20 Ready（conductor の記録なし・経過なし）
 */
async function seed(options: { timeline?: boolean } = {}): Promise<Seeded> {
  const config = makeConfig();
  const clock = fixedClock();
  const store = new MemoryStore(clock);

  await store.update(key(ACTIVE), {
    branch: `conductor/issue-${ACTIVE}`,
    pr: 21,
    rejections: 1,
    objections: 1,
    checkpoint: { stage: "testing" },
  });
  if (options.timeline !== false) {
    for (const [i, s] of TIMELINE.entries()) {
      clock.set(TIMELINE_AT[i]!);
      await store.addSummary(key(ACTIVE), {
        role: s.role,
        verdict: s.verdict,
        text: s.text,
      });
    }
  }
  clock.set(1 * HOUR);
  await store.update(key(ACTIVE), { checkpoint: { stage: "implementing" } });

  clock.set(2 * HOUR);
  await store.update(key(BLOCKED), {
    branch: `conductor/issue-${BLOCKED}`,
    checkpoint: { stage: "testing" },
    blockedReason: BLOCKED_REASON,
  });

  const issue = (n: number, title: string): TaskIssue => ({
    number: n,
    title,
    body: "本文",
  });
  const board = new FakeBoard({
    Ready: [issue(READY, READY_TITLE)],
    Testing: [],
    Implementing: [issue(ACTIVE, ACTIVE_TITLE)],
    Reviewing: [],
    Done: [],
    Blocked: [issue(BLOCKED, BLOCKED_TITLE)],
  });
  clock.set(3 * HOUR);
  return { config, clock, store, board };
}

const IDLE: LoopActivity = {};
const WORKING: LoopActivity = {
  running: { issue: ACTIVE, role: "implementer" },
};

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

// ---- 画面のソース（src の外にあるので、実行時に import する） ----

type Lang = "ja" | "en";
type Order = "newest" | "oldest";

interface TaskDetailProps {
  data: TaskDetailData;
  lang: Lang;
  now: Date;
  order: Order;
  expanded: number[];
  onOrder?: (order: Order) => void;
  onToggle?: (index: number) => void;
  onNavigate?: (path: string) => void;
}

interface TaskDetailModule {
  TaskDetail: ComponentType<TaskDetailProps>;
}

async function render(
  data: TaskDetailData,
  options: { order?: Order; expanded?: number[]; lang?: Lang } = {},
) {
  const url = pathToFileURL(join(ROOT, "web", "src", "TaskDetail.tsx")).href;
  const { TaskDetail } = (await import(
    /* @vite-ignore */ url
  )) as TaskDetailModule;
  // 画面には SSE（JSON）で届くので、JSON を通したものを描く
  const sent = JSON.parse(JSON.stringify(data)) as TaskDetailData;
  const html = renderToStaticMarkup(
    createElement(TaskDetail, {
      data: sent,
      lang: options.lang ?? "ja",
      now: at(3 * HOUR),
      order: options.order ?? "newest",
      expanded: options.expanded ?? [],
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

/** 空白を除いた文（要約の全文が入っているかを比べる） */
const squash = (s: string) => s.replace(/\s+/g, "");

/** <a> の href と文 */
function links(html: string): { href: string; text: string }[] {
  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({
    href: /\bhref="([^"]*)"/.exec(m[1]!)?.[1]?.replace(/&amp;/g, "&") ?? "",
    text: textOf(m[2]!),
  }));
}

/** <button> の属性と文 */
function buttons(html: string): { attrs: string; text: string }[] {
  return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(
    (m) => ({ attrs: m[1]!, text: textOf(m[2]!) }),
  );
}

/** 経過の1件ずつ（<article>） */
function articles(html: string): { html: string; text: string }[] {
  return [...html.matchAll(/<article\b[\s\S]*?<\/article>/g)].map((m) => ({
    html: m[0],
    text: textOf(m[0]),
  }));
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

/** 日時（この PC の時刻で、月/日 時:分） */
function stampPattern(d: Date): RegExp {
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return new RegExp(
    `((${d.getFullYear()}[/-])?0?${m}[/-]0?${day}|(${d.getFullYear()}年)?${m}月${day}日)\\s*${hm}`,
  );
}

/** 経過の <article> に出ている要約の、記録した順の番号（並んでいる順） */
function orderOf(html: string): number[] {
  return articles(html).map((a) => {
    const i = TIMELINE.findIndex((s) =>
      squash(a.text).includes(squash(s.text).slice(0, 12)),
    );
    expect(i, `経過「${a.text}」`).toBeGreaterThanOrEqual(0);
    return i;
  });
}

const WORKING_NOTE =
  "作業中の出力は表示しません。終わると結果がここに並びます。";
const NO_TIMELINE = "まだ経過はありません。";

// ---- SSE ----

type Event = { details?: Record<string, unknown> };

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
  /** その内容のタスク詳細が届くまで読む */
  const waitForDetail = async (
    want: TaskDetailData,
  ): Promise<TaskDetailData> => {
    const json = JSON.stringify(JSON.parse(JSON.stringify(want)));
    for (;;) {
      const event = await next();
      const got = event.details?.[String(want.number)];
      if (JSON.stringify(got) === json) return got as TaskDetailData;
    }
  };
  return { waitForDetail };
}

describe("Issue #65: 管理画面：タスク詳細", () => {
  it("AC1: 番号、タイトル、列、ブランチ、PR、差し戻しと異議の回数、「GitHub で開く」、「タスク一覧へ戻る」を出す", async () => {
    // Given: タスク詳細（/tasks/12）を開いた
    const { config, store, board } = await seed();
    const data = await loadTaskDetail(
      { config, store, board, activity: IDLE },
      ACTIVE,
    );
    expect(data.number).toBe(ACTIVE);

    // When: 表示する
    const page = await render(data);

    // Then: 番号、タイトル、列、ブランチ、PR、回数
    expect(page.text).toMatch(/#\s*12\b/);
    expect(page.text).toContain(ACTIVE_TITLE);
    expect(page.text).toContain("Implementing");
    expect(page.text).toMatch(/ブランチ\s*conductor\/issue-12/);
    expect(page.text).toMatch(/PR\s*#\s*21\b/);
    expect(page.text).toMatch(/差し戻し\s*1(\s*\/\s*3)?(?!\d)/);
    expect(page.text).toMatch(/異議\s*1(\s*\/\s*2)?(?!\d)/);

    // Then: PR・「GitHub で開く」・「タスク一覧へ戻る」のリンク
    const list = links(page.html);
    expect(
      list.some((l) => l.href === pullUrl(21) && /#\s*21\b/.test(l.text)),
      "PR #21 のリンク",
    ).toBe(true);
    expect(
      list.some(
        (l) => l.href === issueUrl(ACTIVE) && l.text.includes("GitHub で開く"),
      ),
      "「GitHub で開く」",
    ).toBe(true);
    expect(
      list.some(
        (l) => l.href === "/tasks" && l.text.includes("タスク一覧へ戻る"),
      ),
      "「タスク一覧へ戻る」",
    ).toBe(true);

    // conductor の記録が無い Issue（#20）も、番号・タイトル・列・回数 0 を出す
    const ready = await render(
      await loadTaskDetail({ config, store, board, activity: IDLE }, READY),
    );
    expect(ready.text).toMatch(/#\s*20\b/);
    expect(ready.text).toContain(READY_TITLE);
    expect(ready.text).toContain("Ready");
    expect(ready.text).toMatch(/差し戻し\s*0(\s*\/\s*3)?(?!\d)/);
    expect(ready.text).toMatch(/異議\s*0(\s*\/\s*2)?(?!\d)/);
    expect(
      links(ready.html).some(
        (l) => l.href === issueUrl(READY) && l.text.includes("GitHub で開く"),
      ),
    ).toBe(true);

    // English は辞書 en の文言で出す
    const en = await render(data, { lang: "en" });
    expect(
      links(en.html).some(
        (l) => l.href === "/tasks" && l.text.includes("Back to tasks"),
      ),
    ).toBe(true);
    expect(
      links(en.html).some(
        (l) => l.href === issueUrl(ACTIVE) && l.text.includes("Open on GitHub"),
      ),
    ).toBe(true);
  });

  it("AC2: 処理中または Blocked の Issue の段階を「テスト→実装→CI→レビュー→マージ」の形で出し、Blocked ならどの段階で止まったかと止まった理由を出す", async () => {
    const { config, store, board } = await seed();

    // Given: 処理中の Issue（#12、実装の段階） / When: 表示する
    const active = await render(
      await loadTaskDetail({ config, store, board, activity: WORKING }, ACTIVE),
    );
    // Then: 進み具合の5段階を出し、今の段階は「実装」
    expectProgress(active.html, "実装");
    expect(active.text).not.toContain(BLOCKED_REASON);

    // Given: Blocked の Issue（#48、テストの段階で止まった） / When: 表示する
    const blocked = await render(
      await loadTaskDetail({ config, store, board, activity: IDLE }, BLOCKED),
    );
    // Then: 止まった段階が「テスト」とわかり、止まった理由と止まった日時を出す
    expectProgress(blocked.html, "テスト");
    expect(blocked.text).toContain("Blocked");
    expect(blocked.text).toContain(BLOCKED_REASON);
    expect(blocked.text).toContain("止まった日時");
    expect(blocked.text).toMatch(stampPattern(at(2 * HOUR)));
  });

  it("AC3: 「経過」に、役、結果、要約、時刻を並べ、並び順は「新しい順」「古い順」を切り替えられる", async () => {
    // Given: 役の結果の記録（summaries）がある
    const { config, store, board } = await seed();
    const data = await loadTaskDetail(
      { config, store, board, activity: IDLE },
      ACTIVE,
    );

    // When: 表示する（新しい順）
    const page = await render(data, { order: "newest" });

    // Then: 「経過」の見出しと、並び順の選択肢を出す
    expect(page.text).toContain("経過");
    const newest = buttons(page.html).find((b) => b.text === "新しい順");
    const oldest = buttons(page.html).find((b) => b.text === "古い順");
    expect(newest, "「新しい順」").toBeDefined();
    expect(oldest, "「古い順」").toBeDefined();
    expect(newest!.attrs).toMatch(/aria-pressed="true"/);
    expect(oldest!.attrs).not.toMatch(/aria-pressed="true"/);

    // Then: 1件ずつ、役・結果・要約・時刻を出す
    const list = articles(page.html);
    expect(list).toHaveLength(TIMELINE.length);
    expect(orderOf(page.html)).toEqual([5, 4, 3, 2, 1, 0]);
    for (const [i, s] of TIMELINE.entries()) {
      const a = list[TIMELINE.length - 1 - i]!;
      expect(a.text, s.text).toContain(s.roleLabel);
      expect(a.text, s.text).toContain(s.result);
      for (const other of RESULT_WORDS.filter((w) => w !== s.result)) {
        expect(a.text, `${s.text} に「${other}」は出さない`).not.toContain(
          other,
        );
      }
      expect(a.text, s.text).toMatch(stampPattern(at(TIMELINE_AT[i]!)));
      if (i !== LONG_INDEX) expect(a.text).toContain(s.text);
    }

    // When: 「古い順」に切り替える / Then: 記録した順に並ぶ
    const asc = await render(data, { order: "oldest" });
    expect(orderOf(asc.html)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(buttons(asc.html).find((b) => b.text === "古い順")!.attrs).toMatch(
      /aria-pressed="true"/,
    );
    expect(
      buttons(asc.html).find((b) => b.text === "新しい順")!.attrs,
    ).not.toMatch(/aria-pressed="true"/);

    // English は辞書 en の文言で出す
    const en = await render(data, { lang: "en" });
    expect(en.text).toContain("Timeline");
    expect(buttons(en.html).some((b) => b.text === "Newest first")).toBe(true);
    expect(buttons(en.html).some((b) => b.text === "Oldest first")).toBe(true);
    for (const w of [
      "Approved",
      "Changes requested",
      "Objection",
      "Done",
      "Failed",
      "Passed",
    ]) {
      expect(
        articles(en.html).some((a) => a.text.includes(w)),
        w,
      ).toBe(true);
    }
  });

  it("AC4: 長い要約は途中まで出し、「続きを表示」で全文、「折りたたむ」で元に戻す", async () => {
    // Given: 要約が長い記録がある（レビュー役の差し戻し）
    const { config, store, board } = await seed();
    const data = await loadTaskDetail(
      { config, store, board, activity: IDLE },
      ACTIVE,
    );
    const longOf = (html: string) => {
      const a = articles(html).find((x) =>
        squash(x.text).includes(squash(LONG_HEAD)),
      );
      expect(a, "長い要約の経過").toBeDefined();
      return a!;
    };
    const shortOf = (html: string) =>
      articles(html).find((x) => x.text.includes(TIMELINE[0].text))!;

    // When: 表示する（畳んでいる）
    const folded = longOf((await render(data)).html);
    // Then: 途中まで出し、「続きを表示」を置く
    expect(squash(folded.text)).not.toContain(squash(LONG_TAIL));
    const more = buttons(folded.html);
    expect(more.map((b) => b.text)).toContain("続きを表示");
    expect(more.find((b) => b.text === "続きを表示")!.attrs).toMatch(
      /aria-expanded="false"/,
    );

    // When: 「続きを表示」を押す / Then: 全文を出し、「折りたたむ」を置く
    const opened = longOf(
      (await render(data, { expanded: [LONG_INDEX] })).html,
    );
    expect(squash(opened.text)).toContain(squash(LONG_TEXT));
    const less = buttons(opened.html);
    expect(less.map((b) => b.text)).toContain("折りたたむ");
    expect(less.map((b) => b.text)).not.toContain("続きを表示");
    expect(less.find((b) => b.text === "折りたたむ")!.attrs).toMatch(
      /aria-expanded="true"/,
    );

    // 並び順を変えても、同じ記録を開いている
    const openedAsc = longOf(
      (await render(data, { order: "oldest", expanded: [LONG_INDEX] })).html,
    );
    expect(squash(openedAsc.text)).toContain(squash(LONG_TEXT));

    // When: 「折りたたむ」を押す / Then: 元に戻る
    const refolded = longOf((await render(data, { expanded: [] })).html);
    expect(squash(refolded.text)).not.toContain(squash(LONG_TAIL));
    expect(buttons(refolded.html).map((b) => b.text)).toContain("続きを表示");

    // 短い要約は全文を出し、ボタンを置かない
    const short = shortOf((await render(data)).html);
    expect(short.text).toContain(TIMELINE[0].text);
    expect(buttons(short.html)).toEqual([]);

    // English
    const en = longOf((await render(data, { lang: "en" })).html);
    expect(buttons(en.html).map((b) => b.text)).toContain("Show more");
    const enOpen = longOf(
      (await render(data, { lang: "en", expanded: [LONG_INDEX] })).html,
    );
    expect(buttons(enOpen.html).map((b) => b.text)).toContain("Show less");
  });

  it("AC5: 役が作業中なら「作業中」と、作業中の出力は出さない旨の案内を出す", async () => {
    // Given: #12 の実装役が作業中
    const { config, store, board } = await seed();
    const data = await loadTaskDetail(
      { config, store, board, activity: WORKING },
      ACTIVE,
    );

    // When: 表示する
    const page = await render(data);

    // Then: 「作業中」と案内を出す。経過は記録の分だけ（作業中の分を経過にしない）
    expect(page.text).toContain(WORKING_NOTE);
    expect(page.text.replace(WORKING_NOTE, "")).toContain("作業中");
    expect(articles(page.html)).toHaveLength(TIMELINE.length);
    for (const a of articles(page.html)) {
      expect(a.text).not.toContain(WORKING_NOTE);
    }
    // 古い順でも出す
    expect((await render(data, { order: "oldest" })).text).toContain(
      WORKING_NOTE,
    );

    // 記録がまだ無くても、作業中なら「まだ経過はありません。」ではなく作業中を出す
    const fresh = await seed({ timeline: false });
    const first = await render(
      await loadTaskDetail(
        {
          config: fresh.config,
          store: fresh.store,
          board: fresh.board,
          activity: WORKING,
        },
        ACTIVE,
      ),
    );
    expect(first.text).toContain(WORKING_NOTE);
    expect(first.text).not.toContain(NO_TIMELINE);

    // 作業中でなければ（別の Issue が動いている・何も動いていない）出さない
    for (const activity of [
      IDLE,
      { running: { issue: BLOCKED, role: "tester" } } satisfies LoopActivity,
    ]) {
      const idle = await render(
        await loadTaskDetail({ config, store, board, activity }, ACTIVE),
      );
      expect(idle.text).not.toContain(WORKING_NOTE);
    }

    // English
    const en = await render(data, { lang: "en" });
    expect(en.text).toContain("Working");
    expect(en.text).toContain(
      "Output from a running role is not shown. Its result appears here when it finishes.",
    );
  });

  it("AC6: 記録がないとき、「まだ経過はありません。」を出す", async () => {
    // Given: 記録がない（#20 は conductor の記録も経過も無い、#48 は経過が無い）
    const { config, store, board } = await seed();

    for (const n of [READY, BLOCKED]) {
      // When: 表示する
      const page = await render(
        await loadTaskDetail({ config, store, board, activity: IDLE }, n),
      );
      // Then: 「まだ経過はありません。」を出し、経過は並べない
      expect(page.text, `#${n}`).toContain(NO_TIMELINE);
      expect(articles(page.html), `#${n}`).toEqual([]);
    }

    // 記録があれば出さない
    const active = await render(
      await loadTaskDetail({ config, store, board, activity: IDLE }, ACTIVE),
    );
    expect(active.text).not.toContain(NO_TIMELINE);

    // English
    const en = await render(
      await loadTaskDetail({ config, store, board, activity: IDLE }, READY),
      { lang: "en" },
    );
    expect(en.text).toContain("Nothing has happened yet.");
  });

  it("AC7: 画面を開いているとき、役の結果が増えると、再読み込みしなくても表示が変わる", async () => {
    const { config, clock, store, board } = await seed({ timeline: false });

    const assets = await mkdtemp(join(tmpdir(), "conductor-admin-65-"));
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

    // タスク詳細の URL は、直接開いても画面（index.html）を返す
    const res = await fetch(new URL(`tasks/${ACTIVE}`, server.url));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>c</title>");

    const first = await loadTaskDetail(
      { config, store, board, activity: IDLE },
      ACTIVE,
    );
    server.setTaskDetail(first);

    // Given: 画面を開いている（開いた直後に今の内容が届く。まだ経過は無い）
    const events = await openEvents(server);
    const shown1 = await render(await events.waitForDetail(first));
    expect(shown1.text).toContain(NO_TIMELINE);
    expect(articles(shown1.html)).toEqual([]);

    // When: 役の結果が増える（テスト役が承認）
    clock.set(4 * HOUR);
    await store.addSummary(key(ACTIVE), {
      role: "tester",
      verdict: "approve",
      text: TIMELINE[0].text,
    });
    const second = await loadTaskDetail(
      { config, store, board, activity: IDLE },
      ACTIVE,
    );
    server.setTaskDetail(second);

    // Then: 再読み込みしなくても、新しい内容が届いて表示が変わる
    const shown2 = await render(await events.waitForDetail(second));
    expect(shown2.text).not.toContain(NO_TIMELINE);
    const list = articles(shown2.html);
    expect(list).toHaveLength(1);
    expect(list[0]!.text).toContain("テスト役");
    expect(list[0]!.text).toContain("承認");
    expect(list[0]!.text).toContain(TIMELINE[0].text);
    expect(list[0]!.text).toMatch(stampPattern(at(4 * HOUR)));

    // When: さらに増える（実装役が異議） / Then: それも届く
    clock.set(5 * HOUR);
    await store.addSummary(key(ACTIVE), {
      role: "implementer",
      verdict: "objection",
      text: TIMELINE[1].text,
    });
    const third = await loadTaskDetail(
      { config, store, board, activity: IDLE },
      ACTIVE,
    );
    server.setTaskDetail(third);
    const shown3 = await render(await events.waitForDetail(third), {
      order: "oldest",
    });
    expect(orderOf(shown3.html)).toEqual([0, 1]);
  });
});

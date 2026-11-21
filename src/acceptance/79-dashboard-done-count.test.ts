/**
 * Issue #79: ダッシュボードの「列ごとの件数」で Done が 0 になる
 *
 * 決めたこと（実装役はこれに合わせる）:
 * - ダッシュボードには本物の GitHub（src/github.ts の GitHub。gh は偽物の Exec に差し替える）を
 *   そのまま board として渡す。src/start.ts でもダッシュボードの board は GitHub のままにする。
 *   閉じた Issue を含めて取るのは、ダッシュボードの側（loadDashboard）で行う
 *   （例：board.issuesByColumn({ includeClosed: true })。DashboardBoard の型は引数を受けられるようにする）。
 *   既存のテストの偽物（引数を見ずにすべて返す board）でも、今と同じように動くこと。
 * - 開いているかどうかは、GitHub の Issue の state（"OPEN" / "CLOSED"）から ProjectIssue に載せる。
 *   載せ方（項目の名前）は実装役が決めてよい。このテストは GitHub が返す state だけを seed する。
 *   開いているかどうかの項目が無い Issue（既存のテストの偽物）は、開いているものとして扱う。
 * - 「更新1回」は dashboardRefresher の update 1回。そのときの Projects の項目の問い合わせ
 *   （ITEMS の GraphQL）は1ページにつき1回のまま（今と同じ）。
 */
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { type ComponentType, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { type Config, parseConfig } from "../config.js";
import { type DashboardData, loadDashboard } from "../dashboard.js";
import type { Exec, ExecResult } from "../exec.js";
import { GitHub } from "../github.js";
import { dashboardRefresher, tasksBoard } from "../start.js";
import { type IssueKey, MemoryStore, type Store } from "../store.js";
import { loadTasks } from "../tasks.js";

// ---- seed ----

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REPO = "pkshimizu/wordcards";
const OWNER = "pkshimizu";
const PROJECT = 3;
const NOW = new Date("2026-11-21T03:00:00.000Z");
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

/** GitHub Projects にある Issue の seed（列と開閉） */
interface SeedItem {
  number: number;
  title?: string;
  column: string | null;
  state: "OPEN" | "CLOSED";
}

const open = (number: number, column: string, title?: string): SeedItem => ({
  number,
  column,
  state: "OPEN",
  ...(title === undefined ? {} : { title }),
});
const closed = (number: number, column: string, title?: string): SeedItem => ({
  number,
  column,
  state: "CLOSED",
  ...(title === undefined ? {} : { title }),
});

const ok = (data: unknown): ExecResult => ({
  code: 0,
  stdout: JSON.stringify(data),
  stderr: "",
});

const COLUMNS = [
  "Ready",
  "Testing",
  "Implementing",
  "Reviewing",
  "Done",
  "Blocked",
];

/**
 * gh の偽物。Projects の設定と、Projects の項目（items）を答える。
 * 開いた Issue だけに絞るのは本物の GitHub（src/github.ts）の仕事なので、偽物はすべての項目を返す。
 * Projects の項目の問い合わせの回数を数える
 */
function fakeGitHub(items: SeedItem[]) {
  let itemQueries = 0;
  const exec: Exec = (_args, { input }) => {
    const { query, variables } = JSON.parse(input ?? "{}") as {
      query: string;
      variables: Record<string, unknown>;
    };
    if (query.includes("projectV2(number")) {
      if (!query.includes("user(")) {
        return Promise.resolve(ok({ data: { organization: null } }));
      }
      return Promise.resolve(
        ok({
          data: {
            user: {
              projectV2: {
                id: "P1",
                field: {
                  id: "F1",
                  options: COLUMNS.map((name) => ({ id: `o-${name}`, name })),
                },
              },
            },
          },
        }),
      );
    }
    if (query.includes("node(id") && query.includes("items(first")) {
      expect(variables.id).toBe("P1");
      itemQueries++;
      return Promise.resolve(
        ok({
          data: {
            node: {
              items: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: items.map((i) => ({
                  fieldValueByName:
                    i.column === null ? null : { name: i.column },
                  content: {
                    number: i.number,
                    title: i.title ?? `Issue ${i.number}`,
                    body: "本文",
                    state: i.state,
                    updatedAt: "2026-11-20T00:00:00Z",
                    repository: { nameWithOwner: REPO },
                    labels: { nodes: [] },
                  },
                })),
              },
            },
          },
        }),
      );
    }
    throw new Error(`想定外の gh の呼び出し: ${query.slice(0, 80)}`);
  };
  const github = new GitHub({
    repo: REPO,
    project: PROJECT,
    notify: "someone",
    exec,
  });
  expect(github.owner).toBe(OWNER);
  return { github, itemQueries: () => itemQueries };
}

/** 2026-11-21 時点のボード：Done に閉じた Issue が 19 件ある */
function seedBoard(): SeedItem[] {
  const done = Array.from({ length: 19 }, (_, i) => closed(i + 1, "Done"));
  return [
    ...done,
    open(20, "Ready"),
    open(21, "Ready"),
    open(12, "Implementing", "単語の一覧に並べ替えをつける"),
    open(51, "Blocked", "単語を読み上げる"),
  ];
}

function countsOf(data: DashboardData): Record<string, number> {
  return Object.fromEntries(data.counts.map((c) => [c.column, c.count]));
}

async function dashboard(
  github: GitHub,
  store: Store = new MemoryStore(() => NOW),
): Promise<DashboardData> {
  return loadDashboard({
    config: makeConfig(),
    store,
    board: github,
    status: "running",
    activity: {
      lastCheckedAt: NOW.toISOString(),
      nextCheckAt: new Date(NOW.getTime() + 30_000).toISOString(),
    },
  });
}

// ---- 画面（src の外にあるので、実行時に import する） ----

interface DashboardModule {
  Dashboard: ComponentType<{ data: DashboardData; lang: "ja"; now: Date }>;
}

async function render(data: DashboardData): Promise<string> {
  const url = pathToFileURL(join(ROOT, "web", "src", "Dashboard.tsx")).href;
  const { Dashboard } = (await import(
    /* @vite-ignore */ url
  )) as DashboardModule;
  const sent = JSON.parse(JSON.stringify(data)) as DashboardData;
  return renderToStaticMarkup(
    createElement(Dashboard, { data: sent, lang: "ja", now: NOW }),
  );
}

function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function sectionOf(html: string, title: string): string | undefined {
  const sections = html.match(/<section\b[\s\S]*?<\/section>/g) ?? [];
  const s = sections.find((x) => textOf(x).includes(title));
  return s === undefined ? undefined : textOf(s);
}

describe("Issue #79: ダッシュボードの「列ごとの件数」で Done が 0 になる", () => {
  it("AC1: Done 列に閉じた Issue があれば、「列ごとの件数」の Done に閉じた Issue も含めた件数が出る", async () => {
    // Given: Done 列に閉じた Issue が 19 件ある
    const { github } = fakeGitHub(seedBoard());

    // When: ダッシュボードを開く
    const data = await dashboard(github);

    // Then: Done の件数は 19
    expect(countsOf(data).Done).toBe(19);
    const counts = sectionOf(await render(data), "列ごとの件数");
    expect(counts, "「列ごとの件数」の欄").toBeDefined();
    expect(counts).toMatch(/Done\s*19(?!\d)/);
  });

  it("AC2: 同じ時点の GitHub Projects なら、「列ごとの件数」の各列の件数がタスク一覧（/tasks）の各列の件数と同じになる", async () => {
    // Given: 同じ時点の GitHub Projects（閉じた Issue が Done と Blocked にもある）
    const items = [
      ...seedBoard(),
      closed(30, "Blocked"),
      closed(31, "Reviewing"),
      open(32, "Testing"),
    ];
    const { github } = fakeGitHub(items);
    const config = makeConfig();
    const store = new MemoryStore(() => NOW);

    // When: ダッシュボードとタスク一覧を開く
    const data = await dashboard(github, store);
    const tasks = await loadTasks({
      config,
      store,
      board: tasksBoard(github),
    });

    // Then: 各列の件数が同じ
    const taskCounts = Object.fromEntries(
      tasks.columns.map((column) => [
        column,
        tasks.issues.filter((i) => i.column === column).length,
      ]),
    );
    expect(countsOf(data)).toEqual(taskCounts);
    expect(countsOf(data)).toEqual({
      Ready: 2,
      Testing: 1,
      Implementing: 1,
      Reviewing: 1,
      Done: 19,
      Blocked: 2,
    });
  });

  it("AC3: Blocked 列に閉じた Issue と開いている Issue があれば、「人の判断を待っています」には開いている Issue だけが出る", async () => {
    // Given: Blocked 列に、閉じた #48 と開いている #51 がある（どちらも止まった記録がある）
    const { github } = fakeGitHub([
      closed(48, "Blocked", "単語帳を書き出す"),
      open(51, "Blocked", "単語を読み上げる"),
      open(20, "Ready"),
    ]);
    const store = new MemoryStore(() => NOW);
    await store.update(key(48), {
      blockedReason: "受け入れ条件が曖昧です。",
      checkpoint: { stage: "testing" },
    });
    await store.update(key(51), {
      blockedReason: "3 回続けて失敗しました",
      checkpoint: { stage: "reviewing" },
    });

    // When: ダッシュボードを開く
    const data = await dashboard(github, store);

    // Then: 判断待ちは #51 だけ（件数の Blocked は閉じた Issue も含めて 2）
    expect(data.blocked.map((b) => b.number)).toEqual([51]);
    expect(countsOf(data).Blocked).toBe(2);
    const blocked = sectionOf(await render(data), "人の判断を待っています");
    expect(blocked, "「人の判断を待っています」の欄").toBeDefined();
    expect(blocked).toContain("単語を読み上げる");
    expect(blocked).not.toContain("単語帳を書き出す");
    expect(blocked).not.toMatch(/#48(?!\d)/);
  });

  it("AC4: Ready・Testing・Implementing・Reviewing 列に Issue があっても、「処理中の Issue」と「Ready の Issue を待っています」の表示は今と変わらない（閉じた Issue を処理中として出さない）", async () => {
    // Given: 作業の列に閉じた Issue（番号が小さい）と開いている Issue がある
    const store = new MemoryStore(() => NOW);
    await store.update(key(5), { checkpoint: { stage: "testing" } });
    await store.update(key(12), {
      branch: "conductor/issue-12",
      checkpoint: { stage: "implementing" },
    });
    const openOnly = [
      open(20, "Ready"),
      open(12, "Implementing", "単語の一覧に並べ替えをつける"),
      open(15, "Reviewing", "単語に例文をつける"),
    ];
    const withClosed = [
      ...openOnly,
      closed(5, "Testing", "閉じたテストの Issue"),
      closed(8, "Implementing", "閉じた実装の Issue"),
      closed(9, "Reviewing", "閉じたレビューの Issue"),
      closed(3, "Ready", "閉じた Ready の Issue"),
    ];

    // When: ダッシュボードを開く
    const before = await dashboard(fakeGitHub(openOnly).github, store);
    const after = await dashboard(fakeGitHub(withClosed).github, store);

    // Then: 処理中の Issue は、開いている Issue だけで決めたものと同じ（#12）
    expect(after.active?.number).toBe(12);
    expect(after.active).toEqual(before.active);
    const active = sectionOf(await render(after), "処理中の Issue");
    expect(active, "「処理中の Issue」の欄").toBeDefined();
    expect(active).toContain("単語の一覧に並べ替えをつける");
    expect(active).not.toContain("閉じた");

    // Given: 作業の列には閉じた Issue しかない
    const onlyClosedWork = [
      open(20, "Ready"),
      closed(5, "Testing", "閉じたテストの Issue"),
      closed(8, "Implementing", "閉じた実装の Issue"),
      closed(9, "Reviewing", "閉じたレビューの Issue"),
    ];
    // When: ダッシュボードを開く
    const idle = await dashboard(fakeGitHub(onlyClosedWork).github, store);
    const idleBefore = await dashboard(
      fakeGitHub([open(20, "Ready")]).github,
      store,
    );
    // Then: 処理中の Issue は無く、「Ready の Issue を待っています」が出る（開いた Issue だけのときと同じ）
    expect(idle.active).toBeUndefined();
    expect(idleBefore.active).toBeUndefined();
    const html = await render(idle);
    expect(textOf(html)).toContain("Ready の Issue を待っています");
    expect(textOf(html)).not.toContain("閉じた");
    expect(sectionOf(html, "処理中の Issue")).toBe(
      sectionOf(await render(idleBefore), "処理中の Issue"),
    );
  });

  it("AC5: 次の確認（poll）で表示を更新するとき、GitHub への列の問い合わせは更新1回につき今と同じ回数（1回）のまま", async () => {
    // Given: ダッシュボードを表示している（1回目の読み込みが済んでいる）
    const gh = fakeGitHub(seedBoard());
    const published: DashboardData[] = [];
    const logs: string[] = [];
    const refresher = dashboardRefresher(
      {
        config: makeConfig(),
        store: new MemoryStore(() => NOW),
        board: gh.github,
      },
      (data) => published.push(data),
      (text) => logs.push(text),
    );
    refresher.update({ status: "running" });
    await refresher.idle();
    expect(logs).toEqual([]);
    expect(gh.itemQueries()).toBe(1);

    // When: 次の確認で表示を更新する
    refresher.update({
      activity: {
        lastCheckedAt: NOW.toISOString(),
        nextCheckAt: new Date(NOW.getTime() + 30_000).toISOString(),
      },
    });
    await refresher.idle();

    // Then: 列の問い合わせは更新1回につき1回のまま。その1回で閉じた Issue も数えている
    expect(logs).toEqual([]);
    expect(gh.itemQueries()).toBe(2);
    expect(published).toHaveLength(2);
    expect(countsOf(published[1]!).Done).toBe(19);
  });
});

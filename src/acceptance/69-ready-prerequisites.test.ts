/**
 * Issue #69: Ready から拾うときに「先に済ませる Issue」を確かめる の受け入れテスト
 *
 * 決めた名前（実装役はこれに合わせて作る）:
 * - `src/progress.ts`
 *   ```ts
 *   export interface WorkIssueStatus {
 *     column?: string;
 *     body: string;
 *     merged?: { number: number; url: string };
 *     // 足す: GitHub の Issue の state が CLOSED なら true（閉じた理由は問わない）
 *     closed?: boolean;
 *   }
 *   export interface ProgressBoard {
 *     // 変える: リポジトリに無い番号なら undefined を返す（通信の失敗などは今までどおり reject）
 *     workIssueStatus(issue: number): Promise<WorkIssueStatus | undefined>;
 *     moveIssue(issue: number, column: string): Promise<void>;
 *   }
 *   ```
 *   - 「済んだ」は closed が true であること（PR のマージ・手で閉じた・不要として閉じた、のどれでも）。
 *     #45・#46 の受け入れテストの偽物は closed を返さず merged だけを返すので、
 *     merged があれば閉じているとみなす（マージした PR が閉じた Issue は閉じている）。
 *   - checkProgress も、Ready に移すかをこの判定でそろえる（AC8）。完了の知らせは今のまま merged で判定する
 * - `src/intake.ts`
 *   ```ts
 *   export type IntakeBoard = Pick<GitHub, "moveIssue" | "comment"> & Pick<ProgressBoard, "workIssueStatus">;
 *   export interface IntakeDeps {
 *     config: Config;
 *     store: Store;
 *     board: IntakeBoard;
 *     log(text: string): void; // 足す
 *   }
 *   export type IntakeResult =
 *     | { accepted: true }                                   // 始めた（テスト役の列に移した）
 *     | { accepted: false; problems: string[] }              // Blocked にした
 *     | { accepted: false; waiting: number[] };              // 待つ（Ready に残す）。まだ開いている「先に済ませる Issue」
 *   ```
 *   - 書き漏れの確認が先（書き漏れがあれば「先に済ませる Issue」の状態にかかわらず Blocked）
 *   - リポジトリに無い番号は書き漏れと同じ扱いで Blocked に移し、その番号をコメントする
 *   - 待つときは Issue を動かさず、コメントもしない
 * - `src/loop.ts`
 *   - `LoopDeps.pickUp` の返り値を `Promise<{ accepted: boolean; waiting?: number[] }>` にする
 *   - waiting があれば、Ready の並び順（今の inColumn と同じ番号の順）で次の Issue を確かめる
 *   - どれも着手できなければ何も始めず、待っている Issue と、まだ開いている「先に済ませる Issue」の番号をログに出す
 *     （ログは LoopDeps.log か IntakeDeps.log のどちらで出してもよい。このテストは両方を同じ所に集める）
 *
 * Given の状態は、偽の GitHub（FakeBoard）に Issue を置いて作る（seed）。
 * 記録は MemoryStore。窓口（chat）は使わない（Blocked にするときはメンション付きでコメントする）。
 */
import { describe, expect, it } from "vitest";

import { MemoryChat } from "../chat.js";
import { type Config, parseConfig } from "../config.js";
import { type IntakeBoard, type IntakeDeps, pickUp } from "../intake.js";
import {
  type LoopBoard,
  type LoopDeps,
  type LoopIssue,
  newLoopState,
  tick,
} from "../loop.js";
import {
  checkProgress,
  type ProgressBoard,
  type WorkIssueStatus,
} from "../progress.js";
import { MemoryStore, type Store } from "../store.js";

// ---- seed ----

const REPO = "pkshimizu/wordcards";
const REQUIREMENTS = "1000000000000000001";
const QUESTIONS = "1000000000000000002";
const NOTICES = "1000000000000000003";
const ALLOWED = "2000000000000000001";
const BOT = "3000000000000000001";

const clock = () => new Date("2026-11-21T00:00:00.000Z");

function makeConfig(options: { chat?: boolean } = {}): Config {
  const lines = [
    `github: { repo: ${REPO}, project: 3, notify: someone }`,
    "protected: [src/acceptance/**]",
    "commands: { setup: s, test: t, acceptance: a, typecheck: c, build: b }",
  ];
  if (options.chat === true) {
    lines.push(
      "chat:",
      "  type: discord",
      "  channels:",
      `    requirements: "${REQUIREMENTS}"`,
      `    questions: "${QUESTIONS}"`,
      `    notices: "${NOTICES}"`,
      "  allowed_users:",
      `    - "${ALLOWED}"`,
    );
  }
  return parseConfig(lines.join("\n"));
}

/** 書き漏れのない本文。prerequisites は「先に済ませる Issue」の節の中身（undefined なら節を書かない） */
function issueBody(
  prerequisites: string | undefined,
  options: { heading?: "##" | "###"; omitPurpose?: boolean } = {},
): string {
  const h = options.heading ?? "##";
  return [
    ...(options.omitPurpose
      ? []
      : [`${h} 目的`, "", "単語を前方一致で探せるようにする。", ""]),
    `${h} 受け入れ条件（AC）`,
    "",
    "- AC1",
    "  - Given 単語「apple」「apricot」「banana」がある",
    "  - When 「ap」で検索する",
    "  - Then 「apple」「apricot」だけが出る",
    "",
    `${h} 画面の URL・文言`,
    "",
    "なし",
    "",
    `${h} 対象外`,
    "",
    "- 部分一致の検索",
    "",
    ...(prerequisites === undefined
      ? []
      : [`${h} 先に済ませる Issue`, "", prerequisites, ""]),
  ].join("\n");
}

/** 閉じた理由。merged は PR のマージで閉じた、completed は手で閉じた、not_planned は不要として閉じた */
type ClosedAs = "merged" | "completed" | "not_planned";

interface FakeIssue {
  number: number;
  title: string;
  body: string;
  column?: string;
  closedAs?: ClosedAs;
  merged?: { number: number; url: string };
}

interface FakeComment {
  issue: number;
  body: string;
  mention: boolean;
}

/** Issue・Project の列・コメントを覚えるだけの GitHub */
class FakeBoard implements LoopBoard, IntakeBoard, ProgressBoard {
  readonly issues: FakeIssue[] = [];
  readonly moved: { issue: number; column: string }[] = [];
  readonly comments: FakeComment[] = [];
  /** workIssueStatus を問い合わせた番号 */
  readonly queried: number[] = [];

  /** Issue を置く（seed） */
  add(issue: FakeIssue): FakeIssue {
    const added = { ...issue };
    if (added.closedAs === "merged" && added.merged === undefined) {
      const pr = 900 + added.number;
      added.merged = {
        number: pr,
        url: `https://github.com/${REPO}/pull/${pr}`,
      };
    }
    this.issues.push(added);
    return added;
  }

  /** 開いている Issue（列は Backlog など、Ready 以外） */
  open(number: number, column = "Backlog"): FakeIssue {
    return this.add({
      number,
      title: `前の Issue ${number}`,
      body: issueBody("なし"),
      column,
    });
  }

  /** 閉じた Issue */
  closed(number: number, closedAs: ClosedAs): FakeIssue {
    return this.add({
      number,
      title: `前の Issue ${number}`,
      body: issueBody("なし"),
      column: "Done",
      closedAs,
    });
  }

  /** Ready に置いた Issue */
  ready(number: number, body: string): FakeIssue {
    return this.add({
      number,
      title: `Ready の Issue ${number}`,
      body,
      column: "Ready",
    });
  }

  workIssueStatus(issue: number): Promise<WorkIssueStatus | undefined> {
    this.queried.push(issue);
    const found = this.issues.find((i) => i.number === issue);
    if (found === undefined) return Promise.resolve(undefined);
    return Promise.resolve({
      body: found.body,
      ...(found.column === undefined ? {} : { column: found.column }),
      ...(found.merged === undefined ? {} : { merged: { ...found.merged } }),
      closed: found.closedAs !== undefined,
    });
  }

  issuesByColumn(): Promise<Map<string, LoopIssue[]>> {
    const map = new Map<string, LoopIssue[]>();
    for (const i of this.issues) {
      if (i.column === undefined) continue;
      const list = map.get(i.column) ?? [];
      list.push({ number: i.number, title: i.title, body: i.body });
      map.set(i.column, list);
    }
    return Promise.resolve(map);
  }

  moveIssue(issue: number, column: string): Promise<void> {
    this.moved.push({ issue, column });
    this.find(issue).column = column;
    return Promise.resolve();
  }

  comment(
    issue: number,
    body: string,
    options: { mention?: boolean } = {},
  ): Promise<void> {
    this.find(issue);
    this.comments.push({ issue, body, mention: options.mention === true });
    return Promise.resolve();
  }

  hasConflict(): Promise<boolean> {
    return Promise.resolve(false);
  }

  find(issue: number): FakeIssue {
    const found = this.issues.find((i) => i.number === issue);
    if (found === undefined) throw new Error(`Issue #${issue} は無い`);
    return found;
  }
}

/**
 * 常駐ループの部品。入口確認は本物の pickUp（src/intake.ts）を、偽の GitHub につなぐ。
 * テスト役は呼ばれた Issue を覚える。ほかの役は呼ばれない
 */
function setup(board: FakeBoard, store: Store, config: Config) {
  const logs: string[] = [];
  const tested: number[] = [];
  const log = (text: string) => {
    logs.push(text);
  };
  const intakeDeps: IntakeDeps = { config, store, board, log };
  const never = () => Promise.reject(new Error("この役は呼ばれない"));
  const deps: LoopDeps = {
    config,
    store,
    board,
    pickUp: (issue) => pickUp(intakeDeps, issue),
    test: (issue) => {
      tested.push(issue.number);
      return Promise.resolve({ status: "tested" });
    },
    implement: never,
    checkCi: never,
    review: never,
    merge: never,
    syncMain: never,
    log,
  };
  return { deps, logs, tested };
}

function world() {
  const config = makeConfig();
  const store = new MemoryStore(clock);
  const board = new FakeBoard();
  return { config, store, board };
}

describe("Issue #69: Ready から拾うときに「先に済ませる Issue」を確かめる", () => {
  it("AC1: Ready の先頭の Issue の「先に済ませる Issue」が開いていれば、Ready に残して着手せず、次の Issue を確かめる", async () => {
    const { config, store, board } = world();
    // Given: Ready の先頭（#10）は、まだ開いている #5 を待っている。次（#11）は待つものが無い
    board.open(5);
    board.ready(10, issueBody("- #5"));
    board.ready(11, issueBody("なし"));
    const { deps, tested } = setup(board, store, config);

    // When: conductor が Ready から Issue を拾う
    await tick(deps, newLoopState());

    // Then: #10 は Ready に残したまま着手しない（動かさず、コメントもしない）
    expect(board.find(10).column).toBe("Ready");
    expect(board.moved.filter((m) => m.issue === 10)).toEqual([]);
    expect(board.comments.filter((c) => c.issue === 10)).toEqual([]);
    expect(tested).not.toContain(10);
    // Then: Ready の並び順で次の #11 を確かめ、始める
    expect(board.moved).toEqual([{ issue: 11, column: "Testing" }]);
    expect(tested).toEqual([11]);
  });

  it("AC2: Ready の並び順で最初の、着手できる Issue（先に済ませる Issue がすべて閉じている・なし・節が無い）を始める", async () => {
    const { config, store, board } = world();
    // Given: #10 は開いている #5 を待つ。#11 は閉じた #6 だけを待つ。#12 は「なし」、#13 は節が無い
    board.open(5);
    board.closed(6, "merged");
    board.ready(10, issueBody("- #5"));
    board.ready(11, issueBody("- #6"));
    board.ready(12, issueBody("なし"));
    board.ready(13, issueBody(undefined));
    const { deps, tested } = setup(board, store, config);

    // When: conductor が Ready から Issue を拾う
    await tick(deps, newLoopState());

    // Then: 最初の着手できる Issue（#11）だけをテスト役の列に移して始める
    expect(board.moved).toEqual([{ issue: 11, column: "Testing" }]);
    expect(tested).toEqual([11]);
    expect(board.comments).toEqual([]);
    expect(board.find(10).column).toBe("Ready");
    expect(board.find(12).column).toBe("Ready");
    expect(board.find(13).column).toBe("Ready");

    // 「なし」の Issue も、節が無い Issue も着手できる（ほかに Ready が無いときに始める）
    for (const n of [12, 13]) {
      const w = world();
      w.board.ready(n, board.find(n).body);
      const s = setup(w.board, w.store, w.config);
      await tick(s.deps, newLoopState());
      expect(w.board.moved).toEqual([{ issue: n, column: "Testing" }]);
      expect(s.tested).toEqual([n]);
    }
  });

  it("AC3: 「先に済ませる Issue」は、閉じた理由（PR のマージ・手で閉じた・不要として閉じた）にかかわらず閉じていれば済んだとみなす", async () => {
    const { config, store, board } = world();
    // Given: #5 は PR のマージで、#6 は手で、#7 は不要として閉じた（#6・#7 にマージした PR は無い）
    board.closed(5, "merged");
    board.closed(6, "completed");
    board.closed(7, "not_planned");
    board.ready(10, issueBody("- #5\n- #6\n- #7"));
    const { deps, tested } = setup(board, store, config);

    // When: 済んだかを判定する（Ready から拾う）
    await tick(deps, newLoopState());

    // Then: すべて済んだとみなして始める
    expect(board.moved).toEqual([{ issue: 10, column: "Testing" }]);
    expect(tested).toEqual([10]);
    expect(board.comments).toEqual([]);
  });

  it("AC4: Ready のどの Issue も着手できなければ、どれも始めず、待っている Issue とまだ開いている番号をログに出し、Issue にはコメントしない", async () => {
    const { config, store, board } = world();
    // Given: #10 は開いている #5 を、#11 は開いている #7 と閉じた #6 を待つ
    board.open(5);
    board.closed(6, "completed");
    board.open(7);
    board.ready(10, issueBody("- #5"));
    board.ready(11, issueBody("- #6\n- #7"));
    const { deps, logs, tested } = setup(board, store, config);

    // When: conductor が Ready から Issue を拾う（確認を2回）
    await tick(deps, newLoopState());
    await tick(deps, newLoopState());

    // Then: どれも始めない
    expect(board.moved).toEqual([]);
    expect(tested).toEqual([]);
    expect(board.find(10).column).toBe("Ready");
    expect(board.find(11).column).toBe("Ready");
    // Then: 待っている Issue と、まだ開いている「先に済ませる Issue」の番号をログに出す
    expect(logs.some((l) => l.includes("#10") && l.includes("#5"))).toBe(true);
    expect(logs.some((l) => l.includes("#11") && l.includes("#7"))).toBe(true);
    // Then: Issue にはコメントしない（確認のたびに増えない）
    expect(board.comments).toEqual([]);
  });

  it("AC5: 「先に済ませる Issue」にリポジトリにない番号があれば、Blocked に移し、見つからない番号をコメントする", async () => {
    const { config, store, board } = world();
    // Given: #10 は閉じた #5 と、リポジトリにない #99 を待つ
    board.closed(5, "merged");
    board.ready(10, issueBody("- #5\n- #99"));
    const { deps, tested } = setup(board, store, config);

    // When: conductor が Ready から Issue を拾う
    await tick(deps, newLoopState());

    // Then: 書き漏れと同じく Blocked に移し、着手しない
    expect(board.moved).toEqual([{ issue: 10, column: "Blocked" }]);
    expect(board.find(10).column).toBe("Blocked");
    expect(tested).toEqual([]);
    // Then: どの番号が見つからないかをコメントする（窓口が無いのでメンション付き）
    const comments = board.comments.filter((c) => c.issue === 10);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain("#99");
    expect(comments[0]!.body).not.toContain("#5");
    expect(comments[0]!.mention).toBe(true);
  });

  it("AC6: 本文に書き漏れがあれば、「先に済ませる Issue」の状態にかかわらず、今と同じく Blocked に移してコメントする", async () => {
    const { config, store, board } = world();
    // Given: #10 は「目的」の見出しが無く、まだ開いている #5 を待つ
    board.open(5);
    board.ready(10, issueBody("- #5", { omitPurpose: true }));
    const { deps, tested } = setup(board, store, config);

    // When: conductor が Ready から Issue を拾う
    await tick(deps, newLoopState());

    // Then: 待たずに Blocked に移し、欠けた項目をコメントする
    expect(board.moved).toEqual([{ issue: 10, column: "Blocked" }]);
    expect(tested).toEqual([]);
    const comments = board.comments.filter((c) => c.issue === 10);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain("書き漏れがあるため");
    expect(comments[0]!.body).toContain("「目的」の見出しがありません");
    expect(comments[0]!.mention).toBe(true);
  });

  it("AC7: 「先に済ませる Issue」に書いた自分自身の番号は無視する", async () => {
    const { config, store, board } = world();
    // Given: #10（開いている自分自身）と、閉じた #6 を待つ
    board.closed(6, "completed");
    board.ready(10, issueBody("- #10\n- #6"));
    const { deps, tested, logs } = setup(board, store, config);

    // When: 済んだかを判定する（Ready から拾う）
    await tick(deps, newLoopState());

    // Then: 自分自身は無視して、始める
    expect(board.moved).toEqual([{ issue: 10, column: "Testing" }]);
    expect(tested).toEqual([10]);
    expect(board.comments).toEqual([]);
    expect(logs.join("\n")).not.toContain("見つかりません");
  });

  it("AC8: 要件の作業用 Issue で列が未設定のものは、「先に済ませる Issue」がすべて閉じていれば（マージされていなくても）Ready に移し、完了の知らせは今のまま", async () => {
    const config = makeConfig({ chat: true });
    const chat = new MemoryChat(BOT);
    const store = new MemoryStore(clock);
    const board = new FakeBoard();
    // Given: 要件の作業用 Issue #201・#202・#203。
    //   #201 は不要として閉じた（マージした PR は無い）。
    //   #202 は列が未設定で、#201 を待つ。
    //   #203 は列が未設定で、#202（まだ開いている）を待つ
    board.add({
      number: 201,
      title: "検索の索引を作る",
      body: issueBody("なし"),
      column: "Done",
      closedAs: "not_planned",
    });
    board.add({
      number: 202,
      title: "検索の API を作る",
      body: issueBody("- #201"),
    });
    board.add({
      number: 203,
      title: "検索の画面を作る",
      body: issueBody("- #201\n- #202"),
    });
    const posted = chat.addMessage(REQUIREMENTS, {
      authorId: ALLOWED,
      text: "単語帳に検索をつけたい",
    });
    const threadId = await chat.createThread(
      QUESTIONS,
      await chat.post(
        QUESTIONS,
        "要件を受け取りました: 単語帳に検索をつけたい",
      ),
      "単語帳に検索をつけたい",
    );
    const requirement = await store.updateRequirement(posted.id, {
      threadId,
      specPr: 101,
      state: "working",
      workIssues: [201, 202, 203],
    });

    // When: src/progress.ts が Ready に移すかを判定する
    await checkProgress(
      { config, chat, store, board, log: () => {} },
      requirement,
    );

    // Then: 先に済ませる Issue（#201）が閉じている #202 を Ready に移す
    expect(board.moved).toEqual([{ issue: 202, column: "Ready" }]);
    // まだ開いている #202 を待つ #203 は動かさない
    expect(board.find(203).column).toBeUndefined();
    // Then: 完了の知らせは今のまま（すべての PR がマージされるまで書かない）
    const notices = (chat.messages.get(NOTICES) ?? []).filter(
      (m) => m.authorId === chat.botId,
    );
    expect(notices).toEqual([]);
    expect((await store.getRequirement(posted.id))?.state).toBe("working");
  });

  it("AC9: 「先に済ませる Issue」の節は `##` でも Issue フォームの `###` でも同じように扱う", async () => {
    const { config, store, board } = world();
    // Given: #10 は `##`、#11 は `###` の節で開いている #5 を待つ。#12 は `###` の節で閉じた #6 を待つ
    board.open(5);
    board.closed(6, "merged");
    board.ready(10, issueBody("- #5", { heading: "##" }));
    board.ready(11, issueBody("- #5", { heading: "###" }));
    board.ready(12, issueBody("- #6", { heading: "###" }));
    const { deps, tested } = setup(board, store, config);

    // When: 読む（Ready から拾う）
    await tick(deps, newLoopState());

    // Then: #10・#11 はどちらも #5 を待つ。#12 を始める
    expect(board.find(10).column).toBe("Ready");
    expect(board.find(11).column).toBe("Ready");
    expect(board.moved).toEqual([{ issue: 12, column: "Testing" }]);
    expect(tested).toEqual([12]);
    expect(board.comments).toEqual([]);

    // どちらの節でも、まだ開いている番号を同じように読む（どれも着手できないときのログ）
    const w = world();
    w.board.open(5);
    w.board.ready(10, issueBody("- #5", { heading: "##" }));
    w.board.ready(11, issueBody("- #5", { heading: "###" }));
    const s = setup(w.board, w.store, w.config);
    await tick(s.deps, newLoopState());
    expect(w.board.moved).toEqual([]);
    expect(s.logs.some((l) => l.includes("#10") && l.includes("#5"))).toBe(
      true,
    );
    expect(s.logs.some((l) => l.includes("#11") && l.includes("#5"))).toBe(
      true,
    );
  });
});

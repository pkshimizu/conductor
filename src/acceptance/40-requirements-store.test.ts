/**
 * Issue #40: 要件の記録（SQLite）の受け入れテスト
 *
 * 決めた名前（実装役はこれに合わせて作る）:
 * - `src/store.ts` に足すもの
 *   ```ts
 *   export const REQUIREMENT_STATES = [
 *     "specifying",        // 仕様化中
 *     "awaiting_approval", // 承認待ち
 *     "working",           // 作業中
 *     "done",              // 完了
 *   ] as const;
 *   export type RequirementState = (typeof REQUIREMENT_STATES)[number];
 *
 *   export interface RequirementRecord {
 *     messageId: string;       // 要件の投稿 ID（記録のキー）
 *     threadId?: string;       // 要件のスレッド ID
 *     state: RequirementState;
 *     questions: number;       // 質問の数
 *     specPr?: number;         // 仕様の PR の番号
 *     workIssues: number[];    // 作業用 Issue の番号（配列の順が作業の順番）
 *     updatedAt: string;       // 最後に更新した時刻（ISO 8601）
 *   }
 *   // 書き換える項目。undefined を入れた省略できる項目（threadId・specPr）は消す
 *   export type RequirementUpdate = {
 *     [K in keyof Omit<RequirementRecord, "messageId" | "updatedAt">]?:
 *       RequirementRecord[K] | undefined;
 *   };
 *
 *   interface Store {
 *     // 既存のメソッドはそのまま
 *     getRequirement(messageId: string): Promise<RequirementRecord | undefined>;
 *     // 記録が無ければ state "specifying"・questions 0・workIssues [] で作り、指定した項目だけ書き換える
 *     updateRequirement(messageId: string, update: RequirementUpdate): Promise<RequirementRecord>;
 *     // すべての要件を投稿 ID の古い順（BigInt で比べて小さい順）に返す
 *     listRequirements(): Promise<RequirementRecord[]>;
 *     // チャンネルまたはスレッド ID ごとの「どこまで読んだか」（最後に読んだ投稿 ID）
 *     getReadPosition(channelId: string): Promise<string | undefined>;
 *     setReadPosition(channelId: string, messageId: string): Promise<void>;
 *   }
 *   ```
 * - `MemoryStore`（`src/store.ts`）と `SqliteStore`（`src/sqlite-store.ts`）の両方が上を実装する
 * - `SqliteStore` は Lv1 の DB（`issues`・`summaries` の表だけ）を開いたとき、既存の表と行を
 *   変えずに要件用の表（名前は自由）を足す
 *
 * SQLite のファイルは一時フォルダに作り、テストの後で消す。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MemoryChat } from "../chat.js";
import { SqliteStore } from "../sqlite-store.js";
import {
  type Clock,
  MemoryStore,
  type RequirementRecord,
  type Store,
} from "../store.js";

// ---- seed ----

const START = "2026-11-19T00:00:00.000Z";

function fixedClock(): Clock & { advance: (ms: number) => void } {
  let t = Date.parse(START);
  const clock = () => new Date(t);
  clock.advance = (ms: number) => {
    t += ms;
  };
  return clock;
}

const REQUIREMENTS_CHANNEL = "1000000000000000001";
const HUMAN = "2000000000000000001";

/** Lv1 の版が作っていた表（この Issue より前の SqliteStore と同じ） */
const LV1_SCHEMA = `
CREATE TABLE IF NOT EXISTS issues (
  repo TEXT NOT NULL,
  issue INTEGER NOT NULL,
  rejections INTEGER NOT NULL DEFAULT 0,
  objections INTEGER NOT NULL DEFAULT 0,
  branch TEXT,
  pr INTEGER,
  checkpoint TEXT,
  protected_hash TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo, issue)
);
CREATE TABLE IF NOT EXISTS summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  issue INTEGER NOT NULL,
  role TEXT NOT NULL,
  verdict TEXT NOT NULL,
  text TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS summaries_issue ON summaries (repo, issue, id);
`;

const LV1_REPO = "pkshimizu/wordcards";

/** Lv1 の記録が入った SQLite のファイルを作る */
function seedLv1Database(file: string): void {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(LV1_SCHEMA);
  const insertIssue = db.prepare(
    `INSERT INTO issues
       (repo, issue, rejections, objections, branch, pr, checkpoint, protected_hash, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertIssue.run(
    LV1_REPO,
    2,
    1,
    0,
    "conductor/issue-2",
    12,
    JSON.stringify({ stage: "reviewing", reason: "利用上限" }),
    "abc123",
    "2026-11-01T00:00:00.000Z",
  );
  insertIssue.run(
    LV1_REPO,
    5,
    0,
    2,
    null,
    null,
    null,
    null,
    "2026-11-02T00:00:00.000Z",
  );
  const insertSummary = db.prepare(
    "INSERT INTO summaries (repo, issue, role, verdict, text, at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  insertSummary.run(
    LV1_REPO,
    2,
    "tester",
    "approve",
    "テストを書いた",
    "2026-11-01T00:00:00.000Z",
  );
  insertSummary.run(
    LV1_REPO,
    2,
    "reviewer",
    "reject",
    "直してほしい",
    "2026-11-01T01:00:00.000Z",
  );
  db.close();
}

function tableNames(file: string): string[] {
  const db = new DatabaseSync(file);
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as unknown as { name: string }[];
  db.close();
  return rows.map((r) => r.name);
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "conductor-40-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("Issue #40: 要件の記録（SQLite）", () => {
  it("AC1: 新しい要件を記録すると、投稿 ID・スレッド・状態・質問の数・仕様の PR・作業用 Issue とその順番が残る", async () => {
    const clock = fixedClock();
    const store: Store = new SqliteStore(join(dir, "conductor.db"), clock);
    try {
      // Given: 新しい要件（まだ記録が無い）
      expect(await store.getRequirement("5000000000000000001")).toBeUndefined();

      // When: 記録する（作った直後は仕様化中・質問 0・作業用 Issue なし）
      const created = await store.updateRequirement("5000000000000000001", {
        threadId: "6000000000000000001",
      });
      expect(created).toEqual({
        messageId: "5000000000000000001",
        threadId: "6000000000000000001",
        state: "specifying",
        questions: 0,
        workIssues: [],
        updatedAt: START,
      });

      // 状態が進むごとに書き換える
      clock.advance(1000);
      await store.updateRequirement("5000000000000000001", {
        state: "awaiting_approval",
        questions: 3,
        specPr: 41,
      });
      clock.advance(1000);
      await store.updateRequirement("5000000000000000001", {
        state: "working",
        workIssues: [44, 42, 43],
      });

      // 別の要件は混ざらない
      await store.updateRequirement("5000000000000000009", {
        threadId: "6000000000000000009",
        state: "done",
        questions: 1,
        specPr: 50,
        workIssues: [51],
      });

      // Then: すべての項目が残り、作業用 Issue は記録した順番のまま
      const expected: RequirementRecord = {
        messageId: "5000000000000000001",
        threadId: "6000000000000000001",
        state: "working",
        questions: 3,
        specPr: 41,
        workIssues: [44, 42, 43],
        updatedAt: "2026-11-19T00:00:02.000Z",
      };
      expect(await store.getRequirement("5000000000000000001")).toEqual(
        expected,
      );
      expect(await store.listRequirements()).toEqual([
        expected,
        {
          messageId: "5000000000000000009",
          threadId: "6000000000000000009",
          state: "done",
          questions: 1,
          specPr: 50,
          workIssues: [51],
          updatedAt: "2026-11-19T00:00:02.000Z",
        },
      ]);

      // 4つの状態はすべて記録できる
      for (const state of [
        "specifying",
        "awaiting_approval",
        "working",
        "done",
      ] as const) {
        const r = await store.updateRequirement("5000000000000000001", {
          state,
        });
        expect(r.state).toBe(state);
        const read = await store.getRequirement("5000000000000000001");
        expect(read?.state).toBe(state);
      }
    } finally {
      await store.close();
    }
  });

  it("AC2: 要件と「どこまで読んだか」を記録して conductor を止めて再起動すると、記録が引き継がれ、続きから読む", async () => {
    const file = join(dir, "conductor.db");
    const clock = fixedClock();
    const chat = new MemoryChat();
    const threadRoot = chat.addMessage(REQUIREMENTS_CHANNEL, {
      authorId: HUMAN,
      text: "単語帳に検索をつけたい",
    });
    const thread = await chat.createThread(
      REQUIREMENTS_CHANNEL,
      threadRoot.id,
      "要件: 検索",
    );
    const answered = chat.addMessage(thread, {
      authorId: HUMAN,
      text: "前方一致でお願いします",
    });

    // Given: 要件と、チャンネル・スレッドごとの「どこまで読んだか」を記録した状態
    const before: Store = new SqliteStore(file, clock);
    await before.updateRequirement(threadRoot.id, {
      threadId: thread,
      state: "specifying",
      questions: 2,
    });
    await before.setReadPosition(REQUIREMENTS_CHANNEL, threadRoot.id);
    await before.setReadPosition(thread, answered.id);
    const saved = await before.getRequirement(threadRoot.id);

    // When: conductor を止める（記録を閉じる）。止まっている間に新しい投稿が来る
    await before.close();
    const nextRequirement = chat.addMessage(REQUIREMENTS_CHANNEL, {
      authorId: HUMAN,
      text: "CSV で書き出したい",
    });
    const nextAnswer = chat.addMessage(thread, {
      authorId: HUMAN,
      text: "大文字小文字は区別しません",
    });

    // When: 再起動する（同じファイルを開き直す）
    const after: Store = new SqliteStore(file, clock);
    try {
      // Then: 記録が引き継がれる
      expect(saved).toBeDefined();
      expect(await after.getRequirement(threadRoot.id)).toEqual(saved);
      expect(await after.listRequirements()).toEqual([saved]);
      expect(await after.getReadPosition(REQUIREMENTS_CHANNEL)).toBe(
        threadRoot.id,
      );
      expect(await after.getReadPosition(thread)).toBe(answered.id);
      const unknown = await after.getReadPosition("1000000000000000999");
      expect(unknown).toBeUndefined();

      // Then: 記録した位置の続きから読むと、止まっている間の投稿だけが得られる
      const channelNews = await chat.readMessages(
        REQUIREMENTS_CHANNEL,
        await after.getReadPosition(REQUIREMENTS_CHANNEL),
      );
      expect(channelNews.map((m) => m.id)).toEqual([nextRequirement.id]);
      const threadNews = await chat.readMessages(
        thread,
        await after.getReadPosition(thread),
      );
      expect(threadNews.map((m) => m.id)).toEqual([nextAnswer.id]);

      // 読んだ位置を進めると、上書きされる
      await after.setReadPosition(REQUIREMENTS_CHANNEL, nextRequirement.id);
      expect(await after.getReadPosition(REQUIREMENTS_CHANNEL)).toBe(
        nextRequirement.id,
      );
    } finally {
      await after.close();
    }
  });

  it("AC3: Lv1 の記録が入った既存の SQLite を新しい版で開くと、既存の記録を壊さずに要件用の表が足される", async () => {
    const file = join(dir, "conductor.db");
    // Given: Lv1 の記録が入った既存の SQLite
    seedLv1Database(file);
    const lv1Tables = tableNames(file);
    expect(lv1Tables).toEqual(["issues", "summaries"]);

    // When: 新しい版で起動する
    const clock = fixedClock();
    const store: Store = new SqliteStore(file, clock);
    try {
      // Then: 既存の記録はそのまま読める
      expect(await store.list(LV1_REPO)).toEqual([
        {
          repo: LV1_REPO,
          issue: 2,
          rejections: 1,
          objections: 0,
          branch: "conductor/issue-2",
          pr: 12,
          checkpoint: { stage: "reviewing", reason: "利用上限" },
          protectedHash: "abc123",
          updatedAt: "2026-11-01T00:00:00.000Z",
        },
        {
          repo: LV1_REPO,
          issue: 5,
          rejections: 0,
          objections: 2,
          updatedAt: "2026-11-02T00:00:00.000Z",
        },
      ]);
      expect(await store.summaries({ repo: LV1_REPO, issue: 2 })).toEqual([
        {
          role: "tester",
          verdict: "approve",
          text: "テストを書いた",
          at: "2026-11-01T00:00:00.000Z",
        },
        {
          role: "reviewer",
          verdict: "reject",
          text: "直してほしい",
          at: "2026-11-01T01:00:00.000Z",
        },
      ]);

      // Then: 要件の記録が使える
      await store.updateRequirement("5000000000000000001", {
        threadId: "6000000000000000001",
        specPr: 41,
      });
      await store.setReadPosition(REQUIREMENTS_CHANNEL, "5000000000000000001");
      expect(await store.getRequirement("5000000000000000001")).toEqual({
        messageId: "5000000000000000001",
        threadId: "6000000000000000001",
        state: "specifying",
        questions: 0,
        specPr: 41,
        workIssues: [],
        updatedAt: START,
      });
      expect(await store.getReadPosition(REQUIREMENTS_CHANNEL)).toBe(
        "5000000000000000001",
      );

      // 既存の Issue の記録は引き続き書き換えられる
      await store.update({ repo: LV1_REPO, issue: 5 }, { objections: 3 });
      const updated = await store.get({ repo: LV1_REPO, issue: 5 });
      expect(updated?.objections).toBe(3);
    } finally {
      await store.close();
    }

    // Then: 既存の表は残ったまま、要件用の表が足されている
    const tables = tableNames(file);
    expect(tables).toEqual(expect.arrayContaining(lv1Tables));
    expect(tables.length).toBeGreaterThan(lv1Tables.length);

    // もう一度起動しても、記録は壊れない（足すのは1回だけ）
    const again: Store = new SqliteStore(file, clock);
    try {
      const issues = await again.list(LV1_REPO);
      expect(issues.map((r) => r.issue)).toEqual([2, 5]);
      const summaries = await again.summaries({ repo: LV1_REPO, issue: 2 });
      expect(summaries).toHaveLength(2);
      const requirement = await again.getRequirement("5000000000000000001");
      expect(requirement?.specPr).toBe(41);
    } finally {
      await again.close();
    }
    expect(tableNames(file)).toEqual(tables);
  });

  it("AC4: テストでメモリ上の記録（MemoryStore）を使うと、SQLite と同じ型で要件の記録を試せる", async () => {
    /** 同じ操作を Store の型だけを使って行い、見えた結果を返す */
    async function scenario(
      store: Store,
      clock: ReturnType<typeof fixedClock>,
    ) {
      const seen: unknown[] = [];
      seen.push(await store.getRequirement("5000000000000000002"));
      seen.push(
        await store.updateRequirement("5000000000000000002", {
          threadId: "6000000000000000002",
        }),
      );
      clock.advance(1000);
      seen.push(
        await store.updateRequirement("5000000000000000002", {
          state: "awaiting_approval",
          questions: 2,
          specPr: 60,
        }),
      );
      clock.advance(1000);
      seen.push(
        await store.updateRequirement("5000000000000000001", {
          threadId: "6000000000000000001",
          state: "working",
          workIssues: [63, 61, 62],
        }),
      );
      // undefined を入れた項目は消える
      seen.push(
        await store.updateRequirement("5000000000000000002", {
          specPr: undefined,
        }),
      );
      seen.push(await store.getRequirement("5000000000000000002"));
      seen.push(await store.listRequirements());
      seen.push(await store.getReadPosition(REQUIREMENTS_CHANNEL));
      await store.setReadPosition(REQUIREMENTS_CHANNEL, "5000000000000000001");
      await store.setReadPosition(REQUIREMENTS_CHANNEL, "5000000000000000002");
      await store.setReadPosition("6000000000000000001", "7000000000000000001");
      seen.push(await store.getReadPosition(REQUIREMENTS_CHANNEL));
      seen.push(await store.getReadPosition("6000000000000000001"));

      // 返された記録を書き換えても、記録の中身は変わらない
      const got = await store.getRequirement("5000000000000000001");
      got?.workIssues.push(99);
      seen.push(await store.getRequirement("5000000000000000001"));
      return seen;
    }

    const memoryClock = fixedClock();
    const memory: Store = new MemoryStore(memoryClock);
    const sqliteClock = fixedClock();
    const sqlite: Store = new SqliteStore(
      join(dir, "conductor.db"),
      sqliteClock,
    );
    try {
      const fromMemory = await scenario(memory, memoryClock);
      const fromSqlite = await scenario(sqlite, sqliteClock);

      // MemoryStore で試した結果は SQLite と同じ
      expect(fromMemory).toEqual(fromSqlite);

      // 結果そのものも期待どおり
      const first: RequirementRecord = {
        messageId: "5000000000000000001",
        threadId: "6000000000000000001",
        state: "working",
        questions: 0,
        workIssues: [63, 61, 62],
        updatedAt: "2026-11-19T00:00:02.000Z",
      };
      const second: RequirementRecord = {
        messageId: "5000000000000000002",
        threadId: "6000000000000000002",
        state: "awaiting_approval",
        questions: 2,
        workIssues: [],
        updatedAt: "2026-11-19T00:00:02.000Z",
      };
      expect(fromMemory).toEqual([
        undefined,
        {
          messageId: "5000000000000000002",
          threadId: "6000000000000000002",
          state: "specifying",
          questions: 0,
          workIssues: [],
          updatedAt: START,
        },
        {
          messageId: "5000000000000000002",
          threadId: "6000000000000000002",
          state: "awaiting_approval",
          questions: 2,
          specPr: 60,
          workIssues: [],
          updatedAt: "2026-11-19T00:00:01.000Z",
        },
        first,
        second,
        second,
        [first, second],
        undefined,
        "5000000000000000002",
        "7000000000000000001",
        first,
      ]);
    } finally {
      await memory.close();
      await sqlite.close();
    }
  });
});

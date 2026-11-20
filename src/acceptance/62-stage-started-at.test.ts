/**
 * Issue #62: 段階を始めた時刻の記録 の受け入れテスト
 *
 * 決めた名前（実装役はこれに合わせて作る）:
 * - `src/store.ts` の `IssueRecord` に足すもの
 *   ```ts
 *   export interface IssueRecord extends IssueKey {
 *     // 既存の項目はそのまま
 *     /** 今の段階（checkpoint.stage）を始めた時刻（ISO 8601） *\/
 *     stageStartedAt?: string;
 *   }
 *   ```
 * - `src/sqlite-store.ts` の `issues` 表に足す列: `stage_started_at TEXT`
 * - 時刻を入れるのは store の `update`。`update` に渡した `checkpoint.stage` が
 *   今の記録の `checkpoint.stage` と違う（または記録・checkpoint が無い）ときだけ、
 *   その時の時刻（Clock）を `stageStartedAt` に入れる。同じ段階のまま
 *   checkpoint を書き直したとき（再開・利用上限で待つ・異議など）は変えない。
 *   各役（tester.ts・implementer.ts など）は今のまま `checkpoint` を書けばよい。
 * - `MemoryStore` と `SqliteStore` の両方が同じ振る舞いをする
 *
 * seed: SQLite のファイルは一時フォルダに毎回新しく作り、テストの後で消す。
 * AC3 の「今までの DB」は、この Issue より前の SqliteStore と同じ表を直接作って入れる。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SqliteStore } from "../sqlite-store.js";
import {
  type Clock,
  type IssueKey,
  MemoryStore,
  type Store,
} from "../store.js";

// ---- seed ----

const START = "2026-11-21T00:00:00.000Z";
const REPO = "pkshimizu/wordcards";
const KEY: IssueKey = { repo: REPO, issue: 7 };

function fixedClock(): Clock & { advance: (ms: number) => void } {
  let t = Date.parse(START);
  const clock = () => new Date(t);
  clock.advance = (ms: number) => {
    t += ms;
  };
  return clock;
}

function at(ms: number): string {
  return new Date(Date.parse(START) + ms).toISOString();
}

/** この Issue より前の SqliteStore が作っていた表（stage_started_at の列が無い） */
const OLD_SCHEMA = `
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
CREATE TABLE IF NOT EXISTS requirements (
  message_id TEXT PRIMARY KEY,
  thread_id TEXT,
  state TEXT NOT NULL,
  questions INTEGER NOT NULL DEFAULT 0,
  spec_pr INTEGER,
  work_issues TEXT NOT NULL DEFAULT '[]',
  decomposition TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS read_positions (
  channel_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS blocked_threads (
  repo TEXT NOT NULL,
  issue INTEGER NOT NULL,
  reason TEXT NOT NULL,
  head_id TEXT,
  thread_id TEXT,
  copied INTEGER NOT NULL DEFAULT 0,
  respec TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo, issue)
);
`;

/** 列のない、今までの DB を作り、作業中の Issue の記録を入れる */
function seedOldDatabase(file: string): void {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(OLD_SCHEMA);
  const insert = db.prepare(
    `INSERT INTO issues
       (repo, issue, rejections, objections, branch, pr, checkpoint, protected_hash, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(
    REPO,
    3,
    1,
    0,
    "conductor/issue-3",
    13,
    JSON.stringify({ stage: "reviewing", reason: "usage-limit" }),
    "abc123",
    "2026-11-10T00:00:00.000Z",
  );
  insert.run(REPO, 4, 0, 2, null, null, null, null, "2026-11-11T00:00:00.000Z");
  db.prepare(
    "INSERT INTO summaries (repo, issue, role, verdict, text, at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    REPO,
    3,
    "tester",
    "approve",
    "テストを書いた",
    "2026-11-09T00:00:00.000Z",
  );
  db.close();
}

/** issues 表の列の名前 */
function issueColumns(file: string): string[] {
  const db = new DatabaseSync(file);
  const rows = db.prepare("PRAGMA table_info(issues)").all() as unknown as {
    name: string;
  }[];
  db.close();
  return rows.map((r) => r.name);
}

/** issues 表に保存された、段階を始めた時刻 */
function savedStageStartedAt(file: string, key: IssueKey): unknown {
  const db = new DatabaseSync(file);
  const row = db
    .prepare("SELECT stage_started_at FROM issues WHERE repo = ? AND issue = ?")
    .get(key.repo, key.issue) as { stage_started_at: unknown } | undefined;
  db.close();
  return row?.stage_started_at;
}

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "conductor-62-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("Issue #62: 段階を始めた時刻の記録", () => {
  it("AC1: Issue の処理中に新しい段階を始めると、その時刻（ISO 8601）を issues テーブルに保存し、IssueRecord の stageStartedAt として読める", async () => {
    const file = join(dir, "conductor.db");
    const clock = fixedClock();
    const store: Store = new SqliteStore(file, clock);
    const memoryClock = fixedClock();
    const memory: Store = new MemoryStore(memoryClock);
    try {
      for (const [s, c] of [
        [store, clock],
        [memory, memoryClock],
      ] as const) {
        // Given: Issue の処理中（テスト役が段階を始めた）
        await s.update(KEY, {
          branch: "conductor/issue-7",
          checkpoint: { stage: "testing" },
        });
        expect((await s.get(KEY))?.stageStartedAt).toBe(at(0));

        // 段階の途中で別の項目を書き換えても、始めた時刻は変わらない
        c.advance(60_000);
        await s.update(KEY, { protectedHash: "hash-1" });
        expect((await s.get(KEY))?.stageStartedAt).toBe(at(0));

        // When: 新しい段階（実装）を始める
        c.advance(60_000);
        const implementing = await s.update(KEY, {
          checkpoint: { stage: "implementing" },
        });

        // Then: その段階を始めた時刻が IssueRecord の項目として読める
        expect(implementing.stageStartedAt).toBe(at(120_000));
        expect(implementing.stageStartedAt).toMatch(ISO_8601);
        expect(await s.get(KEY)).toMatchObject({
          repo: REPO,
          issue: 7,
          checkpoint: { stage: "implementing" },
          stageStartedAt: at(120_000),
          updatedAt: at(120_000),
        });
        expect((await s.list(REPO))[0]?.stageStartedAt).toBe(at(120_000));

        // 続く段階（CI・レビュー・マージ）も、始めるたびにその時刻になる
        let ms = 120_000;
        for (const stage of ["ci", "reviewing", "merging"] as const) {
          c.advance(300_000);
          ms += 300_000;
          await s.update(KEY, { checkpoint: { stage } });
          expect((await s.get(KEY))?.stageStartedAt).toBe(at(ms));
        }
      }

      // Then: issues テーブルに ISO 8601 で保存されている
      const saved = savedStageStartedAt(file, KEY);
      expect(saved).toBe(at(120_000 + 300_000 * 3));
      expect(saved).toMatch(ISO_8601);
    } finally {
      await store.close();
      await memory.close();
    }

    // 開き直しても読める
    const reopened: Store = new SqliteStore(file, fixedClock());
    try {
      expect((await reopened.get(KEY))?.stageStartedAt).toBe(
        at(120_000 + 300_000 * 3),
      );
    } finally {
      await reopened.close();
    }
  });

  it("AC2: 段階の途中で conductor を止めて再起動し、同じ段階を続きから再開しても、段階を始めた時刻は変わらない", async () => {
    const file = join(dir, "conductor.db");
    const clock = fixedClock();

    // Given: 実装の段階を始め、途中で利用上限に当たって止まった
    const before: Store = new SqliteStore(file, clock);
    await before.update(KEY, { checkpoint: { stage: "testing" } });
    clock.advance(60_000);
    await before.update(KEY, {
      branch: "conductor/issue-7",
      checkpoint: { stage: "implementing" },
    });
    clock.advance(60_000);
    await before.update(KEY, {
      checkpoint: {
        stage: "implementing",
        reason: "usage-limit",
        resumeAt: at(3_600_000),
      },
    });
    expect((await before.get(KEY))?.stageStartedAt).toBe(at(60_000));
    // conductor を止める
    await before.close();

    // When: 再起動して、同じ段階を続きから再開する
    clock.advance(3_600_000);
    const after: Store = new SqliteStore(file, clock);
    try {
      expect((await after.get(KEY))?.stageStartedAt).toBe(at(60_000));
      const resumed = await after.update(KEY, {
        checkpoint: { stage: "implementing" },
      });

      // Then: 段階を始めた時刻は変わらない（更新した時刻だけ進む）
      expect(resumed.stageStartedAt).toBe(at(60_000));
      expect(resumed.updatedAt).toBe(at(3_720_000));
      expect(await after.get(KEY)).toMatchObject({
        checkpoint: { stage: "implementing" },
        stageStartedAt: at(60_000),
        updatedAt: at(3_720_000),
      });
      expect(savedStageStartedAt(file, KEY)).toBe(at(60_000));

      // 同じ段階のまま理由を付けて書き直しても変わらない
      clock.advance(60_000);
      await after.update(KEY, {
        checkpoint: { stage: "implementing", reason: "objection" },
      });
      expect((await after.get(KEY))?.stageStartedAt).toBe(at(60_000));

      // 次の段階に進めば、そのときの時刻になる
      clock.advance(60_000);
      await after.update(KEY, { pr: 21, checkpoint: { stage: "ci" } });
      expect((await after.get(KEY))?.stageStartedAt).toBe(at(3_840_000));
    } finally {
      await after.close();
    }

    // MemoryStore でも、同じ段階の書き直しでは変わらない
    const memoryClock = fixedClock();
    const memory: Store = new MemoryStore(memoryClock);
    await memory.update(KEY, { checkpoint: { stage: "reviewing" } });
    memoryClock.advance(60_000);
    await memory.update(KEY, {
      checkpoint: { stage: "reviewing", reason: "usage-limit" },
    });
    memoryClock.advance(60_000);
    await memory.update(KEY, { checkpoint: { stage: "reviewing" } });
    expect((await memory.get(KEY))?.stageStartedAt).toBe(at(0));
    await memory.close();
  });

  it("AC3: 列のない今までの DB で conductor を起動すると、列を足してそのまま動き、今までの記録は消さない", async () => {
    const file = join(dir, "conductor.db");
    // Given: 列のない、今までの DB
    seedOldDatabase(file);
    expect(issueColumns(file)).not.toContain("stage_started_at");

    // When: conductor を起動する
    const clock = fixedClock();
    const store: Store = new SqliteStore(file, clock);
    try {
      // Then: 列が足されている
      expect(issueColumns(file)).toContain("stage_started_at");

      // Then: 今までの記録はそのまま読める
      const records = await store.list(REPO);
      expect(records).toHaveLength(2);
      expect(records[0]).toMatchObject({
        repo: REPO,
        issue: 3,
        rejections: 1,
        objections: 0,
        branch: "conductor/issue-3",
        pr: 13,
        checkpoint: { stage: "reviewing", reason: "usage-limit" },
        protectedHash: "abc123",
        updatedAt: "2026-11-10T00:00:00.000Z",
      });
      expect(records[1]).toMatchObject({
        repo: REPO,
        issue: 4,
        rejections: 0,
        objections: 2,
        updatedAt: "2026-11-11T00:00:00.000Z",
      });
      expect(await store.summaries({ repo: REPO, issue: 3 })).toEqual([
        {
          role: "tester",
          verdict: "approve",
          text: "テストを書いた",
          at: "2026-11-09T00:00:00.000Z",
        },
      ]);

      // Then: そのまま動く（新しい段階を始めると時刻を記録する）
      await store.update(
        { repo: REPO, issue: 3 },
        { checkpoint: { stage: "merging" } },
      );
      const merged = await store.get({ repo: REPO, issue: 3 });
      expect(merged).toMatchObject({
        branch: "conductor/issue-3",
        pr: 13,
        rejections: 1,
        checkpoint: { stage: "merging" },
        stageStartedAt: START,
      });
      await store.update(KEY, { checkpoint: { stage: "testing" } });
      expect((await store.get(KEY))?.stageStartedAt).toBe(START);
    } finally {
      await store.close();
    }

    // もう一度起動しても壊れない（列を足すのは1回だけ）
    const again: Store = new SqliteStore(file, clock);
    try {
      const issues = await again.list(REPO);
      expect(issues.map((r) => r.issue)).toEqual([3, 4, 7]);
      expect(issues[0]?.stageStartedAt).toBe(START);
    } finally {
      await again.close();
    }
    expect(
      issueColumns(file).filter((c) => c === "stage_started_at"),
    ).toHaveLength(1);
  });
});

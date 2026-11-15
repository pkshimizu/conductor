import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  applyUpdate,
  type Checkpoint,
  type Clock,
  emptyRecord,
  type IssueKey,
  type IssueRecord,
  type IssueUpdate,
  type Store,
  type Summary,
  systemClock,
} from "./store.js";

const SCHEMA = `
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

interface IssueRow {
  repo: string;
  issue: number;
  rejections: number;
  objections: number;
  branch: string | null;
  pr: number | null;
  checkpoint: string | null;
  protected_hash: string | null;
  updated_at: string;
}

function fromRow(row: IssueRow): IssueRecord {
  const r: IssueRecord = {
    repo: row.repo,
    issue: row.issue,
    rejections: row.rejections,
    objections: row.objections,
    updatedAt: row.updated_at,
  };
  if (row.branch !== null) r.branch = row.branch;
  if (row.pr !== null) r.pr = row.pr;
  if (row.checkpoint !== null)
    r.checkpoint = JSON.parse(row.checkpoint) as Checkpoint;
  if (row.protected_hash !== null) r.protectedHash = row.protected_hash;
  return r;
}

/** SQLite に保存する実装。file に ":memory:" を渡すとメモリ上の DB になる */
export class SqliteStore implements Store {
  private readonly db: DatabaseSync;

  constructor(
    file: string,
    private readonly clock: Clock = systemClock,
  ) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  get(key: IssueKey): Promise<IssueRecord | undefined> {
    const row = this.db
      .prepare("SELECT * FROM issues WHERE repo = ? AND issue = ?")
      .get(key.repo, key.issue) as IssueRow | undefined;
    return Promise.resolve(row && fromRow(row));
  }

  async update(key: IssueKey, update: IssueUpdate): Promise<IssueRecord> {
    const now = this.clock();
    const current = (await this.get(key)) ?? emptyRecord(key, now);
    const next = applyUpdate(current, update, now);
    this.db
      .prepare(
        `INSERT INTO issues
           (repo, issue, rejections, objections, branch, pr, checkpoint, protected_hash, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (repo, issue) DO UPDATE SET
           rejections = excluded.rejections,
           objections = excluded.objections,
           branch = excluded.branch,
           pr = excluded.pr,
           checkpoint = excluded.checkpoint,
           protected_hash = excluded.protected_hash,
           updated_at = excluded.updated_at`,
      )
      .run(
        next.repo,
        next.issue,
        next.rejections,
        next.objections,
        next.branch ?? null,
        next.pr ?? null,
        next.checkpoint ? JSON.stringify(next.checkpoint) : null,
        next.protectedHash ?? null,
        next.updatedAt,
      );
    return next;
  }

  list(repo: string): Promise<IssueRecord[]> {
    const rows = this.db
      .prepare("SELECT * FROM issues WHERE repo = ? ORDER BY issue")
      .all(repo) as unknown as IssueRow[];
    return Promise.resolve(rows.map(fromRow));
  }

  addSummary(key: IssueKey, summary: Omit<Summary, "at">): Promise<Summary> {
    const s: Summary = { ...summary, at: this.clock().toISOString() };
    this.db
      .prepare(
        "INSERT INTO summaries (repo, issue, role, verdict, text, at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(key.repo, key.issue, s.role, s.verdict, s.text, s.at);
    return Promise.resolve(s);
  }

  summaries(key: IssueKey): Promise<Summary[]> {
    const rows = this.db
      .prepare(
        "SELECT role, verdict, text, at FROM summaries WHERE repo = ? AND issue = ? ORDER BY id",
      )
      .all(key.repo, key.issue) as unknown as Summary[];
    return Promise.resolve(rows.map((r) => ({ ...r })));
  }

  close(): Promise<void> {
    this.db.close();
    return Promise.resolve();
  }
}

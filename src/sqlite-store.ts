import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  applyRequirementUpdate,
  applyUpdate,
  type BlockedThreadInput,
  type BlockedThreadRecord,
  blockedThreadRecord,
  type Checkpoint,
  type Clock,
  compareMessageIds,
  type Decomposition,
  emptyRecord,
  emptyRequirement,
  type IssueKey,
  type IssueRecord,
  type IssueUpdate,
  REQUIREMENT_STATES,
  type RequirementRecord,
  type RequirementState,
  type RequirementUpdate,
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
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo, issue)
);
`;

interface BlockedThreadRow {
  repo: string;
  issue: number;
  reason: string;
  head_id: string | null;
  thread_id: string | null;
  copied: number;
  updated_at: string;
}

function blockedThreadFromRow(row: BlockedThreadRow): BlockedThreadRecord {
  const r: BlockedThreadRecord = {
    repo: row.repo,
    issue: row.issue,
    reason: row.reason,
    updatedAt: row.updated_at,
  };
  if (row.head_id !== null) r.headId = row.head_id;
  if (row.thread_id !== null) r.threadId = row.thread_id;
  if (row.copied !== 0) r.copied = true;
  return r;
}

interface RequirementRow {
  message_id: string;
  thread_id: string | null;
  state: string;
  questions: number;
  spec_pr: number | null;
  work_issues: string;
  decomposition: string | null;
  updated_at: string;
}

/** 前の版で作ったファイルに無い列を足す（既存の記録は壊さない） */
const ADDED_REQUIREMENT_COLUMNS: readonly { name: string; type: string }[] = [
  { name: "decomposition", type: "TEXT" },
];

/** 前の版で作った blocked_threads に無い列を足す */
const ADDED_BLOCKED_THREAD_COLUMNS: readonly { name: string; type: string }[] =
  [{ name: "head_id", type: "TEXT" }];

const decompositionSchema = z.object({
  issues: z.array(
    z.object({
      key: z.string(),
      title: z.string(),
      purpose: z.string(),
      acceptance: z.string(),
      screens: z.string(),
      outOfScope: z.string(),
      dependsOn: z.array(z.string()),
    }),
  ),
  specLinks: z.array(z.string()),
  created: z.array(
    z.object({
      key: z.string(),
      number: z.number(),
      url: z.string(),
      inProject: z.boolean(),
    }),
  ),
});

function parseDecomposition(text: string): Decomposition {
  const parsed = decompositionSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error(`分解の途中経過の記録が壊れています: ${text}`);
  }
  return parsed.data;
}

function isRequirementState(s: string): s is RequirementState {
  return (REQUIREMENT_STATES as readonly string[]).includes(s);
}

function parseWorkIssues(text: string): number[] {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value)) {
    throw new Error(`作業用 Issue の記録が壊れています: ${text}`);
  }
  const items: unknown[] = value;
  const issues: number[] = [];
  for (const n of items) {
    if (typeof n !== "number") {
      throw new Error(`作業用 Issue の記録が壊れています: ${text}`);
    }
    issues.push(n);
  }
  return issues;
}

function requirementFromRow(row: RequirementRow): RequirementRecord {
  if (!isRequirementState(row.state)) {
    throw new Error(`要件の状態の記録が壊れています: ${row.state}`);
  }
  const r: RequirementRecord = {
    messageId: row.message_id,
    state: row.state,
    questions: row.questions,
    workIssues: parseWorkIssues(row.work_issues),
    updatedAt: row.updated_at,
  };
  if (row.thread_id !== null) r.threadId = row.thread_id;
  if (row.spec_pr !== null) r.specPr = row.spec_pr;
  if (row.decomposition !== null) {
    r.decomposition = parseDecomposition(row.decomposition);
  }
  return r;
}

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
    this.addMissingColumns();
  }

  private addMissingColumns(): void {
    this.addColumns("requirements", ADDED_REQUIREMENT_COLUMNS);
    this.addColumns("blocked_threads", ADDED_BLOCKED_THREAD_COLUMNS);
  }

  private addColumns(
    table: string,
    added: readonly { name: string; type: string }[],
  ): void {
    const columns = this.db
      .prepare(`PRAGMA table_info(${table})`)
      .all() as unknown as { name: string }[];
    const names = new Set(columns.map((c) => c.name));
    for (const c of added) {
      if (!names.has(c.name)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${c.name} ${c.type}`);
      }
    }
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

  getRequirement(messageId: string): Promise<RequirementRecord | undefined> {
    const row = this.db
      .prepare("SELECT * FROM requirements WHERE message_id = ?")
      .get(messageId) as RequirementRow | undefined;
    return Promise.resolve(row && requirementFromRow(row));
  }

  async updateRequirement(
    messageId: string,
    update: RequirementUpdate,
  ): Promise<RequirementRecord> {
    const now = this.clock();
    const current =
      (await this.getRequirement(messageId)) ??
      emptyRequirement(messageId, now);
    const next = applyRequirementUpdate(current, update, now);
    this.db
      .prepare(
        `INSERT INTO requirements
           (message_id, thread_id, state, questions, spec_pr, work_issues, decomposition, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (message_id) DO UPDATE SET
           thread_id = excluded.thread_id,
           state = excluded.state,
           questions = excluded.questions,
           spec_pr = excluded.spec_pr,
           work_issues = excluded.work_issues,
           decomposition = excluded.decomposition,
           updated_at = excluded.updated_at`,
      )
      .run(
        next.messageId,
        next.threadId ?? null,
        next.state,
        next.questions,
        next.specPr ?? null,
        JSON.stringify(next.workIssues),
        next.decomposition ? JSON.stringify(next.decomposition) : null,
        next.updatedAt,
      );
    return structuredClone(next);
  }

  listRequirements(): Promise<RequirementRecord[]> {
    const rows = this.db
      .prepare("SELECT * FROM requirements")
      .all() as unknown as RequirementRow[];
    return Promise.resolve(
      rows
        .map(requirementFromRow)
        .sort((a, b) => compareMessageIds(a.messageId, b.messageId)),
    );
  }

  getReadPosition(channelId: string): Promise<string | undefined> {
    const row = this.db
      .prepare("SELECT message_id FROM read_positions WHERE channel_id = ?")
      .get(channelId) as { message_id: string } | undefined;
    return Promise.resolve(row?.message_id);
  }

  setReadPosition(channelId: string, messageId: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO read_positions (channel_id, message_id) VALUES (?, ?)
         ON CONFLICT (channel_id) DO UPDATE SET message_id = excluded.message_id`,
      )
      .run(channelId, messageId);
    return Promise.resolve();
  }

  getBlockedThread(key: IssueKey): Promise<BlockedThreadRecord | undefined> {
    const row = this.db
      .prepare("SELECT * FROM blocked_threads WHERE repo = ? AND issue = ?")
      .get(key.repo, key.issue) as BlockedThreadRow | undefined;
    return Promise.resolve(row && blockedThreadFromRow(row));
  }

  setBlockedThread(
    key: IssueKey,
    input: BlockedThreadInput,
  ): Promise<BlockedThreadRecord> {
    const r = blockedThreadRecord(key, input, this.clock());
    this.db
      .prepare(
        `INSERT INTO blocked_threads (repo, issue, reason, head_id, thread_id, copied, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (repo, issue) DO UPDATE SET
           reason = excluded.reason,
           head_id = excluded.head_id,
           thread_id = excluded.thread_id,
           copied = excluded.copied,
           updated_at = excluded.updated_at`,
      )
      .run(
        r.repo,
        r.issue,
        r.reason,
        r.headId ?? null,
        r.threadId ?? null,
        r.copied === true ? 1 : 0,
        r.updatedAt,
      );
    return Promise.resolve({ ...r });
  }

  deleteBlockedThread(key: IssueKey): Promise<void> {
    this.db
      .prepare("DELETE FROM blocked_threads WHERE repo = ? AND issue = ?")
      .run(key.repo, key.issue);
    return Promise.resolve();
  }

  listBlockedThreads(repo: string): Promise<BlockedThreadRecord[]> {
    const rows = this.db
      .prepare("SELECT * FROM blocked_threads WHERE repo = ? ORDER BY issue")
      .all(repo) as unknown as BlockedThreadRow[];
    return Promise.resolve(rows.map(blockedThreadFromRow));
  }

  close(): Promise<void> {
    this.db.close();
    return Promise.resolve();
  }
}

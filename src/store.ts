/**
 * 指揮役の記憶（Issue ごとの進行の記録）。
 * 段階（Projects の列）は GitHub を正とするので、ここには保存しない。
 * 保存先は Store インターフェースの後ろに隠し、差し替えられるようにする。
 */

/** 中断した段階 */
export const STAGES = [
  "testing",
  "implementing",
  "ci",
  "reviewing",
  "merging",
] as const;
export type Stage = (typeof STAGES)[number];

export interface IssueKey {
  /** owner/name */
  repo: string;
  issue: number;
}

/** 止まった位置。再開時はここから続ける */
export interface Checkpoint {
  stage: Stage;
  /** 停止理由（利用上限・Blocked の理由など） */
  reason?: string;
  /** この時刻まで待ってから再開する（ISO 8601） */
  resumeAt?: string;
}

export interface IssueRecord extends IssueKey {
  /** 差し戻しの回数（CI の失敗・レビューの指摘・ハッシュの不一致を合算） */
  rejections: number;
  /** 異議の回数 */
  objections: number;
  branch?: string;
  pr?: number;
  checkpoint?: Checkpoint;
  /** テスト役の完了時に記録した、受け入れテスト・seed・.conductor/ のハッシュ */
  protectedHash?: string;
  /** 最後に更新した時刻（ISO 8601） */
  updatedAt: string;
}

/** 書き換える項目。undefined を入れた項目は消す */
export type IssueUpdate = {
  [K in keyof Omit<IssueRecord, "repo" | "issue" | "updatedAt">]?:
    IssueRecord[K] | undefined;
};

/** 各役の結果の要約 */
export interface Summary {
  role: string;
  verdict: string;
  text: string;
  /** 記録した時刻（ISO 8601） */
  at: string;
}

export interface Store {
  get(key: IssueKey): Promise<IssueRecord | undefined>;
  /** 記録が無ければ回数0で作り、指定した項目だけ書き換える。undefined を渡した項目は消す */
  update(key: IssueKey, update: IssueUpdate): Promise<IssueRecord>;
  list(repo: string): Promise<IssueRecord[]>;
  addSummary(key: IssueKey, summary: Omit<Summary, "at">): Promise<Summary>;
  summaries(key: IssueKey): Promise<Summary[]>;
  close(): Promise<void>;
}

export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

export function emptyRecord(key: IssueKey, now: Date): IssueRecord {
  return {
    repo: key.repo,
    issue: key.issue,
    rejections: 0,
    objections: 0,
    updatedAt: now.toISOString(),
  };
}

/** update の規則（undefined は削除）を当てはめる */
export function applyUpdate(
  record: IssueRecord,
  update: IssueUpdate,
  now: Date,
): IssueRecord {
  const next: Record<string, unknown> = { ...record };
  for (const [k, v] of Object.entries(update)) {
    if (v === undefined) delete next[k];
    else next[k] = v;
  }
  next.updatedAt = now.toISOString();
  return next as unknown as IssueRecord;
}

/** テスト用のメモリ上の実装 */
export class MemoryStore implements Store {
  private readonly records = new Map<string, IssueRecord>();
  private readonly log = new Map<string, Summary[]>();

  constructor(private readonly clock: Clock = systemClock) {}

  private id(key: IssueKey): string {
    return `${key.repo}#${key.issue}`;
  }

  get(key: IssueKey): Promise<IssueRecord | undefined> {
    const r = this.records.get(this.id(key));
    return Promise.resolve(r && structuredClone(r));
  }

  update(key: IssueKey, update: IssueUpdate): Promise<IssueRecord> {
    const now = this.clock();
    const current = this.records.get(this.id(key)) ?? emptyRecord(key, now);
    const next = applyUpdate(current, structuredClone(update), now);
    this.records.set(this.id(key), next);
    return Promise.resolve(structuredClone(next));
  }

  list(repo: string): Promise<IssueRecord[]> {
    return Promise.resolve(
      [...this.records.values()]
        .filter((r) => r.repo === repo)
        .sort((a, b) => a.issue - b.issue)
        .map((r) => structuredClone(r)),
    );
  }

  addSummary(key: IssueKey, summary: Omit<Summary, "at">): Promise<Summary> {
    const s: Summary = { ...summary, at: this.clock().toISOString() };
    const list = this.log.get(this.id(key)) ?? [];
    list.push(s);
    this.log.set(this.id(key), list);
    return Promise.resolve({ ...s });
  }

  summaries(key: IssueKey): Promise<Summary[]> {
    return Promise.resolve(
      (this.log.get(this.id(key)) ?? []).map((s) => ({ ...s })),
    );
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

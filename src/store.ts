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
  /** 人の承認待ち（merge.approval: human） */
  "approving",
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
  /** 人の承認待ち（merge.approval: human）のときの情報 */
  approval?: ApprovalWait;
}

export interface ApprovalWait {
  /** 承認待ちになった時刻（ISO 8601）。これより後のコメントだけを見る */
  since: string;
  /** レビューした時点の PR の先頭コミット */
  sha: string;
  /** ここまでに書かれたコメントは確認済み（ISO 8601） */
  checked: string;
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

/** 要件の状態 */
export const REQUIREMENT_STATES = [
  /** 仕様化中 */
  "specifying",
  /** 承認待ち */
  "awaiting_approval",
  /** 作業中 */
  "working",
  /** 完了 */
  "done",
] as const;
export type RequirementState = (typeof REQUIREMENT_STATES)[number];

/** 要件ごとの進み具合の記録 */
export interface RequirementRecord {
  /** 要件の投稿 ID（記録のキー） */
  messageId: string;
  /** 要件のスレッド ID */
  threadId?: string;
  state: RequirementState;
  /** 質問の数 */
  questions: number;
  /** 仕様の PR の番号 */
  specPr?: number;
  /** 作業用 Issue の番号（配列の順が作業の順番） */
  workIssues: number[];
  /** 最後に更新した時刻（ISO 8601） */
  updatedAt: string;
}

/** 書き換える項目。undefined を入れた省略できる項目（threadId・specPr）は消す */
export type RequirementUpdate = {
  [K in keyof Omit<RequirementRecord, "messageId" | "updatedAt">]?:
    RequirementRecord[K] | undefined;
};

export interface Store {
  get(key: IssueKey): Promise<IssueRecord | undefined>;
  /** 記録が無ければ回数0で作り、指定した項目だけ書き換える。undefined を渡した項目は消す */
  update(key: IssueKey, update: IssueUpdate): Promise<IssueRecord>;
  list(repo: string): Promise<IssueRecord[]>;
  addSummary(key: IssueKey, summary: Omit<Summary, "at">): Promise<Summary>;
  summaries(key: IssueKey): Promise<Summary[]>;
  getRequirement(messageId: string): Promise<RequirementRecord | undefined>;
  /** 記録が無ければ仕様化中・質問0・作業用 Issue なしで作り、指定した項目だけ書き換える */
  updateRequirement(
    messageId: string,
    update: RequirementUpdate,
  ): Promise<RequirementRecord>;
  /** すべての要件を投稿 ID の古い順に返す */
  listRequirements(): Promise<RequirementRecord[]>;
  /** チャンネルまたはスレッドごとの、最後に読んだ投稿 ID */
  getReadPosition(channelId: string): Promise<string | undefined>;
  setReadPosition(channelId: string, messageId: string): Promise<void>;
  close(): Promise<void>;
}

export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

export function emptyRequirement(
  messageId: string,
  now: Date,
): RequirementRecord {
  return {
    messageId,
    state: "specifying",
    questions: 0,
    workIssues: [],
    updatedAt: now.toISOString(),
  };
}

/**
 * updateRequirement の規則を当てはめる。
 * 省略できる項目（threadId・specPr）は undefined で消し、
 * 省略できない項目（state・questions・workIssues）は undefined なら今の値のまま。
 */
export function applyRequirementUpdate(
  record: RequirementRecord,
  update: RequirementUpdate,
  now: Date,
): RequirementRecord {
  const next: RequirementRecord = {
    messageId: record.messageId,
    state: update.state ?? record.state,
    questions: update.questions ?? record.questions,
    workIssues: [...(update.workIssues ?? record.workIssues)],
    updatedAt: now.toISOString(),
  };
  const threadId = "threadId" in update ? update.threadId : record.threadId;
  if (threadId !== undefined) next.threadId = threadId;
  const specPr = "specPr" in update ? update.specPr : record.specPr;
  if (specPr !== undefined) next.specPr = specPr;
  return next;
}

/** 投稿 ID（Discord の snowflake）を古い順に並べるための比較。数字でなければ文字列で比べる */
export function compareMessageIds(a: string, b: string): number {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function cloneRequirement(r: RequirementRecord): RequirementRecord {
  return { ...r, workIssues: [...r.workIssues] };
}

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
  private readonly requirements = new Map<string, RequirementRecord>();
  private readonly readPositions = new Map<string, string>();

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

  getRequirement(messageId: string): Promise<RequirementRecord | undefined> {
    const r = this.requirements.get(messageId);
    return Promise.resolve(r && cloneRequirement(r));
  }

  updateRequirement(
    messageId: string,
    update: RequirementUpdate,
  ): Promise<RequirementRecord> {
    const now = this.clock();
    const current =
      this.requirements.get(messageId) ?? emptyRequirement(messageId, now);
    const next = applyRequirementUpdate(current, update, now);
    this.requirements.set(messageId, next);
    return Promise.resolve(cloneRequirement(next));
  }

  listRequirements(): Promise<RequirementRecord[]> {
    return Promise.resolve(
      [...this.requirements.values()]
        .sort((a, b) => compareMessageIds(a.messageId, b.messageId))
        .map(cloneRequirement),
    );
  }

  getReadPosition(channelId: string): Promise<string | undefined> {
    return Promise.resolve(this.readPositions.get(channelId));
  }

  setReadPosition(channelId: string, messageId: string): Promise<void> {
    this.readPositions.set(channelId, messageId);
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

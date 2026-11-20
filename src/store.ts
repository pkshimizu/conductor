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
  /**
   * 今の段階（checkpoint.stage）を始めた時刻（ISO 8601）。
   * store の update が、checkpoint.stage が変わったときだけ入れる（同じ段階の書き直し・再開では変えない）
   */
  stageStartedAt?: string;
  /** 最後に更新した時刻（ISO 8601） */
  updatedAt: string;
}

/** update で書き換えない項目（store が入れる） */
type StoreManagedKey = "repo" | "issue" | "updatedAt" | "stageStartedAt";

/** 書き換える項目。undefined を入れた項目は消す */
export type IssueUpdate = {
  [K in keyof Omit<IssueRecord, StoreManagedKey>]?: IssueRecord[K] | undefined;
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
  /** 止めた（作業用 Issue に分けられなかったなど。人が確かめる） */
  "blocked",
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
  /**
   * 作業用 Issue の番号（配列の順が作業の順番）。
   * Issue をすべて作り、一覧をスレッドに書き終えてから入れる（入っていれば分解済み）
   */
  workIssues: number[];
  /** 分解の途中経過（Issue を作り始めてから、一覧を書き終えるまで） */
  decomposition?: Decomposition;
  /** 最後に更新した時刻（ISO 8601） */
  updatedAt: string;
}

/** 分解役が返した作業用 Issue 1件分（decomposer.ts の WorkIssue と同じ形） */
export interface DecompositionIssue {
  key: string;
  title: string;
  purpose: string;
  acceptance: string;
  screens: string;
  outOfScope: string;
  dependsOn: string[];
}

/** 作り終えた作業用 Issue */
export interface CreatedWorkIssue {
  /** 分解役が付けた key */
  key: string;
  number: number;
  url: string;
  /** Project に追加し終えたか */
  inProject: boolean;
}

/**
 * 分解の途中経過。途中で失敗しても、再開のときに分解役を起動し直さず、
 * 作っていない Issue だけを作れるようにする
 */
export interface Decomposition {
  /** 作業の順番に並べた作業用 Issue（確かめ済み） */
  issues: DecompositionIssue[];
  /** 本文に付ける仕様ファイルへのリンク */
  specLinks: string[];
  /** 作り終えた Issue（作った順） */
  created: CreatedWorkIssue[];
}

/** 書き換える項目。undefined を入れた省略できる項目（threadId・specPr・decomposition）は消す */
export type RequirementUpdate = {
  [K in keyof Omit<RequirementRecord, "messageId" | "updatedAt">]?:
    RequirementRecord[K] | undefined;
};

/**
 * Blocked にした Issue の、人に対応を確かめるスレッドの記録（窓口があるときだけ使う）。
 * Blocked にしたときに理由だけで作り、次の確認で質問チャンネルにスレッドを作って threadId を入れる。
 * 人が方針を書くか、GitHub で Blocked の列から出したら消す
 */
export interface BlockedThreadRecord extends IssueKey {
  /** 止まった理由（最後のエラー） */
  reason: string;
  /** 質問チャンネルに書いた、スレッドのもとの投稿。まだ書いていなければ undefined（スレッドを作る途中で失敗しても、投稿を重ねないため） */
  headId?: string;
  /** 質問チャンネルに作ったスレッド。まだ作っていなければ undefined */
  threadId?: string;
  /** スレッドの方針を Issue に書き写したか（Ready に戻す途中で失敗しても、二重に書き写さないため） */
  copied?: true;
  /** 方針を受けて仕様を作り直したときの記録（作り直した仕様の ✅ を待つ間） */
  respec?: RespecProgress;
  /** 最後に更新した時刻（ISO 8601） */
  updatedAt: string;
}

/** 方針を受けて作り直した仕様（respec.ts） */
export interface RespecProgress {
  /** 仕様化役に渡した方針 */
  policy: string;
  /** 仕様化役の要約（変更点。Issue に書き写す） */
  summary: string;
  /** 作り直した仕様の PR */
  pr: number;
  url: string;
  /** スレッドに書いた要約の投稿 ID（この投稿への ✅ を承認とする） */
  summaryId: string;
}

/** 書き込む項目 */
export interface BlockedThreadInput {
  reason: string;
  headId?: string;
  threadId?: string;
  copied?: true;
  respec?: RespecProgress;
}

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
  getBlockedThread(key: IssueKey): Promise<BlockedThreadRecord | undefined>;
  /** Issue の記録を置き換える（無ければ作る） */
  setBlockedThread(
    key: IssueKey,
    input: BlockedThreadInput,
  ): Promise<BlockedThreadRecord>;
  deleteBlockedThread(key: IssueKey): Promise<void>;
  /** リポジトリの記録を Issue の番号の順に返す */
  listBlockedThreads(repo: string): Promise<BlockedThreadRecord[]>;
  close(): Promise<void>;
}

export function blockedThreadRecord(
  key: IssueKey,
  input: BlockedThreadInput,
  now: Date,
): BlockedThreadRecord {
  const r: BlockedThreadRecord = {
    repo: key.repo,
    issue: key.issue,
    reason: input.reason,
    updatedAt: now.toISOString(),
  };
  if (input.headId !== undefined) r.headId = input.headId;
  if (input.threadId !== undefined) r.threadId = input.threadId;
  if (input.copied === true) r.copied = true;
  if (input.respec !== undefined) r.respec = { ...input.respec };
  return r;
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
  const decomposition =
    "decomposition" in update ? update.decomposition : record.decomposition;
  if (decomposition !== undefined) {
    next.decomposition = structuredClone(decomposition);
  }
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
  return structuredClone(r);
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

/**
 * update の規則（undefined は削除）を当てはめる。
 * checkpoint.stage が今の記録と変わったとき（または段階を始めた時刻が無いとき）だけ、
 * stageStartedAt を now にする。checkpoint を消したら stageStartedAt も消す
 */
export function applyUpdate(
  record: IssueRecord,
  update: IssueUpdate,
  now: Date,
): IssueRecord {
  const next: Record<string, unknown> = { ...record };
  for (const [k, v] of Object.entries(update)) {
    if (k === "stageStartedAt") continue;
    if (v === undefined) delete next[k];
    else next[k] = v;
  }
  const result = next as unknown as IssueRecord;
  result.updatedAt = now.toISOString();
  const stage = result.checkpoint?.stage;
  if (stage === undefined) {
    delete result.stageStartedAt;
  } else if (
    stage !== record.checkpoint?.stage ||
    record.stageStartedAt === undefined
  ) {
    result.stageStartedAt = now.toISOString();
  }
  return result;
}

/** テスト用のメモリ上の実装 */
export class MemoryStore implements Store {
  private readonly records = new Map<string, IssueRecord>();
  private readonly log = new Map<string, Summary[]>();
  private readonly requirements = new Map<string, RequirementRecord>();
  private readonly readPositions = new Map<string, string>();
  private readonly blocked = new Map<string, BlockedThreadRecord>();

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

  getBlockedThread(key: IssueKey): Promise<BlockedThreadRecord | undefined> {
    const r = this.blocked.get(this.id(key));
    return Promise.resolve(r && structuredClone(r));
  }

  setBlockedThread(
    key: IssueKey,
    input: BlockedThreadInput,
  ): Promise<BlockedThreadRecord> {
    const r = blockedThreadRecord(key, input, this.clock());
    this.blocked.set(this.id(key), r);
    return Promise.resolve(structuredClone(r));
  }

  deleteBlockedThread(key: IssueKey): Promise<void> {
    this.blocked.delete(this.id(key));
    return Promise.resolve();
  }

  listBlockedThreads(repo: string): Promise<BlockedThreadRecord[]> {
    return Promise.resolve(
      [...this.blocked.values()]
        .filter((r) => r.repo === repo)
        .sort((a, b) => a.issue - b.issue)
        .map((r) => structuredClone(r)),
    );
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

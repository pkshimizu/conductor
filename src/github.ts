/**
 * GitHub を操作する部品。gh コマンド（gh api）を通して REST と GraphQL を呼ぶ。
 * - 段階は GitHub Projects の状態欄（Status）の列で表す
 * - 人とのやり取りは Issue のコメント（必要ならメンション付き）
 */
import type { PrComment } from "./approval.js";
import type { Config } from "./config.js";
import { commandExec, type Exec } from "./exec.js";
import type { WorkIssueStatus } from "./progress.js";

/** Projects の状態欄の名前（GitHub の既定） */
export const STATUS_FIELD = "Status";

export interface ProjectIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  /** 状態欄の値。未設定なら null */
  column: string | null;
  /** GitHub の更新日時（ISO 8601）。取れなければ省く */
  updatedAt?: string;
}

export interface ListIssuesOptions {
  /** 閉じた Issue も含める（タスク一覧で Done の Issue も出すため）。既定は開いた Issue だけ */
  includeClosed?: boolean;
}

export type CiState = "pending" | "success" | "failure";

export interface CiCheck {
  name: string;
  /** gh の分類：pass / fail / pending / skipping / cancel */
  bucket: string;
  link: string;
}

export interface CiResult {
  state: CiState;
  checks: CiCheck[];
  /** 失敗したときのログの要点 */
  failureLog?: string;
}

export interface PullRequest {
  number: number;
  url: string;
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

export interface GitHubOptions {
  /** owner/name */
  repo: string;
  /** Projects の番号 */
  project: number;
  /** メンションする GitHub ユーザー名（@ なし） */
  notify: string;
  exec?: Exec;
}

interface ProjectMeta {
  projectId: string;
  fieldId: string;
  /** 列名 → 選択肢の ID */
  options: Map<string, string>;
}

/** ログの要点として残す行数 */
const LOG_TAIL_LINES = 60;
/** REST API の1ページの件数 */
const PAGE_SIZE = 100;

export class GitHub {
  readonly repo: string;
  readonly owner: string;
  readonly name: string;
  private readonly project: number;
  private readonly notify: string;
  private readonly exec: Exec;
  private meta?: ProjectMeta;
  private defaultBranch?: string;

  constructor(options: GitHubOptions) {
    this.repo = options.repo;
    const [owner, name] = options.repo.split("/");
    if (!owner || !name) {
      throw new GitHubError(`repo は owner/name の形です: ${options.repo}`);
    }
    this.owner = owner;
    this.name = name;
    this.project = options.project;
    this.notify = options.notify;
    this.exec = options.exec ?? commandExec("gh");
  }

  // ---- AC1: 列ごとの Issue ----

  /** Projects にある、このリポジトリの開いた Issue（列つき）。includeClosed なら閉じた Issue も */
  async listIssues(options: ListIssuesOptions = {}): Promise<ProjectIssue[]> {
    const { projectId } = await this.loadMeta();
    const issues: ProjectIssue[] = [];
    let after: string | null = null;
    for (;;) {
      const data: ItemsPage = await this.graphql<ItemsPage>(ITEMS_QUERY, {
        id: projectId,
        after,
        field: STATUS_FIELD,
      });
      const items = data.node?.items;
      if (!items) throw new GitHubError("Projects の項目を取れませんでした");
      for (const item of items.nodes) {
        const c = item.content;
        if (!c || c.number === undefined) continue; // 下書きや PR
        if (c.repository?.nameWithOwner !== this.repo) continue;
        if (c.state !== "OPEN" && !options.includeClosed) continue;
        issues.push({
          number: c.number,
          title: c.title ?? "",
          body: c.body ?? "",
          labels: (c.labels?.nodes ?? []).map((l) => l.name),
          column: item.fieldValueByName?.name ?? null,
          ...(c.updatedAt === undefined ? {} : { updatedAt: c.updatedAt }),
        });
      }
      if (!items.pageInfo.hasNextPage) break;
      after = items.pageInfo.endCursor;
    }
    return issues;
  }

  /** 列ごとにまとめる */
  async issuesByColumn(
    options: ListIssuesOptions = {},
  ): Promise<Map<string, ProjectIssue[]>> {
    const map = new Map<string, ProjectIssue[]>();
    for (const issue of await this.listIssues(options)) {
      const key = issue.column ?? "";
      map.set(key, [...(map.get(key) ?? []), issue]);
    }
    return map;
  }

  // ---- AC2: 列の移動とコメント ----

  /** Issue を列に移す。Projects に無ければ追加する */
  async moveIssue(issue: number, column: string): Promise<void> {
    const meta = await this.loadMeta();
    const optionId = meta.options.get(column);
    if (!optionId) {
      throw new GitHubError(
        `Projects の ${STATUS_FIELD} に「${column}」がありません（あるもの: ${[...meta.options.keys()].join("、")}）`,
      );
    }
    const itemId = await this.ensureItem(issue, meta.projectId);
    await this.graphql(MOVE_MUTATION, {
      project: meta.projectId,
      item: itemId,
      field: meta.fieldId,
      option: optionId,
    });
  }

  /** Issue（や PR）にコメントする。mention なら通知先をメンションする */
  async comment(
    issue: number,
    body: string,
    options: { mention?: boolean } = {},
  ): Promise<void> {
    const text = options.mention ? `@${this.notify} ${body}` : body;
    await this.rest("POST", `repos/${this.repo}/issues/${issue}/comments`, {
      body: text,
    });
  }

  // ---- AC3: PR ----

  /** PR を作る。issue を渡すと、その Issue を閉じる PR にする（仕様の PR は Issue に紐づかない） */
  async createPullRequest(input: {
    issue?: number;
    head: string;
    title: string;
    body: string;
    base?: string;
  }): Promise<PullRequest> {
    const base = input.base ?? (await this.baseBranch());
    const closes =
      input.issue === undefined ? "" : `\n\nCloses #${input.issue}`;
    const pr = await this.rest<{ number: number; html_url: string }>(
      "POST",
      `repos/${this.repo}/pulls`,
      {
        title: input.title,
        head: input.head,
        base,
        body: `${input.body.trimEnd()}${closes}\n`,
      },
    );
    return { number: pr.number, url: pr.html_url };
  }

  /** ブランチの開いた PR を探す */
  async findPullRequest(head: string): Promise<PullRequest | undefined> {
    const list = await this.rest<{ number: number; html_url: string }[]>(
      "GET",
      `repos/${this.repo}/pulls?state=open&head=${encodeURIComponent(`${this.owner}:${head}`)}`,
    );
    const pr = list[0];
    return pr && { number: pr.number, url: pr.html_url };
  }

  /** PR で変えたファイルのパス（全ページ） */
  async pullRequestFiles(pr: number): Promise<string[]> {
    const files: string[] = [];
    for (let page = 1; ; page++) {
      const list = await this.rest<{ filename: string }[]>(
        "GET",
        `repos/${this.repo}/pulls/${pr}/files?per_page=${PAGE_SIZE}&page=${page}`,
      );
      files.push(...list.map((f) => f.filename));
      if (list.length < PAGE_SIZE) break;
    }
    return files;
  }

  // ---- 分解役（decomposer.ts） ----

  /** Issue を作る */
  async createIssue(input: {
    title: string;
    body: string;
  }): Promise<{ number: number; url: string }> {
    const issue = await this.rest<{ number: number; html_url: string }>(
      "POST",
      `repos/${this.repo}/issues`,
      { title: input.title, body: input.body },
    );
    return { number: issue.number, url: issue.html_url };
  }

  /** Issue を Projects に追加する（列は動かさない）。追加済みなら何もしない */
  async addToProject(issue: number): Promise<void> {
    const { projectId } = await this.loadMeta();
    await this.ensureItem(issue, projectId);
  }

  // ---- 着手と完了（progress.ts） ----

  /**
   * 作業用 Issue 1件の今の様子（この Project の状態欄・本文・この Issue を閉じたマージ済みの PR）。
   * 閉じた Issue でも取れる
   */
  async workIssueStatus(issue: number): Promise<WorkIssueStatus | undefined> {
    const { projectId } = await this.loadMeta();
    const data = await this.graphql<IssueStatusResult>(
      ISSUE_STATUS_QUERY,
      {
        owner: this.owner,
        name: this.name,
        number: issue,
        field: STATUS_FIELD,
      },
      { allowNotFound: true },
    );
    if (!data.repository) {
      throw new GitHubError(`リポジトリ ${this.repo} が見つかりません`);
    }
    // リポジトリに無い番号（PR の番号を含む）
    const node = data.repository.issue;
    if (!node) return undefined;
    const item = node.projectItems.nodes.find(
      (i) => i.project.id === projectId,
    );
    const column = item?.fieldValueByName?.name;
    const merged = node.closedByPullRequestsReferences.nodes.find(
      (pr) => pr.merged,
    );
    return {
      body: node.body,
      ...(column === undefined ? {} : { column }),
      ...(merged === undefined
        ? {}
        : { merged: { number: merged.number, url: merged.url } }),
      closed: node.state === "CLOSED",
    };
  }

  // ---- AC4: CI ----

  async ciStatus(pr: number): Promise<CiResult> {
    // 失敗（1）や実行中（8）でも終了コードが 0 以外になるので、出力で判断する
    const res = await this.exec(
      [
        "pr",
        "checks",
        String(pr),
        "-R",
        this.repo,
        "--json",
        "name,bucket,link",
      ],
      {},
    );
    if (res.stdout.trim() === "") {
      if (/no checks reported/i.test(res.stderr)) {
        return { state: "pending", checks: [] };
      }
      throw new GitHubError("CI の結果を取れませんでした", res.stderr.trim());
    }
    const checks = JSON.parse(res.stdout) as CiCheck[];
    const state = summarizeChecks(checks);
    if (state !== "failure") return { state, checks };
    const logs: string[] = [];
    for (const c of checks) {
      if (c.bucket !== "fail" && c.bucket !== "cancel") continue;
      logs.push(`## ${c.name}\n${await this.failureLog(c.link)}`);
    }
    return { state, checks, failureLog: logs.join("\n\n") };
  }

  private async failureLog(link: string): Promise<string> {
    const job = /\/job\/(\d+)/.exec(link)?.[1];
    if (!job) return `（ログの場所が分かりません: ${link}）`;
    const res = await this.exec(
      ["run", "view", "--job", job, "--log-failed", "-R", this.repo],
      {},
    );
    if (res.code === 0) return tailLog(res.stdout, LOG_TAIL_LINES);
    // 他のジョブが動いている間は --log-failed が使えない。
    // 終わったジョブのログは API で取れるので、そちらで代わりに取る
    const api = await this.exec(
      [
        "api",
        "--allow-escape-sequences",
        `repos/${this.repo}/actions/jobs/${job}/logs`,
      ],
      {},
    );
    if (api.code !== 0)
      return `（ログを取れませんでした: ${res.stderr.trim()}）`;
    return tailLog(untilLastError(api.stdout), LOG_TAIL_LINES);
  }

  // ---- AC5: マージ ----

  /** PR を squash でマージし、Issue を完了列に移す */
  async merge(pr: number, issue: number, doneColumn: string): Promise<void> {
    await this.mergePullRequest(pr);
    await this.moveIssue(issue, doneColumn);
  }

  /**
   * PR を squash でマージするだけ（列は動かさない。Issue に紐づかない仕様の PR に使う）。
   * 前の確認でマージ済みの PR は成功として扱う（途中で失敗した確認を繰り返せるように）
   */
  async mergePullRequest(pr: number): Promise<void> {
    const res = await this.exec(
      ["pr", "merge", String(pr), "--squash", "-R", this.repo],
      {},
    );
    if (res.code === 0) return;
    if (await this.isMerged(pr)) return;
    throw new GitHubError(
      `PR #${pr} をマージできませんでした`,
      res.stderr.trim(),
    );
  }

  /** PR がマージ済みか。確かめられなければ false */
  async isMerged(pr: number): Promise<boolean> {
    try {
      const res = await this.rest<{ merged?: boolean }>(
        "GET",
        `repos/${this.repo}/pulls/${pr}`,
      );
      return res.merged === true;
    } catch {
      return false;
    }
  }

  // ---- マージの承認（approval.ts） ----

  /** PR の先頭コミット */
  async headSha(pr: number): Promise<string> {
    const res = await this.rest<{ head: { sha: string } }>(
      "GET",
      `repos/${this.repo}/pulls/${pr}`,
    );
    return res.head.sha;
  }

  /** PR がベースブランチと衝突しているか。GitHub が計算中（null）のときは衝突なしとみなす */
  async hasConflict(pr: number): Promise<boolean> {
    const res = await this.rest<{ mergeable: boolean | null }>(
      "GET",
      `repos/${this.repo}/pulls/${pr}`,
    );
    return res.mergeable === false;
  }

  /** PR の会話・行へのコメント・レビュー本文をまとめて返す（新しい100件まで） */
  async prComments(pr: number): Promise<PrComment[]> {
    type Raw = {
      user: { login: string } | null;
      body: string | null;
      created_at?: string;
      submitted_at?: string;
      path?: string;
      line?: number | null;
    };
    const base = `repos/${this.repo}`;
    const [issue, lines, reviews] = await Promise.all([
      this.rest<Raw[]>("GET", `${base}/issues/${pr}/comments?per_page=100`),
      this.rest<Raw[]>("GET", `${base}/pulls/${pr}/comments?per_page=100`),
      this.rest<Raw[]>("GET", `${base}/pulls/${pr}/reviews?per_page=100`),
    ]);
    const out: PrComment[] = [];
    for (const c of [...issue, ...lines, ...reviews]) {
      const createdAt = c.created_at ?? c.submitted_at;
      if (!c.user || !c.body?.trim() || !createdAt) continue;
      out.push({
        author: c.user.login,
        body: c.body,
        createdAt,
        ...(c.path !== undefined && { path: c.path, line: c.line ?? null }),
      });
    }
    return out;
  }

  /** リポジトリに書き込み権限があるか（共同作業者でなければ false） */
  async canWrite(user: string): Promise<boolean> {
    try {
      const res = await this.rest<{ permission: string }>(
        "GET",
        `repos/${this.repo}/collaborators/${encodeURIComponent(user)}/permission`,
      );
      return res.permission === "admin" || res.permission === "write";
    } catch (e) {
      if (e instanceof GitHubError) return false;
      throw e;
    }
  }

  // ---- 下回り ----

  private async loadMeta(): Promise<ProjectMeta> {
    if (this.meta) return this.meta;
    let project: MetaProject | null | undefined;
    for (const kind of ["user", "organization"] as const) {
      const data = await this.graphql<MetaResult>(
        META_QUERY(kind),
        { owner: this.owner, number: this.project, field: STATUS_FIELD },
        { allowErrors: true },
      );
      project = data?.[kind]?.projectV2;
      if (project) break;
    }
    if (!project) {
      throw new GitHubError(
        `Projects #${this.project}（${this.owner}）が見つかりません`,
      );
    }
    if (!project.field?.options) {
      throw new GitHubError(
        `Projects #${this.project} に単一選択の「${STATUS_FIELD}」欄がありません`,
      );
    }
    this.meta = {
      projectId: project.id,
      fieldId: project.field.id,
      options: new Map(project.field.options.map((o) => [o.name, o.id])),
    };
    return this.meta;
  }

  private async ensureItem(issue: number, projectId: string): Promise<string> {
    const data = await this.graphql<IssueItems>(ISSUE_ITEMS_QUERY, {
      owner: this.owner,
      name: this.name,
      number: issue,
    });
    const node = data.repository?.issue;
    if (!node) throw new GitHubError(`Issue #${issue} が見つかりません`);
    const found = node.projectItems.nodes.find(
      (i) => i.project.id === projectId,
    );
    if (found) return found.id;
    const added = await this.graphql<AddItem>(ADD_ITEM_MUTATION, {
      project: projectId,
      content: node.id,
    });
    return added.addProjectV2ItemById.item.id;
  }

  /** 既定のブランチ（PR のマージ先） */
  async baseBranch(): Promise<string> {
    if (!this.defaultBranch) {
      const repo = await this.rest<{ default_branch: string }>(
        "GET",
        `repos/${this.repo}`,
      );
      this.defaultBranch = repo.default_branch;
    }
    return this.defaultBranch;
  }

  /** REST API。本文は標準入力で渡す */
  async rest<T = unknown>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const args = ["api", path, "--method", method];
    if (body !== undefined) args.push("--input", "-");
    const res = await this.exec(args, {
      ...(body !== undefined && { input: JSON.stringify(body) }),
    });
    if (res.code !== 0) {
      throw new GitHubError(
        `GitHub API（${method} ${path}）が失敗しました`,
        `${res.stderr}\n${res.stdout}`.trim(),
      );
    }
    return (res.stdout.trim() ? JSON.parse(res.stdout) : undefined) as T;
  }

  /** GraphQL API */
  async graphql<T>(
    query: string,
    variables: Record<string, unknown>,
    options: {
      allowErrors?: boolean;
      /** 見つからない（type が NOT_FOUND の）エラーだけなら失敗にしない */
      allowNotFound?: boolean;
    } = {},
  ): Promise<T> {
    const res = await this.exec(["api", "graphql", "--input", "-"], {
      input: JSON.stringify({ query, variables }),
    });
    let parsed:
      { data?: T; errors?: { message: string; type?: string }[] } | undefined;
    try {
      parsed = res.stdout.trim() ? JSON.parse(res.stdout) : undefined;
    } catch {
      parsed = undefined;
    }
    const errors = (parsed?.errors ?? []).filter(
      (e) => !(options.allowNotFound === true && e.type === "NOT_FOUND"),
    );
    if (errors.length > 0 && !options.allowErrors) {
      throw new GitHubError(
        "GitHub GraphQL がエラーを返しました",
        errors.map((e) => e.message).join("\n"),
      );
    }
    if (!parsed?.data && !options.allowErrors) {
      throw new GitHubError(
        "GitHub GraphQL が失敗しました",
        `${res.stderr}\n${res.stdout}`.trim(),
      );
    }
    return parsed?.data as T;
  }
}

/** 失敗・取り消しが1つでもあれば failure、実行中か未報告があれば pending */
export function summarizeChecks(checks: CiCheck[]): CiState {
  if (checks.length === 0) return "pending";
  if (checks.some((c) => c.bucket === "fail" || c.bucket === "cancel")) {
    return "failure";
  }
  if (checks.some((c) => c.bucket === "pending")) return "pending";
  return "success";
}

/** 色付けの制御文字 */
const ANSI_COLOR = new RegExp(String.raw`\u001b\[[0-9;]*m`, "g");

/** gh run view --log-failed の出力から、ジョブ名・手順名・時刻を外して末尾を残す */
export function tailLog(log: string, lines: number): string {
  const cleaned = log
    .split(/\r?\n/)
    .map((l) => {
      const cols = l.split("\t");
      const msg = cols.length >= 3 ? cols.slice(2).join("\t") : l;
      return msg
        .replace(/^\uFEFF?\d{4}-\d{2}-\d{2}T[\d:.]+Z ?/, "")
        .replace(ANSI_COLOR, "");
    })
    .filter((l) => l.trim() !== "");
  return cleaned.slice(-lines).join("\n");
}

/**
 * ジョブ全体のログから、最後の ##[error] 行までを残す。
 * その後ろは後片付けの手順（checkout の Post など）で、失敗の手掛かりにならない
 */
export function untilLastError(log: string): string {
  const lines = log.split(/\r?\n/);
  let last = -1;
  lines.forEach((l, i) => {
    if (l.includes("##[error]")) last = i;
  });
  return last < 0 ? log : lines.slice(0, last + 1).join("\n");
}

/** 設定（.conductor/config.yaml の github）から作る */
export function githubFromConfig(config: Config, exec?: Exec): GitHub {
  const { repo, project, notify } = config.github;
  return new GitHub({ repo, project, notify, ...(exec && { exec }) });
}

// ---- GraphQL ----

interface MetaProject {
  id: string;
  field: { id: string; options?: { id: string; name: string }[] } | null;
}
type MetaResult = Partial<
  Record<"user" | "organization", { projectV2: MetaProject | null } | null>
>;

const META_QUERY = (kind: "user" | "organization") => `
query($owner: String!, $number: Int!, $field: String!) {
  ${kind}(login: $owner) {
    projectV2(number: $number) {
      id
      field(name: $field) {
        ... on ProjectV2SingleSelectField { id options { id name } }
      }
    }
  }
}`;

interface ItemsPage {
  node: {
    items: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: {
        fieldValueByName: { name?: string } | null;
        content: {
          number?: number;
          title?: string;
          body?: string;
          state?: string;
          updatedAt?: string;
          repository?: { nameWithOwner: string };
          labels?: { nodes: { name: string }[] };
        } | null;
      }[];
    };
  } | null;
}

const ITEMS_QUERY = `
query($id: ID!, $after: String, $field: String!) {
  node(id: $id) {
    ... on ProjectV2 {
      items(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          fieldValueByName(name: $field) {
            ... on ProjectV2ItemFieldSingleSelectValue { name }
          }
          content {
            ... on Issue {
              number title body state updatedAt
              repository { nameWithOwner }
              labels(first: 50) { nodes { name } }
            }
          }
        }
      }
    }
  }
}`;

interface IssueItems {
  repository: {
    issue: {
      id: string;
      projectItems: { nodes: { id: string; project: { id: string } }[] };
    } | null;
  } | null;
}

const ISSUE_ITEMS_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      id
      projectItems(first: 50) { nodes { id project { id } } }
    }
  }
}`;

interface IssueStatusResult {
  repository: {
    issue: {
      body: string;
      state: "OPEN" | "CLOSED";
      projectItems: {
        nodes: {
          project: { id: string };
          fieldValueByName: { name?: string } | null;
        }[];
      };
      closedByPullRequestsReferences: {
        nodes: { number: number; url: string; merged: boolean }[];
      };
    } | null;
  } | null;
}

const ISSUE_STATUS_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $field: String!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      body
      state
      projectItems(first: 50) {
        nodes {
          project { id }
          fieldValueByName(name: $field) {
            ... on ProjectV2ItemFieldSingleSelectValue { name }
          }
        }
      }
      closedByPullRequestsReferences(first: 20, includeClosedPrs: true) {
        nodes { number url merged }
      }
    }
  }
}`;

interface AddItem {
  addProjectV2ItemById: { item: { id: string } };
}

const ADD_ITEM_MUTATION = `
mutation($project: ID!, $content: ID!) {
  addProjectV2ItemById(input: { projectId: $project, contentId: $content }) {
    item { id }
  }
}`;

const MOVE_MUTATION = `
mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $project, itemId: $item, fieldId: $field,
    value: { singleSelectOptionId: $option }
  }) { projectV2Item { id } }
}`;

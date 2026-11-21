/**
 * conductor start の組み立て。既存の各役を LoopDeps につなぎ、Ctrl+C で止まるようにする。
 */
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type AdminStatus, startAdminServer } from "./admin-server.js";
import { mergeApproved } from "./approval.js";
import { type ClaudeDeps, realDeps, runRole, withLanguage } from "./claude.js";
import type { Chat } from "./chat.js";
import {
  chatTokenProblem,
  type Config,
  DISCORD_TOKEN_ENV,
  loadRoleDocs,
  loadRoleInstructions,
} from "./config.js";
import {
  type DashboardData,
  type DashboardDeps,
  loadDashboard,
} from "./dashboard.js";
import { runDecomposer } from "./decomposer.js";
import { DiscordChat } from "./discord.js";
import { shellExec } from "./exec.js";
import { Git } from "./git.js";
import { type GitHub, githubFromConfig } from "./github.js";
import { runImplementer } from "./implementer.js";
import { pickUp } from "./intake.js";
import { checkProgress } from "./progress.js";
import type { RespecDeps } from "./respec.js";
import { type LoopActivity, runLoop, type LoopDeps } from "./loop.js";
import { checkCi, runReviewer } from "./reviewer.js";
import { SqliteStore } from "./sqlite-store.js";
import { checkSpecApproval } from "./spec-approval.js";
import { runSpecifier } from "./specifier.js";
import type { RequirementRecord, Store } from "./store.js";
import { syncMain } from "./sync.js";
import { loadTaskDetail, type TaskDetailData } from "./task-detail.js";
import {
  loadTasks,
  type TaskIssue,
  type TasksBoard,
  type TasksData,
  type TasksDeps,
} from "./tasks.js";
import { runTester } from "./tester.js";

/** 記録の置き場所。対象リポジトリに混ざらないよう、ホームの下に置く */
export function storeFile(repo: string, home = homedir()): string {
  return join(home, ".conductor", "state", `${repo.replace("/", "__")}.db`);
}

/**
 * 役を動かす関数。すべての役（テスト役・実装役・レビュー役・仕様化役）はこれを通るので、
 * 言語の指示（config.language）はここで決まりの最後に足す
 */
export function roleRunner(
  config: Pick<Config, "language">,
  claude: ClaudeDeps,
) {
  return <T extends { systemPrompt: string }>(r: T) =>
    runRole(withLanguage(r, config.language) as never, claude) as never;
}

/**
 * 設定から窓口を作る。config.chat が無ければ undefined（要件を受け取らない）。
 * トークンは環境変数から読む（無ければ conductor start の前に止めている）
 */
export function chatFromConfig(
  config: Pick<Config, "chat">,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Chat | undefined {
  if (config.chat === undefined) return undefined;
  const token = env[DISCORD_TOKEN_ENV]?.trim();
  if (!token) throw new Error(chatTokenProblem(config, env));
  return new DiscordChat({ token, channels: config.chat.channels });
}

export async function buildLoopDeps(
  repoDir: string,
  config: Config,
  store: Store,
  log: (text: string) => void,
): Promise<LoopDeps> {
  const github = githubFromConfig(config);
  const git = new Git(repoDir);
  const run = roleRunner(config, realDeps());
  const testerInstructions = await loadRoleInstructions(repoDir, "tester");
  const implementerInstructions = await loadRoleInstructions(
    repoDir,
    "implementer",
  );
  const perspectives = await loadRoleDocs(repoDir, "reviewer");
  const base = { config, repoDir, git, board: github, store };
  const reviewerDeps = {
    ...base,
    run,
    shell: shellExec,
    exists: async (path: string) => {
      try {
        await access(join(repoDir, path));
        return true;
      } catch {
        return false;
      }
    },
    perspectives,
  };

  const chat = chatFromConfig(config);
  const specifierInstructions = await loadRoleInstructions(
    repoDir,
    "specifier",
  );
  const specify =
    chat === undefined
      ? undefined
      : (requirement: RequirementRecord) =>
          runSpecifier(
            {
              config,
              repoDir,
              chat,
              store,
              git,
              board: github,
              run,
              instructions: specifierInstructions,
              log,
            },
            requirement,
          );
  const approveSpec =
    chat === undefined
      ? undefined
      : (requirement: RequirementRecord) =>
          checkSpecApproval(
            { config, chat, store, board: github, log },
            requirement,
          );
  const decomposerInstructions = await loadRoleInstructions(
    repoDir,
    "decomposer",
  );
  const decompose =
    chat === undefined
      ? undefined
      : (requirement: RequirementRecord) =>
          runDecomposer(
            {
              config,
              repoDir,
              chat,
              store,
              board: github,
              run,
              instructions: decomposerInstructions,
              log,
            },
            requirement,
          );
  const progress =
    chat === undefined
      ? undefined
      : (requirement: RequirementRecord) =>
          checkProgress(
            { config, chat, store, board: github, log },
            requirement,
          );

  const respec: RespecDeps | undefined =
    chat === undefined
      ? undefined
      : {
          config,
          repoDir,
          chat,
          store,
          git,
          board: github,
          run,
          instructions: specifierInstructions,
          log,
        };

  return {
    config,
    store,
    board: github,
    ...(chat === undefined ? {} : { chat }),
    ...(respec === undefined ? {} : { respec }),
    ...(specify === undefined ? {} : { specify }),
    ...(approveSpec === undefined ? {} : { approveSpec }),
    ...(decompose === undefined ? {} : { decompose }),
    ...(progress === undefined ? {} : { progress }),
    log,
    pickUp: (issue) => pickUp({ config, store, board: github }, issue),
    test: (issue) =>
      runTester(
        {
          ...base,
          run,
          readFile: (path) => readFile(join(repoDir, path), "utf8"),
          shell: shellExec,
          instructions: testerInstructions,
        },
        issue,
      ),
    implement: (issue, findings) =>
      runImplementer(
        {
          ...base,
          run,
          shell: shellExec,
          instructions: implementerInstructions,
        },
        issue,
        findings,
      ),
    checkCi: (issue) => checkCi(reviewerDeps, issue.number),
    review: (issue) => runReviewer(reviewerDeps, issue),
    merge: (issue) => mergeApproved(reviewerDeps, issue.number),
    syncMain: (issue, pr) => syncMain(base, issue.number, pr),
  };
}

export interface DashboardRefresher {
  /** 稼働状態か常駐ループの状態が変わった。内容を読み直して知らせる */
  update(change: { status?: AdminStatus; activity?: LoopActivity }): void;
  /** 読み直しの途中なら、終わるまで待つ */
  idle(): Promise<void>;
}

/**
 * ダッシュボードの内容を読み直して publish に渡す。
 * 読み直しは1つずつ行い、途中で変わったら終わってからもう1回だけ読み直す（GitHub に要求を重ねない）。
 * 読めなくても常駐ループは止めない
 */
export function dashboardRefresher(
  deps: Pick<DashboardDeps, "config" | "store" | "board">,
  publish: (data: DashboardData) => void,
  log: (text: string) => void,
): DashboardRefresher {
  let status: AdminStatus = "running";
  let activity: LoopActivity = {};
  let pending = false;
  let running: Promise<void> | undefined;

  const loop = async () => {
    while (pending) {
      pending = false;
      try {
        publish(await loadDashboard({ ...deps, status, activity }));
      } catch (e) {
        log(
          `ダッシュボードの内容を読めませんでした: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    running = undefined;
  };

  return {
    update(change) {
      if (change.status !== undefined) status = change.status;
      if (change.activity !== undefined) activity = change.activity;
      pending = true;
      running ??= loop();
    },
    async idle() {
      await running;
    },
  };
}

export interface TasksRefresher {
  /** Issue の列や回数、役の結果、常駐ループの状態が変わったかもしれない。内容を読み直して知らせる */
  update(change?: { activity?: LoopActivity }): void;
  /** 読み直しの途中なら、終わるまで待つ */
  idle(): Promise<void>;
}

/** 読み直しで作った内容の渡し先 */
export interface TasksPublish {
  /** タスク一覧の内容 */
  tasks(data: TasksData): void;
  /** Project のすべての Issue のタスク詳細（番号の小さい順）。1回の読み直しで1度だけ呼ぶ */
  details(list: TaskDetailData[]): void;
}

/**
 * 1回の読み直しの間だけ使う board。Issue の一覧は1度だけ取り、
 * PR がマージ済みかも PR ごとに1度だけ確かめる（タスク一覧とタスク詳細で同じ問い合わせを重ねない）
 */
export function snapshotBoard(board: TasksBoard): TasksBoard {
  let byColumn: Promise<Map<string, TaskIssue[]>> | undefined;
  const merged = new Map<number, Promise<boolean>>();
  return {
    issuesByColumn() {
      byColumn ??= board.issuesByColumn();
      return byColumn;
    },
    isMerged(pr) {
      let found = merged.get(pr);
      if (found === undefined) {
        found = board.isMerged(pr);
        merged.set(pr, found);
      }
      return found;
    },
  };
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * タスク一覧と、Project のすべての Issue のタスク詳細を読み直して publish に渡す。
 * 1回の読み直しの中では GitHub への問い合わせを共有する（snapshotBoard）。
 * 読み直しは1つずつ行い、途中で頼まれたら終わってからもう1回だけ読み直す（GitHub に要求を重ねない）。
 * 読めなくても常駐ループは止めない
 */
export function tasksRefresher(
  deps: TasksDeps,
  publish: TasksPublish,
  log: (text: string) => void,
): TasksRefresher {
  let activity: LoopActivity = {};
  let pending = false;
  let running: Promise<void> | undefined;

  const refresh = async () => {
    const board = snapshotBoard(deps.board);
    try {
      publish.tasks(await loadTasks({ ...deps, board }));
    } catch (e) {
      log(`タスク一覧の内容を読めませんでした: ${messageOf(e)}`);
    }
    try {
      const numbers = [...(await board.issuesByColumn()).values()]
        .flat()
        .map((i) => i.number)
        .sort((a, b) => a - b);
      const list: TaskDetailData[] = [];
      for (const n of numbers) {
        list.push(await loadTaskDetail({ ...deps, board, activity }, n));
      }
      publish.details(list);
    } catch (e) {
      log(`タスク詳細の内容を読めませんでした: ${messageOf(e)}`);
    }
  };

  const loop = async () => {
    while (pending) {
      pending = false;
      await refresh();
    }
    running = undefined;
  };

  return {
    update(change) {
      if (change?.activity !== undefined) activity = change.activity;
      pending = true;
      running ??= loop();
    },
    async idle() {
      await running;
    },
  };
}

/**
 * タスク一覧に使う GitHub。閉じた Issue（Done など）も含めて取り、
 * マージ済みとわかった PR は覚えておく（マージ済みは戻らないので、毎回は確かめない）
 */
export function tasksBoard(
  github: Pick<GitHub, "issuesByColumn" | "isMerged">,
): TasksBoard {
  const merged = new Set<number>();
  return {
    issuesByColumn: () => github.issuesByColumn({ includeClosed: true }),
    async isMerged(pr) {
      if (merged.has(pr)) return true;
      const yes = await github.isMerged(pr);
      if (yes) merged.add(pr);
      return yes;
    },
  };
}

/**
 * 常駐して Issue を進める。同じプロセスから管理画面も配信し、稼働状態を知らせる。
 * Ctrl+C を受けたら、今の段階を終えてから止まる
 */
export async function start(
  repoDir: string,
  config: Config,
  log: (text: string) => void,
): Promise<void> {
  const store = new SqliteStore(storeFile(config.github.repo));
  const controller = new AbortController();
  const onSigint = () => {
    if (controller.signal.aborted) return;
    log("Ctrl+C を受けました。今の段階を終えてから止まります");
    controller.abort();
  };
  process.on("SIGINT", onSigint);
  try {
    const admin = await startAdminServer({
      repo: config.github.repo,
      project: config.github.project,
      status: "running",
      log,
    });
    try {
      const deps = await buildLoopDeps(repoDir, config, store, log);
      const dashboard = dashboardRefresher(
        { config, store, board: deps.board },
        (data) => admin.setDashboard(data),
        log,
      );
      // タスク一覧とタスク詳細は1回の読み直しでまとめて作り、GitHub への問い合わせを共有する
      const tasks = tasksRefresher(
        { config, store, board: tasksBoard(githubFromConfig(config)) },
        {
          tasks: (data) => admin.setTasks(data),
          details: (list) => admin.setTaskDetails(list),
        },
        log,
      );
      await runLoop(
        {
          ...deps,
          onStatus: (status) => {
            admin.setStatus(status);
            dashboard.update({ status });
            tasks.update();
          },
          onActivity: (activity) => {
            dashboard.update({ activity });
            tasks.update({ activity });
          },
        },
        controller.signal,
        { intervalMs: config.poll_interval * 1000 },
      );
      admin.setStatus("stopped");
      dashboard.update({ status: "stopped" });
      await Promise.all([dashboard.idle(), tasks.idle()]);
    } finally {
      await admin.close();
    }
  } finally {
    process.off("SIGINT", onSigint);
    await store.close();
  }
}

/**
 * conductor start の組み立て。既存の各役を LoopDeps につなぎ、Ctrl+C で止まるようにする。
 */
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type AdminSettings,
  type AdminStatus,
  startAdminServer,
} from "./admin-server.js";
import { loadSettings, saveSettings } from "./settings.js";
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
import { type Shell, shellExec } from "./exec.js";
import { Git } from "./git.js";
import { type GitHub, githubFromConfig } from "./github.js";
import { runImplementer } from "./implementer.js";
import { pickUp } from "./intake.js";
import { cachedStatusOf, checkProgress } from "./progress.js";
import type { RespecDeps } from "./respec.js";
import type { LoopActivity, LoopDeps, StepContext } from "./loop.js";
import { checkCi, runReviewer } from "./reviewer.js";
import { SqliteStore } from "./sqlite-store.js";
import { checkSpecApproval } from "./spec-approval.js";
import { runSpecifier } from "./specifier.js";
import { type Supervisor, startSupervisor } from "./supervisor.js";
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
  // 段階の中断の signal を、役（claude -p）と設定のコマンドにつなぐ
  const runWith = (ctx: StepContext | undefined): typeof run =>
    ctx === undefined
      ? run
      : <T extends { systemPrompt: string }>(r: T) =>
          run({ ...r, signal: ctx.signal });
  const shellWith = (ctx: StepContext | undefined): Shell =>
    ctx === undefined
      ? shellExec
      : (command, options) =>
          shellExec(command, { ...options, signal: ctx.signal });
  const reviewerDeps = (ctx?: StepContext) => ({
    ...base,
    run: runWith(ctx),
    shell: shellWith(ctx),
    exists: async (path: string) => {
      try {
        await access(join(repoDir, path));
        return true;
      } catch {
        return false;
      }
    },
    perspectives,
  });

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
    pickUp: (issue, cache) =>
      pickUp(
        { config, store, board: github, log },
        issue,
        cachedStatusOf(github, cache),
      ),
    test: (issue, ctx) =>
      runTester(
        {
          ...base,
          run: runWith(ctx),
          readFile: (path) => readFile(join(repoDir, path), "utf8"),
          shell: shellWith(ctx),
          instructions: testerInstructions,
        },
        issue,
      ),
    implement: (issue, findings, ctx) =>
      runImplementer(
        {
          ...base,
          run,
          shell: shellWith(ctx),
          instructions: implementerInstructions,
          ...(ctx === undefined ? {} : { signal: ctx.signal }),
        },
        issue,
        findings,
      ),
    checkCi: (issue, ctx) => checkCi(reviewerDeps(ctx), issue.number),
    review: (issue, ctx) => runReviewer(reviewerDeps(ctx), issue),
    merge: (issue, ctx) => mergeApproved(reviewerDeps(ctx), issue.number),
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
 * 管理画面の設定の読み書き。保存は対象リポジトリの既定のブランチに向けた PR にする
 * （リポジトリは管理画面から変えられないので、起動したときの GitHub を使い続ける）
 */
export function settingsAccess(
  repoDir: string,
  github: Pick<GitHub, "createPullRequest" | "baseBranch">,
): AdminSettings {
  return {
    load: () => loadSettings(repoDir),
    save: async (form) =>
      saveSettings({ repoDir, github, base: await github.baseBranch() }, form),
  };
}

/**
 * 常駐して Issue を進める。同じプロセスから管理画面も配信し、稼働状態を知らせる。
 * 管理画面から停止・再起動できる（再起動では config.yaml を読み直す）。
 * Ctrl+C を受けたら、今の段階を終えてから止まる
 */
export async function start(
  repoDir: string,
  config: Config,
  log: (text: string) => void,
): Promise<void> {
  const store = new SqliteStore(storeFile(config.github.repo));
  let finished!: () => void;
  const ended = new Promise<void>((done) => (finished = done));
  let supervisor: Supervisor | undefined;
  let interrupted = false;
  const onSigint = () => {
    if (interrupted) return;
    interrupted = true;
    log("Ctrl+C を受けました。今の段階を終えてから止まります");
    finished();
  };
  process.on("SIGINT", onSigint);
  try {
    const admin = await startAdminServer({
      repo: config.github.repo,
      project: config.github.project,
      status: "running",
      log,
      control: {
        stop: () => supervisor?.stop() ?? Promise.resolve(),
        restart: () => supervisor?.restart() ?? Promise.resolve(),
        abort: (issue) =>
          supervisor?.abort(issue) ??
          Promise.reject(new Error("まだ起動していません")),
      },
      settings: settingsAccess(repoDir, githubFromConfig(config)),
    });
    // 再起動のたびに、読み直した設定で作り直す
    let dashboard: DashboardRefresher | undefined;
    let tasks: TasksRefresher | undefined;
    let status: AdminStatus = "running";
    try {
      const buildDeps = async (next: Config): Promise<LoopDeps> => {
        const deps = await buildLoopDeps(repoDir, next, store, log);
        // ダッシュボードは閉じた Issue も数えるので、引数（includeClosed）を受ける GitHub をそのまま渡す
        const d = dashboardRefresher(
          { config: next, store, board: githubFromConfig(next) },
          (data) => admin.setDashboard(data),
          log,
        );
        // タスク一覧とタスク詳細は1回の読み直しでまとめて作り、GitHub への問い合わせを共有する
        const t = tasksRefresher(
          { config: next, store, board: tasksBoard(githubFromConfig(next)) },
          {
            tasks: (data) => admin.setTasks(data),
            details: (list) => admin.setTaskDetails(list),
          },
          log,
        );
        dashboard = d;
        tasks = t;
        d.update({ status });
        return {
          ...deps,
          onActivity: (activity) => {
            d.update({ activity });
            t.update({ activity });
          },
        };
      };
      const current = startSupervisor({
        repoDir,
        config,
        buildDeps,
        onStatus: (next) => {
          status = next;
          admin.setStatus(next);
          dashboard?.update({ status: next });
          tasks?.update();
        },
        log,
      });
      supervisor = current;
      await ended;
      await current.shutdown();
      await Promise.all([dashboard?.idle(), tasks?.idle()]);
    } finally {
      await admin.close();
    }
  } finally {
    process.off("SIGINT", onSigint);
    await store.close();
  }
}

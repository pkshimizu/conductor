/**
 * conductor start の組み立て。既存の各役を LoopDeps につなぎ、Ctrl+C で止まるようにする。
 */
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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
import { DiscordChat } from "./discord.js";
import { shellExec } from "./exec.js";
import { Git } from "./git.js";
import { githubFromConfig } from "./github.js";
import { runImplementer } from "./implementer.js";
import { pickUp } from "./intake.js";
import { runLoop, type LoopDeps } from "./loop.js";
import { checkCi, runReviewer } from "./reviewer.js";
import { SqliteStore } from "./sqlite-store.js";
import { checkSpecApproval } from "./spec-approval.js";
import { runSpecifier } from "./specifier.js";
import type { RequirementRecord, Store } from "./store.js";
import { syncMain } from "./sync.js";
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

  return {
    config,
    store,
    board: github,
    ...(chat === undefined ? {} : { chat }),
    ...(specify === undefined ? {} : { specify }),
    ...(approveSpec === undefined ? {} : { approveSpec }),
    log,
    pickUp: (issue) => pickUp(github, issue, config.github.columns),
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

/** 常駐して Issue を進める。Ctrl+C を受けたら、今の段階を終えてから止まる */
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
    await runLoop(
      await buildLoopDeps(repoDir, config, store, log),
      controller.signal,
    );
  } finally {
    process.off("SIGINT", onSigint);
    await store.close();
  }
}

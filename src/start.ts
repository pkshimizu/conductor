/**
 * conductor start の組み立て。既存の各役を LoopDeps につなぎ、Ctrl+C で止まるようにする。
 */
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { mergeApproved } from "./approval.js";
import { realDeps, runRole } from "./claude.js";
import { loadRoleDocs, loadRoleInstructions, type Config } from "./config.js";
import { shellExec } from "./exec.js";
import { Git } from "./git.js";
import { githubFromConfig } from "./github.js";
import { runImplementer } from "./implementer.js";
import { pickUp } from "./intake.js";
import { runLoop, type LoopDeps } from "./loop.js";
import { checkCi, runReviewer } from "./reviewer.js";
import { SqliteStore } from "./sqlite-store.js";
import type { Store } from "./store.js";
import { runTester } from "./tester.js";

/** 記録の置き場所。対象リポジトリに混ざらないよう、ホームの下に置く */
export function storeFile(repo: string, home = homedir()): string {
  return join(home, ".conductor", "state", `${repo.replace("/", "__")}.db`);
}

export async function buildLoopDeps(
  repoDir: string,
  config: Config,
  store: Store,
  log: (text: string) => void,
): Promise<LoopDeps> {
  const github = githubFromConfig(config);
  const git = new Git(repoDir);
  const claude = realDeps();
  const run = <T>(r: T) => runRole(r as never, claude) as never;
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

  return {
    config,
    store,
    board: github,
    log,
    pickUp: (issue) => pickUp(github, issue, config.github.columns),
    test: (issue) =>
      runTester(
        {
          ...base,
          run,
          readFile: (path) => readFile(join(repoDir, path), "utf8"),
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

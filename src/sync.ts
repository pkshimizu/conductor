/**
 * main の取り込み。PR が main と衝突したら、指揮役が main を取り込む（実装役は git を使えないため）。
 * - 衝突が無ければ、そのまま push して CI からやり直す
 * - 保護ファイル（受け入れテスト・seed など）が衝突したら、テスト役に作り直させる（実装役は保護ファイルを変えられないため）
 * - それ以外の衝突は、衝突のしるしを残したままコミットし、実装役に解消させる
 * どの場合も差し戻しの上限には数えない。
 */
import type { Config } from "./config.js";
import { matchesAny, type Git } from "./git.js";
import { forbiddenGlobs } from "./implementer.js";
import { REJECT, type Board } from "./rejection.js";
import type { IssueKey, Store } from "./store.js";
import { testBranch } from "./tester.js";

export interface SyncDeps {
  config: Config;
  store: Store;
  board: Board;
  git: Pick<
    Git,
    "mergeBase" | "abortMerge" | "commitMerge" | "push" | "treeHash"
  >;
}

export type SyncResult =
  | { status: "synced" }
  | { status: "conflict"; files: string[] }
  | { status: "protected-conflict"; files: string[] };

export function conflictFinding(pr: number, files: readonly string[]): string {
  return [
    `PR #${pr} が main と衝突したため、指揮役が main を取り込みました。`,
    `次のファイルに衝突のしるし（<<<<<<< / ======= / >>>>>>>）が残っています。両方の変更を生かして解消し、しるしを消してください: ${files.join("、")}`,
  ].join("\n");
}

export function protectedConflictFinding(
  pr: number,
  files: readonly string[],
): string {
  return `PR #${pr} の保護ファイルが main と衝突しました: ${files.join("、")}。最新の main からテストを作り直します。`;
}

/** origin の main を Issue のブランチに取り込む */
export async function syncMain(
  deps: SyncDeps,
  issue: number,
  pr: number,
): Promise<SyncResult> {
  const { config, store, board, git } = deps;
  const { columns } = config.github;
  const key: IssueKey = { repo: config.github.repo, issue };
  const branch = (await store.get(key))?.branch ?? testBranch(issue);
  const forbidden = forbiddenGlobs(config);

  const files = await git.mergeBase(branch);
  const protectedFiles = files.filter((f) => matchesAny(f, forbidden));

  if (protectedFiles.length > 0) {
    await git.abortMerge();
    const finding = protectedConflictFinding(pr, protectedFiles);
    await store.update(key, {
      checkpoint: { stage: "testing", reason: "conflict" },
    });
    await store.addSummary(key, {
      role: "conductor",
      verdict: REJECT,
      text: finding,
    });
    await board.moveIssue(issue, columns.testing);
    await board.comment(
      issue,
      `${finding}\n\nテスト役に戻します（差し戻しの上限には数えません）。`,
    );
    return { status: "protected-conflict", files: protectedFiles };
  }

  if (files.length > 0) {
    await git.commitMerge(
      `chore: main を取り込む（衝突あり: ${files.join(", ")}）`,
    );
  }
  await git.push(branch);
  // main で変わった保護ファイルは人が確かめた変更なので、照合の基準を取り込んだ後に合わせる
  const protectedHash = await git.treeHash("HEAD", forbidden);

  if (files.length === 0) {
    await store.update(key, { protectedHash, checkpoint: { stage: "ci" } });
    await board.comment(
      issue,
      `PR #${pr} が main と衝突したため、main を取り込みました。CI からやり直します。`,
    );
    return { status: "synced" };
  }

  const finding = conflictFinding(pr, files);
  await store.update(key, {
    protectedHash,
    checkpoint: { stage: "implementing", reason: "conflict" },
  });
  await store.addSummary(key, {
    role: "conductor",
    verdict: REJECT,
    text: finding,
  });
  await board.moveIssue(issue, columns.implementing);
  await board.comment(
    issue,
    `${finding}\n\n実装役に直させます（差し戻しの上限には数えません）。`,
  );
  return { status: "conflict", files };
}

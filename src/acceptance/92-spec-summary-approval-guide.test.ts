/**
 * Issue #92: 仕様の要約の書き込みに、✅ を付ければ承認できることを書く
 *
 * 使う名前（すでにある）:
 * - `src/specifier.ts` の `summaryMessage(summary, pr, fixed)`・`isSummaryMessage(text)`・`APPROVAL_MARK`
 * - `src/spec-approval.ts` の `checkSpecApproval(deps, requirement)`
 *
 * 変えるのは `summaryMessage` の最後の行だけ。最後の行を承認の案内
 * 「この内容でよければ、この書き込みに ✅ を付けてください。仕様の PR をマージし、作業の分解に進みます。直してほしい点があれば、このスレッドに書いてください。」
 * にし、✅ は `APPROVAL_MARK` を埋め込んで作る。
 *
 * 窓口は MemoryChat、GitHub と git と claude は偽物、記録は MemoryStore を使う。
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MemoryChat } from "../chat.js";
import type { RoleResult, RoleRun } from "../claude.js";
import { type Config, parseConfig } from "../config.js";
import type { CiResult } from "../github.js";
import {
  checkSpecApproval,
  type SpecApprovalBoard,
  type SpecApprovalDeps,
} from "../spec-approval.js";
import {
  APPROVAL_MARK,
  isSummaryMessage,
  runSpecifier,
  type SpecifierDeps,
  type SpecifierOutput,
  type specifierOutputSchema,
  summaryMessage,
} from "../specifier.js";
import { MemoryStore, type Store } from "../store.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

// ---- seed ----

const SUMMARY = "要約";
const PR = { url: "https://github.com/o/r/pull/1" };

/** 承認の案内（✅ は APPROVAL_MARK から埋め込む） */
const GUIDE = `この内容でよければ、この書き込みに ${APPROVAL_MARK} を付けてください。仕様の PR をマージし、作業の分解に進みます。直してほしい点があれば、このスレッドに書いてください。`;

const REPO = "pkshimizu/wordcards";
const REQUIREMENTS = "1000000000000000001";
const QUESTIONS = "1000000000000000002";
const NOTICES = "1000000000000000003";
const ALLOWED = "2000000000000000001";
const BOT = "3000000000000000001";

const REQUIREMENT_TEXT = "単語帳に検索をつけたい\n前方一致で探せるように";
const SPEC_FILE = "docs/specs/word-search.md";
const SPEC_SUMMARY = "前方一致の検索の仕様を書きました";

const clock = () => new Date("2026-11-21T00:00:00.000Z");

function makeConfig(): Config {
  return parseConfig(
    [
      `github: { repo: ${REPO}, project: 3, notify: someone }`,
      "protected: [src/acceptance/**]",
      "commands: { setup: s, test: t, acceptance: a, typecheck: c, build: b }",
      "chat:",
      "  type: discord",
      "  channels:",
      `    requirements: "${REQUIREMENTS}"`,
      `    questions: "${QUESTIONS}"`,
      `    notices: "${NOTICES}"`,
      "  allowed_users:",
      `    - "${ALLOWED}"`,
    ].join("\n"),
  );
}

/** 受け取り済みの要件（要件チャンネルの投稿とスレッドがある状態）を作る */
async function seedRequirement(chat: MemoryChat, store: Store) {
  const posted = chat.addMessage(REQUIREMENTS, {
    authorId: ALLOWED,
    text: REQUIREMENT_TEXT,
  });
  await store.setReadPosition(REQUIREMENTS, posted.id);
  const head = await chat.post(
    QUESTIONS,
    `要件を受け取りました（<@${ALLOWED}>）: 単語帳に検索をつけたい`,
  );
  const threadId = await chat.createThread(
    QUESTIONS,
    head,
    "単語帳に検索をつけたい",
  );
  await chat.post(
    threadId,
    REQUIREMENT_TEXT.split("\n")
      .map((l) => `> ${l}`)
      .join("\n"),
  );
  await store.updateRequirement(posted.id, { threadId });
  return { messageId: posted.id, threadId };
}

// ---- 偽物 ----

/** 作業ツリーとコミット・push を覚えるだけの git */
class FakeGit {
  readonly files = new Set<string>();
  readonly commits: { branch: string; paths: string[] }[] = [];
  private branch = "main";

  startBranch(branch: string): Promise<void> {
    this.branch = branch;
    this.files.clear();
    return Promise.resolve();
  }
  changedFiles(): Promise<string[]> {
    return Promise.resolve([...this.files].sort());
  }
  discard(paths: readonly string[]): Promise<void> {
    for (const p of paths) this.files.delete(p);
    return Promise.resolve();
  }
  discardAll(): Promise<void> {
    this.files.clear();
    return Promise.resolve();
  }
  commit(paths: readonly string[]): Promise<string> {
    this.commits.push({ branch: this.branch, paths: [...paths] });
    for (const p of paths) this.files.delete(p);
    return Promise.resolve(`commit-${this.commits.length}`);
  }
  push(): Promise<void> {
    return Promise.resolve();
  }
}

/** PR・CI・マージを覚えるだけの GitHub */
class FakeBoard implements SpecApprovalBoard {
  readonly created: { number: number; url: string; head: string }[] = [];
  readonly ciChecks: number[] = [];
  readonly merged: number[] = [];

  findPullRequest(head: string) {
    const pr = this.created.find((p) => p.head === head);
    return Promise.resolve(pr && { number: pr.number, url: pr.url });
  }
  createPullRequest(input: { head: string; title: string; body: string }) {
    const number = 101 + this.created.length;
    const url = `https://github.com/${REPO}/pull/${number}`;
    this.created.push({ number, url, head: input.head });
    return Promise.resolve({ number, url });
  }
  ciStatus(pr: number): Promise<CiResult> {
    this.ciChecks.push(pr);
    return Promise.resolve({
      state: "success",
      checks: [{ name: "check", bucket: "pass", link: "" }],
    });
  }
  mergePullRequest(pr: number): Promise<void> {
    this.merged.push(pr);
    return Promise.resolve();
  }
}

type SpecRun = RoleRun<typeof specifierOutputSchema>;

/** 仕様のファイルを書いて approve を返す偽の仕様化役 */
function writingRole(git: FakeGit) {
  const runs: SpecRun[] = [];
  const run = (r: SpecRun): Promise<RoleResult<SpecifierOutput>> => {
    runs.push(r);
    git.files.add(SPEC_FILE);
    return Promise.resolve({
      output: {
        verdict: "approve",
        summary: SPEC_SUMMARY,
        findings: [],
        questions: [],
      },
      denials: [],
      costUsd: 0,
      turns: 1,
      sessionId: `session-${runs.length}`,
    });
  };
  return { run, runs };
}

function run(command: string): string {
  return execSync(command, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** src/specifier.ts の summaryMessage の本体（ソースの文字列） */
function summaryMessageSource(): string {
  const source = readFileSync(join(ROOT, "src", "specifier.ts"), "utf8");
  const start = source.indexOf("export function summaryMessage(");
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = source.slice(start + 1);
  const next = rest.search(/\n(export |function |const |\/\*\*)/);
  return next < 0 ? rest : rest.slice(0, next);
}

describe("Issue #92: 仕様の要約の書き込みに、✅ を付ければ承認できることを書く", () => {
  it("AC1: 書いたとき・直したときのどちらも、最後の行が承認の案内で、✅ は APPROVAL_MARK を埋め込んで作られている", () => {
    // Given: 要約と PR
    // When: 書いたとき・直したときの書き込みを作る
    for (const fixed of [false, true]) {
      const text = summaryMessage(SUMMARY, PR, fixed);

      // Then: 最後の行が承認の案内
      const lines = text.split("\n");
      expect(lines.at(-1), `fixed=${fixed}`).toBe(GUIDE);
      expect(lines.at(-1), `fixed=${fixed}`).toBe(
        "この内容でよければ、この書き込みに ✅ を付けてください。仕様の PR をマージし、作業の分解に進みます。直してほしい点があれば、このスレッドに書いてください。",
      );
    }

    // Then: ✅ は手で書かず、APPROVAL_MARK を埋め込んで作る
    const body = summaryMessageSource();
    expect(body).toContain("APPROVAL_MARK");
    expect(body).not.toContain("✅");
  });

  it("AC2: 1行目は書いた／直したで分かれ、PR の行があり、要約・PR の行・案内の行の間は空行で区切られている", () => {
    // Given: 要約と PR
    // When: 書き込みを作る
    const written = summaryMessage(SUMMARY, PR, false);
    const fixed = summaryMessage(SUMMARY, PR, true);

    // Then: 1行目・要約・PR の行・案内の行が空行で区切られている
    expect(written).toBe(
      [
        "仕様を書きました。",
        "",
        SUMMARY,
        "",
        "PR: https://github.com/o/r/pull/1",
        "",
        GUIDE,
      ].join("\n"),
    );
    expect(fixed).toBe(
      [
        "仕様を直しました。",
        "",
        SUMMARY,
        "",
        "PR: https://github.com/o/r/pull/1",
        "",
        GUIDE,
      ].join("\n"),
    );
  });

  it("AC3: summaryMessage で作った書き込み（書いた・直したの両方）を、isSummaryMessage は要約と判定する", () => {
    // Given: summaryMessage で作った書き込み
    for (const fixed of [false, true]) {
      const text = summaryMessage(SUMMARY, PR, fixed);

      // When / Then: 要約と判定する
      expect(isSummaryMessage(text), `fixed=${fixed}`).toBe(true);
    }
  });

  it("AC4: 新しい文言の要約の書き込みに許可した人が ✅ を付けると、今までどおり承認として扱われ、CI が合格なら仕様の PR がマージされる", async () => {
    // Given: 仕様化役が仕様を書き、新しい文言の要約の書き込みがスレッドに出ている
    const chat = new MemoryChat(BOT);
    const store = new MemoryStore(clock);
    const { messageId, threadId } = await seedRequirement(chat, store);
    const config = makeConfig();
    const git = new FakeGit();
    const board = new FakeBoard();
    const role = writingRole(git);
    const specifierDeps: SpecifierDeps = {
      config,
      repoDir: "/repo",
      chat,
      store,
      git,
      board,
      run: role.run,
      instructions: "",
      log: () => {},
    };
    const first = await store.getRequirement(messageId);
    expect(first).toBeDefined();
    const specified = await runSpecifier(specifierDeps, first!);
    expect(specified.status).toBe("specified");
    expect(board.created).toHaveLength(1);
    const pr = board.created[0]!;

    const summaries = (chat.messages.get(threadId) ?? []).filter(
      (m) => m.authorId === chat.botId && isSummaryMessage(m.text),
    );
    expect(summaries).toHaveLength(1);
    const summary = summaries[0]!;
    expect(summary.text).toBe(
      summaryMessage(SPEC_SUMMARY, { url: pr.url }, false),
    );
    expect(summary.text.split("\n").at(-1)).toBe(GUIDE);

    // When: 許可した人がその書き込みに ✅ を付ける
    chat.addReaction(threadId, summary.id, APPROVAL_MARK, ALLOWED);
    const approvalDeps: SpecApprovalDeps = {
      config,
      chat,
      store,
      board,
      log: () => {},
    };
    const awaiting = await store.getRequirement(messageId);
    expect(awaiting?.state).toBe("awaiting_approval");
    const result = await checkSpecApproval(approvalDeps, awaiting!);

    // Then: 承認として扱われ、CI が合格なので仕様の PR がマージされる
    expect(result.status).toBe("approved");
    expect(board.ciChecks).toContain(pr.number);
    expect(board.merged).toEqual([pr.number]);
    const thread = chat.threads.get(threadId)!;
    expect(thread.archived).toBe(true);
    expect(thread.locked).toBe(true);
    const record = await store.getRequirement(messageId);
    expect(record?.state).toBe("working");
    expect(record?.specPr).toBe(pr.number);

    // Then: 既存の承認のテスト（src/spec-approval.test.ts）も合格する
    run("npx vitest run src/spec-approval.test.ts");
  }, 300_000);

  it("AC5: lint・format:check・typecheck・テスト・build がすべて合格する", () => {
    // When / Then: それぞれ合格する（失敗すると execSync が例外を投げる）
    run("npm run lint");
    run("npm run format:check");
    run("npm run typecheck");
    // npm test はこのテスト自身を含むので、受け入れテスト以外を流す（受け入れテストはこの実行で確かめる）
    run('npx vitest run --exclude "src/acceptance/**"');
    run("npm run build");
  }, 600_000);
});

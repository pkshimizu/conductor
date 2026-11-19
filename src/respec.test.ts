import { describe, expect, it } from "vitest";
import { MemoryChat } from "./chat.js";
import type { RoleResult, RoleRun } from "./claude.js";
import { parseConfig } from "./config.js";
import type { CiResult } from "./github.js";
import {
  checkRespec,
  respecBranch,
  respecComment,
  type RespecBoard,
  type RespecDeps,
  type RespecOutput,
  type respecOutputSchema,
  respecPrompt,
  startRespec,
} from "./respec.js";
import { MemoryStore } from "./store.js";

const ALLOWED = "200";
const OTHER = "201";
const SPEC_FILE = "docs/specs/search.md";

const config = parseConfig(
  [
    "github: { repo: o/r, project: 1, notify: someone }",
    "protected: [src/acceptance/**]",
    "commands: { setup: s, test: t, acceptance: a, typecheck: c, build: b }",
    "chat:",
    "  type: discord",
    "  channels: { requirements: '1', questions: '2', notices: '3' }",
    "  allowed_users: ['200']",
  ].join("\n"),
);

class FakeBoard implements RespecBoard {
  readonly created: { head: string; title: string; body: string }[] = [];
  readonly merged: number[] = [];
  ci: CiResult = { state: "success", checks: [] };
  existing: { number: number; url: string } | undefined;
  pullRequestFiles() {
    return Promise.resolve([SPEC_FILE, "src/a.ts"]);
  }
  findPullRequest() {
    return Promise.resolve(this.existing);
  }
  createPullRequest(input: { head: string; title: string; body: string }) {
    this.created.push(input);
    return Promise.resolve({ number: 301, url: "https://example/pull/301" });
  }
  ciStatus() {
    return Promise.resolve(this.ci);
  }
  mergePullRequest(pr: number) {
    this.merged.push(pr);
    return Promise.resolve();
  }
}

class FakeGit {
  files: string[] = [];
  readonly commits: string[][] = [];
  readonly pushed: string[] = [];
  readonly branches: string[] = [];
  readonly discarded: string[][] = [];
  startBranch(branch: string) {
    this.branches.push(branch);
    return Promise.resolve();
  }
  changedFiles() {
    return Promise.resolve([...this.files]);
  }
  discard(paths: readonly string[]) {
    this.discarded.push([...paths]);
    this.files = this.files.filter((f) => !paths.includes(f));
    return Promise.resolve();
  }
  discardAll() {
    this.files = [];
    return Promise.resolve();
  }
  commit(paths: readonly string[]) {
    this.commits.push([...paths]);
    return Promise.resolve("sha");
  }
  push(branch: string) {
    this.pushed.push(branch);
    return Promise.resolve();
  }
}

async function setup(options: {
  specChange: boolean;
  writes?: string[];
  work?: boolean;
}) {
  const chat = new MemoryChat("bot");
  const store = new MemoryStore();
  const board = new FakeBoard();
  const git = new FakeGit();
  await store.updateRequirement("10", {
    threadId: "x",
    specPr: 101,
    state: "working",
    workIssues: options.work === false ? [99] : [12],
  });
  const head = chat.addMessage("2", { authorId: "bot", text: "止まった" });
  const threadId = head.id;
  const runs: RoleRun<typeof respecOutputSchema>[] = [];
  const run = (
    r: RoleRun<typeof respecOutputSchema>,
  ): Promise<RoleResult<RespecOutput>> => {
    runs.push(r);
    git.files = [...(options.writes ?? [])];
    return Promise.resolve({
      output: {
        verdict: "approve",
        summary: " 変更点です ",
        findings: [],
        specChange: options.specChange,
      },
      denials: [],
      costUsd: 0,
      turns: 1,
      sessionId: "s",
    });
  };
  const deps: RespecDeps = {
    config,
    repoDir: "/repo",
    chat,
    store,
    git,
    board,
    run,
    instructions: "追加の指示",
    log: () => {},
  };
  const input = {
    issue: { number: 12, title: "検索" },
    reason: "落ちた",
    threadId,
    policy: "大文字小文字を区別しない",
  };
  return { chat, store, board, git, runs, deps, input, threadId };
}

describe("startRespec", () => {
  it("要件の作業用 Issue でなければ、仕様化役を起動しない", async () => {
    const s = await setup({ specChange: true, work: false });
    expect(await startRespec(s.deps, s.input)).toEqual({ status: "skipped" });
    expect(s.runs).toEqual([]);
  });

  it("方針と仕様のファイル（docs/specs/ の下だけ）を渡し、変更が要らなければ何も作らない", async () => {
    const s = await setup({ specChange: false });
    expect(await startRespec(s.deps, s.input)).toEqual({
      status: "unchanged",
    });
    const run = s.runs[0]!;
    expect(run.role).toBe("specifier");
    expect(run.prompt).toContain(s.input.policy);
    expect(run.prompt).toContain(SPEC_FILE);
    expect(run.prompt).not.toContain("src/a.ts");
    expect(run.systemPrompt).toContain("追加の指示");
    expect(s.git.commits).toEqual([]);
    expect(s.board.created).toEqual([]);
    expect(s.git.files).toEqual([]);
  });

  it("変更が要ると答えても仕様のファイルが書かれなければ、方針の書き写しに回す", async () => {
    const s = await setup({ specChange: true, writes: ["src/a.ts"] });
    expect(await startRespec(s.deps, s.input)).toEqual({
      status: "unchanged",
    });
    expect(s.git.commits).toEqual([]);
    expect(s.board.created).toEqual([]);
  });

  it("変更が要れば、書いてよいファイルだけをコミットして PR を作り、要約をスレッドに書く", async () => {
    const s = await setup({
      specChange: true,
      writes: [SPEC_FILE, "src/a.ts"],
    });
    const result = await startRespec(s.deps, s.input);
    const branch = respecBranch(12, s.threadId);
    expect(s.git.branches).toEqual([branch]);
    expect(s.git.discarded).toContainEqual(["src/a.ts"]);
    expect(s.git.commits).toEqual([[SPEC_FILE]]);
    expect(s.git.pushed).toEqual([branch]);
    expect(s.board.created[0]?.head).toBe(branch);
    if (result.status !== "respecified") throw new Error(result.status);
    expect(result.progress).toMatchObject({
      policy: s.input.policy,
      summary: "変更点です",
      pr: 301,
      url: "https://example/pull/301",
    });
    const thread = s.chat.messages.get(s.threadId) ?? [];
    const posted = thread.find((m) => m.id === result.progress.summaryId);
    expect(posted?.text).toContain("変更点です");
    expect(posted?.text).toContain("https://example/pull/301");
  });

  it("前の確認で作った PR があれば、作り直さない", async () => {
    const s = await setup({ specChange: true, writes: [SPEC_FILE] });
    s.board.existing = { number: 305, url: "u305" };
    const result = await startRespec(s.deps, s.input);
    expect(s.board.created).toEqual([]);
    expect(result.status === "respecified" && result.progress.pr).toBe(305);
  });
});

describe("checkRespec", () => {
  async function respecified() {
    const s = await setup({ specChange: true, writes: [SPEC_FILE] });
    const result = await startRespec(s.deps, s.input);
    if (result.status !== "respecified") throw new Error(result.status);
    return { ...s, progress: result.progress };
  }

  it("許可した人の ✅ が無ければ待つ", async () => {
    const s = await respecified();
    s.chat.addReaction(s.threadId, s.progress.summaryId, "✅", OTHER);
    s.chat.addReaction(s.threadId, s.progress.summaryId, "👍", ALLOWED);
    expect(await checkRespec(s.deps, s.threadId, s.progress)).toEqual({
      status: "waiting",
    });
    expect(s.board.merged).toEqual([]);
  });

  it("✅ があり CI が通っていればマージする", async () => {
    const s = await respecified();
    s.chat.addReaction(s.threadId, s.progress.summaryId, "✅", ALLOWED);
    expect(await checkRespec(s.deps, s.threadId, s.progress)).toEqual({
      status: "merged",
    });
    expect(s.board.merged).toEqual([301]);
  });

  it("CI が失敗していればマージせず、理由を1回だけスレッドに書く", async () => {
    const s = await respecified();
    s.chat.addReaction(s.threadId, s.progress.summaryId, "✅", ALLOWED);
    s.board.ci = {
      state: "failure",
      checks: [{ name: "check", bucket: "fail", link: "" }],
    };
    const before = s.chat.messages.get(s.threadId)?.length ?? 0;
    await checkRespec(s.deps, s.threadId, s.progress);
    expect(await checkRespec(s.deps, s.threadId, s.progress)).toEqual({
      status: "ci_failed",
    });
    expect(s.chat.messages.get(s.threadId)?.length).toBe(before + 1);
    expect(s.board.merged).toEqual([]);
  });

  it("CI が終わっていなければ待つ", async () => {
    const s = await respecified();
    s.chat.addReaction(s.threadId, s.progress.summaryId, "✅", ALLOWED);
    s.board.ci = { state: "pending", checks: [] };
    expect(await checkRespec(s.deps, s.threadId, s.progress)).toEqual({
      status: "ci_pending",
    });
  });
});

describe("文面", () => {
  it("respecComment は変更点と方針と PR を書く", () => {
    const text = respecComment(
      {
        policy: "方針1\n方針2",
        summary: "変更点",
        pr: 301,
        url: "https://example/pull/301",
        summaryId: "m",
      },
      "Ready",
    );
    expect(text).toContain("#301");
    expect(text).toContain("https://example/pull/301");
    expect(text).toContain("> 変更点");
    expect(text).toContain("> 方針1\n> 方針2");
    expect(text).toContain("Ready");
  });

  it("respecPrompt は止まった理由・方針・仕様のファイルを含める", () => {
    const text = respecPrompt({
      repo: "o/r",
      issue: { number: 12, title: "検索" },
      reason: "落ちた",
      policy: "方針",
      specPr: 101,
      specFiles: [SPEC_FILE],
    });
    expect(text).toContain("https://github.com/o/r/issues/12");
    expect(text).toContain("落ちた");
    expect(text).toContain("方針");
    expect(text).toContain(`- ${SPEC_FILE}`);
  });
});

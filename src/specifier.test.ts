import { describe, expect, it } from "vitest";
import { MemoryChat } from "./chat.js";
import type { RoleResult, RoleRun } from "./claude.js";
import { parseConfig } from "./config.js";
import { newLoopState, tick, type LoopDeps } from "./loop.js";
import {
  questionsMessage,
  runSpecifier,
  specBranch,
  specifierAllow,
  specifierPrompt,
  type SpecifierDeps,
  type SpecifierOutput,
  type specifierOutputSchema,
} from "./specifier.js";
import { MemoryStore } from "./store.js";

const HUMAN = "200";
const config = parseConfig(
  [
    "github: { repo: me/app, project: 1, notify: me }",
    "protected: [e2e/**]",
    "commands: { setup: s, test: t, acceptance: a, typecheck: c, build: b }",
    "roles: { specifier: { allow: ['WebSearch'] } }",
    "chat:",
    "  type: discord",
    '  channels: { requirements: "1", questions: "2", notices: "3" }',
    `  allowed_users: ["${HUMAN}"]`,
  ].join("\n"),
);

function makeDeps(
  outputs: ((files: Set<string>) => SpecifierOutput)[],
  chat = new MemoryChat("bot"),
) {
  const store = new MemoryStore();
  const files = new Set<string>();
  const discarded: string[] = [];
  const commits: string[][] = [];
  const runs: RoleRun<typeof specifierOutputSchema>[] = [];
  const created: { head: string; title: string; body: string }[] = [];
  const deps: SpecifierDeps = {
    config,
    repoDir: "/repo",
    chat,
    store,
    git: {
      startBranch: () => Promise.resolve(),
      changedFiles: () => Promise.resolve([...files].sort()),
      discard: (paths) => {
        for (const p of paths) {
          discarded.push(p);
          files.delete(p);
        }
        return Promise.resolve();
      },
      discardAll: () => {
        files.clear();
        return Promise.resolve();
      },
      commit: (paths) => {
        commits.push([...paths]);
        return Promise.resolve("c1");
      },
      push: () => Promise.resolve(),
    },
    board: {
      findPullRequest: (head) => {
        const i = created.findIndex((c) => c.head === head);
        return Promise.resolve(
          i < 0 ? undefined : { number: 10 + i, url: `https://pr/${10 + i}` },
        );
      },
      createPullRequest: (input) => {
        created.push(input);
        const n = 10 + created.length - 1;
        return Promise.resolve({ number: n, url: `https://pr/${n}` });
      },
    },
    run: (r): Promise<RoleResult<SpecifierOutput>> => {
      runs.push(r);
      const next = outputs.shift();
      if (!next) throw new Error("答えがありません");
      return Promise.resolve({
        output: next(files),
        denials: [],
        costUsd: 0,
        turns: 1,
        sessionId: "s",
      });
    },
    instructions: "",
    log: () => {},
  };
  return { deps, store, chat, files, discarded, commits, runs, created };
}

async function seed(chat: MemoryChat, store: MemoryStore) {
  const head = await chat.post("2", "要件を受け取りました");
  const threadId = await chat.createThread("2", head, "検索");
  await chat.post(threadId, "> 検索をつけたい");
  return store.updateRequirement("req-1", { threadId });
}

describe("questionsMessage", () => {
  it("番号とおすすめの答えを並べ、まとめて答えられることを書く", () => {
    expect(
      questionsMessage([
        { question: "A ですか", recommendation: "はい" },
        { question: "B ですか", recommendation: "いいえ" },
      ]),
    ).toContain(
      "1. A ですか\n   おすすめ: はい\n2. B ですか\n   おすすめ: いいえ",
    );
  });
});

describe("specifierAllow", () => {
  it("docs/specs/ と .conductor/knowledge/ だけ書けて、設定の許可を足す", () => {
    expect(specifierAllow(config)).toEqual([
      "Read",
      "Glob",
      "Grep",
      "Edit(./docs/specs/**)",
      "Edit(./.conductor/knowledge/**)",
      "WebSearch",
    ]);
  });
});

describe("specifierPrompt", () => {
  it("許可した人の書き込みを人として示し、PR があれば修正の依頼にする", () => {
    const text = specifierPrompt({
      requirement: "検索をつけたい",
      thread: [
        { id: "1", authorId: "bot", text: "> 検索をつけたい" },
        { id: "2", authorId: HUMAN, text: "直して" },
      ],
      allowed: new Set([HUMAN]),
      pr: { number: 5, url: "https://pr/5" },
      requests: [{ id: "2", authorId: HUMAN, text: "直して" }],
    });
    expect(text).toContain(`## 人（<@${HUMAN}>）`);
    expect(text).toContain("## conductor");
    expect(text).toContain("PR #5（https://pr/5）への修正の依頼");
    expect(text).toContain("- 直して");
  });
});

describe("runSpecifier", () => {
  it("書いてよい場所の外の変更は捨て、要件ごとのブランチで PR を作って承認待ちにする", async () => {
    const t = makeDeps([
      (files) => {
        files.add("docs/specs/a.md");
        files.add("src/x.ts");
        return {
          verdict: "approve",
          summary: "要約",
          findings: [],
          questions: [],
        };
      },
    ]);
    const req = await seed(t.chat, t.store);
    expect(await runSpecifier(t.deps, req)).toEqual({ status: "specified" });
    expect(t.discarded).toEqual(["src/x.ts"]);
    expect(t.commits).toEqual([["docs/specs/a.md"]]);
    expect(t.created[0]!.head).toBe(specBranch("req-1"));
    const record = await t.store.getRequirement("req-1");
    expect(record?.state).toBe("awaiting_approval");
    expect(record?.specPr).toBe(10);
  });

  it("仕様のファイルが無ければ PR を作らず、その旨を書いて返事を待つ", async () => {
    const t = makeDeps([
      () => ({
        verdict: "approve",
        summary: "書けませんでした",
        findings: [],
        questions: [],
      }),
    ]);
    const req = await seed(t.chat, t.store);
    expect(await runSpecifier(t.deps, req)).toEqual({ status: "unwritten" });
    expect(t.created).toHaveLength(0);
    const last = t.chat.messages.get(req.threadId!)!.at(-1)!;
    expect(last.text).toContain("書かれませんでした");
    // 返事が無ければ、次は何もしない
    expect(await runSpecifier(t.deps, req)).toEqual({ status: "waiting" });
    expect(t.runs).toHaveLength(1);
  });

  it("許可していない人の書き込みでは起動しない", async () => {
    const t = makeDeps([
      () => ({
        verdict: "objection",
        summary: "疑問",
        findings: [],
        questions: [{ question: "Q", recommendation: "R" }],
      }),
    ]);
    const req = await seed(t.chat, t.store);
    await runSpecifier(t.deps, req);
    t.chat.addMessage(req.threadId!, { authorId: "999", text: "どうですか" });
    expect(await runSpecifier(t.deps, req)).toEqual({ status: "waiting" });
    expect(t.runs).toHaveLength(1);
    expect((await t.store.getRequirement("req-1"))?.questions).toBe(1);
  });
});

describe("tick の仕様化", () => {
  it("スレッドのある仕様化中・承認待ちの要件だけを渡し、失敗しても続ける", async () => {
    const store = new MemoryStore();
    await store.updateRequirement("1", { threadId: "t1" });
    await store.updateRequirement("2", {});
    await store.updateRequirement("3", { threadId: "t3", state: "working" });
    await store.updateRequirement("4", {
      threadId: "t4",
      state: "awaiting_approval",
    });
    const seen: string[] = [];
    const logs: string[] = [];
    const never = () => Promise.reject(new Error("呼ばれない"));
    const deps: LoopDeps = {
      config,
      store,
      board: {
        issuesByColumn: () => Promise.resolve(new Map()),
        moveIssue: () => Promise.resolve(),
        comment: () => Promise.resolve(),
        hasConflict: () => Promise.resolve(false),
      },
      pickUp: never,
      test: never,
      implement: never,
      checkCi: never,
      review: never,
      merge: never,
      syncMain: never,
      specify: (r) => {
        seen.push(r.messageId);
        if (r.messageId === "1") return Promise.reject(new Error("壊れた"));
        return Promise.resolve({ status: "waiting" });
      },
      log: (t) => logs.push(t),
    };
    await tick(deps, newLoopState());
    expect(seen).toEqual(["1", "4"]);
    expect(logs.some((l) => l.includes("壊れた"))).toBe(true);
  });
});

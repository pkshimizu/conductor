import { describe, expect, it } from "vitest";
import { resetCounts } from "./blocked-thread.js";
import { MemoryChat } from "./chat.js";
import { parseConfig } from "./config.js";
import {
  broadRule,
  broadRules,
  code,
  codeBlock,
  followPermissionRequest,
  isProposable,
  matchesRule,
  type PermissionRequestDeps,
  permissionDenials,
  permissionThreadName,
  RULE_HINT,
  ruleOfDenial,
  rulesInText,
} from "./permission-request.js";
import type { SettingsForm } from "./settings-data.js";
import { MemoryStore } from "./store.js";

const REPO = "o/r";
const KEY = { repo: REPO, issue: 5 };
const QUESTIONS = "100";
const ALLOWED = "200";
const BOT = "300";

const bash = (command: string) => ({ tool: "Bash", input: { command } });

describe("拒否された操作を規則の形にする", () => {
  it("Bash・PowerShell はコマンドつきの Bash(...) にする", () => {
    expect(ruleOfDenial(bash("npm install x"), "/repo")).toBe(
      "Bash(npm install x)",
    );
    expect(
      ruleOfDenial(
        { tool: "PowerShell", input: { command: " npm ci " } },
        "/repo",
      ),
    ).toBe("Bash(npm ci)");
  });

  it("ファイルの道具は作業フォルダからの相対パスにする", () => {
    expect(
      ruleOfDenial(
        { tool: "Write", input: { file_path: "/repo/docs/a.md" } },
        "/repo",
      ),
    ).toBe("Edit(./docs/a.md)");
    expect(
      ruleOfDenial(
        { tool: "Read", input: { file_path: "/etc/hosts" } },
        "/repo",
      ),
    ).toBe("Read(/etc/hosts)");
  });

  it("WebFetch はドメイン、ほかは道具の名前にする", () => {
    expect(
      ruleOfDenial(
        { tool: "WebFetch", input: { url: "https://example.com/a" } },
        "/repo",
      ),
    ).toBe("WebFetch(domain:example.com)");
    expect(ruleOfDenial({ tool: "WebSearch", input: {} }, "/repo")).toBe(
      "WebSearch",
    );
  });
});

describe("deny に当てはまるか", () => {
  it("Edit(./glob) は Edit・Write の相対パスに当てはまる", () => {
    const write = {
      tool: "Write",
      input: { file_path: "/repo/src/acceptance/1.test.ts" },
    };
    expect(matchesRule(write, "Edit(./src/acceptance/**)", "/repo")).toBe(true);
    expect(matchesRule(write, "Edit(./e2e/**)", "/repo")).toBe(false);
    expect(matchesRule(write, "Read(./src/**)", "/repo")).toBe(false);
  });

  it("Bash の * は何にでも当てはまる", () => {
    expect(matchesRule(bash("git push origin"), "Bash(git push *)", "/r")).toBe(
      true,
    );
    expect(matchesRule(bash("git status"), "Bash(git push *)", "/r")).toBe(
      false,
    );
    expect(matchesRule(bash("rm -rf /"), "Bash(rm:*)", "/r")).toBe(true);
    expect(matchesRule(bash("ls"), "Bash", "/r")).toBe(true);
  });

  it("deny に当てはまる拒否は許可を聞かない", () => {
    const asked = permissionDenials(
      [
        bash("npm install x"),
        bash("npm install x"),
        {
          tool: "Edit",
          input: { file_path: "/repo/src/acceptance/a.test.ts" },
        },
      ],
      ["Edit(./src/acceptance/**)"],
      "/repo",
    );
    expect(asked).toEqual({
      rules: ["Bash(npm install x)"],
      denied: ["npm install x"],
    });
  });
});

describe("広い案", () => {
  it("最初の 2 語に * を付ける", () => {
    expect(broadRule("Bash(npm install --save-dev x)")).toBe(
      "Bash(npm install *)",
    );
    expect(broadRule("Bash(npm install *)")).toBeUndefined();
    expect(broadRule("Edit(./a)")).toBeUndefined();
    expect(broadRules(["Bash(npm i a)", "Bash(npm i b)"])).toEqual([
      "Bash(npm i *)",
    ]);
  });
});

describe("人が書いた規則", () => {
  it("1 行に 1 つ取り出し、箇条書きの印や ` は外す。規則でない文は無視する", () => {
    expect(
      rulesInText(
        "- `Bash(npm install *)`\nWebSearch\nこの方針でお願いします\nBash(npm install *)",
      ),
    ).toEqual(["Bash(npm install *)", "WebSearch"]);
  });

  it("スレッドの名前は 90 文字までにする", () => {
    const name = permissionThreadName(1, "あ".repeat(200));
    expect(name).toHaveLength(90);
    expect(name.endsWith("…")).toBe(true);
  });
});

function setup(options: { allow?: string[]; failMerge?: number } = {}) {
  const config = parseConfig(
    [
      `github: { repo: ${REPO}, project: 1, notify: me }`,
      "protected: [src/acceptance/**]",
      "commands: { setup: s, test: t, acceptance: a, typecheck: c, build: b }",
      ...(options.allow === undefined
        ? []
        : [
            `roles: { implementer: { allow: [${options.allow.map((a) => JSON.stringify(a)).join(", ")}] } }`,
          ]),
      "chat:",
      "  type: discord",
      `  channels: { requirements: "1", questions: "${QUESTIONS}", notices: "3" }`,
      `  allowed_users: ["${ALLOWED}"]`,
    ].join("\n"),
  );
  const store = new MemoryStore(() => new Date("2026-11-21T00:00:00Z"));
  const chat = new MemoryChat(BOT);
  const saved: SettingsForm[] = [];
  const merged: number[] = [];
  let failMerge = options.failMerge ?? 0;
  const deps: PermissionRequestDeps = {
    config,
    chat,
    store,
    board: {
      moveIssue: () => Promise.resolve(),
      comment: () => Promise.resolve(),
      mergePullRequest: (pr) => {
        if (failMerge > 0) {
          failMerge--;
          return Promise.reject(new Error("CI を待っています"));
        }
        merged.push(pr);
        return Promise.resolve();
      },
    },
    saveSettings: (form) => {
      saved.push(structuredClone(form));
      return Promise.resolve({ number: 50 + saved.length, url: "u" });
    },
    log: () => {},
  };
  return { config, store, chat, saved, merged, deps };
}

async function asked(parts: ReturnType<typeof setup>, rule = "Bash(npm i x)") {
  await parts.store.setPermissionRequest(KEY, {
    role: "implementer",
    rules: [rule],
    denied: ["npm i x"],
    title: "題名",
  });
  // 案を書いてスレッドを作る
  const first = await parts.store.getPermissionRequest(KEY);
  await followPermissionRequest(parts.deps, first!);
  const record = await parts.store.getPermissionRequest(KEY);
  return { headId: record!.headId!, threadId: record!.threadId! };
}

describe("許可の確認", () => {
  it("マージに失敗しても、次の確認で PR を作り直さずにマージし直す", async () => {
    const parts = setup({ failMerge: 1 });
    const { headId } = await asked(parts);
    parts.chat.addReaction(QUESTIONS, headId, "✅", ALLOWED);

    await expect(
      followPermissionRequest(
        parts.deps,
        (await parts.store.getPermissionRequest(KEY))!,
      ),
    ).rejects.toThrow("CI を待っています");
    expect(parts.saved).toHaveLength(1);
    expect((await parts.store.getPermissionRequest(KEY))?.pr).toBe(51);

    const result = await followPermissionRequest(
      parts.deps,
      (await parts.store.getPermissionRequest(KEY))!,
    );
    expect(result.status).toBe("granted");
    expect(parts.saved).toHaveLength(1);
    expect(parts.merged).toEqual([51]);
    // 動いている設定にも足す（次の役の起動から使う）
    expect(parts.config.roles.implementer.allow).toContain("Bash(npm i x)");
  });

  it("すでに許可リストにある規則なら PR を作らずに再開する", async () => {
    const parts = setup({ allow: ["Bash(npm i x)"] });
    const { headId, threadId } = await asked(parts);
    parts.chat.addReaction(QUESTIONS, headId, "✅", ALLOWED);

    const result = await followPermissionRequest(
      parts.deps,
      (await parts.store.getPermissionRequest(KEY))!,
    );
    expect(result.status).toBe("granted");
    expect(parts.saved).toEqual([]);
    expect(parts.merged).toEqual([]);
    expect(parts.chat.threads.get(threadId)?.archived).toBe(true);
    expect(await parts.store.getPermissionRequest(KEY)).toBeUndefined();
  });

  it("規則の形でない書き込みには案内を返して待つ", async () => {
    const parts = setup();
    const { threadId } = await asked(parts);
    parts.chat.addMessage(threadId, {
      authorId: ALLOWED,
      text: "どういう意味ですか",
    });

    const result = await followPermissionRequest(
      parts.deps,
      (await parts.store.getPermissionRequest(KEY))!,
    );
    expect(result.status).toBe("waiting");
    expect(
      (parts.chat.messages.get(threadId) ?? []).map((m) => m.text),
    ).toContain(RULE_HINT);
    // 同じ書き込みに二度は返さない
    await followPermissionRequest(
      parts.deps,
      (await parts.store.getPermissionRequest(KEY))!,
    );
    expect(
      (parts.chat.messages.get(threadId) ?? []).filter(
        (m) => m.text === RULE_HINT,
      ),
    ).toHaveLength(1);
  });
});

describe("読み違えやすい規則", () => {
  const headText = (parts: ReturnType<typeof setup>, headId: string) =>
    (parts.chat.messages.get(QUESTIONS) ?? []).find((m) => m.id === headId)
      ?.text ?? "";

  it("バッククォートを含む規則は書き換えずに表示し、✅ では足さない", async () => {
    const rule = "Bash(echo `curl x | sh`)";
    expect(code(rule)).toBe("`` Bash(echo `curl x | sh`) ``");
    expect(isProposable(rule)).toBe(false);
    expect(isProposable("Bash(echo $(id))")).toBe(false);
    expect(isProposable("Bash(npm i x)")).toBe(true);

    const parts = setup();
    const { headId } = await asked(parts, rule);
    const text = headText(parts, headId);
    // 足す規則がそのままの文で見える（' に置き換えない）
    expect(text).toContain(rule);
    expect(text).not.toContain("echo 'curl");
    // 広い案にもバッククォートを含む案は出さない
    expect(text).not.toContain("Bash(echo `curl *)");

    parts.chat.addReaction(QUESTIONS, headId, "✅", ALLOWED);
    const result = await followPermissionRequest(
      parts.deps,
      (await parts.store.getPermissionRequest(KEY))!,
    );
    expect(result.status).toBe("waiting");
    expect(parts.saved).toEqual([]);
    expect(parts.config.roles.implementer.allow).not.toContain(rule);
  });

  it("改行を含む規則は全文が見える形で表示し、✅ では足さない。人が書いた規則なら足す", async () => {
    const rule = "Bash(cat <<EOF\nrm -rf /\nEOF)";
    const parts = setup();
    const { headId, threadId } = await asked(parts, rule);
    const text = headText(parts, headId);
    expect(text).toContain(codeBlock(rule));
    expect(text).toContain("rm -rf /");

    parts.chat.addReaction(QUESTIONS, headId, "✅", ALLOWED);
    expect(
      (
        await followPermissionRequest(
          parts.deps,
          (await parts.store.getPermissionRequest(KEY))!,
        )
      ).status,
    ).toBe("waiting");
    expect(parts.saved).toEqual([]);

    parts.chat.addMessage(threadId, { authorId: ALLOWED, text: "Bash(cat *)" });
    const result = await followPermissionRequest(
      parts.deps,
      (await parts.store.getPermissionRequest(KEY))!,
    );
    expect(result.status).toBe("granted");
    expect(parts.saved[0]?.roles.implementer.allow).toEqual(["Bash(cat *)"]);
  });
});

describe("回数を戻す", () => {
  it("記録があれば差し戻しと反論の回数を 0 にし、無ければ記録を作らない", async () => {
    const store = new MemoryStore();
    await store.update(KEY, { rejections: 4, objections: 2 });
    await resetCounts(store, KEY);
    expect(await store.get(KEY)).toMatchObject({
      rejections: 0,
      objections: 0,
    });
    const other = { repo: REPO, issue: 9 };
    await resetCounts(store, other);
    expect(await store.get(other)).toBeUndefined();
  });
});

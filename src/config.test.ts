import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chatTokenProblem,
  ConfigError,
  loadConfig,
  formatRoleDocs,
  loadRoleDocs,
  loadRoleInstructions,
  parseConfig,
} from "./config.js";

const FULL = `
github:
  repo: pkshimizu/wordcards
  project: 3
  columns:
    ready: 着手可
    testing: テスト中
    implementing: 実装中
    reviewing: レビュー中
    done: 完了
    blocked: 保留
  notify: pkshimizu
protected:
  - e2e/acceptance/**
  - supabase/seed.sql
commands:
  setup: npx supabase db reset
  test: npm test
  acceptance: npx playwright test e2e/acceptance
  typecheck: npm run typecheck
  build: npm run build
limits:
  rejections: 5
  objections: 1
poll_interval: 60
roles:
  tester:
    allow: ["Bash(npx playwright test *)"]
  reviewer:
    allow: []
`;

const MINIMAL = `
github:
  repo: pkshimizu/wordcards
  project: 3
  notify: pkshimizu
protected: [e2e/acceptance/**]
commands:
  setup: npx supabase db reset
  test: npm test
  acceptance: npx playwright test
  typecheck: npm run typecheck
  build: npm run build
`;

function issuesOf(source: string) {
  try {
    parseConfig(source);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as ConfigError).issues;
  }
  throw new Error("ConfigError にならなかった");
}

const CHAT = `
chat:
  type: discord
  channels:
    requirements: "11"
    questions: "12"
    notices: "13"
  allowed_users: ["21"]
`;

describe("chat", () => {
  it("書かなければ undefined", () => {
    expect(parseConfig(MINIMAL).chat).toBeUndefined();
  });

  it("書けば型付きで得られる", () => {
    expect(parseConfig(MINIMAL + CHAT).chat).toEqual({
      type: "discord",
      channels: { requirements: "11", questions: "12", notices: "13" },
      allowed_users: ["21"],
    });
  });

  it("discord 以外の種類・空の許可する人・token は誤り", () => {
    const paths = (source: string) => issuesOf(source).map((i) => i.path);
    const slack = CHAT.replace("discord", "slack");
    expect(paths(MINIMAL + slack)).toContain("chat.type");
    const noUsers = CHAT.replace('["21"]', "[]");
    expect(paths(MINIMAL + noUsers)).toContain("chat.allowed_users");
    const withToken = CHAT + "  token: secret\n";
    expect(paths(MINIMAL + withToken)).toContain("chat");
  });

  it("chatTokenProblem: chat が無ければトークンを求めない", () => {
    expect(chatTokenProblem(parseConfig(MINIMAL), {})).toBeUndefined();
  });

  it("chatTokenProblem: chat があればトークンを求める", () => {
    const config = parseConfig(MINIMAL + CHAT);
    const env = "CONDUCTOR_DISCORD_TOKEN";
    expect(chatTokenProblem(config, {})).toContain(env);
    expect(chatTokenProblem(config, { [env]: "  " })).toContain(env);
    expect(chatTokenProblem(config, { [env]: "secret" })).toBeUndefined();
  });
});

describe("parseConfig", () => {
  it("AC1: 正しい設定から全項目が型付きで得られる", () => {
    const c = parseConfig(FULL);
    expect(c.github).toEqual({
      repo: "pkshimizu/wordcards",
      project: 3,
      columns: {
        ready: "着手可",
        testing: "テスト中",
        implementing: "実装中",
        reviewing: "レビュー中",
        done: "完了",
        blocked: "保留",
      },
      notify: "pkshimizu",
    });
    expect(c.protected).toEqual(["e2e/acceptance/**", "supabase/seed.sql"]);
    expect(c.commands.setup).toBe("npx supabase db reset");
    expect(c.commands.acceptance).toBe("npx playwright test e2e/acceptance");
    expect(c.limits).toEqual({
      rejections: 5,
      objections: 1,
      reviewers: 3,
    });
    expect(c.poll_interval).toBe(60);
    expect(c.roles.tester.allow).toEqual(["Bash(npx playwright test *)"]);
    expect(c.roles.implementer.allow).toEqual([]);
  });

  it("AC2: 必須項目が欠けていると、その項目を示して止まる", () => {
    const source = MINIMAL.replace("  notify: pkshimizu\n", "").replace(
      "  build: npm run build\n",
      "",
    );
    expect(issuesOf(source)).toEqual([
      { path: "github.notify", message: "必須項目がありません" },
      { path: "commands.build", message: "必須項目がありません" },
    ]);
  });

  it("AC2: 型が違うと、その項目と理由を示して止まる", () => {
    const issues = issuesOf(
      MINIMAL.replace("project: 3", 'project: "三"') + "poll_interval: 1\n",
    );
    expect(issues.map((i) => i.path)).toEqual([
      "github.project",
      "poll_interval",
    ]);
    for (const i of issues) expect(i.message).not.toBe("");
  });

  it("language を書けばその言語になり、空文字は誤りにする", () => {
    expect(parseConfig(MINIMAL + "language: English\n").language).toBe(
      "English",
    );
    expect(issuesOf(MINIMAL + 'language: ""\n').map((i) => i.path)).toEqual([
      "language",
    ]);
  });

  it("AC2: 知らない項目（書き間違い）も誤りにする", () => {
    const issues = issuesOf(MINIMAL + "poll_intervl: 60\n");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain("poll_intervl");
  });

  it("AC2: YAML として読めないときも ConfigError", () => {
    expect(issuesOf("github: [")[0]!.message).toContain("YAML");
  });

  it("AC2: 誤りの一覧がエラーの文面に入る", () => {
    expect(() => parseConfig("{}", "x/config.yaml")).toThrow(
      /x\/config\.yaml[\s\S]*github/,
    );
  });

  it("AC3: 上限回数と確認間隔を省略すると既定値になる", () => {
    const c = parseConfig(MINIMAL);
    expect(c.limits).toEqual({
      rejections: 3,
      objections: 2,
      reviewers: 3,
    });
    expect(c.poll_interval).toBe(90);
    expect(c.language).toBe("日本語");
    expect(c.github.columns).toEqual({
      ready: "Ready",
      testing: "Testing",
      implementing: "Implementing",
      reviewing: "Reviewing",
      done: "Done",
      blocked: "Blocked",
    });
  });
});

describe("ファイルからの読み込み", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "conductor-config-"));
    await mkdir(join(dir, ".conductor"), { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loadConfig は .conductor/config.yaml を読む", async () => {
    await writeFile(join(dir, ".conductor", "config.yaml"), MINIMAL);
    expect((await loadConfig(dir)).github.repo).toBe("pkshimizu/wordcards");
  });

  it("config.yaml が無ければ ConfigError", async () => {
    await expect(loadConfig(dir)).rejects.toThrow(/ファイルがありません/);
  });

  it("<役>/ の .md をファイル名の順に読む（空・.md 以外は除く）", async () => {
    const d = join(dir, ".conductor", "reviewer");
    await mkdir(d, { recursive: true });
    await writeFile(join(d, "b-security.md"), "\n秘密を書かない。\n");
    await writeFile(join(d, "a-a11y.md"), "ラベルがある。");
    await writeFile(join(d, "empty.md"), "  \n");
    await writeFile(join(d, "memo.txt"), "読まない");
    expect(await loadRoleDocs(dir, "reviewer")).toEqual([
      { name: "a-a11y", text: "ラベルがある。" },
      { name: "b-security", text: "秘密を書かない。" },
    ]);
  });

  it("<役>/ の定義が見出し付きの追加の指示になる", async () => {
    const d = join(dir, ".conductor", "tester");
    await mkdir(d, { recursive: true });
    await writeFile(join(d, "locator.md"), "画面の文言で部品を探す。");
    await writeFile(join(d, "edge.md"), "0件と1件を確かめる。");
    expect(await loadRoleInstructions(dir, "tester")).toBe(
      [
        "# テスト観点",
        "",
        "このリポジトリで守ること・確かめることです。必ず従ってください。",
        "",
        "## edge",
        "",
        "0件と1件を確かめる。",
        "",
        "## locator",
        "",
        "画面の文言で部品を探す。",
      ].join("\n"),
    );
    expect(formatRoleDocs("implementer", [{ name: "x", text: "y" }])).toMatch(
      /^# 実装ルール/,
    );
  });

  it("フォルダが無い役は定義なし", async () => {
    expect(await loadRoleDocs(dir, "reviewer")).toEqual([]);
    expect(await loadRoleInstructions(dir, "reviewer")).toBe("");
  });
});

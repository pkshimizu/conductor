import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";
import {
  changedTabs,
  diffSettings,
  errorCounts,
  formOf,
  isSettingsData,
  isSettingsForm,
  numberValue,
  validateSettings,
} from "./settings-rules.js";

const SOURCE = [
  "github:",
  "  repo: o/n",
  "  project: 1",
  "  notify: someone",
  "protected:",
  '  - "src/acceptance/**"',
  "commands:",
  "  setup: npm ci",
  "  test: npm test",
  "  acceptance: npm run acceptance",
  "  typecheck: npm run typecheck",
  "  build: npm run build",
  "chat:",
  "  type: discord",
  "  channels:",
  '    requirements: "1"',
  '    questions: "2"',
  '    notices: "3"',
  "  allowed_users:",
  '    - "9"',
].join("\n");

const base = () => formOf(parseConfig(SOURCE));

describe("formOf", () => {
  it("既定値で埋め、数は文字列、無い項目は空にする", () => {
    const form = base();
    expect(form.limits).toEqual({
      rejections: "3",
      objections: "2",
      reviewers: "3",
    });
    expect(form.poll_interval).toBe("90");
    expect(form.screenshots).toBe("");
    expect(form.commands.format).toBe("");
    expect(form.github.columns.ready).toBe("Ready");
    expect(form.chat.enabled).toBe(true);
    expect(form.roles.tester.allow).toEqual([]);
  });

  it("chat が無ければ「Discord を使う」はオフで、値は空", () => {
    const form = formOf(parseConfig(SOURCE.split("chat:")[0]!));
    expect(form.chat).toEqual({
      enabled: false,
      channels: { requirements: "", questions: "", notices: "" },
      allowed_users: [],
    });
  });
});

describe("numberValue", () => {
  it("数として読めれば数、読めなければ文字のまま", () => {
    expect(numberValue("12")).toBe(12);
    expect(numberValue("2.5")).toBe(2.5);
    expect(numberValue("abc")).toBe("abc");
    expect(numberValue("")).toBe("");
  });
});

describe("validateSettings", () => {
  it("正しい値なら誤りは無い", () => {
    expect(validateSettings(base())).toEqual({});
  });

  it("項目ごとに誤りの種類を返す", () => {
    const form = base();
    form.limits.rejections = "0";
    form.poll_interval = "9";
    form.github.notify = "";
    form.commands.test = " ";
    form.protected = [];
    form.chat.allowed_users = [];
    const errors = validateSettings(form);
    expect(errors).toEqual({
      "limits.rejections": "int",
      poll_interval: "poll",
      "github.notify": "required",
      "commands.test": "required",
      protected: "minOne",
      "chat.allowed_users": "minOne",
    });
    expect(errorCounts(errors)).toEqual({
      general: 3,
      commands: 2,
      perms: 0,
      discord: 1,
      prompts: 0,
    });
  });

  it("@ のあるユーザー名はユーザー名の誤り", () => {
    const form = base();
    form.github.notify = "@someone";
    expect(validateSettings(form)).toEqual({ "github.notify": "user" });
  });

  it("Discord を使わないときは chat を点検しない", () => {
    const form = base();
    form.chat = {
      enabled: false,
      channels: { requirements: "", questions: "", notices: "" },
      allowed_users: [],
    };
    expect(validateSettings(form)).toEqual({});
  });
});

describe("diffSettings", () => {
  it("変えた項目だけを src/config.ts の項目名で返す", () => {
    const before = base();
    const after = base();
    after.limits.rejections = "5";
    after.roles.implementer.allow = ["Bash(npm run e2e)"];
    after.screenshots = "shots";
    const changes = diffSettings(before, after);
    expect(changes).toEqual([
      { path: "limits.rejections", before: "3", after: "5" },
      { path: "screenshots", after: "shots" },
      {
        path: "roles.implementer.allow",
        before: "[]",
        after: "[Bash(npm run e2e)]",
      },
    ]);
    expect([...changedTabs(changes)].sort()).toEqual(["general", "perms"]);
  });

  it("Discord をオフにすると chat を丸ごと消す", () => {
    const after = base();
    after.chat.enabled = false;
    expect(diffSettings(base(), after)).toEqual([
      { path: "chat", removed: true },
    ]);
  });

  it("Discord をオンにすると chat.type も出す", () => {
    const before = base();
    before.chat.enabled = false;
    const paths = diffSettings(before, base()).map((c) => c.path);
    expect(paths).toEqual([
      "chat.type",
      "chat.channels.requirements",
      "chat.channels.questions",
      "chat.channels.notices",
      "chat.allowed_users",
    ]);
  });

  it("Discord を使わないままなら、入力中の chat の値は変更にしない", () => {
    const before = base();
    before.chat.enabled = false;
    const after = structuredClone(before);
    after.chat.channels.questions = "99";
    expect(diffSettings(before, after)).toEqual([]);
  });
});

describe("isSettingsForm・isSettingsData", () => {
  it("形が合えば true、違えば false", () => {
    const form = base();
    expect(isSettingsForm(form)).toBe(true);
    expect(isSettingsForm({ ...form, protected: "x" })).toBe(false);
    expect(isSettingsForm(null)).toBe(false);
    const data = {
      repo: "o/n",
      project: 1,
      form,
      token: "unset",
      prompts: {
        tester: [{ name: "a.md", text: "x" }],
        implementer: [],
        reviewer: [],
        specifier: [],
        decomposer: [],
      },
    };
    expect(isSettingsData(data)).toBe(true);
    expect(isSettingsData({ ...data, token: "secret" })).toBe(false);
  });
});

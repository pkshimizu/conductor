import { describe, expect, it } from "vitest";
import type { SettingsData } from "../../src/settings-data.js";
import {
  addDraft,
  cancelSettings,
  confirmSettings,
  discardSettings,
  editForm,
  initSettings,
  needsTokenNotice,
  removeItem,
  reviewSettings,
  setDraft,
  SETTINGS_PATH,
  type SettingsState,
} from "./settings-state.js";

const DATA: SettingsData = {
  repo: "o/n",
  project: 1,
  token: "unset",
  form: {
    github: {
      notify: "someone",
      columns: {
        ready: "Ready",
        testing: "Testing",
        implementing: "Implementing",
        reviewing: "Reviewing",
        done: "Done",
        blocked: "Blocked",
      },
    },
    limits: { rejections: "3", objections: "2", reviewers: "3" },
    merge: { approval: "human" },
    poll_interval: "90",
    language: "日本語",
    screenshots: "",
    commands: {
      setup: "npm ci",
      test: "npm test",
      acceptance: "npm run acceptance",
      typecheck: "npm run typecheck",
      build: "npm run build",
      format: "",
    },
    protected: ["src/acceptance/**"],
    roles: {
      tester: { allow: [] },
      implementer: { allow: [] },
      reviewer: { allow: [] },
      specifier: { allow: [] },
      decomposer: { allow: [] },
    },
    chat: {
      enabled: false,
      channels: { requirements: "", questions: "", notices: "" },
      allowed_users: [],
    },
  },
  prompts: {
    tester: [],
    implementer: [],
    reviewer: [],
    specifier: [],
    decomposer: [],
  },
};

const changed = (): SettingsState =>
  editForm(initSettings(DATA), (f) => (f.poll_interval = "60"));

describe("settings-state", () => {
  it("初めは読み込んだ値で、基本のタブ", () => {
    const s = initSettings(DATA);
    expect(s.form).toEqual(DATA.form);
    expect(s.form).not.toBe(DATA.form);
    expect(s.tab).toBe("general");
  });

  it("変更が無いときは差分の確認を出さない", () => {
    expect(reviewSettings(initSettings(DATA), DATA).dialog).toBeUndefined();
    expect(reviewSettings(changed(), DATA).dialog).toBe("diff");
  });

  it("取り消すと読み込んだ値に戻り、ダイアログを閉じる", () => {
    const s = discardSettings(reviewSettings(changed(), DATA), DATA);
    expect(s.form).toEqual(DATA.form);
    expect(s.dialog).toBeUndefined();
    expect(cancelSettings(reviewSettings(changed(), DATA)).dialog).toBe(
      undefined,
    );
  });

  it("追加欄の値をリストに足し、空白だけや同じ値は足さない", () => {
    const list = (f: SettingsState["form"]) => f.protected;
    let s = setDraft(initSettings(DATA), "protected", " e2e/** ");
    s = addDraft(s, "protected", list);
    expect(s.form.protected).toEqual(["src/acceptance/**", "e2e/**"]);
    expect(s.drafts?.protected).toBe("");
    s = addDraft(setDraft(s, "protected", "e2e/**"), "protected", list);
    expect(s.form.protected).toEqual(["src/acceptance/**", "e2e/**"]);
    s = removeItem(s, list, "src/acceptance/**");
    expect(s.form.protected).toEqual(["e2e/**"]);
    expect(DATA.form.protected).toEqual(["src/acceptance/**"]);
  });

  it("保存に失敗したら failed にして、saved は入れない", async () => {
    const updates: SettingsState[] = [];
    const reviewed = reviewSettings(changed(), DATA);
    const final = await confirmSettings(
      reviewed,
      (path) => {
        expect(path).toBe(SETTINGS_PATH);
        return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
      },
      (s) => updates.push(s),
    );
    expect(updates[0]?.dialog).toBeUndefined();
    expect(final.failed).toBe(true);
    expect(final.saved).toBeUndefined();
  });

  it("頼めなかったときも failed にする", async () => {
    const final = await confirmSettings(
      reviewSettings(changed(), DATA),
      () => Promise.reject(new Error("offline")),
      () => {},
    );
    expect(final.failed).toBe(true);
  });

  it("トークンが未設定で入力中の「Discord を使う」がオンのときだけ案内を出す", () => {
    const on = editForm(initSettings(DATA), (f) => (f.chat.enabled = true));
    expect(needsTokenNotice(initSettings(DATA), DATA)).toBe(false);
    expect(needsTokenNotice(on, DATA)).toBe(true);
    const set: SettingsData = { ...DATA, token: "set" };
    expect(needsTokenNotice(on, set)).toBe(false);
  });
});

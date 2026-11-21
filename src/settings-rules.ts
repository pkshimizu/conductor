/**
 * 設定のフォームの決まり。config.yaml の値との行き来・入力の点検・変更点。
 * 点検は src/config.ts と同じ zod の定義（config-schema.ts）で行う。
 * Node の機能に触らないので、管理画面（web/）からも使う
 */
import { type Config, configSchema, ROLES } from "./config-schema.js";
import type { SettingsData, SettingsForm } from "./settings-data.js";

export type SettingsTab =
  "general" | "commands" | "perms" | "discord" | "prompts";

export const SETTINGS_TABS: readonly SettingsTab[] = [
  "general",
  "commands",
  "perms",
  "discord",
  "prompts",
];

export const COLUMN_KEYS = [
  "ready",
  "testing",
  "implementing",
  "reviewing",
  "done",
  "blocked",
] as const;

export const LIMIT_KEYS = ["rejections", "objections", "reviewers"] as const;

export const COMMAND_KEYS = [
  "setup",
  "test",
  "acceptance",
  "typecheck",
  "build",
  "format",
] as const;

export const CHANNEL_KEYS = ["requirements", "questions", "notices"] as const;

/** 誤りの種類（画面が文言にする） */
export type SettingsErrorKind = "int" | "poll" | "required" | "user" | "minOne";

/** 項目（src/config.ts の項目名。例: "limits.rejections"）ごとの誤り */
export type SettingsErrors = Readonly<Record<string, SettingsErrorKind>>;

/** 読み込んだ設定をフォームの値にする（数は文字列、無い項目は空） */
export function formOf(config: Config): SettingsForm {
  return {
    github: {
      notify: config.github.notify,
      columns: { ...config.github.columns },
    },
    limits: {
      rejections: String(config.limits.rejections),
      objections: String(config.limits.objections),
      reviewers: String(config.limits.reviewers),
    },
    merge: { approval: config.merge.approval },
    poll_interval: String(config.poll_interval),
    language: config.language,
    screenshots: config.screenshots ?? "",
    commands: {
      setup: config.commands.setup,
      test: config.commands.test,
      acceptance: config.commands.acceptance,
      typecheck: config.commands.typecheck,
      build: config.commands.build,
      format: config.commands.format ?? "",
    },
    protected: [...config.protected],
    roles: {
      tester: { allow: [...config.roles.tester.allow] },
      implementer: { allow: [...config.roles.implementer.allow] },
      reviewer: { allow: [...config.roles.reviewer.allow] },
      specifier: { allow: [...config.roles.specifier.allow] },
      decomposer: { allow: [...config.roles.decomposer.allow] },
    },
    chat:
      config.chat === undefined
        ? {
            enabled: false,
            channels: { requirements: "", questions: "", notices: "" },
            allowed_users: [],
          }
        : {
            enabled: true,
            channels: { ...config.chat.channels },
            allowed_users: [...config.chat.allowed_users],
          },
  };
}

/**
 * 数の欄の文字を config.yaml に書く値にする。数として読めれば数、読めなければ文字のまま
 * （文字のままなら config.ts の決まりで誤りになる）
 */
export function numberValue(text: string): number | string {
  return /^\s*-?\d+(\.\d+)?\s*$/.test(text) ? Number(text) : text;
}

/** フォームの値を、config.yaml に書く形（github.repo・github.project を除く）にする */
export function configValuesOf(form: SettingsForm): Record<string, unknown> {
  const values: Record<string, unknown> = {
    github: { notify: form.github.notify, columns: { ...form.github.columns } },
    protected: [...form.protected],
    commands: {
      setup: form.commands.setup,
      test: form.commands.test,
      acceptance: form.commands.acceptance,
      typecheck: form.commands.typecheck,
      build: form.commands.build,
      ...(form.commands.format === "" ? {} : { format: form.commands.format }),
    },
    limits: {
      rejections: numberValue(form.limits.rejections),
      objections: numberValue(form.limits.objections),
      reviewers: numberValue(form.limits.reviewers),
    },
    merge: { approval: form.merge.approval },
    ...(form.screenshots === "" ? {} : { screenshots: form.screenshots }),
    poll_interval: numberValue(form.poll_interval),
    language: form.language,
    roles: Object.fromEntries(
      ROLES.map((r) => [r, { allow: [...form.roles[r].allow] }]),
    ),
  };
  if (form.chat.enabled) {
    values.chat = {
      type: "discord",
      channels: { ...form.chat.channels },
      allowed_users: [...form.chat.allowed_users],
    };
  }
  return values;
}

/** 誤りのある場所（zod の path）を、フォームの項目名にする */
function fieldOf(path: readonly PropertyKey[]): string {
  const keys = path.map(String);
  const [first, second] = keys;
  if (first === "protected") return "protected";
  if (first === "chat" && second === "allowed_users")
    return "chat.allowed_users";
  if (first === "roles") return keys.slice(0, 3).join(".");
  return keys.join(".");
}

function kindOf(field: string, form: SettingsForm): SettingsErrorKind {
  if (field.startsWith("limits.")) return "int";
  if (field === "poll_interval") return "poll";
  if (field === "github.notify") {
    return form.github.notify.trim() === "" ? "required" : "user";
  }
  if (field === "protected") {
    return form.protected.length === 0 ? "minOne" : "required";
  }
  if (field === "chat.allowed_users") {
    return form.chat.allowed_users.length === 0 ? "minOne" : "required";
  }
  return "required";
}

/** フォームの値を config.ts の決まりで点検する。誤りが無ければ空 */
export function validateSettings(form: SettingsForm): SettingsErrors {
  // 見るだけの項目は点検の対象にしない（正しい形の値を仮に入れる）
  const raw = {
    ...configValuesOf(form),
    github: {
      notify: form.github.notify,
      columns: { ...form.github.columns },
      repo: "o/n",
      project: 1,
    },
  };
  const result = configSchema.safeParse(raw);
  const errors: Record<string, SettingsErrorKind> = {};
  if (result.success) return errors;
  for (const issue of result.error.issues) {
    const field = fieldOf(issue.path);
    errors[field] ??= kindOf(field, form);
  }
  return errors;
}

/** 項目が出ているタブ */
export function tabOf(field: string): SettingsTab {
  if (field.startsWith("commands.") || field === "protected") return "commands";
  if (field.startsWith("roles.")) return "perms";
  if (field === "chat" || field.startsWith("chat.")) return "discord";
  return "general";
}

/** タブごとの誤りの件数 */
export function errorCounts(
  errors: SettingsErrors,
): Readonly<Record<SettingsTab, number>> {
  const counts: Record<SettingsTab, number> = {
    general: 0,
    commands: 0,
    perms: 0,
    discord: 0,
    prompts: 0,
  };
  for (const field of Object.keys(errors)) counts[tabOf(field)] += 1;
  return counts;
}

/** 変更点の1つ。before・after が無いのは、config.yaml に書かない（無い）こと */
export interface SettingsChange {
  /** src/config.ts の項目名（例: "limits.rejections"）。chat を丸ごと消すときは "chat" */
  path: string;
  before?: string;
  after?: string;
  /** chat を丸ごと消す */
  removed?: true;
}

function listText(list: readonly string[]): string {
  return `[${list.join(", ")}]`;
}

/** 値の並び（項目名と、書く文字。書かないなら undefined） */
function entriesOf(form: SettingsForm): [string, string | undefined][] {
  const opt = (s: string) => (s === "" ? undefined : s);
  const entries: [string, string | undefined][] = [
    ["github.notify", form.github.notify],
    ...COLUMN_KEYS.map(
      (k) =>
        [`github.columns.${k}`, form.github.columns[k]] as [string, string],
    ),
    ...LIMIT_KEYS.map(
      (k) => [`limits.${k}`, form.limits[k]] as [string, string],
    ),
    ["merge.approval", form.merge.approval],
    ["poll_interval", form.poll_interval],
    ["language", form.language],
    ["screenshots", opt(form.screenshots)],
    ...COMMAND_KEYS.map(
      (k) =>
        [
          `commands.${k}`,
          k === "format" ? opt(form.commands[k]) : form.commands[k],
        ] as [string, string | undefined],
    ),
    ["protected", listText(form.protected)],
    ...ROLES.map(
      (r) =>
        [`roles.${r}.allow`, listText(form.roles[r].allow)] as [string, string],
    ),
  ];
  return entries;
}

function chatEntriesOf(form: SettingsForm): [string, string][] {
  return [
    ["chat.type", "discord"],
    ...CHANNEL_KEYS.map(
      (k) => [`chat.channels.${k}`, form.chat.channels[k]] as [string, string],
    ),
    ["chat.allowed_users", listText(form.chat.allowed_users)],
  ];
}

function change(
  path: string,
  before: string | undefined,
  after: string | undefined,
): SettingsChange {
  return {
    path,
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
  };
}

/** before から after への config.yaml の変更点（src/config.ts の項目名で） */
export function diffSettings(
  before: SettingsForm,
  after: SettingsForm,
): SettingsChange[] {
  const changes: SettingsChange[] = [];
  const a = new Map(entriesOf(after));
  for (const [path, value] of entriesOf(before)) {
    const next = a.get(path);
    if (value !== next) changes.push(change(path, value, next));
  }
  if (before.chat.enabled && !after.chat.enabled) {
    changes.push({ path: "chat", removed: true });
  } else if (!before.chat.enabled && after.chat.enabled) {
    for (const [path, value] of chatEntriesOf(after)) {
      changes.push(change(path, undefined, value));
    }
  } else if (before.chat.enabled && after.chat.enabled) {
    const next = new Map(chatEntriesOf(after));
    for (const [path, value] of chatEntriesOf(before)) {
      if (value !== next.get(path)) {
        changes.push(change(path, value, next.get(path)));
      }
    }
  }
  return changes;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === "string");

function hasStrings(v: unknown, keys: readonly string[]): boolean {
  return isRecord(v) && keys.every((k) => typeof v[k] === "string");
}

/** フォームの値の形か（中身の正しさは validateSettings と config.ts の決まりで確かめる） */
export function isSettingsForm(v: unknown): v is SettingsForm {
  if (!isRecord(v)) return false;
  const { github, limits, merge, commands, roles, chat } = v;
  return (
    isRecord(github) &&
    typeof github.notify === "string" &&
    hasStrings(github.columns, COLUMN_KEYS) &&
    hasStrings(limits, LIMIT_KEYS) &&
    isRecord(merge) &&
    (merge.approval === "auto" || merge.approval === "human") &&
    typeof v.poll_interval === "string" &&
    typeof v.language === "string" &&
    typeof v.screenshots === "string" &&
    hasStrings(commands, COMMAND_KEYS) &&
    isStrings(v.protected) &&
    isRecord(roles) &&
    ROLES.every((r) => {
      const role = roles[r];
      return isRecord(role) && isStrings(role.allow);
    }) &&
    isRecord(chat) &&
    typeof chat.enabled === "boolean" &&
    hasStrings(chat.channels, CHANNEL_KEYS) &&
    isStrings(chat.allowed_users)
  );
}

/** GET /api/settings で届いた内容の形か */
export function isSettingsData(v: unknown): v is SettingsData {
  if (!isRecord(v)) return false;
  const { prompts } = v;
  return (
    typeof v.repo === "string" &&
    typeof v.project === "number" &&
    isSettingsForm(v.form) &&
    (v.token === "set" || v.token === "unset") &&
    isRecord(prompts) &&
    ROLES.every((r) => {
      const list = prompts[r];
      return (
        Array.isArray(list) &&
        list.every(
          (p) =>
            isRecord(p) &&
            typeof p.name === "string" &&
            typeof p.text === "string",
        )
      );
    })
  );
}

/** 変更のあるタブ */
export function changedTabs(
  changes: readonly SettingsChange[],
): ReadonlySet<SettingsTab> {
  return new Set(changes.map((c) => tabOf(c.path)));
}

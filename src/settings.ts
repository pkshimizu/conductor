/**
 * 管理画面の「設定」の読み書き。
 * 対象リポジトリの .conductor/config.yaml と指示ファイルを読み、保存は新しいブランチへのコミットと PR で行う。
 * 保存では作業フォルダ（いまのブランチ・index・作業中のファイル）に触らない（git の低レベルの命令でコミットを作る）
 */
import { randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument } from "yaml";
import {
  CONDUCTOR_DIR,
  CONFIG_FILE,
  DISCORD_TOKEN_ENV,
  loadConfig,
  parseConfig,
  type Role,
  ROLES,
} from "./config.js";
import { Git } from "./git.js";
import type { SettingsData, SettingsForm } from "./settings-data.js";
import {
  CHANNEL_KEYS,
  COLUMN_KEYS,
  COMMAND_KEYS,
  diffSettings,
  formOf,
  LIMIT_KEYS,
  numberValue,
  type SettingsChange,
  validateSettings,
} from "./settings-rules.js";

export type { SettingsData, SettingsForm } from "./settings-data.js";

/** .conductor/<役>/*.md を、ファイル名の順に読む（見るだけなので中身はそのまま） */
async function loadPrompts(
  repoDir: string,
  role: Role,
): Promise<{ name: string; text: string }[]> {
  const dir = join(repoDir, CONDUCTOR_DIR, role);
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const names = entries
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => e.name)
    .sort();
  const list: { name: string; text: string }[] = [];
  for (const name of names) {
    list.push({ name, text: await readFile(join(dir, name), "utf8") });
  }
  return list;
}

/** repoDir の .conductor/config.yaml と指示ファイルを読む。token は env の CONDUCTOR_DISCORD_TOKEN で決める */
export async function loadSettings(
  repoDir: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<SettingsData> {
  const config = await loadConfig(repoDir);
  const prompts: Record<Role, { name: string; text: string }[]> = {
    tester: [],
    implementer: [],
    reviewer: [],
    specifier: [],
    decomposer: [],
  };
  for (const role of ROLES) prompts[role] = await loadPrompts(repoDir, role);
  return {
    repo: config.github.repo,
    project: config.github.project,
    form: formOf(config),
    token: env[DISCORD_TOKEN_ENV]?.trim() ? "set" : "unset",
    prompts,
  };
}

/** config.yaml の文を読めればフォームの値にする。読めなければ undefined */
function formOfSource(source: string): SettingsForm | undefined {
  try {
    return formOf(parseConfig(source));
  } catch {
    return undefined;
  }
}

const sameList = (a: readonly string[] | undefined, b: readonly string[]) =>
  a !== undefined && a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * config.yaml の文（source）を form の値に書き換えた文を返す。github.repo・github.project はそのまま残す。
 * chat.enabled が false なら chat を丸ごと消し、true なら chat.type: discord も書く。
 * いまの値（既定値を含む）と同じ項目は書き換えない（コメントや書き方を残す）
 */
export function applySettings(source: string, form: SettingsForm): string {
  const doc = parseDocument(source);
  const before = formOfSource(source);
  /** value が undefined なら項目を消す。unchanged なら何もしない */
  const put = (path: string[], value: unknown, unchanged: boolean) => {
    if (unchanged) return;
    if (value === undefined) {
      if (doc.hasIn(path)) doc.deleteIn(path);
      return;
    }
    doc.setIn(path, doc.createNode(value));
  };
  const opt = (s: string) => (s === "" ? undefined : s);

  put(
    ["github", "notify"],
    form.github.notify,
    before?.github.notify === form.github.notify,
  );
  for (const k of COLUMN_KEYS) {
    put(
      ["github", "columns", k],
      form.github.columns[k],
      before?.github.columns[k] === form.github.columns[k],
    );
  }
  for (const k of LIMIT_KEYS) {
    put(
      ["limits", k],
      numberValue(form.limits[k]),
      before?.limits[k] === form.limits[k],
    );
  }
  put(
    ["merge", "approval"],
    form.merge.approval,
    before?.merge.approval === form.merge.approval,
  );
  put(
    ["poll_interval"],
    numberValue(form.poll_interval),
    before?.poll_interval === form.poll_interval,
  );
  put(["language"], form.language, before?.language === form.language);
  put(
    ["screenshots"],
    opt(form.screenshots),
    before?.screenshots === form.screenshots,
  );
  for (const k of COMMAND_KEYS) {
    put(
      ["commands", k],
      k === "format" ? opt(form.commands[k]) : form.commands[k],
      before?.commands[k] === form.commands[k],
    );
  }
  put(
    ["protected"],
    [...form.protected],
    sameList(before?.protected, form.protected),
  );
  for (const r of ROLES) {
    put(
      ["roles", r, "allow"],
      [...form.roles[r].allow],
      sameList(before?.roles[r].allow, form.roles[r].allow),
    );
  }

  if (!form.chat.enabled) {
    if (doc.has("chat")) doc.delete("chat");
  } else if (before?.chat.enabled !== true) {
    doc.set(
      "chat",
      doc.createNode({
        type: "discord",
        channels: { ...form.chat.channels },
        allowed_users: [...form.chat.allowed_users],
      }),
    );
  } else {
    const was = before.chat;
    for (const k of CHANNEL_KEYS) {
      put(
        ["chat", "channels", k],
        form.chat.channels[k],
        was.channels[k] === form.chat.channels[k],
      );
    }
    put(
      ["chat", "allowed_users"],
      [...form.chat.allowed_users],
      sameList(was.allowed_users, form.chat.allowed_users),
    );
  }
  return doc.toString({ lineWidth: 0 });
}

/** フォームの値が config.ts の決まりに合わない */
export class SettingsInvalidError extends Error {
  constructor(readonly fields: readonly string[]) {
    super(`設定に誤りがあります: ${fields.join(", ")}`);
    this.name = "SettingsInvalidError";
  }
}

export interface SaveSettingsDeps {
  repoDir: string;
  github: {
    createPullRequest(input: {
      head: string;
      title: string;
      body: string;
      base?: string;
    }): Promise<{ number: number; url: string }>;
  };
  /** PR の向き先。省略したら "main" */
  base?: string;
  /** 対象リポジトリの git。省略したら repoDir の git */
  git?: Git;
  /** ブランチ名に使う時刻。省略したら今 */
  now?: () => Date;
}

const CONFIG_PATH = `${CONDUCTOR_DIR}/${CONFIG_FILE}`;

/** 新しいブランチの名前（例: conductor/settings-20261121-103000-1a2b3c） */
export function settingsBranch(now: Date, suffix: string): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `conductor/settings-${date}-${time}-${suffix}`;
}

/** 変更点を PR の本文にする */
export function settingsPrBody(changes: readonly SettingsChange[]): string {
  const show = (v: string | undefined) => (v === undefined ? "（なし）" : v);
  const lines = changes.map((c) =>
    c.removed === true
      ? `- \`${c.path}\`: （まるごと削除）`
      : `- \`${c.path}\`: ${show(c.before)} → ${show(c.after)}`,
  );
  return [
    `管理画面の設定から \`${CONFIG_PATH}\` を変更しました。`,
    "",
    ...(lines.length > 0 ? ["変更した項目:", ...lines, ""] : []),
    "マージしてから conductor を再起動すると反映されます。",
  ].join("\n");
}

/** NUL 区切りの出力を分ける */
function splitZ(out: string): string[] {
  return out.split("\0").filter((s) => s !== "");
}

/**
 * tree（無ければ空）の parts の場所に blob を置いた tree を作り、その ID を返す。
 * index や作業フォルダは使わない
 */
async function treeWith(
  git: Git,
  tree: string | undefined,
  parts: readonly string[],
  blob: string,
): Promise<string> {
  const [name, ...rest] = parts;
  if (name === undefined) throw new Error("置き場所がありません");
  const lines =
    tree === undefined ? [] : splitZ(await git.run(["ls-tree", "-z", tree]));
  const others: string[] = [];
  let found: { mode: string; type: string; id: string } | undefined;
  for (const line of lines) {
    const tab = line.indexOf("\t");
    if (line.slice(tab + 1) !== name) {
      others.push(line);
      continue;
    }
    const [mode = "", type = "", id = ""] = line.slice(0, tab).split(" ");
    found = { mode, type, id };
  }
  let entry: string;
  if (rest.length === 0) {
    const mode = found?.type === "blob" ? found.mode : "100644";
    entry = `${mode} blob ${blob}\t${name}`;
  } else {
    const sub = found?.type === "tree" ? found.id : undefined;
    entry = `040000 tree ${await treeWith(git, sub, rest, blob)}\t${name}`;
  }
  const input = [...others, entry].map((l) => `${l}\0`).join("");
  return (await git.run(["mktree", "-z"], input)).trim();
}

/**
 * origin の base から新しいブランチを作り、origin の base の config.yaml に applySettings したものをコミットして push し、
 * PR を作る。repoDir のいまのブランチ・作業中のファイル（未コミットの変更・追跡外のファイル）には触らない。
 * form が config.ts の決まりに合わなければ、何もせずに reject する
 */
export async function saveSettings(
  deps: SaveSettingsDeps,
  form: SettingsForm,
): Promise<{ number: number; url: string; branch: string }> {
  const invalid = Object.keys(validateSettings(form));
  if (invalid.length > 0) throw new SettingsInvalidError(invalid);
  const git = deps.git ?? new Git(deps.repoDir);
  const base = deps.base ?? "main";

  await git.run(["fetch", "-q", "origin", base]);
  const parent = (
    await git.run(["rev-parse", "--verify", `origin/${base}^{commit}`])
  ).trim();
  const source = await git.run(["show", `${parent}:${CONFIG_PATH}`]);
  const next = applySettings(source, form);
  // 書いたものが config.ts の決まりで読めることを確かめる（読めなければ ConfigError で止める）
  parseConfig(next, CONFIG_PATH);
  if (next === source) throw new Error("設定に変更がありません");

  const blob = (
    await git.run(["hash-object", "-w", "--no-filters", "--stdin"], next)
  ).trim();
  const tree = await treeWith(git, parent, CONFIG_PATH.split("/"), blob);
  const commit = (
    await git.run([
      "commit-tree",
      tree,
      "-p",
      parent,
      "-m",
      `chore: 管理画面から ${CONFIG_PATH} を変更`,
    ])
  ).trim();
  const branch = settingsBranch(
    (deps.now ?? (() => new Date()))(),
    randomBytes(3).toString("hex"),
  );
  await git.run(["push", "-q", "origin", `${commit}:refs/heads/${branch}`]);

  const before = formOfSource(source);
  const changes = before === undefined ? [] : diffSettings(before, form);
  const pr = await deps.github.createPullRequest({
    head: branch,
    base,
    title: `設定を変更（${CONFIG_PATH}）`,
    body: settingsPrBody(changes),
  });
  return { number: pr.number, url: pr.url, branch };
}

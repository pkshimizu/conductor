import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, YAMLParseError } from "yaml";
import {
  CONDUCTOR_DIR,
  CONFIG_FILE,
  type Config,
  configSchema,
  DISCORD_TOKEN_ENV,
  type Role,
} from "./config-schema.js";

// 決まり（zod の定義）は画面と共有するため config-schema.ts に置き、ここからも使えるようにする
export {
  CONDUCTOR_DIR,
  CONFIG_FILE,
  type ChatConfig,
  chatSchema,
  type Config,
  configSchema,
  DISCORD_TOKEN_ENV,
  type Role,
  ROLES,
} from "./config-schema.js";
export interface ConfigIssue {
  /** 誤りのある項目（例: "github.project"）。ファイル全体なら "" */
  path: string;
  message: string;
}

export class ConfigError extends Error {
  constructor(
    readonly file: string,
    readonly issues: ConfigIssue[],
  ) {
    super(
      [
        `設定に誤りがあります: ${file}`,
        ...issues.map((i) => `  - ${i.path || "(全体)"}: ${i.message}`),
      ].join("\n"),
    );
    this.name = "ConfigError";
  }
}

/** YAML の文字列を読み、型を点検する。誤りがあれば ConfigError */
export function parseConfig(source: string, file = CONFIG_FILE): Config {
  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (e) {
    if (e instanceof YAMLParseError) {
      throw new ConfigError(file, [
        { path: "", message: `YAML として読めません: ${e.message}` },
      ]);
    }
    throw e;
  }
  const result = configSchema.safeParse(raw ?? {}, { reportInput: true });
  if (!result.success) {
    throw new ConfigError(
      file,
      result.error.issues.map((i) => ({
        path: i.path.map(String).join("."),
        message:
          i.code === "invalid_type" && i.input === undefined
            ? "必須項目がありません"
            : i.message,
      })),
    );
  }
  return result.data;
}

/**
 * 窓口を使う設定なのにトークンが無ければ、その旨の文を返す。問題なければ undefined。
 * トークンの値そのものは返さない（ログに出さないため）
 */
export function chatTokenProblem(
  config: Pick<Config, "chat">,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  if (config.chat === undefined) return undefined;
  if (env[DISCORD_TOKEN_ENV]?.trim()) return undefined;
  return `窓口（chat.type: ${config.chat.type}）のトークンがありません。環境変数 ${DISCORD_TOKEN_ENV} に設定してください（config.yaml には書きません）`;
}

/** 対象リポジトリの .conductor/config.yaml を読む */
export async function loadConfig(repoDir: string): Promise<Config> {
  const file = join(repoDir, CONDUCTOR_DIR, CONFIG_FILE);
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConfigError(file, [
        { path: "", message: "ファイルがありません" },
      ]);
    }
    throw e;
  }
  return parseConfig(source, file);
}

/** 役ごとの定義ファイル（.conductor/<役>/*.md）の1つ */
export interface RoleDoc {
  /** 拡張子を除いたファイル名（例: "accessibility"） */
  name: string;
  text: string;
}

/** 役ごとの定義ファイルが何を書くものか（依頼に付ける見出し） */
export const ROLE_DOC_HEADINGS: Record<Role, string> = {
  tester: "テスト観点",
  implementer: "実装ルール",
  reviewer: "レビュー観点",
  specifier: "仕様化の決まり",
  decomposer: "分解の決まり",
};

/**
 * .conductor/<役>/ にある .md を、ファイル名の順に読む。
 * - tester: テスト観点、implementer: 実装ルール、reviewer: レビュー観点、specifier: 仕様化の決まり、
 *   decomposer: 分解の決まり
 * - フォルダが無ければ空。中身が空のファイルは除く
 */
export async function loadRoleDocs(
  repoDir: string,
  role: Role,
): Promise<RoleDoc[]> {
  const dir = join(repoDir, CONDUCTOR_DIR, role);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const docs: RoleDoc[] = [];
  for (const file of names.filter((n) => n.endsWith(".md")).sort()) {
    const text = (await readFile(join(dir, file), "utf8")).trim();
    if (text) docs.push({ name: file.slice(0, -".md".length), text });
  }
  return docs;
}

/** 定義ファイルを、役への追加の指示として1つの文にまとめる */
export function formatRoleDocs(role: Role, docs: readonly RoleDoc[]): string {
  if (docs.length === 0) return "";
  return [
    `# ${ROLE_DOC_HEADINGS[role]}`,
    "",
    "このリポジトリで守ること・確かめることです。必ず従ってください。",
    ...docs.flatMap((d) => ["", `## ${d.name}`, "", d.text]),
  ].join("\n");
}

/**
 * .conductor/<役>/*.md をまとめて、役への追加の指示として返す。
 * ファイルが無ければ空文字（追加の指示なし）。
 */
export async function loadRoleInstructions(
  repoDir: string,
  role: Role,
): Promise<string> {
  return formatRoleDocs(role, await loadRoleDocs(repoDir, role));
}

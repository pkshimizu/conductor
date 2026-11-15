import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, YAMLParseError } from "yaml";
import { z } from "zod";

z.config(z.locales.ja());

/** 対象リポジトリ内の設定フォルダ */
export const CONDUCTOR_DIR = ".conductor";
export const CONFIG_FILE = "config.yaml";

export const ROLES = ["tester", "implementer", "reviewer"] as const;
export type Role = (typeof ROLES)[number];

const text = z.string().trim().min(1);

const columnsSchema = z
  .object({
    ready: text.default("Ready"),
    testing: text.default("Testing"),
    implementing: text.default("Implementing"),
    reviewing: text.default("Reviewing"),
    done: text.default("Done"),
    blocked: text.default("Blocked"),
  })
  .strict();

const roleSchema = z
  .object({
    /** Claude Code の許可リストに追加する操作（例: "Bash(npx playwright test *)"） */
    allow: z.array(text).default([]),
  })
  .strict();

export const configSchema = z
  .object({
    github: z
      .object({
        /** owner/name */
        repo: z
          .string()
          .regex(/^[\w.-]+\/[\w.-]+$/, "owner/name の形で書いてください"),
        /** GitHub Projects の番号 */
        project: z.number().int().positive(),
        /** Projects の状態欄の名前 */
        columns: columnsSchema.prefault({}),
        /** Blocked のときにメンションする GitHub ユーザー名（@ は不要） */
        notify: z
          .string()
          .regex(
            /^[A-Za-z0-9-]+$/,
            "GitHub のユーザー名を @ なしで書いてください",
          ),
      })
      .strict(),
    /** 実装役が変えてはいけないファイル（受け入れテストと seed）。glob で書く */
    protected: z.array(text).min(1),
    commands: z
      .object({
        /** 準備（DB を空にして seed を入れるなど） */
        setup: text,
        test: text,
        acceptance: text,
        typecheck: text,
        build: text,
      })
      .strict(),
    limits: z
      .object({
        /** 差し戻しの上限（CI の失敗・レビューの指摘・ハッシュの不一致を合算） */
        rejections: z.number().int().positive().default(3),
        /** 異議の上限 */
        objections: z.number().int().positive().default(2),
      })
      .strict()
      .prefault({}),
    /** GitHub を確認する間隔（秒） */
    poll_interval: z.number().int().min(10).default(90),
    roles: z
      .object({
        tester: roleSchema.prefault({}),
        implementer: roleSchema.prefault({}),
        reviewer: roleSchema.prefault({}),
      })
      .strict()
      .prefault({}),
  })
  .strict();

export type Config = z.infer<typeof configSchema>;

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

/**
 * .conductor/roles/<役>.md の中身を、役への追加の指示として返す。
 * ファイルが無ければ空文字（追加の指示なし）。
 */
export async function loadRoleInstructions(
  repoDir: string,
  role: Role,
): Promise<string> {
  const file = join(repoDir, CONDUCTOR_DIR, "roles", `${role}.md`);
  try {
    return (await readFile(file, "utf8")).trim();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw e;
  }
}

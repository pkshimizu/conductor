/**
 * .conductor/config.yaml の決まり（zod の定義）。
 * Node の機能に触らないので、管理画面（web/）からも同じ決まりで入力を点検できる
 */
import { z } from "zod";

z.config(z.locales.ja());

/** 対象リポジトリ内の設定フォルダ */
export const CONDUCTOR_DIR = ".conductor";
export const CONFIG_FILE = "config.yaml";

export const ROLES = [
  "tester",
  "implementer",
  "reviewer",
  "specifier",
  "decomposer",
] as const;
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

/** Discord などの ID（数字の並びでも文字列で書く） */
const chatId = z.string().trim().min(1);

/**
 * 窓口（要件の受け取りと人への質問を行うチャット）の設定。
 * トークンは書かない（環境変数 CONDUCTOR_DISCORD_TOKEN で渡す）
 */
export const chatSchema = z
  .object({
    /** チャットの種類（今は discord のみ） */
    type: z.literal("discord"),
    channels: z
      .object({
        /** 要件を受け取るチャンネル */
        requirements: chatId,
        /** 人に質問するチャンネル */
        questions: chatId,
        /** お知らせを書くチャンネル */
        notices: chatId,
      })
      .strict(),
    /** 要件や回答を受け付ける人（ユーザー ID） */
    allowed_users: z.array(chatId).min(1),
  })
  .strict();

export type ChatConfig = z.infer<typeof chatSchema>;

/** 窓口（discord）のトークンを渡す環境変数 */
export const DISCORD_TOKEN_ENV = "CONDUCTOR_DISCORD_TOKEN";

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
        /**
         * 整形（例: npm run format）。書けばテスト役と実装役のコミット前に実行する。
         * テスト役は受け入れテストを整形済みで保護し（実装役の整形で保護対象が変わらないように）、
         * 実装役は整形済みのコードを push する（CI の整形チェックで落ちないように）
         */
        format: text.optional(),
      })
      .strict(),
    limits: z
      .object({
        /** 差し戻しの上限（CI の失敗・レビューの指摘・ハッシュの不一致を合算） */
        rejections: z.number().int().positive().default(3),
        /** 異議の上限 */
        objections: z.number().int().positive().default(2),
        /** レビュー観点ごとのレビュー役を、同時にいくつまで動かすか */
        reviewers: z.number().int().positive().default(3),
      })
      .strict()
      .prefault({}),
    merge: z
      .object({
        /**
         * レビュー役が承認した後のマージのしかた。
         * human: 人が PR に /conductor approve とコメントしてからマージする（既定）
         * auto: 人の確認なしにすぐマージする
         */
        approval: z.enum(["human", "auto"]).default("human"),
      })
      .strict()
      .prefault({}),
    /** 受け入れテストで各 AC の画面を撮影して保存するフォルダ。無ければ撮影しない */
    screenshots: text.optional(),
    /** GitHub を確認する間隔（秒） */
    poll_interval: z.number().int().min(10).default(90),
    /**
     * 役が書く文章（summary・findings・questions）の言語。例: 日本語、English。
     * conductor が書く定型文は対象外
     */
    language: text.default("日本語"),
    roles: z
      .object({
        tester: roleSchema.prefault({}),
        implementer: roleSchema.prefault({}),
        reviewer: roleSchema.prefault({}),
        specifier: roleSchema.prefault({}),
        decomposer: roleSchema.prefault({}),
      })
      .strict()
      .prefault({}),
    /** 窓口のチャット。無ければ窓口を使わない */
    chat: chatSchema.optional(),
  })
  .strict();

export type Config = z.infer<typeof configSchema>;

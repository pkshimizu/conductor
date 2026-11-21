/**
 * 管理画面の「設定」の内容（画面とサーバーで共有する型だけ。web からも import type する）
 */
import type { Role } from "./config-schema.js";

/** フォームの値。項目名は src/config.ts と同じ。数は入力どおりの文字列で持つ */
export interface SettingsForm {
  github: {
    notify: string;
    columns: {
      ready: string;
      testing: string;
      implementing: string;
      reviewing: string;
      done: string;
      blocked: string;
    };
  };
  limits: { rejections: string; objections: string; reviewers: string };
  merge: { approval: "human" | "auto" };
  poll_interval: string;
  language: string;
  /** 空なら config.yaml に書かない（撮影しない） */
  screenshots: string;
  /** format は空なら書かない */
  commands: {
    setup: string;
    test: string;
    acceptance: string;
    typecheck: string;
    build: string;
    format: string;
  };
  protected: string[];
  roles: Record<Role, { allow: string[] }>;
  /** enabled は「Discord を使う」。false のときも channels・allowed_users は入力中の値として持つ */
  chat: {
    enabled: boolean;
    channels: { requirements: string; questions: string; notices: string };
    allowed_users: string[];
  };
}

export interface SettingsData {
  /** config.github.repo（見るだけ） */
  repo: string;
  /** config.github.project（見るだけ） */
  project: number;
  /** config.yaml の値（既定値で埋めたもの） */
  form: SettingsForm;
  /** Discord のトークンがあるか。値そのものは入れない */
  token: "set" | "unset";
  /** 役ごとの指示ファイル（.conductor/<役>/*.md）。name は "acceptance.md" のようにファイル名、ファイル名の順 */
  prompts: Record<Role, { name: string; text: string }[]>;
}

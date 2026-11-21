/**
 * origin の base にある .conductor/config.yaml を読む（作業フォルダには触らない）。
 * 指揮役が起動したあとに main で設定が変わっていても、最新の設定から PR を作るために使う
 */
import { CONDUCTOR_DIR, CONFIG_FILE, parseConfig } from "./config.js";
import { Git } from "./git.js";
import type { SettingsForm } from "./settings-data.js";
import { formOf } from "./settings-rules.js";

const CONFIG_PATH = `${CONDUCTOR_DIR}/${CONFIG_FILE}`;

/** origin の base を取り込み、その config.yaml をフォームの値にする。読めなければ ConfigError などで reject する */
export async function loadBaseSettings(deps: {
  repoDir: string;
  /** 省略したら "main" */
  base?: string;
  /** 省略したら repoDir の git */
  git?: Git;
}): Promise<SettingsForm> {
  const git = deps.git ?? new Git(deps.repoDir);
  const base = deps.base ?? "main";
  await git.run(["fetch", "-q", "origin", base]);
  const source = await git.run(["show", `origin/${base}:${CONFIG_PATH}`]);
  return formOf(parseConfig(source, CONFIG_PATH));
}

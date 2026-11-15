import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { ConfigError, loadConfig } from "./config.js";

export interface Output {
  out: (text: string) => void;
  err: (text: string) => void;
}

const consoleOutput: Output = {
  out: (text) => console.log(text),
  err: (text) => console.error(text),
};

export const HELP = `使い方: conductor <コマンド> [オプション]

コマンド:
  check [フォルダ]  対象リポジトリの .conductor/config.yaml を点検する（既定は今のフォルダ）
  start [フォルダ]  常駐して Ready の Issue を進める（Ctrl+C で、今の段階を終えてから止まる）

オプション:
  -h, --help     この説明を表示する
  -v, --version  バージョンを表示する`;

export function version(): string {
  // src（テスト）と dist（ビルド後）のどちらから呼んでも 1 つ上が package.json
  const url = new URL("../package.json", import.meta.url);
  const pkg = JSON.parse(readFileSync(url, "utf8")) as { version: string };
  return pkg.version;
}

/** CLI の入口。終了コードを返す */
export async function main(
  argv: string[],
  output: Output = consoleOutput,
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (e) {
    output.err((e as Error).message);
    output.err(HELP);
    return 2;
  }

  const { values, positionals } = parsed;
  if (values.version) {
    output.out(version());
    return 0;
  }
  const [command, ...rest] = positionals;
  if (values.help || command === undefined) {
    output.out(HELP);
    return 0;
  }

  switch (command) {
    case "check":
      return check(resolve(rest[0] ?? "."), output);
    case "start":
      return startCommand(resolve(rest[0] ?? "."), output);
    default:
      output.err(`不明なコマンド: ${command}`);
      output.err(HELP);
      return 2;
  }
}

async function startCommand(repoDir: string, output: Output): Promise<number> {
  let config;
  try {
    config = await loadConfig(repoDir);
  } catch (e) {
    if (e instanceof ConfigError) {
      output.err(e.message);
      return 1;
    }
    throw e;
  }
  const { start } = await import("./start.js");
  await start(repoDir, config, (text) =>
    output.out(`[${new Date().toLocaleTimeString("ja-JP")}] ${text}`),
  );
  return 0;
}

async function check(repoDir: string, output: Output): Promise<number> {
  try {
    const config = await loadConfig(repoDir);
    output.out(`設定は正しく読めました: ${config.github.repo}`);
    return 0;
  } catch (e) {
    if (e instanceof ConfigError) {
      output.err(e.message);
      return 1;
    }
    throw e;
  }
}

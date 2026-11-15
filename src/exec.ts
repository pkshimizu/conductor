/** 外部コマンド（claude・gh など）を起動する部品。テストでは偽物に差し替える */
import { spawn } from "node:child_process";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  /** 標準入力に渡す文字列 */
  input?: string;
  /** 制限時間（ミリ秒） */
  timeoutMs?: number;
}

export type Exec = (
  args: string[],
  options: ExecOptions,
) => Promise<ExecResult>;

/** command を子プロセスで起動する（シェルは通さない） */
export function commandExec(command: string): Exec {
  return (args, { cwd, input, timeoutMs } = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        ...(cwd !== undefined && { cwd }),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        ...(timeoutMs !== undefined && { timeout: timeoutMs }),
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on("data", (b: Buffer) => out.push(b));
      child.stderr.on("data", (b: Buffer) => err.push(b));
      child.on("error", reject);
      child.on("close", (code) =>
        resolve({
          code,
          stdout: Buffer.concat(out).toString("utf8"),
          stderr: Buffer.concat(err).toString("utf8"),
        }),
      );
      child.stdin.end(input ?? "", "utf8");
    });
}

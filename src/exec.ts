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
  /**
   * 中断の signal。来たら子プロセスとその子孫をすべて終わらせ（Windows でも残さない）、
   * 終わってから name が "AbortError" の Error で reject する
   */
  signal?: AbortSignal;
}

/** 中断されたことを表すエラー（name は "AbortError"） */
export function abortError(message = "中断しました"): Error {
  const e = new Error(message);
  e.name = "AbortError";
  return e;
}

/** 中断で終わったエラーか */
export function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

export type Exec = (
  args: string[],
  options: ExecOptions,
) => Promise<ExecResult>;

/** command を子プロセスで起動する（シェルは通さない） */
export function commandExec(command: string): Exec {
  return (args, options = {}) => spawnCollect(command, args, options, false);
}

/** 設定に書かれたコマンド（例: "npm run e2e"）をシェルで実行する */
export type Shell = (
  command: string,
  options: Omit<ExecOptions, "input">,
) => Promise<ExecResult>;

export const shellExec: Shell = (command, options = {}) =>
  spawnCollect(command, [], options, true);

const isWindows = process.platform === "win32";

/**
 * 子プロセスとその子孫をすべて終わらせる。
 * Windows は taskkill /T /F で木ごと、ほかはプロセスグループごと（detached で起動したもの）に SIGKILL を送る
 */
export function killTree(pid: number): Promise<void> {
  if (isWindows) {
    return new Promise((done) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("error", () => {
        try {
          process.kill(pid);
        } catch {
          // もう終わっている
        }
        done();
      });
      killer.on("exit", () => done());
    });
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // もう終わっている
    }
  }
  return Promise.resolve();
}

function spawnCollect(
  command: string,
  args: string[],
  { cwd, input, timeoutMs, signal }: ExecOptions,
  shell: boolean,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortError());
      return;
    }
    const child = spawn(command, args, {
      ...(cwd !== undefined && { cwd }),
      shell,
      // 入力が無ければ標準入力は閉じておく（すぐ終わるコマンドへの書き込みで EPIPE になるため）
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
      // 中断できるときは、子孫までまとめて終わらせられるようプロセスグループを分ける（Windows 以外）
      ...(signal !== undefined && !isWindows && { detached: true }),
      ...(timeoutMs !== undefined && { timeout: timeoutMs }),
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let aborting: Promise<void> | undefined;
    let exited = false;
    const onAbort = () => {
      if (aborting !== undefined || exited) return;
      const pid = child.pid;
      aborting = pid === undefined ? Promise.resolve() : killTree(pid);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (b: Buffer) => out.push(b));
    child.stderr?.on("data", (b: Buffer) => err.push(b));
    child.on("error", (e) => {
      signal?.removeEventListener("abort", onAbort);
      reject(e);
    });
    child.on("exit", () => {
      exited = true;
      // 中断したときは、残った子孫が出力をつかんでいても待たない
      if (aborting !== undefined) {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (aborting !== undefined) {
        void aborting.then(() => reject(abortError()));
        return;
      }
      resolve({
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
    if (input !== undefined && child.stdin) {
      // 読まずに終わる子プロセスでも落ちないよう、書き込みの失敗は無視する
      child.stdin.on("error", () => {});
      child.stdin.end(input, "utf8");
    }
  });
}

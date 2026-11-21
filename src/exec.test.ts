import { describe, expect, it } from "vitest";
import { abortError, commandExec, isAbortError, shellExec } from "./exec.js";

describe("exec", () => {
  it("入力を渡してコマンドを実行する", async () => {
    const exec = commandExec(process.execPath);
    const r = await exec(["-e", "process.stdin.pipe(process.stdout)"], {
      input: "こんにちは",
    });
    expect(r).toEqual({ code: 0, stdout: "こんにちは", stderr: "" });
  });

  it("シェルでコマンドを実行し、終了コードと出力を返す", async () => {
    const r = await shellExec(
      `"${process.execPath}" -e "console.error('x'); process.exit(3)"`,
      {},
    );
    expect(r.code).toBe(3);
    expect(r.stderr.trim()).toBe("x");
  });

  it("中断の signal が来たら子プロセスを終わらせ、AbortError で reject する", async () => {
    const controller = new AbortController();
    const running = commandExec(process.execPath)(
      ["-e", "console.log('started'); setInterval(() => {}, 1000)"],
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 200);
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
  });

  it("はじめから中断されていたら起動しない", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      commandExec(process.execPath)(["-e", ""], { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("中断されなければいつもどおり結果を返す", async () => {
    const controller = new AbortController();
    const r = await commandExec(process.execPath)(
      ["-e", "process.stdout.write('ok')"],
      { signal: controller.signal },
    );
    expect(r).toEqual({ code: 0, stdout: "ok", stderr: "" });
    expect(isAbortError(abortError())).toBe(true);
    expect(isAbortError(new Error("x"))).toBe(false);
  });
});

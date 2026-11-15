import { describe, expect, it } from "vitest";
import { commandExec, shellExec } from "./exec.js";

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
});

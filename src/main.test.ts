import { describe, expect, it } from "vitest";
import { HELP, main, version, type Output } from "./main.js";

function capture(): Output & { outs: string[]; errs: string[] } {
  const outs: string[] = [];
  const errs: string[] = [];
  return { outs, errs, out: (t) => outs.push(t), err: (t) => errs.push(t) };
}

describe("main", () => {
  it("--version で package.json のバージョンを表示する", async () => {
    const o = capture();
    expect(await main(["--version"], o)).toBe(0);
    expect(o.outs).toEqual([version()]);
    expect(version()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("引数なしで使い方を表示する", async () => {
    const o = capture();
    expect(await main([], o)).toBe(0);
    expect(o.outs).toEqual([HELP]);
  });

  it("不明なコマンドは終了コード 2", async () => {
    const o = capture();
    expect(await main(["foo"], o)).toBe(2);
    expect(o.errs[0]).toBe("不明なコマンド: foo");
  });

  it("不明なオプションは終了コード 2", async () => {
    const o = capture();
    expect(await main(["--foo"], o)).toBe(2);
  });
});

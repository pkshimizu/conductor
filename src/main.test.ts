import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("check は設定が正しければ 0、誤りがあれば 1 と誤りの一覧", async () => {
    const dir = await mkdtemp(join(tmpdir(), "conductor-main-"));
    try {
      await mkdir(join(dir, ".conductor"));
      const file = join(dir, ".conductor", "config.yaml");
      await writeFile(file, "github:\n  repo: a/b\n");
      const ng = capture();
      expect(await main(["check", dir], ng)).toBe(1);
      expect(ng.errs[0]).toContain("github.project");

      await writeFile(
        file,
        [
          "github: { repo: a/b, project: 1, notify: someone }",
          "protected: [e2e/**]",
          "commands: { setup: s, test: t, acceptance: a, typecheck: c, build: b }",
        ].join("\n"),
      );
      const ok = capture();
      expect(await main(["check", dir], ok)).toBe(0);
      expect(ok.outs[0]).toContain("a/b");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

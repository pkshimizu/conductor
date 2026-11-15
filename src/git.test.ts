import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Git, globToRegExp, matchesAny } from "./git.js";

describe("globToRegExp", () => {
  it.each([
    ["e2e/**", "e2e/a.spec.ts", true],
    ["e2e/**", "e2e/sub/a.spec.ts", true],
    ["e2e/**", "src/e2e/a.ts", false],
    ["**/*.spec.ts", "a.spec.ts", true],
    ["**/*.spec.ts", "x/y/a.spec.ts", true],
    ["supabase/seed.sql", "supabase/seed.sql", true],
    ["supabase/seed.sql", "supabase/seedXsql", false],
    ["e2e/*.ts", "e2e/sub/a.ts", false],
    ["e2e/?.ts", "e2e/a.ts", true],
  ])("%s と %s → %s", (glob, path, expected) => {
    expect(globToRegExp(glob).test(path)).toBe(expected);
  });

  it("matchesAny はどれか1つに当たれば true", () => {
    expect(matchesAny("seed.sql", ["e2e/**", "seed.sql"])).toBe(true);
    expect(matchesAny("src/a.ts", ["e2e/**", "seed.sql"])).toBe(false);
  });
});

/** 本物の git で、一時フォルダのリポジトリを操作して確かめる */
describe("Git（本物の git）", () => {
  let dir: string;
  let git: Git;
  const sh = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  const put = async (path: string, text: string) => {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), text);
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "conductor-git-"));
    sh("init", "-q", "-b", "main");
    sh("config", "user.email", "test@example.com");
    sh("config", "user.name", "test");
    sh("config", "core.autocrlf", "false");
    await put("src/app.ts", "app\n");
    await put("e2e/old.spec.ts", "old\n");
    await put(".conductor/config.yaml", "a: 1\n");
    sh("add", "-A");
    sh("commit", "-q", "-m", "init");
    git = new Git(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("変更・追加したファイルを並べる", async () => {
    expect(await git.isClean()).toBe(true);
    await put("src/app.ts", "changed\n");
    await put("e2e/new.spec.ts", "new\n");
    expect(await git.changedFiles()).toEqual(["e2e/new.spec.ts", "src/app.ts"]);
    expect(await git.isClean()).toBe(false);
  });

  it("discard は指定したファイルだけ元に戻す", async () => {
    await put("src/app.ts", "changed\n");
    await put("src/extra.ts", "extra\n");
    await put("e2e/new.spec.ts", "new\n");
    await git.discard(["src/app.ts", "src/extra.ts"]);
    expect(await git.changedFiles()).toEqual(["e2e/new.spec.ts"]);
  });

  it("commit は指定したファイルだけを入れる", async () => {
    await put("e2e/new.spec.ts", "new\n");
    await put("src/app.ts", "changed\n");
    const id = await git.commit(["e2e/new.spec.ts"], "test: add");
    expect(id).toMatch(/^[0-9a-f]{40}$/);
    expect(await git.changedFiles()).toEqual(["src/app.ts"]);
    await git.discardAll();
    expect(await git.isClean()).toBe(true);
  });

  it("treeHash は対象の中身・追加・削除で変わり、対象外では変わらない", async () => {
    const globs = ["e2e/**", ".conductor/**"];
    const base = await git.treeHash("HEAD", globs);

    await put("src/app.ts", "changed\n");
    await git.commit(["src/app.ts"], "src");
    expect(await git.treeHash("HEAD", globs)).toBe(base);

    await put(".conductor/config.yaml", "a: 2\n");
    await git.commit([".conductor/config.yaml"], "conf");
    const changed = await git.treeHash("HEAD", globs);
    expect(changed).not.toBe(base);

    await put("e2e/added.spec.ts", "x\n");
    await git.commit(["e2e/added.spec.ts"], "add");
    const added = await git.treeHash("HEAD", globs);
    expect(added).not.toBe(changed);

    sh("rm", "-q", "e2e/added.spec.ts");
    sh("commit", "-q", "-m", "rm");
    expect(await git.treeHash("HEAD", globs)).toBe(changed);
  });

  it("失敗したら GitError を投げる", async () => {
    await expect(git.run(["rev-parse", "no-such-ref"])).rejects.toThrow(
      /git rev-parse no-such-ref が失敗しました/,
    );
  });
});

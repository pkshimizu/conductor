/** 対象リポジトリの git 操作。git も Exec で受け取り、テストでは偽物に差し替える */
import { createHash } from "node:crypto";
import { commandExec, type Exec } from "./exec.js";

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly detail: string,
  ) {
    super(`git ${args.join(" ")} が失敗しました: ${detail}`);
    this.name = "GitError";
  }
}

/** glob（**、*、?）を正規表現にする。パスは / 区切り・リポジトリからの相対 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}

/** NUL 区切りの出力を分ける */
function splitZ(out: string): string[] {
  return out.split("\0").filter((s) => s !== "");
}

export class Git {
  constructor(
    readonly cwd: string,
    private readonly exec: Exec = commandExec("git"),
  ) {}

  /** git を実行して標準出力を返す。input は標準入力に渡す */
  async run(args: string[], input?: string): Promise<string> {
    const res = await this.exec(args, {
      cwd: this.cwd,
      ...(input === undefined ? {} : { input }),
    });
    if (res.code !== 0) {
      throw new GitError(args, (res.stderr || res.stdout).trim());
    }
    return res.stdout;
  }

  /** 変更のあるファイル（追跡外を含む）。リポジトリからの相対パス */
  async changedFiles(): Promise<string[]> {
    const tracked = splitZ(
      await this.run(["diff", "--name-only", "-z", "HEAD"]),
    );
    const untracked = splitZ(
      await this.run(["ls-files", "-z", "--others", "--exclude-standard"]),
    );
    return [...new Set([...tracked, ...untracked])].sort();
  }

  async isClean(): Promise<boolean> {
    return (await this.run(["status", "--porcelain"])).trim() === "";
  }

  /** origin の base から branch を作り直して切り替える */
  async startBranch(branch: string, base = "main"): Promise<void> {
    await this.run(["fetch", "origin", base]);
    await this.run(["switch", "-C", branch, `origin/${base}`]);
  }

  /** 指定したファイルの変更を捨てる（追跡外なら消す） */
  async discard(paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return;
    const inHead = new Set(
      splitZ(
        await this.run([
          "ls-tree",
          "-r",
          "-z",
          "--name-only",
          "HEAD",
          "--",
          ...paths,
        ]),
      ),
    );
    const tracked = paths.filter((p) => inHead.has(p));
    const untracked = paths.filter((p) => !inHead.has(p));
    if (tracked.length > 0) {
      await this.run(["checkout", "HEAD", "--", ...tracked]);
    }
    if (untracked.length > 0) {
      await this.run([
        "rm",
        "-q",
        "--cached",
        "--ignore-unmatch",
        "--",
        ...untracked,
      ]);
      await this.run(["clean", "-q", "-f", "--", ...untracked]);
    }
  }

  /** すべての変更を捨てる */
  async discardAll(): Promise<void> {
    await this.run(["reset", "-q", "--hard", "HEAD"]);
    await this.run(["clean", "-q", "-fd"]);
  }

  /** 指定したファイルをコミットし、コミットの ID を返す */
  async commit(paths: readonly string[], message: string): Promise<string> {
    await this.run(["add", "-A", "--", ...paths]);
    await this.run(["commit", "-q", "-m", message]);
    return (await this.run(["rev-parse", "HEAD"])).trim();
  }

  /**
   * origin の base を、origin の branch に取り込む（マージコミットを作る）。
   * 衝突したらマージの途中のまま止め、衝突したファイルを返す。衝突が無ければ空の配列
   */
  async mergeBase(branch: string, base = "main"): Promise<string[]> {
    await this.startBranch(branch, branch);
    await this.run(["fetch", "origin", base]);
    const args = ["merge", "--no-edit", `origin/${base}`];
    const res = await this.exec(args, { cwd: this.cwd });
    if (res.code === 0) return [];
    const conflicts = splitZ(
      await this.run(["diff", "--name-only", "--diff-filter=U", "-z"]),
    ).sort();
    if (conflicts.length === 0) {
      throw new GitError(args, (res.stderr || res.stdout).trim());
    }
    return conflicts;
  }

  /** 途中のマージをやめる */
  async abortMerge(): Promise<void> {
    await this.run(["merge", "--abort"]);
  }

  /** 途中のマージを、衝突のしるしを残したままコミットする */
  async commitMerge(message: string): Promise<string> {
    await this.run(["add", "-A"]);
    await this.run(["commit", "-q", "--no-verify", "-m", message]);
    return (await this.run(["rev-parse", "HEAD"])).trim();
  }

  /** origin の base から HEAD までの差分（stat なら変更の一覧） */
  async diffFrom(base: string, options: { stat?: boolean } = {}) {
    await this.run(["fetch", "-q", "origin", base]);
    return this.run([
      "diff",
      "--no-color",
      ...(options.stat ? ["--stat"] : []),
      `origin/${base}...HEAD`,
    ]);
  }

  async push(branch: string): Promise<void> {
    await this.run([
      "push",
      "-q",
      "--force-with-lease",
      "-u",
      "origin",
      branch,
    ]);
  }

  /** ref の時点で globs に当たるファイルの一覧（ls-tree の行） */
  async treeEntries(ref: string, globs: readonly string[]): Promise<string[]> {
    return splitZ(await this.run(["ls-tree", "-r", "-z", "--full-tree", ref]))
      .filter((line) => matchesAny(line.slice(line.indexOf("\t") + 1), globs))
      .sort();
  }

  /** ref の時点で globs に当たるファイルの中身のハッシュ。中身・名前・追加・削除で変わる */
  async treeHash(ref: string, globs: readonly string[]): Promise<string> {
    const entries = await this.treeEntries(ref, globs);
    return createHash("sha256").update(entries.join("\n")).digest("hex");
  }
}

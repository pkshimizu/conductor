import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";
import type { Exec } from "./exec.js";
import { Git } from "./git.js";
import { formOf } from "./settings-rules.js";
import {
  applySettings,
  loadSettings,
  saveSettings,
  settingsBranch,
  settingsPrBody,
  SettingsInvalidError,
} from "./settings.js";

const SOURCE = [
  "# conductor の設定",
  "github:",
  "  repo: o/n",
  "  project: 2",
  "  notify: someone # 知らせる人",
  "protected:",
  '  - "src/acceptance/**"',
  "commands:",
  "  setup: npm ci",
  "  test: npm test",
  "  acceptance: npm run acceptance",
  "  typecheck: npm run typecheck",
  "  build: npm run build",
  "",
].join("\n");

const form = () => formOf(parseConfig(SOURCE));

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) {
    await rm(dirs.pop()!, { recursive: true, force: true });
  }
});

describe("applySettings", () => {
  it("変えていなければ文はそのまま（既定値の項目も書き足さない）", () => {
    expect(applySettings(SOURCE, form())).toBe(SOURCE);
  });

  it("変えた項目だけを書き換え、コメントは残す", () => {
    const f = form();
    f.limits.reviewers = "4";
    f.github.columns.done = "Shipped";
    const out = applySettings(SOURCE, f);
    expect(out).toContain("# conductor の設定");
    expect(out).toContain("# 知らせる人");
    const config = parseConfig(out);
    expect(config.limits.reviewers).toBe(4);
    expect(config.github.columns.done).toBe("Shipped");
    expect(config.github.repo).toBe("o/n");
    expect(config.github.project).toBe(2);
  });

  it("空の screenshots・commands.format は書かない（消す）", () => {
    const withShots = `${SOURCE}screenshots: shots\n`;
    const f = formOf(parseConfig(withShots));
    f.screenshots = "";
    const out = applySettings(withShots, f);
    expect(out).not.toContain("screenshots");
  });

  it("数として読めない値は文字のまま書く（config.ts の決まりで誤りになる）", () => {
    const f = form();
    f.poll_interval = "abc";
    expect(() => parseConfig(applySettings(SOURCE, f))).toThrow();
  });

  it("数字だけの ID は文字として書く", () => {
    const f = form();
    f.chat = {
      enabled: true,
      channels: { requirements: "1", questions: "2", notices: "3" },
      allowed_users: ["4"],
    };
    expect(parseConfig(applySettings(SOURCE, f)).chat).toEqual({
      type: "discord",
      channels: { requirements: "1", questions: "2", notices: "3" },
      allowed_users: ["4"],
    });
  });
});

describe("loadSettings", () => {
  it("指示ファイルは .md だけを、ファイル名の順に、中身をそのまま読む", async () => {
    const dir = await mkdtemp(join(tmpdir(), "conductor-settings-"));
    dirs.push(dir);
    await mkdir(join(dir, ".conductor", "reviewer"), { recursive: true });
    await writeFile(join(dir, ".conductor", "config.yaml"), SOURCE);
    await writeFile(join(dir, ".conductor", "reviewer", "b.md"), "B\n");
    await writeFile(join(dir, ".conductor", "reviewer", "a.md"), "A\n");
    await writeFile(join(dir, ".conductor", "reviewer", "note.txt"), "x");
    const data = await loadSettings(dir, { CONDUCTOR_DISCORD_TOKEN: "  " });
    expect(data.prompts.reviewer).toEqual([
      { name: "a.md", text: "A\n" },
      { name: "b.md", text: "B\n" },
    ]);
    expect(data.prompts.tester).toEqual([]);
    expect(data.token).toBe("unset");
    expect(data.repo).toBe("o/n");
    expect(data.project).toBe(2);
  });
});

describe("saveSettings", () => {
  it("誤りのある値なら git も GitHub も使わずに reject する", async () => {
    const calls: string[][] = [];
    const exec: Exec = (args) => {
      calls.push(args);
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
    const created: unknown[] = [];
    const f = form();
    f.protected = [];
    await expect(
      saveSettings(
        {
          repoDir: "/repo",
          git: new Git("/repo", exec),
          github: {
            createPullRequest: (input) => {
              created.push(input);
              return Promise.resolve({ number: 1, url: "u" });
            },
          },
        },
        f,
      ),
    ).rejects.toBeInstanceOf(SettingsInvalidError);
    expect(calls).toEqual([]);
    expect(created).toEqual([]);
  });
});

describe("settingsBranch・settingsPrBody", () => {
  it("ブランチ名は時刻と印を含む", () => {
    expect(settingsBranch(new Date(2026, 10, 21, 9, 5, 7), "abc123")).toBe(
      "conductor/settings-20261121-090507-abc123",
    );
  });

  it("PR の本文に変更点を書く", () => {
    const body = settingsPrBody([
      { path: "limits.rejections", before: "3", after: "5" },
      { path: "chat", removed: true },
    ]);
    expect(body).toContain("`limits.rejections`: 3 → 5");
    expect(body).toContain("`chat`: （まるごと削除）");
  });
});

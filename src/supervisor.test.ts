import { describe, expect, it } from "vitest";
import type { AdminStatus } from "./admin-server.js";
import { type Config, parseConfig } from "./config.js";
import type { LoopDeps, LoopIssue } from "./loop.js";
import { MemoryStore } from "./store.js";
import { startSupervisor } from "./supervisor.js";

function config(poll: number): Config {
  return parseConfig(
    [
      "github: { repo: o/r, project: 1, notify: someone }",
      "protected: [src/acceptance/**]",
      "commands: { setup: s, test: t, acceptance: a, typecheck: c, build: b }",
      "merge: { approval: human }",
      `poll_interval: ${poll}`,
      "limits: { rejections: 3, objections: 2 }",
    ].join("\n"),
  );
}

/** 何もしない常駐ループの部品。sleep は止められるまで戻らない */
function world() {
  const sleeps: number[] = [];
  const built: Config[] = [];
  let sleeping: (() => void) | undefined;
  const slept = () =>
    new Promise<void>((done) => {
      sleeping = done;
    });
  let nextSleep = slept();
  const buildDeps = (c: Config): Promise<LoopDeps> => {
    built.push(c);
    const step = () => Promise.resolve({ status: "ok" });
    return Promise.resolve({
      config: c,
      store: new MemoryStore(),
      board: {
        issuesByColumn: () => Promise.resolve(new Map<string, LoopIssue[]>()),
        moveIssue: () => Promise.resolve(),
        comment: () => Promise.resolve(),
        hasConflict: () => Promise.resolve(false),
      },
      pickUp: () => Promise.resolve({ accepted: false }),
      test: step,
      implement: step,
      checkCi: step,
      review: step,
      merge: step,
      syncMain: step,
      log: () => {},
      sleep: (ms, signal) => {
        sleeps.push(ms);
        const done = sleeping;
        nextSleep = slept();
        done?.();
        return new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve());
        });
      },
    });
  };
  return { sleeps, built, buildDeps, waitSleep: () => nextSleep };
}

describe("startSupervisor の中断", () => {
  it("処理中でない Issue の中断は reject する", async () => {
    const w = world();
    const first = w.waitSleep();
    const s = startSupervisor({
      repoDir: "unused",
      config: config(30),
      buildDeps: w.buildDeps,
      onStatus: () => {},
      log: () => {},
    });
    await first;
    await expect(s.abort(12)).rejects.toThrow(/処理中ではない/);
    expect(s.status()).toBe("idle");
    await s.shutdown();
  });
});

describe("startSupervisor", () => {
  it("止めると stopping を経て stopped になり、2回目の停止は何もしない", async () => {
    const w = world();
    const statuses: AdminStatus[] = [];
    const first = w.waitSleep();
    const s = startSupervisor({
      repoDir: "unused",
      config: config(30),
      buildDeps: w.buildDeps,
      onStatus: (x) => statuses.push(x),
      log: () => {},
    });
    await first;
    expect(s.status()).toBe("idle");
    await s.stop();
    expect(s.status()).toBe("stopped");
    await s.stop();
    expect(statuses).toEqual(["idle", "stopping", "stopped"]);
    await s.shutdown();
  });

  it("再起動で設定を読み直し、その間隔で動かし直す", async () => {
    const w = world();
    const logs: string[] = [];
    const first = w.waitSleep();
    const s = startSupervisor({
      repoDir: "repo",
      config: config(30),
      buildDeps: w.buildDeps,
      onStatus: () => {},
      log: (t) => logs.push(t),
      loadConfig: (dir) => {
        expect(dir).toBe("repo");
        return Promise.resolve(config(45));
      },
    });
    await first;
    const second = w.waitSleep();
    await s.restart();
    await second;
    expect(w.built.map((c) => c.poll_interval)).toEqual([30, 45]);
    expect(w.sleeps).toEqual([30_000, 45_000]);
    expect(logs).toContain("再起動しました");
    await s.shutdown();
  });

  it("設定を読めなければ停止中のままにして、失敗を返す", async () => {
    const w = world();
    const logs: string[] = [];
    const first = w.waitSleep();
    const s = startSupervisor({
      repoDir: "repo",
      config: config(30),
      buildDeps: w.buildDeps,
      onStatus: () => {},
      log: (t) => logs.push(t),
      loadConfig: () => Promise.reject(new Error("誤り")),
    });
    await first;
    await expect(s.restart()).rejects.toThrow("誤り");
    expect(s.status()).toBe("stopped");
    expect(w.built).toHaveLength(1);
    expect(logs.some((l) => l.includes("誤り"))).toBe(true);
    await s.shutdown();
  });

  it("部品を作れなければ停止中にする", async () => {
    const logs: string[] = [];
    const statuses: AdminStatus[] = [];
    let failed!: () => void;
    const done = new Promise<void>((r) => (failed = r));
    const s = startSupervisor({
      repoDir: "repo",
      config: config(30),
      buildDeps: () => Promise.reject(new Error("トークンがありません")),
      onStatus: (x) => {
        statuses.push(x);
        if (x === "stopped") failed();
      },
      log: (t) => logs.push(t),
    });
    await done;
    expect(s.status()).toBe("stopped");
    expect(logs.some((l) => l.includes("トークンがありません"))).toBe(true);
    await s.shutdown();
  });

  it("再起動で部品を作れなければ、失敗を返して停止中にし、「再起動しました」とは書かない", async () => {
    const w = world();
    const logs: string[] = [];
    const first = w.waitSleep();
    let builds = 0;
    const s = startSupervisor({
      repoDir: "repo",
      config: config(30),
      buildDeps: (c) => {
        builds += 1;
        if (builds === 1) return w.buildDeps(c);
        return Promise.reject(new Error("役の指示ファイルがありません"));
      },
      onStatus: () => {},
      log: (t) => logs.push(t),
      loadConfig: () => Promise.resolve(config(45)),
    });
    await first;
    await expect(s.restart()).rejects.toThrow("役の指示ファイルがありません");
    expect(s.status()).toBe("stopped");
    expect(logs).not.toContain("再起動しました");
    expect(logs.some((l) => l.includes("役の指示ファイルがありません"))).toBe(
      true,
    );
    // 直したあとの再起動・停止はふつうに動く
    await s.stop();
    expect(s.status()).toBe("stopped");
    await s.shutdown();
  });

  it("終えたあとは再起動しない", async () => {
    const w = world();
    const first = w.waitSleep();
    const s = startSupervisor({
      repoDir: "repo",
      config: config(30),
      buildDeps: w.buildDeps,
      onStatus: () => {},
      log: () => {},
      loadConfig: () => Promise.resolve(config(45)),
    });
    await first;
    await s.shutdown();
    await s.restart();
    expect(s.status()).toBe("stopped");
    expect(w.built).toHaveLength(1);
  });
});

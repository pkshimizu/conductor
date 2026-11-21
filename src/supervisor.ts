/**
 * 常駐ループ（runLoop）の停止と再起動を受け持つ。
 * 止めるときは Ctrl+C と同じく runLoop の signal で止める（今の段階を終えてから止まる）。
 * 再起動のたびに .conductor/config.yaml を読み直し、その設定で部品を作り直して動かし直す。
 */
import type { AdminStatus } from "./admin-server.js";
import { type Config, loadConfig } from "./config.js";
import { type LoopDeps, runLoop } from "./loop.js";

export interface SupervisorOptions {
  /** 対象リポジトリ（再起動のたびに .conductor/config.yaml を読み直す） */
  repoDir: string;
  /** 起動したときの設定（main が読んだもの） */
  config: Config;
  /** 設定から常駐ループの部品を作る（再起動のたびに、読み直した設定で呼ぶ） */
  buildDeps(config: Config): Promise<LoopDeps>;
  /** 稼働状態が変わるたびに呼ぶ */
  onStatus(status: AdminStatus): void;
  log(text: string): void;
  /** 設定を読む（テストで差し替える）。省略したら loadConfig */
  loadConfig?: (repoDir: string) => Promise<Config>;
}

export interface Supervisor {
  status(): AdminStatus;
  /** 今の段階を終えてから止める（Ctrl+C と同じ。runLoop の signal で止める）。止まったら resolve */
  stop(): Promise<void>;
  /** 動作中なら今の段階を終えてから止め、config.yaml を読み直して常駐ループを動かし直す。動かし直したら resolve */
  restart(): Promise<void>;
  /** すべて終える（Ctrl+C のとき start.ts が呼ぶ）。今の段階を終えてから止まったら resolve */
  shutdown(): Promise<void>;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 動いている常駐ループ1回分 */
interface Run {
  controller: AbortController;
  done: Promise<void>;
}

/** すぐに常駐ループを動かし始める */
export function startSupervisor(options: SupervisorOptions): Supervisor {
  const load = options.loadConfig ?? loadConfig;
  let status: AdminStatus = "running";
  let current: Run | undefined;
  let closed = false;
  // 停止・再起動・終了は1つずつ順に行う
  let queue: Promise<void> = Promise.resolve();

  const setStatus = (next: AdminStatus) => {
    if (next === status) return;
    status = next;
    options.onStatus(next);
  };

  const run = (config: Config): void => {
    const controller = new AbortController();
    const { signal } = controller;
    const self: Run = { controller, done: Promise.resolve() };
    current = self;
    self.done = (async () => {
      try {
        const deps = await options.buildDeps(config);
        if (signal.aborted) return;
        await runLoop(
          {
            ...deps,
            onStatus: (s) => {
              if (!signal.aborted) setStatus(s);
            },
          },
          signal,
          { intervalMs: config.poll_interval * 1000 },
        );
      } catch (e) {
        options.log(`常駐ループが止まりました: ${errorMessage(e)}`);
      }
      // 頼まれずに止まった（部品を作れなかったなど）
      if (!signal.aborted && current === self) {
        current = undefined;
        setStatus("stopped");
      }
    })();
  };

  /** 動いていれば今の段階を終えてから止める */
  const halt = async (): Promise<void> => {
    const running = current;
    if (running === undefined) return;
    setStatus("stopping");
    running.controller.abort();
    await running.done;
    if (current === running) current = undefined;
  };

  const enqueue = (op: () => Promise<void>): Promise<void> => {
    const next = queue.then(op);
    queue = next.catch(() => {});
    return next;
  };

  run(options.config);

  return {
    status: () => status,
    stop: () =>
      enqueue(async () => {
        await halt();
        setStatus("stopped");
      }),
    restart: () =>
      enqueue(async () => {
        if (closed) return;
        await halt();
        let config: Config;
        try {
          config = await load(options.repoDir);
        } catch (e) {
          setStatus("stopped");
          options.log(
            `設定を読めないため再起動できませんでした: ${errorMessage(e)}`,
          );
          throw e;
        }
        setStatus("running");
        run(config);
        options.log("再起動しました");
      }),
    shutdown: () =>
      enqueue(async () => {
        closed = true;
        await halt();
        setStatus("stopped");
      }),
  };
}

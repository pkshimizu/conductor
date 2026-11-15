import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStore } from "./sqlite-store.js";
import { type Clock, MemoryStore, type Store } from "./store.js";

const KEY = { repo: "pkshimizu/wordcards", issue: 2 };

function fixedClock(): Clock & { advance: (ms: number) => void } {
  let t = Date.parse("2026-11-15T00:00:00Z");
  const clock = () => new Date(t);
  clock.advance = (ms: number) => {
    t += ms;
  };
  return clock;
}

// AC1・AC3：同じ決まりを両方の実装で確かめる
describe.each([
  ["SqliteStore", (c: Clock) => new SqliteStore(":memory:", c)],
  ["MemoryStore", (c: Clock) => new MemoryStore(c)],
])("%s", (_name, make) => {
  let store: Store;
  let clock: ReturnType<typeof fixedClock>;
  beforeEach(() => {
    clock = fixedClock();
    store = make(clock);
  });
  afterEach(async () => {
    await store.close();
  });

  it("記録の無い Issue は undefined", async () => {
    expect(await store.get(KEY)).toBeUndefined();
  });

  it("AC1: 回数・ブランチ・PR・中断点・ハッシュを保存して取得できる", async () => {
    await store.update(KEY, {
      rejections: 2,
      objections: 1,
      branch: "conductor/2",
      pr: 7,
      checkpoint: {
        stage: "implementing",
        reason: "利用上限",
        resumeAt: "2026-11-15T05:00:00.000Z",
      },
      protectedHash: "sha256:abc",
    });
    expect(await store.get(KEY)).toEqual({
      ...KEY,
      rejections: 2,
      objections: 1,
      branch: "conductor/2",
      pr: 7,
      checkpoint: {
        stage: "implementing",
        reason: "利用上限",
        resumeAt: "2026-11-15T05:00:00.000Z",
      },
      protectedHash: "sha256:abc",
      updatedAt: "2026-11-15T00:00:00.000Z",
    });
  });

  it("update は指定した項目だけ変え、undefined の項目は消す", async () => {
    await store.update(KEY, {
      branch: "b",
      pr: 1,
      checkpoint: { stage: "ci" },
    });
    clock.advance(1000);
    const r = await store.update(KEY, { rejections: 1, checkpoint: undefined });
    expect(r).toEqual({
      ...KEY,
      rejections: 1,
      objections: 0,
      branch: "b",
      pr: 1,
      updatedAt: "2026-11-15T00:00:01.000Z",
    });
    expect(await store.get(KEY)).toEqual(r);
  });

  it("取り出した記録を書き換えても保存内容は変わらない", async () => {
    await store.update(KEY, { checkpoint: { stage: "testing" } });
    const r = await store.get(KEY);
    r!.checkpoint!.stage = "merging";
    expect((await store.get(KEY))!.checkpoint!.stage).toBe("testing");
  });

  it("AC1: 各役の要約を順に保存して取得できる", async () => {
    await store.addSummary(KEY, {
      role: "tester",
      verdict: "approve",
      text: "AC1〜AC6 のテストを書いた",
    });
    clock.advance(60_000);
    await store.addSummary(KEY, {
      role: "implementer",
      verdict: "approve",
      text: "追加画面を作った",
    });
    expect(await store.summaries(KEY)).toEqual([
      {
        role: "tester",
        verdict: "approve",
        text: "AC1〜AC6 のテストを書いた",
        at: "2026-11-15T00:00:00.000Z",
      },
      {
        role: "implementer",
        verdict: "approve",
        text: "追加画面を作った",
        at: "2026-11-15T00:01:00.000Z",
      },
    ]);
    expect(await store.summaries({ ...KEY, issue: 3 })).toEqual([]);
  });

  it("list はリポジトリごとの記録を Issue 番号順に返す", async () => {
    await store.update({ ...KEY, issue: 4 }, {});
    await store.update({ ...KEY, issue: 3 }, {});
    await store.update({ repo: "other/repo", issue: 1 }, {});
    expect((await store.list(KEY.repo)).map((r) => r.issue)).toEqual([3, 4]);
  });
});

describe("SqliteStore の再起動", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "conductor-store-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("AC2: 閉じて開き直しても同じ内容が読める", async () => {
    const file = join(dir, "nested", "conductor.sqlite");
    const first = new SqliteStore(file);
    const saved = await first.update(KEY, {
      rejections: 3,
      checkpoint: { stage: "reviewing" },
      protectedHash: "h",
    });
    await first.addSummary(KEY, {
      role: "reviewer",
      verdict: "reject",
      text: "x",
    });
    await first.close();

    const second = new SqliteStore(file);
    expect(await second.get(KEY)).toEqual(saved);
    expect(await second.summaries(KEY)).toHaveLength(1);
    await second.close();
  });
});

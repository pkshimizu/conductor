import { describe, expect, it } from "vitest";
import {
  askAbort,
  askControl,
  CONTROL_PATHS,
  type ControlState,
  cancelControl,
  confirmControl,
  dismissToast,
} from "./control.js";

describe("askControl・cancelControl", () => {
  it("押したボタンのダイアログを出し、キャンセルで閉じるだけにする", () => {
    const asked = askControl({}, "restart");
    expect(asked).toEqual({ dialog: "restart" });
    expect(cancelControl(asked)).toEqual({});
    expect(cancelControl({ dialog: "stop", toast: "restart" })).toEqual({
      toast: "restart",
    });
  });
});

describe("dismissToast", () => {
  it("知らせだけを消す", () => {
    expect(dismissToast({ toast: "stop" })).toEqual({});
    expect(dismissToast({ dialog: "stop", toast: "stop" })).toEqual({
      dialog: "stop",
    });
  });
});

describe("confirmControl", () => {
  it("ダイアログを閉じてから頼み、ok なら知らせを出す", async () => {
    const updates: ControlState[] = [];
    const posts: string[] = [];
    const final = await confirmControl(
      { dialog: "stop", toast: "restart" },
      (path) => {
        posts.push(path);
        return Promise.resolve({ ok: true });
      },
      (s) => updates.push(s),
    );
    expect(posts).toEqual([CONTROL_PATHS.stop]);
    expect(updates).toEqual([{}, { toast: "stop" }]);
    expect(final).toEqual({ toast: "stop" });
  });

  it("失敗したら成功の知らせを出さず、失敗したことを返す", async () => {
    const updates: ControlState[] = [];
    const ng = await confirmControl(
      { dialog: "restart" },
      () => Promise.resolve({ ok: false }),
      (s) => updates.push(s),
    );
    expect(ng).toEqual({ failed: "restart" });
    const thrown = await confirmControl(
      { dialog: "stop" },
      () => Promise.reject(new Error("つながらない")),
      (s) => updates.push(s),
    );
    expect(thrown).toEqual({ failed: "stop" });
    expect(updates).toEqual([
      {},
      { failed: "restart" },
      {},
      { failed: "stop" },
    ]);
  });

  it("ダイアログが無ければ何もしない", async () => {
    const posts: string[] = [];
    const final = await confirmControl(
      { toast: "stop" },
      (path) => {
        posts.push(path);
        return Promise.resolve({ ok: true });
      },
      () => {},
    );
    expect(final).toEqual({ toast: "stop" });
    expect(posts).toEqual([]);
  });
});

describe("askAbort", () => {
  it("中断のダイアログを Issue と役つきで出し、確認で /api/abort/<番号> に頼む", async () => {
    const asked = askAbort({}, 12, "implementer");
    expect(asked).toEqual({
      dialog: "abort",
      abort: { issue: 12, role: "implementer" },
    });
    expect(cancelControl(asked)).toEqual({});
    const posts: string[] = [];
    const final = await confirmControl(
      asked,
      (path) => {
        posts.push(path);
        return Promise.resolve({ ok: true });
      },
      () => {},
    );
    expect(posts).toEqual(["/api/abort/12"]);
    expect(final).toEqual({
      toast: "abort",
      abort: { issue: 12, role: "implementer" },
    });
    expect(dismissToast(final)).toEqual({});
  });

  it("役がわからなくても出せる。失敗したら failed にする", async () => {
    const asked = askAbort({}, 7);
    expect(asked).toEqual({ dialog: "abort", abort: { issue: 7 } });
    const ng = await confirmControl(
      asked,
      () => Promise.resolve({ ok: false }),
      () => {},
    );
    expect(ng).toEqual({ failed: "abort", abort: { issue: 7 } });
  });
});

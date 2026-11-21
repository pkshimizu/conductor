import { describe, expect, it } from "vitest";
import {
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

  it("失敗したら知らせを出さない", async () => {
    const updates: ControlState[] = [];
    const ng = await confirmControl(
      { dialog: "restart" },
      () => Promise.resolve({ ok: false }),
      (s) => updates.push(s),
    );
    expect(ng).toEqual({});
    const thrown = await confirmControl(
      { dialog: "restart" },
      () => Promise.reject(new Error("つながらない")),
      (s) => updates.push(s),
    );
    expect(thrown).toEqual({});
    expect(updates).toEqual([{}, {}]);
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

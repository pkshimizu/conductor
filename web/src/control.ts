/**
 * ヘッダーの「再起動」「停止」と、処理中の Issue の「この作業を中断」の流れ（確認のダイアログと知らせ）。
 * ブラウザの globals（window・fetch など）には触らない（画面が post を渡す）
 */
import type { RoleKey } from "./i18n.js";

export type ControlKind = "restart" | "stop" | "abort";

/** 中断のダイアログに出す Issue と、動いている役 */
export interface AbortTarget {
  issue: number;
  role?: RoleKey;
}

export interface ControlState {
  /** 出している確認のダイアログ */
  dialog?: ControlKind;
  /** 出している知らせ（再起動しました・停止しました・中断しました） */
  toast?: ControlKind;
  /** 頼んだのに失敗した操作（POST が届かない・ok でない）。画面での知らせはまだ出さない */
  failed?: ControlKind;
  /** 中断のダイアログ（と、その知らせ）に出す Issue と役 */
  abort?: AbortTarget;
}

/** 頼む先（src/admin-server.ts の POST /api/restart・/api/stop・/api/abort/<番号>） */
export const CONTROL_PATHS: Readonly<Record<ControlKind, string>> = {
  restart: "/api/restart",
  stop: "/api/stop",
  abort: "/api/abort",
};

/** 知らせを出しておく時間 */
export const TOAST_MS = 2600;

/** ヘッダーの「再起動」「停止」を押した。そのダイアログを出す */
export function askControl(
  state: ControlState,
  kind: ControlKind,
): ControlState {
  return { ...state, dialog: kind };
}

/** 処理中の Issue の「この作業を中断」を押した。中断のダイアログを出す */
export function askAbort(
  state: ControlState,
  issue: number,
  role?: RoleKey,
): ControlState {
  return {
    ...state,
    dialog: "abort",
    abort: role === undefined ? { issue } : { issue, role },
  };
}

/** 知らせに要るものだけを残す */
function keepToast(state: ControlState): ControlState {
  const next: ControlState = {};
  if (state.toast !== undefined) {
    next.toast = state.toast;
    if (state.toast === "abort" && state.abort !== undefined) {
      next.abort = state.abort;
    }
  }
  return next;
}

/** ダイアログの「キャンセル」。ダイアログを閉じるだけ */
export function cancelControl(state: ControlState): ControlState {
  return keepToast(state);
}

/** 知らせを消す */
export function dismissToast(state: ControlState): ControlState {
  const next: ControlState = {};
  if (state.dialog !== undefined) {
    next.dialog = state.dialog;
    if (state.dialog === "abort" && state.abort !== undefined) {
      next.abort = state.abort;
    }
  }
  return next;
}

/** 確認のボタンで頼む先。中断は /api/abort/<番号> */
export function controlPath(state: ControlState): string | undefined {
  const kind = state.dialog;
  if (kind === undefined) return undefined;
  if (kind !== "abort") return CONTROL_PATHS[kind];
  if (state.abort === undefined) return undefined;
  return `${CONTROL_PATHS.abort}/${state.abort.issue}`;
}

/**
 * ダイアログの確認のボタン（再起動する・停止する・中断する）。ダイアログを閉じて update を呼び、
 * post(頼む先) で頼み、ok なら toast: kind、失敗なら failed: kind にして update を呼ぶ。
 * 最後の状態を返す。
 * 画面は post に (path) => fetch(path, { method: "POST" }) を渡す
 */
export async function confirmControl(
  state: ControlState,
  post: (path: string) => Promise<{ ok: boolean }>,
  update: (state: ControlState) => void,
): Promise<ControlState> {
  const kind = state.dialog;
  const path = controlPath(state);
  if (kind === undefined) return state;
  const target = kind === "abort" ? state.abort : undefined;
  const withTarget = (next: ControlState): ControlState =>
    target === undefined ? next : { ...next, abort: target };
  const closed: ControlState = {};
  update(closed);
  let ok: boolean;
  if (path === undefined) {
    ok = false;
  } else {
    try {
      ok = (await post(path)).ok;
    } catch {
      ok = false;
    }
  }
  if (!ok) {
    const failed = withTarget({ failed: kind });
    update(failed);
    return failed;
  }
  const done = withTarget({ toast: kind });
  update(done);
  return done;
}

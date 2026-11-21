/**
 * ヘッダーの「再起動」「停止」の流れ（確認のダイアログと知らせ）。
 * ブラウザの globals（window・fetch など）には触らない（画面が post を渡す）
 */

export type ControlKind = "restart" | "stop";

export interface ControlState {
  /** 出している確認のダイアログ */
  dialog?: ControlKind;
  /** 出している知らせ（再起動しました・停止しました） */
  toast?: ControlKind;
}

/** 頼む先（src/admin-server.ts の POST /api/restart・/api/stop） */
export const CONTROL_PATHS: Readonly<Record<ControlKind, string>> = {
  restart: "/api/restart",
  stop: "/api/stop",
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

/** ダイアログの「キャンセル」。ダイアログを閉じるだけ */
export function cancelControl(state: ControlState): ControlState {
  const next: ControlState = {};
  if (state.toast !== undefined) next.toast = state.toast;
  return next;
}

/** 知らせを消す */
export function dismissToast(state: ControlState): ControlState {
  const next: ControlState = {};
  if (state.dialog !== undefined) next.dialog = state.dialog;
  return next;
}

/**
 * ダイアログの確認のボタン（再起動する・停止する）。ダイアログを閉じて update を呼び、
 * post(CONTROL_PATHS[kind]) で頼み、ok なら toast: kind にして update を呼ぶ。最後の状態を返す。
 * 画面は post に (path) => fetch(path, { method: "POST" }) を渡す
 */
export async function confirmControl(
  state: ControlState,
  post: (path: string) => Promise<{ ok: boolean }>,
  update: (state: ControlState) => void,
): Promise<ControlState> {
  const kind = state.dialog;
  if (kind === undefined) return state;
  const closed: ControlState = {};
  update(closed);
  let ok: boolean;
  try {
    ok = (await post(CONTROL_PATHS[kind])).ok;
  } catch {
    ok = false;
  }
  if (!ok) return closed;
  const done: ControlState = { toast: kind };
  update(done);
  return done;
}

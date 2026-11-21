/**
 * 設定の画面の状態（入力中の値・タブ・差分の確認ダイアログ・保存して作った PR）。
 * ブラウザの globals（window・fetch など）には触らない（画面が post を渡す）
 */
import type { Role } from "../../src/config-schema.js";
import type { SettingsData, SettingsForm } from "../../src/settings-data.js";
import {
  diffSettings,
  type SettingsTab,
  validateSettings,
} from "../../src/settings-rules.js";

export type { SettingsTab } from "../../src/settings-rules.js";

export interface SettingsState {
  /** 入力中の値 */
  form: SettingsForm;
  /** 出しているタブ */
  tab: SettingsTab;
  /** 差分の確認ダイアログ */
  dialog?: "diff";
  /** 保存して作った PR */
  saved?: { number: number; url: string };
  /** 保存を頼んだのに失敗した */
  failed?: true;
  /** 指示ファイルのタブで出している役とファイル（省略時は最初の役・最初のファイル） */
  prompt?: { role: Role; file?: string };
  /** リストの追加欄に入力中の文字（"protected"・"roles.<役>.allow"・"chat.allowed_users" ごと） */
  drafts?: Readonly<Record<string, string>>;
}

/** 頼む先（src/admin-server.ts の GET・POST /api/settings） */
export const SETTINGS_PATH = "/api/settings";

/** form は data.form、tab は "general" */
export function initSettings(data: SettingsData): SettingsState {
  return { form: structuredClone(data.form), tab: "general" };
}

/** ダイアログと失敗の知らせを除いた状態 */
function settled(state: SettingsState): SettingsState {
  const next: SettingsState = { form: state.form, tab: state.tab };
  if (state.saved !== undefined) next.saved = state.saved;
  if (state.prompt !== undefined) next.prompt = state.prompt;
  if (state.drafts !== undefined) next.drafts = state.drafts;
  return next;
}

/** 入力中の値に変更があるか */
export function hasChanges(state: SettingsState, data: SettingsData): boolean {
  return diffSettings(data.form, state.form).length > 0;
}

/** 入力中の値に誤りがあるか */
export function hasErrors(state: SettingsState): boolean {
  return Object.keys(validateSettings(state.form)).length > 0;
}

/** 「変更を取り消す」。form を data.form に戻す */
export function discardSettings(
  state: SettingsState,
  data: SettingsData,
): SettingsState {
  const next = settled(state);
  next.form = structuredClone(data.form);
  delete next.drafts;
  return next;
}

/** 「差分を確認して保存」。誤りが無く変更があるときだけ dialog: "diff" */
export function reviewSettings(
  state: SettingsState,
  data: SettingsData,
): SettingsState {
  if (hasErrors(state) || !hasChanges(state, data)) return state;
  return { ...settled(state), dialog: "diff" };
}

/** ダイアログの「キャンセル」。閉じるだけ */
export function cancelSettings(state: SettingsState): SettingsState {
  return settled(state);
}

/** タブを選ぶ */
export function selectTab(
  state: SettingsState,
  tab: SettingsTab,
): SettingsState {
  return { ...state, tab };
}

/** 入力中の値を変える（edit は複製した form を書き換える） */
export function editForm(
  state: SettingsState,
  edit: (form: SettingsForm) => void,
): SettingsState {
  const form = structuredClone(state.form);
  edit(form);
  return { ...state, form };
}

/** リストの追加欄の文字を変える */
export function setDraft(
  state: SettingsState,
  key: string,
  text: string,
): SettingsState {
  return { ...state, drafts: { ...state.drafts, [key]: text } };
}

/**
 * リストの追加欄の文字を list に足し、追加欄を空にする。
 * 空白だけ・すでにある値なら足さない
 */
export function addDraft(
  state: SettingsState,
  key: string,
  list: (form: SettingsForm) => string[],
): SettingsState {
  const text = (state.drafts?.[key] ?? "").trim();
  const cleared = setDraft(state, key, "");
  if (text === "" || list(state.form).includes(text)) return cleared;
  return editForm(cleared, (f) => list(f).push(text));
}

/** list から value を除く */
export function removeItem(
  state: SettingsState,
  list: (form: SettingsForm) => string[],
  value: string,
): SettingsState {
  return editForm(state, (f) => {
    const items = list(f);
    const i = items.indexOf(value);
    if (i >= 0) items.splice(i, 1);
  });
}

function savedOf(value: unknown): { number: number; url: string } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const number: unknown = "number" in value ? value.number : undefined;
  const url: unknown = "url" in value ? value.url : undefined;
  if (typeof number !== "number" || typeof url !== "string") return undefined;
  return { number, url };
}

/**
 * ダイアログの「保存して PR を作成」。ダイアログを閉じて update を呼び、post(SETTINGS_PATH, state.form) で頼み、
 * ok なら返った JSON の { number, url } を saved に入れて update を呼ぶ。最後の状態を返す。
 * 画面は post に (p, form) => fetch(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ form }) }) を渡す
 */
export async function confirmSettings(
  state: SettingsState,
  post: (
    path: string,
    form: SettingsForm,
  ) => Promise<{ ok: boolean; json(): Promise<unknown> }>,
  update: (state: SettingsState) => void,
): Promise<SettingsState> {
  const closed = settled(state);
  delete closed.saved;
  update(closed);
  let saved: { number: number; url: string } | undefined;
  try {
    const res = await post(SETTINGS_PATH, state.form);
    if (res.ok) saved = savedOf(await res.json());
  } catch {
    saved = undefined;
  }
  const next: SettingsState =
    saved === undefined ? { ...closed, failed: true } : { ...closed, saved };
  update(next);
  return next;
}

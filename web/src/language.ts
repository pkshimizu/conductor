/** 画面の言語を覚える（画面は localStorage を渡す） */
import type { Lang } from "./i18n.js";

const KEY = "conductor.language";

/** 覚えている言語。無いか、知らない値なら日本語 */
export function loadLanguage(storage: Pick<Storage, "getItem">): Lang {
  return storage.getItem(KEY) === "en" ? "en" : "ja";
}

export function saveLanguage(
  storage: Pick<Storage, "setItem">,
  lang: Lang,
): void {
  storage.setItem(KEY, lang);
}

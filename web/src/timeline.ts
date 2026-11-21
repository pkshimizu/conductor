/** タスク詳細の経過の並べ方と、長い要約の畳み方（デザインの Main.dc.html と同じ決め方） */

/** 長い要約の文字数（これより長ければ畳む） */
export const LONG_CHARS = 180;
/** 長い要約の行数（これより多ければ畳む） */
export const LONG_LINES = 4;

/** 畳むほど長い要約か（180 文字より長いか、5 行以上） */
export function isLongSummary(text: string): boolean {
  return text.split("\n").length > LONG_LINES || text.length > LONG_CHARS;
}

/** 畳んだときに出す、途中までの文（4 行・180 文字まで。続きがあれば「…」を付ける） */
export function foldSummary(text: string): string {
  const head = text.split("\n").slice(0, LONG_LINES).join("\n");
  const cut = head.length > LONG_CHARS ? head.slice(0, LONG_CHARS) : head;
  return cut.length < text.length ? `${cut.trimEnd()}…` : cut;
}

export type TimelineOrder = "newest" | "oldest";

/** 経過を並び順に並べる。index は記録した順の番号（0 がいちばん古い） */
export function orderTimeline<T>(
  entries: readonly T[],
  order: TimelineOrder,
): { entry: T; index: number }[] {
  const list = entries.map((entry, index) => ({ entry, index }));
  return order === "newest" ? list.reverse() : list;
}

/** 開いている番号の一覧で、index を開いたり閉じたりする */
export function toggleExpanded(
  expanded: readonly number[],
  index: number,
): number[] {
  return expanded.includes(index)
    ? expanded.filter((i) => i !== index)
    : [...expanded, index];
}

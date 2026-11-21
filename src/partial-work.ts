/** 中断したときに、それまでの変更をブランチに残せたか */
export type PartialWork =
  /** コミットして Issue のブランチに push した */
  | { kind: "pushed" }
  /** 残す変更が無かった */
  | { kind: "nothing" }
  /** 変えてはいけないファイルが変わっていたので残さなかった */
  | { kind: "discarded" }
  /** 残そうとして失敗した */
  | { kind: "failed"; reason: string };

/**
 * 中断で終わったことと、それまでの変更をどうしたかを伝えるエラー。
 * name は "AbortError"（isAbortError で中断と見なせる）
 */
export class PartialWorkAbortError extends Error {
  override readonly name = "AbortError";
  constructor(
    readonly work: PartialWork,
    options?: { cause?: unknown },
  ) {
    super("中断しました", options);
  }
}

/** 中断のエラーに付いた、変更の残し方。付いていなければ undefined */
export function partialWorkOf(e: unknown): PartialWork | undefined {
  return e instanceof PartialWorkAbortError ? e.work : undefined;
}

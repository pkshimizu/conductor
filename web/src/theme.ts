/** PC の配色（ライト・ダーク）に従う */
export type Scheme = "light" | "dark";

type Listener = (event: { matches: boolean }) => void;

/** window.matchMedia が返すもののうち、使う部分 */
export interface MediaQueryListLike {
  readonly matches: boolean;
  addEventListener(type: "change", listener: Listener): void;
  removeEventListener(type: "change", listener: Listener): void;
}

export const DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * 今の配色を返し、PC の配色が変わったら onChange を呼ぶ。
 * 画面は window.matchMedia を渡す。stop で見るのをやめる
 */
export function watchColorScheme(
  matchMedia: (query: string) => MediaQueryListLike,
  onChange: (scheme: Scheme) => void,
): { scheme: Scheme; stop(): void } {
  const query = matchMedia(DARK_QUERY);
  const listener: Listener = (event) => {
    onChange(event.matches ? "dark" : "light");
  };
  query.addEventListener("change", listener);
  return {
    scheme: query.matches ? "dark" : "light",
    stop: () => query.removeEventListener("change", listener),
  };
}

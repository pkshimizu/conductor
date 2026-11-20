import { describe, expect, it } from "vitest";
import { type MediaQueryListLike, watchColorScheme } from "./theme.js";

type Listener = (event: { matches: boolean }) => void;

describe("watchColorScheme", () => {
  it("stop のあとは PC の配色が変わっても知らせない", () => {
    const listeners = new Set<Listener>();
    const query: MediaQueryListLike = {
      matches: false,
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
    };
    const changes: string[] = [];
    const onChange = (scheme: string) => changes.push(scheme);
    const watch = watchColorScheme(() => query, onChange);
    expect(watch.scheme).toBe("light");
    for (const listener of listeners) listener({ matches: true });
    watch.stop();
    expect(listeners.size).toBe(0);
    expect(changes).toEqual(["dark"]);
  });
});

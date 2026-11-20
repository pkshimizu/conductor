import { describe, expect, it } from "vitest";
import { loadLanguage, saveLanguage } from "./language.js";

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
  };
}

describe("loadLanguage", () => {
  it("覚えた言語を返す", () => {
    const storage = memoryStorage();
    saveLanguage(storage, "en");
    expect(loadLanguage(storage)).toBe("en");
    saveLanguage(storage, "ja");
    expect(loadLanguage(storage)).toBe("ja");
  });

  it("知らない値なら日本語にする", () => {
    const storage = memoryStorage();
    storage.setItem("conductor.language", "fr");
    expect(loadLanguage(storage)).toBe("ja");
  });
});

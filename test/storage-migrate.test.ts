/** The rename to Trov keeps each browser's preferences: canopy.* keys move to trov.* once. */
import { describe, it, expect } from "vitest";
import { migrateLegacyKeys, type KeyStore } from "../web/src/storage-migrate";

function store(init: Record<string, string>): KeyStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(init));
  return {
    data,
    get length() { return data.size; },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, v); },
    removeItem: (k) => { data.delete(k); },
  };
}

describe("migrateLegacyKeys", () => {
  it("moves every canopy.* key to trov.* and removes the old one", () => {
    const s = store({ "canopy.theme": "dark", "canopy.navOpen": "{\"docs\":true}", "other": "x" });
    expect(migrateLegacyKeys(s).sort()).toEqual(["trov.navOpen", "trov.theme"]);
    expect(Object.fromEntries(s.data)).toEqual({ "trov.theme": "dark", "trov.navOpen": "{\"docs\":true}", other: "x" });
  });

  it("never overwrites a value already saved under the new name, and is a no-op the second time", () => {
    const s = store({ "canopy.theme": "dark", "trov.theme": "light" });
    expect(migrateLegacyKeys(s)).toEqual([]);
    expect(Object.fromEntries(s.data)).toEqual({ "trov.theme": "light" });
    expect(migrateLegacyKeys(s)).toEqual([]);
  });

  it("survives a store that throws or is absent", () => {
    const broken: KeyStore = { get length(): number { throw new Error("blocked"); }, key: () => null, getItem: () => null, setItem: () => {}, removeItem: () => {} };
    expect(migrateLegacyKeys(broken)).toEqual([]);
    expect(migrateLegacyKeys(null)).toEqual([]);
  });
});

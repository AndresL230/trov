// The rename to Trov moved every per-browser preference from `canopy.<key>` to `trov.<key>` (theme, feed
// view, prompt view, rail state, open nav groups; the sign-in return-to in sessionStorage). Run ONCE at boot,
// before anything reads them, so nobody loses a setting: each old key is copied to its new name when the new
// one is not set yet, then removed. Never throws — storage can be absent or blocked.

export const LEGACY_PREFIX = "canopy.";
export const PREFIX = "trov.";

export interface KeyStore {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Copy every `canopy.*` key to `trov.*` (unless already set) and drop the old one. Returns the keys moved. */
export function migrateLegacyKeys(store: KeyStore | null | undefined): string[] {
  if (!store) return [];
  const moved: string[] = [];
  try {
    const old: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k && k.startsWith(LEGACY_PREFIX)) old.push(k);
    }
    for (const k of old) {
      const next = PREFIX + k.slice(LEGACY_PREFIX.length);
      const v = store.getItem(k);
      if (v !== null && store.getItem(next) === null) { store.setItem(next, v); moved.push(next); }
      store.removeItem(k);
    }
  } catch { /* storage unavailable or full: the preference is lost, nothing else */ }
  return moved;
}

/** Both browser stores, guarded (a sandboxed frame or a privacy mode can throw on access). */
export function migrateBrowserStorage(): void {
  for (const get of [() => localStorage, () => sessionStorage]) {
    try { migrateLegacyKeys(get()); } catch { /* ignore */ }
  }
}

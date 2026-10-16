// A small least-recently-used cache, for pure functions the app reruns on every paint with the
// same input (markdown.ts's renderers). A hit moves its entry to the
// newest end; past `max` entries the oldest is dropped. Values are handed out as they are stored,
// so cache only what nobody mutates: strings, or frozen objects.

export interface Lru<V> {
  get(key: string): V | undefined;
  set(key: string, value: V): void;
  readonly size: number;
  clear(): void;
}

export function createLru<V>(max: number): Lru<V> {
  const map = new Map<string, V>();
  return {
    get(key) {
      const v = map.get(key);
      if (v === undefined) return undefined;
      map.delete(key);
      map.set(key, v);
      return v;
    },
    set(key, value) {
      map.delete(key);
      map.set(key, value);
      if (map.size > max) map.delete(map.keys().next().value as string);
    },
    get size() { return map.size; },
    clear() { map.clear(); },
  };
}

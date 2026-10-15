// Counts what a piece of code costs in D1 ROUND TRIPS: every `first` / `all` / `run` / `raw` of a prepared
// statement and every `batch` is one trip. Each trip is held for the same `delayMs` before it runs, so trips
// that wait on each other resolve in their order, and `serial` is the longest chain of trips that each had to
// wait for an earlier one (a trip's depth is one more than the deepest trip that had RESOLVED when it was
// sent) — the number that sets a request's latency when every trip pays the distance to the database.
// `total` is every trip, chained or not. Test-only: production code never sees this wrapper.
import { env } from "cloudflare:test";
import type { Env } from "../../src/env";

export interface TripCounter { env: Env; total: number; serial: number; reset(): void }

export function countingEnv(base: Env = env as unknown as Env, delayMs = 4): TripCounter {
  const db = base.DB;
  const real = new WeakMap<object, D1PreparedStatement>();
  let resolvedDepth = 0;
  const counter: TripCounter = {
    env: undefined as unknown as Env, total: 0, serial: 0,
    reset() { counter.total = 0; counter.serial = 0; resolvedDepth = 0; },
  };
  const trip = async <T>(go: () => Promise<T>): Promise<T> => {
    const depth = resolvedDepth + 1;
    counter.total += 1;
    await new Promise((r) => setTimeout(r, delayMs));
    try {
      return await go();
    } finally {
      resolvedDepth = Math.max(resolvedDepth, depth);
      counter.serial = Math.max(counter.serial, depth);
    }
  };
  const wrap = (s: D1PreparedStatement): D1PreparedStatement => {
    const w = new Proxy(s, {
      get(target, prop) {
        if (prop === "bind") return (...args: unknown[]) => wrap(target.bind(...args));
        if (prop === "first" || prop === "all" || prop === "run" || prop === "raw") {
          return (...args: unknown[]) => trip(() => (target[prop] as (...a: unknown[]) => Promise<unknown>).apply(target, args));
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    real.set(w, s);
    return w;
  };
  const counted = new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") return (q: string) => wrap(target.prepare(q));
      if (prop === "batch") return (stmts: D1PreparedStatement[]) => trip(() => target.batch(stmts.map((s) => real.get(s) ?? s)));
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  counter.env = { ...base, DB: counted } as Env;
  return counter;
}

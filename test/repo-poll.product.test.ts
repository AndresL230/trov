/**
 * Product metrics (contract v2) — the POLL side.
 *
 * Sapling's metrics endpoint grows from three active-user numbers to a generic
 * set: `counts` (windowed `{24h,7d,30d}` integers) and `totals` (point-in-time
 * integers). `saplingProductMetrics` is the pure, per-key validator of
 * docs/superpowers/specs/2026-09-21-sapling-product-metrics.md §3;
 * `pollSaplingMetrics` stores what survives as hourly gauges —
 * `sap_c_<key>_<window>` / `sap_t_<key>` — in ONE batch per environment
 * (`putMetrics`), beside the unchanged whole-or-nothing `active_users_*`.
 * The fetch is stubbed at the Response level; every assertion is on D1 rows.
 */
import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import { all } from "./helpers/db";
import { pollSaplingMetrics, saplingProductMetrics } from "../src/repo/poll";
import { putMetrics, pruneRepoCapture, putMetric } from "../src/repo/store";
import { ENVS, LONG_TOKEN, leakedFragments } from "./helpers/repo";

import { platformCtx, systemCtx } from "./helpers/tenant";
const NOW = Date.parse("2026-09-20T12:05:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const AT = "2026-09-20T12:00:00.000Z";
const STAGING_URL = "https://api.staging.saplinglearn.com/api/internal/metrics";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const w = (a: unknown, b: unknown, c: unknown) => ({ "24h": a, "7d": b, "30d": c });
const USERS = { active_users: w(6, 9, 9) };
const stored = (like = "sap_%") => all<{ metric: string; env: string; part: string; value: number; at: string }>(env.DB,
  `SELECT metric, env, part, value, at FROM repo_metrics WHERE metric LIKE ? ORDER BY env, metric, at`, like);
const stagingAnswers = (respond: () => Response) => (async (u: RequestInfo | URL) =>
  String(u) === STAGING_URL ? respond() : new Response("nope", { status: 404 })) as typeof fetch;
const run = async (fn: () => ReturnType<typeof pollSaplingMetrics>) => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try { return { out: await fn(), logged: spy.mock.calls.slice() }; } finally { spy.mockRestore(); }
};

// ── the validator (pure) ─────────────────────────────────────────────────────
describe("saplingProductMetrics — spec §3, per key", () => {
  const plain = (r: ReturnType<typeof saplingProductMetrics>) => ({
    counts: { ...r.counts }, totals: { ...r.totals }, dropped: r.dropped, droppedCount: r.droppedCount,
  });

  it("keeps valid counts and totals", () => {
    expect(plain(saplingProductMetrics({ ...USERS, counts: { signups: w(3, 21, 96), llm_cost_cents: w(412, 2961, 11830) }, totals: { users: 1204, users_pending: 7 } }))).toEqual({
      counts: { signups: { h24: 3, d7: 21, d30: 96 }, llm_cost_cents: { h24: 412, d7: 2961, d30: 11830 } },
      totals: { users: 1204, users_pending: 7 },
      dropped: [], droppedCount: 0,
    });
  });

  it("a v1 body — no counts, no totals — is simply empty, nothing dropped", () => {
    expect(plain(saplingProductMetrics(USERS))).toEqual({ counts: {}, totals: {}, dropped: [], droppedCount: 0 });
    expect(plain(saplingProductMetrics({ counts: {}, totals: {} }))).toEqual({ counts: {}, totals: {}, dropped: [], droppedCount: 0 });
  });

  it.each([["a scalar", 7], ["null", null], ["a string", "x"], ["an array", [1]], ["undefined", undefined]])("a body that is %s → empty, never a throw", (_n, body) => {
    expect(plain(saplingProductMetrics(body))).toEqual({ counts: {}, totals: {}, dropped: [], droppedCount: 0 });
  });

  it.each([["null", null], ["an array", [w(1, 2, 3)]], ["a number", 3], ["a string", "signups"], ["a boolean", true]])("a section that is %s is ignored whole — and named", (_n, section) => {
    const r = saplingProductMetrics({ counts: section, totals: section });
    expect(plain(r)).toEqual({ counts: {}, totals: {}, dropped: ["counts.*", "totals.*"], droppedCount: 2 });
  });

  it("the key caps: 48 counts / 24 totals pass, one more ignores THAT section only", () => {
    const counts = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`c${i}`, w(1, 2, 3)]));
    const totals = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`t${i}`, i]));
    const atCap = saplingProductMetrics({ counts: counts(48), totals: totals(24) });
    expect(Object.keys(atCap.counts)).toHaveLength(48);
    expect(Object.keys(atCap.totals)).toHaveLength(24);
    expect(atCap.dropped).toEqual([]);
    const over = saplingProductMetrics({ counts: counts(49), totals: totals(24) });
    expect(Object.keys(over.counts)).toHaveLength(0);
    expect(Object.keys(over.totals)).toHaveLength(24);
    expect(over.dropped).toEqual(["counts.*"]);
    expect(over.droppedCount).toBe(49); // every key the ignored section held, not "1"
    const overTotals = saplingProductMetrics({ counts: counts(2), totals: totals(25) });
    expect(Object.keys(overTotals.counts)).toHaveLength(2);
    expect(Object.keys(overTotals.totals)).toHaveLength(0);
    expect(overTotals.dropped).toEqual(["totals.*"]);
    expect(overTotals.droppedCount).toBe(25);
  });

  it("an ignored section counts EVERY key it held — 60 counts read as 60 dropped, named once", () => {
    const counts = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`c${i}`, w(1, 2, 3)]));
    const r = saplingProductMetrics({ counts, totals: { Bad: 1, fine: 2 } });
    expect(r.dropped).toEqual(["counts.*", "totals.Bad"]);
    expect(r.droppedCount).toBe(61);
    // a section that is not an object held no keys to count: it is one refusal
    expect(saplingProductMetrics({ counts: "nope" }).droppedCount).toBe(1);
    expect(saplingProductMetrics({ counts: [w(1, 2, 3), w(1, 2, 3)] }).droppedCount).toBe(1);
  });

  it("`clean` runs on a rejected name BEFORE it is cut to 40 characters — and defaults to identity", () => {
    const secret = "S".repeat(64);
    const redact = (s: string) => s.split(secret).join("[redacted]");
    expect(saplingProductMetrics({ totals: { [secret]: 1 } }).dropped).toEqual([`totals.${"S".repeat(40)}`]);
    expect(saplingProductMetrics({ totals: { [secret]: 1 }, counts: { [`key_${secret}`]: w(1, 2, 3) } }, redact).dropped)
      .toEqual(["counts.key_[redacted]", "totals.[redacted]"]);
  });

  const BAD_KEYS = ["Signups", "9lives", "_private", "sign-ups", "sign ups", "", "a".repeat(41), "é", "signups.total", "__proto__", "constructor".toUpperCase()];
  it.each(BAD_KEYS)("the key %j is dropped — and never costs the key beside it", (key) => {
    const counts = JSON.parse(`{${JSON.stringify(key)}:{"24h":1,"7d":2,"30d":3},"ok_key":{"24h":1,"7d":2,"30d":3}}`);
    const totals = JSON.parse(`{${JSON.stringify(key)}:5,"ok_key":5}`);
    const r = saplingProductMetrics({ counts, totals });
    expect(plain(r).counts).toEqual({ ok_key: { h24: 1, d7: 2, d30: 3 } });
    expect(plain(r).totals).toEqual({ ok_key: 5 });
    expect(r.droppedCount).toBe(2);
  });

  it("accepts the longest and the shortest key", () => {
    const long = `a${"0".repeat(39)}`;
    const r = saplingProductMetrics({ totals: { a: 1, [long]: 2 } });
    expect(plain(r).totals).toEqual({ a: 1, [long]: 2 });
  });

  it("prototype-named keys cannot poison the result: valid ones are plain own entries, `__proto__` is dropped", () => {
    // JSON.parse makes `__proto__` an OWN key; an object literal would set the prototype instead.
    const body = JSON.parse(`{"counts":{"__proto__":{"24h":1,"7d":2,"30d":3},"constructor":{"24h":1,"7d":2,"30d":3},"tostring":{"24h":4,"7d":5,"30d":6}},"totals":{"__proto__":9,"constructor":3,"hasownproperty":4,"valueof":5}}`);
    const r = saplingProductMetrics(body);
    expect(Object.keys(r.counts).sort()).toEqual(["constructor", "tostring"]);
    expect(Object.keys(r.totals).sort()).toEqual(["constructor", "hasownproperty", "valueof"]);
    expect(r.totals.constructor).toBe(3);
    expect(r.dropped).toEqual(["counts.__proto__", "totals.__proto__"]);
    expect(({} as Record<string, unknown>).h24).toBeUndefined(); // Object.prototype untouched
    expect(Object.getPrototypeOf(r.counts)).toBeNull();
    expect(Object.getPrototypeOf(r.totals)).toBeNull();
  });

  it("a prototype-inherited window is not a window", () => {
    const entry = Object.create({ "24h": 1, "7d": 2, "30d": 3 }) as Record<string, unknown>;
    expect(plain(saplingProductMetrics({ counts: { inherited: entry } })).counts).toEqual({});
  });

  const BAD_VALUES: [string, unknown][] = [
    ["a boolean", true], ["false", false], ["a float", 1.5], ["a numeric string", "3"], ["null", null], ["a negative", -1],
    ["past the ceiling", 1_000_000_000_001], ["an exponent far past it", 1e21], ["an object", { n: 1 }], ["an array", [1]],
  ];
  it.each(BAD_VALUES)("a total that is %s is dropped", (_n, v) => {
    const r = saplingProductMetrics({ totals: { bad: v, good: 1 } });
    expect(plain(r).totals).toEqual({ good: 1 });
    expect(r.dropped).toEqual(["totals.bad"]);
  });
  it.each(BAD_VALUES)("a count with a window that is %s is dropped whole", (_n, v) => {
    for (const entry of [w(v, 2, 3), w(1, v, 3), w(1, 2, v)]) {
      const r = saplingProductMetrics({ counts: { bad: entry, good: w(1, 2, 3) } });
      expect(plain(r).counts).toEqual({ good: { h24: 1, d7: 2, d30: 3 } });
      expect(r.dropped).toEqual(["counts.bad"]);
    }
  });

  it("the boundaries: 0, equal windows and exactly 1e12 pass", () => {
    const r = saplingProductMetrics({ counts: { zeros: w(0, 0, 0), equal: w(5, 5, 5), top: w(1e12, 1e12, 1e12) }, totals: { zero: 0, top: 1_000_000_000_000 } });
    expect(plain(r)).toMatchObject({
      counts: { zeros: { h24: 0, d7: 0, d30: 0 }, equal: { h24: 5, d7: 5, d30: 5 }, top: { h24: 1e12, d7: 1e12, d30: 1e12 } },
      totals: { zero: 0, top: 1e12 }, dropped: [],
    });
  });

  it.each([
    ["a missing window", { "24h": 1, "7d": 2 }], ["an extra window", { "24h": 1, "7d": 2, "30d": 3, "90d": 4 }],
    ["a bare number", 3], ["null", null], ["an array", [1, 2, 3]], ["24h above 7d", w(3, 2, 5)], ["7d above 30d", w(1, 6, 5)],
  ])("a count that is %s is dropped", (_n, entry) => {
    const r = saplingProductMetrics({ counts: { bad: entry, good: w(1, 2, 3) } });
    expect(Object.keys(r.counts)).toEqual(["good"]);
    expect(r.dropped).toEqual(["counts.bad"]);
  });

  it("names at most 20 dropped keys, counts them all, and never quotes a hostile name at length", () => {
    const totals = Object.fromEntries(Array.from({ length: 23 }, (_, i) => [`BAD${i}`, 1]));
    const r = saplingProductMetrics({ totals: { ...totals, ["X".repeat(5_000)]: 1 } });
    expect(r.droppedCount).toBe(24);
    expect(r.dropped).toHaveLength(20);
    expect(r.dropped[0]).toBe("totals.BAD0");
    const hostile = saplingProductMetrics({ totals: { [`<img src=x onerror=1>\n${"y".repeat(500)}`]: 1 } });
    expect(hostile.dropped[0].length).toBeLessThanOrEqual("totals.".length + 40);
    expect(hostile.dropped[0]).not.toContain("\n");
  });
});

// ── putMetrics (the batch seam) ──────────────────────────────────────────────
describe("putMetrics", () => {
  it("writes many rows in batches of at most 50 statements and counts only NEW rows", async () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({ metric: `sap_t_k${i}`, env: "staging", part: "", value: i, at: "2026-09-20T12:00:00Z" }));
    const spy = vi.spyOn(env.DB, "batch");
    try {
      expect(await putMetrics(systemCtx(), rows)).toBe(120);
      expect(spy.mock.calls.map((c) => c[0].length)).toEqual([50, 50, 20]);
      expect(await putMetrics(systemCtx(), [...rows, { metric: "sap_t_new", env: "staging", part: "", value: 1, at: AT }])).toBe(1);
    } finally { spy.mockRestore(); }
    const back = await stored();
    expect(back).toHaveLength(121);
    expect(new Set(back.map((r) => r.at))).toEqual(new Set([AT])); // normalised exactly as putMetric does
  });

  it("skips an unparseable `at`, writes the rest, and an empty list touches nothing", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await putMetrics(systemCtx(), [])).toBe(0);
      expect(await putMetrics(systemCtx(), [
        { metric: "sap_t_a", env: "staging", part: "", value: 1, at: "not a date" },
        { metric: "sap_t_b", env: "staging", part: "", value: 2, at: "2026-09-20T14:00:00+02:00" },
      ])).toBe(1);
    } finally { spy.mockRestore(); }
    expect(await stored()).toEqual([{ metric: "sap_t_b", env: "staging", part: "", value: 2, at: AT }]);
  });
});

// ── the poller ───────────────────────────────────────────────────────────────
describe("pollSaplingMetrics — product metrics", () => {
  const V2 = { ...USERS, counts: { signups: w(3, 21, 96), llm_cost_cents: w(412, 2961, 11830) }, totals: { users: 1204, users_pending: 7 } };

  it("a v1 body is still ok, and stores the three active-user rows only", async () => {
    const { out } = await run(() => pollSaplingMetrics(systemCtx(), "s3cret", [ENVS[0]], NOW, stagingAnswers(() => json(USERS))));
    expect(out).toEqual([{ env: "staging", status: "ok", written: 3 }]);
    expect(await stored()).toEqual([]);
    expect(await stored("active_users_%")).toHaveLength(3);
  });

  it("a v2 body stores exactly the expected rows at the hour floor", async () => {
    const { out, logged } = await run(() => pollSaplingMetrics(systemCtx(), "s3cret", [ENVS[0]], NOW, stagingAnswers(() => json(V2))));
    expect(out).toEqual([{ env: "staging", status: "ok", written: 11 }]);
    expect(logged).toEqual([]);
    const row = (metric: string, value: number) => ({ metric, env: "staging", part: "", value, at: AT });
    expect(await stored()).toEqual([
      row("sap_c_llm_cost_cents_24h", 412), row("sap_c_llm_cost_cents_30d", 11830), row("sap_c_llm_cost_cents_7d", 2961),
      row("sap_c_signups_24h", 3), row("sap_c_signups_30d", 96), row("sap_c_signups_7d", 21),
      row("sap_t_users", 1204), row("sap_t_users_pending", 7),
    ]);
    expect((await stored("active_users_%")).map((r) => r.value)).toEqual([6, 9, 9]);
  });

  it("a repeat poll inside the hour writes 0 new rows; the next hour is its own reading", async () => {
    const fetchImpl = stagingAnswers(() => json(V2));
    await run(() => pollSaplingMetrics(systemCtx(), "s3cret", [ENVS[0]], NOW, fetchImpl));
    const again = await run(() => pollSaplingMetrics(systemCtx(), "s3cret", [ENVS[0]], NOW + 20 * 60_000, stagingAnswers(() => json({ ...V2, totals: { users: 9999 } }))));
    expect(again.out).toEqual([{ env: "staging", status: "ok", written: 0 }]);
    expect((await stored("sap_t_users")).map((r) => r.value)).toEqual([1204]); // first write of the hour wins
    const next = await run(() => pollSaplingMetrics(systemCtx(), "s3cret", [ENVS[0]], NOW + HOUR, fetchImpl));
    expect(next.out).toEqual([{ env: "staging", status: "ok", written: 11 }]);
  });

  it("dropped keys are reported BY NAME — in the outcome and once in the log — and never cost the valid ones", async () => {
    const body = { ...USERS, counts: { signups: w(3, 21, 96), foo: w(9, 2, 3) }, totals: { users: 1204, bar: "12", Baz: 1 } };
    const { out, logged } = await run(() => pollSaplingMetrics(systemCtx(), "s3cret", [ENVS[0]], NOW, stagingAnswers(() => json(body))));
    expect(out).toEqual([{ env: "staging", status: "ok", written: 7, detail: "3 keys dropped: counts.foo, totals.bar, totals.Baz" }]);
    expect(logged).toEqual([["pollSaplingMetrics", "staging", "3 keys dropped: counts.foo, totals.bar, totals.Baz"]]);
    expect((await stored()).map((r) => r.metric)).toEqual(["sap_c_signups_24h", "sap_c_signups_30d", "sap_c_signups_7d", "sap_t_users"]);
    expect(JSON.stringify(logged)).not.toContain("12"); // names only, never a value
  });

  it("one dropped key reads in the singular; more than 20 are counted, not all named", async () => {
    const one = await run(() => pollSaplingMetrics(systemCtx(), "s3cret", [ENVS[0]], NOW, stagingAnswers(() => json({ ...USERS, totals: { Bad: 1 } }))));
    expect(one.out[0].detail).toBe("1 key dropped: totals.Bad");
    const many = Object.fromEntries(Array.from({ length: 22 }, (_, i) => [`B${i}`, 1]));
    const lots = await run(() => pollSaplingMetrics(systemCtx(), "s3cret", [ENVS[0]], NOW + HOUR, stagingAnswers(() => json({ ...USERS, totals: many }))));
    expect(lots.out[0].detail).toMatch(/^22 keys dropped: totals\.B0, /);
    expect(lots.out[0].detail!.length).toBeLessThanOrEqual(200);
  });

  it("active_users refused but counts/totals valid → the product rows ARE stored, and the environment still reads failed", async () => {
    const body = { active_users: w(10, 9, 12), counts: { signups: w(3, 21, 96) }, totals: { users: 1204 } };
    const { out, logged } = await run(() => pollSaplingMetrics(systemCtx(), "s3cret", [ENVS[0]], NOW, stagingAnswers(() => json(body))));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ env: "staging", status: "failed", written: 4 });
    expect(out[0].detail).toContain("the windows do not nest");
    expect(out[0].detail).toBe(logged[0][2]);
    expect(await stored("active_users_%")).toEqual([]);
    expect((await stored()).map((r) => [r.metric, r.value])).toEqual([
      ["sap_c_signups_24h", 3], ["sap_c_signups_30d", 96], ["sap_c_signups_7d", 21], ["sap_t_users", 1204],
    ]);
  });

  it("a body at both caps is ONE putMetrics call per environment — batches of ≤50, 171 rows", async () => {
    const counts = Object.fromEntries(Array.from({ length: 48 }, (_, i) => [`c${i}`, w(1, 2, 3)]));
    const totals = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`t${i}`, i]));
    const batch = vi.spyOn(env.DB, "batch");
    try {
      const { out } = await run(() => pollSaplingMetrics(systemCtx(), "s3cret", [ENVS[0]], NOW, stagingAnswers(() => json({ ...USERS, counts, totals }))));
      expect(out).toEqual([{ env: "staging", status: "ok", written: 171 }]);
      expect(batch.mock.calls.map((c) => c[0].length)).toEqual([50, 50, 50, 21]);
    } finally { batch.mockRestore(); }
    expect(await stored()).toHaveLength(168);
  });

  it("a non-200, a redirect and a non-JSON body still write nothing at all", async () => {
    for (const res of [() => new Response("no", { status: 500 }), () => new Response(null, { status: 302, headers: { location: "https://x.example" } }), () => new Response("<html>", { status: 200 })]) {
      await run(() => pollSaplingMetrics(systemCtx(), "s3cret", [ENVS[0]], NOW, stagingAnswers(res)));
    }
    expect(await stored("%")).toEqual([]);
  });

  it("an over-cap section reports how many keys were ignored, not 1", async () => {
    const counts = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`c${i}`, w(1, 2, 3)]));
    const { out } = await run(() => pollSaplingMetrics(systemCtx(), "s3cret", [ENVS[0]], NOW, stagingAnswers(() => json({ ...USERS, counts, totals: { users: 5 } }))));
    expect(out).toEqual([{ env: "staging", status: "ok", written: 4, detail: "60 keys dropped: counts.*" }]);
  });

  it("active_users refused AND product keys dropped → the failed outcome's detail carries both", async () => {
    const body = { active_users: w(10, 9, 12), counts: { signups: w(3, 21, 96), foo: w(9, 2, 3) }, totals: { users: 1204, Baz: 1 } };
    const { out, logged } = await run(() => pollSaplingMetrics(systemCtx(), LONG_TOKEN, [ENVS[0]], NOW, stagingAnswers(() => json(body))));
    expect(out[0]).toMatchObject({ env: "staging", status: "failed", written: 4 });
    expect(out[0].detail).toMatch(/^the windows do not nest \(24h ≤ 7d ≤ 30d\) · 2 keys dropped: counts\.foo, totals\.Baz: /);
    expect(out[0].detail!.length).toBeLessThanOrEqual(200);
    expect(logged).toEqual([["pollSaplingMetrics", "staging", out[0].detail]]); // ONE line: the refusal carries the note
  });

  it("the refusal + dropped note stays inside the detail cap, and is scrubbed, even with 20 long hostile names", async () => {
    const totals = Object.fromEntries(Array.from({ length: 22 }, (_, i) => [`${LONG_TOKEN}-${i}`, 1]));
    const { out, logged } = await run(() => pollSaplingMetrics(systemCtx(), LONG_TOKEN, [ENVS[0]], NOW, stagingAnswers(() => json({ active_users: null, totals }))));
    expect(out[0].status).toBe("failed");
    expect(out[0].detail).toMatch(/^no active_users object · 22 keys dropped: totals\.\[redacted\]-0, /);
    expect(out[0].detail!.length).toBeLessThanOrEqual(200);
    expect(leakedFragments(JSON.stringify([out, logged]), LONG_TOKEN)).toEqual([]);
  });

  // The token is 64 characters — what `openssl rand -hex 32` makes. A rejected
  // name is cut to 40, so a scrub that ran AFTER the cut could never match it.
  it.each([
    ["a totals key", (t: string) => ({ ...USERS, totals: { [t]: 1 } })],
    ["a counts key", (t: string) => ({ ...USERS, counts: { [t]: w(1, 2, 3) } })],
    ["a totals key behind `Bearer `", (t: string) => ({ ...USERS, totals: { [`Bearer ${t}`]: 1 } })],
    ["a counts key with the token straddling the 40-character cut", (t: string) => ({ ...USERS, counts: { [`${"x".repeat(30)}${t}`]: w(1, 2, 3) } })],
    ["both sections, with active_users refused as well", (t: string) => ({ active_users: null, counts: { [t]: w(1, 2, 3) }, totals: { [t]: 1 } })],
  ])("never lets ANY 8-character piece of a 64-character token out — echoed as %s", async (_n, body) => {
    expect(LONG_TOKEN).toHaveLength(64);
    const { out, logged } = await run(() => pollSaplingMetrics(systemCtx(), LONG_TOKEN, [ENVS[0]], NOW, stagingAnswers(() => json(body(LONG_TOKEN)))));
    expect(logged.length).toBeGreaterThan(0);
    expect(JSON.stringify(out)).toContain("[redacted]");
    expect(leakedFragments(JSON.stringify(out), LONG_TOKEN)).toEqual([]);
    expect(leakedFragments(JSON.stringify(logged), LONG_TOKEN)).toEqual([]);
  });
});

// ── retention ────────────────────────────────────────────────────────────────
describe("pruneRepoCapture — sap_* rows", () => {
  it("hourly rows go after 7 days; the 00:00 UTC rows stay 100 days; active_users keeps its own rule", async () => {
    const now = Date.parse("2026-09-20T12:00:00Z");
    const put = (metric: string, at: string, value = 1) => putMetric(systemCtx(), { metric, env: "staging", part: "", value, at });
    const iso = (ms: number) => new Date(ms).toISOString();
    // hourly, around the 7-day boundary (the cutoff itself is kept: `at < cutoff` is deleted)
    await put("sap_c_signups_24h", iso(now - 7 * DAY - HOUR), 1);   // gone
    await put("sap_c_signups_24h", iso(now - 7 * DAY), 2);          // kept — exactly 7 days
    await put("sap_t_users", iso(now - 7 * DAY - HOUR), 3);         // gone
    await put("sap_t_users", iso(now - 2 * DAY), 4);                // kept
    // midnight rows, around the 100-day boundary
    await put("sap_c_signups_24h", "2026-09-01T00:00:00Z", 5);      // 19 days old, midnight → kept
    await put("sap_c_signups_7d", "2026-06-13T00:00:00Z", 6);       // 99.5 days → kept
    await put("sap_c_signups_7d", "2026-06-12T00:00:00Z", 7);       // 100.5 days → gone
    await put("sap_t_users", "2026-09-01T00:30:00Z", 8);            // not exactly midnight → gone
    // the older rules neither catch sap_* nor are caught by it
    await put("active_users_24h", iso(now - 8 * DAY), 9);           // kept (100-day rule)
    await put("active_users_24h", iso(now - 101 * DAY), 10);        // gone
    await put("sapling", iso(now - 300 * DAY), 11);                 // not a sap_ metric → kept forever
    await put("xsap_t_users", iso(now - 300 * DAY), 12);            // kept forever
    await pruneRepoCapture(platformCtx(), now);
    const kept = await all<{ value: number }>(env.DB, `SELECT value FROM repo_metrics ORDER BY value`);
    expect(kept.map((r) => r.value)).toEqual([2, 4, 5, 6, 9, 11, 12]);
  });

  // SQLite turns `metric GLOB 'sap_*'` into an index RANGE only when the pattern
  // is a literal in the statement; a bound `GLOB ?` is a scan of the whole table.
  it("the prune's GLOB patterns are literals in the SQL, never bound parameters", async () => {
    const prepare = vi.spyOn(env.DB, "prepare");
    try {
      await pruneRepoCapture(platformCtx(), Date.parse("2026-09-20T12:00:00Z"));
      const sql = prepare.mock.calls.map((c) => String(c[0]));
      expect(sql.some((q) => q.includes("metric GLOB 'sap_*'"))).toBe(true);
      expect(sql.some((q) => q.includes("metric GLOB 'cf_*' OR metric GLOB 'rw_*' OR metric GLOB 'active_users_*'"))).toBe(true);
      expect(sql.filter((q) => /GLOB\s*\?/.test(q))).toEqual([]);
    } finally { prepare.mockRestore(); }
  });
});

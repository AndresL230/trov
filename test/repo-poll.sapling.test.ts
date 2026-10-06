/**
 * Task 18 — active users, from Sapling's own metrics endpoint (source M).
 *
 * Trov cannot compute active users; only Sapling's database knows. The repo
 * cron's minute-0 tick asks each environment's backend
 * (`GET {apiUrl}/api/internal/metrics`, a bearer token) and `pollSaplingMetrics`
 * stores the three windows as hourly GAUGES — `active_users_24h` / `_7d` /
 * `_30d`, `env` = the config key, `part` = "". The whole response is validated
 * or NOTHING is written; the token goes to one https URL and never follows a
 * redirect. `getRepoDashboard` shows the latest reading of a range only while
 * it is current (≤ 3 hours old), and its trend is the readings themselves —
 * never zero-filled, never summed.
 * The fetch is stubbed at the Response level; every assertion is on D1 rows or
 * on the projection built from them.
 */
import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import { all } from "../src/db";
import { pollSaplingMetrics } from "../src/repo/poll";
import { putMetric } from "../src/repo/store";
import { getRepoDashboard } from "../src/tools/repo";
import { ENVS, LONG_TOKEN, leakedFragments } from "./helpers/repo";

import { systemCtx } from "./helpers/tenant";
const NOW = Date.parse("2026-09-20T12:05:00Z");
const HOUR = 3_600_000;
const AT = "2026-09-20T12:00:00.000Z";
const STAGING_URL = "https://api.staging.saplinglearn.com/api/internal/metrics";
const PRODUCTION_URL = "https://api.saplinglearn.com/api/internal/metrics";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const users = (a: unknown, b: unknown, c: unknown) => ({ active_users: { "24h": a, "7d": b, "30d": c } });
const stored = () => all<{ metric: string; env: string; part: string; value: number; at: string }>(env.DB,
  `SELECT metric, env, part, value, at FROM repo_metrics WHERE metric LIKE 'active_users_%' ORDER BY env, metric, at`);
/** Staging answers `body`; production is a plain 404 (the endpoint not built there). */
const stagingAnswers = (respond: () => Response) => (async (u: RequestInfo | URL) =>
  String(u) === STAGING_URL ? respond() : new Response("nope", { status: 404 })) as typeof fetch;
const quietly = async (fn: () => Promise<unknown>) => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try { await fn(); return spy.mock.calls.slice(); } finally { spy.mockRestore(); }
};

describe("pollSaplingMetrics", () => {
  it("stores the three windows per environment at the hour, with the bearer token", async () => {
    const seen: { url: string; auth: string | null; agent: string | null; redirect?: string; method?: string }[] = [];
    const fetchImpl = (async (u: RequestInfo | URL, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      seen.push({ url: String(u), auth: h.get("authorization"), agent: h.get("user-agent"), redirect: init?.redirect, method: init?.method });
      return String(u).startsWith("https://api.staging")
        ? json(users(6, 9, 9))
        : new Response("nope", { status: 404 });
    }) as typeof fetch;
    await quietly(() => pollSaplingMetrics(systemCtx(), "s3cret", ENVS, NOW, fetchImpl));
    expect(await stored()).toEqual([
      { metric: "active_users_24h", env: "staging", part: "", value: 6, at: AT },
      { metric: "active_users_30d", env: "staging", part: "", value: 9, at: AT },
      { metric: "active_users_7d", env: "staging", part: "", value: 9, at: AT },
    ]);
    // ONE request per environment, to ONE place, and a redirect is never followed.
    expect(seen).toEqual([
      { url: STAGING_URL, auth: "Bearer s3cret", agent: "canopy-metrics", redirect: "manual", method: "GET" },
      { url: PRODUCTION_URL, auth: "Bearer s3cret", agent: "canopy-metrics", redirect: "manual", method: "GET" },
    ]);
  });

  it("joins the path without a double slash when apiUrl ends in one", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (u: RequestInfo | URL) => { calls.push(String(u)); return json(users(1, 2, 3)); }) as typeof fetch;
    await pollSaplingMetrics(systemCtx(), "s3cret", [{ ...ENVS[0], apiUrl: "https://api.staging.saplinglearn.com//" }], NOW, fetchImpl);
    expect(calls).toEqual([STAGING_URL]);
    expect(await stored()).toHaveLength(3);
  });

  it("a 302 writes nothing — the token is never carried to wherever it points", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (u: RequestInfo | URL) => {
      calls.push(String(u));
      return new Response(null, { status: 302, headers: { location: "https://elsewhere.example/api/internal/metrics" } });
    }) as typeof fetch;
    await quietly(() => pollSaplingMetrics(systemCtx(), "s3cret", ENVS, NOW, fetchImpl));
    expect(calls).toEqual([STAGING_URL, PRODUCTION_URL]); // one each, and nothing to elsewhere.example
    expect(await stored()).toEqual([]);
  });

  it("an http:// apiUrl is never fetched — a bearer token is not sent in clear — and the other environment still polls", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (u: RequestInfo | URL) => { calls.push(String(u)); return json(users(1, 2, 3)); }) as typeof fetch;
    const envs = [{ ...ENVS[0], apiUrl: "http://api.staging.saplinglearn.com" }, ENVS[1]];
    const logged = await quietly(() => pollSaplingMetrics(systemCtx(), "s3cret", envs, NOW, fetchImpl));
    expect(calls).toEqual([PRODUCTION_URL]);
    expect((await stored()).map((r) => r.env)).toEqual(["production", "production", "production"]);
    expect(JSON.stringify(logged)).toContain("staging");
  });

  it("an apiUrl that is not a URL at all is skipped without throwing", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (u: RequestInfo | URL) => { calls.push(String(u)); return json(users(1, 2, 3)); }) as typeof fetch;
    await expect(quietly(() => pollSaplingMetrics(systemCtx(), "s3cret", [{ ...ENVS[0], apiUrl: "" }, { ...ENVS[1], apiUrl: "not a url" }], NOW, fetchImpl))).resolves.toBeDefined();
    expect(calls).toEqual([]);
    expect(await stored()).toEqual([]);
  });

  it.each([401, 403, 404, 500, 503, 201, 204])("HTTP %i writes nothing — only a 200 is an answer", async (status) => {
    const body = status === 204 ? null : JSON.stringify(users(6, 9, 9));
    await quietly(() => pollSaplingMetrics(systemCtx(), "s3cret", ENVS, NOW, (async () => new Response(body, { status })) as typeof fetch));
    expect(await stored()).toEqual([]);
  });

  it("a thrown fetch writes nothing and does not throw", async () => {
    const fetchImpl = (async () => { throw new Error("connect timeout"); }) as typeof fetch;
    await expect(quietly(() => pollSaplingMetrics(systemCtx(), "s3cret", ENVS, NOW, fetchImpl))).resolves.toBeDefined();
    expect(await stored()).toEqual([]);
  });

  // The whole response or nothing: numbers that contradict each other, or a
  // window that is not a count, are not evidence for the OTHER windows either.
  describe("validation — one bad window costs that environment the whole tick", () => {
    const REJECTED: [string, unknown][] = [
      ["a string", users("6", 9, 9)],
      ["a float", users(6.5, 9, 9)],
      ["a negative", users(6, -1, 9)],
      ["null", users(6, 9, null)],
      ["a missing window", { active_users: { "24h": 6, "7d": 9 } }],
      ["a boolean", users(true, 9, 9)],
      ["over the ceiling", users(6, 9, 10_000_001)],
      ["an exponent past the integer range", users(6, 9, 1e21)],
      ["24h above 7d", users(10, 9, 12)],
      ["7d above 30d", users(6, 13, 12)],
      ["no active_users object", { users: { "24h": 6, "7d": 9, "30d": 9 } }],
      ["active_users as an array", { active_users: [6, 9, 9] }],
      ["active_users as null", { active_users: null }],
      ["a JSON scalar", 7],
      ["JSON null", null],
    ];
    it.each(REJECTED)("%s → zero rows", async (_name, body) => {
      const logged = await quietly(() => pollSaplingMetrics(systemCtx(), "s3cret", ENVS, NOW, stagingAnswers(() => json(body))));
      expect(await stored()).toEqual([]);
      expect(JSON.stringify(logged)).toContain("staging"); // says WHICH environment
    });

    it("NaN / a body that is not JSON → zero rows", async () => {
      for (const text of ['{"active_users":{"24h":NaN,"7d":9,"30d":9}}', "<html>502 Bad Gateway</html>", ""]) {
        await quietly(() => pollSaplingMetrics(systemCtx(), "s3cret", ENVS, NOW, stagingAnswers(() => new Response(text, { status: 200 }))));
      }
      expect(await stored()).toEqual([]);
    });

    it("never logs more than ~80 characters of a body it rejected", async () => {
      const long = "x".repeat(5_000);
      const logged = await quietly(() => pollSaplingMetrics(systemCtx(), "s3cret", ENVS, NOW, stagingAnswers(() => new Response(long, { status: 200 }))));
      expect(JSON.stringify(logged)).not.toContain("x".repeat(81));
    });

    it("a bad environment never costs the good one beside it", async () => {
      const fetchImpl = (async (u: RequestInfo | URL) => json(String(u) === STAGING_URL ? users(10, 9, 12) : users(74, 318, 318))) as typeof fetch;
      await quietly(() => pollSaplingMetrics(systemCtx(), "s3cret", ENVS, NOW, fetchImpl));
      expect((await stored()).map((r) => [r.env, r.metric, r.value])).toEqual([
        ["production", "active_users_24h", 74], ["production", "active_users_30d", 318], ["production", "active_users_7d", 318],
      ]);
    });

    it("accepts the edges: zeros, equal windows, and exactly the ceiling", async () => {
      const fetchImpl = (async (u: RequestInfo | URL) => json(String(u) === STAGING_URL ? users(0, 0, 0) : users(10_000_000, 10_000_000, 10_000_000))) as typeof fetch;
      await pollSaplingMetrics(systemCtx(), "s3cret", ENVS, NOW, fetchImpl);
      expect((await stored()).map((r) => r.value)).toEqual([10_000_000, 10_000_000, 10_000_000, 0, 0, 0]);
    });
  });

  it("keeps the FIRST reading of an hour: a second poll inside it writes nothing new", async () => {
    await quietly(() => pollSaplingMetrics(systemCtx(), "s3cret", ENVS, NOW, stagingAnswers(() => json(users(6, 9, 9)))));
    await quietly(() => pollSaplingMetrics(systemCtx(), "s3cret", ENVS, NOW + 20 * 60_000, stagingAnswers(() => json(users(7, 10, 10)))));
    expect((await stored()).map((r) => r.value)).toEqual([6, 9, 9]);
    // The next hour is its own point.
    await quietly(() => pollSaplingMetrics(systemCtx(), "s3cret", ENVS, NOW + HOUR, stagingAnswers(() => json(users(7, 10, 10)))));
    expect(await stored()).toHaveLength(6);
  });

  it("never logs the token — or any 8-character piece of it — whatever fails", async () => {
    // 64 characters, as `openssl rand -hex 32` makes it: longer than every cut
    // this poller makes (40 / 80 / 200), so a cut-before-scrub cannot hide.
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      // The worst cases: the failure quotes the request back; the body echoes the header —
      // at the start, and straddling the 80-character excerpt cut and the 200-character message cut.
      await pollSaplingMetrics(systemCtx(), LONG_TOKEN, ENVS, NOW, (async (_u: RequestInfo | URL, init?: RequestInit) => {
        throw new Error(`request failed: ${JSON.stringify(init?.headers)}`);
      }) as typeof fetch);
      await pollSaplingMetrics(systemCtx(), LONG_TOKEN, ENVS, NOW, (async (_u: RequestInfo | URL, init?: RequestInit) => {
        throw new Error(`${"p".repeat(170)}${JSON.stringify(init?.headers)}`);
      }) as typeof fetch);
      await pollSaplingMetrics(systemCtx(), LONG_TOKEN, ENVS, NOW, (async () => new Response(`bad token: Bearer ${LONG_TOKEN}`, { status: 200 })) as typeof fetch);
      await pollSaplingMetrics(systemCtx(), LONG_TOKEN, ENVS, NOW, (async () => new Response(`${"p".repeat(50)}${LONG_TOKEN}`, { status: 200 })) as typeof fetch);
      await pollSaplingMetrics(systemCtx(), LONG_TOKEN, ENVS, NOW, (async () => new Response(`{"active_users":null,"echo":"${"p".repeat(30)}${LONG_TOKEN}"}`, { status: 200 })) as typeof fetch);
      await pollSaplingMetrics(systemCtx(), LONG_TOKEN, ENVS, NOW, (async () => new Response("no", { status: 401 })) as typeof fetch);
      expect(spy).toHaveBeenCalled();
      const logged = JSON.stringify(spy.mock.calls.map((c) => c.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : a))));
      expect(logged).toContain("[redacted]");
      expect(leakedFragments(logged, LONG_TOKEN)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});

// ── outcomes ("Poll usage now") ──────────────────────────────────────────────
describe("pollSaplingMetrics — outcomes", () => {
  /** Run quietly, handing back BOTH the outcomes and what was logged. */
  const run = async (fn: () => ReturnType<typeof pollSaplingMetrics>) => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try { return { out: await fn(), logged: spy.mock.calls.slice() }; } finally { spy.mockRestore(); }
  };

  it("ok with the NEW rows written, ok with 0 inside the same hour, and failed on a non-200", async () => {
    const fetchImpl = stagingAnswers(() => json(users(6, 9, 9)));
    const first = await run(() => pollSaplingMetrics(systemCtx(), "s3cret", ENVS, NOW, fetchImpl));
    expect(first.out).toEqual([
      { env: "staging", status: "ok", written: 3 },
      { env: "production", status: "failed", written: 0, detail: "HTTP 404" },
    ]);
    expect(first.logged).toEqual([["pollSaplingMetrics", "production", "HTTP 404"]]);
    const again = await run(() => pollSaplingMetrics(systemCtx(), "s3cret", [ENVS[0]], NOW + 20 * 60_000, fetchImpl));
    expect(again.out).toEqual([{ env: "staging", status: "ok", written: 0 }]);
  });

  it("failed on a refused 200 body — the detail is the logged, scrubbed message", async () => {
    const { out, logged } = await run(() => pollSaplingMetrics(systemCtx(), "s3cret", [ENVS[0]], NOW,
      (async () => new Response(`{"active_users":null,"echo":"s3cret"}`, { status: 200 })) as typeof fetch));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ env: "staging", status: "failed", written: 0 });
    expect(out[0].detail).toBe(logged[0][2]);
    expect(out[0].detail).toContain("no active_users object");
    expect(out[0].detail).not.toContain("s3cret");
  });

  it("skipped — never fetched — for an apiUrl that is not https", async () => {
    let calls = 0;
    const fetchImpl = (async () => { calls++; return json(users(6, 9, 9)); }) as typeof fetch;
    const envs = [{ ...ENVS[0], apiUrl: "http://api.staging.saplinglearn.com" }, ENVS[1]];
    const { out } = await run(() => pollSaplingMetrics(systemCtx(), "s3cret", envs, NOW, fetchImpl));
    expect(out).toEqual([
      { env: "staging", status: "skipped", written: 0, detail: "apiUrl is not https" },
      { env: "production", status: "ok", written: 3 },
    ]);
    expect(calls).toBe(1);
  });
});

// ── the projection ───────────────────────────────────────────────────────────
const ok = <T>(s: { status: string; data?: T }): T => { expect(s.status).toBe("ok"); return (s as { data: T }).data; };
/** The start of the hour `h` hours before NOW's own (12:00): h=0 → 12:00, the newest reading a healthy poll has. */
const hoursBack = (h: number) => new Date(Date.parse(AT) - h * HOUR).toISOString();
const gauge = (range: "24h" | "7d" | "30d", envKey: string, h: number, value: number) =>
  putMetric(systemCtx(), { metric: `active_users_${range}`, env: envKey, part: "", value, at: hoursBack(h) });
const cfPoint = async (envKey: string, h: number, requests: number, errors: number) => {
  await putMetric(systemCtx(), { metric: "cf_requests", env: envKey, part: "frontend", value: requests, at: hoursBack(h) });
  await putMetric(systemCtx(), { metric: "cf_errors", env: envKey, part: "frontend", value: errors, at: hoursBack(h) });
};

describe("getRepoDashboard — active users from active_users_* gauges", () => {
  it("each range shows ITS OWN metric's latest reading, per environment", async () => {
    await gauge("24h", "staging", 0, 74);
    await gauge("7d", "staging", 0, 318);
    await gauge("30d", "staging", 0, 1204);
    await gauge("24h", "production", 0, 5);
    const u = ok((await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS)).usage);
    expect(u["24h"][0].users).toMatchObject({ value: "74", tone: "neutral" });
    expect(u["7d"][0].users).toMatchObject({ value: "318", tone: "neutral" });
    expect(u["30d"][0].users).toMatchObject({ value: "1.2K", tone: "neutral" });
    expect(u["24h"][1].users).toMatchObject({ value: "5" });
    expect(u["7d"][1].users).toBeNull(); // production never reported a 7d window
  });

  // A gauge, not a count: the value is the LATEST reading (never a sum of the
  // hourly ones), and a missing hour is unknown — it is left out, never drawn as 0.
  it("the trend is the readings inside the range, oldest first — not summed, not zero-filled", async () => {
    await gauge("24h", "staging", 5, 60);
    await gauge("24h", "staging", 2, 70); // hours 4 and 3 were never polled
    await gauge("24h", "staging", 0, 74);
    await gauge("24h", "staging", 30, 999); // outside the 24h range
    const { users } = ok((await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS)).usage)["24h"][0];
    expect(users).toEqual({ value: "74", trend: [60, 70, 74], tone: "neutral" });
  });

  it("a range's trend reaches back the whole range", async () => {
    await gauge("7d", "staging", 0, 300);
    await gauge("7d", "staging", 100, 250);
    await gauge("7d", "staging", 24 * 7 + 1, 111); // just outside 7 days
    await gauge("30d", "staging", 0, 900);
    await gauge("30d", "staging", 24 * 29, 700);
    const u = ok((await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS)).usage);
    expect(u["7d"][0].users?.trend).toEqual([250, 300]);
    expect(u["30d"][0].users?.trend).toEqual([700, 900]);
  });

  // P5-10: a 30d trend of hourly readings was 720 points in a 100-unit-wide
  // sparkline. It is THINNED, never truncated: the label says 30 days, so the
  // line still spans 30 days — one reading per UTC day (its LAST), and per
  // 6-hour block for 7d. Still never summed, never zero-filled; the headline
  // value stays the latest reading.
  it("thins the 7d and 30d trends to the LAST reading of each block; 24h stays hourly", async () => {
    const every = (range: string, hours: number) => env.DB.batch(Array.from({ length: hours }, (_, h) =>
      env.DB.prepare(`INSERT INTO repo_metrics (metric, env, part, value, at) VALUES (?, 'staging', '', ?, ?)`).bind(`active_users_${range}`, h, hoursBack(h))));
    await every("24h", 24);   // value = hours back, so each pick names the reading it is
    await every("7d", 168);
    await every("30d", 720);
    const u = ok((await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS)).usage);
    expect(u["24h"][0].users?.trend).toEqual(Array.from({ length: 24 }, (_, i) => 23 - i));
    // 7d: 28 six-hour blocks ENDING at the current hour; the newest reading of each.
    expect(u["7d"][0].users?.trend).toEqual(Array.from({ length: 28 }, (_, i) => 162 - 6 * i));
    // 30d: one per UTC day — the 23:00 reading (13h before NOW's 12:00, then every 24h
    // back), and for today the latest one. Aug 21 … Sep 20 = 31 days.
    expect(u["30d"][0].users?.trend).toEqual([...Array.from({ length: 30 }, (_, i) => 709 - 24 * i), 0]);
    for (const range of ["24h", "7d", "30d"] as const) expect(u[range][0].users?.value, range).toBe("0"); // the latest reading
  });

  it("a missing block is left out of a thinned trend — never drawn as zero", async () => {
    await gauge("30d", "staging", 0, 900);
    await gauge("30d", "staging", 1, 890);      // same UTC day as the one above: only the later is kept
    await gauge("30d", "staging", 24 * 10, 700); // nine whole days with no reading in between
    expect(ok((await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS)).usage)["30d"][0].users?.trend).toEqual([700, 900]);
  });

  it("a reading exactly 3 hours old still shows; one older than that does not", async () => {
    await putMetric(systemCtx(), { metric: "active_users_24h", env: "staging", part: "", value: 41, at: new Date(NOW - 3 * HOUR).toISOString() });
    await gauge("24h", "production", 4, 12); // 08:00 — 4h05m before NOW
    const d = await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS);
    const [staging, production] = ok(d.usage)["24h"];
    expect(staging.users).toMatchObject({ value: "41" });
    expect(production.users).toBeNull();
  });

  // P5-2: `empty` here renders "No current usage reading — the hourly polls have
  // gone quiet." — NOT "No usage recorded in the last 30 days.", which these
  // 6-hour-old readings would make false. The copy is pinned beside the render
  // (test/render.repo.test.ts, "usage empty…"): this file is typed as Worker code
  // and cannot import web/src.
  it("only stale readings → users null everywhere, and the section reads empty (the poll has stopped), not not_connected", async () => {
    await gauge("24h", "staging", 6, 41);
    await gauge("7d", "staging", 6, 90);
    await gauge("30d", "staging", 6, 90);
    expect((await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS)).usage.status).toBe("empty");
  });

  it("readings aged out of the 30-day read entirely → still empty, not not_connected", async () => {
    await gauge("7d", "staging", 24 * 40, 90);
    expect((await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS)).usage.status).toBe("empty");
  });

  it("a reading stamped ahead of the clock is not a current one", async () => {
    await gauge("24h", "staging", -2, 500);
    expect((await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS)).usage.status).toBe("empty");
  });

  // The designed state while Cloudflare is connected and Sapling's endpoint is
  // not built yet: live requests, and `users: null` → "not connected" under
  // Active users. It is TRUE, so it stays.
  it("requests live, users null", async () => {
    await cfPoint("staging", 1, 500, 5);
    const d = await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS);
    const [staging] = ok(d.usage)["24h"];
    expect(staging.requests).toMatchObject({ value: "500" });
    expect(staging.errorRate).toMatchObject({ value: "1.00%" });
    expect(staging.users).toBeNull();
  });

  it("users live, requests null — and the Cloudflare panel stays unconnected", async () => {
    await gauge("24h", "staging", 0, 74);
    const d = await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS);
    const [staging] = ok(d.usage)["24h"];
    expect(staging).toMatchObject({ requests: null, errorRate: null, users: { value: "74", trend: [74], tone: "neutral" } });
    expect(d.cloudflare.status).toBe("not_connected");
    expect(d.hosting.status).toBe("not_connected");
  });

  it("both live, side by side", async () => {
    await cfPoint("staging", 1, 500, 0);
    await gauge("24h", "staging", 0, 74);
    const [staging] = ok((await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS)).usage)["24h"];
    expect(staging.requests).toMatchObject({ value: "500" });
    expect(staging.users).toMatchObject({ value: "74" });
  });

  it("a row for an unconfigured environment, or with a part, is nobody's active users", async () => {
    await gauge("24h", "preview", 0, 9);
    await putMetric(systemCtx(), { metric: "active_users_24h", env: "staging", part: "backend", value: 9, at: hoursBack(0) });
    // Something HAS landed under the name, so the section is "gone quiet", never a guess.
    expect((await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS)).usage.status).toBe("empty");
  });

  it("what the poller writes is what the screen reads", async () => {
    const fetchImpl = (async (u: RequestInfo | URL) => json(String(u) === STAGING_URL ? users(74, 318, 1204) : users(1, 2, 3))) as typeof fetch;
    await pollSaplingMetrics(systemCtx(), "s3cret", ENVS, NOW, fetchImpl);
    const u = ok((await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS)).usage);
    expect([u["24h"][0].users?.value, u["7d"][0].users?.value, u["30d"][0].users?.value]).toEqual(["74", "318", "1.2K"]);
    expect([u["24h"][1].users?.value, u["7d"][1].users?.value, u["30d"][1].users?.value]).toEqual(["1", "2", "3"]);
  });
});

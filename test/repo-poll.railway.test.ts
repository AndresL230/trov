/**
 * Task 17 — Railway CPU and memory (source L).
 *
 * `pollRailway` writes hourly `rw_cpu` (vCPU) / `rw_mem_mb` per environment's
 * BACKEND service, authenticating each environment with ITS OWN project token
 * (`Project-Access-Token`, never `Authorization`); `getRepoDashboard` projects
 * the hosting block from the SAME one read the Usage tab already makes, and
 * shows a figure only while it is current (≤ 3 hours old).
 * The fetch is stubbed at the Response level; every assertion is on D1 rows or
 * on the projection built from them.
 */
import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import { all } from "./helpers/db";
import { pollRailway } from "../src/repo/poll";
import { repoEnvironments } from "../src/repo/config";
import { putMetric } from "../src/repo/store";
import { getRepoDashboard } from "../src/tools/repo";
import { ENVS } from "./helpers/repo";

import { systemCtx } from "./helpers/tenant";
const NOW = Date.parse("2026-09-20T12:05:00Z");
const HOUR = 3_600_000;
const RW_URL = "https://backboard.railway.com/graphql/v2";
const WITH_IDS = ENVS.map((e, i) => ({ ...e, railwayEnvironmentId: `env-${i}`, railwayServiceId: "svc" }));
const TOKENS = { staging: "tok-staging", production: "tok-production" };

/** Unix SECONDS — Railway's `ts` — of the hour `h` hours before 12:00Z. */
const ts = (h: number) => (Date.parse("2026-09-20T12:00:00Z") - h * HOUR) / 1000;
const rwBody = (cpu: unknown[], mem: unknown[]) => ({ data: { metrics: [
  { measurement: "CPU_USAGE", values: cpu }, { measurement: "MEMORY_USAGE_GB", values: mem },
] } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const stored = () => all<{ metric: string; env: string; part: string; value: number; at: string }>(env.DB,
  `SELECT metric, env, part, value, at FROM repo_metrics WHERE metric LIKE 'rw_%' ORDER BY env, metric, at`);
const envOf = (init?: RequestInit) => (JSON.parse(String(init?.body)) as { variables: { e: string } }).variables.e;

describe("pollRailway", () => {
  it("stores hourly CPU and memory (as MB) per backend service, and never the hour in progress", async () => {
    const fetchImpl = (async (u: RequestInfo | URL, init?: RequestInit) => {
      expect(String(u)).toBe(RW_URL);
      expect(init?.method).toBe("POST");
      const sent = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, string> };
      expect(sent.variables).toMatchObject({ s: "svc", start: "2026-09-20T09:00:00.000Z" });
      expect(sent.query).toContain("metrics(environmentId:$e,serviceId:$s,startDate:$start");
      expect(sent.query).toContain("sampleRateSeconds:3600");
      return json(rwBody(
        [{ ts: ts(1), value: 0.12 }, { ts: ts(0), value: 0.9 }],   // 11:00 is complete; 12:00 is the hour in progress at 12:05
        [{ ts: ts(1), value: 0.4 }, { ts: ts(0), value: 0.7 }],
      ));
    }) as typeof fetch;
    await pollRailway(systemCtx(), TOKENS, WITH_IDS, NOW, fetchImpl);
    expect((await stored()).filter((r) => r.env === "staging")).toEqual([
      { metric: "rw_cpu", env: "staging", part: "backend", value: 0.12, at: "2026-09-20T11:00:00.000Z" },
      { metric: "rw_mem_mb", env: "staging", part: "backend", value: 409.6, at: "2026-09-20T11:00:00.000Z" },
    ]);
    expect((await stored()).filter((r) => r.env === "production")).toHaveLength(2);
  });

  // A PROJECT token is bound to one environment and is rejected as a bearer.
  it("sends each environment ITS OWN token as Project-Access-Token — never the other's, never Authorization", async () => {
    const seen: Record<string, Headers> = {};
    const fetchImpl = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      seen[envOf(init)] = new Headers(init?.headers);
      return json(rwBody([], []));
    }) as typeof fetch;
    await pollRailway(systemCtx(), TOKENS, WITH_IDS, NOW, fetchImpl);
    expect(seen["env-0"].get("project-access-token")).toBe("tok-staging");
    expect(seen["env-1"].get("project-access-token")).toBe("tok-production");
    for (const h of Object.values(seen)) expect(h.has("authorization")).toBe(false);
    // The header is spelled as Railway documents it.
    const raw: string[] = [];
    await pollRailway(systemCtx(), TOKENS, [WITH_IDS[0]], NOW, (async (_u: RequestInfo | URL, init?: RequestInit) => {
      raw.push(...Object.keys(init?.headers as Record<string, string>));
      return json(rwBody([], []));
    }) as typeof fetch);
    expect(raw).toContain("Project-Access-Token");
  });

  it("skips an environment with no token, no environment id or no service id — the others still poll", async () => {
    const polled: string[] = [];
    const fetchImpl = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      polled.push(envOf(init));
      return json(rwBody([{ ts: ts(1), value: 0.2 }], []));
    }) as typeof fetch;
    await pollRailway(systemCtx(), { production: "tok-production" }, WITH_IDS, NOW, fetchImpl);
    expect(polled).toEqual(["env-1"]);
    await pollRailway(systemCtx(), { staging: "", production: undefined }, WITH_IDS, NOW, fetchImpl);
    expect(polled).toEqual(["env-1"]);
    const partial = [{ ...WITH_IDS[0], railwayServiceId: undefined }, { ...WITH_IDS[1], railwayEnvironmentId: undefined }, { ...WITH_IDS[0], key: "third", railwayEnvironmentId: "env-2" }];
    await pollRailway(systemCtx(), { ...TOKENS, third: "tok-third" }, partial, NOW, fetchImpl);
    expect(polled).toEqual(["env-1", "env-2"]);
    expect((await stored()).map((r) => r.env)).toEqual(["production", "third"]);
  });

  it("the overlap is a no-op: a second poll of the same hour writes nothing new, and the first value stands", async () => {
    await pollRailway(systemCtx(), TOKENS, [WITH_IDS[0]], NOW, (async () => json(rwBody([{ ts: ts(1), value: 0.12 }], []))) as typeof fetch);
    await pollRailway(systemCtx(), TOKENS, [WITH_IDS[0]], NOW, (async () => json(rwBody([{ ts: ts(1), value: 0.99 }], []))) as typeof fetch);
    expect((await stored()).map((r) => [r.metric, r.value])).toEqual([["rw_cpu", 0.12]]);
  });

  // One point per hour whatever second Railway stamps the sample with —
  // otherwise two polls of one hour could both land.
  it("buckets a sample to its hour", async () => {
    await pollRailway(systemCtx(), TOKENS, [WITH_IDS[0]], NOW, (async () => json(rwBody([{ ts: ts(1) + 37, value: 0.12 }], []))) as typeof fetch);
    expect((await stored()).map((r) => r.at)).toEqual(["2026-09-20T11:00:00.000Z"]);
  });

  // Railway's array order is undocumented, and the write is INSERT OR IGNORE —
  // so without a rule, whichever sample came first in the array would win.
  it.each([
    ["ascending", [{ ts: ts(1), value: 0.1 }, { ts: ts(1) + 1800, value: 0.9 }]],
    ["descending", [{ ts: ts(1) + 1800, value: 0.9 }, { ts: ts(1), value: 0.1 }]],
  ])("several samples in one hour bucket (%s): the LATEST ts wins, whatever the array order", async (_name, cpu) => {
    await pollRailway(systemCtx(), TOKENS, [WITH_IDS[0]], NOW, (async () => json(rwBody(cpu, []))) as typeof fetch);
    expect((await stored()).map((r) => [r.metric, r.value, r.at])).toEqual([["rw_cpu", 0.9, "2026-09-20T11:00:00.000Z"]]);
  });

  // The pick happens AFTER validation: an invalid later sample never beats a
  // valid earlier one, and the same measurement split across two series entries
  // is still one pick per bucket.
  it("picks among VALID samples only, across every series entry of the response", async () => {
    const fetchImpl = (async () => json({ data: { metrics: [
      { measurement: "CPU_USAGE", values: [{ ts: ts(1) + 60, value: 0.2 }, { ts: ts(2) + 10, value: 0.3 }] },
      { measurement: "CPU_USAGE", values: [{ ts: ts(1) + 1800, value: 0.5 }, { ts: ts(1) + 3000, value: 5000 }, { ts: ts(1) + 3300, value: null }] },
      { measurement: "MEMORY_USAGE_GB", values: [{ ts: ts(1), value: 2 }, { ts: ts(1) + 1800, value: 1 }] },
    ] } })) as typeof fetch;
    await pollRailway(systemCtx(), TOKENS, [WITH_IDS[0]], NOW, fetchImpl);
    expect((await stored()).map((r) => [r.metric, r.value, r.at])).toEqual([
      ["rw_cpu", 0.3, "2026-09-20T10:00:00.000Z"], ["rw_cpu", 0.5, "2026-09-20T11:00:00.000Z"],
      ["rw_mem_mb", 1024, "2026-09-20T11:00:00.000Z"],
    ]);
  });

  it.each([
    ["a rejected token (non-2xx)", () => json({ errors: [{ message: "Not Authorized" }] }, 401)],
    // A GraphQL failure arrives with HTTP 200: `data` beside `errors` is never read.
    ["a 200 body carrying `errors`", () => json({ errors: [{ message: "Not Authorized" }], ...rwBody([{ ts: ts(1), value: 0.5 }], []) })],
    ["a body with no metrics list", () => json({ data: { metrics: null } })],
    ["a body that is not JSON", () => new Response("<html>bad gateway</html>", { status: 200 })],
  ])("%s costs THAT environment only, and never throws", async (_name, failure) => {
    const fetchImpl = (async (_u: RequestInfo | URL, init?: RequestInit) =>
      envOf(init) === "env-0" ? failure() : json(rwBody([{ ts: ts(1), value: 0.12 }], [{ ts: ts(1), value: 0.4 }]))) as typeof fetch;
    await expect(pollRailway(systemCtx(), TOKENS, WITH_IDS, NOW, fetchImpl)).resolves.toEqual(expect.any(Array));
    expect((await stored()).map((r) => [r.env, r.metric])).toEqual([["production", "rw_cpu"], ["production", "rw_mem_mb"]]);
  });

  it("a thrown fetch writes nothing and does not throw", async () => {
    const fetchImpl = (async () => { throw new Error("connect timeout"); }) as typeof fetch;
    await expect(pollRailway(systemCtx(), TOKENS, WITH_IDS, NOW, fetchImpl)).resolves.toEqual(expect.any(Array));
    expect(await stored()).toEqual([]);
  });

  it("never logs a token, whatever fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const fetchImpl = (async (_u: RequestInfo | URL, init?: RequestInit) => {
        // The worst case: the failure itself quotes the request back.
        throw new Error(`request failed: ${JSON.stringify(init?.headers)}`);
      }) as typeof fetch;
      await pollRailway(systemCtx(), TOKENS, WITH_IDS, NOW, fetchImpl);
      await pollRailway(systemCtx(), TOKENS, WITH_IDS, NOW, (async () => json({ errors: [{ message: "bad token tok-staging tok-production" }] })) as typeof fetch);
      // A token STRADDLING the 200-char cut of the 200-with-`errors` arm: cutting
      // before scrubbing would leave its first half in the log AND in the detail.
      const straddle = await pollRailway(systemCtx(), TOKENS, WITH_IDS, NOW, (async () => json({ errors: [{ message: `${"p".repeat(192)}tok-staging tok-production` }] })) as typeof fetch);
      expect(spy).toHaveBeenCalled();
      const logged = JSON.stringify(spy.mock.calls.map((c) => c.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : a))));
      expect(logged).not.toContain("tok-staging");
      expect(logged).not.toContain("tok-production");
      expect(logged).not.toContain("tok-st");
      expect(JSON.stringify(straddle)).not.toContain("tok-");
    } finally {
      spy.mockRestore();
    }
  });

  it("skips a malformed or implausible value row by row, ignores an unknown measurement, and never stores NaN", async () => {
    const fetchImpl = (async () => json({ data: { metrics: [
      { measurement: "CPU_USAGE", values: [
        { ts: "soon", value: 0.1 }, { ts: -5, value: 0.1 }, { ts: 0, value: 0.1 }, { ts: 1e18, value: 0.1 }, null,
        { ts: ts(3), value: -0.1 }, { ts: ts(3), value: "0.3" }, { ts: ts(3), value: null }, { ts: ts(3), value: 5000 },
        { ts: ts(4), value: 0.1 },            // before the window asked for
        { ts: ts(2), value: 0.25 },           // the one good row, after all of the above
      ] },
      { measurement: "MEMORY_USAGE_GB", values: [{ ts: ts(2), value: 5000 }, { ts: ts(1), value: 1.5 }] },
      { measurement: "NETWORK_RX_GB", values: [{ ts: ts(1), value: 3 }] },
      { measurement: "CPU_USAGE", values: "none" },
      null,
    ] } })) as typeof fetch;
    await expect(pollRailway(systemCtx(), TOKENS, [WITH_IDS[0]], NOW, fetchImpl)).resolves.toEqual(expect.any(Array));
    expect((await stored()).map((r) => [r.metric, r.value, r.at])).toEqual([
      ["rw_cpu", 0.25, "2026-09-20T10:00:00.000Z"], ["rw_mem_mb", 1536, "2026-09-20T11:00:00.000Z"],
    ]);
  });
});

// ── outcomes ("Poll usage now") ──────────────────────────────────────────────
describe("pollRailway — outcomes", () => {
  const good = () => json(rwBody([{ ts: ts(1), value: 0.12 }], [{ ts: ts(1), value: 0.4 }]));

  it("ok with the NEW rows written, and ok with 0 on a repeat of the same hours", async () => {
    const fetchImpl = (async () => good()) as typeof fetch;
    expect(await pollRailway(systemCtx(), TOKENS, WITH_IDS, NOW, fetchImpl)).toEqual([
      { env: "staging", status: "ok", written: 2 },
      { env: "production", status: "ok", written: 2 },
    ]);
    expect(await pollRailway(systemCtx(), TOKENS, WITH_IDS, NOW, fetchImpl)).toEqual([
      { env: "staging", status: "ok", written: 0 },
      { env: "production", status: "ok", written: 0 },
    ]);
  });

  it("failed on a non-2xx and on a 200 carrying `errors`, each with the logged message", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const fetchImpl = (async (_u: RequestInfo | URL, init?: RequestInit) =>
        envOf(init) === "env-0" ? new Response("", { status: 401 }) : json({ errors: [{ message: "Not Authorized" }] })) as typeof fetch;
      expect(await pollRailway(systemCtx(), TOKENS, WITH_IDS, NOW, fetchImpl)).toEqual([
        { env: "staging", status: "failed", written: 0, detail: "railway metrics 401" },
        { env: "production", status: "failed", written: 0, detail: "railway metrics: Not Authorized" },
      ]);
      expect(spy.mock.calls).toEqual([
        ["pollRailway", "staging", "railway metrics 401"],
        ["pollRailway", "production", "railway metrics: Not Authorized"],
      ]);
    } finally { spy.mockRestore(); }
  });

  // The same production finding as Cloudflare's: the status alone hid the cause.
  it("a non-2xx says what the body said — errors[0].message (+ code), else the raw text's start — scrubbed, never throwing", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const details = async (status: number, body: string) => {
        const out = await pollRailway(systemCtx(), TOKENS, [WITH_IDS[0]], NOW, (async () => new Response(body, { status })) as typeof fetch);
        expect(out).toHaveLength(1);
        expect(spy.mock.calls.at(-1)).toEqual(["pollRailway", "staging", out[0].detail]);
        return out[0].detail;
      };
      expect(await details(401, JSON.stringify({ errors: [{ message: "Not Authorized" }] }))).toBe("railway metrics 401: Not Authorized");
      expect(await details(400, JSON.stringify({ errors: [{ message: "Problem processing request", code: "BAD_INPUT" }] }))).toBe("railway metrics 400: Problem processing request [BAD_INPUT]");
      expect(await details(502, "<html>bad gateway</html>")).toBe("railway metrics 502: <html>bad gateway</html>");
      const echoed = await details(401, `${"x".repeat(110)}tok-staging and tok-production`);
      expect(echoed).not.toContain("tok-");
      expect(echoed).toContain("[redacted]");
    } finally { spy.mockRestore(); }
  });

  it("the detail is scrubbed of EVERY token in the map and truncated", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const fetchImpl = (async () => { throw new Error(`echo tok-staging tok-production ${"x".repeat(400)}`); }) as typeof fetch;
      const out = await pollRailway(systemCtx(), TOKENS, [WITH_IDS[0]], NOW, fetchImpl);
      expect(out[0].status).toBe("failed");
      expect(out[0].detail).toMatch(/^echo \[redacted\] \[redacted\] x+$/);
      expect(out[0].detail!.length).toBeLessThanOrEqual(200);
    } finally { spy.mockRestore(); }
  });

  it("skipped — and never fetched — without a token, an environment id or a service id; the detail names which, never a value", async () => {
    let calls = 0;
    const fetchImpl = (async () => { calls++; return good(); }) as typeof fetch;
    const envs = [WITH_IDS[0], { ...WITH_IDS[1], railwayServiceId: undefined }, { ...WITH_IDS[1], key: "third", railwayEnvironmentId: undefined }, { ...WITH_IDS[0], key: "fourth" }];
    const out = await pollRailway(systemCtx(), { staging: undefined, production: "tok-production", third: "tok-third", fourth: "tok-fourth" }, envs, NOW, fetchImpl);
    expect(out).toEqual([
      { env: "staging", status: "skipped", written: 0, detail: "no project token" },
      { env: "production", status: "skipped", written: 0, detail: "no railwayServiceId" },
      { env: "third", status: "skipped", written: 0, detail: "no railwayEnvironmentId" },
      { env: "fourth", status: "ok", written: 2 },
    ]);
    expect(calls).toBe(1);
    expect(JSON.stringify(out)).not.toContain("tok-");
  });
});

describe("REPO_ENVIRONMENTS in wrangler.toml", () => {
  it("still parses to two environments, each naming its Railway environment and the backend service", () => {
    expect(repoEnvironments(env).map((e) => [e.key, e.railwayEnvironmentId, e.railwayServiceId])).toEqual([
      ["staging", "76bb36e5-cf12-4b1e-b47f-d276a56c3b85", "c67bfc38-32a9-41a7-9440-f033d255af30"],
      ["production", "dd058398-45bc-4c7d-80b1-12d46e3f28fb", "c67bfc38-32a9-41a7-9440-f033d255af30"],
    ]);
  });
});

// ── the projection ───────────────────────────────────────────────────────────
const ok = <T>(s: { status: string; data?: T }): T => { expect(s.status).toBe("ok"); return (s as { data: T }).data; };
/** The start of the hour `h` complete hours before NOW's own (12:00): h=1 → 11:00. */
const hoursBack = (h: number) => new Date(Date.parse("2026-09-20T12:00:00Z") - h * HOUR).toISOString();
const rw = (metric: "rw_cpu" | "rw_mem_mb", envKey: string, at: string, value: number) =>
  putMetric(systemCtx(), { metric, env: envKey, part: "backend", value, at });

describe("getRepoDashboard — hosting from rw_* metrics", () => {
  it("nothing captured → not_connected", async () => {
    expect((await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS)).hosting.status).toBe("not_connected");
  });

  it("shows each environment's LATEST cpu and memory", async () => {
    await rw("rw_cpu", "staging", hoursBack(2), 0.5);
    await rw("rw_cpu", "staging", hoursBack(1), 0.123);
    await rw("rw_mem_mb", "staging", hoursBack(1), 409.6);
    await rw("rw_cpu", "production", hoursBack(1), 1.5);
    await rw("rw_mem_mb", "production", hoursBack(1), 2048);
    expect(ok((await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS)).hosting)).toEqual([
      { env: "staging", cpu: "0.12 vCPU", memory: "410 MB" },
      { env: "production", cpu: "1.50 vCPU", memory: "2048 MB" },
    ]);
  });

  // A "current" figure must be current: the poll is hourly over complete hours,
  // so a healthy poller's newest point is 1–2 hours old. Past 3 hours it is "—".
  it("a metric whose latest point is over 3 hours old reads — while a fresh one beside it still shows", async () => {
    await rw("rw_cpu", "staging", new Date(NOW - 3 * HOUR - 60_000).toISOString(), 0.5);
    await rw("rw_mem_mb", "staging", new Date(NOW - 3 * HOUR).toISOString(), 300); // exactly 3h: still current
    expect(ok((await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS)).hosting)).toEqual([{ env: "staging", cpu: "—", memory: "300 MB" }]);
  });

  it("an environment with nothing fresh is left out while another still shows", async () => {
    await rw("rw_cpu", "staging", hoursBack(10), 0.5);
    await rw("rw_cpu", "production", hoursBack(1), 0.25);
    expect(ok((await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS)).hosting)).toEqual([{ env: "production", cpu: "0.25 vCPU", memory: "—" }]);
  });

  it("every reading stale → empty (the poll has stopped), not not_connected — even aged out of the 30-day read", async () => {
    await rw("rw_cpu", "staging", hoursBack(5), 0.5);
    expect((await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS)).hosting.status).toBe("empty");
    await env.DB.prepare(`DELETE FROM repo_metrics`).run();
    await rw("rw_mem_mb", "production", hoursBack(40 * 24), 512);
    expect((await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS)).hosting.status).toBe("empty");
  });

  it("only the backend series of a configured environment counts", async () => {
    await rw("rw_cpu", "preview", hoursBack(1), 0.5);
    await putMetric(systemCtx(), { metric: "rw_cpu", env: "staging", part: "frontend", value: 0.5, at: hoursBack(1) });
    expect((await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS)).hosting.status).toBe("empty");
  });

  it("no environment configured → not_connected whatever is stored", async () => {
    await rw("rw_cpu", "staging", hoursBack(1), 0.5);
    expect((await getRepoDashboard(systemCtx(), "o/r", NOW, []).then((d) => d.hosting.status))).toBe("not_connected");
  });

  // The two sources share ONE read but not one state.
  it("Railway rows never connect usage or Cloudflare, and Cloudflare rows never connect hosting", async () => {
    await rw("rw_cpu", "staging", hoursBack(1), 0.5);
    let d = await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS);
    expect([d.hosting.status, d.usage.status, d.cloudflare.status]).toEqual(["ok", "not_connected", "not_connected"]);
    await env.DB.prepare(`DELETE FROM repo_metrics`).run();
    await putMetric(systemCtx(), { metric: "cf_requests", env: "staging", part: "frontend", value: 10, at: hoursBack(1) });
    await putMetric(systemCtx(), { metric: "cf_errors", env: "staging", part: "frontend", value: 0, at: hoursBack(1) });
    d = await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS);
    expect([d.hosting.status, d.usage.status, d.cloudflare.status]).toEqual(["not_connected", "ok", "ok"]);
  });
});

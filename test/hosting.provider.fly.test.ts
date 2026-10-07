// The Fly.io hosting provider (#101): descriptor, the FlyV1 / Bearer header, probe, and poll — releases as
// deploys and Prometheus as hourly points — against recorded-shape fixtures (fixtures/hosting/fly/). Fetch is
// stubbed BEHIND the real `hostFetch`, so every request also proves the host allowlist holds.
import { describe, expect, it } from "vitest";
import { metricsForRole } from "@shared/hosting";
import { fly } from "../src/hosting/providers/fly";
import { HostRefusedError, HostingError, hostFetch, type SecretLike } from "../src/hosting/http";
import { checkFields } from "../src/hosting/registry";
import type { PartRef, ProviderContext } from "../src/hosting/types";
import { LONG_TOKEN, leakedFragments } from "./helpers/repo";
import appJson from "../fixtures/hosting/fly/app.json";
import releasesJson from "../fixtures/hosting/fly/releases.json";
import promRequests from "../fixtures/hosting/fly/prom-requests.json";
import promErrors from "../fixtures/hosting/fly/prom-errors.json";
import promLatency from "../fixtures/hosting/fly/prom-latency-p95.json";
import promBandwidth from "../fixtures/hosting/fly/prom-bandwidth.json";
import promCpu from "../fixtures/hosting/fly/prom-cpu.json";
import promMemory from "../fixtures/hosting/fly/prom-memory.json";
import promUp from "../fixtures/hosting/fly/prom-instant-up.json";
import promError from "../fixtures/hosting/fly/prom-error.json";

// 2026-10-07 12:20 UTC → the poll window is 09:00–12:00, read as samples at 10:00, 11:00, 12:00.
const NOW = Date.parse("2026-10-07T12:20:00Z");
const T = (hhmm: string): number => Date.parse(`2026-10-07T${hhmm}:00Z`) / 1000;

// What `fly tokens create readonly` prints: a scheme, then two comma-separated macaroons (64 hex characters
// each, LONG_TOKEN and its reverse, so a leak of EITHER piece is caught).
const TOKEN_B = [...LONG_TOKEN].reverse().join("");
const STORED = `FlyV1 fm2_${LONG_TOKEN},fm2_${TOKEN_B}`;
const HEADER = `FlyV1 fm2_${LONG_TOKEN},fm2_${TOKEN_B}`;
const noLeak = (text: string): void => {
  expect(leakedFragments(text, LONG_TOKEN)).toEqual([]);
  expect(leakedFragments(text, TOKEN_B)).toEqual([]);
};

const secret = (value: string): SecretLike => ({ reveal: () => value, toString: () => "[secret]" } as SecretLike);
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** A refusal that quotes the request's credential back — the scrub must catch it. */
const echo = (status: number): Response =>
  json({ error: `token fm2_${LONG_TOKEN} rejected (also fm2_${TOKEN_B})` }, status);

interface Call { url: URL; headers: Headers; method: string; redirect: string | undefined }

function stubbed(route: (u: URL) => Response | Promise<Response>): { calls: Call[]; fetch: ReturnType<typeof hostFetch> } {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, headers: new Headers(init?.headers), method: init?.method ?? "GET", redirect: init?.redirect });
    return route(url);
  }) as typeof fetch;
  return { calls, fetch: hostFetch(fly.apiHosts, impl) };
}

const ctx = (f: ReturnType<typeof hostFetch>, opts: { token?: string; config?: Record<string, string> } = {}): ProviderContext => ({
  fetch: f,
  credential: { secret: secret(opts.token ?? STORED), config: opts.config ?? { org_slug: "acme-labs" } },
  now: NOW,
});

const part = (role: "web" | "service" = "web", settings: Record<string, string> = { app: "myapp-staging" }): PartRef => ({
  orgId: "org_acme", env: "staging", envLabel: "staging", branch: "main", key: role === "web" ? "web" : "api", role, settings,
});

const promFor = (query: string): unknown => {
  if (query.includes("status=~\"5..\"")) return promErrors;
  if (query.includes("fly_edge_http_response_time_seconds_bucket")) return promLatency;
  if (query.includes("fly_edge_data_out")) return promBandwidth;
  if (query.includes("fly_edge_http_responses_count")) return promRequests;
  if (query.includes("fly_instance_cpu")) return promCpu;
  if (query.includes("fly_instance_memory")) return promMemory;
  throw new Error(`unexpected query ${query}`);
};

/** The happy path: releases + every Prometheus query answer from the fixtures. `over` replaces a route. */
function flyApi(over: { releases?: () => Response; app?: () => Response; range?: (q: string) => Response | null } = {}) {
  return stubbed((u) => {
    if (u.hostname === "api.fly.io" && u.pathname === "/api/v1/apps/myapp-staging/releases") return over.releases?.() ?? json(releasesJson);
    if (u.hostname === "api.machines.dev" && u.pathname === "/v1/apps/myapp-staging") return over.app?.() ?? json(appJson);
    if (u.hostname === "api.fly.io" && u.pathname === "/prometheus/acme-labs/api/v1/query_range") {
      const q = u.searchParams.get("query") ?? "";
      return over.range?.(q) ?? json(promFor(q));
    }
    if (u.hostname === "api.fly.io" && u.pathname === "/prometheus/acme-labs/api/v1/query") return json(promUp);
    throw new Error(`unexpected request ${u}`);
  });
}

/** Every call: an allowed host, a GET, the FlyV1 header, no redirect followed. */
function expectWellFormed(calls: Call[], header = HEADER): void {
  for (const c of calls) {
    expect(fly.apiHosts).toContain(c.url.hostname);
    expect(c.url.protocol).toBe("https:");
    expect(c.method).toBe("GET");
    expect(c.headers.get("authorization")).toBe(header);
    expect(c.redirect).toBe("manual");
  }
}

describe("fly descriptor", () => {
  it("names exact hosts, both roles, one token method and no install", () => {
    expect(fly.id).toBe("fly");
    expect(fly.status).toBe("available");
    expect([...fly.apiHosts]).toEqual(["api.machines.dev", "api.fly.io"]);
    for (const h of fly.apiHosts) expect(h).toMatch(/^[a-z0-9.-]+$/);
    expect([...fly.roles]).toEqual(["web", "service"]);
    expect(fly.credentialScope).toBe("org");
    expect(fly.connectionMethods.map((m) => m.method)).toEqual(["token"]);
    const how = fly.connectionMethods[0].howTo;
    expect(how).toContain("fly tokens create readonly");
    expect(how).toContain("fly auth token"); // named as the one NOT to use
    expect(how).toContain("api.machines.dev and api.fly.io");
    expect(fly.install).toBeUndefined();
    expect(fly.capabilities.deploys).toBe(true);
  });

  it("reads only metrics of its roles, and every role metric is read or explained", () => {
    const all = [...metricsForRole("web"), ...metricsForRole("service")];
    for (const m of fly.capabilities.metrics) expect(all).toContain(m);
    expect([...fly.capabilities.metrics].sort()).toEqual(["bandwidth_bytes", "cpu", "errors", "latency_p95_ms", "mem_mb", "requests"]);
  });

  it("checks the org slug and the app name against their patterns", () => {
    expect(checkFields(fly.orgConfigFields, { org_slug: "acme-labs" }, "config")).toEqual({ values: { org_slug: "acme-labs" } });
    expect(checkFields(fly.orgConfigFields, { org_slug: "personal" }, "config")).toEqual({ values: { org_slug: "personal" } });
    for (const bad of ["Acme Labs", "acme_labs", "acme/labs", "a".repeat(64)]) {
      expect(checkFields(fly.orgConfigFields, { org_slug: bad }, "config")).toHaveProperty("message");
    }
    expect(checkFields(fly.orgConfigFields, {}, "config")).toEqual({ field: "config.org_slug", message: "Organization slug is required" });

    expect(checkFields(fly.partSettings, { app: "myapp-staging" }, "settings")).toEqual({ values: { app: "myapp-staging" } });
    for (const bad of ["a", "MyApp", "my_app", "my app", "my\"app", "a".repeat(64), "../etc"]) {
      expect(checkFields(fly.partSettings, { app: bad }, "settings")).toHaveProperty("message");
    }
    expect(checkFields(fly.partSettings, {}, "settings")).toHaveProperty("message", "App name is required");
  });

  it("links the app's dashboard page", () => {
    expect(fly.consoleUrl({ settings: { app: "myapp-staging" } }, { org_slug: "acme-labs" })).toBe("https://fly.io/apps/myapp-staging");
    expect(fly.consoleUrl({ settings: {} }, {})).toBeNull();
    expect(fly.consoleUrl({ settings: { app: "Bad App" } }, {})).toBeNull();
  });

  it("budgets the worst case: releases, the 404 app check, four web queries", () => {
    expect(fly.pollCost).toBe(6);
  });
});

describe("fly header (fly-go tokens.normalized)", () => {
  const headerFor = async (token: string): Promise<{ header: string | null; ok: boolean; detail: string; calls: number }> => {
    const { calls, fetch } = flyApi();
    const r = await fly.probe(ctx(fetch, { token }), null);
    return { header: calls[0]?.headers.get("authorization") ?? null, ok: r.ok, detail: r.detail, calls: calls.length };
  };

  it("sends macaroons as FlyV1, stripping any pasted scheme", async () => {
    expect((await headerFor(STORED)).header).toBe(HEADER);
    expect((await headerFor(`fm2_${LONG_TOKEN},fm2_${TOKEN_B}`)).header).toBe(HEADER);
    expect((await headerFor(`  flyv1   FlyV1 fm2_${LONG_TOKEN} , fm2_${TOKEN_B}\n`)).header).toBe(HEADER);
    expect((await headerFor(`Bearer fm1r_${LONG_TOKEN}`)).header).toBe(`FlyV1 fm1r_${LONG_TOKEN}`);
    expect((await headerFor(`fm1a_${LONG_TOKEN}`)).header).toBe(`FlyV1 fm1a_${LONG_TOKEN}`);
  });

  it("sends a legacy token as Bearer, and only the macaroons when both are pasted", async () => {
    expect((await headerFor(LONG_TOKEN)).header).toBe(`Bearer ${LONG_TOKEN}`);
    expect((await headerFor(`Bearer ${LONG_TOKEN}`)).header).toBe(`Bearer ${LONG_TOKEN}`);
    expect((await headerFor(`fm2_${LONG_TOKEN},${TOKEN_B}`)).header).toBe(`FlyV1 fm2_${LONG_TOKEN}`);
  });

  it("refuses an empty or broken token in fixed words, before any request", async () => {
    for (const bad of ["", "   ", "FlyV1 ", `fm2_${LONG_TOKEN.slice(0, 32)} ${LONG_TOKEN.slice(32)}`, `fm2_${LONG_TOKEN}\u0000`]) {
      const r = await headerFor(bad);
      expect(r.calls).toBe(0);
      expect(r.ok).toBe(false);
      expect(r.detail).toBe("the Fly.io token is not in the expected form — paste the whole output of fly tokens create readonly");
      noLeak(r.detail);
    }
  });
});

describe("fly probe", () => {
  it("without a part: one Prometheus instant query proves the token and the org", async () => {
    const { calls, fetch } = flyApi();
    const r = await fly.probe(ctx(fetch), null);
    expect(r).toEqual({ ok: true, detail: "Fly.io answered for organization acme-labs." });
    expect(calls).toHaveLength(1);
    expect(calls[0].url.pathname).toBe("/prometheus/acme-labs/api/v1/query");
    expect(calls[0].url.searchParams.get("query")).toBe("count(fly_instance_up)");
    expectWellFormed(calls);
  });

  it("with a part: the Machines API app (in the org), then its metrics", async () => {
    const { calls, fetch } = flyApi();
    const r = await fly.probe(ctx(fetch), part());
    expect(r).toEqual({ ok: true, detail: "Fly.io answered for app myapp-staging (deployed)." });
    expect(calls.map((c) => `${c.url.hostname}${c.url.pathname}`)).toEqual([
      "api.machines.dev/v1/apps/myapp-staging", "api.fly.io/prometheus/acme-labs/api/v1/query",
    ]);
    expect(calls[1].url.searchParams.get("query")).toBe("count(fly_instance_up{app=\"myapp-staging\"})");
    expectWellFormed(calls);
  });

  it("refuses an app that belongs to another organization", async () => {
    const { calls, fetch } = flyApi({ app: () => json({ ...appJson, organization: { name: "Other", slug: "other-co" } }) });
    const r = await fly.probe(ctx(fetch), part());
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("belongs to another organization than acme-labs");
    expect(calls).toHaveLength(1);
  });

  it("a 401 is a scrubbed refusal that says the token is not valid", async () => {
    const { fetch } = flyApi({ app: () => echo(401) });
    const r = await fly.probe(ctx(fetch), part());
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/^fly\.io app 401: .*\[redacted\].* — the token is not valid or has expired/);
    noLeak(r.detail);
  });

  it("a 404 says no app by that name", async () => {
    const { fetch } = flyApi({ app: () => json({ error: "App not found" }, 404) });
    const r = await fly.probe(ctx(fetch), part());
    expect(r).toEqual({ ok: false, status: 404, detail: "fly.io app 404: App not found — no app by that name that the token can see" });
  });

  it("a Prometheus 403 (a token that may not read metrics) fails the test", async () => {
    const { fetch } = stubbed((u) => (u.hostname === "api.machines.dev" ? json(appJson) : echo(403)));
    const r = await fly.probe(ctx(fetch), part());
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("fly.io metrics 403");
    expect(r.detail).toContain("check the organization slug");
    noLeak(r.detail);
  });

  it("refuses a missing org slug before any request", async () => {
    const { calls, fetch } = flyApi();
    const r = await fly.probe(ctx(fetch, { config: {} }), part());
    expect(r).toEqual({ ok: false, detail: "the Fly.io organization slug is not set — fly orgs list shows it" });
    expect(calls).toHaveLength(0);
  });
});

describe("fly poll — deploys", () => {
  it("maps every release status and orders newest first", async () => {
    const { fetch } = flyApi();
    const r = await fly.poll(ctx(fetch), part());
    expect(r.deploys.map((d) => [d.id, d.state, d.message])).toEqual([
      ["Pv7XoqM2lJ8eRk1N", "building", "v46 · rolling"],
      ["Mw2LkqZ9nB4tYc0D", "ready", "v45 · rolling"],
      ["Kq5JdpR8sV1hXf3G", "error", "v44 · canary"],
      ["Hb8TmwC3xN6pQz2E", "canceled", "v43 · bluegreen"],
      ["Fd1RnyV7kL0wSa9H", "ready", "v42 · rolling one"],
    ]);
    expect(r.deploys[1]).toEqual({
      id: "Mw2LkqZ9nB4tYc0D", state: "ready", target: "production", sha: null, branch: null, message: "v45 · rolling",
      by: "dana@acme-labs.dev", createdAt: "2026-10-06T16:40:03.000Z", readyAt: null,
      url: "https://myapp-staging.fly.dev", inspectUrl: "https://fly.io/apps/myapp-staging/releases",
    });
  });

  it("asks for 20 releases and skips what it cannot place, never guessing", async () => {
    const releases = [
      { id: "a1", version: 9, status: "superseded", created_at: "2026-10-07T08:00:00Z" },                         // unknown status
      { id: "a2", version: 8, status: "deploying", in_progress: true, created_at: "2026-10-07T07:00:00Z" },      // unknown, but in progress
      { id: "a3", version: 7, status: "complete" },                                                               // no created_at
      { version: 6, status: "pending", user: { email: null, name: "Dana" }, created_at: "2026-10-07T06:00:00Z" }, // no id
      { id: "a5", status: "Cancelled", user: 42, created_at: T("04:00") },                                        // no version, epoch s
      { id: "a6", version: 4, status: "SUCCEEDED", user: { email: "omar@acme-labs.dev" }, created_at: "2026-10-07T04:00:00Z" },
      "not a release",
      null,
    ];
    const { calls, fetch } = flyApi({ releases: () => json({ releases }) });
    const r = await fly.poll(ctx(fetch), part("service"));
    expect(calls[0].url.searchParams.get("limit")).toBe("20");
    expect(r.deploys.map((d) => [d.id, d.state, d.message, d.by, d.createdAt])).toEqual([
      ["a2", "building", "v8", null, "2026-10-07T07:00:00.000Z"],
      ["v6", "building", "v6", "Dana", "2026-10-07T06:00:00.000Z"],
      // The same instant: the higher version first.
      ["a6", "ready", "v4", "omar@acme-labs.dev", "2026-10-07T04:00:00.000Z"],
      ["a5", "canceled", null, null, "2026-10-07T04:00:00.000Z"],
    ]);
  });

  it("accepts a bare list, refuses a body with no list", async () => {
    const bare = flyApi({ releases: () => json(releasesJson.releases) });
    expect((await fly.poll(ctx(bare.fetch), part("service"))).deploys).toHaveLength(5);
    const none = flyApi({ releases: () => json({ data: [] }) });
    await expect(fly.poll(ctx(none.fetch), part("service"))).rejects.toThrow("fly.io releases: the response has no releases list");
  });

  it("a 404 from the undocumented route is no deploys — once the app is confirmed in the org", async () => {
    const { calls, fetch } = flyApi({ releases: () => json({ error: "Not Found" }, 404) });
    const r = await fly.poll(ctx(fetch), part());
    expect(r.deploys).toEqual([]);
    expect(r.points.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(6);
    expect(calls.length).toBeLessThanOrEqual(fly.pollCost);
    expect(`${calls[1].url.hostname}${calls[1].url.pathname}`).toBe("api.machines.dev/v1/apps/myapp-staging");
    expectWellFormed(calls);
  });

  it("…but a 404 for an app that is not there, or is another org's, fails the poll", async () => {
    const missing = flyApi({ releases: () => json({}, 404), app: () => json({ error: "App not found" }, 404) });
    await expect(fly.poll(ctx(missing.fetch), part())).rejects.toThrow("fly.io app 404: App not found — no app by that name");
    expect(missing.calls).toHaveLength(2);
    const other = flyApi({ releases: () => json({}, 404), app: () => json({ ...appJson, organization: { slug: "other-co" } }) });
    await expect(fly.poll(ctx(other.fetch), part())).rejects.toThrow("belongs to another organization than acme-labs");
  });

  it("any other refusal throws a scrubbed HostingError", async () => {
    for (const status of [401, 403, 500]) {
      const { fetch } = flyApi({ releases: () => echo(status) });
      const e = await fly.poll(ctx(fetch), part()).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(HostingError);
      expect((e as Error).message).toContain(`fly.io releases ${status}`);
      noLeak((e as Error).message);
    }
  });

  it("a redirect is never followed", async () => {
    const { calls, fetch } = flyApi({ releases: () => new Response(null, { status: 302, headers: { location: "https://evil.example/x" } }) });
    await expect(fly.poll(ctx(fetch), part())).rejects.toThrow("fly.io releases 302 — a redirect is never followed");
    expect(calls).toHaveLength(1);
  });
});

describe("fly poll — metrics", () => {
  it("a web part: four edge queries over the window's three hours, converted and bucketed", async () => {
    const { calls, fetch } = flyApi();
    const r = await fly.poll(ctx(fetch), part("web"));
    expect(calls).toHaveLength(5);
    expect(calls.length).toBeLessThanOrEqual(fly.pollCost);
    expectWellFormed(calls);
    const ranges = calls.slice(1);
    for (const c of ranges) {
      expect(c.url.pathname).toBe("/prometheus/acme-labs/api/v1/query_range");
      expect(c.url.searchParams.get("start")).toBe(String(T("10:00")));
      expect(c.url.searchParams.get("end")).toBe(String(T("12:00")));
      expect(c.url.searchParams.get("step")).toBe("3600");
      expect(c.url.searchParams.get("query")).toContain("app=\"myapp-staging\"");
    }
    expect(ranges.map((c) => c.url.searchParams.get("query"))).toEqual([
      "sum(increase(fly_edge_http_responses_count{app=\"myapp-staging\"}[1h]))",
      "sum(increase(fly_edge_http_responses_count{app=\"myapp-staging\",status=~\"5..\"}[1h]))",
      "histogram_quantile(0.95, sum(rate(fly_edge_http_response_time_seconds_bucket{app=\"myapp-staging\"}[1h])) by (le)) * 1000",
      "sum(increase(fly_edge_data_out{app=\"myapp-staging\"}[1h]))",
    ]);
    const at = (h: string): string => `2026-10-07T${h}:00:00.000Z`;
    expect(r.points).toEqual([
      { metric: "requests", at: at("09"), value: 1523 },
      { metric: "requests", at: at("10"), value: 1610 },
      { metric: "requests", at: at("11"), value: 1499 },
      // 09:00 had requests and no 5xx series yet: a measured zero, written explicitly.
      { metric: "errors", at: at("09"), value: 0 },
      { metric: "errors", at: at("10"), value: 3 },
      { metric: "errors", at: at("11"), value: 0 },
      { metric: "latency_p95_ms", at: at("09"), value: 184.3 },
      { metric: "latency_p95_ms", at: at("10"), value: 212.9 },
      { metric: "latency_p95_ms", at: at("11"), value: 197.5 },
      { metric: "bandwidth_bytes", at: at("09"), value: 48213378 },
      { metric: "bandwidth_bytes", at: at("10"), value: 51200000 },
      { metric: "bandwidth_bytes", at: at("11"), value: 47000123 },
    ]);
    expect(r.covered).toEqual({ from: at("09"), to: at("12") });
    expect(r.unavailable).toEqual([{ metric: "latency_p50_ms", reason: "Trov reads Fly.io's edge latency as a p95 only" }]);
    for (const p of r.points) expect(Date.parse(p.at)).toBeLessThan(Date.parse("2026-10-07T12:00:00Z"));
  });

  it("a service part: CPU and memory only, in vCPU and MB", async () => {
    const { calls, fetch } = flyApi();
    const r = await fly.poll(ctx(fetch), part("service"));
    expect(calls).toHaveLength(3);
    expect(calls.length).toBeLessThanOrEqual(fly.pollCost);
    expect(calls.slice(1).map((c) => c.url.searchParams.get("query"))).toEqual([
      "sum(rate(fly_instance_cpu{app=\"myapp-staging\",mode!=\"idle\"}[1h])) / 100",
      "sum(avg_over_time(fly_instance_memory_mem_total{app=\"myapp-staging\"}[1h]) - avg_over_time(fly_instance_memory_mem_available{app=\"myapp-staging\"}[1h])) / 1048576",
    ]);
    expect(r.points.map((p) => [p.metric, p.at.slice(11, 16), p.value])).toEqual([
      ["cpu", "09:00", 0.073], ["cpu", "10:00", 0.081], ["cpu", "11:00", 0.069],
      ["mem_mb", "09:00", 212.4], ["mem_mb", "10:00", 219], ["mem_mb", "11:00", 215.8],
    ]);
    expect(r.unavailable).toEqual([]);
    expect(r.covered).toEqual({ from: "2026-10-07T09:00:00.000Z", to: "2026-10-07T12:00:00.000Z" });
  });

  it("drops incomplete, future, unaligned and out-of-window samples, and skips malformed values one by one", async () => {
    const matrix = (values: unknown[]): Response => json({ status: "success", data: { resultType: "matrix", result: [{ metric: {}, values }] } });
    const { fetch } = flyApi({
      range: (q) => {
        if (q.includes("status=~")) return matrix([]);
        if (q.includes("_bucket")) return matrix([[T("10:00"), "NaN"], [T("11:00"), "+Inf"], [T("12:00"), "-Inf"]]);
        if (q.includes("fly_edge_data_out")) return json({ status: "success", data: { resultType: "matrix", result: [] } });
        return matrix([
          [T("09:00"), "11"],          // the hour before the window
          [T("10:00"), "12"],          // → 09:00
          [T("10:30"), "13"],          // unaligned
          [T("11:00") + 0.0001, "14"], // a float stamp that rounds onto the hour → 10:00
          [`${T("12:00")}`, "15.4"],   // a string stamp → 11:00
          [T("13:00"), "16"],          // → 12:00, the running hour: never stored
          [T("14:00"), "17"],          // the future
          [T("11:00"), "oops"], [T("11:00"), -3], [T("11:00"), "-3"], ["x", "1"], [T("11:00")], "junk", null,
        ]);
      },
    });
    const r = await fly.poll(ctx(fetch), part("web"));
    expect(r.points.map((p) => [p.metric, p.at.slice(11, 16), p.value])).toEqual([
      ["requests", "09:00", 12], ["requests", "10:00", 14], ["requests", "11:00", 15],
      // An empty 5xx result over hours the requests query answered for: measured zeros.
      ["errors", "09:00", 0], ["errors", "10:00", 0], ["errors", "11:00", 0],
    ]);
    expect(r.covered).toEqual({ from: "2026-10-07T09:00:00.000Z", to: "2026-10-07T12:00:00.000Z" });
  });

  it("sums several series of an additive query, and leaves a quantile with several unread", async () => {
    const two = (a: string, b: string): Response => json({ status: "success", data: { resultType: "matrix", result: [
      { metric: { region: "ams" }, values: [[T("10:00"), a]] }, { metric: { region: "iad" }, values: [[T("10:00"), b]] },
    ] } });
    const { fetch } = flyApi({ range: (q) => (q.includes("_bucket") ? two("100", "300") : q.includes("status=~") ? null : two("10", "5")) });
    const r = await fly.poll(ctx(fetch), part("web"));
    expect(r.points.filter((p) => p.metric === "requests")).toEqual([{ metric: "requests", at: "2026-10-07T09:00:00.000Z", value: 15 }]);
    expect(r.points.filter((p) => p.metric === "bandwidth_bytes")).toEqual([{ metric: "bandwidth_bytes", at: "2026-10-07T09:00:00.000Z", value: 15 }]);
    expect(r.points.filter((p) => p.metric === "latency_p95_ms")).toEqual([]);
  });

  it("an implausible value is skipped, never stored", async () => {
    const one = (v: string): Response => json({ status: "success", data: { resultType: "matrix", result: [{ metric: {}, values: [[T("10:00"), v], [T("11:00"), "1e9"], [T("12:00"), "1e400"]] }] } });
    const { fetch } = flyApi({ range: (q) => (q.includes("fly_instance_cpu") ? one("250000") : one("123.45")) });
    const r = await fly.poll(ctx(fetch), part("service"));
    // 250,000 vCPU, 10⁹ MB and an overflow to Infinity are not readings; 123.45 MB is.
    expect(r.points).toEqual([{ metric: "mem_mb", at: "2026-10-07T09:00:00.000Z", value: 123.5 }]);
  });

  it("a skipped request count earns no measured-zero error point", async () => {
    const one = (v: string): Response => json({ status: "success", data: { resultType: "matrix", result: [{ metric: {}, values: [[T("10:00"), v]] }] } });
    const empty = json({ status: "success", data: { resultType: "matrix", result: [] } });
    const { fetch } = flyApi({ range: (q) => (q.includes("status=~") || !q.includes("fly_edge_http_responses_count") ? empty.clone() : one("1e13")) });
    const r = await fly.poll(ctx(fetch), part("web"));
    expect(r.points).toEqual([]);
    expect(r.covered).toEqual({ from: "2026-10-07T09:00:00.000Z", to: "2026-10-07T12:00:00.000Z" });
  });

  it("a refused query — 4xx or a 200 saying error — throws a scrubbed HostingError", async () => {
    const bad = flyApi({ range: (q) => (q.includes("_bucket") ? json(promError, 400) : null) });
    await expect(fly.poll(ctx(bad.fetch), part("web"))).rejects.toThrow(
      "fly.io metrics (latency_p95_ms) 400: 1:34: parse error: unexpected \"}\" in label matching, expected string",
    );
    const leak = flyApi({ range: () => json({ status: "error", errorType: "execution", error: `denied for fm2_${LONG_TOKEN},fm2_${TOKEN_B}` }) });
    const e = await fly.poll(ctx(leak.fetch), part("service")).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HostingError);
    expect((e as Error).message).toMatch(/^fly\.io metrics \(cpu\): denied for \[redacted\]/);
    noLeak((e as Error).message);
    const echoed = flyApi({ range: () => echo(401) });
    const e2 = await fly.poll(ctx(echoed.fetch), part("service")).catch((x: unknown) => x);
    expect((e2 as Error).message).toContain("fly.io metrics (cpu) 401");
    noLeak((e2 as Error).message);
  });

  it("refuses a body that is not a Prometheus answer, or not JSON", async () => {
    const wrong = flyApi({ range: () => json({ status: "success", data: { resultType: "vector" } }) });
    await expect(fly.poll(ctx(wrong.fetch), part("service"))).rejects.toThrow("fly.io metrics (cpu): the response is not a Prometheus answer");
    const scalar = flyApi({ range: () => json({ status: "success", data: { resultType: "scalar", result: [] } }) });
    await expect(fly.poll(ctx(scalar.fetch), part("service"))).rejects.toThrow("fly.io metrics (cpu): the response is not a range result");
    const html = flyApi({ range: () => new Response("<html>bad gateway</html>", { status: 200 }) });
    await expect(fly.poll(ctx(html.fetch), part("service"))).rejects.toThrow("fly.io metrics (cpu): the response is not JSON");
  });

  it("re-checks the app name and org slug itself — nothing unvalidated reaches a URL or PromQL", async () => {
    for (const app of ["x\"}[1h])) or vector(1) #", "Bad", ""]) {
      const { calls, fetch } = flyApi();
      await expect(fly.poll(ctx(fetch), part("web", { app }))).rejects.toThrow("the part's Fly.io app name is not set or not in the expected form");
      expect(calls).toHaveLength(0);
    }
    const { calls, fetch } = flyApi();
    await expect(fly.poll(ctx(fetch, { config: { org_slug: "../graphql" } }), part())).rejects.toThrow("the Fly.io organization slug is not set");
    expect(calls).toHaveLength(0);
  });

  it("the credential never goes anywhere but the two API hosts", async () => {
    const sent: string[] = [];
    const f = hostFetch(fly.apiHosts, (async (u: RequestInfo | URL) => { sent.push(String(u)); return json({}); }) as typeof fetch);
    for (const url of ["https://fly.io/apps/x", "https://myapp-staging.fly.dev/", "http://api.fly.io/graphql", "https://api.fly.io.evil.example/x"]) {
      await expect(f(url, { headers: { authorization: HEADER } })).rejects.toBeInstanceOf(HostRefusedError);
    }
    expect(sent).toEqual([]);
  });
});

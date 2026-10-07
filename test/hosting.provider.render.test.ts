// Render (#99) — src/hosting/providers/render.ts against recorded-shape fixtures (fixtures/hosting/render/).
// No network: `fetch` is a stub, wrapped in the REAL `hostFetch(render.apiHosts, …)`, so every request also
// proves the allowlist. The stub records every call; each test checks host, method and the Bearer header
// after the fact (an assertion thrown INSIDE the stub would be swallowed into a fixed-text HostingError).
import { describe, it, expect } from "vitest";
import { HOSTING_METRICS, metricsForRole, type PartRole } from "@shared/hosting";
import { render } from "../src/hosting/providers/render";
import { HostRefusedError, HostingError, hostFetch, pollWindow } from "../src/hosting/http";
import { checkFields } from "../src/hosting/registry";
import type { PartRef, ProviderContext } from "../src/hosting/types";
import { LONG_TOKEN, leakedFragments } from "./helpers/repo";
import serviceFx from "../fixtures/hosting/render/service.json";
import workerFx from "../fixtures/hosting/render/service-worker.json";
import deploysFx from "../fixtures/hosting/render/deploys.json";
import ownersFx from "../fixtures/hosting/render/owners.json";
import ownerFx from "../fixtures/hosting/render/owner.json";
import requestsFx from "../fixtures/hosting/render/metrics-http-requests.json";
import latencyFx from "../fixtures/hosting/render/metrics-http-latency.json";
import bandwidthFx from "../fixtures/hosting/render/metrics-bandwidth.json";
import cpuFx from "../fixtures/hosting/render/metrics-cpu.json";
import memoryFx from "../fixtures/hosting/render/metrics-memory.json";

const TOKEN = LONG_TOKEN;
const SRV = "srv-d3k8q1j7mgec73a1b2c0";
const WORKER = "srv-d3k9a2m7mgec73b4c5d0";
const OWNER = "tea-cn1t5h0l5elc73fk0abc";
/** 12:20 UTC → the window is [09:00, 12:00): the last three complete hours closed ≥ 15 minutes. */
const NOW = Date.parse("2026-10-07T12:20:00Z");
const H = (hh: string) => `2026-10-07T${hh}:00:00.000Z`;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** An upstream doing its worst: its error body echoes the credential back. */
const echo = (status: number): Response => json({ id: "unauthorized", message: `bad key Bearer ${TOKEN} (${TOKEN})` }, status);

type Route = Response | unknown | ((url: URL) => Response);
interface Call { url: URL; method: string; auth: string | null; redirect: string | undefined }

function harness(routes: Record<string, Route>, config: Record<string, string> = {}, now = NOW) {
  const calls: Call[] = [];
  const unexpected: string[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ url, method: init?.method ?? "GET", auth: new Headers(init?.headers).get("authorization"), redirect: init?.redirect });
    const r = routes[url.pathname];
    if (r === undefined) { unexpected.push(url.pathname); throw new Error(`no route ${url.pathname}`); }
    if (typeof r === "function") return (r as (u: URL) => Response)(url);
    if (r instanceof Response) return r.clone();
    return json(r);
  }) as typeof fetch;
  const pc: ProviderContext = { fetch: hostFetch(render.apiHosts, impl), credential: { secret: { reveal: () => TOKEN }, config }, now };
  /** Every call: GET, to api.render.com over https, the key as a Bearer, no redirect followed. */
  const checkCalls = () => {
    expect(unexpected).toEqual([]);
    for (const c of calls) {
      expect(c.url.protocol).toBe("https:");
      expect(c.url.hostname).toBe("api.render.com");
      expect(c.url.pathname.startsWith("/v1/")).toBe(true);
      expect(c.method).toBe("GET");
      expect(c.auth).toBe(`Bearer ${TOKEN}`);
      expect(c.redirect).toBe("manual");
    }
  };
  return { pc, calls, checkCalls };
}

const part = (role: PartRole, service_id = SRV): PartRef => ({
  orgId: "org_saplinglearn", env: "production", envLabel: "production", branch: "main", key: role === "web" ? "web" : "api", role, settings: { service_id },
});

/** The routes of a healthy web service. */
const webRoutes = (over: Record<string, Route> = {}): Record<string, Route> => ({
  [`/v1/services/${SRV}`]: serviceFx,
  [`/v1/services/${SRV}/deploys`]: deploysFx,
  "/v1/metrics/http-requests": requestsFx,
  "/v1/metrics/http-latency": latencyFx,
  "/v1/metrics/bandwidth": bandwidthFx,
  ...over,
});
const workerRoutes = (over: Record<string, Route> = {}): Record<string, Route> => ({
  [`/v1/services/${WORKER}`]: workerFx,
  [`/v1/services/${WORKER}/deploys`]: [],
  "/v1/metrics/cpu": cpuFx,
  "/v1/metrics/memory": memoryFx,
  ...over,
});
/** One series on the window's three hours, for unit tests. */
const series = (unit: string, values: number[], labels: Record<string, string> = {}) => [{
  labels: Object.entries(labels).map(([field, value]) => ({ field, value })),
  unit,
  values: values.map((value, i) => ({ timestamp: `2026-10-07T${String(9 + i).padStart(2, "0")}:00:00Z`, value })),
}];
const metricOf = (points: { metric: string; at: string; value: number }[], m: string) => points.filter((p) => p.metric === m).map((p) => [p.at, p.value]);
const noLeak = (text: string) => expect(leakedFragments(text, TOKEN)).toEqual([]);

// ── the descriptor ────────────────────────────────────────────────────────────

describe("render: descriptor", () => {
  it("sends the key only to api.render.com, offers only a pasted API key, and says what it can do", () => {
    expect(render.id).toBe("render");
    expect(render.status).toBe("available");
    expect(render.apiHosts).toEqual(["api.render.com"]);
    for (const h of render.apiHosts) expect(h).toMatch(/^[a-z0-9.-]+$/);
    expect(render.credentialScope).toBe("org");
    expect(render.roles).toEqual(["web", "service"]);
    expect(render.install).toBeUndefined();
    expect(render.connectionMethods.map((m) => m.method)).toEqual(["token"]);
    const token = render.connectionMethods[0];
    expect(token.label).toBe("Paste an API key");
    expect(token.howTo).toMatch(/Account Settings › API Keys/);
    expect(token.howTo).toMatch(/NO scopes/);
    expect(token.howTo).toMatch(/EVERY workspace/);
    expect(token.howTo).toMatch(/dedicated member account/);
    expect(token.howTo).toMatch(/api\.render\.com/);
    expect(token.grants.length).toBeGreaterThan(0);
    expect(token.requires).toBeUndefined();
    expect(render.capabilities.deploys).toBe(true);
    expect([...render.capabilities.metrics].sort()).toEqual(["bandwidth_bytes", "cpu", "errors", "latency_p95_ms", "mem_mb", "requests"]);
    for (const m of render.capabilities.metrics) expect(render.roles).toContain(HOSTING_METRICS[m].role);
    expect(render.pollCost).toBe(5);
    expect(render.docsUrl).toMatch(/^https:\/\//);
    expect(render.summary.length).toBeGreaterThan(20);
  });

  it("a part needs a srv- service id; anything else is refused", () => {
    const ok = checkFields(render.partSettings, { service_id: SRV }, "settings");
    expect(ok).toEqual({ values: { service_id: SRV } });
    expect(checkFields(render.partSettings, { service_id: `  ${SRV}  ` }, "settings")).toEqual({ values: { service_id: SRV } });
    for (const bad of ["SRV-D3K8Q1J7MGEC73A1B2C0", "svc-d3k8q1j7mgec73a1b2c0", "srv-short", "srv-d3k8q1j7mgec73a1b2c0/../x", "dep-d3m1a06j7mgec73c0opf", `x${SRV}`]) {
      expect(checkFields(render.partSettings, { service_id: bad }, "settings"), bad).toHaveProperty("message", "Service ID is not in the expected form");
    }
    expect(checkFields(render.partSettings, {}, "settings")).toHaveProperty("message", "Service ID is required");
    expect(checkFields(render.partSettings, { service_id: SRV, project: "x" }, "settings")).toHaveProperty("field", "settings");
  });

  it("the workspace id is optional, and only a tea- / usr- shaped id is accepted", () => {
    expect(checkFields(render.orgConfigFields, {}, "config")).toEqual({ values: {} });
    expect(checkFields(render.orgConfigFields, { owner_id: OWNER }, "config")).toEqual({ values: { owner_id: OWNER } });
    expect(checkFields(render.orgConfigFields, { owner_id: "usr-cn1t5h0l5elc73fk0xyz" }, "config")).toEqual({ values: { owner_id: "usr-cn1t5h0l5elc73fk0xyz" } });
    for (const bad of ["acme", "team-cn1t5h0l5elc73fk0abc", "tea-", "tea-CN1T5H0L5ELC73FK0ABC"]) {
      expect(checkFields(render.orgConfigFields, { owner_id: bad }, "config"), bad).toHaveProperty("message", "Workspace ID is not in the expected form");
    }
  });

  it("links a part to its service in the dashboard, and nothing without a valid id", () => {
    expect(render.consoleUrl({ settings: { service_id: SRV } }, {})).toBe(`https://dashboard.render.com/web/${SRV}`);
    expect(render.consoleUrl({ settings: {} }, {})).toBeNull();
    expect(render.consoleUrl({ settings: { service_id: "not-an-id" } }, {})).toBeNull();
  });
});

// ── probe ─────────────────────────────────────────────────────────────────────

describe("render: probe", () => {
  it("with a part: ONE read of the service, named with its type", async () => {
    const { pc, calls, checkCalls } = harness(webRoutes());
    const r = await render.probe(pc, part("web"));
    expect(r).toEqual({ ok: true, detail: "Render answered for service checkout-api (web service)." });
    expect(calls.map((c) => c.url.pathname)).toEqual([`/v1/services/${SRV}`]);
    checkCalls();
  });

  it("a suspended service still passes, and says so", async () => {
    const { pc } = harness({ [`/v1/services/${SRV}`]: { ...serviceFx, suspended: "suspended", suspenders: ["user"] } });
    const r = await render.probe(pc, part("web"));
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/^Render answered for service checkout-api \(web service\)\. It is SUSPENDED on Render/);
  });

  it("with a Workspace ID set, a service of another workspace fails", async () => {
    const same = harness(webRoutes(), { owner_id: OWNER });
    expect((await render.probe(same.pc, part("web"))).ok).toBe(true);
    const other = harness(webRoutes(), { owner_id: "tea-zz9z9z9z9z9z9z9z9z9z" });
    const r = await render.probe(other.pc, part("web"));
    expect(r).toEqual({ ok: false, detail: "Render answered for service checkout-api, but it belongs to a different workspace than the Workspace ID set here." });
  });

  it("without a part: the key alone (owners?limit=1), or the configured workspace", async () => {
    const plain = harness({ "/v1/owners": ownersFx });
    expect(await render.probe(plain.pc, null)).toEqual({ ok: true, detail: "Render answered: the API key can see workspace Acme." });
    expect(plain.calls).toHaveLength(1);
    expect(plain.calls[0].url.searchParams.get("limit")).toBe("1");
    plain.checkCalls();

    const ws = harness({ [`/v1/owners/${OWNER}`]: ownerFx }, { owner_id: OWNER });
    expect(await render.probe(ws.pc, null)).toEqual({ ok: true, detail: "Render answered for workspace Acme." });
    expect(ws.calls).toHaveLength(1);
    ws.checkCalls();

    const empty = harness({ "/v1/owners": [] });
    expect(await render.probe(empty.pc, null)).toEqual({ ok: true, detail: "Render answered for the API key." });
  });

  it("a 401 fails with the status and a hint, and not one 8-character piece of the key", async () => {
    const { pc } = harness({ [`/v1/services/${SRV}`]: () => echo(401) });
    const r = await render.probe(pc, part("web"));
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/^render service 401: /);
    expect(r.detail).toMatch(/the credential is not valid/);
    noLeak(r.detail);
  });

  it("a 404 says the id may be wrong or out of the key's reach", async () => {
    const { pc } = harness({ [`/v1/services/${SRV}`]: () => json({ id: "not_found", message: "service not found" }, 404) });
    const r = await render.probe(pc, part("web"));
    expect(r).toEqual({ ok: false, status: 404, detail: "render service 404: service not found — not found (check the id, and that the credential can see it)" });
  });

  it("a redirect is never followed, and a thrown fetch is fixed text", async () => {
    const moved = harness({ "/v1/owners": () => new Response(null, { status: 302, headers: { location: `https://evil.example/?k=${TOKEN}` } }) });
    const r = await render.probe(moved.pc, null);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/302.*a redirect is never followed/);
    noLeak(r.detail);

    const thrown = harness({ "/v1/owners": () => { throw new TypeError(`connect failed: Authorization: Bearer ${TOKEN}`); } });
    const t = await render.probe(thrown.pc, null);
    expect(t).toEqual({ ok: false, detail: "render workspaces: the request failed" });
  });

  it("a part without a valid service id never reaches the network", async () => {
    const { pc, calls } = harness({});
    expect(await render.probe(pc, part("web", "nope"))).toEqual({ ok: false, detail: "The part has no Render service ID (srv-…)." });
    expect(calls).toHaveLength(0);
  });
});

// ── poll: deploys ─────────────────────────────────────────────────────────────

describe("render: poll — deploys", () => {
  it("maps every status, newest first, branch and URL from the service; unknown and malformed items are skipped", async () => {
    const { pc, calls, checkCalls } = harness(webRoutes());
    const r = await render.poll(pc, part("web"));
    checkCalls();
    expect(calls[1].url.pathname).toBe(`/v1/services/${SRV}/deploys`);
    expect(calls[1].url.searchParams.get("limit")).toBe("20");
    expect(r.deploys.map((d) => [d.id.slice(-3), d.state])).toEqual([
      ["opa", "queued"], // created
      ["opb", "queued"], // queued
      ["opc", "building"], // build_in_progress
      ["opd", "building"], // update_in_progress
      ["ope", "building"], // pre_deploy_in_progress
      ["opf", "ready"], // live
      ["opg", "error"], // pre_deploy_failed
      ["oph", "error"], // update_failed
      ["opi", "error"], // build_failed
      ["opj", "canceled"], // canceled
      ["opk", "ready"], // deactivated: it was live, then superseded
      ["opl", "ready"], // deactivated, image-backed
    ]);
    const live = r.deploys.find((d) => d.id === "dep-d3m1a06j7mgec73c0opf")!;
    expect(live).toEqual({
      id: "dep-d3m1a06j7mgec73c0opf",
      state: "ready",
      target: "production",
      sha: "4a7c6d5e2f9807361584d97c6b5a493827160594",
      branch: "main",
      message: "Fix checkout totals rounding (#412)",
      by: null,
      createdAt: "2026-10-07T11:40:12.731Z",
      readyAt: "2026-10-07T11:44:50.918Z",
      url: "https://checkout-api.onrender.com",
      inspectUrl: `https://dashboard.render.com/web/${SRV}/deploys/dep-d3m1a06j7mgec73c0opf`,
    });
    // Only the live deploy carries the service's URL; in-flight ones have no readyAt.
    expect(r.deploys.filter((d) => d.url !== null).map((d) => d.id)).toEqual(["dep-d3m1a06j7mgec73c0opf"]);
    expect(r.deploys.find((d) => d.id.endsWith("opc"))).toMatchObject({ readyAt: null, sha: "7dfa09859c2b3a6948170c0fa9e8d7c6b5a49382", message: "Cache tax tables per region" });
    // An image deploy has no commit: its registry digest is not a git SHA.
    expect(r.deploys.find((d) => d.id.endsWith("opl"))).toMatchObject({ sha: null, message: null, branch: "main" });
    for (const d of r.deploys) {
      expect(d.target).toBe("production");
      expect(d.by).toBeNull();
      expect(d.inspectUrl).toMatch(/^https:\/\/dashboard\.render\.com\//);
    }
  });

  it("takes the inspect link from the service's own dashboardUrl, and adds https to a bare URL", async () => {
    const { pc } = harness(webRoutes({
      [`/v1/services/${SRV}`]: { ...serviceFx, dashboardUrl: `https://dashboard.render.com/static/${SRV}/`, serviceDetails: { ...serviceFx.serviceDetails, url: "checkout.acme.example" } },
    }));
    const r = await render.poll(pc, part("web"));
    const live = r.deploys.find((d) => d.state === "ready" && d.url)!;
    expect(live.url).toBe("https://checkout.acme.example");
    expect(live.inspectUrl).toBe(`https://dashboard.render.com/static/${SRV}/deploys/${live.id}`);
  });

  it("a dashboardUrl off dashboard.render.com is not trusted for the link", async () => {
    const { pc } = harness(webRoutes({ [`/v1/services/${SRV}`]: { ...serviceFx, dashboardUrl: "https://evil.example/web/x" } }));
    const r = await render.poll(pc, part("web"));
    for (const d of r.deploys) expect(d.inspectUrl).toBe(`https://dashboard.render.com/web/${SRV}/deploys/${d.id}`);
  });

  it("keeps at most 20, newest first, and a bare (unwrapped) deploy is read too", async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      cursor: `c${i}`,
      deploy: { id: `dep-${String(i).padStart(20, "0")}`, status: "live", createdAt: new Date(Date.parse("2026-10-01T00:00:00Z") + i * 3_600_000).toISOString() },
    }));
    const bare = { id: "dep-bare0000000000000000", status: "queued", createdAt: "2026-10-07T12:15:00Z" };
    const { pc } = harness(webRoutes({ [`/v1/services/${SRV}/deploys`]: [...many, bare] }));
    const r = await render.poll(pc, part("web"));
    expect(r.deploys).toHaveLength(20);
    expect(r.deploys[0].id).toBe("dep-bare0000000000000000");
    const times = r.deploys.map((d) => Date.parse(d.createdAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("a deploy list that is not a list, or a 401 / 403 on it, fails the poll — scrubbed", async () => {
    const notList = harness(webRoutes({ [`/v1/services/${SRV}/deploys`]: { deploys: [] } }));
    await expect(render.poll(notList.pc, part("web"))).rejects.toThrow("render deploys: the response is not a list");
    for (const status of [401, 403]) {
      const { pc } = harness(webRoutes({ [`/v1/services/${SRV}/deploys`]: () => echo(status) }));
      const err = await render.poll(pc, part("web")).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HostingError);
      expect((err as Error).message).toMatch(new RegExp(`^render deploys ${status}: `));
      noLeak((err as Error).message);
    }
  });

  it("a refused service read fails the poll before anything else is asked", async () => {
    const { pc, calls } = harness(webRoutes({ [`/v1/services/${SRV}`]: () => echo(500) }));
    const err = await render.poll(pc, part("web")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostingError);
    expect((err as Error).message).toMatch(/^render service 500: /);
    noLeak((err as Error).message);
    expect(calls).toHaveLength(1);
  });
});

// ── poll: metrics ─────────────────────────────────────────────────────────────

describe("render: poll — web metrics", () => {
  it("requests, 5xx errors, p95 latency and bandwidth for the window's complete hours; 5 fetches", async () => {
    const { pc, calls, checkCalls } = harness(webRoutes());
    const r = await render.poll(pc, part("web"));
    checkCalls();
    expect(calls.length).toBeLessThanOrEqual(render.pollCost);
    expect(calls.map((c) => c.url.pathname)).toEqual([
      `/v1/services/${SRV}`, `/v1/services/${SRV}/deploys`, "/v1/metrics/http-requests", "/v1/metrics/http-latency", "/v1/metrics/bandwidth",
    ]);
    for (const c of calls.slice(2)) {
      expect(c.url.searchParams.get("resource")).toBe(SRV);
      expect(c.url.searchParams.get("startTime")).toBe("2026-10-07T09:00:00Z");
      expect(c.url.searchParams.get("endTime")).toBe("2026-10-07T12:00:00Z");
      expect(c.url.searchParams.get("resolutionSeconds")).toBe("3600");
    }
    expect(calls[2].url.searchParams.get("aggregateBy")).toBe("statusCode");
    expect(calls[3].url.searchParams.get("quantile")).toBe("0.95");

    // 200 + 304 + 404 + 5xx per hour; 08:00 and 12:00 are outside [09:00, 12:00); the bad points are skipped.
    expect(metricOf(r.points, "requests")).toEqual([[H("09"), 1262], [H("10"), 1446], [H("11"), 1575]]);
    // Only the 5xx series (500 + 503). No 5xx at 09:00 → no point: inside `covered`, that hour is a true zero.
    expect(metricOf(r.points, "errors")).toEqual([[H("10"), 3], [H("11"), 5]]);
    expect(metricOf(r.points, "latency_p95_ms")).toEqual([[H("09"), 212.5], [H("10"), 180.3], [H("11"), 240]]);
    // MB → bytes (2^20).
    expect(metricOf(r.points, "bandwidth_bytes")).toEqual([[H("09"), 13_107_200], [H("10"), 20_971_520], [H("11"), 8_650_752]]);
    expect(r.points.some((p) => p.metric === "cpu" || p.metric === "mem_mb")).toBe(false);
    expect(r.unavailable).toEqual([{ metric: "latency_p50_ms", reason: "Trov reads Render's p95 latency only" }]);
    expect(r.covered).toEqual({ from: H("09"), to: H("12") });
    // Every point: an hour start strictly before the current hour, finite, ≥ 0.
    for (const p of r.points) {
      const at = Date.parse(p.at);
      expect(at % 3_600_000).toBe(0);
      expect(at).toBeLessThan(pollWindow(NOW).to + 1);
      expect(at).toBeLessThan(Math.floor(NOW / 3_600_000) * 3_600_000);
      expect(Number.isFinite(p.value) && p.value >= 0).toBe(true);
    }
    // Every web metric is either read or named unavailable.
    const accounted = new Set([...r.points.map((p) => p.metric), ...r.unavailable.map((u) => u.metric)]);
    for (const m of metricsForRole("web")) expect(accounted.has(m), m).toBe(true);
  });

  it("an hour that has not settled is never read: at 12:10 the window is [08:00, 11:00)", async () => {
    const { pc, calls } = harness(webRoutes(), {}, Date.parse("2026-10-07T12:10:00Z"));
    const r = await render.poll(pc, part("web"));
    expect(calls[2].url.searchParams.get("endTime")).toBe("2026-10-07T11:00:00Z");
    expect(metricOf(r.points, "requests")).toEqual([[H("08"), 1500], [H("09"), 1262], [H("10"), 1446]]);
    expect(r.covered).toEqual({ from: H("08"), to: H("11") });
  });

  it("a 4xx on a metrics endpoint costs that metric only, with a reason; covered stays", async () => {
    const { pc } = harness(webRoutes({
      "/v1/metrics/http-requests": () => json({ message: "not supported" }, 404),
      "/v1/metrics/bandwidth": () => echo(403),
    }));
    const r = await render.poll(pc, part("web"));
    expect(r.unavailable).toEqual([
      { metric: "latency_p50_ms", reason: "Trov reads Render's p95 latency only" },
      { metric: "requests", reason: "Render reports no HTTP request metrics for this service type (HTTP 404)" },
      { metric: "errors", reason: "Render reports no HTTP request metrics for this service type (HTTP 404)" },
      { metric: "bandwidth_bytes", reason: "Render refused bandwidth to this API key (HTTP 403)" },
    ]);
    expect(metricOf(r.points, "latency_p95_ms")).toHaveLength(3);
    expect(r.covered).toEqual({ from: H("09"), to: H("12") });
    expect(r.deploys.length).toBeGreaterThan(0);
  });

  it("every metric unavailable → covered is null", async () => {
    const gone = () => json({ message: "no" }, 400);
    const { pc } = harness(webRoutes({ "/v1/metrics/http-requests": gone, "/v1/metrics/http-latency": gone, "/v1/metrics/bandwidth": gone }));
    const r = await render.poll(pc, part("web"));
    expect(r.points).toEqual([]);
    expect(r.covered).toBeNull();
    expect(r.unavailable.map((u) => u.metric).sort()).toEqual(["bandwidth_bytes", "errors", "latency_p50_ms", "latency_p95_ms", "requests"]);
  });

  it("a 401, 429 or 5xx on a metrics endpoint fails the poll, scrubbed", async () => {
    for (const status of [401, 429, 502]) {
      const { pc } = harness(webRoutes({ "/v1/metrics/http-latency": () => echo(status) }));
      const err = await render.poll(pc, part("web")).catch((e: unknown) => e);
      expect(err, String(status)).toBeInstanceOf(HostingError);
      expect((err as Error).message).toMatch(new RegExp(`^render http-latency metrics ${status}: `));
      noLeak((err as Error).message);
    }
  });

  it("a metrics body that is not a list fails the poll; an empty list is zero traffic", async () => {
    const bad = harness(webRoutes({ "/v1/metrics/bandwidth": { series: [] } }));
    await expect(render.poll(bad.pc, part("web"))).rejects.toThrow("render bandwidth metrics: the response is not a list of time series");
    const quiet = harness(webRoutes({ "/v1/metrics/http-requests": [], "/v1/metrics/http-latency": [], "/v1/metrics/bandwidth": [] }));
    const r = await render.poll(quiet.pc, part("web"));
    expect(r.points).toEqual([]);
    expect(r.unavailable.map((u) => u.metric)).toEqual(["latency_p50_ms"]);
    expect(r.covered).toEqual({ from: H("09"), to: H("12") });
  });

  it("a web part on a non-web service asks only for bandwidth; HTTP traffic is unavailable", async () => {
    const { pc, calls } = harness({
      [`/v1/services/${WORKER}`]: workerFx, [`/v1/services/${WORKER}/deploys`]: [], "/v1/metrics/bandwidth": () => json({ message: "unsupported" }, 400),
    });
    const r = await render.poll(pc, part("web", WORKER));
    expect(calls.map((c) => c.url.pathname)).toEqual([`/v1/services/${WORKER}`, `/v1/services/${WORKER}/deploys`, "/v1/metrics/bandwidth"]);
    const reason = "Render reports HTTP requests and latency for web services only; this service is a background worker";
    expect(r.unavailable).toEqual([
      { metric: "latency_p50_ms", reason: "Trov reads Render's p95 latency only" },
      { metric: "requests", reason }, { metric: "errors", reason }, { metric: "latency_p95_ms", reason },
      { metric: "bandwidth_bytes", reason: "Render reports no bandwidth for this service type (HTTP 400)" },
    ]);
    expect(r.covered).toBeNull();
  });

  it("requests answered as a per-second rate are counted over the bucket; seconds → ms; bytes / rates for bandwidth", async () => {
    const { pc } = harness(webRoutes({
      "/v1/metrics/http-requests": [
        ...series("requests/s", [0.5, 2], { statusCode: "200" }),
        ...series("requests/s", [0.01], { statusCode: "503" }),
      ],
      "/v1/metrics/http-latency": series("seconds", [0.2125, 1.5]),
      "/v1/metrics/bandwidth": series("bytes/s", [100, 0]),
    }));
    const r = await render.poll(pc, part("web"));
    expect(metricOf(r.points, "requests")).toEqual([[H("09"), 1836], [H("10"), 7200]]);
    expect(metricOf(r.points, "errors")).toEqual([[H("09"), 36]]);
    expect(metricOf(r.points, "latency_p95_ms")).toEqual([[H("09"), 212.5], [H("10"), 1500]]);
    expect(metricOf(r.points, "bandwidth_bytes")).toEqual([[H("09"), 360_000], [H("10"), 0]]);
  });

  it("sub-hour points are summed into their hour (a step finer than asked for)", async () => {
    const values = [0, 15, 30, 45].map((m) => ({ timestamp: `2026-10-07T10:${String(m).padStart(2, "0")}:00Z`, value: 10 }));
    const { pc } = harness(webRoutes({
      "/v1/metrics/bandwidth": [{ labels: [], unit: "KB", values }],
      "/v1/metrics/http-requests": [{ labels: [{ field: "statusCode", value: "200" }], unit: "req/s", values }],
    }));
    const r = await render.poll(pc, part("web"));
    expect(metricOf(r.points, "bandwidth_bytes")).toEqual([[H("10"), 40 * 1024]]);
    // 10 req/s × 900 s per 15-minute bucket × 4 buckets.
    expect(metricOf(r.points, "requests")).toEqual([[H("10"), 36_000]]);
  });

  it("epoch-second and epoch-millisecond timestamps are read as well as ISO", async () => {
    const t9 = Date.parse(H("09")), t10 = Date.parse(H("10"));
    const { pc } = harness(webRoutes({
      "/v1/metrics/bandwidth": [{ labels: [], unit: "B", values: [{ timestamp: t9 / 1000, value: 5 }, { timestamp: t10, value: 7 }] }],
    }));
    const r = await render.poll(pc, part("web"));
    expect(metricOf(r.points, "bandwidth_bytes")).toEqual([[H("09"), 5], [H("10"), 7]]);
  });

  it("requests not split by status code: requests still counted, errors unknown (never zero)", async () => {
    const { pc } = harness(webRoutes({ "/v1/metrics/http-requests": series("requests", [10, 20, 30]) }));
    const r = await render.poll(pc, part("web"));
    expect(metricOf(r.points, "requests")).toEqual([[H("09"), 10], [H("10"), 20], [H("11"), 30]]);
    expect(metricOf(r.points, "errors")).toEqual([]);
    expect(r.unavailable).toContainEqual({ metric: "errors", reason: "Render did not break the requests down by status code" });
  });

  it("latency for other quantiles only is unavailable, not an empty hour", async () => {
    const { pc } = harness(webRoutes({ "/v1/metrics/http-latency": series("ms", [100, 120], { quantile: "0.99" }) }));
    const r = await render.poll(pc, part("web"));
    expect(metricOf(r.points, "latency_p95_ms")).toEqual([]);
    expect(r.unavailable).toContainEqual({ metric: "latency_p95_ms", reason: "Render answered latency for other quantiles than p95" });
  });

  it("a unit Trov does not know is unavailable, quoting the unit — scrubbed before it is cut", async () => {
    const { pc } = harness(webRoutes({
      "/v1/metrics/bandwidth": series(`furlongs${TOKEN}`, [1]),
      "/v1/metrics/http-latency": series("fortnights", [1]),
    }));
    const r = await render.poll(pc, part("web"));
    const bw = r.unavailable.find((u) => u.metric === "bandwidth_bytes")!;
    expect(bw.reason).toBe("Render reported bandwidth in a unit Trov does not recognise (\"furlongsredacted\")");
    noLeak(bw.reason);
    expect(r.unavailable).toContainEqual({ metric: "latency_p95_ms", reason: "Render reported latency in a unit Trov does not recognise (\"fortnights\")" });
  });
});

describe("render: poll — service metrics", () => {
  it("CPU and memory summed across instances, the latest sample of each hour; 4 fetches", async () => {
    const { pc, calls, checkCalls } = harness(workerRoutes());
    const r = await render.poll(pc, part("service", WORKER));
    checkCalls();
    expect(calls.map((c) => c.url.pathname)).toEqual([`/v1/services/${WORKER}`, `/v1/services/${WORKER}/deploys`, "/v1/metrics/cpu", "/v1/metrics/memory"]);
    expect(calls.length).toBeLessThanOrEqual(render.pollCost);
    for (const c of calls.slice(2)) {
      expect(c.url.searchParams.get("resource")).toBe(WORKER);
      expect(c.url.searchParams.get("resolutionSeconds")).toBe("3600");
      expect(c.url.searchParams.has("aggregationMethod")).toBe(false);
    }
    expect(metricOf(r.points, "cpu")).toEqual([[H("09"), 0.2], [H("10"), 0.3], [H("11"), 0.31]]);
    // bytes → MB; instance A's 10:30 sample is that hour's latest (320 MB + 260 MB).
    expect(metricOf(r.points, "mem_mb")).toEqual([[H("09"), 506], [H("10"), 580], [H("11"), 570]]);
    expect(r.points.some((p) => HOSTING_METRICS[p.metric].role === "web")).toBe(false);
    expect(r.unavailable).toEqual([]);
    expect(r.covered).toEqual({ from: H("09"), to: H("12") });
    expect(r.deploys).toEqual([]);
  });

  it("converts MB / GB memory and millicore CPU; refuses a percentage and an unknown unit", async () => {
    const a = harness(workerRoutes({ "/v1/metrics/memory": series("GB", [0.5, 1.25]), "/v1/metrics/cpu": series("millicores", [250, 1500]) }));
    const ra = await render.poll(a.pc, part("service", WORKER));
    expect(metricOf(ra.points, "mem_mb")).toEqual([[H("09"), 512], [H("10"), 1280]]);
    expect(metricOf(ra.points, "cpu")).toEqual([[H("09"), 0.25], [H("10"), 1.5]]);

    const b = harness(workerRoutes({ "/v1/metrics/memory": series("MB", [300.04]), "/v1/metrics/cpu": series("percent", [40]) }));
    const rb = await render.poll(b.pc, part("service", WORKER));
    expect(metricOf(rb.points, "mem_mb")).toEqual([[H("09"), 300]]);
    expect(rb.unavailable).toEqual([{ metric: "cpu", reason: "Render reported CPU as a percentage of the plan's limit; Trov stores vCPU and does not know the limit" }]);

    const c = harness(workerRoutes({ "/v1/metrics/memory": series("", [1]) }));
    const rc = await render.poll(c.pc, part("service", WORKER));
    expect(rc.unavailable).toEqual([{ metric: "mem_mb", reason: "Render reported memory in a unit Trov does not recognise (\"\")" }]);
    expect(metricOf(rc.points, "cpu")).toHaveLength(3);
  });

  it("an absurd value is dropped, never stored", async () => {
    const { pc } = harness(workerRoutes({ "/v1/metrics/cpu": series("cpu", [0.5, 5000]) }));
    const r = await render.poll(pc, part("service", WORKER));
    expect(metricOf(r.points, "cpu")).toEqual([[H("09"), 0.5]]);
  });

  it("a static site has no CPU or memory: nothing asked, both unavailable, covered null", async () => {
    const { pc, calls } = harness({
      [`/v1/services/${SRV}`]: { ...serviceFx, type: "static_site" }, [`/v1/services/${SRV}/deploys`]: deploysFx,
    });
    const r = await render.poll(pc, part("service"));
    expect(calls).toHaveLength(2);
    expect(r.unavailable).toEqual([
      { metric: "cpu", reason: "Render reports no CPU or memory for a static site" },
      { metric: "mem_mb", reason: "Render reports no CPU or memory for a static site" },
    ]);
    expect(r.covered).toBeNull();
    expect(r.deploys.length).toBeGreaterThan(0);
  });
});

describe("render: the fixed-host fetch", () => {
  it("refuses any URL that is not https on api.render.com before sending anything", async () => {
    const { pc, calls } = harness({});
    for (const url of ["https://dashboard.render.com/web/x", "http://api.render.com/v1/owners", "https://api.render.com.evil.example/v1/owners", `https://u:${TOKEN}@api.render.com/v1/owners`]) {
      const err = await pc.fetch(url).catch((e: unknown) => e);
      expect(err, url).toBeInstanceOf(HostRefusedError);
      noLeak((err as Error).message);
    }
    expect(calls).toHaveLength(0);
  });
});

// The Railway hosting provider: descriptor, the Bearer header, probe, and poll — deployments as deploys, the
// usage metrics and the HTTP metrics as hourly points — against recorded-shape fixtures (fixtures/hosting/railway/).
// Fetch is stubbed BEHIND the real `hostFetch`, so every request also proves the host allowlist holds.
import { describe, expect, it } from "vitest";
import { metricsForRole } from "@shared/hosting";
import { railway } from "../src/hosting/providers/railway";
import { HostRefusedError, HostingError, hostFetch, type SecretLike } from "../src/hosting/http";
import { checkFields } from "../src/hosting/registry";
import type { PartRef, ProviderContext } from "../src/hosting/types";
import { LONG_TOKEN, leakedFragments } from "./helpers/repo";
import deploymentsJson from "../fixtures/hosting/railway/deployments.json";
import metricsServiceJson from "../fixtures/hosting/railway/metrics-service.json";
import metricsWebJson from "../fixtures/hosting/railway/metrics-web.json";
import httpByStatusJson from "../fixtures/hosting/railway/http-by-status.json";
import httpDurationJson from "../fixtures/hosting/railway/http-duration.json";
import probePartJson from "../fixtures/hosting/railway/probe-part.json";
import workspaceJson from "../fixtures/hosting/railway/workspace.json";
import projectsJson from "../fixtures/hosting/railway/projects.json";
import graphqlErrorJson from "../fixtures/hosting/railway/graphql-error.json";

// 2026-10-07 12:20 UTC → the poll window is 09:00–12:00.
const NOW = Date.parse("2026-10-07T12:20:00Z");
const TS = (hh: string): number => Date.parse(`2026-10-07T${hh}:00:00Z`) / 1000;
const TOKEN = `${LONG_TOKEN.slice(0, 8)}-${LONG_TOKEN.slice(8, 12)}-${LONG_TOKEN.slice(12, 16)}-${LONG_TOKEN.slice(16, 20)}-${LONG_TOKEN.slice(20, 32)}`;
const noLeak = (text: string): void => { expect(leakedFragments(text, TOKEN)).toEqual([]); };

const ENV = "b7c1d3e5-f7a9-4b2c-8d4e-6f8a0b2c4d6e";
const SERVICE = "5a7c9e1b-3d5f-4a6c-8e0b-2c4e6a8c0e2d";
const PROJECT = "9e2b4c6d-1a3f-4b5e-8c7d-0f2a4b6c8d1e";

const secret = (value: string): SecretLike => ({ reveal: () => value, toString: () => "[secret]" } as SecretLike);
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const echo = (status: number): Response => json({ errors: [{ message: `token ${TOKEN} is not authorized` }] }, status);

interface Gql { query: string; variables: Record<string, unknown> }
interface Call { url: URL; headers: Headers; method: string; redirect: string | undefined; body: Gql }

/** The root field a query asks for — how the stub routes. */
const ROOTS = ["deployments", "metrics", "httpMetricsGroupedByStatus", "httpDurationMetrics", "serviceInstance", "workspace", "projects"] as const;
type Root = (typeof ROOTS)[number];
const rootOf = (q: string): Root => {
  const m = /\{\s*([A-Za-z]+)\s*[({]/.exec(q.slice(q.indexOf("{")));
  const root = m?.[1];
  if (!root || !(ROOTS as readonly string[]).includes(root)) throw new Error(`unexpected query ${q}`);
  return root as Root;
};

function stubbed(route: (root: Root, body: Gql) => Response | Promise<Response>): { calls: Call[]; fetch: ReturnType<typeof hostFetch> } {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body)) as Gql;
    calls.push({ url, headers: new Headers(init?.headers), method: init?.method ?? "GET", redirect: init?.redirect, body });
    return route(rootOf(body.query), body);
  }) as typeof fetch;
  return { calls, fetch: hostFetch(railway.apiHosts, impl) };
}

const ctx = (f: ReturnType<typeof hostFetch>, opts: { token?: string; config?: Record<string, string> } = {}): ProviderContext => ({
  fetch: f,
  credential: { secret: secret(opts.token ?? TOKEN), config: opts.config ?? {} },
  now: NOW,
});

const SETTINGS = { environment_id: ENV, service_id: SERVICE };
const part = (role: "web" | "service" = "service", settings: Record<string, string> = SETTINGS): PartRef => ({
  orgId: "org_acme", env: "staging", envLabel: "staging", branch: "main", key: role === "web" ? "web" : "api", role, settings,
});

/** The happy path, every root from the fixtures. `over` replaces one. */
function rwApi(over: Partial<Record<Root, (body: Gql) => Response>> = {}) {
  return stubbed((root, body) => {
    const o = over[root]?.(body);
    if (o) return o;
    switch (root) {
      case "deployments": return json(deploymentsJson);
      case "metrics": return json(body.query.includes("NETWORK_TX_GB") ? metricsWebJson : metricsServiceJson);
      case "httpMetricsGroupedByStatus": return json(httpByStatusJson);
      case "httpDurationMetrics": return json(httpDurationJson);
      case "serviceInstance": return json(probePartJson);
      case "workspace": return json(workspaceJson);
      case "projects": return json(projectsJson);
    }
  });
}

/** Every call: the one host and path, a POST of JSON, the Bearer header (never Project-Access-Token). */
function expectWellFormed(calls: Call[]): void {
  for (const c of calls) {
    expect(c.url.toString()).toBe("https://backboard.railway.com/graphql/v2");
    expect(c.method).toBe("POST");
    expect(c.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(c.headers.get("project-access-token")).toBeNull();
    expect(c.headers.get("content-type")).toBe("application/json");
    expect(c.redirect).toBe("manual");
  }
}

describe("railway descriptor", () => {
  it("names its one host, both roles, one org-wide token method and no install", () => {
    expect(railway.id).toBe("railway");
    expect([...railway.apiHosts]).toEqual(["backboard.railway.com"]);
    expect([...railway.roles]).toEqual(["web", "service"]);
    expect(railway.connectionMethods.map((m) => m.method)).toEqual(["token"]);
    const how = railway.connectionMethods[0].howTo;
    expect(how).toContain("Account Settings › Tokens");
    expect(how).toContain("WORKSPACE token");
    expect(how).toContain("a project token does not work");
    expect(how).toContain("only ever sent to backboard.railway.com");
    expect(railway.install).toBeUndefined();
    expect(railway.capabilities.deploys).toBe(true);
    expect([...railway.capabilities.metrics].sort()).toEqual(["bandwidth_bytes", "cpu", "errors", "latency_p50_ms", "latency_p95_ms", "mem_mb", "requests"]);
    const all = [...metricsForRole("web"), ...metricsForRole("service")];
    for (const m of railway.capabilities.metrics) expect(all).toContain(m);
  });

  it("checks its settings: environment and service required, project optional", () => {
    expect(railway.partSettings.map((f) => [f.key, f.required])).toEqual([["environment_id", true], ["service_id", true], ["project_id", false]]);
    expect(checkFields(railway.partSettings, SETTINGS, "settings")).toEqual({ values: SETTINGS });
    expect(checkFields(railway.partSettings, { environment_id: ENV }, "settings")).toHaveProperty("message", "Railway service ID is required");
    for (const bad of ["a b", "x/y", "a".repeat(101), "\"}"]) {
      expect(checkFields(railway.partSettings, { ...SETTINGS, service_id: bad }, "settings")).toHaveProperty("message");
    }
    for (const gone of ["railway_env", "railway_environment_id", "railway_service_id"]) {
      expect(checkFields(railway.partSettings, { ...SETTINGS, [gone]: "x" }, "settings")).toHaveProperty("message");
    }
    expect(railway.orgConfigFields.map((f) => [f.key, f.required])).toEqual([["workspace_id", false]]);
  });

  it("links the service only when the project is known, and the tokens page", () => {
    expect(railway.consoleUrl({ settings: { ...SETTINGS, project_id: PROJECT } }, {}))
      .toBe(`https://railway.com/project/${PROJECT}/service/${SERVICE}?environmentId=${ENV}`);
    expect(railway.consoleUrl({ settings: SETTINGS }, {})).toBeNull();
    expect(railway.consoleUrl({ settings: { ...SETTINGS, project_id: "../x" } }, {})).toBeNull();
    expect(railway.manageUrl?.({}, "token")).toBe("https://railway.com/account/tokens");
    expect(railway.manageUrl?.({}, "install")).toBeNull();
  });

  it("budgets the web worst case: deployments, egress, HTTP by status, HTTP latency", () => {
    expect(railway.pollCost).toBe(4);
  });
});

describe("railway probe", () => {
  it("with a part: one query proves the service in that environment", async () => {
    const { calls, fetch } = rwApi();
    const r = await railway.probe(ctx(fetch), part());
    expect(r).toEqual({ ok: true, detail: "Railway answered for service api in staging." });
    expect(calls).toHaveLength(1);
    expect(calls[0].body.variables).toEqual({ e: ENV, s: SERVICE });
    expect(calls[0].body.query).toContain("serviceInstance(environmentId: $e, serviceId: $s)");
    expect(calls[0].body.query).toContain("environment(id: $e) { name projectId }");
    expectWellFormed(calls);
  });

  it("refuses a part whose environment is in another project than the one set", async () => {
    const { fetch } = rwApi();
    const r = await railway.probe(ctx(fetch), part("service", { ...SETTINGS, project_id: "other-project" }));
    expect(r).toEqual({ ok: false, detail: "Railway answered, but that environment belongs to a different project than the project ID set here." });
    const same = rwApi();
    expect((await railway.probe(ctx(same.fetch), part("service", { ...SETTINGS, project_id: PROJECT }))).ok).toBe(true);
  });

  it("without a part: the workspace when its id is set, else one project", async () => {
    const ws = rwApi();
    expect(await railway.probe(ctx(ws.fetch, { config: { workspace_id: "3c5e7a9b-1d2f-4e6a-8b0c-2d4f6a8c0e1b" } }), null))
      .toEqual({ ok: true, detail: "Railway answered for workspace Acme Labs." });
    expect(ws.calls[0].body.variables).toEqual({ w: "3c5e7a9b-1d2f-4e6a-8b0c-2d4f6a8c0e1b" });
    expectWellFormed(ws.calls);
    const pr = rwApi();
    expect(await railway.probe(ctx(pr.fetch), null)).toEqual({ ok: true, detail: "Railway answered: the token can see the workspace's projects." });
    expect(pr.calls).toHaveLength(1);
    expect(pr.calls[0].body.query).toContain("projects(first: 1)");
    const empty = rwApi({ projects: () => json({ data: { projects: { edges: [] } } }) });
    expect(await railway.probe(ctx(empty.fetch), null)).toEqual({ ok: true, detail: "Railway answered, but the token sees no project." });
  });

  it("a 401 keeps its status, is scrubbed, and says the token is not valid", async () => {
    const { fetch } = rwApi({ serviceInstance: () => echo(401) });
    const r = await railway.probe(ctx(fetch), part());
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
    expect(r.detail).toMatch(/^railway service 401: token \[redacted\] is not authorized — the token is not valid/);
    noLeak(r.detail);
  });

  it("a GraphQL refusal beside a 200 fails the test, scrubbed", async () => {
    const { fetch } = rwApi({ serviceInstance: () => json({ data: null, errors: [{ message: `Not Authorized (${TOKEN})` }] }) });
    const r = await railway.probe(ctx(fetch), part());
    expect(r).toEqual({ ok: false, detail: "railway service: Not Authorized ([redacted])" });
  });

  it("refuses a broken token or a missing id before any request", async () => {
    const { calls, fetch } = rwApi();
    for (const bad of ["", "  ", `${TOKEN} x`, `${TOKEN}\u0000`]) {
      expect(await railway.probe(ctx(fetch, { token: bad }), part())).toEqual({
        ok: false, detail: "the Railway token is not in the expected form — paste the token itself, without quotes or spaces",
      });
    }
    expect(await railway.probe(ctx(fetch), part("service", { service_id: SERVICE }))).toEqual({
      ok: false, detail: "the part's Railway environment ID is not set or not in the expected form",
    });
    expect(calls).toHaveLength(0);
  });

  it("drops a pasted Bearer scheme", async () => {
    const { calls, fetch } = rwApi();
    await railway.probe(ctx(fetch, { token: ` bearer ${TOKEN} ` }), part());
    expectWellFormed(calls);
  });
});

describe("railway poll — deploys", () => {
  it("maps every status and the commit meta, newest first", async () => {
    const { calls, fetch } = rwApi();
    const r = await railway.poll(ctx(fetch), part());
    expect(calls[0].body.variables).toEqual({ e: ENV, s: SERVICE, first: 20 });
    expect(calls[0].body.query).toContain("deployments(first: $first, input: { environmentId: $e, serviceId: $s })");
    const inspect = (id: string): string => `https://railway.com/project/${PROJECT}/service/${SERVICE}?environmentId=${ENV}&id=${id}`;
    expect(r.deploys).toEqual([
      {
        id: "4f1c2a7e-8b3d-4e19-a6c0-2d5f7b9e1a34", state: "building", target: "production",
        sha: "a3f9c2e81b7d4c05e6f1a2b3c4d5e6f708192a3b", branch: "main", message: "Add the pricing page", by: "dana",
        createdAt: "2026-10-07T11:58:12.000Z", readyAt: null, url: null, inspectUrl: inspect("4f1c2a7e-8b3d-4e19-a6c0-2d5f7b9e1a34"),
      },
      {
        id: "7b9d1e3f-2c4a-4f6b-9d8e-1a3c5e7f9b20", state: "ready", target: "production",
        sha: "5d8e2f1a9c3b7e40d6a1f2b3c4d5e6f7a8b9c0d1", branch: "main", message: "Fix the login redirect", by: "omar",
        createdAt: "2026-10-06T16:40:03.000Z", readyAt: "2026-10-06T16:42:10.000Z", url: "https://myapp-staging.up.railway.app",
        inspectUrl: inspect("7b9d1e3f-2c4a-4f6b-9d8e-1a3c5e7f9b20"),
      },
      {
        id: "2a4c6e8f-0b1d-4a3c-8e5f-7a9b1c3d5e60", state: "error", target: "production",
        sha: "c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0", branch: "feat/queue", message: "Queue worker", by: "dana",
        createdAt: "2026-10-06T10:05:44.000Z", readyAt: "2026-10-06T10:09:01.000Z", url: null, inspectUrl: inspect("2a4c6e8f-0b1d-4a3c-8e5f-7a9b1c3d5e60"),
      },
      {
        id: "8e0a2c4e-6f1b-4d3a-9c5e-3b7d9f1a2c40", state: "ready", target: "production",
        sha: null, branch: null, message: null, by: null,
        createdAt: "2026-10-05T09:12:44.000Z", readyAt: null, url: null, inspectUrl: inspect("8e0a2c4e-6f1b-4d3a-9c5e-3b7d9f1a2c40"),
      },
      {
        id: "1f3e5d7c-9b2a-4c4e-8f6d-5a7c9e1b3d50", state: "canceled", target: "production",
        sha: null, branch: null, message: null, by: null,
        createdAt: "2026-10-05T08:00:00.000Z", readyAt: null, url: null, inspectUrl: inspect("1f3e5d7c-9b2a-4c4e-8f6d-5a7c9e1b3d50"),
      },
    ]);
  });

  it("maps the whole status enum, and skips what it cannot place, never guessing", async () => {
    const node = (id: string, status: unknown, extra: Record<string, unknown> = {}) => ({ node: { id, status, createdAt: "2026-10-07T08:00:00Z", ...extra } });
    const edges = [
      node("q1", "QUEUED"), node("q2", "WAITING"), node("q3", "INITIALIZING"), node("q4", "NEEDS_APPROVAL"),
      node("b1", "BUILDING"), node("b2", "DEPLOYING"),
      node("r1", "SUCCESS", { url: "http://insecure.example", staticUrl: null }), node("r2", "SLEEPING", { staticUrl: "https://sleepy.up.railway.app/" }),
      node("r3", "REMOVING"), node("e1", "FAILED"), node("c1", "SKIPPED"),
      node("x1", "TELEPORTED"), node("x2", null), node("bad id", "SUCCESS"), { node: { id: "x3", status: "SUCCESS" } },
      node("m1", "SUCCESS", { meta: { commitHash: "not-a-sha", branch: "a\u0000b", commitMessage: `leak ${TOKEN}`, commitAuthor: 7 } }),
      node("q1", "SUCCESS"), // a duplicate id
      "junk", null, { node: null },
    ];
    const { fetch } = rwApi({ deployments: () => json({ data: { deployments: { edges } } }) });
    const r = await railway.poll(ctx(fetch), part());
    expect(Object.fromEntries(r.deploys.map((d) => [d.id, d.state]))).toEqual({
      q1: "queued", q2: "queued", q3: "queued", q4: "queued", b1: "building", b2: "building",
      r1: "ready", r2: "ready", r3: "ready", e1: "error", c1: "canceled", m1: "ready",
    });
    const byId = new Map(r.deploys.map((d) => [d.id, d]));
    expect(byId.get("r1")?.url).toBeNull(); // http is never a link
    expect(byId.get("r2")?.url).toBe("https://sleepy.up.railway.app");
    expect(byId.get("r1")?.inspectUrl).toBeNull(); // no project id anywhere
    expect(byId.get("m1")).toMatchObject({ sha: null, branch: null, message: "leak [redacted]", by: null });
    noLeak(JSON.stringify(r.deploys));
  });

  it("refuses a body with no deployments list; a GraphQL refusal fails the poll, scrubbed", async () => {
    const none = rwApi({ deployments: () => json({ data: { deployments: null } }) });
    await expect(railway.poll(ctx(none.fetch), part())).rejects.toThrow("railway deployments: the response has no deployments list");
    const refused = rwApi({ deployments: () => json(graphqlErrorJson) });
    await expect(railway.poll(ctx(refused.fetch), part())).rejects.toThrow("railway deployments: Not Authorized");
  });

  it("any refusal throws a scrubbed HostingError carrying its status", async () => {
    for (const status of [400, 401, 403, 429, 500]) {
      const { fetch } = rwApi({ deployments: () => echo(status) });
      const e = await railway.poll(ctx(fetch), part()).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(HostingError);
      expect((e as HostingError).status).toBe(status);
      expect((e as Error).message).toContain(`railway deployments ${status}`);
      noLeak((e as Error).message);
    }
  });

  it("a redirect is never followed", async () => {
    const { calls, fetch } = rwApi({ deployments: () => new Response(null, { status: 302, headers: { location: "https://evil.example/x" } }) });
    await expect(railway.poll(ctx(fetch), part())).rejects.toThrow("railway deployments 302 — a redirect is never followed");
    expect(calls).toHaveLength(1);
  });
});

describe("railway poll — metrics", () => {
  it("a service part: CPU and memory from one metrics query over the window", async () => {
    const { calls, fetch } = rwApi();
    const r = await railway.poll(ctx(fetch), part("service"));
    expect(calls).toHaveLength(2);
    expectWellFormed(calls);
    const m = calls[1].body;
    expect(m.variables).toEqual({ e: ENV, s: SERVICE, start: "2026-10-07T09:00:00.000Z", end: "2026-10-07T12:00:00.000Z" });
    expect(m.query).toContain("metrics(environmentId: $e, serviceId: $s, startDate: $start, endDate: $end, measurements: [CPU_USAGE, MEMORY_USAGE_GB], sampleRateSeconds: 3600)");
    expect(m.query).toContain("measurement values { ts value }");
    expect(r.points.map((p) => [p.metric, p.at.slice(11, 16), p.value])).toEqual([
      ["cpu", "09:00", 0.0731], ["cpu", "10:00", 0.0812], ["cpu", "11:00", 0.0694],
      ["mem_mb", "09:00", 212.4], ["mem_mb", "10:00", 219], ["mem_mb", "11:00", 215.8],
    ]);
    expect(r.unavailable).toEqual([]);
    expect(r.covered).toEqual({ from: "2026-10-07T09:00:00.000Z", to: "2026-10-07T12:00:00.000Z" });
  });

  it("a web part: egress, then requests / errors / latency from the HTTP metrics", async () => {
    const { calls, fetch } = rwApi();
    const r = await railway.poll(ctx(fetch), part("web"));
    expect(calls).toHaveLength(4);
    expect(calls.length).toBeLessThanOrEqual(railway.pollCost);
    expectWellFormed(calls);
    expect(calls[1].body.query).toContain("measurements: [NETWORK_TX_GB], sampleRateSeconds: 3600");
    expect(calls[2].body.query).toContain("httpMetricsGroupedByStatus(environmentId: $e, serviceId: $s, startDate: $start, endDate: $end, stepSeconds: 3600)");
    expect(calls[2].body.query).toContain("statusCode samples { ts value }");
    expect(calls[3].body.query).toContain("httpDurationMetrics(environmentId: $e, serviceId: $s, startDate: $start, endDate: $end, stepSeconds: 3600)");
    for (const c of calls.slice(1)) expect(c.body.variables).toEqual({ e: ENV, s: SERVICE, start: "2026-10-07T09:00:00.000Z", end: "2026-10-07T12:00:00.000Z" });
    expect(r.points.map((p) => [p.metric, p.at.slice(11, 16), p.value])).toEqual([
      ["requests", "09:00", 1523], ["requests", "10:00", 1610], ["requests", "11:00", 1499],
      // 09:00 and 11:00 had requests and no 5xx group: measured zeros.
      ["errors", "09:00", 0], ["errors", "10:00", 3], ["errors", "11:00", 0],
      ["latency_p50_ms", "09:00", 41.2], ["latency_p50_ms", "10:00", 44.9], ["latency_p50_ms", "11:00", 39.6],
      ["latency_p95_ms", "09:00", 184.3], ["latency_p95_ms", "10:00", 212.9], ["latency_p95_ms", "11:00", 197.5],
      ["bandwidth_bytes", "09:00", 48211008], ["bandwidth_bytes", "10:00", 51217485], ["bandwidth_bytes", "11:00", 47029892],
    ]);
    expect(r.unavailable).toEqual([]);
    expect(r.covered).toEqual({ from: "2026-10-07T09:00:00.000Z", to: "2026-10-07T12:00:00.000Z" });
    for (const p of r.points) expect(Date.parse(p.at)).toBeLessThan(Date.parse("2026-10-07T12:00:00Z"));
  });

  it("a refused HTTP read costs only its metrics; a 401 or 429 there still fails the poll", async () => {
    const soft = rwApi({
      httpMetricsGroupedByStatus: () => json({ data: null, errors: [{ message: `Problem processing request for ${TOKEN}` }] }),
      httpDurationMetrics: () => json({ errors: [{ message: "Cannot query field" }] }, 400),
    });
    const r = await railway.poll(ctx(soft.fetch), part("web"));
    expect(r.points.map((p) => p.metric)).toEqual(["bandwidth_bytes", "bandwidth_bytes", "bandwidth_bytes"]);
    expect(r.unavailable).toEqual([
      { metric: "requests", reason: "Railway did not answer HTTP metrics for this service: Problem processing request for [redacted]" },
      { metric: "errors", reason: "Railway did not answer HTTP metrics for this service: Problem processing request for [redacted]" },
      { metric: "latency_p50_ms", reason: "Railway did not answer HTTP metrics for this service: Railway refused it (HTTP 400)" },
      { metric: "latency_p95_ms", reason: "Railway did not answer HTTP metrics for this service: Railway refused it (HTTP 400)" },
    ]);
    expect(r.covered).toEqual({ from: "2026-10-07T09:00:00.000Z", to: "2026-10-07T12:00:00.000Z" });
    for (const status of [401, 429, 500]) {
      const hard = rwApi({ httpDurationMetrics: () => echo(status) });
      const e = await railway.poll(ctx(hard.fetch), part("web")).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(HostingError);
      expect((e as Error).message).toContain(`railway http latency ${status}`);
      noLeak((e as Error).message);
    }
  });

  it("stores a latency only for an hour that had requests", async () => {
    const { fetch } = rwApi({
      httpMetricsGroupedByStatus: () => json({ data: { httpMetricsGroupedByStatus: [{ statusCode: 200, samples: [{ ts: TS("10"), value: 5 }] }] } }),
      httpDurationMetrics: () => json({ data: { httpDurationMetrics: { samples: [
        { ts: TS("09"), p50: 0, p95: 0 }, { ts: TS("10"), p50: 12, p95: 80 }, { ts: TS("11"), p50: 30, p95: 90 },
      ] } } }),
    });
    const r = await railway.poll(ctx(fetch), part("web"));
    expect(r.points.filter((p) => p.metric.startsWith("latency")).map((p) => [p.metric, p.at.slice(11, 16), p.value])).toEqual([
      ["latency_p50_ms", "10:00", 12], ["latency_p95_ms", "10:00", 80],
    ]);
  });

  it("drops samples outside the window or malformed, one by one; the latest of an hour wins for a gauge", async () => {
    const values = [
      { ts: TS("08"), value: 1 },             // before the window
      { ts: TS("09"), value: 0.5 },
      { ts: TS("09") + 1800, value: 0.25 },   // later in the same hour → wins
      { ts: TS("10"), value: -1 }, { ts: TS("10"), value: "0.3" }, { ts: TS("10"), value: 2000 }, // malformed / implausible
      { ts: "x", value: 0.1 }, { ts: 0, value: 0.1 },
      { ts: TS("11") * 1000, value: 0.75 },  // milliseconds
      { ts: TS("12"), value: 0.9 },          // the running hour
      "junk", null,
    ];
    const { fetch } = rwApi({ metrics: () => json({ data: { metrics: [
      { measurement: "CPU_USAGE", values }, { measurement: "NETWORK_TX_GB", values }, { measurement: "MEMORY_USAGE_GB", values: "nope" }, "junk",
    ] } }) });
    const r = await railway.poll(ctx(fetch), part("service"));
    // NETWORK_TX_GB was not asked of a service part: ignored.
    expect(r.points.map((p) => [p.metric, p.at.slice(11, 16), p.value])).toEqual([["cpu", "09:00", 0.25], ["cpu", "11:00", 0.75]]);
  });

  it("a metrics refusal, or a body with no metrics list, fails the poll", async () => {
    const refused = rwApi({ metrics: () => json(graphqlErrorJson) });
    await expect(railway.poll(ctx(refused.fetch), part("service"))).rejects.toThrow("railway metrics: Not Authorized");
    const none = rwApi({ metrics: () => json({ data: {} }) });
    await expect(railway.poll(ctx(none.fetch), part("service"))).rejects.toThrow("railway metrics: no metrics in the response");
    const html = rwApi({ metrics: () => new Response("<html>bad gateway</html>", { status: 200 }) });
    await expect(railway.poll(ctx(html.fetch), part("service"))).rejects.toThrow("railway metrics: the response is not JSON");
  });

  it("re-checks the ids itself — nothing unvalidated reaches a query", async () => {
    for (const settings of [{ ...SETTINGS, service_id: "\"} }" }, { ...SETTINGS, environment_id: "" }, {}]) {
      const { calls, fetch } = rwApi();
      await expect(railway.poll(ctx(fetch), part("service", settings))).rejects.toThrow(/the part's Railway (environment|service) ID is not set/);
      expect(calls).toHaveLength(0);
    }
  });

  it("the credential never goes anywhere but backboard.railway.com", async () => {
    const sent: string[] = [];
    const f = hostFetch(railway.apiHosts, (async (u: RequestInfo | URL) => { sent.push(String(u)); return json({}); }) as typeof fetch);
    for (const url of ["https://railway.com/graphql", "https://backboard.railway.app/graphql/v2", "http://backboard.railway.com/graphql/v2"]) {
      await expect(f(url, { headers: { authorization: `Bearer ${TOKEN}` } })).rejects.toBeInstanceOf(HostRefusedError);
    }
    expect(sent).toEqual([]);
  });
});

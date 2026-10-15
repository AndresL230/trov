// The Cloudflare Workers hosting provider: descriptor, probe, and poll — the Workers Deployments API as deploys
// and the GraphQL Analytics API as hourly points — against recorded-shape fixtures (fixtures/hosting/cloudflare/).
// Fetch is stubbed BEHIND the real `hostFetch`, so every request also proves the host allowlist holds.
import { describe, expect, it } from "vitest";
import { metricsForRole } from "@shared/hosting";
import { cloudflare } from "../src/hosting/providers/cloudflare";
import { HostRefusedError, HostingError, hostFetch, type SecretLike } from "../src/hosting/http";
import { checkFields } from "../src/hosting/registry";
import type { PartRef, ProviderContext } from "../src/hosting/types";
import { LONG_TOKEN, leakedFragments } from "./helpers/repo";
import deploymentsJson from "../fixtures/hosting/cloudflare/deployments.json";
import analyticsJson from "../fixtures/hosting/cloudflare/analytics.json";
import noAccountJson from "../fixtures/hosting/cloudflare/analytics-no-account.json";
import analyticsErrorJson from "../fixtures/hosting/cloudflare/analytics-error.json";
import accountJson from "../fixtures/hosting/cloudflare/account.json";
import notFoundJson from "../fixtures/hosting/cloudflare/script-not-found.json";
import buildsJson from "../fixtures/hosting/cloudflare/builds.json";
import scheduledJson from "../fixtures/hosting/cloudflare/scheduled.json";
import runtimeJson from "../fixtures/hosting/cloudflare/runtime.json";
import d1Json from "../fixtures/hosting/cloudflare/d1.json";
import { COMMIT_NEEDS_CI_READ, COMMIT_UNREAD, NO_D1_DATABASE } from "../src/hosting/providers/cloudflare";

// 2026-10-07 12:20 UTC → the poll window is 09:00–12:00.
const NOW = Date.parse("2026-10-07T12:20:00Z");
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TOKEN = LONG_TOKEN.slice(0, 40);
const noLeak = (text: string): void => {
  expect(leakedFragments(text, TOKEN)).toEqual([]);
};

const secret = (value: string): SecretLike => ({ reveal: () => value, toString: () => "[secret]" } as SecretLike);
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** A refusal that quotes the request's credential back — the scrub must catch it. */
const echo = (status: number): Response =>
  json({ success: false, errors: [{ code: 10000, message: `Authentication error for ${TOKEN} on account ${ACCOUNT}` }] }, status);

interface Call { url: URL; headers: Headers; method: string; redirect: string | undefined; body: Record<string, unknown> | null }

function stubbed(route: (u: URL, body: Record<string, unknown> | null) => Response | Promise<Response>): { calls: Call[]; fetch: ReturnType<typeof hostFetch> } {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ url, headers: new Headers(init?.headers), method: init?.method ?? "GET", redirect: init?.redirect, body });
    return route(url, body);
  }) as typeof fetch;
  return { calls, fetch: hostFetch(cloudflare.apiHosts, impl) };
}

const ctx = (f: ReturnType<typeof hostFetch>, opts: { token?: string; config?: Record<string, string>; now?: number; daily?: string | null } = {}): ProviderContext => ({
  fetch: f,
  credential: { secret: secret(opts.token ?? TOKEN), config: opts.config ?? { account_id: ACCOUNT } },
  now: opts.now ?? NOW,
  ...(opts.daily !== undefined ? { daily: opts.daily } : {}),
});

const part = (settings: Record<string, string> = { worker: "frontend-staging" }): PartRef => ({
  orgId: "org_acme", env: "staging", envLabel: "staging", branch: "main", key: "web", role: "web", settings,
});

const DEPLOYMENTS_PATH = `/client/v4/accounts/${ACCOUNT}/workers/scripts/frontend-staging/deployments`;

/** Which GraphQL query a body is: the hourly analytics, the cron runs, the day's quantiles, or D1. */
const queryKind = (body: Record<string, unknown> | null): "analytics" | "scheduled" | "runtime" | "d1" => {
  const q = String(body?.query ?? "");
  return q.includes("workersInvocationsScheduled") ? "scheduled" : q.includes("quantiles") ? "runtime" : q.includes("d1AnalyticsAdaptiveGroups") ? "d1" : "analytics";
};

/** The happy path, every route from the fixtures. `over` replaces one (`graphql` replaces the hourly analytics
 *  query and the probe's; `scheduled` / `runtime` / `d1` the Phase G queries). */
function cfApi(over: {
  deployments?: () => Response; graphql?: (body: Record<string, unknown> | null) => Response; account?: () => Response; builds?: (u: URL) => Response;
  scheduled?: () => Response; runtime?: () => Response; d1?: (body: Record<string, unknown> | null) => Response;
} = {}) {
  return stubbed((u, body) => {
    if (u.pathname === DEPLOYMENTS_PATH) return over.deployments?.() ?? json(deploymentsJson);
    if (u.pathname === `/client/v4/accounts/${ACCOUNT}/builds/builds`) return over.builds?.(u) ?? json(buildsJson);
    if (u.pathname === "/client/v4/graphql") {
      const kind = queryKind(body);
      if (kind === "scheduled") return over.scheduled?.() ?? json(scheduledJson);
      if (kind === "runtime") return over.runtime?.() ?? json(runtimeJson);
      if (kind === "d1") return over.d1?.(body) ?? json(d1Json);
      return over.graphql?.(body) ?? json(analyticsJson);
    }
    if (u.pathname === `/client/v4/accounts/${ACCOUNT}`) return over.account?.() ?? json(accountJson);
    throw new Error(`unexpected request ${u}`);
  });
}

/** Every call: the one host, https, the Bearer header, no redirect followed. */
function expectWellFormed(calls: Call[]): void {
  for (const c of calls) {
    expect(c.url.hostname).toBe("api.cloudflare.com");
    expect(c.url.protocol).toBe("https:");
    expect(c.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(c.headers.get("user-agent")).toBe("trov-hosting");
    expect(c.redirect).toBe("manual");
  }
}

describe("cloudflare descriptor", () => {
  it("names its one host, the web role, one token method and no install", () => {
    expect(cloudflare.id).toBe("cloudflare");
    expect(cloudflare.label).toBe("Cloudflare Workers");
    expect(cloudflare.status).toBe("available");
    expect([...cloudflare.apiHosts]).toEqual(["api.cloudflare.com"]);
    expect([...cloudflare.roles]).toEqual(["web"]);
    expect(cloudflare.connectionMethods.map((m) => m.method)).toEqual(["token"]);
    const how = cloudflare.connectionMethods[0].howTo;
    expect(how).toContain("Account › Account Analytics › Read");
    expect(how).toContain("Account › Workers Scripts › Read");
    expect(how).toContain("only ever sent to api.cloudflare.com");
    expect(how).toContain("Account › Workers CI › Read");
    expect(cloudflare.connectionMethods[0].grants).toEqual([
      "Account Analytics: Read on one account", "Workers Scripts: Read on that account (its Workers' deployments)",
      "Optional — Workers CI: Read (the commit each deploy was built from)",
    ]);
    expect(cloudflare.install).toBeUndefined();
    expect(cloudflare.capabilities).toEqual({ deploys: true, metrics: ["requests", "errors"], families: ["outcomes", "runtime", "storage", "schedules"] });
    for (const m of cloudflare.capabilities.metrics) expect(metricsForRole("web")).toContain(m);
  });

  it("has the Worker name as its one required part setting, the optional D1 ids and crons, and one org field, the account id", () => {
    expect(cloudflare.partSettings.map((f) => f.key)).toEqual(["worker", "d1_database_ids", "crons"]);
    expect(cloudflare.partSettings.filter((f) => f.required).map((f) => f.key)).toEqual(["worker"]);
    const D1 = "6c71838c-18f7-4f68-8513-b58e86c237b9";
    const two = `${D1}, ${D1.replace("6c", "7d")}`;
    expect(checkFields(cloudflare.partSettings, { worker: "trov", d1_database_ids: two, crons: "*/10 * * * *;0 * * * SUN,MON" }, "settings"))
      .toEqual({ values: { worker: "trov", d1_database_ids: two, crons: "*/10 * * * *;0 * * * SUN,MON" } });
    for (const bad of ["trov", `${D1};${D1}`, Array.from({ length: 6 }, () => D1).join(",")]) {
      expect(checkFields(cloudflare.partSettings, { worker: "trov", d1_database_ids: bad }, "settings")).toHaveProperty("message");
    }
    expect(checkFields(cloudflare.partSettings, { worker: "trov", crons: "rm -rf $HOME" }, "settings")).toHaveProperty("message");
    expect(checkFields(cloudflare.partSettings, { worker: "frontend-staging" }, "settings")).toEqual({ values: { worker: "frontend-staging" } });
    for (const bad of ["front end", "a".repeat(64), "../x", "x\"y"]) expect(checkFields(cloudflare.partSettings, { worker: bad }, "settings")).toHaveProperty("message");
    expect(checkFields(cloudflare.partSettings, { worker_check: "Workers Builds: x" }, "settings")).toHaveProperty("message");
    expect(cloudflare.orgConfigFields.map((f) => f.key)).toEqual(["account_id"]);
    expect(checkFields(cloudflare.orgConfigFields, { account_id: ACCOUNT }, "config")).toEqual({ values: { account_id: ACCOUNT } });
    expect(checkFields(cloudflare.orgConfigFields, { account_id: "acme" }, "config")).toHaveProperty("message");
  });

  it("links the Worker and the token page", () => {
    expect(cloudflare.consoleUrl({ settings: { worker: "frontend-staging" } }, { account_id: ACCOUNT }))
      .toBe(`https://dash.cloudflare.com/${ACCOUNT}/workers/services/view/frontend-staging/production`);
    expect(cloudflare.consoleUrl({ settings: { worker: "frontend-staging" } }, {})).toBeNull();
    expect(cloudflare.consoleUrl({ settings: { worker: "bad name" } }, { account_id: ACCOUNT })).toBeNull();
    expect(cloudflare.manageUrl?.({}, "token")).toBe("https://dash.cloudflare.com/profile/api-tokens");
    expect(cloudflare.manageUrl?.({}, "oauth")).toBeNull();
  });

  it("budgets six fetches a poll: deployments, the newest deployment's build, analytics, cron runs, and once a day the quantiles and D1", () => {
    expect(cloudflare.pollCost).toBe(6);
  });
});

describe("cloudflare probe", () => {
  it("without a part: the account read, then one account-wide analytics query", async () => {
    const { calls, fetch } = cfApi();
    const r = await cloudflare.probe(ctx(fetch), null);
    expect(r).toEqual({ ok: true, detail: "Cloudflare answered for account Acme Labs." });
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([`GET /client/v4/accounts/${ACCOUNT}`, "POST /client/v4/graphql"]);
    expect(calls[1].body?.variables).toEqual({ a: ACCOUNT, from: "2026-10-07T11:00:00.000Z", to: "2026-10-07T12:00:00.000Z" });
    expect(String(calls[1].body?.query)).toContain("workersInvocationsAdaptive(limit: 1");
    expect(String(calls[1].body?.query)).not.toContain("scriptName");
    expectWellFormed(calls);
  });

  it("with a part: the Worker's deployments, then its analytics over the last settled hour", async () => {
    const { calls, fetch } = cfApi();
    const r = await cloudflare.probe(ctx(fetch), part());
    expect(r).toEqual({ ok: true, detail: "Cloudflare answered for Worker frontend-staging." });
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([`GET ${DEPLOYMENTS_PATH}`, "POST /client/v4/graphql"]);
    expect(calls[1].body?.variables).toEqual({ a: ACCOUNT, s: "frontend-staging", from: "2026-10-07T11:00:00.000Z", to: "2026-10-07T12:00:00.000Z" });
    expectWellFormed(calls);
  });

  it("a Worker with no deployments yet still passes, and says so", async () => {
    const { fetch } = cfApi({ deployments: () => json({ success: true, errors: [], result: { deployments: [] } }) });
    expect(await cloudflare.probe(ctx(fetch), part())).toEqual({ ok: true, detail: "Cloudflare answered for Worker frontend-staging (no deployments yet)." });
  });

  it("a 401 keeps its status, is scrubbed, and says the token is not valid", async () => {
    const { fetch } = cfApi({ account: () => echo(401) });
    const r = await cloudflare.probe(ctx(fetch), null);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
    expect(r.detail).toMatch(/^cloudflare account 401: Authentication error for \[redacted\] on account \[redacted\] — the token is not valid/);
    noLeak(r.detail);
  });

  it("a 403 names the missing permission; a 404 an unknown Worker", async () => {
    const forbidden = cfApi({ deployments: () => echo(403) });
    const r = await cloudflare.probe(ctx(forbidden.fetch), part());
    expect(r).toMatchObject({ ok: false, status: 403 });
    expect(r.detail).toContain("the token lacks Workers Scripts: Read on this account");
    noLeak(r.detail);
    const missing = cfApi({ deployments: () => json(notFoundJson, 404) });
    expect(await cloudflare.probe(ctx(missing.fetch), part())).toEqual({
      ok: false, status: 404,
      detail: "cloudflare deployments 404: This Worker does not exist on your account. — no Worker by that name on this account (check the Worker name and the Account ID)",
    });
  });

  it("an analytics answer naming no account fails the test, never reads as quiet", async () => {
    const { fetch } = cfApi({ graphql: () => json(noAccountJson) });
    const r = await cloudflare.probe(ctx(fetch), part());
    expect(r).toEqual({ ok: false, detail: "cloudflare analytics: Cloudflare answered for no account — check the Account ID, and that the token has Account Analytics: Read on it" });
  });

  it("refuses a missing account id or a broken token before any request", async () => {
    const none = cfApi();
    expect(await cloudflare.probe(ctx(none.fetch, { config: {} }), null)).toEqual({ ok: false, detail: "the Cloudflare Account ID is not set — Workers & Pages › Overview shows it" });
    for (const bad of ["", "  ", `${TOKEN.slice(0, 20)} ${TOKEN.slice(20)}`, `"${TOKEN}`.replace("\"", "\u0000")]) {
      const r = await cloudflare.probe(ctx(none.fetch, { token: bad }), null);
      expect(r).toEqual({ ok: false, detail: "the Cloudflare API token is not in the expected form — paste the token itself, without quotes or spaces" });
    }
    expect(none.calls).toHaveLength(0);
  });

  it("drops a pasted Bearer scheme", async () => {
    const { calls, fetch } = cfApi();
    await cloudflare.probe(ctx(fetch, { token: `  Bearer ${TOKEN}\n` }), null);
    expectWellFormed(calls);
  });
});

describe("cloudflare poll — deploys", () => {
  it("maps every deployment, newest first, as ready", async () => {
    const { fetch } = cfApi();
    const r = await cloudflare.poll(ctx(fetch), part());
    const inspect = `https://dash.cloudflare.com/${ACCOUNT}/workers/services/view/frontend-staging/production/deployments`;
    expect(r.deploys).toEqual([
      {
        // The newest deployment's commit and branch come from the Workers Builds API (its version's build).
        id: "bcf48806-b317-4351-9ee7-36e7d557d4de", state: "ready", target: "production", sha: "6c965ac5f99429b7af6fa244ad577e3557211071", branch: "main",
        message: "Ship the pricing page", by: "dana@acme-labs.dev", createdAt: "2026-10-07T11:41:09.522Z", readyAt: null,
        url: null, inspectUrl: inspect,
      },
      {
        id: "18f97339-c287-4872-9bdd-e2135c07ec12", state: "ready", target: "production", sha: null, branch: null,
        message: null, by: "omar@acme-labs.dev", createdAt: "2026-10-06T16:40:03.000Z", readyAt: null, url: null, inspectUrl: inspect,
      },
      {
        id: "5c2d1b7a-9e3f-4a60-b8c4-2f1e0d9a7b35", state: "ready", target: "production", sha: null, branch: null,
        message: null, by: null, createdAt: "2026-10-05T09:12:44.000Z", readyAt: null, url: null, inspectUrl: inspect,
      },
    ]);
  });

  it("asks Workers Builds once, for the newest deployment's version; a split rollout asks nothing", async () => {
    const { calls, fetch } = cfApi();
    const r = await cloudflare.poll(ctx(fetch), part());
    const builds = calls.filter((c) => c.url.pathname.endsWith("/builds/builds"));
    expect(builds.map((c) => c.url.searchParams.get("version_ids"))).toEqual(["7e2a6c1d-0f4b-4c9e-9a51-3d8b2f6e4a10"]);
    expect(r.notes).toBeUndefined();
    expect(calls).toHaveLength(4); // + analytics + cron runs
    expectWellFormed(calls);
    // The newest one serves two versions (90 / 10): no single commit is "the" deploy's — nothing is asked.
    const split = { ...deploymentsJson, result: { deployments: [deploymentsJson.result.deployments[1]] } };
    const s2 = cfApi({ deployments: () => json(split) });
    const r2 = await cloudflare.poll(ctx(s2.fetch), part());
    expect(s2.calls.filter((c) => c.url.pathname.endsWith("/builds/builds"))).toEqual([]);
    expect(r2.deploys[0].sha).toBeNull();
  });

  it("a refused Builds read notes the missing permission and leaves the commit to the join — never a failed poll, never a guess", async () => {
    for (const refused of [() => echo(403), () => echo(401)]) {
      const { fetch } = cfApi({ builds: refused });
      const r = await cloudflare.poll(ctx(fetch), part());
      expect(r.deploys[0].sha).toBeNull();
      expect(r.notes).toEqual([COMMIT_NEEDS_CI_READ]);
      expect(r.points.length).toBeGreaterThan(0);
      noLeak(JSON.stringify(r));
    }
    const broken = cfApi({ builds: () => json({ oops: true }, 500) });
    expect((await cloudflare.poll(ctx(broken.fetch), part())).notes).toEqual([COMMIT_UNREAD]);
    // Two builds with different commits for one version, or none with a commit: no sha.
    const two = { success: true, errors: [], result: [
      { build_trigger_metadata: { commit_hash: "a".repeat(40), branch: "main" } }, { build_trigger_metadata: { commit_hash: "b".repeat(40), branch: "main" } },
    ] };
    expect((await cloudflare.poll(ctx(cfApi({ builds: () => json(two) }).fetch), part())).deploys[0].sha).toBeNull();
    const none = { success: true, errors: [], result: { builds: {} } };
    const r3 = await cloudflare.poll(ctx(cfApi({ builds: () => json(none) }).fetch), part());
    expect(r3.deploys[0].sha).toBeNull();
    expect(r3.notes).toBeUndefined();
  });

  it("skips what it cannot place, dedupes, scrubs a message, and keeps at most 20", async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, created_on: new Date(Date.parse("2026-10-01T00:00:00Z") + i * 3_600_000).toISOString(),
    }));
    const deployments = [
      { id: "a1" },                                                              // no created_on
      { created_on: "2026-10-07T08:00:00Z" },                                   // no id
      { id: "bad id!", created_on: "2026-10-07T08:00:00Z" },                    // not an id
      { id: "a4", created_on: "not a date" },
      { id: "a5", created_on: "2026-10-07T08:00:00Z", author_email: "x\u0000y", annotations: { "workers/message": `deploy with ${TOKEN}` } },
      { id: "a5", created_on: "2026-10-07T07:00:00Z" },                         // a duplicate id
      "junk", null,
      ...many,
    ];
    const { fetch } = cfApi({ deployments: () => json({ success: true, errors: [], result: { deployments } }) });
    const r = await cloudflare.poll(ctx(fetch), part());
    expect(r.deploys).toHaveLength(20);
    expect(r.deploys[0]).toMatchObject({ id: "a5", by: null, message: "deploy with [redacted]" });
    expect(r.deploys[1].id).toBe("00000000-0000-4000-8000-000000000024");
    noLeak(JSON.stringify(r.deploys));
  });

  it("refuses a body with no deployments list, and a 200 that says it failed", async () => {
    const none = cfApi({ deployments: () => json({ success: true, errors: [], result: {} }) });
    await expect(cloudflare.poll(ctx(none.fetch), part())).rejects.toThrow("cloudflare deployments: the response has no deployments list");
    const failed = cfApi({ deployments: () => json({ success: false, errors: [], result: null }) });
    await expect(cloudflare.poll(ctx(failed.fetch), part())).rejects.toThrow("cloudflare deployments: the request was refused");
    const html = cfApi({ deployments: () => new Response("<html>bad gateway</html>", { status: 200 }) });
    await expect(cloudflare.poll(ctx(html.fetch), part())).rejects.toThrow("cloudflare deployments: the response is not JSON");
  });

  it("a 403 on the deployments (a token without Workers Scripts Read) still reads the traffic, with no deploys", async () => {
    const { fetch } = cfApi({ deployments: () => echo(403), graphql: () => json({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [] }] } } }) });
    const r = await cloudflare.poll(ctx(fetch), part());
    expect(r.deploys).toEqual([]);
    expect(r.covered).toEqual({ from: "2026-10-07T09:00:00.000Z", to: "2026-10-07T12:00:00.000Z" });
  });

  it("any other refusal throws a scrubbed HostingError carrying its status", async () => {
    for (const status of [400, 401, 429, 500]) {
      const { fetch } = cfApi({ deployments: () => echo(status) });
      const e = await cloudflare.poll(ctx(fetch), part()).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(HostingError);
      expect((e as HostingError).status).toBe(status);
      expect((e as Error).message).toContain(`cloudflare deployments ${status}`);
      noLeak((e as Error).message);
      expect((e as Error).message).not.toContain(ACCOUNT);
    }
  });

  it("a redirect is never followed", async () => {
    const { calls, fetch } = cfApi({ deployments: () => new Response(null, { status: 302, headers: { location: "https://evil.example/x" } }) });
    await expect(cloudflare.poll(ctx(fetch), part())).rejects.toThrow("cloudflare deployments 302 — a redirect is never followed");
    expect(calls).toHaveLength(1);
  });
});

describe("cloudflare poll — metrics", () => {
  it("one analytics query over the window: requests and errors per settled hour, the inclusive end dropped", async () => {
    const { calls, fetch } = cfApi();
    const r = await cloudflare.poll(ctx(fetch), part());
    expect(calls).toHaveLength(4); // deployments, the newest deployment's build, analytics, cron runs — no daily read asked
    expect(calls.length).toBeLessThanOrEqual(cloudflare.pollCost);
    expectWellFormed(calls);
    const q = calls[2];
    expect(q.method).toBe("POST");
    expect(q.headers.get("content-type")).toBe("application/json");
    expect(q.body?.variables).toEqual({ a: ACCOUNT, s: "frontend-staging", from: "2026-10-07T09:00:00.000Z", to: "2026-10-07T12:00:00.000Z" });
    const query = String(q.body?.query);
    expect(query).toContain("query($a: string!, $s: string!, $from: Time!, $to: Time!)");
    expect(query).toContain("accounts(filter: { accountTag: $a })");
    expect(query).toContain("workersInvocationsAdaptive(limit: 200, filter: { scriptName: $s, datetime_geq: $from, datetime_leq: $to }, orderBy: [datetimeHour_ASC])");
    expect(query).toContain("dimensions { datetimeHour status }");
    expect(query).toContain("sum { requests errors subrequests }");
    expect(r.points).toEqual([
      { metric: "requests", at: "2026-10-07T09:00:00.000Z", value: 1523 },
      { metric: "requests", at: "2026-10-07T10:00:00.000Z", value: 1610 },
      { metric: "errors", at: "2026-10-07T09:00:00.000Z", value: 2 },
      { metric: "errors", at: "2026-10-07T10:00:00.000Z", value: 0 },
    ]);
    // 11:00 has no row: inside the covered window it is a true zero.
    expect(r.covered).toEqual({ from: "2026-10-07T09:00:00.000Z", to: "2026-10-07T12:00:00.000Z" });
    expect(r.unavailable.map((u) => u.metric)).toEqual(["latency_p50_ms", "latency_p95_ms", "bandwidth_bytes"]);
    for (const u of r.unavailable) expect(u.reason.length).toBeGreaterThan(20);
  });

  it("no rows at all is a covered, quiet window", async () => {
    const { fetch } = cfApi({ graphql: () => json({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [] }] } } }) });
    const r = await cloudflare.poll(ctx(fetch), part());
    expect(r.points).toEqual([]);
    expect(r.covered).toEqual({ from: "2026-10-07T09:00:00.000Z", to: "2026-10-07T12:00:00.000Z" });
  });

  it("skips malformed and out-of-window rows one by one", async () => {
    const row = (hour: unknown, requests: unknown, errors: unknown) => ({ dimensions: { datetimeHour: hour }, sum: { requests, errors } });
    const rows = [
      row("2026-10-07T08:00:00Z", 5, 0),   // before the window
      row("2026-10-07T09:00:00Z", 7, 1),
      row("2026-10-07T10:30:00Z", 9, 0),   // not an hour start
      row("2026-10-07T10:00:00Z", "12", 0), // a string count
      row("2026-10-07T10:00:00Z", -1, 0),
      row("2026-10-07T10:00:00Z", 3, null),
      row("nope", 1, 0),
      row("2026-10-07T11:00:00Z", 1e13, 0), // implausible
      row("2026-10-07T11:00:00Z", 4, 2),
      row("2026-10-07T13:00:00Z", 4, 0),   // the future
      { sum: { requests: 1, errors: 0 } }, "junk", null,
    ];
    const { fetch } = cfApi({ graphql: () => json({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: rows }] } } }) });
    const r = await cloudflare.poll(ctx(fetch), part());
    expect(r.points.map((p) => [p.metric, p.at.slice(11, 16), p.value])).toEqual([
      ["requests", "09:00", 7], ["requests", "11:00", 4], ["errors", "09:00", 1], ["errors", "11:00", 2],
    ]);
  });

  it("an answer naming no account, or a GraphQL error, fails the poll — scrubbed", async () => {
    const none = cfApi({ graphql: () => json(noAccountJson) });
    await expect(cloudflare.poll(ctx(none.fetch), part())).rejects.toThrow("cloudflare analytics: Cloudflare answered for no account");
    const refused = cfApi({ graphql: () => json(analyticsErrorJson) });
    await expect(cloudflare.poll(ctx(refused.fetch), part())).rejects.toThrow("cloudflare analytics: not authorized for that account");
    const leak = cfApi({ graphql: () => json({ data: null, errors: [{ message: `bad token ${TOKEN} for ${ACCOUNT}` }] }) });
    const e = await cloudflare.poll(ctx(leak.fetch), part()).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HostingError);
    expect((e as Error).message).toBe("cloudflare analytics: bad token [redacted] for [redacted]");
    const status = cfApi({ graphql: () => echo(403) });
    const e2 = await cloudflare.poll(ctx(status.fetch), part()).catch((x: unknown) => x);
    expect((e2 as Error).message).toContain("cloudflare analytics 403");
    expect((e2 as Error).message).toContain("the token lacks Account Analytics: Read on this account");
    noLeak((e2 as Error).message);
  });

  it("re-checks the Worker name and account id itself — nothing unvalidated reaches a URL or a query", async () => {
    for (const worker of ["x/../../user", "bad name", ""]) {
      const { calls, fetch } = cfApi();
      await expect(cloudflare.poll(ctx(fetch), part({ worker }))).rejects.toThrow("the part's Worker name is not set or not in the expected form");
      expect(calls).toHaveLength(0);
    }
    const { calls, fetch } = cfApi();
    await expect(cloudflare.poll(ctx(fetch, { config: { account_id: "../user/tokens" } }), part())).rejects.toThrow("the Cloudflare Account ID is not set");
    expect(calls).toHaveLength(0);
  });

  it("the credential never goes anywhere but api.cloudflare.com", async () => {
    const sent: string[] = [];
    const f = hostFetch(cloudflare.apiHosts, (async (u: RequestInfo | URL) => { sent.push(String(u)); return json({}); }) as typeof fetch);
    for (const url of ["https://dash.cloudflare.com/x", "http://api.cloudflare.com/client/v4/graphql", "https://api.cloudflare.com.evil.example/x"]) {
      await expect(f(url, { headers: { authorization: `Bearer ${TOKEN}` } })).rejects.toBeInstanceOf(HostRefusedError);
    }
    expect(sent).toEqual([]);
  });
});

// ── Repo setups, Phase G: the extra usage families ───────────────────────────
const D1_ID = "6c71838c-18f7-4f68-8513-b58e86c237b9";
const extraOf = (r: { extraPoints?: { metric: string; at: string; value: number }[] }, prefix: string) =>
  (r.extraPoints ?? []).filter((p) => p.metric.startsWith(prefix)).map((p) => [p.metric, p.at.slice(0, 16), p.value]);

describe("cloudflare poll — outcomes (repo setups, Phase G)", () => {
  it("each (hour, invocation outcome) is its own point, by Cloudflare's own status name; requests and errors are the hour's sums", async () => {
    const { fetch } = cfApi();
    const r = await cloudflare.poll(ctx(fetch), part());
    // The hour sums are unchanged by the grouping — 1500 + 21 + 2 and 2 errors at 09:00.
    expect(r.points.filter((p) => p.metric === "requests").map((p) => p.value)).toEqual([1523, 1610]);
    expect(r.points.filter((p) => p.metric === "errors").map((p) => p.value)).toEqual([2, 0]);
    expect(extraOf(r, "hx_outcome_")).toEqual([
      ["hx_outcome_success", "2026-10-07T09:00", 1500],
      ["hx_outcome_clientDisconnected", "2026-10-07T09:00", 21],
      ["hx_outcome_scriptThrewException", "2026-10-07T09:00", 2],
      ["hx_outcome_success", "2026-10-07T10:00", 1610],
    ]);
    // No HTTP status is invented: nothing says 4xx or 5xx.
    expect(JSON.stringify(r.extraPoints)).not.toMatch(/4xx|5xx/);
    expect(extraOf(r, "hx_subrequests")).toEqual([["hx_subrequests", "2026-10-07T09:00", 917], ["hx_subrequests", "2026-10-07T10:00", 1022]]);
    expect(r.families).toContainEqual({ family: "outcomes", reason: null });
  });

  it("a row with no readable status counts toward the hour and toward no outcome; a missing subrequests count stores none", async () => {
    const rows = [
      { dimensions: { datetimeHour: "2026-10-07T09:00:00Z" }, sum: { requests: 7, errors: 1 } },
      { dimensions: { datetimeHour: "2026-10-07T09:00:00Z", status: "not a status!" }, sum: { requests: 3, errors: 0 } },
    ];
    const { fetch } = cfApi({ graphql: () => json({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: rows }] } } }) });
    const r = await cloudflare.poll(ctx(fetch), part());
    expect(r.points.find((p) => p.metric === "requests")?.value).toBe(10);
    expect(extraOf(r, "hx_outcome_")).toEqual([]);
    expect(extraOf(r, "hx_subrequests")).toEqual([]);
  });
});

describe("cloudflare poll — schedules (repo setups, Phase G)", () => {
  it("one query of the script's cron runs over the window: runs, failures and the last run per (hour, cron)", async () => {
    const { calls, fetch } = cfApi();
    const r = await cloudflare.poll(ctx(fetch), part());
    const q = calls.find((c) => queryKind(c.body) === "scheduled");
    expect(q?.body?.variables).toEqual({ a: ACCOUNT, s: "frontend-staging", from: "2026-10-07T09:00:00.000Z", to: "2026-10-07T12:00:00.000Z" });
    expect(String(q?.body?.query)).toContain("workersInvocationsScheduled(limit: 1000, filter: { scriptName: $s, datetime_geq: $from, datetime_leq: $to })");
    expect(extraOf(r, "hx_cron_")).toEqual([
      ["hx_cron_runs:*/10_*_*_*_*", "2026-10-07T09:00", 6],
      ["hx_cron_failed:*/10_*_*_*_*", "2026-10-07T09:00", 1],
      ["hx_cron_last:*/10_*_*_*_*", "2026-10-07T09:00", Date.parse("2026-10-07T09:50:01Z")],
      ["hx_cron_runs:*/10_*_*_*_*", "2026-10-07T10:00", 2],
      ["hx_cron_failed:*/10_*_*_*_*", "2026-10-07T10:00", 0],
      ["hx_cron_last:*/10_*_*_*_*", "2026-10-07T10:00", Date.parse("2026-10-07T10:50:03Z")],
      ["hx_cron_runs:0_*_*_*_*", "2026-10-07T10:00", 1],
      ["hx_cron_failed:0_*_*_*_*", "2026-10-07T10:00", 0],
      ["hx_cron_last:0_*_*_*_*", "2026-10-07T10:00", Date.parse("2026-10-07T10:00:00Z")],
      ["hx_cron_runs:0_*_*_*_SUN,MON", "2026-10-07T11:00", 1],
      ["hx_cron_failed:0_*_*_*_SUN,MON", "2026-10-07T11:00", 0],
      ["hx_cron_last:0_*_*_*_SUN,MON", "2026-10-07T11:00", Date.parse("2026-10-07T11:00:00Z")],
    ]);
    expect(r.families).toContainEqual({ family: "schedules", reason: null });
  });

  it("a refused or shapeless cron answer is the family's reason — the poll still stands, and the token never shows", async () => {
    for (const scheduled of [() => echo(403), () => json({ data: { viewer: { accounts: [{}] } } }), () => json({ data: null, errors: [{ message: `no ${TOKEN}` }] })]) {
      const { fetch } = cfApi({ scheduled });
      const r = await cloudflare.poll(ctx(fetch), part());
      expect(r.points.length).toBeGreaterThan(0);
      expect(extraOf(r, "hx_cron_")).toEqual([]);
      const f = r.families?.find((x) => x.family === "schedules");
      expect(f?.reason).toMatch(/^Cloudflare did not answer for cron runs: /);
      noLeak(JSON.stringify(r));
    }
    // An answer that fills the limit may be cut short: nothing is stored from it, and the reason says why.
    const full = Array.from({ length: 1000 }, (_, i) => ({ cron: "* * * * *", status: "success", datetime: new Date(Date.parse("2026-10-07T09:00:00Z") + i * 9_000).toISOString() }));
    const r2 = await cloudflare.poll(ctx(cfApi({ scheduled: () => json({ data: { viewer: { accounts: [{ workersInvocationsScheduled: full }] } } }) }).fetch), part());
    expect(extraOf(r2, "hx_cron_")).toEqual([]);
    expect(r2.families?.find((x) => x.family === "schedules")?.reason).toContain("too many to read in one answer");
  });

  it("skips a run that is not a cron, not a time, or outside the window", async () => {
    const runs = [
      { cron: "*/5 * * * *", status: "success", datetime: "2026-10-07T09:05:00Z" },
      { cron: "rm -rf /", status: "success", datetime: "2026-10-07T09:05:00Z" },
      { cron: "*/5 * * * *", status: "success", datetime: "yesterday" },
      { cron: "*/5 * * * *", status: "success", datetime: "2026-10-07T08:55:00Z" },
      "junk", null,
    ];
    const r = await cloudflare.poll(ctx(cfApi({ scheduled: () => json({ data: { viewer: { accounts: [{ workersInvocationsScheduled: runs }] } } }) }).fetch), part());
    expect(extraOf(r, "hx_cron_runs")).toEqual([["hx_cron_runs:*/5_*_*_*_*", "2026-10-07T09:00", 1]]);
  });
});

describe("cloudflare poll — the daily read (repo setups, Phase G)", () => {
  it("without a day to read, asks for no quantile and no D1 — and a part with no D1 id says so, never zero", async () => {
    const { calls, fetch } = cfApi();
    const r = await cloudflare.poll(ctx(fetch), part({ worker: "frontend-staging", d1_database_ids: D1_ID }));
    expect(calls.map((c) => queryKind(c.body)).filter((k) => k === "runtime" || k === "d1")).toEqual([]);
    expect(r.families?.map((f) => f.family)).toEqual(["outcomes", "schedules"]);
    const none = await cloudflare.poll(ctx(cfApi().fetch), part());
    expect(none.families).toContainEqual({ family: "storage", reason: NO_D1_DATABASE });
  });

  it("the day's quantiles (µs) and its D1 figures as daily points at 00:00 UTC, with the day's marker", async () => {
    const { calls, fetch } = cfApi();
    const r = await cloudflare.poll(ctx(fetch, { daily: "2026-10-06" }), part({ worker: "frontend-staging", d1_database_ids: D1_ID }));
    expect(calls.length).toBe(cloudflare.pollCost); // the worst case: every fetch the budget names
    const rt = calls.find((c) => queryKind(c.body) === "runtime");
    expect(rt?.body?.variables).toEqual({ a: ACCOUNT, s: "frontend-staging", from: "2026-10-06T00:00:00.000Z", to: "2026-10-07T00:00:00.000Z" });
    expect(String(rt?.body?.query)).toContain("quantiles { cpuTimeP50 cpuTimeP99 wallTimeP50 }");
    const d1 = calls.find((c) => queryKind(c.body) === "d1");
    expect(d1?.body?.variables).toEqual({ a: ACCOUNT, day: "2026-10-06", d0: D1_ID });
    expect(extraOf(r, "hx_daily_read")).toEqual([["hx_daily_read", "2026-10-06T00:00", 1]]);
    expect([...extraOf(r, "hx_cpu_time"), ...extraOf(r, "hx_wall_time")]).toEqual([
      ["hx_cpu_time_p50_us", "2026-10-06T00:00", 2257], ["hx_cpu_time_p99_us", "2026-10-06T00:00", 55106], ["hx_wall_time_p50_us", "2026-10-06T00:00", 23491],
    ]);
    expect(extraOf(r, "hx_d1_")).toEqual([
      [`hx_d1_read_queries:${D1_ID}`, "2026-10-06T00:00", 9672], [`hx_d1_write_queries:${D1_ID}`, "2026-10-06T00:00", 3093],
      [`hx_d1_rows_read:${D1_ID}`, "2026-10-06T00:00", 2354377], [`hx_d1_rows_written:${D1_ID}`, "2026-10-06T00:00", 13712],
      [`hx_d1_size_bytes:${D1_ID}`, "2026-10-06T00:00", 27545600],
    ]);
    expect(r.families).toEqual([
      { family: "outcomes", reason: null }, { family: "schedules", reason: null }, { family: "runtime", reason: null }, { family: "storage", reason: null },
    ]);
  });

  it("a day with no invocation stores the marker alone; a day not yet over is never read", async () => {
    const empty = cfApi({ runtime: () => json({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [] }] } } }) });
    const r = await cloudflare.poll(ctx(empty.fetch, { daily: "2026-10-06" }), part());
    expect(extraOf(r, "hx_daily_read")).toEqual([["hx_daily_read", "2026-10-06T00:00", 1]]);
    expect(extraOf(r, "hx_cpu_time")).toEqual([]);
    const today = cfApi();
    const r2 = await cloudflare.poll(ctx(today.fetch, { daily: "2026-10-07" }), part());
    expect(today.calls.map((c) => queryKind(c.body))).not.toContain("runtime");
    expect(extraOf(r2, "hx_daily_read")).toEqual([]);
  });

  it("a refused quantile or D1 read is that family's reason (no marker for a failed quantile read, so the day is asked again)", async () => {
    const { fetch } = cfApi({ runtime: () => echo(403), d1: () => json({ data: null, errors: [{ message: `bad ${TOKEN}` }] }) });
    const r = await cloudflare.poll(ctx(fetch, { daily: "2026-10-06" }), part({ worker: "frontend-staging", d1_database_ids: D1_ID }));
    expect(extraOf(r, "hx_daily_read")).toEqual([]);
    expect(r.families?.find((f) => f.family === "runtime")?.reason).toMatch(/^Cloudflare did not answer for the day's CPU and wall time: /);
    expect(r.families?.find((f) => f.family === "storage")?.reason).toMatch(/^Cloudflare did not answer for D1: /);
    expect(r.points.length).toBeGreaterThan(0);
    noLeak(JSON.stringify(r));
  });

  it("reads at most three D1 databases, one alias pair each, and stores nothing for a database whose rows are not that day's", async () => {
    const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"];
    const { calls, fetch } = cfApi({ d1: () => json({ data: { viewer: { accounts: [{
      q0: [{ dimensions: { date: "2026-10-05" }, sum: { readQueries: 1, writeQueries: 1, rowsRead: 1, rowsWritten: 1 } }], s0: [],
      q1: [{ dimensions: { date: "2026-10-06" }, sum: { readQueries: 5, writeQueries: "2", rowsRead: -1, rowsWritten: 3 } }], s1: [{ dimensions: { date: "2026-10-06" }, max: { databaseSizeBytes: 1024 } }],
      q2: [], s2: [],
    }] } } }) });
    const r = await cloudflare.poll(ctx(fetch, { daily: "2026-10-06" }), part({ worker: "frontend-staging", d1_database_ids: ids.join(",") }));
    const d1 = calls.find((c) => queryKind(c.body) === "d1");
    expect(Object.keys(d1?.body?.variables as object)).toEqual(["a", "day", "d0", "d1", "d2"]);
    expect(String(d1?.body?.query)).toContain("q2: d1AnalyticsAdaptiveGroups");
    expect(String(d1?.body?.query)).not.toContain("q3:");
    expect(extraOf(r, "hx_d1_")).toEqual([
      [`hx_d1_read_queries:${ids[1]}`, "2026-10-06T00:00", 5], [`hx_d1_rows_written:${ids[1]}`, "2026-10-06T00:00", 3], [`hx_d1_size_bytes:${ids[1]}`, "2026-10-06T00:00", 1024],
    ]);
  });
});

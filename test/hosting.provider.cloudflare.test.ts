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
import { COMMIT_NEEDS_CI_READ, COMMIT_UNREAD } from "../src/hosting/providers/cloudflare";

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

const ctx = (f: ReturnType<typeof hostFetch>, opts: { token?: string; config?: Record<string, string>; now?: number } = {}): ProviderContext => ({
  fetch: f,
  credential: { secret: secret(opts.token ?? TOKEN), config: opts.config ?? { account_id: ACCOUNT } },
  now: opts.now ?? NOW,
});

const part = (settings: Record<string, string> = { worker: "frontend-staging" }): PartRef => ({
  orgId: "org_acme", env: "staging", envLabel: "staging", branch: "main", key: "web", role: "web", settings,
});

const DEPLOYMENTS_PATH = `/client/v4/accounts/${ACCOUNT}/workers/scripts/frontend-staging/deployments`;

/** The happy path, every route from the fixtures. `over` replaces one. */
function cfApi(over: { deployments?: () => Response; graphql?: (body: Record<string, unknown> | null) => Response; account?: () => Response; builds?: (u: URL) => Response } = {}) {
  return stubbed((u, body) => {
    if (u.pathname === DEPLOYMENTS_PATH) return over.deployments?.() ?? json(deploymentsJson);
    if (u.pathname === `/client/v4/accounts/${ACCOUNT}/builds/builds`) return over.builds?.(u) ?? json(buildsJson);
    if (u.pathname === "/client/v4/graphql") return over.graphql?.(body) ?? json(analyticsJson);
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
    expect(cloudflare.capabilities).toEqual({ deploys: true, metrics: ["requests", "errors"] });
    for (const m of cloudflare.capabilities.metrics) expect(metricsForRole("web")).toContain(m);
  });

  it("has exactly one part setting, the Worker name, and one org field, the account id", () => {
    expect(cloudflare.partSettings.map((f) => f.key)).toEqual(["worker"]);
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

  it("budgets three fetches a poll: deployments, the newest deployment's build, analytics", () => {
    expect(cloudflare.pollCost).toBe(3);
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
    expect(calls).toHaveLength(3);
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
    expect(calls).toHaveLength(3); // deployments, the newest deployment's build, analytics
    expect(calls.length).toBeLessThanOrEqual(cloudflare.pollCost);
    expectWellFormed(calls);
    const q = calls[2];
    expect(q.method).toBe("POST");
    expect(q.headers.get("content-type")).toBe("application/json");
    expect(q.body?.variables).toEqual({ a: ACCOUNT, s: "frontend-staging", from: "2026-10-07T09:00:00.000Z", to: "2026-10-07T12:00:00.000Z" });
    const query = String(q.body?.query);
    expect(query).toContain("query($a: string!, $s: string!, $from: Time!, $to: Time!)");
    expect(query).toContain("accounts(filter: { accountTag: $a })");
    expect(query).toContain("workersInvocationsAdaptive(limit: 100, filter: { scriptName: $s, datetime_geq: $from, datetime_leq: $to }, orderBy: [datetimeHour_ASC])");
    expect(query).toContain("dimensions { datetimeHour }");
    expect(query).toContain("sum { requests errors }");
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

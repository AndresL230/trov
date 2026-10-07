// Netlify (#100) — the provider object in src/hosting/providers/netlify.ts against recorded-shape fixtures
// (fixtures/hosting/netlify/). No network: every request goes through `hostFetch(netlify.apiHosts, stub)`, so the
// allowlist is exercised too, and the stub asserts host, path, query, method and the auth header.
import { describe, it, expect } from "vitest";
import { netlify } from "../src/hosting/providers/netlify";
import { HostRefusedError, HostingError, hostFetch } from "../src/hosting/http";
import { checkFields } from "../src/hosting/registry";
import type { PartRef, ProviderContext } from "../src/hosting/types";
import { DEPLOY_STATES, metricsForRole } from "@shared/hosting";
import { LONG_TOKEN, leakedFragments } from "./helpers/repo";
import site from "../fixtures/hosting/netlify/site.json";
import user from "../fixtures/hosting/netlify/user.json";
import deploysProduction from "../fixtures/hosting/netlify/deploys.production.json";
import deploysBranch from "../fixtures/hosting/netlify/deploys.branch.json";
import oauthToken from "../fixtures/hosting/netlify/oauth-token.json";
import oauthError from "../fixtures/hosting/netlify/oauth-error.json";
import error401 from "../fixtures/hosting/netlify/error.401.json";
import error404 from "../fixtures/hosting/netlify/error.404.json";

const SITE_ID = "3f2a9c1e-7b4d-4e8a-9c2f-5d6e7f8a9b0c";
const NOW = Date.parse("2026-10-07T12:20:00Z");
const NO_USAGE = "Netlify exposes no public usage API (Observability is dashboard-only)";
// A 64-character client secret and code, like LONG_TOKEN — a scrub that only matched short values would pass
// with short fixtures and leak in production.
const CLIENT_SECRET = Array.from({ length: 64 }, (_, i) => "abcdefghijklmnopqrstuvwxyz234567"[(i * 11 + 5) % 32]).join("");
const CODE = Array.from({ length: 64 }, (_, i) => "ZYXWVUTSRQPONMLKJIHGFEDCBA987654"[(i * 13 + 1) % 32]).join("");

/** A real fetch rejects ASYNCHRONOUSLY (a network failure arrives later), and the thrown-fetch stubs below do the
 *  same: an already-rejected promise handed through `hostFetch`'s `return fetchImpl(…)` would sit without a
 *  handler for one adoption microtask, which workerd reports as an unhandled rejection. */
const later = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

interface Call { url: URL; method: string; headers: Headers; body: string | null }

/** A stub fetch that records every call and answers through `route`. It is wrapped in `hostFetch`, exactly as
 *  the framework does, so a URL off `apiHosts` never reaches it. */
function stub(route: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: new URL(String(input)),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : null,
    };
    expect(init?.redirect).toBe("manual");
    calls.push(call);
    return route(call);
  }) as typeof fetch;
  return { calls, fetch: hostFetch(netlify.apiHosts, impl) };
}

const ctx = (f: ReturnType<typeof stub>, token = LONG_TOKEN): ProviderContext => ({
  fetch: f.fetch, credential: { secret: { reveal: () => token }, config: {} }, now: NOW,
});

const part = (settings: Record<string, string> = { site_id: SITE_ID }, role: PartRef["role"] = "web"): PartRef => ({
  orgId: "org_saplinglearn", env: "production", envLabel: "production", branch: "production", key: "web", role, settings,
});

/** Every authenticated read: https, the API host, GET, `Authorization: Bearer <token>`. */
function expectAuthedGet(call: Call, path: string, token = LONG_TOKEN): void {
  expect(call.url.protocol).toBe("https:");
  expect(call.url.hostname).toBe("api.netlify.com");
  expect(call.url.pathname).toBe(path);
  expect(call.method).toBe("GET");
  expect(call.headers.get("authorization")).toBe(`Bearer ${token}`);
  expect(call.headers.get("accept")).toBe("application/json");
  expect(call.headers.get("user-agent")).toBeTruthy();
}

const allLeaks = (text: string): string[] => [
  ...leakedFragments(text, LONG_TOKEN), ...leakedFragments(text, CLIENT_SECRET), ...leakedFragments(text, CODE),
];

async function thrown(p: Promise<unknown>): Promise<HostingError> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(HostingError); return e as HostingError; }
  throw new Error("expected a HostingError");
}

describe("netlify — descriptor", () => {
  it("is an available, org-scoped web host whose credential goes only to api.netlify.com", () => {
    expect(netlify.id).toBe("netlify");
    expect(netlify.status).toBe("available");
    expect(netlify.roles).toEqual(["web"]);
    expect(netlify.apiHosts).toEqual(["api.netlify.com"]);
    expect(netlify.credentialScope).toBe("org");
    expect(netlify.summary.length).toBeGreaterThan(20);
    expect(netlify.docsUrl).toMatch(/^https:\/\//);
    expect(netlify.orgConfigFields).toEqual([]);
    expect(netlify.capabilities).toEqual({ deploys: true, metrics: [] });
    expect(netlify.planNote).toMatch(/no usage or analytics API/);
    expect(netlify.pollCost).toBe(1);
  });

  it("offers OAuth first (needing the operator's app), then a pasted personal access token", () => {
    expect(netlify.connectionMethods.map((m) => m.method)).toEqual(["oauth", "token"]);
    const [oauth, token] = netlify.connectionMethods;
    expect(oauth.label).toBe("Connect with Netlify");
    expect(oauth.requires).toEqual(["NETLIFY_OAUTH_CLIENT_ID", "NETLIFY_OAUTH_CLIENT_SECRET"]);
    expect(oauth.howTo).toMatch(/NO scopes/);
    expect(oauth.grants.join(" ")).toMatch(/no scopes/);
    expect(token.requires).toBeUndefined();
    expect(token.howTo).toMatch(/Personal access tokens/);
    expect(token.howTo).toMatch(/expiration/);
    expect(token.howTo).toMatch(/SAML/);
    expect(token.howTo).toMatch(/api\.netlify\.com/);
    expect(netlify.install?.clientIdVar).toBe("NETLIFY_OAUTH_CLIENT_ID");
    expect(netlify.install?.clientSecretVar).toBe("NETLIFY_OAUTH_CLIENT_SECRET");
    expect(netlify.install?.revoke).toBeUndefined();
    expect(netlify.install?.webhook).toBeUndefined();
  });

  it("anchors every part-setting pattern", () => {
    for (const f of netlify.partSettings) if (f.pattern) expect(f.pattern.source).toMatch(/^\^.*\$$/);
    expect(netlify.partSettings.map((f) => [f.key, f.required])).toEqual([["site_id", true], ["context", false], ["branch", false], ["site_name", false]]);
  });

  it("accepts good part settings and refuses bad ones via checkFields", () => {
    const ok = (given: unknown) => checkFields(netlify.partSettings, given, "settings");
    expect(ok({ site_id: SITE_ID })).toEqual({ values: { site_id: SITE_ID } });
    expect(ok({ site_id: SITE_ID.toUpperCase() })).toEqual({ values: { site_id: SITE_ID.toUpperCase() } });
    expect(ok({ site_id: SITE_ID, context: "branch", branch: "feature/new-nav", site_name: "trov-web" }))
      .toEqual({ values: { site_id: SITE_ID, context: "branch", branch: "feature/new-nav", site_name: "trov-web" } });
    expect(ok({ site_id: ` ${SITE_ID} `, context: "production" })).toEqual({ values: { site_id: SITE_ID, context: "production" } });
    expect(ok({})).toEqual({ field: "settings.site_id", message: "Site ID is required" });
    for (const bad of ["trov-web", "trov-web.netlify.app", "3f2a9c1e7b4d4e8a9c2f5d6e7f8a9b0c", `${SITE_ID}x`, `x${SITE_ID}`, "3f2a9c1e-7b4d-4e8a-9c2f-5d6e7f8a9b0g"]) {
      expect(ok({ site_id: bad })).toEqual({ field: "settings.site_id", message: "Site ID is not in the expected form" });
    }
    for (const bad of ["Production", "deploy-preview", "branch-deploy", "productionx"]) {
      expect(ok({ site_id: SITE_ID, context: bad })).toEqual({ field: "settings.context", message: "Deploy context is not in the expected form" });
    }
    for (const bad of ["two words", "a?b=c", "a&b", "a#b"]) {
      expect(ok({ site_id: SITE_ID, branch: bad })).toEqual({ field: "settings.branch", message: "Branch is not in the expected form" });
    }
    for (const bad of ["Trov-Web", "trov_web", "trov.web", "a".repeat(64)]) {
      expect(ok({ site_id: SITE_ID, site_name: bad })).toEqual({ field: "settings.site_name", message: "Site name is not in the expected form" });
    }
    expect(ok({ site_id: SITE_ID, team: "acme" })).toEqual({ field: "settings", message: "settings has a key this provider does not use" });
  });

  it("links the console only when the site name is known", () => {
    expect(netlify.consoleUrl({ settings: { site_id: SITE_ID, site_name: "trov-web" } }, {})).toBe("https://app.netlify.com/sites/trov-web/overview");
    expect(netlify.consoleUrl({ settings: { site_id: SITE_ID } }, {})).toBeNull();
    expect(netlify.consoleUrl({ settings: { site_id: SITE_ID, site_name: "Not A Name" } }, {})).toBeNull();
  });
});

describe("netlify — probe", () => {
  it("with a part: ONE read of the site, naming it and what Trov will read", async () => {
    const f = stub(() => json(site));
    const res = await netlify.probe(ctx(f), part());
    expect(res).toEqual({ ok: true, detail: "Netlify answered for site trov-web (https://trov-web.netlify.app). Trov reads its production deploys." });
    expect(f.calls).toHaveLength(1);
    expectAuthedGet(f.calls[0], `/api/v1/sites/${SITE_ID}`);
    expect(f.calls[0].url.search).toBe("");
  });

  it("names the branch for a branch part, and falls back to the plain url / the id", async () => {
    const plain = { ...clone(site), ssl_url: null, name: null, url: "http://www.acme.dev" };
    const f = stub(() => json(plain));
    const res = await netlify.probe(ctx(f), part({ site_id: SITE_ID, context: "branch", branch: "staging" }));
    expect(res).toEqual({ ok: true, detail: `Netlify answered for site ${SITE_ID} (http://www.acme.dev). Trov reads the deploys of branch staging.` });
  });

  it("without a part: ONE read of the user, naming whose token it is", async () => {
    const f = stub(() => json(user));
    expect(await netlify.probe(ctx(f), null)).toEqual({ ok: true, detail: "Netlify answered: the token belongs to Ada Lovelace." });
    expect(f.calls).toHaveLength(1);
    expectAuthedGet(f.calls[0], "/api/v1/user");
    const g = stub(() => json({ ...clone(user), full_name: null }));
    expect((await netlify.probe(ctx(g), null)).detail).toBe("Netlify answered: the token belongs to ada@acme.dev.");
    const h = stub(() => json({}));
    expect((await netlify.probe(ctx(h), null)).detail).toBe("Netlify answered: the token is valid.");
  });

  it("a 401 is ok:false with Netlify's reason and a hint — scrubbed even when the body echoes the token", async () => {
    const f = stub(() => json({ ...error401, message: `Access Denied for token ${LONG_TOKEN}` }, 401));
    const res = await netlify.probe(ctx(f), part());
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/^netlify site 401: Access Denied for token \[redacted\] — the token is not valid/);
    expect(allLeaks(res.detail)).toEqual([]);
    const g = stub(() => json(error401, 401));
    const bare = await netlify.probe(ctx(g), null);
    expect(bare).toEqual({ ok: false, detail: "netlify user 401: Access Denied — the token is not valid (expired, revoked, or the Netlify OAuth grant was removed)" });
  });

  it("a 404 says the site id is wrong or not visible to the token", async () => {
    const f = stub(() => json(error404, 404));
    const res = await netlify.probe(ctx(f), part());
    expect(res.ok).toBe(false);
    expect(res.detail).toBe("netlify site 404: Not Found — no site with this Site ID that the token can see (check the Site ID, and that the token's account is on the site's team)");
  });

  it("a branch part with no Branch fails before any request", async () => {
    const f = stub(() => json(site));
    const res = await netlify.probe(ctx(f), part({ site_id: SITE_ID, context: "branch" }));
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/Deploy context.*branch.*no Branch/);
    expect(f.calls).toHaveLength(0);
  });

  it("a thrown fetch is a fixed-text ok:false, never the original error", async () => {
    const f = stub(async () => { await later(); throw new TypeError(`connect failed for Bearer ${LONG_TOKEN}`); });
    const res = await netlify.probe(ctx(f), part());
    expect(res).toEqual({ ok: false, detail: "netlify site: the request failed" });
  });
});

describe("netlify — poll", () => {
  it("production: ONE read of the production deploys, every state mapped, newest first", async () => {
    const f = stub(() => json(deploysProduction));
    const res = await netlify.poll(ctx(f), part());
    expect(f.calls.length).toBeLessThanOrEqual(netlify.pollCost);
    expect(f.calls).toHaveLength(1);
    expectAuthedGet(f.calls[0], `/api/v1/sites/${SITE_ID}/deploys`);
    expect([...f.calls[0].url.searchParams.entries()]).toEqual([["per_page", "20"], ["production", "true"]]);

    expect(res.deploys.map((d) => [d.id, d.state])).toEqual([
      ["6703f2c41b8a9e0008d4c7a1", "queued"],   // new
      ["6703ef901b8a9e0008d4c6f2", "queued"],   // enqueued
      ["6703ec1d1b8a9e0008d4c5e3", "building"], // building
      ["6703e8a71b8a9e0008d4c4d4", "building"], // uploading
      ["6703e5321b8a9e0008d4c3c5", "building"], // processing
      ["6703e1bc1b8a9e0008d4c2b6", "queued"],   // retrying
      ["6703d4a91b8a9e0008d4c1a7", "ready"],    // ready
      ["6703c7351b8a9e0008d4c098", "error"],    // error
      ["6703b9c21b8a9e0008d4bf89", "canceled"], // error + skipped: true
    ]);
    for (const d of res.deploys) {
      expect(DEPLOY_STATES).toContain(d.state);
      expect(d.target).toBe("production");
      expect(d.branch).toBe("main");
    }
    expect(res.deploys.find((d) => d.id === "6703d4a91b8a9e0008d4c1a7")).toEqual({
      id: "6703d4a91b8a9e0008d4c1a7",
      state: "ready",
      target: "production",
      sha: "8807c8e7a737ddb36d658375414569a3c6ab5aaa",
      branch: "main",
      message: "Fix the pricing table on mobile (#214)",
      by: "ada-l",
      createdAt: "2026-10-07T09:41:12.318Z",
      readyAt: "2026-10-07T09:42:55.904Z",
      url: "https://6703d4a91b8a9e0008d4c1a7--trov-web.netlify.app",
      inspectUrl: "https://app.netlify.com/sites/trov-web/deploys/6703d4a91b8a9e0008d4c1a7",
    });
    expect(res.deploys.find((d) => d.id === "6703c7351b8a9e0008d4c098")?.readyAt).toBeNull();
  });

  it("never reads a metric: every web metric unavailable with the reason, no points, covered null", async () => {
    const f = stub(() => json(deploysProduction));
    const res = await netlify.poll(ctx(f), part());
    expect(res.points).toEqual([]);
    expect(res.covered).toBeNull();
    expect(res.unavailable).toEqual(metricsForRole("web").map((metric) => ({ metric, reason: NO_USAGE })));
    expect(res.unavailable.map((u) => u.metric).sort()).toEqual(["bandwidth_bytes", "errors", "latency_p50_ms", "latency_p95_ms", "requests"]);
    // Only the deploys endpoint was asked — no analytics endpoint, however the window falls.
    expect(f.calls.map((c) => c.url.pathname)).toEqual([`/api/v1/sites/${SITE_ID}/deploys`]);
  });

  it("a service part (a role Netlify cannot serve): its metrics unavailable, deploys still read", async () => {
    const f = stub(() => json(deploysProduction));
    const res = await netlify.poll(ctx(f), part({ site_id: SITE_ID }, "service"));
    expect(res.unavailable.map((u) => u.metric)).toEqual(metricsForRole("service"));
    for (const u of res.unavailable) expect(u.reason).toMatch(/no CPU or memory/);
    expect(res.deploys).toHaveLength(9);
    expect(res.covered).toBeNull();
  });

  it("branch: reads the branch's deploys — previews and branch deploys, the other states mapped", async () => {
    const f = stub(() => json(deploysBranch));
    const res = await netlify.poll(ctx(f), part({ site_id: SITE_ID, context: "branch", branch: "staging", site_name: "trov-web" }));
    expect(f.calls).toHaveLength(1);
    expectAuthedGet(f.calls[0], `/api/v1/sites/${SITE_ID}/deploys`);
    expect([...f.calls[0].url.searchParams.entries()]).toEqual([["per_page", "20"], ["branch", "staging"]]);
    expect(res.deploys.map((d) => [d.state, d.target])).toEqual([
      ["queued", "preview"],   // pending_review, deploy-preview
      ["queued", "preview"],   // accepted
      ["building", "preview"], // uploaded, branch-deploy
      ["building", "preview"], // preparing
      ["building", "preview"], // prepared
      ["building", "preview"], // processed
      ["ready", "preview"],    // ready, branch-deploy (never published: readyAt null)
      ["error", "preview"],    // rejected — a deploy that failed review
      ["canceled", "preview"], // error with "Canceled build"
    ]);
    const cli = res.deploys.find((d) => d.id === "6703c3501b8a9e0008d4c539");
    expect(cli).toMatchObject({ sha: null, message: null, by: null, branch: "staging", readyAt: null });
    expect(res.deploys.find((d) => d.state === "ready")?.readyAt).toBeNull();
  });

  it("a branch part with no Branch throws before any request", async () => {
    const f = stub(() => json(deploysBranch));
    const e = await thrown(netlify.poll(ctx(f), part({ site_id: SITE_ID, context: "branch" })));
    expect(e.message).toMatch(/no Branch/);
    expect(f.calls).toHaveLength(0);
  });

  it("reads branch only for context branch — a production part ignores a Branch setting", async () => {
    const f = stub(() => json([]));
    const res = await netlify.poll(ctx(f), part({ site_id: SITE_ID, context: "production", branch: "staging" }));
    expect(f.calls[0].url.searchParams.get("branch")).toBeNull();
    expect(f.calls[0].url.searchParams.get("production")).toBe("true");
    expect(res).toEqual({ deploys: [], points: [], unavailable: metricsForRole("web").map((metric) => ({ metric, reason: NO_USAGE })), covered: null });
  });

  it("skips malformed items one by one and never guesses a state", async () => {
    const good = clone(deploysProduction[6]);
    const items: unknown[] = [
      null, 42, "deploy", [good],
      { ...good, id: undefined },
      { ...good, id: "../../etc" },
      { ...good, id: "u1", state: "mystery" },
      { ...good, id: "u2", state: "constructor" },
      { ...good, id: "u3", state: undefined },
      { ...good, id: "u4", created_at: "yesterday" },
      { ...good, id: "u5", created_at: null },
      good,
      { ...good, title: "a duplicate is dropped" },
    ];
    const f = stub(() => json(items));
    const res = await netlify.poll(ctx(f), part());
    expect(res.deploys.map((d) => d.id)).toEqual([good.id]);
    expect(res.deploys[0].message).toBe("Fix the pricing table on mobile (#214)");
  });

  it("normalises the optional fields defensively", async () => {
    const base = clone(deploysProduction[6]);
    const items = [
      // skipped: true wins over any state; "Cancelled build" (British spelling) is a cancel, not a failure.
      { ...base, id: "a1", state: "ready", skipped: true, created_at: "2026-10-07T09:00:00Z" },
      { ...base, id: "a2", state: "error", error_message: "Cancelled build by ada", created_at: "2026-10-07T08:59:00Z" },
      { ...base, id: "a3", state: "canceled", created_at: "2026-10-07T08:58:00Z" },
      // A genuine failure that merely mentions cancelling stays an error.
      { ...base, id: "a4", state: "error", error_message: "Build failed: step canceled build cache", created_at: "2026-10-07T08:57:00Z" },
      // No permalink → the site's https address; a bare host gains the scheme; plain http is dropped.
      { ...base, id: "a5", deploy_ssl_url: null, ssl_url: "trov-web.netlify.app", created_at: "2026-10-07T08:56:00Z" },
      { ...base, id: "a6", deploy_ssl_url: "http://insecure.example", ssl_url: null, created_at: "2026-10-07T08:55:00Z" },
      // No site name on the deploy and none on the part → the site's admin page.
      { ...base, id: "a7", name: null, created_at: "2026-10-07T08:54:00Z" },
      // An unknown context is a preview; none is unknown; a non-hex commit_ref is no sha.
      { ...base, id: "a8", context: "dev", commit_ref: "not-a-sha", created_at: "2026-10-07T08:53:00Z" },
      { ...base, id: "a9", context: null, committer: "  grace\nh  ", title: "\n\nOnly a body", created_at: "2026-10-07T08:52:00Z" },
    ];
    const f = stub(() => json(items));
    const res = await netlify.poll(ctx(f), part());
    const by = Object.fromEntries(res.deploys.map((d) => [d.id, d]));
    expect(by.a1.state).toBe("canceled");
    expect(by.a2.state).toBe("canceled");
    expect(by.a3.state).toBe("canceled");
    expect(by.a4.state).toBe("error");
    expect(by.a5.url).toBe("https://trov-web.netlify.app");
    expect(by.a6.url).toBeNull();
    expect(by.a7.inspectUrl).toBe("https://app.netlify.com/sites/trov-web");
    expect(by.a8).toMatchObject({ target: "preview", sha: null });
    expect(by.a9).toMatchObject({ target: null, by: "grace h", message: null });
    // Newest first, whatever order Netlify sent.
    const shuffled = stub(() => json([...items].reverse()));
    expect((await netlify.poll(ctx(shuffled), part())).deploys.map((d) => d.id)).toEqual(res.deploys.map((d) => d.id));
  });

  it("uses the part's site_name for the log link when the deploy carries none", async () => {
    const f = stub(() => json([{ ...clone(deploysProduction[6]), name: null }]));
    const res = await netlify.poll(ctx(f), part({ site_id: SITE_ID, site_name: "trov-web" }));
    expect(res.deploys[0].inspectUrl).toBe("https://app.netlify.com/sites/trov-web/deploys/6703d4a91b8a9e0008d4c1a7");
  });

  it("keeps at most 20 deploys", async () => {
    const base = clone(deploysProduction[6]);
    const many = Array.from({ length: 25 }, (_, i) => ({ ...base, id: `d${String(i).padStart(2, "0")}`, created_at: new Date(NOW - i * 60_000).toISOString() }));
    const f = stub(() => json(many));
    const res = await netlify.poll(ctx(f), part());
    expect(res.deploys).toHaveLength(20);
    expect(res.deploys[0].id).toBe("d00");
  });

  it("a body that is not a list throws — never read as 'no deploys'", async () => {
    const f = stub(() => json({ deploys: deploysProduction }));
    const e = await thrown(netlify.poll(ctx(f), part()));
    expect(e.message).toBe("netlify deploys: the response is not a list of deploys");
    const g = stub(() => new Response("<html>oops</html>", { status: 200 }));
    expect((await thrown(netlify.poll(ctx(g), part()))).message).toBe("netlify deploys: the response is not JSON");
  });

  it("a non-2xx throws a scrubbed HostingError", async () => {
    const f = stub(() => json({ code: 401, message: `token ${LONG_TOKEN} is revoked` }, 401));
    const e = await thrown(netlify.poll(ctx(f), part()));
    expect(e.message).toMatch(/^netlify deploys 401: token \[redacted\] is revoked — the token is not valid/);
    expect(allLeaks(e.message)).toEqual([]);

    // A token straddling the 8 KB read cap: the scrub cannot match half of it, so the tail is dropped.
    const straddle = `upstream exploded ${"y".repeat(8192 - 40)}${LONG_TOKEN} and more`;
    const g = stub(() => new Response(straddle, { status: 502 }));
    const e2 = await thrown(netlify.poll(ctx(g), part()));
    expect(e2.message).toMatch(/^netlify deploys 502: upstream exploded y+/);
    expect(allLeaks(e2.message)).toEqual([]);
    // And a whole token anywhere in a long body is scrubbed before the reason is cut.
    const g2 = stub(() => new Response(`gateway said ${LONG_TOKEN} ${"z".repeat(500)}`, { status: 503 }));
    const e2b = await thrown(netlify.poll(ctx(g2), part()));
    expect(e2b.message).toMatch(/^netlify deploys 503: gateway said \[redacted\] z+/);
    expect(allLeaks(e2b.message)).toEqual([]);

    const h = stub(() => new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } }));
    const e3 = await thrown(netlify.poll(ctx(h), part()));
    expect(e3.message).toBe("netlify deploys 302 — a redirect is never followed");
    expect(h.calls).toHaveLength(1);

    const k = stub(() => json(error404, 404));
    expect((await thrown(netlify.poll(ctx(k), part()))).message).toMatch(/^netlify deploys 404: Not Found — no site with this Site ID/);

    const t = stub(async () => { await later(); throw new DOMException("timed out", "TimeoutError"); });
    expect((await thrown(netlify.poll(ctx(t), part()))).message).toBe("netlify deploys: the request timed out");
  });

  it("every call stays on api.netlify.com, and the fetch it is handed refuses any other host", async () => {
    const f = stub((c) => (c.url.pathname.endsWith("/deploys") ? json(deploysBranch) : json(site)));
    await netlify.probe(ctx(f), part());
    await netlify.probe(ctx(f), null);
    await netlify.poll(ctx(f), part({ site_id: SITE_ID, context: "branch", branch: "staging" }));
    expect(f.calls.length).toBe(3);
    for (const c of f.calls) expect(`${c.url.protocol}//${c.url.host}`).toBe("https://api.netlify.com");
    await expect(f.fetch("https://app.netlify.com/authorize")).rejects.toBeInstanceOf(HostRefusedError);
    await expect(f.fetch("http://api.netlify.com/api/v1/user")).rejects.toBeInstanceOf(HostRefusedError);
    expect(f.calls.length).toBe(3);
  });
});

describe("netlify — OAuth install", () => {
  const install = netlify.install!;
  const REDIRECT = "https://trov.example/hosting/netlify/callback";

  it("sends the browser to app.netlify.com/authorize with the code-flow params, URL-encoded", () => {
    const url = new URL(install.authorizeUrl({ clientId: "client 123", redirectUri: REDIRECT, state: "st&ate=1", vars: {} }));
    expect(`${url.protocol}//${url.host}${url.pathname}`).toBe("https://app.netlify.com/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: "client 123", response_type: "code", redirect_uri: REDIRECT, state: "st&ate=1" });
    expect(url.search).not.toContain("st&ate");
  });

  it("exchanges the code (form POST to api.netlify.com/oauth/token), then reads the user for the label", async () => {
    const f = stub((c) => (c.url.pathname === "/oauth/token" ? json({ ...oauthToken, access_token: LONG_TOKEN }) : json(user)));
    const grant = await install.exchange({ fetch: f.fetch, code: CODE, clientId: "client-123", clientSecret: CLIENT_SECRET, redirectUri: REDIRECT, query: {} });
    expect(grant).toEqual({ accessToken: LONG_TOKEN, externalId: null, accountId: "5f9e2b7c4d1a3e0007c8b9a0", accountLabel: "Ada Lovelace", config: {} });
    expect(f.calls).toHaveLength(2);
    const [post, get] = f.calls;
    expect(`${post.url.protocol}//${post.url.host}${post.url.pathname}`).toBe("https://api.netlify.com/oauth/token");
    expect(post.method).toBe("POST");
    expect(post.url.search).toBe("");
    expect(post.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(post.headers.get("authorization")).toBeNull();
    expect(Object.fromEntries(new URLSearchParams(post.body ?? ""))).toEqual({
      grant_type: "authorization_code", code: CODE, client_id: "client-123", client_secret: CLIENT_SECRET, redirect_uri: REDIRECT,
    });
    expectAuthedGet(get, "/api/v1/user");
  });

  it("labels by email when there is no name, and drops an id that is not an id", async () => {
    const f = stub((c) => (c.url.pathname === "/oauth/token" ? json(oauthToken) : json({ ...clone(user), full_name: "", id: "a/b" })));
    const grant = await install.exchange({ fetch: f.fetch, code: CODE, clientId: "c", clientSecret: CLIENT_SECRET, redirectUri: REDIRECT, query: {} });
    expect(grant).toMatchObject({ accessToken: oauthToken.access_token, accountId: null, accountLabel: "ada@acme.dev" });
  });

  it("a refused exchange is a HostingError scrubbed of the client secret and the code", async () => {
    const echo = { ...oauthError, error: `invalid_grant for ${CODE} using ${CLIENT_SECRET}` };
    const f = stub(() => json(echo, 400));
    const e = await thrown(install.exchange({ fetch: f.fetch, code: CODE, clientId: "c", clientSecret: CLIENT_SECRET, redirectUri: REDIRECT, query: {} }));
    expect(e.message).toMatch(/^netlify token exchange 400: invalid_grant for \[redacted\] using \[redacted\] — the code expired/);
    expect(allLeaks(e.message)).toEqual([]);
    expect(f.calls).toHaveLength(1);
    const g = stub(() => json(oauthError, 400));
    const plain = await thrown(install.exchange({ fetch: g.fetch, code: CODE, clientId: "c", clientSecret: CLIENT_SECRET, redirectUri: REDIRECT, query: {} }));
    expect(plain.message).toMatch(/^netlify token exchange 400: invalid_grant — /);
  });

  it("no access token, or one that cannot be a header, fails the exchange", async () => {
    const f = stub(() => json({ token_type: "Bearer" }));
    const e = await thrown(install.exchange({ fetch: f.fetch, code: CODE, clientId: "c", clientSecret: CLIENT_SECRET, redirectUri: REDIRECT, query: {} }));
    expect(e.message).toBe("netlify token exchange: the response carries no access token");
    const g = stub(() => json({ access_token: "has a space\nand a newline" }));
    const e2 = await thrown(install.exchange({ fetch: g.fetch, code: CODE, clientId: "c", clientSecret: CLIENT_SECRET, redirectUri: REDIRECT, query: {} }));
    expect(e2.message).toBe("netlify token exchange: the access token is not in the expected form");
    expect(g.calls).toHaveLength(1);
  });

  it("a refused user read fails the exchange, scrubbed of the new token too", async () => {
    const f = stub((c) => (c.url.pathname === "/oauth/token"
      ? json({ ...oauthToken, access_token: LONG_TOKEN })
      : json({ code: 401, message: `bad token ${LONG_TOKEN} (client ${CLIENT_SECRET})` }, 401)));
    const e = await thrown(install.exchange({ fetch: f.fetch, code: CODE, clientId: "c", clientSecret: CLIENT_SECRET, redirectUri: REDIRECT, query: {} }));
    expect(e.message).toMatch(/^netlify user 401: bad token \[redacted\] \(client \[redacted\]\)/);
    expect(allLeaks(e.message)).toEqual([]);
  });

  it("a thrown fetch during the exchange is fixed text", async () => {
    const f = stub(async () => { await later(); throw new TypeError(`fetch failed: client_secret=${CLIENT_SECRET}&code=${CODE}`); });
    const e = await thrown(install.exchange({ fetch: f.fetch, code: CODE, clientId: "c", clientSecret: CLIENT_SECRET, redirectUri: REDIRECT, query: {} }));
    expect(e.message).toBe("netlify token exchange: the request failed");
  });
});

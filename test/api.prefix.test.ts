/**
 * ONE API prefix (multitenancy Phase 6): every tenant request the SPA makes goes to
 * `/api/o/<current slug>/…`, through one function (web/src/api.ts `apiUrl`) and one sender (`call`).
 *
 * The matrix below calls EVERY exported request function of api.ts against a recording `fetch` and
 * checks where it went — so a new function that names an old, unprefixed tenant path (or sends
 * around the sender) fails here without anyone remembering to add a case.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as api from "../web/src/api";

const sources = import.meta.glob("../web/src/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** Person-level and platform routes: the only paths that may go out without the org prefix. */
const GLOBAL = /^\/(?:auth|avatar|org-logo)\/|^\/api\/(?:orgs|invites|platform|billing)(?:[/?]|$)/;
const TENANT = /^\/api\/o\/acme\//;
/** Org settings' functions take the slug as an argument (`any` → "x"): still under an org's prefix. */
const ANY_ORG = /^\/api\/o\/[^/]+\//;

let asked: { method: string; url: string }[] = [];
const respond = (status = 200, body: unknown = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let answer: (url: string) => Response = () => respond();

beforeEach(() => {
  asked = [];
  answer = () => respond();
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    asked.push({ method: init?.method ?? "GET", url });
    return answer(url);
  });
  api.setApiOrg("acme");
  api.setOrgLostHandler(null);
});
afterEach(() => { vi.unstubAllGlobals(); api.setApiOrg(null); api.setOrgLostHandler(null); });

/** An argument that passes for anything: a string when coerced, an object with every key, callable. */
const any: unknown = new Proxy(function () { /* callable */ }, {
  get: (_t, k) => (k === Symbol.toPrimitive ? () => "x" : k === "toString" || k === "valueOf" ? () => "x" : k === "length" ? 1 : k === "then" ? undefined : any),
  has: (_t, k) => k !== "file",
  apply: () => any,
  ownKeys: () => [],
});
/** Not request functions: the prefix's own controls, and the error classes. */
const NOT_REQUESTS = new Set(["setApiOrg", "apiOrgSlug", "apiUrl", "tenantHref", "isGlobalPath", "setOrgLostHandler", "Unauthorized", "ApiError", "NotFound", "OrgApiError", "isRateLimited", "rateLimitText", "planLimitText"]);
/** Functions whose arguments must be real values (a Blob for a multipart body). */
const SPECIAL: Record<string, unknown[]> = {
  uploadAvatar: [new Blob(["x"]), "a.png"],
  uploadOrgLogo: ["x", new Blob(["x"]), "logo.png"],
  listArtifacts: [{ area: "ui", q: "x" }],
  createArtifact: [{ title: "t", kind: "markdown", area: "ui", repo: "", visibility: "org", summary: "s" }, { content: "c" }],
  addArtifactVersion: ["slug", { content: "c", summary: "s" }],
};
/** Alias-only requests (no `/api/o/:slug` form on the server). There are none: the invitation e-mail
 *  (`resendOrgInvite`) and raw artifact serving both have an org route now. */
const ALIAS_ONLY: Record<string, RegExp> = {};

const requestFns = Object.entries(api).filter(([name, v]) => typeof v === "function" && !NOT_REQUESTS.has(name)) as [string, (...a: unknown[]) => unknown][];

describe("apiUrl — the one prefix", () => {
  it("puts a tenant route under the current org, dropping the old /api/ of the routes that had one", () => {
    expect(api.apiUrl("/feed?limit=2")).toBe("/api/o/acme/feed?limit=2");
    expect(api.apiUrl("/tickets/12/status")).toBe("/api/o/acme/tickets/12/status");
    expect(api.apiUrl("/img/abc")).toBe("/api/o/acme/img/abc");
    expect(api.apiUrl("/api/handoffs?box=mine")).toBe("/api/o/acme/handoffs?box=mine");
    expect(api.apiUrl("/api/prompts/lint/publish")).toBe("/api/o/acme/prompts/lint/publish");
    expect(api.apiUrl("/api/docs/propose")).toBe("/api/o/acme/docs/propose");
    expect(api.apiUrl("/api/people/me/avatar")).toBe("/api/o/acme/people/me/avatar");
    expect(api.apiUrl("/api/artifacts/x/versions")).toBe("/api/o/acme/artifacts/x/versions");
    expect(api.apiUrl("/api/notifications/prefs")).toBe("/api/o/acme/notifications/prefs");
    expect(api.apiUrl("/mcp-tokens")).toBe("/api/o/acme/mcp-tokens");
    // `/docs` is the org's docs — only `/api/docs/…` loses a segment.
    expect(api.apiUrl("/docs?fields=meta")).toBe("/api/o/acme/docs?fields=meta");
  });
  it("leaves person-level and platform routes alone", () => {
    for (const p of ["/auth/me", "/auth/oauth-grants/3/revoke", "/avatar/abc", "/org-logo/abc", "/api/orgs", "/api/invites/3/accept", "/api/platform/usage?days=30", "/api/o/other/settings"]) {
      expect(api.apiUrl(p), p).toBe(p);
      expect(api.isGlobalPath(p), p).toBe(true);
    }
    // Look-alikes are tenant routes: `/api/orgsx`, `/authx`.
    expect(api.apiUrl("/api/orgsx")).toBe("/api/o/acme/orgsx");
  });
  it("billing: the waiting room's poll and the pricing page's question are person-level; an org's billing is that org's", async () => {
    for (const p of ["/api/billing/status?session_id=cs_test_1", "/api/billing/config"]) {
      expect(api.isGlobalPath(p), p).toBe(true);
      expect(api.apiUrl(p), p).toBe(p);
    }
    expect(api.apiUrl("/api/billingx")).toBe("/api/o/acme/billingx");
    api.setApiOrg(null); // the buyer has no org yet: both still go out
    await api.getBillingStatus("cs test/1");
    await api.getBillingConfig();
    await api.openBillingPortal("big co");
    await api.changeBillingPlan("acme", "team");
    await api.renewBilling("acme", "personal");
    expect(asked).toEqual([
      { method: "GET", url: "/api/billing/status?session_id=cs%20test%2F1" }, { method: "GET", url: "/api/billing/config" },
      { method: "POST", url: "/api/o/big%20co/billing/portal" }, { method: "POST", url: "/api/o/acme/billing/change" }, { method: "POST", url: "/api/o/acme/billing/renew" },
    ]);
  });
  it("follows the org it is given, encoded", () => {
    api.setApiOrg("big-co");
    expect(api.apiUrl("/feed")).toBe("/api/o/big-co/feed");
    expect(api.apiOrgSlug()).toBe("big-co");
  });
  it("with NO org open a tenant request is refused before it is sent — never the unprefixed alias", async () => {
    api.setApiOrg(null);
    expect(() => api.apiUrl("/feed")).toThrow("org_required");
    await expect(api.getFeed()).rejects.toMatchObject({ status: 409, message: "org_required" });
    expect(asked).toEqual([]);
    expect(api.tenantHref("/img/abc")).toBe("#");
    // A person-level read still goes out.
    await api.getMe().catch(() => undefined);
    expect(asked.map((a) => a.url)).toEqual(["/auth/me"]);
  });
});

describe("every request function of api.ts", () => {
  it("is exercised here (so the matrix cannot go stale)", () => {
    expect(requestFns.length).toBeGreaterThan(100);
  });

  it("sends a tenant path under /api/o/<slug>/, a person-level one as written, and nothing else", async () => {
    const offenders: string[] = [];
    const silent: string[] = [];
    for (const [name, fn] of requestFns) {
      asked = [];
      try { await Promise.resolve(fn(...(SPECIAL[name] ?? [any, any, any, any]))).catch(() => undefined); }
      catch { /* a synchronous refusal: counted below as having sent nothing */ }
      if (asked.length === 0) { silent.push(name); continue; }
      for (const { url } of asked) {
        const path = url.replace(/^https?:\/\/[^/]+/, "");
        const allowed = ALIAS_ONLY[name] ? ALIAS_ONLY[name].test(path) : ANY_ORG.test(path) || GLOBAL.test(path);
        if (!allowed) offenders.push(`${name} -> ${path}`);
      }
    }
    expect(offenders, "requests outside the org prefix").toEqual([]);
    expect(silent, "functions that sent nothing (give them real arguments in SPECIAL)").toEqual([]);
  });

  it("the tenant ones really are tenant: most of the surface carries the slug", async () => {
    let tenant = 0;
    for (const [name, fn] of requestFns) {
      asked = [];
      try { await Promise.resolve(fn(...(SPECIAL[name] ?? [any, any, any, any]))).catch(() => undefined); } catch { /* as above */ }
      if (asked.some((a) => TENANT.test(a.url))) tenant++;
    }
    expect(tenant).toBeGreaterThan(70);
  });

  it("carries the session cookie and asks for JSON, whatever the method", async () => {
    const seen: RequestInit[] = [];
    vi.stubGlobal("fetch", async (_u: unknown, init?: RequestInit) => { seen.push(init ?? {}); return respond(); });
    await api.getFeed();
    await api.createTicket({ title: "t" } as never);
    await api.getMyOrgs();
    for (const init of seen) {
      expect(init.credentials).toBe("same-origin");
      expect((init.headers as Record<string, string>).accept).toBe("application/json");
    }
    expect((seen[1].headers as Record<string, string>)["content-type"]).toBe("application/json");
  });
});

describe("plans and grants (0044_plans)", () => {
  it("an org's plan is read under that org; grants and plan changes are platform routes, as written; creating an org names its grant", async () => {
    const sent: { method: string; url: string; body: string | null }[] = [];
    vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => { sent.push({ method: init?.method ?? "GET", url: String(input), body: typeof init?.body === "string" ? init.body : null }); return respond(); });
    await api.getOrgPlan("acme").catch(() => undefined);
    await api.listPlatformGrants().catch(() => undefined);
    await api.createPlatformGrant({ to: { email: "a@b.io" }, plan: "team" }).catch(() => undefined);
    await api.revokePlatformGrant(7).catch(() => undefined);
    await api.setPlatformOrgPlan("big co", { plan: "enterprise", overrides: { seats: 40 } }).catch(() => undefined);
    await api.createOrg({ slug: "new-co", name: "New Co", grant: 4 }).catch(() => undefined);
    expect(sent.map((a) => `${a.method} ${a.url}`)).toEqual([
      "GET /api/o/acme/plan", "GET /api/platform/grants", "POST /api/platform/grants", "POST /api/platform/grants/7/revoke",
      "PUT /api/platform/orgs/big%20co/plan", "POST /api/orgs",
    ]);
    expect(JSON.parse(sent[5].body ?? "null")).toEqual({ slug: "new-co", name: "New Co", grant: 4 });
    expect(JSON.parse(sent[4].body ?? "null")).toEqual({ plan: "enterprise", overrides: { seats: 40 } });
  });

  it("a 402 plan_limit keeps the server's refusal on the error, from every sender; planLimitText is its one sentence", async () => {
    const refusal = { error: "plan_limit", limit: "seats", used: 10, cap: 10, plan: "team", status: "active", message: "This organization has reached the 10 seats its Team plan includes." };
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(refusal), { status: 402, headers: { "content-type": "application/json" } }));
    const errors = await Promise.all([
      api.createOrgInvite("acme", { github_login: "x", role: "member" }).catch((e: unknown) => e),                       // the org sender
      api.createArtifact({ title: "t", kind: "markdown", area: "ui", repo: "", visibility: "org", summary: "s" } as never, { content: "c" }).catch((e: unknown) => e), // the artifact sender
      api.createTicket({ title: "t" } as never).catch((e: unknown) => e),                                                 // the plain sender
    ]);
    for (const e of errors) {
      expect(e).toBeInstanceOf(api.ApiError);
      expect((e as InstanceType<typeof api.ApiError>).status).toBe(402);
      expect((e as InstanceType<typeof api.ApiError>).plan).toEqual(refusal);
    }
    expect(api.planLimitText(errors[0], "owner")).toBe("This organization has reached the 10 seats its Team plan includes. Ask Trov to change your plan.");
    expect(api.planLimitText(errors[0], "admin")).toBe("This organization has reached the 10 seats its Team plan includes. Ask one of this organization's owners.");
    expect(api.planLimitText(new api.ApiError(403, "forbidden"), "owner")).toBeNull();
    expect(api.planLimitText(new Error("offline"), "owner")).toBeNull();
  });
});

describe("the SPA sends nothing around the prefix", () => {
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/([^:"'`])\/\/ .*$/gm, "$1");
  const files = Object.entries(sources).map(([path, src]) => ({ name: path.split("/").pop()!, src: code(src) }));

  it("only api.ts calls fetch — its sender, and the membership probe", () => {
    for (const f of files) {
      // A call, not a declaration (`fetch(q: string, …)` in an interface is a dependency's name).
      const calls = f.src.match(/(?<![.\w])fetch\((?!\w+: )/g) ?? [];
      expect(calls.length, f.name).toBe(f.name === "api.ts" ? 2 : 0);
    }
  });

  it("no other module spells an /api/ URL unless it hands it to the prefix function", () => {
    for (const f of files) {
      if (f.name === "api.ts" || f.name === "releases.ts") continue;   // releases.ts is history: its notes quote old routes
      const bare = f.src.replace(/(?:apiUrl|tenantHref)\((["'`])\/api\/[^"'`]*\1\)/g, "");
      expect(bare.match(/["'`]\/api\/(?:o|orgs|invites|platform|handoffs|prompts|docs|people|artifacts|notifications)\b/g) ?? [], f.name).toEqual([]);
    }
  });

  it("a doc image and the raw artifact route are the only tenant URLs built outside api.ts, each through its one function", () => {
    const literal = /["'`=]\/(?:img|raw\/a|feed|docs?|tickets|sprints|persons|roadmap|search|invites|proposals|adrs)\//;
    for (const f of files) {
      if (f.name === "api.ts" || f.name === "releases.ts") continue;
      const bare = f.src.replace(/(?:apiUrl|tenantHref)\(`\/img\/\$\{[^}]+\}`\)/g, "");
      const hits = bare.split("\n").filter((l) => literal.test(l));
      // artifacts.ts: the raw route is named in ONE place — `rawUrl` and its `rawOf` twin for the API's own
      // `raw_url` — and both go through `tenantHref`, so a raw page is always the current org's.
      if (f.name === "artifacts.ts") {
        expect(hits).toHaveLength(2);
        expect(hits[0]).toContain("export const rawUrl");
        expect(hits[0]).toContain("tenantHref(`/raw/a/");
        expect(hits[1]).toContain('apiRawUrl.startsWith("/raw/a/") ? tenantHref(apiRawUrl)');
      } else expect(hits, f.name).toEqual([]);
    }
  });
});

describe("429 rate_limited — one sentence, wherever a limited route is called", () => {
  const limited = (retry_after?: number) => () => new Response(JSON.stringify({ error: "rate_limited", ...(retry_after === undefined ? {} : { retry_after }) }), { status: 429, headers: { "content-type": "application/json" } });
  const NOW = new Date(2026, 9, 6, 14, 30, 0); // a local 2:30 pm
  const caught = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

  it("every limited call carries `retry_after`: invites, resend, test send, the notification address, an avatar upload, the handle check", async () => {
    answer = limited(5400);
    const calls: [string, () => Promise<unknown>][] = [
      ["createOrgInvite", () => api.createOrgInvite("acme", { email: "a@b.co", role: "member" })],
      ["resendOrgInvite", () => api.resendOrgInvite("acme", 3)],
      ["testSendNotification", () => api.testSendNotification("daily")],
      ["putNotificationPrefs", () => api.putNotificationPrefs({ email: "a@b.co" })],
      ["uploadAvatar", () => api.uploadAvatar(new Blob(["x"]), "a.png")],
      ["uploadOrgLogo", () => api.uploadOrgLogo("acme", new Blob(["x"]), "logo.png")],
      ["checkHandle", () => api.checkHandle("someone")],
    ];
    for (const [name, call] of calls) {
      const e = await caught(call());
      expect(api.isRateLimited(e), name).toBe(true);
      expect((e as api.ApiError).retryAfter, name).toBe(5400);
      expect(api.rateLimitText(e, NOW), name).toMatch(/^You've hit today's limit for this; try again after \d{1,2}[:.]\d\d/);
    }
  });

  it("says the local time the limit turns over — with the weekday when that is not today — and never a raw code", () => {
    const err = (retryAfter: number | null) => Object.assign(new api.ApiError(429, "rate_limited"), { retryAfter });
    const at4 = new Date(NOW.getTime() + 5400_000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    expect(api.rateLimitText(err(5400), NOW)).toBe(`You've hit today's limit for this; try again after ${at4}.`);
    const tomorrow = new Date(NOW.getTime() + 20 * 3600_000);
    expect(api.rateLimitText(err(20 * 3600), NOW)).toBe(
      `You've hit today's limit for this; try again after ${tomorrow.toLocaleDateString(undefined, { weekday: "long" })} ${tomorrow.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}.`);
    expect(api.rateLimitText(err(null), NOW)).toBe("You've hit today's limit for this; try again later.");
    expect(api.rateLimitText(new api.ApiError(409, "invite_exists"), NOW)).toBeNull();
    expect(api.rateLimitText(new Error("offline"), NOW)).toBeNull();
  });

  it("Org settings shows that sentence for a limited invite — and has no message for `email_in_use`, which is never returned any more", async () => {
    const { orgErrorText } = await import("../web/src/org-actions");
    const e = Object.assign(new api.OrgApiError(429, "rate_limited", null, null), { retryAfter: 60 });
    expect(orgErrorText(e, "Couldn't send the invite.")).toMatch(/^You've hit today's limit for this; try again after /);
    for (const [path, src] of Object.entries(sources)) expect(src, path).not.toContain("email_in_use");
  });
});

describe("the raw artifact route is the current org's", () => {
  it("rawUrl and every place the SPA loads a raw page name /api/o/<slug>/raw/a/…, never the bare alias", async () => {
    const art = await import("../web/src/artifacts");
    api.setApiOrg("acme");
    expect(art.rawUrl("login mock", 3)).toBe("/api/o/acme/raw/a/login%20mock@v3");
    expect(api.apiUrl("/raw/a/x@v1?download=1")).toBe("/api/o/acme/raw/a/x@v1?download=1");
    api.setApiOrg("other-org");
    expect(art.rawUrl("x", 1)).toBe("/api/o/other-org/raw/a/x@v1");
    api.setApiOrg(null);
    expect(art.rawUrl("x", 1)).toBe("#"); // no org open: inert, never the unprefixed alias
    api.setApiOrg("acme");
    const src = Object.entries(sources).find(([path]) => path.endsWith("/artifacts.ts"))![1];
    expect(src).not.toMatch(/rawAvailable|rawUnavailable|only open for people in exactly one organization/);
  });
});

describe("a 404 from an org's route asks the membership gate — once", () => {
  it("lost the org (the gate's /me is a 404 too): the handler gets the slug", async () => {
    const lost: string[] = [];
    api.setOrgLostHandler((slug) => lost.push(slug));
    answer = () => respond(404, { error: "not_found" });
    await api.getTicket(7).catch(() => undefined);
    await api.getFeed().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
    expect(asked.map((a) => a.url)).toContain("/api/o/acme/me");
    expect(asked.filter((a) => a.url === "/api/o/acme/me").length).toBeLessThanOrEqual(2);
    expect(lost[0]).toBe("acme");
  });
  it("a missing ticket in an org that is still mine is just a missing ticket", async () => {
    const lost: string[] = [];
    api.setOrgLostHandler((slug) => lost.push(slug));
    answer = (url) => (url === "/api/o/acme/me" ? respond(200, { org: { slug: "acme", name: "Acme" }, role: "member" }) : respond(404, { error: "not found" }));
    await expect(api.getTicket(7)).rejects.toMatchObject({ status: 404 });
    await new Promise((r) => setTimeout(r, 0));
    expect(asked.map((a) => a.url)).toEqual(["/api/o/acme/tickets/7", "/api/o/acme/me"]);
    expect(lost).toEqual([]);
  });
  it("a person-level 404 never asks", async () => {
    api.setOrgLostHandler(() => { throw new Error("must not run"); });
    answer = () => respond(404, { error: "not_found" });
    await api.respondToInvite(3, true).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
    expect(asked.map((a) => a.url)).toEqual(["/api/invites/3/accept"]);
  });
  it("a 401 is Unauthorized, on any route", async () => {
    answer = () => respond(401, { error: "unauthorized" });
    await expect(api.getFeed()).rejects.toBeInstanceOf(api.Unauthorized);
    await expect(api.getMyOrgs()).rejects.toBeInstanceOf(api.Unauthorized);
    await expect(api.listArtifacts()).rejects.toBeInstanceOf(api.Unauthorized);
  });
});

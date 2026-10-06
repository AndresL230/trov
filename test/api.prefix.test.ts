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
const GLOBAL = /^\/(?:auth|avatar)\/|^\/api\/(?:orgs|invites|platform)(?:[/?]|$)/;
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
const NOT_REQUESTS = new Set(["setApiOrg", "apiOrgSlug", "apiUrl", "tenantHref", "isGlobalPath", "setOrgLostHandler", "Unauthorized", "ApiError", "NotFound", "OrgApiError", "isRateLimited", "rateLimitText"]);
/** Functions whose arguments must be real values (a Blob for a multipart body). */
const SPECIAL: Record<string, unknown[]> = {
  uploadAvatar: [new Blob(["x"]), "a.png"],
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
    for (const p of ["/auth/me", "/auth/oauth-grants/3/revoke", "/avatar/abc", "/api/orgs", "/api/invites/3/accept", "/api/platform/usage?days=30", "/api/o/other/settings"]) {
      expect(api.apiUrl(p), p).toBe(p);
      expect(api.isGlobalPath(p), p).toBe(true);
    }
    // Look-alikes are tenant routes: `/api/orgsx`, `/authx`.
    expect(api.apiUrl("/api/orgsx")).toBe("/api/o/acme/orgsx");
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
      // artifacts.ts `rawUrl`: alias-only on the server (no /api/o/:slug form yet), gated by `setRawAvailable`.
      if (f.name === "artifacts.ts") { expect(hits).toHaveLength(1); expect(hits[0]).toContain("export const rawUrl"); }
      else expect(hits, f.name).toEqual([]);
    }
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

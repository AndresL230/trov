// The GitHub App's install flow (src/github-app/install.ts; spec §8): `POST /api/o/:slug/github/install`
// seals the `gh_install` cookie, and `GET /github/app/setup` — GitHub's Setup URL and Callback URL — binds
// the installation only for the admin who started it, after their OWN GitHub token proves they can read every
// repository it covers. Driven through the production gates (sessionGate → platformContext → soleTenantGate →
// tenantGate) with a fake GitHub; asserted in real D1. Every refusal is a page and writes nothing.
import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import type { Env } from "../src/env";
import { sessionGate, type AppEnv } from "../src/auth/principal";
import { platformContext, soleTenantGate, tenantGate } from "../src/data/gate";
import { b64uDecode, hmacUnseal } from "../src/auth/crypto";
import { app as realApp } from "../src/routes";
import { buildGithubAppSetupApp, buildGithubAppTenantApp } from "../src/github-app/routes";
import { GH_INSTALL_COOKIE, type InstallDeps, type InstallState } from "../src/github-app/install";
import { installRefusalPage } from "../src/github-app/pages";
import { all, first } from "./helpers/db";
import { cookieFor } from "./helpers/persons";
import { ORG_A, ORG_B, ensureMember } from "./helpers/tenant";
import { HOOK_A, seedOrgSettings } from "./helpers/integrations";
import { APP, USER_TOKEN, appEnv, fakeAppGithub, installationToken, makeAppKeys, seedInstallation, type AppCall, type FakeAppGithub } from "./helpers/github-app";

const ID = 4242;
const T0 = 1_791_300_000_000; // 2026-10-06 — the flow's clock
const SECRET = "test-cookie-secret";
const OWNER = "AndresL230";
const SAPLING = { id: 101, full_name: "SaplingLearn/sapling" };
const PLANS = { id: 102, full_name: "SaplingLearn/secret-plans", private: true };
const INSTALLATION = (id: number) => ({ id, account: { login: "SaplingLearn", id: 9001, type: "Organization" }, repository_selection: "selected", suspended_at: null });

afterEach(() => { vi.restoreAllMocks(); });

// ── harness ──────────────────────────────────────────────────────────────────

/** The production gate chain around the GitHub App's two sub-apps, built with a fake GitHub and a clock. */
function appWith(deps: InstallDeps): Hono<AppEnv> {
  const a = new Hono<AppEnv>();
  a.use("*", sessionGate);
  a.use("*", platformContext);
  a.use("*", soleTenantGate);
  a.use("/api/o/:slug/*", tenantGate);
  a.route("/api/o/:slug", buildGithubAppTenantApp(deps));
  a.route("/", buildGithubAppSetupApp(deps));
  return a;
}

interface Seen { status: number; body: string; headers: [string, string][]; location: string | null; setCookies: string[] }
async function seen(res: Response): Promise<Seen> {
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  const setCookies = typeof h.getSetCookie === "function" ? h.getSetCookie() : (h.get("set-cookie") ? [h.get("set-cookie")!] : []);
  return { status: res.status, body: await res.text(), headers: [...res.headers], location: res.headers.get("location"), setCookies };
}

/** `gh_install`'s new value from a response ('' when it was cleared), or undefined when untouched. */
const ghCookieOf = (r: Seen): string | undefined => {
  const line = r.setCookies.find((l) => l.startsWith(`${GH_INSTALL_COOKIE}=`));
  return line === undefined ? undefined : /^gh_install=([^;]*)/.exec(line)![1];
};
const cleared = (r: Seen): boolean => r.setCookies.some((l) => l.startsWith(`${GH_INSTALL_COOKIE}=;`) && /Max-Age=0/i.test(l));

async function openCookie(value: string): Promise<InstallState> {
  const v = await hmacUnseal(value, `gh-install:${SECRET}`);
  expect(v).not.toBeNull();
  return JSON.parse(b64uDecode(v!)) as InstallState;
}

interface Flow { a: Hono<AppEnv>; e: Env; calls: AppCall[]; clock: { now: number } }
async function flow(fake: FakeAppGithub = {}, wrap?: (f: typeof fetch) => typeof fetch): Promise<Flow> {
  const { fetchImpl, calls } = fakeAppGithub({ installation: INSTALLATION, repos: [SAPLING], ...fake });
  const clock = { now: T0 };
  return { a: appWith({ fetchImpl: wrap ? wrap(fetchImpl) : fetchImpl, now: () => clock.now }), e: await appEnv(), calls, clock };
}

const get = async (f: Flow, path: string, cookie: string | null): Promise<Seen> =>
  seen(await f.a.request(path, { headers: cookie ? { cookie } : {} }, f.e));

/** `POST /api/o/<slug>/github/install` as `cookie`. */
async function start(f: Flow, cookie: string, slug = "saplinglearn"): Promise<Seen & { gh: string; nonce: string }> {
  const r = await seen(await f.a.request(`/api/o/${slug}/github/install`, { method: "POST", headers: { cookie } }, f.e));
  expect(r.status, r.body).toBe(200);
  const url = new URL((JSON.parse(r.body) as { url: string }).url);
  return { ...r, gh: ghCookieOf(r)!, nonce: url.searchParams.get("state")! };
}

/** Start, then GitHub's first hop back (installation_id + state): the cookie the code hop sends. */
async function firstHop(f: Flow, session: string, id = ID): Promise<{ gh: string; nonce: string; hop: Seen }> {
  const s = await start(f, session);
  const hop = await get(f, `/github/app/setup?installation_id=${id}&setup_action=install&state=${encodeURIComponent(s.nonce)}`, `${session}; gh_install=${s.gh}`);
  expect(hop.status, hop.body).toBe(302);
  return { gh: ghCookieOf(hop)!, nonce: s.nonce, hop };
}

const codeHop = (f: Flow, session: string, gh: string, query: string): Promise<Seen> =>
  get(f, `/github/app/setup?${query}`, `${session}; gh_install=${gh}`);

/** Everything the flow could have written, in both orgs. */
const written = async () => JSON.stringify({
  inst: await all(env.DB, `SELECT * FROM github_installations ORDER BY installation_id`),
  repos: await all(env.DB, `SELECT * FROM github_installation_repos ORDER BY installation_id, repo_id`),
  orgRepos: await all(env.DB, `SELECT id, org_id, installation_id FROM org_repos ORDER BY id`),
  audit: await all(env.DB, `SELECT org_id, actor, action, target, detail FROM org_admin_audit ORDER BY id`),
});

const isPage = (r: Seen, status: number, title: RegExp) => {
  expect([r.status, r.body.slice(0, 200)]).toEqual([status, expect.stringContaining("<!doctype html>")]);
  expect(r.body).toMatch(title);
  expect(r.headers).toEqual(expect.arrayContaining([["cache-control", "no-store"], ["referrer-policy", "no-referrer"], ["x-frame-options", "DENY"]]));
  expect(r.headers.find(([k]) => k === "content-security-policy")?.[1]).toContain("default-src 'none'");
};

const githubCalls = (calls: AppCall[]) => calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);

// ── start ────────────────────────────────────────────────────────────────────

describe("POST /api/o/:slug/github/install", () => {
  it("seals gh_install (path /github/app, HttpOnly, Secure, Lax, 30 minutes) and answers GitHub's install URL with the nonce as state", async () => {
    const f = await flow();
    const s = await start(f, await cookieFor(OWNER));
    const url = new URL((JSON.parse(s.body) as { url: string }).url);
    expect(`${url.origin}${url.pathname}`).toBe(`https://github.com/apps/${APP.slug}/installations/new`);
    expect([...url.searchParams.keys()]).toEqual(["state"]);
    expect(s.nonce.length).toBeGreaterThanOrEqual(32);
    const line = s.setCookies.find((l) => l.startsWith("gh_install="))!;
    for (const attr of ["Path=/github/app", "HttpOnly", "Secure", "SameSite=Lax", "Max-Age=1800"]) expect(line).toContain(attr);
    expect(await openCookie(s.gh)).toEqual({ org: ORG_A, slug: "saplinglearn", handle: OWNER, nonce: s.nonce, exp: T0 + 1_800_000 });
    expect(s.headers).toEqual(expect.arrayContaining([["cache-control", "no-store"]]));
    expect(f.calls).toEqual([]); // nothing asked of GitHub yet
    // A second start is a fresh nonce.
    expect((await start(f, await cookieFor(OWNER))).nonce).not.toBe(s.nonce);
  });

  it("503 github_app_not_configured when the App's secrets are absent — no cookie", async () => {
    const f = await flow();
    const res = await seen(await f.a.request("/api/o/saplinglearn/github/install", { method: "POST", headers: { cookie: await cookieFor(OWNER) } }, env));
    expect([res.status, JSON.parse(res.body)]).toEqual([503, { error: "github_app_not_configured", message: expect.any(String) }]);
    expect(ghCookieOf(res)).toBeUndefined();
  });

  it("a member is 403, an Authorization header is 403 even for the owner — no cookie either way", async () => {
    const f = await flow();
    await ensureMember("mona", "member");
    const member = await seen(await f.a.request("/api/o/saplinglearn/github/install", { method: "POST", headers: { cookie: await cookieFor("mona") } }, f.e));
    expect([member.status, JSON.parse(member.body)]).toEqual([403, { error: "forbidden" }]);
    const bearer = await seen(await f.a.request("/api/o/saplinglearn/github/install", { method: "POST", headers: { cookie: await cookieFor(OWNER), authorization: "Bearer trov_mcp_x" } }, f.e));
    expect([bearer.status, JSON.parse(bearer.body).error]).toEqual([403, "forbidden"]);
    for (const r of [member, bearer]) expect(ghCookieOf(r)).toBeUndefined();
    // Another org's slug — not a member — is the gate's 404.
    expect((await f.a.request("/api/o/acme/github/install", { method: "POST", headers: { cookie: await cookieFor(OWNER) } }, f.e)).status).toBe(404);
  });
});

// ── the callback's gates ─────────────────────────────────────────────────────

describe("GET /github/app/setup — who may finish a flow", () => {
  it("no session, no cookie, someone else's cookie, an expired one, a tampered one: a refusal page, nothing written, nothing asked of GitHub", async () => {
    await seedOrgSettings();
    const f = await flow();
    const owner = await cookieFor(OWNER);
    await ensureMember("ada", "admin");
    const ada = await cookieFor("ada");
    const before = await written();
    const { gh, nonce } = await firstHop(f, owner);
    f.calls.length = 0;
    const q = `code=abc123&state=${encodeURIComponent(nonce)}`;

    const noSession = await get(f, `/github/app/setup?${q}`, `gh_install=${gh}`);
    isPage(noSession, 403, /Sign in to Trov first/);
    const noCookie = await get(f, `/github/app/setup?${q}`, owner);
    isPage(noCookie, 403, /No setup in progress/);
    const othersCookie = await codeHop(f, ada, gh, q); // ada is an admin of the same org — still not her flow
    isPage(othersCookie, 403, /This setup isn(&#39;|')t yours/);
    expect(othersCookie.body).not.toContain("/o/saplinglearn"); // someone else's flow names their org: never linked
    const tampered = await codeHop(f, owner, gh.replace(/.$/, (ch) => (ch === "A" ? "B" : "A")), q);
    isPage(tampered, 403, /No setup in progress/);
    f.clock.now = T0 + 31 * 60_000;
    const expired = await codeHop(f, owner, gh, q);
    isPage(expired, 403, /This setup expired/);

    for (const r of [noSession, noCookie, othersCookie, tampered, expired]) expect(cleared(r)).toBe(true);
    expect(f.calls).toEqual([]);
    expect(await written()).toBe(before);
  });

  it("an admin demoted to member — or removed — since they clicked Install connects nothing", async () => {
    await seedOrgSettings();
    const f = await flow();
    await ensureMember("ada", "admin");
    const ada = await cookieFor("ada");
    const { gh, nonce } = await firstHop(f, ada);
    f.calls.length = 0;
    const before = await written();
    await ensureMember("ada", "member");
    const demoted = await codeHop(f, ada, gh, `code=abc123&state=${encodeURIComponent(nonce)}`);
    isPage(demoted, 403, /Admins only/);
    expect(demoted.body).toContain(`href="/o/saplinglearn/#org/repos"`); // still a member: the link back is hers
    await env.DB.prepare(`DELETE FROM memberships WHERE org_id = ? AND user_id = ?`).bind(ORG_A, "ada").run();
    const removed = await codeHop(f, ada, gh, `code=abc123&state=${encodeURIComponent(nonce)}`);
    isPage(removed, 403, /Not a member/);
    expect(removed.body).toContain(`href="/"`);
    expect(f.calls).toEqual([]);
    expect(await written()).toBe(before);
  });

  it("through the real app: public to sessionGate (a page, not a bare 401), and a person in two orgs is not soleTenantGate's 409", async () => {
    const e = await appEnv();
    const noSession = await seen(await realApp.request("/github/app/setup?installation_id=1&setup_action=install", {}, e));
    isPage(noSession, 403, /Sign in to Trov first/);
    await ensureMember(OWNER, "owner", ORG_B); // the owner of A is now in two orgs
    const twoOrgs = await seen(await realApp.request("/github/app/setup?installation_id=1&setup_action=install", { headers: { cookie: await cookieFor(OWNER) } }, e));
    isPage(twoOrgs, 403, /No setup in progress/);
    // …and the start route, through the real mounts, sets a cookie the real callback accepts (first hop: no GitHub call).
    const started = await seen(await realApp.request("/api/o/saplinglearn/github/install", { method: "POST", headers: { cookie: await cookieFor(OWNER) } }, e));
    expect(started.status).toBe(200);
    const nonce = new URL((JSON.parse(started.body) as { url: string }).url).searchParams.get("state")!;
    const hop = await seen(await realApp.request(`/github/app/setup?installation_id=${ID}&state=${nonce}`, { headers: { cookie: `${await cookieFor(OWNER)}; gh_install=${ghCookieOf(started)}` } }, e));
    expect(hop.status).toBe(302);
    expect(hop.location).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize\?/);
  });
});

// ── the hops ─────────────────────────────────────────────────────────────────

describe("GET /github/app/setup — the hops", () => {
  it("setup_action=request (an owner must approve on GitHub) → back to the org, flow over, nothing written", async () => {
    const f = await flow();
    const owner = await cookieFor(OWNER);
    const s = await start(f, owner);
    const before = await written();
    const r = await get(f, `/github/app/setup?setup_action=request&state=${s.nonce}`, `${owner}; gh_install=${s.gh}`);
    expect([r.status, r.location]).toEqual([302, "/o/saplinglearn/#org/repos?github=requested"]);
    expect(cleared(r)).toBe(true);
    expect(f.calls).toEqual([]);
    expect(await written()).toBe(before);
  });

  it("first hop: re-seals the cookie with the installation id and sends the browser to GitHub's authorize, state = nonce, redirect_uri = the setup URL", async () => {
    const f = await flow();
    const owner = await cookieFor(OWNER);
    const { gh, nonce, hop } = await firstHop(f, owner);
    const loc = new URL(hop.location!);
    expect(`${loc.origin}${loc.pathname}`).toBe("https://github.com/login/oauth/authorize");
    expect(Object.fromEntries(loc.searchParams)).toEqual({ client_id: APP.clientId, state: nonce, redirect_uri: "http://localhost/github/app/setup" });
    expect(await openCookie(gh)).toEqual({ org: ORG_A, slug: "saplinglearn", handle: OWNER, nonce, exp: T0 + 1_800_000, installation_id: ID });
    const line = hop.setCookies.find((l) => l.startsWith("gh_install="))!;
    for (const attr of ["Path=/github/app", "HttpOnly", "Secure", "SameSite=Lax"]) expect(line).toContain(attr);
    expect(hop.headers).toEqual(expect.arrayContaining([["cache-control", "no-store"], ["referrer-policy", "no-referrer"]]));
    expect(f.calls).toEqual([]);
  });

  it("first hop: an installation id that is not digits-only, or a state that is not this flow's, is refused", async () => {
    const f = await flow();
    const owner = await cookieFor(OWNER);
    for (const bad of ["12abc", "-1", "0", "1e3", "0012", "99999999999999999", ""]) {
      const s = await start(f, owner);
      const r = await get(f, `/github/app/setup?installation_id=${encodeURIComponent(bad)}&state=${s.nonce}`, `${owner}; gh_install=${s.gh}`);
      isPage(r, 400, /Unreadable installation/);
    }
    const s = await start(f, owner);
    isPage(await get(f, `/github/app/setup?installation_id=${ID}&state=someone-elses`, `${owner}; gh_install=${s.gh}`), 403, /isn(&#39;|')t yours/);
    isPage(await get(f, `/github/app/setup?setup_action=install&state=${s.nonce}`, `${owner}; gh_install=${s.gh}`), 400, /No installation/);
    expect(f.calls).toEqual([]);
  });

  it("a code with no state, or another flow's state, is refused before GitHub is asked anything", async () => {
    await seedOrgSettings();
    const f = await flow();
    const owner = await cookieFor(OWNER);
    const { gh, nonce } = await firstHop(f, owner);
    const before = await written();
    isPage(await codeHop(f, owner, gh, "code=abc123"), 403, /This sign-in isn(&#39;|')t yours/);
    isPage(await codeHop(f, owner, gh, `code=abc123&state=${nonce}x`), 403, /This sign-in isn(&#39;|')t yours/);
    isPage(await codeHop(f, owner, gh, `code=${encodeURIComponent("a/b")}&state=${nonce}`), 400, /Unreadable sign-in/);
    expect(f.calls).toEqual([]);
    expect(await written()).toBe(before);
  });
});

// ── verification ─────────────────────────────────────────────────────────────

describe("GET /github/app/setup — an installation id from the query is never trusted", () => {
  it("a FORGED id — one the person's own GitHub token cannot see (404) — is refused; nothing written; the user token is revoked", async () => {
    await seedOrgSettings();
    const f = await flow({ userRepos: null });
    const owner = await cookieFor(OWNER);
    const { gh, nonce } = await firstHop(f, owner);
    const before = await written();
    const r = await codeHop(f, owner, gh, `code=abc123&state=${nonce}`);
    isPage(r, 403, /Your GitHub account cannot access this installation/);
    expect(cleared(r)).toBe(true);
    expect(await written()).toBe(before);
    expect(githubCalls(f.calls)).toEqual([
      "POST /login/oauth/access_token", `GET /app/installations/${ID}`, `POST /app/installations/${ID}/access_tokens`,
      "GET /installation/repositories", `GET /user/installations/${ID}/repositories`, `DELETE /applications/${APP.clientId}/token`,
    ]);
  });

  it("a code hop naming a DIFFERENT installation than the cookie's is refused — GitHub is not asked", async () => {
    await seedOrgSettings();
    const f = await flow();
    const owner = await cookieFor(OWNER);
    const { gh, nonce } = await firstHop(f, owner);
    const before = await written();
    isPage(await codeHop(f, owner, gh, `code=abc123&state=${nonce}&installation_id=${ID + 1}`), 403, /A different installation/);
    expect(f.calls).toEqual([]);
    expect(await written()).toBe(before);
  });

  it("the person's token sees an installation, but the id belongs to ANOTHER installation of theirs: the per-id check refuses", async () => {
    await seedOrgSettings();
    // GitHub answers /user/installations/<id>/repositories per id: this person can see 5555, not 4242.
    const f = await flow({}, (inner) => (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (new URL(url).pathname === `/user/installations/${ID}/repositories`) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      return inner(input, init);
    }) as typeof fetch);
    const owner = await cookieFor(OWNER);
    const { gh, nonce } = await firstHop(f, owner);
    const before = await written();
    isPage(await codeHop(f, owner, gh, `code=abc123&state=${nonce}`), 403, /cannot access this installation/);
    expect(await written()).toBe(before);
  });

  it("an id that is not an installation of this App (GitHub 404) is refused", async () => {
    const f = await flow({ installation: () => null });
    const owner = await cookieFor(OWNER);
    const { gh, nonce } = await firstHop(f, owner);
    const before = await written();
    isPage(await codeHop(f, owner, gh, `code=abc123&state=${nonce}`), 403, /Not an installation of this App/);
    expect(await written()).toBe(before);
    expect(githubCalls(f.calls).at(-1)).toBe(`DELETE /applications/${APP.clientId}/token`);
  });

  it("SUPERSET: the person cannot read one of the installation's repositories → refused with a COUNT, never the name; nothing written", async () => {
    await seedOrgSettings();
    const f = await flow({ repos: [SAPLING, PLANS, { id: 103, full_name: "SaplingLearn/payroll", private: true }], userRepos: [SAPLING] });
    const owner = await cookieFor(OWNER);
    const { gh, nonce } = await firstHop(f, owner);
    const before = await written();
    const r = await codeHop(f, owner, gh, `code=abc123&state=${nonce}`);
    isPage(r, 403, /Some repositories aren(&#39;|')t yours to connect/);
    expect(r.body).toContain("can&#39;t read 2 repositories this installation covers");
    for (const name of ["secret-plans", "payroll", "SaplingLearn/"]) expect(r.body).not.toContain(name);
    expect(await written()).toBe(before);
    // One repository short reads in the singular.
    const g = await flow({ repos: [SAPLING, PLANS], userRepos: [SAPLING] });
    const hop = await firstHop(g, owner);
    expect((await codeHop(g, owner, hop.gh, `code=abc123&state=${hop.nonce}`)).body).toContain("can&#39;t read 1 repository this installation covers");
  });

  it("bound to ANOTHER Trov org → 409 page that does not name it; nothing written in either org", async () => {
    await seedOrgSettings();
    await seedInstallation(ORG_B, ID, [SAPLING], { login: "SaplingLearn" });
    const f = await flow();
    const owner = await cookieFor(OWNER);
    const { gh, nonce } = await firstHop(f, owner);
    const before = await written();
    const r = await codeHop(f, owner, gh, `code=abc123&state=${nonce}`);
    isPage(r, 409, /Already connected elsewhere/);
    expect(r.body.toLowerCase()).not.toContain("acme");
    expect(r.body).not.toContain(ORG_B);
    expect(await written()).toBe(before);
    expect(githubCalls(f.calls).at(-1)).toBe(`DELETE /applications/${APP.clientId}/token`);
  });

  it("GitHub refusing the code (a 200 with `error`) is a 403 page; GitHub failing is a 503 page — never a 500, nothing written", async () => {
    const f = await flow({ exchange: { error: "bad_verification_code", error_description: "The code passed is incorrect or expired." } });
    const owner = await cookieFor(OWNER);
    const hop = await firstHop(f, owner);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const before = await written();
    isPage(await codeHop(f, owner, hop.gh, `code=abc123&state=${hop.nonce}`), 403, /GitHub didn(&#39;|')t accept the sign-in/);
    const g = await flow({ mint: 500 });
    const hop2 = await firstHop(g, owner);
    const failed = await codeHop(g, owner, hop2.gh, `code=abc123&state=${hop2.nonce}`);
    isPage(failed, 503, /GitHub didn(&#39;|')t answer/);
    expect(cleared(failed)).toBe(true);
    expect(githubCalls(g.calls).at(-1)).toBe(`DELETE /applications/${APP.clientId}/token`); // revoked even on a failure
    expect(await written()).toBe(before);
  });
});

// ── success ──────────────────────────────────────────────────────────────────

describe("GET /github/app/setup — connected", () => {
  it("binds the installation, its repos, ATTACHES the org's existing repo row, audits github.connect, clears the cookie, revokes the token, lands on #org/repos", async () => {
    await seedOrgSettings(); // SaplingLearn/sapling, primary, HOOK_A — connected the 0037 way
    const f = await flow({ repos: [SAPLING, PLANS], userRepos: [PLANS, SAPLING, { id: 999, full_name: "SaplingLearn/extra" }] });
    const owner = await cookieFor(OWNER);
    const { gh, nonce } = await firstHop(f, owner);
    const r = await codeHop(f, owner, gh, `code=abc123&state=${nonce}`);
    expect([r.status, r.location, r.body]).toEqual([302, "/o/saplinglearn/#org/repos?github=connected", ""]);
    expect(cleared(r)).toBe(true);
    expect(r.headers).toEqual(expect.arrayContaining([["cache-control", "no-store"], ["referrer-policy", "no-referrer"]]));

    expect(await all(env.DB, `SELECT installation_id, org_id, account_login, account_type, repository_selection, suspended_at, connected_by FROM github_installations`)).toEqual([
      { installation_id: ID, org_id: ORG_A, account_login: "SaplingLearn", account_type: "Organization", repository_selection: "selected", suspended_at: null, connected_by: OWNER },
    ]);
    expect(await all(env.DB, `SELECT org_id, installation_id, repo_id, repo_full_name, private FROM github_installation_repos ORDER BY repo_id`)).toEqual([
      { org_id: ORG_A, installation_id: ID, repo_id: 101, repo_full_name: "SaplingLearn/sapling", private: 0 },
      { org_id: ORG_A, installation_id: ID, repo_id: 102, repo_full_name: "SaplingLearn/secret-plans", private: 1 },
    ]);
    expect(await first(env.DB, `SELECT installation_id FROM org_repos WHERE id = ?`, HOOK_A)).toEqual({ installation_id: ID });
    const audit = await all<{ actor: string; action: string; target: string; detail: string }>(env.DB, `SELECT actor, action, target, detail FROM org_admin_audit WHERE org_id = ? ORDER BY id`, ORG_A);
    expect(audit.map((a) => [a.actor, a.action, a.target])).toEqual([[OWNER, "repo.attach", "SaplingLearn/sapling"], [OWNER, "github.connect", "SaplingLearn"]]);
    expect(JSON.parse(audit[1].detail)).toMatchObject({ installation_id: ID, repositories: 2 });

    // What GitHub was asked, in order — the mint for metadata only, over every repository (no restriction).
    expect(githubCalls(f.calls)).toEqual([
      "POST /login/oauth/access_token", `GET /app/installations/${ID}`, `POST /app/installations/${ID}/access_tokens`,
      "GET /installation/repositories", `GET /user/installations/${ID}/repositories`, `DELETE /applications/${APP.clientId}/token`,
    ]);
    const [exchange, , mint, list, mine, revoke] = f.calls;
    expect(JSON.parse(exchange.body)).toEqual({ client_id: APP.clientId, client_secret: APP.clientSecret, code: "abc123", redirect_uri: "http://localhost/github/app/setup" });
    expect(JSON.parse(mint.body)).toEqual({ permissions: { metadata: "read" } });
    expect(list.auth).toBe(`Bearer ${installationToken(ID)}`);
    expect(mine.auth).toBe(`Bearer ${USER_TOKEN}`);
    expect(JSON.parse(revoke.body)).toEqual({ access_token: USER_TOKEN });

    // The flow is single-use: the cookie is gone, so a replay of the same URL is refused.
    isPage(await get(f, `/github/app/setup?code=abc123&state=${nonce}`, owner), 403, /No setup in progress/);
  });

  it("an installation id on the code hop (OAuth during install) with no first hop is used — still verified", async () => {
    await seedOrgSettings();
    const f = await flow();
    const owner = await cookieFor(OWNER);
    const s = await start(f, owner);
    const r = await codeHop(f, owner, s.gh, `code=abc123&state=${s.nonce}&installation_id=${ID}&setup_action=install`);
    expect([r.status, r.location]).toEqual([302, "/o/saplinglearn/#org/repos?github=connected"]);
    expect(await first(env.DB, `SELECT org_id FROM github_installations WHERE installation_id = ?`, ID)).toEqual({ org_id: ORG_A });
  });

  it("re-installing into the SAME org (Redirect on update) re-binds in place", async () => {
    await seedOrgSettings();
    await seedInstallation(ORG_A, ID, [SAPLING], { login: "SaplingLearn" });
    const f = await flow({ repos: [SAPLING, PLANS] });
    const owner = await cookieFor(OWNER);
    const { gh, nonce } = await firstHop(f, owner);
    expect((await codeHop(f, owner, gh, `code=abc123&state=${nonce}`)).location).toBe("/o/saplinglearn/#org/repos?github=connected");
    expect(await all(env.DB, `SELECT repo_id FROM github_installation_repos WHERE installation_id = ? ORDER BY repo_id`, ID)).toEqual([{ repo_id: 101 }, { repo_id: 102 }]);
  });
});

// ── the leak rule ────────────────────────────────────────────────────────────

describe("no App secret, JWT, installation token or user token leaves the Worker", () => {
  it("in any body, header (bar the sealed cookie), page, console line or D1 column — upstreams echoing the request back", async () => {
    const logged: unknown[][] = [];
    for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(a); });
    await seedOrgSettings();
    const keys = await makeAppKeys();
    const outputs: Seen[] = [];
    const owner = await cookieFor(OWNER);

    // A full success, a GitHub failure at every step that can fail with an echo, and the refusals in between.
    const echo = (path: RegExp, status = 502) => (inner: typeof fetch) => (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (path.test(new URL(url).pathname)) {
        const h = new Headers(init?.headers);
        return new Response(JSON.stringify({ message: `upstream echo ${h.get("authorization")} ${JSON.stringify(Object.fromEntries(h))} ${String(init?.body ?? "")}` }), { status });
      }
      return inner(input, init);
    }) as typeof fetch;
    const runs: [FakeAppGithub, ((f: typeof fetch) => typeof fetch) | undefined][] = [
      [{ repos: [SAPLING] }, undefined],
      [{ mint: 500 }, undefined],
      [{ mint: "throw" }, undefined],
      [{}, echo(/^\/login\/oauth\/access_token$/)],
      [{}, echo(/^\/app\/installations\/\d+$/, 500)],
      [{}, echo(/^\/installation\/repositories$/)],
      [{}, echo(/^\/user\/installations\/\d+\/repositories$/, 500)],
      [{ userRepos: [], repos: [SAPLING, PLANS] }, undefined],
    ];
    const jwts = new Set<string>();
    for (const [fake, wrap] of runs) {
      await env.DB.prepare(`DELETE FROM github_installations`).run();
      const f = await flow(fake, wrap);
      const s = await start(f, owner);
      outputs.push(s);
      const hop = await get(f, `/github/app/setup?installation_id=${ID}&state=${s.nonce}`, `${owner}; gh_install=${s.gh}`);
      outputs.push(hop);
      outputs.push(await codeHop(f, owner, ghCookieOf(hop)!, `code=abc123&state=${s.nonce}`));
      for (const c of f.calls) if (c.auth?.startsWith("Bearer ey")) jwts.add(c.auth.slice("Bearer ".length));
    }
    expect(jwts.size).toBeGreaterThan(0);

    const keyBody = keys.pkcs1Pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
    const secrets: [string, string][] = [
      ["user token", USER_TOKEN], ["installation token", installationToken(ID)], ["client secret", APP.clientSecret],
      ["webhook secret", APP.webhookSecret], ["private key", keyBody.slice(100, 164)], ["code", "abc123"],
      ...[...jwts].map((j, i): [string, string] => [`jwt ${i}`, j.split(".")[2]]),
    ];
    const leak = (text: string): string | null => {
      for (const [label, value] of secrets) {
        const piece = label === "code" ? [value] : Array.from({ length: value.length - 7 }, (_, i) => value.slice(i, i + 8));
        if (piece.some((p) => text.includes(p))) return label;
      }
      return null;
    };
    for (const o of outputs) {
      const headers = o.headers.map(([k, v]) => (k === "set-cookie" ? v.replace(/gh_install=[^;]*/g, "gh_install=<sealed>") : v)).join("\n");
      // The authorize redirect carries the CLIENT ID (public) and the nonce — never a secret.
      expect(leak(`${o.body}\n${headers}`), `${o.status} ${o.body.slice(0, 200)}`).toBeNull();
    }
    const consoleText = logged.map((args) => args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : typeof a === "string" ? a : JSON.stringify(a))).join(" ")).join("\n");
    expect(logged.length).toBeGreaterThan(0); // the failures were logged…
    expect(leak(consoleText), consoleText.slice(0, 600)).toBeNull(); // …scrubbed
    const d1 = JSON.stringify(await Promise.all(["github_installations", "github_installation_repos", "org_repos", "org_admin_audit", "sessions"].map((t) => all(env.DB, `SELECT * FROM ${t}`))));
    expect(leak(d1)).toBeNull();
  });
});

describe("installRefusalPage", () => {
  it("escapes everything it is given and links only to the org's Repositories screen or the root", () => {
    const html = installRefusalPage({ title: `<script>t</script>`, message: `a "quote" & <b>bold</b>`, slug: `x"><img src=y>` });
    expect(html).not.toContain("<script>t");
    expect(html).not.toContain("<b>bold");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain(`href="/o/x%22%3E%3Cimg%20src%3Dy%3E/#org/repos"`);
    expect(installRefusalPage({ title: "t", message: "m", slug: null })).toContain(`href="/"`);
  });
});

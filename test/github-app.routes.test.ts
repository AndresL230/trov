// The GitHub App panel's tenant routes (src/github-app/routes.ts; spec §9), under `/api/o/:slug`: the state
// read, Refresh (a listing token → the full repository list synced) and Disconnect. Admin, cookie only;
// an installation of ANOTHER org is the same 404 as an unknown id, and nothing reaches GitHub for it.
// Driven through the production gates with a fake GitHub; asserted in real D1.
import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import type { Env } from "../src/env";
import type { GithubAppStateDTO } from "@shared/github-app";
import { sessionGate, type AppEnv } from "../src/auth/principal";
import { platformContext, soleTenantGate, tenantGate } from "../src/data/gate";
import { app as realApp } from "../src/routes";
import { buildGithubAppTenantApp } from "../src/github-app/routes";
import { all, first } from "./helpers/db";
import { cookieFor } from "./helpers/persons";
import { ORG_A, ORG_B, ensureMember } from "./helpers/tenant";
import { HOOK_A, seedOrgSettings } from "./helpers/integrations";
import { addOrgRepo } from "./helpers/org-config";
import { APP, appEnv, attachRepo, fakeAppGithub, installationToken, makeAppKeys, seedInstallation, type AppCall, type FakeAppGithub } from "./helpers/github-app";

const ID = 4242;
const OWNER = "AndresL230";
const SAPLING = { id: 101, full_name: "SaplingLearn/sapling" };
const DOCS = { id: 102, full_name: "SaplingLearn/docs", private: true };

afterEach(() => { vi.restoreAllMocks(); });

function appWith(fetchImpl: typeof fetch): Hono<AppEnv> {
  const a = new Hono<AppEnv>();
  a.use("*", sessionGate);
  a.use("*", platformContext);
  a.use("*", soleTenantGate);
  a.use("/api/o/:slug/*", tenantGate);
  a.route("/api/o/:slug", buildGithubAppTenantApp({ fetchImpl, now: () => 1_791_300_000_000 }));
  return a;
}

interface Ctx { a: Hono<AppEnv>; e: Env; calls: AppCall[] }
async function harness(fake: FakeAppGithub = {}, o: { configured?: boolean } = {}): Promise<Ctx> {
  const { fetchImpl, calls } = fakeAppGithub(fake);
  return { a: appWith(fetchImpl), e: o.configured === false ? (env as unknown as Env) : await appEnv(), calls };
}

async function call(h: Ctx, cookie: string, method: string, path: string, headers: Record<string, string> = {}) {
  const res = await h.a.request(`/api/o${path}`, { method, headers: { cookie, ...headers } }, h.e);
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, text, json, headers: [...res.headers] };
}

const state = (r: { json: unknown }) => r.json as GithubAppStateDTO;
const githubRows = async () => JSON.stringify({
  inst: await all(env.DB, `SELECT * FROM github_installations ORDER BY installation_id`),
  repos: await all(env.DB, `SELECT * FROM github_installation_repos ORDER BY installation_id, repo_id`),
  orgRepos: await all(env.DB, `SELECT id, org_id, installation_id FROM org_repos ORDER BY id`),
  audit: await all(env.DB, `SELECT * FROM org_admin_audit ORDER BY id`),
});
const audit = (org: string) => all<{ actor: string; action: string; target: string; detail: string }>(env.DB,
  `SELECT actor, action, target, detail FROM org_admin_audit WHERE org_id = ? ORDER BY id`, org);

// ── GET /github ──────────────────────────────────────────────────────────────

describe("GET /api/o/:slug/github", () => {
  it("the panel's whole state, from D1: installations, their repositories (connected or not), primary_on_app — the DTO itself", async () => {
    await seedOrgSettings();
    await seedInstallation(ORG_A, ID, [SAPLING, DOCS], { login: "SaplingLearn" });
    await attachRepo(HOOK_A, ID);
    const h = await harness();
    const r = await call(h, await cookieFor(OWNER), "GET", "/saplinglearn/github");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      configured: true,
      app_url: `https://github.com/apps/${APP.slug}`,
      primary_on_app: true,
      installations: [{
        installation_id: ID, account_login: "SaplingLearn", account_type: "Organization", repository_selection: "selected",
        suspended_at: null, connected_by: OWNER, connected_at: "2026-10-06T00:00:00.000Z", last_delivery_at: null, repos_synced_at: null,
        manage_url: `https://github.com/organizations/SaplingLearn/settings/installations/${ID}`,
        repos: [
          { repo_id: 102, full_name: "SaplingLearn/docs", private: false, org_repo_id: null, is_primary: false },
          { repo_id: 101, full_name: "SaplingLearn/sapling", private: false, org_repo_id: HOOK_A, is_primary: true },
        ],
      }],
    } satisfies GithubAppStateDTO);
    expect(h.calls).toEqual([]); // never GitHub on render
  });

  it("unconfigured: configured false, no app URL, the org's installations still listed (it can still disconnect them)", async () => {
    await seedInstallation(ORG_A, ID, [SAPLING]);
    const h = await harness({}, { configured: false });
    const r = state(await call(h, await cookieFor(OWNER), "GET", "/saplinglearn/github"));
    expect(r).toMatchObject({ configured: false, app_url: null, primary_on_app: false });
    expect(r.installations.map((i) => i.installation_id)).toEqual([ID]);
  });

  it("another org's installations never appear", async () => {
    await seedInstallation(ORG_A, ID, [SAPLING]);
    await ensureMember("boss", "owner", ORG_B);
    const h = await harness();
    expect(state(await call(h, await cookieFor("boss"), "GET", "/acme/github")).installations).toEqual([]);
  });
});

// ── the gates ────────────────────────────────────────────────────────────────

describe("who may call them", () => {
  const ROUTES: [string, string][] = [
    ["GET", "/github"], ["POST", "/github/install"],
    ["POST", `/github/installations/${ID}/refresh`], ["POST", `/github/installations/${ID}/disconnect`],
  ];

  it("a member: 403 forbidden on every route; an Authorization header: 403 even for the owner; nothing changes, GitHub is not asked", async () => {
    await seedOrgSettings();
    await seedInstallation(ORG_A, ID, [SAPLING]);
    await attachRepo(HOOK_A, ID);
    await ensureMember("mona", "member");
    const h = await harness({ repos: [] });
    const before = await githubRows();
    const member = await cookieFor("mona");
    const owner = await cookieFor(OWNER);
    for (const [method, path] of ROUTES) {
      const m = await call(h, member, method, `/saplinglearn${path}`);
      expect([m.status, m.json, method, path]).toEqual([403, { error: "forbidden" }, method, path]);
      for (const authorization of ["Bearer trov_mcp_whatever", "Basic Zm9vOmJhcg=="]) {
        const b = await call(h, owner, method, `/saplinglearn${path}`, { authorization });
        expect([b.status, (b.json as { error: string }).error, method, path]).toEqual([403, "forbidden", method, path]);
      }
    }
    // An admin passes (not only the owner).
    await ensureMember("ada", "admin");
    expect((await call(h, await cookieFor("ada"), "GET", "/saplinglearn/github")).status).toBe(200);
    expect(h.calls).toEqual([]);
    expect(await githubRows()).toBe(before);
  });

  it("no session is 401; an unknown slug and a slug the person is not a member of are the gate's 404", async () => {
    const h = await harness();
    for (const [method, path] of ROUTES) {
      expect((await h.a.request(`/api/o/saplinglearn${path}`, { method }, h.e)).status).toBe(401);
      for (const slug of ["acme", "no-such-org"]) {
        const r = await call(h, await cookieFor(OWNER), method, `/${slug}${path}`);
        expect([r.status, r.json]).toEqual([404, { error: "not_found" }]);
      }
    }
  });

  it("the real app mounts them under /api/o/:slug only — no alias at the old path", async () => {
    const e = await appEnv();
    const cookie = await cookieFor(OWNER);
    expect((await realApp.request("/api/o/saplinglearn/github", { headers: { cookie } }, e)).status).toBe(200);
    for (const old of ["/github", "/api/github"]) expect((await realApp.request(old, { headers: { cookie } }, e)).status).toBe(404);
  });
});

// ── refresh ──────────────────────────────────────────────────────────────────

describe("POST /api/o/:slug/github/installations/:installationId/refresh", () => {
  it("mints a LISTING token (metadata only, every repo), re-lists, syncs the FULL list — attaching and detaching org repos — audits, returns the state", async () => {
    await seedOrgSettings();
    const widgets = await addOrgRepo("SaplingLearn/widgets", ORG_A, { id: "hook_widgets", primary: false });
    await seedInstallation(ORG_A, ID, [SAPLING, { id: 103, full_name: "SaplingLearn/widgets" }], { login: "SaplingLearn" });
    await attachRepo(HOOK_A, ID);
    await attachRepo(widgets, ID);
    // On GitHub now: sapling and a new docs repo; widgets left the installation.
    const h = await harness({ repos: [SAPLING, DOCS] });
    const r = await call(h, await cookieFor(OWNER), "POST", `/saplinglearn/github/installations/${ID}/refresh`);
    expect(r.status, r.text).toBe(200);
    const s = state(r);
    expect(s.installations[0].repos.map((x) => [x.full_name, x.private, x.org_repo_id])).toEqual([
      ["SaplingLearn/docs", true, null], ["SaplingLearn/sapling", false, HOOK_A],
    ]);
    expect(s.installations[0].repos_synced_at).not.toBeNull();
    expect(s.primary_on_app).toBe(true);

    expect(h.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([`POST /app/installations/${ID}/access_tokens`, "GET /installation/repositories"]);
    expect(JSON.parse(h.calls[0].body)).toEqual({ permissions: { metadata: "read" } });
    expect(h.calls[1].auth).toBe(`Bearer ${installationToken(ID)}`);
    expect(await first(env.DB, `SELECT installation_id FROM org_repos WHERE id = ?`, widgets)).toEqual({ installation_id: null });
    expect(await first(env.DB, `SELECT installation_id FROM org_repos WHERE id = ?`, HOOK_A)).toEqual({ installation_id: ID });
    const rows = await audit(ORG_A);
    expect(rows.map((a) => [a.actor, a.action, a.target])).toEqual([[OWNER, "repo.detach", "SaplingLearn/widgets"], [OWNER, "github.repos", "SaplingLearn"]]);
    expect(JSON.parse(rows[1].detail)).toMatchObject({ installation_id: ID, added: 1, removed: 1 });
  });

  it("404 for an unknown or malformed id, and for ANOTHER org's installation — the same 404, nothing asked of GitHub, nothing written", async () => {
    await seedInstallation(ORG_A, ID, [SAPLING]);
    await ensureMember("boss", "owner", ORG_B);
    const h = await harness({ repos: [] });
    const before = await githubRows();
    const owner = await cookieFor(OWNER);
    for (const id of ["9999", "abc", "0", "01", "-4242", "4242.0", "1e3", "99999999999999999999"]) {
      const r = await call(h, owner, "POST", `/saplinglearn/github/installations/${encodeURIComponent(id)}/refresh`);
      expect([r.status, r.json, id]).toEqual([404, { error: "not_found" }, id]);
    }
    // Org B's owner, with A's installation id: B has no such installation.
    const foreign = await call(h, await cookieFor("boss"), "POST", `/acme/github/installations/${ID}/refresh`);
    const unknown = await call(h, await cookieFor("boss"), "POST", `/acme/github/installations/9999/refresh`);
    expect([foreign.status, foreign.text]).toEqual([unknown.status, unknown.text]);
    expect(foreign.status).toBe(404);
    expect(h.calls).toEqual([]);
    expect(await githubRows()).toBe(before);
  });

  it("503 github_app_not_configured when the App's secrets are absent (the installation is the org's own)", async () => {
    await seedInstallation(ORG_A, ID, [SAPLING]);
    const h = await harness({}, { configured: false });
    const r = await call(h, await cookieFor(OWNER), "POST", `/saplinglearn/github/installations/${ID}/refresh`);
    expect([r.status, (r.json as { error: string }).error]).toEqual([503, "github_app_not_configured"]);
    expect(h.calls).toEqual([]);
  });

  it("GitHub failing is 502 github_unavailable with a SCRUBBED reason — the echoed JWT, key and secrets are gone — and nothing changes", async () => {
    const logged: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { logged.push(a); });
    await seedInstallation(ORG_A, ID, [SAPLING]);
    const keys = await makeAppKeys();
    const before = await githubRows();
    const owner = await cookieFor(OWNER);
    const jwts: string[] = [];
    for (const fake of [{ mint: 403 }, { mint: "throw" }] as FakeAppGithub[]) {
      const h = await harness(fake);
      const r = await call(h, owner, "POST", `/saplinglearn/github/installations/${ID}/refresh`);
      expect([r.status, (r.json as { error: string }).error]).toEqual([502, "github_unavailable"]);
      expect((r.json as { message: string }).message).toMatch(/^GitHub POST \/app\/installations\/\{id\}\/access_tokens /);
      jwts.push(h.calls[0].auth!.slice("Bearer ".length));
      const text = `${r.text}\n${JSON.stringify(r.headers)}\n${JSON.stringify(logged)}`;
      for (const secret of [...jwts.map((j) => j.split(".")[2]), APP.clientSecret, APP.webhookSecret, keys.pkcs1Pem.split("\n")[3]]) {
        expect(text).not.toContain(secret.slice(0, 16));
      }
    }
    // A failure AFTER the mint: the installation token is scrubbed too.
    const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (new URL(url).pathname === "/installation/repositories") {
        return new Response(JSON.stringify({ message: `nope ${new Headers(init?.headers).get("authorization")}` }), { status: 500 });
      }
      return fakeAppGithub({}).fetchImpl(input, init);
    }) as typeof fetch;
    const r = await appWith(wrapped).request(`/api/o/saplinglearn/github/installations/${ID}/refresh`, { method: "POST", headers: { cookie: owner } }, await appEnv());
    const text = await r.text();
    expect(r.status).toBe(502);
    expect(text).toContain("[redacted]");
    expect(`${text}${JSON.stringify(logged)}`).not.toContain(installationToken(ID).slice(4, 20));
    expect(await githubRows()).toBe(before);
  });
});

// ── disconnect ───────────────────────────────────────────────────────────────

describe("POST /api/o/:slug/github/installations/:installationId/disconnect", () => {
  it("Trov forgets it: its org repos detach, its rows go, github.disconnect + repo.detach audited, the state comes back — GitHub is not asked", async () => {
    await seedOrgSettings();
    await seedInstallation(ORG_A, ID, [SAPLING, DOCS], { login: "SaplingLearn" });
    await attachRepo(HOOK_A, ID);
    const h = await harness({}, { configured: false }); // works without the App configured
    const r = await call(h, await cookieFor(OWNER), "POST", `/saplinglearn/github/installations/${ID}/disconnect`);
    expect(r.status, r.text).toBe(200);
    expect(r.json).toEqual({ configured: false, app_url: null, installations: [], primary_on_app: false });
    expect(await first(env.DB, `SELECT installation_id FROM org_repos WHERE id = ?`, HOOK_A)).toEqual({ installation_id: null });
    expect(await all(env.DB, `SELECT * FROM github_installations`)).toEqual([]);
    expect(await all(env.DB, `SELECT * FROM github_installation_repos`)).toEqual([]);
    expect((await audit(ORG_A)).map((a) => [a.actor, a.action, a.target])).toEqual([[OWNER, "repo.detach", "SaplingLearn/sapling"], [OWNER, "github.disconnect", "SaplingLearn"]]);
    expect(h.calls).toEqual([]);
    // A second disconnect: nothing left to forget.
    expect((await call(h, await cookieFor(OWNER), "POST", `/saplinglearn/github/installations/${ID}/disconnect`)).status).toBe(404);
  });

  it("org B cannot disconnect org A's installation: the same 404 as an unknown id, A untouched", async () => {
    await seedOrgSettings();
    await seedInstallation(ORG_A, ID, [SAPLING]);
    await attachRepo(HOOK_A, ID);
    await ensureMember("boss", "owner", ORG_B);
    const h = await harness();
    const before = await githubRows();
    const boss = await cookieFor("boss");
    const foreign = await call(h, boss, "POST", `/acme/github/installations/${ID}/disconnect`);
    const unknown = await call(h, boss, "POST", `/acme/github/installations/9999/disconnect`);
    expect([foreign.status, foreign.json]).toEqual([404, { error: "not_found" }]);
    expect(foreign.text).toBe(unknown.text);
    expect((await call(h, boss, "POST", `/acme/github/installations/abc/disconnect`)).status).toBe(404);
    expect(await githubRows()).toBe(before);
  });
});

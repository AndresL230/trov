/**
 * Which credential reads GitHub for an org (src/github-app/credential.ts; docs/architecture/github-app.md
 * › Tokens): its live App installation's token, else its stored `github_token`, else — SaplingLearn only —
 * the Worker's legacy secret. Driven through every job that reads GitHub, with TWO orgs: each must carry
 * only ITS OWN installation's token. Then the routes Org settings uses to list, track, test and disconnect.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { all, first, run } from "./helpers/db";
import { ORG_A, ORG_B, bearerCtx, ensureMember, platformCtx, systemCtx, tenantCtx } from "./helpers/tenant";
import { cookieFor } from "./helpers/persons";
import { addOrgRepo, setOrgEnvironments } from "./helpers/org-config";
import { call } from "./helpers/integrations";
import { ENVS, fakeGithub } from "./helpers/repo";
import { fakeApp, seedInstallation, type FakeApp } from "./helpers/github-app";
import { SecretAccessError, setSecret } from "../src/data/secrets";
import { READ_PERMISSIONS, clearInstallationTokens } from "../src/github-app/api";
import { resolveGithubCredential } from "../src/github-app/credential";
import { clearRepoLists, visibleRepos } from "../src/github-app/repos";
import { testGithubApp } from "../src/github-app/routes";
import { importLogoForOrg } from "../src/integrations/logo";
import { runOrgJob, runReconcileJob } from "../src/repo/cron";
import { runBackfill } from "../src/tools/backfill";
import type { GithubAppStatusDTO, GithubReposDTO } from "@shared/github-app";
import type { IntegrationsListDTO, OrgRepoDTO } from "@shared/integrations";
import type { PlanRefusal } from "@shared/plans";
import { setOrgPlan } from "../src/plans/state";

const e = env as unknown as Env;
const NOW = Date.now();
const REPO_A = "SaplingLearn/sapling";
const REPO_B = "beta-co/app";
const INST_A = 601;
const INST_B = 501;
const TOKEN_B = "ghp_beta_stored_token_0123456789abcdef";
const LEGACY = "ghs_legacy_worker_token_0000000000";

beforeEach(() => { clearInstallationTokens(); clearRepoLists(); });
afterEach(() => { vi.unstubAllGlobals(); });

interface Read { url: string; auth: string | null }
/** GitHub, whole: the App's endpoints (./helpers/github-app.ts) and the repository API the readers call. */
function github(over: Parameters<typeof fakeApp>[0] = {}): { app: FakeApp; fetchImpl: typeof fetch; reads: Read[] } {
  const app = fakeApp({
    now: () => NOW,
    installations: {
      [INST_A]: { account: { login: "SaplingLearn", id: 1, type: "Organization" }, repos: [{ full_name: REPO_A }] },
      [INST_B]: { account: { login: "beta-co", id: 2, type: "Organization" }, repos: [{ full_name: REPO_B }, { full_name: "beta-co/docs", private: true }] },
    },
    ...over,
  });
  const api = fakeGithub({});
  const reads: Read[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;
    if (new URL(url).host === "api.github.com" && (path.startsWith("/repos/") || path === "/graphql" || path.startsWith("/users/"))) {
      reads.push({ url, auth: new Headers(init?.headers).get("authorization") });
      return api.fetchImpl(input, init);
    }
    return app.fetchImpl(input, init);
  }) as typeof fetch;
  return { app, fetchImpl, reads };
}
const auths = (reads: Read[]): string[] => [...new Set(reads.map((r) => r.auth ?? "(none)"))];
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
  try { return await fn(); } finally { for (const s of spies) s.mockRestore(); }
}
const binding = (org: string) => first<{ suspended_at: string | null; removed_at: string | null; removed_reason: string | null; last_used_at: string | null; last_error: string | null }>(env.DB,
  `SELECT suspended_at, removed_at, removed_reason, last_used_at, last_error FROM org_github_installations WHERE org_id = ? ORDER BY id DESC LIMIT 1`, org);

/** Both orgs with a primary repository, environments and a live installation each. */
async function twoOrgs(): Promise<void> {
  await addOrgRepo(REPO_A, ORG_A);
  await addOrgRepo(REPO_B, ORG_B);
  await setOrgEnvironments(ENVS, ORG_A);
  await setOrgEnvironments(ENVS, ORG_B);
  await seedInstallation(ORG_A, INST_A, "SaplingLearn");
  await seedInstallation(ORG_B, INST_B, "beta-co", { by: "bob" });
}
const adminB = () => tenantCtx("bob", "admin", { orgId: ORG_B });

describe("every job carries only ITS org's installation token", () => {
  it("the reconcile, Sync GitHub, the progress backstop and the org image's import — for two orgs", async () => {
    await twoOrgs();
    // Each org ALSO has a stored token, and the Worker has its legacy one: none of them may be used.
    await setSecret(await tenantCtx("AndresL230"), "github_token", "", "ghp_alpha_stored_token_0123456789abcd");
    await setSecret(await adminB(), "github_token", "", TOKEN_B);
    const withLegacy = { ...e, GITHUB_SERVICE_TOKEN: LEGACY } as Env;
    const jobs: [string, (org: string, f: typeof fetch) => Promise<unknown>][] = [
      ["reconcile", (org, f) => runReconcileJob(withLegacy, systemCtx(org, "system", withLegacy), NOW, { fetchImpl: f })],
      ["backfill", (org, f) => runBackfill(withLegacy, systemCtx(org, "system", withLegacy), "AndresL230", { fetchImpl: f, summarizer: null, issueSummarizer: null })],
      ["progress", (org, f) => runOrgJob(withLegacy, org, "progress", NOW, f)],
      ["logo", (org, f) => importLogoForOrg(withLegacy, platformCtx("system", withLegacy), systemCtx(org, "system", withLegacy), { fetchImpl: f })],
    ];
    for (const [name, job] of jobs) {
      clearInstallationTokens();
      const gh = github();
      await quiet(() => job(ORG_B, gh.fetchImpl));
      const b = gh.reads.splice(0);
      await quiet(() => job(ORG_A, gh.fetchImpl));
      const a = gh.reads.splice(0);
      const tokenA = gh.app.tokenFor(INST_A)!;
      const tokenB = gh.app.tokenFor(INST_B)!;
      expect(tokenA, name).toBeTruthy();
      expect(tokenB).not.toBe(tokenA);
      if (name !== "progress") { // (no sprint to recompute: the backstop resolves its credential and reads nothing)
        expect(auths(b), `${name}: org B`).toEqual([`Bearer ${tokenB}`]);
        expect(auths(a), `${name}: org A`).toEqual([`Bearer ${tokenA}`]);
        expect(b.length, name).toBeGreaterThan(0);
        expect(b.some((r) => r.url.includes("SaplingLearn")) || a.some((r) => r.url.includes("beta-co")), `${name}: a read named the other org's repository`).toBe(false);
      }
      // Each token was minted for its own installation, once, and nothing else was asked of the App.
      expect(gh.app.seen.map((s) => `${s.method} ${new URL(s.url).pathname}`), name).toEqual([
        `POST /app/installations/${INST_B}/access_tokens`, `POST /app/installations/${INST_A}/access_tokens`,
      ]);
      // …and each was asked for the org's ONE repository, by name, with the read permissions and no more.
      expect(gh.app.mints, name).toEqual([
        { installation: INST_B, repositories: ["app"], permissions: READ_PERMISSIONS, token: tokenB },
        { installation: INST_A, repositories: ["sapling"], permissions: READ_PERMISSIONS, token: tokenA },
      ]);
      for (const r of [...a, ...b]) for (const other of ["ghp_alpha_stored_token", "ghp_beta_stored_token", LEGACY]) expect(r.auth ?? "", name).not.toContain(other);
    }
    // The use is recorded on each org's BINDING, not on its stored token.
    expect((await binding(ORG_A))!.last_used_at).not.toBeNull();
    expect((await binding(ORG_B))!.last_used_at).not.toBeNull();
    expect(await all(env.DB, `SELECT last_used_at, last_error FROM org_secrets WHERE kind = 'github_token'`)).toEqual([
      { last_used_at: null, last_error: null }, { last_used_at: null, last_error: null },
    ]);
  });
});

describe("a token is as narrow as the read it is for", () => {
  it("one cron unit — the reconcile AND the image import that rides it — and the next jobs of the hour share ONE repository-scoped mint", async () => {
    await twoOrgs();
    const gh = github();
    await quiet(() => runOrgJob(e, ORG_B, "reconcile", NOW, gh.fetchImpl));
    await quiet(() => runOrgJob(e, ORG_B, "progress", NOW + 10 * 60_000, gh.fetchImpl));
    await quiet(() => runBackfill(e, systemCtx(ORG_B), "bob", { fetchImpl: gh.fetchImpl, summarizer: null, issueSummarizer: null }));
    expect(gh.app.mints).toEqual([{ installation: INST_B, repositories: ["app"], permissions: READ_PERMISSIONS, token: gh.app.minted[0] }]);
    expect(auths(gh.reads)).toEqual([`Bearer ${gh.app.minted[0]}`]);
    expect(gh.reads.some((r) => r.url.includes("/users/beta-co"))).toBe(true); // the image's lookup went with the job's token
  });

  it("the repository list and Test connection use a token for the installation itself — Metadata only, never the repository's read token", async () => {
    await twoOrgs();
    const ctx = await tenantCtx("bob", "admin", { orgId: ORG_B });
    const gh = github();
    const read = (await resolveGithubCredential(ctx, e, { repo: REPO_B, fetchImpl: gh.fetchImpl, now: NOW }))!.token.reveal();
    expect(await visibleRepos(ctx, e, { fetchImpl: gh.fetchImpl, now: NOW })).toMatchObject({ ok: true, list: { total: 2 } }); // BOTH repositories: the token spans the installation
    expect((await testGithubApp(ctx, e, NOW, gh.fetchImpl))!.detail).toBe("GitHub answered through the installation on beta-co: 2 repositories.");
    expect(gh.app.mints.map((m) => [m.repositories, m.permissions])).toEqual([[["app"], READ_PERMISSIONS], [null, { metadata: "read" }]]);
    const whole = gh.app.tokenFor(INST_B, null)!;
    expect(whole).not.toBe(read);
    expect([...new Set(gh.app.seen.filter((s) => s.url.includes("/installation/repositories")).map((s) => s.auth))]).toEqual([`Bearer ${whole}`]);
  });

  it("a repository the installation does not cover: GitHub refuses the mint, the stored token answers, and the binding only notes it", async () => {
    await twoOrgs();
    await addOrgRepo("beta-co/unselected", ORG_B, { primary: false });
    await setSecret(await adminB(), "github_token", "", TOKEN_B);
    const ctx = systemCtx(ORG_B);
    const gh = github();
    const held = (await resolveGithubCredential(ctx, e, { repo: REPO_B, fetchImpl: gh.fetchImpl, now: NOW }))!;
    const other = (await resolveGithubCredential(ctx, e, { repo: "beta-co/unselected", fetchImpl: gh.fetchImpl, now: NOW }))!;
    expect([other.source, other.token.reveal()]).toEqual(["token", TOKEN_B]);
    expect(gh.app.mints[1]).toEqual({ installation: INST_B, repositories: ["unselected"], permissions: READ_PERMISSIONS, token: null });
    expect(await binding(ORG_B)).toMatchObject({ removed_at: null, suspended_at: null, last_error: "ask GitHub for a token: GitHub would not issue one for that repository (the installation may not cover it)" });
    // The token the covered repository holds was not thrown away with it.
    expect((await resolveGithubCredential(ctx, e, { repo: REPO_B, fetchImpl: gh.fetchImpl, now: NOW }))!.token.reveal()).toBe(held.token.reveal());
    expect(gh.app.minted).toHaveLength(1);
  });
});

describe("the order: installation → stored token → SaplingLearn's legacy secret", () => {
  const withLegacy = { ...e, GITHUB_SERVICE_TOKEN: LEGACY } as Env;
  const sourceOf = async (org: string, envOver: Env, gh: { fetchImpl: typeof fetch }, repo: string): Promise<string | null> => {
    const cred = await resolveGithubCredential(systemCtx(org, "system", envOver), envOver, { repo, fetchImpl: gh.fetchImpl, now: NOW });
    return cred ? `${cred.source}:${cred.token.reveal()}` : null;
  };

  it("each step answers only when the one before it cannot", async () => {
    await addOrgRepo(REPO_A, ORG_A);
    await addOrgRepo(REPO_B, ORG_B);
    const gh = github();
    // Nothing at all: an outside org has no credential; SaplingLearn has the Worker's.
    expect(await sourceOf(ORG_B, withLegacy, gh, REPO_B)).toBeNull();
    expect(await sourceOf(ORG_A, withLegacy, gh, REPO_A)).toBe(`token:${LEGACY}`);
    expect(await sourceOf(ORG_A, e, gh, REPO_A)).toBeNull();
    // A stored token outranks the legacy secret.
    await setSecret(await tenantCtx("AndresL230"), "github_token", "", "ghp_alpha_stored_token_0123456789abcd");
    await setSecret(await adminB(), "github_token", "", TOKEN_B);
    expect(await sourceOf(ORG_A, withLegacy, gh, REPO_A)).toBe("token:ghp_alpha_stored_token_0123456789abcd");
    expect(await sourceOf(ORG_B, withLegacy, gh, REPO_B)).toBe(`token:${TOKEN_B}`);
    expect(gh.app.seen).toEqual([]); // no installation: the App is never asked
    // An installation outranks both.
    await seedInstallation(ORG_A, INST_A, "SaplingLearn");
    await seedInstallation(ORG_B, INST_B, "beta-co");
    expect(await sourceOf(ORG_A, withLegacy, gh, REPO_A)).toBe(`app:${gh.app.tokenFor(INST_A)}`);
    expect(await sourceOf(ORG_B, withLegacy, gh, REPO_B)).toBe(`app:${gh.app.tokenFor(INST_B)}`);
  });

  it("an installation answers only for its OWN account's repositories; a suspended or ended one, or an unconfigured App, falls to the stored token", async () => {
    await addOrgRepo(REPO_B, ORG_B);
    await setSecret(await adminB(), "github_token", "", TOKEN_B);
    await seedInstallation(ORG_B, INST_B, "beta-co");
    const gh = github();
    expect(await sourceOf(ORG_B, e, gh, "Beta-Co/app")).toBe(`app:${gh.app.tokenFor(INST_B)}`); // owners compare without case
    expect(await sourceOf(ORG_B, e, gh, "someone-else/site")).toBe(`token:${TOKEN_B}`);
    for (const over of [{ GITHUB_APP_ID: "" }, { GITHUB_APP_PRIVATE_KEY: "" }]) expect(await sourceOf(ORG_B, { ...e, ...over } as Env, gh, REPO_B)).toBe(`token:${TOKEN_B}`);
    const mints = gh.app.minted.length;
    await run(env.DB, `UPDATE org_github_installations SET suspended_at = '2026-10-07T00:00:00Z' WHERE org_id = ?`, ORG_B);
    clearInstallationTokens();
    expect(await sourceOf(ORG_B, e, gh, REPO_B)).toBe(`token:${TOKEN_B}`);
    await run(env.DB, `UPDATE org_github_installations SET suspended_at = NULL, removed_at = '2026-10-07T00:00:00Z', removed_reason = 'disconnected' WHERE org_id = ?`, ORG_B);
    expect(await sourceOf(ORG_B, e, gh, REPO_B)).toBe(`token:${TOKEN_B}`);
    expect(gh.app.minted).toHaveLength(mints); // neither state so much as asked for a token
  });

  it("a member's context and an MCP (bearer) context are refused before anything is looked up", async () => {
    await addOrgRepo(REPO_B, ORG_B);
    await seedInstallation(ORG_B, INST_B, "beta-co");
    const gh = github();
    for (const ctx of [await bearerCtx("bob", "admin", e, ORG_B), await bearerCtx("bob", "owner", e, ORG_B), await tenantCtx("mia", "member", { orgId: ORG_B })]) {
      await expect(resolveGithubCredential(ctx, e, { repo: REPO_B, fetchImpl: gh.fetchImpl })).rejects.toBeInstanceOf(SecretAccessError);
    }
    expect(gh.app.seen).toEqual([]);
  });
});

describe("when GitHub will not give the installation a token", () => {
  it("uninstalled (404): the binding is ended, the job reads with the stored token, and the next job does not ask again", async () => {
    await twoOrgs();
    await setSecret(await adminB(), "github_token", "", TOKEN_B);
    const gh = github();
    gh.app.world.installations[INST_B].gone = true;
    const res = await quiet(() => runReconcileJob(e, systemCtx(ORG_B), NOW, { fetchImpl: gh.fetchImpl }));
    expect(res).not.toBeNull();
    expect(auths(gh.reads)).toEqual([`Bearer ${TOKEN_B}`]); // the same run, on the fallback
    expect(await binding(ORG_B)).toMatchObject({ removed_reason: "not_found" });
    expect(await all(env.DB, `SELECT actor, action, target FROM org_admin_audit WHERE org_id = ? AND action LIKE 'github.%'`, ORG_B)).toEqual([{ actor: "system", action: "github.uninstall", target: "beta-co" }]);
    const asked = gh.app.seen.length;
    await quiet(() => runReconcileJob(e, systemCtx(ORG_B), NOW, { fetchImpl: gh.fetchImpl }));
    await quiet(() => runOrgJob(e, ORG_B, "progress", NOW, gh.fetchImpl));
    expect(gh.app.seen).toHaveLength(asked); // no loop: an ended binding is never tried again
    // SaplingLearn's installation is untouched and still its credential.
    gh.reads.length = 0;
    await quiet(() => runReconcileJob(e, systemCtx(ORG_A), NOW, { fetchImpl: gh.fetchImpl }));
    expect(auths(gh.reads)).toEqual([`Bearer ${gh.app.tokenFor(INST_A)}`]);
    expect(await binding(ORG_A)).toMatchObject({ removed_at: null, last_error: null });
  });

  it("suspended (403): marked suspended and audited once; with no stored token the org simply has no credential", async () => {
    await twoOrgs();
    const gh = github();
    gh.app.world.installations[INST_B].suspended = true;
    expect(await quiet(() => runReconcileJob(e, systemCtx(ORG_B), NOW, { fetchImpl: gh.fetchImpl }))).toBeNull(); // "not configured": nothing read
    expect(gh.reads).toEqual([]);
    const row = (await binding(ORG_B))!;
    expect(row.suspended_at).not.toBeNull();
    expect(row.removed_at).toBeNull();
    expect(row.last_error).toBe("ask GitHub for a token: the installation is suspended on GitHub");
    const asked = gh.app.seen.length;
    await quiet(() => runReconcileJob(e, systemCtx(ORG_B), NOW, { fetchImpl: gh.fetchImpl }));
    expect(gh.app.seen).toHaveLength(asked);
    expect(await all(env.DB, `SELECT action FROM org_admin_audit WHERE org_id = ? AND action LIKE 'github.%'`, ORG_B)).toEqual([{ action: "github.suspend" }]);
  });

  it("the App's own credentials refused (401), or GitHub down: the binding STAYS — only its last error says so", async () => {
    await twoOrgs();
    await setSecret(await adminB(), "github_token", "", TOKEN_B);
    const bad = github({ badAppCredentials: true });
    await quiet(() => runReconcileJob(e, systemCtx(ORG_B), NOW, { fetchImpl: bad.fetchImpl }));
    expect(auths(bad.reads)).toEqual([`Bearer ${TOKEN_B}`]);
    expect(await binding(ORG_B)).toMatchObject({ removed_at: null, suspended_at: null, last_error: "ask GitHub for a token: GitHub refused the App's credentials" });
    const down = github({ intercept: (s) => (s.url.includes("/access_tokens") ? new Response("nope", { status: 503 }) : undefined) });
    await quiet(() => runReconcileJob(e, systemCtx(ORG_B), NOW, { fetchImpl: down.fetchImpl }));
    expect(await binding(ORG_B)).toMatchObject({ removed_at: null, last_error: "ask GitHub for a token: github 503" });
    // It works again the moment GitHub does — and the error clears.
    const ok = github();
    await quiet(() => runReconcileJob(e, systemCtx(ORG_B), NOW, { fetchImpl: ok.fetchImpl }));
    expect(auths(ok.reads)).toEqual([`Bearer ${ok.app.tokenFor(INST_B)}`]);
    expect(await binding(ORG_B)).toMatchObject({ last_error: null });
  });
});

describe("Org settings › the App's routes", () => {
  const J = async <T>(res: Response): Promise<T> => (await res.json()) as T;
  async function acme(): Promise<{ admin: string; member: string }> {
    const admin = await cookieFor("olive", { member: false });
    await ensureMember("olive", "admin", ORG_B);
    const member = await cookieFor("mia", { member: false });
    await ensureMember("mia", "member", ORG_B);
    return { admin, member };
  }

  it("GET /github/repositories lists what the installation can see, marks what is tracked, and is cached briefly", async () => {
    const { admin, member } = await acme();
    await addOrgRepo(REPO_B, ORG_B);
    await addOrgRepo("beta-co/gone", ORG_B, { primary: false });
    await run(env.DB, `UPDATE org_repos SET connection = 'app' WHERE org_id = ?`, ORG_B);
    await seedInstallation(ORG_B, INST_B, "beta-co", { by: "olive" });
    const gh = github();
    vi.stubGlobal("fetch", gh.fetchImpl);
    const res = await call(admin, "/github/repositories", { slug: "acme" });
    expect(res.status).toBe(200);
    expect(await J<GithubReposDTO>(res)).toEqual({
      repositories: [{ full_name: REPO_B, private: false, tracked: true, is_primary: true }, { full_name: "beta-co/docs", private: true, tracked: false, is_primary: false }],
      total: 2, truncated: false,
    });
    // A connected repository the installation no longer lists is marked — and shows as such on the list.
    const repos = (await J<{ repos: OrgRepoDTO[] }>(await call(admin, "/repos", { slug: "acme" }))).repos;
    expect(repos.map((r) => [r.repo_full_name, r.connection, r.access_lost])).toEqual([[REPO_B, "app", false], ["beta-co/gone", "app", true]]);
    const asked = gh.app.seen.length;
    await call(admin, "/github/repositories", { slug: "acme" });
    expect(gh.app.seen).toHaveLength(asked); // from the isolate's cache
    await call(admin, "/github/repositories?refresh=1", { slug: "acme" });
    expect(gh.app.seen).toHaveLength(asked + 1);
    // Admins only; another org's admin sees nothing of it; no installation → its own 404.
    expect((await call(member, "/github/repositories", { slug: "acme" })).status).toBe(403);
    expect((await call(await cookieFor("AndresL230"), "/github/repositories")).status).toBe(404);
    expect(await J(await call(await cookieFor("AndresL230"), "/github/repositories"))).toMatchObject({ error: "not_connected" });
  });

  it("tracking an App repository at the plan's repository cap is refused with 402 plan_limit, and nothing is written", async () => {
    const { admin } = await acme();
    await seedInstallation(ORG_B, INST_B, "beta-co", { by: "olive" });
    await setOrgPlan(platformCtx("AndresL230"), "acme", { plan: "personal" }); // one repository
    vi.stubGlobal("fetch", github().fetchImpl);
    expect((await call(admin, "/github/repositories", { slug: "acme", method: "POST", body: { repo_full_name: REPO_B } })).status).toBe(201);
    const res = await call(admin, "/github/repositories", { slug: "acme", method: "POST", body: { repo_full_name: "beta-co/docs" } });
    expect(res.status).toBe(402);
    expect(await J<PlanRefusal>(res)).toMatchObject({
      error: "plan_limit", limit: "repositories", used: 1, cap: 1, plan: "personal", status: "active",
      message: "This organization has reached the 1 repository its Personal plan includes.",
    });
    // The one it has can still be made primary (not an addition), and the picker still lists both.
    expect((await call(admin, "/github/repositories", { slug: "acme", method: "POST", body: { repo_full_name: REPO_B, is_primary: true } })).status).toBe(200);
    expect((await J<GithubReposDTO>(await call(admin, "/github/repositories", { slug: "acme" }))).repositories.map((x) => [x.full_name, x.tracked])).toEqual([[REPO_B, true], ["beta-co/docs", false]]);
    expect(await all(env.DB, `SELECT repo_full_name FROM org_repos WHERE org_id = ?`, ORG_B)).toEqual([{ repo_full_name: REPO_B }]);
    expect(await all(env.DB, `SELECT target FROM org_admin_audit WHERE org_id = ? AND action = 'repo.add'`, ORG_B)).toEqual([{ target: REPO_B }]);
  });

  it("POST /github/repositories tracks a repository the installation can see — and refuses one it cannot", async () => {
    const { admin, member } = await acme();
    await seedInstallation(ORG_B, INST_B, "beta-co", { by: "olive" });
    const gh = github();
    vi.stubGlobal("fetch", gh.fetchImpl);
    const first1 = await call(admin, "/github/repositories", { slug: "acme", method: "POST", body: { repo_full_name: "BETA-CO/APP" } });
    expect(first1.status).toBe(201);
    const made = await J<{ repo: OrgRepoDTO }>(first1);
    expect(made.repo).toMatchObject({ repo_full_name: REPO_B, is_primary: true, connection: "app", access_lost: false, webhook_secret_configured: false }); // GitHub's own spelling
    const second = await call(admin, "/github/repositories", { slug: "acme", method: "POST", body: { repo_full_name: "beta-co/docs", is_primary: true } });
    expect((await J<{ repo: OrgRepoDTO }>(second)).repo).toMatchObject({ repo_full_name: "beta-co/docs", is_primary: true, connection: "app" });
    for (const name of ["SaplingLearn/sapling", "beta-co/nope", "", "not a repo"]) {
      const res = await call(admin, "/github/repositories", { slug: "acme", method: "POST", body: { repo_full_name: name } });
      expect([res.status, (await J<{ error: string }>(res)).error], name).toEqual([404, "not_visible"]);
    }
    expect((await call(member, "/github/repositories", { slug: "acme", method: "POST", body: { repo_full_name: REPO_B } })).status).toBe(403);
    expect((await call(admin, "/github/repositories", { slug: "acme", method: "POST", body: { repo_full_name: REPO_B }, headers: { authorization: "Bearer x" } })).status).toBe(403);
    expect(await all(env.DB, `SELECT repo_full_name, connection FROM org_repos WHERE org_id = ? ORDER BY repo_full_name`, ORG_B)).toEqual([
      { repo_full_name: REPO_B, connection: "app" }, { repo_full_name: "beta-co/docs", connection: "app" },
    ]);
    expect(await all(env.DB, `SELECT actor, action, target, detail FROM org_admin_audit WHERE org_id = ? AND action = 'repo.add' ORDER BY id`, ORG_B)).toEqual([
      { actor: "olive", action: "repo.add", target: REPO_B, detail: JSON.stringify({ primary: true, connection: "app" }) },
      { actor: "olive", action: "repo.add", target: "beta-co/docs", detail: JSON.stringify({ primary: true, connection: "app" }) },
    ]);
  });

  it("Test connection is a real read through an installation token; it notices a suspension, its lifting, and an uninstall", async () => {
    await acme();
    await addOrgRepo(REPO_B, ORG_B);
    await setSecret(await adminB(), "github_token", "", TOKEN_B);
    await seedInstallation(ORG_B, INST_B, "beta-co", { by: "olive" });
    const ctx = await tenantCtx("olive", "admin", { orgId: ORG_B });
    const gh = github();
    expect(await testGithubApp(ctx, e, NOW, gh.fetchImpl)).toEqual({ ok: true, detail: "GitHub answered through the installation on beta-co: 2 repositories." });
    const read = gh.app.seen.find((s) => s.url.includes("/installation/repositories"))!;
    expect(read.auth).toBe(`Bearer ${gh.app.tokenFor(INST_B)}`); // never the stored token
    expect((await binding(ORG_B))!.last_used_at).not.toBeNull();

    gh.app.world.installations[INST_B].suspended = true;
    expect(await quiet(() => testGithubApp(ctx, e, NOW, gh.fetchImpl))).toEqual({ ok: false, detail: "The installation on beta-co is suspended on GitHub. Unsuspend it there, then test again." });
    expect((await binding(ORG_B))!.suspended_at).not.toBeNull();
    gh.app.world.installations[INST_B].suspended = false;
    clearInstallationTokens();
    expect((await testGithubApp(ctx, e, NOW, gh.fetchImpl))!.ok).toBe(true); // GitHub says it is live again: the mark is lifted
    expect(await binding(ORG_B)).toMatchObject({ suspended_at: null, last_error: null });

    const broken = github({ badAppCredentials: true });
    clearInstallationTokens();
    expect((await quiet(() => testGithubApp(ctx, e, NOW, broken.fetchImpl)))!.detail).toContain("GitHub refused this Trov's App credentials");
    expect(await binding(ORG_B)).toMatchObject({ removed_at: null });

    gh.app.world.installations[INST_B].gone = true;
    expect((await quiet(() => testGithubApp(ctx, e, NOW, gh.fetchImpl)))!.detail).toBe("The Trov App is no longer installed on that GitHub account. Connect it again from Repositories.");
    expect(await binding(ORG_B)).toMatchObject({ removed_reason: "not_found" });
    expect(await testGithubApp(ctx, e, NOW, gh.fetchImpl)).toBeNull(); // nothing left to test
    await expect(testGithubApp(await tenantCtx("mia", "member", { orgId: ORG_B }), e, NOW, gh.fetchImpl)).rejects.toThrow();
  });

  it("the routes: status, test and disconnect — gated, audited, and Disconnect leaves the repositories connected", async () => {
    const { admin, member } = await acme();
    await addOrgRepo(REPO_B, ORG_B);
    await run(env.DB, `UPDATE org_repos SET connection = 'app' WHERE org_id = ?`, ORG_B);
    await seedInstallation(ORG_B, INST_B, "beta-co", { by: "olive" });
    const gh = github();
    vi.stubGlobal("fetch", gh.fetchImpl);

    const list = await J<IntegrationsListDTO>(await call(admin, "/integrations", { slug: "acme" }));
    expect(list.github_app).toMatchObject({ configured: true, lost: null, installation: { installation_id: INST_B, account_login: "beta-co", account_type: "Organization", repository_selection: "all", connected_by: "olive", suspended_at: null } });

    const tested = await call(admin, "/github/test", { slug: "acme", method: "POST", body: {} });
    expect(tested.status).toBe(200);
    expect(await J(tested)).toMatchObject({ ok: true, detail: "GitHub answered through the installation on beta-co: 2 repositories.", github_app: { installation: { account_login: "beta-co" } } });
    for (const path of ["/github/test", "/github/disconnect"]) {
      expect((await call(member, path, { slug: "acme", method: "POST", body: {} })).status, path).toBe(403);
      expect((await call(admin, path, { slug: "acme", method: "POST", body: {}, headers: { authorization: "Bearer x" } })).status, path).toBe(403);
    }
    expect((await binding(ORG_B))!.removed_at).toBeNull();

    const gone = await call(admin, "/github/disconnect", { slug: "acme", method: "POST", body: {} });
    expect(gone.status).toBe(200);
    const after = await J<{ ok: true; github_app: GithubAppStatusDTO; repos: OrgRepoDTO[] }>(gone);
    expect(after.github_app).toEqual({ configured: true, installation: null, lost: null, mismatch: null }); // asked for: not "lost"
    expect(after.repos.map((r) => [r.repo_full_name, r.connection])).toEqual([[REPO_B, "manual"]]);
    expect(await binding(ORG_B)).toMatchObject({ removed_reason: "disconnected" });
    expect(await all(env.DB, `SELECT actor, action, target FROM org_admin_audit WHERE org_id = ? AND action LIKE 'github.%'`, ORG_B)).toEqual([{ actor: "olive", action: "github.disconnect", target: "beta-co" }]);
    // The history shows it, in the org's own trail.
    const history = await J<{ audit: { action: string; actor: string }[] }>(await call(admin, "/integrations/audit", { slug: "acme" }));
    expect(history.audit.map((a) => a.action)).toContain("github.disconnect");
    // Nothing left: each route answers its own "not connected".
    for (const [method, path] of [["POST", "/github/disconnect"], ["POST", "/github/test"], ["GET", "/github/repositories"]] as const) {
      const res = await call(admin, path, { slug: "acme", method, ...(method === "POST" ? { body: {} } : {}) });
      expect([res.status, (await J<{ error: string }>(res)).error], path).toEqual([404, "not_connected"]);
    }
    // An installation that went away from GitHub's side reads as LOST until something replaces it.
    await seedInstallation(ORG_B, 777, "beta-co", { by: "olive" });
    await run(env.DB, `UPDATE org_github_installations SET removed_at = '2026-10-07T01:00:00.000Z', removed_reason = 'uninstalled' WHERE installation_id = 777`);
    expect((await J<GithubAppStatusDTO>(await call(member, "/github", { slug: "acme" }))).lost).toEqual({ account_login: "beta-co", reason: "uninstalled", at: "2026-10-07T01:00:00.000Z" });
  });

  it("a deployment with no App configured says so and offers nothing that would reach GitHub", async () => {
    const { admin } = await acme();
    const bare = { ...e, GITHUB_APP_SLUG: "", GITHUB_APP_ID: "", GITHUB_APP_PRIVATE_KEY: "" } as Env;
    expect(await J(await call(admin, "/github", { slug: "acme", env: bare }))).toEqual({ configured: false, installation: null, lost: null, mismatch: null });
    expect((await J<IntegrationsListDTO>(await call(admin, "/integrations", { slug: "acme", env: bare }))).github_app).toEqual({ configured: false, installation: null, lost: null, mismatch: null });
    for (const [method, path] of [["GET", "/github/repositories"], ["POST", "/github/test"], ["POST", "/github/disconnect"]] as const) {
      const res = await call(admin, path, { slug: "acme", method, env: bare, ...(method === "POST" ? { body: {} } : {}) });
      expect(res.status, path).toBe(404);
    }
  });
});

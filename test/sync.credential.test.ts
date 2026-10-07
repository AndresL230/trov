/**
 * Sync GitHub and THE org's GitHub credential (src/github-app/credential.ts; docs/architecture/sync.md ›
 * The credential): the panel's "can a sync start" (`GET /sync`), the batch route's own check, and the
 * run itself all ask the ONE source every GitHub read resolves from — the org's App installation, then
 * its stored token, then (SaplingLearn alone) the Worker's legacy secret. A status read never asks
 * GitHub for a token. GitHub is a stub — never the network.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import type { SyncRunView, SyncStatusView } from "@shared/sync";
import { syncBlockText, syncFailureTab } from "@shared/sync";
import { app } from "../src/routes";
import { SecretAccessError, setSecret } from "../src/data/secrets";
import { clearInstallationTokens } from "../src/github-app/api";
import { githubCredentialSource, resolveGithubCredential } from "../src/github-app/credential";
import { clearRepoLists } from "../src/github-app/repos";
import { runSyncBatch, syncStatus, type SyncBatchResult } from "../src/sync/runs";
import { localUpstreamFetch } from "../src/sync/local-upstream";
import { holdsLiveKey } from "../src/billing/config";
import { isLiveStripeKey, loopbackOrigin } from "../src/platform/loopback";
import { all, first } from "./helpers/db";
import { cookieFor } from "./helpers/persons";
import { addOrgRepo } from "./helpers/org-config";
import { fakeGithub } from "./helpers/repo";
import { fakeApp, seedInstallation, type FakeApp } from "./helpers/github-app";
import { ORG_A, ORG_B, bearerCtx, ensureMember, systemCtx, tenantCtx } from "./helpers/tenant";

const e = env as unknown as Env; // the pool configures the App: GITHUB_APP_SLUG / _ID / _PRIVATE_KEY (vitest.config.ts)
const noApp = { ...e, GITHUB_APP_SLUG: "" } as Env; // a Trov whose App cannot be offered (it could still sign)
const noKey = { ...e, GITHUB_APP_SLUG: "", GITHUB_APP_ID: "", GITHUB_APP_PRIVATE_KEY: "" } as Env; // no App at all
const NOW = Date.now();
const REPO_B = "beta-co/app";
const INST_B = 501;
const TOKEN_B = "ghp_beta_stored_token_0123456789abcdef";
const LEGACY = "ghs_legacy_worker_token_0000000000";

beforeEach(() => { clearInstallationTokens(); clearRepoLists(); });
afterEach(() => { vi.unstubAllGlobals(); });

interface Read { url: string; auth: string | null }
/** GitHub, whole: the App's endpoints and the repository API (`routes` answers `/repos/…` paths). */
function github(routes: Record<string, unknown> = {}, over: Parameters<typeof fakeApp>[0] = {}): { app: FakeApp; fetchImpl: typeof fetch; reads: Read[] } {
  const gh = fakeApp({ now: () => NOW, installations: { [INST_B]: { account: { login: "beta-co", id: 2, type: "Organization" }, repos: [{ full_name: REPO_B }] } }, ...over });
  const api = fakeGithub(routes);
  const reads: Read[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;
    if (new URL(url).host === "api.github.com" && (path.startsWith("/repos/") || path === "/graphql" || path.startsWith("/users/"))) {
      reads.push({ url, auth: new Headers(init?.headers).get("authorization") });
      return api.fetchImpl(input, init);
    }
    return gh.fetchImpl(input, init);
  }) as typeof fetch;
  return { app: gh, fetchImpl, reads };
}
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
  try { return await fn(); } finally { for (const s of spies) s.mockRestore(); }
}
const adminB = (envOver: Env = e) => tenantCtx("bob", "admin", { orgId: ORG_B, env: envOver });
const memberB = () => tenantCtx("mel", "member", { orgId: ORG_B });
/** Any request the Worker makes on its own (not through a test's `fetchImpl`) fails the test. */
const noNetwork = () => {
  const seen: string[] = [];
  vi.stubGlobal("fetch", async (input: unknown) => { seen.push(String(input instanceof Request ? input.url : input)); return new Response("no network in tests", { status: 599 }); });
  return seen;
};
const statusB = (envOver: Env = e) => adminB(envOver).then((ctx) => syncStatus(envOver, ctx, NOW));
const runsB = () => all<{ status: string; failures: string }>(env.DB, `SELECT status, failures FROM sync_runs WHERE org_id = ? ORDER BY id`, ORG_B);

describe("where the credential would come from — githubCredentialSource, the order resolveGithubCredential resolves in", () => {
  it("installation → stored token → SaplingLearn's legacy secret → none, and it agrees with the real resolve at every step", async () => {
    await addOrgRepo("SaplingLearn/sapling", ORG_A);
    await addOrgRepo(REPO_B, ORG_B);
    const gh = github();
    const withLegacy = { ...e, GITHUB_SERVICE_TOKEN: LEGACY } as Env;
    const both = async (org: string, envOver: Env, repo: string): Promise<[string | null, string | null]> => {
      const ctx = systemCtx(org, "system", envOver);
      return [await githubCredentialSource(ctx, envOver, { repo }), (await resolveGithubCredential(ctx, envOver, { repo, fetchImpl: gh.fetchImpl, now: NOW }))?.source ?? null];
    };
    // Nothing: an outside org has none; SaplingLearn has the Worker's legacy token, and only it.
    expect(await both(ORG_B, withLegacy, REPO_B)).toEqual([null, null]);
    expect(await both(ORG_A, withLegacy, "SaplingLearn/sapling")).toEqual(["token", "token"]);
    expect(await both(ORG_A, e, "SaplingLearn/sapling")).toEqual([null, null]);
    // A stored token.
    await setSecret(await adminB(), "github_token", "", TOKEN_B);
    expect(await both(ORG_B, e, REPO_B)).toEqual(["token", "token"]);
    // An installation outranks it — for a repository its account owns; another account's is the token's.
    await seedInstallation(ORG_B, INST_B, "beta-co", { by: "bob" });
    expect(await both(ORG_B, e, REPO_B)).toEqual(["app", "app"]);
    expect(await both(ORG_B, e, "BETA-CO/App")).toEqual(["app", "app"]); // the owner is matched without regard to case
    expect(await both(ORG_B, e, "someone-else/app")).toEqual(["token", "token"]);
    // A Worker that cannot sign as the App never asks the installation.
    expect(await both(ORG_B, noKey, REPO_B)).toEqual(["token", "token"]);
  });

  it("asks GitHub for nothing: no token is minted to answer it, and nothing is written", async () => {
    await addOrgRepo(REPO_B, ORG_B);
    await seedInstallation(ORG_B, INST_B, "beta-co", { by: "bob" });
    const seen = noNetwork();
    expect(await githubCredentialSource(systemCtx(ORG_B), e, { repo: REPO_B })).toBe("app");
    expect(seen).toEqual([]);
    expect(await first(env.DB, `SELECT last_used_at, last_error FROM org_github_installations WHERE org_id = ?`, ORG_B)).toEqual({ last_used_at: null, last_error: null });
  });

  it("a suspended installation does not answer: the stored token does, or nothing", async () => {
    await addOrgRepo(REPO_B, ORG_B);
    await seedInstallation(ORG_B, INST_B, "beta-co", { by: "bob", suspended: true });
    expect(await githubCredentialSource(systemCtx(ORG_B), e, { repo: REPO_B })).toBeNull();
    await setSecret(await adminB(), "github_token", "", TOKEN_B);
    expect(await githubCredentialSource(systemCtx(ORG_B), e, { repo: REPO_B })).toBe("token");
  });

  it("has getSecret's access rule: it throws for an MCP (bearer) context and for a member, before anything is looked up", async () => {
    await addOrgRepo(REPO_B, ORG_B);
    await seedInstallation(ORG_B, INST_B, "beta-co", { by: "bob" });
    await expect(githubCredentialSource(await memberB(), e, { repo: REPO_B })).rejects.toBeInstanceOf(SecretAccessError);
    await ensureMember("bob", "admin", ORG_B);
    await expect(githubCredentialSource(await bearerCtx("bob", "admin", e, ORG_B), e, { repo: REPO_B })).rejects.toBeInstanceOf(SecretAccessError);
    expect(await githubCredentialSource(await adminB(), e, { repo: REPO_B })).toBe("app");
  });
});

describe("GET /sync — can a sync start, with what, and where an admin connects GitHub", () => {
  it("an org on the GitHub App with NO token can sync: `via: app` — and reading the status mints nothing", async () => {
    await addOrgRepo(REPO_B, ORG_B);
    await seedInstallation(ORG_B, INST_B, "beta-co", { by: "bob" });
    const seen = noNetwork();
    expect(await statusB()).toMatchObject({ repo: REPO_B, admin: true, blocked: null, via: "app", connect: "app" });
    // A member reads the same answer (it is asked as the org's system tenant, never revealed).
    expect(await syncStatus(e, await memberB(), NOW)).toMatchObject({ admin: false, blocked: null, via: "app", connect: "app" });
    expect(seen).toEqual([]);
  });

  it("no credential: `no_token`, and `connect` says where THIS Trov connects GitHub — the setup checklist's test (the App configured or not)", async () => {
    await addOrgRepo(REPO_B, ORG_B);
    const configured = await statusB();
    expect(configured).toMatchObject({ repo: REPO_B, blocked: "no_token", via: null, connect: "app" });
    expect(syncBlockText(configured.blocked!, null, configured.connect)).toMatchObject({ tab: "repos", link: "Connect with GitHub in Org settings › Repositories" });
    // No slug: "Connect with GitHub" cannot be offered (`appConfigured`), so the token is the way.
    const bare = await statusB(noApp);
    expect(bare).toMatchObject({ blocked: "no_token", via: null, connect: "token" });
    expect(syncBlockText(bare.blocked!, null, bare.connect)).toMatchObject({ tab: "integrations", link: "Add one in Org settings › Integrations" });
    // It is the same `configured` Org settings › Repositories reads (GET …/github).
    await ensureMember("bob", "admin", ORG_B);
    const cookie = await cookieFor("bob", { member: false });
    for (const [envOver, want] of [[e, true], [noApp, false]] as const) {
      const gh = (await (await app.request("/api/o/acme/github", { headers: { cookie } }, envOver)).json()) as { configured: boolean };
      const sync = (await (await app.request("/api/o/acme/sync", { headers: { cookie } }, envOver)).json()) as SyncStatusView;
      expect(gh.configured).toBe(want);
      expect(sync.connect).toBe(want ? "app" : "token");
    }
  });

  it("a stored token still answers where the App is configured but not installed, suspended, or on another account", async () => {
    await addOrgRepo(REPO_B, ORG_B);
    await setSecret(await adminB(), "github_token", "", TOKEN_B);
    expect(await statusB()).toMatchObject({ blocked: null, via: "token", connect: "app" });
    await seedInstallation(ORG_B, INST_B, "another-account", { by: "bob" });
    expect(await statusB()).toMatchObject({ blocked: null, via: "token" });
    expect(JSON.stringify(await statusB())).not.toContain(TOKEN_B);
  });

  it("an installation that covers another account's repositories only, and no token: blocked — the run would have nothing to read with either", async () => {
    await addOrgRepo(REPO_B, ORG_B);
    await seedInstallation(ORG_B, INST_B, "another-account", { by: "bob" });
    expect(await statusB()).toMatchObject({ blocked: "no_token", via: null, connect: "app" });
    const out = await runSyncBatch(e, await adminB(), "bob", { start: true });
    expect(out).toEqual({ status: 503, body: { error: "service token or repo not configured" } });
    expect(await runsB()).toEqual([]);
  });
});

describe("POST /admin/backfill — the batch reads with the credential the status named", () => {
  const pr = (number: number) => ({
    number, title: `PR ${number}`, body: `body ${number}`, html_url: `https://github.com/${REPO_B}/pull/${number}`,
    merged_at: "2026-06-28T00:00:00Z", closed_at: "2026-06-28T00:00:00Z", updated_at: "2026-06-28T00:00:00Z", user: { login: "octocat" }, milestone: null,
  });

  it("through the App: one repository-scoped token for the whole run, the stored token never sent, the use recorded on the binding", async () => {
    await addOrgRepo(REPO_B, ORG_B);
    await seedInstallation(ORG_B, INST_B, "beta-co", { by: "bob" });
    await setSecret(await adminB(), "github_token", "", TOKEN_B);
    const gh = github({ [`/repos/${REPO_B}/pulls`]: [pr(1), pr(2)] });
    noNetwork();
    expect((await statusB()).via).toBe("app");
    const out = await quiet(async () => runSyncBatch(e, await adminB(), "bob", { batch: 1, of: 10, start: true }, { backfillOpts: { fetchImpl: gh.fetchImpl, summarizer: null, issueSummarizer: null }, reconcile: async () => ({ written: 3, unchanged: 0, failed: [] }) }));
    expect(out.status).toBe(200);
    const body = out.body as SyncBatchResult;
    expect(body.run).toMatchObject({ status: "ok", repo: REPO_B, by: "bob", failures: [], counts: { prs_seen: 2, prs_new: 2, repo_written: 3 } });
    expect(gh.app.mints).toHaveLength(1);
    expect(gh.app.mints[0]).toMatchObject({ installation: INST_B, repositories: ["app"] });
    expect([...new Set(gh.reads.map((r) => r.auth))]).toEqual([`Bearer ${gh.app.minted[0]}`]);
    expect((await first<{ last_used_at: string | null }>(env.DB, `SELECT last_used_at FROM org_github_installations WHERE org_id = ?`, ORG_B))!.last_used_at).not.toBeNull();
    const kept = JSON.stringify(out.body) + JSON.stringify(await all(env.DB, `SELECT * FROM sync_runs`));
    expect(kept).not.toContain(gh.app.minted[0]);
    expect(kept).not.toContain(TOKEN_B);
  });

  it("over HTTP, on both mounts: the org-prefixed route and the old-path alias run the same batch through the App", async () => {
    await ensureMember("bob", "admin", ORG_B);
    await addOrgRepo(REPO_B, ORG_B);
    await seedInstallation(ORG_B, INST_B, "beta-co", { by: "bob" });
    const gh = github({ [`/repos/${REPO_B}/pulls`]: [pr(7)] });
    vi.stubGlobal("fetch", gh.fetchImpl); // the route passes no fetch of its own
    const cookie = await cookieFor("bob", { member: false }); // in ONE org, so the old path resolves to it
    const post = (path: string, body: unknown) => quiet(() => Promise.resolve(app.request(path, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }, e)));
    const first1 = await post("/api/o/acme/admin/backfill", { batch: 1, of: 10, start: true });
    expect(first1.status).toBe(200);
    const one = (await first1.json()) as SyncBatchResult;
    expect(one).toMatchObject({ ok: true, prs: 1, capturedPrs: 1, run: { status: expect.stringMatching(/^(ok|partial)$/), repo: REPO_B, by: "bob" }, summaries: { status: "off" } });
    // bob has one org, so the old path (`/admin/backfill`, no slug) resolves to it and starts the next run.
    const alias = await post("/admin/backfill", { batch: 1, of: 10, start: true });
    expect(alias.status).toBe(200);
    const two = (await alias.json()) as SyncBatchResult;
    expect(two.run.id).not.toBe(one.run.id);
    expect(two).toMatchObject({ prs: 1, capturedPrs: 0, run: { repo: REPO_B, by: "bob" } });
    expect(gh.reads.every((r) => r.auth === `Bearer ${gh.app.minted[0]}`)).toBe(true);
    expect(await runsB()).toHaveLength(2);
  });

  it("a read GitHub refuses the App: the failure names how it was read, so its fix points at Repositories, not at a token", async () => {
    await addOrgRepo(REPO_B, ORG_B);
    await seedInstallation(ORG_B, INST_B, "beta-co", { by: "bob" });
    const gh = github({}, { intercept: (s) => (s.url.includes(`/repos/${REPO_B}/pulls`) ? new Response(`{"message":"Not Found"}`, { status: 404 }) : undefined) });
    const refuse = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return url.includes(`/repos/${REPO_B}/`) ? new Response(`{"message":"Not Found"}`, { status: 404 }) : gh.fetchImpl(input, init);
    }) as typeof fetch;
    const out = await quiet(async () => runSyncBatch(e, await adminB(), "bob", { start: true }, { backfillOpts: { fetchImpl: refuse } }));
    expect(out.status).toBe(503);
    const run = (out.body as { run: SyncRunView }).run;
    expect(run).toMatchObject({ status: "failed", failures: [{ code: "list_prs", status: 404, via: "app" }] });
    expect(syncFailureTab(run.failures[0])).toBe("repos");
    // …and with a token it points at Integrations, as before.
    await setSecret(await adminB(), "github_token", "", TOKEN_B);
    const viaToken = await quiet(async () => runSyncBatch(noKey, await adminB(noKey), "bob", { start: true }, { backfillOpts: { fetchImpl: refuse } }));
    const tokenRun = (viaToken.body as { run: SyncRunView }).run;
    expect(tokenRun.failures).toEqual([{ code: "list_prs", status: 404, via: "token" }]);
    expect(syncFailureTab(tokenRun.failures[0])).toBe("integrations");
  });

  it("a part of the closing refresh that fails carries the credential too", async () => {
    await addOrgRepo(REPO_B, ORG_B);
    await seedInstallation(ORG_B, INST_B, "beta-co", { by: "bob" });
    const gh = github();
    const out = await quiet(async () => runSyncBatch(e, await adminB(), "bob", { start: true }, { backfillOpts: { fetchImpl: gh.fetchImpl, summarizer: null, issueSummarizer: null }, reconcile: async () => ({ written: 1, unchanged: 0, failed: ["runs", "unexpected error"] }) }));
    expect((out.body as SyncBatchResult).run).toMatchObject({ status: "partial", failures: [{ code: "reconcile:runs", via: "app" }, { code: "reconcile:unexpected" }] });
  });

  it("GitHub will not issue the installation's token and there is no stored one: the run is recorded as failed (`not_configured`), nothing is written", async () => {
    // The status read does not mint, so it still says `app` here; the run is where a refused mint shows.
    await addOrgRepo(REPO_B, ORG_B);
    await seedInstallation(ORG_B, INST_B, "beta-co", { by: "bob" });
    const gh = github({}, { badAppCredentials: true });
    expect((await statusB()).via).toBe("app");
    const out = await quiet(async () => runSyncBatch(e, await adminB(), "bob", { start: true }, { backfillOpts: { fetchImpl: gh.fetchImpl } }));
    expect(out.status).toBe(503);
    expect((out.body as { run: SyncRunView }).run).toMatchObject({ status: "failed", failures: [{ code: "not_configured" }] });
    expect(gh.reads).toEqual([]);
    expect(await first(env.DB, `SELECT 1 AS x FROM events WHERE org_id = ?`, ORG_B)).toBeNull();
    // The binding says why (Org settings › Integrations shows it), and the lock is released.
    expect((await first<{ last_error: string | null }>(env.DB, `SELECT last_error FROM org_github_installations WHERE org_id = ?`, ORG_B))!.last_error).not.toBeNull();
    expect((await statusB()).blocked).toBeNull();
  });
});

describe("the local stand-ins (LOCAL_UPSTREAM, STRIPE_TEST_API_BASE) pass ONE test — src/platform/loopback.ts", () => {
  it("loopback http only: any path is dropped; https, another host, a look-alike host and junk are refused", () => {
    expect(loopbackOrigin("http://127.0.0.1:8862")).toBe("http://127.0.0.1:8862");
    expect(loopbackOrigin(" http://localhost:8862/some/path?x=1 ")).toBe("http://localhost:8862");
    for (const v of [undefined, null, "", "  ", "nonsense", "https://127.0.0.1:8862", "https://localhost", "http://example.com", "http://169.254.169.254", "http://0.0.0.0:80",
      "http://[::1]:80", "http://127.0.0.1.evil.example", "http://localhost.evil.example", "http://evil.example/http://127.0.0.1", "ftp://127.0.0.1", "//127.0.0.1"]) {
      expect(loopbackOrigin(v), String(v)).toBeNull();
    }
  });

  it("a live key is recognised by its own form", () => {
    for (const k of ["sk_live_x", "rk_live_x", " sk_live_x "]) expect(isLiveStripeKey(k), k).toBe(true);
    for (const k of [undefined, null, "", "sk_test_x", "rk_test_x", "pk_live_x", "xsk_live_x", "whsec_live"]) expect(isLiveStripeKey(k), String(k)).toBe(false);
    expect(holdsLiveKey({ STRIPE_SECRET_KEY: "sk_live_x" })).toBe(true);
    expect(holdsLiveKey({ STRIPE_SECRET_KEY: "sk_test_x" })).toBe(false);
    expect(holdsLiveKey({})).toBe(false);
  });

  it("LOCAL_UPSTREAM is never honoured beside a live key — a loopback value included", () => {
    const base = "http://127.0.0.1:8862";
    expect(localUpstreamFetch({ LOCAL_UPSTREAM: base })).toBeTypeOf("function");
    expect(localUpstreamFetch({ LOCAL_UPSTREAM: base, STRIPE_SECRET_KEY: "sk_test_x" })).toBeTypeOf("function");
    expect(localUpstreamFetch({ LOCAL_UPSTREAM: base, STRIPE_SECRET_KEY: "sk_live_x" })).toBeUndefined();
    expect(localUpstreamFetch({ LOCAL_UPSTREAM: base, STRIPE_SECRET_KEY: "rk_live_x" })).toBeUndefined();
    expect(localUpstreamFetch({ LOCAL_UPSTREAM: "http://localhost:8862", STRIPE_SECRET_KEY: " sk_live_x" })).toBeUndefined();
    expect(localUpstreamFetch({ LOCAL_UPSTREAM: "https://evil.example", STRIPE_SECRET_KEY: "sk_test_x" })).toBeUndefined();
  });

  it("with a live key a sync talks to the real hosts: the batch's fetch is not rewritten", async () => {
    await addOrgRepo(REPO_B, ORG_B);
    await setSecret(await adminB(), "github_token", "", TOKEN_B);
    const seen = noNetwork();
    const live = { ...noKey, LOCAL_UPSTREAM: "http://127.0.0.1:8862", STRIPE_SECRET_KEY: "sk_live_x" } as Env;
    await quiet(async () => runSyncBatch(live, await adminB(live), "bob", { start: true }));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((u) => u.startsWith("https://api.github.com/"))).toBe(true);
    // …and without one, the same batch goes to the stand-in.
    seen.length = 0;
    const local = { ...noKey, LOCAL_UPSTREAM: "http://127.0.0.1:8862" } as Env;
    await quiet(async () => runSyncBatch(local, await adminB(local), "bob", { start: true }));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((u) => u.startsWith("http://127.0.0.1:8862/github/"))).toBe(true);
  });
});

// THE GitHub credential (src/github-app/credential.ts; spec §6) and the four jobs that use it: an installation
// token for an attached, unsuspended repository of a configured App — scoped to that one repository, read only —
// else the pasted `github_token`; a failed mint falls back to it; a bearer or a member gets nothing. The jobs
// (reconcile, progress, Sync GitHub, the per-repo hook's follow-up reads) read with whichever answered, and keep
// the pasted token's bookkeeping only when it was the pasted token they used. No App secret, JWT or token in a
// log line, a stored error or a thrown message.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { inspect } from "node:util";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { SecretAccessError, setSecret } from "../src/data/secrets";
import { JOB_PERMISSIONS, githubCredential, resolveGithubToken } from "../src/github-app/credential";
import { githubAppConfig } from "../src/github-app/config";
import { reconcileCost, refreshSubrequests, runOrgJob, runReconcileJob, SUBREQUEST_CAP } from "../src/repo/cron";
import { runBackfill } from "../src/tools/backfill";
import { handleGithubWebhook } from "../src/github-hook";
import { all, first, run, nowIso } from "./helpers/db";
import { ORG_A, ORG_B, bearerCtx, systemCtx, tenantCtx } from "./helpers/tenant";
import { addOrgRepo, setOrgEnvironments } from "./helpers/org-config";
import { ENVS, fakeGithub, leakedFragments } from "./helpers/repo";
import { APP, appEnv, attachRepo, fakeAppGithub, installationToken, seedInstallation, type AppCall } from "./helpers/github-app";
import workflowRun from "./fixtures/gh-workflow-run.json";

const e = env as unknown as Env;
const ID = 5150;
const REPO = "beta-co/app";
const HOOK = "hook_beta_app";
const PASTED = "ghp_pasted_".padEnd(64, "0f1e2d3c4b5a6978");
const HOOK_SECRET = "whsec_beta_".padEnd(48, "13579bdf");
const INST = installationToken(ID);
const target = { id: HOOK, repo: REPO };

// ── every console line of every test is checked for every secret ─────────────
const logged: unknown[][] = [];
const jwts: string[] = [];
beforeEach(() => {
  logged.length = 0;
  jwts.length = 0;
  for (const level of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args); });
});
afterEach(async () => {
  vi.restoreAllMocks();
  const cfg = githubAppConfig(await appEnv())!;
  const text = logged.map((args) => args.map((a) => `${String(a)} ${inspect(a, { depth: 6 })} ${a instanceof Error ? a.stack : ""}`).join(" ")).join("\n");
  const keyBody = cfg.privateKeyPem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  for (const secret of [keyBody, APP.clientSecret, APP.webhookSecret, INST, PASTED, ...jwts]) expect(leakedFragments(text, secret), secret.slice(0, 10)).toEqual([]);
});

/** A fake GitHub: the App's calls (the mint) and every other read through `fakeGithub`. JWTs are collected
 *  for the leak check above. */
function world(o: Parameters<typeof fakeAppGithub>[0] = {}) {
  const reads = fakeGithub({ "/issues/1": { state: "closed" } });
  const gh = fakeAppGithub({ fallback: reads.fetchImpl, ...o });
  const fetchImpl = (async (u: RequestInfo | URL, init?: RequestInit) => {
    try { return await gh.fetchImpl(u, init); } finally {
      const last = gh.calls.at(-1);
      if (last?.url.includes("/access_tokens") && last.auth) jwts.push(last.auth.replace(/^Bearer /, ""));
    }
  }) as typeof fetch;
  const mints = () => gh.calls.filter((c) => c.url.endsWith("/access_tokens"));
  const reading = () => gh.calls.filter((c) => c.url.startsWith(`https://api.github.com/repos/${REPO}`) || c.url === "https://api.github.com/graphql");
  return { fetchImpl, calls: gh.calls, mints, reading };
}

/** Org B: its primary repo, a stored pasted token and webhook secret, and — unless `attached: false` — an
 *  installation of the App covering the repo, attached. */
async function orgB(o: { attached?: boolean; suspended?: string | null; pasted?: boolean } = {}): Promise<void> {
  await addOrgRepo(REPO, ORG_B, { id: HOOK });
  await setOrgEnvironments(ENVS, ORG_B);
  const admin = await tenantCtx("bob", "admin", { orgId: ORG_B });
  if (o.pasted !== false) await setSecret(admin, "github_token", "", PASTED);
  await setSecret(admin, "github_webhook", HOOK, HOOK_SECRET);
  await seedInstallation(ORG_B, ID, [{ id: 77, full_name: REPO }], { suspended: o.suspended ?? null });
  if (o.attached !== false) await attachRepo(HOOK, ID);
}
const tokenRow = () => first<{ last_used_at: string | null; last_error: string | null }>(env.DB,
  `SELECT last_used_at, last_error FROM org_secrets WHERE org_id = ? AND kind = 'github_token'`, ORG_B);

describe("resolveGithubToken — the order", () => {
  it("an attached repo of a configured App: a fresh installation token, minted for THAT repository with the jobs' read permissions", async () => {
    await orgB();
    const w = world();
    const token = await resolveGithubToken(systemCtx(ORG_B), await appEnv(), target, { fetchImpl: w.fetchImpl, now: Date.parse("2026-10-06T21:00:00Z") });
    expect(token?.reveal()).toBe(INST);
    expect(w.mints()).toHaveLength(1);
    expect(w.mints()[0].url).toBe(`https://api.github.com/app/installations/${ID}/access_tokens`);
    expect(JSON.parse(w.mints()[0].body)).toEqual({ repositories: ["app"], permissions: JOB_PERMISSIONS });
    expect(Object.values(JOB_PERMISSIONS).every((p) => p === "read")).toBe(true);
    expect(Object.keys(JOB_PERMISSIONS).sort()).toEqual(["actions", "checks", "contents", "deployments", "issues", "metadata", "pull_requests", "statuses"]);
    expect((await githubCredential(systemCtx(ORG_B), await appEnv(), target, { fetchImpl: w.fetchImpl }))?.source).toBe("installation");
  });

  it("an admin's session (Sync GitHub, Poll now) is served too", async () => {
    await orgB();
    const w = world();
    expect((await resolveGithubToken(await tenantCtx("bob", "admin", { orgId: ORG_B }), await appEnv(), target, { fetchImpl: w.fetchImpl }))?.reveal()).toBe(INST);
  });

  it("a SUSPENDED installation: the pasted token, and no request", async () => {
    await orgB({ suspended: "2026-10-06T00:00:00Z" });
    const w = world();
    const cred = await githubCredential(systemCtx(ORG_B), await appEnv(), target, { fetchImpl: w.fetchImpl });
    expect(cred).toMatchObject({ source: "pasted" });
    expect(cred?.token.reveal()).toBe(PASTED);
    expect(w.calls).toEqual([]);
  });

  for (const [what, mint] of [["refuses (401, echoing the request)", 401], ["cannot be reached (the fetch throws)", "throw"]] as const) {
    it(`a mint GitHub ${what}: ONE scrubbed log line, and the pasted token`, async () => {
      await orgB();
      const w = world({ mint });
      const cred = await githubCredential(systemCtx(ORG_B), await appEnv(), target, { fetchImpl: w.fetchImpl });
      expect(cred).toMatchObject({ source: "pasted" });
      expect(cred?.token.reveal()).toBe(PASTED);
      expect(logged).toHaveLength(1);
      expect(String(logged[0][0])).toBe("github app: installation token failed, using the pasted token");
      expect(String(logged[0][1])).toMatch(/^GitHub POST \/app\/installations\/\{id\}\/access_tokens /);
      expect(logged[0][2]).toBe(`org=${ORG_B}`);
    });
  }

  it("the App NOT configured (the pool's default): the pasted token, and no request — attached or not", async () => {
    await orgB();
    const w = world();
    expect((await githubCredential(systemCtx(ORG_B), e, target, { fetchImpl: w.fetchImpl }))?.source).toBe("pasted");
    expect(w.calls).toEqual([]);
  });

  it("a repo connected the 0037 way (not attached): the pasted token; neither: null", async () => {
    await orgB({ attached: false });
    const w = world();
    expect((await githubCredential(systemCtx(ORG_B), await appEnv(), target, { fetchImpl: w.fetchImpl }))?.source).toBe("pasted");
    await run(env.DB, `DELETE FROM org_secrets WHERE org_id = ? AND kind = 'github_token'`, ORG_B);
    expect(await resolveGithubToken(systemCtx(ORG_B), await appEnv(), target, { fetchImpl: w.fetchImpl })).toBeNull();
    expect(w.calls).toEqual([]);
  });

  it("SaplingLearn off the App still falls back to the Worker's GITHUB_SERVICE_TOKEN", async () => {
    const id = await addOrgRepo("SaplingLearn/sapling", ORG_A);
    const legacy = await appEnv(e, { GITHUB_SERVICE_TOKEN: "ghs_legacy_worker_token_0000000000" });
    expect((await resolveGithubToken(systemCtx(ORG_A), legacy, { id, repo: "SaplingLearn/sapling" }))?.reveal()).toBe("ghs_legacy_worker_token_0000000000");
  });

  it("a bearer (MCP) context and a plain member are refused before anything is read or minted", async () => {
    await orgB();
    const w = world();
    const app = await appEnv();
    for (const ctx of [await bearerCtx("bob", "admin", undefined, ORG_B), await bearerCtx("AndresL230"), await tenantCtx("carol", "member", { orgId: ORG_B })]) {
      await expect(resolveGithubToken(ctx, app, target, { fetchImpl: w.fetchImpl })).rejects.toBeInstanceOf(SecretAccessError);
    }
    expect(w.calls).toEqual([]);
  });
});

describe("the jobs read with it", () => {
  it("the budget: reconcile 20 + 2N (the mint is one subrequest), Poll now 20 + 7N — 34 for two, 48 at N = 4 (under the cap), 55 at N = 5", () => {
    expect(reconcileCost(2)).toBe(24);
    expect(refreshSubrequests(2)).toBe(34);
    expect(refreshSubrequests(4)).toBe(48);
    expect(refreshSubrequests(4)).toBeLessThanOrEqual(SUBREQUEST_CAP);
    expect(refreshSubrequests(5)).toBe(55);
  });

  it("reconcile on the App: every GitHub read carries the installation token, the pasted one is never sent nor marked used", async () => {
    await orgB();
    const w = world();
    const res = await runReconcileJob(await appEnv(), systemCtx(ORG_B), Date.parse("2026-10-06T21:00:00Z"), { fetchImpl: w.fetchImpl });
    expect(res).toEqual(expect.objectContaining({ failed: [] }));
    expect(w.mints()).toHaveLength(1);
    expect(w.reading().length).toBeGreaterThan(5);
    for (const c of w.reading()) expect(c.auth).toBe(`Bearer ${INST}`);
    expect(w.calls.some((c) => c.auth?.includes(PASTED))).toBe(false);
    expect(w.calls.length).toBeLessThanOrEqual(reconcileCost(ENVS.length));
    expect(await tokenRow()).toEqual({ last_used_at: null, last_error: null });
  });

  it("reconcile with a failing mint: the pasted token reads, and ITS row records the use", async () => {
    await orgB();
    const w = world({ mint: 500 });
    await runReconcileJob(await appEnv(), systemCtx(ORG_B), Date.parse("2026-10-06T21:00:00Z"), { fetchImpl: w.fetchImpl });
    for (const c of w.reading()) expect(c.auth).toBe(`Bearer ${PASTED}`);
    expect((await tokenRow())?.last_used_at).not.toBeNull();
  });

  it("the progress backstop on the App reads with the installation token and leaves the pasted token's row alone", async () => {
    await orgB();
    await run(env.DB, `INSERT INTO sprints (org_id, title, target_date, status, github_ref, created_at, created_by) VALUES (?, 'S', '2026-10-30', 'in_progress', '[1]', ?, 'bob')`, ORG_B, nowIso());
    const w = world();
    await runOrgJob(await appEnv(), ORG_B, "progress", Date.parse("2026-10-06T21:10:00Z"), w.fetchImpl);
    expect(w.reading().map((c) => [c.url, c.auth])).toEqual([[`https://api.github.com/repos/${REPO}/issues/1`, `Bearer ${INST}`]]);
    expect(await all(env.DB, `SELECT org_id, closed, total FROM sprint_progress`)).toEqual([{ org_id: ORG_B, closed: 1, total: 1 }]);
    expect((await tokenRow())?.last_used_at).toBeNull();
  });

  it("Sync GitHub (runBackfill) on the App lists PRs and issues with the installation token", async () => {
    await orgB();
    const w = world();
    const res = await runBackfill(await appEnv(), await tenantCtx("bob", "admin", { orgId: ORG_B }), "bob", { fetchImpl: w.fetchImpl, summarizer: null, issueSummarizer: null });
    expect(res.ok).toBe(true);
    const lists = w.calls.filter((c) => c.url.includes(`/repos/${REPO}/pulls`) || c.url.includes(`/repos/${REPO}/issues`));
    expect(lists).toHaveLength(2);
    for (const c of lists) expect(c.auth).toBe(`Bearer ${INST}`);
    expect((await tokenRow())?.last_used_at).toBeNull();
  });

  it("the per-repo hook's follow-up read (a failed run) uses the installation token — minted once, lazily", async () => {
    await orgB();
    const w = world();
    const body = JSON.stringify({ ...workflowRun, repository: { full_name: REPO } });
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(HOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = "sha256=" + [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const res = await handleGithubWebhook(new Request("https://trov.test/webhook/github/" + HOOK, {
      method: "POST", body, headers: { "x-github-event": "workflow_run", "x-hub-signature-256": sig },
    }), await appEnv(), { hookId: HOOK, fetchImpl: w.fetchImpl });
    expect(res.status).toBe(200);
    expect(w.mints()).toHaveLength(1);
    const runs = w.calls.filter((c) => c.url.includes(`/repos/${REPO}/actions/runs/`));
    expect(runs).toHaveLength(1);
    expect(runs[0].auth).toBe(`Bearer ${INST}`);
    expect((await tokenRow())?.last_used_at).toBeNull();
  });

  it("a delivery that needs no follow-up read mints nothing", async () => {
    await orgB();
    const w = world();
    const body = JSON.stringify({ zen: "Keep it logically awesome.", hook_id: 1 });
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(HOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = "sha256=" + [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const res = await handleGithubWebhook(new Request("https://trov.test/webhook/github/" + HOOK, {
      method: "POST", body, headers: { "x-github-event": "ping", "x-hub-signature-256": sig },
    }), await appEnv(), { hookId: HOOK, fetchImpl: w.fetchImpl });
    expect(res.status).toBe(202); // ping names no repository: acknowledged and ignored
    expect(w.calls).toEqual([] as AppCall[]);
  });

  it("an echoing GitHub during a reconcile on the App: nothing secret reaches a log line or a stored error", async () => {
    await orgB();
    const w = world({
      fallback: (async (_u: RequestInfo | URL, init?: RequestInit) => {
        throw new Error(`request failed: ${JSON.stringify(init?.headers)} ${String(init?.body ?? "")}`);
      }) as typeof fetch,
    });
    const res = await runReconcileJob(await appEnv(), systemCtx(ORG_B), Date.parse("2026-10-06T21:00:00Z"), { fetchImpl: w.fetchImpl });
    expect(res?.failed.length).toBeGreaterThan(0);
    expect(logged.length).toBeGreaterThan(0);
    const stored = JSON.stringify(await all(env.DB, `SELECT * FROM org_secrets`)) + JSON.stringify(await all(env.DB, `SELECT * FROM github_installations`));
    for (const secret of [INST, PASTED, ...jwts]) expect(leakedFragments(stored, secret)).toEqual([]);
  });
});

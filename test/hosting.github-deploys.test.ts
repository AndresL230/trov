/**
 * A `github` part's deploys from the GitHub capture (src/hosting/github-deploys.ts) and the rollback compare
 * (src/hosting/rollback.ts). What matters:
 *   - THE GUARD: an untagged signal never sets a part's deploy without a matching part setting — exact
 *     environment name / app + check name / workflow file, on the environment's branch;
 *   - a matched signal upserts ONE deploy (`source = 'github'`, `sha_source = 'provider'`), its state moving;
 *   - THE ROLLBACK COMPARE: a new ready sha → ONE compare (previous...new); `behind` sets `rolled_back_from`,
 *     `ahead` / `identical` do not; previews, the first deploy and the same sha cost no request.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { all, first } from "./helpers/db";
import { SAPLING_HOOK, addOrgRepo, setOrgEnvironments } from "./helpers/org-config";
import { handleGithubWebhook } from "../src/github-hook";
import { ORG_A, systemCtx, tenantCtx } from "./helpers/tenant";
import { ENVS, fakeGithub } from "./helpers/repo";
import { backfillGithubDeploys, deployFromSignal, signalMatchesPart, writeGithubDeploys } from "../src/hosting/github-deploys";
import { putPart } from "../src/hosting/part-writes";
import { setSecret } from "../src/data/secrets";
import { reconcileRepo } from "../src/repo/github";
import { ingestRepoEvent } from "../src/consumer";
import { checkRollback } from "../src/hosting/rollback";
import { upsertDeploys, type CleanDeploy } from "../src/hosting/deploy-store";
import { repoEventsFromDelivery } from "../src/repo/capture";
import type { RepoEvent } from "../src/repo/types";

const SHA1 = "1".repeat(40), SHA2 = "2".repeat(40), SHA3 = "3".repeat(40);

async function addGithubPart(envKey: string, key: string, settings: Record<string, string>, role: "web" | "service" = "web"): Promise<void> {
  await env.DB.prepare(`INSERT INTO org_environment_parts (org_id, env_key, part_key, position, label, role, provider, settings, created_at, updated_at, updated_by)
    VALUES (?, ?, ?, 0, ?, ?, 'github', ?, 'x', 'x', 'test')`).bind(ORG_A, envKey, key, key, role, JSON.stringify(settings)).run();
}

const deploymentStatus = (o: { id?: number; environment?: string; state?: string; ref?: string; sha?: string; at?: string; description?: string; workflow?: string } = {}) => ({
  action: "created",
  deployment_status: { id: 900 + (o.id ?? 1), state: o.state ?? "success", environment: o.environment ?? "web / staging", description: o.description ?? "",
    created_at: o.at ?? "2026-10-15T10:00:00Z", updated_at: o.at ?? "2026-10-15T10:00:00Z", log_url: "https://railway.com/project/p/logs", environment_url: "https://web-staging.up.railway.app" },
  deployment: { id: o.id ?? 1, sha: o.sha ?? SHA1, ref: o.ref ?? o.sha ?? SHA1, environment: o.environment ?? "web / staging", created_at: "2026-10-15T09:58:00Z", creator: { login: "railway-app[bot]" } },
  ...(o.workflow ? { workflow: { path: o.workflow } } : {}),
});
const checkRun = (o: { id?: number; app?: string; name?: string; branch?: string; conclusion?: string | null; title?: string } = {}) => ({
  action: o.conclusion === null ? "created" : "completed",
  check_run: { id: o.id ?? 5, name: o.name ?? "Workers Builds: web", head_sha: SHA1, status: o.conclusion === null ? "in_progress" : "completed",
    conclusion: o.conclusion === null ? null : o.conclusion ?? "success", started_at: "2026-10-15T10:00:00Z", completed_at: "2026-10-15T10:02:00Z",
    details_url: "https://dash.cloudflare.com/x", app: { slug: o.app ?? "cloudflare-workers-and-pages" }, check_suite: { head_branch: o.branch ?? "main" },
    output: { title: o.title ?? null } },
});
const workflowRun = (o: { path?: string; branch?: string; conclusion?: string } = {}) => ({
  action: "completed",
  workflow_run: { id: 77, name: "Deploy jobs", path: o.path ?? ".github/workflows/deploy-jobs.yml", head_branch: o.branch ?? "main", head_sha: SHA1,
    conclusion: o.conclusion ?? "success", run_attempt: 1, updated_at: "2026-10-15T10:05:00Z", run_started_at: "2026-10-15T10:01:00Z",
    html_url: "https://github.com/SaplingLearn/sapling/actions/runs/77", actor: { login: "AndresL230" }, event: "push" },
});
const ev = (name: string, payload: unknown): RepoEvent => repoEventsFromDelivery(name, payload)[0];
const part = (settings: Record<string, string>, provider = "github", branch = "main") => ({ provider, branch, settings }) as Parameters<typeof signalMatchesPart>[1];
const deploys = () => all<Record<string, unknown>>(env.DB,
  `SELECT env, part, provider, deploy_id, state, sha, sha_source, source, branch, reason, rolled_back_from FROM hosting_deploys WHERE org_id = ? ORDER BY env, part, deploy_id`, ORG_A);

describe("THE GUARD — signalMatchesPart", () => {
  it("matches only through the part's own setting, on the environment's branch", () => {
    // environment: exact name; a sha ref says nothing about the branch, a branch ref must be the environment's
    expect(signalMatchesPart(ev("deployment_status", deploymentStatus()), part({ environment: "web / staging" }))).toBe(true);
    expect(signalMatchesPart(ev("deployment_status", deploymentStatus({ ref: "main" })), part({ environment: "web / staging" }))).toBe(true);
    expect(signalMatchesPart(ev("deployment_status", deploymentStatus({ ref: "feat/x" })), part({ environment: "web / staging" }))).toBe(false);
    expect(signalMatchesPart(ev("deployment_status", deploymentStatus({ environment: "web / staging-2" })), part({ environment: "web / staging" }))).toBe(false);
    expect(signalMatchesPart(ev("deployment_status", deploymentStatus({ environment: "Web / Staging" })), part({ environment: "web / staging" }))).toBe(false);
    // check run: app AND name AND branch
    expect(signalMatchesPart(ev("check_run", checkRun()), part({ check_app: "cloudflare-workers-and-pages", check_name: "Workers Builds: web" }))).toBe(true);
    expect(signalMatchesPart(ev("check_run", checkRun({ app: "github-actions" })), part({ check_app: "cloudflare-workers-and-pages", check_name: "Workers Builds: web" }))).toBe(false);
    expect(signalMatchesPart(ev("check_run", checkRun({ name: "Workers Builds: api" })), part({ check_app: "cloudflare-workers-and-pages", check_name: "Workers Builds: web" }))).toBe(false);
    expect(signalMatchesPart(ev("check_run", checkRun({ branch: "feat/x" })), part({ check_app: "cloudflare-workers-and-pages", check_name: "Workers Builds: web" }))).toBe(false);
    // workflow: the file (with or without its folder) AND branch
    expect(signalMatchesPart(ev("workflow_run", workflowRun()), part({ workflow: "deploy-jobs.yml" }))).toBe(true);
    expect(signalMatchesPart(ev("workflow_run", workflowRun()), part({ workflow: ".github/workflows/deploy-jobs.yml" }))).toBe(true);
    expect(signalMatchesPart(ev("workflow_run", workflowRun({ path: ".github/workflows/ci.yml" })), part({ workflow: "deploy-jobs.yml" }))).toBe(false);
    expect(signalMatchesPart(ev("workflow_run", workflowRun({ branch: "production" })), part({ workflow: "deploy-jobs.yml" }))).toBe(false);
    // a signal of the wrong KIND for the setting, a part with no setting, a part on another provider
    expect(signalMatchesPart(ev("check_run", checkRun({ name: "web / staging" })), part({ environment: "web / staging" }))).toBe(false);
    expect(signalMatchesPart(ev("deployment_status", deploymentStatus()), part({}))).toBe(false);
    expect(signalMatchesPart(ev("deployment_status", deploymentStatus()), part({ environment: "web / staging" }, "railway"))).toBe(false);
    // a commit status is never a github part's deploy
    const status = ev("status", { id: 3, sha: SHA1, context: "web / staging", state: "success", branches: [{ name: "main" }], updated_at: "2026-10-15T10:00:00Z" });
    expect(signalMatchesPart(status, part({ environment: "web / staging" }))).toBe(false);
  });

  it("an org whose signals match no part's setting gets no deploy — whatever the signals say", async () => {
    await setOrgEnvironments(ENVS, ORG_A);
    await addGithubPart("staging", "web", { environment: "web / staging" });
    await env.DB.prepare(`INSERT INTO org_environment_parts (org_id, env_key, part_key, position, label, role, provider, settings, created_at, updated_at, updated_by)
      VALUES (?, 'staging', 'api', 1, 'API', 'service', 'railway', '{"environment_id":"e","service_id":"s"}', 'x', 'x', 'test')`).bind(ORG_A).run();
    for (const [name, payload] of [
      ["deployment_status", deploymentStatus({ environment: "api / staging" })],   // the railway part's own name: not a github part's
      ["check_run", checkRun()],
      ["workflow_run", workflowRun()],
    ] as const) {
      expect(await writeGithubDeploys(systemCtx(ORG_A), ev(name, payload), Date.now())).toEqual([]);
    }
    expect(await deploys()).toEqual([]);
  });
});

describe("a matched signal is the part's deploy", () => {
  it("through the webhook: a deployment's states upsert ONE row — source github, sha from GitHub", async () => {
    const SECRET = "test-webhook-secret";
    const sign = async (body: string) => {
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      return "sha256=" + [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))].map((b) => b.toString(16).padStart(2, "0")).join("");
    };
    const post = async (name: string, payload: object) => {
      const body = JSON.stringify({ ...payload, repository: { full_name: "SaplingLearn/sapling" } });
      return handleGithubWebhook(new Request(`https://x/webhook/github/${SAPLING_HOOK}`, { method: "POST", body, headers: { "x-github-event": name, "x-hub-signature-256": await sign(body) } }), env as unknown as Env, { hookId: SAPLING_HOOK });
    };
    await addOrgRepo("SaplingLearn/sapling", ORG_A, { id: SAPLING_HOOK });
    await setSecret(await tenantCtx("AndresL230"), "github_webhook", SAPLING_HOOK, SECRET);
    await setOrgEnvironments(ENVS, ORG_A);
    await addGithubPart("staging", "web", { environment: "web / staging" });
    await post("deployment_status", deploymentStatus({ state: "in_progress" }));
    expect(await deploys()).toMatchObject([{ env: "staging", part: "web", provider: "github", deploy_id: "gh-deployment:1", state: "building", source: "github", sha: SHA1, sha_source: "provider" }]);
    await post("deployment_status", deploymentStatus({ state: "failure", description: "Build failed: exit 1" }));
    expect(await deploys()).toMatchObject([{ deploy_id: "gh-deployment:1", state: "error", reason: "Build failed: exit 1" }]);
    expect(await all(env.DB, `SELECT kind, env FROM repo_events WHERE org_id = ?`, ORG_A)).toEqual([{ kind: "deploy", env: null }, { kind: "deploy", env: null }]);
  });

  it("maps check runs and workflow runs; a failed check's reason is its output title; neutral is skipped", () => {
    expect(deployFromSignal(ev("check_run", checkRun({ conclusion: null })))).toMatchObject({ id: "gh-check:5", state: "building", readyAt: null });
    expect(deployFromSignal(ev("check_run", checkRun({ conclusion: "failure", title: "Build failed\nmore" })))).toMatchObject({ state: "error", reason: "Build failed" });
    expect(deployFromSignal(ev("check_run", checkRun({ conclusion: "cancelled" })))).toMatchObject({ state: "canceled", reason: null });
    expect(deployFromSignal(ev("check_run", checkRun({ conclusion: "neutral" })))).toBeNull();
    expect(deployFromSignal(ev("workflow_run", workflowRun()))).toMatchObject({ id: "gh-run:77:1", state: "ready", sha: SHA1, branch: "main", message: "Deploy jobs", createdAt: "2026-10-15T10:01:00.000Z" });
    expect(deployFromSignal(ev("deployment_status", deploymentStatus({ state: "inactive" })))).toBeNull();
  });
});

describe("THE ROLLBACK COMPARE", () => {
  const cd = (id: string, sha: string | null, createdAt: string, o: Partial<CleanDeploy> = {}): CleanDeploy => ({
    id, state: "ready", target: "production", sha, branch: "main", message: null, by: null, createdAt, readyAt: createdAt, url: null, inspectUrl: null, reason: null, ...o,
  });
  const ref = { env: "production", key: "web", provider: "vercel" };
  function gh(status: string | null) {
    const calls: string[] = [];
    const fetchImpl = (async (u: RequestInfo | URL) => { calls.push(String(u)); return status === null ? new Response("no", { status: 500 }) : Response.json({ status }); }) as typeof fetch;
    return { calls, get: async () => ({ token: "tok", repo: "SaplingLearn/sapling", fetchImpl }) };
  }
  async function seed(...list: CleanDeploy[]) { await upsertDeploys(systemCtx(ORG_A), ref, list, Date.now()); }
  const rolledBack = async (id: string) => (await first<{ rolled_back_from: string | null }>(env.DB,
    `SELECT rolled_back_from FROM hosting_deploys WHERE org_id = ? AND deploy_id = ?`, ORG_A, id))?.rolled_back_from ?? null;

  it("behind → rolled_back_from = the previous sha, after ONE compare of previous...new", async () => {
    await seed(cd("d1", SHA1, "2026-10-15T08:00:00.000Z"), cd("d2", SHA2, "2026-10-15T09:00:00.000Z"), cd("d3", SHA1, "2026-10-15T10:00:00.000Z"));
    const g = gh("behind");
    expect(await checkRollback(systemCtx(ORG_A), ref, "d3", g.get)).toBe("rolled_back");
    expect(g.calls).toEqual([`https://api.github.com/repos/SaplingLearn/sapling/compare/${SHA2}...${SHA1}?per_page=1`]);
    expect(await rolledBack("d3")).toBe(SHA2);
  });

  it("ahead or identical → nothing set", async () => {
    await seed(cd("d1", SHA1, "2026-10-15T08:00:00.000Z"), cd("d2", SHA2, "2026-10-15T09:00:00.000Z"));
    for (const status of ["ahead", "identical", "diverged"]) {
      const g = gh(status);
      expect(await checkRollback(systemCtx(ORG_A), ref, "d2", g.get)).toBe("forward");
      expect(g.calls).toHaveLength(1);
    }
    expect(await rolledBack("d2")).toBeNull();
  });

  it("costs no request for a preview, the first ready deploy, the same sha, a deploy with no sha, no credential — and a failed compare sets nothing", async () => {
    await seed(cd("d1", SHA1, "2026-10-15T08:00:00.000Z"), cd("same", SHA1, "2026-10-15T09:00:00.000Z"),
      cd("pv", SHA3, "2026-10-15T09:30:00.000Z", { target: "preview" }), cd("nosha", null, "2026-10-15T09:40:00.000Z"),
      cd("live", SHA3, "2026-10-15T10:00:00.000Z"));
    const g = gh("behind");
    for (const id of ["d1", "same", "pv", "nosha"]) expect(await checkRollback(systemCtx(ORG_A), ref, id, g.get), id).toBe("skipped");
    expect(g.calls).toEqual([]);
    expect(await checkRollback(systemCtx(ORG_A), ref, "live", async () => null)).toBe("skipped");
    const broken = gh(null);
    expect(await checkRollback(systemCtx(ORG_A), ref, "live", broken.get)).toBe("skipped");
    expect(await rolledBack("live")).toBeNull();
  });
});

describe("history: a github part is filled from signals captured before it, or by reconcile (THE GUARD holds)", () => {
  const DAY = 86_400_000;
  const NOW = Date.parse("2026-10-14T12:00:00Z");
  const at = (now: number, daysAgo: number) => new Date(now - daysAgo * DAY).toISOString().replace(/\.\d{3}Z$/, "Z");
  const ghRun = (id: number, o: { path?: string; branch?: string; conclusion?: string; at: string }) => ({
    id, name: "Deploy jobs", path: o.path ?? ".github/workflows/deploy-jobs.yml", head_branch: o.branch ?? "main", head_sha: SHA2,
    conclusion: o.conclusion ?? "success", run_attempt: 1, updated_at: o.at, run_started_at: o.at, html_url: `https://github.com/SaplingLearn/sapling/actions/runs/${id}`,
    actor: { login: "AndresL230" }, event: "push", status: "completed",
  });
  const ghCheck = (id: number, o: { app: string; name: string; at: string }) => ({
    id, name: o.name, head_sha: SHA3, status: "completed", conclusion: "success", started_at: o.at, completed_at: o.at,
    details_url: "https://dash.cloudflare.com/x", app: { slug: o.app }, output: { title: null },
  });

  it("reconcile's backfilled workflow runs and check runs become a matching part's deploys — a look-alike never does", async () => {
    await setOrgEnvironments(ENVS, ORG_A);
    await addGithubPart("staging", "jobs", { workflow: "deploy-jobs.yml" }, "service");
    await addGithubPart("staging", "web", { check_app: "cloudflare-workers-and-pages", check_name: "Workers Builds: web" });
    const gh = fakeGithub({
      "/actions/runs?status=completed": { workflow_runs: [
        ghRun(77, { at: at(NOW, 2) }),                                           // the setting's file on the environment's branch
        ghRun(78, { at: at(NOW, 1), branch: "feat/x" }),                         // same file, another branch: not this part's
        ghRun(79, { at: at(NOW, 1), path: ".github/workflows/ci.yml" }),         // same branch, another file
      ] },
      "/commits/main/check-runs": { check_runs: [
        ghCheck(501, { app: "cloudflare-workers-and-pages", name: "Workers Builds: web", at: at(NOW, 3) }),
        ghCheck(502, { app: "github-actions", name: "Workers Builds: web", at: at(NOW, 1) }),  // same name, another App
      ] },
    });
    const res = await reconcileRepo(systemCtx(ORG_A), { token: "t", repo: "SaplingLearn/sapling", fetchImpl: gh.fetchImpl }, ENVS, NOW);
    expect(res.failed).toEqual([]);
    expect(await deploys()).toMatchObject([
      { env: "staging", part: "jobs", provider: "github", deploy_id: "gh-run:77:1", state: "ready", sha: SHA2, sha_source: "provider", source: "github" },
      { env: "staging", part: "web", provider: "github", deploy_id: "gh-check:501", state: "ready", sha: SHA3, source: "github" },
    ]);
    expect((await deploys()).length).toBe(2);
    // Idempotent: a second pass over the same history changes nothing, and costs no GitHub request of its own.
    const before = gh.calls.length;
    expect(await backfillGithubDeploys(systemCtx(ORG_A), NOW)).toEqual([]);
    expect(gh.calls.length).toBe(before);
  });

  it("a part created (or re-pointed) after its signals were captured is filled from the last 30 days on save", async () => {
    await setOrgEnvironments(ENVS, ORG_A);
    const now = Date.now();
    const ctx = systemCtx(ORG_A);
    const take = async (name: string, payload: unknown) => { for (const e of repoEventsFromDelivery(name, payload)) expect((await ingestRepoEvent(ctx, e)).outcome).toBe("written"); };
    // Captured while no part named them: one deployment's states, a look-alike on a feature branch, one too old.
    await take("deployment_status", deploymentStatus({ id: 1, state: "in_progress", ref: "main", at: at(now, 3) }));
    await take("deployment_status", deploymentStatus({ id: 1, state: "success", ref: "main", at: at(now, 3) }));
    await take("deployment_status", deploymentStatus({ id: 2, state: "success", ref: "feat/x", at: at(now, 2) }));
    await take("deployment_status", deploymentStatus({ id: 3, state: "success", ref: "main", at: at(now, 40) }));
    await take("deployment_status", deploymentStatus({ id: 4, state: "failure", environment: "api / staging", ref: "main", at: at(now, 1), description: "Build failed" }));
    expect(await deploys()).toEqual([]);
    const admin = await tenantCtx("AndresL230");
    await putPart(admin, "staging", "web", { provider: "github", role: "web", settings: { environment: "web / staging" } });
    expect(await deploys()).toMatchObject([{ env: "staging", part: "web", deploy_id: "gh-deployment:1", state: "ready", sha: SHA1, source: "github" }]);
    expect((await deploys()).length).toBe(1);
    // Re-pointed at another deployment environment: its history arrives too.
    await putPart(admin, "staging", "web", { provider: "github", role: "web", settings: { environment: "api / staging" } });
    expect((await deploys()).map((d) => [d.deploy_id, d.state, d.reason])).toEqual([["gh-deployment:1", "ready", null], ["gh-deployment:4", "error", "Build failed"]]);
  });
});

/**
 * The Repo Overview's facts (repo setups, Phase B) — `facts` on `GET /repo/dashboard?repo=&app=` and on the
 * projection (`getRepoDashboard` → src/tools/repo-facts.ts), read from seeded D1 rows: apps (implicit ones too),
 * the environments a repository's parts are in, each part's serving / latest / history, previews matched to open
 * PRs, health (stale past 30 minutes), every attention kind, the connect hint, and unknown as null — never 0.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { app as http } from "../src/routes";
import { ingestRepoEvent } from "../src/consumer";
import { getRepoDashboard } from "../src/tools/repo";
import { putMetrics, putSnapshot } from "../src/repo/store";
import { REPO_WIDE, type RepoFacts } from "@shared/repo-facts-core";
import type { RepoDashboard } from "@shared/repo";
import type { RepoEnvConfig } from "../src/repo/config";
import type { RepoEvent } from "../src/repo/types";
import type { NotShippedSnapshot, OutOfStepSnapshot, DriftChainSnapshot } from "../src/repo/facts-store";
import { ENVS, seedOrgRepoConfig } from "./helpers/repo";
import { addPart } from "./helpers/dashboard-hosting";
import { cookieFor } from "./helpers/persons";
import { ORG_A, systemCtx, tenantCtx } from "./helpers/tenant";
import { setRepoOverviewGroup } from "../src/data/repo-settings";

const NOW = Date.parse("2026-10-15T12:00:00Z");
const MIN = 60_000;
const ago = (mins: number) => new Date(NOW - mins * MIN).toISOString();
const PRIMARY = "SaplingLearn/sapling";
const DEV: RepoEnvConfig = { key: "dev", label: "dev", note: "develop", branch: "develop", frontendUrl: "", apiUrl: "", healthPath: "/" };
const ENVS3: RepoEnvConfig[] = [DEV, ...ENVS];

const SHA = {
  fStg: "a1a1a1a1a1", fProd1: "b2b2b2b2b2", fProd2: "c3c3c3c3c3", fProdBad: "d4d4d4d4d4", fProdNext: "e5e5e5e5e5",
  bStg: "f6f6f6f6f6", bStgOld: "0a0a0a0a0a", bProd: "1b1b1b1b1b", bProdBad: "2c2c2c2c2c", docs: "3d3d3d3d3d",
};

interface DepOpts { sha?: string | null; target?: "production" | "preview" | null; branch?: string | null; source?: "provider" | "github"; reason?: string | null; rolledBackFrom?: string | null; url?: string | null; recordedMins?: number }
async function dep(envKey: string, part: string, provider: string, id: string, state: string, mins: number, o: DepOpts = {}): Promise<void> {
  const at = ago(mins);
  await env.DB.prepare(
    `INSERT INTO hosting_deploys (org_id, env, part, provider, deploy_id, state, target, sha, branch, message, actor, url, inspect_url, created_at, ready_at,
       recorded_at, updated_at, source, reason, sha_source, rolled_back_from)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'jose-a', ?, 'https://logs.example/x', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(ORG_A, envKey, part, provider, id, state, o.target === undefined ? "production" : o.target, o.sha === undefined ? null : o.sha,
    o.branch ?? "main", `msg ${id}`, o.url ?? null, at, state === "ready" ? at : null, o.recordedMins !== undefined ? ago(o.recordedMins) : at, at,
    o.source ?? "provider", o.reason ?? null, o.sha ? "provider" : null, o.rolledBackFrom ?? null).run();
}

const pr = (number: number, state: string, ref: string, mins: number): RepoEvent => ({
  semantic_key: `gh:prs:${number}:${state}:${mins}`, kind: "pr", number, state, ref, sha: `sha${number}`, actor_login: "jose-a",
  title: `PR ${number}`, url: `https://github.com/o/r/pull/${number}`, raw: "{}", provenance: "webhook", occurred_at: ago(mins),
});
const check = (sha: string, name: string, state: string, n: number): RepoEvent => ({
  semantic_key: `gh:check:${sha}:${name}:${n}`, kind: "check", sha, name, state, ref: null, raw: "{}", provenance: "webhook", occurred_at: ago(30),
});

/** SaplingLearn's frontend (Cloudflare) and backend (Railway) in staging + production, a `docs` part (Vercel, no
 *  `repo_apps` row — an implicit app) in production only, and a `dev` environment with no part. */
async function seedWorld(): Promise<void> {
  await seedOrgRepoConfig(env.DB, ORG_A, PRIMARY, ENVS3);
  await addPart(ORG_A, "staging", "frontend", "cloudflare", "web", {}, 0, "Frontend");
  await addPart(ORG_A, "staging", "backend", "railway", "service", {}, 1, "Backend");
  await addPart(ORG_A, "production", "frontend", "cloudflare", "web", {}, 0, "Frontend");
  await addPart(ORG_A, "production", "backend", "railway", "service", {}, 1, "Backend");
  await addPart(ORG_A, "production", "docs", "vercel", "web", {}, 2, "Docs");

  // frontend: staging serving; production served fProd2 after fProd1, a failed deploy since, and one building now
  await dep("staging", "frontend", "cloudflare", "fs1", "ready", 300, { sha: SHA.fStg });
  await dep("production", "frontend", "cloudflare", "fp1", "ready", 600, { sha: SHA.fProd1, recordedMins: 30 * 24 * 60 });
  await dep("production", "frontend", "cloudflare", "fp2", "ready", 180, { sha: SHA.fProd2 });
  await dep("production", "frontend", "cloudflare", "fp3", "canceled", 120, { sha: SHA.fProdBad });
  await dep("production", "frontend", "cloudflare", "fp4", "building", 10, { sha: SHA.fProdNext });
  // backend: staging rolled back to an older commit; production's newest deploy failed
  await dep("staging", "backend", "railway", "bs1", "ready", 200, { sha: SHA.bStg });
  await dep("staging", "backend", "railway", "bs2", "ready", 100, { sha: SHA.bStgOld, rolledBackFrom: SHA.bStg });
  await dep("production", "backend", "railway", "bp1", "ready", 400, { sha: SHA.bProd });
  await dep("production", "backend", "railway", "bp2", "error", 20, { sha: SHA.bProdBad, reason: "Build failed: exit 1" });
  // docs: one production deploy, and previews on three branches
  await dep("production", "docs", "vercel", "dp1", "ready", 500, { sha: SHA.docs, url: "https://docs.example.com" });
  await dep("production", "docs", "vercel", "pv-a", "ready", 50, { target: "preview", branch: "feat/a", url: "https://a.preview.example" });
  for (const [i, mins] of [[1, 300], [2, 200], [3, 90]] as const) {
    await dep("production", "docs", "vercel", `pv-b${i}`, "error", mins, { target: "preview", branch: "feat/b" });
  }
  await dep("production", "docs", "vercel", "pv-b0", "ready", 400, { target: "preview", branch: "feat/b" });
  await dep("production", "docs", "vercel", "pv-old", "ready", 60, { target: "preview", branch: "old" });

  const ctx = systemCtx(ORG_A);
  for (const ev of [pr(12, "review", "feat/a", 70), pr(13, "draft", "feat/b", 80), pr(9, "merged", "old", 40)]) await ingestRepoEvent(ctx, ev);
  await putSnapshot(ctx, "prs_reconciled", { at: ago(5) }, ago(5));

  // health: staging frontend 40 minutes old (stale), production frontend down, production backend up
  await putMetrics(ctx, [
    { metric: "health_up", env: "staging", part: "frontend", value: 1, at: ago(40) },
    { metric: "health_ms", env: "staging", part: "frontend", value: 90, at: ago(40) },
    { metric: "health_up", env: "production", part: "frontend", value: 0, at: ago(5) },
    { metric: "health_ms", env: "production", part: "frontend", value: 8000, at: ago(5) },
    { metric: "health_up", env: "production", part: "backend", value: 1, at: ago(5) },
    { metric: "health_ms", env: "production", part: "backend", value: 120.4, at: ago(5) },
  ]);

  // head checks: production fails one of two; staging still running
  await putSnapshot(ctx, "env_heads", { main: "headmain", production: "headprod", develop: "headdev" }, ago(1));
  for (const ev of [check("headprod", "ci", "failure", 1), check("headprod", "lint", "success", 2), check("headmain", "ci", "pending", 3), check("headmain", "lint", "success", 4)]) {
    await ingestRepoEvent(ctx, ev);
  }

  // what reconcile's facts arms stored
  const ns: NotShippedSnapshot = { parts: {
    "production/frontend": { env: "production", app: "frontend", servingSha: SHA.fProd2.slice(0, 7), branch: "production", head: "headprod", count: 4,
      oldestAt: ago(2 * 24 * 60), groups: [{ kind: "pr", pr: 41, title: "Checkout", by: ["jose-a"], mergedAt: ago(2 * 24 * 60), commits: [{ sha: "9999999", msg: "Checkout (#41)", at: ago(2 * 24 * 60) }], more: 0 }],
      computedAt: ago(60) },
    "staging/frontend": { env: "staging", app: "frontend", servingSha: "ffffffff", branch: "main", head: "headmain", count: 7, oldestAt: ago(5000), groups: [], computedAt: ago(60) },
  } };
  await putSnapshot(ctx, "not_shipped", ns);
  const oos: OutOfStepSnapshot = { envs: {
    production: { shas: { frontend: SHA.fProd2, backend: SHA.bProd, docs: SHA.docs }, computedAt: ago(60),
      rows: [{ env: "production", app: "backend", sha: SHA.bProd, of: "frontend", ofSha: SHA.fProd2, behindBy: 3 }] },
  } };
  await putSnapshot(ctx, "out_of_step", oos);
  const chain: DriftChainSnapshot = { steps: [
    { fromEnv: "dev", toEnv: "staging", from: "develop", to: "main", ahead: 2, behind: 0, groups: [] },
    { fromEnv: "staging", toEnv: "production", from: "main", to: "production", ahead: 5, behind: 1, groups: [] },
  ] };
  await putSnapshot(ctx, "drift_chain", chain);
}

const factsOf = async (o: { repo?: string; app?: string | null; admin?: boolean } = {}): Promise<{ dash: RepoDashboard; f: RepoFacts }> => {
  const ctx = o.admin ? await tenantCtx("admin-user", "admin") : systemCtx(ORG_A);
  const dash = await getRepoDashboard(ctx, o.repo ?? PRIMARY, NOW, ENVS3, undefined, { app: o.app ?? null });
  return { dash, f: dash.facts! };
};

describe("the facts read — apps, environments, parts", () => {
  it("lists the repository's apps, a part key with no row as an implicit app, and hides an environment with no part of them", async () => {
    await seedWorld();
    const { dash, f } = await factsOf();
    expect(dash.degraded).toBe(false);
    expect(f.repo).toBe(PRIMARY);
    expect(f.repos).toEqual([PRIMARY]);
    expect(f.app).toBeNull();
    expect(f.allApps.map((a) => [a.key, a.kind, a.source])).toEqual([["frontend", "Worker", "migrated"], ["backend", "Service", "migrated"], ["docs", "Site", "implicit"]]);
    expect(f.apps).toEqual(f.allApps);
    // dev has no part: hidden; promotion order kept, positions are the org's
    expect(f.envs).toEqual([{ key: "staging", name: "staging", branch: "main", position: 1 }, { key: "production", name: "production", branch: "production", position: 2 }]);
    expect(f.parts.map((p) => `${p.app}@${p.env}`)).toEqual(["frontend@staging", "frontend@production", "backend@staging", "backend@production", "docs@production"]);
    const docs = f.parts.find((p) => p.app === "docs")!;
    expect(docs).toMatchObject({ provider: "vercel", host: "Vercel", role: "web", reportsDeploys: true, reportsMetrics: false, connection: "not_connected", viaGithub: false, via: null });
    // the registry's capabilities, never a provider id: Cloudflare and Railway report usage, Vercel none
    expect(f.parts.map((p) => p.reportsMetrics)).toEqual([true, true, true, true, false]);
    // previews: only docs has any
    expect(f.allApps.map((a) => a.previews)).toEqual([false, false, true]);
    // three apps: which open PRs touch which needs PR files (Phase E) — null, never a share of the total
    expect(f.allApps.every((a) => a.openPrs === null)).toBe(true);
  });

  it("serving = the newest ready production deploy, latest = the newest when it is not that one, history = the last settled, oldest first", async () => {
    await seedWorld();
    const { f } = await factsOf();
    const fp = f.parts.find((p) => p.app === "frontend" && p.env === "production")!;
    expect(fp.serving).toMatchObject({ id: "fp2", state: "ready", sha: SHA.fProd2, shaSource: "provider", source: "provider", target: "production" });
    expect(fp.latest).toMatchObject({ id: "fp4", state: "building", sha: SHA.fProdNext });
    expect(fp.history.map((d) => d.id)).toEqual(["fp1", "fp2", "fp3"]); // the building one is not settled
    const bp = f.parts.find((p) => p.app === "backend" && p.env === "production")!;
    expect(bp.serving?.id).toBe("bp1");
    expect(bp.latest).toMatchObject({ id: "bp2", state: "error", reason: "Build failed: exit 1", logUrl: "https://logs.example/x" });
    const bs = f.parts.find((p) => p.app === "backend" && p.env === "staging")!;
    expect(bs.serving).toMatchObject({ id: "bs2", rolledBackFrom: SHA.bStg });
    expect(bs.latest).toBeNull();
    // a production part's previews are not its deploys
    expect(f.parts.find((p) => p.app === "docs")!.history.map((d) => d.id)).toEqual(["dp1"]);
  });

  it("health: the part's own target, fresh up / down, stale past 30 minutes, and none when the target is not this part's", async () => {
    await seedWorld();
    const { f } = await factsOf();
    const part = (app: string, envKey: string) => f.parts.find((p) => p.app === app && p.env === envKey)!;
    expect(part("frontend", "staging").health).toEqual({ url: "https://staging.saplinglearn.com", up: true, ms: 90, at: ago(40), stale: true });
    expect(part("frontend", "production").health).toEqual({ url: "https://saplinglearn.com", up: false, ms: 8000, at: ago(5), stale: false });
    expect(part("backend", "production").health).toEqual({ url: "https://api.saplinglearn.com/api/health", up: true, ms: 120, at: ago(5), stale: false });
    expect(part("backend", "staging").health).toBeNull(); // never pinged: unknown, not down
    expect(part("docs", "production").health).toBeNull(); // the frontend target is the `frontend` part's, not a guess for docs
    expect(part("frontend", "production").url).toBe("https://saplinglearn.com");
    expect(part("docs", "production").url).toBe("https://docs.example.com"); // its serving deploy's URL
  });

  it("previews: newest per branch, matched to OPEN PRs by branch, a merged PR's branch left out, and the fail streak", async () => {
    await seedWorld();
    const { f } = await factsOf();
    expect(f.previews).toEqual([
      { app: "docs", pr: 12, title: "PR 12", branch: "feat/a", by: "jose-a", state: "ready", at: ago(50), url: "https://a.preview.example", failStreak: 0, failingSince: null },
      { app: "docs", pr: 13, title: "PR 13", branch: "feat/b", by: "jose-a", state: "error", at: ago(90), url: null, failStreak: 3, failingSince: ago(300) },
    ]);
  });
});

describe("the facts read — snapshots, CI, attention, the week", () => {
  it("not shipped only for the commit the part serves NOW, out of step while its shas still serve, drift steps between shown environments", async () => {
    await seedWorld();
    const { f } = await factsOf();
    const ns = (app: string, envKey: string) => f.notShipped.find((n) => n.app === app && n.env === envKey)!;
    expect(ns("frontend", "production")).toMatchObject({ count: 4, oldestAt: ago(2 * 24 * 60) });
    expect(ns("frontend", "production").groups[0].pr).toBe(41);
    expect(ns("frontend", "staging")).toEqual({ app: "frontend", env: "staging", count: null, oldestAt: null, groups: [] }); // computed for another sha
    expect(ns("backend", "staging").count).toBeNull(); // never computed
    expect(f.notShipped).toHaveLength(f.parts.length);
    expect(f.outOfStep).toEqual([{ env: "production", app: "backend", sha: SHA.bProd, of: "frontend", ofSha: SHA.fProd2, behindBy: 3 }]);
    expect(f.drift.map((d) => `${d.fromEnv}→${d.toEnv}`)).toEqual(["staging→production"]); // dev is hidden
  });

  it("out of step is dropped once an app serves another commit", async () => {
    await seedWorld();
    await dep("production", "docs", "vercel", "dp2", "ready", 2, { sha: "4e4e4e4e4e" });
    const { f } = await factsOf();
    expect(f.outOfStep).toEqual([]);
  });

  it("CI per environment: fail with its failing names, running with no total yet", async () => {
    await seedWorld();
    const { f } = await factsOf();
    expect(f.ci).toEqual([
      { env: "staging", sha: "headmain", state: "running", total: null, failing: null, names: ["ci"] },
      { env: "production", sha: "headprod", state: "fail", total: 2, failing: 1, names: ["ci"] },
    ]);
  });

  it("every attention kind, structured, most urgent first", async () => {
    await seedWorld();
    const { f } = await factsOf();
    expect(f.attention.map((a) => `${a.kind}:${a.app ?? "-"}@${a.env ?? "-"}`)).toEqual([
      "down:frontend@production",
      "failed:backend@production",
      "rolledBack:backend@staging",
      "outOfStep:backend@production",
      "stale:frontend@staging",
      "degraded:-@production",
      "waiting:frontend@production",
      "previewFailing:docs@-",
    ]);
    const by = (k: string) => f.attention.find((a) => a.kind === k)!.refs;
    expect(by("failed")).toEqual({ failedSha: SHA.bProdBad, sha: SHA.bProd, since: ago(20), provider: "railway", reason: "Build failed: exit 1" });
    expect(by("rolledBack")).toEqual({ sha: SHA.bStgOld, prevSha: SHA.bStg, since: ago(100) });
    expect(by("outOfStep")).toEqual({ sha: SHA.bProd, behindBy: 3, of: "frontend", provider: "railway" });
    expect(by("down")).toEqual({ url: "https://saplinglearn.com", since: ago(5) });
    expect(by("degraded")).toEqual({ count: 1, check: "ci" });
    expect(by("waiting")).toEqual({ count: 4, since: ago(2 * 24 * 60), sha: SHA.fProd2 });
    expect(by("previewFailing")).toEqual({ pr: 13, count: 3, since: ago(300) });
  });

  it("the week: deploys and failures counted, figures with no capture null, releases null until Phase F", async () => {
    await seedWorld();
    const { f } = await factsOf();
    const w = Object.fromEntries(f.week.map((x) => [x.key, [x.value, x.delta]]));
    expect(Object.keys(w)).toEqual(["mergedPrs", "deploys", "failedDeploys", "openPrs", "commits", "releases", "ciRuns"]);
    // 8 settled production deploys this week (ready + error; canceled and building are not), 1 failed. Capture of
    // most parts began this week, so no delta — never "+9 vs a week nobody recorded".
    expect(w.deploys).toEqual([8, null]);
    expect(w.failedDeploys).toEqual([1, null]);
    expect(w.openPrs[0]).toBe(2);
    expect(w.mergedPrs).toEqual([null, null]); // no merged PR was ever captured in `events`
    expect(w.commits).toEqual([null, null]);
    expect(w.releases).toEqual([null, null]);
    expect(w.ciRuns).toEqual([null, null]);
  });

  it("the connect hint is an admin's: the first host not connected, needing deploys (nothing comes through GitHub)", async () => {
    await seedWorld();
    expect((await factsOf()).f.connect).toBeNull(); // the system reader is not an admin
    expect((await factsOf({ admin: true })).f.connect).toEqual({ provider: "cloudflare", need: "deploys", apps: ["frontend"] });
  });

  it("asks for metrics only, when GitHub already gives every such part its deploys", async () => {
    await seedOrgRepoConfig(env.DB, ORG_A, PRIMARY, ENVS);
    await addPart(ORG_A, "production", "backend", "railway", "service");
    await dep("production", "backend", "railway", "gh1", "ready", 30, { sha: SHA.bProd, source: "github", target: null });
    const { f } = await factsOf({ admin: true });
    expect(f.connect).toEqual({ provider: "railway", need: "metrics", apps: ["backend"] });
    expect(f.parts[0]).toMatchObject({ viaGithub: true, serving: { id: "gh1", source: "github", target: null } });
  });
});

describe("the admin's default Group by", () => {
  it("is the repository's repo_settings.overview_group, else null", async () => {
    await seedWorld();
    expect((await factsOf()).f.groupDefault).toBeNull();
    await setRepoOverviewGroup(await tenantCtx("admin-user", "admin"), PRIMARY, "app");
    expect((await factsOf()).f.groupDefault).toBe("app");
  });
});

describe("narrowing and other repositories", () => {
  it("app narrows the facts AND the per-part sections; REPO_WIDE drops every app row; an unknown app is every app", async () => {
    await seedWorld();
    const one = await factsOf({ app: "docs" });
    expect(one.f.app).toBe("docs");
    expect(one.f.apps.map((a) => a.key)).toEqual(["docs"]);
    expect(one.f.allApps).toHaveLength(3);
    expect(one.f.envs.map((e) => e.key)).toEqual(["production"]);
    expect(one.f.parts.map((p) => p.app)).toEqual(["docs"]);
    expect(one.f.attention.map((a) => a.kind)).toEqual(["previewFailing"]);
    const providers = one.dash.providers.status === "ok" ? one.dash.providers.data : [];
    expect(providers.map((p) => p.part)).toEqual(["docs"]);

    const wide = await factsOf({ app: REPO_WIDE });
    expect(wide.f).toMatchObject({ app: REPO_WIDE, apps: [], parts: [], envs: [], previews: [] });
    expect(wide.dash.providers.status).toBe("not_connected"); // no part in view — the section with no part, never another app's

    const unknown = await factsOf({ app: "nope" });
    expect(unknown.f.app).toBeNull();
    expect(unknown.f.parts).toHaveLength(5);
  });

  it("another connected repository: its apps only, and the primary's PR / CI capture is never passed off as its own", async () => {
    await seedWorld();
    await env.DB.prepare(`INSERT INTO org_repos (id, org_id, repo_full_name, is_primary, legacy_hook, created_at, created_by) VALUES ('hook_docs', ?, 'SaplingLearn/docs', 0, 0, ?, 'seed')`)
      .bind(ORG_A, ago(10)).run();
    await env.DB.prepare(`INSERT INTO repo_apps (org_id, key, repo, label, folder, kind, watch, source, position, created_at, created_by, updated_at, updated_by)
      VALUES (?, 'docs', 'SaplingLearn/docs', 'Docs', '/', 'Site', '["/"]', 'manual', 5, ?, 'seed', ?, 'seed')`).bind(ORG_A, ago(10), ago(10)).run();
    const docs = (await factsOf({ repo: "saplinglearn/DOCS" })).f;
    expect(docs.repos).toEqual([PRIMARY, "SaplingLearn/docs"]);
    expect(docs.allApps.map((a) => [a.key, a.source])).toEqual([["docs", "manual"]]);
    expect(docs.envs.map((e) => e.key)).toEqual(["production"]);
    expect(docs.ci).toEqual([]);
    expect(docs.drift).toEqual([]);
    expect(docs.outOfStep).toEqual([]);
    expect(docs.notShipped.map((n) => n.count)).toEqual([null]);
    expect(docs.allApps[0].openPrs).toBeNull();
    const w = Object.fromEntries(docs.week.map((x) => [x.key, x.value]));
    expect(w.openPrs).toBeNull();
    expect(w.deploys).toBe(1); // its own part's deploys are its own
    const primary = (await factsOf()).f;
    expect(primary.allApps.map((a) => a.key)).toEqual(["frontend", "backend"]);
  });

  it("with nothing captured, every figure is null and every list empty — never 0", async () => {
    await seedOrgRepoConfig(env.DB, ORG_A, PRIMARY, ENVS);
    await addPart(ORG_A, "production", "frontend", "cloudflare", "web");
    const { dash, f } = await factsOf();
    expect(dash.degraded).toBe(false);
    expect(f.week.every((x) => x.value === null && x.delta === null)).toBe(true);
    expect(f.parts[0]).toMatchObject({ serving: null, latest: null, history: [], health: null });
    expect(f.notShipped).toEqual([{ app: "frontend", env: "production", count: null, oldestAt: null, groups: [] }]);
    expect(f.ci).toEqual([{ env: "production", sha: null, state: null, total: null, failing: null, names: [] }]);
    expect(f.previews).toEqual([]);
    expect(f.attention).toEqual([]);
    expect(f.release).toBeNull();
    expect(f.found).toBeNull();
    expect(f.unseen).toBeNull();
    expect(f.groupDefault).toBeNull();
  });

  it("a facts failure costs the facts alone: the empty facts, degraded, every other section still read", async () => {
    await seedWorld();
    await env.DB.prepare(`ALTER TABLE repo_apps RENAME TO repo_apps_gone`).run();
    try {
      const { dash, f } = await factsOf();
      expect(dash.degraded).toBe(true);
      expect(f.parts).toEqual([]);
      expect(f.week.every((x) => x.value === null)).toBe(true);
      expect(dash.providers.status).toBe("ok");
    } finally {
      await env.DB.prepare(`ALTER TABLE repo_apps_gone RENAME TO repo_apps`).run();
    }
  });
});

describe("GET /repo/dashboard?repo=&app=", () => {
  const get = async (q: string, cookie: string) => http.request(`/repo/dashboard${q}`, { headers: { cookie } }, env);

  it("checks repo against the org's repositories: absent → the primary, any case → that one, unknown → 404 { error }", async () => {
    await seedWorld();
    const cookie = await cookieFor("jose-a");
    const plain = (await (await get("", cookie)).json()) as RepoDashboard;
    expect(plain.repo).toBe(PRIMARY);
    expect(plain.facts?.repo).toBe(PRIMARY);
    const cased = (await (await get("?repo=saplinglearn%2FSAPLING", cookie)).json()) as RepoDashboard;
    expect(cased.repo).toBe(PRIMARY);
    const unknown = await get("?repo=someone%2Felse", cookie);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "unknown repository" });
  });

  it("app narrows; an unknown app is every app", async () => {
    await seedWorld();
    const cookie = await cookieFor("jose-a");
    const docs = (await (await get("?app=docs", cookie)).json()) as RepoDashboard;
    expect(docs.facts?.app).toBe("docs");
    expect(docs.facts?.parts.map((p) => p.app)).toEqual(["docs"]);
    const wide = (await (await get(`?app=${REPO_WIDE}`, cookie)).json()) as RepoDashboard;
    expect(wide.facts?.parts).toEqual([]);
    const unknown = (await (await get("?app=zzz", cookie)).json()) as RepoDashboard;
    expect(unknown.facts?.app).toBeNull();
  });

  it("is never a 500: a projection that throws is the degraded empty payload, facts included", async () => {
    await seedWorld();
    const cookie = await cookieFor("jose-a");
    await env.DB.prepare(`ALTER TABLE repo_events RENAME TO repo_events_gone`).run();
    try {
      const res = await get("?app=docs", cookie);
      expect(res.status).toBe(200);
      const d = (await res.json()) as RepoDashboard;
      expect(d.degraded).toBe(true);
      expect(d.repo).toBe(PRIMARY);
      expect(d.facts).toMatchObject({ repo: PRIMARY, apps: [], parts: [] });
    } finally {
      await env.DB.prepare(`ALTER TABLE repo_events_gone RENAME TO repo_events`).run();
    }
  });
});

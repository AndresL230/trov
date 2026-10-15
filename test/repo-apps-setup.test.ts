/**
 * Org settings › Repositories › a repo › Apps — the read and the app writes (src/repo/apps-setup.ts through
 * src/repo/apps-routes.ts). What matters: admin only, cookie only, the repository checked against the org's own
 * (another org's or an unconnected one is a 404), the read null-safe (a failed scan sub-read degrades, never a
 * 500), the deploy-signal picker's source is the signals seen in 30 days, unassigned names are the ones no
 * `github` part names, and every write goes through Phase A's audited writers.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import type { AppEnv } from "../src/auth/principal";
import { sessionGate } from "../src/auth/principal";
import { platformContext, soleTenantGate, tenantGate } from "../src/data/gate";
import { makeRepoAppsApp } from "../src/repo/apps-routes";
import { APPS_SETUP_DEPS, type AppsSetupDeps } from "../src/repo/apps-setup";
import type { AppSuggestionDTO, RepoAppsSetupDTO, SeenSignal } from "@shared/repo-scan-core";
import { all, run } from "./helpers/db";
import { ownerCookie, roleCookie, seedOrgSettings } from "./helpers/integrations";
import { send } from "./helpers/hosting-setup";
import { ORG_A } from "./helpers/tenant";

const A = "/api/o/saplinglearn";
const REPO = `${A}/repos/SaplingLearn/sapling`;

const sig = (o: Partial<SeenSignal> & Pick<SeenSignal, "kind" | "name">): SeenSignal =>
  ({ provider: null, count: 3, lastAt: "2026-10-14T10:00:00Z", source: null, ...o });

function testApp(over: Partial<AppsSetupDeps> = {}): { app: Hono<AppEnv>; calls: { sinceDays: (number | undefined)[]; repos: string[] } } {
  const calls = { sinceDays: [] as (number | undefined)[], repos: [] as string[] };
  const deps: AppsSetupDeps = {
    ...APPS_SETUP_DEPS,
    seenSignals: async (_ctx, repo, sinceDays) => { calls.sinceDays.push(sinceDays); calls.repos.push(repo); return []; },
    ...over,
  };
  const a = new Hono<AppEnv>();
  a.use("*", sessionGate);
  a.use("*", platformContext);
  a.use("*", soleTenantGate);
  a.use("/api/o/:slug/*", tenantGate);
  a.route("/api/o/:slug", makeRepoAppsApp(deps));
  return { app: a, calls };
}

async function addGithubPart(envKey: string, key: string, settings: Record<string, string>): Promise<void> {
  await run(env.DB, `INSERT INTO org_environment_parts (org_id, env_key, part_key, position, label, role, provider, settings, created_at, updated_at, updated_by)
    VALUES (?, ?, ?, 5, ?, 'web', 'github', ?, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', 'test')`, ORG_A, envKey, key, key, JSON.stringify(settings));
}
const adminAudit = (action: string) => all<{ actor: string; target: string; detail: string }>(env.DB,
  `SELECT actor, target, detail FROM org_admin_audit WHERE org_id = ? AND action = ? ORDER BY id`, ORG_A, action);

describe("GET /repos/:owner/:name/apps", () => {
  it("is admin only, cookie only, and checks the repository against the org's own", async () => {
    await seedOrgSettings();
    const { app } = testApp();
    const member = await roleCookie("shiva", "member");
    expect((await send(app, "GET", `${REPO}/apps`, member)).status).toBe(403);
    const me = await ownerCookie();
    expect((await send(app, "GET", `${A}/repos/acme/other/apps`, me)).status).toBe(404);
    expect((await send(app, "GET", `${A}/repos/SaplingLearn/sapling/apps`, me, undefined, undefined, { authorization: "Bearer trov_mcp_x" })).status).toBe(403);
    // GitHub compares names case-insensitively: the canonical name comes back.
    const ok = await send(app, "GET", `${A}/repos/saplinglearn/SAPLING/apps`, me);
    expect(ok.status).toBe(200);
    expect((ok.json as unknown as RepoAppsSetupDTO).repo).toBe("SaplingLearn/sapling");
  });

  it("answers the apps with their parts per environment, the environments, the provider words — null-safe when the scan has nothing", async () => {
    await seedOrgSettings();
    const { app, calls } = testApp();
    const d = (await send(app, "GET", `${REPO}/apps`, await ownerCookie())).json as unknown as RepoAppsSetupDTO;
    expect(d.apps.map((a) => [a.key, a.kind, a.parts.map((p) => `${p.env}/${p.provider}`)])).toEqual([
      ["frontend", "Worker", ["staging/cloudflare", "production/cloudflare"]],
      ["backend", "Service", ["staging/railway", "production/railway"]],
    ]);
    expect(d.environments).toEqual([{ key: "staging", label: "staging", branch: "main" }, { key: "production", label: "production", branch: "production" }]);
    expect(d.providers?.find((p) => p.id === "github")).toEqual({ id: "github", label: "GitHub deployments", via_github: true });
    expect(d.providers?.some((p) => p.id === "aws")).toBe(false); // later: not choosable, not listed
    expect(d.suggestions).toEqual([]);
    expect(d.signals).toEqual([]);
    expect(d.unassigned).toEqual([]);
    expect(d.scan).toEqual({ treeSha: null, scannedAt: null, looked: [], error: null });
    expect(d.tags).toEqual({ count: 0, latest: null });
    expect(d.degraded).toBeUndefined();
    // The picker's source: exactly the signals seen in the last 30 days, of this repository.
    expect(calls.sinceDays).toEqual([30]);
    expect(calls.repos).toEqual(["SaplingLearn/sapling"]);
  });

  it("degrades a failed scan sub-read to empty — never a 500", async () => {
    await seedOrgSettings();
    const boom = async (): Promise<never> => { throw new Error("D1 hiccup with a secret"); };
    const { app } = testApp({ listSuggestions: boom, readScan: boom, seenSignals: boom });
    const res = await send(app, "GET", `${REPO}/apps`, await ownerCookie());
    expect(res.status).toBe(200);
    const d = res.json as unknown as RepoAppsSetupDTO;
    expect(d.degraded).toBe(true);
    expect(d.suggestions).toEqual([]);
    expect(d.scan.scannedAt).toBeNull();
    expect(JSON.stringify(d)).not.toContain("hiccup");
  });

  it("lists as unassigned only the deploy names no github part names and no pending suggestion carries", async () => {
    await seedOrgSettings();
    await addGithubPart("production", "web", { environment: "Production – sapling-web" });
    const signals = [
      sig({ kind: "deployment", name: "Production – sapling-web", provider: "vercel", count: 31 }), // named by the part
      sig({ kind: "deployment", name: "Production – storefront-admin", provider: "vercel", count: 8 }), // unassigned
      sig({ kind: "deployment", name: "Production – storefront-api", provider: "render", count: 14 }), // a pending suggestion carries it
      sig({ kind: "check", name: "test", provider: null, source: "github-actions" }), // a plain CI check: not a deploy name
      sig({ kind: "workflow", name: "ci.yml", source: ".github/workflows/ci.yml" }), // a workflow: not a deploy name
      sig({ kind: "status", name: "Vercel", provider: "vercel" }), // a host's status: a deploy name
    ];
    const suggestion: AppSuggestionDTO = {
      id: "s1", key: "api", folder: "apps/api", kind: "Service", provider: "render", evidence: [], parts: [], usedBy: [], state: "pending",
      signals: [signals[2]],
    };
    const { app } = testApp({ seenSignals: async () => signals, listSuggestions: async () => [suggestion] });
    const d = (await send(app, "GET", `${REPO}/apps`, await ownerCookie())).json as unknown as RepoAppsSetupDTO;
    expect(d.unassigned.map((s) => s.name)).toEqual(["Production – storefront-admin", "Vercel"]);
    expect(d.signals).toHaveLength(6);
    expect(d.suggestions.map((s) => s.id)).toEqual(["s1"]);
  });
});

describe("PUT / DELETE /repos/:owner/:name/apps/:key", () => {
  it("creates and changes an app of this repository through the audited writer", async () => {
    await seedOrgSettings();
    const { app } = testApp();
    const me = await ownerCookie();
    const made = await send(app, "PUT", `${REPO}/apps/docs`, me, { kind: "Site", label: "Docs", folder: "apps/docs/", watch: ["apps/docs/**", "packages/ui/**"] });
    expect(made.status).toBe(201);
    expect(made.json).toMatchObject({ created: true, app: { key: "docs", repo: "SaplingLearn/sapling", folder: "apps/docs", kind: "Site", source: "manual", watch: ["apps/docs/**", "packages/ui/**"] } });
    const changed = await send(app, "PUT", `${REPO}/apps/docs`, me, { kind: "Package", release_signal: "tag:v*" });
    expect(changed.status).toBe(200);
    expect(changed.json).toMatchObject({ created: false, app: { kind: "Package", releaseSignal: "tag:v*" } });
    const audit = await adminAudit("app.set");
    expect(audit.map((a) => [a.actor, a.target, JSON.parse(a.detail).created])).toEqual([["AndresL230", "docs", true], ["AndresL230", "docs", false]]);
  });

  it("refuses a body field an app does not have (repo, source), a member, an unconnected repository and another repository's key", async () => {
    await seedOrgSettings();
    await run(env.DB, `INSERT INTO org_repos (id, org_id, repo_full_name, is_primary, created_at, created_by) VALUES ('r2', ?, 'SaplingLearn/docs', 0, '2026-10-01T00:00:00Z', 'test')`, ORG_A);
    const { app } = testApp();
    const me = await ownerCookie();
    expect((await send(app, "PUT", `${REPO}/apps/x`, me, { kind: "Site", repo: "acme/elsewhere" })).status).toBe(400);
    expect((await send(app, "PUT", `${REPO}/apps/x`, me, { kind: "Site", source: "suggested" })).status).toBe(400);
    expect((await send(app, "PUT", `${REPO}/apps/x`, await roleCookie("shiva", "member"), { kind: "Site" })).status).toBe(403);
    expect((await send(app, "PUT", `${A}/repos/acme/nope/apps/x`, me, { kind: "Site" })).status).toBe(404);
    // `frontend` is SaplingLearn/sapling's: a write addressed to SaplingLearn/docs never moves it.
    const taken = await send(app, "PUT", `${A}/repos/SaplingLearn/docs/apps/frontend`, me, { kind: "Site" });
    expect(taken.status).toBe(409);
    expect(taken.json).toMatchObject({ error: "app_conflict", field: "key" });
    expect((await all<{ repo: string }>(env.DB, `SELECT repo FROM repo_apps WHERE org_id = ? AND key = 'frontend'`, ORG_A))[0].repo).toBe("SaplingLearn/sapling");
  });

  it("removes an app, keeping its parts by default — or with them, each audited", async () => {
    await seedOrgSettings();
    const { app } = testApp();
    const me = await ownerCookie();
    const kept = await send(app, "DELETE", `${REPO}/apps/backend`, me);
    expect(kept.status).toBe(200);
    expect(kept.json).toEqual({ key: "backend", removed_parts: [], kept_parts: 2 });
    expect((await all(env.DB, `SELECT 1 FROM org_environment_parts WHERE org_id = ? AND part_key = 'backend'`, ORG_A))).toHaveLength(2);
    // Its parts still read as an app (synthesised): removing THAT needs its parts to go.
    expect((await send(app, "DELETE", `${REPO}/apps/backend`, me)).status).toBe(400);
    const gone = await send(app, "DELETE", `${REPO}/apps/backend?parts=remove`, me);
    expect(gone.json).toEqual({ key: "backend", removed_parts: [{ env: "staging", part: "backend" }, { env: "production", part: "backend" }], kept_parts: 0 });
    expect((await all(env.DB, `SELECT 1 FROM org_environment_parts WHERE org_id = ? AND part_key = 'backend'`, ORG_A))).toHaveLength(0);
    expect((await adminAudit("app.delete")).map((a) => a.target)).toEqual(["backend"]);
    expect((await adminAudit("part.delete")).map((a) => a.target)).toEqual(["staging/backend", "production/backend"]);
    expect((await send(app, "DELETE", `${REPO}/apps/backend`, me)).status).toBe(404);
    expect((await send(app, "DELETE", `${REPO}/apps/frontend?parts=all`, me)).status).toBe(400);
  });
});

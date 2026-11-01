/**
 * "One service that does everything" (#144, narrowed by #153) — src/repo/one-service.ts through the Apps routes.
 * What matters:
 *   - RECOGNITION is a pre-fill from captured rows only: one host's signs and at most one deployable on it, on the
 *     primary repository, with no app yet. Two hosts, two deployables, a suggestion on another host, a non-primary
 *     repository or an existing app → no offer (a wrong pre-fill is worse than none).
 *   - Trov's own wrangler.toml (this repository's) is the test case: one Worker, its D1 database and crons, read
 *     before any environment exists.
 *   - The confirmed step writes the environment's URL + health path, the app and its ONE part through the audited
 *     writers; a refused step leaves nothing behind; admin, cookie only.
 *   - The Overview reads the one part's health from the URL + health path.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import wranglerToml from "../wrangler.toml?raw";
import type { AppEnv } from "../src/auth/principal";
import { sessionGate } from "../src/auth/principal";
import { platformContext, tenantGate } from "../src/data/gate";
import { makeRepoAppsApp } from "../src/repo/apps-routes";
import { APPS_SETUP_DEPS, type AppsSetupDeps } from "../src/repo/apps-setup";
import { recogniseOneService, type OneServiceInput } from "../src/repo/one-service";
import { buildParts } from "../src/repo/scan";
import { wrangler } from "../src/repo/detect/wrangler";
import { PROVIDERS } from "../src/hosting/registry";
import type { DetectRow } from "../src/hosting/detect";
import { getRepoDashboard } from "../src/tools/repo";
import { putMetrics } from "../src/repo/store";
import type { AppSuggestionDTO, OneServiceOfferDTO, RepoAppsSetupDTO } from "@shared/repo-scan-core";
import type { HostingDetectionDTO } from "@shared/hosting";
import type { RepoEnvConfig } from "../src/repo/config";
import { all, run } from "./helpers/db";
import { ownerCookie, roleCookie } from "./helpers/integrations";
import { send } from "./helpers/hosting-setup";
import { seedOrgRepoConfig } from "./helpers/repo";
import { addPart } from "./helpers/dashboard-hosting";
import { ORG_A, systemCtx } from "./helpers/tenant";

const REPO = "AndresL230/trov";
const A = "/api/o/saplinglearn";
const PATH = `${A}/repos/AndresL230/trov`;

// ── the test case: this repository's own wrangler.toml ─────────────────────────
const trovCandidates = () => wrangler.detect({ repo: REPO, tree: ["wrangler.toml"], files: new Map([["wrangler.toml", wranglerToml]]) });

const CF: HostingDetectionDTO = { provider: "cloudflare", evidence: "GitHub check runs posted by the Cloudflare Workers and Pages app", last_seen: "2026-10-31T10:00:00Z", in_use: false };
const RAILWAY: HostingDetectionDTO = { provider: "railway", evidence: "GitHub deployments created by railway-app[bot]", last_seen: "2026-10-31T10:00:00Z", in_use: false };

function trovSuggestion(over: Partial<AppSuggestionDTO> = {}): AppSuggestionDTO {
  const c = trovCandidates()[0];
  return {
    id: "sg_0123456789abcdef0123", key: "trov", folder: c.folder, kind: c.kind, provider: c.provider, evidence: c.evidence,
    parts: buildParts(c, [], [], PROVIDERS), signals: [], usedBy: [], state: "pending", ...over,
  };
}
const input = (over: Partial<OneServiceInput> = {}): OneServiceInput => ({
  repo: REPO, primary: true, apps: [], suggestions: [trovSuggestion()], detected: [CF], environments: [], taken: new Set(), providers: PROVIDERS, ...over,
});

describe("the repo scan on Trov's own wrangler.toml", () => {
  it("finds ONE Worker, with its D1 database, its R2 bucket and its crons — and keeps them even before an environment exists", () => {
    const c = trovCandidates();
    expect(c.map((x) => [x.folder, x.kind, x.provider])).toEqual([["/", "Worker", "cloudflare"]]);
    expect(c[0].settings).toEqual({
      worker: "trov", d1_database_ids: "6c71838c-18f7-4f68-8513-b58e86c237b9", crons: "*/10 * * * *;0 * * * *;0 * * * SUN,MON",
      r2_bucket_names: "trov-artifacts", // [[previews.r2_buckets]] belongs to the previews, not this Worker (#143)
    });
    // No environment yet: the host's own part is proposed for production, so the Worker's settings are not lost.
    expect(buildParts(c[0], [], [], PROVIDERS)).toEqual([{ env: "production", provider: "cloudflare", settings: c[0].settings }]);
    // [env.preview] names only a database to migrate: with no `preview` environment it proposes nothing more.
    const prod: RepoEnvConfig = { key: "production", label: "Production", note: null, branch: "main", frontendUrl: "", apiUrl: "", healthPath: "/" };
    expect(buildParts(c[0], [], [prod], PROVIDERS).map((p) => p.env)).toEqual(["production"]);
  });
});

describe("recogniseOneService — a pre-fill, from captured rows only", () => {
  it("one host's signs and one Worker on it: one service, prefilled from the scan, a new production environment", () => {
    const o = recogniseOneService(input())!;
    expect(o).toEqual<OneServiceOfferDTO>({
      provider: "cloudflare", evidence: CF.evidence, suggestion: "sg_0123456789abcdef0123", key: "trov", folder: "/", kind: "Worker",
      settings: { worker: "trov", d1_database_ids: "6c71838c-18f7-4f68-8513-b58e86c237b9", crons: "*/10 * * * *;0 * * * *;0 * * * SUN,MON", r2_bucket_names: "trov-artifacts" },
      env: { key: "production", label: "Production", branch: "main", exists: false, url: "", health_path: "" },
    });
  });

  it("reuses the environment called production (or the only one), prefilled with what it stores", () => {
    const prod = { key: "prod", label: "Production", branch: "main", frontend_url: "https://trov.dev", api_url: "https://trov.dev", health_path: "/api/health" };
    const stg = { key: "staging", label: "Staging", branch: "develop", frontend_url: "", api_url: "", health_path: "/" };
    expect(recogniseOneService(input({ environments: [stg, prod] }))!.env).toEqual({ key: "prod", label: "Production", branch: "main", exists: true, url: "https://trov.dev", health_path: "/api/health" });
    expect(recogniseOneService(input({ environments: [stg] }))!.env).toMatchObject({ key: "staging", exists: true, url: "", health_path: "" });
    // two environments and neither is production: a new one
    expect(recogniseOneService(input({ environments: [stg, { ...stg, key: "dev", label: "Dev" }] }))!.env).toMatchObject({ key: "production", exists: false });
  });

  it("with no scan suggestion it still offers the host, named after the repository (a free key)", () => {
    const o = recogniseOneService(input({ suggestions: [], taken: new Set(["trov"]) }))!;
    expect(o).toMatchObject({ provider: "cloudflare", suggestion: null, key: "trov-2", folder: "/", kind: "Site", settings: {} });
  });

  it("is NOT offered when the signals or the scan say more than one thing (never a guess)", () => {
    expect(recogniseOneService(input({ detected: [] }))).toBeNull(); // nothing seen deploying
    expect(recogniseOneService(input({ detected: [CF, RAILWAY] }))).toBeNull(); // a second host
    expect(recogniseOneService(input({ suggestions: [trovSuggestion(), trovSuggestion({ id: "sg_1", key: "api", folder: "api", kind: "Service", provider: null })] }))).toBeNull(); // two deployables
    expect(recogniseOneService(input({ suggestions: [trovSuggestion({ provider: "vercel" })] }))).toBeNull(); // the files name another host
    expect(recogniseOneService(input({ primary: false }))).toBeNull(); // only the primary repository's signals are captured
    expect(recogniseOneService(input({ apps: [{ key: "trov" }] }))).toBeNull(); // already set up
    expect(recogniseOneService(input({ detected: [{ ...CF, provider: "github" as never }] }))).toBeNull(); // not a host
  });

  it("a Package beside the one Worker does not stop it; an ignored or accepted suggestion is not the scan's answer", () => {
    const pkg = trovSuggestion({ id: "sg_2", key: "ui", folder: "packages/ui", kind: "Package", provider: null });
    expect(recogniseOneService(input({ suggestions: [trovSuggestion(), pkg] }))?.suggestion).toBe("sg_0123456789abcdef0123");
    expect(recogniseOneService(input({ suggestions: [trovSuggestion({ state: "ignored" })], taken: new Set() }))).toMatchObject({ suggestion: null, key: "trov" });
  });
});

// ── the routes, against D1 ─────────────────────────────────────────────────────

const CHECK_ROW: DetectRow = { kind: "check", signal: null, name: "Workers Builds: trov", url: "https://dash.cloudflare.com/x", actor_login: null, app: "cloudflare-workers-and-pages", last_at: "2026-10-31T10:00:00Z", n: 12 };

function testApp(over: Partial<AppsSetupDeps> = {}): Hono<AppEnv> {
  const deps: AppsSetupDeps = { ...APPS_SETUP_DEPS, seenSignals: async () => [], detectRows: async () => [CHECK_ROW], ...over };
  const a = new Hono<AppEnv>();
  a.use("*", sessionGate);
  a.use("*", platformContext);
  a.use("/api/o/:slug/*", tenantGate);
  a.route("/api/o/:slug", makeRepoAppsApp(deps));
  return a;
}

/** SaplingLearn, but its primary repository is Trov with nothing set up: no app, no part. */
async function seedBare(envs: RepoEnvConfig[] = []): Promise<void> {
  await run(env.DB, `DELETE FROM org_environment_parts WHERE org_id = ?`, ORG_A);
  await run(env.DB, `DELETE FROM repo_apps WHERE org_id = ?`, ORG_A);
  await run(env.DB, `DELETE FROM org_environments WHERE org_id = ?`, ORG_A);
  await seedOrgRepoConfig(env.DB, ORG_A, REPO, envs);
}
async function seedSuggestion(): Promise<void> {
  const s = trovSuggestion();
  await run(env.DB, `INSERT INTO repo_app_suggestions (org_id, id, repo, key, folder, kind, provider, evidence, parts, used_by, state, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 'pending', '2026-10-31T00:00:00Z')`,
    ORG_A, s.id, REPO, s.key, s.folder, s.kind, s.provider, JSON.stringify(s.evidence), JSON.stringify(s.parts));
}
const BODY = {
  provider: "cloudflare", key: "trov", url: "https://trov.dev/", health_path: "/api/health", branch: "main",
  settings: { worker: "trov", d1_database_ids: "6c71838c-18f7-4f68-8513-b58e86c237b9", crons: "*/10 * * * *;0 * * * *;0 * * * SUN,MON" },
  suggestion: "sg_0123456789abcdef0123",
};

describe("GET …/apps offers one service; POST …/one-service sets it up in one step", () => {
  it("the read carries the offer (D1 rows only), and none once the repository has an app", async () => {
    await seedBare();
    await seedSuggestion();
    const app = testApp();
    const me = await ownerCookie();
    const d = (await send(app, "GET", `${PATH}/apps`, me)).json as unknown as RepoAppsSetupDTO;
    expect(d.oneService).toMatchObject({ provider: "cloudflare", key: "trov", suggestion: "sg_0123456789abcdef0123", env: { key: "production", exists: false } });
    // a failed detection read is no offer — never a degraded page
    const broken = testApp({ detectRows: async () => { throw new Error("d1"); } });
    const b = (await send(broken, "GET", `${PATH}/apps`, me)).json as unknown as RepoAppsSetupDTO;
    expect(b.oneService).toBeNull();
    expect(b.degraded).toBeUndefined();
  });

  it("writes the environment (URL as both addresses, the health path), the app and its ONE part — audited, the suggestion accepted", async () => {
    await seedBare();
    await seedSuggestion();
    const app = testApp();
    const me = await ownerCookie();
    const r = await send(app, "POST", `${PATH}/one-service`, me, BODY);
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ env: { key: "production", created: true }, part: { env: "production", key: "trov", provider: "cloudflare" } });
    expect(await all(env.DB, `SELECT key, label, branch, frontend_url, api_url, health_path FROM org_environments WHERE org_id = ?`, ORG_A)).toEqual([
      { key: "production", label: "Production", branch: "main", frontend_url: "https://trov.dev", api_url: "https://trov.dev", health_path: "/api/health" },
    ]);
    const parts = await all<{ env_key: string; part_key: string; role: string; provider: string; settings: string }>(env.DB,
      `SELECT env_key, part_key, role, provider, settings FROM org_environment_parts WHERE org_id = ?`, ORG_A);
    expect(parts.map((p) => [p.env_key, p.part_key, p.role, p.provider, JSON.parse(p.settings)])).toEqual([["production", "trov", "web", "cloudflare", BODY.settings]]);
    expect(await all(env.DB, `SELECT key, repo, folder, kind, source FROM repo_apps WHERE org_id = ?`, ORG_A)).toEqual([
      { key: "trov", repo: REPO, folder: "/", kind: "Worker", source: "suggested" },
    ]);
    expect(await all(env.DB, `SELECT state, decided_by FROM repo_app_suggestions WHERE org_id = ?`, ORG_A)).toEqual([{ state: "accepted", decided_by: "AndresL230" }]);
    const audit = await all<{ action: string }>(env.DB, `SELECT action FROM org_admin_audit WHERE org_id = ? AND action IN ('app.set', 'part.set') ORDER BY id`, ORG_A);
    expect(audit.map((x) => x.action)).toEqual(["app.set", "part.set"]);
    // Once set up, the page offers nothing more.
    const d = (await send(app, "GET", `${PATH}/apps`, me)).json as unknown as RepoAppsSetupDTO;
    expect(d.oneService).toBeNull();
    expect(d.apps.map((a) => [a.key, a.parts.map((p) => `${p.env}/${p.provider}`)])).toEqual([["trov", ["production/cloudflare"]]]);
  });

  it("an existing production environment keeps its branch and takes the URL; a refused part undoes the step", async () => {
    await seedBare([{ key: "production", label: "Production", note: null, branch: "release", frontendUrl: "https://old.example.com", apiUrl: "https://api.old.example.com", healthPath: "/health" }]);
    const app = testApp();
    const me = await ownerCookie();
    // A Worker name Cloudflare would refuse: nothing written, the environment as it was.
    const bad = await send(app, "POST", `${PATH}/one-service`, me, { ...BODY, suggestion: undefined, settings: { worker: "no spaces allowed" } });
    expect(bad.status).toBe(400);
    expect(bad.json).toMatchObject({ error: "invalid", field: "settings.worker" });
    const envRow = async () => all(env.DB, `SELECT branch, frontend_url, api_url, health_path FROM org_environments WHERE org_id = ?`, ORG_A);
    expect(await envRow()).toEqual([{ branch: "release", frontend_url: "https://old.example.com", api_url: "https://api.old.example.com", health_path: "/health" }]);
    const ok = await send(app, "POST", `${PATH}/one-service`, me, { ...BODY, suggestion: undefined, health_path: "", branch: "ignored" });
    expect(ok.status).toBe(201);
    expect(ok.json).toMatchObject({ env: { key: "production", created: false } });
    expect(await envRow()).toEqual([{ branch: "release", frontend_url: "https://trov.dev", api_url: "https://trov.dev", health_path: "/" }]);
    expect(await all(env.DB, `SELECT kind, source FROM repo_apps WHERE org_id = ?`, ORG_A)).toEqual([{ kind: "Site", source: "manual" }]);
    // the same name again: taken
    const again = await send(app, "POST", `${PATH}/one-service`, me, { ...BODY, suggestion: undefined });
    expect(again.status).toBe(409);
    expect(again.json).toMatchObject({ error: "key_taken", field: "key" });
  });

  it("refuses a bad URL beside its field, and is admin only and cookie only", async () => {
    await seedBare();
    const app = testApp();
    const me = await ownerCookie();
    const http = await send(app, "POST", `${PATH}/one-service`, me, { ...BODY, suggestion: undefined, url: "http://trov.dev" });
    expect(http.status).toBe(400);
    expect(http.json).toMatchObject({ error: "invalid", field: "url" });
    expect(await all(env.DB, `SELECT key FROM org_environments WHERE org_id = ?`, ORG_A)).toEqual([]);
    expect((await send(app, "POST", `${PATH}/one-service`, await roleCookie("shiva", "member"), BODY)).status).toBe(403);
    expect((await send(app, "POST", `${PATH}/one-service`, me, BODY, undefined, { authorization: "Bearer trov_mcp_x" })).status).toBe(403);
    expect((await send(app, "POST", `${A}/repos/acme/other/one-service`, me, BODY)).status).toBe(404);
  });
});

describe("the Overview reads one service's health from its URL + health path", () => {
  const NOW = Date.parse("2026-10-31T12:00:00Z");
  const at = new Date(NOW - 5 * 60_000).toISOString();
  const env1 = (frontendUrl: string): RepoEnvConfig => ({ key: "production", label: "Production", note: null, branch: "main", frontendUrl, apiUrl: "https://trov.dev", healthPath: "/api/health" });

  it("the environment's ONLY part, one origin: the API URL + health path is its health", async () => {
    await seedBare([env1("https://trov.dev")]);
    await addPart(ORG_A, "production", "trov", "cloudflare", "web", { worker: "trov" });
    await putMetrics(systemCtx(ORG_A), [
      { metric: "health_up", env: "production", part: "backend", value: 1, at }, { metric: "health_ms", env: "production", part: "backend", value: 80, at },
      { metric: "health_up", env: "production", part: "frontend", value: 0, at }, { metric: "health_ms", env: "production", part: "frontend", value: 50, at },
    ]);
    const dash = await getRepoDashboard(systemCtx(ORG_A), REPO, NOW, [env1("https://trov.dev")], undefined, { app: null });
    expect(dash.facts!.parts[0]).toMatchObject({ app: "trov", health: { url: "https://trov.dev/api/health", up: true, stale: false }, url: "https://trov.dev" });
  });

  it("a site with its API on another origin keeps the site's own target (unchanged)", async () => {
    await seedBare([env1("https://www.example.com")]);
    await addPart(ORG_A, "production", "trov", "cloudflare", "web", { worker: "trov" });
    await putMetrics(systemCtx(ORG_A), [{ metric: "health_up", env: "production", part: "frontend", value: 1, at }, { metric: "health_ms", env: "production", part: "frontend", value: 50, at }]);
    const dash = await getRepoDashboard(systemCtx(ORG_A), REPO, NOW, [env1("https://www.example.com")], undefined, { app: null });
    expect(dash.facts!.parts[0].health).toMatchObject({ url: "https://www.example.com", up: true });
  });
});

// The GitHub App's HTTP surface (spec §9): Org settings › Repositories' "GitHub App" panel, and the
// install flow's callback.
//
//   Tenant, mounted at `/api/o/:slug` beside the org settings (src/routes.ts), ADMIN (owner passes),
//   cookie only — a request carrying an `Authorization` header is refused outright, like the rest of Org
//   settings (src/integrations/routes.ts `personOnly`), and there is no MCP tool for any of it:
//     GET  /github                                            the panel's state (`GithubAppStateDTO`)
//     POST /github/install                                    § 8.1 — `{ url }` + the sealed `gh_install` cookie
//     POST /github/installations/:installationId/refresh      re-list its repositories from GitHub
//     POST /github/installations/:installationId/disconnect   Trov forgets it (it stays installed on GitHub)
//   An installation of ANOTHER org is the same 404 as an unknown id: every read is the org's own.
//
//   Platform: GET /github/app/setup (src/github-app/install.ts) — public to `sessionGate`, which it does
//   itself, so a missing session is a page rather than a bare 401.
//
// Every answer is the DTO itself (web/src/api.ts reads no wrapper). No answer, and no log line, carries a
// credential or a thrown Error's own text — except GitHub's reason on a failed refresh, scrubbed of the
// App's secrets and the installation token first.
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../auth/principal";
import { RoleError, requireRole } from "../data/context";
import { scrub, type Secret } from "../data/secrets";
import { GithubAppError, listInstallationRepos, mintInstallationToken } from "./client";
import { appSecrets, githubAppConfig } from "./config";
import { InstallationNotFoundError, githubAppState, listInstallations, syncInstallationRepos, unbindInstallation } from "./installations";
import { LISTING_PERMISSIONS, SETUP_PATH, githubAppSetup, parseInstallationId, startInstall, type InstallDeps } from "./install";

type C = Context<AppEnv>;

const personOnly: MiddlewareHandler<AppEnv> = async (c, next) =>
  c.req.header("authorization")
    ? c.json({ error: "forbidden", message: "the GitHub App is connected by a signed-in admin, never a token" }, 403)
    : next();

const notFound = (c: C) => c.json({ error: "not_found" }, 404);
const notConfigured = (c: C) => c.json({ error: "github_app_not_configured", message: "the GitHub App is not set up on this Trov" }, 503);

/** Run a handler; map the module's refusals to their status. Anything else is a 503 with no detail —
 *  never a 500, and never the Error's own text. */
async function guard(c: C, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof RoleError) return c.json({ error: "forbidden" }, 403);
    if (e instanceof InstallationNotFoundError) return notFound(c);
    console.error("github app route failed", e instanceof Error ? e.name : "error"); // the name only — never the Error
    return c.json({ error: "temporarily_unavailable" }, 503);
  }
}

/** The path's installation id, when it is one of THIS org's installations — else null (404). */
async function ownInstallation(c: C): Promise<number | null> {
  const id = parseInstallationId(c.req.param("installationId"));
  if (id === null) return null;
  return (await listInstallations(c.var.ctx)).some((i) => i.installation_id === id) ? id : null;
}

/** The tenant routes, behind the app's `tenantGate` (src/routes.ts mounts it on `/api/o/:slug/*`). */
export function buildGithubAppTenantApp(deps: InstallDeps = {}): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  // Only this sub-app's own prefix: a sibling mounted on the same base is not affected.
  for (const path of ["/github", "/github/*"]) r.use(path, personOnly);

  r.get("/github", (c) => guard(c, async () => {
    requireRole(c.var.ctx, "admin");
    return c.json(await githubAppState(c.var.ctx, c.env));
  }));

  r.post("/github/install", (c) => guard(c, async () => {
    requireRole(c.var.ctx, "admin");
    const cfg = githubAppConfig(c.env);
    if (!cfg) return notConfigured(c);
    return c.json(await startInstall(c, cfg, c.var.ctx, c.req.param("slug") ?? "", deps), 200, { "cache-control": "no-store" });
  }));

  // Re-list the installation's repositories from GitHub (a listing token, metadata only) and sync the full
  // list: a repository that left it detaches, one that arrived attaches. The ownership check comes BEFORE any
  // GitHub call — no org mints for another org's installation.
  r.post("/github/installations/:installationId/refresh", (c) => guard(c, async () => {
    const ctx = c.var.ctx;
    requireRole(ctx, "admin");
    const id = await ownInstallation(c);
    if (id === null) return notFound(c);
    const cfg = githubAppConfig(c.env);
    if (!cfg) return notConfigured(c);
    let token: Secret | null = null;
    try {
      token = (await mintInstallationToken(cfg, id, { permissions: LISTING_PERMISSIONS }, { fetchImpl: deps.fetchImpl, now: (deps.now ?? Date.now)() })).token;
      const repos = await listInstallationRepos(token, { fetchImpl: deps.fetchImpl });
      await syncInstallationRepos(ctx, id, repos, ctx.userId);
    } catch (e) {
      if (!(e instanceof GithubAppError)) throw e;
      const message = scrub(e.message, [appSecrets(cfg), token]);
      console.error("github app refresh: GitHub failed", message, `org=${ctx.orgId}`);
      return c.json({ error: "github_unavailable", message }, 502);
    }
    return c.json(await githubAppState(ctx, c.env));
  }));

  // Trov forgets the installation: its repositories detach (back to the pasted token), its rows go, audited.
  // It stays installed on GitHub — the panel says to uninstall there too. Needs no App config.
  r.post("/github/installations/:installationId/disconnect", (c) => guard(c, async () => {
    const ctx = c.var.ctx;
    requireRole(ctx, "admin");
    const id = parseInstallationId(c.req.param("installationId"));
    if (id === null || !(await unbindInstallation(ctx, id, ctx.userId, "github.disconnect"))) return notFound(c);
    return c.json(await githubAppState(ctx, c.env));
  }));

  return r;
}

/** `GET /github/app/setup` — the install flow's callback (person-level: the org comes from the sealed cookie). */
export function buildGithubAppSetupApp(deps: InstallDeps = {}): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.get(SETUP_PATH, (c) => githubAppSetup(c, deps));
  return r;
}

export const githubAppTenantApp = buildGithubAppTenantApp();
export const githubAppSetupApp = buildGithubAppSetupApp();

// Org settings › Repositories › a repo › Apps — the HTTP surface of the app read and writes (repo setups, Phase D2).
// Mounted at `/api/o/:slug` (src/routes.ts) behind the app's `tenantGate`; cookie only (an `Authorization` header is
// a 403, as on every Org settings route); admin+. The repository in the path must be one the org connected (else 404).
//
//   GET    /repos/:owner/:name/apps            admin+   RepoAppsSetupDTO (src/repo/apps-setup.ts)
//   PUT    /repos/:owner/:name/apps/:key       admin+   { app, created }  (201 when created) — kind, label, folder,
//                                                       watch, release_signal, position; audited `app.set`
//   DELETE /repos/:owner/:name/apps/:key       admin+   AppRemoved — `?parts=remove` takes its parts too (each
//                                                       audited `part.delete`); default keeps them
//
// The scan and the suggestions' accept / ignore / undo (`POST …/scan`, `…/suggestions/…`) are the scan's own routes.
// Every refusal is a status with fixed text; nothing answers 500 with an Error's own words.
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../auth/principal";
import { RoleError, requireRole } from "../data/context";
import { SettingsError } from "../integrations/settings";
import { APPS_SETUP_DEPS, connectedRepo, getRepoAppsSetup, putAppInRepo, removeAppInRepo, type AppsSetupDeps } from "./apps-setup";

type C = Context<AppEnv>;

const personOnly: MiddlewareHandler<AppEnv> = async (c, next) =>
  c.req.header("authorization")
    ? c.json({ error: "forbidden", message: "repository settings are a signed-in person's action, never a token's" }, 403)
    : next();

async function guard(c: C, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof RoleError) return c.json({ error: "forbidden" }, 403);
    if (e instanceof SettingsError) return c.json({ error: e.code, ...(e.field ? { field: e.field } : {}), message: e.message }, e.status);
    console.error("repo apps route failed", e instanceof Error ? e.name : "error"); // the name only — never the Error
    return c.json({ error: "internal" }, 500);
  }
}

async function jsonBody(c: C): Promise<Record<string, unknown> | null> {
  const text = await c.req.text().catch(() => "");
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch { return null; }
}

/** The repository the path names, as the org connected it — or the 404 to answer. Admin is checked first, so a
 *  member learns nothing about which repositories are connected. */
async function repoOf(c: C): Promise<string | Response> {
  requireRole(c.var.ctx, "admin");
  const repo = await connectedRepo(c.var.ctx, c.req.param("owner") ?? "", c.req.param("name") ?? "");
  return repo ?? c.json({ error: "not_found", message: "no such repository in this organization" }, 404);
}

export function makeRepoAppsApp(deps: AppsSetupDeps = APPS_SETUP_DEPS): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use("/repos/:owner/:name/apps", personOnly);
  r.use("/repos/:owner/:name/apps/*", personOnly);

  r.get("/repos/:owner/:name/apps", (c) => guard(c, async () => {
    const repo = await repoOf(c);
    if (repo instanceof Response) return repo;
    try {
      return c.json(await getRepoAppsSetup(c.var.ctx, c.env, repo, deps));
    } catch (e) {
      if (e instanceof RoleError || e instanceof SettingsError) throw e;
      // A screen's read degrades — never a 500 (invariant 7).
      console.error("repo apps read failed", e instanceof Error ? e.name : "error");
      return c.json({ error: "unavailable", degraded: true }, 503);
    }
  }));

  r.put("/repos/:owner/:name/apps/:key", (c) => guard(c, async () => {
    const repo = await repoOf(c);
    if (repo instanceof Response) return repo;
    const body = await jsonBody(c);
    if (!body) return c.json({ error: "invalid_json", message: "the body must be a JSON object" }, 400);
    const { app, created } = await putAppInRepo(c.var.ctx, repo, c.req.param("key"), body);
    return c.json({ app, created }, created ? 201 : 200);
  }));

  r.delete("/repos/:owner/:name/apps/:key", (c) => guard(c, async () => {
    const repo = await repoOf(c);
    if (repo instanceof Response) return repo;
    const parts = c.req.query("parts") ?? "keep";
    if (parts !== "keep" && parts !== "remove") return c.json({ error: "invalid", field: "parts", message: "parts must be keep or remove" }, 400);
    return c.json(await removeAppInRepo(c.var.ctx, repo, c.req.param("key"), parts === "remove"));
  }));

  return r;
}

export const repoAppsApp = makeRepoAppsApp();

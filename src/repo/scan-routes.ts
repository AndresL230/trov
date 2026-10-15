// The repo scan's HTTP surface (repo setups, Phase D) — Org settings › Repositories › a repo › Apps calls it. Mounted
// at `/api/o/:slug` (src/routes.ts) behind the app's `tenantGate`; cookie only (an `Authorization` header is a 403,
// as on the other Org settings routes); admin only; never an MCP tool (invariant 2: humans confirm).
//
//   POST /repos/:owner/:name/scan                     Scan again → ScanNowResult (`ok: false` + `scan.error` when
//                                                     it could not run; never a 500 with upstream words)
//   POST /repos/:owner/:name/suggestions/:id/accept   → { undo, app, parts }
//   POST /repos/:owner/:name/suggestions/:id/ignore   → { undo }
//   POST /repos/:owner/:name/suggestions/undo         body { undo } → { id, undone }
//
// The repository is checked against `org_repos` (404 otherwise), and a suggestion must belong to it.
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../auth/principal";
import { RoleError, requireRole } from "../data/context";
import { first } from "../data/sql";
import { SecretAccessError } from "../data/secrets";
import { SettingsError } from "../integrations/settings";
import { acceptSuggestion, ignoreSuggestion, runScanNow, undoAccept } from "./scan-store";
import type { ProviderMap } from "./scan";

type C = Context<AppEnv>;

export interface ScanRouteOptions { fetchImpl?: typeof fetch; providers?: ProviderMap; now?: () => number }

const personOnly: MiddlewareHandler<AppEnv> = async (c, next) =>
  c.req.header("authorization")
    ? c.json({ error: "forbidden", message: "repository setup is a signed-in person's action, never a token's" }, 403)
    : next();

async function guard(c: C, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof RoleError || e instanceof SecretAccessError) return c.json({ error: "forbidden" }, 403);
    if (e instanceof SettingsError) return c.json({ error: e.code, ...(e.field ? { field: e.field } : {}), message: e.message }, e.status);
    console.error("repo scan route failed", e instanceof Error ? e.name : "error"); // the name only — never the Error
    return c.json({ error: "internal" }, 500);
  }
}

/** The org's repository named by the path, as stored — or null. */
async function heldRepo(c: C): Promise<string | null> {
  const want = `${c.req.param("owner")}/${c.req.param("name")}`;
  const row = await first<{ repo_full_name: string }>(c.var.ctx, `SELECT repo_full_name FROM org_repos WHERE org_id = ? AND lower(repo_full_name) = lower(?)`, c.var.ctx.orgId, want);
  return row?.repo_full_name ?? null;
}

/** The suggestion must be this repository's. */
async function ownsSuggestion(c: C, repo: string, id: string): Promise<boolean> {
  return !!(await first<{ id: string }>(c.var.ctx, `SELECT id FROM repo_app_suggestions WHERE org_id = ? AND id = ? AND lower(repo) = lower(?)`, c.var.ctx.orgId, id, repo));
}

const noRepo = (c: C) => c.json({ error: "not_found", message: "no such repository" }, 404);
const noSuggestion = (c: C) => c.json({ error: "not_found", message: "no such suggestion" }, 404);

export function makeScanApp(o: ScanRouteOptions = {}): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const now = () => (o.now ? o.now() : Date.now());
  r.use("/repos/:owner/:name/scan", personOnly);
  r.use("/repos/:owner/:name/suggestions/*", personOnly);

  r.post("/repos/:owner/:name/scan", (c) => guard(c, async () => {
    requireRole(c.var.ctx, "admin");
    const repo = await heldRepo(c);
    if (!repo) return noRepo(c);
    return c.json(await runScanNow(c.env, c.var.ctx, repo, { fetchImpl: o.fetchImpl, now: now(), providers: o.providers }));
  }));

  r.post("/repos/:owner/:name/suggestions/undo", (c) => guard(c, async () => {
    requireRole(c.var.ctx, "admin");
    const repo = await heldRepo(c);
    if (!repo) return noRepo(c);
    let body: unknown = null;
    try { body = await c.req.json(); } catch { /* answered below */ }
    const token = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).undo : undefined;
    if (typeof token !== "string") return c.json({ error: "invalid", field: "undo", message: "the body must be { undo }" }, 400);
    const id = token.split("~")[0];
    if (!(await ownsSuggestion(c, repo, id))) return noSuggestion(c);
    return c.json(await undoAccept(c.var.ctx, c.var.ctx.userId, token, now()));
  }));

  r.post("/repos/:owner/:name/suggestions/:id/accept", (c) => guard(c, async () => {
    requireRole(c.var.ctx, "admin");
    const repo = await heldRepo(c);
    if (!repo) return noRepo(c);
    if (!(await ownsSuggestion(c, repo, c.req.param("id")))) return noSuggestion(c);
    const out = await acceptSuggestion(c.var.ctx, c.var.ctx.userId, c.req.param("id"), { providers: o.providers, now: now() });
    return c.json(out);
  }));

  r.post("/repos/:owner/:name/suggestions/:id/ignore", (c) => guard(c, async () => {
    requireRole(c.var.ctx, "admin");
    const repo = await heldRepo(c);
    if (!repo) return noRepo(c);
    if (!(await ownsSuggestion(c, repo, c.req.param("id")))) return noSuggestion(c);
    return c.json(await ignoreSuggestion(c.var.ctx, c.var.ctx.userId, c.req.param("id"), now()));
  }));

  return r;
}

export const scanApp = makeScanApp();

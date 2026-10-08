// Org settings › Integrations, Repositories, Environments — mounted at `/api/o/:slug`
// (canopy-multitenancy.md §8.7.3, §8.7.4, D14, D16, D18).
//
//   /integrations   WRITE-ONLY secrets. Every route is admin+ (rotate-key: owner). A secret is accepted,
//                   encrypted and never returned, logged, audited or echoed in a validation error.
//   /repos          the org's repositories (one primary); any member reads, admin+ writes.
//   /environments   the org's environments, in drift order; any member reads, admin+ writes.
//
// Cookie only, never a token: a request that carries an `Authorization` header is refused outright
// (like ratify, src/artifacts/routes.ts), and there is no MCP tool for any of this. Gates, in order:
// sessionGate (401) → tenantGate (404 for an unknown org AND for a non-member) → the Authorization
// refusal (403) → the role (403). The first two are the app's (src/routes.ts mounts `tenantGate` ONCE
// on `/api/o/:slug/*`, which also meters the request); this sub-app adds only the last two.
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { isIntegrationKind, type IntegrationKind } from "@shared/integrations";
import type { AppEnv } from "../auth/principal";
import { RoleError, hasRole, requireRole } from "../data/context";
import {
  SecretAccessError, SecretConflictError, SecretDecryptError, SecretNotFoundError, SecretValueError, SecretsUnavailableError,
  deleteSecret, listOrgAudit, rotateOrgKey, rotateSecret, secretValueProblem, setIntegrationConfig, setSecret,
} from "../data/secrets";
import { INTEGRATION_CATALOG, checkIntegrationConfig, integrationRow, listIntegrations, scopeExists } from "./catalog";
import { importLogoLater } from "./logo";
import { testConnection } from "./probe";
import { supersedeConnection } from "../hosting/connections";
import { PlanLimitError } from "../plans/state";
import { SettingsError, addRepo, deleteEnvironment, listEnvironments, listRepos, putEnvironment, removeRepo, reorderEnvironments } from "./settings";

type C = Context<AppEnv>;

const originOf = (c: C): string => c.env.PUBLIC_ORIGIN ?? new URL(c.req.url).origin;

const personOnly: MiddlewareHandler<AppEnv> = async (c, next) =>
  c.req.header("authorization")
    ? c.json({ error: "forbidden", message: "org settings are a signed-in person's action, never a token's" }, 403)
    : next();

/** Run a handler; map every refusal to its status. No response, and no log line, carries a thrown
 *  Error's own text unless it is one of this module's fixed-text errors. */
async function guard(c: C, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PlanLimitError) throw e; // the org's plan refused an addition (0044_plans): the app's one handler answers 402
    if (e instanceof RoleError || e instanceof SecretAccessError) return c.json({ error: "forbidden" }, 403);
    if (e instanceof SecretsUnavailableError) return c.json({ error: "secrets_unavailable" }, 503);
    if (e instanceof SecretValueError) return c.json({ error: e.code, field: "secret", message: e.message }, 400);
    if (e instanceof SecretConflictError) return c.json({ error: e.code, message: e.message }, 409);
    if (e instanceof SecretNotFoundError) return c.json({ error: e.code, message: e.message }, 404);
    if (e instanceof SecretDecryptError) return c.json({ error: e.code, target: e.target, message: "a stored secret could not be decrypted — delete or rotate it" }, 409);
    if (e instanceof SettingsError) return c.json({ error: e.code, ...(e.field ? { field: e.field } : {}), message: e.message }, e.status);
    console.error("org settings route failed", e instanceof Error ? e.name : "error"); // the name only — never the Error
    return c.json({ error: "internal" }, 500);
  }
}

/** The JSON object a write was sent, or null (not JSON, or not an object). */
async function jsonObject(c: C): Promise<Record<string, unknown> | null> {
  try {
    const v = (await c.req.json()) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
const badJson = (c: C) => c.json({ error: "invalid_json", message: "the body must be a JSON object" }, 400);
const notFound = (c: C) => c.json({ error: "not_found" }, 404);

// ── /integrations ────────────────────────────────────────────────────────────

type Verb = "set" | "config" | "rotate" | "test" | "delete";
interface Target { kind: IntegrationKind; scope: string; verb: Verb }

/**
 * `/:kind[/:scope][/rotate|/test|/config]` → what it addresses. Whether the segment after the kind is a
 * scope is decided by the KIND (an org-wide kind takes none; a scoped kind always takes one), so an
 * environment that happens to be called `config` or `rotate` is still addressable.
 */
function target(c: C): Target | null {
  const kind = c.req.param("kind");
  if (!isIntegrationKind(kind)) return null;
  const rest = [c.req.param("a"), c.req.param("b")].filter((s): s is string => typeof s === "string");
  const scoped = INTEGRATION_CATALOG[kind].scope !== "org";
  if (scoped && (rest.length === 0 || rest[0] === "")) return null;
  const scope = scoped ? rest.shift()! : "";
  const action = rest.shift();
  if (rest.length) return null;
  const method = c.req.method;
  let verb: Verb | null = null;
  if (method === "PUT") verb = action === undefined ? "set" : action === "config" ? "config" : null;
  else if (method === "POST") verb = action === "rotate" || action === "test" ? action : null;
  else if (method === "DELETE") verb = action === undefined ? "delete" : null;
  return verb ? { kind, scope, verb } : null;
}

const row = async (c: C, t: Target) => ({ integration: await integrationRow(c.var.ctx, c.env, originOf(c), t.kind, t.scope) });

async function integrationWrite(c: C): Promise<Response> {
  return guard(c, async () => {
    const ctx = c.var.ctx;
    requireRole(ctx, "admin");
    const t = target(c);
    if (!t) return notFound(c);

    if (t.verb === "delete") {
      await deleteSecret(ctx, t.kind, t.scope);
      // A hosting provider's install / OAuth row no longer describes a credential (src/hosting/connections.ts).
      await supersedeConnection(ctx, t.kind, t.scope, "disconnected");
      return c.json(await row(c, t));
    }
    if (t.verb === "test") {
      const result = await testConnection(ctx, c.env, t.kind, t.scope, originOf(c));
      return c.json({ ...result, ...(await row(c, t)) });
    }

    const body = await jsonObject(c);
    if (!body) return badJson(c);
    if (t.verb === "rotate") {
      await rotateSecret(ctx, t.kind, t.scope, body.secret as string);
      await supersedeConnection(ctx, t.kind, t.scope, "superseded");
      if (t.kind === "github_token") importLogoLater(c); // the org's image comes from GitHub (./logo.ts)
      return c.json(await row(c, t));
    }
    // set / config name a scope that must exist NOW: a secret is never stored for an environment or
    // repo the org does not have.
    if (!(await scopeExists(ctx, t.kind, t.scope))) return c.json({ error: "unknown_scope", message: "no such environment or repository in this org" }, 404);
    let config: Record<string, string> | undefined;
    if (t.verb === "config" || body.config !== undefined) {
      const checked = checkIntegrationConfig(t.kind, body.config);
      if ("field" in checked) return c.json({ error: "invalid_config", ...checked }, 400);
      config = checked.config;
    }
    if (t.verb === "config") {
      await setIntegrationConfig(ctx, t.kind, t.scope, config!);
      return c.json(await row(c, t));
    }
    const problem = secretValueProblem(t.kind, body.secret);
    if (problem) return c.json({ error: "invalid_secret", field: "secret", message: problem }, 400);
    await setSecret(ctx, t.kind, t.scope, body.secret as string, config);
    await supersedeConnection(ctx, t.kind, t.scope, "superseded");
    if (t.kind === "github_token") importLogoLater(c);
    return c.json(await row(c, t), 201);
  });
}

function integrationRoutes(r: Hono<AppEnv>): void {
  r.get("/integrations", (c) => guard(c, async () => {
    requireRole(c.var.ctx, "admin");
    return c.json(await listIntegrations(c.var.ctx, c.env, originOf(c)));
  }));

  // The page's history list: the org's recent secret / config / key changes, newest first.
  r.get("/integrations/audit", (c) => guard(c, async () => {
    requireRole(c.var.ctx, "admin");
    const n = Number(c.req.query("limit") ?? 50);
    return c.json({ audit: await listOrgAudit(c.var.ctx, Number.isInteger(n) && n >= 1 && n <= 200 ? n : 50) });
  }));

  // DEK rotation (§8.7.1): owner only.
  r.post("/integrations/rotate-key", (c) => guard(c, async () => {
    requireRole(c.var.ctx, "owner");
    return c.json(await rotateOrgKey(c.var.ctx));
  }));

  r.put("/integrations/:kind", integrationWrite);
  r.put("/integrations/:kind/:a", integrationWrite);
  r.put("/integrations/:kind/:a/:b", integrationWrite);
  r.post("/integrations/:kind/:a", integrationWrite);
  r.post("/integrations/:kind/:a/:b", integrationWrite);
  r.delete("/integrations/:kind", integrationWrite);
  r.delete("/integrations/:kind/:a", integrationWrite);
}

// ── /repos ───────────────────────────────────────────────────────────────────

function repoRoutes(r: Hono<AppEnv>): void {
  const list = (c: C) => listRepos(c.var.ctx, originOf(c), hasRole(c.var.ctx, "admin"));

  r.get("/repos", (c) => guard(c, async () => c.json({ repos: await list(c) })));

  r.post("/repos", (c) => guard(c, async () => {
    requireRole(c.var.ctx, "admin");
    const body = await jsonObject(c);
    if (!body) return badJson(c);
    const { id, created } = await addRepo(c.var.ctx, { repo_full_name: body.repo_full_name, is_primary: body.is_primary });
    // Connected, or made primary: the org's image follows its primary repository's owner — after the
    // response, and never over an uploaded one (./logo.ts).
    importLogoLater(c);
    const repos = await list(c);
    return c.json({ repo: repos.find((x) => x.id === id) ?? null, repos }, created ? 201 : 200);
  }));

  r.delete("/repos/:id", (c) => guard(c, async () => {
    requireRole(c.var.ctx, "admin");
    const removed_secrets = await removeRepo(c.var.ctx, c.req.param("id"));
    return c.json({ ok: true, removed_secrets, repos: await list(c) });
  }));
}

// ── /environments ────────────────────────────────────────────────────────────

function environmentRoutes(r: Hono<AppEnv>): void {
  r.get("/environments", (c) => guard(c, async () => c.json({ environments: await listEnvironments(c.var.ctx) })));

  // The collection PUT reorders: `{ order: [key, …] }`, every key exactly once.
  r.put("/environments", (c) => guard(c, async () => {
    requireRole(c.var.ctx, "admin");
    const body = await jsonObject(c);
    if (!body) return badJson(c);
    return c.json({ environments: await reorderEnvironments(c.var.ctx, body.order) });
  }));

  r.put("/environments/:key", (c) => guard(c, async () => {
    requireRole(c.var.ctx, "admin");
    const body = await jsonObject(c);
    if (!body) return badJson(c);
    const written = await putEnvironment(c.var.ctx, c.req.param("key"), body);
    return c.json(written, written.created ? 201 : 200);
  }));

  r.delete("/environments/:key", (c) => guard(c, async () => {
    requireRole(c.var.ctx, "admin");
    const removed_secrets = await deleteEnvironment(c.var.ctx, c.req.param("key"));
    return c.json({ ok: true, removed_secrets, environments: await listEnvironments(c.var.ctx) });
  }));
}

/** Mounted at `/api/o/:slug`, behind the app's `tenantGate`. The Authorization refusal names these three
 *  prefixes only, so a sibling sub-app mounted on the same base is not affected. */
export const orgSettingsApp = (() => {
  const r = new Hono<AppEnv>();
  for (const prefix of ["/integrations", "/repos", "/environments"]) {
    for (const path of [prefix, `${prefix}/*`]) r.use(path, personOnly);
  }
  integrationRoutes(r);
  repoRoutes(r);
  environmentRoutes(r);
  return r;
})();

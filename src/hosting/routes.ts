// Org settings › Hosting — the HTTP surface (#97). No screen yet: these are the routes the screen will call.
//
// Mounted at `/api/o/:slug` beside the Integrations routes (src/routes.ts), behind the app's `tenantGate`
// (404 for an unknown org and for a non-member alike), with NO old-path alias — like the rest of the org surface:
//
//   GET    /hosting                              admin+   HostingSetupDTO — providers, environments + parts, connections, checklist
//   GET    /hosting/providers                    member   { providers: HostingProviderDTO[] }
//   PUT    /environments/:key/parts/:part        admin+   { part: EnvironmentPartDTO, created }   (201 when created)
//   DELETE /environments/:key/parts/:part        admin+   { ok: true, removed: { env, part, provider, legacy } }
//   POST   /hosting/:provider/connect            admin+   ConnectStartDTO, + the `trov_hx` nonce cookie
//   POST   /hosting/:provider/disconnect         admin+   { connection: HostingConnectionDTO, upstream }   body { scope? }
//   POST   /hosting/:provider/test               admin+   HostingTestDTO   body { scope?, env?, part? }
//
// …and, at the app ROOT (a provider's redirect URI is fixed, so it cannot carry the org; the sealed `state`
// does — src/data/gate.ts lets `/hosting/*` past the one-org alias gate, and the callback checks the
// membership itself):
//
//   GET    /hosting/:provider/callback           session  302 → `/o/<slug>/#org/hosting?connected=<p>` | `?connect_error=<code>`
//
// Cookie only, never a token: a request that carries an `Authorization` header is refused outright (403), as
// on the Integrations routes, and there is no MCP tool for any of this. Every refusal maps to a status with
// fixed text; nothing answers 500 with an Error's own words.
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HOSTING_INTEGRATION_KIND, HOSTING_PROVIDERS, isHostingProvider, type HostingTestDTO } from "@shared/hosting";
import type { AppEnv } from "../auth/principal";
import { RoleError, requireRole } from "../data/context";
import {
  SecretAccessError, SecretConflictError, SecretDecryptError, SecretNotFoundError, SecretValueError, SecretsUnavailableError,
} from "../data/secrets";
import { testConnection } from "../integrations/probe";
import { SettingsError } from "../integrations/settings";
import {
  CONNECT_COOKIE, CONNECT_TTL_MS, checkScope, completeConnect, connectCookiePath, connectionDTO, disconnect, startConnect,
} from "./connections";
import { deletePart, putPart, type ProviderMap } from "./part-writes";
import { listAllParts } from "./parts";
import { PROVIDERS, providerDTO } from "./registry";
import { describeParts, getHostingSetup } from "./setup";

type C = Context<AppEnv>;

export interface HostingRouteOptions {
  /** The provider registry — a test stands a fake provider in; production uses `PROVIDERS`. */
  providers?: ProviderMap;
  /** The fetch a provider's exchange / revoke goes through (still wrapped in its fixed-host fetch). */
  fetchImpl?: typeof fetch;
}

const originOf = (c: C): string => c.env.PUBLIC_ORIGIN ?? new URL(c.req.url).origin;

const personOnly: MiddlewareHandler<AppEnv> = async (c, next) =>
  c.req.header("authorization")
    ? c.json({ error: "forbidden", message: "hosting settings are a signed-in person's action, never a token's" }, 403)
    : next();

/** Run a handler; map every refusal to its status. No response, and no log line, carries a thrown Error's own text. */
async function guard(c: C, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof RoleError || e instanceof SecretAccessError) return c.json({ error: "forbidden" }, 403);
    if (e instanceof SecretsUnavailableError) return c.json({ error: "secrets_unavailable" }, 503);
    if (e instanceof SecretValueError) return c.json({ error: e.code, field: "secret", message: e.message }, 400);
    if (e instanceof SecretConflictError) return c.json({ error: e.code, message: e.message }, 409);
    if (e instanceof SecretNotFoundError) return c.json({ error: e.code, message: e.message }, 404);
    if (e instanceof SecretDecryptError) return c.json({ error: e.code, target: e.target, message: "a stored secret could not be decrypted — delete or rotate it" }, 409);
    if (e instanceof SettingsError) return c.json({ error: e.code, ...(e.field ? { field: e.field } : {}), message: e.message }, e.status);
    console.error("hosting route failed", e instanceof Error ? e.name : "error"); // the name only — never the Error
    return c.json({ error: "internal" }, 500);
  }
}

/** The JSON object a write was sent; `{}` for an empty body; null when it is not a JSON object. */
async function jsonBody(c: C, emptyOk: boolean): Promise<Record<string, unknown> | null> {
  const text = await c.req.text().catch(() => "");
  if (text.trim() === "") return emptyOk ? {} : null;
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
const badJson = (c: C) => c.json({ error: "invalid_json", message: "the body must be a JSON object" }, 400);
const onlyKeys = (body: Record<string, unknown>, keys: string[]): boolean => Object.keys(body).every((k) => keys.includes(k));

/** The routes under `/api/o/:slug` — see the header for the list. */
export function makeHostingApp(o: HostingRouteOptions = {}): Hono<AppEnv> {
  const providers = o.providers ?? PROVIDERS;
  const r = new Hono<AppEnv>();
  for (const path of ["/hosting", "/hosting/*", "/environments/:key/parts/*"]) r.use(path, personOnly);

  r.get("/hosting", (c) => guard(c, async () => c.json(await getHostingSetup(c.var.ctx, c.env, providers))));

  // The catalogue alone, for any member: no org data, nothing secret — what the picker and the docs links show.
  r.get("/hosting/providers", (c) => guard(c, async () => c.json({ providers: HOSTING_PROVIDERS.map((id) => providerDTO(providers[id], c.env)) })));

  r.put("/environments/:key/parts/:part", (c) => guard(c, async () => {
    requireRole(c.var.ctx, "admin");
    const body = await jsonBody(c, false);
    if (!body) return badJson(c);
    const { part, created } = await putPart(c.var.ctx, c.req.param("key"), c.req.param("part"), body, providers);
    const [dto] = await describeParts(c.var.ctx, c.env, [part], providers);
    return c.json({ part: dto, created }, created ? 201 : 200);
  }));

  r.delete("/environments/:key/parts/:part", (c) => guard(c, async () => {
    const removed = await deletePart(c.var.ctx, c.req.param("key"), c.req.param("part"));
    return c.json({ ok: true, removed });
  }));

  r.post("/hosting/:provider/connect", (c) => guard(c, async () => {
    const { start, nonce } = await startConnect(c.var.ctx, c.env, c.req.param("provider"), originOf(c), c.req.param("slug") ?? null, Date.now(), providers);
    // `startConnect` accepted the id, so it is one of the registry's and safe in a cookie path.
    setCookie(c, CONNECT_COOKIE, nonce, {
      httpOnly: true, secure: true, sameSite: "Lax", path: connectCookiePath(c.req.param("provider")), maxAge: CONNECT_TTL_MS / 1000,
    });
    return c.json(start);
  }));

  r.post("/hosting/:provider/disconnect", (c) => guard(c, async () => {
    requireRole(c.var.ctx, "admin");
    const body = await jsonBody(c, true);
    if (!body) return badJson(c);
    if (!onlyKeys(body, ["scope"])) return c.json({ error: "invalid", field: "body", message: "the body has a field this route does not take" }, 400);
    return c.json(await disconnect(c.var.ctx, c.env, c.req.param("provider"), body.scope, o.fetchImpl, providers));
  }));

  // Test connection for a provider (and, given env + part, against THAT part's settings). Cloudflare and
  // Railway run their Integrations probe; every other provider its own `probe` through its fixed-host fetch.
  // The outcome is recorded on the credential (`last_error` / `last_used_at`) by `testConnection`.
  r.post("/hosting/:provider/test", (c) => guard(c, async () => {
    const ctx = c.var.ctx;
    requireRole(ctx, "admin");
    const id = c.req.param("provider");
    if (!isHostingProvider(id)) return c.json({ error: "not_found", message: "no such hosting provider" }, 404);
    const p = providers[id];
    const body = await jsonBody(c, true);
    if (!body) return badJson(c);
    if (!onlyKeys(body, ["scope", "env", "part"])) return c.json({ error: "invalid", field: "body", message: "the body has a field this route does not take" }, 400);
    let scopeIn = body.scope;
    let partKey: { env: string; part: string } | undefined;
    if (body.env !== undefined || body.part !== undefined) {
      if (typeof body.env !== "string" || typeof body.part !== "string") return c.json({ error: "invalid", field: "part", message: "env and part must both be given, as strings" }, 400);
      const part = (await listAllParts(ctx)).find((x) => x.env === body.env && x.key === body.part && x.provider === p.id);
      if (!part) return c.json({ error: "not_found", message: `no such ${p.label} part` }, 404);
      partKey = { env: part.env, part: part.key };
      if (p.credentialScope === "environment") {
        if (scopeIn !== undefined && scopeIn !== part.env) return c.json({ error: "invalid", field: "scope", message: "scope must be the part's environment" }, 400);
        scopeIn = part.env;
      }
    }
    const scope = checkScope(p, scopeIn);
    const result = await testConnection(ctx, c.env, HOSTING_INTEGRATION_KIND[p.id], scope, originOf(c), Date.now(), o.fetchImpl, partKey);
    const out: HostingTestDTO = { ok: result.ok, detail: result.detail, connection: await connectionDTO(ctx, c.env, p.id, scope, providers) };
    return c.json(out);
  }));

  return r;
}

/** `GET /hosting/:provider/callback`, mounted at `/hosting` on the app root (behind `sessionGate` only). */
export function makeHostingCallbackApp(o: HostingRouteOptions = {}): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use("*", personOnly);
  r.get("/:provider/callback", async (c) => {
    const provider = c.req.param("provider");
    let location = "/#org/hosting?connect_error=failed";
    try {
      const out = await completeConnect(c.env, {
        handle: c.get("principal").handle, provider, query: c.req.query(), cookieNonce: getCookie(c, CONNECT_COOKIE) ?? null,
        origin: originOf(c), fetchImpl: o.fetchImpl, providers: o.providers,
      });
      location = out.location;
    } catch (e) {
      console.error("hosting callback failed", e instanceof Error ? e.name : "error");
    }
    // The nonce is single use: cleared whatever the outcome.
    if (isHostingProvider(provider)) deleteCookie(c, CONNECT_COOKIE, { path: connectCookiePath(provider), secure: true, httpOnly: true, sameSite: "Lax" });
    c.header("cache-control", "no-store");
    c.header("referrer-policy", "no-referrer"); // the callback URL carried a code
    return c.redirect(location, 302);
  });
  return r;
}

export const hostingApp = makeHostingApp();
export const hostingCallbackApp = makeHostingCallbackApp();

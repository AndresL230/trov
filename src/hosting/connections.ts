// How an org is CONNECTED to each hosting provider (#97): the connection list Org settings › Hosting shows,
// the install / OAuth round trip, Disconnect from Trov, and the provider-side revocation.
//
//   the credential   always an `org_secrets` row (src/data/secrets.ts — write-only, encrypted, audited), under
//                    the provider's kind (`HOSTING_INTEGRATION_KIND`) and scope ("" — or the environment key for
//                    Railway's per-environment project token). A pasted token is ONLY that row.
//   the connection   `org_hosting_connections` (0043): what an install / OAuth grant adds beside the secret —
//                    the method, the provider-side installation id (`external_id`, what an uninstall notice
//                    names), the account it reaches, and how it ended (`revoked_*`).
//
// The round trip: `startConnect` seals `{ org, slug, provider, person, nonce, exp }` with HMAC (key
// `hosting-connect:<COOKIE_SECRET>`) as the provider's `state`, and the route sets the nonce in a short-lived
// HttpOnly cookie (path `/hosting/<provider>/`), so the callback is bound to the BROWSER that started it as well
// as to the person. `completeConnect` checks all of it, re-checks the person's ADMIN membership of that org
// live, exchanges the code through the provider's fixed-host fetch, stores the token as the org's secret and
// the grant's non-secret config beside it, and answers a redirect to the SPA with a FIXED code — never the
// provider's own words, which stay in a scrubbed log line.
//
// Nothing here returns, logs or audits a credential: every message that could quote an upstream is scrubbed
// of the token, the code and the client secret BEFORE it is cut. This module reaches src/data/secrets.ts, so
// nothing reachable from src/mcp.ts may import it (test/secrets.mcp.test.ts).
import {
  HOSTING_INTEGRATION_KIND, HOSTING_PROVIDERS, isHostingProvider, providerOfKind,
  type ConnectStartDTO, type ConnectionMethod, type ConnectionStatus, type HostingConnectionDTO, type HostingProviderId,
} from "@shared/hosting";
import type { IntegrationKind, OrgSettingsAuditAction } from "@shared/integrations";
import { b64uDecode, b64uEncode, hmacSeal, hmacUnseal, randomToken } from "../auth/crypto";
import { hasRole, requireRole, resolveTenantById } from "../data/context";
import {
  SecretConflictError, SecretsUnavailableError, getIntegrationConfig, getSecret, getSecretMeta, hasLegacyCredential,
  listIntegrationConfig, listSecretMeta, rotateSecret, secretDeleteStmts, secretValueProblem, setIntegrationConfig, setSecret,
  systemRevocationDeleteStmts, type SecretMeta,
} from "../data/secrets";
import { all, batch, first, nowIso, stmt, type Stmt, type TenantContext } from "../data/sql";
import type { Env } from "../env";
import { SettingsError, listEnvironments } from "../integrations/settings";
import { asHostingError, hostFetch, scrub } from "./http";
import { listAllParts, type PartRow } from "./parts";
import type { ProviderMap } from "./part-writes";
import { PROVIDERS, checkFields } from "./registry";
import type { ConnectionMethodSpec, HostingProvider, InstallGrant } from "./types";

// ── the connection list ──────────────────────────────────────────────────────

export interface ConnectionRow {
  provider: string;
  scope: string;
  method: ConnectionMethod;
  external_id: string | null;
  account_id: string | null;
  account_label: string | null;
  status: "active" | "revoked";
  connected_by: string;
  connected_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
  revoked_reason: string | null;
}
const CONNECTION_COLS = `provider, scope, method, external_id, account_id, account_label, status, connected_by, connected_at, revoked_at, revoked_by, revoked_reason`;

const listConnectionRows = (ctx: TenantContext): Promise<ConnectionRow[]> =>
  all<ConnectionRow>(ctx, `SELECT ${CONNECTION_COLS} FROM org_hosting_connections WHERE org_id = ? ORDER BY provider, scope`, ctx.orgId);

const connectionRow = (ctx: TenantContext, provider: HostingProviderId, scope: string): Promise<ConnectionRow | null> =>
  first<ConnectionRow>(ctx, `SELECT ${CONNECTION_COLS} FROM org_hosting_connections WHERE org_id = ? AND provider = ? AND scope = ?`, ctx.orgId, provider, scope);

/** The credential scope a part of provider `p` uses: "" for an org-wide credential, the environment key for Railway's. */
export const credentialScopeOf = (p: Pick<HostingProvider, "credentialScope">, part: Pick<PartRow, "env">): string =>
  p.credentialScope === "environment" ? part.env : "";

/** Everything a connection DTO is built from, read once for a whole list. */
export interface ConnectionState {
  parts: PartRow[];
  secrets: SecretMeta[];
  rows: ConnectionRow[];
  configs: { kind: string; scope: string; config: Record<string, string> }[];
  envLabels: Map<string, string>;
  envOrder: Map<string, number>;
}

export async function loadConnectionState(ctx: TenantContext): Promise<ConnectionState> {
  const [parts, secrets, rows, configs, envs] = [
    await listAllParts(ctx), await listSecretMeta(ctx), await listConnectionRows(ctx), await listIntegrationConfig(ctx), await listEnvironments(ctx),
  ];
  return {
    parts, secrets, rows, configs,
    envLabels: new Map(envs.map((e) => [e.key, e.label])),
    envOrder: new Map(envs.map((e) => [e.key, e.position])),
  };
}

/** A connection's status, from the secret and the connection row (the rule the DTO documents). */
export function connectionStatusOf(meta: SecretMeta | null, row: ConnectionRow | null): ConnectionStatus {
  if (meta) return meta.last_error ? "error" : "connected";
  return row?.status === "revoked" ? "revoked" : "not_connected";
}

export async function describeConnection(
  ctx: TenantContext, env: Env, s: ConnectionState, provider: HostingProvider, scope: string,
): Promise<HostingConnectionDTO> {
  const kind = HOSTING_INTEGRATION_KIND[provider.id];
  const meta = s.secrets.find((m) => m.kind === kind && m.scope === scope) ?? null;
  const row = s.rows.find((r) => r.provider === provider.id && r.scope === scope) ?? null;
  const status = connectionStatusOf(meta, row);
  // The row describes the CURRENT credential only while it is active and the secret is there; a revoked row
  // describes how the last install ended, shown while nothing replaced it.
  const live = row !== null && row.status === "active" && meta !== null;
  const ended = row !== null && row.status === "revoked" && meta === null;
  return {
    provider: provider.id,
    scope,
    scope_label: scope ? s.envLabels.get(scope) ?? null : null,
    status,
    method: meta ? (live ? row!.method : "token") : null,
    account: live || ended ? { id: row!.account_id, label: row!.account_label } : null,
    external_id: live || ended ? row!.external_id : null,
    config: s.configs.find((c) => c.kind === kind && c.scope === scope)?.config ?? {},
    hint_last4: meta?.hint_last4 ?? "",
    connected_by: live ? row!.connected_by : meta?.created_by ?? null,
    connected_at: live ? row!.connected_at : meta?.created_at ?? null,
    last_used_at: meta?.last_used_at ?? null,
    last_error: meta?.last_error ?? null,
    legacy_fallback: meta === null && (await hasLegacyCredential(ctx, env, kind, scope)),
    revoked_reason: status === "revoked" ? row?.revoked_reason ?? null : null,
    used_by: s.parts.filter((p) => p.provider === provider.id && credentialScopeOf(provider, p) === scope).map((p) => ({ env: p.env, part: p.key })),
  };
}

/**
 * `HostingSetupDTO.connections`: one row per (provider, scope) a part USES, plus every provider the org holds
 * a credential or a connection row for (an unused one can be disconnected without breaking anything). In
 * picker order, an org-wide scope before the environments in drift order.
 */
export async function listConnections(ctx: TenantContext, env: Env, providers: ProviderMap = PROVIDERS, state?: ConnectionState): Promise<HostingConnectionDTO[]> {
  const s = state ?? (await loadConnectionState(ctx));
  const keys = new Map<string, { provider: HostingProviderId; scope: string }>();
  const add = (provider: HostingProviderId, scope: string) => keys.set(`${provider}\u0000${scope}`, { provider, scope });
  for (const p of s.parts) add(p.provider, credentialScopeOf(providers[p.provider], p));
  for (const m of s.secrets) {
    const provider = providerOfKind(m.kind);
    if (provider) add(provider, m.scope);
  }
  for (const r of s.rows) if (isHostingProvider(r.provider)) add(r.provider, r.scope);
  const order = (k: { provider: HostingProviderId; scope: string }): [number, number, string] =>
    [HOSTING_PROVIDERS.indexOf(k.provider), k.scope === "" ? -1 : s.envOrder.get(k.scope) ?? Number.MAX_SAFE_INTEGER, k.scope];
  const sorted = [...keys.values()].sort((a, b) => {
    const [pa, ea, sa] = order(a), [pb, eb, sb] = order(b);
    return pa - pb || ea - eb || (sa < sb ? -1 : sa > sb ? 1 : 0);
  });
  const out: HostingConnectionDTO[] = [];
  for (const k of sorted) out.push(await describeConnection(ctx, env, s, providers[k.provider], k.scope));
  return out;
}

/** One connection's DTO (what a disconnect / test answers with) — also for a (provider, scope) no part uses. */
export async function connectionDTO(ctx: TenantContext, env: Env, provider: HostingProviderId, scope: string, providers: ProviderMap = PROVIDERS): Promise<HostingConnectionDTO> {
  return await describeConnection(ctx, env, await loadConnectionState(ctx), providers[provider], scope);
}

// ── shared helpers ───────────────────────────────────────────────────────────

const auditStmt = (ctx: TenantContext, action: OrgSettingsAuditAction, target: string, detail: Record<string, unknown>, at: string): Stmt =>
  stmt(ctx, `INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at) VALUES (?, ?, ?, ?, ?, ?)`,
    ctx.orgId, ctx.userId, action, target, JSON.stringify(detail), at);

/** A Worker var's value when set (non-empty string), else null. Names only are ever logged — never a value. */
const varOf = (env: unknown, name: string): string | null => {
  const v = (env as Record<string, unknown> | null | undefined)?.[name];
  return typeof v === "string" && v.length > 0 ? v : null;
};

/** A short, single-line, non-secret value from a provider (an account name, an installation id), or null. */
const cleanText = (v: unknown, max = 200): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
  return t || null;
};

/** The provider, or a 404 for an id Trov does not know. */
function knownProvider(providers: ProviderMap, id: string): HostingProvider {
  if (!isHostingProvider(id) || !providers[id]) throw new SettingsError("not_found", 404, "no such hosting provider");
  return providers[id];
}

/** The scope a request names, checked against the provider's credential scope (org-wide: ""; Railway: an environment key). */
export function checkScope(p: HostingProvider, scope: unknown): string {
  const s = scope === undefined || scope === null ? "" : scope;
  if (typeof s !== "string") throw new SettingsError("invalid", 400, "scope must be a string", "scope");
  if (p.credentialScope === "org" && s !== "") throw new SettingsError("invalid", 400, `${p.label} is connected once for the whole org: its scope is ""`, "scope");
  if (p.credentialScope === "environment" && !/^[a-z0-9_-]{1,32}$/.test(s)) throw new SettingsError("invalid", 400, `${p.label} is connected per environment: scope must be an environment key`, "scope");
  return s;
}

interface InstallChoice { spec: ConnectionMethodSpec & { method: "install" | "oauth" }; clientId: string; clientSecret: string; vars: Record<string, string> }

/**
 * The connection method `startConnect` / `completeConnect` use: the provider's FIRST install / OAuth method
 * this deployment can offer — every var in its `requires`, and the integration's client id and secret, set.
 * `vars` is the `requires` values for `authorizeUrl` (an integration's slug), the client SECRET never among them.
 */
function installChoice(p: HostingProvider, env: unknown): InstallChoice | null {
  if (!p.install) return null;
  for (const m of p.connectionMethods) {
    if (m.method !== "install" && m.method !== "oauth") continue;
    if ((m.requires ?? []).some((name) => varOf(env, name) === null)) continue;
    const clientId = varOf(env, p.install.clientIdVar);
    const clientSecret = varOf(env, p.install.clientSecretVar);
    if (!clientId || !clientSecret) continue;
    const vars: Record<string, string> = {};
    for (const name of m.requires ?? []) if (name !== p.install.clientSecretVar) vars[name] = varOf(env, name)!;
    return { spec: m as InstallChoice["spec"], clientId, clientSecret, vars };
  }
  return null;
}

// ── the install / OAuth round trip ───────────────────────────────────────────

export const CONNECT_TTL_MS = 10 * 60_000;
/** The nonce cookie: per provider (its path), so two connects in two tabs do not clobber each other. */
export const CONNECT_COOKIE = "trov_hx";
export const connectCookiePath = (provider: string): string => `/hosting/${provider}/`;
const stateKey = (env: Pick<Env, "COOKIE_SECRET">): string => `hosting-connect:${env.COOKIE_SECRET}`;
/** Trov's callback for a provider — what is registered as the integration's redirect URL. */
export const connectRedirectUri = (origin: string, provider: HostingProviderId): string => `${origin.replace(/\/+$/, "")}/hosting/${provider}/callback`;

interface ConnectState { o: string; s: string | null; p: string; h: string; n: string; exp: number }

function parseState(json: string): ConnectState | null {
  try {
    const v = JSON.parse(json) as Record<string, unknown>;
    if (!v || typeof v !== "object") return null;
    if (typeof v.o !== "string" || typeof v.p !== "string" || typeof v.h !== "string" || typeof v.n !== "string" || typeof v.exp !== "number") return null;
    if (v.s !== null && typeof v.s !== "string") return null;
    return { o: v.o, s: v.s as string | null, p: v.p, h: v.h, n: v.n, exp: v.exp };
  } catch {
    return null;
  }
}

const sameText = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};

export interface ConnectStart { start: ConnectStartDTO; nonce: string }

/**
 * Begin an install / OAuth connection (admin+). Refusals (409, fixed text): a provider not supported yet, one
 * with no install / OAuth method (paste a token instead), a credential kept per environment, or a deployment
 * that has not configured the provider's integration (its client id / secret / required vars). Returns where to
 * send the browser and the nonce the route sets in the `trov_hx` cookie.
 */
export async function startConnect(
  ctx: TenantContext, env: Env, providerId: string, origin: string, orgSlug: string | null, now: number = Date.now(), providers: ProviderMap = PROVIDERS,
): Promise<ConnectStart> {
  requireRole(ctx, "admin");
  const p = knownProvider(providers, providerId);
  if (p.status !== "available") throw new SettingsError("not_available", 409, `${p.label} is not supported yet`);
  if (!p.install || !p.connectionMethods.some((m) => m.method === "install" || m.method === "oauth")) {
    throw new SettingsError("not_installable", 409, `${p.label} has no install or OAuth connection — paste a token instead`);
  }
  if (p.credentialScope !== "org") throw new SettingsError("not_installable", 409, `${p.label} is connected per environment — paste a token instead`);
  const choice = installChoice(p, env);
  if (!choice) throw new SettingsError("not_configured", 409, `this Trov deployment has no ${p.label} integration configured — paste a token instead`);
  const nonce = randomToken(16);
  const exp = now + CONNECT_TTL_MS;
  const payload: ConnectState = { o: ctx.orgId, s: orgSlug, p: p.id, h: ctx.userId, n: nonce, exp };
  const state = await hmacSeal(b64uEncode(JSON.stringify(payload)), stateKey(env));
  const url = p.install.authorizeUrl({ clientId: choice.clientId, redirectUri: connectRedirectUri(origin, p.id), state, vars: choice.vars });
  return { start: { url, method: choice.spec.method, expires_at: new Date(exp).toISOString() }, nonce };
}

/** The fixed codes a callback redirects with — the SPA words each one; nothing from the provider ever rides along. */
export type ConnectErrorCode =
  | "unknown_provider" | "mismatch" | "expired" | "denied" | "forbidden" | "not_configured" | "exchange_failed" | "secrets_unavailable" | "failed";

export interface ConnectCallback {
  /** The signed-in person (the session's principal). */
  handle: string;
  /** The callback path's provider segment. */
  provider: string;
  query: Readonly<Record<string, string>>;
  /** The `trov_hx` cookie's value, or null. */
  cookieNonce: string | null;
  origin: string;
  now?: number;
  fetchImpl?: typeof fetch;
  providers?: ProviderMap;
}

export interface ConnectOutcome { location: string; ok: boolean; error: ConnectErrorCode | null }

const hostingLocation = (slug: string | null, query: string): string =>
  `${slug ? `/o/${encodeURIComponent(slug)}/` : "/"}#org/hosting?${query}`;

/**
 * `GET /hosting/:provider/callback` — finish an install / OAuth connection. Never throws: every outcome is a
 * redirect to Org settings › Hosting, `?connected=<provider>` or `?connect_error=<fixed code>`.
 */
export async function completeConnect(env: Env, cb: ConnectCallback): Promise<ConnectOutcome> {
  const providers = cb.providers ?? PROVIDERS;
  const now = cb.now ?? Date.now();
  let slug: string | null = null;
  const fail = (error: ConnectErrorCode): ConnectOutcome => ({ location: hostingLocation(slug, `connect_error=${error}`), ok: false, error });

  if (!isHostingProvider(cb.provider) || !providers[cb.provider]?.install) return fail("unknown_provider");
  const p = providers[cb.provider];
  const install = p.install!;

  // The state: sealed by us, for this provider, still fresh, from THIS browser, for THIS person.
  const sealed = cb.query.state ?? "";
  const opened = sealed ? await hmacUnseal(sealed, stateKey(env)) : null;
  let decoded: string | null = null;
  try { decoded = opened === null ? null : b64uDecode(opened); } catch { decoded = null; }
  const st = decoded === null ? null : parseState(decoded);
  if (!st) return fail("mismatch");
  slug = st.s;
  if (st.p !== p.id) return fail("mismatch");
  if (st.exp <= now) return fail("expired");
  if (!cb.cookieNonce || !sameText(cb.cookieNonce, st.n)) return fail("mismatch");
  if (st.h.toLowerCase() !== cb.handle.toLowerCase()) return fail("mismatch");
  if (cb.query.error) return fail("denied"); // the person declined on the provider's page

  try {
    // Admin of that org NOW — a membership or role lost since the start does not survive the round trip.
    const ctx = await resolveTenantById(env, cb.handle, st.o, "session");
    if (!ctx || !hasRole(ctx, "admin")) return fail("forbidden");
    const code = cb.query.code;
    if (!code) return fail("mismatch");
    const choice = installChoice(p, env);
    if (!choice) return fail("not_configured");

    const redirectUri = connectRedirectUri(cb.origin, p.id);
    let grant: InstallGrant;
    try {
      grant = await install.exchange({
        fetch: hostFetch(p.apiHosts, cb.fetchImpl ?? ((input, init) => fetch(input, init))),
        code, clientId: choice.clientId, clientSecret: choice.clientSecret, redirectUri, query: { ...cb.query },
      });
    } catch (e) {
      // A HostingError is scrubbed by the provider; anything else is replaced by fixed words. Scrubbed again
      // here of what THIS side revealed, then cut — never the Error object itself.
      const msg = scrub(asHostingError(`${p.id} install`, e).message, [choice.clientSecret, code]).slice(0, 300);
      console.error("hosting connect: exchange failed", p.id, `org=${st.o}`, msg);
      return fail("exchange_failed");
    }
    const token = grant?.accessToken;
    if (typeof token !== "string" || secretValueProblem(HOSTING_INTEGRATION_KIND[p.id], token) !== null) {
      console.error("hosting connect: the exchange returned no usable token", p.id, `org=${st.o}`);
      return fail("exchange_failed");
    }

    const kind = HOSTING_INTEGRATION_KIND[p.id];
    // The credential: stored, or replacing whatever was there (a pasted token, a previous install).
    if (await getSecretMeta(ctx, kind, "")) await rotateSecret(ctx, kind, "", token);
    else {
      try { await setSecret(ctx, kind, "", token); } catch (e) {
        if (!(e instanceof SecretConflictError)) throw e;
        await rotateSecret(ctx, kind, "", token); // lost a race with another write
      }
    }
    await mergeGrantConfig(ctx, p, kind, grant.config);

    const at = nowIso();
    const accountLabel = cleanText(grant.accountLabel);
    await batch(ctx, [
      stmt(ctx, `INSERT INTO org_hosting_connections (org_id, provider, scope, method, external_id, account_id, account_label, status, connected_by, connected_at)
                 VALUES (?, ?, '', ?, ?, ?, ?, 'active', ?, ?)
                 ON CONFLICT(org_id, provider, scope) DO UPDATE SET method = excluded.method, external_id = excluded.external_id,
                   account_id = excluded.account_id, account_label = excluded.account_label, status = 'active', connected_by = excluded.connected_by,
                   connected_at = excluded.connected_at, revoked_at = NULL, revoked_by = NULL, revoked_reason = NULL`,
        ctx.orgId, p.id, choice.spec.method, cleanText(grant.externalId), cleanText(grant.accountId), accountLabel, ctx.userId, at),
      auditStmt(ctx, "hosting.connect", p.id, { provider: p.id, method: choice.spec.method, account: accountLabel }, at),
    ]);
    // OWNER CHECK: Vercel's callback also carries `next`, and an install may need the browser sent there to be
    // finalised (UNCONFIRMED, research doc › Vercel) — it is deliberately NOT followed; the whole query still
    // reached `exchange` above.
    return { location: hostingLocation(slug, `connected=${p.id}`), ok: true, error: null };
  } catch (e) {
    if (e instanceof SecretsUnavailableError) return fail("secrets_unavailable");
    console.error("hosting connect failed", p.id, `org=${st.o}`, e instanceof Error ? e.name : "error"); // the name only — never the Error
    return fail("failed");
  }
}

/** Merge what the grant taught (a team id) into the org's config for the provider: only the provider's own
 *  fields, each checked against its pattern; a refused value is dropped and logged by KEY. */
async function mergeGrantConfig(ctx: TenantContext, p: HostingProvider, kind: IntegrationKind, given: unknown): Promise<void> {
  if (!given || typeof given !== "object" || Array.isArray(given)) return;
  const known = new Set(p.orgConfigFields.map((f) => f.key));
  const fromGrant = Object.fromEntries(Object.entries(given as Record<string, unknown>).filter(([k]) => known.has(k)));
  if (Object.keys(fromGrant).length === 0) return;
  const current = await getIntegrationConfig(ctx, kind, "");
  // `required` is not this merge's question (an admin may still have to fill a field the grant did not carry).
  const checked = checkFields(p.orgConfigFields.map((f) => ({ ...f, required: false })), { ...current, ...fromGrant }, "config");
  if ("field" in checked) {
    console.error("hosting connect: a config value from the grant was refused", p.id, checked.field);
    return;
  }
  const next = checked.values;
  const same = Object.keys(next).length === Object.keys(current).length && Object.keys(next).every((k) => next[k] === current[k]);
  if (!same) await setIntegrationConfig(ctx, kind, "", next);
}

// ── disconnect ───────────────────────────────────────────────────────────────

export interface DisconnectResult { connection: HostingConnectionDTO; upstream: "revoked" | "failed" | "none" }

/**
 * Disconnect a provider from Trov's side (admin+): an install / OAuth connection is first removed on the
 * provider's side when its spec can (`install.revoke` — best effort: a failure is logged, scrubbed, and does
 * not stop the disconnect), then the secret is deleted and the connection row marked revoked, audited, ONE
 * batch. A token connection just loses its secret. Nothing to disconnect → 404.
 */
export async function disconnect(
  ctx: TenantContext, env: Env, providerId: string, scopeIn: unknown, fetchImpl?: typeof fetch, providers: ProviderMap = PROVIDERS,
): Promise<DisconnectResult> {
  requireRole(ctx, "admin");
  const p = knownProvider(providers, providerId);
  const scope = checkScope(p, scopeIn);
  const kind = HOSTING_INTEGRATION_KIND[p.id];
  const [meta, row] = [await getSecretMeta(ctx, kind, scope), await connectionRow(ctx, p.id, scope)];
  const active = row?.status === "active" ? row : null;
  if (!meta && !active) throw new SettingsError("not_connected", 404, `${p.label} is not connected`);

  let upstream: DisconnectResult["upstream"] = "none";
  if (meta && active && (active.method === "install" || active.method === "oauth") && p.install?.revoke) {
    let secret = null;
    try {
      secret = await getSecret(ctx, kind, scope);
      if (secret) {
        await p.install.revoke({
          fetch: hostFetch(p.apiHosts, fetchImpl ?? ((input, init) => fetch(input, init))),
          secret, externalId: active.external_id, config: await getIntegrationConfig(ctx, kind, scope),
        });
        upstream = "revoked";
      }
    } catch (e) {
      upstream = "failed";
      console.error("hosting disconnect: the provider-side removal failed", p.id, `org=${ctx.orgId}`, scrub(asHostingError(`${p.id} revoke`, e).message, secret).slice(0, 300));
    }
  }

  const at = nowIso();
  await batch(ctx, [
    ...(await secretDeleteStmts(ctx, [{ kind, scope }], "disconnected", at)),
    ...(active ? [stmt(ctx, `UPDATE org_hosting_connections SET status = 'revoked', revoked_at = ?, revoked_by = ?, revoked_reason = ?
                             WHERE org_id = ? AND provider = ? AND scope = ? AND status = 'active'`,
      at, ctx.userId, "disconnected in Trov", ctx.orgId, p.id, scope)] : []),
    auditStmt(ctx, "hosting.disconnect", p.id, { provider: p.id, ...(scope ? { scope } : {}), method: active?.method ?? "token", upstream }, at),
  ]);
  return { connection: await connectionDTO(ctx, env, p.id, scope, providers), upstream };
}

/**
 * An Integrations-page write to a hosting provider's credential (src/integrations/routes.ts — a pasted token
 * over an installed one, a set, a delete) means the install / OAuth row no longer describes the secret: it is
 * marked revoked (no provider-side call — that is Disconnect's), audited. Without this, a later "uninstalled"
 * notice for the OLD installation would delete the credential that replaced it. A no-op otherwise.
 */
export async function supersedeConnection(ctx: TenantContext, kind: IntegrationKind, scope: string, reason: string): Promise<void> {
  const provider = providerOfKind(kind);
  if (!provider) return;
  const row = await connectionRow(ctx, provider, scope);
  if (!row || row.status !== "active") return;
  const at = nowIso();
  await batch(ctx, [
    stmt(ctx, `UPDATE org_hosting_connections SET status = 'revoked', revoked_at = ?, revoked_by = ?, revoked_reason = ?
               WHERE org_id = ? AND provider = ? AND scope = ? AND status = 'active'`, at, ctx.userId, reason, ctx.orgId, provider, scope),
    auditStmt(ctx, "hosting.disconnect", provider, { provider, ...(scope ? { scope } : {}), method: row.method, upstream: "none", reason }, at),
  ]);
}

// ── provider-side revocation (src/hosting/webhook.ts) ────────────────────────

/**
 * A provider's VERIFIED "uninstalled" notice, for ONE org that holds that installation: as the org's SYSTEM
 * tenant, delete the credential it granted and mark the connection revoked (`revoked_by` = the provider id,
 * "removed on <Label>"), audited `hosting.revoked` — one batch. Re-reads the row first: a connection that was
 * replaced since the lookup (another install, a pasted token) is left alone. Returns whether it revoked.
 */
export async function revokeFromProviderSide(ctx: TenantContext, provider: HostingProvider, scope: string, externalId: string): Promise<boolean> {
  const row = await connectionRow(ctx, provider.id, scope);
  if (!row || row.status !== "active" || row.external_id !== externalId) return false;
  const kind = HOSTING_INTEGRATION_KIND[provider.id];
  const reason = `removed on ${provider.label}`;
  const at = nowIso();
  await batch(ctx, [
    ...(await systemRevocationDeleteStmts(ctx, kind, scope, reason, at)),
    stmt(ctx, `UPDATE org_hosting_connections SET status = 'revoked', revoked_at = ?, revoked_by = ?, revoked_reason = ?
               WHERE org_id = ? AND provider = ? AND scope = ? AND status = 'active' AND external_id = ?`,
      at, provider.id, reason, ctx.orgId, provider.id, scope, externalId),
    auditStmt(ctx, "hosting.revoked", provider.id, { provider: provider.id, ...(scope ? { scope } : {}), method: row.method, reason }, at),
  ]);
  return true;
}

// How an org is CONNECTED to each hosting provider (#97): the connection list Org settings › Hosting shows,
// the install / OAuth round trip, Disconnect from Trov, and the provider-side revocation.
//
//   the credential   always an `org_secrets` row (src/data/secrets.ts — write-only, encrypted, audited), under
//                    the provider's kind (`HOSTING_INTEGRATION_KIND`) and scope ("" — or the environment key for
//                    Railway's per-environment project token). A pasted token is ONLY that row.
//   the connection   `org_hosting_connections` (0047): what an install / OAuth grant adds beside the secret —
//                    the method, the provider-side installation id (`external_id`, what an uninstall notice
//                    names), the account it reaches, and how it ended (`revoked_*`).
//
// The round trip has the GitHub App binding's guarantees (src/github-app/connect.ts; issue #97: "an installed
// connection is bound to one Trov org, verified against the signed-in admin the same way the GitHub App binding
// is, and can be disconnected from either side"):
//   - the provider sees only a RANDOM `state`; what it answers for — `{ org, slug, provider, person, state, exp }` —
//     is HMAC-sealed (key `hosting-connect:<COOKIE_SECRET>`) in the HttpOnly `trov_hx` cookie, Path `/hosting/`,
//     10 minutes, spent by the first callback;
//   - `completeConnect` binds only for that browser, that provider, that person — still an admin of that org,
//     re-checked live — and only an installation no OTHER org holds (`taken`; 0047's partial unique index
//     enforces it at the write, which is ONE batch with the credential). An org holds ONE install / OAuth
//     connection per provider: a DIFFERENT one REPLACES it (the GitHub App's rule, src/github-app/connect.ts
//     step 6) in the same batch — no Disconnect first — and the replaced grant is then removed on the
//     provider's side, best effort, as Disconnect would have; a pasted token is superseded the same way;
//   - the installation id comes from the provider's own answer, never from the callback URL (./providers/*);
//   - a grant it refuses is handed back to the provider, best effort — never an installation another org holds;
//   - every outcome is a redirect with a FIXED code (`HOSTING_CONNECT_OUTCOMES`) — never the provider's own
//     words, which stay in a scrubbed log line — and nobody signed in lands on `/`.
// Disconnecting from either side: Disconnect here (the provider-side removal first, best effort), the
// provider's verified uninstall notice (./webhook.ts), or a 401 at Test connection (src/integrations/probe.ts)
// — the last two end the connection as the org's SYSTEM tenant (`endConnectionAsSystem`).
//
// Nothing here returns, logs or audits a credential: every message that could quote an upstream is scrubbed
// of the token, the code and the client secret BEFORE it is cut. This module reaches src/data/secrets.ts, so
// nothing reachable from src/mcp.ts may import it (test/secrets.mcp.test.ts).
import {
  HOSTING_INTEGRATION_KIND, HOSTING_PROVIDERS, hostingRevokedReasonText, isHostingProvider, isHostingRevokedReason, providerOfKind,
  type ConnectStartDTO, type ConnectionMethod, type ConnectionStatus, type HostingConnectOutcome, type HostingConnectionDTO,
  type HostingProviderId, type HostingRevokedReason,
} from "@shared/hosting";
import type { IntegrationKind, OrgSettingsAuditAction } from "@shared/integrations";
import { b64uDecode, b64uEncode, hmacSeal, hmacUnseal, randomToken } from "../auth/crypto";
import { hasRole, platform, requireRole, resolveTenantById } from "../data/context";
import {
  SecretsUnavailableError, getIntegrationConfig, getSecret, getSecretMeta, hasLegacyCredential,
  listIntegrationConfig, listSecretMeta, secretDeleteStmts, secretPutStmts, secretValueProblem,
  systemRevocationDeleteStmts, type SecretMeta,
} from "../data/secrets";
import { all, batch, first, nowIso, stmt, type Stmt, type TenantContext } from "../data/sql";
import type { Env } from "../env";
import { SettingsError, listEnvironments } from "../integrations/settings";
import { connectionsForExternalId, jobTenant } from "../platform/jobs";
import { asHostingError, hostFetch, scrub, type HostFetch } from "./http";
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
  revoked_reason: HostingRevokedReason | null;
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
  const config = s.configs.find((c) => c.kind === kind && c.scope === scope)?.config ?? {};
  // Where the grant is managed on the provider: for the current method, or — when the last install ended —
  // the one it was made by (the grant may still be listed there).
  const method: ConnectionMethod | null = meta ? (live ? row!.method : "token") : ended ? row!.method : null;
  return {
    provider: provider.id,
    scope,
    scope_label: scope ? s.envLabels.get(scope) ?? null : null,
    status,
    method: meta ? method : null,
    account: live || ended ? { id: row!.account_id, label: row!.account_label } : null,
    external_id: live || ended ? row!.external_id : null,
    config,
    hint_last4: meta?.hint_last4 ?? "",
    connected_by: live ? row!.connected_by : meta?.created_by ?? null,
    connected_at: live ? row!.connected_at : meta?.created_at ?? null,
    last_used_at: meta?.last_used_at ?? null,
    last_error: meta?.last_error ?? null,
    legacy_fallback: meta === null && (await hasLegacyCredential(ctx, env, kind, scope)),
    revoked_reason: status === "revoked" && isHostingRevokedReason(row?.revoked_reason) ? hostingRevokedReasonText(row!.revoked_reason!, provider.label) : null,
    manage_url: method ? manageUrlOf(provider, config, method) : null,
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

/** `HostingProvider.manageUrl`, kept to an https URL (a provider is code, but the contract is cheap to hold). */
function manageUrlOf(p: HostingProvider, config: Readonly<Record<string, string>>, method: ConnectionMethod): string | null {
  try {
    const url = p.manageUrl?.(config, method) ?? null;
    return url && new URL(url).protocol === "https:" ? url : null;
  } catch { return null; }
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
//
// The GitHub App's shape (src/github-app/connect.ts): the provider is handed a RANDOM `state` and nothing else
// of Trov's — never the org id, its slug or the person's handle. What the state answers for is sealed (HMAC, key
// `hosting-connect:<COOKIE_SECRET>`) in the HttpOnly `trov_hx` cookie: `{ o: org id, s: slug, p: provider,
// h: handle, state, exp }`, Path `/hosting/` (every provider's callback), 10 minutes, spent by the first callback
// whatever its outcome. So a return binds only for the browser that started it, for that org and that person.

export const CONNECT_TTL_MS = 10 * 60_000;
export const CONNECT_COOKIE = "trov_hx";
/** One path for every provider's callback: a second connect (another provider, another tab) replaces the first. */
export const CONNECT_COOKIE_PATH = "/hosting/";
const sealKey = (env: Pick<Env, "COOKIE_SECRET">): string => `hosting-connect:${env.COOKIE_SECRET}`;
/** Trov's callback for a provider — what is registered as the integration's redirect URL. */
export const connectRedirectUri = (origin: string, provider: HostingProviderId): string => `${origin.replace(/\/+$/, "")}/hosting/${provider}/callback`;

/** The sealed intent: what the random `state` answers for. */
interface ConnectIntent { o: string; s: string | null; p: string; h: string; state: string; exp: number }

const sealIntent = (i: ConnectIntent, env: Pick<Env, "COOKIE_SECRET">): Promise<string> => hmacSeal(b64uEncode(JSON.stringify(i)), sealKey(env));

/** The intent a cookie carries, or null: absent, tampered, sealed with another key, or not the shape. Expiry
 *  is checked by the caller — an expired intent still names the org to send the person back to. */
async function openIntent(sealed: string | null, env: Pick<Env, "COOKIE_SECRET">): Promise<ConnectIntent | null> {
  const opened = sealed ? await hmacUnseal(sealed, sealKey(env)) : null;
  if (!opened) return null;
  try {
    const v = JSON.parse(b64uDecode(opened)) as Record<string, unknown> | null;
    if (!v || typeof v !== "object") return null;
    if (typeof v.o !== "string" || typeof v.p !== "string" || typeof v.h !== "string" || typeof v.state !== "string" || typeof v.exp !== "number") return null;
    if (v.s !== null && typeof v.s !== "string") return null;
    return { o: v.o, s: v.s as string | null, p: v.p, h: v.h, state: v.state, exp: v.exp };
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

/** An ACTIVE install / OAuth connection — what makes an org "already connected" (a pasted token never does). */
const isLiveInstall = (row: ConnectionRow | null): row is ConnectionRow =>
  row !== null && row.status === "active" && (row.method === "install" || row.method === "oauth");

/** Is a new grant the SAME installation the row describes (a re-authorization, an "update" return)? By the
 *  installation id when both have one, else by the provider-side account. */
const sameGrant = (row: ConnectionRow, externalId: string | null, accountId: string | null): boolean =>
  row.external_id && externalId ? row.external_id === externalId : !!row.account_id && !!accountId && row.account_id === accountId;

export interface ConnectStart {
  start: ConnectStartDTO;
  /** The sealed intent — the route sets it as the `trov_hx` cookie. */
  cookie: string;
}

/**
 * Begin an install / OAuth connection (admin+). Refusals (409, fixed text): a provider not supported yet, one
 * with no install / OAuth method (paste a token instead), a credential kept per environment, or a deployment
 * that has not configured the provider's integration. An org that is already connected — by a pasted token or
 * by another install / OAuth grant — is NOT refused: the new grant replaces it at the callback. Returns where to
 * send the browser and the sealed intent the route sets in the `trov_hx` cookie.
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
  const state = randomToken(16);
  const exp = now + CONNECT_TTL_MS;
  const cookie = await sealIntent({ o: ctx.orgId, s: orgSlug, p: p.id, h: ctx.userId, state, exp }, env);
  const url = p.install.authorizeUrl({ clientId: choice.clientId, redirectUri: connectRedirectUri(origin, p.id), state, vars: choice.vars });
  return { start: { url, method: choice.spec.method, expires_at: new Date(exp).toISOString() }, cookie };
}

export interface ConnectCallback {
  /** The person signed in NOW (the session cookie — never a bearer), or null. */
  handle: string | null;
  /** The callback path's provider segment. */
  provider: string;
  query: Readonly<Record<string, string>>;
  /** The `trov_hx` cookie's value (the sealed intent), or null. */
  cookie: string | null;
  origin: string;
  now?: number;
  fetchImpl?: typeof fetch;
  providers?: ProviderMap;
}

/** Where the callback sends the browser, and the outcome it carries (null: nobody was signed in). */
export interface ConnectOutcome { location: string; outcome: HostingConnectOutcome | null }

/**
 * The page a return lands on: Org settings of the org the intent named, with the outcome in the QUERY (the
 * hash is the SPA's route) — `/<slug>/?hosting=<outcome>&provider=<id>#org` (an org's address, `orgPath`); `/?hosting=<outcome>` when no
 * intent could be read. `#org` is Org settings' canonical hash (Integrations): there is no Hosting tab yet —
 * the UI that adds one can point this at it.
 */
export function connectReturnUrl(slug: string | null, outcome: HostingConnectOutcome, provider: HostingProviderId | null): string {
  if (!slug) return `/?hosting=${outcome}`;
  return `/${encodeURIComponent(slug)}/?hosting=${outcome}${provider ? `&provider=${provider}` : ""}#org`;
}

/**
 * `GET /hosting/:provider/callback` — finish an install / OAuth connection. Never throws, and every outcome is
 * a redirect (`connectReturnUrl`) with a FIXED code from `HOSTING_CONNECT_OUTCOMES`; nobody signed in → `/`.
 * An installation is bound only when ALL of these hold — a failure at any step writes nothing:
 *   1. our sealed intent is in this browser, for this provider, unexpired, and the provider handed back ITS state;
 *   2. the person signed in now is the person who started, and is still an admin of that org;
 *   3. the provider exchanges the code for a usable credential;
 *   4. the installation is no OTHER org's (`taken` — 0047's unique index says so again at the write).
 * A DIFFERENT live install / OAuth grant of this org is REPLACED, not refused (the GitHub App's rule): ended in
 * the same batch the new one is written in (`bindConnection`'s `replaced`), then removed on the provider's side
 * with its OWN credential, read before the write — best effort, as Disconnect does (`dropReplaced`).
 * A grant refused at 4 (or lost to an error after the exchange) is handed back to the provider, best effort
 * (`dropGrant`) — but an installation another org holds is never removed: only the new credential is.
 */
export async function completeConnect(env: Env, cb: ConnectCallback): Promise<ConnectOutcome> {
  const providers = cb.providers ?? PROVIDERS;
  const now = cb.now ?? Date.now();
  // Nobody signed in: the landing page. The return cannot be tied to a person, so it says nothing either.
  if (!cb.handle) return { location: "/", outcome: null };
  const handle = cb.handle;
  const intent = await openIntent(cb.cookie, env);
  const p = isHostingProvider(cb.provider) && providers[cb.provider]?.install ? providers[cb.provider] : null;
  const to = (outcome: HostingConnectOutcome): ConnectOutcome =>
    ({ location: connectReturnUrl(intent?.s ?? null, outcome, outcome === "unknown_provider" ? null : p?.id ?? null), outcome });

  if (!p) return to("unknown_provider");
  // 1 — our intent, for this provider, unexpired, and the state the provider handed back is the one sealed in it.
  const state = cb.query.state ?? "";
  if (!intent || intent.p !== p.id || !state || !sameText(state, intent.state) || intent.exp <= now) return to("expired");
  // 2 — the same person, then (below, live) still an admin of that org.
  if (intent.h.toLowerCase() !== handle.toLowerCase()) return to("wrong_person");
  if (cb.query.error) return to("denied"); // the person declined on the provider's page

  const install = p.install!;
  const hf = hostFetch(p.apiHosts, cb.fetchImpl ?? ((input, init) => fetch(input, init)));
  let grant: InstallGrant | null = null;
  // What a refusal after the exchange may remove on the provider's side: the installation itself only once it
  // is known to be nobody's (set below); until then, only the new credential.
  let removable: string | null = null;
  try {
    const ctx = await resolveTenantById(env, handle, intent.o, "session");
    if (!ctx || !hasRole(ctx, "admin")) return to("not_admin");
    const choice = installChoice(p, env);
    if (!choice) return to("not_configured");
    // 3 — the exchange.
    const code = cb.query.code;
    if (!code) return to("exchange_failed");
    try {
      grant = await install.exchange({
        fetch: hf, code, clientId: choice.clientId, clientSecret: choice.clientSecret, redirectUri: connectRedirectUri(cb.origin, p.id), query: { ...cb.query },
      });
    } catch (e) {
      // A HostingError is scrubbed by the provider; anything else is replaced by fixed words. Scrubbed again
      // here of what THIS side revealed, then cut — never the Error object itself.
      const msg = scrub(asHostingError(`${p.id} install`, e).message, [choice.clientSecret, code]).slice(0, 300);
      console.error("hosting connect: exchange failed", p.id, `org=${intent.o}`, msg);
      return to("exchange_failed");
    }
    const token = grant?.accessToken;
    if (typeof token !== "string" || secretValueProblem(HOSTING_INTEGRATION_KIND[p.id], token) !== null) {
      grant = null; // nothing usable to hand back either
      console.error("hosting connect: the exchange returned no usable token", p.id, `org=${intent.o}`);
      return to("exchange_failed");
    }
    const externalId = cleanText(grant.externalId);
    const accountId = cleanText(grant.accountId);

    // 4 — one org per installation: held by another org (a suspended one included) is `taken`.
    if (externalId) {
      const holders = await connectionsForExternalId(platform(env, handle), p.id, externalId);
      if (holders.some((h) => h.org_id !== ctx.orgId)) {
        await dropGrant(p, hf, grant, null, intent.o, "taken");
        return to("taken");
      }
    }
    // …and one install / OAuth connection per org: a DIFFERENT live one is replaced. Its credential and config
    // are read NOW, before the write deletes them, for the provider-side removal after it.
    const row = await connectionRow(ctx, p.id, "");
    const same = isLiveInstall(row) && sameGrant(row, externalId, accountId);
    const replaced = isLiveInstall(row) && !same ? row : null;
    const kind = HOSTING_INTEGRATION_KIND[p.id];
    const old = replaced && install.revoke
      ? { secret: await getSecret(ctx, kind, ""), config: await getIntegrationConfig(ctx, kind, "") }
      : null;
    if (!same) removable = externalId;

    try {
      // The same installation again keeps the id it was bound by when this grant did not carry one.
      await bindConnection(ctx, p, choice.spec.method, { ...grant, externalId: externalId ?? (same ? row!.external_id : null), accountId }, nowIso(), replaced);
    } catch (e) {
      if (!(e instanceof ConnectionConflictError)) throw e;
      // Lost the race for the installation: another org bound it between the check above and the write.
      await dropGrant(p, hf, grant, null, intent.o, "taken");
      return to("taken");
    }
    if (replaced && old?.secret) await dropReplaced(p, hf, replaced, old.secret, old.config, grant, externalId, intent.o);
    // OWNER CHECK: Vercel's callback also carries `next`, and an install may need the browser sent there to be
    // finalised (UNCONFIRMED, research doc › Vercel) — it is deliberately NOT followed; the whole query still
    // reached `exchange` above.
    return to("connected");
  } catch (e) {
    if (grant) await dropGrant(p, hf, grant, removable, intent.o, "error");
    if (e instanceof SecretsUnavailableError) return to("secrets_unavailable");
    console.error("hosting connect failed", p.id, `org=${intent.o}`, e instanceof Error ? e.name : "error"); // the name only — never the Error
    return to("failed");
  }
}

/**
 * Hand a grant Trov will NOT keep back to the provider — best effort, so no orphan stays live upstream: the
 * provider's `install.revoke` with the NEW credential. `externalId` null removes only what that credential is,
 * never an installation (`InstallSpec.revoke`): the caller passes the id only when the installation is nobody's
 * — never for `taken`, where it is another org's live connection. A failure is one scrubbed log line; it never
 * changes the outcome.
 */
async function dropGrant(p: HostingProvider, hf: HostFetch, grant: InstallGrant, externalId: string | null, orgId: string, why: string): Promise<void> {
  if (!p.install?.revoke) return;
  const token = grant.accessToken;
  const config: Record<string, string> = {};
  for (const [k, v] of Object.entries(grant.config ?? {})) if (typeof v === "string") config[k] = v;
  try {
    await p.install.revoke({ fetch: hf, secret: { reveal: () => token }, externalId, config });
  } catch (e) {
    console.error("hosting connect: handing the refused grant back failed", p.id, why, `org=${orgId}`, scrub(asHostingError(`${p.id} revoke`, e).message, token).slice(0, 300));
  }
}

/**
 * Remove a REPLACED install / OAuth grant on the provider's side, with its own credential — what Disconnect would
 * have done before the new grant was connected. Best effort: a failure is one scrubbed log line and never changes
 * the outcome (the new connection stands). Never anything the NEW grant is: skipped when the old credential IS
 * the new token, and the installation id is passed only when it differs from the new one's (`null` removes only
 * the old credential).
 */
async function dropReplaced(
  p: HostingProvider, hf: HostFetch, replaced: ConnectionRow, secret: { reveal(): string }, config: Readonly<Record<string, string>>,
  grant: InstallGrant, newExternalId: string | null, orgId: string,
): Promise<void> {
  if (!p.install?.revoke || secret.reveal() === grant.accessToken) return;
  const externalId = replaced.external_id && replaced.external_id !== newExternalId ? replaced.external_id : null;
  try {
    await p.install.revoke({ fetch: hf, secret, externalId, config });
  } catch (e) {
    console.error("hosting connect: removing the replaced grant failed", p.id, `org=${orgId}`, scrub(asHostingError(`${p.id} revoke`, e).message, [secret, grant.accessToken]).slice(0, 300));
  }
}

/** The binding lost a race: the installation went to another org between the callback's check and its write
 *  (0047's unique index on the active installation ids). */
export class ConnectionConflictError extends Error {
  constructor() { super("the installation is already connected to another org"); this.name = "ConnectionConflictError"; }
}
const isInstallationConflict = (e: unknown): boolean =>
  e instanceof Error && /UNIQUE constraint failed:\s*org_hosting_connections\b/i.test(e.message);

/**
 * Bind a grant to `ctx`'s org: the connection row (which CLAIMS the installation — 0047's partial unique index),
 * the credential (stored, or replacing a pasted token or an earlier grant) and the grant's config, audited —
 * ONE batch, so a lost race for the installation stores nothing at all (`ConnectionConflictError`).
 *
 * `replaced` is the org's live install / OAuth connection the caller read and means to END (a DIFFERENT grant —
 * the GitHub App's replace rule): the row is overwritten by the new grant in the same batch, and the end is audited
 * `hosting.disconnect` with `replaced_by` — written only while that row is still the one the caller read.
 */
export async function bindConnection(
  ctx: TenantContext, p: HostingProvider, method: "install" | "oauth", grant: InstallGrant, at: string = nowIso(),
  replaced: ConnectionRow | null = null,
): Promise<void> {
  const kind = HOSTING_INTEGRATION_KIND[p.id];
  const config = await mergedGrantConfig(ctx, p, kind, grant.config);
  const accountLabel = cleanText(grant.accountLabel);
  const stmts: Stmt[] = [
    // Before the upsert, which overwrites the row it checks.
    ...(replaced ? [stmt(ctx,
      `INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at)
       SELECT ?, ?, 'hosting.disconnect', ?, ?, ? WHERE EXISTS (SELECT 1 FROM org_hosting_connections
         WHERE org_id = ? AND provider = ? AND scope = '' AND status = 'active' AND connected_at = ?)`,
      ctx.orgId, ctx.userId, p.id,
      JSON.stringify({ provider: p.id, method: replaced.method, reason: "superseded", replaced: replaced.external_id ?? replaced.account_label ?? null, replaced_by: cleanText(grant.externalId) ?? accountLabel }),
      at, ctx.orgId, p.id, replaced.connected_at)] : []),
    stmt(ctx, `INSERT INTO org_hosting_connections (org_id, provider, scope, method, external_id, account_id, account_label, status, connected_by, connected_at)
               VALUES (?, ?, '', ?, ?, ?, ?, 'active', ?, ?)
               ON CONFLICT(org_id, provider, scope) DO UPDATE SET method = excluded.method, external_id = excluded.external_id,
                 account_id = excluded.account_id, account_label = excluded.account_label, status = 'active', connected_by = excluded.connected_by,
                 connected_at = excluded.connected_at, revoked_at = NULL, revoked_by = NULL, revoked_reason = NULL`,
      ctx.orgId, p.id, method, cleanText(grant.externalId), cleanText(grant.accountId), accountLabel, ctx.userId, at),
    ...(await secretPutStmts(ctx, kind, "", grant.accessToken, config ?? undefined, at)),
    auditStmt(ctx, "hosting.connect", p.id, { provider: p.id, method, account: accountLabel }, at),
  ];
  try {
    await batch(ctx, stmts);
  } catch (e) {
    if (isInstallationConflict(e)) throw new ConnectionConflictError();
    throw e;
  }
}

/** What the grant taught (a team id) merged into the org's config for the provider — only the provider's own
 *  fields, each checked against its pattern; null when nothing changes, or when a value was refused (logged
 *  by KEY). */
async function mergedGrantConfig(ctx: TenantContext, p: HostingProvider, kind: IntegrationKind, given: unknown): Promise<Record<string, string> | null> {
  if (!given || typeof given !== "object" || Array.isArray(given)) return null;
  const known = new Set(p.orgConfigFields.map((f) => f.key));
  const fromGrant = Object.fromEntries(Object.entries(given as Record<string, unknown>).filter(([k]) => known.has(k)));
  if (Object.keys(fromGrant).length === 0) return null;
  const current = await getIntegrationConfig(ctx, kind, "");
  // `required` is not this merge's question (an admin may still have to fill a field the grant did not carry).
  const checked = checkFields(p.orgConfigFields.map((f) => ({ ...f, required: false })), { ...current, ...fromGrant }, "config");
  if ("field" in checked) {
    console.error("hosting connect: a config value from the grant was refused", p.id, checked.field);
    return null;
  }
  const next = checked.values;
  const same = Object.keys(next).length === Object.keys(current).length && Object.keys(next).every((k) => next[k] === current[k]);
  return same ? null : next;
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
    ...(active ? [stmt(ctx, `UPDATE org_hosting_connections SET status = 'revoked', revoked_at = ?, revoked_by = ?, revoked_reason = 'disconnected'
                             WHERE org_id = ? AND provider = ? AND scope = ? AND status = 'active'`,
      at, ctx.userId, ctx.orgId, p.id, scope)] : []),
    auditStmt(ctx, "hosting.disconnect", p.id, { provider: p.id, ...(scope ? { scope } : {}), method: active?.method ?? "token", upstream }, at),
  ]);
  return { connection: await connectionDTO(ctx, env, p.id, scope, providers), upstream };
}

/**
 * An Integrations-page write to a hosting provider's credential (src/integrations/routes.ts — a pasted token
 * over an installed one, a set, a delete) means the install / OAuth row no longer describes the secret: it is
 * marked revoked (no provider-side call — that is Disconnect's), audited — `superseded` for a pasted token,
 * `disconnected` for a delete. Without this, a later "uninstalled" notice for the OLD installation would delete
 * the credential that replaced it. A no-op otherwise.
 */
export async function supersedeConnection(ctx: TenantContext, kind: IntegrationKind, scope: string, reason: "superseded" | "disconnected"): Promise<void> {
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

// ── ended from the provider's side (./webhook.ts, src/integrations/probe.ts) ──

/**
 * End an install / OAuth connection because the PROVIDER'S side ended it — its verified uninstall notice
 * (`uninstalled`, ./webhook.ts) or a 401 at Test connection (`refused`, `endRefusedConnection`) — as the org's
 * SYSTEM tenant: the credential deleted (`systemRevocationDeleteStmts`), the row marked revoked by `system` (a
 * reserved handle — never a provider id, `revoked_by` is in HANDLE_COLUMNS) with the reason's CODE, audited
 * `hosting.revoked` — one batch. Re-reads the row first and acts only on the connection the caller saw (the
 * installation id a notice names; the `connected_at` Test connection read before its probe): one replaced since
 * (another install, a pasted token) is left alone. Returns whether it ended one.
 */
export async function endConnectionAsSystem(
  ctx: TenantContext, provider: HostingProvider, scope: string, reason: "uninstalled" | "refused", match: { externalId?: string; connectedAt?: string },
): Promise<boolean> {
  const row = await connectionRow(ctx, provider.id, scope);
  if (!isLiveInstall(row)) return false;
  if (match.externalId !== undefined && row.external_id !== match.externalId) return false;
  if (match.connectedAt !== undefined && row.connected_at !== match.connectedAt) return false;
  const kind = HOSTING_INTEGRATION_KIND[provider.id];
  const at = nowIso();
  await batch(ctx, [
    ...(await systemRevocationDeleteStmts(ctx, kind, scope, reason, at)),
    stmt(ctx, `UPDATE org_hosting_connections SET status = 'revoked', revoked_at = ?, revoked_by = 'system', revoked_reason = ?
               WHERE org_id = ? AND provider = ? AND scope = ? AND status = 'active' AND connected_at = ?`,
      at, reason, ctx.orgId, provider.id, scope, row.connected_at),
    auditStmt(ctx, "hosting.revoked", provider.id, { provider: provider.id, ...(scope ? { scope } : {}), method: row.method, reason }, at),
  ]);
  return true;
}

/** The org's LIVE install / OAuth connection for a hosting `kind` / `scope` — its `connected_at` — or null (no
 *  row, ended, a pasted token, not a hosting kind). What Test connection reads BEFORE its probe. */
export async function liveInstallConnection(ctx: TenantContext, kind: IntegrationKind, scope: string): Promise<{ connected_at: string } | null> {
  const id = providerOfKind(kind);
  if (!id) return null;
  const row = await connectionRow(ctx, id, scope);
  return isLiveInstall(row) ? { connected_at: row.connected_at } : null;
}

/**
 * Test connection got a 401 for the credential an install / OAuth grant put there: the grant was revoked or
 * removed on the provider's side, so the connection is ended (`refused`) — ONLY Test connection does this (a
 * poll's 401 is recorded in `last_error` and deletes nothing: src/hosting/poll.ts). `connectedAt` is what
 * `liveInstallConnection` read before the probe. Runs as the org's system tenant (`jobTenant` refuses a bearer).
 */
export async function endRefusedConnection(env: Env, ctx: TenantContext, kind: IntegrationKind, scope: string, connectedAt: string): Promise<boolean> {
  const id = providerOfKind(kind);
  if (!id) return false;
  return endConnectionAsSystem(jobTenant(env, ctx), PROVIDERS[id], scope, "refused", { connectedAt });
}

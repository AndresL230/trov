// Fixtures for the Org settings › Hosting backend tests (test/hosting.setup.*.test.ts): FAKE providers standing
// in for the registry's (whose real implementations are their own suites' business), an app that serves the
// hosting routes with that registry behind the production gates, and the env an install needs.
import { env } from "cloudflare:test";
import { Hono } from "hono";
import type { HostingProviderId } from "@shared/hosting";
import type { AppEnv } from "../../src/auth/principal";
import { sessionGate } from "../../src/auth/principal";
import { platformContext, soleTenantGate, tenantGate } from "../../src/data/gate";
import type { Env } from "../../src/env";
import { refuse } from "../../src/hosting/http";
import type { ProviderMap } from "../../src/hosting/part-writes";
import { PROVIDERS } from "../../src/hosting/registry";
import { makeHostingApp, makeHostingCallbackApp } from "../../src/hosting/routes";
import type { HostingProvider, InstallGrant, InstallSpec } from "../../src/hosting/types";
import { LONG_TOKEN } from "./repo";

export const FAKE_HOST = "api.fake-host.test";
/** The integration's client secret — long, so a leak check can look for any 8-character piece of it. */
export const CLIENT_SECRET = "cs_" + "Zx9Yw8Vu".repeat(8);
export const FAKE_VARS = { VERCEL_INTEGRATION_CLIENT_ID: "oac_fake_client", VERCEL_INTEGRATION_CLIENT_SECRET: CLIENT_SECRET, VERCEL_INTEGRATION_SLUG: "trov-test" };
/** The pool env plus the integration's vars: what a deployment that configured the (fake) Vercel integration has. */
export const installEnv = (extra: Record<string, unknown> = {}): Env => ({ ...env, ...FAKE_VARS, ...extra }) as unknown as Env;
/** The pool env with the integration's vars BLANKED — a deployment that configured no install (the pool loads a
 *  developer's `.dev.vars`, so absence is stated, never assumed). */
export const noInstallEnv = (): Env => ({ ...env, ...Object.fromEntries(Object.keys(FAKE_VARS).map((k) => [k, ""])) }) as unknown as Env;

type ExchangeArgs = Parameters<InstallSpec["exchange"]>[0];
type RevokeArgs = Parameters<NonNullable<InstallSpec["revoke"]>>[0];
type AuthorizeArgs = Parameters<InstallSpec["authorizeUrl"]>[0];

export async function hmacHex(key: string, body: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface FakeOpts {
  exchange?: (a: ExchangeArgs) => Promise<InstallGrant>;
  revoke?: (a: RevokeArgs) => Promise<void>;
}

export interface Fakes {
  providers: ProviderMap;
  calls: { authorize: AuthorizeArgs[]; exchange: ExchangeArgs[]; revoke: RevokeArgs[] };
}

/** The default exchange: one POST to the fake host's token endpoint (through the fixed-host fetch it is handed). */
async function defaultExchange(a: ExchangeArgs): Promise<InstallGrant> {
  const res = await a.fetch(`https://${FAKE_HOST}/oauth/token`, {
    method: "POST", body: new URLSearchParams({ code: a.code, client_id: a.clientId, client_secret: a.clientSecret, redirect_uri: a.redirectUri }),
  });
  if (!res.ok) await refuse("fakecel token", res, [a.clientSecret, a.code]);
  const body = (await res.json()) as { access_token: string; installation_id: string; team_id: string | null; team_name: string | null };
  return {
    accessToken: body.access_token, externalId: body.installation_id, accountId: body.team_id, accountLabel: body.team_name,
    config: body.team_id ? { team_id: body.team_id } : {},
  };
}

/**
 * Two fake providers in an otherwise real registry:
 *   vercel  "Fakecel" — a WEB host connected by an INSTALL (client id / secret / slug vars), with revoke and an
 *           uninstall webhook (`x-fake-signature` = hex HMAC-SHA256 of the raw body with the client secret;
 *           `{ type: "removed", id }`); org config `team_id` (optional); part setting `project` (required).
 *   render  "Fakender" — a token-only host serving web AND service, with a REQUIRED org config field
 *           (`owner_id`) and a required part setting `service_id`.
 * Cloudflare, Railway and AWS are the registry's own (they are stable: legacy, and `later`).
 */
export function fakeProviders(o: FakeOpts = {}): Fakes {
  const calls: Fakes["calls"] = { authorize: [], exchange: [], revoke: [] };
  const fakecel: HostingProvider = {
    id: "vercel", label: "Fakecel", status: "available", summary: "A fake web host.", roles: ["web"], apiHosts: [FAKE_HOST],
    docsUrl: "https://docs.fake-host.test", credentialScope: "org",
    connectionMethods: [
      { method: "install", label: "Connect with Fakecel", howTo: "Install it.", grants: ["Projects: read"], requires: Object.keys(FAKE_VARS) },
      { method: "token", label: "Paste a token", howTo: "Paste it.", grants: ["Everything"] },
    ],
    orgConfigFields: [{ key: "team_id", label: "Team ID", description: "The team.", required: false, pattern: /^team_[A-Za-z0-9]+$/ }],
    partSettings: [
      { key: "project", label: "Project", description: "The project's name.", required: true, pattern: /^[a-z0-9-]{1,40}$/ },
      { key: "branch", label: "Branch", description: "A preview branch.", required: false },
    ],
    capabilities: { deploys: true, metrics: [] }, planNote: null, pollCost: 1,
    consoleUrl: (part, config) => (part.settings.project ? `https://fake-host.test/${config.team_id ?? "personal"}/${part.settings.project}` : null),
    manageUrl: (config, method) => (method === "install" ? `https://fake-host.test/${config.team_id ?? "personal"}/integrations` : method === "token" ? "https://fake-host.test/tokens" : null),
    probe: async () => ({ ok: true, detail: "Fakecel answered." }),
    poll: async () => ({ deploys: [], points: [], unavailable: [], covered: null }),
    install: {
      clientIdVar: "VERCEL_INTEGRATION_CLIENT_ID",
      clientSecretVar: "VERCEL_INTEGRATION_CLIENT_SECRET",
      authorizeUrl(a) {
        calls.authorize.push(a);
        return `https://fake-host.test/integrations/${a.vars.VERCEL_INTEGRATION_SLUG}/new?client_id=${a.clientId}&redirect_uri=${encodeURIComponent(a.redirectUri)}&state=${encodeURIComponent(a.state)}`;
      },
      async exchange(a) { calls.exchange.push(a); return (o.exchange ?? defaultExchange)(a); },
      async revoke(a) { calls.revoke.push(a); if (o.revoke) await o.revoke(a); },
      webhook: {
        async verify({ rawBody, headers, clientSecret }) { return headers.get("x-fake-signature") === (await hmacHex(clientSecret, rawBody)); },
        removedExternalId(p) {
          const v = p as { type?: unknown; id?: unknown } | null;
          return v && v.type === "removed" && typeof v.id === "string" ? v.id : null;
        },
      },
    },
  };
  const fakender: HostingProvider = {
    id: "render", label: "Fakender", status: "available", summary: "A fake service host.", roles: ["service", "web"], apiHosts: [FAKE_HOST],
    docsUrl: "https://docs.fake-host.test", credentialScope: "org",
    connectionMethods: [{ method: "token", label: "Paste an API key", howTo: "Paste it.", grants: ["Everything"] }],
    orgConfigFields: [{ key: "owner_id", label: "Owner ID", description: "The workspace's owner id.", required: true, pattern: /^own-[a-z0-9]+$/ }],
    partSettings: [{ key: "service_id", label: "Service ID", description: "The service's id.", required: true, pattern: /^srv-[a-z0-9]+$/ }],
    capabilities: { deploys: true, metrics: ["cpu", "mem_mb"] }, planNote: null, pollCost: 2,
    consoleUrl: (part) => (part.settings.service_id ? `https://fake-host.test/services/${part.settings.service_id}` : null),
    probe: async () => ({ ok: true, detail: "Fakender answered." }),
    poll: async () => ({ deploys: [], points: [], unavailable: [], covered: null }),
  };
  return { providers: { ...PROVIDERS, vercel: fakecel, render: fakender } as Record<HostingProviderId, HostingProvider>, calls };
}

/** A fetch for the fake host's token endpoint: 200 with an installed grant for `LONG_TOKEN`, unless `status` says otherwise
 *  (then the body ECHOES the request — code and client secret included — as a careless upstream would). Test
 *  connection's probe runs the REAL Vercel provider (src/integrations/probe.ts reads the registry): with `probe`,
 *  a request to api.vercel.com answers that status. */
export function tokenEndpoint(o: { status?: number; token?: string; installation?: string; team?: string | null; probe?: number } = {}): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    urls.push(url);
    if (new URL(url).hostname === "api.vercel.com") {
      return new Response(JSON.stringify(o.probe === undefined || o.probe === 200 ? { id: "team_acme", slug: "acme" } : { error: { code: "forbidden", message: "Not authorized" } }),
        { status: o.probe ?? 200, headers: { "content-type": "application/json" } });
    }
    const sent = init?.body ? String(init.body) : "";
    if ((o.status ?? 200) !== 200) return new Response(JSON.stringify({ error: { message: `bad request: ${sent}` } }), { status: o.status, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({
      access_token: o.token ?? LONG_TOKEN, installation_id: o.installation ?? "icfg_one", team_id: o.team === undefined ? "team_acme" : o.team, team_name: "Acme Team",
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: f, urls };
}

/** The hosting routes with `providers` (and `fetchImpl`), behind the SAME gates the app runs them behind. */
export function hostingTestApp(providers: ProviderMap, fetchImpl?: typeof fetch): Hono<AppEnv> {
  const a = new Hono<AppEnv>();
  a.use("*", sessionGate);
  a.use("*", platformContext);
  a.use("*", soleTenantGate);
  a.use("/api/o/:slug/*", tenantGate);
  a.route("/hosting", makeHostingCallbackApp({ providers, fetchImpl }));
  a.route("/api/o/:slug", makeHostingApp({ providers, fetchImpl }));
  return a;
}

export interface Sent { status: number; json: Record<string, unknown> | null; headers: Headers }

/** One request to `app` as `cookie`. `path` is absolute (`/api/o/saplinglearn/hosting`). */
export async function send(app: Hono<AppEnv>, method: string, path: string, cookie: string | null, body?: unknown, e: Env = installEnv(), headers: Record<string, string> = {}): Promise<Sent> {
  const res = await app.request(path, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  }, e as unknown as Record<string, unknown>);
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { json = null; }
  return { status: res.status, json, headers: res.headers };
}

/** An environment row with nothing on it (no legacy columns), for an org. */
export async function seedBareEnvironment(orgId: string, key: string, position: number, label = key): Promise<void> {
  const at = "2026-10-06T00:00:00.000Z";
  await env.DB.prepare(`INSERT INTO org_environments (org_id, key, position, label, branch, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, 'main', ?, ?, 'seed')`)
    .bind(orgId, key, position, label, at, at).run();
}

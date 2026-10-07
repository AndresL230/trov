// `POST /webhook/hosting/:provider` — a hosting provider's "uninstalled" notice (#97: a connection "can be
// disconnected from either side"). Dispatched by src/index.ts BEFORE the session-gated app, like
// `/webhook/github`: the provider's signature over the raw body IS the authentication.
//
//   1. the provider must be one Trov knows AND declare a notice (`install.webhook`), else 404;
//   2. the body is read raw, to at most 256 KB (413 past that);
//   3. the signature is verified with the integration's CLIENT SECRET (the Worker var `install.clientSecretVar`).
//      No secret configured, a signature that does not verify, a verifier that throws → the SAME bare 401
//      `{ "error": "unauthorized" }`, and NOTHING is written — unauthenticated traffic causes no write;
//   4. a verified body that names a removed installation (`removedExternalId`) revokes it in EVERY org whose
//      ACTIVE connection for that provider carries that installation id — found by a cross-org read (the
//      notice names only the installation), and revoked as each org's SYSTEM tenant
//      (`revokeFromProviderSide`, ./connections.ts): its secret deleted, its connection marked revoked by the
//      provider, audited. A suspended org is included: a dead installation's credential goes either way.
//   5. 200 `{ ok: true, revoked: <n> }` — also for a verified notice about something else (`revoked: 0`).
import { isHostingProvider } from "@shared/hosting";
import { platform, systemTenant, type PlatformContext } from "../data/context";
import { all } from "../data/platform-sql";
import type { Env } from "../env";
import { revokeFromProviderSide } from "./connections";
import type { ProviderMap } from "./part-writes";
import { PROVIDERS } from "./registry";

export const HOSTING_WEBHOOK_MAX_BYTES = 262_144;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** The one refusal for anything unauthenticated: same status, body and headers whatever the reason. */
const unauthorized = (): Response => json({ error: "unauthorized" }, 401);

/** `/webhook/hosting/<provider>` → the provider segment, else null (not this route). */
export function hostingWebhookPath(pathname: string): { provider: string } | null {
  const m = /^\/webhook\/hosting\/([a-z0-9_-]{1,32})$/.exec(pathname);
  return m ? { provider: m[1] } : null;
}

/** The raw body, or null when it is larger than the cap (declared or actual). */
async function rawBody(request: Request, cap: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > cap) return null;
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    size += value.byteLength;
    if (size > cap) { await reader.cancel().catch(() => undefined); return null; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(bytes);
}

/**
 * The orgs whose ACTIVE connection for `provider` is the installation `externalId`, with its scope — a
 * cross-org read BEFORE any org is known (the notice names only the installation). Ids and a scope only;
 * declared in test/data-layer.static.test.ts (PLATFORM_ALLOW).
 */
export function connectionsForExternalId(p: PlatformContext, provider: string, externalId: string): Promise<{ org_id: string; scope: string }[]> {
  return all<{ org_id: string; scope: string }>(p,
    `SELECT c.org_id, c.scope FROM org_hosting_connections c
      WHERE c.provider = ? AND c.external_id = ? AND c.status = 'active' ORDER BY c.org_id, c.scope`, provider, externalId);
}

export async function handleHostingWebhook(request: Request, env: Env, providerId: string, providers: ProviderMap = PROVIDERS): Promise<Response> {
  if (!isHostingProvider(providerId) || !providers[providerId]?.install?.webhook) return json({ error: "not_found" }, 404);
  const provider = providers[providerId];
  const install = provider.install!;
  const hook = install.webhook!;

  const body = await rawBody(request, HOSTING_WEBHOOK_MAX_BYTES).catch(() => null);
  if (body === null) return json({ error: "too_large" }, 413);
  const clientSecret = (env as unknown as Record<string, unknown>)[install.clientSecretVar];
  if (typeof clientSecret !== "string" || clientSecret.length === 0) return unauthorized();
  const verified = await hook.verify({ rawBody: body, headers: request.headers, clientSecret }).catch(() => false);
  if (verified !== true) return unauthorized();

  let payload: unknown;
  try { payload = JSON.parse(body); } catch { return json({ error: "invalid_json" }, 400); }
  let externalId: string | null = null;
  try { externalId = hook.removedExternalId(payload); } catch { externalId = null; }
  if (typeof externalId !== "string" || externalId.length === 0 || externalId.length > 200) return json({ ok: true, revoked: 0 });

  const p = platform(env, "system");
  let revoked = 0;
  for (const row of await connectionsForExternalId(p, provider.id, externalId)) {
    try {
      if (await revokeFromProviderSide(systemTenant(p, row.org_id, "system"), provider, row.scope, externalId)) revoked += 1;
    } catch (e) {
      // One org's failure never costs another org its revocation; the name only — never the Error.
      console.error("hosting webhook: revocation failed", provider.id, `org=${row.org_id}`, e instanceof Error ? e.name : "error");
    }
  }
  return json({ ok: true, revoked });
}

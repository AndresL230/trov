// `POST /webhook/hosting/:provider` — a hosting provider's "uninstalled" notice (#97: a connection "can be
// disconnected from either side"). Dispatched by src/index.ts BEFORE the session-gated app, like
// `/webhook/github`: the provider's signature over the raw body IS the authentication.
//
//   1. the provider must be one Trov knows AND declare a notice (`install.webhook`), else 404;
//   2. the body is read raw, to at most 256 KB (413 past that);
//   3. the signature is verified with the integration's CLIENT SECRET (the Worker var `install.clientSecretVar`).
//      No secret configured, a signature that does not verify, a verifier that throws → the SAME bare 401
//      `{ "error": "unauthorized" }`, and NOTHING is written — unauthenticated traffic causes no write;
//   4. a verified body that names a removed installation (`removedExternalId`) ends the connection of the org
//      whose ACTIVE connection for that provider carries that installation id (0057's unique index: at most
//      one) — found by a cross-org read (src/platform/jobs.ts `connectionsForExternalId`: the notice names only
//      the installation), and ended as that org's SYSTEM tenant (`endConnectionAsSystem`, ./connections.ts):
//      its secret deleted, its connection marked revoked by `system` (`uninstalled`), audited. A suspended org
//      is included: a dead installation's credential goes either way.
//   5. a verified body that names a CHANGED project (`changedProject`: Vercel's `deployment.created` /
//      `succeeded` / `error` / `canceled` / `promoted` / `rollback`, `project.removed` / `project.renamed`) is a
//      NUDGE: the stored parts on that project, in the active org(s) connected to that provider-side account
//      (`connectionsForAccount`), are polled again now (`pollPart`, as each org's system tenant) — the provider's
//      API stays the record, nothing from the delivery is stored. At most `HOSTING_WEBHOOK_MAX_REFRESH` parts a
//      delivery; the polls run after the response (`waitUntil`) so the provider gets its 2xx at once.
//   6. 200 `{ ok: true, revoked: <n> }` (+ `refreshed: <n>` for a changed project) — also for a verified notice
//      about anything else (`revoked: 0`): an unknown event type is acknowledged and ignored, never an error.
import { isHostingProvider } from "@shared/hosting";
import { platform, systemTenant } from "../data/context";
import type { Env } from "../env";
import { connectionsForAccount, connectionsForExternalId } from "../platform/jobs";
import { endConnectionAsSystem } from "./connections";
import { listAllParts, type PartRow } from "./parts";
import type { ProviderMap } from "./part-writes";
import { pollPart } from "./poll";
import { PROVIDERS } from "./registry";
import type { TenantContext } from "../data/sql";

export const HOSTING_WEBHOOK_MAX_BYTES = 262_144;
/** The most parts one delivery may have polled: a project is one or two parts, and a delivery must stay cheap. */
export const HOSTING_WEBHOOK_MAX_REFRESH = 6;

export interface HostingWebhookOptions {
  providers?: ProviderMap;
  /** The Worker's `ctx.waitUntil`: the polls a changed project asks for run after the response. Absent (a test),
   *  they are awaited. */
  waitUntil?: (p: Promise<unknown>) => void;
  /** The fetch a refresh poll goes through (still wrapped in the provider's fixed-host fetch). */
  fetchImpl?: typeof fetch;
}

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

export async function handleHostingWebhook(request: Request, env: Env, providerId: string, opts: ProviderMap | HostingWebhookOptions = {}): Promise<Response> {
  // (The fourth argument was the provider registry alone; a registry is still accepted.)
  const o: HostingWebhookOptions = "vercel" in opts ? { providers: opts as ProviderMap } : (opts as HostingWebhookOptions);
  const providers = o.providers ?? PROVIDERS;
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
  const p = platform(env, "system");
  if (typeof externalId !== "string" || externalId.length === 0 || externalId.length > 200) {
    // Not a removal. A changed project is a nudge to read its parts again; anything else is acknowledged.
    let change: { accountId: string; names: string[] } | null = null;
    try { change = hook.changedProject?.(payload) ?? null; } catch { change = null; }
    if (!change || typeof change.accountId !== "string" || !change.accountId || change.accountId.length > 200 || !Array.isArray(change.names)) return json({ ok: true, revoked: 0 });
    const names = new Set(change.names.filter((n) => typeof n === "string" && n.length > 0 && n.length <= 200));
    const idKey = provider.partSettings[0]?.key;
    const todo: { ctx: TenantContext; part: PartRow }[] = [];
    if (idKey && names.size) {
      for (const row of await connectionsForAccount(p, provider.id, change.accountId)) {
        const ctx = systemTenant(p, row.org_id, "system");
        for (const part of await listAllParts(ctx)) {
          if (part.provider === provider.id && names.has(part.settings[idKey] ?? "") && todo.length < HOSTING_WEBHOOK_MAX_REFRESH) todo.push({ ctx, part });
        }
      }
    }
    // `pollPart` never throws and records its own outcome (and the credential's) — the screen shows a failure.
    const work = (async () => { for (const t of todo) await pollPart(env, t.ctx, t.part, Date.now(), o.fetchImpl, providers); })()
      .catch((e) => { console.error("hosting webhook: refresh failed", provider.id, e instanceof Error ? e.name : "error"); });
    if (o.waitUntil) o.waitUntil(work); else await work;
    return json({ ok: true, revoked: 0, refreshed: todo.length });
  }

  let revoked = 0;
  for (const row of await connectionsForExternalId(p, provider.id, externalId)) {
    try {
      if (await endConnectionAsSystem(systemTenant(p, row.org_id, "system"), provider, row.scope, "uninstalled", { externalId })) revoked += 1;
    } catch (e) {
      // One org's failure never costs another org its revocation; the name only — never the Error.
      console.error("hosting webhook: revocation failed", provider.id, `org=${row.org_id}`, e instanceof Error ? e.name : "error");
    }
  }
  return json({ ok: true, revoked });
}

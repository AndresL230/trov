// The GitHub webhook's ENTRY POINT (canopy-multitenancy.md §8.5, D10): which org a delivery belongs
// to, and whether it is authentic. The capture that follows is src/webhook.ts (`captureDelivery`).
//
//   POST /webhook/github/:hookId   `hookId` = `org_repos.id`. The HMAC is verified against THAT
//                                  repo's `github_webhook` secret (scope = the hook id), the payload
//                                  must name that repo, and the capture runs as that org's
//                                  "github-webhook" system tenant.
//   POST /webhook/github           LEGACY — the URL SaplingLearn's GitHub webhook was created with.
//                                  It delivers ONLY to the repo row flagged `legacy_hook = 1`, whose
//                                  secret is still the Worker's GITHUB_WEBHOOK_SECRET until that org's
//                                  admin stores one (`resolveCredential`'s fallback). The cleanup
//                                  phase deletes the route, the flag and the Worker secret.
//
// This module resolves credentials, so it must NOT be reachable from src/mcp.ts (src/webhook.ts is —
// test/secrets.mcp.test.ts): the revealed values go down to `captureDelivery` as parameters. The GitHub
// token is `githubCredential`'s (src/github-app/credential.ts): an installation token when this repo is
// attached to the GitHub App, else the pasted `github_token`.
//
// A delivery that fails its signature writes NOTHING — unauthenticated traffic must not cause a write,
// not even a `last_error` — and every refusal is the SAME bare 401 (§8.5), so a hook id cannot be probed.
import type { Env } from "./env";
import { platform, systemTenant } from "./data/context";
import { markSecretUsed, resolveCredential } from "./data/secrets";
import { githubCredential } from "./github-app/credential";
import { hookRepo, legacyHookRepo } from "./platform/jobs";
import { captureDelivery, verifyGithubSignature, type DeliveryOpts } from "./webhook";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** The one refusal: an unknown hook id, a suspended org's, a repo with no (readable) secret and a bad
 *  signature all answer this — same status, body and headers, no WWW-Authenticate. */
const unauthorized = (): Response => json({ error: "unauthorized" }, 401);

/** `/webhook/github` → `{ hookId: null }` (the legacy hook); `/webhook/github/<id>` → that hook;
 *  anything else → null (not a webhook path). */
export function webhookPath(pathname: string): { hookId: string | null } | null {
  if (pathname === "/webhook/github") return { hookId: null };
  const m = /^\/webhook\/github\/([A-Za-z0-9_-]{1,64})$/.exec(pathname);
  return m ? { hookId: m[1] } : null;
}

/** The repository a payload says it is about, or null (unparseable, or a payload without one). */
function payloadRepo(rawBody: string): string | null {
  try {
    const name = (JSON.parse(rawBody) as { repository?: { full_name?: unknown } | null } | null)?.repository?.full_name;
    return typeof name === "string" ? name : null;
  } catch {
    return null;
  }
}

/**
 * Verify one delivery and hand it to the capture. In order:
 *
 *   1. the hook's repo row — a platform read by id. Unknown id, a suspended org's, or the legacy URL
 *      with no `legacy_hook` row → the bare 401 below.
 *   2. the HMAC over the raw body, against that repo's secret. No secret, a secret that cannot be
 *      read, or a bad signature → the same bare 401, and NO rows.
 *   3. on a per-org hook the payload's repository must be the row's (case-insensitively, as GitHub
 *      compares names); a payload naming another repository — or none — is acknowledged and ignored
 *      (202, no rows), so a hook of org B can never write a delivery about org A's repo into either
 *      org. The LEGACY hook does not apply this check: it behaves exactly as it did before (the
 *      ticket mirror alone is scoped to the repo), so production's existing webhook is unaffected.
 *   4. only the org's PRIMARY repo is captured today: the capture's keys (`gh:pr:<n>:…`) do not carry
 *      the repo, so a second repo's PR #7 would collide with the first's. A verified delivery for a
 *      non-primary repo is acknowledged and ignored.
 *
 * A verified delivery bumps the secret's `last_used_at` (throttled) — what the Integrations screen's
 * "Test connection" reports for a webhook.
 */
export async function handleGithubWebhook(request: Request, env: Env, opts?: DeliveryOpts & { hookId?: string | null }): Promise<Response> {
  const rawBody = await request.text();
  const sig = request.headers.get("x-hub-signature-256");
  const p = platform(env, "github-webhook");
  const hookId = opts?.hookId ?? null;
  const row = hookId === null ? await legacyHookRepo(p) : await hookRepo(p, hookId);
  if (!row) return unauthorized();

  const ctx = systemTenant(p, row.org_id, "github-webhook");
  // Fixed-text errors only (src/data/secrets.ts); a secret that cannot be read verifies nothing.
  const secret = await resolveCredential(ctx, env, "github_webhook", row.id).catch(() => null);
  if (!secret || !(await verifyGithubSignature(secret.reveal(), rawBody, sig))) return unauthorized();
  await markSecretUsed(ctx, "github_webhook", row.id).catch(() => undefined);

  if (hookId !== null && payloadRepo(rawBody)?.toLowerCase() !== row.repo_full_name.toLowerCase()) return json({ ok: true, ignored: true }, 202);
  if (row.is_primary !== 1) return json({ ok: true, ignored: true }, 202);

  // LAZY and resolved at most ONCE per delivery: a delivery may ask more than once (a failed run, a push to
  // an environment branch), and on the App each resolution is a mint.
  let token: Promise<string | null> | undefined;
  return captureDelivery(ctx, env, {
    repo: row.repo_full_name,
    githubToken: () => token ??= (async () => {
      const cred = await githubCredential(ctx, env, { id: row.id, repo: row.repo_full_name }, { fetchImpl: opts?.fetchImpl }).catch(() => null);
      if (cred?.source === "pasted") await markSecretUsed(ctx, "github_token", "").catch(() => undefined);
      return cred?.token.reveal() ?? null;
    })(),
  }, request.headers.get("x-github-event") ?? "", rawBody, opts);
}

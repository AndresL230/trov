// The GitHub App's webhook (issue #95; docs/superpowers/specs/2026-10-06-github-app-design.md §7): ONE URL,
// `POST /webhook/github-app`, for every installation of the App, signed with the App's own webhook secret. Which
// org a delivery belongs to is the INSTALLATION's (`installationOwner`), never anything else the payload says.
//
//   1. The App not configured, or a missing / bad `X-Hub-Signature-256` → the bare 401 — NOTHING written, not
//      even `last_delivery_at`. Every refusal is the same status, body and headers.
//   2. A verified body that is not a JSON object → 400 `{ error: "bad_request" }` (GitHub always sends JSON, so
//      this is a broken upstream, and a 4xx shows as a FAILED delivery in the App's "Recent deliveries"). A
//      well-formed body that names no usable installation (`ping`, `meta`, `github_app_authorization`, an id
//      that is not a positive safe integer) or one no org has bound → 202 ignored, nothing written.
//   3. `installation` / `installation_repositories` keep the BINDING true to GitHub, so they apply even while
//      the org or the installation is suspended (an uninstall, a suspension's end, a repository leaving the
//      list must all land). 200 `{ ok: true }`; an action we do not handle → 202 ignored.
//   4. Every other event is CAPTURE: ignored (202) when the org or the installation is suspended, when the event
//      is not one the capture reads, or unless `repository.full_name` is an `org_repos` row OF THAT ORG attached
//      to THIS installation and primary — then `noteDelivery` and the SAME `captureDelivery` the per-repo hook
//      runs (src/github-hook.ts), as the org's "github-webhook" system tenant, with a lazy `githubToken`.
//
// This module mints (through credential.ts), so NOTHING REACHABLE FROM src/mcp.ts MAY IMPORT IT
// (test/secrets.mcp.test.ts); src/webhook.ts is reachable from MCP and takes the token as a plain string.
// An unexpected throw after the signature verified is a 503 (GitHub can redeliver; every write is idempotent),
// logged scrubbed of every App secret and of the installation token if one was revealed — never a 500.
import type { Env } from "../env";
import { platform, systemTenant, type TenantContext } from "../data/context";
import { markSecretUsed, scrub } from "../data/secrets";
import { listRepoRows } from "../integrations/settings";
import { captureDelivery, REPO_EVENT_NAMES, verifyGithubSignature, WORK_EVENT_NAMES, type DeliveryOpts } from "../webhook";
import { appSecrets, githubAppConfig } from "./config";
import { githubCredential } from "./credential";
import {
  installationOwner, InstallationNotFoundError, noteDelivery, setInstallationSuspended, syncInstallationRepos, unbindInstallation,
} from "./installations";

// ── shapes ───────────────────────────────────────────────────────────────────

const ACTOR = "github-webhook" as const;
/** The deliveries `captureDelivery` reads; anything else (star, issue_comment, …) is acknowledged and ignored. */
const CAPTURED = new Set<string>([...WORK_EVENT_NAMES, ...REPO_EVENT_NAMES]);

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const unauthorized = (): Response => json({ error: "unauthorized" }, 401);
const ignored = (): Response => json({ ok: true, ignored: true }, 202);
const applied = (): Response => json({ ok: true });

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);

function parseObject(raw: string): Obj | null {
  try {
    return obj(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** `installation.id` — a positive safe integer, as GitHub's ids are — else null. */
function installationIdOf(payload: Obj): number | null {
  const id = obj(payload.installation)?.id;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
}

const selectionOf = (v: unknown): "all" | "selected" | undefined => (v === "all" || v === "selected" ? v : undefined);

/** `/webhook/github-app` exactly (it never matches the per-repo `/webhook/github/:hookId`). */
export const githubAppWebhookPath = (pathname: string): boolean => pathname === "/webhook/github-app";

// ── the handler ──────────────────────────────────────────────────────────────

export async function handleGithubAppWebhook(request: Request, env: Env, opts?: DeliveryOpts): Promise<Response> {
  const cfg = githubAppConfig(env);
  if (!cfg) return unauthorized();
  const rawBody = await request.text();
  if (!(await verifyGithubSignature(cfg.webhookSecret, rawBody, request.headers.get("x-hub-signature-256")))) return unauthorized();

  const payload = parseObject(rawBody);
  if (!payload) return json({ error: "bad_request" }, 400);
  const id = installationIdOf(payload);
  if (id === null) return ignored();
  const event = request.headers.get("x-github-event") ?? "";

  let revealed: string | null = null; // the installation token, once the capture asked for it — for the scrub below
  try {
    const p = platform(env, ACTOR);
    const owner = await installationOwner(p, id);
    if (!owner) return ignored();
    const ctx = systemTenant(p, owner.org_id, ACTOR);

    if (event === "installation" || event === "installation_repositories") return await lifecycle(ctx, id, event, payload);

    if (!CAPTURED.has(event) || owner.org_suspended || owner.suspended_at !== null) return ignored();
    const name = obj(payload.repository)?.full_name;
    if (typeof name !== "string") return ignored();
    // ≤ MAX_ORG_REPOS rows; names compare without case, as GitHub's do.
    const row = (await listRepoRows(ctx)).find((r) =>
      r.installation_id === id && r.is_primary === 1 && r.repo_full_name.toLowerCase() === name.toLowerCase());
    if (!row) return ignored();
    await noteDelivery(ctx, id).catch(() => false); // bookkeeping never costs the capture

    // LAZY and resolved at most ONCE per delivery (each resolution is a mint) — the per-repo hook's thunk.
    let token: Promise<string | null> | undefined;
    return await captureDelivery(ctx, env, {
      repo: row.repo_full_name,
      githubToken: () => token ??= (async () => {
        const cred = await githubCredential(ctx, env, { id: row.id, repo: row.repo_full_name }, { fetchImpl: opts?.fetchImpl }).catch(() => null);
        if (cred?.source === "pasted") await markSecretUsed(ctx, "github_token", "").catch(() => undefined);
        revealed = cred?.token.reveal() ?? null;
        return revealed;
      })(),
    }, event, rawBody, opts);
  } catch (e) {
    console.error("github app webhook failed", event, scrub(e instanceof Error ? e.message : String(e), [...appSecrets(cfg), revealed]), `installation=${id}`);
    return json({ error: "temporarily_unavailable" }, 503);
  }
}

// ── lifecycle ────────────────────────────────────────────────────────────────

/**
 * `installation` / `installation_repositories`, for an installation bound to `ctx`'s org. Each write is the
 * repository's own (src/github-app/installations.ts), audited as `github-webhook`, and a redelivery is a no-op.
 *
 * `created` / `new_permissions_accepted` carry `repositories`, which GitHub may cut short for a large
 * installation. A truncated FULL list would wrongly DETACH repositories, so only a `selected` installation's
 * list (what a person picked) replaces the stored one; an `all` installation's is applied as ADDITIONS (it
 * attaches, never detaches — removals arrive as `installation_repositories.removed`, and a complete list comes
 * only from GitHub's API: the bind and an admin's Refresh). No `repositories` → nothing written.
 */
async function lifecycle(ctx: TenantContext, id: number, event: string, payload: Obj): Promise<Response> {
  const action = typeof payload.action === "string" ? payload.action : "";
  const inst = obj(payload.installation) ?? {};
  try {
    if (event === "installation") {
      switch (action) {
        case "deleted":
          await unbindInstallation(ctx, id, ACTOR, "github.uninstall");
          return applied();
        case "suspend":
          await setInstallationSuspended(ctx, id, typeof inst.suspended_at === "string" ? inst.suspended_at : new Date().toISOString());
          return applied();
        case "unsuspend":
          await setInstallationSuspended(ctx, id, null);
          return applied();
        case "created":
        case "new_permissions_accepted": {
          const repos = payload.repositories;
          if (!Array.isArray(repos)) return applied();
          const selection = selectionOf(inst.repository_selection);
          await syncInstallationRepos(ctx, id, selection === "selected" ? repos : { added: repos }, ACTOR, { repositorySelection: selection });
          return applied();
        }
        default:
          return ignored();
      }
    }
    if (action !== "added" && action !== "removed") return ignored();
    await syncInstallationRepos(ctx, id, {
      added: Array.isArray(payload.repositories_added) ? payload.repositories_added : [],
      removed: Array.isArray(payload.repositories_removed) ? payload.repositories_removed : [],
    }, ACTOR, { repositorySelection: selectionOf(payload.repository_selection) });
    return applied();
  } catch (e) {
    // Unbound between the owner read and the write (a racing `deleted`): nothing left to keep true.
    if (e instanceof InstallationNotFoundError) return ignored();
    throw e;
  }
}

// The GitHub App's ONE webhook, `POST /webhook/github/app` (docs/architecture/github-app.md › The webhook).
// Every installation of the App delivers here, so the URL names no org: the delivery's own
// `installation.id` does, through the binding (`installationOrg`). In order:
//
//   1. the HMAC over the raw body, against GITHUB_APP_WEBHOOK_SECRET (constant time). No secret
//      configured, no signature, a bad one → the SAME bare 401 the per-repo hook gives, nothing written.
//   2. the installation the payload names → the org it is connected to. An installation Trov does not
//      know (the App was installed, never connected), or none in the payload → 202 ignored, no rows.
//   3. `installation` / `installation_repositories` events update the binding and the repositories'
//      marks, audited as `github-webhook` (a system actor).
//   4. anything else is a repository's event: the repository must be one THAT org tracks, and — as for
//      the per-repo hook — its PRIMARY (the capture's keys carry no repository). Otherwise 202 ignored.
//      Then the existing capture runs as that org's system tenant, exactly as the per-repo hook runs it.
//
// The same event may also arrive through the org's old per-repo (or legacy) webhook while both are
// configured: the capture's keys are per org, so the second arrival writes nothing
// (test/github-app.webhook.test.ts proves it).
//
// This module resolves credentials, so it must NOT be reachable from src/mcp.ts.
import type { Env } from "../env";
import { platform, systemTenant } from "../data/context";
import { json, unauthorized } from "../github-hook";
import { installationOrg } from "../platform/jobs";
import { captureDelivery, verifyGithubSignature, type DeliveryOpts } from "../webhook";
import { forgetInstallationToken } from "./api";
import { resolveGithubCredential } from "./credential";
import { forgetRepoList } from "./repos";
import { endInstallation, liveInstallation, notePermissionsAccepted, recordRepositoriesChanged, setInstallationSuspended, trackedRepo } from "./store";

export const APP_WEBHOOK_PATH = "/webhook/github/app";

const ignored = (): Response => json({ ok: true, ignored: true }, 202);
const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
/** `full_name`s out of an `installation_repositories` list — names only, bounded. */
const names = (v: unknown): string[] =>
  (Array.isArray(v) ? v : []).map((r) => record(r).full_name).filter((n): n is string => typeof n === "string").slice(0, 500);

export async function handleGithubAppWebhook(request: Request, env: Env, opts?: DeliveryOpts): Promise<Response> {
  const rawBody = await request.text();
  const secret = env.GITHUB_APP_WEBHOOK_SECRET;
  if (!secret || !(await verifyGithubSignature(secret, rawBody, request.headers.get("x-hub-signature-256")))) return unauthorized();

  let payload: Record<string, unknown>;
  try { payload = record(JSON.parse(rawBody)); } catch { return ignored(); }
  const installationId = record(payload.installation).id;
  if (typeof installationId !== "number" || !Number.isSafeInteger(installationId)) return ignored();

  const p = platform(env, "github-webhook");
  const bound = await installationOrg(p, installationId);
  if (!bound) return ignored();
  const ctx = systemTenant(p, bound.org_id, "github-webhook");
  const row = await liveInstallation(ctx);
  if (!row || row.installation_id !== installationId) return ignored();

  const event = request.headers.get("x-github-event") ?? "";
  const action = typeof payload.action === "string" ? payload.action : "";

  if (event === "installation") {
    if (action === "deleted") {
      await endInstallation(ctx, row, "uninstalled");
      forgetInstallationToken(env, installationId);
      forgetRepoList(installationId);
    } else if (action === "suspend" || action === "unsuspend") {
      await setInstallationSuspended(ctx, row, action === "suspend");
      forgetInstallationToken(env, installationId);
    } else if (action === "new_permissions_accepted") {
      await notePermissionsAccepted(ctx, row);
      forgetInstallationToken(env, installationId); // a token minted before carries the old permissions
    } else {
      return ignored(); // `created`: a binding is only ever made by the connect flow
    }
    return json({ ok: true, installation: action });
  }

  if (event === "installation_repositories") {
    if (action !== "added" && action !== "removed") return ignored();
    const selection = payload.repository_selection === "all" ? "all" : payload.repository_selection === "selected" ? "selected" : null;
    await recordRepositoriesChanged(ctx, row, { selection, added: names(payload.repositories_added), removed: names(payload.repositories_removed) });
    forgetRepoList(installationId);
    return json({ ok: true, repositories: action });
  }

  // A repository's event. A suspended ORG captures nothing (its per-repo hook reads as unknown too).
  if (bound.org_suspended) return ignored();
  const name = record(payload.repository).full_name;
  const repo = typeof name === "string" ? await trackedRepo(ctx, name) : null;
  if (!repo || repo.is_primary !== 1) return ignored();

  return captureDelivery(ctx, env, {
    repo: repo.repo_full_name,
    githubToken: async () => {
      const gh = await resolveGithubCredential(ctx, env, { repo: repo.repo_full_name, fetchImpl: opts?.fetchImpl }).catch(() => null);
      if (gh) await gh.markUsed();
      return gh?.token.reveal() ?? null;
    },
  }, event, rawBody, opts);
}

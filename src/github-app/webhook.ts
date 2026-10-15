// The GitHub App's ONE webhook, `POST /webhook/github/app` (docs/architecture/github-app.md › The webhook).
// Every installation of the App delivers here, so the URL names no org. An installation may be bound by
// SEVERAL orgs, and a repository may be tracked by several of them (0053_installation_repos). In order:
//
//   1. the HMAC over the raw body, against GITHUB_APP_WEBHOOK_SECRET (constant time). No secret
//      configured, no signature, a bad one → the SAME bare 401 the per-repo hook gives, nothing written.
//   2. the installation the payload names → the orgs it is connected to (`installationOrgs`). An
//      installation Trov does not know (the App was installed, never connected), or none in the
//      payload → 202 ignored, no rows.
//   3. `installation` / `installation_repositories` events are about the installation itself: EVERY org
//      bound to it has its binding and its own repositories' marks updated, audited as `github-webhook`
//      (a system actor). An org is told only of its own binding; no row names another org.
//   4. anything else is a repository's event, routed by the REPOSITORY to EVERY org bound to the
//      installation that tracks it and whose binding reaches it (`installationRepoOrgs`) — and, as for
//      the per-repo hook, only where it is that org's PRIMARY (the capture's keys carry no repository)
//      and the org is not suspended. No such org → 202 ignored. The existing capture then runs once per
//      org, as that org's system tenant, exactly as the per-repo hook runs it; each org's rows are its
//      own, and the answer GitHub gets is the worst of them.
//
// The same event may also arrive through the org's old per-repo (or legacy) webhook while both are
// configured: the capture's keys are per org, so the second arrival writes nothing
// (test/github-app.webhook.test.ts proves it).
//
// This module resolves credentials, so it must NOT be reachable from src/mcp.ts.
import type { Env } from "../env";
import { platform, systemTenant, type TenantContext } from "../data/context";
import { json, unauthorized } from "../github-hook";
import { installationOrgs, installationRepoOrgs } from "../platform/jobs";
import { captureDelivery, verifyGithubSignature, type DeliveryOpts } from "../webhook";
import { forgetInstallationToken } from "./api";
import { resolveGithubCredential } from "./credential";
import { forgetRepoList } from "./repos";
import { endInstallation, liveInstallation, notePermissionsAccepted, recordRepositoriesChanged, setInstallationSuspended, type InstallationRow } from "./store";

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
  const event = request.headers.get("x-github-event") ?? "";
  const action = typeof payload.action === "string" ? payload.action : "";

  if (event === "installation" || event === "installation_repositories") {
    // About the installation itself: every org bound to it, each as its own system tenant.
    const bound: { ctx: TenantContext; row: InstallationRow }[] = [];
    for (const org of await installationOrgs(p, installationId)) {
      const ctx = systemTenant(p, org.org_id, "github-webhook");
      const row = await liveInstallation(ctx);
      if (row && row.installation_id === installationId) bound.push({ ctx, row });
    }
    if (bound.length === 0) return ignored();

    if (event === "installation") {
      if (action === "deleted") {
        for (const { ctx, row } of bound) await endInstallation(ctx, row, "uninstalled");
        forgetInstallationToken(env, installationId);
        forgetRepoList(installationId);
      } else if (action === "suspend" || action === "unsuspend") {
        for (const { ctx, row } of bound) await setInstallationSuspended(ctx, row, action === "suspend");
        forgetInstallationToken(env, installationId);
      } else if (action === "new_permissions_accepted") {
        for (const { ctx, row } of bound) await notePermissionsAccepted(ctx, row);
        forgetInstallationToken(env, installationId); // a token minted before carries the old permissions
      } else {
        return ignored(); // `created`: a binding is only ever made by the connect flow
      }
      return json({ ok: true, installation: action });
    }

    if (action !== "added" && action !== "removed") return ignored();
    const selection = payload.repository_selection === "all" ? "all" : payload.repository_selection === "selected" ? "selected" : null;
    const change = { selection, added: names(payload.repositories_added), removed: names(payload.repositories_removed) } as const;
    for (const { ctx, row } of bound) await recordRepositoriesChanged(ctx, row, { ...change, added: [...change.added], removed: [...change.removed] });
    forgetRepoList(installationId);
    return json({ ok: true, repositories: action });
  }

  // A repository's event: every org that tracks the repository through this installation. A suspended
  // ORG captures nothing (its per-repo hook reads as unknown too).
  const name = record(payload.repository).full_name;
  const targets = (typeof name === "string" ? await installationRepoOrgs(p, installationId, name) : [])
    .filter((r) => !r.org_suspended && r.is_primary === 1);
  if (targets.length === 0) return ignored();

  // One org's capture failing must not cost the others theirs: all run, then the worst answer (or the
  // first throw) is what GitHub sees — a redelivery writes nothing twice (the capture's keys are per org).
  let worst: Response | null = null;
  let thrown: unknown = null;
  for (const repo of targets) {
    const ctx = systemTenant(p, repo.org_id, "github-webhook");
    try {
      const res = await captureDelivery(ctx, env, {
        repo: repo.repo_full_name,
        githubToken: async () => {
          const gh = await resolveGithubCredential(ctx, env, { repo: repo.repo_full_name, fetchImpl: opts?.fetchImpl }).catch(() => null);
          if (gh) await gh.markUsed();
          return gh?.token.reveal() ?? null;
        },
      }, event, rawBody, opts);
      if (!worst || res.status > worst.status) worst = res;
    } catch (e) {
      thrown ??= e;
    }
  }
  if (thrown) throw thrown;
  return worst ?? ignored();
}

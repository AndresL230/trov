// The org image's GitHub import, for a caller that has an org but not its credential
// (docs/architecture/organizations.md › The organization's image). The rule and the fetch are
// `importOrgLogo` (src/orgs/logo.ts); this module only finds what it needs — the org's PRIMARY
// repository and, when it has one, its `github_token` — and hands them down. It lives here because
// it resolves a credential: nothing reachable from src/mcp.ts may (test/secrets.mcp.test.ts).
//
// Called when a repository is connected or made primary and when the GitHub token is set or rotated
// (./routes.ts, after the response), when an uploaded image is removed (src/orgs/routes.ts), and by the
// periodic reconcile (src/repo/cron.ts). TOTAL: it never throws, and no log line carries the token.
import type { Context } from "hono";
import type { AppEnv } from "../auth/principal";
import type { Env } from "../env";
import type { PlatformContext, TenantContext } from "../data/context";
import { resolveCredential } from "../data/secrets";
import { jobTenant } from "../platform/jobs";
import { orgPrimaryRepo } from "../repo/config";
import { scrubbedMessage } from "../repo/github";
import { importOrgLogo, type LogoImport } from "../orgs/logo";

export interface ImportLogoOpts {
  fetchImpl?: typeof fetch;
  /** The periodic reconcile: an org with no GitHub token is not asked about at all — a background job
   *  makes no request on behalf of an org that has stored no credential (src/repo/cron.ts). */
  tokenOnly?: boolean;
}

/**
 * Import `caller`'s org's image from GitHub (`importOrgLogo`), as that org's system tenant — so the
 * org, its repository and its token all come from the ONE context, and a bearer context is refused
 * (`jobTenant`). An org with no primary repository imports nothing and asks nothing; one with no
 * (readable) token asks GitHub unauthenticated, which answers for any public owner — unless
 * `tokenOnly`, when it too imports nothing and asks nothing.
 */
export async function importLogoForOrg(env: Env, p: PlatformContext, caller: TenantContext, opts: ImportLogoOpts = {}): Promise<LogoImport> {
  let token: string | null = null;
  try {
    const ctx = jobTenant(env, caller);
    const repo = await orgPrimaryRepo(ctx);
    if (!repo) return { status: "no_repo" };
    // A secret that cannot be read (no key, a row that does not decrypt) reads as "no token".
    token = (await resolveCredential(ctx, env, "github_token", "").catch(() => null))?.reveal() ?? null;
    if (!token && opts.tokenOnly) return { status: "no_token" };
    return await importOrgLogo(p, env.ARTIFACTS_BUCKET, ctx.orgId, { repo: repo.repo, token, fetchImpl: opts.fetchImpl });
  } catch (e) {
    console.error("org logo import", scrubbedMessage(e, token ?? ""), `org=${caller.orgId}`);
    return { status: "failed", reason: "unexpected error" };
  }
}

/**
 * Run the import AFTER the response (`waitUntil`): the write that caused it — a repository connected,
 * a token set — never waits on GitHub and cannot fail because of it. A request with no ExecutionContext
 * schedules nothing (Hono throws on the getter), so nothing is started that nobody would wait for.
 */
export function importLogoLater(c: Context<AppEnv>): void {
  let ec: { waitUntil(promise: Promise<unknown>): void };
  try { ec = c.executionCtx; } catch { return; }
  ec.waitUntil(importLogoForOrg(c.env, c.var.p, c.var.ctx));
}

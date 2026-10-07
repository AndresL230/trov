// THE org's GitHub credential (docs/architecture/github-app.md › Tokens). Every GitHub read Trov makes on
// an org's behalf — the reconcile, the progress backstop, Sync GitHub, the webhook's follow-up reads,
// the org image's import — asks HERE, in this order:
//
//   1. the org's live GitHub App installation → an installation token (minted, or the isolate's cached
//      one) for THAT repository alone, read-only (`repoScope`); with no repository named, a token for
//      the installation itself, which carries Metadata only (`INSTALLATION_SCOPE`);
//   2. the org's stored `github_token` (Org settings › Integrations);
//   3. for SaplingLearn alone, the Worker's legacy GITHUB_SERVICE_TOKEN (`resolveCredential`'s fallback).
//
// This module resolves credentials, so NOTHING REACHABLE FROM src/mcp.ts MAY IMPORT IT
// (test/secrets.mcp.test.ts): it is called from the modules that already resolved the token —
// src/repo/cron.ts, src/github-hook.ts, src/tools/backfill.ts, src/sync/runs.ts (which only asks
// WHERE it would come from — `githubCredentialSource`), src/integrations/logo.ts, and this folder's
// routes and webhook — and the revealed value goes down to the readers as a parameter.
//
// An installation that cannot give a token does not cost the org its reads: the failure is recorded on
// the binding (and ends or suspends it when GitHub says that is what happened), and the stored token
// answers instead. Nothing is retried inside one resolve.
import type { Env } from "../env";
import { Secret, SecretAccessError, markSecretUsed, recordSecretOutcome, resolveCredential, type Revealed } from "../data/secrets";
import type { TenantContext } from "../data/sql";
import { INSTALLATION_SCOPE, appCanSign, forgetInstallationToken, installationToken, repoScope, type AppRefusal, type TokenScope } from "./api";
import { endInstallation, liveInstallation, markInstallationUsed, recordInstallationOutcome, setInstallationSuspended, type InstallationRow } from "./store";

export type GithubCredentialSource = "app" | "token";
export type CredentialOutcome = { ok: true } | { ok: false; message: string; revealed: Revealed };

export interface GithubCredential {
  /** Revealed at the ONE line that builds the Authorization header; `[secret]` anywhere else. */
  token: Secret;
  source: GithubCredentialSource;
  /** The installation the token is for (`source: "app"`). */
  installation: InstallationRow | null;
  /** The fetch to read GitHub with: for an installation token it also notices a 401 (the token was
   *  revoked — uninstalled or suspended since it was minted) and forgets the cached token. */
  fetch(fetchImpl?: typeof fetch): typeof fetch | undefined;
  /** `last_used_at` on whichever row holds this credential (throttled). Never throws. */
  markUsed(now?: number): Promise<void>;
  /** `last_error` / `last_used_at` on whichever row holds this credential. Never throws. */
  recordOutcome(outcome: CredentialOutcome, now?: number): Promise<void>;
}

export interface ResolveOpts {
  /** The repository about to be read (`owner/repo`). An installation covers ONE account's repositories,
   *  so it answers only for a repository that account owns; anything else is the stored token's. The
   *  installation's token is minted for this repository ONLY. Absent = a call about the installation
   *  itself (its repository list): a token that spans it and carries Metadata alone. */
  repo?: string | null;
  fetchImpl?: typeof fetch;
  now?: number;
  /** Only the installation: no fallback to the stored token (Test connection on the App's own row). */
  appOnly?: boolean;
}

const covers = (row: InstallationRow, repo: string | null | undefined): boolean =>
  !repo || repo.split("/")[0]?.toLowerCase() === row.account_login.toLowerCase();

/** What a refused mint means for the binding: GitHub no longer knows the installation → it is ended;
 *  suspended → marked so; anything else (the App's own credentials, an outage, a repository the
 *  installation does not cover) → `last_error` only. The first two kill every token of the installation;
 *  the rest say nothing about the tokens other repositories hold. */
async function noteRefusal(ctx: TenantContext, env: Env, row: InstallationRow, refusal: AppRefusal, now: number): Promise<void> {
  try {
    if (refusal.kind === "not_found" || refusal.kind === "suspended") forgetInstallationToken(env, row.installation_id);
    if (refusal.kind === "not_found") { await endInstallation(ctx, row, "not_found"); return; }
    if (refusal.kind === "suspended") await setInstallationSuspended(ctx, row, true);
    await recordInstallationOutcome(ctx, row, { ok: false, message: refusal.message, revealed: [] }, now);
  } catch { /* bookkeeping must not cost the job */ }
}

function appCredential(ctx: TenantContext, env: Env, row: InstallationRow, scope: TokenScope, token: string): GithubCredential {
  return {
    token: new Secret(token), source: "app", installation: row,
    fetch: (fetchImpl) => {
      const inner: typeof fetch = fetchImpl ?? ((input, init) => fetch(input, init));
      return async (input, init) => {
        const res = await inner(input, init);
        if (res.status === 401) forgetInstallationToken(env, row.installation_id, scope); // this token, not its siblings
        return res;
      };
    },
    markUsed: (now) => markInstallationUsed(ctx, row, now).catch(() => undefined),
    recordOutcome: (outcome, now) => recordInstallationOutcome(ctx, row, outcome, now).catch(() => undefined),
  };
}

function tokenCredential(ctx: TenantContext, token: Secret): GithubCredential {
  return {
    token, source: "token", installation: null,
    fetch: (fetchImpl) => fetchImpl,
    markUsed: (now) => markSecretUsed(ctx, "github_token", "", now).catch(() => undefined),
    recordOutcome: (outcome, now) => recordSecretOutcome(ctx, "github_token", "", outcome, now).catch(() => undefined),
  };
}

/** Step 1 of the order, before any token is asked for: the org's live, unsuspended installation, when
 *  the App can sign and the installation's account owns `repo`. */
async function answeringInstallation(ctx: TenantContext, env: Env, repo: string | null | undefined): Promise<InstallationRow | null> {
  const row = appCanSign(env) ? await liveInstallation(ctx) : null;
  return row && row.suspended_at === null && covers(row, repo) ? row : null;
}

/**
 * WHERE `resolveGithubCredential` would get the org's credential from, asked WITHOUT minting or
 * revealing anything — `app`, `token`, or null when the org has none. The same order and the same
 * access rule (it throws for a bearer context and for a member). It is what a status read asks
 * (`GET /sync`, polled by every member's page): a read must not cost GitHub a token request.
 *
 * `app` is a statement about the binding, not a promise that GitHub will issue the token: a mint
 * GitHub refuses is found by the run that needs it, which then falls back to the stored token.
 */
export async function githubCredentialSource(ctx: TenantContext, env: Env, opts: Pick<ResolveOpts, "repo"> = {}): Promise<GithubCredentialSource | null> {
  if (ctx.via === "bearer" || ctx.role === "member") throw new SecretAccessError();
  if (await answeringInstallation(ctx, env, opts.repo)) return "app";
  return (await resolveCredential(ctx, env, "github_token", "")) ? "token" : null;
}

/**
 * The credential to read GitHub with for `ctx`'s org, or null when it has none. Same access rule as
 * `getSecret`: it THROWS for an MCP (bearer) context and for a plain member, before anything is looked
 * up — a system context (cron, webhook) and an admin's session are served.
 */
export async function resolveGithubCredential(ctx: TenantContext, env: Env, opts: ResolveOpts = {}): Promise<GithubCredential | null> {
  if (ctx.via === "bearer" || ctx.role === "member") throw new SecretAccessError();
  const now = opts.now ?? Date.now();
  const row = await answeringInstallation(ctx, env, opts.repo);
  if (row) {
    const scope = opts.repo ? repoScope(opts.repo) : INSTALLATION_SCOPE;
    const minted = await installationToken(env, row.installation_id, scope, opts.fetchImpl, now);
    if (minted.ok) return appCredential(ctx, env, row, scope, minted.token);
    await noteRefusal(ctx, env, row, minted, now);
  }
  if (opts.appOnly) return null;
  const stored = await resolveCredential(ctx, env, "github_token", "");
  return stored ? tokenCredential(ctx, stored) : null;
}

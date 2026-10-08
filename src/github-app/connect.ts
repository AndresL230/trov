// Connecting an org to a GitHub App installation (docs/architecture/github-app.md › The connect flow).
//
//   GET /api/o/:slug/github/install            an org ADMIN starts it (`startInstall`): a sealed cookie
//                                              binds { org, person, state, expiry }, then GitHub's install page.
//   GET /auth/callback?code&installation_id&setup_action&state
//                                              GitHub's return after an install (`installReturn`).
//   GET /api/o/:slug/github/install?existing=1 link an installation that ALREADY exists: an ordinary
//                                              authorization (state + PKCE, src/auth/tx.ts), back to the
//                                              same callback (`connectReturn`).
//
// THE SECURITY OF THE FEATURE IS `verifyAndBind`. `installation_id` arrives in a URL, so by itself it
// proves nothing: anyone can type one. An installation is bound to an org only when ALL of these hold —
//   1. the browser holds OUR sealed cookie, unexpired, and the `state` in the URL is the one in it
//      (so this return answers a flow this browser started, for that org);
//   2. the person signed in to Trov NOW is the person the cookie names, and is still an admin of that org;
//   3. the code exchanges for a GitHub user token, and that GitHub account is this person's own linked
//      GitHub identity (login, pinned numeric id) — the same match sign-in makes;
//   4. GitHub itself lists the installation among those this user token can reach (`GET /user/installations`);
//   5. that GitHub account can read EVERY repository the installation covers — the installation's
//      repository ids are a subset of the ids GitHub says this user can read in it — so the org gains
//      nothing through the installation that the person connecting it could not already read (a
//      collaborator on one repository must not be able to attach an organization's whole installation);
//   6. no other Trov org holds the installation. An org holds ONE: connecting a different one (the App
//      on another GitHub account) REPLACES the org's current binding, in the same write.
// A failure at any step redirects to Org settings with a sentence and writes NOTHING. Every outcome is a
// redirect — a human never gets JSON here.
//
// The GitHub user token exists only to answer 3–5. Once the decision is made — bound or refused — it is
// revoked at GitHub (`dropUserToken`), after the redirect and whatever that revoke comes to.
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { GITHUB_LOGIN_RE } from "@shared/orgs";
import type { GithubConnectOutcome } from "@shared/github-app";
import { b64uDecode, b64uEncode, hmacSeal, hmacUnseal, randomToken } from "../auth/crypto";
import { buildAuthorizeUrl, exchangeCode, getUser } from "../auth/github";
import { findIdentity } from "../auth/persons";
import { resolveSessionPrincipal, type AppEnv, type Principal } from "../auth/principal";
import { OAUTH_TX_COOKIE, beginTx, callbackUrl } from "../auth/tx";
import { hasRole, resolveTenantById, type TenantContext } from "../data/context";
import { importLogoForOrg } from "../integrations/logo";
import { listMyOrgs } from "../orgs/repo";
import { installationOrg } from "../platform/jobs";
import {
  INSTALLATION_SCOPE, appConfigured, appSlug, forgetInstallationToken, getInstallation, installUrl, installationRepoIds, installationToken, listUserInstallations,
  revokeUserToken, userInstallationRepoIds, type AppRefusal,
} from "./api";
import { forgetRepoList, visibleRepos } from "./repos";
import { InstallationConflictError, bindInstallation, liveInstallation } from "./store";

type C = Context<AppEnv>;
export interface ConnectDeps { fetchImpl?: typeof fetch; now?: () => number }

// ── the sealed intent ────────────────────────────────────────────────────────

export const INSTALL_COOKIE = "gh_install";
/** How long an admin has to finish on GitHub: choosing an account and its repositories takes a while. */
export const INSTALL_TTL_S = 15 * 60;
const COOKIE_PATH = "/auth";

interface Intent {
  org: string;      // the org id the installation is to be connected to
  slug: string;     // its slug, for the redirect back (immutable)
  person: string;   // the handle of the admin who started
  state: string;
  /** `install`: GitHub's install page. `existing`: an authorization, to find an installation that is already there. */
  mode: "install" | "existing";
  /** `existing` only: the GitHub account whose installation was picked when there were several. */
  account?: string;
  exp: number;
}

const sealKey = (secret: string): string => `gh-install:${secret}`;
const sealIntent = (i: Intent, secret: string): Promise<string> => hmacSeal(b64uEncode(JSON.stringify(i)), sealKey(secret));

/** The intent a cookie carries, or null: absent, tampered, sealed with another key, or not the shape.
 *  Expiry is NOT checked here — an expired intent still says which org to send the person back to. */
async function openIntent(c: C): Promise<Intent | null> {
  const sealed = getCookie(c, INSTALL_COOKIE);
  const value = sealed ? await hmacUnseal(sealed, sealKey(c.env.COOKIE_SECRET)) : null;
  if (!value) return null;
  try {
    const o = JSON.parse(b64uDecode(value)) as Partial<Intent> | null;
    if (!o || typeof o.org !== "string" || typeof o.slug !== "string" || typeof o.person !== "string" || typeof o.state !== "string" || typeof o.exp !== "number") return null;
    if (o.mode !== "install" && o.mode !== "existing") return null;
    return o as Intent;
  } catch {
    return null;
  }
}

const nowOf = (deps: ConnectDeps): number => (deps.now ? deps.now() : Date.now());

/** Org settings › Repositories of `slug`, with what happened as the `github` query value. */
const back = (c: C, slug: string, outcome: GithubConnectOutcome, extra = ""): Response =>
  c.redirect(`/${slug}/?github=${outcome}${extra}#org/repos`, 302);

/** The signed-in person on a path the session gate lets through unauthenticated (`/auth/callback`). */
async function currentPerson(c: C): Promise<Principal | null> {
  if (c.env.DEV_LOGIN) return { handle: c.env.DEV_LOGIN }; // local dev only, as in `sessionGate`
  return resolveSessionPrincipal(c);
}

/** Where a signed-in person lands when the return names no org of ours: the Repositories tab of the
 *  first org they administer, with the sentence; with none, the app's root. */
async function homeFor(c: C, handle: string, outcome: GithubConnectOutcome): Promise<string> {
  const org = (await listMyOrgs(c.var.p, handle)).find((o) => o.role === "owner" || o.role === "admin");
  return org ? `/${org.slug}/?github=${outcome}#org/repos` : "/";
}

// ── start ────────────────────────────────────────────────────────────────────

/**
 * `GET /api/o/:slug/github/install[?existing=1[&account=<login>]]` — behind `tenantGate`, cookie only.
 * A browser navigation, so every refusal is a redirect back to the tab, not JSON.
 */
export async function startInstall(c: C, deps: ConnectDeps = {}): Promise<Response> {
  const ctx = c.var.ctx;
  const slug = c.req.param("slug") ?? "";
  // A GET that starts something must be started from Trov's own page: a link on another site (which
  // the session cookie, SameSite=Lax, would follow) could otherwise begin — and, for `existing`, with
  // GitHub's instant re-authorization, FINISH — a connection the admin never asked for. Browsers say
  // where a navigation came from; one typed or bookmarked (`none`) is the person's own.
  const from = c.req.header("sec-fetch-site");
  if (from && from !== "same-origin" && from !== "none") return back(c, slug, "expired");
  if (!hasRole(ctx, "admin")) return back(c, slug, "not_admin");
  const app = appConfigured(c.env) ? appSlug(c.env) : null;
  if (!app) return back(c, slug, "not_configured");
  const existing = c.req.query("existing") === "1";
  const account = c.req.query("account");
  const base = { org: ctx.orgId, slug, person: ctx.userId, exp: nowOf(deps) + INSTALL_TTL_S * 1000 };
  const seal = async (i: Intent): Promise<void> => {
    setCookie(c, INSTALL_COOKIE, await sealIntent(i, c.env.COOKIE_SECRET), { httpOnly: true, secure: true, sameSite: "Lax", path: COOKIE_PATH, maxAge: INSTALL_TTL_S });
  };
  if (existing) {
    // An ordinary authorization: our state AND a PKCE challenge, exactly as sign-in sends them.
    const { state, challenge } = await beginTx(c, "connect");
    await seal({ ...base, state, mode: "existing", ...(account && GITHUB_LOGIN_RE.test(account) ? { account } : {}) });
    return c.redirect(buildAuthorizeUrl({ clientId: c.env.GITHUB_CLIENT_ID, redirectUri: callbackUrl(c.req.url), state, challenge }), 302);
  }
  const state = randomToken(16);
  await seal({ ...base, state, mode: "install" });
  return c.redirect(installUrl(app, state), 302);
}

// ── the checks, and the write ────────────────────────────────────────────────

type Verdict = { outcome: GithubConnectOutcome; extra?: string };
const no = (outcome: GithubConnectOutcome, extra?: string): Verdict => ({ outcome, extra });

const refusedAs = (r: AppRefusal): GithubConnectOutcome =>
  r.kind === "suspended" ? "suspended" : r.kind === "credentials" ? "not_configured" : "github_failed";

/** What is to be bound: the installation GitHub's install return named, or — linking an existing one —
 *  whichever this account can reach (optionally narrowed to one GitHub account). */
type Pick = { installationId: number } | { account?: string };

/**
 * Checks 2–6 of this file's header, then the binding. `userToken` is the GitHub user token the code was
 * exchanged for; it is used for these reads and revoked by the caller — never stored, never logged.
 */
async function verifyAndBind(c: C, deps: ConnectDeps, intent: Intent, userToken: string, pick: Pick): Promise<Verdict> {
  const f = deps.fetchImpl;
  const p = c.var.p;
  // 2 — the person who started is the person here now, and still an admin of that org.
  const me = await currentPerson(c);
  if (!me || me.handle.toLowerCase() !== intent.person.toLowerCase()) return no("wrong_person");
  const ctx: TenantContext | null = await resolveTenantById(c.env, me.handle, intent.org, "session");
  if (!ctx || !hasRole(ctx, "admin")) return no("not_admin");
  if (!appConfigured(c.env)) return no("not_configured");

  // 3 — the GitHub account behind the code is this person's own linked identity.
  const gh = await getUser(userToken, f);
  if (!gh) return no("github_failed");
  const known = await findIdentity(p, "github", gh.login);
  const sameAccount = !!known && known.person.toLowerCase() === me.handle.toLowerCase() && !(known.provider_uid && gh.id && known.provider_uid !== gh.id);
  if (!sameAccount) return no("wrong_account");

  // 4 — GitHub lists the installation among those this account can reach. A list that did not arrive
  //     in full is not a yes.
  const mine = await listUserInstallations(userToken, f);
  if (!mine) return no("github_failed");
  let installationId: number;
  if ("installationId" in pick) {
    if (!mine.some((i) => i.installation_id === pick.installationId)) return no("not_yours");
    installationId = pick.installationId;
  } else {
    const wanted = pick.account?.toLowerCase();
    const reachable = wanted ? mine.filter((i) => i.account_login.toLowerCase() === wanted) : mine;
    if (reachable.length === 0) return no("none_found");
    const free: typeof reachable = [];
    for (const i of reachable.slice(0, 20)) {
      const held = await installationOrg(p, i.installation_id);
      if (!held || held.org_id === ctx.orgId) free.push(i);
    }
    if (free.length === 0) return no("taken");
    if (free.length > 1) {
      const accounts = free.map((i) => i.account_login).filter((l) => GITHUB_LOGIN_RE.test(l)).slice(0, 10);
      return no("choose", `&accounts=${accounts.map(encodeURIComponent).join(",")}`);
    }
    installationId = free[0].installation_id;
  }

  // 6 — one org per installation (the unique index says so again at the write). An org has one
  //     installation: a different one — the admin chose another GitHub account — takes the place of
  //     the org's current binding, ended in the same batch as the new one is written.
  const held = await installationOrg(p, installationId);
  if (held && held.org_id !== ctx.orgId) return no("taken");
  const live = await liveInstallation(ctx);
  const replaced = live && live.installation_id !== installationId ? live : null;

  // The installation's account, from GitHub AS THE APP — never from the URL, never from the user's list.
  const info = await getInstallation(c.env, installationId, f, nowOf(deps));
  if (!info.ok) {
    if (info.kind === "credentials") console.error("github app connect: GitHub refused the App's credentials");
    return no(refusedAs(info));
  }
  if (info.installation.suspended_at !== null) return no("suspended");

  // 5 — no escalation: every repository the installation covers is one this account can read. Compared
  //     by repository ID, the whole of both lists — two counts can agree while the repositories differ.
  //     The same for a personal account's installation: its owner reads all of it, and passes. An
  //     installation too large to list in `REPO_ID_PAGES` pages is refused, never guessed at; so is a
  //     list that did not arrive in full. The refusal carries a COUNT, never a repository's name.
  const minted = await installationToken(c.env, installationId, INSTALLATION_SCOPE, f, nowOf(deps));
  if (!minted.ok) return no(refusedAs(minted));
  const covered = await installationRepoIds(minted.token, f);
  if (!covered.ok) return no(covered.reason === "too_many" ? "too_many_repos" : "github_failed");
  const readable = await userInstallationRepoIds(userToken, installationId, f);
  if (!readable.ok) return no("github_failed");
  let unreadable = 0;
  for (const id of covered.ids) if (!readable.ids.has(id)) unreadable++;
  if (unreadable > 0) return no("partial_access", `&missing=${unreadable}`);

  try {
    await bindInstallation(ctx, info.installation, replaced);
  } catch (e) {
    if (e instanceof InstallationConflictError) return no("taken");
    throw e;
  }
  if (replaced) { // what the isolate held for the installation that was replaced, as Disconnect drops it
    forgetInstallationToken(c.env, replaced.installation_id);
    forgetRepoList(replaced.installation_id);
  }
  // Courtesies, after the binding stands: mark the org's repositories the installation can see, and let
  // the org's image follow its repository's owner. Neither can undo or fail the connection.
  await visibleRepos(ctx, c.env, { fetchImpl: f, refresh: true, now: nowOf(deps) }).catch(() => undefined);
  try { c.executionCtx.waitUntil(importLogoForOrg(c.env, p, ctx, { fetchImpl: f })); } catch { /* no ExecutionContext (a test): nothing is scheduled */ }
  return { outcome: "connected" };
}

// ── GitHub's return after an install ─────────────────────────────────────────

/** A return from the App's install page carries parameters a sign-in never does. */
export const isInstallReturn = (c: C): boolean => c.req.query("installation_id") !== undefined || c.req.query("setup_action") !== undefined;

/** Does this request answer a SIGN-IN this browser started (its sealed transaction's state)? Read
 *  only — the sign-in path opens and spends the cookie itself. */
async function answersSignIn(c: C): Promise<boolean> {
  const state = c.req.query("state");
  const sealed = getCookie(c, OAUTH_TX_COOKIE);
  if (!state || !sealed || !c.req.query("code")) return false;
  const tx = await hmacUnseal(sealed, c.env.COOKIE_SECRET);
  return !!tx && tx.split(".")[0] === state;
}

/**
 * `GET /auth/callback` with `installation_id` / `setup_action`. Returns the response, or null when this
 * is not an install Trov started AND the request answers a sign-in transaction — the caller then runs
 * the ordinary sign-in, unchanged.
 *
 * An install or update Trov did not start (installed from GitHub's side, "Configure" there) carries no
 * cookie of ours: NOTHING is bound. A signed-in person is sent to their Repositories tab with how to
 * connect it from there; anyone else to the landing page. The code such a return carries is NOT used to
 * sign anyone in: with no state of ours behind it, that would be a sign-in an attacker could start in
 * someone else's browser.
 */
export async function installReturn(c: C, deps: ConnectDeps = {}): Promise<Response | null> {
  const intent = await openIntent(c);
  const action = c.req.query("setup_action") ?? "";
  if (!intent || intent.mode !== "install") {
    const me = await currentPerson(c);
    if (me) return c.redirect(await homeFor(c, me.handle, action === "request" ? "requested" : "unlinked"), 302);
    return (await answersSignIn(c)) ? null : c.redirect("/", 302);
  }
  deleteCookie(c, INSTALL_COOKIE, { path: COOKIE_PATH });
  // A member asked a GitHub organization owner to approve: there is no installation yet.
  if (action === "request") return back(c, intent.slug, "requested");
  // 1 — our cookie, unexpired, and the state GitHub handed back is the one sealed in it.
  const state = c.req.query("state");
  if (intent.exp <= nowOf(deps) || !state || state !== intent.state) return back(c, intent.slug, "expired");
  const code = c.req.query("code");
  const rawId = c.req.query("installation_id") ?? "";
  // Digits only: `Number()` would also read "1e3", " 12 " or "0x1f" as an id.
  if (!code || !/^[1-9][0-9]{0,15}$/.test(rawId)) return back(c, intent.slug, "github_failed");
  return finish(c, deps, intent, { installationId: Number(rawId) }, () =>
    // GitHub began this authorization itself (the App asks for it during installation), so there is no
    // code_challenge of ours to answer and no redirect_uri of ours to repeat: neither is sent.
    exchangeCode({ env: c.env, code, fetchImpl: deps.fetchImpl }));
}

/**
 * Revoke the GitHub user token: the decision it was needed for has been made. Best effort, and never in
 * the person's way — it runs after the response (`waitUntil`); with no ExecutionContext (a test) it is
 * awaited, and `revokeUserToken` neither throws nor outlives its own short timeout. A revoke GitHub did
 * not confirm is one fixed line in the log — never the token, never GitHub's answer.
 */
async function dropUserToken(c: C, deps: ConnectDeps, userToken: string): Promise<void> {
  const revoked = revokeUserToken(c.env, userToken, deps.fetchImpl)
    .then((ok) => { if (!ok) console.error("github app connect: GitHub did not confirm revoking the user token"); })
    .catch(() => undefined);
  let ec: { waitUntil(promise: Promise<unknown>): void } | null = null;
  try { ec = c.executionCtx; } catch { /* no ExecutionContext (a test) */ }
  if (ec) ec.waitUntil(revoked); else await revoked;
}

/** Run the exchange and the checks; whatever happens, the person gets a redirect with a sentence. A
 *  thrown fetch (GitHub unreachable) is "GitHub did not answer" — logged by NAME, never the Error. Once
 *  a user token exists it is revoked on EVERY way out: bound, refused, or thrown. */
async function finish(c: C, deps: ConnectDeps, intent: Intent, pick: Pick, exchange: () => Promise<string | null>): Promise<Response> {
  let userToken: string | null = null;
  let verdict: Verdict;
  try {
    userToken = await exchange();
    verdict = userToken ? await verifyAndBind(c, deps, intent, userToken, pick) : no("github_failed");
  } catch (e) {
    console.error("github app connect failed", e instanceof Error ? e.name : "error", `org=${intent.org}`);
    verdict = no("github_failed");
  }
  if (userToken) await dropUserToken(c, deps, userToken);
  return back(c, intent.slug, verdict.outcome, verdict.extra);
}

/**
 * `GET /auth/callback` for a `connect` transaction (src/auth/routes.ts has already checked the sealed
 * transaction's state and holds its PKCE verifier): the admin asked to link an installation that already
 * exists. The same checks, with the installation found from GitHub's own list.
 */
export async function connectReturn(c: C, deps: ConnectDeps, code: string, verifier: string): Promise<Response> {
  const intent = await openIntent(c);
  deleteCookie(c, INSTALL_COOKIE, { path: COOKIE_PATH });
  if (!intent || intent.mode !== "existing" || intent.state !== c.req.query("state")) {
    const me = await currentPerson(c);
    return c.redirect(me ? await homeFor(c, me.handle, "expired") : "/", 302);
  }
  if (intent.exp <= nowOf(deps)) return back(c, intent.slug, "expired");
  return finish(c, deps, intent, { account: intent.account }, () =>
    exchangeCode({ env: c.env, code, redirectUri: callbackUrl(c.req.url), verifier, fetchImpl: deps.fetchImpl }));
}

// The GitHub App's install flow (spec §8): an org ADMIN installs the App on GitHub, GitHub sends the browser
// back, and Trov binds the installation to the org — but only after GitHub itself, asked with the admin's
// OWN user token, confirms that they can read every repository the installation covers.
//
//   1. `startInstall` (`POST /api/o/:slug/github/install`): seals the `gh_install` cookie — { org, slug,
//      handle, nonce, exp } for 30 minutes, path `/github/app` — and answers GitHub's install URL, the
//      nonce as its `state`.
//   2. `githubAppSetup` (`GET /github/app/setup`, the App's Setup URL AND Callback URL):
//        • a session AND a `gh_install` cookie naming the SAME person, unexpired, who is STILL an admin of
//          that org — else a refusal page (never a redirect into an org);
//        • `setup_action=request` (a GitHub org member asked an owner to approve) → back to the org;
//        • no `code` → the installation id is re-sealed into the cookie and the browser goes to GitHub's
//          OAuth authorize with the nonce as `state`;
//        • `code` → `state` must equal the nonce; the code becomes a user token; the installation is read
//          (App JWT), its repositories listed (an installation token minted for metadata only), and the
//          repositories THE PERSON can read in it listed (their user token). Bound only when the second
//          list covers the first.
//
// An installation id from the query string is never trusted: everything about it is re-read from GitHub,
// and the person's own token decides whether they may connect it. The user token is revoked best effort the
// moment the flow is done with it, and is never stored, logged or rendered; every message logged here is
// scrubbed of it, of the installation token, of the code and of the App's secrets. Never a 500.
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { GithubInstallOutcome, GithubInstallStartDTO } from "@shared/github-app";
import type { AppEnv } from "../auth/principal";
import { b64uDecode, b64uEncode, hmacSeal, hmacUnseal, randomToken } from "../auth/crypto";
import { getSessionUser, readSessionCookie } from "../auth/session";
import { oauthOrigin } from "../auth/oauth";
import { RoleError, hasRole, platform, resolveTenantById, type TenantContext } from "../data/context";
import { scrub, type Revealed, type Secret } from "../data/secrets";
import {
  GithubAppError, exchangeUserCode, getAppInstallation, listInstallationRepos, listUserInstallationRepos,
  mintInstallationToken, revokeUserToken, type InstallationRepo, type TokenPermissions,
} from "./client";
import { appSecrets, githubAppConfig, type GithubAppConfig } from "./config";
import { InstallationBoundElsewhereError, bindInstallation } from "./installations";
import { backTo, installRefusalPage } from "./pages";

export const GH_INSTALL_COOKIE = "gh_install";
export const GH_INSTALL_TTL_S = 30 * 60;
/** The App's Setup URL and its Callback URL (spec §11) — one route for both hops. */
export const SETUP_PATH = "/github/app/setup";
/** The cookie is sent to the callback and nowhere else. */
const COOKIE_PATH = "/github/app";
/** Its own purpose label: a sealed session id, onboard or oauth_pending value never opens as this. */
const sealKey = (secret: string): string => `gh-install:${secret}`;

/** The one permission a listing token needs. Trov reads repositories through it and nothing else. */
export const LISTING_PERMISSIONS: TokenPermissions = { metadata: "read" };

export interface InstallDeps {
  /** Tests stub GitHub here; nothing in the flow reaches the network without it in a test. */
  fetchImpl?: typeof fetch;
  /** The flow's clock: the cookie's expiry and the App JWT. */
  now?: () => number;
}

// ── the cookie ───────────────────────────────────────────────────────────────

export interface InstallState {
  org: string;       // org id — the membership re-check reads it, never the slug
  slug: string;      // where the browser goes back to
  handle: string;    // the admin who started it; the callback's session must be the same person
  nonce: string;     // GitHub's `state`, on the install URL and the authorize hop
  exp: number;       // ms
  installation_id?: number; // set by the callback's first hop
}

const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-ancestors 'none'; form-action 'none'; base-uri 'none'";

const cookieOpts = (maxAge: number) => ({ path: COOKIE_PATH, httpOnly: true, secure: true, sameSite: "Lax" as const, maxAge });

async function writeState(c: Context<AppEnv>, st: InstallState, maxAge: number): Promise<void> {
  setCookie(c, GH_INSTALL_COOKIE, await hmacSeal(b64uEncode(JSON.stringify(st)), sealKey(c.env.COOKIE_SECRET)), cookieOpts(maxAge));
}

const clearState = (c: Context<AppEnv>): void => { deleteCookie(c, GH_INSTALL_COOKIE, { path: COOKIE_PATH, secure: true, httpOnly: true, sameSite: "Lax" }); };

/** A positive integer id as GitHub writes one — digits only, no sign, no exponent, no leading zero. */
export function parseInstallationId(raw: string | undefined | null): number | null {
  if (typeof raw !== "string" || !/^[1-9][0-9]{0,15}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/** The cookie's state, `"expired"`, or null (absent, tampered, malformed). */
async function readState(c: Context<AppEnv>, now: number): Promise<InstallState | "expired" | null> {
  const sealed = getCookie(c, GH_INSTALL_COOKIE);
  if (!sealed) return null;
  const v = await hmacUnseal(sealed, sealKey(c.env.COOKIE_SECRET));
  if (!v) return null;
  let o: Record<string, unknown>;
  try { o = JSON.parse(b64uDecode(v)) as Record<string, unknown>; } catch { return null; }
  if (!o || typeof o !== "object") return null;
  const str = (k: string) => (typeof o[k] === "string" && (o[k] as string).length > 0 ? (o[k] as string) : null);
  const org = str("org"), slug = str("slug"), handle = str("handle"), nonce = str("nonce");
  if (!org || !slug || !handle || !nonce || typeof o.exp !== "number") return null;
  const id = o.installation_id === undefined ? undefined : typeof o.installation_id === "number" && Number.isSafeInteger(o.installation_id) && o.installation_id > 0 ? o.installation_id : null;
  if (id === null) return null;
  if (o.exp <= now) return "expired";
  return { org, slug, handle, nonce, exp: o.exp, ...(id !== undefined ? { installation_id: id } : {}) };
}

function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// ── 1. start ─────────────────────────────────────────────────────────────────

/**
 * Start an install for `ctx`'s org (an admin's session): seal `gh_install` onto the response and answer
 * where the browser goes next. `slug` is the org's slug as the path named it — where the callback returns.
 */
export async function startInstall(c: Context<AppEnv>, cfg: GithubAppConfig, ctx: TenantContext, slug: string, deps: InstallDeps = {}): Promise<GithubInstallStartDTO> {
  if (ctx.via !== "session" || !hasRole(ctx, "admin")) throw new RoleError();
  const nonce = randomToken(24);
  const now = (deps.now ?? Date.now)();
  await writeState(c, { org: ctx.orgId, slug, handle: ctx.userId, nonce, exp: now + GH_INSTALL_TTL_S * 1000 }, GH_INSTALL_TTL_S);
  return { url: `https://github.com/apps/${encodeURIComponent(cfg.slug)}/installations/new?state=${encodeURIComponent(nonce)}` };
}

// ── 2. the callback ──────────────────────────────────────────────────────────

/** Every answer the callback gives carries these: nothing cached, and the URL (which held a code and a
 *  state) never leaves in a Referer. */
const HEADERS = { "cache-control": "no-store", "referrer-policy": "no-referrer" };

type PageStatus = 400 | 403 | 409 | 503;

/** A refusal page. Ends the flow: the cookie goes with it. */
function refuse(c: Context<AppEnv>, status: PageStatus, title: string, message: string, slug: string | null): Response {
  clearState(c);
  return c.html(installRefusalPage({ title, message, slug }), status, { ...HEADERS, "x-frame-options": "DENY", "content-security-policy": PAGE_CSP });
}

function redirect(c: Context<AppEnv>, location: string): Response {
  for (const [k, v] of Object.entries(HEADERS)) c.header(k, v);
  return c.redirect(location, 302);
}

/** Back to the org's Repositories screen with the outcome the SPA flashes. Ends the flow. */
function landing(c: Context<AppEnv>, slug: string, outcome: GithubInstallOutcome): Response {
  clearState(c);
  return redirect(c, `${backTo(slug)}?github=${outcome}`);
}

/** The signed-in person, read here because this path is public to `sessionGate` (a missing session gets a
 *  page, not a bare 401). DEV_LOGIN mirrors sessionGate's local-dev bypass — inert in production. */
async function sessionHandle(c: Context<AppEnv>): Promise<string | null> {
  if (c.env.DEV_LOGIN) return c.env.DEV_LOGIN;
  const id = await readSessionCookie(c, c.env.COOKIE_SECRET);
  return id ? getSessionUser(platform(c.env, "anonymous"), id) : null;
}

const START_AGAIN = "Start again from Org settings › Repositories.";

/**
 * `GET /github/app/setup`. Never throws, never a 500: an unexpected error is a 503 page, logged as its
 * scrubbed message only.
 */
export async function githubAppSetup(c: Context<AppEnv>, deps: InstallDeps = {}): Promise<Response> {
  const held: Revealed[] = [];
  const known: { slug: string | null } = { slug: null };
  try {
    return await setup(c, deps, held, known);
  } catch (e) {
    const gh = e instanceof GithubAppError;
    console.error(gh ? "github app setup: GitHub failed" : "github app setup: unexpected error", scrub(e instanceof Error ? e.message : String(e), held));
    return refuse(c, 503, gh ? "GitHub didn't answer" : "Something went wrong",
      gh ? `Trov couldn't check this installation with GitHub just now. ${START_AGAIN}` : `Trov couldn't finish connecting the GitHub App right now. ${START_AGAIN}`, known.slug);
  }
}

async function setup(c: Context<AppEnv>, deps: InstallDeps, held: Revealed[], known: { slug: string | null }): Promise<Response> {
  const now = (deps.now ?? Date.now)();
  const q = (k: string): string | undefined => c.req.query(k);

  // ── who, and which flow ──
  const handle = await sessionHandle(c);
  if (!handle) return refuse(c, 403, "Sign in to Trov first", "Connecting the GitHub App needs you signed in to Trov as the admin who started it. Sign in, then start again from Org settings › Repositories.", null);
  const st = await readState(c, now);
  if (st === "expired") return refuse(c, 403, "This setup expired", `A GitHub App setup has 30 minutes to finish. ${START_AGAIN}`, null);
  if (!st) return refuse(c, 403, "No setup in progress", `This browser has no GitHub App setup that Trov started. ${START_AGAIN}`, null);
  // Someone else's flow names their org; it is never linked.
  if (st.handle.toLowerCase() !== handle.toLowerCase()) return refuse(c, 403, "This setup isn't yours", `The GitHub App setup in this browser was started by someone else. ${START_AGAIN}`, null);
  // Re-checked on every hop: a person removed or demoted since they clicked Install connects nothing.
  const ctx = await resolveTenantById(c.env, handle, st.org, "session");
  if (!ctx) return refuse(c, 403, "Not a member", "You're no longer a member of the organization this setup was for, so nothing can be connected to it.", null);
  known.slug = st.slug;
  if (!hasRole(ctx, "admin")) return refuse(c, 403, "Admins only", "Only an admin or owner of this organization can connect the GitHub App.", st.slug);
  const cfg = githubAppConfig(c.env);
  if (!cfg) return refuse(c, 503, "The GitHub App isn't set up", "This Trov has no GitHub App registered. Connect the repository with a GitHub token instead.", st.slug);
  held.push(appSecrets(cfg));

  // ── a request for approval: nothing to bind yet ──
  if (q("setup_action") === "request") return landing(c, st.slug, "requested");

  const rawId = q("installation_id");
  const queryId = rawId === undefined ? null : parseInstallationId(rawId);
  if (rawId !== undefined && queryId === null) return refuse(c, 400, "Unreadable installation", `GitHub sent an installation id Trov can't read. ${START_AGAIN}`, st.slug);
  const state = q("state");
  const code = q("code");

  // ── first hop: GitHub's Setup URL → the authorize hop ──
  if (code === undefined) {
    // GitHub hands the install URL's `state` back here; one that is present must be ours.
    if (state !== undefined && !sameString(state, st.nonce)) return refuse(c, 403, "This setup isn't yours", `GitHub returned to a different setup than the one this browser started. ${START_AGAIN}`, st.slug);
    if (queryId === null) return refuse(c, 400, "No installation", `GitHub didn't say which installation to connect. ${START_AGAIN}`, st.slug);
    await writeState(c, { ...st, installation_id: queryId }, Math.max(1, Math.floor((st.exp - now) / 1000)));
    const authorize = new URL("https://github.com/login/oauth/authorize");
    authorize.searchParams.set("client_id", cfg.clientId);
    authorize.searchParams.set("state", st.nonce);
    authorize.searchParams.set("redirect_uri", setupUrl(c));
    return redirect(c, authorize.toString());
  }

  // ── second hop: the authorization code ──
  held.push(code);
  // A code is only ever accepted for the flow this browser started (login CSRF: someone else's code).
  if (state === undefined || !sameString(state, st.nonce)) return refuse(c, 403, "This sign-in isn't yours", `The GitHub sign-in didn't come from the setup this browser started. ${START_AGAIN}`, st.slug);
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(code)) return refuse(c, 400, "Unreadable sign-in", `GitHub sent an authorization code Trov can't read. ${START_AGAIN}`, st.slug);
  const cookieId = st.installation_id ?? null;
  if (queryId !== null && cookieId !== null && queryId !== cookieId) {
    return refuse(c, 403, "A different installation", `GitHub returned with a different installation than the one this setup started with. ${START_AGAIN}`, st.slug);
  }
  const installationId = queryId ?? cookieId;
  if (installationId === null) return refuse(c, 400, "No installation", `GitHub didn't say which installation to connect. ${START_AGAIN}`, st.slug);

  return verifyAndBind(c, cfg, ctx, deps, now, held, { code, installationId, slug: st.slug, handle });
}

/** The redirect_uri of the authorize hop and the code exchange — the same value both times. */
const setupUrl = (c: Context<AppEnv>): string => `${oauthOrigin(c.req.url)}${SETUP_PATH}`;

async function verifyAndBind(
  c: Context<AppEnv>, cfg: GithubAppConfig, ctx: TenantContext, deps: InstallDeps, now: number, held: Revealed[],
  a: { code: string; installationId: number; slug: string; handle: string },
): Promise<Response> {
  const opts = { fetchImpl: deps.fetchImpl, now };
  let userToken: Secret | null = null;
  try {
    try {
      userToken = await exchangeUserCode(cfg, a.code, setupUrl(c), opts);
    } catch (e) {
      // GitHub's own refusal of the code (expired, used, another app's): the person's to retry.
      if (e instanceof GithubAppError && e.code === "oauth") {
        console.error("github app setup: code refused", scrub(e.message, held));
        return refuse(c, 403, "GitHub didn't accept the sign-in", `The GitHub sign-in expired or was already used. ${START_AGAIN}`, a.slug);
      }
      throw e;
    }
    held.push(userToken);

    // The installation, as GitHub (not the query string) describes it.
    const installation = await getAppInstallation(cfg, a.installationId, opts);
    if (!installation) return refuse(c, 403, "Not an installation of this App", `That isn't an installation of Trov's GitHub App. ${START_AGAIN}`, a.slug);
    const { token } = await mintInstallationToken(cfg, a.installationId, { permissions: LISTING_PERMISSIONS }, opts);
    held.push(token);
    let repos: InstallationRepo[];
    try {
      repos = await listInstallationRepos(token, opts);
    } catch (e) {
      if (e instanceof GithubAppError && e.code === "too_many_repositories") {
        return refuse(c, 403, "Too many repositories", "This installation covers more repositories than Trov can check. Narrow its repository selection on GitHub, then start again.", a.slug);
      }
      throw e;
    }

    // What the PERSON can read in it. A 404: their account cannot see the installation at all — a forged id.
    const mine = await listUserInstallationRepos(userToken, a.installationId, opts);
    if (!mine) return refuse(c, 403, "Not your installation", `Your GitHub account cannot access this installation. ${START_AGAIN}`, a.slug);
    const readable = new Set(mine.map((r) => r.id));
    const unreadable = repos.filter((r) => !readable.has(r.id)).length;
    if (unreadable > 0) {
      // A count, never names: the repositories in question are exactly the ones this person cannot see.
      return refuse(c, 403, "Some repositories aren't yours to connect",
        `Your GitHub account can't read ${unreadable} ${unreadable === 1 ? "repository" : "repositories"} this installation covers, and Trov connects only what you can already read. `
        + "Ask someone who can read all of them to connect it, or narrow the installation's repository selection on GitHub.", a.slug);
    }

    try {
      await bindInstallation(ctx, platform(c.env, a.handle), { installation, repos, by: a.handle });
    } catch (e) {
      if (e instanceof InstallationBoundElsewhereError) {
        return refuse(c, 409, "Already connected elsewhere", "This GitHub installation is already connected to another Trov organization. It can be connected to one organization only.", a.slug);
      }
      throw e;
    }
    return landing(c, a.slug, "connected");
  } finally {
    // Best effort, and never thrown: the token's only job is done either way.
    if (userToken) await revokeUserToken(cfg, userToken, { fetchImpl: deps.fetchImpl });
  }
}

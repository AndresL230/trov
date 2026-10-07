// Every request Trov makes to GitHub ABOUT the App (docs/architecture/github-app.md): as the App itself
// (a JWT — read one installation, mint its token), as an installation (list its repositories), and as
// the user who is connecting it (which installations can this account reach). Reads only.
//
// No D1, no secrets module: this file knows GitHub, not orgs. Nothing here logs, and no result carries
// upstream text — GitHub's answer is reduced to a status and a FIXED phrase, because an error body may
// echo the Authorization header it was sent.
import type { GithubAccountType, GithubRepoSelection } from "@shared/github-app";
import type { Env } from "../env";
import { GithubAppKeyError, appIdOf, signAppJwt } from "./jwt";

export type AppEnv = Pick<Env, "GITHUB_APP_ID" | "GITHUB_APP_PRIVATE_KEY" | "GITHUB_APP_SLUG">;

const API = "https://api.github.com";
const TIMEOUT_MS = 10_000;
const PER_PAGE = 100;
/** GitHub's slug shape for an App (its URL name). */
const SLUG_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/;

const headers = (auth: string): Record<string, string> => ({
  authorization: `Bearer ${auth}`, accept: "application/vnd.github+json", "user-agent": "trov-worker", "x-github-api-version": "2022-11-28",
});
const pick = (f?: typeof fetch): typeof fetch => f ?? ((input, init) => fetch(input, init));
const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

// ── is the App set up on this deployment? ────────────────────────────────────

/** The App's slug (`https://github.com/apps/<slug>`), or null when the var is empty or not one. */
export function appSlug(env: AppEnv): string | null {
  const v = (env.GITHUB_APP_SLUG ?? "").trim();
  return SLUG_RE.test(v) ? v : null;
}
/** Can this deployment sign as the App (an id and a key are present)? Whether the key IMPORTS is found at use. */
export const appCanSign = (env: AppEnv): boolean => appIdOf(env.GITHUB_APP_ID) !== null && !!env.GITHUB_APP_PRIVATE_KEY;
/** Slug, id and key: "Connect with GitHub" can be offered. Anything less and only the manual path is. */
export const appConfigured = (env: AppEnv): boolean => appSlug(env) !== null && appCanSign(env);

/** Where an admin installs the App; `state` comes back on the return to `/auth/callback`. */
export const installUrl = (slug: string, state: string): string =>
  `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(state)}`;

/** The installation's own settings page on GitHub (repositories, suspend, uninstall). */
export function manageUrl(i: { installation_id: number; account_login: string; account_type: GithubAccountType }): string {
  return i.account_type === "Organization"
    ? `https://github.com/organizations/${encodeURIComponent(i.account_login)}/settings/installations/${i.installation_id}`
    : `https://github.com/settings/installations/${i.installation_id}`;
}

// ── as the App (JWT) ─────────────────────────────────────────────────────────

/**
 * Why a request made as the App did not succeed:
 *   not_found   404 — GitHub has no such installation of THIS App (uninstalled)
 *   suspended   403 naming a suspension — the installation exists and is switched off
 *   credentials 401 — GitHub refused the JWT (wrong App id, a key that is not this App's, a clock far off)
 *                or the key did not import. The App's problem, never the installation's.
 *   failed      anything else (rate limit, 5xx, a thrown fetch, a body that is not what was asked for)
 */
export type AppFailure = "not_found" | "suspended" | "credentials" | "failed";
export interface AppRefusal { ok: false; kind: AppFailure; status: number; message: string }

const refusal = (kind: AppFailure, status: number, message: string): AppRefusal => ({ ok: false, kind, status, message });
const thrown = (what: string, e: unknown): AppRefusal => {
  if (e instanceof GithubAppKeyError) return refusal("credentials", 0, e.message);
  const name = e instanceof Error ? e.name : "";
  return refusal("failed", 0, `${what}: ${name === "TimeoutError" || name === "AbortError" ? "the request timed out" : "the request failed"}`);
};

/** A non-2xx from an App-authenticated request, as a refusal. The body is read ONLY to tell a suspension
 *  from another 403, and none of it is kept. */
async function refused(what: string, res: Response): Promise<AppRefusal> {
  if (res.status === 404) { await res.body?.cancel().catch(() => undefined); return refusal("not_found", 404, `${what}: GitHub has no such installation of this App`); }
  if (res.status === 401) { await res.body?.cancel().catch(() => undefined); return refusal("credentials", 401, `${what}: GitHub refused the App's credentials`); }
  if (res.status === 403) {
    const text = await res.text().catch(() => "");
    if (/suspended/i.test(text)) return refusal("suspended", 403, `${what}: the installation is suspended on GitHub`);
    return refusal("failed", 403, `${what}: github 403`);
  }
  await res.body?.cancel().catch(() => undefined);
  return refusal("failed", res.status, `${what}: github ${res.status}`);
}

export interface InstallationInfo {
  installation_id: number;
  account_login: string;
  account_id: string;
  account_type: GithubAccountType;
  repository_selection: GithubRepoSelection;
  suspended_at: string | null;
  avatar_url: string | null;
}

/** `GET /app/installations/:id` — which account the installation is on, and whether it is suspended. */
export async function getInstallation(env: AppEnv, installationId: number, fetchImpl?: typeof fetch, now: number = Date.now()): Promise<{ ok: true; installation: InstallationInfo } | AppRefusal> {
  const what = "read the installation";
  try {
    const jwt = await signAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, now);
    const res = await pick(fetchImpl)(`${API}/app/installations/${installationId}`, { headers: headers(jwt), signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return refused(what, res);
    const body = record(await res.json());
    const account = record(body.account);
    const type = account.type === "Organization" ? "Organization" : account.type === "User" ? "User" : null;
    const login = typeof account.login === "string" ? account.login : "";
    const id = typeof account.id === "number" || typeof account.id === "string" ? String(account.id) : "";
    if (body.id !== installationId || !type || !login || !id) return refusal("failed", res.status, `${what}: GitHub's answer names no account`);
    return {
      ok: true,
      installation: {
        installation_id: installationId, account_login: login, account_id: id, account_type: type,
        repository_selection: body.repository_selection === "all" ? "all" : "selected",
        suspended_at: typeof body.suspended_at === "string" ? body.suspended_at : null,
        avatar_url: typeof account.avatar_url === "string" ? account.avatar_url : null,
      },
    };
  } catch (e) {
    return thrown(what, e);
  }
}

export type Minted = { ok: true; token: string; expiresAt: number } | AppRefusal;

/** `POST /app/installations/:id/access_tokens` — a token for that installation, good for about an hour. */
export async function mintInstallationToken(env: AppEnv, installationId: number, fetchImpl?: typeof fetch, now: number = Date.now()): Promise<Minted> {
  const what = "mint an installation token";
  try {
    const jwt = await signAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, now);
    const res = await pick(fetchImpl)(`${API}/app/installations/${installationId}/access_tokens`, { method: "POST", headers: headers(jwt), signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return refused(what, res);
    const body = record(await res.json());
    const expiresAt = typeof body.expires_at === "string" ? Date.parse(body.expires_at) : NaN;
    if (typeof body.token !== "string" || !body.token || !Number.isFinite(expiresAt)) return refusal("failed", res.status, `${what}: GitHub's answer holds no token`);
    return { ok: true, token: body.token, expiresAt };
  } catch (e) {
    return thrown(what, e);
  }
}

// ── the token cache ──────────────────────────────────────────────────────────

/** A cached token is handed out until it has this long left — a job that starts with it must be able
 *  to finish with it (the longest, a reconcile with every read timing out, is about six minutes). */
export const TOKEN_REFRESH_MARGIN_MS = 10 * 60_000;

// Per isolate, in memory, and nowhere else: an installation token is never written to D1 and never
// logged. Keyed by the App AND the installation, so a changed GITHUB_APP_ID cannot be answered from a
// token the previous App minted. A mint in flight is shared by the callers that asked while it ran.
const tokens = new Map<string, { token: string; expiresAt: number }>();
const minting = new Map<string, Promise<Minted>>();
const cacheKey = (env: AppEnv, installationId: number): string => `${appIdOf(env.GITHUB_APP_ID) ?? ""}:${installationId}`;

/**
 * The installation's token: the cached one while it has `TOKEN_REFRESH_MARGIN_MS` left, else a fresh
 * mint (one request). A refusal is NOT cached — the caller decides what it means for the binding.
 */
export async function installationToken(env: AppEnv, installationId: number, fetchImpl?: typeof fetch, now: number = Date.now()): Promise<Minted> {
  const key = cacheKey(env, installationId);
  const held = tokens.get(key);
  if (held && held.expiresAt - now > TOKEN_REFRESH_MARGIN_MS) return { ok: true, token: held.token, expiresAt: held.expiresAt };
  tokens.delete(key);
  let pending = minting.get(key);
  if (!pending) {
    pending = mintInstallationToken(env, installationId, fetchImpl, now).then((m) => {
      if (m.ok) tokens.set(key, { token: m.token, expiresAt: m.expiresAt });
      return m;
    }).finally(() => minting.delete(key));
    minting.set(key, pending);
  }
  return pending;
}

/** Forget the installation's cached token: GitHub answered 401 to it (revoked — uninstalled, suspended),
 *  or the binding ended. The next use mints again and learns which. */
export function forgetInstallationToken(env: AppEnv, installationId: number): void {
  tokens.delete(cacheKey(env, installationId));
}

/** Tests only: every isolate-held token and mint. */
export function clearInstallationTokens(): void {
  tokens.clear();
  minting.clear();
}

// ── as an installation ───────────────────────────────────────────────────────

export interface InstallationRepo { full_name: string; private: boolean }
export type RepoList = { ok: true; repositories: InstallationRepo[]; total: number; truncated: boolean } | { ok: false; status: number };

/** `GET /installation/repositories`, paginated up to `max` repositories. */
export async function listInstallationRepos(token: string, fetchImpl?: typeof fetch, max = 500): Promise<RepoList> {
  const out: InstallationRepo[] = [];
  let total = 0;
  try {
    for (let page = 1; out.length < max; page++) {
      const res = await pick(fetchImpl)(`${API}/installation/repositories?per_page=${PER_PAGE}&page=${page}`, { headers: headers(token), signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) { await res.body?.cancel().catch(() => undefined); return { ok: false, status: res.status }; }
      const body = record(await res.json());
      const rows = Array.isArray(body.repositories) ? body.repositories : [];
      total = typeof body.total_count === "number" ? body.total_count : out.length + rows.length;
      for (const r of rows) {
        const row = record(r);
        if (typeof row.full_name === "string") out.push({ full_name: row.full_name, private: row.private === true });
      }
      if (rows.length < PER_PAGE || out.length >= total) break;
    }
  } catch {
    return { ok: false, status: 0 };
  }
  return { ok: true, repositories: out.slice(0, max), total: Math.max(total, out.length), truncated: total > max };
}

// ── as the connecting user ───────────────────────────────────────────────────

export interface UserInstallation { installation_id: number; account_login: string; account_id: string }
/** How many of a user's installations are read before giving up (ten pages). */
const USER_INSTALLATION_PAGES = 10;

/**
 * `GET /user/installations` — every installation of THIS App the user's own GitHub account can reach,
 * paginated. null when GitHub did not answer in full: a partial list must never read as "not listed".
 */
export async function listUserInstallations(userToken: string, fetchImpl?: typeof fetch): Promise<UserInstallation[] | null> {
  const out: UserInstallation[] = [];
  try {
    for (let page = 1; page <= USER_INSTALLATION_PAGES; page++) {
      const res = await pick(fetchImpl)(`${API}/user/installations?per_page=${PER_PAGE}&page=${page}`, { headers: headers(userToken), signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) { await res.body?.cancel().catch(() => undefined); return null; }
      const body = record(await res.json());
      if (!Array.isArray(body.installations)) return null;
      for (const i of body.installations) {
        const row = record(i);
        const account = record(row.account);
        if (typeof row.id === "number" && Number.isSafeInteger(row.id)) {
          out.push({ installation_id: row.id, account_login: typeof account.login === "string" ? account.login : "", account_id: account.id === undefined ? "" : String(account.id) });
        }
      }
      const total = typeof body.total_count === "number" ? body.total_count : out.length;
      if (body.installations.length < PER_PAGE || out.length >= total) return out;
    }
  } catch {
    return null;
  }
  return null; // more pages than this reads: unknown, so not a yes
}

/** GitHub's count of something listed with `total_count`, from ONE request of one row; null = no answer. */
async function totalCount(url: string, auth: string, fetchImpl?: typeof fetch): Promise<number | null> {
  try {
    const res = await pick(fetchImpl)(url, { headers: headers(auth), signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) { await res.body?.cancel().catch(() => undefined); return null; }
    const n = record(await res.json()).total_count;
    return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

/** How many of the installation's repositories the USER can reach (`GET /user/installations/:id/repositories`). */
export const countUserInstallationRepos = (userToken: string, installationId: number, fetchImpl?: typeof fetch): Promise<number | null> =>
  totalCount(`${API}/user/installations/${installationId}/repositories?per_page=1`, userToken, fetchImpl);

/** How many repositories the INSTALLATION covers (`GET /installation/repositories`). */
export const countInstallationRepos = (installationToken_: string, fetchImpl?: typeof fetch): Promise<number | null> =>
  totalCount(`${API}/installation/repositories?per_page=1`, installationToken_, fetchImpl);

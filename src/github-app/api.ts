// Every request Trov makes to GitHub ABOUT the App (docs/architecture/github-app.md): as the App itself
// (a JWT — read one installation, mint its token), as an installation (list its repositories), and as
// the user who is connecting it (which installations can this account reach, and which of one's
// repositories it can read). Reads only — and one DELETE: the connecting user's token, revoked when the
// connect flow is done with it.
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
  const what = "ask GitHub about the installation";
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

// ── what a token may do ──────────────────────────────────────────────────────

/** The repository permissions the App is registered with — all of them read. A mint that names one the
 *  App was not granted is refused by GitHub (422), so nothing outside this list is ever asked for. */
export type TokenPermission = "metadata" | "contents" | "pull_requests" | "issues" | "actions" | "checks" | "deployments" | "statuses";
export type TokenPermissions = Readonly<Partial<Record<TokenPermission, "read">>>;

/**
 * What ONE installation token is minted for. A token is never wider than the read it is for:
 *   repository  the one repository it can touch (its NAME, without the owner — an installation is one
 *               account's), or null for a call that is about the installation itself;
 *   permissions the permissions it carries, each `read`.
 */
export interface TokenScope { repository: string | null; permissions: TokenPermissions }

/** Everything the readers of a repository call (docs/architecture/github-app.md › Permissions ↔
 *  endpoints): the reconcile, Sync GitHub, the progress backstop, the webhook's follow-up reads. */
export const READ_PERMISSIONS: TokenPermissions = {
  metadata: "read", contents: "read", pull_requests: "read", issues: "read",
  actions: "read", checks: "read", deployments: "read", statuses: "read",
};

/** A token to READ `owner/repo`: that repository alone, with `READ_PERMISSIONS`. */
export const repoScope = (fullName: string): TokenScope => ({ repository: fullName.slice(fullName.indexOf("/") + 1), permissions: READ_PERMISSIONS });

/** A token for a call about the installation ITSELF — `GET /installation/repositories` (the picker, Test
 *  connection, the connect flow's no-escalation check). It has to span the installation, or the list
 *  would be cut to the repositories it names; so it carries Metadata alone and can read no code, no
 *  pull request and no issue of any of them. */
export const INSTALLATION_SCOPE: TokenScope = { repository: null, permissions: { metadata: "read" } };

/**
 * `POST /app/installations/:id/access_tokens` — a token for that installation, good for about an hour,
 * narrowed to `scope`. A repository the installation does not cover, or a permission the App was not
 * granted, is GitHub's 422: a refusal like any other (`failed`).
 */
export async function mintInstallationToken(env: AppEnv, installationId: number, scope: TokenScope, fetchImpl?: typeof fetch, now: number = Date.now()): Promise<Minted> {
  const what = "ask GitHub for a token";
  try {
    const jwt = await signAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, now);
    const body = JSON.stringify({ ...(scope.repository ? { repositories: [scope.repository] } : {}), permissions: scope.permissions });
    const res = await pick(fetchImpl)(`${API}/app/installations/${installationId}/access_tokens`, {
      method: "POST", headers: { ...headers(jwt), "content-type": "application/json" }, body, signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 422) {
      await res.body?.cancel().catch(() => undefined);
      return refusal("failed", 422, `${what}: GitHub would not issue one for ${scope.repository ? "that repository (the installation may not cover it)" : "the installation"}`);
    }
    if (!res.ok) return refused(what, res);
    const answer = record(await res.json());
    const expiresAt = typeof answer.expires_at === "string" ? Date.parse(answer.expires_at) : NaN;
    if (typeof answer.token !== "string" || !answer.token || !Number.isFinite(expiresAt)) return refusal("failed", res.status, `${what}: GitHub's answer holds no token`);
    return { ok: true, token: answer.token, expiresAt };
  } catch (e) {
    return thrown(what, e);
  }
}

// ── the token cache ──────────────────────────────────────────────────────────

/** A cached token is handed out until it has this long left — a job that starts with it must be able
 *  to finish with it (the longest, a reconcile with every read timing out, is about six minutes). */
export const TOKEN_REFRESH_MARGIN_MS = 10 * 60_000;

// Per isolate, in memory, and nowhere else: an installation token is never written to D1 and never
// logged. Keyed by the App, the installation AND the scope the token was minted for — so a changed
// GITHUB_APP_ID cannot be answered from a token the previous App minted, and a token for one repository
// is never handed to a read of another. A mint in flight is shared by the callers that asked for the
// same scope while it ran.
const tokens = new Map<string, { token: string; expiresAt: number }>();
const minting = new Map<string, Promise<Minted>>();
const installationKey = (env: AppEnv, installationId: number): string => `${appIdOf(env.GITHUB_APP_ID) ?? ""}:${installationId}:`;
/** A repository's name cannot hold `/` or a space, so `*` (the installation) never collides with one. */
const cacheKey = (env: AppEnv, installationId: number, scope: TokenScope): string =>
  `${installationKey(env, installationId)}${scope.repository?.toLowerCase() ?? "*"}:${Object.keys(scope.permissions).sort().join(",")}`;

/**
 * The installation's token for `scope`: the cached one while it has `TOKEN_REFRESH_MARGIN_MS` left, else
 * a fresh mint (one request). A refusal is NOT cached — the caller decides what it means for the binding.
 */
export async function installationToken(env: AppEnv, installationId: number, scope: TokenScope, fetchImpl?: typeof fetch, now: number = Date.now()): Promise<Minted> {
  const key = cacheKey(env, installationId, scope);
  const held = tokens.get(key);
  if (held && held.expiresAt - now > TOKEN_REFRESH_MARGIN_MS) return { ok: true, token: held.token, expiresAt: held.expiresAt };
  tokens.delete(key);
  let pending = minting.get(key);
  if (!pending) {
    pending = mintInstallationToken(env, installationId, scope, fetchImpl, now).then((m) => {
      if (m.ok) tokens.set(key, { token: m.token, expiresAt: m.expiresAt });
      return m;
    }).finally(() => minting.delete(key));
    minting.set(key, pending);
  }
  return pending;
}

/**
 * Forget cached tokens of an installation. With a `scope`, the ONE token minted for it: GitHub answered
 * 401 to that token, and the others are not known to be dead. Without, every token of the installation:
 * the binding ended, it was suspended, or its permissions changed. The next use mints again and learns
 * which.
 */
export function forgetInstallationToken(env: AppEnv, installationId: number, scope?: TokenScope): void {
  if (scope) { tokens.delete(cacheKey(env, installationId, scope)); return; }
  const prefix = installationKey(env, installationId);
  for (const key of [...tokens.keys()]) if (key.startsWith(prefix)) tokens.delete(key);
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

// ── the repositories of ONE installation, by id ──────────────────────────────

/** How many pages of an installation's repositories the connect flow reads before it refuses: ten pages
 *  of 100, so an installation of up to 1,000 repositories can be checked (and costs at most twenty
 *  requests — the installation's list and the user's). */
export const REPO_ID_PAGES = 10;

/** Every repository id of a list, or why not: `too_many` = still more after `REPO_ID_PAGES`; `failed` =
 *  GitHub did not answer in full. Neither is ever a yes. */
export type RepoIds = { ok: true; ids: Set<number> } | { ok: false; reason: "too_many" | "failed" };

/**
 * Page a `{ total_count, repositories }` list to its END and return the repositories' numeric ids.
 * Anything short of the whole list is a failure: a page that did not arrive, a body that is not a list,
 * a row with no id, or a final count that is not the `total_count` GitHub gave. `missingIsEmpty`: a 404
 * means "none" (the user's view of an installation they can no longer see).
 */
async function repoIds(url: string, auth: string, fetchImpl: typeof fetch | undefined, missingIsEmpty: boolean): Promise<RepoIds> {
  const ids = new Set<number>();
  try {
    for (let page = 1; page <= REPO_ID_PAGES; page++) {
      const res = await pick(fetchImpl)(`${url}?per_page=${PER_PAGE}&page=${page}`, { headers: headers(auth), signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return missingIsEmpty && res.status === 404 && page === 1 ? { ok: true, ids } : { ok: false, reason: "failed" };
      }
      const body = record(await res.json());
      const total = body.total_count;
      if (!Array.isArray(body.repositories) || typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) return { ok: false, reason: "failed" };
      if (total > REPO_ID_PAGES * PER_PAGE) return { ok: false, reason: "too_many" }; // known from the first page: no point reading on
      for (const r of body.repositories) {
        const id = record(r).id;
        if (typeof id !== "number" || !Number.isSafeInteger(id)) return { ok: false, reason: "failed" };
        ids.add(id);
      }
      if (ids.size >= total) return ids.size === total ? { ok: true, ids } : { ok: false, reason: "failed" };
      if (body.repositories.length < PER_PAGE) return { ok: false, reason: "failed" }; // a short page that is not the last
    }
  } catch {
    return { ok: false, reason: "failed" };
  }
  return { ok: false, reason: "too_many" };
}

/** The ids of EVERY repository the installation covers (`GET /installation/repositories`, an installation token). */
export const installationRepoIds = (installationToken_: string, fetchImpl?: typeof fetch): Promise<RepoIds> =>
  repoIds(`${API}/installation/repositories`, installationToken_, fetchImpl, false);

/** The ids of the installation's repositories the USER can read (`GET /user/installations/:id/repositories`,
 *  the user's token). GitHub answers 404 when that is none of them. */
export const userInstallationRepoIds = (userToken: string, installationId: number, fetchImpl?: typeof fetch): Promise<RepoIds> =>
  repoIds(`${API}/user/installations/${installationId}/repositories`, userToken, fetchImpl, true);

/** How many repositories the INSTALLATION covers — GitHub's `total_count`, from one request of one row
 *  (Test connection); null = no answer. */
export async function countInstallationRepos(installationToken_: string, fetchImpl?: typeof fetch): Promise<number | null> {
  try {
    const res = await pick(fetchImpl)(`${API}/installation/repositories?per_page=1`, { headers: headers(installationToken_), signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) { await res.body?.cancel().catch(() => undefined); return null; }
    const n = record(await res.json()).total_count;
    return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

// ── the connecting user's token, when the flow is done with it ───────────────

const REVOKE_TIMEOUT_MS = 5_000;

/**
 * `DELETE /applications/{client_id}/token` — revoke ONE user access token (HTTP Basic: the App's client
 * id and secret). The connect flow asks for a user token only to learn who is connecting and what they
 * can read; once it has decided, the token has no further use. Best effort: true when GitHub said it is
 * gone (204), false for anything else, never a throw — and nothing of the request is logged or returned.
 */
export async function revokeUserToken(env: Pick<Env, "GITHUB_CLIENT_ID" | "GITHUB_CLIENT_SECRET">, userToken: string, fetchImpl?: typeof fetch): Promise<boolean> {
  try {
    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !userToken) return false;
    const res = await pick(fetchImpl)(`${API}/applications/${encodeURIComponent(env.GITHUB_CLIENT_ID)}/token`, {
      method: "DELETE",
      headers: {
        authorization: `Basic ${btoa(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`)}`,
        accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "trov-worker", "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({ access_token: userToken }),
      signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
    });
    await res.body?.cancel().catch(() => undefined);
    return res.status === 204;
  } catch {
    return false;
  }
}

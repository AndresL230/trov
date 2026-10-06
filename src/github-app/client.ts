// The six GitHub calls the App makes (spec §4's endpoint table). Every call takes `{ fetchImpl }` (tests stub
// it; the cron passes its counting budget fetch), carries a 15-second `AbortSignal.timeout`, the `trov-worker`
// user-agent and `x-github-api-version: 2022-11-28`.
//
// Credentials come back as `Secret` (src/data/secrets.ts) — an installation token and a person's user token
// print as "[secret]" however they are logged. A failure throws `GithubAppError(code, message)`, and its
// message is `scrub`bed of the App JWT, the private key, the client and webhook secrets and every token or
// code the call held BEFORE it is built or cut: GitHub's error bodies are quoted (their `message`, or the
// raw text's start), response headers never are. Nothing here logs.
import { Secret, scrub, type Revealed } from "../data/secrets";
import { appSecrets, type GithubAppConfig } from "./config";
import { appJwt, GithubAppKeyError } from "./jwt";

const API = "https://api.github.com";
const TIMEOUT_MS = 15_000;
const PER_PAGE = 100;
/** `/installation/repositories` and `/user/installations/{id}/repositories` stop here: 1,000 repositories. */
export const MAX_REPO_PAGES = 10;
const REASON_READ_BYTES = 4096;
const SECRET_TAIL_GUARD = 256; // longer than any secret a call holds bar the private key, which is scrubbed whole
const REASON_CHARS = 160;

export type GithubAppErrorCode =
  | "invalid_request"   // an argument Trov refuses before any request (a non-numeric installation id)
  | "network"           // the fetch threw — a timeout, a dead connection
  | "http"              // GitHub answered a non-2xx (`status` says which)
  | "invalid_response"  // a 2xx whose body is not the documented shape
  | "oauth"             // the code exchange answered 200 with an `error`
  | "app_key"           // the App's private key does not parse or import (a platform misconfiguration)
  | "too_many_repositories"; // still paging after MAX_REPO_PAGES

export class GithubAppError extends Error {
  constructor(readonly code: GithubAppErrorCode, message: string, readonly status?: number) {
    super(message);
    this.name = "GithubAppError";
  }
}

export interface ClientOpts { fetchImpl?: typeof fetch }
export interface JwtOpts extends ClientOpts { now?: number }

export interface InstallationRepo { id: number; full_name: string; private: boolean }
export interface AppInstallation {
  id: number;
  account: { login: string; id: number; type: "User" | "Organization" };
  repository_selection: "all" | "selected";
  suspended_at: string | null;
}

// ── plumbing ─────────────────────────────────────────────────────────────────

const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

const baseHeaders = (): Record<string, string> => ({
  accept: "application/vnd.github+json",
  "user-agent": "trov-worker",
  "x-github-api-version": "2022-11-28",
});

/** A positive integer id in a path — never a string from a query that could carry a `/`. */
function checkId(id: number, what: string): number {
  if (!Number.isSafeInteger(id) || id <= 0) throw new GithubAppError("invalid_request", `${what} must be a positive integer`);
  return id;
}

/** Up to `cap` bytes of a body — an edge error page can be megabytes. */
async function readCapped(res: Response, cap: number): Promise<{ text: string; cut: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { text: "", cut: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cut = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    if (size + value.byteLength > cap) { chunks.push(value.subarray(0, cap - size)); size = cap; cut = true; break; }
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return { text: new TextDecoder().decode(all), cut };
}

/** `: <GitHub's reason>` — its JSON `message` (or `error_description` / `error`), else the raw text's start —
 *  scrubbed WHOLE before any cut (a cut first could leave half a token behind), the read cap included: a
 *  secret straddling it is a fragment no scrub matches, so a cut read loses its tail too. */
async function reason(res: Response, clean: (s: string) => string): Promise<string> {
  let text = "";
  try {
    const read = await readCapped(res, REASON_READ_BYTES);
    text = read.cut ? clean(read.text).slice(0, -SECRET_TAIL_GUARD) : read.text;
  } catch { return ""; }
  // Scrubbed before the whitespace collapses too: a quoted multi-line value only matches as it was.
  const oneLine = (v: string) => clean(clean(v).replace(/\s+/g, " ").trim());
  let out = "";
  try {
    const body = record(JSON.parse(text));
    const msg = [body.message, body.error_description, body.error].find((v) => typeof v === "string" && v.trim());
    if (typeof msg === "string") out = oneLine(msg).slice(0, REASON_CHARS);
  } catch { /* not JSON */ }
  if (!out) out = oneLine(text).slice(0, REASON_CHARS);
  return out ? `: ${out}` : "";
}

/**
 * One request. `label` names the call in every message (`POST /app/installations/{id}/access_tokens`, a
 * template — never a URL carrying an id or a token); `revealed` is what to scrub besides the App's secrets.
 * A thrown fetch → `network`; a non-2xx → `http` with GitHub's scrubbed reason, unless `allow` lists the
 * status, in which case the response is returned for the caller to read (a 404 that means "none").
 */
async function call(
  label: string, url: string, init: { method: string; headers: Record<string, string>; body?: string },
  revealed: Revealed, opts: ClientOpts, allow: number[] = [],
): Promise<Response> {
  const clean = (s: string) => scrub(s, revealed);
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new GithubAppError("network", `GitHub ${label} failed: ${clean(e instanceof Error ? e.message : String(e)).slice(0, REASON_CHARS)}`);
  }
  if (res.ok || allow.includes(res.status)) return res;
  throw new GithubAppError("http", `GitHub ${label} answered ${res.status}${await reason(res, clean)}`, res.status);
}

async function jsonOf(res: Response, label: string, revealed: Revealed): Promise<unknown> {
  try {
    return await res.json();
  } catch (e) {
    throw new GithubAppError("invalid_response", `GitHub ${label} answered a body that is not JSON: ${scrub(e instanceof Error ? e.message : String(e), revealed).slice(0, REASON_CHARS)}`);
  }
}

/** The App JWT for one call. A key that does not parse or import is the platform's misconfiguration —
 *  `app_key`, with jwt.ts's fixed text (it never quotes the key). */
async function jwtFor(cfg: GithubAppConfig, opts: JwtOpts): Promise<string> {
  try {
    return await appJwt(cfg, opts.now ?? Date.now());
  } catch (e) {
    throw new GithubAppError("app_key", e instanceof GithubAppKeyError ? e.message : "the GitHub App JWT could not be signed");
  }
}

const bad = (label: string, what: string) => new GithubAppError("invalid_response", `GitHub ${label} answered without ${what}`);

function repoOf(v: unknown): InstallationRepo | null {
  const r = record(v);
  if (typeof r.id !== "number" || !Number.isSafeInteger(r.id) || typeof r.full_name !== "string" || !r.full_name.includes("/")) return null;
  return { id: r.id, full_name: r.full_name, private: r.private === true };
}

/** Page a repositories list (`{ total_count, repositories }`) to the end — or refuse past MAX_REPO_PAGES
 *  rather than pass a prefix off as the whole list (the install flow's superset check reads it). */
async function pageRepos(label: string, base: string, auth: string, revealed: Revealed, opts: ClientOpts, notFoundIsNull: boolean): Promise<InstallationRepo[] | null> {
  const out: InstallationRepo[] = [];
  for (let page = 1; page <= MAX_REPO_PAGES; page++) {
    const res = await call(label, `${base}?per_page=${PER_PAGE}&page=${page}`, { method: "GET", headers: { ...baseHeaders(), authorization: auth } },
      revealed, opts, notFoundIsNull ? [404] : []);
    if (res.status === 404) return null;
    const body = record(await jsonOf(res, label, revealed));
    if (!Array.isArray(body.repositories)) throw bad(label, "a repositories list");
    for (const item of body.repositories) {
      const repo = repoOf(item);
      if (!repo) throw bad(label, "a repository id and full_name");
      out.push(repo);
    }
    const total = typeof body.total_count === "number" ? body.total_count : null;
    if (body.repositories.length < PER_PAGE || (total !== null && out.length >= total)) return out;
  }
  throw new GithubAppError("too_many_repositories", `GitHub ${label} lists more than ${MAX_REPO_PAGES * PER_PAGE} repositories`);
}

// ── the six calls ────────────────────────────────────────────────────────────

/** `GET /app/installations/{id}` (App JWT): the account, selection and suspension — the bind's existence
 *  check. null on 404 (no such installation of THIS App). */
export async function getAppInstallation(cfg: GithubAppConfig, installationId: number, opts: JwtOpts = {}): Promise<AppInstallation | null> {
  const label = "GET /app/installations/{id}";
  const id = checkId(installationId, "installation id");
  const jwt = await jwtFor(cfg, opts);
  const revealed: Revealed = [jwt, appSecrets(cfg)];
  const res = await call(label, `${API}/app/installations/${id}`, { method: "GET", headers: { ...baseHeaders(), authorization: `Bearer ${jwt}` } }, revealed, opts, [404]);
  if (res.status === 404) return null;
  const body = record(await jsonOf(res, label, revealed));
  const account = record(body.account);
  if (typeof body.id !== "number" || body.id !== id) throw bad(label, "the installation's id");
  if (typeof account.login !== "string" || typeof account.id !== "number") throw bad(label, "an account");
  if (account.type !== "User" && account.type !== "Organization") throw bad(label, "a User or Organization account");
  if (body.repository_selection !== "all" && body.repository_selection !== "selected") throw bad(label, "a repository selection");
  return {
    id,
    account: { login: account.login, id: account.id, type: account.type },
    repository_selection: body.repository_selection,
    suspended_at: typeof body.suspended_at === "string" ? body.suspended_at : null,
  };
}

/** A repository permission an installation token is minted with. Trov only ever asks for read. */
export type TokenPermissions = Record<string, "read">;

/**
 * `POST /app/installations/{id}/access_tokens` (App JWT): a ONE-HOUR installation token. `repositories`
 * (names, not `owner/repo`) and `permissions` narrow it below what the installation was granted; omitted,
 * GitHub grants everything the installation has. GitHub answers 201.
 */
export async function mintInstallationToken(
  cfg: GithubAppConfig, installationId: number,
  scope: { repositories?: string[]; permissions?: TokenPermissions }, opts: JwtOpts = {},
): Promise<{ token: Secret; expires_at: string }> {
  const label = "POST /app/installations/{id}/access_tokens";
  const id = checkId(installationId, "installation id");
  const jwt = await jwtFor(cfg, opts);
  const revealed: Revealed[] = [jwt, appSecrets(cfg)];
  const body: Record<string, unknown> = {};
  if (scope.repositories) body.repositories = scope.repositories;
  if (scope.permissions) body.permissions = scope.permissions;
  const res = await call(label, `${API}/app/installations/${id}/access_tokens`, {
    method: "POST",
    headers: { ...baseHeaders(), authorization: `Bearer ${jwt}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }, revealed, opts);
  const out = record(await jsonOf(res, label, revealed));
  if (typeof out.token !== "string" || !out.token) throw bad(label, "a token");
  if (typeof out.expires_at !== "string") throw bad(label, "an expiry");
  return { token: new Secret(out.token), expires_at: out.expires_at };
}

/** `GET /installation/repositories` (installation token): every repository the installation covers, ≤ 10
 *  pages of 100 — past that it throws `too_many_repositories` rather than return a prefix. */
export async function listInstallationRepos(token: Secret, opts: ClientOpts = {}): Promise<InstallationRepo[]> {
  return (await pageRepos("GET /installation/repositories", `${API}/installation/repositories`, `Bearer ${token.reveal()}`, [token], opts, false))!;
}

/** `GET /user/installations/{id}/repositories` (the person's user token): the repositories of that
 *  installation THE PERSON can read. null on 404 — their account cannot see the installation at all. */
export async function listUserInstallationRepos(userToken: Secret, installationId: number, opts: ClientOpts = {}): Promise<InstallationRepo[] | null> {
  const id = checkId(installationId, "installation id");
  return pageRepos("GET /user/installations/{id}/repositories", `${API}/user/installations/${id}/repositories`, `Bearer ${userToken.reveal()}`, [userToken], opts, true);
}

/**
 * `POST https://github.com/login/oauth/access_token` (client id + secret): the install flow's user token for
 * `code`. Never stored. GitHub reports a refused code as a 200 whose body has an `error` — that is a failure
 * (`oauth`), its fixed error code quoted, never the code itself.
 */
export async function exchangeUserCode(cfg: GithubAppConfig, code: string, redirectUri: string, opts: ClientOpts = {}): Promise<Secret> {
  const label = "POST /login/oauth/access_token";
  const revealed: Revealed = [code, appSecrets(cfg)];
  const res = await call(label, "https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { ...baseHeaders(), accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code, redirect_uri: redirectUri }),
  }, revealed, opts);
  const body = record(await jsonOf(res, label, revealed));
  if (typeof body.error === "string") {
    throw new GithubAppError("oauth", `GitHub refused the authorization code: ${scrub(body.error, revealed).replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 60)}`);
  }
  if (typeof body.access_token !== "string" || !body.access_token) throw bad(label, "an access token");
  return new Secret(body.access_token);
}

/** `DELETE /applications/{client_id}/token` (basic client id : secret): revoke a user token. Best effort —
 *  it never throws, and says only whether GitHub confirmed (204). */
export async function revokeUserToken(cfg: GithubAppConfig, userToken: Secret, opts: ClientOpts = {}): Promise<boolean> {
  const basic = btoa(`${cfg.clientId}:${cfg.clientSecret}`);
  try {
    const res = await call("DELETE /applications/{client_id}/token", `${API}/applications/${encodeURIComponent(cfg.clientId)}/token`, {
      method: "DELETE",
      headers: { ...baseHeaders(), authorization: `Basic ${basic}`, "content-type": "application/json" },
      body: JSON.stringify({ access_token: userToken.reveal() }),
    }, [basic, userToken, appSecrets(cfg)], opts);
    return res.status === 204;
  } catch {
    return false;
  }
}

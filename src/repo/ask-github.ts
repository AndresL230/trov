// The CREDENTIALED half of Ask Trov's GitHub tools (docs/architecture/ask.md › GitHub; the tools themselves are
// src/ai/ask/github.ts, which holds no credential). The HTTP app hands this factory to the Ask route
// (src/routes.ts → `provideAskGithub`); nothing under src/ai/ask/ imports it, and nothing reachable from src/mcp.ts
// does either (test/secrets.mcp.test.ts). The route builds it only while the org's AI switch AND its GitHub lookups
// switch (`orgs.ai_chat_github`, an admin's) are on.
//
//   • THE credential path: `resolveGithubCredential` for the ONE repository asked — the org's installation token
//     minted for that repository with the read permissions it already holds (READ_PERMISSIONS), else the org's
//     stored token. It is resolved as the org's system tenant (`jobTenant`, as Sync GitHub does), because the
//     resolver serves no plain member — which is why the next point exists.
//   • Each person's OWN GitHub access (the owner's ruling, 2026-10-17): before anything of a repository is read for
//     someone, their linked GitHub identity (`identities`, provider github — the sign-in one, never the org's
//     attribution map) must hold at least read on it, asked of GitHub with the org's credential:
//     `GET /repos/{r}/collaborators/{login}/permission` (Metadata). No linked identity → `not_linked` (link GitHub in
//     Settings); `none` → `no_access`; an error or a timeout → `access_unknown` — a deny, never an allow. Asked once
//     per repository per answer (cached), and NOT counted in the answer's ASK_GITHUB_REQUESTS_MAX: it is bounded by
//     the org's connected repositories and the person's linked identities.
//   • Tenant scoped: the repository must be one of the org's `org_repos` rows, re-read here on every request, before
//     any credential is asked for. Anything else is `not_connected`.
//   • Read-only: GET only, to api.github.com only, under /repos/<that repository>/ — checked on the parsed URL, so
//     no path can climb out — or the code search, whose query is scoped here to that repository alone.
//   • Bounded: each request has ASK_GITHUB_TIMEOUT_MS, and the turn's own abort (Stop) ends it.
//   • Secret: the token is revealed on the ONE line that builds the Authorization header. A failure is fixed words
//     (never GitHub's body, never the token), a log line is the error's NAME only, and a body that somehow quotes the
//     token back has it scrubbed before it is parsed.
import { ASK_GITHUB_ROWS_MAX, ASK_GITHUB_TIMEOUT_MS } from "@shared/ai-ask-core";
import type { Env } from "../env";
import { all, first, type TenantContext } from "../data/sql";
import { jobTenant } from "../platform/jobs";
import { resolveGithubCredential, type GithubCredential } from "../github-app/credential";
import { scrubbedMessage } from "./gh-http";
import type { GithubFailCode, GithubReply, GithubRequest, GithubTransport, GithubTransportFactory } from "../ai/ask/github";

const API = "https://api.github.com";
const API_VERSION = "2022-11-28";
/** A person's linked GitHub identities checked at most (a person rarely has more than one). */
const IDENTITIES_MAX = 3;
/** The repository permissions that can read it (`permission` is admin / write / read / none; `role_name` adds
 *  maintain / triage and custom roles' bases). */
const READS = new Set(["admin", "maintain", "write", "triage", "read"]);

type Fail = Extract<GithubReply, { ok: false }>;
const fail = (code: GithubFailCode, message: string): Fail => ({ ok: false, code, message });

/** A code search's words with every scope qualifier taken out, then scoped to `repo` alone. */
export function scopedSearch(q: string, repo: string): string {
  const words = q.replace(/(^|\s)-?(?:repo|org|user|owner|fork|is):\S*/gi, " ").replace(/\s+/g, " ").trim();
  return `${words} repo:${repo}`.trim();
}

/** A per-request signal: the timeout, and the turn's own abort. */
function requestSignal(outer: AbortSignal | undefined): AbortSignal {
  const t = AbortSignal.timeout(ASK_GITHUB_TIMEOUT_MS);
  if (!outer) return t;
  const ctl = new AbortController();
  const stop = (s: AbortSignal) => () => ctl.abort(s.reason);
  if (outer.aborted) ctl.abort(outer.reason);
  outer.addEventListener("abort", stop(outer), { once: true });
  t.addEventListener("abort", stop(t), { once: true });
  return ctl.signal;
}

/** Why a read is not allowed for this person, or null when it is. */
type Access = null | GithubReply;

export const NOT_LINKED = "GitHub lookups follow each person's own GitHub access, and your Trov account is not linked to GitHub. Link GitHub in Settings, then ask again.";

export const askGithubTransport: GithubTransportFactory = (env: Env, ctx: TenantContext, opts): GithubTransport => {
  // One credential per repository per answer (the installation token is cached per isolate besides).
  const creds = new Map<string, Promise<GithubCredential | null | "error">>();
  const credentialFor = (repo: string) => {
    const key = repo.toLowerCase();
    if (!creds.has(key)) {
      creds.set(key, resolveGithubCredential(jobTenant(env, ctx), env, { repo, fetchImpl: opts.fetchImpl }).catch((e) => {
        console.error("ask github: credential", e instanceof Error ? e.name : "error"); // the name only — never a value
        return "error" as const;
      }));
    }
    return creds.get(key)!;
  };

  /** One GET with the credential: the response, or a failure in fixed words. */
  async function send(cred: GithubCredential, url: URL, accept: string): Promise<Response | Fail> {
    const token = cred.token.reveal();
    try {
      return await (cred.fetch(opts.fetchImpl) ?? fetch)(url.toString(), {
        method: "GET",
        headers: { authorization: `Bearer ${token}`, accept, "user-agent": "trov-worker", "x-github-api-version": API_VERSION },
        signal: requestSignal(opts.signal),
      });
    } catch (e) {
      const name = e instanceof Error ? e.name : "error";
      console.error("ask github: request", name);
      if (opts.signal?.aborted) return fail("failed", "Stopped before GitHub answered.");
      return name === "TimeoutError" || name === "AbortError"
        ? fail("timeout", `GitHub did not answer within ${ASK_GITHUB_TIMEOUT_MS / 1000} seconds.`)
        : fail("failed", "GitHub could not be reached.");
    }
  }
  const isReply = (r: Response | Fail): r is Fail => !(r instanceof Response);

  // The person's linked GitHub logins (their own sign-in identities, while a live member of this org), read once.
  let logins: Promise<string[]> | null = null;
  const loginsOf = () => (logins ??= all<{ subject: string }>(ctx,
    `SELECT i.subject FROM identities i JOIN memberships m ON m.user_id = i.person AND m.org_id = ?
      WHERE i.person = ? COLLATE NOCASE AND i.provider = 'github' ORDER BY i.linked_at LIMIT ${IDENTITIES_MAX}`, ctx.orgId, ctx.userId)
    .then((rows) => rows.map((r) => r.subject).filter((s) => /^[A-Za-z0-9-]{1,39}$/.test(s))));

  // Each repository's answer for this person, once per answer.
  const access = new Map<string, Promise<Access>>();
  const accessFor = (repo: string, cred: GithubCredential) => {
    const key = repo.toLowerCase();
    if (!access.has(key)) access.set(key, checkAccess(repo, cred));
    return access.get(key)!;
  };
  async function checkAccess(repo: string, cred: GithubCredential): Promise<Access> {
    let mine: string[];
    try { mine = await loginsOf(); } catch { return fail("access_unknown", `Trov could not check your GitHub access to ${repo}, so nothing of it was read. Try again.`); }
    if (!mine.length) return fail("not_linked", NOT_LINKED);
    for (const login of mine) {
      const r = await send(cred, new URL(`${API}/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`), "application/vnd.github+json");
      if (isReply(r)) return fail("access_unknown", `Trov could not check your GitHub access to ${repo} (${r.message.replace(/\.$/, "")}), so nothing of it was read.`);
      if (r.status === 404) { void r.body?.cancel().catch(() => undefined); continue; } // GitHub knows no such user (a renamed login): the next one
      if (!r.ok) {
        void r.body?.cancel().catch(() => undefined);
        return fail("access_unknown", `Trov could not check your GitHub access to ${repo} (GitHub answered ${r.status}), so nothing of it was read.`);
      }
      let body: { permission?: unknown; role_name?: unknown };
      try { body = JSON.parse(scrubbedMessage(await r.text(), cred.token.reveal())) as typeof body; } catch {
        return fail("access_unknown", `Trov could not check your GitHub access to ${repo}, so nothing of it was read.`);
      }
      if (READS.has(String(body.permission)) || READS.has(String(body.role_name))) return null;
    }
    return fail("no_access", `You don't have access to ${repo} on GitHub (as ${mine.join(" or ")}), so Trov can't read it for you. Someone with access can, or ask an admin of the repository on GitHub to add you.`);
  }

  return {
    async get(asked: string, req: GithubRequest): Promise<GithubReply> {
      // The org's own row, every time — never the name as the model wrote it.
      const row = await first<{ repo_full_name: string }>(ctx,
        `SELECT repo_full_name FROM org_repos WHERE org_id = ? AND repo_full_name = ?`, ctx.orgId, asked).catch(() => null);
      if (!row) return fail("not_connected", `${asked.slice(0, 100)} is not a repository this organization connected to Trov.`);
      const repo = row.repo_full_name;

      let url: URL;
      let accept = "application/vnd.github+json";
      if ("search" in req) {
        url = new URL(`${API}/search/code`);
        url.searchParams.set("q", scopedSearch(req.search, repo));
        url.searchParams.set("per_page", String(ASK_GITHUB_ROWS_MAX));
        accept = "application/vnd.github.text-match+json";
      } else {
        url = new URL(`${API}/repos/${repo}${req.path ? `/${req.path}` : ""}`);
        const root = `/repos/${repo}`.toLowerCase();
        const at = url.pathname.toLowerCase();
        if (url.origin !== API || (at !== root && !at.startsWith(`${root}/`))) return fail("bad_request", "That path is not one Trov can read.");
        if (req.accept) accept = req.accept;
      }

      // Not linked to GitHub: said before any credential is asked for.
      try { if (!(await loginsOf()).length) return fail("not_linked", NOT_LINKED); } catch { /* checkAccess says it */ }

      const cred = await credentialFor(repo);
      if (cred === "error") return fail("failed", `Trov could not get its GitHub access for ${repo} just now.`);
      if (!cred) return fail("no_credential", `GitHub is not connected for ${repo} (Org settings › Repositories), so Trov cannot read it.`);

      const denied = await accessFor(repo, cred);
      if (denied) return denied;

      const res = await send(cred, url, accept);
      if (isReply(res)) return res;
      if (res.ok) {
        try {
          const text = scrubbedMessage(await res.text(), cred.token.reveal());
          void cred.markUsed();
          return { ok: true, status: res.status, body: text ? JSON.parse(text) : null };
        } catch (e) {
          console.error("ask github: body", e instanceof Error ? e.name : "error");
          return fail("failed", "GitHub's answer could not be read.");
        }
      }
      void res.body?.cancel().catch(() => undefined);
      const limited = res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0");
      if (limited) return fail("rate_limited", "GitHub's rate limit for Trov is used up for now. Try again in a few minutes.");
      switch (res.status) {
        case 404: return fail("not_found", `GitHub has nothing at that address in ${repo} (or Trov's access does not reach it).`);
        case 401: return fail("forbidden", `GitHub refused Trov's access to ${repo}.`);
        case 403: return fail("forbidden", `GitHub refused this read: Trov's access to ${repo} does not cover it.`);
        case 409: return fail("not_found", `${repo} is empty on GitHub.`);
        case 422: return fail("bad_request", "GitHub could not run that request (a search or a ref it does not accept).");
        default: return fail("failed", `GitHub answered with an error (${res.status}).`);
      }
    },
  };
};

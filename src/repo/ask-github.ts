// The CREDENTIALED half of Ask Trov's GitHub tools (docs/architecture/ask.md › GitHub; the tools themselves are
// src/ai/ask/github.ts, which holds no credential). The HTTP app hands this factory to the Ask route
// (src/routes.ts → `provideAskGithub`); nothing under src/ai/ask/ imports it, and nothing reachable from src/mcp.ts
// does either (test/secrets.mcp.test.ts).
//
//   • THE credential path: `resolveGithubCredential` for the ONE repository asked — the org's installation token
//     minted for that repository with the read permissions it already holds (READ_PERMISSIONS), else the org's
//     stored token. It is resolved as the org's system tenant (`jobTenant`, as Sync GitHub does), because the
//     resolver serves no plain member while any member may ask: what reaches the model is bounded below, not by role.
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
import { first, type TenantContext } from "../data/sql";
import { jobTenant } from "../platform/jobs";
import { resolveGithubCredential, type GithubCredential } from "../github-app/credential";
import { scrubbedMessage } from "./gh-http";
import type { GithubFailCode, GithubReply, GithubRequest, GithubTransport, GithubTransportFactory } from "../ai/ask/github";

const API = "https://api.github.com";
const API_VERSION = "2022-11-28";

const fail = (code: GithubFailCode, message: string): GithubReply => ({ ok: false, code, message });

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

      const cred = await credentialFor(repo);
      if (cred === "error") return fail("failed", `Trov could not get its GitHub access for ${repo} just now.`);
      if (!cred) return fail("no_credential", `GitHub is not connected for ${repo} (Org settings › Repositories), so Trov cannot read it.`);

      const token = cred.token.reveal();
      let res: Response;
      try {
        res = await (cred.fetch(opts.fetchImpl) ?? fetch)(url.toString(), {
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

      if (res.ok) {
        try {
          const text = scrubbedMessage(await res.text(), token);
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

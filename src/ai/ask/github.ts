// Ask Trov's GitHub tools (docs/architecture/ask.md › GitHub): read-only lookups in the organization's CONNECTED
// repositories — a file or folder, code search, a pull request with its changed files, an issue with its comments, a
// commit with its diff, recent pull requests / commits / branches / releases / issues, and CI on a ref.
//
//   • NO CREDENTIAL HERE. This module never resolves, holds or sees a token: it shapes requests and results. The
//     transport that does (`GithubTransport`) is built OUTSIDE src/ai/ask/ — src/repo/ask-github.ts, through
//     `resolveGithubCredential` — and handed to the route by the HTTP app (`provideAskGithub`), so nothing under
//     src/ai/ask/ reaches src/github-app/ or the secrets store (test/secrets.mcp.test.ts).
//   • Tenant scoped twice: a tool names a repository only from `AskGithub.repos` (the org's `org_repos`, read when the
//     turn starts; anything else is `not_connected`), and the transport checks the org's rows again before it asks
//     for a credential.
//   • Read-only by construction: the transport only GETs, on api.github.com, under /repos/<that repository>/ (or the
//     code search it scopes to that repository itself).
//   • Bounded: at most ASK_GITHUB_REQUESTS_MAX requests per answer (`limit` past it), each with its own timeout (in
//     the transport); every text the model gets is cut at ASK_GITHUB_TEXT_MAX with a note, lists at ASK_GITHUB_ROWS_MAX.
//   • Honest: a failure is a `GithubToolError` the model relays (turn.ts `errorBody`) — never invented content.
//   • Untrusted: the turn fences every result like any tool result (prompt.ts rule 4; rule 8 says the same for GitHub).
import { z } from "zod";
import type { Env } from "../../env";
import { all, type TenantContext } from "../../data/sql";
import { ASK_GITHUB_REQUESTS_MAX, ASK_GITHUB_ROWS_MAX, ASK_GITHUB_TEXT_MAX, ASK_GITHUB_TOOLS } from "@shared/ai-ask-core";

export type GithubFailCode = "not_connected" | "no_credential" | "not_found" | "forbidden" | "rate_limited" | "timeout" | "failed" | "limit" | "bad_request";

/** One GET's answer from the transport: the parsed JSON body, or why there is none (fixed words, no token). */
export type GithubReply = { ok: true; status: number; body: unknown } | { ok: false; code: GithubFailCode; message: string };

/** What the transport is asked for: a path under /repos/<repo>/ (already encoded, no leading slash; "" = the repository
 *  itself), or a code search the transport scopes to `repo` itself. */
export type GithubRequest = { path: string; accept?: string } | { search: string };

/** The credentialed side — src/repo/ask-github.ts. Built once per answer; the repository is re-checked there. */
export interface GithubTransport {
  get(repo: string, req: GithubRequest): Promise<GithubReply>;
}
export type GithubTransportFactory = (env: Env, ctx: TenantContext, opts: { fetchImpl?: typeof fetch; signal?: AbortSignal }) => GithubTransport;

export interface ConnectedRepo { name: string; primary: boolean }

/** The GitHub side of one answer: the org's connected repositories and the requests spent so far. */
export interface AskGithub {
  repos: readonly ConnectedRepo[];
  requests: number;
  transport: GithubTransport;
}

/** A GitHub tool's refusal or failure, in words the model can relay. */
export class GithubToolError extends Error {
  constructor(public code: GithubFailCode, message: string) {
    super(message);
    this.name = "GithubToolError";
  }
}

export const isGithubTool = (name: string): boolean => (ASK_GITHUB_TOOLS as readonly string[]).includes(name);

/** The org's connected repositories, primary first (D1 only). */
export async function connectedRepos(ctx: TenantContext): Promise<ConnectedRepo[]> {
  const rows = await all<{ repo_full_name: string; is_primary: number }>(ctx,
    `SELECT repo_full_name, is_primary FROM org_repos WHERE org_id = ? ORDER BY is_primary DESC, created_at, id`, ctx.orgId);
  return rows.map((r) => ({ name: r.repo_full_name, primary: r.is_primary === 1 }));
}

export const askGithub = (transport: GithubTransport, repos: readonly ConnectedRepo[]): AskGithub => ({ repos, requests: 0, transport });

// ── shaping ─────────────────────────────────────────────────────────────────

const REPO_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const short = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The repository a call names — one the org connected — else the primary (or the only one). */
export function repoOf(gh: AskGithub, asked: string | undefined): ConnectedRepo {
  const names = gh.repos.map((r) => r.name).join(", ");
  if (!asked) {
    const r = gh.repos.find((x) => x.primary) ?? (gh.repos.length === 1 ? gh.repos[0] : null);
    if (!r) throw new GithubToolError("bad_request", `Name the repository (\`repo\`): one of ${names}.`);
    return r;
  }
  const want = asked.trim().replace(/^https:\/\/github\.com\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  const hit = REPO_NAME.test(want) ? gh.repos.find((r) => r.name.toLowerCase() === want.toLowerCase()) : undefined;
  if (!hit) throw new GithubToolError("not_connected", `${short(asked)} is not a repository this organization connected to Trov, so it cannot be read. Connected: ${names || "none"}.`);
  return hit;
}

/** A repository path, each segment encoded; `.` / `..` and control characters are refused (nothing can climb out of
 *  /repos/<repo>/). */
export function encodePath(path: string): string {
  const segs = path.split("/").filter((s) => s.length);
  for (const s of segs) {
    if (s === "." || s === ".." || /[\u0000-\u001f]/.test(s)) throw new GithubToolError("bad_request", "That path is not one Trov can read.");
  }
  return segs.map(encodeURIComponent).join("/");
}
const qs = (o: Record<string, string | number | undefined | null>): string => {
  const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return p.length ? `?${p.join("&")}` : "";
};

/** One request, within the answer's budget. */
async function get(gh: AskGithub, repo: string, req: GithubRequest): Promise<unknown> {
  if (gh.requests >= ASK_GITHUB_REQUESTS_MAX) {
    throw new GithubToolError("limit", `This answer has used its ${ASK_GITHUB_REQUESTS_MAX} GitHub lookups. Answer with what you have, and say what you could not check.`);
  }
  gh.requests++;
  const r = await gh.transport.get(repo, req);
  if (!r.ok) throw new GithubToolError(r.code, r.message);
  return r.body;
}

const o = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const a = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const s = (v: unknown): string | null => (typeof v === "string" ? v : null);
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const login = (v: unknown): string | null => s(o(v).login);

/** Text cut to what is left of `budget` (shared across one result's patches / comments), with a note when cut. */
export function cut(text: string | null, budget: { left: number }, max = ASK_GITHUB_TEXT_MAX): { text: string | null; truncated?: true } {
  if (text === null) return { text: null };
  const room = Math.max(0, Math.min(max, budget.left));
  if (text.length <= room) { budget.left -= text.length; return { text }; }
  budget.left -= room;
  return { text: `${text.slice(0, room)}\n… (truncated: ${room.toLocaleString("en-US")} of ${text.length.toLocaleString("en-US")} characters shown)`, truncated: true };
}

/** A base64 file body as text, or null for a binary file (a NUL byte in it). */
export function decodeContent(b64: string): string | null {
  const bin = atob(b64.replace(/\s+/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  if (bytes.includes(0)) return null;
  return new TextDecoder().decode(bytes);
}

function filesOf(rows: unknown[], budget: { left: number }): { files: unknown[]; patches_truncated?: true } {
  let truncated = false;
  const files = rows.slice(0, ASK_GITHUB_ROWS_MAX).map((f) => {
    const x = o(f);
    const patch = cut(s(x.patch), budget, 6_000);
    if (patch.truncated) truncated = true;
    return { filename: s(x.filename), status: s(x.status), additions: n(x.additions), deletions: n(x.deletions), patch: patch.text, ...(s(x.previous_filename) ? { previous_filename: s(x.previous_filename) } : {}) };
  });
  return { files, ...(truncated ? { patches_truncated: true as const } : {}) };
}

const firstLine = (m: string | null) => (m ? m.split("\n")[0] : null);

// ── the tools ───────────────────────────────────────────────────────────────

const Repo = z.string().max(200).optional();
const RefStr = z.string().min(1).max(200).regex(/^[A-Za-z0-9._\/-]+$/, "a branch, tag or commit sha")
  .refine((v) => !v.split("/").some((x) => x === "." || x === ".."), "a branch, tag or commit sha");
const Ref = RefStr.optional();
const Num = z.number().int().positive().max(10_000_000);

export const GithubReadIn = z.object({ repo: Repo, path: z.string().max(500).optional(), ref: Ref });
export const GithubSearchIn = z.object({ repo: Repo, q: z.string().trim().min(1).max(200) });
export const GithubPullIn = z.object({ repo: Repo, number: Num, files: z.boolean().optional() });
export const GithubIssueIn = z.object({ repo: Repo, number: Num, comments: z.boolean().optional() });
export const GithubCommitIn = z.object({ repo: Repo, sha: RefStr });
export const GithubListIn = z.object({
  repo: Repo, what: z.enum(["pulls", "commits", "branches", "releases", "issues"]),
  state: z.enum(["open", "closed", "all"]).optional(), branch: Ref, path: z.string().max(500).optional(),
  limit: z.number().int().min(1).max(ASK_GITHUB_ROWS_MAX).optional(),
});
export const GithubCiIn = z.object({ repo: Repo, ref: Ref });

/** A file (its text, cut) or a folder (its entries). */
export async function githubRead(gh: AskGithub, args: z.infer<typeof GithubReadIn>): Promise<unknown> {
  const repo = repoOf(gh, args.repo);
  const path = encodePath(args.path ?? "");
  const body = await get(gh, repo.name, { path: `contents${path ? `/${path}` : ""}${qs({ ref: args.ref })}` });
  const base = { repo: repo.name, primary: repo.primary, path: args.path ?? "", ref: args.ref ?? null };
  if (Array.isArray(body)) {
    const entries = body.map((e) => { const x = o(e); return { name: s(x.name), path: s(x.path), type: s(x.type), size: n(x.size) }; });
    const DIR_MAX = 200;
    return { ...base, type: "dir", entries: entries.slice(0, DIR_MAX), ...(entries.length > DIR_MAX ? { truncated: true, note: `First ${DIR_MAX} of ${entries.length} entries.` } : {}) };
  }
  const f = o(body);
  const type = s(f.type);
  if (type !== "file") return { ...base, type, target: s(f.target), submodule_git_url: s(f.submodule_git_url), html_url: s(f.html_url) };
  const size = n(f.size);
  if (f.encoding !== "base64" || typeof f.content !== "string" || (!f.content && (size ?? 0) > 0)) {
    return { ...base, type: "file", size, text: null, note: "This file is too large for GitHub to return through its API; it was not read.", html_url: s(f.html_url) };
  }
  const text = decodeContent(f.content);
  if (text === null) return { ...base, type: "file", size, text: null, binary: true, note: "A binary file; its content is not shown.", html_url: s(f.html_url) };
  const c = cut(text, { left: ASK_GITHUB_TEXT_MAX });
  return { ...base, type: "file", size, sha: s(f.sha), text: c.text, ...(c.truncated ? { truncated: true } : {}), html_url: s(f.html_url) };
}

/** GitHub's code search, scoped by the transport to that one repository. */
export async function githubSearchCode(gh: AskGithub, args: z.infer<typeof GithubSearchIn>): Promise<unknown> {
  const repo = repoOf(gh, args.repo);
  const body = o(await get(gh, repo.name, { search: args.q }));
  const items = a(body.items).slice(0, ASK_GITHUB_ROWS_MAX).map((it) => {
    const x = o(it);
    const matches = a(x.text_matches).slice(0, 2).map((m) => short(s(o(m).fragment) ?? "", 300)).filter(Boolean);
    return { path: s(x.path), name: s(x.name), html_url: s(x.html_url), ...(matches.length ? { matches } : {}) };
  });
  return { repo: repo.name, query: args.q, total_count: n(body.total_count), incomplete_results: body.incomplete_results === true, items };
}

/** A pull request, and (by default) its changed files with their patches, cut. */
export async function githubPullRequest(gh: AskGithub, args: z.infer<typeof GithubPullIn>): Promise<unknown> {
  const repo = repoOf(gh, args.repo);
  const p = o(await get(gh, repo.name, { path: `pulls/${args.number}` }));
  const budget = { left: ASK_GITHUB_TEXT_MAX };
  const body = cut(s(p.body), budget, 4_000);
  const out: Record<string, unknown> = {
    repo: repo.name, primary: repo.primary, number: n(p.number), title: s(p.title), state: s(p.state), draft: p.draft === true,
    merged: p.merged === true, merged_at: s(p.merged_at), author: login(p.user), head: s(o(p.head).ref), base: s(o(p.base).ref), head_sha: s(o(p.head).sha),
    created_at: s(p.created_at), updated_at: s(p.updated_at), closed_at: s(p.closed_at),
    additions: n(p.additions), deletions: n(p.deletions), changed_files: n(p.changed_files), commits: n(p.commits),
    labels: a(p.labels).map((l) => s(o(l).name)).filter(Boolean), requested_reviewers: a(p.requested_reviewers).map(login).filter(Boolean),
    body: body.text, ...(body.truncated ? { body_truncated: true } : {}), html_url: s(p.html_url),
  };
  if (args.files !== false) {
    const rows = a(await get(gh, repo.name, { path: `pulls/${args.number}/files${qs({ per_page: ASK_GITHUB_ROWS_MAX })}` }));
    Object.assign(out, filesOf(rows, budget));
    if ((n(p.changed_files) ?? 0) > rows.length) out.files_note = `First ${rows.length} of ${n(p.changed_files)} changed files.`;
  }
  return out;
}

/** An issue, and (by default) its comments, cut. A pull request number answers too (GitHub serves PRs as issues). */
export async function githubIssue(gh: AskGithub, args: z.infer<typeof GithubIssueIn>): Promise<unknown> {
  const repo = repoOf(gh, args.repo);
  const i = o(await get(gh, repo.name, { path: `issues/${args.number}` }));
  const budget = { left: ASK_GITHUB_TEXT_MAX };
  const body = cut(s(i.body), budget, 6_000);
  const out: Record<string, unknown> = {
    repo: repo.name, number: n(i.number), title: s(i.title), state: s(i.state), state_reason: s(i.state_reason), is_pull_request: !!i.pull_request,
    author: login(i.user), assignees: a(i.assignees).map(login).filter(Boolean), labels: a(i.labels).map((l) => s(o(l).name)).filter(Boolean),
    milestone: s(o(i.milestone).title), comments_count: n(i.comments), created_at: s(i.created_at), updated_at: s(i.updated_at), closed_at: s(i.closed_at),
    body: body.text, ...(body.truncated ? { body_truncated: true } : {}), html_url: s(i.html_url),
  };
  if (args.comments !== false && (n(i.comments) ?? 0) > 0) {
    const rows = a(await get(gh, repo.name, { path: `issues/${args.number}/comments${qs({ per_page: ASK_GITHUB_ROWS_MAX })}` }));
    let truncated = false;
    out.comments = rows.slice(0, ASK_GITHUB_ROWS_MAX).map((c) => {
      const x = o(c);
      const t = cut(s(x.body), budget, 3_000);
      if (t.truncated) truncated = true;
      return { author: login(x.user), created_at: s(x.created_at), body: t.text };
    });
    if (truncated) out.comments_truncated = true;
  }
  return out;
}

/** A commit: its message, author, stats and changed files with their patches, cut. */
export async function githubCommit(gh: AskGithub, args: z.infer<typeof GithubCommitIn>): Promise<unknown> {
  const repo = repoOf(gh, args.repo);
  const c = o(await get(gh, repo.name, { path: `commits/${encodeURIComponent(args.sha)}` }));
  const commit = o(c.commit);
  const budget = { left: ASK_GITHUB_TEXT_MAX };
  const message = cut(s(commit.message), budget, 4_000);
  return {
    repo: repo.name, sha: s(c.sha), message: message.text, author: login(c.author) ?? s(o(commit.author).name), date: s(o(commit.author).date),
    committer: login(c.committer) ?? s(o(commit.committer).name), parents: a(c.parents).map((p) => s(o(p).sha)).filter(Boolean),
    stats: { additions: n(o(c.stats).additions), deletions: n(o(c.stats).deletions), total: n(o(c.stats).total) },
    ...filesOf(a(c.files), budget), html_url: s(c.html_url),
  };
}

/** Recent pull requests, commits, branches, releases or issues — newest first. */
export async function githubList(gh: AskGithub, args: z.infer<typeof GithubListIn>): Promise<unknown> {
  const repo = repoOf(gh, args.repo);
  const per = args.limit ?? 15;
  const base = { repo: repo.name, primary: repo.primary, what: args.what };
  switch (args.what) {
    case "pulls": {
      const rows = a(await get(gh, repo.name, { path: `pulls${qs({ state: args.state ?? "all", sort: "updated", direction: "desc", per_page: per })}` }));
      return { ...base, items: rows.map((r) => { const x = o(r); return { number: n(x.number), title: s(x.title), state: s(x.state), draft: x.draft === true, merged_at: s(x.merged_at), author: login(x.user), head: s(o(x.head).ref), base: s(o(x.base).ref), updated_at: s(x.updated_at) }; }) };
    }
    case "commits": {
      if (args.path) encodePath(args.path); // the same refusal as a read's path; it goes as a query value
      const rows = a(await get(gh, repo.name, { path: `commits${qs({ sha: args.branch, path: args.path, per_page: per })}` }));
      return { ...base, branch: args.branch ?? null, items: rows.map((r) => { const x = o(r); const c = o(x.commit); return { sha: s(x.sha)?.slice(0, 12) ?? null, message: short(firstLine(s(c.message)) ?? "", 200), author: login(x.author) ?? s(o(c.author).name), date: s(o(c.author).date) }; }) };
    }
    case "branches": {
      const rows = a(await get(gh, repo.name, { path: `branches${qs({ per_page: per })}` }));
      return { ...base, items: rows.map((r) => { const x = o(r); return { name: s(x.name), protected: x.protected === true, sha: s(o(x.commit).sha)?.slice(0, 12) ?? null }; }) };
    }
    case "releases": {
      const rows = a(await get(gh, repo.name, { path: `releases${qs({ per_page: per })}` }));
      return { ...base, items: rows.map((r) => { const x = o(r); return { tag: s(x.tag_name), name: s(x.name), draft: x.draft === true, prerelease: x.prerelease === true, published_at: s(x.published_at), author: login(x.author), notes: s(x.body) ? short(s(x.body)!, 600) : null }; }) };
    }
    case "issues": {
      const rows = a(await get(gh, repo.name, { path: `issues${qs({ state: args.state ?? "open", sort: "updated", direction: "desc", per_page: per })}` }));
      // GitHub lists pull requests among issues; they are left out here (list `pulls` for those).
      return { ...base, items: rows.filter((r) => !o(r).pull_request).map((r) => { const x = o(r); return { number: n(x.number), title: s(x.title), state: s(x.state), author: login(x.user), labels: a(x.labels).map((l) => s(o(l).name)).filter(Boolean), comments: n(x.comments), updated_at: s(x.updated_at) }; }) };
    }
  }
}

/** CI on a ref (default: the repository's default branch): its check runs and its combined commit status. */
export async function githubCi(gh: AskGithub, args: z.infer<typeof GithubCiIn>): Promise<unknown> {
  const repo = repoOf(gh, args.repo);
  const ref = args.ref ?? s(o(await get(gh, repo.name, { path: "" })).default_branch);
  if (!ref) throw new GithubToolError("failed", "GitHub did not say which branch is the default; name a ref.");
  const enc = encodeURIComponent(ref);
  const runs = o(await get(gh, repo.name, { path: `commits/${enc}/check-runs${qs({ per_page: ASK_GITHUB_ROWS_MAX })}` }));
  const status = o(await get(gh, repo.name, { path: `commits/${enc}/status` }));
  const checks = a(runs.check_runs).slice(0, ASK_GITHUB_ROWS_MAX).map((r) => {
    const x = o(r);
    return { name: s(x.name), status: s(x.status), conclusion: s(x.conclusion), app: s(o(x.app).slug), started_at: s(x.started_at), completed_at: s(x.completed_at), html_url: s(x.html_url) };
  });
  const count = (f: (c: (typeof checks)[number]) => boolean) => checks.filter(f).length;
  return {
    repo: repo.name, ref, sha: s(status.sha),
    summary: {
      checks: n(runs.total_count) ?? checks.length,
      passing: count((c) => c.conclusion === "success" || c.conclusion === "neutral" || c.conclusion === "skipped"),
      failing: count((c) => c.conclusion === "failure" || c.conclusion === "timed_out" || c.conclusion === "cancelled" || c.conclusion === "action_required" || c.conclusion === "startup_failure"),
      running: count((c) => c.status !== "completed"),
      combined_status: s(status.state),
    },
    check_runs: checks,
    statuses: a(status.statuses).slice(0, ASK_GITHUB_ROWS_MAX).map((x) => ({ context: s(o(x).context), state: s(o(x).state), description: s(o(x).description) })),
  };
}

/** The step's count line for a list or a search (the one wording — turn.ts `resultLine`), or "Truncated". */
export function githubLine(tool: string, out: unknown, resultLine: (n: number) => string): string | undefined {
  const x = o(out);
  if (tool === "github_search_code" || tool === "github_list") return resultLine(a(x.items).length);
  if (x.truncated || x.patches_truncated || x.body_truncated || x.comments_truncated) return "Truncated";
  return undefined;
}

/** The tools' definitions as the model is offered them (only while the org has a connected repository). */
export const GITHUB_DEFS: { name: string; description: string; input_schema: Record<string, unknown> }[] = [
  {
    name: "github_read",
    description: "Read a file, or list a folder, in one of the organization's connected GitHub repositories (read-only). `path` is from the repository root (empty = the root folder); `ref` a branch, tag or commit (default: the default branch). A file comes back as text, cut past a size with a note; a folder as its entries.",
    input_schema: { type: "object", properties: { repo: { type: "string", description: "owner/name of a connected repository (default: the primary)." }, path: { type: "string" }, ref: { type: "string" } } },
  },
  {
    name: "github_search_code",
    description: "Search the code of one connected GitHub repository (GitHub's code search, default branch only). `q` is words or a symbol, optionally with qualifiers like `path:src` `language:ts` `extension:md`. Returns matching files with short fragments; read a file with github_read.",
    input_schema: { type: "object", properties: { repo: { type: "string" }, q: { type: "string" } }, required: ["q"] },
  },
  {
    name: "github_pull_request",
    description: "Read one pull request of a connected repository on GitHub: its state, branches, author, description, and (unless `files` is false) its changed files with their diffs, cut past a size.",
    input_schema: { type: "object", properties: { repo: { type: "string" }, number: { type: "integer" }, files: { type: "boolean" } }, required: ["number"] },
  },
  {
    name: "github_issue",
    description: "Read one GitHub issue of a connected repository: its state, labels, assignees, body and (unless `comments` is false) its comments, cut past a size.",
    input_schema: { type: "object", properties: { repo: { type: "string" }, number: { type: "integer" }, comments: { type: "boolean" } }, required: ["number"] },
  },
  {
    name: "github_commit",
    description: "Read one commit of a connected repository (by sha, or a branch for its newest commit): message, author, stats and changed files with their diffs, cut past a size.",
    input_schema: { type: "object", properties: { repo: { type: "string" }, sha: { type: "string" } }, required: ["sha"] },
  },
  {
    name: "github_list",
    description: `List the newest items of a connected repository on GitHub: \`what\` is pulls (state open / closed / all, default all), commits (optional \`branch\`, \`path\`), branches, releases, or issues (state, default open; pull requests left out). Up to ${ASK_GITHUB_ROWS_MAX} (\`limit\`, default 15).`,
    input_schema: {
      type: "object",
      properties: {
        repo: { type: "string" }, what: { type: "string", enum: ["pulls", "commits", "branches", "releases", "issues"] },
        state: { type: "string", enum: ["open", "closed", "all"] }, branch: { type: "string" }, path: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: ASK_GITHUB_ROWS_MAX },
      },
      required: ["what"],
    },
  },
  {
    name: "github_ci",
    description: "CI on a branch, tag or commit of a connected repository, read on GitHub now: each check run's status and conclusion, and the combined commit status (default: the default branch). For CI over time, use get_repo_dashboard or show_chart.",
    input_schema: { type: "object", properties: { repo: { type: "string" }, ref: { type: "string" } } },
  },
];

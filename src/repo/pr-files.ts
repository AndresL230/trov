// A pull request's changed files (Repo setups, Phase E) — what lets the App menu say which apps a PR touches. Read
// from GitHub (`GET /pulls/{n}/files`, at most `PR_FILES_PAGES` pages of 100) ONLY for a repository with two or more
// apps (with one, every PR is that app's), for open PRs and PRs merged in the last `PR_FILES_MERGED_DAYS` days, and
// put through the gate's PR-files arm (`ingestPrFiles`, src/consumer.ts). Two triggers, both off the render path:
//
//   - the `pull_request` webhook (opened / reopened / synchronize / closed-merged, src/webhook.ts) — skipped without
//     a request when the files were already read for the PR's current head;
//   - reconcile's `pr_files` arm (`reconcilePrFiles`) — the self-heal, bounded by its request allowance
//     (`PR_FILES_REQUESTS` for Poll now, `PR_FILES_SYNC_REQUESTS` for the cron and Sync GitHub): a PR is started only
//     while a whole read (3 pages) still fits, open PRs first, newest first.
import { REPO_WIDE } from "@shared/repo-facts-core";
import type { TenantContext } from "../data/sql";
import { ingestPrFiles } from "../consumer";
import { listRepoApps } from "./apps-read";
import { ghJson, type GhOpts } from "./gh-http";
import { prReadHeads } from "./pr-files-store";
import { prStatesAsOf } from "./reads";

export const PR_FILES_PAGES = 3;
export const PR_FILES_PER_PAGE = 100;
/** Merged PRs are read this long after they merged (the Code tab's "merged this week" and its 14-day bars). */
export const PR_FILES_MERGED_DAYS = 14;
/** Reconcile's PR-files allowance in requests — three PRs' worst case. Counted in `reconcileRequests` (Poll now's
 *  `refreshSubrequests`, which `SUBREQUEST_CAP` = 100 bounds). */
export const PR_FILES_REQUESTS = 3 * PR_FILES_PAGES;
/** The cron's and Sync GitHub's allowance (ten PRs' worst case): their budgets are the invocation's, not Poll
 *  now's. `reconcileCost` counts the difference. */
export const PR_FILES_SYNC_REQUESTS = 10 * PR_FILES_PAGES;

const DAY = 86_400_000;
/** `pull_request` actions that read a PR's files: a new head (opened, reopened, synchronize) or the merge. */
const READ_ACTIONS = new Set(["opened", "reopened", "synchronize"]);

/** Whether a repository's PRs need their files read: two or more apps (Packages count — a PR that touches only a
 *  package is still told apart from one that touches an app). The REPO_WIDE key is never an app. */
export async function prFilesWanted(ctx: TenantContext, repo: string): Promise<boolean> {
  const apps = await listRepoApps(ctx, repo);
  return apps.filter((a) => a.key !== REPO_WIDE).length >= 2;
}

/** One PR's files, ≤ `pages` pages. `complete` = the last page came back short. Throws on a failed read. */
export async function fetchPrFiles(opts: GhOpts, number: number, pages = PR_FILES_PAGES): Promise<{ files: string[]; complete: boolean; requests: number }> {
  const files: string[] = [];
  for (let page = 1; page <= pages; page++) {
    const list = await ghJson<{ filename?: unknown }[]>(opts, `/pulls/${number}/files?per_page=${PR_FILES_PER_PAGE}&page=${page}`);
    const items = Array.isArray(list) ? list : [];
    for (const f of items) if (typeof f?.filename === "string" && f.filename && f.filename.length <= 400) files.push(f.filename.replace(/^\/+/, ""));
    if (items.length < PR_FILES_PER_PAGE) return { files, complete: true, requests: page };
  }
  return { files, complete: false, requests: pages };
}

/** Read one PR's files and put them through the gate. */
export async function capturePrFiles(ctx: TenantContext, opts: GhOpts, number: number, headSha: string | null): Promise<{ outcome: "written" | "unchanged"; requests: number }> {
  const read = await fetchPrFiles(opts, number);
  const res = await ingestPrFiles(ctx, { repo: opts.repo, number, headSha, files: read.files, complete: read.complete });
  return { ...res, requests: read.requests };
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v !== null && typeof v === "object" ? (v as Obj) : null);

/** The PR a `pull_request` delivery asks to read, or null (another action, a closed-unmerged PR, no number). PURE. */
export function prFilesTarget(payload: unknown): { number: number; headSha: string | null } | null {
  const p = obj(payload);
  const pr = obj(p?.pull_request);
  const action = typeof p?.action === "string" ? p.action : "";
  const number = typeof pr?.number === "number" ? pr.number : null;
  if (!pr || number === null) return null;
  if (!READ_ACTIONS.has(action) && !(action === "closed" && pr.merged === true)) return null;
  const sha = obj(pr.head)?.sha;
  return { number, headSha: typeof sha === "string" && sha ? sha : null };
}

/** The webhook's trigger: read the delivery's PR files when the repository has two or more apps and they were not
 *  already read for its head. Never throws (logged by the caller's guard). */
export async function prFilesOnDelivery(ctx: TenantContext, gh: () => Promise<GhOpts | null>, repo: string, payload: unknown): Promise<"read" | "skipped"> {
  const t = prFilesTarget(payload);
  if (!t || !(await prFilesWanted(ctx, repo))) return "skipped";
  if (t.headSha && (await prReadHeads(ctx, repo, [t.number])).get(t.number) === t.headSha) return "skipped";
  const opts = await gh();
  if (!opts) return "skipped";
  await capturePrFiles(ctx, opts, t.number, t.headSha);
  return "read";
}

/**
 * Reconcile's `pr_files` arm: the open PRs and the PRs merged in the last 14 days whose files were never read for
 * their current head — open first, then merged, newest first — read while a whole PR (`PR_FILES_PAGES` requests)
 * still fits in `allowance`. Nothing for a repository with fewer than two apps. Returns what it wrote and spent;
 * THROWS on a failed read (reconcile names the arm in `failed`), after storing what it did read.
 */
export async function reconcilePrFiles(ctx: TenantContext, opts: GhOpts, now: number, allowance: number = PR_FILES_REQUESTS): Promise<{ written: number; unchanged: number; requests: number }> {
  const out = { written: 0, unchanged: 0, requests: 0 };
  if (allowance < PR_FILES_PAGES || !(await prFilesWanted(ctx, opts.repo))) return out;
  const since = new Date(now - PR_FILES_MERGED_DAYS * DAY).toISOString();
  const latest = await prStatesAsOf(ctx, new Date(now).toISOString());
  const open = latest.filter((r) => r.state === "draft" || r.state === "review");
  const merged = latest.filter((r) => r.state === "merged" && r.occurred_at > since);
  const byNewest = (a: { occurred_at: string }, b: { occurred_at: string }) => (a.occurred_at < b.occurred_at ? 1 : a.occurred_at > b.occurred_at ? -1 : 0);
  const candidates = [...open.sort(byNewest), ...merged.sort(byNewest)].filter((r) => typeof r.number === "number" && r.number > 0);
  const heads = await prReadHeads(ctx, opts.repo, candidates.map((r) => r.number!));
  for (const r of candidates) {
    if (heads.has(r.number!) && (r.sha === null || heads.get(r.number!) === r.sha)) continue; // read for this head
    if (allowance - out.requests < PR_FILES_PAGES) break;
    const res = await capturePrFiles(ctx, opts, r.number!, r.sha);
    out.requests += res.requests;
    if (res.outcome === "written") out.written++; else out.unchanged++;
  }
  return out;
}

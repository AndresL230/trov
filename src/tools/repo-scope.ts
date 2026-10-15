// The Code and CI tabs narrowed by the App menu (Repo setups, Phase E) — part of the Repo dashboard's ONE projection
// (`getRepoDashboard`, ./repo.ts), so `GET /repo/dashboard?app=` and MCP `get_repo_dashboard { app }` narrow alike.
// D1 only: what a PR, a commit or a run touched was captured off the render path (src/repo/pr-files.ts,
// src/repo/commit-paths.ts); the rules are shared/repo-scope-core.ts.
//
// Never guess. A PR whose files were never read, a commit with no exact file list, a run whose workflow names no app
// and whose head commit's files are not known — each is UNKNOWN: listed under All apps only (no "touches" line),
// never under an app or "Repo-wide only", and a figure narrowed to an app that would count one reads `null` ("—")
// with how many are not known yet.
import type { RepoApp } from "@shared/repo-apps-core";
import { REPO_WIDE } from "@shared/repo-facts-core";
import type { RepoBars, RepoCiFailure, RepoCodeStat } from "@shared/repo";
import { inScope, type ScopeApp, type Touch } from "@shared/repo-scope-core";
import type { TenantContext } from "../data/sql";
import { commitPathsFor, type KnownPaths } from "../repo/commit-paths";
import { prFilesFor, type PrFiles } from "../repo/pr-files-store";
import { packageUsers, scopeApps, touchesOf, type RunRow } from "../repo/app-scope";
import type { RepoEventRow } from "../repo/types";

/** A touch with whether its list is whole (a PR read past its page cap is not: "touches none" is then unknown). */
export type ScopedTouch = Touch & { complete: boolean };
const UNKNOWN: ScopedTouch = { touches: null, packages: [], complete: false };

/** What the narrowing reads from D1 for one paint: every listed / counted PR's files, every counted commit's exact
 *  files, every run head's files (exact, else its push's), and the Packages' users. Four statements and their
 *  fan-outs, whatever the app. */
export interface ScopeReads {
  apps: RepoApp[];
  sapps: ScopeApp[];
  prFiles: Map<number, PrFiles>;
  commits: Map<string, KnownPaths>;
  runHeads: Map<string, KnownPaths>;
  /** Each Package's users (app keys), `null` when the scan never described it. */
  users: Map<string, string[] | null>;
}

export async function readScope(ctx: TenantContext, repo: string, apps: RepoApp[], o: { prs: number[]; commits: string[]; runs: string[] }): Promise<ScopeReads> {
  const [prFiles, commits, runHeads, users] = await Promise.all([
    prFilesFor(ctx, repo, o.prs),
    commitPathsFor(ctx, repo, o.commits),
    commitPathsFor(ctx, repo, o.runs, true),
    packageUsers(ctx, repo, apps),
  ]);
  return { apps, sapps: scopeApps(apps, users), prFiles, commits, runHeads, users };
}

/** A PR's touch: from its read files, or UNKNOWN when they were never read. */
export function prTouch(s: ScopeReads, number: number | null): ScopedTouch {
  const f = number !== null ? s.prFiles.get(number) : undefined;
  return f ? { ...touchesOf(f.paths, s.apps), complete: f.complete } : UNKNOWN;
}

/** A commit's touch: from its exact files, or UNKNOWN. */
export function commitTouch(s: ScopeReads, sha: string | null): ScopedTouch {
  const k = sha ? s.commits.get(sha.toLowerCase()) : undefined;
  return k ? { ...touchesOf(k.paths, s.apps), complete: true } : UNKNOWN;
}

/** The wire form of a touch (`RepoPr.touches` / `packages`). */
export const touchWire = (t: Touch): { touches: string[] | null; packages: string[] } => ({ touches: t.touches, packages: t.touches === null ? [] : t.packages ?? [] });

/** Under `app`: is it in (true), out (false) or unknown (null)? */
export const scoped = (s: ScopeReads, app: string, t: ScopedTouch): boolean | null => inScope(t, app, s.sapps, t.complete);

// ── commits ──────────────────────────────────────────────────────────────────

/** One commit a captured push carried, dated by the PUSH (like every commit figure): a webhook push's distinct
 *  commits (`raw.commits`), a backfilled push's own sha. A webhook push that kept no list counts `count` unknown ones. */
export interface PushedCommit { sha: string | null; author: string | null; at: string }
export function pushedCommits(p: Pick<RepoEventRow, "raw" | "sha" | "count" | "actor_login" | "occurred_at" | "provenance">): PushedCommit[] {
  let raw: { backfill?: unknown; commits?: unknown } = {};
  try { raw = JSON.parse(p.raw) as typeof raw; } catch { /* nothing listed */ }
  if (raw.backfill === true || p.provenance === "backfill") return [{ sha: p.sha, author: p.actor_login, at: p.occurred_at }];
  const listed = (Array.isArray(raw.commits) ? raw.commits : [])
    .map((c) => (c && typeof c === "object" ? c as { id?: unknown; distinct?: unknown; author?: unknown } : null))
    .filter((c): c is { id?: unknown; distinct?: unknown; author?: unknown } => c !== null && c.distinct === true)
    .map((c) => ({ sha: typeof c.id === "string" ? c.id : null, author: typeof c.author === "string" ? c.author : p.actor_login, at: p.occurred_at }));
  const missing = Math.max(0, (p.count ?? 0) - listed.length);
  return [...listed, ...Array.from({ length: missing }, () => ({ sha: null, author: p.actor_login, at: p.occurred_at }))];
}

// ── the Code tab under an app ────────────────────────────────────────────────

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;
/** In / unknown counts of a list under `app`. */
function tally<T>(s: ScopeReads, app: string, items: readonly T[], t: (x: T) => ScopedTouch): { in: T[]; unknown: number } {
  const out: T[] = [];
  let unknown = 0;
  for (const x of items) {
    const v = scoped(s, app, t(x));
    if (v === true) out.push(x); else if (v === null) unknown++;
  }
  return { in: out, unknown };
}
const notRead = (n: number, what: string): string => `${plural(n, what)} not read yet`;

/** How many of these touches belong under `app` — `null` when any is unknown (the App menu's open-PR counts). */
export function countIn(s: ScopeReads, app: string, touches: readonly ScopedTouch[]): number | null {
  const t = tally(s, app, touches, (x) => x);
  return t.unknown ? null : t.in.length;
}

export interface ScopedCodeInputs {
  app: string;
  prCaptured: boolean;
  /** Open PRs now (latest state draft / review), each with whether it is awaiting review. */
  open: { number: number | null; awaiting: boolean }[];
  /** PRs merged this week (`events`), with their author. */
  merged: { number: number; author: string }[];
  /** PRs closed unmerged this week — the first tile until open PRs are captured. */
  closedUnmerged: { number: number }[];
  /** The week's pushed commits (empty when no push was ever captured). */
  commits: PushedCommit[];
  pushesCaptured: boolean;
}

/** The four Code tiles narrowed to `app` (or `REPO_WIDE`): Open PRs (or Closed unmerged), Merged this week, Commits
 *  this week (or Issues opened stays repo-wide: nothing to narrow), Contributors. A figure with an unknown member is
 *  `null`, its sub saying how many. */
export function scopedCodeStats(s: ScopeReads, i: ScopedCodeInputs, issuesOpened: number): RepoCodeStat[] {
  const tiles: RepoCodeStat[] = [];
  if (i.prCaptured) {
    const o = tally(s, i.app, i.open, (r) => prTouch(s, r.number));
    tiles.push({ label: "Open PRs", value: o.unknown ? null : o.in.length, sub: o.unknown ? notRead(o.unknown, "pull request") : `${o.in.filter((r) => r.awaiting).length} awaiting review`, tone: "neutral" });
  } else {
    const c = tally(s, i.app, i.closedUnmerged, (r) => prTouch(s, r.number));
    tiles.push({ label: "Closed unmerged", value: c.unknown ? null : c.in.length, sub: c.unknown ? notRead(c.unknown, "pull request") : "this week", tone: "neutral" });
  }
  const m = tally(s, i.app, i.merged, (r) => prTouch(s, r.number));
  const mergers = new Set(m.in.map((r) => r.author.toLowerCase())).size;
  tiles.push({ label: "Merged this week", value: m.unknown ? null : m.in.length,
    sub: m.unknown ? notRead(m.unknown, "pull request") : mergers === 0 ? "this week" : mergers === 1 ? "by 1 person" : `by ${mergers} people`, tone: "neutral" });
  const c = tally(s, i.app, i.commits, (x) => commitTouch(s, x.sha));
  if (i.pushesCaptured) {
    tiles.push({ label: "Commits this week", value: c.unknown ? null : c.in.length, sub: c.unknown ? `${plural(c.unknown, "commit")} with paths unknown` : "this week", tone: "neutral" });
  } else {
    tiles.push({ label: "Issues opened", value: issuesOpened, sub: "this week · repo-wide", tone: "neutral" });
  }
  // Who worked on it this week: the authors of its commits and of its merged PRs — known only when both are.
  const who = new Set([...c.in.map((x) => x.author?.toLowerCase()).filter((x): x is string => !!x), ...m.in.map((r) => r.author.toLowerCase())]);
  const unknown = c.unknown + m.unknown;
  tiles.push({ label: "Contributors", value: unknown ? null : who.size, sub: unknown ? "until every change is read" : "this week", tone: "neutral" });
  return tiles;
}

/** The 14-day bars narrowed to `app`: its commits per push day (or, before pushes are captured, its merges per day). */
export function scopedBars(s: ScopeReads, app: string, label: string, days: string[], items: { at: string; t: ScopedTouch }[], commits: boolean): RepoBars {
  const per = new Map<string, number>();
  let unknown = 0, total = 0;
  for (const x of items) {
    const v = scoped(s, app, x.t);
    if (v === true) { per.set(x.at.slice(0, 10), (per.get(x.at.slice(0, 10)) ?? 0) + 1); total++; }
    else if (v === null) unknown++;
  }
  const noun = commits ? "commit" : "merged PR";
  const where = app === REPO_WIDE ? "outside every app" : `touching ${label}`;
  return {
    title: `${commits ? "Commit" : "Merge"} activity — last ${days.length} days`,
    note: `${plural(total, noun)} · ${where}${unknown ? ` · ${unknown} with paths unknown` : ""}`,
    days: days.map((date) => ({ date, count: per.get(date) ?? 0 })),
  };
}

// ── the CI tab ───────────────────────────────────────────────────────────────

const DECISIVE = ["success", "failure", "timed_out"];
const FAILED = ["failure", "timed_out"];
export interface RunTouch { run: RunRow; t: ScopedTouch & { approx: boolean } }

/** A failure as the CI tab lists it, with its apps when the repository has two or more. */
export const failureOf = (r: RunTouch, multi: boolean): RepoCiFailure => ({
  workflow: r.run.name ?? "workflow", branch: r.run.ref ?? "", job: r.run.title ?? "—", at: r.run.occurred_at, url: r.run.url ?? "",
  ...(multi ? { apps: r.t.touches === null ? null : [...r.t.touches, ...(r.t.packages ?? [])], ...(r.t.approx && r.t.touches !== null ? { approx: true } : {}) } : {}),
});

/** CI failures narrowed to `app`: its failed runs this week (≤ `limit`, and the count), and the 7-day rate over its
 *  decisive runs — `null` (with no trend) unless `rateOk` (a week of run capture) AND every decisive run of the window
 *  is attributed: a rate over the runs that happen to be known would be a guess. */
export function scopedCi(s: ScopeReads, app: string, runs: RunTouch[], weekAgo: string, now: number, limit: number, rateOk: boolean): { rows: RepoCiFailure[]; total: number; rate: number | null; trend: number[] } {
  const failed = runs.filter((r) => r.run.occurred_at > weekAgo && FAILED.includes(r.run.state ?? "") && scoped(s, app, r.t) === true);
  const day = (i: number) => new Date(now - i * 86_400_000).toISOString().slice(0, 10);
  const since = `${day(6)}T00:00:00.000Z`;
  const window = runs.filter((r) => r.run.occurred_at >= since && DECISIVE.includes(r.run.state ?? ""));
  let rate: number | null = null;
  let trend: number[] = [];
  if (rateOk && window.every((r) => scoped(s, app, r.t) !== null)) {
    const mine = window.filter((r) => scoped(s, app, r.t) === true);
    let bad = 0, total = 0;
    for (let i = 6; i >= 0; i--) {
      const of = mine.filter((r) => r.run.occurred_at.slice(0, 10) === day(i));
      const b = of.filter((r) => r.run.state !== "success").length;
      bad += b; total += of.length;
      trend.push(of.length ? Math.round((b / of.length) * 1000) / 10 : 0);
    }
    rate = total ? Math.round((bad / total) * 1000) / 10 : 0;
  }
  return { rows: failed.slice(0, limit).map((r) => failureOf(r, true)), total: failed.length, rate, trend: rate === null ? [] : trend };
}

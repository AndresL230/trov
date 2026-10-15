// The Repo Overview's computed facts (repo setups, Phase B) — what merged and is not serving, which apps of an
// environment run an older commit than the others, and the drift along the promotion chain. Each is a GitHub
// `compare`, so each runs OFF the render path — in `reconcileRepo` (its guarded `drift` / `not_shipped` /
// `out_of_step` arms) and on a push to an environment branch (`refreshDrift`, src/webhook.ts) — and stores a
// `repo_snapshots` row the facts read only reads back (src/tools/repo-facts.ts):
//
//   drift_chain   one step per ADJACENT pair of environments whose branches differ (`<next>...<earlier>`: what the
//                 earlier branch has that the next lacks), grouped by the PR that landed each commit — the
//                 promotion chain. It replaces the old first↔last pair; the `drift` section's snapshot is now
//                 its LAST step (for two environments, exactly the old pair). ≤ N compares for N environments:
//                 N − 1 steps plus the behind side of the last step (the `drift` section's BEHIND group).
//   not_shipped   per part of the primary repository's apps, with a serving commit: `<serving sha>...<branch>`,
//                 grouped by PR (a squash merge's trailing `(#123)`) or as direct pushes. In a repository with ≥ 2
//                 apps the commits are kept to the app's watch paths (./watch.ts), each commit's files read from
//                 `commit_paths` (Phase E, ./commit-paths.ts — exact rows only; GitHub's compare lists one combined
//                 file list for the range, which cannot say which commit touched what). A commit whose files are
//                 not known stays IN, counted, and its group says how many (`pathsUnknown`) — never dropped.
//                 Incremental: a part is compared again only when its serving sha or its branch head changed, or
//                 when a commit it kept as unknown has paths now (a D1 read finds out).
//   out_of_step   per environment where the primary repository's apps serve different commits: the part with the
//                 NEWEST serving deploy is the reference, and one compare per other distinct sha says how far
//                 behind it each is. Incremental: an environment is compared again only when its shas changed.
//
// THE BOUND: not_shipped and out_of_step share `FACTS_COMPARE_CAP` compares per run (the parts and environments
// left over keep their previous entry and go first next time); the chain costs `driftCompares(N)`. `reconcileCost`
// (src/repo/cron.ts) counts both. Each arm THROWS on failure, after storing what it did compute, so reconcile
// names it in `failed` and the last good entries stand.
import type { FactsCommitGroup, FactsDriftStep, FactsOutOfStep } from "@shared/repo-facts-core";
import { fanOut, type TenantContext } from "../data/sql";
import { listAllParts, type PartRow } from "../hosting/parts";
import { listRepoApps } from "./apps-read";
import type { RepoEnvConfig } from "./config";
import {
  notShippedKey, servingShas,
  type DriftChainSnapshot, type NotShippedEntry, type NotShippedSnapshot, type OutOfStepEntry, type OutOfStepSnapshot,
} from "./facts-store";
import { ghJson, type GhOpts } from "./gh-http";
import { branchHeads } from "./reads";
import { getSnapshot, putSnapshot } from "./store";
import { matchesWatch } from "./watch";
import { commitPathsFor, type KnownPaths } from "./commit-paths";

/** not_shipped + out_of_step compares, together, per run. */
export const FACTS_COMPARE_CAP = 6;
/** The promotion chain's compares for N environments (N − 1 steps + the last step's behind side), counted as the
 *  old first↔last drift's 2 when that is more, so no budget shrank. */
export const driftCompares = (n: number): number => Math.max(2, n);

const SHA = /^[0-9a-f]{7,64}$/i;
/** Two spellings of one commit (a 7-character and a 40-character sha). */
const sameSha = (a: string, b: string): boolean => {
  const x = a.toLowerCase(), y = b.toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
};

export interface GhCompareCommit {
  sha: string;
  commit: { message: string; committer?: { date?: string | null } | null; author?: { date?: string | null } | null };
  author: { login?: string | null } | null;
  /** Not in GitHub's compare today — see the header. When a commit carries it, it is that commit's files (else `commit_paths`). */
  files?: { filename?: string }[];
}
export interface GhCompare { status?: string; ahead_by: number; behind_by: number; commits: GhCompareCommit[] }

const compare = (opts: GhOpts, base: string, head: string): Promise<GhCompare> =>
  ghJson<GhCompare>(opts, `/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);

const firstLine = (c: GhCompareCommit): string => c.commit.message.split("\n")[0];
const commitAt = (c: GhCompareCommit): string => c.commit.committer?.date ?? c.commit.author?.date ?? "";

/**
 * Commits grouped the way the Overview shows them: one group per PR a squash merge names (`(#123)` at the end of
 * the first line), newest PR first, with the PR's captured title and author (`repo_events` `pr` rows) when known;
 * then the rest as one `direct` group. Commits newest first, 7-character shas. `more` stays 0: a compare's 250-commit
 * cap cannot be attributed to a group (the count beside the groups is GitHub's own total).
 */
export async function groupCommits(ctx: TenantContext, commits: GhCompareCommit[], branch: string): Promise<FactsCommitGroup[]> {
  const byPr = new Map<number, GhCompareCommit[]>();
  const direct: GhCompareCommit[] = [];
  for (const c of commits) {
    const m = firstLine(c).match(/\(#(\d+)\)\s*$/);
    if (m) byPr.set(Number(m[1]), [...(byPr.get(Number(m[1])) ?? []), c]);
    else direct.push(c);
  }
  // A compare returns up to 250 commits — past D1's 100 bound parameters, so in chunks (as computeDrift does).
  const known = await fanOut<{ number: number; title: string | null; actor_login: string | null; merged_at: string | null }>(
    ctx, [...byPr.keys()],
    (p) => `SELECT number, MAX(title) AS title, MAX(actor_login) AS actor_login, MAX(CASE WHEN state = 'merged' THEN occurred_at END) AS merged_at
              FROM repo_events WHERE org_id = ? AND kind = 'pr' AND number IN (${p}) GROUP BY number`,
    [ctx.orgId]);
  const toCommit = (c: GhCompareCommit) => ({ sha: c.sha.slice(0, 7), msg: firstLine(c).slice(0, 160), at: commitAt(c) });
  const newestFirst = (rows: GhCompareCommit[]) => rows.map(toCommit).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const groups: FactsCommitGroup[] = [];
  for (const [pr, list] of [...byPr.entries()].sort((a, b) => b[0] - a[0])) {
    const k = known.find((r) => r.number === pr);
    const cs = newestFirst(list);
    const by = k?.actor_login ?? list[0].author?.login ?? null;
    groups.push({
      kind: "pr", pr, title: k?.title ?? firstLine(list[0]), by: by ? [by] : [],
      // A squash merge's commit IS the merge (GitHub commits it), so its date stands in when no `pr` row says.
      mergedAt: k?.merged_at ?? cs[0]?.at ?? null, commits: cs, more: 0,
    });
  }
  if (direct.length) {
    const by = [...new Set(direct.map((c) => c.author?.login).filter((l): l is string => !!l))];
    groups.push({ kind: "direct", pr: null, title: `Direct pushes to ${branch}`, by, mergedAt: null, commits: newestFirst(direct), more: 0 });
  }
  return groups;
}

// ── the promotion chain ─────────────────────────────────────────────────────

/** The chain's last step's two compares, for the `drift` section's snapshot (src/repo/github.ts `computeDrift`). */
export interface ChainLast { head: string; base: string; ahead: GhCompare }

/** Compute and store `drift_chain`. Returns the last step's compare (null with < 2 environments or one branch
 *  for all). THROWS on a failed compare, before writing — the last good chain stands. */
export async function computeDriftChain(ctx: TenantContext, opts: GhOpts, envs: RepoEnvConfig[], now: number = Date.now()): Promise<ChainLast | null> {
  if (envs.length < 2) return null;
  const steps: FactsDriftStep[] = [];
  let last: ChainLast | null = null;
  for (let i = 0; i + 1 < envs.length; i++) {
    const from = envs[i], to = envs[i + 1];
    if (from.branch === to.branch) continue;
    const ahead = await compare(opts, to.branch, from.branch);
    steps.push({
      fromEnv: from.key, toEnv: to.key, from: from.branch, to: to.branch,
      ahead: ahead.ahead_by, behind: ahead.behind_by, groups: await groupCommits(ctx, ahead.commits ?? [], from.branch),
    });
    last = { head: from.branch, base: to.branch, ahead };
  }
  const snap: DriftChainSnapshot = { steps };
  await putSnapshot(ctx, "drift_chain", snap, new Date(now).toISOString());
  return last;
}

// ── shared inputs of the two capped arms ─────────────────────────────────────

/** A run's compares for not_shipped + out_of_step — `left` counts down from `FACTS_COMPARE_CAP`. */
export interface FactsBudget { left: number }
export const factsBudget = (): FactsBudget => ({ left: FACTS_COMPARE_CAP });

interface ServingPart { part: PartRow; app: string; sha: string; at: string; watch: string[] }

/** The primary repository's apps' parts that serve a known commit (their CURRENT provider's newest ready
 *  production deploy, with a sha), and how many apps the repository has. */
async function servingParts(ctx: TenantContext, repo: string): Promise<{ parts: ServingPart[]; appCount: number }> {
  const all = await listAllParts(ctx);
  const apps = (await listRepoApps(ctx, repo, all)).filter((a) => a.kind !== "Package");
  const byKey = new Map(apps.map((a) => [a.key, a]));
  const serving = await servingShas(ctx);
  const parts: ServingPart[] = [];
  for (const p of all) {
    const app = byKey.get(p.key);
    if (!app) continue;
    const s = serving.find((r) => r.env === p.env && r.part === p.key && r.provider === p.provider);
    if (s?.sha && SHA.test(s.sha)) parts.push({ part: p, app: app.key, sha: s.sha, at: s.at, watch: app.watch });
  }
  return { parts, appCount: apps.length };
}

// ── not shipped ──────────────────────────────────────────────────────────────

/** Compute what each part's branch has that its serving commit lacks, and merge it into `not_shipped`.
 *  `branch`: only the parts of environments on that branch (a push). */
export async function computeNotShipped(
  ctx: TenantContext, opts: GhOpts, envs: RepoEnvConfig[], budget: FactsBudget, now: number = Date.now(), branch?: string,
): Promise<void> {
  if (!envs.length) return;
  const { parts, appCount } = await servingParts(ctx, opts.repo);
  const prev = (await getSnapshot<NotShippedSnapshot>(ctx, "not_shipped"))?.data?.parts ?? {};
  const heads = await branchHeads(ctx, envs.map((e) => e.branch));
  const keep = new Set(parts.map((p) => notShippedKey(p.part.env, p.app)));
  const next: Record<string, NotShippedEntry> = Object.fromEntries(Object.entries(prev).filter(([k]) => keep.has(k)));

  // Phase E: an entry that kept commits of unknown paths is computed again once one of them has paths (a D1 read —
  // no GitHub request to find out).
  const waiting = appCount >= 2 ? [...new Set(Object.values(prev).flatMap((e) => e.unknown ?? []))] : [];
  const nowKnown = waiting.length ? await commitPathsFor(ctx, opts.repo, waiting) : new Map<string, KnownPaths>();
  const todo = parts
    .filter((p) => branch === undefined || p.part.branch === branch)
    .filter((p) => {
      const e = prev[notShippedKey(p.part.env, p.app)];
      const head = heads.get(p.part.branch) ?? null;
      return !e || !sameSha(e.servingSha, p.sha) || e.head === null || head === null || e.head !== head
        || (e.unknown ?? []).some((s) => nowKnown.has(s));
    })
    // never computed first, then the oldest
    .sort((a, b) => (prev[notShippedKey(a.part.env, a.app)]?.computedAt ?? "").localeCompare(prev[notShippedKey(b.part.env, b.app)]?.computedAt ?? ""));

  const at = new Date(now).toISOString();
  let failure: unknown = null;
  for (const p of todo) {
    if (budget.left <= 0) break;
    budget.left--;
    try {
      const cmp = await compare(opts, p.sha, p.part.branch);
      const commits = cmp.commits ?? [];
      // Watch paths, in a repository with two or more apps (Phase E): each commit's files are its own `files` when
      // the compare lists them (it does not today), else its captured `commit_paths` (exact rows only — a push's
      // rows are never read as a commit's). A commit whose files are not known stays IN, counted and flagged in
      // its group ("paths unknown") — never dropped. With one app, every commit counts, unfiltered.
      const multi = appCount >= 2 && commits.length > 0;
      const captured = multi ? await commitPathsFor(ctx, opts.repo, commits.filter((c) => !Array.isArray(c.files)).map((c) => c.sha)) : new Map<string, KnownPaths>();
      const pathsOf = (c: GhCompareCommit): string[] | null => Array.isArray(c.files)
        ? c.files.map((f) => f.filename).filter((f): f is string => typeof f === "string")
        : captured.get(c.sha.toLowerCase())?.paths ?? null;
      const filter = multi && commits.some((c) => pathsOf(c) !== null);
      const kept = filter
        ? commits.filter((c) => { const ps = pathsOf(c); return ps === null || ps.some((f) => matchesWatch(f, p.watch)); })
        : commits;
      const unknown = multi ? kept.filter((c) => pathsOf(c) === null).map((c) => c.sha.toLowerCase()) : [];
      // GitHub's own total when nothing could be filtered; filtered, an exact count only when the compare returned
      // every commit (the unknown ones are in it).
      const count = !filter ? cmp.ahead_by : commits.length >= cmp.ahead_by ? kept.length : null;
      const dates = kept.map(commitAt).filter(Boolean).sort();
      const groups = await groupCommits(ctx, kept, p.part.branch);
      if (unknown.length) {
        const short = new Set(unknown.map((s) => s.slice(0, 7)));
        for (const g of groups) {
          const n = g.commits.filter((x) => short.has(x.sha.toLowerCase())).length;
          if (n) g.pathsUnknown = n;
        }
      }
      next[notShippedKey(p.part.env, p.app)] = {
        env: p.part.env, app: p.app, servingSha: p.sha, branch: p.part.branch, head: heads.get(p.part.branch) ?? null,
        count, oldestAt: count ? dates[0] ?? null : null, groups, computedAt: at,
        ...(unknown.length ? { unknown: unknown.slice(0, 250) } : {}),
      };
    } catch (e) {
      failure ??= e;
    }
  }
  const snap: NotShippedSnapshot = { parts: next };
  await putSnapshot(ctx, "not_shipped", snap, at);
  if (failure) throw failure;
}

// ── out of step ──────────────────────────────────────────────────────────────

/** Compute, per environment whose apps serve different commits, how far behind the newest each other one is,
 *  and merge it into `out_of_step`. */
export async function computeOutOfStep(ctx: TenantContext, opts: GhOpts, envs: RepoEnvConfig[], budget: FactsBudget, now: number = Date.now()): Promise<void> {
  if (!envs.length) return;
  const { parts } = await servingParts(ctx, opts.repo);
  const prev = (await getSnapshot<OutOfStepSnapshot>(ctx, "out_of_step"))?.data?.envs ?? {};
  const next: Record<string, OutOfStepEntry> = {};
  const at = new Date(now).toISOString();
  let failure: unknown = null;
  for (const env of envs) {
    const here = parts.filter((p) => p.part.env === env.key);
    const shas = Object.fromEntries(here.map((p) => [p.app, p.sha]));
    const old = prev[env.key];
    const unchanged = old && Object.keys(old.shas).length === here.length && here.every((p) => old.shas[p.app] !== undefined && sameSha(old.shas[p.app], p.sha));
    if (unchanged) { next[env.key] = old; continue; }
    // distinct commits, each with the apps serving it
    const distinct: { sha: string; apps: ServingPart[] }[] = [];
    for (const p of here) {
      const d = distinct.find((x) => sameSha(x.sha, p.sha));
      if (d) d.apps.push(p); else distinct.push({ sha: p.sha, apps: [p] });
    }
    if (distinct.length < 2) { next[env.key] = { shas, rows: [], computedAt: at }; continue; }
    const newest = [...here].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))[0];
    const ref = distinct.find((d) => d.apps.includes(newest))!;
    const others = distinct.filter((d) => d !== ref);
    if (budget.left < others.length) { if (old) next[env.key] = old; continue; } // the whole environment, or none of it
    const rows: FactsOutOfStep[] = [];
    try {
      for (const o of others) {
        budget.left--;
        const cmp = await compare(opts, o.sha, ref.sha);
        if (cmp.status === "behind") {
          // the newest deploy runs OLDER code (a rollback, a hotfix branch): the reference apps are the ones behind
          for (const a of ref.apps) rows.push({ env: env.key, app: a.app, sha: a.sha, of: o.apps[0].app, ofSha: o.sha, behindBy: cmp.behind_by });
        } else if (cmp.ahead_by > 0) {
          for (const a of o.apps) rows.push({ env: env.key, app: a.app, sha: a.sha, of: ref.apps[0].app, ofSha: ref.sha, behindBy: cmp.ahead_by });
        }
      }
      next[env.key] = { shas, rows, computedAt: at };
    } catch (e) {
      failure ??= e;
      if (old) next[env.key] = old;
    }
  }
  const snap: OutOfStepSnapshot = { envs: next };
  await putSnapshot(ctx, "out_of_step", snap, at);
  if (failure) throw failure;
}

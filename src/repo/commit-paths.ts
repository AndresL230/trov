// Which files a commit touched (`commit_paths`, 0073_commit_paths — Repo setups, Phase E). Three halves:
//
//   1. PURE derivations of one verified `push` delivery (`commitPathsFromPush`) and of the ONE compare that fills in
//      what the delivery cut short (`pushPathsFromCompare`). No DB, no clock, no network.
//   2. The writer, `writeCommitPaths` — called ONLY by the gate's commit-paths arm (`ingestCommitPaths`,
//      src/consumer.ts). INSERT OR IGNORE on (org, repo, sha, path): a redelivery writes nothing.
//   3. The read, `commitPathsFor` — D1 only, for the not-shipped arm and the App menu's narrowing
//      (src/repo/facts-compute.ts, src/repo/app-scope.ts).
//
// Precision — attribute only what is known:
//   - a commit whose own `added / modified / removed` arrived whole → `scope = 'commit'` rows: EXACTLY its files;
//   - a push that lists more commits than its payload holds (GitHub caps a push payload at 20 commits), or a commit
//     whose lists are cut short (`PATHS_PER_COMMIT_CAP`, or missing), is filled from ONE compare (before...after) —
//     whose `files` are the whole PUSH's, not any one commit's. They are stored under the push's head commit as
//     `scope = 'push'` (`'push_partial'` when the compare returned its own 300-file cap) and ONLY when that head
//     commit has no exact list of its own. A `push*` row is the push's: a filter never reads it as a commit's, so a
//     commit with no `commit` rows has UNKNOWN paths (`commitPathsFor` leaves it out).
import { type TenantContext, all, batch, stmt, fanOut } from "../data/sql";

/** GitHub's push payload holds at most this many commits; a push listing this many may have held more. */
export const PUSH_PAYLOAD_COMMIT_CAP = 20;
/** A commit listing this many files (its three lists together) is treated as cut short — its paths are not
 *  claimed as exact. 300 is the most GitHub's own file lists return in one go (a compare's `files`, a page of
 *  `/pulls/{n}/files` × 3); a commit that big is unusual enough that "unknown" costs nothing. UNVERIFIED: GitHub
 *  documents no per-commit cap for the push payload. */
export const PATHS_PER_COMMIT_CAP = 300;
/** A compare returns at most this many files. */
export const COMPARE_FILES_CAP = 300;
/** At most this many rows from ONE push (20 commits × their files, or one compare) — the write's own bound. */
export const PUSH_PATH_ROWS_CAP = 1000;
/** Kept this long (by the commit's own `at`): the widest window anything reads is the 14-day commit bars and the
 *  not-shipped compares (src/platform/sweeps.ts `pruneRepoCapture`). */
export const COMMIT_PATHS_RETENTION_DAYS = 100;

export type CommitPathScope = "commit" | "push" | "push_partial";
export interface CommitPathRow { sha: string; path: string; scope: CommitPathScope; at: string }

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v !== null && typeof v === "object" ? (v as Obj) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const SHA = /^[0-9a-f]{40}$/i;
const ZERO = /^0+$/;
/** A file path as stored: as GitHub lists it, without leading slashes, ≤ 400 characters (else not stored). */
const cleanPath = (v: unknown): string | null => {
  const s = str(v)?.replace(/^\/+/, "");
  return s && s.length <= 400 ? s : null;
};

export interface PushPaths {
  /** The branch the push landed on. */
  branch: string;
  before: string | null;
  after: string;
  /** When GitHub says the push happened (`repository.pushed_at`), else the head commit's timestamp. */
  at: string;
  /** Exact rows: each listed commit's own files. */
  rows: CommitPathRow[];
  /** Whether the head commit (`after`) has an exact list of its own. */
  headListed: boolean;
  /** Something was cut short (more commits than the payload holds, or a commit's lists) → ONE compare fills it,
   *  when `before` is a real commit (a new branch's push has none to compare from). */
  needsCompare: boolean;
}

/** One verified `push` delivery → the exact paths of every commit it lists whole, and whether a compare must fill
 *  in. null for a push that is not a branch push or carries no head. PURE. */
export function commitPathsFromPush(payload: unknown): PushPaths | null {
  const p = obj(payload);
  const ref = str(p?.ref);
  if (!p || !ref?.startsWith("refs/heads/") || p.deleted === true) return null;
  const after = str(p.after);
  if (!after || !SHA.test(after) || ZERO.test(after)) return null;
  const before = str(p.before);
  const commits = Array.isArray(p.commits) ? p.commits.map(obj).filter((c): c is Obj => c !== null) : [];
  const pushedAt = num(obj(p.repository)?.pushed_at);
  const head = obj(p.head_commit);
  const at = pushedAt !== null
    ? new Date(pushedAt * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")
    : str(head?.timestamp) ?? str(commits[commits.length - 1]?.timestamp);
  if (!at) return null;

  const rows: CommitPathRow[] = [];
  let cut = commits.length >= PUSH_PAYLOAD_COMMIT_CAP;
  let headListed = false;
  for (const c of commits) {
    const sha = str(c.id);
    if (!sha || !SHA.test(sha)) continue;
    const lists = [c.added, c.modified, c.removed];
    if (!lists.every(Array.isArray)) { cut = true; continue; }
    const files = [...new Set((lists as unknown[][]).flat().map(cleanPath).filter((f): f is string => f !== null))];
    if (files.length >= PATHS_PER_COMMIT_CAP) { cut = true; continue; }
    if (rows.length + files.length > PUSH_PATH_ROWS_CAP) { cut = true; continue; }
    const cAt = str(c.timestamp) ?? at;
    for (const path of files) rows.push({ sha: sha.toLowerCase(), path, scope: "commit", at: cAt });
    if (sha.toLowerCase() === after.toLowerCase()) headListed = true;
  }
  // A head commit the payload never listed (a force-push to an older commit lists none) is not "cut short": there
  // is nothing new to attribute, and the compare would describe a range the push did not add.
  const realBefore = before !== null && SHA.test(before) && !ZERO.test(before);
  return {
    branch: ref.slice("refs/heads/".length), before: realBefore ? before : null, after: after.toLowerCase(), at, rows, headListed,
    needsCompare: cut && realBefore,
  };
}

/** A compare's `files` (before...after) → the PUSH's rows, under its head commit — only when that head commit has
 *  no exact list (else nothing: a commit's exact rows are never mixed with a push's). `push_partial` when the
 *  compare returned its own file cap. PURE. */
export function pushPathsFromCompare(push: Pick<PushPaths, "after" | "at" | "headListed">, files: unknown): CommitPathRow[] {
  if (push.headListed || !Array.isArray(files)) return [];
  const names = [...new Set(files.map((f) => cleanPath(obj(f)?.filename)).filter((f): f is string => f !== null))].slice(0, PUSH_PATH_ROWS_CAP);
  const scope: CommitPathScope = files.length >= COMPARE_FILES_CAP ? "push_partial" : "push";
  return names.map((path) => ({ sha: push.after, path, scope, at: push.at }));
}

// ── the writer (the gate's commit-paths arm only) ────────────────────────────

/** Rows per INSERT: 6 bound values each, under D1's 100 bound parameters. */
const ROWS_PER_STATEMENT = 15;

/** INSERT OR IGNORE every row (one batch); returns how many were NEW. Called only by `ingestCommitPaths`. */
export async function writeCommitPaths(ctx: TenantContext, repo: string, rows: CommitPathRow[]): Promise<number> {
  if (!rows.length || !repo) return 0;
  const stmts = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_STATEMENT) {
    const chunk = rows.slice(i, i + ROWS_PER_STATEMENT);
    stmts.push(stmt(ctx,
      `INSERT OR IGNORE INTO commit_paths (org_id, repo, sha, path, scope, at) VALUES ${chunk.map(() => "(?, ?, ?, ?, ?, ?)").join(", ")}`,
      ...chunk.flatMap((r) => [ctx.orgId, repo, r.sha, r.path, r.scope, r.at])));
  }
  const res = await batch(ctx, stmts);
  return res.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
}

// ── the read ─────────────────────────────────────────────────────────────────

/** What is known of one commit's files. */
export interface KnownPaths {
  /** `commit` = exactly this commit's; `push` / `push_partial` = its push's (it was the push's head and had no
   *  list of its own — `push_partial`: the compare returned its file cap, so "touches none" is not known). */
  scope: CommitPathScope;
  paths: string[];
}

/** The known files of each commit (full 40-character shas, case-insensitive; anything else is unknown). A commit with `commit` rows reads
 *  them; with only `push*` rows, those — only when `pushRows` (the CI's head-commit attribution reads them, marked;
 *  the not-shipped filter and the commit counts never do). A commit with neither is absent: UNKNOWN. D1 only. */
export async function commitPathsFor(ctx: TenantContext, repo: string, shas: readonly string[], pushRows = false): Promise<Map<string, KnownPaths>> {
  const full = [...new Set(shas.filter((s) => SHA.test(s)).map((s) => s.toLowerCase()))];
  const out = new Map<string, KnownPaths>();
  if (!full.length || !repo) return out;
  const rows = await fanOut<{ sha: string; path: string; scope: CommitPathScope }>(ctx, full,
    (p) => `SELECT sha, path, scope FROM commit_paths WHERE org_id = ? AND repo = ? AND sha IN (${p})`, [ctx.orgId, repo]);
  for (const r of rows) {
    if (r.scope !== "commit" && !pushRows) continue;
    const k = out.get(r.sha);
    if (!k) out.set(r.sha, { scope: r.scope, paths: [r.path] });
    else if (k.scope === r.scope) k.paths.push(r.path);
    else if (r.scope === "commit") out.set(r.sha, { scope: "commit", paths: [r.path] }); // exact wins over a push's
  }
  return out;
}

/** Every exact commit row of a repository touched since `sinceIso` — what the 14-day commit bars and the week's
 *  counts read when a push row carries no commit list of its own. D1 only. */
export async function exactCommitsSince(ctx: TenantContext, repo: string, sinceIso: string): Promise<{ sha: string; path: string; at: string }[]> {
  if (!repo) return [];
  return all(ctx, `SELECT sha, path, at FROM commit_paths WHERE org_id = ? AND repo = ? AND scope = 'commit' AND at > ?`, ctx.orgId, repo, sinceIso);
}

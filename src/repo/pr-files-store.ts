// `pr_files` / `pr_file_reads` (0073_commit_paths — Repo setups, Phase E): the writer, called ONLY by the gate's
// PR-files arm (`ingestPrFiles`, src/consumer.ts), and the read (D1 only) the App menu's narrowing and the reconcile
// arm use. No GitHub here — the fetch is ./pr-files.ts.
import { type TenantContext, batch, first, stmt, fanOut, nowIso } from "../data/sql";

/** One PR's file list as the gate receives it. */
export interface PrFilesCapture {
  repo: string;
  number: number;
  /** The PR head the list was read for (`pull_request.head.sha`). */
  headSha: string | null;
  files: string[];
  /** False when the read stopped at its page cap (3 × 100): the list may be longer. */
  complete: boolean;
}

export interface PrFileReadRow { head_sha: string | null; complete: number; content_hash: string; fetched_at: string }

export async function prFileRead(ctx: TenantContext, repo: string, number: number): Promise<PrFileReadRow | null> {
  return first<PrFileReadRow>(ctx,
    `SELECT head_sha, complete, content_hash, fetched_at FROM pr_file_reads WHERE org_id = ? AND repo = ? AND number = ?`,
    ctx.orgId, repo, number);
}

/** Rows per INSERT: 4 bound values each, under D1's 100 bound parameters. */
const ROWS_PER_STATEMENT = 24;

/** Replace a PR's files and its read row in ONE batch (`files` changed). Called only by `ingestPrFiles`. */
export async function writePrFiles(ctx: TenantContext, c: PrFilesCapture, hash: string): Promise<void> {
  const at = nowIso();
  const stmts = [stmt(ctx, `DELETE FROM pr_files WHERE org_id = ? AND repo = ? AND number = ?`, ctx.orgId, c.repo, c.number)];
  for (let i = 0; i < c.files.length; i += ROWS_PER_STATEMENT) {
    const chunk = c.files.slice(i, i + ROWS_PER_STATEMENT);
    stmts.push(stmt(ctx, `INSERT OR IGNORE INTO pr_files (org_id, repo, number, path) VALUES ${chunk.map(() => "(?, ?, ?, ?)").join(", ")}`,
      ...chunk.flatMap((path) => [ctx.orgId, c.repo, c.number, path])));
  }
  stmts.push(readUpsert(ctx, c, hash, at));
  await batch(ctx, stmts);
}

/** The read row alone — the files are the same, only the head they were read for moved. */
export async function touchPrFileRead(ctx: TenantContext, c: PrFilesCapture, hash: string): Promise<void> {
  await batch(ctx, [readUpsert(ctx, c, hash, nowIso())]);
}

const readUpsert = (ctx: TenantContext, c: PrFilesCapture, hash: string, at: string) =>
  stmt(ctx, `INSERT INTO pr_file_reads (org_id, repo, number, head_sha, complete, content_hash, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (org_id, repo, number) DO UPDATE SET head_sha = excluded.head_sha, complete = excluded.complete,
      content_hash = excluded.content_hash, fetched_at = excluded.fetched_at`,
    ctx.orgId, c.repo, c.number, c.headSha, c.complete ? 1 : 0, hash, at);

/** What is known of each PR's files: absent = never read (UNKNOWN — never guessed into an app). */
export interface PrFiles { headSha: string | null; complete: boolean; paths: string[] }

/** The read and its files for each PR number. D1 only (two fan-outs). */
export async function prFilesFor(ctx: TenantContext, repo: string, numbers: readonly number[]): Promise<Map<number, PrFiles>> {
  const ids = [...new Set(numbers.filter((n) => Number.isInteger(n) && n > 0))];
  const out = new Map<number, PrFiles>();
  if (!ids.length || !repo) return out;
  const reads = await fanOut<{ number: number; head_sha: string | null; complete: number }>(ctx, ids,
    (p) => `SELECT number, head_sha, complete FROM pr_file_reads WHERE org_id = ? AND repo = ? AND number IN (${p})`, [ctx.orgId, repo]);
  for (const r of reads) out.set(r.number, { headSha: r.head_sha, complete: r.complete === 1, paths: [] });
  if (!out.size) return out;
  const files = await fanOut<{ number: number; path: string }>(ctx, [...out.keys()],
    (p) => `SELECT number, path FROM pr_files WHERE org_id = ? AND repo = ? AND number IN (${p})`, [ctx.orgId, repo]);
  for (const f of files) out.get(f.number)?.paths.push(f.path);
  return out;
}

/** Each PR's read head (no files) — what the reconcile arm compares a PR's current head against. */
export async function prReadHeads(ctx: TenantContext, repo: string, numbers: readonly number[]): Promise<Map<number, string | null>> {
  const ids = [...new Set(numbers.filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length || !repo) return new Map();
  const rows = await fanOut<{ number: number; head_sha: string | null }>(ctx, ids,
    (p) => `SELECT number, head_sha FROM pr_file_reads WHERE org_id = ? AND repo = ? AND number IN (${p})`, [ctx.orgId, repo]);
  return new Map(rows.map((r) => [r.number, r.head_sha]));
}

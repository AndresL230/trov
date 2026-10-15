// The `releases` table's writers (0074_releases) — called ONLY by the gate's release arm (`ingestRepoRelease`,
// src/consumer.ts), which decides by content hash whether anything changed. No GitHub, no clock beyond
// `captured_at`. The reads live in ./releases.ts.
import { type TenantContext, first, run, nowIso } from "../data/sql";

/** One release or tag as the gate receives it — what a `release` / `create` delivery or reconcile's
 *  `releases` arm says, already narrowed (src/repo/releases.ts derives it). */
export interface ReleaseCapture {
  /** `upsert` = a published release (or a re-read one); `tag` = a bare tag, written only where no release
   *  holds it; `remove` = a release deleted or turned back into a draft. */
  op: "upsert" | "tag" | "remove";
  repo: string;
  tag: string;
  name?: string | null;
  /** GitHub's own instant. Required for `upsert` / `tag`. */
  publishedAt?: string;
  /** A GitHub login. */
  author?: string | null;
  notes?: string | null;
  prerelease?: boolean;
  sha?: string | null;
  provenance: "webhook" | "backfill";
}

export interface ReleaseRow {
  tag: string; name: string | null; published_at: string; author: string | null; notes: string | null;
  is_prerelease: number; is_draft: number; sha: string | null; source: "release" | "tag"; content_hash: string;
}

/** A release body is kept to this many characters; the read shortens it further. */
export const RELEASE_NOTES_MAX = 4000;

export async function releaseRow(ctx: TenantContext, repo: string, tag: string): Promise<ReleaseRow | null> {
  return first<ReleaseRow>(ctx,
    `SELECT tag, name, published_at, author, notes, is_prerelease, is_draft, sha, source, content_hash
       FROM releases WHERE org_id = ? AND repo = ? AND tag = ?`, ctx.orgId, repo, tag);
}

export interface ReleaseWrite {
  repo: string; tag: string; name: string | null; publishedAt: string; author: string | null; notes: string | null;
  prerelease: boolean; sha: string | null; source: "release" | "tag"; hash: string;
}

/** The computed write: the row as the gate settled it (a tag row upgraded to a release keeps its sha). */
export async function writeRelease(ctx: TenantContext, w: ReleaseWrite): Promise<void> {
  await run(ctx,
    `INSERT INTO releases (org_id, repo, tag, name, published_at, author, notes, is_prerelease, is_draft, sha, source, content_hash, captured_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
     ON CONFLICT(org_id, repo, tag) DO UPDATE SET name = excluded.name, published_at = excluded.published_at,
       author = excluded.author, notes = excluded.notes, is_prerelease = excluded.is_prerelease, is_draft = 0,
       sha = excluded.sha, source = excluded.source, content_hash = excluded.content_hash, captured_at = excluded.captured_at`,
    ctx.orgId, w.repo, w.tag, w.name, w.publishedAt, w.author, w.notes, w.prerelease ? 1 : 0, w.sha, w.source, w.hash, nowIso());
}

/** A release that is no more (deleted, or unpublished back to a draft). A bare tag row is not touched. */
export async function removeRelease(ctx: TenantContext, repo: string, tag: string): Promise<boolean> {
  const res = await run(ctx, `DELETE FROM releases WHERE org_id = ? AND repo = ? AND tag = ? AND source = 'release'`, ctx.orgId, repo, tag);
  return (res.meta.changes ?? 0) > 0;
}

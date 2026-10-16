// Ask Trov's PENDING attachments past their day (0068_ask_pending; the owner's ruling Q60, docs/architecture/ask.md ›
// Attachments). A file uploaded before its conversation existed waits, unsent, on the person's hidden holder thread
// (`chat_threads.pending = 1`); sending the question moves it onto the real thread. What is never sent goes 24 hours
// after it was uploaded — through the SAME hard delete as the composer's ✕ (`deleteUnsentAttachment`: its page's rows
// and its link in one batch, the R2 bytes after the commit when nothing else holds them). One the person published
// from the library meanwhile, or that a ticket or a doc now refers to, keeps its artifact: only the pending link goes,
// as a thread deletion keeps such a file. A holder with nothing left on it goes too.
//
// Run on the hourly digest trigger (src/index.ts `scheduled()`, `0 * * * *`) — no cron of its own.
import { type PlatformContext, all } from "../data/platform-sql";
import { systemTenant } from "../data/context";
import { run } from "../data/sql";
import { deleteUnsentAttachment } from "./ask";

/** How long an unsent upload with no conversation is kept. */
export const ASK_PENDING_TTL_MS = 24 * 3_600_000;
/** At most this many links per run (each is a few statements); the rest wait for the next hour. */
const SWEEP_MAX = 100;

/** The sweep's unit list: pending links past the TTL, with their org and person — ids and a handle only. */
function staleHolders(p: PlatformContext, cutoff: string) {
  return all<{ org_id: string; handle: string; link: number }>(p,
    `SELECT ca.org_id, t.handle, ca.id AS link
       FROM chat_artifacts ca JOIN chat_threads t ON t.id = ca.thread_id AND t.org_id = ca.org_id AND t.pending = 1
      WHERE ca.role = 'attachment' AND ca.message_id IS NULL AND ca.created_at < ?
      ORDER BY ca.id LIMIT ?`, cutoff, SWEEP_MAX);
}

/** The empty holders older than the TTL: (org, holder id). */
function emptyHolders(p: PlatformContext, cutoff: string) {
  return all<{ org_id: string; id: number }>(p,
    `SELECT t.org_id, t.id FROM chat_threads t
      WHERE t.pending = 1 AND t.created_at < ?
        AND NOT EXISTS (SELECT 1 FROM chat_artifacts ca WHERE ca.org_id = t.org_id AND ca.thread_id = t.id)
      LIMIT ?`, cutoff, SWEEP_MAX);
}

export interface PendingSweep { deleted: number; unlinked: number; holders: number }

export async function sweepPendingAskAttachments(p: PlatformContext, bucket: R2Bucket | undefined, now: number): Promise<PendingSweep> {
  const cutoff = new Date(now - ASK_PENDING_TTL_MS).toISOString();
  const out: PendingSweep = { deleted: 0, unlinked: 0, holders: 0 };
  for (const u of await staleHolders(p, cutoff)) {
    const ctx = systemTenant(p, u.org_id, "system");
    try {
      const r = await deleteUnsentAttachment(ctx, p, bucket, u.handle, u.link);
      if (r.ok) { out.deleted++; continue; }
      // Published, referenced or no longer the person's own: the artifact stays; the pending link goes.
      await run(ctx, `DELETE FROM chat_artifacts WHERE id = ? AND org_id = ? AND message_id IS NULL`, u.link, ctx.orgId);
      out.unlinked++;
    } catch (e) {
      console.error("ask pending sweep", e instanceof Error ? e.name : "error");
    }
  }
  for (const h of await emptyHolders(p, cutoff)) {
    const ctx = systemTenant(p, h.org_id, "system");
    const res = await run(ctx, `DELETE FROM chat_threads WHERE id = ? AND org_id = ? AND pending = 1
        AND NOT EXISTS (SELECT 1 FROM chat_artifacts ca WHERE ca.org_id = ? AND ca.thread_id = chat_threads.id)`, h.id, ctx.orgId, ctx.orgId)
      .catch((e) => { console.error("ask pending holder", e instanceof Error ? e.name : "error"); return null; });
    out.holders += res?.meta.changes ?? 0;
  }
  return out;
}

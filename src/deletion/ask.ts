// Ask Trov's attachments when what holds them goes (docs/architecture/ask.md › Deleting a thread or an account;
// organizations.md › What deletion removes and what it keeps). The owner's ruling (2026-10-15, legal #4):
//   • deleting a THREAD deletes its attachments, EXCEPT a file still referenced by a ticket or a doc;
//   • deleting an ACCOUNT deletes the person's PRIVATE Ask attachments (that half lives in ./person.ts,
//     `ASK_ATTACHMENTS_OF`, inside the account's own batch).
// An attachment is a private artifact the person's upload created (src/ai/ask/attachments.ts), linked to its thread
// by a `chat_artifacts` row with role `attachment`. A saved answer (role `saved`) is something the person chose to put
// in the library: no deletion here touches it.
//
// These are HARD deletes — with the account's, the only artifacts hard-deleted outside an organization's deletion
// (CLAUDE.md invariant 11): every version, link, upload token and search row of the page goes in ONE batch with the
// thread's own rows, and the R2 bytes are freed AFTER the commit, only when no row anywhere still points at the same
// sha (./r2.ts — the objects are content-addressed and shared).
//
// What a thread deletion keeps (`planThreadAttachments`), and why:
//   • `published` — the person moved it out of private (visibility `org`): it is the org's library item now, which
//     others may use, and the ruling covers private attachments. It stays, as every artifact of theirs does.
//   • `ticket` — a ticket points at it: an `artifact_links` row to a ticket (the schema's link — the library's
//     Links, MCP, record_session), or the artifact's address in a ticket's body, a comment, or the ticket's links.
//   • `doc` — a doc points at it: its address in a doc's body or in any version of it (a staged proposal may still be
//     promoted; a rejected one is restorable). Docs have no link table: an address is the only way a doc refers to an
//     artifact. (A doc IMAGE is its own copy — `doc-images/<sha>` in `doc_images` — and never depends on this object.)
//   • `shared` — another thread links the same artifact (not made by Ask today; checked, not assumed), or someone else
//     authored it: a person the thread was shared with to continue attached it (0077_ask_people_sharing). It is
//     their private artifact and stays theirs, in their Artifacts.
// "The artifact's address" is `artifacts/<slug>` (the app's `#artifacts/<slug>`, the API's `/api/artifacts/<slug>`),
// `raw/a/<slug>` (its bytes), or an Ask ref token `[[artifact:<slug>`, followed by anything that cannot continue a
// slug — matched with GLOB, so `<slug>-2` never keeps `<slug>`.
import { type TenantContext, type Stmt, all, batch, first, stmt, chunked, ph } from "../data/sql";
import type { PlatformContext } from "../data/context";
import { deleteThread } from "../data/ask";
import { artifactShas, noCandidates, sweepR2, type R2Sweep } from "./r2";

export type KeptWhy = "published" | "ticket" | "doc" | "shared";
export interface ThreadAttachmentPlan {
  /** Artifact page ids that go with the thread. */
  going: number[];
  kept: { id: number; slug: string; why: KeptWhy }[];
  /** The R2 keys (`artifacts/<sha>`) of every version of what goes: freed after the commit when nothing else holds them. */
  r2Keys: string[];
}

/** The five GLOB patterns that find `slug`'s address in a text column (binds ?2–?6 of `REFERENCE_SQL`). */
export function addressGlobs(slug: string): string[] {
  const end = "[^a-z0-9-]*";
  return [`*artifacts/${slug}${end}`, `*artifacts/${slug}`, `*raw/a/${slug}${end}`, `*raw/a/${slug}`, `*[[][[]artifact:${slug}${end}`];
}
const hit = (col: string): string => `(${col} GLOB ?2 OR ${col} GLOB ?3 OR ${col} GLOB ?4 OR ${col} GLOB ?5 OR ${col} GLOB ?6)`;

/** Does a ticket or a doc of this org refer to the page? Binds: ?1 org, ?2–?6 `addressGlobs(slug)`, ?7 page id. */
const REFERENCE_SQL = `SELECT
    (EXISTS (SELECT 1 FROM artifact_links WHERE org_id = ?1 AND page_id = ?7 AND target_type = 'ticket')
     OR EXISTS (SELECT 1 FROM tickets WHERE org_id = ?1 AND ${hit("body")})
     OR EXISTS (SELECT 1 FROM ticket_comments WHERE org_id = ?1 AND ${hit("body")})
     OR EXISTS (SELECT 1 FROM ticket_links WHERE org_id = ?1 AND ${hit("url")})) AS ticket,
    (EXISTS (SELECT 1 FROM docs WHERE org_id = ?1 AND ${hit("body")})
     OR EXISTS (SELECT 1 FROM doc_versions WHERE org_id = ?1 AND ${hit("body")})) AS doc`;

/** Which of the thread's attachments go with it, which stay and why (see the header). */
export async function planThreadAttachments(ctx: TenantContext, handle: string, threadId: number): Promise<ThreadAttachmentPlan> {
  const rows = await all<{ id: number; slug: string; visibility: string; author_id: string; elsewhere: number }>(ctx,
    `SELECT p.id, p.slug, p.visibility, p.author_id,
            EXISTS (SELECT 1 FROM chat_artifacts o WHERE o.org_id = p.org_id AND o.artifact_id = p.id AND o.thread_id <> ca.thread_id) AS elsewhere
       FROM chat_artifacts ca JOIN artifact_pages p ON p.id = ca.artifact_id AND p.org_id = ca.org_id
      WHERE ca.org_id = ? AND ca.thread_id = ? AND ca.role = 'attachment'
      ORDER BY p.id`, ctx.orgId, threadId);
  const plan: ThreadAttachmentPlan = { going: [], kept: [], r2Keys: [] };
  for (const r of rows) {
    // Only the person's own private upload is theirs to take with the thread.
    if (r.visibility !== "private") { plan.kept.push({ id: r.id, slug: r.slug, why: "published" }); continue; }
    if (r.elsewhere || r.author_id.toLowerCase() !== handle.toLowerCase()) { plan.kept.push({ id: r.id, slug: r.slug, why: "shared" }); continue; }
    const ref = await first<{ ticket: number; doc: number }>(ctx, REFERENCE_SQL, ctx.orgId, ...addressGlobs(r.slug), r.id);
    if (ref?.ticket) plan.kept.push({ id: r.id, slug: r.slug, why: "ticket" });
    else if (ref?.doc) plan.kept.push({ id: r.id, slug: r.slug, why: "doc" });
    else plan.going.push(r.id);
  }
  for (const ids of chunked(plan.going)) {
    const keys = await all<{ r2_key: string | null }>(ctx, `SELECT r2_key FROM artifact_versions WHERE org_id = ? AND page_id IN (${ph(ids.length)})`, ctx.orgId, ...ids);
    plan.r2Keys.push(...keys.map((k) => k.r2_key).filter((k): k is string => !!k));
  }
  return plan;
}

/** The statements that hard-delete these pages (still private, still the person's) with everything that hangs off
 *  them. Part of the thread's own batch. */
export function attachmentDeletes(ctx: TenantContext, handle: string, ids: readonly number[], guard: { sql: string; binds: unknown[] } | null = null): Stmt[] {
  return chunked(ids).flatMap((chunk) => {
    // Re-checked inside the batch: a page published since the plan was read stays whole (and `guard`, a caller's own
    // condition on `artifact_pages`, likewise).
    const mine = `SELECT id FROM artifact_pages WHERE org_id = ? AND visibility = 'private' AND author_id = ? COLLATE NOCASE AND id IN (${ph(chunk.length)})${guard ? ` ${guard.sql}` : ""}`;
    const binds = [ctx.orgId, handle, ...chunk, ...(guard?.binds ?? [])];
    return [
      stmt(ctx, `DELETE FROM artifact_upload_tokens WHERE org_id = ? AND page_id IN (${mine})`, ctx.orgId, ...binds),
      stmt(ctx, `DELETE FROM artifact_links WHERE org_id = ? AND page_id IN (${mine})`, ctx.orgId, ...binds),
      stmt(ctx, `DELETE FROM artifact_versions WHERE org_id = ? AND page_id IN (${mine})`, ctx.orgId, ...binds),
      stmt(ctx, `DELETE FROM artifacts_fts WHERE org_id = ? AND CAST(page_id AS INTEGER) IN (${mine})`, ctx.orgId, ...binds),
      stmt(ctx, `DELETE FROM artifact_pages WHERE org_id = ? AND id IN (${mine})`, ctx.orgId, ...binds),
    ];
  });
}

export interface DeletedThread { attachments: { deleted: number; kept: ThreadAttachmentPlan["kept"] }; r2: R2Sweep }

/**
 * Delete one of `handle`'s threads (`DELETE /ask/threads/:id`): the thread's rows and the attachments that go with it
 * in ONE batch, then their R2 bytes when nothing else holds them. Null when there is no such thread of theirs.
 */
export async function deleteAskThread(ctx: TenantContext, p: PlatformContext, bucket: R2Bucket | undefined, handle: string, threadId: number): Promise<DeletedThread | null> {
  const plan = await planThreadAttachments(ctx, handle, threadId);
  if (!(await deleteThread(ctx, handle, threadId, attachmentDeletes(ctx, handle, plan.going)))) return null;
  const r2 = await sweepR2(p, bucket, { ...noCandidates(), artifacts: artifactShas(plan.r2Keys) });
  return { attachments: { deleted: plan.going.length, kept: plan.kept }, r2 };
}

export type UnsentRefusal = "not_found" | "sent" | "published" | "referenced";
export type DeletedAttachment = { ok: true; r2: R2Sweep } | { ok: false; why: UnsentRefusal };

/**
 * Delete ONE of `handle`'s attachments that was never sent (`DELETE /ask/attachments/:id`, the composer removing an
 * uploaded chip) — the owner's ruling for a thread's attachments, applied to one: the same statements as a thread's
 * (`attachmentDeletes`) and its `chat_artifacts` link, in ONE batch, then the R2 bytes when nothing else holds them.
 * The uploader's own (its artifact's author) — in their thread, or one shared with them to continue (0077).
 * Refused, with nothing deleted: another person's / an unknown id (`not_found`), one already sent with a question
 * (`sent`), one moved out of private (`published`), one a ticket or a doc refers to (`referenced`).
 */
export async function deleteUnsentAttachment(ctx: TenantContext, p: PlatformContext, bucket: R2Bucket | undefined, handle: string, attachmentId: number): Promise<DeletedAttachment> {
  const row = await first<{ link: number; message_id: number | null; page: number; slug: string; visibility: string; author_id: string; elsewhere: number }>(ctx,
    `SELECT ca.id AS link, ca.message_id, pg.id AS page, pg.slug, pg.visibility, pg.author_id,
            EXISTS (SELECT 1 FROM chat_artifacts o WHERE o.org_id = ca.org_id AND o.artifact_id = ca.artifact_id AND o.id <> ca.id) AS elsewhere
       FROM chat_artifacts ca
       JOIN artifact_pages pg ON pg.id = ca.artifact_id AND pg.org_id = ca.org_id
      WHERE ca.org_id = ? AND ca.id = ? AND ca.role = 'attachment'`, ctx.orgId, attachmentId);
  if (!row || row.author_id.toLowerCase() !== handle.toLowerCase()) return { ok: false, why: "not_found" };
  if (row.message_id !== null) return { ok: false, why: "sent" };
  if (row.visibility !== "private") return { ok: false, why: "published" };
  const ref = await first<{ ticket: number; doc: number }>(ctx, REFERENCE_SQL, ctx.orgId, ...addressGlobs(row.slug), row.page);
  if (ref?.ticket || ref?.doc || row.elsewhere) return { ok: false, why: "referenced" };
  const keys = await all<{ r2_key: string | null }>(ctx, `SELECT r2_key FROM artifact_versions WHERE org_id = ? AND page_id = ?`, ctx.orgId, row.page);
  await batch(ctx, [
    // Re-checked inside the batch: an attachment sent meanwhile keeps everything (its page, then its link).
    ...attachmentDeletes(ctx, handle, [row.page], {
      sql: `AND NOT EXISTS (SELECT 1 FROM chat_artifacts s WHERE s.org_id = artifact_pages.org_id AND s.artifact_id = artifact_pages.id AND s.message_id IS NOT NULL)`, binds: [],
    }),
    stmt(ctx, `DELETE FROM chat_artifacts WHERE id = ? AND org_id = ? AND message_id IS NULL`, row.link, ctx.orgId),
  ]);
  const r2 = await sweepR2(p, bucket, { ...noCandidates(), artifacts: artifactShas(keys.map((k) => k.r2_key).filter((k): k is string => !!k)) });
  return { ok: true, r2 };
}

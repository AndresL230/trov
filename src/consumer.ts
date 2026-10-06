import type { IngestPayload, FeedEntry, DocProposal, AdrDraft, CapturedEvent } from "@shared/contract";
// NOTE: CapturedEvent is imported for ingestEvent's signature only — the webhook
// (src/webhook.ts) calls ingestEvent directly. There is no `events` arm on
// IngestPayload: subject_login is trustworthy only once the webhook has verified
// the delivery's HMAC, so no bearer/cookie payload may route events through here.
import { isSection, isTag } from "@shared/vocabulary";
import type { DocRow, DocVersionRow, AdrRow, ProcessedItemRow } from "@shared/rows";
import { type TenantContext, first, run, nowIso } from "./data/sql";
import type { PlatformContext } from "./data/platform-sql";
import { legacyDb } from "./data/legacy";
import { append_feed, propose_doc_update, stage_adr, route_triage, ensure_identity_task } from "./tools/writes";
import { contentHash } from "./hash";
import { changeKind } from "./diff";
import type { Principal } from "./auth/principal";
import type { RepoEvent } from "./repo/types";
import { applyArtifactLinks, type ArtifactLinkOutcome } from "./tools/artifacts-agent";
import { docImageProblems } from "./tools/doc-images";
import { legacyCtxOf } from "./data/legacy-ctx";

// Per-type, per-outcome counts surfaced on /ingest so a re-run reads, e.g.,
// "3 docs: 1 staged, 2 unchanged".
export interface IngestResult {
  feed: { written: number; unchanged: number; triaged: number };
  docs: { staged: number; unchanged: number; triaged: number };
  adrs: { staged: number; unchanged: number; triaged: number };
  triage: { recorded: number; unchanged: number };
  /** Doc proposals the gate REFUSED (a dangling or external image), each with why.
   *  Present only when non-empty, so a batch with no images reads exactly as before. */
  refused?: { slug: string; reason: string }[];
}

// The replay key for one item. The worker assigns item_index by stable
// enumeration across the payload's typed arrays, so the SAME payload always maps
// an item to the SAME (sessionId, itemIndex).
export interface LedgerRef {
  sessionId: string;
  itemIndex: number;
}

// The gate's verdict for a single entry. "unchanged" is the reconciler's no-op
// drop (a content-hash dedupe hit or a ledger replay) — nothing was written.
export type FeedIngestResult =
  | { outcome: "written"; id: number }
  | { outcome: "unchanged" }
  | { outcome: "triaged"; reason: string };
export type DocIngestResult =
  | { outcome: "written"; slug: string; version: number; status: "staged"; change_kind: "new" | "edit" | "rewrite"; base_version: number | null; low_confidence: boolean }
  | { outcome: "unchanged"; slug?: string }
  | { outcome: "triaged"; reason: string }
  // Refused outright: nothing staged, nothing triaged (a person cannot repair a missing
  // upload), and NOT ledgered — once the image is uploaded, the same payload re-POSTed
  // (same session id + index) stages instead of replaying as "unchanged".
  | { outcome: "refused"; slug: string; reason: string };
export type AdrIngestResult =
  | { outcome: "written"; id: number }
  | { outcome: "unchanged"; id?: number }
  | { outcome: "triaged"; reason: string };
export type EventIngestResult = { outcome: "written"; id: number } | { outcome: "unchanged" };

// ---------------------------------------------------------------------------
// The replay ledger. ledger-first per item: a (sessionId, itemIndex) already in
// processed_items means the worker has handled this exact item before (a re-POST
// of the same payload), so it is DROPPED — nothing new is written.
// ---------------------------------------------------------------------------
async function ledgerLookup(ctx: TenantContext, ledger: LedgerRef): Promise<ProcessedItemRow | null> {
  return first<ProcessedItemRow>(
    ctx,
    `SELECT * FROM processed_items WHERE org_id = ? AND session_id = ? AND item_index = ?`,
    ctx.orgId,
    ledger.sessionId,
    ledger.itemIndex
  );
}

async function ledgerRecord(
  ctx: TenantContext,
  ledger: LedgerRef,
  item_type: ProcessedItemRow["item_type"],
  outcome: string,
  ref: string | null
): Promise<void> {
  // INSERT OR IGNORE: the PK guards against a double-record under a race.
  await run(
    ctx,
    `INSERT OR IGNORE INTO processed_items (org_id, session_id, item_index, item_type, outcome, ref, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ctx.orgId,
    ledger.sessionId,
    ledger.itemIndex,
    item_type,
    outcome,
    ref,
    nowIso()
  );
}

// ---------------------------------------------------------------------------
// The gate. ONE place per entry-type decides ledger/vocab/confidence/dedupe →
// write-or-stage-or-triage-or-drop. Every write path (the /ingest consumer below
// AND the MCP write tools) funnels through these, so the invariant holds
// identically regardless of entry point. The author is always the authenticated
// principal, passed in by the caller. A `ledger` makes the entry replay-safe.
// ---------------------------------------------------------------------------

/** Feed: append-only. Out-of-vocab tag → triage; the ledger is the only replay guard
 *  (content repeats are legal, which is exactly why feed needs the ledger). */
export async function ingestFeedEntry(ctx: TenantContext, entry: FeedEntry, author: string, ledger?: LedgerRef): Promise<FeedIngestResult> {
  if (ledger && (await ledgerLookup(ctx,ledger))) return { outcome: "unchanged" };

  const unknown = entry.tags.filter((t) => !isTag(t));
  if (unknown.length > 0) {
    const reason = `unknown tag: ${unknown.join(", ")}`;
    await route_triage(ctx,{ raw: entry, reason, source_author: author });
    if (ledger) await ledgerRecord(ctx,ledger, "feed", "triaged", null);
    return { outcome: "triaged", reason };
  }
  const id = await append_feed(ctx,{
    author,
    summary: entry.summary,
    brief: entry.brief,
    body: entry.body,
    artifacts: entry.artifacts,
    tags: entry.tags,
  });
  if (ledger) await ledgerRecord(ctx,ledger, "feed", "written", String(id));
  return { outcome: "written", id };
}

/** Docs: reconcile against the KB. Out-of-vocab section or low-confidence-new → triage;
 *  low-confidence-existing → stage-and-flag; unchanged body → drop; else stage a typed delta. */
export async function ingestDocProposal(ctx: TenantContext, proposal: DocProposal, author: string, ledger?: LedgerRef): Promise<DocIngestResult> {
  if (ledger && (await ledgerLookup(ctx,ledger))) return { outcome: "unchanged" };

  // Images: every one must be an uploaded doc image (/img/<sha256>) — checked first,
  // since neither staging nor triage can fix a missing upload.
  const imageProblem = await docImageProblems(ctx, proposal.body);
  if (imageProblem) return { outcome: "refused", slug: proposal.slug, reason: imageProblem };

  if (!isSection(proposal.section)) {
    const reason = `out-of-vocab section: ${proposal.section}`;
    await route_triage(ctx,{ raw: proposal, reason, source_author: author });
    if (ledger) await ledgerRecord(ctx,ledger, "doc", "triaged", null);
    return { outcome: "triaged", reason };
  }

  const existing = await first<DocRow>(ctx, `SELECT * FROM docs WHERE org_id = ? AND slug = ?`, ctx.orgId, proposal.slug);
  const lowConf = proposal.confidence === "low";

  // Low confidence: a NEW slug is too uncertain to even create — triage. An
  // EXISTING slug stages but is flagged for human scrutiny.
  if (lowConf && !existing) {
    const reason = "low confidence doc proposal";
    await route_triage(ctx,{ raw: proposal, reason, source_author: author });
    if (ledger) await ledgerRecord(ctx,ledger, "doc", "triaged", null);
    return { outcome: "triaged", reason };
  }

  const hash = await contentHash(proposal.body);

  // No-op dedupe (existing slug): identical to the promoted body OR the latest
  // staged body means there is nothing new to stage — drop, unless `force`.
  if (existing) {
    const promotedBody = existing.current_version > 0 ? existing.body : null;
    const promotedHash = promotedBody !== null ? await contentHash(promotedBody) : null;
    const latestStaged = await first<DocVersionRow>(
      ctx,
      `SELECT * FROM doc_versions WHERE org_id = ? AND slug = ? AND status = 'staged' ORDER BY version DESC LIMIT 1`,
      ctx.orgId,
      proposal.slug
    );
    const latestStagedHash = latestStaged ? (latestStaged.content_hash ?? (await contentHash(latestStaged.body))) : null;
    if (!proposal.force && (hash === promotedHash || hash === latestStagedHash)) {
      if (ledger) await ledgerRecord(ctx,ledger, "doc", "unchanged", proposal.slug);
      return { outcome: "unchanged", slug: proposal.slug };
    }
  }

  // change_kind: `new` when there is no promoted body to diff against; else a
  // line diff vs the current promoted body — changed/max(old,new) < 0.5 → edit.
  let change_kind: "new" | "edit" | "rewrite";
  let base_version: number | null;
  if (!existing || existing.current_version === 0) {
    change_kind = "new";
    base_version = existing ? (proposal.base_version ?? existing.current_version) : (proposal.base_version ?? null);
  } else {
    change_kind = changeKind(existing.body, proposal.body);
    base_version = proposal.base_version ?? existing.current_version;
  }

  const res = await propose_doc_update(
    ctx,
    {
      slug: proposal.slug,
      section: proposal.section,
      title: proposal.title,
      body: proposal.body,
      change_summary: proposal.change_summary,
      confidence: proposal.confidence,
      space: proposal.space ?? "technical",
      content_hash: hash,
      base_version,
      change_kind,
      low_confidence: lowConf, // true only for low-confidence on an EXISTING slug (new+low triaged above)
    },
    author
  );
  if (ledger) await ledgerRecord(ctx,ledger, "doc", "staged", `${res.slug}@${res.version}`);
  return { outcome: "written", ...res, change_kind, base_version, low_confidence: lowConf };
}

/** ADRs: low confidence → triage; content-hash dedupe on title+context+decision+rationale →
 *  identical exists → drop; else stage a 'draft' carrying its content_hash. */
export async function ingestAdrDraft(ctx: TenantContext, draft: AdrDraft, author: string, ledger?: LedgerRef): Promise<AdrIngestResult> {
  if (ledger && (await ledgerLookup(ctx,ledger))) return { outcome: "unchanged" };

  if (draft.confidence === "low") {
    const reason = "low confidence adr draft";
    await route_triage(ctx,{ raw: draft, reason, source_author: author });
    if (ledger) await ledgerRecord(ctx,ledger, "adr", "triaged", null);
    return { outcome: "triaged", reason };
  }

  // NUL separator — it cannot appear in the joined fields, preventing boundary
  // collisions (["ab","c"] vs ["a","bc"]). Written as an escape sequence so the
  // file isn't treated as binary by grep. Stored `adrs.content_hash` values were
  // computed with this separator — do not change it.
  const hash = await contentHash([draft.title, draft.context, draft.decision, draft.rationale].join("\u0000"));
  const dup = await first<AdrRow>(ctx, `SELECT * FROM adrs WHERE org_id = ? AND content_hash = ? AND status != 'rejected' LIMIT 1`, ctx.orgId, hash);
  if (dup) {
    if (ledger) await ledgerRecord(ctx,ledger, "adr", "unchanged", String(dup.id));
    return { outcome: "unchanged", id: dup.id };
  }

  const id = await stage_adr(ctx,draft, author, hash);
  if (ledger) await ledgerRecord(ctx,ledger, "adr", "staged", String(id));
  return { outcome: "written", id };
}

/** Captured events: dedupe is the UNIQUE semantic_key (INSERT OR IGNORE) — a
 *  redelivery or backfill overlap drops as unchanged. No vocab/confidence checks:
 *  the event is external fact, captured verbatim. The writer is the authenticated
 *  principal; subject_login is the event's own identity (trusted post-HMAC). */
export async function ingestEvent(ctx: TenantContext, p: PlatformContext, event: CapturedEvent, recordedBy: string, ledger?: LedgerRef): Promise<EventIngestResult> {
  if (ledger && (await ledgerLookup(ctx, ledger))) return { outcome: "unchanged" };
  const res = await run(
    ctx,
    `INSERT OR IGNORE INTO events (org_id, semantic_key, event_type, ref_number, subject_login, raw, provenance, occurred_at, recorded_at, recorded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ctx.orgId, event.semantic_key, event.event_type, event.ref_number, event.subject_login,
    event.raw, event.provenance, event.occurred_at ?? null, nowIso(), recordedBy
  );
  const written = (res.meta.changes ?? 0) > 0;
  // Identity intake AFTER the event write: an unmapped subject_login raises one
  // pending identity task (login PK, INSERT OR IGNORE). Runs on unchanged
  // deliveries too, so events captured before the task store existed still
  // surface on their next redelivery/backfill overlap. The event above has
  // already landed either way — capture never depends on this.
  await ensure_identity_task(ctx, p, event.subject_login);
  if (ledger) await ledgerRecord(ctx,ledger, "event", written ? "written" : "unchanged", event.semantic_key);
  return written ? { outcome: "written", id: res.meta.last_row_id as number } : { outcome: "unchanged" };
}

/**
 * THE GATE for repo-dashboard capture (kinds: push / pr / review / deploy / check
 * / run). Same reconciliation as ingestEvent — a UNIQUE `semantic_key` written
 * INSERT OR IGNORE, so a redelivery or a backfill overlap drops as `unchanged` —
 * and deliberately NOTHING else: no identity intake (most actors here are bots or
 * CI) and no summaries. Reached only from the HMAC-verified webhook and the
 * admin backfill.
 */
export async function ingestRepoEvent(ctx: TenantContext, ev: RepoEvent): Promise<{ outcome: "written" | "unchanged" }> {
  const res = await run(
    ctx,
    `INSERT OR IGNORE INTO repo_events
       (org_id, semantic_key, kind, ref, sha, number, env, part, state, name, actor_login, title, url, count, raw, provenance, occurred_at, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ctx.orgId, ev.semantic_key, ev.kind, ev.ref ?? null, ev.sha ?? null, ev.number ?? null, ev.env ?? null, ev.part ?? null,
    ev.state ?? null, ev.name ?? null, ev.actor_login ?? null, ev.title ?? null, ev.url ?? null, ev.count ?? null,
    ev.raw, ev.provenance, ev.occurred_at, nowIso()
  );
  return { outcome: (res.meta.changes ?? 0) > 0 ? "written" : "unchanged" };
}

/**
 * Validate-and-reconcile the (already structurally-validated) /ingest payload.
 * The Worker verifies structure; the gate functions above verify vocabulary,
 * confidence, content-hash identity, and the replay ledger. item_index is
 * assigned by stable enumeration across the typed arrays — feed, docs, adrs,
 * THEN needs_triage — so a re-POST of the same payload replays to all-`unchanged`
 * and existing indices never shift. There is no events arm here: captured events
 * only ever reach the gate via the HMAC-verified webhook calling ingestEvent
 * directly (src/webhook.ts), never through this bearer/cookie-authenticated path.
 */
export async function consume(ctx: TenantContext, payload: IngestPayload, principal: Principal): Promise<IngestResult> {
  const author = principal.handle; // authenticated principal; payload.session.author is advisory and ignored
  const sessionId = payload.session.id;
  const result: IngestResult = {
    feed: { written: 0, unchanged: 0, triaged: 0 },
    docs: { staged: 0, unchanged: 0, triaged: 0 },
    adrs: { staged: 0, unchanged: 0, triaged: 0 },
    triage: { recorded: 0, unchanged: 0 },
  };
  let idx = 0;

  for (const entry of payload.feed_entries) {
    const r = await ingestFeedEntry(ctx,entry, author, { sessionId, itemIndex: idx++ });
    if (r.outcome === "written") result.feed.written++;
    else if (r.outcome === "unchanged") result.feed.unchanged++;
    else result.feed.triaged++;
  }

  for (const proposal of payload.doc_proposals) {
    const r = await ingestDocProposal(ctx,proposal, author, { sessionId, itemIndex: idx++ });
    if (r.outcome === "written") result.docs.staged++;
    else if (r.outcome === "unchanged") result.docs.unchanged++;
    else if (r.outcome === "refused") (result.refused ??= []).push({ slug: r.slug, reason: r.reason });
    else result.docs.triaged++;
  }

  for (const draft of payload.adr_drafts) {
    const r = await ingestAdrDraft(ctx,draft, author, { sessionId, itemIndex: idx++ });
    if (r.outcome === "written") result.adrs.staged++;
    else if (r.outcome === "unchanged") result.adrs.unchanged++;
    else result.adrs.triaged++;
  }

  // Explicit triage items: already a triage request — written directly, but
  // ledger-guarded so a re-POST does not duplicate the queue row.
  for (const item of payload.needs_triage) {
    const ledger: LedgerRef = { sessionId, itemIndex: idx++ };
    if (await ledgerLookup(ctx,ledger)) {
      result.triage.unchanged++;
      continue;
    }
    await route_triage(ctx,{ raw: item.raw, reason: item.reason, source_author: author });
    await ledgerRecord(ctx,ledger, "triage", "triaged", null);
    result.triage.recorded++;
  }

  return result;
}

// ---------------------------------------------------------------------------
// recordBatch — the whole session batch: /ingest and MCP record_session both call
// THIS, so the two surfaces cannot drift. It is consume() (the gate, untouched) plus
// ONE post-batch step for `artifact_links` (issue #52): each link is a DIRECT
// authored write through the artifacts repository's addLink under the SAME
// authenticated principal — not an ingested item, so it never touches the replay
// ledger (addLink is idempotent, which is what makes a replay safe). The outcomes
// travel back as `artifact_links`, present only when the payload carried any.
// ---------------------------------------------------------------------------
export interface RecordBatchResult extends IngestResult {
  artifact_links?: ArtifactLinkOutcome[];
}

export async function recordBatch(ctx: TenantContext, payload: IngestPayload, principal: Principal): Promise<RecordBatchResult> {
  const result: RecordBatchResult = await consume(ctx,payload, principal);
  const links = payload.artifact_links ?? [];
  if (links.length) result.artifact_links = await applyArtifactLinks(ctx, links, principal.handle);
  return result;
}

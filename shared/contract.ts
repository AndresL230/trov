import { z } from "zod";
import { ARTIFACT_LINK_TYPES } from "./artifacts-core";

export const Session = z.object({
  id: z.string(),                  // uuid minted by the writer; the replay key with item_index
  author: z.string(),   // advisory only — overwritten server-side from the authenticated principal
  ended_at: z.string(),            // ISO8601
  skill_version: z.string(),
});

/** The Feed's "For reading" line: 1–2 sentences on the problem solved, for people. */
export const FEED_BRIEF_MAX = 280;

export const FeedEntry = z.object({
  summary: z.string(),
  // Optional so an older plugin keeps working (its entry reads title-only); over the
  // cap is a validation error — nothing is written, the writer resends.
  brief: z.string().trim().min(1).max(FEED_BRIEF_MAX).optional(),
  body: z.string(),
  tags: z.array(z.string()),
  artifacts: z.object({
    prs: z.array(z.string()).default([]),
    commits: z.array(z.string()).default([]),
    issues: z.array(z.number()).default([]),
  }),
});

export const DocProposal = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9_/-]*$/),
  section: z.string(),
  title: z.string().optional(),          // session sends a real title when it has one
  body: z.string(),                      // markdown, or mermaid/d2 for diagrams
  change_summary: z.string(),
  confidence: z.enum(["high", "low"]),
  space: z.enum(["technical", "product"]).optional(),  // server defaults technical on first creation
  base_version: z.number().optional(),   // the current_version the writer read before editing
  force: z.boolean().optional(),         // escape hatch: stage even if the body hash is unchanged
});

export const AdrDraft = z.object({
  title: z.string(),
  context: z.string(),
  decision: z.string(),
  rationale: z.string(),
  confidence: z.enum(["high", "low"]),
});

export const TriageItem = z.object({
  raw: z.string(),
  reason: z.string(),
});

// A captured GitHub event (webhook/backfill). subject_login is who the event is
// ABOUT — a second identity, distinct from the writer principal — and is trusted
// only because the webhook branch verified the delivery's HMAC before the gate.
export const CapturedEvent = z.object({
  semantic_key: z.string().min(1),   // derived identity, e.g. 'gh:pr:42:merged'
  event_type: z.enum(["pr_merged", "pr_closed", "issue"]),
  ref_number: z.number().int(),
  subject_login: z.string().min(1),
  raw: z.string(),                   // JSON snapshot slice — the truth
  provenance: z.enum(["webhook", "backfill"]),
  occurred_at: z.string().optional(),
});

// ── Read-side query contract (Phase 1) ───────────────────────────────────────
// The stable seam for assembled, authority-flagged retrieval. RRF (Reciprocal
// Rank Fusion) is the future cross-source merge when Vectorize lands; this
// envelope does not change when that happens.
/** The record types `query` searches. */
export const QueryType = z.enum(["doc", "decision", "feed", "sprint", "artifact"]);

export const QueryRequest = z.object({
  q: z.string().default(""),
  // NOTE: no "ticket" — tickets_fts exists but tickets are NOT in the /search
  // fan-out; the Tickets screen is their surface. "artifact" (issue #52) is in:
  // a private page reaches only its author (query()'s `viewer` argument).
  types: z.array(QueryType).optional(), // default all
  section: z.string().optional(),
  space: z.enum(["technical", "product"]).optional(),
  include_staged: z.boolean().optional(), // caller sets the default (MCP true, HTTP false)
  limit: z.number().optional(),           // full-body primary count (default 6)
  pointer_limit: z.number().optional(),   // ranked snippet count (default 20)
});

export const Authority = z.enum(["live", "staged_pending", "unpromoted", "draft"]);

export const QueryPrimary = z.object({
  type: QueryType,
  id: z.string(),
  title: z.string(),
  section: z.string().nullable(),
  space: z.string().nullable(),
  body: z.string(),                       // FULL current authoritative body
  authority: Authority,
  current_version: z.number().nullable(),
  pending_version: z.number().nullable(),
  staged_body: z.string().nullable(),     // only when include_staged AND a pending version exists
  confidence: z.string().nullable(),
  updated_at: z.string().nullable(),
  updated_by: z.string().nullable(),
  score: z.number(),                      // normalized so higher = better
});

export const QueryPointer = z.object({
  type: QueryType,
  id: z.string(),
  title: z.string(),
  snippet: z.string(),
  authority: Authority,
  score: z.number(),
});

export const QueryResult = z.object({
  primary: z.array(QueryPrimary),
  pointers: z.array(QueryPointer),
  meta: z.object({ engine: z.literal("fts5"), total: z.number() }),
});

/** One artifact → ticket / sprint / PR / issue link a session asks for (issue #52). */
export const ArtifactSessionLink = z.object({
  slug: z.string().min(1).max(80),
  target_type: z.enum(ARTIFACT_LINK_TYPES),
  target_ref: z.string().trim().min(1).max(300),
});

export const IngestPayload = z.object({
  session: Session,
  feed_entries: z.array(FeedEntry).default([]),
  doc_proposals: z.array(DocProposal).default([]),
  adr_drafts: z.array(AdrDraft).default([]),
  needs_triage: z.array(TriageItem).default([]),
  // Artifacts this session produced, linked to what they belong to. NOT an ingested
  // item: applied AFTER the batch is reconciled (`recordBatch` in src/consumer.ts),
  // each a DIRECT authored write through the artifacts repository's addLink under the
  // authenticated principal — a page it cannot see is `not_found`. addLink is
  // idempotent, so a replay links nothing twice. Same on /ingest and record_session.
  artifact_links: z.array(ArtifactSessionLink).max(50).default([]),
});

export type Session = z.infer<typeof Session>;
export type FeedEntry = z.infer<typeof FeedEntry>;
export type DocProposal = z.infer<typeof DocProposal>;
export type AdrDraft = z.infer<typeof AdrDraft>;
export type TriageItem = z.infer<typeof TriageItem>;
export type CapturedEvent = z.infer<typeof CapturedEvent>;
export type IngestPayload = z.infer<typeof IngestPayload>;
export type QueryRequest = z.infer<typeof QueryRequest>;
export type QueryType = z.infer<typeof QueryType>;
export type ArtifactSessionLink = z.infer<typeof ArtifactSessionLink>;
export type Authority = z.infer<typeof Authority>;
export type QueryPrimary = z.infer<typeof QueryPrimary>;
export type QueryPointer = z.infer<typeof QueryPointer>;
export type QueryResult = z.infer<typeof QueryResult>;

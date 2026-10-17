// What the AI pass's Jev CARD jobs read (docs/architecture/ai.md › The kinds; Phase C) — the ticket card
// (`ticket.category` / `ticket.priority` / `ticket.duplicate`), the Review card (`review.risk`) and the Unplaced card
// (`unplaced.destination`) — and what the screens read back of what those jobs wrote. A TENANT module: every
// statement names `org_id = ?`, bound from the caller's context (test/data-layer.static.test.ts). Nothing here
// calls a model.
//
// The full-text CANDIDATES (a ticket's possible duplicates, an Unplaced item's nearby docs, a proposal's related
// docs and decisions) come from THIS org's own indexes only, ranked by bm25, and never include the item itself:
// what Jev may pick from is exactly what these return.
import type { AiSuggestion } from "@shared/ai";
import { all, first, type TenantContext } from "./sql";
import { aiKeySet } from "./context";
import { suggestionDto, type AiSuggestionRow } from "./ai";

const SUGGESTION_COLS = `s.id, s.item_type, s.item_ref, s.kind, s.value_json, s.confidence, s.reason, s.cites_json, s.model, s.prompt_version, s.state, s.created_at, s.decided_by, s.decided_at`;

// ── suggestions: decided kinds, and what a screen shows ─────────────────────

/** The kinds a person already DECIDED for this item (accepted or dismissed): never suggested again. */
export async function decidedKinds(ctx: TenantContext, itemType: string, itemRef: string): Promise<Set<string>> {
  const rows = await all<{ kind: string }>(ctx,
    `SELECT DISTINCT kind FROM ai_suggestions WHERE org_id = ? AND item_type = ? AND item_ref = ? AND state IN ('accepted','dismissed')`,
    ctx.orgId, itemType, itemRef);
  return new Set(rows.map((r) => r.kind));
}

/**
 * The OPEN suggestions of `kinds` for these items, as the screens show them — ONLY under THE read rule
 * (src/plans/gate.ts `aiShown`): the org's switch on (the join on `orgs.ai_automation`, in the same statement) and an
 * Anthropic key on the deployment (no key: nothing is read). Off, nothing comes back and the screen draws what it
 * drew before. Oldest first, so a screen keeps a stable order.
 */
export async function openSuggestions(ctx: TenantContext, itemType: string, refs: readonly string[], kinds: readonly string[]): Promise<AiSuggestion[]> {
  if (!refs.length || !kinds.length || !aiKeySet(ctx)) return [];
  const out: AiSuggestion[] = [];
  // D1 binds at most 100 parameters: refs go in chunks.
  for (let i = 0; i < refs.length; i += 80) {
    const chunk = refs.slice(i, i + 80);
    const rows = await all<AiSuggestionRow>(ctx,
      `SELECT ${SUGGESTION_COLS} FROM ai_suggestions s JOIN orgs o ON o.id = s.org_id AND o.ai_automation = 1
        WHERE s.org_id = ? AND s.state = 'open' AND s.item_type = ?
          AND s.item_ref IN (${chunk.map(() => "?").join(",")}) AND s.kind IN (${kinds.map(() => "?").join(",")})
        ORDER BY s.id`,
      ctx.orgId, itemType, ...chunk, ...kinds);
    out.push(...rows.map(suggestionDto));
  }
  return out;
}

/** Is the org's AI shown — its switch on (`orgs.ai_automation`) AND an Anthropic key on the deployment (THE read rule,
 *  src/plans/gate.ts `aiShown`)? No key reads nothing. A failed read is off. */
export async function aiSwitchOn(ctx: TenantContext): Promise<boolean> {
  if (!aiKeySet(ctx)) return false;
  const r = await first<{ enabled: number }>(ctx, `SELECT ai_automation AS enabled FROM orgs WHERE id = ?`, ctx.orgId).catch(() => null);
  return r?.enabled === 1;
}

// ── the ticket card ──────────────────────────────────────────────────────────

export interface TicketCardRow {
  id: number;
  number: number;
  title: string;
  body: string;
  category: string;
  priority: string;
  status: string;
  parent_id: number | null;
  source_ref: string | null;
}

export function ticketCardRow(ctx: TenantContext, number: number): Promise<TicketCardRow | null> {
  return first<TicketCardRow>(ctx,
    `SELECT id, number, title, body, category, priority, status, parent_id, source_ref FROM tickets WHERE number = ? AND org_id = ?`,
    number, ctx.orgId);
}

export interface TicketCandidateRow { id: number; number: number; title: string; body: string; source_ref: string | null; snippet: string | null }

/** The top `limit` tickets of this org the index matches against `match` — never `selfId`, never a ticket already
 *  its parent or child. bm25 weighs the title 5× the body, as quick search does. */
export function ticketCandidates(ctx: TenantContext, match: string, selfId: number, limit: number): Promise<TicketCandidateRow[]> {
  return all<TicketCandidateRow>(ctx,
    `SELECT t.id, t.number, t.title, t.body, t.source_ref, snippet(tickets_fts, -1, '', '', '…', 12) AS snippet
       FROM tickets_fts JOIN tickets t ON t.id = CAST(tickets_fts.ticket_id AS INTEGER) AND t.org_id = ?
      WHERE tickets_fts MATCH ? AND tickets_fts.org_id = ? AND t.id != ?
        AND (t.parent_id IS NULL OR t.parent_id != ?)
        AND t.id != COALESCE((SELECT p.parent_id FROM tickets p WHERE p.id = ? AND p.org_id = ?), -1)
      ORDER BY bm25(tickets_fts, 1.0, 5.0, 1.0) LIMIT ${Math.max(1, Math.min(10, Math.trunc(limit)))}`,
    ctx.orgId, match, ctx.orgId, selfId, selfId, selfId, ctx.orgId);
}

/** The URLs a ticket already links to (any kind). */
export async function ticketLinkUrls(ctx: TenantContext, ticketId: number): Promise<string[]> {
  const rows = await all<{ url: string }>(ctx, `SELECT url FROM ticket_links WHERE ticket_id = ? AND org_id = ?`, ticketId, ctx.orgId);
  return rows.map((r) => r.url);
}

// ── the Review card ──────────────────────────────────────────────────────────

export interface ProposalCardRow {
  slug: string;
  version: number;
  title: string;
  section: string;
  summary: string | null;
  change_kind: "new" | "edit" | "rewrite" | null;
  current_version: number;
  staged_body: string;
  live_body: string;
}

/** A staged doc version still waiting in Review (staged, newer than the live doc), or null. */
export function proposalCardRow(ctx: TenantContext, slug: string, version: number): Promise<ProposalCardRow | null> {
  return first<ProposalCardRow>(ctx,
    `SELECT v.slug AS slug, v.version AS version, d.title AS title, d.section AS section, v.summary AS summary, v.change_kind AS change_kind,
            d.current_version AS current_version, v.body AS staged_body, d.body AS live_body
       FROM doc_versions v JOIN docs d ON d.slug = v.slug AND d.org_id = ?
      WHERE v.org_id = ? AND v.slug = ? AND v.version = ? AND v.status = 'staged' AND v.version > d.current_version AND d.archived_at IS NULL`,
    ctx.orgId, ctx.orgId, slug, version);
}

export interface AdrCardRow { id: number; title: string; context: string | null; decision: string | null; rationale: string | null }

/** A drafted decision still waiting in Review, or null. */
export function adrCardRow(ctx: TenantContext, id: number): Promise<AdrCardRow | null> {
  return first<AdrCardRow>(ctx, `SELECT id, title, context, decision, rationale FROM adrs WHERE id = ? AND org_id = ? AND status = 'draft'`, id, ctx.orgId);
}

export interface DocHitRow { slug: string; title: string; section: string; body: string; snippet: string | null }

/** The top `limit` LIVE docs of this org the index matches against `match`, never `exceptSlug`. */
export function docCandidates(ctx: TenantContext, match: string, exceptSlug: string | null, limit: number): Promise<DocHitRow[]> {
  return all<DocHitRow>(ctx,
    `SELECT d.slug AS slug, d.title AS title, d.section AS section, d.body AS body, snippet(docs_fts, 3, '', '', '…', 12) AS snippet
       FROM docs_fts JOIN docs d ON d.slug = docs_fts.slug AND d.org_id = ?
      WHERE docs_fts MATCH ? AND docs_fts.org_id = ? AND d.current_version > 0 AND d.archived_at IS NULL AND d.section != 'needs-triage' AND d.slug != ?
      ORDER BY bm25(docs_fts, 1.0, 5.0, 1.0, 1.0) LIMIT ${Math.max(1, Math.min(10, Math.trunc(limit)))}`,
    ctx.orgId, match, ctx.orgId, exceptSlug ?? "");
}

export interface AdrHitRow { id: number; title: string; decision: string | null; snippet: string | null }

/** The top `limit` RATIFIED decisions of this org the index matches against `match`, never `exceptId`. */
export function ratifiedAdrCandidates(ctx: TenantContext, match: string, exceptId: number | null, limit: number): Promise<AdrHitRow[]> {
  return all<AdrHitRow>(ctx,
    `SELECT a.id AS id, a.title AS title, a.decision AS decision, snippet(adrs_fts, -1, '', '', '…', 12) AS snippet
       FROM adrs_fts JOIN adrs a ON a.id = CAST(adrs_fts.adr_id AS INTEGER) AND a.org_id = ?
      WHERE adrs_fts MATCH ? AND adrs_fts.org_id = ? AND a.status = 'ratified' AND a.id != ?
      ORDER BY bm25(adrs_fts) LIMIT ${Math.max(1, Math.min(10, Math.trunc(limit)))}`,
    ctx.orgId, match, ctx.orgId, exceptId ?? -1);
}

// ── the Unplaced card ────────────────────────────────────────────────────────

export interface TriageCardRow { id: number; raw: string; reason: string }

/** An Unplaced item still in the queue, or null. */
export function triageCardRow(ctx: TenantContext, id: number): Promise<TriageCardRow | null> {
  return first<TriageCardRow>(ctx, `SELECT id, raw, reason FROM needs_triage WHERE id = ? AND org_id = ? AND resolved = 0`, id, ctx.orgId);
}

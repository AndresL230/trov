import type { DocRow, DocMetaRow, DocVersionRow, FeedRow, AdrRow, NeedsTriageRow, SprintRow, PlanRow, EventRow, IdentityTaskRow, TicketRow, TicketLinkRow, TicketCommentRow, TicketEventRow } from "@shared/rows";
import type { QueryRequest, QueryResult, QueryPrimary, QueryPointer, Authority, QueryType as ContractQueryType } from "@shared/contract";
import { ARTIFACT_INLINE_MAX, type ArtifactKind, type ArtifactStatus } from "@shared/artifacts";
import { ftsBody, listPages, searchArtifacts } from "./artifacts";
import type { TicketListItem, TicketDetail, TicketRef, TicketSeg, TicketAssigneeFilter, TicketCategory } from "@shared/tickets";
import { OPEN_STATUSES, OPEN_STATUS_SQL, TICKET_STATUSES } from "@shared/tickets-core";
import { type TenantContext, first, all, ph, fanOut } from "../data/sql";
// The sprint read model lives next to the sprint writers; `query()` borrows its
// progress RULE so the assembled sprint body and the Roadmap can never disagree.
import { sprintProgress, ticketCountsBySprint } from "./sprints";

export async function get_doc(
  ctx: TenantContext,
  slug: string
): Promise<{ doc: DocRow; versions: DocVersionRow[] } | null> {
  const doc = await first<DocRow>(ctx, `SELECT * FROM docs WHERE org_id = ? AND slug = ?`, ctx.orgId, slug);
  if (!doc) return null;
  const versions = await all<DocVersionRow>(
    ctx,
    `SELECT * FROM doc_versions WHERE org_id = ? AND slug = ? ORDER BY version ASC`,
    ctx.orgId,
    slug
  );
  return { doc, versions };
}

export async function list_docs(ctx: TenantContext, section?: string): Promise<DocRow[]> {
  if (section) {
    return all<DocRow>(ctx, `SELECT * FROM docs WHERE org_id = ? AND section = ? ORDER BY slug ASC`, ctx.orgId, section);
  }
  return all<DocRow>(ctx, `SELECT * FROM docs WHERE org_id = ? ORDER BY slug ASC`, ctx.orgId);
}

/** Every doc WITHOUT its body — for a surface that only lists (My Work's "Docs you
 *  own"), so it never pulls every doc's full text over the wire. */
export async function list_doc_meta(ctx: TenantContext): Promise<DocMetaRow[]> {
  return all<DocMetaRow>(ctx,
    `SELECT slug, section, title, current_version, updated_at, updated_by, space, owner FROM docs WHERE org_id = ? ORDER BY slug ASC`,
    ctx.orgId);
}

export interface FeedFilter {
  author?: string;
  tags?: string[];
  since?: string;
  limit?: number;
}

export async function get_feed(ctx: TenantContext, filter: FeedFilter = {}): Promise<FeedRow[]> {
  const clauses: string[] = [`f.org_id = ?`];
  const params: unknown[] = [ctx.orgId];
  const joinParams: unknown[] = [];
  let join = "";

  if (filter.author) {
    clauses.push(`f.author = ?`);
    params.push(filter.author);
  }
  if (filter.since) {
    clauses.push(`f.created_at >= ?`);
    params.push(filter.since);
  }
  if (filter.tags && filter.tags.length > 0) {
    const placeholders = filter.tags.map(() => "?").join(", ");
    join = `JOIN entry_tags et ON et.org_id = ? AND et.entry_type = 'feed'
            AND et.entry_id = CAST(f.id AS TEXT) AND et.tag IN (${placeholders})`;
    joinParams.push(ctx.orgId, ...filter.tags);
  }

  const where = `WHERE ${clauses.join(" AND ")}`;
  // Clamp to a safe integer; interpolated (not bound) because SQLite rejects bound LIMIT in some drivers.
  const limit = Math.trunc(Math.min(Math.max(filter.limit ?? 50, 1), 500));

  return all<FeedRow>(
    ctx,
    `SELECT DISTINCT f.* FROM feed f ${join} ${where} ORDER BY f.created_at DESC, f.id DESC LIMIT ${limit}`,
    ...joinParams,
    ...params
  );
}

// NOTE: the old flat-LIKE search_context was replaced by query() (below) — one
// engine. /search and the MCP `query` tool both back onto it.

export async function list_needs_triage(ctx: TenantContext): Promise<NeedsTriageRow[]> {
  return all<NeedsTriageRow>(ctx, `SELECT * FROM needs_triage WHERE org_id = ? AND resolved = 0 ORDER BY created_at DESC, id DESC`, ctx.orgId);
}

export async function list_adrs(ctx: TenantContext, status?: string): Promise<AdrRow[]> {
  // Decision reads exclude 'rejected' (Phase 3): a rejected draft leaves the queue.
  // With an explicit status filter the caller already constrains it (the UI asks
  // for 'draft' / 'ratified', never 'rejected').
  return status
    ? all<AdrRow>(ctx, `SELECT * FROM adrs WHERE org_id = ? AND status = ? ORDER BY created_at DESC, id DESC`, ctx.orgId, status)
    : all<AdrRow>(ctx, `SELECT * FROM adrs WHERE org_id = ? AND status != 'rejected' ORDER BY created_at DESC, id DESC`, ctx.orgId);
}

// The Proposals queue, server-joined (Phase 3, audit G9): every staged doc version
// newer than the live doc, not rejected, joined to its doc — carrying both bodies
// (live promoted + staged) and the Phase 2 reconciler metadata so Phase 4 can chip
// and diff the queue without the old per-doc N+1.
export interface ProposalRow {
  slug: string;
  version: number;
  title: string;
  section: string;
  space: string;
  summary: string | null;
  author: string;
  confidence: string | null;
  status: string;
  change_kind: "new" | "edit" | "rewrite" | null;
  low_confidence: number;
  base_version: number | null;
  current_version: number;
  created_at: string;    // doc_versions.created_at (when the proposal was staged)
  stagedBody: string;    // doc_versions.body (the proposed body)
  promotedBody: string;  // docs.body (the current live body)
}

export async function list_proposals(ctx: TenantContext): Promise<ProposalRow[]> {
  return all<ProposalRow>(
    ctx,
    `SELECT v.slug AS slug, v.version AS version, d.title AS title, d.section AS section, d.space AS space,
            v.summary AS summary, v.created_by AS author, v.confidence AS confidence, v.status AS status,
            v.change_kind AS change_kind, v.low_confidence AS low_confidence, v.base_version AS base_version,
            d.current_version AS current_version, v.created_at AS created_at,
            v.body AS stagedBody, d.body AS promotedBody
       FROM doc_versions v JOIN docs d ON d.slug = v.slug AND d.org_id = ?
      WHERE v.org_id = ? AND v.status = 'staged' AND v.version > d.current_version
      ORDER BY v.created_at DESC, v.id DESC`,
    ctx.orgId,
    ctx.orgId
  );
}

// ── Identity triage (Maintenance group) ───────────────────────────────────────

// One sampled event on an identity task: enough for a human to recognize whose
// work this login is. `title` comes from the event's own raw snapshot (PR or
// issue); a malformed raw yields null rather than failing the list.
export interface IdentitySample {
  semantic_key: string;
  event_type: EventRow["event_type"];
  ref_number: number;
  title: string | null;
  occurred_at: string | null;
}
export interface IdentityTaskWithSample extends IdentityTaskRow {
  sample: IdentitySample[];
}

const IDENTITY_SAMPLE_LIMIT = 3;

function titleFromRaw(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { pr?: { title?: string }; issue?: { title?: string } };
    return parsed.pr?.title ?? parsed.issue?.title ?? null;
  } catch {
    return null;
  }
}

/**
 * Pending identity tasks, each with a small LIVE activity sample. Activity is
 * never copied onto the task — events are already stored by raw login, so the
 * sample is just a per-login SELECT at read time (the queue is human-scale).
 */
export async function list_identity_tasks(ctx: TenantContext): Promise<IdentityTaskWithSample[]> {
  const tasks = await all<IdentityTaskRow>(
    ctx,
    `SELECT * FROM identity_tasks WHERE org_id = ? AND status = 'pending' ORDER BY first_seen DESC, login ASC`,
    ctx.orgId
  );
  const out: IdentityTaskWithSample[] = [];
  for (const t of tasks) {
    const rows = await all<EventRow>(
      ctx,
      `SELECT * FROM events WHERE org_id = ? AND subject_login = ? ORDER BY occurred_at DESC, id DESC LIMIT ${IDENTITY_SAMPLE_LIMIT}`,
      ctx.orgId,
      t.login
    );
    out.push({
      ...t,
      sample: rows.map((e) => ({
        semantic_key: e.semantic_key,
        event_type: e.event_type,
        ref_number: e.ref_number,
        title: titleFromRaw(e.raw),
        occurred_at: e.occurred_at,
      })),
    });
  }
  return out;
}

/** A discarded login, as the Identity tab's restore list shows it. */
export interface DiscardedIdentity {
  login: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

/**
 * Discarded identity tasks, newest discard first — what Undo can still bring
 * back. A login linked since (a GitHub sign-in) is left out: restoring it would
 * list a task there is nothing left to map.
 */
export async function list_discarded_identities(ctx: TenantContext): Promise<DiscardedIdentity[]> {
  return all<DiscardedIdentity>(
    ctx,
    `SELECT t.login, t.resolved_at, t.resolved_by FROM identity_tasks t
     WHERE t.org_id = ? AND t.status = 'discarded'
       AND NOT EXISTS (SELECT 1 FROM identities i WHERE i.provider = 'github' AND i.subject = t.login)
     ORDER BY t.resolved_at DESC, t.login ASC`,
    ctx.orgId
  );
}

// ── Tickets (the org-wide queue) ──────────────────────────────────────────────
//
// Read-only projections over the 0024 tables. Everything here is a fixed number
// of round-trips: the rows come back in ONE query, then each derived column
// (assignees, link counts, sub counts, sprint labels) is a single grouped query
// keyed by ticket id. No per-row fan-out — the queue renders the whole org.

/** The `seg` filter: Open = not yet resolved by a person. */
const SEG_STATUSES: Record<TicketSeg, readonly string[]> = {
  open: OPEN_STATUSES,
  closed: ["done", "declined"],
  all: TICKET_STATUSES,
};

export interface TicketListFilter {
  seg?: TicketSeg;
  assignee?: TicketAssigneeFilter;
  category?: TicketCategory;
  /** The signed-in principal's handle — what `assignee: 'me'` resolves to. */
  me?: string;
}

export async function list_tickets(ctx: TenantContext, filter: TicketListFilter = {}): Promise<TicketListItem[]> {
  const seg = filter.seg ?? "open";
  const assignee = filter.assignee ?? "anyone";
  const statuses = SEG_STATUSES[seg];

  const clauses: string[] = [`t.org_id = ?`, `t.status IN (${ph(statuses.length)})`];
  const params: unknown[] = [ctx.orgId, ...statuses];
  if (filter.category) {
    clauses.push(`t.category = ?`);
    params.push(filter.category);
  }
  if (assignee === "me") {
    // An unresolvable `me` (no principal) matches nothing rather than everything.
    // NOCASE, like `persons.handle` and `getPerson` — a principal spelled with a
    // different case must not silently match nothing.
    clauses.push(`EXISTS (SELECT 1 FROM ticket_assignees a WHERE a.org_id = ? AND a.ticket_id = t.id AND a.login = ? COLLATE NOCASE)`);
    params.push(ctx.orgId, filter.me ?? "");
  } else if (assignee === "unassigned") {
    clauses.push(`NOT EXISTS (SELECT 1 FROM ticket_assignees a WHERE a.org_id = ? AND a.ticket_id = t.id)`);
    params.push(ctx.orgId);
  }

  const rows = await all<TicketRow>(
    ctx,
    `SELECT t.* FROM tickets t WHERE ${clauses.join(" AND ")} ORDER BY t.updated_at DESC, t.id DESC`,
    ...params
  );
  if (rows.length === 0) return [];

  // The queue is org-wide and unpaginated, so these id lists routinely outgrow
  // D1's 100-bound-parameter ceiling: every one goes through `fanOut` (src/db.ts).
  const ids = rows.map((r) => r.id);

  const assigneeRows = await fanOut<{ ticket_id: number; login: string }>(
    ctx,
    ids,
    (p) => `SELECT ticket_id, login FROM ticket_assignees WHERE org_id = ? AND ticket_id IN (${p}) ORDER BY login ASC`,
    [ctx.orgId]
  );
  const linkRows = await fanOut<{ ticket_id: number; n: number }>(
    ctx,
    ids,
    (p) => `SELECT ticket_id, COUNT(*) AS n FROM ticket_links WHERE org_id = ? AND ticket_id IN (${p}) GROUP BY ticket_id`,
    [ctx.orgId]
  );
  const subRows = await fanOut<{ parent_id: number; n: number }>(
    ctx,
    ids,
    (p) => `SELECT parent_id, COUNT(*) AS n FROM tickets WHERE org_id = ? AND parent_id IN (${p}) GROUP BY parent_id`,
    [ctx.orgId]
  );

  const sprintIds = [...new Set(rows.map((r) => r.sprint_id).filter((v): v is number => v !== null))];
  const sprintRows = await fanOut<{ id: number; title: string }>(
    ctx,
    sprintIds,
    (p) => `SELECT id, title FROM sprints WHERE org_id = ? AND id IN (${p})`,
    [ctx.orgId]
  );

  const byTicket = new Map<number, string[]>();
  for (const a of assigneeRows) {
    const list = byTicket.get(a.ticket_id) ?? [];
    list.push(a.login);
    byTicket.set(a.ticket_id, list);
  }
  const links = new Map(linkRows.map((r) => [r.ticket_id, r.n]));
  const subs = new Map(subRows.map((r) => [r.parent_id, r.n]));
  const sprintLabels = new Map(sprintRows.map((r) => [r.id, r.title]));

  return rows.map((r) => ({
    ...r,
    assignees: byTicket.get(r.id) ?? [],
    link_count: links.get(r.id) ?? 0,
    sub_count: subs.get(r.id) ?? 0,
    sprint_label: r.sprint_id !== null ? sprintLabels.get(r.sprint_id) ?? null : null,
  }));
}

/** One ticket, whole: assignees, links, comments, history, parent + children, sprint. */
export async function get_ticket(ctx: TenantContext, id: number): Promise<TicketDetail | null> {
  const t = await first<TicketRow>(ctx, `SELECT * FROM tickets WHERE id = ? AND org_id = ?`, id, ctx.orgId);
  if (!t) return null;

  const assignees = (
    await all<{ login: string }>(ctx, `SELECT login FROM ticket_assignees WHERE org_id = ? AND ticket_id = ? ORDER BY login ASC`, ctx.orgId, id)
  ).map((a) => a.login);
  const links = await all<TicketLinkRow>(ctx, `SELECT * FROM ticket_links WHERE org_id = ? AND ticket_id = ? ORDER BY created_at ASC, id ASC`, ctx.orgId, id);
  const comments = await all<TicketCommentRow>(ctx, `SELECT * FROM ticket_comments WHERE org_id = ? AND ticket_id = ? ORDER BY created_at ASC, id ASC`, ctx.orgId, id);
  const events = await all<TicketEventRow>(ctx, `SELECT * FROM ticket_events WHERE org_id = ? AND ticket_id = ? ORDER BY created_at ASC, id ASC`, ctx.orgId, id);
  const children = await all<TicketRef>(
    ctx,
    `SELECT id, title, status FROM tickets WHERE org_id = ? AND parent_id = ? ORDER BY updated_at DESC, id DESC`,
    ctx.orgId,
    id
  );
  const parent = t.parent_id !== null
    ? await first<TicketRef>(ctx, `SELECT id, title, status FROM tickets WHERE id = ? AND org_id = ?`, t.parent_id, ctx.orgId)
    : null;
  const sprintRow = t.sprint_id !== null
    ? await first<{ id: number; title: string }>(ctx, `SELECT id, title FROM sprints WHERE id = ? AND org_id = ?`, t.sprint_id, ctx.orgId)
    : null;

  return {
    ...t,
    assignees,
    links,
    comments,
    events,
    parent,
    children,
    sprint: sprintRow ? { id: sprintRow.id, label: sprintRow.title } : null,
  };
}

/** The sidebar badge: active tickets nobody has picked up (unassigned + open).
 *  NATIVE tickets only — an unassigned mirrored ticket is an unassigned GitHub
 *  issue, triaged on GitHub, and would otherwise flood the badge (0032). */
export async function ticket_badge(ctx: TenantContext): Promise<number> {
  const row = await first<{ n: number }>(
    ctx,
    `SELECT COUNT(*) AS n FROM tickets t
      WHERE t.org_id = ? AND t.status IN ${OPEN_STATUS_SQL} AND t.source = 'canopy'
        AND NOT EXISTS (SELECT 1 FROM ticket_assignees a WHERE a.org_id = ? AND a.ticket_id = t.id)`,
    ctx.orgId,
    ctx.orgId
  );
  return row?.n ?? 0;
}

// ── Sprints (the Roadmap's containers) ────────────────────────────────────────
//
// DEFINED in ./sprints.ts, next to the sprint writers and the one progress rule
// (`sprintProgress`) they share — splitting the read half off would have put the
// ticket-inclusive math in two files. Re-exported here so every read surface,
// including MCP, can reach the whole read model from one module.
export { list_sprints, get_sprint } from "./sprints";

// ── query(): ranked, assembled FTS5 retrieval (Phase 1 read-side brain) ───────
//
// One engine. Per requested type, bm25-ranked FTS5 (title/summary weighted above
// body) yields candidates; the global top-`limit` by score become `primary`
// (hydrated from base rows with the FULL authoritative body + an authority flag),
// the remainder up to `pointer_limit` become `pointers` (fts5 snippet()). Empty
// `q` degrades to a filtered browse ordered by recency.
//
// SEAM: when Vectorize lands, a second (semantic) candidate stream merges here via
// RRF (Reciprocal Rank Fusion). The QueryResult envelope is the stable contract;
// this normalize-bm25-then-global-sort is the FTS-only special case of that merge.

// NOTE: `ticket` is deliberately NOT a query type. `tickets_fts` stays populated
// (0024 keeps the table and its three triggers) but tickets are their own
// surface — the Tickets screen — and never join the /search fan-out.
//
// `artifact` (issue #52) IS a query type, and in the default list: candidates come
// from the artifacts repository (`searchArtifacts` — bm25 1.0/5.0/1.0/1.0, title
// weighted — or `listPages` when browsing), both of which apply the ONE visibility
// rule with query()'s `viewer`: a private page reaches only its author, and with no
// viewer no private page reaches anyone. Authority: draft → "draft", published /
// ratified → "live"; the body's first line says which (`Status: <status> · v<n>`).
type QueryType = ContractQueryType;
const DEFAULT_QUERY_TYPES: readonly QueryType[] = ["doc", "decision", "feed", "sprint", "artifact"];

/** One artifact page joined to its CURRENT version, for hydration. */
interface ArtifactHydrateRow {
  id: number;
  slug: string;
  title: string;
  kind: ArtifactKind;
  area: string;
  repo: string;
  status: ArtifactStatus;
  author_id: string;
  current_version: number;
  updated_at: string;
  content: string | null;
  summary: string;
  content_type: string;
  size_bytes: number;
  created_by: string;
}

// The hydrated artifact body. First line `Status: <status> · v<n>` (the spec's
// contract — it is how an agent tells ratified from merely published), then kind /
// area / repo, the latest version's summary, and the content: markdown / mermaid
// raw, html / svg as their visible text (`ftsBody` — the raw markup is one
// artifact_get away), binary kinds a one-line description (no bytes over query).
// Text over ARTIFACT_INLINE_MAX (the stored UTF-8 size) is a pointer line too, the
// same rule as artifact_get's `content_omitted`.
function assembleArtifactBody(a: ArtifactHydrateRow): string {
  const head = [
    `Status: ${a.status} · v${a.current_version}`,
    `Kind: ${a.kind} · Area: ${a.area}${a.repo ? ` · Repo: ${a.repo}` : ""}`,
  ];
  if (a.summary) head.push(`Summary: ${a.summary}`);
  const body = a.content === null
    ? `(${a.kind} file · ${a.content_type} · ${a.size_bytes} bytes — read it with artifact_get)`
    : a.size_bytes > ARTIFACT_INLINE_MAX
      ? `(${a.kind} · ${a.size_bytes} bytes — too large to inline; read it with artifact_get)`
      : ftsBody(a.kind, a.content);
  return `${head.join("\n")}\n\n${body}`;
}

// Internal assembled record: a superset carrying everything both a primary
// (full body) and a pointer (snippet) need, so we hydrate once per candidate.
interface Assembled {
  type: QueryType;
  id: string;
  title: string;
  section: string | null;
  space: string | null;
  body: string;
  authority: Authority;
  current_version: number | null;
  pending_version: number | null;
  staged_body: string | null;
  confidence: string | null;
  updated_at: string | null;
  updated_by: string | null;
  score: number;
  snippet: string;
}

// A raw candidate from one type's FTS (or browse) pass, before hydration.
interface Candidate {
  type: QueryType;
  key: string;      // doc slug | feed id | adr id | ticket id (as text) | roadmap ref ('sprint:<id>' | 'plan')
  score: number;    // normalized so higher = better
  snippet: string;  // fts5 snippet() or a browse body slice
}

const SNIPPET = `'', '', '…', 12`; // open, close, ellipsis, tokens — no markup (raw text)

// Build a syntactically-safe FTS5 MATCH expression: keep only word characters,
// quote each token as a phrase, OR them together. Returns null when nothing is
// left to match (caller degrades to browse). Quoting every token guarantees we
// never feed FTS5 its own operator/syntax characters.
export function buildMatch(q: string): string | null {
  const cleaned = q.replace(/[^\p{L}\p{N}_]+/gu, " ").trim();
  if (!cleaned) return null;
  return cleaned.split(/\s+/).map((t) => `"${t}"`).join(" OR ");
}

const browseSnippet = (body: string | null): string => {
  const s = (body ?? "").replace(/\s+/g, " ").trim();
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
};

function assembleAdrBody(a: AdrRow): string {
  const parts: string[] = [];
  if (a.context) parts.push(`## Context\n${a.context}`);
  if (a.decision) parts.push(`## Decision\n${a.decision}`);
  if (a.rationale) parts.push(`## Rationale\n${a.rationale}`);
  return parts.join("\n\n");
}

// The hydrated sprint body: description + summary + phase + a progress line.
//
// The progress line obeys the ONE rule (`sprintProgress` in ./sprints.ts): the
// sprint's OWN TICKETS (done + declined over total) and nothing else. The ticket
// counts are read once per query() call via one grouped query over the hydrated
// sprint ids and passed in, so this stays a pure assembly step with no
// per-result round-trip. A sprint with no tickets carries no line at all: there
// is nothing to report, and a bare "0/0" would read as a claim.
//
// The cached GitHub issue counts are deliberately NOT in this body — they are a
// separate field on the read DTOs (`SprintView.issues`), shown only in the
// Roadmap's Narrative spotlight.
function assembleSprintBody(
  sp: SprintRow,
  tickets: { total: number; closed: number } | undefined
): string {
  const parts: string[] = [];
  if (sp.description) parts.push(sp.description);
  if (sp.summary) parts.push(sp.summary);
  if (sp.phase) parts.push(sp.phase);
  const progress = sprintProgress({
    ticketsTotal: tickets?.total ?? 0,
    ticketsClosed: tickets?.closed ?? 0,
  });
  if (progress.total > 0) parts.push(`Progress: ${progress.closed}/${progress.total} closed`);
  return parts.join("\n");
}

/**
 * `viewer` is the principal's handle — it decides which PRIVATE artifacts are
 * visible (only their author's). Omitted → no private artifact is returned.
 * Every other type is org-wide and ignores it.
 */
export async function query(ctx: TenantContext, req: QueryRequest, viewer?: string): Promise<QueryResult> {
  const types: readonly QueryType[] = req.types ?? DEFAULT_QUERY_TYPES;
  const artifactViewer = viewer ?? "";
  const limit = Math.trunc(Math.min(Math.max(req.limit ?? 6, 0), 50));
  const pointerLimit = Math.trunc(Math.min(Math.max(req.pointer_limit ?? 20, 0), 100));
  const includeStaged = req.include_staged ?? false;
  const section = req.section;
  const space = req.space;
  // A section/space filter only makes sense for docs (feed/adrs carry neither),
  // so those types drop out when either is set — mirroring the old engine.
  const docsOnly = section !== undefined || space !== undefined;
  const fetchCap = limit + pointerLimit;

  const match = buildMatch(req.q ?? "");

  // 1. Gather raw candidates per requested type (FTS when we have a match
  //    expression, else a recency browse).
  const candidates: Candidate[] = [];

  if (types.includes("doc")) {
    if (match) {
      const clauses = ["docs_fts MATCH ?", "docs_fts.org_id = ?"];
      const params: unknown[] = [ctx.orgId, match, ctx.orgId];
      if (section !== undefined) { clauses.push("docs.section = ?"); params.push(section); }
      if (space !== undefined) { clauses.push("docs.space = ?"); params.push(space); }
      const rows = await all<{ key: string; rank: number; snip: string }>(
        ctx,
        `SELECT docs_fts.slug AS key, bm25(docs_fts, 1.0, 5.0, 1.0, 1.0) AS rank,
                snippet(docs_fts, -1, ${SNIPPET}) AS snip
         FROM docs_fts JOIN docs ON docs.slug = docs_fts.slug AND docs.org_id = ?
         WHERE ${clauses.join(" AND ")} ORDER BY rank LIMIT ${fetchCap}`,
        ...params
      );
      for (const r of rows) candidates.push({ type: "doc", key: String(r.key), score: -r.rank, snippet: r.snip });
    } else {
      const clauses: string[] = ["org_id = ?"];
      const params: unknown[] = [ctx.orgId];
      if (section !== undefined) { clauses.push("section = ?"); params.push(section); }
      if (space !== undefined) { clauses.push("space = ?"); params.push(space); }
      const rows = await all<{ key: string; ts: string | null }>(
        ctx,
        `SELECT slug AS key, updated_at AS ts FROM docs WHERE ${clauses.join(" AND ")}
         ORDER BY (updated_at IS NULL), updated_at DESC, slug DESC LIMIT ${fetchCap}`,
        ...params
      );
      for (const r of rows) candidates.push({ type: "doc", key: String(r.key), score: 0, snippet: "" });
    }
  }

  if (types.includes("feed") && !docsOnly) {
    if (match) {
      const rows = await all<{ key: string; rank: number; snip: string }>(
        ctx,
        `SELECT feed_id AS key, bm25(feed_fts, 1.0, 5.0, 1.0) AS rank,
                snippet(feed_fts, -1, ${SNIPPET}) AS snip
         FROM feed_fts WHERE feed_fts MATCH ? AND feed_fts.org_id = ? ORDER BY rank LIMIT ${fetchCap}`,
        match,
        ctx.orgId
      );
      for (const r of rows) candidates.push({ type: "feed", key: String(r.key), score: -r.rank, snippet: r.snip });
    } else {
      const rows = await all<{ key: string }>(
        ctx,
        `SELECT id AS key FROM feed WHERE org_id = ? ORDER BY created_at DESC, id DESC LIMIT ${fetchCap}`,
        ctx.orgId
      );
      for (const r of rows) candidates.push({ type: "feed", key: String(r.key), score: 0, snippet: "" });
    }
  }

  if (types.includes("decision") && !docsOnly) {
    if (match) {
      const rows = await all<{ key: string; rank: number; snip: string }>(
        ctx,
        `SELECT adr_id AS key, bm25(adrs_fts, 1.0, 5.0, 1.0, 1.0, 1.0) AS rank,
                snippet(adrs_fts, -1, ${SNIPPET}) AS snip
         FROM adrs_fts WHERE adrs_fts MATCH ? AND adrs_fts.org_id = ? ORDER BY rank LIMIT ${fetchCap}`,
        match,
        ctx.orgId
      );
      for (const r of rows) candidates.push({ type: "decision", key: String(r.key), score: -r.rank, snippet: r.snip });
    } else {
      const rows = await all<{ key: string }>(
        ctx,
        `SELECT id AS key FROM adrs WHERE org_id = ? ORDER BY created_at DESC, id DESC LIMIT ${fetchCap}`,
        ctx.orgId
      );
      for (const r of rows) candidates.push({ type: "decision", key: String(r.key), score: 0, snippet: "" });
    }
  }

  // Roadmap: one FTS pass over roadmap_fts (plan + sprints, keyed by `ref`).
  // section/space filters are doc-only, so sprint drops out under docsOnly.
  if (types.includes("sprint") && !docsOnly) {
    if (match) {
      const rows = await all<{ key: string; rank: number; snip: string }>(
        ctx,
        `SELECT ref AS key, bm25(roadmap_fts, 1.0, 5.0, 1.0) AS rank,
                snippet(roadmap_fts, -1, ${SNIPPET}) AS snip
         FROM roadmap_fts WHERE roadmap_fts MATCH ? AND roadmap_fts.org_id = ? ORDER BY rank LIMIT ${fetchCap}`,
        match,
        ctx.orgId
      );
      for (const r of rows) candidates.push({ type: "sprint", key: String(r.key), score: -r.rank, snippet: r.snip });
    } else {
      // Browse: the plan row first (only when it carries a narrative), then
      // sprints by recency (updated_at, then created_at).
      const planRow = await first<PlanRow>(ctx, `SELECT * FROM plan WHERE org_id = ?`, ctx.orgId);
      if (planRow && planRow.narrative.trim() !== "") {
        candidates.push({ type: "sprint", key: "plan", score: 0, snippet: "" });
      }
      const rows = await all<{ key: number }>(
        ctx,
        `SELECT id AS key FROM sprints WHERE org_id = ?
         ORDER BY (updated_at IS NULL), updated_at DESC, created_at DESC, id DESC LIMIT ${fetchCap}`,
        ctx.orgId
      );
      for (const r of rows) candidates.push({ type: "sprint", key: `sprint:${r.key}`, score: 0, snippet: "" });
    }
  }

  // Artifacts: the repository's own reads, which apply the visibility rule (and hide
  // version-0 pages). section/space are doc-only, so artifacts drop out under docsOnly.
  if (types.includes("artifact") && !docsOnly) {
    if (match) {
      const hits = fetchCap > 0 ? await searchArtifacts(ctx, req.q ?? "", artifactViewer, fetchCap) : [];
      for (const h of hits) candidates.push({ type: "artifact", key: String(h.id), score: -h.rank, snippet: h.snippet });
    } else {
      const pages = (await listPages(ctx, {}, artifactViewer)).slice(0, fetchCap);
      for (const p of pages) candidates.push({ type: "artifact", key: String(p.id), score: 0, snippet: "" });
    }
  }

  // 2. Hydrate base rows in bulk (one round-trip per type per CHUNK — `fetchCap`
  //    reaches 150, so every key list here can outgrow D1's 100-param ceiling),
  //    then assemble.
  const docKeys = candidates.filter((c) => c.type === "doc").map((c) => c.key);
  const feedKeys = candidates.filter((c) => c.type === "feed").map((c) => Number(c.key));
  const adrKeys = candidates.filter((c) => c.type === "decision").map((c) => Number(c.key));

  const docMap = new Map<string, DocRow>();
  const stagedMap = new Map<string, DocVersionRow[]>();
  for (const d of await fanOut<DocRow>(ctx, docKeys, (p) => `SELECT * FROM docs WHERE org_id = ? AND slug IN (${p})`, [ctx.orgId])) docMap.set(d.slug, d);
  for (const v of await fanOut<DocVersionRow>(
    ctx,
    docKeys,
    (p) => `SELECT * FROM doc_versions WHERE org_id = ? AND status = 'staged' AND slug IN (${p}) ORDER BY version ASC`,
    [ctx.orgId]
  )) {
    const list = stagedMap.get(v.slug) ?? [];
    list.push(v);
    stagedMap.set(v.slug, list);
  }

  const feedMap = new Map<string, FeedRow>();
  for (const f of await fanOut<FeedRow>(ctx, feedKeys, (p) => `SELECT * FROM feed WHERE org_id = ? AND id IN (${p})`, [ctx.orgId])) feedMap.set(String(f.id), f);

  const adrMap = new Map<string, AdrRow>();
  for (const a of await fanOut<AdrRow>(ctx, adrKeys, (p) => `SELECT * FROM adrs WHERE org_id = ? AND id IN (${p})`, [ctx.orgId])) adrMap.set(String(a.id), a);

  // Roadmap hydration: sprint ids (from 'sprint:<id>' refs) + the plan flag.
  const sprintIds = candidates
    .filter((c) => c.type === "sprint" && c.key.startsWith("sprint:"))
    .map((c) => Number(c.key.slice("sprint:".length)));
  const needPlan = candidates.some((c) => c.type === "sprint" && c.key === "plan");

  const sprintMap = new Map<string, SprintRow>();
  for (const sp of await fanOut<SprintRow>(ctx, sprintIds, (p) => `SELECT * FROM sprints WHERE org_id = ? AND id IN (${p})`, [ctx.orgId])) {
    sprintMap.set(`sprint:${sp.id}`, sp);
  }
  // The progress line is TICKETS ONLY, for the hydrated sprints only — one
  // grouped query, sharing `sprintProgress`'s definition of "closed". The
  // `sprint_progress` cache is deliberately NOT read here.
  const sprintTicketCounts = await ticketCountsBySprint(ctx, sprintIds);
  const planRow = needPlan ? await first<PlanRow>(ctx, `SELECT * FROM plan WHERE org_id = ?`, ctx.orgId) : null;

  // Artifact hydration: each candidate page joined to its current version. The ids
  // came from visibility-checked reads; the rule is repeated here as a guard anyway.
  const artifactKeys = candidates.filter((c) => c.type === "artifact").map((c) => Number(c.key));
  const artifactMap = new Map<string, ArtifactHydrateRow>();
  for (const r of await fanOut<ArtifactHydrateRow>(
    ctx,
    artifactKeys,
    (p) => `SELECT p.id, p.slug, p.title, p.kind, p.area, p.repo, p.status, p.author_id, p.current_version, p.updated_at,
                   v.content, v.summary, v.content_type, v.size_bytes, v.created_by
              FROM artifact_pages p
              JOIN artifact_versions v ON v.page_id = p.id AND v.version_no = p.current_version AND v.org_id = ?
             WHERE p.org_id = ? AND (p.visibility = 'org' OR p.author_id = ? COLLATE NOCASE) AND p.deleted_at IS NULL AND p.id IN (${p})`,
    [ctx.orgId, ctx.orgId, artifactViewer]
  )) artifactMap.set(String(r.id), r);

  // Browse mode carries no per-row score, so order is by the merged recency from
  // step 1; FTS mode already has a normalized score. Sort once by score desc and,
  // for browse ties (all 0), keep the stable per-type recency order via index.
  const ordered = candidates
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (b.c.score - a.c.score) || (a.i - b.i));

  const assembled: Assembled[] = [];
  for (const { c } of ordered) {
    let a: Assembled | null = null;
    if (c.type === "doc") {
      const doc = docMap.get(c.key);
      if (!doc) continue;
      const staged = stagedMap.get(c.key) ?? [];
      const latest = staged.length ? staged[staged.length - 1] : null;
      let authority: Authority;
      let body = doc.body;
      let pendingVersion: number | null = null;
      let stagedBody: string | null = null;
      let confidence: string | null = null;
      if (doc.current_version === 0) {
        authority = "unpromoted"; // never promoted — its only content lives in a staged version
        if (latest) { body = latest.body; confidence = latest.confidence; }
      } else {
        const pending = staged.filter((v) => v.version > doc.current_version);
        const top = pending.length ? pending[pending.length - 1] : null;
        if (top) {
          authority = "staged_pending"; // live body stands; a newer version awaits promotion
          pendingVersion = top.version;
          confidence = top.confidence;
          stagedBody = includeStaged ? top.body : null;
        } else {
          authority = "live";
        }
      }
      a = {
        type: "doc", id: doc.slug, title: doc.title, section: doc.section, space: doc.space,
        body, authority, current_version: doc.current_version, pending_version: pendingVersion,
        staged_body: stagedBody, confidence, updated_at: doc.updated_at, updated_by: doc.updated_by,
        score: c.score, snippet: c.snippet || browseSnippet(body),
      };
    } else if (c.type === "feed") {
      const f = feedMap.get(c.key);
      if (!f) continue;
      a = {
        type: "feed", id: String(f.id), title: f.summary, section: null, space: null,
        body: f.brief ? `Brief: ${f.brief}\n\n${f.body ?? ""}` : f.body ?? "", authority: "live", current_version: null, pending_version: null,
        staged_body: null, confidence: null, updated_at: f.created_at, updated_by: f.author,
        score: c.score, snippet: c.snippet || browseSnippet(f.brief ?? f.body),
      };
    } else if (c.type === "decision") {
      const adr = adrMap.get(c.key);
      if (!adr) continue;
      const body = assembleAdrBody(adr);
      a = {
        type: "decision", id: String(adr.id), title: adr.title, section: null, space: null,
        body, authority: adr.status === "ratified" ? "live" : "draft",
        current_version: null, pending_version: null, staged_body: null, confidence: adr.confidence,
        updated_at: adr.created_at, updated_by: adr.created_by,
        score: c.score, snippet: c.snippet || browseSnippet(body),
      };
    } else if (c.type === "artifact") {
      const art = artifactMap.get(c.key);
      if (!art) continue;
      const body = assembleArtifactBody(art);
      // id is the SLUG — what artifact_get and #artifacts/<slug> take.
      a = {
        type: "artifact", id: art.slug, title: art.title, section: null, space: null,
        body, authority: art.status === "draft" ? "draft" : "live",
        current_version: art.current_version, pending_version: null, staged_body: null, confidence: null,
        updated_at: art.updated_at, updated_by: art.created_by,
        score: c.score, snippet: c.snippet || browseSnippet(art.summary || body),
      };
    } else {
      // sprint: either the plan singleton (ref 'plan') or a sprint row.
      // Both are direct/authored writes, so always authority "live".
      if (c.key === "plan") {
        if (!planRow) continue;
        a = {
          type: "sprint", id: "plan", title: "Roadmap plan", section: null, space: null,
          body: planRow.narrative, authority: "live", current_version: null, pending_version: null,
          staged_body: null, confidence: null, updated_at: planRow.updated_at, updated_by: planRow.updated_by,
          score: c.score, snippet: c.snippet || browseSnippet(planRow.narrative),
        };
      } else {
        const sp = sprintMap.get(c.key);
        if (!sp) continue;
        const body = assembleSprintBody(sp, sprintTicketCounts.get(sp.id));
        a = {
          type: "sprint", id: `sprint:${sp.id}`, title: sp.title, section: null, space: null,
          body, authority: "live", current_version: null, pending_version: null,
          staged_body: null, confidence: null, updated_at: sp.updated_at ?? sp.created_at, updated_by: sp.created_by,
          score: c.score, snippet: c.snippet || browseSnippet(body),
        };
      }
    }
    // Human (include_staged false) never surfaces not-yet-settled content: drop
    // unpromoted (empty-live) docs and unratified (draft) decisions entirely.
    if (!includeStaged && (a.authority === "unpromoted" || a.authority === "draft")) continue;
    assembled.push(a);
  }

  const primary: QueryPrimary[] = assembled.slice(0, limit).map((a) => ({
    type: a.type, id: a.id, title: a.title, section: a.section, space: a.space,
    body: a.body, authority: a.authority, current_version: a.current_version,
    pending_version: a.pending_version, staged_body: a.staged_body, confidence: a.confidence,
    updated_at: a.updated_at, updated_by: a.updated_by, score: a.score,
  }));

  const pointers: QueryPointer[] = assembled.slice(limit, limit + pointerLimit).map((a) => ({
    type: a.type, id: a.id, title: a.title, snippet: a.snippet, authority: a.authority, score: a.score,
  }));

  return { primary, pointers, meta: { engine: "fts5", total: primary.length + pointers.length } };
}

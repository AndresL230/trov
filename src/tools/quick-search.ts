// The "search everything" dropdown's read (GET /search/quick → quickSearch).
//
// A jump list, not the Search screen: per type a SMALL ranked lookup that returns a
// title and one short excerpt — never a body — so the whole answer is a few KB and
// every lookup is bounded by a LIMIT. All of them run in ONE `batch` (one D1 round
// trip), and a query with fewer than QUICK_MIN_CHARS characters (or nothing
// matchable in it) returns no groups WITHOUT touching D1: the panel's Screens list is
// static and lives in the SPA.
//
// What is covered, and the visibility rule each obeys (the viewer is the session
// principal; this is the HUMAN reading, so it is live-only like GET /search):
//   ticket   — tickets_fts (+ an exact `#12` / `12` id hit). Org-wide, always live.
//   doc      — docs_fts over the LIVE body; a never-promoted doc (current_version 0)
//              is withheld, exactly as /search drops `unpromoted`.
//   decision — adrs_fts; ratified only (/search drops `draft`).
//   sprint   — roadmap_fts (the plan narrative + sprints). Authored, always live.
//   artifact — `searchArtifactsStmt` (src/tools/artifacts.ts), which owns THE
//              visibility rule: a private page reaches only its author, a page whose
//              upload never landed reaches no one; drafts dropped (live-only).
//   prompt   — prompts_fts; only a prompt with at least one PUBLISHED version (a
//              prompt that is still only a draft or an agent's staged proposal is
//              not settled), and never a soft-deleted one (0035 PART C — prompts_fts
//              drops it too). The context line is its description, not the body.
//   handoff  — no FTS: a LIKE over the viewer's OWN handoffs (the union of the
//              inbox's boxes — left for me, left for anyone, or sent by me), pending
//              or claimed. A small, bounded set; one statement.
//   person   — the org's MEMBERS by handle / name prefix; reserved system handles never listed.
//   feed     — feed_fts. Always live.
//
// FTS input is never passed through: `buildPrefixMatch` keeps word characters only
// and quotes every token, so operators, quotes and parentheses typed by a person are
// just text and can never be a syntax error (a 500).

import { type TenantContext, type Stmt, stmt, batch } from "../data/sql";
import { legacyDb } from "../data/legacy";
import { RESERVED_HANDLES } from "../auth/persons";
import { searchArtifactsStmt } from "./artifacts";
import { legacyCtxOf } from "../data/legacy-ctx";
import { avatarSrc } from "@shared/people";
import {
  QUICK_TYPES, QUICK_MIN_CHARS, QUICK_LIMIT_DEFAULT, QUICK_LIMIT_MAX,
  type QuickHit, type QuickType, type QuickSearchResult,
} from "@shared/quick-search";

/** Word tokens of `q` (letters, digits, underscore), at most 6. */
export function quickTokens(q: string): string[] {
  return q.replace(/[^\p{L}\p{N}_]+/gu, " ").trim().split(/\s+/).filter(Boolean).slice(0, 6);
}

/**
 * A safe FTS5 MATCH expression for typeahead: every token quoted (so nothing typed is
 * ever FTS syntax) and PREFIX-matched (`"tok"*`), ANDed. The index is porter-stemmed
 * and FTS5 stems a prefix term too, so a whole word matches its stem ("searching"* →
 * search*) — but a partial word past the stem does not ("searchi"* matches nothing).
 * So the LAST token, the one being typed, also tries itself one and two characters
 * shorter (never below 4): "searchi" → ("searchi"* OR "search"* OR "searc"*).
 * Tokens are joined with an explicit AND (FTS5 rejects `"a"* ("b"* OR …)`).
 * Null when nothing matchable is left.
 */
export function buildPrefixMatch(q: string): string | null {
  const toks = quickTokens(q);
  if (!toks.length) return null;
  return toks.map((t, i) => {
    const alts = [`"${t}"*`];
    if (i === toks.length - 1) for (const k of [1, 2]) if (t.length - k >= 4) alts.push(`"${t.slice(0, -k)}"*`);
    return alts.length > 1 ? `(${alts.join(" OR ")})` : alts[0];
  }).join(" AND "); // explicit: FTS5's implicit AND is only between PHRASES, not before a (group)
}

/** A LIKE pattern for a literal substring (`\` escapes `%`, `_` and itself). */
const likeEsc = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** One line of plain text: markdown marks and runs of whitespace gone, capped. */
function oneLine(s: string | null | undefined, max = 160): string | null {
  if (!s) return null;
  const t = s.replace(/[`*#>|]+/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const firstLine = (s: string): string => (s.split("\n").find((l) => l.trim()) ?? "").trim();

const SNIP = `'', '', '…', 10`;

interface Row { [k: string]: unknown }
const str = (v: unknown): string | null => (typeof v === "string" ? v : v == null ? null : String(v));

export interface QuickSearchOpts {
  /** Per-group cap (default 4, at most 8). */
  limit?: number;
  /** Restrict to these groups (default: all). */
  types?: readonly QuickType[];
}

export async function quickSearch(ctx: TenantContext, q: string, viewer: string, opts: QuickSearchOpts = {}): Promise<QuickSearchResult> {
  const raw = (q ?? "").slice(0, 200);
  const trimmed = raw.trim();
  const out: QuickSearchResult = { q: trimmed, groups: [] };
  if (trimmed.length < QUICK_MIN_CHARS) return out;
  const match = buildPrefixMatch(trimmed);
  if (!match) return out;

  const n = Math.trunc(Math.min(Math.max(opts.limit ?? QUICK_LIMIT_DEFAULT, 1), QUICK_LIMIT_MAX));
  const want = new Set<QuickType>(opts.types && opts.types.length ? opts.types : QUICK_TYPES);
  const toks = quickTokens(trimmed);
  const idMatch = /^#?(\d{1,9})$/.exec(trimmed);
  const id = idMatch ? Number(idMatch[1]) : null;

  // Each entry: the group it feeds and the statement. ONE batch runs them all.
  const plan: { type: QuickType; stmt: Stmt; map: (r: Row) => QuickHit }[] = [];

  if (want.has("ticket")) {
    const map = (r: Row): QuickHit => ({
      type: "ticket", id: String(r.id), title: str(r.title) ?? "", snippet: oneLine(str(r.snippet)),
      status: str(r.status), by: str(r.by), at: str(r.at),
    });
    // An exact number first: `#12` or `12` is how people name a ticket.
    if (id !== null) {
      plan.push({ type: "ticket", map, stmt: stmt(ctx,
        `SELECT id, title, status, requester AS by, updated_at AS at, NULL AS snippet FROM tickets WHERE id = ? AND org_id = ?`, id, ctx.orgId) });
    }
    plan.push({ type: "ticket", map, stmt: stmt(ctx,
      `SELECT t.id, t.title, t.status, t.requester AS by, t.updated_at AS at, snippet(tickets_fts, 2, ${SNIP}) AS snippet
         FROM tickets_fts JOIN tickets t ON t.id = CAST(tickets_fts.ticket_id AS INTEGER) AND t.org_id = ?
        WHERE tickets_fts MATCH ? AND tickets_fts.org_id = ? ORDER BY bm25(tickets_fts, 1.0, 5.0, 1.0) LIMIT ${n}`, ctx.orgId, match, ctx.orgId) });
  }

  if (want.has("doc")) {
    plan.push({ type: "doc", stmt: stmt(ctx,
      `SELECT d.slug AS id, d.title, d.section, d.updated_at AS at, d.updated_by AS by, snippet(docs_fts, 3, ${SNIP}) AS snippet
         FROM docs_fts JOIN docs d ON d.slug = docs_fts.slug AND d.org_id = ?
        WHERE docs_fts MATCH ? AND docs_fts.org_id = ? AND d.current_version > 0
        ORDER BY bm25(docs_fts, 1.0, 5.0, 1.0, 1.0) LIMIT ${n}`, ctx.orgId, match, ctx.orgId),
      map: (r) => ({ type: "doc", id: str(r.id) ?? "", title: str(r.title) ?? "", snippet: oneLine(str(r.snippet)), status: str(r.section), by: str(r.by), at: str(r.at) }) });
  }

  if (want.has("decision")) {
    plan.push({ type: "decision", stmt: stmt(ctx,
      `SELECT a.id, a.title, a.created_by AS by, a.created_at AS at, snippet(adrs_fts, 3, ${SNIP}) AS snippet
         FROM adrs_fts JOIN adrs a ON a.id = CAST(adrs_fts.adr_id AS INTEGER) AND a.org_id = ?
        WHERE adrs_fts MATCH ? AND adrs_fts.org_id = ? AND a.status = 'ratified'
        ORDER BY bm25(adrs_fts, 1.0, 5.0, 1.0, 1.0, 1.0) LIMIT ${n}`, ctx.orgId, match, ctx.orgId),
      map: (r) => ({ type: "decision", id: String(r.id), title: str(r.title) ?? "", snippet: oneLine(str(r.snippet)), status: "ratified", by: str(r.by), at: str(r.at) }) });
  }

  if (want.has("sprint")) {
    plan.push({ type: "sprint", stmt: stmt(ctx,
      `SELECT roadmap_fts.ref AS id, roadmap_fts.title AS title, snippet(roadmap_fts, 2, ${SNIP}) AS snippet,
              s.status AS status, COALESCE(s.updated_at, s.created_at) AS at
         FROM roadmap_fts
         LEFT JOIN sprints s ON roadmap_fts.ref LIKE 'sprint:%' AND s.id = CAST(substr(roadmap_fts.ref, 8) AS INTEGER) AND s.org_id = ?
        WHERE roadmap_fts MATCH ? AND roadmap_fts.org_id = ? ORDER BY bm25(roadmap_fts, 1.0, 5.0, 1.0) LIMIT ${n}`, ctx.orgId, match, ctx.orgId),
      map: (r) => ({ type: "sprint", id: str(r.id) ?? "", title: str(r.title) ?? "", snippet: oneLine(str(r.snippet)), status: str(r.status), by: null, at: str(r.at) }) });
  }

  if (want.has("artifact")) {
    plan.push({ type: "artifact", stmt: searchArtifactsStmt(ctx, match, viewer, n, true),
      map: (r) => ({ type: "artifact", id: str(r.slug) ?? "", title: str(r.title) ?? "", snippet: oneLine(str(r.description)) ?? oneLine(str(r.snippet)), status: str(r.kind), by: str(r.author_id), at: str(r.updated_at) }) });
  }

  if (want.has("prompt")) {
    plan.push({ type: "prompt", stmt: stmt(ctx,
      `SELECT p.slug AS id, p.title, p.description, p.author AS by, p.updated_at AS at, v.status AS status,
              snippet(prompts_fts, 3, ${SNIP}) AS snippet
         FROM prompts_fts JOIN prompts p ON p.slug = prompts_fts.slug AND p.org_id = ?
         LEFT JOIN prompt_versions v ON v.slug = p.slug AND v.version = p.current_version AND v.org_id = ?
        WHERE prompts_fts MATCH ? AND prompts_fts.org_id = ?
          AND p.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM prompt_versions pv WHERE pv.org_id = ? AND pv.slug = p.slug AND pv.status = 'published')
        ORDER BY bm25(prompts_fts, 2.0, 5.0, 1.0, 1.0, 1.0) LIMIT ${n}`, ctx.orgId, ctx.orgId, match, ctx.orgId, ctx.orgId),
      map: (r) => ({ type: "prompt", id: str(r.id) ?? "", title: str(r.title) ?? "", snippet: oneLine(str(r.description)), status: str(r.status), by: str(r.by), at: str(r.at) }) });
  }

  if (want.has("handoff") && viewer) {
    // Every token must appear in the message, its inline prompt's title, or the
    // context's task / repo / branch — not in the JSON's own key names.
    const hay = `(h.body || ' ' || COALESCE(h.prompt_title, '') || ' ' || COALESCE(json_extract(h.context, '$.task'), '')
                  || ' ' || COALESCE(json_extract(h.context, '$.repo'), '') || ' ' || COALESCE(json_extract(h.context, '$.branch'), ''))`;
    const likes = toks.map(() => `${hay} LIKE ? ESCAPE '\\'`).join(" AND ");
    plan.push({ type: "handoff", stmt: stmt(ctx,
      `SELECT h.id, h.sender, h.recipient, h.status, h.body, h.created_at AS at, json_extract(h.context, '$.task') AS task
         FROM handoffs h
        WHERE h.org_id = ? AND h.status IN ('pending', 'claimed')
          AND (h.recipient = ? COLLATE NOCASE OR h.sender = ? COLLATE NOCASE OR h.recipient = 'anyone')
          AND ((${likes})${id !== null ? " OR h.id = ?" : ""})
        ORDER BY (h.status = 'pending') DESC, h.created_at DESC LIMIT ${n}`,
      ctx.orgId, viewer, viewer, ...toks.map((t) => `%${likeEsc(t)}%`), ...(id !== null ? [id] : [])),
      map: (r) => {
        const to = str(r.recipient) ?? "";
        const task = oneLine(str(r.task), 100);
        return {
          type: "handoff", id: String(r.id), title: oneLine(firstLine(str(r.body) ?? ""), 120) ?? `Handoff #${r.id}`,
          snippet: `@${str(r.sender)} → ${to === "anyone" ? "anyone" : `@${to}`}${task ? ` · ${task}` : ""}`,
          status: str(r.status), by: str(r.sender), at: str(r.at),
        };
      } });
  }

  if (want.has("person")) {
    // The whole query (an @ dropped) as a prefix of the handle, the name, or any word of the name.
    const whole = likeEsc(trimmed.replace(/^@/, "").replace(/\s+/g, " "));
    plan.push({ type: "person", stmt: stmt(ctx,
      `SELECT handle, name, color, avatar_url, avatar_sha, role FROM persons
        WHERE handle NOT IN (${RESERVED_HANDLES.map(() => "?").join(", ")})
          AND EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = ? AND m.user_id = persons.handle COLLATE NOCASE)
          AND (handle LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')
        ORDER BY (handle LIKE ? ESCAPE '\\') DESC, handle COLLATE NOCASE LIMIT ${n}`,
      ...RESERVED_HANDLES, ctx.orgId, `${whole}%`, `${whole}%`, `% ${whole}%`, `${whole}%`),
      map: (r) => ({ type: "person", id: str(r.handle) ?? "", title: str(r.name) || (str(r.handle) ?? ""), snippet: str(r.role), status: null, by: null, at: null, color: str(r.color), avatar_url: avatarSrc({ avatar_sha: str(r.avatar_sha), avatar_url: str(r.avatar_url) }) }) });
  }

  if (want.has("feed")) {
    plan.push({ type: "feed", stmt: stmt(ctx,
      `SELECT f.id, f.summary AS title, f.brief, f.author AS by, f.created_at AS at, snippet(feed_fts, 2, ${SNIP}) AS snippet
         FROM feed_fts JOIN feed f ON f.id = CAST(feed_fts.feed_id AS INTEGER) AND f.org_id = ?
        WHERE feed_fts MATCH ? AND feed_fts.org_id = ? ORDER BY bm25(feed_fts, 1.0, 5.0, 1.0) LIMIT ${n}`, ctx.orgId, match, ctx.orgId),
      map: (r) => ({ type: "feed", id: String(r.id), title: str(r.title) ?? "", snippet: oneLine(str(r.brief)) ?? oneLine(str(r.snippet)), status: null, by: str(r.by), at: str(r.at) }) });
  }

  if (!plan.length) return out;
  const results = await batch<Row>(ctx, plan.map((p) => p.stmt));

  const byType = new Map<QuickType, QuickHit[]>();
  plan.forEach((p, i) => {
    const list = byType.get(p.type) ?? [];
    for (const r of results[i]?.results ?? []) {
      const h = p.map(r);
      if (list.length < n && !list.some((x) => x.id === h.id)) list.push(h);
    }
    byType.set(p.type, list);
  });
  for (const type of QUICK_TYPES) {
    const hits = byType.get(type);
    if (hits && hits.length) out.groups.push({ type, hits });
  }
  return out;
}

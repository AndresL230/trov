// Sprint writers + the sprint read model — DIRECT AUTHORED WRITES, promote class.
//
// A sprint is the container the Roadmap shows: it holds tickets (0024) and,
// through `github_ref`, a set of GitHub issues whose closed/total counts are
// cached event-side in `sprint_progress`. Nothing in this file goes through
// `consume()` / the ingestion gate — a sprint is created and reshaped by a
// signed-in human over a cookie route, or by the admin plan write
// (`update_plan` → `write_plan` in plan.ts). `status: 'done'` is set ONLY by
// `complete_sprint` (the Confirm-done button) or the plan write — never inferred
// from tickets resolving or issues closing.
//
// TWO VOCABULARIES. The DB keeps `title` / `target_date` / `start_date`; every DTO
// here speaks `label` / `due` / `start` / `active` (shared/sprints.ts documents the seam, and
// `toSprintView` is the one translation). Column names never leave this file.
//
// THE PROGRESS RULE (one place, `sprintProgress` below): a sprint's progress is
// its OWN TICKETS, and nothing else —
//   total  = tickets in the sprint
//   closed = tickets done OR declined
// A sprint with no tickets reads 0/0. The GitHub issues behind a sprint are a
// SEPARATE field (`SprintView.issues`), read from the `sprint_progress` cache
// through `github_ref` and shown only in the Roadmap's Narrative spotlight; they
// are never folded into `progress`. Both halves are read-only D1 — there is NO
// live GitHub call at render, here or anywhere on the read path.

import type { SprintRow, SprintProgressRow, TicketRow } from "@shared/rows";
import {
  toSprintView,
  type SprintCreate,
  type SprintView,
  type SprintDetail,
  type SprintProgress,
  type SprintIssueCounts,
  type SprintTicketRow,
  type SprintResourceView,
} from "@shared/sprints";
import { normalizeSprintDate, sprintDatesProblem } from "@shared/sprints-core";
import { parseTicketLink } from "@shared/tickets";
import { type DB, first, all, run, nowIso, ph, fanOut } from "../db";
import { getProgress } from "./progress";

/**
 * A typed failure the sprint routes map onto an HTTP status — the same three
 * codes `TicketError` uses, kept as its own class so a sprint failure is never
 * mistaken for a ticket one in a stack trace.
 *   not_found   → 404 (unknown sprint)
 *   conflict    → 409 (a rule the caller broke)
 *   bad_request → 400 (an unusable link)
 * Anything that is NOT a SprintError re-throws and stays a real 500.
 */
export class SprintError extends Error {
  constructor(readonly code: "not_found" | "conflict" | "bad_request", message: string) {
    super(message);
    this.name = "SprintError";
  }
}

export const SPRINT_ERROR_STATUS = { not_found: 404, conflict: 409, bad_request: 400 } as const;

/** Ticket statuses that count as "closed" for progress — a person resolved them, either way. */
const CLOSED_TICKET_STATUSES = ["done", "declined"] as const;

// ── progress + members (the two computed fields on every SprintView) ──────────

export interface SprintProgressInput {
  /** Tickets whose `sprint_id` is this sprint. */
  ticketsTotal: number;
  /** Of those, the ones a person resolved (`done` or `declined`). */
  ticketsClosed: number;
}

/**
 * THE progress function (§C.8). TICKETS ONLY — the cached GitHub issue counts
 * are NOT an input here; they travel separately as `SprintView.issues`. Pure:
 * no DB, no clock. `pct` is rounded; 0/0 yields `pct: 0` rather than NaN.
 */
export function sprintProgress({ ticketsTotal, ticketsClosed }: SprintProgressInput): SprintProgress {
  return {
    closed: ticketsClosed,
    total: ticketsTotal,
    pct: ticketsTotal > 0 ? Math.round((100 * ticketsClosed) / ticketsTotal) : 0,
  };
}

/** The GitHub half: the cache row for a sprint, or null when it has none.
 *  A sprint with no `github_ref` never gets a cache row, so this is null for it. */
export const sprintIssueCounts = (cache: SprintProgressRow | undefined | null): SprintIssueCounts | null =>
  cache ? { closed: cache.closed, total: cache.total } : null;

/**
 * Per-sprint ticket counts, in ONE grouped query (never per sprint). Pass `ids`
 * to scope it to a known set — that is how `query()` in reads.ts costs the
 * ticket half of the progress line for just the sprints it hydrated, without
 * re-declaring which statuses count as closed. A scoped call chunks the id list
 * (D1's 100-bound-parameter ceiling — see `fanOut` in src/db.ts).
 */
export async function ticketCountsBySprint(
  db: DB,
  ids?: number[]
): Promise<Map<number, { total: number; closed: number }>> {
  if (ids && ids.length === 0) return new Map();
  const select = (scope: string) =>
    `SELECT sprint_id,
            COUNT(*) AS total,
            SUM(CASE WHEN status IN (${ph(CLOSED_TICKET_STATUSES.length)}) THEN 1 ELSE 0 END) AS closed
       FROM tickets WHERE sprint_id IS NOT NULL${scope} GROUP BY sprint_id`;
  type CountRow = { sprint_id: number; total: number; closed: number };
  const rows = ids
    ? await fanOut<CountRow>(db, ids, (p) => select(` AND sprint_id IN (${p})`), [...CLOSED_TICKET_STATUSES])
    : await all<CountRow>(db, select(""), ...CLOSED_TICKET_STATUSES);
  return new Map(rows.map((r) => [r.sprint_id, { total: r.total, closed: r.closed }]));
}

/**
 * Distinct assignee handles per sprint, in ONE grouped query. Order is `login
 * ASC` — stable and independent of ticket order, so the Roadmap card's avatar
 * row does not reshuffle when a ticket is touched.
 */
async function membersBySprint(db: DB): Promise<Map<number, string[]>> {
  const rows = await all<{ sprint_id: number; login: string }>(
    db,
    `SELECT DISTINCT t.sprint_id AS sprint_id, a.login AS login
       FROM tickets t JOIN ticket_assignees a ON a.ticket_id = t.id
      WHERE t.sprint_id IS NOT NULL
      ORDER BY t.sprint_id ASC, a.login ASC`
  );
  const out = new Map<number, string[]>();
  for (const r of rows) {
    const list = out.get(r.sprint_id) ?? [];
    list.push(r.login);
    out.set(r.sprint_id, list);
  }
  return out;
}

/** The distinct assignee handles over ONE sprint's tickets (login ASC). */
export async function sprintMembers(db: DB, sprintId: number): Promise<string[]> {
  const rows = await all<{ login: string }>(
    db,
    `SELECT DISTINCT a.login AS login
       FROM tickets t JOIN ticket_assignees a ON a.ticket_id = t.id
      WHERE t.sprint_id = ? ORDER BY a.login ASC`,
    sprintId
  );
  return rows.map((r) => r.login);
}

// ── reads ────────────────────────────────────────────────────────────────────

// target_date is NOT NULL but may be '' (an unscheduled sprint — see
// create_sprint), so the blank goes LAST rather than sorting to the top as ''
// naturally would. Same key everywhere a sprint list is produced.
const SPRINT_ORDER = `ORDER BY CASE WHEN target_date IS NULL OR target_date = '' THEN 1 ELSE 0 END ASC, target_date ASC, id ASC`;

/**
 * Every sprint, in roadmap order, each with its TICKET progress, its cached
 * GitHub issue counts and its real member list. FOUR queries total regardless of
 * how many sprints exist: the rows, the grouped ticket counts, the grouped
 * assignees, the progress cache. No N+1.
 */
export async function list_sprints(db: DB): Promise<SprintView[]> {
  const rows = await all<SprintRow>(db, `SELECT * FROM sprints ${SPRINT_ORDER}`);
  if (rows.length === 0) return [];

  const counts = await ticketCountsBySprint(db);
  const members = await membersBySprint(db);
  const cache = await getProgress(db);

  return rows.map((row) => viewOf(row, counts.get(row.id), cache.get(row.id), members.get(row.id) ?? []));
}

/** Assemble one SprintView from a row + its three computed inputs. The cache row
 *  becomes `issues` — it is NEVER folded into `progress`. */
function viewOf(
  row: SprintRow,
  counts: { total: number; closed: number } | undefined,
  cache: SprintProgressRow | undefined,
  members: string[]
): SprintView {
  const progress = sprintProgress({
    ticketsTotal: counts?.total ?? 0,
    ticketsClosed: counts?.closed ?? 0,
  });
  // toSprintView re-derives pct from closed/total with the same formula, so the
  // two can never disagree; sprintProgress stays the one place the RULE lives.
  return toSprintView(row, { closed: progress.closed, total: progress.total }, members, sprintIssueCounts(cache));
}

/** One sprint's row, or a 404-shaped throw. */
async function requireSprint(db: DB, id: number): Promise<SprintRow> {
  const sp = await first<SprintRow>(db, `SELECT * FROM sprints WHERE id = ?`, id);
  if (!sp) throw new SprintError("not_found", `no such sprint: ${id}`);
  return sp;
}

/** One sprint as a view (used by every writer's response). */
async function viewFor(db: DB, id: number): Promise<SprintView> {
  const row = await requireSprint(db, id);
  const counts = await first<{ total: number; closed: number }>(
    db,
    `SELECT COUNT(*) AS total, SUM(CASE WHEN status IN (${ph(CLOSED_TICKET_STATUSES.length)}) THEN 1 ELSE 0 END) AS closed
       FROM tickets WHERE sprint_id = ?`,
    ...CLOSED_TICKET_STATUSES,
    id
  );
  const cache = await first<SprintProgressRow>(db, `SELECT * FROM sprint_progress WHERE sprint_id = ?`, id);
  const members = await sprintMembers(db, id);
  return viewOf(row, counts ? { total: counts.total, closed: counts.closed ?? 0 } : undefined, cache ?? undefined, members);
}

/**
 * One sprint, whole: the view plus its ticket list and its resources.
 *
 * TICKET ORDER — roots, then each root's own children directly under it:
 *   - a ROOT is a ticket with no parent, OR one whose parent is NOT in this
 *     sprint (the parent is invisible here, so the child cannot hang off it);
 *     roots are ordered `updated_at DESC` (id DESC as the tiebreak).
 *   - a CHILD is an in-sprint ticket whose parent is also in this sprint; it is
 *     emitted immediately after its root, `updated_at DESC`, with `depth: 1`.
 * Tickets nest exactly one level, so this is the whole tree.
 *
 * RESOURCES — the sprint's own `sprint_resources` rows FIRST, then the links of
 * the sprint's tickets in the ticket order above, deduped by url with the first
 * occurrence winning (so a url attached to both the sprint and a ticket shows
 * once, as the sprint's).
 */
export async function get_sprint(db: DB, id: number): Promise<SprintDetail | null> {
  const row = await first<SprintRow>(db, `SELECT * FROM sprints WHERE id = ?`, id);
  if (!row) return null;

  const inSprint = await all<TicketRow>(
    db,
    `SELECT * FROM tickets WHERE sprint_id = ? ORDER BY updated_at DESC, id DESC`,
    id
  );
  const present = new Set(inSprint.map((t) => t.id));

  // Per-ticket assignees, in ONE grouped query per chunk (the design's stacked
  // avatars on a sprint's ticket rows, line 514) — never a lookup per row.
  const asgRows = await fanOut<{ ticket_id: number; login: string }>(
    db,
    inSprint.map((t) => t.id),
    (p) => `SELECT ticket_id, login FROM ticket_assignees WHERE ticket_id IN (${p}) ORDER BY login ASC`
  );
  const asgByTicket = new Map<number, string[]>();
  for (const a of asgRows) {
    const list = asgByTicket.get(a.ticket_id) ?? [];
    list.push(a.login);
    asgByTicket.set(a.ticket_id, list);
  }
  const withAsg = (t: TicketRow, depth: 0 | 1): SprintTicketRow => ({ ...t, depth, assignees: asgByTicket.get(t.id) ?? [] });

  const ordered: SprintTicketRow[] = [];
  for (const t of inSprint) {
    if (t.parent_id !== null && present.has(t.parent_id)) continue; // emitted under its root below
    ordered.push(withAsg(t, 0));
    for (const child of inSprint) {
      if (child.parent_id === t.id) ordered.push(withAsg(child, 1));
    }
  }

  const own = await all<SprintResourceView>(
    db,
    `SELECT url, kind, label, meta FROM sprint_resources WHERE sprint_id = ? ORDER BY id ASC`,
    id
  );
  const ticketIds = ordered.map((t) => t.id);
  // Chunked: a sprint can hold more tickets than D1 allows bound params.
  const linkRows = await fanOut<SprintResourceView & { ticket_id: number }>(
    db,
    ticketIds,
    (p) => `SELECT ticket_id, url, kind, label, meta FROM ticket_links WHERE ticket_id IN (${p})
             ORDER BY created_at ASC, id ASC`
  );
  const linksByTicket = new Map<number, SprintResourceView[]>();
  for (const l of linkRows) {
    const list = linksByTicket.get(l.ticket_id) ?? [];
    list.push({ url: l.url, kind: l.kind, label: l.label, meta: l.meta });
    linksByTicket.set(l.ticket_id, list);
  }

  const resources: SprintResourceView[] = [];
  const seen = new Set<string>();
  for (const r of [...own, ...ticketIds.flatMap((tid) => linksByTicket.get(tid) ?? [])]) {
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    resources.push({ url: r.url, kind: r.kind, label: r.label, meta: r.meta });
  }

  const closed = ordered.filter((t) => t.status === "done" || t.status === "declined").length;
  const cache = await first<SprintProgressRow>(db, `SELECT * FROM sprint_progress WHERE sprint_id = ?`, id);
  const members = await sprintMembers(db, id);
  const view = viewOf(row, { total: ordered.length, closed }, cache ?? undefined, members);

  return { ...view, tickets: ordered, resources };
}

// ── writers ──────────────────────────────────────────────────────────────────

/**
 * Create a sprint from the Roadmap's New sprint panel. It lands **inactive and
 * unscheduled**: `status: 'upcoming'` (so `active` is false), `phase` defaults
 * to `'Unscheduled'` when the panel didn't pick one.
 *
 * `target_date` is NOT NULL in the schema, so a sprint created without a due
 * date stores the EMPTY STRING — and `toSprintView` surfaces that as
 * `due: null`. '' is the one sentinel; nothing else means "unscheduled", and
 * the list order (SPRINT_ORDER above) sorts those rows last.
 *
 * `lead` is stored as given (a person handle) without a persons lookup — the
 * same contract the admin plan write has, so the two paths cannot disagree.
 *
 * `start` / `due` are re-checked HERE with the one validator (`sprintDatesProblem`,
 * shared/sprints-core.ts) even though `SprintCreate` already did: a bad pair is a
 * `bad_request` that writes nothing, whoever the caller. Blank = not set.
 */
export async function create_sprint(db: DB, input: SprintCreate, author: string): Promise<SprintView> {
  const problem = sprintDatesProblem(input);
  if (problem) throw new SprintError("bad_request", problem);
  const now = nowIso();
  const res = await run(
    db,
    `INSERT INTO sprints (title, description, summary, phase, dates, start_date, target_date, status, urgency, lead, domain,
                          github_ref, created_at, created_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'upcoming', ?, ?, ?, NULL, ?, ?, ?)`,
    input.label,
    input.description ?? null,
    input.summary ?? null,
    input.phase ?? "Unscheduled",
    input.dates ?? null,
    normalizeSprintDate(input.start),
    normalizeSprintDate(input.due) ?? "",
    input.urgency,
    input.lead ?? null,
    input.domain ?? null,
    now,
    author,
    now
  );
  return viewFor(db, res.meta.last_row_id as number);
}

/**
 * Flip a sprint between the Roadmap's In Progress and Upcoming groups.
 * `active` is derived, never stored, so this writes `status`:
 *
 *   active: true               → 'in_progress'  (from ANY status, including
 *                                'done' — that is an admin re-opening a sprint
 *                                that turned out not to be finished)
 *   active: false, status done → NO-OP: the row is returned unchanged. Clearing
 *                                "active" must never un-finish a sprint; only
 *                                the plan write can move it off 'done'.
 *   active: false, otherwise   → 'upcoming'
 */
export async function set_sprint_active(db: DB, id: number, active: boolean): Promise<SprintView> {
  const sp = await requireSprint(db, id);
  if (!active && sp.status === "done") return viewFor(db, id);
  const status = active ? "in_progress" : "upcoming";
  if (sp.status !== status) {
    await run(db, `UPDATE sprints SET status = ?, updated_at = ? WHERE id = ?`, status, nowIso(), id);
  }
  return viewFor(db, id);
}

/**
 * Human confirmation: flip a live sprint to 'done'. Admin action in the promote
 * class — 'done' is NEVER inferred from issues or tickets closing. Lives here
 * (with the other sprint writers) and is re-exported from writes.ts so the older
 * import path keeps working.
 */
export async function complete_sprint(db: DB, id: number): Promise<SprintView> {
  const sp = await first<{ id: number }>(db, `SELECT id FROM sprints WHERE id = ?`, id);
  // Typed like every other writer in this file: the MCP adapter surfaces `code`
  // to the caller, and "no such sprint" vs "already done" are different answers
  // for an agent (retry with a real id, versus nothing to do). The cookie route
  // catches both into the same 400 it always did, so the web path is unchanged.
  if (!sp) throw new SprintError("not_found", `no such sprint: ${id}`);

  // COMPARE-AND-SET, not check-then-act. The "already done" guard lives in the
  // UPDATE's own WHERE, so the read and the write are one statement: D1 has no
  // interactive transaction, and a separate status read leaves a window where a
  // second completion passes the check after the first has already written —
  // both would then report success for the one sprint. `changes === 0` means
  // some other caller got there first, which is exactly the conflict.
  const res = await run(
    db,
    `UPDATE sprints SET status = 'done', updated_at = ? WHERE id = ? AND status != 'done'`,
    nowIso(),
    id
  );
  if (!res.meta.changes) throw new SprintError("conflict", `sprint already done: ${id}`);
  // Answers with the VIEW, like create_sprint and set_sprint_active — column
  // names never leave this file (see the header). The agent skill tells a caller
  // to read the new state off the write response, and a raw row would hand it
  // `label: undefined` and no `active`. The cookie route's body changes shape
  // with it; web/src/api.ts types that call `Promise<{ok:true}>` and drops it.
  return viewFor(db, id);
}

/**
 * Delete a sprint — a HARD delete, open to any signed-in member (and, over MCP,
 * any principal). Its tickets are NOT deleted: they move to the backlog
 * (`sprint_id = NULL`, `updated_at` bumped so they resurface in the queue) and
 * keep every comment, link and event. The sprint's own `sprint_resources` and
 * its `sprint_progress` cache row go with it (both FK the sprint); the
 * `roadmap_fts` row goes via the AFTER DELETE trigger. Past `plan_versions`
 * snapshots still name it — history, not the live plan.
 *
 * ONE `db.batch` (a single implicit transaction), children before the parent
 * so the FKs hold. Answers with how many tickets moved to the backlog.
 */
export async function delete_sprint(db: DB, id: number): Promise<{ id: number; label: string; moved: number }> {
  const sp = await requireSprint(db, id);
  const now = nowIso();
  const [moved] = await db.batch([
    db.prepare(`UPDATE tickets SET sprint_id = NULL, updated_at = ? WHERE sprint_id = ?`).bind(now, id),
    db.prepare(`DELETE FROM sprint_resources WHERE sprint_id = ?`).bind(id),
    db.prepare(`DELETE FROM sprint_progress WHERE sprint_id = ?`).bind(id),
    db.prepare(`DELETE FROM sprints WHERE id = ?`).bind(id),
  ]);
  return { id, label: sp.title, moved: moved.meta.changes ?? 0 };
}

/**
 * Attach one resource to the sprint itself, parsed by the SHARED link parser the
 * ticket links and the SPA also use — so `#214` means the same thing wherever it
 * is typed. An unparseable raw is a 400 (never a silently dropped field); an
 * unknown sprint is a 404.
 *
 * Idempotent: the same url twice adds one row. (The read side dedupes by url
 * anyway, so a duplicate would be invisible — but it would still be a row.)
 */
export async function add_sprint_resource(db: DB, id: number, raw: string): Promise<SprintDetail> {
  await requireSprint(db, id);
  const link = parseTicketLink(raw);
  if (!link) throw new SprintError("bad_request", `unusable link: ${raw}`);

  const existing = await first<{ id: number }>(
    db,
    `SELECT id FROM sprint_resources WHERE sprint_id = ? AND url = ?`,
    id,
    link.url
  );
  if (!existing) {
    await run(
      db,
      `INSERT INTO sprint_resources (sprint_id, url, kind, label, meta) VALUES (?, ?, ?, ?, ?)`,
      id, link.url, link.kind, link.label, link.meta
    );
  }
  return (await get_sprint(db, id))!;
}

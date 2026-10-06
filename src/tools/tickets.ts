// Ticket writers — DIRECT AUTHORED WRITES, in the promote class.
//
// Nothing here goes through `consume()` / the ingestion gate: a ticket is filed
// by a signed-in human through a cookie route, so there is no vocabulary to
// police, no confidence to weigh, no staged state to confirm. `done` / `declined`
// are set here only because a person asked for them — never inferred from a PR
// merging or an issue closing (the brief's fourth invariant). The one carve-out
// lives OUTSIDE this file: a ticket mirrored from a GitHub issue follows that
// issue's close/reopen through ./ticket-mirror.ts's private writer.
//
// Two rules hold across every function in this file:
//   1. Every write bumps `tickets.updated_at` — the queue is sorted by it, so a
//      comment, an assignment or a link has to move the ticket the same way a
//      status change does.
//   2. Every person-bearing value is a person HANDLE (0023 identity root),
//      canonicalized through `persons.handle` so a case variant can never create
//      a second, unrenameable spelling of the same person.
//
// The status machine is NOT re-declared here: `canTransition` in shared/tickets.ts
// is the one table, shared with the SPA.

import type { TicketCreate, TicketEdit, TicketStatus } from "@shared/tickets";
import { canTransition, parseTicketLink, placeInColumn, DEFAULT_TICKET_REPO } from "@shared/tickets";
import type { TicketRow } from "@shared/rows";
import { type TenantContext, type Stmt, first, all, run, stmt, batch, nowIso } from "../data/sql";
import { requireMember } from "../auth/persons";

/**
 * A typed failure the routes map onto an HTTP status:
 *   not_found   → 404 (unknown ticket / sprint / …)
 *   conflict    → 409 (an illegal status move, a nesting rule)
 *   bad_request → 400 (an unknown assignee handle, an unusable link, an empty comment)
 *   forbidden   → 403 (the write is outside the writer's lane — see tickets-agent.ts)
 * Everything else is a real 500.
 *
 * `forbidden` has two sources: the MCP write surface (`tickets-agent.ts`), which
 * scopes an agent to the tickets its principal is already assigned to (the cookie
 * routes never pass a scope — a signed-in human on the web is not assignee-scoped
 * and never was); and `remove_ticket_link` on a LOCKED link — a mirrored ticket's
 * source link (0032), which nobody may remove, on any surface.
 */
export class TicketError extends Error {
  constructor(readonly code: "not_found" | "conflict" | "bad_request" | "forbidden", message: string) {
    super(message);
    this.name = "TicketError";
  }
}

export const TICKET_ERROR_STATUS = { not_found: 404, conflict: 409, bad_request: 400, forbidden: 403 } as const;

const getTicketRow = async (ctx: TenantContext, id: number): Promise<TicketRow> => {
  const t = await first<TicketRow>(ctx, `SELECT * FROM tickets WHERE id = ? AND org_id = ?`, id, ctx.orgId);
  if (!t) throw new TicketError("not_found", `no such ticket: ${id}`);
  return t;
};

/** Bump `updated_at` on a ticket. Called by EVERY writer below — the queue's sort key. */
const touch = (ctx: TenantContext, id: number, at: string) =>
  run(ctx, `UPDATE tickets SET updated_at = ? WHERE id = ? AND org_id = ?`, at, id, ctx.orgId);

// Every handle these writers take — requester, actor, assignee, author — goes through `requireMember`
// (src/auth/persons.ts, §4.3): its canonical `persons.handle` spelling, or a `PersonError` the routes
// and /mcp answer exactly as a `bad_request` TicketError. A RESERVED handle (`github-webhook`, 0032)
// has a persons row but is not a person: it can never be assigned, file, comment or link through
// these writers — only the GitHub mirror (./ticket-mirror.ts) writes as it.

/** An explicit sprint must exist (the column is a soft INTEGER ref — 0024 could not FK it). */
async function requireSprint(ctx: TenantContext, sprintId: number): Promise<void> {
  const sp = await first<{ id: number }>(ctx, `SELECT id FROM sprints WHERE id = ? AND org_id = ?`, sprintId, ctx.orgId);
  if (!sp) throw new TicketError("not_found", `no such sprint: ${sprintId}`);
}

/**
 * The repository a BARE issue ref (`#214`) resolves against: the org's primary repository (`org_repos`,
 * D16) — never another org's. An org that has not configured one still gets the pre-multitenancy
 * default (`DEFAULT_TICKET_REPO`); the Phase 7 cleanup removes that fallback with the constant.
 */
export async function ticketLinkRepo(ctx: TenantContext): Promise<string> {
  const row = await first<{ repo_full_name: string }>(ctx, `SELECT repo_full_name FROM org_repos WHERE org_id = ? AND is_primary = 1`, ctx.orgId);
  return row?.repo_full_name ?? DEFAULT_TICKET_REPO;
}

/** Parse a raw link input, or 400. A blank raw is the caller's business, not this helper's. */
async function requireParsedLink(ctx: TenantContext, raw: string) {
  const parsed = parseTicketLink(raw, await ticketLinkRepo(ctx));
  if (!parsed) throw new TicketError("bad_request", `unusable link: ${raw}`);
  return parsed;
}

/**
 * File a ticket. The requester is ALWAYS the authenticated principal — a
 * client-supplied requester is not read by this function at all.
 *
 * Writes, in one logical unit: the ticket row (status 'submitted'), its
 * assignees, the OPENING `ticket_events` row (from_status NULL → 'submitted',
 * which the detail screen renders as "opened this ticket"), and the parsed link
 * when one was given.
 */
export async function create_ticket(ctx: TenantContext, input: TicketCreate, requester: string): Promise<number> {
  const author = await requireMember(ctx, requester);
  // Validate everything BEFORE the first insert: a bad assignee or sprint must
  // not leave a half-built ticket behind (D1 has no transaction here).
  const assignees: string[] = [];
  for (const a of input.assignees) {
    const handle = await requireMember(ctx, a);
    if (!assignees.includes(handle)) assignees.push(handle);
  }
  const sprintId = input.sprint_id ?? null;
  if (sprintId !== null) await requireSprint(ctx, sprintId);
  const rawLink = (input.link ?? "").trim();
  const link = rawLink ? await requireParsedLink(ctx, rawLink) : null;

  const now = nowIso();
  const res = await run(
    ctx,
    `INSERT INTO tickets (org_id, title, body, category, priority, status, requester, parent_id, sprint_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'submitted', ?, NULL, ?, ?, ?)`,
    ctx.orgId,
    input.title,
    input.body,
    input.category,
    input.priority,
    author,
    sprintId,
    now,
    now
  );
  const id = res.meta.last_row_id as number;

  for (const handle of assignees) {
    await run(ctx, `INSERT OR IGNORE INTO ticket_assignees (org_id, ticket_id, login) VALUES (?, ?, ?)`, ctx.orgId, id, handle);
  }

  // The opening history row. Every later status change appends one more.
  await run(
    ctx,
    `INSERT INTO ticket_events (org_id, ticket_id, actor, from_status, to_status, created_at) VALUES (?, ?, ?, NULL, 'submitted', ?)`,
    ctx.orgId,
    id,
    author,
    now
  );

  if (link) {
    await run(
      ctx,
      `INSERT INTO ticket_links (org_id, ticket_id, url, kind, label, meta, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ctx.orgId, id, link.url, link.kind, link.label, link.meta, author, now
    );
  }

  return id;
}

/**
 * Move a ticket's status. The move must be legal per `canTransition` (the ONE
 * table in shared/tickets.ts) — an illegal one throws and writes NOTHING, not
 * even the history row.
 */
export async function transition_ticket(ctx: TenantContext, id: number, to: TicketStatus, actor: string): Promise<void> {
  const t = await getTicketRow(ctx, id);
  const who = await requireMember(ctx, actor);
  if (!canTransition(t.status, to)) {
    throw new TicketError("conflict", `illegal transition: ${t.status} → ${to}`);
  }
  const now = nowIso();
  await run(
    ctx,
    `INSERT INTO ticket_events (org_id, ticket_id, actor, from_status, to_status, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ctx.orgId, id, who, t.status, to, now
  );
  // A move that is not a board drop clears the card's position: it lands at the
  // TOP of its new column (`boardOrder`), where a person will see it.
  await run(ctx, `UPDATE tickets SET status = ?, board_rank = NULL, updated_at = ? WHERE id = ? AND org_id = ?`, to, now, id, ctx.orgId);
}

/**
 * A board drop: move a ticket to column `to` (a status) right after `afterId`
 * (null = the top), in one write. A status change must be legal per
 * `canTransition` and appends the same history row as `transition_ticket`; a drop
 * back into its own column only reorders. The position comes from the ONE
 * `placeInColumn` the board uses for its optimistic drop, over the WHOLE column —
 * so a filtered board places relative to what the person saw, and the hidden cards
 * keep their order. When the column had to be renumbered, every renumbered row is
 * written in the same batch.
 */
export async function move_ticket(ctx: TenantContext, id: number, to: TicketStatus, afterId: number | null, actor: string): Promise<void> {
  const t = await getTicketRow(ctx, id);
  const who = await requireMember(ctx, actor);
  if (to !== t.status && !canTransition(t.status, to)) {
    throw new TicketError("conflict", `illegal transition: ${t.status} → ${to}`);
  }
  const column = await all<{ id: number; board_rank: number | null; updated_at: string }>(
    ctx,
    `SELECT id, board_rank, updated_at FROM tickets WHERE org_id = ? AND status = ? AND id != ?`,
    ctx.orgId, to, id
  );
  const { rank, renumber } = placeInColumn(column, afterId);
  const now = nowIso();
  const stmts: Stmt[] = [];
  for (const [rid, r] of renumber ?? []) stmts.push(stmt(ctx, `UPDATE tickets SET board_rank = ? WHERE id = ? AND org_id = ?`, r, rid, ctx.orgId));
  if (to !== t.status) {
    stmts.push(stmt(ctx, `INSERT INTO ticket_events (org_id, ticket_id, actor, from_status, to_status, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ctx.orgId, id, who, t.status, to, now));
  }
  stmts.push(stmt(ctx, `UPDATE tickets SET status = ?, board_rank = ?, updated_at = ? WHERE id = ? AND org_id = ?`, to, rank, now, id, ctx.orgId));
  // D1 caps a batch well above a board column; chunk anyway so a huge Done column never trips it.
  for (let i = 0; i < stmts.length; i += 100) await batch(ctx, stmts.slice(i, i + 100));
}

/**
 * Add or remove one assignee. Idempotent by construction (INSERT OR IGNORE on the
 * (ticket_id, login) PK / an unconditional DELETE), because the design's picker
 * toggles with no confirm step and may fire twice.
 */
export async function toggle_assignee(ctx: TenantContext, id: number, login: string, on: boolean): Promise<void> {
  await getTicketRow(ctx, id);
  const handle = await requireMember(ctx, login);
  if (on) {
    await run(ctx, `INSERT OR IGNORE INTO ticket_assignees (org_id, ticket_id, login) VALUES (?, ?, ?)`, ctx.orgId, id, handle);
  } else {
    await run(ctx, `DELETE FROM ticket_assignees WHERE ticket_id = ? AND login = ? AND org_id = ?`, id, handle, ctx.orgId);
  }
  await touch(ctx, id, nowIso());
}

/** Attach one linked-work reference, parsed by the SHARED parser the SPA also uses. */
export async function add_ticket_link(ctx: TenantContext, id: number, raw: string, by: string): Promise<number> {
  await getTicketRow(ctx, id);
  const who = await requireMember(ctx, by);
  const link = await requireParsedLink(ctx, raw);
  const now = nowIso();
  const res = await run(
    ctx,
    `INSERT INTO ticket_links (org_id, ticket_id, url, kind, label, meta, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ctx.orgId, id, link.url, link.kind, link.label, link.meta, who, now
  );
  await touch(ctx, id, now);
  return res.meta.last_row_id as number;
}

/**
 * Detach one linked-work reference. A hard delete: a link is a pointer, not a
 * record, and `ticket_events` audits status moves only (adding one writes no
 * event either). The link must belong to THIS ticket — a link id from another
 * ticket is the same 404 as an unknown one, so the route cannot reach across.
 *
 * THE LOCK (0032): a `locked` link — the GitHub issue a mirrored ticket was
 * sourced from — is refused with `forbidden` and left in place. This function is
 * the ONLY delete path for ticket links (there is deliberately no DB trigger:
 * the test harness truncates ticket_links), so keep it the only one. The DELETE
 * repeats `locked = 0`, so even a lock set between the read and the write holds.
 */
export async function remove_ticket_link(ctx: TenantContext, id: number, linkId: number): Promise<void> {
  await getTicketRow(ctx, id);
  const link = await first<{ locked: number }>(
    ctx, `SELECT locked FROM ticket_links WHERE id = ? AND ticket_id = ? AND org_id = ?`, linkId, id, ctx.orgId);
  if (!link) throw new TicketError("not_found", `no such link on ticket ${id}: ${linkId}`);
  if (link.locked) throw new TicketError("forbidden", "this is the GitHub issue the ticket mirrors — its link cannot be removed");
  const res = await run(ctx, `DELETE FROM ticket_links WHERE id = ? AND ticket_id = ? AND org_id = ? AND locked = 0`, linkId, id, ctx.orgId);
  if (!res.meta.changes) throw new TicketError("forbidden", "this link is locked");
  await touch(ctx, id, nowIso());
}

/**
 * Edit a ticket's title and/or body — native AND mirrored tickets alike: a
 * mirrored ticket's title and body are seeded from the issue at import and are
 * Trov's from then on (the mirror never writes them again). A patch that
 * changes neither is `bad_request`; a title must survive trimming. No history
 * row — `ticket_events` audits status moves only. The tickets_fts_au trigger
 * re-indexes the new text.
 */
export async function edit_ticket(ctx: TenantContext, id: number, patch: TicketEdit, actor: string): Promise<void> {
  const t = await getTicketRow(ctx, id);
  await requireMember(ctx, actor);
  const title = patch.title !== undefined ? patch.title.trim() : undefined;
  if (title !== undefined && !title) throw new TicketError("bad_request", "title is empty");
  if (title === undefined && patch.body === undefined) throw new TicketError("bad_request", "nothing to edit: pass title and/or body");
  await run(ctx, `UPDATE tickets SET title = ?, body = ?, updated_at = ? WHERE id = ? AND org_id = ?`,
    title ?? t.title, patch.body ?? t.body, nowIso(), id, ctx.orgId);
}

/** Move a ticket into a sprint, or back to the backlog (`null`). */
export async function set_ticket_sprint(ctx: TenantContext, id: number, sprintId: number | null): Promise<void> {
  await getTicketRow(ctx, id);
  if (sprintId !== null) await requireSprint(ctx, sprintId);
  const now = nowIso();
  await run(ctx, `UPDATE tickets SET sprint_id = ?, updated_at = ? WHERE id = ? AND org_id = ?`, sprintId, now, id, ctx.orgId);
}

/**
 * Nest `childId` under `parentId`. Tickets nest EXACTLY ONE level, so four
 * rejections guard the write (plus the degenerate self-parent):
 *   - the parent itself has a parent      → that would be level two
 *   - the child already has a parent      → it is already nested somewhere
 *   - the child is done/declined          → closed work is not re-filed under a parent
 *   - the child has children of its own   → it is a parent, and would become level two
 * Every rejection leaves the database untouched.
 */
export async function set_ticket_parent(ctx: TenantContext, parentId: number, childId: number): Promise<void> {
  const parent = await getTicketRow(ctx, parentId);
  const child = await getTicketRow(ctx, childId);

  if (parent.id === child.id) throw new TicketError("conflict", "a ticket cannot be its own sub-ticket");
  if (parent.parent_id !== null) throw new TicketError("conflict", "tickets nest one level: this ticket already has a parent");
  if (child.parent_id !== null) throw new TicketError("conflict", "that ticket already has a parent");
  if (child.status === "done" || child.status === "declined") throw new TicketError("conflict", "that ticket is closed");
  const kids = await first<{ n: number }>(ctx, `SELECT COUNT(*) AS n FROM tickets WHERE parent_id = ? AND org_id = ?`, child.id, ctx.orgId);
  if ((kids?.n ?? 0) > 0) throw new TicketError("conflict", "that ticket has sub-tickets of its own");

  const now = nowIso();
  await run(ctx, `UPDATE tickets SET parent_id = ?, updated_at = ? WHERE id = ? AND org_id = ?`, parent.id, now, child.id, ctx.orgId);
  // The parent's sub-ticket count changed, so it is a write on the parent too.
  await touch(ctx, parent.id, now);
}

/** Append one comment. The body is trimmed and must survive it (min 1 char). */
export async function add_ticket_comment(ctx: TenantContext, id: number, body: string, author: string): Promise<number> {
  await getTicketRow(ctx, id);
  const who = await requireMember(ctx, author);
  const text = body.trim();
  if (!text) throw new TicketError("bad_request", "comment body is empty");
  const now = nowIso();
  const res = await run(
    ctx,
    `INSERT INTO ticket_comments (org_id, ticket_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)`,
    ctx.orgId, id, who, text, now
  );
  await touch(ctx, id, now);
  return res.meta.last_row_id as number;
}

/**
 * Delete a ticket — a HARD delete, one `db.batch`, open to any signed-in member
 * (like `delete_sprint`). Only a NATIVE ticket: a ticket mirrored from a GitHub
 * issue (`source = 'github'`) is refused with 403, because the issue is still
 * there and the mirror would only re-create it on the next delivery or Sync.
 * Its assignees, links, comments and history go with it; its sub-tickets are
 * detached (top-level again, never deleted); an artifact linked to it keeps the
 * page and loses only the link. The number is never reissued (AUTOINCREMENT),
 * and `tickets_fts_ad` drops the search row.
 */
export async function delete_ticket(ctx: TenantContext, id: number): Promise<{ id: number; title: string; detached: number }> {
  const t = await getTicketRow(ctx, id);
  if (t.source === "github") {
    throw new TicketError("forbidden", "this ticket mirrors a GitHub issue — close the issue on GitHub instead");
  }
  const now = nowIso();
  const [detached] = await batch(ctx, [
    stmt(ctx, `UPDATE tickets SET parent_id = NULL, updated_at = ? WHERE parent_id = ? AND org_id = ?`, now, id, ctx.orgId),
    stmt(ctx, `DELETE FROM ticket_assignees WHERE ticket_id = ? AND org_id = ?`, id, ctx.orgId),
    stmt(ctx, `DELETE FROM ticket_links WHERE ticket_id = ? AND org_id = ?`, id, ctx.orgId),
    stmt(ctx, `DELETE FROM ticket_comments WHERE ticket_id = ? AND org_id = ?`, id, ctx.orgId),
    stmt(ctx, `DELETE FROM ticket_events WHERE ticket_id = ? AND org_id = ?`, id, ctx.orgId),
    stmt(ctx, `DELETE FROM artifact_links WHERE target_type = 'ticket' AND target_ref = ? AND org_id = ?`, String(id), ctx.orgId),
    stmt(ctx, `DELETE FROM tickets WHERE id = ? AND org_id = ? AND source = 'canopy'`, id, ctx.orgId),
  ]);
  return { id, title: t.title, detached: detached.meta.changes ?? 0 };
}

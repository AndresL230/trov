// The ZOD-FREE core of the tickets contract: the controlled vocabulary tuples and
// the status machine. `shared/tickets.ts` builds its Zod schemas on top of these
// and RE-EXPORTS every one of them, so nothing outside this file has to know the
// split — `import { legalMoves } from "@shared/tickets"` keeps working.
//
// Why the split: the SPA needs the RULE (which moves are legal, what a status is
// called, which categories exist) as VALUES at runtime, and `web/` importing a
// module that evaluates `z.object(...)` at load time drags the whole of zod into
// the browser bundle (+70 kB minified, measured). Every other web ↔ shared seam is
// type-only for exactly that reason. This module has no imports at all, so the
// SPA gets the one shared definition of the status machine for free.
//
// The status machine is declared ONCE, here, and enforced everywhere: the routes
// (`transition_ticket`), the MCP reads, and the detail screen's transition buttons
// all read the same table.

// ── controlled vocabulary (must match the CHECK constraints in 0024_tickets.sql,
//    and for statuses 0033_ticket_testing_rank.sql) ─

export const TICKET_CATEGORIES = ["bug", "request", "question", "access", "other"] as const;
export const TICKET_PRIORITIES = ["low", "normal", "high"] as const;
export const TICKET_STATUSES = ["submitted", "in_progress", "testing", "done", "declined"] as const;
export const TICKET_LINK_KINDS = ["github", "figma", "plain"] as const;
/** Where a ticket came from (0032): filed in Canopy, or mirrored from a GitHub issue. */
export const TICKET_SOURCES = ["canopy", "github"] as const;

export type TicketCategory = (typeof TICKET_CATEGORIES)[number];
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export type TicketLinkKind = (typeof TICKET_LINK_KINDS)[number];
export type TicketSource = (typeof TICKET_SOURCES)[number];

/** The issue number of a mirrored ticket's `source_ref` ("owner/repo#214" → 214), else null. */
export function sourceIssueNumber(sourceRef: string | null | undefined): number | null {
  const m = sourceRef?.match(/#(\d+)$/);
  return m ? Number(m[1]) : null;
}

// ── the status machine (ONE definition, enforced everywhere) ─────────────────
// A status is SET by a person, from the status control itself — or by dragging
// the card on the board — there are no accept/reject action buttons, and
// assignment never implies a status (an assignee is assigned, full stop).
//
// Every move is free (the owner's call, 2026-09-27): any status may move to any
// other — Triage straight to Done, and Done or Declined back to any open status
// (a ticket resolved by mistake, or whose work turned out unfinished, is simply
// moved back). Testing (0033) is an optional step, not a gate. The only move
// refused is a status to itself, which is not a move.
//
// The order here is the pipeline's, which is the order the control lists them in.

export const TICKET_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  submitted: ["in_progress", "testing", "done", "declined"],
  in_progress: ["submitted", "testing", "done", "declined"],
  testing: ["submitted", "in_progress", "done", "declined"],
  done: ["submitted", "in_progress", "testing", "declined"],
  declined: ["submitted", "in_progress", "testing", "done"],
};

export function canTransition(from: TicketStatus, to: TicketStatus): boolean {
  return TICKET_TRANSITIONS[from].includes(to);
}

/** The moves the UI may offer from `status` (a copy — callers never mutate the table). */
export function legalMoves(status: TicketStatus): TicketStatus[] {
  return [...TICKET_TRANSITIONS[status]];
}

/** The DISPLAY vocabulary — the DB values never change. `submitted` reads
 *  "Triage" because that is what the state is for a reader: filed, waiting for
 *  a person to pick it up or decide against it. It is deliberately NOT called
 *  "Open" (the queue's `seg=open` covers `submitted` AND `in_progress`, so one
 *  status owning that word would contradict `isOpenStatus`) and not "Backlog"
 *  (a sprint-less ticket is already in the Backlog group). */
export const TICKET_STATUS_LABEL: Record<TicketStatus, string> = {
  submitted: "Triage",
  in_progress: "In progress",
  testing: "Testing",
  done: "Done",
  declined: "Declined",
};

/** The OPEN statuses — the `seg=open` segment, "not yet resolved by a person".
 *  The SQL readers spell the same set as `OPEN_STATUS_SQL`. */
export const OPEN_STATUSES = ["submitted", "in_progress", "testing"] as const;
export const OPEN_STATUS_SQL = "('submitted','in_progress','testing')";

export function isOpenStatus(s: TicketStatus): boolean {
  return (OPEN_STATUSES as readonly string[]).includes(s);
}

// ── the board's order (0033 `tickets.board_rank`) ────────────────────────────
// Each board column is ordered by a saved position, set only by dragging a card.
// A ticket with NO position (NULL — every ticket before its first drag, a new
// ticket, a ticket moved by the status menu, MCP or the GitHub mirror) sits at the
// TOP of its column, newest-updated first; the positioned ones follow in rank
// order. The Worker's `move_ticket` and the board read this ONE comparator and
// place with the ONE `placeInColumn` below, so an optimistic drop lands where
// the server will put it.

export interface BoardOrderKey {
  id: number;
  board_rank: number | null;
  updated_at: string;
}

export function boardOrder(a: BoardOrderKey, b: BoardOrderKey): number {
  const an = a.board_rank === null, bn = b.board_rank === null;
  if (an !== bn) return an ? -1 : 1;
  if (!an && a.board_rank !== b.board_rank) return (a.board_rank as number) - (b.board_rank as number);
  if (a.updated_at !== b.updated_at) return a.updated_at < b.updated_at ? 1 : -1;
  return b.id - a.id;
}

/** Spacing between renumbered positions, so later drops have room to split. */
export const BOARD_RANK_STEP = 1024;

/**
 * Where a card dropped into `column` right after `afterId` (null = the top) goes.
 * `column` is the target column WITHOUT the moved card, in any order. Returns the
 * card's new rank and, when the column had to be renumbered first (it holds a
 * NULL position, or two neighbours are too close to split), the new rank of every
 * other card — the caller writes those too. An `afterId` not in the column means
 * the top.
 */
export function placeInColumn(column: BoardOrderKey[], afterId: number | null): { rank: number; renumber: Map<number, number> | null } {
  let col = [...column].sort(boardOrder);
  let renumber: Map<number, number> | null = null;
  const respace = () => {
    renumber = new Map(col.map((t, i) => [t.id, (i + 1) * BOARD_RANK_STEP]));
    col = col.map((t) => ({ ...t, board_rank: (renumber as Map<number, number>).get(t.id) as number }));
  };
  if (col.some((t) => t.board_rank === null)) respace();
  const at = afterId === null ? 0 : col.findIndex((t) => t.id === afterId) + 1;   // -1 + 1 = 0: the top
  const between = () => {
    const prev = col[at - 1]?.board_rank ?? null;
    const next = col[at]?.board_rank ?? null;
    if (prev === null && next === null) return BOARD_RANK_STEP;
    if (prev === null) return (next as number) - BOARD_RANK_STEP;
    if (next === null) return prev + BOARD_RANK_STEP;
    return next - prev > 1e-6 ? (prev + next) / 2 : null;
  };
  let rank = between();
  if (rank === null) { respace(); rank = between() as number; }
  return { rank, renumber };
}

// The MCP ticket WRITE surface — the agent's lane, and the one place it is drawn.
//
// Tickets are authored writes in the promote class (see ./tickets.ts). Nothing
// here changes that: every function below delegates to the SAME writer the cookie
// route calls, so the transition table, the nesting rules, handle validation and
// the `ticket_events` audit rows are shared with the web UI. What this module adds
// — and all it adds — is SCOPE:
//
//   An agent writes only inside its principal's own lane. A ticket write over MCP
//   is permitted exactly when the bearer principal is already an assignee of that
//   ticket. Filing a new ticket is the one unscoped write, and assigning one has
//   a rule of its own (below).
//
// Why assignment is the boundary (design D2): the queue already states "this is
// yours" by assigning it, by hand, in the web UI. Scoping to that needs no new
// concept, no new column and no new screen.
//
// Assignment itself (issue #90, 2026-09-27 — reversing design D3, which kept it a
// human act reachable only through `create_ticket`'s `assignees`). D3 stood on
// "an agent that could edit the assignee list could edit its own permissions".
// The lane cannot scope assignment — assignment is how a ticket gets INTO a lane —
// so `assign_ticket` is scoped to the people who could already hand the ticket to
// someone: an ADMIN (a lead distributing work), the ticket's REQUESTER (routing
// their own ticket) or a CURRENT ASSIGNEE (handing it on). That still leaves an
// unrelated agent unable to put itself — or anyone — on someone else's ticket;
// the escalation left open is the requester adding themselves, which D10 already
// accepts at filing time.
//
// The bearer token IS the person (design D1), so inside that lane the parity with
// the ticket screen is total — `done` and `declined` included. The fourth tickets
// invariant is untouched by that: it says nothing INFERS a resolution (not a PR
// merging, not an issue closing, not the cron — the one carve-out being a
// MIRRORED ticket following its own source issue, ./ticket-mirror.ts), and an agent calling
// transition_ticket under a person's token on that person's ticket is the person
// saying so.
//
// TWO rules hold across every function here:
//   1. Scope is asserted BEFORE the first mutation, never between two. D1 has no
//      transaction on this path, so a refusal must leave the database untouched.
//   2. 404 before 403 — an unknown ticket id is `not_found`, never `forbidden`.
//      The scope check must not double as an existence oracle.

import type { Env } from "../env";
import { isAdmin } from "../auth/principal";
import { type TenantContext, first } from "../data/sql";
import {
  TicketError,
  create_ticket, edit_ticket, transition_ticket, add_ticket_comment, add_ticket_link,
  set_ticket_sprint, set_ticket_parent, toggle_assignee, requirePerson,
} from "./tickets";
import type { TicketCreate, TicketEdit, TicketStatus } from "@shared/tickets";

/** The lane-scoped verbs. `create_ticket` is absent on purpose — it is the unscoped
 *  write — and so is `assign_ticket`, which has its own rule (assertTicketAssignable). */
export type AgentVerb =
  | "edit_ticket"
  | "transition_ticket"
  | "add_ticket_comment"
  | "add_ticket_link"
  | "set_ticket_sprint"
  | "set_ticket_parent";

/**
 * The lane rule, in one function.
 *
 * Throws `not_found` for an unknown ticket (checked FIRST, so a non-assignee
 * cannot use a 403 to learn that an id exists), then `forbidden` unless the
 * handle is among the ticket's assignees.
 *
 * ONE exception (design D6): an admin may `set_ticket_sprint` on any ticket.
 * Composing a sprint is sprint management, which is admin territory already
 * (the plan write and the four sprint verbs), and without it "edit sprints over
 * MCP" is half a feature — an admin could create the container and never fill
 * it. It is a `sprint_id` move and nothing else: it never resolves, comments on,
 * re-assigns or re-parents someone else's ticket. Deleting the exception is
 * deleting the one `if` below.
 *
 * Handles compare COLLATE NOCASE, matching `persons.handle` and the ticket reads,
 * so a case variant can never widen or narrow a lane.
 */
export async function assertTicketWritable(
  ctx: TenantContext,
  env: Env,
  id: number,
  handle: string,
  verb: AgentVerb,
): Promise<void> {
  const exists = await first<{ id: number }>(ctx, `SELECT id FROM tickets WHERE id = ? AND org_id = ?`, id, ctx.orgId);
  if (!exists) throw new TicketError("not_found", `no such ticket: ${id}`);

  if (verb === "set_ticket_sprint" && isAdmin(env, handle)) return;

  const mine = await first<{ n: number }>(
    ctx,
    `SELECT COUNT(*) AS n FROM ticket_assignees WHERE ticket_id = ? AND org_id = ? AND login = ? COLLATE NOCASE`,
    id,
    ctx.orgId,
    handle,
  );
  if (!(mine?.n ?? 0)) {
    throw new TicketError("forbidden", `ticket ${id} is not assigned to you — an admin, its requester or one of its assignees can add you (assign_ticket, or the web UI)`);
  }
}

/**
 * The assignment rule, in one function (issue #90) — NOT the lane: see the header.
 *
 * Throws `not_found` for an unknown ticket (FIRST, as above), then `forbidden`
 * unless the handle is an admin, the ticket's requester or one of its current
 * assignees. Handles compare COLLATE NOCASE, like the lane.
 */
export async function assertTicketAssignable(ctx: TenantContext, env: Env, id: number, handle: string): Promise<void> {
  const t = await first<{ requester: number; assignee: number }>(
    ctx,
    `SELECT requester = ? COLLATE NOCASE AS requester,
            EXISTS (SELECT 1 FROM ticket_assignees a
                     WHERE a.ticket_id = tickets.id AND a.org_id = ? AND a.login = ? COLLATE NOCASE) AS assignee
       FROM tickets WHERE id = ? AND org_id = ?`,
    handle,
    ctx.orgId,
    handle,
    id,
    ctx.orgId,
  );
  if (!t) throw new TicketError("not_found", `no such ticket: ${id}`);

  if (isAdmin(env, handle) || t.requester || t.assignee) return;
  throw new TicketError("forbidden", `ticket ${id} can be (re)assigned only by an admin, its requester or one of its assignees`);
}

// ── the eight wrappers: assert, then delegate ──────────────────────────────────
//
// Each is one line of scope and one line of work. `src/mcp.ts` imports ONLY from
// this module for ticket writes, so a verb cannot reach the MCP surface without
// passing through one of the assertions above.

/**
 * File a ticket — THE ONE UNSCOPED WRITE (design D2). It asserts nothing because
 * there is no ticket yet to be assigned to anyone.
 *
 * `input.assignees` is the one assignment an agent makes without a rule to pass
 * (after filing, `assign_ticket` is scoped by assertTicketAssignable).
 * An agent MAY name its own principal there and thereby unlock every scoped verb
 * on the ticket it just filed (design D10, accepted): every field it could later
 * change it could have set here, and the ticket is one it opened. That is the
 * whole of the escalation, and it is named rather than hidden.
 */
export function agentCreateTicket(ctx: TenantContext, input: TicketCreate, requester: string): Promise<number> {
  return create_ticket(ctx, input, requester);
}

/** Edit a ticket's title and/or body, inside the lane. A mirrored ticket's title
 *  and body are Trov's after import, so this works on those too. */
export async function agentEditTicket(ctx: TenantContext, env: Env, id: number, patch: TicketEdit, actor: string): Promise<void> {
  await assertTicketWritable(ctx, env, id, actor, "edit_ticket");
  await edit_ticket(ctx, id, patch, actor);
}

/**
 * Move a ticket's status, inside the lane. Every move in the shared table is
 * reachable — `done` and `declined` included, because the bearer token IS the
 * person (design D1) and refusing them here would withhold them from the person,
 * not from a machine. What the invariant forbids is INFERENCE, and nothing on
 * this path infers: a caller asked, under that person's own credential.
 */
export async function agentTransitionTicket(ctx: TenantContext, env: Env, id: number, to: TicketStatus, actor: string): Promise<void> {
  await assertTicketWritable(ctx, env, id, actor, "transition_ticket");
  await transition_ticket(ctx, id, to, actor);
}

/** Append a comment, inside the lane. Attributed to the author with no provenance
 *  marking it agent-written (design D4) — the skill's `comment_prefix` is the only
 *  thing that makes one recognizable. */
export async function agentAddTicketComment(ctx: TenantContext, env: Env, id: number, body: string, author: string): Promise<number> {
  await assertTicketWritable(ctx, env, id, author, "add_ticket_comment");
  return add_ticket_comment(ctx, id, body, author);
}

/** Attach linked work, inside the lane. `raw` goes through the SHARED parser, so
 *  `#214` resolves the same way it does when a person types it into the web UI. */
export async function agentAddTicketLink(ctx: TenantContext, env: Env, id: number, raw: string, by: string): Promise<number> {
  await assertTicketWritable(ctx, env, id, by, "add_ticket_link");
  return add_ticket_link(ctx, id, raw, by);
}

/** Move a ticket into a sprint, or back to the backlog (`null`). The ONE verb an
 *  admin may use outside their lane — see the D6 note on assertTicketWritable. */
export async function agentSetTicketSprint(ctx: TenantContext, env: Env, id: number, sprintId: number | null, actor: string): Promise<void> {
  await assertTicketWritable(ctx, env, id, actor, "set_ticket_sprint");
  await set_ticket_sprint(ctx, id, sprintId);
}

/**
 * Nest one ticket under another. The lane is required on BOTH ids: the call writes
 * `child.parent_id` AND bumps the parent's `updated_at` (its sub-ticket count
 * changed), so both rows are the subject of the write. The conservative reading,
 * and the easy one to relax — drop the second assertion.
 */
export async function agentSetTicketParent(ctx: TenantContext, env: Env, parentId: number, childId: number, actor: string): Promise<void> {
  await assertTicketWritable(ctx, env, parentId, actor, "set_ticket_parent");
  await assertTicketWritable(ctx, env, childId, actor, "set_ticket_parent");
  await set_ticket_parent(ctx, parentId, childId);
}

/**
 * Add (`on: true`) or remove (`on: false`) one assignee — scoped by
 * assertTicketAssignable, not the lane. Delegates to the web's `toggle_assignee`,
 * so handle validation (an unknown or RESERVED handle is `bad_request`) and the
 * write are the ticket screen's own. It never touches status, exactly like the
 * web picker, and writes no history row: `ticket_events` audits status moves only.
 *
 * Idempotent WITHOUT a write: adding someone already on the ticket, or removing
 * someone who is not, returns having written nothing — not even the `updated_at`
 * bump the web writer makes on every toggle, so a repeated call never reorders the
 * queue. The handle is still validated on that path, so a typo is never a silent
 * success. A mirrored ticket's assignees are Trov's after import, so this works
 * on those too.
 */
export async function agentAssignTicket(ctx: TenantContext, env: Env, id: number, login: string, on: boolean, actor: string): Promise<void> {
  await assertTicketAssignable(ctx, env, id, actor);
  const handle = await requirePerson(ctx, login);
  const has = await first<{ n: number }>(
    ctx,
    `SELECT COUNT(*) AS n FROM ticket_assignees WHERE ticket_id = ? AND org_id = ? AND login = ? COLLATE NOCASE`,
    id,
    ctx.orgId,
    handle,
  );
  if (Boolean(has?.n) === on) return;
  await toggle_assignee(ctx, id, handle, on);
}

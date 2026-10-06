import type { DashboardData, MyWorkPr, MyWorkTodo, MyWorkTicket } from "@shared/dashboard";
import type { EventRow, PersonRow } from "@shared/rows";
import { OPEN_STATUS_SQL } from "@shared/tickets-core";
import { type TenantContext, all, first } from "../data/sql";
import { type PlatformContext, first as platformFirst } from "../data/platform-sql";
import { legacyDb } from "../data/legacy";
import { getPerson, listIdentities } from "../auth/persons";
import { isIssueGone } from "./issue-gone";

// My Work: a D1-only projection over captured GitHub events (Task 6). No live
// GitHub reads — this is deliberately the "what already happened + what's
// open" view built entirely from `events` (+ `pr_summaries`, `issue_summaries`,
// `persons`/`identities`).

// The projection is structurally the /me/dashboard DTO; the shared type is the
// single source of truth so the Worker and web build agree on the shape.
export type MyWork = DashboardData;

const PR_LIMIT = 6;
const TODO_LIMIT = 6;
const TICKET_LIMIT = 6;

const EMPTY = (degraded: boolean): MyWork => ({ person: null, previousActivity: [], todo: [], tickets: [], ticketsTotal: 0, degraded });

// Priority is parsed from a leading "[P0]"–"[P3]" tag on the issue title; the
// tag is stripped from the displayed title.
export function priorityOf(title: string): "P0" | "P1" | "P2" | "P3" | null {
  const m = title.match(/^\s*\[(P[0-3])\]/);
  return m ? (m[1] as "P0" | "P1" | "P2" | "P3") : null;
}
export function stripPriority(title: string): string {
  return title.replace(/^\s*\[P[0-3]\]\s*/, "").trim();
}

/** The person a GitHub login belongs to, via the github identity row; null when unmapped. */
export async function resolvePersonForLogin(p: PlatformContext, login: string): Promise<PersonRow | null> {
  return platformFirst<PersonRow>(p,
    `SELECT p.* FROM identities i JOIN persons p ON p.handle = i.person WHERE i.provider = 'github' AND i.subject = ?`, login);
}

export interface PrEventJoinRow extends EventRow {
  s_title: string | null;
  s_what: string | null;
  s_why: string | null;
  s_impact: string | null;
}

interface RawPr {
  pr: { number: number; title: string; html_url: string; merged: boolean; base?: { ref: string } | null };
}

interface RawIssue {
  action?: string;
  issue: {
    number: number;
    title: string;
    html_url: string;
    state: string;
    updated_at: string;
    assignees: { login: string }[];
    labels: string[];
    // GitHub's own key — not Trov vocabulary. The group an issue belongs to on
    // GitHub; Trov resolves its `number` to a SPRINT below.
    milestone?: { number?: number | null; title?: string | null; due_on?: string | null } | null;
  };
}

/**
 * GitHub group number → the sprint that claims it, in ONE query. A sprint's
 * `github_ref` is JSON: a bare number IS a GitHub group number (the array form
 * is a list of issue numbers and claims no group). First sprint wins if two
 * claim the same number; a malformed ref claims nothing.
 */
async function sprintTitlesByGroupNumber(ctx: TenantContext): Promise<Map<number, string>> {
  const rows = await all<{ title: string; github_ref: string }>(
    ctx,
    `SELECT title, github_ref FROM sprints WHERE org_id = ? AND github_ref IS NOT NULL ORDER BY id ASC`,
    ctx.orgId
  );
  const out = new Map<number, string>();
  for (const r of rows) {
    try {
      const parsed = JSON.parse(r.github_ref) as unknown;
      if (typeof parsed === "number" && !out.has(parsed)) out.set(parsed, r.title);
    } catch { /* malformed ref → claims nothing */ }
  }
  return out;
}

interface IssueSnapshotRow {
  ref_number: number;
  raw: string;
  summary: string | null;
  s_title: string | null;
  s_next_step: string | null;
}

/** One captured PR event (+ its summary join) → the My Work card shape. Shared
 *  with the my_work email renderer so both surfaces summarize identically. */
export function toMyWorkPr(row: PrEventJoinRow): MyWorkPr {
  const parsed = JSON.parse(row.raw) as RawPr;
  return {
    number: parsed.pr.number,
    title: parsed.pr.title,
    url: parsed.pr.html_url,
    merged: parsed.pr.merged,
    occurredAt: row.occurred_at ?? row.recorded_at,
    displayTitle: row.s_title,
    what: row.s_what,
    why: row.s_why,
    impact: row.s_impact,
    baseRef: parsed.pr.base?.ref ?? null,
  };
}

/**
 * Every open issue assigned to any of `logins`, newest-updated first, uncapped.
 * Built from the latest snapshot per ref_number across ALL issue events (not
 * scoped to a known set of numbers — every issue ever captured is a todo
 * candidate). `logins` is every GitHub identity of one person (usually one).
 * The dashboard caps this; the email renderer lists it whole.
 */
export async function listOpenAssignedIssues(ctx: TenantContext, logins: string[]): Promise<MyWorkTodo[]> {
  const issueRows = await all<IssueSnapshotRow>(
    ctx,
    `SELECT e.ref_number, e.raw, s.summary AS summary, s.title AS s_title, s.next_step AS s_next_step
     FROM (
       SELECT ref_number, raw, ROW_NUMBER() OVER (PARTITION BY ref_number ORDER BY occurred_at DESC, id DESC) rn
       FROM events WHERE org_id = ? AND event_type = 'issue'
     ) e
     LEFT JOIN issue_summaries s ON s.issue_number = e.ref_number AND s.org_id = ?
     WHERE e.rn = 1
     ORDER BY e.ref_number ASC`,
    ctx.orgId,
    ctx.orgId
  );
  const sprintByGroup = await sprintTitlesByGroupNumber(ctx);
  const todo: MyWorkTodo[] = [];
  for (const row of issueRows) {
    const parsed = JSON.parse(row.raw) as RawIssue;
    const issue = parsed.issue;
    if (issue.state !== "open") continue;
    if (isIssueGone(parsed.action)) continue; // deleted / transferred: the snapshot still says open
    if (!issue.assignees.some((a) => logins.includes(a.login))) continue;
    const group = issue.milestone; // GitHub's own key — not Trov vocabulary
    const claimed = typeof group?.number === "number" ? sprintByGroup.get(group.number) ?? null : null;
    todo.push({
      number: issue.number,
      title: stripPriority(issue.title),
      priority: priorityOf(issue.title),
      labels: issue.labels,
      url: issue.html_url,
      updatedAt: issue.updated_at,
      summary: row.summary,
      displayTitle: row.s_title,
      // The SPRINT whose github_ref claims this issue's GitHub group number;
      // when none does, the GitHub group's own title stands in. Legacy raws
      // captured before 0018 carry neither — the row is hidden.
      sprint: claimed
        ? { title: claimed, dueOn: group?.due_on ?? null }
        : group?.title
        ? { title: group.title, dueOn: group.due_on ?? null }
        : null,
      nextStep: row.s_next_step,
    });
  }
  // Most recently updated first (updated_at is a GitHub ISO-8601 UTC string —
  // lexicographic order is chronological).
  todo.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return todo;
}

interface AssignedTicketRow {
  id: number;
  number: number;
  title: string;
  body: string;
  category: MyWorkTicket["category"];
  priority: MyWorkTicket["priority"];
  status: MyWorkTicket["status"];
  source: MyWorkTicket["source"];
  requester: string;
  sprint_id: number | null;
  sprint_label: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Which tickets an assigned-ticket read covers. `"canopy"` (the stored `tickets.source` value — it kept its
 * name through the rename to Trov) = NATIVE tickets only
 * (the ticket-queue digest's rule: a ticket mirrored from a GitHub issue (0032) is
 * that issue, which the digest's readers already know about); `"all"` = native AND
 * mirrored (My Work's rule since the redesign: the screen renders no issue list, so
 * a mirrored ticket's only way onto it is as a ticket).
 */
export type AssignedTicketSources = "all" | "canopy";
export interface AssignedTicketOpts { limit?: number; sources?: AssignedTicketSources }

// The shared FROM/WHERE of the list and its count, so the two can never disagree.
// (The sprint LEFT JOIN is on a primary key, so it never changes the count.)
// Binds, in order: org, handle, org, org — `assignedBinds`.
const assignedFrom = (sources: AssignedTicketSources): string =>
  `FROM tickets t
       JOIN ticket_assignees a ON a.ticket_id = t.id AND a.org_id = ? AND a.login = ? COLLATE NOCASE
       LEFT JOIN sprints s ON s.id = t.sprint_id AND s.org_id = ?
      WHERE t.org_id = ? AND t.status IN ${OPEN_STATUS_SQL}${sources === "canopy" ? " AND t.source = 'canopy'" : ""}`;
const assignedBinds = (ctx: TenantContext, handle: string): string[] => [ctx.orgId, handle, ctx.orgId, ctx.orgId];

/**
 * The OPEN tickets `handle` is an assignee of, most recently updated first.
 * D1-only, one query (the sprint label joins in) — the queue is org-scale but a
 * person's own assignments are not. `ticket_assignees.login` holds a person
 * HANDLE (§C.2), so this is keyed on the handle directly, NOT on a GitHub login:
 * a Google-only person (no `identities` row at all) still sees their tickets.
 * The comparison is `COLLATE NOCASE`, matching `persons.handle`'s collation and
 * `getPerson` — a caller spelling the handle in another case must not be told
 * "nothing assigned to you" while holding half the queue.
 * Closed tickets (`done` / `declined`) never appear — My Work is what is open.
 * `sources` defaults to `"canopy"` (NATIVE only) — the ticket-queue digest's rule,
 * which reuses this read. My Work passes `"all"`.
 */
export async function listAssignedTickets(ctx: TenantContext, handle: string, opts: AssignedTicketOpts = {}): Promise<MyWorkTicket[]> {
  const limit = opts.limit ?? TICKET_LIMIT;
  const rows = await all<AssignedTicketRow>(
    ctx,
    `SELECT t.id, t.number, t.title, t.body, t.category, t.priority, t.status, t.source, t.requester,
            t.sprint_id, s.title AS sprint_label, t.created_at, t.updated_at
       ${assignedFrom(opts.sources ?? "canopy")}
      ORDER BY t.updated_at DESC, t.id DESC
      LIMIT ${Math.trunc(limit)}`,
    ...assignedBinds(ctx, handle)
  );
  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    title: r.title,
    body: r.body,
    category: r.category,
    priority: r.priority,
    status: r.status,
    source: r.source,
    requester: r.requester,
    sprint: r.sprint_id !== null && r.sprint_label !== null ? { id: r.sprint_id, label: r.sprint_label } : null,
    updatedAt: r.updated_at,
    createdAt: r.created_at,
  }));
}

/** How many tickets `listAssignedTickets` would list with no cap — the same rule, counted. */
export async function countAssignedTickets(ctx: TenantContext, handle: string, sources: AssignedTicketSources = "canopy"): Promise<number> {
  const row = await first<{ n: number }>(ctx, `SELECT COUNT(*) AS n ${assignedFrom(sources)}`, ...assignedBinds(ctx, handle));
  return row?.n ?? 0;
}

/**
 * The personal My Work projection for `handle` (a person handle). person comes
 * from `persons` directly; an unmapped/unknown handle is a captured-but-
 * unsurfaced no-op (empty projection, degraded:false — the events themselves
 * are never dropped). The GitHub logins to query are every `identities` row
 * for the person — usually just the one login that IS their handle. A person
 * with no GitHub identity at all (e.g. Google-only) surfaces with empty EVENT
 * lists but still gets their assigned tickets (those key on the handle).
 * Any D1 failure degrades the whole projection to empty with degraded:true
 * rather than throwing.
 */
export async function getMyWork(ctx: TenantContext, handle: string): Promise<MyWork> {
  try {
    const me = await getPerson(legacyDb(ctx), handle);
    if (!me) return EMPTY(false);

    // Tickets are keyed on the person HANDLE, not on a GitHub login, so they are
    // read BEFORE the identity fork: a Google-only person (no github identity)
    // has no PRs and no assigned issues but can still own half the queue.
    // ALL sources: the screen shows no issue list any more, so a mirrored ticket
    // (0032) reaches My Work only as a ticket. `ticketsTotal` is the uncapped count.
    const tickets = await listAssignedTickets(ctx, me.handle, { sources: "all" });
    const ticketsTotal = await countAssignedTickets(ctx, me.handle, "all");

    const logins = (await listIdentities(legacyDb(ctx), handle)).filter((i) => i.provider === "github").map((i) => i.subject);
    if (logins.length === 0) return { person: me.name ?? me.handle, previousActivity: [], todo: [], tickets, ticketsTotal, degraded: false };

    const prRows = await all<PrEventJoinRow>(
      ctx,
      `SELECT e.*, s.title AS s_title, s.what AS s_what, s.why AS s_why, s.impact AS s_impact
         FROM events e
         LEFT JOIN pr_summaries s ON s.semantic_key = e.semantic_key AND s.org_id = ?
        WHERE e.org_id = ?
          AND e.event_type IN ('pr_merged', 'pr_closed')
          AND e.subject_login IN (${logins.map(() => "?").join(",")})
        ORDER BY e.occurred_at DESC, e.id DESC
        LIMIT ${PR_LIMIT}`,
      ctx.orgId,
      ctx.orgId,
      ...logins
    );
    const previousActivity: MyWorkPr[] = prRows.map(toMyWorkPr);
    const todo = await listOpenAssignedIssues(ctx, logins);

    return { person: me.name ?? me.handle, previousActivity, todo: todo.slice(0, TODO_LIMIT), tickets, ticketsTotal, degraded: false };
  } catch {
    return EMPTY(true);
  }
}

/** Recent captured GitHub events, optionally filtered by type/subject. The raw
 *  log behind My Work and roadmap progress. */
export async function list_events(
  ctx: TenantContext,
  filter?: { type?: "pr_merged" | "pr_closed" | "issue"; subject?: string; limit?: number }
): Promise<EventRow[]> {
  const clauses: string[] = [`org_id = ?`];
  const params: unknown[] = [ctx.orgId];
  if (filter?.type) {
    clauses.push(`event_type = ?`);
    params.push(filter.type);
  }
  if (filter?.subject) {
    clauses.push(`subject_login = ?`);
    params.push(filter.subject);
  }
  const limit = Math.trunc(Math.min(Math.max(filter?.limit ?? 50, 1), 500));

  return all<EventRow>(
    ctx,
    `SELECT * FROM events WHERE ${clauses.join(" AND ")} ORDER BY occurred_at DESC, id DESC LIMIT ${limit}`,
    ...params
  );
}

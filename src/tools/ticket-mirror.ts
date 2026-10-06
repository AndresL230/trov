// The GitHub issue → ticket MIRROR. Every issue in GITHUB_REPO appears as a
// ticket, linked to the issue by a LOCKED link that can never be removed.
//
// ADR-007, amended (0032): a ticket may link to GitHub work, and may be SOURCED
// from a GitHub issue, but is never the issue itself. A mirrored ticket is a D1
// row Trov owns, and this module is a COMPUTED write from a verified delivery
// (the webhook, post-HMAC, or the admin backfill) — no `consume()`, no gate.
//
// Who owns what (the owner's ruling, 2026-09-24):
//   - title, body, category, priority, requester, assignees: seeded from the
//     issue when the ticket is CREATED, then Trov's — a later GitHub edit never
//     overwrites a Trov edit, and a GitHub (un)assign never touches assignees.
//   - status: Trov's, under the normal transition table — EXCEPT that GitHub
//     drives closure. A `closed` delivery forces the final state (done /
//     declined), a `deleted` / `transferred` one forces declined, and a
//     `reopened` one reopens a resolved ticket to `submitted`. Those forced moves
//     go through `forceStatus` below (a person may make any move too; the mirror's
//     writer just carries GitHub's actor and `source_updated_at`), which is NOT exported: no route or MCP tool
//     can reach it. Every forced move writes a `ticket_events` row as
//     `github-webhook`.
//   - the source link: locked forever (`ticket_links.locked = 1`); the one delete
//     path, `remove_ticket_link`, refuses it.
//
// Idempotency and ordering: the ticket is keyed on `source_ref` ("owner/repo#n",
// UNIQUE). A delivery whose issue.updated_at is OLDER than the ticket's
// `source_updated_at` is skipped whole. Creation is ONE D1 batch (a transaction)
// whose child inserts are each guarded, so re-running it — a redelivery, a
// backfill overlap, or the heal after a half-failed earlier attempt — writes
// nothing twice.

import { parseTicketLink, type TicketCategory, type TicketPriority, type TicketStatus } from "@shared/tickets";
import { type TenantContext, type Stmt, first, run, stmt, batch, nowIso } from "../data/sql";
import type { PlatformContext } from "../data/platform-sql";
import { priorityOf, stripPriority } from "./mywork";
import { resolvePersonForLogin } from "../auth/persons";
import { isIssueGone } from "./issue-gone";

/** The mirror's writer principal — a reserved handle with a persons row (0032). */
export const MIRROR_ACTOR = "github-webhook";

interface GhUserLite { login: string }
interface MirrorIssuePayload {
  action?: string;
  repository?: { full_name?: string } | null;
  issue?: {
    number: number;
    title: string;
    body?: string | null;
    html_url: string;
    state: string;
    state_reason?: string | null;
    updated_at: string;
    user: GhUserLite;
    assignees?: GhUserLite[] | null;
    labels?: (string | { name: string })[] | null;
    pull_request?: unknown;
  };
}

/** Everything the mirror needs from one delivery, derived PURELY (no DB, no clock). */
export interface IssueMirror {
  repo: string;             // repository.full_name
  sourceRef: string;        // "owner/repo#n"
  number: number;
  htmlUrl: string;
  action: string;
  title: string;            // the [P0]–[P3] tag stripped
  body: string;
  priority: TicketPriority;
  category: TicketCategory;
  authorLogin: string;      // raw GitHub login — stored as source_author, never a handle
  assigneeLogins: string[]; // raw GitHub logins, resolved to handles by the caller
  updatedAt: string;
  /** The final ticket status GitHub implies, or null while the issue is open. */
  final: "done" | "declined" | null;
}

const PRIORITY: Record<"P0" | "P1" | "P2" | "P3", TicketPriority> = { P0: "high", P1: "high", P2: "normal", P3: "low" };

const labelNames = (labels: (string | { name: string })[] | null | undefined): string[] =>
  (labels ?? []).map((l) => (typeof l === "string" ? l : l?.name)).filter((n): n is string => typeof n === "string" && n !== "");

/**
 * PURE: map one `issues` delivery onto the ticket fields. Null for anything that
 * is not a mirrorable issue: a non-object payload, a PR delivered on the issues
 * event, or a payload without its repository (the mirror's scope key).
 *
 *   title    — the issue title, `[P0]`–`[P3]` tag stripped
 *   priority — that tag (else a `P0`–`P3` LABEL): P0/P1 high, P2 normal, P3 low, none normal
 *   category — label `bug` → bug, label `question` → question, else other
 *   final    — closed: state_reason not_planned / duplicate → declined, else done;
 *              a deleted / transferred delivery → declined; open → null
 */
export function ticketFromIssue(payload: unknown): IssueMirror | null {
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as MirrorIssuePayload;
  const issue = p.issue;
  const repo = p.repository?.full_name;
  if (!issue || issue.pull_request || typeof repo !== "string" || !repo) return null;
  if (typeof issue.number !== "number" || typeof issue.html_url !== "string" || typeof issue.title !== "string") return null;

  const labels = labelNames(issue.labels);
  const lower = labels.map((l) => l.toLowerCase());
  const tag = priorityOf(issue.title) ?? (labels.find((l) => /^P[0-3]$/.test(l)) as "P0" | "P1" | "P2" | "P3" | undefined) ?? null;
  const action = p.action ?? "";

  let final: IssueMirror["final"] = null;
  if (isIssueGone(action)) final = "declined";
  else if (issue.state === "closed") final = issue.state_reason === "not_planned" || issue.state_reason === "duplicate" ? "declined" : "done";

  return {
    repo,
    sourceRef: `${repo}#${issue.number}`,
    number: issue.number,
    htmlUrl: issue.html_url,
    action,
    title: stripPriority(issue.title) || issue.title,
    body: issue.body ?? "",
    priority: tag ? PRIORITY[tag] : "normal",
    category: lower.includes("bug") ? "bug" : lower.includes("question") ? "question" : "other",
    authorLogin: issue.user.login,
    assigneeLogins: (issue.assignees ?? []).map((a) => a.login),
    updatedAt: issue.updated_at,
    final,
  };
}

export type MirrorOutcome =
  | "out_of_scope"  // not an issue of GITHUB_REPO (or GITHUB_REPO unset)
  | "created"       // a new ticket
  | "updated"       // an existing ticket: a forced status move, or a newer source_updated_at
  | "unchanged"     // a redelivery — nothing to write
  | "stale";        // older than the last applied delivery — skipped whole

interface MirrorTicketRow {
  id: number;
  status: TicketStatus;
  source_updated_at: string | null;
}

/**
 * Apply one `issues` delivery to its mirrored ticket. `repo` is env.GITHUB_REPO:
 * unset mirrors nothing, and only an issue whose repository.full_name equals it
 * (ignoring case) is mirrored. Throws only on a D1 failure — the webhook wraps it so the `events`
 * capture never pays for a mirror failure. A SYSTEM write (§4.1): `ctx` is the org the delivery belongs
 * to, never a member's; `p` reads the global login → person map.
 */
export async function mirrorIssue(ctx: TenantContext, p: PlatformContext, repo: string | undefined, payload: unknown): Promise<MirrorOutcome> {
  if (ctx.role !== "system") throw new Error("mirrorIssue is a system write");
  const parsed = ticketFromIssue(payload);
  // GitHub treats owner/repo names case-INsensitively, and its deliveries carry
  // the repo's canonical spelling ("SaplingLearn/Sapling") while GITHUB_REPO may
  // not ("SaplingLearn/sapling"). So scope compares without case, and the key is
  // ALWAYS built from the configured spelling — else the webhook and a backfill
  // (which reconstructs full_name FROM GITHUB_REPO) would key one issue twice.
  if (!parsed || !repo || parsed.repo.toLowerCase() !== repo.toLowerCase()) return "out_of_scope";
  const m: IssueMirror = { ...parsed, repo, sourceRef: `${repo}#${parsed.number}` };

  const existing = await first<MirrorTicketRow>(
    ctx, `SELECT id, status, source_updated_at FROM tickets WHERE source_ref = ? AND org_id = ?`, m.sourceRef, ctx.orgId);

  if (!existing) {
    // An issue that left the repo before it was ever mirrored has nothing to decline.
    if (isIssueGone(m.action)) return "unchanged";
    await createMirrored(ctx, p, m);
    return "created";
  }

  // The ordering guard: an older delivery never overwrites a newer one.
  if (existing.source_updated_at !== null && m.updatedAt < existing.source_updated_at) return "stale";

  // Heal a creation that half-landed in an earlier attempt (the batch below is a
  // transaction, so this is belt and braces): the locked link and the opening row.
  let wrote = await healMirrored(ctx, existing.id, m, existing.status);

  // A delivery ALREADY applied (same updated_at) forces nothing: a person may
  // have moved the status in Trov since, and a redelivery must not undo that.
  // The move and the new source_updated_at land in ONE batch, so a failure
  // leaves source_updated_at behind and the redelivery re-applies the move.
  const alreadyApplied = existing.source_updated_at === m.updatedAt;
  const forced = alreadyApplied ? null : forcedStatus(m, existing.status);
  if (forced) {
    await forceStatus(ctx, existing.id, existing.status, forced, m.updatedAt);
    wrote = true;
  } else if (!alreadyApplied) {
    await run(ctx, `UPDATE tickets SET source_updated_at = ? WHERE id = ? AND org_id = ?`, m.updatedAt, existing.id, ctx.orgId);
    wrote = true;
  }
  return wrote ? "updated" : "unchanged";
}

/**
 * The status GitHub FORCES on an existing ticket, or null. Only the actions that
 * change an issue's open/closed state force anything — every other delivery
 * (edited, labeled, assigned…) leaves the Trov-owned status alone.
 */
function forcedStatus(m: IssueMirror, current: TicketStatus): TicketStatus | null {
  if ((m.action === "closed" || isIssueGone(m.action)) && m.final && current !== m.final) return m.final;
  if (m.action === "reopened" && (current === "done" || current === "declined")) return "submitted";
  return null;
}

/**
 * THE internal status writer — the mirror's only way to move a status, writing
 * as `github-webhook` and stamping `source_updated_at`. Module-private on
 * purpose: routes and MCP reach status only through `transition_ticket`.
 */
async function forceStatus(ctx: TenantContext, id: number, from: TicketStatus, to: TicketStatus, sourceUpdatedAt: string): Promise<void> {
  const now = nowIso();
  await batch(ctx, [
    stmt(ctx, `INSERT INTO ticket_events (org_id, ticket_id, actor, from_status, to_status, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ctx.orgId, id, MIRROR_ACTOR, from, to, now),
    stmt(ctx, `UPDATE tickets SET status = ?, board_rank = NULL, updated_at = ?, source_updated_at = ? WHERE id = ? AND org_id = ?`,
      to, now, sourceUpdatedAt, id, ctx.orgId),
  ]);
}

/** Resolve GitHub logins to person handles; an unmapped login is dropped. */
async function handlesFor(ctx: TenantContext, logins: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const login of logins) {
    const person = await resolvePersonForLogin(ctx, login);
    if (person && !out.includes(person.handle)) out.push(person.handle);
  }
  return out;
}

/** The ticket's ONE locked link: the issue itself. */
const sourceLink = (m: IssueMirror) => parseTicketLink(m.htmlUrl);

/**
 * Create the ticket, its assignees, its opening history row and its locked link
 * in ONE batch. Every child insert selects the ticket BY (org, source_ref) and is
 * guarded, so if a concurrent delivery created the ticket first (the parent
 * INSERT OR IGNOREs) nothing is duplicated. Assignees are part of the opening
 * unit — inserted only while the ticket has no history yet — so a replay can
 * never re-add someone a person has since unassigned in Trov.
 */
async function createMirrored(ctx: TenantContext, p: PlatformContext, m: IssueMirror): Promise<void> {
  const requester = (await resolvePersonForLogin(ctx, m.authorLogin))?.handle ?? MIRROR_ACTOR;
  const assignees = await handlesFor(ctx, m.assigneeLogins);
  const status: TicketStatus = m.final ?? (assignees.length > 0 ? "in_progress" : "submitted");
  const link = sourceLink(m);
  const now = nowIso();
  const org = ctx.orgId;
  // Binds (source_ref, org) at each use.
  const TID = `(SELECT id FROM tickets WHERE source_ref = ? AND org_id = ?)`;

  const stmts: Stmt[] = [
    stmt(ctx,
      `INSERT OR IGNORE INTO tickets
         (org_id, title, body, category, priority, status, requester, parent_id, sprint_id, created_at, updated_at,
          source, source_ref, source_author, source_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, 'github', ?, ?, ?)`,
      org, m.title, m.body, m.category, m.priority, status, requester, now, now, m.sourceRef, m.authorLogin, m.updatedAt),
    ...assignees.map((h) =>
      stmt(ctx,
        `INSERT OR IGNORE INTO ticket_assignees (org_id, ticket_id, login)
         SELECT ?, ${TID}, ? WHERE NOT EXISTS (SELECT 1 FROM ticket_events WHERE org_id = ? AND ticket_id = ${TID})`,
        org, m.sourceRef, org, h, org, m.sourceRef, org)),
    stmt(ctx,
      `INSERT INTO ticket_events (org_id, ticket_id, actor, from_status, to_status, created_at)
       SELECT ?, ${TID}, ?, NULL, ?, ? WHERE NOT EXISTS (SELECT 1 FROM ticket_events WHERE org_id = ? AND ticket_id = ${TID})`,
      org, m.sourceRef, org, MIRROR_ACTOR, status, now, org, m.sourceRef, org),
  ];
  if (link) {
    stmts.push(stmt(ctx,
      `INSERT INTO ticket_links (org_id, ticket_id, url, kind, label, meta, created_by, created_at, locked)
       SELECT ?, ${TID}, ?, ?, ?, ?, ?, ?, 1
        WHERE NOT EXISTS (SELECT 1 FROM ticket_links WHERE org_id = ? AND ticket_id = ${TID} AND locked = 1)`,
      org, m.sourceRef, org, link.url, link.kind, link.label, link.meta, MIRROR_ACTOR, now, org, m.sourceRef, org));
  }
  await batch(ctx, stmts);
}

/** Re-add the locked link / opening row if either is missing. True when it wrote. */
async function healMirrored(ctx: TenantContext, id: number, m: IssueMirror, status: TicketStatus): Promise<boolean> {
  let wrote = false;
  const link = sourceLink(m);
  if (link) {
    const res = await run(ctx,
      `INSERT INTO ticket_links (org_id, ticket_id, url, kind, label, meta, created_by, created_at, locked)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, 1
        WHERE NOT EXISTS (SELECT 1 FROM ticket_links WHERE ticket_id = ? AND org_id = ? AND locked = 1)`,
      ctx.orgId, id, link.url, link.kind, link.label, link.meta, MIRROR_ACTOR, nowIso(), id, ctx.orgId);
    wrote ||= (res.meta.changes ?? 0) > 0;
  }
  const res = await run(ctx,
    `INSERT INTO ticket_events (org_id, ticket_id, actor, from_status, to_status, created_at)
     SELECT ?, ?, ?, NULL, ?, ? WHERE NOT EXISTS (SELECT 1 FROM ticket_events WHERE ticket_id = ? AND org_id = ?)`,
    ctx.orgId, id, MIRROR_ACTOR, status, nowIso(), id, ctx.orgId);
  wrote ||= (res.meta.changes ?? 0) > 0;
  return wrote;
}

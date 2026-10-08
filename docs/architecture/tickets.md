# Tickets, the board, sprints-from-MCP and the GitHub mirror

<!-- Moved verbatim out of CLAUDE.md (2026-10-07). This is the detailed reference; CLAUDE.md keeps only what applies to every change. Keep it current when you change the area. A reference to another section ("see Core invariant", "the Repo dashboard section below") now means another file in this folder — see the table at the bottom of CLAUDE.md. -->

**Tickets are the largest authored-write surface** (`src/tools/tickets.ts`, fourteen session-cookie routes in
`routes.ts`): `create_ticket` (opening `ticket_events` row) / `edit_ticket` (title and/or body) / `transition_ticket` / `move_ticket` (a board drop) / `toggle_assignee` /
`add_ticket_link` / `remove_ticket_link` / `set_ticket_sprint` / `set_ticket_parent` / `add_ticket_comment` /
`delete_ticket` (`POST /tickets/:id/delete`, any signed-in member, NEVER MCP: a HARD delete in one `db.batch` —
assignees, links, comments, history and `artifact_links` rows go with it, sub-tickets are detached, the number is
never reissued; a ticket MIRRORED from a GitHub issue is a 403, since the mirror would only re-create it; on screen
"Delete ticket" at the bottom of the rail, native tickets only, through the shared confirmation modal). There is no vocab
gate, no confidence, no staged state. Every write bumps `tickets.updated_at` (the queue's sort key); the
status machine is `canTransition` in `shared/tickets-core.ts` (re-exported by `shared/tickets.ts`) and is
never re-declared server-side; an illegal move or a nesting-rule break is a 409 that writes nothing;
tickets nest exactly ONE level (`set_ticket_parent`'s four rejections).

**The ticket board** (the queue's DEFAULT view, `web/src/tickets.ts` `boardView`; the Table is the other).
Statuses are `submitted` (Triage) / `in_progress` / `testing` / `done` / `declined` — `testing` (0033) is an
optional step, not a gate. Every move is FREE (the owner's call, 2026-09-27): ANY status may move to any other —
Triage straight to Done, and `done` / `declined` back to an open status (nothing is terminal; only a move to the
status a ticket already has is a 409). The OPEN statuses are `OPEN_STATUSES`, spelled `OPEN_STATUS_SQL` in every
SQL reader (My Work, the badge, the Repo tile, `seg=open`). Each column is in
a SAVED order, `tickets.board_rank`, written only by a drag: `POST /tickets/:id/move {to, after_id}` →
`move_ticket` sets status AND position in one batch (a status change appends the same history row as
`transition_ticket`; a same-column drop only reorders). NULL = no position = the TOP of the column,
newest-updated first — every ticket before its first drag, a new ticket, and any status move that is not a
drop (`transition_ticket` and the mirror's `forceStatus` both write `board_rank = NULL`, so a ticket moved by
the status menu, MCP or GitHub surfaces on top). The comparator `boardOrder` and the placement
`placeInColumn` (`shared/tickets-core.ts`) are ONE definition shared by the Worker and the SPA's optimistic
drop: a column holding a NULL is renumbered in its visible order first (`BOARD_RANK_STEP` apart), and so is
one whose neighbours are too close to split. The drag is POINTER-driven (`web/src/main.ts`), never HTML5
drag-and-drop — the browser's drag image is a shrunken snapshot the page cannot size: a full-size clone
follows the pointer, a slot the other cards slide around (FLIP) marks where it will land, rerenders are
HELD for the whole drag, and the click a drag's release fires is swallowed. Mouse and pen only — touch
scrolls. The queue's search box and Filter menu (Assignee incl. any one person, Category, Priority, Sprint)
are the Artifacts library's; Assignee (anyone / me / unassigned) and Category filter server-side, a person,
Priority, Sprint and search narrow the loaded rows (`queueRows`).

**The writer is a PERSON — over a cookie, or over their own bearer token.** Eight of those writers are also
MCP tools (`src/tools/tickets-agent.ts`, the read side below), scoped so an agent writes only inside its
principal's lane. That is a narrowing of the old "ticket writes are cookie-only" rule, not of the
invariant underneath it: **nothing INFERS a resolution.** `done` / `declined` are never set by a PR
merging, an issue closing, the webhook, or `scheduled()` — a person asks for them, and an agent holding
that person's token asking is that person asking. ONE carve-out: a ticket MIRRORED from a GitHub issue
follows its OWN source issue's close and reopen (see "Tickets mirrored from GitHub issues"); a native
ticket that merely links an issue never does. `toggle_assignee` reaches MCP as `assign_ticket` (issue #90,
2026-09-27), which REVERSES design D3 ("no MCP counterpart, forever — assignment is the data the lane rule is
built on"): leads had to assign agent-split work by hand, ticket by ticket, and teammates GitHub cannot reach
could not be assigned at all. Because assignment is how a ticket gets INTO a lane, the lane cannot scope it, so
it has its own rule (below).

**MCP ticket/sprint reads are unscoped; the writes are not** — `src/mcp.ts` registers `list_tickets`
(`seg` / `assignee` where `me` = the bearer principal / `category`), `get_ticket`, `list_sprints` and
`get_sprint` for EVERY principal (not admin-gated): seeing the org's queue is how an agent orients.

**The write surface is `src/tools/tickets-agent.ts` — the ONE place the lane rule is drawn** (spec:
`docs/superpowers/specs/2026-09-17-agent-ticket-writes-design.md`). A ticket write over MCP is permitted
exactly when the bearer principal is ALREADY an assignee of that ticket, else `TicketError('forbidden')`
(403) with NOTHING written; an unknown id is `not_found` FIRST, so the check is never an existence
oracle. Each of the eight tools (`create_ticket` / `edit_ticket` / `transition_ticket` / `add_ticket_comment` /
`add_ticket_link` / `set_ticket_sprint` / `set_ticket_parent` / `assign_ticket`) asserts, then delegates to the
UNTOUCHED writer in `tools/tickets.ts` — the transition table, nesting rules and audit rows stay shared with the
cookie routes, which are NOT assignee-scoped and did not change. `create_ticket` is the one unscoped
write (filing is how work enters the queue); `set_ticket_parent` needs the lane on BOTH ids. TWO exceptions to
the lane: an **admin** may `set_ticket_sprint` on any ticket (composing a sprint is sprint management) — it
spreads to no other verb; and **`assign_ticket { id, login, on }`** (over `toggle_assignee`) is scoped by
`assertTicketAssignable` instead — the bearer must be an ADMIN, the ticket's REQUESTER or a CURRENT ASSIGNEE
(NOCASE), else 403 with nothing written, `not_found` first as ever. It is idempotent WITHOUT a write (adding
someone already on it / removing someone who is not returns before `toggle_assignee`, which would still bump
`updated_at`), still validates the handle on that path (`requirePerson`: unknown or RESERVED → `bad_request`),
never touches status, writes no history row (`ticket_events` audits status moves only — assignment has no audit,
from the web either), and works on mirrored tickets (their assignees are Trov's after import). **Sprint writes are
open to every principal** (`create_sprint` / `set_sprint_active` / `complete_sprint` /
`add_sprint_resource` / `delete_sprint`), matching the web, where every sprint route sits under
`sessionGate` with no `adminGate`; only the whole-plan rewrite `update_plan` stays admin-only. **No provenance is stored** (design D4): an
MCP write is recorded as the person, indistinguishable from a click.

## Tickets mirrored from GitHub issues — ADR-007, amended (`src/tools/ticket-mirror.ts`, `0032_ticket_source`)

ADR-007 now reads: **a ticket may link to GitHub work, and may be sourced from a GitHub issue, but is never the
issue itself.** Every issue of `GITHUB_REPO` is mirrored into a ticket (`source = 'github'`, `source_ref`
`owner/repo#n`, UNIQUE; `source_author` = the raw GitHub login, NOT a handle, so it is not in
`HANDLE_COLUMNS`). The mirror is a COMPUTED write from a verified delivery — no `consume()`.

- **Where it runs**: `handleGithubWebhook` calls `mirrorIssue` on EVERY verified `issues` delivery (not only
  when `ingestEvent` wrote — a redelivery heals a half-failed mirror), wrapped so a failure never costs the
  `events` capture; `runBackfill` calls the SAME function for OPEN issues, and its reconstructed deliveries
  (and `scripts/backfill-events.mjs`') carry `repository.full_name`. Only an issue whose
  `repository.full_name === GITHUB_REPO` is mirrored; unset `GITHUB_REPO` mirrors nothing; PRs are skipped.
- **Mapping** (`ticketFromIssue`, pure): the `[P0]`–`[P3]` title tag (else a `P0`–`P3` label) → high / high /
  normal / low, none → normal, stripped from the title; label `bug` / `question` → that category, else
  `other`; the requester is `resolvePersonForLogin(author)` or the system person `github-webhook`; GitHub
  assignees map through `identities` (unmapped dropped); open → `in_progress` with a mapped assignee, else
  `submitted`; closed `completed` → `done`, `not_planned` / `duplicate` → `declined`.
- **Ownership (the owner's ruling)**: title, body, category, priority, requester and assignees are seeded at
  IMPORT and are Trov's afterwards — later deliveries never overwrite them, and they are edited like any
  ticket (`edit_ticket`, `toggle_assignee` — `assign_ticket` over MCP — the normal transition table). GitHub drives only CLOSURE: a
  `closed` delivery forces `done`/`declined`, `deleted` / `transferred` forces `declined`, `reopened` puts a
  resolved ticket back to `submitted` — through the module-private `forceStatus`, the ONE writer allowed to
  bypass `TICKET_TRANSITIONS`, writing a `ticket_events` row as `github-webhook`. Trov never writes back to
  GitHub, and a sprint is still completed only by a person.
- **Idempotency / ordering**: creation is ONE guarded D1 batch (ticket, assignees, opening row, locked link —
  each child keyed by `source_ref`), so a replay writes nothing twice; a delivery older than
  `source_updated_at` is skipped whole; one already applied (same `updated_at`) forces nothing, so a
  redelivery cannot undo a later Trov change.
- **The lock**: the source link is inserted `locked = 1`; `remove_ticket_link` (the ONLY link delete path —
  there is deliberately no trigger, the harness truncates `ticket_links`) refuses it with 403 and the UI
  shows a lock with no Remove row. Everything else stays writable.
- **No double counting**: `listAssignedTickets` with its DEFAULT `sources: "canopy"` (the ticketq digest's
  own half), `ticket_badge`, the digest's unassigned half and the Repo dashboard's Open tickets tile read
  `source = 'canopy'`; sprint progress counts both, and so does My Work (`sources: "all"` — its screen no
  longer shows the To-do issue list, so the mirrored ticket is the ONE place that work appears there). `deleted` / `transferred` are captured issue actions, and every open-issue reader
  (My Work's To-do, array-ref progress, the Repo dashboard's open issues) treats them as no longer open
  (`src/tools/issue-gone.ts`).
- **`github-webhook`** is a reserved handle with a `persons` row (seeded by 0032 AND `reset.mjs`, which
  truncates persons): `listPersons` never lists a reserved handle and the ticket writers' `requirePerson`
  refuses one, so it can never be assigned, file, comment or link.

---
name: tickets
description: Use when a person explicitly asks to work the Trov ticket queue — file a ticket, assign or unassign someone, start or resolve one, comment on it, link work to it, move it into a sprint, nest it under another, or create and manage sprints (triggers — "file a ticket for…", "assign 12 to meilin", "start that ticket", "mark it done", "comment on ticket 12", "move this to sprint 13", "create a sprint"). Reading the queue needs no skill. Explicit invocation only for writes — must never auto-fire.
disable-model-invocation: true
allowed-tools: mcp__trov__list_tickets, mcp__trov__get_ticket, mcp__trov__list_sprints, mcp__trov__get_sprint, mcp__trov__list_people, mcp__trov__create_ticket, mcp__trov__edit_ticket, mcp__trov__transition_ticket, mcp__trov__add_ticket_comment, mcp__trov__add_ticket_link, mcp__trov__set_ticket_sprint, mcp__trov__set_ticket_parent, mcp__trov__assign_ticket, mcp__trov__create_sprint, mcp__trov__set_sprint_active, mcp__trov__complete_sprint, mcp__trov__add_sprint_resource, mcp__trov__get_connection, Bash(git remote get-url:*)
---

# Tickets → Trov

## Overview

Works the org's ticket queue — the one queue the whole team files into. A ticket is a Trov D1 row
(ADR-007, amended): it may *link* to GitHub or Figma work, and may be *sourced from* a GitHub issue,
but it is never the issue itself.

**Mirrored tickets.** Every GitHub issue of the tracked repo also appears as a ticket (`source:
"github"`, `source_ref` `owner/repo#n`), linked to its issue by a **locked** link nobody can remove.
Its title, body, category, priority and assignees were copied from the issue once, at import — after
that they are Trov's, and you edit them like any other ticket (`edit_ticket`, inside your lane). The
one thing GitHub still drives is **closure**: closing the issue sets the ticket `done` (or `declined`
when closed as not planned, deleted or transferred), and reopening it reopens the ticket.

These are **direct authored writes in the promote class** — the same class the web UI writes in.
There is no gate, no staging and no triage step: a ticket write **takes effect immediately and is
visible to the whole org**. That is why this skill is **explicit-only**, like `update-plan` and
`record-session`. It must never auto-fire.

Part of the **`trov`** skill set. Reading the queue does not need this skill at all — the four read
tools are available to every principal and documented in the `trov` umbrella.

## The lane rule — read this before anything else

> **You may write only to tickets already assigned to you.** Filing a new ticket is the one
> unscoped write, and assigning has a rule of its own (below).

This is enforced by the Worker, not by this skill. A write outside the lane comes back
`{"error": "…not assigned to you…", "code": "forbidden"}` and **nothing is written**.

Three consequences worth knowing before you promise a person anything:

- **Assigning after filing is `assign_ticket`, and it has its OWN scope** — the lane can't bound it,
  because assignment is how a ticket gets into a lane. `assign_ticket { id, login, on }` adds (`on:
  true`) or removes (`on: false`) one assignee, and only an **admin**, the ticket's **requester** or one
  of its **current assignees** may call it; anyone else gets `forbidden` and nothing is written. It is
  idempotent (adding someone already on it, or removing someone who isn't, is a success that writes
  nothing), it **never changes status**, and it records no history row. `login` is a handle from
  `list_people` (step 1), never a guess — the same goes for `create_ticket`'s `assignees`.
- **You cannot pick work up off the unassigned pile** unless your principal is an admin or filed it.
  Otherwise somebody who may assign it (an admin, its requester, an assignee) has to put your principal
  on it first. Say that plainly rather than trying and reporting a failure.
- **You cannot triage other people's tickets** — not comment, not resolve, not re-parent. An admin is
  the one exception, and only for `set_ticket_sprint` (re-homing a ticket into a sprint).

`get_ticket` returns `assignees`. **Check it before proposing a write**, so you never offer to do
something the server will refuse.

## When to use / NOT use

- Use when a person **explicitly** asks for a ticket or sprint change in words like the triggers above.
- **Never auto-fire.** Noticing that a ticket looks stale, that a bug you just fixed has a ticket, or
  that a sprint looks finished is **not** license to write. Reading is free; writing is asked for.
- **Not** for recording what a session did — that's `record-session` (feed / docs / ADRs, through the
  gate). A ticket is somebody's request, not a session log.
- **Not** for the roadmap narrative or a bulk sprint reshape — that's `update-plan`.
- **Never infer a resolution.** `done` / `declined` are set because a person said so in this
  conversation. A merged PR, a closed issue, or every sub-ticket resolving is **not** a person saying
  so. This is Trov's oldest ticket invariant and this skill is not an exception to it. (The one
  exception is the Worker's, not yours: a MIRRORED ticket follows its own source issue's close and
  reopen. A native ticket that merely links an issue never does.)

## Which organization — pass `repo` on every call

One Trov connection covers every organization you belong to, so every Trov tool takes the repository
you are working in. Once per session, run `git remote get-url origin` and reduce it to `owner/name`
(`git@github.com:acme/app.git` and `https://github.com/acme/app` are both `acme/app`). Pass that as
`repo` on EVERY Trov call this skill makes. No remote, or not a GitHub one: leave `repo` out.

- A connection that **follows the repository** acts in the organization that has that repository
  connected. `repo_required` / `not_connected` mean NOTHING was read or written: tell the person this
  repository is not connected to any of their organizations (Trov › Org settings › Repositories) and
  stop — never pass a different repository to get an answer. `ambiguous_org` lists the candidates:
  ask the person which, then pass it as `org`.
- A **manual** connection ignores `repo` and acts in its current organization. `org_unavailable` /
  `org_not_allowed` list what it may use: ask the person, never guess, and prefer `org` on the call
  over `switch_org` (a switch moves every session that shares the connection).
- Not sure where you are? `get_connection` (same `repo`) answers: the organization this call would
  act in, the connection's mode, and what it can reach.

## Procedure

### 1. Orient — read before you write

Never write from the conversation's memory of a ticket. Read it back:

- `list_tickets` — `seg` (`open` default / `closed` / `all`), `assignee` (`anyone` / `me` /
  `unassigned`), `category`. Use `assignee: "me"` to find your own lane.
- `get_ticket <id>` — the whole ticket, including **`assignees`** (your lane check) and `status`
  (which moves are even legal).
- `list_sprints` / `get_sprint <id>` before any sprint move, so you name a real sprint.
- `list_people` before **filing with assignees** — every person's `handle`, `name`, `role` and
  `responsibilities`. Propose the person whose role and responsibilities fit the work, by handle; a
  null `role` / `responsibilities` means unknown, so never infer what someone owns from a name. If
  nobody clearly fits, propose filing it unassigned (or ask). The same read comes before
  `assign_ticket`.

### 2. Check the lane, and say so if you're outside it

If your principal is not in `assignees`, **stop**. Tell the person which ticket it is, that it is not
assigned to them, and who can assign it (an admin, its requester or an assignee — in the web UI or with
`assign_ticket`). Do not call the tool to produce a refusal you could have predicted.

For `assign_ticket` the check is different: you may call it when your principal is an admin, the
ticket's `requester`, or in its `assignees`. Otherwise stop and say who can.

### 3. Load the team's config, and show a one-line diff

Read `tickets.config.md` (see `references/config.md` — repo root or `.claude/`, all keys optional).
Then show the person exactly what you are about to send, in one line:

```
file ticket · "CSV export drops the header row" · bug / high · sprint: Backlog · assignees: andres
move #42 · submitted → in_progress
assign #42 · + meilin   (unassign: − meilin)
```

Wait for confirmation unless the config sets `require_confirmation: false`. **Always** confirm for
`done` and `declined` — those resolve the ticket for the whole org (a person can still move it back
later, but the whole team sees it resolved until then).

`--dry-run`: print the line above and **stop**. No tool call.

### 4. One call, then report what changed

Report what the response actually says, not what you intended to happen. The two surfaces return
different shapes, so do not go looking for ticket fields after a sprint write:

- **Ticket writes** return the whole ticket — read `status`, `assignees` and `sprint` back off it.
- **Sprint writes** return sprint data and no ticket at all: `create_sprint`, `set_sprint_active` and
  `complete_sprint` return the sprint view (`label`, `due`, `status`/`active`, progress), and
  `add_sprint_resource` returns that view plus the sprint's tickets and merged resources.

If the call came back with a `code`, say what it means and what the person should do:

| code | what it means | what to say |
|---|---|---|
| `forbidden` | outside your lane (or, for `assign_ticket`, not an admin, the requester or an assignee) | who can assign it — an admin, its requester or an assignee |
| `conflict` | a shared rule said no — a move to the status it already has, or a nesting rule | which rule |
| `bad_request` | your input was wrong — an unknown handle, an unusable link, an empty comment | the specific field |
| `not_found` | no such ticket or sprint | the id you used |

## The status machine

One table, shared with the web UI and the server: **any status may move to any other.**

```
submitted | in_progress | testing | done | declined  →  any of the other four
```

`done` and `declined` are not terminal — a ticket resolved by mistake, or whose work turned out
unfinished, is moved back to an open status. `testing` is an optional step between In progress and
Done, not a gate. `seg=open` covers `submitted` / `in_progress` / `testing`.

Nesting is exactly **one level**: `set_ticket_parent` fails as a `conflict` if the parent already has
a parent, the child already has a parent, the child is resolved, or the child has sub-tickets of its
own. You need the lane on **both** tickets.

## Sprints

`create_sprint`, `set_sprint_active`, `complete_sprint`, `add_sprint_resource` and `delete_sprint` are
open to every principal, like the web's sprint routes. Which *tickets* are in a sprint is
`set_ticket_sprint`, not a sprint tool.

`delete_sprint` is permanent: the sprint is gone and its tickets move to the backlog. **Always confirm
with the person first**, naming the sprint and how many tickets it holds.

`complete_sprint` reports to the whole org that a body of work finished. **Always confirm with the
person first**, and never infer it from the sprint's tickets all being resolved — the Roadmap computes
progress from tickets, but `done` is a person's statement.

## Hard rules

- **Never auto-fire.** Explicit ask only.
- **Never infer `done` / `declined`**, on a ticket or a sprint — a mirrored ticket's closure is the
  Worker following GitHub, never something you do on its behalf.
- **Never claim you assigned someone** without reading it back — report the `assignees` the call
  returned, not the ones you asked for.
- **Read the ticket back before writing it**, every time.
- **Your writes are attributed to your principal with nothing marking them agent-made.** If the team
  wants agent comments recognizable, `comment_prefix` in the config is how (see `references/config.md`).

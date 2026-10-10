---
name: read-plan
description: Use when an admin wants to read the current roadmap plan and check it against what actually happened (triggers — "read the plan", "what's the roadmap state", "show me the plan against reality", "where does the roadmap stand"). Read-only — this skill never writes.
allowed-tools: mcp__trov__get_roadmap, mcp__trov__get_events, mcp__trov__query, mcp__trov__get_connection, Bash(git remote get-url:*)
---

# Read Plan ← Trov

## Overview

Reads the roadmap plan — the admin-authored narrative plus **sprints**, each carrying its computed
progress — and pairs it with the recent captured activity that progress is built from.
The point is to give an admin a true read of where the plan stands **and** what has actually shipped
recently, so they can spot drift before deciding whether to reshape the plan (the `update-plan` skill).
This skill is read-only; it never proposes or writes anything.

Part of the **`trov`** skill set. `update-plan` is the write counterpart — always read here (or via
its own `get_roadmap` call) before writing.

## When to use

- An admin asks to see the roadmap plan, its sprints, or its progress.
- An admin wants to check the plan against reality before deciding whether to update it.
- Preparing to run `update-plan` — reading first is how you know what's current.

## When NOT to use

- To write or change the plan — that's `update-plan`, and it's explicit-only.
- For a person's own work items — that's `my-work` (`get_my_work`), not the roadmap.

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

1. **`mcp__trov__get_roadmap`** — read the plan: `{narrative, version, updated_at, updated_by,
   sprints:[{id, label, summary, description, phase, dates, due, status, active, urgency, lead,
   domain, github_ref, progress, issues, members}]}`. A sprint's `progress` (`{closed, total, pct}`) is
   its **tickets only**: `total` = the tickets in the sprint, `closed` = those a person marked
   `done`/`declined`. A sprint with no tickets reads `0/0`; say so rather than calling it stalled. The
   GitHub issues behind `github_ref` are NOT in `progress`: each sprint carries them separately as
   `issues` (`{closed, total}` from a stored, event-derived cache, or null) — **never** a
   live GitHub read, and never to be added to the ticket numbers. `members` is the distinct set of person handles assigned to that sprint's
   tickets (empty when the sprint holds no assigned tickets — not a staffing claim).
   The `narrative` is meant to be short (Now / Next / Later — `update_plan` refuses one over 800
   characters); one stored before the cap may be longer and still reads whole. If it is over, say so:
   the next `update-plan` has to shorten it.
   `active` is derived (`status === 'in_progress'`), and `label`/`due` are the DTO's words for the
   stored `title`/`target_date` (an unscheduled sprint has `due: null` and sorts last).
2. **`mcp__trov__get_events`** — pull recent captured activity (e.g. `limit: 30`) so you can compare
   the plan against what has actually happened: merged/closed PRs and issues that plausibly belong to a
   sprint but aren't reflected in its `status` or `progress` yet. Filter by `type` or `subject` when
   you're checking one specific sprint.
3. **Optionally `mcp__trov__query`** for related doc/decision context (e.g. why a sprint's scope
   changed) when the narrative references something you need more background on. `query` indexes the
   roadmap too — type `sprint`, ids `sprint:<id>` (plus the plan narrative as id `plan`).
4. **Report, don't guess.** Summarize the plan (narrative + sprints + progress) alongside anything
   from `get_events` that looks like drift — a sprint whose linked issues are closing out but whose
   `status` is still `upcoming`/`in_progress`, or recent activity that doesn't map to any sprint.
   Flag it for the admin; don't silently reconcile it yourself.

## Hard rules

- **Read-only.** Never call `update_plan` or any write tool from this skill.
- **A sprint's GitHub issue counts (`issues`) are cached, not live.** Say they came from the stored
  event-derived cache, not a fresh GitHub read. (`progress` is a live count of the sprint's tickets, so
  it is current.)
- **Progress moving is not the same as a sprint being done.** Tickets resolving raise the bar; only a
  person sets `status: 'done'` (any member can complete a sprint; the plan write is the admin's).
- Present drift as an observation for the admin to act on (via `update-plan`), never as an
  already-made decision.

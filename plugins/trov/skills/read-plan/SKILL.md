---
name: read-plan
description: Use when an admin wants to read the current roadmap plan and check it against what actually happened (triggers — "read the plan", "what's the roadmap state", "show me the plan against reality", "where does the roadmap stand"). Read-only — this skill never writes.
allowed-tools: mcp__trov__get_roadmap, mcp__trov__get_events, mcp__trov__query
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

## Procedure

1. **`mcp__trov__get_roadmap`** — read the plan: `{narrative, version, updated_at, updated_by,
   sprints:[{id, label, summary, description, phase, dates, due, status, active, urgency, lead,
   domain, github_ref, progress, members}]}`. A sprint's `progress` (`{closed, total, pct}`) is
   **ticket-inclusive**: `total` = the tickets in the sprint + the cached, event-derived GitHub issue
   counts behind `github_ref`; `closed` = the tickets a person marked `done`/`declined` + the cached
   closed issues. It is **never** a live GitHub read. A sprint with neither reads `0/0`; say so rather
   than calling it stalled. `members` is the distinct set of person handles assigned to that sprint's
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
- **The GitHub half of progress is cached, not live.** Say it came from the stored event-derived
  cache, not a fresh GitHub read. (The ticket half is a live D1 count, so it is current.)
- **Progress moving is not the same as a sprint being done.** Tickets closing and issues closing both
  raise the bar; only an admin sets `status: 'done'`.
- Present drift as an observation for the admin to act on (via `update-plan`), never as an
  already-made decision.

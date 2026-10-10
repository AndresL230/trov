---
name: update-plan
description: Use when an admin explicitly asks to update, rewrite, or change the roadmap plan — narrative or sprints, including marking a sprint done (triggers — "update the plan", "rewrite the roadmap narrative", "add a sprint", "mark this sprint done"). Explicit invocation only — must never auto-fire.
disable-model-invocation: true
allowed-tools: mcp__trov__get_roadmap, mcp__trov__update_plan, mcp__trov__get_connection, Bash(git remote get-url:*)
---

# Update Plan → Trov

## Overview

Writes the roadmap plan — narrative and **sprints** — through the **direct, admin-authored**
`update_plan` MCP tool. This is a **promote-class** write, not the ingestion gate: there is no
staging/triage step and no confirmation queue. It IS still non-destructive — every call bumps the
plan version and snapshots the prior state (`plan_versions`), so nothing is lost — but it takes
effect immediately. That's why this skill is **explicit-only**: it must never auto-fire, the same as
`record-session`.

Part of the **`trov`** skill set. `read-plan` is the read counterpart — always read first (this
skill does so itself, in step 1) so you never write blind.

## When to use / NOT use

- Use only when an admin **explicitly** asks to change the plan: rewrite the narrative, add/edit a
  sprint, or mark one done.
- **Not** for moving tickets in or out of a sprint. Which tickets belong to a sprint is set from the
  Tickets UI (`POST /tickets/:id/sprint`), never from the plan write. This skill owns the sprint's own
  fields only — and since a sprint's progress bar counts its tickets, re-homing a ticket is how that
  bar moves, not an `update_plan` call.
- **Never auto-fire.** Reading the plan, discussing it, or noticing drift is not license to write it —
  that's `read-plan`'s job. Only an explicit ask reaches this skill.
- Never infer `status: 'done'` from issue/PR activity — `done` is only ever a person's say-so: here
  (admin), or `complete_sprint` / the web Confirm-done button (any member). No worker, webhook or cron sets it.

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

### 1. Always `get_roadmap` first (read-before-write)

Call `mcp__trov__get_roadmap` before composing anything. Carry forward:
- The current `narrative` (you'll pass a full replacement, so start from what's live). Check its
  length: if it is over the **800-character cap** (below), you cannot resend it as it is — even a
  sprint-only change carries the narrative — so step 2 proposes a shortened one.
- Every existing sprint's **`id`** — pass `id` on a sprint you're editing so the tool updates it
  in place; a sprint omitted from your call is **untouched**, not deleted. Omitting `id` on a new
  entry creates it.

### 2. Keep the narrative short

The narrative is the Roadmap's "What's happening" card, not a status report. Write it — or ask the
admin for it — as **2–3 sentences up to two short paragraphs: Now / Next / Later**, optionally under one
short heading line. The server refuses anything over **800 characters** (counted after trimming) and
writes nothing — not the plan, not a version, not one sprint.

- **Leave out** sprint-by-sprint detail, issue-number lists, dated status logs ("State as of …"),
  ops sequences and schedule tables. The sprints (`summary` / `description`) and the timeline carry
  those; move detail there instead of dropping it.
- **Count before you call.** Measure the trimmed length of the narrative you are about to send; if it
  is over 800, cut it and re-show the admin the shorter text — never send it hoping it fits.
- **An existing narrative over the cap** is not resent: propose a shortened replacement (Now / Next /
  Later in a few sentences) in the diff, and say where any detail you cut now lives (which sprint's
  `description`). A long narrative already stored still reads fine — the cap applies only to the next
  write.

### 3. Show the admin a diff and get confirmation

Before writing, lay out plainly what will change: narrative before/after with its character count
(or "narrative unchanged" — only when the live one is within the cap),
and per sprint — created / edited (with the specific fields changing) / left untouched. Get the
admin's explicit go-ahead on that diff before calling the write tool. If they want changes, revise the
diff and re-confirm — don't call `update_plan` speculatively.

### 4. One `update_plan` call

Once confirmed, make **exactly one** call:

```jsonc
{
  "narrative": "<full narrative text — ≤ 800 characters, Now / Next / Later>",
  "sprints": [
    { "id": 3, "label": "Ticket queue", "summary": "One queue the whole org files into.",
      "description": "markdown — **bold**, `code`, links, ### headings, - bullets",
      "phase": "Now", "dates": "Sep 16 – Sep 30", "due": "2026-09-30",
      "status": "in_progress", "urgency": "high", "lead": "AndresL230", "domain": "tickets",
      "github_ref": 42 },
    { "label": "<new sprint, no id>", "due": "2026-10-15", "status": "upcoming" }
  ]
}
```

The sprint vocabulary (the DTO's words, not the column names):

| field | meaning |
|---|---|
| `label` | the sprint name (required) |
| `due` | target date — a real calendar day `YYYY-MM-DD`, or `""` for unscheduled (required) |
| `start` | start date, `YYYY-MM-DD`, on or before `due` (omit = keep the stored one, `null` = clear). A bad date or start after due refuses the WHOLE call |
| `summary` | one line under the label on the Roadmap card |
| `description` | markdown body, rendered on the sprint screen |
| `phase` | coarse plan label — "Now", "Weeks 3-4", "Later" |
| `dates` | optional free-text label, e.g. "Sep 16 – Sep 30" — display only; the Roadmap shows start–due when `start` is set |
| `status` | `upcoming` \| `in_progress` \| `done` (`in_progress` = the Roadmap's **active**) |
| `urgency` | `low` \| `normal` \| `high` (defaults `normal`) |
| `lead` | a person **handle** |
| `domain` | `notifications` \| `tickets` \| `gate` \| `feed` \| `search` \| `infra` |
| `github_ref` | a GitHub milestone number, or an array of issue numbers |

- `id` present → update that sprint; `id` absent → create one.
- On an update, a field you **omit** is left unchanged (`label`, `due` and `status` are required, so
  they always overwrite); passing an explicit `null` is how you **clear** one. Sprint fields also come
  from the Roadmap's New sprint panel, so never re-send a field blank just to fill the shape.
- **You never write progress.** A sprint's `closed/total/pct` is computed at read time from **the
  tickets in the sprint, and nothing else** — `total` = its tickets, `closed` = those a person marked
  `done`/`declined`. A sprint with no tickets reads `0/0`, and the bar moves only when someone files,
  resolves or re-homes a ticket. The GitHub issues behind `github_ref` are a separate figure (a sprint's
  `issues`, kept current in a cache by the webhook and the cron backstop) and are never added to
  `progress`; editing `github_ref` changes that figure only.
- Sprints you don't list are left exactly as they are — you don't need to round-trip every
  sprint, only the ones changing.
- `status: 'done'` is legal here (`complete_sprint` is the other agent-reachable path, open to every
  member) — only set it when the admin explicitly confirmed the sprint is done, never inferred from closed issues or from
  every ticket in the sprint being resolved.
- Report back the new plan `version` the tool returns. If the call comes back with
  `narrative is N characters; the cap is 800`, nothing was written: shorten the narrative, re-confirm
  with the admin and call once more.

## Hard rules (invariants)

- **Server-gated to the organization's admins.** `update_plan` writes only when the connection's person is
  an **admin or owner of the organization the call acts in** (their role there today — set in Org
  settings › Members). A person who is an admin nowhere the connection reaches doesn't have the tool at
  all (absent from `tools/list`); an admin of one organization calling it in another gets `forbidden`,
  and nothing is written.
  This skill's own instructions are a second layer, not the enforcement boundary.
- **Explicit only.** Never fire without a direct admin ask.
- **Read before write, every time** — step 1 is not optional, even for a small edit.
- **Confirm the diff before writing** — no silent writes.
- **`done` is a person's say-so only** — set here by an admin, or by any member with `complete_sprint` /
  the web Confirm-done button — never inferred from
  GitHub activity, issue closure percentage, or `get_events`.
- **Narrative ≤ 800 characters** (after trimming) — server-enforced; over it, the whole call is
  refused and nothing is written.
- **One call.** Compose the full sprints array (with unchanged ones simply omitted) and call
  `update_plan` once — this is a direct write, not a reconciling batch, so there's no replay safety net
  if you call it twice with different content.
- This is **not** the ingestion gate — no staging, no triage, no `record_session`. Don't route plan
  writes through those tools.

## Common mistakes

- Forgetting a sprint's `id` when editing it → the tool creates a duplicate instead of updating.
- Using the pre-rename field names (`title` / `target_date`) instead of `label` / `due` → the tool
  rejects the call as a validation error.
- Setting `status: 'done'` because issues look closed, without the admin having said so.
- Skipping the diff/confirmation step and writing straight from the ask.
- Writing the narrative as a status report — per-sprint progress, issue lists, dated logs — or resending
  a stored narrative that is already over the cap. It is refused; shorten it and push the detail into
  the sprints.
- Calling `get_roadmap` after deciding what to write instead of before — you lose the current `id`s
  and the real current narrative to diff against.

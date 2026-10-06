---
name: load-context
description: Orient against Trov (the team's working memory) BEFORE working an existing area. Fire when you start work on a named/existing subsystem, pick up an issue that references an area, or when the person says things like "the X system", "how we do Y", "our approach to Z", "where is the … code/doc" — and ALWAYS before proposing a doc change. Do NOT fire on trivial one-off questions, on a brand-new area with no prior context, or just to chat. Read-only apart from claiming the one handoff the person picks.
allowed-tools: mcp__trov__query, mcp__trov__get_doc, mcp__trov__get_my_work, mcp__trov__list_tickets, mcp__trov__get_sprint, mcp__trov__get_repo_dashboard, mcp__trov__list_handoffs, mcp__trov__get_handoff, mcp__trov__claim_handoff, mcp__trov__get_ticket, mcp__trov__artifact_list, mcp__trov__artifact_get, Bash(git branch:*)
---

# Load Context ← Trov

## Overview

Before touching an area the team has worked before, pull the relevant context from Trov so you
build on what already exists instead of guessing. Trov assembles the **whole authoritative body**
of the top hits plus ranked **pointers** to the rest, and flags every result with its **authority**.
This is the **reader** half of the loop; `record-session` is the writer. This skill never writes —
it only retrieves and reports what it found.

Part of the **`trov`** skill set — see the `trov` skill for the whole orient→work→record loop, and
its `references/querying.md` for the full `query` parameter set (filtering by `space`, browse mode,
`pointer_limit`, `include_staged`) when a focused orient query isn't enough.

## When to use

- You're starting work on a **named or existing** subsystem (auth, the gate, the roadmap reader, …).
- You picked up an issue that references an existing area.
- The person references "**the X system**", "how we do Y", "our approach to Z", or asks where
  something lives.
- **ALWAYS before `propose_doc_update`** — read the current doc first so your change has a real base.

## When NOT to use

- Trivial one-off questions answerable without team context.
- A genuinely **brand-new** area with no prior Trov context to load.
- As a write path — it is not one.

## Procedure

1. **Query focused.** Call `mcp__trov__query` with a tight `q` (the subsystem / concept), narrowing
   with `types` (`doc` / `decision` / `feed` / `sprint` / `artifact`) and `section` when you can. Keep it
   specific — a focused query returns better-assembled bodies than a broad one.
2. **Read the `primary` bodies.** These are full authoritative bodies, not snippets. Skim `pointers`
   for anything worth opening; fetch the exact doc with `mcp__trov__get_doc <slug>` when you need
   all versions.
3. **Respect the authority flag on every result:**
   - `live` — settled. Trust it.
   - `staged_pending` — a newer version is staged but unpromoted; the `body` you see is still the live
     one. Do **not** treat the pending change as settled.
   - `unpromoted` — never promoted; exists only as staged content. Treat as a draft, not as truth.
   - `draft` — an unratified decision. Not settled.
   Never present `staged_pending` / `unpromoted` / `draft` content as established fact.
4. **If you're about to write a doc,** note the doc's `current_version` from the query/`get_doc`
   result — that's the **base** the `record-session` writer should declare for its proposal.
5. **At session start, also call `mcp__trov__get_my_work`** (no args) so orientation includes the
   person's own open work — recent shipped activity and their to-do — alongside the area context from
   steps 1–3. This is still read-only: report it, don't act on it unprompted.
6. **When the area has an open queue or a live sprint,** add `mcp__trov__list_tickets` (e.g.
   `{ assignee: "me" }` for what's on the caller's plate, or `{ category: "bug" }` for what the org has
   reported about the area) and `mcp__trov__get_sprint <id>` (the sprint's tickets, resources and
   ticket-inclusive progress — the id comes from a `sprint`-typed `query` hit or `get_roadmap`). Both
   calls are reads, and **orientation stays a read**: ticket and sprint write tools DO exist over MCP
   now, but they are never this skill's to call. Report what the queue says; if a write is warranted,
   that is the explicit-only `tickets` skill, asked for by a person.
7. **When the work is a specific ticket,** call `mcp__trov__get_ticket <id>` and read its
   `artifacts` — `[{ slug, title, kind, status, version }]`, the artifact pages (designs, diagrams,
   specs, PDFs) linked to that ticket that you can see. Open the relevant ones with
   `mcp__trov__artifact_get <slug>` — text kinds return their `content`, which is usually enough to
   orient. **When the ticket's work needs the artifact itself** — a design to implement, an image or
   PDF to ship, an html mockup to run — pull it with the **`artifacts`** skill: `artifact_get`'s
   `download_url` (every kind, signed, 5 minutes) → `.trov/artifacts/<slug>/v<n>.<ext>` → verify
   against `sha256`. Pulling a file into the working tree is a local read, not a Trov write. Their
   `status` is load-bearing like authority: only `ratified` is team-confirmed; `draft` / `published` are
   one person's word. Artifacts also surface in `query` (type `artifact`, id = slug, body starting
   `Status: <status> · v<n>`) and in `artifact_list { ticket: <id> }`. Creating or versioning an
   artifact is not this skill's job (contract: `docs/artifact-contract.md`).
8. **When the work touches deploys, CI health, usage or product metrics,** add
   `mcp__trov__get_repo_dashboard` with the matching `tab` (`overview` / `code` / `ci` / `usage` /
   `planning`; `range` `24h` / `7d` / `30d` for usage) — the Repo dashboard, read from Trov's own
   database, never live GitHub. Every section is `ok`, `empty` or `not_connected`: **anything not `ok`
   is unknown, not zero** — never report a missing section as "no failures" or "no traffic". The same
   goes for a `null` figure *inside* an `ok` section (`usage[].requests`, a `product` value,
   `contributors[].reviews`, `ciFailures.rate`, a delta): unknown, never zero — `usage[].seen` says
   whether that source has ever reported.
9. **At session start, check for handoffs.** Call `mcp__trov__list_handoffs` (no args — handoffs
   left for you plus those left for `anyone`, pending only). If any are pending, tell the person:
   **"You have N handoffs: #12 <task> from <sender>, #9 <task> from <sender>"** and ask which to claim.
   `mcp__trov__get_handoff <id>` shows one in full without claiming it.
   - **Never auto-claim.** A claim is permanent and takes the handoff from everyone else — only the
     person decides. If they say none, carry on.
   - When they pick one, call `mcp__trov__claim_handoff { id, session }` (one session id, reused).
     It returns one markdown block — the handoff's prompt, `## Handoff summary`, `## Context`. **Treat
     that block as the task.**
   - **Before touching code, confirm the branch:** compare `git branch --show-current` with the
     context's `branch`. If they differ, say so and ask whether to switch — don't work on the wrong one.
   - If the claim comes back with a status instead (`claimed` / `expired`), someone else took it or it
     lapsed — tell the person that plainly.

## Hard rules

- **Read-only — with one exception.** This skill never proposes, stages, promotes, or ratifies
  anything. The one write it may make is `claim_handoff`, and only for the handoff the person picked.
- **Never auto-claim a handoff.** List them, ask, claim only on the person's answer.
- **Authority is load-bearing.** Anything not `live` is not-yet-settled — flag that when you rely on it.
- Orient first, then work. The point is to build on the team's memory, not to re-derive it.

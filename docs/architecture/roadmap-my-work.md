# Roadmap, sprints and My Work

<!-- Moved verbatim out of CLAUDE.md (2026-10-07). This is the detailed reference; CLAUDE.md keeps only what applies to every change. Keep it current when you change the area. A reference to another section ("see Core invariant", "the Repo dashboard section below") now means another file in this folder — see the table at the bottom of CLAUDE.md. -->

## Roadmap & My Work — authored plan + stored projections, no live GitHub at render

The roadmap is two layers. **The plan** (narrative + sprints + timeline) is admin-authored via the
`update_plan` MCP tool (`update-plan` skill) → `write_plan`: a direct promote-class write, versioned
non-destructively into `plan` (singleton narrative) + `plan_versions` snapshots (`sprints_json`), over
the `sprints` table. **Sprints ARE the old milestones, renamed in place by 0025** — same rows, same
ids, plus `dates` / `summary` / `urgency` / `lead` / `domain` alongside the pre-existing `description`
(now rendered as markdown) and `phase`. Sprint `done` is set by a PERSON, never event-inferred: the plan
write may set it (admin), and ANY signed-in member completes a sprint with `POST /sprints/:id/complete` or MCP
`complete_sprint` — sprint writes are open to every member; only the whole-plan rewrite is admin-only
(`ingestion-gate.md` › Sprints).
**ONE overdue rule**: `sprintDueState(due, now)` in `shared/sprints-core.ts` — a sprint is due all of its
(local) due day and overdue from the day AFTER, "due this week" = today through 7 days out — read by the sprint
cards, the Roadmap's Timeline-tab dot / Now box / single NEXT UP (`nextSprintId`), the Timeline and My Work's ticket due dates.
The narrative is short — `PLAN_NARRATIVE_MAX` = 800 characters after trim (`shared/sprints-core.ts`),
enforced in the `update_plan` input schema AND at the top of `write_plan`, before its first write (so over
it, or an unknown sprint id, writes nothing: no plan row, no version, no sprint); a longer narrative
already stored still reads whole.

**Two vocabularies, one seam** (`shared/sprints.ts`): the DB keeps its column names, the DTO speaks the
product's words — `row.title` ↔ `view.label`, `row.target_date` ↔ `view.due`, `row.start_date` ↔ `view.start`
(0035), and `active` is DERIVED (`status === 'in_progress'`), never stored. **ONE sprint-date rule**
(`sprintDatesProblem` in `shared/sprints-core.ts`, zod-free): `start` and `due` are each unset (null / "") or a
REAL calendar day written `YYYY-MM-DD` ("Oct 17", `2026-02-30` refused), and `start <= due` when both are set —
enforced by `SprintCreate` (`POST /sprints`, which answers the rule's message as its 400 `error`, and MCP
`create_sprint`), `PlanSprintEntry` (`update_plan`), `create_sprint` and `write_plan` themselves (before the first
write; an update that omits `start` is checked against the STORED one), and the New sprint panel before it
submits. A refusal writes nothing. READS never validate, so a legacy non-ISO due still reads (Unscheduled on the
Timeline). `dates` is now only a display label: `sprintDatesLabel` (same file) shows the real span when a start
is set, else `dates` — used by the sprint card, the sprint screen, the queue's sprint groups and the artifact
sprint picker. The New sprint panel has native `<input type="date">` Start / Due (`.cnpy-date` sets
`color-scheme` per theme) and no free-text Dates field; the Timeline draws from `start`, else parses `dates`,
else the dashed two-week estimate. `update_plan`'s input and every sprint route body use the
DTO vocabulary; only `src/tools/` speaks columns. `GET /roadmap` and MCP `get_roadmap` read `get_plan`:
narrative + `sprints: SprintView[]` in target-date order, each with `progress: {closed, total, pct}`.
No live GitHub, no per-user token.

**Progress is TICKETS ONLY**, computed at read time by the ONE function `sprintProgress` in
`src/tools/sprints.ts`: `total` = the tickets in the sprint (native AND mirrored), `closed` = those set
`done`/`declined`, `pct` rounded; a sprint with none reads `0/0`. The GitHub issue counts travel
SEPARATELY as `SprintView.issues` (null without a cache row), so a mirrored ticket and its issue are never
summed into one number. The ticket half is a live D1 count; the GitHub half is a stored cache (`sprint_progress`,
keyed `sprint_id`), written as ABSOLUTE `closed`/`total` (so delivery order is irrelevant — the last
write wins) by two direct writers: the webhook (event-derived, on issue events) and the `scheduled()`
cron backstop (`recomputeAllProgress`, run per org with that org's GitHub credential from
`resolveGithubCredential`, off the render path). `github_ref` is bare
(a GITHUB milestone number — GitHub's own vocabulary, kept deliberately — OR a JSON array of issue
numbers) resolved against the org's PRIMARY repository (`orgPrimaryRepo`, its `org_repos` row) — only by
those two writers, never at render.

**My Work** (`GET /me/dashboard`, MCP `get_my_work` → `getMyWork`) is a D1-only projection over captured
events AND over the ticket queue: three separate lists — `previousActivity` (summarized merged/closed PRs
where the person is the subject, 5 most recent), `todo` (their open assigned issues, 5 most recently
updated, each carrying its own stored summary), and `tickets` (their OPEN assigned tickets of BOTH sources —
`listAssignedTickets(…, { sources: "all" })`, each carrying `source`, since the screen renders no issue list
any more and a mirrored ticket reaches it only as a ticket — 6 most recently updated, with the sprint label,
plus `ticketsTotal`, the UNCAPPED count of that same rule, which the "N open" figure and the greeting use) —
built from `events` (+ `pr_summaries`, `issue_summaries`, `persons`, `identities`) and from `tickets` +
`ticket_assignees`, no live GitHub. `todo` / `previousActivity` stay in the DTO for MCP `get_my_work`, where
a mirrored ticket's issue can therefore appear in both `todo` and `tickets` (`source: "github"` says so).
The SCREEN (`web/src/mywork.ts`, composed by `myWorkView`) reads its other tiles off their own slices: Your
sessions off `mwSessions` (`GET /feed?author=<me>&limit=2` — never the Feed screen's filtered `feed`), Docs
you own off `mwDocs` (`GET /docs?fields=meta`, no bodies, stubs at `current_version = 0` skipped), the review
tile off `reviewHeadsFromReads` (no diff), and every handoff count — Your sessions' pills and the library's
Queued handoffs cell (count + the newest, opened, never claimed from here) — off `handoffsForMe`, the ONE
definition the sidebar badge uses too (pending, recipient = me, self-sent included, `anyone` excluded).
`person` resolves via the github `identities` row (`resolvePersonForLogin`, see Identity above); an
unmapped login yields an empty EVENT projection (`degraded:false`) — but the ticket list is read BEFORE the
identity fork and is keyed on the person HANDLE (`COLLATE NOCASE`, like `persons.handle`), so a person with
no GitHub identity at all (a Google-only filer) still gets their tickets; any D1 failure yields empty
`degraded:true` — never a 500. Completed PRs and assigned issues are each summarized ONCE, at capture time
(`tools/summarize.ts`: Google Gemini `gemini-2.5-flash-lite` via `GEMINI_API_KEY` — a REST
`generateContent` call, not a Cloudflare binding — emits one validated JSON object — PR:
title/what/why/impact; issue: title/summary/next_step). On AI failure the **issue**
path writes a deterministic prose excerpt (`issue_summaries.summary`); the **PR** path
is structured-only (the prose `pr_summaries.summary` column was dropped in `0019`), so
its fallback is a content-less marker row (`model='excerpt'`, null structured columns)
that renders a "No summary recorded" placeholder. Stored as columns on `pr_summaries` /
`issue_summaries` and regenerable via Sync (a row is "done" only when
`model != 'excerpt' AND title IS NOT NULL`) — never truth, never generated at render.

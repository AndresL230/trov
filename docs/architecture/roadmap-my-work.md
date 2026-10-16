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

**Your brief** (`DashboardData.brief?`, `shared/ai-core.ts` `AiBrief`) is what Trov WROTE for the person — now,
recently, what is next — by the AI pass's `brief.person` job (`src/ai/brief.ts`; `ai.md` › The brief), stored in
`person_brief` (0063, the last 5 versions). `getMyWork` reads the NEWEST row (`storedBrief`, `src/tools/mywork.ts`,
through `src/data/person-brief.ts` — plain D1, no model, nothing from `src/ai/`), so `/me/dashboard` and
`get_my_work` carry the same one — and the digest e-mail will (Phase E). The field is ABSENT under the AI read rule
(`ai.md` › The read rule: the org's AI switch off, or no Anthropic key on the deployment), nothing is stored, the
newest is older than `AI_STALE_DAYS` (7 days — never shown as current, owner ruling Q25), the stored row fails `AiBriefSchema`, or the person pressed "Wrong?" on that very
version (`aiItemRef.brief(generatedAt)`; the next version shows again); `state` is `capped` (the last brief, its
`resumesOn`, `upgrade` on Free) when the org's `ai_runs` are spent, `empty` for a version the pass wrote with no
model when nothing was left to say. A failed brief read never degrades the rest of My Work. `GET /me/dashboard`
also records `memberships.mywork_opened_at` (0063; at most one write an hour, never a model call; MCP's
`get_my_work` does not count) — a brief is written only for someone who opened My Work in the last 14 days or who
receives the digest. `LOCAL_AI_PREVIEW` replaces it with the sample on the screen under `wrangler dev` only, never
over MCP; the local dev seed stores a real one for AndresL230 (`scripts/seed/brief-dev.mjs`). Absent = the screen
renders exactly as before.

**My Work** (`GET /me/dashboard`, MCP `get_my_work` → `getMyWork`) is a D1-only projection over captured
events AND over the ticket queue: three separate lists — `previousActivity` (summarized merged/closed PRs
where the person is the subject, 5 most recent), `todo` (their open assigned issues, 5 most recently
updated, each carrying its own stored summary), and `tickets` (their OPEN assigned tickets of BOTH sources —
`listAssignedTickets(…, { sources: "all" })`, each carrying `source`, since the screen renders no issue list
any more and a mirrored ticket reaches it only as a ticket — 6 most recently updated, with the sprint label,
plus `ticketsTotal`, the UNCAPPED count of that same rule, which the "N open" figure and the greeting use) —
built from `events` (+ `pr_summaries`, `issue_summaries`, `persons`, `identities`) and from `tickets` +
`ticket_assignees`, no live GitHub. `todo` is `listOpenAssignedIssues` (also the my_work digest's list, uncapped): each captured issue's LATEST
snapshot, kept when its `issue.state` is `open`, its `action` is not one that means it left the repository
(`ISSUE_GONE_ACTIONS`) and one of its `assignees[].login` is exactly one of the person's logins — all filtered in
D1 (`json_extract` / `json_each`), so only the person's open issues' raw JSON leaves the database, not every
issue ever captured (`test/mywork.test.ts` pins the rule clause by clause).
`todo` / `previousActivity` stay in the DTO for MCP `get_my_work`, where
a mirrored ticket's issue can therefore appear in both `todo` and `tickets` (`source: "github"` says so).
The SCREEN (`web/src/mywork.ts`, composed by `myWorkView`) reads its other tiles off their own slices: Your
sessions off `mwSessions` (`GET /feed?author=<me>&limit=2` — never the Feed screen's filtered `feed`), Docs
you own off `mwDocs` (`GET /docs?fields=meta`, no bodies, stubs at `current_version = 0` skipped), the review
tile off `reviewHeadsFromReads` (no diff), and every handoff count — Your sessions' pills and the library's
Queued handoffs cell (count + the newest: its row opens it; **Claim & copy** (`mwHandoffClaim`,
the owner's call 2026-10-15) copies it as a prompt inside the click, then claims it with a `sess_web_` session —
permanent, as on the handoff screen) — off `handoffsForMe`, the ONE
definition the sidebar badge uses too (pending, recipient = me, self-sent included, `anyone` excluded;
`GET /badges` counts the same set in SQL, held to it by `test/badges.routes.test.ts`).
`person` resolves via the github `identities` row (`resolvePersonForLogin`, see Identity above); an
unmapped login yields an empty EVENT projection (`degraded:false`) — but the ticket list is read BEFORE the
identity fork and is keyed on the person HANDLE (`COLLATE NOCASE`, like `persons.handle`), so a person with
no GitHub identity at all (a Google-only filer) still gets their tickets; any D1 failure yields empty
`degraded:true` — never a 500. Completed PRs and assigned issues are each summarized ONCE, at capture time
(`tools/summarize.ts`: Anthropic Claude `claude-haiku-5-5` via `ANTHROPIC_API_KEY`, through the one model
client `src/ai/client.ts` — structured outputs over the Messages API, not a Cloudflare binding — emits one
JSON object, checked again by its zod schema — PR: title/what/why/impact; issue: title/summary/next_step; a
refusal or an answer cut off at `max_tokens` is no answer). On AI failure the **issue**
path writes a deterministic prose excerpt (`issue_summaries.summary`); the **PR** path
is structured-only (the prose `pr_summaries.summary` column was dropped in `0019`), so
its fallback is a content-less marker row (`model='excerpt'`, null structured columns)
that renders a "No summary recorded" placeholder. Stored as columns on `pr_summaries` /
`issue_summaries` and regenerable via Sync (a row is "done" only when
`model != 'excerpt' AND title IS NOT NULL`) — never truth, never generated at render.

**Your brief** (`DashboardData.brief?`, `AiBrief` in `shared/ai-core.ts`; `briefTile` in `web/src/mywork.ts`) is
a bento TILE — drawn ONLY when the dashboard carries `brief` and the person has not pressed "Wrong?" on it (off, no
key, or nothing written: the field is absent and the bento is exactly its five tiles). With it the bento is laid out by AREA
(`trov.css` `.mw-bento-brief`, `MyWorkLayout.bento`), each tile sized to what it holds and the whole closing as one
rectangle: Brief on the left (8 of 12 columns) beside Needs your review over Docs you own; Your sessions beside
Tickets for you (the wide slot, BR-OWNER-3); Repo wide beside Queued handoffs (`libraryTiles` gives the two small
tiles; Artifacts is not drawn here — the owner's call; the strip without a brief keeps it). A SHORT tile under
Needs your review is the point (the owner, 2026-10-16): with Repo there the right column was 556px and stretched the
brief to it. Needs your review is slim (one-line titles, 64px rows) and Docs you own's row takes the rest of the
brief's height (`grid-template-rows:auto 1fr auto auto`): 258 + 12 + 135 = the brief's 405 at 1456. The tiles are in that visual order, and the
entrance follows it. **Nothing in the
bento scrolls** (BR-OWNER-1/2): the rows size to what the tiles hold, and all of it is bounded. The brief is ONE
shape (`ai.md` › The brief; fixed boxes, `web-ui.md` › The AI kit); Needs your review and Tickets for you
hold TWO rows each in fixed boxes (`MW_BESIDE_ROWS`; a ticket title clamped to two lines, a review title to one) then "N more in Review" /
"N more in the queue" (that one opens the queue filtered to me), the line's place and unused rows kept, every state
(loading, empty, failed) in the same fixed body. Repo, wide in the last row, is its usual tile (`repoTile` still
has a narrow two-row `beside` form, unused since the 2026-10-16 swap). The brief's parts never stretch to the row. Below the 700px container breakpoint every tile is full width at its natural
height, stacked Brief, Needs your review, Tickets for you, Repo, then the rest (CSS `order`, the entrance's steps
with it). Without a brief the page is unchanged (7/5,
then `mwSpans`, then the library strip across the page). Ready: Now / Recently (each a sentence and its sources) and Next — rows that are real items
(Failing = the app's failing mark, Overdue = the danger mark, Due soon = the warning mark, Handoff = an arrow, a
ticket = its `#N`; one of each, three at most), the title
the item's own and linked to `cites[0]`, the model's one muted "why" — over a footer with the "Written by Trov"
byline and the thumbs-down "Wrong?" at the bottom right. Now, Recently and Next are ALWAYS drawn, an empty part
saying "Nothing new." in its slot. Empty: "Trov writes your brief after your next push or when something is
assigned to you. It reads your sessions, pull requests, tickets and handoffs." Capped: the last `now`, then the
allowance line (`web-ui.md` › The AI kit). "Wrong?" hides it for the person. `get_my_work` carries the same `brief?`.

## Roadmap intelligence (Phase D; `ai.md` › The Roadmap)

- **Forecast** — `SprintView.forecast` on every sprint read (`sprintForecast`, `src/tools/sprints.ts`): ARITHMETIC,
  never a model — tickets closed per day since the start day (day 1), carried over the open ones, against the due
  day (`projected`, `daysLate`). Null for a sprint not active, with no start, or with nothing closed yet. The card
  says "At this pace, done Nov 2, 3 days late" with no AI mark.
- **Sprint notes** — `SprintView.note?`: one line Trov wrote about an ACTIVE sprint (its tickets, the PRs they link,
  the week's entries naming them), with its cites, byline and "Wrong?" (which hides it for that person on the
  Roadmap, `/sprints` and MCP's `get_roadmap` / `list_sprints` / `get_sprint` alike). `org_insights` (0065), present only under
  the AI read rule (the switch on and a key); at the month's cap it is the last version with `state: "capped"`, and
  the card adds the AI kit's capped line (so does the drift).
- **Drift** — `PlanView.drift?`: one sentence on where the merged work went against the plan, with the theme shares
  the SERVER counted (`shares`, `windowDays`), drawn under the narrative.
- **Suggestions** — `PlanView.suggestions?` (cookie `GET /roadmap`, admins only, never MCP): a sprint draft (2–4
  sprints over the backlog, offered when ≥8 open tickets sit outside every sprint and none is active) and the weekly
  narrative proposal. Accept runs `create_sprint` + `set_ticket_sprint` or `write_plan` AS that admin; nothing is
  written before. Nothing here sets a sprint or ticket done.
- With a field absent each piece renders nothing and the Roadmap is byte-for-byte what it was
  (`test/render.ai-absent.test.ts`, `test/render.roadmap-ai-real.test.ts`) — but for one attribute that is not AI's:
  the Narrative tab's `<main data-morph="roadmap:narrative">` (below).
- **Motion** (the app's own; `web-ui.md` › A row leaving a list): the Narrative tab is `data-morph`ed (patched in
  place; the Timeline is still rebuilt), the cards are a keyed list (`data-morph-list`, `s:<id>`) that rises with the
  entrance (`.cnpy-stagger`), the drift rises (`.cnpy-rise`), the forecast and note come with their sprint card. A
  card an Accept / Dismiss took — and a note or the drift "Wrong?" took — is Review's `.cnpy-rv-row`: `data-verdict`
  + `inert`, collapsing over `AI_EXIT_MS` (= `REVIEW_EXIT_MS`), then not drawn (`state.ai.leaving` / `decided` in
  `ai-actions.ts`, which only HIDE rows of the read). The write goes on the click; a failure puts the card back with a
  toast; the Roadmap is read again once no card is collapsing (one read for several). Reduced motion: gone at once.
  Off the Roadmap (a theme proposal on Repo) the kit's busy path is unchanged. Tests: `test/render.roadmap-ai.test.ts`
  (markup, CSS), `test/render.roadmap-ai-exit.test.ts` (the controller).

# CLAUDE.md

Canopy — a shared context store backend. **One** Cloudflare Worker on one origin serves the HTTP API,
a stateless MCP endpoint at `/mcp`, a GitHub webhook receiver at `/webhook/github`, and the static web
build (via the assets binding); a `scheduled()` cron recomputes roadmap progress. Agents propose context
through a reconciling gate and humans confirm the consequential changes; authored (plan) and computed
(progress, summary) writes go direct.

## Working memory (use the skills)

Canopy is the team's working memory, and the skills under `.claude/skills/` are **the root of how it
stays living** (orient → work → record), not a side feature. The core loop is three skills:

- **`canopy`** — the umbrella/overview skill: the whole loop, the authority model, and the read/write
  tool map (the plan model; no `focus`, no agent-proposed sprints). Its `references/querying.md` is the full
  `query` parameter reference (filtering, browse, pointers, `include_staged`). Start here.
- **`load-context`** (auto-fires, read-only) — **orient before touching an existing area**: it calls
  `query` (assembled authoritative bodies + ranked pointers, each authority-flagged) so you build on what
  exists instead of guessing, and at session start also calls `get_my_work`. ALWAYS run it before
  proposing a doc change (note the doc's `current_version` as the writer's base).
- **`record-session`** (explicit only — never auto-fires) — at **session end**, observe what actually
  shipped (`git`/`gh`), read the touched docs back from Canopy, and stage **one** reconciled batch via
  the `record_session` MCP tool (feed / doc / ADR / triage / event items — a bearer-reachable batch over
  the same gate as `/ingest`).

**Tickets from Claude Code** — **`tickets`** (explicit only, never auto-fires) works the ticket queue and,
the sprints, over the scoped MCP write tools. It orients with a read, checks the lane before
proposing anything, shows a one-line diff, then makes ONE call and reports the real new state. Per-team
defaults live in a `tickets.config.md` it reads (`references/config.md`) — advisory taste on top of the
Worker's hard rules, never a permission system. Reading the queue needs no skill.

Three more skills cover the roadmap/my-work surfaces:

- **`read-plan`** (admin, read-only) — read the current plan and check it against captured reality.
- **`update-plan`** (admin, explicit) — push a reshaped plan back through the direct, non-destructively
  versioned plan-write path (`update_plan`), including setting a sprint `done`.
- **`my-work`** (read-only) — pull your own My Work projection (`get_my_work`); also invoked by
  `load-context` at session start.

Trust `live` results; **scrutinize `staged_pending` / `unpromoted` / `draft`** — anything not `live` is
not-yet-settled and must not be treated as established fact. Agents only ever stage; a human confirms in
Triage. That staging-plus-confirmation loop is what keeps the store trustworthy as it grows.

## Commands

- `npm test` — Vitest against a real Miniflare D1 (the source of truth for "is it green").
- `npm run typecheck` — `tsc` over worker + web (does NOT run in `npm test`; run it too).
- `npm run build:web` — Vite build of the web SPA into `web/dist`.
- `npm run dev` — build web, then `wrangler dev` with a `vite build --watch` beside it (`npm run watch:web`), so a
  web change is live on a plain page reload — no rebuild, no restart. The watch keeps old hashed bundles
  (`--emptyOutDir false`): emptying `web/dist` under a running `wrangler dev` is what made it serve stale or
  404 assets. `npm run deploy` — build web, then `wrangler deploy`.
- `npm run db:create` / `db:migrate:local` / `db:migrate:remote` — D1 provisioning + migrations.
- Run one test file: `npx vitest run test/<file>.test.ts`.

## Layout

- `shared/` — the ONLY shared layer (imported via the `@shared` alias by `src/` and `web/`):
  `contract.ts` (Zod ingest contract), `vocabulary.ts` (controlled vocab), `rows.ts` (one type per D1 table),
  `dashboard.ts` (the My Work DTO shared by the Worker and web), `repo.ts` (the Repo dashboard DTO — zod-free,
  since the SPA imports `REPO_TABS` as a value), `notifications.ts` (the digest DTOs), and the
  tickets pair-per-domain: `tickets.ts` / `sprints.ts` (zod rows, DTOs, payloads, `parseTicketLink`,
  `toSprintView`) over `tickets-core.ts` / `sprints-core.ts`. **The `*-core.ts` split is a rule**: anything
  the SPA imports as a VALUE (`canTransition` / `legalMoves` / `TICKET_STATUS_LABEL` / `isOpenStatus`,
  the status/urgency/domain tuples) lives in the zod-free core so the browser bundle never drags zod in;
  the zod module re-exports it, so the server still has one definition.
- `src/` — the Worker. `index.ts` (fetch entry: `/mcp` by bearer, `/webhook/github` by HMAC, everything
  else to the Hono app; plus `scheduled()`, which dispatches the repo cron and the two digest crons by exact
  cron expression), `routes.ts` (Hono HTTP), `mcp.ts` (MCP
  tools), `consumer.ts` (THE GATE), `webhook.ts` (GitHub event capture), `tools/` (`writes.ts`, `reads.ts`,
  `plan.ts`, `tickets.ts`, `sprints.ts`, `mywork.ts`, `repo.ts`, `repo-agent.ts`, `progress.ts`, `summarize.ts`), `notifications/` (email digests — see the
  Email notifications section), `db.ts` (D1 helpers), `auth/` (`persons.ts` — the identity root;
  `google.ts` — second provider; `onboard.ts` — the sign-in fork + onboarding cookie; `invites.ts`),
  `env.ts`. `repo/` is the repo-capture package behind `tools/repo.ts`: `types.ts` (the `RepoEvent` /
  `RepoEventRow` / `RepoMetric` shapes), `config.ts` (parses the `REPO_ENVIRONMENTS` var into
  `RepoEnvConfig[]`, `[]` on absent/malformed), `capture.ts` (PURE delivery→`RepoEvent[]` derivation,
  `repoEventsFromDelivery` — no DB, no clock, no network, and stores only a SLICE of each payload in `raw`),
  `store.ts` (the snapshot and metric seam: `putSnapshot` / `getSnapshot` over the five snapshot kinds —
  `prs_reconciled`, `env_heads`, `drift`, `branches`, `cf_polled`; `putMetric`, the ONE write seam that
  normalises `repo_metrics.at`, and `putMetrics`, the same write for MANY rows in `db.batch` chunks of 50;
  the metric reads `metricSeries` / `latestMetric` / `latestHealth` and the Usage tab's whole-tab reads
  `metricsSince` / `productReadings` / `metricsEver`; and `pruneRepoCapture`, the retention rules),
  `product.ts` (Sapling's product metrics: the `sap_c_*` / `sap_t_*` metric naming and the key → group /
  label / format registry — one place, server-side), `reads.ts` (every SELECT over `repo_events` — D1 only, nothing here may fetch — including
  `recordingSince`, the earliest `recorded_at` per kind that the week-over-week deltas gate on, and the ONE
  non-decisive-conclusion policy at `foldResult`/`checkState`), `github.ts` (service-token GitHub reads —
  `ghJson` / `ghGraphql`, `reconcileRepo` with its drift and branches arms, `refreshDrift`, `fillFailedJob` —
  never on the render path), `poll.ts` (the four scheduled pulls, none of which may throw: `pingHealth` every tick,
  and the three hourly usage pollers `pollCloudflare`, `pollRailway`, `pollSaplingMetrics`, each returning a
  `PollOutcome` per environment), and `cron.ts`
  (`handleRepoCron` — the repo trigger's one dispatcher, ONE heavy job per invocation, the subrequest budget
  stated at the dispatcher — `runUsagePolls`, the one function behind the `:00` tick and the usage half of
  the admin's "Poll now"; `runRepoRefresh` / `runLockedRepoRefresh`, the on-demand refresh of EVERY source
  behind `POST /admin/poll`, which the cron never calls; and `railwayTokens`). Retention, the cron schedule and every capture path are
  described once, in the Repo dashboard section below.
- `migrations/` — D1 SQL (`0001_init` … `0010_triage_resolve`, then `0011_fts_recreate`,
  `0012_events_plan` [events / pr_summaries / milestone_progress / people / plan / plan_versions +
  `milestones.phase`], `0013_roadmap_fts`, `0014_drop_focus` [retires `0007_focus`],
  `0015_drop_user_token` [drops `users.github_token`], `0016_identity_tasks`, then
  `0017_issue_summaries` [assigned-issue summaries], `0018_structured_summaries` [structured summary
  columns], `0019_drop_pr_summary` [retires the legacy prose `pr_summaries.summary` — PR cards are
  structured-only], `0020_docs_space_vocab`, then `0021_notifications` [notification_policy /
  notification_settings / notification_prefs / notification_outbox + `users.email`,
  `users.email_unsubscribed`], `0022_notification_bodies` [dev-only rendered-message store], then
  `0023_persons` [persons / identities / invites replace users + people; sessions + mcp_tokens repoint
  to persons.handle; bodies table loses its outbox FK], then the tickets build: `0024_tickets`
  [tickets / ticket_assignees / ticket_links / ticket_comments / ticket_events + `tickets_fts`],
  `0025_sprints` [`milestones`→`sprints` in place (+ `dates`, `summary`, `urgency`, `lead`, `domain`),
  `milestone_progress`→`sprint_progress` (`milestone_id`→`sprint_id`), `plan_versions.milestones_json`
  →`sprints_json`, roadmap_fts re-keyed `milestone:<id>`→`sprint:<id>`, new `sprint_resources`, and
  `DROP TABLE milestone_proposals` — the whole agent-proposed-roadmap surface goes with it], then
  `0026_token_hint` [`mcp_tokens.token_hint` — the clear-text label Settings lists a token by], then
  `0027_repo_capture` [`repo_events` (append-only, UNIQUE `semantic_key`, kinds push/pr/review/deploy/check/run)
  / `repo_snapshots` / `repo_metrics` — the Repo dashboard's second capture path, deliberately separate from
  `events`], then `0028_handoffs_prompts` [`handoffs` / `prompts` / `prompt_versions` / `prompts_fts` — see
  "Handoffs & Prompt Library" below], then `0029_oauth` [`oauth_clients` / `oauth_grants` / `oauth_codes` /
  `oauth_tokens` — MCP OAuth, see Auth], then `0030_artifacts` [`artifact_pages` / `artifact_versions` /
  `artifact_links` / `artifact_upload_tokens` / `artifacts_fts` — see "Artifacts" below], then `0031_doc_images`
  [`doc_images` / `doc_image_upload_tokens` — see "Doc images" below], then `0032_ticket_source`
  [`tickets.source` / `source_ref` (partial UNIQUE) / `source_author` / `source_updated_at`,
  `ticket_links.locked`, and the `github-webhook` system person — see "Tickets mirrored from GitHub issues"], then
  `0033_ticket_testing_rank` [REBUILDS `tickets` + `ticket_events` (SQLite cannot alter a CHECK) to admit the
  `testing` status and add `tickets.board_rank`; under `defer_foreign_keys`, carrying each AUTOINCREMENT counter
  over so a deleted ticket's number is never reissued — see "The ticket board" below], then
  `0034_feed_brief_artifact_cap` [`feed.brief` — see "The feed brief" below — and REBUILDS `artifact_versions`
  to raise its text CHECK to 768000 bytes, the 750 KB `ARTIFACT_TEXT_CAP`], then `0035_library_and_sprint_dates`
  (ONE migration for the 2026-09-26 redesign batch — developed as 0035 + 0036, consolidated before production;
  four marked parts, each test cutting its own part out between the `-- ═══ PART` marker lines) — PART A [`docs.owner`, `artifact_pages.published_at`, `prompts.use_count` / `last_used_at` —
  each backfilled — and `prompts_fts_au` narrowed to the indexed columns so a use bump never rewrites the FTS
  row; the data behind My Work's library strip], PART B [`sprints.start_date` (nullable `YYYY-MM-DD`, the DTO's
  `start`), backfilled CONSERVATIVELY from `dates` — only a label that BEGINS with an ISO date or "<month> <day>"
  with no year, against an ISO `target_date` (the year before only for a range crossing New Year); anything else
  stays NULL and the Timeline still parses `dates`. Nothing else is rewritten — legacy non-ISO `target_date`s stay],
  PART C [prompt soft delete: `prompts.deleted_at` / `deleted_by` (a handle, in `HANDLE_COLUMNS`), and the four
  `prompts_fts` rebuild triggers re-created to index only `deleted_at IS NULL` rows — the update trigger now also
  fires on `deleted_at`, so a delete drops the FTS row and a restore puts it back — see the Prompt Library below],
  PART D [artifact soft delete: `artifact_pages.deleted_at` / `deleted_by` (a handle, in `HANDLE_COLUMNS`) — no
  trigger, `artifacts_fts` is kept by the repository — see Artifacts below]).
- `web/` — full TypeScript/Vite single-page app (My Work, Feed, Docs, Roadmap, Triage, Search,
  Settings, Get Started, the four tickets screens — Tickets queue / ticket detail / new ticket / sprint —
  the five-tab Repo dashboard, plus the `#unsubscribe` confirmation screen) served via the ASSETS binding;
  `web/src/markdown.ts` renders PR summaries, the roadmap narrative and a sprint description as styled HTML;
  `web/src/notifications.ts` holds the Settings › Email notifications and Maintenance › Notifications views;
  `web/src/tickets.ts` + `web/src/sprints.ts` are the (purely presentational) tickets/sprint components, and
  `web/src/hash.ts` is the hash-route seam (`parseHash` / `hashForRoute` — `#tickets/7`, `#sprints/3`,
  `#repo/<tab>`). `web/src/repo.ts` is the Repo dashboard (ported from the Claude Design `Canopy Repo
  Dashboard.dc.html`), `web/src/repo-sample.ts` its design-placeholder set (a dynamic import, never in the main
  bundle), and `web/src/sidebar.ts` + `web/src/morph.ts` the sidebar — see "Sidebar & motion" below.
  Signed out, the app renders the **landing page** (`web/src/landing.ts`, ported from the Claude Design
  `Canopy Site.dc.html`); its nav's Sign in opens the GitHub/Google dialog, and its in-page links scroll
  rather than set the hash (the hash is the route and the sign-in return-to). Signed IN, the sidebar logo
  reopens the same page as the `site` screen (`#site`): its nav swaps Sign in for "Back to the app", which
  returns to the route the logo was clicked from; `#site` is never stashed as a sign-in return-to. `web/src/landing-motion.ts`
  plays its scroll reveals; played keys live in `state.landingSeen` so a rerender never replays them.
  `web/src/releases.ts` is Help › **What's new**: `#releases` a grid of release cards; each release has TWO pages,
  `#releases/<v>` (release notes — for USERS: no PRs, no migrations) and `#releases/<v>/patches` (patch notes — for
  builders: `ops` upgrade notes, Added / Changed / Fixed / Removed, PR links), flipped by a `segmented()` switch;
  `<v>` is `0.N` or `unreleased`; the old `#releases/patches` opens the newest release's patches. Static `RELEASES`
  data (`0.N` per milestone, newest first) plus a pure renderer. **Every shipped PR adds its lines to the top
  entry** (highlights / heads-up in product words, deploy steps in `ops`, patch lines ending `(#N)` to link the
  PR) — and since a merge to `main` deploys, the PR that merges also CUTS "Unreleased" into the next `0.N`, so
  main never shows a shipped batch as unreleased; the header comment says how.
- `.claude/skills/` — Claude Code skills: `canopy`, `load-context`, `record-session`, `tickets`, and the
  roadmap/my-work skills `read-plan`, `update-plan`, `my-work`. Described in the Working memory section
  above. (Symlinks into `plugins/canopy/skills/` — one source of truth.)

## Core invariant — ingested content is gated; authored & computed writes are direct

`consume()` is an **ingestion** gate, not a universal write gate: it polices agent-proposed content
(vocab, confidence, content-hash dedupe, reconciliation). Every ingested entry funnels through the
per-type **gate** functions in `src/consumer.ts` (`ingestFeedEntry` / `ingestDocProposal` /
`ingestAdrDraft` / `ingestEvent` / `ingestRepoEvent`). The ingestion entry points are thin
adapters over these: `/ingest` and the MCP `record_session` batch tool (both via `consume`), the
per-entry MCP write tools (`append_feed`, `propose_doc_update`), and the `/webhook/github` branch, which
calls `ingestEvent` (into `events`, for My Work) AND, independently, `ingestRepoEvent` (into `repo_events`,
for the Repo dashboard — see below) off the SAME verified delivery. The gate **reconciles**, not just routes:

- **Replay ledger** (`processed_items`, keyed by `session.id + item_index`): a re-POST of the same
  payload drops every item as `unchanged` — nothing is double-written. MCP tools use an ephemeral
  UUID session so each call is independently reconciled without ever hitting the ledger.
- **Content-hash dedupe** (SHA-256 via Web Crypto): an identical body for an existing slug/ADR
  is a no-op (`unchanged`) unless `force: true` is passed.
- **Change-typing**: `change_kind` (`new` / `edit` / `rewrite`) is server-computed via a line LCS diff
  of the proposed body against the current promoted body; `base_version` records the version the writer
  read, surfacing stale-edit warnings. Both are stored on `doc_versions`.
- **Low-confidence nuance**: low-conf on a NEW slug → triage; low-conf on an EXISTING slug → stage and
  flag (`low_confidence = 1`) for human scrutiny. Only low-conf new slugs go directly to triage.
- Out-of-vocab tag/section → routed to `needs_triage` (nothing is guessed).
- **Doc images**: a doc body may embed only UPLOADED images (`![alt](/img/<sha256>)`). A `/img/` ref with
  no `doc_images` row, or any other image source (external URL, `data:` URI), makes the proposal
  `refused` — checked first, nothing staged or triaged, NOT ledgered (so a resend after the upload
  stages); a batch lists them under `refused`. Code blocks are not scanned. See "Doc images" below.
- **Events** carry no vocab/confidence — an event is external fact captured verbatim, deduped by a UNIQUE
  `semantic_key` (`gh:pr:42:merged`, `gh:issue:…`) written `INSERT OR IGNORE` (a redelivery/backfill
  overlap drops as `unchanged`). Its `subject_login` is a SECOND identity (who the event is about),
  trusted only post-HMAC — distinct from the writer.
- **Author is ALWAYS the authenticated principal**, passed in by the caller. The client-supplied
  `session.author` is advisory and ignored. (This writer rule does NOT clobber an event's `subject_login`.)
- **Repo capture is a SECOND, sibling gate to `ingestEvent`** — same reconciliation (a UNIQUE `semantic_key`
  written `INSERT OR IGNORE`, so a redelivery or a backfill overlap drops as `unchanged`) but deliberately
  NOT the `events` table: `ingestEvent` raises an `identity_tasks` row per unmapped `subject_login`, which is
  wrong for bots and high-volume CI telemetry (pushes, checks, runs). `ingestRepoEvent` carries no
  vocab/confidence and does no identity intake or summarization; it is reached only from the HMAC-verified
  webhook and from `reconcileRepo` (`src/repo/github.ts`, service-token GitHub reads — run by an admin's Sync
  GitHub and by the repo cron, never on the render path) — never through `/ingest` or `record_session`.
  `src/webhook.ts`'s `WORK_EVENT_NAMES` (`pull_request` / `issues`) and `REPO_EVENT_NAMES` (`pull_request` /
  `push` / `pull_request_review` / `deployment_status` / `check_run` / `workflow_run` / `status`)
  independently gate which deliveries feed which capture; a repo-capture failure is caught and logged, never
  costing the My Work capture, and the webhook's response body carries `repo: { captured, unchanged }`
  alongside the existing `captured` / `unchanged`. PR-close and issue capture into `events` is unchanged by
  any of this. **`repo_metrics` points and `repo_snapshots` are computed writes, not gated ingestion**: the
  `status` delivery's `metricsFromStatus` arm, the cron's pollers and reconcile's snapshots write them direct
  through `putMetric` / `putSnapshot` (`src/repo/store.ts`) — each validates its own input, and `putMetric`
  is first-write-wins.

Authored and computed writes are **direct, in the `promote` class** — NOT the ingestion gate — exactly
like `promote_doc` / `ratify_adr` / `complete_sprint` always have been: the plan write
(`update_plan` → `write_plan`, versioned non-destructively) and the computed writes (the progress cache in
`tools/progress.ts`, the PR summaries in `tools/summarize.ts`). When adding an **ingestion** path
(agent-proposed content), add it to the gate — never a second ingestion surface; authored/computed writes
stay direct in the promote class.

**Tickets are the largest authored-write surface** (`src/tools/tickets.ts`, thirteen session-cookie routes in
`routes.ts`): `create_ticket` (opening `ticket_events` row) / `edit_ticket` (title and/or body) / `transition_ticket` / `move_ticket` (a board drop) / `toggle_assignee` /
`add_ticket_link` / `remove_ticket_link` / `set_ticket_sprint` / `set_ticket_parent` / `add_ticket_comment`. There is no vocab
gate, no confidence, no staged state. Every write bumps `tickets.updated_at` (the queue's sort key); the
status machine is `canTransition` in `shared/tickets-core.ts` (re-exported by `shared/tickets.ts`) and is
never re-declared server-side; an illegal move or a nesting-rule break is a 409 that writes nothing;
tickets nest exactly ONE level (`set_ticket_parent`'s four rejections).

**The ticket board** (the queue's DEFAULT view, `web/src/tickets.ts` `boardView`; the Table is the other).
Statuses are `submitted` (Triage) / `in_progress` / `testing` / `done` / `declined` — `testing` (0033) is an
optional step, not a gate. The board moves FREELY (the owner's call, 2026-09-26): any OPEN status —
`OPEN_STATUSES`, spelled `OPEN_STATUS_SQL` in every SQL reader (My Work, the badge, the Repo tile, `seg=open`) —
may move to any other, Triage straight to Done included; `done` / `declined` stay terminal. Each column is in
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

**The writer is a PERSON — over a cookie, or over their own bearer token.** Seven of those writers are also
MCP tools (`src/tools/tickets-agent.ts`, the read side below), scoped so an agent writes only inside its
principal's lane. That is a narrowing of the old "ticket writes are cookie-only" rule, not of the
invariant underneath it: **nothing INFERS a resolution.** `done` / `declined` are never set by a PR
merging, an issue closing, the webhook, or `scheduled()` — a person asks for them, and an agent holding
that person's token asking is that person asking. ONE carve-out: a ticket MIRRORED from a GitHub issue
follows its OWN source issue's close and reopen (see "Tickets mirrored from GitHub issues"); a native
ticket that merely links an issue never does. `toggle_assignee` is the one writer with NO MCP
counterpart (design D3): assignment is the data the lane rule is built on, so after filing it is
cookie-only, forever.

**The feed brief** (`0034_feed_brief_artifact_cap`, spec `docs/superpowers/specs/2026-09-26-feed-brief-design.md`). A
feed entry has two readers. `summary` is the one-line title; `brief` (optional, 1–2 plain sentences,
`FEED_BRIEF_MAX` = 280 characters, over it is a validation error that writes nothing) is the problem solved
in product words, for PEOPLE; `body` is the agent record. The Feed screen's header switch **For reading**
(default; title + brief + artifact chips, no body — an entry with no brief is title-only) / **For agents**
(the full body) is client-side, saved per browser as `canopy.feedView`. `get_feed` returns both, and
`query`'s assembled feed body leads with `Brief: …`. The Feed screen has the Roadmap Narrative's two columns — ONE shared
helper, `asideColumns` (`web/src/ui.ts`; CSS `.cnpy-cols-page` / `.cnpy-cols` / `.cnpy-cols-aside`: a 360px aside,
sticky at the page's own top padding `--cols-pad-top`, one column under an 880px page; not the sidebar's
`.cnpy-aside`) — with a two-box aside: **This week**, over `GET /feed/stats?days=7&tz=<minutes east of UTC>`
(`src/tools/feed-stats.ts`, DTO `shared/feed-stats.ts`; session cookie; `days` 1–30, `tz` ±840, else 400; a
failed read is 503 `{ error }`, never a 500): `{ days: [{date, count}], total, people, topTags, topAuthors }`
over the WHOLE team in the viewer's LOCAL days (UTC when `tz` is absent), every day listed so a zero is a
true zero — two statements, loaded on entering the Feed, never on a filter change; its tag and author chips
apply the Feed's own `setTag` / `setAuthor` filter; and **Waiting on review**, the Review queue from the
boot-loaded proposals + draft ADRs as `reviewHeadsFromReads` heads (no diff), each row `mwOpenReview`. The `record-session` skill always writes a brief; the
body's soft target is ~2,500 characters. Pre-0034 entries were filled once by
`scripts/backfill-feed-briefs.mjs` (local, Gemini, dry run by default, `--apply` only `WHERE brief IS NULL`).

## Read side — FTS5 query engine

`src/tools/reads.ts` exposes a ranked FTS5 `query()` engine (bm25, title/summary weighted) that backs
both MCP `query` and `GET /search`, over five types: `doc` / `decision` / `feed` / `sprint` / `ticket`. Each
result is authority-flagged: `live` / `staged_pending` / `unpromoted` / `draft`. The doc/feed/ADR index
lives in `migrations/0008_fts.sql` (recreated in `0011_fts_recreate.sql`); `0013_roadmap_fts.sql` adds a
standalone `roadmap_fts` over the plan narrative + sprints (refs `plan` / `sprint:<id>`, re-keyed by
0025) so `query` surfaces the roadmap, and `0024_tickets.sql`'s `tickets_fts` backs the `ticket` type
(ids `ticket:<id>`, always authority `live` — a ticket is an authored human write with no staged state).
`get_doc` is the exact-slug fetch (all versions + live body); `list_tickets` / `get_ticket` /
`ticket_badge` are the queue's read projections (no N+1 — grouped queries keyed by ticket id). The
assembled `sprint` body's `Progress: closed/total` line uses the SAME `sprintProgress` rule as the
Roadmap (tickets + cache), never the cache alone.

**The "search everything" dropdown — `GET /search/quick`** (`src/tools/quick-search.ts`, DTO
`shared/quick-search.ts`, panel `web/src/quicksearch.ts`; session cookie, NEVER MCP). As a person types in
the sidebar box it returns `{ result: { q, groups: [{ type, hits }] } }` — per type the top `limit` (default 4,
max 8) hits, each a title + short plain fields (`snippet` / `status` / `by` / `at`, a person's `color`) the panel
composes into ONE context line; never a body. Groups, in order: `ticket` (tickets_fts + an exact `#12` / `12`
id), `doc`, `decision`, `sprint` (roadmap_fts), `artifact`, `prompt` (prompts_fts), `handoff`, `person`, `feed`.
**Visibility — the human, live-only reading of `/search`**: a never-promoted doc and a non-ratified decision are
withheld; artifacts go through `searchArtifactsStmt` (`src/tools/artifacts.ts`, the ONE visibility rule —
another person's private page and an un-uploaded page never appear) with drafts dropped; a prompt only once
it has a PUBLISHED version (its context is the description, not the body); handoffs only the viewer's own —
left for them, left for anyone, or sent by them — pending or claimed (the inbox boxes' union); reserved
system handles never appear as people. **Speed**: a query under 2 characters (or with nothing matchable)
returns no groups WITHOUT touching D1 (the Screens list is static, client-side); otherwise every lookup is a
LIMITed statement and all of them go in ONE `db.batch` (one D1 round trip). FTS input is rebuilt by
`buildPrefixMatch` — word tokens only, each quoted and PREFIX-matched (`"tok"*`), so typed operators/quotes
are inert (never a 500); porter stems a prefix term too, so the last token also tries itself 1–2 characters
shorter (`searchi` → `search*`) to match past its stem. Handoffs and people are not FTS: a LIKE (literal —
`%`/`_` escaped) over the viewer's handoffs (a scan of a small table, NOCASE like `listHandoffs`) and over
`persons` (tiny). Measured against `wrangler dev` (local D1, 15 queries × 7 runs, in-page fetch): p50 ≈ 12
ms, p95 ≈ 28 ms, max ≈ 60 ms. A failure answers 200 with empty groups + `degraded: true`. **The panel**
lives on `<body>`, outside the app mount (like the lightbox, carrying `data-cnpy-theme`), so rerenders never
touch it and the sidebar's pinned tree is unchanged; `rerender()` calls `qs.sync()` to re-anchor/re-theme it.
Rail expanded: it hangs under the sidebar box (≈ 340–380px wide), which stays the input. Rail collapsed or
narrow: ⌘K / the icon open a centered palette (≤ 480px) with its own input. **It never reshapes under a
keystroke**: results paint only after a 1 s PAUSE in typing (what is shown stays put until then; ⌘K and a
refocus paint at once); opening, closing and every height change animate (~200 ms, off under reduced motion).
Behind the pause: the request starts 120 ms after a keystroke, the in-flight one is aborted on every
keystroke, a 40-entry LRU (60 s TTL) answers repeats with no fetch, and a pause that passes with the answer
still out shows the longest cached PREFIX's still-matching hits plus "Searching…". One-line rows, no accent
strip — selection is a background fill. ↑/↓ move (a first press before the pause shows the results), Enter opens the selected row — or, typed
faster than the panel shows, goes straight to the Search screen with the text; Tab / ⌘Enter = the Search
screen with the query, Esc closes. A pick runs the existing acts (`openTicket`, `openDocFrom`, `openSprint`,
`artOpen`, `openPrompt`, `openHandoff`, `goFeed`, a person → the queue filtered to them; a decision, which has
no screen, → the Search screen on its title).

**MCP ticket/sprint reads are unscoped; the writes are not** — `src/mcp.ts` registers `list_tickets`
(`seg` / `assignee` where `me` = the bearer principal / `category`), `get_ticket`, `list_sprints` and
`get_sprint` for EVERY principal (not admin-gated): seeing the org's queue is how an agent orients.

**`get_repo_dashboard` is the Repo dashboard's read over MCP, for every principal too** — it exposes nothing
a signed-in member cannot see at `#repo`, and nothing per-user. `src/tools/repo-agent.ts` is a VIEW over
`getRepoDashboard` (the same D1-only projection the route serves — never a second projection, never a
fetch): `tab` returns only that tab's sections via `REPO_TAB_SECTIONS` (`shared/repo.ts` — the ONE
section→tab mapping, also read by the screen's "not connected" footer, and compile-time exhaustive over
`RepoDashboard`'s sections); `range` (default `7d`) collapses `usage` / `cloudflare` / each `product` count
to that one range; `include_trends` (default `false`) governs every `trend` array and the drift breakdown —
drift is the one section with no small bound, TWICE over (up to 250 commits a side, and one group per
squash-merged PR among them, on the OVERVIEW tab), so without the flag a group carries `commitCount` instead
of its `commits` AND only the first `DRIFT_GROUP_LIMIT` (20) groups travel, with `groupCount` the full number
beside GitHub's own `ahead` / `behind`; with it, every group and its commits. A section's STATUS is never
touched — `not_connected` / `empty` pass through, never coerced to zeros — and the tool's description says
the same of a `null` INSIDE an `ok` section (`usage[].requests`, a `product` value, `contributors[].reviews`,
`ciFailures.rate`, `prs.openCount`, a delta): unknown, never zero, with `usage[].seen` saying whether the source ever
reported. A projection throw is the degraded empty payload, not an MCP error. The view is per-call and only
serialized — it SHARES structure with the projection, it is not a deep copy. Output: `{ repo, generatedAt,
degraded, tab, range, sections }`.

**The write surface is `src/tools/tickets-agent.ts` — the ONE place the lane rule is drawn** (spec:
`docs/superpowers/specs/2026-09-17-agent-ticket-writes-design.md`). A ticket write over MCP is permitted
exactly when the bearer principal is ALREADY an assignee of that ticket, else `TicketError('forbidden')`
(403) with NOTHING written; an unknown id is `not_found` FIRST, so the check is never an existence
oracle. Each of the seven tools (`create_ticket` / `edit_ticket` / `transition_ticket` / `add_ticket_comment` /
`add_ticket_link` / `set_ticket_sprint` / `set_ticket_parent`) asserts, then delegates to the UNTOUCHED
writer in `tools/tickets.ts` — the transition table, nesting rules and audit rows stay shared with the
cookie routes, which are NOT assignee-scoped and did not change. `create_ticket` is the one unscoped
write (filing is how work enters the queue) and its `assignees` is the only agent-reachable assignment;
`set_ticket_parent` needs the lane on BOTH ids. ONE exception: an **admin** may `set_ticket_sprint` on any
ticket (composing a sprint is sprint management) — it spreads to no other verb. **Sprint writes are
open to every principal** (`create_sprint` / `set_sprint_active` / `complete_sprint` /
`add_sprint_resource` / `delete_sprint`), matching the web, where every sprint route sits under
`sessionGate` with no `adminGate`; only the whole-plan rewrite `update_plan` stays admin-only. **No provenance is stored** (design D4): an
MCP write is recorded as the person, indistinguishable from a click.

- **MCP `query`** defaults `include_staged: true` — agents see staged/unpromoted context (authority-flagged).
- **`GET /search`** (human UI) defaults `include_staged: false` — shows only settled (`live`) content.

## Staged-write model — agents stage, humans confirm

Agents only ever stage; humans confirm via **authenticated HTTP routes that are NEVER MCP tools**:

- Docs: `propose_doc_update` stages a `doc_versions` row (status `staged`); `POST /doc/:slug/promote`
  copies it into the live doc and bumps `current_version` (non-destructive; prior versions remain).
  Reject (soft): `POST /doc/:slug/reject` flips a staged version to `status='rejected'`; the row
  and body remain (non-destructive). Idempotent.
- ADRs: `stage_adr` stages a `draft`; `POST /adr/:id/ratify` flips it to `ratified`.
  Reject (soft): `POST /adr/:id/reject` flips a draft to `status='rejected'`; the row remains.
- Sprints: **nothing about a sprint is ever staged.** 0025 dropped `milestone_proposals` and with it
  the whole agent-proposed-roadmap surface — the gate fn, the contract schema, the promote/reject
  routes, and the `"milestone"` triage-assign kind. A sprint is created and edited by the admin plan
  write (`update_plan` → `write_plan`) or by the session-cookie routes in `src/routes.ts` over the writers
  in `src/tools/sprints.ts` —
  `POST /sprints` (created `upcoming`, `phase` `'Unscheduled'`, no `due` → `target_date` `''` which the
  DTO shows as `due: null`), `POST /sprints/:id/active` (`true` → `in_progress`, `false` → `upcoming`;
  on a `done` sprint `false` is a NO-OP and `true` re-opens it), `POST /sprints/:id/resources`,
  `POST /sprints/:id/complete` which flips status to `done`, and `POST /sprints/:id/delete` — a HARD delete
  (`delete_sprint`, one `db.batch`): its tickets move to the backlog (`sprint_id = NULL`), its
  `sprint_resources` and `sprint_progress` rows go with it, past `plan_versions` snapshots keep naming it. All
  direct promote-class writes, open to any signed-in member; the same five are MCP tools for every principal
  (read side above). `'done'` is NEVER set by the worker and NEVER inferred from issue closure or from every ticket
  in the sprint being resolved — a sprint is completed by a PERSON: `POST /sprints/:id/complete` sits under
  the blanket `sessionGate` with no `adminGate`, so any signed-in org member can do it from the web UI;
  the plan write is the admin path. The
  triage-assign kinds are now exactly `doc` / `adr` / `feed`.
- Triage write-back: `POST /needs-triage/:id/discard` (soft dismiss) and `POST /needs-triage/:id/assign`
  (re-runs the item's `raw` through the SAME gate for the target type, then records `resolution='assigned'`
  with `assigned_ref`). All triage exits are soft — nothing is hard-deleted; `resolved=1` + audit columns
  (`resolved_at`, `resolved_by`, `resolution`, `assigned_ref`) record how each item left the queue.
- `GET /proposals` — server-joined queue of staged doc versions newer than the live doc (both bodies +
  reconciler metadata: `change_kind`, `low_confidence`, `base_version`). The web triage UI reads this
  instead of per-doc N+1 fetches. These are session-cookie HTTP routes, NEVER MCP tools.

## Auth — three classes, two providers in the session class (fully built — don't add a class)

GitHub OAuth + PKCE, gated to **active members of the `SaplingLearn` org** (`SAPLING_ORG` in
`src/auth/github.ts` — a real external org, do not rename it). Three auth classes, kept separate:

- **Session cookie** (humans, the Hono app): signed cookie; every route except the public auth paths
  passes `sessionGate`. The principal is `{ handle }`. Two providers feed ONE fork (`src/auth/onboard.ts`
  `completeSignIn`): **GitHub** (OAuth + PKCE, gated to active `SaplingLearn` members) and **Google**
  (OAuth + PKCE, ID token verified against Google's JWKS, gated to admin **invites**). The fork: known
  identity → session; verified email matches a person → link + session; invited (or GitHub member) →
  onboarding (a sealed 10-minute `onboard` cookie; the person row is created only on `POST /auth/onboard`
  with handle + color); else denied. Link mode (`?link=1` with a session) attaches a second provider in
  Settings; the last identity can't be unlinked.
- **Bearer token** (agents, `/mcp`): either a pasted per-person `canopy_mcp_` token (stored hashed) or an
  OAuth access token (`canopy_oat_`) obtained through Canopy's own OAuth server — both resolve to the same
  person handle in `resolveBearerPrincipal`, so OAuth is how a bearer is OBTAINED, not a fourth class.
  Settings lists a person's live tokens by `token_hint` (the first 4 characters
  of the random part; the value itself is shown once, at mint) via `GET /auth/mcp-tokens`, and
  `POST /auth/mcp-tokens/:id/revoke` soft-revokes the caller's OWN token — someone else's id is the same
  404 as an unknown one. Both are session-cookie routes, never MCP tools. Settings › **Get connection command** (`connectModal` / `connectSnippet` in `web/src/render.ts`) is the ONE place a token's value appears: the click mints, a modal shows the exact setup for Claude Code (`claude mcp add … --header`), Codex (`CANOPY_MCP_TOKEN` + `--bearer-token-env-var`), a `.mcp.json` or the bare token, against the SPA's own origin, and names the Settings row the token now lives under; closing the modal drops the token from the page for good. `/mcp` is **bearer-only**; its `401` carries
  `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource"` (plus
  `error="invalid_token"` when a token was presented), which is how Claude Code and claude.ai discover
  sign-in. A fresh `McpServer` is constructed per request
  (SDK ≥1.26 guards against reuse); `createMcpHandler` is stateless (no Durable Object / McpAgent).
- **MCP OAuth** (`src/auth/oauth.ts` core, `oauth-routes.ts` HTTP, `oauth-pages.ts` pages; spec
  `docs/superpowers/specs/2026-09-24-mcp-oauth-design.md`; migration `0029_oauth`): RFC 9728/8414 metadata,
  RFC 7591 registration (public clients, loopback redirects match on any port), authorization code + S256
  PKCE, a server-rendered consent page shown on EVERY authorization (CSRF = HMAC over session + request),
  access 1 h; refresh tokens rotate with a 60 s reuse interval — a reuse past that window revokes the
  whole grant — and a rotated refresh token is kept until its OWN expiry (90 days idle), so a late reuse
  is still caught. Sign-in from
  an authorize link survives GitHub/Google and onboarding via the sealed `oauth_pending` cookie. Settings ›
  MCP access lists connections (`GET /auth/oauth-grants`, `POST /auth/oauth-grants/:id/revoke` —
  cookie-only, never MCP). `pruneOAuth` rides the repo cron's `:30` tick and deletes spent or expired
  codes, access tokens a day past expiry, refresh tokens past expiry, and client registrations that never
  got a grant after 90 days (`UNGRANTED_CLIENT_TTL_MS` — long enough that a person denied at authorize,
  e.g. not yet invited, still finds their registration on a retry days later) — grants themselves are never
  deleted. An unknown `client_id` at authorize is an error PAGE naming the Claude Code fix (`/mcp` → canopy
  → Clear authentication → Authenticate again), never a silent redirect. Every OAuth endpoint answers an unexpected error
  with `503 { error: "temporarily_unavailable" }` (the authorize pages with a 503 error page), never a 500.
- **GitHub webhook** (`/webhook/github`, `src/webhook.ts`): a delivery authenticates by an HMAC-SHA256
  `X-Hub-Signature-256` over the raw body against `GITHUB_WEBHOOK_SECRET` (NOT `COOKIE_SECRET`). HMAC is
  verified in the branch BEFORE the gate; a bad/absent signature (or unset secret) is a bare `401`. The
  writer principal is the fixed string `"github-webhook"`; the delivery's own `subject_login` is trusted
  only post-verify. This branch never touches `sessionGate`.

## Identity — persons, not logins

`persons` (handle PK; name, color, email) is the root — the handle is chosen at first sign-in, prefilled
with the GitHub login, and renameable from Settings (`renamePerson` rewrites every stored handle
atomically via `HANDLE_COLUMNS`, in one D1 batch with FK checks deferred for the transaction).
`identities(provider, subject) → person` holds the GitHub login and Google `sub`. Event subjects
(`events.subject_login`) resolve to a person through the github identity row at read time
(`resolvePersonForLogin`); an unmapped login raises an `identity_tasks` row and Maintenance › Identity
links it to an existing handle. Mapping a login there calls the same `linkIdentity` as sign-in linking, so
it also grants that GitHub account sign-in as the mapped person, not just attribution — there is no undo
route yet; fix a wrong mapping by deleting the `identities` row with `wrangler d1 execute`. `ADMIN_LOGINS`
holds handles — list the new handle there before an admin renames (`POST /auth/me/handle` 403s otherwise).
Every `recorded_by` / `created_by` / `user_id` is a handle. Migrated GitHub users kept their login as handle.
`docs.owner` (0035) is one too — the proposer of a doc's FIRST version, set once at creation and never
overwritten by edits or promotions (`updated_by` is the last promoter) — listed in `HANDLE_COLUMNS`; there is no
route to change it yet.

## Roadmap & My Work — authored plan + stored projections, no live GitHub at render

The roadmap is two layers. **The plan** (narrative + sprints + timeline) is admin-authored via the
`update_plan` MCP tool (`update-plan` skill) → `write_plan`: a direct promote-class write, versioned
non-destructively into `plan` (singleton narrative) + `plan_versions` snapshots (`sprints_json`), over
the `sprints` table. **Sprints ARE the old milestones, renamed in place by 0025** — same rows, same
ids, plus `dates` / `summary` / `urgency` / `lead` / `domain` alongside the pre-existing `description`
(now rendered as markdown) and `phase`. Sprint `done` is admin-set here, never event-inferred.
**ONE overdue rule**: `sprintDueState(due, now)` in `shared/sprints-core.ts` — a sprint is due all of its
(local) due day and overdue from the day AFTER, "due this week" = today through 7 days out — read by the sprint
cards, the Roadmap's header dot / Now box / single NEXT UP (`nextSprintId`), the Timeline and My Work's ticket due dates.
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
cron backstop (`recomputeAllProgress`, `GITHUB_SERVICE_TOKEN`, off the render path). `github_ref` is bare
(a GITHUB milestone number — GitHub's own vocabulary, kept deliberately — OR a JSON array of issue
numbers) resolved against `GITHUB_REPO` — only by those two writers, never at render.

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
sessions off `mwSessions` (`GET /feed?author=<me>&limit=3` — never the Feed screen's filtered `feed`), Docs
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

**The Repo dashboard** (`GET /repo/dashboard` → `getRepoDashboard` in `src/tools/repo.ts`; screen `#repo`,
`#repo/code|ci|usage|planning`) is the same class of read as My Work: D1-only, session-cookie, never a 500
(a throw yields `emptyRepoDashboard(repo, degraded:true)`) — and, like My Work, the READ is also an MCP tool
for every principal (`get_repo_dashboard`, see Read side); "Poll now" and Sync GitHub stay session-cookie +
admin, NEVER MCP. **Nothing on its render
path fetches**: every external read happens in the webhook, in `reconcileRepo`, or in the repo cron. Every
block travels as a `RepoSection<T>`, and **never guess** governs all of them: `ok` = something to show;
`empty` = capture HAS landed but nothing falls in the window, or every reading has gone stale (the poll
stopped); `not_connected` = nothing has EVER been captured for it (or no environment is configured). **Every
section has a capture path** — the old list of uncaptured sections is gone from `src/tools/repo.ts` — so
`not_connected` means "its capture has not landed YET", and the screen's copy (`web/src/repo.ts`) names what
each one waits on: a setting or secret by NAME, a webhook event, the target repo's CI, or Sync GitHub. There
is no connect button or flow. "Preview with sample data" swaps in `repo-sample.ts` client-side
(session-only, labelled on screen); it never touches the Worker.

Three capture shapes feed it: `repo_events` rows (through the `ingestRepoEvent` gate — see Core invariant),
`repo_snapshots` (one JSON row per kind: `prs_reconciled`, `env_heads`, `drift`, `branches`, `cf_polled` —
plus the transient `refresh_lock`, which is "Poll now"'s lock and feeds no section) and
`repo_metrics` points (`putMetric`). Every section, its source, and what triggers the capture:

| Section (tab) | Source | Trigger |
| --- | --- | --- |
| `stats` tiles (Overview) | open issues / bugs from `events` issue snapshots (latest per issue, now vs 7 days ago, read with `json_extract` so bodies never leave D1); Open PRs / Awaiting review from `repo_events` `pr` | webhook `issues`, `pull_request`; reconcile PR lists |
| `environments` | `deploy` rows (backend), `check` rows with `part = 'frontend'`, head checks, fresh `health_*` metrics | webhook `deployment_status` / `check_run`; reconcile `deployments` / `env_heads` / `checks` arms; cron health ping |
| `drift` | snapshot `drift` | webhook `push` to a configured environment branch; reconcile `drift` arm |
| `health` | metrics `health_up` / `health_ms` | cron, every tick |
| `codeStats`, `bars`, `prs` (Code) | `repo_events` `pr` / `push`; merged/closed PRs in `events` as the fallback | webhook `pull_request` / `push`; reconcile open + closed PR lists and the pre-capture commit window |
| `branches` (+ the Active branches tile) | snapshot `branches` | reconcile `branches` arm only |
| `deploys` (CI) | the same `deploy` / frontend-`check` rows as `environments`, health excluded | as `environments`, minus the ping |
| `ciFailures` | `run` rows | webhook `workflow_run` (+ `fillFailedJob`); reconcile `runs` + `job_titles` arms |
| `coverage`, `bundle` (CI); `todos` (Planning) | metrics `coverage` / `bundle_kb` / `todo_count` | a `canopy/*` commit status the target repo's CI posts — webhook `status`; reconcile `statuses` arm |
| `activity` | PR closes + issue moves from `events`; webhook `push` rows, `review` rows, landed deploys | the captures above |
| `usage` (Usage) | metrics `cf_requests` / `cf_errors` (requests, error rate) and `active_users_*` | cron `:00` — `pollCloudflare`, `pollSaplingMetrics` |
| `cloudflare` | metrics `cf_*` + snapshot `cf_polled` | cron `:00` — `pollCloudflare` |
| `hosting` | metrics `rw_cpu` / `rw_mem_mb` | cron `:00` — `pollRailway` |
| `product` (Usage) | metrics `sap_c_<key>_<24h\|7d\|30d>` / `sap_t_<key>` — whatever keys the app reports | cron `:00` — `pollSaplingMetrics` (the same response as active users) |
| `sprint`, `labels`, `contributors` (Planning) | live D1: the sprint a person marked `active` (the Roadmap's `sprintProgress`); open-issue snapshots; webhook pushes · merged PRs · `review` rows this week | none / webhook `issues` / `push`, `pull_request`, `pull_request_review`; reconcile `reviews` arm |

"Reconcile" is `reconcileRepo` (`src/repo/github.ts`), run by an admin's Sync GitHub and by the cron's
6-hourly `:20` tick; "cron" is the `*/10` repo trigger — both below. **Everything the cron and reconcile
capture also runs on demand from an admin's "Poll now"** (`POST /admin/poll`, below: health pings, the three
`:00` pollers, reconcile) — and reconcile reads EVERY GitHub input the dashboard has, including the two that
used to be webhook-only (`canopy/*` commit statuses, PR reviews). What stays webhook-only is `issues`, which
feeds `events` (My Work's capture, refreshed by Sync GitHub). The capture names a PR's AUTHOR and an
issue's subject, not who merged/closed, so the feed never claims an actor it does not have.

**Owner prerequisites — what must be true OUTSIDE this repo** (the one place they are listed):
- **The target repo's GitHub webhook must be SUBSCRIBED to every name in `REPO_EVENT_NAMES`**
  (`src/webhook.ts`): `pull_request`, `push`, `pull_request_review`, `deployment_status`, `check_run`,
  `workflow_run`, `status`. Every capture arm exists, but GitHub delivers only what the hook subscribes to.
  Without `deployment_status` / `check_run` / `workflow_run`, reconcile is the ONLY source of deploys, checks
  and runs (up to 6 hours late). The same now holds for `pull_request_review` and `status`: without them the
  reconcile's `reviews` and `statuses` arms are the only source (up to 6 hours late, or an admin's Poll now),
  and a review on a PR outside the 30 most recently updated OPEN ones, or older than that PR's last 10, is
  never backfilled (which is why a polled review never opens the contributors' `R` gate — see below).
  Likewise the `statuses` arm reads ONLY the branch HEAD's statuses: a `canopy/*` status CI posted on a
  commit that was superseded before the next reconcile is captured by the webhook or not at all — a
  permanent, invisible hole in the trend (deliberate: older commits cost one request EACH against the
  subrequest budget, and the arm has exactly one).
- **The target repo's CI must post the three `canopy/*` commit statuses** on a push to the first configured
  environment's branch — the YAML is `docs/superpowers/specs/2026-09-20-sapling-ci-metrics.md`, a PR against
  the separate `SaplingLearn/sapling` repo (bundle size is optional there).
- **The target app must implement `GET /api/internal/metrics`** —
  `docs/superpowers/specs/2026-09-20-sapling-metrics-endpoint.md`. It was not built as of 2026-09-20; until it
  is, every poll is a non-200, nothing is written, and Active users reads "not connected" beside live
  Requests / Error rate — the true, designed state.
- **The secrets under Env / bindings** (`GITHUB_SERVICE_TOKEN`, `CF_ANALYTICS_*`, `RAILWAY_TOKEN_*`,
  `SAPLING_METRICS_TOKEN`) and a `REPO_ENVIRONMENTS` var. **The Cloudflare and Railway query shapes were
  built to the vendors' documentation, never verified against a live call** (no token was available to the
  build), and Railway's docs do not confirm a PROJECT token may read `metrics` — the first live poll of each
  is an owner check. A refusal is a logged failure: nothing is written, the section stays `not_connected`,
  nothing false is ever shown.
- **After a merge that changes `[triggers] crons`, run `wrangler triggers deploy`** — a Workers Builds deploy
  did NOT update the schedule (observed 2026-09-20).

**The repo cron** (`src/repo/cron.ts`, `REPO_CRON = "*/10 * * * *"`; THE description of this trigger — Env /
bindings points here). Cloudflare caps one invocation at 50 subrequests (outbound `fetch`; D1 does not
count), so `handleRepoCron` spreads ONE heavy job per invocation across the six ticks an hour, keyed off the
fire time's UTC minute/hour, each job in its own `safely` arm:
- **every tick** — `pingHealth`: 2 requests per environment (4 today).
- **`:00`, every hour** — the three pollers and nothing else, each skipped entirely when its credentials are
  absent: `pollCloudflare` (1 GraphQL request per environment; needs BOTH `CF_ANALYTICS_TOKEN` and
  `CF_ANALYTICS_ACCOUNT_ID`), `pollRailway` (1 per environment that has a `RAILWAY_TOKEN_<KEY>`),
  `pollSaplingMetrics` (1 GET per environment, `redirect: "manual"` so never a second hop; needs
  `SAPLING_METRICS_TOKEN`). The tick is health 2N + Cloudflare N + Railway N + Sapling N = **5N requests —
  10 today**, which caps the configuration at **N ≤ 9 environments** under the free plan's 50 (a tenth lands
  exactly on the cap, and a health ping that follows a redirect costs a subrequest more). The pollers run
  sequentially, each fetch under its own timeout: worst case ≈ 64 s of wall clock for two environments, all
  I/O wait. The tick calls `runUsagePolls`, and the cron ignores what it returns.
- **every 6th hour** (UTC hour % 6 = 0) — `:10` `recomputeAllProgress` alone (UNBOUNDED: one request per
  issue number of every array-ref sprint); `:20` `reconcileRepo` alone (19 + 2N worst case, below — **19 + 4N with the tick's own
  pings: 27 today, N ≤ 7 under the 50**; logs `failed` when non-empty); `:30` `pruneRepoCapture` (D1 only). `:10` and `:20` need `GITHUB_SERVICE_TOKEN`
  + `GITHUB_REPO`; `:30` and the pings run regardless.
- `:40` / `:50`, and `:10`–`:30` of any other hour, ping health and nothing else.
`src/index.ts` dispatches by EXACT string equality on `controller.cron`, so `REPO_CRON` and the expression
in `wrangler.toml` must stay identical (pinned by a test).

**PR and commit capture — the fallback turns on a completeness marker, deltas on a recording window.**
`prCaptured` = the `prs_reconciled` snapshot exists, which `reconcileRepo` writes only after the open-PR list
was BOTH fetched AND ingested without throwing — a marker, not `provenance = 'backfill'`, because a repo with
zero open PRs would otherwise never earn one. Until it exists the Overview reads Merged PRs · issues · Open
tickets (a live ticket count with a net 7-day delta from `ticket_events`) and the Code tab reads Closed
unmerged, instead of lying with "Open PRs: 0" off one webhook delivery, and the PR list stays the
merged/closed list from `events`; once it flips, Open PRs / Awaiting review replace them (Open tickets
leaves the Overview) and the list includes open PRs with their own head branch. **`prs` is `{ rows,
openCount }`**: `rows` is the capped list (8), `openCount` the Overview's own "Open PRs" figure (one
definition, `prsNow`) — `null` until `prCaptured`, never a count of `rows`; a known count with no recent rows
is still `ok` (My Work's Repo tile reads "Open PRs not captured yet — showing recent merged/closed" on `null`,
and tags `repo.sample` data "Sample data"). The 14-day bars are MERGE
bars until a `push` row exists in the trailing 14-day window (not "ever"), then COMMIT bars; the Commits
tile replaces Issues opened on that same condition, and Active branches replaces Issues closed once a
`branches` snapshot exists. A week-over-week DELTA is a further, independent gate: `recordingSince(db, kind)`
(`MIN(recorded_at)` — not `occurred_at`, which a backfilled row predates) must predate the comparison
window, else the delta reads `0` (rendered "—") rather than an artifact of when capture began — PR tiles
need `recordingSince('pr') <= weekAgo`, the Commits tile `recordingSince('push') <= twoWeeksAgo` (else its
`sub` is just "this week"). **The CI-failure rate follows the same rule**: `RepoCiFailures.rate` is `number
| null` and `trend` may be `[]` until `recordingSince('run') <= weekAgo` — before that a day with no captured
runs is a day capture was not running, not a green day. The failures LIST is NOT gated (those rows are
facts, and `empty` would render "No CI failures this week", itself false); rate and trend share the SAME
seven UTC calendar-day buckets, and a `null` rate draws no percentage and no sparkline, just "A 7-day rate
appears after a week of captured runs." `rate` is a PERCENTAGE (3.5 = 3.5%). `rows` is capped at 5;
**`RepoCiFailures.total`** counts every failed/timed-out run in the same window, and every "N failures" reads
it, never `rows.length`. `ciFailures` itself is `not_connected` until a `run` row has ever
been captured; it does not consult `REPO_ENVIRONMENTS`. Backfilled `push` rows (one synthetic count-1 row PER
COMMIT) are excluded from the activity feed and the contributors' `P` tally — a 40-commit backfill would
otherwise read as 40 feed lines and P=40 — but still count toward the Commits tile and the bars; bots are
excluded from `P` and `R`. `reviews` is `null` (rendered "—", excluded from the bar width, not tallied, so
it neither orders the list nor adds a row) until a `review` row has been captured **BY THE WEBHOOK**
(`hasCaptured(db, 'review', 'webhook')`), never a guessed `0`. A POLLED row does not open that gate: the
reconcile's `reviews` arm sees only the 30 most recently updated OPEN PRs × their last 10 reviews, so a
person whose one review sits on a PR merged before the poll would read a hard `0` — "reviewed nothing", a
claim that arm cannot support; the webhook, once subscribed, is complete going forward. With the gate open,
polled rows count like any other (they dedupe against the webhook's). **`approvedPrs` / "Awaiting review"
are NOT gated** and use polled rows at once: they ask only about OPEN PRs — the set the arm reads — and act
on a positive fact; what the arm misses leaves a PR reading "awaiting review", which is what every open PR
read before the arm existed.

**Environments and deploys — each environment ships two deployables, on two hosts** (`HOSTS` / `PARTS` in
`src/tools/repo.ts`): **Backend** is a Railway `deployment_status`, matched by `deployment.environment`
equalling `cfg.railwayEnv`; **Frontend** is the Cloudflare "Workers Builds" `check_run`, which counts as THAT
environment's frontend deploy only when BOTH its name matches `cfg.workerCheck` AND its branch matches
`cfg.branch` (`fromCheckRun` in `src/repo/capture.ts`) — the same check on a PR branch is just a check.
`deployHistories` (`src/repo/reads.ts`) builds the per-part dot strips and carries its own 90-day bound,
because deploy rows are never pruned. **The pill is a verdict about CHECKS, with health as an override**:
`HEALTHY` needs checks captured on the branch head, none failing, and no failed part; a deploy that landed
with NO checks captured reads `UNKNOWN`; a failed part is a fact on its own, so `FAILING` does not wait for
checks; failing head checks read `DEGRADED`; `DOWN` OUTRANKS everything — a fresh health ping saying the
environment is unreachable is the headline. Whether the `environments` section is CONNECTED is a separate
question: it is `ok` once any part has a result, any head check is captured, OR a fresh health ping landed —
a ping alone connects the card but never makes it `HEALTHY`. **`deploys` is gated on a narrower flag** (a
part with a result OR head checks — health EXCLUDED): a ping is not grounds for "No deploys recorded", so
`deploys` stays `not_connected` until deploy capture itself exists.

**ONE policy for a non-decisive conclusion**, stated at `foldResult` and again at `checkState`
(`src/repo/reads.ts`) and shared by the deploy dots and the PR checks column: `success` = ok;
`failure`/`error`/`timed_out` = fail; `stale`/`action_required`/`cancelled`/`inactive`-without-a-preceding-
success = cancel (abandoned, not failed — `inactive` AFTER a success is just the supersede marker of a
deploy that DID land, which is why `success` is tested first); `neutral`/`skipped` = nothing happened, so
NOT a dot at all, and a pass for the checks icon. The checks column has only pass/fail/run, so the cancel
bucket reads there as not-failing.

**A branch's head comes from `branchHeads`** (`src/repo/reads.ts`), which reads TWO sources and takes the
newer: that branch's latest captured `push` row, and the **`env_heads` snapshot** (`{ [branch]: sha }`)
`reconcileRepo` writes — so a rarely-pushed branch (production) still has a head for checks to key off. The
snapshot wins only when its `computed_at` is newer than the branch's latest push `occurred_at` (or no push
was ever captured), compared as PARSED instants (`Date.parse`), never raw strings: `occurred_at` is stored
WITHOUT milliseconds and `computed_at` WITH them, so within one UTC second a string compare calls a newer
snapshot older. It is deliberately a SNAPSHOT, not a synthetic `push` row: a Sync landing between a real
push and its webhook delivery wrote a count-1 row first and the real count-N push then dropped as
`unchanged` — under-counting commits forever — while every Sync that saw a new head added a phantom commit.
It is replaced wholesale, so one branch's failed head fetch drops that branch's previous entry until the
next reconcile (the arm lands in `failed`). The pre-capture commit backfill still writes real backfill push
rows.

**Health is a standing 10-minute ping, not event capture**: `pingHealth` (`src/repo/poll.ts`) sends a polite
`GET` (8s `AbortSignal.timeout`, `redirect: "follow"`, a `canopy-health` user-agent, no retries) to each
environment's TWO deployables (the frontend URL, `apiUrl + healthPath`), all CONCURRENTLY (`Promise.all` —
sequentially, four dead targets would burn 4 × the timeout; each target still times itself, so `health_ms`
is unaffected). `redirect: "follow"` + `res.ok` means a redirect that LANDS on a 200 counts as up — a
reachability check, not a content check. A thrown fetch is recorded as down, never an exception out of the
cron. Written as `health_up` (0/1) / `health_ms`, bucketed to the 10-minute tick, so a double-fired tick is a
no-op. **A health row older than 30 minutes means the cron has stopped** — `getRepoDashboard` treats it as
ABSENT, both for display and for the pill (a stale "down" cannot drag an environment to `DOWN`). So `health`
has THREE states: `ok` with any fresh reading, **`empty` when readings exist but every one has aged out**
("No fresh health reading — the last ping is over 30 minutes old."), `not_connected` only when none EVER
landed. The read is ONE statement (`latestHealth` in `src/repo/store.ts`) however many environments exist.

**There is exactly ONE `repo_metrics.at` format, enforced at the write seam**: `putMetric` re-serialises `at`
through `toISOString()` and SKIPS an unparseable value — every read (`latestMetric` / `metricSeries` /
`metricsSince` / `latestHealth`) compares `at` as a raw string and the UNIQUE key `(metric, env, part, at)`
includes it, so two spellings of one instant would both mis-order and duplicate. The readers normalise their
`sinceIso` bound the same way (a bound lacking milliseconds would sort AFTER the normalised row of the same
instant and exclude it; an unparseable bound returns `[]`, not every row ever written). `putMetric` is
`INSERT OR IGNORE` — **first write wins, forever** — and returns whether it wrote a NEW row. That permanence
is why every poller below stores only values that can no longer change.

**Drift and branches are snapshots, computed off the render path.** `computeDrift` (`src/repo/github.ts`)
compares `envs[0]`'s branch (the head, e.g. `main`) against `envs[last]`'s (the base, e.g. `production`) via
TWO `GET /compare/<base>...<head>` calls (compare returns only the AHEAD side's commits, so the BEHIND side
needs its own), groups the ahead commits by the PR that landed them (a squash merge's trailing `(#123)`) or
as a direct push, and stores one `RepoDrift` snapshot. The PR-title lookup fans out in chunks (`fanOut`,
`src/db.ts`) — a compare returns up to 250 commits and D1 caps a statement at 100 bound parameters.
`ahead`/`behind` are GitHub's own TOTALS while `groups` is built from the commits actually returned, so past
the 250 cap the strip's HEADER stays truthful and only the expanded breakdown is partial. Two triggers: a
webhook `push` to a configured environment branch (the never-throwing `refreshDrift`, needs
`GITHUB_SERVICE_TOKEN`) and every reconcile; it needs two environments. `computeBranches` pages
`refs(refPrefix:"refs/heads/")` over GraphQL with a per-ref `compare(headRef:$head)` (100 branches per page,
5 pages max — REST would cost one `/compare` PER BRANCH; still paging after the 5th it THROWS rather than
pass off a 500-branch prefix as the whole repo) and stores a `RepoBranches` snapshot: active/stale counts,
the `head` it compared against (the first environment's branch — the list renders `vs <head>`, and a
snapshot written before `head` was recorded renders NO "vs …" rather than guess `main`) and
up to 8 rows — the freshest branches plus up to 3 of the stalest-but-unmerged (14 days untouched = stale).
GraphQL's `Ref.compare` treats THE BRANCH as base and `$head` as head, so `aheadBy`/`behindBy` arrive
INVERTED from the product's meaning — `computeBranches` flips them back on purpose (verified live). It runs
only from reconcile (a full refs page on every push would be wasteful), and still runs with `envs: []` (head
`main`, nothing excluded). Both THROW on failure so reconcile's `safely` can name them in `failed` without
clobbering the LAST GOOD snapshot; `refreshDrift` / `refreshBranches` are the never-throwing wrappers for
other callers. Both sections read `not_connected` until a first snapshot exists and then show a STALE one
rather than nothing — **nothing on screen says how old it is** (`computedAt` never reaches the DTO).

**`reconcileRepo` is the backfill AND the self-heal**, the same function from both triggers: an admin's Sync
GitHub (`POST /admin/backfill`) and the cron's 6-hourly `:20` tick, so a repo nobody clicks Sync on still
heals within 6 hours. Both need `GITHUB_SERVICE_TOKEN` + `GITHUB_REPO`. Its arms, each in its own `safely`
block: open PRs (+ the `prs_reconciled` marker), closed PRs, the pre-capture commit window, deployments,
completed workflow runs, the failing-job label pass, the environment heads, each environment's head checks,
the `canopy/*` commit statuses, PR reviews, branches, drift. It returns `{ written, unchanged, failed: string[] }` — `failed` NAMES every arm that threw
(`"deployments"`, `"runs"`, …); `/admin/backfill` passes that through as its `repo` object and the cron logs
it.
- **Deployments are ONE GraphQL request** (`ghGraphql` beside `ghJson`; throws on non-2xx AND on an `errors`
  body), filtered server-side by `environments: [<every cfg.railwayEnv>]` with `statuses(first:10)` inline —
  deployments are selected by ENVIRONMENT NAME, only heads and checks are per branch; the arm is skipped when
  no environment is configured. Each status is re-wrapped into the WEBHOOK's `deployment_status` payload
  shape and put back through the pure `repoEventsFromDelivery`, so there is one derivation of a deploy row.
  Verified live: `databaseId` EQUALS the REST/webhook `deployment.id` (so `gh:deploy:<id>:<state>` still
  collides with a webhook row), `state` arrives UPPERCASE and is lowercased, a Bot creator's `login` arrives
  WITHOUT the `[bot]` suffix and is re-suffixed, and a GraphQL status has no numeric id, so `raw.status_id` is
  `null`, never invented.
- **The failing-job label pass reads the BACKLOG, not this run's writes**: the ≤5 newest `run` rows of the
  last 7 days whose state is `failure`/`timed_out` and whose `title IS NULL` (`untitledFailedRuns`) each get
  a `fillFailedJob`, so a first Sync's leftovers drain over later ones. (The webhook calls `fillFailedJob`
  itself for a failed `workflow_run` delivery.)
- **Which environment a Workers Builds check belongs to is decided by NAME + HEAD SHA**, not by the branch
  the poll asked for: the owner is the config whose `workerCheck` matches the run's name AND whose captured
  head equals the run's `head_sha` (falling back to the polled branch) — two branches sharing a HEAD
  otherwise left one environment permanently untagged.
- **The `statuses` arm closes coverage / bundle / TODO** (they used to arrive ONLY as `status` deliveries):
  ONE `GET /commits/<ref>/statuses?per_page=100`, `<ref>` = the head sha the env_heads arm just read for the
  FIRST environment's branch (the branch name when that read failed; `main` with no environment). Each
  `canopy/*` item — at most the newest 10 per context — is rebuilt as the WEBHOOK's `status` payload (context,
  description, state, created/updated_at, sha, `branches: [{ name }]`) and put through the UNCHANGED
  `metricsFromStatus` → `putMetric`: one derivation, one validator, and the same `at` (`updated_at`, else
  `created_at`, normalised by `putMetric`), so a polled point and a delivered one collide on `(metric, env,
  part, at)`. New rows count into `written`, repeats into `unchanged`; a dropped one is `console.warn`ed as
  the webhook does; a 404 or an empty list is not a failure (`ghJsonOrNull`).
- **The `reviews` arm closes the contributors' `R` and APPROVED**: ONE GraphQL request — the 30 most recently
  updated OPEN PRs, each with its last 10 reviews — each review rebuilt as the webhook's
  `pull_request_review` payload and put through the UNCHANGED `fromReview`, `provenance: "backfill"`.
  **Key parity, verified live 2026-09-21** (PR #658's two reviews read over GraphQL and over REST):
  `databaseId` EQUALS the REST/webhook `review.id`, so `gh:review:<id>:<action>` is the webhook row's key;
  `submittedAt` = `submitted_at` and `url` = `html_url`, string for string; `state` arrives UPPERCASE and is
  lower-cased; a Bot's `login` arrives WITHOUT `[bot]` and is re-suffixed. A DISMISSED review is wrapped as
  the webhook's `dismissed` action only (key `…:dismissed`) — its state at submission is no longer knowable,
  and a guessed `…:submitted` row would shadow the real one forever. PENDING reviews and ones with no author
  or no `submittedAt` are skipped.
- Worst case **19 + 2N outbound requests** for N environments (23 today): 2 PR lists + 1 commit window + 1
  GraphQL deployments + 1 workflow-run list + ≤5 job lookups + 1 status list + 1 GraphQL reviews + ≤5 branch
  pages + ≤2 drift compares + 2 per environment (head commit, head checks). Under an admin Sync it shares the
  invocation with `runBackfill`'s ~13 (36 today).
- **`/admin/backfill` runs it once per Sync, on the batch that ENDS the loop**: the batch whose
  `summaryBudgetExhausted` reads `false`, OR the one that hits the SPA's own cap while still exhausted —
  `isFinalBackfillBatch(result, batch?, of?)` (`src/tools/backfill.ts`); `runAdminBackfillLoop`
  (`web/src/main.ts`) sends its 1-based `{ batch, of }` (`MAX_BACKFILL_BATCHES` = 10), read defensively
  (absent/malformed → gate on the budget alone). Reconcile redoes ~250 no-op statements on a reconciled repo,
  so not on every batch; `repo` is in the response only when it ran; best-effort, unable to fail the route.

**Coverage, bundle size and the TODO/FIXME count are commit-status metrics**: the target repo's CI posts each
as a GitHub commit status (`context` names the metric, `description` is the number); the `status` delivery
reaches `metricsFromStatus` (`src/repo/capture.ts`) — a SIBLING arm to `repoEventsFromDelivery` in the
webhook's repo-capture branch, since a status produces no `RepoEvent`; reconcile's `statuses` arm feeds the
SAME function the same payload — which turns it into a `repo_metrics` point: `canopy/coverage` → `coverage`, `canopy/bundle-kb` → `bundle_kb`, `canopy/todo` → `todo_count`. A
status counts only when its `branches[].name` includes the FIRST configured environment's branch (the
literal `"main"` when none is configured); an unrelated context (Railway's, CodeRabbit's) is dropped after
one cheap parse, costing zero D1 writes. **`description` must be a strict decimal, range-checked per
metric** — these metrics are never pruned, so a bad point is PERMANENT, and `Number()` alone accepts far too
much (`Number(null) === 0`, `"1e3"`, `"0x10"`, a leading `-`): the trimmed description must match
`/^\d+(\.\d+)?$/` AND fall in range — coverage 0–100, bundle_kb 0–10,000,000, todo_count an INTEGER
0–10,000,000 (`STATUS_METRICS`, one table with the context map). `metricsFromStatus` stays PURE: it returns
`{ metrics, dropped }`, `dropped` set only for a `canopy/*` context refused by the branch filter or by
validation, and the webhook `console.warn`s it once (context + reason, ≤ ~40 chars of the description). A
newly-written point counts into `repo.captured`, a redelivery into `repo.unchanged`. **A delta claims a
trend only once the window holds ≥2 points whose first and last are ≥7 days apart** (`windowDelta`):
coverage/bundle read 30 days, the TODO count 90 (it moves too slowly for 30); the baseline is the window's
FIRST point, which may lie left of the 10-point sparkline. Below that bar `RepoTrend.delta` is `""` and
`RepoTodos.delta` is `null` — value shown, no delta text, no "since" — and `spark()` renders nothing under 2
points. All three read `empty`, not `not_connected`, once a point has EVER landed but none is in the window
(`latestMetric` with no bound, checked only on the empty path).

**"Poll now" — health, usage and GitHub on demand; NOT the issue-derived sections** (`POST /admin/poll`; session-cookie,
admin-only — a non-admin is 403 `{ error: "admin only" }` — no request body, NEVER an MCP tool). It calls
`runRepoRefresh(env, Date.now())` (`src/repo/cron.ts`), which runs three sources **in this order, each in
its OWN guarded arm** (a failure in one never skips another): **health** (`pingHealth`), **usage**
(`runUsagePolls`, unchanged — Cloudflare, Railway, the app's metrics), **github** (`reconcileRepo` with the
service token: deploys, checks, runs, branches, drift, open PRs, env heads, the `canopy/*` commit statuses
and PR reviews). The result is
`RepoRefreshResult` (`shared/repo.ts`, types only): `UsagePollResult`'s `cloudflare` / `railway` /
`sapling`, plus `health` — one `PollOutcome` per TARGET (`part` set; `ok` = up, `failed` = down with FIXED
words `timeout` / `HTTP <status>` / `unreachable`; `"not_configured"` with no environment) — and `github`:
`{ written, unchanged, failed }` (`failed` = reconcile's ARM NAMES), `"not_configured"` without
`GITHUB_SERVICE_TOKEN` + `GITHUB_REPO`, `failed: ["unexpected error"]` on an unexpected throw. **The cron
does NOT call it** — its per-tick spreading stands. **Budget: health 2N + usage 3N + reconcile (19 + 2N) =
19 + 7N subrequests — 33 for two environments, and the free plan's 50 caps it at N ≤ 4** (47; 54 at five); past that the
github arm is SKIPPED and says so (`failed: ["skipped: would exceed the subrequest budget"]`) rather than
risk the invocation, while health and usage still run. **Deliberately excluded**: `recomputeAllProgress`
(UNBOUNDED — the reason it has a tick of its own — and it feeds the Roadmap, not this dashboard),
`pruneRepoCapture` (maintenance, not a refresh) and `runBackfill` / summaries (that is Sync GitHub: My Work's
capture, with its own Gemini budget loop). **That last exclusion has a visible cost**: `runBackfill` is also
the ONLY non-webhook writer of the `events` issue snapshots, so the Overview's Open issues / Open bugs tiles
and their deltas, Planning's Issues by label and the activity feed's issue lines do NOT move on a poll — they
refresh with Sync GitHub, and the button's title says so. **Idempotent with the cron**: the pollers key on the HOUR FLOOR,
reconcile on semantic keys and snapshot upserts. **The on-demand health ping is stamped to the SECOND, not
the ten-minute tick** (`HEALTH_ON_DEMAND_BUCKET_MS = 1_000`): `putMetric` is first-write-wins, so a reading
floored to the cron's bucket is dropped and the screen keeps the tick's — and a one-MINUTE floor still
collided for the whole of the tick's own minute (`:X0:40` floors to `:X0:00` either way), so a real DOWN was
shown in the strip and then dropped while the pill stayed HEALTHY. A second lands a NEWER row, which
`latestHealth` (the only reader, latest row per target) picks up; the double-fire guard on this path is the
lock, not the floor. Second-stamped rows read and prune like any other (45 days); a poll every 2 minutes for
a day costs 5,760 health rows for two environments, beside the cron's own 1,152. **The lock**: overlapping runs are correct but wasteful, so `runLockedRepoRefresh` takes a
`repo_snapshots` row `refresh_lock` (`{ by, at }` — not a dashboard section) in ONE statement, an upsert that
only overwrites a row older than **3 minutes** (`REFRESH_LOCK_MS = 180_000`); a younger one is a 409 `{ error:
"a refresh is already running", since }` that runs nothing. It is cleared in a `finally`, and only when the
row is still the caller's own. **What the lock does and does not promise**: it outlives the REALISTIC worst
case (seconds when GitHub answers; ≈ 64 s of pollers all hanging plus a slow reconcile is still inside it),
not the theoretical one — every GitHub read is now bounded (`ghJson` / `ghJsonOrNull` / `ghGraphql` carry an
`AbortSignal.timeout(15_000)`, a timeout surfacing as that arm's name in `failed[]`), and 23 of them all
timing out is ≈ 6 minutes. If a run ever overruns its lock a second run may start beside it: correctness
holds (every write is idempotent, and the overrun run's release is a no-op because the row's `json` is no
longer its own) — only budget is wasted.
The response is 200 even when every source failed (the body says so), 502 `{ error: "poll failed" }` only if
the lock statement itself throws, never a 500 — and it carries outcomes but **never a token, a header or an
account id**; `src/repo/github.ts` now LOGS a failed read as its message with the service token scrubbed
(`scrubbedMessage`), never the Error object, since a thrown fetch or a GraphQL `errors` body can quote the
`authorization` header back — and `src/repo/cron.ts` does the same at EVERY log site it has (`scrubbedLog`:
the cron's generic `safely` logger — which wraps the progress arm's service-token fetches — and
`runUsagePolls`' arm), scrubbing every secret the module hands to a fetch, literally and empty-guarded.
**On screen** the button lives in the **Repo top bar, beside the refresh icon, on every tab** and in every
state of the dashboard (loading, failed, degraded, all `not_connected`) — admins only, hidden in sample
mode, and a non-admin's bar is byte-for-byte what it was (pinned by a test; the refresh icon's title is
"Reload from Canopy's database" only beside the button, whose own is "Poll deploys, CI, usage and health now
(admin) — issues refresh with Sync GitHub", and "Polling…" while it runs). A
container query on the BAR (`.repo-pollbtn` in `canopy.css`; only a bar that has the button is a container)
makes it icon-only when crumb + labelled controls no longer fit (bar content < 740px — a viewport under
~850px with the rail collapsed) and drops the "updated …" text under 676px, so at phone width an admin's
controls (281px) are narrower than a non-admin's (343px). While in flight it is disabled and reads
"Polling…" (the refresh icon's `cnpy-spin`, off under reduced motion); a second click does nothing. On
completion the dashboard reloads (the payload stays on screen, so the entrance is not replayed) and a
dismissible strip flashes in at the top of WHICHEVER tab is open (`state.repoPoll`, `repoPollFor`:
session-only, survives a tab switch, cleared on leaving the Repo screen): `Health — 3 up · staging api ✗
timeout`, the three usage lines as below, `GitHub — 12 new · 240 unchanged` / `✗ failed: deployments, runs`
/ `– skipped: …` / `not configured`; a 409 reads "A refresh is already running — try again in a minute.",
any other failure "Poll failed — try again."

**`POST /admin/poll-usage` remains — the narrower, older route** (same gate, no lock): the three usage
pollers only, via `runUsagePolls(env, Date.now())` (`src/repo/cron.ts`), the SAME function as the `:00`
tick; the SPA no longer calls it. **Idempotent with the cron**: every poller keys on the HOUR
FLOOR of `now` and every write is `INSERT OR IGNORE`, so a run at any minute asks for the same hours and
writes the same rows. **3N subrequests** (6 today; no health pings). Each poller returns one `PollOutcome`
per environment (`shared/repo.ts`, types only: `ok` with `written` = NEW `repo_metrics` rows — `0` is a
legitimate re-poll; `failed` with `detail` = the SAME scrubbed message it logs (scrubbed BEFORE any cut, on the non-2xx AND the 200-with-`errors` path; an error body is read to at most 8 KB); `skipped` with a
few fixed words — no worker / no project token / no `railwayEnvironmentId` / no `railwayServiceId` /
`apiUrl` not https), and `UsagePollResult` is those per source, or `"not_configured"` when the source's
secret(s) are absent — exactly when the cron skips it. The response is 200 even when every source failed
(the body says so), 502 `{ error: "poll failed" }` only if `runUsagePolls` itself throws, never a 500 — and
it carries outcomes but **never a token, a header or an account id** (`pollCloudflare`'s one scrub covers
the account id as well as the token). A Cloudflare or Railway **non-2xx says why**: the body's
`errors[0].message` (+ `code`), else the raw text's start, scrubbed BEFORE it is cut (`failureReason`), and
Cloudflare's 400 / 401 / 403 each append a fixed hint (malformed token value / invalid token / lacks Account
Analytics: Read). In the strip the
Sapling line is labelled "App metrics" (one response carries active users AND product metrics); an `ok`
outcome's `detail` (dropped product keys) and a `failed` outcome's partial `written` are both shown.

**Cloudflare Workers analytics** (`pollCloudflare`, `src/repo/poll.ts`) asks Cloudflare's GraphQL analytics
API (`https://api.cloudflare.com/client/v4/graphql`, dataset `workersInvocationsAdaptive`, `scriptName` =
each environment's `cfg.worker`, grouped by `datetimeHour`, `sum { requests errors }`) and writes hourly
`cf_requests` / `cf_errors` (`env` = the config key, `part = 'frontend'`). Cloudflare's schema spells its
scalar **`string`, lowercase** — `String!` is rejected. **The window is LAGGED one hour** — `to` = the
current hour's floor − 1h, `from` = `to` − 3h (at 12:00 it reads 08:00–11:00): the poll fires seconds after
an hour closes, when the adaptive dataset may not have caught up, and a short count would be permanent.
`datetime_leq` is inclusive, so the bucket AT `to` is skipped (`at >= to`); the overlap heals a missed tick
and cannot re-count a written hour. A GraphQL failure arrives as HTTP **200 with an `errors` array** — that,
a non-2xx, a thrown fetch, or a body with no account in it costs THAT environment the tick (logged; `data`
is never read beside `errors`) and the loop moves on; a malformed row is skipped on its own. Never throws.
**The `cf_polled` marker — no row ≠ zero unless we know we looked**: Cloudflare returns NO row for an hour
with no invocations, so a quiet hour and a dead poll look identical in `repo_metrics`. Each environment whose
poll SUCCEEDED (even with zero rows) has its window merged into ONE snapshot row, `cf_polled` (`CF_POLLED` in
`src/repo/types.ts`): `{ [envKey]: { from, to } }` — ONE contiguous covered INTERVAL, `to` exclusive. An
interval, not a high-water bound, because a bound cannot say a stretch in the middle was never looked at: when
the previous interval reaches the new window (`prev.to >= window.from`) it keeps its `from` and `to` becomes
the max; otherwise (no previous, or a GAP — an outage longer than the 3-hour window) `from` RESTARTS at the
window's start, and that jump is the record of the hole. One read + at most one write per poll (an unlocked
read-modify-write, safe because ticks never overlap and a lost update re-writes identically); a failed
environment keeps its interval, and within one run neither end moves BACKWARDS (the write is an unlocked
read-modify-write, so an on-demand run overlapping a cron tick can put back an older `to` — accepted: that
stretch draws unknown, never zero, and the next poll re-extends it). A LEGACY string value (the pre-interval
shape, still in local dev DBs) reads through `cfCovered` as `{ from: bound − 3h, to: bound }`.
The projection (`projectUsage`) costs the render **ONE statement** — `metricsSince` (`src/repo/store.ts`)
for every range, environment and series, sliced in memory. It takes GROUPS, each with its OWN bound
(`(metric IN (…) AND at >= ?) OR (…)`, `usageReadGroups` in `src/tools/repo.ts`): `cf_*` and
`active_users_30d` over 30 days, `active_users_7d` over 7, `active_users_24h` over 24 hours, and `rw_*` over
the 3-hour staleness window — every row left out is one the projection already discarded (over half of the
~10,000 a flat 30-day read returned). It sits beside ONE
`getSnapshot('cf_polled')`, plus ONE `metricsEver` only on the not-`ok` path. A range is its last N COMPLETE
hours (24 / 168 / 720) in equal buckets (1h / 24h / 24h) ending at the last complete hour, never at UTC
midnight. The trend is DENSE but zero only where a zero is entitled: the fill STARTS at the first captured
point (or the range's start when capture predates it) — **unless that would cross a HOLE** (an hour before
the covered `from` with no real point: nothing ever looked at it), in which case the series starts at the
covered `from` and shows the contiguous covered stretch only, while totals still sum every real point in the
range — and ENDS at `min(last complete hour, that environment's covered `to`)`; with NO marker it ends at the
last real point, so a dead poll draws no zeros after it. **The first bucket drawn is the first WHOLE one**: a
7d/30d day-bucket that capture or coverage began inside is counted in the total but not drawn as a day.
`requests` is non-null when something is known in the range — a point in range, or capture predating the
range AND covered hours inside it (a "0" that is true of the COVERED hours — known limit: when only part of
the range was covered, e.g. a poll that resumed three quiet hours ago after a long outage, the card still
reads "0" for the whole range label) — otherwise `null`, never "0". `errorRate`
needs a real point in range: points summing to 0 requests read "0.00%", but with NO point 0 of 0 is not a
rate → `null` (the screen shows "—" beside live requests). Totals are sums of real points only. `usage` is
`ok` when any metric of any range is non-null; the `cloudflare` panel when the WIDEST (30d) range has rows,
so a narrower range can be `[]` ("Nothing recorded in this range." — never "no requests": the range may be
one no poll covered). **A per-metric `null` does not say WHY**, so each `RepoUsageEnv` carries `seen: {
requests, users }` — whether that environment's `cf_requests` / any `active_users_*` point exists AT ALL in
the one 30-day read, the same in every range. `null` + seen renders **"no recent reading"** (no point in this
range, a poll that stopped, a gauge gone stale); `null` + not seen renders **"not connected"**; the error
rate follows `seen.requests`, keeping its "—" beside live requests. `seen` looks back those 30 days only: a
source silent for longer reads "not connected" per metric again while the section-level `metricsEver` (any
age) still says `empty` — whose copy is "No current usage reading — the hourly polls have gone quiet."

**Railway CPU and memory** (`pollRailway`) asks Railway's public GraphQL API
(`https://backboard.railway.com/graphql/v2`, `metrics(environmentId, serviceId, startDate, measurements:
[CPU_USAGE, MEMORY_USAGE_GB], sampleRateSeconds: 3600)`, `ts` in unix SECONDS) once per environment and
writes hourly `rw_cpu` (vCPU) / `rw_mem_mb` (GB × 1024, one decimal), `part = 'backend'`. **Auth is a PROJECT
token PER ENVIRONMENT, sent as `Project-Access-Token` — never `Authorization`** (a project token is refused
as a bearer): the ONE helper `railwayTokens` (`src/repo/cron.ts`) maps each `cfg.key` to the secret
`RAILWAY_TOKEN_<KEY>` (upper-cased, anything outside A–Z/0–9 → `_`), so a third environment is its secret
and no new cron line. An environment with no token, no `railwayEnvironmentId` or no `railwayServiceId` is
skipped while the others poll. **A token is never logged** — only `cfg.key` and the error's MESSAGE, scrubbed
of every token in the map. Only COMPLETE hours are stored: a sample stamped at or after the current hour's
floor, or before the 3-hour window, is skipped; each is bucketed to its hour; values are validated one by one
(finite, ≥ 0, under 1024 vCPU / 4096 GB); an unknown measurement is ignored. **Within ONE response, per
metric per hour bucket, the valid sample with the LATEST `ts` is the one written** (Railway's array order is
undocumented) — but a row an EARLIER poll stored for that bucket still wins. These are gauges, so — unlike
Cloudflare's counts — there is NO extra hour of lag. A non-2xx, a thrown fetch, a 200 carrying `errors`, or
no metrics list costs THAT environment the tick; never throws. The projection costs **NO new statement**:
`rw_*` ride the same `metricsSince` read, and `projectHosting` picks each environment's latest backend point
in memory. The sources share a read but NOT a state — a Railway row never connects `usage`, a Cloudflare row
never connects `hosting`. **A "current" figure must be current: a value shows only while its latest point is
≤ 3 hours older than `now`**, else that cell reads "—"; `hosting` is `empty` when an `rw_*` row has EVER
landed but none is fresh ("No fresh hosting reading — the last Railway sample is over 3 hours old.").

**Active users come from Sapling's own backend** — the one number Canopy CANNOT compute. `pollSaplingMetrics`
sends `GET {cfg.apiUrl}/api/internal/metrics` with `Authorization: Bearer <SAPLING_METRICS_TOKEN>`
(user-agent `canopy-metrics`, the 8s timeout) per environment and expects `200` → `{ "active_users": {
"24h": n, "7d": n, "30d": n } }`. **The token goes to ONE place**: a non-`https:` `apiUrl` is never fetched,
trailing slashes are normalised, and `redirect: "manual"` + "only a 200 is an answer" means a 3xx is a
failure, never a hop that carries the header elsewhere. The token, headers and request init are never logged
— only `cfg.key` and a short message, scrubbed BEFORE it is cut, quoting ≤ 80 characters of a refused body.
**Validation is the whole response or nothing** (`saplingActiveUsers`): each window a non-negative INTEGER ≤
10,000,000 AND `24h ≤ 7d ≤ 30d`, else NOTHING is written for that environment that tick. Stored as hourly
`active_users_24h` / `_7d` / `_30d` (`part = ''`), `at` = the CURRENT hour's floor with NO lag — a
point-in-time GAUGE is whole the moment it is read; `INSERT OR IGNORE` keeps the first reading of each hour.
The projection costs **NO new statement** (the names are in `USAGE_METRICS` and `usageReadGroups`). For range R, `users.value` is
the LATEST `active_users_R` reading — **never a sum** — shown only while ≤ 3 hours old (the same
`HOSTING_STALE_MS` rule; a reading stamped ahead of the clock does not count), else `users: null`;
`users.trend` is **never zero-filled** (a missing hour is a poll that did not land, not zero users) and is
THINNED for the wider ranges, never truncated (`thinGauge`): 30d keeps the LAST reading of each UTC day (≤ 31
points), 7d the last of each 6-hour block ending at the current hour (≤ 28), 24h stays hourly. A
current users reading makes `usage` `ok` on its own; readings all gone stale leave it `empty`.

**Product metrics ride that SAME response** (contract v2,
`docs/superpowers/specs/2026-09-21-sapling-product-metrics.md`): optional `counts` (windowed `{24h,7d,30d}`
integers) and `totals` (point-in-time integers). `saplingProductMetrics` (`src/repo/poll.ts`, pure) validates
them **per key** — key `^[a-z][a-z0-9_]{0,39}$`, JSON integers `0..1e12`, a count's windows exactly three and
nesting; a section that is not an object or holds more than 48 / 24 keys is ignored whole — reading OWN keys
only into prototype-less objects. Canopy is **generic over keys**: every valid key is stored, as
`sap_c_<key>_<window>` / `sap_t_<key>` hourly gauges (`part = ''`, the hour floor, first write wins), so
Sapling adds a metric with no Canopy change. The two halves never cost each other: a v1 body is a plain
success, and a body whose `active_users` is refused still stores its product keys — that environment reads
`failed`, with `written` the rows that landed. One environment's rows (≤ 171) go in ONE `putMetrics` call.
Dropped keys are logged once per environment by NAME only and named in the outcome's `detail` — an `ok`'s,
and (appended to the refusal) a `failed`'s; an ignored SECTION is one name (`counts.*`) but counts every key
it held. **A rejected name is scrubbed BEFORE it is cut to 40 characters**: the validator takes the poller's
`scrub` as its optional `clean` argument (default identity, so it stays pure), because a scrub matches a WHOLE
secret and 40 characters of a 64-character token (`openssl rand -hex 32`) match nothing — the same rule as
every other cut in `src/repo/poll.ts`, including `failureReason`'s 8 KB READ cap, which scrubs the capped text
whole and then drops a 256-character tail a cut-off secret could be hiding in. Token-leak tests use a
64-character token (`LONG_TOKEN`, `test/helpers/repo.ts`) and assert no 8-character piece of it gets out.
The `product` section (`projectProduct`, `src/tools/repo.ts`) lists every configured environment: `counts`
grouped Growth / Learning activity / Community / AI spend / Reliability / Other (`src/repo/product.ts`; an
unknown key → Other, labelled from the key; `llm_cost_cents` reads as dollars with a "lower bound" note —
`flashcards_created` and `errors_4xx` carry notes too, printed as one footnote block under their group, a
line per noted key; the registry lists what Sapling SERVES, so `study_guides` is not in it and
`rag_chunks_dropped` is labelled "RAG runs that dropped chunks"), one
figure per range, and `totals` on their own ("Right now" — they ignore the range selector). A figure shows
only while its latest reading is ≤ 3 hours old (`HOSTING_STALE_MS`), else `null` → "no recent reading"; a key
with no row in the read is absent. The trend is the daily totals — for a `counts` key its `24h` reading, for a `totals` key its own reading —
stamped EXACTLY 00:00 UTC of each of the last 30 days, a missed midnight ABSENT, the same line for every range. `ok` = any
figure current; `empty` = a `sap_*` row has ever landed (`metricsEver`'s prefix family, in its existing
statement); else `not_connected`. It costs the render **ONE statement** — `productReadings`, a loose index
scan (a recursive CTE hops distinct `sap_*` names, then seeks each name × environment: the fresh range, and
each midnight by equality), because the plain `metric GLOB 'sap_*'` form walks every stored `sap_` entry
(~33k at steady state for two environments) to return ~3k. The shape saves rows READ, not the sort — the
`UNION ALL … ORDER BY` still costs a temp b-tree in both arms.

**On screen the Usage tab is a hierarchy, not tables** (`web/src/repo.ts`): APP USAGE compare (side by side —
comparing environments is its job) → ONE **Product** section → infrastructure. Product shows ONE environment,
picked by a segmented control (`state.repoProductEnv`, session-only; default = the LAST configured environment
that has reported anything, else the first; the pressed button carries no `data-act`, so re-pressing it never
replays the cross-fade; `repoProductEnv` flashes only `.repo-pswap`, a range switch flashes every `.repo-swap`).
Inside it: the `totals` as an inline "Right now" stat strip; up to four headline tiles picked by KEY in a fixed
order (`signups`, `tutor_sessions`, `llm_cost_cents`, `errors_5xx`, then `chat_messages`, `logins`,
`quizzes_completed`; fewer than two present → no strip; `errors_5xx` > 0 is the one toned tile); then a block
per group on a 12-column grid, its SHAPE keyed by the group `id` — `learning` a ranked bar list (sorted by the
range's raw figure, bar = raw ÷ group max, null last with no bar), `ai` one feature figure (`llm_cost_cents`
leads, the other keys are one quiet line — nothing derived, no cost-per-call), `reliability` a status list
(non-zero rows with a tone dot — `bad`, except `errors_4xx` which stays neutral; every measured ZERO folds into
one "N at zero — …" line; a null is named on its own "no recent reading" line and is NEVER counted a zero; the
block's `min-height` is its tallest form across every range and environment so a switch shifts nothing under
it), `growth` / `community` stat pairs, and `other` or ANY unrecognised group id as quiet rows at the end — no
shape may depend on a key existing. `data-count` now takes an optional `data-count-fmt` (`compact` / `usd`,
`formatCount`): `countUp` formats the in-between frames and LANDS on the element's own rendered text, so a
compacted or dollar figure counts up without the browser ever re-deriving the Worker's string. Cloudflare and
Railway are figure-over-label blocks per environment; the Cloudflare error-share bar is `errorShare` over the
two compact strings that block itself shows (`parseCompact`), drawn only when both parse and requests > 0, and
it prints NO percentage (the Worker's own error rate sits in the compare block above — a second, re-derived
figure could disagree with it by a rounding).

**Pruning** (`pruneRepoCapture`, `src/repo/store.ts`, the cron's 6-hourly `:30` tick): `health_*` metrics
and `check` rows older than 45 days — the `check` deletion ONLY `WHERE part IS NULL`, because a FRONTEND
deploy record IS a `check` row (`part = 'frontend'`) and must be kept forever like `deploy` rows; and the
HOURLY usage metrics (`cf_*` / `rw_*` / `active_users_*`) older than 100 days; and `sap_*` product metrics
older than **7 days, EXCEPT the rows stamped exactly 00:00 UTC, kept 100 days** (the daily totals the trend
reads — `sap_*` and the usage globs never match each other's names). `pr` / `push` / `deploy` /
`run` / `review` rows and `coverage` / `bundle_kb` / `todo_count` match no rule and are kept forever.

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
  IMPORT and are Canopy's afterwards — later deliveries never overwrite them, and they are edited like any
  ticket (`edit_ticket`, `toggle_assignee`, the normal transition table). GitHub drives only CLOSURE: a
  `closed` delivery forces `done`/`declined`, `deleted` / `transferred` forces `declined`, `reopened` puts a
  resolved ticket back to `submitted` — through the module-private `forceStatus`, the ONE writer allowed to
  bypass `TICKET_TRANSITIONS`, writing a `ticket_events` row as `github-webhook`. Canopy never writes back to
  GitHub, and a sprint is still completed only by a person.
- **Idempotency / ordering**: creation is ONE guarded D1 batch (ticket, assignees, opening row, locked link —
  each child keyed by `source_ref`), so a replay writes nothing twice; a delivery older than
  `source_updated_at` is skipped whole; one already applied (same `updated_at`) forces nothing, so a
  redelivery cannot undo a later Canopy change.
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

## Handoffs & Prompt Library — direct writers, NOT the ingestion gate

Ported from the Claude Design project `2c8cfa50`: **Handoffs** (Workspace; `#handoffs`, `#handoffs/new`,
`#handoffs/<id>` — `web/src/handoffs.ts`), **Prompt Library** (Knowledge; `#prompts`, `#prompts/new`,
`#prompts/<slug>`, `#prompts/<slug>/edit|version` — `web/src/prompts.ts`), **Docs › New doc** (`#docs/new`) and
the tabbed **Maintenance** (Unplaced / Identity / People; the admin email-notification sections sit under People).
Storage is `0028_handoffs_prompts` (`handoffs` with an INTEGER id rendered `#12`, `context` JSON
`{ repo, branch, task, done[], next[], files[] }`, an inline prompt that is both-or-neither, `expires_at` =
created + 7 days; `prompts` / `prompt_versions`; standalone `prompts_fts` over slug/title/description/body/tags
kept at the LATEST version by triggers on BOTH tables). DTOs + helpers: `shared/handoffs.ts`.

- **A handoff is an addressed message, not knowledge** — `src/tools/handoffs.ts` writes it directly (no vocab,
  no confidence, never staged). The sender is always the principal. A create carrying a session id is
  replay-safe through `processed_items` (item_type `handoff`, same session-id + item-index key as `/ingest`).
  **Claim is ONE conditional UPDATE** (`… WHERE status = 'pending' AND (recipient = 'anyone' OR recipient = me OR
  sender = me)`); on 0 changes it re-reads for 404 / 403 / 409 `handoff is <status>`, so a race has one winner.
  Expire: sender or named recipient, pending only. Create writes a feed row through `append_feed` (no tags).
  The repo cron expires overdue pending handoffs on EVERY tick (`expireDueHandoffs`, D1 only, before the `:00`
  early return).
- **Prompts** (`src/tools/prompts.ts`): every save appends a version; the latest version's status/body ARE the
  prompt's. `savePrompt(…, via)` — a person (`via: "human"`, the cookie route) saves draft/staged/published and
  may rename the slug (both tables, one batch); an agent (`via: "agent"`, MCP `save_prompt`) is FORCED to
  `staged` and may not rename. Publishing a staged version and retagging are session-cookie only. **Usage**
  (0035): `use_count` / `last_used_at` (on `PromptSummary` / `PromptDetail`) are bumped by ONE conditional UPDATE
  in `recordPromptUse` — from MCP `get_prompt` (every principal) and `POST /api/prompts/:slug/used` (the web Copy
  button; 404 unknown slug, 503 on a D1 failure, never a 500); a use is not an edit, so `updated_at` stays, and
  `GET /api/prompts?sort=used` lists the most used first.
- **Delete is SOFT** (0035 PART C; `deletePrompt` / `restorePrompt`): `POST /api/prompts/:slug/delete` stamps
  `deleted_at` / `deleted_by` and touches nothing else — every `prompt_versions` row stays in D1. Only the prompt's
  AUTHOR (case-insensitive) or an ADMIN (`isAdmin`); anyone else is 403 with nothing written. A deleted prompt is
  gone from EVERY read — the library, `GET /api/prompts/:slug` (the same 404 as an unknown slug), versions,
  `/search/quick`, MCP `search_prompts` / `get_prompt`, `prompts_fts`, and so every picker fed by the library — and
  takes no write (tags / publish / use / a second delete are 404). **Its slug stays RESERVED**: a save to it (new,
  rename target, or an agent's `save_prompt`) is a 409 `slug <s> belongs to a deleted prompt — restore it instead
  of reusing the slug` — chosen over reuse because a reused slug would silently re-point everything that names it
  (handoffs, skills, agents' `get_prompt` calls) at different instructions, and would collide with a restore.
  `POST /api/prompts/:slug/restore` (same people; 409 `prompt is not deleted` on a live one) clears both columns,
  so the prompt is back exactly as it was. Both are session-cookie only — there is NO MCP delete, so an agent can
  never remove a prompt. On screen: "Delete prompt" in the prompt page's header (author / admins only), the shared
  confirmation MODAL (`web/src/confirm.ts` — see "The confirmation modal" under Artifacts; never `window.confirm`),
  then the library with a toast "Deleted “<title>” · Undo" (`flash(msg, ms, action)` — a
  toast may carry ONE `data-act` button) whose Undo calls restore. There is no list of deleted prompts.
- **Routes** (session cookie, `{ error }` on failure): `GET /api/handoffs?box=mine|me|anyone|sent`,
  `GET /api/handoffs/:id`, `POST /api/handoffs`, `POST /api/handoffs/:id/claim`, `POST /api/handoffs/:id/expire`,
  `GET /api/prompts?q&tags&sort`, `GET /api/prompts/:slug`, `GET /api/prompts/:slug/versions`, `POST /api/prompts`,
  `POST /api/prompts/:slug/tags`, `POST /api/prompts/:slug/publish`, `POST /api/prompts/:slug/delete|restore`, and
  `POST /api/docs/propose` (a person stages
  a NEW doc through `ingestDocProposal`; an existing slug is a 409). The Hono app stays cookie-only — agents
  reach these through MCP, not a bearer on `/api/*` (no new auth class).
- **MCP** (every principal): `send_handoff`, `list_handoffs` (pending `me` + `anyone` by default; only `sent`
  shows claimed/expired), `get_handoff`, `claim_handoff` (returns one markdown block: prompt, `## Handoff
  summary`, `## Context`), `expire_handoff`, `search_prompts`, `get_prompt` (fills `{{vars}}`, lists `unfilled`),
  `save_prompt` (always staged). There is no per-token rate limit in Canopy today.
- Skills: `handoff`, `prompts`, and `load-context` (lists waiting handoffs at session start; never auto-claims).

## Artifacts — stored, versioned pages; direct writers, human ratify (spec: `docs/superpowers/specs/2026-09-24-artifacts-implementation.md`, issue #52)

An artifact is one self-contained page an agent or person produced (a design page, spec, report, diagram, image,
PDF, file), stored and versioned in Canopy and linked to the work it came from. Knowledge › **Artifacts** in the
SPA (`#artifacts`, `#artifacts/new`, `#artifacts/<slug>[/v<n>|@v<n>]`, `#artifacts/<slug>/diff/<a>..<b>` —
`web/src/artifacts.ts`, ported from the Claude Design `Canopy Artifacts.dc.html`, decoded copy in
`docs/superpowers/specs/artifacts-prototype/`), plus an Artifacts block on the ticket detail. The viewer's
**New version** dialog (`newVersionDialog`, over `POST /api/artifacts/:slug/versions`) edits the SHOWN version's
text (text kinds; from an older version that is a restore) or uploads a replacement file on the page's own side
(text / binary — `artAcceptNvFile` refuses the other), with the create form's size / claude.ai / flatten checks
(`contentChecks`); an unchanged save is the API's `unchanged` no-op. The contract for
agents is `docs/artifact-contract.md` (referenced by `AGENTS.md` and the `canopy` / `artifacts` skills).

- **Kinds and storage**: text kinds `html` / `markdown` / `svg` / `mermaid` (≤ 750 KB of UTF-8, the `content`
  column in D1) and binary kinds `image` (png/jpeg/gif/webp only) / `pdf` / `file` (≤ 10 MB, R2 bucket
  `ARTIFACTS_BUCKET` at `artifacts/<sha256>`, put with R2's own `sha256` check). `0030_artifacts`:
  `artifact_pages` / `artifact_versions` (exactly one of `content` / `r2_key`) / `artifact_links` /
  `artifact_upload_tokens` / `artifacts_fts` (kept in sync by the repository, not triggers; bm25 like docs).
  The vocabulary, caps, status rules and wire DTOs live ONCE in `shared/artifacts-core.ts` (zod-free — the SPA
  imports it); `shared/artifacts.ts` adds the zod request schemas. The repository is `src/tools/artifacts.ts`
  (`ArtifactError` codes → 404/403/400/409/413/410); every surface calls it, none re-implements a rule.
- **Rules**: create = v1 `draft`; draft ⇄ published by anyone who can READ the page; a later version →
  `published` and clears `ratified_*`; → draft clears `ratified_*`; an identical sha256 to the current version is
  a no-op (`unchanged`). Only the AUTHOR may set `private`; a private page is readable (and writable) only by its
  author; a binary page whose upload has not landed (`current_version = 0`) exists to NO reader. Those three and
  a missing slug are ONE byte-identical not-found on every surface (HTTP, raw, MCP, query, list) — pinned by
  `test/artifacts.security-access.test.ts`. Slugs are one namespace, so allocating `<slug>-2` does reveal that a
  hidden page with that title exists (never its content or author) — a known, accepted leak.
- **`published_at`** (0035, on both DTOs) is when the CURRENT published content went live: stamped on draft →
  published (PATCH or private → org) and by every later version (it auto-publishes), kept by a PATCH that leaves
  the page published, cleared to NULL on → draft, untouched by ratify; pre-0035 pages carry their current
  version's `created_at` (a v1 published by PATCH never recorded when, so that is a lower bound).
- **Delete is SOFT** (0035 PART D; `deletePage` / `restorePage` in `src/tools/artifacts.ts`):
  `POST /api/artifacts/:slug/delete` stamps `deleted_at` / `deleted_by` and drops the page's `artifacts_fts` row in
  ONE batch — every version, every `artifact_links` row and the R2 bytes stay, so restore is lossless. Only the
  page's AUTHOR (case-insensitive) or an ADMIN (`isAdmin`), and only on a page they can SEE (an admin gets the plain
  404 on someone's private page); anyone else is 403 with nothing written. `VISIBLE_SQL` carries `p.deleted_at IS
  NULL`, so a deleted page is the ONE byte-identical not-found on EVERY surface — library, detail, diff, raw, MCP
  `artifact_get` / `artifact_list` / `artifact_update` / `upload_asset` targeting it, `query` (its hydration repeats
  the rule), `/search`, `/search/quick`, a ticket's / sprint's artifacts, My Work's "published this week", a
  record_session `artifact_links` entry (`not_found`), a signed download minted BEFORE the delete (the re-check at
  download) and an upload token minted before it (the consume re-check) — for its own author too.
  `POST /api/artifacts/:slug/restore` (same people; for anyone else a deleted page stays the one 404; a LIVE page is
  409 `artifact is not deleted`) clears both columns and re-inserts the FTS row. **The slug stays RESERVED**:
  `uniqueSlug` counts every row, so a new page with the same title gets `<slug>-2` (there is no explicit-slug
  create to 409). Both routes are session-cookie only and refuse an `Authorization` header, like ratify — there is
  NO MCP delete. On screen: "Delete artifact" at the bottom of the viewer's `…` menu (author / admins only;
  `canDeleteArtifact`), the confirmation modal, then the library with "Deleted “<title>” · Undo" (Undo →
  `artRestore` → "Restored “<title>”"). There is no list of deleted artifacts.
- **The confirmation modal** (`web/src/confirm.ts` `confirmModal`, shared by the prompt and artifact deletes; never
  `window.confirm`): a root-level `data-overlay` (so morph keeps it, and its focus, across rerenders) — a dimmed
  backdrop whose click cancels, and a centered `.cnpy-surface` `role="alertdialog"` `aria-modal="true"` labelled by
  its title and described by its explanation, with Cancel and a red Delete. Delete is FOCUSED on open, so Enter /
  Space press it; ONE capture-phase keydown listener in `main.ts` drives every `[data-confirm-dialog]` through the
  pure `confirmKeyAction`: Enter elsewhere confirms (never on a key repeat), Escape cancels and focus returns to
  `[data-confirm-trigger]`, Tab is trapped; while the write runs the button reads "Deleting…", both buttons are
  disabled and `data-busy` swallows every key (the reducers' busy guards agree — one delete, ever). Fade/scale in,
  `data-closing` plays the exit (`confirmOut`), none under reduced motion; at ≤ 640px it is a bottom sheet (the
  modal/sheet rule names `role="alertdialog"` too) with safe-area padding.
- **Ratify is the human confirm gate**: `POST /api/artifacts/:slug/ratify {version}`, session cookie only, only
  the LATEST version of a `published` page, and it refuses any request carrying an `Authorization` header. There
  is NO MCP ratify tool.
- **HTTP** (`src/artifacts/routes.ts`, mounted at `/api/artifacts`, session cookie): list (filters area, kind,
  author, status, sprint, ticket, q), get `?v=`, create (JSON text / multipart binary), PATCH, add version
  (content or `old_str`/`new_str`, which must match exactly once; multipart for binary), links add/remove,
  diff, ratify, delete / restore (`POST /:slug/delete|restore`), `upload-url`, and `POST /api/artifacts/fetch` (the From-URL tab: `src/artifacts/fetch-url.ts`,
  https only, private/loopback/link-local literals refused, every redirect hop re-checked, 5 s, 750 KB, text
  only, nothing stored — a Worker cannot resolve DNS first, so rebinding is out of its reach).
- **Two token-authenticated routes sit in `src/index.ts` BEFORE the session-gated app** (like `/u/`): the upload
  `PUT /api/artifacts/upload/:token` (`src/artifacts/upload.ts`: single use, 5 minutes, bound to principal /
  page / kind / size / sha256; stored only as a hash; a length or hash mismatch leaves it retryable) and the
  agent download `GET /api/artifacts/download/:token` (`src/artifacts/download.ts`: stateless HMAC over
  {handle, page, version, exp} keyed from COOKIE_SECRET with its own purpose label, 5 minutes, reusable, the
  page's visibility RE-CHECKED at download, exact stored bytes as an attachment with `sandbox` CSP).
- **Raw route** `GET /raw/a/:slug[@v<n>|/v<n>]` (`src/artifacts/raw.ts`, session cookie) is what the SPA frames:
  html/svg get the active CSP (inline scripts + the two CDNs, `connect-src 'none'`) PLUS `sandbox allow-scripts`,
  so an artifact opened in its own tab still runs at an opaque origin; image/pdf/file get
  `default-src 'none'; frame-ancestors 'self'`; always nosniff, `X-Frame-Options: SAMEORIGIN`,
  `Cache-Control: private`; html alone gets the injected `canopy:height` postMessage script (never on
  `?download=1`). The SPA frames html as `<iframe src="/raw/…" sandbox="allow-scripts">` — never `srcdoc`, never
  `allow-same-origin` — and inlines svg ONLY through `sanitizeSvg` (DOMPurify, `web/src/markdown.ts`).
- **MCP** (every principal, `src/tools/artifacts-agent.ts`): `artifact_list`, `artifact_get` (text content inline
  up to `ARTIFACT_INLINE_MAX` = 64 KB — over it `content: null` + `content_omitted: true` unless
  `include_content: true`, and `query`'s assembled body is a one-line pointer instead; `warnings` still see
  the full text; for every kind a `download_url` + `sha256` + `size_bytes` to verify), `upload_asset` / `artifact_update`
  (text inline; binary returns an absolute `upload_url` the agent PUTs to). All carry `warnings` (never a
  rejection) for `window.claude` / `window.storage` / `api.anthropic.com`, and for a bundled Claude Design
  export (`isBundledExport` — its `blob:` scripts and `new Function` are refused by the raw CSP, so it must be
  flattened; the web create screen shows the same warning as FLATTEN FIRST). `query` has an `artifact` type
  (draft → `draft`, published/ratified → `live`; private only to the author — `query()` takes a viewer);
  `get_ticket` lists the ticket's visible artifacts; `record_session` and `/ingest` accept `artifact_links`,
  applied after the batch as direct writes (`recordBatch` in `src/consumer.ts`).
- **Skills**: `artifacts` (find / pull into `.canopy/artifacts/<slug>/v<n>.<ext>` and verify the sha256 / serve an
  html one locally / link / publish), plus `canopy`, `load-context` and `record-session`. `.canopy/` is gitignored.
  End-to-end check against a live `wrangler dev`: `scripts/e2e/artifacts-agent.mjs` (start dev with
  `--var PUBLIC_ORIGIN:<its URL>`, or the script refuses the production-origin upload/download URLs).
- **Deferred on purpose**: external share links, per-person sharing, a raw-content subdomain, PDF text extraction
  for search.

## Doc images — uploaded, content-addressed, gate-checked (spec: `docs/superpowers/specs/2026-09-24-doc-images-design.md`)

A doc embeds an image as `![alt](/img/<sha256>)`. `0031_doc_images`: one `doc_images` row per sha256 (png /
jpeg / gif / webp, ≤ 10 MB), bytes in R2 (`ARTIFACTS_BUCKET`) at `doc-images/<sha256>` — immutable, never
deleted, so a promoted version renders the same forever. The reference format and the body scan live ONCE
in `shared/doc-images.ts` (`scanDocImages`, zod-free); the repository is `src/tools/doc-images.ts`.

- **Upload is the artifact upload's twin, through ONE tool**: MCP `upload_asset` (was `artifact_create`)
  takes `destination: "artifact"` (default, unchanged) or `"doc"` → `{ ref, markdown, sha256, uploaded }`
  plus `upload_url` / `expires_at` when the bytes are not stored yet (`uploaded: true` = no PUT, no token).
  The PUT is the SAME route, `PUT /api/artifacts/upload/<token>`: `consumeDocImageToken` claims a
  `doc_image_upload_tokens` token (single use, 5 minutes, hash-only, bound to principal + sha + size + type)
  and returns `null` for any other token, which then goes to artifacts. R2's own sha256 check; a mismatch
  releases the claim for a retry.
- **The gate** (`docImageProblems`, first in `ingestDocProposal`) — see Core invariant. `/api/docs/propose`
  answers a refusal with 400; triage assign throws it.
- **Serving**: `GET /img/<sha>` on the session-gated app — `nosniff`, `default-src 'none'; sandbox`,
  `Cache-Control: private, max-age=31536000, immutable`; 404 unknown. Agents cannot read it with a bearer
  (deferred: a signed download like `artifact_get`'s).
- **Web**: `markdown.ts` `enhance()` wraps each `/img/` image in a `.cnpy-md-img` zoom button (`docImgZoom`
  → `web/src/lightbox.ts`, the lightbox the guide uses); Review's Rendered view (`renderedPreview`) shows a
  line's images outlined green (added) / red and dimmed (removed); unified and split diffs show the text.
- There is no web upload yet (agents only, by decision) and no garbage collection.

## Sidebar & motion — the `<aside>` outlives rerenders

`rerender()` swaps the app wholesale, which is fatal for a transition: a width, a rotating chevron or an
opening sub-page list can only animate on an element that SURVIVES the state change. So `web/src/morph.ts`
`paint()` patches the `<aside>` in place and swaps only `<main>` (the seam is `.cnpy-shell`). That only works
because **the sidebar's structure is stable** (`web/src/sidebar.ts`): every label, badge, dot, chevron and
sub-page list is ALWAYS emitted, and collapsed / open / active are attributes and classes that `canopy.css`
animates (`data-collapsed`, `.cnpy-sub[data-open]`, `.is-active`, `data-n="0"` hides a badge). Emitting a
node conditionally there swaps it out from under its own animation — `test/render.sidebar.test.ts` pins the
element tree across every state. `data-keep` marks a script-owned node (the collapsed-rail tooltip) the
patcher leaves alone. A sub-page list the app opened on entry folds again on leaving; one opened by hand
sticks and is what persists (`canopy.navOpen`). Below 900px the rail renders collapsed (`state.narrow`)
without touching the saved preference. Search is the box at the top of the rail (⌘K / Ctrl+K), not a nav row.

**Every pick-one switch is `segmented()`** (`web/src/segmented.ts`) — the Feed view, Roadmap tabs, the queue's
Board/Table and All/Open/Closed, Repo ranges and environments, an artifact's status, form segments. Never
hand-roll a segment group. Its picked fill is ONE indicator that slides between options: `rerender()` swaps
`<main>`, so `syncSegments` (run after every paint, and without a slide on resize / font load) remembers each
switch's indicator box by its stable `id` and plays the slide old → new (FLIP); a switch new to the screen
does not slide in. Sizes `md` (header) / `sm` / `xs`, plus `cnpy-seg--bar` (a 34px toolbar row) and
`cnpy-seg--wrap`. Two-state colored toggles (an artifact's visibility) and chip pickers are other idioms.

Screen entrances are `[data-enter]` (set by `markEnter()` in `main.ts` only when the route changed or the
screen's main read landed — never on a keystroke). `--enter-t` is a NEGATIVE animation-delay, so a rerender
mid-entrance joins the animation where the old DOM left off. Hooks: `.cnpy-rise` + `--i`, `.cnpy-stagger`
(lists), `.repo-bar` / `.repo-fill` / `.repo-spark`, `data-count` (count-up). In-place changes use the
one-shot `pendingFlash`. All of it is off under `prefers-reduced-motion`.

## Corners — tighter than the design file

Every radius renders at `--corner-scale` (`.4`) of its authored value: ONE block at the end of
`web/src/canopy.css` zeroes everything with `!important` (the radii are INLINE styles in the TS templates, and
only `!important` outranks those), then restores each radius the app uses at `calc(<its value> *
var(--corner-scale))` — canopy.css classes by name, inline styles by `[style*="border-radius:Npx"]` — and
circles/pills at `min(calc(12px * scale), 25%)`, so dots and avatars are small rounded squares. The authored
values stay as written (`1` restores them, `0` squares everything). So a NEW radius value or a new class with a
radius needs a line in that block, else it renders square; `test/render.corners.test.ts` fails until it has one.
A shape that only reads right as a CIRCLE (a halo ring, an overlapping avatar stack, a check in a bordered circle)
needs a hook class and a rule in that block (`.cnpy-av`, `.cnpy-avstack`, `.cnpy-seal`, `.repo-envdot`, …), and
a status dot must be an element, never a `●` character (`GDOT` in `repo.ts`).

## Email notifications — a read-side projection, never a writer (spec: `docs/superpowers/specs/2026-09-11-canopy-email.md`)

Digests are assembled from D1 and sent via Resend; the pipeline never writes to the store (only to its own
`notification_*` tables). Everything lives in `src/notifications/`:

- **Registry in code, not D1** (`registry.ts` + `shared/notifications.ts`): one `NotificationKind` per digest
  section — `my_work` (event spine: merged PRs in the window + open assigned issues, summarized exactly as My
  Work does), `review_queue` (open Proposals + draft Decisions), `roadmap_plan` (diffs `plan_versions` in the
  window against the last pre-window version; progress rows never surface), `ticketq` (the ticket queue, not
  window-scoped: `submitted` tickets with no assignees org-wide + the recipient's own open assigned tickets via
  `listAssignedTickets`, the same read My Work uses). A renderer is a **pure read**
  (`render(db, login, window)` → `Section | null`; null = nothing to say, dropped). Adding a kind = one entry +
  one renderer; `notification_policy` is seeded from the registry per isolate (`policy.ts`, INSERT OR IGNORE,
  never overwrites).
- **Cadences are `daily` / `weekly` / `off` — there is NO immediate tier.** Resolution (`resolve.ts`): user pref
  → policy `default_cadence` → registry default; `policy.enabled = 0` short-circuits to `off` before the user
  layer. A pref must be in the kind's `allowedCadences` (validated at write time).
- **Runs** (`run.ts`): per eligible user (address on file, `email_unsubscribed = 0`) the outbox row is claimed
  FIRST by `INSERT OR IGNORE` on `user:cadence:window_id` — a conflict skips the user, so a double fire is
  harmless. Then render, drop nulls, `skipped` on zero sections, else one message → `sent` (with `resend_id`)
  or `failed` (with the error). `retry.ts` re-attempts `failed` rows only. Windows (`window.ts`) are computed
  in the org timezone: daily = previous 24h (72h on Monday), weekly = previous 7 days.
- **Cron** (`cron.ts`, `wrangler.toml [triggers]`): two hourly triggers (`0 * * * *` daily candidate,
  `0 * * * SUN,MON` weekly candidate) dispatched by expression in `scheduled()`, gated in code on
  `notification_settings.send_hour` + `timezone` at fire time (static crons cannot read D1 or follow DST).
- **Delivery gate** (`resend.ts`): `NOTIFICATIONS_MODE` absent/`local` → bodies go to the dev-only
  `notification_outbox_bodies` table and Resend is NEVER called; `resend` requires `RESEND_API_KEY` (a config
  error otherwise, never a silent fallback). Headers: `List-Unsubscribe` (mailto + https) and
  `List-Unsubscribe-Post: List-Unsubscribe=One-Click`.
- **Unsubscribe** (`unsubscribe.ts`): `/u/<login.sig>` (HMAC over the login with `COOKIE_SECRET`) is the
  single signed-token exception — handled in `src/index.ts` outside `sessionGate`; POST can ONLY set
  `email_unsubscribed = 1`; GET redirects to the cookie-gated `#unsubscribe` screen. Prefs survive unsubscribe.
- **HTTP** (`routes.ts`, mounted at `/api/notifications`, session-cookie only, NEVER MCP): `prefs` (GET/PUT,
  own row only), admin-only `policy`, `settings`, `outbox`, `persons/:handle`.
- **Address**: seeded at first sign-in, per provider — GitHub from `GET /user/emails` (primary +
  verified; scope `user:email`), Google from the verified `email` claim on the ID token (unverified
  emails are denied before the fork) — both through `recordSignIn`'s `COALESCE(email, …)` write, which
  never overwrites a user/admin-edited value.
- **Invite email** (`src/notifications/invite.ts`): one transactional message per invite/resend through
  `deliveryFor`; not a kind — no cadence, prefs, or window. Outcome lands on `invites.email_*`. No
  `List-Unsubscribe` headers (they are optional on `OutboundMessage` now, omitted for invites).
- **Welcome email** (`src/notifications/welcome.ts`): the second transactional message — sent from
  `POST /auth/onboard` once the person row and session exist, linking Get Started (`/#guide`, where a
  fresh sign-in lands). Also not a kind. It fires THERE and not when someone joins the GitHub org
  because the address comes from the person's OWN OAuth token (`getPrimaryEmail`), which does not
  exist until they sign in — nothing Canopy holds can reach a new org member before that. No outcome
  column and the result is ignored at the call site: `sendWelcome` never throws, and a mailer problem
  must never cost somebody their sign-up. No address from the provider = no mail.
- **Deferred:** the digest's ledger layout (`EMAIL_CARD.item`) has no avatar chips today, so a person's
  color does not appear in email yet. When a chip is added there, take the color from `persons.color`
  via the light hex set documented in §7 of the identity design doc.
- Tests assert on outbox/bodies rows, never mocks (`test/notifications.*.test.ts`, `test/render.notifications.test.ts`).

## Conventions & gotchas

- `shared/vocabulary.ts` MUST match `migrations/0002_seed_vocab.sql` — it's the gate's source of truth.
- D1 helpers live in `src/db.ts` (`first` / `all` / `run` / `nowIso`); writers in `src/tools/writes.ts`.
- Tests use real Miniflare D1; `test/apply-migrations.ts` truncates data tables `beforeEach` via
  `scripts/seed/reset.mjs` (add new tables — `events`, `repo_events`, `repo_snapshots`, `repo_metrics`,
  `pr_summaries`, `sprints`, `sprint_progress`,
  `sprint_resources`, `tickets` + `ticket_*`, `persons`, `identities`, `invites`, `plan`,
  `plan_versions`, `notification_*`, `oauth_*` — there). That file is also the canonical person seed: the four
  engineers (github identities) plus two Google-only non-engineers, `meilin` / `sanaok`.
  GitHub I/O and the PR summarizer are dependency-injected (`fetchImpl?: typeof fetch`, `summarizer`)
  because the vitest pool exports no fetch/AI mock — stub at the `Response`/`Summarizer` level, never hit
  the network in tests.
- The vitest pool loads your local `.dev.vars` through the wrangler config, so `vitest.config.ts` BLANKS every
  secret that would make a test resolve a real network client (`GEMINI_API_KEY`, `GITHUB_SERVICE_TOKEN`,
  `RESEND_API_KEY`, `CF_ANALYTICS_TOKEN`, `CF_ANALYTICS_ACCOUNT_ID`, `RAILWAY_TOKEN_STAGING` /
  `_PRODUCTION`, `SAPLING_METRICS_TOKEN`) — a test that needs one passes its own value in a per-test env
  object, and the suite is fully green with no carve-out.
- **Deferred seams — do NOT activate:** Cloudflare Queue, Vectorize.
  They exist as `// SEAM:` comments only.

## Env / bindings

Secrets (`wrangler secret put …`; local: `.dev.vars`): `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`,
`GOOGLE_CLIENT_ID` (Google OAuth client id for the second session-class provider — absent →
`/auth/google/login` itself returns 503), `GOOGLE_CLIENT_SECRET` (absent → the login redirect still
happens, but the code exchange fails and `/auth/google/callback` 401s `exchange_failed`), `COOKIE_SECRET`,
`GITHUB_WEBHOOK_SECRET` (HMAC for the webhook — absent → the surface 401s), `GITHUB_SERVICE_TOKEN`
(app-level token for the sprint-progress backstop, for `reconcileRepo` — from Sync GitHub AND the repo cron
— and for the webhook's two follow-up reads, `fillFailedJob` and `refreshDrift`; absent → Sync GitHub 503s,
the cron's 6-hourly `:10` and `:20` ticks and those follow-ups are skipped, while the `:30` prune and the
health pings run regardless), `GEMINI_API_KEY`
(Google Gemini key for capture-time PR/issue summaries — absent → the excerpt fallback), `RESEND_API_KEY`
(email delivery; needed only when `NOTIFICATIONS_MODE = "resend"`).

The repo cron's three hourly pollers each have their own secret(s). Each poller is skipped when its secret
is absent — its section then stays `not_connected` — and none of these values may ever be logged:
- `CF_ANALYTICS_TOKEN` (a Cloudflare API token with Account Analytics: Read) + `CF_ANALYTICS_ACCOUNT_ID` (the
  account the frontend Workers live under). Absent EITHER → `pollCloudflare` is not called, and the Usage
  tab's requests / error rate and the Cloudflare panel stay `not_connected`. The account id is a SECRET,
  deliberately NOT a `[vars]` entry: it was created as a secret, and a var and a secret sharing a binding
  name collide and fail the deploy. Neither is named `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`,
  because those are the names the wrangler CLI itself authenticates with.
- `RAILWAY_TOKEN_STAGING` / `RAILWAY_TOKEN_PRODUCTION` — Railway PROJECT tokens, ONE PER ENVIRONMENT, named
  `RAILWAY_TOKEN_<environment key, upper-cased, non-alphanumerics → _>` and sent as `Project-Access-Token`.
  Absent one → `pollRailway` skips THAT environment; absent both → it is not called and `hosting` stays
  `not_connected`. **These tokens are NOT read-only** — Railway has no read-only scope; one environment of
  one project is the narrowest it offers. A third environment needs its secret plus a line in `src/env.ts`
  (and `test/env.d.ts`) for the type.
- `SAPLING_METRICS_TOKEN` — the bearer token Sapling's `GET {apiUrl}/api/internal/metrics` expects (the same
  value on both sides; ONE token for every environment, so staging and production Sapling must accept the
  same one — a stated limitation of the contract doc). Absent or empty → `pollSaplingMetrics` is not called
  and the Usage tab's Active users stays "not connected". Never sent to a non-https URL or across a redirect.

Vars (`[vars]` in `wrangler.toml`): `GITHUB_REPO` (e.g. `SaplingLearn/sapling`), `ADMIN_LOGINS`,
`PUBLIC_ORIGIN` (absolute origin for links inside email), `NOTIFICATIONS_MODE` (`local` default / `resend`),
and `REPO_ENVIRONMENTS` — a JSON list parsed by `repoEnvironments()` (`src/repo/config.ts`): per environment
`key`, `label`, `note`, `branch`, `railwayEnv` (the GitHub deployment environment name), `worker` +
`workerCheck` (the Cloudflare script and its Workers Builds check name), `frontendUrl`, `apiUrl`,
`healthPath`, and — optional — `railwayEnvironmentId` / `railwayServiceId` (ids, not secrets; the service id
is the same in both environments). An entry missing a required string is dropped; absent or malformed →
`[]`. Today it encodes two: **staging** deploys from `main`, **production** from a `production` branch;
backend on Railway, frontend on Cloudflare Workers. **Order matters**: entry `[0]` is the drift HEAD and the
branch a `canopy/*` status must be on; the LAST entry is the drift base. It is read by the webhook's repo
capture (matching a `deployment_status` / `check_run` to its environment, the status branch filter, which
pushes refresh drift), the projection (`getRepoDashboard`'s `envs`), `reconcileRepo` (the environment NAMES
the deployments query filters on; the BRANCHES whose head, head checks and drift it reads) and all four
pollers (`pingHealth`: `frontendUrl`, `apiUrl + healthPath`; `pollCloudflare`: `worker`; `pollRailway`: the
two Railway ids; `pollSaplingMetrics`: `apiUrl`). Absent → no deployments / env-head / head-checks arms, no
drift (it needs two environments), no pings and no polls, and `environments` / `deploys` / `health` /
`usage` / `cloudflare` / `hosting` stay `not_connected` — but the **branches arm still runs**
(`computeBranches` degrades correctly with `envs: []`), and `ciFailures` never consults it.

Bindings: `DB` (D1), `ASSETS` (static), `ARTIFACTS_BUCKET` (R2, bucket `canopy-artifacts` — binary artifact
bodies at `artifacts/<sha256>`; **the bucket must exist before the first deploy that carries this binding**:
`wrangler r2 bucket create canopy-artifacts`). Capture-time summaries call Gemini over REST (`GEMINI_API_KEY`),
never at render — not a Cloudflare binding, so there is no `[ai]` block. `[triggers] crons` is three
expressions: `*/10 * * * *` is the repo cron — its per-tick schedule and subrequest arithmetic are described
ONCE, under "The repo cron" in the Repo dashboard section — plus the two hourly digest candidates (see Email
notifications). `REPO_CRON` and the expression in `wrangler.toml` must stay identical (pinned by a test),
and a change to this list needs `wrangler triggers deploy` after the merge (see "Owner prerequisites").

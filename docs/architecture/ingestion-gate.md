# The ingestion gate and the staged-write model

<!-- Moved verbatim out of CLAUDE.md (2026-10-07). This is the detailed reference; CLAUDE.md keeps only what applies to every change. Keep it current when you change the area. A reference to another section ("see Core invariant", "the Repo dashboard section below") now means another file in this folder — see the table at the bottom of CLAUDE.md. -->

## Core invariant — ingested content is gated; authored & computed writes are direct

`consume()` is an **ingestion** gate, not a universal write gate: it polices agent-proposed content
(vocab, confidence, content-hash dedupe, reconciliation). Every ingested entry funnels through the
per-type **gate** functions in `src/consumer.ts` (`ingestFeedEntry` / `ingestDocProposal` /
`ingestAdrDraft` / `ingestEvent` / `ingestRepoEvent`). The ingestion entry points are thin
adapters over these: `/ingest` and the MCP `record_session` batch tool (both via `consume`), the
per-entry MCP write tools (`append_feed`, `propose_doc_update`), and the GitHub webhooks (`/webhook/github/:hookId`,
the App's `/webhook/github/app` and the legacy `/webhook/github` — all through `captureDelivery`), which
call `ingestEvent` (into `events`, for My Work) AND, independently, `ingestRepoEvent` (into `repo_events`,
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
- Out-of-vocab **section** → routed to `needs_triage` (nothing is guessed). Sections are fixed
  (`shared/vocabulary.ts` `SECTIONS`).
- **Feed tags are the ORGANIZATION's own list** (`0056_org_tags`; `feed-and-search.md` › Tags), read inside
  `ingestFeedEntry` through `sortAgentTags` (`src/tools/tags.ts`) — never a constant. An agent's tag is
  normalized (`normalizeTagName`: case, spaces, underscores) and sorted: **on the list and live** → written
  to `entry_tags` (a name merged into another reads as that one); **well-formed but not on the list, or
  retired** → the entry is STILL WRITTEN, without it, and the tag is recorded as a suggestion
  (`recordTagSuggestions` → `org_tag_suggestions`: the item, the tag, who sent it) for an admin to accept,
  map or dismiss; **not a tag at all** → dropped. An unknown tag therefore never sends a feed entry to
  `needs_triage` (it did until 0056 — a deliberate change: one odd word was holding whole entries back). The
  result says what happened: `{ outcome: "written", id, tags, suggested_tags?, ignored_tags? }`, and a batch
  lists `suggested_tags` (only when non-empty, like `refused`). **Nothing an agent sends adds a tag to the
  list** — only an admin does, over a cookie route. The ledger is checked first, so a replay records no
  second suggestion; `shared/vocabulary.ts` `TAGS` and `0002_seed_vocab.sql` still agree, but they now name
  the STARTER tags every org begins with, not the gate's vocabulary.
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
  **The ONE exception: what Trov writes itself.** A session digest (the AI pass's `digest.session` job,
  `src/ai/digests.ts`; `ai.md` › Session digests) goes through `ingestFeedEntry` like any entry, authored by the
  reserved system person `trov` (`TROV_SYSTEM_HANDLE`, its `persons` row from 0061 — never a member, never
  listed, never deletable or renamable) with its provenance `ai = { model, subject }` → `feed.origin = 'ai'`,
  `feed.model`, `feed.subject` (the member it is for; in `HANDLE_COLUMNS`). The author and the provenance go
  TOGETHER or not at all — `ingestFeedEntry` throws on `trov` without `ai`, or `ai` with any other author — and
  only the pass's job passes `ai` (no route, no MCP tool can: `/ingest` and `record_session` never do), so no
  principal can write as Trov and no person's entry can be marked as Trov's. Its ledger key is the burst
  (`ai:session:<repo>:<login>:<started_at>`, item 0), so a retried write replays instead of doubling; a tag of
  Trov's entry that is not on the org's list is DROPPED (never recorded as a suggestion for the admins); and the
  router marks `person:<subject>`, not `person:trov`. Phase D's doc-drift proposals (0065) will be the same
  exception through `ingestDocProposal`.
- **Repo capture is a SECOND, sibling gate to `ingestEvent`** — same reconciliation (a UNIQUE `semantic_key`
  written `INSERT OR IGNORE`, so a redelivery or a backfill overlap drops as `unchanged`) but deliberately
  NOT the `events` table: `ingestEvent` raises an `identity_tasks` row per unmapped `subject_login`, which is
  wrong for bots and high-volume CI telemetry (pushes, checks, runs). `ingestRepoEvent` carries no
  vocab/confidence and does no identity intake or summarization; it is reached only from the HMAC-verified
  webhook and from `reconcileRepo` (`src/repo/github.ts`, GitHub reads with the ORG's credential from
  `resolveGithubCredential` — run by an admin's Sync GitHub and Poll now and by the repo cron, never on the
  render path) — never through `/ingest` or `record_session`.
  `src/webhook.ts`'s `WORK_EVENT_NAMES` (`pull_request` / `issues`) and `REPO_EVENT_NAMES` (`pull_request` /
  `push` / `pull_request_review` / `check_run` / `workflow_run` / `status` / `deployment_status` / `deployment` —
  the last two, and a non-`canopy/*` status, as untagged GitHub deploy signals through `ingestRepoEvent`)
  independently gate which deliveries feed which capture; a repo-capture failure is caught and logged, never
  costing the My Work capture, and the webhook's response body carries `repo: { captured, unchanged }`
  alongside the existing `captured` / `unchanged`. PR-close and issue capture into `events` is unchanged by
  any of this. A NEWLY captured deploy signal, check run or workflow run is then offered to
  `writeGithubDeploys` (`src/hosting/github-deploys.ts`), which may write a `github` part's `hosting_deploys` row —
  a computed, direct write from a row the gate already stored, only through the part's own setting, never a second
  ingestion surface (`repo-apps.md` › The `github` provider). Reconcile and a `github` part's write replay the
  already-stored signals of 30 days through the same matcher (`backfillGithubDeploys`) — still computed from gated
  rows, no new surface.
- **Releases are the repo capture's THIRD arm, `ingestRepoRelease`** (Repo setups, Phase F): the `release` /
  `create` deliveries (`RELEASE_EVENT_NAMES`) and reconcile's `releases` arm put each release or tag through it —
  never `/ingest`. A release CHANGES (edited, deleted), so it is not an append-only `repo_events` row: its
  identity is `(org, repo, tag)` and its dedupe is the gate's content hash over the settled row (a redelivery,
  a no-op edit or a re-read writes nothing); the write itself is `releases` (`src/repo/release-store.ts`).
  A draft is never captured, a tag never downgrades a release, and a row without GitHub's own date is not
  written. **`repo_metrics` points and `repo_snapshots` are computed writes, not gated ingestion**: the
  `status` delivery's `metricsFromStatus` arm, the cron's pollers and reconcile's snapshots write them direct
  through `putMetric` / `putSnapshot` (`src/repo/store.ts`) — each validates its own input, and `putMetric`
  is first-write-wins.
- **Which files a commit and a pull request touched are the repo capture's FOURTH and FIFTH arms** (Repo setups,
  Phase E — `0073_commit_paths`): `ingestCommitPaths` (a `push` delivery's own lists, and the ONE compare that fills in a
  head commit the delivery cut short — `src/repo/commit-paths.ts`; identity (repo, sha, path), INSERT OR IGNORE, a row's
  `scope` saying whether it is the commit's own or its push's) and `ingestPrFiles` (`GET /pulls/{n}/files` from the
  `pull_request` webhook and reconcile's `pr_files` arm — identity (repo, number), content-hash dedupe over the sorted
  list: the same list read again only records the head it was read for; a new one replaces the PR's rows whole). From
  the HMAC-verified webhook and reconcile only — never `/ingest`.

Authored and computed writes are **direct, in the `promote` class** — NOT the ingestion gate — exactly
like `promote_doc` / `ratify_adr` / `complete_sprint` always have been: the plan write
(`update_plan` → `write_plan`, versioned non-destructively) and the computed writes (the progress cache in
`tools/progress.ts`, the PR summaries in `tools/summarize.ts`). When adding an **ingestion** path
(agent-proposed content), add it to the gate — never a second ingestion surface; authored/computed writes
stay direct in the promote class.

## Staged-write model — agents stage, humans confirm

Agents only ever stage; humans confirm via **authenticated HTTP routes that are NEVER MCP tools**:

- Docs: `propose_doc_update` stages a `doc_versions` row (status `staged`); `POST /doc/:slug/promote`
  copies it into the live doc and bumps `current_version` (non-destructive; prior versions remain).
  Reject (soft): `POST /doc/:slug/reject` flips a staged version to `status='rejected'`; the row
  and body remain (non-destructive). Idempotent.
- ADRs: an ADR draft arrives in a batch — `adr_drafts` of MCP `record_session` or of `POST /ingest` — and
  the gate's `ingestAdrDraft` stages it as a `draft` through the writer `stage_adr` (`src/tools/writes.ts`;
  a function, NOT an MCP tool — there is no per-entry ADR tool). `POST /adr/:id/ratify` flips it to `ratified`.
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
  with `assigned_ref`). Placing an item as a feed entry: tags the PERSON picks must be live on the org's
  list (400 otherwise); with none picked, the item's own tags go to the gate as they came — an item held
  before 0056 for an unknown tag is placed with the tags it may have, the other becoming a suggestion. All triage exits are soft — nothing is hard-deleted; `resolved=1` + audit columns
  (`resolved_at`, `resolved_by`, `resolution`, `assigned_ref`) record how each item left the queue.
- `GET /proposals` — server-joined queue of staged doc versions newer than the live doc (both bodies +
  reconciler metadata: `change_kind`, `low_confidence`, `base_version`). The web triage UI reads this
  instead of per-doc N+1 fetches. These are session-cookie HTTP routes, NEVER MCP tools.
- **Trov's suggestions on Unplaced and Review** (Phase C, `ai.md` › The kinds) — information, never a gate decision.
  With the org's AI on, an Unplaced item that is a doc (a slug and a body) gets ONE Jev request: which section
  (the vocabulary's, less `needs-triage`) or "next to" which of the top three live docs (counted as that doc's
  section). `GET /needs-triage` carries the open one as the row's `ai?`; **Accept files the item exactly as
  "File it" does** — `assign_triage` as a `doc` in that section, through the SAME gate, as the person who pressed
  it. A doc proposal or drafted ADR waiting in Review gets ONE request: does it change a decision, contradict a doc,
  change a process, or is it routine. `GET /proposals` / `GET /adrs` carry a non-routine risk as `ai?`, drawn as a
  quiet line on the card with Dismiss only: **a risk never promotes, rejects or ratifies anything** (no Accept
  handler). Both are open suggestions only, only while the switch is on, cookie reads only.

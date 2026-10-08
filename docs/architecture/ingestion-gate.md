# The ingestion gate and the staged-write model

<!-- Moved verbatim out of CLAUDE.md (2026-10-07). This is the detailed reference; CLAUDE.md keeps only what applies to every change. Keep it current when you change the area. A reference to another section ("see Core invariant", "the Repo dashboard section below") now means another file in this folder — see the table at the bottom of CLAUDE.md. -->

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

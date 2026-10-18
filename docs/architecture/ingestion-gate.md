# The ingestion gate and the staged-write model

<!-- Moved verbatim out of CLAUDE.md (2026-10-07). This is the detailed reference; CLAUDE.md keeps only what applies to every change. Keep it current when you change the area. A reference to another section ("see Core invariant", "the Repo dashboard section below") now means another file in this folder — see the table at the bottom of CLAUDE.md. -->

## Core invariant — ingested content is gated; authored & computed writes are direct

`consume()` is an **ingestion** gate, not a universal write gate: it polices agent-proposed content
(vocab, confidence, content-hash dedupe, reconciliation). Every ingested entry funnels through the
per-type **gate** functions in `src/consumer.ts` (`ingestFeedEntry` / `ingestDocProposal` /
`ingestAdrDraft` / `ingestEvent` / `ingestRepoEvent`). The ingestion entry points are thin
adapters over these: `/ingest` and the MCP `record_session` batch tool (both via `consume`), the
per-entry MCP write tools (`append_feed`, `propose_doc_update`), a person's Markdown import (`POST /imports/:id/pages`,
`src/imports/runs.ts` — every page into `ingestDocProposal`; see below), and the GitHub webhooks (`/webhook/github/:hookId`,
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
- **Refuse or stage — nothing an agent sends lands in Unplaced** (owner ruling, 2026-10-18). A doc proposal the gate
  cannot place is REFUSED (`{ outcome: "refused", slug, code, reason }`, `DocRefusal`): nothing is written, nothing is
  ledgered (so the corrected re-send — same session id and index — stages instead of replaying), and the reason lists
  what IS valid, so the agent fixes it in the same session. The codes: `image` (below), `section`, `space`,
  `archived_page`. A batch (`/ingest`, `record_session`) lists them under `refused` — `{ slug, reason, code }`, present
  only when non-empty — and its `docs` / `adrs` counts are `{ staged, unchanged }` only (their `triaged` went with
  this ruling; `feed.triaged` stays, always 0, as it has been since 0056).
- **Low confidence stages and is flagged.** A low-confidence doc proposal stages with `low_confidence = 1`, a NEW slug
  as well as an existing one (a new one went to triage until 2026-10-18); Review shows the "Low confidence" mark. A
  low-confidence ADR draft stages as a `draft` like any other, its stored `adrs.confidence = 'low'` being the flag
  Review shows (`triage-map.ts` `adrReviewItem`; no migration — the column was there).
- Out-of-vocab **section** → refused (`code: "section"`, the reason lists `reference, context, decisions`; nothing is
  guessed). Sections are fixed (`shared/vocabulary.ts` `SECTIONS`; `needs-triage` is Unplaced's own and never offered,
  though the gate does not refuse it).
- **A batch's own `needs_triage` items** are still accepted, written straight to the queue, ledger-guarded — for
  COMPATIBILITY: the record-session skill stopped sending them in plugin 0.11 (an unsure thing is a low-confidence
  proposal, or left out and told to the person), but an installed older plugin still sends them, and refusing them
  would lose what it was unsure of. They are the only way an item reaches Unplaced now.
- **A doc's space is one of the ORGANIZATION's Library spaces** (`0081_docs_library`; `docs-library.md`). The
  proposal's `space` resolves through `shared/docs-core.ts` `SPACE_ALIASES` (`technical` → `engineering`), then
  `src/tools/spaces.ts` `spaceState`: a space that was SENT must be live — **unknown or archived → refused**
  (`code: "space"`; `unknown space "<slug>": use one of this organization's spaces: <the live slugs>` / `the space
  "<slug>" is archived: …`), never guessed. With no space, a NEW doc goes to `engineering` only while that space is
  live (else refused, `no space given, and the default space (engineering) is archived|missing: …`); an existing doc
  keeps its own space either way — a proposal never moves a doc, and an edit of a page in an archived space still
  stages. Unplaced › assign passes the space the person picked (any live one) back through this same check — a
  refusal there is a 400 with the gate's reason and the item stays unresolved. A person's `POST /docs/propose`
  refuses an unknown or archived space with a 400 in its own words before the gate.
- **An archived page takes nothing from a proposal** (`0083_doc_archive`; `docs-library.md` › Archiving a page).
  When the slug is an ARCHIVED page of the org, the proposal is refused (`code: "archived_page"`; the reason says a
  person restores it in the Library and a new page needs another slug) — checked right after the section, before the
  space — so no agent path (`propose_doc_update`, `record_session`, `/ingest`, Ask's mirror, an import, Unplaced ›
  assign) adds a version to it, restores it, or takes its slug (a slug stays reserved: a "new" page with that slug is
  refused too, and a person's `POST /docs/propose` refuses it 409).
  Only a person archives and restores, over the cookie routes; there is no MCP tool for either. An archived page is
  also no PARENT: `checkParent` and the promote's parent read only the pages in the Library, so a parent that is
  archived is ignored (`not_found`).
- **A doc's place in its space's page tree** (`docs-library.md` › The page tree). A proposal may carry
  `parent_slug` (contract `DocProposal`, MCP `propose_doc_update`, Ask's mirror, a person's `/docs/propose`):
  `src/tools/doc-tree.ts` `checkParent` runs the tree's rules (`shared/docs-tree-core.ts` `planMove` "into", in the
  page's OWN space). A valid parent is taken by a **new** doc's row at insert (it is unpromoted, so it shows "Not yet
  approved" under its parent; its rank is the plan's unless the siblings needed a renumber — the gate never writes
  another page's row) and recorded on every version (`doc_versions.parent_slug`); an **existing** doc moves under it
  only when that version is promoted, and only if it is still a valid place then (else the tree is left as it is).
  An invalid parent (missing, another space, the page itself, under it, too deep) is **ignored** — the page stages
  anyway and the result carries `parent_ignored: { parent_slug, reason }`. It is never a reason to refuse.
- **Server-only options.** `ingestDocProposal(ctx, proposal, author, ledger?, opts?)`: `opts` is
  `{ importId?, importPath? }` (`DocIngestOptions`), written to `doc_versions.import_id` / `import_path` — the
  Markdown import run a version came from and the file's path in it. It is NOT part of the contract: no agent or
  person can set it (a proposal's own `import_id` field is dropped by the schema). Only the import routes pass it.
- **A Markdown import is an ingestion path INTO this gate, never a second surface** (`docs-library.md` › Import).
  `POST /imports/:id/pages` (cookie only — a person's import, recorded as that person) re-validates each page
  against the run's server-side plan, prepares its body (the shared `prepareBody`: the first heading out as the
  title, relative links → `[[slug]]`, images → the run's uploaded `/img/<sha256>`), then calls
  `ingestDocProposal` with `confidence: "high"`, section `reference`, the run's space, the planned `parent_slug`,
  the ledger `{ sessionId: "import:<run id>", itemIndex: <the page's index in the plan> }` — so a retried batch is
  dropped by the replay ledger like any re-POST — and the server-only `{ importId, importPath }`. Every check above
  applies unchanged: an archived space or an archived page's slug is refused (the page fails `space_gone` /
  `archived_page` in the run's results), an identical body is `unchanged`, an image that is not one of the org's is
  refused (`refused`; the import drops an image it could not upload to its alt text first, so that is rare). Every
  page STAGES; nothing an import sends is live until a person approves it (one by one, or the import's "Approve
  all" in Review, which runs `promote_doc` per page).
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
  `refused` (`code: "image"`) — checked first, nothing staged, NOT ledgered (so a resend after the upload
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
  copies it into the live doc and bumps `current_version` (non-destructive; prior versions remain). The promote is
  ONE batch: the version's status, its open risk superseded, the live body, the page's `doc_links` rebuilt from that
  body (`[[slug]]` links, `shared/docs-links-core.ts`), and the version's requested parent applied when still valid.
  Reject (soft): `POST /doc/:slug/reject` flips a staged version to `status='rejected'`; the row
  and body remain (non-destructive). Idempotent. A version of an ARCHIVED page is refused 409 `archived` by promote
  (`DocArchivedError`): its staged versions stay `staged`, HIDDEN from Review and the badge (every Review read joins
  `d.archived_at IS NULL`), and come back when the page is restored — hiding, not rejecting, because they were made
  before the archive (the gate refuses any new one), and Restore must give back what was waiting.
- Archive page / Restore (`0083_doc_archive`): `POST /doc/:slug/archive` and `POST /doc/:slug/restore`, cookie only
  (`cookieOnly` with promote / reject), an org admin or an owner of the page's space — never an MCP tool
  (`docs-library.md` › Archiving a page).
- Doc drift (#161, `src/ai/doc-drift.ts`; `ai.md` › Doc drift): when Trov finds a doc that recent feed entries show
  is out of date, its edit is a doc proposal THROUGH THIS GATE — `ingestDocProposal` with `confidence: "low"`, so it
  is staged and flagged like any low-confidence edit of an existing doc — authored by the reserved system person
  `trov` (`TROV_SYSTEM_HANDLE`): the one documented exception to "the author is the authenticated principal",
  because no person wrote it. Only a person promotes or rejects it in Review; Trov never does.
- ADRs: an ADR draft arrives in a batch — `adr_drafts` of MCP `record_session` or of `POST /ingest` — and
  the gate's `ingestAdrDraft` stages it as a `draft` through the writer `stage_adr` (`src/tools/writes.ts`;
  a function, NOT an MCP tool — there is no per-entry ADR tool). `POST /adr/:id/ratify` flips it to `ratified`.
  Reject (soft): `POST /adr/:id/reject` flips a draft to `status='rejected'`; the row remains. Ratifying or rejecting
  a draft — and promoting or rejecting a doc proposal — closes Trov's open risk on it in the same batch (superseded;
  owner ruling Q37, `ai.md` › The kinds).
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
- Triage write-back: `POST /needs-triage/:id/discard` (soft dismiss), `POST /needs-triage/:id/restore` (undoes a
  discard — Unplaced's Undo toast: back to unresolved with the audit columns cleared; only a `discarded` item, an
  assigned one is 409) and `POST /needs-triage/:id/assign` (re-runs the item's `raw` through the SAME gate for the
  target type, then records `resolution='assigned'` with `assigned_ref`; a refusal is a 400 with the gate's reason and
  resolves nothing). Placing an item as a feed entry: tags the PERSON picks must be live on the org's
  list (400 otherwise); with none picked, the item's own tags go to the gate as they came — an item held
  before 0056 for an unknown tag is placed with the tags it may have, the other becoming a suggestion. All triage exits are soft — nothing is hard-deleted; `resolved=1` + audit columns
  (`resolved_at`, `resolved_by`, `resolution`, `assigned_ref`) record how each item left the queue.
- `GET /proposals` — server-joined queue of staged doc versions newer than the live doc (both bodies +
  reconciler metadata: `change_kind`, `low_confidence`, `base_version`). The web triage UI reads this
  instead of per-doc N+1 fetches. These are session-cookie HTTP routes, NEVER MCP tools.
- **Trov's suggestions on Unplaced and Review** (Phase C, `ai.md` › The kinds) — information, never a gate decision.
  With the org's AI on, an Unplaced item that is a doc (a slug and a body) gets ONE Jev request: which section
  (the vocabulary's, less `needs-triage`) or "next to" which of the top three live docs (counted as that doc's
  section). `GET /needs-triage` carries the open one as the row's `ai?`; **Accept places the item exactly as
  Place does** (its card then leaves by the queue's row exit) — `assign_triage` as a `doc` in that section, through the SAME gate, as the person who pressed
  it. A doc proposal or drafted ADR waiting in Review gets ONE request: does it change a decision, contradict a doc,
  change a process, or is it routine. `GET /proposals` / `GET /adrs` carry a non-routine risk as `ai?`, drawn as a
  quiet line on the card with Dismiss only: **a risk never promotes, rejects or ratifies anything** (no Accept
  handler). Both are open suggestions only, only while the switch is on, cookie reads only.

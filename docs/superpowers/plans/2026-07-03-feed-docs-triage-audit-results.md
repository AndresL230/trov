# Feed / Docs / Triage — state-of-play audit (results)

Audit spec: `canopy-audit-feed-docs-triage.md`. Posture: behavioral, file:line + command evidence.
No code changes. Companion Canopy docs consulted (all `live`): `feed`, `docs-and-versioning`,
`triage`, `the-gate`, `data-model`.

---

## 1. Feed — current state, single-writer proof, deltas

### Current state

One table, append-only, no edits or deletes anywhere in the worker:

- Schema: `feed (id, author, summary, body, artifacts, created_at)` — `migrations/0001_init.sql:26-33`;
  tags live in `entry_tags` keyed `('feed', id)` — `0001_init.sql:45-50`.
- The one writer: `append_feed` (`src/tools/writes.ts:16-40`) — the only `INSERT INTO feed` in the
  codebase (`grep -rn "INSERT INTO feed" src/ shared/ migrations/` → `writes.ts:23` plus the fts
  shadow-table triggers in 0008/0011 only).
- The one gate in front of it: `ingestFeedEntry` (`src/consumer.ts:96-115`). Unknown tag →
  `route_triage`; else `append_feed`. Ledger-guarded (content repeats are legal on feed, so the
  replay ledger is the only dedupe — `consumer.ts:94-95`).
- Callers of `ingestFeedEntry` (complete, `grep -rna ingestFeedEntry src/`):
  1. MCP `append_feed` tool (`src/mcp.ts:77-98`) via `feedEntryFromMcpArgs` (`src/mcp-args.ts:12-30`).
  2. `consume()` batch — MCP `record_session` (`src/mcp.ts:139-147`) and cookie `POST /ingest`
     (`src/routes.ts:23-32`) — loop at `consumer.ts:300-305`.
  3. Triage assign, feed arm (`src/tools/writes.ts:412-417`).

**Single-writer confirmation: agents are the only writers today.** The event spine never touches
feed: `grep -n "feed" src/webhook.ts src/tools/backfill.ts src/tools/progress.ts
src/tools/summarize.ts` → one cosmetic hit (a prompt string in `summarize.ts:22`). The webhook calls
only `ingestEvent` → `events` + the summary/progress seams (`src/webhook.ts:291-307`); backfill the
same (`src/tools/backfill.ts:181,199,214,218`). **No event-to-feed write exists — no defect to remove.**

One caveat on "agents-only": it is enforced by surface, not by auth class. A session-cookie human
could POST feed entries through `/ingest` (`src/routes.ts:23`); the web UI simply has no affordance
(`grep -rn "ingest" web/src/` → nothing). Convention holds in practice.

### What an entry is / how it renders

Contract `FeedEntry` = `summary, body, tags[], artifacts{prs[], commits[], issues[]}`
(`shared/contract.ts:10-19`). Rendered as cards (`web/src/render.ts:373-405`): avatar + linkified
summary (`linkifyRefs`, render.ts:168 — bare `#123` → issue links), escaped body, a hardcoded
"agent" chip (render.ts:392), relative time, and an artifact chip row (`feedArtifacts`,
render.ts:143-152: PR/commit/issue chips linking into `REPO_URL` = SaplingLearn/sapling,
`web/src/github.ts:3`).

### Known gap reconfirmed

`feed_fts` indexes **only `(feed_id UNINDEXED, summary, body)`** — artifacts are not indexed
(`migrations/0011_fts_recreate.sql:39-40`, backfill :85-86), and `query()`'s feed results don't
carry artifacts either (assembly at `src/tools/reads.ts:404-412`; `QueryPrimary` has no artifacts
field, `shared/contract.ts:84-99`). Still true. `get_feed` **does** return artifacts (`SELECT f.*`,
reads.ts:60), so the omission is search/query-side only. Once feed entries are the "what's done"
record referencing linked work, a query for "the PR that changed X" can't match on artifacts.

### Delta list to hit the target (agents posting frequent, higher-level done-posts)

The `append_feed` shape (summary/body/tags/artifacts) supports the target as-is; no new entry type
or field is structurally required. Small deltas:

1. **Body rendering is plain escaped text** — no markdown, no `white-space:pre-wrap`
   (`render.ts:389`). A multi-paragraph "what's done" body collapses into one run-on line. If done-
   posts get longer, render markdown (the repo already has `web/src/markdown.ts`) or at least
   preserve line breaks.
2. **The feed time-range filter is inert.** The control renders (All time / 24h / 7d,
   `render.ts:316`) and `setRange` stores state (`main.ts:374`), but `loadFeed` never passes `since`
   (`main.ts:68-81`) and `feedView` doesn't filter — `feedRange` is read nowhere else
   (`grep -n feedRange web/src` → 3 hits: type, init, control). Defect: wire it or drop it.
3. **`prs` artifact format is ambiguous.** The MCP tool description says "PR urls" (`mcp.ts:78`) and
   the record-session skill collects `gh pr view --json number,url`, but the renderer builds
   `#${pr}` → `/pull/${pr}` (render.ts:148) and the test canon is bare numbers
   (`test/append-feed-artifacts.test.ts:15` — `prs: ["14"]`). An agent passing a full URL produces a
   broken chip. Pick one format and align description/skill/renderer.
4. **Artifacts→search gap** (above): index artifacts (or at least PR/issue numbers) in `feed_fts`
   and/or surface artifacts on feed `query()` results.
5. (Observation, not a change) Feed's only triage trigger is an unknown tag (`consumer.ts:99-105`).
   The 6-tag vocabulary (`auth, architecture, infra, api, ui, data`) is the whole placement scheme
   for done-posts — worth a deliberate check that it's the vocabulary you want for that genre.

## 2. Docs — current state, deltas (near-zero)

### Model confirmed against the code

- **Stage:** `ingestDocProposal` (`consumer.ts:119-191`) → `propose_doc_update`
  (`writes.ts:42-109`): first proposal creates the docs row with `body='', current_version=0`
  (:63-79), every proposal inserts a `doc_versions` row `status='staged'` (:88-105);
  `docs.current_version` untouched (:107).
- **Promote (human, HTTP only):** `POST /doc/:slug/promote` (`routes.ts:93-103`) → `promote_doc`
  (`writes.ts:156-183`): flips the version to `promoted`, copies body into `docs`, bumps
  `current_version`. Non-destructive — prior versions remain, and the reader shows full history
  (`render.ts:464-471`).
- **Reject (soft):** `POST /doc/:slug/reject` (`routes.ts:107-117`) → `reject_doc_version`
  (`writes.ts:268-284`), idempotent status flip; row + body remain.

### Dedup and staleness confirmed

- **Content-hash dedupe:** SHA-256 of the proposed body vs the promoted body AND the latest staged
  body (`consumer.ts:141-158`); identical → `unchanged` drop unless `force`. Covered by
  `test/consumer.reconcile.test.ts`.
- **Staleness:** `base_version` recorded on the staged row (`consumer.ts:162-170`,
  `writes.ts:102`); the triage detail renders "Edited from vN; live is now vM — conflict possible"
  when `base_version < current_version` (`render.ts:733-735`). Flagged, never blocked.
- **Change typing:** server-computed line-LCS `change_kind` new/edit/rewrite (`consumer.ts:168`,
  `src/diff.ts`) stored and chipped in the queue (`render.ts:741`).

### Target check: "agents update as needed" vs propose-then-promote

They match. The delta list is effectively **zero**. Two notes, neither fights the intent:

- Title/section are set only on first creation and never rewritten by later proposals
  (`writes.ts:63-79`) — deliberate (a human may have set them).
- Staged bodies are not full-text indexed: `docs_fts` mirrors the live `docs` table via triggers
  (`0011_fts_recreate.sql:46-60`), so a staged-only (unpromoted) doc is findable by title/slug but
  not by its staged body text. Pre-existing; only matters if you want agents to discover each
  other's unpromoted drafts by content.

## 3. Triage — component map

Evidence-first, disposition left open per the spec.

| Component | What it does (file:line) | Backing store | Routed-in-by | On-resolve behavior | Touched by events? | Disposition |
|---|---|---|---|---|---|---|
| **Proposals queue** (staged doc versions) | Server-joined queue of staged versions newer than live, both bodies + reconciler metadata: `list_proposals` `src/tools/reads.ts:104-116`, `GET /proposals` `routes.ts:90` | `doc_versions` ⋈ `docs` | MCP `propose_doc_update` (`mcp.ts:100-115`), `record_session`/`/ingest` batch (`consumer.ts:307-312`), triage-assign doc arm (`writes.ts:388-399`) | Promote → `promote_doc` (`writes.ts:156-183`; route :93) makes it live; Reject → soft flip (`writes.ts:268-284`; route :107) | No | |
| **Decisions queue** (ADR drafts) | `list_adrs` (`reads.ts:72-79`, excludes rejected), `GET /adrs` `routes.ts:83` | `adrs` | `record_session`/`/ingest` `adr_drafts` via `ingestAdrDraft` (`consumer.ts:195-215`), triage-assign adr arm (`writes.ts:400-404`). No per-entry MCP tool exists | Ratify → `ratify_adr` (`writes.ts:211-217`; route :120); Reject → soft flip (`writes.ts:290-297`; route :133) | No | |
| **Triage proper** (`needs_triage`) | The unplaced-item queue: `list_needs_triage` `reads.ts:68-70` (`resolved = 0`), `GET /needs-triage` `routes.ts:81`; writer `route_triage` `writes.ts:134-150` | `needs_triage` (`0001_init.sql:52-59` + audit cols `0010_triage_resolve.sql:11-14`) | The gate's complete trigger set (`grep -rna route_triage src/`): feed unknown tag (`consumer.ts:100-105`); doc out-of-vocab section (:122-127); doc low-conf **new** slug (:134-139); ADR low-conf (:198-203); milestone `status:'done'` (:227-232); milestone low-conf (:233-238); explicit `needs_triage` payload items (:323-332) | Discard → `resolve_triage` soft, audit columns (`writes.ts:316-339`; route :146). Assign → `assign_triage` re-runs `raw` through the SAME gate as doc/adr/milestone/feed with confidence forced high, then resolves `'assigned'` + `assigned_ref` (`writes.ts:361-422`; route :160). Free-form (non-JSON-object) raw can only be discarded (`writes.ts:374-381`) | No | |
| **Milestones queue** (staged milestone proposals) | `list_milestone_proposals` (`reads.ts:118-120`, `staged_status='staged'`), `GET /milestone-proposals` `routes.ts:85` | `milestone_proposals` (`0004_roadmap.sql:16`) | **Only** triage-assign milestone arm (`writes.ts:405-410`; `grep -rna ingestMilestoneProposal src/` → writes.ts:408 is the sole external caller — `propose_milestone` MCP is retired, and `IngestPayload` has no milestones arm, `contract.ts:116-122`). The web UI offers **no milestone assign button** (`render.ts:823-827`: doc×3, ADR, feed only) → intake reachable only by hand-crafted `POST /needs-triage/:id/assign {type:"milestone"}` — effectively dormant | Promote → `promote_milestone_proposal` materializes a live `milestones` row, atomic claim (`writes.ts:220-249`; route :199); Reject → soft flip (`writes.ts:302-309`; route :212). **Dependency:** promote writes into `milestones`, a roadmap-owned table | No | |
| **Milestone complete** | `POST /milestones/:id/complete` → `complete_milestone` (`writes.ts:252-259`; route :236). Human-only 'done' flip; also settable in the admin plan write | `milestones` | n/a (an action, not a queue) | Status flip to `done` | No — never event-inferred (progress cache is separate) | |
| **Web Triage screen** | One screen, four queue tabs proposals/decisions/triage/milestones (`main.ts:378-390`); list pane `render.ts:500-565`; detail pane `render.ts:721-833` with per-queue actions: Promote/Reject (:753-754), Ratify/Reject (:771-772), Promote/Reject milestone (:797-798), Assign-to (doc-reference / doc-context / doc-decisions / ADR / feed) + Discard (:823-830); handlers `main.ts:497-555`. Docs reader deep-links in via the STAGED banner (`render.ts:458-462`) | — (renders the four stores above) | — | Calls the session-cookie HTTP routes; none of these are MCP tools (verified: `src/mcp.ts` registers no triage read/write) | No | |
| **Resolution audit trail** | Soft exits only, nothing hard-deletes: `resolved/resolved_at/resolved_by/resolution/assigned_ref` (`0010_triage_resolve.sql`), rejected statuses retained. But no surface reads resolved rows today (`list_needs_triage` filters them out; no history view in web) | `needs_triage`, `doc_versions`, `adrs`, `milestone_proposals` | — | — | No | |
| **Skills touching triage** | `record-session` is the only writer-side skill: it can deliberately emit `needs_triage` items and treats triage-routing as the correct outcome for uncertain entries (`.claude/skills/record-session/SKILL.md:66,94`). No skill reads the queue (impossible — no MCP tool exposes it). `load-context`/`canopy` only teach authority-flag scrutiny of staged content | — | — | — | No | |

Tests pinning this behavior: `test/triage-reads.test.ts`, `test/triage-writeback.test.ts`,
`test/render.triage.test.ts`, `test/consumer.vocab-gate.test.ts`, `test/consumer.reconcile.test.ts`.

## 4. Centerpiece: what is triage for now

**Triage's sole remaining job is reviewing agent-proposed content. The event spine bypasses it
completely, and nothing event-derived can ever land in it.**

Evidence: `ingestEvent` (`consumer.ts:265-277`) has no vocab check, no confidence, no
`route_triage` — dedupe is the UNIQUE `semantic_key` via `INSERT OR IGNORE`, and the only outcomes
are `written`/`unchanged`. Its two callers, the HMAC-verified webhook (`webhook.ts:295`) and the
admin backfill (`backfill.ts:181,214`), fan out only to `events`, `pr_summaries`, and
`milestone_progress`. An unmapped `subject_login` doesn't triage either — it's a captured-but-
unsurfaced no-op (`mywork.ts:59-62`, seed comment `0012_events_plan.sql:44-45`). The complete
`route_triage` caller set lives inside the four agent-content gate functions plus the explicit
`needs_triage` payload arm — all of them agent-proposal paths.

So with events high-trust and Feed agents-only, triage collapses to exactly one purpose across four
queues: **the human half of "agents stage, humans confirm"** — doc proposals, ADR drafts, unplaced
items, and a milestones queue whose intake is effectively dormant (assign-only, no UI affordance).
Everything in it is agent output awaiting a human verdict; the redo can treat "review agent
proposals" as the entire problem statement, plus a decision about whether any event-adjacent case
(unmapped subjects) should be *added* to its scope.

## 5. Open questions the redo decision depends on

1. **Unmapped event subjects.** `people` is seeded only in migration `0012` — there is no runtime
   write path and no UI for it (`grep -rna "INTO people"` → the migration only). Unmapped logins'
   events are captured and visible via `get_events` but surface in no My Work. Should "map this
   login" become a triage job (the one event-adjacent case that could enter the redone triage), or
   stay an admin/migration concern?
2. **The milestones queue.** Intake is dormant (triage-assign only; no UI button offers it). Keep
   the queue + `ingestMilestoneProposal` for the assign path, or retire the queue in the redo and
   make milestone creation purely a plan-write concern?
3. **Feed's triage coupling.** Feed's only trigger is an unknown tag. If the redone triage drops
   feed routing, does an out-of-vocab tag become a hard error at `append_feed` time instead — and is
   the 6-tag vocabulary still the right placement scheme for higher-level done-posts?
4. **The explicit `needs_triage` arm** of `record_session` — the agent's deliberate "I can't place
   this, human please" channel. Keep as-is in the redo?
5. **The low-confidence asymmetry** — low-conf **new** slug → triage, low-conf **existing** slug →
   stage-and-flag (`consumer.ts:130-139`, `writes.ts:104`). Keep, or unify in the redo?
6. **Resolved-item visibility.** Every exit is soft and audited, but nothing renders resolved rows
   or rejected versions as history. Does the redo want an audit/history view, or is the D1 trail
   enough?
7. **Free-form triage items** can only be discarded (`writes.ts:374-381`). Acceptable, or should
   assign offer a compose/edit step?

## Side-finding (out of scope, worth knowing)

`src/consumer.ts` contains two **raw NUL bytes** used as content-hash join separators
(`ingestAdrDraft` line 205, `ingestMilestoneProposal` line 254 — `join("\0")` written as a literal
byte). Functionally sensible (unambiguous field separator), but it makes the file register as binary
to `file`, `grep`, and `git diff`. Consider rewriting as the escape sequence (backslash-zero) so the file
stays text — behavior identical, tooling restored.

# Wire-contract audit results — mock frontend ↔ finished backend reads

Date: 2026-07-04. Two-sided contract audit per `canopy-audit-wire-contract.md`. No code changed.

Frontend evidence: `web/src/triage-mock.ts` (the single mock module), `web/src/review.ts`,
`web/src/maintenance.ts` (prop shapes), `web/src/render.ts` (props builders + nav counts),
`web/src/main.ts` (dispatch), `web/src/api.ts` (typed fetch layer — several triage helpers
already exist). Backend evidence: `src/tools/reads.ts`, `src/tools/writes.ts`, `src/routes.ts`,
`shared/rows.ts`, `shared/contract.ts`, `shared/vocabulary.ts`, `src/consumer.ts`.

Legend: **Match** (drops in) · **Rename** (trivial mapping/derivation) · **MOCK-ONLY** (component
renders it, backend doesn't send it) · **BACKEND-ONLY** (read returns it, UI never designed for it).

---

## 1 · Review — Proposals

Component props: `ReviewItem` (`web/src/review.ts:23-39`), consumed by `reviewCard`
(`review.ts:59`) and `reviewDetail` (`review.ts:208`).
Backend read: `list_proposals()` → `ProposalRow` (`src/tools/reads.ts:85-116`), served by
`GET /proposals` (`src/routes.ts:94`). The client type + helper **already exist**:
`StagedProposal` / `listStagedProposals()` (`web/src/api.ts:151-171`) — it mirrors `ProposalRow`
field-for-field.

| Component prop (file:line) | Mock value shape | Backend read field (file:line) | Category | Note |
|---|---|---|---|---|
| `id` (review.ts:24) | `"p1"` opaque string | `slug` + `version` (reads.ts:87-88) | Rename | No single id. Synthesize e.g. `doc:${slug}@${version}`; the accept/reject buttons must decode back to `(slug, version)` for the write routes. |
| `kind` (review.ts:25) | `"proposal"` | — (implied by source list) | Rename | Constant per list; set when merging the two reads. |
| `eyebrow` (review.ts:26) | `"PROPOSAL · DOCS / RUNBOOKS"` | `section` + `space` (reads.ts:89-90) | Rename | Derived. **The mock taxonomy is fictional** — real sections are only `reference`/`context`/`decisions` (shared/vocabulary.ts:3), spaces `sapling`/`canopy`. |
| `badge` (review.ts:27) | `"STAGED"` | `status` (reads.ts:94) | Rename | Always `'staged'` in this queue (WHERE clause reads.ts:113). |
| `badgeColor` (review.ts:28) | `"var(--amber)"` | — | MOCK-ONLY | Decorative; derive from kind. Drop from data. |
| `title` (review.ts:29) | string | `title` (reads.ts:88) | Match | From the joined doc row. |
| `summary` (review.ts:30) | string, always present | `summary` (reads.ts:91) | Match | **Nullable** on the backend (`string \| null`). Card renders a 2-line clamp — needs a fallback (empty or body excerpt). |
| `agent` (review.ts:31) | `"agent · session 4f2c"` | `author` (reads.ts:92 — `v.created_by`) | Rename | Author is the bearer principal's GitHub login. **Session id is MOCK-ONLY** — not stored on `doc_versions`; drop it. |
| `agentInitials` (review.ts:32) | `"A4"` | — | Rename | Derive from `author` (render.ts:160 `initialsOf` already does this for feed). |
| `time` (review.ts:33) | `"18m ago"` | `created_at` (reads.ts:99) | Rename | ISO → `relTime` (render.ts:165). |
| `stale` (review.ts:34) | boolean | `base_version` + `current_version` (reads.ts:97-98) | Rename | Derive: `base_version !== null && base_version < current_version`. |
| `staleNote` (review.ts:35) | prose sentence | `base_version`, `current_version` | Rename | Compose client-side ("Proposed from v{base} — the live doc is now v{current}"). |
| `liveVersion` (review.ts:36) | `"LIVE (v8)"` | `current_version` (reads.ts:98) | Rename | Format client-side. |
| `diff` (review.ts:37) | pre-chewed `DiffEntry[]` (`ctx/add/del/gap/h`, review.ts:18-19) | `stagedBody` + `promotedBody` (reads.ts:100-101) | **BACKEND-ONLY replaces MOCK-ONLY** | The backend sends **both raw bodies**, never a diff. Compute client-side — `lineDiff`/`collapsedLineDiff` already exist (render.ts:556, 578) **but emit `DiffRow` kind `ctx/add/del/ellipsis`, not the mock's `ctx/add/del/gap/h`**: `ellipsis` (carries "N unchanged lines" text) ≠ `gap` (bare separator), and nothing produces `h` (heading emphasis). Wire-up must reconcile the two diff-row vocabularies — adapt the viewer or the differ. |
| — | — | `slug`, `version` (reads.ts:87-88) | BACKEND-ONLY | Needed by the promote/reject POSTs; carry them even though nothing renders them. |
| — | — | `confidence` (reads.ts:93) | BACKEND-ONLY | `high`/`low`/null. Never modeled by the design. Decide: render as a chip or ignore. |
| — | — | `change_kind` (reads.ts:95) | BACKEND-ONLY | `new`/`edit`/`rewrite`/null, server-computed. Never modeled. Decide: chip in list/detail or ignore. |
| — | — | `low_confidence` (reads.ts:96) | BACKEND-ONLY | `1` = staged-and-flagged for scrutiny — this is exactly the "scrutinize" signal from the core invariant. Ignoring it loses information the gate deliberately surfaces. Decide loudly. |
| — | — | `space` (reads.ts:90) | BACKEND-ONLY | Docs screen groups by space; the Review design doesn't. Fold into eyebrow or ignore. |

## 2 · Review — Decisions

Component props: same `ReviewItem`, `kind:"decision"`, plus `adr: AdrSection[]` (`review.ts:21,38`)
rendered by `adrRecord` (`review.ts:195`).
Backend read: `list_adrs(status?)` → `AdrRow[]` (`src/tools/reads.ts:72-79`, shape
`shared/rows.ts:42-54`), served by `GET /adrs` (`src/routes.ts:83`). Client helper exists:
`listAdrs(status?)` (`web/src/api.ts:115-117`).

| Component prop | Mock value shape | Backend read field | Category | Note |
|---|---|---|---|---|
| `id` (review.ts:24) | `"d1"` | `id` (rows.ts:44, number) | Rename | Synthesize e.g. `adr:${id}`; ratify/reject need the numeric id back. |
| `eyebrow` (review.ts:26) | `"DECISION · ADR-014"` | `id` | Rename | Format from the numeric id. |
| `badge` (review.ts:27) | `"DRAFT"` | `status` (rows.ts:49) | Rename | **Queue must fetch `/adrs?status=draft`** — the unfiltered read also returns `ratified` (reads.ts:76-78). |
| `title` (review.ts:29) | string | `title` (rows.ts:45) | Match | |
| `summary` (review.ts:30) | one-liner | — | **MOCK-ONLY** | `AdrRow` has no summary field. Derive (e.g. first sentence of `decision`) or leave the card's 2-line slot empty. Decision needed. |
| `agent` / `agentInitials` / `time` | as above | `created_by` / — / `created_at` (rows.ts:51-52) | Rename | Session id MOCK-ONLY, same as proposals. |
| `adr` (review.ts:38) | `[{h:"Context"},{h:"Decision"},{h:"Consequences"}]` | `context`, `decision`, `rationale` (rows.ts:45-47) | Rename | Three nullable columns → sections. **Mock's third heading is "Consequences"; the backend field is `rationale`.** The MCP query engine renders it as "Rationale" (reads.ts:243); pick a label. Each field is nullable — skip empty sections. |
| `stale`/`staleNote`/`liveVersion`/`diff` | absent for decisions | — | Match | ADRs have no versions/diff; `adrRecord`'s "new document — no prior version" caption (review.ts:202) is accurate. |
| — | — | `confidence` (rows.ts:50) | BACKEND-ONLY | Same decision as proposals. |
| — | — | `content_hash` (rows.ts:53) | BACKEND-ONLY | Dedupe internals; safely ignore. |

## 3 · Maintenance — Unplaced

Component props: `UnplacedItem` (`web/src/maintenance.ts:14-21`) rendered by `unplacedRow`
(`maintenance.ts:101`); `AssignOptions` (`maintenance.ts:24-27`) rendered by `assignPanel`
(`maintenance.ts:74`).
Backend read: `list_needs_triage()` → `NeedsTriageRow[]` where `resolved = 0`
(`src/tools/reads.ts:68-70`, shape `shared/rows.ts:62-75`), served by `GET /needs-triage`
(`src/routes.ts:81`). Client helper exists: `listNeedsTriage()` (`web/src/api.ts:112-114`).

| Component prop | Mock value shape | Backend read field | Category | Note |
|---|---|---|---|---|
| `id` (maintenance.ts:15) | `"u1"` string | `id` (rows.ts:64, number) | Match | Type coercion only; discard/assign need the number. |
| `title` (maintenance.ts:16) | `"Notes on connection pool sizing"` | — (inside `raw`) | **MOCK-ONLY as a field** | `raw` (rows.ts:65) is the stored payload: JSON of the gated item (DocProposal/AdrDraft/MilestoneProposal/FeedEntry) **or a free-form string** for agent-flagged batch items (contract.ts:42, consumer.ts:334-340). Derive title client-side from `raw` (`title` / `summary` / `slug` keys), fallback for free strings. |
| `snippet` (maintenance.ts:17) | quoted excerpt | — (inside `raw`) | **MOCK-ONLY as a field** | Same derivation: `body`/`summary` from parsed JSON, or the raw string itself. |
| `reason` chip (maintenance.ts:18) | `"AGENT FLAGGED"` / `"LOW CONFIDENCE"` | `reason` (rows.ts:66, free string) | Rename | **No enum exists.** Gate-produced strings (src/consumer.ts): `unknown tag: …` (:101), `out-of-vocab section: …` (:123), `low confidence doc proposal` (:135), `low confidence adr draft` (:199), `milestone completion is a human action` (:232), `low confidence milestone proposal` (:238) — plus verbatim agent-supplied reasons from batch items (:340). Chip classification (`starts with "low confidence"` → LOW CONFIDENCE, else AGENT FLAGGED / vocab) is a client-side heuristic; be explicit that it's lossy. |
| `meta` (maintenance.ts:19) | `"agent · session 9b1e · 2h ago"` | `source_author` (rows.ts:67) + `created_at` (rows.ts:68) | Rename | Author + relTime. **Session id MOCK-ONLY** — not stored. |
| `reasonNote` (maintenance.ts:20) | prose | `reason` (verbatim) | Rename | The full reason string fits here better than in the chip. |
| — | — | `raw` itself | BACKEND-ONLY | Beyond title/snippet derivation, decide whether the detail exposes the full payload (useful for judging placement). |
| — | — | `resolved`, `resolved_at/by`, `resolution`, `assigned_ref` (rows.ts:69-74) | BACKEND-ONLY | Always `0`/null in this list (WHERE resolved = 0). Safely ignore. |

**Assign panel — the biggest shape mismatch on this surface.** Mock `AssignOptions`
(`triage-mock.ts:94-102`) is `{kinds: string[], targets: Record<kind, string[]>}` with fictional
prose targets ("Runbooks / Deployment", "Q3 — Reliability") and a single target pick. The real
write `POST /needs-triage/:id/assign` (`src/routes.ts:164-181` → `assign_triage`,
`src/tools/writes.ts:429-490`) takes `{type, section?, space?, tags?}` (`AssignTarget`,
writes.ts:409-415) where the per-type "where it goes" differs structurally:

- `type:"doc"` → requires a valid `section` (`reference|context|decisions`, vocabulary.ts:3) and
  optionally `space` (`sapling|canopy`) — **two** choices, not one (writes.ts:456-467).
- `type:"feed"` → optional `tags[]` from the tag vocab (vocabulary.ts:4) — **multi-select** (writes.ts:479-485).
- `type:"adr"` / `type:"milestone"` → no target at all (writes.ts:468-478).

The mock's kinds map cleanly (`Doc section`→`doc`, `Decision record`→`adr`, `Roadmap note`→`milestone`,
`Feed update`→`feed`), but the second column must be rebuilt per type from `@shared/vocabulary`
(web already imports it — render.ts:11). Also: `assign_triage` **throws on free-form raw**
("cannot assign a free-form triage item; discard it instead", writes.ts:448) and on vocab misses —
the File It button must surface `ApiError.message` (the flash pattern exists, main.ts:201).

## 4 · Maintenance — Identity

Component props: `IdentityGroup` / `ActivitySample` / `Person` (`web/src/maintenance.ts:29-40`)
rendered by `identityCard` (`maintenance.ts:143`) and `personPicker` (`maintenance.ts:127`).
Backend read: `list_identity_tasks()` → `IdentityTaskWithSample[]` (`src/tools/reads.ts:127-178`,
task shape `shared/rows.ts:178-184`), served by `GET /identity-tasks` (`src/routes.ts:188`),
envelope `{tasks}`. **No client helper exists in api.ts yet.**

| Component prop | Mock value shape | Backend read field | Category | Note |
|---|---|---|---|---|
| `id` (maintenance.ts:32) | `"g1"` | `login` (rows.ts:179 — the PK) | Rename | There is no numeric id; `login` is the key and the map route's path param. |
| `login` (maintenance.ts:33) | `"mk-dev2"` | `login` | Match | |
| `meta` (maintenance.ts:34) | `"first seen 3w ago"` | `first_seen` (rows.ts:180) | Rename | ISO → relTime. |
| `countNum` (maintenance.ts:35) | `14` | — | **MOCK-ONLY** | **The backend returns no pending-event count.** `list_identity_tasks` returns at most 3 sampled events (`IDENTITY_SAMPLE_LIMIT`, reads.ts:138) and no `COUNT(*)`. The card's accent line, the section header's "M events waiting" (maintenance.ts:172), and the map-confirmation toast (main.ts:448) all render it. Decide: add a count to the read, or degrade the copy ("recent activity" instead of "N events waiting"). |
| `countLabel` (maintenance.ts:36) | `"14 events waiting on this match"` | — | MOCK-ONLY | Same gap; derived from `countNum`. |
| `sample[].kind` (maintenance.ts:29) | `"PR"` / `"COMMIT"` / `"ISSUE"` | `sample[].event_type` (reads.ts:130) | Rename | Real values are only `pr_merged` / `pr_closed` / `issue` (rows.ts:141). **`COMMIT` never occurs** — commits are not captured events; the mock's commit rows are fiction. Map pr_* → PR, issue → ISSUE. |
| `sample[].text` (maintenance.ts:29) | `"#412 Fix pagination …"` | `sample[].ref_number` + `sample[].title` (reads.ts:129-131) | Rename | Compose `#${ref_number} ${title}`. `title` is **nullable** (malformed raw → null, reads.ts:140-147). |
| `sample[].when` (maintenance.ts:29) | `"2d ago"` | `sample[].occurred_at` (reads.ts:132) | Rename | Nullable ISO → relTime. |
| — | — | `sample[].semantic_key` (reads.ts:128) | BACKEND-ONLY | Stable key; useful as a render key, else ignore. |
| — | — | `status`, `resolved_at`, `resolved_by` (rows.ts:181-183) | BACKEND-ONLY | Always `pending`/null in this list. Ignore. |

**Person picker (`Person`, maintenance.ts:40; `MOCK_PEOPLE`, triage-mock.ts:122-127) — no backend
counterpart at all.** There is **no people-list read**: the only routes touching `people` are the
map write and reads that consume it. The write `POST /identity-tasks/:login/map` takes `person` as
a **free non-empty string** (`src/routes.ts:194-204`, `map_identity` writes.ts:190-218). What the
picker should offer (org members from `users`? distinct existing `people.person` values? free text?)
is undesigned — see open questions. Note `getMyWork` resolves the mapping by looking up the
**signed-in login** in `people` (`src/tools/mywork.ts:61`), so the semantics of `person` (display
string) vs the login keying matter for what value the picker posts.

## 5 · Nav counts (sidebar Review / Maintenance badges)

Frontend: `triageCounts()` (`web/src/render.ts:136-143`) — review = pending mock review items;
maintenance = pending mock unplaced + pending mock identity groups. Rendered in `sidebar()`
(render.ts:279-296) as a count pill (Review) and bare number (Maintenance), collapsed-mode dot.

**Backend: there is no counts endpoint.** Nothing in `src/routes.ts` returns queue sizes. The
counts are the lengths of the four list reads:

- review = `GET /proposals`.length + `GET /adrs?status=draft`.length
- maintenance = `GET /needs-triage`.length + `GET /identity-tasks`.length

Consequences for wiring: (a) the sidebar shows counts on **every** screen, so these four reads must
be loaded at session boot (not lazily on first visit) or the badges lie; (b) every accept/reject/
discard/assign/map must refresh or locally decrement them; (c) fetching four lists to render two
numbers is the cost of not having a counts route — acceptable at this scale, but it's a decision,
not an accident. Category: **MOCK-ONLY convenience** (instant counts) that wiring must reproduce.

---

## 6 · Consolidated decision list (mock-only + backend-only)

**Mock-only props (component renders it; backend never sends it):**

1. `IdentityGroup.countNum` / `countLabel` — no pending-event count anywhere in the read. Needs a
   backend addition or a copy change. **The only gap that likely needs a backend change.**
2. `Person` / `MOCK_PEOPLE` picker options — no people-list read; `person` is a free string.
3. `ReviewItem.summary` for decisions — no summary column on `adrs`; derive or drop.
4. Session ids in `agent`/`meta` strings ("session 4f2c") — not stored anywhere; drop.
5. `UnplacedItem.title`/`snippet` as fields — derivable from `raw`, but the derivation (esp. for
   free-form raw) is wire-up code that doesn't exist yet.
6. `badgeColor` — decorative; fold into the component.
7. Mock assign targets ("Runbooks / Deployment", "Q3 — Reliability") — fictional; real targets are
   section/space/tags from `@shared/vocabulary`.
8. Identity sample kind `COMMIT` — the event store has no commit events.
9. Pre-computed `diff: DiffEntry[]` — replaced by client-side diff of the two bodies; the existing
   differ's row vocabulary (`ellipsis`) doesn't match the viewer's (`gap`/`h`).

**Backend-only fields (read returns it; UI never designed for it):**

1. `ProposalRow.low_confidence` — the gate's "stage and flag for scrutiny" bit. Rendering nothing
   silently discards a human-review signal. Decide.
2. `ProposalRow.change_kind` (`new`/`edit`/`rewrite`) — server-computed delta class. Chip or ignore.
3. `ProposalRow.confidence` / `AdrRow.confidence` — agent's own confidence. Chip or ignore.
4. `ProposalRow.space` — Review design has no space affordance (Docs screen does). Eyebrow or ignore.
5. `NeedsTriageRow.raw` full payload — show in detail or keep only the derived title/snippet.
6. Resolution audit columns (`resolved_*`, `assigned_ref`; identity `status`/`resolved_*`) — always
   empty in the pending lists; safe to ignore.
7. `IdentitySample.semantic_key` — render key or ignore.
8. **An entire backend-only surface: milestone proposals.** `GET /milestone-proposals`
   (routes.ts:85, `list_milestone_proposals` reads.ts:118-120) with promote/reject routes
   (routes.ts:226-248) and existing api.ts helpers (api.ts:118-120, 180-182, 194-196). The mock
   Review models only proposals + decisions. Staged milestone proposals now arise only via
   triage-assign (`type:"milestone"`), so the queue is rarely non-empty — but if Review doesn't
   render them, nothing in the UI ever surfaces them. Decide: third Review kind, or explicitly out.

## 7 · Routes + auth per surface

Everything below sits behind `sessionGate` (`src/routes.ts:18`) — session-cookie, human, same
origin. `web/src/api.ts` already sends `credentials:"same-origin"` (api.ts:22,31). None of these
are MCP tools; none require admin (`isAdmin` guards only `/admin/backfill`, routes.ts:256 — note
`identity-tasks/:login/map` is session-only despite rows.ts:169 calling the map "admin-maintained").

| Surface | Read (route → fn) | api.ts helper | Writes (route → fn) | api.ts helper |
|---|---|---|---|---|
| Review · Proposals | `GET /proposals` (routes.ts:94) → `list_proposals` (reads.ts:104) | `listStagedProposals` (api.ts:169) ✓ | `POST /doc/:slug/promote {version}` (routes.ts:97) → `promote_doc` (writes.ts:224); `POST /doc/:slug/reject {version}` (routes.ts:111) → `reject_doc_version` (writes.ts:336) | `promoteDoc` (api.ts:174) ✓, `rejectDoc` (api.ts:188) ✓ |
| Review · Decisions | `GET /adrs?status=draft` (routes.ts:83) → `list_adrs` (reads.ts:72) | `listAdrs` (api.ts:115) ✓ | `POST /adr/:id/ratify` (routes.ts:124) → `ratify_adr` (writes.ts:279); `POST /adr/:id/reject` (routes.ts:137) → `reject_adr` (writes.ts:358) | `ratifyAdr` (api.ts:177) ✓, `rejectAdr` (api.ts:191) ✓ |
| Maintenance · Unplaced | `GET /needs-triage` (routes.ts:81) → `list_needs_triage` (reads.ts:68) | `listNeedsTriage` (api.ts:112) ✓ | `POST /needs-triage/:id/discard` (routes.ts:150) → `resolve_triage` (writes.ts:384); `POST /needs-triage/:id/assign {type,section?,space?,tags?}` (routes.ts:164) → `assign_triage` (writes.ts:429) | `discardTriage` (api.ts:197) ✓, `assignTriage` (api.ts:201) ✓ |
| Maintenance · Identity | `GET /identity-tasks` (routes.ts:188) → `list_identity_tasks` (reads.ts:154), envelope `{tasks}` | **missing** | `POST /identity-tasks/:login/map {person}` (routes.ts:194) → `map_identity` (writes.ts:190) | **missing** |
| (undesigned) Milestone proposals | `GET /milestone-proposals` (routes.ts:85) | `listMilestoneProposals` (api.ts:118) ✓ | promote (routes.ts:226) / reject (routes.ts:239) | api.ts:180, 194 ✓ |

All writes respond `{ok:true, ...}` and map domain errors to `400 {error}` (e.g. routes.ts:104-106);
promote/reject/ratify/discard/map are idempotent-safe on re-POST (writes.ts:352, 361, 393-396,
198-202). `Unauthorized`/`ApiError` handling conventions already exist in api.ts:12-19 and every
loader in main.ts.

## 8 · Loading / error / empty state gaps

The app has an established pattern: `Loadable<T>` slices (`render.ts:24-28`), per-screen loaders
with `Unauthorized` → login redirect (e.g. main.ts:68-108), and the `notice()` helper for
loading/error (render.ts:208). The triage surfaces have **none of it** — their state is UI-only
(`render.ts:50-62`) and their data is synchronous mock.

| Surface | Empty | Loading | Error |
|---|---|---|---|
| Review list | ✓ exists (`reviewListEmpty` review.ts:78; `reviewQueueClear` review.ts:237) | ✗ add | ✗ add |
| Review detail | ✓ (queue-clear pane) | ✗ (bodies arrive with the list, so list-level is enough) | ✗ add |
| Maintenance · Unplaced | ✓ (`maintEmpty` maintenance.ts:65, used :176) | ✗ add | ✗ add |
| Maintenance · Identity | ✓ (maintenance.ts:180) | ✗ add | ✗ add |
| Nav counts | ✓ (zero hides the pill, render.ts:289-296) | ✗ decide: hide badge while unfetched | ✗ decide: hide on error |

Wiring needs four `Loadable` slices (proposals, draft ADRs, needs-triage, identity-tasks) plus
`loadXIfNeeded` loaders keyed off `goReview`/`goMaintenance` (main.ts:297-298 currently just flip
`state.screen`) **and** a boot-time load for the sidebar counts (see §5). Every verdict action must
also invalidate/refresh its list — the mock's `*Done` arrays (render.ts:56-58) become obsolete.

## 9 · Open questions (surfaced, not resolved)

1. **Identity pending count** — add `COUNT(*)` per login to `list_identity_tasks`, or change the
   copy? The mock's confirmation toast and section header both promise a number the read can't supply.
2. **Person picker source** — what populates "WHO IS THIS"? No people-list read exists; `person` is
   a free string. Candidates: `users` (org members who have signed in), distinct `people.person`,
   or free text. Related: should `person` be a display name or a canonical login, given
   `getMyWork` keys the projection on the **signed-in login** (mywork.ts:61) — mapping alias login
   `mk-dev2` → "Maya Krishnan" does not merge those events into the dashboard of Maya's primary
   login; is that understood/intended for the picker's promise ("flows into their view")?
3. **Reconciler metadata rendering** — `low_confidence`, `change_kind`, `confidence`: chips in
   Review, or ignored? `low_confidence` in particular exists precisely to direct human scrutiny.
4. **Milestone proposals** — third Review kind or explicitly unrendered? If unrendered, an assigned
   `type:"milestone"` item disappears from every UI surface until promoted via curl.
5. **Diff row vocabulary** — adapt `collapsedLineDiff` output (`ellipsis`) to the viewer's
   `gap`/`h` model, or change the viewer? Also: does the split/rendered view survive real bodies
   (hundreds of lines) without the mock's hand-tuned hunks?
6. **Reason-chip heuristic** — classifying free-string `reason` into AGENT FLAGGED / LOW CONFIDENCE
   is lossy (six gate strings + arbitrary agent strings). Acceptable, or should the chip show the
   gate-string verbatim/a third "VOCAB" class?
7. **ADR card summary** — derive from `decision` (first sentence) or drop the summary line for
   decisions?
8. **Count freshness** — after a verdict, refetch the affected list (simple, extra request) or
   locally decrement (fast, drift-prone)? The mock decrements.

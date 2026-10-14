# The feed brief, FTS query engine and quick search

<!-- Moved verbatim out of CLAUDE.md (2026-10-07). This is the detailed reference; CLAUDE.md keeps only what applies to every change. Keep it current when you change the area. A reference to another section ("see Core invariant", "the Repo dashboard section below") now means another file in this folder — see the table at the bottom of CLAUDE.md. -->

**The feed brief** (`0034_feed_brief_artifact_cap`, spec `docs/superpowers/specs/2026-09-26-feed-brief-design.md`). A
feed entry has two readers. `summary` is the one-line title; `brief` (optional, 1–2 plain sentences,
`FEED_BRIEF_MAX` = 280 characters, over it is a validation error that writes nothing) is the problem solved
in product words, for PEOPLE; `body` is the agent record. The Feed screen's header switch **For reading**
(default; title + brief + artifact chips, no body — an entry with no brief is title-only) / **For agents**
(the full body) is client-side, saved per browser as `trov.feedView`. `get_feed` returns both, and
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

## Tags — ONE list per organization (`0056_org_tags`, phase 1)

Each org has its own tag list (`org_tags`: `name`, a one-line `description`, a `color` from
`shared/tags-core.ts` `TAG_COLORS`, `starter`, `retired_at`, `merged_into`). It starts as the six STARTER tags
(`STARTER_TAGS` = the names of `shared/vocabulary.ts` `TAGS` and `0002_seed_vocab.sql`): 0056 seeded them for
the orgs that existed, `createOrg` (`src/orgs/repo.ts`) seeds them for a new one, and `tagRows` gives them to
an org that has NO row at all (one a pre-0056 Worker created). **Phase 1 puts tags on feed entries, docs and
decisions** (`entry_tags.entry_type` = `feed` / `doc` / `adr`; ids: the entry's number, the doc's slug, the
decision's number). Tickets, artifacts (`area`) and prompts (free-text tags) are untouched — phase 2.

- **Stored by NAME.** `entry_tags(org_id, tag, entry_type, entry_id)` holds the tag's name; 0056 rebuilt the
  table without its reference to the global `tags` table (which stays, unread: it names the starters) and
  added NO reference to `org_tags` — what may be stored is the gate's rule and `setItemTags`'s, so the Worker
  from before 0056 keeps working. A name is lowercase letters, digits and hyphens, ≤ 32 (`normalizeTagName`).
- **Only an org ADMIN changes the list** (`src/tools/tags.ts`, each `requireRole(ctx, "admin")` with an
  `org_admin_audit` row `tag.*` in the same batch; cookie routes in `src/tags/routes.ts`, which refuse any
  request carrying an `Authorization` header — NEVER MCP): `addTag`; `editTag` (rename and/or description,
  colour — a rename rewrites `entry_tags` in the batch, so every tagged item stays tagged; a starter may be
  renamed); `mergeTag` (the source's items move to the target, the source is retired with
  `merged_into`, and an agent that still sends it gets the target; a starter cannot be merged away);
  `retireTag` (soft: stays on what has it, can no longer be picked, name stays reserved; never a starter) and
  `restoreTag`. Nothing is hard-deleted.
- **The plan caps the list**: `tags` in `PLANS` (`plans.md`), `requirePlan(ctx, "tags")` on add, restore and
  accepting a suggestion (402 `plan_limit`). Live tags count; retired ones do not.
- **Suggestions** (`org_tag_suggestions`): one row per ITEM and suggested tag — `source` (`agent` now; `model`
  later, issues #154–#158), `state` (`open` / `accepted` / `dismissed` / `superseded`), nullable `confidence`,
  `reason`, `model`, `prompt_version`, who suggested and who resolved. A suggestion is never the tag itself:
  the item's tags are `entry_tags`. Phase 1 writes only agent rows — a tag the gate could not use
  (`ingestion-gate.md`). `listTags` groups the open rows whose tag is NOT live by tag text (who sent it, on
  what, how many, a look-alike on the list) — admins only. `resolveSuggestion`: **accept** (the tag joins
  the list — or is restored — and every item that carried it gets it), **map** (`into` an existing live tag:
  the items get that one; rows are `accepted` with `resolved_to` = it), **dismiss** (nothing tagged; a later
  use is a new suggestion). Adding or renaming a tag TO a suggested name settles those rows the same way.
- **Any member** reads the list (`GET /api/o/:slug/tags` → `TagListDTO`: tags with per-type counts, `used`,
  `cap`; suggestions `[]` unless admin), one tag's page (`GET /tags/:name` → `TagPageDTO`: feed entries, docs,
  decisions, newest 50 each, what it is seen with, who writes about it — authors across the three types, a doc
  counting for its last editor — and Jev's share: an item a run added the tag to carries `jev` { confidence,
  reason, at } from its `source = 'model'`, `accepted` provenance row while it still has the tag, and
  `jev_added` counts them all) and sets one item's tags
  (`POST /item-tags` `{ type, id, tags }` → `setItemTags`: an authored, direct write; each tag must be live or
  already on the item, at most 12). Reads answer 503 `{ error }` on failure, never a 500.
- **Agents** read the list with MCP **`list_tags`** (live tags + descriptions) and can only USE it.
  `get_feed` (MCP and HTTP) returns each entry's `tags`; `GET /doc/:slug` the doc's.
- **Tagging existing items — Jev ADDS the tag** (issues #154–#158, #166; `src/tools/classify.ts`, `src/tools/tag-fit.ts`).
  When an admin adds a tag (or accepts a suggested one), and on "Find items", Trov asks a model which of the
  org's EXISTING items fit it, and **adds the tag to each item it judges a fit** (≥ `FIT_THRESHOLD`, 0.7). The model
  is **TypeSafe AI's Jev** (`POST https://api.typesafe.ai/v1/systemone`, `TYPESAFE_API_KEY`), a NON-generative
  decision model: ONE request per candidate item, the item's text as `state` and one `noul` (yes/no) question keyed
  `fits` with `criteria` built from the tag's name and description, at most 4 in flight. Its answer is a
  probability: "fits" at 0.5 or more, the confidence that probability. Summaries are on Anthropic (`ai.md`).
  - **A deliberate exception to #154's "suggestions, never actions" — the owner's call (2026-10-14)**: no review
    step. It is SCOPED: only a run an ADMIN starts (adding a tag, accepting a suggested one, Find items), only with
    the org's switch on, only that org's items, and it only ever ADDS that one tag — it never removes or changes
    anything else. Every other rule holds: never on a render path (the route starts the run and hands its work to
    `waitUntil`); a fixed set of answers (a `noul` must be a number 0–1, anything else is no judgement); metered
    (`jev_checks`, one per request, `plans.md`).
  - **Provenance**: each tag a run adds keeps an `org_tag_suggestions` row — `source = 'model'`, `confidence`,
    `reason`, `model` (the version Jev reports, e.g. `jev-1.13.0`), `prompt_version` `jev-fit-1`, `state =
    'accepted'`, `resolved_by = 'jev'` (a reserved handle) and the run's `run_id` — written in the SAME batch as
    the `entry_tags` row (`INSERT … WHERE changes() > 0`, so a row exists only for a tag the run really added).
    One `tag.fit` row in `org_admin_audit` per run (counts only).
  - **The way back**: `POST /api/o/:slug/tags/:name/undo-run` (admins, cookie; `undoTagFit`) removes EXACTLY the tags
    that run added and that are still there — never one a person or another run added — marks those rows
    `undone` and the run `undone_at`, audited `tag.fit.undo`. A PERSON taking a tag off one item (`setItemTags`)
    marks a run's row for it `removed` in the same batch. A later run skips an item whose row is `undone`,
    `removed`, `dismissed` or `open`, so it never adds a tag back that someone took off.
  - **The reason is Trov's EVIDENCE, never the model's**: Jev writes no text, and #157 shows no suggestion without
    a reason, so the reason is the full-text snippet around the match that made the item a candidate
    (`evidenceOf`: `Mentions “…session cookie…”`, scrubbed like the excerpt) — or "Matches the tag's description"
    when the match left no usable snippet. A TOPPED-UP item (below) matched nothing, so its reason is the model's
    score said as such: `Jev rates it a fit (87%)` (`scoreReason`). Nothing is invented, and no quote is faked.
  - **Too few matches → top up** (`TOP_UP_TO` = 20): a tag with no description, or words nothing uses (`desktop`),
    found nothing to judge. When the keyword search yields fewer than 20, the newest other items (not tagged, not
    dismissed or open for it) fill the list up to 20, so Jev — the part that understands meaning — judges them.
    `CANDIDATE_CAP` stays 60 and the threshold 0.7. With nothing at all (an empty org) the run ends with
    `candidates = 0` and no call, and the row says "Nothing in this organization to check yet." The add row nudges
    for a description ("A one-line description helps find the right items"); it is never required.
  - **Live progress**: the run writes `candidates`, `calls`, `checked` and `added` on `org_tag_runs` AS IT GOES —
    one small UPDATE per answer (≤ 60), and each confident "fits" adds the tag the moment it is answered.
    `GET /api/o/:slug/tags/:name/run` (admins; `{ run: TagRunDTO | null }`) is the cheap read the Tags tab polls.
  - **Errors** (`jevClassifier`): a 422, a body that is not JSON, a bad answer, a timeout (10 s) or a network
    error → no judgement for that item, the run goes on; a 429 or 529 → one retry after 1.5 s, then the run stops;
    a 401 or any other status → the run stops (`failed`). Nothing surfaces to a person.
  - **Not confirmed from TypeSafe's docs** (so the client is conservative): a maximum number of questions per
    request, a maximum `state` size, rate limits and pricing are not documented. Hence one item and one question
    per request, at most 4 at once, and states of at most ~600 characters (title ≤ 200 + excerpt ≤ 400).
  - **Consent**: `org_ai_settings` (kind `tag.fit`), OFF by default, an admin's switch in Org settings › Tags
    (`PUT /api/o/:slug/tag-settings`, audited `ai.enable` / `ai.disable`). Off, or no `TYPESAFE_API_KEY` → nothing
    is sent (`startTagFit` answers `off` / `no_key`); turning it off mid-run stops the next call.
  - **What is sent** (to TypeSafe AI only): the tag's name and description (in the question and its criteria), and
    per item its title (≤ 200) and an excerpt of ≤ 400 characters (topped-up items alike) (`excerptOf`: code blocks, inline code, link targets, URLs, markup and anything shaped like
    a credential removed). Candidates are picked WITHOUT the model: the org's own FTS (`feed_fts`, `docs_fts` —
    live docs —, `adrs_fts` — not rejected) over the tag's name and description words, items that do not carry
    the tag and that no one has said no to (no dismissed, open, undone or removed row), newest first, at most 60,
    one request each. Every
    statement binds the org; another org's items are never read.
  - **Runs**: `org_tag_runs`, ONE running row per tag (`busy` otherwise; a row running for 15 minutes is let go).
    A run that is still going cannot be undone yet (409 `run_running`). `GET /tags` gives an admin `ai` (switch,
    key, allowance) and `runs` (per tag: its latest run).
  - **Agents' suggestions are separate and unchanged**: an AGENT's unknown tag (sent on a feed entry through the
    gate, `recordTagSuggestions`) still waits (`open`) for an admin to approve, map or dismiss it. They are drawn
    as suggested rows at the top of the tag list (`web-ui.md` › Tags).
  - Not built: the content-hash cache of #155, the per-kind test set and the rates in Platform of #158.
- Screens: `web-ui.md` › Tags.

**Entries written by Trov** (`FeedRow.ai?`, `shared/ai-core.ts` `AiFeedMeta`: `origin: "ai"`, the person it was
written for, its sources). An entry with no `ai` is an agent's — every entry today: nothing writes one yet, so
`/feed` and `get_feed` carry no `ai` in production. `LOCAL_AI_PREVIEW` merges two sample entries into `/feed`
by `created_at` (respecting `author` / `tags` / `since` / `limit`) under `wrangler dev` only, never over MCP
(`ai.md`).

## Read side — FTS5 query engine

`src/tools/reads.ts` exposes a ranked FTS5 `query()` engine (bm25, title/summary weighted) that backs
both MCP `query` and `GET /search`, over five types: `doc` / `decision` / `feed` / `sprint` / `artifact`
(`QueryType` in `shared/contract.ts`; `DEFAULT_QUERY_TYPES` is all five). Each
result is authority-flagged: `live` / `staged_pending` / `unpromoted` / `draft`. The doc/feed/ADR index
lives in `migrations/0008_fts.sql` (recreated in `0011_fts_recreate.sql`); `0013_roadmap_fts.sql` adds a
standalone `roadmap_fts` over the plan narrative + sprints (refs `plan` / `sprint:<id>`, re-keyed by
0025) so `query` surfaces the roadmap. An `artifact` result's id is its slug; candidates come from the
artifacts repository under the ONE visibility rule (a private page reaches only its author), and its authority
is `draft` for a draft, `live` once published or ratified. **A ticket is deliberately NOT a query type**:
`0024_tickets.sql`'s `tickets_fts` stays populated, but it backs quick search (below) and the Tickets screen,
never the `query` / `/search` fan-out — over MCP tickets are read with `list_tickets` / `get_ticket`.
`get_doc` is the exact-slug fetch (all versions + live body); `list_tickets` / `get_ticket` /
`ticket_badge` are the queue's read projections (no N+1 — grouped queries keyed by ticket id). The
assembled `sprint` body's `Progress: closed/total` line uses the SAME `sprintProgress` rule as the
Roadmap — the sprint's tickets only, never the GitHub issue cache.

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
`artOpen`, `openPrompt`, `openHandoff`, `goFeed`, a person → their person card (the role as the context line); a decision, which has
no screen, → the Search screen on its title).

- **MCP `query`** defaults `include_staged: true` — agents see staged/unpromoted context (authority-flagged).
- **`GET /search`** (human UI) defaults `include_staged: false` — shows only settled (`live`) content.

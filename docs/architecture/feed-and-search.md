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

## Tags — ONE list per organization (`0054_org_tags`, phase 1)

Each org has its own tag list (`org_tags`: `name`, a one-line `description`, a `color` from
`shared/tags-core.ts` `TAG_COLORS`, `starter`, `retired_at`, `merged_into`). It starts as the six STARTER tags
(`STARTER_TAGS` = the names of `shared/vocabulary.ts` `TAGS` and `0002_seed_vocab.sql`): 0054 seeded them for
the orgs that existed, `createOrg` (`src/orgs/repo.ts`) seeds them for a new one, and `tagRows` gives them to
an org that has NO row at all (one a pre-0054 Worker created). **Phase 1 puts tags on feed entries, docs and
decisions** (`entry_tags.entry_type` = `feed` / `doc` / `adr`; ids: the entry's number, the doc's slug, the
decision's number). Tickets, artifacts (`area`) and prompts (free-text tags) are untouched — phase 2.

- **Stored by NAME.** `entry_tags(org_id, tag, entry_type, entry_id)` holds the tag's name; 0054 rebuilt the
  table without its reference to the global `tags` table (which stays, unread: it names the starters) and
  added NO reference to `org_tags` — what may be stored is the gate's rule and `setItemTags`'s, so the Worker
  from before 0054 keeps working. A name is lowercase letters, digits and hyphens, ≤ 32 (`normalizeTagName`).
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
  decisions, newest 50 each, what it is seen with, who writes about it) and sets one item's tags
  (`POST /item-tags` `{ type, id, tags }` → `setItemTags`: an authored, direct write; each tag must be live or
  already on the item, at most 12). Reads answer 503 `{ error }` on failure, never a 500.
- **Agents** read the list with MCP **`list_tags`** (live tags + descriptions) and can only USE it.
  `get_feed` (MCP and HTTP) returns each entry's `tags`; `GET /doc/:slug` the doc's.
- Screens: `web-ui.md` › Tags.

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

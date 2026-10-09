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

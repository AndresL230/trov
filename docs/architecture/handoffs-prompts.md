# Handoffs and the Prompt Library

<!-- Moved verbatim out of CLAUDE.md (2026-10-07). This is the detailed reference; CLAUDE.md keeps only what applies to every change. Keep it current when you change the area. A reference to another section ("see Core invariant", "the Repo dashboard section below") now means another file in this folder — see the table at the bottom of CLAUDE.md. -->

## Handoffs & Prompt Library — direct writers, NOT the ingestion gate

Ported from the Claude Design project `2c8cfa50`: **Handoffs** (Workspace; `#handoffs`, `#handoffs/new`,
`#handoffs/<id>` — `web/src/handoffs.ts`), **Prompt Library** (Knowledge; `#prompts`, `#prompts/new`,
`#prompts/<slug>`, `#prompts/<slug>/edit|version` — `web/src/prompts.ts`), **Docs › New doc** (`#docs/new`) and
**Unplaced** (Triage; `#unplaced` — `web/src/maintenance.ts`, the screen id is still `maintenance`). It was the
tabbed Maintenance until 2026-10-06: Identity and People moved into Org settings › Members and the admin
email-notification sections into Org settings › Notifications; `#maintenance`, `#maintenance/identity` and
`#maintenance/people` still resolve (`web/src/hash.ts`).
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
  AUTHOR (case-insensitive) or an org ADMIN / owner; anyone else is 403 with nothing written. A deleted prompt is
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
- **The reading list (#167)** — "Read these first (not complete)". `claimHandoffWithReading` claims, then builds
  it with `handoffReadingList`: retrieval only, no model, no network, computed at the claim (a write path) and
  NOT stored, so nothing on a render path computes it and a reload of the handoff page does not show it again.
  `readingTerms` takes the handoff's own words (task and title at weight 2, then file-name stems, next, the rest
  of the body, done, the prompt's title; stop words, numbers and words under 3 letters dropped; ≤ 24); `query()`
  — the `query` / `/search` engine — runs ONCE PER KIND (doc, decision, feed, artifact; ≤ 8 each with full
  bodies), because bm25 from different FTS tables does not compare (a small table where every row holds a word
  scores ~0). The candidates are re-ranked together by which words they hold (weight × rarity among the
  candidates, double in the title, damped by length), an item holding fewer than two of the words is dropped,
  and the top 5 (`HANDOFF_READING_MAX`) are returned with an evidence line from Trov's own text. What the
  claimer could not see is never listed: `ctx` is the claim's org (another org's rows are not candidates), the
  claimer is `query()`'s `viewer` (a private artifact reaches only its author), and `include_staged: false`
  keeps it to settled content as `/search` does (no unpromoted doc, no draft decision or draft artifact). A
  handoff's own feed announcement (`HANDOFF_FEED_LINE`) is never listed. A list that throws is `null` and the
  claim stands. Surfaces: `POST /api/handoffs/:id/claim` answers `{ ok, handoff, reading_list }`
  (`HandoffClaimResult`, `shared/handoffs.ts`); MCP `claim_handoff` ends with `## Read these first (not
  complete)` (each item: kind, title, and `get_doc` / `artifact_get` slug, or the decision / feed number for
  `query`; an empty list draws no section, `null` says it could not be built); the handoff screen draws it
  under the body after its own claim (`readingListBlock`: a plain list, the kind as a word, the title as the
  same link `/search` uses — a decision is plain text; `state.handoffReading` holds it for that handoff only)
  and Copy as prompt appends it. An empty list draws nothing. Tests: `test/handoffs.reading-list.test.ts`
  (over the dev seed's fixtures — claiming #15 lists the Document Pipeline doc first) and
  `test/render.handoffs.test.ts`.
- **MCP** (every principal): `send_handoff`, `list_handoffs` (pending `me` + `anyone` by default; only `sent`
  shows claimed/expired), `get_handoff`, `claim_handoff` (returns one markdown block: prompt, `## Handoff
  summary`, `## Context`, then `## Read these first (not complete)` when anything matched), `expire_handoff`, `search_prompts`, `get_prompt` (fills `{{vars}}`, lists `unfilled`),
  `save_prompt` (always staged). There is no per-token rate limit in Trov today.
- Skills: `handoff`, `prompts`, and `load-context` (lists waiting handoffs at session start; never auto-claims).

## Agent links — a short-lived line between two sessions (0078_agent_links)

Spec: `docs/superpowers/specs/2026-10-17-agent-links.md` (its owner rulings override the text above them).
Built so far: the data and domain layer, and the MCP tools. The cookie routes, the Links tab, the plugin hooks and
Ask as a side are later phases.

- **Storage.** `agent_links` (a per-org `number` from `org_counters` `'link'` by the `agent_links_number_ai`
  trigger — 0078 rebuilt `org_counters` so its CHECK takes `'link'`; `createOrg` seeds it), and
  `agent_link_notes` (keyed to its link by `(org_id, link_number)`, with the `side` it was written FROM —
  stored, because a self-link's two sides are one person). Session columns end in `_agent_session` (Trov's own
  `ai_sessions` is something else). DTOs and the numbers: `shared/links.ts`.
- **Writers** (`src/tools/links.ts`): direct, like handoffs — no gate, no feed, no `routeAi`, nothing from
  `src/ai/`. Every transition is ONE conditional UPDATE, explained on a miss (404 / 403 / 409 / the cap).
  `requestLink` is an agent's DRAFT (its side bound, due in 1 h); `sendLink` (requester) makes it `requested`
  (24 h) — a self-link `open` at once; `acceptLink` / `declineLink` (recipient), `cancelLink` (requester, draft or
  requested), `closeLink` (either side, open only). `createRequestFromWeb` and `requestLinkFromAsk` (Ask's
  Confirm, the thread bound as `ask-thread-<id>`) create it already sent. An open link lasts 7 days.
- **Joining** binds the caller's own side (re-join overwrites). On a self-link: the side this session is on,
  else the one with no session (recipient first), else `side` must say; one session never holds both.
- **`via`** (`mcp` | `ask` | `web`): over MCP a session starting `ask-thread-` is refused; Ask binds only that;
  the web binds none. MCP never calls the person steps.
- **Notes**: from the side the session is bound to (an unbound session is refused), or a person's own side on
  the page (a self-link's: `side`, default requester). Caps for every author: 1,000 characters, 20 per side per
  link (re-checked in the INSERT), and `LIMITS.link_note` (60 / person / hour).
- **The inbox** (`readInbox`): notes from the OTHER side, on open links whose caller's side is bound to the
  session, at most 5 per read, oldest first, the rest counted. One statement when nothing waits (it stamps the
  side's `*_seen_at` and counts in its RETURNING); delivery is one `UPDATE … WHERE delivered_at IS NULL …
  RETURNING`, so each note goes once. `formatInbox` fences each note with a nonce fresh per delivery;
  `inboxHookOutput` wraps it as hook JSON (≤ 10,000 characters).
- **The 5-link cap** counts the links a person SENT that are requested or open, plus the ones sent to them that
  they accepted: a request waiting for someone does not fill their allowance; it is checked at their accept.
- **Expiry**: `expireDueLinks` (`src/platform/sweeps.ts`) every repo-cron tick — past `expires_at`, or open with
  no sign from either side (`decided_at`, `*_seen_at`) for 12 h. Deleting an account cancels or closes the
  person's live links (`src/deletion/person.ts`).
- **Over MCP** (`src/mcp.ts`), as the bearer's person, `via: "mcp"`. Five org tools: `request_link` (a DRAFT,
  returns `{ id, url, state }` — the person sends it from the url), `join_link` (an OPEN link only), `send_link_note`,
  `close_link`, and `list_links` (the four live boxes, for `load-context`; each side says whether it has joined, and
  carries its session id only when it is the caller's own side). There is NO tool for send, accept, decline or
  cancel. Each refuses an `ask-thread-` session (`bad_request`); `LinkError` codes travel like `HandoffError`'s, with
  hints for `not_member` and `limit` (`retry_after` on the hourly note limit).
- **`link_inbox`** is a CONNECTION tool (`{ session, event? }`, no `repo` / `org`): it finds its org by session
  (`resolveLinkSession`, `data-layer.md` › Bearer — CLAUDE.md invariant 4), then `readInbox`. With `event` (a hook)
  it answers `inboxHookOutput` JSON, or `""`; without, the fenced text, or "No new notes on Trov links for this
  session." The empty path (no org, an `ask-thread-` session, nothing waiting) is never `isError` and writes no
  usage row; only a delivery runs `meterMcpTool`. Measured locally (wrangler dev, pasted token, unknown session):
  ~11 ms median, ~15 ms p95 — about 2 ms over `get_connection`.
- The server instructions (`mcpInstructions`) say a session that has joined a link calls `link_inbox` at the start of
  each reply — how a `chat` side checks without hooks. Site group: "Links" (`shared/mcp-tools-core.ts`), all six.
  Ask excludes all six for now (`ASK_EXCLUDED_TOOLS`).
- Tests: `test/links.test.ts`, `test/links.migration.test.ts`, `test/mcp.links.test.ts` (the tools and
  `link_inbox`'s resolution in every connection mode, through the real `/mcp`), and the six tools' rows in
  `test/isolation.mcp.test.ts` (another org's link, person and session reach nothing).

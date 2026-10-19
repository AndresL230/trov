# Handoffs and the Prompt Library

<!-- Moved verbatim out of CLAUDE.md (2026-10-07). This is the detailed reference; CLAUDE.md keeps only what applies to every change. Keep it current when you change the area. A reference to another section ("see Core invariant", "the Repo dashboard section below") now means another file in this folder — see the table at the bottom of CLAUDE.md. -->

## Handoffs & Prompt Library — direct writers, NOT the ingestion gate

Ported from the Claude Design project `2c8cfa50`: **Handoffs** (Workspace; `#handoffs`, `#handoffs/new`,
`#handoffs/<id>` — `web/src/handoffs.ts`), **Prompt Library** (Knowledge; `#prompts`, `#prompts/new`,
`#prompts/<slug>`, `#prompts/<slug>/edit|version` — `web/src/prompts.ts`), **Docs › New doc** (`#docs/new`) and
**Unplaced** (Review's other view; `#review/unplaced` — `web/src/maintenance.ts`; the screen is `review`, the view
`state.reviewView`). It was the tabbed Maintenance until 2026-10-06: Identity and People moved into Org settings ›
Members and the admin email-notification sections into Org settings › Notifications; `#unplaced`, `#maintenance`,
`#maintenance/unplaced` (→ `#review/unplaced`), `#maintenance/identity` and `#maintenance/people` (→ Org settings ›
Members) still resolve (`web/src/hash.ts`).

**Unplaced since 2026-10-18** ("refuse or stage", `ingestion-gate.md`): the gate no longer sends anything here — it
refuses a doc it cannot place (naming what is valid) and stages what an agent was unsure of, flagged — so the queue
holds what came before, and what a plugin older than 0.11 still sends as a batch's own `needs_triage`. The screen is
laid out like Review (`web/src/maintenance.ts`): ONE two-pane frame (`.cnpy-rv`; the panes take turns on a phone, back
with "All items"), the queue a keyed list of Review's surface cards (title, the Low confidence mark when it was sent
unsure, two lines, then the author's avatar · what it is · why it is here, in a few words (`unplacedReasonWord`; the
verbatim reason in its tooltip and on the item) · when), and the item in Review's page pane: "‹i› of ‹N› unplaced",
the title, what it is, who and when, a "Why it wasn't placed" card, Trov's suggestion, the item itself (a doc through
the reader's renderer, a decision's parts, a feed entry's or a note's text), then **Place it as** — the kind, a doc's
section and space as `segmented()` switches (the Space a `dropdown()` past four spaces), a feed entry's tags as
toggles — and the footer with what Place will do, Discard and Place. The picks START from what the agent sent when it
is valid (`effectivePicks`: its kind, a vocabulary section, a live space, else the default space), so a well-formed
item is one press away, and main.ts files exactly what the hint says. A note (free text) cannot be placed: it says
so and offers Discard only. Place and Discard are optimistic and leave by the app's one row exit (`web-ui.md` › A
row leaving a list); a refusal (`could not place doc: …`, the gate's words) brings the card and the picks back.
Discard has no arm step — the toast's Undo restores the item (`POST /needs-triage/:id/restore`). Tests:
`test/render.unplaced.test.ts`, `test/triage-writeback.test.ts`.
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
- **A library card's copy button** (top left, `promptCopySlug`) puts the PLAIN slug on the clipboard — what
  `get_prompt` and the `prompts` skill take — and toasts "Slug copied · <slug>". The card is a `hitArea` card; the
  copy button is a sibling of the hit (never inside a button) lifted above it by `cnpy-hitctl`, so its click copies
  and never opens the prompt. Copying a slug is not a use (no `/used` bump; the agent's `get_prompt` counts it).
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
- **A prompt by upload (`0076_10_17_staging` › `0080_handoff_upload_tokens`).** Typing a long prompt into the tool call costs the agent
  thousands of output tokens — that writing, not Trov, was the whole delay of a big handoff. So MCP
  `send_handoff`'s `prompt` takes either `{ title, body }` (inline, as before) or `{ title, sha256, size_bytes }`
  (UTF-8 text, at most `HANDOFF_BODY_MAX`; both forms at once, or neither, is a `bad_request`). The upload form
  writes NO handoff: `mintHandoffUpload` checks what a create would (the recipient included) and stores the WHOLE
  pending handoff — sender (the bearer principal), recipient, body, context, the prompt's title, the declared
  sha256 + size, the session ledger key and the org's link base — on a single-use token (`handoff_upload_tokens`,
  only the token's SHA-256 stored, the artifact uploads' 5-minute TTL), answering `{ upload_url, expires_at }`.
  A session item that already made its handoff answers `{ id, url, replayed: true }` instead and mints nothing.
  The PUT is the artifact route, `PUT /api/artifacts/upload/<token>` (`src/artifacts/upload.ts` tries doc-image
  tokens, then handoff tokens, then artifact ones), so there is no new unauthenticated route (CLAUDE.md
  invariant 8). `consumeHandoffUploadToken`, in order: used or expired → 410 `gone`; a body over the cap → 413;
  a length or SHA-256 that is not the declared one, or bytes that are not UTF-8 → 400 — none of these touch the
  token, so it stays usable within its TTL; then ONE conditional UPDATE claims it (a racing second PUT is 410),
  the sender must still be a member of the org (else the unknown-token 404), and `createHandoff` runs as the
  sender with the token's ledger key — the feed line, `routeAi` and the replay ledger exactly as an inline send —
  answering `{ id, url }`. A create that fails releases the claim. Why create on the PUT instead of inserting
  first and filling in later: a half-made handoff would show in inboxes and badges; this way nothing is visible
  until it is complete. Every statement binds the token's org (`uploadTokenOrg` → that org's system tenant), so a
  token can only ever create a handoff where it was minted. The repo cron's every-tick sweep
  (`pruneHandoffUploadTokens`) deletes tokens whose window has closed, used or not (each holds a pending
  handoff's text); a used one is kept until then, so a repeated PUT still answers 410. Deleting an account
  deletes its tokens; the table is in `ORG_TABLES`, `principal` / `recipient` in `HANDLE_COLUMNS`. **Ask has no
  shell and never mints one**: its `send_handoff` input takes the prompt inline only (a strict object — the
  upload keys are refused with `ASK_NO_PROMPT_UPLOAD`, never dropped) and the schema Ask offers the model is
  narrowed to `{ title, body }` (`ASK_NARROWED_ARGS`, `src/ai/ask/tools.ts`). The `handoff` skill uploads a
  prompt over about 2 KB when it has a shell and reports `#N` only after the PUT answers. Tests:
  `test/handoffs.upload.test.ts`.
- **MCP** (every principal): `send_handoff` (inline or upload form, above), `list_handoffs` (pending `me` + `anyone` by default; only `sent`
  shows claimed/expired), `get_handoff`, `claim_handoff` (returns one markdown block: prompt, `## Handoff
  summary`, `## Context`, then `## Read these first (not complete)` when anything matched), `expire_handoff`, `search_prompts`, `get_prompt` (fills `{{vars}}`, lists `unfilled`),
  `save_prompt` (always staged). There is no per-token rate limit in Trov today.
- Skills: `handoff`, `prompts`, and `load-context` (lists waiting handoffs and live links at session start; never
  auto-claims). Links have their own skill, `link` (below).

## Agent links — a short-lived line between two sessions (0076_10_17_staging › 0078_agent_links)

Spec: `docs/superpowers/specs/2026-10-17-agent-links.md` (its owner rulings override the text above them).
Built: the data and domain layer, the MCP tools, the cookie routes and badge, the Links tab and a link's page, the
plugin's `link` skill and its hooks, and an Ask thread as a side (`ask.md` › Agent links).

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
- **Cookie routes** (`tenantApi`, `src/routes.ts`, beside the handoffs; `/api/links…` and `/api/o/<slug>/links…`) —
  the ONLY place a link is sent, accepted, declined or cancelled (besides Ask's Confirm). The actor is always the
  session's person; a body's author fields are never read. `:id` is the per-org number.
  `GET /links?box=waiting|mine|open|unbound|closed` (default `open`; another box is 400) → `{ links }`, each with
  `preview: { last: { side, author, author_kind, excerpt, created_at } | null, notes, waiting }` (`linkPreviews`: ONE
  windowed query for the listed links; `waiting` = undelivered notes from the other side, either side on a self-link;
  the excerpt is the newest note's first line cut to `LINK_EXCERPT_MAX`; a handle and a kind, never a session id; if
  it fails the list still answers without `preview`, never a 500);
  `GET /links/:id` → `{ link }` with its notes, 404 `not_found` for anyone but its two people; every answer is
  `linkForViewer`'s: the OTHER side's `session` is null (its kind, branch and seen stay), as on MCP and in Ask;
  `POST /links` `{ target, reason?, repo? }` → `{ link }` (`createRequestFromWeb`: `requested`, or `open` to oneself);
  `POST /links/:id/send|accept|decline|cancel` and `/close` `{ reason? }` → `{ link }`;
  `POST /links/:id/notes` `{ body, side? }` → `{ link }` with its notes (a person's note, own side, no session —
  the same caps, `link_note` taken on `c.var.p`). A `LinkError` is `{ error: <code>, message }` at
  `LINK_ERROR_STATUS` (a 429 from the hourly allowance adds `retry_after` and `retry-after`); anything else is
  503 `{ error, degraded: true }`, never a 500. No role check: any member, as with handoffs.
- **Badge.** `GET /badges` carries `links`: requests waiting for me (= `GET /links?box=waiting`'s length; a self-link
  never waits). `handoffs` stays handoffs only; the web adds the two for the Relay badge.
- **`link_inbox`** is a CONNECTION tool (`{ session, event? }`, no `repo` / `org`): it finds its org by session
  (`resolveLinkSession`, `data-layer.md` › Bearer — CLAUDE.md invariant 4), then `readInbox`. With `event` (a hook)
  it answers `inboxHookOutput` JSON, or `""`; without, the fenced text, or "No new notes on Trov links for this
  session." The empty path (no org, an `ask-thread-` session, nothing waiting) is never `isError` and writes no
  usage row; only a delivery runs `meterMcpTool`. Measured locally (wrangler dev, pasted token, unknown session):
  ~11 ms median, ~15 ms p95 — about 2 ms over `get_connection`.
- The server instructions (`mcpInstructions`) say a session that has joined a link calls `link_inbox` at the start of
  each reply — how a `chat` side checks without hooks. Site group: "Links" (`shared/mcp-tools-core.ts`), all six.
- **Ask as a side** (`ask.md` › Agent links): `request_link`, `join_link`, `send_link_note` and `close_link` are
  Ask write cards — Confirm-only, never Auto, run as the CONFIRMER — and `list_links` a read; only `link_inbox` is in
  `ASK_EXCLUDED_TOOLS` ("Ask reads link notes in its own turn"). The thread's session is `ask-thread-<thread id>`
  (kind `ask`, no branch), the id Ask claims handoffs with; only the LINK tools refuse that prefix over MCP, so
  `claim_handoff` with it still works. Confirming `request_link` is the Send (`requestLinkFromAsk`: `requested`, or
  `open` to oneself; no draft; `previewLinkRequest` builds the card and refuses a target or a cap bound to fail).
  A turn delivers the thread's waiting notes once (`readInbox`, fenced in the turn); the thread list and the thread
  read count them in one query (`askThreadLinkNotes`). Deleting the thread unbinds its side (session, kind and branch
  go null; the link stays — `src/deletion/ask.ts` `unbindLinkSides`).
- **The plugin** (0.10.0): the `link` skill (`plugins/trov/skills/link/SKILL.md`) carries the hooks in its OWN
  frontmatter (owner ruling 6), not a plugin-wide `hooks/hooks.json`: `UserPromptSubmit`, and `PostToolUse` on
  `Bash` with `if` `Bash(git commit*)` / `Bash(git push*)`, each an `mcp_tool` call to `plugin:trov:trov` /
  `link_inbox` with `{ session: "${session_id}", event: "${hook_event_name}" }`, timeout 5. Skill hooks register
  when the skill is first invoked and last the session, so only a session that requests or joins a link ever
  calls `link_inbox` (and only it would see a hook error when the server is not signed in); `/clear` drops them,
  so the person says "join link N" again. The skill is model-invocable on purpose (no
  `disable-model-invocation`): a spoken "join link 12" must load it for the hooks to register; every write in
  it still waits for the person's word. It covers noticing (the Repo overview's `state.inFlight` + facts, then
  `git diff --name-only origin/<default>...HEAD` against open PRs and local branches / worktrees), asking,
  drafting (`kind: "code"`, the session from `$CLAUDE_CODE_SESSION_ID`), joining, notes, closing, and the chat
  case (its own short id, `kind: "chat"`, `link_inbox` at the start of each reply). `load-context` step 10 calls
  `list_links` beside `list_handoffs` and never joins or requests. Public docs: Concepts › Agent links
  (`web/src/docs-content.ts`, numbers from `shared/links.ts`) and a line in Connect's chat section; llms.txt's
  intro. `test/plugin.skills.test.ts` holds the hooks' shape and where they live.
- Tests: `test/links.test.ts`, `test/links.migration.test.ts`, `test/mcp.links.test.ts` (the tools and
  `link_inbox`'s resolution in every connection mode, through the real `/mcp`), and the six tools' rows in
  `test/isolation.mcp.test.ts` (another org's link, person and session reach nothing).

### Web (Relay › Overview, `web/src/relay.ts`)

- **The landing page** (`#relay`, screen `relay`; the sidebar's Relay opens it, `goRelay`): one sentence on what
  Relay is (`RELAY_LEAD`), then two cards balanced on their middle — **Handoffs** and **Links** — each a drawing in a
  tinted band (a note waiting between two sessions; a line whose dots flow, still under reduced motion), its name
  and what it is, two counts side by side (`relayCounts`: handoffs waiting for me — My Work's `handoffsForMe` — and
  sent but not picked up; link requests asking me and OPEN links), then New handoff / Start a link at the left and
  "Open … →" at the right. The whole card is a `hitArea` (`goHandoffs` / `goLinks`); the New button sits above it.
  A count whose read is out is "—", never 0.
- **Your connections**: the person's OAuth connections that act in this org (`grantsHere`: manual ones listing it,
  or repo-following ones), their access tokens for it, then Ask Trov (on / off for the org / not set up on this
  server, from `GET /ask/state`), each with when it was last used; none → "Connect an agent" (Settings). Reads:
  `loadRelay` in main.ts — handoffs, links, grants, tokens and Ask's state, the same routes Settings › MCP access
  and Ask use. Test: `test/render.relay.test.ts`.

### Web (Relay › Links, `web/src/links.ts`)

- **Where.** Relay has NO tab bar (the owner's call, 2026-10-18): the sidebar's Relay opens its Overview, and
  Handoffs and Links are its pages, each a child screen ("Relay › Links", the title a back button to `#relay`).
  Routes `#links` (screen `links`) and `#links/<n>` (screen `link`), NOT under `#handoffs/` (whose second segment is a
  handoff's number); a link's page is a child of Links (crumb "Link #12", back to Links).
- **The tab** reads four boxes at once (`GET /links?box=waiting|open|mine|closed`). The story (owner, 2026-10-17)
  is linking YOUR OWN sessions — a coding agent, a web chat, an Ask thread; a teammate's session is the second case.
  It opens on **the arc diagram** (`linksHero`, `heroModel`): one STATION per client kind you have on a live link —
  Claude Code, Web chat, Ask thread, left to right (`STATION_X`), every session of that kind folded in (its card
  lists each branch / thread and the links it holds; "Claude Code · 2" only when > 1; the Ask station opens the
  thread when there is one, else Ask) — on a gentle dotted line that starts at your photo on the left. A link
  between two of your JOINED sessions is an arc ABOVE the line between their stations (one per pair of kinds,
  denser for more links; a small loop over a station when both sides are the same kind). A side of yours no
  session has joined draws nothing: that link is only in the rows, with its join hint. Teammates sit BELOW the line,
  one orb per person, a quieter arc dropping to them from the station that holds the link (from your photo when your
  side has no session); a request waiting for you pulses up toward you, its Accept / Decline in a callout under the
  picture ("Luke asks to link with you"). Words sit under stations and persons, off every arc. One canvas
  (`link-line.ts` `linkHeroCanvas`: orbs, segments with a shape — `u` over, `d` down, `o` loop — and the line, as
  data attributes; the shared orb loop); over it each station and person is a real `<a>` with an aria-label and a
  hover / focus card. Past six people, "+N more". No live link: your photo in a quiet halo, `LINKS_LEAD` and "Link
  two of your sessions". A phone shows the same diagram compressed, stations by icon alone. Under it
  `LINKS_LEAD`, then the live links as CARDS (`linkCard`, a grid of at most three across, two when narrower, one on
  a phone; order `liveCardOrder`: waiting for you, open by newest activity, then your requests and drafts). Every
  card is the SAME compact shape (~160 px), five one-line rows always in the same places, each kept when empty: the
  two sides as clients on a slim strip (icon + "Claude Code `branch`", a teammate's photo and client, "not joined";
  a dotted connector, full only while open; the full text in its title), #n · the topic · the mark · when, the
  reason, the newest note (who, excerpt, when) with "N new" at the right — or "No notes yet" / "Notes start once
  it's open" — and a footer pinned to the bottom: "join #n" with Copy / Open-in-Ask icon buttons when a side of
  yours has no session, and the steps at the right (Accept / Decline on a waiting card, which has an accent border
  and reads "Luke asks to link with you"; Close; Cancel request through confirmModal, `state.linkCancelId`; Send /
  Cancel on a draft). No canvas on a card — the diagram carries the motion. The
  card is a `hitArea`; its buttons sit above it. Then the PAST links, always shown (`pastRow`, latest
  `LINKS_PAST_SHOWN` with "Show all N", `state.linksPastAll`): a dim glyph, the topic, the reason, how it ended in
  words (`linkEndWords`: "Closed by you: Both merged", "Declined by Jose", "Cancelled by you", "Expired after 12 h
  idle", "Expired: not answered in 24 h", "Expired: never sent"), when, and its note count. A link about a person
  reads "With Luke" in the history, "Link with Luke" on its page (`linkAboutHtml`).
- **Start a link** (`linkStartCard`): the header's "Start a link" (`linkStartOpen`) opens a card in a stable slot at
  the top of the tab (the tab is `data-morph="links"`, so typing never rebuilds it). A `segmented()` picks who it is
  between: **Between my sessions** (the default: target = yourself, opens at once; two client orbs) or **With a
  teammate** (About: Person / Pull request / Branch / Ticket — a pick chip, a number, a branch). Why is the reason —
  OPTIONAL (the owner's ruling, 2026-10-18: left out or blank it is stored as "" and a card reads "No reason given",
  a past row and a link's page show none; ≤ 280, counted, "Optional · n / 280"). Send → `POST /links` (`startLink`, `{ target, reason }`); the answer waits ~1.1 s for the particles
  to cross (not under reduced motion). A link between your sessions then says how each client joins: Claude Code or a
  chat — "join Trov link #n" with Copy; Ask — "Open in Ask" (`linkJoinAsk`: a new thread with the phrase typed in its
  composer; the person sends it; also on a link page's join hint). A teammate request says "Sent to X. They accept
  it in Relay…". A refusal is said in place (`linkStartRefusal`), never a toast.
- **The link line** (`web/src/link-line.ts`): two orbs and the particles between them on ONE canvas — the
  requester's on the left, the recipient's on the right — at the head of a link's page and in the start card. It
  paints on the thinking orb's loop and clock (`thinking-orb.ts` `addOrbPainter`, one rAF loop for the page),
  in the theme's `--accent` only; the canvas is `aria-hidden` and sized in the template (`data-ll-*` attributes
  carry its mode, so a morph keeps it and its particles); a line with nothing moving is painted once and asks
  for no frames; off-screen it is skipped; reduced motion is one still frame. By state (`linkLineState`):
  draft = a flicker on the requester's side, recipient asleep; requested = a slow one-way trickle to a
  "listening" orb; open = flowing both ways, a side with no session a hollow ring that sends little; a new note
  = a pulse from its author's side (the far orb flares as it lands); declined / cancelled / expired / closed =
  stopped, both orbs dim. The start card: you are awake (your photo inside); theirs is asleep, then their photo
  in a bright ring (a person) or Trov's searching globe (a PR, branch or ticket), the stream reaching further as
  the card fills in; Send is a burst, and their orb lights; a refusal dims both. The words under the orbs and
  the state's mark carry every meaning — the line is never the only place a state is said.
- **A link's page**: topic and reason; the link line with each side in words under its orb (a self-link's two
  name its two sessions): the person and the session — "coding session on `branch`", "web chat" (with "a web chat checks for
  notes when you ask it to": that claude.ai polls on its own is not verified), "Ask thread" (a link to `#ask/<id>` on the viewer's OWN side
  only), or "waiting for a session". The notes thread says who wrote each ("@jose's agent", "@jose's Ask
  thread", "@jose"); bodies are text, never markup. A composer (1,000 characters, counted) for the viewer's own
  side, only while the link is open; on a self-link a `segmented()` "Write as" switch picks which of the two
  sessions the note is from (`side` on `POST /links/:id/notes`, default the requester's). An open link whose viewer side has no session shows "Tell your agent: join
  Trov link #12" with a Copy button.
- **Steps** (`linkActionsFor`, the one rule the buttons read; the server re-checks): requester on a draft → Send
  request, Cancel (at once); requester on a request → Cancel request, through `confirmModal`
  (`linkCancelModal`); recipient on a request → Accept, Decline (at once); either side on an open link → Close.
  Nothing on an ended link, nothing for anyone else. A step re-reads the page and the tab; a refusal's `message`
  is shown in the toast (`ApiError.detail`).
- **States** are `LINK_MARK` / `linkMark` in `marks.ts`: nothing for `open` (the normal state), a ring for a
  draft or a request, a check for closed, a square for declined, cancelled and expired, each with a `data-mtip`.
- **The page is `data-morph`ed** (`link:<n>`): the count under the composer rerenders per keystroke without
  rebuilding the page, so the box keeps its focus and caret.
- **The badge.** The sidebar's Handoffs count is `handoffOnlyBadge + linkBadge` (`render.ts`): pending handoffs for
  me (`handoffsForMe`, which My Work also counts — links stay out of it) plus link requests waiting for me (the
  Waiting box once loaded, else `GET /badges` `links`). `loadLinks` writes `listed("links", …)`.
- Tests: `test/render.links.test.ts` (each state as each viewer, each side kind, a self-link, the note authors,
  the join hint, the routes, the badge sum, the line per state, the start card and its refusals, the constellation and the rows).

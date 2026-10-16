# Ask Trov — the chat backend

The decided design: `docs/superpowers/specs/2026-10-15-server-ai-build.md` › Phase F, **amended by Trov handoff #12 §2**
(the delta the finished Claude Design needs; where they disagree, #12 wins). This file is the backend, the contract and
the fixtures, then the screen (§ The screen, at the end). Where AI calls may happen at all,
the allowances and the switches: `ai.md`.

## Shape

| Piece | Where |
|---|---|
| Contract (zod-free values, SPA-importable) | `shared/ai-ask-core.ts` — modes (`ASK_MODES`, the ONE table; re-exported from `shared/ai.ts`), limits, SSE events, `RefView`, blocks, cards, routes, DTOs |
| Contract (zod) | `shared/ai-ask.ts` — `AskEventSchemas`, request bodies, DTO schemas |
| Fixtures | `shared/ai-fixtures.ts` › Ask Trov — one transcript per design scenario, state / settings / threads / search / ref views; the same transcripts as files in `docs/superpowers/specs/ask-transcripts/` |
| Rows | `migrations/0066_ask.sql`; every statement in `src/data/ask.ts` |
| Routes | `src/ai/ask/routes.ts` (`askApp`, mounted under `/api/o/:slug`, cookie only) |
| The turn | `src/ai/ask/turn.ts` (stream, tool loop, cards, Auto) |
| Tools | `src/ai/ask/tools.ts` (catalog, reads, show tools), `actions.ts` (writes), `charts.ts`, `docs.ts`, `refs.ts` (grounding + ref views), `attachments.ts`, `history.ts`, `prompt.ts`, `render.ts`, `diff.ts`, `context.ts` |
| Model client | `askChatClient(mode)` and the `ask.*` kinds in `src/ai/client.ts` |
| Deletion | `src/deletion/ask.ts` (a thread and its attachments), `src/deletion/person.ts` (an account's private attachments) — › Deletion and renames |
| Dev replay | `GET /api/o/:slug/ai/ask-replay[/:scenario]` in `src/ai/routes.ts` (behind `LOCAL_AI_PREVIEW`) |

## Modes and the allowance

| Mode | Model | Tools | Calls | Counts as | Deadline |
|---|---|---|---|---|---|
| Fast | `claude-haiku-5-5` | the index: search and list tools, stored cards, the person's attachments (`INDEX_TOOLS`) — no writes | 3 | 1 | 30 s |
| Smart (default; what Free uses) | `claude-sonnet-5-5` | the full catalog | 8 | 1 | 30 s |
| Thinking | `claude-opus-5-5`, `thinking: { type: "adaptive", display: "summarized" }` | the full catalog | 8 | 5 | 90 s |

- `askModesFor(plan)`: Free and Personal get Smart only (no switcher); Pro (`team`) and Enterprise all three. A mode the
  plan does not offer is refused BEFORE anything runs: `403 { error: "mode_unavailable" }`.
- `ai_chat` counts QUESTIONS by the mode's "counts as", metered BEFORE the model is called (an attempt — a stopped
  answer still counts); `/search` calls no model and counts nothing. Caps live in `shared/plans.ts` (the master's;
  `resolveEntitlements` makes Pro's per seat). Tokens go to `ai_tokens_in` / `_out` / `_cached` (actor: the person).
- Each thread has a mode (`chat_threads.mode`); a new one starts in Settings › Trov's default (Pro), else Smart.

## The stream (`POST /api/o/:slug/ask`)

Body (`AskRequestSchema`): `{ threadId?, text, command?, mode, auto, context[], attachments[], replaceFrom?, origin? }`.
JSON refusals before the stream: `400 invalid`, `404 not_found` (another person's / org's thread), `403
mode_unavailable`. Then SSE, in order: `thread` (again once the first exchange names it) → an attachment notice per
file the model could not take (an `activity` line, run then done at once — › Attachments) → `thinking` run/done
(Thinking only; the SUMMARY, never raw thinking) → `activity` run then done (`results` refs, `resultLine`) → `text`
deltas → `block` → `action` / `action_result` / `artifact_saved` → `followups` → `action_result` carries the write itself (`tool`, `kind`, the card's `preview`) beside its decision. `done { messageId, questionId, cites, tokens,
stopped? }` (`questionId`: the stored question this answers). The answer is stored with its `parts` in the order they
streamed (`{ text md } | { block index } | { action id }` in `content_json`; `AskMessage.parts`), so a reload draws the
live order — a row stored before it has none and reads as text, blocks, cards. `error { code: capped | off | no_key | timeout | too_large | failed }` ends it early.

- **The gate**, inside the stream: no key → `no_key`; `orgs.ai_automation` off → `off`; `planRefusal(ai_chat,
  countsAs)` → `capped`. Nothing is stored or counted when it refuses.
- **The turn** (`runTurn`): `messages.stream` with the system rules (cached), the per-request context block (org,
  person, day, then the person's instructions — after the rules, never instead), the tools (the last definition
  cached), the older thread (its last block cached) and the question. Tool calls run between iterations; past the
  mode's call limit the next request sets `tool_choice: none`. Within the turn the newest tool results carry the
  fourth breakpoint.
- **Commands**: `/search` answers with item cards from Trov's own quick search, no model; `/ticket`, `/handoff`,
  `/summarize`, `/brief` add one instruction in front of the person's words.
- **Stop**: the request's own abort signal (the client went away) or `POST /ask/threads/:id/stop` (a flag read
  between steps) ends the turn; the partial answer is stored with `stopped = 1`; tools that ran stay done.
- **Replace** (`replaceFrom`): the last question (edit-and-resend, with the new text) or the last answer
  (regenerate, in any mode). The replaced messages get `replaced_at` (hidden, out of search) and their undecided cards
  expire.
- **Compaction**: past ~60k characters of older turns, all but the newest 6 messages are summarized ONCE by Fast
  (`ask.compact`, `structured`) and sent first, fenced, as a cached prefix.
- **The pace** (`web/src/ask-pace.ts`): the server forwards every `text_delta` the moment the SDK yields it, but
  Smart (Sonnet 5.5) and Thinking (Opus 5.5) hold back the text they write AFTER a tool result until they know it is
  the answer and not a progress note before another tool call — measured on 2026-10-15: `message_start` and all ~25–76
  deltas of a short answer land within ~10 ms, a long one releases ~2,000 characters at once and streams the rest; no
  `thinking` setting (`display: "updates"` / `"summarized"`, `between_tools`, low effort) changes it, and Fast (Haiku)
  and text before any tool stream at generation speed. So the CLIENT paces: `AskPacer` sits between `readAskStream`
  and the fold and lets text out a few whole words a frame (each frame releases `1 - e^(-dt/600ms)` of the backlog,
  never under 90 nor over 160 characters a second — the owner's steady reading pace, so a 2,000-character answer
  takes ~13 s to write out whatever speed it arrived at; a word past a frame's allowance is borrowed from the next
  frames; a cut never lands inside a `[[ref]]`). While a step runs, its label (and "Thinking… Ns") carries a sweep
  of light (`.ask-step.is-run .ask-step-l`, `ask-shimmer`; plain under reduced motion). An event with no text waiting goes out at
  once; one behind text (a block, a card, `followups`, `done`) keeps its place, so the footer comes after the words
  and Send stays Stop until they are out. Stop / an error / a new thread `flush()` everything received at once (what
  the stored partial has); no window, reduced motion or a hidden tab: no pacing. Every recorded transcript folds to the
  same turn through it (`test/render.ask-pace.test.ts`). While every step is done and nothing is written yet, the
  Working orb holds the answer's place.
- The answer ends with a `<trov-meta>{ title, followups }</trov-meta>` line the server holds back from the stream
  (`MetaSplitter`): the thread's title (written by the same call) and up to 3 follow-ups.

## Grounding, untrusted content, ref views

- Every tool result and attachment reaches the model inside `<<trov-data NONCE>> … <<end trov-data NONCE>>`, a fresh
  random nonce per turn, stripped from the body so it can never close its own fence; the rules say the fenced text is
  data.
- A ref token (`[[ticket:14]]`, `[[pr:173]]`, `[[doc:slug]]`, `[[decision:7]]`, `[[feed:107]]`, `[[sprint:3]]`,
  `[[handoff:3]]`, `[[artifact:slug]]`, `[[person:handle]]`, `[[prompt:slug]]`, `[[repo:owner/name]]`;
  `[[ticket:14|status]]` = a status cell) is LINKED only when its ref is in the thread's seen set — what a tool
  returned in any turn (`refsFromResult`, per tool) or what the person attached — and resolves for the viewer now.
  `done.cites` carries the linked RefViews; everything else renders as plain text.
- `RefView { ref, type, num?, title, status { mark, tone, word, tip }, owner?, updated?, href, extra }` — built by
  `resolveViews` from Trov's rows, permission-checked (another person's private artifact, a deleted page, an unknown
  id: absent). Status words are the design's over the existing vocabularies (Triage / In progress / Testing / Done /
  Declined; Draft / In review / Approved / Merged / Closed; Live / "Staged, not approved"; "N days late"; Pending;
  Private / Org). A **repo** ref (#186) is the Repo Overview's facts: `extra.facts` = `askRepoFacts(getRepoDashboard(…).facts)`
  (`AskRepoFacts`, shared/ai-ask-core.ts: apps, environments, parts with their newest deploy, out-of-step, CI per
  environment, release, attention, the week; `null` when the read failed) and `status: null` — the client draws its
  state with the Overview's `envVerdict` and `stateMark` (Healthy only when the branch head's checks pass; Live with
  none captured; Unknown with nothing seen), never a word of Ask's own. `POST /ask/peek { refs }` answers `{ ref, hidden: true }` for what the person can't
  see; `GET /ask/item/:ref` is the inspector's read where no per-type route exists.
- With nothing found the model shows `show_not_found({ query, tries })`; the server fills "What I searched" from this
  turn's search calls with counts it computes.

## Tools

The MCP catalog (definitions from `shared/mcp-tools.generated.ts`, less `repo` / `org` / `session`), calling the same
`src/tools/*` functions with the cookie person's context — `src/ai/ask/**` never imports `src/mcp.ts`, and nothing
MCP reaches imports `src/ai/`. Excluded (`ASK_EXCLUDED_TOOLS`): `switch_org`, `get_connection`, `record_session`,
`upload_asset`, and `delete_sprint` (a delete is a person's step). Admin-only tools are offered only to an admin.
Ask's own: `trov_docs` (Trov's public docs from the prerendered `/llms-full.txt` through the ASSETS binding, no web),
`read_attachment`, `save_artifact`, `publish_doc`, `show_items`, `show_chart` (fixed queries: merged PRs by week,
tickets by status, CI failures by week, theme shares — empty until themes exist —, sprint burn-down; the server's
numbers), `show_themes` (empty until themes exist; caption "Share of merged PRs"), `show_diagram` (structured, ≤ 8
nodes; a chain is drawn, anything else falls back to a list; saving writes server-generated Mermaid) and
`show_not_found`. `test/ask.parity.test.ts` fails while an MCP tool is neither wired nor excluded.

Never reachable from Ask: secrets and integrations, billing, the audit log, other orgs, others' private items, source
code, the web (`test/secrets.mcp.test.ts` walks `src/ai/ask/**`).

## Write cards (`chat_actions`)

A write tool never runs when called: the server builds the card from Trov's rows (`preview`), checking the lane first
(a write bound to be refused makes no card — the writer's refusal goes back to the model), and stores a `proposed`
row. `POST /ask/actions/:id/confirm { args?, only? }` claims it (`proposed | waiting → running`, one guarded UPDATE:
never twice), applies edited fields (only `editable` ones; re-validated; preview rebuilt), and runs it AS the person
through the same lane-scoped writers MCP uses. Cancel drops it. A card expires when the next turn starts or its answer
is replaced.

- **Kinds**: ticket, handoff, doc_edit (≤ 3 changed hunks with their heading; editing a hunk rebuilds the body), move,
  publish, sprint, other. **Groups**: consecutive calls to the same tool in one answer share a `groupId` — one card,
  one Confirm, one Undo.
- **Auto** (`auto: true` on the request, only while `orgs.ai_chat_auto` is on): writes run at once (`auto`), at most 5
  per answer; past it, and for `update_plan`, completing a sprint and Publish, the card WAITS with its note. Moving
  a ticket to Done is an ordinary write.
- **Publish a staged doc** (`publish_doc`): Confirm calls `promote_doc` — the web promote path — as the person, only
  when `mayPromote` (a signed-in member, the web route's own rule; otherwise `canPublish: false`, the card shows Open
  in Review). Never Auto, outside the cap, not an MCP tool.
- **Undo** (`POST /ask/actions/:id/undo`, the whole group newest first): a ticket edit / move / assignment / sprint →
  the previous value; a created ticket → declined with "Undone in Trov"; a created sprint → deleted while still empty;
  a sent handoff → expired while unclaimed; a staged prompt → that version dropped (v1: the prompt soft-deleted); a
  saved artifact → the private draft deleted. Each first checks the item is as the write left it (`updated_at`,
  status, version) — else `409 { error: "changed", message: "Changed since. Undo it by hand.", ref }`. A doc proposal
  has no Undo (the store has no withdraw path).
- **A declined ticket stays out of the default views** (the owner's ruling on Undo): Ask's `list_tickets` (no `seg` =
  `open`), its starters (the person's top OPEN assigned ticket), a person card's "working on" (in progress / testing),
  My Work and its brief (`listAssignedTickets`, open only), and the queue's server default (`GET /tickets` with no
  `seg`) all leave it out; asking for `closed` or `all` still finds it — declining is not deleting
  (`test/ask.declined.test.ts`). The Tickets SCREEN itself opens on `seg=all` as a board, whose Declined column shows
  it — that default predates this build (#78) and is left as it is.

## Attachments, saving, history

- `POST /ask/attachments` (multipart, ≤ 5 files, 10 MB each, images / PDFs / text and code): checked whole first, then
  each stored as a PRIVATE artifact (`createPage`: D1 for a text kind, R2 for the rest; sha256; the artifact caps)
  and linked to the thread (`chat_artifacts`). A message names them by id; the model gets them read BACK from the
  store (`readRaw`, as the person) — whole only in that turn. Later turns carry one line; `read_attachment(id)` reads
  one again, this person's thread's only.
- **An image over the model's limit** is stored, NOT read, and the person is told. The limits are the Messages API's
  own on the Claude API, which Trov calls directly (platform.claude.com › Vision › Request limits; the pinned SDK,
  0.133, types only `ImageBlockParam.transformations.oversized_image: "downsize" | "error"`, whose default already
  scales an image past the model's VIEWING size — 2576 px on the long edge for the current models — so only the hard
  limits matter): **10 MB per image base64-encoded** (`ASK_MODEL_IMAGE_B64_MAX`, read as decimal MB; about 7.5 MB of
  file) and **8000 px on either side** (`ASK_MODEL_IMAGE_PX_MAX`, read from the PNG / GIF / JPEG / WebP header by
  `imageSize`, no decoding; an unreadable header is sent and the API judges). Files past ~20 MB in one request
  (`ASK_MODEL_FILES_MAX`, under the API's 32 MB) are likewise stored but not read. (The API's > 20 images rule — 2000
  px each — cannot trigger: a message carries ≤ 5 files, later turns carry none, and a turn's ≤ 8 `read_attachment`
  calls add at most 8.) The model gets a line saying it could not view the file. The PERSON gets a notice in the
  existing contract — no new field: the turn's first `activity` lines, one per file, emitted run → done at once before
  the model is called, `{ step, tool: "read_attachment", icon: "read", label: "<name> is too large for Trov to view, so
  it was stored but not read." }` then `{ step, state: "done", resultLine: "Not read" }` ("<name> didn't fit in this
  message, so it was stored but not read." for the request budget). They are kept in the answer's `activity`, so a
  reopened thread shows them; tool steps number on after them.
- **Downscaling was weighed and not built** (the owner: "downscale instead of skipping, if easy"). A Worker has no
  canvas, and no new binding, WASM library or paid service is added without asking, so the only route is the browser
  making a smaller copy at attach time while the original stays the stored artifact. Its server half is not small:
  the copy needs a home bound to the original (a new `chat_artifacts` column — a migration — and a new R2 prefix, or a
  second private artifact that would show in the person's library), and every deletion path (thread, account,
  organization, and `sweepR2`'s reference check) would have to free it too. With the real limits above the gap is
  narrow — an image between ~7.5 and 10 MB, or wider than 8000 px — so the notice ships alone. **For the Ask
  frontend**: render these activity lines like any other (no special case is needed); nothing to downscale. If the
  owner later wants downscaling, the client half is: on attach, for an image over 7.5 MB or 8000 px, draw it to a
  canvas at ≤ 2576 px on the long edge, encode WebP/JPEG, and upload it as the original's model copy (a route that
  does not exist yet).
- Save as artifact: the footer / a block → `POST /ask/messages/:id/save-form` adds a `save_form` block (no model
  call); the model's `save_artifact` sends the same form (in Auto: saved private at once, a card with Undo).
  `POST /ask/threads/:id/save { messageId?, block?, title, kind: markdown | html, visibility }` writes it from the
  STORED answer: Markdown with refs as links, or an HTML page rendered by the server (charts as SVG, every string
  escaped). Linked to the thread and to the tickets and sprints it cites.
- Threads: `GET /ask/threads` (grouped pinned / today / week / earlier), `?q=` (titles and the person's own messages
  through `chat_fts`; `{ thread, snippet { text, matches }, matchCount }`), `PATCH` (title, pinned, auto, mode,
  draft), `DELETE`, `/export` (markdown). A ⌘J thread records `origin: panel` and `context_ref`.
- "Wrong?" (`POST /ask/messages/:id/wrong { reason }`): `ai_feedback` (item type `ask`, `detail_json`: reason, mode,
  messageId, cites). "A source is wrong" / "It is out of date" also add one `ask_flags` row per cited item — the
  reason only, no handle, no thread, no text — which Review reads (`askFlags` on `GET /proposals` and `GET /adrs`).
  The SPA gives each row its own (`attachAskFlags` in `web/src/api.ts`: `doc:<slug>`, `decision:<id>`) and Review's
  detail draws one line under the risk line: "Flagged in Ask: A source is wrong (2) · It is out of date (1)"
  (`askFlagsLine`, `web/src/review.ts`; the words are `ASK_WRONG_LABELS`, most flagged first).
- Settings › Trov: `GET / PUT /ask/settings` — instructions (≤ 500) and the default mode (Pro). The screen is three tiles
  of personal Settings (`web/src/ask-settings.ts`, controller `ask-settings-actions.ts`, acts `trovSet…`): its modes and
  their words come from `GET /ask/state`, the default mode is sent only when the plan offers a choice, and "What Trov
  can see" is the design's copy, held to this file's Tools section — change one, check the other. Where something is
  connected links its Org settings tab (`orgGo`: Integrations, Repositories, Hosting, Environments; the off line, AI).
- `GET /ask/state`: `{ enabled, eligibility, plan, modes, defaultMode, allowance { used, cap, resetsAt, low }, autoAllowed,
  attach { maxFiles, maxBytes, kinds }, starters }` — starters by plain rules (the person's top assigned ticket, the
  active sprint, what is waiting on them), the design's four as the fallback. `allowance.cap` is the cap the gate
  enforces (`resolveEntitlements` with the org's members): on Pro 300 × the paid seats, or × the members (at least
  1) when there is no paid-seat count (a gifted Pro); an override of `ai_chat` is the whole cap, never multiplied.
- No Ask route answers a malformed ref or id with a 500 (invariant 7; `test/ask.hardening.test.ts`): `GET
  /ask/item/:ref` takes a ref that will not decode (`%25`) as it is, so it is the same `404 { ref, hidden: true }` as
  an unknown one; `/ask/peek` refuses a malformed ref with `400 invalid` and hides a well-formed one that names
  nothing; every `:id` route answers a non-id with its own 404 / 400.

## Deletion and renames

Every Ask table is in `ORG_TABLES` and the reset seed; `chat_threads.handle` and `person_ask_settings.handle` are in
`HANDLE_COLUMNS` (no new table or handle column came with the deletion rules below).

**Deleting a thread or an account** (the owner's ruling, 2026-10-15 — legal #4). An attachment is a private artifact
the upload created (`chat_artifacts.role = 'attachment'`); a SAVED answer (`role = 'saved'`) is something the person
chose to put in the library, and no Ask deletion touches it. Both are HARD deletes — with an organization's, the only
artifacts ever hard-deleted (CLAUDE.md invariant 11): every version, link, pending upload token and search row of the
page goes in ONE batch with the thread's (or account's) rows, and the R2 bytes are freed AFTER the commit, only when
no row anywhere still points at the same sha (`src/deletion/r2.ts`).

- **Saving from a follow-up** (`save_artifact`, `saveTarget` in routes.ts): the answer saved — by the Save form's
  `messageId` and by Auto's `scope: "answer"` — is the one the model names (`which: "this" | "previous"`), else THIS
  answer when it has content of its own (a block, or 280+ characters), else the most recent earlier answer that has:
  "save this as a doc" after an answer saves that answer, not the one-line reply.
- **`DELETE /ask/attachments/:id`** (`deleteUnsentAttachment`, `src/deletion/ask.ts`): the composer removing an
  uploaded chip before it was sent deletes that one attachment the same way (its page's rows and its `chat_artifacts`
  link in ONE batch, re-checked inside it; R2 after the commit when nothing else holds the bytes). Refused with nothing
  deleted: not the person's (404), already sent (`sent`), published (`published`), or referred to by a ticket or a doc
  (`referenced`) — 409 each. A never-sent attachment also goes with its thread (`deleteAskThread`).
- **`DELETE /ask/threads/:id`** (`deleteAskThread`, `src/deletion/ask.ts`) deletes the thread and its attachments,
  EXCEPT a file something still refers to (`planThreadAttachments`). "Referenced" is what the schema actually links:
  - **a ticket** — an `artifact_links` row to a ticket (the library's Links, MCP `artifact_update`, `record_session`'s
    `artifact_links`); or the artifact's address in a ticket's body, a comment, or the ticket's own links
    (`ticket_links.url`);
  - **a doc** — its address in a doc's body or in ANY version of it (a staged proposal may still be promoted; a
    rejected one is restorable). Docs have no link table: the address is the only way a doc refers to an artifact. A doc
    IMAGE (`/img/<sha>`) is its own copy in `doc_images` / `doc-images/<sha>` and never depends on this object.
  - "The address" is `artifacts/<slug>` (the app's `#artifacts/<slug>`, `/api/artifacts/<slug>`), `raw/a/<slug>` (its
    bytes, any version), or a ref token `[[artifact:<slug>`, followed by anything that cannot continue a slug — GLOB,
    so a reference to `<slug>-2` never keeps `<slug>`.
  - Links to a sprint, a PR or an issue do not keep a file: the ruling names tickets and docs.
  - **Published** — an attachment the person moved to the org (`visibility = 'org'`) stays: it is the org's library
    item now, which others may rely on, and the ruling (legal #4) is about private attachments. Likewise one another
    thread links, or someone else authored (neither is made by Ask today).
  - A kept file stays a private artifact of the person's in the library; only the thread's link to it goes.
- **Deleting an account** (`src/deletion/person.ts`, `ASK_ATTACHMENTS_OF`) deletes the person's PRIVATE Ask
  attachments in every org — referenced or not: a private page is readable only by its author, who is gone — in the
  account's own batch, before its threads, then frees their bytes with the photo's. A published attachment stays,
  its author the tombstone, like every other artifact of theirs.
- **Deleting an organization** already removes every artifact of the org (attachments included) and its chat rows
  (`ORG_TABLES`), and frees the bytes no other org shares.
- Tests: `test/ask.deletion.test.ts` (kept when a ticket link, ticket text, a doc body or a staged version refers to
  it, or it is published; rows and bytes gone otherwise; bytes kept when another artifact has them; a saved answer
  kept; the account and the org cases).

## Fixtures and the replay

`shared/ai-fixtures.ts` › Ask Trov: `askTranscript(scenario)` for every design scenario (`live`, `streaming`,
`thinking`, `answer`, `answer-pr`, `actions-ask`, `actions-auto`, `artifact`, `artifact-saved`, `search`, `notfound`,
`cmdj`, `ticket`, `settings`, `phone`, `phone-plus`, `phone-insp`), built from the design's sample content (its org
renamed "Acme"); `askStateFixture`, `askSettingsFixture`, `askThreadsFixture`, `askSearchFixture`, `askRefFixtures`.
Under `wrangler dev` with `LOCAL_AI_PREVIEW` set, `GET /api/o/:slug/ai/ask-replay/:scenario?speed=1` streams one at
real pacing and `GET …/ai/ask-replay` lists the rest; anywhere else both are 404.

## Tests

`test/ask.stream.test.ts` (the event order and contract, caching, grounding, the gate, modes by plan, the allowance,
Stop, regenerate, tenant isolation, the fence), `test/ask.actions.test.ts` (Confirm / Cancel / expiry / edits / the
lane, Auto and its cap, Confirm-only writes, Publish, Undo and "changed since", groups, saving),
`test/ask.attachments.test.ts` (with the over-the-limit notice and `imageSize`), `test/ask.deletion.test.ts`,
`test/ask.declined.test.ts`, `test/ask.views.test.ts` (peek, the inspector, "Wrong?" and Review's flags, threads,
/search, ⌘J, state, settings, account deletion), `test/ask.parity.test.ts`, `test/ask.contract.test.ts` (every
fixture against the schemas, the transcript files, the replay's guard), `test/secrets.mcp.test.ts` (the boundary).
The Anthropic stream is stubbed at the `Response` level (`test/helpers/ask.ts`) — never the network.

## The screen (`web/src/ask-*.ts`)

Workspace › **Trov** (the sidebar row after My Work), `#ask` (a new thread) and `#ask/<id>`; the page is
`data-morph="ask"`. The design and the per-scenario map: `docs/superpowers/specs/ask-trov.dc.html` and
`ask-trov-inventory.md`. One file per part, each with its own `/* ── Ask: <part> ── */` block in trov.css:

- **Foundation**: `ask-state.ts` (`AppState.ask`, `AskCtx` — the ONLY way a part reads or writes, `AskPart`),
  `ask-controller.ts` (main.ts hands it every `ask…` act, routed by the two-letter part code; it owns the reads, one
  stream per conversation with Stop, batched `POST /ask/peek`, the inspector stack, the hover card, ⌘J, the Escape
  stack, the resize edge; nothing on a render path fetches), `ask-api.ts` (the typed client), `ask-sse.ts` +
  `ask-stream.ts` (the SSE reader and the reducer, tested on every recorded transcript), `ask-pace.ts` (the
  answer's reading pace between the two — › The stream), `ask-refs.ts` (the chip, the
  status cell, the hover card — one `RefView` per ref), `ask-screen.ts` + `ask-layout.ts` (header, the three columns
  and their breakpoints, the inspector's frame), `ask-threads.ts` (the thread list), `ask-escape.ts`,
  `ask-icons.ts`, `ask-motion.ts` (the motion hooks: inventory §12), `ask-replay.ts` (the dev replay).
- **Parts** (stubs with their interface in the file header): `ask-conversation.ts`, `ask-composer.ts`,
  `ask-inspector.ts`, `ask-actions.ts`, `ask-cmdj.ts` (the ⌘J panel over ANY page, a root `data-overlay`, and the
  Tickets page's "Ask about this ⌘J"), `ask-phone.ts`; Settings › Trov is `ask-settings.ts`.
- **Working, shown** (`ask-conversation.ts`, `thinking-orb.ts`; `web-ui.md` › The thinking orb): while a turn is live a
  20px thinking orb says what Trov is doing — a running step's icon (`STEP_ORB`: search / docs / feed / read / review
  steps "searching", the rest "working", decorative beside the step's words), the thinking row's icon ("solving";
  "Thought for Ns" keeps the clock), and the lone-cursor slot ("working" before anything arrived, "composing" once a
  block has). The text cursor inside streaming words is unchanged. Which animation is the person's pick
  (`AskUi.orb`, `ask-orb.ts` `askOrbState`), from the header's "Thinking animation" dropdown beside the bug button
  (Ask only; its trigger is the picked orb and a caret; it stays on a phone): "Match what it's doing" is the default
  above; one of the six replaces every orb in Ask — steps, thinking and the wait — while the orb's name ("Working…",
  "Writing…") still says what it is doing. Kept per browser (localStorage `trov.askOrb`), applied live.
- **The ⌘J panel** (`ask-cmdj.ts`): 420px on the right over any page (full screen on a phone), its own conversation
  (`AskUi.panel`) and the composer in panel form; the page's item (`pageRef`: a ticket, sprint, handoff or artifact)
  is the context chip, so the first send makes a normal thread with `origin: panel` and that `context_ref`. Another
  item starts a fresh panel thread; the same item reopens the same one. "Open as thread" moves the conversation, the
  draft and an open inspector to `#ask/<id>` (a history entry). **Painting**: the pages it opens over are not
  `data-morph`ed, so while Ask is not the screen the controller's paint repaints Ask's root overlays alone
  (`cmdjRepaint`: the panel and the hover card, morphed / inserted / removed) and never rebuilds the page behind
  it per keystroke or streamed word. **Keys**: ⌘J on a Mac, Ctrl+J elsewhere (`isCmdjKey`; never with Shift or Alt
  — DevTools' chords —, never mid-composition, never while another `aria-modal` dialog is up), toggles it; on the
  Ask screen it focuses the composer. Escape closes the panel's own inspector first, then the panel; Tab stays in
  the panel; closing hands focus back to its opener. The Tickets page's one change is the header's "Ask about
  this ⌘J" (`cmdjHeaderButton`). `?askReplay=cmdj#tickets/14` plays the scenario over the ticket (the replay starts
  from the controller's after-paint for a panel plan, since the Ask screen never enters there).
- **Composer** (`ask-composer.ts`, one per conversation): every limit and flag from `GET /ask/state` (modes, the
  allowance and its usage line under a fifth left, `autoAllowed`, `attach { maxFiles, maxBytes, kinds }`) — none in
  the UI. Files upload ON ATTACH (`POST /ask/attachments`; a new conversation's first upload makes its thread, and
  the question goes there); a file over `maxBytes` stays as a red "Too large" chip and is never sent. `@` searches
  the org through the app's quick search (`AskApi.searchRefs`; PRs are not in it — only PRs Trov already shows
  are offered), rows drawn from RefViews; `/` is the five commands, sent as `command` with the rest as the text.
  The mode (only when the plan offers more than one) and the Auto switch are remembered per thread
  (`PATCH /ask/threads/:id { mode | auto }`); Auto is never sent while an admin has it off. Unsent words are kept
  per thread (here, and `PATCH … { draft }`, read back from the thread's detail; cleared on send). On a phone the box's
  bottom row is the phone part's `phoneComposerBar` and its ONE + menu, which drives these controls (the file input, the
  box through a real `input` event, `setMode` / `setAuto`). Tests: `test/render.ask-composer.test.ts`.
- **Conversation** (`ask-conversation.ts`, `test/render.ask-conversation.test.ts`): the answer draws in stream order —
  steps (a `show_*` / `save_artifact` step stays quiet), thinking, then the parts — with its own small markdown
  reader (headings, lists, code, tables split outside ref tokens so `[[ticket:14|status]]` is one cell). Edit-and-resend
  and regenerate go through `replaceFrom`; a question streamed this session gets its id from `done.questionId`
  (`withQuestionId`; read back from `GET /ask/threads/:id` only after an answer that ended in an error). Save as
  artifact and Wrong? are the actions part's acts, their args built by `saveFormArg` (`askAcSaveForm`
  `<answerKey>[|<block>]`) and `askAcWrong` `<answerKey>`. A block or a question's file
  opens in the inspector as a conversation-held ref, `askcv:<where>:<key>:<kind>:<n>` (`ask-cvref.ts`): primed as
  hidden so it is never peeked, resolved by `cvItem`, drawn bigger with `chartFigure` / `themesFigure` /
  `diagramFigure` / `tableView`. **The bottom** (ask-motion.ts rule 7): a conversation stays at its bottom while
  `conversation.stick` — set by a send, a thread opened or a new one, and by reaching the bottom; cleared ONLY by the
  person scrolling up (`stickAfterScroll`, any distance). ONLY THE CONVERSATION moves the view (the owner,
  2026-10-16): the controller's `bottomMove` compares each scroller's conversation with its last paint — a thread
  opened or its history landed JUMPS to the bottom; an answer streaming, a message sent or an answer finishing EASES
  there frame by frame (`askFollowBottom`, each frame `1 - e^(-dt/110ms)` of the way, held 450ms past the last paint
  that asked, and while a glide runs), so streamed lines glide in instead of jumping a line at a time (measured:
  ≤13px a frame, ≤41px behind, at the bottom when it ends). What a person opens themselves — Wrong?, the sources, a
  step's results — never moves the view: the clicked control stays put and the new rows push down. It runs LAST in
  a paint, after the entrances and height glides started (pinning before them is what once jumped the thread).
- **Write cards, Save, Wrong?** (`ask-actions.ts`): a pending card (or a group's pending cards, one frame) with Edit
  of its `editable` fields only — Confirm sends just the changed ones as `args` (each edited card alone, then the
  rest of the group in one call) — and Cancel; a Publish whose `canPublish` is false shows Open in Review, never
  Confirm. A decided card is a line per outcome (done linked to `ref` with a time and Undo; Cancelled / Undone /
  Expired / Didn't work); Undo's `changed` keeps the line and says "Changed since. Undo it by hand." with a link. An
  Auto result names its own write (`action_result { tool, kind, preview }`), so its line says what was done with no
  read back; nothing on the client ever decides a card. An Undo of a ticket write calls `ctx.refreshTickets` (main.ts
  `loadTickets`, only once the queue was loaded) so an open board drops a declined ticket with its exit. `saveButton` / `wrongButton` are the footer's and a block's
  buttons (acts `askAcSaveForm`, `askAcWrong`). Tests: `test/render.ask-actions.test.ts` (every scenario from its
  transcript) and `test/ask.actions-hookup.test.ts` (the real routes into the real screen, the §4 guards).
- **Dev replay**: `http://localhost:<port>/<org>/?askReplay=<scenario>[&askSpeed=4]#ask` runs the screen on
  `GET …/ai/ask-replay` (above): fixtures for reads, the recorded transcript for each send, nothing written.
- Tests: `test/render.ask-stream.test.ts`, `test/render.ask-shell.test.ts`, `test/render.ask-cmdj.test.ts`.
- Tests: `test/render.ask-stream.test.ts`, `test/render.ask-shell.test.ts`.
- **Phone** (`ask-phone.ts`, ≤ 640px; `test/render.ask-phone.test.ts`): the header's Open threads + New thread (the
  app's nav button stays; bug and theme leave the Ask header); the thread list is a modal side drawer (focus in, Tab
  kept in, Escape / scrim / Close / a pick close it through its exit, focus back — it opts out of the app's phone
  modal-as-bottom-sheet rule); the composer renders `phoneComposerBar(v)` in place of its toolbar: the + menu drives
  the composer's OWN controls (Attach clicks its file input, Mention / Run a command type `@` / `/` into its box as a
  real `input` event, Mode / Changes write `ComposerUi.mode / .auto`, from `ask/state` only) and the meta line reads
  "Smart · Asks first"; the inspector is the shell's frame as a full-height sheet (`data-sheet="1"`) with focus kept in
  it. Every phone control is ≥ 44px.
- **Inspector** (`ask-inspector.ts`): one view per type (ticket, PR, doc, sprint, repo, handoff, feed, person,
  artifact, plus an upload and a chart) under the shell's frame. The header of each is the RefView; the rest is
  `GET /ask/item/:ref`, read once per ref after paint (a skeleton until then; a 404 and a peek `hidden` both show
  one sentence and nothing of the item). A repository draws RepoFacts with the Overview's verdicts and marks; its
  State is the Repo dashboard's own read (`GET /repo/dashboard`, `state`). An artifact's preview is the viewer's
  sandboxed frame (`artifacts.ts` `artifactFrame`); Publish to org is offered to its author only, and writes
  `PATCH /artifacts/:slug { visibility: "org" }`. A question's file and an answer's block have no RefView: there is ONE
  kind of local ref for them, the conversation's `askcv:` (the dev replay's `insp:upload` / `insp:chart` register
  theirs in `inspectorUi.local` under `askcv:page:replay:…`); the frame names them (`inspectorLocalHead`) and the
  controller never peeks them. The conversation's "Open in inspector" pushes `askcv:<where>:<key>:<kind>:<n>` (`ask-cvref.ts`, primed hidden so nothing peeks it): the
  inspector reads it with the conversation's `cvItem` and draws it with its `chartFigure` (larger, under the
  Chart / Table switch), `themesFigure`, `diagramFigure` and `tableView`; a question's file is the upload view. Every detail is the
  server's own projection — no client math: a sprint's forecast is `SprintDetail.forecast` (`sprintForecast`, the
  Roadmap's) in the Roadmap's words (`forecastWords`); a staged doc's excerpt is `detail.staged.body` (the version
  waiting in Review), the live `body` beside it; a feed entry is the Feed's projection (`ai` on one Trov wrote — its
  origin and model —, Sift's `importance`, its tags; its kind is the summary's leading `Shipped:` / `Status:` / `Decision:` / `Finding:` / `Incident:` /
  `Triage:`, read by `feedKind` (`web/src/feed-kind.ts`) and shown as a plain word in the meta line with the rest as the
  title — no column, and a summary with no known word has no kind); a
  pull request's changed files are what Repo setups' capture stored (`pr_files`: `files` when the read was complete,
  `filePaths`, `filesComplete`) and its added / deleted lines, stored nowhere, stay null and are not drawn.
- **Dev replay**: `http://localhost:<port>/<org>/?askReplay=<scenario>[&askSpeed=4]#ask` runs the screen on
  `GET …/ai/ask-replay` (above): fixtures for reads, the recorded transcript for each send, nothing written. The
  inspector's details come from `web/src/ask-inspector-fixtures.ts` (loaded on demand). A transcript recorded
  mid-answer (`streaming`, no `done`) is HELD — busy, the cursor, Stop — until Stop; a scenario question's files ride
  with it (`replayQuestionFiles`); a transcript's repo views get the index's RepoFacts (`withRepoFacts`).
- **The composer's place** (Phase H, AU-OWNER-1): centred under an empty conversation (the design's spacer under the
  composer, `EMPTY_TAIL`, page and ⌘J panel), docked at the foot once there are messages; `data-ask-dock="center" |
  "dock"` on the composer, and `askGlideDock` (ask-motion.ts rule 8) glides it when that flips — at once under
  reduced motion. The box's input clips while its height glides and scrolls only past the 220px cap (`data-full`),
  never with a visible scrollbar (`scrollbar-width:none`, the input only), and keeps the caret in view there
  (AU-OWNER-2).
- **Small rules the e2e pinned**: a decided card's `ref` is rebuilt by the thread read (`refOfAction`, routes.ts — no
  column keeps it), and a done line with no number says "the ticket", never "#null"; editing a command question shows
  "/search …" and Send parses it again (`parseCommand`); the thread menu takes focus on open, ↑↓ move, Escape returns
  to ⋯; on a phone the actions' buttons have the 44px hit area too.
- Tests: `test/render.ask-stream.test.ts`, `test/render.ask-shell.test.ts`, `test/render.ask-inspector.test.ts`,
  `test/ask.inspector-contract.test.ts`; where the parts meet and the contract gaps the build closed:
  `test/render.ask-integration.test.ts` (client) and `test/ask.gaps.test.ts` (server).

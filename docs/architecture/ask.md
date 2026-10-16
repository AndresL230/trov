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
  answer still counts); `/search` calls no model and counts nothing. An answer that FINISHED having written nothing — no
  words, no block, no card (the model spent its calls on lookups) — is taken back off (`unmeterBy`, the same day and
  actor) and stored with 0 units; the screen says "Trov didn't write an answer." with Try again and no Copy / Save
  (the owner, Q-F2; `isEmptyAnswer`). Caps live in `shared/plans.ts` (the master's;
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
- **Commands**: `/search` answers with item cards from Trov's own quick search, no model (its step says "No
  results" / "1 result" / "N results" — `resultLine`, the one wording, streamed and stored; Q51); `/ticket`, `/handoff`,
  `/summarize`, `/brief` add one instruction in front of the person's words.
- **Stop**: the request's own abort signal (the client went away) or `POST /ask/threads/:id/stop` (a flag read
  between steps) ends the turn; the partial answer is stored with `stopped = 1`; tools that ran stay done. On the
  screen the footer draws AT ONCE for what was written (Copy works on what is shown); Regenerate, Save and Wrong? need
  the stored id, which the controller reads back from the thread a moment later (`readBackStopped`, a few spaced tries;
  QA-4).
- **A close after `done` is never a Stop** (the `net::ERR_ABORTED` Chromium reports for `POST /ask` under wrangler dev,
  after its last event): the server stores the answer — and decides `stopped` — BEFORE it writes `done`, and only an
  abort DURING the turn (`runTurn`'s listener, removed when it returns) can mark it; on the client the pacer is
  flushed before the catch reads the error, so `done` has landed and `stopTurn` / `failTurn` leave a finished turn
  alone (`turnLive`), whatever the browser calls the close (`test/render.ask-controller.test.ts`).
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
  and the fold and lets text out a few characters a frame (never inside a `[[ref]]` or a surrogate pair; the owner: whole
  words were choppy) (each frame releases `1 - e^(-dt/600ms)` of the backlog,
  never under 70 nor over 120 characters a second — the owner's steady reading pace, so a 2,000-character answer
  takes ~17 s to write out whatever speed it arrived at; a word past a frame's allowance is borrowed from the next
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
  `done.cites` carries the linked RefViews; everything else renders as plain text. A REOPENED thread draws the stored
  `cites_json` / block views as its first paint only, then peeks every item it shows again at once (`threadRefs`,
  ask-controller.ts: sources, item cards, diagram nodes, context chips — `want(…, fresh)`): a status reads as it is
  now, and an item since made private or deleted drops out (its chip is plain text, its source row and card go, the
  count says so, a diagram node loses its link and mark) — never its old state (the owner, QA-1).
- `RefView { ref, type, num?, title, status { mark, tone, word, tip }, owner?, updated?, href, extra }` — built by
  `resolveViews` from Trov's rows, permission-checked (another person's private artifact, a deleted page, an unknown
  id: absent). Status words are the design's over the existing vocabularies (Triage / In progress / Testing / Done /
  Declined; Draft / In review / Approved / Merged / Closed; Live / "Staged, not approved"; "N days late"; Pending;
  Private / Org). A **repo** ref (#186) is the Repo Overview's facts: `extra.facts` = `askRepoFacts(getRepoDashboard(…).facts)`
  (`AskRepoFacts`, shared/ai-ask-core.ts: apps, environments, parts with their newest deploy, out-of-step, CI per
  environment, release, attention, the week; `null` when the read failed) and `status: null` — the client draws its
  state with the Overview's `envVerdict` and `stateMark` (Healthy only when the branch head's checks pass; Live with
  none captured; Unknown with nothing seen), never a word of Ask's own. `extra` (#178, for the single item card) also
  carries `excerpt` — the item's own first paragraph, ≤ 280 chars, null when it has none: a ticket's body, a PR's
  What (`pr_summaries.what`), a decision's decision (else its context), a sprint's summary (else its description), a
  prompt's description; a doc's was already there — and a person's `openTickets` (their tickets not done or declined,
  one COUNT), all from the queries `resolveViews` already makes. `POST /ask/peek { refs }` answers `{ ref, hidden: true }` for what the person can't
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
nodes, an edge [a, b] = b waits on a; `layout` is `chain` for one simple chain (nodes in its order) else `list`, but
the client draws ANY graph without a loop — only a loop or an edge naming no node is a list, and only then does the
tool's note say so (`diagramDrawable`); saving writes server-generated Mermaid) and
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

- **Rights are checked at Confirm** (the owner, Q57): a card is a proposal and never carries the rights it was made
  under. Confirm runs with the CONFIRMER's context as it is now, as if they called the tool themselves —
  `assertMayRunNow` (actions.ts: an admin-only tool needs the admin role now; an excluded tool never runs), then each
  writer's own rule inside `run` (the ticket lane and the assignment rule re-read on the write, a handoff's sender /
  recipient, Publish's `mayPromote`, `update_plan`'s admin check). Refused → the card is `failed` with the
  writer's `forbidden` and nothing is written (`test/ask.rulings.test.ts`). The turn asks the same before it builds a
  card.
- **A waiting card's note** is rebuilt by the thread read (`waitingNote`: a Confirm-only write's own note, else the
  Auto cap's — the only two reasons a card waits), so it survives a reload (Q55).

- **Kinds**: ticket, handoff, doc_edit (≤ 3 changed hunks with their heading; editing a hunk rebuilds the body), move,
  publish, sprint, other. **Groups**: consecutive calls to the same tool in one answer share a `groupId` — one card,
  one Confirm, one Undo; each item inside the group keeps its OWN in-place fields, and Confirm sends every edited
  item alone with its edits, then the rest of the group in one call (QA-3; `test/render.ask-actions.test.ts`).
- **Assignments** (`assign_ticket`): the card's `fields` are `{ id, login, on }` and `login` is the one editable field
  (the agent tool's args are unchanged); the preview's `item` is the ticket's RefView, whose `extra.assignees` is who
  was on it when the card was made — the card draws the change from those two. A replacement is two writes (remove,
  add) in one group. Undo checks THAT person's assignment is as the write left it (not the ticket's `updated_at`: the
  group's first undo touches the ticket, and a stamp check refused the second every time).
- **Auto** (`auto: true` on the request, only while `orgs.ai_chat_auto` is on — asked for while it is off, the answer
  runs asking first and the `thread` event carries `autoOff: true`, so the composer's switch turns to "Asks first"
  with the admin's reason (the owner, Q52)): writes run at once (`auto`), at most 5
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
  and linked to the thread (`chat_artifacts`). Past the org's artifact storage it is the app's ONE 402 body
  (`plan_limit` with `limit` / `used` / `cap` / `plan` / `status` / `message`; Save as artifact too — Q59).
  **With no `threadId` the files are PENDING** (the owner, Q60; `0068_ask_pending`): linked, unsent, to the person's
  hidden HOLDER thread (`chat_threads.pending = 1`), which no route lists, searches, opens or writes, and the answer's
  `threadId` is null — no visible untitled thread. The question that names them binds them to its thread
  (`bindPendingAttachments`, the person's own holder only). Never sent, they go 24 hours after the upload
  (`sweepPendingAskAttachments`, src/deletion/ask-pending.ts, on the hourly digest trigger `0 * * * *` — no cron of
  its own), by the composer ✕'s hard delete; one published or referenced meanwhile keeps its artifact and loses only
  the link; an empty holder goes too. The holder is an ordinary thread of the person's, so account and org deletion
  already take it. The composer sends EACH FILE AS ITS OWN REQUEST, so one failure is that chip's alone (no batch
  atomicity). A message names them by id; the model gets them read BACK from the
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
- Threads: `GET /ask/threads` (grouped pinned / today / week / earlier), `?q=` (titles and the thread's messages —
  the person's questions AND Trov's answers — through `chat_fts`; the owner kept answers searchable, Q54; `{ thread,
  snippet { text, matches }, matchCount }`), `PATCH` (title, pinned, auto, mode, draft), `DELETE`, `/export`
  (markdown, named by `askExportName`: the title transliterated to ASCII — é → e, ß → ss —, `ask-trov` only when
  nothing is left (Q56); the client's download name is the same function). A ⌘J thread records `origin: panel` and
  `context_ref` — the first context item the person can SEE; a hidden item never enters a thread (Q53).
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
  attach { maxFiles, maxBytes, kinds }, starters }` — each mode carries `canSend` (the key, the switch and the
  allowance left covering what it counts as: with 1–4 left Thinking cannot; Q50), and the composer never sends a
  mode that cannot (its menu shows it disabled with "Needs 5 questions; fewer are left this month."; the question goes
  in the default, else Smart); every mode out reads as the quota block; starters by plain rules (the person's top assigned ticket, the
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
- **`DELETE /ask/threads/:id`** (`deleteAskThread`, `src/deletion/ask.ts`; the thread menu's Delete asks first through the
  app's `confirmModal` — "Delete “<title>”?", what goes and what stays — a root overlay, `threadDeleteModal`; QA-2)
  deletes the thread and its attachments,
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

**The gallery** (for reviewing how Ask looks): `npm run ask:gallery [-- <out.html>]` writes ONE self-contained page
(default `.ask-gallery/ask-gallery.html`, gitignored) with every surface Ask can put on screen in every state — one
plain scroll in conversation order, a one-line caption each, in the app's light theme only (the owner) (the owner: "I
just want to be able to see everything", nothing complicated); whole screens (1440 and a 390 phone, in frames) last,
and each part cut out of a real render with its ancestors kept. Nothing in it
is hand-drawn: `scripts/ask-gallery/specimens.ts` sets states up as the controller would (these fixtures, the
inspector's `ask-inspector-fixtures.ts`, the Repo Overview's sample) and calls the SPA's renderers in headless Chromium
(Playwright; the app's CSS is loaded there so an open dropdown is placed by `createDropdowns`); `build.ts` inlines
`trov.css` with its fonts, the orb loop (`orb.ts`) and the page's runtime (`runtime.ts`: light only, lazy frames,
inert specimens). It has no `<html>`/`<head>`/`<body>` (it is published as a claude.ai
Artifact, which wraps it). A new part or state goes in `specimens.ts` as one more `inline(…)` / `desktop(…)` /
`phone(…)`; typecheck it with `npx tsc -p scripts/ask-gallery`.

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
  `ask-inspector.ts`, `ask-actions.ts`, `ask-cmdj.ts` (the ⌘J panel over any ORG page, a root `data-overlay`, and the
  Tickets page's "Ask about this ⌘J"), `ask-phone.ts`; Settings › Trov is `ask-settings.ts`.
- **Jump to the latest** (`jumpButton`, ask-conversation.ts): scrolled up more than 160px (and not following the
  bottom), an arrow shows on the scroller's bottom edge — a 0-height sticky row, so it changes no height; the scroll
  listener flips its `data-away` without a repaint and the render writes the same from `conversation.away`. It is
  in the accent while an answer is still coming (`data-busy`). A click (`askCvJump`) glides to the bottom and holds on there.
- **Half-written markdown** (`settleTail`, ask-conversation.ts): while a text part streams, its last line is settled
  before it is parsed — a bare heading / list / fence marker or a table row not yet closed by its bar waits, an unclosed
  `**` / `*` / backtick is closed for now (the words show bold as they arrive), a half `[link](…` shows its text, a half
  `[[ref` waits — so no raw marks flash before they render (the owner). A finished part is parsed as it came.
- **Working, shown** (`ask-conversation.ts`, `thinking-orb.ts`; `web-ui.md` › The thinking orb): while a turn is live a
  20px thinking orb says what Trov is doing, in ONE place under the steps (the owner, 2026-10-16): the wait row — the
  orb beside "Thinking…" ("Writing…" once a block is out and no step runs) in the sweep of light — is there for the whole wait, before
  anything, while the steps appear and after them, gone only while words stream or the Thinking row runs (that row
  keeps its "solving" orb; "Thought for Ns" keeps the clock). Its orb is the running step's kind (`STEP_ORB`: search /
  docs / feed / read / review steps and anything labelled "Searched …" are "searching", the rest "working"), else
  "solving" (the cube = thinking), "composing" (the ribbon, "Writing…") once a block is out AND no step runs — a step
  running after a block still shows its own orb (the owner, Q-F1).
  A step keeps its own icon; its label carries the sweep while it runs. Steps APPEAR AS THEY GO: the tools run in a
  few ms, so the pacer (`ask-pace.ts`, `stepMs` 350) shows each running for 350 ms, then done, then the next — what
  comes after waits its turn; quiet steps take no time; Stop shows everything at once. The text cursor inside streaming words is unchanged. **Each orb means one thing** (the owner, 2026-10-16:
  the picker is gone) — the cube while Trov thinks, the ribbon while it writes, the globe while it searches, the
  orbits for other work; all of them in the theme's `--accent` (olive in dark — the owner: colour carries meaning only,
  no hue of its own for "working").
- **The ⌘J panel** (`ask-cmdj.ts`): 420px on the right over any org page (full screen on a phone; ⌘J does nothing on
  Platform, which sits outside every org while Ask is per org — the owner kept it so, Q-F3), its own conversation
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
- **A blocked composer** (`composerBlock`, in the server gate's order): no key (`eligibility: no_key`, or a `no_key`
  stream error) shows "Ask Trov is not set up on this deployment." in place of the box, as `off` does (Q58); off and
  the quota have their cards. While blocked there is no Enter hint (Q-F4), and the starters stay to read but send
  nothing — `aria-disabled`, the block's reason in their tooltip (`composerBlockReason`; QA-6). A starter or a
  follow-up goes in the composer's own mode and Auto (`composerMode` / `composerAuto`).
- **Composer** (`ask-composer.ts`, one per conversation): every limit and flag from `GET /ask/state` (modes, the
  allowance and its usage line under a fifth left, `autoAllowed`, `attach { maxFiles, maxBytes, kinds }`) — none in
  the UI. Files upload ON ATTACH, one request per file (`POST /ask/attachments`; in a new conversation they are
  pending until the first question binds them — › Attachments; a failed file is its own chip's failure); a file over `maxBytes` stays as a red "Too large" chip and is never sent. **What is
  attached sits ABOVE the box** (the owner): the file chips (every state, an image's thumbnail) then the context chips
  are one keyed row (`.ask-co-chips`, `data-ask-enter="pop"` + `data-ask-tween`) between the notes and the box, on the
  box's edges; the box holds only the words and the toolbar. The row wraps; on a phone past two rows it is one line
  that scrolls sideways (`fitChips` measures after a paint → `ComposerUi.chipScroll` / `data-scroll`) and each × has
  a 44px hit area. A chip pops in once and leaves through `ctx.exit`; the row's height glides; it is inside the
  composer, so `askGlideDock` carries it; a conversation keeping to its bottom moves up as the composer area grows
  (`askKeepBottom`, rule 7). No "About … · N files" line (the owner: it only repeated the chips); with two or more
  the row ends on **Clear** (removes them all). A SENT question shows the same chips under its bubble, one size for
  everything (an image is the chip's 22px thumb, never a bigger card), no ×, a click opens the item (`sentFileChip` /
  `sentRefChip`). DOM order is focus order: the chips' ×, Clear, then the box. `@` searches
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
  `diagramFigure` / `tableView`. **One item** (`ask-one.ts` `singleItemCard`, the owner: never "a wider version that
  just looks boring, and has dead space on the right"): an `items` block with ONE visible item draws its own card —
  two zones: the identity on the left (the type and number eyebrow — a PR's repository beside it —, a 16.5px title,
  two clamped lines of the item's own words: `excerpt` as plain words (`plainWords` drops markdown's inline marks), a
  handoff's task, a feed entry's brief, a person's role, a repo's head-environment CI line; a foot: "Updated …" and
  "Open beside the thread") and a facts column on a faint tint, label / value rows per type: ticket Status · Priority ·
  Assignees (pictures, "Unassigned") · Sprint ("Backlog"); PR State · Checks (the summary mark and "n of m") · Author
  · Branch (head → base); doc Status · Owner · Space · Version; decision Status · Author · Proposed; feed Kind (the
  summary's leading word, taken off the title) · Author · Posted; sprint Status · Dates · Progress (a thin bar and "n
  of m done", "No tickets yet") · Lead; handoff Status · From · To ("Anyone") · Sent; artifact Visibility · State ·
  Kind · Version · Author; person Open tickets · Working on (up to three, each its mark, number and title — the
  controller peeks those tickets once, `wantOneCard`); prompt Status · Author · Slug; repo each environment's verdict
  (≤ 3, the Overview's) · Attention (else State: Unknown). A missing value is a missing row, never a guess; added /
  deleted lines and a ticket's due date are stored nowhere, so they are not drawn. The whole card is ONE `hitArea`
  (opens the item; nothing inside is a button); Save as artifact stays on the block's toolbar. Under 560px of its own
  width (`@container askone`: a phone, the ⌘J panel) the facts stack under the identity, the foot last. Its entrance
  is the rich block's; the hover lift and the bar's wipe are off under reduced motion. Two or more items keep the grid
  of cards (`itemCard`). The gallery's "One item: …" specimens show every type, and two narrow ones. **The bottom** (ask-motion.ts rule 7): a conversation stays at its bottom while
  `conversation.stick` — set by a send, a thread opened or a new one, and by reaching the bottom; cleared ONLY by the
  person scrolling up (`stickAfterScroll`, any distance). ONLY THE CONVERSATION moves the view (the owner,
  2026-10-16): the controller's `bottomMove` compares each scroller's conversation with its last paint — a thread
  opened or its history landed JUMPS to the bottom; an answer streaming, a message sent or an answer finishing EASES
  there frame by frame (`askFollowBottom`, each frame `1 - e^(-dt/110ms)` of the way, held 450ms past the last paint
  that asked, and while a glide runs), so streamed lines glide in instead of jumping a line at a time (measured:
  ≤13px a frame, ≤41px behind, at the bottom when it ends). What a person opens themselves — Wrong?, the sources, a
  step's results — never moves the view: the clicked control stays put and the new rows push down. It runs LAST in
  a paint, after the entrances and height glides started (pinning before them is what once jumped the thread).
- **The diagram** (`ask-diagram.ts`, `test/render.ask-diagram.test.ts`; `diagramFigure` is the thread's AND the
  inspector's bigger copy — the same figure, its mode picked by the width it gets). `layoutDiagram`: a node's layer is
  its longest path from a root; an edge that skips layers gets a dummy slot in each (so a connector never crosses a
  card); each layer is ordered by barycentres (two sweeps); each slot sits at the mean of its neighbours on both sides
  (a dummy's pull ×3, so a long edge runs straight), a lane apart in its layer (pool-adjacent-violators on
  `want − index`), in half-lane steps — a fan-out is parallel lanes with its parent centred on them. Shapes: `chain`,
  `graph`, `set` (no edges: a plain list), `list` (a loop or a broken edge: the timeline). **One set of nodes**: an
  `<ol>` in topological order (the text equivalent: each step's button names it, a hidden "Waits on …" says its
  edges; a node's mark is its item's status — a REPOSITORY's is its CI, the head environment's checks in the checks'
  words "Checks failing / passing / running", Unknown when none were captured, never the deploy verdict: `repoCiMark`,
  the owner's QA-5), each `<li>` absolutely placed by three coordinate sets carried as custom properties (`--lx/--ly/--lw`,
  `--tx/--ty/--tw`, `--sy`). trov.css › Ask diagram sets `--lr` / `--tb` / `--ls` to 1 for the mode in use and every
  position is their weighted sum — so a mode is three numbers, not a second stylesheet. **The mode** is a container
  query on `.ask-dg-wrap`: top → bottom by default; left → right once `(layers + 0.36 × gaps) × 112px` fits (`data-l`,
  a rule per layer count); the list once a top → bottom lane would get under 120px (`data-s` = the lane span in
  half-lanes, a rule each) — left → right wins over the list. `DG` (ask-diagram.ts) holds every number and the test
  recomputes each rule from it. Cards are a fixed height (100px left → right with a 3-line title, 84px otherwise),
  capped in width (`--lm` / `--tm`) and centred. **Connectors**: one SVG per graph mode over the same unit grid,
  `preserveAspectRatio="none"` (they stretch with the cards) and `vector-effect: non-scaling-stroke` (1.5px, crisp),
  in `--dg-edge` (46% of the foreground mixed into the surface: solid, ≥ 3:1 in both themes); every incoming edge meets its card at one
  point under the card's own arrowhead (`.ask-dg-ah`, rotated for top → bottom). A root (nothing before it, in a graph
  with edges) is the blocker: the surface and a darker edge (a filled dot in the list). The list is a rail with a dot
  per node. Motion: nodes rise by layer and each SVG wipes in its direction once, on insertion (a rerender keeps the
  elements — measured: no animation restarts while typing or opening the sources); off under reduced motion.
- **Write cards, Save, Wrong?** (`ask-actions.ts`): a pending card (or a group's pending cards, one frame). **Every
  kind has the same frame** (the owner, 2026-10-16): the head — the eyebrow, the draft / waiting mark and, for a waiting
  card, its reason in words — then the body, designed ON ITS OWN, as if the card had no buttons: it fills the card's
  width (no dead space on the right, not left-heavy). Fields are label-over-value columns that share a ruled row
  (`fieldsRow`: a new ticket's Category · Priority · Assignee · Sprint, weighted; a new sprint's Dates · Lead ·
  Urgency — `sprintDatesLabel`, "Nov 2 – 20"; any other write's short lines; one field fills the row, and narrow they
  flow two to a line); people read from → to (a handoff, an assignment, a claim) with the quiet note ("Andres Lopez
  stays on it", "Any agent session can claim it") at the row's right edge (`aside`); a move is ONE row — "#87 Title"
  on the left, the status marks from → to at its right (also a sprint started or completed); a doc edit's "Goes to
  Review before it is live" sits at its doc row's right, the hunks across the card; a Publish ends on what publishing
  does. Narrow (a phone, the ⌘J panel) a row's right-hand part takes the next line, left-aligned.
  **The floating pair**: Cancel / Confirm (a group's ONE pair; "Open in Review" in place of Confirm for a Publish that
  can't publish) are never inside the frame. They sit OUTSIDE it, a compact right-aligned pair just under its
  bottom-right edge (8px), no band and no background of their own — closer to their card than to what follows (the
  unit's 14px) — the same for every kind, a group, a phone and ⌘J. They come right after the card's content in the
  DOM (Tab from its last control reaches Cancel, then Confirm; `role="group"` named for the card), with the app's
  focus ring; on a phone the 44px comes from their hit areas (`.ask-col .ask-btn::after`), not a bigger button. The
  card and its pair share one wrapper (`.ask-act-w`, `act:<id>`, `data-ask-tween`), which is what a decision swaps for
  the line — so the pair leaves in the card's one glide.
  **One control height** (the owner): everything that sits together on a card, its line and the Save form is the app's
  small control, 30px (`--ask-ctl` on `.ask-acts`, = `.cnpy-dd.is-sm`): the floating pair, Undo / Open, the Save
  form's title field and Save (same top and bottom), its Kind / Who can see it switches, a card's person dropdown, a
  word a click cycles — and a field's value line, so a dropdown, a cycled word and plain text share a baseline. Pinned
  by `test/render.ask-actions.test.ts`.
  **There is no Edit mode**: every `editable` field is edited IN PLACE — text (a title, a task, a doc hunk's `+`
  text, an edit's new title) reads as text and a click (`askAcText`) turns it into an input that looks the same,
  focused; Enter or leaving it keeps the edit (a hunk's textarea: ⌘/Ctrl+Enter), Escape puts back what it held (an
  Escape layer above the others), and a title left empty goes back. A small fixed set (category, priority) is a word a
  click cycles (`askAcField <id>|<field>|<next>`, its tooltip lists the values); a person (a new ticket's assignee, a
  handoff's recipient — Anyone or a member — an assignment's person) is the app's `dropdown()`, quiet until hovered,
  its menu a root overlay (`actionDropdowns`, render.ts) so it opens over the ⌘J panel too (`askAcPick`; Unassigned is
  `~none` → null). Confirm sends just the changed editable fields as `args`, as before (each edited card alone, then
  the rest of the group in one call); the server is unchanged. A Publish whose `canPublish` is false shows Open in
  Review, never Confirm. **An assignment** (`assign_ticket`, and a handoff's claim in the same frame) reads as one: the
  item — number, title, its status mark; a click opens it — then the people, avatar and name through people.ts:
  "Andres → Jose" for a replacement, "Unassigned → Jose", "Adds Jose · Andres stays on it", "Removes Luke" (a claim:
  sender → you); the person who comes (or goes, when someone else is on it to pick) is the dropdown — every member who
  could take it. Its lines name people ("Assigned ticket #87 to Jose", "Reassigned ticket #6 from Jack to Luke", "Took
  Luke off ticket #7"; `doneText` / `proposedText` take the directory), and a confirmed edit becomes the card's
  `fields` so its line names who it really went to. **A decided card is ONE line per outcome**: the mark and what
  happened (done linked to `ref`; Cancelled / Undone / Expired / Didn't work), the reason muted on the same line (cut
  short, all of it in its `data-mtip`), then the time and Undo / Open at its end (Didn't work opens the item); on a
  phone it flows as one wrapped line, never a stacked block. Undo's `changed` keeps the line and says "Changed since.
  Undo it by hand." with Open for the item. An Auto result names its own write (`action_result { tool, kind,
  preview }`), so its line says what was done with no read back; nothing on the client ever decides a card. An Undo of
  a ticket write calls `ctx.refreshTickets` (main.ts `loadTickets`, only once the queue was loaded) so an open board
  drops a declined ticket with its exit. The Save as artifact form carries Kind and Who can see it as compact switches
  at its head's right (their options are their labels), the title with Save at its end, the hint under them. Save
  stays beside the title (no floating pair): the form is not a proposed write waiting for a yes / no — there is no
  Cancel, and Save is the submit of the field it sits next to.
  `saveButton` / `wrongButton` are the footer's and a block's
  buttons (acts `askAcSaveForm`, `askAcWrong`). **The swap** (ask-motion.ts rule 4): a card becoming its line glides ONCE from the height it had to its natural new one, whatever paints follow — the
  Confirm's own, a toast, every streamed word. `askTweenHeights` measures natural heights (running glides stepped past
  their end for the read; `tweenStart` decides): reading a glide's own height as the card's once started a glide back
  on every paint, and the card swung 48 ↔ 336px under an answer still writing. The measuring layout sees the card
  short before the glide holds it, which clamps a scroller near its end; `askHoldScroll` (main.ts `rerender` →
  `beforePaint`, and the ⌘J repaint) / `askKeepScroll` (after the glides start, before the bottom) put it back, so the
  view never jumps and `stick` holds (that clamp's scroll event once let go of a streaming answer). Scrolled up, the
  clicked card stays put and the rows under it rise; at the bottom with `stick`, the bottom holds and the card glides
  down by what it lost. Tests: `test/render.ask-actions.test.ts` (every scenario from its
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

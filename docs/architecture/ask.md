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
mode_unavailable`. Then SSE, in order: `thread` (again once the first exchange names it) → `thinking` run/done
(Thinking only; the SUMMARY, never raw thinking) → `activity` run then done (`results` refs, `resultLine`) → `text`
deltas → `block` → `action` / `action_result` / `artifact_saved` → `followups` → `done { messageId, cites, tokens,
stopped? }`. `error { code: capped | off | no_key | timeout | too_large | failed }` ends it early.

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

## Attachments, saving, history

- `POST /ask/attachments` (multipart, ≤ 5 files, 10 MB each, images / PDFs / text and code): checked whole first, then
  each stored as a PRIVATE artifact (`createPage`: D1 for a text kind, R2 for the rest; sha256; the artifact caps)
  and linked to the thread (`chat_artifacts`). A message names them by id; the model gets them read BACK from the
  store (`readRaw`, as the person) — whole only in that turn (an image over 5 MB, or files past ~20 MB in one request,
  are stored but the model is told it could not view them). Later turns carry one line; `read_attachment(id)` reads
  one again, this person's thread's only.
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
- Settings › Trov: `GET / PUT /ask/settings` — instructions (≤ 500) and the default mode (Pro).
- `GET /ask/state`: `{ enabled, eligibility, plan, modes, defaultMode, allowance { used, cap, resetsAt, low }, autoAllowed,
  attach { maxFiles, maxBytes, kinds }, starters }` — starters by plain rules (the person's top assigned ticket, the
  active sprint, what is waiting on them), the design's four as the fallback.

## Deletion and renames

Every Ask table is in `ORG_TABLES` and the reset seed; `chat_threads.handle` and `person_ask_settings.handle` are in
`HANDLE_COLUMNS`; deleting an account deletes the person's threads (with their messages, cards and attachment links)
and settings — the artifacts stay in the library like every other of theirs.

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
`test/ask.attachments.test.ts`, `test/ask.views.test.ts` (peek, the inspector, "Wrong?" and Review's flags, threads,
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
  `ask-stream.ts` (the SSE reader and the reducer, tested on every recorded transcript), `ask-refs.ts` (the chip, the
  status cell, the hover card — one `RefView` per ref), `ask-screen.ts` + `ask-layout.ts` (header, the three columns
  and their breakpoints, the inspector's frame), `ask-threads.ts` (the thread list), `ask-escape.ts`,
  `ask-icons.ts`, `ask-motion.ts` (the motion hooks: inventory §12), `ask-replay.ts` (the dev replay).
- **Parts** (stubs with their interface in the file header): `ask-conversation.ts`, `ask-composer.ts`,
  `ask-inspector.ts`, `ask-actions.ts`, `ask-cmdj.ts` (the ⌘J panel over ANY page, a root `data-overlay`, and the
  Tickets page's "Ask about this ⌘J"), `ask-phone.ts`; Settings › Trov is `ask-settings.ts`.
- **Dev replay**: `http://localhost:<port>/<org>/?askReplay=<scenario>[&askSpeed=4]#ask` runs the screen on
  `GET …/ai/ask-replay` (above): fixtures for reads, the recorded transcript for each send, nothing written.
- Tests: `test/render.ask-stream.test.ts`, `test/render.ask-shell.test.ts`.
- **Phone** (`ask-phone.ts`, ≤ 640px; `test/render.ask-phone.test.ts`): the header's Open threads + New thread (the
  app's nav button stays; bug and theme leave the Ask header); the thread list is a modal side drawer (focus in, Tab
  kept in, Escape / scrim / Close / a pick close it through its exit, focus back — it opts out of the app's phone
  modal-as-bottom-sheet rule); the composer renders `phoneComposerBar(v)` in place of its toolbar: the + menu drives
  the composer's OWN controls (Attach clicks its file input, Mention / Run a command type `@` / `/` into its box as a
  real `input` event, Mode / Changes write `ComposerUi.mode / .auto`, from `ask/state` only) and the meta line reads
  "Smart · Asks first"; the inspector is the shell's frame as a full-height sheet (`data-sheet="1"`) with focus kept in
  it. Every phone control is ≥ 44px.

# Server-side AI: the decided build (2026-10-15)

> **Decided.** This is the design of Trov handoff #10 (claimed 2026-10-15), built into PR #178 on `ai/screens`.
> Updated 2026-10-15 after merging `main` with #185 (hosting providers): migrations moved to 0058–0067, and
> hosting deploys feed the router and repo state.
> Where `2026-10-14-server-ai.md` (the older background spec) disagrees, this file wins. What was verified before
> building, and the migration numbers, are in `2026-10-14-ai-base.md`.

## How the system works

**One loop: capture → route → decide → write → show → learn.**

1. **Capture** already exists: the GitHub webhook and reconcile, plus the app's writers.
2. **Route** is plain code. Each write marks the scopes it made stale. No model is involved.
3. **The AI pass** in the `*/10` cron works through stale scopes per org, within the switch, the allowance and the cron budget.
4. **Jev decides; Haiku writes.**
   - Jev (TypeSafe, about $0.0001 a check) answers classifications and **gates**: is this worth a Haiku call?
   - Haiku 5.5 writes words, only past a gate, and reads **item cards**, never raw PR bodies or commit lists.
5. **Store** everything as computed rows. Screens, MCP, emails and Ask Trov all read those rows. Nothing calls a model while a page loads.
6. **Learn.** Accept, Dismiss and "Wrong?" go to `ai_suggestions` and `ai_feedback`, and each kind's eval set must pass before its prompt or threshold changes.

**Rules every part keeps** (the first, fourth and fifth become CLAUDE.md invariants in Phase G):

- **Where model calls happen.** Only in: the AI pass; the summary seams (the webhook and Sync); the Sift run an admin starts (it moves into the pass); the Ask route; the plain-language filter route. Never on a render path, and never in anything reachable from `src/mcp.ts`.
- **The model fills fields; the server renders.** No model-written HTML. Every number comes from the server.
- **Never guess.** A cite that is not in the input is dropped; an item with no valid cite is not written. `refusal` and `max_tokens` write nothing. Failures are quiet and retried on a later tick. A Jev reason is always Trov's own evidence (a snippet, a field), never model text — the pattern Sift already uses.
- **Suggestions, not actions.** The one exception is Sift at 85% and up, which comes with Undo. That stays as it is.
- **Nothing AI-written is official, promoted, ratified, or a resolution.** AI feed entries and doc-drift proposals go through the gate. Everything else is a computed, direct write.
- **One org per prompt.**
- **The org switch.** `orgs.ai_automation` gates every AI feature, Sift included.
- **Sample data.** Every screen a phase touches gets `LOCAL_AI_PREVIEW` fixtures (and local-seed rows where the screen reads real tables), so the owner can click through it under `wrangler dev` (owner's request, 2026-10-15).

## Phases

Each phase is committed to `ai/screens` in order, green at every boundary (`npm test`, `npm run typecheck`). After each: push, a short status comment on #178 (what landed, the guard proofs, what's next), one `record_session`.

### Phase A: one client, one switch, one settings page

- **Jev becomes a provider in `src/ai/client.ts`.** `providerFor(kind)` returns `claude` or `jev`. `src/tools/classify.ts` becomes the Jev provider's implementation, and its behaviour does not change: one request per item with the gate before each; 429/529 retried once; 401 stops the run; evidence as the reason. Callers name a kind; nothing else imports the TypeSafe URL.
- **Sift under the org switch.** It runs only when `orgs.ai_automation` is on **and** its own `tag.fit` setting is on. Turning the org switch off stops a run in progress at the next gate.
- **Org settings › AI** shows: the switch; all four allowances with this month's use — `ai_summaries`, `ai_runs` (Haiku), `jev_checks` (Jev), `ai_chat` (new, Phase F, in weighted units); the Auto mode switch for Ask Trov (Phase F); `AI_SENDS` naming **both** Anthropic and TypeSafe AI, and what each receives.
- **Docs.** `ai.md` lists every call site. `test/secrets.mcp.test.ts` pins them.

### Phase B: the router, scopes and the pass

- **`ai_dirty(org_id, scope, scope_key, dirty_since, last_run_at, attempts, last_error)`**, PK `(org_id, scope, scope_key)`. Marking an already-dirty scope keeps its `dirty_since`.
- **`src/ai/router.ts`:** one table from event to scopes, with `markDirty(ctx, scopes)` called from each write path. It writes rows and nothing else:

  | Event | Scopes |
  |---|---|
  | PR merged | `card:pr:<n>`, `repo:<repo>`, `person:<author>`, `sprint:<id>` (linked tickets), `theme_window:<repo>` |
  | Push, PR opened, run, check, deploy | `session:<repo>:<actor>`; plus `repo:<repo>` for a default-branch push, a deploy or a default-branch run failure; plus `person:<PR author>` for a failure on their PR |
  | Hosting deploy recorded or changing state (`hosting_deploys`, from the `:40` hosting poll or a provider event — #185) | `repo:<repo>` when it lands ready or fails on an environment's branch; no `session` (a host is not an actor) |
  | Ticket created (native or mirrored) | `card:ticket:<n>`, `org` |
  | Ticket assigned, status or sprint changed | `person:<assignee>`, `sprint:<id>`, `org` |
  | Handoff sent | `person:<recipient>` (members, capped, for `anyone`) |
  | Agent feed entry ingested | `card:feed:<id>`, `person:<author>` |
  | Doc proposal or ADR staged | `card:proposal:<id>` |
  | Item lands in Unplaced | `card:unplaced:<id>` |
  | Doc promoted, artifact created or versioned | `card:tagfit:<type>:<id>` (Sift on new items), `doc_drift:<slug>` |
  | Themes accepted | `theme_backfill:<repo>` |
  | Digest send hour is one tick away | `person:<handle>` (pre-warms the brief) |

- **`src/ai/pass.ts`** fills the empty registry. Per eligible org it reads the scopes past their debounce and runs them in order: sessions, cards, briefs, repo state, org rollup, themes, doc drift.
  - **Grouping.** Jev cards: one item per request. Haiku cards: up to 20 per call.
  - **Every Haiku prompt starts with the cached org prefix** (`src/ai/prefix.ts`): org name, tag vocabulary, active themes, active sprints, the plan narrative, with a `cache_control` breakpoint. Then the scope's input.
  - **Non-urgent kinds go to the Batch API:** theme proposals, theme backfill, captions, doc drift, the weekly recap and the narrative proposal. The pass submits them and collects on a later tick (`ai_batches`, a platform table: `custom_id` = `org:scope:key:prompt_version`). A result for an org that no longer exists, or that has the switch off, writes nothing.
  - **Output sections are validated one at a time,** so a bad section is dropped and the rest of the call still writes.
  - **Clearing.** A written scope is cleared. A failure bumps `attempts`; after 3 the scope waits until it is marked dirty again.
- **Debounce** (`shared/ai.ts`, `debounceMs(scope, plan)`):

  | Scope | Pro / Enterprise | Free / Personal |
  |---|---|---|
  | `session` | closes 45 min after its last event | same |
  | `card:*` | next tick | next tick |
  | `person` | 30 min | 2 h |
  | `repo` | 60 min (a breaking change skips it) | 6 h |
  | `org` and `sprint` | 6 h | 24 h |
  | `theme_window` | daily | weekly |
  | `doc_drift` | weekly | monthly |

- **Metering.** `ai_run:<kind>` counts Haiku calls (one call is one run, however many items it carries). `jev_check` counts Jev calls (the existing metric). Token metrics are recorded per provider.

### Phase C: Jev jobs (cards, Sift, gates)

Each kind ships an eval set in `test/ai-evals/<kind>/` (real examples from Personal Dev, with the expected answer), plus a recorded-response CI test.

| Kind | Scope | Jev question | Result |
|---|---|---|---|
| `tag.fit` (Sift on new items) | `card:tagfit:*` | for each active tag: fits? | the existing bands: ≥0.85 adds, with provenance and Undo; 0.6–0.85 suggests |
| `ticket.category` / `ticket.priority` | `card:ticket` | pick from the fixed lists | `ai_suggestions`; the reason is the ticket's own words that matched |
| `ticket.duplicate` | `card:ticket` | is this the same request as candidate X? Candidates are the top 5 FTS hits only | a suggestion linking the candidate; never closes |
| `feed.importance` | `card:feed`, `card:pr` | routine / notable / breaking | stored on `feed.importance` and `pr_summaries.importance` as computed facts, not suggestions |
| `review.risk` | `card:proposal` | changes a decision / contradicts a doc / changes a process / routine | a suggestion shown on the Review card; never promotes or rejects |
| `unplaced.destination` | `card:unplaced` | which section, or which existing doc (candidates from FTS)? | a suggestion; Accept routes exactly as assign does |
| `pr.theme` | `card:pr`, once themes exist | which active theme? | `pr_themes`, `source='ai'`; a person's choice is never overwritten |
| `gate.session` | `session` | is this burst substantive? (the input is commit subjects and PR titles) | below 0.5, no digest; status `skipped` |
| `gate.state` | `repo` | did this delta change what's shipped, in flight or needing attention? | below 0.5, no state call |
| `gate.drift` | `doc_drift` | does this doc disagree with these entries? | below 0.6, no Haiku call |

Jev has a native `choice` type (verified 2026-10-15, `2026-10-14-ai-base.md`), so the pick-one kinds are ONE `choice` question, and one request may carry several questions about the same item.

**When Jev is unavailable** (no key, or the provider stops the run): the gates fall back to plain rules — **session:** the burst has a PR, or 3 or more commits; **state:** a merged PR, a deploy, or a red main; **drift:** skip. The cards simply don't appear.

### Phase D: Haiku producers

Every output is structured (`output_config.format`) and carries `cites`. A Jev gate runs before each one, where the table above has one.

- **Session digests** (Feature A of the background spec). Input: the burst's commit subjects plus the cards of merged PRs. Output: a `Shipped:` or `Status:` entry written through `ingestFeedEntry`. Feed columns: `origin='ai'`, `model`, `subject`, `importance`. The author is the reserved system person `trov` — recorded as the one exception to "author = principal" in `ingestion-gate.md`. Dedupe: an agent feed entry citing the same commits or PRs skips the digest, with zero calls. The `record-session` skill now records only decisions, findings and incidents, and cites its commits.
- **Repo state** (Feature B). `repo_state` is append-only; keep the last 20. Updated incrementally from the previous state plus cards and digests since, and the environments' hosting part statuses and deploys (`RepoDashboard.providers`, `hosting_deploys` — every host is a provider since #185). The Repo › Overview `state` section and `get_repo_dashboard` read it, and `load-context` reads it first.
- **The brief** (Feature C, #163). Home: `person_brief`; keep the last 5 versions. **Now:** open PRs, red checks and the latest `Status` digest. **Recently:** the last 7 days of digests and PR cards. **Next:** only offered items (assigned tickets, handoffs, failing runs on their PRs, sprint tickets due soon), ordered by plain rules (overdue, then blocked, then someone waiting); the model adds only the one-line why. Only for people who opened My Work in the last 14 days, or who receive the digest. The same stored brief is what My Work, `get_my_work` and the email show.
- **Themes** (Feature D). The proposal (Batch API) runs when there are ≥15 carded PRs in 12 weeks with no active themes, then monthly. An admin accepts, renames, merges or removes themes through the suggestion routes. Classification: `pr.theme` (Jev). Backfill: `theme_backfill`, through the Batch API. Caption: Haiku; the server passes the theme shares in; a caption containing a digit, or naming an inactive theme, is discarded. Chart: a D1 aggregation on read.
- **Roadmap** (Feature E). `org_insights` stores sprint notes and drift; keep the last 10 per key. Sprint forecast is math, computed on read in `src/tools/sprints.ts`. Sprint notes and plan drift come from the org rollup; the server computes theme shares against sprint contents for the drift. Sprint drafts (when ≥8 open tickets sit outside any sprint and none is active) and the weekly narrative proposal go through the Batch API into `ai_suggestions`; an admin accepts, and accepting runs the existing writers as that admin (`write_plan` for the narrative). Roadmap UI: a forecast and a note per sprint row, a drift line, and suggestion cards for admins.
- **Doc drift** (#161). Weekly, through the Batch API, only past `gate.drift`. A disagreement with valid evidence becomes a low-confidence proposal through `ingestDocProposal`, authored by `trov`.

### Phase E: shorter emails, led by the brief

Applies to everyone, whether AI is on or off.

- **Daily** (aim: read in 20 seconds):
  - **Subject** from the brief's top "Next" item ("Netlify test failing, plus 1 more"); with AI off, from the first assigned item.
  - **"Your brief":** the same stored brief as My Work — the "Now" line and up to 3 "Next" items; with AI off, the 3 most recent assigned items in plain words.
  - **"Also":** at most 3 one-line items, only notable or breaking ones that touched the person's work, as a title plus a link.
  - **One line per queue, only when it has something:** "Review: 3 waiting, 1 changes a decision", "Sprint: Hosting, due Fri, 2 of 5 done".
  - **Removed:** the per-PR What / Why / Impact cards, issue detail rows and labels, and the full plan diff. Empty sections are omitted.
- **Weekly:** the brief, then "This week" (at most 3 cited highlights, one Haiku call per org per week through the Batch API, shared by all members), then one numbers line computed by the server.
- **"Only when something needs me"** — a new per-person option: send only when "Next" has items, or a notable or breaking item touched their work.
- **The brief is pre-warmed** by the router one tick before each recipient's send hour.
- **What stays:** no per-event emails, no reply-to-email, deep links only through the existing return-to sign-in.
- Update `notifications.md` and the renderers, and replace the screenshots of the email previews.

### Phase F: Ask Trov (backend, contract, fixtures and tests — NO frontend)

- **Route.** `POST /api/o/:slug/ask`, cookie-only, streams with SSE. Gated by the org switch and a new `ai_chat` allowance.
- **Modes** (`chat_messages.mode` records each):

  | Mode | Model | Who | Weight in `ai_chat` |
  |---|---|---|---|
  | Fast | `claude-haiku-5-5` | everyone (the only mode on Free) | 1 |
  | Smart | `claude-sonnet-5-5` | Pro and Enterprise | 5 |
  | Thinking | `claude-opus-5-5` with extended thinking (`thinking: {type: "adaptive"}`, verified 2026-10-15) | Pro and Enterprise | 10 |

  Free shows no switcher. Pro's default is Fast and a person's last choice is remembered. Regenerate can re-run an answer in another mode. Per turn: at most 8 tool calls, about 30s (90s in Thinking). Caching: the system prompt, tool definitions and the older part of the thread.
- **Allowance.** `ai_chat` counts weighted units: Free 50 per org per month (Fast only), Pro 500 per seat, Enterprise unlimited. `PLANS` has no per-seat limit (`LimitDef.per` is `org | person`), so Pro's is computed as `cap × paid seats` at read time. The composer shows what's left under 20%.
- **Tools: the whole MCP catalog, minus a short list.** Definitions from `shared/mcp-tools.generated.ts` (the names and input schemas MCP serves). Implementations call the same `src/tools/*` functions MCP calls, with the cookie person's context. Ask never imports `src/mcp.ts`, and nothing reachable from `src/mcp.ts` imports `src/ai/`. A parity test fails if an MCP tool is neither wired into Ask nor in the exclusion list. **Excluded:** `switch_org` (a thread belongs to one org), `get_connection` (no MCP connection here), `record_session` (Ask is not a coding session), binary `upload_asset` (files come through Ask's own attachment upload, stored as artifacts). Admin-only tools (e.g. `update_plan`) are offered only to an admin, exactly as MCP lists them. **Ask-only tools:** `trov_docs` (Trov's public docs), `save_artifact` (a write) and the show tools.
- **Reads run freely; every write is a confirm card.** For a write tool (`send_handoff`, `claim_handoff`, `create_ticket`, `edit_ticket`, `transition_ticket`, `assign_ticket`, `add_ticket_comment`, sprint tools, `append_feed`, `propose_doc_update`, `save_prompt`, `artifact_update`, `update_plan`) the server does not run it: it stores a `chat_actions` row and streams an `action` event with a server-built preview (the item it becomes). **Confirm** (`POST /api/o/:slug/ask/actions/:id/confirm`, cookie) runs it as that person through the same lane-scoped writers MCP uses; the result returns to the thread as the tool's result. **Cancel** drops it.
  - **Auto mode** — a per-thread toggle ("Ask before changes" default, "Auto"). In Auto writes run at once and show as a done card; every write is still a `chat_actions` row (state `auto`). **Undo** wherever a reverse exists: ticket edit / transition / assign / sprint change → write back the previous value; `send_handoff` → expire it; `save_prompt` → drop the staged version; `save_artifact` → delete the private draft. At most 5 auto writes per turn (the 6th waits for Confirm). Never for `update_plan`. Admins can turn Auto off for the org (`orgs.ai_chat_auto`, default on).
  - **Rules:** an action expires with its thread turn and is never confirmed twice; feed entries and doc proposals still go through the gate and are only staged; the human-only steps (promote, reject, ratify, publish a prompt, accept a suggestion, any delete) are never tools — Ask can link to them.
- **Never reachable from Ask:** secrets and integrations, billing, the audit log, other orgs, others' private items, source code, the web. A static test: `src/ai/ask/**` imports nothing from `src/data/secrets.ts`, `src/github-app/` or `src/billing/`.
- **Untrusted content.** Tool results are fenced with nonce-delimited markers; the system prompt treats them as data.
- **Grounding.** Markdown with ref tokens (`[[ticket:14]]`, `[[pr:173]]`, `[[doc:slug]]`, `[[sprint:id]]`, `[[handoff:3]]`, `[[artifact:slug]]`, `[[person:handle]]`); a token is linked only if a tool returned that item in this thread, else plain text. Staged docs and draft decisions are labeled. With no source: "I couldn't find that in Trov".
- **Rendering** (server-built blocks the model asks for through show tools): text (the sanitized markdown renderer); ref chips (resolved against D1, live status marks); item cards `show_items(refs)`; charts `show_chart(query, params)` from a fixed set (merged PRs by week, tickets by status, CI failures by week, theme shares, sprint burn-down); theme strip `show_themes(repo, range)`; diagrams `show_diagram(mermaid)` (sandboxed); tool activity (one quiet line per step); 2–3 follow-ups.
- **Attachments.** Up to 5 files per message, 10 MB each: images, PDFs, text / markdown / code. Each is stored as an artifact FIRST (R2 for binary, D1 for text), private to the person and linked to the thread; then images and PDFs go to the model as content blocks, text inline up to a cap (past it, the first part plus "truncated"). The artifact rules apply (size caps, sha256, sandboxed viewer). The person can publish an attachment to the org later.
- **Saving to artifacts.** An answer, a table, a chart (SVG), a diagram (Mermaid), a drafted doc or plan, or the whole thread (markdown) — through `save_artifact` (confirm or auto) or a "Save as artifact" button. Private by default; linked to the thread and to cited tickets or sprints.
- **History.** Thread list with auto-generated titles (from the first exchange, same call), rename, pin, delete. Search over the person's own threads (`chat_fts`). Unsent drafts per thread. Long threads compacted: turns past a token budget summarized once by Fast and kept as a cached prefix.
- **Message actions:** copy; edit and resend the last message; regenerate (same or another mode); stop while streaming; "Wrong?"; export the thread to markdown.
- **Composer:** `@` attaches items and people (the existing quick search); `/ticket`, `/handoff`, `/search`, `/summarize`, `/brief`; the ⌘J panel attaches the current page's item; a context line shows what's attached.
- **Personal instructions.** Settings › Ask: "How Trov should answer you" (≤500 characters) and a default mode, added to the system prompt after the rules, never replacing them.
- **Thinking.** "Thought for Ns" with the thinking summary collapsed; never raw thinking the API does not return as displayable.
- **Storage.** `chat_threads(org_id, handle, id, title, pinned, auto_mode, draft, created_at, updated_at)`; `chat_messages(org_id, thread_id, role, mode, content_json, cites_json, attachments_json, model, tokens_in, tokens_out, created_at)` plus `chat_fts`; `person_ask_settings(org_id, handle, instructions, default_mode)`; `chat_actions(org_id, thread_id, id, tool, args_json, state proposed|confirmed|auto|undone|cancelled|failed|expired, result_json, created_at, decided_at)`. Private to the person and deletable; in `ORG_TABLES`, `HANDLE_COLUMNS` and account deletion. "Wrong?" on an answer writes `ai_feedback`.
- **The stream contract** (`shared/ai-ask.ts`; zod-free value parts in `shared/ai-ask-core.ts`), SSE events in order: `thread {id, title, mode}`; `thinking {seconds, summary}` (Thinking only); `activity {step, label}`; `text {delta}`; `block {kind: items|chart|themes|diagram, …}` (resolved by the server); `action {id, tool, preview, state: proposed}`; `action_result {id, state: confirmed|auto|undone|cancelled|failed, result, undo}`; `artifact_saved {slug, title, visibility}`; `followups {items}`; `done {messageId, cites, tokens}`; `error {code: capped|off|no_key|timeout|failed, message}`. Routes: threads (list, search, get, rename, pin, delete, export), actions (confirm, cancel, undo), attachments (upload, bound to the artifacts store), Settings › Ask. Fixtures for each state in `shared/ai-fixtures.ts`.
- **UI: HOLD.** No Ask page, no ⌘J panel, no Ask frontend in this PR; the sidebar is unchanged. Andres is designing them in Claude Design (HTML later, as a Trov artifact or `docs/superpowers/specs/ask-trov.dc.html`). Noted in `2026-10-14-ai-base.md` › Waiting on design.
- **Plain-language filter (#162).** `POST /api/ai/filter { screen, text }` returns a filter object validated against that screen's own filter schema (Tickets, Feed, Artifacts) — filters, never results. An unreadable request says so.
- **Handoff reading list (#167).** At claim, an FTS-ranked "Read these first (not complete)" list. No model.

### Phase G: wrap up

- **`ai.md`** covers the loop, the router table, scopes and debounce, the kinds by provider, Ask, emails, evals and cost.
- **CLAUDE.md invariants:** the call-site rule; the switch covering every AI feature; Jev reasons are always evidence.
- **`releases.ts` lines** for each phase.
- **Screenshots** (`LOCAL_AI_PREVIEW` plus real data in a local seed) of every AI screen and email, light and dark, desktop and phone. Ask has no screen yet: a sample SSE transcript per state instead.
- **Legal.** Privacy Policy and Terms passages for Ask Trov (what is sent when a person asks), the weekly recap, and the widened Anthropic list — added with **DRAFT markers**, and the build stops for Andres's approval before they are removed. The approved Sift passages stay as they are.

## Migrations

Numbers in `2026-10-14-ai-base.md`. Every org table goes in `ORG_TABLES` and `scripts/seed/reset.mjs`; every handle column in `HANDLE_COLUMNS`.

## Guards each subagent proves (remove, show the test failing, restore)

Router mappings, debounce, grouping, the cap, the switch, cite validation, dedupe, section isolation, candidates-only answers, person-over-AI, Ask's import boundary, ref-token linking, the MCP parity test, no write runs without Confirm unless Auto is on and allowed, the 5-write auto cap, mode access by plan, attachments stored as artifacts before the model sees them.

## The master's review before merging a worktree

Run the suite. Grep the call sites. Count calls in the pass harness: ten pushes plus a merge give one repo call; 25 ticket cards give 25 Jev requests and zero Haiku calls; a non-substantive burst gives one Jev call and no Haiku call.

## Out of scope

The Ask page, the ⌘J panel and any Ask frontend (waiting on Andres's design); per-org keys; a Claude Code SessionEnd hook; merging the allowances; Queues or Vectorize; any AI that writes to GitHub; anything that marks a ticket or sprint done. If finishing a phase needs one of these, stop and ask.

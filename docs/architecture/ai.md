# AI — the loop, the kinds, and where a model may run

Trov's server-side AI (PR #178): Jev (TypeSafe AI) decides and gates, Claude Haiku 5.5 writes, Ask Trov answers, and
every screen, MCP read and e-mail reads STORED rows — never a model call on a render path. The decided design is
`docs/superpowers/specs/2026-10-15-server-ai-build.md` (handoff #10; background: `2026-10-14-server-ai.md`); what was
verified and the migrations (`0055`, `0058`–`0067`): `2026-10-14-ai-base.md`. Ask Trov in full: `ask.md`. The e-mails:
`notifications.md`. The capture-time summaries' allowance: `plans.md` › AI summaries. The keys: `env.md`.

## The loop: capture → route → decide → write → show → learn

| Step | What happens | Where |
|---|---|---|
| **Capture** | The GitHub webhook and Sync, the hosting poll, the app's and MCP's writers record what happened (and, at capture, a PR or issue gets its summary card). | `src/webhook.ts`, `src/consumer.ts`, `src/tools/*`, `src/tools/summarize.ts` |
| **Route** | Plain code, no model: each write marks the scopes it made stale in `ai_dirty`, one line after it commits. | `src/tools/ai-route.ts` (› The router) |
| **Decide** | The `*/10` pass takes the scopes past their debounce, per org, within the switch, the allowances, the per-tick caps and the cron budget. Jev answers classifications and GATES (is this worth a Haiku call?). | `src/ai/pass.ts` (› The pass), Jev kinds |
| **Write** | Haiku writes words — only past a gate, from item cards, never raw PR bodies — as structured output the server checks (cites, numbers, lengths) section by section. Everything lands as a COMPUTED row; AI feed entries and doc-drift proposals go through the gate. | the Haiku kinds (› Kinds by provider) |
| **Show** | My Work, Repo, the Feed, the Roadmap, Review, Unplaced, the ticket detail, MCP and the e-mails read those rows. Off = the field is missing, never an "off" state. | › The screens' fields |
| **Learn** | Accept / Dismiss (`ai_suggestions`) and "Wrong?" (`ai_feedback`) are remembered per person and item; each kind's eval set must pass before its prompt or threshold changes. | › Suggestions and "Wrong?", › Evals |

**The rules every part keeps** (CLAUDE.md invariants 14–16): a model is called from five places only (› Where a model
call may happen); the org switch covers every AI feature; a Jev reason is Trov's own evidence, never model text. And:
the model fills fields, the server renders and counts (no model-written HTML, every number the server's); never guess
(a cite not in the input is dropped, an item with no valid cite is not written, a refusal or `max_tokens` writes
nothing, a failure is quiet and retried later); suggestions, not actions (the one exception: Sift at ≥ 0.85 adds a tag,
with Undo); nothing AI-written is official, promoted, ratified or a resolution; one org per prompt.

## Kinds by provider

A caller names a KIND, never a model (`KIND_PROVIDER`, `src/ai/client.ts`). Scores are the live eval runs of
2026-10-15 (› Evals has the sets, runners and CI floors).

| Kind | Provider | Where it runs (scope, stage) | Gate / threshold | Writes | Live eval |
|---|---|---|---|---|---|
| `summary_pr`, `summary_issue` | Claude Haiku | the capture seams (webhook, Sync) | `ai_summaries`, the switch | `pr_summaries`, `issue_summaries` (the cards) | — (`plans.md`) |
| `tag.fit` | Jev `noul` | the Sift run (admin) and the pass (`card:tagfit:*`, cards) | ≥ 0.85 adds (Undo), 0.6–0.85 suggests | `entry_tags` (with provenance), `org_tag_suggestions` | 9/11 clear fits, 33/33 non-fits left alone |
| `feed.importance` | Jev `choice` | pass, `card:feed:*` / `card:pr:*`, cards | stored at ≥ 0.7, else unknown | `feed.importance`, `pr_summaries.importance` | 18 rated, 18 right (25 cases) |
| `ticket.category` / `ticket.priority` / `ticket.duplicate` | Jev `choice` (one request) | pass, `card:ticket:*`, cards | 0.7 / 0.75 / 0.9 | `ai_suggestions` | 96% / 98% / 95% |
| `review.risk` | Jev `choice` | pass, `card:proposal:*`, cards | 0.6 | `ai_suggestions` (Dismiss only) | 61% (every risk written right) |
| `unplaced.destination` | Jev `choice` | pass, `card:unplaced:*`, cards | 0.55 | `ai_suggestions` | 85% |
| `pr.theme` | Jev `choice` | pass, `card:pr:*`, cards (once themes exist) | 0.5 | `pr_themes` (`source='ai'`) | 38/39 |
| `gate.session` → `digest.session` | Jev `noul` → Haiku | pass, `session:<repo>:<login>`, sessions | gate 0.5 (rule: a PR or 3+ commits) | a `Shipped:` / `Status:` feed entry through the gate | gate 17/17; digest 10/10 |
| `gate.state` → `repo.state` | Jev `noul` → Haiku | pass, `repo:<repo>`, repo state | gate 0.5 (rule: a merge, a deploy or a red default branch) | `repo_state` | gate 18/19; state 8/8 |
| `brief.person` | Haiku | pass, `person:<handle>`, briefs | only for people who read it; no call on an unchanged input | `person_brief` | 10/10 |
| `org.rollup` | Haiku | pass, `sprint:<id>` / `org`, org rollup | the drift only with a theme ≥ 25% in no sprint | `org_insights` (sprint notes, plan drift) | 10/10 kept |
| `sprint.draft`, `plan.narrative` | Haiku, Batch API | pass, `org`, org rollup | ≥ 8 open tickets outside every sprint, none active / weekly | `ai_suggestions` (admin Accept) | — |
| `themes.propose`, `themes.backfill`, `themes.caption` | Haiku, Batch API | pass, `theme_window:<repo>` / `theme_backfill:<repo>`, themes | ≥ 15 carded PRs in 12 weeks; a caption with a digit is discarded | `repo_themes` + `ai_suggestions`, `pr_themes`, `repo_theme_captions` | caption 6/6 |
| `gate.drift` → `doc.drift` | Jev `noul` → Haiku, Batch API | pass, `doc_drift:<slug>`, doc drift | gate 0.6 (rule: skip) | a low-confidence doc proposal through the gate, authored `trov` | gate 17/20 (no false pass); drift 5/12 (no false proposal) |
| `digest.week` | Haiku, Batch API | pass, `digest:week:*`, last stage | marked 3 h before the weekly send | `digest_highlights` | 17/17 |
| `filter` | Haiku | the filter route, on a person's request | `ai_runs`, a 60/h rate | nothing stored: the screen's filters | — (rules-checked) |
| `ask.fast` / `ask.smart` / `ask.thinking`, `ask.compact` | Haiku / Sonnet 5.5 / Opus 5.5, Haiku | the Ask route, on a person's question | `ai_chat` (a Thinking question counts 5) | `chat_*` (`ask.md`) | — (`ask.md` › Tests) |

## THE client, and the two providers (`src/ai/client.ts`)

A caller names a KIND, never a model. `KIND_PROVIDER` is the ONE table from a kind to its provider, and
`providerFor(kind, { apiKey, fetchImpl, … })` returns that provider (typed by the kind) or null without a key:

| Provider | Model | What it does |
|---|---|---|
| `claude` | `claude-haiku-5-5` (Anthropic, `ANTHROPIC_API_KEY`; Ask's Smart and Thinking modes also Sonnet 5.5 and Opus 5.5) | `structured()`: one call, a system prompt and a text in, a zod-checked value out. It writes words. |
| `jev` | `jev-latest` (TypeSafe AI's Jev, `TYPESAFE_API_KEY`) | `classify()`: a run of one yes/no question over many items; `ask()`: several `noul` / `choice` / `score` questions about ONE item in ONE request. Numbers only, no text. |

Which kind is whose: › Kinds by provider.

- **The Jev provider is `src/tools/classify.ts`**, the ONLY file in `src/` and `shared/` that names TypeSafe's URL,
  and only `src/ai/client.ts` imports it (`test/secrets.mcp.test.ts`). `classify` is Sift's run, unchanged by the
  move: ONE request per item, the caller's `gate` asked before EACH request (and its retry), at most 4 in flight;
  422 / a timeout / a non-JSON body is no judgement for that item; 429 / 529 is retried once after a short delay,
  then the run stops; 401 (or anything else) stops it. `ask` parses each answer against the question asked — a
  `choice` must be one of the options with probabilities for exactly those options, a `score` a level in range with
  one probability per level — and an answer malformed in ANY way is null, never a guess; it refuses to send
  questions TypeSafe would reject (none, a blank instruction, a choice of fewer than 2 or more than 255 options, a
  score of fewer than 2 or more than 10 levels: `status -1`, no request) and has no retry (the caller decides).
- **A Jev reason is always Trov's own evidence** (the matched snippet, a field), never model text: Jev writes none.
- Neither provider ever throws. Claude makes no retries (`maxRetries: 0`). A failure logs its error NAME and
  status only.

## Where a model call may happen

ONLY in these places, all behind THE client (the fifth, Ask Trov, is `ask.md`):

1. **The capture-time summary seams** — `src/tools/summarize.ts`, chosen per org by `orgSummarizers`
   (`src/plans/summaries.ts`), from the webhook and Sync GitHub. Kinds `summary_pr` / `summary_issue` (Claude).
   Gated by the org switch (below).
2. **The AI pass** — `src/ai/pass.ts` (and its batch half, `src/ai/batches.ts`), from the `*/10` repo tick. Jev
   jobs and gates and Claude jobs (`src/ai/jobs.ts`); every producer in `AI_JOBS` (› Kinds by provider) imports no
   client: the pass calls for it.
3. **The Sift run** — `src/ai/sift.ts` (`startTagFit` / `continueTagFit`), started by an admin from the Tags routes
   (`src/tags/routes.ts`: adding a tag, accepting a suggested one, Find items) and run in the background
   (`waitUntil`). Kind `tag.fit` (Jev). Everything about Sift that is NOT a call — candidates, the question, the
   bands and their writer, the switches' read, Undo, review counts — is `src/tools/tag-fit.ts`, which imports no
   client (MCP reaches it through `src/tools/tags.ts`). Sift on NEW items runs in the pass (› Jobs); the admin's run
   over existing items stays here.
4. **The plain-language filter route** — `POST /api/o/:slug/ai/filter` (`src/ai/routes.ts` → `src/ai/filter.ts`), on
   a person's request only (Enter in the filter box). Kind `filter` (Claude). See "The plain-language filter" below.
5. **Ask Trov** — `POST /api/o/:slug/ask` (`src/ai/ask/routes.ts`, cookie only): the turn (`src/ai/ask/turn.ts`,
   `askChatClient` — kinds `ask.fast` / `ask.smart` / `ask.thinking`, streamed with tools) and the one-time compaction
   of a long thread (`src/ai/ask/history.ts`, kind `ask.compact`). Gated by the org switch and `ai_chat` (questions,
   by the mode). Everything else about it: `ask.md`.

Never on a render path (a read that backs a screen calls no model), and never from MCP: nothing reachable from
`src/mcp.ts` imports `src/ai/` or the Jev provider (`test/secrets.mcp.test.ts` walks the import graph, and pins that
only those call sites import the client — `src/tools/summarize.ts`, `src/ai/sift.ts`, the filter's `src/ai/filter.ts`
(imported only by `src/ai/routes.ts`), the pass's `src/ai/pass.ts`, `src/ai/batches.ts` and `src/ai/jobs.ts` (types
only), and Ask's `src/ai/ask/turn.ts` and `history.ts`; that only `src/ai/eligibility.ts`, `src/ai/filter.ts`,
`src/ai/pass.ts`, `src/plans/summaries.ts`, `src/platform/routes.ts` and Ask's routes, turn and history read
`ANTHROPIC_API_KEY`; that only `src/ai/pass.ts`, `src/ai/sift.ts` and `src/tags/routes.ts` read `TYPESAFE_API_KEY`;
that nothing under `src/ai/ask/` reaches secrets, the GitHub App, billing or `src/mcp.ts`; and that the ROUTER, which
MCP's writers reach, imports nothing from `src/ai/`).

**The org switch covers every AI feature, Sift and the capture-time summaries included.** For summaries
(owner ruling, 2026-10-15): `planAndSummaries` (`src/plans/gate.ts`) reads `orgs.ai_automation` in the SAME
statement as the plan and the month's use — as `planAndAiRuns` reads it for the pass — and `summaryAllowance` answers
`disabled` when it is off, before the allowance is looked at. `orgSummarizers` then hands out no summarizer and
`switchedOff()` is true, and both seams (the webhook's `captureDelivery`, Sync's `runBackfill`) write NOTHING for the
item: no call, no summary row (not even the excerpt marker a cap or a missing key leaves), no meter. It is a write
gate, not a hide: a summary already written stays readable, and is never replaced by an excerpt while the switch is
off; the items wait, and the first Sync after it is turned back on summarizes them. The switch is read once per
webhook delivery or Sync batch (a batch makes at most 5 calls), not before every call as Sift's is. The Sync panel
says so (`syncSummariesText`, `disabled`); `test/summaries.switch.test.ts` pins it.

A Sift run starts, and each of its requests is made, only
while BOTH `orgs.ai_automation` (Org settings › AI) and Sift's own switch (`org_ai_settings`, kind `tag.fit`, the
Tags tab) are on — `siftSwitches` reads both in one statement before the run and before EVERY request, so turning
either off stops a run in progress at its next request. The Tags tab says when the org's switch is what stops it
(`TagAiDTO.org`).

## The router (`src/tools/ai-route.ts`, `src/data/ai-dirty.ts`; Phase B)

Plain code, no model, no network: `routeAi(ctx, event)` turns a write that happened into the scopes it made stale
(`scopesFor`, the ONE table `AI_ROUTES`) and `markDirty` writes them — rows only, one D1 batch, only while the org's
switch is on (an org with AI off accrues nothing; turning it on starts from the next writes). It lives in
`src/tools/` + `src/data/` because MCP's writers call it and nothing reachable from `src/mcp.ts` may import
`src/ai/`; `src/ai/router.ts` re-exports it. Every call site is ONE line after its write commits, and a failed mark
never fails the write (`routeAi` logs the error's name with the org id).

| Event | Scopes | Call site |
|---|---|---|
| PR merged | `card:pr:<n>`, `repo:<repo>`, `person:<author>`, `sprint:<id>` (tickets linking the PR), `theme_window:<repo>` | `ingestEvent` (`src/consumer.ts`): the webhook and Sync's backfill |
| push, PR opened, run, check, deploy | `session:<repo>:<actor>`; + `repo:<repo>` for a default-branch push, a deploy or a default-branch run failure; + `person:<PR author>` for a failure on their PR | the webhook's repo capture (`captureDelivery`, `src/webhook.ts`; the default branch is the delivery's `repository.default_branch`). Reconcile's backfilled rows mark nothing |
| hosting deploy recorded or changing state | `repo:<repo>` when it lands `ready` or `error` on an environment's branch; no session | the provider poll (`src/hosting/poll.ts`: the `:40` poll and a provider event's poll), for each deploy `upsertDeploys` (`src/hosting/deploy-store.ts`) reports new or changed; a `github` part's deploys come from webhook signals, which mark as their own row above |
| ticket created (native or mirrored) | `card:ticket:<n>`, `org` | `create_ticket`; `mirrorIssue` (by `source_ref`) |
| ticket assigned, status or sprint changed | `person:<assignee>` (and one just unassigned), `sprint:<id>` (and the one it left), `org` | `transition_ticket`, `move_ticket` (a status change), `toggle_assignee`, `set_ticket_sprint`; the mirror's forced status |
| handoff sent | `person:<recipient>`; for `anyone`, up to 20 members (`AI_ANYONE_MAX`) | `createHandoff` |
| feed entry ingested | `card:feed:<id>`, `person:<author>` — for a digest Trov wrote, `person:<subject>` | `ingestFeedEntry` |
| doc proposal or ADR staged | `card:proposal:doc:<slug>:<version>` / `card:proposal:adr:<id>` | `ingestDocProposal`, `ingestAdrDraft` |
| item lands in Unplaced | `card:unplaced:<id>` | `route_triage` |
| doc promoted; artifact created or versioned | `card:tagfit:doc:<slug>` + `doc_drift:<slug>`; `card:tagfit:artifact:<slug>` + `doc_drift:artifact:<slug>` | `promote_doc`; `insertPage` (with a version) and `writeVersion` (`src/tools/artifacts.ts`) |
| themes accepted | `theme_backfill:<repo>` | the theme accept handler (`src/ai/themes-accept.ts`): Accept, Rename, a Merge into an active theme |
| digest send hour one tick away | `person:<handle>`, URGENT | `prewarmDigests` (`src/notifications/cron.ts`), from the repo tick at `:50` |
| weekly digest 3 hours away (Phase E) | `digest:week:<YYYY-Www>:<send instant>` | `prewarmDigests`, the same `:50` tick |

Some scopes are named by what the write knows and resolved in SQL in the same batch (`ScopeRef`): a GitHub login →
the member this org attributes it to (the attribution map, else a member's own sign-in — never a stranger); a PR's
author by its head branch; a ticket's assignees and sprint; the sprints of tickets linking a PR; the primary repo; a
deploy's branch against its environment's.

**`ai_dirty`** (0058 + 0059), PK `(org_id, scope, scope_key)`: `dirty_since` (the FIRST mark since the last run —
a re-mark keeps it), `marked_at` (the LAST mark), `last_run_at`, `attempts`, `last_error`, `urgent`. Dirty =
`last_run_at IS NULL OR marked_at > last_run_at`. In `ORG_TABLES` and the reset seed. No handle COLUMN, but a
`person` key is a handle and a `session` key ends in a login: an account's deletion deletes those rows
(`src/deletion/person.ts`); a rename leaves the old key, whose producer then finds no member and writes nothing.

## Scopes and debounce (`shared/ai-core.ts`)

`debounceMs(scope, plan, { urgent })` — how long a scope waits after it went stale (`debounceFrom`: a session from
its LAST mark, every other scope from its FIRST):

| Scope | Pro / Enterprise | Free / Personal |
|---|---|---|
| `session` | closes 45 min after its last event | same |
| `card:*` | next tick | next tick |
| `person` | 30 min | 2 h |
| `repo` | 60 min (a breaking change skips it) | 6 h |
| `org`, `sprint` | 6 h | 24 h |
| `theme_window` | daily | weekly |
| `doc_drift` | weekly | monthly (30 days) |
| `theme_backfill` | next tick (not in the design's table: the accept's own follow-up, through the Batch API) | same |
| `digest` | next tick (Phase E: marked once, hours before the weekly send, through the Batch API) | same |

`urgent` (`ai_dirty.urgent`, set by whoever marks): a BREAKING change skips a `repo`'s wait on Pro and Enterprise only
(Phase C's `feed.importance` marks it); the digest pre-warm skips a `person`'s on every plan. It changes nothing
for any other scope, and clears when the scope is written.

## The pass (`src/ai/pass.ts`)

`runAiPass(env, budget, opts?)` runs on every repo tick that has **no heavy job** (not `:00`'s usage polls, not the
6-hourly progress / reconcile), AFTER the health pings, on what they left of the SAME `Budget`
(`CRON_SUBREQUEST_BUDGET`, `CRON_WALL_BUDGET_MS` — `src/repo/dispatch.ts`, `repo-dashboard.md` › The repo cron).

- **The job registry.** `AI_JOBS: readonly AiJob[]` (`src/ai/pass.ts`) — one line per producer: the three Jev card
  jobs, `tag.fit` on new items, `feed.importance` (two scopes), `digest.session`, `repo.state`, `brief.person`, the
  Roadmap's four, `doc.drift`, `pr.theme`, `themes.propose` / `caption` / `backfill` and `digest.week` (› Kinds by
  provider). A job
  (`src/ai/jobs.ts`) is one KIND of work over one scope (`scope`, and for a shared scope like `card` a `keyPrefix`):
  `input(ctx, scope)` reads its item from D1 (null = nothing to send: the scope is written as it is), and then —
  - a **Jev job** (`provider: "jev"`, a `JevKind`): `ask(item)` → ONE request (`state` + questions) per item;
    `write(ctx, item, answers)` → true when it wrote;
  - a **Haiku job** (`provider: "claude"`, a `ClaudeKind`): `group` (1–20 items per call), `schema`, `maxTokens`,
    `prompt(items)` → `{ system, input }` (the org prefix is the pass's), `write(ctx, items, output)` → the scope
    keys it wrote; optionally a Jev **gate** (`ask`, `pass`, a plain-rule `fallback`, and `skip` for what a gated-out
    item writes) and `batch: true` (the Batch API, below).
  A job never decides eligibility, the allowances, caps, metering, grouping, the prefix, batching or clearing. A job
  runs only with its provider's key (a gated Haiku job needs only Anthropic's: its gate falls back to its rule).
  With nothing runnable the pass returns before reading anything: no statement, no request, no log line.
- **Rotation.** Orgs (`listActiveOrgIds`, by id) in a stable order, starting after the last org a tick could not
  finish (`cron_cursor`, job `ai_pass`). The cursor is written only when a tick stops early.
- **Per org**: ONE statement (`planAndAiSettings`: the plan, the switch, the month's `ai_runs` and `jev_checks`) —
  the switch off and nothing else is read or asked; then ONE read of its dirty scopes (`dueScopes`, oldest first,
  at most 500, skipping any that failed 3 times), kept only when its debounce is over (`isDue`) and not already in
  an open batch. Then the STAGES (`AI_PASS_STAGES`): sessions → cards → briefs (`person`) → repo state → the org
  rollup (`org`, `sprint`) → themes (`theme_window`, `theme_backfill`) → doc drift, each stage's jobs in registry
  order, so a later stage reads what an earlier one just wrote.
- **Grouping.** Jev: ONE item per request, always. Haiku: up to `group` items per call, never more than
  `HAIKU_GROUP_MAX = 20` (`groupOf`). A gate asks Jev once per item before it joins a call; below the gate the item
  is `skip`ped and its scope written; when Jev is unavailable (no key, `jev_checks` spent, the provider stopped —
  401, 429, 529, 5xx — or a malformed answer) the gate's plain rule decides.
- **The allowances.** A Haiku call is one `ai_runs` (however many items it carries), a Jev request one `jev_checks`;
  the month's use read at the org's start plus what this tick spent is never overspent. At either, the job makes no
  call, one `ai_run_capped:<kind>` is counted, and its scopes wait (not a failure).
- **Caps.** At most `AI_RUNS_PER_TICK = 12` Haiku calls and `JEV_CALLS_PER_TICK = 60` Jev requests per tick across
  every org, and none the budget cannot afford (`AI_CALL_COST = 1` subrequest: neither provider retries inside the
  pass). Every call goes through `budget.fetch`, so what it spent is counted. When a call it needs does not fit, the
  pass stops and the next tick resumes at that org. Measured (`test/ai.harness.test.ts`, stub providers answering
  at once): 1 org with 5 ticket cards, a repo and a session — 8 subrequests (2 Haiku, 6 Jev); 10 or 50 such orgs —
  48 subrequests a tick (the 12-Haiku cap binds), well inside 900, drained in 2 and 9 ticks.
- **Clearing** (`src/data/ai-dirty.ts`). A scope several jobs take clears when ALL of them wrote it. WRITTEN: a
  `card` row is deleted (one item, written once; a later mark makes a fresh row), any other row is kept clean
  (`last_run_at` = the tick); a mark that came in WHILE the run went keeps it dirty, its wait counting from that
  mark. FAILED (an input that threw, no answer, a refusal, `max_tokens`, nothing written): `attempts + 1` and
  `last_error` (a fixed name); after `AI_MAX_ATTEMPTS = 3` it waits until something marks it again (a mark resets
  `attempts`).
- **Isolation.** A read, `input`, `prompt` or `write` that throws is logged by name with `org=<id>` (the scope fails)
  and the loop moves on; nothing throws out of `runAiPass`.

## The cached org prefix (`src/ai/prefix.ts`)

Every Haiku prompt starts with the org's prefix — `# Organization`, `# Tag vocabulary` (its live `org_tags`, not
retired), `# Active themes` (the org's active `repo_themes`, "name: description", at most 16), `# Active sprints` (`in_progress`), `# Plan narrative` — built ONCE
per org turn (only when a Haiku call or batch request is about to be made), each part bounded and an empty part
said as "none". It goes as the request's `prefix` with `cache: true`: the first user block, carrying
`cache_control: {type: "ephemeral"}`, before the scope's input. One org per prompt: it is read through the org's own
context.

## Batches (`src/ai/batches.ts`, `0059_ai_batches`)

Non-urgent kinds — every Haiku job with `batch: true`: `themes.propose`, `themes.caption`, `themes.backfill`,
`doc.drift`, `sprint.draft`, `plan.narrative` and `digest.week` — go through Anthropic's Message Batches API (half the
price):

- **Submit.** During the tick their items are QUEUED (one item per request, past any gate, against `ai_runs`; at most
  `AI_BATCH_PER_TICK = 100`), and at its end ONE `batches.create` (one subrequest) carries them all, across orgs —
  each request exactly what a direct call sends, prefix first. `ai_run:<kind>` is counted per request BEFORE it. The
  batch and its requests are recorded (`ai_batches`, `ai_batch_requests`: PLATFORM tables, no `org_id` — a request
  names its org only in `custom_id` = `<org>:<scope>:<key>:<prompt version>`; the API's own id is `r0`, `r1`, … since
  it allows only `[A-Za-z0-9_-]`), and each scope is HELD (`last_run_at` = the tick: it reads clean, and an open
  request's scope is skipped, so no tick submits it twice). A refused submit fails the scopes.
- **Collect**, at the start of a later tick: the oldest open batches (`AI_BATCH_COLLECT_PER_TICK = 3`, 3 subrequests
  each): `retrieve`; once ended, `results`. Per result, and ONLY for an org that still exists, is not suspended and
  has the switch ON (else NOTHING is written — no row, no meter, no scope): the answer is read exactly as a direct
  call's (`answer`: a refusal, `max_tokens` or a schema miss is null), its tokens metered, the item's input re-read
  from D1, and the job's `write` stores it — the scope clears, or fails (`batch_errored` / `_expired` /
  `_canceled`, `no_answer`, `not_written`; a job gone or with a new prompt version: `batch_stale`). Then the batch
  keeps its counts (`collected`) and its request rows are deleted. A batch the provider no longer knows (404) is
  `lost`: its scopes are due again.

## Sections (`src/ai/sections.ts`)

An answer is validated ONE SECTION AT A TIME, so a bad section is dropped and the rest of the call still writes:
`sections({...})` makes each top-level field `each(...)` (`.catch` to a marker), `z.array(each(item))` does the same
per list item (a Haiku card call's 20 items), and `keep(value)` returns the valid ones and how many were dropped —
a dropped section is MISSING, never a guessed default. The JSON Schema the model is constrained by is the sections'
own; only Trov's check is per section.

## Eligibility, the allowance and the switch

`aiEligibility(ctx, env, now?)` (`src/ai/eligibility.ts`) → `ok` | `off` | `no_key` | `capped`, never throwing:
`no_key` without `ANTHROPIC_API_KEY` (nothing read); else ONE statement — `planAndAiRuns` (`src/plans/gate.ts`):
the plan, `orgs.ai_automation` and the month's `ai_run:*` — gives `off` when the switch is off, `capped` when
`planRefusal(plan, "ai_runs", used, 1)` refuses (the allowance, or an ended plan), else `ok`. A failed read is `off`.

- **`ai_runs`** (`shared/plans.ts`, monthly like `ai_summaries`): Free 250, Personal 250, Pro 2,000, Enterprise
  unlimited; overridable per org like every limit. One call is one run. It refuses nothing with a 402: past it the
  pass makes no call. It is **not listed** (`LimitDef.listed: false`, `LISTED_LIMIT_KEYS`): the pricing page, the
  Plan block and Settings › Limits leave it out until something uses it (`plans.md`).
- **`ai_chat`** (Ask Trov, `shared/plans.ts`, monthly): QUESTIONS (handoff #12) — a Fast or Smart question is 1, a
  Thinking one 5 (`ASK_MODES`, metric `ai_chat`). Free 50 and Personal 50 per org, Pro **300 per seat**, Enterprise
  unlimited. `LimitDef.per` cannot say "per seat", so `PlanDef.perSeat` (Pro: `["ai_chat"]`) does:
  `resolveEntitlements` multiplies the plan's per-seat amount by the PAID seats (the org's `seats` override, a paid
  Pro org's) or, with no paid-seat count (a gifted Pro), by the org's members, at least 1 (`PLAN_COLS` reads
  `plan_members`) — never the plan's 50-seat most — at read time, so `planRefusal` and every screen see the org's whole cap. An override of
  `ai_chat` itself is the whole cap, never multiplied. Ask writes the metric BEFORE each answer (`ask.md`). **Not
  listed**, like `ai_runs`.
- **The switches** — `orgs.ai_automation` (0055, default on): every AI feature, Sift and PR / issue summaries included. And
  `orgs.ai_chat_auto` (0058, default on): whether Ask Trov's Auto mode (writes run without a Confirm card, with Undo)
  may be used in the org. Org settings › AI, cookie routes only (`src/ai/routes.ts`, `AI_ROUTES` in
  `shared/ai-core.ts`; `organizations.md`):

| Route (`/api/o/:slug…`) | Who | Does |
|---|---|---|
| `GET /ai/settings` | any member | `AiSettings` from ONE statement (`planAndAiSettings`, `src/plans/gate.ts`): `enabled`, `chatAuto`, `canEdit` (admin+), `eligibility`, `allowances` — `ai_summaries`, `ai_runs`, `jev_checks` (Sift), `ai_chat` (Ask Trov), each `{ used, cap, resumesOn }` (`cap` from `resolveEntitlements`, so Pro's `ai_chat` is already per seat; `resumesOn` = the 1st of next month, only when that allowance is spent) — what is sent to whom (`AI_SENDS`: each line names its provider, Anthropic or TypeSafe AI) and what never is (`AI_NEVER_SENT`). A failed read is 503 `{ error }` |
| `PUT /ai/settings { enabled?, chatAuto? }` | admin+ (403 otherwise) | either switch or both (neither, another key or a wrong type is 400): `enabled` audited `org.ai`, `chatAuto` audited `org.ai_chat_auto`, in `org_admin_audit`; returns `AiSettings` |

On the screen, TypeSafe AI's model is **Sift** — never its own name; the providers' legal names appear only where
the tab says what is SENT (`web-ui.md`, the Privacy Policy).

Off means the field is MISSING on every screen — never an `"off"` state (`shared/ai-core.ts`).

## Metering (`src/data/meter.ts`, actor `ai-pass`)

Per provider, per org per UTC day in `org_usage_daily`. Counts only.

- **Claude (Haiku):** `ai_run:<kind>` — ONE per call however many items it carries, or per batch request — written
  BEFORE the call (what `ai_runs` counts, `AI_RUN_METRIC_GLOB = 'ai_run:*'`); `ai_run_failed:<kind>` (it wrote
  nothing); and Anthropic's own `ai_tokens_in` / `ai_tokens_out` / `ai_tokens_cached`.
- **Jev:** `ai_suggest` — ONE per request (a card or a gate), written BEFORE it: the metric Sift already counts and
  what `jev_checks` sums; and TypeSafe's own `ai_jev_tokens_in` / `ai_jev_tokens_out`.
- `ai_run_capped:<kind>` — a job had work but its allowance (or an ended plan) let no call start; once per job per
  org turn.

Platform › Usage reads them into `OrgUsage.ai` and `PlatformUsageResponse.ai` (`src/platform/usage.ts`) — runs,
failed, capped, Claude's tokens, and `jevChecks` / `jevTokensIn` / `jevTokensOut` (drawn as Sift checks and tokens
only when the read carries them) — when a key is set, left out without one, as summaries say they are off. None of
them is a person's request (not "active people", not "last activity").

## Jobs: importance and Sift on new items (Jev, Phase C)

- **`feed.importance`** (`src/ai/importance.ts`; scopes `card:feed:<id>`, `card:pr:<n>` — two job objects, one kind):
  ONE Jev `choice` question (`IMPORTANCE_QUESTION`: routine / notable / breaking, each option described) per item,
  one request each. Sent: a feed entry's title, brief and a 600-character scrubbed excerpt of its body
  (`feedImportanceText`); a merged PR's title and capture-time summary — what / why / impact — or, with no summary
  content, a scrubbed excerpt of its body (`prImportanceText`). A PR whose summary row is not written yet fails the
  attempt (`SummaryPending`) and a later tick retries. Stored as a COMPUTED FACT (not a suggestion) on
  `feed.importance` / `pr_summaries.importance` (`0060_ai_importance`) ONLY when Jev's `confidence` is at least
  `IMPORTANCE_MIN_CONFIDENCE` = 0.7 (the eval's choice: on 25 real items, 18 rated and all 18 right; 7 left unknown);
  below it nothing is written and the column stays NULL — unknown, never a guessed `routine` — and the card is done.
  A malformed answer is a failed attempt. An item already rated is never asked again, and a stored value is never
  overwritten (`… AND importance IS NULL`); `storePrSummary` upserts its own columns, so a re-summarized PR keeps
  its rating. A BREAKING item marks the org's primary repo `{ scope: "repo", urgent: true }` through `markDirty`,
  so the repo state skips its wait on Pro and Enterprise (› Scopes and debounce). No reason is stored or shown.
  Read by: the Feed's mark (`feed-and-search.md` › Importance), `get_feed`, My Work's merged PRs; Phase E's
  "notable or breaking" lines.
- **`tag.fit` on new items** (`src/ai/sift-items.ts`; scope `card:tagfit:<type>:<id>`): Sift's question for every
  active tag in ONE request about the new item, Sift's bands, provenance and Undo, both switches, `ai_suggest` —
  `feed-and-search.md` › Tags › Sift on NEW items. It shares the question, the bands and the writer with the run
  (`fitQuestion`, `fitBand`, `storeFit` in `src/tools/tag-fit.ts`).

Neither job imports the client (the pass asks Jev for them); both are reachable only from `src/ai/pass.ts`.

## The kinds: the ticket, Review and Unplaced cards (Jev, Phase C; `src/ai/jobs/`)

Three jobs in `AI_JOBS` (`src/ai/jobs/cards.ts`), each ONE Jev request per item, each writing `ai_suggestions` and
nothing else. The request and the decision are pure modules (`ticket-card.ts`, `review-card.ts`, `unplaced-card.ts`)
so the eval runner and the recorded-response test build exactly what the pass sends; D1 reads are
`src/data/ai-cards.ts` (this org's own full-text indexes only, never the item itself).

| Job (scope) | Kinds | The question | Accept |
|---|---|---|---|
| `ticket.card` (`card:ticket:<n>`) | `ticket.category`, `ticket.priority`, `ticket.duplicate` | ONE request with up to three `choice` questions: the category (`TICKET_CATEGORIES`), the priority (`TICKET_PRIORITIES`), and the duplicate — `ticket_<n>` for each of the TOP FIVE `tickets_fts` hits (never itself, its parent or children, or a ticket it already links) or `none` | category / priority → `set_ticket_classification` (`src/tools/tickets.ts`); duplicate → `add_ticket_link` (the other ticket's GitHub issue if mirrored, else its in-app `#tickets/<n>` address) — never closes anything |
| `review.risk` (`card:proposal:doc:<slug>:<v>` / `card:proposal:adr:<id>`) | `review.risk` | `choice`: `decision` / `contradicts` / `process` / `routine`, over the lines the proposal removes and adds (or the ADR's context, decision, rationale) and the top related live docs and ratified decisions | none (`not_available`): Dismiss only. Never promotes, rejects or ratifies; `routine` writes nothing |
| `unplaced.destination` (`card:unplaced:<id>`) | `unplaced.destination` | `choice` over the vocabulary's sections (less `needs-triage`) and the top three live docs by full text ("next to …"); a section's probability is its own option's plus its docs' | `assign_triage` as a doc in that section — exactly Unplaced's "File it", the same gate, as the person |

- **Person over AI.** A ticket's category is asked about only while it is `other` and its priority only while it
  is `normal` (what the form files when nobody picks; a person who picked either is indistinguishable and is left
  alone); a kind a person already accepted or dismissed for the item (`decidedKinds`) is never asked again; a
  closed ticket, a gone item, an Unplaced item that is not a doc (no slug and body) is not asked about at all.
- **Candidates only.** A duplicate or a destination is only ever one of the options OFFERED; anything else counts
  for nothing (the parser already refuses an option outside the question).
- **Thresholds** (chosen on the eval sets): category 0.7, priority 0.75, duplicate 0.9, risk 0.6, destination 0.55.
  Below one, or the value the item already has, writes nothing and the scope is still cleared.
- **Reasons are Trov's evidence**: the ticket's own words around a word matching the answer (else its title); the
  words two tickets share (else the candidate's full-text snippet); the lines a proposal removes / adds or the
  decision an ADR records, plus the related doc or decision cited; the snippet an Unplaced item shares with the
  nearby doc, or the section the agent filed it under. No reason → no suggestion.
- **The screens** (cookie reads only, `src/ai/attach.ts`): `GET /tickets/:id` carries `TicketDetail.ai?`,
  `GET /needs-triage` each row's `ai?`, `GET /proposals` / `GET /adrs` each item's `ai?` — open suggestions only,
  only while the switch is on (`openSuggestions` joins `orgs.ai_automation`); a failed read returns the rows as they
  were. MCP's `get_ticket` never carries the field. Drawn by `web/src/ai-cards.ts` (chips with Accept / Dismiss on
  the ticket detail and on an Unplaced item; a quiet risk line on Review with Dismiss only).

## Session digests (`src/ai/digests.ts`, `0061_ai_digests`; Phase D)

What one person's burst of work on one repository shipped, or where it stands — a `Shipped:` / `Status:` feed entry
written by Trov, so agents record only what a session alone knows (`record-session` now writes decisions, findings
and incidents, citing its commits). The job `digest.session` takes the router's `session:<repo>:<login>` scope (a
push, PR opened, run, check or deploy by that login), which closes 45 minutes after its last event.

1. **The burst** (`sessionInput`, D1 only): the login's `repo_events` captured since its last `ai_sessions` row (or
   since the scope went stale) — the pushes' commits (short sha, subject, branch; distinct only; newest first, at
   most 40) and its PRs (at most 12): a MERGED one as its card (`pr_summaries` what / why / impact), an open one by
   its title. Never a PR body, a diff or a commit body. Runs and checks alone are no burst (nothing to digest:
   the scope clears, no row). `shipped` = a merged PR, or commits pushed to `main` / `master` / an environment's
   branch — only then may the type be `Shipped`. `subject` = the member the login is in this org
   (`resolvePersonForLogin`), else null.
2. **Dedupe, with ZERO model calls** (`agentCovered`): an AGENT entry (`origin = 'agent'`, the last 24 h before the
   burst onwards) whose `artifacts.commits` (compared by their first 7 characters) or `artifacts.prs` meet the
   burst's covers it — UNLESS its type is `Decision:` / `Finding:` / `Incident:` / `Triage:`, which is not a record
   of what shipped (the new `record-session` writes exactly those, citing its commits, and they must not suppress
   the digest). Covered: `ai_sessions` `skipped` / `agent_recorded`, the scope written, no Jev, no Haiku. The other
   direction — an agent records the same commits AFTER the digest — writes both: the agent's entry is never held
   back (the gate never refuses a person's write over Trov's), and the 45-minute wait gives a session-end
   `record_session` the time to land first.
3. **`gate.session`** (Jev, one `noul` over the commit subjects and PR titles: substantive?) — below
   `SESSION_GATE_MIN` (0.5) no digest, `ai_sessions` `skipped` / `not_substantive`. Without Jev (no key, the
   allowance spent, the provider stopped, a malformed answer): the plain rule — a PR, or 3+ commits.
4. **`digest.session`** (Haiku, `output_config.format`, the org prefix first; `DigestSchema`, one section per field):
   `type`, `summary`, `brief`, the labelled fields (`what` / `why` / `impact` / `follow_up` for Shipped, `state` /
   `blocked_on` / `next` for Status), `tags` (from the prefix's vocabulary) and `cites` (`sha:<7>` / `pr:<n>`).
   `cites` may name every ref the input carries (40 commits + 12 PRs: a lower cap made the schema drop a whole
   answer that cited them all — found by the eval). The prompt asks for a summary of at most 90 characters.
   **`checkDigest`** (pure) writes it only when: the summary starts with `<type>: ` and fits 100 characters; the
   type is `Shipped` only for a `shipped` burst; the brief (≤ 280) carries no `#n`, sha or `pr:` / `sha:` ref; no
   number in the summary or brief that the input does not write (a sha's digits do not count); at least ONE cite
   that was in the input (the rest dropped). Over-length is discarded, never cut. An optional field with an
   invented number is dropped alone. A refusal or `max_tokens` is no answer: nothing is written, the scope fails.
5. **The write** (`writeDigest`): the server renders the body in the record-session format (`**What** …`, then
   "Written by Trov from N commits in <repo>. Not reviewed by a person.") and `artifacts` from the kept cites,
   and calls **`ingestFeedEntry(ctx, entry, "trov", ledger, { model, subject })`** — THE GATE, the one author
   exception (`ingestion-gate.md`). Then `ai_sessions` is `done` with the entry's id.

**`ai_sessions`** (0061; `ORG_TABLES`, the reset seed): PK `(org_id, repo, actor_login, started_at)`; `ended_at`,
`status` (`done` | `skipped`), `reason` (`not_substantive` | `agent_recorded`), `shas` / `prs` (JSON), `feed_id`,
`model`, `prompt_version`. `actor_login` is a GitHub login, not a handle: an account's deletion deletes the rows of
its logins (`src/deletion/person.ts`); its digests stay as content with `subject` tombstoned (`HANDLE_COLUMNS`).

**The `trov` person** (0061): `persons` row like `github-webhook`'s; reserved (`RESERVED_HANDLES`: no sign-up,
rename to or from); never a member (the reset seed's memberships skip it), never listed (`listPersons`), never a
person card (`memberPerson`), never counted as a person (Platform), and `accountDeletionPreview` answers not found
for any reserved handle, so neither Settings nor Platform can delete it.

## Repo state (`src/ai/repo-state.ts`, `src/tools/repo-state.ts`, `0062_repo_state`; Phase D)

Where the org's repository stands — a headline and three lists of at most 5 (shipped recently, in flight, needs
attention), each line with its cites — what Repo › Overview's State, `get_repo_dashboard`'s `state` and the
`load-context` skill read FIRST. The job `repo.state` takes `repo:<repo>` (debounced 60 min on Pro / Enterprise —
a breaking change skips it — 6 h otherwise).

1. **The input, INCREMENTAL** (`stateInput`, D1 only): the newest version (its lines and their resolved cites —
   valid cites again) and, since its `basis_until` (14 days for the first): merged PRs as their cards (`events`
   `pr_merged` ⋈ `pr_summaries`), Trov's digests for the repo (`feed` ⋈ `ai_sessions`); and now: the open PRs (each
   PR's newest `repo_events` row, 30 days), the default branches' failing workflows (each workflow's newest run on
   `main` / `master` / an environment's branch), every environment PART's newest `hosting_deploys` row and last
   `hosting_poll_state` status (#185: every host is a provider), and the deploys since. Every ref the model may cite
   is built HERE with its cite (`pr:<n>`, `run:<id>`, `feed:<id>` → `#feed`, `deploy:<env>/<part>` → the deploy's
   inspect link). A deploy cite names its host by the part's label (`<env label> <part label>`, from
   `org_environment_parts.label` — the label RepoFacts draws), never a provider id; a deploy of a part no longer
   configured is left out (Q62). `eventCount` = merged + digests + new default-branch failures + deploys since.
2. **`gate.state`** (Jev, one `noul` over the delta: did it change what is shipped, in flight or needing
   attention?) — below `STATE_GATE_MIN` (0.5) no call, nothing written, the scope clears. Without Jev: a merged
   PR, a deploy, or a red default branch. What Jev reads (`stateGateText`) is a merged PR with its card's `what`,
   a digest with its brief and a deploy WITH the commit it shipped — with titles alone Jev scored 8/19 on the eval
   (it could not tell a release-notes deploy from a feature); with them, 18/19.
3. **`repo.state`** (Haiku, structured, the org prefix first; `StateSchema`: `headline` and each list's lines
   checked one at a time). **`checkState`** keeps a line only with ≥ 1 cite from the input (resolved to the
   server's own `AiCite`, the rest dropped), no number the input lacks and no ref written INTO its sentence
   (`writesRef`: "pr:178" in a headline is the model's syntax, never shown to a person — dropped, not cleaned);
   at most 5 per list; a headline over 200 characters, with an invented number or a ref is dropped. Nothing left at all → not written (the scope fails).
4. **The write** — computed, direct (`appendRepoState`): version N+1 and every version older than the last 20
   deleted, in ONE batch.

**The read** (`readRepoState`, MCP-reachable, imports nothing from `src/ai/`): absent with no repo, the switch off,
nothing written, a row that no longer parses, the viewer's "Wrong?" on that version
(`aiItemRef.repoState(repo, generatedAt)`), or a failed read; `capped` once the month's `ai_runs` are spent (the
last state, `resumesOn`, `upgrade` on Free); else `ready`. Two statements (plus "Wrong?"'s with a viewer).

## The brief (`brief.person`, Phase D, #163; `src/ai/brief.ts`, `src/ai/brief-core.ts`, `0063_person_brief`)

My Work's "Your brief" — ONE Haiku call per person, on the scope `person:<handle>` (stage "briefs"; marked by a PR
merged, a failure on their PR, a ticket assigned / moved, a handoff sent, an agent feed entry, and URGENT by the
digest pre-warm one tick before the send hour). Every prompt is led by the cached org prefix; the answer is
structured (`BriefAnswerSchema`, each part checked on its own: `sections`).

- **The input** (`buildBriefInput`, D1 only, the org's PRIMARY repository for GitHub activity, so a PR is `pr:<n>`):
  - **Now** — their open PRs (the latest `repo_events` row per PR is `draft` / `review`, authored by a login the org
    attributes to them, last event within 60 days; at most 8), each with its failing runs (the latest run per
    workflow on its branch is `failure` / `timed_out`) and red checks (on its head sha), and their latest `Status:`
    session note or digest (summary starts "Status:", last 7 days).
  - **Recently** — the last 7 days of their session notes (their own agent entries, the handoff announcements left
    out, AND the session digests Trov wrote for them: `origin = 'ai'`, author `trov`, `subject` = the member — Q61)
    and merged-PR CARDS (`pr_summaries`' title / what / impact, the PR's own title and link — never a raw PR body).
    A digest for them marks `person:<subject>` (the router), so the brief follows it.
  - **Next** — ONLY items the server OFFERS, in the server's order (`orderNext`, by `NEXT_RULES`): **overdue** (an
    assigned open ticket whose sprint, not done, is past its date — `sprintDueState`), **blocked** (a failing run on
    their open PR), **waiting** (a pending, unexpired handoff someone else left for them, then one left for anyone),
    **due soon** (an assigned ticket whose sprint is due within 7 days), then **assigned** (handoffs they left for
    themselves, then their other assigned open tickets of both sources: in progress → testing → not started, high
    priority first, most recently updated). The top `AI_LIST_MAX` (5) are offered, each with its own title (a
    ticket's title, a handoff's first line, a run's job title) and the server's plain facts.
  - Every citable ref carries the cite the SERVER built (`#12` → the PR's URL, `CI run 4812`, `#14` →
    `#tickets/14`, `handoff #3`, a feed entry → `#feed`); headings carry the server's counts ("Open pull
    requests (2)") — the only counts the model may use.
- **The answer and the server's checks** (`briefFromAnswer`): `now` and `recently` are kept only when the input
  has something for them, their text is ≤ `BRIEF_LINE_MAX` (400) — dropped, never cut — has NO ref written into it
  (`REF_IN_TEXT`) and no number the input does not have (`numbersGrounded`: a whole date only if the input has it,
  digits only if the input has them outside a date and a feed ref, a count in words only if the input says it in
  words or digits), and at least one cite that is a ref of the input (an invented cite is dropped). **Next is the
  server's list**: an item the model names that was not offered is dropped, its order is ignored, and each offered
  item's "why" is the model's when it passes the same checks (≤ `BRIEF_WHY_MAX`, 160) — else the server's own
  plain sentence ("Its sprint, Hosting, was due 2026-10-12."). Nothing valid at all writes nothing (a failed
  attempt); a `refusal` or `max_tokens` is no answer (the client's rule): nothing written, `attempts + 1`.
- **Only for people who need it** (`briefWanted`, `src/data/person-brief.ts`): a MEMBER who opened My Work in the
  last 14 days (`memberships.mywork_opened_at`, written by `GET /me/dashboard` at most once an hour — never a model
  call; `get_my_work` does not count) or who receives the digest (an address on file, not unsubscribed: the rule of
  `digestRecipients`, asked for one person). Anyone else: `input` is null — no call, the scope written.
- **No call when nothing changed**: `input_hash` (SHA-256 of the prompt version and the scope's input) equal to the
  newest stored row's → null. **Nothing left to say** (no open PR, no note, no card, nothing offered) while the
  newest stored brief said something → an EMPTY version (`model` NULL) is stored without a call, so My Work stops
  showing what is no longer true.
- **Storage** (`person_brief`, 0063): append-only versions per (org, handle), the newest 5 kept (`storeBrief`: the
  insert and the trim in ONE batch). In `ORG_TABLES`, `HANDLE_COLUMNS` and the reset seed; deleting the account
  DELETES the person's rows (`src/deletion/person.ts`), never hands them to the tombstone.
- **The read** (`storedBrief`, `src/tools/mywork.ts`, plain D1 — reachable from MCP, so it imports nothing from
  `src/ai/`): the newest row → `AiBrief`; ABSENT when the switch is off, there is none, it fails `AiBriefSchema`,
  or the person pressed "Wrong?" on that version; `capped` (with `resumesOn`, `upgrade` on Free) when `ai_runs` are
  spent; `empty` for a no-model version. `GET /me/dashboard`, `get_my_work` and — Phase E — the e-mail read it.

## Themes — "Where the work went" (Phase D; `src/ai/themes.ts`, `src/ai/themes-accept.ts`, `src/tools/themes.ts`, `src/data/themes.ts`, `0064_repo_themes`)

One lane per theme of the org's PRIMARY repository, a band per UTC Monday week sized by merged PRs. The model names
themes and sorts PRs into them; an admin approves the themes; the server counts.

- **Tables** (`0064_repo_themes`, all in `ORG_TABLES` and the reset seed): `repo_themes` (`proposed` → `active` |
  `removed`; name unique among the repo's live themes; colour a `--p-*` key the SERVER picks; `seed_prs` the PRs the
  proposal cited; `merged_into`; `created_by` = `trov` for a proposal and `decided_by` in `HANDLE_COLUMNS`),
  `pr_themes` (one row per (repo, PR), `source` `ai` | `person`, `set_by` in `HANDLE_COLUMNS`), `repo_theme_captions`
  (the last 10 per (repo, range), with the `basis_hash` of the shares they were written from). PRs are read from
  `events` (`pr_merged`) by ORG — `events.repo` still holds 0042's constant default.
- **`themes.propose`** (Haiku, Batch API, scope `theme_window:<repo>`, `promptVersion` `propose-1`): only when the repo
  is the org's primary, has ≥ 15 CARDED PRs (a `pr_summaries` row with `what`) merged in 12 weeks, no proposal in the
  last 30 days (the first time, then monthly — additions only: the active themes are listed as "do not repeat") and
  none waiting on an admin; at most 8 live themes. Input: up to 120 PR cards (number, card title, what — never a body).
  Output `{ themes: [{ name, description, prs }] }`, per theme (`checkProposal`): the name 1–40 characters, not taken;
  only PR numbers from the input; ≥ 3 of them or the theme is not written. Each written theme is a `proposed` row and an
  `ai_suggestions` row (item `theme` / `<repo>#<id>`, kind `themes.propose`, reason = its description, cites = its PRs).
- **The admin's answers** (cookie routes, `src/ai/themes-accept.ts`; the handler's `role` and `dismissRole` are
  `admin`): Accept `{}` (active as proposed), Rename `{ value: { name } }` (a live theme's name → `invalid`), Merge
  `{ value: { mergeInto } }` (another live theme of the repo: this one is removed, its PRs join), Remove = dismiss.
  Accept, Rename and a Merge into an active theme route `themes_accepted` → `theme_backfill:<repo>`.
- **`pr.theme`** (Jev, `card:pr:<n>`, `pr-theme-1`): once the repo has an active theme, ONE `choice` request per merged PR
  — the active themes (described) plus `(none of these)`; the state is the PR's card (title, what, why, impact), each part through `excerptOf` (no code, no link targets,
  nothing shaped like a credential — what the Privacy Policy says TypeSafe AI is sent). A pick
  at ≥ 0.5 confidence is written `source='ai'` with the confidence (`prThemePick`); none-of-these or below is answered
  and writes nothing. A PR a PERSON themed is never asked about; every AI write is an upsert guarded by
  `WHERE pr_themes.source <> 'person'`.
- **`themes.backfill`** (Haiku, Batch API, `theme_backfill:<repo>`): up to 100 PRs of the 12-week window that have no
  theme, or an AI theme set before the newest acceptance — never a person's; output `{ prs: [{ pr, theme_id | null }] }`,
  a pick outside the input or the active ids dropped (`checkBackfill`).
- **`themes.caption`** (Haiku, Batch API, `theme_window:<repo>`): the SERVER computes each active theme's share of the
  merged PRs per week of the 8 and per half (`captionBasis`) and passes them in; output `{ caption, theme_ids }`.
  DISCARDED (`checkCaption`: nothing stored, the scope fails) when it has a digit (any script), names a theme id that is
  not active or the name of a proposed / removed theme (unless an active name contains it), names none, or is outside
  20–280 characters. The same shares as the stored caption make no call.
- **The read** (`readRepoThemes`, from `getRepoDashboard` — so the screen and `get_repo_dashboard`'s planning tab): 8 weeks
  and a quarter (13), each `AiThemes` with active lanes (PRs counted from `pr_themes`) and proposed lanes that have an
  OPEN suggestion (counted from `seed_prs`, `suggestionId` set), at most 8; `prCount` = the PRs drawn; the newest caption
  on the 8-week range only, and only while every theme it names is still active. ABSENT when the switch is off, there is
  no repository, or neither an active theme nor a waiting proposal exists; a failed read leaves it out and marks the
  dashboard `degraded`. A range the READER marked "Wrong?" (`aiItemRef.themes(repo, range, generatedAt)`) is left out
  for them (`hiddenFor`), so the field is `Partial<Record<AiThemeRange, AiThemes>>` — the screen keeps the card and its
  8 weeks / Quarter switch, saying the picked range is hidden, while the other is there; both flagged → absent; a newer
  version (a new caption, a new theme) is a new ref and comes back. Deciding a proposal re-reads the dashboard
  (`AiHost.reloadRepo`), so the lane shows what it became.
- **`themeShares(ctx, repo, from, to)`** (`src/tools/themes.ts`) — each active theme's share of the PRs merged in a
  window, null with no active theme: the read the Roadmap's drift calls.
- **Local**: `fixtures/dev/themes.json` + `scripts/seed/themes-dev.mjs` (appended by `scripts/seed-dev.mjs`) seed four
  active themes, a person's pick, a caption and a proposal; `LOCAL_AI_PREVIEW` still overrides the field with fixtures.

## The Roadmap (Phase D, Feature E; `src/ai/roadmap.ts`, `src/ai/roadmap-accept.ts`, `0065_org_insights`)

| job | kind | scope | how | writes |
| --- | --- | --- | --- | --- |
| `roadmap.sprint_note` | `org.rollup` | `sprint:<id>` | direct, ≤10 sprints a call | `org_insights` `sprint_note` — an ACTIVE sprint's one line |
| `roadmap.plan_drift` | `org.rollup` | `org` | direct | `org_insights` `plan_drift` — only when a theme of ≥25% of the merged PRs is in no active sprint |
| `roadmap.sprint_draft` | `sprint.draft` | `org` | Batch API | `ai_suggestions` `sprint_draft` — ≥8 open tickets outside every sprint and none active; at most one a week |
| `roadmap.plan_narrative` | `plan.narrative` | `org` | Batch API | `ai_suggestions` `plan_narrative` — weekly |

- **The forecast is not here**: `sprintForecast` (`src/tools/sprints.ts`) is arithmetic on read — closed tickets
  per day since the start, carried over the open ones, against the due day; null when unknown. No model.
- **The drift's numbers are the server's**: `themeShares` reads the themes module's per-repo shares (`themeShares`,
  `src/tools/themes.ts` — 0064's `repo_themes` / `pr_themes`) for the primary repository over `AI_DRIFT_WINDOW_DAYS` (14), rounds them (`toAiThemeShares`) and marks
  which an active sprint holds (its tickets' linked PRs, by theme). No active theme, nothing merged, no primary
  repo → null: no call, nothing said. The model is given the shares and words them.
- **Grounding** (`src/ai/grounding.ts`, every line of every job): cites only from the refs the input offered (the
  server builds each `AiCite`); every number stated must be one the input gave (digits and number words); a ref
  written in the text (`ticket:14`) states no number, is shown as its label (`#14`), and one not offered drops the
  line; people's words go fenced as data (a document as its own text, `fencedText`). A note claiming the sprint is
  done is dropped. Nothing here marks work done (invariant 5).
- **Reads**: `org_insights` (newest of the last 10 versions per key) joins `orgs.ai_automation = 1`, so with the
  switch off every field is ABSENT. `SprintView.note?` (active sprints only) and `PlanView.drift?` (until its
  window passes) come with `GET /roadmap`, `GET /sprints` and MCP `get_roadmap`; `PlanView.suggestions?` (the open
  Roadmap suggestions) only with the cookie `GET /roadmap`, only for an admin. "Wrong?" on a note or the drift
  hides it for that person (`roadmapForPerson`, `src/data/org-insights.ts`).
- **Accept** runs the existing writers AS the admin who pressed it: a draft → `create_sprint` per sprint (created
  upcoming), then `set_ticket_sprint` for each of its tickets still open in the backlog (never moved out of another
  sprint); a narrative → `write_plan` with the narrative and no sprint entries (versioned like any plan write).
- The UI: `web/src/roadmap-ai.ts` over the AI kit (`aiByline`, `aiCites`, `aiWrongBtn`, `aiSuggestionChip`) — a
  forecast and a note on each active sprint card, the drift line under the narrative, an admin's cards above it.

## Doc drift (#161; `src/ai/doc-drift.ts`)

Scope `doc_drift:<slug>` (marked by a doc promote; weekly on Pro / Enterprise, monthly otherwise), Batch API, behind
**`gate.drift`**: Jev `noul` ("does an entry show something this doc states is no longer true?", with criteria) over
the entries and the doc's paragraphs that share words with them (`gateState`, ≤4,000 characters — a doc's stale
sentence is usually far from its opening); below `DRIFT_GATE_MIN` (0.6) no Haiku call; without Jev the rule is SKIP.
The input is the live doc and up to six feed entries since its last promote (≤30 days) that its full-text index
matches against its title — none, no call; Trov's own entries are never evidence; a doc with a Trov proposal still
staged is not checked again. Haiku answers edits (`find` an exact passage, `replace`, `cites`); the SERVER applies
them (`applyDrift`: a passage not in the doc exactly once, a number not given or no valid cite drops the edit) and
the result goes **through the gate**: `ingestDocProposal` at `confidence: "low"`, authored by `trov`
(`TROV_SYSTEM_HANDLE`, the documented exception to "the author is the principal"). Staged and flagged; only a
person promotes or rejects it. An artifact's scope has no doc: null, cleared.

## The weekly highlights (`digest.week`, Phase E; `src/ai/week.ts`, `src/ai/week-core.ts`, 0067)

The weekly e-mail's "This week" (`notifications.md` › The digest's shape): at most 3 cited highlights of ONE
organization's week, written ONCE per org per week and shared by every member's weekly e-mail. A Haiku job
(`KIND_PROVIDER["digest.week"] = "claude"`) on the scope `digest:week:<YYYY-Www>:<send instant>` (`weekScopeKey`;
the key carries the send instant so the submit and the collect read the same window), through the Message Batches
API (`batch: true`, half the price), the pass's last stage.

- **Marked** by the digest pre-warm (`prewarmDigests`) `WEEK_HIGHLIGHTS_LEAD_MS` = 3 h before the org's weekly send,
  only with `week_recap` on and someone to send to. The Batch API answers on a later tick, usually within the hour;
  a week whose answer is not back by the send has no highlights (never a guess).
- **Input** (`buildWeekInput`, D1 only): the week's merged PRs on the primary repo (the summary card's title and what
  changed, Sift's `importance`), the Feed's entries as `get_feed` reads them (handoff lines left out), tickets a
  person marked done, sprints completed — each with a ref and the server's cite; ordered breaking, notable, then the
  rest, newest first; capped at 50 items.
- **Once a week**: `input` reads null — no request — for a week that already has a row; the pass never submits a
  scope whose request is in flight; `storeWeekHighlights` keeps the first answer (`INSERT OR IGNORE`) and the last 8
  weeks. A week with nothing in it makes no request.
- **Never guess** (`weekFromAnswer`): a cite not in the input is dropped and a highlight with no valid cite is not
  written; a highlight with a number the input does not have, a ref in its text, or over 220 characters is dropped
  (never cut); at most 3. The numbers line under it is the SERVER's (`renderers/week-recap.ts`), never the model's.
- **Read** by the weekly e-mail only, while the org's switch is on; it never calls a model.

## Suggestions and "Wrong?" (0055)

- **`ai_suggestions`** — a suggested value for one field of one item, with a REQUIRED reason, its cites, model and
  prompt version; `open` → `accepted` | `dismissed` (a person's decision, remembered) | `superseded` (a re-run of
  the same kind for the same item replaces the OPEN one: `putSuggestion`, `src/data/ai.ts`). Phase C's cards write
  them (› The kinds), theme proposals (kind `themes.propose`) and the Roadmap's two
  kinds (› The Roadmap). A value that is an
  object names itself with a `label` (`suggestionDto`).
- **Accept** — `POST /ai/suggestions/:id/accept { value? }` (`:id` is the row id; another org's id is
  `not_found`). In order: `not_found` (404) → `not_open` (409) → `not_available` (409: no handler for the kind) →
  `forbidden` (403: below the handler's role) → `invalid` (400: a body the contract refuses). Then the row is claimed by one guarded UPDATE, the handler writes the
  real field AS the cookie person, and on its throw the claim is undone. `AI_ACCEPT_HANDLERS` (`src/ai/suggestions.ts`)
  holds Phase C's (`src/ai/jobs/accept.ts`), the theme handlers (kind `themes.propose`) and the Roadmap's `sprint_draft` /
  `plan_narrative` (admin; `src/ai/roadmap-accept.ts`); a kind with none
  (`review.risk`) is `not_available`. A handler gets the request's origin too (`AcceptRequest`: the in-app address a
  duplicate link points at). **A handler names its `role`**: `member` (anyone in the org)
  or `admin`; **dismiss is open to every member** (`POST /ai/suggestions/:id/dismiss`) unless the handler names a `dismissRole` (a theme's
  Remove is an admin's), and a handler may also act on a dismissal (`dismissed`), check a value before the claim (`valid`:
  `invalid` 400) and refuse with a code (`AcceptRefused`) — `src/ai/accept.ts`. A refusal is never a 500: Phase C's
  handlers check their value in `valid` and answer a writer's refusal after the claim (the ticket or triage item
  gone) as `not_available` / `invalid` / `forbidden` (`refusing`, `src/ai/jobs/accept.ts`); a Roadmap writer refusing
  (`SprintError` / `TicketError` / `PersonError`) is a 400 `invalid` with the writer's message. Theme accept / rename /
  remove go through the same two routes.
- **"Wrong?"** — `POST /ai/feedback` (`AiFeedbackBody`) records `ai_feedback` for the cookie person, ONE row per
  (person, item), idempotent; it hides the item for that person (`hiddenFor(ctx, handle, itemType)`, what a
  producer reads) and never edits the record.
- Both tables are in `ORG_TABLES` and the reset seed; `ai_suggestions.decided_by` and `ai_feedback.handle` are in
  `HANDLE_COLUMNS`. Every route refuses a request carrying an `Authorization` header (`cookieOnly`); none is an MCP
  tool and none has an old-path alias.

## The plain-language filter (#162; `src/ai/filter.ts`)

"Show my open high-priority bugs" becomes the screen's OWN filter controls, filled in — **filters, never results**:
the model cannot invent an item, because it returns no item. Three screens: Tickets, the Feed, Artifacts.

- **One schema per screen, defined once** (`shared/ai-filter.ts`, values in the zod-free `shared/ai-filter-core.ts`),
  from the controls the screen really has: Tickets — `status` (the Open / Closed / All switch), `assignee`
  (anyone / me / unassigned) or one `person`, `category`, `priority`, `sprint` ("backlog" or an id), `text` (the
  search box); the Feed — `author`, `tag`, `range` (24h / 7d / all; it has no search box); Artifacts — `area`,
  `kind`, `author`, `status`, `sprint`, `text`. No "overdue" or "label": the screens filter by neither.
- **`POST /api/o/:slug/ai/filter { screen, text }`** (cookie only, any member; `text` ≤ 300). Gates in order, each
  refusing before anything is spent: the body (400 `invalid`); the org switch (403 `off`); the key (503 `no_key`);
  the month's `ai_runs` (the house 402 `plan_limit`, and one `ai_run_capped:filter`); the person's `ai_filter` rate
  (60 an hour, 429 — `abuse-limits.md`). A failed read is 503 `{ error }`.
- **ONE Haiku call** (kind `filter`, effort low, no temperature), counted `ai_run:filter` BEFORE it (actor
  `ai-filter`), then `ai_run_failed:filter` when no answer came and the provider's token counts. Its output format IS
  the screen's schema with each field made forgiving (`catch`, which adds no JSON Schema keyword), so one bad field
  cannot sink the rest; plus `unmatched`. The input lists the org's members (handle, name), sprints (id, title) or
  tags — only this org's — and the request between nonce-delimited markers, read as data.
- **The server checks every field again** (`resolveFilter`, pure): each is parsed on its own against the schema (a
  value it refuses, or a key it does not have, is dropped); a NAME must be a real row of the org — `me` is the
  caller, a handle or tag name matches exactly (case aside), a sprint matches its id or its exact title (one), never
  by likeness — or it is dropped. `unmatched` keeps only phrases quoted from the request (a dropped name too, when
  the request said it): the screen shows them as "Not a filter here: “overdue”", never model prose.
- **Unreadable**: nothing left to set, a `refusal`, an answer cut at `max_tokens`, no JSON, or an error → 422
  `{ error: "unreadable", message }` in plain words (naming the request's words that were no filter here).
- **The box** (`web/src/ai-filter.ts`, acts in `web/src/ai-filter-actions.ts`; `web-ui.md`): above each screen's
  toolbar, shown only when `GET /ai/settings` (read once per org on entering the screen) says the switch is on and
  there is a key — off is no box. Typing keeps a draft without a repaint; Enter or Apply calls the route; the answer
  REPLACES the screen's filter state (`applyAiFilter` in `main.ts` — a field left out is "no filter"), so the
  result is what the person would get setting those filters by hand, each visible in the Filter menu. A line says
  what was set and what was not a filter here, with Undo back to the filters set by hand.
- **`LOCAL_AI_PREVIEW`** answers from `aiFilterFixture` (`shared/ai-fixtures.ts`), checked by `resolveFilter` like a
  model's answer, with no key, no call and no count; `empty` is unreadable, `capped` the 402. The switch still holds.
- Tests: `test/ai.filter.test.ts` (the call, the gates, the checks, the preview), `test/render.ai-filter.test.ts`.

## Ask Trov (`src/ai/ask/`; in full: `ask.md`)

The fifth call site. `POST /api/o/:slug/ask` (cookie only) streams one answer over SSE in one of three modes —
Fast (`claude-haiku-5-5`, the index tools only, 3 calls, counts 1), Smart (`claude-sonnet-5-5`, the full catalog,
8 calls, counts 1; the default, and the only mode on Free and Personal) and Thinking (`claude-opus-5-5` with adaptive
thinking, 8 calls, 90 s, counts 5) — gated by the org switch and `ai_chat` (› Eligibility). Its tools are the MCP
catalog (the same `src/tools/*` functions, as the cookie person) less a short exclusion list; reads run freely and
every write is a confirm card (`chat_actions`), or runs at once in Auto (at most 5 a turn, with Undo; never
`update_plan`). Ask imports nothing from `src/mcp.ts`, secrets, the GitHub App or billing (`test/secrets.mcp.test.ts`).
Attachments are stored as private artifacts before the model sees them. The screen — the Ask page, the ⌘J panel, the
composer, the inspector, Settings › Trov — is built from Andres's design (handoff #12): `ask.md` › The screen.

## The e-mails (Phase E; in full: `notifications.md` › The digest's shape)

The digests read what the pass stored and call no model while they render: the daily leads with **Your brief** (the
SAME stored brief My Work shows, `storedBrief`; its subject is the brief's top Next item), then **Also** (at most 3
items Sift rated notable or breaking that touched the person's work, from `feed.importance` /
`pr_summaries.importance`) and one line per queue (Review counts `review.risk` "changes a decision" while AI is on).
The weekly adds **This week** (`digest.week`, › Kinds by provider). The router pre-warms each recipient's brief one
tick before the send hour (`person:<handle>`, urgent) and marks the weekly 3 hours ahead. "Only when something needs
me" (`notification_person_prefs`) sends only when the brief has a Next item or a notable / breaking item touched the
person's work. With AI off the same e-mail is built from plain reads (the three most recent assigned items).

## The screens' fields

The contracts are typed (`shared/ai-core.ts`, schemas in `shared/ai.ts`): `DashboardData.brief?` (`/me/dashboard`,
`get_my_work`), `RepoDashboard.state?` / `themes?` (`/repo/dashboard`, `get_repo_dashboard`), `FeedRow.ai?` (`/feed`,
`get_feed`), plus the cards' `ai?` on the ticket detail, Unplaced and Review (› The kinds), the Roadmap's
`SprintView.note?` / `PlanView.drift?` / `suggestions?` (› The Roadmap) and `feed.importance`. Every producer exists:
each field is present only when its producer wrote something, the switch is on and the reader did not press "Wrong?"
on it — off or nothing written is a MISSING field, never an "off" state. `get_repo_dashboard` carries `state` with `tab: overview` (or no
tab) and `themes` with `planning` (or no tab) when the dashboard has them — they are not sections, so
`REPO_TAB_SECTIONS` does not name them (`src/tools/repo-agent.ts`).

**`LOCAL_AI_PREVIEW`** (`src/ai/preview.ts`, `env.md` › Local development only) fills four cookie reads from
`shared/ai-fixtures.ts` — the brief, `state` + `themes`, two feed entries merged by `created_at`, and Org settings ›
AI's numbers (`aiSettingsFixture`: all four allowances and the eligibility of a 5-seat Pro org — partway through the
month in `ready` / `proposed`, nothing used in `empty`, every allowance used up in `capped`; the switches stay the
org's real ones, and what is sent names both providers in every mode) — when it names a mode (`ready` / `empty` /
`capped` / `proposed`), the request came to a loopback `http://` origin (what `wrangler dev` serves on; no deployed
Worker is reached there) and no live Stripe key is set. Never over MCP. It also answers the plain-language filter route
from its fixtures (above). And it puts Phase C's sample suggestions on the REAL rows of the ticket detail, Unplaced and
Review (`ticketSuggestionsFixture`, `unplacedSuggestionFixture`, `reviewRiskFixture`; made-up ids, so Accept and
Dismiss answer `not_found`) while the switch is on, in `ready` / `proposed`.

## Evals (`test/ai-evals/<kind>/`)

Every kind the pass runs ships an eval set — real items from Personal Dev and this repository, labelled by hand
(Jev: the expected answer; Haiku: the input and the grading rules — cites offered, no invented number, no ref in a
sentence, the lengths, the type the input calls for) — run LIVE by hand once (keys read from a `.dev.vars` path at run
time, never stored), its raw response bodies recorded in `<kind>/recorded.json` with a hash of what was sent, and a
CI test that replays them at the `Response` level through THE client and the REAL job code. A changed question,
prompt or input fails the replay ("record again"); a kind's prompt or threshold changes only with its set passing.

| Kinds | Cases | Live (2026-10-15) | CI floor | Runner (live) | Replay (CI) |
|---|---|---|---|---|---|
| `feed.importance` | 25 | 18 rated at 0.7, 18 right; 7 left unknown | the decisions as recorded | `scripts/ai-evals/run-live.ts` | `test/ai.evals.test.ts` |
| `tag.fit` (new items) | 16 docs × 6 tags | 9/11 clear fits added or suggested; 33/33 non-fits left alone | as recorded | `scripts/ai-evals/run-live.ts` | `test/ai.evals.test.ts` |
| `ticket.category` / `.priority` / `.duplicate`, `review.risk`, `unplaced.destination` | 48 / 48 / 22 / 18 / 20 | 96% / 98% / 95% / 61% (no wrong risk written) / 85% | every request and decision as recorded | `node scripts/ai-evals/run.mjs record` (`score` sweeps thresholds offline) | `test/ai.evals.cards.test.ts` |
| `pr.theme`, `themes.caption` | 39, 6 windows | 38/39; 6/6 kept by the rules | 0.9; 1.0 | `test/ai-evals/run-live.mjs` | `test/ai-evals.themes.test.ts` |
| `gate.session`, `digest.session`, `gate.state`, `repo.state` | 17, 10, 19, 8 | 17/17 (plain rule 14/17); 10/10; 18/19 (plain rule 12/19); 8/8 | 0.9, 0.9, 0.85, 0.9 | `scripts/ai-evals/digests-live.ts` | `test/ai-evals.digests.test.ts` |
| `brief.person` | 10 | 10/10 | every case 1.0 | `scripts/ai-evals/brief-live.ts` | `test/ai-evals.brief.test.ts` |
| `gate.drift`, `doc.drift`, `org.rollup` | 20, 12, 10 | 17/20 with no false pass; 5/12 with no false proposal; 10/10 kept | 0.8, 0.4, 0.9 — and the "never" floors (no false pass, no proposal on a doc that agrees, only offered cites) with no margin | `test/ai-evals/run-live-roadmap.mjs` | `test/ai.evals-roadmap.test.ts` |
| `digest.week` | 17 | 17/17 by the rules | every case 1.0 | `scripts/ai-evals/week-live.ts` | `test/ai-evals.week.test.ts` |

The digests' and the state's cases are this repository's real history (`git log` of each merged PR's commits, branch
bursts, trivial pushes to `main`) with Personal Dev's PR cards and dashboard; `scripts/ai-evals/digests-cases.mjs`
rebuilds them, and `test/ai-evals/digests-grade.ts` grades a Haiku answer raw AND as the server would write it
(`checkDigest` / `checkState`). The roadmap's grades are `test/ai-evals/roadmap-grade.ts`. Kinds with no live set:
`sprint.draft`, `plan.narrative`, `themes.propose`, `themes.backfill` (Batch API, checked by their server rules in
`test/ai.roadmap.test.ts` / `test/ai.themes.test.ts`), `filter` (`resolveFilter`'s checks, `test/ai.filter.test.ts`)
and Ask (`ask.md` › Tests).

## Cost (measured per call; activity assumed)

**Per call**, from the live eval runs' token counts (averages over each set), at Claude Haiku 5.5's first-party
prices — $0.10 / MTok in, $0.50 / MTok out, $0.01 / MTok cache read (prompts under 100k tokens), the Message Batches
API at half — and Jev at about $0.0001 a request (the handoff's figure; TypeSafe bills per request, the token counts
are metered too):

| Call | Tokens in (uncached + cached) / out | Cost |
|---|---|---|
| PR / issue summary (capture-time) | ~3,000 / 250 (the spec's estimate) | $0.00043 |
| `digest.session` | 662 + 1,223 / 366 | $0.00026 |
| `repo.state` | 507 + 1,039 / 249 | $0.00019 |
| `brief.person` | 555 + 1,210 / 194 | $0.00017 |
| `org.rollup` | 525 + 676 / 98 | $0.00011 |
| `doc.drift` (batch) | 2,926 + 791 / 316 | $0.00023 |
| `themes.caption` (batch) | 659 + 637 / 80 | $0.00006 |
| `digest.week` (batch) | 487 + 821 / 156 | $0.00007 |
| `themes.propose` / `backfill`, `sprint.draft`, `plan.narrative` (batch; no live run — assumed) | ~3,000 + 800 / 600 | $0.00030 |
| `filter` (assumed) | ~1,500 / 150 | $0.00023 |
| Any Jev request (gates 416–1,144 tokens in, 20–158 out) | — | ~$0.0001 |
| Ask, Fast (assumed: 2 calls, 10k cached + 6k uncached in, 600 out) | Haiku | ~$0.001 |
| Ask, Smart (assumed: 3 calls, 18k cached + 9k uncached in, 1k out) | Sonnet 5.5 ($2 / $10, cache $0.20) | ~$0.032 |
| Ask, Thinking (assumed: 4 calls, 24k cached + 12k uncached in, 4k out with thinking) | Opus 5.5 ($4 / $20, cache $0.20) | ~$0.13 |

**Per org per month** — the activity is ASSUMED (no production traffic yet), the per-call costs are the measured ones:

| | Free (1 repo, 2 active people) | Pro (10 seats, 1–2 repos) | Enterprise (50 seats, 3 repos) |
|---|---|---|---|
| Assumed activity | 40 merged PRs, 60 session bursts, 20 tickets, 40 feed entries, 30 Ask questions (Smart) | 250 PRs, 500 bursts, 120 tickets, 400 entries, 940 questions (600 Smart, 300 Fast, 40 Thinking) | 1,250 PRs, 2,500 bursts, 600 tickets, 2,000 entries, 4,700 questions (3,000 / 1,500 / 200) |
| Capture-time summaries | 60 → $0.03 | 400 → $0.17 | 2,000 → $0.85 |
| The pass and the filter, Haiku (`ai_runs`) | 180 calls → $0.03 | 1,299 → $0.25 | 5,508 → $1.10 |
| Of which through the Batch API | 16 → $0.003 | 59 → $0.008 | 168 → $0.023 |
| Jev (`jev_checks`) | 289 → $0.03 | 2,030 → $0.20 | 9,440 → $0.94 |
| **Everything but Ask** | **$0.09** | **$0.62** | **$2.90** |
| Ask Trov (`ai_chat`) | $0.95 | $24.57 | $122.86 |
| **Total** | **$1.04** | **$25.20** | **$125.76** |
| At the caps (no Ask / with Ask) | 300 summaries + 250 runs + 1,000 checks ≈ $0.29 / + 50 Smart ≈ $1.87 | 3,000 + 2,000 + 10,000 ≈ $2.80 / + 3,000 Smart ≈ $97.60 | unlimited |

What keeps the pass cheap: a Jev gate before every Haiku producer (a non-substantive burst is one Jev request and no
Haiku call), cards read instead of raw bodies, the router's debounce (ten pushes plus a merge are ONE repo call), the
cached org prefix (over half of each producer's input reads at a tenth of the price), the Batch API for what can
wait, and no call on an unchanged input (the brief's `input_hash`). Ask is the cost driver once it is used: Smart is
~30× a Fast question and Thinking ~4× Smart, which is why Thinking counts 5 and the Pro cap is per seat.

## Tests

`test/ai.pass.test.ts` (the real registry; stand-in jobs over real `ai_dirty` rows drive the guards — the switch,
the keys, both allowances, the per-tick cap, the budget, the rotation, metering —; eligibility; Platform usage per
provider), `test/ai.router.test.ts` (the table, pure; `markDirty`'s keep / reset / switch and the derived scopes; the
debounce; every write path's marks; a failed mark never fails the write), `test/ai.harness.test.ts` (THE PASS HARNESS:
ten pushes plus a merge give ONE repo call, 25 ticket cards give 25 Jev requests and zero Haiku calls, a
non-substantive burst gives one Jev call and no Haiku call; grouping, the Jev cap, the prefix, section isolation,
clearing, batches — a deleted or switched-off org's result writes nothing — and the measured spend per tick),
`test/ai.importance.test.ts` and `test/ai.sift-items.test.ts` (Phase C's jobs through the real pass: the question,
the threshold — never guessed —, the switches, the urgent mark, Sift's bands, Undo and person-over-AI on new items),
`test/ai.evals.test.ts` (the eval sets replayed), `test/render.feed-importance.test.ts` (the Feed's mark),
`test/ai.routes.test.ts` (settings — all four allowances, Pro's per-seat Ask Trov cap, the Auto switch —, accept /
dismiss, "Wrong?"), `test/ai.preview.test.ts` (fields absent in production, the preview and its guard — Org settings
› AI in every mode —, the MCP tab mapping), `test/ai.contracts.test.ts` (the fixtures against the schemas),
`test/ai.client.test.ts` (Claude's `structured`), `test/ai.jev.test.ts` (the kind table, Jev's `ask` and its
parsing), `test/tag-fit.test.ts` (Sift: the run, its switches — the org's included, mid-run — and the allowance),
`test/summaries.switch.test.ts` (the org switch over summaries: off = zero summarizer calls and nothing written on a
merged-PR webhook, an assigned issue and Sync; an existing summary kept; on = as before),
`test/secrets.mcp.test.ts` (the call sites, the MCP boundary, TypeSafe's URL in one file),
`test/plans.limits.test.ts` (`ai_chat`, per seat on Pro), `test/ai.brief.test.ts` (the brief: the input and the
server's order, the job's guards, who gets one, the 5 versions, the read, the route, the dev seed) and
`test/ai-evals.brief.test.ts` (its recorded eval answers), `test/render.brief-real.test.ts` (the brief end to end over
real data: the job's row → `/me/dashboard` / `getMyWork` → `render` → `briefTile`, and its "Wrong?" `data-arg` POSTed to
`/ai/feedback` hiding it; the SPA is loaded at run time, so the file stays under `tsconfig.worker.json`),
`test/render.brief-motion.test.ts` (the brief tile's entrance and settle fade, web-ui.md "The AI kit"),
`test/ai.filter.test.ts` and `test/render.ai-filter.test.ts`
(the plain-language filter), `test/ai.themes.test.ts` (themes: the threshold, the cadence, cites, person-over-AI, the
caption rules, admin-only decisions, batch results for a deleted or switched-off org, the read and the dev seed),
`test/ai-evals.themes.test.ts` (the theme evals, replayed), `test/ai.cards.test.ts` (Phase C's cards over real D1: the
request, person over AI, decided kinds, the switch, Accept through the writers — and its refusals as 4xx —, the reads,
the preview), `test/ai.evals.cards.test.ts` (the cards' recorded evals), `test/render.ai-cards.test.ts` (the three
screens with and without `ai`), `test/ai.cards-live.test.ts` (END TO END on real rows: the pass writes them, the SPA's
own api client reads them through the real cookie routes, the SPA's render draws the AI kit's chips, and its
`aiAccept` / `aiDismiss` acts round-trip through the real accept / dismiss routes),
`test/ai.digests.test.ts` (session digests through the real webhook capture: the gate
and its rule, dedupe with zero calls, cites, refusal / `max_tokens`, the gate path and its ledger, the `trov`
exception, the feed's `ai`, deletion), `test/ai.repo-state.test.ts` (repo state: the gate and its rule, incremental
input, hosting parts, cites, keep 20, the read — absent, the switch, capped, "Wrong?" — and `get_repo_dashboard`),
`test/ai.hookup.test.ts` (THE HOOKUP, real rows end to end: webhook capture → the pass → `GET /repo/dashboard`,
`get_repo_dashboard`, `GET /feed`, `get_feed` → the existing screens render State and the Trov entry; "Wrong?"'s
exact button bodies through the real route hide each for the presser only; absent renders nothing),
`test/ai-evals.digests.test.ts` (the digest evals' recorded live answers, replayed and graded in CI). Phase D's Roadmap: `test/ai.roadmap.test.ts` (the forecast, notes, drift and its shares, drafts,
the narrative, accept), `test/ai.doc-drift.test.ts`, `test/ai.grounding.test.ts`, `test/render.roadmap-ai.test.ts`,
`test/render.roadmap-ai-exit.test.ts`, `test/render.roadmap-ai-real.test.ts` (real rows → the real reads → the real
render), `test/ai.roadmap-seed.test.ts`, `test/ai.evals-roadmap.test.ts`.

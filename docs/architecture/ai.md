# AI — where the model runs, and the base every AI feature builds on

What this build delivers and what it leaves to the owner's design: `docs/superpowers/specs/2026-10-14-ai-base.md`
and the decided system, `docs/superpowers/specs/2026-10-15-server-ai-build.md` (background only:
`2026-10-14-server-ai.md`). The capture-time summaries and their allowance: `plans.md` › AI summaries. The keys:
`env.md` › Summaries.

**The first producer is My Work's brief** (Phase D, `brief.person` — "The brief" below); no suggestion is written
yet, and every other AI field on the existing reads is omitted in production. What
exists is the base: the client with both providers (and Claude's Message Batches), the allowances, the switches,
the ROUTER (every write path marks the scopes it made stale in `ai_dirty`), the pass's machinery (debounce, stages,
grouping, gates, the cached org prefix, batches, section isolation, clearing, the caps), the suggestion and
"Wrong?" tables and routes, the screens' contracts, and a local preview. Sift (tagging existing items,
`feed-and-search.md` › Tags) and the plain-language filter (below, #162) are the AI features that run today.

**The loop: capture → route → decide → write → show → learn.** A write (the webhook, Sync, the app's writers)
marks scopes (the router, plain code); the `*/10` pass works through the scopes past their debounce, per org,
within the switch, the allowances and the cron budget; Jev decides (classifications, gates), Haiku writes words,
only past a gate; what they write is a computed row the screens, MCP and the e-mails read — never a model call
on a render path.

## THE client, and the two providers (`src/ai/client.ts`)

A caller names a KIND, never a model. `KIND_PROVIDER` is the ONE table from a kind to its provider, and
`providerFor(kind, { apiKey, fetchImpl, … })` returns that provider (typed by the kind) or null without a key:

| Provider | Model | Kinds today | What it does |
|---|---|---|---|
| `claude` | `claude-haiku-5-5` (Anthropic, `ANTHROPIC_API_KEY`) | `summary_pr`, `summary_issue`, `filter`, `brief.person` | `structured()`: one call, a system prompt and a text in, a zod-checked value out. It writes words. |
| `jev` | `jev-latest` (TypeSafe AI's Jev, `TYPESAFE_API_KEY`) | `tag.fit` | `classify()`: a run of one yes/no question over many items; `ask()`: several `noul` / `choice` / `score` questions about ONE item in ONE request. Numbers only, no text. |

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

ONLY in these places, all behind THE client (the decided build adds Ask Trov's route as the fifth):

1. **The capture-time summary seams** — `src/tools/summarize.ts`, chosen per org by `orgSummarizers`
   (`src/plans/summaries.ts`), from the webhook and Sync GitHub. Kinds `summary_pr` / `summary_issue` (Claude).
2. **The AI pass** — `src/ai/pass.ts` (and its batch half, `src/ai/batches.ts`), from the `*/10` repo tick. Jev
   jobs and gates and Claude jobs (`src/ai/jobs.ts`); the registry (`AI_JOBS`) holds `brief.person` (`src/ai/brief.ts`).
3. **The Sift run** — `src/ai/sift.ts` (`startTagFit` / `continueTagFit`), started by an admin from the Tags routes
   (`src/tags/routes.ts`: adding a tag, accepting a suggested one, Find items) and run in the background
   (`waitUntil`). Kind `tag.fit` (Jev). Everything about Sift that is NOT a call — candidates, the switches' read,
   Undo, review counts — is `src/tools/tag-fit.ts`, which imports no client (MCP reaches it through
   `src/tools/tags.ts`). The decided build moves this run into the pass (Phase C).
4. **The plain-language filter route** — `POST /api/o/:slug/ai/filter` (`src/ai/routes.ts` → `src/ai/filter.ts`), on
   a person's request only (Enter in the filter box). Kind `filter` (Claude). See "The plain-language filter" below.

Never on a render path (a read that backs a screen calls no model), and never from MCP: nothing reachable from
`src/mcp.ts` imports `src/ai/` or the Jev provider (`test/secrets.mcp.test.ts` walks the import graph, and pins that
only those call sites import the client — `src/tools/summarize.ts`, `src/ai/sift.ts`, the filter's `src/ai/filter.ts`
(imported only by `src/ai/routes.ts`), and the pass's `src/ai/pass.ts`, `src/ai/batches.ts` and `src/ai/jobs.ts`
(types only); that only `src/ai/eligibility.ts`, `src/ai/filter.ts`, `src/ai/pass.ts`, `src/plans/summaries.ts` and
`src/platform/routes.ts` read `ANTHROPIC_API_KEY`; that only `src/ai/pass.ts`, `src/ai/sift.ts` and
`src/tags/routes.ts` read `TYPESAFE_API_KEY`; and that the ROUTER, which MCP's writers reach, imports nothing from
`src/ai/`).

**The org switch covers every AI feature, Sift included.** A Sift run starts, and each of its requests is made, only
while BOTH `orgs.ai_automation` (Org settings › AI) and Sift's own switch (`org_ai_settings`, kind `tag.fit`, the
Tags tab) are on — `siftSwitches` reads both in one statement before the run and before EVERY request, so turning
either off stops a run in progress at its next request. The Tags tab says when the org's switch is what stops it
(`TagAiDTO.org`).

## The pass (`src/ai/pass.ts`)

`runAiPass(env, budget, opts?)` runs on every repo tick that has **no heavy job** (not `:00`'s usage polls, not the
6-hourly progress / reconcile), AFTER the health pings, on what they left of the SAME `Budget`
(`CRON_SUBREQUEST_BUDGET`, `CRON_WALL_BUDGET_MS` — `src/repo/dispatch.ts`, `repo-dashboard.md` › The repo cron).

- **The job registry.** `AI_JOBS: readonly AiJob[]` — one line per producer (Phases C and D): today `briefJob`. A job
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
| hosting deploy recorded or changing state | `repo:<repo>` when it lands `ready` or `error` on an environment's branch; no session | `upsertDeploys` (`src/hosting/poll.ts`: the `:40` poll and a provider event's poll) |
| ticket created (native or mirrored) | `card:ticket:<n>`, `org` | `create_ticket`; `mirrorIssue` (by `source_ref`) |
| ticket assigned, status or sprint changed | `person:<assignee>` (and one just unassigned), `sprint:<id>` (and the one it left), `org` | `transition_ticket`, `move_ticket` (a status change), `toggle_assignee`, `set_ticket_sprint`; the mirror's forced status |
| handoff sent | `person:<recipient>`; for `anyone`, up to 20 members (`AI_ANYONE_MAX`) | `createHandoff` |
| agent feed entry ingested | `card:feed:<id>`, `person:<author>` | `ingestFeedEntry` |
| doc proposal or ADR staged | `card:proposal:doc:<slug>:<version>` / `card:proposal:adr:<id>` | `ingestDocProposal`, `ingestAdrDraft` |
| item lands in Unplaced | `card:unplaced:<id>` | `route_triage` |
| doc promoted; artifact created or versioned | `card:tagfit:doc:<slug>` + `doc_drift:<slug>`; `card:tagfit:artifact:<slug>` + `doc_drift:artifact:<slug>` | `promote_doc`; `insertPage` (with a version) and `writeVersion` (`src/tools/artifacts.ts`) |
| themes accepted | `theme_backfill:<repo>` | (Phase D's theme accept) |
| digest send hour one tick away | `person:<handle>`, URGENT | `prewarmDigests` (`src/notifications/cron.ts`), from the repo tick at `:50` |

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

`urgent` (`ai_dirty.urgent`, set by whoever marks): a BREAKING change skips a `repo`'s wait on Pro and Enterprise only
(Phase C's `feed.importance` marks it); the digest pre-warm skips a `person`'s on every plan. It changes nothing
for any other scope, and clears when the scope is written.

## The cached org prefix (`src/ai/prefix.ts`)

Every Haiku prompt starts with the org's prefix — `# Organization`, `# Tag vocabulary` (its live `org_tags`, not
retired), `# Active themes` (none until Phase D), `# Active sprints` (`in_progress`), `# Plan narrative` — built ONCE
per org turn (only when a Haiku call or batch request is about to be made), each part bounded and an empty part
said as "none". It goes as the request's `prefix` with `cache: true`: the first user block, carrying
`cache_control: {type: "ephemeral"}`, before the scope's input. One org per prompt: it is read through the org's own
context.

## Batches (`src/ai/batches.ts`, `0059_ai_batches`)

Non-urgent kinds (theme proposals, theme backfill, captions, doc drift, the weekly recap, the narrative proposal —
any Haiku job with `batch: true`; none exists yet) go through Anthropic's Message Batches API:

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

## The brief (`brief.person`, Phase D, #163; `src/ai/brief.ts`, `src/ai/brief-core.ts`, `0063_person_brief`)

My Work's "Your brief" — ONE Haiku call per person, on the scope `person:<handle>` (stage "briefs"; marked by a PR
merged, a failure on their PR, a ticket assigned / moved, a handoff sent, an agent feed entry, and URGENT by the
digest pre-warm one tick before the send hour). Every prompt is led by the cached org prefix; the answer is
structured (`BriefAnswerSchema`, each part checked on its own: `sections`).

- **The input** (`buildBriefInput`, D1 only, the org's PRIMARY repository for GitHub activity, so a PR is `pr:<n>`):
  - **Now** — their open PRs (the latest `repo_events` row per PR is `draft` / `review`, authored by a login the org
    attributes to them, last event within 60 days; at most 8), each with its failing runs (the latest run per
    workflow on its branch is `failure` / `timed_out`) and red checks (on its head sha), and their latest `Status:`
    session note (a feed entry they wrote whose summary starts "Status:", last 7 days).
  - **Recently** — the last 7 days of their session notes (their feed entries, the handoff announcements left out)
    and merged-PR CARDS (`pr_summaries`' title / what / impact, the PR's own title and link — never a raw PR body).
    SEAM: Phase D's session digests are written by `trov` for a person (`feed.subject`, 0061); once that column
    exists they join here.
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
- **Evals** (`test/ai-evals/brief.person/`): 10 cases built from Personal Dev's real rows (`cases.ts` says which
  parts are arranged), graded by rules (`grade.ts`: cites in the input, Next only offered and in the server's order,
  a why for each, numbers grounded, no refs in text, lengths, null when nothing, written when there is material).
  `scripts/ai-evals/brief-live.ts` runs them live (by hand, a real key from the environment) and writes
  `recorded.json`; `test/ai-evals.brief.test.ts` replays it — and an answer made worse on purpose — through the
  server's checks. Measured 2026-10-15 (`brief.1`): 10/10 cases 1.0; per call 245–781 uncached input tokens plus
  ~1,210 cached (system + prefix), 105–390 output tokens (≈ $0.0002 a brief at Haiku 5.5's prices).

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
  `ai_chat` itself is the whole cap, never multiplied. Nothing writes the metric yet (Ask Trov is Phase F), so it
  reads 0. **Not listed**, like `ai_runs`.
- **The switches** — `orgs.ai_automation` (0055, default on): every AI feature, Sift included. And
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

## Suggestions and "Wrong?" (0055)

- **`ai_suggestions`** — a suggested value for one field of one item, with a REQUIRED reason, its cites, model and
  prompt version; `open` → `accepted` | `dismissed` (a person's decision, remembered) | `superseded` (a re-run of
  the same kind for the same item replaces the OPEN one: `putSuggestion`, `src/data/ai.ts`). Nothing writes one yet.
- **Accept** — `POST /ai/suggestions/:id/accept { value? }` (`:id` is the row id; another org's id is
  `not_found`). In order: `not_found` (404) → `not_open` (409) → `not_available` (409: no handler for the kind) →
  `forbidden` (403: below the handler's role) → `invalid` (400: a body the contract refuses). Then the row is claimed by one guarded UPDATE, the handler writes the
  real field AS the cookie person, and on its throw the claim is undone. `AI_ACCEPT_HANDLERS` (`src/ai/suggestions.ts`)
  is EMPTY, so today every accept is `not_available`. **A handler names its `role`**: `member` (anyone in the org)
  or `admin`; **dismiss is open to every member** (`POST /ai/suggestions/:id/dismiss`). Theme accept / rename /
  remove go through the same two routes.
- **"Wrong?"** — `POST /ai/feedback` (`AiFeedbackBody`) records `ai_feedback` for the cookie person, ONE row per
  (person, item), idempotent; it hides the item for that person (`hiddenFor(ctx, handle, itemType)`, what a
  producer reads) and never edits the record.
- Both tables are in `ORG_TABLES` and the reset seed; `ai_suggestions.decided_by` and `ai_feedback.handle` are in
  `HANDLE_COLUMNS`. Every route refuses a request carrying an `Authorization` header (`cookieOnly`); none is an MCP
  tool and none has an old-path alias.

## The screens' fields (each omitted until its producer exists)

The contracts are typed (`shared/ai-core.ts`, schemas in `shared/ai.ts`): `DashboardData.brief?` (`/me/dashboard`,
`get_my_work`), `RepoDashboard.state?` / `themes?` (`/repo/dashboard`, `get_repo_dashboard`), `FeedRow.ai?` (`/feed`,
`get_feed`). Production returns `brief` (the stored brief — "The brief" above) and none of the others yet. `get_repo_dashboard` carries `state` with `tab: overview` (or no
tab) and `themes` with `planning` (or no tab) when the dashboard has them — they are not sections, so
`REPO_TAB_SECTIONS` does not name them (`src/tools/repo-agent.ts`).

**`LOCAL_AI_PREVIEW`** (`src/ai/preview.ts`, `env.md` › Local development only) fills four cookie reads from
`shared/ai-fixtures.ts` — the brief, `state` + `themes`, two feed entries merged by `created_at`, and Org settings ›
AI's numbers (`aiSettingsFixture`: all four allowances and the eligibility of a 5-seat Pro org — partway through the
month in `ready` / `proposed`, nothing used in `empty`, every allowance used up in `capped`; the switches stay the
org's real ones, and what is sent names both providers in every mode) — when it names a mode (`ready` / `empty` /
`capped` / `proposed`), the request came to a loopback `http://` origin (what `wrangler dev` serves on; no deployed
Worker is reached there) and no live Stripe key is set. Never over MCP. It also answers the plain-language filter route
from its fixtures (above).

## Tests

`test/ai.pass.test.ts` (the empty registry; stand-in jobs over real `ai_dirty` rows drive the guards — the switch,
the keys, both allowances, the per-tick cap, the budget, the rotation, metering —; eligibility; Platform usage per
provider), `test/ai.router.test.ts` (the table, pure; `markDirty`'s keep / reset / switch and the derived scopes; the
debounce; every write path's marks; a failed mark never fails the write), `test/ai.harness.test.ts` (THE PASS HARNESS:
ten pushes plus a merge give ONE repo call, 25 ticket cards give 25 Jev requests and zero Haiku calls, a
non-substantive burst gives one Jev call and no Haiku call; grouping, the Jev cap, the prefix, section isolation,
clearing, batches — a deleted or switched-off org's result writes nothing — and the measured spend per tick),
`test/ai.routes.test.ts` (settings — all four allowances, Pro's per-seat Ask Trov cap, the Auto switch —, accept /
dismiss, "Wrong?"), `test/ai.preview.test.ts` (fields absent in production, the preview and its guard — Org settings
› AI in every mode —, the MCP tab mapping), `test/ai.contracts.test.ts` (the fixtures against the schemas),
`test/ai.client.test.ts` (Claude's `structured`), `test/ai.jev.test.ts` (the kind table, Jev's `ask` and its
parsing), `test/tag-fit.test.ts` (Sift: the run, its switches — the org's included, mid-run — and the allowance),
`test/secrets.mcp.test.ts` (the call sites, the MCP boundary, TypeSafe's URL in one file),
`test/plans.limits.test.ts` (`ai_chat`, per seat on Pro), `test/ai.brief.test.ts` (the brief: the input and the
server's order, the job's guards, who gets one, the 5 versions, the read, the route, the dev seed) and
`test/ai-evals.brief.test.ts` (its recorded eval answers), `test/render.brief-real.test.ts` (the brief end to end over
real data: the job's row → `/me/dashboard` / `getMyWork` → `render` → `briefTile`, and its "Wrong?" `data-arg` POSTed to
`/ai/feedback` hiding it; the SPA is loaded at run time, so the file stays under `tsconfig.worker.json`),
`test/ai.filter.test.ts` and `test/render.ai-filter.test.ts`
(the plain-language filter).

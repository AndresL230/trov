# AI — where the model runs, and the base every AI feature builds on

What this build delivers and what it leaves to the owner's design: `docs/superpowers/specs/2026-10-14-ai-base.md`
and the decided system, `docs/superpowers/specs/2026-10-15-server-ai-build.md` (background only:
`2026-10-14-server-ai.md`). The capture-time summaries and their allowance: `plans.md` › AI summaries. The keys:
`env.md` › Summaries.

**Nothing produces AI content yet** (Phase A of the decided build). The pass below has no job, no suggestion is
ever written, and every AI field on the existing reads is omitted in production. What exists is the base: the
client with both providers, the allowances, the switches, the pass's skeleton, the router's table (`ai_dirty`,
nothing writes it yet), the suggestion and "Wrong?" tables and routes, the screens' contracts, and a local preview.
Sift (tagging existing items, `feed-and-search.md` › Tags) and the plain-language filter (below, #162) are the AI
features that run today.

## THE client, and the two providers (`src/ai/client.ts`)

A caller names a KIND, never a model. `KIND_PROVIDER` is the ONE table from a kind to its provider, and
`providerFor(kind, { apiKey, fetchImpl, … })` returns that provider (typed by the kind) or null without a key:

| Provider | Model | Kinds today | What it does |
|---|---|---|---|
| `claude` | `claude-haiku-5-5` (Anthropic, `ANTHROPIC_API_KEY`) | `summary_pr`, `summary_issue`, `filter` | `structured()`: one call, a system prompt and a text in, a zod-checked value out. It writes words. |
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
2. **The AI pass** — `src/ai/pass.ts`, from the `*/10` repo tick. Claude kinds only today (`AiJob.kind: ClaudeKind`).
3. **The Sift run** — `src/ai/sift.ts` (`startTagFit` / `continueTagFit`), started by an admin from the Tags routes
   (`src/tags/routes.ts`: adding a tag, accepting a suggested one, Find items) and run in the background
   (`waitUntil`). Kind `tag.fit` (Jev). Everything about Sift that is NOT a call — candidates, the switches' read,
   Undo, review counts — is `src/tools/tag-fit.ts`, which imports no client (MCP reaches it through
   `src/tools/tags.ts`). The decided build moves this run into the pass (Phase C).
4. **The plain-language filter route** — `POST /api/o/:slug/ai/filter` (`src/ai/routes.ts` → `src/ai/filter.ts`), on
   a person's request only (Enter in the filter box). Kind `filter` (Claude). See "The plain-language filter" below.

Never on a render path (a read that backs a screen calls no model), and never from MCP: nothing reachable from
`src/mcp.ts` imports `src/ai/` or the Jev provider (`test/secrets.mcp.test.ts` walks the import graph, and pins that
only those four files import the client, and that only `src/ai/routes.ts` imports the filter; that only
`src/ai/eligibility.ts`, `src/ai/filter.ts`, `src/ai/pass.ts`, `src/plans/summaries.ts` and `src/platform/routes.ts`
read `ANTHROPIC_API_KEY`; and that only `src/ai/sift.ts` and
`src/tags/routes.ts` read `TYPESAFE_API_KEY`).

**The org switch covers every AI feature, Sift included.** A Sift run starts, and each of its requests is made, only
while BOTH `orgs.ai_automation` (Org settings › AI) and Sift's own switch (`org_ai_settings`, kind `tag.fit`, the
Tags tab) are on — `siftSwitches` reads both in one statement before the run and before EVERY request, so turning
either off stops a run in progress at its next request. The Tags tab says when the org's switch is what stops it
(`TagAiDTO.org`).

## The pass (`src/ai/pass.ts`)

`runAiPass(env, budget, opts?)` runs on every repo tick that has **no heavy job** (not `:00`'s usage polls, not the
6-hourly progress / reconcile), AFTER the health pings, on what they left of the SAME `Budget`
(`CRON_SUBREQUEST_BUDGET`, `CRON_WALL_BUDGET_MS` — `src/repo/dispatch.ts`, `repo-dashboard.md` › The repo cron).

- **The job registry.** `AI_JOBS: readonly AiJob[]` is EMPTY. A job is `{ kind: AiKind, pending(ctx) → number,
  run(ctx, provider) → "done" | "failed" }`: `pending` is D1 only, and `run` does ONE unit — at most ONE model call,
  through the provider it is handed. A job never decides eligibility, caps or metering. With the registry empty —
  or no key — the pass returns before reading anything: no statement, no request, no log line.
- **Rotation.** Orgs (`listActiveOrgIds`, by id) in a stable order, starting after the last org a tick could not
  finish (`cron_cursor`, job `ai_pass`). The cursor is written only when a tick stops early.
- **Per org**: `aiAllowance` (ONE statement), then each job's `pending`, then up to that many calls. `off` and
  `no_key` are skipped; at the allowance (or an ended plan) the job makes no call and one `ai_run_capped:<kind>` is
  counted per job that had work. The allowance read at the org's start, less what this tick spent, is never
  overspent.
- **Caps.** At most `AI_RUNS_PER_TICK = 12` calls per tick across every org, and none the budget cannot afford
  (`AI_CALL_COST = 1` subrequest: the client makes no retries). Every call goes through `budget.fetch`, so what it
  spent is counted. When either runs out the pass stops and the next tick resumes at that org.
- **Isolation.** A read, `pending` or `run` that throws is logged by name with `org=<id>` (a `run` that throws is a
  failed run) and the loop moves on; nothing throws out of `runAiPass`.

## Eligibility, the allowance and the switch

`aiEligibility(ctx, env, now?)` (`src/ai/eligibility.ts`) → `ok` | `off` | `no_key` | `capped`, never throwing:
`no_key` without `ANTHROPIC_API_KEY` (nothing read); else ONE statement — `planAndAiRuns` (`src/plans/gate.ts`):
the plan, `orgs.ai_automation` and the month's `ai_run:*` — gives `off` when the switch is off, `capped` when
`planRefusal(plan, "ai_runs", used, 1)` refuses (the allowance, or an ended plan), else `ok`. A failed read is `off`.

- **`ai_runs`** (`shared/plans.ts`, monthly like `ai_summaries`): Free 250, Personal 250, Pro 2,000, Enterprise
  unlimited; overridable per org like every limit. One call is one run. It refuses nothing with a 402: past it the
  pass makes no call. It is **not listed** (`LimitDef.listed: false`, `LISTED_LIMIT_KEYS`): the pricing page, the
  Plan block and Settings › Limits leave it out until something uses it (`plans.md`).
- **`ai_chat`** (Ask Trov, `shared/plans.ts`, monthly): WEIGHTED units — a Fast answer is 1, Smart 5, Thinking 10
  (metric `ai_chat`). Free 50 and Personal 50 per org, Pro **500 per seat**, Enterprise unlimited. `LimitDef.per`
  cannot say "per seat", so `PlanDef.perSeat` (Pro: `["ai_chat"]`) does: `resolveEntitlements` multiplies the plan's
  per-seat amount by the seats in force — the org's `seats` override (a paid Pro org's: the seats it pays for),
  else the plan's own 50 — at read time, so `planRefusal` and every screen see the org's whole cap. An override of
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

`ai_run:<kind>` (the attempt, written BEFORE the call — what `ai_runs` counts, `AI_RUN_METRIC_GLOB = 'ai_run:*'`),
`ai_run_failed:<kind>` (it wrote nothing), `ai_run_capped:<kind>`, and the provider's own `ai_tokens_in` /
`ai_tokens_out` / `ai_tokens_cached`, per org per UTC day in `org_usage_daily`. Counts only. Platform › Usage reads
them into `OrgUsage.ai` and `PlatformUsageResponse.ai` (`src/platform/usage.ts`) when a key is set — left out
without one, as summaries say they are off — and none of them is a person's request (not "active people", not
"last activity").

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

## The screens' fields (omitted until a producer exists)

The contracts are typed (`shared/ai-core.ts`, schemas in `shared/ai.ts`): `DashboardData.brief?` (`/me/dashboard`,
`get_my_work`), `RepoDashboard.state?` / `themes?` (`/repo/dashboard`, `get_repo_dashboard`), `FeedRow.ai?` (`/feed`,
`get_feed`). Production returns none of them. `get_repo_dashboard` carries `state` with `tab: overview` (or no
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

## The router's table (0058, Phase B)

`ai_dirty(org_id, scope, scope_key, dirty_since, last_run_at, attempts, last_error)`, PK `(org_id, scope,
scope_key)`: one row per stale scope of an org (`card`, `session`, `person`, `repo`, `org`, `sprint`, `theme_window`,
`theme_backfill`, `doc_drift`). NOTHING writes it yet; Phase B's router marks and the pass clears. In `ORG_TABLES`
and the reset seed; it has no handle column.

## Tests

`test/ai.pass.test.ts` (the empty registry, the fake-job guards, eligibility, Platform usage),
`test/ai.routes.test.ts` (settings — all four allowances, Pro's per-seat Ask Trov cap, the Auto switch —, accept /
dismiss, "Wrong?"), `test/ai.preview.test.ts` (fields absent in production, the preview and its guard — Org settings
› AI in every mode —, the MCP tab mapping), `test/ai.contracts.test.ts` (the fixtures against the schemas),
`test/ai.client.test.ts` (Claude's `structured`), `test/ai.jev.test.ts` (the kind table, Jev's `ask` and its
parsing), `test/tag-fit.test.ts` (Sift: the run, its switches — the org's included, mid-run — and the allowance),
`test/secrets.mcp.test.ts` (the call sites, the MCP boundary, TypeSafe's URL in one file),
`test/plans.limits.test.ts` (`ai_chat`, per seat on Pro), `test/ai.filter.test.ts` and `test/render.ai-filter.test.ts`
(the plain-language filter).

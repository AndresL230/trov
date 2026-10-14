# AI — where the model runs, and the base every AI feature builds on

What this build delivers and what it leaves to the owner's design: `docs/superpowers/specs/2026-10-14-ai-base.md`
(background only: `2026-10-14-server-ai.md`). The capture-time summaries and their allowance: `plans.md` › AI
summaries. The key: `env.md` › Summaries.

**Nothing produces AI content yet.** The pass below has no job, no suggestion is ever written, and every AI field
on the existing reads is omitted in production. What exists is the base: the allowance, the switch, the pass's
skeleton, the suggestion and "Wrong?" tables and routes, the screens' contracts, and a local preview.

## Where a model call may happen

ONLY in two places, both behind THE model client (`src/ai/client.ts`, `providerFor` — one structured call that
never throws; `claude-haiku-5-5` today):

1. **The capture-time summary seams** — `src/tools/summarize.ts`, chosen per org by `orgSummarizers`
   (`src/plans/summaries.ts`), from the webhook and Sync GitHub.
2. **The AI pass** — `src/ai/pass.ts`, from the `*/10` repo tick.

Never on a render path (a read that backs a screen calls no model), and never from MCP: nothing reachable from
`src/mcp.ts` imports `src/ai/` (`test/secrets.mcp.test.ts` walks the import graph, and pins that only those two
files import the client and only they, `src/ai/eligibility.ts` and `src/platform/routes.ts` read
`ANTHROPIC_API_KEY`).

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
- **The switch** — `orgs.ai_automation` (0055, default on). Org settings › AI, cookie routes only
  (`src/ai/routes.ts`, `AI_ROUTES` in `shared/ai-core.ts`; `organizations.md`):

| Route (`/api/o/:slug…`) | Who | Does |
|---|---|---|
| `GET /ai/settings` | any member | `AiSettings`: `enabled`, `canEdit` (admin+), `eligibility`, `runs { used, cap, resumesOn }` (`resumesOn` = the 1st of next month, only when the allowance is spent), what is sent to Anthropic (`AI_SENDS`) and what never is (`AI_NEVER_SENT`). A failed read is 503 `{ error }` |
| `PUT /ai/settings { enabled }` | admin+ (403 otherwise) | sets the switch, audited `org.ai` in `org_admin_audit`; returns `AiSettings` |

Off means the field is MISSING on every screen — never an `"off"` state (`shared/ai-core.ts`).

## Metering (`src/data/meter.ts`, actor `ai-pass`)

`ai_run:<kind>` (the attempt, written BEFORE the call — what `ai_runs` counts, `AI_RUN_METRIC_GLOB = 'ai_run:*'`),
`ai_run_failed:<kind>` (it wrote nothing), `ai_run_capped:<kind>`, and the provider's own `ai_tokens_in` /
`ai_tokens_out` / `ai_tokens_cached`, per org per UTC day in `org_usage_daily`. Counts only. Platform › Usage reads
them into `OrgUsage.ai` and `PlatformUsageResponse.ai` (`src/platform/usage.ts`) when a key is set — left out
without one, as summaries say they are off — and none of them is a person's request (not "active people", not
"last activity").

## Suggestions and "Wrong?" (0056)

- **`ai_suggestions`** — a suggested value for one field of one item, with a REQUIRED reason, its cites, model and
  prompt version; `open` → `accepted` | `dismissed` (a person's decision, remembered) | `superseded` (a re-run of
  the same kind for the same item replaces the OPEN one: `putSuggestion`, `src/data/ai.ts`). Nothing writes one yet.
- **Accept** — `POST /ai/suggestions/:id/accept { value? }` (`:id` is the row id; another org's id is
  `not_found`). In order: `not_found` (404) → `not_open` (409) → `not_available` (409: no handler for the kind) →
  `forbidden` (403: below the handler's role). Then the row is claimed by one guarded UPDATE, the handler writes the
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

**`LOCAL_AI_PREVIEW`** (`src/ai/preview.ts`, `env.md` › Local development only) fills the three cookie reads from
`shared/ai-fixtures.ts` — the brief, `state` + `themes`, and two feed entries merged by `created_at` — when it names
a mode (`ready` / `empty` / `capped` / `proposed`), the request came to a loopback `http://` origin (what `wrangler
dev` serves on; no deployed Worker is reached there) and no live Stripe key is set. Never over MCP.

## Tests

`test/ai.pass.test.ts` (the empty registry, the fake-job guards, eligibility, Platform usage),
`test/ai.routes.test.ts` (settings, accept / dismiss, "Wrong?"), `test/ai.preview.test.ts` (fields absent in
production, the preview and its guard, the MCP tab mapping), `test/ai.contracts.test.ts` (the fixtures against the
schemas).

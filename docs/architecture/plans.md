# Plans, limits and grants

Every organization is on a **plan**; a plan is a name over a table of **limits**. A person who is not a
superadmin comes to create an organization only by using a **grant**. No prices and no payment code exist
yet: the last section is the seam billing will use.

Code: `shared/plans.ts` (the plans, the limits, the one refusal — shared by the Worker, the SPA and the
landing page), `src/plans/` (`state.ts`, `gate.ts`, `grants.ts`, `billing.ts`, `routes.ts`). Migration:
`0044_plans.sql`. Tests: `test/plans.limits.test.ts`, `test/plans.grants.test.ts`, `test/render.plans.test.ts`.

## The plans

Every number is a **placeholder for the owner to decide**. They live in ONE place — `PLANS` in
`shared/plans.ts` — and changing a number there changes it everywhere (enforcement reads the resolved value;
the screens read the same table). `null` means unlimited.

| Limit (`LimitKey`) | Personal | Team | Enterprise | Counted | Enforced at |
|---|---|---|---|---|---|
| `seats` | 1 | 10 | unlimited (set per org) | members + pending invitations, per org | an invitation created (`createInvite`, the legacy `/invites` alias, the superadmin's owner invitation), an invitation accepted (`respondToInvite`, `consumeLegacyInvite`), a person added directly (`assignOrgAdmin`) |
| `repositories` | 1 | 5 | 10 | `org_repos` rows | `addRepo` (a new repository; promoting one the org has is not an addition) |
| `environments` | 2 | 5 | 10 | `org_environments` rows | `putEnvironment` (a new key; an edit is not an addition) |
| `artifact_bytes` | 250 MB | 5 GB | unlimited | `SUM(artifact_versions.size_bytes)` — every stored version, deleted pages included | `writeVersion`, `insertPage`, `mintUploadToken`, `consumeUploadToken` (`src/tools/artifacts.ts`) — so HTTP, the upload link and the MCP artifact tools alike |
| `agent_connections` | 5 | 10 | unlimited | PER PERSON: that person's live MCP tokens + connected apps into the org | `mintToken`, `issueAuthorization` (the OAuth consent) |
| `ai_summaries` | 300 | 3,000 | unlimited | PER CALENDAR MONTH (UTC): summarizer calls attempted for the org | `orgSummarizers` (`src/plans/summaries.ts`) — it refuses nothing: past it an item shows its excerpt (below) |

Enterprise's repositories and environments are the platform caps from before plans (the repo cron's
subrequest budget is shared — `data-layer.md` › Background jobs), so an org that existed before sees no change.

**Per-org overrides** (`orgs.plan_overrides`, JSON): a key that is present replaces the plan's value for that
org, `null` for unlimited; an absent key is the plan's own. This is how the superadmin sizes an Enterprise
org, and makes an exception on any plan. `resolveEntitlements(plan, overrides)` is the one resolution. An
unknown plan id or an unparseable override reads as the SMALLEST plan / "no overrides": a bad value can only
make an org smaller.

## One question, one refusal

`planRefusal(state, limit, used, adding)` (`shared/plans.ts`) answers "may this org add this now?" — `null`,
or the typed refusal. Nothing else compares a count to a cap. The Worker throws it as `PlanLimitError`
(`src/plans/state.ts`); a tenant write path calls `requirePlan(ctx, limit, adding)` (`gate.ts`), a seat is
taken through `seatGate(p, orgId, "reserve" | "accept")` (`state.ts`).

**HTTP 402**, from every route, mapped once (`app.onError` in `src/routes.ts`; the artifact adapters and the
OAuth consent page map it themselves because they do not answer JSON through the app):

```json
{ "error": "plan_limit", "limit": "seats", "used": 10, "cap": 10, "plan": "team", "status": "active",
  "message": "This organization has reached the 10 seats its Team plan includes." }
```

402 rather than 403: a 403 here means "your role may not" and an owner can fix that; no role in the org can
fix this one, and nothing else in the app answers 402, so a client branches on the status alone. Over MCP it
is a tool error with `code: "plan_limit"`. The SPA shows `message` plus who can change the plan
(`planRefusalSentence`: an owner reads "Ask Trov to change your plan.", everyone else "Ask one of this
organization's owners.") — `PLAN_CHANGE_POINTER` is the one place billing replaces.

## Seats

A seat is a **member or a pending invitation** — so ten invitations cannot be accepted into an eleventh
seat. Two rules, one per way a seat is taken:

- **reserve** (a new invitation, a person added directly): refused when members + pending ≥ seats.
- **accept** (a pending invitation becoming a member — its seat was reserved when it was made): refused only
  when the org is already full of MEMBERS, which happens after its plan shrank.

The condition is in the INSERT that takes the seat (`SEAT_FREE`, `MEMBER_SEAT_FREE`), not only in a check
before it: of two requests racing for the last seat, one writes. Lifting a current member to owner, or
upgrading a pending invitation to an owner's, takes no seat. A one-person plan refuses an invitation in a
sentence that names the plan that allows them. The other limits are check-then-write, as the caps they
replaced were.

## Over a limit

An org can end up over a limit — its plan was changed, or an override lowered. Then, and always:

- **nothing is deleted and nobody is removed**; every read keeps working for every member;
- **additions of that kind are refused** (402) until the org is back under; everything no limit governs
  (tickets, docs, the feed, agents) carries on; removals are never refused;
- the UI says so: Org settings › General lists what the org is over, Members replaces the invite form with
  the sentence, and Platform's Change plan says it before the change is confirmed.

## AI summaries: one key, counted per org, capped per plan

Capture-time summaries of pull requests and assigned issues come from Gemini, and **one** platform key
(`GEMINI_API_KEY`) pays for every org. So each org's calls are counted, and each plan has a monthly
allowance. Code: `src/plans/summaries.ts`, `src/data/meter.ts`; tests: `test/summaries.cap.test.ts`.

**The one choice.** `orgSummarizers(env, ctx, …)` is the only place a summarizer is chosen for an org — the
webhook (`src/webhook.ts`) and Sync GitHub (`src/tools/backfill.ts`) both ask it. It answers the Gemini
summarizer, or `null` when the deployment has no key (`off`), the org's plan is canceled (`ended`), or the
org has used its month's allowance (`capped`). The comparison is `planRefusal(state, "ai_summaries", used)`,
like every other limit.

**Nothing errors past the cap.** A `null` summarizer is what the code always had without a key: the item
is stored with its **excerpt** (`pr_summaries.model = 'excerpt'`, a marker row; an issue's row holds the
first 280 characters of its body). No 402, no failed delivery, no failed sync. A later **Sync GitHub**
retries every excerpt once summaries are allowed again — a new month, a raised cap, a renewed plan —
at most 5 a batch and 50 a run (`sync.md`), so a large backlog cannot spend a month's allowance in one
click; the Sync panel says how many a run will attempt and how many are left before it starts.

**What counts.** Every *attempted* call, whatever its outcome, from both paths. Per (org, UTC day, actor —
`github-webhook`, or the admin who pressed Sync) in `org_usage_daily`:

| Metric | Is |
|---|---|
| `summary:pr`, `summary:issue` | attempts — **what the allowance counts** |
| `summary_failed:pr`, `summary_failed:issue` | attempts that produced no summary (the item kept its excerpt) |
| `summary_capped:pr`, `summary_capped:issue` | items given an excerpt because nothing could be attempted (the allowance, an ended plan); counted once, when the excerpt row is first written |
| `summary_chars_in`, `summary_chars_out` | characters sent (prompt + title + body) and received |
| `summary_tokens_in`, `summary_tokens_out` | Gemini's own `usageMetadata` counts, when its answer carried them |

Counts and sizes only: no title, body or summary text is ever written there. The attempt is written
*before* the call and its outcome after it. Metering follows the request-metering rule — it rides
`waitUntil` on the webhook and is awaited (never throwing) inside Sync, which has no execution context.

**The month** is the calendar month in **UTC**: use is summed from the 1st (`monthStartDay`), so the
allowance is whole again at 00:00 UTC on the 1st. Nothing is reset or deleted; the rows stay for the
Usage page (400 days).

**Cost of the check, and the overshoot.** One statement (`planAndSummaries`: the org's plan row plus a
range read of its month on the table's primary key), once per webhook delivery that needs a summary and
once per Sync batch. Whoever reads then spends only what it read: a Sync batch can never make more calls
than were left. Requests that read at the same moment can each spend what they saw, so the overshoot is
bounded by them: **one call per webhook delivery in flight, plus up to 5 for a Sync batch** reading at
that instant. The next reader sees their attempts and stops — there is no runaway.

**Where it shows.** Org settings › General › Plan lists it like any limit ("AI summaries — 212 of 300
this month") with, at the cap, "New pull requests and issues show an excerpt until next month." It is
never "over the limit" (`overLimits` skips a monthly allowance). Platform › Usage shows, per org and in
total, attempted / succeeded / fell back for the window and the month's use against the cap. The Sync
panel shows what a run will attempt and what is left. With **no key at all** nothing is counted or capped,
and only the Sync panel and Platform › Usage say that summaries are off on this deployment — as a fact,
not an error.

**The numbers are placeholders** for the owner: 300 (Personal), 3,000 (Team), unlimited (Enterprise, sized
per org with an override like every limit; `0` turns summaries off for an org). They are sized against the
bill, not from measured use: at about ten summaries a working day per person they leave Personal and a
ten-person Team headroom, and they bound the worst case to a known figure per org per month.

**Estimating cost.** Platform › Usage's totals, or directly:

```sql
SELECT org_id, metric, SUM(count) FROM org_usage_daily
 WHERE day >= '2026-10-01' AND metric GLOB 'summary*' GROUP BY org_id, metric;
```

Cost ≈ `tokens_in × input price + tokens_out × output price` for the model in use (`GEMINI_MODEL` in
`src/tools/summarize.ts`, `gemini-2.5-flash-lite`); where tokens were not recorded, characters ÷ 4 is the
usual approximation. Input dominates and scales with the pull request's description, which is sent whole —
that is why sizes are recorded and not just calls. Check the provider's current prices; none is stored here.

**Owner step.** Summaries are **off** until the key is set: `wrangler secret put GEMINI_API_KEY`. From then
on every org's new pull requests and assigned issues are summarized on capture (webhook) and on Sync, each
call is counted, and each org's plan allowance applies. Existing excerpt rows fill in at each org's next
Sync GitHub. Removing the secret turns it all off again; nothing else changes.

## Plan status

`orgs.plan_status`: `active`; `past_due` (changes nothing — a grace period is billing's to run); `canceled`
— the org stays readable and working, and every addition a limit governs is refused until `setOrgPlan` puts
it on a plan again (AI summaries stop too: new items show an excerpt). Nothing sets a status but billing's functions below.

## Grants: an organization of one's own

An organization comes to exist in two ways: a superadmin creates it and names its admin (Platform ›
Organizations — `organizations.md` §1), or a superadmin **grants** a person the right to create one
themselves (Platform › Access). `persons.org_limit`, the per-person allowance from before, is read by
nothing; its Platform control and route are gone, and the column is dropped by the cleanup migration.

1. **Granted** — `POST /api/platform/grants { to, plan, overrides?, note?, expires_in_days? }`. `to` is
   exactly one of `{ handle }` (an existing person), `{ github_login }`, `{ email }`. The grantee needs no
   account yet. An e-mail grant is mailed a notice (`src/notifications/grant.ts`): it names who granted it
   and the plan, its only link is the site root, and it spends the granter's daily `invite` allowance (a
   superadmin is exempt). The outcome is on the grant (`mail_status`).
2. **Seen** — a grant is the caller's when it names their handle, one of their GitHub identity logins, or one
   of their provider-VERIFIED e-mails (never the editable `persons.email`) — the invitation rule.
   `GET /api/orgs` lists the usable ones in `grants` (oldest first) and sets `can_create`. A superadmin holds
   none here. The picker shows each as "You can set up an organization — <Plan>".
3. **Used** — `POST /api/orgs { slug, name, grant? }` creates the org (`grant` = an id; omitted = the oldest)
   on the grant's plan, overrides and source, makes the caller its owner, and marks the grant used with the
   org it became — all in ONE batch. The consuming UPDATE writes `used` when the grant is still usable and a
   status the table's `org_grant_usable` CHECK refuses when it is not, which aborts the batch: a double
   submit, or a grant revoked or expired while the form was open, creates nothing (403 `no_grant`).
4. **Revoked / expired** — `POST /api/platform/grants/:id/revoke` for an unused one (409 `grant_used` after).
   `expires_in_days` is optional (1–365; the default is never); "expired" is derived, the row is not
   rewritten.

Every step is in `org_admin_audit`: `grant.create`, `grant.revoke`, `grant.use`, and for an org's plan
`plan.change`, `plan.overrides`, `plan.status`.

Both new tables are GLOBAL platform tables (no `org_id` column, like `platform_admins`): a grant is about a
person before any org exists. `org_grants.used_org` is deliberately not named `org_id`.

## Routes

| Route | Gate | Answers |
|---|---|---|
| `GET /api/o/:slug/plan` | any member | `OrgPlanView`: plan, name, status, entitlements, `usage` (seats = members + pending; `agent_connections` = the caller's own; `ai_summaries` = this month's), `over` |
| `GET /api/o/:slug/sync` | any member | `SyncStatusView` — its `summaries` is the allowance: status, used, cap, remaining, pending (`sync.md`) |
| `GET /api/orgs` | signed in | adds `grants: MyGrant[]`, `can_create` |
| `POST /api/orgs` | holds a usable grant | 201 the org; 403 `no_grant` |
| `GET /api/platform/grants` | superadmin | `{ grants: PlatformGrant[] }` |
| `POST /api/platform/grants` | superadmin | 201 `{ ok, grant }`; 400 `invalid_grant`; 404 `no_such_person` |
| `POST /api/platform/grants/:id/revoke` | superadmin | `{ ok, grant }`; 404; 409 `grant_used` |
| `PUT /api/platform/orgs/:slug/plan` | superadmin | `{ ok, org }` (the Platform row, with `plan`); 400 `invalid_plan` / `invalid_overrides` |
| `POST /api/platform/orgs` | superadmin | also takes `plan` (default `team`) and `overrides` |

## The billing seam

`src/plans/billing.ts` is everything a payment integration calls — no superadmin, no session. Its webhook
handler builds `platform(env, BILLING_ACTOR)` and calls only these:

| When | Call |
|---|---|
| a payment succeeded for plan X by person / e-mail Y, who has no org | `grantOrganization(env, p, { to, plan, overrides?, note?, expires_in_days?, external_ref, origin? })` → a `PlatformGrant`. Idempotent on `external_ref`; mails an e-mail grantee when `origin` is given |
| the subscription starts, changes or renews for an org | `setOrgPlan(p, slug, { plan, overrides?, source: "billing", status?, period_end?, customer_id?, subscription_id? })` |
| a renewal failed | `markOrgPastDue(p, slug)` |
| the subscription ended | `cancelOrgPlan(p, slug)` — readable, working, no additions. (To shrink instead: `setOrgPlan(p, slug, { plan: "personal" })`.) |
| read | `orgPlan(p, orgId)`, `getGrant(p, id)` |

Reserved for it and written by nothing yet: `orgs.plan_period_end`, `orgs.billing_customer_id`,
`orgs.billing_subscription_id`, `org_grants.external_ref` (unique: one grant per payment), and
`PlanDef.billing` (`{ price_id }`) in `shared/plans.ts` for a plan's price. `orgs.plan_source` /
`org_grants.source` already distinguish `granted` from `billing`.

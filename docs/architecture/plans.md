# Plans, limits and grants

Every organization is on a **plan**; a plan is a name over a table of **limits** (and, later, a list of
**features**). A signed-in person creates an organization on **Free** with no grant (one they own at a time);
anything else comes from a **grant** — one a superadmin gave, or one a payment made (`billing.md`). No prices
live in Trov: the last section is the seam billing uses.

Code: `shared/plans.ts` (the plans, the limits, the one refusal — shared by the Worker, the SPA and the
landing page), `src/plans/` (`state.ts`, `gate.ts`, `grants.ts`, `gifts.ts`, `free.ts`, `billing.ts`, `routes.ts`).
Migrations: `0044_plans.sql`, `0048_plan_gifts.sql`. Tests: `test/plans.limits.test.ts`, `test/plans.grants.test.ts`,
`test/plans.gifts.test.ts`, `test/render.plans.test.ts`, `test/render.gifts.test.ts`, `test/orgs.routes.test.ts` (Free).

## The plans

The numbers are the owner's. They live in ONE place — `PLANS` in `shared/plans.ts` — and changing a number
there changes it everywhere (enforcement reads the resolved value; the screens read the same table). `null`
means unlimited. Plan ids are stored and never renamed: **`team` is the plan users see as "Pro"**.

| Limit (`LimitKey`) | Free (`free`) | Pro (`team`) | Enterprise | Personal (legacy) | Counted | Enforced at |
|---|---|---|---|---|---|---|
| `seats` | 3 | **the seats paid for**, up to 50 (50 when granted) | unlimited (set per org) | 1 | members + pending invitations, per org | an invitation created (`createInvite`, the legacy `/invites` alias, the superadmin's owner invitation), an invitation accepted (`respondToInvite`, `consumeLegacyInvite`), a person added directly (`assignOrgAdmin`) |
| `repositories` | 1 | 5 | 10 | 1 | `org_repos` rows | `addRepo` (a new repository; promoting one the org has is not an addition) |
| `environments` | 2 | 5 | 10 | 2 | `org_environments` rows | `putEnvironment` (a new key; an edit is not an addition) |
| `artifact_bytes` | 250 MB | 5 GB | unlimited | 250 MB | `SUM(artifact_versions.size_bytes)` — every stored version, deleted pages included | `writeVersion`, `insertPage`, `mintUploadToken`, `consumeUploadToken` (`src/tools/artifacts.ts`) — so HTTP, the upload link and the MCP artifact tools alike |
| `agent_connections` | 5 | 10 | unlimited | 5 | PER PERSON: that person's live MCP tokens + connected apps into the org | `mintToken`, `issueAuthorization` (the OAuth consent) |
| `ai_summaries` | 300 | 3,000 | unlimited | 300 | PER CALENDAR MONTH (UTC): summarizer calls attempted for the org | `orgSummarizers` (`src/plans/summaries.ts`) — it refuses nothing: past it an item shows its excerpt (below) |

- **Free** is what anyone signed in creates (below, *Free*), and what a paid org moves to when its
  subscription ends (`billing.md`).
- **Pro** is bought **per seat** ($10 / seat / month, no minimum: `billing.md`). A paid Pro org's `seats` is
  an override written from the subscription's quantity, so the seats paid for are the seats allowed; 50 is
  the most Pro sells and the cap of a Pro org granted by hand.
- **Enterprise**'s repositories and environments are the platform caps from before plans (the repo cron's
  subrequest budget is shared — `data-layer.md` › Background jobs), so an org that existed before sees no
  change.
- **Personal** is LEGACY (`PlanDef.offered: false`): no longer sold or shown on the pricing page, hidden from
  Platform's plan pickers unless it is the org's current plan; an org or grant already on it keeps it. It
  stays the `FALLBACK_PLAN` (the smallest): an unknown plan id reads as it.

**Features** (`PlanDef.features`, `FEATURE_KEYS`): capabilities a plan includes beyond its limits. NONE is
gated yet — the list is empty on every plan; the first will be Pro-only automation. To gate one, add its key
to `FEATURE_KEYS`, list it on each plan that includes it, and call `requireFeature(ctx, key)` (`gate.ts`,
beside `requirePlan`) on its write path. A plan without it is refused with `PlanFeatureError` — HTTP 402
`{ error: "plan_feature", feature, plan, status, message, paid?, next? }` through `app.onError`, an MCP tool
error with `code: "plan_feature"` (`planFeatureRefusal` in `shared/plans.ts`). Features are not overridable
per org, and a canceled plan includes none. Until one is gated, the pricing page's "a plan is a table of
limits, never a feature switch" stays true.

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
{ "error": "plan_limit", "limit": "seats", "used": 4, "cap": 4, "plan": "team", "status": "active",
  "message": "This organization has reached the 4 seats its Pro plan includes.", "paid": true, "next": "add_seat" }
```

`next` is the one thing the org's OWNER can do about it in Trov (`planNext`): **`add_seat`** — a paid Pro
org (`source: "billing"`) out of seats, below Pro's 50; **`upgrade`** — any refusal on a Free org. Absent
otherwise (a granted plan: ask Trov; an ended one: renew; Pro at 50 seats).

402 rather than 403: a 403 here means "your role may not" and an owner can fix that; no role in the org can
fix this one, and nothing else in the app answers 402, so a client branches on the status alone. Over MCP it
is a tool error with `code: "plan_limit"`. The SPA shows `message` plus who can change the plan
(`planRefusalSentence` over `PLAN_CHANGE_POINTER`): an owner reads the `next` pointer when there is one —
"Add a seat to invite more people." / "Upgrade to Pro for more."; otherwise an owner of a GRANTED org reads
"Ask Trov to change your plan.", an owner of an org that PAYS (`paid: true`) "You can upgrade or manage
billing in Org settings." (ended: "You can renew it in Org settings."); everyone else "Ask one of this
organization's owners.". At the seat cap the Members tab shows the owner the button for `next` (`inviteGate`,
`seatCapAction` in `web/src/org-plan.ts`): **Add a seat** opens Stripe's portal at the seat count; **Upgrade
to Pro** starts a checkout for the org (`billing.md`). The button shows only where it can work (a paid org
with a customer; a Free org with Pro priced).

## Seats

A seat is a **member or a pending invitation** — so ten invitations cannot be accepted into an eleventh
seat. Two rules, one per way a seat is taken:

- **reserve** (a new invitation, a person added directly): refused when members + pending ≥ seats.
- **accept** (a pending invitation becoming a member — its seat was reserved when it was made): refused only
  when the org is already full of MEMBERS, which happens after its plan shrank.

The condition is in the INSERT that takes the seat (`SEAT_FREE`, `MEMBER_SEAT_FREE`), not only in a check
before it: of two requests racing for the last seat, one writes. Lifting a current member to owner, or
upgrading a pending invitation to an owner's, takes no seat. A one-person PLAN (Personal: `isSoloPlan`)
refuses an invitation in a sentence that names the plan that allows them, and the Members tab shows no invite
form; a Pro org that bought ONE seat is not one — it is at its cap and its owner adds a seat. The other
limits are check-then-write, as the caps they replaced were.

## Over a limit

An org can end up over a limit — its plan was changed (a Pro subscription ended and the org moved to Free),
its paid seats lowered, or an override lowered. Then, and always:

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

**Where it shows.** Org settings › General › Plan lists it like any limit ("AI summaries — 1,212 of 3,000
this month") with, at the cap, "New pull requests and issues show an excerpt until next month." It is
never "over the limit" (`overLimits` skips a monthly allowance) — so billing's "switch to a smaller plan"
confirmation never counts it among what the org would be over; when the month's use is already at the
smaller plan's allowance it says that, in the allowance's own sentence. The pricing page lists it on each
card ("3,000 AI summaries per month"; an unlimited one names no period) and in the comparison table.
Platform › Usage shows, per org and in total, attempted / succeeded / fell back for the window and the
month's use against the cap; an organization's own Platform page has the same line. The Sync panel shows
what a run will attempt and what is left. With **no key at all** nothing is counted or capped, and the
Sync panel, Platform › Usage and an organization's Platform page each say that summaries are off on this
deployment — as a fact, not an error.

**One formatter.** A limit's number is written by `formatLimit` / `formatUse` (`shared/plans.ts`), with
thousands separators (`formatCount`); `limitPhrase` adds what it counts ("AI summaries per month", "agent
connections per person") and `limitNoun` names a limit inside a sentence. The Plan block, Platform and
the pricing page all go through them — none formats a count itself.

**With billing's plan states** (`billing.md` › What each state does). The summarizer choice reads the
columns billing writes (`orgs.plan`, `plan_overrides`, `plan_status`, through `planOf` — what `orgPlan`
returns): `active` and **`past_due` summarize** (past due limits nothing); an **ended** subscription moves the
org to Free, which summarizes on Free's allowance (the month's use carries over); an upgrade moves it to
Pro's; a superadmin's pinned plan is the one whose allowance applies; a legacy **`canceled`** (frozen) org
does not summarize (new items show an excerpt; nothing errors).
`test/summaries.billing.test.ts` drives each transition with Stripe's own events.

**The numbers**: 300 (Free, and legacy Personal), 3,000 (Pro), unlimited (Enterprise, sized per org with an
override like every limit; `0` turns summaries off for an org). They are sized against the bill, not from
measured use: they bound the worst case to a known figure per org per month.

**Estimating cost.** Platform › Usage's totals, or directly:

```sql
SELECT org_id, metric, SUM(count) FROM org_usage_daily
 WHERE day >= '2026-10-01' AND metric GLOB 'summary*' GROUP BY org_id, metric;
```

Cost ≈ `tokens_in × input price + tokens_out × output price` for the model in use (`GEMINI_MODEL` in
`src/tools/summarize.ts`, `gemini-2.5-flash-lite`); where tokens were not recorded, characters ÷ 4 is the
usual approximation. Input dominates and scales with the description, so at most its first **8,000
characters** are sent (`SUMMARY_BODY_MAX`, `capSummaryBody` — the title always goes whole; a cut never
splits a surrogate pair); sizes are recorded, not just calls. Check the provider's current prices; none is
stored here.

**Owner step.** Summaries are **off** until the key is set: `wrangler secret put GEMINI_API_KEY`. From then
on every org's new pull requests and assigned issues are summarized on capture (webhook) and on Sync, each
call is counted, and each org's plan allowance applies. Existing excerpt rows fill in at each org's next
Sync GitHub. Removing the secret turns it all off again; nothing else changes.

## Where the plan shows

A plan belongs to an ORGANIZATION and its owner pays for every seat; everyone in the org may read it
(`GET /api/o/:slug/plan`). It is shown in two places, from ONE read (`state.org.plan`) and ONE set of words
(`web/src/org-plan.ts`):

- **Org settings › General** — `planBlock`: the Plan and Limits tiles (above, and `billing.md`).
- **Personal Settings** (`#settings`, `web/src/settings-plan.ts`) — for the organization on screen:
  - **Plan** (`settingsPlanTile`): whose plan it is and my role in it; the plan's name; **the price it is
    actually charged** (`planPriceWords`: a live subscription on an interval `PRICING` has a price for —
    "$10 per seat / month"; a granted, gifted, pinned or yearly-without-a-yearly-price plan says nothing, and
    Enterprise says the pricing page's "Custom pricing"; a Free org also reads "Pro is $10 per seat / month.");
    the status chips, the gift line and the payment sentence; and **the Plan block's own buttons** for an
    owner — Upgrade to Pro, Change seats, Manage billing, Keep Pro by paying — the same `orgBilling…` acts and
    `state.org.billing`. Anyone else gets no button: the Plan block's sentence naming who can change it, and a
    link to Org settings › General. "Compare plans" opens `/pricing`. All of it comes through `planParts`
    (`org-plan.ts`), which returns the Plan block's chips / gift / sentence / buttons / closing line in parts;
    the one sentence this tile words itself is a never-paid Free org's (the Plan block's says the limits are
    "below", and here they are beside it).
  - **Limits** (`settingsLimitsTile`): every `LIMIT_KEYS` row as "used of limit" with a quiet meter
    (`role="meter"`), what it counts, "yours" on the per-person one and "this month" on the allowance; "Over
    the limit" in amber and the spent-allowance sentence as in Org settings. A use that is not a number is
    **"—" with an empty meter, never 0** (the route always sends numbers today; the tile does not assume it).
  - **Organizations** (`settingsOrgsTile`): every org I belong to — my role, its plan's chip, a link that
    opens it — from `GET /api/orgs`, whose rows carry `plan` and `paid` (`listMyOrgs`, `src/orgs/repo.ts`:
    `paid` = `plan_source = 'billing'` with a subscription, not Free, not `canceled`; so also on `/auth/me`).
    Who pays is said only when `paid`: "you manage its billing" to an owner, "paid for by its owners" to
    anyone else — never "you pay", since an org may have several owners and nothing here says whose card it
    is. Then Create organization (the picker's `orgsCreateOpen`) when `can_create`, else `FREE_TAKEN_SENTENCE`
    (already owns a Free one) or, for a superadmin, a pointer to Platform; pending invitations are counted.
  - Opening Settings loads the plan ALONE (`orgCtl.loadPlan()`, retry act `orgPlanReload`) and re-reads
    `GET /api/orgs`. Not read yet is a skeleton in each tile; a failed read is a sentence and Try again.
  - Tests: `test/render.settings-plan.test.ts`, `test/orgs.routes.test.ts` (`plan` / `paid`).

## Plan status

`orgs.plan_status`: `active`; `past_due` (changes nothing — the grace period is Stripe's retry schedule, `billing.md`); `canceled`
— the org stays readable and working, and every addition a limit governs is refused until `setOrgPlan` puts
it on a plan again (AI summaries stop too: new items show an excerpt). Billing no longer writes `canceled`:
an ended subscription moves the org to Free (`moveOrgToFree`); the status remains for an org frozen before
that, and `cancelOrgPlan` stays in the seam. Nothing sets a status but billing's functions below.

## Gifts: a plan for free until a date

A superadmin can give an organization a plan **for free until a date**; when the date passes the
organization moves to Free by itself, with nothing deleted. This is the only thing in Trov that ends a
plan on a date without Stripe: a plan set with Change plan, and a grant without a length, last until
someone changes them. Code: `src/plans/gifts.ts`; `0048_plan_gifts`; tests `test/plans.gifts.test.ts`,
`test/render.gifts.test.ts`.

**Data.** `orgs.plan_gift_until` — the instant the plan ends (ISO-8601 UTC, always `toISOString()` so it
compares as text); NULL = the plan is not a gift. `org_grants.gift_days` — a grant's gift as a LENGTH (below).
Who gave a gift and when is the audit trail's (`plan.gift`, `plan.gift_end`), not a column.

**A length** (`giftEnd`, `shared/plans.ts`) is `{ days }` — a whole number, 1 to `GIFT_MAX_DAYS` (1,095) — or
`{ until }`: a `YYYY-MM-DD` day, which runs to the END of that day UTC, or a full instant. The end must be in
the future and at most three years away. Platform's presets (`GIFT_PRESETS`) are 1 / 2 / 3 / 6 / 12 months as
30 / 60 / 90 / 180 / 365 days, so a gift on an org and a gift on a grant mean the same thing.

| | Call | What it writes |
|---|---|---|
| **Give** (or replace) | `PUT /api/platform/orgs/:slug/plan { plan, overrides?, gift }` → `giftOrgPlan` → `setOrgPlan(…, { gift_until })` | the plan (never Free: 400 `invalid_gift`), its overrides as for Change plan, `plan_source = 'granted'`, the end. Audited `plan.gift` |
| **Extend** | `POST /api/platform/orgs/:slug/gift/extend { days } \| { until }` → `extendOrgGift` | only the end: `days` are added to the CURRENT end, `until` sets it. Compare-and-set on the end it read. Audited `plan.gift` (`extended_from`). 409 `not_gifted` |
| **End now** | `POST /api/platform/orgs/:slug/gift/end` → `endOrgGift` | Free at once, as at the gift's end. Audited `plan.gift_end` (`reason: "ended"`). 409 `not_gifted` |
| **Expire** | `expireGifts(p, now)` — the repo cron's EVERY tick (`src/repo/cron.ts`, beside the handoff expiry; no cron of its own) | every org whose end has passed: Free. Audited `plan.gift_end` by `system` (`reason: "expired"`) |

- **Only an org that does not pay through a live subscription** can be given a gift: 409 `billed` otherwise
  (a date must not end what Stripe charges for). One whose subscription has ended can.
- **Any other plan write clears the gift** (`setOrgPlan` without `gift_until`): Change plan on a gifted org
  makes its plan permanent (the dialog says so; the audit row carries `gift_cleared`), and billing's
  `setOrgPlan` on fulfilment leaves a paid org with no end date.
- **Ending is what `moveOrgToFree` writes** for a cancelled subscription — Free, `active`, overrides cleared —
  with `plan_source = 'granted'` (nobody ever paid: the org is then exactly a self-served Free org), and the
  over-limit rule is all that applies: nobody is removed, every read works, additions over a Free limit are
  refused (402, `next: "upgrade"`) until the org is back under or upgrades.
- **The expiry is one guarded batch per org, by that org's id**: the UPDATE carries `plan_gift_until <= ?`
  and `plan_source <> 'billing'`, and its audit row is written `WHERE changes() > 0`. So it is idempotent, safe
  to run twice or late, and a payment, an extension or a plan change that lands between the cron's read and
  its write wins. An org that pays (`plan_source = 'billing'`) only has the lapsed gift CLEARED
  (`reason: "paid"`); its plan is left alone. It never throws out of the cron: a failed org is counted and
  retried on the next tick. Precision is the tick: an org moves within about ten minutes of its end.
- **A gifted grant** — `POST /api/platform/grants { …, gift_days }` (1–1,095; refused on Free and on a paid
  grant, 400 `invalid_grant`). The clock starts when the grantee CREATES the organization: the creating batch
  sets `plan_gift_until = created + gift_days` (`grantGiftStmts`) and audits `plan.gift` with the grant's id.
  The grant itself still has no end (`expires_at` is only the date by which it must be used). The notice
  mail, the picker's row and the create dialog say how long it is free and what happens after.
- **Paying before the end.** A gifted org's owner may start a subscription while the gift runs
  (`POST /api/o/:slug/billing/upgrade`, which otherwise accepts only Free): `orgBillingView` answers a view
  with `gifted: true` and `upgrade_to`, fulfilment (`upgradeOrg`) is the usual `setOrgPlan(team, { seats },
  source: "billing")`, and that clears the gift. **The paid plan takes over at once** — the seats bought become
  the seat cap, and a gifted Enterprise org moves to Pro's limits — the rest of the gift is not kept.
- **What the org's people read.** `GET /api/o/:slug/plan` carries `gift_until` (null for a plan that is not
  a gift). The Plan tile (`giftNote`, `web/src/org-plan.ts`) says "Free until <date>, a gift from Trov. After
  that this organization moves to Free; nothing is deleted." — the amber note in its last `GIFT_SOON_DAYS` (7).
  The owner gets "Keep Pro by paying" only where billing is set up and Pro is on sale.
- **No mail is sent** when a gift is given to an existing org, when it is about to end, or when it ends.

## Free: an organization of one's own, with no grant

Any signed-in person who is not a superadmin may create a **Free** organization (issue #94;
`src/plans/free.ts`): `POST /api/orgs { slug, name }` with no grant named — `plan: "free"` asks for Free even
while holding a grant; holding none, Free is what naming nothing makes. They become its owner; it starts on
`free` with no overrides, `plan_source = 'granted'` (no payment), audited `org.create` + `member.add` +
`org.create_free`.

**One owned Free org at a time** (`DEFAULT_ORG_LIMIT = 1`, `shared/orgs.ts`): what counts is the Free orgs
the person is an OWNER of — suspended ones too. One they upgraded to Pro, or one somebody else owns, does not
count; one whose Pro subscription ended (it moved to Free) does. Past it: **403 `free_org_limit`** ("you
already own a Free organization (<name>)…"). The rule is held INSIDE the creating batch: `freeGuardStmt`
writes the `org.create_free` audit row with a NULL `detail` (a NOT NULL column) when, counting the org being
created, the person owns more than one Free org — so the statement and the whole batch fail, and two racing
requests make one org (the pattern of the grant's `consumeStmt`). A superadmin gets 403 `no_grant`: Platform
is where they add organizations.

`GET /api/orgs` answers `free: { can_create, owned }` and `can_create = grants.length > 0 ||
free.can_create`. The picker shows "Create a Free organization" while `free.can_create` (the page's primary
action for someone with no organization and no grant); a refused create reads `FREE_TAKEN_SENTENCE`.

What bounds it (`abuse-limits.md`): one owned Free org per account, Free's own limits (3 seats, 1 repository,
2 environments, 250 MB, 300 summaries a month), and the per-person rate limits on invitations.

## Grants: an organization of one's own, on any plan

An organization comes to exist in four ways: a superadmin creates it and names its admin (Platform ›
Organizations — `organizations.md` §1), a superadmin **grants** a person the right to create one
themselves (Platform › Access), a person **buys Pro** and is given that same grant by billing
(`billing.md`), or a person creates a **Free** one (above). `persons.org_limit`, the per-person allowance from
before, is read by nothing; its Platform control and route are gone, and the column is dropped by the cleanup
migration.

1. **Granted** — `POST /api/platform/grants { to, plan, overrides?, note?, expires_in_days?, gift_days? }`
   (`gift_days`: the org it becomes is free for that long and then moves to Free — *Gifts*, above). `to` is
   exactly one of `{ handle }` (an existing person), `{ github_login }`, `{ email }`. The grantee needs no
   account yet. An e-mail grant is mailed a notice (`src/notifications/grant.ts`): it names who granted it
   and the plan, its only link is the site root, and it spends the granter's daily `invite` allowance (a
   superadmin is exempt). The outcome is on the grant (`mail_status`).
2. **Seen** — a grant is the caller's when it names their handle, one of their GitHub identity logins, or one
   of their provider-VERIFIED e-mails (never the editable `persons.email`) — the invitation rule.
   `GET /api/orgs` lists the usable ones in `grants` (oldest first) and sets `can_create`. A superadmin holds
   none here. The picker shows each as "You can set up an organization — <Plan>".
3. **Used** — `POST /api/orgs { slug, name, grant? }` creates the org (`grant` = an id; omitted = the oldest;
   holding none = Free, above) on the grant's plan, overrides and source, makes the caller its owner, and
   marks the grant used with the org it became — all in ONE batch. The consuming UPDATE writes `used` when the grant is still usable and a
   status the table's `org_grant_usable` CHECK refuses when it is not, which aborts the batch: a double
   submit, or a grant revoked or expired while the form was open, creates nothing (403 `no_grant`).
4. **Revoked / expired** — `POST /api/platform/grants/:id/revoke` for an unused one (409 `grant_used` after).
   `expires_in_days` is optional (1–365; the default is never); "expired" is derived, the row is not
   rewritten.

Every step is in `org_admin_audit`: `grant.create`, `grant.revoke`, `grant.use`, and for an org's plan
`plan.change`, `plan.overrides`, `plan.status`, `plan.gift`, `plan.gift_end`.

Both new tables are GLOBAL platform tables (no `org_id` column, like `platform_admins`): a grant is about a
person before any org exists. `org_grants.used_org` is deliberately not named `org_id`.

## Routes

| Route | Gate | Answers |
|---|---|---|
| `GET /api/o/:slug/plan` | any member | `OrgPlanView`: plan, name, status, `gift_until`, entitlements, `usage` (seats = members + pending; `agent_connections` = the caller's own; `ai_summaries` = this month's), `over` |
| `GET /api/o/:slug/sync` | any member | `SyncStatusView` — its `summaries` is the allowance: status, used, cap, remaining, pending (`sync.md`) |
| `GET /api/orgs` | signed in | each org with its `plan` and `paid`; adds `grants: MyGrant[]`, `can_create`, `free: { can_create, owned }` |
| `POST /api/orgs` | holds a usable grant, or may own a Free org | 201 the org; 403 `no_grant` (a grant that is not theirs, a superadmin); 403 `free_org_limit` |
| `GET /api/platform/grants` | superadmin | `{ grants: PlatformGrant[] }` |
| `POST /api/platform/grants` | superadmin | 201 `{ ok, grant }`; 400 `invalid_grant`; 404 `no_such_person` |
| `POST /api/platform/grants/:id/revoke` | superadmin | `{ ok, grant }`; 404; 409 `grant_used` |
| `PUT /api/platform/orgs/:slug/plan` | superadmin | `{ ok, org }` (the Platform row, with `plan` and `plan.gift`); 400 `invalid_plan` / `invalid_overrides`; with `gift`: 400 `invalid_gift`, 409 `billed` |
| `POST /api/platform/orgs/:slug/gift/extend` | superadmin | `{ ok, org }`; 400 `invalid_gift`; 409 `not_gifted` |
| `POST /api/platform/orgs/:slug/gift/end` | superadmin | `{ ok, org }` (now on Free); 409 `not_gifted` |
| `POST /api/platform/orgs` | superadmin | also takes `plan` (default `team`, Pro) and `overrides` |

## The pricing page

The public face of the plans is ONE pure render, `pricingSection` (`web/src/pricing.ts`), shown twice: as the
landing page's last section (nav link "Pricing") and as the static page `/pricing` (`web/pricing.html`, booted
by `web/src/pricing-page.ts`; an extra Vite input served by the assets binding like `/terms`, linked from the
footer). It restates nothing: names, descriptions and limits come from `PLANS`, prices from `PRICING` in
`shared/pricing.ts`. It shows the OFFERED plans only — Free, Pro, Enterprise. Tests:
`test/render.pricing.test.ts`.

- **What ships:** Free `price: 0` (the card says "Free"; its button "Start for free" opens `/`, where a
  signed-in person creates one — "Open Trov" when signed in); Pro `price: 10, per: "per seat / month"` (the
  card shows "$10 per seat / month", its seats as "Up to 50", and "Choose Pro" is the purchase link and the
  page's one accent action); Enterprise `price: null`, not self-serve ("Custom pricing", "Talk to us").
- **A price is `null` until the owner announces it.** The card then reads "Pricing to be announced" and its
  button is a waitlist e-mail; no number and no purchase link is ever shown for it. To announce one, set
  `price` (and `yearly`, to offer yearly billing) in `PRICING` — the card shows the amount, its button becomes
  the purchase link, and the Monthly / Yearly switch appears once any plan has both.
- **A purchase is a plain link**, `purchaseHref(plan, interval)` → `/billing/start?plan=…` (`&interval=year`
  only for yearly). It IS billing's `billingStartHref` (`shared/billing.ts`) — one source for the path the
  billing route seals and returns to. Whether to offer it is decided by `PRICING` alone (`canPurchasePlan`:
  `selfServe`, a price above zero, and a plan billing sells); the page calls no API. A plan with `selfServe:
  false` (Enterprise) is always "Talk to us". So the page does not know whether Stripe is set up
  (`billing.md`): with billing off, "Choose Pro" answers "Paid plans are not available yet". The one billing
  link anywhere public is Pro's — `test/render.pricing.test.ts` holds that.
- The switch is two native radios and CSS (`:has(:checked)`); `web/src/pricing-dom.ts` only keeps the choice
  across a rerender. `/pricing` cannot know a session, so it is always the signed-out page.
- Its sentences (what every plan includes, the questions — among them how Pro's per-seat pricing works and
  that a cancelled Pro org moves to Free) describe what the product does today. A change to seats, limits or
  how a plan is changed is a change to that copy.

## The billing seam

`src/plans/billing.ts` is everything a payment integration calls — no superadmin, no session. Its webhook
handler builds `platform(env, BILLING_ACTOR)` and calls only these:

| When | Call |
|---|---|
| a payment succeeded for plan X by person / e-mail Y, who has no org | `grantOrganization(env, p, { to, plan, overrides?, note?, expires_in_days?, external_ref, origin? })` → a `PlatformGrant` (billing passes `overrides: { seats }`). Idempotent on `external_ref`; mails an e-mail grantee when `origin` is given |
| the subscription starts, changes (plan or seats) or renews for an org | `setOrgPlan(p, slug, { plan, overrides?, source: "billing", status?, period_end?, customer_id?, subscription_id? })` |
| a renewal failed | `markOrgPastDue(p, slug)` |
| a gift's date passed (no payment involved; the cron) | `expireGifts(p, now)` (`./gifts.ts`) — the same end state as the next row, guarded per org |
| the subscription ended | `moveOrgToFree(p, slug, { period_end? })` — Free, active, still a billing org; overrides cleared; the over-limit rule applies. (`cancelOrgPlan` — readable, working, no additions — remains in the seam, unused by billing.) |
| read | `orgPlan(p, orgId)`, `getGrant(p, id)` |
| the buyer changed plan or seats before using the grant | `setPaidGrantPlan(p, external_ref, plan, { seats })` |
| the subscription ended before the grant was used | `revokeGrant(p, id)` |

**The seam is in use** (`billing.md`): Stripe's webhook (`src/billing/`) calls exactly these. A paid
grant's `external_ref` is its Stripe subscription id; `createOrgFromGrant` links the org it becomes to the
customer and subscription in the creating batch (`linkPaidOrgStmt`), from `billing_subscriptions`
(0045_billing), and takes the grant's overrides (the seats paid for). `orgs.plan_period_end`, `billing_customer_id` and `billing_subscription_id` are written
only that way and by `setOrgPlan` / `setOrgPlanStatus`. A plan's price is NOT in `PlanDef.billing` (left
null): it is a Stripe Price id in `wrangler.toml`, so the owner changes one without a release.

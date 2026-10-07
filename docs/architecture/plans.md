# Plans, limits and grants

Every organization is on a **plan**; a plan is a name over a table of **limits**. A person who is not a
superadmin comes to create an organization only by using a **grant** — one a superadmin gave, or one a
payment made (`billing.md`). No prices live in Trov: the last section is the seam billing uses.

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
(`planRefusalSentence` over `PLAN_CHANGE_POINTER`: an owner of a GRANTED org reads "Ask Trov to change your
plan."; an owner of an org that PAYS — the refusal carries `paid: true` — reads "You can upgrade or manage
billing in Org settings." (ended: "You can renew it in Org settings."); everyone else "Ask one of this
organization's owners.").

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

## Plan status

`orgs.plan_status`: `active`; `past_due` (changes nothing — the grace period is Stripe's retry schedule, `billing.md`); `canceled`
— the org stays readable and working, and every addition a limit governs is refused until `setOrgPlan` puts
it on a plan again. Nothing sets a status but billing's functions below.

## Grants: an organization of one's own

An organization comes to exist in three ways: a superadmin creates it and names its admin (Platform ›
Organizations — `organizations.md` §1), a superadmin **grants** a person the right to create one
themselves (Platform › Access), or a person **buys a plan** and is given that same grant by billing
(`billing.md`). `persons.org_limit`, the per-person allowance from before, is read by
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
| `GET /api/o/:slug/plan` | any member | `OrgPlanView`: plan, name, status, entitlements, `usage` (seats = members + pending; `agent_connections` = the caller's own), `over` |
| `GET /api/orgs` | signed in | adds `grants: MyGrant[]`, `can_create` |
| `POST /api/orgs` | holds a usable grant | 201 the org; 403 `no_grant` |
| `GET /api/platform/grants` | superadmin | `{ grants: PlatformGrant[] }` |
| `POST /api/platform/grants` | superadmin | 201 `{ ok, grant }`; 400 `invalid_grant`; 404 `no_such_person` |
| `POST /api/platform/grants/:id/revoke` | superadmin | `{ ok, grant }`; 404; 409 `grant_used` |
| `PUT /api/platform/orgs/:slug/plan` | superadmin | `{ ok, org }` (the Platform row, with `plan`); 400 `invalid_plan` / `invalid_overrides` |
| `POST /api/platform/orgs` | superadmin | also takes `plan` (default `team`) and `overrides` |

## The pricing page

The public face of the plans is ONE pure render, `pricingSection` (`web/src/pricing.ts`), shown twice: as the
landing page's last section (nav link "Pricing") and as the static page `/pricing` (`web/pricing.html`, booted
by `web/src/pricing-page.ts`; an extra Vite input served by the assets binding like `/terms`, linked from the
footer). It restates nothing: names, descriptions and limits come from `PLANS`, prices from `PRICING` in
`shared/pricing.ts`. Tests: `test/render.pricing.test.ts`.

- **A price is `null` until the owner announces it.** The card then reads "Pricing to be announced" and its
  button is a waitlist e-mail; no number and no purchase link is ever shown for it. To announce one, set
  `price` (and `yearly`, to offer yearly billing) in `PRICING` — the card shows the amount, its button becomes
  the purchase link, and the Monthly / Yearly switch appears once any plan has both.
- **A purchase is a plain link**, `purchaseHref(plan, interval)` → `/billing/start?plan=…` (`&interval=year`
  only for yearly). Whether to offer it is decided by `PRICING` alone (`canPurchase`: `selfServe` and a
  price); the page calls no API. A plan with `selfServe: false` (Enterprise) is always "Talk to us".
- The switch is two native radios and CSS (`:has(:checked)`); `web/src/pricing-dom.ts` only keeps the choice
  across a rerender. `/pricing` cannot know a session, so it is always the signed-out page.
- Its sentences (what every plan includes, the questions) describe what the product does today. A change to
  seats, limits or how a plan is changed is a change to that copy.

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

| the buyer switched plan before using the grant | `setPaidGrantPlan(p, external_ref, plan)` |
| the subscription ended before the grant was used | `revokeGrant(p, id)` |

**The seam is in use** (`billing.md`): Stripe's webhook (`src/billing/`) calls exactly these. A paid
grant's `external_ref` is its Stripe subscription id; `createOrgFromGrant` links the org it becomes to the
customer and subscription in the creating batch (`linkPaidOrgStmt`), from `billing_subscriptions`
(0045_billing). `orgs.plan_period_end`, `billing_customer_id` and `billing_subscription_id` are written
only that way and by `setOrgPlan` / `setOrgPlanStatus`. A plan's price is NOT in `PlanDef.billing` (left
null): it is a Stripe Price id in `wrangler.toml`, so the owner changes one without a release.

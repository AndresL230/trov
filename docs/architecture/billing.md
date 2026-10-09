# Billing — paying for Pro through Stripe, per seat

A person buys **Pro** (plan id `team`), **per seat**, and sets their organization up themselves, with nobody
at Trov in the loop — or the owner of a **Free** organization upgrades it to Pro. **Free** is never bought
(anyone signed in creates one: `plans.md` › Free). **Enterprise** is never bought here: it is arranged with
Trov ("contact us"). **Personal** is no longer sold. Billing only ever *moves the things plans already
have* — a grant, an org's plan, its `seats` override, its status — through the seam in
`src/plans/billing.ts`; the limits and their enforcement are `plans.md`.

Code: `shared/billing.ts` (the wire, shared with the SPA and the pricing page; `paidSeats`), `src/billing/`
(`config.ts`, `stripe.ts`, `signature.ts`, `store.ts`, `sync.ts`, `webhook.ts`, `routes.ts`, `view.ts`,
`pages.ts`), `src/auth/return-to.ts`, `web/src/billing.ts` (the waiting room), `web/src/org-plan.ts` +
`org-billing-actions.ts` (the Plan block, and the Members tab's "Add a seat" / "Upgrade to Pro").
Migrations: `0045_billing.sql`, `0047_billing_seats.sql`. Tests: `test/billing.*.test.ts`,
`test/render.billing.test.ts`.

**Money correctness:** Trov computes no amount, tax or proration and holds no price, card or address. A
price is an opaque Stripe Price id in `wrangler.toml`; the amount a buyer sees is on Stripe's page. Trov
stores ids, a status and a seat count.

## Configuration

| Name | Kind | Missing → |
|---|---|---|
| `STRIPE_SECRET_KEY` | secret | billing is OFF |
| `STRIPE_WEBHOOK_SECRET` | secret | billing is OFF (a key alone could take a payment nobody hears about) |
| `STRIPE_PRICE_TEAM` | var (`wrangler.toml`), the monthly Price id of ONE SEAT of Pro (a licensed, per-unit recurring price) | Pro cannot be bought monthly |
| `STRIPE_PRICE_TEAM_YEARLY` | var, optional, the yearly per-seat Price id | Pro is not offered yearly |
| `STRIPE_TEST_API_BASE` | local / test only | — honoured only for a loopback `http://` origin and never with a live key (`src/platform/loopback.ts` — the rule Sync's `LOCAL_UPSTREAM` follows too; both are described in `.dev.vars.example`) |

`STRIPE_PRICE_PERSONAL` / `STRIPE_PRICE_PERSONAL_YEARLY` are gone with Personal: a Personal price is not read.

**The pricing page** (`plans.md`, `web/src/pricing.ts`) is static and asks no server: it offers a purchase
link — `purchaseHref`, which is `billingStartHref` — only for a plan with a price above zero in
`shared/pricing.ts`. Pro is priced ($10 per seat / month), so "Choose Pro" links to `/billing/start?plan=team`;
Free (`price: 0`) links to `/`, where a signed-in person creates one. The page does not know whether Stripe
is set up: with billing OFF, "Choose Pro" lands on "Paid plans are not available yet". `PRICING_PATH` is that
page. (`GET /api/billing/config` is not read by it.)

**OFF** means: every billing route answers **503** `{ "error": "billing_unavailable", "message": "Paid plans
are not available yet." }` (`GET /billing/start` a page saying so when the browser asks for HTML), the
webhook answers its bare 401, `GET /api/billing/config` says `available: false`, the Plan block's buttons
are disabled with a sentence — and nothing else in the app changes (Free orgs are still created). Test or
live mode is whichever key is set (`sk_test_…` / `sk_live_…`); an event from the other mode is acknowledged
and ignored.

## Seats: what is paid for is what is allowed

Pro is sold per seat. A seat is a member or a pending invitation (`plans.md` › Seats).

- **Checkout's quantity** starts at the seats the org uses now — members + pending invitations, at least 1
  (a first purchase, before any org exists: 1) — with `adjustable_quantity` on (1 to Pro's seat cap, 50),
  so the buyer settles the number on Stripe's page. A person on their own buys one seat.
- **The quantity becomes the org's `seats` override** (`paidSeats`, `shared/billing.ts`): written by
  `src/billing/sync.ts` whenever a subscription event lands (`org_seats`), held to the plan's own cap
  (Pro's 50). The org's other overrides are kept. Before the org exists, the unused paid grant carries it in
  its `overrides` (`setPaidGrantPlan`), and the batch that creates the org copies it
  (`linkPaidOrgStmt`), so an event that lands while the form is open is not lost.
- **The mirror keeps it too** (`billing_subscriptions.quantity`, 0047), so a write made without a Stripe
  event — the superadmin's Follow subscription — puts the paid seats back.
- **At the cap**, an invitation is the 402 `plan_limit` with `next: "add_seat"` (`plans.md` › One refusal).
  The Members tab shows its owner **Add a seat**, which opens the Customer Portal straight at the
  subscription's update page (`POST …/billing/portal { seats: true }` → `flow_data.type =
  subscription_update`), where the quantity is changed. The seat cap moves when Stripe's
  `customer.subscription.updated` lands — never before. At Pro's 50 there is no seat to add: `next` is absent.
- **Fewer seats than in use** (the owner lowered the quantity): the over-limit rule — nobody is removed,
  invitations wait.

## The flow

1. **Start** — `GET /billing/start?plan=team[&interval=month|year]`, a plain link.
   Signed out → a sealed 10-minute `return_to` cookie holding that exact path (an allowlisted shape built from
   `PURCHASABLE_PLANS`, never a visitor's URL) and a sign-in page; the sign-in tail (`takeOAuthPending` →
   `takeReturnTo`) comes back here, through onboarding too. The page says it plainly: *signing in with either
   GitHub or Google creates the account.*
   Signed in → one unit of the `checkout` limit (10 / person / day), a `billing_checkouts` row binding a
   random `ref` to **the person signed in**, then `POST /v1/checkout/sessions` (mode `subscription`, the
   per-seat price × the starting quantity with `adjustable_quantity`, `client_reference_id` = the handle,
   `customer_email` = the person's provider-VERIFIED address when there is one, `metadata.trov_ref`, success →
   `/billing/done?session_id={CHECKOUT_SESSION_ID}`, cancel → `/pricing`, `Idempotency-Key:
   trov-checkout-<ref>`) and a 303 to Stripe. `plan=enterprise` → a page pointing at Trov; any other plan
   (`free`, `personal`) → 302 `/pricing`; a superadmin → a page pointing at Platform.
2. **Pay** — on Stripe's page. Trov is not involved.
3. **Fulfil — the webhook** (`POST /webhook/stripe`, below). `checkout.session.completed` →
   `grantOrganization(env, platform(env, "billing"), { to: { handle }, plan, overrides: { seats }, external_ref:
   <subscription id> })` — the SAME grant a superadmin gives by hand, carrying the seats paid for. `to` is the
   person on Trov's own checkout row, never a field of the payload and never whoever presents the session id.
4. **Wait** — `/billing/done` is only a waiting room. It polls `GET /api/billing/status?session_id=…`
   every 2 s; after 20 s it says *payment received, your organization will be ready shortly*; it rests
   after 2 minutes with "Check again". It never says a payment failed. If the webhook is late, the status
   route itself retrieves the session from Stripe (at most once per 5 s per session) and runs the SAME
   fulfilment.
5. **Set up** — when the grant exists the room goes to `/?setup=<grant>`: the picker with that
   organization's form open ("You can set up an organization — Pro. … Paid for just now."). The buyer
   names it (`POST /api/orgs`) and lands on the setup checklist, as with any grant.
6. **Link** — the batch that creates the org also runs `linkPaidOrgStmt` (`src/plans/grants.ts`): one
   `UPDATE orgs … FROM billing_subscriptions` that copies the customer id, the subscription id, the
   subscription's CURRENT plan, status and period, and the grant's seats onto the org. `plan_source` is
   `billing`.

A grant that is paid for and never used stays usable (no expiry) and follows the seats changed in Stripe;
if the subscription is cancelled first, the grant is revoked. Buying again while owning an org makes a
second grant — a second organization.

**Upgrading a Free org** — the owner presses **Upgrade to Pro** (Org settings › General, or Members at the
cap): `POST /api/o/:slug/billing/upgrade` starts a checkout FOR THAT ORG (`billing_checkouts.for_org`), with
the org's Stripe customer when it has one (an org whose earlier subscription ended) and the quantity at
members + pending. Fulfilment is `upgradeOrg` (`src/billing/sync.ts`): `setOrgPlan(team, { seats }, source:
billing, the new ids)` — no grant. A self-served Free org (source `granted`) becomes a billing org here.
The same route serves an org whose plan is a **gift** (`plans.md` › Gifts): its owner starts paying before
the gift's end, the paid plan takes over at once, and the gift is cleared — the date then ends nothing.

## The webhook

`POST /webhook/stripe` is dispatched in `src/index.ts` before the app (no session). In order:

1. The signature: `Stripe-Signature: t=…,v1=…[,v1=…]`, HMAC-SHA256 over `<t>.<raw body>` with
   `STRIPE_WEBHOOK_SECRET`, compared with `crypto.subtle.verify`, any one `v1` enough, ±5 minutes. Anything
   else — no header, wrong secret, stale, tampered, billing off — is the SAME bare **401**
   `{ "error": "unauthorized" }` and writes nothing.
2. The event id is recorded once (`billing_events`). Already handled → `200 { ok, replay: true }`, nothing
   runs. Seen but its handler failed (`processed_at` NULL) → it runs again.
3. The handler. A failure answers 500 (Stripe retries) and logs the event's id, type and a scrubbed message.

| Event | What Trov does |
|---|---|
| `checkout.session.completed`, `checkout.session.async_payment_succeeded` | `fulfilCheckout`: find Trov's row for the session (none → `unknown_checkout`; a `trov_ref` that does not match → `ref_mismatch`; not paid → `not_paid`), re-read the subscription, then the grant (`grantOrganization`, with the seats) and Trov's notice — or, for an upgrade of an existing org, `setOrgPlan` on that org (`org_upgraded`) |
| `customer.subscription.created` / `.updated` / `.deleted`, `invoice.paid`, `invoice.payment_failed` | `syncSubscription`: re-read the subscription from Stripe and make Trov match it (next table) |
| anything else | acknowledged, `ignored` |

**Converging on Stripe's state.** No handler trusts an event's order or its copy of the subscription: each
one `GET`s `/v1/subscriptions/<id>` and applies what Stripe says NOW, writing only what differs.

| Stripe says | No org yet (grant unused) | The org |
|---|---|---|
| another quantity (seats) | `setPaidGrantPlan(ref, plan, { seats })` | `setOrgPlan(plan, { …overrides, seats }, source: "billing")` — the seat cap changes in place (`org_seats`) |
| `active` / `trialing`, a new period end | — | `setOrgPlanStatus(status, { period_end })` |
| `past_due` (or `incomplete`) | — | `markOrgPastDue` |
| `active` again | — | `setOrgPlanStatus("active")` |
| `cancel_at_period_end` | — | nothing yet: the Plan block says "Cancelled: the plan ends on <date>, and then this organization moves to Free" |
| `canceled` / `unpaid` / `incomplete_expired` / `paused` | `revokeGrant` | `moveOrgToFree` (`org_free`) — also for a pinned plan |
| a price Trov does not sell | plan kept | plan kept; status, period and seats still follow |

**Why this is idempotent and order-proof.** (a) One grant per payment: `org_grants.external_ref` is the
subscription id, under a unique index, and `createGrant` returns the first grant for a repeated ref — so a
replayed event, the same payment under a new event id, and the waiting room racing the webhook all land on
one grant (`test/billing.flow.test.ts`). (b) An event id runs to completion once. (c) Every handler is a
function of Stripe's current state, not of the event, so a stale `past_due` arriving after `invoice.paid`
re-reads "active" and changes nothing; a subscription event before `checkout.session.completed` finds no
row and is a no-op, and fulfilment then reads the current state itself. (d) The org's link (and its seats)
is read from `billing_subscriptions` and the grant inside the creating batch, so an event that lands while
the form is open is not lost; one that lands after finds the org by its subscription id. (e) A late event
about an OLD subscription (one that ended before the org upgraded again) finds no org — the org now carries
the new subscription's id — and changes nothing.

## What each state does to an org

| The org | Means | The org |
|---|---|---|
| Pro, `active` | paid | everything Pro allows, with the seats paid for |
| Pro, `active`, cancelling | the owner cancelled; the period is paid | unchanged until Stripe ends it; the block shows the end date and that Free follows |
| Pro, `past_due` | a payment failed; Stripe is retrying | **unchanged — nothing is enforced.** The block and Platform say so |
| **Free**, `active`, still a billing org | the subscription ended (cancelled, or retries exhausted) | **on Free's limits** (`moveOrgToFree`): every member keeps access and reads everything; tickets, docs, the feed, agents and existing connections carry on; members can be removed. Anything **over a Free limit** is refused (402, `next: "upgrade"`) — a new invitation or member, repository, environment, artifact version, MCP token or connected app — until the org is back under or upgrades again. Nothing is deleted. AI summaries continue on Free's allowance. The Stripe customer is kept: Manage billing still opens its invoices |
| `canceled` (legacy) | a frozen org from before Free (billing no longer writes it) | readable and working; every addition a limit governs refused until a plan is set |

**Past-due grace.** `plans.md` says past-due enforces nothing, and that stands: the grace period is
Stripe's own retry schedule (Smart Retries, about three weeks by default). When it runs out Stripe marks
the subscription `canceled` or `unpaid` — whichever the owner chose under *Billing › Subscriptions and
emails › Manage failed payments* — and Trov treats both as ended: the org moves to Free. Trov adds no timer of
its own, so there is one clock and it is the one the customer's e-mails from Stripe talk about.

## Decisions

- **Seats: per seat, not flat** (replaces the earlier "flat, not per-seat" decision). Pro is $10 per seat per
  month with **no minimum** — a person on their own buys one seat — and a cap of 50 seats (Pro's own
  `seats`, which is also checkout's maximum and the most the seat override can be). The subscription's
  quantity IS the org's seat cap (its `seats` override): paid seats = allowed seats. Trov reports no
  quantity to Stripe and explains no proration: the owner changes the quantity on Stripe's pages (checkout,
  the portal), Stripe prices and prorates it, and its webhook moves the cap. The cost of not pushing
  quantities: inviting past the cap is refused until a seat is added, rather than billed automatically.
- **Personal is gone as a paid plan.** One plan is sold; `PURCHASABLE_PLANS = ["team"]`. The plan-switch
  route (`/billing/change`) and its smaller-plan confirmation existed only to move between Personal and Team
  and were removed with it. An org already on Personal keeps it (it is a legacy plan id).
- **An ended subscription moves the org to Free** (replaces "freeze it as `canceled`"). Free is a working
  plan with real limits, so the existing over-limit rule is all that is needed: nothing deleted, everyone
  reads, additions over a limit refused. The org stays a billing org (`plan_source = 'billing'`, ids kept)
  so its owner can open invoices and upgrade again with the same customer. A pinned plan ends too: nothing
  pays for it any more.
- **The superadmin and a paid org.** Change plan is allowed and audited (`plan.change` by the superadmin).
  While the subscription is live the org stays a billing org and a plan that differs from the paid one is
  **pinned** (`billing_subscriptions.plan_pinned`): later events move status and period, never the plan or
  its limits, until **Follow subscription** (`PUT …/plan { follow_subscription: true }`), which also restores
  the paid seats from the mirror. Refusing instead would leave the owner of the platform unable to fix a
  customer's org without logging in to Stripe. On an ENDED subscription (`PlatformOrgBilling.ended`),
  Change plan takes the org back as a granted one and billing stops moving it.
- **Upgrade, not renew.** An org whose subscription ended is a Free org; it pays again the way any Free
  org does — a new checkout for the SAME org and customer (`billing_checkouts.for_org`), not a grant.

## Routes

| Route | Gate | Answers |
|---|---|---|
| `GET /billing/start?plan=team&interval=` | public (reads the session itself) | 303 → Stripe; 200 a sign-in / Enterprise page; 302 `/pricing` (any other plan); 403 page (superadmin); 429 page; 502 page; 503 |
| `GET /api/billing/config` | public | `BillingConfigResponse`: `available`, `mode`, `plans[id] = { purchasable, intervals, href }`, `contact`, `signed_in`, `manage[]` (the caller's own paid orgs, ended ones too) |
| `GET /api/billing/status?session_id=` | session; the caller's own checkout (else 404) | `{ state: "pending", paid }` \| `{ state: "ready", plan, grant }` \| `{ state: "done", org }` \| `{ state: "unpaid" }` \| `{ state: "ended" }` |
| `POST /api/o/:slug/billing/portal { seats? }` | owner, cookie only, an org with a Stripe customer | `{ url }` (`seats: true` and a live subscription: the subscription-update flow); 403 `forbidden`; 409 `not_billed`; 502 `billing_failed` |
| `POST /api/o/:slug/billing/upgrade { plan?, interval? }` | owner, cookie only, an org on Free (or a legacy `canceled` one, or one whose plan is a gift) | `{ url }` (a checkout for this org); 400 `invalid_plan`; 409 `not_free`; 429; 502; 503 |
| `GET /api/o/:slug/plan` | any member | adds `billing: OrgBillingView \| null` (no id of Stripe's): `subscribed`, `ended`, `customer`, `interval`, `seats`, `cancel_at_period_end`, `pinned`, `upgrade_to`. Present for a billing org and for every Free org |
| `GET /api/platform/orgs[/:slug]` | superadmin | `plan.billing` for a paid org: ids, Stripe's status, `ended`, `seats`, `pinned`, `dashboard_url` (test or live) |
| `PUT /api/platform/orgs/:slug/plan` | superadmin | also `{ follow_subscription: true }`; 409 `not_billed` |
| `POST /webhook/stripe` | Stripe's signature | 200 / 401 / 500 |

## Safety

- The key is read in ONE module (`config.ts`) and sent by ONE (`stripe.ts`): fixed host, redirects not
  followed, 10 s timeout, pinned `Stripe-Version`, an `Idempotency-Key` on every POST. Every error is
  scrubbed of both secrets before it is cut; a 2xx that echoes the key is refused whole. Canary tests:
  `test/billing.leak.test.ts`. Nothing reachable from `src/mcp.ts` imports `src/billing/`
  (`test/secrets.mcp.test.ts`).
- A person opens the portal only for an org they OWN; the customer is read from that org's row.
- A session id claims nothing: status is the caller's own checkouts only, and fulfilment grants the person
  on Trov's row. Isolation: `test/isolation.http.test.ts`.
- Abuse: `checkout` is 10 / person / day (`abuse-limits.md`), for a purchase and an upgrade alike. Trov
  mails nobody an address typed at checkout: Stripe sends receipts, and Trov's "your organization is ready"
  notice goes to the buyer's provider-verified address through the platform's delivery.

## Running it in Stripe test mode

Everything works with test keys; do this before live. Locally: put the test values in `.dev.vars`
(`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_TEAM` and optionally `STRIPE_PRICE_TEAM_YEARLY`),
run `npm run dev`, and forward events with the Stripe CLI — `stripe listen --forward-to
localhost:8787/webhook/stripe` prints the `whsec_…` to use. Pay with card `4242 4242 4242 4242`, any future
date, any CVC. `4000 0000 0000 0341` attaches and then fails on renewal (past due). The suite never reaches
Stripe: `test/helpers/billing.ts` is an in-memory stand-in.

## Owner checklist

1. Create the Stripe account (or use the existing one) and stay in **test mode**.
2. Create ONE Product, **Trov Pro**, with a **recurring, per-unit** Price of **$10 per month** ("Recurring",
   "Per unit", the price of one seat; a yearly per-unit price too if you want to offer it). Archive any old
   Trov Personal / Trov Team flat prices.
3. Paste the Price id (`price_…`) into `wrangler.toml` `[vars]` as `STRIPE_PRICE_TEAM` (and
   `STRIPE_PRICE_TEAM_YEARLY`), in both `[vars]` and `[previews.vars]` if a Preview should sell. Remove any
   `STRIPE_PRICE_PERSONAL*` left in the dashboard.
4. `wrangler secret put STRIPE_SECRET_KEY` (the test `sk_test_…`).
5. In Stripe › Developers › Webhooks add the endpoint `https://trov.dev/webhook/stripe` with exactly:
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`,
   `invoice.paid`, `invoice.payment_failed`. Then `wrangler secret put STRIPE_WEBHOOK_SECRET` (its `whsec_…`).
6. Configure the **Customer Portal** (Settings › Billing › Customer portal): allow updating payment methods,
   viewing invoices, and cancelling (at the end of the period is the kinder default). Enable
   **Subscriptions › Customers can update subscriptions → quantity** for the Pro price, with a maximum of 50
   if the portal offers one: without it "Add a seat" / "Change seats" opens a page that cannot change seats.
7. Under *Manage failed payments*, choose what happens when retries run out (**cancel the subscription** and
   "mark unpaid" both move the org to Free).
8. Deploy (a merge to `main` applies `0047_billing_seats` and ships the Worker; a secret change alone also
   ships the latest build). Buy Pro with `4242…` and 2 seats, name the organization, invite until the cap,
   press Add a seat, raise it to 3 in the portal, see the cap move, then cancel it and see the org on Free.
   Also: create a Free org from a second account and Upgrade to Pro.
9. Switch to live: create the same Product and Price in live mode, paste the live Price id, put the live
   `sk_live_…` and a live endpoint's `whsec_…`, and repeat steps 6–7 in live mode (portal settings are per
   mode).

**Yours to decide:** a yearly price or not; a free trial or not (a trial needs
`subscription_data[trial_period_days]` in `startCheckout` — one line — and reads as `active` here); tax
(Stripe Tax on or off; on needs `automatic_tax[enabled]=true` and an address at checkout); promotion codes;
the refund policy (refunds are made in the Stripe dashboard — Trov has no refund code); Terms / Privacy
wording for paid plans (`web/src/legal.ts`); and whether the numbers in `shared/plans.ts` are the ones you
want to sell.

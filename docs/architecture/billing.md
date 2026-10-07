# Billing — paying for a plan through Stripe

A person buys **Personal** or **Team** and sets their organization up themselves, with nobody at Trov in
the loop. **Enterprise** is never bought here: it is arranged with Trov ("contact us"). Billing only ever
*moves the things plans already have* — a grant, an org's plan, its status — through the seam in
`src/plans/billing.ts`; the limits and their enforcement are `plans.md` and are unchanged.

Code: `shared/billing.ts` (the wire, shared with the SPA and the pricing page), `src/billing/` (`config.ts`,
`stripe.ts`, `signature.ts`, `store.ts`, `sync.ts`, `webhook.ts`, `routes.ts`, `view.ts`, `pages.ts`),
`src/auth/return-to.ts`, `web/src/billing.ts` (the waiting room), `web/src/org-plan.ts` +
`org-billing-actions.ts` (the Plan block). Migration: `0045_billing.sql`. Tests: `test/billing.*.test.ts`,
`test/render.billing.test.ts`.

**Money correctness:** Trov computes no amount, tax or proration and holds no price, card or address. A
price is an opaque Stripe Price id in `wrangler.toml`; the amount a buyer sees is on Stripe's page. Trov
stores ids and a status.

## Configuration

| Name | Kind | Missing → |
|---|---|---|
| `STRIPE_SECRET_KEY` | secret | billing is OFF |
| `STRIPE_WEBHOOK_SECRET` | secret | billing is OFF (a key alone could take a payment nobody hears about) |
| `STRIPE_PRICE_PERSONAL`, `STRIPE_PRICE_TEAM` | var (`wrangler.toml`), monthly Price ids | that plan cannot be bought monthly |
| `STRIPE_PRICE_PERSONAL_YEARLY`, `STRIPE_PRICE_TEAM_YEARLY` | var, optional | that plan is not offered yearly |
| `STRIPE_TEST_API_BASE` | local / test only | — honoured only for a loopback `http://` origin and never with a live key (`src/platform/loopback.ts` — the rule Sync's `LOCAL_UPSTREAM` follows too; both are described in `.dev.vars.example`) |

**The pricing page** (`plans.md`, `web/src/pricing.ts`) is static and asks no server: it offers a purchase
link — `purchaseHref`, which is `billingStartHref` — only for a plan with a price in `shared/pricing.ts`.
Every price there is `null` today, so nothing public links to `/billing/start`. `PRICING_PATH` is that page.
Set a price there only after billing is on. (`GET /api/billing/config` is not read by that page.)

**OFF** means: every billing route answers **503** `{ "error": "billing_unavailable", "message": "Paid plans
are not available yet." }` (`GET /billing/start` a page saying so when the browser asks for HTML), the
webhook answers its bare 401, `GET /api/billing/config` says `available: false`, the Plan block's buttons
are disabled with a sentence — and nothing else in the app changes. Test or live mode is whichever key is
set (`sk_test_…` / `sk_live_…`); an event from the other mode is acknowledged and ignored.

## The flow

1. **Start** — `GET /billing/start?plan=personal|team[&interval=month|year]`, a plain link.
   Signed out → a sealed 10-minute `return_to` cookie holding that exact path (an allowlisted shape, never a
   visitor's URL) and a sign-in page; the sign-in tail (`takeOAuthPending` → `takeReturnTo`) comes back here,
   through onboarding too. The page says it plainly: *any GitHub account can sign in and that creates the
   account; Google only opens an account that already exists.*
   Signed in → one unit of the `checkout` limit (10 / person / day), a `billing_checkouts` row binding a
   random `ref` to **the person signed in**, then `POST /v1/checkout/sessions` (mode `subscription`, the
   plan's price × 1, `client_reference_id` = the handle, `customer_email` = the person's provider-VERIFIED
   address when there is one, `metadata.trov_ref`, success → `/billing/done?session_id={CHECKOUT_SESSION_ID}`,
   cancel → `/pricing`, `Idempotency-Key: trov-checkout-<ref>`) and a 303 to Stripe.
   `plan=enterprise` → a page pointing at Trov; a superadmin → a page pointing at Platform.
2. **Pay** — on Stripe's page. Trov is not involved.
3. **Fulfil — the webhook** (`POST /webhook/stripe`, below). `checkout.session.completed` →
   `grantOrganization(env, platform(env, "billing"), { to: { handle }, plan, external_ref: <subscription id> })`
   — the SAME grant a superadmin gives by hand. `to` is the person on Trov's own checkout row, never a field
   of the payload and never whoever presents the session id.
4. **Wait** — `/billing/done` is only a waiting room. It polls `GET /api/billing/status?session_id=…`
   every 2 s; after 20 s it says *payment received, your organization will be ready shortly*; it rests
   after 2 minutes with "Check again". It never says a payment failed. If the webhook is late, the status
   route itself retrieves the session from Stripe (at most once per 5 s per session) and runs the SAME
   fulfilment.
5. **Set up** — when the grant exists the room goes to `/?setup=<grant>`: the picker with that
   organization's form open ("You can set up an organization — Team. … Paid for just now."). The buyer
   names it (`POST /api/orgs`) and lands on the setup checklist, as with any grant.
6. **Link** — the batch that creates the org also runs `linkPaidOrgStmt` (`src/plans/grants.ts`): one
   `UPDATE orgs … FROM billing_subscriptions` that copies the customer id, the subscription id and the
   subscription's CURRENT plan, status and period onto the org. `plan_source` is `billing`.

A grant that is paid for and never used stays usable (no expiry) and follows a plan switch made in Stripe;
if the subscription is cancelled first, the grant is revoked. Buying again while owning an org makes a
second grant — a second organization.

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
| `checkout.session.completed`, `checkout.session.async_payment_succeeded` | `fulfilCheckout`: find Trov's row for the session (none → `unknown_checkout`; a `trov_ref` that does not match → `ref_mismatch`; not paid → `not_paid`), re-read the subscription, then the grant (`grantOrganization`) and Trov's notice — or, for a renewal, `setOrgPlan` on that org |
| `customer.subscription.created` / `.updated` / `.deleted`, `invoice.paid`, `invoice.payment_failed` | `syncSubscription`: re-read the subscription from Stripe and make Trov match it (next table) |
| anything else | acknowledged, `ignored` |

**Converging on Stripe's state.** No handler trusts an event's order or its copy of the subscription: each
one `GET`s `/v1/subscriptions/<id>` and applies what Stripe says NOW, writing only what differs.

| Stripe says | No org yet (grant unused) | The org |
|---|---|---|
| another price of Trov's | `setPaidGrantPlan` | `setOrgPlan(plan, source: "billing", …)` — limits change in place |
| `active` / `trialing`, a new period end | — | `setOrgPlanStatus(status, { period_end })` |
| `past_due` (or `incomplete`) | — | `markOrgPastDue` |
| `active` again | — | `setOrgPlanStatus("active")` |
| `cancel_at_period_end` | — | nothing yet: the Plan block says "Cancelled: the plan ends on <date>" |
| `canceled` / `unpaid` / `incomplete_expired` / `paused` | `revokeGrant` | `cancelOrgPlan` |
| a price Trov does not sell | plan kept | plan kept; status and period still follow |

**Why this is idempotent and order-proof.** (a) One grant per payment: `org_grants.external_ref` is the
subscription id, under a unique index, and `createGrant` returns the first grant for a repeated ref — so a
replayed event, the same payment under a new event id, and the waiting room racing the webhook all land on
one grant (`test/billing.flow.test.ts`). (b) An event id runs to completion once. (c) Every handler is a
function of Stripe's current state, not of the event, so a stale `past_due` arriving after `invoice.paid`
re-reads "active" and changes nothing; a subscription event before `checkout.session.completed` finds no
row and is a no-op, and fulfilment then reads the current state itself. (d) The org's link is read from
`billing_subscriptions` inside the creating batch, so an event that lands while the form is open is not
lost; one that lands after finds the org by its subscription id.

## What each state does to an org

| `orgs.plan_status` | Means | The org |
|---|---|---|
| `active` | paid | everything its plan allows |
| `active`, cancelling | the owner cancelled; the period is paid | unchanged until Stripe ends it; the block shows the end date |
| `past_due` | a payment failed; Stripe is retrying | **unchanged — nothing is enforced.** The block and Platform say so |
| `canceled` | the subscription ended (cancelled, or retries exhausted) | **readable and working**: every member keeps access; tickets, docs, the feed, agents and existing connections carry on; members can be removed. **Refused (402):** a new invitation or member, repository, environment, artifact version, MCP token or connected app — until its owner renews (`POST …/billing/renew`) or a superadmin sets a plan. Nothing is deleted |

**Past-due grace.** `plans.md` says past-due enforces nothing, and that stands: the grace period is
Stripe's own retry schedule (Smart Retries, about three weeks by default). When it runs out Stripe marks
the subscription `canceled` or `unpaid` — whichever the owner chose under *Billing › Subscriptions and
emails › Manage failed payments* — and Trov treats both as `canceled`. Trov adds no timer of its own, so
there is one clock and it is the one the customer's e-mails from Stripe talk about.

## Decisions

- **Seats: flat, not per-seat.** Personal is a subscription for one seat; Team is ONE price for "up to 10
  people", the cap enforced by the plan (already built). Per-seat billing would need Trov to report a
  quantity on every invitation and to explain proration; nothing asked for it. The door stays open: the
  line item's quantity is 1 today, `seats` is already counted (`seatCounts`), and a per-seat price would be
  a `quantity` update in `sync.ts` plus a `seats` override — no schema change.
- **The superadmin and a paid org.** Change plan is allowed and audited (`plan.change` by the superadmin).
  While the subscription is live the org stays a billing org and a plan that differs from the paid one is
  **pinned** (`billing_subscriptions.plan_pinned`): later events move status and period, never the plan,
  until **Follow subscription** (`PUT …/plan { follow_subscription: true }`). Refusing instead would leave
  the owner of the platform unable to fix a customer's org without logging in to Stripe. On an ENDED
  subscription, Change plan takes the org back as a granted one and billing stops moving it.
- **A plan switch is the portal's confirm flow** (`flow_data.type = subscription_update_confirm`), so
  Stripe shows the price and the proration and takes the confirmation; the plan changes here when
  `customer.subscription.updated` lands. Team → Personal with more than one seat in use is allowed by
  Stripe and confirmed in Trov first: nobody is removed, nothing is deleted, invitations wait.
- **Renewal** of a canceled org is a new Checkout for the SAME org and customer (`billing_checkouts.for_org`),
  not a grant.

## Routes

| Route | Gate | Answers |
|---|---|---|
| `GET /billing/start?plan=&interval=` | public (reads the session itself) | 303 → Stripe; 200 a sign-in / Enterprise page; 302 `/pricing` (unknown plan); 403 page (superadmin); 429 page; 502 page; 503 |
| `GET /api/billing/config` | public | `BillingConfigResponse`: `available`, `mode`, `plans[id] = { purchasable, intervals, href }`, `contact`, `signed_in`, `manage[]` (the caller's own paid orgs) |
| `GET /api/billing/status?session_id=` | session; the caller's own checkout (else 404) | `{ state: "pending", paid }` \| `{ state: "ready", plan, grant }` \| `{ state: "done", org }` \| `{ state: "unpaid" }` \| `{ state: "ended" }` |
| `POST /api/o/:slug/billing/portal` | owner, cookie only | `{ url }`; 403 `forbidden`; 409 `not_billed`; 502 `billing_failed` |
| `POST /api/o/:slug/billing/change { plan }` | owner | `{ url }`; 400 `invalid_plan`; 409 `same_plan` / `plan_ended` |
| `POST /api/o/:slug/billing/renew { plan?, interval? }` | owner, a canceled billing org | `{ url }`; 409 `not_ended`; 429 |
| `GET /api/o/:slug/plan` | any member | adds `billing: OrgBillingView \| null` (no id of Stripe's) |
| `GET /api/platform/orgs[/:slug]` | superadmin | `plan.billing` for a paid org: ids, Stripe's status, `pinned`, `dashboard_url` (test or live) |
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
- Abuse: `checkout` is 10 / person / day (`abuse-limits.md`). Trov mails nobody an address typed at
  checkout: Stripe sends receipts, and Trov's "your organization is ready" notice goes to the buyer's
  provider-verified address through the platform's delivery (`NOTIFICATIONS_MODE = "local"` today, so it
  is written to `platform_outbox_bodies` and does not leave).

## Running it in Stripe test mode

Everything works with test keys; do this before live. Locally: put the test values in `.dev.vars`
(`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, the four `STRIPE_PRICE_*`), run `npm run dev`, and forward
events with the Stripe CLI — `stripe listen --forward-to localhost:8787/webhook/stripe` prints the
`whsec_…` to use. Pay with card `4242 4242 4242 4242`, any future date, any CVC. `4000 0000 0000 0341`
attaches and then fails on renewal (past due). The suite never reaches Stripe: `test/helpers/billing.ts`
is an in-memory stand-in.

## Owner checklist

1. Create the Stripe account (or use the existing one) and stay in **test mode**.
2. Create two Products, **Trov Personal** and **Trov Team**, each with a **recurring** Price (monthly; a
   yearly one too if you want to offer it). Flat prices, quantity 1.
3. Paste the Price ids (`price_…`) into `wrangler.toml` `[vars]`: `STRIPE_PRICE_PERSONAL`,
   `STRIPE_PRICE_TEAM`, and the `_YEARLY` pair if any.
4. `wrangler secret put STRIPE_SECRET_KEY` (the test `sk_test_…`).
5. In Stripe › Developers › Webhooks add the endpoint `https://trov.dev/webhook/stripe` with exactly:
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`,
   `invoice.paid`, `invoice.payment_failed`. Then `wrangler secret put STRIPE_WEBHOOK_SECRET` (its `whsec_…`).
6. Configure the **Customer Portal** (Settings › Billing › Customer portal): allow updating payment methods,
   viewing invoices, and cancelling (at the end of the period is the kinder default). To let owners switch
   plan, enable **Subscriptions › Customers can switch plans** and add BOTH products' prices; without it
   "Upgrade to Team" answers "could not open the plan change".
7. Under *Manage failed payments*, choose what happens when retries run out (**cancel the subscription** is
   what Trov's wording assumes; "mark unpaid" freezes the org the same way).
8. Deploy (a merge to `main` applies `0045_billing` and ships the Worker; a secret change alone also ships
   the latest build). Buy a plan with `4242…`, name the organization, open Manage billing, cancel it.
9. Switch to live: create the same Products and Prices in live mode, paste the live Price ids, put the
   live `sk_live_…` and a live endpoint's `whsec_…`, and repeat step 6–7 in live mode (portal settings are
   per mode).

**Yours to decide:** the prices; monthly only or yearly too; a free trial or not (a trial needs
`subscription_data[trial_period_days]` in `startCheckout` — one line — and reads as `active` here); tax
(Stripe Tax on or off; on needs `automatic_tax[enabled]=true` and an address at checkout); promotion codes;
the refund policy (refunds are made in the Stripe dashboard — Trov has no refund code); what a cancelled org
keeps and for how long (today: everything, indefinitely, with additions frozen); and whether the numbers in
`shared/plans.ts` are the ones you want to sell.

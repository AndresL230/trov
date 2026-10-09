/**
 * A subscription's life → the org's plan (docs/architecture/billing.md › What each state does), and the
 * owner's side of it: the Stripe portal, seats, an upgrade from Free. Pro is sold PER SEAT: the
 * subscription's quantity is the org's seat cap, and a subscription that ends moves the org to Free.
 * Every transition goes through the seam (src/plans/billing.ts) and converges on what Stripe says NOW.
 * Stand-in Stripe; nothing reaches the network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MyOrgsResponse, PlatformOrgRow, PlatformOrgDetail } from "@shared/orgs";
import type { OrgPlanView, PlanRefusal } from "@shared/plans";
import { planRefusalSentence } from "@shared/plans";
import { cookieFor, seedPerson } from "./helpers/persons";
import { call, one, rows, exec, SUPERADMIN } from "./helpers/orgs";
import { FakeStripe, PRICES, PERIOD_1, PERIOD_2, bcall, deliver, event, iso } from "./helpers/billing";

let stripe: FakeStripe;
beforeEach(() => { stripe = new FakeStripe(); vi.stubGlobal("fetch", stripe.fetch); });
afterEach(() => { vi.unstubAllGlobals(); });

const count = async (sql: string, ...p: unknown[]) => (await one<{ n: number }>(sql, ...p))!.n;
const orgRow = (slug: string) => one<{ plan: string; plan_overrides: string; plan_source: string; plan_status: string; plan_period_end: string | null; billing_customer_id: string | null; billing_subscription_id: string | null }>(
  `SELECT plan, plan_overrides, plan_source, plan_status, plan_period_end, billing_customer_id, billing_subscription_id FROM orgs WHERE slug = ?`, slug);
const planOf = async (slug: string, cookie: string) => (await bcall<OrgPlanView>("GET", `/api/o/${slug}/plan`, cookie)).json;
const audit = (slug: string) => rows<{ actor: string; action: string; detail: string }>(
  `SELECT a.actor, a.action, a.detail FROM org_admin_audit a JOIN orgs o ON o.id = a.org_id WHERE o.slug = ? AND a.action LIKE 'plan.%' ORDER BY a.id`, slug);
const boss = () => cookieFor(SUPERADMIN);

/** `handle` buys Pro with `seats` seats, the webhook lands, and they create `slug`. Returns the subscription to play with. */
async function paidOrg(handle: string, slug: string, seats = 5) {
  const cookie = await cookieFor(handle, { member: false, email: `${handle}@example.com`, verified: true });
  expect((await bcall("GET", `/billing/start?plan=team`, cookie)).status).toBe(303);
  const session = stripe.lastSession();
  const sub = stripe.pay(session.id, seats);
  await deliver(event("checkout.session.completed", stripe.sessionJson(session)));
  expect((await call("POST", "/api/orgs", cookie, { slug, name: slug })).status).toBe(201);
  const updated = () => deliver(event("customer.subscription.updated", stripe.subscriptionJson(sub)));
  return { cookie, sub, session, updated };
}
const addMember = async (slug: string, handle: string, role = "member") => {
  await seedPerson(handle, { member: false });
  await exec(`INSERT INTO memberships (org_id, user_id, role, created_at, created_by) SELECT id, ?, ?, '2026-10-01T00:00:00Z', 'seed' FROM orgs WHERE slug = ?`, handle, role, slug);
  return cookieFor(handle, { member: false });
};
const invite = (slug: string, cookie: string, email: string) => call<PlanRefusal>("POST", `/api/o/${slug}/invites`, cookie, { email });

describe("renewal, a failed payment, paid again", () => {
  it("a renewal moves the period's end and nothing else; delivered twice it writes once", async () => {
    const { sub, updated } = await paidOrg("maya", "maya-co");
    sub.current_period_end = PERIOD_2;
    expect((await deliver(event("invoice.paid", { id: "in_2", subscription: sub.id }))).json).toEqual({ ok: true, outcome: "org_period" });
    expect(await orgRow("maya-co")).toMatchObject({ plan: "team", plan_status: "active", plan_period_end: iso(PERIOD_2), plan_source: "billing" });
    const trail = await audit("maya-co");
    // The same state again, as two more events: nothing to write.
    expect((await updated()).json).toEqual({ ok: true, outcome: "unchanged" });
    expect((await deliver(event("invoice.paid", { id: "in_2b", subscription: sub.id }))).json).toEqual({ ok: true, outcome: "unchanged" });
    expect(await audit("maya-co")).toEqual(trail);
    expect(trail.at(-1)).toMatchObject({ actor: "billing", action: "plan.status" });
  });

  it("payment failed → past due: it is SAID, and nothing is enforced; paid again → active", async () => {
    const { cookie, sub, updated } = await paidOrg("maya", "maya-co");
    sub.status = "past_due";
    expect((await deliver(event("invoice.payment_failed", { id: "in_2", subscription: sub.id }))).json).toEqual({ ok: true, outcome: "org_past_due" });
    expect((await planOf("maya-co", cookie)).status).toBe("past_due");
    // Past due is Stripe's retry window: the org still adds what its plan allows.
    expect((await invite("maya-co", cookie, "new@example.com")).status).toBe(201);
    expect((await updated()).json).toEqual({ ok: true, outcome: "unchanged" });

    sub.status = "active";
    sub.current_period_end = PERIOD_2;
    expect((await deliver(event("invoice.paid", { id: "in_2", subscription: sub.id }))).json).toEqual({ ok: true, outcome: "org_active" });
    expect(await orgRow("maya-co")).toMatchObject({ plan_status: "active", plan_period_end: iso(PERIOD_2) });
    expect((await audit("maya-co")).map((a) => JSON.parse(a.detail) as { from: string; to: string }).slice(-2)).toEqual([{ from: "active", to: "past_due" }, { from: "past_due", to: "active" }]);
  });

  it("retries exhausted (unpaid) end the plan like a cancellation: the org moves to Free", async () => {
    const { cookie, sub, updated } = await paidOrg("maya", "maya-co");
    sub.status = "unpaid";
    expect((await updated()).json).toEqual({ ok: true, outcome: "org_free" });
    expect(await orgRow("maya-co")).toMatchObject({ plan: "free", plan_status: "active", plan_overrides: "{}", plan_source: "billing" });
    // Free's own limits apply: one person of three seats can still invite.
    expect((await invite("maya-co", cookie, "x@example.com")).status).toBe(201);
    expect((await updated()).json).toEqual({ ok: true, outcome: "unchanged" });
  });
});

describe("cancelling", () => {
  it("at the period's end: Pro stays and says when it ends; when Stripe ends it the org DOWNGRADES TO FREE — nothing deleted, everyone reads, additions over Free's limits refused", async () => {
    const { cookie, sub, updated } = await paidOrg("maya", "maya-co", 5);
    const mate = await addMember("maya-co", "omar");
    await addMember("maya-co", "priya", "admin");
    sub.cancel_at_period_end = true;
    expect((await updated()).json).toEqual({ ok: true, outcome: "unchanged" });
    let plan = await planOf("maya-co", cookie);
    expect(plan).toMatchObject({ plan: "team", name: "Pro", status: "active", period_end: iso(PERIOD_1) });
    expect(plan.billing).toMatchObject({ subscribed: true, ended: false, cancel_at_period_end: true, seats: 5, upgrade_to: [] });
    expect((await invite("maya-co", cookie, "still@example.com")).status).toBe(201); // 4 of 5 seats

    sub.status = "canceled";
    expect((await deliver(event("customer.subscription.deleted", stripe.subscriptionJson(sub)))).json).toEqual({ ok: true, outcome: "org_free" });
    expect(await orgRow("maya-co")).toMatchObject({ plan: "free", plan_overrides: "{}", plan_source: "billing", plan_status: "active", billing_customer_id: sub.customer, billing_subscription_id: sub.id });
    plan = await planOf("maya-co", cookie);
    // Four seats in use (three members, one pending invitation) on Free's three: over, nothing removed.
    expect(plan).toMatchObject({ plan: "free", name: "Free", status: "active", over: ["seats"] });
    expect(plan.usage.seats).toBe(4);
    expect(plan.entitlements).toMatchObject({ seats: 3, repositories: 1, environments: 2 });
    // The owner can look at invoices and upgrade again; nothing about a live subscription is offered.
    expect(plan.billing).toMatchObject({ subscribed: false, ended: true, customer: true, seats: null, cancel_at_period_end: false, upgrade_to: ["team"] });
    expect(await count(`SELECT COUNT(*) AS n FROM memberships m JOIN orgs o ON o.id = m.org_id WHERE o.slug = 'maya-co'`)).toBe(3);
    expect(await count(`SELECT COUNT(*) AS n FROM org_invites i JOIN orgs o ON o.id = i.org_id WHERE o.slug = 'maya-co' AND i.status = 'pending'`)).toBe(1);
    expect((await call("GET", "/api/o/maya-co/members", mate)).status).toBe(200);
    expect((await call("POST", "/api/o/maya-co/tickets", mate, { title: "still working" })).status).toBe(200);
    // An addition over a Free limit is refused — the owner is pointed at upgrading, the member at the owner.
    const refused = await invite("maya-co", cookie, "late@example.com");
    expect(refused.status).toBe(402);
    expect(refused.json).toMatchObject({ error: "plan_limit", limit: "seats", used: 4, cap: 3, plan: "free", status: "active", paid: true, next: "upgrade" });
    expect(planRefusalSentence(refused.json, "owner")).toBe("This organization has reached the 3 seats its Free plan includes. Upgrade to Pro for more.");
    expect(planRefusalSentence(refused.json, "member")).toMatch(/Ask one of this organization's owners\.$/);
    expect((await bcall("POST", "/api/o/maya-co/billing/portal", cookie, {})).status).toBe(200); // invoices stay reachable
    // …and removals are never refused: back under the cap, invitations work again.
    expect((await call("DELETE", "/api/o/maya-co/members/omar", cookie)).status).toBe(200);
    expect((await call("DELETE", "/api/o/maya-co/members/priya", cookie)).status).toBe(200);
    expect((await invite("maya-co", cookie, "back@example.com")).status).toBe(201);
    // Audited as billing's plan change, and a replay writes nothing.
    expect((await audit("maya-co")).at(-1)).toMatchObject({ actor: "billing", action: "plan.change", detail: expect.stringContaining(`"from":"team","to":"free"`) });
    expect((await deliver(event("customer.subscription.deleted", stripe.subscriptionJson(sub)))).json).toEqual({ ok: true, outcome: "unchanged" });
  });

  it("at once: the deleted event alone moves the org to Free", async () => {
    const { sub } = await paidOrg("maya", "maya-co");
    sub.status = "canceled";
    await deliver(event("customer.subscription.deleted", stripe.subscriptionJson(sub)));
    expect(await orgRow("maya-co")).toMatchObject({ plan: "free", plan_status: "active", plan_source: "billing" });
    expect(await one(`SELECT plan_status, quantity FROM billing_subscriptions`)).toEqual({ plan_status: "canceled", quantity: 5 });
  });

  it("before the grant was used: the grant is revoked, and the buyer can no longer create the org", async () => {
    const cookie = await cookieFor("maya", { member: false });
    await bcall("GET", "/billing/start?plan=team", cookie);
    const session = stripe.lastSession();
    const sub = stripe.pay(session.id);
    await deliver(event("checkout.session.completed", stripe.sessionJson(session)));
    const [grant] = (await call<MyOrgsResponse>("GET", "/api/orgs", cookie)).json.grants;
    expect(grant).toMatchObject({ plan: "team" });
    sub.status = "canceled";
    expect((await deliver(event("customer.subscription.deleted", stripe.subscriptionJson(sub)))).json).toEqual({ ok: true, outcome: "grant_revoked" });
    expect(await one(`SELECT status, revoked_by FROM org_grants`)).toEqual({ status: "revoked", revoked_by: "billing" });
    expect((await call<MyOrgsResponse>("GET", "/api/orgs", cookie)).json.grants).toEqual([]);
    expect((await call("POST", "/api/orgs", cookie, { slug: "too-late", name: "Too late", grant: grant.id })).status).toBe(403);
    expect((await bcall("GET", `/api/billing/status?session_id=${session.id}`, cookie)).json).toEqual({ state: "ended" });
    // Delivered again: still revoked, nothing thrown.
    expect((await deliver(event("customer.subscription.deleted", stripe.subscriptionJson(sub)))).json).toEqual({ ok: true, outcome: "grant_revoked" });
  });

  it("a paid grant that is simply never used stays usable, and follows the seats changed in Stripe", async () => {
    const cookie = await cookieFor("maya", { member: false });
    await bcall("GET", "/billing/start?plan=team", cookie);
    const session = stripe.lastSession();
    const sub = stripe.pay(session.id, 2);
    await deliver(event("checkout.session.completed", stripe.sessionJson(session)));
    sub.current_period_end = PERIOD_2;
    sub.quantity = 7;
    expect((await deliver(event("customer.subscription.updated", stripe.subscriptionJson(sub)))).json).toEqual({ ok: true, outcome: "grant_plan" });
    const [grant] = (await call<MyOrgsResponse>("GET", "/api/orgs", cookie)).json.grants;
    expect(grant).toMatchObject({ plan: "team", expires_at: null });
    expect(grant.entitlements.seats).toBe(7);
    expect((await call("POST", "/api/orgs", cookie, { slug: "later", name: "Later" })).status).toBe(201);
    expect(await orgRow("later")).toMatchObject({ plan: "team", plan_overrides: '{"seats":7}', plan_period_end: iso(PERIOD_2), billing_subscription_id: sub.id });
  });
});

describe("seats changed in Stripe — paid seats are allowed seats", () => {
  it("more seats: the seat cap follows the subscription's quantity in place, through setOrgPlan; at the cap the owner is told to add a seat", async () => {
    const { cookie, sub, updated } = await paidOrg("maya", "maya-co", 1); // a person on their own buys one seat
    expect(await orgRow("maya-co")).toMatchObject({ plan: "team", plan_overrides: '{"seats":1}' });
    const full = await invite("maya-co", cookie, "one@example.com");
    expect(full.status).toBe(402);
    expect(full.json).toMatchObject({ error: "plan_limit", limit: "seats", used: 1, cap: 1, plan: "team", paid: true, next: "add_seat" });
    expect(planRefusalSentence(full.json, "owner")).toBe("This organization has reached the 1 seat its Pro plan includes. Add a seat to invite more people.");
    expect(planRefusalSentence(full.json, "admin")).toBe("This organization has reached the 1 seat its Pro plan includes. Ask one of this organization's owners.");

    sub.quantity = 3;
    expect((await updated()).json).toEqual({ ok: true, outcome: "org_seats" });
    expect(await orgRow("maya-co")).toMatchObject({ plan: "team", plan_overrides: '{"seats":3}', plan_source: "billing", plan_status: "active", billing_subscription_id: sub.id });
    const plan = await planOf("maya-co", cookie);
    expect(plan.entitlements.seats).toBe(3);
    expect(plan.billing).toMatchObject({ subscribed: true, seats: 3 });
    expect((await invite("maya-co", cookie, "one@example.com")).status).toBe(201);
    expect((await audit("maya-co")).at(-1)).toMatchObject({ actor: "billing", action: "plan.overrides", detail: expect.stringContaining(`"overrides":{"seats":3}`) });
    expect(await one(`SELECT quantity FROM billing_subscriptions`)).toEqual({ quantity: 3 });
    // Delivered again: nothing to write. No second grant: it is the same organization.
    expect((await updated()).json).toEqual({ ok: true, outcome: "unchanged" });
    expect(await count(`SELECT COUNT(*) AS n FROM org_grants`)).toBe(1);
  });

  it("fewer seats than in use: nothing is deleted, the org is over its seats, and additions wait", async () => {
    const { cookie, sub, updated } = await paidOrg("maya", "maya-co", 5);
    await addMember("maya-co", "omar");
    const third = await addMember("maya-co", "priya", "admin");
    sub.quantity = 2;
    expect((await updated()).json).toEqual({ ok: true, outcome: "org_seats" });
    const plan = await planOf("maya-co", cookie);
    expect(plan).toMatchObject({ plan: "team", status: "active", over: ["seats"] });
    expect(plan.usage.seats).toBe(3);
    expect(await count(`SELECT COUNT(*) AS n FROM memberships m JOIN orgs o ON o.id = m.org_id WHERE o.slug = 'maya-co'`)).toBe(3);
    expect((await call("GET", "/api/o/maya-co/members", third)).status).toBe(200);
    const refused = await invite("maya-co", cookie, "fourth@example.com");
    expect([refused.status, refused.json.limit, refused.json.paid, refused.json.next]).toEqual([402, "seats", true, "add_seat"]);
    expect(planRefusalSentence(refused.json, "owner")).toMatch(/Add a seat to invite more people\.$/);
  });

  it("a quantity above Pro's seat cap is held to it (50); the other overrides of the org are kept", async () => {
    const { cookie, sub, updated } = await paidOrg("maya", "maya-co", 5);
    await call("PUT", "/api/platform/orgs/maya-co/plan", await boss(), { plan: "team", overrides: { seats: 5, repositories: 8 } }); // the same plan: pins nothing
    sub.quantity = 60;
    expect((await updated()).json).toEqual({ ok: true, outcome: "org_seats" });
    expect(JSON.parse((await orgRow("maya-co"))!.plan_overrides)).toEqual({ seats: 50, repositories: 8 });
    expect((await planOf("maya-co", cookie)).entitlements).toMatchObject({ seats: 50, repositories: 8 });
  });

  it("to a price Trov does not sell: the plan it was on is kept; status and period still follow", async () => {
    const { sub, updated } = await paidOrg("maya", "maya-co");
    sub.price = "price_made_by_hand";
    sub.current_period_end = PERIOD_2;
    expect((await updated()).json).toEqual({ ok: true, outcome: "org_period" });
    expect(await orgRow("maya-co")).toMatchObject({ plan: "team", plan_period_end: iso(PERIOD_2) });
  });
});

describe("the owner's billing routes", () => {
  it("Manage billing: a Customer Portal session for THIS org's customer, returning to its Plan block", async () => {
    const { cookie, sub } = await paidOrg("maya", "maya-co");
    const r = await bcall<{ url: string }>("POST", "/api/o/maya-co/billing/portal", cookie, {});
    expect([r.status, r.json]).toEqual([200, { url: expect.stringMatching(/^https:\/\/billing\.stripe\.com\/p\/session\//) }]);
    expect(stripe.portals).toEqual([{ customer: sub.customer, return_url: "http://localhost/maya-co/#org/general", flow: expect.anything() }]);
    const [c] = stripe.callsTo("POST", "/v1/billing_portal/sessions");
    expect(Object.fromEntries(c.params)).toEqual({ customer: sub.customer, return_url: "http://localhost/maya-co/#org/general" });
    expect(c.headers.get("idempotency-key")).toMatch(/^trov-portal-/);
  });

  it("Cancel plan: the portal, straight to THIS subscription's cancel page, and back to Trov when it is done; a plain portal once it has ended", async () => {
    const { cookie, sub } = await paidOrg("maya", "maya-co", 1);
    const r = await bcall<{ url: string }>("POST", "/api/o/maya-co/billing/portal", cookie, { cancel: true });
    expect(r.status).toBe(200);
    expect(Object.fromEntries(stripe.callsTo("POST", "/v1/billing_portal/sessions").at(-1)!.params)).toEqual({
      customer: sub.customer, return_url: "http://localhost/maya-co/#org/general",
      "flow_data[type]": "subscription_cancel", "flow_data[subscription_cancel][subscription]": sub.id,
      "flow_data[after_completion][type]": "redirect", "flow_data[after_completion][redirect][return_url]": "http://localhost/maya-co/#org/general",
    });
    // Nothing moves here: the plan changes when Stripe's event lands.
    expect(await orgRow("maya-co")).toMatchObject({ plan: "team" });
    // Seats wins if both are asked for; and with no live subscription there is nothing to cancel.
    await bcall("POST", "/api/o/maya-co/billing/portal", cookie, { seats: true, cancel: true });
    expect(Object.fromEntries(stripe.callsTo("POST", "/v1/billing_portal/sessions").at(-1)!.params)["flow_data[type]"]).toBe("subscription_update");
    sub.status = "canceled";
    await deliver(event("customer.subscription.deleted", stripe.subscriptionJson(sub)));
    expect((await bcall("POST", "/api/o/maya-co/billing/portal", cookie, { cancel: true })).status).toBe(200);
    expect(Object.fromEntries(stripe.callsTo("POST", "/v1/billing_portal/sessions").at(-1)!.params)).toEqual({ customer: sub.customer, return_url: "http://localhost/maya-co/#org/general" });
  });

  it("Add a seat: the portal, straight to THIS subscription's update page (where the seat count is changed); a plain portal once it has ended", async () => {
    const { cookie, sub } = await paidOrg("maya", "maya-co", 1);
    const r = await bcall<{ url: string }>("POST", "/api/o/maya-co/billing/portal", cookie, { seats: true });
    expect(r.status).toBe(200);
    const c = stripe.callsTo("POST", "/v1/billing_portal/sessions").at(-1)!;
    expect(Object.fromEntries(c.params)).toEqual({
      customer: sub.customer, return_url: "http://localhost/maya-co/#org/general",
      "flow_data[type]": "subscription_update", "flow_data[subscription_update][subscription]": sub.id,
      "flow_data[after_completion][type]": "redirect", "flow_data[after_completion][redirect][return_url]": "http://localhost/maya-co/#org/general",
    });
    // The seats change when Stripe says so — nothing here moves before the webhook.
    expect(await orgRow("maya-co")).toMatchObject({ plan_overrides: '{"seats":1}' });
    sub.status = "canceled";
    await deliver(event("customer.subscription.deleted", stripe.subscriptionJson(sub)));
    expect((await bcall("POST", "/api/o/maya-co/billing/portal", cookie, { seats: true })).status).toBe(200);
    expect(Object.fromEntries(stripe.callsTo("POST", "/v1/billing_portal/sessions").at(-1)!.params)).toEqual({ customer: sub.customer, return_url: "http://localhost/maya-co/#org/general" });
  });

  it("only an OWNER of that org: an admin and a member are 403, a stranger and another org's owner 404, a token 403 — and Stripe is never asked", async () => {
    await paidOrg("maya", "maya-co");
    const other = await paidOrg("omar", "omar-co");
    const admin = await addMember("maya-co", "priya", "admin");
    const member = await addMember("maya-co", "quinn");
    const stranger = await cookieFor("zed", { member: false });
    const before = stripe.calls.length;
    for (const path of ["/billing/portal", "/billing/upgrade"]) {
      for (const who of [admin, member]) {
        const r = await bcall("POST", `/api/o/maya-co${path}`, who, { plan: "team" });
        expect([r.status, (r.json as { error: string }).error], path).toEqual([403, "forbidden"]);
      }
      for (const who of [stranger, other.cookie, await boss()]) expect((await bcall("POST", `/api/o/maya-co${path}`, who, { plan: "team" })).status, path).toBe(404);
      expect((await bcall("POST", `/api/o/maya-co${path}`, "", { plan: "team" })).status).toBe(401);
      const withToken = await bcall("POST", `/api/o/maya-co${path}`, (await paidOrgOwner("maya")), { plan: "team" }, { headers: { authorization: "Bearer trov_mcp_x" } });
      expect(withToken.status).toBe(403);
    }
    expect(stripe.calls).toHaveLength(before);
  });
  const paidOrgOwner = (handle: string) => cookieFor(handle, { member: false });

  it("a GRANTED org on a paid plan has no billing: its owner is told so, and its plan view carries none", async () => {
    const owner = await boss(); // SaplingLearn's owner: an Enterprise org nobody pays for
    for (const [path, code] of [["/billing/portal", "not_billed"], ["/billing/upgrade", "not_free"]] as const) {
      const r = await bcall("POST", `/api/o/saplinglearn${path}`, owner, { plan: "team" });
      expect([r.status, (r.json as { error: string }).error], path).toEqual([409, code]);
    }
    expect((await planOf("saplinglearn", owner)).billing).toBeNull();
    expect(stripe.calls).toEqual([]);
  });

  it("Pro is the one plan sold: a live subscription's view offers seats and billing, nothing to switch to, and no route to switch", async () => {
    const { cookie } = await paidOrg("maya", "maya-co");
    expect((await planOf("maya-co", cookie)).billing).toEqual({
      available: true, subscribed: true, ended: false, customer: true, interval: "month", seats: 5,
      cancel_at_period_end: false, pinned: false, upgrade_to: [],
    });
    expect((await bcall("POST", "/api/o/maya-co/billing/change", cookie, { plan: "team" })).status).toBe(404);
    expect(stripe.callsTo("POST", "/v1/billing_portal/sessions")).toHaveLength(0);
  });

  it("a Stripe failure is a 502 with a sentence and no detail of the upstream", async () => {
    const { cookie } = await paidOrg("maya", "maya-co");
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    stripe.fail = () => Response.json({ error: { type: "invalid_request_error", message: "No configuration provided and your test mode default configuration has not been created." } }, { status: 400 });
    for (const [path, body] of [["/billing/portal", {}], ["/billing/portal", { seats: true }]] as const) {
      const r = await bcall<{ error: string; message: string }>("POST", `/api/o/maya-co${path}`, cookie, body);
      expect([r.status, r.json.error]).toEqual([502, "billing_failed"]);
      expect(r.json.message).not.toMatch(/configuration/);
    }
    spy.mockRestore();
  });

  it("Upgrade to Pro after the subscription ended (the org is on Free): a new subscription for the SAME org and customer, seats starting at what it uses, no grant; refused while Pro is live", async () => {
    const { cookie, sub, session } = await paidOrg("maya", "maya-co");
    expect((await bcall("POST", "/api/o/maya-co/billing/upgrade", cookie, {})).json).toMatchObject({ error: "not_free" });
    await addMember("maya-co", "omar");
    sub.status = "canceled";
    await deliver(event("customer.subscription.deleted", stripe.subscriptionJson(sub)));
    expect((await invite("maya-co", cookie, "pending@example.com")).status).toBe(201); // 3 of Free's 3 seats

    const r = await bcall<{ url: string }>("POST", "/api/o/maya-co/billing/upgrade", cookie, {});
    expect(r.status).toBe(200);
    const again = stripe.lastSession();
    expect(again.id).not.toBe(session.id);
    expect(r.json.url).toBe(again.url);
    // Two members and one pending invitation: three seats to start with, and the buyer may change it at Stripe.
    expect(again).toMatchObject({ customer: sub.customer, customer_email: null, price: PRICES.team, quantity: 3, cancel_url: "http://localhost/maya-co/#org/general" });
    expect(Object.fromEntries(stripe.callsTo("POST", "/v1/checkout/sessions").at(-1)!.params)).toMatchObject({
      "line_items[0][quantity]": "3", "line_items[0][adjustable_quantity][enabled]": "true", "line_items[0][adjustable_quantity][minimum]": "1", "line_items[0][adjustable_quantity][maximum]": "50",
    });
    expect(again.metadata).toMatchObject({ trov_plan: "team", trov_person: "maya", trov_org: "maya-co" });
    const newSub = stripe.pay(again.id, 4);
    expect(newSub.customer).toBe(sub.customer);
    expect((await deliver(event("checkout.session.completed", stripe.sessionJson(again)))).json).toEqual({ ok: true, outcome: "org_upgraded" });
    expect(await orgRow("maya-co")).toMatchObject({ plan: "team", plan_overrides: '{"seats":4}', plan_source: "billing", plan_status: "active", billing_subscription_id: newSub.id, billing_customer_id: sub.customer });
    expect(await count(`SELECT COUNT(*) AS n FROM org_grants`)).toBe(1);
    expect((await bcall("GET", `/api/billing/status?session_id=${again.id}`, cookie)).json).toEqual({ state: "done", org: { slug: "maya-co", name: "maya-co" } });
    // Delivered again, and a late event about the OLD subscription: the org stays on the new one.
    expect((await deliver(event("checkout.session.completed", stripe.sessionJson(again)))).json).toEqual({ ok: true, outcome: "unchanged" });
    expect((await deliver(event("customer.subscription.deleted", stripe.subscriptionJson(sub)))).json).toEqual({ ok: true, outcome: "grant_used" });
    expect(await orgRow("maya-co")).toMatchObject({ plan_status: "active", billing_subscription_id: newSub.id });
  });

  it("Upgrade to Pro from a Free org that never paid: a checkout for THIS org at members + pending invitations, and on payment a billing Pro org with the seats bought", async () => {
    const cookie = await cookieFor("maya", { member: false, email: "maya@example.com", verified: true });
    expect((await call("POST", "/api/orgs", cookie, { slug: "maya-free", name: "Maya Free" })).status).toBe(201);
    expect(await orgRow("maya-free")).toMatchObject({ plan: "free", plan_source: "granted", billing_customer_id: null });
    // A Free org's owner is offered the upgrade; nothing about a subscription yet.
    expect((await planOf("maya-free", cookie)).billing).toEqual({
      available: true, subscribed: false, ended: false, customer: false, interval: null, seats: null,
      cancel_at_period_end: false, pinned: false, upgrade_to: ["team"],
    });
    await addMember("maya-free", "omar");
    expect((await invite("maya-free", cookie, "p1@example.com")).status).toBe(201);
    // At Free's three seats the refusal tells the owner to upgrade.
    const full = await invite("maya-free", cookie, "p2@example.com");
    expect(full.json).toMatchObject({ error: "plan_limit", limit: "seats", plan: "free", next: "upgrade" });
    expect(full.json.paid).toBeUndefined();
    expect(planRefusalSentence(full.json, "owner")).toBe("This organization has reached the 3 seats its Free plan includes. Upgrade to Pro for more.");
    // Only Free orgs (and only their owners) upgrade; a portal needs a customer.
    expect((await bcall("POST", "/api/o/maya-free/billing/portal", cookie, {})).json).toMatchObject({ error: "not_billed" });
    expect((await bcall("POST", "/api/o/maya-free/billing/upgrade", cookie, { plan: "enterprise" })).json).toMatchObject({ error: "invalid_plan" });

    const r = await bcall<{ url: string }>("POST", "/api/o/maya-free/billing/upgrade", cookie, {});
    expect(r.status).toBe(200);
    const session = stripe.lastSession();
    expect(r.json.url).toBe(session.url);
    // No customer yet: the provider-verified address is suggested. Two members + one pending invitation = three seats.
    expect(session).toMatchObject({ customer: null, customer_email: "maya@example.com", price: PRICES.team, quantity: 3, cancel_url: "http://localhost/maya-free/#org/general" });
    expect(session.metadata).toMatchObject({ trov_plan: "team", trov_person: "maya", trov_org: "maya-free" });
    expect(await one(`SELECT plan, for_org FROM billing_checkouts WHERE session_id = ?`, session.id)).toMatchObject({ plan: "team", for_org: expect.stringMatching(/^org_/) });

    const sub = stripe.pay(session.id, 6);
    expect((await deliver(event("checkout.session.completed", stripe.sessionJson(session)))).json).toEqual({ ok: true, outcome: "org_upgraded" });
    expect(await orgRow("maya-free")).toMatchObject({
      plan: "team", plan_overrides: '{"seats":6}', plan_source: "billing", plan_status: "active",
      plan_period_end: iso(PERIOD_1), billing_customer_id: sub.customer, billing_subscription_id: sub.id,
    });
    expect(await count(`SELECT COUNT(*) AS n FROM org_grants`)).toBe(0); // the org exists: no grant
    expect((await planOf("maya-free", cookie)).billing).toMatchObject({ subscribed: true, seats: 6, customer: true, upgrade_to: [] });
    expect((await invite("maya-free", cookie, "p2@example.com")).status).toBe(201);
    expect((await bcall("POST", "/api/o/maya-free/billing/upgrade", cookie, {})).json).toMatchObject({ error: "not_free" });
    // The owner may now own another Free org: this one is on Pro.
    expect((await call<MyOrgsResponse>("GET", "/api/orgs", cookie)).json.free).toEqual({ can_create: true, owned: null });
  });
});

describe("the superadmin and a paid org", () => {
  const platformOrg = async (slug: string) => (await call<PlatformOrgDetail>("GET", `/api/platform/orgs/${slug}`, await boss())).json.org;

  it("Platform shows whether a plan is granted or paid, Stripe's status, and the customer in the right dashboard", async () => {
    const { sub } = await paidOrg("maya", "maya-co");
    const list = (await call<{ orgs: PlatformOrgRow[] }>("GET", "/api/platform/orgs", await boss())).json.orgs;
    const paid = list.find((o) => o.slug === "maya-co")!, granted = list.find((o) => o.slug === "saplinglearn")!;
    expect(granted.plan).toMatchObject({ source: "granted" });
    expect(granted.plan!.billing).toBeUndefined();
    expect(paid.plan).toMatchObject({ plan: "team", source: "billing", status: "active" });
    expect(paid.plan!.billing).toEqual({
      customer_id: sub.customer, subscription_id: sub.id, stripe_status: "active", plan: "team", ended: false, seats: 5, interval: "month", period_end: iso(PERIOD_1),
      cancel_at_period_end: false, pinned: false, livemode: false, dashboard_url: `https://dashboard.stripe.com/test/customers/${sub.customer}`,
    });
    await exec(`UPDATE billing_subscriptions SET livemode = 1`);
    expect((await platformOrg("maya-co")).plan!.billing!.dashboard_url).toBe(`https://dashboard.stripe.com/customers/${sub.customer}`);
    // A member of the org never sees an id of Stripe's.
    const view = JSON.stringify(await planOf("maya-co", await cookieFor("maya", { member: false })));
    expect(view).not.toContain(sub.customer);
    expect(view).not.toContain(sub.id);
  });

  it("Change plan on a live subscription: allowed, audited, the org stays a billing org — and the next subscription event does not undo it", async () => {
    const { cookie, sub, updated } = await paidOrg("maya", "maya-co", 4);
    const put = await call<{ org: PlatformOrgRow }>("PUT", "/api/platform/orgs/maya-co/plan", await boss(), { plan: "enterprise", overrides: { seats: 25 } });
    expect(put.status).toBe(200);
    expect(put.json.org.plan).toMatchObject({ plan: "enterprise", source: "billing", status: "active", overrides: { seats: 25 } });
    expect(put.json.org.plan!.billing).toMatchObject({ plan: "team", pinned: true });
    expect((await audit("maya-co")).at(-1)).toMatchObject({ actor: SUPERADMIN, action: "plan.change", detail: expect.stringContaining(`"from":"team","to":"enterprise"`) });

    // Renewals, a failed payment, its recovery and a change of seats all land — the plan stays Enterprise with its 25 seats.
    sub.quantity = 9;
    sub.current_period_end = PERIOD_2;
    expect((await updated()).json).toEqual({ ok: true, outcome: "org_period" });
    sub.status = "past_due";
    expect((await updated()).json).toEqual({ ok: true, outcome: "org_past_due" });
    sub.status = "active";
    await updated();
    expect(await orgRow("maya-co")).toMatchObject({ plan: "enterprise", plan_overrides: `{"seats":25}`, plan_source: "billing", plan_status: "active", plan_period_end: iso(PERIOD_2), billing_subscription_id: sub.id });
    // The owner still manages billing, is told the plan is Trov's doing, and is not offered a switch.
    expect((await planOf("maya-co", cookie)).billing).toMatchObject({ pinned: true, seats: 25 });
    expect((await bcall("POST", "/api/o/maya-co/billing/portal", cookie, {})).status).toBe(200);

    // Follow the subscription again: back to what is paid for — Pro, with the 9 seats it pays for now.
    const follow = await call<{ org: PlatformOrgRow }>("PUT", "/api/platform/orgs/maya-co/plan", await boss(), { follow_subscription: true });
    expect(follow.json.org.plan).toMatchObject({ plan: "team", source: "billing", overrides: { seats: 9 } });
    expect(follow.json.org.plan!.billing).toMatchObject({ pinned: false, seats: 9 });
    expect((await updated()).json).toEqual({ ok: true, outcome: "unchanged" });
    sub.quantity = 10;
    expect((await updated()).json).toEqual({ ok: true, outcome: "org_seats" });
    // Setting the plan the subscription already pays for (only its limits differ) pins nothing.
    const same = await call<{ org: PlatformOrgRow }>("PUT", "/api/platform/orgs/maya-co/plan", await boss(), { plan: "team", overrides: { seats: 10, repositories: 8 } });
    expect(same.json.org.plan!.billing).toMatchObject({ pinned: false });
    expect((await call("PUT", "/api/platform/orgs/saplinglearn/plan", await boss(), { follow_subscription: true })).status).toBe(409);
  });

  it("a pinned plan ends with its subscription too: the org moves to Free, and Change plan then takes it back as a granted one", async () => {
    const { sub, updated } = await paidOrg("maya", "maya-co");
    await call("PUT", "/api/platform/orgs/maya-co/plan", await boss(), { plan: "enterprise", overrides: {} });
    sub.status = "canceled";
    expect((await updated()).json).toEqual({ ok: true, outcome: "org_free" });
    expect(await orgRow("maya-co")).toMatchObject({ plan: "free", plan_status: "active", plan_source: "billing", plan_overrides: "{}" });
    // The subscription is over, so a Change plan now pins nothing: the org is Trov's again.
    const put = await call<{ org: PlatformOrgRow }>("PUT", "/api/platform/orgs/maya-co/plan", await boss(), { plan: "enterprise", overrides: {} });
    expect(put.json.org.plan).toMatchObject({ plan: "enterprise", source: "granted", status: "active" });
    expect(await one(`SELECT plan_pinned FROM billing_subscriptions`)).toEqual({ plan_pinned: 1 }); // the old pin is moot: nothing follows it
  });

  it("Change plan on an ENDED subscription takes the org back as a granted one, and billing no longer moves it", async () => {
    const { cookie, sub, updated } = await paidOrg("maya", "maya-co");
    sub.status = "canceled";
    await updated();
    const put = await call<{ org: PlatformOrgRow }>("PUT", "/api/platform/orgs/maya-co/plan", await boss(), { plan: "enterprise", overrides: {} });
    expect(put.json.org.plan).toMatchObject({ plan: "enterprise", source: "granted", status: "active" });
    expect(put.json.org.plan!.billing).toBeUndefined();
    expect((await deliver(event("customer.subscription.deleted", stripe.subscriptionJson(sub)))).json).toEqual({ ok: true, outcome: "org_not_billing" });
    expect(await orgRow("maya-co")).toMatchObject({ plan: "enterprise", plan_source: "granted", plan_status: "active" });
    // Nothing about payment is shown or offered any more.
    expect((await planOf("maya-co", cookie)).billing).toBeNull();
    expect((await bcall("POST", "/api/o/maya-co/billing/portal", cookie, {})).json).toMatchObject({ error: "not_billed" });
  });
});

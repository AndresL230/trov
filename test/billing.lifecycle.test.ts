/**
 * A subscription's life → the org's plan (docs/architecture/billing.md › What each state does), and the
 * owner's side of it: the Stripe portal, a plan switch, a renewal. Every transition goes through the seam
 * (src/plans/billing.ts) and converges on what Stripe says NOW. Stand-in Stripe; nothing reaches the network.
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

/** `handle` buys `plan`, the webhook lands, and they create `slug`. Returns the subscription to play with. */
async function paidOrg(handle: string, plan: "personal" | "team", slug: string) {
  const cookie = await cookieFor(handle, { member: false, email: `${handle}@example.com`, verified: true });
  expect((await bcall("GET", `/billing/start?plan=${plan}`, cookie)).status).toBe(303);
  const session = stripe.lastSession();
  const sub = stripe.pay(session.id);
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
    const { sub, updated } = await paidOrg("maya", "team", "maya-co");
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
    const { cookie, sub, updated } = await paidOrg("maya", "team", "maya-co");
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

  it("retries exhausted (unpaid) end the plan like a cancellation", async () => {
    const { cookie, sub, updated } = await paidOrg("maya", "team", "maya-co");
    sub.status = "unpaid";
    expect((await updated()).json).toEqual({ ok: true, outcome: "org_canceled" });
    expect((await invite("maya-co", cookie, "x@example.com")).status).toBe(402);
  });
});

describe("cancelling", () => {
  it("at the period's end: the plan stays active and says when it ends; when Stripe ends it, additions freeze and everything else works", async () => {
    const { cookie, sub, updated } = await paidOrg("maya", "team", "maya-co");
    const mate = await addMember("maya-co", "omar");
    sub.cancel_at_period_end = true;
    expect((await updated()).json).toEqual({ ok: true, outcome: "unchanged" });
    let plan = await planOf("maya-co", cookie);
    expect(plan).toMatchObject({ status: "active", period_end: iso(PERIOD_1) });
    expect(plan.billing).toMatchObject({ cancel_at_period_end: true, switch_to: ["personal"], renew_on: [] });
    expect((await invite("maya-co", cookie, "still@example.com")).status).toBe(201);

    sub.status = "canceled";
    expect((await deliver(event("customer.subscription.deleted", stripe.subscriptionJson(sub)))).json).toEqual({ ok: true, outcome: "org_canceled" });
    plan = await planOf("maya-co", cookie);
    expect(plan.status).toBe("canceled");
    expect(plan.billing).toMatchObject({ cancel_at_period_end: false, switch_to: [], renew_on: ["personal", "team"] });
    // Nothing was removed; reads and everything no limit governs carry on, for every member.
    expect(await count(`SELECT COUNT(*) AS n FROM memberships m JOIN orgs o ON o.id = m.org_id WHERE o.slug = 'maya-co'`)).toBe(2);
    expect((await call("GET", "/api/o/maya-co/members", mate)).status).toBe(200);
    expect((await call("POST", "/api/o/maya-co/tickets", mate, { title: "still working" })).status).toBe(200);
    // Additions a limit governs are refused — and the owner is pointed at renewing, the member at the owner.
    const refused = await invite("maya-co", cookie, "late@example.com");
    expect(refused.status).toBe(402);
    expect(refused.json).toMatchObject({ error: "plan_limit", limit: "seats", status: "canceled", paid: true });
    expect(planRefusalSentence(refused.json, "owner")).toBe("This organization's Team plan has ended, so nothing can be added until it is renewed. You can renew it in Org settings.");
    expect(planRefusalSentence(refused.json, "member")).toMatch(/Ask one of this organization's owners\.$/);
    // …and a member can still be removed.
    expect((await call("DELETE", "/api/o/maya-co/members/omar", cookie)).status).toBe(200);
  });

  it("at once: the deleted event alone ends the plan", async () => {
    const { sub } = await paidOrg("maya", "personal", "maya-co");
    sub.status = "canceled";
    await deliver(event("customer.subscription.deleted", stripe.subscriptionJson(sub)));
    expect(await orgRow("maya-co")).toMatchObject({ plan: "personal", plan_status: "canceled", plan_source: "billing" });
  });

  it("before the grant was used: the grant is revoked, and the buyer can no longer create the org", async () => {
    const cookie = await cookieFor("maya", { member: false });
    await bcall("GET", "/billing/start?plan=team", cookie);
    const session = stripe.lastSession();
    const sub = stripe.pay(session.id);
    await deliver(event("checkout.session.completed", stripe.sessionJson(session)));
    expect((await call<MyOrgsResponse>("GET", "/api/orgs", cookie)).json.can_create).toBe(true);
    sub.status = "canceled";
    expect((await deliver(event("customer.subscription.deleted", stripe.subscriptionJson(sub)))).json).toEqual({ ok: true, outcome: "grant_revoked" });
    expect(await one(`SELECT status, revoked_by FROM org_grants`)).toEqual({ status: "revoked", revoked_by: "billing" });
    expect((await call<MyOrgsResponse>("GET", "/api/orgs", cookie)).json.can_create).toBe(false);
    expect((await call("POST", "/api/orgs", cookie, { slug: "too-late", name: "Too late" })).status).toBe(403);
    expect((await bcall("GET", `/api/billing/status?session_id=${session.id}`, cookie)).json).toEqual({ state: "ended" });
    // Delivered again: still revoked, nothing thrown.
    expect((await deliver(event("customer.subscription.deleted", stripe.subscriptionJson(sub)))).json).toEqual({ ok: true, outcome: "grant_revoked" });
  });

  it("a paid grant that is simply never used stays usable, and follows a plan switch made in Stripe", async () => {
    const cookie = await cookieFor("maya", { member: false });
    await bcall("GET", "/billing/start?plan=personal", cookie);
    const session = stripe.lastSession();
    const sub = stripe.pay(session.id);
    await deliver(event("checkout.session.completed", stripe.sessionJson(session)));
    sub.current_period_end = PERIOD_2;
    sub.price = PRICES.team;
    expect((await deliver(event("customer.subscription.updated", stripe.subscriptionJson(sub)))).json).toEqual({ ok: true, outcome: "grant_plan" });
    expect((await call<MyOrgsResponse>("GET", "/api/orgs", cookie)).json.grants).toMatchObject([{ plan: "team", expires_at: null }]);
    expect((await call("POST", "/api/orgs", cookie, { slug: "later", name: "Later" })).status).toBe(201);
    expect(await orgRow("later")).toMatchObject({ plan: "team", plan_period_end: iso(PERIOD_2), billing_subscription_id: sub.id });
  });
});

describe("a plan switch made in Stripe", () => {
  it("up, Personal → Team: the plan and the seat cap change in place, through setOrgPlan", async () => {
    const { cookie, sub, updated } = await paidOrg("maya", "personal", "maya-co");
    expect((await invite("maya-co", cookie, "one@example.com")).status).toBe(402);
    sub.price = PRICES.team;
    expect((await updated()).json).toEqual({ ok: true, outcome: "org_plan" });
    expect(await orgRow("maya-co")).toMatchObject({ plan: "team", plan_source: "billing", plan_status: "active", billing_subscription_id: sub.id });
    expect((await planOf("maya-co", cookie)).entitlements.seats).toBe(10);
    expect((await invite("maya-co", cookie, "one@example.com")).status).toBe(201);
    expect((await audit("maya-co")).at(-1)).toMatchObject({ actor: "billing", action: "plan.change", detail: expect.stringContaining(`"from":"personal","to":"team"`) });
    // No second grant: it is the same organization.
    expect(await count(`SELECT COUNT(*) AS n FROM org_grants`)).toBe(1);
  });

  it("down, Team → Personal with three members: nothing is deleted, the org is over its seats, and additions wait", async () => {
    const { cookie, sub, updated } = await paidOrg("maya", "team", "maya-co");
    await addMember("maya-co", "omar");
    const third = await addMember("maya-co", "priya", "admin");
    sub.price = PRICES.personal;
    expect((await updated()).json).toEqual({ ok: true, outcome: "org_plan" });
    const plan = await planOf("maya-co", cookie);
    expect(plan).toMatchObject({ plan: "personal", status: "active", over: ["seats"] });
    expect(plan.usage.seats).toBe(3);
    expect(await count(`SELECT COUNT(*) AS n FROM memberships m JOIN orgs o ON o.id = m.org_id WHERE o.slug = 'maya-co'`)).toBe(3);
    expect((await call("GET", "/api/o/maya-co/members", third)).status).toBe(200);
    const refused = await invite("maya-co", cookie, "fourth@example.com");
    expect([refused.status, refused.json.limit, refused.json.paid]).toEqual([402, "seats", true]);
    expect(planRefusalSentence(refused.json, "owner")).toMatch(/You can upgrade or manage billing in Org settings\.$/);
  });

  it("to a price Trov does not sell: the plan it was on is kept; status and period still follow", async () => {
    const { sub, updated } = await paidOrg("maya", "team", "maya-co");
    sub.price = "price_made_by_hand";
    sub.current_period_end = PERIOD_2;
    expect((await updated()).json).toEqual({ ok: true, outcome: "org_period" });
    expect(await orgRow("maya-co")).toMatchObject({ plan: "team", plan_period_end: iso(PERIOD_2) });
  });
});

describe("the owner's billing routes", () => {
  it("Manage billing: a Customer Portal session for THIS org's customer, returning to its Plan block", async () => {
    const { cookie, sub } = await paidOrg("maya", "team", "maya-co");
    const r = await bcall<{ url: string }>("POST", "/api/o/maya-co/billing/portal", cookie, {});
    expect([r.status, r.json]).toEqual([200, { url: expect.stringMatching(/^https:\/\/billing\.stripe\.com\/p\/session\//) }]);
    expect(stripe.portals).toEqual([{ customer: sub.customer, return_url: "http://localhost/maya-co/#org/general", flow: expect.anything() }]);
    const [c] = stripe.callsTo("POST", "/v1/billing_portal/sessions");
    expect(Object.fromEntries(c.params)).toEqual({ customer: sub.customer, return_url: "http://localhost/maya-co/#org/general" });
    expect(c.headers.get("idempotency-key")).toMatch(/^trov-portal-/);
  });

  it("only an OWNER of that org: an admin and a member are 403, a stranger and another org's owner 404, a token 403 — and Stripe is never asked", async () => {
    await paidOrg("maya", "team", "maya-co");
    const other = await paidOrg("omar", "team", "omar-co");
    const admin = await addMember("maya-co", "priya", "admin");
    const member = await addMember("maya-co", "quinn");
    const stranger = await cookieFor("zed", { member: false });
    const before = stripe.calls.length;
    for (const path of ["/billing/portal", "/billing/change", "/billing/renew"]) {
      for (const who of [admin, member]) {
        const r = await bcall("POST", `/api/o/maya-co${path}`, who, { plan: "personal" });
        expect([r.status, (r.json as { error: string }).error], path).toEqual([403, "forbidden"]);
      }
      for (const who of [stranger, other.cookie, await boss()]) expect((await bcall("POST", `/api/o/maya-co${path}`, who, { plan: "personal" })).status, path).toBe(404);
      expect((await bcall("POST", `/api/o/maya-co${path}`, "", { plan: "personal" })).status).toBe(401);
      const withToken = await bcall("POST", `/api/o/maya-co${path}`, (await paidOrgOwner("maya")), { plan: "personal" }, { headers: { authorization: "Bearer trov_mcp_x" } });
      expect(withToken.status).toBe(403);
    }
    expect(stripe.calls).toHaveLength(before);
  });
  const paidOrgOwner = (handle: string) => cookieFor(handle, { member: false });

  it("a GRANTED org has no billing: its owner is told so, and its plan view carries none", async () => {
    const owner = await boss(); // SaplingLearn's owner: an Enterprise org nobody pays for
    for (const path of ["/billing/portal", "/billing/change", "/billing/renew"]) {
      const r = await bcall("POST", `/api/o/saplinglearn${path}`, owner, { plan: "team" });
      expect([r.status, (r.json as { error: string }).error], path).toEqual([409, "not_billed"]);
    }
    expect((await planOf("saplinglearn", owner)).billing).toBeNull();
    expect(stripe.calls).toEqual([]);
  });

  it("Upgrade to Team: the portal's confirm flow for THIS subscription and the Team price on the same interval — not a new checkout, not a new grant", async () => {
    const { cookie, sub } = await paidOrg("maya", "personal", "maya-co");
    expect((await planOf("maya-co", cookie)).billing).toEqual({ available: true, interval: "month", cancel_at_period_end: false, pinned: false, switch_to: ["team"], renew_on: [] });
    const r = await bcall<{ url: string }>("POST", "/api/o/maya-co/billing/change", cookie, { plan: "team" });
    expect(r.status).toBe(200);
    const c = stripe.callsTo("POST", "/v1/billing_portal/sessions").at(-1)!;
    expect(Object.fromEntries(c.params)).toEqual({
      customer: sub.customer, return_url: "http://localhost/maya-co/#org/general",
      "flow_data[type]": "subscription_update_confirm",
      "flow_data[subscription_update_confirm][subscription]": sub.id,
      "flow_data[subscription_update_confirm][items][0][id]": sub.item,
      "flow_data[subscription_update_confirm][items][0][price]": PRICES.team,
      "flow_data[subscription_update_confirm][items][0][quantity]": "1",
      "flow_data[after_completion][type]": "redirect",
      "flow_data[after_completion][redirect][return_url]": "http://localhost/maya-co/#org/general",
    });
    expect(stripe.callsTo("POST", "/v1/checkout/sessions")).toHaveLength(1); // the original purchase only
    // Nothing changed here yet: the plan moves when Stripe says the subscription did.
    expect((await orgRow("maya-co"))!.plan).toBe("personal");
    const refusals: [unknown, number, string][] = [[{ plan: "personal" }, 409, "same_plan"], [{ plan: "enterprise" }, 400, "invalid_plan"], [{}, 400, "invalid_plan"]];
    for (const [body, status, code] of refusals) {
      const x = await bcall("POST", "/api/o/maya-co/billing/change", cookie, body);
      expect([x.status, (x.json as { error: string }).error]).toEqual([status, code]);
    }
  });

  it("a Stripe failure is a 502 with a sentence and no detail of the upstream", async () => {
    const { cookie } = await paidOrg("maya", "personal", "maya-co");
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    stripe.fail = () => Response.json({ error: { type: "invalid_request_error", message: "No configuration provided and your test mode default configuration has not been created." } }, { status: 400 });
    for (const [path, body] of [["/billing/portal", {}], ["/billing/change", { plan: "team" }]] as const) {
      const r = await bcall<{ error: string; message: string }>("POST", `/api/o/maya-co${path}`, cookie, body);
      expect([r.status, r.json.error]).toEqual([502, "billing_failed"]);
      expect(r.json.message).not.toMatch(/configuration/);
    }
    spy.mockRestore();
  });

  it("Renew: a canceled org pays again — a new subscription for the SAME org and customer, no grant; refused while the plan is live", async () => {
    const { cookie, sub, session } = await paidOrg("maya", "team", "maya-co");
    expect((await bcall("POST", "/api/o/maya-co/billing/renew", cookie, {})).json).toMatchObject({ error: "not_ended" });
    sub.status = "canceled";
    await deliver(event("customer.subscription.deleted", stripe.subscriptionJson(sub)));
    expect((await bcall("POST", "/api/o/maya-co/billing/change", cookie, { plan: "personal" })).json).toMatchObject({ error: "plan_ended" });

    const r = await bcall<{ url: string }>("POST", "/api/o/maya-co/billing/renew", cookie, { plan: "personal" });
    expect(r.status).toBe(200);
    const again = stripe.lastSession();
    expect(again.id).not.toBe(session.id);
    expect(r.json.url).toBe(again.url);
    expect(again).toMatchObject({ customer: sub.customer, customer_email: null, price: PRICES.personal, cancel_url: "http://localhost/maya-co/#org/general" });
    expect(again.metadata).toMatchObject({ trov_plan: "personal", trov_person: "maya", trov_org: "maya-co" });
    const newSub = stripe.pay(again.id);
    expect(newSub.customer).toBe(sub.customer);
    expect((await deliver(event("checkout.session.completed", stripe.sessionJson(again)))).json).toEqual({ ok: true, outcome: "org_renewed" });
    expect(await orgRow("maya-co")).toMatchObject({ plan: "personal", plan_source: "billing", plan_status: "active", billing_subscription_id: newSub.id, billing_customer_id: sub.customer });
    expect(await count(`SELECT COUNT(*) AS n FROM org_grants`)).toBe(1);
    expect((await bcall("GET", `/api/billing/status?session_id=${again.id}`, cookie)).json).toEqual({ state: "done", org: { slug: "maya-co", name: "maya-co" } });
    // Delivered again, and a late event about the OLD subscription: the org stays on the new one.
    expect((await deliver(event("checkout.session.completed", stripe.sessionJson(again)))).json).toEqual({ ok: true, outcome: "unchanged" });
    expect((await deliver(event("customer.subscription.deleted", stripe.subscriptionJson(sub)))).json).toEqual({ ok: true, outcome: "grant_used" });
    expect(await orgRow("maya-co")).toMatchObject({ plan_status: "active", billing_subscription_id: newSub.id });
  });
});

describe("the superadmin and a paid org", () => {
  const platformOrg = async (slug: string) => (await call<PlatformOrgDetail>("GET", `/api/platform/orgs/${slug}`, await boss())).json.org;

  it("Platform shows whether a plan is granted or paid, Stripe's status, and the customer in the right dashboard", async () => {
    const { sub } = await paidOrg("maya", "team", "maya-co");
    const list = (await call<{ orgs: PlatformOrgRow[] }>("GET", "/api/platform/orgs", await boss())).json.orgs;
    const paid = list.find((o) => o.slug === "maya-co")!, granted = list.find((o) => o.slug === "saplinglearn")!;
    expect(granted.plan).toMatchObject({ source: "granted" });
    expect(granted.plan!.billing).toBeUndefined();
    expect(paid.plan).toMatchObject({ plan: "team", source: "billing", status: "active" });
    expect(paid.plan!.billing).toEqual({
      customer_id: sub.customer, subscription_id: sub.id, stripe_status: "active", plan: "team", interval: "month", period_end: iso(PERIOD_1),
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
    const { cookie, sub, updated } = await paidOrg("maya", "personal", "maya-co");
    const put = await call<{ org: PlatformOrgRow }>("PUT", "/api/platform/orgs/maya-co/plan", await boss(), { plan: "team", overrides: { seats: 25 } });
    expect(put.status).toBe(200);
    expect(put.json.org.plan).toMatchObject({ plan: "team", source: "billing", status: "active", overrides: { seats: 25 } });
    expect(put.json.org.plan!.billing).toMatchObject({ plan: "personal", pinned: true });
    expect((await audit("maya-co")).at(-1)).toMatchObject({ actor: SUPERADMIN, action: "plan.change", detail: expect.stringContaining(`"from":"personal","to":"team"`) });

    // Renewals, a failed payment and its recovery all land — the plan stays Team with its 25 seats.
    sub.current_period_end = PERIOD_2;
    expect((await updated()).json).toEqual({ ok: true, outcome: "org_period" });
    sub.status = "past_due";
    expect((await updated()).json).toEqual({ ok: true, outcome: "org_past_due" });
    sub.status = "active";
    await updated();
    expect(await orgRow("maya-co")).toMatchObject({ plan: "team", plan_overrides: `{"seats":25}`, plan_source: "billing", plan_status: "active", plan_period_end: iso(PERIOD_2), billing_subscription_id: sub.id });
    // The owner still manages billing, is told the plan is Trov's doing, and is not offered a switch.
    expect((await planOf("maya-co", cookie)).billing).toMatchObject({ pinned: true, switch_to: [] });
    expect((await bcall("POST", "/api/o/maya-co/billing/portal", cookie, {})).status).toBe(200);

    // Follow the subscription again: back to what is paid for.
    const follow = await call<{ org: PlatformOrgRow }>("PUT", "/api/platform/orgs/maya-co/plan", await boss(), { follow_subscription: true });
    expect(follow.json.org.plan).toMatchObject({ plan: "personal", source: "billing", overrides: {} });
    expect(follow.json.org.plan!.billing).toMatchObject({ pinned: false });
    sub.price = PRICES.team;
    expect((await updated()).json).toEqual({ ok: true, outcome: "org_plan" });
    expect((await orgRow("maya-co"))!.plan).toBe("team");
    // Setting the plan the subscription already pays for (only its limits differ) pins nothing.
    const same = await call<{ org: PlatformOrgRow }>("PUT", "/api/platform/orgs/maya-co/plan", await boss(), { plan: "team", overrides: { repositories: 8 } });
    expect(same.json.org.plan!.billing).toMatchObject({ pinned: false });
    expect((await call("PUT", "/api/platform/orgs/saplinglearn/plan", await boss(), { follow_subscription: true })).status).toBe(409);
  });

  it("the pinned plan keeps its status following Stripe: when the subscription ends, the org freezes", async () => {
    const { sub, updated } = await paidOrg("maya", "personal", "maya-co");
    await call("PUT", "/api/platform/orgs/maya-co/plan", await boss(), { plan: "team", overrides: {} });
    sub.status = "canceled";
    expect((await updated()).json).toEqual({ ok: true, outcome: "org_canceled" });
    expect(await orgRow("maya-co")).toMatchObject({ plan: "team", plan_status: "canceled", plan_source: "billing" });
  });

  it("Change plan on an ENDED subscription takes the org back as a granted one, and billing no longer moves it", async () => {
    const { cookie, sub, updated } = await paidOrg("maya", "team", "maya-co");
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

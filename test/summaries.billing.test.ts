/**
 * AI summaries and billing's plan states (docs/architecture/plans.md › AI summaries; billing.md › What each
 * state does to an org). The summarizer choice (`orgSummarizers`) reads the SAME columns billing writes —
 * `orgs.plan`, `plan_overrides`, `plan_status`, through `planOf` — so each transition a subscription makes
 * is driven here by a real Stripe event (the stand-in), never by an UPDATE:
 *   active → summarizes; past due → still summarizes (past due limits nothing); ended → the org is on Free
 *   and summarizes on Free's allowance; upgraded again → Pro's; a superadmin's pinned plan moves the
 *   allowance; a legacy frozen (`canceled`) org does not summarize.
 * Gemini is a stub — never the network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env } from "../src/env";
import type { OrgPlanView } from "@shared/plans";
import { PLANS } from "@shared/plans";
import type { PlatformOrgRow } from "@shared/orgs";
import { systemTenant, platform } from "../src/data/context";
import { cancelOrgPlan, orgPlan } from "../src/plans/billing";
import { orgSummarizers, summaryAllowance } from "../src/plans/summaries";
import { cookieFor } from "./helpers/persons";
import { call, one, SUPERADMIN } from "./helpers/orgs";
import { FakeStripe, PERIOD_2, bcall, billingEnv, deliver, event } from "./helpers/billing";

const KEY = "AIzaFAKE_gemini_key_for_tests_0123456789";
const keyed = (): Env => ({ ...billingEnv(), GEMINI_API_KEY: KEY });

let stripe: FakeStripe;
beforeEach(() => { stripe = new FakeStripe(); vi.stubGlobal("fetch", stripe.fetch); });
afterEach(() => { vi.unstubAllGlobals(); });

/** A Gemini `generateContent` stand-in that counts its calls. */
function gemini(): { fetchImpl: typeof fetch; calls: number } {
  const g = {
    calls: 0,
    fetchImpl: (async (url: string | URL | Request) => {
      g.calls++;
      expect(String(url)).toContain("generativelanguage.googleapis.com");
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ title: "t", what: "w", why: null, impact: null }) }] } }] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch,
  };
  return g;
}

/** `handle` buys `plan`, the webhook lands, and they create `slug` — billing.lifecycle.test.ts's own setup. */
async function paidOrg(handle: string, slug: string) {
  const cookie = await cookieFor(handle, { member: false, email: `${handle}@example.com`, verified: true });
  expect((await bcall("GET", `/billing/start?plan=team`, cookie)).status).toBe(303);
  const session = stripe.lastSession();
  const sub = stripe.pay(session.id);
  await deliver(event("checkout.session.completed", stripe.sessionJson(session)));
  expect((await call("POST", "/api/orgs", cookie, { slug, name: slug })).status).toBe(201);
  const orgId = (await one<{ id: string }>(`SELECT id FROM orgs WHERE slug = ?`, slug))!.id;
  const updated = () => deliver(event("customer.subscription.updated", stripe.subscriptionJson(sub)));
  return { cookie, sub, session, updated, orgId };
}
const ctxOf = (orgId: string) => systemTenant(platform(keyed(), "system"), orgId, "system");
const allowance = (orgId: string) => summaryAllowance(keyed(), ctxOf(orgId));
/** Ask THE choice for a pull request's summarizer and, when it hands one out, make the one call. */
async function summarize(orgId: string): Promise<{ offered: boolean; calls: number; status: string }> {
  const g = gemini();
  const sums = await orgSummarizers(keyed(), ctxOf(orgId), { actor: "github-webhook", gemini: { fetchImpl: g.fetchImpl } });
  const s = sums.pr();
  if (s) await s.summarize({ title: "Add export", body: "The body." });
  return { offered: s !== null, calls: g.calls, status: sums.allowance().status };
}
const attempts = async (orgId: string) => (await one<{ n: number }>(`SELECT COALESCE(SUM(count), 0) AS n FROM org_usage_daily WHERE org_id = ? AND metric = 'summary:pr'`, orgId))!.n;
const planView = async (slug: string, cookie: string) => (await bcall<OrgPlanView>("GET", `/api/o/${slug}/plan`, cookie, undefined, { env: keyed() })).json;

describe("the summarizer choice reads the plan state billing writes", () => {
  it("it is the same state: what `orgPlan` (billing's read) says is what the allowance is computed from", async () => {
    const { orgId, sub, updated } = await paidOrg("maya", "maya-co");
    for (const status of ["active", "past_due", "active", "canceled"] as const) {
      sub.status = status;
      await updated();
      const state = await orgPlan(platform(keyed(), "billing"), orgId);
      // An ended subscription moves the org to Free: active, on Free's allowance.
      expect([state.plan, state.status]).toEqual(status === "canceled" ? ["free", "active"] : ["team", status]);
      expect((await allowance(orgId)).status).toBe("on");
      expect((await allowance(orgId)).cap).toBe(PLANS[state.plan].entitlements.ai_summaries);
    }
    // A legacy org frozen as `canceled` (the seam still has the call): its allowance is ended.
    await cancelOrgPlan(platform(keyed(), "billing"), "maya-co");
    expect((await allowance(orgId)).status).toBe("ended");
  });

  it("active: a paid Pro org summarizes against Pro's allowance, and the Plan block shows the use beside billing", async () => {
    const { orgId, cookie } = await paidOrg("maya", "maya-co");
    expect(await allowance(orgId)).toEqual({ status: "on", used: 0, cap: 3000, remaining: 3000 });
    expect(await summarize(orgId)).toEqual({ offered: true, calls: 1, status: "on" });
    expect(await attempts(orgId)).toBe(1);
    const view = await planView("maya-co", cookie);
    expect(view).toMatchObject({ plan: "team", status: "active", source: "billing", usage: { ai_summaries: 1 }, over: [] });
    expect(view.entitlements.ai_summaries).toBe(3000);
    expect(view.billing).toMatchObject({ available: true, cancel_at_period_end: false });
  });

  it("PAST DUE still summarizes — a failed payment limits nothing — and paid again changes nothing either", async () => {
    const { orgId, cookie, sub } = await paidOrg("maya", "maya-co");
    sub.status = "past_due";
    expect((await deliver(event("invoice.payment_failed", { id: "in_2", subscription: sub.id }))).json).toEqual({ ok: true, outcome: "org_past_due" });
    expect((await one<{ plan_status: string }>(`SELECT plan_status FROM orgs WHERE id = ?`, orgId))!.plan_status).toBe("past_due");
    expect(await allowance(orgId)).toEqual({ status: "on", used: 0, cap: 3000, remaining: 3000 });
    expect(await summarize(orgId)).toEqual({ offered: true, calls: 1, status: "on" });
    expect(await attempts(orgId)).toBe(1);
    expect(await planView("maya-co", cookie)).toMatchObject({ status: "past_due", usage: { ai_summaries: 1 }, over: [] });
    // The allowance itself still applies while past due: it is the plan's, not the payment's.
    await call("PUT", "/api/platform/orgs/maya-co/plan", await cookieFor(SUPERADMIN), { plan: "team", overrides: { seats: 1, ai_summaries: 1 } });
    expect((await one<{ plan_status: string }>(`SELECT plan_status FROM orgs WHERE id = ?`, orgId))!.plan_status).toBe("past_due");
    expect(await summarize(orgId)).toEqual({ offered: false, calls: 0, status: "capped" });

    sub.status = "active";
    sub.current_period_end = PERIOD_2;
    expect((await deliver(event("invoice.paid", { id: "in_3", subscription: sub.id }))).json).toEqual({ ok: true, outcome: "org_active" });
    expect((await allowance(orgId)).status).toBe("capped"); // the override stands; the payment changed nothing about it
  });

  it("ENDED moves the org to Free, which summarizes on Free's allowance — the cancellation, and retries running out", async () => {
    for (const [handle, slug, end] of [["maya", "maya-co", "canceled"], ["noor", "noor-co", "unpaid"]] as const) {
      const { orgId, cookie, sub, updated } = await paidOrg(handle, slug);
      expect((await summarize(orgId)).offered).toBe(true);
      sub.status = end;
      expect((await (end === "canceled" ? deliver(event("customer.subscription.deleted", stripe.subscriptionJson(sub))) : updated())).json).toEqual({ ok: true, outcome: "org_free" });
      // The month's use carries over: one of Free's 300.
      expect(await allowance(orgId)).toEqual({ status: "on", used: 1, cap: 300, remaining: 299 });
      expect(await summarize(orgId)).toEqual({ offered: true, calls: 1, status: "on" });
      expect(await attempts(orgId)).toBe(2);
      // Nothing errors, and the org reads its plan: Free, with the month's use on it.
      expect(await planView(slug, cookie)).toMatchObject({ plan: "free", status: "active", usage: { ai_summaries: 2 }, over: [] });
    }
  });

  it("cancelled at the period's end keeps Pro's allowance until Stripe ends it, then Free's", async () => {
    const { orgId, sub, updated } = await paidOrg("maya", "maya-co");
    sub.cancel_at_period_end = true;
    await updated();
    expect(await summarize(orgId)).toEqual({ offered: true, calls: 1, status: "on" });
    expect((await allowance(orgId)).cap).toBe(3000);
    sub.status = "canceled";
    await deliver(event("customer.subscription.deleted", stripe.subscriptionJson(sub)));
    expect((await allowance(orgId)).cap).toBe(300);
  });

  it("UPGRADED: an org whose subscription ended (on Free) pays again and summarizes on Pro's allowance", async () => {
    const { orgId, cookie, sub } = await paidOrg("maya", "maya-co");
    sub.status = "canceled";
    await deliver(event("customer.subscription.deleted", stripe.subscriptionJson(sub)));
    expect((await allowance(orgId)).cap).toBe(300);
    expect((await bcall("POST", "/api/o/maya-co/billing/upgrade", cookie, {})).status).toBe(200);
    const again = stripe.lastSession();
    stripe.pay(again.id);
    expect((await deliver(event("checkout.session.completed", stripe.sessionJson(again)))).json).toEqual({ ok: true, outcome: "org_upgraded" });
    expect(await allowance(orgId)).toEqual({ status: "on", used: 0, cap: 3000, remaining: 3000 });
    expect(await summarize(orgId)).toEqual({ offered: true, calls: 1, status: "on" });
  });

  it("a superadmin's PINNED plan is the one that counts; when the subscription ends, Free's does", async () => {
    const { orgId, sub, updated } = await paidOrg("maya", "maya-co");
    expect((await allowance(orgId)).cap).toBe(3000);
    // Pinned to Enterprise by the superadmin: the subscription still pays for Pro, and its events move
    // status and period only — the allowance is the pinned plan's (unlimited), not the paid one's.
    const put = await call<{ org: PlatformOrgRow }>("PUT", "/api/platform/orgs/maya-co/plan", await cookieFor(SUPERADMIN), { plan: "enterprise" });
    expect(put.json.org.plan!.billing).toMatchObject({ plan: "team", pinned: true });
    sub.current_period_end = PERIOD_2;
    await updated();
    expect(await allowance(orgId)).toEqual({ status: "on", used: 0, cap: null, remaining: null });
    // …and the pinned plan's status still follows Stripe: past due summarizes; ended moves the org to Free.
    sub.status = "past_due";
    await updated();
    expect((await summarize(orgId)).offered).toBe(true);
    sub.status = "canceled";
    await updated();
    expect(await allowance(orgId)).toMatchObject({ status: "on", cap: 300 });
    // Follow the subscription is refused nothing here; a plan set on the ENDED subscription takes the org back as granted — and it summarizes.
    await call("PUT", "/api/platform/orgs/maya-co/plan", await cookieFor(SUPERADMIN), { plan: "team" });
    expect(await allowance(orgId)).toMatchObject({ status: "on", cap: 3000 });
  });

  it("with no platform key nothing is summarized or counted, whatever the plan's state", async () => {
    const { orgId } = await paidOrg("maya", "maya-co");
    const g = gemini();
    const sums = await orgSummarizers(billingEnv(), systemTenant(platform(billingEnv(), "system"), orgId, "system"), { actor: "github-webhook", gemini: { fetchImpl: g.fetchImpl } });
    expect(sums.pr()).toBeNull();
    expect(sums.allowance().status).toBe("off");
    expect(g.calls).toBe(0);
    expect(await attempts(orgId)).toBe(0);
  });
});

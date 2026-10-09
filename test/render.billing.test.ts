/**
 * Billing's screens, as markup (docs/architecture/billing.md): Org settings › General's Plan block in
 * every billing state (Free, Pro per seat, cancelling, ended → Free), with the owner's actions; the waiting room a
 * buyer lands in after Stripe Checkout, and its poll; the pointer a plan refusal ends with; a paid grant
 * on the picker; and Platform's view of a paid organization.
 */
import { describe, it, expect } from "vitest";
import { planBlock, inviteGate, initialOrgBillingUi, type OrgBillingUi } from "../web/src/org-plan";
import { generalTab, initialOrgUi, type OrgUi } from "../web/src/org-settings";
import { billingErrorText, createOrgBillingActions } from "../web/src/org-billing-actions";
import { billingDonePage, initialBillingDone, applyBillingStatus, startBillingDone, setupHref, BILLING_POLL, type BillingDoneUi } from "../web/src/billing";
import { orgPickerView, initialOrgsUi } from "../web/src/org-picker";
import { orgPlanSection, planModal, planModalBillingNote, planSourceWord, limitDraftOf } from "../web/src/platform-access";
import { ApiError, OrgApiError, planLimitText } from "../web/src/api";
import { initialState, render, type AppState } from "../web/src/render";
import { PLANS, planRefusal, planRefusalSentence, type MyGrant, type OrgPlanView, type PlatformOrgPlan, type PlanId } from "@shared/plans";
import { billingDate, billingStartHref, stripeCustomerUrl, type BillingStatusResponse, type OrgBillingView, type PlatformOrgBilling } from "@shared/billing";
import type { MyOrg, MyOrgsResponse } from "@shared/orgs";

const sources = import.meta.glob(["../web/src/billing.ts", "../web/src/org-plan.ts", "../web/src/org-billing-actions.ts"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const PERIOD = "2027-01-15T08:00:00.000Z";
/** A LIVE Pro subscription for 5 seats (the defaults); a Free org's view is `freeBill`. */
const bill = (o: Partial<OrgBillingView> = {}): OrgBillingView => ({
  available: true, subscribed: true, ended: false, customer: true, interval: "month", seats: 5,
  cancel_at_period_end: false, pinned: false, upgrade_to: [], ...o,
});
const freeBill = (o: Partial<OrgBillingView> = {}): OrgBillingView => bill({ subscribed: false, customer: false, interval: null, seats: null, upgrade_to: ["team"], ...o });
const view = (plan: PlanId = "team", o: Partial<OrgPlanView> = {}): OrgPlanView => ({
  plan, name: PLANS[plan].name, description: PLANS[plan].description, status: "active", source: "billing", period_end: PERIOD, gift_until: null,
  entitlements: plan === "team" ? { ...PLANS.team.entitlements, seats: 5 } : PLANS[plan].entitlements, overridden: plan === "team" ? ["seats"] : [], seats: { members: 3, pending: 0 },
  usage: { seats: 3, repositories: 1, environments: 2, artifact_bytes: 1024 ** 2, agent_connections: 1, ai_summaries: 1212 }, over: [], billing: plan === "free" ? freeBill() : bill(), ...o,
});
const block = (v: OrgPlanView, role: MyOrg["role"] = "owner", b: OrgBillingUi = initialOrgBillingUi()) => planBlock({ status: "ok", data: v }, role, b);
const buttons = (html: string): string[] => [...html.matchAll(/<button[^>]*data-act="(orgBilling\w+)"(?: data-arg="(\w+)")?[^>]*>([^<]+)<\/button>/g)].map((m) => `${m[3]}|${m[1]}${m[2] ? `:${m[2]}` : ""}`);

describe("Org settings › General — the Plan block of an org that pays, or can", () => {
  it("active Pro: its seats, when it renews, how it is billed, and the owner's Change seats and Manage billing", () => {
    const html = block(view("team"));
    expect(html).toContain('data-org-billing="active"');
    expect(html).toContain(`5 seats, paid per seat. Renews on ${billingDate(PERIOD)}. Billed monthly through Stripe.`);
    expect(billingDate(PERIOD)).toBe("15 January 2027");
    expect(buttons(html)).toEqual(["Change seats|orgBillingSeats", "Manage billing|orgBillingPortal"]);
    expect(html).toContain("Card, invoices, seats and cancelling are on Stripe&#39;s pages. Trov never sees your card.");
    expect(html).not.toContain("contact Trov");
    // No accent button: the tab's one primary action is not billing's.
    expect(html).not.toContain("cnpy-accentbtn");
    expect(block(view("team", { billing: bill({ interval: "year" }) }))).toContain("Billed yearly through Stripe.");
    expect(block(view("team", { billing: bill({ seats: 1 }) }))).toContain("1 seat, paid per seat.");
  });

  it("the AI-summaries allowance is one more limit row beside billing's controls — with thousands separators, and never 'over'", () => {
    const words = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/&middot;/g, "·").replace(/\s+/g, " ");
    const html = block(view("team"));
    expect(html).toMatch(/data-limit="ai_summaries"/);
    const row = (h: string): string => words(h.slice(h.indexOf('data-limit="ai_summaries"')).split("</li>")[0]);
    expect(row(html)).toMatch(/AI summaries .* 1,212 of 3,000 this month\s*$/);
    expect(html).not.toContain("3000");
    expect(html.match(/data-limit="/g)).toHaveLength(6);
    // Billing's line and buttons are exactly what they were without it.
    expect(html).toContain('data-org-billing="active"');
    expect(buttons(html)).toEqual(["Change seats|orgBillingSeats", "Manage billing|orgBillingPortal"]);
    // Past due limits nothing, summaries included.
    const due = block(view("team", { status: "past_due" }));
    expect(row(due)).toMatch(/1,212 of 3,000 this month\s*$/);
    expect(due).toContain('data-org-billing="past_due"');
    // Used up on Free: the row says what happens, and the org is not "over" anything.
    const used = block(view("free", { usage: { seats: 1, repositories: 1, environments: 1, artifact_bytes: 0, agent_connections: 0, ai_summaries: 300 } }));
    expect(row(used)).toMatch(/300 of 300 this month\s*$/);
    expect(used).not.toContain("Over the limit");
    expect(used).toContain("New pull requests and issues show an excerpt until next month.");
  });

  it("Free, never paid: what Pro is, and the owner's one button — Upgrade to Pro — with no Manage billing (there is no customer)", () => {
    const html = block(view("free", { source: "granted", period_end: null }));
    expect(html).toContain('data-org-billing="free"');
    expect(html).toContain("Pro is paid per seat: one for each member or pending invitation. It raises every limit below.");
    expect(buttons(html)).toEqual(["Upgrade to Pro|orgBillingUpgrade:team"]);
    expect(html).toMatch(/data-field="orgBillingUpgrade:team"/);
    expect(html).toContain("Pro is paid through Stripe; you choose the number of seats there. Trov never sees your card.");
    for (const role of ["admin", "member"] as const) {
      const other = block(view("free", { source: "granted", period_end: null }), role);
      expect(buttons(other)).toEqual([]);
      expect(other).toContain("An owner of this organization can upgrade it to Pro.");
    }
    // Billing off on the deployment: the button is there, disabled, and says why.
    const off = block(view("free", { billing: freeBill({ available: false }) }));
    expect(off).toMatch(/<button[^>]*data-act="orgBillingUpgrade"[^>]*disabled[^>]*>Upgrade to Pro<\/button>/);
    expect(off).toContain("Billing is not available right now, so these are off. Your plan is unchanged.");
    // Nothing purchasable (no price set): no button.
    expect(buttons(block(view("free", { billing: freeBill({ upgrade_to: [] }) })))).toEqual([]);
  });

  it("past due: says the payment failed, that nothing changes while Stripe retries, and the date", () => {
    const html = block(view("team", { status: "past_due" }));
    expect(html).toContain('data-org-billing="past_due"');
    expect(html).toContain(">Payment past due<");
    expect(html).toContain("The last payment did not go through. Stripe is trying the card again, and nothing changes while it does; if it keeps failing, the organization moves to Free. The current period runs to 15 January 2027. Update the card in Manage billing.");
    expect(buttons(html)).toContain("Manage billing|orgBillingPortal");
    // Nothing is refused while past due, so nothing is said about limits.
    expect(html).not.toContain("cnpy-plan-note");
  });

  it("cancelled, ends on a date: still works until then, then Free — and how to keep it; no seats to change", () => {
    const html = block(view("team", { billing: bill({ cancel_at_period_end: true }) }));
    expect(html).toContain('data-org-billing="cancelling"');
    expect(html).toContain(">Cancelled<");
    expect(html).toContain("Cancelled: the plan ends on 15 January 2027, and then this organization moves to Free. Until then everything works as before. To keep it, resume the subscription in Manage billing.");
    expect(html).not.toContain(">Ended<");
    expect(buttons(html)).toEqual(["Manage billing|orgBillingPortal"]);
  });

  it("ended: the org is on Free now — what that means, and Upgrade to Pro for the same organization, with its invoices", () => {
    const ended = (o: Partial<OrgPlanView> = {}) => view("free", { period_end: "2026-03-02T00:00:00.000Z", billing: freeBill({ ended: true, customer: true }), ...o });
    const html = block(ended());
    expect(html).toContain('data-org-billing="ended"');
    expect(html).toContain("The Pro subscription ended on 2 March 2026, so this organization is on Free now. Nothing was removed; anything over a Free limit waits until it is back under.");
    expect(buttons(html)).toEqual(["Upgrade to Pro|orgBillingUpgrade:team", "Manage billing|orgBillingPortal"]);
    expect(html).not.toContain(">Ended<"); // Free is a plan like any other: active
    // Cancelled at once, before the paid period was up: that date is not when it ended, so none is given.
    const early = block(ended({ period_end: "2999-01-01T00:00:00.000Z" }));
    expect(early).toContain("The Pro subscription ended, so this organization is on Free now.");
    expect(early).not.toContain("2999");
    // Over a Free limit (the Pro org had more): said once, as for any plan.
    expect(block(ended({ over: ["seats"] }))).toContain("This organization is over its plan's seats. Nothing was removed and everyone keeps their access; more can be added once it is back under the limit.");
    // A legacy org frozen as ended (status canceled) says that it ended and what a limit then means.
    const frozen = block(view("team", { status: "canceled", period_end: "2026-03-02T00:00:00.000Z", billing: freeBill({ ended: true, customer: true }) }));
    expect(frozen).toContain(">Ended<");
    expect(frozen).toContain("The subscription ended on 2 March 2026.");
    expect(frozen).toContain("This plan has ended. Everything here stays as it is and keeps working, but nothing a limit covers can be added until the plan is renewed or upgraded.");
  });

  it("a plan Trov set by hand says so and offers no change of seats", () => {
    const html = block(view("team", { billing: bill({ pinned: true }) }));
    expect(html).toContain("Trov set this plan for your organization, so it does not follow the subscription&#39;s.");
    expect(buttons(html)).toEqual(["Manage billing|orgBillingPortal"]);
  });

  it("an admin or a member reads the same facts and gets no button", () => {
    for (const role of ["admin", "member"] as const) {
      const html = block(view("team", { status: "past_due" }), role);
      expect(html).toContain("The last payment did not go through.");
      expect(html).not.toContain("Update the card");
      expect(buttons(html)).toEqual([]);
      expect(html).toContain("An owner of this organization manages its plan and billing.");
    }
  });

  it("billing switched off on the deployment: the buttons are really disabled and the block says why", () => {
    const html = block(view("team", { billing: bill({ available: false }) }));
    expect(html).toMatch(/<button[^>]*data-act="orgBillingPortal"[^>]*disabled[^>]*>Manage billing<\/button>/);
    expect(html).toMatch(/<button[^>]*data-act="orgBillingSeats"[^>]*disabled[^>]*>Change seats<\/button>/);
    expect(html).toContain("Billing is not available right now, so these are off. Your plan is unchanged.");
  });

  it("on its way to Stripe: the pressed button says so, the others wait; a refusal is an alert under them", () => {
    const busy = block(view("team"), "owner", { busy: "orgBillingPortal", error: null });
    expect(busy).toMatch(/data-act="orgBillingPortal"[^>]*disabled[^>]*aria-busy="true"[^>]*>Opening Stripe…<\/button>/);
    expect(busy).toMatch(/data-act="orgBillingSeats"[^>]*disabled[^>]*>Change seats<\/button>/);
    const failed = block(view("team"), "owner", { busy: null, error: "Couldn't open Stripe. Nothing was changed. Try again in a minute." });
    expect(failed).toMatch(/<div role="alert"[^>]*>Couldn&#39;t open Stripe\. Nothing was changed\. Try again in a minute\.<\/div>/);
  });

  it("a GRANTED org on a paid-for plan shows nothing about payment, exactly as before billing", () => {
    for (const billing of [null, undefined]) {
      const html = block(view("enterprise", { source: "granted", period_end: null, billing }));
      expect(html).not.toContain("data-org-billing");
      expect(html).not.toContain("Stripe");
      expect(html).not.toContain("orgBilling");
      expect(html).toContain("To change your plan, contact Trov.");
    }
  });

  it("General renders it with the page's billing state", () => {
    const ui: OrgUi = { ...initialOrgUi(), slug: "acme", settings: { status: "ok", data: { org: { slug: "acme", name: "Acme", created_at: PERIOD, created_by: "ines", logo: null } as never, can_edit: true } }, plan: { status: "ok", data: view("team") }, billing: { busy: "orgBillingPortal", error: null } };
    expect(generalTab({ slug: "acme", name: "Acme", role: "owner" }, ui)).toContain("Opening Stripe…");
  });
});

describe("the owner's billing acts — each leaves for Stripe", () => {
  it("the controller: Manage billing, Change seats / Add a seat and Upgrade to Pro each ask once and go; a refusal lands as a sentence and frees the buttons", async () => {
    const state = { org: { ...initialOrgUi(), slug: "acme", plan: { status: "ok", data: view("free") } }, me: { orgs: [{ slug: "acme", name: "Acme", role: "owner" }] }, orgSlug: "acme", myOrgs: { status: "ok", data: null } } as unknown as AppState;
    const went: string[] = [];
    let painted = 0;
    const asked: string[] = [];
    const answer = { ok: true, status: 200, body: { url: "https://billing.stripe.com/p/session/x" } as unknown };
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => { asked.push(`${init?.method ?? "GET"} ${String(url)} ${String(init?.body ?? "")}`); return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } }); }) as typeof fetch;
    try {
      const ctl = createOrgBillingActions({ state, mount: { querySelector: () => null } as unknown as HTMLElement, rerender: () => { painted++; }, unauth: () => undefined, go: (u) => went.push(u) });
      expect(ctl.act("orgRowToggle", null)).toBe(false); // not billing's
      expect(ctl.act("orgBillingUpgrade", "team")).toBe(true);
      expect(state.org.billing).toMatchObject({ busy: "orgBillingUpgrade:team" });
      // While one is on its way, the others wait.
      ctl.act("orgBillingPortal", null);
      await new Promise((r) => setTimeout(r, 0));
      expect(asked).toEqual(['POST /api/o/acme/billing/upgrade {"plan":"team"}']);
      expect(went).toEqual(["https://billing.stripe.com/p/session/x"]);
      // A plan that is not sold is not asked for.
      state.org.billing = initialOrgBillingUi();
      ctl.act("orgBillingUpgrade", "personal");
      expect(asked).toHaveLength(1);

      // "Add a seat" (Members) and "Change seats" (General) are the portal's seat count.
      ctl.act("orgBillingSeats", null);
      await new Promise((r) => setTimeout(r, 0));
      expect(asked.at(-1)).toBe('POST /api/o/acme/billing/portal {"seats":true}');
      state.org.billing = initialOrgBillingUi();
      ctl.act("orgBillingPortal", null);
      await new Promise((r) => setTimeout(r, 0));
      expect(asked.at(-1)).toBe("POST /api/o/acme/billing/portal {}");
      expect(went).toHaveLength(3);

      // A refusal: the sentence, and the buttons work again.
      state.org.billing = initialOrgBillingUi();
      Object.assign(answer, { status: 502, body: { error: "billing_failed", message: "Trov could not reach Stripe just now. Nothing was changed. Try again in a minute." } });
      ctl.act("orgBillingPortal", null);
      await new Promise((r) => setTimeout(r, 0));
      expect(state.org.billing).toEqual({ busy: null, error: "Trov could not reach Stripe just now. Nothing was changed. Try again in a minute." });
      expect(went).toHaveLength(3);
      expect(painted).toBeGreaterThan(3);
      // Not an owner: nothing is even asked.
      (state.me as { orgs: MyOrg[] }).orgs[0].role = "admin";
      const before = asked.length;
      ctl.act("orgBillingPortal", null);
      ctl.act("orgBillingSeats", null);
      expect(asked).toHaveLength(before);
    } finally { globalThis.fetch = realFetch; }
  });

  it("every refusal code has a sentence that says what to do", () => {
    const of = (code: string, status = 409, detail: string | null = null) => billingErrorText(new OrgApiError(status, code, detail, null));
    expect(of("billing_unavailable", 503)).toBe("Billing is not available right now. Your plan is unchanged.");
    expect(of("forbidden", 403)).toBe("Only an owner of this organization manages its billing.");
    expect(of("not_billed")).toContain("set by Trov");
    expect(of("not_free")).toBe("This organization already has a paid plan. Use Manage billing.");
    expect(of("mystery", 500)).toBe("Couldn't open Stripe. Nothing was changed. Try again in a minute.");
    expect(billingErrorText(new TypeError("Failed to fetch"))).toBe("Couldn't reach Trov. Check your connection and try again.");
    const limited = new ApiError(429, "rate_limited");
    expect(billingErrorText(limited)).toContain("today's limit");
  });
});

describe("a plan refusal's pointer", () => {
  const paid = { plan: "personal" as const, overrides: {}, status: "active" as const, source: "billing" as const };
  it("an owner is pointed at the one thing they can do — add a seat, upgrade, manage billing, renew, or ask Trov; everyone else at an owner", () => {
    // A legacy paid Personal org: Org settings.
    const r = planRefusal(paid, "seats", 1)!;
    expect(r.paid).toBe(true);
    expect(planRefusalSentence(r, "owner")).toBe("The Personal plan is for one person. Invitations start with the Pro plan. You can upgrade or manage billing in Org settings.");
    expect(planRefusalSentence(r, "admin")).toBe("The Personal plan is for one person. Invitations start with the Pro plan. Ask one of this organization's owners.");
    const granted = planRefusal({ ...paid, source: "granted" }, "seats", 1)!;
    expect(granted.paid).toBeUndefined();
    expect(planRefusalSentence(granted, "owner")).toMatch(/Ask Trov to change your plan\.$/);
    // Paid Pro at its seats: add a seat. Free at any limit: upgrade.
    const pro = planRefusal({ plan: "team", overrides: { seats: 3 }, status: "active", source: "billing" }, "seats", 3)!;
    expect(planRefusalSentence(pro, "owner")).toBe("This organization has reached the 3 seats its Pro plan includes. Add a seat to invite more people.");
    const free = planRefusal({ plan: "free", overrides: {}, status: "active", source: "granted" }, "repositories", 1)!;
    expect(planRefusalSentence(free, "owner")).toBe("This organization has reached the 1 repository its Free plan includes. Upgrade to Pro for more.");
    expect(planRefusalSentence(free, "member")).toBe("This organization has reached the 1 repository its Free plan includes. Ask one of this organization's owners.");
    const ended = planRefusal({ ...paid, plan: "team", status: "canceled" }, "repositories", 1)!;
    expect(planRefusalSentence(ended, "owner")).toBe("This organization's Pro plan has ended, so nothing can be added until it is renewed. You can renew it in Org settings.");
    expect(planRefusalSentence({ ...ended, paid: undefined }, "owner")).toMatch(/Ask Trov to change your plan\.$/);
  });
  it("the SPA's one sentence for a 402 carries it, and so does the invite form's gate — with the button that fixes it", () => {
    const e = new ApiError(402, "plan_limit");
    e.plan = planRefusal(paid, "seats", 1);
    expect(planLimitText(e, "owner")).toMatch(/You can upgrade or manage billing in Org settings\.$/);
    expect(planLimitText(e, "member")).toMatch(/Ask one of this organization's owners\.$/);
    const gate = inviteGate(view("personal", { billing: null, usage: { seats: 1, repositories: 0, environments: 0, artifact_bytes: 0, agent_connections: 0, ai_summaries: 0 } }), "owner");
    expect(gate).toMatchObject({ kind: "solo", sentence: expect.stringMatching(/You can upgrade or manage billing in Org settings\.$/), next: null });
    expect(inviteGate(view("personal", { source: "granted", billing: null, usage: { seats: 1, repositories: 0, environments: 0, artifact_bytes: 0, agent_connections: 0, ai_summaries: 0 } }), "owner")).toMatchObject({ sentence: expect.stringMatching(/Ask Trov to change your plan\.$/) });
    // A full Pro org: "Add a seat"; a full Free org: "Upgrade to Pro".
    const fullPro = view("team", { usage: { ...view().usage, seats: 5 } });
    expect(inviteGate(fullPro, "owner")).toMatchObject({ kind: "full", next: "add_seat" });
    expect(inviteGate(fullPro, "admin")).toMatchObject({ kind: "full", next: null });
    expect(inviteGate(view("free", { usage: { ...view().usage, seats: 3 } }), "owner")).toMatchObject({ kind: "full", next: "upgrade" });
  });
});

describe("the waiting room — /billing/done", () => {
  const room = (o: Partial<BillingDoneUi> = {}): BillingDoneUi => ({ ...initialBillingDone("cs_test_1"), ...o });
  const text = (html: string) => html.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  it("confirming: says it takes a few seconds, with a live region and no way to 'fail'", () => {
    const html = billingDonePage(room());
    expect(html).toContain('data-billing-done="confirming"');
    expect(html).toMatch(/<main[^>]*role="status" aria-live="polite"/);
    expect(text(html)).toContain("Confirming your payment This takes a few seconds. Keep this page open. Checking with Stripe");
    expect(html).toMatch(/<h1[^>]*>Confirming your payment<\/h1>/);
  });

  it("slow, or the poll resting: payment received, ready shortly, you need not wait — never 'failed'", () => {
    const slow = text(billingDonePage(room({ slow: true })));
    expect(slow).toContain("Payment received Your organization will be ready shortly.");
    expect(slow).toContain("you do not need to wait here: it will be on your organizations page when it is ready");
    const stopped = billingDonePage(room({ slow: true, stopped: true }));
    expect(stopped).toMatch(/<a href="\/billing\/done\?session_id=cs_test_1"[^>]*>Check again<\/a>/);
    expect(stopped).toMatch(/<a href="\/"[^>]*>Go to your organizations<\/a>/);
    expect(stopped).not.toContain("cnpy-spin");
    const received = text(billingDonePage(room({ phase: "received" })));
    expect(received).toContain("Payment received Getting your organization ready.");
    for (const html of [billingDonePage(room()), billingDonePage(room({ slow: true })), stopped, billingDonePage(room({ phase: "received" })), billingDonePage(room({ phase: "received", stopped: true }))]) {
      expect(text(html)).not.toMatch(/fail|error|declin|problem|went wrong/i);
    }
  });

  it("ready: sends the buyer to name their organization — a real link, the page's one accent action", () => {
    const html = billingDonePage(room({ phase: "ready", plan: "team", grant: 12 }));
    expect(text(html)).toContain("Payment received Your Pro organization is ready to set up. Next you choose its name and its address, and it is yours.");
    expect(html).toMatch(/<a href="\/\?setup=12" data-billing-go class="cnpy-accentbtn"[^>]*>Set up your organization<\/a>/);
    expect(html.match(/cnpy-accentbtn/g)).toHaveLength(1);
    expect(setupHref(12)).toBe("/?setup=12");
  });

  it("done, unpaid, cancelled, not yours, signed out: each says what is true and where to go", () => {
    const done = billingDonePage(room({ phase: "done", org: { slug: "maya-co", name: "Maya & Co" } }));
    expect(done).toMatch(/<a href="\/maya-co\/"[^>]*>Open Maya &amp; Co<\/a>/);
    expect(done).toContain("<strong style=\"color:var(--fg);font-weight:600\">Maya &amp; Co</strong> is on its plan.");
    const unpaid = text(billingDonePage(room({ phase: "unpaid" })));
    expect(unpaid).toContain("This checkout was not completed Stripe did not take a payment for it, so nothing was charged.");
    expect(billingDonePage(room({ phase: "unpaid" }))).toMatch(/<a href="\/pricing"[^>]*>See the plans<\/a>/);
    expect(text(billingDonePage(room({ phase: "ended" })))).toContain("This subscription was cancelled It was cancelled before an organization was set up on it");
    expect(text(billingDonePage(initialBillingDone(null)))).toContain("Nothing to confirm here");
    expect(text(billingDonePage(room({ phase: "signedout" })))).toContain("Sign in to finish Your payment is safe.");
  });

  it("is what the app renders while it is set, whatever else the state says — in the app's own theme wrapper", () => {
    const s = { ...initialState(), billingDone: room() };
    const html = render(s);
    expect(html).toContain('data-billing-done="confirming"');
    expect(html).toMatch(/^<div data-cnpy-theme="/);
    expect(render({ ...initialState(), billingDone: null })).not.toContain("data-billing-done");
  });

  it("holds no colour of its own and no price: tokens and Geist only", () => {
    for (const [file, src] of Object.entries(sources)) {
      expect(src, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(src, file).not.toMatch(/rgba?\(/);
      expect(src, file).not.toMatch(/font-family:(?!var\()/);
      expect(src, file).not.toMatch(/[$€£]\s?\d/);
    }
  });

  it("applies each answer of the status route", () => {
    const apply = (r: BillingStatusResponse, s = room()) => [applyBillingStatus(s, r), s.phase, s.plan, s.grant, s.org] as const;
    expect(apply({ state: "pending", paid: false })).toEqual([false, "confirming", null, null, null]);
    expect(apply({ state: "pending", paid: true })).toEqual([false, "received", null, null, null]);
    expect(apply({ state: "ready", plan: "team", grant: 7 })).toEqual([true, "ready", "team", 7, null]);
    expect(apply({ state: "done", org: { slug: "a", name: "A" } })).toEqual([true, "done", null, null, { slug: "a", name: "A" }]);
    expect(apply({ state: "unpaid" })[1]).toBe("unpaid");
    expect(apply({ state: "ended" })[1]).toBe("ended");
    // Once received, a later "not confirmed yet" does not take it back.
    const s = room({ phase: "received" });
    applyBillingStatus(s, { state: "pending", paid: false });
    expect(s.phase).toBe("received");
  });

  it("the poll: waits through pending answers and blips, turns 'slow', and goes to set-up the moment the grant exists", async () => {
    const answers: (BillingStatusResponse | Error)[] = [{ state: "pending", paid: false }, new TypeError("network"), Object.assign(new Error("503"), { status: 503 }), { state: "pending", paid: true }, { state: "ready", plan: "team", grant: 5 }];
    let ui: BillingDoneUi = room();
    let clock = 0;
    const went: string[] = [];
    const seen: string[] = [];
    await startBillingDone({
      get: () => ui, rerender: () => seen.push(`${ui.phase}${ui.slow ? "+slow" : ""}`),
      ask: async () => { const a = answers.shift()!; if (a instanceof Error) throw a; return a; },
      go: (href) => went.push(href), now: () => clock, wait: async (ms) => { clock += ms * 4; },
    });
    expect(went).toEqual(["/?setup=5"]);
    expect(ui).toMatchObject({ phase: "ready", grant: 5, plan: "team" });
    expect(seen).toEqual(["confirming", "confirming", "confirming", "received+slow", "ready+slow"]);
    expect(BILLING_POLL.slowMs).toBeGreaterThanOrEqual(15_000);

    // Never confirmed: it rests after the limit, having said "received", and does not navigate.
    ui = room(); clock = 0; went.length = 0;
    await startBillingDone({ get: () => ui, rerender: () => undefined, ask: async () => ({ state: "pending", paid: false }), go: (h) => went.push(h), now: () => clock, wait: async (ms) => { clock += ms * 20; } });
    expect(ui).toMatchObject({ phase: "confirming", slow: true, stopped: true });
    expect(went).toEqual([]);

    // Signed out, and someone else's link: said once, and the poll stops.
    for (const [err, phase] of [[new Error("unauthorized"), "signedout"], [Object.assign(new Error("not_found"), { status: 404 }), "missing"]] as const) {
      ui = room();
      let calls = 0;
      await startBillingDone({ get: () => ui, rerender: () => undefined, ask: async () => { calls++; throw err; }, go: () => undefined, now: () => 0, wait: async () => undefined });
      expect([ui.phase, calls]).toEqual([phase, 1]);
    }
    // No session in the URL: nothing is asked.
    ui = initialBillingDone(null);
    let asked = 0;
    await startBillingDone({ get: () => ui, rerender: () => undefined, ask: async () => { asked++; return { state: "unpaid" }; }, go: () => undefined });
    expect(asked).toBe(0);
  });
});

describe("the picker — a grant that was paid for", () => {
  const me = { handle: "maya", name: "Maya Ortiz", identities: [{ provider: "github" as const, label: "maya" }] };
  const grant = (o: Partial<MyGrant> = {}): MyGrant => ({ id: 9, plan: "team", plan_name: "Pro", entitlements: { ...PLANS.team.entitlements, seats: 4 }, granted_by: "billing", created_at: new Date().toISOString(), expires_at: null, gift_days: null, ...o });
  const picker = (grants: MyGrant[]) => { const orgs: MyOrgsResponse = { orgs: [], invites: [], superadmin: false, can_create: true, grants, free: { can_create: true, owned: null } }; return orgPickerView({ me, mine: [], orgs, status: "ok", ui: initialOrgsUi(), hash: "" }); };
  it("says it was paid for — never 'Granted by @billing' — and the page opens on the payment", () => {
    const html = picker([grant()]);
    expect(html).toContain("You can set up an organization &mdash; Pro");
    expect(html).toContain("For up to 4 people"); // the seats paid for travel on the grant
    expect(html).toContain("You choose its name and become its owner. Paid for ");
    expect(html).not.toContain("@billing");
    expect(html).toContain("Your payment went through. Name your organization, and you are its owner.");
    // A hand-made grant beside it keeps its own words, and the lead stops speaking of a payment.
    const mixed = picker([grant(), grant({ id: 10, granted_by: "andres" })]);
    expect(mixed).toContain("Granted by @andres");
    expect(mixed).toContain("You&#39;ve been given an organization of your own.");
  });
});

describe("Platform — a paid organization", () => {
  const paid = (o: Partial<PlatformOrgBilling> = {}): PlatformOrgBilling => ({
    customer_id: "cus_123", subscription_id: "sub_123", stripe_status: "active", plan: "team", ended: false, seats: 5, interval: "month", period_end: PERIOD,
    cancel_at_period_end: false, pinned: false, livemode: false, dashboard_url: stripeCustomerUrl("cus_123", false), ...o,
  });
  const plan = (o: Partial<PlatformOrgPlan> = {}): PlatformOrgPlan => ({ plan: "team", overrides: {}, status: "active", source: "billing", entitlements: PLANS.team.entitlements, seats_used: 3, billing: paid(), ...o });
  const section = (p: PlatformOrgPlan) => orgPlanSection({ slug: "acme", name: "Acme", plan: p }, null);

  it("says paid or granted, Stripe's own status, the period, and links to the customer in the right dashboard", () => {
    const html = section(plan());
    expect(html).toContain('data-plat-billing="paid"');
    expect(html).toContain("Paid through Stripe, monthly &middot; 5 seats");
    expect(html).toContain("Stripe says <strong");
    expect(html).toContain(">active</strong> &middot; renews 15 January 2027 &middot; test mode");
    expect(html).toMatch(/<a href="https:\/\/dashboard\.stripe\.com\/test\/customers\/cus_123" target="_blank" rel="noopener noreferrer"[^>]*>Open the customer in Stripe<\/a>/);
    const live = section(plan({ billing: paid({ livemode: true, dashboard_url: stripeCustomerUrl("cus_123", true), stripe_status: "past_due" }), status: "past_due" }));
    expect(live).toContain('href="https://dashboard.stripe.com/customers/cus_123"');
    expect(live).toContain(">past due</strong>");
    expect(live).not.toContain("test mode");
    expect(live).toContain(">PAST DUE<");
    expect(section(plan({ billing: paid({ cancel_at_period_end: true }) }))).toContain("ends 15 January 2027");
    // Ended: the org is on Free, and the line says so (no seats, no renewal).
    const ended = section(plan({ plan: "free", entitlements: PLANS.free.entitlements, billing: paid({ ended: true, stripe_status: "canceled", period_end: "2026-03-02T00:00:00.000Z" }) }));
    expect(ended).toContain("Paid through Stripe until its subscription ended: now on Free");
    expect(ended).toContain("ended 2 March 2026");
    expect(ended).not.toContain("5 seats");
    const granted = section(plan({ source: "granted", billing: null, plan: "enterprise", entitlements: PLANS.enterprise.entitlements }));
    expect(granted).toContain('data-plat-billing="granted"');
    expect(granted).toContain("Granted by Trov: nobody pays for this plan through Stripe.");
    expect(granted).not.toContain("dashboard.stripe.com");
    expect(stripeCustomerUrl("cus/../x", false)).toBe("https://dashboard.stripe.com/test/customers/cus%2F..%2Fx");
  });

  it("the list's word for each org: granted, paid, and what Stripe says of a paid one", () => {
    expect(planSourceWord(plan({ source: "granted", billing: null }))).toBe("granted");
    expect(planSourceWord(plan())).toBe("paid");
    expect(planSourceWord(plan({ status: "past_due" }))).toBe("paid, past due");
    expect(planSourceWord(plan({ status: "canceled" }))).toBe("paid, ended");
    expect(planSourceWord(plan({ plan: "free", billing: paid({ ended: true }) }))).toBe("paid, ended");
    expect(planSourceWord(plan({ plan: "free", source: "granted", billing: null }))).toBe("free");
    expect(planSourceWord(plan({ billing: paid({ cancel_at_period_end: true }) }))).toBe("paid, cancelling");
  });

  it("a plan set by hand is said to be pinned, with the way back; Change plan says what it will do to a paid org", () => {
    const pinned = section(plan({ plan: "enterprise", entitlements: PLANS.enterprise.entitlements, billing: paid({ pinned: true, plan: "team" }) }));
    expect(pinned).toContain('data-plat-billing="pinned"');
    expect(pinned).toContain("You set this plan by hand. The subscription pays for Pro, and its events do not change the plan while it is pinned.");
    expect(pinned).toMatch(/<button type="button" data-act="platPlanFollow"[^>]*>Follow subscription<\/button>/);
    expect(section(plan())).not.toContain("platPlanFollow");

    expect(planModalBillingNote(plan())).toContain("It pays for Pro through Stripe. A different plan set here is pinned");
    expect(planModalBillingNote(plan({ status: "canceled" }))).toContain("Its subscription has ended. A plan you set here takes the organization back as a granted one");
    expect(planModalBillingNote(plan({ plan: "free", billing: paid({ ended: true }) }))).toContain("Its subscription has ended.");
    expect(planModalBillingNote(plan({ source: "granted", billing: null }))).toBe("");
    const modal = planModal({ slug: "acme", name: "Acme", current: plan(), artifactBytes: null, plan: "team", limits: limitDraftOf({}), confirm: false, busy: false, error: null });
    expect(modal).toContain("data-plat-plan-billing");
  });
});

describe("the contract the pricing page uses", () => {
  it("a plan's link is a plain href, with the interval only when it is not monthly", () => {
    expect(billingStartHref("team")).toBe("/billing/start?plan=team");
    expect(billingStartHref("team", "month")).toBe("/billing/start?plan=team");
    expect(billingStartHref("team", "year")).toBe("/billing/start?plan=team&interval=year");
  });
});

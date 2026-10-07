/**
 * Billing's screens, as markup (docs/architecture/billing.md): Org settings › General's Plan block in
 * every billing state, with the owner's actions and the smaller-plan confirmation; the waiting room a
 * buyer lands in after Stripe Checkout, and its poll; the pointer a plan refusal ends with; a paid grant
 * on the picker; and Platform's view of a paid organization.
 */
import { describe, it, expect } from "vitest";
import { planBlock, planSwitchCopy, isSmallerPlan, inviteGate, initialOrgBillingUi, type OrgBillingUi } from "../web/src/org-plan";
import { generalTab, orgOverlays, initialOrgUi, type OrgUi } from "../web/src/org-settings";
import { billingErrorText, createOrgBillingActions } from "../web/src/org-billing-actions";
import { billingDonePage, initialBillingDone, applyBillingStatus, startBillingDone, setupHref, BILLING_POLL, type BillingDoneUi } from "../web/src/billing";
import { orgPickerView, initialOrgsUi } from "../web/src/org-picker";
import { orgPlanSection, planModal, planModalBillingNote, planSourceWord, limitDraftOf } from "../web/src/platform-access";
import { ApiError, OrgApiError, planLimitText } from "../web/src/api";
import { initialState, render, type AppState } from "../web/src/render";
import { PLANS, planRefusal, planRefusalSentence, resolveEntitlements, type MyGrant, type OrgPlanView, type PlatformOrgPlan, type PlanId } from "@shared/plans";
import { billingDate, billingStartHref, stripeCustomerUrl, type BillingStatusResponse, type OrgBillingView, type PlatformOrgBilling } from "@shared/billing";
import type { MyOrg, MyOrgsResponse } from "@shared/orgs";

const sources = import.meta.glob(["../web/src/billing.ts", "../web/src/org-plan.ts", "../web/src/org-billing-actions.ts"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const PERIOD = "2027-01-15T08:00:00.000Z";
const bill = (o: Partial<OrgBillingView> = {}): OrgBillingView => ({ available: true, interval: "month", cancel_at_period_end: false, pinned: false, switch_to: ["personal"], renew_on: [], ...o });
const view = (plan: PlanId = "team", o: Partial<OrgPlanView> = {}): OrgPlanView => ({
  plan, name: PLANS[plan].name, description: PLANS[plan].description, status: "active", source: "billing", period_end: PERIOD,
  entitlements: PLANS[plan].entitlements, overridden: [], seats: { members: 3, pending: 0 },
  usage: { seats: 3, repositories: 1, environments: 2, artifact_bytes: 1024 ** 2, agent_connections: 1 }, over: [], billing: bill(), ...o,
});
const block = (v: OrgPlanView, role: MyOrg["role"] = "owner", b: OrgBillingUi = initialOrgBillingUi()) => planBlock({ status: "ok", data: v }, role, b);
const buttons = (html: string): string[] => [...html.matchAll(/<button[^>]*data-act="(orgBilling\w+)"(?: data-arg="(\w+)")?[^>]*>([^<]+)<\/button>/g)].map((m) => `${m[3]}|${m[1]}${m[2] ? `:${m[2]}` : ""}`);

describe("Org settings › General — the Plan block of an org that pays", () => {
  it("active: when it renews, how it is billed, and the owner's Manage billing — with the smaller plan after it", () => {
    const html = block(view("team"));
    expect(html).toContain('data-org-billing="active"');
    expect(html).toContain(`Renews on ${billingDate(PERIOD)}. Billed monthly through Stripe.`);
    expect(billingDate(PERIOD)).toBe("15 January 2027");
    expect(buttons(html)).toEqual(["Manage billing|orgBillingPortal", "Switch to Personal|orgBillingChange:personal"]);
    expect(html).toContain("Card, invoices and cancelling are on Stripe&#39;s pages. Trov never sees your card.");
    expect(html).not.toContain("contact Trov");
    // No accent button: the tab's one primary action is not billing's.
    expect(html).not.toContain("cnpy-accentbtn");
    expect(block(view("team", { billing: bill({ interval: "year" }) }))).toContain("Billed yearly through Stripe.");
  });

  it("Personal: Upgrade to Team comes first, then Manage billing", () => {
    const html = block(view("personal", { usage: { seats: 1, repositories: 1, environments: 1, artifact_bytes: 0, agent_connections: 0 }, billing: bill({ switch_to: ["team"] }) }));
    expect(buttons(html)).toEqual(["Upgrade to Team|orgBillingChange:team", "Manage billing|orgBillingPortal"]);
    expect(html).toMatch(/data-field="orgBillingChange:team"/);
  });

  it("past due: says the payment failed, that nothing changes while Stripe retries, and the date", () => {
    const html = block(view("team", { status: "past_due" }));
    expect(html).toContain('data-org-billing="past_due"');
    expect(html).toContain(">Payment past due<");
    expect(html).toContain("The last payment did not go through. Stripe is trying the card again, and nothing changes while it does; if it keeps failing, the plan ends. The current period runs to 15 January 2027. Update the card in Manage billing.");
    expect(buttons(html)).toContain("Manage billing|orgBillingPortal");
    // Nothing is refused while past due, so nothing is said about limits.
    expect(html).not.toContain("cnpy-plan-note");
  });

  it("cancelled, ends on a date: still works until then, and how to keep it", () => {
    const html = block(view("team", { billing: bill({ cancel_at_period_end: true }) }));
    expect(html).toContain('data-org-billing="cancelling"');
    expect(html).toContain(">Cancelled<");
    expect(html).toContain("Cancelled: the plan ends on 15 January 2027. Until then everything works as before. To keep it, resume the subscription in Manage billing.");
    expect(html).not.toContain(">Ended<");
  });

  it("ended: what still works, and Renew for the same organization — the plan it was on first", () => {
    const html = block(view("team", { status: "canceled", billing: bill({ switch_to: [], renew_on: ["personal", "team"] }) }));
    expect(html).toContain('data-org-billing="ended"');
    expect(html).toContain(">Ended<");
    expect(html).toContain("The subscription ended on 15 January 2027.");
    expect(html).toContain("This plan has ended. Everything here stays as it is and keeps working, but nothing a limit covers can be added until the plan is renewed.");
    expect(buttons(html)).toEqual(["Renew Team|orgBillingRenew:team", "Renew on Personal|orgBillingRenew:personal", "Manage billing|orgBillingPortal"]);
  });

  it("a plan Trov set by hand says so and offers no switch", () => {
    const html = block(view("team", { billing: bill({ pinned: true, switch_to: [] }) }));
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
    const html = block(view("team", { billing: bill({ available: false, switch_to: [] }) }));
    expect(html).toMatch(/<button[^>]*data-act="orgBillingPortal"[^>]*disabled[^>]*>Manage billing<\/button>/);
    expect(html).toContain("Billing is not available right now, so these are off. Your plan is unchanged.");
  });

  it("on its way to Stripe: the pressed button says so, the others wait; a refusal is an alert under them", () => {
    const busy = block(view("team"), "owner", { busy: "orgBillingPortal", error: null, confirm: null });
    expect(busy).toMatch(/data-act="orgBillingPortal"[^>]*disabled[^>]*aria-busy="true"[^>]*>Opening Stripe…<\/button>/);
    expect(busy).toMatch(/data-act="orgBillingChange"[^>]*disabled[^>]*>Switch to Personal<\/button>/);
    const failed = block(view("team"), "owner", { busy: null, error: "Couldn't open Stripe. Nothing was changed. Try again in a minute.", confirm: null });
    expect(failed).toMatch(/<div role="alert"[^>]*>Couldn&#39;t open Stripe\. Nothing was changed\. Try again in a minute\.<\/div>/);
  });

  it("a GRANTED org shows nothing about payment, exactly as before billing", () => {
    for (const billing of [null, undefined]) {
      const html = block(view("enterprise", { source: "granted", period_end: null, billing }));
      expect(html).not.toContain("data-org-billing");
      expect(html).not.toContain("Stripe");
      expect(html).not.toContain("orgBilling");
      expect(html).toContain("To change your plan, contact Trov.");
    }
  });

  it("General renders it with the page's billing state", () => {
    const ui: OrgUi = { ...initialOrgUi(), slug: "acme", settings: { status: "ok", data: { org: { slug: "acme", name: "Acme", created_at: PERIOD, created_by: "ines", logo: null } as never, can_edit: true } }, plan: { status: "ok", data: view("team") }, billing: { busy: "orgBillingPortal", error: null, confirm: null } };
    expect(generalTab({ slug: "acme", name: "Acme", role: "owner" }, ui)).toContain("Opening Stripe…");
  });
});

describe("switching to a smaller plan is confirmed before leaving for Stripe", () => {
  it("says what happens to an org with more people than the plan holds: nobody removed, nothing deleted, additions wait", () => {
    const v = view("team", { usage: { seats: 3, repositories: 4, environments: 2, artifact_bytes: 0, agent_connections: 0 } });
    expect(isSmallerPlan(v, "personal")).toBe(true);
    expect(isSmallerPlan(view("personal"), "team")).toBe(false);
    expect(planSwitchCopy(v, "Acme", "personal")).toEqual({
      title: "Switch Acme to Personal?",
      body: "Personal is for one person, and Acme has 3 (members and pending invitations). Nobody is removed and nothing is deleted, but it will be over the plan's seats and repositories: no more can be added until it is back under. Stripe shows the new price and what is credited, and takes the confirmation.",
      confirmLabel: "Continue to Stripe", busyLabel: "Opening Stripe…",
    });
    // The numbers are the shared table's, never restated here.
    expect(resolveEntitlements("personal").seats).toBe(1);
    const fits = planSwitchCopy(view("team", { usage: { seats: 1, repositories: 1, environments: 1, artifact_bytes: 0, agent_connections: 0 } }), "Acme", "personal");
    expect(fits.body).toBe("Acme fits within Personal, so nothing it has changes. Stripe shows the new price and what is credited, and takes the confirmation.");
  });

  it("is the shared confirm dialog, neutral (not a deletion), for an owner only", () => {
    const ui: OrgUi = { ...initialOrgUi(), slug: "acme", plan: { status: "ok", data: view("team") }, billing: { busy: null, error: null, confirm: "personal" } };
    const html = orgOverlays({ org: { slug: "acme", name: "Acme", role: "owner" }, ui } as never);
    expect(html).toContain('id="org-billing-confirm"');
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain("Switch Acme to Personal?");
    expect(html).toContain('data-confirm-act="orgBillingConfirmGo"');
    expect(html).toContain('data-confirm-cancel="orgBillingConfirmCancel"');
    expect(html).toContain(">Continue to Stripe<");
    expect(orgOverlays({ org: { slug: "acme", name: "Acme", role: "admin" }, ui } as never)).not.toContain("org-billing-confirm");
  });

  it("the controller: an upgrade leaves at once, a downgrade asks first, a refusal lands as a sentence and frees the buttons", async () => {
    const state = { org: { ...initialOrgUi(), slug: "acme", plan: { status: "ok", data: view("personal", { billing: bill({ switch_to: ["team"] }) }) } }, me: { orgs: [{ slug: "acme", name: "Acme", role: "owner" }] }, orgSlug: "acme", myOrgs: { status: "ok", data: null } } as unknown as AppState;
    const went: string[] = [];
    let painted = 0;
    const asked: string[] = [];
    const answer = { ok: true, status: 200, body: { url: "https://billing.stripe.com/p/session/x" } as unknown };
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => { asked.push(`${init?.method ?? "GET"} ${String(url)}`); return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } }); }) as typeof fetch;
    try {
      const ctl = createOrgBillingActions({ state, mount: { querySelector: () => null } as unknown as HTMLElement, rerender: () => { painted++; }, unauth: () => undefined, confirmOut: (then) => then(), go: (u) => went.push(u) });
      expect(ctl.act("orgRowToggle", null)).toBe(false); // not billing's
      expect(ctl.act("orgBillingChange", "team")).toBe(true);
      expect(state.org.billing).toMatchObject({ busy: "orgBillingChange:team", confirm: null });
      await new Promise((r) => setTimeout(r, 0));
      expect(asked).toEqual(["POST /api/o/acme/billing/change"]);
      expect(went).toEqual(["https://billing.stripe.com/p/session/x"]);

      // Team → Personal: nothing is sent until the dialog is confirmed; cancelling sends nothing at all.
      state.org.billing = initialOrgBillingUi();
      state.org.plan = { status: "ok", data: view("team") };
      ctl.act("orgBillingChange", "personal");
      expect(state.org.billing.confirm).toBe("personal");
      expect(asked).toHaveLength(1);
      ctl.act("orgBillingConfirmCancel", null);
      expect(state.org.billing.confirm).toBeNull();
      ctl.act("orgBillingChange", "personal");
      ctl.act("orgBillingConfirmGo", null);
      await new Promise((r) => setTimeout(r, 0));
      expect(asked.at(-1)).toBe("POST /api/o/acme/billing/change");
      expect(went).toHaveLength(2);

      // A refusal: the sentence, and the buttons work again.
      state.org.billing = initialOrgBillingUi();
      Object.assign(answer, { status: 502, body: { error: "billing_failed", message: "Trov could not reach Stripe just now. Nothing was changed. Try again in a minute." } });
      ctl.act("orgBillingPortal", null);
      await new Promise((r) => setTimeout(r, 0));
      expect(state.org.billing).toEqual({ busy: null, confirm: null, error: "Trov could not reach Stripe just now. Nothing was changed. Try again in a minute." });
      expect(went).toHaveLength(2);
      expect(painted).toBeGreaterThan(3);
      // Not an owner: nothing is even asked.
      (state.me as { orgs: MyOrg[] }).orgs[0].role = "admin";
      const before = asked.length;
      ctl.act("orgBillingPortal", null);
      expect(asked).toHaveLength(before);
    } finally { globalThis.fetch = realFetch; }
  });

  it("every refusal code has a sentence that says what to do", () => {
    const of = (code: string, status = 409, detail: string | null = null) => billingErrorText(new OrgApiError(status, code, detail, null));
    expect(of("billing_unavailable", 503)).toBe("Billing is not available right now. Your plan is unchanged.");
    expect(of("forbidden", 403)).toBe("Only an owner of this organization manages its billing.");
    expect(of("not_billed")).toContain("set by Trov");
    expect(of("same_plan")).toBe("This organization is already on that plan.");
    expect(of("plan_ended")).toBe("This plan has ended. Renew it instead.");
    expect(of("mystery", 500)).toBe("Couldn't open Stripe. Nothing was changed. Try again in a minute.");
    expect(billingErrorText(new TypeError("Failed to fetch"))).toBe("Couldn't reach Trov. Check your connection and try again.");
    const limited = new ApiError(429, "rate_limited");
    expect(billingErrorText(limited)).toContain("today's limit");
  });
});

describe("a plan refusal's pointer", () => {
  const paid = { plan: "personal" as const, overrides: {}, status: "active" as const, source: "billing" as const };
  it("an owner of an org that pays is pointed at Org settings; of a granted one, at Trov; everyone else at an owner", () => {
    const r = planRefusal(paid, "seats", 1)!;
    expect(r.paid).toBe(true);
    expect(planRefusalSentence(r, "owner")).toBe("The Personal plan is for one person. Invitations start with the Team plan. You can upgrade or manage billing in Org settings.");
    expect(planRefusalSentence(r, "admin")).toBe("The Personal plan is for one person. Invitations start with the Team plan. Ask one of this organization's owners.");
    const granted = planRefusal({ ...paid, source: "granted" }, "seats", 1)!;
    expect(granted.paid).toBeUndefined();
    expect(planRefusalSentence(granted, "owner")).toMatch(/Ask Trov to change your plan\.$/);
    const ended = planRefusal({ ...paid, plan: "team", status: "canceled" }, "repositories", 1)!;
    expect(planRefusalSentence(ended, "owner")).toBe("This organization's Team plan has ended, so nothing can be added until it is renewed. You can renew it in Org settings.");
    expect(planRefusalSentence({ ...ended, paid: undefined }, "owner")).toMatch(/Ask Trov to change your plan\.$/);
  });
  it("the SPA's one sentence for a 402 carries it, and so does the invite form's gate", () => {
    const e = new ApiError(402, "plan_limit");
    e.plan = planRefusal(paid, "seats", 1);
    expect(planLimitText(e, "owner")).toMatch(/You can upgrade or manage billing in Org settings\.$/);
    expect(planLimitText(e, "member")).toMatch(/Ask one of this organization's owners\.$/);
    const gate = inviteGate(view("personal", { usage: { seats: 1, repositories: 0, environments: 0, artifact_bytes: 0, agent_connections: 0 } }), "owner");
    expect(gate).toMatchObject({ kind: "solo", sentence: expect.stringMatching(/You can upgrade or manage billing in Org settings\.$/) });
    expect(inviteGate(view("personal", { source: "granted", billing: null, usage: { seats: 1, repositories: 0, environments: 0, artifact_bytes: 0, agent_connections: 0 } }), "owner")).toMatchObject({ sentence: expect.stringMatching(/Ask Trov to change your plan\.$/) });
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
    expect(text(html)).toContain("Payment received Your Team organization is ready to set up. Next you choose its name and its address, and it is yours.");
    expect(html).toMatch(/<a href="\/\?setup=12" data-billing-go class="cnpy-accentbtn"[^>]*>Set up your organization<\/a>/);
    expect(html.match(/cnpy-accentbtn/g)).toHaveLength(1);
    expect(setupHref(12)).toBe("/?setup=12");
  });

  it("done, unpaid, cancelled, not yours, signed out: each says what is true and where to go", () => {
    const done = billingDonePage(room({ phase: "done", org: { slug: "maya-co", name: "Maya & Co" } }));
    expect(done).toMatch(/<a href="\/o\/maya-co\/"[^>]*>Open Maya &amp; Co<\/a>/);
    expect(done).toContain("<strong style=\"color:var(--fg);font-weight:600\">Maya &amp; Co</strong> is on its plan.");
    const unpaid = text(billingDonePage(room({ phase: "unpaid" })));
    expect(unpaid).toContain("This checkout was not completed Stripe did not take a payment for it, so nothing was charged.");
    expect(billingDonePage(room({ phase: "unpaid" }))).toMatch(/<a href="\/#pricing"[^>]*>See the plans<\/a>/);
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
      expect(src.replace(/#pricing/g, ""), file).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(src, file).not.toMatch(/rgba?\(/);
      expect(src, file).not.toMatch(/font-family:(?!var\()/);
      expect(src, file).not.toMatch(/[$€£]\s?\d/);
    }
  });

  it("applies each answer of the status route", () => {
    const apply = (r: BillingStatusResponse, s = room()) => [applyBillingStatus(s, r), s.phase, s.plan, s.grant, s.org] as const;
    expect(apply({ state: "pending", paid: false })).toEqual([false, "confirming", null, null, null]);
    expect(apply({ state: "pending", paid: true })).toEqual([false, "received", null, null, null]);
    expect(apply({ state: "ready", plan: "personal", grant: 7 })).toEqual([true, "ready", "personal", 7, null]);
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
  const grant = (o: Partial<MyGrant> = {}): MyGrant => ({ id: 9, plan: "team", plan_name: "Team", entitlements: PLANS.team.entitlements, granted_by: "billing", created_at: new Date().toISOString(), expires_at: null, ...o });
  const picker = (grants: MyGrant[]) => { const orgs: MyOrgsResponse = { orgs: [], invites: [], superadmin: false, can_create: true, grants }; return orgPickerView({ me, mine: [], orgs, status: "ok", ui: initialOrgsUi(), hash: "" }); };
  it("says it was paid for — never 'Granted by @billing' — and the page opens on the payment", () => {
    const html = picker([grant()]);
    expect(html).toContain("You can set up an organization &mdash; Team");
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
    customer_id: "cus_123", subscription_id: "sub_123", stripe_status: "active", plan: "team", interval: "month", period_end: PERIOD,
    cancel_at_period_end: false, pinned: false, livemode: false, dashboard_url: stripeCustomerUrl("cus_123", false), ...o,
  });
  const plan = (o: Partial<PlatformOrgPlan> = {}): PlatformOrgPlan => ({ plan: "team", overrides: {}, status: "active", source: "billing", entitlements: PLANS.team.entitlements, seats_used: 3, billing: paid(), ...o });
  const section = (p: PlatformOrgPlan) => orgPlanSection({ slug: "acme", name: "Acme", plan: p }, null);

  it("says paid or granted, Stripe's own status, the period, and links to the customer in the right dashboard", () => {
    const html = section(plan());
    expect(html).toContain('data-plat-billing="paid"');
    expect(html).toContain("Paid through Stripe, monthly");
    expect(html).toContain("Stripe says <strong");
    expect(html).toContain(">active</strong> &middot; renews 15 January 2027 &middot; test mode");
    expect(html).toMatch(/<a href="https:\/\/dashboard\.stripe\.com\/test\/customers\/cus_123" target="_blank" rel="noopener noreferrer"[^>]*>Open the customer in Stripe<\/a>/);
    const live = section(plan({ billing: paid({ livemode: true, dashboard_url: stripeCustomerUrl("cus_123", true), stripe_status: "past_due" }), status: "past_due" }));
    expect(live).toContain('href="https://dashboard.stripe.com/customers/cus_123"');
    expect(live).toContain(">past due</strong>");
    expect(live).not.toContain("test mode");
    expect(live).toContain(">PAST DUE<");
    expect(section(plan({ billing: paid({ cancel_at_period_end: true }) }))).toContain("ends 15 January 2027");
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
    expect(planSourceWord(plan({ billing: paid({ cancel_at_period_end: true }) }))).toBe("paid, cancelling");
  });

  it("a plan set by hand is said to be pinned, with the way back; Change plan says what it will do to a paid org", () => {
    const pinned = section(plan({ plan: "enterprise", entitlements: PLANS.enterprise.entitlements, billing: paid({ pinned: true, plan: "personal" }) }));
    expect(pinned).toContain('data-plat-billing="pinned"');
    expect(pinned).toContain("You set this plan by hand. The subscription pays for Personal, and its events do not change the plan while it is pinned.");
    expect(pinned).toMatch(/<button type="button" data-act="platPlanFollow"[^>]*>Follow subscription<\/button>/);
    expect(section(plan())).not.toContain("platPlanFollow");

    expect(planModalBillingNote(plan())).toContain("It pays for Team through Stripe. A different plan set here is pinned");
    expect(planModalBillingNote(plan({ status: "canceled" }))).toContain("Its subscription has ended. A plan you set here takes the organization back as a granted one");
    expect(planModalBillingNote(plan({ source: "granted", billing: null }))).toBe("");
    const modal = planModal({ slug: "acme", name: "Acme", current: plan(), artifactBytes: null, plan: "team", limits: limitDraftOf({}), confirm: false, busy: false, error: null });
    expect(modal).toContain("data-plat-plan-billing");
  });
});

describe("the contract the pricing page uses", () => {
  it("a plan's link is a plain href, with the interval only when it is not monthly", () => {
    expect(billingStartHref("personal")).toBe("/billing/start?plan=personal");
    expect(billingStartHref("team", "month")).toBe("/billing/start?plan=team");
    expect(billingStartHref("team", "year")).toBe("/billing/start?plan=team&interval=year");
  });
});

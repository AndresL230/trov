/**
 * The screens of plans and grants (shared/plans.ts), as markup: the picker's grant card, its Free row and
 * the create dialog they open; Org settings › General's Plan block and Members' seats (at the cap — with
 * the owner's one fix, "Add a seat" on a paid Pro org or "Upgrade to Pro" on Free — and on a one-person
 * plan); Platform › Access (the grants, the grant dialog, revoke) and an organization's plan with the
 * Change plan dialog and its confirmation.
 */
import { describe, it, expect } from "vitest";
import { orgPickerView, orgMenu, createOrgModal, blankCreateOrg, createOrgServerError, initialOrgsUi, FREE_TAKEN_SENTENCE } from "../web/src/org-picker";
import { membersTab, generalTab, setupSteps, initialOrgUi, type OrgUi } from "../web/src/org-settings";
import { planBlock, inviteGate, seatCapAction, seatsLead, initialOrgBillingUi } from "../web/src/org-plan";
import {
  accessTab, accessDialogs, grantModal, planModal, orgPlanSection, planChangeCopy, parseLimitDraft, limitDraftOf, grantSentence, grantServerError, seatsCell, planSourceWord,
  blankGrant, blankLimits, initialAccess, type AccessState, type PlanDraft,
} from "../web/src/platform-access";
import { platformView, platformDialogs, addOrgModal, blankAddOrg, initialPlat, orgsTab, PLAT_TABS, type PlatState } from "../web/src/platform";
import { initialDropdownUi } from "../web/src/dropdown";
import { LIMIT_KEYS, PLANS, resolveEntitlements, type MyGrant, type OrgPlanView, type PlatformGrant, type PlatformOrgPlan, type PlanId } from "@shared/plans";
import type { MyOrg, MyOrgsResponse, OrgMember, PlatformOrgRow } from "@shared/orgs";
import type { OrgBillingView } from "@shared/billing";

const sources = import.meta.glob(["../web/src/org-plan.ts", "../web/src/platform-access.ts", "../web/src/platform-access-actions.ts"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const grant = (o: Partial<MyGrant> = {}): MyGrant => ({ id: 4, plan: "team", plan_name: "Pro", entitlements: PLANS.team.entitlements, granted_by: "andres", created_at: "2026-10-05T09:00:00.000Z", expires_at: null, gift_days: null, ...o });
const mine = (o: Partial<MyOrgsResponse> = {}): MyOrgsResponse => ({ orgs: [], invites: [], superadmin: false, can_create: true, grants: [grant()], free: { can_create: false, owned: null }, ...o });
const me = { handle: "ines", name: "Ines Vidal", identities: [{ provider: "github" as const, label: "ines-vidal" }] };
const picker = (orgs: MyOrgsResponse) => orgPickerView({ me, mine: orgs.orgs, orgs, status: "ok", ui: initialOrgsUi(), hash: "" });

const view = (plan: PlanId = "team", o: Partial<OrgPlanView> = {}): OrgPlanView => ({
  plan, name: PLANS[plan].name, description: PLANS[plan].description, status: "active", source: "granted", period_end: null, gift_until: null,
  entitlements: PLANS[plan].entitlements, overridden: [], seats: { members: 5, pending: 2 },
  usage: { seats: 7, repositories: 1, environments: 2, artifact_bytes: 1024 ** 3, agent_connections: 1, ai_summaries: 0 }, over: [], ...o,
});
/** An org's billing view (shared/billing.ts): by default a Free org that never paid and can upgrade to Pro. */
const bill = (o: Partial<OrgBillingView> = {}): OrgBillingView => ({
  available: true, subscribed: false, ended: false, customer: false, interval: null, seats: null, cancel_at_period_end: false, pinned: false, upgrade_to: ["team"], ...o,
});
/** A Pro org that pays through Stripe for `seats` seats — and uses every one. */
const paidPro = (seats: number): OrgPlanView => view("team", {
  source: "billing", entitlements: { ...PLANS.team.entitlements, seats }, overridden: ["seats"], usage: { ...view().usage, seats }, seats: { members: seats, pending: 0 },
  billing: bill({ subscribed: true, customer: true, interval: "month", seats, upgrade_to: [] }),
});
/** A Free org with every seat in use. */
const fullFree = (o: Partial<OrgBillingView> = {}): OrgPlanView => view("free", { usage: { ...view().usage, seats: 3 }, seats: { members: 2, pending: 1 }, billing: bill(o) });
const org = (role: MyOrg["role"] = "owner"): MyOrg => ({ slug: "acme", name: "Acme", role });
const member = (handle: string, role: OrgMember["role"] = "member"): OrgMember => ({ handle, name: handle, color: "sky", avatar_url: null, role, title: null, joined_at: "2026-10-01T00:00:00.000Z" });
const orgUi = (plan: OrgPlanView | null, o: Partial<OrgUi> = {}): OrgUi => ({
  ...initialOrgUi(), slug: "acme", members: { status: "ok", data: [member("ines", "owner")] }, invites: { status: "ok", data: [] },
  plan: plan ? { status: "ok", data: plan } : { status: "loading", data: null }, ...o,
});

describe("the org picker — a grant", () => {
  it("shows “You can set up an organization — <Plan>” with what it gives and who granted it, above waiting for an invitation", () => {
    const html = picker(mine());
    expect(html).toContain("You can set up an organization &mdash; Pro");
    expect(html).toContain("For up to 50 people. You choose its name and become its owner. Granted by @andres");
    expect(html).toMatch(/<button type="button" data-act="orgsCreateOpen" data-arg="4" data-field="orgsCreateOpen:4" aria-label="Set up your Pro organization" class="cnpy-accentbtn"[^>]*>Set up organization<\/button>/);
    expect(html.indexOf("You can set up an organization")).toBeLessThan(html.indexOf("Or wait for an invitation"));
    expect(html).toContain("You&#39;ve been given an organization of your own.");
    expect(html).toContain('data-orgs-grant="4"');
  });
  it("each grant is its own row; a (legacy) Personal one says it is for one person, an expiring one by when", () => {
    const html = picker(mine({ grants: [grant({ id: 1, plan: "personal", plan_name: "Personal", entitlements: PLANS.personal.entitlements }), grant({ id: 2, expires_at: "2026-11-06T00:00:00.000Z" })] }));
    expect(html.match(/data-orgs-grant=/g)).toHaveLength(2);
    expect(html).toContain("You can set up an organization &mdash; Personal");
    expect(html).toContain("For one person: you.");
    expect(html).toMatch(/use it by Nov [56], 2026/);
    // Only the first is the page's primary action.
    expect(html.match(/class="cnpy-accentbtn"/g)).toHaveLength(1);
  });
  it("with an organization already, the grant is offered quietly; without one, nothing about creating", () => {
    const withOrg = picker(mine({ orgs: [org()] }));
    expect(withOrg).toContain("Set up your own");
    expect(withOrg).not.toContain("cnpy-accentbtn");
    expect(picker(mine({ can_create: false, grants: [] }))).not.toContain("orgsCreateOpen");
  });
  it("the create dialog says which plan the organization will be on", () => {
    const html = createOrgModal(blankCreateOrg(grant()));
    expect(html).toContain("It will be on the <strong");
    expect(html).toContain(">Pro</strong> plan, up to 50 people. You become its owner and invite everyone else.");
    const solo = createOrgModal(blankCreateOrg(grant({ plan: "personal", plan_name: "Personal", entitlements: PLANS.personal.entitlements })));
    expect(solo).toContain(">Personal</strong> plan, for one person. You become its owner.");
    expect(solo).not.toContain("invite everyone else");
  });
  it("the switcher's menu offers Create organization only to a person who can: a usable grant, or Free", () => {
    const menu = (o: MyOrgsResponse) => orgMenu({ orgs: o, mine: o.orgs, current: "acme", status: "ok", ui: { ...initialOrgsUi(), menu: true } });
    expect(menu(mine({ orgs: [org()] }))).toContain("Create organization");
    expect(menu(mine({ orgs: [org()], grants: [], free: { can_create: true, owned: null } }))).toContain("Create organization");
    expect(menu(mine({ orgs: [org()], can_create: false, grants: [] }))).not.toContain("Create organization");
  });
});

describe("the org picker — Free", () => {
  const freeOnly = (o: Partial<MyOrgsResponse> = {}) => mine({ grants: [], free: { can_create: true, owned: null }, ...o });

  it("with nothing to open and no grant, “Create a Free organization” is the page's primary action, above waiting for an invitation", () => {
    const html = picker(freeOnly());
    expect(html).toContain('<li class="cnpy-orgs-opt" data-orgs-free>');
    expect(html).toContain("Create a Free organization");
    expect(html).toContain("For up to 3 people, free. You choose its name and become its owner. Upgrade to Pro, paid per seat, when you need more.");
    expect(html).toMatch(/<button type="button" data-act="orgsCreateOpen" data-arg="free" data-field="orgsCreateOpen:free" aria-label="Create a Free organization" class="cnpy-accentbtn"[^>]*>Create organization<\/button>/);
    expect(html.match(/class="cnpy-accentbtn"/g)).toHaveLength(1);
    expect(html.indexOf("data-orgs-free")).toBeLessThan(html.indexOf("Wait for an invitation"));
    expect(html).toContain("Everything in it belongs to an organization: create one for your team, or join one you&#39;re invited to.");
  });
  it("beside a grant or an organization of one's own it is quiet: one primary action on the page", () => {
    const withGrant = picker(mine({ free: { can_create: true, owned: null } }));
    expect(withGrant.indexOf('data-orgs-grant="4"')).toBeLessThan(withGrant.indexOf("data-orgs-free"));
    expect(withGrant.match(/class="cnpy-accentbtn"/g)).toHaveLength(1);
    expect(withGrant).toMatch(/data-arg="4"[^>]*class="cnpy-accentbtn"/);
    expect(withGrant).toMatch(/data-arg="free"[^>]*class="cnpy-ghostbtn"/);
    const withOrg = picker(freeOnly({ orgs: [org()] }));
    expect(withOrg).toContain("data-orgs-free");
    expect(withOrg).not.toContain("cnpy-accentbtn");
  });
  it("someone who already owns a Free organization is not offered another", () => {
    const html = picker(freeOnly({ can_create: false, free: { can_create: false, owned: { slug: "mine", name: "Mine" } } }));
    expect(html).not.toContain("data-orgs-free");
    expect(html).not.toContain("orgsCreateOpen");
    expect(html).not.toContain("create one for your team");
  });
  it("the create dialog says it will be on Free, and a refusal for a second one says why", () => {
    expect(blankCreateOrg(null, true).free).toBe(true);
    expect(blankCreateOrg().free).toBe(false);
    expect(blankCreateOrg(grant(), true).free).toBe(false); // a grant decides the plan
    const html = createOrgModal(blankCreateOrg(null, true));
    expect(html).toContain(">Free</strong> plan, up to 3 people. You become its owner and invite everyone else; upgrade it to Pro when you need more.");
    expect(FREE_TAKEN_SENTENCE).toBe("You already own a Free organization, and you can own one at a time. Upgrade it to Pro in its Org settings, or ask Trov if you need another.");
    expect(createOrgServerError("free_org_limit", { slug: "acme" })).toEqual({ form: FREE_TAKEN_SENTENCE });
  });
});

describe("Org settings › General — the Plan block", () => {
  it("names the plan, what it is for, each limit with the org's use, and how to change it", () => {
    const html = planBlock({ status: "ok", data: view() }, "owner");
    expect(html).toContain('data-org-plan="team"');
    expect(html).toContain(">Pro</span>");
    expect(html).toContain("For a team, paid per seat.");
    for (const label of ["Seats", "Repositories", "Environments", "Artifact storage", "Agent connections", "AI summaries"]) expect(html).toContain(label);
    expect(html.match(/data-limit="/g)).toHaveLength(LIMIT_KEYS.length);
    expect(html).toMatch(/data-limit="seats">[\s\S]*?7 of 50/);
    expect(html).toContain("Members plus pending invitations.");
    expect(html).toMatch(/data-limit="artifact_bytes">[\s\S]*?1 GB of 5 GB/);
    expect(html).toContain("per person");
    expect(html).toContain("To change your plan, contact Trov.");
    expect(planBlock({ status: "ok", data: view() }, "member")).toContain("An owner of this organization can ask Trov to change the plan.");
    // Nobody edits it here.
    expect(html).not.toMatch(/<input|data-act=/);
  });
  it("AI summaries: the month's use of the allowance, with thousands separators; used up says what happens and is never 'over'", () => {
    const row = (html: string): string => html.slice(html.indexOf('data-limit="ai_summaries"')).split("</li>")[0];
    const some = row(planBlock({ status: "ok", data: view("team", { usage: { ...view().usage, ai_summaries: 1212 } }) }, "owner"));
    expect(some).toContain("1,212 of 3,000 this month");
    expect(some).not.toContain("3000");
    expect(some).not.toContain("data-limit-spent");
    const spent = row(planBlock({ status: "ok", data: view("team", { usage: { ...view().usage, ai_summaries: 3000 } }) }, "owner"));
    expect(spent).toContain("3,000 of 3,000 this month");
    expect(spent).toContain("New pull requests and issues show an excerpt until next month.");
    expect(spent).not.toContain("Over the limit");
    expect(row(planBlock({ status: "ok", data: view("enterprise", { usage: { ...view().usage, ai_summaries: 12345 } }) }, "owner"))).toContain("12,345 used &middot; Unlimited");
  });
  it("an unlimited limit shows the use and says Unlimited", () => {
    const html = planBlock({ status: "ok", data: view("enterprise") }, "owner");
    expect(html).toMatch(/data-limit="seats">[\s\S]*?7 used &middot; Unlimited/);
  });
  it("OVER a limit: says which, in words, and that nothing was removed", () => {
    const html = planBlock({ status: "ok", data: view("personal", { over: ["seats", "repositories"] }) }, "owner");
    expect(html).toContain("This organization is over its plan's seats and repositories. Nothing was removed and everyone keeps their access; more can be added once it is back under the limit.");
    expect(html).toMatch(/data-limit="seats" data-over="1"[\s\S]*?Over the limit/);
    expect(html).toContain('role="status"');
  });
  it("a plan that ended or is past due says so with a labelled chip, never colour alone", () => {
    expect(planBlock({ status: "ok", data: view("team", { status: "canceled" }) }, "owner")).toMatch(/>Ended<[\s\S]*This plan has ended\. Everything here stays as it is and keeps working/);
    expect(planBlock({ status: "ok", data: view("team", { status: "past_due" }) }, "owner")).toContain(">Payment past due<");
  });
  it("loading and failed; and it is part of the General tab", () => {
    // Two tiles of General's bento: Plan (name, billing, who changes it), then Limits (the rows).
    const two = planBlock({ status: "ok", data: view() }, "owner");
    expect([...two.matchAll(/<section class="cnpy-surface cnpy-tile (cnpy-org-gen-[a-z]+)"/g)].map((m) => m[1])).toEqual(["cnpy-org-gen-plan", "cnpy-org-gen-limits"]);
    expect(two.indexOf('id="org-plan-t"')).toBeLessThan(two.indexOf("cnpy-org-gen-limits"));
    expect(two.indexOf('id="org-limits-t"')).toBeLessThan(two.indexOf('class="cnpy-plan-rows"'));
    expect(two.slice(0, two.indexOf("cnpy-org-gen-limits"))).not.toContain("cnpy-plan-row");
    expect(planBlock({ status: "loading", data: null }, "owner")).toContain("Loading the plan");
    expect(planBlock({ status: "error", data: null }, "owner")).toContain("Couldn't load the plan");
    const ui = orgUi(view(), { settings: { status: "ok", data: { org: { slug: "acme", name: "Acme", created_at: "2026-10-01T00:00:00.000Z", created_by: "ines" }, can_edit: true } } });
    expect(generalTab(org(), ui)).toContain('data-org-plan="team"');
  });
});

describe("Org settings › Members — seats", () => {
  it("the lead line shows the seats used of the cap; unlimited seats show none", () => {
    expect(seatsLead(view())).toBe("<strong>7</strong> of <strong>50</strong> seats used");
    expect(seatsLead(view("free"))).toBe("<strong>7</strong> of <strong>3</strong> seats used");
    expect(seatsLead(view("enterprise"))).toBe("");
    expect(seatsLead(null)).toBe("");
    const html = membersTab(org(), orgUi(view()), "ines");
    expect(html).toContain("<strong>7</strong> of <strong>50</strong> seats used &middot; <strong>1</strong> member");
    expect(html).toContain('id="org-invite"');
  });
  it("AT THE CAP: the invite form is replaced by the sentence, and how to free a seat", () => {
    const full = view("team", { usage: { ...view().usage, seats: 50 }, seats: { members: 46, pending: 4 } });
    expect(inviteGate(full, "owner")).toEqual({ kind: "full", sentence: "This organization has reached the 50 seats its Pro plan includes. Ask Trov to change your plan.", next: null });
    expect(inviteGate(full, "admin")).toMatchObject({ sentence: expect.stringContaining("Ask one of this organization's owners."), next: null });
    const html = membersTab(org(), orgUi(full), "ines");
    expect(html).toContain('data-invite-gate="full"');
    expect(html).not.toContain('id="org-invite"');
    expect(html).toContain("This organization has reached the 50 seats its Pro plan includes. Ask Trov to change your plan. Removing a member or revoking a pending invite frees a seat.");
    expect(html).toContain("<strong>50</strong> of <strong>50</strong> seats used");
    // A granted plan: Trov changes it, so there is nothing for the owner to press.
    expect(html).not.toContain("data-seat-fix");
  });
  it("AT THE CAP of a paid Pro org: its owner gets “Add a seat”, the act that opens Stripe's seat count", () => {
    const full = paidPro(12);
    expect(inviteGate(full, "owner")).toEqual({ kind: "full", sentence: "This organization has reached the 12 seats its Pro plan includes. Add a seat to invite more people.", next: "add_seat" });
    const html = membersTab(org(), orgUi(full), "ines");
    expect(html).toContain('data-invite-gate="full"');
    expect(html).not.toContain('id="org-invite"');
    expect(html).toContain("This organization has reached the 12 seats its Pro plan includes. Add a seat to invite more people. Removing a member or revoking a pending invite frees a seat.");
    expect(html).toMatch(/<div class="cnpy-plan-actions" data-seat-fix="add_seat"><button type="button" data-act="orgBillingSeats" data-field="orgBillingSeats" class="cnpy-ghostbtn"[^>]*>Add a seat<\/button><\/div>/);
    expect(html).not.toContain("Upgrade to Pro");
    // Only where it can work: no live subscription with a customer, no button (the sentence still says what to do).
    expect(inviteGate({ ...full, billing: bill({ subscribed: true, customer: false, seats: 12, upgrade_to: [] }) }, "owner")).toMatchObject({ kind: "full", next: null });
    expect(inviteGate({ ...full, billing: null }, "owner")).toMatchObject({ kind: "full", next: null });
    // Stripe off on this deployment: the button is there, and off.
    expect(membersTab(org(), orgUi({ ...full, billing: { ...full.billing!, available: false } }), "ines")).toMatch(/data-act="orgBillingSeats" data-field="orgBillingSeats" disabled class="cnpy-org-off"[^>]*>Add a seat</);
    // Busy: it says it is on its way.
    expect(membersTab(org(), orgUi(full, { billing: { ...initialOrgBillingUi(), busy: "orgBillingSeats" } }), "ines")).toContain(">Opening Stripe…</button>");
  });
  it("a Pro org that bought ONE seat is full, not a one-person plan: its owner sees the invite section with “Add a seat”", () => {
    const one = paidPro(1);
    expect(inviteGate(one, "owner")).toEqual({ kind: "full", sentence: "This organization has reached the 1 seat its Pro plan includes. Add a seat to invite more people.", next: "add_seat" });
    const html = membersTab(org(), orgUi(one), "ines");
    expect(html).toContain('data-invite-gate="full"');
    expect(html).toContain("Invite someone");
    expect(html).not.toContain("data-plan-solo");
    expect(html).not.toContain("is for one person");
    expect(html).toContain('data-seat-fix="add_seat"');
    expect(html).toMatch(/data-act="orgBillingSeats"[^>]*>Add a seat<\/button>/);
    expect(html).toContain("<strong>1</strong> of <strong>1</strong> seat used");
  });
  it("AT THE CAP of a Free org: its owner gets “Upgrade to Pro”, a checkout for this org", () => {
    const full = fullFree();
    expect(inviteGate(full, "owner")).toEqual({ kind: "full", sentence: "This organization has reached the 3 seats its Free plan includes. Upgrade to Pro for more.", next: "upgrade" });
    const html = membersTab(org(), orgUi(full), "ines");
    expect(html).toContain('data-invite-gate="full"');
    expect(html).toContain("This organization has reached the 3 seats its Free plan includes. Upgrade to Pro for more. Removing a member or revoking a pending invite frees a seat.");
    expect(html).toMatch(/<div class="cnpy-plan-actions" data-seat-fix="upgrade"><button type="button" data-act="orgBillingUpgrade" data-arg="team" data-field="orgBillingUpgrade:team" class="cnpy-ghostbtn"[^>]*>Upgrade to Pro<\/button><\/div>/);
    expect(html).not.toContain("Add a seat");
    // Nothing to upgrade to on this deployment: no button.
    expect(inviteGate(fullFree({ upgrade_to: [] }), "owner")).toMatchObject({ kind: "full", next: null });
    expect(membersTab(org(), orgUi(fullFree({ upgrade_to: [] })), "ines")).not.toContain("data-seat-fix");
    // A failed trip to Stripe says so under the button.
    expect(membersTab(org(), orgUi(full, { billing: { ...initialOrgBillingUi(), error: "Couldn't open Stripe." } }), "ines")).toMatch(/data-seat-fix="upgrade">[\s\S]*?<div role="alert"[^>]*>Couldn&#39;t open Stripe\.<\/div>/);
  });
  it("AT THE CAP, an admin who is not an owner reads the sentence with who to ask — and gets no button", () => {
    for (const full of [paidPro(12), fullFree()]) {
      expect(inviteGate(full, "admin")).toMatchObject({ kind: "full", sentence: expect.stringMatching(/ Ask one of this organization's owners\.$/), next: null });
      const html = membersTab(org("admin"), orgUi(full), "ines");
      expect(html).toContain('data-invite-gate="full"');
      expect(html).toContain("Ask one of this organization&#39;s owners. Removing a member or revoking a pending invite frees a seat.");
      expect(html).not.toContain("data-seat-fix");
      expect(html).not.toMatch(/Add a seat|Upgrade to Pro/);
    }
    // The button itself needs a `next`: none, nothing.
    expect(seatCapAction(null, initialOrgBillingUi(), true)).toBe("");
  });
  it("A ONE-PERSON PLAN: no invite section at all, and the tab says the plan is for one person", () => {
    const solo = view("personal", { usage: { ...view().usage, seats: 1 }, seats: { members: 1, pending: 0 } });
    expect(inviteGate(solo, "owner").kind).toBe("solo");
    const html = membersTab(org(), orgUi(solo), "ines");
    expect(html).not.toContain("Invite someone");
    expect(html).not.toContain('id="org-invite"');
    expect(html).toContain("<strong>1</strong> of <strong>1</strong> seat used");
    expect(html).toMatch(/<span data-plan-solo>The Personal plan is for one person\. Invitations start with the Pro plan\. Ask Trov to change your plan\.<\/span>/);
    // A member who is not an admin reads the first sentence only.
    expect(membersTab(org("member"), orgUi(solo), "ines")).toMatch(/<span data-plan-solo>The Personal plan is for one person\.<\/span>/);
  });
  it("a plan that ended refuses invitations in its own words; an unread plan leaves the form (the server answers)", () => {
    const ended = membersTab(org(), orgUi(view("team", { status: "canceled" })), "ines");
    expect(ended).toContain('data-invite-gate="ended"');
    expect(ended).toContain("plan has ended");
    expect(membersTab(org(), orgUi(null), "ines")).toContain('id="org-invite"');
    expect(inviteGate(null, "owner")).toEqual({ kind: "open" });
  });
  it("the setup checklist does not ask a one-person org to invite its team", () => {
    const ready: Partial<OrgUi> = { repos: { status: "ok", data: [] }, envs: { status: "ok", data: [] }, integrations: { status: "ok", data: { integrations: [], key: null } as never } };
    expect(setupSteps(orgUi(view(), ready))!.map((s) => s.key)).toEqual(["repo", "env", "token", "team"]);
    expect(setupSteps(orgUi(view("personal"), ready))!.map((s) => s.key)).toEqual(["repo", "env", "token"]);
    // A Pro org that bought ONE seat is not a one-person plan: it invites by adding a seat, so the step stays.
    expect(setupSteps(orgUi(paidPro(1), ready))!.map((s) => s.key)).toEqual(["repo", "env", "token", "team"]);
  });
});

// ── Platform ─────────────────────────────────────────────────────────────────
const pg = (o: Partial<PlatformGrant> = {}): PlatformGrant => ({
  id: 9, handle: null, github_login: "nova-dev", email: null, plan: "team", overrides: {}, note: null, source: "granted", granted_by: "andres", gift_days: null,
  created_at: "2026-10-06T09:00:00.000Z", expires_at: null, status: "unused", used_at: null, used_by: null, org: null, revoked_at: null, revoked_by: null,
  mail_status: null, mail_at: null, mail_error: null, ...o,
});
const access = (o: Partial<AccessState> = {}): AccessState => ({ ...initialAccess(), grants: { status: "ok", data: [] }, ...o });
const orgPlan = (plan: PlanId = "team", o: Partial<PlatformOrgPlan> = {}): PlatformOrgPlan => ({ plan, overrides: {}, status: "active", source: "granted", entitlements: resolveEntitlements(plan, o.overrides ?? {}), seats_used: 7, ...o });
const row = (o: Partial<PlatformOrgRow> = {}): PlatformOrgRow => ({
  slug: "acme", name: "Acme", logo_url: null, status: "active", created_at: "2026-09-01T10:00:00.000Z", created_by: "andres", suspended_at: null, suspended_by: null,
  owners: [{ handle: "maya", name: "Maya" }], member_count: 5, pending_invites: 2, last_activity_at: null, plan: orgPlan(), ...o,
});
const draft = (o: Partial<PlanDraft> = {}): PlanDraft => ({ slug: "acme", name: "Acme", current: orgPlan(), artifactBytes: 0, plan: "team", limits: blankLimits(), confirm: false, busy: false, error: null, ...o });

describe("Platform › Access — the grants", () => {
  it("is a tab of Platform, beside Organizations", () => {
    expect(PLAT_TABS).toEqual(["orgs", "access", "usage", "support", "admins", "audit"]);
    const p: PlatState = { ...initialPlat(), superadmin: true, tab: "access", access: access({ grants: { status: "ok", data: [pg()] } }) };
    const html = platformView(p, "andres");
    expect(html).toMatch(/>Access<\/[a-z]+>/);
    expect(html).toContain('data-grant="9"');
  });
  it("empty: says what a grant is, with the one primary action", () => {
    const html = accessTab(access());
    expect(html).toContain("No grants yet. A grant lets one person set up one organization of their own, on the plan you choose.");
    expect(html.match(/data-act="platGrantOpen"/g)).toHaveLength(1);
    expect(html).toContain("Grant an organization");
  });
  it("lists who, the plan, the status in words, when and by whom — a used one links to the org it became", () => {
    const html = accessTab(access({ grants: { status: "ok", data: [
      pg(),
      pg({ id: 10, github_login: null, email: "cto@bigco.io", plan: "enterprise", overrides: { seats: 40 }, note: "Annual contract", mail_status: "sent", expires_at: "2026-11-06T00:00:00.000Z" }),
      pg({ id: 11, github_login: null, handle: "maya", status: "used", used_by: "maya", used_at: "2026-10-06T10:00:00.000Z", org: { slug: "maya-co", name: "Maya Co" } }),
      pg({ id: 12, status: "revoked", revoked_by: "andres", revoked_at: "2026-10-06T11:00:00.000Z" }),
      pg({ id: 13, status: "expired", expires_at: "2026-10-01T00:00:00.000Z" }),
      pg({ id: 14, github_login: null, email: "buyer@shop.io", source: "billing", granted_by: "billing", mail_status: "failed" }),
    ] } }));
    expect(html).toContain("<strong>6</strong> grants &middot; <strong>3</strong> unused.");
    for (const word of ["UNUSED", "USED", "REVOKED", "EXPIRED"]) expect(html).toContain(`>${word}<`);
    expect(html).toContain("GitHub login &middot; granted");
    expect(html).toContain("by @andres &middot; does not expire");
    expect(html).toMatch(/cto@bigco\.io[\s\S]*?Enterprise[\s\S]*?Email &middot;[\s\S]*?email sent &middot; seats 40[\s\S]*?Annual contract/);
    expect(html).toMatch(/became <button type="button" data-act="platOpenOrg" data-arg="maya-co"[^>]*>Maya Co<\/button> \(@maya/);
    expect(html).toContain("revoked");
    expect(html).toContain("by billing");
    expect(html).toContain("email not sent");
    // Revoke is offered for an unused or an expired grant only, as quiet text with a name.
    expect(html.match(/data-act="platGrantRevokeArm"/g)).toHaveLength(4);
    expect(html).toContain('aria-label="Revoke the grant for nova-dev"');
    expect(html).not.toMatch(/data-grant="11"[^]*?data-act="platGrantRevokeArm" data-arg="11"/);
  });
  it("loading and failed", () => {
    expect(accessTab(access({ grants: { status: "loading", data: [] } }))).toContain("Loading grants");
    expect(accessTab(access({ grants: { status: "error", data: [] } }))).toContain("Couldn't load the grants.");
  });
  it("the grant dialog: the person three ways, the plan dropdown, the limits for Enterprise, a note and an expiry", () => {
    const html = grantModal(blankGrant());
    expect(html).toContain('role="dialog" aria-modal="true" aria-labelledby="plat-grant-t"');
    for (const kind of ["Existing person", "GitHub login", "Email"]) expect(html).toContain(kind);
    expect(html).toContain("they need no Trov account yet");
    expect(html).not.toContain("become an owner at once"); // Add organization's wording, not a grant's
    expect(html).toMatch(/id="plat-grant-plan"[^>]*data-act="ddToggle"[^>]*aria-haspopup="listbox"/);
    expect(html).toContain("Pro: up to 50 people.");
    expect(html).toContain('data-act="platGrantLimits"');
    expect(html).not.toContain('id="plat-grant-limit-seats"');
    expect(html).toContain('<label for="plat-grant-note"');
    expect(html).toMatch(/id="plat-grant-expiry"/);
    expect(html).not.toContain("<select");
    const ent = grantModal({ ...blankGrant(), plan: "enterprise" });
    for (const k of ["seats", "repositories", "environments", "artifact_bytes", "agent_connections"]) expect(ent).toContain(`<label for="plat-grant-limit-${k}"`);
    expect(ent).toMatch(/id="plat-grant-limit-seats"[^>]*placeholder="Unlimited"/);
    expect(ent).toContain("Leave a limit blank for the Enterprise plan's own");
    // The dropdown's menu is a root overlay beside the dialog, with each plan and what it is.
    const open = accessDialogs(access({ grant: blankGrant() }), "platform", { ...initialDropdownUi(), open: "plat-grant-plan" });
    expect(open).toContain('data-dd-pop="plat-grant-plan"');
    expect(open).toContain("For a small team trying Trov out.");
    expect(open).toContain("For a team, paid per seat.");
    expect(open.match(/role="option"/g)).toHaveLength(3); // the plans on offer: Free, Pro, Enterprise
    expect(open).not.toContain('data-arg="personal"');
    // A legacy plan stays pickable only while it is the value already chosen, and says it is no longer offered.
    const legacy = accessDialogs(access({ grant: { ...blankGrant(), plan: "personal" } }), "platform", { ...initialDropdownUi(), open: "plat-grant-plan" });
    expect(legacy.match(/role="option"/g)).toHaveLength(4);
    expect(legacy).toContain("One person&#39;s own organization. No longer offered.");
  });
  it("errors sit under their field; once made the dialog says what happens next", () => {
    const bad = grantModal({ ...blankGrant(), kind: "email", value: "nope", limitsOpen: true, errors: { to: "Enter an email address, like name@example.com.", limits: "Seats: enter a whole number of at least 1, or “unlimited”." } });
    expect(bad).toMatch(/id="plat-grant-to"[^>]*aria-invalid="true" aria-describedby="plat-grant-to-err"/);
    expect(bad).toContain('<div id="plat-grant-limit-err" role="alert"');
    expect(grantServerError("no_such_person", { kind: "handle", value: "@ghost" }).to).toContain("No one has the handle @ghost.");
    expect(grantServerError("", { kind: "handle", value: "x" }).form).toContain("wasn't made");
    expect(grantSentence(pg())).toBe("nova-dev can now set up one Pro organization. No email is sent for a GitHub login: tell them it is waiting.");
    expect(grantSentence(pg({ github_login: null, email: "a@b.io", mail_status: "sent" }))).toBe("a@b.io can now set up one Pro organization. Trov emailed them.");
    expect(grantSentence(pg({ github_login: null, handle: "maya" }))).toContain("@maya can now set up one Pro organization. They see it the next time they open Trov.");
    const done = grantModal({ ...blankGrant(), done: pg() });
    expect(done).toContain("Organization granted");
    expect(done).toContain('role="status"');
    expect(done).toContain("Until they do, you can revoke it here.");
  });
  it("revoking asks first, and says what it does", () => {
    const html = accessDialogs(access({ grants: { status: "ok", data: [pg()] }, revokeArm: 9 }), "platform", initialDropdownUi());
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain("Revoke the grant for nova-dev?");
    expect(html).toContain("They can no longer set up an organization with it.");
    expect(html).toContain('data-confirm-act="platGrantRevokeGo" data-confirm-cancel="platGrantRevokeCancel"');
  });
});

describe("Platform — an organization's plan", () => {
  it("the list shows each org's plan, its seats used of the cap, and whether it is granted, free or paid for", () => {
    const html = orgsTab({ orgs: { status: "ok", data: [
      row(), row({ slug: "big", name: "Big", plan: orgPlan("enterprise", { seats_used: 31 }) }), row({ slug: "tiny", name: "Tiny", plan: orgPlan("free", { seats_used: 2 }) }),
    ] } });
    expect(html).toContain("<span>Plan</span>");
    expect(html).toMatch(/>Pro<\/span>[\s\S]*?>7 of 50 seats &middot; granted<\/span>/);
    expect(html).toMatch(/>Enterprise<\/span>[\s\S]*?>31 seats &middot; granted<\/span>/);
    expect(html).toMatch(/>Free<\/span>[\s\S]*?>2 of 3 seats &middot; free<\/span>/);
    expect(seatsCell(orgPlan())).toBe("7 of 50");
    // A Free org that never paid is "free"; one whose subscription ended (it moved to Free) is "paid, ended".
    expect(planSourceWord(orgPlan("free"))).toBe("free");
    expect(planSourceWord(orgPlan("free", { source: "billing" }))).toBe("paid, ended");
    expect(planSourceWord(orgPlan("team", { source: "billing" }))).toBe("paid");
    // A row cached from before plans reads as unknown, not as a plan.
    expect(orgsTab({ orgs: { status: "ok", data: [row({ plan: undefined })] } })).toContain("&mdash;");
  });
  it("the org's page: its plan, each limit (marked when set for this org), seats used / cap, and Change plan", () => {
    const html = orgPlanSection(row({ plan: orgPlan("enterprise", { overrides: { seats: 25 } }) }), 2 * 1024 ** 3);
    expect(html).toContain('data-plat-plan="enterprise"');
    expect(html).toMatch(/data-limit="seats"[\s\S]*?set for this org[\s\S]*?7 of 25/);
    expect(html).toMatch(/data-limit="artifact_bytes"[\s\S]*?2 GB used[\s\S]*?unlimited/);
    expect(html).toMatch(/<button type="button" data-act="platPlanOpen" data-plat-plan-trigger class="cnpy-outlinebtn" aria-haspopup="dialog"[^>]*>Change plan<\/button>/);
    expect(orgPlanSection(row({ plan: orgPlan("personal", { seats_used: 4 }) }), null)).toContain("over the limit");
    expect(orgPlanSection(row({ plan: orgPlan("team", { status: "canceled" }) }), null)).toContain(">ENDED<");
  });
  it("the limit fields: blank is the plan's own, a number or “unlimited” overrides, storage is in GB", () => {
    expect(parseLimitDraft(blankLimits())).toEqual({ overrides: {} });
    expect(parseLimitDraft({ ...blankLimits(), seats: " 25 ", repositories: "Unlimited", artifact_bytes: "0.5" })).toEqual({ overrides: { seats: 25, repositories: null, artifact_bytes: 536870912 } });
    expect(parseLimitDraft({ ...blankLimits(), seats: "0" })).toEqual({ error: "Seats: enter a whole number of at least 1, or “unlimited”." });
    expect(parseLimitDraft({ ...blankLimits(), environments: "two" })).toEqual({ error: "Environments: enter a whole number, or “unlimited”." });
    expect(parseLimitDraft({ ...blankLimits(), artifact_bytes: "-1" })).toMatchObject({ error: expect.stringContaining("Artifact storage") });
    expect(limitDraftOf({ seats: 25, repositories: null, artifact_bytes: 5 * 1024 ** 3 })).toEqual({ ...blankLimits(), seats: "25", repositories: "unlimited", artifact_bytes: "5" });
  });
  it("the Change plan dialog: the plan dropdown and the five limits, then a review", () => {
    const html = planModal(draft());
    expect(html).toContain("Change Acme's plan");
    expect(html).toContain("It is on Pro and uses 7 of 50 seats. Changing a plan never removes anything from the organization.");
    expect(html).toMatch(/id="plat-plan-pick"[^>]*data-act="ddToggle"/);
    expect(html).toMatch(/id="plat-plan-limit-seats"[^>]*placeholder="50"/);
    // The plan dropdown offers the plans on offer; an org still on legacy Personal keeps it as an option.
    const pick = (d: PlanDraft) => accessDialogs(access({ plan: d }), "platformorg", { ...initialDropdownUi(), open: "plat-plan-pick" });
    expect(pick(draft()).match(/role="option"/g)).toHaveLength(3);
    expect(pick(draft())).not.toContain('data-arg="personal"');
    const legacy = pick(draft({ current: orgPlan("personal", { seats_used: 1 }), plan: "personal" }));
    expect(legacy.match(/role="option"/g)).toHaveLength(4);
    expect(legacy).toContain("No longer offered.");
    expect(html).toContain('data-act="platPlanReview"');
    expect(planModal(draft({ error: "Seats: enter a whole number of at least 1, or “unlimited”." }))).toContain('role="alert"');
  });
  it("THE CONFIRMATION says what happens when the org is over the new limits — nothing is removed", () => {
    const down = planChangeCopy(draft({ plan: "free", artifactBytes: 2 * 1024 ** 3 }), {});
    expect(down.title).toBe("Move Acme from Pro to Free?");
    expect(down.body).toBe("Acme will be over the new limits: it has 7 seats (members and pending invitations) where the new limit is 3, and 2 GB of artifacts where the new limit is 250 MB. Nothing is removed and nobody loses access. Anything it already has over a new limit stays, and no more of that kind can be added until it is back under.");
    const up = planChangeCopy(draft({ plan: "enterprise" }), { seats: 25 });
    expect(up.title).toBe("Move Acme from Pro to Enterprise?");
    expect(up.body).toContain("Its seats become 25; it uses 7.");
    expect(up.body).toContain("Nothing is removed and nobody loses access.");
    expect(planChangeCopy(draft(), { seats: 12 }).title).toBe("Change Acme's limits?");
    const html = planModal(draft({ plan: "free", confirm: true }));
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain("will be over the new limits");
    expect(html).toContain('data-confirm-act="platPlanGo" data-confirm-cancel="platPlanBack"');
    expect(html).toContain('data-confirm-tone="neutral"'); // it takes nothing away: not the destructive red
    // Shown through platformDialogs on the org's page only.
    const p: PlatState = { ...initialPlat(), superadmin: true, access: access({ plan: draft({ plan: "free", confirm: true }) }) };
    expect(platformDialogs(p, "platformorg")).toContain("Move Acme from Pro to Free?");
    expect(platformDialogs(p, "platform")).toBe("");
  });
  it("Add organization picks the plan the org starts on, with the shared dropdown", () => {
    const html = addOrgModal(blankAddOrg());
    expect(html).toMatch(/id="plat-add-plan"[^>]*data-act="ddToggle"/);
    expect(html).toContain("For a team, paid per seat. Its limits can be set on its page afterwards.");
    expect(blankAddOrg().plan).toBe("team");
    // The plans on offer only: a new organization is never put on legacy Personal.
    const p: PlatState = { ...initialPlat(), superadmin: true, add: blankAddOrg() };
    const open = platformDialogs(p, "platform", { ...initialDropdownUi(), open: "plat-add-plan" });
    expect(open.match(/role="option"/g)).toHaveLength(3);
    expect(open).not.toContain('data-arg="personal"');
  });
});

describe("the new modules keep to the design system", () => {
  it("every colour is a token (no hex, no rgb), and no native <select>", () => {
    expect(Object.keys(sources)).toHaveLength(3);
    for (const [file, src] of Object.entries(sources)) {
      expect(src, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b(?![^`]*&)/);
      expect(src, file).not.toMatch(/rgba?\(/);
      expect(src, file).not.toContain("<select");
    }
  });
});

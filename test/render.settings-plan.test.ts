/**
 * Personal Settings › Plan, Limits and Organizations (web/src/settings-plan.ts), as markup.
 *
 *  • the Plan tile in every role and state: an owner of a Free org (upgrade), of a paying org (manage
 *    billing, change seats), of a gifted one (keep it by paying); anyone else (no buttons — who can, and
 *    the way to Org settings); billing not set up; the plan not read yet, and a read that failed
 *  • the price: only what the organization is actually charged
 *  • the Limits tile: every limit as "used of limit" with a meter; unknown is "—", never 0
 *  • the Organizations tile: each org with my role and its plan, who pays only where the data says so,
 *    and Create organization or the sentence that says why not
 *  • the same words as Org settings › General's Plan block (org-plan.ts), which stays the one source
 */
import { describe, it, expect } from "vitest";
import { settingsPlanTile, settingsLimitsTile, settingsOrgsTile, planPriceWords, upgradePriceWords, paysWords, PRICING_HREF } from "../web/src/settings-plan";
import { planBlock, planParts } from "../web/src/org-plan";
import { FREE_TAKEN_SENTENCE } from "../web/src/org-picker";
import { render, initialState } from "../web/src/render";
import { esc } from "../web/src/ui";
import { LIMIT_KEYS, LIMITS, PLANS, type MyGrant, type OrgPlanView, type PlanId } from "@shared/plans";
import type { MyOrg, MyOrgsResponse, OrgRole } from "@shared/orgs";
import type { OrgBillingView } from "@shared/billing";
import css from "../web/src/trov.css?raw";

const view = (plan: PlanId = "team", o: Partial<OrgPlanView> = {}): OrgPlanView => ({
  plan, name: PLANS[plan].name, description: PLANS[plan].description, status: "active", source: "granted", period_end: null, gift_until: null,
  entitlements: PLANS[plan].entitlements, overridden: [], seats: { members: 2, pending: 0 },
  usage: { seats: 2, repositories: 1, environments: 2, artifact_bytes: 1024 ** 2 * 50, agent_connections: 1, ai_summaries: 12 }, over: [], ...o,
});
const bill = (o: Partial<OrgBillingView> = {}): OrgBillingView => ({
  available: true, subscribed: false, ended: false, customer: false, interval: null, seats: null, cancel_at_period_end: false, pinned: false, upgrade_to: ["team"], ...o,
});
const free = (o: Partial<OrgPlanView> = {}) => view("free", { billing: bill(), ...o });
const paid = (o: Partial<OrgPlanView> = {}, b: Partial<OrgBillingView> = {}) => view("team", {
  source: "billing", period_end: "2026-11-08T00:00:00.000Z", entitlements: { ...PLANS.team.entitlements, seats: 6 }, overridden: ["seats"],
  usage: { ...view().usage, seats: 6 }, billing: bill({ subscribed: true, customer: true, interval: "month", seats: 6, upgrade_to: [], ...b }), ...o,
});
const org = (role: OrgRole = "owner") => ({ slug: "acme", name: "Acme Robotics", role });
const ok = (v: OrgPlanView) => ({ status: "ok" as const, data: v });
const plan = (v: OrgPlanView, role: OrgRole = "owner") => settingsPlanTile({ org: org(role), plan: ok(v) });
const limits = (v: OrgPlanView) => settingsLimitsTile({ org: org(), plan: ok(v) });
const buttons = (html: string) => [...html.matchAll(/<button[^>]*data-act="(orgBilling\w+)"[^>]*>([^<]*)<\/button>/g)].map((m) => `${m[1]}:${m[2]}`);

describe("Settings › Plan — whose plan, which plan, and what I can do about it", () => {
  it("says whose plan it is and my role in it, its name and description, and links to the pricing page", () => {
    const html = plan(free());
    expect(html).toMatch(/data-plan-org[^>]*>Acme Robotics &middot; you are an owner</);
    expect(html).toMatch(/data-plan-name[^>]*>Free</);
    expect(html).toContain(PLANS.free.description);
    expect(html).toMatch(new RegExp(`<a href="${PRICING_HREF}" target="_blank" rel="noopener" data-plan-compare[^>]*>Compare plans`));
    expect(plan(free(), "member")).toContain("you are a member");
    expect(plan(free(), "admin")).toContain("you are an admin");
  });

  it("an owner of a Free org: Upgrade to Pro (the Plan block's own act), Pro's price, and no 'below'", () => {
    const html = plan(free());
    expect(html).toContain('data-set-billing="free"');
    expect(buttons(html)).toEqual(["orgBillingUpgrade:Upgrade to Pro"]);
    expect(html).toMatch(/data-act="orgBillingUpgrade" data-arg="team"/);
    // The limits sit BESIDE this tile, so its sentence does not point "below" (Org settings' does).
    expect(html).toContain("Pro is paid per seat: one for each member or pending invitation. It raises every limit.");
    expect(html).not.toContain("every limit below");
    expect(html).toMatch(/data-plan-upsell>Pro is \$10 per seat \/ month\.</);
    expect(html).toContain("Pro is paid through Stripe; you choose the number of seats there. Trov never sees your card.");
  });

  it("an owner of a paying org: Change seats and Manage billing, the renewal as the Plan block words it, and the price it is charged", () => {
    const v = paid();
    const html = plan(v);
    expect(html).toContain('data-set-billing="active"');
    expect(buttons(html)).toEqual(["orgBillingSeats:Change seats", "orgBillingPortal:Manage billing", "orgBillingCancel:Cancel plan"]);
    expect(html).toMatch(/data-plan-price[^>]*>\$10 per seat \/ month</);
    expect(html).toContain("6 seats, paid per seat. Renews on 8 November 2026. Billed monthly through Stripe.");
    expect(html).not.toContain("data-plan-upsell");
    // Past due and cancelled read as they do in Org settings: the chip, and the sentence.
    expect(plan(paid({ status: "past_due" }))).toContain("Payment past due");
    const cancelling = plan(paid({}, { cancel_at_period_end: true }));
    expect(cancelling).toContain('data-set-billing="cancelling"');
    expect(cancelling).toContain("Cancelled: the plan ends on 8 November 2026");
    expect(buttons(cancelling)).toEqual(["orgBillingPortal:Manage billing"]);
  });

  it("a gifted org: the gift's line, and for its owner the way to keep the plan by paying", () => {
    const gifted = view("team", { gift_until: "2099-12-20T00:00:00.000Z", billing: bill({ gifted: true }) });
    const html = plan(gifted);
    expect(html).toContain('data-set-billing="gift"');
    expect(html).toMatch(/data-plan-gift="on"[^>]*>Free until 20 December 2099, a gift from Trov\./);
    expect(buttons(html)).toEqual(["orgBillingUpgrade:Keep Pro by paying"]);
    expect(html).not.toContain("data-plan-price"); // nobody is charged for a gift
    const member = plan(gifted, "member");
    expect(member).toContain("Free until 20 December 2099");
    expect(buttons(member)).toEqual([]);
  });

  it("not an owner: no buttons — one sentence naming who can change it, and a link to Org settings › General", () => {
    for (const role of ["admin", "member"] as const) {
      const freeOrg = plan(free(), role), paidOrg = plan(paid(), role);
      expect(buttons(freeOrg), role).toEqual([]);
      expect(buttons(paidOrg), role).toEqual([]);
      expect(freeOrg).toMatch(/data-plan-foot[^>]*>An owner of this organization can upgrade it to Pro\.</);
      expect(paidOrg).toMatch(/data-plan-foot[^>]*>An owner of this organization manages its plan and billing\.</);
      expect(paidOrg).toMatch(/<button type="button" data-act="orgGo" data-arg="general"[^>]*>Org settings &rarr;<\/button>/);
      // …and they still read the plan, what it costs and when it renews.
      expect(paidOrg).toContain("Renews on 8 November 2026");
      expect(paidOrg).toMatch(/data-plan-price/);
    }
    expect(plan(paid())).toMatch(/data-act="orgGo" data-arg="general"[^>]*>Plan and limits in Org settings &rarr;/);
  });

  it("billing not set up: the Plan block's own disabled state and sentence", () => {
    const off = plan(paid({}, { available: false }));
    expect(off).toMatch(/<button[^>]*data-act="orgBillingSeats"[^>]*disabled[^>]*>Change seats</);
    expect(off).toMatch(/<button[^>]*data-act="orgBillingPortal"[^>]*disabled[^>]*>Manage billing</);
    expect(off).toContain("Billing is not available right now, so these are off. Your plan is unchanged.");
    // A Free org with nothing on sale offers no button at all — and no price for a plan it cannot buy here… the price is still Pro's.
    const freeOff = plan(free({ billing: bill({ available: false, upgrade_to: [] }) }));
    expect(buttons(freeOff)).toEqual([]);
    expect(freeOff).toContain("Billing is not available right now");
  });

  it("an action on its way to Stripe says so and the others wait; a refusal is shown under the buttons", () => {
    const busy = settingsPlanTile({ org: org(), plan: ok(paid()), billing: { busy: "orgBillingPortal", error: null } });
    expect(busy).toMatch(/data-act="orgBillingPortal"[^>]*disabled[^>]*aria-busy="true"[^>]*>Opening Stripe…</);
    expect(busy).toMatch(/data-act="orgBillingSeats"[^>]*disabled/);
    const refused = settingsPlanTile({ org: org(), plan: ok(paid()), billing: { busy: null, error: "Couldn't open Stripe. Nothing was changed. Try again in a minute." } });
    expect(refused).toMatch(/role="alert"[^>]*>Couldn&#39;t open Stripe\.|role="alert"[^>]*>Couldn't open Stripe\./);
  });

  it("a granted plan: nothing about payment, and who to ask", () => {
    const html = plan(view("enterprise"));
    expect(html).not.toContain("data-set-billing");
    expect(buttons(html)).toEqual([]);
    expect(html).toMatch(/data-plan-price[^>]*>Custom pricing</);
    expect(html).toContain("To change your plan, contact Trov.");
    expect(plan(view("enterprise"), "member")).toContain("An owner of this organization can ask Trov to change the plan.");
  });

  it("every word and button is the Plan block's: the two can never say different things about one organization", () => {
    for (const [v, role] of [[paid(), "owner"], [paid(), "member"], [paid({ status: "past_due" }), "owner"], [view("enterprise"), "owner"]] as const) {
      const parts = planParts(v, role);
      const block = planBlock(ok(v), role);
      const tile = plan(v, role);
      for (const text of [parts.line, parts.foot]) if (text) { expect(block).toContain(esc(text)); expect(tile).toContain(esc(text)); }
      expect(buttons(tile)).toEqual(buttons(block));
    }
    // The one sentence the tile words itself (a Free org's) still has the Plan block's closing line and button.
    expect(buttons(plan(free()))).toEqual(buttons(planBlock(ok(free()), "owner")));
  });

  it("not read yet: a skeleton in the tile's own frame; a failed read: a sentence and Try again — never a broken tile", () => {
    const loading = settingsPlanTile({ org: org(), plan: { status: "loading", data: null } });
    expect(loading).toContain('data-set-plan="loading"');
    expect(loading).toMatch(/class="cnpy-skel" data-skel="set-plan" aria-busy="true"/);
    expect(loading).toContain("Acme Robotics"); // whose plan is known before the plan is
    expect(loading).toContain("Compare plans");
    const failed = settingsPlanTile({ org: org(), plan: { status: "error", data: null, error: "boom" } });
    expect(failed).toMatch(/role="alert"[^>]*>Couldn't load this organization&#39;s plan\./);
    expect(failed).toMatch(/data-act="orgPlanReload"[^>]*>Try again</);
    expect(failed).not.toContain("boom");
    expect(failed).not.toContain("data-skel");
    expect(settingsPlanTile({ org: null, plan: { status: "idle", data: null } })).toContain("Open an organization to see its plan.");
  });
});

describe("the price — only what the organization is charged", () => {
  it("a monthly subscription says the monthly price; a yearly one says nothing while no yearly price exists", () => {
    expect(planPriceWords(paid())).toBe("$10 per seat / month");
    expect(planPriceWords(paid({}, { interval: "year" }))).toBe("");
    expect(planPriceWords(paid({}, { pinned: true }))).toBe(""); // Trov set the plan: it is not what the subscription pays for
  });
  it("a granted, gifted or Free plan names no price of its own; Enterprise is the pricing page's 'Custom pricing'", () => {
    expect(planPriceWords(view("team"))).toBe("");
    expect(planPriceWords(view("team", { gift_until: "2099-01-01T00:00:00.000Z" }))).toBe("");
    expect(planPriceWords(free())).toBe("");
    expect(planPriceWords(view("personal"))).toBe("");
    expect(planPriceWords(view("enterprise"))).toBe("Custom pricing");
  });
  it("only a Free org is told what Pro costs", () => {
    expect(upgradePriceWords(free())).toBe("Pro is $10 per seat / month.");
    expect(upgradePriceWords(paid())).toBe("");
    expect(upgradePriceWords(view("enterprise"))).toBe("");
  });
});

describe("Settings › Limits — every limit, with the use of it", () => {
  const row = (html: string, key: string) => html.match(new RegExp(`<li class="cnpy-set-limit" data-limit="${key}"[\\s\\S]*?</li>`))?.[0] ?? "";

  it("one row per limit, in the plan's order, each 'used of limit' with a meter and what it counts", () => {
    const html = limits(free());
    expect([...html.matchAll(/data-limit="(\w+)"/g)].map((m) => m[1])).toEqual([...LIMIT_KEYS]);
    expect(row(html, "seats")).toMatch(/data-limit-use[^>]*>2 of 3</);
    expect(row(html, "artifact_bytes")).toMatch(/data-limit-use[^>]*>50 MB of 250 MB</);
    expect(row(html, "ai_summaries")).toMatch(/AI summaries <span[^>]*>this month<\/span>/);
    expect(row(html, "ai_summaries")).toMatch(/data-limit-use[^>]*>12 of 300</);
    for (const k of LIMIT_KEYS) expect(row(html, k), k).toContain(LIMITS[k].counts);
    // The meter: a real role with its numbers, filled to the share used.
    expect(row(html, "seats")).toMatch(/class="cnpy-meter" data-meter="ok" role="meter" aria-label="Seats" aria-valuemin="0" aria-valuemax="3" aria-valuenow="2" aria-valuetext="2 of 3"><span style="width:67%">/);
    expect(row(html, "environments")).toMatch(/data-meter="full"[\s\S]*width:100%/);
  });

  it("agent connections are MINE, and say so", () => {
    const r = row(limits(free()), "agent_connections");
    expect(r).toMatch(/Agent connections <span[^>]*>yours<\/span>/);
    expect(r).toMatch(/data-limit-use[^>]*>1 of 5</);
    expect(r).toContain('aria-label="Agent connections, yours"');
  });

  it("unknown use is '—', never 0: no number, no filled meter", () => {
    const v = free();
    const html = limits({ ...v, usage: { ...v.usage, repositories: undefined as unknown as number, seats: Number.NaN } });
    for (const k of ["repositories", "seats"]) {
      const r = row(html, k);
      expect(r, k).toContain('data-unknown="1"');
      expect(r, k).toMatch(/data-limit-use[^>]*>&mdash; of /);
      expect(r, k).not.toMatch(/data-limit-use[^>]*>0 /);
      expect(r, k).toMatch(/class="cnpy-meter" data-meter="none" aria-hidden="true"><\/div>/);
    }
    expect(row(html, "environments")).not.toContain("data-unknown");
  });

  it("an unlimited limit shows what is used and 'Unlimited', with no meter to fill", () => {
    const r = row(limits(view("enterprise")), "seats");
    expect(r).toMatch(/data-limit-use[^>]*>2 used &middot; Unlimited</);
    expect(r).toContain('data-meter="none"');
  });

  it("over a limit: the row says so in amber and the tile says nothing was removed; a spent allowance says what happens instead", () => {
    const over = limits(free({ usage: { ...free().usage, seats: 6 }, over: ["seats"] }));
    expect(row(over, "seats")).toMatch(/data-over="1"[\s\S]*data-meter="over"[\s\S]*data-limit-over[^>]*>Over the limit</);
    expect(over).toMatch(/data-limits-note="over"[^>]*>Over the plan's seats\. Nothing was removed; more can be added once it is back under\./);
    const spent = limits(free({ usage: { ...free().usage, ai_summaries: 300 } }));
    expect(row(spent, "ai_summaries")).toMatch(/data-limit-spent[^>]*>New pull requests and issues show an excerpt until next month\./);
    expect(spent).not.toContain("data-limits-note"); // a used-up allowance is not "over"
    expect(limits(free({ status: "canceled" }))).toMatch(/data-limits-note="ended"[^>]*>This plan has ended\./);
  });

  it("not read yet: six skeleton rows; a failed read: a sentence and Try again", () => {
    const loading = settingsLimitsTile({ org: org(), plan: { status: "idle", data: null } });
    expect(loading).toMatch(/data-skel="set-limits" aria-busy="true"/);
    expect(loading.match(/class="cnpy-set-limit"/g)).toHaveLength(LIMIT_KEYS.length);
    const failed = settingsLimitsTile({ org: org(), plan: { status: "error", data: null } });
    expect(failed).toMatch(/Couldn't load this organization&#39;s limits\./);
    expect(failed).toMatch(/data-act="orgPlanReload"/);
    expect(failed).not.toContain("data-limit=");
  });

  it("the meter is quiet and still: no radius of its own, no animation", () => {
    const rule = css.match(/\n\.cnpy-meter \{[^}]*\}/)?.[0] ?? "";
    expect(rule).toContain("height:4px");
    expect(rule).not.toMatch(/border-radius|animation|transition/);
    expect(css.match(/\n\.cnpy-meter > span \{[^}]*\}/)?.[0]).not.toMatch(/animation|transition/);
  });
});

describe("Settings › Organizations — every org I belong to, and what I may create", () => {
  const acme: MyOrg = { slug: "acme", name: "Acme Robotics", role: "owner", logo_url: null, plan: "team", paid: true };
  const birch: MyOrg = { slug: "birch", name: "Birch Labs", role: "member", logo_url: null, plan: "team", paid: true };
  const cedar: MyOrg = { slug: "cedar", name: "Cedar", role: "admin", logo_url: null, plan: "free", paid: false };
  const gifted: MyOrg = { slug: "dune", name: "Dune", role: "owner", logo_url: null, plan: "enterprise", paid: false };
  const grant: MyGrant = { id: 4, plan: "team", plan_name: "Pro", entitlements: PLANS.team.entitlements, granted_by: "andres", created_at: "2026-10-05T09:00:00.000Z", expires_at: null, gift_days: null };
  const mine = (o: Partial<MyOrgsResponse> = {}): MyOrgsResponse => ({ orgs: [acme, birch, cedar, gifted], invites: [], superadmin: false, can_create: false, grants: [], free: { can_create: false, owned: null }, ...o });
  const tile = (orgs: MyOrgsResponse | null, o: Partial<Parameters<typeof settingsOrgsTile>[0]> = {}) => settingsOrgsTile({ orgs, mine: [], status: orgs ? "ok" : "loading", current: "acme", ...o });
  const rowOf = (html: string, slug: string) => html.match(new RegExp(`<li><a href="/${slug}/"[\\s\\S]*?</a></li>`))?.[0] ?? "";

  it("one row per org: a LINK that opens it, my role, its plan's chip; the one on screen is marked", () => {
    const html = tile(mine());
    expect([...html.matchAll(/<a href="\/([a-z]+)\/" class="cnpy-set-org" data-org="\1"/g)].map((m) => m[1])).toEqual(["acme", "birch", "cedar", "dune"]);
    expect(rowOf(html, "acme")).toMatch(/aria-current="true"/);
    expect(rowOf(html, "acme")).toMatch(/data-org-role[^>]*>Owner &middot; open now/);
    expect(rowOf(html, "birch")).not.toContain("aria-current");
    expect(rowOf(html, "birch")).toMatch(/data-org-plan="team"[^>]*><span[^>]*>Pro</);
    expect(rowOf(html, "cedar")).toMatch(/data-org-role[^>]*>Admin</);
    expect(rowOf(html, "cedar")).toMatch(/data-org-plan="free"[^>]*><span[^>]*>Free</);
    expect(rowOf(html, "dune")).toMatch(/data-org-plan="enterprise"[^>]*><span[^>]*>Enterprise</);
    // A row is a link, never a button holding one.
    expect(html).not.toMatch(/<button[^>]*>[^<]*<a /);
  });

  it("who pays is said only where the data says so: a live subscription — never for a Free, granted or gifted org", () => {
    expect(paysWords(acme)).toBe("you manage its billing");
    expect(paysWords(birch)).toBe("paid for by its owners");
    expect(paysWords({ ...birch, role: "admin" })).toBe("paid for by its owners");
    for (const o of [cedar, gifted, { ...acme, paid: undefined }, { ...acme, paid: false }]) expect(paysWords(o), o.slug).toBe("");
    const html = tile(mine());
    expect(rowOf(html, "acme")).toContain("you manage its billing");
    expect(rowOf(html, "birch")).toContain("paid for by its owners");
    expect(rowOf(html, "cedar")).not.toMatch(/billing|paid for/);
    expect(rowOf(html, "dune")).not.toMatch(/billing|paid for/);
  });

  it("an org with no plan on the wire (an older answer) shows no chip rather than a guessed one", () => {
    const html = tile(mine({ orgs: [{ slug: "acme", name: "Acme Robotics", role: "owner" }] }));
    expect(html).not.toContain("data-org-plan");
    expect(rowOf(html, "acme")).toMatch(/data-org-role[^>]*>Owner &middot; open now</);
  });

  it("may create: the existing Create organization act — a Free one of my own, or a grant's plan", () => {
    const freeOk = tile(mine({ can_create: true, free: { can_create: true, owned: null } }));
    expect(freeOk).toMatch(/data-orgs-create[\s\S]*<button[^>]*data-act="orgsCreateOpen"[^>]*>Create organization<\/button>/);
    expect(freeOk).toContain("A Free organization of your own: one owned at a time.");
    const granted = tile(mine({ can_create: true, grants: [grant] }));
    expect(granted).toContain("You can set up an organization on Pro.");
  });

  it("may not: the existing sentence saying why (already owns a Free one), and no button; a superadmin is pointed at Platform", () => {
    const taken = tile(mine({ free: { can_create: false, owned: { slug: "cedar", name: "Cedar" } } }));
    expect(taken).not.toContain("orgsCreateOpen");
    expect(taken).toMatch(/data-orgs-nocreate/);
    expect(taken).toContain(FREE_TAKEN_SENTENCE);
    const sup = tile(mine({ superadmin: true }));
    expect(sup).not.toContain("orgsCreateOpen");
    expect(sup).toMatch(/As a superadmin you add organizations in <a href="\/platform\/"/);
  });

  it("pending invitations are counted, with the way to answer them", () => {
    const inv = { id: 1, org: { slug: "elm", name: "Elm" }, role: "member" as const, invited_by: "x", created_at: "t", github_login: "me", email: null };
    expect(tile(mine({ invites: [inv] }))).toMatch(/data-orgs-invites[^>]*>1 invitation is waiting\. <button type="button" data-act="orgsMenu"[^>]*>Answer it</);
    expect(tile(mine({ invites: [inv, { ...inv, id: 2 }] }))).toContain("2 invitations are waiting.");
    expect(tile(mine())).not.toContain("data-orgs-invites");
  });

  it("before the read lands: the session's own list (no chips); nothing known at all: a skeleton; a failed read: a sentence", () => {
    const early = tile(null, { mine: [{ slug: "acme", name: "Acme Robotics", role: "owner" }] });
    expect(rowOf(early, "acme")).toContain("Acme Robotics");
    expect(early).not.toContain("data-org-plan");
    expect(early).not.toContain("data-skel");
    expect(tile(null)).toMatch(/data-skel="set-orgs" aria-busy="true"/);
    const failed = tile(null, { status: "error", mine: [{ slug: "acme", name: "Acme Robotics", role: "owner" }] });
    expect(rowOf(failed, "acme")).toContain("Acme Robotics");
    expect(failed).toMatch(/role="alert"[^>]*>Couldn't load what you can create\./);
    expect(failed).toMatch(/data-act="orgsReload"/);
  });
});

describe("the Settings screen composes them for the org on screen", () => {
  const me = { handle: "alice", name: null, avatar_url: null, color: "moss" as const, identities: [], orgs: [{ slug: "acme", name: "Acme Robotics", role: "owner" as const }], superadmin: false, pending_invites: 0 };
  const base = () => ({ ...initialState(), view: "app" as const, screen: "settings" as const, me, orgSlug: "acme" });

  it("the plan read for THIS org fills the tiles; one read for another org is not shown as this one's", () => {
    const s = base();
    s.org = { ...s.org, slug: "acme", plan: { status: "ok", data: paid() } };
    const html = render(s);
    expect(html).toMatch(/data-set-plan="team" data-set-role="owner" data-set-billing="active"/);
    expect(html).toContain('data-limit="seats"');
    const other = base();
    other.org = { ...other.org, slug: "birch", plan: { status: "ok", data: paid() } };
    const stale = render(other);
    expect(stale).toContain('data-set-plan="loading"');
    expect(stale).not.toContain('data-set-billing="active"');
  });

  it("with nothing read yet the page still renders every tile (skeletons), and offers no billing button", () => {
    const html = render(base());
    for (const cls of ["cnpy-set-plan", "cnpy-set-limits", "cnpy-set-orgs-tile"]) expect(html, cls).toContain(`cnpy-surface ${cls}"`);
    expect(html).toContain('data-skel="set-plan"');
    expect(html).toContain('data-skel="set-limits"');
    expect(html).not.toMatch(/data-act="orgBilling/);
  });
});

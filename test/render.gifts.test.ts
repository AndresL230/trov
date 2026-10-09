/**
 * The screens of a GIFTED plan (0048_plan_gifts), as markup: Platform's Plan section ("Gift a plan", then
 * "Gifted until <date>" with Extend and End now), the gift dialog and its confirmation, "Free for" on Grant
 * an organization, and the line the org's own people read in Org settings › General › Plan.
 */
import { describe, it, expect } from "vitest";
import { planBlock, giftNote, initialOrgBillingUi } from "../web/src/org-plan";
import {
  accessDialogs, accessTab, grantModal, grantSentence, giftModal, giftEndModal, giftCopy, giftDraftEnd, giftLengthOf, giftOverrides, giftPlanFor, giftLeftWords,
  orgPlanSection, planModal, planSourceWord, canGift, blankGrant, blankLimits, initialAccess, type AccessState, type GiftDraft,
} from "../web/src/platform-access";
import { orgPickerView, createOrgModal, blankCreateOrg, initialOrgsUi } from "../web/src/org-picker";
import { PLANS, resolveEntitlements, type MyGrant, type OrgPlanView, type PlatformGrant, type PlatformOrgPlan, type PlanId } from "@shared/plans";
import { billingDate, type OrgBillingView, type PlatformOrgBilling } from "@shared/billing";
import type { MyOrgsResponse } from "@shared/orgs";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-08T12:00:00.000Z");
const inDays = (n: number, from: number = Date.now()): string => new Date(from + n * DAY).toISOString();
const sources = import.meta.glob(["../web/src/org-plan.ts", "../web/src/platform-access.ts", "../web/src/platform-access-actions.ts"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const orgPlan = (plan: PlanId = "team", o: Partial<PlatformOrgPlan> = {}): PlatformOrgPlan => ({ plan, overrides: {}, status: "active", source: "granted", entitlements: resolveEntitlements(plan, o.overrides ?? {}), seats_used: 7, gift: null, ...o });
const paid = (o: Partial<PlatformOrgBilling> = {}): PlatformOrgBilling => ({
  customer_id: "cus_1", subscription_id: "sub_1", stripe_status: "active", plan: "team", ended: false, seats: 5, interval: "month", period_end: "2027-01-15T08:00:00.000Z",
  cancel_at_period_end: false, pinned: false, livemode: false, dashboard_url: "https://dashboard.stripe.com/test/customers/cus_1", ...o,
});
const section = (p: PlatformOrgPlan) => orgPlanSection({ slug: "acme", name: "Acme", plan: p }, 0);
const draft = (o: Partial<GiftDraft> = {}): GiftDraft => ({ slug: "acme", name: "Acme", current: orgPlan("enterprise"), mode: "give", plan: "team", seats: "", length: "60", date: "", confirm: false, busy: false, error: null, ...o });
const access = (o: Partial<AccessState> = {}): AccessState => ({ ...initialAccess(), grants: { status: "ok", data: [] }, ...o });
const pg = (o: Partial<PlatformGrant> = {}): PlatformGrant => ({
  id: 9, handle: null, github_login: "nova-dev", email: null, plan: "team", overrides: {}, note: null, source: "granted", granted_by: "andres", gift_days: null,
  created_at: "2026-10-06T09:00:00.000Z", expires_at: null, status: "unused", used_at: null, used_by: null, org: null, revoked_at: null, revoked_by: null,
  mail_status: null, mail_at: null, mail_error: null, ...o,
});
const view = (plan: PlanId = "team", o: Partial<OrgPlanView> = {}): OrgPlanView => ({
  plan, name: PLANS[plan].name, description: PLANS[plan].description, status: "active", source: "granted", period_end: null, gift_until: null,
  entitlements: PLANS[plan].entitlements, overridden: [], seats: { members: 5, pending: 2 },
  usage: { seats: 7, repositories: 1, environments: 2, artifact_bytes: 1024 ** 3, agent_connections: 1, ai_summaries: 0 }, over: [], ...o,
});
const giftedBill = (o: Partial<OrgBillingView> = {}): OrgBillingView => ({
  available: true, subscribed: false, ended: false, customer: false, interval: null, seats: null, cancel_at_period_end: false, pinned: false, upgrade_to: ["team"], gifted: true, ...o,
});
const block = (v: OrgPlanView, role: "owner" | "admin" | "member" = "owner") => planBlock({ status: "ok", data: v }, role, initialOrgBillingUi());
/** The Plan tile alone (the first of the block's two sections). */
const planTile = (html: string): string => html.slice(0, html.indexOf("cnpy-org-gen-limits"));

describe("Platform › an organization's Plan section — a gift", () => {
  it("offers Gift a plan beside Change plan on an org nobody pays for", () => {
    const html = section(orgPlan("enterprise"));
    expect(html.match(/data-act="platGiftOpen"/g)).toHaveLength(1);
    expect(html).toContain(">Gift a plan</button>");
    expect(html).toContain(">Change plan</button>");
    expect(html).not.toContain("data-plat-gift=");
    expect(html).toContain("Granted by Trov: nobody pays for this plan through Stripe.");
  });

  it("not on an org with a live subscription; again once that subscription has ended", () => {
    expect(canGift(orgPlan("team", { source: "billing", billing: paid() }))).toBe(false);
    expect(section(orgPlan("team", { source: "billing", billing: paid() }))).not.toContain("platGiftOpen");
    expect(canGift(orgPlan("free", { source: "billing", billing: paid({ ended: true, stripe_status: "canceled" }) }))).toBe(true);
    expect(section(orgPlan("free", { source: "billing", billing: paid({ ended: true, stripe_status: "canceled" }) }))).toContain("platGiftOpen");
  });

  it("a gifted org says until when, how long is left and what happens then, with Extend and End now", () => {
    const until = inDays(60);
    const html = section(orgPlan("team", { gift: { until } }));
    expect(html).toContain('data-plat-gift="on"');
    expect(html).toContain(`Gifted until ${billingDate(until)}`);
    expect(html).toContain("60 days left. Nobody pays for it. Then it moves to Free by itself; nothing is deleted.");
    expect(html.match(/data-act="platGiftExtendOpen"/g)).toHaveLength(1);
    expect(html.match(/data-act="platGiftEndArm"/g)).toHaveLength(1);
    expect(html).toContain(">Extend</button>");
    expect(html).toContain(">End now</button>");
    expect(html).toContain(">Change gift</button>");
    expect(html).not.toContain("Granted by Trov: nobody pays");
  });

  it("is amber in its last seven days", () => {
    expect(section(orgPlan("team", { gift: { until: inDays(8) } }))).toContain('data-plat-gift="on"');
    const soon = section(orgPlan("team", { gift: { until: inDays(6.5) } }));
    expect(soon).toContain('data-plat-gift="soon"');
    expect(soon).toMatch(/color:var\(--amber\)">Gifted until/);
    expect(giftLeftWords(inDays(1, NOW), NOW)).toBe("1 day left");
    expect(giftLeftWords(inDays(-1, NOW), NOW)).toBe("ending now");
  });

  it("the Organizations list says a plan is a gift and when it ends", () => {
    expect(planSourceWord(orgPlan("team", { gift: { until: "2026-12-07T12:00:00.000Z" } }))).toBe("gift until 7 December 2026");
    expect(planSourceWord(orgPlan("team"))).toBe("granted");
  });

  it("Change plan on a gifted org says the plan set there has no end", () => {
    const html = planModal({ slug: "acme", name: "Acme", current: orgPlan("team", { gift: { until: "2026-12-07T12:00:00.000Z" } }), artifactBytes: 0, plan: "team", limits: blankLimits(), confirm: false, busy: false, error: null });
    expect(html).toContain("data-plat-plan-gift");
    expect(html).toContain("Its plan is a gift until 7 December 2026. A plan you set here has no end: the gift is cleared, and nothing moves it to Free.");
  });
});

describe("Gift a plan — the dialog", () => {
  it("picks the plan (never Free), optional seats, and a length from ONE segmented switch: five presets and a date", () => {
    const html = giftModal(draft(), undefined, NOW);
    expect(html).toContain("Gift Acme a plan");
    expect(html).toContain('data-seg="plat-gift-len"');
    const seg = html.slice(html.indexOf('data-seg="plat-gift-len"'), html.indexOf("data-plat-gift-until"));
    expect([...seg.matchAll(/data-arg="([^"]+)"/g)].map((m) => m[1])).toEqual(["30", "90", "180", "365", "date"]); // the picked one (60) is inert
    expect([...seg.matchAll(/aria-pressed="(true|false)"/g)].map((m) => m[1])).toEqual(["false", "true", "false", "false", "false", "false"]);
    expect(html).toContain('id="plat-gift-seats"');
    expect(html).toContain("Free until <strong");
    expect(html).toContain(billingDate(inDays(60, NOW)));
    expect(html).not.toMatch(/<select/);
    expect(html).not.toContain('type="date"');
    expect(giftPlanFor("free")).toBe("team");
    expect(giftPlanFor("enterprise")).toBe("enterprise");
    expect(giftPlanFor("personal")).toBe("team");
  });

  it("“Date” shows a date field bounded to tomorrow … three years", () => {
    const html = giftModal(draft({ length: "date", date: "" }), undefined, NOW);
    expect(html).toMatch(/<input id="plat-gift-date" type="date"[^>]*min="2026-10-09"[^>]*max="2029-10-07"/);
    expect(html).toContain("The gift runs to the end of the day you pick (UTC).");
    expect(giftLengthOf({ length: "date", date: "" })).toEqual({ error: "Pick the date the gift ends." });
    expect(giftLengthOf({ length: "date", date: "2026-12-31" })).toEqual({ length: { until: "2026-12-31" } });
    expect(giftLengthOf({ length: "90", date: "2026-12-31" })).toEqual({ length: { days: 90 } });
    expect(giftDraftEnd(draft({ length: "date", date: "2026-12-31" }), NOW)).toBe("2026-12-31T23:59:59.999Z");
    expect(giftDraftEnd(draft({ length: "date", date: "2026-10-01" }), NOW)).toBeNull();
  });

  it("the seats field: blank keeps what is there, a number sets seats and keeps the org's other limits on the same plan", () => {
    expect(giftOverrides(draft())).toEqual({ overrides: undefined });
    expect(giftOverrides(draft({ seats: "12" }))).toEqual({ overrides: { seats: 12 } });
    expect(giftOverrides(draft({ seats: "12", plan: "enterprise", current: orgPlan("enterprise", { overrides: { repositories: 20 } }) }))).toEqual({ overrides: { repositories: 20, seats: 12 } });
    expect(giftOverrides(draft({ seats: "0" }))).toHaveProperty("error");
    expect(giftOverrides(draft({ seats: "many" }))).toHaveProperty("error");
  });

  it("the confirmation is the app's confirm modal and says what happens when the gift ends", () => {
    const d = draft({ seats: "12", confirm: true });
    const html = giftModal(d, undefined, NOW);
    expect(html).toContain("data-confirm-dialog");
    expect(html).toContain('data-confirm-act="platGiftGo"');
    expect(html).toContain('data-confirm-cancel="platGiftBack"');
    expect(html).toContain("Give Acme Pro free until 7 December 2026?");
    const copy = giftCopy(d, inDays(60, NOW));
    expect(copy.body).toBe("It goes on Pro with 12 seats today and nobody pays for it. On 7 December 2026 it moves to Free by itself. Nothing is deleted and nobody loses access; anything it has over a Free limit stays, and no more of that kind can be added until it is back under. Until then you can extend the gift or end it, and its owner can start paying to keep a plan.");
    expect(copy.confirm).toBe("Give plan");
    // An end that is not valid never reaches the confirmation: the form stays.
    expect(giftModal(draft({ length: "date", date: "", confirm: true }), undefined, NOW)).not.toContain("data-confirm-dialog");
  });

  it("Extend keeps the plan: only the length, counted from the gift's current end", () => {
    const current = orgPlan("team", { gift: { until: "2026-12-07T12:00:00.000Z" } });
    const d = draft({ mode: "extend", current, length: "30" });
    const html = giftModal(d, undefined, NOW);
    expect(html).toContain("Extend Acme's gift");
    expect(html).not.toContain('id="plat-gift-seats"');
    expect(html).not.toContain("plat-gift-plan");
    expect(html).toContain("A length is added to that date; a date replaces it.");
    expect(giftDraftEnd(d, NOW)).toBe("2027-01-06T12:00:00.000Z");
    expect(giftCopy(d, "2027-01-06T12:00:00.000Z")).toMatchObject({ title: "Extend Acme's gift to 6 January 2027?", confirm: "Extend gift" });
  });

  it("End now is a destructive confirmation that says nothing is deleted", () => {
    const html = giftEndModal({ name: "Acme", plan: orgPlan("team", { gift: { until: "2026-12-07T12:00:00.000Z" } }) }, false);
    expect(html).toContain("data-confirm-dialog");
    expect(html).toContain("End Acme&#39;s gift now?");
    expect(html).toContain("It moves from Pro to Free at once, instead of on 7 December 2026. Nothing is deleted and nobody loses access");
    expect(html).toContain('data-confirm-act="platGiftEndGo"');
  });

  it("the page's dialogs: the gift dialog, then its confirmation, then End now — only on the org's page", () => {
    const org = { name: "Acme", plan: orgPlan("team", { gift: { until: inDays(30) } }) };
    expect(accessDialogs(access({ gift: draft() }), "platformorg", { open: null, active: 0 } as never, org)).toContain('id="plat-gift"');
    expect(accessDialogs(access({ gift: draft({ confirm: true }) }), "platformorg", { open: null, active: 0 } as never, org)).toContain('id="plat-gift-confirm"');
    expect(accessDialogs(access({ giftEnd: { busy: false } }), "platformorg", { open: null, active: 0 } as never, org)).toContain('id="plat-gift-end"');
    expect(accessDialogs(access({ gift: draft(), giftEnd: { busy: false } }), "platform", { open: null, active: 0 } as never, org)).toBe("");
  });

  it("follows the web rules: no native select, no window.confirm, no button inside a button", () => {
    for (const [file, src] of Object.entries(sources)) {
      expect(src, file).not.toMatch(/<select/);
      expect(src, file).not.toMatch(/window\.confirm|\bconfirm\(/);
    }
    for (const html of [section(orgPlan("team", { gift: { until: inDays(3) } })), giftModal(draft(), undefined, NOW), giftModal(draft({ mode: "extend", current: orgPlan("team", { gift: { until: inDays(3) } }) }), undefined, NOW)]) {
      expect(html).not.toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*<button/);
    }
  });
});

describe("Platform › Access › Grant an organization — Free for", () => {
  it("offers the optional length, and says the clock starts when the org is created", () => {
    const none = grantModal(blankGrant());
    expect(none).toContain("data-plat-grant-gift");
    expect(none).toContain("Free for");
    expect(none).toContain("The organization keeps this plan until you change it.");
    const three = grantModal({ ...blankGrant(), gift: "90" });
    expect(three).toContain("The clock starts the day they create the organization. After 3 months it moves to Free by itself; nothing is deleted.");
    expect(grantModal({ ...blankGrant(), plan: "free", gift: "90" })).toContain("Free has no end to set.");
    expect(none).not.toMatch(/<select/);
  });

  it("a gifted grant says so in its row and in the sentence after it is made", () => {
    const html = accessTab(access({ grants: { status: "ok", data: [pg({ gift_days: 90 }), pg({ id: 10 })] } }));
    expect(html.match(/data-grant-gift/g)).toHaveLength(1);
    expect(html).toContain("free for 3 months, then Free");
    expect(grantSentence(pg({ gift_days: 45 }))).toBe("nova-dev can now set up one Pro organization. It is free for 45 days from the day they create it, then it moves to Free. No email is sent for a GitHub login: tell them it is waiting.");
    expect(grantSentence(pg())).toBe("nova-dev can now set up one Pro organization. No email is sent for a GitHub login: tell them it is waiting.");
  });

  it("the grantee reads it before and while creating the organization", () => {
    const g: MyGrant = { id: 4, plan: "team", plan_name: "Pro", entitlements: PLANS.team.entitlements, granted_by: "andres", created_at: "2026-10-05T09:00:00.000Z", expires_at: null, gift_days: 90 };
    const orgs: MyOrgsResponse = { orgs: [], invites: [], superadmin: false, can_create: true, grants: [g], free: { can_create: false, owned: null } };
    const me = { handle: "ines", name: "Ines Vidal", identities: [{ provider: "github" as const, label: "ines-vidal" }] };
    expect(orgPickerView({ me, mine: [], orgs, status: "ok", ui: initialOrgsUi(), hash: "" })).toContain("For up to 50 people, free for 3 months. You choose its name and become its owner.");
    expect(createOrgModal(blankCreateOrg(g))).toContain("It is free for 3 months from today, a gift from Trov; after that it moves to Free, and nothing is deleted.");
    expect(createOrgModal(blankCreateOrg({ ...g, gift_days: null }))).not.toContain("a gift from Trov");
  });
});

describe("Org settings › General › Plan — what the org's people read", () => {
  it("says until when it is free, that it is a gift, and what happens after — to everyone", () => {
    const until = inDays(60);
    const sentence = `Free until ${billingDate(until)}, a gift from Trov. After that this organization moves to Free; nothing is deleted.`;
    for (const role of ["owner", "admin", "member"] as const) {
      const tile = planTile(block(view("team", { gift_until: until }), role));
      expect(tile, role).toContain(sentence);
      expect(tile, role).toContain('data-plan-gift="on"');
      expect(tile, role).not.toContain("cnpy-plan-note");
    }
    expect(planTile(block(view("team", { gift_until: until }), "owner"))).toContain("To keep or change your plan, contact Trov.");
  });

  it("is the amber note in the last seven days, with the days left", () => {
    expect(giftNote(view("team", { gift_until: inDays(8, NOW) }), NOW)).toContain('data-plan-gift="on"');
    const soon = giftNote(view("team", { gift_until: inDays(7, NOW) }), NOW);
    expect(soon).toContain('data-plan-gift="soon"');
    expect(soon).toContain('class="cnpy-plan-note"');
    expect(soon).toContain('role="status"');
    expect(soon).toContain("7 days left.</strong> Free until 15 October 2026, a gift from Trov. After that this organization moves to Free; nothing is deleted.");
    expect(giftNote(view("team", { gift_until: inDays(0.5, NOW) }), NOW)).toContain("1 day left.");
    // Past its end, before the next tick moves it: it says so rather than naming a date that has gone.
    expect(giftNote(view("team", { gift_until: inDays(-0.01, NOW) }), NOW)).toContain("The gift from Trov has ended, and this organization is moving to Free. Nothing is deleted.");
  });

  it("says nothing for a plan that is not a gift, an unreadable date, or an org that pays", () => {
    expect(giftNote(view("team"), NOW)).toBe("");
    expect(giftNote(view("team", { gift_until: "not a date" }), NOW)).toBe("");
    expect(giftNote(view("team", { gift_until: inDays(30, NOW), source: "billing" }), NOW)).toBe("");
    expect(block(view("team"))).not.toContain("data-plan-gift");
  });

  it("gives the OWNER the way to keep the plan by paying, where billing can work", () => {
    const v = view("team", { gift_until: inDays(20), billing: giftedBill() });
    const tile = planTile(block(v, "owner"));
    expect(tile).toContain('data-org-billing="gift"');
    expect(tile.match(/data-act="orgBillingUpgrade"/g)).toHaveLength(1);
    expect(tile).toContain("Keep Pro by paying");
    expect(tile).toContain("To keep Pro after that, start paying before the gift ends.");
    expect(tile).toContain("Trov never sees your card.");
    // Not the Free org's sentence, and not for anyone but the owner.
    expect(tile).not.toContain("It raises every limit below.");
    for (const role of ["admin", "member"] as const) {
      const other = planTile(block(v, role));
      expect(other, role).not.toContain("orgBillingUpgrade");
      expect(other, role).toContain("a gift from Trov");
    }
    // A gifted Enterprise org: paying means Pro, and the tile says so.
    const ent = planTile(block(view("enterprise", { gift_until: inDays(20), billing: giftedBill() }), "owner"));
    expect(ent).toContain("Pay for Pro");
    expect(ent).toContain("To keep Enterprise, contact Trov.");
  });

  it("offers no payment where billing is off or nothing is on sale: only the line", () => {
    for (const b of [giftedBill({ available: false, upgrade_to: [] }), giftedBill({ upgrade_to: [] })]) {
      const tile = planTile(block(view("team", { gift_until: inDays(20), billing: b }), "owner"));
      expect(tile).not.toContain("orgBillingUpgrade");
      expect(tile).not.toContain("data-org-billing");
      expect(tile).toContain("a gift from Trov");
      expect(tile).toContain("To keep or change your plan, contact Trov.");
    }
  });

  it("leaves General's two tiles as they are: Plan, then Limits", () => {
    const html = block(view("team", { gift_until: inDays(3), billing: giftedBill() }));
    expect(html.match(/<section/g)).toHaveLength(2);
    expect(html.indexOf("cnpy-org-gen-plan")).toBeLessThan(html.indexOf("cnpy-org-gen-limits"));
    expect(html).not.toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*<button/);
  });
});

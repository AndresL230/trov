/**
 * The public pricing surface (web/src/pricing.ts): the landing's last section and the
 * standalone /pricing page, one render. It restates nothing — plans come from
 * shared/plans.ts, prices from shared/pricing.ts — and a plan with no announced price
 * never shows a number or a purchase link.
 */
import { describe, it, expect } from "vitest";
import { PLANS, PLAN_IDS, LIMIT_KEYS, LIMITS, formatLimit, type PlanDef, type PlanId } from "../shared/plans";
import { PRICING, canPurchase, formatPrice, hasYearly, purchaseHref, type PlanPricing } from "../shared/pricing";
import { EVERY_PLAN, PRICING_TITLE, earlyAccessHref, pricingQuestions, pricingSection, pricingView, talkHref, waitlistHref } from "../web/src/pricing";
import { landingView } from "../web/src/landing";
import { siteFooter, SITE_CONTACT } from "../web/src/site-chrome";
import { LEGAL_CONTACT } from "../web/src/legal";

/** Example prices — a test double; the committed table announces none. */
const priced = (over: Partial<Record<PlanId, Partial<PlanPricing>>> = {}): Record<PlanId, PlanPricing> => ({
  personal: { ...PRICING.personal, price: 8, ...over.personal },
  team: { ...PRICING.team, price: 40, ...over.team },
  enterprise: { ...PRICING.enterprise, ...over.enterprise },
});
/** One plan's card, cut out of a render. */
const card = (html: string, id: PlanId) => html.slice(html.indexOf(`aria-labelledby="site-plan-${id}"`)).split("</article>")[0];
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("shared/pricing.ts", () => {
  it("announces no price: what ships says so instead of naming a number", () => {
    for (const id of PLAN_IDS) {
      expect(PRICING[id].price).toBeNull();
      expect(PRICING[id].yearly).toBeNull();
      expect(canPurchase(PRICING[id])).toBe(false);
    }
    expect(PRICING.personal.selfServe).toBe(true);
    expect(PRICING.team.selfServe).toBe(true);
    expect(PRICING.enterprise.selfServe).toBe(false);
  });

  it("the purchase link is the billing route, with the interval only for a yearly purchase", () => {
    expect(purchaseHref("personal")).toBe("/billing/start?plan=personal");
    expect(purchaseHref("team", "month")).toBe("/billing/start?plan=team");
    expect(purchaseHref("team", "year")).toBe("/billing/start?plan=team&interval=year");
  });

  it("a plan is purchasable only when it is self-serve AND has a price", () => {
    expect(canPurchase({ ...PRICING.team, price: 40 })).toBe(true);
    expect(canPurchase({ ...PRICING.enterprise, price: 400 })).toBe(false);
    expect(hasYearly({ ...PRICING.team, price: 40, yearly: 400 })).toBe(true);
    expect(hasYearly({ ...PRICING.team, price: null, yearly: 400 })).toBe(false);
    expect(formatPrice(12)).toBe("$12");
    expect(formatPrice(12.5)).toBe("$12.50");
  });
});

describe("pricing — the three plans come from shared/plans.ts", () => {
  const html = pricingSection();

  it("renders each plan's name, description and every limit, in order", () => {
    for (const id of PLAN_IDS) {
      const c = card(html, id);
      expect(c).toContain(`>${PLANS[id].name}</h3>`);
      expect(c).toContain(`<p class="site-plan-for">${PLANS[id].description.replace(/'/g, "&#39;")}</p>`);
      for (const k of LIMIT_KEYS) expect(c).toContain(`<b>${formatLimit(k, PLANS[id].entitlements[k])}</b>`);
    }
    expect(html.indexOf("site-plan-personal")).toBeLessThan(html.indexOf("site-plan-team"));
    expect(html.indexOf("site-plan-team")).toBeLessThan(html.indexOf("site-plan-enterprise"));
    expect(card(html, "personal")).toContain("<b>1</b> seat</li>");
    expect(card(html, "team")).toContain("<b>10</b> seats</li>");
    expect(card(html, "team")).toContain("agent connections per person</li>");
  });

  it("follows a changed number, name or description — nothing is typed twice", () => {
    const plans: Record<PlanId, PlanDef> = {
      ...PLANS,
      team: { ...PLANS.team, name: "Crew", description: "A crew of up to 25 people.", entitlements: { ...PLANS.team.entitlements, seats: 25, repositories: 1, artifact_bytes: 3 * 1024 * 1024 * 1024 } },
    };
    const out = pricingSection({ plans });
    const c = card(out, "team");
    expect(c).toContain(">Crew</h3>");
    expect(c).toContain("A crew of up to 25 people.");
    expect(c).toContain("<b>25</b> seats</li>");
    expect(c).toContain("<b>1</b> repository</li>");
    expect(c).toContain("<b>3 GB</b> artifact storage</li>");
    expect(out).toContain('<td role="cell" data-plan="Crew">25</td>');
    expect(out).toContain('<td role="cell" data-plan="Crew">3 GB</td>');
    expect(out).not.toContain('data-plan="Team"');
    expect(out).toContain("Trov%20Crew%20plan");
  });
});

describe("pricing — no price announced (what ships)", () => {
  const html = pricingSection();

  it("shows no amount and no currency anywhere", () => {
    expect(html).not.toMatch(/[$€£¥]/);
    expect(html).not.toContain("site-plan-amt");
    expect(text(html)).not.toMatch(/\bper (month|year)\b/);
    expect(card(html, "personal")).toContain("Pricing to be announced");
    expect(card(html, "team")).toContain("Pricing to be announced");
  });

  it("each self-serve card offers the waitlist, by e-mail with the plan in the subject", () => {
    for (const id of ["personal", "team"] as const) {
      const c = card(html, id);
      expect(c).toContain(`href="${waitlistHref(PLANS[id])}"`);
      expect(c).toContain("Join the waitlist");
    }
    expect(waitlistHref(PLANS.team)).toBe(`mailto:${LEGAL_CONTACT}?subject=Trov%20Team%20plan%3A%20waitlist`);
    expect(SITE_CONTACT).toBe(LEGAL_CONTACT);
  });

  it("offers no purchase link and no interval switch", () => {
    expect(html).not.toContain("/billing/");
    expect(html).not.toContain('role="radiogroup"');
    expect(html).not.toContain("is-year");
  });

  it("no card is the accent: the one accent action is early access", () => {
    expect(html).not.toContain("is-accent");
    expect(html.match(/site-btn-accent/g)).toHaveLength(1);
    expect(html).toContain(`<a href="${earlyAccessHref()}" class="site-btn site-btn-accent"`);
    expect(html).toContain("Prices are not announced yet.");
  });
});

describe("pricing — prices announced", () => {
  it("shows the amount and its interval, and the button is the purchase link", () => {
    const html = pricingSection({ pricing: priced() });
    expect(card(html, "personal")).toContain('<span class="site-plan-amt">$8</span> <span class="site-plan-per">per month</span>');
    expect(card(html, "team")).toContain('<span class="site-plan-amt">$40</span> <span class="site-plan-per">per month</span>');
    expect(card(html, "personal")).toContain('<a href="/billing/start?plan=personal" class="site-btn site-btn-outline site-plan-cta"');
    expect(card(html, "team")).toContain('<a href="/billing/start?plan=team" class="site-btn site-btn-accent site-plan-cta"');
    expect(card(html, "team")).toContain("Choose Team");
    expect(html).not.toContain("Pricing to be announced");
    expect(html).not.toContain("waitlist");
    expect(html).not.toContain("Prices are not announced yet.");
  });

  it("has ONE accent action: the badged plan's", () => {
    const html = pricingSection({ pricing: priced() });
    expect(html.match(/site-btn-accent/g)).toHaveLength(1);
    expect(html.match(/site-plan is-accent/g)).toHaveLength(1);
    expect(html).toMatch(/class="site-st site-plan is-accent"[^>]*aria-labelledby="site-plan-team"/);
    expect(card(html, "team")).toContain("Most teams start here");
  });

  it("monthly only: no interval switch, no yearly link", () => {
    const html = pricingSection({ pricing: priced() });
    expect(html).not.toContain('role="radiogroup"');
    expect(html).not.toContain("interval=year");
  });

  it("a plan with both prices brings the switch: a radio group, monthly first, and a link per interval", () => {
    const html = pricingSection({ pricing: priced({ team: { yearly: 400 } }) });
    expect(html).toContain('role="radiogroup" aria-label="Billing interval"');
    expect(html).toContain('<input type="radio" name="site-interval" value="month" checked>Monthly');
    expect(html).toContain('<input type="radio" name="site-interval" value="year">Yearly');
    const team = card(html, "team");
    expect(team).toContain('<p class="site-plan-price is-month"><span class="site-plan-amt">$40</span> <span class="site-plan-per">per month</span></p>');
    expect(team).toContain('<p class="site-plan-price is-year"><span class="site-plan-amt">$400</span> <span class="site-plan-per">per year</span></p>');
    expect(team).toContain('href="/billing/start?plan=team" class="site-btn site-btn-accent site-plan-cta is-month"');
    expect(team).toContain('href="/billing/start?plan=team&amp;interval=year" class="site-btn site-btn-accent site-plan-cta is-year"');
    // a plan that is monthly only keeps its one price and link whichever interval is picked
    const personal = card(html, "personal");
    expect(personal).not.toContain("is-year");
    expect(personal).not.toContain("interval=year");
  });

  it("a plan still without a price keeps the waitlist beside one that has one", () => {
    const html = pricingSection({ pricing: priced({ personal: { price: null } }) });
    expect(card(html, "personal")).toContain("Pricing to be announced");
    expect(card(html, "personal")).toContain(waitlistHref(PLANS.personal));
    expect(card(html, "personal")).not.toContain("/billing/");
    expect(card(html, "team")).toContain("/billing/start?plan=team");
  });
});

describe("pricing — Enterprise is a conversation", () => {
  it("never has a purchase link, with or without a price", () => {
    for (const pricing of [PRICING, priced(), priced({ enterprise: { price: 900, yearly: 9000 } })]) {
      const c = card(pricingSection({ pricing }), "enterprise");
      expect(c).not.toContain("/billing/");
      expect(c).toContain(`href="${talkHref(PLANS.enterprise)}"`);
      expect(c).toContain("Talk to us");
    }
    expect(talkHref(PLANS.enterprise)).toBe(`mailto:${LEGAL_CONTACT}?subject=Trov%20Enterprise%20plan`);
    expect(card(pricingSection(), "enterprise")).toContain("Custom pricing");
  });
});

describe("pricing — the comparison", () => {
  const html = pricingSection();
  const table = html.slice(html.indexOf("<table"), html.indexOf("</table>"));

  it("is a real table: a column header per plan, a row header per limit", () => {
    for (const id of PLAN_IDS) expect(table).toContain(`<th role="columnheader" scope="col">${PLANS[id].name}</th>`);
    for (const k of LIMIT_KEYS) {
      expect(table).toContain(`<th role="rowheader" scope="row"><span class="site-cmp-label">${LIMITS[k].label}`);
      expect(table).toContain(`<span class="site-cmp-counts">${LIMITS[k].counts}</span>`);
    }
    expect(table.match(/<tr role="row">/g)).toHaveLength(LIMIT_KEYS.length + 1);
  });

  it("formats every value: counts, MB / GB, and Unlimited for null", () => {
    expect(table).toContain('<td role="cell" data-plan="Personal">1</td>');
    expect(table).toContain('<td role="cell" data-plan="Personal">250 MB</td>');
    expect(table).toContain('<td role="cell" data-plan="Team">5 GB</td>');
    expect(table).toContain('<td role="cell" data-plan="Enterprise">Unlimited</td>');
    expect(table).not.toContain("null");
    expect(table).toContain("Agent connections, per person");
  });

  it("lists what every plan includes, and says the by-conversation plan's limits can be set", () => {
    for (const line of EVERY_PLAN) expect(html).toContain(`<span>${line}</span>`);
    expect(html).toContain("Enterprise limits are where an organization starts");
  });
});

describe("pricing — questions say only what is true today", () => {
  const defs = PLAN_IDS.map((id) => PLANS[id]);
  const qs = pricingQuestions(defs, PRICING);
  const all = text(pricingSection() + pricingSection({ pricing: priced({ team: { yearly: 400 } }) }));

  it("answers seats, going over, changing plans, isolation, the source and Enterprise", () => {
    expect(qs.map((x) => x.q)).toEqual([
      "What counts as a seat?",
      "What happens if we go over a limit?",
      "Can we change plans?",
      "Is our data separate from other organizations?",
      "Can we read the source?",
      "How does Enterprise work?",
    ]);
    expect(qs[0].a).toContain("an invitation that has not been answered yet");
    expect(qs[1].a).toContain("Nothing is deleted and nobody is removed");
    expect(qs[4].a).toContain("AGPL-3.0");
    expect(qs[5].a).toContain(talkHref(PLANS.enterprise));
  });

  it("promises nothing the product does not do", () => {
    for (const claim of [/refund/i, /\btrial/i, /\bSLA\b/, /discount/i, /\btax/i, /money.back/i, /SOC ?2/i, /GDPR/i, /HIPAA/i, /uptime/i, /guarantee/i, /\bfree\b/i, /cancel any ?time/i]) {
      expect(all).not.toMatch(claim);
    }
    for (const word of [/seamless/i, /powerful/i, /unlock/i, /lorem/i, /\$X\b/]) expect(all).not.toMatch(word);
  });
});

describe("pricing — where it lives", () => {
  const landing = landingView({ dark: false, signInOpen: false, seen: new Set() });

  it("is the landing's last section, reached from its nav, with scroll-reveal hooks", () => {
    expect(landing).toContain('<button data-act="siteJump" data-arg="pricing" class="site-navlink">Pricing</button>');
    expect(landing).toContain('<section id="site-pricing"');
    expect(landing.indexOf('id="site-security"')).toBeLessThan(landing.indexOf('id="site-pricing"'));
    expect(landing.indexOf('id="site-pricing"')).toBeLessThan(landing.indexOf("<footer"));
    expect(landing).toContain(`<h2 class="site-price-title">${PRICING_TITLE}</h2>`);
    expect(landing).toContain('data-rv="pricing-plans"');
    // already played: rendered settled, so a rerender never replays it
    expect(landingView({ dark: false, signInOpen: false, seen: new Set(["pricing-head"]) })).toMatch(/data-rv="pricing-head" class="site-rv site-price-top is-done"/);
  });

  it("the footer links the standalone page as a path, beside Terms and Privacy", () => {
    expect(siteFooter()).toContain('<a href="/pricing">Pricing</a> · <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a>');
  });

  it("/pricing is the same render under an h1, with the way home and the shared footer", () => {
    const page = pricingView(false);
    expect(page).toContain(`<h1 class="site-price-title is-page">${PRICING_TITLE}</h1>`);
    expect(page.match(/<h1/g)).toHaveLength(1);
    expect(page).toContain(">Personal</h2>");
    expect(page).toContain("<h3>What counts as a seat?</h3>");
    expect(page).toContain('<a href="/" aria-label="Trov home"');
    expect(page).toContain(">Open Trov</a>");
    expect(page).toContain("data-site-theme");
    expect(page).toContain(siteFooter());
    expect(pricingView(true)).not.toBe(page);
    // rendered settled: nothing waits for a scroll observer the page does not run
    expect(page).not.toContain("data-rv");
    expect(page.match(/class="site-rv is-done/g)!.length).toBeGreaterThan(3);
    // same cards as the landing's section
    expect(card(page, "team").replace(/h2/g, "h3")).toBe(card(pricingSection(), "team"));
  });

  it("signed in: an unpriced plan offers the way back into the app, not a waitlist", () => {
    const html = landingView({ dark: false, signInOpen: false, signedIn: true, seen: new Set() });
    const section = html.slice(html.indexOf('id="site-pricing"'));
    for (const id of ["personal", "team"] as const) {
      expect(card(section, id)).toContain('<button type="button" data-act="siteBack" class="site-btn site-btn-outline site-plan-cta"');
      expect(card(section, id)).toContain(">Open Trov</button>");
    }
    expect(section).not.toContain("waitlist");
    expect(section).not.toContain("Get early access");
    expect(card(section, "enterprise")).toContain("Talk to us");
  });

  it("signed in with prices: the purchase links still work", () => {
    const html = pricingSection({ signedIn: true, pricing: priced() });
    expect(card(html, "team")).toContain('href="/billing/start?plan=team"');
    expect(html).not.toContain("Open Trov");
  });
});

/**
 * The public pricing surface (web/src/pricing.ts): the landing's last section and the
 * standalone /pricing page, one render. It restates nothing — plans come from
 * shared/plans.ts, prices from shared/pricing.ts — it shows only the plans on offer (Free,
 * Pro, Enterprise; legacy Personal never), Free starts an organization instead of a purchase,
 * Pro is bought per seat, and a plan with no announced price never shows a number or a
 * purchase link.
 */
import { describe, it, expect } from "vitest";
import { OFFERED_PLAN_IDS, PLANS, PLAN_IDS, LIMIT_KEYS, LIMITS, formatLimit, type PlanDef, type PlanId } from "../shared/plans";
import { PRICING, canPurchase, canPurchasePlan, formatPrice, hasYearly, isFreePrice, purchaseHref, type PlanPricing } from "../shared/pricing";
import { BILLING_INTERVALS, BILLING_START_PATH, PRICING_PATH, PURCHASABLE_PLANS, billingStartHref, isPurchasablePlan } from "../shared/billing";
import pricingHtml from "../web/pricing.html?raw";
import viteConfig from "../web/vite.config.ts?raw";
import trovCssRaw from "../web/src/trov.css?raw";
import { EVERY_PLAN, FREE_START_HREF, PRICING_TITLE, earlyAccessHref, pricingQuestions, pricingSection, pricingView, talkHref, waitlistHref } from "../web/src/pricing";
import { landingView } from "../web/src/landing";
import { siteFooter, SITE_CONTACT } from "../web/src/site-chrome";
import { LEGAL_CONTACT } from "../web/src/legal";

/** The shipped table with Pro at another price — a test double: the page follows whatever it says. */
const priced = (over: Partial<Record<PlanId, Partial<PlanPricing>>> = {}): Record<PlanId, PlanPricing> => ({
  free: { ...PRICING.free, ...over.free },
  personal: { ...PRICING.personal, ...over.personal },
  team: { ...PRICING.team, price: 40, ...over.team },
  enterprise: { ...PRICING.enterprise, ...over.enterprise },
});
/** No paid price announced: Pro without a number (Free still costs nothing) — a test double. */
const unpriced = () => priced({ team: { price: null } });
/** One plan's card, cut out of a render. */
const card = (html: string, id: PlanId) => html.slice(html.indexOf(`aria-labelledby="site-plan-${id}"`)).split("</article>")[0];
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("shared/pricing.ts", () => {
  it("what ships: Free costs nothing, Pro is $10 per seat a month, Enterprise is custom, legacy Personal is not sold", () => {
    expect(PRICING.free).toMatchObject({ price: 0, yearly: null, badge: null, selfServe: true });
    expect(isFreePrice(PRICING.free)).toBe(true);
    expect(canPurchase(PRICING.free)).toBe(false);
    expect(PRICING.team).toMatchObject({ price: 10, per: "per seat / month", yearly: null, yearlyPer: "per seat / year", badge: "Most teams start here", selfServe: true });
    expect(canPurchase(PRICING.team)).toBe(true);
    expect(isFreePrice(PRICING.team)).toBe(false);
    expect(PRICING.personal).toMatchObject({ price: null, selfServe: false });
    expect(canPurchase(PRICING.personal)).toBe(false);
    expect(PRICING.enterprise).toMatchObject({ price: null, selfServe: false });
    expect(canPurchase(PRICING.enterprise)).toBe(false);
    // monthly only: no plan is sold by the year yet
    for (const id of PLAN_IDS) expect(PRICING[id].yearly, id).toBeNull();
  });

  it("the purchase link is the billing route, with the interval only for a yearly purchase", () => {
    expect(purchaseHref("team")).toBe("/billing/start?plan=team");
    expect(purchaseHref("team", "month")).toBe("/billing/start?plan=team");
    expect(purchaseHref("team", "year")).toBe("/billing/start?plan=team&interval=year");
  });

  it("the purchase link IS billing's start link, and billing's way back to the plans is this page", () => {
    expect(PURCHASABLE_PLANS).toEqual(["team"]);
    for (const plan of PURCHASABLE_PLANS) for (const interval of BILLING_INTERVALS) {
      expect(purchaseHref(plan, interval)).toBe(billingStartHref(plan, interval));
      expect(purchaseHref(plan, interval).startsWith(`${BILLING_START_PATH}?plan=${plan}`)).toBe(true);
    }
    expect(PRICING_PATH).toBe("/pricing");
    expect(siteFooter()).toContain(`<a href="${PRICING_PATH}">Pricing</a>`);
    // the page PRICING_PATH names is a real build input (web/vite.config.ts → dist/pricing.html)
    expect(viteConfig).toMatch(/pricing: path\.join\(__dirname, "pricing\.html"\)/);
    expect(pricingHtml).toContain("/src/pricing-page.ts");
    // the plans the page may sell are exactly the ones billing sells; the only other self-serve plan is Free
    for (const id of PLAN_IDS) {
      expect(canPurchasePlan(id, PRICING[id]), id).toBe(isPurchasablePlan(id));
      expect(PRICING[id].selfServe, id).toBe(isPurchasablePlan(id) || isFreePrice(PRICING[id]));
      expect(canPurchasePlan(id, { ...PRICING[id], price: 9 }), id).toBe(isPurchasablePlan(id));
      expect(canPurchasePlan(id, { ...PRICING[id], selfServe: true, price: 9 }), id).toBe(isPurchasablePlan(id));
    }
  });

  it("with the prices that ship, the one billing link anywhere public is Pro's: not Free's, not Enterprise's, signed in or out", () => {
    for (const html of [
      pricingSection(), pricingSection({ signedIn: true }), pricingView(false), pricingView(true),
      landingView({ dark: false, signInOpen: false, seen: new Set() }),
      landingView({ dark: false, signInOpen: false, signedIn: true, seen: new Set() }),
      landingView({ dark: true, signInOpen: true, seen: new Set() }),
    ]) {
      expect(html.match(/\/billing/g)).toHaveLength(1);
      expect(html).toContain(`href="${purchaseHref("team")}"`);
      expect(html).toContain(">Choose Pro</a>");
      expect(html).not.toMatch(/>Choose (Free|Personal|Enterprise)/);
    }
    expect(text(pricingView(false))).not.toContain("Pricing to be announced");
    expect(text(pricingView(false)).match(/Custom pricing/g)).toHaveLength(1);
  });

  it("a plan is purchasable only when it is self-serve AND has a price above nothing", () => {
    expect(canPurchase({ ...PRICING.team, price: 40 })).toBe(true);
    expect(canPurchase({ ...PRICING.team, price: 0 })).toBe(false);
    expect(canPurchase({ ...PRICING.team, price: null })).toBe(false);
    expect(canPurchase({ ...PRICING.enterprise, price: 400 })).toBe(false);
    // Free is a self-serve plan at 0 — never a custom one at 0, never an unannounced one
    expect(isFreePrice({ ...PRICING.enterprise, price: 0 })).toBe(false);
    expect(isFreePrice({ ...PRICING.team, price: null })).toBe(false);
    expect(hasYearly({ ...PRICING.team, price: 40, yearly: 400 })).toBe(true);
    expect(hasYearly({ ...PRICING.team, price: null, yearly: 400 })).toBe(false);
    expect(hasYearly({ ...PRICING.free, yearly: 0 })).toBe(false);
    expect(formatPrice(12)).toBe("$12");
    expect(formatPrice(12.5)).toBe("$12.50");
  });
});

describe("pricing — the plans on offer come from shared/plans.ts", () => {
  const html = pricingSection();

  it("renders each offered plan's name, description and every limit, in order — and Personal not at all", () => {
    expect(OFFERED_PLAN_IDS).toEqual(["free", "team", "enterprise"]);
    expect(PLANS.personal.offered).toBe(false);
    expect(html.match(/<article /g)).toHaveLength(OFFERED_PLAN_IDS.length);
    for (const id of OFFERED_PLAN_IDS) {
      const c = card(html, id);
      expect(c).toContain(`>${PLANS[id].name}</h3>`);
      expect(c).toContain(`<p class="site-plan-for">${PLANS[id].description.replace(/'/g, "&#39;")}</p>`);
      for (const k of LIMIT_KEYS) {
        const v = formatLimit(k, PLANS[id].entitlements[k]);
        // a plan sold per seat (Pro) shows its seat cap as the most it can buy
        expect(c).toContain(`<b>${id === "team" && k === "seats" ? `Up to ${v}` : v}</b>`);
      }
    }
    expect(html).not.toContain("site-plan-personal");
    expect(html.indexOf("site-plan-free")).toBeLessThan(html.indexOf("site-plan-team"));
    expect(html.indexOf("site-plan-team")).toBeLessThan(html.indexOf("site-plan-enterprise"));
    expect(card(html, "free")).toContain("<b>3</b> seats</li>");
    expect(card(html, "team")).toContain("<b>Up to 50</b> seats</li>");
    expect(card(html, "team")).toContain("agent connections per person</li>");
  });

  it("the monthly AI-summaries allowance reads as one: thousands separated, per month — and no period on an unlimited one", () => {
    expect(card(html, "free")).toContain("<li><b>300</b> AI summaries per month</li>");
    expect(card(html, "team")).toContain("<li><b>3,000</b> AI summaries per month</li>");
    expect(card(html, "enterprise")).toContain("<li><b>Unlimited</b> AI summaries</li>");
    expect(html).not.toContain("3000");
    // A changed allowance follows, like every other number.
    const out = pricingSection({ plans: { ...PLANS, free: { ...PLANS.free, entitlements: { ...PLANS.free.entitlements, ai_summaries: 1 } }, team: { ...PLANS.team, entitlements: { ...PLANS.team.entitlements, ai_summaries: 1250000 } } } });
    expect(card(out, "free")).toContain("<li><b>1</b> AI summary per month</li>");
    expect(card(out, "team")).toContain("<li><b>1,250,000</b> AI summaries per month</li>");
  });

  it("follows a changed number, name or description — nothing is typed twice", () => {
    const plans: Record<PlanId, PlanDef> = {
      ...PLANS,
      team: { ...PLANS.team, name: "Crew", description: "A crew, paid per head.", entitlements: { ...PLANS.team.entitlements, seats: 25, repositories: 1, artifact_bytes: 3 * 1024 * 1024 * 1024 } },
    };
    const out = pricingSection({ plans });
    const c = card(out, "team");
    expect(c).toContain(">Crew</h3>");
    expect(c).toContain("A crew, paid per head.");
    expect(c).toContain("<b>Up to 25</b> seats</li>");
    expect(c).toContain("<b>1</b> repository</li>");
    expect(c).toContain("<b>3 GB</b> artifact storage</li>");
    expect(c).toContain(">Choose Crew</a>");
    expect(out).not.toContain("Choose Pro");
    expect(out).toContain("How does Crew pricing work?");
    expect(out).toContain(", up to 25.");
  });

  it("whether a plan shows is the table's `offered`, not the page's choice", () => {
    const out = pricingSection({ plans: { ...PLANS, free: { ...PLANS.free, offered: false }, personal: { ...PLANS.personal, offered: true } } });
    expect(out).not.toContain("site-plan-free");
    expect(out).toContain('aria-labelledby="site-plan-personal"');
    expect(out.indexOf("site-plan-personal")).toBeLessThan(out.indexOf("site-plan-team"));
  });
});

describe("pricing — what ships: Free, Pro per seat, Enterprise by conversation", () => {
  const html = pricingSection();

  it("Free says Free, with no interval, and its button starts an organization: Trov's front door signed out, the way back in signed in", () => {
    const free = card(html, "free");
    expect(free).toContain('<p class="site-plan-price"><span class="site-plan-amt">Free</span></p>');
    expect(free).not.toContain("site-plan-per");
    expect(free).not.toMatch(/[$€£¥]/);
    expect(FREE_START_HREF).toBe("/");
    expect(free).toContain(`<a href="${FREE_START_HREF}" class="site-btn site-btn-outline site-plan-cta" style="border-radius:9px;justify-content:center">Start for free<span class="site-vh"> on the Free plan</span></a>`);
    expect(free).not.toContain("/billing/");
    expect(free).not.toContain("waitlist");
    const signedIn = card(pricingSection({ signedIn: true }), "free");
    expect(signedIn).toContain('<button type="button" data-act="siteBack" class="site-btn site-btn-outline site-plan-cta"');
    expect(signedIn).toContain(">Open Trov</button>");
    expect(signedIn).not.toContain("Start for free");
  });

  it("Pro is $10 per seat a month, up to 50 seats, and its button is the page's one accent: the purchase link", () => {
    const pro = card(html, "team");
    expect(pro).toContain(">Pro</h3>");
    expect(pro).toContain("Most teams start here");
    expect(pro).toContain('<p class="site-plan-price"><span class="site-plan-amt">$10</span> <span class="site-plan-per">per seat / month</span></p>');
    expect(pro).toContain('<a href="/billing/start?plan=team" class="site-btn site-btn-accent site-plan-cta"');
    expect(pro).toContain(">Choose Pro</a>");
    expect(pro).toContain("<li><b>Up to 50</b> seats</li>");
    expect(html).toMatch(/class="site-st site-plan is-accent"[^>]*aria-labelledby="site-plan-team"/);
    expect(html.match(/site-btn-accent/g)).toHaveLength(1);
    expect(html.match(/site-plan is-accent/g)).toHaveLength(1);
    // Only the plan sold per seat reads "Up to": Free's and Enterprise's seats are the plan's own.
    expect(card(html, "free")).not.toContain("Up to");
    expect(card(html, "enterprise")).not.toContain("Up to");
    expect(html.match(/Up to /g)).toHaveLength(1); // Pro's card, the one place it is said
    // A plan can be bought, so nothing says prices are coming, and nothing asks for early access.
    expect(html).not.toContain("Prices are not announced yet.");
    expect(html).not.toContain("Get early access");
    expect(html).not.toContain("waitlist");
    expect(html).not.toContain('role="radiogroup"');
  });

  it("Personal is a legacy plan: not on the page at all — no card, no column, no question", () => {
    for (const page of [html, pricingSection({ signedIn: true }), pricingView(false), pricingView(true)]) {
      expect(page).not.toContain("site-plan-personal");
      expect(page).not.toContain('data-plan="Personal"');
      expect(page).not.toContain("Personal");
      expect(page).not.toContain("plan=personal");
    }
  });
});

describe("pricing — no paid price announced (a test double: Pro without a number)", () => {
  const html = pricingSection({ pricing: unpriced() });

  it("shows no amount but Free's word, and no currency anywhere", () => {
    expect(html).not.toMatch(/[$€£¥]/);
    expect(html.match(/site-plan-amt/g)).toHaveLength(1);
    expect(card(html, "free")).toContain('<span class="site-plan-amt">Free</span>');
    // No price interval anywhere. The one "per month" on the page is a LIMIT's period (the AI-summaries
    // allowance), never a price: with those phrases set aside, nothing else says "per month" or "per year".
    expect(html).not.toContain('class="site-plan-per"');
    const allowance = /AI summar(?:y|ies),? per month/g;
    expect(text(html).match(allowance)).toHaveLength(2); // the Free and Pro cards
    expect(text(html).replace(allowance, "")).not.toMatch(/\bper (month|year)\b/);
    expect(text(html)).not.toContain("per seat /");
    expect(card(html, "team")).toContain("Pricing to be announced");
    expect(card(html, "free")).not.toContain("Pricing to be announced");
    // not sold, so not "Up to": the plan's seats read as they are
    expect(card(html, "team")).toContain("<b>50</b> seats</li>");
  });

  it("the unpriced self-serve card offers the waitlist, by e-mail with the plan in the subject; Free offers a start", () => {
    const c = card(html, "team");
    expect(c).toContain(`href="${waitlistHref(PLANS.team)}"`);
    expect(c).toContain("Join the waitlist");
    expect(waitlistHref(PLANS.team)).toBe(`mailto:${LEGAL_CONTACT}?subject=Trov%20Pro%20plan%3A%20waitlist`);
    expect(SITE_CONTACT).toBe(LEGAL_CONTACT);
    expect(card(html, "free")).toContain(`<a href="${FREE_START_HREF}"`);
    expect(card(html, "free")).not.toContain("waitlist");
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
    expect(card(html, "team")).toContain('<span class="site-plan-amt">$40</span> <span class="site-plan-per">per seat / month</span>');
    expect(card(html, "team")).toContain('<a href="/billing/start?plan=team" class="site-btn site-btn-accent site-plan-cta"');
    expect(card(html, "team")).toContain("Choose Pro");
    // Free is never bought, whatever Pro costs
    expect(card(html, "free")).toContain('<span class="site-plan-amt">Free</span>');
    expect(card(html, "free")).toContain(`<a href="${FREE_START_HREF}" class="site-btn site-btn-outline site-plan-cta"`);
    expect(card(html, "free")).not.toContain("/billing/");
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
    expect(team).toContain('<p class="site-plan-price is-month"><span class="site-plan-amt">$40</span> <span class="site-plan-per">per seat / month</span></p>');
    expect(team).toContain('<p class="site-plan-price is-year"><span class="site-plan-amt">$400</span> <span class="site-plan-per">per seat / year</span></p>');
    expect(team).toContain('href="/billing/start?plan=team" class="site-btn site-btn-accent site-plan-cta is-month"');
    expect(team).toContain('href="/billing/start?plan=team&amp;interval=year" class="site-btn site-btn-accent site-plan-cta is-year"');
    // a plan with no yearly price (Free) keeps its one price and button whichever interval is picked
    const free = card(html, "free");
    expect(free).not.toContain("is-year");
    expect(free).not.toContain("is-month");
    expect(free).not.toContain("interval=year");
  });

  it("a paid plan still without a price keeps the waitlist beside Free, which needs none", () => {
    const html = pricingSection({ pricing: unpriced() });
    expect(card(html, "team")).toContain("Pricing to be announced");
    expect(card(html, "team")).toContain(waitlistHref(PLANS.team));
    expect(card(html, "team")).not.toContain("/billing/");
    expect(card(html, "free")).toContain("Start for free");
  });
});

describe("pricing — Enterprise is a conversation", () => {
  it("never has a purchase link, with or without a price", () => {
    for (const pricing of [PRICING, priced(), unpriced(), priced({ enterprise: { price: 900, yearly: 9000 } })]) {
      const c = card(pricingSection({ pricing }), "enterprise");
      expect(c).not.toContain("/billing/");
      expect(c).toContain(`href="${talkHref(PLANS.enterprise)}"`);
      expect(c).toContain("Talk to us");
    }
    expect(talkHref(PLANS.enterprise)).toBe(`mailto:${LEGAL_CONTACT}?subject=Trov%20Enterprise%20plan`);
    expect(card(pricingSection(), "enterprise")).toContain("Custom pricing");
  });
});

describe("pricing — the limits are said once, on the cards", () => {
  const html = pricingSection();

  it("has no side-by-side table repeating them: each card lists every limit, formatted", () => {
    expect(html).not.toContain("<table");
    expect(html).not.toContain("Limits, side by side");
    expect(html).not.toContain("site-cmp");
    for (const id of OFFERED_PLAN_IDS) expect((card(html, id).match(/<li><b>/g) ?? []).length).toBe(LIMIT_KEYS.length);
    expect(card(html, "free")).toContain("<b>250 MB</b>");
    expect(card(html, "team")).toContain("<b>5 GB</b>");
    expect(card(html, "enterprise")).toContain("<b>Unlimited</b>");
    expect(html).not.toContain("null");
  });

  it("lists what every plan includes, and says the by-conversation plan's limits can be set", () => {
    for (const line of EVERY_PLAN) expect(html).toContain(`<span>${line}</span>`);
    expect(html).toContain("Enterprise limits are where an organization starts");
  });
});

describe("pricing — questions say only what is true today", () => {
  const defs = OFFERED_PLAN_IDS.map((id) => PLANS[id]);
  const qs = pricingQuestions(defs, PRICING);
  it("the questions are an accordion: native details, one group, the first open", () => {
    const html = pricingView(false);
    const items = html.match(/<details name="pricing-faq"( open)?><summary>/g) ?? [];
    expect(items).toHaveLength(qs.length);
    expect(items[0]).toContain(" open");
    expect(items.slice(1).every((x) => !x.includes(" open"))).toBe(true);
    // Each question is still a heading (inside its summary), and its answer is in the same item.
    expect(html).toMatch(/<summary><h\d>[^<]+<\/h\d><svg class="site-faq-chev"[\s\S]*?<\/summary><p>/);
    // It spans the page's blocks (no cap of its own), and BOTH opening and closing animate, off under reduced motion.
    const css = trovCssRaw.replace(/\s+/g, " ");
    expect(css).toMatch(/\.site-faq \{ border-bottom:1px solid var\(--border\); interpolate-size:allow-keywords; \}/);
    // Two columns: the heading (and a way to ask something else) left, the accordion right; one column when narrow.
    expect(html).toMatch(/<div class="site-faq-wrap">\s*<div class="site-faq-side">\s*<h\d class="site-price-h">Questions<\/h\d>[\s\S]*?<a href="mailto:[^"]+">Ask us<\/a>[\s\S]*?<\/div>\s*<div class="site-faq">/);
    expect(css).toContain(".site-faq-wrap { display:grid; grid-template-columns:minmax(0, 1fr) minmax(0, 2fr); gap:24px 64px; align-items:start; }");
    expect(css).toMatch(/@media \(max-width:860px\) \{ \.site-faq-wrap \{ grid-template-columns:minmax\(0, 1fr\); \}/);
    expect(css).toMatch(/\.site-faq > details::details-content \{ block-size:0; opacity:0; overflow:clip; transition:block-size var\(--faq-t\) var\(--faq-e\), opacity [^;]+, content-visibility var\(--faq-t\) allow-discrete; \}/);
    // One clock for the box that opens, the box that closes and the chevrons: no stutter between them.
    expect(css).toContain(".site-faq { --faq-t:.38s; --faq-e:cubic-bezier(.4, 0, .2, 1); }");
    expect(css).toMatch(/\.site-faq-chev \{[^}]*transition:transform var\(--faq-t\) var\(--faq-e\)/);
    expect(css).toMatch(/\.site-faq > details\[open\]::details-content \{ block-size:auto; opacity:1; transition:block-size var\(--faq-t\) var\(--faq-e\),/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.site-faq > details::details-content,[^}]*transition:none; \}/);
  });
  const all = text(pricingSection() + pricingSection({ pricing: priced({ team: { yearly: 400 } }) }) + pricingSection({ pricing: unpriced() }));

  it("answers seats, Pro's per-seat price, going over, changing plans, isolation, the source and Enterprise", () => {
    expect(qs.map((x) => x.q)).toEqual([
      "What counts as a seat?",
      "How does Pro pricing work?",
      "What happens if we go over a limit?",
      "Can we change plans?",
      "Is our data separate from other organizations?",
      "Can we read the source?",
      "How does Enterprise work?",
    ]);
    expect(qs[0].a).toContain("an invitation that has not been answered yet");
    // Per seat: the price and its interval from shared/pricing.ts, no minimum, more seats from Org settings, up to the cap.
    expect(qs[1].a).toContain(`Pro is bought per seat, at ${formatPrice(10)} per seat / month.`);
    expect(qs[1].a).not.toContain("for each one");
    expect(qs[1].a).toContain("There is no minimum, so a person on their own can buy a single seat.");
    expect(qs[1].a).toContain("You choose how many at checkout, and add more from Org settings › General when you invite more people, up to 50.");
    expect(qs[2].a).toContain("Nothing is deleted and nobody is removed");
    // Changing plans: Free is created one at a time and upgraded from Org settings; cancelling Pro moves to Free.
    expect(qs[3].a).toContain("Anyone signed in can create a Free organization (one they own at a time), and its owner upgrades it to Pro from Org settings › General.");
    expect(qs[3].a).toContain("An owner manages seats, the card and invoices there too.");
    expect(qs[3].a).toContain("If Pro is cancelled, the organization moves to Free when the paid period ends");
    expect(qs[3].a).not.toContain("mailto:");
    expect(qs[3].a).not.toMatch(/downgrade|any ?time|instantly/i);
    expect(qs[5].a).toContain("AGPL-3.0");
    expect(qs[6].a).toContain(talkHref(PLANS.enterprise));
  });

  it("with nothing purchasable there is no per-seat question, and a plan is changed by writing to Trov", () => {
    const none = pricingQuestions(defs, unpriced());
    expect(none.map((x) => x.q)).toEqual([
      "What counts as a seat?",
      "What happens if we go over a limit?",
      "Can we change plans?",
      "Is our data separate from other organizations?",
      "Can we read the source?",
      "How does Enterprise work?",
    ]);
    expect(none[2].a).toContain("Until paid plans are available, a plan is changed by us: write to <a href=\"mailto:");
    expect(none[2].a).not.toMatch(/upgrade|downgrade|any ?time|instantly|yourself/i);
    // a per-seat plan with no seat cap promises no "up to"
    const uncapped = pricingQuestions(defs.map((d) => (d.id === "team" ? { ...d, entitlements: { ...d.entitlements, seats: null } } : d)), PRICING);
    expect(uncapped[1].a).toContain("when you invite more people. The seats you pay for");
    expect(uncapped[1].a).not.toContain("up to");
  });

  it("promises nothing the product does not do", () => {
    for (const claim of [/refund/i, /\btrial/i, /\bSLA\b/, /discount/i, /\btax/i, /money.back/i, /SOC ?2/i, /GDPR/i, /HIPAA/i, /uptime/i, /guarantee/i, /free (for ?ever|of charge)/i, /cancel any ?time/i]) {
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
    expect(page).toContain(">Free</h2>");
    expect(page).toContain(">Pro</h2>");
    expect(page).not.toContain(">Personal</h2>");
    expect(page).toContain("<h3>What counts as a seat?</h3>");
    expect(page).toContain("<h3>How does Pro pricing work?</h3>");
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
    expect(card(page, "free").replace(/h2/g, "h3")).toBe(card(pricingSection(), "free"));
  });

  it("signed in (what ships): Free offers the way back into the app, Pro still sells, Enterprise is a conversation", () => {
    const html = landingView({ dark: false, signInOpen: false, signedIn: true, seen: new Set() });
    const section = html.slice(html.indexOf('id="site-pricing"'));
    expect(card(section, "free")).toContain('<button type="button" data-act="siteBack" class="site-btn site-btn-outline site-plan-cta"');
    expect(card(section, "free")).toContain(">Open Trov</button>");
    expect(card(section, "team")).toContain('href="/billing/start?plan=team"');
    expect(card(section, "team")).not.toContain("Open Trov");
    expect(card(section, "enterprise")).toContain("Talk to us");
    expect(section).not.toContain("Start for free");
    expect(section).not.toContain("waitlist");
    expect(section).not.toContain("Get early access");
  });

  it("signed in with no paid price: every self-serve plan offers the way back into the app, not a waitlist", () => {
    const html = pricingSection({ signedIn: true, pricing: unpriced() });
    for (const id of ["free", "team"] as const) {
      expect(card(html, id)).toContain('<button type="button" data-act="siteBack" class="site-btn site-btn-outline site-plan-cta"');
      expect(card(html, id)).toContain(">Open Trov</button>");
    }
    expect(html).not.toContain("waitlist");
    expect(html).not.toContain("Get early access");
    expect(card(html, "enterprise")).toContain("Talk to us");
  });

  it("signed in with prices: the purchase links still work, and only Free's button is the way back", () => {
    const html = pricingSection({ signedIn: true, pricing: priced() });
    expect(card(html, "team")).toContain('href="/billing/start?plan=team"');
    expect(card(html, "team")).not.toContain("Open Trov");
    expect(html.match(/Open Trov/g)).toHaveLength(1);
    expect(card(html, "free")).toContain(">Open Trov</button>");
  });
});

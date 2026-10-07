// ── Pricing: the three plans, as the public site shows them ──────────────────
// ONE render (`pricingSection`) in two places: the last section of the landing page
// (web/src/landing.ts, nav link "Pricing") and the standalone `/pricing` page
// (`pricingView` — web/pricing.html, booted by web/src/pricing-page.ts; a static page
// like /terms, readable signed out and linked from the footer).
//
// PURE, and it restates nothing: names, descriptions and every limit come from
// shared/plans.ts, every price from shared/pricing.ts — change a number there and this
// page follows. A plan with no announced price says so and offers a waitlist e-mail;
// it never shows a number, and never a purchase link. A purchase is a plain link to
// `purchaseHref` (the billing route owns sign-in and payment); this page calls no API.
//
// The Monthly / Yearly switch is two native radios and CSS (`:has(:checked)` in
// trov.css shows the `.is-month` or `.is-year` price and link), so it works with no
// script; web/src/pricing-dom.ts only remembers the choice across a rerender.
//
// Every sentence below describes what Trov does today (docs/architecture/plans.md,
// organizations.md). No refunds, trials, discounts or compliance claims: none exist.

import { LIMIT_KEYS, LIMITS, PLAN_IDS, PLANS, formatLimit, type LimitKey, type PlanDef, type PlanId } from "@shared/plans";
import { PRICING, canPurchase, canPurchasePlan, formatPrice, hasYearly, purchaseHref, type PlanPricing } from "@shared/pricing";
import { esc, attr } from "./ui";
import { SITE_CONTACT, TROV_REPO, siteFooter, siteMark } from "./site-chrome";

export interface PricingProps {
  /** Opened from inside the app: a plan with no price offers the way back, not a waitlist. */
  signedIn?: boolean;
  /** The heading level of the title: 2 on the landing (a section of it), 1 on /pricing. */
  level?: 1 | 2;
  /** The landing's scroll-reveal hook (`data-rv` + classes). Default: rendered settled. */
  rv?: (key: string, extra?: string) => string;
  /** The plans and prices to show. Defaults: THE definitions; a test passes its own. */
  plans?: Record<PlanId, PlanDef>;
  pricing?: Record<PlanId, PlanPricing>;
}

const settled = (_key: string, extra = "") => `class="site-rv is-done${extra ? ` ${extra}` : ""}"`;
const at = (ms: number) => `--d:${ms}ms;`;

/** A mailto to Trov with the subject filled in. */
export function mailHref(subject: string): string {
  return `mailto:${SITE_CONTACT}?subject=${encodeURIComponent(subject)}`;
}
export const waitlistHref = (plan: PlanDef) => mailHref(`Trov ${plan.name} plan: waitlist`);
export const talkHref = (plan: PlanDef) => mailHref(`Trov ${plan.name} plan`);
export const earlyAccessHref = () => mailHref("Early access to Trov");

/** The plan whose button is the page's one accent action: the purchasable plan that carries
 *  a badge, else the largest purchasable one. null while no price is announced. */
function accentPlan(pricing: Record<PlanId, PlanPricing>): PlanId | null {
  const buyable = PLAN_IDS.filter((id) => canPurchase(pricing[id]));
  return buyable.find((id) => pricing[id].badge) ?? buyable[buyable.length - 1] ?? null;
}

/** A limit as a card line: the value, then what it counts ("10" + "seats", "5 GB" + "artifact storage"). */
function limitLine(key: LimitKey, value: number | null): [string, string] {
  const d = LIMITS[key];
  const what = d.unit === "bytes" ? d.label.toLowerCase() : value === 1 ? d.one : d.many;
  return [formatLimit(key, value), `${what}${d.per === "person" ? " per person" : ""}`];
}

const CHECK = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.4" aria-hidden="true" style="flex:none;margin-top:3px"><path d="M20 6 9 17l-5-5"></path></svg>`;

// ── the cards ────────────────────────────────────────────────────────────────
function priceSlot(price: PlanPricing): string {
  const amount = (n: number, per: string, cls = "") =>
    `<p class="site-plan-price${cls}"><span class="site-plan-amt">${n === 0 ? "Free" : esc(formatPrice(n))}</span>${n === 0 ? "" : ` <span class="site-plan-per">${esc(per)}</span>`}</p>`;
  if (price.price === null) return `<p class="site-plan-price site-plan-tba">${price.selfServe ? "Pricing to be announced" : "Custom pricing"}</p>`;
  if (!hasYearly(price)) return amount(price.price, price.per);
  return amount(price.price, price.per, " is-month") + amount(price.yearly as number, price.yearlyPer, " is-year");
}

function planCta(def: PlanDef, price: PlanPricing, accent: boolean, signedIn: boolean): string {
  const BTN = "border-radius:9px;justify-content:center";
  const outline = `class="site-btn site-btn-outline site-plan-cta" style="${BTN}"`;
  if (!price.selfServe) return `<a href="${attr(talkHref(def))}" ${outline}>Talk to us<span class="site-vh"> about the ${esc(def.name)} plan</span></a>`;
  const id = def.id;
  if (!canPurchasePlan(id, price)) {
    return signedIn
      ? `<button type="button" data-act="siteBack" ${outline}>Open Trov</button>`
      : `<a href="${attr(waitlistHref(def))}" ${outline}>Join the waitlist<span class="site-vh"> for the ${esc(def.name)} plan</span></a>`;
  }
  const link = (interval: "month" | "year", cls = "") =>
    `<a href="${attr(purchaseHref(id, interval))}" class="site-btn ${accent ? "site-btn-accent" : "site-btn-outline"} site-plan-cta${cls}" style="${BTN}">Choose ${esc(def.name)}${cls ? `<span class="site-vh">, billed ${interval === "year" ? "yearly" : "monthly"}</span>` : ""}</a>`;
  return hasYearly(price) ? link("month", " is-month") + link("year", " is-year") : link("month");
}

function planCard(def: PlanDef, price: PlanPricing, i: number, accent: boolean, signedIn: boolean, h: number): string {
  const limits = LIMIT_KEYS.map((k) => {
    const [value, what] = limitLine(k, def.entitlements[k]);
    return `<li><b>${esc(value)}</b> ${esc(what)}</li>`;
  }).join("");
  return `<article class="site-st site-plan${accent ? " is-accent" : ""}" style="border-radius:12px;${at(i * 110)}" aria-labelledby="site-plan-${def.id}">
      <div class="site-plan-head">
        <h${h} id="site-plan-${def.id}" class="site-plan-name">${esc(def.name)}</h${h}>
        ${price.badge ? `<span class="site-plan-badge" style="border-radius:4px">${esc(price.badge)}</span>` : ""}
      </div>
      <p class="site-plan-for">${esc(def.description)}</p>
      <div class="site-plan-pricebox">${priceSlot(price)}</div>
      <div class="site-plan-ctabox">${planCta(def, price, accent, signedIn)}</div>
      <ul class="site-plan-limits" aria-label="${attr(def.name)} limits">${limits}</ul>
    </article>`;
}

/** Shown only while NO plan can be bought: the page's one accent action. */
function notAnnounced(signedIn: boolean): string {
  const text = signedIn
    ? `To move your organization to another plan, write to <a href="${attr(mailHref("Changing our Trov plan"))}">${SITE_CONTACT}</a>.`
    : "Until they are, organizations are set up by invitation. Write to us and say which plan fits.";
  return `<div class="site-price-note" style="border-radius:12px">
      <p><b>Prices are not announced yet.</b> ${text}</p>
      ${signedIn ? "" : `<a href="${attr(earlyAccessHref())}" class="site-btn site-btn-accent" style="border-radius:9px">Get early access</a>`}
    </div>`;
}

function intervalSwitch(): string {
  const opt = (value: "month" | "year", label: string) =>
    `<label style="border-radius:7px"><input type="radio" name="site-interval" value="${value}"${value === "month" ? " checked" : ""}>${label}</label>`;
  return `<div class="site-interval" role="radiogroup" aria-label="Billing interval" style="border-radius:9px">${opt("month", "Monthly")}${opt("year", "Yearly")}</div>`;
}

// ── the comparison ───────────────────────────────────────────────────────────
// A real table. On a phone each limit becomes a block: its name, then the three plans'
// values side by side (trov.css) — the roles keep it a table to a screen reader there too.
function comparison(defs: PlanDef[], pricing: Record<PlanId, PlanPricing>, h: number): string {
  const rows = LIMIT_KEYS.map((k) => {
    const d = LIMITS[k];
    const cells = defs.map((def) => `<td role="cell" data-plan="${attr(def.name)}">${esc(formatLimit(k, def.entitlements[k]))}</td>`).join("");
    return `<tr role="row"><th role="rowheader" scope="row"><span class="site-cmp-label">${esc(d.label)}${d.per === "person" ? ", per person" : ""}</span><span class="site-cmp-counts">${esc(d.counts)}</span></th>${cells}</tr>`;
  }).join("");
  const sized = defs.filter((def) => !pricing[def.id].selfServe).map((def) => def.name);
  return `<h${h} class="site-price-h">Limits, side by side</h${h}>
    <table class="site-cmp" role="table">
      <caption class="site-vh">What each plan allows</caption>
      <thead role="rowgroup"><tr role="row"><th role="columnheader" scope="col"><span class="site-vh">Limit</span></th>${defs.map((def) => `<th role="columnheader" scope="col">${esc(def.name)}</th>`).join("")}</tr></thead>
      <tbody role="rowgroup">${rows}</tbody>
    </table>
    ${sized.length ? `<p class="site-cmp-foot">${esc(sized.join(" and "))} limits are where an organization starts: each one can be set for the organization.</p>` : ""}`;
}

/** What no plan withholds — a plan is a table of limits, never a feature switch. */
export const EVERY_PLAN: readonly string[] = [
  "An MCP server and a Claude Code plugin for your agents",
  "Docs and decisions, with a person approving what becomes official",
  "Tickets, sprints and the roadmap",
  "The feed, handoffs, the prompt library and artifacts",
  "The repo dashboard: deploys, CI, drift and usage",
  "Email digests, daily or weekly",
  "Integration keys that are write-only and stored encrypted",
  "Sign-in with GitHub or Google",
];

function everyPlan(h: number): string {
  return `<h${h} class="site-price-h">In every plan</h${h}>
    <ul class="site-price-all">${EVERY_PLAN.map((t) => `<li>${CHECK}<span>${esc(t)}</span></li>`).join("")}</ul>`;
}

// ── questions ────────────────────────────────────────────────────────────────
export interface PricingQuestion { q: string; /** Authored HTML (this file's own text). */ a: string }

export function pricingQuestions(defs: PlanDef[], pricing: Record<PlanId, PlanPricing>): PricingQuestion[] {
  const byTalk = defs.find((def) => !pricing[def.id].selfServe);
  const limitNames = LIMIT_KEYS.map((k) => LIMITS[k].label.toLowerCase());
  const list = `${limitNames.slice(0, -1).join(", ")} and ${limitNames[limitNames.length - 1]}`;
  const qs: PricingQuestion[] = [
    { q: "What counts as a seat?", a: "A member of the organization, or an invitation that has not been answered yet. A pending invitation holds its seat, so an organization can never accept more people than it has seats." },
    { q: "What happens if we go over a limit?", a: "Nothing is deleted and nobody is removed. Everyone can still read everything. Adding more of that one thing is refused until the organization is back under the limit, and the rest of Trov carries on." },
    { q: "Can we change plans?", a: `Yes. An owner manages a paid plan from Org settings › General in Trov. Until paid plans are available, a plan is changed by us: write to <a href="${attr(mailHref("Changing our Trov plan"))}">${SITE_CONTACT}</a>. If the new plan is smaller than what the organization uses, the answer above applies.` },
    { q: "Is our data separate from other organizations?", a: "Yes. Everything in Trov belongs to one organization, and only its members and the agents they connect can read it." },
    { q: "Can we read the source?", a: `Yes. Trov's source is <a href="${TROV_REPO}" target="_blank" rel="noopener">published on GitHub</a> under AGPL-3.0. The plans on this page are for the hosted service.` },
  ];
  if (byTalk) qs.push({ q: `How does ${byTalk.name} work?`, a: `<a href="${attr(talkHref(byTalk))}">Talk to us about ${esc(byTalk.name)}</a>. Its ${list} are each set for your organization, and can be changed later.` });
  return qs;
}

function questions(defs: PlanDef[], pricing: Record<PlanId, PlanPricing>, h: number): string {
  return `<h${h} class="site-price-h">Questions</h${h}>
    <div class="site-faq">${pricingQuestions(defs, pricing).map((x) => `<div><h${h + 1}>${esc(x.q)}</h${h + 1}><p>${x.a}</p></div>`).join("")}</div>`;
}

// ── the section ──────────────────────────────────────────────────────────────
export const PRICING_TITLE = "One product, three sizes.";
export const PRICING_LEDE = "Every plan is all of Trov. They differ in how many people share the organization, and in how much it can connect and store.";

export function pricingSection(p: PricingProps = {}): string {
  const plans = p.plans ?? PLANS;
  const pricing = p.pricing ?? PRICING;
  const rv = p.rv ?? settled;
  const signedIn = p.signedIn ?? false;
  const level = p.level ?? 2;
  const defs = PLAN_IDS.map((id) => plans[id]);
  const accent = accentPlan(pricing);
  const yearly = PLAN_IDS.some((id) => hasYearly(pricing[id]));
  const title = level === 1
    ? `<div class="site-price-eyebrow">Pricing</div><h1 class="site-price-title is-page">${PRICING_TITLE}</h1>`
    : `<h2 class="site-price-title">${PRICING_TITLE}</h2>`;

  return `<section id="site-pricing" class="site-pricing${level === 1 ? " is-page" : ""}" aria-label="Pricing">
    <div ${rv("pricing-head", "site-price-top")}>
      <div class="site-price-intro">
        ${title}
        <p class="site-price-lede">${PRICING_LEDE}</p>
      </div>
      ${yearly ? intervalSwitch() : ""}
    </div>
    <div ${rv("pricing-plans", "rv-static site-plans")}>
      ${defs.map((def, i) => planCard(def, pricing[def.id], i, def.id === accent, signedIn, level + 1)).join("")}
    </div>
    ${accent === null ? `<div ${rv("pricing-note")}>${notAnnounced(signedIn)}</div>` : ""}
    <div ${rv("pricing-compare", "site-price-block")}>${comparison(defs, pricing, level + 1)}</div>
    <div ${rv("pricing-all", "site-price-block")}>${everyPlan(level + 1)}</div>
    <div ${rv("pricing-faq", "site-price-block")}>${questions(defs, pricing, level + 1)}</div>
  </section>`;
}

// ── the standalone page (/pricing) ───────────────────────────────────────────
const SUN = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="4.2"></circle><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8"></path></svg>`;
const MOON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"></path></svg>`;

/** The whole /pricing page. `dark` picks the toggle's icon, like the landing's nav. The page
 *  cannot know a session without asking the server, so it is always the signed-out page; its
 *  nav's "Open Trov" goes to `/`, which is the app when signed in and the landing when not. */
export function pricingView(dark: boolean, p: Pick<PricingProps, "plans" | "pricing"> = {}): string {
  return `<div class="cnpy-site">
    <nav class="site-nav" style="position:sticky;top:0;z-index:50;background:color-mix(in srgb, var(--bg) 86%, transparent);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)">
      <div class="site-navin" style="max-width:1120px;margin:0 auto;padding:0 24px;height:60px;display:flex;align-items:center;gap:28px">
        <a href="/" aria-label="Trov home" style="display:flex;align-items:center;gap:9px;color:var(--fg);text-decoration:none">
          ${siteMark(20)}
          <span style="font-size:16.5px;font-weight:650;letter-spacing:-0.01em">Trov</span>
        </a>
        <div style="margin-left:auto;display:flex;align-items:center;gap:10px">
          <button type="button" data-site-theme title="Toggle theme" aria-label="Toggle theme" class="site-iconbtn" style="border:1px solid var(--border)">${dark ? MOON : SUN}</button>
          <a href="/" class="cnpy-accentbtn" style="padding:7px 16px;border-radius:8px;background:var(--accent);color:var(--accent-fg);font-size:13.5px;font-weight:600;white-space:nowrap;text-decoration:none">Open Trov</a>
        </div>
      </div>
    </nav>
    <main>${pricingSection({ ...p, level: 1 })}</main>
    ${siteFooter()}
  </div>`;
}

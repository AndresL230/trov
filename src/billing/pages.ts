// The pages `GET /billing/start` answers with when it cannot go straight to Stripe — rendered by the
// Worker (not the SPA), on the OAuth pages' shell (src/auth/oauth-pages.ts: the Trov mark, Geist, the
// same card and tokens). Pure string templates; every dynamic value is escaped. No script, no price.
import { PLANS, type PlanId } from "@shared/plans";
import { BILLING_CONTACT, PRICING_PATH } from "@shared/billing";
import { PLATFORM_FROM_ADDRESS } from "@shared/sender";
import { esc, shell, head, GITHUB, GOOGLE } from "../auth/oauth-pages";

const back = `<a class="btn" href="${PRICING_PATH}">Back to the plans</a>`;

/** Signed out: sign in, then the purchase carries on (src/auth/return-to.ts). Any GitHub or Google
 *  account can sign in, and a first sign-in creates the account. */
export function billingSignInPage(plan: PlanId): string {
  return shell("Sign in", head("Sign in to continue")
    + `<p class="lede">to get Trov <strong>${esc(PLANS[plan].name)}</strong></p>`
    + `<div class="stack">`
    + `<a class="btn primary" href="/auth/login">${GITHUB}Sign in with GitHub</a>`
    + `<div class="or"><span></span>or<span></span></div>`
    + `<a class="btn" href="/auth/google/login">${GOOGLE}Continue with Google</a>`
    + `</div>`
    + `<div class="foot">New to Trov? Signing in with either one creates your account. After you sign in, you go on to payment.</div>`);
}

export function billingNoticePage(o: { title: string; lede: string; foot?: string; action?: { href: string; label: string }; error?: boolean }): string {
  return shell(o.title, head(o.title)
    + (o.error ? `<div class="err" role="alert">${esc(o.lede)}</div>` : `<p class="lede">${esc(o.lede)}</p>`)
    + `<div class="stack">${o.action ? `<a class="btn primary" href="${esc(o.action.href)}">${esc(o.action.label)}</a>` : ""}${back}</div>`
    + (o.foot ? `<div class="foot">${esc(o.foot)}</div>` : ""));
}

export const unavailablePage = (): string => billingNoticePage({
  title: "Paid plans are not available yet",
  lede: "Trov is not taking payments yet. Nothing was charged.",
  foot: `To get an organization now, write to ${PLATFORM_FROM_ADDRESS}.`,
});
export const enterprisePage = (): string => billingNoticePage({
  title: "Enterprise is arranged with Trov",
  lede: "Enterprise is set up for each organization: its seats and limits are agreed with Trov, not bought here.",
  action: { href: BILLING_CONTACT, label: `Write to ${PLATFORM_FROM_ADDRESS}` },
});
export const superadminPage = (): string => billingNoticePage({
  title: "You run this Trov",
  lede: "A superadmin adds organizations in Platform, on any plan, without paying.",
  action: { href: "/platform/", label: "Open Platform" },
});
export const rateLimitedPage = (): string => billingNoticePage({
  title: "Too many checkouts today",
  lede: "You have started the most checkouts Trov allows in a day. Nothing was charged. Try again tomorrow.",
  error: true,
});
export const stripeFailedPage = (): string => billingNoticePage({
  title: "The payment page did not open",
  lede: "Trov could not reach Stripe just now. Nothing was charged. Try again in a minute.",
  error: true,
});

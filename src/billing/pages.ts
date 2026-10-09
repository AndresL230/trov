// The NOTICES `GET /billing/start` answers with when it cannot go on (a signed-out buyer is not one of them:
// they are sent to the app's Get started dialog, or straight to the provider they picked) — rendered by the
// Worker (not the SPA), on the OAuth pages' shell (src/auth/oauth-pages.ts: the Trov mark, Geist, the
// same card and tokens). Pure string templates; every dynamic value is escaped. No script, no price.
import { BILLING_CONTACT, PRICING_PATH } from "@shared/billing";
import { PLATFORM_FROM_ADDRESS } from "@shared/sender";
import { esc, shell, head } from "../auth/oauth-pages";

const back = `<a class="btn" href="${PRICING_PATH}">Back to the plans</a>`;

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

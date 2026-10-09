// THE PAYMENT PAGE — `/billing/checkout?plan=team[&interval=year][&org=<slug>][&session=cs_…]`: embedded
// checkout (docs/architecture/billing.md › Embedded checkout). The buyer pays INSIDE Trov: Stripe's own
// form, in Stripe's own iframe, mounted in the body of the first-run card — the same bannered card, over
// the same backdrop, as the confirmation step that follows it (billing.ts `billingDonePage`). Trov still
// sees no card and no amount; only where the buyer is while paying has changed.
//
// Reached only while embedded checkout is on (`/billing/start` and the org's "Upgrade to Pro" send the
// buyer here then). The page asks the Worker for its Checkout Session (a client secret, to this signed-in
// buyer only), loads Stripe.js (stripe-js.ts — on this page and nowhere else) and mounts the form. When
// the payment is made Stripe sends the browser to `/billing/done?session_id=…`, exactly as its hosted page
// does. This page fulfils nothing and proves nothing: the webhook does that.
//
// `data-morph` on the root and `data-keep` on the mount node: a repaint patches the card in place and
// never touches the node Stripe's iframe lives in — a replaced iframe would reload the form and lose what
// the buyer typed. The body's structure is the same in every phase (state is attributes), so the mount
// node is always the same child.
//
// Pure markup (`billingCheckoutPage`) + a small controller (`startBillingCheckout`, `billingCheckoutHosted`).

import { PLANS } from "@shared/plans";
import {
  BILLING_DONE_PATH, PRICING_PATH, billingCheckoutHref, billingStartHref, isBillingInterval, isPurchasablePlan, orgBillingHref,
  type BillingCheckoutRequest, type BillingCheckoutResponse, type BillingInterval, type PurchasablePlan,
} from "@shared/billing";
import { esc, attr, surface } from "./ui";
import { trovMark } from "@shared/mark";
import { BILLING_FOOT, BTN, SPINNER, accentLink, quietLink } from "./billing";
import { skBar, skBox } from "./skeleton";
import type { StripeEmbedder } from "./stripe-js";

export type BillingCheckoutPhase =
  | "loading"   // asking for the session, loading Stripe.js: a skeleton where the form will be
  | "form"      // Stripe's form is mounted
  | "failed"    // Stripe.js would not load or mount: offer Stripe's hosted page
  | "expired"   // the session this page showed expired unpaid
  | "refused";  // the Worker would not start a checkout (a limit, billing off, not the owner, Stripe unreachable)

export interface BillingCheckoutRefusal { title: string; body: string; retry: boolean }

export interface BillingCheckoutUi {
  plan: PurchasablePlan;
  interval: BillingInterval;
  /** The organization being upgraded (its slug), or null for a new purchase. */
  org: string | null;
  /** The Checkout Session this page shows — kept in the URL, never its client secret. */
  sessionId: string | null;
  phase: BillingCheckoutPhase;
  refusal: BillingCheckoutRefusal | null;
  /** The fallback was pressed: waiting for Stripe's hosted URL. */
  hosting: boolean;
  /** The fallback itself was refused: one sentence under the buttons. */
  hostedError: string | null;
}

/** The page's state from its own URL, or null when the URL names no plan Trov sells (→ the pricing page). */
export function initialBillingCheckout(params: URLSearchParams): BillingCheckoutUi | null {
  const plan = params.get("plan");
  if (!isPurchasablePlan(plan)) return null;
  const asked = params.get("interval");
  const org = params.get("org");
  const session = params.get("session");
  return {
    plan, interval: isBillingInterval(asked) ? asked : "month",
    org: org && /^[a-z0-9][a-z0-9-]{0,62}$/.test(org) ? org : null,
    sessionId: session && /^cs_[A-Za-z0-9_]{1,200}$/.test(session) ? session : null,
    phase: "loading", refusal: null, hosting: false, hostedError: null,
  };
}

/** Where backing out goes: the plans, or — for an upgrade — the organization's Plan block. */
export const billingCheckoutBackHref = (s: Pick<BillingCheckoutUi, "org">): string => (s.org ? orgBillingHref(s.org) : PRICING_PATH);
const doneHref = (sessionId: string): string => `${BILLING_DONE_PATH}?session_id=${encodeURIComponent(sessionId)}`;

/** The id of the node Stripe mounts into. `data-keep`: morph never looks inside it (web/src/morph.ts). */
export const BILLING_MOUNT_ID = "billing-checkout-mount";

/** The form's place while it loads: an order line and its total beside a column of fields, the shape
 *  Stripe's form takes. Pure decoration (`aria-hidden`); the live line beside it is what is read out. */
function formSkeleton(): string {
  const field = (w: string): string => `<div style="display:grid;gap:7px">${skBar(w, 9)}${skBox("100%", 40)}</div>`;
  return `<div class="cnpy-billco-skel" aria-hidden="true">
    <div class="cnpy-billco-skel-sum">${skBar("38%", 10)}${skBar("56%", 26)}${skBar("72%", 10)}<div style="display:flex;justify-content:space-between;gap:12px;margin-top:10px">${skBar("34%", 10)}${skBar("16%", 10)}</div></div>
    <div class="cnpy-billco-skel-form">${field("22%")}${field("34%")}<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">${field("46%")}${field("38%")}</div>${field("28%")}${skBox("100%", 44, "margin-top:4px")}</div>
  </div>`;
}

interface Copy { title: string; lede: string; note: string; actions: string }

function copyOf(s: BillingCheckoutUi): Copy {
  const plan = PLANS[s.plan].name;
  const back = quietLink(billingCheckoutBackHref(s), s.org ? "Back to the organization" : "See the plans");
  const again = quietLink(billingCheckoutHref(s.plan, s.interval, { org: s.org, session: s.sessionId }), "Try again");
  switch (s.phase) {
    case "failed":
      return {
        title: "The payment form did not open",
        lede: "",
        note: "Nothing was charged. Stripe's form could not be loaded on this page: a content blocker or the network may have stopped it. You can pay on Stripe's own page instead, and you come back here when it is done.",
        // A button, not a link: it asks the Worker for a hosted session first (main.ts `billingHosted`).
        actions: `<button type="button" data-act="billingHosted" data-field="billingHosted"${s.hosting ? " disabled aria-busy=\"true\"" : ""} class="cnpy-accentbtn" style="${BTN};background:var(--accent);color:var(--accent-fg);font-weight:600;border:0">${s.hosting ? "Opening Stripe…" : "Continue on Stripe's page"}</button>${again}`,
      };
    case "expired":
      return {
        title: "This checkout expired",
        lede: "",
        note: "It was left open too long, so Stripe closed it. Nothing was charged. Starting again takes a moment.",
        actions: accentLink(billingCheckoutHref(s.plan, s.interval, { org: s.org }), "Start again") + back,
      };
    case "refused":
      return {
        title: s.refusal?.title ?? "The payment page did not open",
        lede: "",
        note: esc(s.refusal?.body ?? "Nothing was charged. Try again in a minute."),
        actions: (s.refusal?.retry ? again : "") + back,
      };
    default:
      return {
        title: s.org ? `Upgrade to ${plan}` : `Pay for ${plan}`,
        lede: s.org
          ? `${plan} is paid per seat. The form starts at the seats this organization uses now; you can change the number there.`
          : `${plan} is paid per seat. Choose the number of seats in the form; you name your organization next.`,
        note: "", actions: "",
      };
  }
}

/**
 * The payment page. The same first-run card as the confirmation step (`.cnpy-orgs-card`, its banner, the
 * backdrop from render.ts `firstRunBackdrop`), wider — Stripe's form wants the room — and aligned to the top
 * of the window, because the form's height is Stripe's and changes as the buyer fills it in: the card grows
 * with it and the PAGE scrolls, never a box inside the card.
 */
export function billingCheckoutPage(s: BillingCheckoutUi, backdrop = ""): string {
  const c = copyOf(s);
  const plan = PLANS[s.plan].name;
  const paying = s.phase === "loading" || s.phase === "form";
  return `<div class="cnpy-orgs cnpy-billco" data-morph="billing-checkout" data-billing-checkout="${s.phase}">
    ${backdrop}
    <div class="cnpy-orgs-col">
      <main${surface("overflow:hidden", { cls: "cnpy-orgs-card" })}>
        <header class="cnpy-orgs-banner">
          <span class="cnpy-orgs-art" aria-hidden="true">${trovMark(230, "currentColor")}</span>
          <div style="position:relative;display:flex;align-items:center;gap:9px">${trovMark(20, "currentColor")}<span style="font-size:15px;font-weight:600;letter-spacing:-0.01em">Trov</span><span class="cnpy-onb-step">${esc(s.org ? `${plan} · ${s.org}` : `Your ${plan} organization`)}</span></div>
          <h1 style="position:relative;margin:20px 0 0;font-size:26px;font-weight:600;letter-spacing:-0.02em;line-height:1.2">${esc(c.title)}</h1>
          <p class="cnpy-orgs-lede" style="position:relative;margin:8px 0 0;font-size:14px;line-height:1.55;max-width:56ch"${c.lede ? "" : " hidden"}>${esc(c.lede)}</p>
        </header>
        <div class="cnpy-orgs-body cnpy-billco-body" data-billco-phase="${s.phase}">
          <div class="cnpy-billco-stage"${paying ? "" : " hidden"}><div class="cnpy-billco-mount" id="${BILLING_MOUNT_ID}" data-keep data-billing-mount></div>${formSkeleton()}<div class="cnpy-billco-wait" role="status"${s.phase === "loading" ? "" : " hidden"}>${SPINNER}<span>Opening Stripe's secure form</span></div></div>
          <div class="cnpy-billco-note" role="${paying ? "presentation" : "alert"}"${paying ? " hidden" : ""}>
            <p style="margin:0;font-size:14px;line-height:1.6;color:var(--fg-70);overflow-wrap:anywhere">${c.note}</p>
            <div class="cnpy-billdone-acts">${c.actions}</div>
            <p role="status" style="margin:0;font-size:12.5px;line-height:1.5;color:var(--red)"${s.hostedError ? "" : " hidden"}>${esc(s.hostedError ?? "")}</p>
          </div>
        </div>
        <footer class="cnpy-orgs-foot"><span>${BILLING_FOOT}</span><a class="cnpy-mutelink" data-billing-back href="${attr(billingCheckoutBackHref(s))}" style="font-size:12.5px;text-decoration:none">Back</a></footer>
      </main>
    </div>
  </div>`;
}

// ── the controller ───────────────────────────────────────────────────────────

export interface BillingCheckoutHost {
  get(): BillingCheckoutUi | null;
  rerender(): void;
  /** The Worker: `POST /api/billing/checkout`, or the org's `…/billing/upgrade`. Rejects as api.ts does. */
  ask(s: BillingCheckoutUi, req: BillingCheckoutRequest): Promise<BillingCheckoutResponse>;
  /** Stripe.js for this publishable key (stripe-js.ts `loadStripeEmbedder`). Rejects when it will not load. */
  stripe(publishableKey: string): Promise<StripeEmbedder>;
  /** The live mount node (`#billing-checkout-mount`), after a rerender. */
  mountNode(): HTMLElement | null;
  /** Leave the page (`location.replace`: the payment page is not a place to come Back to by accident). */
  go(href: string): void;
  /** Put the session in the address bar without loading anything (`history.replaceState`). */
  setUrl(href: string): void;
}

/** What a refused call means for the buyer: somewhere to go, or a sentence. Never "payment failed" — nothing was paid. */
export function billingCheckoutRefusal(s: BillingCheckoutUi, e: unknown): { go: string } | BillingCheckoutRefusal {
  const status = (e as { status?: number } | null)?.status;
  const code = e instanceof Error ? e.message : "";
  // api.ts: a 401 is its `Unauthorized` (no status). Signed out → the purchase link, which signs them in
  // and brings them back; an upgrade → the organization, which does the same.
  if (code === "unauthorized" && status === undefined) return { go: s.org ? `/${encodeURIComponent(s.org)}/` : billingStartHref(s.plan, s.interval) };
  if (code === "not_free" && s.org) return { go: orgBillingHref(s.org) }; // already on a paid plan: its Plan block says so
  if (status === 429) return { title: "Too many checkouts today", body: "You have started the most checkouts Trov allows in a day. Nothing was charged. Try again tomorrow.", retry: false };
  if (code === "billing_unavailable") return { title: "Paid plans are not available yet", body: "Trov is not taking payments yet. Nothing was charged.", retry: false };
  if (code === "superadmin") return { title: "You run this Trov", body: "A superadmin adds organizations in Platform, on any plan, without paying.", retry: false };
  if (status === 403) return { title: "Only an owner can pay for this", body: "Only an owner of this organization manages its plan and billing. Nothing was charged.", retry: false };
  if (status === 404 || status === 400) return { title: "Nothing to pay for here", body: "This link is not for a plan or an organization of yours. Nothing was charged.", retry: false };
  return { title: "The payment page did not open", body: "Trov could not reach Stripe just now. Nothing was charged. Try again in a minute.", retry: true };
}

function refuse(h: BillingCheckoutHost, s: BillingCheckoutUi, e: unknown): void {
  const r = billingCheckoutRefusal(s, e);
  if ("go" in r) { h.go(r.go); return; }
  s.phase = "refused";
  s.refusal = r;
  h.rerender();
}

/**
 * Open the form: ask for the session, load Stripe.js, mount. Resolves when the page has settled — the form
 * is up, or the page says why not. The client secret lives in this call's frame only: it is handed to
 * Stripe.js and is never put in the page's state, its markup, the URL or storage.
 */
export async function startBillingCheckout(h: BillingCheckoutHost): Promise<void> {
  const s = h.get();
  if (!s) return;
  let r: BillingCheckoutResponse;
  try {
    r = await h.ask(s, { plan: s.plan, interval: s.interval, ui: "embedded", ...(s.sessionId ? { session_id: s.sessionId } : {}) });
  } catch (e) { refuse(h, s, e); return; }
  if (r.ui === "hosted") { h.go(r.url); return; }            // embedded checkout is off: Stripe's own page
  if (r.ui === "complete") { h.go(doneHref(r.session_id)); return; } // already paid: never a second form
  if (r.ui === "expired") { s.phase = "expired"; s.sessionId = null; h.rerender(); return; }
  // The session's id goes in the address bar, so a reload — or Back from the confirmation — asks about
  // THIS session (resumed, or found paid) instead of starting another.
  s.sessionId = r.session_id;
  h.setUrl(billingCheckoutHref(s.plan, s.interval, { org: s.org, session: r.session_id }));
  try {
    const checkout = await (await h.stripe(r.publishable_key)).embed(r.client_secret);
    s.phase = "form";
    h.rerender();
    const node = h.mountNode();
    if (!node) throw new Error("no mount node");
    checkout.mount(node);
  } catch {
    // Blocked, offline, timed out, or Stripe refused to mount. Nothing about the error is shown or kept.
    s.phase = "failed";
    h.rerender();
  }
}

/** The fallback: Stripe's HOSTED checkout for the same purchase, when its form would not open here. */
export async function billingCheckoutHosted(h: BillingCheckoutHost): Promise<void> {
  const s = h.get();
  if (!s || s.hosting) return;
  s.hosting = true;
  s.hostedError = null;
  h.rerender();
  try {
    const r = await h.ask(s, { plan: s.plan, interval: s.interval, ui: "hosted", ...(s.sessionId ? { session_id: s.sessionId } : {}) });
    if (r.ui === "hosted") { h.go(r.url); return; }
    if (r.ui === "complete") { h.go(doneHref(r.session_id)); return; }
    throw new Error("unexpected");
  } catch (e) {
    const r = billingCheckoutRefusal(s, e);
    if ("go" in r) { h.go(r.go); return; }
    s.hosting = false;
    s.hostedError = r.body;
    h.rerender();
  }
}

// The WAITING ROOM — `/billing/done?session_id=…`, where Stripe sends a buyer back after checkout
// (docs/architecture/billing.md › The waiting room). It is ONLY a waiting room: the browser arriving
// here proves nothing, so nothing is fulfilled from this page. It polls `GET /api/billing/status` until
// the webhook has made the buyer's grant, then sends them on to name their organization.
//
// A page outside any org (the buyer has none yet), on the sign-in cards' frame. It never says a payment
// failed: Stripe took the money before it redirected here, so a slow confirmation is "received, ready
// shortly" — the only unhappy words are for a checkout Stripe itself says was never paid.
//
// Pure markup (`billingDonePage`) + one small controller (`startBillingDone`) that owns the poll.

import { PLANS, type PlanId } from "@shared/plans";
import { PRICING_PATH, type BillingStatusResponse } from "@shared/billing";
import { esc, attr, surface } from "./ui";
import { trovMark } from "@shared/mark";

export type BillingDonePhase =
  | "confirming"   // asking; nothing confirmed yet
  | "received"     // Stripe has the payment; the grant is on its way
  | "ready"        // the grant exists: go and name the organization
  | "done"         // nothing left to do here: the organization exists
  | "unpaid"       // Stripe says this checkout was never paid
  | "ended"        // cancelled before an organization was set up
  | "missing"      // no session in the URL, or not this person's
  | "signedout";

export interface BillingDoneUi {
  sessionId: string | null;
  phase: BillingDonePhase;
  /** Confirmation is taking longer than usual: say the payment is safe instead of spinning in silence. */
  slow: boolean;
  /** The poll gave up for now; the page offers "Check again". */
  stopped: boolean;
  plan: PlanId | null;
  grant: number | null;
  org: { slug: string; name: string } | null;
}

export const initialBillingDone = (sessionId: string | null): BillingDoneUi =>
  ({ sessionId, phase: sessionId ? "confirming" : "missing", slow: false, stopped: false, plan: null, grant: null, org: null });

/** Where the buyer names their organization: the picker, with the form for THIS grant open (main.ts boot). */
export const setupHref = (grant: number): string => `/?setup=${grant}`;
export const SETUP_PARAM = "setup";
const doneHref = (sessionId: string): string => `/billing/done?session_id=${encodeURIComponent(sessionId)}`;

const SPINNER = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.4" aria-hidden="true" style="animation:cnpy-spin .8s linear infinite"><path d="M12 3a9 9 0 1 0 9 9" stroke-linecap="round"></path></svg>`;
const BTN = "display:flex;align-items:center;justify-content:center;width:100%;box-sizing:border-box;padding:11px 16px;border-radius:9px;font-size:13.5px;text-decoration:none";
const accentLink = (href: string, text: string): string =>
  `<a href="${attr(href)}" data-billing-go class="cnpy-accentbtn" style="${BTN};background:var(--accent);color:var(--accent-fg);font-weight:600">${esc(text)}</a>`;
const quietLink = (href: string, text: string): string =>
  `<a href="${attr(href)}" class="cnpy-outlinebtn" style="${BTN};border:1px solid var(--border-strong);color:var(--fg);font-weight:500">${esc(text)}</a>`;

interface Copy { title: string; body: string; actions: string }

function copyOf(s: BillingDoneUi): Copy {
  const again = s.sessionId ? quietLink(doneHref(s.sessionId), "Check again") : "";
  const home = quietLink("/", "Go to your organizations");
  switch (s.phase) {
    case "ready": {
      const plan = s.plan ? `${PLANS[s.plan].name} ` : "";
      return {
        title: "Payment received",
        body: `Thank you. Your ${esc(plan)}organization is paid for and ready to set up: next you choose its name and its handle, and it is yours.`,
        actions: accentLink(setupHref(s.grant ?? 0), "Set up your organization"),
      };
    }
    case "done":
      return {
        title: "Your organization is ready",
        body: s.org ? `<strong style="color:var(--fg);font-weight:600">${esc(s.org.name)}</strong> is on its plan.` : "It is on its plan.",
        actions: s.org ? accentLink(`/${encodeURIComponent(s.org.slug)}/`, `Open ${s.org.name}`) : home,
      };
    case "unpaid":
      return {
        title: "This checkout was not completed",
        body: "Stripe did not take a payment for it, so nothing was charged. You can start again from the plans.",
        actions: accentLink(PRICING_PATH, "See the plans") + home,
      };
    case "ended":
      return {
        title: "This subscription was cancelled",
        body: "It was cancelled before an organization was set up on it, so there is nothing to set up. Stripe has the receipt and any refund.",
        actions: accentLink(PRICING_PATH, "See the plans") + home,
      };
    case "missing":
      return {
        title: "Nothing to confirm here",
        body: "This is the page Stripe returns you to after a payment, and this link is not for a payment of yours. If you paid, your organization is waiting on your organizations page.",
        actions: accentLink("/", "Go to your organizations"),
      };
    case "signedout":
      return {
        title: "Sign in to finish",
        body: "Your payment is safe. Sign in with the account you paid with, and your organization will be waiting for you to set up.",
        actions: accentLink("/", "Sign in"),
      };
    case "received":
      return {
        title: "Payment received",
        body: s.stopped
          ? "Your organization will be ready shortly. It is taking longer than usual, and you do not need to wait here: it will be on your organizations page when it is ready."
          : "Getting your organization ready. This takes a few seconds.",
        actions: s.stopped ? again + home : "",
      };
    default:
      // Not confirmed to this page YET. After a while it stops spinning in silence — and still never says "failed":
      // Stripe only sends a buyer here after it has taken the payment.
      return s.slow || s.stopped
        ? {
            title: "Payment received",
            body: "Your organization will be ready shortly. Stripe is taking longer than usual to confirm it with Trov, and you do not need to wait here: it will be on your organizations page when it is ready.",
            actions: s.stopped ? again + home : home,
          }
        : { title: "Confirming your payment", body: "This takes a few seconds. Keep this page open.", actions: "" };
  }
}

/**
 * The page Stripe returns the buyer to. It is a STEP of signing up — the one before naming the
 * organization — so it is the first-run card (people.ts, org-picker.ts, welcome.ts): the banner with what
 * is happening, the body with what to do, a foot, in front of the same backdrop (`backdrop`, from
 * render.ts `firstRunBackdrop`). `data-morph`: the poll repaints every two seconds, and the card and what
 * is behind it must not be rebuilt each time. `aria-live` on the card, so a screen reader hears each
 * change of state once.
 */
export function billingDonePage(s: BillingDoneUi, backdrop = ""): string {
  const c = copyOf(s);
  const waiting = !s.stopped && (s.phase === "confirming" || s.phase === "received");
  const plan = s.plan ? PLANS[s.plan].name : null;
  return `<div class="cnpy-orgs cnpy-billdone" data-morph="billing-done" data-billing-done="${s.phase}">
    ${backdrop}
    <div class="cnpy-orgs-col">
      <main${surface("overflow:hidden", { cls: "cnpy-orgs-card" })} role="status" aria-live="polite">
        <header class="cnpy-orgs-banner">
          <span class="cnpy-orgs-art" aria-hidden="true">${trovMark(230, "currentColor")}</span>
          <div style="position:relative;display:flex;align-items:center;gap:9px">${trovMark(20, "currentColor")}<span style="font-size:15px;font-weight:600;letter-spacing:-0.01em">Trov</span><span class="cnpy-onb-step">${esc(plan ? `Your ${plan} organization` : "Payment")}</span></div>
          <h1 style="position:relative;margin:20px 0 0;font-size:26px;font-weight:600;letter-spacing:-0.02em;line-height:1.2">${esc(c.title)}</h1>
        </header>
        <div class="cnpy-orgs-body cnpy-billdone-body">
          <p style="margin:0;font-size:14px;line-height:1.6;color:var(--fg-70);overflow-wrap:anywhere">${c.body}</p>
          ${waiting ? `<div style="display:flex;align-items:center;gap:10px;font-size:12.5px;color:var(--fg-55)">${SPINNER}<span>${s.phase === "received" || s.slow ? "Still working on it" : "Checking with Stripe"}</span></div>` : ""}
          ${c.actions ? `<div class="cnpy-billdone-acts">${c.actions}</div>` : ""}
        </div>
        <footer class="cnpy-orgs-foot"><span>Stripe sends the receipt. Trov never sees your card.</span></footer>
      </main>
    </div>
  </div>`;
}

// ── the poll ─────────────────────────────────────────────────────────────────

export interface BillingDoneHost {
  get(): BillingDoneUi | null;
  rerender(): void;
  /** `GET /api/billing/status`. Rejects with `{ status }` on a refusal. */
  ask(sessionId: string): Promise<BillingStatusResponse>;
  /** Leave the page (the grant is ready, or the organization exists). */
  go(href: string): void;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}

/** Every 2 s; "taking longer than usual" after 20 s; the poll rests after 2 minutes. */
export const BILLING_POLL = { everyMs: 2000, slowMs: 20_000, stopMs: 120_000 } as const;

/** One answer applied to the page's state. Returns true when there is nothing more to ask. */
export function applyBillingStatus(s: BillingDoneUi, r: BillingStatusResponse): boolean {
  if (r.state === "pending") { if (r.paid) s.phase = "received"; return false; }
  if (r.state === "ready") { s.phase = "ready"; s.plan = r.plan; s.grant = r.grant; return true; }
  if (r.state === "done") { s.phase = "done"; s.org = r.org; return true; }
  s.phase = r.state;
  return true;
}

/** Poll until the purchase is settled. Resolves when it stops; the settled card is where the buyer goes on from. */
export async function startBillingDone(h: BillingDoneHost): Promise<void> {
  const now = h.now ?? Date.now, wait = h.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const started = now();
  for (;;) {
    const s = h.get();
    if (!s || !s.sessionId || s.phase === "missing") return;
    try {
      if (applyBillingStatus(s, await h.ask(s.sessionId))) {
        // The card STAYS on "Payment received" with its one button: it is the confirmation that the payment
        // went through, and the buyer reads it and goes on when they choose. (It used to jump straight on,
        // so nobody ever saw it.)
        h.rerender();
        return;
      }
    } catch (e) {
      // api.ts: a 401 is its `Unauthorized` (no status); any other refusal carries one.
      const status = (e as { status?: number } | null)?.status ?? (e instanceof Error && e.message === "unauthorized" ? 401 : undefined);
      if (status === 401) { s.phase = "signedout"; h.rerender(); return; }
      if (status === 404) { s.phase = "missing"; h.rerender(); return; }
      // Anything else (a network blip, a 5xx, billing switched off): the payment is not in doubt — keep waiting.
    }
    const waited = now() - started;
    s.slow = waited >= BILLING_POLL.slowMs;
    if (waited >= BILLING_POLL.stopMs) { s.stopped = true; h.rerender(); return; }
    h.rerender();
    await wait(BILLING_POLL.everyMs);
  }
}

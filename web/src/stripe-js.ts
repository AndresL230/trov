// Stripe.js, loaded on the payment page and NOWHERE else (docs/architecture/billing.md › Embedded checkout).
// It is a third party's script: it must come from js.stripe.com itself (Stripe's rule — never bundled, never
// self-hosted), it sets Stripe's own cookies, and it is why the Privacy Policy names it. So nothing imports
// this module but web/src/main.ts's `/billing/checkout` boot, and the tag is injected only when that page
// asks (test/render.billing-checkout.test.ts holds both).
//
// No npm dependency: the one call Trov makes is "mount this Checkout Session here".

/** The one URL the script is ever loaded from. `v3` is Stripe's evergreen build. */
export const STRIPE_JS_URL = "https://js.stripe.com/v3/";
export const STRIPE_JS_TIMEOUT_MS = 15_000;

/** What `mount` is called on: Stripe puts its iframe inside the node and sizes it to the form. */
export interface EmbeddedCheckout { mount(node: HTMLElement): void; destroy?(): void }
/** The two names Stripe.js has had for the same call; Trov uses whichever is there. */
interface StripeInstance {
  createEmbeddedCheckoutPage?(o: { fetchClientSecret: () => Promise<string> }): Promise<EmbeddedCheckout>;
  initEmbeddedCheckout?(o: { fetchClientSecret: () => Promise<string> }): Promise<EmbeddedCheckout>;
}
type StripeFactory = (publishableKey: string) => StripeInstance;

/** Stripe's embedded form for ONE Checkout Session. The client secret is handed straight to Stripe.js. */
export interface StripeEmbedder { embed(clientSecret: string): Promise<EmbeddedCheckout> }

const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e instanceof Error ? e : new Error(what)); });
  });

function inject(doc: Document, win: { Stripe?: unknown }): Promise<StripeFactory> {
  return new Promise<StripeFactory>((resolve, reject) => {
    const ready = () => (typeof win.Stripe === "function" ? resolve(win.Stripe as StripeFactory) : reject(new Error("Stripe.js loaded without Stripe")));
    if (typeof win.Stripe === "function") { ready(); return; }
    const tag = doc.createElement("script");
    tag.src = STRIPE_JS_URL;
    tag.async = true;
    tag.setAttribute("data-stripe-js", "");
    tag.addEventListener("load", ready);
    tag.addEventListener("error", () => { tag.remove(); reject(new Error("Stripe.js did not load")); });
    doc.head.appendChild(tag);
  });
}

/**
 * Load Stripe.js (once) and answer an embedder for `publishableKey` — Stripe's PUBLIC key. Rejects when the
 * script is blocked, fails, or does not answer in time: the page then offers Stripe's hosted checkout.
 */
export async function loadStripeEmbedder(publishableKey: string, doc: Document = document, win: { Stripe?: unknown } = window as unknown as { Stripe?: unknown }, timeoutMs = STRIPE_JS_TIMEOUT_MS): Promise<StripeEmbedder> {
  const factory = await withTimeout(inject(doc, win), timeoutMs, "Stripe.js");
  const stripe = factory(publishableKey);
  // `initEmbeddedCheckout` first: it is the call that belongs to the `ui_mode: "embedded"` sessions the pinned
  // API version (src/billing/stripe.ts) creates; the newer name is the fallback should Stripe retire it.
  const init = stripe.initEmbeddedCheckout?.bind(stripe) ?? stripe.createEmbeddedCheckoutPage?.bind(stripe);
  if (!init) throw new Error("this Stripe.js has no embedded checkout");
  return { embed: (clientSecret) => withTimeout(init({ fetchClientSecret: () => Promise.resolve(clientSecret) }), timeoutMs, "Stripe's form") };
}

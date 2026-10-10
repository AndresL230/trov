/**
 * The payment page of embedded checkout (docs/architecture/billing.md › Embedded checkout), as markup and
 * as its controller: `/billing/checkout`, Stripe's form mounted in the first-run card. Every state it can
 * be in; the node Stripe mounts into, which a repaint must never rebuild; where the client secret goes
 * (to Stripe.js, and nowhere else); and that Stripe.js is loaded from js.stripe.com on this page alone.
 */
import { describe, it, expect } from "vitest";
import {
  BILLING_MOUNT_ID, BILLING_PREVIEW_REFUSAL, billingCheckoutBackHref, billingCheckoutHosted, billingCheckoutPage, billingCheckoutRefusal, initialBillingCheckout, startBillingCheckout,
  type BillingCheckoutHost, type BillingCheckoutPhase, type BillingCheckoutUi,
} from "../web/src/billing-checkout";
import { billingDonePage, initialBillingDone, BILLING_FOOT } from "../web/src/billing";
import { STRIPE_JS_URL, loadStripeEmbedder } from "../web/src/stripe-js";
import { ApiError, OrgApiError, PreviewBlocked, Unauthorized, askBillingCheckout, setWriteBlock } from "../web/src/api";
import { initialState, render } from "../web/src/render";
import { landingView } from "../web/src/landing";
import { PRIVACY } from "../web/src/legal";
import type { BillingCheckoutRequest, BillingCheckoutResponse } from "@shared/billing";

const sources = import.meta.glob("../web/src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const html = import.meta.glob("../web/*.html", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const css = (import.meta.glob("../web/src/trov.css", { query: "?raw", import: "default", eager: true }) as Record<string, string>)["../web/src/trov.css"];

const ui = (query = "plan=team", o: Partial<BillingCheckoutUi> = {}): BillingCheckoutUi => ({ ...initialBillingCheckout(new URLSearchParams(query))!, ...o });
const PHASES: BillingCheckoutPhase[] = ["loading", "form", "failed", "expired", "refused"];
const SECRET = "cs_test_9_secret_0123456789abcdef0123456789abcdef0123456789abcdef";
const PK = "pk_test_51TrovPublic";
const embedded: BillingCheckoutResponse = { ui: "embedded", client_secret: SECRET, publishable_key: PK, session_id: "cs_test_9" };
/** The tags of a fragment, in order, with nothing else — what morph pairs children by. */
const shape = (s: string): string => [...s.matchAll(/<\/?([a-z0-9]+)/g)].map((m) => m[0]).join("");
const between = (s: string, from: string, to: string): string => s.slice(s.indexOf(from), s.indexOf(to, s.indexOf(from)));

describe("the page's state, read from its own URL", () => {
  it("takes the plan, the interval, the organization and the session from the query — and nothing it does not recognise", () => {
    expect(ui()).toEqual({ plan: "team", interval: "month", org: null, sessionId: null, phase: "loading", refusal: null, hosting: false, hostedError: null });
    expect(ui("plan=team&interval=year&org=maya-free&session=cs_test_a1B2")).toMatchObject({ interval: "year", org: "maya-free", sessionId: "cs_test_a1B2" });
    expect(ui("plan=team&interval=decade&org=../etc&session=<script>")).toMatchObject({ interval: "month", org: null, sessionId: null });
    for (const q of ["", "plan=enterprise", "plan=free", "plan=personal", "session=cs_test_1"]) expect(initialBillingCheckout(new URLSearchParams(q)), q).toBeNull();
    expect([billingCheckoutBackHref(ui()), billingCheckoutBackHref(ui("plan=team&org=maya-free"))]).toEqual(["/pricing", "/maya-free/#org/general"]);
  });
});

describe("billingCheckoutPage — the same bannered first-run card as the confirmation step", () => {
  it("is the first-run card over the backdrop, titled for the plan, with the foot line the confirmation card uses and a quiet Back link", () => {
    const page = billingCheckoutPage(ui(), '<div class="cnpy-fr-bg">BACKDROP</div>');
    const done = billingDonePage(initialBillingDone("cs_test_1"), "");
    for (const cls of ["cnpy-orgs", "cnpy-orgs-col", "cnpy-orgs-card", "cnpy-orgs-banner", "cnpy-orgs-art", "cnpy-orgs-body", "cnpy-orgs-foot", "cnpy-onb-step"]) {
      expect(page, cls).toContain(cls);
      expect(done, cls).toContain(cls);
    }
    expect(page).toContain("BACKDROP");
    expect(page).toContain('data-morph="billing-checkout"');
    expect(page).toContain(">Pay for Pro</h1>");
    expect(page).toContain("Your Pro organization");
    expect(page).toContain(`<span>${BILLING_FOOT}</span>`);
    expect(done).toContain(`<span>${BILLING_FOOT}</span>`);
    expect(page).toMatch(/<a class="cnpy-mutelink" data-billing-back href="\/pricing"[^>]*>Back<\/a>/);
    // An upgrade says so, names the organization, and goes back to its Plan block.
    const up = billingCheckoutPage(ui("plan=team&org=maya-free"));
    expect(up).toContain(">Upgrade to Pro</h1>");
    expect(up).toContain("Pro · maya-free");
    expect(up).toContain('data-billing-back href="/maya-free/#org/general"');
    // No price, no amount: those are Stripe's, in its form.
    expect(page).not.toMatch(/\$\s?\d/);
  });

  it("loading: a skeleton in the form's place and one spoken line; mounted: the skeleton rule is off and the node holds the form", () => {
    const loading = billingCheckoutPage(ui());
    expect(loading).toContain('data-billco-phase="loading"');
    expect(loading).toMatch(/<div class="cnpy-billco-skel" aria-hidden="true">/);
    expect((loading.match(/class="cnpy-sk"/g) ?? []).length).toBeGreaterThan(8);
    expect(loading).toMatch(/<div class="cnpy-billco-wait" role="status">.*Opening Stripe's secure form/s);
    expect(loading).toMatch(/<div class="cnpy-billco-note" role="presentation" hidden>/);
    const form = billingCheckoutPage(ui("plan=team", { phase: "form" }));
    expect(form).toContain('data-billco-phase="form"');
    expect(form).toMatch(/<div class="cnpy-billco-wait" role="status" hidden>/);
    expect(form).toMatch(/<div class="cnpy-billco-stage">/);
    // The stylesheet is what swaps them (state is an attribute, never a missing node).
    expect(css).toContain('[data-billco-phase="loading"] .cnpy-billco-mount { display:none; }');
    expect(css).toContain('[data-billco-phase="form"] .cnpy-billco-skel { display:none; }');
    expect(css).toContain(".cnpy-billco [hidden] { display:none !important; }");
  });

  it("Stripe.js failed: a plain message, a button that falls back to Stripe's hosted checkout, and Try again on the same session", () => {
    const failed = billingCheckoutPage(ui("plan=team&org=maya-free&session=cs_test_9", { phase: "failed" }));
    expect(failed).toContain(">The payment form did not open</h1>");
    expect(failed).toContain("Nothing was charged.");
    expect(failed).toMatch(/<div class="cnpy-billco-note" role="alert">/);
    expect(failed).toMatch(/<div class="cnpy-billco-stage" hidden>/);
    expect(failed).toMatch(/<button type="button" data-act="billingHosted" data-field="billingHosted" class="cnpy-accentbtn"[^>]*>Continue on Stripe's page<\/button>/);
    expect(failed).toContain('href="/billing/checkout?plan=team&amp;org=maya-free&amp;session=cs_test_9"');
    const busy = billingCheckoutPage(ui("plan=team", { phase: "failed", hosting: true }));
    expect(busy).toMatch(/data-act="billingHosted"[^>]* disabled aria-busy="true"[^>]*>Opening Stripe…</);
    const refused = billingCheckoutPage(ui("plan=team", { phase: "failed", hostedError: "Trov could not reach <Stripe> just now." }));
    expect(refused).toContain("Trov could not reach &lt;Stripe&gt; just now.");
  });

  it("expired: start again (a NEW session — the old id is dropped) or back; refused: the reason, escaped, and Try again only when trying again can help", () => {
    const expired = billingCheckoutPage(ui("plan=team&interval=year", { phase: "expired" }));
    expect(expired).toContain(">This checkout expired</h1>");
    expect(expired).toMatch(/<a href="\/billing\/checkout\?plan=team&amp;interval=year" data-billing-go[^>]*>Start again<\/a>/);
    expect(expired).toContain(">See the plans</a>");
    const limited = billingCheckoutPage(ui("plan=team", { phase: "refused", refusal: { title: "Too many <checkouts> today", body: "Try <again> tomorrow.", retry: false } }));
    expect(limited).toContain("Too many &lt;checkouts&gt; today</h1>");
    expect(limited).toContain("Try &lt;again&gt; tomorrow.");
    expect(limited).not.toContain(">Try again</a>");
    expect(billingCheckoutPage(ui("plan=team", { phase: "refused", refusal: { title: "t", body: "b", retry: true } }))).toContain(">Try again</a>");
  });

  it("the node Stripe mounts into is `data-keep`, byte-identical and in the SAME place in every phase — a repaint can never rebuild it", () => {
    const mount = `<div class="cnpy-billco-mount" id="${BILLING_MOUNT_ID}" data-keep data-billing-mount></div>`;
    const bodies = PHASES.map((phase) => {
      const page = billingCheckoutPage(ui("plan=team&session=cs_test_9", { phase, refusal: { title: "t", body: "b", retry: true }, hostedError: phase === "failed" ? "x" : null }), "<i>bg</i>");
      expect(page.split(mount), phase).toHaveLength(2);
      // The first child of the stage, so nothing before it can shift its index.
      expect(page, phase).toMatch(new RegExp(`<div class="cnpy-billco-stage"( hidden)?>${mount.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      return page;
    });
    // Outside the note (whose buttons are the one thing that differs), every phase has the same elements in the same order.
    const frame = (p: string) => shape(p.slice(0, p.indexOf('<div class="cnpy-billco-note"'))) + "…" + shape(p.slice(p.indexOf("<footer")));
    for (const p of bodies) expect(frame(p)).toBe(frame(bodies[0]));
    // …and the note itself always holds the same three children.
    for (const p of bodies) expect(shape(between(p, '<div class="cnpy-billco-note"', "<footer")).replace(/<(a|button)<\/\1/g, "")).toBe("<div<p</p<div</div<p</p</div</div");
    // morph.ts is what honours `data-keep`.
    expect(sources["../web/src/morph.ts"]).toContain('if (live.hasAttribute("data-keep")) return;');
  });

  it("the card is wide enough for Stripe's form, sits at the top and scrolls with the page — nothing inside it scrolls", () => {
    expect(css).toMatch(/\.cnpy-billco > \.cnpy-orgs-col \{ max-width:(\d+)px; \}/);
    expect(Number(/\.cnpy-billco > \.cnpy-orgs-col \{ max-width:(\d+)px; \}/.exec(css)![1])).toBeGreaterThanOrEqual(660);
    expect(css).toContain(".cnpy-billco { align-items:flex-start;");
    const rules = css.split("\n").filter((l) => /^\.cnpy-billco|^\[data-billco-phase/.test(l)).join("\n");
    expect(rules).not.toMatch(/overflow\s*:\s*(auto|scroll)|max-height|[^-]height\s*:\s*\d/);
    // No font size of an existing screen is touched: the page's own rules set only the wait line's.
    expect(rules.match(/font-size:[^;]+/g)).toEqual(["font-size:12.5px"]);
  });

  it("render(): the payment page is what the app draws while its state is set, on the real-app backdrop", () => {
    const s = initialState();
    s.billingCheckout = ui();
    const page = render(s);
    expect(page).toContain('data-morph="billing-checkout"');
    expect(page).toContain("cnpy-fr-bg");
    expect(page).not.toContain('data-morph="billing-done"');
  });
});

// ── the controller ───────────────────────────────────────────────────────────

function host(s: BillingCheckoutUi, answers: (BillingCheckoutResponse | Error)[], o: { stripe?: "ok" | "blocked" | "nomount" | "throws"; node?: boolean } = {}) {
  const log = { asked: [] as BillingCheckoutRequest[], went: [] as string[], urls: [] as string[], keys: [] as string[], secrets: [] as string[], mounted: [] as unknown[], paints: [] as string[] };
  const node = { id: BILLING_MOUNT_ID } as unknown as HTMLElement;
  const h: BillingCheckoutHost = {
    get: () => s,
    rerender: () => { log.paints.push(billingCheckoutPage(s)); },
    ask: async (_s, req) => { log.asked.push(req); const a = answers.shift(); if (!a) throw new Error("no answer"); if (a instanceof Error) throw a; return a; },
    stripe: async (key) => {
      log.keys.push(key);
      if (o.stripe === "blocked") throw new Error("Stripe.js did not load");
      return { embed: async (secret) => { log.secrets.push(secret); if (o.stripe === "nomount") throw new Error("init failed"); return { mount: (n) => { if (o.stripe === "throws") throw new Error("mount failed"); log.mounted.push(n); } }; } };
    },
    mountNode: () => (o.node === false ? null : node),
    go: (href) => { log.went.push(href); },
    setUrl: (href) => { log.urls.push(href); },
  };
  return { h, log, node };
}

describe("startBillingCheckout — ask for the session, load Stripe.js, mount", () => {
  it("mounts Stripe's form in the kept node with the client secret, and puts the SESSION (never the secret) in the address bar", async () => {
    const s = ui("plan=team&interval=year");
    const { h, log, node } = host(s, [embedded]);
    await startBillingCheckout(h);
    expect(log.asked).toEqual([{ plan: "team", interval: "year", ui: "embedded" }]);
    expect(log.keys).toEqual([PK]);
    expect(log.secrets).toEqual([SECRET]);
    expect(log.mounted).toEqual([node]);
    expect(log.urls).toEqual(["/billing/checkout?plan=team&interval=year&session=cs_test_9"]);
    expect(log.went).toEqual([]);
    expect(s).toMatchObject({ phase: "form", sessionId: "cs_test_9" });
    // The secret is in no state the page keeps, no markup it painted and no URL it wrote.
    for (const text of [JSON.stringify(s), ...log.paints, ...log.urls]) expect(text).not.toContain("_secret_");
    // Painted "form" BEFORE mounting: Stripe measures a node that is on screen.
    expect(log.paints.at(-1)).toContain('data-billco-phase="form"');
  });

  it("a reload asks about the session in its URL; an upgrade asks the organization's own route", async () => {
    const s = ui("plan=team&org=maya-free&session=cs_test_9");
    const { h, log } = host(s, [embedded]);
    await startBillingCheckout(h);
    expect(log.asked).toEqual([{ plan: "team", interval: "month", ui: "embedded", session_id: "cs_test_9" }]);
    expect(log.urls).toEqual(["/billing/checkout?plan=team&org=maya-free&session=cs_test_9"]);
    const asked: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => { asked.push(`${init?.method} ${String(url)} ${String(init?.body)}`); return Response.json({ ui: "expired" }); }) as typeof fetch;
    try {
      await askBillingCheckout("maya-free", { plan: "team", ui: "embedded" });
      await askBillingCheckout(null, { plan: "team", ui: "hosted", session_id: "cs_test_9" });
    } finally { globalThis.fetch = realFetch; }
    expect(asked).toEqual(['POST /api/o/maya-free/billing/upgrade {"plan":"team","ui":"embedded"}', 'POST /api/billing/checkout {"plan":"team","ui":"hosted","session_id":"cs_test_9"}']);
  });

  it("embedded off → Stripe's hosted page; already paid → the waiting room (no form, no Stripe.js); expired → says so and forgets the session", async () => {
    const hosted = host(ui(), [{ ui: "hosted", url: "https://checkout.stripe.com/c/pay/cs_test_1" }]);
    await startBillingCheckout(hosted.h);
    expect(hosted.log.went).toEqual(["https://checkout.stripe.com/c/pay/cs_test_1"]);
    const paid = host(ui("plan=team&session=cs_test_9"), [{ ui: "complete", session_id: "cs_test_9" }]);
    await startBillingCheckout(paid.h);
    expect(paid.log.went).toEqual(["/billing/done?session_id=cs_test_9"]);
    const gone = ui("plan=team&session=cs_test_9");
    const expired = host(gone, [{ ui: "expired" }]);
    await startBillingCheckout(expired.h);
    expect(gone).toMatchObject({ phase: "expired", sessionId: null });
    for (const t of [hosted, paid, expired]) expect([t.log.keys, t.log.mounted, t.log.urls]).toEqual([[], [], []]);
  });

  it.each(["blocked", "nomount", "throws"] as const)("Stripe.js %s → the failed state, with the fallback offered and nothing about the error shown", async (how) => {
    const s = ui();
    const { h, log } = host(s, [embedded], { stripe: how });
    await startBillingCheckout(h);
    expect(s.phase).toBe("failed");
    expect(log.paints.at(-1)).toContain('data-act="billingHosted"');
    expect(log.paints.at(-1)).not.toMatch(/did not load<|init failed|mount failed|_secret_/);
    expect(log.went).toEqual([]);
  });

  it("no node to mount into is the failed state too, not a silent blank card", async () => {
    const s = ui();
    await startBillingCheckout(host(s, [embedded], { node: false }).h);
    expect(s.phase).toBe("failed");
  });

  it("a refusal is somewhere to go or a sentence — never 'payment failed'", async () => {
    const run = async (query: string, e: Error) => { const s = ui(query); const t = host(s, [e]); await startBillingCheckout(t.h); return { s, went: t.log.went }; };
    // Signed out: the purchase link (which signs them in and comes back); an upgrade: the organization.
    expect((await run("plan=team&interval=year", new Unauthorized())).went).toEqual(["/billing/start?plan=team&interval=year"]);
    expect((await run("plan=team&org=maya-free", new Unauthorized())).went).toEqual(["/maya-free/"]);
    // Already on a paid plan (Back after paying for an upgrade): its Plan block.
    expect((await run("plan=team&org=maya-free", new OrgApiError(409, "not_free", null, null))).went).toEqual(["/maya-free/#org/general"]);
    const cases: [Error, string, boolean][] = [
      [new ApiError(429, "rate_limited"), "Too many checkouts today", false],
      [new ApiError(503, "billing_unavailable"), "Paid plans are not available yet", false],
      [new ApiError(403, "superadmin"), "You run this Trov", false],
      [new ApiError(403, "forbidden"), "Only an owner can pay for this", false],
      [new ApiError(404, "not_found"), "Nothing to pay for here", false],
      [new ApiError(502, "billing_failed"), "The payment page did not open", true],
      [new TypeError("Failed to fetch"), "The payment page did not open", true],
    ];
    for (const [e, title, retry] of cases) {
      const { s, went } = await run("plan=team", e);
      expect([s.phase, s.refusal?.title, s.refusal?.retry, went], title).toEqual(["refused", title, retry, []]);
      expect(s.refusal!.body, title).toMatch(/Nothing was charged|without paying/);
      expect(`${s.refusal!.title} ${s.refusal!.body}`.toLowerCase(), title).not.toMatch(/payment failed|declined/);
    }
    expect(billingCheckoutRefusal(ui(), new ApiError(500, "500"))).toMatchObject({ retry: true });
  });
});

describe("under the state preview (web/src/preview.ts) — nothing can be paid", () => {
  it("the page says so plainly and asks nothing: no session, no Stripe.js, no navigation", async () => {
    const s = ui("plan=team&session=cs_test_9");
    const { h, log } = host(s, [embedded]);
    h.preview = () => true;
    await startBillingCheckout(h);
    expect(s).toMatchObject({ phase: "refused", refusal: BILLING_PREVIEW_REFUSAL });
    expect([log.asked, log.keys, log.mounted, log.went, log.urls]).toEqual([[], [], [], [], []]);
    expect(log.paints.at(-1)).toContain(">Nothing can be paid in a preview</h1>");
    expect(log.paints.at(-1)).toContain("nothing was charged");
    expect(log.paints.at(-1)).not.toContain(">Try again</a>");
    // The app draws that card, not a projected screen, while a preview is on.
    const app = initialState();
    app.preview = "empty";
    app.billingCheckout = s;
    expect(render(app)).toContain(">Nothing can be paid in a preview</h1>");
  });

  it("a write the preview refuses in api.ts (the fallback pressed, say) is the same sentence, never 'could not reach Stripe'", async () => {
    setWriteBlock(() => undefined);
    try {
      const blocked = await askBillingCheckout(null, { plan: "team", ui: "embedded" }).catch((e: unknown) => e);
      expect(blocked).toBeInstanceOf(PreviewBlocked);
      expect(billingCheckoutRefusal(ui(), blocked)).toBe(BILLING_PREVIEW_REFUSAL);
    } finally { setWriteBlock(null); }
    expect(sources["../web/src/main.ts"]).toMatch(/preview: \(\) => state\.preview !== null/);
  });
});

describe("billingCheckoutHosted — the fallback", () => {
  it("asks for a hosted session for the same purchase and goes to Stripe; pressed twice it asks once", async () => {
    const s = ui("plan=team&org=maya-free&session=cs_test_9", { phase: "failed" });
    const { h, log } = host(s, [{ ui: "hosted", url: "https://checkout.stripe.com/c/pay/cs_test_2" }]);
    const first = billingCheckoutHosted(h);
    void billingCheckoutHosted(h);
    expect(log.paints.at(-1)).toContain("Opening Stripe…");
    await first;
    expect(log.asked).toEqual([{ plan: "team", interval: "month", ui: "hosted", session_id: "cs_test_9" }]);
    expect(log.went).toEqual(["https://checkout.stripe.com/c/pay/cs_test_2"]);
  });

  it("a session that turns out to be paid goes to the waiting room; a refusal is one sentence and the button works again", async () => {
    const paid = host(ui("plan=team&session=cs_test_9", { phase: "failed" }), [{ ui: "complete", session_id: "cs_test_9" }]);
    await billingCheckoutHosted(paid.h);
    expect(paid.log.went).toEqual(["/billing/done?session_id=cs_test_9"]);
    const s = ui("plan=team", { phase: "failed" });
    const t = host(s, [new ApiError(502, "billing_failed"), { ui: "hosted", url: "https://checkout.stripe.com/c/pay/cs_test_3" }]);
    await billingCheckoutHosted(t.h);
    expect(s).toMatchObject({ phase: "failed", hosting: false, hostedError: "Trov could not reach Stripe just now. Nothing was charged. Try again in a minute." });
    expect(t.log.paints.at(-1)).toContain("Continue on Stripe's page");
    await billingCheckoutHosted(t.h);
    expect(t.log.went).toEqual(["https://checkout.stripe.com/c/pay/cs_test_3"]);
  });
});

// ── Stripe.js ────────────────────────────────────────────────────────────────

/** Just enough of a document for the loader: one <head> that records what is appended to it. */
function fakeDoc(onAppend: (tag: FakeTag) => void) {
  return { createElement: () => new FakeTag(), head: { appendChild: (t: FakeTag) => { onAppend(t); return t; } } } as unknown as Document;
}
class FakeTag {
  src = ""; async = false; attrs: Record<string, string> = {}; removed = false;
  private on: Record<string, () => void> = {};
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  addEventListener(k: string, f: () => void) { this.on[k] = f; }
  remove() { this.removed = true; }
  fire(k: "load" | "error") { this.on[k]?.(); }
}

describe("Stripe.js — from js.stripe.com, on the payment page only", () => {
  it("injects ONE script from js.stripe.com and hands the client secret straight to Stripe's embedded checkout", async () => {
    const tags: FakeTag[] = [];
    const win: { Stripe?: unknown } = {};
    const seen: { key?: string; secret?: string } = {};
    const p = loadStripeEmbedder(PK, fakeDoc((t) => tags.push(t)), win);
    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatchObject({ src: "https://js.stripe.com/v3/", async: true });
    expect(new URL(STRIPE_JS_URL).origin).toBe("https://js.stripe.com");
    win.Stripe = (key: string) => { seen.key = key; return { initEmbeddedCheckout: async (o: { fetchClientSecret: () => Promise<string> }) => { seen.secret = await o.fetchClientSecret(); return { mount() { /* Stripe's */ } }; } }; };
    tags[0].fire("load");
    await (await p).embed(SECRET);
    expect(seen).toEqual({ key: PK, secret: SECRET });
    // Already there (a second call): no second tag.
    await loadStripeEmbedder(PK, fakeDoc((t) => tags.push(t)), win);
    expect(tags).toHaveLength(1);
  });

  it("uses Stripe's newer name for the same call when the old one is gone, and refuses a Stripe.js with neither", async () => {
    let called = "";
    const win = { Stripe: () => ({ createEmbeddedCheckoutPage: async () => { called = "new"; return { mount() { /* Stripe's */ } }; } }) };
    await (await loadStripeEmbedder(PK, fakeDoc(() => undefined), win)).embed(SECRET);
    expect(called).toBe("new");
    await expect(loadStripeEmbedder(PK, fakeDoc(() => undefined), { Stripe: () => ({}) })).rejects.toThrow(/no embedded checkout/);
  });

  it("a blocked script, one that loads without Stripe, and one that never answers all reject — the page then offers the hosted checkout", async () => {
    const tags: FakeTag[] = [];
    const blocked = loadStripeEmbedder(PK, fakeDoc((t) => tags.push(t)), {});
    tags[0].fire("error");
    await expect(blocked).rejects.toThrow(/did not load/);
    expect(tags[0].removed).toBe(true); // so Try again injects a fresh one
    const empty = loadStripeEmbedder(PK, fakeDoc((t) => tags.push(t)), {});
    tags[1].fire("load");
    await expect(empty).rejects.toThrow(/without Stripe/);
    await expect(loadStripeEmbedder(PK, fakeDoc(() => undefined), {}, 5)).rejects.toThrow(/timed out/);
    const hung = { Stripe: () => ({ initEmbeddedCheckout: () => new Promise<never>(() => undefined) }) };
    await expect((await loadStripeEmbedder(PK, fakeDoc(() => undefined), hung, 5)).embed(SECRET)).rejects.toThrow(/timed out/);
  });

  it("is named in ONE module, imported by the payment page's boot alone — never the landing, the app shell or a static page", () => {
    // (releases.ts is prose: its patch notes name the URL.)
    const naming = Object.entries(sources).filter(([path, src]) => src.includes("js.stripe.com") && !path.endsWith("/releases.ts")).map(([path]) => path);
    expect(naming).toEqual(["../web/src/stripe-js.ts"]);
    const importing = Object.entries(sources).filter(([, src]) => /from "\.\/stripe-js"/.test(src)).map(([path]) => path).sort();
    expect(importing).toEqual(["../web/src/billing-checkout.ts", "../web/src/main.ts"]);
    // billing-checkout.ts takes only its TYPE; main.ts calls it from the payment page's host and nowhere else.
    expect(sources["../web/src/billing-checkout.ts"]).toContain('import type { StripeEmbedder } from "./stripe-js";');
    const main = sources["../web/src/main.ts"];
    expect(main.match(/loadStripeEmbedder\(/g)).toHaveLength(1);
    expect(main).toMatch(/stripe: \(publishableKey\) => loadStripeEmbedder\(publishableKey\)/);
    expect(main).toMatch(/location\.pathname === BILLING_CHECKOUT_PATH\) \{[^}]*initialBillingCheckout\(params\)/s);
    expect(main.match(/startBillingCheckout\(/g)).toHaveLength(1);
    // No page ships a Stripe script tag, and no npm dependency carries one in.
    for (const [path, page] of Object.entries(html)) expect(page, path).not.toMatch(/stripe/i);
    expect(landingView({ dark: false, signInOpen: true, signedIn: false, seen: new Set<string>(), feature: null } as never)).not.toContain("js.stripe.com");
    const s = initialState();
    expect(render(s)).not.toContain("js.stripe.com");
  });

  it("the Privacy Policy says Stripe's script runs on the payment page, only there, and sets Stripe's cookies", () => {
    const text = JSON.stringify(PRIVACY);
    expect(text).toContain("Stripe.js");
    expect(text).toMatch(/Its script \(Stripe\.js\) runs on Trov's payment page, and only there/);
    expect(text).toMatch(/Stripe's script runs there to show its payment form, and sets Stripe's own cookies/);
    expect(PRIVACY.updated).toBe("2026-10-09");
  });
});

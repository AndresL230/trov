#!/usr/bin/env node
// A local stand-in for Stripe, for walking Trov's paid flows on your own machine with no Stripe account,
// no keys and no network: `node scripts/dev/stripe-standin.mjs`, and in `.dev.vars`
//
//   STRIPE_SECRET_KEY=sk_test_local_standin
//   STRIPE_WEBHOOK_SECRET=whsec_local_standin
//   STRIPE_TEST_API_BASE=http://127.0.0.1:8842
//
// (src/billing/config.ts honours STRIPE_TEST_API_BASE only for a loopback http origin and never with a
// live key.) It answers the handful of endpoints src/billing/ calls, the way Stripe does — the same set
// the test suite's FakeStripe answers (test/helpers/billing.ts) — and serves two plain pages in place of
// Stripe's own: a checkout ("Pay") and a customer portal (change seats, cancel, resume, end now). Each
// button changes the stand-in's state, delivers the signed webhook Stripe would send, and sends the
// browser back to Trov. Nothing here is Stripe, and nothing here can charge anyone.
//
// State is kept in memory and in a JSON file beside the OS temp dir, so a restart of the stand-in does
// not orphan the subscriptions your local database already points at.

import { createServer } from "node:http";
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.STRIPE_STANDIN_PORT ?? 8842);
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_local_standin";
const STATE_FILE = join(tmpdir(), "trov-stripe-standin.json");
const BASE = `http://127.0.0.1:${PORT}`;

/** @type {{ sessions: Record<string, any>, subscriptions: Record<string, any>, portals: Record<string, any>, n: number }} */
let db = { sessions: {}, subscriptions: {}, portals: {}, n: 0 };
try { db = { ...db, ...JSON.parse(readFileSync(STATE_FILE, "utf8")) }; } catch { /* first run */ }
const save = () => { try { writeFileSync(STATE_FILE, JSON.stringify(db)); } catch { /* memory only */ } };
const id = (prefix) => `${prefix}_local_${++db.n}_${randomBytes(4).toString("hex")}`;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const now = () => Math.floor(Date.now() / 1000);

const sessionJson = (s) => ({
  id: s.id, object: "checkout.session", url: s.status === "open" ? s.url : null, status: s.status, payment_status: s.payment_status, mode: s.mode,
  subscription: s.subscription, customer: s.customer, customer_email: s.customer_email, client_reference_id: s.client_reference_id, metadata: s.metadata, livemode: false,
});
const subscriptionJson = (s) => ({
  id: s.id, object: "subscription", customer: s.customer, status: s.status, cancel_at_period_end: s.cancel_at_period_end, cancel_at: s.cancel_at,
  current_period_end: s.current_period_end, livemode: false, metadata: {},
  items: { object: "list", data: [{ id: s.item, object: "subscription_item", price: { id: s.price, object: "price" }, quantity: s.quantity, current_period_end: s.current_period_end }] },
});

/** Deliver one event to Trov's webhook, signed the way Stripe signs (`t=…,v1=hmac(t.body)`). */
async function deliver(origin, type, object) {
  const body = JSON.stringify({ id: id("evt"), object: "event", type, livemode: false, created: now(), data: { object } });
  const t = now();
  const v1 = createHmac("sha256", WEBHOOK_SECRET).update(`${t}.${body}`).digest("hex");
  try {
    const res = await fetch(`${origin}/webhook/stripe`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": `t=${t},v1=${v1}` }, body });
    console.log(`  webhook ${type} -> ${res.status}`);
  } catch (e) {
    console.log(`  webhook ${type} not delivered (${e instanceof Error ? e.message : e}); Trov's status route asks the stand-in itself`);
  }
}

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Stripe stand-in</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:#f6f6f7;color:#16161a;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.card{width:min(440px,100%);background:#fff;border-radius:8px;box-shadow:0 0 0 1px rgba(20,22,60,.08),0 12px 40px -12px rgba(20,22,60,.18);overflow:hidden}
.tag{padding:8px 24px;background:#fff7e0;color:#7a5b00;font-size:12px;border-bottom:1px solid rgba(20,22,60,.08)}
.body{padding:22px 24px 24px}h1{margin:0 0 4px;font-size:20px;letter-spacing:-.01em}p{margin:6px 0;color:#4f4f58}
dl{margin:16px 0;display:grid;grid-template-columns:auto 1fr;gap:6px 16px}dt{color:#6e6e78}dd{margin:0;font-weight:600;text-align:right}
form{margin:10px 0 0;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
input[type=number]{width:84px;padding:9px 10px;border:1px solid rgba(20,20,30,.2);border-radius:6px;font:inherit}
button,a.btn{flex:1 1 auto;padding:10px 14px;border-radius:6px;border:1px solid rgba(20,20,30,.2);background:#fff;color:#16161a;font:inherit;font-weight:600;cursor:pointer;text-align:center;text-decoration:none}
button.primary{background:#5e6ad2;border-color:#5e6ad2;color:#fff}button.danger{color:#c53030}
hr{border:0;border-top:1px solid rgba(20,22,60,.08);margin:18px 0}
</style></head><body><main class="card"><div class="tag">Local stand-in for Stripe. No real payment, no real card.</div><div class="body">${body}</div></main></body></html>`;

const readBody = (req) => new Promise((resolve) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => resolve(b)); });
const json = (res, status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
const html = (res, markup, status = 200) => { res.writeHead(status, { "content-type": "text/html; charset=utf-8" }); res.end(markup); };
const redirect = (res, to) => { res.writeHead(303, { location: to }); res.end(); };
const notFound = (res) => json(res, 404, { error: { type: "invalid_request_error", code: "resource_missing", message: "No such object" } });

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", BASE);
  const method = (req.method ?? "GET").toUpperCase();
  const params = method === "GET" ? url.searchParams : new URLSearchParams(await readBody(req));
  console.log(`${method} ${url.pathname}`);

  // ── the API Trov's Worker calls ────────────────────────────────────────────
  if (url.pathname.startsWith("/v1/")) {
    if (!/^Bearer (sk|rk)_test_/.test(req.headers.authorization ?? "")) return json(res, 401, { error: { type: "invalid_request_error", message: "Invalid API Key provided" } });
    if (method === "POST" && url.pathname === "/v1/checkout/sessions") {
      const key = String(req.headers["idempotency-key"] ?? "");
      const held = Object.values(db.sessions).find((s) => key && s.idem === key);
      if (held) return json(res, 200, sessionJson(held));
      const sid = id("cs_test");
      const metadata = {};
      for (const [k, v] of params) { const m = /^metadata\[(\w+)\]$/.exec(k); if (m) metadata[m[1]] = v; }
      const s = {
        id: sid, idem: key, url: `${BASE}/pay/${sid}`, status: "open", payment_status: "unpaid", mode: params.get("mode") ?? "subscription",
        subscription: null, customer: params.get("customer"), customer_email: params.get("customer_email"), client_reference_id: params.get("client_reference_id"),
        metadata, price: params.get("line_items[0][price]") ?? "", quantity: Number(params.get("line_items[0][quantity]") ?? "1"),
        max: Number(params.get("line_items[0][adjustable_quantity][maximum]") ?? "50"),
        success_url: params.get("success_url") ?? "", cancel_url: params.get("cancel_url") ?? "",
      };
      db.sessions[sid] = s; save();
      return json(res, 200, sessionJson(s));
    }
    let m = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && m) return db.sessions[m[1]] ? json(res, 200, sessionJson(db.sessions[m[1]])) : notFound(res);
    m = /^\/v1\/subscriptions\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && m) return db.subscriptions[m[1]] ? json(res, 200, subscriptionJson(db.subscriptions[m[1]])) : notFound(res);
    if (method === "POST" && url.pathname === "/v1/billing_portal/sessions") {
      const pid = id("bps");
      db.portals[pid] = {
        customer: params.get("customer") ?? "", return_url: params.get("return_url") ?? "",
        flow: params.get("flow_data[type]"), after: params.get("flow_data[after_completion][redirect][return_url]"),
      };
      save();
      return json(res, 200, { id: pid, object: "billing_portal.session", url: `${BASE}/portal/${pid}` });
    }
    return json(res, 400, { error: { type: "invalid_request_error", message: `the stand-in has no ${method} ${url.pathname}` } });
  }

  // ── in place of Stripe Checkout ────────────────────────────────────────────
  let m = /^\/pay\/([^/]+)$/.exec(url.pathname);
  if (m) {
    const s = db.sessions[m[1]];
    if (!s) return html(res, page("Not found", "<h1>No such checkout</h1>"), 404);
    if (method === "GET") {
      if (s.status !== "open") return html(res, page("Already paid", `<h1>This checkout is complete</h1><p><a class="btn" href="${esc(s.success_url.replace("{CHECKOUT_SESSION_ID}", s.id))}">Back to Trov</a></p>`));
      return html(res, page("Checkout", `<h1>Subscribe to Trov Pro</h1><p>$10.00 per seat, per month.</p>
        <dl><dt>Email</dt><dd>${esc(s.customer_email ?? "(none)")}</dd><dt>Price</dt><dd>${esc(s.price)}</dd></dl>
        <form method="post"><label for="q">Seats</label><input id="q" type="number" name="quantity" min="1" max="${s.max}" value="${s.quantity}"><button class="primary" name="do" value="pay">Pay (test)</button></form>
        <hr><a class="btn" href="${esc(s.cancel_url)}">Cancel and go back</a>`));
    }
    const quantity = Math.max(1, Math.min(s.max, Number(params.get("quantity") ?? s.quantity) || s.quantity));
    const sub = {
      id: id("sub"), customer: s.customer ?? id("cus"), status: "active", cancel_at_period_end: false, cancel_at: null,
      current_period_end: now() + 30 * 86400, price: s.price, item: id("si"), quantity,
    };
    db.subscriptions[sub.id] = sub;
    Object.assign(s, { status: "complete", payment_status: "paid", subscription: sub.id, customer: sub.customer, quantity });
    save();
    const success = s.success_url.replace("{CHECKOUT_SESSION_ID}", s.id);
    await deliver(new URL(success).origin, "checkout.session.completed", sessionJson(s));
    return redirect(res, success);
  }

  // ── in place of the Customer Portal ────────────────────────────────────────
  m = /^\/portal\/([^/]+)$/.exec(url.pathname);
  if (m) {
    const p = db.portals[m[1]];
    if (!p) return html(res, page("Not found", "<h1>No such portal session</h1>"), 404);
    const sub = Object.values(db.subscriptions).filter((x) => x.customer === p.customer).at(-1);
    const back = p.after ?? p.return_url;
    if (method === "GET") {
      const flow = p.flow === "subscription_update" ? "Change seats" : p.flow === "subscription_cancel" ? "Cancel plan" : "Manage billing";
      if (!sub) return html(res, page(flow, `<h1>${flow}</h1><p>No subscription for this customer.</p><a class="btn" href="${esc(p.return_url)}">Back to Trov</a>`));
      const ends = new Date(sub.current_period_end * 1000).toDateString();
      const seats = `<form method="post"><label for="q">Seats</label><input id="q" type="number" name="quantity" min="1" max="50" value="${sub.quantity}"><button class="primary" name="do" value="seats">Update seats</button></form>`;
      const cancel = sub.cancel_at_period_end
        ? `<form method="post"><button name="do" value="resume">Resume the subscription</button></form>`
        : `<form method="post"><button class="danger" name="do" value="cancel">Cancel at the end of the period</button></form>`;
      const end = `<form method="post"><button class="danger" name="do" value="end">End it now (as if the period ran out)</button></form>`;
      return html(res, page(flow, `<h1>${flow}</h1>
        <dl><dt>Plan</dt><dd>Trov Pro</dd><dt>Status</dt><dd>${esc(sub.status)}${sub.cancel_at_period_end ? " (cancels at period end)" : ""}</dd><dt>Seats</dt><dd>${sub.quantity}</dd><dt>${sub.cancel_at_period_end ? "Ends" : "Renews"}</dt><dd>${esc(ends)}</dd></dl>
        ${sub.status === "canceled" ? "" : p.flow === "subscription_cancel" ? cancel : p.flow === "subscription_update" ? seats : seats + cancel + end}
        <hr><a class="btn" href="${esc(p.return_url)}">Back to Trov</a>`));
    }
    if (!sub) return redirect(res, p.return_url);
    const action = params.get("do");
    let type = "customer.subscription.updated";
    if (action === "seats") sub.quantity = Math.max(1, Math.min(50, Number(params.get("quantity") ?? sub.quantity) || sub.quantity));
    else if (action === "cancel") { sub.cancel_at_period_end = true; sub.cancel_at = sub.current_period_end; }
    else if (action === "resume") { sub.cancel_at_period_end = false; sub.cancel_at = null; }
    else if (action === "end") { sub.status = "canceled"; sub.cancel_at_period_end = false; type = "customer.subscription.deleted"; }
    save();
    await deliver(new URL(p.return_url).origin, type, subscriptionJson(sub));
    // Stripe returns to Trov by itself only from a flow with `after_completion`; the plain portal stays put.
    return p.after && (action === "seats" || action === "cancel") ? redirect(res, back) : redirect(res, `${BASE}/portal/${m[1]}`);
  }

  if (url.pathname === "/") return html(res, page("Stand-in", `<h1>Stripe stand-in</h1><p>${Object.keys(db.sessions).length} checkouts, ${Object.keys(db.subscriptions).length} subscriptions. State: ${esc(STATE_FILE)}</p>`));
  return html(res, page("Not found", "<h1>Not found</h1>"), 404);
}).listen(PORT, "127.0.0.1", () => console.log(`Stripe stand-in on ${BASE} (state: ${STATE_FILE})`));

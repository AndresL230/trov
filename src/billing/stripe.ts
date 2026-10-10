// THE Stripe client: the only code in Trov that sends the secret key anywhere, and the only place it is
// sent is api.stripe.com (docs/architecture/billing.md › Safety). Plain `fetch` — no SDK: the handful of
// calls Trov makes are form-encoded POSTs and GETs, and the SDK would be most of the Worker's bundle.
//
//   • the host is fixed (`BillingConfig.apiBase`: api.stripe.com, or a loopback stand-in in a test);
//   • redirects are not followed, so the Authorization header cannot travel to another origin;
//   • every call has a timeout, a pinned `Stripe-Version`, and — when it mutates — an `Idempotency-Key`;
//   • every failure is a `StripeError` whose message was SCRUBBED of the key (and of the webhook secret)
//     before it was cut — so nothing that logs, stores or returns it can leak either.
//   • a 2xx that holds the key anywhere in its body is refused whole: its ids are never read, so the key
//     cannot reach a D1 column by way of a field Trov stores.
//
// Nothing reachable from src/mcp.ts imports this file (test/secrets.mcp.test.ts): an agent's token never
// reaches a payment call.
import { scrub } from "../data/secrets";
import type { BillingConfig } from "./config";

/** Pinned: a Stripe account's default version moves, and the shapes ./sync.ts reads must not move with it. */
export const STRIPE_VERSION = "2024-06-20";
const TIMEOUT_MS = 10_000;
const MAX_ERROR_BYTES = 8192;
const MESSAGE_CHARS = 300;

export type StripeFailure = "http" | "network" | "timeout" | "shape";
export class StripeError extends Error {
  /** `status` is Stripe's HTTP status (0 when no answer came); `code` its own error code, when it gave one. */
  constructor(readonly kind: StripeFailure, readonly status: number, readonly code: string | null, message: string) {
    super(message);
    this.name = "StripeError";
  }
}

export type FormValue = string | number | boolean | null | undefined | FormValue[] | { [k: string]: FormValue };

/** Stripe's form encoding: `a[b][0][c]=v`. `undefined` / `null` are left out. */
export function formEncode(params: Record<string, FormValue>): string {
  const out: string[] = [];
  const walk = (key: string, v: FormValue): void => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(`${key}[${i}]`, x));
    else if (typeof v === "object") for (const [k, x] of Object.entries(v)) walk(`${key}[${k}]`, x);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  };
  for (const [k, v] of Object.entries(params)) walk(k, v);
  return out.join("&");
}

/** A Checkout Session's client secret (embedded checkout), wherever an upstream message quotes one: it is
 *  the buyer's browser's alone, so it is cut out of anything that could be logged — by SHAPE, since Trov
 *  never keeps one to compare against. */
const CLIENT_SECRET = /\b[a-z]{2,8}_(?:test_|live_)?[A-Za-z0-9]+_secret_[A-Za-z0-9_%+/=-]+/g;

/** Scrubbed FIRST, then one line, then cut — a cut first could leave half a key behind. */
const clean = (cfg: BillingConfig, text: string): string =>
  scrub(text, [cfg.secretKey, cfg.webhookSecret]).replace(CLIENT_SECRET, "[client secret]").replace(/\s+/g, " ").trim().slice(0, MESSAGE_CHARS);

async function boundedText(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  // The chunk that crosses the cap is kept whole, so a key that straddles the cap is still there to be scrubbed.
  while (size < MAX_ERROR_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(all);
}

export interface StripeCallOpts {
  /** REQUIRED on a POST: Stripe returns the first answer for a repeated key, so a retry creates nothing twice. */
  idempotencyKey?: string;
  fetchImpl?: typeof fetch;
}

/**
 * One call to Stripe. `path` is `/v1/…`. Resolves to the parsed JSON object of a 2xx; anything else —
 * a 4xx / 5xx, a redirect, a timeout, a network failure, a body that is not a JSON object — throws a
 * `StripeError` with a scrubbed message.
 */
export async function stripeCall<T>(cfg: BillingConfig, method: "GET" | "POST", path: string, params: Record<string, FormValue> = {}, opts: StripeCallOpts = {}): Promise<T> {
  if (!path.startsWith("/v1/")) throw new StripeError("shape", 0, null, "not a Stripe API path");
  if (method === "POST" && !opts.idempotencyKey) throw new StripeError("shape", 0, null, "a mutating Stripe call needs an idempotency key");
  const body = formEncode(params);
  const url = `${cfg.apiBase}${path}${method === "GET" && body ? `?${body}` : ""}`;
  const f = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(url, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${cfg.secretKey}`,
        "stripe-version": STRIPE_VERSION,
        ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded", "idempotency-key": opts.idempotencyKey! } : {}),
      },
      ...(method === "POST" ? { body } : {}),
    });
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    throw new StripeError(timedOut ? "timeout" : "network", 0, null, clean(cfg, `stripe ${method} ${path}: ${timedOut ? "timed out" : e instanceof Error ? e.message : "network error"}`));
  }
  if (!res.ok) {
    const text = await boundedText(res).catch(() => "");
    let code: string | null = null, said = "";
    try {
      const err = (JSON.parse(text) as { error?: { code?: unknown; type?: unknown; message?: unknown } }).error;
      code = typeof err?.code === "string" ? err.code : typeof err?.type === "string" ? err.type : null;
      said = typeof err?.message === "string" ? err.message : "";
    } catch { said = text; }
    throw new StripeError("http", res.status, code === null ? null : clean(cfg, code), clean(cfg, `stripe ${method} ${path}: ${res.status} ${said}`));
  }
  const text = await res.text().catch(() => "");
  // Stripe never sends the key back. An answer that holds it is not one to read ids out of: they would be stored.
  if (scrub(text, [cfg.secretKey, cfg.webhookSecret]) !== text) throw new StripeError("shape", res.status, null, `stripe ${method} ${path}: the answer echoed a credential`);
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new StripeError("shape", res.status, null, `stripe ${method} ${path}: not a JSON object`);
  return json as T;
}

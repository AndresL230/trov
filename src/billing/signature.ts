// Stripe's webhook signature (docs/architecture/billing.md › The webhook). The header is
//   Stripe-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>…][,v0=…]
// and a `v1` is HMAC-SHA256, keyed by the endpoint's secret, over `<t>.<raw body>`. Several `v1`s arrive
// while a secret is being rolled: any ONE that verifies is enough. A delivery older (or newer) than the
// tolerance is refused even with a good signature, so a captured delivery cannot be replayed later.
//
// Pure Web Crypto; no key but the one passed in. The comparison is `crypto.subtle.verify` — constant
// time. A malformed or absent header is `false`; nothing here throws.

/** Five minutes, Stripe's own default. */
export const SIGNATURE_TOLERANCE_S = 300;
/** More `v1`s than a secret roll ever sends are not checked (each one is an HMAC). */
const MAX_SIGNATURES = 8;

export interface ParsedSignature { timestamp: number; v1: string[] }

export function parseStripeSignature(header: string | null): ParsedSignature | null {
  if (!header || header.length > 2048) return null;
  let timestamp: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === "t" && /^\d{1,12}$/.test(v)) timestamp = Number(v);
    else if (k === "v1" && /^[0-9a-f]{64}$/i.test(v) && v1.length < MAX_SIGNATURES) v1.push(v.toLowerCase());
  }
  return timestamp === null || v1.length === 0 ? null : { timestamp, v1 };
}

const hexBytes = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

/** Is `rawBody` a delivery Stripe signed with `secret`, within the tolerance of `nowMs`? */
export async function verifyStripeSignature(secret: string, rawBody: string, header: string | null, nowMs: number = Date.now(), toleranceS: number = SIGNATURE_TOLERANCE_S): Promise<boolean> {
  if (!secret) return false;
  const sig = parseStripeSignature(header);
  if (!sig) return false;
  if (Math.abs(Math.floor(nowMs / 1000) - sig.timestamp) > toleranceS) return false;
  try {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const signed = enc.encode(`${sig.timestamp}.${rawBody}`);
    let ok = false;
    // Every candidate is checked (no early exit): the time taken does not say which one matched.
    for (const hex of sig.v1) ok = (await crypto.subtle.verify("HMAC", key, hexBytes(hex), signed)) || ok;
    return ok;
  } catch {
    return false;
  }
}

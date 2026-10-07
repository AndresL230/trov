// The one way a hosting provider reaches the network (#97: "each provider needs its fixed-host allowlist
// and scrubbed errors, like the existing pollers").
//
//   hostFetch(hosts, …)   a fetch that refuses — BEFORE any request — a URL that is not https or whose
//                         hostname is not exactly one of `hosts`; never follows a redirect (`redirect:
//                         "manual"`: a 3xx is a failure, so a credential never travels to a second host);
//                         and bounds every request with a timeout.
//   HostingError          the only error a provider throws. Its message is scrubbed of the credential at
//                         construction, so whatever logs or stores it later cannot leak one.
//   failureReason         why an upstream refused, read from a bounded slice of its body, scrubbed BEFORE
//                         it is cut (a cut first could leave half a token behind).
//   readJson              a bounded JSON read: a provider never buffers an unbounded body.
//
// This file, ./types.ts, ./registry.ts and ./providers/* must NOT import src/data/secrets.ts — not even a
// type: the Repo dashboard projection reads the registry (labels, console links), it is reachable from
// src/mcp.ts, and nothing reachable from there may name the decrypt path (test/secrets.mcp.test.ts). So the
// scrub below is this layer's own copy of `scrub`'s rule, over anything with a `reveal()`.

/** A credential as this layer sees it: anything with `reveal()` (src/data/secrets.ts's `Secret`). */
export interface SecretLike { reveal(): string }
export type Revealed = string | SecretLike | null | undefined | readonly Revealed[];

const plainValues = (r: Revealed, out: string[] = []): string[] => {
  if (Array.isArray(r)) for (const x of r as readonly Revealed[]) plainValues(x, out);
  else if (typeof r === "string") out.push(r);
  else if (r && typeof r === "object" && "reveal" in r) out.push((r as SecretLike).reveal());
  return out;
};

/** Replace every revealed value (and its URL-encoded spelling) with `[redacted]` — src/data/secrets.ts
 *  `scrub`'s rule. Every message that may quote an upstream goes through here BEFORE it is cut. */
export function scrub(text: string, revealed: Revealed): string {
  const values = new Set<string>();
  for (const v of plainValues(revealed)) {
    if (!v) continue;
    values.add(v);
    values.add(encodeURIComponent(v));
  }
  return [...values].sort((a, b) => b.length - a.length).reduce((m, v) => m.split(v).join("[redacted]"), text);
}

export type HostFetch = (url: string, init?: RequestInit) => Promise<Response>;

export const HOSTING_TIMEOUT_MS = 10_000;
const REASON_READ_BYTES = 8192;
const REASON_CHARS = 160;
export const JSON_READ_BYTES = 2_000_000;

/** A provider's refusal / failure. `message` is fixed text or already scrubbed — safe to log and store. */
export class HostingError extends Error {
  constructor(message: string, revealed: Revealed = null) {
    super(scrub(message, revealed).replace(/\s+/g, " ").trim().slice(0, 300));
    this.name = "HostingError";
  }
}

/** Thrown by `hostFetch` itself: the URL was refused before anything was sent. */
export class HostRefusedError extends HostingError {
  constructor(why: string) { super(`refused to send the credential: ${why}`); this.name = "HostRefusedError"; }
}

/**
 * A fetch bound to `hosts` (exact, lower-case hostnames). Every request: https only, no userinfo, the
 * hostname in the allowlist, no redirect followed, a timeout. Tests pass `fetchImpl`; it is still wrapped,
 * so a test also proves the allowlist holds.
 */
export function hostFetch(hosts: readonly string[], fetchImpl: typeof fetch = fetch, timeoutMs: number = HOSTING_TIMEOUT_MS): HostFetch {
  const allowed = new Set(hosts.map((h) => h.toLowerCase()));
  return async (url: string, init: RequestInit = {}): Promise<Response> => {
    let u: URL;
    try { u = new URL(url); } catch { throw new HostRefusedError("not a URL"); }
    if (u.protocol !== "https:") throw new HostRefusedError("not https");
    if (u.username || u.password) throw new HostRefusedError("the URL carries credentials");
    if (!allowed.has(u.hostname.toLowerCase())) throw new HostRefusedError(`${u.hostname} is not one of the provider's API hosts`);
    if (u.port && u.port !== "443") throw new HostRefusedError("not the default https port");
    // `await`, so a fetch that throws synchronously (a test stub) rejects THIS promise, never floats one.
    return await fetchImpl(u.toString(), { ...init, redirect: "manual", signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
  };
}

async function readCapped(res: Response, cap: number): Promise<{ text: string; cut: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { text: "", cut: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cut = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    if (size + value.byteLength > cap) { chunks.push(value.subarray(0, cap - size)); size = cap; cut = true; break; }
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return { text: new TextDecoder().decode(all), cut };
}

const longest = (revealed: Revealed): number => {
  if (Array.isArray(revealed)) return Math.max(0, ...(revealed as readonly Revealed[]).map(longest));
  if (typeof revealed === "string") return revealed.length;
  return revealed && typeof revealed === "object" && "reveal" in revealed ? (revealed as SecretLike).reveal().length : 0;
};

const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * `": <reason>"` from a refused response's body (or `""`): a JSON `error.message` / `errors[0].message` /
 * `message` / `error`, else the raw text. Read to at most 8 KB, scrubbed WHOLE first; when the read was
 * cut, the tail a straddling credential could hide in is dropped too. One line, ≤ 160 characters.
 */
export async function failureReason(res: Response, revealed: Revealed): Promise<string> {
  let text = "";
  try {
    const read = await readCapped(res, REASON_READ_BYTES);
    text = scrub(read.text, revealed);
    if (read.cut) text = text.slice(0, Math.max(0, text.length - 3 * longest(revealed) - 4));
  } catch { return ""; }
  let reason = "";
  try {
    const body = record(JSON.parse(text));
    const err = body.error;
    const first = (typeof err === "object" ? record(err).message : err)
      ?? record(Array.isArray(body.errors) ? body.errors[0] : null).message
      ?? body.message;
    if (typeof first === "string") reason = first;
  } catch { /* not JSON: the raw text */ }
  reason = (reason || text).replace(/\s+/g, " ").trim().slice(0, REASON_CHARS);
  return reason ? `: ${reason}` : "";
}

/** Fixed words for an HTTP status a provider commonly answers — appended after the reason. */
export function statusHint(status: number, hints: Readonly<Record<number, string>> = {}): string {
  if (hints[status]) return ` — ${hints[status]}`;
  if (status === 401) return " — the credential is not valid";
  if (status === 403) return " — the credential lacks the permission this read needs";
  if (status === 404) return " — not found (check the id, and that the credential can see it)";
  if (status === 429) return " — rate limited; the next poll retries";
  if (status >= 300 && status < 400) return " — a redirect is never followed";
  return "";
}

/**
 * Throw a `HostingError` describing a non-2xx answer: `<what> <status>: <reason> — <hint>`. Use it as
 * `if (!res.ok) await refuse("vercel deployments", res, secret)`.
 */
export async function refuse(what: string, res: Response, revealed: Revealed, hints?: Readonly<Record<number, string>>): Promise<never> {
  const reason = res.status >= 300 && res.status < 400 ? "" : await failureReason(res, revealed);
  if (res.status >= 300 && res.status < 400) await res.body?.cancel().catch(() => undefined);
  throw new HostingError(`${what} ${res.status}${reason}${statusHint(res.status, hints)}`, revealed);
}

/** A bounded JSON read of a 2xx body. A body over `cap` or not JSON is a `HostingError` (never quoted). */
export async function readJson(res: Response, what: string, cap: number = JSON_READ_BYTES): Promise<unknown> {
  const { text, cut } = await readCapped(res, cap);
  if (cut) throw new HostingError(`${what}: the response is larger than ${Math.round(cap / 1000)} KB`);
  try { return JSON.parse(text) as unknown; } catch { throw new HostingError(`${what}: the response is not JSON`); }
}

/**
 * A thrown fetch / parse, as a `HostingError` whose message is NEVER the original: a fetch error may
 * repeat the request and a JSON SyntaxError quotes a slice of the body — a slice can hold PART of a
 * credential, which no whole-value scrub would catch. A `HostingError` passes through unchanged.
 */
export function asHostingError(what: string, e: unknown): HostingError {
  if (e instanceof HostingError) return e;
  const name = e instanceof Error ? e.name : "";
  if (name === "TimeoutError" || name === "AbortError") return new HostingError(`${what}: the request timed out`);
  if (name === "SyntaxError") return new HostingError(`${what}: the response is not JSON`);
  return new HostingError(`${what}: the request failed`);
}

// ── small parsing helpers every provider uses ────────────────────────────────

export const HOUR = 3_600_000;
export const hourFloor = (ms: number): number => Math.floor(ms / HOUR) * HOUR;
export const iso = (ms: number): string => new Date(ms).toISOString();

/** How long an hour must have been CLOSED before it is read: a provider's figures for the hour that just
 *  ended may still be filling in, and a stored point is permanent (first write wins). */
export const SETTLE_MS = 15 * 60_000;
/** Hours one poll reads, so a missed tick (or two) heals on the next one. */
export const POLL_HOURS = 3;
/**
 * THE metric window every provider reads: the last `POLL_HOURS` COMPLETE hours that have been closed for
 * at least `SETTLE_MS`, `[from, to)`, both hour-aligned. A re-poll at any minute of the same hour asks for
 * the same hours, so an on-demand poll and the cron write the same rows.
 */
export function pollWindow(now: number): { from: number; to: number } {
  const to = hourFloor(now - SETTLE_MS);
  return { from: to - POLL_HOURS * HOUR, to };
}

export { record };
export const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
export const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** An instant from a provider: epoch ms, epoch seconds (< 1e12), or an ISO string → ISO, else null. */
export function instant(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return iso(v < 1e12 ? v * 1000 : v);
  if (typeof v === "string" && v) { const t = Date.parse(v); return Number.isNaN(t) ? null : iso(t); }
  return null;
}
/** A finite, non-negative value under `max`, or null — every stored point goes through this. */
export const sane = (v: unknown, max: number): number | null => {
  const n = typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n < max ? n : null;
};

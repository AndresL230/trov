// The SSRF-guarded fetch behind `POST /api/artifacts/fetch` (issue #52 · Track B; spec:
// docs/superpowers/specs/2026-09-24-artifacts-implementation.md, "SSRF guard limit").
//
// The New-artifact screen's "From URL" tab: fetch a TEXT document, return it with an
// inferred kind, store NOTHING. The guard:
//   • https only; no credentials in the URL;
//   • hostnames `localhost` / `*.localhost` / `*.local` / `*.internal` refused;
//   • literal IPv4 private / loopback / link-local / CGNAT / 0.0.0.0/8 / multicast /
//     reserved refused (the WHATWG parser has already normalised decimal / hex / octal
//     spellings into a dotted quad), and literal IPv6 unspecified / loopback / ULA /
//     link-local / IPv4-mapped / IPv4-compatible / NAT64 refused;
//   • `redirect: "manual"` — every hop (≤ 3) is re-checked HERE before it is followed;
//   • one `AbortSignal.timeout(5000)` across all hops;
//   • at most 750 KB of body is read — past that the stream is cancelled and the call
//     refused (413), never buffered;
//   • text content types only.
// Workers cannot resolve DNS before `fetch`, so a public name that RESOLVES to a private
// address (DNS rebinding) is not closable here — Cloudflare's egress not reaching RFC1918
// space is the backstop. `fetchImpl` is injected so tests never touch the network.

import { ARTIFACT_EXT_KIND, ARTIFACT_TEXT_CAP, isTextKind, type ArtifactFetchDTO, type ArtifactTextKind } from "@shared/artifacts";

export const FETCH_TIMEOUT_MS = 5_000;
export const FETCH_MAX_BYTES = ARTIFACT_TEXT_CAP;
export const FETCH_MAX_REDIRECTS = 3;

export type FetchUrlErrorCode = "bad_request" | "too_large" | "bad_gateway";

/** A refused or failed fetch. `status` is the HTTP status the route answers with. */
export class FetchUrlError extends Error {
  constructor(readonly code: FetchUrlErrorCode, message: string) {
    super(message);
    this.name = "FetchUrlError";
  }
  get status(): 400 | 413 | 502 {
    return this.code === "bad_request" ? 400 : this.code === "too_large" ? 413 : 502;
  }
}

// ── the address guard (pure) ─────────────────────────────────────────────────

function ipv4Blocked(host: string): boolean | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return true;
  return (
    a === 0 ||                              // 0.0.0.0/8 ("this network")
    a === 10 ||                             // RFC1918
    a === 127 ||                            // loopback
    (a === 100 && b >= 64 && b <= 127) ||   // CGNAT 100.64/10
    (a === 169 && b === 254) ||             // link-local (cloud metadata lives here)
    (a === 172 && b >= 16 && b <= 31) ||    // RFC1918
    (a === 192 && b === 168) ||             // RFC1918
    (a === 192 && b === 0 && Number(m[3]) === 0) || // IETF protocol assignments
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224                                // multicast + reserved + broadcast
  );
}

/** The 8 16-bit groups of an IPv6 literal (brackets stripped), or null when it is not one. */
export function expandIpv6(host: string): number[] | null {
  let h = host.toLowerCase();
  if (!h.includes(":")) return null;
  const pct = h.indexOf("%");
  if (pct >= 0) h = h.slice(0, pct);
  // A trailing dotted quad (::ffff:1.2.3.4) → two hex groups.
  const q = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (q) {
    const o = q.slice(2).map(Number);
    if (o.some((n) => n > 255)) return null;
    h = `${q[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = h.split("::");
  if (halves.length > 2) return null;
  const parse = (s: string) => (s === "" ? [] : s.split(":"));
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

function ipv6Blocked(host: string): boolean | null {
  const g = expandIpv6(host);
  if (!g) return host.includes(":") ? true : null; // an unparseable v6-looking host: refuse
  const zeros = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeros(8)) return true;                                   // ::
  if (zeros(7) && g[7] === 1) return true;                     // ::1
  if ((g[0] & 0xfe00) === 0xfc00) return true;                 // fc00::/7 ULA
  if ((g[0] & 0xffc0) === 0xfe80) return true;                 // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true;                 // fec0::/10 site-local (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return true;                 // multicast
  if (zeros(5) && g[5] === 0xffff) return true;                // ::ffff:a.b.c.d IPv4-mapped
  if (zeros(6)) return true;                                   // ::a.b.c.d IPv4-compatible
  if (g[0] === 0x64 && g[1] === 0xff9b) return true;           // 64:ff9b::/96 NAT64
  return false;
}

/**
 * Parse and vet one URL (the first request or a redirect hop). Throws a `bad_request`
 * FetchUrlError naming why; returns the parsed URL when it may be fetched.
 */
export function checkFetchUrl(input: string | URL, base?: string | URL): URL {
  let u: URL;
  try {
    u = new URL(input, base);
  } catch {
    throw new FetchUrlError("bad_request", "not a valid URL");
  }
  if (u.protocol !== "https:") throw new FetchUrlError("bad_request", "only https URLs can be fetched");
  if (u.username || u.password) throw new FetchUrlError("bad_request", "URLs with credentials are refused");
  let host = u.hostname.toLowerCase().replace(/\.+$/, "");
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (!host) throw new FetchUrlError("bad_request", "the URL has no host");
  const blocked = (why: string) => new FetchUrlError("bad_request", `that address is not reachable from Trov (${why})`);
  if (host === "localhost" || host.endsWith(".localhost")) throw blocked("localhost");
  if (host === "local" || host.endsWith(".local") || host === "internal" || host.endsWith(".internal")) throw blocked("private name");
  const v4 = ipv4Blocked(host);
  if (v4 === true) throw blocked("private address");
  if (v4 === null && ipv6Blocked(host)) throw blocked("private address");
  return u;
}

// ── kind + content-type rules ────────────────────────────────────────────────

const TEXT_TYPES = new Set([
  "image/svg+xml", "application/xhtml+xml", "application/xml", "application/json", "application/x-mermaid",
]);
const isTextType = (ct: string): boolean => ct.startsWith("text/") || TEXT_TYPES.has(ct);

/** html / svg / markdown / mermaid from the content type, else the URL's extension, else null. */
export function inferFetchedKind(contentType: string, url: URL): ArtifactTextKind | null {
  const ct = contentType.split(";")[0].trim().toLowerCase();
  if (ct === "text/html" || ct === "application/xhtml+xml") return "html";
  if (ct === "image/svg+xml") return "svg";
  if (ct === "text/markdown" || ct === "text/x-markdown") return "markdown";
  if (ct === "text/vnd.mermaid" || ct === "application/x-mermaid") return "mermaid";
  const last = url.pathname.split("/").pop() ?? "";
  const ext = last.includes(".") ? (last.split(".").pop() ?? "").toLowerCase() : "";
  const k = ARTIFACT_EXT_KIND[ext];
  return k && isTextKind(k) ? k : null;
}

// ── the fetch ────────────────────────────────────────────────────────────────

async function readCapped(res: Response): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > FETCH_MAX_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    throw new FetchUrlError("too_large", `the document is larger than ${FETCH_MAX_BYTES} bytes`);
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > FETCH_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new FetchUrlError("too_large", `the document is larger than ${FETCH_MAX_BYTES} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

/**
 * Fetch `url` under the guard and return it as an `ArtifactFetchDTO` (nothing is stored).
 * Throws `FetchUrlError`: bad_request (refused address / scheme / type, too many
 * redirects), too_large (> 750 KB, ARTIFACT_TEXT_CAP), bad_gateway (network error, timeout, non-2xx).
 */
export async function fetchArtifactUrl(url: string, fetchImpl: typeof fetch = fetch): Promise<ArtifactFetchDTO> {
  let current = checkFetchUrl(url);
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  for (let hop = 0; ; hop++) {
    let res: Response;
    try {
      res = await fetchImpl(current.toString(), {
        method: "GET",
        redirect: "manual",
        signal,
        headers: { accept: "text/*, image/svg+xml, application/xhtml+xml;q=0.9, */*;q=0.1", "user-agent": "trov-artifact-fetch" },
      });
    } catch (e) {
      const timedOut = signal.aborted || (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError"));
      throw new FetchUrlError("bad_gateway", timedOut ? "the fetch timed out" : "the fetch failed");
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      await res.body?.cancel().catch(() => undefined);
      if (!loc) throw new FetchUrlError("bad_gateway", `HTTP ${res.status} without a Location`);
      if (hop >= FETCH_MAX_REDIRECTS) throw new FetchUrlError("bad_request", `more than ${FETCH_MAX_REDIRECTS} redirects`);
      current = checkFetchUrl(loc, current);
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new FetchUrlError("bad_gateway", `the server answered HTTP ${res.status}`);
    }
    const contentType = (res.headers.get("content-type") ?? "").trim();
    const base = contentType.split(";")[0].trim().toLowerCase();
    if (!base || !isTextType(base)) {
      await res.body?.cancel().catch(() => undefined);
      throw new FetchUrlError("bad_request", `not a text document (${base || "no content type"})`);
    }
    let bytes: Uint8Array;
    try {
      bytes = await readCapped(res);
    } catch (e) {
      if (e instanceof FetchUrlError) throw e;
      throw new FetchUrlError("bad_gateway", signal.aborted ? "the fetch timed out" : "the fetch failed");
    }
    return {
      url: current.toString(),
      content: new TextDecoder("utf-8").decode(bytes),
      content_type: contentType,
      size_bytes: bytes.byteLength,
      kind: inferFetchedKind(contentType, current),
    };
  }
}

// The agent download (issue #52 · Track F; spec:
// docs/superpowers/specs/2026-09-24-artifacts-implementation.md, contract:
// docs/artifact-contract.md): `GET /api/artifacts/download/:token`.
//
// The raw route is session-cookie only, so a bearer (an agent) could read TEXT content
// through `artifact_get` but never a binary's bytes. `artifact_get` now mints a signed,
// short-lived URL for EVERY kind, and this handler serves the exact stored bytes for it.
//
// THE TOKEN is stateless: `<b64u(JSON claims)>.<b64u(HMAC-SHA256)>`, claims
// `{ h: handle, p: page id, v: version_no, e: expiry ms }`. The key is DERIVED from
// COOKIE_SECRET with a purpose label (HMAC(COOKIE_SECRET, PURPOSE)) — never the cookie
// key itself, so a download signature can never pass as a session cookie, an
// unsubscribe token or anything else sealed with COOKIE_SECRET, and vice versa. Valid
// for `ARTIFACT_DOWNLOAD_TTL_MS` (5 minutes) and REUSABLE within it: a download changes
// nothing, so there is no ledger and no single-use row.
//
// AT DOWNLOAD TIME the page is re-checked for the token's principal through the
// repository (`readRawByPageId` → `readRaw`): a page made private after the URL was
// minted, or deleted, is the one `404 {"error":"not_found"}` — the same body as a
// forged or malformed token, so the route is never an existence oracle. A token whose
// signature verifies but whose expiry has passed is `410 {"error":"gone"}`; neither
// answer says which part of a bad token failed.
//
// THE RESPONSE is always an attachment with the stored bytes untouched (no height
// script), the stored content type, `X-Content-Type-Options: nosniff`, `Cache-Control:
// private, no-store`, and `default-src 'none'; frame-ancestors 'none'; sandbox` — so
// nothing it serves can ever run, or be framed, in the app's origin. Dispatched from
// src/index.ts BEFORE the Hono app and its sessionGate (the token IS the auth), like the
// upload PUT. The token is never logged here; nothing in this module logs at all.

import { ARTIFACT_DOWNLOAD_TTL_MS } from "@shared/artifacts";
import { b64uEncode, b64uDecode, b64uToBytes } from "../auth/crypto";
import { ArtifactError, readRawByPageId, type ArtifactRaw } from "../tools/artifacts";
import { NOT_FOUND_BODY } from "./http";
import { rawFilename } from "./raw";
import type { Env } from "../env";
import { resolveSoleTenant } from "../data/context";

export const DOWNLOAD_PREFIX = "/api/artifacts/download/";
/** Domain separation: the download key is HMAC(COOKIE_SECRET, PURPOSE), never COOKIE_SECRET itself. */
const PURPOSE = "trov/artifact-download/v1";
/** `<claims>.<sig>` — base64url, the signature exactly 32 bytes (43 chars). */
const TOKEN_RE = /^[A-Za-z0-9_-]{8,512}\.[A-Za-z0-9_-]{43}$/;

export const DOWNLOAD_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";

const enc = new TextEncoder();

const lockdown = (): Record<string, string> => ({
  "x-content-type-options": "nosniff",
  "cache-control": "private, no-store",
  "content-security-policy": DOWNLOAD_CSP,
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
});

function toB64u(bytes: ArrayBuffer): string {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function downloadKey(secret: string): Promise<CryptoKey> {
  const root = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const derived = await crypto.subtle.sign("HMAC", root, enc.encode(PURPOSE));
  return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export interface DownloadClaims { handle: string; page_id: number; version_no: number }

/** Mint a download token for `claims`, valid `ARTIFACT_DOWNLOAD_TTL_MS` from `now`. */
export async function mintDownloadToken(
  secret: string, claims: DownloadClaims, now = Date.now()
): Promise<{ token: string; expires_at: string }> {
  if (!secret) throw new Error("no download secret");
  const exp = now + ARTIFACT_DOWNLOAD_TTL_MS;
  const body = b64uEncode(JSON.stringify({ h: claims.handle, p: claims.page_id, v: claims.version_no, e: exp }));
  const sig = await crypto.subtle.sign("HMAC", await downloadKey(secret), enc.encode(body));
  return { token: `${body}.${toB64u(sig)}`, expires_at: new Date(exp).toISOString() };
}

export type DownloadVerdict = { ok: true; claims: DownloadClaims } | { ok: false; reason: "invalid" | "expired" };

/** Verify signature, shape and expiry. The signature is checked FIRST (constant-time `verify`). */
export async function verifyDownloadToken(secret: string, token: string, now = Date.now()): Promise<DownloadVerdict> {
  const invalid: DownloadVerdict = { ok: false, reason: "invalid" };
  if (!secret || !TOKEN_RE.test(token)) return invalid;
  const [body, sig] = token.split(".");
  let good = false;
  try {
    good = await crypto.subtle.verify("HMAC", await downloadKey(secret), b64uToBytes(sig), enc.encode(body));
  } catch {
    return invalid;
  }
  if (!good) return invalid;
  let c: { h?: unknown; p?: unknown; v?: unknown; e?: unknown };
  try {
    c = JSON.parse(b64uDecode(body));
  } catch {
    return invalid;
  }
  if (typeof c?.h !== "string" || !c.h || !Number.isInteger(c.p) || !Number.isInteger(c.v) || typeof c.e !== "number") return invalid;
  if (now >= c.e) return { ok: false, reason: "expired" };
  return { ok: true, claims: { handle: c.h, page_id: c.p as number, version_no: c.v as number } };
}

/** The name a download is saved under: the stored filename when there is one, else `<slug>-v<n>.<ext>`. */
export const downloadFilename = (r: Pick<ArtifactRaw, "slug" | "version_no" | "kind" | "content_type" | "filename">): string =>
  r.filename ? r.filename : rawFilename(r);

/** `attachment` with an ASCII fallback, plus RFC 5987 `filename*` when the name is not plain ASCII. */
export function attachmentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const plain = `attachment; filename="${ascii}"`;
  return ascii === name ? plain : `${plain}; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Whether src/index.ts should hand this request to `handleArtifactDownload`: a TOKEN-SHAPED path under the prefix. */
export function isDownloadRequest(pathname: string): boolean {
  if (!pathname.startsWith(DOWNLOAD_PREFIX)) return false;
  return TOKEN_RE.test(pathname.slice(DOWNLOAD_PREFIX.length));
}

const notFound = (): Response =>
  new Response(NOT_FOUND_BODY, { status: 404, headers: { "content-type": "application/json; charset=UTF-8", ...lockdown() } });

export async function handleArtifactDownload(request: Request, env: Env, now = Date.now()): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405, headers: { "content-type": "application/json; charset=UTF-8", allow: "GET, HEAD", ...lockdown() },
    });
  }
  const token = new URL(request.url).pathname.slice(DOWNLOAD_PREFIX.length);
  const verdict = await verifyDownloadToken(env.COOKIE_SECRET, token, now);
  if (!verdict.ok) {
    if (verdict.reason === "expired") {
      return new Response(JSON.stringify({ error: "gone" }), {
        status: 410, headers: { "content-type": "application/json; charset=UTF-8", ...lockdown() },
      });
    }
    return notFound();
  }
  const { handle, page_id, version_no } = verdict.claims;
  // MT: no session — the signed URL names the person artifact_get minted it for, so the tenant is that
  // person's ONE org (the bearer alias). Phase 5a puts the org in the token's claims. No org → the same
  // 404 as a page the person cannot see.
  const sole = await resolveSoleTenant(env, handle, "bearer");
  if (!sole.ok) return notFound();
  let r: ArtifactRaw;
  try {
    r = await readRawByPageId(sole.ctx, env.ARTIFACTS_BUCKET, page_id, version_no, handle);
  } catch (e) {
    if (e instanceof ArtifactError) return notFound();
    throw e;
  }
  const headers: Record<string, string> = {
    ...lockdown(),
    "content-type": r.content_type,
    "content-disposition": attachmentDisposition(downloadFilename(r)),
  };
  if (r.text !== null) {
    const bytes = enc.encode(r.text);
    headers["content-length"] = String(bytes.byteLength);
    return new Response(request.method === "HEAD" ? null : bytes, { status: 200, headers });
  }
  headers["content-length"] = String(r.object!.size);
  if (request.method === "HEAD") {
    await r.object!.body.cancel().catch(() => undefined);
    return new Response(null, { status: 200, headers });
  }
  return new Response(r.object!.body, { status: 200, headers });
}

// The binary upload PUT (issue #52 · Track B; spec:
// docs/superpowers/specs/2026-09-24-artifacts-implementation.md):
// `PUT /api/artifacts/upload/:token` — also the PUT for a doc image (MCP upload_asset,
// destination "doc"; src/tools/doc-images.ts), whose tokens are tried first. NO session — the single-use token minted by
// `POST /api/artifacts/upload-url` (or the MCP tools) IS the auth, so src/index.ts
// dispatches this BEFORE the Hono app and its `sessionGate`, like `/u/`.
//
// The body is handed to `consumeUploadToken` as a STREAM (FixedLengthStream → R2 with
// R2's own sha256 check); nothing buffers it here. 200 with the version result;
// 404 unknown token (the one `{"error":"not_found"}`); 410 used / expired; 413 a
// declared Content-Length over the binary cap (refused before the token is touched);
// 400 a body that does not match the declared size / sha256 (the token stays usable
// within its TTL). Any other method on a token path is 405.

import { ARTIFACT_BINARY_CAP } from "@shared/artifacts";
import { consumeUploadToken } from "../tools/artifacts";
import { consumeDocImageToken } from "../tools/doc-images";
import type { Env } from "../env";
import { sha256Hex } from "../auth/crypto";
import { platform, systemTenant } from "../data/context";
import { type PlatformContext, first } from "../data/platform-sql";
import { artifactErrorResponse, jsonResponse, NOT_FOUND_BODY } from "./http";

export const UPLOAD_PREFIX = "/api/artifacts/upload/";
/** A minted token: 32 random bytes, base64url, no padding. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Whether src/index.ts should hand this request to `handleArtifactUpload`: every PUT
 * under the prefix, and any other method on a TOKEN-SHAPED path (so it can 405). A
 * non-PUT on anything else — `GET /api/artifacts/upload/v2`, a page whose slug is
 * `upload` — falls through to the app.
 */
export function isUploadRequest(method: string, pathname: string): boolean {
  if (!pathname.startsWith(UPLOAD_PREFIX)) return false;
  const rest = pathname.slice(UPLOAD_PREFIX.length);
  if (!rest || rest.includes("/")) return false;
  return method === "PUT" || TOKEN_RE.test(rest);
}

/**
 * The org an upload token was minted in — a PLATFORM read, by hash, because the request carries nothing
 * else (the token/grant-by-hash exception of §4.4): a doc-image token or an artifact one. Null for an
 * unknown token, and for a token of a SUSPENDED org, which answers like an org that is not there.
 */
async function uploadTokenOrg(p: PlatformContext, token: string): Promise<string | null> {
  const hash = await sha256Hex(token);
  const row = await first<{ org_id: string }>(p,
    `SELECT t.org_id FROM (
       SELECT org_id FROM doc_image_upload_tokens WHERE token_hash = ?
       UNION ALL
       SELECT org_id FROM artifact_upload_tokens WHERE token_hash = ?
     ) t JOIN orgs o ON o.id = t.org_id AND o.suspended_at IS NULL LIMIT 1`, hash, hash);
  return row?.org_id ?? null;
}

export async function handleArtifactUpload(request: Request, env: Env): Promise<Response> {
  if (request.method !== "PUT") {
    return jsonResponse({ error: "method_not_allowed" }, 405, { allow: "PUT" });
  }
  const token = new URL(request.url).pathname.slice(UPLOAD_PREFIX.length);
  const len = request.headers.get("content-length");
  if (len !== null && Number(len) > ARTIFACT_BINARY_CAP) {
    return jsonResponse({ error: "too_large", message: `file exceeds ${ARTIFACT_BINARY_CAP} bytes` }, 413);
  }
  // No session: the single-use token is the auth, and its row names its org. Everything after this
  // lookup runs as that org's system tenant, so a token can only ever write where it was minted.
  const p = platform(env, "system");
  const orgId = await uploadTokenOrg(p, token);
  if (!orgId) return new Response(NOT_FOUND_BODY, { status: 404, headers: { "content-type": "application/json; charset=UTF-8" } });
  const ctx = systemTenant(p, orgId, "system");
  try {
    // ONE upload route for every asset: a doc-image token (MCP upload_asset with
    // destination "doc") is looked up first; any other token is an artifact's.
    const image = await consumeDocImageToken(ctx, env.ARTIFACTS_BUCKET, token, request.body);
    if (image) return jsonResponse(image, 200);
    const result = await consumeUploadToken(ctx, env.ARTIFACTS_BUCKET, token, request.body);
    return jsonResponse(result, 200);
  } catch (e) {
    const res = artifactErrorResponse(e);
    if (res) return res;
    console.error("artifact upload failed", e instanceof Error ? e.message : String(e));
    return jsonResponse({ error: "upload_failed" }, 502);
  }
}

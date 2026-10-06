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
import { legacySystemTenant } from "../data/legacy";
import { artifactErrorResponse, jsonResponse } from "./http";

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

export async function handleArtifactUpload(request: Request, env: Env): Promise<Response> {
  if (request.method !== "PUT") {
    return jsonResponse({ error: "method_not_allowed" }, 405, { allow: "PUT" });
  }
  const token = new URL(request.url).pathname.slice(UPLOAD_PREFIX.length);
  const len = request.headers.get("content-length");
  if (len !== null && Number(len) > ARTIFACT_BINARY_CAP) {
    return jsonResponse({ error: "too_large", message: `file exceeds ${ARTIFACT_BINARY_CAP} bytes` }, 413);
  }
  // MT: no session — the single-use token is the auth, and its row carries its org. Until this
  // resolves the org from that row (a platform lookup by hash), only the legacy org's tokens are
  // found here: another org's token is the unknown-token 404, never a cross-org write.
  const ctx = legacySystemTenant(env, "system");
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

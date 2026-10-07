// Shared HTTP plumbing for the artifact adapters (routes.ts, raw.ts, upload.ts): the ONE
// mapping from `ArtifactError` to a response. Every not-found cause — a missing slug, a
// page private to someone else, a version-0 page, a version out of range — answers the
// byte-identical `404 {"error":"not_found"}` (the spec's 404 parity).

import { ArtifactError, ARTIFACT_ERROR_STATUS } from "../tools/artifacts";
import { PlanLimitError, PLAN_LIMIT_STATUS } from "../plans/state";

export const NOT_FOUND_BODY = JSON.stringify({ error: "not_found" });

const JSON_HEADERS = { "content-type": "application/json; charset=UTF-8" };

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

/** An ArtifactError → its response; a plan refusal (0044_plans: the org's artifact storage is full) →
 *  402 with its body; anything else → null (the caller rethrows). */
export function artifactErrorResponse(e: unknown, headers: Record<string, string> = {}): Response | null {
  if (e instanceof PlanLimitError) return jsonResponse(e.refusal, PLAN_LIMIT_STATUS, headers);
  if (!(e instanceof ArtifactError)) return null;
  if (e.code === "not_found") return new Response(NOT_FOUND_BODY, { status: 404, headers: { ...JSON_HEADERS, ...headers } });
  return jsonResponse({ error: e.code, message: e.message }, ARTIFACT_ERROR_STATUS[e.code], headers);
}

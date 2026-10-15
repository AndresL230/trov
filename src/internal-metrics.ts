// `GET /api/internal/metrics` — Trov's OWN app metrics endpoint, in contract v3 (repo setups, Phase G;
// docs/superpowers/specs/2026-10-15-app-metrics-v3.md §4). What Trov's usage poller asks every app for, answered by
// Trov about one of its organizations — so an org that runs Trov's repository sees Trov's Product block (scenario B).
//
// AUTH: the BEARER class (CLAUDE.md invariant 8 — no fourth class): `Authorization: Bearer <token>` is a Trov MCP
// credential (a pasted `trov_mcp_` / legacy `canopy_mcp_` token, or an OAuth access token), and the organization is
// chosen ONLY by `resolveBearerTenant` (src/data/bearer.ts): the token's one org, or a manual connection's current one,
// among its person's LIVE memberships. Every way of having no organization — no header, an unknown / revoked / expired
// credential, a person who left, a connection that follows the repository (it names an org only per call) — is the same
// bare 401. Dispatched in src/index.ts before the cookie-only Hono app, like /mcp. Read-only and D1-only: nothing is
// written, nothing is fetched, nothing is metered. Never a 500: a failed read is a 503 `{ error }`.
import type { Env } from "./env";
import { resolveBearerTenant } from "./data/bearer";
import { ownMetricsBody } from "./data/own-metrics";

export const INTERNAL_METRICS_PATH = "/api/internal/metrics";

const NO_STORE = { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" };

export async function handleInternalMetrics(request: Request, env: Env, now: number = Date.now()): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(JSON.stringify({ error: "method not allowed" }), { status: 405, headers: { ...NO_STORE, allow: "GET, HEAD" } });
  }
  const bearer = await resolveBearerTenant(env, request, now);
  if (!bearer.ok) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...NO_STORE, "www-authenticate": 'Bearer realm="trov"' } });
  }
  try {
    const body = JSON.stringify(await ownMetricsBody(bearer.ctx, now));
    return new Response(request.method === "HEAD" ? null : body, { status: 200, headers: NO_STORE });
  } catch (e) {
    console.error("internal metrics", e instanceof Error ? e.message : String(e), `org=${bearer.ctx.orgId}`);
    return new Response(JSON.stringify({ error: "metrics unavailable" }), { status: 503, headers: NO_STORE });
  }
}

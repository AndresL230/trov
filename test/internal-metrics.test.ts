/**
 * Trov's OWN app metrics endpoint (repo setups, Phase G — src/internal-metrics.ts, src/data/own-metrics.ts):
 * `GET /api/internal/metrics` answers contract v3 for ONE organization, through the real Worker entry.
 *
 * Auth is the BEARER class (invariant 8 — no fourth class): a Trov MCP credential, its org chosen only by
 * src/data/bearer.ts; everything else is a bare 401. Per org: another org's rows never count. D1 only. The body
 * passes Trov's own v3 validator unchanged — so the poller that reads apps reads Trov.
 */
import { describe, it, expect } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import type { Env } from "../src/env";
import { appMetricsV3 } from "../src/repo/poll";
import { create_ticket } from "../src/tools/tickets";
import { revokeToken, listTokens } from "../src/auth/tokens";
import { ORG_A, ORG_B, ensureMember, mintTokenFor, systemCtx, tenantCtx } from "./helpers/tenant";

const e = env as unknown as Env;
const URL_ = "https://trov.test/api/internal/metrics";

async function call(init: RequestInit = {}, path = URL_): Promise<Response> {
  const exec = createExecutionContext();
  const res = await worker.fetch(new Request(path, init), e, exec);
  await waitOnExecutionContext(exec);
  return res;
}
const bearer = (raw: string): RequestInit => ({ headers: { authorization: `Bearer ${raw}` } });

const today = new Date().toISOString().slice(0, 10);
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

async function seed(orgId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await env.DB.prepare(`INSERT INTO docs (org_id, slug, section, title, body, current_version) VALUES (?, ?, 'reference', 'T', 'B', ?)`).bind(orgId, `doc-${i}`, i === 0 ? 0 : 1).run();
    await env.DB.prepare(`INSERT INTO doc_versions (org_id, slug, version, body, status, created_at, created_by) VALUES (?, ?, 2, 'B2', 'staged', ?, 'AndresL230')`).bind(orgId, `doc-${i}`, hoursAgo(2)).run();
  }
  await env.DB.prepare(`INSERT INTO doc_versions (org_id, slug, version, body, status, created_at, created_by) VALUES (?, 'doc-1', 1, 'B', 'promoted', ?, 'AndresL230')`).bind(orgId, hoursAgo(72)).run();
  await env.DB.prepare(`INSERT INTO needs_triage (org_id, raw, reason, resolved, created_at) VALUES (?, '{}', 'low confidence', 0, ?)`).bind(orgId, hoursAgo(1)).run();
  await env.DB.prepare(
    `INSERT INTO org_usage_daily (org_id, day, metric, actor, count, last_at) VALUES (?, ?, 'mcp_tool:query', 'AndresL230', ?, ?), (?, ?, 'mcp_tool:record_session', 'AndresL230', 2, ?), (?, ?, 'mcp_tool:get_doc', 'sanaok', 1, ?)`,
  ).bind(orgId, today, 5 * n, hoursAgo(0), orgId, today, hoursAgo(0), orgId, today, hoursAgo(0)).run();
}

type Body = { version: number; groups: { id: string; metrics: { key: string; label: string; value?: number; values?: Record<string, number> }[] }[] };
const metric = (b: Body, group: string, key: string) => b.groups.find((g) => g.id === group)?.metrics.find((m) => m.key === key);

describe("GET /api/internal/metrics — the bearer class, nothing else", () => {
  it("no header, a malformed header, an unknown token: the same bare 401 — and nothing read", async () => {
    const inits: RequestInit[] = [{}, { headers: { authorization: "Basic abc" } }, bearer("trov_mcp_not-a-real-token"), { headers: { cookie: "trov_session=x" } }];
    for (const init of inits) {
      const res = await call(init);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe('Bearer realm="trov"');
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
  });

  it("only GET and HEAD", async () => {
    const { raw } = await mintTokenFor("AndresL230");
    const res = await call({ method: "POST", ...bearer(raw), body: "{}" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
    const head = await call({ method: "HEAD", ...bearer(raw) });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("a revoked token, or a person who left the org, is 401", async () => {
    await ensureMember("sanaok", "member", ORG_A);
    const { raw } = await mintTokenFor("sanaok");
    expect((await call(bearer(raw))).status).toBe(200);
    const ctx = await tenantCtx("sanaok");
    const [t] = await listTokens(ctx);
    await revokeToken(ctx, t.id);
    expect((await call(bearer(raw))).status).toBe(401);
  });
});

describe("GET /api/internal/metrics — the token's one organization, in v3", () => {
  it("answers a v3 body Trov's own validator keeps whole; Cache-Control no-store", async () => {
    await seed(ORG_A, 3);
    const { raw } = await mintTokenFor("AndresL230");
    const res = await call(bearer(raw));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json() as Body;
    expect(body.version).toBe(3);
    const parsed = appMetricsV3(body);
    expect(parsed.droppedCount).toBe(0);
    expect(parsed.descriptor.groups.map((g) => [g.id, g.shape, g.window])).toEqual([
      ["now", "stats", "now"], ["mcp_tools", "ranked", "range"], ["gate", "stats", "range"], ["activity", "stats", "range"],
    ]);
  });

  it("counts the org's own rows: live docs, proposals awaiting review, triage, tickets, tools ranked, the gate, activity", async () => {
    await seed(ORG_A, 3);
    await create_ticket(systemCtx(ORG_A), { title: "Open one", body: "", category: "other", priority: "normal", assignees: [] }, "AndresL230");
    const { raw } = await mintTokenFor("AndresL230");
    const body = await (await call(bearer(raw))).json() as Body;
    expect(metric(body, "now", "live_docs")?.value).toBe(2);            // doc-0 was never promoted
    expect(metric(body, "now", "awaiting_review")?.value).toBe(3);
    expect(metric(body, "now", "in_triage")?.value).toBe(1);
    expect(metric(body, "now", "open_tickets")?.value).toBe(1);
    expect(metric(body, "now", "agents_connected")?.value).toBe(1);     // the token asking
    expect(metric(body, "now", "people")?.value).toBeGreaterThan(0);
    const tools = body.groups.find((g) => g.id === "mcp_tools")!.metrics;
    expect(tools.map((m) => [m.key, m.label, m.values?.["24h"]])).toEqual([["mcp_query", "query", 15], ["mcp_record_session", "record_session", 2], ["mcp_get_doc", "get_doc", 1]]);
    expect(metric(body, "gate", "gate_staged")?.values).toEqual({ "24h": 3, "7d": 4, "30d": 4 });
    expect(metric(body, "gate", "gate_promoted")?.values).toEqual({ "24h": 0, "7d": 1, "30d": 1 });
    expect(metric(body, "gate", "gate_to_triage")?.values).toEqual({ "24h": 1, "7d": 1, "30d": 1 });
    expect(metric(body, "activity", "sessions_recorded")?.values).toEqual({ "24h": 2, "7d": 2, "30d": 2 });
    expect(metric(body, "activity", "people_active")?.values).toEqual({ "24h": 2, "7d": 2, "30d": 2 });
    // Counts only: no handle, no title, no body leaves.
    const text = JSON.stringify(body);
    for (const leak of ["AndresL230", "sanaok", "Open one", "doc-1"]) expect(text).not.toContain(leak);
  });

  it("another org's rows never count — and a token of that org reads that org alone", async () => {
    await seed(ORG_B, 5);
    const { raw } = await mintTokenFor("AndresL230");
    const a = await (await call(bearer(raw))).json() as Body;
    expect(metric(a, "now", "live_docs")?.value).toBe(0);
    expect(metric(a, "now", "awaiting_review")?.value).toBe(0);
    expect(a.groups.find((g) => g.id === "mcp_tools")).toBeUndefined();
    await ensureMember("AndresL230", "member", ORG_B);
    const { raw: rawB } = await mintTokenFor("AndresL230", ORG_B);
    const b = await (await call(bearer(rawB))).json() as Body;
    expect(metric(b, "now", "live_docs")?.value).toBe(4);
    expect(metric(b, "now", "awaiting_review")?.value).toBe(5);
  });
});

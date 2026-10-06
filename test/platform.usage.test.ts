import { describe, it, expect } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import type { Env } from "../src/env";
import worker from "../src/index";
import { cookieFor } from "./helpers/persons";
import { ensureMember, platformCtx, systemCtx, ORG_A, ORG_B } from "./helpers/tenant";
import { call, one, rows, exec, SUPERADMIN } from "./helpers/orgs";
import { meter, meterMcp, pruneUsage } from "../src/data/meter";
import { platformUsage, usageDays } from "../src/platform/usage";
import { sha256Hex } from "../src/auth/crypto";
import type { OrgUsage, PlatformUsageResponse } from "@shared/orgs";

const e = env as unknown as Env;
const NOW = new Date("2026-10-06T12:00:00.000Z");
const usageRows = () => rows<{ org_id: string; day: string; metric: string; actor: string; count: number }>(
  `SELECT org_id, day, metric, actor, count FROM org_usage_daily ORDER BY org_id, metric, actor`);
const today = () => new Date().toISOString().slice(0, 10);

/** Two orgs with different amounts of everything; Acme's are the smaller, distinct numbers. */
async function fill() {
  await ensureMember("olive", "owner", ORG_B);
  const at = "2026-10-05T10:00:00.000Z";
  const old = "2026-01-01T00:00:00.000Z";
  const stmts: [string, ...unknown[]][] = [];
  for (const [org, n] of [[ORG_A, 3], [ORG_B, 1]] as const) {
    const who = org === ORG_A ? "meilin" : "olive";
    for (let i = 0; i < n; i++) {
      stmts.push([`INSERT INTO feed (org_id, author, summary, created_at) VALUES (?, ?, ?, ?)`, org, who, `entry ${i}`, i === 0 ? old : at]);
      stmts.push([`INSERT INTO tickets (org_id, title, requester, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, org, `t${i}`, who, i === 0 ? "done" : "submitted", at, at]);
      stmts.push([`INSERT INTO docs (org_id, slug, section, title, body) VALUES (?, ?, 'reference', 'T', 'b')`, org, `doc-${i}`]);
      stmts.push([`INSERT INTO handoffs (org_id, sender, recipient, body, created_at, expires_at) VALUES (?, ?, 'anyone', 'b', ?, '2027-01-01T00:00:00Z')`, org, who, at]);
      stmts.push([`INSERT INTO prompts (org_id, slug, title, author, created_at, updated_at) VALUES (?, ?, 'P', ?, ?, ?)`, org, `prompt-${i}`, who, at, at]);
      stmts.push([`INSERT INTO mcp_tokens (person, token_hash, created_at, org_id, revoked) VALUES (?, ?, ?, ?, ?)`, who, `hash-${org}-${i}`, at, org, i === 2 ? 1 : 0]);
      stmts.push([`INSERT INTO notification_outbox (idempotency_key, user_id, cadence, window_id, kinds, status, created_at, org_id) VALUES (?, ?, 'daily', 'w', '[]', ?, ?, ?)`,
        `${org}:${i}`, who, i === 1 ? "skipped" : "sent", at, org]);
    }
  }
  // One artifact page per org, with stored bytes that differ.
  for (const [org, bytes] of [[ORG_A, 700], [ORG_B, 40]] as const) {
    stmts.push([`INSERT INTO artifact_pages (org_id, slug, title, kind, area, author_id, created_at, updated_at) VALUES (?, 'page', 'Page', 'markdown', 'api', 'meilin', ?, ?)`, org, at, at]);
    stmts.push([`INSERT INTO artifact_versions (org_id, page_id, version_no, content, size_bytes, content_type, sha256, created_by, created_at)
                 SELECT ?, id, 1, 'x', ?, 'text/markdown', ?, 'meilin', ? FROM artifact_pages WHERE org_id = ? AND slug = 'page'`, org, bytes, "a".repeat(64), at, org]);
  }
  for (const [sql, ...params] of stmts) await exec(sql, ...params);
}

describe("metering", () => {
  it("meter() upserts one counter per (org, day, metric, person)", async () => {
    const p = platformCtx("meilin");
    await meter(p, ORG_A, "meilin", "api_read", "2026-10-06T01:00:00.000Z");
    await meter(p, ORG_A, "meilin", "api_read", "2026-10-06T02:00:00.000Z");
    await meter(p, ORG_A, "meilin", "api_write", "2026-10-06T03:00:00.000Z");
    await meter(p, ORG_A, "sanaok", "api_read", "2026-10-06T04:00:00.000Z");
    await meter(p, ORG_B, "meilin", "api_read", "2026-10-07T00:00:00.000Z");
    expect(await usageRows()).toEqual([
      { org_id: ORG_B, day: "2026-10-07", metric: "api_read", actor: "meilin", count: 1 },
      { org_id: ORG_A, day: "2026-10-06", metric: "api_read", actor: "meilin", count: 2 },
      { org_id: ORG_A, day: "2026-10-06", metric: "api_read", actor: "sanaok", count: 1 },
      { org_id: ORG_A, day: "2026-10-06", metric: "api_write", actor: "meilin", count: 1 },
    ]);
    expect(await one(`SELECT last_at FROM org_usage_daily WHERE org_id = ? AND metric = 'api_read' AND actor = 'meilin'`, ORG_A)).toEqual({ last_at: "2026-10-06T02:00:00.000Z" });
  });

  it("never rejects — an unknown org (a foreign-key failure) is swallowed", async () => {
    await expect(meter(platformCtx(), "org_does_not_exist", "meilin", "api_read")).resolves.toBeUndefined();
    expect(await usageRows()).toEqual([]);
  });

  it("the tenant gates meter reads and writes separately, per org, in waitUntil", async () => {
    await ensureMember("olive", "owner", ORG_B);
    const olive = await cookieFor("olive", { member: false });
    const meilin = await cookieFor("meilin");
    const ctx = createExecutionContext();
    const go = (method: string, path: string, cookie: string, body?: unknown) => call(method, path, cookie, body, { exec: ctx });
    expect((await go("GET", "/api/o/acme/me", olive)).status).toBe(200);
    expect((await go("GET", "/api/o/acme/members", olive)).status).toBe(200);
    expect((await go("PUT", "/api/o/acme/members/olive", olive, { title: "Founder" })).status).toBe(200);
    expect((await go("GET", "/docs", meilin)).status).toBe(200);                  // the cut-over alias gate meters too
    expect((await go("GET", "/api/o/saplinglearn/me", olive)).status).toBe(404);  // not a member: nothing metered
    expect((await go("GET", "/api/orgs", olive)).status).toBe(200);               // no tenant: nothing metered
    await waitOnExecutionContext(ctx);
    expect(await usageRows()).toEqual([
      { org_id: ORG_B, day: today(), metric: "api_read", actor: "olive", count: 2 },
      { org_id: ORG_B, day: today(), metric: "api_write", actor: "olive", count: 1 },
      { org_id: ORG_A, day: today(), metric: "api_read", actor: "meilin", count: 1 },
    ]);
  });

  // `tenantGate` is mounted once, in src/routes.ts; a sub-app that applied it again (as the integration
  // routes once did) would resolve the tenant twice and count every request double.
  it("one request meters once on every /api/o/:slug sub-app — orgs, integrations, repos, environments", async () => {
    const meilin = await cookieFor("meilin");
    const ctx = createExecutionContext();
    for (const path of ["/me", "/repos", "/environments"]) {
      expect((await call("GET", `/api/o/saplinglearn${path}`, meilin, undefined, { exec: ctx })).status).toBe(200);
    }
    expect((await call("GET", "/api/o/saplinglearn/integrations", meilin, undefined, { exec: ctx })).status).toBe(403); // admin+: refused, but it reached the org
    await waitOnExecutionContext(ctx);
    expect(await usageRows()).toEqual([{ org_id: ORG_A, day: today(), metric: "api_read", actor: "meilin", count: 4 }]);
  });

  it("a request with no ExecutionContext is served and simply not metered", async () => {
    expect((await call("GET", "/api/o/saplinglearn/me", await cookieFor("meilin"))).status).toBe(200);
    expect(await usageRows()).toEqual([]);
  });

  it("meterMcp counts the request and each tool call by name, and leaves the body for the handler", async () => {
    const mk = (body: unknown) => new Request("https://trov.test/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const ctx = systemCtx(ORG_B);
    const call1 = mk({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_feed", arguments: {} } });
    await meterMcp(e, ctx, call1);
    expect(await call1.json()).toMatchObject({ method: "tools/call" }); // the original is still readable
    await meterMcp(e, ctx, mk([
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_feed" } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_docs" } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "x".repeat(200) } }, // not a tool name: not a metric
    ]));
    await meterMcp(e, ctx, mk({ jsonrpc: "2.0", id: 5, method: "tools/list" }));
    await meterMcp(e, ctx, new Request("https://trov.test/mcp", { method: "POST", body: "not json" }));
    await meterMcp(e, ctx, new Request("https://trov.test/mcp", { method: "GET" }));
    expect((await usageRows()).map((r) => [r.metric, r.count])).toEqual([["mcp_request", 5], ["mcp_tool:get_feed", 2], ["mcp_tool:list_docs", 1]]);
  });

  it("the Worker meters a real /mcp tool call against the token's org and person", async () => {
    await ensureMember("olive", "owner", ORG_B);
    const raw = "trov_mcp_usage-test-token";
    await exec(`INSERT INTO mcp_tokens (person, token_hash, created_at, org_id) VALUES ('olive', ?, '2026-01-01T00:00:00Z', ?)`, await sha256Hex(raw), ORG_B);
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("https://trov.test/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${raw}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_docs", arguments: {} } }),
    }) as Parameters<typeof worker.fetch>[0], e, ctx);
    await res.text();
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect((await usageRows()).map((r) => [r.org_id, r.actor, r.metric, r.count])).toEqual([
      [ORG_B, "olive", "mcp_request", 1], [ORG_B, "olive", "mcp_tool:list_docs", 1],
    ]);
  });

  it("pruneUsage drops rows past 400 days and keeps the rest", async () => {
    const p = platformCtx();
    await meter(p, ORG_A, "meilin", "api_read", "2025-08-31T00:00:00.000Z"); // 401 days before NOW
    await meter(p, ORG_A, "meilin", "api_read", "2025-09-02T00:00:00.000Z"); // 399
    await meter(p, ORG_A, "meilin", "api_read", "2026-10-06T00:00:00.000Z");
    expect(await pruneUsage(p, NOW)).toBe(1);
    expect((await usageRows()).map((r) => r.day)).toEqual(["2025-09-02", "2026-10-06"]);
  });
});

describe("platformUsage", () => {
  it("sizes and window counts are per org and do not bleed between two orgs", async () => {
    await fill();
    const u = await platformUsage(platformCtx(), 30, NOW);
    const a = u.orgs.find((o) => o.slug === "saplinglearn")!;
    const b = u.orgs.find((o) => o.slug === "acme")!;

    expect(b.sizes).toEqual({
      members: 1, docs: 1, feed_entries: 1, tickets_open: 0, tickets_total: 1, sprints: 0, prompts: 1, handoffs: 1,
      artifacts: 1, artifact_bytes: 40, repo_events: 0, mcp_tokens: 1, oauth_grants: 0,
    });
    expect(a.sizes).toEqual({
      members: 6, docs: 3, feed_entries: 3, tickets_open: 2, tickets_total: 3, sprints: 0, prompts: 3, handoffs: 3,
      artifacts: 1, artifact_bytes: 700, repo_events: 0, mcp_tokens: 2, oauth_grants: 0,
    });
    // In the window: the first feed entry of each org is from January, so it is a size but not "created".
    expect(b.activity.created).toEqual({ feed_entries: 0, tickets: 1, doc_versions: 0, sprints: 0, prompts: 1, handoffs: 1, artifacts: 1 });
    expect(a.activity.created).toEqual({ feed_entries: 2, tickets: 3, doc_versions: 0, sprints: 0, prompts: 3, handoffs: 3, artifacts: 1 });
    expect([a.activity.emails_sent, b.activity.emails_sent]).toEqual([2, 1]);

    expect(u.totals.sizes.feed_entries).toBe(4);
    expect(u.totals.sizes.artifact_bytes).toBe(740);
    expect(u.totals.sizes.members).toBe(7);
    expect(u.totals.activity.created.tickets).toBe(4);
    expect(u.totals).toMatchObject({ orgs: 2, suspended_orgs: 0, persons: 7 });
  });

  it("activity, distinct people, top tools and last activity come from the meter, per org", async () => {
    await ensureMember("olive", "owner", ORG_B);
    const p = platformCtx();
    const m = async (org: string, actor: string, metric: string, at: string, times: number) => {
      for (let i = 0; i < times; i++) await meter(p, org, actor, metric, at);
    };
    await m(ORG_A, "meilin", "api_read", "2026-10-06T08:00:00.000Z", 4);
    await m(ORG_A, "sanaok", "api_read", "2026-10-05T08:00:00.000Z", 2);
    await m(ORG_A, "meilin", "api_write", "2026-10-06T09:00:00.000Z", 1);
    await m(ORG_A, "meilin", "mcp_request", "2026-10-06T09:30:00.000Z", 5);
    await m(ORG_A, "meilin", "mcp_tool:get_feed", "2026-10-06T09:30:00.000Z", 3);
    await m(ORG_A, "meilin", "mcp_tool:list_docs", "2026-10-04T09:30:00.000Z", 1);
    await m(ORG_A, "meilin", "api_read", "2026-08-01T00:00:00.000Z", 9); // before the window
    await m(ORG_B, "olive", "api_read", "2026-10-06T07:00:00.000Z", 1);
    await m(ORG_B, "meilin", "mcp_tool:query", "2026-10-06T07:30:00.000Z", 2); // meilin is active in both orgs

    const u = await platformUsage(p, 7, NOW);
    const a = u.orgs.find((o) => o.slug === "saplinglearn")!;
    const b = u.orgs.find((o) => o.slug === "acme")!;
    expect(a.activity).toMatchObject({
      api_requests: 7, api_reads: 6, api_writes: 1, mcp_requests: 5, mcp_tool_calls: 4, active_people: 2,
      top_tools: [{ tool: "get_feed", count: 3 }, { tool: "list_docs", count: 1 }],
    });
    expect(b.activity).toMatchObject({ api_requests: 1, api_reads: 1, api_writes: 0, mcp_requests: 0, mcp_tool_calls: 2, active_people: 2, top_tools: [{ tool: "query", count: 2 }] });
    expect(a.last_activity_at).toBe("2026-10-06T09:30:00.000Z");
    expect(b.last_activity_at).toBe("2026-10-06T07:30:00.000Z");
    // Totals add up — except people: meilin in two orgs is one person.
    expect(u.totals.activity).toMatchObject({ api_requests: 8, mcp_tool_calls: 6, active_people: 3 });
    expect(u.totals.activity.top_tools).toEqual([{ tool: "get_feed", count: 3 }, { tool: "query", count: 2 }, { tool: "list_docs", count: 1 }]);
    expect(u.totals.last_activity_at).toBe("2026-10-06T09:30:00.000Z");
  });

  it("the per-day series is zero-filled, oldest first, exactly `days` long, for every org and the totals", async () => {
    const p = platformCtx();
    await meter(p, ORG_A, "meilin", "api_read", "2026-10-06T08:00:00.000Z");
    await meter(p, ORG_A, "meilin", "api_write", "2026-10-06T08:00:00.000Z");
    await meter(p, ORG_A, "meilin", "mcp_tool:get_feed", "2026-10-04T08:00:00.000Z");
    await meter(p, ORG_A, "meilin", "mcp_request", "2026-10-04T08:00:00.000Z"); // a request is not a tool call
    await meter(p, ORG_B, "meilin", "api_read", "2026-10-02T08:00:00.000Z");

    const u = await platformUsage(p, 5, NOW);
    expect([u.days, u.since, u.until]).toEqual([5, "2026-10-02", "2026-10-06"]);
    expect(u.orgs.find((o) => o.slug === "saplinglearn")!.series).toEqual([
      { day: "2026-10-02", requests: 0, mcp_calls: 0 },
      { day: "2026-10-03", requests: 0, mcp_calls: 0 },
      { day: "2026-10-04", requests: 0, mcp_calls: 1 },
      { day: "2026-10-05", requests: 0, mcp_calls: 0 },
      { day: "2026-10-06", requests: 2, mcp_calls: 0 },
    ]);
    expect(u.orgs.find((o) => o.slug === "acme")!.series.map((d) => d.requests)).toEqual([1, 0, 0, 0, 0]);
    expect(u.totals.series.map((d) => [d.requests, d.mcp_calls])).toEqual([[1, 0], [0, 0], [0, 1], [0, 0], [2, 0]]);
    expect((await platformUsage(p, 1, NOW)).totals.series).toEqual([{ day: "2026-10-06", requests: 2, mcp_calls: 0 }]);
  });

  it("usageDays clamps ?days to a whole number in range, defaulting to 30", () => {
    expect([undefined, "", "abc", "0", "-3", "1.5", "401"].map(usageDays)).toEqual([30, 30, 30, 30, 30, 30, 30]);
    expect(["1", "7", "90", "400"].map(usageDays)).toEqual([1, 7, 90, 400]);
  });
});

describe("GET /api/platform/usage", () => {
  it("returns totals and one row per org, suspended ones included, in the documented shape", async () => {
    await fill();
    const cookie = await cookieFor(SUPERADMIN);
    await call("POST", "/api/platform/orgs/acme/suspend", cookie);
    const { status, json } = await call<PlatformUsageResponse>("GET", "/api/platform/usage?days=7", cookie);
    expect(status).toBe(200);
    expect(json.days).toBe(7);
    expect(json.until).toBe(today());
    expect(json.totals).toMatchObject({ orgs: 2, suspended_orgs: 1 });
    expect(json.totals.series).toHaveLength(7);
    expect(json.orgs.map((o) => [o.slug, o.status])).toEqual([["acme", "suspended"], ["saplinglearn", "active"]]);
    const acme = json.orgs[0] satisfies OrgUsage;
    expect(Object.keys(acme).sort()).toEqual(["activity", "created_at", "last_activity_at", "name", "series", "sizes", "slug", "status"]);
    expect(Object.keys(acme.activity).sort()).toEqual(["active_people", "api_reads", "api_requests", "api_writes", "created", "emails_sent", "mcp_requests", "mcp_tool_calls", "top_tools"]);
    expect(acme.sizes.feed_entries).toBe(1);
    expect(acme.series).toHaveLength(7);
    expect((await call<PlatformUsageResponse>("GET", "/api/platform/usage", cookie)).json.days).toBe(30);
    expect((await call("GET", "/api/platform/usage", await cookieFor("meilin"))).status).toBe(404);
  });
});

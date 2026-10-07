import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { systemCtx } from "./helpers/tenant";
import { app } from "../src/routes";
import {
  route_triage,
  stage_adr,
  ratify_adr,
} from "../src/tools/writes";
import {
  list_needs_triage,
  list_adrs,
} from "../src/tools/reads";
import { cookieFor as authedCookie } from "./helpers/persons";

// ---------------------------------------------------------------------------
// 2. list_needs_triage
// ---------------------------------------------------------------------------

describe("list_needs_triage", () => {
  it("returns only unresolved triage items", async () => {
    const id1 = await route_triage(systemCtx(), { raw: "item1", reason: "bad tag" });
    await route_triage(systemCtx(), { raw: "item2", reason: "low confidence" });
    // mark first one resolved
    await env.DB.prepare(`UPDATE needs_triage SET resolved = 1 WHERE id = ?`).bind(id1).run();

    const items = await list_needs_triage(systemCtx());
    expect(items.length).toBe(1);
    expect(items[0].raw).toBe("item2");
    expect(items[0].resolved).toBe(0);
  });

  it("returns empty array when all items are resolved", async () => {
    const id = await route_triage(systemCtx(), { raw: "item", reason: "test" });
    await env.DB.prepare(`UPDATE needs_triage SET resolved = 1 WHERE id = ?`).bind(id).run();
    const items = await list_needs_triage(systemCtx());
    expect(items).toHaveLength(0);
  });
});

describe("GET /needs-triage", () => {
  it("returns { items: [...] } with only unresolved items for an authenticated user", async () => {
    const id1 = await route_triage(systemCtx(), { raw: "alpha", reason: "out of vocab" });
    await route_triage(systemCtx(), { raw: "beta", reason: "low confidence" });
    await env.DB.prepare(`UPDATE needs_triage SET resolved = 1 WHERE id = ?`).bind(id1).run();

    const cookie = await authedCookie("andres");
    const res = await app.request("/needs-triage", { headers: { cookie } }, env);
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ raw: string; resolved: number }> };
    expect(body.items.length).toBe(1);
    expect(body.items[0].raw).toBe("beta");
    expect(body.items[0].resolved).toBe(0);
  });

  it("returns 401 without a session cookie", async () => {
    const res = await app.request("/needs-triage", {}, env);
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// 3. list_adrs
// ---------------------------------------------------------------------------

const adrBase = { title: "Use SQLite", context: "We need storage", decision: "SQLite", rationale: "Simple", confidence: "high" as const };

describe("list_adrs", () => {
  it("returns all adrs when no status filter", async () => {
    const id1 = await stage_adr(systemCtx(), adrBase, "andres");
    const id2 = await stage_adr(systemCtx(), { ...adrBase, title: "Use Hono" }, "andres");
    await ratify_adr(systemCtx(), id1);

    const adrs = await list_adrs(systemCtx());
    expect(adrs.length).toBe(2);
  });

  it("filters by status=draft", async () => {
    const id1 = await stage_adr(systemCtx(), adrBase, "andres");
    await stage_adr(systemCtx(), { ...adrBase, title: "Use Hono" }, "andres");
    await ratify_adr(systemCtx(), id1);

    const drafts = await list_adrs(systemCtx(), "draft");
    expect(drafts.length).toBe(1);
    expect(drafts[0].status).toBe("draft");
    expect(drafts[0].title).toBe("Use Hono");
  });

  it("filters by status=ratified", async () => {
    const id1 = await stage_adr(systemCtx(), adrBase, "andres");
    await stage_adr(systemCtx(), { ...adrBase, title: "Use Hono" }, "andres");
    await ratify_adr(systemCtx(), id1);

    const ratified = await list_adrs(systemCtx(), "ratified");
    expect(ratified.length).toBe(1);
    expect(ratified[0].status).toBe("ratified");
  });
});

describe("GET /adrs", () => {
  it("returns { adrs: [...] } for all adrs when no filter", async () => {
    const id1 = await stage_adr(systemCtx(), adrBase, "andres");
    await stage_adr(systemCtx(), { ...adrBase, title: "Use Hono" }, "andres");
    await ratify_adr(systemCtx(), id1);

    const cookie = await authedCookie("andres");
    const res = await app.request("/adrs", { headers: { cookie } }, env);
    expect(res.status).toBe(200);
    const body = await res.json() as { adrs: Array<{ status: string }> };
    expect(body.adrs.length).toBe(2);
  });

  it("filters by ?status=draft", async () => {
    const id1 = await stage_adr(systemCtx(), adrBase, "andres");
    await stage_adr(systemCtx(), { ...adrBase, title: "Use Hono" }, "andres");
    await ratify_adr(systemCtx(), id1);

    const cookie = await authedCookie("andres");
    const res = await app.request("/adrs?status=draft", { headers: { cookie } }, env);
    expect(res.status).toBe(200);
    const body = await res.json() as { adrs: Array<{ status: string }> };
    expect(body.adrs.length).toBe(1);
    expect(body.adrs[0].status).toBe("draft");
  });

  it("returns 401 without a session cookie", async () => {
    const res = await app.request("/adrs", {}, env);
    expect(res.status).toBe(401);
  });
});

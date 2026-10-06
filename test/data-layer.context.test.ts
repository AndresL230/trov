import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { app } from "../src/routes";
import { sessionGate, type AppEnv } from "../src/auth/principal";
import type { Env } from "../src/env";
import {
  hasRole, isSuperadmin, requireRole, requireSuperadmin, resolveSoleTenant, resolveTenant, RoleError,
  resolveTenantById,
} from "../src/data/context";
import { resolveBearerTenant } from "../src/data/bearer";
import { tenantGate } from "../src/data/gate";
import { consumeLegacyInvite, isLegacyOrg } from "../src/data/legacy";
import * as sql from "../src/data/sql";
import * as psql from "../src/data/platform-sql";
import { cookieFor, seedPerson } from "./helpers/persons";
import { sha256Hex } from "../src/auth/crypto";
import { ORG_A, ORG_B, bearerCtx, ensureMember, mintTokenFor, platformCtx, systemCtx, tenantCtx } from "./helpers/tenant";

const e = env as unknown as Env;

describe("TenantContext constructors", () => {
  it("resolveTenant: a member of the named org, with their role — and null for a non-member or an unknown slug", async () => {
    const owner = await resolveTenant(e, "AndresL230", "saplinglearn");
    expect(owner).toMatchObject({ orgId: ORG_A, userId: "AndresL230", role: "owner", via: "session" });
    expect((await resolveTenant(e, "meilin", "saplinglearn"))?.role).toBe("member");
    expect(await resolveTenant(e, "andresl230", "saplinglearn")).not.toBeNull(); // handles compare NOCASE
    expect(await resolveTenant(e, "AndresL230", "acme")).toBeNull(); // a real org, not a member
    expect(await resolveTenant(e, "AndresL230", "no-such-org")).toBeNull();
    expect(await resolveTenant(e, "nobody", "saplinglearn")).toBeNull();
  });

  it("resolveSoleTenant: the only membership; none and more-than-one are told apart", async () => {
    const one = await resolveSoleTenant(e, "meilin", "bearer");
    expect(one).toMatchObject({ ok: true, ctx: { orgId: ORG_A, userId: "meilin", role: "member", via: "bearer" } });
    await seedPerson("drifter", { member: false });
    expect(await resolveSoleTenant(e, "drifter", "session")).toEqual({ ok: false, reason: "no_membership" });
    await ensureMember("meilin", "admin", ORG_B);
    expect(await resolveSoleTenant(e, "meilin", "session")).toEqual({ ok: false, reason: "org_required" });
  });

  it("a SUSPENDED org resolves for no one — read in the resolver's own statement, not a second query", async () => {
    const queries: string[] = [];
    const counting = { ...e, DB: new Proxy(env.DB, { get: (db, k) => k === "prepare" ? (q: string) => (queries.push(q), db.prepare(q)) : Reflect.get(db, k) }) } as Env;
    const suspend = (on: boolean) => env.DB.prepare(`UPDATE orgs SET suspended_at = ? WHERE id = ?`).bind(on ? "2026-01-01T00:00:00Z" : null, ORG_A).run();
    const token = (await mintTokenFor("sanaok")).raw;
    const bearer = () => resolveBearerTenant(e, new Request("https://trov.test/mcp", { headers: { authorization: `Bearer ${token}` } }));

    await suspend(true);
    expect(await resolveTenant(counting, "meilin", "saplinglearn")).toBeNull();
    expect(await resolveTenantById(counting, "meilin", ORG_A, "bearer")).toBeNull();
    expect(await resolveSoleTenant(counting, "meilin", "session")).toEqual({ ok: false, reason: "suspended" });
    expect(queries).toHaveLength(3); // one statement each
    expect(await bearer()).toEqual({ ok: false, reason: "unauthorized" });

    await suspend(false);
    queries.length = 0;
    expect((await resolveTenant(counting, "meilin", "saplinglearn"))?.orgId).toBe(ORG_A);
    expect(await resolveTenantById(counting, "meilin", ORG_A, "bearer")).toMatchObject({ orgId: ORG_A, userId: "meilin", role: "member", via: "bearer" });
    expect(await resolveTenantById(counting, "meilin", ORG_B, "bearer")).toBeNull(); // not a member
    expect((await resolveSoleTenant(counting, "meilin", "session")).ok).toBe(true);
    expect(queries).toHaveLength(4);
    expect((await bearer()).ok).toBe(true);
  });

  it("resolveBearerTenant: no / unknown token is unauthorized; a live token resolves the org ON ITS ROW, via bearer", async () => {
    const req = (auth?: string) => new Request("https://trov.test/mcp", { headers: auth ? { authorization: auth } : {} });
    expect(await resolveBearerTenant(e, req())).toEqual({ ok: false, reason: "unauthorized" });
    expect(await resolveBearerTenant(e, req("Bearer trov_mcp_nope"))).toEqual({ ok: false, reason: "unauthorized" });
    const { raw } = await mintTokenFor("sanaok");
    expect(await resolveBearerTenant(e, req(`Bearer ${raw}`))).toMatchObject({ ok: true, ctx: { orgId: ORG_A, userId: "sanaok", via: "bearer" } });
    // A second membership no longer makes the token ambiguous: it is still the org it was minted for.
    await ensureMember("sanaok", "admin", ORG_B);
    expect(await resolveBearerTenant(e, req(`Bearer ${raw}`))).toMatchObject({ ok: true, ctx: { orgId: ORG_A, role: "member" } });
    // A token row whose person is not a member of the row's org (here: of no org) is not a credential.
    await seedPerson("drifter", { member: false });
    await env.DB.prepare(`INSERT INTO mcp_tokens (org_id, person, token_hash, created_at) VALUES (?, 'drifter', ?, '2026-01-01T00:00:00Z')`)
      .bind(ORG_A, await sha256Hex("trov_mcp_orphan")).run();
    expect(await resolveBearerTenant(e, req("Bearer trov_mcp_orphan"))).toEqual({ ok: false, reason: "unauthorized" });
  });

  it("a system context has role and via `system`, and passes no human role gate", async () => {
    const sys = systemCtx(ORG_A, "github-webhook");
    expect(sys).toMatchObject({ orgId: ORG_A, userId: "github-webhook", role: "system", via: "system" });
    expect(hasRole(sys, "admin")).toBe(false);
    expect(() => requireRole(sys, "admin")).toThrow(RoleError);
  });

  it("requireRole: admin = admin or owner, owner = owner only", async () => {
    const owner = await tenantCtx("AndresL230");
    const admin = await tenantCtx("meilin", "admin");
    const member = await tenantCtx("sanaok");
    expect([hasRole(owner, "admin"), hasRole(owner, "owner")]).toEqual([true, true]);
    expect([hasRole(admin, "admin"), hasRole(admin, "owner")]).toEqual([true, false]);
    expect([hasRole(member, "admin"), hasRole(member, "owner")]).toEqual([false, false]);
    expect(() => requireRole(admin, "owner")).toThrow(RoleError);
    expect(() => requireRole(admin, "admin")).not.toThrow();
  });

  it("superadmin is read from platform_admins, and is not an org role", async () => {
    const p = platformCtx();
    expect(await isSuperadmin(p, "andresl230")).toBe(true);
    expect(await isSuperadmin(p, "meilin")).toBe(false);
    await expect(requireSuperadmin(p, "meilin")).rejects.toThrow(RoleError);
    expect(await resolveTenant(e, "AndresL230", "acme")).toBeNull(); // no way into an org he is not in
  });

  it("a context is opaque: it serializes without its database handle", async () => {
    const ctx = await tenantCtx("meilin");
    expect(JSON.parse(JSON.stringify(ctx))).toEqual({ orgId: ORG_A, userId: "meilin", role: "member", via: "session" });
    expect(Object.keys(platformCtx("x"))).toEqual(["actor"]);
  });
});

describe("the query surface", () => {
  it("tenant sql: first / all / run / stmt + batch / fanOut over a TenantContext", async () => {
    const ctx = systemCtx();
    const now = sql.nowIso();
    const res = await sql.batch(ctx, [
      sql.stmt(ctx, `INSERT INTO needs_triage (org_id, raw, reason, created_at) VALUES (?, '{}', 'a', ?)`, ctx.orgId, now),
      sql.stmt(ctx, `INSERT INTO needs_triage (org_id, raw, reason, created_at) VALUES (?, '{}', 'b', ?)`, ORG_B, now),
    ]);
    expect(res.map((r) => r.meta.changes)).toEqual([1, 1]);
    const mine = await sql.all<{ id: number; reason: string }>(ctx, `SELECT id, reason FROM needs_triage WHERE org_id = ?`, ctx.orgId);
    expect(mine.map((r) => r.reason)).toEqual(["a"]);
    const ids = (await sql.all<{ id: number }>(ctx, `SELECT id FROM needs_triage`)).map((r) => r.id);
    const fanned = await sql.fanOut<{ reason: string }>(ctx, ids, (ph) => `SELECT reason FROM needs_triage WHERE org_id = ? AND id IN (${ph})`, [ORG_B]);
    expect(fanned).toEqual([{ reason: "b" }]);
    expect((await sql.run(ctx, `DELETE FROM needs_triage WHERE org_id = ? AND id = ?`, ctx.orgId, mine[0].id)).meta.changes).toBe(1);
    expect(await sql.first(ctx, `SELECT 1 FROM needs_triage WHERE org_id = ?`, ctx.orgId)).toBeNull();
  });

  it("platform sql: the same helpers over a PlatformContext", async () => {
    const p = platformCtx();
    expect(await psql.first<{ slug: string }>(p, `SELECT slug FROM orgs WHERE id = ?`, ORG_A)).toEqual({ slug: "saplinglearn" });
    const [a, b] = await psql.batch<{ n: number }>(p, [
      psql.stmt(p, `SELECT COUNT(*) AS n FROM orgs`),
      psql.stmt(p, `SELECT COUNT(*) AS n FROM memberships WHERE org_id = ?`, ORG_B),
    ]);
    expect([a.results[0].n, b.results[0].n]).toEqual([2, 0]);
    expect(await psql.fanOut<{ handle: string }>(p, ["meilin", "sanaok"], (ph) => `SELECT handle FROM persons WHERE handle IN (${ph}) ORDER BY handle`)).toHaveLength(2);
  });
});

describe("the gates", () => {
  it("the cut-over alias: a member's routes work; a person with no org, or two, gets 409 org_required", async () => {
    expect((await app.request("/docs", { headers: { cookie: await cookieFor("meilin") } }, env)).status).toBe(200);
    const none = await app.request("/docs", { headers: { cookie: await cookieFor("drifter", { member: false }) } }, env);
    expect([none.status, await none.json()]).toEqual([409, { error: "org_required" }]);
    await ensureMember("sanaok", "member", ORG_B);
    const two = await app.request("/docs", { headers: { cookie: await cookieFor("sanaok") } }, env);
    expect([two.status, await two.json()]).toEqual([409, { error: "org_required" }]);
  });

  it("person-level routes need no org, and an unauthenticated request is still a 401", async () => {
    const cookie = await cookieFor("drifter", { member: false });
    const me = await app.request("/auth/me", { headers: { cookie } }, env);
    expect(me.status).toBe(200);
    expect(((await me.json()) as { handle: string }).handle).toBe("drifter");
    expect((await app.request("/docs", {}, env)).status).toBe(401);
  });

  it("tenantGate: 404 not_found for an unknown slug and for a non-member alike; a member gets c.var.ctx", async () => {
    const t = new Hono<AppEnv>();
    t.use("*", sessionGate);
    t.use("/api/o/:slug/*", tenantGate);
    t.get("/api/o/:slug/whoami", (c) => c.json({ orgId: c.var.ctx.orgId, role: c.var.ctx.role, via: c.var.ctx.via }));
    const cookie = await cookieFor("AndresL230");
    const ok = await t.request("/api/o/saplinglearn/whoami", { headers: { cookie } }, env);
    expect(await ok.json()).toEqual({ orgId: ORG_A, role: "owner", via: "session" });
    for (const slug of ["acme", "no-such-org"]) {
      const res = await t.request(`/api/o/${slug}/whoami`, { headers: { cookie } }, env);
      expect([res.status, await res.json()], slug).toEqual([404, { error: "not_found" }]);
    }
  });

  it("/mcp: a token whose person has left its org is the same 401 invalid_token as an unknown one — never a 409", async () => {
    const { default: worker } = await import("../src/index");
    const { raw } = await mintTokenFor("drifter");
    await env.DB.prepare(`DELETE FROM memberships WHERE user_id = 'drifter'`).run(); // the row stays unrevoked
    const exec = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    const res = await worker.fetch(new Request("https://trov.test/mcp", { method: "POST", headers: { authorization: `Bearer ${raw}` } }), e, exec);
    expect([res.status, await res.json()]).toEqual([401, { error: "unauthorized" }]);
    expect(res.headers.get("www-authenticate")).toContain(`error="invalid_token"`);
  });
});

describe("test + cut-over helpers", () => {
  it("consumeLegacyInvite: only a live legacy invite for the verified email makes a new person a SaplingLearn member, once", async () => {
    await seedPerson("newbie", { member: false });
    expect(await consumeLegacyInvite(platformCtx(), "newbie", null)).toBeNull();
    expect(await consumeLegacyInvite(platformCtx(), "newbie", "newbie@x.io")).toBeNull(); // nobody invited that address
    expect(await resolveSoleTenant(e, "newbie", "session")).toEqual({ ok: false, reason: "no_membership" });

    await env.DB.prepare(`INSERT INTO invites (email, name, invited_by, invited_at) VALUES ('newbie@x.io', 'Newbie', 'AndresL230', '2026-10-01T00:00:00Z')`).run();
    expect(await consumeLegacyInvite(platformCtx(), "newbie", "Newbie@X.io")).toMatchObject({ orgId: ORG_A, role: "system", via: "system" });
    expect(await consumeLegacyInvite(platformCtx(), "newbie", "newbie@x.io")).toBeNull(); // spent
    expect(await resolveSoleTenant(e, "newbie", "session")).toMatchObject({ ok: true, ctx: { orgId: ORG_A, role: "member" } });
    expect(await env.DB.prepare(`SELECT accepted_by FROM invites WHERE email = 'newbie@x.io'`).first()).toEqual({ accepted_by: "newbie" });
  });

  it("isLegacyOrg names org #1 and nothing else", async () => {
    expect(isLegacyOrg(systemCtx(ORG_A))).toBe(true);
    expect(isLegacyOrg(systemCtx(ORG_B))).toBe(false);
  });

  it("tenantCtx / bearerCtx create the person and membership they need", async () => {
    expect(await tenantCtx("fresh-face", "admin")).toMatchObject({ orgId: ORG_A, userId: "fresh-face", role: "admin", via: "session" });
    expect(await bearerCtx("fresh-face")).toMatchObject({ role: "admin", via: "bearer" });
    expect(await tenantCtx("fresh-face", "member", { orgId: ORG_B })).toMatchObject({ orgId: ORG_B, role: "member" });
  });
});

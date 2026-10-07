import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { cookieFor } from "./helpers/persons";
import { ensureMember, ORG_B } from "./helpers/tenant";
import { call, one, rows, exec, SUPERADMIN } from "./helpers/orgs";
import { resolveBearerTenant } from "../src/data/bearer";
import { sha256Hex } from "../src/auth/crypto";
import type { AdminAssignment, MyOrgsResponse, PlatformAdmin, PlatformAuditRow, PlatformOrgDetail, PlatformOrgRow } from "@shared/orgs";

const e = env as unknown as Env;
const boss = () => cookieFor(SUPERADMIN);
const loner = (handle: string) => cookieFor(handle, { member: false });
const roleOf = async (slug: string, handle: string) =>
  (await one<{ role: string }>(`SELECT m.role FROM memberships m JOIN orgs o ON o.id = m.org_id WHERE o.slug = ? AND m.user_id = ? COLLATE NOCASE`, slug, handle))?.role ?? null;

const ROUTES: [method: string, path: string, body?: unknown][] = [
  ["GET", "/api/platform/orgs"],
  ["POST", "/api/platform/orgs", { slug: "x-co", name: "X", admin: { handle: "meilin" } }],
  ["GET", "/api/platform/orgs/acme"],
  ["POST", "/api/platform/orgs/acme/admin", { handle: "meilin" }],
  ["POST", "/api/platform/orgs/acme/suspend"],
  ["POST", "/api/platform/orgs/acme/unsuspend"],
  ["PUT", "/api/platform/persons/meilin/org-limit", { limit: 9 }],
  ["GET", "/api/platform/admins"],
  ["POST", "/api/platform/admins", { handle: "meilin" }],
  ["DELETE", "/api/platform/admins/AndresL230"],
  ["GET", "/api/platform/audit"],
  ["GET", "/api/platform/usage"],
  ["GET", "/api/platform/no-such-route"],
];

describe("/api/platform/* — the gate", () => {
  it("404s every route for a non-superadmin — an org owner included — and changes nothing", async () => {
    await ensureMember("olive", "owner", ORG_B);
    for (const cookie of [await cookieFor("meilin"), await loner("olive"), await loner("nobody")]) {
      for (const [method, path, body] of ROUTES) {
        const r = await call(method, path, cookie, body);
        expect([r.status, r.json], `${method} ${path}`).toEqual([404, { error: "not_found" }]);
      }
    }
    expect(await one(`SELECT COUNT(*) AS n FROM orgs`)).toEqual({ n: 2 });
    expect(await rows(`SELECT person FROM platform_admins`)).toEqual([{ person: SUPERADMIN }]);
    expect(await one(`SELECT org_limit FROM persons WHERE handle = 'meilin'`)).toEqual({ org_limit: null });
    expect(await one(`SELECT suspended_at FROM orgs WHERE id = ?`, ORG_B)).toEqual({ suspended_at: null });
  });

  it("401s without a session, and refuses a superadmin's request that carries an Authorization header", async () => {
    expect((await call("GET", "/api/platform/orgs", "")).status).toBe(401);
    // A bearer token alone never reaches the app's session routes at all…
    expect((await call("GET", "/api/platform/orgs", "", undefined, { headers: { authorization: "Bearer trov_mcp_anything" } })).status).toBe(401);
    // …and even with the superadmin's cookie beside it, every route refuses.
    const cookie = await boss();
    for (const [method, path, body] of ROUTES.slice(0, -1)) {
      const r = await call(method, path, cookie, body, { headers: { authorization: "Bearer trov_mcp_anything" } });
      expect([r.status, r.json.error], `${method} ${path}`).toEqual([403, "forbidden"]);
    }
    expect(await one(`SELECT COUNT(*) AS n FROM orgs`)).toEqual({ n: 2 });
  });
});

describe("POST /api/platform/orgs — take on an org and name its admin", () => {
  it("an existing person becomes the OWNER at once; the superadmin is NOT a member and gets the org's 404s", async () => {
    const cookie = await boss();
    const res = await call<{ ok: true; org: PlatformOrgRow; admin: AdminAssignment }>("POST", "/api/platform/orgs", cookie, { slug: "birch", name: "Birch Labs", admin: { handle: "MEILIN" } });
    expect(res.status).toBe(201);
    expect(res.json.admin).toEqual({ status: "owner", handle: "meilin" });
    expect(res.json.org).toMatchObject({
      slug: "birch", name: "Birch Labs", status: "active", created_by: SUPERADMIN, suspended_at: null,
      owners: [{ handle: "meilin", name: "Meilin Zhao" }], member_count: 1, pending_invites: 0, last_activity_at: null,
    });
    expect(await roleOf("birch", "meilin")).toBe("owner");
    expect(await roleOf("birch", SUPERADMIN)).toBeNull();
    // The singletons are there (the same createOrg as POST /api/orgs).
    const id = (await one<{ id: string }>(`SELECT id FROM orgs WHERE slug = 'birch'`))!.id;
    expect(await one(`SELECT (SELECT COUNT(*) FROM plan WHERE org_id = ?1) AS plan, (SELECT COUNT(*) FROM notification_settings WHERE org_id = ?1) AS settings, (SELECT COUNT(*) FROM org_counters WHERE org_id = ?1) AS counters`, id))
      .toEqual({ plan: 1, settings: 1, counters: 2 });

    // §5.4: no backdoor. The superadmin created it and still cannot read a thing inside it.
    for (const path of ["/api/o/birch/me", "/api/o/birch/members", "/api/o/birch/settings", "/api/o/birch/invites"]) {
      expect((await call("GET", path, cookie)).status, path).toBe(404);
    }
    expect((await call("PUT", "/api/o/birch/settings", cookie, { name: "Mine now" })).status).toBe(404);
    expect((await call<MyOrgsResponse>("GET", "/api/orgs", cookie)).json.orgs.map((o) => o.slug)).toEqual(["saplinglearn"]);
    // …while its owner does (meilin is now in two orgs, which the slug routes do not mind).
    expect((await call("GET", "/api/o/birch/me", await cookieFor("meilin"))).json).toMatchObject({ role: "owner" });
  });

  it("an unknown admin is INVITED as owner: they sign in, accept, and own the org", async () => {
    const cookie = await boss();
    const res = await call<{ org: PlatformOrgRow; admin: Extract<AdminAssignment, { status: "invited" }> }>("POST", "/api/platform/orgs", cookie, { slug: "cedar", name: "Cedar", admin: { github_login: "Cedar-Founder" } });
    expect(res.status).toBe(201);
    expect(res.json.admin).toEqual({ status: "invited", invite_id: expect.any(Number), github_login: "Cedar-Founder", email: null });
    expect(res.json.org).toMatchObject({ owners: [], member_count: 0, pending_invites: 1 });
    expect(await one(`SELECT role, as_owner, invited_by FROM org_invites WHERE id = ?`, res.json.admin.invite_id)).toEqual({ role: "admin", as_owner: 1, invited_by: SUPERADMIN });

    // Somebody else who signs in cannot take it.
    expect((await call("POST", `/api/invites/${res.json.admin.invite_id}/accept`, await loner("squatter"))).status).toBe(404);

    // The founder signs in with that GitHub login (their handle need not match it).
    const founder = await cookieFor("cedar", { member: false, github: false });
    await exec(`INSERT INTO identities (provider, subject, label, person, linked_at, linked_by) VALUES ('github', 'cedar-founder', 'cedar-founder', 'cedar', '2026-01-01T00:00:00Z', 'seed')`);
    const mine = await call<MyOrgsResponse>("GET", "/api/orgs", founder);
    expect(mine.json.invites).toMatchObject([{ id: res.json.admin.invite_id, org: { slug: "cedar", name: "Cedar" }, role: "owner" }]);
    expect((await call("POST", `/api/invites/${res.json.admin.invite_id}/accept`, founder)).json).toEqual({ ok: true, org: { slug: "cedar", name: "Cedar" }, role: "owner" });
    expect(await roleOf("cedar", "cedar")).toBe("owner");
    expect((await call("GET", "/api/o/cedar/me", founder)).json).toMatchObject({ role: "owner" });
    // "…for them to do the rest": the new owner can invite their own team.
    expect((await call("POST", "/api/o/cedar/invites", founder, { email: "dev@cedar.test" })).status).toBe(201);
  });

  it("a github_login / email that already belongs to a person resolves to them — no invite", async () => {
    const cookie = await boss();
    const byLogin = await call<{ admin: AdminAssignment }>("POST", "/api/platform/orgs", cookie, { slug: "elm", name: "Elm", admin: { github_login: "lpcooper-arch" } });
    expect(byLogin.json.admin).toEqual({ status: "owner", handle: "lpcooper-arch" });
    const byEmail = await call<{ admin: AdminAssignment }>("POST", "/api/platform/orgs", cookie, { slug: "fir", name: "Fir", admin: { email: "Meilin@SaplingLearn.org" } });
    expect(byEmail.json.admin).toEqual({ status: "owner", handle: "meilin" });
  });

  it("validates before it creates: a bad admin, an unknown handle, or a bad slug leaves no org behind", async () => {
    const cookie = await boss();
    const bad: [unknown, number, string][] = [
      [{ slug: "oak", name: "Oak" }, 400, "invalid_admin"],
      [{ slug: "oak", name: "Oak", admin: { handle: "meilin", email: "a@b.co" } }, 400, "invalid_admin"],
      [{ slug: "oak", name: "Oak", admin: { email: "nope" } }, 400, "invalid_admin"],
      [{ slug: "oak", name: "Oak", admin: { handle: "ghost" } }, 404, "no_such_person"],
      [{ slug: "api", name: "Oak", admin: { handle: "meilin" } }, 400, "reserved_slug"],
      [{ slug: "acme", name: "Oak", admin: { handle: "meilin" } }, 409, "slug_taken"],
    ];
    for (const [body, status, error] of bad) {
      const r = await call("POST", "/api/platform/orgs", cookie, body);
      expect([r.status, r.json.error], JSON.stringify(body)).toEqual([status, error]);
    }
    expect(await one(`SELECT COUNT(*) AS n FROM orgs`)).toEqual({ n: 2 });
    expect(await one(`SELECT COUNT(*) AS n FROM org_invites`)).toEqual({ n: 0 });
  });
});

describe("GET /api/platform/orgs[/:slug]", () => {
  it("lists every org with owners, counts and status; the detail adds members, pending invites and usage", async () => {
    await ensureMember("olive", "owner", ORG_B);
    await ensureMember("mia", "member", ORG_B);
    await exec(`INSERT INTO org_invites (org_id, github_login, role, invited_by, status, created_at) VALUES (?, 'pending-dev', 'member', 'olive', 'pending', '2026-10-06T00:00:00Z'), (?, 'gone-dev', 'member', 'olive', 'revoked', '2026-10-05T00:00:00Z')`, ORG_B, ORG_B);
    await exec(`INSERT INTO org_usage_daily (org_id, day, metric, actor, count, last_at) VALUES (?, '2026-10-01', 'api_read', 'mia', 3, '2026-10-01T09:30:00.000Z')`, ORG_B);
    const cookie = await boss();

    const list = (await call<{ orgs: PlatformOrgRow[] }>("GET", "/api/platform/orgs", cookie)).json.orgs;
    expect(list.map((o) => o.slug).sort()).toEqual(["acme", "saplinglearn"]);
    expect(list.find((o) => o.slug === "acme")).toEqual({
      slug: "acme", name: "Acme", logo_url: null, status: "active", created_at: "2026-10-06T00:00:00.000Z", created_by: "migration",
      suspended_at: null, suspended_by: null, owners: [{ handle: "olive", name: "olive" }], member_count: 2, pending_invites: 1,
      last_activity_at: "2026-10-01T09:30:00.000Z", github_account: null, // 0043_github_app: no App installation
      // 0044_plans: an org from before plans is Enterprise — unlimited seats — and uses members + pending invites.
      plan: {
        plan: "enterprise", overrides: {}, status: "active", source: "granted", seats_used: 3,
        entitlements: { seats: null, repositories: 10, environments: 10, artifact_bytes: null, agent_connections: null, ai_summaries: null },
      },
    });
    expect(list.find((o) => o.slug === "saplinglearn")).toMatchObject({ owners: [{ handle: SUPERADMIN, name: "Andres" }], member_count: 6 });
    expect(list[0]).not.toHaveProperty("id");

    const d = (await call<PlatformOrgDetail>("GET", "/api/platform/orgs/acme", cookie)).json;
    expect(d.org.slug).toBe("acme");
    expect(d.members).toEqual([
      { handle: "olive", name: "olive", role: "owner", title: null, joined_at: "2026-01-01T00:00:00Z" },
      { handle: "mia", name: "mia", role: "member", title: null, joined_at: "2026-01-01T00:00:00Z" },
    ]);
    expect(d.invites.map((i) => [i.github_login, i.status])).toEqual([["pending-dev", "pending"]]);
    expect(d.usage).toMatchObject({ slug: "acme", sizes: { members: 2 } });
    expect(d.usage.series).toHaveLength(30);
    expect((await call("GET", "/api/platform/orgs/nope", cookie)).status).toBe(404);
  });
});

describe("POST /api/platform/orgs/:slug/admin — rescue an org", () => {
  it("lifts an existing person (member or not) to owner, and invites anyone else as owner", async () => {
    await ensureMember("mia", "member", ORG_B);
    const cookie = await boss();
    expect((await call("POST", "/api/platform/orgs/acme/admin", cookie, { handle: "mia" })).json).toEqual({ ok: true, admin: { status: "owner", handle: "mia" } });
    expect(await roleOf("acme", "mia")).toBe("owner");
    expect((await call("POST", "/api/platform/orgs/acme/admin", cookie, { handle: "sanaok" })).json).toMatchObject({ admin: { status: "owner", handle: "sanaok" } });
    expect(await roleOf("acme", "sanaok")).toBe("owner");

    const invited = await call<{ admin: Extract<AdminAssignment, { status: "invited" }> }>("POST", "/api/platform/orgs/acme/admin", cookie, { email: "New.Owner@Acme.test" });
    expect(invited.json.admin).toEqual({ status: "invited", invite_id: expect.any(Number), github_login: null, email: "new.owner@acme.test" });
    // Asking again upgrades / keeps the one pending invite rather than failing or duplicating.
    const again = await call<{ admin: Extract<AdminAssignment, { status: "invited" }> }>("POST", "/api/platform/orgs/acme/admin", cookie, { email: "new.owner@acme.test" });
    expect(again.json.admin.invite_id).toBe(invited.json.admin.invite_id);
    expect(await rows(`SELECT as_owner, status FROM org_invites WHERE org_id = ?`, ORG_B)).toEqual([{ as_owner: 1, status: "pending" }]);

    expect((await call("POST", "/api/platform/orgs/nope/admin", cookie, { handle: "mia" })).status).toBe(404);
    expect((await call("POST", "/api/platform/orgs/acme/admin", cookie, { handle: "ghost" })).json.error).toBe("no_such_person");
    expect(await roleOf("acme", SUPERADMIN)).toBeNull();
  });

  it("an org admin's ordinary pending invite becomes an owner invite when the superadmin names the same address", async () => {
    await exec(`INSERT INTO org_invites (org_id, github_login, role, invited_by, status, created_at) VALUES (?, 'rescuer', 'member', 'olive', 'pending', '2026-10-06T00:00:00Z')`, ORG_B);
    await call("POST", "/api/platform/orgs/acme/admin", await boss(), { github_login: "Rescuer" });
    expect(await rows(`SELECT github_login, as_owner FROM org_invites WHERE org_id = ?`, ORG_B)).toEqual([{ github_login: "rescuer", as_owner: 1 }]);
    const rescuer = await loner("rescuer");
    const id = (await one<{ id: number }>(`SELECT id FROM org_invites WHERE org_id = ?`, ORG_B))!.id;
    expect((await call("POST", `/api/invites/${id}/accept`, rescuer)).json.role).toBe("owner");
  });
});

describe("suspend / unsuspend", () => {
  it("a suspended org is 404 for its members on the slug routes, hidden from the picker, and restored untouched", async () => {
    await ensureMember("olive", "owner", ORG_B);
    await exec(`INSERT INTO feed (org_id, author, summary, created_at) VALUES (?, 'olive', 'kept', '2026-01-01T00:00:00Z')`, ORG_B);
    const olive = await loner("olive");
    const cookie = await boss();
    expect((await call("GET", "/api/o/acme/me", olive)).status).toBe(200);

    const res = await call<{ org: PlatformOrgRow }>("POST", "/api/platform/orgs/acme/suspend", cookie);
    expect(res.json.org).toMatchObject({ slug: "acme", status: "suspended", suspended_by: SUPERADMIN });
    expect(res.json.org.suspended_at).toMatch(/^\d{4}-\d\d-\d\dT/);
    for (const path of ["/api/o/acme/me", "/api/o/acme/members", "/api/o/acme/settings"]) expect((await call("GET", path, olive)).status, path).toBe(404);
    expect((await call<MyOrgsResponse>("GET", "/api/orgs", olive)).json.orgs).toEqual([]);
    // The legacy single-org routes (soleTenantGate) answer 404 too — not org_required.
    expect((await call("GET", "/docs", olive)).status).toBe(404);
    // The superadmin still sees it, suspended; nothing inside was touched.
    expect((await call<{ orgs: PlatformOrgRow[] }>("GET", "/api/platform/orgs", cookie)).json.orgs.find((o) => o.slug === "acme")?.status).toBe("suspended");
    expect(await one(`SELECT COUNT(*) AS n FROM feed WHERE org_id = ?`, ORG_B)).toEqual({ n: 1 });
    expect(await one(`SELECT role FROM memberships WHERE org_id = ? AND user_id = 'olive'`, ORG_B)).toEqual({ role: "owner" });
    // Another org is unaffected.
    expect((await call("GET", "/api/o/saplinglearn/me", await cookieFor("meilin"))).status).toBe(200);

    const back = await call<{ org: PlatformOrgRow }>("POST", "/api/platform/orgs/acme/unsuspend", cookie);
    expect(back.json.org).toMatchObject({ status: "active", suspended_at: null, suspended_by: null });
    expect((await call("GET", "/api/o/acme/me", olive)).json).toMatchObject({ role: "owner" });
    expect((await call("GET", "/docs", olive)).status).toBe(200);
    expect((await call("POST", "/api/platform/orgs/nope/suspend", cookie)).status).toBe(404);
    expect((await rows<{ action: string }>(`SELECT action FROM org_admin_audit WHERE org_id = ? ORDER BY id`, ORG_B)).map((a) => a.action)).toEqual(["org.suspend", "org.unsuspend"]);
  });

  it("a suspended org's bearer tokens stop resolving, and resolve again once restored", async () => {
    await ensureMember("olive", "owner", ORG_B);
    const raw = "trov_mcp_suspension-test-token";
    await exec(`INSERT INTO mcp_tokens (person, token_hash, created_at, org_id) VALUES ('olive', ?, '2026-01-01T00:00:00Z', ?)`, await sha256Hex(raw), ORG_B);
    const request = () => new Request("https://trov.test/mcp", { method: "POST", headers: { authorization: `Bearer ${raw}` } });
    expect(await resolveBearerTenant(e, request())).toMatchObject({ ok: true, ctx: { orgId: ORG_B, userId: "olive", via: "bearer" } });

    const cookie = await boss();
    await call("POST", "/api/platform/orgs/acme/suspend", cookie);
    expect(await resolveBearerTenant(e, request())).toEqual({ ok: false, reason: "unauthorized" });
    await call("POST", "/api/platform/orgs/acme/unsuspend", cookie);
    expect(await resolveBearerTenant(e, request())).toMatchObject({ ok: true });
  });
});

describe("superadmins, audit", () => {
  it("the per-person org limit is gone: its route no longer exists, and a grant is what opens creation (test/plans.grants.test.ts)", async () => {
    const cookie = await boss();
    expect((await call("PUT", "/api/platform/persons/meilin/org-limit", cookie, { limit: 10 })).status).toBe(404);
    expect((await call<MyOrgsResponse>("GET", "/api/orgs", await cookieFor("meilin"))).json).toMatchObject({ can_create: false, grants: [] });
  });

  it("grants and revokes superadmin; the last one cannot be removed", async () => {
    const cookie = await boss();
    expect((await call<{ admins: PlatformAdmin[] }>("GET", "/api/platform/admins", cookie)).json.admins)
      .toEqual([{ handle: SUPERADMIN, name: "Andres", granted_at: "2026-10-06T00:00:00.000Z", granted_by: "seed" }]);
    const last = await call("DELETE", `/api/platform/admins/${SUPERADMIN}`, cookie);
    expect([last.status, last.json.error]).toEqual([409, "last_superadmin"]);

    expect((await call("POST", "/api/platform/admins", cookie, { handle: "ghost" })).status).toBe(404);
    const granted = await call<{ admins: PlatformAdmin[] }>("POST", "/api/platform/admins", cookie, { handle: "meilin" });
    expect(granted.json.admins.map((a) => [a.handle, a.granted_by])).toEqual([[SUPERADMIN, "seed"], ["meilin", SUPERADMIN]]);
    const meilin = await cookieFor("meilin");
    expect((await call("GET", "/api/platform/orgs", meilin)).status).toBe(200);
    // Superadmin is not an org role: meilin is still a plain member of SaplingLearn.
    expect((await call("GET", "/api/o/saplinglearn/me", meilin)).json).toMatchObject({ role: "member" });

    expect((await call("DELETE", "/api/platform/admins/ghost", cookie)).status).toBe(404);
    expect((await call<{ admins: PlatformAdmin[] }>("DELETE", "/api/platform/admins/meilin", cookie)).json.admins.map((a) => a.handle)).toEqual([SUPERADMIN]);
    expect((await call("GET", "/api/platform/orgs", meilin)).status).toBe(404);
  });

  it("GET /audit merges the org-administration and secrets trails, newest first, filterable by org", async () => {
    const cookie = await boss();
    await call("POST", "/api/platform/orgs", cookie, { slug: "birch", name: "Birch", admin: { handle: "meilin" } });
    await call("POST", "/api/platform/grants", cookie, { to: { handle: "meilin" }, plan: "team" });
    await exec(`INSERT INTO org_audit (org_id, actor, action, target, detail, at) VALUES (?, 'olive', 'secret.set', 'github_token:', '{"hint_last4":"wxyz","key_version":1}', '2020-01-01T00:00:00.000Z')`, ORG_B);

    const all = (await call<{ audit: PlatformAuditRow[] }>("GET", "/api/platform/audit", cookie)).json.audit;
    expect(all.map((a) => [a.org, a.action, a.target])).toEqual([
      [null, "grant.create", expect.stringMatching(/^grant:\d+$/)],
      ["birch", "member.add", "meilin"],
      ["birch", "org.create", "birch"],
      ["acme", "secret.set", "github_token:"],
    ]);
    expect(all[0]).toMatchObject({ id: expect.stringMatching(/^a\d+$/), actor: SUPERADMIN, detail: { to: "@meilin", plan: "team" } });
    expect(all[3]).toMatchObject({ id: expect.stringMatching(/^s\d+$/), actor: "olive", detail: { hint_last4: "wxyz", key_version: 1 } });
    expect([...all].sort((a, b) => b.at.localeCompare(a.at)).map((a) => a.at)).toEqual(all.map((a) => a.at));

    const acme = (await call<{ audit: PlatformAuditRow[] }>("GET", "/api/platform/audit?org=acme", cookie)).json.audit;
    expect(acme.map((a) => a.action)).toEqual(["secret.set"]);
    expect((await call<{ audit: PlatformAuditRow[] }>("GET", "/api/platform/audit?limit=1", cookie)).json.audit).toHaveLength(1);
    expect((await call("GET", "/api/platform/audit?org=nope", cookie)).status).toBe(404);
  });
});

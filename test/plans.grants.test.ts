/**
 * Grants (0044_plans `org_grants`, src/plans/grants.ts): the superadmin grants a person an organization of
 * their own; that person creates it with `POST /api/orgs`, which consumes the grant — exactly once. Holding
 * none, the same route makes a Free org instead (src/plans/free.ts; test/orgs.routes.test.ts), so a refused
 * grant is tested by naming it. Also the notice e-mail, the audit trail, the billing seam
 * (src/plans/billing.ts) and the migration's backfill.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { env, applyD1Migrations } from "cloudflare:test";
import { cookieFor, seedPerson } from "./helpers/persons";
import { ORG_A, platformCtx } from "./helpers/tenant";
import { call, one, rows, exec, grantOrgs, SUPERADMIN } from "./helpers/orgs";
import type { Env } from "../src/env";
import type { MyOrgsResponse, PlatformOrgRow } from "@shared/orgs";
import { PLANS, type MyGrant, type OrgPlanView, type PlatformGrant } from "@shared/plans";
import { renderGrantEmail } from "../src/notifications/grant";
import { createGrant, mailGrant, usableGrants, createOrgFromGrant, consumeStmt } from "../src/plans/grants";
import { createOrg } from "../src/orgs/repo";
import { grantOrganization, setOrgPlan, cancelOrgPlan, moveOrgToFree, setPaidGrantPlan, BILLING_ACTOR } from "../src/plans/billing";
import { LIMITS } from "../src/platform/limits";

const boss = () => cookieFor(SUPERADMIN);
const loner = (handle: string, o: Parameters<typeof cookieFor>[1] = {}) => cookieFor(handle, { member: false, ...o });
const grant = async (body: Record<string, unknown>) => call<{ ok: true; grant: PlatformGrant }>("POST", "/api/platform/grants", await boss(), body);
const mine = async (cookie: string) => (await call<MyOrgsResponse>("GET", "/api/orgs", cookie)).json;
const count = async (sql: string, ...p: unknown[]) => (await one<{ n: number }>(sql, ...p))!.n;
/** What `GET /api/orgs` says to a person holding no usable grant and owning no Free org: only Free is open. */
const ONLY_FREE = { can_create: true, grants: [], free: { can_create: true, owned: null } };
interface Mail { to_address: string; subject: string; html: string; text: string }
const mails = () => rows<Mail>(`SELECT to_address, subject, html, text FROM platform_outbox_bodies ORDER BY id`);
/** Every href and bare URL in a message (the font stylesheet aside). */
const links = (m: { html: string; text: string }): string[] =>
  [...m.html.matchAll(/href="([^"]+)"/g)].map((x) => x[1]).filter((h) => !h.includes("fonts.googleapis.com")).concat(m.text.match(/https?:\/\/\S+/g) ?? []);

afterEach(() => { vi.unstubAllGlobals(); });

describe("POST /api/platform/grants — the superadmin grants an organization", () => {
  it("by Trov handle, by GitHub login and by e-mail; each is listed unused and audited", async () => {
    await seedPerson("maya", { member: false });
    const byHandle = await grant({ to: { handle: "@Maya" }, plan: "team", note: "  pilot  " });
    expect(byHandle.status).toBe(201);
    expect(byHandle.json.grant).toMatchObject({
      handle: "maya", github_login: null, email: null, plan: "team", overrides: {}, note: "pilot", source: "granted", granted_by: SUPERADMIN,
      status: "unused", expires_at: null, used_at: null, org: null, mail_status: null,
    });
    const byLogin = await grant({ to: { github_login: "octo-cat" }, plan: "personal", expires_in_days: 7 });
    expect(byLogin.json.grant).toMatchObject({ handle: null, github_login: "octo-cat", plan: "personal" });
    expect(Date.parse(byLogin.json.grant.expires_at!) - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    const byMail = await grant({ to: { email: "New.Founder@X.io" }, plan: "enterprise", overrides: { seats: 40 } });
    expect(byMail.json.grant).toMatchObject({ email: "new.founder@x.io", plan: "enterprise", overrides: { seats: 40 }, mail_status: "sent" });

    const list = (await call<{ grants: PlatformGrant[] }>("GET", "/api/platform/grants", await boss())).json.grants;
    expect(list.map((g) => [g.handle ?? g.github_login ?? g.email, g.status])).toEqual([["new.founder@x.io", "unused"], ["octo-cat", "unused"], ["maya", "unused"]]);
    expect(await rows(`SELECT org_id, actor, action, target, detail FROM org_admin_audit WHERE action = 'grant.create' ORDER BY id`)).toEqual([
      { org_id: null, actor: SUPERADMIN, action: "grant.create", target: `grant:${byHandle.json.grant.id}`, detail: `{"to":"@maya","plan":"team"}` },
      { org_id: null, actor: SUPERADMIN, action: "grant.create", target: `grant:${byLogin.json.grant.id}`, detail: expect.stringContaining(`"to":"github:octo-cat","plan":"personal","expires_at"`) },
      { org_id: null, actor: SUPERADMIN, action: "grant.create", target: `grant:${byMail.json.grant.id}`, detail: `{"to":"new.founder@x.io","plan":"enterprise","overrides":{"seats":40}}` },
    ]);
  });

  it("refuses a bad target, plan, limits, note or expiry — and writes nothing", async () => {
    const cases: [Record<string, unknown>, number, string][] = [
      [{ to: {}, plan: "team" }, 400, "invalid_grant"],
      [{ to: { handle: "maya", email: "a@b.io" }, plan: "team" }, 400, "invalid_grant"],
      [{ to: { handle: "nobody-here" }, plan: "team" }, 404, "no_such_person"],
      [{ to: { github_login: "not a login" }, plan: "team" }, 400, "invalid_grant"],
      [{ to: { email: "nope" }, plan: "team" }, 400, "invalid_grant"],
      [{ to: { email: "a@b.io" }, plan: "gold" }, 400, "invalid_grant"],
      [{ to: { email: "a@b.io" } }, 400, "invalid_grant"],
      [{ to: { email: "a@b.io" }, plan: "team", overrides: { seats: 0 } }, 400, "invalid_grant"],
      [{ to: { email: "a@b.io" }, plan: "team", note: "x".repeat(281) }, 400, "invalid_grant"],
      [{ to: { email: "a@b.io" }, plan: "team", expires_in_days: 0 }, 400, "invalid_grant"],
      [{ to: { email: "a@b.io" }, plan: "team", expires_in_days: 400 }, 400, "invalid_grant"],
      // A superadmin adds organizations in Platform: granting one to a superadmin's handle is a mistake.
      [{ to: { handle: SUPERADMIN }, plan: "team" }, 400, "invalid_grant"],
    ];
    await seedPerson("maya", { member: false });
    for (const [body, status, code] of cases) {
      const r = await grant(body);
      expect([r.status, (r.json as unknown as { error: string }).error], JSON.stringify(body)).toEqual([status, code]);
    }
    expect(await count(`SELECT COUNT(*) AS n FROM org_grants`)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM platform_outbox_bodies`)).toBe(0);
  });

  it("is the superadmin's alone: every plan and grant route is a 404 for anyone else, and refuses a bearer header", async () => {
    await grantOrgs("someone");
    const member = await cookieFor("plain-member");
    for (const [method, path] of [["GET", "/api/platform/grants"], ["POST", "/api/platform/grants"], ["POST", "/api/platform/grants/1/revoke"], ["PUT", "/api/platform/orgs/saplinglearn/plan"]] as const) {
      const r = await call(method, path, member, method === "GET" ? undefined : { to: { email: "a@b.io" }, plan: "team" });
      expect([r.status, r.json], `${method} ${path}`).toEqual([404, { error: "not_found" }]);
    }
    const bearer = await call("GET", "/api/platform/grants", await boss(), undefined, { headers: { authorization: "Bearer trov_mcp_x" } });
    expect(bearer.status).toBe(403);
    expect(await count(`SELECT COUNT(*) AS n FROM org_grants`)).toBe(1);
  });
});

describe("the grantee — who a grant is for", () => {
  it("a GitHub-login grant made BEFORE the person has an account is theirs when they sign in, and nobody else's", async () => {
    const g = (await grant({ to: { github_login: "Late-Comer" }, plan: "team" })).json.grant;
    // No such person yet. They sign in (their GitHub identity's subject is the login)…
    const late = await loner("late-comer");
    const other = await loner("someone-else");
    const seen = await mine(late);
    expect(seen.can_create).toBe(true);
    expect(seen.grants).toEqual([{ id: g.id, plan: "team", plan_name: "Pro", entitlements: PLANS.team.entitlements, granted_by: SUPERADMIN, created_at: g.created_at, expires_at: null } satisfies MyGrant]);
    // …and it is invisible to, and unusable by, anyone else — even naming its id. (They may still make a Free org.)
    expect(await mine(other)).toMatchObject(ONLY_FREE);
    const stolen = await call("POST", "/api/orgs", other, { slug: "stolen", name: "Stolen", grant: g.id });
    expect([stolen.status, stolen.json.error]).toEqual([403, "no_grant"]);
    expect(await one(`SELECT 1 AS x FROM orgs WHERE slug = 'stolen'`)).toBeNull();
    expect(await one(`SELECT status FROM org_grants WHERE id = ?`, g.id)).toEqual({ status: "unused" });
    // Naming none, they get a Free org of their own — never the grant's plan.
    expect((await call("POST", "/api/orgs", other, { slug: "not-stolen", name: "Not Stolen" })).status).toBe(201);
    expect(await one(`SELECT plan, plan_source FROM orgs WHERE slug = 'not-stolen'`)).toEqual({ plan: "free", plan_source: "granted" });
    expect(await one(`SELECT status FROM org_grants WHERE id = ?`, g.id)).toEqual({ status: "unused" });
  });

  it("an e-mail grant matches a provider-VERIFIED address, never the editable notification address", async () => {
    const g = (await grant({ to: { email: "cto@startup.io" }, plan: "team" })).json.grant;
    const typed = await loner("typed-it", { email: "cto@startup.io" });               // persons.email only
    const verified = await loner("really-cto", { email: "CTO@startup.io", verified: true });
    expect((await mine(typed)).grants).toEqual([]);
    expect((await mine(verified)).grants).toHaveLength(1);
    const refused = await call("POST", "/api/orgs", typed, { slug: "typed", name: "Typed", grant: g.id });
    expect([refused.status, refused.json.error]).toEqual([403, "no_grant"]);
    // Naming none, the typed address gets them a Free org — and the grant waits for its real owner.
    expect((await call("POST", "/api/orgs", typed, { slug: "typed", name: "Typed" })).status).toBe(201);
    expect(await one(`SELECT plan FROM orgs WHERE slug = 'typed'`)).toEqual({ plan: "free" });
    expect(await one(`SELECT status FROM org_grants WHERE id = ?`, g.id)).toEqual({ status: "unused" });
  });

  it("a handle grant follows the person", async () => {
    await seedPerson("maya", { member: false });
    await grant({ to: { handle: "maya" }, plan: "personal" });
    expect((await mine(await loner("maya"))).grants.map((x) => x.plan)).toEqual(["personal"]);
    expect(await usableGrants(platformCtx(), "MAYA")).toHaveLength(1); // handles are case-insensitive
  });

  it("a superadmin cannot use one: Platform is where they add an organization", async () => {
    await grant({ to: { github_login: SUPERADMIN }, plan: "team" }); // by login: the handle form is refused outright
    expect(await mine(await boss())).toMatchObject({ superadmin: true, can_create: false, grants: [], free: { can_create: false, owned: null } });
    const r = await call("POST", "/api/orgs", await boss(), { slug: "mine-too", name: "Mine Too" });
    expect([r.status, r.json.error]).toEqual([403, "no_grant"]);
    // Nor a Free one.
    const free = await call("POST", "/api/orgs", await boss(), { slug: "mine-free", name: "Mine Free", plan: "free" });
    expect([free.status, free.json.error]).toEqual([403, "no_grant"]);
    expect(await one(`SELECT 1 AS x FROM orgs WHERE slug IN ('mine-too', 'mine-free')`)).toBeNull();
  });
});

describe("POST /api/orgs — using a grant", () => {
  it("creates the org on the grant's plan and limits, makes the grantee its owner, and consumes the grant", async () => {
    const g = (await grant({ to: { github_login: "founder" }, plan: "enterprise", overrides: { seats: 25 } })).json.grant;
    const cookie = await loner("founder");
    const made = await call<{ ok: true; org: { slug: string; role: string } }>("POST", "/api/orgs", cookie, { slug: "orchard", name: "Orchard", grant: g.id });
    expect(made.status).toBe(201);
    expect(made.json.org).toMatchObject({ slug: "orchard", role: "owner" });

    const org = (await one<{ id: string; plan: string; plan_overrides: string; plan_source: string; plan_status: string; created_by: string }>(
      `SELECT id, plan, plan_overrides, plan_source, plan_status, created_by FROM orgs WHERE slug = 'orchard'`))!;
    expect(org).toMatchObject({ plan: "enterprise", plan_overrides: `{"seats":25}`, plan_source: "granted", plan_status: "active", created_by: "founder" });
    expect(await one(`SELECT role FROM memberships WHERE org_id = ? AND user_id = 'founder'`, org.id)).toEqual({ role: "owner" });
    expect((await call<OrgPlanView>("GET", "/api/o/orchard/plan", cookie)).json).toMatchObject({ plan: "enterprise", entitlements: { seats: 25 }, overridden: ["seats"], seats: { members: 1, pending: 0 } });

    // The grant is used, and says which org it became — in the row and on Platform.
    expect(await one(`SELECT status, used_by, used_org FROM org_grants WHERE id = ?`, g.id)).toEqual({ status: "used", used_by: "founder", used_org: org.id });
    const listed = (await call<{ grants: PlatformGrant[] }>("GET", "/api/platform/grants", await boss())).json.grants[0];
    expect(listed).toMatchObject({ id: g.id, status: "used", used_by: "founder", org: { slug: "orchard", name: "Orchard" } });
    expect(listed.used_at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect((await rows<{ action: string; target: string }>(`SELECT action, target FROM org_admin_audit WHERE org_id = ? ORDER BY id`, org.id)).map((a) => `${a.action} ${a.target}`))
      .toEqual(["org.create orchard", "member.add founder", `grant.use grant:${g.id}`]);
    // One grant, one org: the spent grant is refused by name, and what is left is a Free org of their own.
    expect(await mine(cookie)).toMatchObject(ONLY_FREE);
    const again = await call("POST", "/api/orgs", cookie, { slug: "orchard-2", name: "Second", grant: g.id });
    expect([again.status, again.json.error]).toEqual([403, "no_grant"]);
    expect(await one(`SELECT 1 AS x FROM orgs WHERE slug = 'orchard-2'`)).toBeNull();
    expect((await call("POST", "/api/orgs", cookie, { slug: "orchard-2", name: "Second" })).status).toBe(201);
    expect(await one(`SELECT plan, plan_source FROM orgs WHERE slug = 'orchard-2'`)).toEqual({ plan: "free", plan_source: "granted" });
    expect(await count(`SELECT COUNT(*) AS n FROM org_admin_audit WHERE action = 'grant.use'`)).toBe(1);
  });

  it("with several grants the oldest is used unless one is named", async () => {
    const [older, newer] = [...(await grantOrgs("picker", 1, "personal")), ...(await grantOrgs("picker", 1, "team"))];
    await exec(`UPDATE org_grants SET created_at = '2026-10-07T00:00:00.000Z' WHERE id = ?`, newer);
    const cookie = await loner("picker");
    expect((await mine(cookie)).grants.map((g) => g.id)).toEqual([older, newer]);
    expect((await call("POST", "/api/orgs", cookie, { slug: "named", name: "Named", grant: newer })).status).toBe(201);
    expect(await one(`SELECT plan FROM orgs WHERE slug = 'named'`)).toEqual({ plan: "team" });
    expect((await call("POST", "/api/orgs", cookie, { slug: "defaulted-one", name: "Defaulted" })).status).toBe(201);
    expect(await one(`SELECT plan FROM orgs WHERE slug = 'defaulted-one'`)).toEqual({ plan: "personal" });
    expect(await rows(`SELECT id, status FROM org_grants WHERE person = 'picker' ORDER BY id`)).toEqual([{ id: older, status: "used" }, { id: newer, status: "used" }]);
  });

  it("a double submit creates ONE org: the second request finds the grant spent and changes nothing", async () => {
    const [g] = await grantOrgs("eager");
    const cookie = await loner("eager");
    const before = await count(`SELECT COUNT(*) AS n FROM orgs`);
    // The grant named, as the picker's card sends it: a request naming NONE that reads after the first one
    // landed holds no grant, and is a request for a Free org (src/orgs/routes.ts), not a double submit.
    const [a, b] = await Promise.all([
      call("POST", "/api/orgs", cookie, { slug: "eager-one", name: "Eager", grant: g }),
      call("POST", "/api/orgs", cookie, { slug: "eager-two", name: "Eager", grant: g }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 403]);
    expect((a.status === 403 ? a : b).json.error).toBe("no_grant");
    expect(await count(`SELECT COUNT(*) AS n FROM orgs`)).toBe(before + 1);
    expect(await count(`SELECT COUNT(*) AS n FROM memberships WHERE user_id = 'eager'`)).toBe(1);
    expect(await one(`SELECT status FROM org_grants WHERE id = ?`, g)).toEqual({ status: "used" });
    // The same form sent twice (the same slug): still one org.
    await grantOrgs("eager2");
    const c2 = await loner("eager2");
    const [x, y] = await Promise.all([call("POST", "/api/orgs", c2, { slug: "twice", name: "Twice" }), call("POST", "/api/orgs", c2, { slug: "twice", name: "Twice" })]);
    expect([x.status, y.status].filter((s) => s === 201)).toHaveLength(1);
    expect(await count(`SELECT COUNT(*) AS n FROM orgs WHERE slug = 'twice'`)).toBe(1);
  });

  it("the consuming statement is the guard: with a grant that is used, revoked or expired, the creating batch fails whole", async () => {
    await seedPerson("slow", { member: false });
    const p = platformCtx("slow");
    const [used, revoked, expired, fine] = await grantOrgs("slow", 4);
    await exec(`UPDATE org_grants SET status = 'used' WHERE id = ?`, used);
    await exec(`UPDATE org_grants SET status = 'revoked' WHERE id = ?`, revoked);
    await exec(`UPDATE org_grants SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`, expired);
    const orgsBefore = await count(`SELECT COUNT(*) AS n FROM orgs`);
    // What a request that READ the grant as usable does next — the batch, with the consume in it.
    const attempt = (grantId: number, slug: string) => createOrg(p, {
      slug, name: slug, owner: "slow", plan: { id: "team", overrides: {}, source: "granted" },
      extra: (orgId, at) => [consumeStmt(p, grantId, "slow", orgId, at)],
    });
    for (const [id, slug] of [[used, "was-used"], [revoked, "was-revoked"], [expired, "was-expired"]] as const) {
      await expect(attempt(id, slug), slug).rejects.toThrow(/CHECK constraint failed: org_grant_usable/);
    }
    expect(await count(`SELECT COUNT(*) AS n FROM orgs`)).toBe(orgsBefore);
    expect(await count(`SELECT COUNT(*) AS n FROM memberships WHERE user_id = 'slow'`)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM org_admin_audit WHERE action = 'org.create'`)).toBe(0);
    expect(await rows(`SELECT id, status FROM org_grants WHERE person = 'slow' ORDER BY id`))
      .toEqual([{ id: used, status: "used" }, { id: revoked, status: "revoked" }, { id: expired, status: "unused" }, { id: fine, status: "unused" }]);
    // …and through the route that failure is the same 403 `no_grant` as having none.
    await expect(createOrgFromGrant(p, "slow", { slug: "nope", name: "Nope", grant: used })).rejects.toMatchObject({ code: "no_grant" });
    expect((await attempt(fine, "fine-co")).slug).toBe("fine-co");
    expect(await one(`SELECT status, used_by FROM org_grants WHERE id = ?`, fine)).toEqual({ status: "used", used_by: "slow" });
  });

  it("lands the grantee on a working org: they can invite up to the plan's seats (Pro: fifty)", async () => {
    await grantOrgs("teamlead", 1, "team");
    const cookie = await loner("teamlead");
    expect((await call("POST", "/api/orgs", cookie, { slug: "squad", name: "Squad" })).status).toBe(201);
    const id = (await one<{ id: string }>(`SELECT id FROM orgs WHERE slug = 'squad'`))!.id;
    // 45 invitations already out (written directly: fifty through the route would spend the owner's daily
    // invite allowance), then the last seats through the route.
    for (let n = 1; n <= 45; n++) {
      await exec(`INSERT INTO org_invites (org_id, github_login, role, invited_by, status, created_at) VALUES (?, ?, 'member', 'teamlead', 'pending', '2026-10-06T00:00:00Z')`, id, `squad-${n}`);
    }
    for (let n = 46; n <= 49; n++) expect((await call("POST", "/api/o/squad/invites", cookie, { github_login: `squad-${n}` })).status, `invite ${n}`).toBe(201);
    const full = await call("POST", "/api/o/squad/invites", cookie, { github_login: "squad-50" });
    // A granted Pro org: no `paid`, no `next` — its owner asks Trov.
    expect([full.status, full.json]).toEqual([402, {
      error: "plan_limit", limit: "seats", used: 50, cap: 50, plan: "team", status: "active",
      message: "This organization has reached the 50 seats its Pro plan includes.",
    }]);
    // The superadmin raises it: Enterprise with 60 seats, and the invitation goes through.
    await call("PUT", "/api/platform/orgs/squad/plan", await boss(), { plan: "enterprise", overrides: { seats: 60 } });
    expect((await call("POST", "/api/o/squad/invites", cookie, { github_login: "squad-50" })).status).toBe(201);
  });
});

describe("revoking and expiry", () => {
  it("an unused grant can be revoked, after which it is nobody's; a used one cannot (409)", async () => {
    const g = (await grant({ to: { github_login: "wavering" }, plan: "team" })).json.grant;
    const cookie = await loner("wavering");
    const root = await boss();
    const revoked = await call<{ ok: true; grant: PlatformGrant }>("POST", `/api/platform/grants/${g.id}/revoke`, root, {});
    expect(revoked.json.grant).toMatchObject({ status: "revoked", revoked_by: SUPERADMIN });
    expect(await mine(cookie)).toMatchObject(ONLY_FREE);
    const late = await call("POST", "/api/orgs", cookie, { slug: "too-late", name: "Too Late", grant: g.id });
    expect([late.status, late.json.error]).toEqual([403, "no_grant"]);
    expect(await one(`SELECT 1 AS x FROM orgs WHERE slug = 'too-late'`)).toBeNull();
    expect((await call("POST", `/api/platform/grants/${g.id}/revoke`, root, {})).status).toBe(404); // already revoked
    expect((await call("POST", "/api/platform/grants/99999/revoke", root, {})).status).toBe(404);
    expect((await call("POST", "/api/platform/grants/abc/revoke", root, {})).status).toBe(404);
    expect(await rows(`SELECT action, target FROM org_admin_audit WHERE action = 'grant.revoke'`)).toEqual([{ action: "grant.revoke", target: `grant:${g.id}` }]);

    const [used] = await grantOrgs("decided");
    await call("POST", "/api/orgs", await loner("decided"), { slug: "decided-co", name: "Decided" });
    const r = await call("POST", `/api/platform/grants/${used}/revoke`, root, {});
    expect([r.status, r.json.error]).toEqual([409, "grant_used"]);
    expect(await one(`SELECT 1 AS x FROM orgs WHERE slug = 'decided-co'`)).not.toBeNull(); // the org is untouched
  });

  it("an expired grant is not offered and cannot be used; Platform shows it as expired", async () => {
    const g = (await grant({ to: { github_login: "sleepy" }, plan: "team", expires_in_days: 30 })).json.grant;
    const cookie = await loner("sleepy");
    expect((await mine(cookie)).grants).toHaveLength(1);
    await exec(`UPDATE org_grants SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`, g.id);
    expect(await mine(cookie)).toMatchObject(ONLY_FREE);
    const r = await call("POST", "/api/orgs", cookie, { slug: "sleepy-co", name: "Sleepy", grant: g.id });
    expect([r.status, r.json.error]).toEqual([403, "no_grant"]);
    expect(await one(`SELECT 1 AS x FROM orgs WHERE slug = 'sleepy-co'`)).toBeNull();
    expect((await call<{ grants: PlatformGrant[] }>("GET", "/api/platform/grants", await boss())).json.grants[0]).toMatchObject({ id: g.id, status: "expired" });
    expect(await one(`SELECT status FROM org_grants WHERE id = ?`, g.id)).toEqual({ status: "unused" }); // expiry is derived, the row is not rewritten
  });
});

describe("the notice e-mail (an e-mail grant only)", () => {
  it("renders who granted it and the plan; its only link is the site root; markup in a name is escaped", () => {
    const m = renderGrantEmail({ granterName: "Andres", planName: PLANS.team.name, planDescription: PLANS.team.description, email: "cto@startup.io", signInUrl: "https://trov.test/", host: "trov.test" });
    expect(m.subject).toBe("You can set up an organization on Trov");
    expect(m.html).toContain("Andres has given you an organization on Trov");
    expect(m.text).toContain("Andres has given you an organization on Trov's Pro plan.");
    expect(m.text).toContain("Pro: For a team, paid per seat.");
    expect(new Set(links(m))).toEqual(new Set(["https://trov.test/"]));
    expect(m.html).toContain('data-mark="trov"');
    const evil = renderGrantEmail({ granterName: `<img src=x onerror=1>`, planName: "Pro", planDescription: "d", email: "a@b.io", signInUrl: "https://trov.test/", host: "trov.test" });
    expect(evil.html).not.toContain("<img src=x");
    // A grant nobody made by hand (billing) names no person.
    expect(renderGrantEmail({ granterName: null, planName: "Pro", planDescription: "d", email: "a@b.io", signInUrl: "https://trov.test/", host: "trov.test" }).text)
      .toContain("You have been given an organization on Trov's Pro plan.");
  });

  it("is sent to the granted address with no token and no grant id in any link, and recorded on the grant; a login or handle grant sends none", async () => {
    await seedPerson("maya", { member: false });
    await grant({ to: { handle: "maya" }, plan: "team" });
    await grant({ to: { github_login: "octo-cat" }, plan: "team" });
    expect(await mails()).toEqual([]);

    const g = (await grant({ to: { email: "cto@startup.io" }, plan: "team" })).json.grant;
    expect(g).toMatchObject({ mail_status: "sent", mail_error: null });
    expect(g.mail_at).toMatch(/^\d{4}-\d\d-\d\dT/);
    const sent = await mails();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to_address: "cto@startup.io", subject: "You can set up an organization on Trov" });
    expect(sent[0].text).toContain("Andres has given you an organization on Trov's Pro plan.");
    expect(sent[0].text).toContain("Pro: For a team, paid per seat.");
    for (const href of links(sent[0])) {
      expect(href).toMatch(/^https?:\/\/[^/?#]+\/$/); // the site root, nothing after it
      expect(href).not.toContain(String(g.id));
    }
    expect(sent[0].html + sent[0].text).not.toMatch(/token|grant:|[?&](id|grant|code)=/i);
    // Nothing went to an org's outbox: this mail belongs to no org.
    expect(await count(`SELECT COUNT(*) AS n FROM notification_outbox_bodies`)).toBe(0);
  });

  it("in resend mode it leaves as the platform's own From, to the one recipient; a provider failure is recorded and costs nothing", async () => {
    const out: { url: string; body: { from: string; to: string[]; subject: string; html: string; text: string } }[] = [];
    let fail = false;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      out.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return fail ? new Response(JSON.stringify({ message: "domain not verified" }), { status: 403 }) : new Response(JSON.stringify({ id: "re_1" }), { status: 200 });
    }) as typeof fetch;
    const live = { ...(env as unknown as Env), NOTIFICATIONS_MODE: "resend", RESEND_API_KEY: "re_test" } as Env;
    const p = platformCtx(SUPERADMIN, live);
    const g = await createGrant(p, { to: { email: "cto@startup.io" }, plan: "team" });
    await mailGrant(live, p, g, "https://trov.test", fetchImpl);
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe("https://api.resend.com/emails");
    expect(out[0].body).toMatchObject({ from: "Trov <hello@trov.dev>", to: ["cto@startup.io"], subject: "You can set up an organization on Trov" });
    expect(new Set(links(out[0].body))).toEqual(new Set(["https://trov.test/"]));
    expect(await one(`SELECT mail_status FROM org_grants WHERE id = ?`, g.id)).toEqual({ mail_status: "sent" });
    expect(await count(`SELECT COUNT(*) AS n FROM platform_outbox_bodies`)).toBe(0);

    fail = true;
    const g2 = await createGrant(p, { to: { email: "other@startup.io" }, plan: "team" });
    await mailGrant(live, p, g2, "https://trov.test", fetchImpl);
    expect(await one(`SELECT status, mail_status, mail_error FROM org_grants WHERE id = ?`, g2.id)).toEqual({ status: "unused", mail_status: "failed", mail_error: "resend 403: domain not verified" });
  });

  it("takes the granter's daily invite allowance, and is skipped once that is spent (a superadmin is exempt)", async () => {
    // Only a superadmin (or billing) creates grants, so the limit is exercised on the function: a granter who is not one.
    await seedPerson("delegate", { member: false });
    const p = platformCtx("delegate");
    const g1 = await createGrant(p, { to: { email: "one@x.io" }, plan: "team" });
    await mailGrant(env as unknown as Env, p, g1, "https://trov.test");
    expect(await one(`SELECT count FROM abuse_counters WHERE subject = 'delegate' AND action = 'invite'`)).toEqual({ count: 1 });
    await exec(`UPDATE abuse_counters SET count = ? WHERE subject = 'delegate' AND action = 'invite'`, LIMITS.invite.max);
    const g2 = await createGrant(p, { to: { email: "two@x.io" }, plan: "team" });
    await mailGrant(env as unknown as Env, p, g2, "https://trov.test");
    expect((await mails()).map((m) => m.to_address)).toEqual(["one@x.io"]);
    expect(await one(`SELECT status, mail_status FROM org_grants WHERE id = ?`, g2.id)).toEqual({ status: "unused", mail_status: null }); // the grant stands
    // The superadmin's own grants spend nothing.
    await grant({ to: { email: "three@x.io" }, plan: "team" });
    expect(await one(`SELECT 1 AS x FROM abuse_counters WHERE subject = ?`, SUPERADMIN)).toBeNull();
  });
});

describe("the billing seam — src/plans/billing.ts", () => {
  it("grantOrganization: a payment becomes a grant with no superadmin; a re-delivered event is a no-op; the org it becomes is on billing's plan", async () => {
    const p = platformCtx(BILLING_ACTOR);
    const e = env as unknown as Env;
    const g = await grantOrganization(e, p, { to: { email: "buyer@shop.io" }, plan: "team", external_ref: "pay_123", origin: "https://trov.test" });
    expect(g).toMatchObject({ email: "buyer@shop.io", plan: "team", source: "billing", granted_by: "billing", status: "unused", mail_status: "sent" });
    const replay = await grantOrganization(e, p, { to: { email: "buyer@shop.io" }, plan: "team", external_ref: "pay_123", origin: "https://trov.test" });
    expect(replay.id).toBe(g.id);
    expect(await count(`SELECT COUNT(*) AS n FROM org_grants`)).toBe(1);
    const sent = await mails();
    expect(sent.map((m) => m.to_address)).toEqual(["buyer@shop.io"]);
    expect(sent[0].text).toContain("You have been given an organization on Trov's Pro plan."); // no person granted it
    expect(await rows(`SELECT actor, action FROM org_admin_audit WHERE action = 'grant.create'`)).toEqual([{ actor: "billing", action: "grant.create" }]);

    // The buyer signs in with that (verified) address and sets up their org.
    const buyer = await loner("buyer", { email: "buyer@shop.io", verified: true });
    expect((await call("POST", "/api/orgs", buyer, { slug: "shop", name: "Shop" })).status).toBe(201);
    expect(await one(`SELECT plan, plan_source FROM orgs WHERE slug = 'shop'`)).toEqual({ plan: "team", plan_source: "billing" });
    // …and billing then hangs its ids on the org, and can end it.
    expect(await setOrgPlan(p, "shop", { plan: "team", source: "billing", period_end: "2026-11-07T00:00:00.000Z", customer_id: "cus_9", subscription_id: "sub_9" }))
      .toMatchObject({ customer_id: "cus_9", subscription_id: "sub_9", status: "active" });
    expect((await cancelOrgPlan(p, "shop")).status).toBe("canceled");
    const frozen = await call("POST", "/api/o/shop/invites", buyer, { github_login: "x" });
    expect([frozen.status, frozen.json]).toMatchObject([402, { error: "plan_limit", status: "canceled", plan: "team", paid: true }]);
    expect(frozen.json).not.toHaveProperty("next"); // ended: renew, not upgrade
    const row = (await call<{ orgs: PlatformOrgRow[] }>("GET", "/api/platform/orgs", await boss())).json.orgs.find((o) => o.slug === "shop")!;
    expect(row.plan).toMatchObject({ plan: "team", source: "billing", status: "canceled" });
    // What billing does now when a subscription ends: the org moves to Free — active, still billing's, its ids kept.
    expect(await moveOrgToFree(p, "shop")).toMatchObject({ plan: "free", overrides: {}, status: "active", source: "billing", customer_id: "cus_9", subscription_id: "sub_9" });
    expect((await call("POST", "/api/o/shop/invites", buyer, { github_login: "x" })).status).toBe(201); // 2 of Free's 3 seats
    const moved = (await call<{ orgs: PlatformOrgRow[] }>("GET", "/api/platform/orgs", await boss())).json.orgs.find((o) => o.slug === "shop")!;
    expect(moved.plan).toMatchObject({ plan: "free", source: "billing", status: "active", entitlements: PLANS.free.entitlements, seats_used: 2 });
    expect(await rows(`SELECT actor, action FROM org_admin_audit WHERE target = 'shop' AND action LIKE 'plan.%' ORDER BY id`))
      .toEqual([{ actor: "billing", action: "plan.overrides" }, { actor: "billing", action: "plan.status" }, { actor: "billing", action: "plan.change" }]);
  });

  it("setPaidGrantPlan: an UNUSED paid grant follows its subscription's plan and the seats it pays for; the org it becomes takes both", async () => {
    const p = platformCtx(BILLING_ACTOR);
    // What fulfilment mirrored from Stripe: the subscription the grant's `external_ref` names.
    await exec(`INSERT INTO billing_subscriptions (subscription_id, customer_id, plan, stripe_status, plan_status, period_end, created_at, updated_at)
                VALUES ('sub_seats', 'cus_seats', 'team', 'active', 'active', '2026-11-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z')`);
    const g = await grantOrganization(env as unknown as Env, p, { to: { email: "seats@shop.io" }, plan: "team", external_ref: "sub_seats" });
    expect(g).toMatchObject({ plan: "team", overrides: {}, source: "billing", status: "unused" });

    // The buyer changes the quantity at Stripe before naming their org: the grant follows; the same again is a no-op.
    expect(await setPaidGrantPlan(p, "sub_seats", "team", { seats: 7 })).toBe(true);
    expect(await setPaidGrantPlan(p, "sub_seats", "team", { seats: 7 })).toBe(false);
    expect(await one(`SELECT plan, overrides FROM org_grants WHERE id = ?`, g.id)).toEqual({ plan: "team", overrides: `{"seats":7}` });
    expect(await setPaidGrantPlan(p, "sub_nobody", "team", { seats: 3 })).toBe(false); // no grant has that subscription
    // A grant a superadmin made is never moved, even under the same reference.
    const [byHand] = await grantOrgs("handmade", 1, "team");
    await exec(`UPDATE org_grants SET external_ref = 'sub_hand' WHERE id = ?`, byHand);
    expect(await setPaidGrantPlan(p, "sub_hand", "team", { seats: 2 })).toBe(false);
    expect(await one(`SELECT overrides FROM org_grants WHERE id = ?`, byHand)).toEqual({ overrides: "{}" });

    const buyer = await loner("seat-buyer", { email: "seats@shop.io", verified: true });
    expect((await mine(buyer)).grants).toEqual([expect.objectContaining({ id: g.id, plan: "team", plan_name: "Pro", entitlements: { ...PLANS.team.entitlements, seats: 7 } })]);
    expect((await call("POST", "/api/orgs", buyer, { slug: "seven", name: "Seven", grant: g.id })).status).toBe(201);
    // The creating batch copied the subscription's ids, plan, status and period — and the grant's paid seats.
    expect(await one(`SELECT plan, plan_overrides, plan_source, plan_status, plan_period_end, billing_customer_id, billing_subscription_id FROM orgs WHERE slug = 'seven'`)).toEqual({
      plan: "team", plan_overrides: `{"seats":7}`, plan_source: "billing", plan_status: "active", plan_period_end: "2026-11-07T00:00:00.000Z",
      billing_customer_id: "cus_seats", billing_subscription_id: "sub_seats",
    });
    expect((await call<OrgPlanView>("GET", "/api/o/seven/plan", buyer)).json).toMatchObject({ plan: "team", name: "Pro", source: "billing", entitlements: { seats: 7 }, overridden: ["seats"] });
    // A used grant is left alone: from here on the org's own plan is what billing moves.
    expect(await setPaidGrantPlan(p, "sub_seats", "team", { seats: 9 })).toBe(false);
    expect(await one(`SELECT overrides FROM org_grants WHERE id = ?`, g.id)).toEqual({ overrides: `{"seats":7}` });
  });

  it("refuses a bad payment input like any grant, and mails nothing without an origin", async () => {
    const p = platformCtx(BILLING_ACTOR);
    await expect(grantOrganization(env as unknown as Env, p, { to: { email: "nope" }, plan: "team" })).rejects.toMatchObject({ code: "invalid_grant" });
    const quiet = await grantOrganization(env as unknown as Env, p, { to: { email: "quiet@shop.io" }, plan: "personal", external_ref: "pay_q" });
    expect(quiet.mail_status).toBeNull();
    expect(await mails()).toEqual([]);
  });
});

describe("migration 0044_plans — existing orgs", () => {
  const db = () => env.MT_DB;
  async function wipe(): Promise<void> {
    const objs = (await db().prepare(`SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'`).all<{ type: string; name: string; sql: string | null }>()).results;
    if (!objs.length) return;
    const virtual = objs.filter((o) => o.type === "table" && /VIRTUAL TABLE/i.test(o.sql ?? "")).map((o) => o.name);
    const plain = objs.filter((o) => o.type === "table" && !virtual.includes(o.name) && !virtual.some((v) => o.name.startsWith(`${v}_`))).map((o) => o.name);
    await db().batch([
      db().prepare("PRAGMA defer_foreign_keys = true"),
      ...objs.filter((o) => o.type === "trigger").map((o) => db().prepare(`DROP TRIGGER IF EXISTS "${o.name}"`)),
      ...virtual.map((v) => db().prepare(`DROP TABLE IF EXISTS "${v}"`)),
      ...plain.map((t) => db().prepare(`DROP TABLE IF EXISTS "${t}"`)),
      db().prepare("PRAGMA defer_foreign_keys = false"),
    ]);
  }

  it("backfills every existing org to Enterprise (unlimited seats), granted — and touches nothing else in the row", async () => {
    await wipe();
    await applyD1Migrations(db(), env.TEST_MIGRATIONS.filter((m) => m.name < "0044"));
    // SaplingLearn as production has it (seven members), and a second org with an image and a suspension.
    const people = ["p1", "p2", "p3", "p4", "p5", "p6", "p7"];
    await db().batch([
      ...people.map((h) => db().prepare(`INSERT INTO persons (handle, name, color, created_at, onboarded_at) VALUES (?, ?, 'stone', 't', 't')`).bind(h, h)),
      ...people.map((h, i) => db().prepare(`INSERT INTO memberships (org_id, user_id, role, created_at, created_by) VALUES (?, ?, ?, 't', 'seed')`).bind(ORG_A, h, i === 0 ? "owner" : "member")),
      db().prepare(`INSERT INTO orgs (id, slug, name, created_at, created_by, suspended_at, suspended_by, logo_sha) VALUES ('org_two', 'two', 'Two', 't', 'p1', 't2', 'p1', '${"a".repeat(64)}')`),
    ]);
    const before = await db().prepare(`SELECT id, slug, name, created_at, created_by, suspended_at, suspended_by, logo_sha FROM orgs ORDER BY id`).all();

    await applyD1Migrations(db(), env.TEST_MIGRATIONS.filter((m) => m.name.startsWith("0044")));

    expect((await db().prepare(`SELECT id, slug, name, created_at, created_by, suspended_at, suspended_by, logo_sha FROM orgs ORDER BY id`).all()).results).toEqual(before.results);
    expect((await db().prepare(`SELECT id, plan, plan_overrides, plan_source, plan_status, plan_period_end, billing_customer_id, billing_subscription_id, plan_changed_by FROM orgs ORDER BY id`).all()).results).toEqual([
      { id: ORG_A, plan: "enterprise", plan_overrides: "{}", plan_source: "granted", plan_status: "active", plan_period_end: null, billing_customer_id: null, billing_subscription_id: null, plan_changed_by: "migration" },
      { id: "org_two", plan: "enterprise", plan_overrides: "{}", plan_source: "granted", plan_status: "active", plan_period_end: null, billing_customer_id: null, billing_subscription_id: null, plan_changed_by: "migration" },
    ]);
    expect((await db().prepare(`SELECT COUNT(*) AS n FROM memberships WHERE org_id = ?`).bind(ORG_A).first<{ n: number }>())!.n).toBe(7);
    expect((await db().prepare(`SELECT COUNT(*) AS n FROM org_grants`).first<{ n: number }>())!.n).toBe(0);
    // An org written AFTER it by anything that names no plan gets the smallest one (fail closed).
    await db().prepare(`INSERT INTO orgs (id, slug, name, created_at, created_by) VALUES ('org_new', 'newer', 'Newer', 't', 'p1')`).run();
    expect(await db().prepare(`SELECT plan, plan_status FROM orgs WHERE id = 'org_new'`).first()).toEqual({ plan: "personal", plan_status: "active" });
    // The grant table's guards: exactly one target, and only the three stored statuses.
    await expect(db().prepare(`INSERT INTO org_grants (person, email, plan, granted_by, created_at) VALUES ('p1', 'a@b.io', 'team', 'p1', 't')`).run()).rejects.toThrow(/CHECK/);
    await expect(db().prepare(`INSERT INTO org_grants (plan, granted_by, created_at) VALUES ('team', 'p1', 't')`).run()).rejects.toThrow(/CHECK/);
    await expect(db().prepare(`INSERT INTO org_grants (person, plan, granted_by, created_at, status) VALUES ('p1', 'team', 'p1', 't', 'spent')`).run()).rejects.toThrow(/org_grant_usable/);
  });

  it("is additive only: no DROP, no table rebuild, no rename", async () => {
    const sql = (await import("../migrations/0044_plans.sql?raw")).default.replace(/--.*$/gm, "");
    expect(sql).not.toMatch(/\bDROP\b|\bRENAME\b|\bDELETE\b/i);
    for (const stmt of sql.split(";").map((s) => s.trim()).filter(Boolean)) {
      expect(stmt, stmt.slice(0, 60)).toMatch(/^(ALTER TABLE orgs ADD COLUMN|CREATE TABLE IF NOT EXISTS|CREATE (UNIQUE )?INDEX IF NOT EXISTS|UPDATE orgs SET plan = 'enterprise')/);
    }
  });
});

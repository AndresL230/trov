import { describe, it, expect } from "vitest";
import { cookieFor } from "./helpers/persons";
import { ensureMember, ORG_A, ORG_B } from "./helpers/tenant";
import { call, one, rows, exec, grantOrgs, SUPERADMIN } from "./helpers/orgs";
import { REGISTRY } from "../src/notifications/registry";
import { RESERVED_ORG_SLUGS, type MyOrgsResponse, type OrgInvite, type OrgMember, type OrgMeResponse } from "@shared/orgs";

const loner = (handle: string) => cookieFor(handle, { member: false });
const orgId = async (slug: string) => (await one<{ id: string }>(`SELECT id FROM orgs WHERE slug = ?`, slug))!.id;
const roleOf = async (org: string, handle: string) =>
  (await one<{ role: string }>(`SELECT role FROM memberships WHERE org_id = ? AND user_id = ? COLLATE NOCASE`, org, handle))?.role ?? null;
const audit = (org: string) => rows<{ actor: string; action: string; target: string }>(`SELECT actor, action, target FROM org_admin_audit WHERE org_id = ? ORDER BY id`, org);

describe("GET /api/orgs — reachable with no org, and with several", () => {
  it("a person in no org gets an empty picker, not org_required", async () => {
    const { status, json } = await call<MyOrgsResponse>("GET", "/api/orgs", await loner("nomad"));
    expect(status).toBe(200);
    expect(json).toEqual({ orgs: [], invites: [], superadmin: false, can_create: true, grants: [], free: { can_create: true, owned: null } });
  });

  it("lists every membership with its role, and says who is superadmin", async () => {
    await ensureMember(SUPERADMIN, "admin", ORG_B);
    const { status, json } = await call<MyOrgsResponse>("GET", "/api/orgs", await cookieFor(SUPERADMIN));
    expect(status).toBe(200);
    // Each org carries its plan and whether it PAYS for it (personal Settings' Organizations tile): both seed orgs are granted.
    expect(json.orgs).toEqual([
      { slug: "acme", name: "Acme", role: "admin", logo_url: null, plan: "enterprise", paid: false },
      { slug: "saplinglearn", name: "SaplingLearn", role: "owner", logo_url: null, plan: "enterprise", paid: false },
    ]);
    expect(json).toMatchObject({ superadmin: true, can_create: false, grants: [], free: { can_create: false, owned: null } }); // a superadmin adds orgs in Platform, not here
  });

  it("each org says its plan, and `paid` only while a live subscription pays for it", async () => {
    await ensureMember("payer", "owner", ORG_A);
    await ensureMember("payer", "member", ORG_B);
    const read = async () => Object.fromEntries((await call<MyOrgsResponse>("GET", "/api/orgs", await cookieFor("payer"))).json.orgs.map((o) => [o.slug, { plan: o.plan, paid: o.paid }]));
    const restore = await one<Record<string, unknown>>(`SELECT plan, plan_source, plan_status, billing_subscription_id FROM orgs WHERE id = ?`, ORG_B);
    try {
      // Pro through Stripe: paid. The other org (granted) is not.
      await exec(`UPDATE orgs SET plan = 'team', plan_source = 'billing', plan_status = 'active', billing_subscription_id = 'sub_t' WHERE id = ?`, ORG_B);
      expect(await read()).toEqual({ acme: { plan: "team", paid: true }, saplinglearn: { plan: "enterprise", paid: false } });
      // Past due still pays (nothing changes while Stripe retries).
      await exec(`UPDATE orgs SET plan_status = 'past_due' WHERE id = ?`, ORG_B);
      expect((await read()).acme).toEqual({ plan: "team", paid: true });
      // The subscription ended and the org moved to Free: still a billing org, no longer paid.
      await exec(`UPDATE orgs SET plan = 'free', plan_status = 'active' WHERE id = ?`, ORG_B);
      expect((await read()).acme).toEqual({ plan: "free", paid: false });
      // A granted Pro org, and a legacy frozen one: not paid.
      await exec(`UPDATE orgs SET plan = 'team', plan_source = 'granted', billing_subscription_id = NULL WHERE id = ?`, ORG_B);
      expect((await read()).acme).toEqual({ plan: "team", paid: false });
      await exec(`UPDATE orgs SET plan_source = 'billing', plan_status = 'canceled', billing_subscription_id = 'sub_t' WHERE id = ?`, ORG_B);
      expect((await read()).acme).toEqual({ plan: "team", paid: false });
      // An unknown plan id reads as the smallest plan, like everywhere else.
      await exec(`UPDATE orgs SET plan = 'mystery', plan_source = 'granted', plan_status = 'active', billing_subscription_id = NULL WHERE id = ?`, ORG_B);
      expect((await read()).acme).toEqual({ plan: "personal", paid: false });
    } finally {
      await exec(`UPDATE orgs SET plan = ?, plan_source = ?, plan_status = ?, billing_subscription_id = ? WHERE id = ?`, restore!.plan, restore!.plan_source, restore!.plan_status, restore!.billing_subscription_id, ORG_B);
    }
  });

  it("refuses a request carrying an Authorization header", async () => {
    const { status } = await call("GET", "/api/orgs", await loner("nomad"), undefined, { headers: { authorization: "Bearer trov_mcp_x" } });
    expect(status).toBe(403);
  });
});

describe("POST /api/orgs", () => {
  it("a person with no grant creates ONE Free org of their own (issue #94): its owner, on Free, audited — and not a second while they own it", async () => {
    const cookie = await loner("hopeful");
    const r = await call("POST", "/api/orgs", cookie, { slug: "hopeful-co", name: "Hopeful Co" });
    expect(r.status).toBe(201);
    const id = await orgId("hopeful-co");
    expect(await one(`SELECT plan, plan_source, plan_status, plan_overrides FROM orgs WHERE id = ?`, id)).toEqual({ plan: "free", plan_source: "granted", plan_status: "active", plan_overrides: "{}" });
    expect(await roleOf(id, "hopeful")).toBe("owner");
    expect(await audit(id)).toEqual([
      { actor: "hopeful", action: "org.create", target: "hopeful-co" },
      { actor: "hopeful", action: "member.add", target: "hopeful" },
      { actor: "hopeful", action: "org.create_free", target: "hopeful-co" },
    ]);
    expect((await call<MyOrgsResponse>("GET", "/api/orgs", cookie)).json).toMatchObject({ can_create: false, free: { can_create: false, owned: { slug: "hopeful-co", name: "Hopeful Co" } } });

    // The second is refused, and nothing is written.
    const before = await one(`SELECT COUNT(*) AS n FROM orgs`);
    const again = await call("POST", "/api/orgs", cookie, { slug: "hopeful-two", name: "Hopeful Two", plan: "free" });
    expect([again.status, again.json.error]).toEqual([403, "free_org_limit"]);
    expect(again.json.message).toContain("Hopeful Co");
    expect(await one(`SELECT COUNT(*) AS n FROM orgs`)).toEqual(before);

    // Owning a Free org is what counts: once it is on Pro, another Free one can be made.
    await exec(`UPDATE orgs SET plan = 'team' WHERE id = ?`, id);
    expect((await call("POST", "/api/orgs", cookie, { slug: "hopeful-two", name: "Hopeful Two" })).status).toBe(201);
    expect(await one(`SELECT plan FROM orgs WHERE slug = 'hopeful-two'`)).toEqual({ plan: "free" });
  });

  it("the one-Free-org rule holds inside the creating batch: two racing requests make one org", async () => {
    const cookie = await loner("racer");
    const [a, b] = await Promise.all([
      call("POST", "/api/orgs", cookie, { slug: "race-one", name: "Race One" }),
      call("POST", "/api/orgs", cookie, { slug: "race-two", name: "Race Two" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 403]);
    expect([a.json.error, b.json.error].filter(Boolean)).toEqual(["free_org_limit"]);
    expect(await one(`SELECT COUNT(*) AS n FROM memberships m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = 'racer' AND o.plan = 'free'`)).toEqual({ n: 1 });
    expect(await one(`SELECT COUNT(*) AS n FROM orgs WHERE slug IN ('race-one', 'race-two')`)).toEqual({ n: 1 });
  });

  it("the guard itself: a creating batch whose check ran before another Free org landed fails whole", async () => {
    const { createFreeOrg, freeGuardStmt } = await import("../src/plans/free");
    const { createOrg } = await import("../src/orgs/repo");
    const { platform } = await import("../src/data/context");
    const { env } = await import("cloudflare:test");
    await loner("sneaky");
    const p = platform(env as never, "sneaky");
    await createFreeOrg(p, "sneaky", { slug: "sneaky-one", name: "Sneaky One" });
    // What a racing request's batch is once the first has landed: the same statements, its check long passed.
    await expect(createOrg(p, {
      slug: "sneaky-two", name: "Sneaky Two", owner: "sneaky", plan: { id: "free", overrides: {}, source: "granted" },
      extra: (orgId, at) => [freeGuardStmt(p, "sneaky", orgId, "sneaky-two", at)],
    })).rejects.toThrow(/NOT NULL constraint failed: org_admin_audit\.detail/);
    expect(await one(`SELECT COUNT(*) AS n FROM orgs WHERE slug = 'sneaky-two'`)).toEqual({ n: 0 });
    expect(await one(`SELECT COUNT(*) AS n FROM memberships WHERE user_id = 'sneaky'`)).toEqual({ n: 1 });
  });

  it("creates the org, makes the creator its owner, and seeds every per-org singleton", async () => {
    const cookie = await loner("founder");
    const [grant] = await grantOrgs("founder");
    const { status, json } = await call("POST", "/api/orgs", cookie, { slug: "birch", name: "  Birch Labs " });
    expect(status).toBe(201);
    expect(json).toEqual({ ok: true, org: { slug: "birch", name: "Birch Labs", role: "owner", logo_url: null } });

    const id = await orgId("birch");
    expect(id).toMatch(/^org_[a-z2-7]{26}$/);
    expect(await one(`SELECT created_by FROM orgs WHERE id = ?`, id)).toEqual({ created_by: "founder" });
    expect(await roleOf(id, "founder")).toBe("owner");
    // The singletons 0042_organizations seeded for SaplingLearn: plan, notification settings + policy, both counters.
    expect(await one(`SELECT narrative, current_version FROM plan WHERE org_id = ?`, id)).toEqual({ narrative: "", current_version: 0 });
    expect(await one(`SELECT send_hour, timezone, from_address FROM notification_settings WHERE org_id = ?`, id))
      .toEqual({ send_hour: 8, timezone: "America/New_York", from_address: "Trov <hello@trov.dev>" });
    expect((await rows<{ kind: string }>(`SELECT kind FROM notification_policy WHERE org_id = ? ORDER BY kind`, id)).map((r) => r.kind))
      .toEqual(REGISTRY.map((k) => k.id).sort());
    expect(await rows(`SELECT name, value FROM org_counters WHERE org_id = ? ORDER BY name`, id)).toEqual([{ name: "handoff", value: 0 }, { name: "ticket", value: 0 }]);
    // …so the new org's first ticket is #1, whatever SaplingLearn's counter says.
    await exec(`INSERT INTO tickets (org_id, title, requester, created_at, updated_at) VALUES (?, 'first', 'founder', '2026-10-06T00:00:00Z', '2026-10-06T00:00:00Z')`, id);
    expect(await one(`SELECT number FROM tickets WHERE org_id = ?`, id)).toEqual({ number: 1 });
    expect(await audit(id)).toEqual([
      { actor: "founder", action: "org.create", target: "birch" },
      { actor: "founder", action: "member.add", target: "founder" },
      { actor: "founder", action: "grant.use", target: `grant:${grant}` },
    ]);

    // …and it is a working tenant: the creator reaches it, a stranger gets 404.
    const me = await call<OrgMeResponse>("GET", "/api/o/birch/me", cookie);
    expect(me.json).toEqual({ org: { slug: "birch", name: "Birch Labs", logo_url: null }, role: "owner", title: null, responsibilities: null, repos: { primary: null, all: [] } });
    expect((await call("GET", "/api/o/birch/me", await loner("stranger"))).status).toBe(404);
  });

  it("refuses invalid and reserved slugs, a bad name, and a taken slug", async () => {
    const cookie = await loner("founder");
    await grantOrgs("founder");
    for (const slug of ["a", "-lead", "Has-Caps", "under_score", "x".repeat(40), "", 7]) {
      const r = await call("POST", "/api/orgs", cookie, { slug, name: "N" });
      expect([r.status, r.json.error], String(slug)).toEqual([400, "invalid_slug"]);
    }
    for (const slug of ["api", "auth", "orgs", "platform", "admin", "www", "trov", "canopy"]) {
      expect(RESERVED_ORG_SLUGS).toContain(slug);
      const r = await call("POST", "/api/orgs", cookie, { slug, name: "N" });
      expect([r.status, r.json.error], slug).toEqual([400, "reserved_slug"]);
    }
    expect((await call("POST", "/api/orgs", cookie, { slug: "fine", name: "" })).json.error).toBe("invalid_name");
    expect((await call("POST", "/api/orgs", cookie, { slug: "fine", name: "x".repeat(81) })).json.error).toBe("invalid_name");
    const taken = await call("POST", "/api/orgs", cookie, { slug: "acme", name: "Another Acme" });
    expect([taken.status, taken.json.error]).toEqual([409, "slug_taken"]);
    expect(await one(`SELECT COUNT(*) AS n FROM orgs`)).toEqual({ n: 2 });
    // A refused create spends nothing: the grant is still there to use.
    expect(await one(`SELECT status FROM org_grants WHERE person = 'founder'`)).toEqual({ status: "unused" });
  });

  it("one org per grant, then one Free org; persons.org_limit grants nothing any more; a superadmin has no exemption", async () => {
    const cookie = await loner("founder");
    await grantOrgs("founder", 3);
    for (const slug of ["one-co", "two-co", "three-co"]) expect((await call("POST", "/api/orgs", cookie, { slug, name: slug })).status).toBe(201);
    // The grants are spent: what is left is the one Free org.
    expect((await call<MyOrgsResponse>("GET", "/api/orgs", cookie)).json).toMatchObject({ can_create: true, grants: [], free: { can_create: true } });
    expect((await call("POST", "/api/orgs", cookie, { slug: "free-co", name: "Free" })).status).toBe(201);
    const fifth = await call("POST", "/api/orgs", cookie, { slug: "four-co", name: "Four" });
    expect([fifth.status, fifth.json.error]).toEqual([403, "free_org_limit"]);
    expect((await call<MyOrgsResponse>("GET", "/api/orgs", cookie)).json).toMatchObject({ can_create: false, grants: [] });

    // The allowance from before grants is a dead column: setting it opens nothing.
    await exec(`UPDATE persons SET org_limit = 10 WHERE handle = 'founder'`);
    expect((await call("POST", "/api/orgs", cookie, { slug: "four-co", name: "Four" })).status).toBe(403);
    await grantOrgs("founder");
    expect((await call("POST", "/api/orgs", cookie, { slug: "four-co", name: "Four" })).status).toBe(201);
    expect((await call("POST", "/api/orgs", cookie, { slug: "five-co", name: "Five" })).status).toBe(403);
    // Holding a grant, `plan: "free"` still asks for Free — and leaves the grant unused.
    await grantOrgs("founder");
    expect((await call("POST", "/api/orgs", cookie, { slug: "five-co", name: "Five", plan: "free" })).json.error).toBe("free_org_limit");
    expect(await one(`SELECT COUNT(*) AS n FROM org_grants WHERE person = 'founder' AND status = 'unused'`)).toEqual({ n: 1 });

    // A superadmin creates organizations in Platform (which names the admin), not through this route.
    const boss = await cookieFor(SUPERADMIN);
    const self = await call("POST", "/api/orgs", boss, { slug: "super-own", name: "Super Own" });
    expect([self.status, self.json.error]).toEqual([403, "no_grant"]);
    expect((await call("POST", "/api/platform/orgs", boss, { slug: "super-made", name: "Super Made", admin: { handle: "founder" } })).status).toBe(201);
  });
});

describe("invites — who may accept", () => {
  const invite = (o: { org?: string; github_login?: string; email?: string; role?: string; as_owner?: number }) =>
    exec(`INSERT INTO org_invites (org_id, github_login, email, role, as_owner, invited_by, status, created_at) VALUES (?, ?, ?, ?, ?, 'AndresL230', 'pending', '2026-10-06T00:00:00Z')`,
      o.org ?? ORG_B, o.github_login ?? null, o.email ?? null, o.role ?? "member", o.as_owner ?? 0).then((r) => r.meta.last_row_id);

  it("a GitHub-login invite belongs to whoever holds that login (case-insensitively), and accepting joins the org", async () => {
    const id = await invite({ github_login: "Octo-Cat", role: "admin" });
    const cookie = await loner("octo-cat"); // seedPerson gives the github identity `octo-cat`
    const mine = await call<MyOrgsResponse>("GET", "/api/orgs", cookie);
    expect(mine.json.invites).toEqual([{ id, org: { slug: "acme", name: "Acme", logo_url: null }, role: "admin", invited_by: "AndresL230", created_at: "2026-10-06T00:00:00Z", github_login: "Octo-Cat", email: null }]);
    expect((await call<{ invites: unknown[] }>("GET", "/api/invites", cookie)).json.invites).toHaveLength(1);

    const res = await call("POST", `/api/invites/${id}/accept`, cookie);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, org: { slug: "acme", name: "Acme" }, role: "admin" });
    expect(await roleOf(ORG_B, "octo-cat")).toBe("admin");
    expect(await one(`SELECT status, responded_by FROM org_invites WHERE id = ?`, id)).toEqual({ status: "accepted", responded_by: "octo-cat" });
    expect((await call<OrgMeResponse>("GET", "/api/o/acme/me", cookie)).json.role).toBe("admin");
    expect((await audit(ORG_B)).map((a) => a.action)).toEqual(["invite.accept", "member.add"]);
    // Answered: it is nobody's any more.
    expect((await call("POST", `/api/invites/${id}/accept`, cookie)).status).toBe(404);
  });

  it("an email invite matches a provider-VERIFIED email — never the editable persons.email", async () => {
    const id = await invite({ email: "Priya@Example.com" });
    // `editor` typed the address into their profile; no provider vouched for it.
    const editor = await cookieFor("editor", { member: false, email: "priya@example.com" });
    expect((await call<MyOrgsResponse>("GET", "/api/orgs", editor)).json.invites).toEqual([]);
    expect((await call("POST", `/api/invites/${id}/accept`, editor)).status).toBe(404);
    expect(await roleOf(ORG_B, "editor")).toBeNull();

    const priya = await cookieFor("priya", { member: false, github: false });
    await exec(`INSERT INTO identities (provider, subject, label, person, linked_at, linked_by, verified_email) VALUES ('google', 'sub-priya', 'priya@example.com', 'priya', '2026-01-01T00:00:00Z', 'seed', 'priya@example.com')`);
    expect((await call<MyOrgsResponse>("GET", "/api/orgs", priya)).json.invites.map((i) => i.id)).toEqual([id]);
    expect((await call("POST", `/api/invites/${id}/accept`, priya)).status).toBe(200);
    expect(await roleOf(ORG_B, "priya")).toBe("member");
  });

  it("a signed-in person whose identities do not match can neither see, accept nor decline it", async () => {
    const id = await invite({ github_login: "octo-cat" });
    const other = await loner("someone-else");
    expect((await call<MyOrgsResponse>("GET", "/api/orgs", other)).json.invites).toEqual([]);
    expect((await call("POST", `/api/invites/${id}/accept`, other)).status).toBe(404);
    expect((await call("POST", `/api/invites/${id}/decline`, other)).status).toBe(404);
    expect((await call("POST", `/api/invites/not-a-number/accept`, other)).status).toBe(404);
    expect(await one(`SELECT status FROM org_invites WHERE id = ?`, id)).toEqual({ status: "pending" });
    expect(await roleOf(ORG_B, "someone-else")).toBeNull();
  });

  it("declining stamps the invite and joins nothing; a revoked invite cannot be accepted", async () => {
    const declined = await invite({ github_login: "octo-cat" });
    const cookie = await loner("octo-cat");
    expect((await call("POST", `/api/invites/${declined}/decline`, cookie)).json).toEqual({ ok: true, org: { slug: "acme", name: "Acme" }, role: null });
    expect(await one(`SELECT status FROM org_invites WHERE id = ?`, declined)).toEqual({ status: "declined" });
    expect(await roleOf(ORG_B, "octo-cat")).toBeNull();

    const revoked = await invite({ github_login: "octo-cat" });
    await exec(`UPDATE org_invites SET status = 'revoked' WHERE id = ?`, revoked);
    expect((await call("POST", `/api/invites/${revoked}/accept`, cookie)).status).toBe(404);
  });

  it("an as_owner invite (a superadmin's) grants OWNER; an ordinary invite never does", async () => {
    const id = await invite({ github_login: "octo-cat", role: "admin", as_owner: 1 });
    const cookie = await loner("octo-cat");
    expect((await call<MyOrgsResponse>("GET", "/api/orgs", cookie)).json.invites[0].role).toBe("owner");
    expect((await call("POST", `/api/invites/${id}/accept`, cookie)).json.role).toBe("owner");
    expect(await roleOf(ORG_B, "octo-cat")).toBe("owner");
  });
});

describe("/api/o/:slug — settings, members, invites", () => {
  /** Acme with an owner, an admin and a member. */
  async function acme() {
    await ensureMember("olive", "owner", ORG_B);
    await ensureMember("adam", "admin", ORG_B);
    await ensureMember("mia", "member", ORG_B);
    const c = (h: string) => cookieFor(h, { member: false });
    return { owner: await c("olive"), admin: await c("adam"), member: await c("mia") };
  }

  it("404s a non-member and an unknown slug alike; 401s without a session", async () => {
    await acme();
    const outsider = await loner("outsider");
    for (const path of ["/api/o/acme/me", "/api/o/acme/members", "/api/o/acme/settings", "/api/o/acme/invites", "/api/o/nope/me"]) {
      expect((await call("GET", path, outsider)).status, path).toBe(404);
    }
    expect((await call("GET", "/api/o/acme/me", "")).status).toBe(401);
  });

  it("/me returns the caller's role, title and responsibilities in THIS org", async () => {
    const { member } = await acme();
    await exec(`UPDATE memberships SET title = 'Designer', responsibilities = 'The UI' WHERE org_id = ? AND user_id = 'mia'`, ORG_B);
    expect((await call("GET", "/api/o/acme/me", member)).json).toEqual({ org: { slug: "acme", name: "Acme", logo_url: null }, role: "member", title: "Designer", responsibilities: "The UI", repos: { primary: null, all: [] } });
    // §9: the org's repositories — primary first — are what the SPA builds its GitHub URLs from.
    await exec(`INSERT INTO org_repos (id, org_id, repo_full_name, is_primary, created_at, created_by) VALUES ('hook_a1', ?, 'acme/site', 0, '2026-10-01T00:00:00Z', 'seed'), ('hook_a2', ?, 'acme/widgets', 1, '2026-10-02T00:00:00Z', 'seed')`, ORG_B, ORG_B);
    expect((await call<OrgMeResponse>("GET", "/api/o/acme/me", member)).json.repos).toEqual({ primary: "acme/widgets", all: ["acme/widgets", "acme/site"] });
  });

  it("settings: any member reads; only admin+ renames; the change is audited", async () => {
    const { admin, member } = await acme();
    expect((await call("GET", "/api/o/acme/settings", member)).json).toEqual({
      org: { slug: "acme", name: "Acme", created_at: "2026-10-06T00:00:00.000Z", created_by: "migration", logo: { url: null, source: null, by: null, from: null, at: null } }, can_edit: false,
    });
    expect((await call("PUT", "/api/o/acme/settings", member, { name: "Mine" })).status).toBe(403);
    expect((await call("PUT", "/api/o/acme/settings", admin, { name: "" })).status).toBe(400);
    const ok = await call<{ org: { name: string } }>("PUT", "/api/o/acme/settings", admin, { name: "Acme Corp" });
    expect([ok.status, ok.json.org.name]).toEqual([200, "Acme Corp"]);
    expect(await audit(ORG_B)).toEqual([{ actor: "adam", action: "org.update", target: "settings" }]);
    expect((await call("PUT", "/api/o/acme/settings", admin, { name: "X" }, { headers: { authorization: "Bearer x" } })).status).toBe(403);
    await exec(`UPDATE orgs SET name = 'Acme' WHERE id = ?`, ORG_B); // the seed org outlives the test
  });

  it("members: listed owners-first; responsibilities only for admin+", async () => {
    const { admin, member } = await acme();
    await exec(`UPDATE memberships SET responsibilities = 'Everything' WHERE org_id = ? AND user_id = 'olive'`, ORG_B);
    const asMember = (await call<{ members: OrgMember[] }>("GET", "/api/o/acme/members", member)).json.members;
    expect(asMember.map((m) => [m.handle, m.role])).toEqual([["olive", "owner"], ["adam", "admin"], ["mia", "member"]]);
    expect(asMember[0]).toEqual({ handle: "olive", name: "olive", color: "stone", avatar_url: null, role: "owner", title: null, joined_at: "2026-01-01T00:00:00Z" });
    const asAdmin = (await call<{ members: OrgMember[] }>("GET", "/api/o/acme/members", admin)).json.members;
    expect(asAdmin[0].responsibilities).toBe("Everything");
  });

  it("role changes: admin+ only, and only an owner grants or revokes owner", async () => {
    const { owner, admin, member } = await acme();
    expect((await call("PUT", "/api/o/acme/members/adam", member, { role: "member" })).status).toBe(403);
    expect((await call("PUT", "/api/o/acme/members/ghost", admin, { role: "admin" })).status).toBe(404);
    expect((await call("PUT", "/api/o/acme/members/mia", admin, { role: "boss" })).status).toBe(400);

    const promoted = await call<{ members: OrgMember[] }>("PUT", "/api/o/acme/members/MIA", admin, { role: "admin", title: " Lead ", responsibilities: "Design" });
    expect(promoted.status).toBe(200);
    expect(promoted.json.members.find((m) => m.handle === "mia")).toMatchObject({ role: "admin", title: "Lead", responsibilities: "Design" });

    expect((await call("PUT", "/api/o/acme/members/mia", admin, { role: "owner" })).status).toBe(403);   // an admin cannot mint an owner
    expect((await call("PUT", "/api/o/acme/members/olive", admin, { role: "admin" })).status).toBe(403); // …nor demote one
    expect((await call("PUT", "/api/o/acme/members/olive", admin, { title: "Founder" })).status).toBe(200); // a title is not a role change
    expect((await call("PUT", "/api/o/acme/members/mia", owner, { role: "owner" })).status).toBe(200);
    expect(await roleOf(ORG_B, "mia")).toBe("owner");
    expect((await audit(ORG_B)).map((a) => [a.actor, a.action, a.target])).toEqual([
      ["adam", "member.update", "mia"], ["adam", "member.update", "olive"], ["olive", "member.update", "mia"],
    ]);
  });

  it("the last owner can be neither demoted nor removed, nor leave (409) — until there is a second", async () => {
    const { owner } = await acme();
    for (const r of [
      await call("PUT", "/api/o/acme/members/olive", owner, { role: "admin" }),
      await call("DELETE", "/api/o/acme/members/olive", owner),
    ]) expect([r.status, r.json.error]).toEqual([409, "last_owner"]);
    expect(await roleOf(ORG_B, "olive")).toBe("owner");

    expect((await call("PUT", "/api/o/acme/members/adam", owner, { role: "owner" })).status).toBe(200);
    expect((await call("PUT", "/api/o/acme/members/olive", owner, { role: "member" })).status).toBe(200);
    expect(await roleOf(ORG_B, "olive")).toBe("member");
    // adam is now the only owner.
    expect((await call("DELETE", "/api/o/acme/members/adam", await cookieFor("adam", { member: false }))).status).toBe(409);
  });

  it("leave: any member removes themselves; a member cannot remove someone else", async () => {
    const { member } = await acme();
    expect((await call("DELETE", "/api/o/acme/members/adam", member)).status).toBe(403);
    expect((await call("DELETE", "/api/o/acme/members/mia", member)).json).toEqual({ ok: true, left: true });
    expect(await roleOf(ORG_B, "mia")).toBeNull();
    expect((await call("GET", "/api/o/acme/me", member)).status).toBe(404);
    expect((await audit(ORG_B)).at(-1)).toEqual({ actor: "mia", action: "member.leave", target: "mia" });
  });

  it("removal revokes that person's MCP tokens and OAuth grants for THIS org only, and keeps their content", async () => {
    const { admin } = await acme();
    await ensureMember("mia", "member", ORG_A);
    for (const [org, hash] of [[ORG_B, "h-b"], [ORG_A, "h-a"]]) {
      await exec(`INSERT INTO mcp_tokens (person, token_hash, created_at, org_id) VALUES ('mia', ?, '2026-01-01T00:00:00Z', ?)`, hash, org);
      await exec(`INSERT INTO oauth_grants (person, client_id, client_name, created_at, org_id) VALUES ('mia', 'c1', 'Claude', '2026-01-01T00:00:00Z', ?)`, org);
      await exec(`INSERT INTO oauth_grant_orgs (grant_id, org_id, person, added_at) SELECT id, org_id, person, created_at FROM oauth_grants WHERE org_id = ? AND person = 'mia'`, org); // as 0051 backfills it
    }
    await exec(`INSERT INTO mcp_tokens (person, token_hash, created_at, org_id) VALUES ('adam', 'h-adam', '2026-01-01T00:00:00Z', ?)`, ORG_B);
    await exec(`INSERT INTO feed (org_id, author, summary, created_at) VALUES (?, 'mia', 'shipped', '2026-01-01T00:00:00Z')`, ORG_B);

    expect((await call("DELETE", "/api/o/acme/members/mia", admin)).json).toEqual({ ok: true, left: false });
    expect(await roleOf(ORG_B, "mia")).toBeNull();
    expect(await roleOf(ORG_A, "mia")).toBe("member");
    expect(await rows(`SELECT token_hash, revoked FROM mcp_tokens ORDER BY token_hash`)).toEqual([
      { token_hash: "h-a", revoked: 0 }, { token_hash: "h-adam", revoked: 0 }, { token_hash: "h-b", revoked: 1 },
    ]);
    expect(await rows(`SELECT org_id, revoked_at IS NOT NULL AS revoked, revoked_reason FROM oauth_grants ORDER BY org_id`)).toEqual([
      { org_id: ORG_B, revoked: 1, revoked_reason: "member_removed" }, { org_id: ORG_A, revoked: 0, revoked_reason: null },
    ]);
    // The connection into the other org keeps its one organization; the revoked one holds none.
    expect(await rows(`SELECT org_id FROM oauth_grant_orgs WHERE person = 'mia'`)).toEqual([{ org_id: ORG_A }]);
    expect(await one(`SELECT COUNT(*) AS n FROM feed WHERE org_id = ? AND author = 'mia'`, ORG_B)).toEqual({ n: 1 });
    expect((await audit(ORG_B)).at(-1)).toEqual({ actor: "adam", action: "member.remove", target: "mia" });
    // An admin cannot remove an owner.
    expect((await call("DELETE", "/api/o/acme/members/olive", admin)).status).toBe(403);
  });

  it("invites: admin+ creates by login or email as admin|member, lists and revokes; members cannot", async () => {
    const { admin, member } = await acme();
    expect((await call("GET", "/api/o/acme/invites", member)).status).toBe(403);
    expect((await call("POST", "/api/o/acme/invites", member, { github_login: "new-dev" })).status).toBe(403);

    const byLogin = await call<{ invite: OrgInvite }>("POST", "/api/o/acme/invites", admin, { github_login: "new-dev" });
    expect(byLogin.status).toBe(201);
    expect(byLogin.json.invite).toMatchObject({ github_login: "new-dev", email: null, role: "member", status: "pending", invited_by: "adam", responded_at: null });
    const byEmail = await call<{ invite: OrgInvite }>("POST", "/api/o/acme/invites", admin, { email: "New.Dev@Example.com", role: "admin" });
    expect(byEmail.json.invite).toMatchObject({ github_login: null, email: "new.dev@example.com", role: "admin" });
    expect(await one(`SELECT as_owner FROM org_invites WHERE id = ?`, byEmail.json.invite.id)).toEqual({ as_owner: 0 });

    for (const bad of [{}, { github_login: "a", email: "b@c.de" }, { github_login: "not a login" }, { email: "nope" }, { github_login: "x", role: "owner" }]) {
      const r = await call("POST", "/api/o/acme/invites", admin, bad);
      expect([r.status, r.json.error], JSON.stringify(bad)).toEqual([400, "invalid_invite"]);
    }
    expect((await call("POST", "/api/o/acme/invites", admin, { github_login: "NEW-DEV" })).json.error).toBe("invite_exists");
    expect((await call("POST", "/api/o/acme/invites", admin, { github_login: "mia" })).json.error).toBe("already_member");

    const list = (await call<{ invites: OrgInvite[] }>("GET", "/api/o/acme/invites", admin)).json.invites;
    expect(list.map((i) => i.id).sort()).toEqual([byLogin.json.invite.id, byEmail.json.invite.id].sort());

    expect((await call("POST", `/api/o/acme/invites/${byLogin.json.invite.id}/revoke`, admin)).json).toEqual({ ok: true });
    expect((await call("POST", `/api/o/acme/invites/${byLogin.json.invite.id}/revoke`, admin)).status).toBe(404);
    expect(await one(`SELECT status, responded_by FROM org_invites WHERE id = ?`, byLogin.json.invite.id)).toEqual({ status: "revoked", responded_by: "adam" });
    expect((await audit(ORG_B)).map((a) => [a.action, a.target])).toEqual([
      ["invite.create", `invite:${byLogin.json.invite.id}`], ["invite.create", `invite:${byEmail.json.invite.id}`], ["invite.revoke", `invite:${byLogin.json.invite.id}`],
    ]);
    // Another org's admin cannot revoke it by id.
    await ensureMember("sap-admin", "admin", ORG_A);
    expect((await call("POST", `/api/o/saplinglearn/invites/${byEmail.json.invite.id}/revoke`, await cookieFor("sap-admin"))).status).toBe(404);
  });
});

describe("soleTenantGate still guards the legacy routes", () => {
  it("a person in no org gets 409 org_required there, and reaches the picker", async () => {
    const cookie = await loner("nomad");
    expect((await call("GET", "/docs", cookie)).status).toBe(409);
    expect((await call("GET", "/api/orgs", cookie)).status).toBe(200);
    expect((await call("GET", "/api/invites", cookie)).status).toBe(200);
  });
});

describe("GET /api/orgs/slug-check — is an organization handle free", () => {
  const check = async (slug: string, cookie: string) => call<{ available: boolean; reason?: string }>("GET", `/api/orgs/slug-check?slug=${encodeURIComponent(slug)}`, cookie);

  it("answers for a person in no org: free, taken (any org's, whatever its case), reserved, invalid", async () => {
    const cookie = await loner("nomad");
    expect((await check("brand-new-co", cookie)).json).toEqual({ available: true });
    expect((await check("acme", cookie)).json).toEqual({ available: false, reason: "taken" });
    expect((await check(" Acme ", cookie)).json).toEqual({ available: false, reason: "taken" });
    expect((await check(RESERVED_ORG_SLUGS[0], cookie)).json).toEqual({ available: false, reason: "reserved" });
    expect((await check("-nope", cookie)).json).toEqual({ available: false, reason: "invalid" });
    expect((await check("", cookie)).json).toEqual({ available: false, reason: "invalid" });
  });

  it("says what Create then does: a handle it calls free can be created, and is taken afterwards", async () => {
    const cookie = await loner("hopeful");
    expect((await check("hopeful-co", cookie)).json.available).toBe(true);
    expect((await call("POST", "/api/orgs", cookie, { slug: "hopeful-co", name: "Hopeful Co" })).status).toBe(201);
    expect((await check("hopeful-co", await loner("nomad"))).json).toEqual({ available: false, reason: "taken" });
  });

  it("needs a session, and is capped per person with the handle-check allowance", async () => {
    expect((await call("GET", "/api/orgs/slug-check?slug=acme", "")).status).toBe(401);
    const cookie = await loner("nomad");
    await exec(`INSERT INTO abuse_counters (subject, action, bucket, count, last_at) VALUES ('nomad', 'handle_check', strftime('%Y-%m-%dT%H', 'now'), 60, 't')`);
    const r = await check("acme", cookie);
    expect(r.status).toBe(429);
  });
});

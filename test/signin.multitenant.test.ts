// Sign-in and onboarding once sign-in is tied to no GitHub org (canopy-multitenancy.md §5.1, C-2):
//   • any GitHub account reaches onboarding; a Google account only with a pending invite for its VERIFIED email
//     (an `org_invites` row of any live org, or a legacy SaplingLearn invite);
//   • onboarding creates a PERSON, never a membership — except that a legacy invite is consumed as a
//     SaplingLearn membership, as it always was;
//   • a person in no org reaches nothing tenant-scoped; `/auth/me` tells the SPA which orgs and how many
//     pending invites they have;
//   • nothing a person (or an org's admin) can type into `persons.email` signs anyone in as someone else.
// The callbacks run through `buildAuthApp({ fetchImpl })` (the providers are stubbed); everything after the
// session cookie runs through the real app.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { app } from "../src/routes";
import { buildAuthApp } from "../src/auth/routes";
import { sessionGate, type AppEnv } from "../src/auth/principal";
import { hmacSeal } from "../src/auth/crypto";
import { all, first, run } from "./helpers/db";
import { cookieFor, seedPerson } from "./helpers/persons";
import { fakeGithubFetch } from "./helpers/github";
import { makeGoogleKeys, signIdToken, googleFetch, CLAIMS } from "./helpers/google";
import { ORG_A, ORG_B, ensureMember } from "./helpers/tenant";

const NOW = () => 1_800_000_100_000;
function authWith(fetchImpl: typeof fetch): Hono<AppEnv> {
  const a = new Hono<AppEnv>();
  a.use("*", sessionGate);
  a.route("/auth", buildAuthApp({ fetchImpl, now: NOW }));
  return a;
}
const tx = async () => `oauth_tx=${await hmacSeal("st.ver.signin", "test-cookie-secret")}`;
const cookieOf = (res: Response, name: string): string | null => new RegExp(`${name}=[^;,]+`).exec(res.headers.get("set-cookie") ?? "")?.[0] ?? null;

const github = async (login: string, emails: { email: string; primary: boolean; verified: boolean }[] = []) =>
  authWith(fakeGithubFetch({ login, name: null, avatar_url: null }, emails)).request("/auth/callback?code=c&state=st", { headers: { cookie: await tx() } }, env);
const google = async (claims: Record<string, unknown> = {}) => {
  const keys = await makeGoogleKeys();
  return authWith(googleFetch(keys, { idToken: await signIdToken(keys, { ...CLAIMS, ...claims }) }).fetchImpl)
    .request("/auth/google/callback?code=c&state=st", { headers: { cookie: await tx() } }, env);
};
const json = async (method: string, path: string, cookie: string, body?: unknown) => {
  const res = await app.request(path, { method, headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown>, res };
};
/** Finish onboarding with the onboard cookie a callback set; returns the session cookie. */
async function onboard(callback: Response, handle: string): Promise<string> {
  expect(callback.status).toBe(302);
  expect(callback.headers.get("location")).toBe("/#onboard");
  const done = await json("POST", "/auth/onboard", cookieOf(callback, "onboard")!, { handle, name: null, color: "sky" });
  expect([done.status, done.json]).toEqual([200, { ok: true, handle }]);
  return cookieOf(done.res, "session")!;
}
const memberships = (handle: string) => all<{ org_id: string; role: string }>(env.DB, `SELECT org_id, role FROM memberships WHERE user_id = ? ORDER BY org_id`, handle);
const orgInvite = (o: { org?: string; email?: string; github_login?: string; role?: string }) =>
  run(env.DB, `INSERT INTO org_invites (org_id, github_login, email, role, invited_by, status, created_at) VALUES (?, ?, ?, ?, 'AndresL230', 'pending', '2026-10-06T00:00:00Z')`,
    o.org ?? ORG_B, o.github_login ?? null, o.email ?? null, o.role ?? "member").then((r) => r.meta.last_row_id as number);
const legacyInvite = (email: string, name: string | null = null) =>
  run(env.DB, `INSERT INTO invites (email, name, invited_by, invited_at) VALUES (?, ?, 'AndresL230', '2026-10-01T00:00:00Z')`, email, name);
const VERIFIED = (email: string) => [{ email, primary: true, verified: true }];

describe("an existing SaplingLearn member", () => {
  it("signs in as before; /auth/me keeps `admin` and `org`, and gains `orgs`, `superadmin`, `pending_invites`", async () => {
    const res = await github("AndresL230", VERIFIED("andres@saplinglearn.org"));
    expect([res.status, res.headers.get("location")]).toEqual([302, "/"]);
    const session = cookieOf(res, "session")!;
    const me = await json("GET", "/auth/me", session);
    expect(me.json).toMatchObject({
      handle: "AndresL230", org: "SaplingLearn", admin: true, superadmin: true, pending_invites: 0,
      orgs: [{ slug: "saplinglearn", name: "SaplingLearn", role: "owner" }],
    });
    // The provider-verified address is recorded on the identity at every sign-in (Q1).
    expect(await first(env.DB, `SELECT verified_email FROM identities WHERE provider = 'github' AND subject = 'AndresL230'`)).toEqual({ verified_email: "andres@saplinglearn.org" });
    expect((await json("GET", "/docs", session)).status).toBe(200);
    expect((await json("GET", "/api/o/saplinglearn/docs", session)).status).toBe(200);
  });

  it("a plain member: `admin` false, the same one org", async () => {
    const me = await json("GET", "/auth/me", await cookieFor("casey"));
    expect(me.json).toMatchObject({ org: "SaplingLearn", admin: false, superadmin: false, orgs: [{ slug: "saplinglearn", name: "SaplingLearn", role: "member" }] });
  });

  it("in two orgs: `orgs` lists both; `admin` and `org` speak for no single org", async () => {
    await ensureMember("dual", "member", ORG_A);
    await ensureMember("dual", "owner", ORG_B);
    const me = await json("GET", "/auth/me", await cookieFor("dual"));
    expect(me.json).toMatchObject({ org: "", admin: false, role: null });
    expect(me.json.orgs).toEqual([{ slug: "acme", name: "Acme", role: "owner" }, { slug: "saplinglearn", name: "SaplingLearn", role: "member" }]);
  });
});

describe("a new GitHub account", () => {
  it("with no invite: onboards (no GitHub org is asked about), joins NO org, reaches nothing tenant-scoped, can create an org", async () => {
    const session = await onboard(await github("stranger", VERIFIED("stranger@example.com")), "stranger");
    expect(await memberships("stranger")).toEqual([]);
    expect(await first(env.DB, `SELECT verified_email FROM identities WHERE subject = 'stranger'`)).toEqual({ verified_email: "stranger@example.com" });
    expect((await json("GET", "/auth/me", session)).json).toMatchObject({ handle: "stranger", org: "", admin: false, superadmin: false, orgs: [], pending_invites: 0 });

    for (const path of ["/docs", "/feed", "/tickets", "/persons", "/api/prompts", "/api/artifacts", "/api/notifications/prefs", "/invites", "/raw/a/anything", "/img/" + "a".repeat(64)]) {
      const r = await json("GET", path, session);
      expect([r.status, r.json], path).toEqual([409, { error: "org_required" }]);
    }
    expect((await json("GET", "/api/o/saplinglearn/docs", session)).status).toBe(404);
    expect((await json("GET", "/api/o/saplinglearn/me", session)).status).toBe(404);
    expect((await json("POST", "/auth/mcp-token", session)).status).toBe(409);
    // No welcome mail: mail goes out as an org, and they are in none.
    expect(await first(env.DB, `SELECT 1 AS x FROM notification_outbox_bodies`)).toBeNull();

    // The way in: their own org (cap 3 — test/orgs.routes.test.ts), where they are the owner and see only its content.
    expect((await json("POST", "/api/orgs", session, { slug: "stranger-co", name: "Stranger Co" })).status).toBe(201);
    expect((await json("GET", "/auth/me", session)).json).toMatchObject({ org: "Stranger Co", admin: true, orgs: [{ slug: "stranger-co", name: "Stranger Co", role: "owner" }] });
    expect((await json("GET", "/docs", session)).json).toEqual({ docs: [] });
    expect((await json("GET", "/persons", session)).json).toEqual({ persons: [expect.objectContaining({ handle: "stranger" })] });
    expect((await json("GET", "/api/o/saplinglearn/docs", session)).status).toBe(404);
  });

  it("reserved and taken handles still apply at onboarding", async () => {
    const res = await github("stranger");
    const c = cookieOf(res, "onboard")!;
    for (const handle of ["admin", "system", "trov", "canopy", "me", "github-webhook"]) {
      const r = await json("POST", "/auth/onboard", c, { handle, name: null, color: "sky" });
      expect([r.status, r.json.error], handle).toEqual([400, "handle_reserved"]);
    }
    expect((await json("POST", "/auth/onboard", c, { handle: "andresl230", name: null, color: "sky" })).json).toEqual({ error: "handle_taken" });
    expect(await first(env.DB, `SELECT 1 AS x FROM identities WHERE subject = 'stranger'`)).toBeNull();
  });

  it("with a legacy (SaplingLearn) invite for their verified email: a SaplingLearn member on first sign-in, the invite consumed", async () => {
    // Created the way Maintenance › People creates it today: the legacy route, as SaplingLearn's owner.
    const owner = await cookieFor("AndresL230");
    expect((await json("POST", "/invites", owner, { email: "New.Hire@example.com", name: "New Hire" })).status).toBe(200);
    expect(await first(env.DB, `SELECT org_id, status, role FROM org_invites WHERE email = 'new.hire@example.com'`)).toEqual({ org_id: ORG_A, status: "pending", role: "member" });

    const session = await onboard(await github("newhire", VERIFIED("new.hire@example.com")), "newhire");
    expect(await memberships("newhire")).toEqual([{ org_id: ORG_A, role: "member" }]);
    expect(await first(env.DB, `SELECT accepted_by FROM invites WHERE email = 'new.hire@example.com'`)).toEqual({ accepted_by: "newhire" });
    expect(await first(env.DB, `SELECT status, responded_by FROM org_invites WHERE email = 'new.hire@example.com'`)).toEqual({ status: "accepted", responded_by: "newhire" });
    expect((await json("GET", "/auth/me", session)).json).toMatchObject({ org: "SaplingLearn", admin: false, pending_invites: 0, orgs: [{ slug: "saplinglearn", name: "SaplingLearn", role: "member" }] });
    expect((await json("GET", "/docs", session)).status).toBe(200);
    // The welcome goes out, under SaplingLearn's settings.
    expect((await all<{ subject: string }>(env.DB, `SELECT subject FROM notification_outbox_bodies ORDER BY created_at`)).map((b) => b.subject)).toContain("Welcome to Trov");
    // The old screen shows it accepted.
    const list = (await json("GET", "/invites", owner)).json as unknown as { invites: { email: string; name: string | null; accepted_by: string | null }[] };
    expect(list.invites).toEqual([expect.objectContaining({ email: "new.hire@example.com", name: "New Hire", accepted_by: "newhire" })]);
  });

  it("a legacy invite is matched on the VERIFIED email only, and not once it is revoked", async () => {
    await legacyInvite("ghost@example.com");
    // GitHub says the address is not verified → `getPrimaryEmail` is null → nothing to match.
    await onboard(await github("ghost", [{ email: "ghost@example.com", primary: true, verified: false }]), "ghost");
    expect(await memberships("ghost")).toEqual([]);

    const owner = await cookieFor("AndresL230");
    await json("POST", "/invites", owner, { email: "revoked@example.com" });
    expect((await json("POST", "/invites/revoked%40example.com/revoke", owner)).status).toBe(200);
    await onboard(await github("revoked-dev", VERIFIED("revoked@example.com")), "revoked-dev");
    expect(await memberships("revoked-dev")).toEqual([]); // a GitHub account still onboards — into no org
  });

  it("with an org invite (by GitHub login): onboards into NO org; the invite shows as pending and grants nothing until accepted", async () => {
    const id = await orgInvite({ github_login: "Invited-Dev", role: "admin" });
    const session = await onboard(await github("invited-dev"), "invited-dev");
    expect(await memberships("invited-dev")).toEqual([]);
    expect((await json("GET", "/auth/me", session)).json).toMatchObject({ orgs: [], pending_invites: 1, admin: false });
    expect((await json("GET", "/api/o/acme/docs", session)).status).toBe(404);
    expect((await json("GET", "/docs", session)).status).toBe(409);

    expect((await json("POST", `/api/invites/${id}/accept`, session)).status).toBe(200);
    expect(await memberships("invited-dev")).toEqual([{ org_id: ORG_B, role: "admin" }]);
    expect((await json("GET", "/auth/me", session)).json).toMatchObject({ org: "Acme", admin: true, pending_invites: 0, orgs: [{ slug: "acme", name: "Acme", role: "admin" }] });
    expect((await json("GET", "/api/o/acme/docs", session)).status).toBe(200);
    expect((await json("GET", "/docs", session)).status).toBe(200);
  });
});

describe("a new Google account", () => {
  it("with no invite for its verified email: denied — no onboarding, nothing written", async () => {
    const res = await google();
    expect(res.headers.get("location")).toBe("/?denied=invite&email=priya.n%40gmail.com");
    expect(cookieOf(res, "onboard")).toBeNull();
    expect(await first(env.DB, `SELECT 1 AS x FROM identities WHERE subject = 'g-123'`)).toBeNull();
  });

  it("an invite for a DIFFERENT address, an invite by GitHub login, or one from a suspended org does not open the door", async () => {
    await orgInvite({ email: "someone.else@gmail.com" });
    await orgInvite({ github_login: "priya-n" });
    await run(env.DB, `INSERT INTO orgs (id, slug, name, created_at, created_by, suspended_at) VALUES ('org_c', 'cedar', 'Cedar', 't', 'test', 't')`);
    await orgInvite({ org: "org_c", email: "priya.n@gmail.com" });
    expect((await google()).headers.get("location")).toMatch(/^\/\?denied=invite/);
    // …and an unverified claim is refused even with a matching invite.
    await orgInvite({ email: "priya.n@gmail.com" });
    expect((await google({ email_verified: false })).headers.get("location")).toMatch(/^\/\?denied=invite/);
  });

  it("with an org invite for its verified email: onboards into NO org, then accepts", async () => {
    const id = await orgInvite({ email: "Priya.N@gmail.com" });
    const session = await onboard(await google(), "priya");
    expect(await memberships("priya")).toEqual([]);
    expect(await first(env.DB, `SELECT verified_email FROM identities WHERE provider = 'google' AND subject = 'g-123'`)).toEqual({ verified_email: "priya.n@gmail.com" });
    expect((await json("GET", "/auth/me", session)).json).toMatchObject({ orgs: [], pending_invites: 1 });
    expect((await json("GET", "/api/o/acme/me", session)).status).toBe(404);
    expect((await json("POST", `/api/invites/${id}/accept`, session)).status).toBe(200);
    expect(await memberships("priya")).toEqual([{ org_id: ORG_B, role: "member" }]);
  });

  it("with a legacy invite: a SaplingLearn member on first sign-in (unchanged)", async () => {
    await legacyInvite("priya.n@gmail.com", "Priya");
    await onboard(await google(), "priya");
    expect(await memberships("priya")).toEqual([{ org_id: ORG_A, role: "member" }]);
  });

  it("the invite is re-checked when onboarding is submitted: revoked in between → 403, no person", async () => {
    const id = await orgInvite({ email: "priya.n@gmail.com" });
    const callback = await google();
    expect(callback.headers.get("location")).toBe("/#onboard");
    await run(env.DB, `UPDATE org_invites SET status = 'revoked' WHERE id = ?`, id);
    const r = await json("POST", "/auth/onboard", cookieOf(callback, "onboard")!, { handle: "priya", name: null, color: "sky" });
    expect([r.status, r.json]).toEqual([403, { error: "invite_revoked" }]);
    expect(await first(env.DB, `SELECT 1 AS x FROM persons WHERE handle = 'priya'`)).toBeNull();
  });
});

describe("an editable address is never a way into someone else's account", () => {
  it("parking an address on persons.email does not capture its owner's first sign-in", async () => {
    // `squatter` (any signed-in person with an org) types the victim's address into their own profile…
    await ensureMember("squatter", "owner", ORG_B);
    const squatter = await cookieFor("squatter", { member: false });
    expect((await json("PUT", "/api/notifications/prefs", squatter, { email: "priya.n@gmail.com" })).status).toBe(200);
    // …the victim is later invited and signs in with Google: a NEW person, not the squatter's.
    await orgInvite({ email: "priya.n@gmail.com" });
    const session = await onboard(await google(), "priya");
    expect((await json("GET", "/auth/me", session)).json.handle).toBe("priya");
    expect(await first(env.DB, `SELECT person FROM identities WHERE subject = 'g-123'`)).toEqual({ person: "priya" });
  });

  it("an org admin cannot point a person's sign-in at an address they control", async () => {
    // `victim` signed in with GitHub (verified address on file) and is in SaplingLearn; `boss` owns another org.
    await seedPerson("victim", { email: "victim@example.com", verified: true });
    await ensureMember("boss", "owner", ORG_B);
    const boss = await cookieFor("boss", { member: false });
    // Not a member of boss's org: the same 404 as an unknown handle, at both mounts.
    for (const path of ["/api/notifications/persons/victim", "/api/o/acme/notifications/persons/victim"]) {
      expect(await json("PUT", path, boss, { email: "priya.n@gmail.com" }).then((r) => [r.status, r.json])).toEqual([404, { error: "no such person" }]);
    }
    // Even once victim JOINS boss's org, their address is theirs: they are in another org too.
    await ensureMember("victim", "member", ORG_B);
    expect(await json("PUT", "/api/o/acme/notifications/persons/victim", boss, { email: "priya.n@gmail.com" }).then((r) => [r.status, r.json])).toEqual([409, { error: "email_not_yours_to_set" }]);
    expect(await first(env.DB, `SELECT email FROM persons WHERE handle = 'victim'`)).toEqual({ email: "victim@example.com" });

    // And if `persons.email` DID say so (written directly here), a Google sign-in with that address still
    // links nothing: only an address a provider verified for the person does.
    await run(env.DB, `UPDATE persons SET email = 'priya.n@gmail.com' WHERE handle = 'victim'`);
    expect((await google()).headers.get("location")).toMatch(/^\/\?denied=invite/);
    expect(await first(env.DB, `SELECT 1 AS x FROM identities WHERE subject = 'g-123'`)).toBeNull();
  });

  it("the legitimate link still works: a second provider with the SAME verified address joins the existing person", async () => {
    await seedPerson("priya", { email: "priya.n@gmail.com", verified: true });
    const res = await google();
    expect([res.status, res.headers.get("location")]).toEqual([302, "/"]);
    expect(await first(env.DB, `SELECT person, verified_email FROM identities WHERE subject = 'g-123'`)).toEqual({ person: "priya", verified_email: "priya.n@gmail.com" });
  });
});

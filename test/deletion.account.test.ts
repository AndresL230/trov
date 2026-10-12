/**
 * Deleting an ACCOUNT (src/deletion/person.ts; docs/architecture/organizations.md › What deletion removes and
 * what it keeps): the person's own rows go; what they wrote in organizations that carry on stays, credited to
 * a tombstone handle, so that NO column anywhere still holds their handle, login or address; the guard rails
 * protect the people they leave behind; Stripe is settled first. Cookie only, never MCP. No network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import type { AccountDeletionPreview } from "@shared/deletion-core";
import { TOMBSTONE_NAME, isTombstoneHandle } from "@shared/deletion-core";
import { TicketCreate } from "@shared/tickets";
import { app } from "../src/routes";
import { append_feed, propose_doc_update } from "../src/tools/writes";
import { create_ticket, add_ticket_comment } from "../src/tools/tickets";
import { createHandoff } from "../src/tools/handoffs";
import { savePrompt } from "../src/tools/prompts";
import { createPage } from "../src/tools/artifacts";
import { avatarKey } from "../src/tools/people";
import { mintToken } from "../src/auth/tokens";
import { completeSignIn } from "../src/auth/onboard";
import { handleAvailable } from "../src/auth/persons";
import { deletionRef } from "../src/deletion/person";
import { buildTrovMcpServer } from "../src/mcp";
import { call, exec, one, rows } from "./helpers/orgs";
import { cookieFor, seedPerson } from "./helpers/persons";
import { ORG_A, ORG_B, ensureMember, platformCtx, systemCtx, tenantCtx } from "./helpers/tenant";
import { fillOrg, newOrg, orgDigest } from "./helpers/deletion";
import { FakeStripe, bcall, deliver, event } from "./helpers/billing";

const ZED = "zed-alice";
const LOGIN = "zedgh";
const EMAILS = ["zed@example.com", "zed@gmail.example", "zed@notify.example"];
const GOOGLE_SUB = "g-zed-sub";
const T = "2026-10-01T00:00:00.000Z";
const e = env as unknown as Env;

/** zed: a GitHub and a Google sign-in, a notification address, a photo; a member of SaplingLearn and Acme. */
async function seedZed(): Promise<string> {
  await exec(`INSERT INTO persons (handle, name, color, email, created_at, onboarded_at, avatar_sha, avatar_url, avatar_source, role, responsibilities)
              VALUES (?, 'Zed Alice', 'plum', ?, ?, ?, ?, 'https://avatars.example/zed.png', 'github', 'Engineer', 'Everything')`, ZED, EMAILS[2], T, T, "1".repeat(64));
  await exec(`INSERT INTO identities (provider, subject, label, person, linked_at, linked_by, verified_email, provider_uid) VALUES ('github', ?, ?, ?, ?, ?, ?, '777')`, LOGIN, LOGIN, ZED, T, ZED, EMAILS[0]);
  await exec(`INSERT INTO identities (provider, subject, label, person, linked_at, linked_by, verified_email) VALUES ('google', ?, ?, ?, ?, ?, ?)`, GOOGLE_SUB, EMAILS[1], ZED, T, ZED, EMAILS[1]);
  await env.ARTIFACTS_BUCKET.put(avatarKey("1".repeat(64)), "photo");
  await ensureMember(ZED, "member", ORG_A);
  await ensureMember(ZED, "admin", ORG_B);
  return cookieFor(ZED, { member: false });
}

/** What zed wrote and did, in both orgs, through the real writers and routes. */
async function zedsWork(): Promise<number> {
  const a = systemCtx(ORG_A);
  const ticket = await create_ticket(a, TicketCreate.parse({ title: "Fix the login page", body: "steps", assignees: [ZED] }), ZED);
  await add_ticket_comment(a, ticket, "Looking into it", ZED);
  await append_feed(a, { author: ZED, summary: "Shipped the fix", body: "details", tags: ["infra"] });
  await propose_doc_update(a, { slug: "zed-runbook", section: "reference", title: "Runbook", body: "how to", change_summary: "first", confidence: "high" }, ZED);
  await createHandoff(a, ZED, { body: "Over to you", context: { task: "t" } });
  await createHandoff(a, "AndresL230", { body: "For zed", recipient: ZED, context: { task: "t" } }); // "AndresL230 left a handoff for zed-alice: …"
  await savePrompt(a, ZED, { slug: "zed-prompt", title: "Prompt", body: "b", tags: ["review"], status: "published" }, "human");
  await createPage(a, { title: "Design", kind: "markdown", area: "auth", content: "# d" }, ZED);
  await append_feed(systemCtx(ORG_B), { author: ZED, summary: "Acme note", body: "b", tags: ["infra"] });
  // Credentials and preferences.
  await mintToken(await tenantCtx(ZED, undefined, { orgId: ORG_A }));
  await exec(`INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES ('cl', 'Claude Code', '[]', ?)`, T);
  const g = (await exec(`INSERT INTO oauth_grants (person, client_id, client_name, created_at, org_id, mode) VALUES (?, 'cl', 'Claude Code', ?, ?, 'manual')`, ZED, T, ORG_A)).meta.last_row_id;
  await exec(`INSERT INTO oauth_grant_orgs (grant_id, org_id, person, added_at) VALUES (?, ?, ?, ?)`, g, ORG_A, ZED, T);
  await exec(`INSERT INTO oauth_tokens (token_hash, grant_id, kind, created_at, expires_at) VALUES ('zt', ?, 'access', ?, '2099-01-01')`, g, T);
  await exec(`INSERT INTO oauth_codes (code_hash, client_id, person, grant_id, redirect_uri, code_challenge, resource, created_at, expires_at, org_id) VALUES ('zc', 'cl', ?, ?, 'http://localhost', 'x', 'r', ?, '2099-01-01', ?)`, ZED, g, T, ORG_A);
  await exec(`INSERT INTO notification_prefs (org_id, user_id, kind, cadence, updated_at) VALUES (?, ?, 'my_work', 'weekly', ?)`, ORG_A, ZED, T);
  await exec(`INSERT INTO notification_outbox (idempotency_key, user_id, cadence, window_id, kinds, status, created_at, org_id) VALUES (?, ?, 'daily', 'w', '[]', 'sent', ?, ?)`, `${ORG_A}:${ZED}:daily:w`, ZED, T, ORG_A);
  await exec(`INSERT INTO notification_outbox_bodies (idempotency_key, to_address, subject, html, text, created_at, org_id) VALUES (?, ?, 's', 'h', 't', ?, ?)`, `${ORG_A}:${ZED}:daily:w`, EMAILS[2], T, ORG_A);
  await exec(`INSERT INTO platform_outbox_bodies (idempotency_key, to_address, subject, html, text, created_at) VALUES ('pk', ?, 's', 'h', 't', ?)`, EMAILS[0], T);
  await exec(`INSERT INTO org_login_map (org_id, github_login, person, mapped_at, mapped_by) VALUES (?, 'zed-old-login', ?, ?, 'AndresL230')`, ORG_A, ZED, T);
  await exec(`INSERT INTO org_usage_daily (org_id, day, metric, actor, count, last_at) VALUES (?, '2026-10-01', 'api_read', ?, 4, ?)`, ORG_A, ZED, T);
  await exec(`INSERT INTO abuse_counters (subject, action, bucket, count, last_at) VALUES (?, 'invite', '2026-10-01', 1, ?), (?, 'handle_check', '2026-10-01', 1, ?)`, ZED, T, `onboard:github:${LOGIN}`, T);
  await exec(`INSERT INTO support_reports (kind, subject, message, reporter, from_org, from_org_slug, route, app_version, user_agent, status, created_at) VALUES ('question', 's', 'm', ?, ?, 'saplinglearn', '#', '0.29', 'ua', 'open', ?)`, ZED, ORG_A, T);
  await exec(`INSERT INTO support_reports (kind, subject, message, contact_email, route, app_version, user_agent, status, created_at) VALUES ('question', 's', 'signed out', ?, '/', '0.29', 'ua', 'open', ?)`, EMAILS[1], T);
  // The audit trail names them: an invitation by GitHub login, accepted, and an admin's edit.
  const owner = await cookieFor("AndresL230");
  await exec(`DELETE FROM memberships WHERE org_id = ? AND user_id = ?`, ORG_A, ZED);
  expect((await call("POST", "/api/o/saplinglearn/invites", owner, { github_login: LOGIN })).status).toBe(201);
  const inv = (await one<{ id: number }>(`SELECT id FROM org_invites WHERE github_login = ?`, LOGIN))!.id;
  expect((await call("POST", `/api/invites/${inv}/accept`, await cookieFor(ZED, { member: false }))).status).toBe(200);
  expect((await call("PUT", `/api/o/saplinglearn/members/${ZED}`, owner, { title: "Engineer" })).status).toBe(200);
  await exec(`INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at) VALUES (?, 'AndresL230', 'invite.create', 'invite:99', ?, ?)`, ORG_A, JSON.stringify({ email: EMAILS[0], role: "member" }), T);
  return ticket;
}

const NEEDLES = [ZED, LOGIN, "zed-old-login", GOOGLE_SUB, ...EMAILS];

/** Every (table.column) in the database whose value still contains one of `needles`. */
async function leftovers(needles: string[]): Promise<string[]> {
  const tables = await rows<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'd1_%'`);
  const hits = new Set<string>();
  const res = await env.DB.batch(tables.map((t) => env.DB.prepare(`SELECT * FROM "${t.name}"`)));
  res.forEach((r, i) => {
    for (const row of r.results as Record<string, unknown>[]) {
      for (const [col, v] of Object.entries(row)) {
        const text = typeof v === "string" ? v.toLowerCase() : "";
        for (const n of needles) if (text.includes(n.toLowerCase())) hits.add(`${tables[i].name}.${col} ∋ ${n}`);
      }
    }
  });
  return [...hits].sort();
}

const del = (cookie: string, confirm: unknown = ZED, o: { headers?: Record<string, string> } = {}) =>
  app.request("/auth/me/delete", { method: "POST", headers: { cookie, "content-type": "application/json", ...o.headers }, body: JSON.stringify({ confirm }) }, env);

describe("deleting your own account", () => {
  it("removes every personal row, de-identifies what they wrote, and leaves NO column holding their handle, login or address", async () => {
    const cookie = await seedZed();
    const ticket = await zedsWork();
    const other = await cookieFor(ZED, { member: false }); // a second browser
    expect((await leftovers(NEEDLES)).length).toBeGreaterThan(20);

    const preview = await call<AccountDeletionPreview>("GET", "/auth/me/deletion", cookie);
    expect(preview.status).toBe(200);
    expect(preview.json).toMatchObject({ handle: ZED, deletes: [], blockers: [], unused_paid: 0, confirm: ZED });
    expect(preview.json.leaves.map((o) => o.slug).sort()).toEqual(["acme", "saplinglearn"]);

    const res = await del(cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("set-cookie")).toMatch(/^session=;.*Max-Age=0/);

    // Nothing anywhere names them.
    expect(await leftovers(NEEDLES)).toEqual([]);
    // Their sessions are gone everywhere: the other browser is signed out too.
    expect((await call("GET", "/auth/me", other)).status).toBe(401);
    // The content stays, credited to the tombstone.
    const tomb = (await one<{ requester: string }>(`SELECT requester FROM tickets WHERE org_id = ? AND number = ?`, ORG_A, ticket))!.requester;
    expect(isTombstoneHandle(tomb)).toBe(true);
    expect(await one(`SELECT handle, name, email, avatar_url, avatar_sha, role, responsibilities, email_unsubscribed FROM persons WHERE handle = ?`, tomb))
      .toEqual({ handle: tomb, name: TOMBSTONE_NAME, email: null, avatar_url: null, avatar_sha: null, role: null, responsibilities: null, email_unsubscribed: 1 });
    expect(await one(`SELECT author FROM ticket_comments WHERE org_id = ?`, ORG_A)).toEqual({ author: tomb });
    expect(new Set((await rows<{ author: string }>(`SELECT author FROM feed WHERE org_id IN (?, ?)`, ORG_A, ORG_B)).map((r) => r.author))).toEqual(new Set([tomb, "AndresL230"]));
    // The handoff sentence Trov wrote names the tombstone too — and so does its search row.
    expect((await rows<{ summary: string }>(`SELECT summary FROM feed WHERE summary LIKE '%left a handoff%' ORDER BY id`)).map((r) => r.summary.split(":")[0]))
      .toEqual([`${tomb} left a handoff for anyone`, `AndresL230 left a handoff for ${tomb}`]);
    expect(await one<{ n: number }>(`SELECT COUNT(*) AS n FROM feed_fts WHERE feed_fts MATCH ?`, `"${tomb}"`)).toEqual({ n: 2 });
    expect(await one(`SELECT login FROM ticket_assignees WHERE org_id = ?`, ORG_A)).toEqual({ login: tomb });
    // …and the tombstone is no one's: not a member, not listed, no sign-in, no session, no connection.
    for (const t of ["memberships", "identities", "sessions", "mcp_tokens", "oauth_grants", "oauth_codes", "oauth_grant_orgs", "notification_prefs", "notification_outbox", "org_login_map", "platform_admins"]) {
      const col = t === "memberships" || t.startsWith("notification") ? "user_id" : "person";
      expect(await one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t} WHERE ${col} = ?`, tomb), t).toEqual({ n: 0 });
    }
    expect(await one(`SELECT COUNT(*) AS n FROM oauth_tokens WHERE token_hash = 'zt'`)).toEqual({ n: 0 });
    // Each org they left says so, and one platform row records the deletion — by the tombstone, never the old handle.
    expect(await rows(`SELECT org_id, actor, target FROM org_admin_audit WHERE action = 'member.leave' ORDER BY org_id`))
      .toEqual([{ org_id: ORG_B, actor: tomb, target: tomb }, { org_id: ORG_A, actor: tomb, target: tomb }].sort((x, y) => x.org_id.localeCompare(y.org_id)));
    // Its `ref` is a keyed hash of the old handle — no handle in it, but a restored database can be matched against it.
    expect(await rows(`SELECT org_id, actor, target, detail FROM org_admin_audit WHERE action = 'person.delete'`))
      .toEqual([{ org_id: null, actor: tomb, target: tomb, detail: JSON.stringify({ by: "self", ref: await deletionRef("test-cookie-secret", ZED) }) }]);
    expect(await deletionRef("test-cookie-secret", ZED)).not.toBe(await deletionRef("test-cookie-secret", "someone-else"));
    // Their photo's bytes go (nobody else's photo is the same).
    expect(await env.ARTIFACTS_BUCKET.head(avatarKey("1".repeat(64)))).toBeNull();
  });

  it("signing in again with the same GitHub or Google account starts a new, empty account; the old handle is free and a tombstone handle is not", async () => {
    const cookie = await seedZed();
    expect((await del(cookie)).status).toBe(200);
    const p = platformCtx();
    expect((await completeSignIn(p, { provider: "github", subject: LOGIN, label: LOGIN, email: EMAILS[0], name: "Zed", avatar_url: null, uid: "777" })).kind).toBe("onboard");
    expect((await completeSignIn(p, { provider: "google", subject: GOOGLE_SUB, label: EMAILS[1], email: EMAILS[1], name: "Zed", avatar_url: null })).kind).toBe("onboard");
    expect(await handleAvailable(p, ZED)).toEqual({ available: true });
    const tomb = (await one<{ handle: string }>(`SELECT handle FROM persons WHERE name = ?`, TOMBSTONE_NAME))!.handle;
    expect(await handleAvailable(p, tomb)).toEqual({ available: false, reason: "reserved" });
    expect(await handleAvailable(p, "deleted-anything")).toEqual({ available: false, reason: "reserved" });
  });

  it("a photo someone else also uses stays in R2", async () => {
    const cookie = await seedZed();
    await seedPerson("twin", { member: false });
    await exec(`UPDATE persons SET avatar_sha = ? WHERE handle = 'twin'`, "1".repeat(64));
    expect((await del(cookie)).status).toBe(200);
    expect(await env.ARTIFACTS_BUCKET.head(avatarKey("1".repeat(64)))).not.toBeNull();
  });

  it("the typed confirmation must be their handle; a token-shaped caller is refused; a bearer alone is not signed in", async () => {
    const cookie = await seedZed();
    for (const confirm of ["", "zed", "Zed Alice", null]) expect((await del(cookie, confirm)).status).toBe(400);
    expect((await del(cookie, ZED, { headers: { authorization: "Bearer trov_mcp_abc" } })).status).toBe(403);
    const token = (await mintToken(await tenantCtx(ZED, undefined, { orgId: ORG_A }))).raw;
    const bearerOnly = await app.request("/auth/me/delete", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ confirm: ZED }) }, env);
    expect(bearerOnly.status).toBe(401);
    expect(await one(`SELECT handle FROM persons WHERE handle = ?`, ZED)).toEqual({ handle: ZED });
  });

  it("MCP has no way to delete anything but a sprint, and nothing it reaches imports the deletion core (test/secrets.mcp.test.ts)", async () => {
    const server = buildTrovMcpServer(e, await tenantCtx("AndresL230")) as unknown as { _registeredTools: Record<string, unknown> };
    const names = Object.keys(server._registeredTools);
    expect(names.filter((n) => /delet|account|erase|purge/.test(n))).toEqual(["delete_sprint"]);
  });
});

describe("the guard rails", () => {
  it("the only owner of an org other people are in is blocked, with the org named, until someone else is an owner", async () => {
    const cookie = await seedZed();
    const id = await newOrg(ZED, "zedteam");
    await seedPerson("pal", { member: false });
    await exec(`INSERT INTO memberships (org_id, user_id, role, created_at, created_by) VALUES (?, 'pal', 'member', ?, 'seed')`, id, T);
    const preview = (await call<AccountDeletionPreview>("GET", "/auth/me/deletion", cookie)).json;
    expect(preview.blockers).toEqual([{ code: "last_owner", org: { slug: "zedteam", name: "zedteam org" }, message: expect.stringMatching(/only owner of zedteam org.*1 other person is in it.*owner/) }]);
    const refused = await del(cookie);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "blocked", blockers: [{ code: "last_owner" }] });
    expect(await one(`SELECT handle FROM persons WHERE handle = ?`, ZED)).toEqual({ handle: ZED });
    await exec(`UPDATE memberships SET role = 'owner' WHERE org_id = ? AND user_id = 'pal'`, id);
    expect((await del(cookie)).status).toBe(200);
    expect(await one(`SELECT user_id, role FROM memberships WHERE org_id = ?`, id)).toEqual({ user_id: "pal", role: "owner" });
  });

  it("an organization nobody else is in is deleted WITH the account — named in the preview — and the other orgs are untouched", async () => {
    const cookie = await seedZed();
    const solo = await newOrg(ZED, "zedsolo");
    await fillOrg(solo, ZED, "SOLO");
    const keepB = await orgDigest(ORG_B);
    const preview = (await call<AccountDeletionPreview>("GET", "/auth/me/deletion", cookie)).json;
    expect(preview.deletes).toEqual([{ slug: "zedsolo", name: "zedsolo org", paid: false }]);
    expect((await del(cookie)).status).toBe(200);
    expect(await one(`SELECT 1 AS x FROM orgs WHERE id = ?`, solo)).toBeNull();
    const audit = await one<{ actor: string; detail: string }>(`SELECT actor, detail FROM org_admin_audit WHERE action = 'org.delete'`);
    expect(isTombstoneHandle(audit!.actor)).toBe(true);
    expect(JSON.parse(audit!.detail)).toMatchObject({ by: "self", with_account: true });
    expect(JSON.parse((await one<{ detail: string }>(`SELECT detail FROM org_admin_audit WHERE action = 'person.delete'`))!.detail)).toEqual({ by: "self", ref: await deletionRef("test-cookie-secret", ZED), orgs_deleted: ["zedsolo"] });
    // Acme lost exactly zed's membership and Acme note's author, nothing else.
    const after = await orgDigest(ORG_B);
    expect(Object.keys(after).filter((k) => after[k] !== keepB[k]).sort()).toEqual(["memberships", "org_admin_audit", "persons"]);
  });

  it("the platform's only superadmin is blocked", async () => {
    const cookie = await cookieFor("AndresL230");
    const preview = (await call<AccountDeletionPreview>("GET", "/auth/me/deletion", cookie)).json;
    expect(preview.blockers.map((b) => b.code).sort()).toEqual(["last_owner", "last_superadmin"]);
    expect((await del(cookie, "AndresL230")).status).toBe(409);
  });
});

// ── billing ──────────────────────────────────────────────────────────────────

let stripe: FakeStripe;
beforeEach(() => { stripe = new FakeStripe(); vi.stubGlobal("fetch", stripe.fetch); });
afterEach(() => { vi.unstubAllGlobals(); });

/** zed pays for Pro at Stripe; with `slug`, they also set up the organization. */
async function zedPays(slug: string | null) {
  const cookie = await seedZed();
  expect((await bcall("GET", `/billing/start?plan=team`, cookie)).status).toBe(303);
  const session = stripe.lastSession();
  const sub = stripe.pay(session.id, 2);
  await deliver(event("checkout.session.completed", stripe.sessionJson(session)));
  if (slug) expect((await bcall("POST", "/api/orgs", cookie, { slug, name: slug })).status).toBe(201);
  return { cookie, sub };
}
const bdel = (cookie: string) => bcall<{ error?: string; blockers?: { code: string }[] }>("POST", "/auth/me/delete", cookie, { confirm: ZED });

describe("an account that pays", () => {
  it("the buyer of a subscription that still renews for an org that carries on is blocked; once it is cancelled (to the period's end) they may go, and it is NOT cut short", async () => {
    const { cookie, sub } = await zedPays("zedpaid");
    const id = (await one<{ id: string }>(`SELECT id FROM orgs WHERE slug = 'zedpaid'`))!.id;
    await seedPerson("pal", { member: false });
    await exec(`INSERT INTO memberships (org_id, user_id, role, created_at, created_by) VALUES (?, 'pal', 'owner', ?, 'seed')`, id, T);
    const refused = await bdel(cookie);
    expect(refused.status).toBe(409);
    expect(refused.json.blockers!.map((b) => b.code)).toEqual(["billing_buyer"]);
    // The owner cancels in the portal: Stripe says cancel_at_period_end.
    sub.cancel_at_period_end = true;
    await deliver(event("customer.subscription.updated", stripe.subscriptionJson(sub)));
    expect((await bdel(cookie)).status).toBe(200);
    expect(stripe.callsTo("DELETE", /\/v1\/subscriptions\//)).toEqual([]);
    expect(stripe.subscriptions.get(sub.id)!.status).toBe("active"); // runs to the end of the period already paid
    const buyer = (await one<{ person: string }>(`SELECT person FROM billing_subscriptions WHERE subscription_id = ?`, sub.id))!.person;
    expect(isTombstoneHandle(buyer)).toBe(true);
  });

  it("a paid organization nobody else is in is deleted with the account, its subscription cancelled now", async () => {
    const { cookie, sub } = await zedPays("zedalone");
    const preview = (await bcall<AccountDeletionPreview>("GET", "/auth/me/deletion", cookie)).json;
    expect(preview.deletes).toEqual([{ slug: "zedalone", name: "zedalone", paid: true }]);
    expect(preview.blockers).toEqual([]);
    expect((await bdel(cookie)).status).toBe(200);
    expect(stripe.subscriptions.get(sub.id)!.status).toBe("canceled");
    expect(await one(`SELECT COUNT(*) AS n FROM orgs WHERE slug = 'zedalone'`)).toEqual({ n: 0 });
  });

  it("a plan paid for but never set up: its subscription is cancelled and the grant revoked, naming no one", async () => {
    const { cookie, sub } = await zedPays(null);
    expect((await bcall<AccountDeletionPreview>("GET", "/auth/me/deletion", cookie)).json.unused_paid).toBe(1);
    expect((await bdel(cookie)).status).toBe(200);
    expect(stripe.subscriptions.get(sub.id)!.status).toBe("canceled");
    const g = await one<{ status: string; person: string; github_login: string | null; email: string | null }>(`SELECT status, person, github_login, email FROM org_grants WHERE external_ref = ?`, sub.id);
    expect(g).toMatchObject({ status: "revoked", github_login: null, email: null });
    expect(isTombstoneHandle(g!.person)).toBe(true);
  });

  it("Stripe failing deletes nothing at all — not the account, not the org that would have gone with it", async () => {
    const { cookie, sub } = await zedPays("zedalone");
    stripe.fail = (c) => (c.method === "DELETE" ? new Response("down", { status: 503 }) : null);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await bdel(cookie);
    spy.mockRestore();
    expect(res.status).toBe(502);
    expect(res.json.error).toBe("billing_failed");
    expect(stripe.subscriptions.get(sub.id)!.status).toBe("active");
    expect(await one(`SELECT handle FROM persons WHERE handle = ?`, ZED)).toEqual({ handle: ZED });
    expect(await one(`SELECT COUNT(*) AS n FROM orgs WHERE slug = 'zedalone'`)).toEqual({ n: 1 });
    expect((await call("GET", "/auth/me", cookie)).status).toBe(200);
  });

  it("an open checkout they started is expired, so it cannot be paid after they are gone", async () => {
    const cookie = await seedZed();
    expect((await bcall("GET", `/billing/start?plan=team`, cookie)).status).toBe(303);
    const session = stripe.lastSession();
    expect((await bdel(cookie)).status).toBe(200);
    expect(stripe.sessions.get(session.id)!.status).toBe("expired");
  });
});

/**
 * The invitation and welcome mails of the org surface (0042_organizations, src/orgs/mail.ts):
 *   • `POST /api/o/:slug/invites` mails an e-mail invite, takes a `name`, and reports the outcome on the row;
 *   • `POST /api/o/:slug/invites/:id/resend`;
 *   • the superadmin's owner invite (`POST /api/platform/orgs`, `…/admin`) sends the "made the owner" wording;
 *   • a GitHub-login invite sends nothing;
 *   • the welcome goes out once — on a person's FIRST membership of any org — under that org.
 * Mail is asserted both ways: the local bodies table (default mode) and the outgoing Resend request (stubbed fetch).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { cookieFor, FIXTURE_ADMIN } from "./helpers/persons";
import { ensureMember, ORG_A, ORG_B } from "./helpers/tenant";
import { call, one, rows, exec, SUPERADMIN } from "./helpers/orgs";
import { app } from "../src/routes";
import { renderInviteEmail } from "../src/notifications/invite";
import { LIMITS } from "../src/platform/limits";
import type { OrgInvite } from "@shared/orgs";

interface Body { org_id: string; to_address: string; subject: string; html: string; text: string }
const bodies = () => rows<Body>(`SELECT org_id, to_address, subject, html, text FROM notification_outbox_bodies ORDER BY created_at, rowid`);
const admin = () => cookieFor(FIXTURE_ADMIN, { name: "Ada Admin" });
const acmeBoss = async () => { const cookie = await cookieFor("boss", { member: false, name: "Bo Boss" }); await ensureMember("boss", "admin", ORG_B); return cookie; };
/** Every href and bare URL in a message. */
const links = (m: { html: string; text: string }): string[] =>
  [...m.html.matchAll(/href="([^"]+)"/g)].map((x) => x[1]).filter((h) => !h.includes("fonts.googleapis.com")).concat(m.text.match(/https?:\/\/\S+/g) ?? []);

afterEach(() => { vi.unstubAllGlobals(); });

describe("renderInviteEmail — the generalised copy", () => {
  const base = { inviteeName: "Priya", inviterName: "Andres", orgName: "Acme Robotics", email: "priya@x.io", signInUrl: "https://trov.test/", host: "trov.test" };

  it("names the org, the inviter and the role; never 'Sapling'; the only link is the site root", () => {
    for (const role of ["member", "admin"] as const) {
      const m = renderInviteEmail({ ...base, role });
      expect(m.subject).toBe("Andres invited you to Acme Robotics on Trov");
      expect(m.html).toContain(`Andres invited you to join Acme Robotics as ${role === "admin" ? "an admin" : "a member"}.`);
      expect(m.text).toContain(`as ${role === "admin" ? "an admin" : "a member"}`);
      expect(m.html + m.text).not.toMatch(/sapling/i);
      expect(new Set(links(m))).toEqual(new Set(["https://trov.test/"]));
      expect(m.html).toContain('data-mark="trov"'); // the same banner as before
    }
  });

  it("an owner invite is worded 'you have been made the owner of <org> on Trov'", () => {
    const m = renderInviteEmail({ ...base, role: "owner" });
    expect(m.subject).toBe("You have been made the owner of Acme Robotics on Trov");
    expect(m.html).toContain("Andres added Acme Robotics to Trov and named you its owner.");
    expect(new Set(links(m))).toEqual(new Set(["https://trov.test/"]));
  });

  it("escapes an org name and an invitee name that carry markup", () => {
    const m = renderInviteEmail({ ...base, role: "member", orgName: `<b>Evil</b> & "Co"`, inviteeName: "<img src=x>" });
    expect(m.html).not.toContain("<b>Evil</b>");
    expect(m.html).not.toContain("<img src=x>");
    expect(m.html).toContain("&lt;b&gt;Evil&lt;/b&gt; &amp;");
  });
});

describe("POST /api/o/:slug/invites — an e-mail invite is mailed", () => {
  it("sends the invitation under the inviting org, stores the name and the outcome, and returns both on the row", async () => {
    const r = await call<{ ok: true; invite: OrgInvite }>("POST", "/api/o/acme/invites", await acmeBoss(), { email: "New.Hire@X.io", name: "  Nia Hire ", role: "admin" });
    expect(r.status).toBe(201);
    expect(r.json.invite).toMatchObject({ email: "new.hire@x.io", name: "Nia Hire", role: "admin", status: "pending", mail_status: "sent", mail_error: null });
    expect(r.json.invite.mail_at).toMatch(/^\d{4}-\d\d-\d\dT/);
    const sent = await bodies();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ org_id: ORG_B, to_address: "new.hire@x.io", subject: "Bo Boss invited you to Acme on Trov" });
    expect(sent[0].html).toContain("Hi Nia Hire,");
    expect(sent[0].html).toContain("as an admin");
    expect(sent[0].html + sent[0].text).not.toMatch(/sapling/i);
    // The list carries the same fields.
    const list = await call<{ invites: OrgInvite[] }>("GET", "/api/o/acme/invites", await acmeBoss());
    expect(list.json.invites).toEqual([expect.objectContaining({ id: r.json.invite.id, name: "Nia Hire", mail_status: "sent" })]);
  });

  it("the outgoing provider request: recipient, the platform From with the org's sender name, subject, no token in any link", async () => {
    const out: { url: string; auth: string | null; body: { from: string; to: string[]; subject: string; html: string; text: string } }[] = [];
    vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
      out.push({ url: String(input), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ id: "em_42" }), { status: 200 });
    }) as typeof fetch);
    await exec(`INSERT INTO notification_settings (org_id, send_hour, timezone, from_address) VALUES (?, 8, 'UTC', 'Acme Robotics <hello@trov.dev>')
                ON CONFLICT(org_id) DO UPDATE SET from_address = excluded.from_address`, ORG_B);
    const resendEnv = { ...env, NOTIFICATIONS_MODE: "resend", RESEND_API_KEY: "re_test", PUBLIC_ORIGIN: "https://trov.test" };
    const res = await app.request("/api/o/acme/invites", {
      method: "POST", headers: { cookie: await acmeBoss(), "content-type": "application/json" }, body: JSON.stringify({ email: "hire@x.io", name: "Nia" }),
    }, resendEnv);
    expect(res.status).toBe(201);
    const invite = ((await res.json()) as { invite: OrgInvite }).invite;
    expect(invite.mail_status).toBe("sent");
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe("https://api.resend.com/emails");
    expect(out[0].auth).toBe("Bearer re_test");
    expect(out[0].body.to).toEqual(["hire@x.io"]);
    expect(out[0].body.from).toBe("Acme Robotics <hello@trov.dev>");
    expect(out[0].body.subject).toBe("Bo Boss invited you to Acme on Trov");
    expect(out[0].body.html + out[0].body.text).not.toMatch(/sapling/i);
    const all = links(out[0].body);
    expect(new Set(all)).toEqual(new Set(["https://trov.test/"])); // the site root: no path, no query, no id, no token
    expect(out[0].body.html + out[0].body.text).not.toContain(`invite:${invite.id}`);
    expect(out[0].body.html).not.toMatch(/[?&](token|invite|id|code)=/);
  });

  it("a provider refusal is the `failed` outcome on the row — the invite still exists", async () => {
    vi.stubGlobal("fetch", (async () => new Response(JSON.stringify({ message: "domain not verified" }), { status: 403 })) as typeof fetch);
    const res = await app.request("/api/o/acme/invites", {
      method: "POST", headers: { cookie: await acmeBoss(), "content-type": "application/json" }, body: JSON.stringify({ email: "hire@x.io" }),
    }, { ...env, NOTIFICATIONS_MODE: "resend", RESEND_API_KEY: "re_test" });
    expect(res.status).toBe(201);
    const invite = ((await res.json()) as { invite: OrgInvite }).invite;
    expect(invite).toMatchObject({ status: "pending", mail_status: "failed", mail_error: "resend 403: domain not verified" });
  });

  it("a GitHub-login invite sends nothing and reports no mail", async () => {
    const r = await call<{ invite: OrgInvite }>("POST", "/api/o/acme/invites", await acmeBoss(), { github_login: "octo-hire" });
    expect(r.status).toBe(201);
    expect(r.json.invite).toMatchObject({ github_login: "octo-hire", email: null, mail_status: null, mail_at: null });
    expect(await bodies()).toEqual([]);
  });

  it("a name that is not text or is too long is refused and nothing is written or sent", async () => {
    const boss = await acmeBoss();
    expect((await call("POST", "/api/o/acme/invites", boss, { email: "a@x.io", name: "x".repeat(121) })).status).toBe(400);
    expect((await call("POST", "/api/o/acme/invites", boss, { email: "a@x.io", name: 7 })).status).toBe(400);
    expect(await one(`SELECT COUNT(*) AS n FROM org_invites WHERE org_id = ?`, ORG_B)).toEqual({ n: 0 });
    expect(await bodies()).toEqual([]);
  });
});

describe("POST /api/o/:slug/invites/:id/resend", () => {
  it("mails the pending invite again and moves the outcome's time; a member is refused", async () => {
    const boss = await acmeBoss();
    const { invite } = (await call<{ invite: OrgInvite }>("POST", "/api/o/acme/invites", boss, { email: "hire@x.io", name: "Nia" })).json;
    await new Promise((r) => setTimeout(r, 5));
    const again = await call<{ ok: true; invite: OrgInvite }>("POST", `/api/o/acme/invites/${invite.id}/resend`, boss);
    expect(again.status).toBe(200);
    expect(again.json.invite.mail_status).toBe("sent");
    expect(again.json.invite.mail_at! > invite.mail_at!).toBe(true);
    const sent = await bodies();
    expect(sent).toHaveLength(2);
    expect(sent[1].html).toContain("Hi Nia,"); // the stored name greets the resend too
    await ensureMember("plain", "member", ORG_B);
    expect((await call("POST", `/api/o/acme/invites/${invite.id}/resend`, await cookieFor("plain", { member: false }))).status).toBe(403);
    expect(await bodies()).toHaveLength(2);
  });

  it("404 for another org's invite, an answered or revoked one and an unknown id; 409 `no_address` for a GitHub-login invite — nothing sent", async () => {
    const boss = await acmeBoss();
    const theirs = (await call<{ invite: OrgInvite }>("POST", "/api/o/saplinglearn/invites", await admin(), { email: "a-only@x.io" })).json.invite;
    const login = (await call<{ invite: OrgInvite }>("POST", "/api/o/acme/invites", boss, { github_login: "octo-hire" })).json.invite;
    const gone = (await call<{ invite: OrgInvite }>("POST", "/api/o/acme/invites", boss, { email: "gone@x.io" })).json.invite;
    await call("POST", `/api/o/acme/invites/${gone.id}/revoke`, boss);
    const before = (await bodies()).length;
    const stamp = await one(`SELECT mail_at FROM org_invites WHERE id = ?`, theirs.id);
    expect((await call("POST", `/api/o/acme/invites/${theirs.id}/resend`, boss)).status).toBe(404); // org A's row, addressed through org B
    expect((await call("POST", `/api/o/acme/invites/${gone.id}/resend`, boss)).status).toBe(404);
    expect((await call("POST", `/api/o/acme/invites/999999/resend`, boss)).status).toBe(404);
    const noAddr = await call<{ error: string }>("POST", `/api/o/acme/invites/${login.id}/resend`, boss);
    expect([noAddr.status, noAddr.json.error]).toEqual([409, "no_address"]);
    expect((await bodies()).length).toBe(before);
    expect(await one(`SELECT mail_at FROM org_invites WHERE id = ?`, theirs.id)).toEqual(stamp); // A's row was not stamped
  });

  it("takes a unit of the per-person daily invite limit, and answers 429 with nothing sent once it is spent", async () => {
    const boss = await acmeBoss();
    const { invite } = (await call<{ invite: OrgInvite }>("POST", "/api/o/acme/invites", boss, { email: "hire@x.io" })).json;
    await exec(`UPDATE abuse_counters SET count = ? WHERE subject = 'boss' AND action = 'invite'`, LIMITS.invite.max);
    const before = (await bodies()).length;
    const r = await call<{ error: string; retry_after: number }>("POST", `/api/o/acme/invites/${invite.id}/resend`, boss);
    expect([r.status, r.json.error]).toEqual([429, "rate_limited"]);
    expect(r.json.retry_after).toBeGreaterThan(0);
    expect((await bodies()).length).toBe(before);
  });
});

describe("the superadmin's owner invite", () => {
  it("POST /api/platform/orgs with { email } mails 'you have been made the owner of <org> on Trov' under the new org", async () => {
    const r = await call<{ ok: true; admin: { status: string; invite_id: number } }>("POST", "/api/platform/orgs", await cookieFor(SUPERADMIN, { name: "Andres" }),
      { slug: "nova", name: "Nova Labs", admin: { email: "founder@nova.io" } });
    expect(r.status).toBe(201);
    expect(r.json.admin.status).toBe("invited");
    const novaId = (await one<{ id: string }>(`SELECT id FROM orgs WHERE slug = 'nova'`))!.id;
    const sent = await bodies();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ org_id: novaId, to_address: "founder@nova.io", subject: "You have been made the owner of Nova Labs on Trov" });
    expect(sent[0].html).toContain("named you its owner");
    expect(sent[0].html + sent[0].text).not.toMatch(/sapling/i);
    expect(await one(`SELECT mail_status, as_owner FROM org_invites WHERE id = ?`, r.json.admin.invite_id)).toEqual({ mail_status: "sent", as_owner: 1 });
  });

  it("POST …/orgs/:slug/admin with { email } mails the same; a GitHub login mails nothing; an existing person gets no invite mail", async () => {
    const boss = await cookieFor(SUPERADMIN, { name: "Andres" });
    expect((await call("POST", "/api/platform/orgs/acme/admin", boss, { email: "rescue@acme.io" })).status).toBe(200);
    let sent = await bodies();
    expect(sent.map((m) => [m.org_id, m.to_address, m.subject])).toEqual([[ORG_B, "rescue@acme.io", "You have been made the owner of Acme on Trov"]]);
    expect((await call("POST", "/api/platform/orgs/acme/admin", boss, { github_login: "octo-owner" })).status).toBe(200);
    await cookieFor("meilin"); // a SaplingLearn member already: made owner at once, and not for the first time anywhere
    expect((await call("POST", "/api/platform/orgs/acme/admin", boss, { handle: "meilin" })).status).toBe(200);
    sent = await bodies();
    expect(sent).toHaveLength(1);
  });
});

describe("the welcome mail — a person's FIRST membership of any org", () => {
  const newcomer = (handle: string, email: string) => cookieFor(handle, { member: false, email, verified: true, name: "New Comer" });

  it("accepting an invitation sends it under that org, naming it and linking into it; a second org's acceptance sends none", async () => {
    const me = await newcomer("newc", "newc@x.io");
    const boss = await acmeBoss();
    const first = (await call<{ invite: OrgInvite }>("POST", "/api/o/acme/invites", boss, { email: "newc@x.io" })).json.invite;
    const second = (await call<{ invite: OrgInvite }>("POST", "/api/o/saplinglearn/invites", await admin(), { email: "newc@x.io" })).json.invite;
    await exec(`DELETE FROM notification_outbox_bodies`); // drop the two invitation mails
    const accepted = await call<Record<string, unknown>>("POST", `/api/invites/${first.id}/accept`, me);
    expect(accepted.status).toBe(200);
    expect(accepted.json).toEqual({ ok: true, org: { slug: "acme", name: "Acme" }, role: "member" }); // the wire shape is unchanged
    let sent = await bodies();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ org_id: ORG_B, to_address: "newc@x.io", subject: "Welcome to Acme on Trov" });
    expect(sent[0].html).toContain("You have joined Acme.");
    expect(sent[0].html).toContain("@newc");
    expect(sent[0].html).toContain('href="https://trov.test/o/acme/#guide"');
    expect(sent[0].html + sent[0].text).not.toMatch(/sapling/i);
    expect((await call("POST", `/api/invites/${second.id}/accept`, me)).status).toBe(200);
    sent = await bodies();
    expect(sent).toHaveLength(1); // already a member somewhere: no second welcome
  });

  it("creating an org sends it once; leaving and joining another is not a second first; declining sends nothing", async () => {
    const me = await newcomer("solo", "solo@x.io");
    const invite = (await call<{ invite: OrgInvite }>("POST", "/api/o/acme/invites", await acmeBoss(), { email: "solo@x.io" })).json.invite;
    await exec(`DELETE FROM notification_outbox_bodies`);
    expect((await call("POST", `/api/invites/${invite.id}/decline`, me)).status).toBe(200);
    expect(await bodies()).toEqual([]);
    await exec(`UPDATE persons SET org_limit = 1 WHERE handle = 'solo'`); // self-serve creation is off by default
    expect((await call("POST", "/api/orgs", me, { slug: "solo-co", name: "Solo Co" })).status).toBe(201);
    const sent = await bodies();
    expect(sent.map((m) => [m.to_address, m.subject])).toEqual([["solo@x.io", "Welcome to Solo Co on Trov"]]);
    expect(sent[0].org_id).toBe((await one<{ id: string }>(`SELECT id FROM orgs WHERE slug = 'solo-co'`))!.id);
    // Leave nothing behind but the audit trail, then join again: still not a first.
    await exec(`DELETE FROM memberships WHERE user_id = 'solo'`);
    const again = (await call<{ invite: OrgInvite }>("POST", "/api/o/acme/invites", await acmeBoss(), { email: "solo@x.io" })).json.invite;
    await exec(`DELETE FROM notification_outbox_bodies`);
    expect((await call("POST", `/api/invites/${again.id}/accept`, me)).status).toBe(200);
    expect(await bodies()).toEqual([]);
  });

  it("goes only to a provider-VERIFIED address: a person with just an editable notification address gets none, and still joins", async () => {
    const me = await cookieFor("unver", { member: false, email: "typed@x.io" }); // persons.email only
    await exec(`UPDATE persons SET org_limit = 1 WHERE handle = 'unver'`); // self-serve creation is off by default
    expect((await call("POST", "/api/orgs", me, { slug: "unver-co", name: "Unver Co" })).status).toBe(201);
    expect(await bodies()).toEqual([]);
    expect(await one(`SELECT role FROM memberships WHERE user_id = 'unver'`)).toEqual({ role: "owner" });
  });

  it("a person the superadmin makes an owner directly is welcomed if that is their first org", async () => {
    await newcomer("fresh", "fresh@x.io");
    expect((await call("POST", "/api/platform/orgs", await cookieFor(SUPERADMIN), { slug: "fresh-co", name: "Fresh Co", admin: { handle: "fresh" } })).status).toBe(201);
    expect((await bodies()).map((m) => [m.to_address, m.subject])).toEqual([["fresh@x.io", "Welcome to Fresh Co on Trov"]]);
  });

  it("a mailer that is misconfigured never costs the join", async () => {
    const me = await newcomer("brk", "brk@x.io");
    await exec(`UPDATE persons SET org_limit = 1 WHERE handle = 'brk'`); // self-serve creation is off by default
    const res = await app.request("/api/orgs", { method: "POST", headers: { cookie: me, "content-type": "application/json" }, body: JSON.stringify({ slug: "brk-co", name: "Brk Co" }) },
      { ...env, NOTIFICATIONS_MODE: "resend", RESEND_API_KEY: "" });
    expect(res.status).toBe(201);
    expect(await one(`SELECT role FROM memberships WHERE user_id = 'brk'`)).toEqual({ role: "owner" });
  });
});

describe("isolation — one org's invite mail never touches another's", () => {
  it("org B's invite for an address org A also invited: two rows, two outboxes, each stamped alone", async () => {
    const a = (await call<{ invite: OrgInvite }>("POST", "/api/o/saplinglearn/invites", await admin(), { email: "both@x.io", name: "A's name" })).json.invite;
    const b = (await call<{ invite: OrgInvite }>("POST", "/api/o/acme/invites", await acmeBoss(), { email: "both@x.io", name: "B's name" })).json.invite;
    expect(a.id).not.toBe(b.id);
    const sent = await bodies();
    expect(sent.map((m) => [m.org_id, m.subject])).toEqual([[ORG_A, "Ada Admin invited you to SaplingLearn on Trov"], [ORG_B, "Bo Boss invited you to Acme on Trov"]]);
    expect(sent[0].html).toContain("A's name".replace("'", "&#39;"));
    expect(sent[1].html).not.toContain("A&#39;s name");
    const listB = (await call<{ invites: OrgInvite[] }>("GET", "/api/o/acme/invites", await acmeBoss())).json.invites;
    expect(listB.map((i) => i.name)).toEqual(["B's name"]);
  });
});

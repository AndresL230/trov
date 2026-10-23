import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/routes";
import { all, first } from "./helpers/db";
import { cookieFor } from "./helpers/persons";
import { renderInviteEmail, inviteSignInUrl } from "../src/notifications/invite";
import type { OrgInvite } from "@shared/orgs";

const post = (path: string, cookie: string, body?: unknown) =>
  app.request(path, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
const bodies = () => all<{ idempotency_key: string; to_address: string; subject: string; html: string; text: string }>(env.DB, `SELECT * FROM notification_outbox_bodies ORDER BY created_at`);

describe("renderInviteEmail", () => {
  it("names the inviter, the org, the role and the address, and links where it is told to", () => {
    const m = renderInviteEmail({ orgName: "Acme Robotics", role: "member", inviteeName: "Priya", inviterName: "Andres", email: "priya.n@gmail.com", signInUrl: "https://trov.test/auth/google/login?login_hint=priya.n%40gmail.com", host: "trov.test" });
    expect(m.subject).toBe("Andres invited you to Acme Robotics on Trov");
    expect(m.html).toContain("Hi Priya,");
    expect(m.html).toContain("Andres invited you to join Acme Robotics as a member.");
    expect(m.html + m.text).not.toMatch(/sapling/i);
    expect(m.html).toContain('href="https://trov.test/auth/google/login?login_hint=priya.n%40gmail.com"');
    expect(m.html).toContain("priya.n@gmail.com");
    expect(m.text).toContain("https://trov.test/auth/google/login?login_hint=priya.n%40gmail.com");
    expect(m.html).not.toContain("Unsubscribe");
  });

  it("carries the same Trov banner as the digests: the mark as table cells, no SVG, wordmark beside it", () => {
    const m = renderInviteEmail({ orgName: "Acme Robotics", role: "member", inviteeName: "Priya", inviterName: "Andres", email: "priya.n@gmail.com", signInUrl: "https://trov.test/x", host: "trov.test" });
    expect(m.html).not.toContain("<svg");
    expect(m.html).toContain('data-mark="trov"');
    expect((m.html.match(/data-cell="on"/g) ?? []).length).toBe(5);
    expect(m.html).toMatch(/data-mark="trov"[\s\S]*?Trov<\/(span|strong|td)>/);
  });

  it("opens with the headline in the banner, above the greeting", () => {
    const m = renderInviteEmail({ orgName: "Acme Robotics", role: "member", inviteeName: "Priya", inviterName: "Andres", email: "priya.n@gmail.com", signInUrl: "https://trov.test/x", host: "trov.test" });
    expect(m.html).toContain("You&#39;re invited to Acme Robotics on Trov.");
    // The headline is IN the band, reversed out of it, under an "Invitation" label — the first-run card's shape.
    expect(m.html).toMatch(/<div data-banner-title class="tm-title" style="[^"]*font-size:25px[^"]*color:#ffffff[^"]*">You&#39;re invited to Acme Robotics on Trov\.<\/div>/);
    expect(m.html).toMatch(/text-transform:uppercase[^>]*>Invitation<\/td>/);
    expect(m.html.match(/re invited to Acme/g)).toHaveLength(1);
    expect(m.html.indexOf("re invited to Acme")).toBeLessThan(m.html.indexOf("Hi Priya,"));
  });

  it("centres the sign-in button in the card", () => {
    const m = renderInviteEmail({ orgName: "Acme Robotics", role: "member", inviteeName: "Priya", inviterName: "Andres", email: "p@x.com", signInUrl: "https://trov.test/x", host: "trov.test" });
    expect(m.html).toMatch(/<div style="[^"]*text-align:center[^"]*"><a href="https:\/\/trov\.test\/x"/);
  });

  it("says what Trov actually is — an invitee has no other way to know", () => {
    const m = renderInviteEmail({ orgName: "Acme Robotics", role: "member", inviteeName: "Priya", inviterName: "Andres", email: "p@x.com", signInUrl: "https://trov.test/x", host: "trov.test" });
    expect(m.html).toContain("shared memory");
    expect(m.text).toContain("shared memory");
  });

  it("lands on Trov's own sign-in screen, not Google's account chooser", () => {
    expect(inviteSignInUrl("https://trov.test")).toBe("https://trov.test/");
    const m = renderInviteEmail({ orgName: "Acme Robotics", role: "member", inviteeName: null, inviterName: "Andres", email: "p@x.com", signInUrl: inviteSignInUrl("https://trov.test"), host: "trov.test" });
    expect(m.html).toContain('href="https://trov.test/"');
    expect(m.html).not.toContain("accounts.google.com");
    expect(m.html).not.toContain("login_hint");
    expect(m.text).toContain("https://trov.test/");
  });

  it("carries that headline into the plain-text part too", () => {
    const m = renderInviteEmail({ orgName: "Acme Robotics", role: "member", inviteeName: "Priya", inviterName: "Andres", email: "priya.n@gmail.com", signInUrl: "https://trov.test/x", host: "trov.test" });
    expect(m.text).toContain("You're invited to Acme Robotics on Trov.");
  });

  it("lays that banner out the way the digest shell does: brand top left", () => {
    const m = renderInviteEmail({ orgName: "Acme Robotics", role: "member", inviteeName: null, inviterName: "Andres", email: "priya.n@gmail.com", signInUrl: "https://trov.test/x", host: "trov.test" });
    expect(m.html).toMatch(/<td data-banner style="[^"]*text-align:left;">[\s\S]*?data-mark="trov"/);
  });
});

// The legacy `/invites` alias (addressed by e-mail) is gone; an org's invitations live at `/api/o/:slug/invites`,
// addressed by the invite's numeric id.
const INVITES = "/api/o/saplinglearn/invites";

describe("/api/o/:slug/invites (admin, session-cookie)", () => {
  it("non-admin → 403; unauthenticated → 401", async () => {
    expect((await app.request(INVITES, { headers: { cookie: await cookieFor("casey") } }, env)).status).toBe(403); // a plain member (AndresL230 is the org's OWNER — §5.2)
    expect((await app.request(INVITES, {}, env)).status).toBe(401);
  });
  it("the old /invites alias is gone", async () => {
    const admin = await cookieFor("admin-user");
    expect((await app.request("/invites", { headers: { cookie: admin } }, env)).status).toBe(404);
    expect((await post("/invites", admin, { email: "m@x.io" })).status).toBe(404);
    expect(await all(env.DB, `SELECT id FROM org_invites WHERE email = 'm@x.io'`)).toHaveLength(0);
  });
  it("POST creates the invite and sends the email through local delivery; GET lists it", async () => {
    const admin = await cookieFor("admin-user", { name: "Admin" });
    const res = await post(INVITES, admin, { email: "Priya.N@gmail.com", name: "Priya" });
    expect(res.status).toBe(201);
    const body = await res.json() as { ok: true; invite: OrgInvite };
    expect(body.invite.email).toBe("priya.n@gmail.com");
    expect(body.invite.mail_status).toBe("sent");
    const rows = await bodies();
    expect(rows).toHaveLength(1);
    expect(rows[0].to_address).toBe("priya.n@gmail.com");
    expect(rows[0].subject).toBe("Admin invited you to SaplingLearn on Trov");
    expect(rows[0].idempotency_key).toMatch(/^invite:\d+:/);
    expect(await first(env.DB, `SELECT name, mail_status, mail_error FROM org_invites WHERE email = 'priya.n@gmail.com'`)).toEqual({ name: "Priya", mail_status: "sent", mail_error: null });
    const list = await (await app.request(INVITES, { headers: { cookie: admin } }, env)).json() as { invites: OrgInvite[] };
    expect(list.invites.map((i) => i.email)).toEqual(["priya.n@gmail.com"]);
    expect(list.invites[0].mail_at).toBeTruthy(); expect(list.invites[0].mail_error).toBeNull(); expect(list.invites[0].name).toBe("Priya");
  });
  it("POST 400 on a bad email, 409 on a duplicate live invite or an existing member's address", async () => {
    const admin = await cookieFor("admin-user");
    expect((await post(INVITES, admin, { email: "nope" })).status).toBe(400);
    expect((await post(INVITES, admin, { email: "m@x.io" })).status).toBe(201);
    expect((await post(INVITES, admin, { email: "m@x.io" })).status).toBe(409);
    // A member who holds the address (a provider-verified one — the editable persons.email is not who someone is).
    await cookieFor("priya", { email: "priya@x.io" });
    await env.DB.prepare(`INSERT INTO identities (provider, subject, label, person, linked_at, linked_by, verified_email) VALUES ('google', 'sub-priya', 'priya@x.io', 'priya', '2026-01-01T00:00:00Z', 'seed', 'priya@x.io')`).run();
    const taken = await post(INVITES, admin, { email: "priya@x.io" });
    expect(taken.status).toBe(409);
    expect(((await taken.json()) as { error: string }).error).toBe("already_member");
  });
  it("resend writes a second body and updates mail_at; revoke is soft", async () => {
    const admin = await cookieFor("admin-user");
    const { invite } = await (await post(INVITES, admin, { email: "m@x.io" })).json() as { invite: OrgInvite };
    const sentAt = async () => (await first<{ mail_at: string }>(env.DB, `SELECT mail_at FROM org_invites WHERE email = 'm@x.io'`))!.mail_at;
    const before = await sentAt();
    await new Promise((r) => setTimeout(r, 5));
    expect((await post(`${INVITES}/${invite.id}/resend`, admin)).status).toBe(200);
    expect((await bodies())).toHaveLength(2);
    expect((await sentAt()) > before).toBe(true);
    expect((await post(`${INVITES}/${invite.id}/revoke`, admin)).status).toBe(200);
    expect((await first<{ status: string; responded_at: string | null }>(env.DB, `SELECT status, responded_at FROM org_invites WHERE email = 'm@x.io'`))).toEqual({ status: "revoked", responded_at: expect.any(String) });
    expect((await post(`${INVITES}/${invite.id + 1000}/revoke`, admin)).status).toBe(404);
    expect((await post(`${INVITES}/${invite.id}/resend`, admin)).status).toBe(404); // revoked → cannot resend
    expect((await bodies())).toHaveLength(2);
  });
  it("a delivery config error still creates the invite and records the error", async () => {
    const admin = await cookieFor("admin-user");
    const res = await app.request(INVITES, { method: "POST", headers: { cookie: admin, "content-type": "application/json" }, body: JSON.stringify({ email: "m@x.io" }) }, { ...env, NOTIFICATIONS_MODE: "resend", RESEND_API_KEY: "" });
    expect(res.status).toBe(201);
    const body = await res.json() as { invite: OrgInvite };
    expect(body.invite.mail_status).toBe("failed");
    expect(body.invite.mail_error).toContain("RESEND_API_KEY");
    expect((await first<{ mail_status: string; mail_error: string }>(env.DB, `SELECT mail_status, mail_error FROM org_invites WHERE email = 'm@x.io'`))).toEqual({ mail_status: "failed", mail_error: expect.stringContaining("RESEND_API_KEY") });
  });
});

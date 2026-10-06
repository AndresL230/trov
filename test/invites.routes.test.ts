import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/routes";
import { all, first } from "./helpers/db";
import { cookieFor } from "./helpers/persons";
import { renderInviteEmail, inviteSignInUrl } from "../src/notifications/invite";
import type { InviteRow } from "@shared/rows";

const post = (path: string, cookie: string, body?: unknown) =>
  app.request(path, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
const bodies = () => all<{ idempotency_key: string; to_address: string; subject: string; html: string; text: string }>(env.DB, `SELECT * FROM notification_outbox_bodies ORDER BY created_at`);

describe("renderInviteEmail", () => {
  it("names the inviter, the address, and links the Google sign-in with login_hint", () => {
    const m = renderInviteEmail({ inviteeName: "Priya", inviterName: "Andres", email: "priya.n@gmail.com", signInUrl: "https://trov.test/auth/google/login?login_hint=priya.n%40gmail.com", host: "trov.test" });
    expect(m.subject).toBe("Andres invited you to Trov");
    expect(m.html).toContain("Hi Priya,");
    expect(m.html).toContain('href="https://trov.test/auth/google/login?login_hint=priya.n%40gmail.com"');
    expect(m.html).toContain("priya.n@gmail.com");
    expect(m.text).toContain("https://trov.test/auth/google/login?login_hint=priya.n%40gmail.com");
    expect(m.html).not.toContain("Unsubscribe");
  });

  it("carries the same Trov banner as the digests: the mark as table cells, no SVG, wordmark beside it", () => {
    const m = renderInviteEmail({ inviteeName: "Priya", inviterName: "Andres", email: "priya.n@gmail.com", signInUrl: "https://trov.test/x", host: "trov.test" });
    expect(m.html).not.toContain("<svg");
    expect(m.html).toContain('data-mark="trov"');
    expect((m.html.match(/data-cell="on"/g) ?? []).length).toBe(5);
    expect(m.html).toMatch(/data-mark="trov"[\s\S]*?Trov<\/(span|strong|td)>/);
  });

  it("opens with the editorial headline, above the greeting", () => {
    const m = renderInviteEmail({ inviteeName: "Priya", inviterName: "Andres", email: "priya.n@gmail.com", signInUrl: "https://trov.test/x", host: "trov.test" });
    expect(m.html).toContain("You're invited to the Sapling team's shared workspace.");
    expect(m.html).toMatch(/font-size:26px/);
    expect(m.html.indexOf("You're invited to")).toBeLessThan(m.html.indexOf("Hi Priya,"));
  });

  it("centres the sign-in button in the card", () => {
    const m = renderInviteEmail({ inviteeName: "Priya", inviterName: "Andres", email: "p@x.com", signInUrl: "https://trov.test/x", host: "trov.test" });
    expect(m.html).toMatch(/<div style="[^"]*text-align:center[^"]*"><a href="https:\/\/trov\.test\/x"/);
  });

  it("says what Trov actually is — an invitee has no other way to know", () => {
    const m = renderInviteEmail({ inviteeName: "Priya", inviterName: "Andres", email: "p@x.com", signInUrl: "https://trov.test/x", host: "trov.test" });
    expect(m.html).toContain("shared memory");
    expect(m.text).toContain("shared memory");
  });

  it("lands on Trov's own sign-in screen, not Google's account chooser", () => {
    expect(inviteSignInUrl("https://trov.test")).toBe("https://trov.test/");
    const m = renderInviteEmail({ inviteeName: null, inviterName: "Andres", email: "p@x.com", signInUrl: inviteSignInUrl("https://trov.test"), host: "trov.test" });
    expect(m.html).toContain('href="https://trov.test/"');
    expect(m.html).not.toContain("accounts.google.com");
    expect(m.html).not.toContain("login_hint");
    expect(m.text).toContain("https://trov.test/");
  });

  it("carries that headline into the plain-text part too", () => {
    const m = renderInviteEmail({ inviteeName: "Priya", inviterName: "Andres", email: "priya.n@gmail.com", signInUrl: "https://trov.test/x", host: "trov.test" });
    expect(m.text).toContain("You're invited to the Sapling team's shared workspace.");
  });

  it("centres that banner the way the digest shell does", () => {
    const m = renderInviteEmail({ inviteeName: null, inviterName: "Andres", email: "priya.n@gmail.com", signInUrl: "https://trov.test/x", host: "trov.test" });
    expect(m.html).toMatch(/<td[^>]*text-align:center[^>]*>[\s\S]*?<table[^>]*align="center"[^>]*>[\s\S]*?data-mark="trov"/);
  });
});

describe("/invites (admin, session-cookie)", () => {
  it("non-admin → 403; unauthenticated → 401", async () => {
    expect((await app.request("/invites", { headers: { cookie: await cookieFor("AndresL230") } }, env)).status).toBe(403);
    expect((await app.request("/invites", {}, env)).status).toBe(401);
  });
  it("POST creates the invite and sends the email through local delivery; GET lists it", async () => {
    const admin = await cookieFor("admin-user", { name: "Admin" });
    const res = await post("/invites", admin, { email: "Priya.N@gmail.com", name: "Priya" });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: true; invite: InviteRow; email: { status: string; id: string | null; error: string | null } };
    expect(body.invite.email).toBe("priya.n@gmail.com");
    expect(body.email.status).toBe("sent");
    const rows = await bodies();
    expect(rows).toHaveLength(1);
    expect(rows[0].to_address).toBe("priya.n@gmail.com");
    expect(rows[0].subject).toBe("Admin invited you to Trov");
    expect(rows[0].idempotency_key).toMatch(/^invite:priya\.n@gmail\.com:/);
    const inv = (await first<InviteRow>(env.DB, `SELECT * FROM invites WHERE email = 'priya.n@gmail.com'`))!;
    expect(inv.email_sent_at).toBeTruthy(); expect(inv.email_error).toBeNull();
    const list = await (await app.request("/invites", { headers: { cookie: admin } }, env)).json() as { invites: InviteRow[] };
    expect(list.invites.map((i) => i.email)).toEqual(["priya.n@gmail.com"]);
  });
  it("POST 400 on a bad email, 409 on a duplicate live invite or an existing person's address", async () => {
    const admin = await cookieFor("admin-user");
    expect((await post("/invites", admin, { email: "nope" })).status).toBe(400);
    await post("/invites", admin, { email: "m@x.io" });
    expect((await post("/invites", admin, { email: "m@x.io" })).status).toBe(409);
    await cookieFor("priya", { email: "priya@x.io" });
    expect((await post("/invites", admin, { email: "priya@x.io" })).status).toBe(409);
  });
  it("resend writes a second body and updates email_sent_at; revoke is soft", async () => {
    const admin = await cookieFor("admin-user");
    await post("/invites", admin, { email: "m@x.io" });
    const before = (await first<InviteRow>(env.DB, `SELECT * FROM invites WHERE email = 'm@x.io'`))!;
    await new Promise((r) => setTimeout(r, 5));
    expect((await post("/invites/m%40x.io/resend", admin)).status).toBe(200);
    expect((await bodies())).toHaveLength(2);
    const after = (await first<InviteRow>(env.DB, `SELECT * FROM invites WHERE email = 'm@x.io'`))!;
    expect(after.email_sent_at! > before.email_sent_at!).toBe(true);
    expect((await post("/invites/m%40x.io/revoke", admin)).status).toBe(200);
    expect((await first<InviteRow>(env.DB, `SELECT * FROM invites WHERE email = 'm@x.io'`))!.revoked_at).toBeTruthy();
    expect((await post("/invites/none%40x.io/revoke", admin)).status).toBe(404);
    expect((await post("/invites/m%40x.io/resend", admin)).status).toBe(409); // revoked → cannot resend
  });
  it("a delivery config error still creates the invite and records the error", async () => {
    const admin = await cookieFor("admin-user");
    const res = await app.request("/invites", { method: "POST", headers: { cookie: admin, "content-type": "application/json" }, body: JSON.stringify({ email: "m@x.io" }) }, { ...env, NOTIFICATIONS_MODE: "resend", RESEND_API_KEY: "" });
    expect(res.status).toBe(200);
    const body = await res.json() as { email: { status: string; error: string | null } };
    expect(body.email.status).toBe("failed");
    expect(body.email.error).toContain("RESEND_API_KEY");
    expect((await first<InviteRow>(env.DB, `SELECT * FROM invites WHERE email = 'm@x.io'`))!.email_error).toContain("RESEND_API_KEY");
  });
});

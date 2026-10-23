/**
 * Every kind of mail Trov sends, by what "Unsubscribe from Trov email" (`persons.email_unsubscribed`, one
 * flag per person, every org) does to it — shared/email-unsubscribe.ts, docs/architecture/notifications.md
 * › Who gets what:
 *   • NOTIFICATIONS respect the flag and carry the person's signed link twice — the footer's Unsubscribe and
 *     the RFC 8058 `List-Unsubscribe` + `List-Unsubscribe-Post` headers: the digests (and their retry) and
 *     the welcome.
 *   • TRANSACTIONAL mail goes whatever the flag says, carries no unsubscribe, and its footer says what
 *     one-off thing it answers: the invitation (and the owner invitation), the grant / paid notice. The
 *     test send is the admin's own request: it goes, and being a digest it carries the digest's link.
 *   • No mail of any kind links a web font (or anything else) — opening one asks no third party for anything.
 * Mail is asserted on the bodies tables (local mode) and on the outgoing Resend request (a fetch stubbed at
 * the Response level) — never on mocks.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all, first, run } from "./helpers/db";
import { cookieFor, seedPerson, FIXTURE_ADMIN } from "./helpers/persons";
import { ORG_A, platformCtx, systemCtx } from "./helpers/tenant";
import { call, grantOrgs, SUPERADMIN } from "./helpers/orgs";
import { nowIso } from "../src/data/sql";
import { ingestAdrDraft } from "../src/consumer";
import { runDigest } from "../src/notifications/run";
import { retryFailed } from "../src/notifications/retry";
import { localDelivery } from "../src/notifications/delivery";
import { deliveryFor, PLATFORM_FROM } from "../src/notifications/resend";
import { unsubscribeUrl, verifyUnsubscribeToken } from "../src/notifications/unsubscribe";
import { assembleMessage } from "../src/notifications/assemble";
import { sampleSections } from "../src/notifications/sample";
import { renderInviteEmail, sendInvite } from "../src/notifications/invite";
import { renderWelcomeEmail, sendWelcome } from "../src/notifications/welcome";
import { renderGrantEmail, sendGrantNotice } from "../src/notifications/grant";
import { renderSupportEmail } from "../src/notifications/support";
import type { Env } from "../src/env";

const SECRET = "test-cookie-secret";
const ORIGIN = "https://trov.test";
const FRI = new Date("2026-09-11T12:00:00.000Z"); // Friday 08:00 New York: the daily digest is due
interface Body { to_address: string; subject: string; html: string; text: string }
const tenantBodies = () => all<Body>(env.DB, `SELECT to_address, subject, html, text FROM notification_outbox_bodies ORDER BY created_at, rowid`);
const platformBodies = () => all<Body>(env.DB, `SELECT to_address, subject, html, text FROM platform_outbox_bodies ORDER BY id`);
const to = (rows: Body[], address: string) => rows.filter((b) => b.to_address === address);
/** The handle a mail's Unsubscribe link names (from the text part), or null when it carries none. */
const unsubscribeHandle = async (m: { text: string }): Promise<string | null> => {
  const token = /Unsubscribe: https:\/\/trov\.test\/u\/(\S+)/.exec(m.text)?.[1];
  return token ? verifyUnsubscribeToken(token, SECRET) : null;
};
const UNSUB_LINK = />Unsubscribe<\/a>/;

/** A member of SaplingLearn with a digest address and, when `off`, the flag set. */
async function member(handle: string, off: 0 | 1): Promise<string> {
  const email = `${handle}@x.io`;
  await seedPerson(handle, { name: handle, email, unsubscribed: off });
  await run(env.DB, `UPDATE persons SET email = ?, email_unsubscribed = ? WHERE handle = ?`, email, off, handle);
  return email;
}
const digestOpts = (delivery = localDelivery(systemCtx())) => ({
  delivery, origin: ORIGIN, appBase: `${ORIGIN}/saplinglearn`, unsubscribeUrl: (l: string) => unsubscribeUrl(ORIGIN, l, SECRET),
});

describe("notifications respect the flag and carry the person's unsubscribe link", () => {
  it("the digest: an unsubscribed member gets none; a subscribed one gets one whose footer link names them", async () => {
    const on = await member("dee", 0);
    const off = await member("eli", 1);
    await ingestAdrDraft(systemCtx(), { title: "Pending decision", context: "c", decision: "d", rationale: "r", confidence: "high" }, "agent");
    await runDigest(systemCtx(), platformCtx(), "daily", FRI, digestOpts());
    const sent = await tenantBodies();
    expect(to(sent, off)).toEqual([]);
    expect(to(sent, on)).toHaveLength(1);
    expect(to(sent, on)[0].html).toMatch(UNSUB_LINK);
    expect(await unsubscribeHandle(to(sent, on)[0])).toBe("dee");
    expect(await first(env.DB, `SELECT 1 AS x FROM notification_outbox WHERE user_id = 'eli'`)).toBeNull(); // not even claimed
  });

  it("the digest retry: a member who unsubscribed after a failed send is not retried", async () => {
    const off = await member("eli", 1);
    await ingestAdrDraft(systemCtx(), { title: "Pending decision", context: "c", decision: "d", rationale: "r", confidence: "high" }, "agent");
    await run(env.DB, `INSERT INTO notification_outbox (org_id, idempotency_key, user_id, cadence, window_id, kinds, status, created_at) VALUES (?, ?, 'eli', 'daily', '2026-09-11', '["review_queue"]', 'failed', ?)`,
      ORG_A, `${ORG_A}:eli:daily:2026-09-11`, nowIso());
    const report = await retryFailed(systemCtx(), platformCtx(), digestOpts());
    expect(report.retried).toBe(0);
    expect(to(await tenantBodies(), off)).toEqual([]);
  });

  it("the welcome: an unsubscribed newcomer gets none (and still joins); a subscribed one gets one whose footer link names them", async () => {
    const quiet = await cookieFor("quinn", { member: false, email: "quinn@x.io", verified: true, unsubscribed: 1 });
    await grantOrgs("quinn");
    expect((await call("POST", "/api/orgs", quiet, { slug: "quinn-co", name: "Quinn Co" })).status).toBe(201);
    expect(await tenantBodies()).toEqual([]);
    expect(await first(env.DB, `SELECT role FROM memberships WHERE user_id = 'quinn'`)).toEqual({ role: "owner" });

    const keen = await cookieFor("kim", { member: false, email: "kim@x.io", verified: true });
    await grantOrgs("kim");
    expect((await call("POST", "/api/orgs", keen, { slug: "kim-co", name: "Kim Co" })).status).toBe(201);
    const [welcome] = await tenantBodies();
    expect(welcome).toMatchObject({ to_address: "kim@x.io", subject: "Welcome to Kim Co on Trov" });
    expect(welcome.html).toMatch(UNSUB_LINK);
    expect(await unsubscribeHandle(welcome)).toBe("kim");
  });
});

describe("transactional mail goes whatever the flag says, and carries no unsubscribe", () => {
  it("an invitation to an unsubscribed person's address is still sent, and says why it came", async () => {
    await cookieFor("fay", { member: false, email: "fay@x.io", verified: true, unsubscribed: 1 });
    const admin = await cookieFor(FIXTURE_ADMIN, { name: "Ada Admin" });
    expect((await call("POST", "/api/o/saplinglearn/invites", admin, { email: "fay@x.io" })).status).toBe(201);
    const [invite] = to(await tenantBodies(), "fay@x.io");
    expect(invite.subject).toContain("invited you to");
    expect(invite.html + invite.text).not.toMatch(/unsubscribe/i);
    expect(invite.text).toMatch(/You're getting this because .+ invited this address to .+: a one-off email, not a mailing list\./);
  });

  it("a grant notice to an unsubscribed person's address is still sent, and says why it came", async () => {
    await cookieFor("gus", { member: false, email: "gus@x.io", verified: true, unsubscribed: 1 });
    expect((await call("POST", "/api/platform/grants", await cookieFor(SUPERADMIN), { to: { email: "gus@x.io" }, plan: "team" })).status).toBe(201);
    const [notice] = to(await platformBodies(), "gus@x.io");
    expect(notice.subject).toBe("You can set up an organization on Trov");
    expect(notice.html + notice.text).not.toMatch(/unsubscribe/i);
    expect(notice.text).toMatch(/You're getting this because .+ gave this address an organization on Trov: a one-off email, not a mailing list\./);
  });

  it("a test send is the admin's own request: it goes to an unsubscribed admin too, with the digest's link", async () => {
    const admin = await cookieFor(FIXTURE_ADMIN, { email: "admin@x.io" });
    await run(env.DB, `UPDATE persons SET email = 'admin@x.io', email_unsubscribed = 1 WHERE handle = ?`, FIXTURE_ADMIN);
    const res = await call<{ ok: boolean }>("POST", "/api/o/saplinglearn/notifications/test-send", admin, { cadence: "daily", sample: true });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    const [sent] = to(await tenantBodies(), "admin@x.io");
    expect(await unsubscribeHandle(sent)).toBe(FIXTURE_ADMIN);
  });
});

describe("the headers, as Resend is asked: List-Unsubscribe on notifications only, https one-click alone", () => {
  it("digest and welcome carry the signed link and List-Unsubscribe-Post; invitation and grant notice carry neither", async () => {
    const resendEnv = { ...(env as unknown as Env), NOTIFICATIONS_MODE: "resend", RESEND_API_KEY: "re_test" } as Env;
    const sent: { to: string[]; headers?: Record<string, string> }[] = [];
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)) as (typeof sent)[number]);
      return new Response(JSON.stringify({ id: `em_${sent.length}` }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const on = await member("dee", 0);
    await ingestAdrDraft(systemCtx(), { title: "Pending decision", context: "c", decision: "d", rationale: "r", confidence: "high" }, "agent");
    await runDigest(systemCtx(), platformCtx(), "daily", FRI, digestOpts(deliveryFor(systemCtx(), resendEnv, { from: PLATFORM_FROM, fetchImpl })));
    expect((await sendWelcome(resendEnv, systemCtx(), { email: "new@x.io", name: "New", handle: "newbie", orgName: "SaplingLearn", orgSlug: "saplinglearn", origin: ORIGIN, fetchImpl })).status).toBe("sent");
    expect((await sendInvite(resendEnv, systemCtx(), platformCtx(FIXTURE_ADMIN), { inviteId: 999_999, email: "inv@x.io", inviteeName: null, inviterHandle: FIXTURE_ADMIN, orgName: "SaplingLearn", role: "member", origin: ORIGIN, fetchImpl })).status).toBe("sent");
    expect((await sendGrantNotice(resendEnv, platformCtx(), { grantId: 999_999, email: "grant@x.io", granterHandle: null, planName: "Pro", planDescription: "d", origin: ORIGIN, fetchImpl })).status).toBe("sent");

    const of = (address: string) => sent.find((m) => m.to[0] === address)!;
    for (const [address, handle] of [[on, "dee"], ["new@x.io", "newbie"]] as const) {
      const h = of(address).headers!;
      const link = /^<(https:\/\/trov\.test\/u\/([^>\s]+))>$/.exec(h["List-Unsubscribe"]);
      expect(link, address).not.toBeNull();
      expect(await verifyUnsubscribeToken(link![2], SECRET), address).toBe(handle);
      expect(h["List-Unsubscribe"]).not.toContain("mailto:");
      expect(h["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    }
    expect(of("inv@x.io").headers).toBeUndefined();
    expect(of("grant@x.io").headers).toBeUndefined();
  });
});

describe("no rendered email links a web font", () => {
  const NO_REMOTE = /fonts\.googleapis\.com|fonts\.gstatic\.com|<link\b|@import|@font-face|<script\b|<img\b/i;

  it("every template, every variant: the digest, both invitations, the welcome, the grant / gift / paid notices, the support notice", () => {
    const window = { cadence: "daily" as const, id: "2026-09-11", start: new Date("2026-09-10T12:00:00Z"), end: FRI };
    const weekly = { cadence: "weekly" as const, id: "2026-09-14", start: new Date("2026-09-07T12:00:00Z"), end: new Date("2026-09-14T12:00:00Z") };
    const invite = { inviteeName: "Priya", inviterName: "Ada", orgName: "Acme", email: "p@x.io", signInUrl: `${ORIGIN}/`, host: "trov.test" };
    const grant = { granterName: "Ada", planName: "Pro", planDescription: "d", email: "g@x.io", signInUrl: `${ORIGIN}/`, host: "trov.test" };
    const support = { id: 1, kind: "bug" as const, subject: "s", message: "m", org: null, route: null, appVersion: null, userAgent: null, reportUrl: `${ORIGIN}/platform/#platform/support/1`, host: "trov.test" };
    const rendered = [
      assembleMessage({ sections: sampleSections(), window, timeZone: "America/New_York", origin: ORIGIN, login: "dee", unsubscribeUrl: `${ORIGIN}/u/x.y` }),
      assembleMessage({ sections: sampleSections(), window: weekly, timeZone: "America/New_York", origin: ORIGIN, login: "dee", unsubscribeUrl: `${ORIGIN}/u/x.y` }),
      renderInviteEmail({ ...invite, role: "member" }),
      renderInviteEmail({ ...invite, role: "owner" }),
      renderWelcomeEmail({ name: "Kim", handle: "kim", orgName: "Acme", orgSlug: "acme", origin: ORIGIN, host: "trov.test", digests: { daily: true, weekly: true, sendHour: 8, timeZone: "UTC" }, unsubscribeUrl: `${ORIGIN}/u/x.y` }),
      renderGrantEmail(grant),
      renderGrantEmail({ ...grant, giftDays: 30 }),
      renderGrantEmail({ ...grant, granterName: null, paid: true }),
      renderSupportEmail({ ...support, reporter: { handle: "meilin", name: "Mei", email: "m@x.io" } }),
      renderSupportEmail({ ...support, reporter: null, contactEmail: "v@x.io" }),
    ];
    for (const m of rendered) {
      expect(m.html, m.subject).not.toMatch(NO_REMOTE);
      expect(m.html, m.subject).toContain("font-family:-apple-system,"); // the reader's own system fonts
    }
  });

  it("and what actually went out through the delivery gate", async () => {
    await member("dee", 0);
    await ingestAdrDraft(systemCtx(), { title: "Pending decision", context: "c", decision: "d", rationale: "r", confidence: "high" }, "agent");
    await runDigest(systemCtx(), platformCtx(), "daily", FRI, digestOpts());
    await sendWelcome(env as unknown as Env, systemCtx(), { email: "new@x.io", name: "New", handle: "newbie", orgName: "SaplingLearn", orgSlug: "saplinglearn", origin: ORIGIN });
    await sendGrantNotice(env as unknown as Env, platformCtx(), { grantId: 1, email: "grant@x.io", granterHandle: null, planName: "Pro", planDescription: "d", origin: ORIGIN });
    const mails = [...(await tenantBodies()), ...(await platformBodies())];
    expect(mails.length).toBeGreaterThanOrEqual(3);
    for (const m of mails) expect(m.html, m.subject).not.toMatch(NO_REMOTE);
  });
});

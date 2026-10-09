/**
 * Abuse limits (docs/architecture/abuse-limits.md) — what keeps a stranger with a GitHub account from
 * using Trov to send mail, fill storage or look people up:
 *   • the per-person counters (0042_organizations `abuse_counters`, src/platform/limits.ts) and the 429 each route answers;
 *   • the From header: an org contributes a display NAME, never an address, on every mail path;
 *   • the notification address is not an oracle for "is this address on file".
 * Real D1; mail is inspected at the Request level (resend mode with the global fetch swapped).
 */
import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/routes";
import type { Env } from "../src/env";
import { ingestAdrDraft } from "../src/consumer";
import { renamePerson } from "../src/auth/persons";
import { sealOnboard, ONBOARD_COOKIE, type OnboardPayload } from "../src/auth/onboard";
import { DAILY_CRON, handleNotificationCron } from "../src/notifications/cron";
import { PLATFORM_FROM, deliveryFor, platformFrom, senderNameProblem } from "../src/notifications/resend";
import { sendWelcome } from "../src/notifications/welcome";
import { LIMITS, LIMIT_RETENTION_DAYS, pruneLimits, takeLimit, type LimitedAction } from "../src/platform/limits";
import { all, first, run } from "./helpers/db";
import { cookieFor, seedPerson, FIXTURE_ADMIN } from "./helpers/persons";
import { ORG_A, ORG_B, ensureMember, platformCtx, systemCtx } from "./helpers/tenant";

const NOW = Date.parse("2026-10-06T10:20:00.000Z");
const DAY = "2026-10-06";
const p = () => platformCtx();
const json = (method: string, body: unknown, cookie: string): RequestInit => ({ method, headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
const counters = () => all<{ subject: string; action: string; bucket: string; count: number }>(env.DB, `SELECT subject, action, bucket, count FROM abuse_counters ORDER BY subject, action, bucket`);
/** Put `subject`'s CURRENT window for `action` at `count` (default: full). */
async function fill(subject: string, action: LimitedAction, count: number = LIMITS[action].max): Promise<void> {
  const bucket = new Date().toISOString().slice(0, LIMITS[action].window === "day" ? 10 : 13);
  await run(env.DB, `INSERT OR REPLACE INTO abuse_counters (subject, action, bucket, count, last_at) VALUES (?, ?, ?, ?, ?)`, subject, action, bucket, count, new Date().toISOString());
}
const countOf = async (subject: string, action: LimitedAction) =>
  (await first<{ count: number }>(env.DB, `SELECT count FROM abuse_counters WHERE subject = ? AND action = ?`, subject, action))?.count ?? 0;
async function expectLimited(res: Response): Promise<void> {
  expect(res.status).toBe(429);
  const body = (await res.json()) as { error: string; retry_after: number };
  expect(Object.keys(body).sort()).toEqual(["error", "retry_after"]);
  expect(body.error).toBe("rate_limited");
  expect(body.retry_after).toBeGreaterThanOrEqual(1);
  expect(res.headers.get("retry-after")).toBe(String(body.retry_after));
}

describe("the numbers", () => {
  it("are the documented ones", () => {
    expect(LIMITS).toEqual({
      invite: { max: 50, window: "day" }, test_send: { max: 20, window: "day" }, email_change: { max: 5, window: "day" },
      avatar_upload: { max: 20, window: "day" }, org_logo_upload: { max: 20, window: "day" }, handle_check: { max: 60, window: "hour" },
      checkout: { max: 10, window: "day" },
    });
  });
});

describe("takeLimit", () => {
  it("allows exactly `max` units per window, then answers the seconds until it turns over; a new window starts fresh", async () => {
    for (let i = 0; i < LIMITS.test_send.max; i++) expect(await takeLimit(p(), "casey", "test_send", NOW)).toBeNull();
    expect(await takeLimit(p(), "casey", "test_send", NOW)).toBe(13 * 3600 + 40 * 60); // until 00:00 UTC
    expect(await takeLimit(p(), "casey", "test_send", NOW + 1000)).toBe(13 * 3600 + 40 * 60 - 1);
    expect(await counters()).toEqual([{ subject: "casey", action: "test_send", bucket: DAY, count: 20 }]); // a refusal counts nothing
    expect(await takeLimit(p(), "casey", "test_send", NOW + 24 * 3_600_000)).toBeNull();
  });

  it("counts per subject and per action; an hourly limit turns over on the hour", async () => {
    for (let i = 0; i < LIMITS.handle_check.max; i++) await takeLimit(p(), "casey", "handle_check", NOW);
    expect(await takeLimit(p(), "casey", "handle_check", NOW)).toBe(40 * 60);
    expect(await takeLimit(p(), "dana", "handle_check", NOW)).toBeNull();
    expect(await takeLimit(p(), "casey", "invite", NOW)).toBeNull();
    expect(await takeLimit(p(), "casey", "handle_check", NOW + 40 * 60_000)).toBeNull();
    expect((await counters()).map((r) => r.bucket).sort()).toEqual([DAY, `${DAY}T10`, `${DAY}T10`, `${DAY}T11`]);
  });

  it("two racing takers cannot both have the last unit", async () => {
    await run(env.DB, `INSERT INTO abuse_counters (subject, action, bucket, count, last_at) VALUES ('casey', 'email_change', ?, ?, 't')`, DAY, LIMITS.email_change.max - 1);
    const got = await Promise.all(Array.from({ length: 6 }, () => takeLimit(p(), "casey", "email_change", NOW)));
    expect(got.filter((r) => r === null)).toHaveLength(1);
    expect((await counters())[0].count).toBe(LIMITS.email_change.max);
  });

  it("pruneLimits drops only counters whose window is long over", async () => {
    await takeLimit(p(), "casey", "invite", NOW);
    await takeLimit(p(), "casey", "invite", NOW - (LIMIT_RETENTION_DAYS + 1) * 86_400_000);
    expect(await pruneLimits(p(), new Date(NOW))).toBe(1);
    expect((await counters()).map((r) => r.bucket)).toEqual([DAY]);
  });

  it("a rename carries the counters, and clears what a previous holder of the new handle left", async () => {
    await seedPerson("old-me");
    await fill("old-me", "invite");
    await fill("new-me", "invite", 3);
    expect(await renamePerson(p(), "old-me", "new-me")).toEqual({ ok: true });
    expect((await counters()).map((r) => [r.subject, r.count])).toEqual([["new-me", LIMITS.invite.max]]);
  });
});

describe("invites: 50 per person per day, across every org and both routes", () => {
  it("the legacy route, its resend and the org route share one allowance; the 51st is 429 and writes nothing", async () => {
    const admin = await cookieFor(FIXTURE_ADMIN);
    await ensureMember(FIXTURE_ADMIN, "owner", ORG_B); // a second org does not double it
    expect((await app.request("/api/o/saplinglearn/invites", json("POST", { email: "one@x.io" }, admin), env)).status).toBe(201);
    expect((await app.request("/api/o/acme/invites", json("POST", { github_login: "octo-two" }, admin), env)).status).toBe(201);
    expect((await app.request(`/api/o/saplinglearn/invites`, json("POST", { email: "three@x.io" }, admin), env)).status).toBe(201);
    expect(await countOf(FIXTURE_ADMIN, "invite")).toBe(3);

    await fill(FIXTURE_ADMIN, "invite");
    const before = await all(env.DB, `SELECT id FROM org_invites`);
    await expectLimited(await app.request("/api/o/saplinglearn/invites", json("POST", { email: "four@x.io" }, admin), env));
    await expectLimited(await app.request("/api/o/acme/invites", json("POST", { github_login: "octo-five" }, admin), env));
    expect(await all(env.DB, `SELECT id FROM org_invites`)).toEqual(before);
    // The two e-mail invites above were mailed (the org route sends since 0042_organizations); the refused ones sent nothing.
    expect(await all(env.DB, `SELECT to_address FROM notification_outbox_bodies ORDER BY to_address`)).toEqual([{ to_address: "one@x.io" }, { to_address: "three@x.io" }]);
    expect(await countOf(FIXTURE_ADMIN, "invite")).toBe(LIMITS.invite.max);
  });

  it("the old /invites route and its resend are limited too — and a plain member's refusal costs nothing", async () => {
    const admin = await cookieFor(FIXTURE_ADMIN);
    expect((await app.request("/invites", json("POST", { email: "one@x.io" }, admin), env)).status).toBe(200);
    expect((await app.request("/invites/one%40x.io/resend", json("POST", {}, admin), env)).status).toBe(200);
    expect(await countOf(FIXTURE_ADMIN, "invite")).toBe(2);
    await fill(FIXTURE_ADMIN, "invite");
    await expectLimited(await app.request("/invites", json("POST", { email: "two@x.io" }, admin), env));
    await expectLimited(await app.request("/invites/one%40x.io/resend", json("POST", {}, admin), env));
    expect(await all(env.DB, `SELECT 1 FROM notification_outbox_bodies`)).toHaveLength(2);

    const member = await cookieFor("casey");
    expect((await app.request("/api/o/saplinglearn/invites", json("POST", { email: "x@x.io" }, member), env)).status).toBe(403);
    expect(await countOf("casey", "invite")).toBe(0);
  });

  it("a superadmin is exempt, and is not counted; the exemption goes with the grant", async () => {
    const owner = await cookieFor("AndresL230"); // the seeded superadmin (0042_organizations)
    expect(await first(env.DB, `SELECT 1 AS x FROM platform_admins WHERE person = 'AndresL230'`)).toEqual({ x: 1 });
    await fill("AndresL230", "invite");
    expect((await app.request("/api/o/saplinglearn/invites", json("POST", { email: "one@x.io" }, owner), env)).status).toBe(201);
    expect(await countOf("AndresL230", "invite")).toBe(LIMITS.invite.max);
    await run(env.DB, `DELETE FROM platform_admins WHERE person = 'AndresL230'`);
    await expectLimited(await app.request("/api/o/saplinglearn/invites", json("POST", { email: "two@x.io" }, owner), env));
  });
});

describe("test sends, avatar uploads and handle checks", () => {
  it("test-send: 20 per person per day", async () => {
    const admin = await cookieFor(FIXTURE_ADMIN, { email: "admin@example.com" });
    const send = () => app.request("/api/notifications/test-send", json("POST", { cadence: "daily", sample: true }, admin), env);
    expect((await send()).status).toBe(200);
    expect(await countOf(FIXTURE_ADMIN, "test_send")).toBe(1);
    await fill(FIXTURE_ADMIN, "test_send");
    await expectLimited(await send());
    await expectLimited(await app.request("/api/o/saplinglearn/notifications/test-send", json("POST", { cadence: "daily", sample: true }, admin), env));
    expect(await all(env.DB, `SELECT 1 FROM notification_outbox`)).toHaveLength(1);
  });

  it("avatar upload: 20 per person per day, refused before the body is read", async () => {
    const cookie = await cookieFor("casey");
    const upload = () => {
      const form = new FormData();
      form.set("file", new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])], "a.png", { type: "image/png" }));
      return app.request("/api/people/me/avatar", { method: "POST", headers: { cookie }, body: form }, env);
    };
    expect((await upload()).status).toBe(200);
    expect(await countOf("casey", "avatar_upload")).toBe(1);
    await fill("casey", "avatar_upload");
    await expectLimited(await upload());
    await expectLimited(await app.request("/api/o/saplinglearn/people/me/avatar", { method: "POST", headers: { cookie }, body: "not multipart" }, env));
  });

  it("handle-check: 60 per hour for a signed-in person, and per provider account while onboarding", async () => {
    const cookie = await cookieFor("casey");
    const check = (c: string) => app.request("/auth/handle-check?handle=free-handle", { headers: { cookie: c } }, env);
    expect(await (await check(cookie)).json()).toEqual({ available: true });
    expect(await countOf("casey", "handle_check")).toBe(1);
    await fill("casey", "handle_check");
    await expectLimited(await check(cookie));

    const payload: OnboardPayload = { provider: "github", subject: "newcomer", label: "newcomer", email: null, name: null, avatar_url: null, suggested_handle: "newcomer" };
    const onboard = `${ONBOARD_COOKIE}=${await sealOnboard(payload, "test-cookie-secret")}`;
    expect((await check(onboard)).status).toBe(200);
    expect(await countOf("onboard:github:newcomer", "handle_check")).toBe(1);
    await fill("onboard:github:newcomer", "handle_check");
    await expectLimited(await check(onboard));
    // A fresh cookie for the SAME provider account does not reset it; another account has its own.
    await expectLimited(await check(`${ONBOARD_COOKIE}=${await sealOnboard(payload, "test-cookie-secret")}`));
    expect((await check(`${ONBOARD_COOKIE}=${await sealOnboard({ ...payload, subject: "someone-else" }, "test-cookie-secret")}`)).status).toBe(200);
    expect((await app.request("/auth/handle-check?handle=free-handle", {}, env)).status).toBe(401);
  });
});

describe("the notification address", () => {
  it("a change is limited to 5 a day; re-saving the same address, clearing it and other prefs are free", async () => {
    const cookie = await cookieFor("casey", { email: "casey@example.com" });
    const put = (body: unknown) => app.request("/api/notifications/prefs", json("PUT", body, cookie), env);
    expect((await put({ email: "CASEY@example.com" })).status).toBe(200);
    expect((await put({ unsubscribed: true })).status).toBe(200);
    expect(await countOf("casey", "email_change")).toBe(0);
    for (let i = 0; i < LIMITS.email_change.max; i++) expect((await put({ email: `victim-${i}@example.com` })).status).toBe(200);
    await expectLimited(await put({ email: "victim-6@example.com" }));
    expect(await first(env.DB, `SELECT email FROM persons WHERE handle = 'casey'`)).toEqual({ email: "victim-4@example.com" });
    expect((await put({ email: "" })).status).toBe(200);
    expect((await put({ unsubscribed: false })).status).toBe(200);
  });

  it("an admin setting a member's address spends the ADMIN's allowance", async () => {
    const admin = await cookieFor(FIXTURE_ADMIN);
    await seedPerson("casey");
    await fill(FIXTURE_ADMIN, "email_change");
    await expectLimited(await app.request("/api/notifications/persons/casey", json("PUT", { email: "casey@example.com" }, admin), env));
    expect(await first(env.DB, `SELECT email FROM persons WHERE handle = 'casey'`)).toEqual({ email: null });
  });
});

// ── the From header ──────────────────────────────────────────────────────────

/** Sender settings an org admin could try, or a row written before the route checked: [stored value, the From it must produce]. */
const HOSTILE: [string, string][] = [
  ["CEO <ceo@trov.dev>", "CEO <hello@trov.dev>"],                                  // any address on the sending domain
  ["Acme <billing@acme.example>", "Acme <hello@trov.dev>"],
  ["security@trov.dev", PLATFORM_FROM],
  ['"Trov Security" <security@trov.dev>', PLATFORM_FROM],                          // reads as Trov's own voice
  ["T.r.o.v Support <x@y.z>", PLATFORM_FROM],
  ["TROV <x@y.z>", PLATFORM_FROM],
  ["Тrov <x@y.z>", PLATFORM_FROM],                                                 // a Cyrillic look-alike
  ["=?utf-8?b?VHJvdg==?= <x@y.z>", PLATFORM_FROM],                                 // RFC 2047 "Trov"
  ["Acme\r\nBcc: victim@example.com <x@y.z>", PLATFORM_FROM],                      // a second header
  ["Acme\nReply-To: evil@example.com", PLATFORM_FROM],
  ['Acme" <evil@example.com>, "x <x@y.z>', PLATFORM_FROM],                         // a second mailbox
  ["Acme <evil@example.com> <x@y.z>", "Acme <hello@trov.dev>"],
  ["A, B <x@y.z>", PLATFORM_FROM],
  ["Acme: Team; <x@y.z>", PLATFORM_FROM],
  [`${"A".repeat(65)} <x@y.z>`, PLATFORM_FROM],
  ["", PLATFORM_FROM],
];

describe("the From header: an org's display name, the platform's address — never anything else", () => {
  it("platformFrom produces a fixed shape for every stored value", () => {
    for (const [stored, from] of HOSTILE) expect(platformFrom(stored), JSON.stringify(stored)).toBe(from);
    expect(platformFrom("Trov <hello@trov.dev>")).toBe(PLATFORM_FROM);
    expect(platformFrom("Sapling & Co. <hello@trov.dev>")).toBe("Sapling & Co. <hello@trov.dev>");
    for (const [stored] of HOSTILE) expect(platformFrom(stored)).toMatch(/^[A-Za-z0-9 .&'+_-]{1,64} <hello@trov\.dev>$/);
    expect([senderNameProblem("Trov"), senderNameProblem("Trov Team"), senderNameProblem("Acme"), senderNameProblem("a<b")]).toEqual([null, "reserved", null, "characters"]);
  });

  it("PUT …/notifications/settings accepts a sender NAME (with or without the platform address) and refuses everything else", async () => {
    const admin = await cookieFor(FIXTURE_ADMIN);
    const put = (from_address: string) => app.request("/api/o/saplinglearn/notifications/settings", json("PUT", { from_address }, admin), env);
    const stored = async () => (await first<{ from_address: string }>(env.DB, `SELECT from_address FROM notification_settings WHERE org_id = ?`, ORG_A))!.from_address;
    for (const ok of ["Sapling Digest", "Sapling Digest <hello@trov.dev>", '"Sapling Digest" <Hello@Trov.dev>', "  Sapling   Digest  "]) {
      const res = await put(ok);
      expect(res.status, ok).toBe(200);
      expect(((await res.json()) as { from_address: string }).from_address, ok).toBe("Sapling Digest <hello@trov.dev>");
    }
    for (const [bad] of HOSTILE) {
      const res = await put(bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid payload");
    }
    expect(await stored()).toBe("Sapling Digest <hello@trov.dev>");
    expect((await put("Trov")).status).toBe(200); // the platform's own name is every org's default
    expect(await stored()).toBe(PLATFORM_FROM);
  });

  it("every mail path — digest, test send, invite, welcome — sends from the platform address, whatever the org's row says", async () => {
    const resendEnv = { ...(env as unknown as Env), NOTIFICATIONS_MODE: "resend", RESEND_API_KEY: "re_test", PUBLIC_ORIGIN: "https://trov.test" } as Env;
    const sent: { from: string; subject: string; headers?: Record<string, string> }[] = [];
    vi.stubGlobal("fetch", (async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.resend.com/emails");
      sent.push(JSON.parse(String(init?.body)) as (typeof sent)[number]);
      return new Response(JSON.stringify({ id: "em_1" }), { status: 200 });
    }) as typeof fetch);
    try {
      const admin = await cookieFor(FIXTURE_ADMIN, { email: "admin@example.com" });
      await run(env.DB, `UPDATE persons SET name = ? WHERE handle = ?`, "Mallory\r\nBcc: victim@example.com", FIXTURE_ADMIN);
      await ingestAdrDraft(systemCtx(), { title: "Pending decision", context: "c", decision: "d", rationale: "r", confidence: "high" }, "agent");
      for (const [i, [stored, from]] of [HOSTILE[0], HOSTILE[3], HOSTILE[8], HOSTILE[10]].entries()) {
        sent.length = 0;
        await run(env.DB, `UPDATE notification_settings SET from_address = ?, send_hour = 8, timezone = 'America/New_York' WHERE org_id = ?`, stored, ORG_A);
        await run(env.DB, `DELETE FROM notification_outbox`);
        await handleNotificationCron(resendEnv, DAILY_CRON, new Date("2026-09-11T12:00:00.000Z"));                                    // digest
        expect((await app.request("/api/notifications/test-send", json("POST", { cadence: "daily", sample: true }, admin), resendEnv)).status).toBe(200); // test send
        expect((await app.request("/invites", json("POST", { email: `inv-${i}@x.io` }, admin), resendEnv)).status).toBe(200);                 // invite
        expect((await sendWelcome(resendEnv, systemCtx(), { email: "new@x.io", name: "New", handle: "newbie", orgName: "Acme", orgSlug: "acme", origin: "https://trov.test" })).status).toBe("sent"); // welcome
        expect(sent, JSON.stringify(stored)).toHaveLength(4);
        for (const m of sent) {
          expect(m.from, JSON.stringify(stored)).toBe(from);
          expect(m.subject).not.toMatch(/[\r\n]/);
          if (m.headers) expect(m.headers["List-Unsubscribe"]).toContain("<mailto:hello@trov.dev?subject=unsubscribe>");
        }
      }
      expect(sent.some((m) => m.subject.startsWith("Mallory Bcc: victim@example.com invited you"))).toBe(true); // flattened, not dropped
    } finally { vi.unstubAllGlobals(); }
  });

  it("deliveryFor is the only door: in local mode too the subject is one line", async () => {
    const d = deliveryFor(systemCtx(ORG_B), env as unknown as Env, { from: "x" });
    await d.send({ idempotencyKey: "k", userId: "u", to: "a@b.co", subject: "one\r\ntwo three", html: "", text: "" });
    expect(await first(env.DB, `SELECT subject FROM notification_outbox_bodies WHERE org_id = ?`, ORG_B)).toEqual({ subject: "one two three" });
  });
});

import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/routes";
import { all, first } from "./helpers/db";
import { sealOnboard, ONBOARD_COOKIE, type OnboardPayload } from "../src/auth/onboard";
import { renderWelcomeEmail, welcomeUrl, sendWelcome, digestSentence, welcomeDigests, type WelcomeDigests } from "../src/notifications/welcome";
import { verifyUnsubscribeToken } from "../src/notifications/unsubscribe";
import type { PersonRow } from "@shared/rows";

import { systemCtx } from "./helpers/tenant";
// The welcome email — the transactional message onboarding sends once the person
// row exists. Asserted on the dev bodies table (NOTIFICATIONS_MODE unset = local),
// never on a mock, exactly like the invite and digest tests.

const PAYLOAD: OnboardPayload = {
  provider: "github", subject: "priya-gh", label: "priya-gh", email: "priya.n@gmail.com",
  name: "Priya Natarajan", avatar_url: null, suggested_handle: "priya-gh",
};
const cookie = async (p: OnboardPayload = PAYLOAD) => `${ONBOARD_COOKIE}=${await sealOnboard(p, "test-cookie-secret")}`;
const post = (path: string, c: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { cookie: c, "content-type": "application/json" }, body: JSON.stringify(body) }, env);
const bodies = () => all<{ idempotency_key: string; to_address: string; subject: string; html: string; text: string }>(
  env.DB, `SELECT * FROM notification_outbox_bodies ORDER BY created_at`);

/** What a new member of an org with the registry's defaults gets: daily (My Work, Review queue, Ticket
 *  queue) and weekly (Roadmap plan changes), at the default send hour. */
const DEFAULT_DIGESTS: WelcomeDigests = { daily: true, weekly: true, sendHour: 8, timeZone: "America/New_York" };
const UNSUB = "https://trov.test/u/priya.sig";
const input = (o: Partial<Parameters<typeof renderWelcomeEmail>[0]> = {}) => ({
  name: "Priya Natarajan", handle: "priya", orgName: "Acme Robotics", orgSlug: "acme", origin: "https://trov.test", host: "trov.test",
  digests: DEFAULT_DIGESTS, unsubscribeUrl: UNSUB, ...o,
});

describe("renderWelcomeEmail", () => {
  const m = renderWelcomeEmail(input());

  it("greets them, names their handle, and points at the guided setup", () => {
    expect(m.subject).toBe("Welcome to Acme Robotics on Trov");
    expect(m.html).toContain("You have joined Acme Robotics.");
    expect(m.html + m.text).not.toMatch(/sapling/i);
    expect(m.html).toContain("Hi Priya Natarajan,");
    expect(m.html).toContain("@priya");
    expect(m.html).toContain('href="https://trov.test/acme/#welcome"');
    expect(m.text).toContain("https://trov.test/acme/#welcome");
    // Settings is where the handle/colour and the digest cadence live.
    expect(m.html).toContain("https://trov.test/acme/#settings");
  });

  it("says digests are ON — as they are by default — and when they come; never that they are off until you pick", () => {
    for (const body of [m.html, m.text]) {
      expect(body).toContain("Email digests are on: Trov emails you one each weekday at 08:00 (America/New_York) when there is something for you, and a weekly one on Mondays.");
      expect(body).not.toMatch(/off until/i);
    }
    expect(digestSentence({ ...DEFAULT_DIGESTS, weekly: false }, "Acme")).toBe("Email digests are on: Trov emails you one each weekday at 08:00 (America/New_York) when there is something for you.");
    expect(digestSentence({ ...DEFAULT_DIGESTS, daily: false, sendHour: 17, timeZone: "UTC" }, "Acme")).toBe("Email digests are on: Trov emails you one each Monday at 17:00 (UTC) when there is something for you.");
    expect(digestSentence({ ...DEFAULT_DIGESTS, daily: false, weekly: false }, "Acme")).toBe("Email digests are off in Acme for now: its admin has turned them off.");
  });

  it("is a notification: its footer says why it came and carries the Unsubscribe link; the digests' banner", () => {
    expect(m.html).toContain(`You&#39;re getting this because you joined Acme Robotics on Trov. <a href="${UNSUB}"`);
    expect(m.html).toMatch(/>Unsubscribe<\/a>/);
    expect(m.text).toContain(`Unsubscribe: ${UNSUB}`);
    expect(m.html).not.toContain("<svg");
    expect(m.html).toContain('data-mark="trov"');
    expect((m.html.match(/data-cell="on"/g) ?? []).length).toBe(5);
  });

  it("drops the name when there isn't one", () => {
    const anon = renderWelcomeEmail(input({ name: null }));
    expect(anon.html).toContain("Hi,");
    expect(anon.text).toContain("Hi,");
  });

  it("welcomeUrl is the guided setup, the route the app lands a new person on", () => {
    expect(welcomeUrl("https://trov.test", "acme")).toBe("https://trov.test/acme/#welcome");
  });
});

describe("sendWelcome", () => {
  it("writes the rendered body in local mode and reports sent; its Unsubscribe link names the person", async () => {
    const r = await sendWelcome(env, systemCtx(), { email: "p@x.io", name: "P", handle: "priya", orgName: "Acme Robotics", orgSlug: "acme", origin: "https://trov.test" });
    expect(r.status).toBe("sent");
    const rows = await bodies();
    expect(rows.length).toBe(1);
    expect(rows[0].to_address).toBe("p@x.io");
    expect(rows[0].subject).toBe("Welcome to Acme Robotics on Trov");
    expect(rows[0].idempotency_key).toContain("welcome:priya:");
    const token = /Unsubscribe: https:\/\/trov\.test\/u\/(\S+)/.exec(rows[0].text)?.[1];
    expect(token).toBeTruthy();
    expect(await verifyUnsubscribeToken(token!, "test-cookie-secret")).toBe("priya");
  });

  it("states the org's digests as its policy has them: the registry's defaults, then an admin's change", async () => {
    expect(await welcomeDigests(systemCtx())).toEqual({ daily: true, weekly: true, sendHour: 8, timeZone: "America/New_York" });
    // Both weekly kinds off (the sprint line, and Phase E's "This week"): no weekly e-mail is left.
    for (const kind of ["roadmap_plan", "week_recap"]) {
      await env.DB.prepare(`INSERT INTO notification_policy (org_id, kind, default_cadence, enabled, updated_at, updated_by) VALUES ('org_saplinglearn', ?, 'weekly', 0, 'x', 'x')
        ON CONFLICT(org_id, kind) DO UPDATE SET enabled = 0`).bind(kind).run();
    }
    expect(await welcomeDigests(systemCtx())).toMatchObject({ daily: true, weekly: false });
    await sendWelcome(env, systemCtx(), { email: "p@x.io", name: "P", handle: "priya", orgName: "Acme Robotics", orgSlug: "acme", origin: "https://trov.test" });
    expect((await bodies())[0].text).toContain("Email digests are on: Trov emails you one each weekday at 08:00 (America/New_York) when there is something for you. To change");
  });

  it("never throws on a misconfigured mode — it reports failed", async () => {
    const r = await sendWelcome({ ...env, NOTIFICATIONS_MODE: "resend", RESEND_API_KEY: undefined } as unknown as typeof env,
      systemCtx(), { email: "p@x.io", name: null, handle: "priya", orgName: "Acme Robotics", orgSlug: "acme", origin: "https://trov.test" });
    expect(r.status).toBe("failed");
    expect(r.error).toContain("RESEND_API_KEY");
    expect((await bodies()).length).toBe(0);
  });
});

describe("POST /auth/onboard → welcome", () => {
  it("sends it once the person exists and joins their first org, to the address the provider gave", async () => {
    // Mail goes out AS an org, and onboarding joins none (below): the welcome follows the first membership —
    // here, accepting an org invitation for the verified address the provider gave.
    const onboard = await post("/auth/onboard", await cookie(), { handle: "priya", name: "Priya N", color: "plum" });
    expect(onboard.status).toBe(200);
    expect((await first<PersonRow>(env.DB, `SELECT * FROM persons WHERE handle = 'priya'`))!.email).toBe("priya.n@gmail.com");
    expect((await bodies()).length).toBe(0);

    const session = /(?:^|[\s,])(session=[^;]+)/.exec(onboard.headers.get("set-cookie") ?? "")?.[1];
    expect(session).toBeTruthy();
    await env.DB.prepare(`INSERT INTO org_invites (org_id, email, role, as_owner, invited_by, status, created_at) VALUES ('org_saplinglearn', 'priya.n@gmail.com', 'member', 0, 'AndresL230', 'pending', '2026-10-01T00:00:00Z')`).run();
    const { id } = (await first<{ id: number }>(env.DB, `SELECT id FROM org_invites WHERE email = 'priya.n@gmail.com'`))!;
    expect((await post(`/api/invites/${id}/accept`, session!, {})).status).toBe(200);

    const rows = await bodies();
    expect(rows.length).toBe(1);
    expect(rows[0].to_address).toBe("priya.n@gmail.com");
    expect(rows[0].subject).toBe("Welcome to SaplingLearn on Trov");
    expect(rows[0].html).toContain("@priya");          // the handle they just chose, not the suggestion
    expect(rows[0].html).toContain("Hi Priya N,");     // the name they just typed
  });

  it("sends nothing when the provider handed over no address — and still onboards", async () => {
    const noEmail = { ...PAYLOAD, email: null };
    expect((await post("/auth/onboard", await cookie(noEmail), { handle: "priya", name: null, color: "plum" })).status).toBe(200);
    expect(await first<PersonRow>(env.DB, `SELECT * FROM persons WHERE handle = 'priya'`)).toBeTruthy();
    expect((await bodies()).length).toBe(0);
  });

  it("sends nothing to a new person who joined no org (no mail goes out under an org they are not in)", async () => {
    expect((await post("/auth/onboard", await cookie(), { handle: "priya", name: "Priya N", color: "plum" })).status).toBe(200);
    expect(await first(env.DB, `SELECT 1 AS x FROM memberships WHERE user_id = 'priya'`)).toBeNull();
    expect((await bodies()).length).toBe(0);
    expect(await first(env.DB, `SELECT 1 AS x FROM notification_outbox`)).toBeNull();
  });
});

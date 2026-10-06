import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/routes";
import { all, first } from "./helpers/db";
import { sealOnboard, ONBOARD_COOKIE, type OnboardPayload } from "../src/auth/onboard";
import { renderWelcomeEmail, welcomeUrl, sendWelcome } from "../src/notifications/welcome";
import type { PersonRow } from "@shared/rows";

import { systemCtx } from "./helpers/tenant";
// The welcome email — the transactional message onboarding sends once the person
// row exists. Asserted on the dev bodies table (NOTIFICATIONS_MODE unset = local),
// never on a mock, exactly like the invite and digest tests.

const PAYLOAD: OnboardPayload = {
  provider: "github", subject: "priya-gh", label: "priya-gh", email: "priya.n@gmail.com",
  name: "Priya Natarajan", avatar_url: null, suggested_handle: "priya-gh", invite_email: null,
};
const cookie = async (p: OnboardPayload = PAYLOAD) => `${ONBOARD_COOKIE}=${await sealOnboard(p, "test-cookie-secret")}`;
const post = (path: string, c: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { cookie: c, "content-type": "application/json" }, body: JSON.stringify(body) }, env);
const bodies = () => all<{ idempotency_key: string; to_address: string; subject: string; html: string; text: string }>(
  env.DB, `SELECT * FROM notification_outbox_bodies ORDER BY created_at`);

describe("renderWelcomeEmail", () => {
  const m = renderWelcomeEmail({ name: "Priya Natarajan", handle: "priya", origin: "https://trov.test", host: "trov.test" });

  it("greets them, names their handle, and points at Get Started", () => {
    expect(m.subject).toBe("Welcome to Trov");
    expect(m.html).toContain("Hi Priya Natarajan,");
    expect(m.html).toContain("@priya");
    expect(m.html).toContain('href="https://trov.test/#guide"');
    expect(m.text).toContain("https://trov.test/#guide");
    // Settings is where the handle/colour and the digest cadence live.
    expect(m.html).toContain("https://trov.test/#settings");
  });

  it("is transactional — no unsubscribe, and the digests' banner", () => {
    expect(m.html).not.toContain("Unsubscribe");
    expect(m.html).not.toContain("<svg");
    expect(m.html).toContain('data-mark="trov"');
    expect((m.html.match(/data-cell="on"/g) ?? []).length).toBe(5);
  });

  it("drops the name when there isn't one", () => {
    const anon = renderWelcomeEmail({ name: null, handle: "priya", origin: "https://trov.test", host: "trov.test" });
    expect(anon.html).toContain("Hi,");
    expect(anon.text).toContain("Hi,");
  });

  it("welcomeUrl is the Get Started hash route the app lands a new person on", () => {
    expect(welcomeUrl("https://trov.test")).toBe("https://trov.test/#guide");
  });
});

describe("sendWelcome", () => {
  it("writes the rendered body in local mode and reports sent", async () => {
    const r = await sendWelcome(env, systemCtx(), { email: "p@x.io", name: "P", handle: "priya", origin: "https://trov.test" });
    expect(r.status).toBe("sent");
    const rows = await bodies();
    expect(rows.length).toBe(1);
    expect(rows[0].to_address).toBe("p@x.io");
    expect(rows[0].subject).toBe("Welcome to Trov");
    expect(rows[0].idempotency_key).toContain("welcome:priya:");
  });

  it("never throws on a misconfigured mode — it reports failed", async () => {
    const r = await sendWelcome({ ...env, NOTIFICATIONS_MODE: "resend", RESEND_API_KEY: undefined } as unknown as typeof env,
      systemCtx(), { email: "p@x.io", name: null, handle: "priya", origin: "https://trov.test" });
    expect(r.status).toBe("failed");
    expect(r.error).toContain("RESEND_API_KEY");
    expect((await bodies()).length).toBe(0);
  });
});

describe("POST /auth/onboard → welcome", () => {
  it("sends it once the person exists, to the address the provider gave", async () => {
    expect((await post("/auth/onboard", await cookie(), { handle: "priya", name: "Priya N", color: "plum" })).status).toBe(200);
    expect((await first<PersonRow>(env.DB, `SELECT * FROM persons WHERE handle = 'priya'`))!.email).toBe("priya.n@gmail.com");

    const rows = await bodies();
    expect(rows.length).toBe(1);
    expect(rows[0].to_address).toBe("priya.n@gmail.com");
    expect(rows[0].subject).toBe("Welcome to Trov");
    expect(rows[0].html).toContain("@priya");          // the handle they just chose, not the suggestion
    expect(rows[0].html).toContain("Hi Priya N,");     // the name they just typed
  });

  it("sends nothing when the provider handed over no address — and still onboards", async () => {
    const noEmail = { ...PAYLOAD, email: null };
    expect((await post("/auth/onboard", await cookie(noEmail), { handle: "priya", name: null, color: "plum" })).status).toBe(200);
    expect(await first<PersonRow>(env.DB, `SELECT * FROM persons WHERE handle = 'priya'`)).toBeTruthy();
    expect((await bodies()).length).toBe(0);
  });
});

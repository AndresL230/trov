import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import type { AppEnv } from "../src/auth/principal";
import { sessionGate } from "../src/auth/principal";
import { buildAuthApp } from "../src/auth/routes";
import { hmacSeal, b64uEncode } from "../src/auth/crypto";
import { sealOnboard, ONBOARD_COOKIE } from "../src/auth/onboard";
import { fakeGithubFetch } from "./helpers/github";
import { seedPerson } from "./helpers/persons";

function mountAuth(fetchImpl: typeof fetch): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", sessionGate);
  app.route("/auth", buildAuthApp({ fetchImpl }));
  return app;
}
const txCookie = async (state: string) => `oauth_tx=${await hmacSeal(`${state}.verifier.signin`, "test-cookie-secret")}`;
const pending = async (q: string, exp = Date.now() + 60_000) =>
  `oauth_pending=${await hmacSeal(b64uEncode(JSON.stringify({ q, exp })), "oauth-pending:test-cookie-secret")}`;
const Q = "response_type=code&client_id=abc&state=s1";

describe("sign-in returns to a pending authorize", () => {
  it("a known GitHub identity lands back on /oauth/authorize and the pending cookie is cleared", async () => {
    await seedPerson("knowndev");
    const app = mountAuth(fakeGithubFetch({ login: "knowndev" }));
    const res = await app.request("/auth/callback?code=c&state=st1", { headers: { cookie: `${await txCookie("st1")}; ${await pending(Q)}` } }, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/oauth/authorize?${Q}`);
    expect(res.headers.get("set-cookie") ?? "").toMatch(/oauth_pending=;|oauth_pending=.*Max-Age=0/);
  });
  it("with no pending cookie it lands on / as before", async () => {
    await seedPerson("knowndev");
    const app = mountAuth(fakeGithubFetch({ login: "knowndev" }));
    const res = await app.request("/auth/callback?code=c&state=st1", { headers: { cookie: await txCookie("st1") } }, env);
    expect(res.headers.get("location")).toBe("/");
  });
  it("stale pending cookie: an expired or tampered one lands on / with no error", async () => {
    await seedPerson("knowndev");
    const app = mountAuth(fakeGithubFetch({ login: "knowndev" }));
    for (const p of [await pending(Q, Date.now() - 1), "oauth_pending=tampered.sig"]) {
      const res = await app.request("/auth/callback?code=c&state=st1", { headers: { cookie: `${await txCookie("st1")}; ${p}` } }, env);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/");
    }
  });
  it("a brand-new person keeps the pending cookie through onboarding and gets the redirect from POST /auth/onboard", async () => {
    const app = mountAuth(fakeGithubFetch({ login: "brandnew" }));
    const cb = await app.request("/auth/callback?code=c&state=st1", { headers: { cookie: `${await txCookie("st1")}; ${await pending(Q)}` } }, env);
    expect(cb.headers.get("location")).toBe("/#onboard");
    expect(cb.headers.get("set-cookie") ?? "").not.toMatch(/oauth_pending=;/);
    const onboard = `${ONBOARD_COOKIE}=${await sealOnboard({ provider: "github", subject: "brandnew", label: "brandnew", email: null, name: null, avatar_url: null, suggested_handle: "brandnew" }, "test-cookie-secret")}`;
    const res = await app.request("/auth/onboard", {
      method: "POST", headers: { cookie: `${onboard}; ${await pending(Q)}`, "content-type": "application/json" },
      body: JSON.stringify({ handle: "brandnew", name: "B", color: "sky" }),
    }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, handle: "brandnew", redirect: `/oauth/authorize?${Q}` });
  });
});

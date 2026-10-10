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
import { isBillingStartPath, signInReturnPath } from "@shared/billing";

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
const returnTo = async (to: string, exp = Date.now() + 60_000) =>
  `return_to=${await hmacSeal(b64uEncode(JSON.stringify({ to, exp })), "return-to:test-cookie-secret")}`;

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

  // The purchase a sign-in was started for (src/auth/return-to.ts) rides the same tail. For someone who
  // already has an account the CALLBACK returns to it; a brand-new person has onboarding in between, and
  // it is POST /auth/onboard that hands the path back — for the SPA to follow (below).
  it("a brand-new BUYER keeps the purchase through onboarding: POST /auth/onboard hands back the checkout path", async () => {
    const app = mountAuth(fakeGithubFetch({ login: "newbuyer" }));
    const buy = await returnTo("/billing/start?plan=team");
    const cb = await app.request("/auth/callback?code=c&state=st1", { headers: { cookie: `${await txCookie("st1")}; ${buy}` } }, env);
    expect(cb.headers.get("location")).toBe("/#onboard");
    expect(cb.headers.get("set-cookie") ?? "").not.toMatch(/return_to=;/);   // still held for after onboarding
    const onboard = `${ONBOARD_COOKIE}=${await sealOnboard({ provider: "github", subject: "newbuyer", label: "newbuyer", email: null, name: null, avatar_url: null, suggested_handle: "newbuyer" }, "test-cookie-secret")}`;
    const res = await app.request("/auth/onboard", {
      method: "POST", headers: { cookie: `${onboard}; ${buy}`, "content-type": "application/json" },
      body: JSON.stringify({ handle: "newbuyer", name: "N", color: "sky" }),
    }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, handle: "newbuyer", redirect: "/billing/start?plan=team" });
    expect(res.headers.get("set-cookie") ?? "").toMatch(/return_to=;|return_to=.*Max-Age=0/);   // taken once
  });
});

describe("after signing up, the app goes on to what the sign-up was for", () => {
  it("recognises exactly two kinds of path: an MCP authorize request and a purchase link", () => {
    expect(signInReturnPath(`/oauth/authorize?${Q}`)).toBe(`/oauth/authorize?${Q}`);
    for (const buy of ["/billing/start?plan=team", "/billing/start?plan=team&interval=month", "/billing/start?plan=team&interval=year"]) {
      expect(isBillingStartPath(buy), buy).toBe(true);
      expect(signInReturnPath(buy), buy).toBe(buy);
    }
  });
  it("ignores everything else — another host, another path, a purchase link with anything added", () => {
    for (const bad of [undefined, null, "", 7, "/", "/#guide", "https://evil.example/", "//evil.example/billing/start?plan=team",
      "/billing/start?plan=team&via=github", "/billing/start?plan=team&next=//evil.example", "/billing/start?plan=enterprise",
      "/billing/start?plan=free", "/billing/start", "/billing/done?session_id=x", "/oauth/authorizeX?x=1", "javascript:alert(1)"]) {
      expect(signInReturnPath(bad), String(bad)).toBeNull();
    }
  });
});

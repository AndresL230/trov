import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { buildAuthApp } from "../src/auth/routes";
import { sessionGate, type AppEnv } from "../src/auth/principal";
import { hmacSeal } from "../src/auth/crypto";
import { first, all } from "./helpers/db";
import { createInvite } from "../src/auth/invites";
import { seedPerson, cookieFor } from "./helpers/persons";
import { makeGoogleKeys, signIdToken, googleFetch, CLAIMS } from "./helpers/google";
import type { IdentityRow } from "@shared/rows";

import { platformCtx } from "./helpers/tenant";
const NOW = () => 1_800_000_100_000;
function appWith(fetchImpl: typeof fetch) {
  const app = new Hono<AppEnv>();
  app.use("*", sessionGate);
  app.route("/auth", buildAuthApp({ fetchImpl, now: NOW }));
  return app;
}
const tx = async (mode = "signin") => `oauth_tx=${await hmacSeal(`st.ver.${mode}`, "test-cookie-secret")}`;

describe("GET /auth/google/login", () => {
  it("302s to Google with PKCE and a tx cookie; passes login_hint and prompt", async () => {
    const keys = await makeGoogleKeys();
    const app = appWith(googleFetch(keys).fetchImpl);
    const res = await app.request("/auth/google/login?login_hint=a%40b.c&prompt=select_account", {}, env);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(loc.searchParams.get("client_id")).toBe("test-google-client-id");
    expect(loc.searchParams.get("login_hint")).toBe("a@b.c");
    expect(loc.searchParams.get("prompt")).toBe("select_account");
    expect(loc.searchParams.get("redirect_uri")).toMatch(/\/auth\/google\/callback$/);
    expect(res.headers.get("set-cookie")).toContain("oauth_tx=");
  });
  it("?link=1 without a session falls back to a sign-in tx", async () => {
    const keys = await makeGoogleKeys();
    const res = await appWith(googleFetch(keys).fetchImpl).request("/auth/google/login?link=1", {}, env);
    expect(res.status).toBe(302);
  });
});

describe("GET /auth/google/callback", () => {
  it("invited + unknown → onboard cookie + redirect /#onboard", async () => {
    await createInvite(platformCtx(), { email: "priya.n@gmail.com", name: null, invitedBy: "AndresL230" });
    const keys = await makeGoogleKeys();
    const app = appWith(googleFetch(keys, { idToken: await signIdToken(keys, CLAIMS) }).fetchImpl);
    const res = await app.request("/auth/google/callback?code=c&state=st", { headers: { cookie: await tx() } }, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/#onboard");
    expect(res.headers.get("set-cookie")).toContain("onboard=");
  });
  it("not invited → onboarding all the same: Google sign-up is open", async () => {
    const keys = await makeGoogleKeys();
    const app = appWith(googleFetch(keys, { idToken: await signIdToken(keys, CLAIMS) }).fetchImpl);
    const res = await app.request("/auth/google/callback?code=c&state=st", { headers: { cookie: await tx() } }, env);
    expect(res.headers.get("location")).toBe("/#onboard");
    expect(res.headers.get("set-cookie")).toContain("onboard=");
  });
  it("unverified email → denied even when invited", async () => {
    await createInvite(platformCtx(), { email: "priya.n@gmail.com", name: null, invitedBy: "AndresL230" });
    const keys = await makeGoogleKeys();
    const app = appWith(googleFetch(keys, { idToken: await signIdToken(keys, { ...CLAIMS, email_verified: false }) }).fetchImpl);
    const res = await app.request("/auth/google/callback?code=c&state=st", { headers: { cookie: await tx() } }, env);
    expect(res.headers.get("location")).toBe("/?denied=unverified&email=priya.n%40gmail.com");
    expect(res.headers.get("set-cookie") ?? "").not.toContain("onboard=");
  });
  it("known identity → session cookie + redirect /", async () => {
    await seedPerson("priya");
    await env.DB.prepare(`INSERT INTO identities (provider, subject, label, person, linked_at, linked_by) VALUES ('google', 'g-123', 'priya.n@gmail.com', 'priya', 't', 'priya')`).run();
    const keys = await makeGoogleKeys();
    const app = appWith(googleFetch(keys, { idToken: await signIdToken(keys, CLAIMS) }).fetchImpl);
    const res = await app.request("/auth/google/callback?code=c&state=st", { headers: { cookie: await tx() } }, env);
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.get("set-cookie")).toContain("session=");
  });
  it("bad ID token → 401 identity_failed", async () => {
    const keys = await makeGoogleKeys();
    const app = appWith(googleFetch(keys, { idToken: "garbage" }).fetchImpl);
    const res = await app.request("/auth/google/callback?code=c&state=st", { headers: { cookie: await tx() } }, env);
    expect(res.status).toBe(401);
  });
  it("link mode with a session attaches Google to the caller; conflict redirects with ?link=conflict", async () => {
    const keys = await makeGoogleKeys();
    const app = appWith(googleFetch(keys, { idToken: await signIdToken(keys, CLAIMS) }).fetchImpl);
    const session = await cookieFor("AndresL230");
    const res = await app.request("/auth/google/callback?code=c&state=st", { headers: { cookie: `${session}; ${await tx("link")}` } }, env);
    expect(res.headers.get("location")).toBe("/#settings");
    expect((await first<IdentityRow>(env.DB, `SELECT * FROM identities WHERE subject = 'g-123'`))?.person).toBe("AndresL230");
    const other = await cookieFor("Jose-Gael-Cruz-Lopez");
    const res2 = await app.request("/auth/google/callback?code=c&state=st", { headers: { cookie: `${other}; ${await tx("link")}` } }, env);
    expect(res2.headers.get("location")).toBe("/?link=conflict#settings");
    // The conflict must be a no-op: still exactly one identities row for this
    // Google subject, still owned by AndresL230, and Jose gets no google identity.
    const rows = await all<IdentityRow>(env.DB, `SELECT * FROM identities WHERE provider = 'google' AND subject = 'g-123'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].person).toBe("AndresL230");
    expect(await first(env.DB, `SELECT 1 AS x FROM identities WHERE provider = 'google' AND person = 'Jose-Gael-Cruz-Lopez'`)).toBeNull();
  });
});

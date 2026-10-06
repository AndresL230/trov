import { describe, it, expect } from "vitest";
import { authApp } from "../src/auth/routes";
import { env } from "cloudflare:test";
import { hmacSeal } from "../src/auth/crypto";

describe("GET /auth/login", () => {
  it("302-redirects to GitHub authorize with PKCE params and sets the oauth_tx cookie", async () => {
    const res = await authApp.request("/login", {}, env);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(loc.searchParams.get("client_id")).toBe("test-client-id");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("code_challenge")).toBeTruthy();
    expect(loc.searchParams.get("state")).toBeTruthy();
    expect(res.headers.get("set-cookie")).toContain("oauth_tx=");
  });
});

describe("GET /auth/callback", () => {
  it("returns 400 when required params (code, state, tx cookie) are missing", async () => {
    // Hitting callback with no query params or tx cookie — should be 400 invalid_request.
    const res = await authApp.request("/callback", {}, env);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("invalid_request");
  });

  it("returns 403 bad_state when the tx cookie is tampered", async () => {
    // Provide a code+state+tx cookie where the tx is invalid (not a valid HMAC seal).
    const res = await authApp.request(
      "/callback?code=fake-code&state=fake-state",
      { headers: { cookie: "oauth_tx=not-a-valid-seal" } },
      env
    );
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("bad_state");
  });

  it("returns 403 state_mismatch when state does not match the tx cookie", async () => {
    // Build a valid seal that binds state "real-state" but send "wrong-state" in the query.
    const sealed = await hmacSeal("real-state.fake-verifier", "test-cookie-secret");
    const res = await authApp.request(
      "/callback?code=fake-code&state=wrong-state",
      { headers: { cookie: `oauth_tx=${sealed}` } },
      env
    );
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("state_mismatch");
  });

  // What the callback does once the state checks out — sign-in, onboarding, and the one GitHub refusal
  // left (`/?denied=1`: a known login presented by a different account, 0045) — is driven through
  // `buildAuthApp({ fetchImpl })` in test/signin.multitenant.test.ts. No GitHub org is checked any more.
});


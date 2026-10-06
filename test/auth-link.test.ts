import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import type { AppEnv } from "../src/auth/principal";
import { sessionGate } from "../src/auth/principal";
import { buildAuthApp } from "../src/auth/routes";
import { hmacSeal } from "../src/auth/crypto";
import { first } from "./helpers/db";
import { cookieFor } from "./helpers/persons";
import { fakeGithubFetch } from "./helpers/github";
import type { IdentityRow } from "@shared/rows";

/** Mounts buildAuthApp exactly like src/routes.ts does: sessionGate first, then /auth. */
function mountAuth(fetchImpl: typeof fetch): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", sessionGate);
  app.route("/auth", buildAuthApp({ fetchImpl }));
  return app;
}

const txCookie = async (mode: "signin" | "link", state: string, verifier = "verifier") =>
  `oauth_tx=${await hmacSeal(`${state}.${verifier}.${mode}`, "test-cookie-secret")}`;

describe("GitHub callback — link mode", () => {
  it("refuses link mode with no session cookie; nothing written", async () => {
    const app = mountAuth(fakeGithubFetch({ login: "newdev", name: "New Dev", avatar_url: null }));
    const res = await app.request("/auth/callback?code=c&state=st1", { headers: { cookie: await txCookie("link", "st1") } }, env);
    expect(res.status).toBe(403);
    expect(await first(env.DB, `SELECT 1 AS x FROM identities WHERE subject = 'newdev'`)).toBeNull();
  });

  it("attaches a free identity to the signed-in caller; a different caller linking the same identity gets a conflict", async () => {
    const app = mountAuth(fakeGithubFetch({ login: "newdev", name: "New Dev", avatar_url: null }));

    // linker-a has no identity of any provider yet (github: false) — link mode gives them their first.
    const sessionA = await cookieFor("linker-a", { github: false });
    const resA = await app.request("/auth/callback?code=c&state=st1", {
      headers: { cookie: `${await txCookie("link", "st1")}; ${sessionA}` },
    }, env);
    expect(resA.status).toBe(302);
    expect(resA.headers.get("location")).toBe("/#settings");
    const idAfterA = await first<IdentityRow>(env.DB, `SELECT * FROM identities WHERE subject = 'newdev'`);
    expect(idAfterA?.person).toBe("linker-a");

    // linker-b (also no identity yet) tries to claim the SAME github subject, already linker-a's.
    const sessionB = await cookieFor("linker-b", { github: false });
    const resB = await app.request("/auth/callback?code=c&state=st2", {
      headers: { cookie: `${await txCookie("link", "st2")}; ${sessionB}` },
    }, env);
    expect(resB.status).toBe(302);
    expect(resB.headers.get("location")).toBe("/?link=conflict#settings");
    const idAfterB = await first<IdentityRow>(env.DB, `SELECT * FROM identities WHERE subject = 'newdev'`);
    expect(idAfterB?.person).toBe("linker-a"); // unchanged
  });

  it("linking a second GitHub identity when the caller already has one redirects ?link=already (distinct from belongs_to_other)", async () => {
    const app = mountAuth(fakeGithubFetch({ login: "someone-else", name: "Someone Else", avatar_url: null }));
    const session = await cookieFor("linker-c"); // default github:true → already has a github identity (subject = handle)
    const res = await app.request("/auth/callback?code=c&state=st1", {
      headers: { cookie: `${await txCookie("link", "st1")}; ${session}` },
    }, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?link=already#settings");
    expect(await first(env.DB, `SELECT 1 AS x FROM identities WHERE subject = 'someone-else'`)).toBeNull();
  });
});

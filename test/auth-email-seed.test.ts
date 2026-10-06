/**
 * canopy-email.md §7 (Addresses): the teammate email is seeded at first login
 * from GET /user/emails (primary + verified), written only when the row has no
 * address yet, never overwriting a user- or admin-edited value.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { getPrimaryEmail } from "../src/auth/github";
import { recordSignIn, getPerson } from "../src/auth/persons";
import { seedPerson } from "./helpers/persons";

import { platformCtx } from "./helpers/tenant";
const jsonFetch = (status: number, body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;

describe("getPrimaryEmail", () => {
  it("returns the primary + verified address even when the profile email is private (noreply alias present)", async () => {
    const f = jsonFetch(200, [
      { email: "12345+jose@users.noreply.github.com", primary: false, verified: true, visibility: null },
      { email: "jose@example.com", primary: true, verified: true, visibility: "private" },
    ]);
    expect(await getPrimaryEmail("tok", f)).toBe("jose@example.com");
  });
  it("ignores a primary address that is not verified", async () => {
    const f = jsonFetch(200, [{ email: "x@example.com", primary: true, verified: false }]);
    expect(await getPrimaryEmail("tok", f)).toBeNull();
  });
  it("returns null on a non-2xx response", async () => {
    expect(await getPrimaryEmail("tok", jsonFetch(403, { message: "scope" }))).toBeNull();
  });
});

describe("recordSignIn — email written on first sign-in only", () => {
  it("first sign-in seeds a non-null email", async () => {
    await seedPerson("jose", { email: null });
    await recordSignIn(platformCtx(), "jose", { provider: "github", avatar_url: "https://a/img.png", email: "jose@example.com" });
    expect((await getPerson(env.DB, "jose"))!.email).toBe("jose@example.com");
  });
  it("a later sign-in never overwrites an existing address, even if the provider now reports a different one", async () => {
    await seedPerson("jose", { email: null });
    await recordSignIn(platformCtx(), "jose", { provider: "github", avatar_url: "https://a/img.png", email: "jose@example.com" });
    await env.DB.prepare(`UPDATE persons SET email = 'edited@example.com' WHERE handle = 'jose'`).run();
    await recordSignIn(platformCtx(), "jose", { provider: "github", avatar_url: "https://a/img.png", email: "new@github.example" });
    const r = (await getPerson(env.DB, "jose"))!;
    expect(r.email).toBe("edited@example.com");
    expect(r.name).toBe("jose"); // and a sign-in never writes the name (0036 PART B)
  });
  it("a sign-in with no address available leaves the column null, and a later sign-in with one fills it", async () => {
    await seedPerson("jose", { email: null });
    await recordSignIn(platformCtx(), "jose", { provider: "github", avatar_url: null, email: null });
    expect((await getPerson(env.DB, "jose"))!.email).toBeNull();
    await recordSignIn(platformCtx(), "jose", { provider: "github", avatar_url: null, email: "jose@example.com" });
    expect((await getPerson(env.DB, "jose"))!.email).toBe("jose@example.com");
  });
});

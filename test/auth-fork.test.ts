import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { first } from "../src/db";
import { completeSignIn, linkSignIn, suggestHandle, sealOnboard, openOnboard, type ProviderProfile } from "../src/auth/onboard";
import { createInvite } from "../src/auth/invites";
import { seedPerson } from "./helpers/persons";
import { hmacSeal, b64uEncode } from "../src/auth/crypto";
import type { IdentityRow, PersonRow } from "@shared/rows";

import { platformCtx } from "./helpers/tenant";
const google = (over: Partial<ProviderProfile> = {}): ProviderProfile => ({
  provider: "google", subject: "g-123", label: "priya.n@gmail.com", email: "priya.n@gmail.com", name: "Priya Natarajan", avatar_url: "https://lh3/p.png", ...over,
});
const github = (over: Partial<ProviderProfile> = {}): ProviderProfile => ({
  provider: "github", subject: "newdev", label: "newdev", email: "newdev@example.com", name: "New Dev", avatar_url: null, ...over,
});

describe("completeSignIn — the fork", () => {
  it("1. known identity → session; the name kept, email COALESCEd", async () => {
    const r = await completeSignIn(platformCtx(), github({ subject: "AndresL230", label: "AndresL230", name: "Andrés L", email: "x@y.z" }));
    expect(r).toEqual({ kind: "session", handle: "AndresL230" });
    const p = (await first<PersonRow>(env.DB, `SELECT * FROM persons WHERE handle = 'AndresL230'`))!;
    expect(p.name).toBe("Andres"); // a sign-in never writes the name (0036 PART B)
    expect(p.email).toBe("x@y.z"); // was NULL in the seed → filled
  });
  it("2. unknown identity, verified email matches a person → linked + session, no onboarding", async () => {
    await seedPerson("priya", { email: "priya.n@gmail.com", github: true });
    const r = await completeSignIn(platformCtx(), google());
    expect(r).toEqual({ kind: "session", handle: "priya" });
    const id = await first<IdentityRow>(env.DB, `SELECT * FROM identities WHERE provider = 'google' AND subject = 'g-123'`);
    expect(id?.person).toBe("priya");
    expect(id?.linked_by).toBe("priya");
  });
  it("3a. unknown Google identity with a live invite → onboard payload (nothing written)", async () => {
    await createInvite(platformCtx(), { email: "priya.n@gmail.com", name: "Priya", invitedBy: "AndresL230" });
    const r = await completeSignIn(platformCtx(), google());
    expect(r.kind).toBe("onboard");
    if (r.kind !== "onboard") throw new Error();
    expect(r.payload.suggested_handle).toBe("priya-n");
    expect(r.payload.invite_email).toBe("priya.n@gmail.com");
    expect(await first(env.DB, `SELECT 1 AS x FROM identities WHERE subject = 'g-123'`)).toBeNull();
    expect(await first(env.DB, `SELECT 1 AS x FROM persons WHERE handle = 'priya-n'`)).toBeNull();
  });
  it("3b. unknown GitHub identity (org member) → onboard with the login as suggested handle, no invite needed", async () => {
    const r = await completeSignIn(platformCtx(), github());
    expect(r.kind).toBe("onboard");
    if (r.kind !== "onboard") throw new Error();
    expect(r.payload.suggested_handle).toBe("newdev");
    expect(r.payload.invite_email).toBeNull();
  });
  it("4. unknown Google identity, no match, no invite (or revoked) → denied", async () => {
    expect(await completeSignIn(platformCtx(), google())).toEqual({ kind: "denied" });
    await createInvite(platformCtx(), { email: "priya.n@gmail.com", name: null, invitedBy: "AndresL230" });
    await env.DB.prepare(`UPDATE invites SET revoked_at = 't' WHERE email = 'priya.n@gmail.com'`).run();
    expect(await completeSignIn(platformCtx(), google())).toEqual({ kind: "denied" });
  });
  it("a null email never auto-links", async () => {
    await seedPerson("priya", { email: null });
    expect(await completeSignIn(platformCtx(), google({ email: null }))).toEqual({ kind: "denied" });
  });
  it("5. two persons already share an email (ambiguous) → denied, never auto-linked to either", async () => {
    await seedPerson("priya", { email: "priya.n@gmail.com" });
    await seedPerson("priyb", { email: "priya.n@gmail.com", github: false });
    expect(await completeSignIn(platformCtx(), google())).toEqual({ kind: "denied" });
    expect(await first(env.DB, `SELECT 1 AS x FROM identities WHERE subject = 'g-123'`)).toBeNull();
  });
});

describe("linkSignIn", () => {
  it("attaches a free identity to the caller; refuses one that belongs to someone else", async () => {
    await seedPerson("priya");
    expect(await linkSignIn(platformCtx(), "AndresL230", google())).toBe("linked");
    expect((await first<IdentityRow>(env.DB, `SELECT * FROM identities WHERE subject = 'g-123'`))?.person).toBe("AndresL230");
    expect(await linkSignIn(platformCtx(), "priya", google())).toBe("belongs_to_other");
  });
  it("refuses a second identity of the same provider on one person, without writing", async () => {
    // AndresL230 already has a github identity (seeded). A second github identity for
    // the same person must be refused — one identity per provider, or unlinkIdentity
    // could never disambiguate which to remove.
    const r = await linkSignIn(platformCtx(), "AndresL230", github({ subject: "alt-login", label: "alt-login" }));
    expect(r).toBe("provider_already_linked");
    expect(await first(env.DB, `SELECT 1 AS x FROM identities WHERE subject = 'alt-login'`)).toBeNull();
  });
});

describe("suggestHandle + onboard cookie", () => {
  it("github → the login lowercased; google → local part in the handle alphabet", () => {
    expect(suggestHandle(github({ subject: "NewDev" }))).toBe("newdev");
    expect(suggestHandle(google({ email: "Priya.N+x@gmail.com" }))).toBe("priya-n-x");
    expect(suggestHandle(google({ email: "9lives@x.io" }))).toBe("p-9lives");
  });
  it("seal/open round-trips (plus a server-added exp) and rejects tampering", async () => {
    const payload = { ...google(), suggested_handle: "priya-n", invite_email: "priya.n@gmail.com" };
    const sealed = await sealOnboard(payload, "s");
    expect(await openOnboard(sealed, "s")).toMatchObject(payload);
    expect(await openOnboard(sealed + "x", "s")).toBeNull();
    expect(await openOnboard(sealed, "other")).toBeNull();
  });
  it("rejects an expired payload", async () => {
    const payload = { ...google(), suggested_handle: "priya-n", invite_email: "priya.n@gmail.com" };
    const sealed = await sealOnboard(payload, "s");
    // 10 minutes + 1s past the seal time — past ONBOARD_TTL_S.
    expect(await openOnboard(sealed, "s", () => Date.now() + 601_000)).toBeNull();
  });
  it("rejects a sealed value with no exp field (bypassing sealOnboard)", async () => {
    const payload = { ...google(), suggested_handle: "priya-n", invite_email: "priya.n@gmail.com" };
    const rawSealed = await hmacSeal(b64uEncode(JSON.stringify(payload)), "onboard:s");
    expect(await openOnboard(rawSealed, "s")).toBeNull();
  });
  it("rejects a shape that isn't a valid provider profile", async () => {
    const badProvider = await hmacSeal(b64uEncode(JSON.stringify({ ...google(), provider: "facebook", exp: Date.now() + 600_000 })), "onboard:s");
    expect(await openOnboard(badProvider, "s")).toBeNull();
    const badSubject = await hmacSeal(b64uEncode(JSON.stringify({ ...google(), subject: 123, exp: Date.now() + 600_000 })), "onboard:s");
    expect(await openOnboard(badSubject, "s")).toBeNull();
  });
});

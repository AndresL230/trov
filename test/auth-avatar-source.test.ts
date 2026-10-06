// A person's picture and name do not flip with the provider they sign in with (0036 PART B).
// The provider picture belongs to ONE provider (`persons.avatar_source`): the first to bring
// one claims it, only that provider's sign-ins refresh it, and the other's never touch it.
// The name is never written by a sign-in at all — onboarding seeds it, Settings edits it.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/routes";
import { first, run } from "./helpers/db";
import { completeSignIn, linkSignIn, sealOnboard, ONBOARD_COOKIE, type ProviderProfile, type OnboardPayload } from "../src/auth/onboard";
import { getPerson, unlinkIdentity } from "../src/auth/persons";
import { createInvite } from "../src/auth/invites";
import { avatarSrc } from "@shared/people";
import type { PersonRow } from "@shared/rows";
import { cookieFor, seedPerson } from "./helpers/persons";
import combined from "../migrations/0036_person_profiles.sql?raw";

import { platformCtx } from "./helpers/tenant";
const GH_PIC = "https://avatars.githubusercontent.com/u/1?v=4";
const GH_PIC_NEW = "https://avatars.githubusercontent.com/u/1?v=5";
const GOOGLE_PIC = "https://lh3.googleusercontent.com/a/abc=s96-c";

const github = (over: Partial<ProviderProfile> = {}): ProviderProfile => ({
  provider: "github", subject: "AndresL230", label: "AndresL230", email: null, name: "Andrés (GitHub)", avatar_url: GH_PIC, ...over,
});
const google = (over: Partial<ProviderProfile> = {}): ProviderProfile => ({
  provider: "google", subject: "g-andres", label: "andres@gmail.com", email: "andres@gmail.com", name: "Andrés (Google)", avatar_url: GOOGLE_PIC, ...over,
});
const person = async (handle: string) => (await getPerson(platformCtx(), handle))!;

describe("the provider picture has ONE owner", () => {
  it("a GitHub sign-in fills a missing picture and claims it", async () => {
    await completeSignIn(platformCtx(), github());
    expect(await person("AndresL230")).toMatchObject({ avatar_url: GH_PIC, avatar_source: "github", name: "Andres" });
  });

  it("linking Google, then signing in with Google, leaves the picture AND the name as they were", async () => {
    await completeSignIn(platformCtx(), github());
    expect(await linkSignIn(platformCtx(), "AndresL230", google())).toBe("linked");
    expect(await person("AndresL230")).toMatchObject({ avatar_url: GH_PIC, avatar_source: "github", name: "Andres" });
    expect(await completeSignIn(platformCtx(), google())).toEqual({ kind: "session", handle: "AndresL230" });
    expect(await person("AndresL230")).toMatchObject({ avatar_url: GH_PIC, avatar_source: "github", name: "Andres" });
  });

  it("a later GitHub sign-in with a NEW GitHub picture refreshes it", async () => {
    await completeSignIn(platformCtx(), github());
    await linkSignIn(platformCtx(), "AndresL230", google());
    await completeSignIn(platformCtx(), google());
    await completeSignIn(platformCtx(), github({ avatar_url: GH_PIC_NEW }));
    expect(await person("AndresL230")).toMatchObject({ avatar_url: GH_PIC_NEW, avatar_source: "github" });
  });

  it("a sign-in that brings no picture keeps the one on file", async () => {
    await completeSignIn(platformCtx(), github());
    await completeSignIn(platformCtx(), github({ avatar_url: null }));
    expect(await person("AndresL230")).toMatchObject({ avatar_url: GH_PIC, avatar_source: "github" });
  });

  it("a Google-only person keeps their Google picture after linking GitHub and signing in with it", async () => {
    await seedPerson("meilin2", { name: "Meilin", github: false });
    await run(env.DB, `INSERT INTO identities (provider, subject, label, person, linked_at, linked_by) VALUES ('google', 'g-meilin2', 'meilin@x.org', 'meilin2', 't', 'seed')`);
    await completeSignIn(platformCtx(), google({ subject: "g-meilin2", label: "meilin@x.org", email: "meilin@x.org" }));
    expect(await person("meilin2")).toMatchObject({ avatar_url: GOOGLE_PIC, avatar_source: "google" });
    expect(await linkSignIn(platformCtx(), "meilin2", github({ subject: "meilin-gh", label: "meilin-gh" }))).toBe("linked");
    await completeSignIn(platformCtx(), github({ subject: "meilin-gh", label: "meilin-gh" }));
    expect(await person("meilin2")).toMatchObject({ avatar_url: GOOGLE_PIC, avatar_source: "google", name: "Meilin" });
  });

  it("the email branch (a new identity auto-linked by address) does not take the picture either", async () => {
    await seedPerson("priya", { email: "andres@gmail.com", verified: true }); // the address GitHub verified for them — what the link matches (§5.1)
    await completeSignIn(platformCtx(), github({ subject: "priya", label: "priya" }));
    expect(await completeSignIn(platformCtx(), google())).toEqual({ kind: "session", handle: "priya" });
    expect(await person("priya")).toMatchObject({ avatar_url: GH_PIC, avatar_source: "github", name: "priya" });
  });

  it("unlinking the owning provider releases the picture: it stays, and the other provider claims it next", async () => {
    await completeSignIn(platformCtx(), github());
    await linkSignIn(platformCtx(), "AndresL230", google());
    expect(await unlinkIdentity(platformCtx(), "AndresL230", "google")).toBe("ok"); // not the owner: nothing released
    expect((await person("AndresL230")).avatar_source).toBe("github");
    await linkSignIn(platformCtx(), "AndresL230", google());
    expect(await unlinkIdentity(platformCtx(), "AndresL230", "github")).toBe("ok");
    expect(await person("AndresL230")).toMatchObject({ avatar_url: GH_PIC, avatar_source: null });
    await completeSignIn(platformCtx(), google());
    expect(await person("AndresL230")).toMatchObject({ avatar_url: GOOGLE_PIC, avatar_source: "google" });
  });

  it("onboarding records the provider the picture came from", async () => {
    await createInvite(platformCtx(), { email: "priya.n@gmail.com", name: "Priya", invitedBy: "AndresL230" });
    const payload: OnboardPayload = { provider: "google", subject: "g-123", label: "priya.n@gmail.com", email: "priya.n@gmail.com", name: "Priya", avatar_url: GOOGLE_PIC, suggested_handle: "priya-n", invite_email: "priya.n@gmail.com" };
    const res = await app.request("/auth/onboard", {
      method: "POST", headers: { cookie: `${ONBOARD_COOKIE}=${await sealOnboard(payload, "test-cookie-secret")}`, "content-type": "application/json" },
      body: JSON.stringify({ handle: "priya", name: "Priya N", color: "plum" }),
    }, env);
    expect(res.status).toBe(200);
    expect(await person("priya")).toMatchObject({ avatar_url: GOOGLE_PIC, avatar_source: "google" });
    // …and a later GitHub link + sign-in leaves it.
    await linkSignIn(platformCtx(), "priya", github({ subject: "priya-gh", label: "priya-gh" }));
    await completeSignIn(platformCtx(), github({ subject: "priya-gh", label: "priya-gh" }));
    expect(await person("priya")).toMatchObject({ avatar_url: GOOGLE_PIC, avatar_source: "google", name: "Priya N" });
  });
});

describe("what a sign-in never overrides", () => {
  it("a name edited in Settings survives a sign-in with either provider", async () => {
    const cookie = await cookieFor("AndresL230");
    await completeSignIn(platformCtx(), github());
    await linkSignIn(platformCtx(), "AndresL230", google());
    const res = await app.request("/auth/me", { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Andy" }) }, env);
    expect(res.status).toBe(200);
    await completeSignIn(platformCtx(), github());
    await completeSignIn(platformCtx(), google());
    expect((await person("AndresL230")).name).toBe("Andy");
    // Cleared in Settings stays cleared, too: a sign-in never refills it.
    await app.request("/auth/me", { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: null }) }, env);
    await completeSignIn(platformCtx(), google());
    expect((await person("AndresL230")).name).toBeNull();
  });

  it("an uploaded avatar still outranks the provider picture, whoever signs in", async () => {
    const sha = "a".repeat(64);
    await completeSignIn(platformCtx(), github());
    await run(env.DB, `UPDATE persons SET avatar_sha = ? WHERE handle = 'AndresL230'`, sha);
    await linkSignIn(platformCtx(), "AndresL230", google());
    await completeSignIn(platformCtx(), google());
    await completeSignIn(platformCtx(), github({ avatar_url: GH_PIC_NEW }));
    const row = await person("AndresL230");
    expect(row).toMatchObject({ avatar_sha: sha, avatar_url: GH_PIC_NEW });
    expect(avatarSrc(row)).toBe(`/avatar/${sha}`);
  });
});

// ── the migration's backfill ──────────────────────────────────────────────────

/** PART B of 0036 — everything after its marker line; its one UPDATE is the backfill. */
async function runBackfill(): Promise<void> {
  const body = (combined.split("-- ═══ PART B")[1] ?? "").replace(/^--.*$/gm, "");
  const statements = body.split(/;\s*$/m).map((s) => s.trim()).filter((s) => /^UPDATE\b/.test(s));
  expect(statements.length).toBe(1);
  for (const st of statements) await env.DB.prepare(st).run();
}

describe("0036 PART B backfill — avatar_source from the picture's host, conservatively", () => {
  it("github / google hosts are named; anything else stays NULL", async () => {
    const rows: [string, string | null, string | null][] = [
      ["b-gh", GH_PIC, "github"],
      ["b-ghcase", "HTTPS://Avatars.GitHubUserContent.com/u/2", "github"],
      ["b-google", GOOGLE_PIC, "google"],
      ["b-google2", "https://lh4.googleusercontent.com/x", "google"],
      ["b-null", null, null],
      ["b-other", "https://a/p.png", null],
      ["b-http", "http://avatars.githubusercontent.com/u/1", null],                     // not https
      ["b-spoof", "https://evil.example/avatars.githubusercontent.com/u/1", null],       // host is evil.example
      ["b-spoof2", "https://avatars.githubusercontent.com.evil.example/u/1", null],
      ["b-bare", "https://lh3.googleusercontent.com", null],                            // no path: host unread
    ];
    for (const [h, url] of rows) await seedPerson(h, { avatar_url: url, github: false });
    await runBackfill();
    for (const [h, , want] of rows) expect([h, (await first<PersonRow>(env.DB, `SELECT * FROM persons WHERE handle = ?`, h))!.avatar_source]).toEqual([h, want]);
  });

  it("never overwrites an owner already recorded", async () => {
    await seedPerson("b-set", { avatar_url: GH_PIC, github: false });
    await run(env.DB, `UPDATE persons SET avatar_source = 'google' WHERE handle = 'b-set'`);
    await runBackfill();
    expect((await person("b-set")).avatar_source).toBe("google");
  });

  it("the CHECK refuses an unknown provider", async () => {
    await seedPerson("b-check", { github: false });
    await expect(run(env.DB, `UPDATE persons SET avatar_source = 'gitlab' WHERE handle = 'b-check'`)).rejects.toThrow(/CHECK/);
  });
});

import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { first } from "../src/db";
import {
  isValidHandle, defaultColor, handleAvailable, createPerson, HandleTakenError, recordSignIn,
  linkIdentity, unlinkIdentity, listIdentities, findIdentity, findPersonByEmail, updateProfile, listPersons, getPerson,
} from "../src/auth/persons";
import type { PersonRow } from "@shared/rows";

describe("handle rules", () => {
  it("validates the regex", () => {
    expect(isValidHandle("priya")).toBe(true);
    expect(isValidHandle("p-1")).toBe(true);
    expect(isValidHandle("Priya")).toBe(false);
    expect(isValidHandle("1p")).toBe(false);
    expect(isValidHandle("p")).toBe(false);
    expect(isValidHandle("a".repeat(25))).toBe(false);
  });
  it("defaultColor is stable and in the palette", () => {
    expect(defaultColor("AndresL230")).toBe(defaultColor("AndresL230"));
    expect(["moss","fern","sky","slate","plum","rose","rust","ochre","clay","stone"]).toContain(defaultColor("x"));
  });
  it("handleAvailable: invalid, reserved, taken (case-insensitive), available", async () => {
    expect(await handleAvailable(env.DB, "Bad")).toEqual({ available: false, reason: "invalid" });
    expect(await handleAvailable(env.DB, "admin")).toEqual({ available: false, reason: "reserved" });
    expect(await handleAvailable(env.DB, "andresl230")).toEqual({ available: false, reason: "taken" }); // seeded AndresL230
    expect(await handleAvailable(env.DB, "priya")).toEqual({ available: true });
  });
});

describe("createPerson / recordSignIn", () => {
  it("creates a person and refuses a case-colliding handle", async () => {
    const p = await createPerson(env.DB, { handle: "priya", name: "Priya N", color: "plum", avatar_url: null, email: "priya@example.com" });
    expect(p.handle).toBe("priya");
    expect(p.onboarded_at).toBeTruthy();
    await expect(createPerson(env.DB, { handle: "PRIYA", name: null, color: "moss", avatar_url: null, email: null })).rejects.toBeInstanceOf(HandleTakenError);
  });
  it("a CHECK violation (invalid color) is not mis-reported as a taken handle", async () => {
    await expect(
      createPerson(env.DB, { handle: "zed", name: null, color: "neon" as never, avatar_url: null, email: null })
    ).rejects.not.toBeInstanceOf(HandleTakenError);
  });
  it("recordSignIn fills the picture, never writes the name, and never overwrites a set email", async () => {
    await createPerson(env.DB, { handle: "priya", name: "Priya", color: "plum", avatar_url: null, email: "set@example.com" });
    await recordSignIn(env.DB, "priya", { provider: "github", avatar_url: "https://a/p.png", email: "other@example.com" });
    const row = (await getPerson(env.DB, "priya"))!;
    expect(row.name).toBe("Priya");
    expect(row.avatar_url).toBe("https://a/p.png");
    expect(row.email).toBe("set@example.com");
  });
  it("recordSignIn fills a NULL email", async () => {
    await createPerson(env.DB, { handle: "priya", name: null, color: "plum", avatar_url: null, email: null });
    await recordSignIn(env.DB, "priya", { provider: "github", avatar_url: null, email: "late@example.com" });
    expect((await getPerson(env.DB, "priya"))!.email).toBe("late@example.com");
  });
});

describe("identities", () => {
  it("link, list, find, unlink; the last identity cannot be unlinked", async () => {
    await createPerson(env.DB, { handle: "priya", name: null, color: "plum", avatar_url: null, email: null });
    await linkIdentity(env.DB, { provider: "google", subject: "g-123", label: "priya@example.com", person: "priya", linkedBy: "priya" });
    expect((await findIdentity(env.DB, "google", "g-123"))?.person).toBe("priya");
    expect(await unlinkIdentity(env.DB, "priya", "google")).toBe("last_identity");
    await linkIdentity(env.DB, { provider: "github", subject: "priya-gh", label: "priya-gh", person: "priya", linkedBy: "priya" });
    expect((await listIdentities(env.DB, "priya")).map((i) => i.provider).sort()).toEqual(["github", "google"]);
    expect(await unlinkIdentity(env.DB, "priya", "google")).toBe("ok");
    expect(await unlinkIdentity(env.DB, "priya", "google")).toBe("not_found");
  });
  it("findPersonByEmail is case-insensitive", async () => {
    await createPerson(env.DB, { handle: "priya", name: null, color: "plum", avatar_url: null, email: "Priya@Example.com" });
    expect((await findPersonByEmail(env.DB, "priya@example.com"))?.handle).toBe("priya");
  });
  it("findPersonByEmail returns null when more than one person shares the address (ambiguous)", async () => {
    await createPerson(env.DB, { handle: "priya", name: null, color: "plum", avatar_url: null, email: "dup@example.com" });
    await createPerson(env.DB, { handle: "priyb", name: null, color: "moss", avatar_url: null, email: "DUP@example.com" });
    expect(await findPersonByEmail(env.DB, "dup@example.com")).toBeNull();
  });
});

describe("updateProfile / listPersons", () => {
  it("updates name and color only; rejects an unknown handle", async () => {
    const before = await first<PersonRow>(env.DB, `SELECT * FROM persons WHERE handle = 'AndresL230'`);
    const after = await updateProfile(env.DB, "AndresL230", { name: "Andrés", color: "rose" });
    expect(after?.name).toBe("Andrés");
    expect(after?.color).toBe("rose");
    expect(after?.created_at).toBe(before?.created_at);
    expect(await updateProfile(env.DB, "nobody", { color: "moss" })).toBeNull();
  });
  it("listPersons returns the whole seeded directory, handle-sorted, with color", async () => {
    // Six since the tickets build: the four engineers plus the two Google-only
    // non-engineer requesters (meilin / sanaok) the queue is filed by.
    const rows = await listPersons(env.DB);
    expect(rows.map((r) => r.handle)).toEqual(
      ["AndresL230", "Darkest-Teddy", "Jose-Gael-Cruz-Lopez", "lpcooper-arch", "meilin", "sanaok"]
    );
    expect(rows[0].color).toBe("moss");
  });
});

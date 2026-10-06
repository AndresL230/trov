import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { createSession, getSessionUser, deleteSession } from "../src/auth/session";
import { run } from "./helpers/db";
import { seedPerson } from "./helpers/persons";

import { platformCtx } from "./helpers/tenant";
describe("sessions", () => {
  it("creates a session and resolves it to the person", async () => {
    await seedPerson("real-user");
    const { id } = await createSession(platformCtx(), "real-user");
    expect(id.length).toBeGreaterThanOrEqual(43);
    expect(await getSessionUser(platformCtx(), id)).toBe("real-user");
  });

  it("returns null for an unknown session id", async () => {
    expect(await getSessionUser(platformCtx(), "nope")).toBeNull();
  });

  it("returns null for an expired session", async () => {
    await seedPerson("real-user");
    await run(env.DB,
      `INSERT INTO sessions (id, person, created_at, expires_at) VALUES (?, ?, ?, ?)`,
      "expired-id", "real-user", "2020-01-01T00:00:00Z", "2020-01-02T00:00:00Z");
    expect(await getSessionUser(platformCtx(), "expired-id")).toBeNull();
  });

  it("deletes a session (revocation)", async () => {
    await seedPerson("real-user");
    const { id } = await createSession(platformCtx(), "real-user");
    await deleteSession(platformCtx(), id);
    expect(await getSessionUser(platformCtx(), id)).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/routes";
import { cookieFor } from "./helpers/persons";

describe("POST /admin/backfill (session- + admin-gated)", () => {
  it("401s without a session", async () => {
    const res = await app.request("/admin/backfill", { method: "POST" }, env);
    expect(res.status).toBe(401);
  });

  it("403s for a non-admin principal", async () => {
    const res = await app.request(
      "/admin/backfill",
      { method: "POST", headers: { cookie: await cookieFor("not-admin") } },
      env
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "admin only" });
  });

  it("passes the admin gate and 503s when the service token is unset (proves wiring, no network)", async () => {
    // "admin-user" is seeded as an org admin (test/helpers/persons.ts), so this login clears
    // the role gate. The org has no repo and no GitHub token in tests, so runBackfill
    // returns ok:false BEFORE any GitHub fetch → 503 with the config error.
    const res = await app.request(
      "/admin/backfill",
      { method: "POST", headers: { cookie: await cookieFor("admin-user") } },
      env
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "service token or repo not configured" });
  });
});

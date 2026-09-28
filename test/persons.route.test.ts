import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/routes";
import { cookieFor } from "./helpers/persons";

describe("GET /persons", () => {
  it("lists every person with handle, name, color, avatar_url, role — no email, no responsibilities", async () => {
    const res = await app.request("/persons", { headers: { cookie: await cookieFor("AndresL230") } }, env);
    expect(res.status).toBe(200);
    const body = await res.json() as { persons: Record<string, unknown>[] };
    expect(body.persons.length).toBeGreaterThanOrEqual(4);
    expect(Object.keys(body.persons[0]).sort()).toEqual(["avatar_url", "color", "handle", "name", "role"]);
  });
  it("401 without a session", async () => {
    expect((await app.request("/persons", {}, env)).status).toBe(401);
  });
});

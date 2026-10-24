import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/routes";
import { cookieFor } from "./helpers/persons";

describe("GET /auth/me", () => {
  it("returns handle, name, orgs, and null avatar_url when not set", async () => {
    const cookie = await cookieFor("andres");
    const res = await app.request("/auth/me", { headers: { cookie } }, env);
    expect(res.status).toBe(200);
    const body = await res.json() as { handle: string; name: string | null; avatar_url: string | null; color: string; orgs: { slug: string }[]; identities: { provider: string; label: string; linked_at: string }[] };
    expect(body.handle).toBe("andres");
    expect(body.name).toBe("andres");
    expect(body.avatar_url).toBeNull();
    expect(body.orgs.map((o) => o.slug)).toEqual(["saplinglearn"]);
    expect(body).not.toHaveProperty("org"); // the one-org fields went with the cut-over
    expect(body.color).toBe("stone");
    expect(body.identities).toEqual([{ provider: "github", label: "andres", linked_at: "2026-01-01T00:00:00Z" }]);
  });

  it("returns avatar_url when stored", async () => {
    const url = "https://avatars.githubusercontent.com/u/12345?v=4";
    const cookie = await cookieFor("jose", { avatar_url: url });
    const res = await app.request("/auth/me", { headers: { cookie } }, env);
    expect(res.status).toBe(200);
    const body = await res.json() as { handle: string; name: string | null; avatar_url: string | null; org: string };
    expect(body.handle).toBe("jose");
    expect(body.avatar_url).toBe(url);
  });

  it("returns 401 without a session cookie", async () => {
    const res = await app.request("/auth/me", {}, env);
    expect(res.status).toBe(401);
  });
});

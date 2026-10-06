import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { resolveBearerPrincipal } from "../src/auth/principal";
import { mintToken } from "../src/auth/tokens";
import { seedPerson } from "./helpers/persons";
import { platformCtx, ORG_A } from "./helpers/tenant";

const req = (auth?: string) =>
  new Request("https://x/mcp", { method: "POST", headers: auth ? { authorization: auth } : {} });

describe("resolveBearerPrincipal", () => {
  it("resolves a valid bearer to the owner principal", async () => {
    await seedPerson("real-user");
    const { raw } = await mintToken(platformCtx(), "real-user", ORG_A);
    expect(await resolveBearerPrincipal(req(`Bearer ${raw}`), env)).toEqual({ handle: "real-user" });
  });

  it("returns null when the Authorization header is missing", async () => {
    expect(await resolveBearerPrincipal(req(), env)).toBeNull();
  });

  it("returns null for an unknown token", async () => {
    expect(await resolveBearerPrincipal(req("Bearer canopy_mcp_unknown"), env)).toBeNull();
  });

  it("returns null for a revoked token", async () => {
    await seedPerson("real-user");
    const { raw } = await mintToken(platformCtx(), "real-user", ORG_A);
    await env.DB.prepare(`UPDATE mcp_tokens SET revoked = 1`).run();
    expect(await resolveBearerPrincipal(req(`Bearer ${raw}`), env)).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";

import { seedPerson } from "./helpers/persons";
import { credentialOf, mintTokenFor, ORG_A } from "./helpers/tenant";

const req = (auth?: string) =>
  new Request("https://x/mcp", { method: "POST", headers: auth ? { authorization: auth } : {} });

describe("resolveBearerCredential", () => {
  it("resolves a valid bearer to the (person, org) on its row", async () => {
    await seedPerson("real-user");
    const { raw } = await mintTokenFor("real-user");
    expect(await credentialOf(req(`Bearer ${raw}`))).toEqual({ handle: "real-user", orgId: ORG_A });
  });

  it("returns null when the Authorization header is missing", async () => {
    expect(await credentialOf(req())).toBeNull();
  });

  it("returns null for an unknown token", async () => {
    expect(await credentialOf(req("Bearer canopy_mcp_unknown"))).toBeNull();
  });

  it("returns null for a revoked token", async () => {
    await seedPerson("real-user");
    const { raw } = await mintTokenFor("real-user");
    await env.DB.prepare(`UPDATE mcp_tokens SET revoked = 1`).run();
    expect(await credentialOf(req(`Bearer ${raw}`))).toBeNull();
  });
});

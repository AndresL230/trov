import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { mintToken, resolveToken, listTokens, revokeToken } from "../src/auth/tokens";
import { sha256Hex } from "../src/auth/crypto";
import { resolveBearerPrincipal } from "../src/auth/principal";
import { app } from "../src/routes";
import { first } from "./helpers/db";
import { seedPerson, cookieFor } from "./helpers/persons";

import { platformCtx, ORG_A, ORG_B, ensureMember } from "./helpers/tenant";
describe("mcp tokens", () => {
  it("mints a prefixed token, stores only its hash, and resolves it to the owner (bumping last_used_at)", async () => {
    await seedPerson("real-user");
    const { raw } = await mintToken(platformCtx(), "real-user", ORG_A);
    expect(raw.startsWith("trov_mcp_")).toBe(true);

    expect(await resolveToken(platformCtx(), raw)).toEqual({ handle: "real-user" });

    const row = await first<{ last_used_at: string | null; token_hash: string }>(
      env.DB, `SELECT last_used_at, token_hash FROM mcp_tokens WHERE person = ?`, "real-user");
    expect(row?.last_used_at).not.toBeNull();
    expect(row?.token_hash).not.toBe(raw); // never the raw token
  });

  // The rename to Trov: new tokens start `trov_mcp_`, but a `canopy_mcp_` token already pasted into an
  // agent's config is the SAME lookup (the hash of the whole string) and must keep working.
  it("a token minted before the rename (`canopy_mcp_…`) still resolves, over /mcp's bearer path too", async () => {
    await seedPerson("real-user");
    const legacy = "canopy_mcp_minted-before-the-rename-0123456789";
    await env.DB.prepare(`INSERT INTO mcp_tokens (person, token_hash, created_at) VALUES (?, ?, ?)`).bind("real-user", await sha256Hex(legacy), "2026-09-01T00:00:00.000Z").run();
    expect(await resolveToken(platformCtx(), legacy)).toEqual({ handle: "real-user" });
    const req = new Request("https://trov.test/mcp", { headers: { authorization: `Bearer ${legacy}` } });
    expect(await resolveBearerPrincipal(req, env)).toEqual({ handle: "real-user" });
  });

  it("rejects an unknown token", async () => {
    expect(await resolveToken(platformCtx(), "canopy_mcp_unknown")).toBeNull();
  });

  it("rejects a revoked token", async () => {
    await seedPerson("real-user");
    const { raw } = await mintToken(platformCtx(), "real-user", ORG_A);
    await env.DB.prepare(`UPDATE mcp_tokens SET revoked = 1 WHERE person = ?`).bind("real-user").run();
    expect(await resolveToken(platformCtx(), raw)).toBeNull();
  });

  it("lists a person's live tokens by hint — never the hash, never the raw value — newest first", async () => {
    await seedPerson("real-user"); await seedPerson("other-user");
    const a = await mintToken(platformCtx(), "real-user", ORG_A);
    await mintToken(platformCtx(), "other-user", ORG_A);
    await env.DB.prepare(`UPDATE mcp_tokens SET created_at = '2026-01-01T00:00:00.000Z' WHERE person = 'real-user'`).run();
    const b = await mintToken(platformCtx(), "real-user", ORG_A);

    const list = await listTokens(platformCtx(), "real-user");
    expect(list.map((t) => t.hint)).toEqual([b.raw.slice(9, 13), a.raw.slice(9, 13)]);
    expect(Object.keys(list[0]).sort()).toEqual(["created_at", "hint", "id", "last_used_at"]);
    expect(list[0].last_used_at).toBeNull();
  });

  it("a token minted before the hint column lists with a null hint", async () => {
    await seedPerson("real-user");
    await env.DB.prepare(`INSERT INTO mcp_tokens (person, token_hash, created_at) VALUES ('real-user', 'legacy-hash', '2026-01-01T00:00:00.000Z')`).run();
    expect((await listTokens(platformCtx(), "real-user"))[0].hint).toBeNull();
  });

  it("revokes only the caller's own token: it stops resolving and leaves the list; someone else's id is a miss that writes nothing", async () => {
    await seedPerson("real-user"); await seedPerson("other-user");
    const mine = await mintToken(platformCtx(), "real-user", ORG_A);
    const theirs = await mintToken(platformCtx(), "other-user", ORG_A);
    const [theirRow] = await listTokens(platformCtx(), "other-user");
    const [myRow] = await listTokens(platformCtx(), "real-user");

    expect(await revokeToken(platformCtx(), "real-user", theirRow.id)).toBe(false);
    expect(await resolveToken(platformCtx(), theirs.raw)).toEqual({ handle: "other-user" });

    expect(await revokeToken(platformCtx(), "real-user", myRow.id)).toBe(true);
    expect(await resolveToken(platformCtx(), mine.raw)).toBeNull();
    expect(await listTokens(platformCtx(), "real-user")).toEqual([]);
    expect(await revokeToken(platformCtx(), "real-user", myRow.id)).toBe(true); // idempotent
  });
});

describe("GET /auth/mcp-tokens · POST /auth/mcp-tokens/:id/revoke", () => {
  const get = (cookie: string) => app.request("/auth/mcp-tokens", { headers: { cookie } }, env);
  const post = (path: string, cookie: string) => app.request(path, { method: "POST", headers: { cookie } }, env);

  it("lists the caller's tokens, revokes one, 404s on another person's id and a junk id, 401s signed out", async () => {
    const me = await cookieFor("AndresL230");
    const other = await cookieFor("priya");
    const { token } = await (await post("/auth/mcp-token", me)).json() as { token: string };
    await post("/auth/mcp-token", other);

    const { tokens } = await (await get(me)).json() as { tokens: { id: number; hint: string | null }[] };
    expect(tokens).toHaveLength(1);
    expect(tokens[0].hint).toBe(token.slice(9, 13)); // after `trov_mcp_`
    expect(JSON.stringify(tokens)).not.toContain(token);

    expect((await post(`/auth/mcp-tokens/${tokens[0].id}/revoke`, other)).status).toBe(404);
    expect((await post("/auth/mcp-tokens/nope/revoke", me)).status).toBe(404);
    expect(await resolveToken(platformCtx(), token)).toEqual({ handle: "AndresL230" });

    expect((await post(`/auth/mcp-tokens/${tokens[0].id}/revoke`, me)).status).toBe(200);
    expect(await resolveToken(platformCtx(), token)).toBeNull();
    expect(((await (await get(me)).json()) as { tokens: unknown[] }).tokens).toEqual([]);
    expect((await get("")).status).toBe(401);
  });

  it("a token is minted for the caller's org and records it; a person in no org is 409 org_required and nothing is minted", async () => {
    await seedPerson("acme-user", { member: false });
    await ensureMember("acme-user", "member", ORG_B);
    expect((await post("/auth/mcp-token", await cookieFor("acme-user", { member: false }))).status).toBe(200);
    expect((await post("/auth/mcp-token", await cookieFor("priya"))).status).toBe(200);
    const rows = async () => (await env.DB.prepare(`SELECT person, org_id FROM mcp_tokens ORDER BY person`).all<{ person: string; org_id: string }>()).results;
    expect(await rows()).toEqual([{ person: "acme-user", org_id: ORG_B }, { person: "priya", org_id: ORG_A }]);

    const res = await post("/auth/mcp-token", await cookieFor("drifter", { member: false }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "org_required" });
    expect(await rows()).toHaveLength(2);
  });
});

import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/routes";
import { first, all } from "./helpers/db";
import { sealOnboard, ONBOARD_COOKIE, type OnboardPayload } from "../src/auth/onboard";
import { createInvite } from "../src/auth/invites";
import type { PersonRow, IdentityRow, InviteRow } from "@shared/rows";

import { platformCtx } from "./helpers/tenant";
const PAYLOAD: OnboardPayload = { provider: "google", subject: "g-123", label: "priya.n@gmail.com", email: "priya.n@gmail.com", name: "Priya Natarajan", avatar_url: null, suggested_handle: "priya-n" };
const cookie = async (p = PAYLOAD) => `${ONBOARD_COOKIE}=${await sealOnboard(p, "test-cookie-secret")}`;
const post = (path: string, c: string, body: unknown) => app.request(path, { method: "POST", headers: { cookie: c, "content-type": "application/json" }, body: JSON.stringify(body) }, env);

describe("GET /auth/onboard", () => {
  it("returns the prefill without the subject; 401 without/with a bad cookie", async () => {
    const res = await app.request("/auth/onboard", { headers: { cookie: await cookie() } }, env);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({ provider: "google", label: "priya.n@gmail.com", email: "priya.n@gmail.com", name: "Priya Natarajan", avatar_url: null, suggested_handle: "priya-n" });
    expect((await app.request("/auth/onboard", {}, env)).status).toBe(401);
    expect((await app.request("/auth/onboard", { headers: { cookie: `${ONBOARD_COOKIE}=nope` } }, env)).status).toBe(401);
  });
});

describe("GET /auth/handle-check", () => {
  it("reports available / taken / invalid / reserved", async () => {
    const c = await cookie();
    const q = async (h: string) => (await (await app.request(`/auth/handle-check?handle=${h}`, { headers: { cookie: c } }, env)).json()) as { available: boolean; reason?: string };
    expect(await q("priya-n")).toEqual({ available: true });
    expect(await q("andresl230")).toEqual({ available: false, reason: "taken" });
    expect(await q("Bad")).toEqual({ available: false, reason: "invalid" });
    expect(await q("admin")).toEqual({ available: false, reason: "reserved" });
  });
});

describe("POST /auth/onboard", () => {
  it("creates person + identity, accepts the invite, sets a session, clears the cookie", async () => {
    await createInvite(platformCtx(), { email: "priya.n@gmail.com", name: "Priya", invitedBy: "AndresL230" });
    const res = await post("/auth/onboard", await cookie(), { handle: "priya", name: "Priya N", color: "plum" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, handle: "priya" });
    const setCookies = res.headers.get("set-cookie") ?? "";
    expect(setCookies).toContain("session=");
    expect(setCookies).toMatch(/onboard=;|onboard=; Max-Age=0|onboard=.*Max-Age=0/);
    const p = (await first<PersonRow>(env.DB, `SELECT * FROM persons WHERE handle = 'priya'`))!;
    expect(p.name).toBe("Priya N"); expect(p.color).toBe("plum"); expect(p.email).toBe("priya.n@gmail.com");
    expect((await first<IdentityRow>(env.DB, `SELECT * FROM identities WHERE subject = 'g-123'`))?.person).toBe("priya");
    expect((await first<InviteRow>(env.DB, `SELECT * FROM invites WHERE email = 'priya.n@gmail.com'`))?.accepted_by).toBe("priya");
    // Cut-over (Phase 3): a new person joins SaplingLearn, so their tenant routes resolve — the session works at once.
    expect(await first(env.DB, `SELECT org_id, role FROM memberships WHERE user_id = 'priya'`)).toEqual({ org_id: "org_saplinglearn", role: "member" });
    const session = /session=[^;]+/.exec(setCookies)![0];
    expect((await app.request("/docs", { headers: { cookie: session } }, env)).status).toBe(200);
  });
  it("400 on an invalid handle/color; 409 on a taken handle (cookie kept)", async () => {
    const c = await cookie();
    expect((await post("/auth/onboard", c, { handle: "Bad", name: "x", color: "plum" })).status).toBe(400);
    expect((await post("/auth/onboard", c, { handle: "okay", name: "x", color: "neon" })).status).toBe(400);
    const taken = await post("/auth/onboard", c, { handle: "andresl230", name: "x", color: "plum" });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual({ error: "handle_taken" });
    expect(taken.headers.get("set-cookie") ?? "").not.toContain("onboard=;");
  });
  it("a Google account needs no invite: a revoked one creates the person, in no org", async () => {
    await createInvite(platformCtx(), { email: "priya.n@gmail.com", name: null, invitedBy: "AndresL230" });
    await env.DB.prepare(`UPDATE invites SET revoked_at = 't' WHERE email = 'priya.n@gmail.com'`).run();
    const res = await post("/auth/onboard", await cookie(), { handle: "priya", name: "x", color: "plum" });
    expect(res.status).toBe(200);
    expect(await first(env.DB, `SELECT 1 AS x FROM persons WHERE handle = 'priya'`)).not.toBeNull();
    expect(await first(env.DB, `SELECT 1 AS x FROM memberships WHERE user_id = 'priya'`)).toBeNull();
  });
  it("a GitHub payload onboards without any invite", async () => {
    const res = await post("/auth/onboard", await cookie({ ...PAYLOAD, provider: "github", subject: "newdev", label: "newdev" }), { handle: "newdev", name: "New", color: "sky" });
    expect(res.status).toBe(200);
  });
  it("replaying a GitHub onboard cookie after success is refused; no orphan persons row", async () => {
    const ghCookie = await cookie({ ...PAYLOAD, provider: "github", subject: "replay-dev", label: "replay-dev" });
    const first1 = await post("/auth/onboard", ghCookie, { handle: "replaydev", name: "Replay", color: "sky" });
    expect(first1.status).toBe(200);
    const replay = await post("/auth/onboard", ghCookie, { handle: "replaydev2", name: "Replay2", color: "sky" });
    expect(replay.status).toBe(409);
    expect(await replay.json()).toEqual({ error: "already_onboarded" });
    expect(replay.headers.get("set-cookie") ?? "").toMatch(/onboard=;|onboard=.*Max-Age=0/);
    const rows = await all<PersonRow>(env.DB, `SELECT handle FROM persons WHERE handle IN ('replaydev','replaydev2')`);
    expect(rows).toEqual([{ handle: "replaydev" }]);
  });
});

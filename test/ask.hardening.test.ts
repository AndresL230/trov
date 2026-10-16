// Two Ask backend fixes found by the e2e prep: the composer's allowance is the cap the gate enforces (a gifted Pro's
// is × its members — handoff #12 §2.1), and no Ask route answers a malformed ref or id with a 500 (CLAUDE.md
// invariant 7): an undecodable ref is the same 404 as an unknown one, a bad id the routes' own 404 / 400.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { first, run } from "./helpers/db";
import { cookieFor } from "./helpers/persons";
import { ORG_A } from "./helpers/tenant";
import { BASE, call } from "./helpers/ask";

const ME = "ask-hardener";
const members = async () => (await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM memberships WHERE org_id = ?`, ORG_A))!.n;

describe("GET /ask/state: the allowance is the cap the gate enforces", () => {
  it("a Pro with no paid-seat count (gifted) is 300 × its members; paid seats multiply instead; an override is the whole cap", async () => {
    const cookie = await cookieFor(ME);
    await run(env.DB, `UPDATE orgs SET plan = 'team', plan_source = 'granted', plan_status = 'active', plan_overrides = '{}' WHERE id = ?`, ORG_A);
    const n = await members();
    expect(n).toBeGreaterThan(1);
    const gifted = await call("GET", `${BASE}/ask/state`, cookie);
    expect(gifted.status).toBe(200);
    expect(gifted.json.allowance.cap).toBe(300 * n);

    await run(env.DB, `UPDATE orgs SET plan_source = 'billing', plan_overrides = ? WHERE id = ?`, JSON.stringify({ seats: 4 }), ORG_A);
    expect((await call("GET", `${BASE}/ask/state`, cookie)).json.allowance.cap).toBe(1200);

    await run(env.DB, `UPDATE orgs SET plan_source = 'granted', plan_overrides = ? WHERE id = ?`, JSON.stringify({ ai_chat: 500 }), ORG_A);
    expect((await call("GET", `${BASE}/ask/state`, cookie)).json.allowance.cap).toBe(500);
  });
});

describe("no Ask route answers a malformed ref or id with a 500", () => {
  it("GET /ask/item: an undecodable or malformed ref is the same 404 as an unknown one", async () => {
    const cookie = await cookieFor(ME);
    for (const ref of ["%25", "%E0%A4%A", "%25E0", "ticket%3Aabc", "ticket%3A99999999999999999999", "pr%3A1.5", "repo%3Aa%2Fb%2Fc", "person%3A", "x", "doc%3A..%2F..%2Fsecret"]) {
      const r = await call("GET", `${BASE}/ask/item/${ref}`, cookie);
      expect(r.status, ref).toBe(404);
      expect(r.json.hidden, ref).toBe(true);
    }
  });

  it("POST /ask/peek: a ref of the right shape that names nothing is hidden; a malformed one is 400 invalid", async () => {
    const cookie = await cookieFor(ME);
    const shaped = await call("POST", `${BASE}/ask/peek`, cookie, { refs: ["ticket:abc", "ticket:99999999999999999999", "pr:1.5", "repo:a/b/c", "doc:x..y", "sprint:0"] });
    expect(shaped.status).toBe(200);
    expect(shaped.json.items.every((i: { hidden?: boolean }) => i.hidden === true)).toBe(true);
    for (const bad of ["%", "%E0%A4%A", "person:", "x", "doc:../../secret"]) {
      const r = await call("POST", `${BASE}/ask/peek`, cookie, { refs: [bad] });
      expect(r.status, bad).toBe(400);
      expect(r.json.error, bad).toBe("invalid");
    }
  });

  it("every route that takes an id: a malformed one is a 4xx", async () => {
    const cookie = await cookieFor(ME);
    const routes: [string, string, unknown?][] = [
      ["GET", "/ask/threads/:id"], ["PATCH", "/ask/threads/:id", { pinned: true }], ["DELETE", "/ask/threads/:id"],
      ["POST", "/ask/threads/:id/stop"], ["GET", "/ask/threads/:id/export"], ["POST", "/ask/threads/:id/save", { title: "x", kind: "markdown", visibility: "private" }],
      ["POST", "/ask/messages/:id/save-form", {}], ["POST", "/ask/messages/:id/wrong", { reason: "missed" }],
      ["POST", "/ask/actions/:id/confirm", {}], ["POST", "/ask/actions/:id/cancel", {}], ["POST", "/ask/actions/:id/undo", {}],
    ];
    for (const [method, path, body] of routes) {
      for (const id of ["%25", "%E0%A4%A", "abc", "0", "-1", "1e3", "99999999999999999999"]) {
        const r = await call(method, `${BASE}${path.replace(":id", id)}`, cookie, body);
        expect(r.status, `${method} ${path} ${id}`).toBeGreaterThanOrEqual(400);
        expect(r.status, `${method} ${path} ${id}`).toBeLessThan(500);
      }
    }
  });
});

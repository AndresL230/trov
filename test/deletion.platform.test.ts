/**
 * A superadmin deletes an organization or an account from Platform (src/platform/routes.ts) — through the SAME
 * cores as the owner's and the person's own deletions (src/deletion/). No membership is needed for an org;
 * an account keeps every guard rail that protects other people, and a superadmin's account (another's, or
 * one's own) is never deleted from here. Everyone else gets the Platform surface's one 404.
 */
import { describe, it, expect } from "vitest";
import type { AccountDeletionPreview, OrgDeletionPreview } from "@shared/deletion-core";
import { isTombstoneHandle } from "@shared/deletion-core";
import { call, exec, one, rows, SUPERADMIN } from "./helpers/orgs";
import { cookieFor, seedPerson } from "./helpers/persons";
import { ORG_A, ORG_B, ensureMember } from "./helpers/tenant";
import { fillOrg, newOrg, orgDigest, orgRowCounts } from "./helpers/deletion";
import { deletionRef } from "../src/deletion/person";

const T = "2026-10-01T00:00:00.000Z";
const root = () => cookieFor(SUPERADMIN);

describe("Platform › delete an organization", () => {
  it("a superadmin who is NOT a member deletes it; the audit names them; the other orgs are untouched", async () => {
    const id = await newOrg("olive", "doomed");
    await fillOrg(id, "olive", "DOOMED");
    expect(await one(`SELECT 1 AS x FROM memberships WHERE org_id = ? AND user_id = ?`, id, SUPERADMIN)).toBeNull();
    const keepA = await orgDigest(ORG_A), keepB = await orgDigest(ORG_B);
    const cookie = await root();
    const preview = await call<OrgDeletionPreview>("GET", "/api/platform/orgs/doomed/deletion", cookie);
    expect(preview.json).toMatchObject({ org: { slug: "doomed" }, members: 1, confirm: "doomed" });
    expect((await call("POST", "/api/platform/orgs/doomed/delete", cookie, { confirm: "nope" })).status).toBe(400);
    expect(await call("POST", "/api/platform/orgs/doomed/delete", cookie, { confirm: "doomed" })).toEqual({ status: 200, json: { ok: true, slug: "doomed" } });
    expect(Object.values(await orgRowCounts(id)).every((n) => n === 0)).toBe(true);
    expect(await one(`SELECT 1 AS x FROM orgs WHERE id = ?`, id)).toBeNull();
    expect(await orgDigest(ORG_A)).toEqual(keepA);
    expect(await orgDigest(ORG_B)).toEqual(keepB);
    expect(await rows(`SELECT org_id, actor, target, detail FROM org_admin_audit WHERE action = 'org.delete'`))
      .toEqual([{ org_id: null, actor: SUPERADMIN, target: "doomed", detail: JSON.stringify({ by: "platform", members: 1 }) }]);
    // …and it is in the Platform audit list, as a platform row.
    const audit = await call<{ audit: { action: string; org: string | null; target: string }[] }>("GET", "/api/platform/audit", cookie);
    expect(audit.json.audit.find((a) => a.action === "org.delete")).toMatchObject({ org: null, target: "doomed" });
  });

  it("anyone else — an owner of it included — gets the Platform surface's 404, and nothing is deleted", async () => {
    const id = await newOrg("olive", "doomed");
    for (const who of ["olive", "stranger"]) {
      const c = await cookieFor(who, { member: false });
      expect(await call("GET", "/api/platform/orgs/doomed/deletion", c)).toEqual({ status: 404, json: { error: "not_found" } });
      expect(await call("POST", "/api/platform/orgs/doomed/delete", c, { confirm: "doomed" })).toEqual({ status: 404, json: { error: "not_found" } });
      expect(await call("POST", "/api/platform/persons/olive/delete", c, { confirm: "olive" })).toEqual({ status: 404, json: { error: "not_found" } });
    }
    // A superadmin's request carrying a token is refused too (cookie only).
    expect((await call("POST", "/api/platform/orgs/doomed/delete", await root(), { confirm: "doomed" }, { headers: { authorization: "Bearer x" } })).status).toBe(403);
    expect(await one(`SELECT id FROM orgs WHERE id = ?`, id)).toEqual({ id });
  });

  it("an unknown slug is 404", async () => {
    expect((await call("POST", "/api/platform/orgs/nope/delete", await root(), { confirm: "nope" })).status).toBe(404);
  });
});

describe("Platform › delete an account", () => {
  it("deletes it like the person would (content de-identified), recorded with the superadmin as actor and the tombstone as target", async () => {
    await seedPerson("gone-soon", { member: false });
    await ensureMember("gone-soon", "member", ORG_A);
    await exec(`INSERT INTO feed (org_id, author, summary, body, artifacts, created_at) VALUES (?, 'gone-soon', 'hello', 'b', '[]', ?)`, ORG_A, T);
    const cookie = await root();
    const preview = await call<AccountDeletionPreview>("GET", "/api/platform/persons/gone-soon/deletion", cookie);
    expect(preview.json).toMatchObject({ handle: "gone-soon", blockers: [], leaves: [{ slug: "saplinglearn", role: "member" }], confirm: "gone-soon" });
    expect((await call("POST", "/api/platform/persons/gone-soon/delete", cookie, { confirm: "gone" })).status).toBe(400);
    const res = await call<{ ok: boolean; orgs_deleted: string[] }>("POST", "/api/platform/persons/gone-soon/delete", cookie, { confirm: "gone-soon" });
    expect(res).toEqual({ status: 200, json: { ok: true, orgs_deleted: [] } });
    expect(await one(`SELECT 1 AS x FROM persons WHERE handle = 'gone-soon'`)).toBeNull();
    const author = (await one<{ author: string }>(`SELECT author FROM feed WHERE summary = 'hello'`))!.author;
    expect(isTombstoneHandle(author)).toBe(true);
    expect(await rows(`SELECT actor, target, detail FROM org_admin_audit WHERE action = 'person.delete'`))
      .toEqual([{ actor: SUPERADMIN, target: author, detail: JSON.stringify({ by: "platform", ref: await deletionRef("test-cookie-secret", "gone-soon") }) }]);
    // A tombstone, or a handle nobody has, is not an account.
    expect((await call("GET", `/api/platform/persons/${author}/deletion`, cookie)).status).toBe(404);
    expect((await call("GET", "/api/platform/persons/nobody-here/deletion", cookie)).status).toBe(404);
  });

  it("keeps the guard rails that protect other people — naming the org — and the superadmin can delete that org first", async () => {
    const id = await newOrg("olive", "olives");
    await seedPerson("pip", { member: false });
    await exec(`INSERT INTO memberships (org_id, user_id, role, created_at, created_by) VALUES (?, 'pip', 'member', ?, 'seed')`, id, T);
    const cookie = await root();
    const preview = (await call<AccountDeletionPreview>("GET", "/api/platform/persons/olive/deletion", cookie)).json;
    expect(preview.blockers).toEqual([{ code: "last_owner", org: { slug: "olives", name: "olives org" }, message: expect.stringMatching(/@olive is the only owner of olives org \(olives\)/) }]);
    const refused = await call<{ error: string; blockers: { code: string; org: { slug: string } }[] }>("POST", "/api/platform/persons/olive/delete", cookie, { confirm: "olive" });
    expect(refused.status).toBe(409);
    expect(refused.json.blockers.map((b) => b.org.slug)).toEqual(["olives"]);
    expect(await one(`SELECT handle FROM persons WHERE handle = 'olive'`)).toEqual({ handle: "olive" });
    // The org first, then the person.
    expect((await call("POST", "/api/platform/orgs/olives/delete", cookie, { confirm: "olives" })).status).toBe(200);
    expect((await call("POST", "/api/platform/persons/olive/delete", cookie, { confirm: "olive" })).status).toBe(200);
  });

  it("an organization nobody else is in goes with the account here too, named in the preview", async () => {
    const id = await newOrg("olive", "olivesolo");
    const cookie = await root();
    expect((await call<AccountDeletionPreview>("GET", "/api/platform/persons/olive/deletion", cookie)).json.deletes).toEqual([{ slug: "olivesolo", name: "olivesolo org", paid: false }]);
    expect((await call<{ orgs_deleted: string[] }>("POST", "/api/platform/persons/olive/delete", cookie, { confirm: "olive" })).json.orgs_deleted).toEqual(["olivesolo"]);
    expect(await one(`SELECT 1 AS x FROM orgs WHERE id = ?`, id)).toBeNull();
  });

  it("never another superadmin's account, and never one's own: both are refused with the reason", async () => {
    await seedPerson("root2", { member: false });
    await exec(`INSERT INTO platform_admins (person, granted_at, granted_by) VALUES ('root2', ?, ?)`, T, SUPERADMIN);
    const cookie = await root();
    const other = await call<{ error: string; blockers: { code: string }[] }>("POST", "/api/platform/persons/root2/delete", cookie, { confirm: "root2" });
    expect(other.status).toBe(409);
    expect(other.json.blockers.map((b) => b.code)).toEqual(["superadmin"]);
    const self = await call<{ error: string; blockers: { code: string }[] }>("POST", `/api/platform/persons/${SUPERADMIN}/delete`, cookie, { confirm: SUPERADMIN });
    expect(self.status).toBe(409);
    expect(self.json.blockers.map((b) => b.code)).toContain("self");
    expect(await one(`SELECT COUNT(*) AS n FROM persons WHERE handle IN ('root2', ?)`, SUPERADMIN)).toEqual({ n: 2 });
  });
});

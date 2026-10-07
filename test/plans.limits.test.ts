/**
 * Plans and their limits (0044_plans, docs/architecture/plans.md): the resolution of an org's entitlements,
 * and EVERY enforcement point at and over its cap — seats (an invitation created, one accepted, the
 * superadmin's owner, the legacy invite alias), repositories, environments, stored artifact bytes and a
 * person's agent connections — each refused with the one 402 `plan_limit` body, and none deleting anything.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { cookieFor } from "./helpers/persons";
import { ensureMember, ORG_A, ORG_B, platformCtx, tenantCtx } from "./helpers/tenant";
import { call, one, rows, exec, SUPERADMIN } from "./helpers/orgs";
import { app } from "../src/routes";
import {
  PLANS, PLAN_IDS, LIMIT_KEYS, resolveEntitlements, parseOverrides, storedOverrides, planRefusal, planRefusalSentence, formatLimit, formatUse, overLimits,
  type OrgPlanView, type PlanRefusal,
} from "@shared/plans";
import type { PlatformOrgRow } from "@shared/orgs";
import { PlanLimitError, setOrgPlan, setOrgPlanStatus, markOrgPastDue, cancelOrgPlan, orgPlan } from "../src/plans/state";
import { createPage, addTextVersion, mintUploadToken } from "../src/tools/artifacts";
import { issueAuthorization, registerClient, checkAuthorizeRequest } from "../src/auth/oauth";
import { buildTrovMcpServer } from "../src/mcp";

const boss = () => cookieFor(SUPERADMIN);
const loner = (handle: string) => cookieFor(handle, { member: false });
const orgId = async (slug: string) => (await one<{ id: string }>(`SELECT id FROM orgs WHERE slug = ?`, slug))!.id;
const count = async (sql: string, ...p: unknown[]) => (await one<{ n: number }>(sql, ...p))!.n;
const members = (org: string) => count(`SELECT COUNT(*) AS n FROM memberships WHERE org_id = ?`, org);
const pending = (org: string) => count(`SELECT COUNT(*) AS n FROM org_invites WHERE org_id = ? AND status = 'pending'`, org);

/** An org made by the superadmin on `plan`, owned by `owner` (created if missing). Returns the owner's cookie and the org id. */
async function orgOn(plan: string, slug: string, owner = `${slug}-owner`, overrides?: Record<string, number | null>) {
  const cookie = await loner(owner);
  const r = await call("POST", "/api/platform/orgs", await boss(), { slug, name: slug, admin: { handle: owner }, plan, overrides });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return { cookie, id: await orgId(slug), owner };
}
const invite = (slug: string, cookie: string, n: number) => call<PlanRefusal>("POST", `/api/o/${slug}/invites`, cookie, { github_login: `dev-${slug}-${n}` });

describe("entitlements — the plan's defaults with the org's overrides on top", () => {
  it("the three plans: personal is one person, team is ten, enterprise's seats are unlimited", () => {
    expect(PLAN_IDS).toEqual(["personal", "team", "enterprise"]);
    expect(resolveEntitlements("personal").seats).toBe(1);
    expect(resolveEntitlements("team").seats).toBe(10);
    expect(resolveEntitlements("enterprise").seats).toBeNull();
    for (const id of PLAN_IDS) {
      expect(Object.keys(PLANS[id].entitlements).sort()).toEqual([...LIMIT_KEYS].sort());
      expect(PLANS[id]).toMatchObject({ id, billing: null }); // no price in this branch
      expect(PLANS[id].name).toBeTruthy();
      expect(PLANS[id].description).toBeTruthy();
    }
  });

  it("an override replaces one limit and leaves the rest; null is unlimited; an absent key is the plan's", () => {
    expect(resolveEntitlements("team", { seats: 25 })).toEqual({ ...PLANS.team.entitlements, seats: 25 });
    expect(resolveEntitlements("team", { seats: null, repositories: 2 })).toEqual({ ...PLANS.team.entitlements, seats: null, repositories: 2 });
    expect(resolveEntitlements("enterprise", { seats: 40 }).seats).toBe(40);
    expect(resolveEntitlements("personal", {})).toEqual(PLANS.personal.entitlements);
  });

  it("an unknown plan id resolves to the smallest plan — a bad value can only make an org smaller", () => {
    expect(resolveEntitlements("platinum")).toEqual(PLANS.personal.entitlements);
    expect(resolveEntitlements(null)).toEqual(PLANS.personal.entitlements);
  });

  it("overrides are validated whole: an unknown key, a fraction, a negative, a seat cap of 0 are refused", () => {
    expect(parseOverrides({ seats: 12, artifact_bytes: null })).toEqual({ seats: 12, artifact_bytes: null });
    expect(parseOverrides(undefined)).toEqual({});
    for (const bad of [{ seat: 3 }, { seats: 1.5 }, { seats: -1 }, { seats: 0 }, { seats: "10" }, [], "x", { repositories: -2 }]) expect(parseOverrides(bad), JSON.stringify(bad)).toBeNull();
    expect(parseOverrides({ repositories: 0 })).toEqual({ repositories: 0 });
    // A stored value that does not parse reads as "no overrides", never as unlimited.
    expect(storedOverrides("{not json")).toEqual({});
    expect(storedOverrides(`{"seats":"many"}`)).toEqual({});
  });

  it("planRefusal: under the cap nothing, at it the typed refusal; unlimited never refuses; canceled always does", () => {
    const team = { plan: "team" as const, overrides: {}, status: "active" as const };
    expect(planRefusal(team, "seats", 9)).toBeNull();
    expect(planRefusal(team, "seats", 10)).toEqual({
      error: "plan_limit", limit: "seats", used: 10, cap: 10, plan: "team", status: "active",
      message: "This organization has reached the 10 seats its Team plan includes.",
    });
    expect(planRefusal(team, "seats", 14)).toMatchObject({ used: 14, cap: 10 }); // over: still just "no more"
    expect(planRefusal({ ...team, overrides: { seats: 11 } }, "seats", 10)).toBeNull();
    expect(planRefusal({ plan: "enterprise", overrides: {}, status: "active" }, "seats", 100000)).toBeNull();
    expect(planRefusal(team, "artifact_bytes", 0, 6 * 1024 ** 3)).toMatchObject({ limit: "artifact_bytes", message: "This organization has reached the 5 GB of artifact storage its Team plan includes." });
    expect(planRefusal(team, "agent_connections", 10)).toMatchObject({ message: "You have reached the 10 agent connections per person this organization's Team plan includes." });
    expect(planRefusal({ ...team, status: "past_due" }, "seats", 9)).toBeNull();
    expect(planRefusal({ ...team, status: "canceled" }, "seats", 1)).toMatchObject({ status: "canceled", message: expect.stringContaining("has ended") });
    expect(planRefusal({ plan: "enterprise", overrides: {}, status: "canceled" }, "seats", 3)).toMatchObject({ cap: 3 });
  });

  it("a one-person plan refuses an invitation in words that name the plan that allows them", () => {
    const r = planRefusal({ plan: "personal", overrides: {}, status: "active" }, "seats", 1)!;
    expect(r.message).toBe("The Personal plan is for one person. Invitations start with the Team plan.");
    expect(planRefusalSentence(r, "owner")).toBe(`${r.message} Ask Trov to change your plan.`);
    expect(planRefusalSentence(r, "admin")).toBe(`${r.message} Ask one of this organization's owners.`);
  });

  it("formats a limit and its use; names the limits an org is over", () => {
    expect(formatLimit("seats", null)).toBe("Unlimited");
    expect(formatLimit("artifact_bytes", 5 * 1024 ** 3)).toBe("5 GB");
    expect(formatUse("seats", 7, 10)).toBe("7 of 10");
    expect(formatUse("seats", 7, null)).toBe("7");
    expect(overLimits(PLANS.personal.entitlements, { seats: 4, repositories: 1, environments: 3 })).toEqual(["seats", "environments"]);
  });
});

describe("seats — an invitation reserves one", () => {
  it("a Team org invites up to ten seats and is refused the eleventh with the one 402 body; nothing is written", async () => {
    const { cookie, id } = await orgOn("team", "tenco");
    for (let n = 1; n <= 9; n++) expect((await invite("tenco", cookie, n)).status, `invite ${n}`).toBe(201);
    expect([await members(id), await pending(id)]).toEqual([1, 9]);
    const audit = await count(`SELECT COUNT(*) AS n FROM org_admin_audit WHERE org_id = ?`, id);

    const r = await invite("tenco", cookie, 10);
    expect(r.status).toBe(402);
    expect(r.json).toEqual({
      error: "plan_limit", limit: "seats", used: 10, cap: 10, plan: "team", status: "active",
      message: "This organization has reached the 10 seats its Team plan includes.",
    });
    expect([await members(id), await pending(id)]).toEqual([1, 9]);
    expect(await count(`SELECT COUNT(*) AS n FROM org_admin_audit WHERE org_id = ?`, id)).toBe(audit);
    // An e-mail invitation is refused the same way, and nothing is mailed.
    expect((await call("POST", "/api/o/tenco/invites", cookie, { email: "late@x.io" })).status).toBe(402);
    expect(await count(`SELECT COUNT(*) AS n FROM notification_outbox_bodies`)).toBe(0);
    // Revoking one frees its seat.
    const first = (await one<{ id: number }>(`SELECT id FROM org_invites WHERE org_id = ? ORDER BY id LIMIT 1`, id))!.id;
    expect((await call("POST", `/api/o/tenco/invites/${first}/revoke`, cookie, {})).status).toBe(200);
    expect((await invite("tenco", cookie, 11)).status).toBe(201);
  });

  it("a Personal org refuses invitations outright, in a sentence that says which plan allows them", async () => {
    const { cookie, id } = await orgOn("personal", "solo");
    const r = await invite("solo", cookie, 1);
    expect(r.status).toBe(402);
    expect(r.json).toMatchObject({ error: "plan_limit", limit: "seats", used: 1, cap: 1, plan: "personal", message: "The Personal plan is for one person. Invitations start with the Team plan." });
    expect(await pending(id)).toBe(0);
    // …by the legacy alias too (a person with exactly one org), through the same gate.
    const legacy = await call("POST", "/invites", cookie, { email: "old-path@x.io", name: "Old Path" });
    expect([legacy.status, legacy.json.error]).toEqual([402, "plan_limit"]);
    expect(await pending(id)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM invites WHERE email = 'old-path@x.io'`)).toBe(0);
  });

  it("an existing org (Enterprise, from before plans) has no seat cap", async () => {
    const cookie = await cookieFor("boss-b", { member: false });
    await ensureMember("boss-b", "owner", ORG_B);
    for (let n = 1; n <= 14; n++) expect((await invite("acme", cookie, n)).status).toBe(201);
    expect(await pending(ORG_B)).toBe(14);
    expect(await orgPlan(platformCtx(), ORG_A)).toMatchObject({ plan: "enterprise", overrides: {}, status: "active", source: "granted" });
  });

  it("two invitations racing for the last seat: one is written", async () => {
    const { cookie, id } = await orgOn("team", "racers", "racers-owner", { seats: 2 });
    const [a, b] = await Promise.all([invite("racers", cookie, 1), invite("racers", cookie, 2)]);
    expect([a.status, b.status].sort()).toEqual([201, 402]);
    expect(await pending(id)).toBe(1);
  });
});

describe("seats — accepting an invitation", () => {
  /** A Team org with its owner and two pending invitations, then its seats cut to 2: full once ONE more person joins. */
  async function lastSeat() {
    const { cookie, id } = await orgOn("team", "lastseat");
    const ann = await loner("ann"), ben = await loner("ben");
    for (const login of ["ann", "ben"]) expect((await call("POST", "/api/o/lastseat/invites", cookie, { github_login: login })).status).toBe(201);
    await setOrgPlan(platformCtx(SUPERADMIN), "lastseat", { plan: "team", overrides: { seats: 2 } });
    const idOf = async (login: string) => (await one<{ id: number }>(`SELECT id FROM org_invites WHERE org_id = ? AND github_login = ?`, id, login))!.id;
    return { id, ann, ben, annInvite: await idOf("ann"), benInvite: await idOf("ben") };
  }

  it("two accepts for the last seat: one joins, the other is refused and its invitation stays pending", async () => {
    const fx = await lastSeat();
    const [a, b] = await Promise.all([
      call<PlanRefusal>("POST", `/api/invites/${fx.annInvite}/accept`, fx.ann, {}),
      call<PlanRefusal>("POST", `/api/invites/${fx.benInvite}/accept`, fx.ben, {}),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 402]);
    const lost = a.status === 402 ? a : b;
    expect(lost.json).toMatchObject({ error: "plan_limit", limit: "seats", used: 2, cap: 2, plan: "team" });
    expect(await members(fx.id)).toBe(2);
    expect(await rows(`SELECT status FROM org_invites WHERE org_id = ? ORDER BY status`, fx.id)).toEqual([{ status: "accepted" }, { status: "pending" }]);
    // The audit trail records ONE join, not two.
    expect(await count(`SELECT COUNT(*) AS n FROM org_admin_audit WHERE org_id = ? AND action = 'invite.accept'`, fx.id)).toBe(1);
  });

  it("accepting within the cap works; declining is never refused; a member's second invitation takes no seat", async () => {
    const fx = await lastSeat();
    expect((await call("POST", `/api/invites/${fx.annInvite}/accept`, fx.ann, {})).status).toBe(200);
    expect((await call("POST", `/api/invites/${fx.benInvite}/accept`, fx.ben, {})).status).toBe(402);
    expect((await call("POST", `/api/invites/${fx.benInvite}/decline`, fx.ben, {})).status).toBe(200);
    // ann, already a member of a full org, is named an owner by an invitation: lifted, no seat needed.
    await exec(`INSERT INTO org_invites (org_id, github_login, role, as_owner, invited_by, status, created_at) VALUES (?, 'ann', 'admin', 1, ?, 'pending', '2026-10-06T00:00:00Z')`, fx.id, SUPERADMIN);
    const again = (await one<{ id: number }>(`SELECT id FROM org_invites WHERE org_id = ? AND github_login = 'ann' AND status = 'pending'`, fx.id))!.id;
    expect((await call("POST", `/api/invites/${again}/accept`, fx.ann, {})).json).toMatchObject({ ok: true, role: "owner" });
    expect(await members(fx.id)).toBe(2);
  });
});

describe("seats — the superadmin adding an owner", () => {
  it("a new owner needs a free seat (by handle and by address); lifting a member or upgrading an invitation does not", async () => {
    const { id, cookie } = await orgOn("team", "rescue", "rescue-owner", { seats: 2 });
    await loner("helper"); await loner("extra");
    const root = await boss();
    expect((await invite("rescue", cookie, 1)).status).toBe(201); // 1 member + 1 pending = full

    const byHandle = await call<PlanRefusal>("POST", "/api/platform/orgs/rescue/admin", root, { handle: "extra" });
    expect([byHandle.status, byHandle.json.limit, byHandle.json.cap]).toEqual([402, "seats", 2]);
    const byMail = await call("POST", "/api/platform/orgs/rescue/admin", root, { email: "new-owner@x.io" });
    expect([byMail.status, byMail.json.error]).toEqual([402, "plan_limit"]);
    expect([await members(id), await pending(id)]).toEqual([1, 1]);
    expect(await count(`SELECT COUNT(*) AS n FROM org_admin_audit WHERE org_id = ? AND target = 'owner-invite'`, id)).toBe(0);

    // The pending invitation is upgraded to an owner's — its seat is already reserved.
    const up = await call("POST", "/api/platform/orgs/rescue/admin", root, { github_login: "dev-rescue-1" });
    expect(up.json).toMatchObject({ ok: true, admin: { status: "invited" } });
    expect(await one(`SELECT as_owner FROM org_invites WHERE org_id = ? AND status = 'pending'`, id)).toEqual({ as_owner: 1 });
    // A current member is lifted to owner in a full org.
    await exec(`UPDATE org_invites SET status = 'revoked' WHERE org_id = ?`, id);
    await ensureMember("helper", "member", id);
    expect([await members(id), await pending(id)]).toEqual([2, 0]);
    expect((await call("POST", "/api/platform/orgs/rescue/admin", root, { handle: "helper" })).json).toMatchObject({ admin: { status: "owner", handle: "helper" } });
    expect(await members(id)).toBe(2);
  });
});

describe("repositories and environments", () => {
  it("a Personal org connects one repository; promoting the one it has is not an addition", async () => {
    const { cookie } = await orgOn("personal", "onerepo");
    expect((await call("POST", "/api/o/onerepo/repos", cookie, { repo_full_name: "acme/one" })).status).toBe(201);
    const r = await call<PlanRefusal>("POST", "/api/o/onerepo/repos", cookie, { repo_full_name: "acme/two" });
    expect(r.status).toBe(402);
    expect(r.json).toEqual({
      error: "plan_limit", limit: "repositories", used: 1, cap: 1, plan: "personal", status: "active",
      message: "This organization has reached the 1 repository its Personal plan includes.",
    });
    expect((await call("POST", "/api/o/onerepo/repos", cookie, { repo_full_name: "acme/one", is_primary: true })).status).toBeLessThan(300);
    expect(await count(`SELECT COUNT(*) AS n FROM org_repos WHERE org_id = (SELECT id FROM orgs WHERE slug = 'onerepo')`)).toBe(1);
  });

  it("a Personal org adds two environments; a third is refused, an edit of one it has is not", async () => {
    const { cookie } = await orgOn("personal", "twoenv");
    for (const key of ["staging", "production"]) expect((await call("PUT", `/api/o/twoenv/environments/${key}`, cookie, { branch: "main" })).status).toBeLessThan(300);
    const r = await call<PlanRefusal>("PUT", "/api/o/twoenv/environments/preview", cookie, { branch: "main" });
    expect([r.status, r.json.limit, r.json.used, r.json.cap]).toEqual([402, "environments", 2, 2]);
    expect((await call("PUT", "/api/o/twoenv/environments/staging", cookie, { label: "Staging" })).status).toBeLessThan(300);
  });

  it("an Enterprise org keeps the caps from before plans (10 each) unless the superadmin overrides them", async () => {
    const { cookie } = await orgOn("enterprise", "bigco");
    for (let n = 1; n <= 10; n++) expect((await call("POST", "/api/o/bigco/repos", cookie, { repo_full_name: `bigco/r${n}` })).status).toBe(201);
    expect((await call("POST", "/api/o/bigco/repos", cookie, { repo_full_name: "bigco/r11" })).status).toBe(402);
    await setOrgPlan(platformCtx(SUPERADMIN), "bigco", { plan: "enterprise", overrides: { repositories: 12 } });
    expect((await call("POST", "/api/o/bigco/repos", cookie, { repo_full_name: "bigco/r11" })).status).toBe(201);
  });
});

describe("stored artifact bytes", () => {
  it("a write past the org's storage is refused — over HTTP (402), at the upload link, in the repository and as an MCP tool error", async () => {
    const { cookie, id, owner } = await orgOn("team", "smallbox", "smallbox-owner", { artifact_bytes: 40 });
    const ok = await call<{ slug: string }>("POST", "/api/o/smallbox/artifacts", cookie, { title: "Fits", kind: "markdown", area: "auth", content: "x".repeat(30) });
    expect(ok.status).toBeLessThan(300);

    const over = await call<PlanRefusal>("POST", "/api/o/smallbox/artifacts", cookie, { title: "Too big", kind: "markdown", area: "auth", content: "y".repeat(20) });
    expect(over.status).toBe(402);
    expect(over.json).toMatchObject({ error: "plan_limit", limit: "artifact_bytes", used: 30, cap: 40, plan: "team" });
    const version = await call("POST", `/api/o/smallbox/artifacts/${ok.json.slug}/versions`, cookie, { content: "z".repeat(20) });
    expect([version.status, version.json.error]).toEqual([402, "plan_limit"]);
    const link = await call("POST", "/api/o/smallbox/artifacts/upload-url", cookie, { kind: "file", title: "Bin", area: "auth", size_bytes: 500, sha256: "a".repeat(64), filename: "a.bin" });
    expect([link.status, link.json.error]).toEqual([402, "plan_limit"]);
    expect(await count(`SELECT COUNT(*) AS n FROM artifact_pages WHERE org_id = ?`, id)).toBe(1);
    expect(await count(`SELECT COUNT(*) AS n FROM artifact_upload_tokens WHERE org_id = ?`, id)).toBe(0);

    const ctx = await tenantCtx(owner, undefined, { orgId: id, via: "bearer" });
    await expect(createPage(ctx, { title: "Repo", kind: "markdown", area: "auth", content: "w".repeat(20) }, owner)).rejects.toBeInstanceOf(PlanLimitError);
    await expect(addTextVersion(ctx, ok.json.slug, { content: "v".repeat(20) }, owner)).rejects.toBeInstanceOf(PlanLimitError);
    await expect(mintUploadToken(ctx, { kind: "file", title: "B", area: "auth", size_bytes: 11, sha256: "b".repeat(64), filename: "b.bin" }, owner)).rejects.toBeInstanceOf(PlanLimitError);
    // A version that fits still lands (30 + 10 = 40).
    expect((await addTextVersion(ctx, ok.json.slug, { content: "u".repeat(10) }, owner)).unchanged).toBe(false);

    // The MCP spelling: a tool error whose code is `plan_limit`.
    const server = buildTrovMcpServer(env as never, ctx, { origin: "https://trov.test" });
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (a: unknown, x: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }> }> })._registeredTools;
    const res = await tools.artifact_update.handler({ slug: ok.json.slug, content: "t".repeat(20), summary: "s" }, {});
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text)).toMatchObject({ code: "plan_limit" });
  });
});

describe("agent connections — per person", () => {
  it("a person's MCP tokens and connected apps into the org share one cap; revoking one frees it; another member has their own", async () => {
    const { cookie, id, owner } = await orgOn("team", "conn", "conn-owner", { agent_connections: 2 });
    expect((await call("POST", "/api/o/conn/mcp-tokens", cookie, {})).status).toBe(200);
    // One connected app (a consent) is the second connection…
    const client = await registerClient(platformCtx(), { client_name: "Claude Code", redirect_uris: ["http://localhost:4444/callback"] }, Date.now());
    const check = await checkAuthorizeRequest(platformCtx(), new URLSearchParams({
      response_type: "code", client_id: client.client_id, redirect_uri: "http://localhost:4444/callback", code_challenge: "c".repeat(43), code_challenge_method: "S256",
    }), "https://trov.test");
    if (!check.ok) throw new Error("expected a valid authorize request");
    const ctx = await tenantCtx(owner, undefined, { orgId: id, via: "bearer" });
    await issueAuthorization(ctx, { client, params: check.params, nowMs: Date.now() });
    // …and the third of either kind is refused.
    const r = await call<PlanRefusal>("POST", "/api/o/conn/mcp-tokens", cookie, {});
    expect(r.status).toBe(402);
    expect(r.json).toMatchObject({ limit: "agent_connections", used: 2, cap: 2, message: "You have reached the 2 agent connections per person this organization's Team plan includes." });
    await expect(issueAuthorization(ctx, { client, params: check.params, nowMs: Date.now() })).rejects.toBeInstanceOf(PlanLimitError);
    expect(await count(`SELECT COUNT(*) AS n FROM oauth_grants WHERE org_id = ?`, id)).toBe(1);

    // Another member of the same org is counted on their own.
    await ensureMember("conn-mate", "member", id);
    expect((await call("POST", "/api/o/conn/mcp-tokens", await loner("conn-mate"), {})).status).toBe(200);
    // Revoking frees one.
    const token = (await one<{ id: number }>(`SELECT id FROM mcp_tokens WHERE org_id = ? AND person = ?`, id, owner))!.id;
    expect((await call("POST", `/api/o/conn/mcp-tokens/${token}/revoke`, cookie, {})).status).toBe(200);
    expect((await call("POST", "/api/o/conn/mcp-tokens", cookie, {})).status).toBe(200);
  });
});

describe("over a limit — nothing is deleted, nobody is removed, additions are refused", () => {
  it("a Team org with five people and two repositories moved to Personal keeps all of it and reads normally", async () => {
    const { cookie, id } = await orgOn("team", "shrunk");
    for (const h of ["s1", "s2", "s3", "s4"]) await ensureMember(h, "member", id);
    expect((await invite("shrunk", cookie, 1)).status).toBe(201);
    for (const repo of ["shrunk/a", "shrunk/b"]) expect((await call("POST", "/api/o/shrunk/repos", cookie, { repo_full_name: repo })).status).toBe(201);
    const before = await rows(`SELECT user_id, role FROM memberships WHERE org_id = ? ORDER BY user_id`, id);

    const changed = await call<{ ok: true; org: PlatformOrgRow }>("PUT", "/api/platform/orgs/shrunk/plan", await boss(), { plan: "personal" });
    expect(changed.status).toBe(200);
    expect(changed.json.org.plan).toMatchObject({ plan: "personal", seats_used: 6, entitlements: { seats: 1, repositories: 1 } });

    // Nothing went.
    expect(await rows(`SELECT user_id, role FROM memberships WHERE org_id = ? ORDER BY user_id`, id)).toEqual(before);
    expect(await pending(id)).toBe(1);
    expect(await count(`SELECT COUNT(*) AS n FROM org_repos WHERE org_id = ?`, id)).toBe(2);
    // Reads keep working — for every member — and the Plan block says what the org is over.
    const mate = await loner("s1");
    expect((await call("GET", "/api/o/shrunk/members", mate)).status).toBe(200);
    expect((await call("GET", "/api/o/shrunk/repos", mate)).status).toBe(200);
    const plan = (await call<OrgPlanView>("GET", "/api/o/shrunk/plan", mate)).json;
    expect(plan).toMatchObject({ plan: "personal", name: "Personal", status: "active", seats: { members: 5, pending: 1 }, over: ["seats", "repositories"] });
    expect(plan.usage).toMatchObject({ seats: 6, repositories: 2, environments: 0 });
    // Additions of an over-limit kind are refused; a pending invitation cannot be accepted into a full org.
    expect((await invite("shrunk", cookie, 2)).status).toBe(402);
    expect((await call("POST", "/api/o/shrunk/repos", cookie, { repo_full_name: "shrunk/c" })).status).toBe(402);
    await loner("dev-shrunk-1");
    const inv = (await one<{ id: number }>(`SELECT id FROM org_invites WHERE org_id = ? AND status = 'pending'`, id))!.id;
    expect((await call("POST", `/api/invites/${inv}/accept`, await loner("dev-shrunk-1"), {})).status).toBe(402);
    // Removals are never refused, and the org is still fully usable for what no limit governs.
    expect((await call("DELETE", "/api/o/shrunk/members/s4", cookie)).status).toBe(200);
    expect((await call("POST", "/api/o/shrunk/tickets", cookie, { title: "still works" })).status).toBeLessThan(300);
    // Back on a plan that fits, additions work again.
    await setOrgPlan(platformCtx(SUPERADMIN), "shrunk", { plan: "team" });
    expect((await invite("shrunk", cookie, 3)).status).toBe(201);
  });
});

describe("GET /api/o/:slug/plan and PUT /api/platform/orgs/:slug/plan", () => {
  it("any member reads the plan, its limits and the org's use; a stranger gets the tenant 404", async () => {
    const { cookie, id } = await orgOn("team", "planview");
    await ensureMember("pv-mate", "member", id);
    await invite("planview", cookie, 1);
    const view = (await call<OrgPlanView>("GET", "/api/o/planview/plan", await loner("pv-mate"))).json;
    expect(view).toEqual({
      plan: "team", name: "Team", description: PLANS.team.description, status: "active", source: "granted", period_end: null,
      entitlements: PLANS.team.entitlements, overridden: [], seats: { members: 2, pending: 1 },
      usage: { seats: 3, repositories: 0, environments: 0, artifact_bytes: 0, agent_connections: 0 }, over: [],
    });
    expect((await call("GET", "/api/o/planview/plan", await loner("outsider"))).status).toBe(404);
    expect((await call("PUT", "/api/o/planview/plan", cookie, { plan: "enterprise" })).status).toBe(404); // nobody changes it here
  });

  it("the superadmin changes a plan and its overrides; each is validated and audited", async () => {
    const { id } = await orgOn("team", "moving");
    const root = await boss();
    for (const [bodyIn, code] of [[{ plan: "gold" }, "invalid_plan"], [{}, "invalid_plan"], [{ plan: "team", overrides: { seats: 0 } }, "invalid_overrides"], [{ plan: "team", overrides: { sets: 4 } }, "invalid_overrides"]] as const) {
      const r = await call("PUT", "/api/platform/orgs/moving/plan", root, bodyIn);
      expect([r.status, r.json.error], JSON.stringify(bodyIn)).toEqual([400, code]);
    }
    expect((await call("PUT", "/api/platform/orgs/nope/plan", root, { plan: "team" })).status).toBe(404);

    const ent = await call<{ org: PlatformOrgRow }>("PUT", "/api/platform/orgs/moving/plan", root, { plan: "enterprise", overrides: { seats: 25, repositories: null } });
    expect(ent.json.org.plan).toMatchObject({ plan: "enterprise", overrides: { seats: 25, repositories: null }, source: "granted", entitlements: { seats: 25, repositories: null, environments: 10 } });
    // Only the limits move: the same plan, new overrides.
    await call("PUT", "/api/platform/orgs/moving/plan", root, { plan: "enterprise", overrides: { seats: 30 } });
    expect(await rows<{ action: string; actor: string }>(`SELECT action, actor FROM org_admin_audit WHERE org_id = ? AND action LIKE 'plan.%' ORDER BY id`, id))
      .toEqual([{ action: "plan.change", actor: SUPERADMIN }, { action: "plan.overrides", actor: SUPERADMIN }]);
    expect(await one(`SELECT plan, plan_overrides, plan_source, plan_changed_by FROM orgs WHERE id = ?`, id))
      .toEqual({ plan: "enterprise", plan_overrides: `{"seats":30}`, plan_source: "granted", plan_changed_by: SUPERADMIN });
    // The list and the org page carry it.
    const listed = (await call<{ orgs: PlatformOrgRow[] }>("GET", "/api/platform/orgs", root)).json.orgs.find((o) => o.slug === "moving")!;
    expect(listed.plan).toMatchObject({ plan: "enterprise", seats_used: 1, entitlements: { seats: 30 } });
  });

  it("Platform › Add organization takes a plan and overrides; with none it is Team", async () => {
    const root = await boss();
    await loner("pm");
    const made = await call<{ org: PlatformOrgRow }>("POST", "/api/platform/orgs", root, { slug: "defaulted", name: "Defaulted", admin: { handle: "pm" } });
    expect(made.json.org.plan).toMatchObject({ plan: "team", source: "granted" });
    const sized = await call<{ org: PlatformOrgRow }>("POST", "/api/platform/orgs", root, { slug: "sized", name: "Sized", admin: { email: "cto@sized.io" }, plan: "enterprise", overrides: { seats: 50 } });
    expect(sized.json.org.plan).toMatchObject({ plan: "enterprise", entitlements: { seats: 50 }, seats_used: 1 }); // the owner's invitation holds a seat
    const bad = await call("POST", "/api/platform/orgs", root, { slug: "badplan", name: "Bad", admin: { handle: "pm" }, plan: "gold" });
    expect([bad.status, bad.json.error]).toEqual([400, "invalid_plan"]);
    expect(await one(`SELECT 1 AS x FROM orgs WHERE slug = 'badplan'`)).toBeNull();
  });
});

describe("the functions billing will call (src/plans/billing.ts)", () => {
  it("setOrgPlan with source billing stores the period and the provider's ids; a later change leaves what it does not name", async () => {
    const { id } = await orgOn("personal", "paid");
    const p = platformCtx("billing");
    const set = await setOrgPlan(p, "paid", { plan: "team", source: "billing", period_end: "2026-11-07T00:00:00.000Z", customer_id: "cus_1", subscription_id: "sub_1" });
    expect(set).toMatchObject({ plan: "team", source: "billing", status: "active", period_end: "2026-11-07T00:00:00.000Z", customer_id: "cus_1", subscription_id: "sub_1" });
    expect(await setOrgPlan(p, "paid", { plan: "team", source: "billing", period_end: "2026-12-07T00:00:00.000Z" }))
      .toMatchObject({ period_end: "2026-12-07T00:00:00.000Z", customer_id: "cus_1", subscription_id: "sub_1" });
    expect(await one(`SELECT plan_changed_by FROM orgs WHERE id = ?`, id)).toEqual({ plan_changed_by: "billing" });
  });

  it("past_due enforces nothing; canceled keeps the org readable and working but refuses every addition; setOrgPlan brings it back", async () => {
    const { cookie, id } = await orgOn("team", "lapsed");
    const p = platformCtx("billing");
    expect((await markOrgPastDue(p, "lapsed")).status).toBe("past_due");
    expect((await invite("lapsed", cookie, 1)).status).toBe(201);

    expect((await cancelOrgPlan(p, "lapsed")).status).toBe("canceled");
    const r = await invite("lapsed", cookie, 2);
    expect(r.status).toBe(402);
    expect(r.json).toMatchObject({ error: "plan_limit", limit: "seats", status: "canceled", plan: "team", message: "This organization's Team plan has ended, so nothing can be added until it is renewed." });
    expect((await call("POST", "/api/o/lapsed/repos", cookie, { repo_full_name: "lapsed/a" })).status).toBe(402);
    expect((await call("POST", "/api/o/lapsed/mcp-tokens", cookie, {})).status).toBe(402);
    // Everything else carries on, and nothing was removed.
    expect((await call("GET", "/api/o/lapsed/members", cookie)).status).toBe(200);
    expect((await call("POST", "/api/o/lapsed/tickets", cookie, { title: "work goes on" })).status).toBeLessThan(300);
    expect([await members(id), await pending(id)]).toEqual([1, 1]);
    expect((await call<OrgPlanView>("GET", "/api/o/lapsed/plan", cookie)).json).toMatchObject({ status: "canceled", plan: "team" });

    expect((await setOrgPlan(p, "lapsed", { plan: "team", source: "billing" })).status).toBe("active");
    expect((await invite("lapsed", cookie, 2)).status).toBe(201);
    expect((await rows<{ action: string }>(`SELECT action FROM org_admin_audit WHERE org_id = ? AND action LIKE 'plan.%' ORDER BY id`, id)).map((a) => a.action))
      .toEqual(["plan.status", "plan.status", "plan.change"]);
    await expect(setOrgPlanStatus(p, "nope", "canceled")).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("the refusal's shape is the same everywhere", () => {
  it("every 402 is exactly { error, limit, used, cap, plan, status, message } as JSON", async () => {
    const { cookie } = await orgOn("personal", "shape");
    const res = await app.request("/api/o/shape/invites", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ github_login: "x" }) }, env);
    expect(res.status).toBe(402);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(Object.keys(await res.json() as object).sort()).toEqual(["cap", "error", "limit", "message", "plan", "status", "used"]);
  });
});

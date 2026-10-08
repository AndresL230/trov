/**
 * Plans and their limits (0044_plans, docs/architecture/plans.md): the four plans (Free, legacy Personal,
 * Pro — id `team`, sold per seat — and Enterprise), the resolution of an org's entitlements, and EVERY
 * enforcement point at and over its cap — seats (an invitation created, one accepted, the superadmin's
 * owner, the legacy invite alias), repositories, environments, stored artifact bytes and a person's agent
 * connections — each refused with the one 402 `plan_limit` body (its `next` saying what the owner can do),
 * and none deleting anything. Also a plan's FEATURES (`requireFeature`, 402 `plan_feature`) and the move
 * to Free when a subscription ends (`moveOrgToFree`).
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { cookieFor } from "./helpers/persons";
import { ensureMember, ORG_A, ORG_B, platformCtx, tenantCtx } from "./helpers/tenant";
import { call, one, rows, exec, SUPERADMIN } from "./helpers/orgs";
import { app } from "../src/routes";
import {
  PLANS, PLAN_IDS, LIMIT_KEYS, FEATURE_KEYS, FALLBACK_PLAN, OFFERED_PLAN_IDS, PLAN_CHANGE_POINTER,
  resolveEntitlements, parseOverrides, storedOverrides, planRefusal, planRefusalSentence, planNext, planFeatureRefusal, isSoloPlan, formatLimit, formatUse, limitPhrase, overLimits,
  type OrgPlanState, type OrgPlanView, type PlanDef, type PlanId, type PlanRefusal,
} from "@shared/plans";
import type { PlatformOrgRow } from "@shared/orgs";
import { PlanLimitError, PlanFeatureError, setOrgPlan, setOrgPlanStatus, markOrgPastDue, cancelOrgPlan, moveOrgToFree, orgPlan } from "../src/plans/state";
import { requireFeature } from "../src/plans/gate";
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
/** A Free org made the self-serve way — a signed-in person with no grant (`POST /api/orgs`, src/plans/free.ts). */
async function freeOrg(slug: string, owner = `${slug}-owner`) {
  const cookie = await loner(owner);
  const r = await call("POST", "/api/orgs", cookie, { slug, name: slug });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return { cookie, id: await orgId(slug), owner };
}
const MB = 1024 ** 2;
const GB = 1024 ** 3;
const OWNERS = "Ask one of this organization's owners.";

describe("entitlements — the plan's defaults with the org's overrides on top", () => {
  it("the four plans: Free is three people, Personal (legacy) one, Pro (`team`) fifty, Enterprise's seats are unlimited", () => {
    expect(PLAN_IDS).toEqual(["free", "personal", "team", "enterprise"]);
    expect(resolveEntitlements("free").seats).toBe(3);
    expect(resolveEntitlements("personal").seats).toBe(1);
    expect(resolveEntitlements("team").seats).toBe(50);
    expect(resolveEntitlements("enterprise").seats).toBeNull();
    for (const id of PLAN_IDS) {
      expect(Object.keys(PLANS[id].entitlements).sort()).toEqual([...LIMIT_KEYS].sort());
      expect(PLANS[id]).toMatchObject({ id, billing: null, features: [] }); // no price in this branch; no feature gated yet
      expect(PLANS[id].name).toBeTruthy();
      expect(PLANS[id].description).toBeTruthy();
      expect(typeof PLANS[id].offered).toBe("boolean");
    }
  });

  it("Free is exactly what a person gets with no grant; Pro is `team`, sold per seat; Personal is legacy — kept, offered to nobody", () => {
    expect(PLANS.free).toEqual({
      id: "free", name: "Free", description: "For a small team trying Trov out.",
      entitlements: { seats: 3, repositories: 1, environments: 2, artifact_bytes: 250 * MB, agent_connections: 5, ai_summaries: 300 },
      features: [], offered: true, billing: null,
    });
    expect(PLANS.team).toEqual({
      id: "team", name: "Pro", description: "For a team, paid per seat.",
      entitlements: { seats: 50, repositories: 5, environments: 5, artifact_bytes: 5 * GB, agent_connections: 10, ai_summaries: 3000 },
      features: [], offered: true, billing: null,
    });
    // An org or grant already on Personal keeps its limits.
    expect(PLANS.personal).toEqual({
      id: "personal", name: "Personal", description: "One person's own organization.",
      entitlements: { seats: 1, repositories: 1, environments: 2, artifact_bytes: 250 * MB, agent_connections: 5, ai_summaries: 300 },
      features: [], offered: false, billing: null,
    });
    expect(PLANS.enterprise).toMatchObject({ name: "Enterprise", offered: true, entitlements: { seats: null, repositories: 10, environments: 10 } });
    expect(PLAN_IDS.filter((id) => PLANS[id].offered)).toEqual(["free", "team", "enterprise"]);
    expect(OFFERED_PLAN_IDS).toEqual(["free", "team", "enterprise"]);
    expect(FEATURE_KEYS).toEqual([]);
    // The fallback is still the SMALLEST plan — one seat, legacy Personal — not Free.
    expect(FALLBACK_PLAN).toBe("personal");
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
    expect(planRefusal(team, "seats", 49)).toBeNull();
    expect(planRefusal(team, "seats", 50)).toEqual({
      error: "plan_limit", limit: "seats", used: 50, cap: 50, plan: "team", status: "active",
      message: "This organization has reached the 50 seats its Pro plan includes.",
    });
    expect(planRefusal(team, "seats", 54)).toMatchObject({ used: 54, cap: 50 }); // over: still just "no more"
    expect(planRefusal({ ...team, overrides: { seats: 51 } }, "seats", 50)).toBeNull();
    expect(planRefusal({ plan: "enterprise", overrides: {}, status: "active" }, "seats", 100000)).toBeNull();
    expect(planRefusal(team, "artifact_bytes", 0, 6 * 1024 ** 3)).toMatchObject({ limit: "artifact_bytes", message: "This organization has reached the 5 GB of artifact storage its Pro plan includes." });
    expect(planRefusal(team, "agent_connections", 10)).toMatchObject({ message: "You have reached the 10 agent connections per person this organization's Pro plan includes." });
    expect(planRefusal({ ...team, status: "past_due" }, "seats", 49)).toBeNull();
    expect(planRefusal({ ...team, status: "canceled" }, "seats", 1)).toMatchObject({ status: "canceled", message: expect.stringContaining("has ended") });
    expect(planRefusal({ plan: "enterprise", overrides: {}, status: "canceled" }, "seats", 3)).toMatchObject({ cap: 3 });
  });

  it("next: every refusal of a Free org says upgrade; a PAID Pro org out of seats says add a seat; a granted or ended plan says neither", () => {
    const free: OrgPlanState = { plan: "free", overrides: {}, status: "active", source: "granted" };
    expect(planRefusal(free, "seats", 2)).toBeNull();
    expect(planRefusal(free, "seats", 3)).toEqual({
      error: "plan_limit", limit: "seats", used: 3, cap: 3, plan: "free", status: "active",
      message: "This organization has reached the 3 seats its Free plan includes.", next: "upgrade",
    });
    expect(planRefusal(free, "repositories", 1)).toEqual({
      error: "plan_limit", limit: "repositories", used: 1, cap: 1, plan: "free", status: "active",
      message: "This organization has reached the 1 repository its Free plan includes.", next: "upgrade",
    });
    expect(planRefusal(free, "environments", 2)).toMatchObject({ limit: "environments", cap: 2, next: "upgrade" });
    expect(planRefusal(free, "artifact_bytes", 0, 251 * MB)).toMatchObject({ message: "This organization has reached the 250 MB of artifact storage its Free plan includes.", next: "upgrade" });
    expect(planRefusal(free, "agent_connections", 5)).toMatchObject({ cap: 5, next: "upgrade" });
    expect(planRefusal(free, "ai_summaries", 300)).toMatchObject({ cap: 300, next: "upgrade" });
    expect(planRefusal({ ...free, status: "past_due" }, "seats", 3)).toMatchObject({ next: "upgrade" });
    expect(planRefusal({ ...free, overrides: { seats: 4 } }, "seats", 3)).toBeNull(); // an override still lifts a Free cap
    // A billing org moved to Free when its subscription ended: paid, and upgrade.
    expect(planRefusal({ ...free, source: "billing" }, "seats", 3)).toEqual({
      error: "plan_limit", limit: "seats", used: 3, cap: 3, plan: "free", status: "active",
      message: "This organization has reached the 3 seats its Free plan includes.", paid: true, next: "upgrade",
    });
    // An ENDED plan is renewed, not upgraded: no `next`, Free or not.
    const endedFree = planRefusal({ ...free, status: "canceled" }, "seats", 1)!;
    expect(endedFree).toMatchObject({ status: "canceled", message: "This organization's Free plan has ended, so nothing can be added until it is renewed." });
    expect(endedFree).not.toHaveProperty("next");

    // Pro, paid per seat: the override is the seats the subscription pays for.
    const paidPro: OrgPlanState = { plan: "team", overrides: { seats: 2 }, status: "active", source: "billing" };
    expect(planRefusal(paidPro, "seats", 1)).toBeNull();
    expect(planRefusal(paidPro, "seats", 2)).toEqual({
      error: "plan_limit", limit: "seats", used: 2, cap: 2, plan: "team", status: "active",
      message: "This organization has reached the 2 seats its Pro plan includes.", paid: true, next: "add_seat",
    });
    expect(planRefusal({ ...paidPro, status: "past_due" }, "seats", 2)).toMatchObject({ paid: true, next: "add_seat" });
    // Only seats are bought one at a time: a paid Pro org's other limits are the plan's (paid, no `next`).
    const paidRepos = planRefusal(paidPro, "repositories", 5)!;
    expect(paidRepos).toMatchObject({ limit: "repositories", cap: 5, paid: true });
    expect(paidRepos).not.toHaveProperty("next");
    // A GRANTED Pro org asks Trov: neither paid nor next.
    const grantedPro = planRefusal({ plan: "team", overrides: {}, status: "active", source: "granted" }, "seats", 50)!;
    expect(grantedPro).toEqual({
      error: "plan_limit", limit: "seats", used: 50, cap: 50, plan: "team", status: "active",
      message: "This organization has reached the 50 seats its Pro plan includes.",
    });
    // An ENDED paid Pro org: paid (renew in Org settings), no `next`.
    const endedPro = planRefusal({ ...paidPro, status: "canceled" }, "seats", 1)!;
    expect(endedPro).toMatchObject({ status: "canceled", paid: true, message: "This organization's Pro plan has ended, so nothing can be added until it is renewed." });
    expect(endedPro).not.toHaveProperty("next");
    // `add_seat` is Pro's alone: billing on Personal or Enterprise names nothing.
    expect(planRefusal({ plan: "personal", overrides: {}, status: "active", source: "billing" }, "seats", 1)).not.toHaveProperty("next");
    expect(planRefusal({ plan: "enterprise", overrides: { seats: 5 }, status: "active", source: "billing" }, "seats", 5)).not.toHaveProperty("next");

    // planNext, the one rule both refusals use.
    expect(planNext(free, "seats")).toBe("upgrade");
    expect(planNext(free, null)).toBe("upgrade");
    expect(planNext({ ...free, status: "canceled" }, "seats")).toBeNull();
    expect(planNext(paidPro, "seats")).toBe("add_seat");
    expect(planNext(paidPro, "repositories")).toBeNull();
    expect(planNext(paidPro, null)).toBeNull();
    expect(planNext({ ...paidPro, source: "granted" }, "seats")).toBeNull();
    expect(planNext({ ...paidPro, source: null }, "seats")).toBeNull();
    expect(planNext({ ...paidPro, status: "canceled" }, "seats")).toBeNull();
    // At the most Pro sells (50 seats) there is no seat to add: the refusal names nothing to do in Trov.
    const maxed: OrgPlanState = { ...paidPro, overrides: { seats: 50 } };
    expect(planNext(maxed, "seats")).toBeNull();
    expect(planRefusal(maxed, "seats", 50)).toEqual({
      error: "plan_limit", limit: "seats", used: 50, cap: 50, plan: "team", status: "active",
      message: "This organization has reached the 50 seats its Pro plan includes.", paid: true,
    });
    expect(planNext({ ...paidPro, overrides: { seats: 49 } }, "seats")).toBe("add_seat");
  });

  it("planRefusalSentence: an owner is told the ONE thing they can do — upgrade, add a seat, manage billing, renew or ask Trov; anyone else asks an owner", () => {
    expect(PLAN_CHANGE_POINTER).toEqual({
      owner: "Ask Trov to change your plan.",
      paid_owner: "You can upgrade or manage billing in Org settings.",
      ended_owner: "You can renew it in Org settings.",
      add_seat: "Add a seat to invite more people.",
      upgrade: "Upgrade to Pro for more.",
      other: OWNERS,
    });
    const free = planRefusal({ plan: "free", overrides: {}, status: "active", source: "granted" }, "seats", 3)!;
    expect(planRefusalSentence(free, "owner")).toBe("This organization has reached the 3 seats its Free plan includes. Upgrade to Pro for more.");
    const freeRepo = planRefusal({ plan: "free", overrides: {}, status: "active", source: "granted" }, "repositories", 1)!;
    expect(planRefusalSentence(freeRepo, "owner")).toBe("This organization has reached the 1 repository its Free plan includes. Upgrade to Pro for more.");
    // `next` wins over `paid`: a paid Pro org out of seats buys one, a billing org now on Free upgrades.
    const seat = planRefusal({ plan: "team", overrides: { seats: 2 }, status: "active", source: "billing" }, "seats", 2)!;
    expect(planRefusalSentence(seat, "owner")).toBe("This organization has reached the 2 seats its Pro plan includes. Add a seat to invite more people.");
    const movedToFree = planRefusal({ plan: "free", overrides: {}, status: "active", source: "billing" }, "seats", 3)!;
    expect(planRefusalSentence(movedToFree, "owner")).toBe(`${movedToFree.message} Upgrade to Pro for more.`);
    // Without a `next`: paid → manage billing; paid and ended → renew; granted → ask Trov.
    const paidRepos = planRefusal({ plan: "team", overrides: {}, status: "active", source: "billing" }, "repositories", 5)!;
    expect(planRefusalSentence(paidRepos, "owner")).toBe(`${paidRepos.message} You can upgrade or manage billing in Org settings.`);
    const ended = planRefusal({ plan: "team", overrides: {}, status: "canceled", source: "billing" }, "seats", 1)!;
    expect(planRefusalSentence(ended, "owner")).toBe(`${ended.message} You can renew it in Org settings.`);
    const granted = planRefusal({ plan: "team", overrides: {}, status: "active", source: "granted" }, "seats", 50)!;
    expect(planRefusalSentence(granted, "owner")).toBe(`${granted.message} Ask Trov to change your plan.`);
    // Whatever the refusal says an owner could do, an admin, a member (or nobody signed in) asks an owner.
    for (const r of [free, freeRepo, seat, movedToFree, paidRepos, ended, granted]) {
      for (const role of ["admin", "member", null] as const) expect(planRefusalSentence(r, role), `${r.message} / ${role}`).toBe(`${r.message} ${OWNERS}`);
    }
    // The SPA has only the parsed body: `next` alone decides.
    expect(planRefusalSentence({ message: "Full.", next: "upgrade" }, "owner")).toBe("Full. Upgrade to Pro for more.");
    expect(planRefusalSentence({ message: "Full.", next: "add_seat", paid: true }, "owner")).toBe("Full. Add a seat to invite more people.");
    expect(planRefusalSentence({ message: "Full.", paid: true }, "owner")).toBe("Full. You can upgrade or manage billing in Org settings.");
  });

  it("a one-person plan refuses an invitation in words that name the plan that allows them", () => {
    const r = planRefusal({ plan: "personal", overrides: {}, status: "active" }, "seats", 1)!;
    expect(r.message).toBe("The Personal plan is for one person. Invitations start with the Pro plan.");
    expect(r).not.toHaveProperty("next"); // legacy Personal is granted: its owner asks Trov
    expect(planRefusalSentence(r, "owner")).toBe(`${r.message} Ask Trov to change your plan.`);
    expect(planRefusalSentence(r, "admin")).toBe(`${r.message} Ask one of this organization's owners.`);
    // Personal with its one seat cut by an override is still for one person; raised, it counts like any plan.
    expect(planRefusal({ plan: "personal", overrides: { seats: 1 }, status: "active" }, "seats", 1)?.message).toBe(r.message);
    expect(planRefusal({ plan: "personal", overrides: { seats: 4 }, status: "active" }, "seats", 4)?.message).toBe("This organization has reached the 4 seats its Personal plan includes.");
  });

  it("only a plan FOR one person says so: a Pro or Free org held to one seat by an override reaches its 1 seat (and a paid Pro org adds one)", () => {
    // isSoloPlan is the plan's OWN seats — an unknown id is the fallback (Personal), so it is one too.
    expect(PLAN_IDS.filter((id) => isSoloPlan(id))).toEqual(["personal"]);
    expect([isSoloPlan("platinum"), isSoloPlan(null), isSoloPlan(undefined)]).toEqual([true, true, true]);

    const grantedPro = planRefusal({ plan: "team", overrides: { seats: 1 }, status: "active", source: "granted" }, "seats", 1)!;
    expect(grantedPro).toEqual({
      error: "plan_limit", limit: "seats", used: 1, cap: 1, plan: "team", status: "active",
      message: "This organization has reached the 1 seat its Pro plan includes.",
    });
    expect(planRefusalSentence(grantedPro, "owner")).toBe(`${grantedPro.message} Ask Trov to change your plan.`);
    // A paid Pro org that bought ONE seat: the ordinary sentence, and its owner adds a seat.
    const onePaidSeat = planRefusal({ plan: "team", overrides: { seats: 1 }, status: "active", source: "billing" }, "seats", 1)!;
    expect(onePaidSeat).toEqual({
      error: "plan_limit", limit: "seats", used: 1, cap: 1, plan: "team", status: "active",
      message: "This organization has reached the 1 seat its Pro plan includes.", paid: true, next: "add_seat",
    });
    expect(planRefusalSentence(onePaidSeat, "owner")).toBe("This organization has reached the 1 seat its Pro plan includes. Add a seat to invite more people.");
    expect(planRefusalSentence(onePaidSeat, "admin")).toBe(`${onePaidSeat.message} ${OWNERS}`);
    // Free held to one seat: the ordinary sentence, pointing at Pro.
    expect(planRefusal({ plan: "free", overrides: { seats: 1 }, status: "active", source: "granted" }, "seats", 1)).toEqual({
      error: "plan_limit", limit: "seats", used: 1, cap: 1, plan: "free", status: "active",
      message: "This organization has reached the 1 seat its Free plan includes.", next: "upgrade",
    });
    // Enterprise sized to one seat: the ordinary sentence too.
    expect(planRefusal({ plan: "enterprise", overrides: { seats: 1 }, status: "active" }, "seats", 1)?.message).toBe("This organization has reached the 1 seat its Enterprise plan includes.");
  });

  it("formats a limit and its use; names the limits an org is over", () => {
    expect(formatLimit("seats", null)).toBe("Unlimited");
    expect(formatLimit("artifact_bytes", 5 * 1024 ** 3)).toBe("5 GB");
    expect(formatUse("seats", 7, 10)).toBe("7 of 10");
    expect(formatUse("seats", 7, null)).toBe("7");
    // Counts carry thousands separators — in the ONE formatter, so the Plan block, Platform and the pricing page agree.
    expect(formatLimit("ai_summaries", 3000)).toBe("3,000");
    expect(formatLimit("ai_summaries", 300)).toBe("300");
    expect(formatLimit("ai_summaries", null)).toBe("Unlimited");
    expect(formatUse("ai_summaries", 1212, 3000)).toBe("1,212 of 3,000 this month");
    expect(formatUse("ai_summaries", 12345, null)).toBe("12,345");
    expect(limitPhrase("ai_summaries", 3000)).toEqual(["3,000", "AI summaries per month"]);
    expect(limitPhrase("ai_summaries", null)).toEqual(["Unlimited", "AI summaries"]);
    expect(limitPhrase("agent_connections", 5)).toEqual(["5", "agent connections per person"]);
    expect(limitPhrase("seats", 1)).toEqual(["1", "seat"]);
    expect(limitPhrase("artifact_bytes", 5 * 1024 ** 3)).toEqual(["5 GB", "artifact storage"]);
    expect(planRefusal({ plan: "enterprise", overrides: { repositories: 1500 }, status: "active" }, "repositories", 1500)?.message)
      .toBe("This organization has reached the 1,500 repositories its Enterprise plan includes.");
    expect(overLimits(PLANS.personal.entitlements, { seats: 4, repositories: 1, environments: 3 })).toEqual(["seats", "environments"]);
  });
});

describe("seats — an invitation reserves one", () => {
  it("a (granted) Pro org invites up to fifty seats and is refused the fifty-first with the one 402 body; nothing is written", async () => {
    const { cookie, id } = await orgOn("team", "fiftyco");
    // 45 invitations already out (written directly: fifty through the route would spend the owner's daily
    // invite allowance, src/platform/limits.ts), then the last four seats through the route.
    for (let n = 1; n <= 45; n++) {
      await exec(`INSERT INTO org_invites (org_id, github_login, role, invited_by, status, created_at) VALUES (?, ?, 'member', ?, 'pending', '2026-10-06T00:00:00Z')`, id, `dev-fiftyco-${n}`, "fiftyco-owner");
    }
    for (let n = 46; n <= 49; n++) expect((await invite("fiftyco", cookie, n)).status, `invite ${n}`).toBe(201);
    expect([await members(id), await pending(id)]).toEqual([1, 49]);
    const audit = await count(`SELECT COUNT(*) AS n FROM org_admin_audit WHERE org_id = ?`, id);

    const r = await invite("fiftyco", cookie, 50);
    expect(r.status).toBe(402);
    expect(r.json).toEqual({
      error: "plan_limit", limit: "seats", used: 50, cap: 50, plan: "team", status: "active",
      message: "This organization has reached the 50 seats its Pro plan includes.",
    });
    expect([await members(id), await pending(id)]).toEqual([1, 49]);
    expect(await count(`SELECT COUNT(*) AS n FROM org_admin_audit WHERE org_id = ?`, id)).toBe(audit);
    // An e-mail invitation is refused the same way, and nothing is mailed.
    expect((await call("POST", "/api/o/fiftyco/invites", cookie, { email: "late@x.io" })).status).toBe(402);
    expect(await count(`SELECT COUNT(*) AS n FROM notification_outbox_bodies`)).toBe(0);
    // Revoking one frees its seat.
    const first = (await one<{ id: number }>(`SELECT id FROM org_invites WHERE org_id = ? ORDER BY id LIMIT 1`, id))!.id;
    expect((await call("POST", `/api/o/fiftyco/invites/${first}/revoke`, cookie, {})).status).toBe(200);
    expect((await invite("fiftyco", cookie, 51)).status).toBe(201);
  });

  it("a Free org — self-serve, no grant — invites up to its three seats; the fourth is the 402 that points its owner at Pro; nothing is written", async () => {
    const { cookie, id } = await freeOrg("freebie");
    expect(await orgPlan(platformCtx(), id)).toMatchObject({ plan: "free", overrides: {}, status: "active", source: "granted" });
    for (let n = 1; n <= 2; n++) expect((await invite("freebie", cookie, n)).status, `invite ${n}`).toBe(201);
    expect([await members(id), await pending(id)]).toEqual([1, 2]);
    const audit = await count(`SELECT COUNT(*) AS n FROM org_admin_audit WHERE org_id = ?`, id);

    const r = await invite("freebie", cookie, 3);
    expect(r.status).toBe(402);
    expect(r.json).toEqual({
      error: "plan_limit", limit: "seats", used: 3, cap: 3, plan: "free", status: "active",
      message: "This organization has reached the 3 seats its Free plan includes.", next: "upgrade",
    });
    expect(planRefusalSentence(r.json, "owner")).toBe("This organization has reached the 3 seats its Free plan includes. Upgrade to Pro for more.");
    expect([await members(id), await pending(id)]).toEqual([1, 2]);
    expect(await count(`SELECT COUNT(*) AS n FROM org_admin_audit WHERE org_id = ?`, id)).toBe(audit);
    expect((await call<PlanRefusal>("POST", "/api/o/freebie/invites", cookie, { email: "fourth@x.io" })).json).toMatchObject({ error: "plan_limit", cap: 3, next: "upgrade" });
    // Its other limits are Free's too, each pointing at Pro: one repository.
    expect((await call("POST", "/api/o/freebie/repos", cookie, { repo_full_name: "freebie/one" })).status).toBe(201);
    const repo = await call<PlanRefusal>("POST", "/api/o/freebie/repos", cookie, { repo_full_name: "freebie/two" });
    expect([repo.status, repo.json]).toEqual([402, {
      error: "plan_limit", limit: "repositories", used: 1, cap: 1, plan: "free", status: "active",
      message: "This organization has reached the 1 repository its Free plan includes.", next: "upgrade",
    }]);
  });

  it("a PAID Pro org has the seats it pays for: past them the 402 is `paid` with `next: add_seat`; one more seat bought lets the invitation through", async () => {
    const { cookie, id } = await orgOn("team", "paidpro");
    await exec(`UPDATE orgs SET plan = 'team', plan_source = 'billing', plan_overrides = '{"seats":2}' WHERE id = ?`, id);
    expect((await invite("paidpro", cookie, 1)).status).toBe(201);
    const r = await invite("paidpro", cookie, 2);
    expect(r.status).toBe(402);
    expect(r.json).toEqual({
      error: "plan_limit", limit: "seats", used: 2, cap: 2, plan: "team", status: "active",
      message: "This organization has reached the 2 seats its Pro plan includes.", paid: true, next: "add_seat",
    });
    expect(planRefusalSentence(r.json, "owner")).toBe("This organization has reached the 2 seats its Pro plan includes. Add a seat to invite more people.");
    expect(planRefusalSentence(r.json, "admin")).toBe(`${r.json.message} ${OWNERS}`);
    expect([await members(id), await pending(id)]).toEqual([1, 1]);
    // The org's Plan block reads the paid seats as an override of Pro's.
    expect((await call<OrgPlanView>("GET", "/api/o/paidpro/plan", cookie)).json).toMatchObject({ plan: "team", name: "Pro", source: "billing", entitlements: { seats: 2 }, overridden: ["seats"] });
    // One more seat paid for (billing raises the override): the same invitation goes through.
    await exec(`UPDATE orgs SET plan_overrides = '{"seats":3}' WHERE id = ?`, id);
    expect((await invite("paidpro", cookie, 2)).status).toBe(201);
  });

  it("a Personal org refuses invitations outright, in a sentence that says which plan allows them", async () => {
    const { cookie, id } = await orgOn("personal", "solo");
    const r = await invite("solo", cookie, 1);
    expect(r.status).toBe(402);
    expect(r.json).toMatchObject({ error: "plan_limit", limit: "seats", used: 1, cap: 1, plan: "personal", message: "The Personal plan is for one person. Invitations start with the Pro plan." });
    expect(r.json).not.toHaveProperty("next");
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
  /** A Pro org with its owner and two pending invitations, then its seats cut to 2: full once ONE more person joins. */
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
    expect(r.json).toMatchObject({ limit: "agent_connections", used: 2, cap: 2, message: "You have reached the 2 agent connections per person this organization's Pro plan includes." });
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
  it("a Pro org with five people and two repositories moved to (legacy) Personal keeps all of it and reads normally", async () => {
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
      plan: "team", name: "Pro", description: "For a team, paid per seat.", status: "active", source: "granted", period_end: null,
      entitlements: PLANS.team.entitlements, overridden: [], seats: { members: 2, pending: 1 },
      usage: { seats: 3, repositories: 0, environments: 0, artifact_bytes: 0, agent_connections: 0, ai_summaries: 0 }, over: [],
      billing: null, // a granted org: nothing about payment (0045_billing)
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
    expect((await call("PUT", "/api/platform/orgs/moving/plan", root, { plan: "gold" })).json).toEqual({ error: "invalid_plan", message: "plan must be free, personal, team or enterprise" });
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

  it("Platform › Add organization takes a plan and overrides — Free too; with none it is Pro (`team`)", async () => {
    const root = await boss();
    await loner("pm");
    const made = await call<{ org: PlatformOrgRow }>("POST", "/api/platform/orgs", root, { slug: "defaulted", name: "Defaulted", admin: { handle: "pm" } });
    expect(made.json.org.plan).toMatchObject({ plan: "team", source: "granted" });
    const sized = await call<{ org: PlatformOrgRow }>("POST", "/api/platform/orgs", root, { slug: "sized", name: "Sized", admin: { email: "cto@sized.io" }, plan: "enterprise", overrides: { seats: 50 } });
    expect(sized.json.org.plan).toMatchObject({ plan: "enterprise", entitlements: { seats: 50 }, seats_used: 1 }); // the owner's invitation holds a seat
    const free = await call<{ org: PlatformOrgRow }>("POST", "/api/platform/orgs", root, { slug: "givenfree", name: "Given Free", admin: { handle: "pm" }, plan: "free" });
    expect(free.json.org.plan).toMatchObject({ plan: "free", source: "granted", entitlements: PLANS.free.entitlements, seats_used: 1 });
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
    expect(r.json).toMatchObject({ error: "plan_limit", limit: "seats", status: "canceled", plan: "team", message: "This organization's Pro plan has ended, so nothing can be added until it is renewed." });
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

  it("moveOrgToFree: an ended subscription puts the org on Free — active, still billing's, paid seats cleared — audited; nothing is deleted and additions past Free wait", async () => {
    const { cookie, id } = await orgOn("team", "ended");
    const p = platformCtx("billing");
    await setOrgPlan(p, "ended", { plan: "team", source: "billing", overrides: { seats: 6 }, period_end: "2026-11-07T00:00:00.000Z", customer_id: "cus_e", subscription_id: "sub_e" });
    for (const h of ["e1", "e2", "e3"]) await ensureMember(h, "member", id);
    expect((await invite("ended", cookie, 1)).status).toBe(201);
    for (const repo of ["ended/a", "ended/b"]) expect((await call("POST", "/api/o/ended/repos", cookie, { repo_full_name: repo })).status).toBe(201);
    const people = () => rows(`SELECT user_id, role FROM memberships WHERE org_id = ? ORDER BY user_id`, id);
    const invites = () => rows(`SELECT id, github_login, status FROM org_invites WHERE org_id = ? ORDER BY id`, id);
    const [peopleBefore, invitesBefore] = [await people(), await invites()];

    const moved = await moveOrgToFree(p, "ended");
    // The customer and subscription ids stay (invoices, an upgrade); the period is left as it was.
    expect(moved).toEqual({ plan: "free", overrides: {}, status: "active", source: "billing", period_end: "2026-11-07T00:00:00.000Z", customer_id: "cus_e", subscription_id: "sub_e" });
    expect(await one(`SELECT plan, plan_overrides, plan_source, plan_status, plan_changed_by FROM orgs WHERE id = ?`, id))
      .toEqual({ plan: "free", plan_overrides: "{}", plan_source: "billing", plan_status: "active", plan_changed_by: "billing" });
    const audit = await rows<{ action: string; actor: string; target: string; detail: string }>(`SELECT action, actor, target, detail FROM org_admin_audit WHERE org_id = ? AND action LIKE 'plan.%' ORDER BY id`, id);
    expect(audit.map((a) => a.action)).toEqual(["plan.change", "plan.change"]); // onto billing, then onto Free
    expect(audit[1]).toEqual({ action: "plan.change", actor: "billing", target: "ended", detail: JSON.stringify({ from: "team", to: "free", overrides: {}, source: "billing" }) });

    // Nothing went: every member, the invitation, both repositories.
    expect(await people()).toEqual(peopleBefore);
    expect(await invites()).toEqual(invitesBefore);
    expect(await count(`SELECT COUNT(*) AS n FROM org_repos WHERE org_id = ?`, id)).toBe(2);
    // Every member reads; the Plan block says what the org is over.
    const mate = await loner("e1");
    expect((await call("GET", "/api/o/ended/members", mate)).status).toBe(200);
    expect((await call<OrgPlanView>("GET", "/api/o/ended/plan", mate)).json).toMatchObject({
      plan: "free", name: "Free", status: "active", source: "billing", overridden: [], entitlements: PLANS.free.entitlements,
      seats: { members: 4, pending: 1 }, usage: { seats: 5, repositories: 2 }, over: ["seats", "repositories"],
    });
    // Additions over a Free limit are refused — paid (a billing org) and pointing at Pro.
    const r = await invite("ended", cookie, 2);
    expect([r.status, r.json]).toEqual([402, {
      error: "plan_limit", limit: "seats", used: 5, cap: 3, plan: "free", status: "active",
      message: "This organization has reached the 3 seats its Free plan includes.", paid: true, next: "upgrade",
    }]);
    expect(planRefusalSentence(r.json, "owner")).toBe(`${r.json.message} Upgrade to Pro for more.`);
    expect((await call<PlanRefusal>("POST", "/api/o/ended/repos", cookie, { repo_full_name: "ended/c" })).json).toMatchObject({ limit: "repositories", cap: 1, paid: true, next: "upgrade" });
    await loner("dev-ended-1");
    const pendingId = (invitesBefore[0] as { id: number }).id;
    expect((await call("POST", `/api/invites/${pendingId}/accept`, await loner("dev-ended-1"), {})).status).toBe(402); // four members already: Free's three are taken
    expect([await members(id), await pending(id)]).toEqual([4, 1]);
    // What no limit governs carries on; a removal is never refused, and back under the cap an invitation goes through.
    expect((await call("POST", "/api/o/ended/tickets", cookie, { title: "still works" })).status).toBeLessThan(300);
    for (const h of ["e1", "e2", "e3"]) expect((await call("DELETE", `/api/o/ended/members/${h}`, cookie)).status).toBe(200);
    expect((await invite("ended", cookie, 2)).status).toBe(201); // 1 member + 2 pending = Free's 3
    expect((await invite("ended", cookie, 3)).status).toBe(402);
    // Moving to Free can also close the period.
    expect(await moveOrgToFree(p, "ended", { period_end: null })).toMatchObject({ plan: "free", status: "active", source: "billing", period_end: null, customer_id: "cus_e" });
    await expect(moveOrgToFree(p, "nope")).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("the refusal's shape is the same everywhere", () => {
  it("a granted plan's 402 is exactly { error, limit, used, cap, plan, status, message } as JSON; a Free org's adds `next`, a paid one's `paid`", async () => {
    const { cookie } = await orgOn("personal", "shape");
    const res = await app.request("/api/o/shape/invites", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ github_login: "x" }) }, env);
    expect(res.status).toBe(402);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(Object.keys(await res.json() as object).sort()).toEqual(["cap", "error", "limit", "message", "plan", "status", "used"]);

    const free = await orgOn("free", "shapefree", "shapefree-owner", { seats: 1 });
    const r1 = await call("POST", "/api/o/shapefree/invites", free.cookie, { github_login: "y" });
    expect(r1.status).toBe(402);
    expect(Object.keys(r1.json).sort()).toEqual(["cap", "error", "limit", "message", "next", "plan", "status", "used"]);
    const paid = await orgOn("team", "shapepaid", "shapepaid-owner", { seats: 1 });
    await exec(`UPDATE orgs SET plan_source = 'billing' WHERE id = ?`, paid.id);
    const r2 = await call<PlanRefusal>("POST", "/api/o/shapepaid/invites", paid.cookie, { github_login: "z" });
    expect(r2.status).toBe(402);
    expect(Object.keys(r2.json).sort()).toEqual(["cap", "error", "limit", "message", "next", "paid", "plan", "status", "used"]);
    // A paid Pro org on ONE seat is not "for one person": it reaches its 1 seat, and adds another.
    expect(r2.json).toMatchObject({ cap: 1, plan: "team", message: "This organization has reached the 1 seat its Pro plan includes.", paid: true, next: "add_seat" });
    expect(r1.json).toMatchObject({ cap: 1, plan: "free", message: "This organization has reached the 1 seat its Free plan includes.", next: "upgrade" });
  });
});

describe("features — what a plan includes beyond its limits (none is gated yet)", () => {
  /** FEATURE_KEYS is empty, so no real key can be typed: a stand-in, cast. */
  const FEATURE = "automation" as never;
  const state = (plan: PlanId, o: Partial<OrgPlanState> = {}): OrgPlanState => ({ plan, overrides: {}, status: "active", source: "granted", ...o });

  it("with the real table every plan refuses a feature, with the `plan_feature` body; a Free org's points at Pro", () => {
    for (const id of PLAN_IDS) {
      expect(planFeatureRefusal(state(id), FEATURE), id).toEqual({
        error: "plan_feature", feature: "automation", plan: id, status: "active",
        message: `This organization's ${PLANS[id].name} plan does not include this.`, ...(id === "free" ? { next: "upgrade" } : {}),
      });
    }
    // Enterprise's unlimited seats include nothing either; an override never adds a feature.
    expect(planFeatureRefusal(state("enterprise", { overrides: { seats: null } }), FEATURE)).toMatchObject({ plan: "enterprise" });
  });

  it("with a table where Pro includes it: Pro passes (granted, paid, past due); Free refuses with upgrade; an ended plan refuses", () => {
    const plans = { ...PLANS, team: { ...PLANS.team, features: [FEATURE] } } as Record<PlanId, PlanDef>;
    expect(planFeatureRefusal(state("team"), FEATURE, plans)).toBeNull();
    expect(planFeatureRefusal(state("team", { source: "billing", overrides: { seats: 2 } }), FEATURE, plans)).toBeNull();
    expect(planFeatureRefusal(state("team", { status: "past_due" }), FEATURE, plans)).toBeNull();
    // Free does not include it — an override of its limits changes nothing.
    expect(planFeatureRefusal(state("free", { overrides: { seats: 50 } }), FEATURE, plans)).toEqual({
      error: "plan_feature", feature: "automation", plan: "free", status: "active",
      message: "This organization's Free plan does not include this.", next: "upgrade",
    });
    // A billing org moved to Free: paid, and upgrade.
    expect(planFeatureRefusal(state("free", { source: "billing" }), FEATURE, plans)).toMatchObject({ plan: "free", paid: true, next: "upgrade" });
    // Neither does Personal or Enterprise here: no `next` (a granted plan asks Trov).
    for (const id of ["personal", "enterprise"] as const) {
      const r = planFeatureRefusal(state(id), FEATURE, plans);
      expect(r, id).toMatchObject({ error: "plan_feature", plan: id });
      expect(r, id).not.toHaveProperty("next");
    }
    // An ended plan includes nothing — even the one that lists it.
    expect(planFeatureRefusal(state("team", { status: "canceled", source: "billing" }), FEATURE, plans)).toEqual({
      error: "plan_feature", feature: "automation", plan: "team", status: "canceled",
      message: "This organization's Pro plan has ended, so nothing can be added until it is renewed.", paid: true,
    });
    expect(planFeatureRefusal(state("free", { status: "canceled" }), FEATURE, plans)).not.toHaveProperty("next");
    // A plan id that is not one reads as the fallback (Personal), which does not include it.
    expect(planFeatureRefusal(state("platinum" as PlanId), FEATURE, plans)).toMatchObject({ plan: "personal" });
    // The real table is untouched.
    expect(PLANS.team.features).toEqual([]);
  });

  it("requireFeature reads the org's own plan and throws PlanFeatureError (code `plan_feature`) carrying that refusal", async () => {
    const refusedWith = async (ctx: Parameters<typeof requireFeature>[0]) => {
      const err = await requireFeature(ctx, FEATURE).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(PlanFeatureError);
      expect((err as PlanFeatureError).code).toBe("plan_feature");
      expect((err as PlanFeatureError).message).toBe((err as PlanFeatureError).refusal.message);
      return (err as PlanFeatureError).refusal;
    };
    const free = await freeOrg("featfree");
    expect(await refusedWith(await tenantCtx(free.owner, undefined, { orgId: free.id, via: "bearer" }))).toEqual({
      error: "plan_feature", feature: "automation", plan: "free", status: "active",
      message: "This organization's Free plan does not include this.", next: "upgrade",
    });
    const paid = await orgOn("team", "featpaid");
    await exec(`UPDATE orgs SET plan_source = 'billing', plan_overrides = '{"seats":4}' WHERE id = ?`, paid.id);
    expect(await refusedWith(await tenantCtx(paid.owner, undefined, { orgId: paid.id, via: "bearer" }))).toEqual({
      error: "plan_feature", feature: "automation", plan: "team", status: "active",
      message: "This organization's Pro plan does not include this.", paid: true,
    });
    await cancelOrgPlan(platformCtx("billing"), "featpaid");
    expect(await refusedWith(await tenantCtx(paid.owner, undefined, { orgId: paid.id, via: "bearer" }))).toMatchObject({ status: "canceled", paid: true, message: expect.stringContaining("has ended") });
    // SaplingLearn (Enterprise, granted) is refused too: no plan includes any feature yet.
    expect(await refusedWith(await tenantCtx())).toEqual({
      error: "plan_feature", feature: "automation", plan: "enterprise", status: "active", message: "This organization's Enterprise plan does not include this.",
    });
  });
});

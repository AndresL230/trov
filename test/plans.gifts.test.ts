/**
 * Gifts (0048_plan_gifts, src/plans/gifts.ts; docs/architecture/plans.md › Gifts): a superadmin gives an
 * org a plan for free UNTIL A DATE, extends it, ends it now — and when the date passes the org moves to
 * Free by itself, nothing deleted. A grant carries the same thing as a length that starts counting when
 * the org is created. Also: what the org's people read, the owner paying before the end, and the migration.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { env, applyD1Migrations } from "cloudflare:test";
import { cookieFor, seedPerson } from "./helpers/persons";
import { ORG_A, ORG_B, ensureMember, platformCtx } from "./helpers/tenant";
import { call, one, rows, exec, SUPERADMIN } from "./helpers/orgs";
import { FakeStripe, bcall, deliver, event } from "./helpers/billing";
import type { Env } from "../src/env";
import type { MyOrgsResponse, PlatformOrgRow } from "@shared/orgs";
import { GIFT_MAX_DAYS, giftDaysLeft, giftEnd, giftLengthWords, type OrgPlanView, type PlatformGrant } from "@shared/plans";
import { expireGifts } from "../src/plans/gifts";
import { handleRepoCron } from "../src/repo/cron";

const DAY = 86_400_000;
const boss = () => cookieFor(SUPERADMIN);
const near = (iso: string | null | undefined, ms: number): boolean => !!iso && Math.abs(Date.parse(iso) - ms) < 60_000;
const count = async (sql: string, ...p: unknown[]) => (await one<{ n: number }>(sql, ...p))!.n;
type Row = { plan: string; plan_overrides: string; plan_source: string | null; plan_status: string; plan_gift_until: string | null; plan_changed_by: string | null };
const orgRow = (slug: string) => one<Row>(`SELECT plan, plan_overrides, plan_source, plan_status, plan_gift_until, plan_changed_by FROM orgs WHERE slug = ?`, slug);
const audit = (slug: string) => rows<{ actor: string; action: string; detail: string }>(
  `SELECT a.actor, a.action, a.detail FROM org_admin_audit a JOIN orgs o ON o.id = a.org_id WHERE o.slug = ? AND a.action LIKE 'plan.%' ORDER BY a.id`, slug);
const gift = async (slug: string, body: Record<string, unknown>) => call<{ ok: true; org: PlatformOrgRow; error?: string }>("PUT", `/api/platform/orgs/${slug}/plan`, await boss(), body);
const extend = async (slug: string, body: Record<string, unknown>) => call<{ ok: true; org: PlatformOrgRow; error?: string }>("POST", `/api/platform/orgs/${slug}/gift/extend`, await boss(), body);
const end = async (slug: string) => call<{ ok: true; org: PlatformOrgRow; error?: string }>("POST", `/api/platform/orgs/${slug}/gift/end`, await boss());
/** Put a gift's end in the past, as time passing would. */
const lapse = (slug: string, ago = DAY) => exec(`UPDATE orgs SET plan_gift_until = ? WHERE slug = ?`, new Date(Date.now() - ago).toISOString(), slug);
const sweep = () => expireGifts(platformCtx("system"), Date.now());

afterEach(() => { vi.unstubAllGlobals(); });

describe("giftEnd — a length from a request (shared/plans.ts)", () => {
  const now = Date.parse("2026-10-08T12:00:00.000Z");
  it("days count from now; a day runs to its end, UTC; an instant is taken as it is", () => {
    expect(giftEnd({ days: 60 }, now)).toBe("2026-12-07T12:00:00.000Z");
    expect(giftEnd({ until: "2026-12-31" }, now)).toBe("2026-12-31T23:59:59.999Z");
    expect(giftEnd({ until: "2026-11-01T00:00:00.000Z" }, now)).toBe("2026-11-01T00:00:00.000Z");
  });
  it("extending counts days from the current end — or from now, when that end has already passed", () => {
    expect(giftEnd({ days: 30 }, now, Date.parse("2026-12-07T12:00:00.000Z"))).toBe("2027-01-06T12:00:00.000Z");
    expect(giftEnd({ days: 30 }, now, now - 5 * DAY)).toBe("2026-11-07T12:00:00.000Z");
  });
  it("refuses neither, both, a past end, one too far away, a fraction, a day that does not exist", () => {
    for (const bad of [{}, null, "60", { days: 60, until: "2026-12-31" }, { days: 0 }, { days: 1.5 }, { days: "30" }, { days: GIFT_MAX_DAYS + 1 },
      { until: "2026-10-01" }, { until: "2031-01-01" }, { until: "2027-02-31" }, { until: "soon" }, { until: 5 }]) {
      expect(giftEnd(bad, now), JSON.stringify(bad)).toBeNull();
    }
    expect(giftEnd({ days: GIFT_MAX_DAYS }, now)).not.toBeNull();
  });
  it("days left round up; a length reads as its preset's name", () => {
    expect(giftDaysLeft("2026-10-15T12:00:00.000Z", now)).toBe(7);
    expect(giftDaysLeft("2026-10-08T12:00:01.000Z", now)).toBe(1);
    expect(giftDaysLeft("2026-10-08T11:00:00.000Z", now)).toBe(0);
    expect(giftDaysLeft(null, now)).toBeNull();
    expect([30, 90, 365, 45, 1].map(giftLengthWords)).toEqual(["1 month", "3 months", "12 months", "45 days", "1 day"]);
  });
});

describe("PUT /api/platform/orgs/:slug/plan { gift } — the superadmin gives a plan until a date", () => {
  it("puts the org on the plan with its seats and an end, and audits it as the superadmin", async () => {
    const r = await gift("acme", { plan: "team", overrides: { seats: 8 }, gift: { days: 60 } });
    expect(r.status).toBe(200);
    expect(r.json.org.plan).toMatchObject({ plan: "team", overrides: { seats: 8 }, source: "granted", status: "active" });
    expect(near(r.json.org.plan!.gift!.until, Date.now() + 60 * DAY)).toBe(true);
    const row = (await orgRow("acme"))!;
    expect(row).toMatchObject({ plan: "team", plan_overrides: '{"seats":8}', plan_source: "granted", plan_status: "active", plan_changed_by: SUPERADMIN });
    expect(row.plan_gift_until).toBe(r.json.org.plan!.gift!.until);
    expect(await audit("acme")).toEqual([{ actor: SUPERADMIN, action: "plan.gift", detail: expect.stringContaining(`"from":"enterprise","to":"team","overrides":{"seats":8},"source":"granted","until":"${row.plan_gift_until}"`) }]);
    // The list says so too; an org with no gift carries none.
    const list = (await call<{ orgs: PlatformOrgRow[] }>("GET", "/api/platform/orgs", await boss())).json.orgs;
    expect(list.find((o) => o.slug === "acme")!.plan!.gift).toEqual({ until: row.plan_gift_until });
    expect(list.find((o) => o.slug === "saplinglearn")!.plan!.gift).toBeNull();
  });

  it("takes a date: the gift runs to the end of that day", async () => {
    const day = new Date(Date.now() + 45 * DAY).toISOString().slice(0, 10);
    const r = await gift("acme", { plan: "enterprise", gift: { until: day } });
    expect(r.json.org.plan).toMatchObject({ plan: "enterprise", gift: { until: `${day}T23:59:59.999Z` } });
  });

  it("refuses Free, a bad length and a bad plan — and writes nothing", async () => {
    const cases: [Record<string, unknown>, number, string][] = [
      [{ plan: "free", gift: { days: 30 } }, 400, "invalid_gift"],
      [{ plan: "team", gift: { days: 0 } }, 400, "invalid_gift"],
      [{ plan: "team", gift: { days: GIFT_MAX_DAYS + 1 } }, 400, "invalid_gift"],
      [{ plan: "team", gift: { days: 30, until: "2030-01-01" } }, 400, "invalid_gift"],
      [{ plan: "team", gift: { until: "2020-01-01" } }, 400, "invalid_gift"],
      [{ plan: "team", gift: {} }, 400, "invalid_gift"],
      [{ plan: "gold", gift: { days: 30 } }, 400, "invalid_plan"],
      [{ plan: "team", overrides: { seats: 0 }, gift: { days: 30 } }, 400, "invalid_overrides"],
    ];
    for (const [body, status, code] of cases) {
      const r = await gift("acme", body);
      expect([r.status, r.json.error], JSON.stringify(body)).toEqual([status, code]);
    }
    expect((await gift("no-such-org", { plan: "team", gift: { days: 30 } })).status).toBe(404);
    expect(await orgRow("acme")).toMatchObject({ plan: "enterprise", plan_gift_until: null });
    expect(await audit("acme")).toEqual([]);
  });

  it("is the superadmin's alone: anyone else gets the surface's 404, an org owner included", async () => {
    await gift("acme", { plan: "team", gift: { days: 30 } });
    const before = await orgRow("acme");
    await ensureMember("maya", "owner", ORG_B);
    for (const cookie of [await cookieFor("maya"), await cookieFor("omar", { member: false })]) {
      expect((await call("PUT", "/api/platform/orgs/acme/plan", cookie, { plan: "enterprise", gift: { days: 365 } })).status).toBe(404);
      expect((await call("POST", "/api/platform/orgs/acme/gift/extend", cookie, { days: 365 })).status).toBe(404);
      expect((await call("POST", "/api/platform/orgs/acme/gift/end", cookie)).status).toBe(404);
    }
    // …and never with a bearer header, like the rest of /api/platform.
    expect((await call("POST", "/api/platform/orgs/acme/gift/end", await boss(), undefined, { headers: { authorization: "Bearer canopy_mcp_x" } })).status).not.toBe(200);
    expect(await orgRow("acme")).toEqual(before);
  });

  it("a plan set by hand afterwards has no end: Change plan clears the gift, and says so in the audit row", async () => {
    await gift("acme", { plan: "team", gift: { days: 30 } });
    const until = (await orgRow("acme"))!.plan_gift_until;
    const r = await gift("acme", { plan: "team", overrides: { seats: 12 } });
    expect(r.json.org.plan).toMatchObject({ plan: "team", overrides: { seats: 12 }, gift: null });
    expect((await orgRow("acme"))!.plan_gift_until).toBeNull();
    expect((await audit("acme")).at(-1)).toEqual({ actor: SUPERADMIN, action: "plan.overrides", detail: expect.stringContaining(`"gift_cleared":"${until}"`) });
    expect(await sweep()).toEqual({ expired: 0, cleared: 0, failed: 0 });
  });
});

describe("extend and end now", () => {
  it("extend adds days to the CURRENT end, or sets a date; the plan and its limits stay", async () => {
    await gift("acme", { plan: "team", overrides: { seats: 8 }, gift: { days: 30 } });
    const first = (await orgRow("acme"))!.plan_gift_until!;
    const more = await extend("acme", { days: 60 });
    expect(more.status).toBe(200);
    expect(more.json.org.plan!.gift!.until).toBe(new Date(Date.parse(first) + 60 * DAY).toISOString());
    expect(await orgRow("acme")).toMatchObject({ plan: "team", plan_overrides: '{"seats":8}', plan_source: "granted" });
    const day = new Date(Date.now() + 200 * DAY).toISOString().slice(0, 10);
    expect((await extend("acme", { until: day })).json.org.plan!.gift).toEqual({ until: `${day}T23:59:59.999Z` });
    expect((await audit("acme")).map((a) => a.action)).toEqual(["plan.gift", "plan.gift", "plan.gift"]);
    expect((await audit("acme"))[1].detail).toContain(`"extended_from":"${first}"`);
  });

  it("extend refuses a bad length (400) and an org with no gift (409 not_gifted)", async () => {
    expect((await extend("acme", { days: 30 })).json).toMatchObject({ error: "not_gifted" });
    await gift("acme", { plan: "team", gift: { days: 30 } });
    expect((await extend("acme", { days: 0 })).json).toMatchObject({ error: "invalid_gift" });
    expect((await extend("acme", { until: "2020-01-01" })).json).toMatchObject({ error: "invalid_gift" });
    expect((await extend("acme", { days: GIFT_MAX_DAYS })).json).toMatchObject({ error: "invalid_gift" }); // past three years from now
    expect((await extend("nope", { days: 30 })).status).toBe(404);
  });

  it("end now moves the org to Free at once, deletes nothing, and can only be done once", async () => {
    await gift("saplinglearn", { plan: "team", overrides: { seats: 20 }, gift: { days: 90 } });
    const members = await count(`SELECT COUNT(*) AS n FROM memberships WHERE org_id = ?`, ORG_A);
    const r = await end("saplinglearn");
    expect(r.status).toBe(200);
    expect(r.json.org.plan).toMatchObject({ plan: "free", overrides: {}, status: "active", source: "granted", gift: null });
    expect(await count(`SELECT COUNT(*) AS n FROM memberships WHERE org_id = ?`, ORG_A)).toBe(members);
    expect((await audit("saplinglearn")).at(-1)).toEqual({ actor: SUPERADMIN, action: "plan.gift_end", detail: expect.stringContaining(`"from":"team","to":"free"`) });
    expect((await audit("saplinglearn")).at(-1)!.detail).toContain(`"reason":"ended"`);
    expect((await end("saplinglearn")).json).toMatchObject({ error: "not_gifted" });
    expect((await end("acme")).status).toBe(409);
    expect(await audit("saplinglearn")).toHaveLength(2);
  });
});

describe("expireGifts — the date passes", () => {
  it("moves a lapsed gift to Free exactly once; a second and a late run change nothing; a gift still running is left alone", async () => {
    await gift("saplinglearn", { plan: "team", overrides: { seats: 20 }, gift: { days: 30 } });
    await gift("acme", { plan: "team", gift: { days: 30 } });
    const running = (await orgRow("acme"))!;
    const members = await count(`SELECT COUNT(*) AS n FROM memberships WHERE org_id = ?`, ORG_A);
    expect(await sweep()).toEqual({ expired: 0, cleared: 0, failed: 0 }); // nothing is due yet
    await lapse("saplinglearn");
    const lapsed = (await orgRow("saplinglearn"))!.plan_gift_until;

    expect(await sweep()).toEqual({ expired: 1, cleared: 0, failed: 0 });
    expect(await orgRow("saplinglearn")).toEqual({ plan: "free", plan_overrides: "{}", plan_source: "granted", plan_status: "active", plan_gift_until: null, plan_changed_by: "system" });
    expect(await orgRow("acme")).toEqual(running);
    // Nothing deleted, nobody removed.
    expect(await count(`SELECT COUNT(*) AS n FROM memberships WHERE org_id = ?`, ORG_A)).toBe(members);
    const ended = (await audit("saplinglearn")).filter((a) => a.action === "plan.gift_end");
    expect(ended).toEqual([{ actor: "system", action: "plan.gift_end", detail: JSON.stringify({ from: "team", to: "free", until: lapsed, reason: "expired" }) }]);

    expect(await sweep()).toEqual({ expired: 0, cleared: 0, failed: 0 });
    expect(await expireGifts(platformCtx("system"), Date.now() + 5 * DAY)).toEqual({ expired: 0, cleared: 0, failed: 0 });
    expect((await audit("saplinglearn")).filter((a) => a.action === "plan.gift_end")).toHaveLength(1);
  });

  it("the over-limit rule is all that applies afterwards: everyone reads, an addition over a Free limit is refused", async () => {
    await gift("saplinglearn", { plan: "team", gift: { days: 30 } });
    await lapse("saplinglearn");
    await sweep();
    const owner = await boss();
    const view = (await call<OrgPlanView>("GET", "/api/o/saplinglearn/plan", owner)).json;
    expect(view).toMatchObject({ plan: "free", status: "active", gift_until: null });
    expect(view.over).toContain("seats"); // six seeded people on Free's three seats: nobody was removed
    const refused = await call<{ error: string; limit: string; next?: string }>("POST", "/api/o/saplinglearn/invites", owner, { email: "late@example.com", role: "member" });
    expect([refused.status, refused.json.error, refused.json.limit, refused.json.next]).toEqual([402, "plan_limit", "seats", "upgrade"]);
  });

  it("an org that pays through Stripe keeps its paid plan: the lapsed gift is only cleared", async () => {
    await exec(`UPDATE orgs SET plan = 'team', plan_overrides = '{"seats":6}', plan_source = 'billing', billing_subscription_id = 'sub_x', billing_customer_id = 'cus_x', plan_gift_until = ? WHERE slug = 'acme'`,
      new Date(Date.now() - DAY).toISOString());
    expect(await sweep()).toEqual({ expired: 0, cleared: 1, failed: 0 });
    expect(await orgRow("acme")).toMatchObject({ plan: "team", plan_overrides: '{"seats":6}', plan_source: "billing", plan_status: "active", plan_gift_until: null });
    expect(await audit("acme")).toEqual([{ actor: "system", action: "plan.gift_end", detail: expect.stringContaining(`"kept":"team"`) }]);
    expect((await audit("acme"))[0].detail).toContain(`"reason":"paid"`);
    expect(await sweep()).toEqual({ expired: 0, cleared: 0, failed: 0 });
  });

  it("a gift extended, or a plan changed, between the read and the write is left alone (the statement is guarded)", async () => {
    await gift("acme", { plan: "team", gift: { days: 30 } });
    await lapse("acme");
    // The cutoff this run was given is BEFORE the gift's end: nothing is due, whatever the row said a moment ago.
    expect(await expireGifts(platformCtx("system"), Date.now() - 3 * DAY)).toEqual({ expired: 0, cleared: 0, failed: 0 });
    expect(await orgRow("acme")).toMatchObject({ plan: "team" });
  });

  it("rides the repo cron's every tick (no new cron), twice in a row, and never throws out of it", async () => {
    await gift("acme", { plan: "team", gift: { days: 30 } });
    await lapse("acme");
    const noNetwork = (async () => { throw new Error("the gift sweep reached the network"); }) as unknown as typeof fetch;
    const tick = Date.now();
    await handleRepoCron(env as unknown as Env, tick, noNetwork);
    expect(await orgRow("acme")).toMatchObject({ plan: "free", plan_gift_until: null, plan_changed_by: "system" });
    await handleRepoCron(env as unknown as Env, tick + 600_000, noNetwork);
    expect((await audit("acme")).filter((a) => a.action === "plan.gift_end")).toHaveLength(1);
    // A broken database is a counted failure, not an exception.
    const broken = platformCtx("system", { ...(env as unknown as Env), DB: { prepare() { throw new Error("d1 down"); } } as unknown as Env["DB"] });
    expect(await expireGifts(broken, Date.now())).toEqual({ expired: 0, cleared: 0, failed: 1 });
  });
});

describe("a grant that is a gift — the clock starts when the org is created", () => {
  const grant = async (body: Record<string, unknown>) => call<{ ok: true; grant: PlatformGrant; error?: string }>("POST", "/api/platform/grants", await boss(), body);

  it("carries the length in days; the org it becomes ends that long after its creation", async () => {
    await seedPerson("maya", { member: false });
    const g = await grant({ to: { handle: "maya" }, plan: "team", overrides: { seats: 10 }, gift_days: 90 });
    expect(g.status).toBe(201);
    expect(g.json.grant).toMatchObject({ plan: "team", gift_days: 90, status: "unused" });
    expect(await one(`SELECT gift_days FROM org_grants WHERE id = ?`, g.json.grant.id)).toEqual({ gift_days: 90 });
    expect((await rows<{ detail: string }>(`SELECT detail FROM org_admin_audit WHERE action = 'grant.create'`))[0].detail).toContain(`"gift_days":90`);
    // Nothing is counting yet: the grant has no end date of its own, only a length.
    await exec(`UPDATE org_grants SET created_at = ? WHERE id = ?`, new Date(Date.now() - 40 * DAY).toISOString(), g.json.grant.id);

    const cookie = await cookieFor("maya", { member: false });
    expect((await call<MyOrgsResponse>("GET", "/api/orgs", cookie)).json.grants).toMatchObject([{ id: g.json.grant.id, gift_days: 90 }]);
    expect((await call("POST", "/api/orgs", cookie, { slug: "maya-co", name: "Maya Co" })).status).toBe(201);
    const row = (await orgRow("maya-co"))!;
    expect(row).toMatchObject({ plan: "team", plan_overrides: '{"seats":10}', plan_source: "granted" });
    expect(near(row.plan_gift_until, Date.now() + 90 * DAY)).toBe(true);
    expect((await audit("maya-co")).filter((a) => a.action === "plan.gift")).toEqual([
      { actor: "maya", action: "plan.gift", detail: expect.stringContaining(`"days":90,"grant":${g.json.grant.id},"by":"${SUPERADMIN}"`) },
    ]);
    expect((await call<OrgPlanView>("GET", "/api/o/maya-co/plan", cookie)).json.gift_until).toBe(row.plan_gift_until);
    // …and it ends like any gift.
    await lapse("maya-co");
    expect(await sweep()).toEqual({ expired: 1, cleared: 0, failed: 0 });
    expect(await orgRow("maya-co")).toMatchObject({ plan: "free", plan_overrides: "{}", plan_gift_until: null });
  });

  it("a grant with no length makes an org with no end, as before", async () => {
    await seedPerson("omar", { member: false });
    const g = await grant({ to: { handle: "omar" }, plan: "team" });
    expect(g.json.grant.gift_days).toBeNull();
    expect((await call("POST", "/api/orgs", await cookieFor("omar", { member: false }), { slug: "omar-co", name: "Omar Co" })).status).toBe(201);
    expect((await orgRow("omar-co"))!.plan_gift_until).toBeNull();
  });

  it("refuses a bad length, and a gift of Free", async () => {
    for (const body of [{ plan: "team", gift_days: 0 }, { plan: "team", gift_days: 2.5 }, { plan: "team", gift_days: "90" }, { plan: "team", gift_days: GIFT_MAX_DAYS + 1 }, { plan: "free", gift_days: 30 }]) {
      const r = await grant({ to: { email: "a@b.io" }, ...body });
      expect([r.status, r.json.error], JSON.stringify(body)).toEqual([400, "invalid_grant"]);
    }
    expect(await count(`SELECT COUNT(*) AS n FROM org_grants`)).toBe(0);
  });

  it("the notice mail of an e-mail grant says how long it is free, and what happens after", async () => {
    const g = await grant({ to: { email: "founder@x.io" }, plan: "team", gift_days: 90 });
    expect(g.json.grant.mail_status).toBe("sent");
    const [mail] = await rows<{ text: string; html: string }>(`SELECT text, html FROM platform_outbox_bodies`);
    const said = "It is free for 3 months from the day you set it up; after that it moves to the Free plan, and nothing is deleted.";
    expect(mail.text).toContain(said);
    expect(mail.html).toContain(said);
  });
});

describe("what the org's people read, and paying before the end", () => {
  const planOf = async (slug: string, cookie: string, billing = false) =>
    (billing ? await bcall<OrgPlanView>("GET", `/api/o/${slug}/plan`, cookie) : await call<OrgPlanView>("GET", `/api/o/${slug}/plan`, cookie)).json;

  it("GET /api/o/:slug/plan serves the gift's end — and null, never a guessed date, for a plan that is not one", async () => {
    await ensureMember("maya", "owner", ORG_B);
    const cookie = await cookieFor("maya");
    expect(await planOf("acme", cookie)).toMatchObject({ plan: "enterprise", gift_until: null, billing: null });
    await gift("acme", { plan: "team", gift: { days: 60 } });
    const view = await planOf("acme", cookie);
    expect(view).toMatchObject({ plan: "team", source: "granted", gift_until: (await orgRow("acme"))!.plan_gift_until });
    // Billing is off on this deployment: there is nothing to pay with, so nothing about payment is offered.
    expect(view.billing).toMatchObject({ gifted: true, available: false, subscribed: false, upgrade_to: [] });
    // A member reads the same.
    expect((await planOf("acme", await cookieFor("zoe", { member: false }).then(async (c) => { await ensureMember("zoe", "member", ORG_B); return c; }))).gift_until).toBe(view.gift_until);
  });

  it("the owner may start paying before the gift ends: the paid plan takes over and the gift is cleared, with no lapse", async () => {
    const stripe = new FakeStripe();
    vi.stubGlobal("fetch", stripe.fetch);
    await ensureMember("maya", "owner", ORG_B);
    const cookie = await cookieFor("maya", { email: "maya@example.com", verified: true });
    // Not a gift, not Free: the upgrade is refused as before.
    expect((await bcall("POST", "/api/o/acme/billing/upgrade", cookie, {})).json).toMatchObject({ error: "not_free" });

    await gift("acme", { plan: "team", overrides: { seats: 25 }, gift: { days: 30 } });
    expect((await planOf("acme", cookie, true)).billing).toMatchObject({ gifted: true, available: true, subscribed: false, ended: false, customer: false, upgrade_to: ["team"] });
    // Only the owner.
    await ensureMember("omar", "admin", ORG_B);
    expect((await bcall("POST", "/api/o/acme/billing/upgrade", await cookieFor("omar"), {})).status).toBe(403);

    const r = await bcall<{ url: string }>("POST", "/api/o/acme/billing/upgrade", cookie, {});
    expect(r.status).toBe(200);
    const session = stripe.lastSession();
    expect(r.json.url).toBe(session.url);
    const sub = stripe.pay(session.id, 4);
    expect((await deliver(event("checkout.session.completed", stripe.sessionJson(session)))).json).toEqual({ ok: true, outcome: "org_upgraded" });
    expect(await orgRow("acme")).toMatchObject({ plan: "team", plan_overrides: '{"seats":4}', plan_source: "billing", plan_status: "active", plan_gift_until: null });
    expect(await one(`SELECT billing_subscription_id FROM orgs WHERE slug = 'acme'`)).toEqual({ billing_subscription_id: sub.id });
    const view = await planOf("acme", cookie, true);
    expect(view.gift_until).toBeNull();
    expect(view.billing).toMatchObject({ subscribed: true, seats: 4 });
    expect(view.billing!.gifted).toBeUndefined();
    // The date that would have ended the gift now ends nothing.
    expect(await expireGifts(platformCtx("system"), Date.now() + 60 * DAY)).toEqual({ expired: 0, cleared: 0, failed: 0 });
    expect(await orgRow("acme")).toMatchObject({ plan: "team", plan_source: "billing" });
    // …and an org on a live subscription cannot be given a gift.
    expect((await gift("acme", { plan: "enterprise", gift: { days: 30 } })).json).toMatchObject({ error: "billed" });
    expect((await extend("acme", { days: 30 })).json).toMatchObject({ error: "not_gifted" });
  });
});

describe("migration 0048_plan_gifts", () => {
  const db = () => env.MT_DB;
  async function wipe(): Promise<void> {
    const objs = (await db().prepare(`SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'`).all<{ type: string; name: string; sql: string | null }>()).results;
    if (!objs.length) return;
    const virtual = objs.filter((o) => o.type === "table" && /VIRTUAL TABLE/i.test(o.sql ?? "")).map((o) => o.name);
    const plain = objs.filter((o) => o.type === "table" && !virtual.includes(o.name) && !virtual.some((v) => o.name.startsWith(`${v}_`))).map((o) => o.name);
    await db().batch([
      db().prepare("PRAGMA defer_foreign_keys = true"),
      ...objs.filter((o) => o.type === "trigger").map((o) => db().prepare(`DROP TRIGGER IF EXISTS "${o.name}"`)),
      ...virtual.map((v) => db().prepare(`DROP TABLE IF EXISTS "${v}"`)),
      ...plain.map((t) => db().prepare(`DROP TABLE IF EXISTS "${t}"`)),
      db().prepare("PRAGMA defer_foreign_keys = false"),
    ]);
  }

  it("adds the columns over live rows without touching them: every org and grant has no gift", async () => {
    await wipe();
    await applyD1Migrations(db(), env.TEST_MIGRATIONS.filter((m) => m.name < "0048"));
    await db().batch([
      db().prepare(`INSERT INTO persons (handle, name, color, created_at, onboarded_at) VALUES ('p1', 'p1', 'stone', 't', 't')`),
      db().prepare(`INSERT INTO orgs (id, slug, name, created_at, created_by, plan, plan_overrides, plan_source, plan_status) VALUES ('org_pro', 'pro', 'Pro Co', 't', 'p1', 'team', '{"seats":9}', 'billing', 'past_due')`),
      db().prepare(`INSERT INTO org_grants (person, plan, granted_by, created_at) VALUES ('p1', 'team', 'p1', 't')`),
    ]);
    const orgsBefore = (await db().prepare(`SELECT * FROM orgs ORDER BY id`).all()).results;
    const grantsBefore = (await db().prepare(`SELECT * FROM org_grants ORDER BY id`).all()).results;
    // What the Worker from before this migration does keeps working after it: it names none of the new columns.
    const oldWrite = `UPDATE orgs SET plan_status = 'active' WHERE id = 'org_pro'`;

    await applyD1Migrations(db(), env.TEST_MIGRATIONS.filter((m) => m.name.startsWith("0048")));

    const orgsAfter = (await db().prepare(`SELECT * FROM orgs ORDER BY id`).all<Record<string, unknown>>()).results;
    expect(orgsAfter.map(({ plan_gift_until: _g, ...rest }) => rest)).toEqual(orgsBefore);
    expect(orgsAfter.every((o) => o.plan_gift_until === null)).toBe(true);
    const grantsAfter = (await db().prepare(`SELECT * FROM org_grants ORDER BY id`).all<Record<string, unknown>>()).results;
    expect(grantsAfter.map(({ gift_days: _d, ...rest }) => rest)).toEqual(grantsBefore);
    expect(grantsAfter.every((g) => g.gift_days === null)).toBe(true);
    await db().prepare(oldWrite).run();
    await db().prepare(`INSERT INTO org_grants (person, plan, granted_by, created_at) VALUES ('p1', 'team', 'p1', 't2')`).run();
    // The new column's own guard, and the index the expiry reads.
    await expect(db().prepare(`INSERT INTO org_grants (person, plan, granted_by, created_at, gift_days) VALUES ('p1', 'team', 'p1', 't3', 0)`).run()).rejects.toThrow(/CHECK/);
    expect(await db().prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_orgs_plan_gift'`).first()).toEqual({ name: "idx_orgs_plan_gift" });
    // Leave the scratch database whole for whoever uses it next.
    await applyD1Migrations(db(), env.TEST_MIGRATIONS);
  });

  it("is additive only: nullable columns and an index — no DROP, no rebuild, no rename, no rewrite of a row", async () => {
    const sql = (await import("../migrations/0048_plan_gifts.sql?raw")).default.replace(/--.*$/gm, "");
    expect(sql).not.toMatch(/\bDROP\b|\bRENAME\b|\bDELETE\b|\bUPDATE\b/i);
    const stmts = sql.split(";").map((s) => s.trim()).filter(Boolean);
    expect(stmts).toHaveLength(3);
    for (const s of stmts) expect(s, s.slice(0, 60)).toMatch(/^(ALTER TABLE (orgs|org_grants) ADD COLUMN|CREATE INDEX IF NOT EXISTS)/);
    // Every added column is nullable with no default: an existing row needs nothing written to it.
    for (const s of stmts.filter((x) => x.startsWith("ALTER"))) expect(s).not.toMatch(/NOT NULL|DEFAULT/i);
  });
});

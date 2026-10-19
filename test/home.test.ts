/**
 * GET /home — Home's one server read (src/tools/home.ts, shared/home-core.ts): the org's activity per LOCAL day over
 * HOME_DAYS (tickets set done, handoffs claimed, doc versions promoted, sessions recorded), Docs promoted unknown
 * ("null") before 0077_home timed promotions, the team and what each is on, the repositories with their last push, and
 * the backlog / Triage counts. Tenant-bound, tz-validated, a failed read a 503 `{ error }`.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { systemCtx, platformCtx } from "./helpers/tenant";
import { app } from "../src/routes";
import { createSession } from "../src/auth/session";
import { hmacSeal } from "../src/auth/crypto";
import { homeData } from "../src/tools/home";
import { promote_doc } from "../src/tools/writes";
import { HOME_DAYS, homeSum, type HomeData } from "@shared/home-core";

// "Now": Saturday 2026-10-17, 15:00 UTC — the last day of the window is 2026-10-17 in UTC.
const NOW = Date.parse("2026-10-17T15:00:00.000Z");
const ORG = "org_saplinglearn";

async function cookieFor(login: string): Promise<string> {
  const { id } = await createSession(platformCtx(), login);
  return `session=${await hmacSeal(id, "test-cookie-secret")}`;
}
const q = (sql: string, ...args: unknown[]) => env.DB.prepare(sql).bind(...args).run();

let n = 1;
async function ticket(o: { status?: string; sprint?: number | null; assignee?: string; title?: string; created?: string; updated?: string; org?: string } = {}): Promise<number> {
  const id = n++;
  await q(`INSERT INTO tickets (id, org_id, number, title, status, requester, sprint_id, created_at, updated_at, source) VALUES (?, ?, ?, ?, ?, 'AndresL230', ?, ?, ?, 'canopy')`,
    id, o.org ?? ORG, id, o.title ?? `Ticket ${id}`, o.status ?? "submitted", o.sprint ?? null, o.created ?? "2026-10-01T00:00:00.000Z", o.updated ?? "2026-10-01T00:00:00.000Z");
  if (o.assignee) await q(`INSERT INTO ticket_assignees (org_id, ticket_id, login) VALUES (?, ?, ?)`, o.org ?? ORG, id, o.assignee);
  return id;
}
const done = (ticketId: number, at: string, actor = "AndresL230", org = ORG) =>
  q(`INSERT INTO ticket_events (org_id, ticket_id, actor, from_status, to_status, created_at) VALUES (?, ?, ?, 'in_progress', 'done', ?)`, org, ticketId, actor, at);
const handoff = (claimedAt: string | null, by = "meilin", org = ORG) =>
  q(`INSERT INTO handoffs (org_id, number, sender, recipient, status, body, created_at, claimed_at, claimed_by, expires_at) VALUES (?, ?, 'AndresL230', 'meilin', ?, 'Do the thing', '2026-10-10T00:00:00.000Z', ?, ?, '2026-12-01T00:00:00.000Z')`,
    org, n++, claimedAt ? "claimed" : "pending", claimedAt, claimedAt ? by : null);
const feed = (author: string, at: string, origin: "agent" | "ai" = "agent", summary = "Shipped: a thing") =>
  q(`INSERT INTO feed (org_id, author, summary, created_at, origin) VALUES (?, ?, ?, ?, ?)`, ORG, author, summary, at, origin);
const docRow = (slug: string) => q(`INSERT INTO docs (org_id, slug, section, title, body) VALUES (?, ?, 'reference', ?, 'b')`, ORG, slug, slug);
const promoted = async (at: string, slug = `d${n++}`) => (await docRow(slug), q(`INSERT INTO doc_versions (org_id, slug, version, body, status, created_at, created_by, promoted_at) VALUES (?, ?, 1, 'b', 'promoted', ?, 'AndresL230', ?)`, ORG, slug, at, at));
const timed = (at: string | null) => q(`UPDATE orgs SET promotions_timed_at = ? WHERE id = ?`, at, ORG);

describe("homeData", () => {
  beforeEach(() => timed("2000-01-01T00:00:00.000Z"));

  it("counts each figure per local day over HOME_DAYS days, the last one today, zero days included", async () => {
    const a = await ticket(), b = await ticket();
    await done(a, "2026-10-17T09:00:00.000Z");
    await done(a, "2026-10-17T10:00:00.000Z"); // the same ticket set done twice that day counts once
    await done(b, "2026-10-15T09:00:00.000Z");
    await handoff("2026-10-16T12:00:00.000Z");
    await handoff(null); // pending: not claimed
    await promoted("2026-10-17T01:00:00.000Z");
    await feed("meilin", "2026-10-17T08:00:00.000Z");
    await feed("trov", "2026-10-17T08:00:00.000Z", "ai"); // Trov's digest is not a session
    const h = await homeData(systemCtx(), { now: NOW });
    expect(h.days).toHaveLength(HOME_DAYS);
    expect(h.days.at(-1)).toEqual({ date: "2026-10-17", tickets: 1, handoffs: 0, docs: 1, sessions: 1 });
    expect(h.days.at(-2)).toEqual({ date: "2026-10-16", tickets: 0, handoffs: 1, docs: 0, sessions: 0 });
    expect(h.days.at(-3)?.tickets).toBe(1);
    expect(homeSum(h.days, "tickets", 7)).toBe(2);
    expect(homeSum(h.days, "tickets", 7, 7)).toBe(0);
  });

  it("buckets into the viewer's local days with a tz offset", async () => {
    const a = await ticket();
    await done(a, "2026-10-17T02:00:00.000Z"); // 22:00 on the 16th in UTC-4
    const local = await homeData(systemCtx(), { now: NOW, tzOffsetMin: -240 });
    expect(local.days.at(-1)?.date).toBe("2026-10-17");
    expect(local.days.at(-2)?.tickets).toBe(1);
    expect(local.days.at(-1)?.tickets).toBe(0);
  });

  it("never guesses Docs promoted: a day before promotions were timed is null, the days after it are counted", async () => {
    await timed("2026-10-15T13:00:00.000Z"); // 0077_home ran mid-day on the 15th
    await promoted("2026-10-16T09:00:00.000Z");
    const h = await homeData(systemCtx(), { now: NOW });
    expect(h.days.find((d) => d.date === "2026-10-15")?.docs).toBeNull();
    expect(h.days.find((d) => d.date === "2026-10-14")?.docs).toBeNull();
    expect(h.days.find((d) => d.date === "2026-10-16")?.docs).toBe(1);
    expect(h.days.at(-1)?.docs).toBe(0);
    expect(homeSum(h.days, "docs", 7)).toBeNull(); // a window with an unknown day is unknown
    expect(homeSum(h.days, "docs", 2)).toBe(1);
  });

  it("an org made after promotions were timed (NULL marker) counts from the start: zero is known", async () => {
    await timed(null);
    const h = await homeData(systemCtx(), { now: NOW });
    expect(h.days.every((d) => d.docs === 0)).toBe(true);
  });

  it("the team: every member, what each is on (a ticket in progress first, else their newest entry) and when they were last seen", async () => {
    await ticket({ status: "in_progress", assignee: "meilin", title: "Write the onboarding copy", updated: "2026-10-16T00:00:00.000Z" });
    await ticket({ status: "submitted", assignee: "sanaok", title: "Not started" });
    await feed("sanaok", "2026-10-15T08:00:00.000Z", "agent", "Decision: **Pricing** copy moves to the site");
    await feed("sanaok", "2026-10-14T08:00:00.000Z", "agent", "Older entry");
    const h = await homeData(systemCtx(), { now: NOW });
    const by = new Map(h.team.map((t) => [t.handle, t]));
    expect([...by.keys()]).toContain("AndresL230");
    expect(by.has("trov")).toBe(false); // reserved handles are not members
    expect(by.get("meilin")?.on).toMatch(/^#\d+ Write the onboarding copy$/);
    expect(by.get("sanaok")?.on).toBe("Decision: Pricing copy moves to the site");
    expect(by.get("sanaok")?.at).toBe("2026-10-15T08:00:00.000Z");
    expect(by.get("AndresL230")?.at).toBeNull();
  });

  it("repositories with their last push (a push with no repository named is the primary's), backlog and Triage", async () => {
    await q(`INSERT INTO org_repos (org_id, repo_full_name, is_primary, created_at, created_by) VALUES (?, 'acme/app', 1, '2026-10-01', 'AndresL230'), (?, 'acme/docs', 0, '2026-10-01', 'AndresL230')`, ORG, ORG);
    await q(`INSERT INTO repo_events (org_id, repo, semantic_key, kind, raw, provenance, occurred_at, recorded_at) VALUES (?, '', 'p1', 'push', '{}', 'webhook', '2026-10-17T10:00:00.000Z', '2026-10-17T10:00:00.000Z')`, ORG);
    await ticket({ status: "in_progress", sprint: null });
    await ticket({ status: "done", sprint: null }); // closed: not backlog
    await ticket({ status: "submitted", created: "2026-10-02T00:00:00.000Z" });
    await ticket({ status: "submitted", assignee: "meilin" }); // assigned: not waiting in Triage
    const h = await homeData(systemCtx(), { now: NOW });
    expect(h.repos).toEqual([
      { repo: "acme/app", primary: true, lastPush: "2026-10-17T10:00:00.000Z", accessLost: false },
      { repo: "acme/docs", primary: false, lastPush: null, accessLost: false },
    ]);
    expect(h.backlog).toBe(3);
    expect(h.triage).toEqual({ count: 1, oldest: "2026-10-02T00:00:00.000Z" });
  });

  it("reads only its own organization", async () => {
    const a = await ticket({ org: "org_b" });
    await done(a, "2026-10-17T09:00:00.000Z", "AndresL230", "org_b");
    await handoff("2026-10-17T09:00:00.000Z", "meilin", "org_b");
    const h = await homeData(systemCtx(), { now: NOW });
    expect(homeSum(h.days, "tickets", 7)).toBe(0);
    expect(homeSum(h.days, "handoffs", 7)).toBe(0);
    expect(h.backlog).toBe(0);
  });
});

describe("promote_doc times the promotion (0077_home)", () => {
  it("sets promoted_at when a staged version is promoted", async () => {
    await docRow("timed");
    await q(`INSERT INTO doc_versions (org_id, slug, version, body, status, created_at, created_by) VALUES (?, 'timed', 1, 'body', 'staged', '2026-10-01T00:00:00.000Z', 'AndresL230')`, ORG);
    await promote_doc(systemCtx(), "timed", 1, "AndresL230");
    const row = await env.DB.prepare(`SELECT status, promoted_at FROM doc_versions WHERE org_id = ? AND slug = 'timed'`).bind(ORG).first<{ status: string; promoted_at: string | null }>();
    expect(row?.status).toBe("promoted");
    expect(row?.promoted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("GET /home", () => {
  it("needs a session", async () => {
    expect((await app.request("/home", {}, env)).status).toBe(401);
  });

  it("returns Home's shape for the signed-in member's org", async () => {
    const res = await app.request("/home?tz=-240", { headers: { cookie: await cookieFor("meilin") } }, env);
    expect(res.status).toBe(200);
    const body = await res.json() as HomeData;
    expect(body.days).toHaveLength(HOME_DAYS);
    expect(body).toMatchObject({ backlog: 0, triage: { count: 0, oldest: null }, repos: [] });
    expect(body.team.map((t) => t.handle)).toContain("meilin");
  });

  it("refuses a bad tz with a 400 { error }", async () => {
    const cookie = await cookieFor("meilin");
    for (const tz of ["900", "1.5", "x", "-841"]) {
      const res = await app.request(`/home?tz=${tz}`, { headers: { cookie } }, env);
      expect(res.status, tz).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBeTruthy();
    }
  });

  it("a failed read is a 503 { error }, never a 500", async () => {
    const cookie = await cookieFor("meilin");
    const realPrepare = env.DB.prepare.bind(env.DB);
    const DB = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") return (sql: string) => { if (/FROM ticket_events/.test(sql)) throw new Error("D1 is down"); return realPrepare(sql); };
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const res = await app.request("/home", { headers: { cookie } }, { ...env, DB });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Couldn't read Home" });
  });
});

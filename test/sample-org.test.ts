/**
 * The Sample workspace (0087_sample_orgs; src/orgs/sample.ts; organizations.md › 1e): every new person gets one at
 * onboarding — an org they own, on Free, filled with made-up content — so they (and a connector reviewer coming in
 * through MCP OAuth) can try every tool with nothing set up. It must not use up their one Free org, must be inert (no
 * job, no model, no mail, nothing outbound), and must go whole with the existing delete-an-organization flow.
 */
import { describe, it, expect } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { app } from "../src/routes";
import type { Env } from "../src/env";
import { sealOnboard, ONBOARD_COOKIE, type OnboardPayload } from "../src/auth/onboard";
import { createSampleOrg, reachesOutside, sampleSlug } from "../src/orgs/sample";
import * as C from "../src/orgs/sample-content";
import { parsePlanNarrative } from "@shared/sprints-core";
import { HANDLE_COLUMNS, renamePerson } from "../src/auth/persons";
import { handleRepoCron } from "../src/repo/cron";
import { handleNotificationCron, DAILY_CRON } from "../src/notifications/cron";
import { expireDueHandoffs } from "../src/platform/sweeps";
import { REGISTRY } from "../src/notifications/registry";
import { all, first, run } from "./helpers/db";
import { cookieFor, seedPerson } from "./helpers/persons";
import { platformCtx } from "./helpers/tenant";
import { mintToken } from "../src/auth/tokens";
import { resolveTenantById } from "../src/data/context";
import { orgRowCounts } from "./helpers/deletion";

const e = env as unknown as Env;
const PAYLOAD: OnboardPayload = { provider: "google", subject: "g-sample", label: "rev@example.com", email: "rev@example.com", name: "Reviewer", avatar_url: null, suggested_handle: "reviewer" };
const onboardCookie = async (p = PAYLOAD) => `${ONBOARD_COOKIE}=${await sealOnboard(p, "test-cookie-secret")}`;
const request = (method: string, path: string, cookie: string, body?: unknown) =>
  app.request(path, { method, headers: { cookie, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
const sessionOf = (res: Response): string => /session=[^;,]+/.exec(res.headers.get("set-cookie") ?? "")![0];

async function onboard(handle = "reviewer"): Promise<string> {
  const res = await request("POST", "/auth/onboard", await onboardCookie(), { handle, name: "Reviewer", color: "sky" });
  expect(res.status).toBe(200);
  return sessionOf(res);
}
const sampleOrgs = (handle: string) => all<{ id: string; slug: string; name: string; plan: string; sample: number; ai_automation: number; role: string; created_by: string }>(env.DB,
  `SELECT o.id, o.slug, o.name, o.plan, o.sample, o.ai_automation, m.role, o.created_by FROM memberships m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = ? AND o.sample = 1`, handle);
const count = async (sql: string, ...p: unknown[]) => (await first<{ n: number }>(env.DB, sql, ...p))!.n;

// ── MCP over HTTP, as a client calls it ─────────────────────────────────────
async function call(token: string, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string; json: Record<string, unknown> | null }> {
  const exec = createExecutionContext();
  const res = await worker.fetch(new Request("https://trov.test/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  }) as Parameters<typeof worker.fetch>[0], e, exec);
  const raw = await res.text();
  await waitOnExecutionContext(exec);
  const data = raw.split("\n").find((l) => l.startsWith("data: "));
  const result = (data ? JSON.parse(data.slice(6)) : JSON.parse(raw)).result as { isError?: boolean; content?: { text: string }[] };
  const text = (result.content ?? []).map((c) => c.text).join("\n");
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* not JSON */ }
  return { isError: result.isError === true, text, json };
}

describe("onboarding creates the Sample workspace", () => {
  it("exactly one, owned by the new person, on Free, inert, with rows in every table the seed writes", async () => {
    await onboard();
    const orgs = await sampleOrgs("reviewer");
    expect(orgs).toEqual([{ id: expect.any(String), slug: "sample-reviewer", name: "Sample workspace", plan: "free", sample: 1, ai_automation: 0, role: "owner", created_by: "reviewer" }]);
    const org = orgs[0].id;
    expect(await count(`SELECT COUNT(*) AS n FROM memberships WHERE org_id = ?`, org)).toBe(1);

    const rows = await orgRowCounts(org);
    for (const t of ["docs", "doc_versions", "doc_links", "doc_spaces", "adrs", "sprints", "tickets", "ticket_assignees", "ticket_events", "ticket_comments",
      "feed", "entry_tags", "handoffs", "prompts", "prompt_versions", "plan", "plan_versions", "org_tags", "org_repos", "org_environments",
      "org_environment_parts", "hosting_deploys", "repo_events", "repo_snapshots", "org_counters", "notification_policy", "notification_settings"]) {
      expect(rows[t], t).toBeGreaterThan(0);
    }
    expect(rows.docs).toBe(C.DOCS.length);
    expect(rows.doc_versions).toBe(C.DOCS.reduce((n, d) => n + d.versions.length, 0)); // one page has a second version
    expect(rows.adrs).toBe(3);
    expect(rows.tickets).toBe(C.TICKETS.length);
    expect(rows.feed).toBe(C.FEED.length);
    expect(rows.prompts).toBe(2);
    expect(rows.hosting_deploys).toBe(C.DEPLOYS.length);

    // Every ticket is assigned to the person (the lane-scoped MCP writes work on all of them); one has a parent.
    expect(await count(`SELECT COUNT(*) AS n FROM tickets t WHERE t.org_id = ? AND NOT EXISTS (SELECT 1 FROM ticket_assignees a WHERE a.ticket_id = t.id AND a.login = 'reviewer')`, org)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM tickets WHERE org_id = ? AND parent_id IS NOT NULL`, org)).toBe(1);
    // One sprint done, one active, its tickets across statuses.
    expect(await all(env.DB, `SELECT status FROM sprints WHERE org_id = ? ORDER BY status`, org)).toEqual([{ status: "done" }, { status: "in_progress" }]);
    expect((await all<{ status: string }>(env.DB, `SELECT DISTINCT t.status FROM tickets t JOIN sprints s ON s.id = t.sprint_id WHERE t.org_id = ? AND s.status = 'in_progress'`, org)).length).toBeGreaterThanOrEqual(4);
    // The feed and the docs are live (nothing staged, nothing in Unplaced), tagged with starter tags only.
    expect(await count(`SELECT COUNT(*) AS n FROM doc_versions WHERE org_id = ? AND status <> 'promoted'`, org)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM needs_triage WHERE org_id = ?`, org)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM entry_tags t WHERE t.org_id = ? AND t.tag NOT IN (SELECT name FROM org_tags g WHERE g.org_id = ? AND g.starter = 1)`, org, org)).toBe(0);
    // A pending handoff to themselves; the counters continue after the seed.
    expect(await all(env.DB, `SELECT number, sender, recipient, status FROM handoffs WHERE org_id = ?`, org)).toEqual([{ number: 1, sender: "reviewer", recipient: "reviewer", status: "pending" }]);
    expect(await all(env.DB, `SELECT name, value FROM org_counters WHERE org_id = ? ORDER BY name`, org)).toEqual([
      { name: "handoff", value: 1 }, { name: "link", value: 0 }, { name: "ticket", value: C.TICKETS.length },
    ]);
    // Inert: every digest kind off, no welcome mail, no GitHub App binding, no credential.
    expect(await all(env.DB, `SELECT DISTINCT enabled FROM notification_policy WHERE org_id = ?`, org)).toEqual([{ enabled: 0 }]);
    expect(rows.notification_policy).toBe(REGISTRY.length);
    expect(await count(`SELECT COUNT(*) AS n FROM notification_outbox_bodies`)).toBe(0);
    expect(rows.org_github_installations).toBe(0);
    expect(rows.org_secrets).toBe(0);
    expect(rows.org_hosting_connections).toBe(0);
  });

  it("/auth/me lists it as a sample; Home's org read says so too", async () => {
    const session = await onboard();
    const me = await (await request("GET", "/auth/me", session)).json() as { orgs: { slug: string; sample?: boolean; role: string }[] };
    expect(me.orgs).toEqual([expect.objectContaining({ slug: "sample-reviewer", role: "owner", sample: true })]);
    const orgMe = await (await request("GET", "/api/o/sample-reviewer/me", session)).json() as { sample?: boolean };
    expect(orgMe.sample).toBe(true);
  });

  it("a seeding failure is logged and onboarding still completes", async () => {
    await run(env.DB, `CREATE TRIGGER IF NOT EXISTS sample_fail_test BEFORE INSERT ON orgs WHEN new.name = 'Sample workspace' BEGIN SELECT RAISE(ABORT, 'sample seed broken'); END`);
    try {
      const res = await request("POST", "/auth/onboard", await onboardCookie(), { handle: "reviewer", name: "Reviewer", color: "sky" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, handle: "reviewer" });
      expect(res.headers.get("set-cookie")).toContain("session=");
      expect(await first(env.DB, `SELECT handle FROM persons WHERE handle = 'reviewer'`)).toEqual({ handle: "reviewer" });
      expect(await sampleOrgs("reviewer")).toEqual([]);
      // Nothing half-written: the batch is all or nothing.
      expect(await count(`SELECT COUNT(*) AS n FROM orgs WHERE slug LIKE 'sample-%'`)).toBe(0);
    } finally {
      await run(env.DB, `DROP TRIGGER IF EXISTS sample_fail_test`);
    }
  });

  it("does not use up the person's one Free org: they can still create their real one, and get its welcome", async () => {
    const session = await onboard();
    const res = await request("POST", "/api/orgs", session, { slug: "reviewer-co", name: "Reviewer Co" });
    expect(res.status).toBe(201);
    expect(await first(env.DB, `SELECT plan, sample FROM orgs WHERE slug = 'reviewer-co'`)).toEqual({ plan: "free", sample: 0 });
    // The real org is their FIRST real join: the welcome goes out for it (never for the sample).
    expect(await count(`SELECT COUNT(*) AS n FROM notification_outbox_bodies`)).toBe(1);
    // …and only one Free org still: the sample never counted, the real one does.
    expect((await (await request("POST", "/api/orgs", session, { slug: "reviewer-two", name: "Two" })).json() as { error: string }).error).toBe("free_org_limit");
  });
});

describe("createSampleOrg", () => {
  it("is one per person: a second call — or POST /api/orgs/sample — returns the same org", async () => {
    await seedPerson("dana");
    const a = await createSampleOrg(platformCtx("dana"), "dana");
    const b = await createSampleOrg(platformCtx("dana"), "dana");
    expect(b.id).toBe(a.id);
    const cookie = await cookieFor("dana");
    const res = await request("POST", "/api/orgs/sample", cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, org: { slug: a.slug, sample: true } });
    expect(await sampleOrgs("dana")).toHaveLength(1);
  });

  it("an existing person without one gets one from POST /api/orgs/sample (201)", async () => {
    const cookie = await cookieFor("eli");
    const res = await request("POST", "/api/orgs/sample", cookie);
    expect(res.status).toBe(201);
    expect(await sampleOrgs("eli")).toEqual([expect.objectContaining({ slug: "sample-eli", role: "owner" })]);
  });

  it("a taken slug gets a short suffix; an odd handle still makes a valid slug", async () => {
    await seedPerson("fay");
    await run(env.DB, `INSERT INTO orgs (id, slug, name, created_at, created_by) VALUES ('org_squatter', 'sample-fay', 'Squatter', 't', 'test')`);
    const org = await createSampleOrg(platformCtx("fay"), "fay");
    expect(org.slug).toMatch(/^sample-fay-[a-z0-9]{4}$/);
    expect(sampleSlug("Some_Person.Name")).toBe("sample-some-person-name");
    expect(sampleSlug("x".repeat(60))).toHaveLength(39);
  });

  it("every handle it writes is in a HANDLE_COLUMNS column: a rename leaves none behind", async () => {
    await seedPerson("gus");
    const org = await createSampleOrg(platformCtx("gus"), "gus");
    expect((await renamePerson(platformCtx("gus"), "gus", "gus2")).ok).toBe(true);
    for (const [t, c] of HANDLE_COLUMNS) {
      expect(await count(`SELECT COUNT(*) AS n FROM ${t} WHERE ${c} = 'gus' COLLATE NOCASE`), `${t}.${c}`).toBe(0);
    }
    expect(await count(`SELECT COUNT(*) AS n FROM tickets WHERE org_id = ? AND requester = 'gus2'`, org.id)).toBe(C.TICKETS.length);
  });
});

describe("the MCP tools, with a bearer for the sample org", () => {
  async function setup(): Promise<{ token: string; org: string }> {
    await seedPerson("rev");
    const org = await createSampleOrg(platformCtx("rev"), "rev");
    const ctx = await resolveTenantById(e, "rev", org.id, "session");
    return { token: (await mintToken(ctx!)).raw, org: org.id };
  }

  it("every read answers with the seeded data", async () => {
    const { token } = await setup();
    const reads: Array<[string, Record<string, unknown>, string]> = [
      ["get_my_work", {}, "Reminder fires twice after changing its time"],
      ["list_tickets", { seg: "all" }, "iOS home-screen widget"],
      ["get_roadmap", {}, "Reminders & widgets"],
      ["list_docs", {}, "habitloop-sync-protocol"],
      ["get_feed", {}, "Found the double-reminder bug"],
      ["list_handoffs", {}, "Finish the double-reminder fix"],
      ["search_prompts", { q: "release" }, "write-release-notes"],
      ["query", { q: "auth" }, "passkeys"],
    ];
    for (const [name, args, expected] of reads) {
      const r = await call(token, name, args);
      expect(r.isError, `${name}: ${r.text.slice(0, 300)}`).toBe(false);
      expect(r.text, name).toContain(expected);
    }
    const dash = (await call(token, "get_repo_dashboard", {})).json as { repo: string; degraded: boolean; sections: Record<string, { status: string }> };
    expect(dash.repo).toBe(C.SAMPLE_REPO);
    expect(dash.degraded).toBe(false);
    expect(dash.sections.environments.status).toBe("ok");
    const ci = (await call(token, "get_repo_dashboard", { tab: "ci" })).json as { sections: Record<string, { status: string }> };
    expect(ci.sections.deploys.status).toBe("ok");
    expect(ci.sections.ciFailures.status).toBe("ok");
  });

  it("writes work: the owner rewrites the plan, a new ticket continues the numbers, a seeded ticket moves", async () => {
    const { token, org } = await setup();
    // The seeded narrative is already in the three-part form get_roadmap hands back.
    expect(parsePlanNarrative(((await first<{ narrative: string }>(env.DB, `SELECT narrative FROM plan WHERE org_id = ?`, org))!).narrative)).toEqual(C.NARRATIVE);
    const plan = await call(token, "update_plan", { now: "Ship the widget.", next: "Sharing.", later: "A watch app.", sprints: [] });
    expect(plan.isError, plan.text).toBe(false);
    expect(await first(env.DB, `SELECT narrative, current_version FROM plan WHERE org_id = ?`, org)).toEqual({ narrative: "**Now:** Ship the widget.\n\n**Next:** Sharing.\n\n**Later:** A watch app.", current_version: 2 });
    const created = await call(token, "create_ticket", { title: "Try the sample", category: "other" });
    expect(created.isError, created.text).toBe(false);
    expect(created.json).toMatchObject({ id: C.TICKETS.length + 1 });
    const moved = await call(token, "transition_ticket", { id: 6, to: "in_progress" });
    expect(moved.isError, moved.text).toBe(false);
    expect(await first(env.DB, `SELECT status FROM tickets WHERE org_id = ? AND number = 6`, org)).toEqual({ status: "in_progress" });
  });
});

describe("it is inert", () => {
  async function sample(): Promise<string> {
    await seedPerson("ina");
    return (await createSampleOrg(platformCtx("ina"), "ina")).id;
  }
  const recorder = () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => { calls.push(String(input instanceof Request ? input.url : input)); return new Response("{}", { status: 500 }); }) as typeof fetch;
    return { calls, fetchImpl };
  };

  it("the repo cron — health, usage, progress, reconcile, the hosting job, the sweeps — calls nothing for it", async () => {
    const org = await sample();
    const before = await orgRowCounts(org);
    const r = recorder();
    // :00 usage, :10 progress, :20 reconcile, :30 the sweeps, :40 the hosting job (every 6th hour for the heavy ones).
    for (const at of ["2026-11-05T06:00:00Z", "2026-11-05T06:10:00Z", "2026-11-05T06:20:00Z", "2026-11-05T06:30:00Z", "2026-11-05T06:40:00Z", "2026-11-05T06:50:00Z"]) {
      await handleRepoCron(e, Date.parse(at), r.fetchImpl);
    }
    expect(r.calls).toEqual([]);
    expect(await orgRowCounts(org)).toEqual(before);
  });

  it("the digest cron leaves it alone — no backfilled policy rows, no outbox — and its handoff does not expire", async () => {
    const org = await sample();
    const reports = await handleNotificationCron(e, DAILY_CRON, new Date("2026-11-09T14:00:00Z"));
    expect(Object.keys(reports)).not.toContain(org);
    expect(await all(env.DB, `SELECT DISTINCT enabled FROM notification_policy WHERE org_id = ?`, org)).toEqual([{ enabled: 0 }]);
    expect(await count(`SELECT COUNT(*) AS n FROM notification_outbox WHERE org_id = ?`, org)).toBe(0);
    expect(await expireDueHandoffs(platformCtx("system"), Date.now() + 30 * 86_400_000)).toBe(0);
    expect(await first(env.DB, `SELECT status FROM handoffs WHERE org_id = ?`, org)).toEqual({ status: "pending" });
  });

  it("Sync GitHub, Poll now and every connect / test / credential route refuse it with 409 sample_org", async () => {
    await sample();
    const cookie = await cookieFor("ina");
    for (const [method, path] of [["POST", "/admin/backfill"], ["POST", "/admin/poll"], ["POST", "/admin/poll-usage"], ["GET", "/github/install"],
      ["POST", "/github/test"], ["POST", "/hosting/vercel/connect"], ["PUT", "/integrations/github_token"], ["POST", "/repos"],
      ["POST", `/repos/${C.SAMPLE_REPO}/scan`]] as const) {
      const res = await request(method, `/api/o/sample-ina${path}`, cookie, method === "GET" ? undefined : {});
      expect([res.status, ((await res.json()) as { error: string }).error], `${method} ${path}`).toEqual([409, "sample_org"]);
    }
    // A read still answers.
    expect((await request("GET", "/api/o/sample-ina/repo/dashboard", cookie)).status).toBe(200);
    // And the rule is only for outbound routes.
    expect(reachesOutside("GET", "/repo/dashboard")).toBe(false);
    expect(reachesOutside("POST", "/tickets")).toBe(false);
  });

  it("a real org's Poll now is not refused", async () => {
    const cookie = await cookieFor("AndresL230");
    const res = await request("POST", "/api/o/saplinglearn/admin/poll-usage", cookie);
    expect(res.status).not.toBe(409);
  });
});

describe("deleting it", () => {
  it("the owner's Delete organization removes every row the seed wrote", async () => {
    const session = await onboard();
    const [{ id: org }] = await sampleOrgs("reviewer");
    const res = await request("POST", "/api/o/sample-reviewer/delete", session, { confirm: "sample-reviewer" });
    expect(res.status).toBe(200);
    const left = Object.entries(await orgRowCounts(org)).filter(([, n]) => n > 0);
    expect(left).toEqual([]);
    expect(await first(env.DB, `SELECT 1 AS x FROM orgs WHERE id = ?`, org)).toBeNull();
    // …and they can make a new one.
    expect((await request("POST", "/api/orgs/sample", session)).status).toBe(201);
  });
});

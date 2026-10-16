// The LOCAL dev seed's named scenarios (scripts/seed/scenarios.mjs; docs/architecture/local-dev.md), run through
// `env.DB` exactly as `npm run seed` runs them through wrangler:
//   • the `team` scenario fills EVERY org-keyed table (`ORG_TABLES`) — a table added without seed rows fails here;
//   • every scenario loads on its own, and says what it promises (Free at its caps, hosting in every state, …);
//   • the seeds never reach a remote database: each CLI refuses --remote before it calls wrangler, and every wrangler
//     call is --local;
//   • the dev sign-in is local only: DEV_LOGIN set, a loopback origin, no live Stripe key — else a bare 404.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { ORG_TABLES } from "../src/deletion/tables";
import { app } from "../src/routes";
import { devSignInAllowed } from "../src/auth/dev-signin";
import { loadScenarios, scenarioNames, SCENARIOS, orgTablesInOrder, orgWipeStatements, ORG_TABLES_SQL, type SeedDb } from "../scripts/seed/scenarios.mjs";
import { CANONICAL_SPRINT_DATES, datedRoadmap } from "../scripts/seed/team-rich.mjs";
import roadmapFixture from "../fixtures/dev/roadmap.json";
import { cookieFor } from "./helpers/persons";
import { rows } from "./helpers/orgs";

/** The scenarios' database interface over the test D1: statements in order, in batches. */
const db: SeedDb = {
  query: async (sqls) => Promise.all(sqls.map(async (s) => (await env.DB.prepare(s).all<Record<string, unknown>>()).results)),
  apply: async (_label, statements) => {
    for (let i = 0; i < statements.length; i += 40) await env.DB.batch(statements.slice(i, i + 40).map((s) => env.DB.prepare(s)));
  },
};
const NOW = new Date("2026-10-15T15:00:00.000Z");
const count = async (sql: string, ...p: unknown[]) => Number((await env.DB.prepare(sql).bind(...p).first<{ n: number }>())?.n ?? 0);

describe("the team scenario", () => {
  it("has rows in EVERY org-keyed table (ORG_TABLES) — a new table needs seed rows in scripts/seed/team-rich.mjs", async () => {
    await loadScenarios(db, ["team"], { now: NOW });
    const empty: string[] = [];
    for (const t of ORG_TABLES) if (!(await count(`SELECT COUNT(*) AS n FROM "${t}" WHERE org_id = 'org_saplinglearn'`))) empty.push(t);
    expect(empty).toEqual([]);
    // …and it is the busy team it says: tickets in every status, sprints done / late / current / planned, handoffs
    // in every state, staged proposals and Unplaced items waiting, an admin among the members.
    expect((await rows<{ status: string }>(`SELECT DISTINCT status FROM tickets WHERE org_id = 'org_saplinglearn'`)).map((r) => r.status).sort()).toEqual(["declined", "done", "in_progress", "submitted", "testing"]);
    expect((await rows<{ status: string }>(`SELECT DISTINCT status FROM handoffs WHERE org_id = 'org_saplinglearn'`)).map((r) => r.status).sort()).toEqual(["claimed", "expired", "pending"]);
    expect(await count(`SELECT COUNT(*) AS n FROM sprints WHERE org_id = 'org_saplinglearn' AND status = 'in_progress' AND target_date < ?`, NOW.toISOString().slice(0, 10))).toBeGreaterThan(0);
    expect(await count(`SELECT COUNT(*) AS n FROM sprints WHERE org_id = 'org_saplinglearn' AND status = 'upcoming' AND start_date > ?`, NOW.toISOString().slice(0, 10))).toBeGreaterThan(0);
    expect(await count(`SELECT COUNT(*) AS n FROM doc_versions WHERE org_id = 'org_saplinglearn' AND status = 'staged'`)).toBeGreaterThan(2);
    expect(await count(`SELECT COUNT(*) AS n FROM needs_triage WHERE org_id = 'org_saplinglearn' AND resolved = 0`)).toBeGreaterThan(5);
    expect(await count(`SELECT COUNT(*) AS n FROM memberships WHERE org_id = 'org_saplinglearn' AND role = 'admin'`)).toBe(1);
    expect(await count(`SELECT COUNT(DISTINCT author) AS n FROM feed WHERE org_id = 'org_saplinglearn' AND created_at > ?`, new Date(NOW.getTime() - 42 * 86_400_000).toISOString())).toBeGreaterThan(5);
  });

  it("ONE late sprint (owner ruling 2026-10-16): Gradebook export rework (7002) — Token rotation & audit log (3) is done", async () => {
    await loadScenarios(db, ["team"], { now: NOW });
    const today = NOW.toISOString().slice(0, 10);
    expect(await rows<{ id: number }>(`SELECT id FROM sprints WHERE org_id = 'org_saplinglearn' AND status = 'in_progress' AND target_date < '${today}' ORDER BY id`)).toEqual([{ id: 7002 }]);
    expect(await rows<{ status: string }>(`SELECT status FROM sprints WHERE org_id = 'org_saplinglearn' AND id = 3`)).toEqual([{ status: "done" }]);
    // Nothing planned reads as already started, and nothing open as months overdue.
    expect(await count(`SELECT COUNT(*) AS n FROM sprints WHERE org_id = 'org_saplinglearn' AND status = 'upcoming' AND start_date <= ?`, today)).toBe(0);
    // The showcase's brief makes no "overdue" claim about a sprint that is done.
    const brief = await rows<{ brief_json: string }>(`SELECT brief_json FROM person_brief WHERE org_id = 'org_saplinglearn' AND handle = 'AndresL230' ORDER BY version DESC LIMIT 1`);
    expect(brief[0].brief_json).not.toContain("Token rotation");
  });

  it("the canonical roadmap fixture, as a dev seed loads it, is dated against the clock — it never rots (the TEST seed's fixture is untouched)", () => {
    for (const now of [NOW, new Date("2028-03-01T09:00:00.000Z")]) {
      const today = now.toISOString().slice(0, 10);
      const rm = datedRoadmap(roadmapFixture, now);
      expect(rm.sprints.map((sp) => sp.id)).toEqual(roadmapFixture.sprints.map((sp) => sp.id));
      for (const sp of rm.sprints) {
        if (sp.status !== "done") expect(sp.target_date >= today, `sprint ${sp.id} is not past due`).toBe(true);
        if (sp.status === "upcoming") expect(sp.start_date > today, `sprint ${sp.id} has not started`).toBe(true);
      }
      expect(rm.sprints.find((sp) => sp.id === 3)).toMatchObject({ status: "done" });
    }
    expect(CANONICAL_SPRINT_DATES.map(([id]) => id)).toEqual([3, 4, 5, 6, 7]);
    // The canonical fixture itself keeps its absolute dates: tests pin them (CLAUDE.md › the canonical seed).
    expect(roadmapFixture.sprints.find((sp) => sp.id === 3)).toMatchObject({ status: "in_progress", target_date: "2026-06-10" });
  });

  it("rewrites only its own org: a rerun leaves the same rows, and another org's rows are untouched", async () => {
    await loadScenarios(db, ["team", "pro"], { now: NOW });
    const before = await count(`SELECT COUNT(*) AS n FROM tickets WHERE org_id = 'org_saplinglearn'`);
    const pro = await count(`SELECT COUNT(*) AS n FROM tickets WHERE org_id = 'org_dev_northwind'`);
    await loadScenarios(db, ["team"], { now: NOW });
    expect(await count(`SELECT COUNT(*) AS n FROM tickets WHERE org_id = 'org_saplinglearn'`)).toBe(before);
    expect(await count(`SELECT COUNT(*) AS n FROM tickets WHERE org_id = 'org_dev_northwind'`)).toBe(pro);
  });

  it("deletes children before the tables they reference (the wipe order is read from the schema)", async () => {
    const order = orgTablesInOrder((await db.query(ORG_TABLES_SQL))[0]);
    expect([...order].sort()).toEqual([...ORG_TABLES].sort());
    for (const [child, parent] of [["ticket_events", "tickets"], ["doc_versions", "docs"], ["prompt_versions", "prompts"], ["artifact_versions", "artifact_pages"], ["org_environment_parts", "org_environments"]]) {
      expect(order.indexOf(child), `${child} before ${parent}`).toBeLessThan(order.indexOf(parent));
    }
  });
});

describe("a freshly migrated D1 (what `npm run seed` meets in a new worktree, #189)", () => {
  it("loads every scenario WITHOUT --reset, and again on top", async () => {
    // A fresh D1 holds SaplingLearn alone (0042_organizations) and nobody in it: no Acme (`org_b` is the canonical
    // reset's) and no memberships. Make the test D1 that.
    const tables = orgTablesInOrder((await db.query(ORG_TABLES_SQL))[0]);
    await db.apply("fresh", [...orgWipeStatements("org_b", tables), `DELETE FROM orgs WHERE id = 'org_b'`, `DELETE FROM memberships`]);
    expect(await count(`SELECT COUNT(*) AS n FROM orgs`)).toBe(1);

    await loadScenarios(db, scenarioNames(), { now: NOW });
    const members = async () => Object.fromEntries((await rows<{ org_id: string; n: number }>(`SELECT org_id, COUNT(*) AS n FROM memberships GROUP BY org_id`)).map((r) => [r.org_id, r.n]));
    const first = await members();
    for (const s of SCENARIOS) expect(first[s.org], s.name).toBeGreaterThan(0);
    // The plain path writes only the scenarios' own orgs — never Acme's rows, which belong to the reset.
    expect(await count(`SELECT COUNT(*) AS n FROM orgs WHERE id = 'org_b'`)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM org_usage_daily WHERE org_id = 'org_saplinglearn'`)).toBeGreaterThan(0);

    // A second plain run over the seeded D1 (`npm run seed` again) rewrites the same orgs to the same shape.
    await loadScenarios(db, scenarioNames(), { now: NOW });
    expect(await members()).toEqual(first);
  });
});

describe("every other scenario loads on its own", () => {
  it("names five scenarios, each its own org", () => {
    expect(scenarioNames()).toEqual(["team", "empty", "free-at-cap", "pro", "hosting"]);
    expect(new Set(SCENARIOS.map((s) => s.org)).size).toBe(SCENARIOS.length);
  });

  it("empty: a new org with its owner and nothing else", async () => {
    await loadScenarios(db, ["empty"], { now: NOW });
    expect(await count(`SELECT COUNT(*) AS n FROM memberships WHERE org_id = 'org_dev_dayone'`)).toBe(1);
    for (const t of ["tickets", "feed", "docs", "org_repos", "handoffs", "sprints"]) expect(await count(`SELECT COUNT(*) AS n FROM ${t} WHERE org_id = 'org_dev_dayone'`), t).toBe(0);
  });

  it("free-at-cap: every limit reached on Free (the plan block reads them at the cap)", async () => {
    await loadScenarios(db, ["free-at-cap"], { now: NOW });
    const cookie = await cookieFor("kai-moreno");
    const res = await app.request("/api/o/pinecone/plan", { headers: { cookie } }, env);
    expect(res.status).toBe(200);
    const plan = (await res.json()) as { plan: string; usage: Record<string, number>; entitlements: Record<string, number | null> };
    expect(plan.plan).toBe("free");
    for (const k of ["seats", "repositories", "environments", "tags", "artifact_bytes", "agent_connections", "ai_summaries", "jev_checks"]) {
      expect(plan.usage[k], k).toBe(plan.entitlements[k]);
    }
  });

  it("pro: on Pro, inside its limits, with a person who is in two orgs", async () => {
    await loadScenarios(db, ["team", "pro"], { now: NOW });
    expect((await rows<{ plan: string }>(`SELECT plan FROM orgs WHERE id = 'org_dev_northwind'`))[0].plan).toBe("team");
    expect((await rows<{ org_id: string }>(`SELECT org_id FROM memberships WHERE user_id = 'sanaok' ORDER BY org_id`)).map((r) => r.org_id)).toEqual(["org_dev_northwind", "org_saplinglearn"]);
  });

  it("hosting: parts in every connection state", async () => {
    await loadScenarios(db, ["hosting"], { now: NOW });
    const cookie = await cookieFor("ines-garcia");
    const res = await app.request("/api/o/fernhill/hosting", { headers: { cookie } }, env);
    expect(res.status).toBe(200);
    const setup = (await res.json()) as { connections: { provider: string; status: string }[]; leftovers?: { provider: string }[] };
    const status = Object.fromEntries(setup.connections.map((c) => [c.provider, c.status]));
    expect(status).toMatchObject({ vercel: "connected", fly: "connected", cloudflare: "connected", render: "error", railway: "not_connected", netlify: "revoked" });
    expect((setup.leftovers ?? []).map((l) => l.provider)).toContain("railway");
  });
});

describe("the seeds never reach a remote database", () => {
  const SOURCES = import.meta.glob("../scripts/{seed-dev.mjs,seed/*.mjs,dev/*.mjs}", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
  const CLIS = ["../scripts/seed-dev.mjs", "../scripts/seed/team-rich.mjs", "../scripts/seed/ai-showcase.mjs", "../scripts/seed/repo-setups.mjs", "../scripts/dev/ensure-seeded.mjs", "../scripts/dev/as.mjs"];

  it("each seed CLI refuses --remote before its first wrangler call", () => {
    for (const path of CLIS) {
      const src = SOURCES[path];
      expect(src, path).toBeDefined();
      const guard = src.search(/if \((?:targetsRemote\((?:[^()]|\([^()]*\))*\)|argv\.includes\("--remote"\))\) \{\s*console\.error\([^\n]*\);\s*process\.exit\(1\);/);
      expect(guard, `${path} refuses --remote`).toBeGreaterThan(-1);
      const firstCall = src.search(/execFileSync\(|localD1\(|\.query\(\[|\.apply\(/);
      if (firstCall >= 0) expect(guard, `${path}: the refusal comes before any wrangler call`).toBeLessThan(firstCall);
    }
  });

  it("every wrangler d1 / r2 call in the seeds is --local, and none names --remote", () => {
    for (const [path, src] of Object.entries(SOURCES)) {
      if (path.endsWith("server-ai-e2e.mjs") || path.endsWith("guide-demo.mjs")) continue; // their own CLIs, unchanged here
      for (const line of src.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l))) {
        if (/["']wrangler["']/.test(line) && /["'](d1|r2)["']/.test(line)) expect(/--local|\bLOCAL\b/.test(line), `${path}: ${line.trim()}`).toBe(true);
        if (/--remote/.test(line)) expect(/includes\("--remote"\)|refusing --remote|targetsRemote|--remote`|"--remote"\]/.test(line), `${path}: ${line.trim()}`).toBe(true);
      }
    }
  });
});

describe("the dev sign-in (src/auth/dev-signin.ts) is local only", () => {
  it("is allowed only with DEV_LOGIN set, on a loopback http origin, without a live Stripe key", () => {
    expect(devSignInAllowed({ DEV_LOGIN: "AndresL230", STRIPE_SECRET_KEY: "" }, "http://localhost:8787/auth/dev/as")).toBe(true);
    expect(devSignInAllowed({ DEV_LOGIN: "AndresL230", STRIPE_SECRET_KEY: "sk_test_x" }, "http://127.0.0.1:8787/auth/dev/as")).toBe(true);
    expect(devSignInAllowed({ DEV_LOGIN: "", STRIPE_SECRET_KEY: "" }, "http://localhost:8787/auth/dev/as")).toBe(false);
    expect(devSignInAllowed({ STRIPE_SECRET_KEY: "" }, "http://localhost:8787/auth/dev/as")).toBe(false);
    expect(devSignInAllowed({ DEV_LOGIN: "AndresL230", STRIPE_SECRET_KEY: "" }, "https://trov.dev/auth/dev/as")).toBe(false);
    expect(devSignInAllowed({ DEV_LOGIN: "AndresL230", STRIPE_SECRET_KEY: "" }, "https://localhost/auth/dev/as")).toBe(false);
    expect(devSignInAllowed({ DEV_LOGIN: "AndresL230", STRIPE_SECRET_KEY: "sk_live_abc" }, "http://localhost:8787/auth/dev/as")).toBe(false);
  });

  it("makes an ordinary session for the person picked, which wins over DEV_LOGIN until /auth/dev/out", async () => {
    await cookieFor("meilin");
    const local = { ...env, DEV_LOGIN: "AndresL230" };
    const res = await app.request("http://localhost:8787/auth/dev/as?handle=meilin", {}, local);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/saplinglearn/");
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
    expect(cookie).toMatch(/^session=/);
    const me = await app.request("http://localhost:8787/auth/me", { headers: { cookie } }, local);
    expect(((await me.json()) as { handle: string }).handle).toBe("meilin");
    // Without the cookie, DEV_LOGIN's person, as before.
    const dev = await app.request("http://localhost:8787/auth/me", {}, local);
    expect(((await dev.json()) as { handle: string }).handle).toBe("AndresL230");
    // Unknown people are refused; the people page lists who can be picked.
    expect((await app.request("http://localhost:8787/auth/dev/as?handle=nobody-here", {}, local)).status).toBe(404);
    expect(await (await app.request("http://localhost:8787/auth/dev/as", {}, local)).text()).toContain("meilin");
  });

  it("is a bare 404 off loopback, beside a live Stripe key, and without DEV_LOGIN (the gate's 401)", async () => {
    await cookieFor("meilin");
    const local = { ...env, DEV_LOGIN: "AndresL230" };
    for (const [url, e, want] of [
      ["https://trov.dev/auth/dev/as?handle=meilin", local, 404],
      ["http://localhost:8787/auth/dev/as?handle=meilin", { ...local, STRIPE_SECRET_KEY: "sk_live_abc" }, 404],
      ["http://localhost:8787/auth/dev/as?handle=meilin", env, 401],
    ] as const) {
      const res = await app.request(url, {}, e);
      expect(res.status, url).toBe(want);
      expect(res.headers.get("set-cookie"), url).toBeNull();
    }
  });
});

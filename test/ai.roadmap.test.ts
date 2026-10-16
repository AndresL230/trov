// THE ROADMAP'S AI (Phase D, Feature E — docs/architecture/roadmap-my-work.md › Roadmap intelligence): the sprint
// forecast (arithmetic, on read), the org rollup's sprint notes and plan drift (Haiku, through the pass), the
// Batch-API sprint draft and narrative proposal (suggestions an ADMIN accepts — running the existing writers as
// that admin), and the reads: `get_plan` / `list_sprints` / `get_sprint` (MCP too) and the cookie `/roadmap`.
// Real Miniflare D1; both providers stubbed at the `Response` level.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { app } from "../src/routes";
import { get_plan } from "../src/tools/plan";
import { create_sprint, set_sprint_active, sprintForecast, list_sprints, get_sprint } from "../src/tools/sprints";
import { create_ticket, set_ticket_sprint, transition_ticket, add_ticket_link } from "../src/tools/tickets";
import {
  DRAFT_MIN_BACKLOG, PLAN_DRIFT_JOB, PLAN_NARRATIVE_JOB, SPRINT_DRAFT_JOB, SPRINT_NOTE_JOB, ROADMAP_JOBS, driftInput, themeShares, toAiThemeShares,
} from "../src/ai/roadmap";
import { AI_JOBS } from "../src/ai/pass";
import { KIND_PROVIDER } from "../src/ai/client";
import { AI_ACCEPT_HANDLERS } from "../src/ai/suggestions";
import { putInsight, INSIGHT_KEEP } from "../src/data/org-insights";
import { AI_ROUTES, type AiSuggestion } from "@shared/ai";
import type { AiThemeShare } from "@shared/ai-core";
import type { PlanView } from "../src/tools/plan";
import { all, first, run } from "./helpers/db";
import { FIXTURE_ADMIN, cookieFor } from "./helpers/persons";
import { ORG_A, ORG_B, systemCtx } from "./helpers/tenant";
import { markRow, stubProviders, succeededLine, type ClaudeReply } from "./helpers/ai-pass";
import { fencedBlocks, inputOf, tick, withThemes } from "./helpers/ai-roadmap";
import { addOrgRepo } from "./helpers/org-config";
import { useAiKey } from "./helpers/ai-key";

// THE read rule (src/plans/gate.ts `aiShown`): no Anthropic key reads like the switch off, so these tests hold a fake one.
useAiKey();

const e = env as unknown as Env;
const HOUR = 3_600_000;
const later = (ms: number) => new Date(Date.now() + ms);
const BASE = "/api/o/saplinglearn";
const ctx = () => systemCtx();
const count = async (sql: string, ...p: unknown[]) => (await first<{ n: number }>(env.DB, sql, ...p))!.n;

async function call<T = unknown>(method: string, path: string, cookie: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await app.request(path, { method, headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) }, e);
  return { status: res.status, json: (await res.json().catch(() => null)) as T };
}

/** An ACTIVE sprint started 2026-10-01, due 2026-10-20, with five tickets — two closed — and a PR link on one. */
async function activeSprint(): Promise<{ id: number; tickets: number[] }> {
  const sp = await create_sprint(ctx(), { label: "Hosting", urgency: "normal", start: "2026-10-01", due: "2026-10-20" }, "AndresL230");
  await set_sprint_active(ctx(), sp.id, true);
  const tickets: number[] = [];
  for (let i = 1; i <= 5; i++) {
    const n = await create_ticket(ctx(), { title: `Hosting task ${i}`, body: "", category: "request", priority: "normal", assignees: i === 3 ? ["AndresL230"] : [] }, "AndresL230");
    await set_ticket_sprint(ctx(), n, sp.id);
    tickets.push(n);
  }
  await transition_ticket(ctx(), tickets[0], "done", "AndresL230");
  await transition_ticket(ctx(), tickets[1], "declined", "AndresL230");
  await add_ticket_link(ctx(), tickets[2], "https://github.com/SaplingLearn/sapling/pull/173", "AndresL230");
  return { id: sp.id, tickets };
}

// ── the forecast: arithmetic on read, never a model ──────────────────────────

describe("the sprint forecast — math, computed on read (src/tools/sprints.ts)", () => {
  const base = { status: "in_progress", start: "2026-10-01", due: "2026-10-20", closed: 2, total: 5 };
  const at = (d: string) => new Date(`${d}T15:00:00Z`);

  it("pace = closed ÷ days since the start (the start day is day 1), carried over the open tickets", () => {
    // Oct 10 is day 10: 2 closed → 0.2 a day; 3 open → 15 days → Oct 25, five days after Oct 20.
    expect(sprintForecast(base, at("2026-10-10"))).toEqual({ remaining: 3, perDay: 0.2, projected: "2026-10-25", daysLate: 5 });
    // Faster: 4 of 5 closed by day 4 → one day for the last → Oct 5, fifteen days early.
    expect(sprintForecast({ ...base, closed: 4 }, at("2026-10-04"))).toMatchObject({ projected: "2026-10-05", daysLate: -15 });
    // No due day: a projection, no lateness.
    expect(sprintForecast({ ...base, due: null }, at("2026-10-10"))).toMatchObject({ projected: "2026-10-25", daysLate: null });
  });

  it("never a guess: null — not 0 — for an inactive sprint, no or a future start, no tickets, none open, none closed", () => {
    const now = at("2026-10-10");
    expect(sprintForecast({ ...base, status: "upcoming" }, now)).toBeNull();
    expect(sprintForecast({ ...base, status: "done" }, now)).toBeNull();
    expect(sprintForecast({ ...base, start: null }, now)).toBeNull();
    expect(sprintForecast({ ...base, start: "Oct 1" }, now)).toBeNull();
    expect(sprintForecast({ ...base, start: "2026-10-11" }, now)).toBeNull();
    expect(sprintForecast({ ...base, total: 0, closed: 0 }, now)).toBeNull();
    expect(sprintForecast({ ...base, closed: 5 }, now)).toBeNull();
    expect(sprintForecast({ ...base, closed: 0 }, now)).toBeNull(); // no pace yet: never "a pace of 0"
  });

  it("every sprint read carries it (null when unknown) — list_sprints, get_sprint, get_plan — and no model is reached", async () => {
    const { id } = await activeSprint();
    const upcoming = await create_sprint(ctx(), { label: "Later", urgency: "normal" }, "AndresL230");
    const s = stubProviders();
    const now = at("2026-10-10");
    const list = await list_sprints(ctx(), now);
    expect(list.find((x) => x.id === id)!.forecast).toEqual({ remaining: 3, perDay: 0.2, projected: "2026-10-25", daysLate: 5 });
    expect(list.find((x) => x.id === upcoming.id)!.forecast).toBeNull();
    expect((await get_plan(ctx(), now)).sprints.find((x) => x.id === id)!.forecast).toMatchObject({ daysLate: 5 });
    expect((await get_sprint(ctx(), id))!.forecast).not.toBeUndefined();
    expect([s.haiku, s.jev, s.batchCreates, s.other]).toEqual([0, 0, 0, 0]);
  });

  it("the forecast's module reaches no model: src/tools/sprints.ts imports nothing from src/ai/", async () => {
    const src = (import.meta.glob("../src/tools/sprints.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>)["../src/tools/sprints.ts"];
    // `from "…/ai/…"`, a bare `import "…/ai/…"` and a dynamic `import("…/ai/…")` alike.
    expect(src).not.toMatch(/(?:\bfrom|\bimport)\s*\(?\s*["'][^"']*\/ai\//);
    expect(src).toMatch(/export function sprintForecast\(/);
  });
});

// ── the registry ─────────────────────────────────────────────────────────────

describe("registered once: the kinds, the jobs, the accept handlers", () => {
  it("one KIND_PROVIDER line per kind; the four roadmap jobs and doc drift are in AI_JOBS; two admin accept handlers", () => {
    expect([KIND_PROVIDER["org.rollup"], KIND_PROVIDER["sprint.draft"], KIND_PROVIDER["plan.narrative"], KIND_PROVIDER["doc.drift"], KIND_PROVIDER["gate.drift"]])
      .toEqual(["claude", "claude", "claude", "claude", "jev"]);
    for (const j of ROADMAP_JOBS) expect(AI_JOBS).toContain(j);
    expect(AI_JOBS.map((j) => j.name)).toEqual(expect.arrayContaining(["roadmap.sprint_note", "roadmap.plan_drift", "roadmap.sprint_draft", "roadmap.plan_narrative", "doc.drift"]));
    expect([SPRINT_DRAFT_JOB.batch, PLAN_NARRATIVE_JOB.batch, SPRINT_NOTE_JOB.batch, PLAN_DRIFT_JOB.batch]).toEqual([true, true, undefined, undefined]);
    expect(AI_ACCEPT_HANDLERS.sprint_draft.role).toBe("admin");
    expect(AI_ACCEPT_HANDLERS.plan_narrative.role).toBe("admin");
  });
});

// ── sprint notes ─────────────────────────────────────────────────────────────

/** A Haiku stub that answers the notes call from its own input: `make(sprint)` → the note for it. */
const notesReply = (make: (sp: { sprint: number; items: { ref: string }[]; tickets: { closed: number; total: number } }) => Record<string, unknown>): ClaudeReply => (body) => {
  const sprints = fencedBlocks(inputOf(body)).sprints as { sprint: number; items: { ref: string }[]; tickets: { closed: number; total: number } }[];
  return JSON.stringify({ notes: sprints.map((sp) => ({ sprint: sp.sprint, ...make(sp) })) });
};
const noteRows = () => all<{ key: string; version: number; json: string; model: string | null }>(env.DB, `SELECT key, version, json, model FROM org_insights WHERE kind = 'sprint_note' ORDER BY key, version`);

describe("sprint notes — the org rollup's `sprint:<id>` (Haiku, ≤10 a call, cited, no number it was not given)", () => {
  it("writes one cited note per ACTIVE sprint; the read carries it on that sprint only; the scope clears", async () => {
    const { id, tickets } = await activeSprint();
    const s = stubProviders({ claude: notesReply(() => ({ text: `Two of five closed; #${tickets[2]} waits on review.`, cites: [`ticket:${tickets[2]}`, "pr:173", "ticket:9999"] })) });
    await tick(s, [SPRINT_NOTE_JOB], later(25 * HOUR));
    expect(s.haiku).toBe(1);
    const sent = fencedBlocks(inputOf(s.haikuBodies[0] as never)).sprints as Record<string, unknown>[];
    expect(sent[0]).toMatchObject({ sprint: id, tickets: { closed: 2, total: 5, open: 3 } }); // the server's counts
    const rows = await noteRows();
    expect(rows).toHaveLength(1);
    const note = JSON.parse(rows[0].json);
    expect(note.cites.map((c: { ref: string }) => c.ref)).toEqual([`ticket:${tickets[2]}`, "pr:173"]); // ticket:9999 was never offered
    expect(note.cites[1]).toEqual({ ref: "pr:173", label: "#173", href: "https://github.com/SaplingLearn/sapling/pull/173" });
    const plan = await get_plan(ctx());
    expect(plan.sprints.find((x) => x.id === id)!.note).toMatchObject({ text: expect.stringContaining("Two of five"), model: "claude-haiku-5-5" });
    expect(await count(`SELECT COUNT(*) AS n FROM ai_dirty WHERE org_id = ? AND scope = 'sprint' AND (last_run_at IS NULL OR marked_at > last_run_at)`, ORG_A)).toBe(0);
  });

  it("GUARD: a note stating a number it was not given, or with no valid cite, or saying the sprint is done, is NOT written", async () => {
    await activeSprint();
    for (const bad of [
      { text: "Three of 99 closed.", cites: ["ticket:1"] },                        // 99 was not given
      { text: "Most of it waits on review.", cites: ["ticket:4242"] },             // no valid cite
      { text: "The sprint is done and can be closed.", cites: ["pr:173"] },        // never infers a resolution
    ]) {
      await run(env.DB, `DELETE FROM org_insights`);
      const s = stubProviders({ claude: notesReply(() => bad) });
      const sp = (await all<{ id: number }>(env.DB, `SELECT id FROM sprints WHERE org_id = ? AND status = 'in_progress'`, ORG_A))[0];
      await markRow(ORG_A, "sprint", String(sp.id), new Date(Date.now() - 25 * HOUR).toISOString());
      await tick(s, [SPRINT_NOTE_JOB], later(0));
      expect(s.haiku).toBe(1);
      expect(await noteRows()).toEqual([]);
    }
  });

  it("an inactive sprint, or one with no ticket, makes no call (input null) and clears", async () => {
    const sp = await create_sprint(ctx(), { label: "Not started", urgency: "normal" }, "AndresL230");
    await markRow(ORG_A, "sprint", String(sp.id), new Date(Date.now() - 25 * HOUR).toISOString());
    const s = stubProviders({ claude: notesReply(() => ({ text: "x", cites: [] })) });
    await tick(s, [SPRINT_NOTE_JOB], later(0));
    expect(s.haiku).toBe(0);
  });

  it("keeps the last 10 versions per key", async () => {
    for (let i = 0; i < INSIGHT_KEEP + 3; i++) await putInsight(ctx(), "sprint_note", "7", { text: `v${i}`, cites: [{ ref: "ticket:1", label: "#1", href: null }] }, { model: "m", promptVersion: "p" });
    const rows = await all<{ version: number }>(env.DB, `SELECT version FROM org_insights WHERE key = '7' ORDER BY version`);
    expect(rows.map((r) => r.version)).toEqual(Array.from({ length: 10 }, (_, i) => i + 4));
  });

  it("the switch off: the notes and the drift are ABSENT from every read (never an 'off' state)", async () => {
    const { id } = await activeSprint();
    await putInsight(ctx(), "sprint_note", String(id), { text: "Waiting on review.", cites: [{ ref: "ticket:1", label: "#1", href: null }] }, { model: "m", promptVersion: "p" });
    await putInsight(ctx(), "plan_drift", "", { text: "Mostly billing.", cites: [{ ref: "theme:b", label: "Billing", href: null }], windowDays: 14, shares: [] }, { model: "m", promptVersion: "p" });
    expect((await get_plan(ctx())).drift).toBeDefined();
    expect((await list_sprints(ctx())).find((x) => x.id === id)!.note).toBeDefined();
    await run(env.DB, `UPDATE orgs SET ai_automation = 0 WHERE id = ?`, ORG_A);
    const plan = await get_plan(ctx());
    expect("drift" in plan).toBe(false);
    expect("note" in plan.sprints.find((x) => x.id === id)!).toBe(false);
    // …and another org never sees them.
    expect((await get_plan(systemCtx(ORG_B))).drift).toBeUndefined();
  });
});

// ── plan drift ───────────────────────────────────────────────────────────────

describe("plan drift — the SERVER counts the theme shares; the model only words them", () => {
  const SHARES: AiThemeShare[] = [
    { themeId: "billing", theme: "Billing", pct: 46, inSprint: false },
    { themeId: "hosting", theme: "Hosting", pct: 31, inSprint: true },
    { themeId: "polish", theme: "UI polish", pct: 23, inSprint: false },
  ];
  const withShares = (shares: AiThemeShare[] | null) => ({ ...PLAN_DRIFT_JOB, input: (c: Parameters<typeof driftInput>[0]) => driftInput(c, new Date(), shares) });
  const driftRow = () => first<{ json: string }>(env.DB, `SELECT json FROM org_insights WHERE kind = 'plan_drift'`);

  it("no themes yet (0064 not here) — themeShares is null, the drift says nothing, and no call is made", async () => {
    expect(await themeShares(ctx(), new Date())).toBeNull();
    await markRow(ORG_A, "org", "", new Date(Date.now() - 25 * HOUR).toISOString());
    const s = stubProviders({ claude: () => JSON.stringify({ drift: { text: "x", cites: [] } }) });
    await tick(s, [PLAN_DRIFT_JOB], later(0));
    expect(s.haiku).toBe(0);
    expect(await driftRow()).toBeNull();
  });

  it("every big theme in a sprint: nothing to say (no call); an off-plan theme: one call, the shares stored are the server's", async () => {
    await markRow(ORG_A, "org", "", new Date(Date.now() - 25 * HOUR).toISOString());
    const s0 = stubProviders();
    await tick(s0, [withShares(SHARES.map((x) => ({ ...x, inSprint: x.pct >= 25 })))], later(0));
    expect(s0.haiku).toBe(0);

    await markRow(ORG_A, "org", "", new Date(Date.now() - 25 * HOUR).toISOString());
    const s = stubProviders({ claude: () => JSON.stringify({ drift: { text: "The last two weeks went mostly to Billing (46%), which isn't in any sprint.", cites: ["theme:billing"] } }) });
    await tick(s, [withShares(SHARES)], later(0));
    expect(s.haiku).toBe(1);
    const sent = fencedBlocks(inputOf(s.haikuBodies[0] as never)).drift as { themes: { sharePct: number }[]; offPlan: string[] };
    expect(sent.themes.map((t) => t.sharePct)).toEqual([46, 31, 23]);
    expect(sent.offPlan).toEqual(["theme:billing"]);
    const stored = JSON.parse((await driftRow())!.json);
    expect(stored.shares).toEqual(SHARES);
    expect((await get_plan(ctx())).drift).toMatchObject({ windowDays: 14, cites: [{ ref: "theme:billing", label: "Billing", href: "#repo/planning" }] });
  });

  it("GUARD: a number the server did not give (the model's own share), or no off-plan theme cited, is NOT written", async () => {
    for (const bad of [
      { text: "Billing took 60% of the work.", cites: ["theme:billing"] },
      { text: "Hosting carried on as planned.", cites: ["theme:hosting"] },
    ]) {
      await markRow(ORG_A, "org", "", new Date(Date.now() - 25 * HOUR).toISOString());
      const s = stubProviders({ claude: () => JSON.stringify({ drift: bad }) });
      await tick(s, [withShares(SHARES)], later(0));
      expect(s.haiku).toBe(1);
      expect(await driftRow()).toBeNull();
    }
  });

  it("themeShares: the primary repo's merged PRs per active theme (the themes module's read), counted by the server; inSprint from the active sprints' PR links", async () => {
    const R = "SaplingLearn/sapling";
    expect(await themeShares(ctx(), new Date())).toBeNull(); // no primary repository
    await addOrgRepo(R, ORG_A, { primary: true });
    expect(await themeShares(ctx(), new Date())).toBeNull(); // 0064 not here, or no active theme: says nothing
    await withThemes(async ({ theme, prTheme }) => {
      expect(await themeShares(ctx(), new Date())).toBeNull(); // the tables, but no active theme
      const billing = await theme(ORG_A, R, "Billing");
      const hosting = await theme(ORG_A, R, "Hosting");
      expect(await themeShares(ctx(), new Date())).toBeNull(); // nothing merged
      const merge = (n: number, at = new Date()) => run(env.DB, `INSERT INTO events (org_id, repo, semantic_key, event_type, ref_number, subject_login, raw, provenance, occurred_at, recorded_at, recorded_by)
        VALUES (?, ?, ?, 'pr_merged', ?, 'x', '{}', 'webhook', ?, ?, 'test')`, ORG_A, R, `gh:pr:${n}:merged`, n, at.toISOString(), at.toISOString());
      for (const [n, t] of [[1, billing], [2, billing], [3, billing], [4, hosting]] as const) { await merge(n); await prTheme(ORG_A, R, n, t); }
      await merge(5); // unthemed: counts in the total only
      await merge(6, new Date(Date.now() - 20 * 86_400_000)); await prTheme(ORG_A, R, 6, hosting); // outside the window
      const { tickets } = await activeSprint();
      await add_ticket_link(ctx(), tickets[3], `https://github.com/${R}/pull/4`, "AndresL230");
      expect(await themeShares(ctx(), new Date())).toEqual([
        { themeId: String(billing), theme: "Billing", pct: 60, inSprint: false },
        { themeId: String(hosting), theme: "Hosting", pct: 20, inSprint: true },
      ]);
      expect(await themeShares(systemCtx(ORG_B), new Date())).toBeNull(); // another org: nothing of A's
    });
  });

  it("toAiThemeShares rounds the shares itself, drops empty themes and keeps the biggest eight", () => {
    const s = { total: 3, unthemed: 0, themes: [{ id: 1, name: "A", count: 2, share: 2 / 3 }, { id: 2, name: "B", count: 1, share: 1 / 3 }, { id: 3, name: "C", count: 0, share: 0 }] };
    expect(toAiThemeShares(s, new Set(["2"]))).toEqual([
      { themeId: "1", theme: "A", pct: 67, inSprint: false },
      { themeId: "2", theme: "B", pct: 33, inSprint: true },
    ]);
  });
});

// ── sprint drafts and the narrative: Batch API → suggestions → an admin accepts ─

async function backlog(n: number): Promise<number[]> {
  const out: number[] = [];
  for (let i = 1; i <= n; i++) out.push(await create_ticket(ctx(), { title: `Backlog item ${i}`, body: "", category: i % 2 ? "bug" : "request", priority: "normal", assignees: [] }, "AndresL230"));
  return out;
}

/** Submit the org scope's batch, end it with `answers` (by job name), and collect it. */
let round = 0;
async function batchRound(jobs: readonly (typeof SPRINT_DRAFT_JOB | typeof PLAN_NARRATIVE_JOB)[], answers: Record<string, unknown>) {
  await markRow(ORG_A, "org", "", new Date(Date.now() - 25 * HOUR).toISOString());
  const s = stubProviders();
  s.batch.id = `msgbatch_round${++round}`; // each round its own batch (ai_batches keys on the provider's id)
  const r1 = await tick(s, jobs, later(0));
  const reqs = await all<{ request_id: string; job: string }>(env.DB, `SELECT request_id, job FROM ai_batch_requests ORDER BY request_id`);
  s.batch.ended = true;
  s.batch.results = reqs.map((q) => succeededLine(q.request_id, JSON.stringify(answers[q.job])));
  const r2 = await tick(s, jobs, later(HOUR));
  return { s, r1, r2, reqs };
}

const DRAFT = (t: number[]) => ({
  sprints: [
    { name: "Bug sweep", goal: "Fix the reported bugs.", tickets: [t[0], t[2], t[4], 99999] },
    { name: "Features", goal: "Ship the small features.", tickets: [t[1], t[3], t[0]] },
  ],
  reason: "the backlog splits cleanly into bugs and features.",
});

describe("sprint drafts — ≥8 open tickets outside any sprint and none active; Batch API; an admin accepts", () => {
  it("below the backlog bar, or with a sprint active: no request at all", async () => {
    await backlog(DRAFT_MIN_BACKLOG - 1);
    const a = await batchRound([SPRINT_DRAFT_JOB], {});
    expect(a.r1.batched).toBe(0);
    await backlog(1);
    const sp = await create_sprint(ctx(), { label: "Running", urgency: "normal" }, "AndresL230");
    await set_sprint_active(ctx(), sp.id, true);
    expect((await batchRound([SPRINT_DRAFT_JOB], {})).r1.batched).toBe(0);
  });

  it("submits ONE batch request, then stores a suggestion of backlog tickets only, each once; nothing about a ticket or sprint changes", async () => {
    const t = await backlog(DRAFT_MIN_BACKLOG);
    const before = await all(env.DB, `SELECT number, status, sprint_id FROM tickets WHERE org_id = ? ORDER BY number`, ORG_A);
    const { s, r1, r2 } = await batchRound([SPRINT_DRAFT_JOB], { "roadmap.sprint_draft": DRAFT(t) });
    expect([r1.batched, s.batchCreates, s.haiku, r2.collected]).toEqual([1, 1, 0, 1]);
    const row = await first<{ kind: string; value_json: string; reason: string; state: string; item_type: string; item_ref: string }>(env.DB, `SELECT kind, value_json, reason, state, item_type, item_ref FROM ai_suggestions`);
    expect(row).toMatchObject({ kind: "sprint_draft", state: "open", item_type: "roadmap", item_ref: "org" });
    expect(JSON.parse(row!.value_json)).toEqual({ sprints: [
      { name: "Bug sweep", goal: "Fix the reported bugs.", tickets: [t[0], t[2], t[4]] },  // 99999 is no backlog ticket
      { name: "Features", goal: "Ship the small features.", tickets: [t[1], t[3]] },        // t[0] already placed
    ] });
    expect(await all(env.DB, `SELECT number, status, sprint_id FROM tickets WHERE org_id = ? ORDER BY number`, ORG_A)).toEqual(before);
    expect(await count(`SELECT COUNT(*) AS n FROM sprints`)).toBe(0);
    // An open draft is not drafted again.
    expect((await batchRound([SPRINT_DRAFT_JOB], {})).r1.batched).toBe(0);
  });

  it("ACCEPT: an admin's accept creates the sprints and moves the tickets AS THAT ADMIN; a member is forbidden; nothing is marked done or started", async () => {
    const t = await backlog(DRAFT_MIN_BACKLOG);
    await batchRound([SPRINT_DRAFT_JOB], { "roadmap.sprint_draft": DRAFT(t) });
    const id = (await first<{ id: number }>(env.DB, `SELECT id FROM ai_suggestions WHERE kind = 'sprint_draft'`))!.id;
    // A ticket closed since the draft is left where it is.
    await transition_ticket(ctx(), t[4], "done", "AndresL230");
    const member = await call<{ error: string }>("POST", `${BASE}${AI_ROUTES.accept(id)}`, await cookieFor("roadmap-member"));
    expect(member).toEqual({ status: 403, json: { error: "forbidden" } });
    expect(await count(`SELECT COUNT(*) AS n FROM sprints`)).toBe(0);
    const ok = await call<{ ok: boolean; suggestion: AiSuggestion }>("POST", `${BASE}${AI_ROUTES.accept(id)}`, await cookieFor(FIXTURE_ADMIN));
    expect(ok.status).toBe(200);
    expect(ok.json.suggestion.state).toBe("accepted");
    const sprints = await all<{ id: number; title: string; summary: string; status: string; created_by: string }>(env.DB, `SELECT id, title, summary, status, created_by FROM sprints ORDER BY id`);
    expect(sprints.map((x) => [x.title, x.summary, x.status, x.created_by])).toEqual([
      ["Bug sweep", "Fix the reported bugs.", "upcoming", FIXTURE_ADMIN],
      ["Features", "Ship the small features.", "upcoming", FIXTURE_ADMIN],
    ]);
    const placed = await all<{ number: number; sprint_id: number | null; status: string }>(env.DB, `SELECT number, sprint_id, status FROM tickets WHERE org_id = ? ORDER BY number`, ORG_A);
    expect(placed.filter((x) => x.sprint_id === sprints[0].id).map((x) => x.number)).toEqual([t[0], t[2]]); // not the closed t[4]
    expect(placed.filter((x) => x.sprint_id === sprints[1].id).map((x) => x.number)).toEqual([t[1], t[3]]);
    expect(placed.filter((x) => x.status === "done").map((x) => x.number)).toEqual([t[4]]); // only the person's own close
    expect((await first<{ decided_by: string }>(env.DB, `SELECT decided_by FROM ai_suggestions WHERE id = ?`, id))!.decided_by).toBe(FIXTURE_ADMIN);
  });
});

describe("the weekly narrative proposal — Batch API; an admin's accept is a `write_plan` as that admin", () => {
  const ANSWER = { narrative: "**Now:** hosting. **Next:** billing.", reason: "the plan still leads with tickets.", cites: [] as string[] };

  it("writes a suggestion citing what it was given; weekly: no second request within 7 days; accept writes the plan as the admin", async () => {
    const { id: sprintId } = await activeSprint();
    const { r1 } = await batchRound([PLAN_NARRATIVE_JOB], { "roadmap.plan_narrative": { ...ANSWER, cites: [`sprint:${sprintId}`, "feed:999"] } });
    expect(r1.batched).toBe(1);
    const sug = await first<{ id: number; value_json: string; cites_json: string }>(env.DB, `SELECT id, value_json, cites_json FROM ai_suggestions WHERE kind = 'plan_narrative'`);
    expect(JSON.parse(sug!.value_json)).toEqual({ narrative: ANSWER.narrative });
    expect(JSON.parse(sug!.cites_json).map((c: { ref: string }) => c.ref)).toEqual([`sprint:${sprintId}`]);
    expect((await batchRound([PLAN_NARRATIVE_JOB], {})).r1.batched).toBe(0); // weekly
    expect((await first<{ narrative: string }>(env.DB, `SELECT narrative FROM plan WHERE org_id = ?`, ORG_A))!.narrative).toBe(""); // nothing written yet
    expect((await call("POST", `${BASE}${AI_ROUTES.accept(sug!.id)}`, await cookieFor("roadmap-member"))).status).toBe(403);
    expect((await call("POST", `${BASE}${AI_ROUTES.accept(sug!.id)}`, await cookieFor(FIXTURE_ADMIN))).status).toBe(200);
    expect(await first(env.DB, `SELECT narrative, updated_by FROM plan WHERE org_id = ?`, ORG_A)).toEqual({ narrative: ANSWER.narrative, updated_by: FIXTURE_ADMIN });
    // The sprints the plan write did not list are untouched — still active, never done.
    expect((await first<{ status: string }>(env.DB, `SELECT status FROM sprints WHERE id = ?`, sprintId))!.status).toBe("in_progress");
  });

  it("GUARD: no valid cite, or a number it was not given, writes no suggestion; an edited narrative over the cap is refused and stays open", async () => {
    const { id: sprintId } = await activeSprint();
    const a = await batchRound([PLAN_NARRATIVE_JOB], { "roadmap.plan_narrative": { ...ANSWER, cites: ["sprint:424242"] } });
    expect([a.r1.batched, a.s.batchResults]).toEqual([1, 1]);
    expect(await count(`SELECT COUNT(*) AS n FROM ai_suggestions`)).toBe(0);
    const b = await batchRound([PLAN_NARRATIVE_JOB], { "roadmap.plan_narrative": { ...ANSWER, narrative: "Now: 12 sprints at once.", cites: [`sprint:${sprintId}`] } });
    expect([b.r1.batched, b.s.batchResults]).toEqual([1, 1]);
    expect(await count(`SELECT COUNT(*) AS n FROM ai_suggestions`)).toBe(0);
    await batchRound([PLAN_NARRATIVE_JOB], { "roadmap.plan_narrative": { ...ANSWER, cites: [`sprint:${sprintId}`] } });
    const id = (await first<{ id: number }>(env.DB, `SELECT id FROM ai_suggestions`))!.id;
    const r = await call<{ error: string }>("POST", `${BASE}${AI_ROUTES.accept(id)}`, await cookieFor(FIXTURE_ADMIN), { value: { narrative: "x".repeat(900) } });
    expect(r).toMatchObject({ status: 400, json: { error: "invalid" } });
    expect((await first<{ state: string }>(env.DB, `SELECT state FROM ai_suggestions WHERE id = ?`, id))!.state).toBe("open");
    expect((await first<{ narrative: string }>(env.DB, `SELECT narrative FROM plan WHERE org_id = ?`, ORG_A))!.narrative).toBe("");
  });
});

// ── the reads ────────────────────────────────────────────────────────────────

describe("GET /roadmap — notes and drift for everyone (minus their own 'Wrong?'), suggestions for an ADMIN only; MCP never gets suggestions", () => {
  it("admin vs member, and a note hidden for the person who pressed 'Wrong?'", async () => {
    const { id } = await activeSprint();
    await putInsight(ctx(), "sprint_note", String(id), { text: "Waiting on review.", cites: [{ ref: "ticket:1", label: "#1", href: "#tickets/1" }] }, { model: "m", promptVersion: "p" }, "2026-10-15T10:00:00.000Z");
    await run(env.DB, `INSERT INTO ai_suggestions (org_id, item_type, item_ref, kind, value_json, reason, cites_json, state, created_at) VALUES (?, 'roadmap', 'org', 'plan_narrative', '{"narrative":"Now: x."}', 'because.', '[]', 'open', ?)`, ORG_A, new Date().toISOString());
    const admin = await call<PlanView>("GET", `${BASE}/roadmap`, await cookieFor(FIXTURE_ADMIN));
    expect(admin.json.suggestions?.map((s) => [s.kind, s.label])).toEqual([["plan_narrative", "a new plan narrative"]]);
    expect(admin.json.sprints.find((x) => x.id === id)!.note?.text).toBe("Waiting on review.");
    const memberCookie = await cookieFor("roadmap-member");
    const member = await call<PlanView>("GET", `${BASE}/roadmap`, memberCookie);
    expect("suggestions" in member.json).toBe(false);
    expect(member.json.sprints.find((x) => x.id === id)!.note).toBeDefined();
    const fb = await call("POST", `${BASE}${AI_ROUTES.feedback}`, memberCookie, { itemType: "sprint_note", itemRef: `${id}@2026-10-15T10:00:00.000Z`, kind: "sprint_note", model: "m", promptVersion: null });
    expect(fb.status).toBe(200);
    expect((await call<PlanView>("GET", `${BASE}/roadmap`, memberCookie)).json.sprints.find((x) => x.id === id)!.note).toBeUndefined();
    expect((await call<PlanView>("GET", `${BASE}/roadmap`, await cookieFor(FIXTURE_ADMIN))).json.sprints.find((x) => x.id === id)!.note).toBeDefined();
    // The MCP read model (get_roadmap is get_plan) carries the note and no suggestion.
    const mcp = await get_plan(ctx());
    expect("suggestions" in mcp).toBe(false);
    expect(mcp.sprints.find((x) => x.id === id)!.note).toBeDefined();
  });
  // e2e RM-8 (Phase H): a sprint draft whose `sprints` was not a list threw in its label (TypeError), and the catch
  // dropped EVERY suggestion — the good draft beside it never reached the admin.
  it("a malformed sprint draft does not take the others with it: the good one is listed (the screen skips the bad one)", async () => {
    const at = new Date().toISOString();
    await run(env.DB, `INSERT INTO ai_suggestions (org_id, item_type, item_ref, kind, value_json, reason, cites_json, state, created_at) VALUES (?, 'roadmap', 'org', 'sprint_draft', ?, 'because.', '[]', 'open', ?)`,
      ORG_A, JSON.stringify({ sprints: [{ name: "Exports", goal: "CSV.", tickets: [7, 8] }] }), at);
    await run(env.DB, `INSERT INTO ai_suggestions (org_id, item_type, item_ref, kind, value_json, reason, cites_json, state, created_at) VALUES (?, 'roadmap', 'org', 'sprint_draft', '{"sprints":"not a list"}', 'because.', '[]', 'open', ?)`, ORG_A, at);
    const admin = await call<PlanView>("GET", `${BASE}/roadmap`, await cookieFor(FIXTURE_ADMIN));
    expect(admin.json.suggestions?.map((s) => s.label)).toContain("1 sprint from 2 backlog tickets");
    expect(admin.json.suggestions).toHaveLength(2);
  });
});

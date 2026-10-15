// Repo themes — "Where the work went" (docs/architecture/ai.md › Themes; src/ai/themes.ts, src/ai/themes-accept.ts,
// src/tools/themes.ts, src/data/themes.ts, 0064_repo_themes). Real D1 rows, the REAL registry's jobs run through the
// REAL pass, both providers stubbed at the `Response` level (Jev answering `choice`, the Message Batches API), and
// the cookie suggestion routes. The guards: the ≥ 15-carded-PR threshold, the cadence, cites from the input only,
// person-over-AI on `pr_themes`, the caption's discard rules, admin-only accept / rename / merge / remove, batch
// results for a deleted or switched-off org writing nothing, and the field absent when there is nothing to show.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { app } from "../src/routes";
import { runAiPass, type AiJob, type AiPassResult } from "../src/ai/pass";
import {
  PR_THEME_NONE, checkCaption, prThemeJob, themesBackfillJob, themesCaptionJob, themesProposeJob, captionBasis,
} from "../src/ai/themes";
import { orgPrefix } from "../src/ai/prefix";
import { readRepoThemes, themeShares, mondayOf } from "../src/tools/themes";
import { getRepoDashboard } from "../src/tools/repo";
import { shapeRepoDashboard } from "../src/tools/repo-agent";
import { insertProposedThemes, setPersonPrTheme, putAiPrThemes, insertCaption, mergedPrsSince } from "../src/data/themes";
import { putSuggestion } from "../src/data/ai";
import { newBudget, CRON_SUBREQUEST_BUDGET } from "../src/repo/dispatch";
import { batch as sqlBatch } from "../src/data/sql";
import { orgRowDeletes } from "../src/deletion/tables";
import { AI_ROUTES } from "@shared/ai";
import { AiThemesSchema } from "@shared/ai";
import { all, first, run } from "./helpers/db";
import { FIXTURE_ADMIN, cookieFor } from "./helpers/persons";
import { ORG_A, ORG_B, systemCtx } from "./helpers/tenant";
import { addOrgRepo } from "./helpers/org-config";
import { themesDevStatements } from "../scripts/seed/themes-dev.mjs";
import { dirtyRow, keyedEnv, markRow, stubProviders, succeededLine, type ClaudeReply, type Stub } from "./helpers/ai-pass";

const REPO = "SaplingLearn/sapling";
const BASE = "/api/o/saplinglearn";
const DAY = 86_400_000;
const MIN = 60_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const later = (ms: number) => new Date(Date.now() + ms);
const count = async (sql: string, ...p: unknown[]) => (await first<{ n: number }>(env.DB, sql, ...p))!.n;
const JOBS: readonly AiJob[] = [prThemeJob, themesProposeJob, themesCaptionJob, themesBackfillJob];

/** A merged PR of `orgId`, `days` ago; with a card (a structured summary) unless `card: false`. */
async function addPr(n: number, days: number, o: { orgId?: string; card?: boolean; title?: string } = {}): Promise<void> {
  const orgId = o.orgId ?? ORG_A;
  const at = ago(days);
  const key = `gh:pr:${n}:merged`;
  const title = o.title ?? `PR ${n}`;
  await run(env.DB, `INSERT INTO events (org_id, semantic_key, event_type, ref_number, subject_login, raw, provenance, occurred_at, recorded_at, recorded_by)
    VALUES (?, ?, 'pr_merged', ?, 'AndresL230', ?, 'webhook', ?, ?, 'github-webhook')`,
  orgId, key, n, JSON.stringify({ pr: { number: n, title, html_url: `https://github.com/${REPO}/pull/${n}`, base: { ref: "main" } } }), at, at);
  if (o.card !== false) {
    await run(env.DB, `INSERT INTO pr_summaries (org_id, semantic_key, pr_number, model, created_at, title, what, why, impact) VALUES (?, ?, ?, 'claude-haiku-5-5', ?, ?, ?, 'because', 'impact')`,
      orgId, key, n, at, `Card ${n}`, `What PR ${n} changed`);
  }
}

/** Two active themes for the repo (ids returned), as an admin would have accepted them. */
async function activeThemes(orgId = ORG_A, at = ago(1)): Promise<[number, number]> {
  const ids = await insertProposedThemes(systemCtx(orgId), REPO, [
    { name: "Billing and plans", description: "Checkout and the Pro plan.", colorKey: "ochre", position: 0, seedPrs: [] },
    { name: "Repo dashboard", description: "Capture, health and metrics.", colorKey: "slate", position: 1, seedPrs: [] },
  ], { createdBy: "trov", model: "claude-haiku-5-5", promptVersion: "propose-1" }, ago(2));
  await run(env.DB, `UPDATE repo_themes SET status = 'active', decided_by = 'admin-user', decided_at = ? WHERE org_id = ?`, at, orgId);
  return [ids[0], ids[1]];
}

const pass = (s: Stub, now: Date, e: Env = keyedEnv()): Promise<AiPassResult> => runAiPass(e, newBudget(s.fetchImpl, CRON_SUBREQUEST_BUDGET), { jobs: JOBS, now });

/** The providers, with Jev answering `choice` for the `theme` question: `pick` gets the options and says which. */
function themeStub(o: { claude?: ClaudeReply; pick?: (options: string[], state: string) => { choice: string; confidence: number } | { status: number } } = {}): Stub {
  const s = stubProviders({ claude: o.claude });
  const inner = s.fetchImpl;
  s.fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://api.typesafe.ai/")) return inner(input, init);
    s.jev++;
    const body = JSON.parse(String(init?.body)) as { state: string; questions: { theme: { criteria: Record<string, string | null> } } };
    const options = Object.keys(body.questions.theme.criteria);
    const r = (o.pick ?? ((opts) => ({ choice: opts[0], confidence: 0.9 })))(options, body.state);
    if ("status" in r) return new Response("{}", { status: r.status });
    const probabilities = Object.fromEntries(options.map((k) => [k, k === r.choice ? r.confidence : (1 - r.confidence) / (options.length - 1)]));
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers: { theme: { type: "choice", choice: r.choice, probabilities, confidence: r.confidence } }, usage: { input_tokens: 60, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return s;
}

async function call<T = unknown>(method: string, path: string, cookie: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await app.request(path, { method, headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) }, env as unknown as Env);
  return { status: res.status, json: (await res.json().catch(() => null)) as T };
}

const themesRows = (orgId = ORG_A) => all<{ id: number; name: string; status: string; color_key: string; seed_prs: string; merged_into: number | null; decided_by: string | null; created_by: string }>(
  env.DB, `SELECT id, name, status, color_key, seed_prs, merged_into, decided_by, created_by FROM repo_themes WHERE org_id = ? ORDER BY position, id`, orgId);
const prTheme = (n: number, orgId = ORG_A) => first<{ theme_id: number | null; source: string; confidence: number | null; set_by: string | null }>(
  env.DB, `SELECT theme_id, source, confidence, set_by FROM pr_themes WHERE org_id = ? AND pr_number = ?`, orgId, n);

/** A proposal's answer citing `prs` per theme (the model's shape). */
const proposal = (themes: { name: string; prs: number[] }[]) => JSON.stringify({ themes: themes.map((t) => ({ name: t.name, description: `${t.name} work.`, prs: t.prs })) });

/** Submit the theme_window batch, end it with `answer` for every request, and collect. */
async function proposeRound(s: Stub, answer: (jobOfRequest: string) => string, now = later(0)): Promise<AiPassResult> {
  const r1 = await pass(s, now);
  expect(r1.batched).toBeGreaterThan(0);
  const reqs = await all<{ request_id: string; job: string }>(env.DB, `SELECT request_id, job FROM ai_batch_requests ORDER BY request_id`);
  s.batch.ended = true;
  s.batch.results = reqs.map((q) => succeededLine(q.request_id, answer(q.job)));
  return pass(s, new Date(now.getTime() + 10 * MIN));
}

// ─────────────────────────────────────────────────────────────────────────────

describe("themes.propose: ≥ 15 carded PRs in 12 weeks, then monthly — suggestions an admin decides", () => {
  it("14 carded PRs (and uncarded ones, and older ones) propose NOTHING: no request, the scope just clears", async () => {
    await addOrgRepo(REPO);
    for (let n = 1; n <= 14; n++) await addPr(n, n);
    for (let n = 20; n <= 30; n++) await addPr(n, 2, { card: false }); // no card: not counted
    await addPr(40, 90); // older than 12 weeks: not counted
    await markRow(ORG_A, "theme_window", REPO, ago(2));
    const s = themeStub();
    const r = await pass(s, later(0));
    expect([r.batched, s.batchCreates, s.haiku, s.jev]).toEqual([0, 0, 0, 0]);
    expect((await dirtyRow(ORG_A, "theme_window", REPO))!.last_run_at).not.toBeNull(); // written as it is
    // The 15th carded PR crosses the line.
    await addPr(15, 3);
    await markRow(ORG_A, "theme_window", REPO, ago(2));
    const r2 = await pass(s, later(0));
    expect([r2.batched, s.batchCreates]).toEqual([1, 1]);
    const params = s.batchBodies[0].requests[0].params as { system: { text: string }[]; messages: { content: { text: string }[] }[] };
    expect(params.system[0].text).toContain("themes");
    expect(params.messages[0].content[0].text).toContain("# Active themes\nnone"); // the cached prefix leads
    const input = params.messages[0].content[1].text;
    expect(input).toContain("#15 Card 15 — What PR 15 changed");
    expect(input).not.toContain("#20 "); // an uncarded PR is never read
    expect(input).not.toContain("because"); // the card's title + what only, never the body
  });

  it("writes proposed themes and their suggestions; a cite outside the input is dropped and a theme left with < 3 is not written", async () => {
    await addOrgRepo(REPO);
    for (let n = 1; n <= 16; n++) await addPr(n, n);
    await markRow(ORG_A, "theme_window", REPO, ago(2));
    const s = themeStub();
    const r = await proposeRound(s, (job) => job === "themes.propose" ? proposal([
      { name: "Billing and plans", prs: [1, 2, 3, 999] },  // 999 is not in the input: dropped, 3 left → kept
      { name: "Repo dashboard", prs: [4, 5, 998, 997] },   // 2 real → not written
      { name: "  Public   site  ", prs: [6, 7, 8, 8] },    // whitespace collapsed; the repeat counts once
      { name: "billing AND plans", prs: [9, 10, 11] },     // a repeat name: not written
    ]) : "{}");
    expect(r.collected).toBe(1);
    const rows = await themesRows();
    expect(rows.map((t) => [t.name, t.status, JSON.parse(t.seed_prs)])).toEqual([["Billing and plans", "proposed", [1, 2, 3]], ["Public site", "proposed", [6, 7, 8]]]);
    expect(rows.every((t) => t.created_by === "trov")).toBe(true);
    expect(new Set(rows.map((t) => t.color_key)).size).toBe(2); // the server's colours, distinct
    const sugg = await all<{ kind: string; item_type: string; item_ref: string; state: string; reason: string; cites_json: string }>(env.DB,
      `SELECT kind, item_type, item_ref, state, reason, cites_json FROM ai_suggestions WHERE org_id = ? ORDER BY id`, ORG_A);
    expect(sugg.map((x) => [x.kind, x.item_type, x.item_ref, x.state])).toEqual([
      ["themes.propose", "theme", `${REPO}#${rows[0].id}`, "open"], ["themes.propose", "theme", `${REPO}#${rows[1].id}`, "open"]]);
    expect(JSON.parse(sugg[0].cites_json).map((c: { ref: string }) => c.ref)).toEqual(["pr:1", "pr:2", "pr:3"]);
    expect(await dirtyRow(ORG_A, "theme_window", REPO)).toMatchObject({ attempts: 0, last_error: null });
    // NOTHING is active: no PR is classified, and the screen shows proposals only.
    expect(await count(`SELECT COUNT(*) AS n FROM pr_themes`)).toBe(0);
    // Waiting on an admin: the next window proposes nothing (no request).
    await markRow(ORG_A, "theme_window", REPO, ago(2));
    const s2 = themeStub();
    expect((await pass(s2, later(DAY))).batched).toBe(0);
  });

  it("then monthly: within 30 days of the last proposal nothing; after, additions only (never an active theme's name)", async () => {
    await addOrgRepo(REPO);
    for (let n = 1; n <= 16; n++) await addPr(n, n);
    await activeThemes(ORG_A, ago(40));
    await run(env.DB, `UPDATE repo_themes SET created_at = ? WHERE org_id = ?`, ago(10), ORG_A);
    await markRow(ORG_A, "theme_window", REPO, ago(2));
    const s = themeStub();
    await pass(s, later(0));
    expect(s.batchBodies.flatMap((b) => b.requests).length).toBe(1); // the caption only
    await run(env.DB, `DELETE FROM ai_batch_requests`);
    await run(env.DB, `DELETE FROM ai_batches`);
    await run(env.DB, `UPDATE repo_themes SET created_at = ? WHERE org_id = ?`, ago(31), ORG_A);
    await markRow(ORG_A, "theme_window", REPO, ago(2));
    const s2 = themeStub();
    await proposeRound(s2, (job) => job === "themes.propose" ? proposal([{ name: "Repo dashboard", prs: [1, 2, 3] }, { name: "Docs", prs: [4, 5, 6] }]) : JSON.stringify({ caption: "x", theme_ids: [] }));
    const input = (s2.batchBodies[0].requests.find((q) => JSON.stringify(q.params).includes("Existing active themes"))!.params as { messages: { content: { text: string }[] }[] }).messages[0].content[1].text;
    expect(input).toContain("- Billing and plans: Checkout and the Pro plan.");
    expect(input).toContain("Propose at most 6 new themes.");
    expect((await themesRows()).map((t) => [t.name, t.status])).toEqual([["Billing and plans", "active"], ["Repo dashboard", "active"], ["Docs", "proposed"]]);
  });

  it("a batch result for a DELETED org, or one whose switch went OFF, writes nothing", async () => {
    await run(env.DB, `INSERT INTO orgs (id, slug, name, created_at, created_by) VALUES ('org_gone', 'gone', 'Gone', '2026-10-01', 'test')`);
    for (const o of [ORG_A, ORG_B, "org_gone"]) {
      await addOrgRepo(REPO, o);
      for (let n = 1; n <= 15; n++) await addPr(n, n, { orgId: o });
      await markRow(o, "theme_window", REPO, ago(8));
    }
    const s = themeStub();
    expect((await pass(s, later(0))).batched).toBe(3);
    await sqlBatch(systemCtx("org_gone"), orgRowDeletes(systemCtx("org_gone")));
    await run(env.DB, `DELETE FROM orgs WHERE id = 'org_gone'`);
    await run(env.DB, `UPDATE orgs SET ai_automation = 0 WHERE id = ?`, ORG_B);
    const reqs = await all<{ request_id: string }>(env.DB, `SELECT request_id FROM ai_batch_requests ORDER BY request_id`);
    s.batch.ended = true;
    s.batch.results = reqs.map((q) => succeededLine(q.request_id, proposal([{ name: "Billing and plans", prs: [1, 2, 3] }])));
    const r = await pass(s, later(10 * MIN));
    expect(r.collected).toBe(1);
    expect(await count(`SELECT COUNT(*) AS n FROM repo_themes WHERE org_id = ?`, ORG_A)).toBe(1);
    expect(await count(`SELECT COUNT(*) AS n FROM repo_themes WHERE org_id <> ?`, ORG_A)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM ai_suggestions WHERE org_id <> ?`, ORG_A)).toBe(0);
  });
});

describe("accept, rename, merge, remove — an ADMIN's, through the cookie suggestion routes", () => {
  async function proposed(): Promise<{ ids: number[]; sugg: number[] }> {
    await addOrgRepo(REPO);
    const ids = await insertProposedThemes(systemCtx(), REPO, [
      { name: "Billing and plans", description: "Checkout.", colorKey: "ochre", position: 0, seedPrs: [1, 2, 3] },
      { name: "Repo dashboard", description: "Capture.", colorKey: "slate", position: 1, seedPrs: [4, 5, 6] },
      { name: "Payments", description: "Stripe.", colorKey: "rose", position: 2, seedPrs: [7, 8, 9] },
    ], { createdBy: "trov", model: "claude-haiku-5-5", promptVersion: "propose-1" });
    const sugg: number[] = [];
    for (const [k, id] of ids.entries()) {
      sugg.push((await putSuggestion(systemCtx(), { itemType: "theme", itemRef: `${REPO}#${id}`, kind: "themes.propose", value: { name: ["Billing and plans", "Repo dashboard", "Payments"][k], description: "d" }, confidence: null, reason: "Because.", cites: [], model: "m", promptVersion: "propose-1" }))!);
    }
    return { ids, sugg };
  }
  const backfillMarked = () => dirtyRow(ORG_A, "theme_backfill", REPO);

  it("a member can neither accept, rename, merge nor remove (403); nothing changes", async () => {
    const { ids, sugg } = await proposed();
    const member = await cookieFor("theme-member");
    for (const body of [{}, { value: { name: "X" } }, { value: { mergeInto: ids[1] } }]) {
      expect(await call("POST", `${BASE}${AI_ROUTES.accept(sugg[0])}`, member, body)).toEqual({ status: 403, json: { error: "forbidden" } });
    }
    expect(await call("POST", `${BASE}${AI_ROUTES.dismiss(sugg[0])}`, member, {})).toEqual({ status: 403, json: { error: "forbidden" } });
    expect((await themesRows()).map((t) => t.status)).toEqual(["proposed", "proposed", "proposed"]);
    expect(await backfillMarked()).toBeNull();
    // A bearer is refused outright (cookie only).
    const res = await app.request(`${BASE}${AI_ROUTES.accept(sugg[0])}`, { method: "POST", headers: { authorization: "Bearer trov_mcp_x", "content-type": "application/json" }, body: "{}" }, env as unknown as Env);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("accept makes it active as the admin and marks theme_backfill; rename activates it under the admin's name", async () => {
    const { ids, sugg } = await proposed();
    const admin = await cookieFor(FIXTURE_ADMIN);
    const a = await call<{ ok: boolean }>("POST", `${BASE}${AI_ROUTES.accept(sugg[0])}`, admin, {});
    expect(a.status).toBe(200);
    expect(await backfillMarked()).toMatchObject({ scope: "theme_backfill", scope_key: REPO });
    const r = await call("POST", `${BASE}${AI_ROUTES.accept(sugg[1])}`, admin, { value: { name: "  Repo   health " } });
    expect(r.status).toBe(200);
    const rows = await themesRows();
    expect(rows.map((t) => [t.id, t.name, t.status, t.decided_by])).toEqual([
      [ids[0], "Billing and plans", "active", FIXTURE_ADMIN], [ids[1], "Repo health", "active", FIXTURE_ADMIN], [ids[2], "Payments", "proposed", null]]);
    // A name taken by a live theme is `invalid` and the suggestion stays open; so is an empty or a bad value.
    expect(await call("POST", `${BASE}${AI_ROUTES.accept(sugg[2])}`, admin, { value: { name: "billing and PLANS" } })).toEqual({ status: 400, json: { error: "invalid" } });
    expect(await call("POST", `${BASE}${AI_ROUTES.accept(sugg[2])}`, admin, { value: { name: "   " } })).toEqual({ status: 400, json: { error: "invalid" } });
    expect(await call("POST", `${BASE}${AI_ROUTES.accept(sugg[2])}`, admin, { value: { name: "x".repeat(41) } })).toEqual({ status: 400, json: { error: "invalid" } });
    expect(await call("POST", `${BASE}${AI_ROUTES.accept(sugg[2])}`, admin, { value: "Payments" })).toEqual({ status: 400, json: { error: "invalid" } });
    expect((await first<{ state: string }>(env.DB, `SELECT state FROM ai_suggestions WHERE id = ?`, sugg[2]))!.state).toBe("open");
    // Decided once: a second accept is not_open.
    expect((await call("POST", `${BASE}${AI_ROUTES.accept(sugg[0])}`, admin, {})).status).toBe(409);
  });

  it("merge folds a proposed theme into another live one (its PRs join), and remove (dismiss) removes it — an admin's", async () => {
    const { ids, sugg } = await proposed();
    const admin = await cookieFor(FIXTURE_ADMIN);
    // Into itself, into nothing, into another org's id: invalid.
    expect((await call("POST", `${BASE}${AI_ROUTES.accept(sugg[2])}`, admin, { value: { mergeInto: ids[2] } })).status).toBe(400);
    expect((await call("POST", `${BASE}${AI_ROUTES.accept(sugg[2])}`, admin, { value: { mergeInto: 999_999 } })).status).toBe(400);
    expect((await call("POST", `${BASE}${AI_ROUTES.accept(sugg[2])}`, admin, { value: { mergeInto: ids[0] } })).status).toBe(200);
    let rows = await themesRows();
    expect(rows.find((t) => t.id === ids[2])).toMatchObject({ status: "removed", merged_into: ids[0], decided_by: FIXTURE_ADMIN });
    expect(JSON.parse(rows.find((t) => t.id === ids[0])!.seed_prs).sort()).toEqual([1, 2, 3, 7, 8, 9]);
    expect(await backfillMarked()).toBeNull(); // merged into a PROPOSED theme: nothing to classify yet
    expect((await call("POST", `${BASE}${AI_ROUTES.dismiss(sugg[1])}`, admin, {})).status).toBe(200);
    rows = await themesRows();
    expect(rows.find((t) => t.id === ids[1])).toMatchObject({ status: "removed", decided_by: FIXTURE_ADMIN });
  });
});

describe("pr.theme (Jev choice), and person-over-AI", () => {
  it("one Jev request per merged PR card once themes exist; writes source='ai' with the confidence", async () => {
    await addOrgRepo(REPO);
    const [billing, repo] = await activeThemes();
    await addPr(201, 1);
    await addPr(202, 1);
    await markRow(ORG_A, "card", "pr:201", ago(0.01));
    await markRow(ORG_A, "card", "pr:202", ago(0.01));
    const s = themeStub({ pick: (opts, state) => (state.includes("#201") ? { choice: "Repo dashboard", confidence: 0.8 } : { choice: "Billing and plans", confidence: 0.7 }) });
    const r = await pass(s, later(0));
    expect([r.jev, r.haiku]).toEqual([2, 0]);
    expect(await prTheme(201)).toEqual({ theme_id: repo, source: "ai", confidence: 0.8, set_by: null });
    expect(await prTheme(202)).toMatchObject({ theme_id: billing, source: "ai" });
    // The question asked: the active themes plus "none of these"; the state is the card, never the body.
    expect(await count(`SELECT COALESCE(SUM(count), 0) AS n FROM org_usage_daily WHERE metric = 'ai_suggest'`)).toBe(2);
  });

  it("with no active theme there is no request; 'none of these' or a low confidence writes nothing (and is not a failure)", async () => {
    await addOrgRepo(REPO);
    await addPr(201, 1);
    await markRow(ORG_A, "card", "pr:201", ago(0.01));
    const s = themeStub();
    await pass(s, later(0));
    expect(s.jev).toBe(0);
    await activeThemes();
    await addPr(202, 1);
    await markRow(ORG_A, "card", "pr:201", ago(0.01));
    await markRow(ORG_A, "card", "pr:202", ago(0.01));
    const options: string[][] = [];
    const s2 = themeStub({ pick: (opts, state) => { options.push(opts); return state.includes("#201") ? { choice: PR_THEME_NONE, confidence: 0.9 } : { choice: "Repo dashboard", confidence: 0.4 }; } });
    await pass(s2, later(0));
    expect(s2.jev).toBe(2);
    expect(options[0]).toEqual(["Billing and plans", "Repo dashboard", PR_THEME_NONE]);
    expect(await count(`SELECT COUNT(*) AS n FROM pr_themes`)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM ai_dirty WHERE scope = 'card'`)).toBe(0); // both answered: written
  });

  it("PERSON OVER AI: a PR a person themed is never asked about (zero requests) and never overwritten — by Jev or the backfill", async () => {
    await addOrgRepo(REPO);
    const [billing, repo] = await activeThemes();
    await addPr(201, 1);
    await setPersonPrTheme(systemCtx(), REPO, 201, billing, "AndresL230");
    await markRow(ORG_A, "card", "pr:201", ago(0.01));
    const s = themeStub({ pick: () => ({ choice: "Repo dashboard", confidence: 0.99 }) });
    await pass(s, later(0));
    expect(s.jev).toBe(0);
    // Even a direct AI write cannot replace it (the guarded upsert).
    expect(await putAiPrThemes(systemCtx(), REPO, [{ pr: 201, themeId: repo, confidence: 0.99, model: "jev", promptVersion: "x" }])).toBe(0);
    expect(await prTheme(201)).toEqual({ theme_id: billing, source: "person", confidence: null, set_by: "AndresL230" });
  });
});

describe("themes.backfill: the window's earlier PRs, through the Batch API, after an accept", () => {
  it("classifies unclassified and older AI picks, never a person's; a pick outside the input or the active themes is dropped", async () => {
    await addOrgRepo(REPO);
    const [billing, repo] = await activeThemes(ORG_A, ago(1));
    for (const n of [301, 302, 303, 304]) await addPr(n, 10);
    await addPr(305, 100); // outside the 12 weeks
    await setPersonPrTheme(systemCtx(), REPO, 303, repo, "AndresL230");
    await putAiPrThemes(systemCtx(), REPO, [{ pr: 304, themeId: billing, confidence: 0.6, model: "jev", promptVersion: "x" }], ago(5)); // before the accept
    await markRow(ORG_A, "theme_backfill", REPO, ago(0.01));
    const s = themeStub();
    const r1 = await pass(s, later(0));
    expect(r1.batched).toBe(1);
    const input = (s.batchBodies[0].requests[0].params as { messages: { content: { text: string }[] }[] }).messages[0].content[1].text;
    expect(input).toContain("#301 ");
    expect(input).toContain("#304 ");
    expect(input).not.toContain("#303 "); // a person's
    expect(input).not.toContain("#305 ");
    const reqs = await all<{ request_id: string }>(env.DB, `SELECT request_id FROM ai_batch_requests`);
    s.batch.ended = true;
    s.batch.results = [succeededLine(reqs[0].request_id, JSON.stringify({ prs: [
      { pr: 301, theme_id: repo }, { pr: 302, theme_id: null }, { pr: 303, theme_id: billing }, { pr: 304, theme_id: repo },
      { pr: 999, theme_id: repo }, { pr: 301, theme_id: billing }, { pr: 302, theme_id: 424242 },
    ] }))];
    expect((await pass(s, later(10 * MIN))).collected).toBe(1);
    expect(await prTheme(301)).toMatchObject({ theme_id: repo, source: "ai" });
    expect(await prTheme(302)).toBeNull();
    expect(await prTheme(303)).toMatchObject({ theme_id: repo, source: "person" });
    expect(await prTheme(304)).toMatchObject({ theme_id: repo, source: "ai", confidence: null });
    expect(await prTheme(999)).toBeNull();
  });
});

describe("themes.caption: the server's shares in, one sentence out — or nothing", () => {
  const active = [{ id: 1, name: "Billing and plans" }, { id: 2, name: "Repo dashboard" }];
  it("checkCaption: a digit, an inactive theme (by id or by name), no theme, or a bad length DISCARDS it", () => {
    const ok = "Most of the work went to Billing and plans, then the Repo dashboard picked up late.";
    expect(checkCaption(ok, [1, 2], active, ["Public site"])).toEqual({ caption: ok, ids: [1, 2] });
    expect(checkCaption("Billing and plans took 40% of the work.", [1], active, [])).toBeNull();
    expect(checkCaption("Billing and plans took most of the work in week ３.", [1], active, [])).toBeNull(); // a full-width digit
    expect(checkCaption(ok, [1, 3], active, [])).toBeNull(); // id 3 is not active
    expect(checkCaption("Billing and plans led, then the public SITE took over.", [1], active, ["Public site"])).toBeNull();
    expect(checkCaption("Billing and plans led all along, steady to the end.", [1], active, ["Billing"])).not.toBeNull(); // contained in an active name
    expect(checkCaption(ok, [], active, [])).toBeNull();
    expect(checkCaption("Billing.", [1], active, [])).toBeNull();
    expect(checkCaption(`Billing and plans ${"led ".repeat(80)}`, [1], active, [])).toBeNull();
  });

  it("the job: shares computed by the server and sent in; a digit caption is discarded (nothing stored); a good one stored; the same basis makes no call", async () => {
    await addOrgRepo(REPO);
    const [billing, repo] = await activeThemes();
    for (const n of [1, 2, 3]) await addPr(n, 2);
    await addPr(4, 30);
    await putAiPrThemes(systemCtx(), REPO, [{ pr: 1, themeId: billing, confidence: 0.9, model: "j", promptVersion: "x" }, { pr: 2, themeId: billing, confidence: 0.9, model: "j", promptVersion: "x" }, { pr: 4, themeId: repo, confidence: 0.9, model: "j", promptVersion: "x" }]);
    // Nothing to propose (themes exist, recently): only the caption goes.
    await run(env.DB, `UPDATE repo_themes SET created_at = ? WHERE org_id = ?`, ago(1), ORG_A);
    await markRow(ORG_A, "theme_window", REPO, ago(2));
    const s = themeStub();
    await proposeRound(s, () => JSON.stringify({ caption: "Billing and plans took 67% of the work.", theme_ids: [billing] }));
    const input = (s.batchBodies[0].requests[0].params as { messages: { content: { text: string }[] }[] }).messages[0].content[1].text;
    expect(input).toContain(`- id ${billing}: Billing and plans`);
    expect(input).toMatch(/Billing and plans 67%, Repo dashboard 0%/); // this week's shares, computed here
    expect(await count(`SELECT COUNT(*) AS n FROM repo_theme_captions`)).toBe(0);
    expect(await dirtyRow(ORG_A, "theme_window", REPO)).toMatchObject({ attempts: 1, last_error: "not_written" });
    // A good one.
    await run(env.DB, `DELETE FROM ai_batch_requests`); await run(env.DB, `DELETE FROM ai_batches`);
    await markRow(ORG_A, "theme_window", REPO, ago(2));
    const s2 = themeStub();
    await proposeRound(s2, () => JSON.stringify({ caption: "Most of the work went to Billing and plans; the Repo dashboard came earlier.", theme_ids: [billing, repo] }));
    expect(await first(env.DB, `SELECT caption, theme_ids, range FROM repo_theme_captions`)).toEqual({ caption: "Most of the work went to Billing and plans; the Repo dashboard came earlier.", theme_ids: JSON.stringify([billing, repo]), range: "8w" });
    // Same shares again: no request.
    await markRow(ORG_A, "theme_window", REPO, ago(2));
    const s3 = themeStub();
    expect((await pass(s3, later(DAY))).batched).toBe(0);
  });

  it("captionBasis: per-week and per-half shares; null when nothing merged in the window", () => {
    const now = Date.now();
    const row = (n: number, days: number, theme: number | null) => ({ number: n, at: ago(days), theme_id: theme } as unknown as Parameters<typeof captionBasis>[3][number]);
    expect(captionBasis(REPO, active, [], [], now)).toBeNull();
    const c = captionBasis(REPO, active, [], [row(1, 0, 1), row(2, 0, 2), row(3, 0, null), row(4, 0, 1)], now)!;
    expect(c.perWeek.at(-1)).toEqual({ shares: [0.5, 0.25], total: 4 });
    expect(c.halves[0].total).toBe(0);
  });
});

describe("the read: RepoDashboard.themes (and get_repo_dashboard's planning tab)", () => {
  it("ABSENT with no theme, with no repository, and with the switch off — on the screen's read and on MCP's", async () => {
    await addOrgRepo(REPO);
    const ctx = systemCtx();
    expect(await readRepoThemes(ctx, REPO)).toBeUndefined();
    const dash = await getRepoDashboard(ctx, REPO);
    expect("themes" in dash).toBe(false);
    expect("themes" in shapeRepoDashboard(dash, { tab: "planning" })).toBe(false);
    await activeThemes();
    expect(await readRepoThemes(ctx, "")).toBeUndefined();
    expect(await readRepoThemes(ctx, REPO)).toBeDefined();
    await run(env.DB, `UPDATE orgs SET ai_automation = 0 WHERE id = ?`, ORG_A);
    expect(await readRepoThemes(ctx, REPO)).toBeUndefined();
    expect("themes" in (await getRepoDashboard(ctx, REPO))).toBe(false);
  });

  it("counts merged PRs per theme per UTC Monday week, from rows; the caption only while its themes are active; proposed lanes carry their suggestion", async () => {
    await addOrgRepo(REPO);
    const [billing, repo] = await activeThemes();
    await addPr(1, 0); await addPr(2, 0); await addPr(3, 8); await addPr(4, 70); await addPr(5, 120);
    await putAiPrThemes(systemCtx(), REPO, [1, 3, 4, 5].map((n) => ({ pr: n, themeId: billing, confidence: 0.9, model: "j", promptVersion: "x" })));
    await setPersonPrTheme(systemCtx(), REPO, 2, repo, "AndresL230");
    await insertCaption(systemCtx(), REPO, "8w", { caption: "Most of it went to Billing and plans.", themeIds: [billing], basisHash: "h", model: "claude-haiku-5-5", promptVersion: "caption-1" });
    const [pid] = await insertProposedThemes(systemCtx(), REPO, [{ name: "Docs", description: "The docs.", colorKey: "plum", position: 2, seedPrs: [1, 3] }], { createdBy: "trov", model: "claude-haiku-5-5", promptVersion: "propose-1" });
    const [hidden] = await insertProposedThemes(systemCtx(), REPO, [{ name: "Orphan", description: "No suggestion.", colorKey: "rust", position: 3, seedPrs: [] }], { createdBy: "trov", model: "m", promptVersion: "p" });
    const sid = (await putSuggestion(systemCtx(), { itemType: "theme", itemRef: `${REPO}#${pid}`, kind: "themes.propose", value: { name: "Docs" }, confidence: null, reason: "The docs.", cites: [], model: "m", promptVersion: "propose-1" }))!;
    const t = (await readRepoThemes(systemCtx(), REPO))!;
    for (const r of ["8w", "quarter"] as const) expect(AiThemesSchema.safeParse(t[r]).success).toBe(true);
    const w8 = t["8w"];
    expect(w8.weeks).toHaveLength(8);
    expect(w8.weeks.at(-1)).toBe(mondayOf(Date.now()));
    expect(w8.lanes.map((l) => [l.name, l.status, l.suggestionId])).toEqual([["Billing and plans", "active", null], ["Repo dashboard", "active", null], ["Docs", "proposed", sid]]);
    expect(w8.lanes.some((l) => l.id === String(hidden))).toBe(false); // no open suggestion: not drawn
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    expect(sum(w8.lanes[0].counts)).toBe(2); // #1 and #3 (#4 is older than 8 weeks)
    expect(w8.lanes[0].counts.at(-1)).toBe(1);
    expect(sum(w8.lanes[1].counts)).toBe(1); // the person's pick counts like any
    expect(sum(w8.lanes[2].counts)).toBe(2); // a proposal draws its cited PRs
    expect(w8.lanes[0].prs[0]).toEqual({ ref: "pr:1", label: "#1 Card 1", href: `https://github.com/${REPO}/pull/1` });
    expect(w8.caption).toBe("Most of it went to Billing and plans.");
    expect(w8.prCount).toBe(3);
    const q = t.quarter;
    expect(q.weeks).toHaveLength(13);
    expect(sum(q.lanes[0].counts)).toBe(3); // #4 at 10 weeks is in the quarter; #5 is not
    expect(q.caption).toBeNull(); // the caption speaks of eight weeks only
    // A caption naming a theme no longer active is not shown.
    await run(env.DB, `UPDATE repo_themes SET status = 'removed' WHERE id = ?`, billing);
    expect((await readRepoThemes(systemCtx(), REPO))!["8w"].caption).toBeNull();
    // MCP's planning tab carries it; another tab does not.
    const dash = await getRepoDashboard(systemCtx(), REPO);
    expect(shapeRepoDashboard(dash, { tab: "planning" }).themes?.["8w"].lanes.length).toBeGreaterThan(0);
    expect(shapeRepoDashboard(dash, { tab: "overview" }).themes).toBeUndefined();
  });

  it("themeShares: each active theme's share of the PRs merged in a window; null with no active theme", async () => {
    await addOrgRepo(REPO);
    expect(await themeShares(systemCtx(), REPO, ago(30), ago(0))).toBeNull();
    const [billing] = await activeThemes();
    for (const n of [1, 2, 3, 4]) await addPr(n, 3);
    await putAiPrThemes(systemCtx(), REPO, [1, 2, 3].map((n) => ({ pr: n, themeId: billing, confidence: 0.9, model: "j", promptVersion: "x" })));
    const s = (await themeShares(systemCtx(), REPO, ago(30), new Date(Date.now() + MIN).toISOString()))!;
    expect(s).toEqual({ total: 4, themes: [{ id: billing, name: "Billing and plans", count: 3, share: 0.75 }, expect.objectContaining({ name: "Repo dashboard", count: 0, share: 0 })], unthemed: 1 });
    expect((await mergedPrsSince(systemCtx(), REPO, ago(30))).length).toBe(4);
  });

  it("the local dev seed (fixtures/dev/themes.json) draws a real section: active lanes, a person's pick, a caption, a proposal to decide", async () => {
    const fx = JSON.parse(Object.values(import.meta.glob("../fixtures/dev/themes.json", { query: "?raw", import: "default", eager: true }))[0] as string) as Record<string, unknown>;
    for (const st of themesDevStatements(fx)) await env.DB.prepare(st).run();
    const t = (await readRepoThemes(systemCtx(), REPO))!;
    expect(t).toBeDefined();
    const w8 = t["8w"];
    expect(w8.lanes.map((l) => [l.name, l.status])).toEqual([
      ["Repo dashboard", "active"], ["Tickets and sprints", "active"], ["Billing and plans", "active"], ["Organizations and sign-in", "active"], ["Emails and digests", "proposed"]]);
    expect(w8.lanes.every((l) => l.counts.length === 8)).toBe(true);
    expect(w8.lanes.slice(0, 4).every((l) => l.counts.some((c) => c > 0))).toBe(true);
    expect(w8.lanes[4].suggestionId).not.toBeNull();
    expect(w8.caption).toMatch(/^Most of the work/);
    expect(checkCaption(w8.caption!, [1], [{ id: 1, name: "x" }], [])).not.toBeNull(); // the sample keeps the rules
    expect(await prTheme(171)).toMatchObject({ source: "person", set_by: "AndresL230" });
    // The proposal is decidable through the real route.
    const admin = await cookieFor(FIXTURE_ADMIN);
    expect((await call("POST", `${BASE}${AI_ROUTES.accept(w8.lanes[4].suggestionId!)}`, admin, { value: { name: "Emails" } })).status).toBe(200);
    expect((await readRepoThemes(systemCtx(), REPO))!["8w"].lanes.at(-1)).toMatchObject({ name: "Emails", status: "active" });
  });

  it("the cached prefix names the org's active themes", async () => {
    await addOrgRepo(REPO);
    expect(await orgPrefix(systemCtx())).toContain("# Active themes\nnone");
    await activeThemes();
    expect(await orgPrefix(systemCtx())).toContain("# Active themes\n- Billing and plans: Checkout and the Pro plan.\n- Repo dashboard: Capture, health and metrics.");
  });
});

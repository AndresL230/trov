// Sync GitHub as a RUN (docs/architecture/sync.md; 0046_sync_runs): what each batch reports, the run
// record from start to end, the lock, the read every member has, and that nothing a run keeps or
// answers with is upstream text or a credential. GitHub and Gemini are stubs — never the network.
import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { SYNC_MAX_BATCHES, SYNC_PHASES, SYNC_RUN_RETENTION_DAYS, SYNC_STALE_MS, syncFailureText, type SyncRunView, type SyncStatusView } from "@shared/sync";
import { app } from "../src/routes";
import { runBackfill, type BackfillResult } from "../src/tools/backfill";
import type { PrSummary, Summarizer } from "../src/tools/summarize";
import { runSyncBatch, syncStatus, type SyncBatchResult } from "../src/sync/runs";
import { localUpstreamFetch } from "../src/sync/local-upstream";
import { pruneSyncRuns } from "../src/platform/sweeps";
import { putSnapshot } from "../src/repo/store";
import { all, first, run } from "./helpers/db";
import { cookieFor } from "./helpers/persons";
import { syncOrgConfig } from "./helpers/org-config";
import { ORG_A, ORG_B, ensureMember, platformCtx, systemCtx, tenantCtx } from "./helpers/tenant";

const TOKEN = "ghs_SECRET_service_token_0123456789";
const e = (over: Partial<Env> = {}): Env => ({ ...(env as unknown as Env), GITHUB_SERVICE_TOKEN: TOKEN, GITHUB_REPO: "o/r", ...over });
const ready = () => syncOrgConfig(e());
const admin = (handle = "admin-user") => tenantCtx(handle, "admin");

const pr = (number: number) => ({
  number, title: `PR ${number}`, body: `body ${number}`, html_url: `https://github.com/o/r/pull/${number}`,
  merged_at: "2026-06-28T00:00:00Z", closed_at: "2026-06-28T00:00:00Z", updated_at: "2026-06-28T00:00:00Z", user: { login: "octocat" }, milestone: null,
});
const issue = (number: number, assigned = true) => ({
  number, title: `Issue ${number}`, body: "Something is wrong.", html_url: `https://github.com/o/r/issues/${number}`, state: "open",
  updated_at: "2026-06-28T00:00:00Z", user: { login: "octocat" }, assignees: assigned ? [{ login: "octocat" }] : [], labels: [], milestone: null,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const github = (prs: unknown[], issues: unknown[]): typeof fetch => (async (url: string | URL | Request) => {
  const u = String(url);
  return json(u.includes("/pulls") ? prs : u.includes("/issues") ? issues : []);
}) as unknown as typeof fetch;
const summarizer = (): Summarizer<PrSummary> => ({ model: "test-model", summarize: async () => ({ title: "t", what: "w", why: null, impact: null }) });
const reconciled = (failed: string[] = [], written = 4) => vi.fn(async () => ({ written, unchanged: 9, failed }));

interface Row { id: number; org_id: string; status: string; batch: number; batches: number | null; phase: string; done: number | null; total: number | null; started_by: string; counts: string; failures: string; ended_at: string | null; updated_at: string; repo: string; previous_at: string | null }
const rows = (orgId: string = ORG_A) => all<Row>(env.DB, `SELECT * FROM sync_runs WHERE org_id = ? ORDER BY id`, orgId);
const ok = (a: Awaited<ReturnType<typeof runSyncBatch>>): SyncBatchResult => { expect(a.status).toBe(200); return a.body as SyncBatchResult; };

describe("one batch reports where it stands", () => {
  it("each phase in order — totals unknown while GitHub is being listed, known while saving — then the closing refresh, then done", async () => {
    await ready();
    const seen: Pick<Row, "phase" | "done" | "total" | "status" | "batch">[] = [];
    const snap = async () => { const r = (await rows())[0]; seen.push({ phase: r.phase, done: r.done, total: r.total, status: r.status, batch: r.batch }); };
    const reconcile = vi.fn(async () => { await snap(); return { written: 4, unchanged: 9, failed: [] as string[] }; });
    const out = ok(await runSyncBatch(e(), await admin(), "admin-user", { batch: 1, of: SYNC_MAX_BATCHES, start: true }, {
      backfill: (env2, ctx, by, o) => runBackfill(env2, ctx, by, { ...o, onProgress: async (p) => { await o!.onProgress!(p); await snap(); } }),
      backfillOpts: { fetchImpl: github([pr(1), pr(2), pr(3)], [issue(20), issue(21, false)]), summarizer: summarizer(), issueSummarizer: null, summaryCallDelayMs: 0 },
      reconcile,
    }));
    const phases = seen.map((s) => s.phase);
    expect([...new Set(phases)]).toEqual(["reading_prs", "reading_issues", "saving_issues", "saving_prs", "reconcile"]);
    expect(phases.every((p) => (SYNC_PHASES as readonly string[]).includes(p))).toBe(true);
    for (const s of seen) {
      expect(s.status).toBe("running");
      if (s.phase === "reading_prs" || s.phase === "reading_issues" || s.phase === "reconcile") expect(s.total).toBeNull();
    }
    expect(seen.find((s) => s.phase === "saving_issues")).toMatchObject({ done: 0, total: 2 });
    expect(seen.find((s) => s.phase === "saving_prs")).toMatchObject({ done: 0, total: 3 });
    expect(reconcile).toHaveBeenCalledTimes(1);

    // The answer: the backfill's own result, unchanged, plus the run and the allowance.
    expect(out).toMatchObject({ ok: true, captured: 5, unchanged: 0, summarized: 3, summaryBudgetExhausted: false, prs: 3, issues: 2, repo: { written: 4, unchanged: 9, failed: [] } });
    expect(out.run).toMatchObject({
      repo: "o/r", by: "admin-user", status: "ok", batch: 1, batches: 1, phase: "done", done: null, total: null, failures: [], previous_at: null,
      counts: {
        prs_seen: 3, issues_seen: 2, prs_new: 3, issues_changed: 2, tickets_created: 2, tickets_updated: 0,
        summaries_written: 3, summaries_failed: 0, summaries_skipped: 1, summaries_pending: 1, repo_written: 4,
      },
    });
    expect(out.run.ended_at).not.toBeNull();
    expect(out.summaries).toMatchObject({ status: "off", per_run: 50 });
  });

  it("counts accumulate across batches, the expected number of batches is reported, and only the last batch reconciles", async () => {
    await ready();
    const ctx = await admin();
    const reconcile = reconciled();
    const opts = { backfillOpts: { fetchImpl: github([1, 2, 3, 4, 5].map(pr), [issue(20, false)]), summarizer: summarizer(), summaryBatchLimit: 2, summaryCallDelayMs: 0 }, reconcile };
    const one = ok(await runSyncBatch(e(), ctx, "admin-user", { batch: 1, of: 10, start: true }, opts));
    expect(one.summaryBudgetExhausted).toBe(true);
    expect(one.repo).toBeUndefined();
    // 3 still waiting at 5 a batch (the production pace) → one more batch expected.
    expect(one.run).toMatchObject({ status: "running", batch: 1, batches: 2, ended_at: null, counts: { prs_new: 5, issues_changed: 1, tickets_created: 1, summaries_written: 2, summaries_pending: 3, repo_written: null } });
    expect(reconcile).not.toHaveBeenCalled();

    const two = ok(await runSyncBatch(e(), ctx, "admin-user", { batch: 2, of: 10, run: one.run.id }, opts));
    expect(two.run).toMatchObject({ id: one.run.id, status: "running", batch: 2, counts: { prs_new: 5, issues_changed: 1, tickets_created: 1, summaries_written: 4, summaries_pending: 1 } });
    // A batch's own answer is that batch's alone — it is the RUN that accumulates.
    expect(two).toMatchObject({ captured: 0, unchanged: 6, summarized: 2 });

    const three = ok(await runSyncBatch(e(), ctx, "admin-user", { batch: 3, of: 10, run: one.run.id }, opts));
    expect(three.summaryBudgetExhausted).toBe(false);
    expect(three.run).toMatchObject({ id: one.run.id, status: "ok", batch: 3, batches: 3, phase: "done", counts: { prs_new: 5, summaries_written: 5, summaries_pending: 0, repo_written: 4 } });
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(await rows()).toHaveLength(1);
  });

  it("a run never makes more than SYNC_MAX_BATCHES, whatever the client says: the last one reconciles and closes it", async () => {
    await ready();
    const ctx = await admin();
    const reconcile = reconciled();
    const never: typeof runBackfill = async () => ({
      ok: true, captured: 0, unchanged: 1, summarized: 5, summaryBudgetExhausted: true, prSummarizedCount: 0, issueSummarizedCount: 0, prs: 900, issues: 0, issuesToSummarize: 0,
      capturedPrs: 0, capturedIssues: 0, ticketsCreated: 0, ticketsUpdated: 0, summariesWritten: 0, summariesFailed: 5, summariesSkipped: 0, summariesPending: 900,
    } satisfies BackfillResult);
    let last: SyncBatchResult | null = null;
    for (let i = 1; i <= SYNC_MAX_BATCHES; i++) {
      last = ok(await runSyncBatch(e(), ctx, "admin-user", i === 1 ? { start: true } : { run: last!.run.id }, { backfill: never, reconcile }));
      if (i < SYNC_MAX_BATCHES) expect(last.run).toMatchObject({ status: "running", batch: i, batches: SYNC_MAX_BATCHES });
    }
    expect(last!.run).toMatchObject({ status: "ok", batch: SYNC_MAX_BATCHES, counts: { summaries_failed: 50, summaries_pending: 900 } });
    expect(reconcile).toHaveBeenCalledTimes(1);
  });
});

describe("how a run ends", () => {
  it("partial: the closing refresh lost a part — named by code, in words built from the code", async () => {
    await ready();
    const out = ok(await runSyncBatch(e(), await admin(), "admin-user", { start: true }, {
      backfillOpts: { fetchImpl: github([pr(1)], []), summarizer: summarizer(), summaryCallDelayMs: 0 }, reconcile: reconciled(["deployments", "checks", "unexpected error"]),
    }));
    expect(out.run).toMatchObject({ status: "partial", failures: [{ code: "reconcile:deployments" }, { code: "reconcile:checks" }, { code: "reconcile:unexpected" }] });
    expect(out.run.failures.map((f) => syncFailureText(f, out.run.repo).what)).toEqual([
      "Could not read deployments from GitHub.", "Could not read check runs from GitHub.", "Could not refresh deployments and CI.",
    ]);
  });

  it("failed: GitHub refused a list — 503 as before, the run closed with the status, nothing written", async () => {
    await ready();
    const refuse = (async () => new Response(`{"message":"Bad credentials for ${TOKEN}","documentation_url":"https://docs.github.com/rest"}`, { status: 403 })) as unknown as typeof fetch;
    const out = await runSyncBatch(e(), await admin(), "admin-user", { start: true }, { backfillOpts: { fetchImpl: refuse }, reconcile: reconciled() });
    expect(out.status).toBe(503);
    const body = out.body as { error: string; run: SyncRunView };
    expect(body.error).toBe("GitHub 403 listing closed PRs (check the org's GitHub token)");
    expect(body.run).toMatchObject({ status: "failed", failures: [{ code: "list_prs", status: 403 }], phase: "done" });
    expect(body.run.ended_at).not.toBeNull();
    expect(syncFailureText(body.run.failures[0], "o/r")).toEqual({
      what: "Could not read pull requests: GitHub refused the token (403). Nothing was written.",
      fix: "Check that the GitHub token in Org settings › Integrations can read this repository, then sync again.",
    });
    expect(await first(env.DB, `SELECT 1 AS x FROM events`)).toBeNull();
    // Neither the answer nor the row carries what GitHub said, or the token it was said about.
    const kept = JSON.stringify(out.body) + JSON.stringify(await rows());
    expect(kept).not.toContain(TOKEN);
    expect(kept).not.toContain("Bad credentials");
    expect(kept).not.toContain("documentation_url");
  });

  it("failed: a batch that throws is a 502 with a fixed word, and the run is closed — no raw error, no secret", async () => {
    await ready();
    const explode = (async () => { throw new Error(`connect ECONNRESET authorization: Bearer ${TOKEN}`); }) as unknown as typeof fetch;
    const out = await runSyncBatch(e(), await admin(), "admin-user", { start: true }, { backfillOpts: { fetchImpl: explode } });
    expect(out.status).toBe(502);
    expect(out.body).toMatchObject({ error: "sync failed", run: { status: "failed", failures: [{ code: "unexpected" }] } });
    const kept = JSON.stringify(out.body) + JSON.stringify(await rows());
    expect(kept).not.toContain(TOKEN);
    expect(kept).not.toContain("ECONNRESET");
    // The lock is released with it: the next start is not refused.
    expect((await runSyncBatch(e(), await admin(), "admin-user", { start: true }, { backfillOpts: { fetchImpl: github([], []) }, reconcile: reconciled() })).status).toBe(200);
  });

  it("nothing to sync with is the same 503 as ever, and records no run", async () => {
    const out = await runSyncBatch(e(), await admin(), "admin-user", { start: true });
    expect(out).toEqual({ status: 503, body: { error: "service token or repo not configured" } });
    await syncOrgConfig(e({ GITHUB_SERVICE_TOKEN: "" }));
    expect(await runSyncBatch(e({ GITHUB_SERVICE_TOKEN: "" }), await admin(), "admin-user", { start: true })).toEqual({ status: 503, body: { error: "service token or repo not configured" } });
    expect(await rows()).toEqual([]);
  });

  it("abandoned: a run that stops reporting reads as not finished after three minutes, and the next start marks it", async () => {
    await ready();
    const ctx = await admin();
    let now = Date.parse("2026-10-07T10:00:00.000Z");
    const opts = { now: () => now, backfillOpts: { fetchImpl: github([1, 2, 3].map(pr), []), summarizer: summarizer(), summaryBatchLimit: 1, summaryCallDelayMs: 0 }, reconcile: reconciled() };
    const one = ok(await runSyncBatch(e(), ctx, "admin-user", { batch: 1, of: 10, start: true }, opts));
    expect(one.run.status).toBe("running");
    // The tab is closed: no second batch ever arrives.
    now += SYNC_STALE_MS - 1000;
    expect((await syncStatus(e(), ctx, now))).toMatchObject({ blocked: "running", running: { id: one.run.id, status: "running" }, last: null });
    now += 2000;
    const stale = await syncStatus(e(), ctx, now);
    expect(stale).toMatchObject({ blocked: null, running: null, last: { id: one.run.id, status: "abandoned", ended_at: one.run.updated_at } });
    expect((await rows())[0].status).toBe("running"); // read as abandoned before anything rewrote it
    // Its late batch is refused rather than reviving it…
    expect((await runSyncBatch(e(), ctx, "admin-user", { batch: 2, of: 10, run: one.run.id }, opts)).status).toBe(409);
    // …and a new run starts, marking the old one.
    const again = ok(await runSyncBatch(e(), ctx, "admin-user", { batch: 1, of: 1, start: true }, opts));
    expect(again.run.id).not.toBe(one.run.id);
    expect((await rows()).map((r) => [r.id, r.status])).toEqual([[one.run.id, "abandoned"], [again.run.id, "ok"]]);
    expect((await rows())[0].ended_at).toBe(one.run.updated_at);
  });

  it("previous_at is when the last finished run ended — what 'Nothing new since' reads", async () => {
    await ready();
    const ctx = await admin();
    const opts = { backfillOpts: { fetchImpl: github([pr(1)], []), summarizer: summarizer(), summaryCallDelayMs: 0 }, reconcile: reconciled([], 0) };
    const one = ok(await runSyncBatch(e(), ctx, "admin-user", { start: true }, opts));
    const two = ok(await runSyncBatch(e(), ctx, "admin-user", { start: true }, opts));
    expect(two.run.previous_at).toBe(one.run.ended_at);
    expect(two.run.counts).toMatchObject({ prs_new: 0, issues_changed: 0, summaries_written: 0, repo_written: 0 });
  });
});

describe("the lock: one run per org", () => {
  const slow = { backfillOpts: { fetchImpl: github([1, 2, 3].map(pr), []), summarizer: summarizer(), summaryBatchLimit: 1, summaryCallDelayMs: 0 }, reconcile: reconciled() };

  it("a second start is refused with the run in progress — the same person's double click, and another admin's", async () => {
    await ready();
    const one = ok(await runSyncBatch(e(), await admin(), "admin-user", { batch: 1, of: 10, start: true }, slow));
    const again = await runSyncBatch(e(), await admin(), "admin-user", { batch: 1, of: 10, start: true }, slow);
    expect(again).toMatchObject({ status: 409, body: { error: "sync_running", run: { id: one.run.id, by: "admin-user", status: "running" } } });
    const other = await runSyncBatch(e(), await admin("second-admin"), "second-admin", { batch: 1, of: 10, start: true }, slow);
    expect(other).toMatchObject({ status: 409, body: { error: "sync_running", run: { id: one.run.id } } });
    // Another admin cannot continue it either, by id or by an old client's bare body.
    expect((await runSyncBatch(e(), await admin("second-admin"), "second-admin", { run: one.run.id }, slow)).status).toBe(409);
    expect((await runSyncBatch(e(), await admin("second-admin"), "second-admin", {}, slow)).status).toBe(409);
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0].batch).toBe(1);
  });

  it("of two starts racing, one writes", async () => {
    await ready();
    const [a, b] = await Promise.all([
      runSyncBatch(e(), await admin(), "admin-user", { start: true }, slow),
      runSyncBatch(e(), await admin("second-admin"), "second-admin", { start: true }, slow),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await rows()).toHaveLength(1);
  });

  it("a body naming no run (an older client) continues the caller's own live run, and starts one when there is none", async () => {
    await ready();
    const ctx = await admin();
    const one = ok(await runSyncBatch(e(), ctx, "admin-user", {}, slow));
    const two = ok(await runSyncBatch(e(), ctx, "admin-user", {}, slow));
    expect([one.run.batch, two.run.batch, two.run.id === one.run.id]).toEqual([1, 2, true]);
    const three = ok(await runSyncBatch(e(), ctx, "admin-user", {}, slow));
    expect(three.run).toMatchObject({ id: one.run.id, status: "ok", batch: 3 });
    expect(ok(await runSyncBatch(e(), ctx, "admin-user", {}, slow)).run.id).not.toBe(one.run.id);
  });

  it("is per org: a run in one org neither blocks nor shows in another", async () => {
    await ready();
    ok(await runSyncBatch(e(), await admin(), "admin-user", { start: true }, slow));
    await ensureMember("boss", "owner", ORG_B);
    const b = await syncStatus(e(), await tenantCtx("boss", "owner", { orgId: ORG_B }));
    expect(b).toMatchObject({ repo: null, blocked: "no_repo", running: null, last: null });
    expect(await rows(ORG_B)).toEqual([]);
  });
});

describe("GET /sync and POST /admin/backfill over HTTP", () => {
  const get = async (path: string, cookie: string, envOver: Env = e()) => {
    const res = await app.request(path, { headers: { cookie, accept: "application/json" } }, envOver);
    return { status: res.status, json: (await res.json()) as SyncStatusView & { error?: string } };
  };

  it("any member reads it; an admin is told they may start one; a non-member gets the tenant 404", async () => {
    await ready();
    await run(env.DB, `INSERT INTO sync_runs (org_id, repo, started_by, started_at, updated_at, ended_at, status, batch, batches, phase, counts, failures)
                       VALUES (?, 'o/r', 'admin-user', '2026-10-07T09:00:00.000Z', '2026-10-07T09:01:12.000Z', '2026-10-07T09:01:12.000Z', 'partial', 3, 3, 'done', ?, ?)`,
      ORG_A, JSON.stringify({ prs_new: 12, issues_changed: 4, summaries_written: 9, summaries_failed: 2, repo_written: 30 }), JSON.stringify([{ code: "reconcile:checks" }]));
    await putSnapshot(systemCtx(), "prs_reconciled", { at: "2026-10-07T09:01:10.000Z" }, "2026-10-07T09:01:10.000Z");

    const member = await get("/api/o/saplinglearn/sync", await cookieFor("plain-member"));
    expect(member.status).toBe(200);
    expect(member.json).toMatchObject({
      repo: "o/r", admin: false, blocked: null, running: null, refreshed_at: "2026-10-07T09:01:10.000Z",
      last: { by: "admin-user", status: "partial", batch: 3, failures: [{ code: "reconcile:checks" }], counts: { prs_new: 12, issues_changed: 4, summaries_written: 9, summaries_failed: 2, tickets_created: 0, repo_written: 30 } },
      // The pool has no GEMINI_API_KEY: summaries are off on this deployment — a state, not an error.
      summaries: { status: "off", used: 0, cap: null, remaining: null, pending: 0, per_run: 50 },
    });
    expect((await get("/api/o/saplinglearn/sync", await cookieFor("admin-user"))).json.admin).toBe(true);
    // The old-path alias, for a person with one org.
    expect((await get("/api/sync", await cookieFor("plain-member"))).json.repo).toBe("o/r");
    // Not a member of that org: the one 404, and nothing about its runs.
    const outsider = await app.request("/api/o/saplinglearn/sync", { headers: { cookie: await cookieFor("stranger", { member: false }) } }, e());
    expect(outsider.status).toBe(404);
    expect(await outsider.text()).toBe(JSON.stringify({ error: "not_found" }));
    expect((await app.request("/api/o/saplinglearn/sync", {}, e())).status).toBe(401);
  });

  it("says why a sync cannot start: no repository, then no token, then a run in progress", async () => {
    const cookie = await cookieFor("admin-user");
    expect((await get("/api/o/saplinglearn/sync", cookie)).json).toMatchObject({ repo: null, blocked: "no_repo", admin: true });
    await syncOrgConfig(e({ GITHUB_SERVICE_TOKEN: "" }));
    expect((await get("/api/o/saplinglearn/sync", cookie, e({ GITHUB_SERVICE_TOKEN: "" }))).json).toMatchObject({ repo: "o/r", blocked: "no_token" });
    expect((await get("/api/o/saplinglearn/sync", cookie)).json.blocked).toBeNull();
    const now = new Date().toISOString();
    await run(env.DB, `INSERT INTO sync_runs (org_id, repo, started_by, started_at, updated_at, status, batch, batches, phase, done, total) VALUES (?, 'o/r', 'second-admin', ?, ?, 'running', 2, 6, 'saving_prs', 140, 412)`, ORG_A, now, now);
    expect((await get("/api/o/saplinglearn/sync", cookie)).json).toMatchObject({
      blocked: "running", last: null, running: { by: "second-admin", status: "running", batch: 2, batches: 6, phase: "saving_prs", done: 140, total: 412 },
    });
    // …and the start is refused over HTTP with that run.
    const res = await app.request("/api/o/saplinglearn/admin/backfill", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ batch: 1, of: 10, start: true }) }, e());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "sync_running", run: { by: "second-admin", batch: 2 } });
  });

  it("shows the summaries allowance and what is waiting, when the deployment has a key", async () => {
    await ready();
    await run(env.DB, `UPDATE orgs SET plan = 'personal', plan_overrides = '{"ai_summaries":20}' WHERE id = ?`, ORG_A);
    const day = new Date().toISOString().slice(0, 10);
    await run(env.DB, `INSERT INTO org_usage_daily (org_id, day, metric, actor, count, last_at) VALUES (?, ?, 'summary:pr', 'github-webhook', 14, ?)`, ORG_A, day, `${day}T00:00:00.000Z`);
    // One pull request with a real summary; then three more and an assigned issue captured with no summarizer: four excerpts.
    await runBackfill(e(), systemCtx(), "admin-user", { fetchImpl: github([pr(9)], []), summarizer: summarizer(), summaryCallDelayMs: 0 });
    await runBackfill(e(), systemCtx(), "admin-user", { fetchImpl: github([pr(1), pr(2), pr(3), pr(9)], [issue(5)]), summaryCallDelayMs: 0 });
    const keyed = e({ GEMINI_API_KEY: "AIzaFAKE" });
    const { json } = await get("/api/o/saplinglearn/sync", await cookieFor("plain-member"), keyed);
    expect(json.summaries).toEqual({ status: "on", used: 14, cap: 20, remaining: 6, pending: 4, per_run: 50 });
    expect(JSON.stringify(json)).not.toContain("AIzaFAKE");
  });

  it("a member cannot start one; the route's answer never carries a secret", async () => {
    await ready();
    const res = await app.request("/api/o/saplinglearn/admin/backfill", { method: "POST", headers: { cookie: await cookieFor("plain-member"), "content-type": "application/json" }, body: JSON.stringify({ start: true }) }, e());
    expect(res.status).toBe(403);
    expect(await rows()).toEqual([]);
    const status = await app.request("/api/o/saplinglearn/sync", { headers: { cookie: await cookieFor("plain-member") } }, e());
    expect(await status.text()).not.toContain(TOKEN);
  });
});

describe("retention, and the local stand-in", () => {
  it("pruneSyncRuns deletes runs past 90 days, in every org, and nothing younger", async () => {
    const now = Date.parse("2026-10-07T00:00:00.000Z");
    const at = (days: number) => new Date(now - days * 86_400_000).toISOString();
    for (const [org, days] of [[ORG_A, SYNC_RUN_RETENTION_DAYS + 1], [ORG_B, SYNC_RUN_RETENTION_DAYS + 30], [ORG_A, SYNC_RUN_RETENTION_DAYS - 1], [ORG_A, 0]] as const) {
      await run(env.DB, `INSERT INTO sync_runs (org_id, repo, started_by, started_at, updated_at, ended_at, status) VALUES (?, 'o/r', 'x', ?, ?, ?, 'ok')`, org, at(days), at(days), at(days));
    }
    expect(await pruneSyncRuns(platformCtx(), now)).toBe(2);
    expect((await all<Row>(env.DB, `SELECT org_id FROM sync_runs`)).map((r) => r.org_id)).toEqual([ORG_A, ORG_A]);
  });

  describe("LOCAL_UPSTREAM", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("is ignored unless it is plain http on a loopback host — so production, where it is unset, is untouched", () => {
      for (const v of [undefined, "", "not a url", "https://127.0.0.1:8862", "http://example.com", "http://169.254.169.254", "https://api.github.com", "http://127.0.0.1.evil.io:80"]) {
        expect(localUpstreamFetch({ LOCAL_UPSTREAM: v }), String(v)).toBeUndefined();
      }
      expect(localUpstreamFetch({ LOCAL_UPSTREAM: "http://127.0.0.1:8862" })).toBeTypeOf("function");
      expect(localUpstreamFetch({ LOCAL_UPSTREAM: "http://localhost:8862" })).toBeTypeOf("function");
    });

    it("sends GitHub and Gemini to the stand-in and leaves every other request alone", async () => {
      const seen: string[] = [];
      vi.stubGlobal("fetch", async (input: unknown) => { seen.push(String(input)); return json({}); });
      const f = localUpstreamFetch({ LOCAL_UPSTREAM: "http://127.0.0.1:8862/ignored" })!;
      await f("https://api.github.com/repos/o/r/pulls?state=closed&per_page=100");
      await f("https://generativelanguage.googleapis.com/v1beta/models/m:generateContent");
      await f("https://api.cloudflare.com/client/v4/graphql");
      await f("http://127.0.0.1:8862/github/next-page");
      expect(seen).toEqual([
        "http://127.0.0.1:8862/github/repos/o/r/pulls?state=closed&per_page=100",
        "http://127.0.0.1:8862/gemini/v1beta/models/m:generateContent",
        "https://api.cloudflare.com/client/v4/graphql",
        "http://127.0.0.1:8862/github/next-page",
      ]);
    });
  });
});

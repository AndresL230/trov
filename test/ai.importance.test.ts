// feed.importance (src/ai/importance.ts; docs/architecture/ai.md › Jobs): Jev rates a feed entry or a merged PR
// routine / notable / breaking, ONE `choice` question per request, and the answer is a COMPUTED FACT on
// `feed.importance` / `pr_summaries.importance` (0060) — stored only at `IMPORTANCE_MIN_CONFIDENCE` or more, never
// guessed. Jev is stubbed at the Response level; everything else is real D1 and the real pass.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { runAiPass } from "../src/ai/pass";
import { newBudget } from "../src/repo/dispatch";
import {
  FEED_IMPORTANCE_JOB, IMPORTANCE_JOBS, IMPORTANCE_MIN_CONFIDENCE, IMPORTANCE_QUESTION, PR_IMPORTANCE_JOB, feedImportanceText, prImportanceText,
} from "../src/ai/importance";
import { storePrSummary } from "../src/tools/summarize";
import { ingestFeedEntry } from "../src/consumer";
import { get_feed } from "../src/tools/reads";
import { getMyWork } from "../src/tools/mywork";
import { all, first, run } from "./helpers/db";
import { ORG_A, ORG_B, systemCtx } from "./helpers/tenant";
import { dirtyRow, keyedEnv, markRow } from "./helpers/ai-pass";

// The pass's clock: after BEFORE, and after the REAL clock too — the gate and the router stamp `marked_at` with it, and
// a mark later than the pass's `now` is not due yet.
const NOW = new Date(Math.max(Date.parse("2026-10-15T12:40:00.000Z"), Date.now() + 60 * 60_000));
const BEFORE = "2026-10-15T12:00:00.000Z";
const OWNER = "AndresL230";

interface Sent { state: string; questions: Record<string, { type: string; instructions: string; criteria: Record<string, string> }> }
type Answer = { choice: string; confidence: number } | { status: number } | { raw: unknown };
/** A Jev stub answering ONE `choice` per request with `reply(state)`; records each request. */
function jev(reply: (state: string) => Answer) {
  const sent: Sent[] = [];
  let other = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://api.typesafe.ai/")) { other++; return new Response("ok"); }
    const body = JSON.parse(String(init?.body)) as Sent;
    sent.push(body);
    const r = reply(body.state);
    if ("status" in r) return new Response(JSON.stringify({ error: "x" }), { status: r.status });
    const answers = "raw" in r ? r.raw : Object.fromEntries(Object.keys(body.questions).map((k) => {
      const probabilities = { routine: 0, notable: 0, breaking: 0, [r.choice]: r.confidence };
      const rest = (1 - r.confidence) / 2;
      for (const o of Object.keys(probabilities)) if (o !== r.choice) (probabilities as Record<string, number>)[o] = rest;
      return [k, { type: "choice", choice: r.choice, confidence: r.confidence, probabilities }];
    }));
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 400, output_tokens: 30 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, sent, other: () => other };
}
const pass = (j: ReturnType<typeof jev>, e: Env = keyedEnv()) => runAiPass(e, newBudget(j.fetchImpl, 900), { jobs: IMPORTANCE_JOBS, now: NOW });

const feedImportance = async (id: number, org = ORG_A) => (await first<{ importance: string | null }>(env.DB, `SELECT importance FROM feed WHERE org_id = ? AND id = ?`, org, id))?.importance;
const prImportance = async (n: number, org = ORG_A) => (await first<{ importance: string | null }>(env.DB, `SELECT importance FROM pr_summaries WHERE org_id = ? AND semantic_key = ?`, org, `gh:pr:${n}:merged`))?.importance;
const meter = async (metric: string, org = ORG_A) => (await first<{ n: number }>(env.DB, `SELECT COALESCE(SUM(count), 0) AS n FROM org_usage_daily WHERE org_id = ? AND metric = ?`, org, metric))!.n;

/** A feed entry, as an agent writes it — through the gate, so the ROUTER marks `card:feed:<id>` itself. */
async function entry(summary: string, body = "", org = ORG_A): Promise<number> {
  const r = await ingestFeedEntry(systemCtx(org), { summary, body, tags: [] } as never, OWNER);
  if (r.outcome !== "written") throw new Error("not written");
  return r.id;
}
/** A merged PR #n: its event and its capture-time summary (`summary: null` = none written yet), and its card. */
async function mergedPr(n: number, o: { title?: string; body?: string; summary?: { title: string; what: string; why: string | null; impact: string } | "excerpt" | null } = {}): Promise<void> {
  const key = `gh:pr:${n}:merged`;
  const raw = JSON.stringify({ pr: { number: n, title: o.title ?? `PR ${n}`, body: o.body ?? "", html_url: `https://github.com/o/r/pull/${n}`, merged: true } });
  await run(env.DB, `INSERT INTO events (org_id, semantic_key, event_type, ref_number, subject_login, raw, provenance, occurred_at, recorded_at, recorded_by) VALUES (?, ?, 'pr_merged', ?, ?, ?, 'webhook', ?, ?, 'test')`,
    ORG_A, key, n, OWNER, raw, BEFORE, BEFORE);
  const s = o.summary === undefined ? "excerpt" : o.summary;
  if (s === "excerpt") await run(env.DB, `INSERT INTO pr_summaries (org_id, semantic_key, pr_number, model, created_at) VALUES (?, ?, ?, 'excerpt', ?)`, ORG_A, key, n, BEFORE);
  else if (s) await run(env.DB, `INSERT INTO pr_summaries (org_id, semantic_key, pr_number, model, created_at, title, what, why, impact) VALUES (?, ?, ?, 'claude-haiku-5-5', ?, ?, ?, ?, ?)`, ORG_A, key, n, BEFORE, s.title, s.what, s.why, s.impact);
  await markRow(ORG_A, "card", `pr:${n}`, BEFORE);
}
const primaryRepo = () => run(env.DB, `INSERT INTO org_repos (id, org_id, repo_full_name, is_primary, legacy_hook, created_at, created_by) VALUES ('hook_imp', ?, 'acme/app', 1, 0, ?, 'test')`, ORG_A, BEFORE);

describe("feed.importance: one choice question per item, a computed fact", () => {
  it("a new feed entry (marked by the gate) is rated in ONE request with ONE choice question, metered ai_suggest, and stored", async () => {
    const id = await entry("Organization addresses move to /<slug>/", "Old /o/ links redirect.");
    expect((await dirtyRow(ORG_A, "card", `feed:${id}`))).not.toBeNull(); // the router marked it
    const j = jev(() => ({ choice: "breaking", confidence: 0.93 }));
    const r = await pass(j);
    expect(r.jev).toBe(1);
    expect(j.sent).toHaveLength(1);
    expect(Object.keys(j.sent[0].questions)).toEqual(["importance"]);
    expect(j.sent[0].questions.importance).toEqual(IMPORTANCE_QUESTION);
    expect(j.sent[0].state).toBe(feedImportanceText({ summary: "Organization addresses move to /<slug>/", brief: null, body: "Old /o/ links redirect." }));
    expect(await feedImportance(id)).toBe("breaking");
    expect(await meter("ai_suggest")).toBe(1);
    expect(await dirtyRow(ORG_A, "card", `feed:${id}`)).toBeNull(); // written: the card is gone
  });

  it("NEVER GUESSED: below the threshold nothing is written — the column stays NULL — and the card is still done", async () => {
    const id = await entry("Sidebar polish");
    const j = jev(() => ({ choice: "routine", confidence: IMPORTANCE_MIN_CONFIDENCE - 0.01 }));
    await pass(j);
    expect(j.sent).toHaveLength(1);
    expect(await feedImportance(id)).toBeNull();
    expect(await dirtyRow(ORG_A, "card", `feed:${id}`)).toBeNull();
    // At the threshold it is stored.
    const id2 = await entry("Sidebar polish, again");
    await pass(jev(() => ({ choice: "routine", confidence: IMPORTANCE_MIN_CONFIDENCE })));
    expect(await feedImportance(id2)).toBe("routine");
  });

  it("a malformed answer (an option not asked) writes nothing and fails the attempt, to be retried", async () => {
    const id = await entry("Something");
    await pass(jev(() => ({ raw: { importance: { type: "choice", choice: "huge", confidence: 0.99, probabilities: { routine: 0, notable: 0, breaking: 1 } } } })));
    expect(await feedImportance(id)).toBeNull();
    const row = await dirtyRow(ORG_A, "card", `feed:${id}`);
    expect(row?.attempts).toBe(1);
    expect(row?.last_error).toBe("not_written");
  });

  it("an entry already rated is never asked about again, and a stored value is never overwritten", async () => {
    const id = await entry("Already rated");
    await run(env.DB, `UPDATE feed SET importance = 'notable' WHERE org_id = ? AND id = ?`, ORG_A, id);
    const j = jev(() => ({ choice: "routine", confidence: 0.99 }));
    await pass(j);
    expect(j.sent).toHaveLength(0);
    expect(await feedImportance(id)).toBe("notable");
  });

  it("a merged PR is rated from its title and capture-time summary — never its raw body when it has one", async () => {
    const s = { title: "Tags of your own", what: "Each org keeps its own tag list.", why: null, impact: "Sift tags existing items." };
    await mergedPr(179, { title: "raw title", body: "RAW BODY never sent", summary: s });
    const j = jev(() => ({ choice: "notable", confidence: 0.97 }));
    await pass(j);
    expect(j.sent).toHaveLength(1);
    expect(j.sent[0].state).toBe(prImportanceText(179, { title: "raw title", body: "RAW BODY never sent" }, s));
    expect(j.sent[0].state).not.toContain("RAW BODY");
    expect(await prImportance(179)).toBe("notable");
  });

  it("a PR with only the excerpt marker is rated from its title and a scrubbed excerpt of its body", async () => {
    await mergedPr(12, { title: "Fix a typo", body: "One word. ```secret code``` ghp_abcdefghijklmnopqrstuvwxyz0123456789" });
    const j = jev(() => ({ choice: "routine", confidence: 0.9 }));
    await pass(j);
    expect(j.sent[0].state).toBe("Pull request #12: Fix a typo\n\nOne word.");
    expect(await prImportance(12)).toBe("routine");
  });

  it("a PR whose summary is not written yet sends nothing and fails the attempt (a later tick retries)", async () => {
    await mergedPr(13, { summary: null });
    const j = jev(() => ({ choice: "routine", confidence: 0.9 }));
    await pass(j);
    expect(j.sent).toHaveLength(0);
    expect((await dirtyRow(ORG_A, "card", "pr:13"))?.attempts).toBe(1);
  });

  it("a BREAKING item marks the primary repo urgent (it skips the repo wait); notable does not", async () => {
    await primaryRepo();
    await mergedPr(111, { summary: { title: "Addresses move", what: "Org addresses change.", why: null, impact: "Links change." } });
    await pass(jev(() => ({ choice: "breaking", confidence: 0.95 })));
    expect(await prImportance(111)).toBe("breaking");
    expect((await dirtyRow(ORG_A, "repo", "acme/app"))?.urgent).toBe(1);
    await run(env.DB, `DELETE FROM ai_dirty WHERE org_id = ? AND scope = 'repo'`, ORG_A);
    await mergedPr(112, { summary: { title: "A feature", what: "New.", why: null, impact: "New." } });
    await pass(jev(() => ({ choice: "notable", confidence: 0.95 })));
    expect(await dirtyRow(ORG_A, "repo", "acme/app")).toBeNull();
  });

  it("THE SWITCH: an org with AI off is never asked about, and nothing is stored", async () => {
    const id = await entry("Off org entry");
    await run(env.DB, `UPDATE orgs SET ai_automation = 0 WHERE id = ?`, ORG_A);
    await markRow(ORG_A, "card", `feed:${id}`, BEFORE); // even with a card standing
    const j = jev(() => ({ choice: "breaking", confidence: 0.99 }));
    await pass(j);
    expect(j.sent).toHaveLength(0);
    expect(await feedImportance(id)).toBeNull();
  });

  it("no TypeSafe key: the job does not run at all", async () => {
    const id = await entry("No key");
    const j = jev(() => ({ choice: "breaking", confidence: 0.99 }));
    await pass(j, keyedEnv({ TYPESAFE_API_KEY: "" }));
    expect(j.sent).toHaveLength(0);
    expect(await feedImportance(id)).toBeNull();
  });

  it("one org per request: org B's entry is rated in org B only", async () => {
    const a = await entry("Org A thing");
    const b = await entry("Org B thing", "", ORG_B);
    await pass(jev((state) => (state.includes("Org B") ? { choice: "breaking", confidence: 0.9 } : { choice: "routine", confidence: 0.9 })));
    expect(await feedImportance(a)).toBe("routine");
    expect(await feedImportance(b, ORG_B)).toBe("breaking");
  });

  it("the registry carries both halves under ONE kind", () => {
    expect(IMPORTANCE_JOBS.map((j) => [j.name, j.kind, j.scope, j.keyPrefix])).toEqual([
      ["feed.importance:feed", "feed.importance", "card", "feed:"],
      ["feed.importance:pr", "feed.importance", "card", "pr:"],
    ]);
    expect([FEED_IMPORTANCE_JOB.provider, PR_IMPORTANCE_JOB.provider]).toEqual(["jev", "jev"]);
  });
});

describe("feed.importance on the reads: absent when unknown", () => {
  it("get_feed carries `importance` only when it is set — an unrated entry has no such key at all", async () => {
    const rated = await entry("Rated");
    const unrated = await entry("Unrated");
    await run(env.DB, `UPDATE feed SET importance = 'breaking' WHERE org_id = ? AND id = ?`, ORG_A, rated);
    const rows = await get_feed(systemCtx(), {});
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(rated)?.importance).toBe("breaking");
    expect(Object.prototype.hasOwnProperty.call(byId.get(unrated), "importance")).toBe(false);
  });

  it("My Work's merged PRs carry it when set, and leave it out when not", async () => {
    await run(env.DB, `INSERT INTO identities (provider, subject, person, created_at) VALUES ('github', 'imp-login', ?, ?) ON CONFLICT DO NOTHING`, OWNER, BEFORE).catch(() => undefined);
    const logins = (await all<{ subject: string }>(env.DB, `SELECT subject FROM identities WHERE provider = 'github' AND person = ?`, OWNER)).map((r) => r.subject);
    expect(logins.length).toBeGreaterThan(0);
    for (const [n, imp] of [[501, "notable"], [502, null]] as const) {
      const key = `gh:pr:${n}:merged`;
      await run(env.DB, `INSERT INTO events (org_id, semantic_key, event_type, ref_number, subject_login, raw, provenance, occurred_at, recorded_at, recorded_by) VALUES (?, ?, 'pr_merged', ?, ?, ?, 'webhook', ?, ?, 'test')`,
        ORG_A, key, n, logins[0], JSON.stringify({ pr: { number: n, title: `PR ${n}`, body: "", html_url: `https://github.com/o/r/pull/${n}`, merged: true } }), BEFORE, BEFORE);
      await run(env.DB, `INSERT INTO pr_summaries (org_id, semantic_key, pr_number, model, created_at, importance) VALUES (?, ?, ?, 'excerpt', ?, ?)`, ORG_A, key, n, BEFORE, imp);
    }
    const w = await getMyWork(systemCtx(), OWNER);
    const pr = new Map(w.previousActivity.map((p) => [p.number, p]));
    expect(pr.get(501)?.importance).toBe("notable");
    expect(Object.prototype.hasOwnProperty.call(pr.get(502), "importance")).toBe(false);
  });

  it("a re-summarized PR keeps its rating (the summary is an upsert of its own columns)", async () => {
    await mergedPr(77, { summary: "excerpt" });
    await run(env.DB, `UPDATE pr_summaries SET importance = 'breaking' WHERE org_id = ? AND semantic_key = 'gh:pr:77:merged'`, ORG_A);
    await storePrSummary(systemCtx(), { model: "m", summarize: async () => ({ title: "T", what: "W", why: null, impact: "I" }) } as never,
      { semantic_key: "gh:pr:77:merged", pr_number: 77, title: "t", body: "b" });
    const row = await first<{ title: string; importance: string }>(env.DB, `SELECT title, importance FROM pr_summaries WHERE org_id = ? AND semantic_key = 'gh:pr:77:merged'`, ORG_A);
    expect(row).toEqual({ title: "T", importance: "breaking" });
  });
});

// THE PHASE C EVAL SETS, replayed (test/ai-evals/<kind>/: cases.json — real items with the expected answer and why —
// and recorded.json — what Jev answered when the set was run live with `scripts/ai-evals/run-live.ts`). Each case is
// written to D1 as the real item, its card is marked, and the REAL pass runs the REAL job; a stub answers each request
// with the recorded response for the SAME request text (a request the job builds differently from the recorded one
// fails the test — the eval stays a test of what production sends). The thresholds' results are pinned here, so a
// change to a prompt, a threshold or what is sent must be re-run live and re-recorded.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { runAiPass } from "../src/ai/pass";
import { newBudget } from "../src/repo/dispatch";
import { IMPORTANCE_JOBS, IMPORTANCE_MIN_CONFIDENCE } from "../src/ai/importance";
import { TAG_FIT_ITEM_JOB } from "../src/ai/sift-items";
import { setAiEnabled } from "../src/tools/tag-fit";
import { all, first, run } from "./helpers/db";
import { ORG_A, tenantCtx } from "./helpers/tenant";
import { keyedEnv, markRow } from "./helpers/ai-pass";
import importanceCases from "./ai-evals/feed.importance/cases.json";
import importanceRecorded from "./ai-evals/feed.importance/recorded.json";
import tagFitCases from "./ai-evals/tag.fit/cases.json";
import tagFitRecorded from "./ai-evals/tag.fit/recorded.json";

const NOW = new Date("2026-10-15T12:40:00.000Z");
const BEFORE = "2026-10-15T12:00:00.000Z";

type Recorded = Record<string, { state: string; response: { model: string; answers: Record<string, unknown> }; order?: string[] }>;

/** A Jev stub that answers from the recordings by request text; requests it has no recording for are listed. */
function replay(recorded: Recorded, answersFor: (rec: Recorded[string], questions: Record<string, { instructions: string }>) => Record<string, unknown>) {
  const byState = new Map(Object.values(recorded).map((r) => [r.state, r]));
  const unknown: string[] = [];
  let requests = 0;
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    requests++;
    const body = JSON.parse(String(init?.body)) as { state: string; questions: Record<string, { instructions: string }> };
    const rec = byState.get(body.state);
    if (!rec) { unknown.push(body.state.slice(0, 80)); return new Response(JSON.stringify({ error: "no recording" }), { status: 422 }); }
    return new Response(JSON.stringify({ ...rec.response, answers: answersFor(rec, body.questions) }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, unknown, requests: () => requests };
}

describe("eval: feed.importance (test/ai-evals/feed.importance)", () => {
  it(`replays ${importanceCases.cases.length} real items: every request is the recorded one, and at ${IMPORTANCE_MIN_CONFIDENCE} every stored rating is right`, async () => {
    expect(importanceCases.cases.length).toBeGreaterThanOrEqual(15);
    const ids = new Map<string, number>();
    for (const c of importanceCases.cases) {
      if (c.kind === "feed") {
        const r = await run(env.DB, `INSERT INTO feed (org_id, author, summary, brief, body, created_at) VALUES (?, 'andres', ?, ?, ?, ?)`, ORG_A, c.row.summary, c.row.brief, c.row.body, BEFORE);
        const id = Number(r.meta.last_row_id);
        ids.set(c.id, id);
        await markRow(ORG_A, "card", `feed:${id}`, BEFORE);
      } else {
        const n = c.row.number!;
        const key = `gh:pr:${n}:merged`;
        await run(env.DB, `INSERT INTO events (org_id, semantic_key, event_type, ref_number, subject_login, raw, provenance, occurred_at, recorded_at, recorded_by) VALUES (?, ?, 'pr_merged', ?, 'AndresL230', ?, 'backfill', ?, ?, 'test')`,
          ORG_A, key, n, JSON.stringify({ pr: { number: n, title: c.row.title, body: c.row.body, html_url: `https://github.com/AndresL230/trov/pull/${n}`, merged: true } }), BEFORE, BEFORE);
        await run(env.DB, `INSERT INTO pr_summaries (org_id, semantic_key, pr_number, model, created_at) VALUES (?, ?, ?, 'excerpt', ?)`, ORG_A, key, n, BEFORE);
        await markRow(ORG_A, "card", `pr:${n}`, BEFORE);
      }
    }
    const j = replay(importanceRecorded as Recorded, (rec) => rec.response.answers);
    await runAiPass(keyedEnv(), newBudget(j.fetchImpl, 900), { jobs: IMPORTANCE_JOBS, now: NOW });
    expect(j.unknown).toEqual([]);
    expect(j.requests()).toBe(importanceCases.cases.length);

    let stored = 0, right = 0;
    for (const c of importanceCases.cases) {
      const got = c.kind === "feed"
        ? (await first<{ importance: string | null }>(env.DB, `SELECT importance FROM feed WHERE org_id = ? AND id = ?`, ORG_A, ids.get(c.id)))!.importance
        : (await first<{ importance: string | null }>(env.DB, `SELECT importance FROM pr_summaries WHERE org_id = ? AND semantic_key = ?`, ORG_A, `gh:pr:${c.row.number}:merged`))!.importance;
      const a = (importanceRecorded as Recorded)[c.id].response.answers.importance as { choice: string; confidence: number };
      // What the job must have done with the recorded answer: the choice at the threshold or above, else NOTHING.
      expect(got, c.id).toBe(a.confidence >= IMPORTANCE_MIN_CONFIDENCE ? a.choice : null);
      if (got !== null) { stored++; if (got === c.expected) right++; }
    }
    // The live run's result at the chosen threshold (2026-10-15): 18 of 25 rated, all 18 right; 7 left unknown.
    expect({ stored, right }).toEqual({ stored: 18, right: 18 });
  });
});

describe("eval: tag.fit on new items (test/ai-evals/tag.fit)", () => {
  it(`replays ${tagFitCases.cases.length} real docs against the six starter tags: no clear non-fit is added or suggested`, async () => {
    expect(tagFitCases.cases.length).toBeGreaterThanOrEqual(15);
    await setAiEnabled(await tenantCtx("AndresL230"), true);
    for (const c of tagFitCases.cases) {
      await run(env.DB, `INSERT INTO docs (org_id, slug, section, title, body, current_version, updated_at, updated_by) VALUES (?, ?, 'reference', ?, ?, 1, ?, 'tester')`, ORG_A, c.item.id, c.item.title, c.item.body, BEFORE);
      await markRow(ORG_A, "card", `tagfit:doc:${c.item.id}`, BEFORE);
    }
    // The question ids follow this request's tag order; the recording's follow its own (`order`): map by tag name.
    const j = replay(tagFitRecorded as Recorded, (rec, questions) => Object.fromEntries(Object.entries(questions).map(([k, q]) => {
      const tag = /the tag "([^"]+)"/.exec(q.instructions)?.[1] ?? "";
      return [k, rec.response.answers[`t${rec.order!.indexOf(tag)}`]];
    })));
    await runAiPass(keyedEnv(), newBudget(j.fetchImpl, 900), { jobs: [TAG_FIT_ITEM_JOB], now: NOW });
    expect(j.unknown).toEqual([]);
    expect(j.requests()).toBe(tagFitCases.cases.length);

    let found = 0, fits = 0, clear = 0, notFits = 0, added = 0;
    for (const c of tagFitCases.cases) {
      const tagged = (await all<{ tag: string }>(env.DB, `SELECT tag FROM entry_tags WHERE org_id = ? AND entry_type = 'doc' AND entry_id = ?`, ORG_A, c.item.id)).map((r) => r.tag);
      const open = (await all<{ tag: string }>(env.DB, `SELECT tag FROM org_tag_suggestions WHERE org_id = ? AND source = 'model' AND state = 'open' AND entry_type = 'doc' AND entry_id = ?`, ORG_A, c.item.id)).map((r) => r.tag);
      added += tagged.length;
      for (const t of c.fits) { fits++; if (tagged.includes(t) || open.includes(t)) found++; }
      for (const t of c.doesNotFit) { notFits++; if (!tagged.includes(t) && !open.includes(t)) clear++; }
    }
    // The live run (2026-10-15), under Sift's own bands: 9 of 11 clear fits added or suggested; all 33 clear non-fits
    // left alone; 4 tags added, none of them on a clear non-fit.
    expect({ found, fits, clear, notFits, added }).toEqual({ found: 9, fits: 11, clear: 33, notFits: 33, added: 4 });
  });
});

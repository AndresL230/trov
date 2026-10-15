// DOC DRIFT (#161; Phase D — docs/architecture/ai.md › Doc drift): weekly (the `doc_drift` debounce), through the
// Batch API, only past `gate.drift` (Jev; below 0.6 no Haiku call; without Jev, skip). A disagreement with VALID
// evidence becomes a LOW-CONFIDENCE proposal through `ingestDocProposal` (the gate), authored by `trov`, and stays
// staged: only a person promotes it. Real D1; both providers stubbed at the `Response` level.
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { DOC_DRIFT_JOB, DRIFT_GATE_MIN, docDriftInput, applyDrift } from "../src/ai/doc-drift";
import { propose_doc_update, promote_doc } from "../src/tools/writes";
import { all, first, run } from "./helpers/db";
import { ORG_A, ORG_B, systemCtx } from "./helpers/tenant";
import { keyedEnv, markRow, stubProviders, succeededLine, dirtyRow } from "./helpers/ai-pass";
import { ensureTrovPerson, fencedBlocks, tick } from "./helpers/ai-roadmap";

const DAY = 86_400_000;
const later = (ms: number) => new Date(Date.now() + ms);
const SLUG = "deploys";
const BODY = "# Deploys\n\nDeploys are manual: an engineer runs the deploy script from a laptop.\n\nRollbacks take about 10 minutes.\n";

async function liveDoc(): Promise<void> {
  const ctx = systemCtx();
  await propose_doc_update(ctx, { slug: SLUG, section: "reference", title: "Deploys", body: BODY, change_summary: "first", confidence: "high", space: "technical" }, "AndresL230");
  await promote_doc(ctx, SLUG, 1, "AndresL230");
}
async function entry(summary: string, body: string, author = "Jose-Gael-Cruz-Lopez"): Promise<number> {
  const r = await first<{ id: number }>(env.DB, `INSERT INTO feed (org_id, author, summary, body, artifacts, created_at) VALUES (?, ?, ?, ?, NULL, ?) RETURNING id`,
    ORG_A, author, summary, body, new Date(Date.now() + 1000).toISOString());
  return r!.id;
}
const staged = () => all<{ version: number; status: string; created_by: string; confidence: string; low_confidence: number; body: string; summary: string }>(env.DB,
  `SELECT version, status, created_by, confidence, low_confidence, body, summary FROM doc_versions WHERE org_id = ? AND slug = ? AND status = 'staged'`, ORG_A, SLUG);
const due = () => markRow(ORG_A, "doc_drift", SLUG, new Date(Date.now() - 8 * DAY).toISOString());

let round = 0;
/** Tick 1 (gate + submit), end the batch with `answer`, tick 2 (collect + write). */
async function driftRound(jev: number, answer: (feedId: number) => unknown, feedId: number, e = keyedEnv()) {
  await due();
  const s = stubProviders({ jev: () => jev });
  s.batch.id = `msgbatch_drift${++round}`; // each round its own batch (ai_batches keys on the provider's id)
  const r1 = await tick(s, [DOC_DRIFT_JOB], later(0), e);
  const reqs = await all<{ request_id: string }>(env.DB, `SELECT request_id FROM ai_batch_requests`);
  s.batch.ended = true;
  s.batch.results = reqs.map((q) => succeededLine(q.request_id, JSON.stringify(answer(feedId))));
  const r2 = await tick(s, [DOC_DRIFT_JOB], later(DAY), e);
  return { s, r1, r2 };
}
const GOOD = (id: number) => ({
  disagrees: true,
  edits: [{ find: "Deploys are manual: an engineer runs the deploy script from a laptop.", replace: "Deploys run in CI on every merge to main.", cites: [`feed:${id}`] }],
  summary: "Deploys now run in CI, not by hand.",
});

beforeEach(async () => {
  await ensureTrovPerson();
  await liveDoc();
});

describe("the input: the live doc and the entries since its promote that its index matches", () => {
  it("null (no call, the scope clears) for an artifact's scope, an unknown doc, no matching entry, or a Trov proposal still waiting", async () => {
    const ctx = systemCtx();
    expect(await docDriftInput(ctx, "artifact:checkout")).toBeNull();
    expect(await docDriftInput(ctx, "nope")).toBeNull();
    expect(await docDriftInput(ctx, SLUG)).toBeNull(); // nothing written since
    await entry("Lunch menu", "Tacos on Friday.");
    expect(await docDriftInput(ctx, SLUG)).toBeNull(); // nothing matches "deploys"
    const id = await entry("Deploys moved to CI", "Every merge to main deploys through the CI workflow now.");
    const i = await docDriftInput(ctx, SLUG);
    expect(i?.entries.map((x) => x.ref)).toEqual([`feed:${id}`]);
    expect(i?.sent).toContain("Deploys are manual");
    expect(await docDriftInput(systemCtx(ORG_B), SLUG)).toBeNull(); // one org per prompt
  });
});

describe("gate.drift — Jev before any Haiku call", () => {
  it(`below ${DRIFT_GATE_MIN}: one Jev request, NO batch request, nothing proposed; the scope is written`, async () => {
    const id = await entry("Deploys moved to CI", "Every merge to main deploys through the CI workflow now.");
    const { s, r1 } = await driftRound(0.4, GOOD, id);
    expect([s.jev, r1.batched, s.batchCreates, s.haiku]).toEqual([1, 0, 0, 0]);
    expect(await staged()).toEqual([]);
    expect(await dirtyRow(ORG_A, "doc_drift", SLUG)).toMatchObject({ attempts: 0, last_error: null });
  });

  it("without Jev (no TypeSafe key) the plain rule is SKIP: zero requests of any kind", async () => {
    const id = await entry("Deploys moved to CI", "Every merge to main deploys through the CI workflow now.");
    const { s, r1 } = await driftRound(0.99, GOOD, id, keyedEnv({ TYPESAFE_API_KEY: undefined }));
    expect([s.jev, r1.batched, s.batchCreates, s.haiku]).toEqual([0, 0, 0, 0]);
    expect(await staged()).toEqual([]);
  });

  it("the gate asks ONE noul question over the doc and the entries", async () => {
    await entry("Deploys moved to CI", "Every merge to main deploys through the CI workflow now.");
    await due();
    let asked: { state: string; questions: Record<string, { type: string }> } | null = null;
    const s = stubProviders({ jev: (b) => { asked = b as never; return 0.1; } });
    await tick(s, [DOC_DRIFT_JOB], later(0));
    expect(Object.values(asked!.questions).map((q) => q.type)).toEqual(["noul"]);
    expect(asked!.state).toContain("Deploys are manual");
    expect(asked!.state).toContain("Deploys moved to CI");
  });
});

describe("past the gate: a cited disagreement is a LOW-CONFIDENCE proposal through the gate, by `trov`, and stays staged", () => {
  it("one Batch request; the server applies the edit; ingestDocProposal stages it flagged; nothing is promoted", async () => {
    const id = await entry("Deploys moved to CI", "Every merge to main deploys through the CI workflow now.");
    const { s, r1, r2 } = await driftRound(0.9, GOOD, id);
    expect([s.jev, r1.batched, s.batchCreates, s.haiku, r2.collected]).toEqual([1, 1, 1, 0, 1]);
    const sent = fencedBlocks((s.batchBodies[0].requests[0].params as { messages: { content: { text: string }[] }[] }).messages[0].content.at(-1)!.text);
    expect(Object.keys(sent)).toEqual([`document "Deploys" (${SLUG})`, "recent entries"]);
    expect(Object.values(sent)[0]).toBe(BODY); // the doc as its own text (what an edit's passage is quoted from)
    const rows = await staged();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ version: 2, created_by: "trov", confidence: "low", low_confidence: 1, status: "staged" });
    expect(rows[0].body).toBe(BODY.replace("Deploys are manual: an engineer runs the deploy script from a laptop.", "Deploys run in CI on every merge to main."));
    expect(rows[0].summary).toContain("“Deploys moved to CI”");
    expect(rows[0].summary).toContain("Low confidence");
    // The live doc is untouched: only a person promotes.
    expect(await first(env.DB, `SELECT current_version, body FROM docs WHERE org_id = ? AND slug = ?`, ORG_A, SLUG)).toEqual({ current_version: 1, body: BODY });
    // …and while it waits, the doc is not checked again.
    expect(await docDriftInput(systemCtx(), SLUG)).toBeNull();
  });

  it("'nothing disagrees' is an answer: the scope is written, nothing is proposed", async () => {
    const id = await entry("Deploys moved to CI", "Every merge to main deploys through the CI workflow now.");
    await driftRound(0.9, () => ({ disagrees: false, edits: [], summary: "The doc already says this." }), id);
    expect(await staged()).toEqual([]);
    expect(await dirtyRow(ORG_A, "doc_drift", SLUG)).toMatchObject({ attempts: 0, last_error: null });
  });

  it("GUARD: an edit with no valid cite, a passage not in the doc, or a number not in the input is dropped — none left, nothing is written", async () => {
    const id = await entry("Deploys moved to CI", "Every merge to main deploys through the CI workflow now.");
    for (const bad of [
      { ...GOOD(id), edits: [{ ...GOOD(id).edits[0], cites: ["feed:999999"] }] },
      { ...GOOD(id), edits: [{ ...GOOD(id).edits[0], find: "Deploys are automatic and instant." }] },
      { ...GOOD(id), edits: [{ find: "Rollbacks take about 10 minutes.", replace: "Rollbacks take about 3 minutes.", cites: [`feed:${id}`] }] },
    ]) {
      const { r1, s } = await driftRound(0.9, () => bad, id);
      expect([r1.batched, s.batchResults]).toEqual([1, 1]); // the answer WAS collected…
      expect(await staged()).toEqual([]); // …and nothing was written from it
      expect((await dirtyRow(ORG_A, "doc_drift", SLUG))!.last_error).toBe("not_written");
    }
  });

  it("applyDrift: a passage found more than once is ambiguous and dropped", async () => {
    const i = (await docDriftInput(systemCtx(), SLUG)) ?? null;
    expect(i).toBeNull();
    const id = await entry("Deploys moved to CI", "Every merge to main deploys through the CI workflow now.");
    const input = (await docDriftInput(systemCtx(), SLUG))!;
    expect(applyDrift({ ...input, body: `${input.body}\n${input.body}` }, GOOD(id))).toBeNull();
    expect(applyDrift(input, GOOD(id))?.cites.map((c) => c.ref)).toEqual([`feed:${id}`]);
  });

  it("Trov's own feed entries are never the evidence", async () => {
    await entry("Deploys moved to CI", "Every merge to main deploys through the CI workflow now.", "trov");
    expect(await docDriftInput(systemCtx(), SLUG)).toBeNull();
  });
});

describe("the switch", () => {
  it("off: nothing is read, asked or written", async () => {
    await entry("Deploys moved to CI", "Every merge to main deploys through the CI workflow now.");
    await run(env.DB, `UPDATE orgs SET ai_automation = 0 WHERE id = ?`, ORG_A);
    await due();
    const s = stubProviders();
    await tick(s, [DOC_DRIFT_JOB], later(0));
    expect([s.jev, s.batchCreates, s.haiku]).toEqual([0, 0, 0]);
  });
});

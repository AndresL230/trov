// THE ROADMAP AND DOC-DRIFT EVALS, replayed (docs/architecture/ai.md › Evals): `test/ai-evals/gate.drift/` (Jev — 20
// of Personal Dev's real docs, each with the feed entries the drift input would compare it with, labelled by hand),
// `doc.drift/` (Haiku — 12 of them) and `org.rollup/` (Haiku — 6 sprint notes and 4 plan drifts). The live run
// (test/ai-evals/run-live-roadmap.mjs) recorded what the providers answered; this test feeds those bodies back
// through THE client at the `Response` level and the REAL job code — the Jev question and `gateState`, the prompts,
// `applyDrift` / `checkNote` / `checkDrift` — and grades with test/ai-evals/roadmap-grade.ts. A change to a
// question or a prompt needs a new live run (the recording no longer answers it), and must keep these floors.
import { describe, it, expect } from "vitest";
import { providerFor } from "../src/ai/client";
import { keep } from "../src/ai/sections";
import { applyDrift, buildDocDriftInput, DOC_DRIFT_JOB, DRIFT_GATE, type DriftEntryRow } from "../src/ai/doc-drift";
import { buildDriftInput, buildNoteInput, checkDrift, checkNote, offPlanThemes, PLAN_DRIFT_JOB, SPRINT_NOTE_JOB, type NoteRaw } from "../src/ai/roadmap";
import type { AiThemeShare } from "@shared/ai";
import type { DirtyScope } from "../src/data/ai-dirty";
import { gradeDocDrift, gradeLine } from "./ai-evals/roadmap-grade";

interface DriftCase { id: string; slug: string; entries: number[]; expected: boolean }
interface Recorded { responses: Record<string, { status: number; body: string }> }
const files = Object.fromEntries(Object.entries(import.meta.glob("./ai-evals/{gate.drift,doc.drift,org.rollup}/*.json", { query: "?raw", import: "default", eager: true }))
  .map(([path, text]) => [path, JSON.parse(text as string) as unknown]));
const DOCS = (files["./ai-evals/doc.drift/docs.json"] as { docs: Record<string, { title: string; section: string; body: string }> }).docs;
const ENTRIES = new Map((files["./ai-evals/doc.drift/entries.json"] as { entries: DriftEntryRow[] }).entries.map((e) => [e.id, e]));
const gateCases = (files["./ai-evals/gate.drift/cases.json"] as { cases: DriftCase[] }).cases;
const docCases = (files["./ai-evals/doc.drift/cases.json"] as { cases: DriftCase[] }).cases;
const rollup = files["./ai-evals/org.rollup/cases.json"] as {
  now: string;
  notes: { id: string; sprint: NoteRaw }[];
  drift: { id: string; shares: AiThemeShare[]; sprints: { id: number; title: string }[] }[];
};
const rec = (kind: string) => (files[`./ai-evals/${kind}/recorded.json`] as Recorded).responses;
const replay = (body: { status: number; body: string } | undefined): typeof fetch => {
  if (!body) throw new Error("no recording for this case: run test/ai-evals/run-live-roadmap.mjs");
  return (async () => new Response(body.body, { status: body.status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
};
const scope = (s: DirtyScope["scope"], key: string): DirtyScope => ({ scope: s, key, dirtySince: "", markedAt: "", attempts: 0, urgent: false });
const inputOf = (c: DriftCase) => {
  const d = DOCS[c.slug];
  return buildDocDriftInput({ slug: c.slug, section: d.section, title: d.title, body: d.body, current_version: 1 }, c.entries.map((id) => ENTRIES.get(id)!));
};

/** The floors: what the live run scored on 2026-10-15 (gate.drift 17/20 with no false pass; doc.drift 5/12 with no
 *  false proposal; org.rollup 10/10 kept once the cite cap stopped failing a whole answer), less a margin for a
 *  re-record. The "never" floors have no margin. */
const GATE_FLOOR = 0.8;
const DOC_FLOOR = 0.4;
const ROLLUP_FLOOR = 0.9;

describe("gate.drift — real docs and entries, Jev's recorded answers, the real question and the 0.6 threshold", () => {
  it(`has at least 15 cases (both labels), scores ≥ ${GATE_FLOOR}, and NEVER passes a doc that agrees`, async () => {
    expect(gateCases.length).toBeGreaterThanOrEqual(15);
    expect(gateCases.some((c) => c.expected) && gateCases.some((c) => !c.expected)).toBe(true);
    let right = 0;
    const misses: string[] = [];
    for (const c of gateCases) {
      const req = DRIFT_GATE.ask({ scope: scope("doc_drift", c.slug), input: inputOf(c) });
      expect(req.state.length).toBeLessThanOrEqual(4000);
      const r = await providerFor("gate.drift", { apiKey: "ts-FAKE", fetchImpl: replay(rec("gate.drift")[c.id]) })!.ask(req.state, req.questions);
      expect(r.ok, c.id).toBe(true);
      const passed = r.ok ? DRIFT_GATE.pass({ model: r.model, answers: r.answers }) : false;
      if (!c.expected) expect(passed, `${c.id} agrees with its entries and must not reach Haiku`).toBe(false);
      if (passed === c.expected) right++; else misses.push(c.id);
    }
    expect(right / gateCases.length, misses.join(", ")).toBeGreaterThanOrEqual(GATE_FLOOR);
  });
});

describe("doc.drift — Haiku's recorded edits through the server's rules", () => {
  it(`has at least 8 cases, scores ≥ ${DOC_FLOOR}, never proposes on a doc that agrees, and every surviving edit is grounded`, async () => {
    expect(docCases.length).toBeGreaterThanOrEqual(8);
    let right = 0, proposals = 0, named = 0, valid = 0;
    for (const c of docCases) {
      const input = inputOf(c);
      const p = DOC_DRIFT_JOB.prompt([{ scope: scope("doc_drift", c.slug), input }]);
      expect(p.input).toContain(input.sent.slice(0, 200)); // the doc goes as its own text, not JSON escapes
      const res = await providerFor("doc.drift", { apiKey: "sk-ant-FAKE", fetchImpl: replay(rec("doc.drift")[c.id]) })!
        .structured({ kind: "doc.drift", system: p.system, input: p.input, schema: DOC_DRIFT_JOB.schema, maxTokens: DOC_DRIFT_JOB.maxTokens });
      expect(res, `${c.id}: the recorded answer still parses`).not.toBeNull();
      const kept = res ? keep(res.value).kept : null;
      const g = gradeDocDrift(input, kept, c.expected, applyDrift);
      if (g.right) right++;
      named += g.citesNamed;
      valid += g.citesValid;
      const proposal = kept ? applyDrift(input, kept) : null;
      if (!c.expected) expect(proposal, `${c.id} agrees with its entries: no proposal`).toBeNull();
      if (proposal) {
        proposals++;
        expect(proposal.body).not.toBe(input.body);
        expect(proposal.cites.length).toBeGreaterThan(0);
        for (const cite of proposal.cites) expect(input.offered.has(cite.ref)).toBe(true);
        expect(proposal.summary).not.toMatch(/\b(?:feed|ticket|pr):\d/); // refs read as labels
      }
    }
    expect(proposals).toBeGreaterThanOrEqual(3);
    expect(valid).toBe(named); // the model cited only entries it was given
    expect(right / docCases.length).toBeGreaterThanOrEqual(DOC_FLOOR);
  });
});

describe("org.rollup — sprint notes and plan drift, recorded, through checkNote / checkDrift", () => {
  it(`has at least 8 cases and ≥ ${ROLLUP_FLOOR} of the lines are kept: cites offered, numbers given, refs read as labels`, async () => {
    const now = new Date(rollup.now);
    const cases = [
      ...rollup.notes.map((c) => ({ id: c.id, job: SPRINT_NOTE_JOB, input: buildNoteInput(c.sprint, now), sprintId: c.sprint.sprintId })),
      ...rollup.drift.map((c) => ({ id: c.id, job: PLAN_DRIFT_JOB, input: buildDriftInput(c.shares, offPlanThemes(c.shares), c.sprints), sprintId: null })),
    ];
    expect(cases.length).toBeGreaterThanOrEqual(8);
    let kept = 0, named = 0, valid = 0;
    const dropped: string[] = [];
    for (const c of cases) {
      const job = c.job as typeof SPRINT_NOTE_JOB | typeof PLAN_DRIFT_JOB;
      const p = (job.prompt as (items: unknown[]) => { system: string; input: string })([{ scope: scope(job.scope, c.id), input: c.input }]);
      const res = await providerFor("org.rollup", { apiKey: "sk-ant-FAKE", fetchImpl: replay(rec("org.rollup")[c.id]) })!
        .structured({ kind: "org.rollup", system: p.system, input: p.input, schema: job.schema as typeof SPRINT_NOTE_JOB.schema, maxTokens: job.maxTokens });
      const k = res ? (keep(res.value).kept as { notes?: { sprint: number; text: string; cites: string[] }[]; drift?: { text: string; cites: string[] } }) : {};
      const line = c.sprintId !== null ? (k.notes ?? []).find((n) => n.sprint === c.sprintId) ?? null : k.drift ?? null;
      const g = c.sprintId !== null
        ? gradeLine(c.input as ReturnType<typeof buildNoteInput>, line, checkNote)
        : gradeLine(c.input as ReturnType<typeof buildDriftInput>, line, checkDrift);
      named += g.citesNamed;
      valid += g.citesValid;
      if (g.kept) kept++; else dropped.push(c.id);
      const stored = line ? (c.sprintId !== null ? checkNote(c.input as ReturnType<typeof buildNoteInput>, line) : checkDrift(c.input as ReturnType<typeof buildDriftInput>, line)) : null;
      if (stored) expect(stored.text).not.toMatch(/\b(?:ticket|pr|feed|sprint|theme):\w/);
    }
    expect(valid).toBe(named);
    expect(kept / cases.length, dropped.join(", ")).toBeGreaterThanOrEqual(ROLLUP_FLOOR);
  });
});

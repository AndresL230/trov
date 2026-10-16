// THE PHASE D DIGEST EVALS, replayed (docs/architecture/ai.md › Evals): `gate.session` and `gate.state` (Jev) and
// `digest.session` and `repo.state` (Haiku), each in `test/ai-evals/<kind>/` — real cases from this repository's
// history and the Personal Dev org (cases.json), and what the providers answered when they were run LIVE once
// (recorded.json, by scripts/ai-evals/digests-live.ts). This test feeds the recorded bodies back through THE client at
// the `Response` level and the REAL job code — the gate questions and decisions, the prompts, `checkDigest` /
// `checkState` — and grades them with the rules in test/ai-evals/digests-grade.ts. No network.
//
// Each recording carries a hash of what was sent: a changed prompt, question or input FAILS here ("record again") —
// run the live script, and keep these floors.
import { describe, it, expect } from "vitest";
import { providerFor } from "../src/ai/client";
import { DIGEST_SYSTEM, DigestSchema, digestPrompt, checkDigest, sessionDigestJob, sessionFallback, sessionGate, type SessionInput } from "../src/ai/digests";
import { STATE_SYSTEM, StateSchema, checkState, repoStateJob, stateFallback, stateGate, statePrompt, type StateInput } from "../src/ai/repo-state";
import type { JobItem } from "../src/ai/jobs";
import {
  DIGEST_RULES, EVAL_PREFIX, STATE_RULES, gradeDigestKept, gradeDigestRaw, gradeStateKept, gradeStateRaw, promptKey, tally,
  type Case, type GateCase, type RecordedFile, type Recording,
} from "./ai-evals/digests-grade";
import gateSessionCases from "./ai-evals/gate.session/cases.json";
import gateSessionRec from "./ai-evals/gate.session/recorded.json";
import digestCases from "./ai-evals/digest.session/cases.json";
import digestRec from "./ai-evals/digest.session/recorded.json";
import gateStateCases from "./ai-evals/gate.state/cases.json";
import gateStateRec from "./ai-evals/gate.state/recorded.json";
import stateCases from "./ai-evals/repo.state/cases.json";
import stateRec from "./ai-evals/repo.state/recorded.json";

/** The floors: what the live run scored (2026-10-15 — gate.session 17/17, gate.state 18/19, digest.session 10/10
 *  raw and written, repo.state 8/8 raw and written), less a margin for a re-record. */
const FLOOR = { "gate.session": 0.9, "gate.state": 0.85, "digest.session": 0.9, "repo.state": 0.9 };

const replay = (r: Recording): typeof fetch =>
  (async () => new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
const item = <I>(scope: "session" | "repo", input: I): JobItem<I> =>
  ({ scope: { scope, key: "eval", dirtySince: "", markedAt: "", attempts: 0, urgent: false }, input }) as JobItem<I>;
const recOf = (file: unknown, id: string): Recording => {
  const r = (file as RecordedFile).responses[id];
  expect(r, `${id} has a recording`).toBeDefined();
  return r;
};

async function gateScore<I>(kind: "gate.session" | "gate.state", cases: GateCase<I>[], rec: unknown, g: typeof sessionGate | typeof stateGate, scope: "session" | "repo", fallback: (i: I) => boolean) {
  let right = 0, fb = 0;
  const misses: string[] = [];
  for (const c of cases) {
    const req = (g.ask as (i: JobItem<I>) => { state: string; questions: Record<string, never> })(item(scope, c.input));
    const r = recOf(rec, c.id);
    expect(r.key, `${kind} ${c.id}: the question or its input changed since the recording — run the live evals again`).toBe(promptKey(req.state, JSON.stringify(req.questions)));
    const a = await providerFor(kind, { apiKey: "ts-FAKE", fetchImpl: replay(r) })!.ask(req.state, req.questions);
    expect(a.ok, `${kind} ${c.id}`).toBe(true);
    const got = a.ok && (g.pass as (x: typeof a) => boolean)(a);
    if (got === c.expected) right++; else misses.push(`${c.id}: ${got} (expected ${c.expected})`);
    if (fallback(c.input) === c.expected) fb++;
  }
  return { rate: right / cases.length, fallback: fb / cases.length, misses };
}

describe("gate.session — is a burst substantive? Real bursts, Jev's recorded answers, the real question and threshold", () => {
  it(`has ≥ 15 real cases, both answers represented, and scores ≥ ${FLOOR["gate.session"]} (the plain rule scores less)`, async () => {
    const cases = gateSessionCases.cases as unknown as GateCase<SessionInput>[];
    expect(cases.length).toBeGreaterThanOrEqual(15);
    expect(cases.some((c) => c.expected) && cases.some((c) => !c.expected)).toBe(true);
    const s = await gateScore("gate.session", cases, gateSessionRec, sessionGate, "session", sessionFallback);
    expect(s.rate, s.misses.join("; ")).toBeGreaterThanOrEqual(FLOOR["gate.session"]);
    expect(s.fallback).toBeLessThan(s.rate); // Jev beats "a PR or 3+ commits" on these cases (14/17)
  });
});

describe("gate.state — did the delta change the picture? Real deltas, Jev's recorded answers", () => {
  it(`has ≥ 15 real cases, both answers represented, and scores ≥ ${FLOOR["gate.state"]} (the plain rule scores less)`, async () => {
    const cases = gateStateCases.cases as unknown as GateCase<StateInput>[];
    expect(cases.length).toBeGreaterThanOrEqual(15);
    expect(cases.some((c) => c.expected) && cases.some((c) => !c.expected)).toBe(true);
    const s = await gateScore("gate.state", cases, gateStateRec, stateGate, "repo", stateFallback);
    expect(s.rate, s.misses.join("; ")).toBeGreaterThanOrEqual(FLOOR["gate.state"]);
    expect(s.fallback).toBeLessThan(s.rate); // the plain rule calls every deploy a change (12/19)
  });
});

describe("digest.session — real bursts in, Haiku's recorded entries out, graded by the rules", () => {
  it(`has ≥ 8 cases; the raw answers keep every rule (≥ ${FLOOR["digest.session"]}) and the server writes them`, async () => {
    const cases = digestCases.cases as unknown as Case<SessionInput>[];
    expect(cases.length).toBeGreaterThanOrEqual(8);
    expect(cases.some((c) => c.input.shipped) && cases.some((c) => !c.input.shipped)).toBe(true);
    const rows: Record<string, boolean>[] = [];
    let written = 0;
    for (const c of cases) {
      const input = digestPrompt(c.input);
      const r = recOf(digestRec, c.id);
      expect(r.key, `${c.id}: the prompt changed since the recording — run the live evals again`).toBe(promptKey(DIGEST_SYSTEM, EVAL_PREFIX, input));
      const res = await providerFor("digest.session", { apiKey: "sk-ant-FAKE", fetchImpl: replay(r) })!
        .structured({ kind: "digest.session", system: DIGEST_SYSTEM, prefix: EVAL_PREFIX, cache: true, input, schema: DigestSchema, maxTokens: sessionDigestJob.maxTokens });
      expect(res, c.id).not.toBeNull();
      const a = res!.value as unknown as Record<string, unknown>;
      rows.push(gradeDigestRaw(a, c.input));
      if (gradeDigestKept(a, c.input).written) written++;
    }
    const t = tally(rows, DIGEST_RULES);
    expect(t.all, JSON.stringify(t.byRule)).toBeGreaterThanOrEqual(FLOOR["digest.session"]);
    expect(written / cases.length).toBeGreaterThanOrEqual(FLOOR["digest.session"]);
  });

  it("the rules catch what a careless digest does (the eval's negative cases)", () => {
    const s = (digestCases.cases as unknown as Case<SessionInput>[]).find((c) => c.id === "pr-182")!.input;
    const ok = { type: "Shipped", summary: "Shipped: only the row you settle slides out", brief: "Reviewing suggestions is quicker.", cites: ["pr:182"] };
    expect(Object.values(gradeDigestRaw(ok, s)).every(Boolean)).toBe(true);
    expect(gradeDigestRaw({ ...ok, type: "Status", summary: "Status: x y" }, s).type).toBe(false); // a merge is Shipped
    expect(gradeDigestRaw({ ...ok, summary: "Only the row slides out" }, s).prefix).toBe(false);
    expect(gradeDigestRaw({ ...ok, summary: `Shipped: ${"x".repeat(100)}` }, s).length).toBe(false);
    expect(gradeDigestRaw({ ...ok, brief: "Fixed in #182." }, s).brief_refs).toBe(false);
    expect(gradeDigestRaw({ ...ok, summary: "Shipped: review is 40% faster" }, s).numbers).toBe(false);
    expect(gradeDigestRaw({ ...ok, cites: ["pr:182", "pr:999"] }, s).cites_valid).toBe(false);
    expect(gradeDigestRaw({ ...ok, cites: ["pr:999"] }, s).cites_some).toBe(false);
    // …and the server's own check refuses to write the last one.
    expect(checkDigest({ ...ok, cites: ["pr:999"] }, s)).toEqual({ ok: false, reason: "no_cite" });
  });
});

describe("repo.state — real deltas in, Haiku's recorded pictures out, graded by the rules", () => {
  it(`has ≥ 8 cases; the raw answers keep every rule (≥ ${FLOOR["repo.state"]}) and the server writes them`, async () => {
    const cases = stateCases.cases as unknown as Case<StateInput>[];
    expect(cases.length).toBeGreaterThanOrEqual(8);
    expect(cases.some((c) => c.input.redMain) && cases.some((c) => c.input.previous) && cases.some((c) => !c.input.previous)).toBe(true);
    const rows: Record<string, boolean>[] = [];
    let written = 0;
    for (const c of cases) {
      const input = statePrompt(c.input);
      const r = recOf(stateRec, c.id);
      expect(r.key, `${c.id}: the prompt changed since the recording — run the live evals again`).toBe(promptKey(STATE_SYSTEM, EVAL_PREFIX, input));
      const res = await providerFor("repo.state", { apiKey: "sk-ant-FAKE", fetchImpl: replay(r) })!
        .structured({ kind: "repo.state", system: STATE_SYSTEM, prefix: EVAL_PREFIX, cache: true, input, schema: StateSchema, maxTokens: repoStateJob.maxTokens });
      expect(res, c.id).not.toBeNull();
      const a = res!.value as unknown as Record<string, unknown>;
      rows.push(gradeStateRaw(a, c.input));
      if (gradeStateKept(a, c.input).written) written++;
    }
    const t = tally(rows, STATE_RULES);
    expect(t.all, JSON.stringify(t.byRule)).toBeGreaterThanOrEqual(FLOOR["repo.state"]);
    expect(written / cases.length).toBeGreaterThanOrEqual(FLOOR["repo.state"]);
  });

  it("the rules catch what a careless picture does (the eval's negative cases)", () => {
    const red = (stateCases.cases as unknown as Case<StateInput>[]).find((c) => c.id === "red-main")!.input;
    const merge = (stateCases.cases as unknown as Case<StateInput>[]).find((c) => c.id === "add-185")!.input;
    const ok = { headline: "Hosting providers landed.", shipped: [{ text: "Hosting providers landed.", cites: ["pr:185"] }], in_flight: [], attention: [] };
    expect(Object.values(gradeStateRaw(ok, merge)).every(Boolean)).toBe(true);
    expect(gradeStateRaw({ ...ok, shipped: [], in_flight: ok.shipped }, merge)).toMatchObject({ merged_shipped: false, merged_left_flight: false });
    expect(gradeStateRaw({ ...ok, headline: "Hosting landed in pr:185." }, merge).text_refs).toBe(false);
    expect(gradeStateRaw({ ...ok, shipped: [{ text: "Hosting landed for 12 teams.", cites: ["pr:185"] }] }, merge).numbers).toBe(false);
    expect(gradeStateRaw({ ...ok, shipped: [...ok.shipped, { text: "Billing shipped.", cites: ["pr:4242"] }] }, merge).cites_valid).toBe(false);
    expect(gradeStateRaw({ headline: "All good.", shipped: [], in_flight: [], attention: [] }, red).red_attention).toBe(false);
    // …and the server drops such lines: a ref in the sentence, an unknown cite.
    const c = checkState({ ...ok, shipped: [{ text: "Hosting landed in pr:185.", cites: ["pr:185"] }, { text: "Billing shipped.", cites: ["pr:4242"] }] }, merge);
    expect(c.ok && c.state.shipped).toEqual([]);
    expect(c.ok && c.dropped).toBe(2);
  });
});

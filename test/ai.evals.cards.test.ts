// THE RECORDED-RESPONSE EVALS of Phase C's Jev cards (test/ai-evals/<kind>/): every case's request is built by the
// card module itself and must equal, byte for byte, the request recorded against the LIVE Jev API (scripts/ai-evals/
// run.mjs) — a change to a card's questions fails here until the set is re-recorded and re-scored. The recorded body
// is replayed at the `Response` level through the real provider (its parser), and each decision must be the one the
// recorded run made at the card's thresholds, so the per-kind accuracy cannot silently drop. Never the network.
import { describe, it, expect } from "vitest";
import { providerFor } from "../src/ai/client";
import { EVAL_KINDS, decisionFor, recordingOf, requestFor, score, type EvalFile, type EvalKind, type RecordedFile } from "./ai-evals/evals";
import catCases from "./ai-evals/ticket.category/cases.json";
import priCases from "./ai-evals/ticket.priority/cases.json";
import dupCases from "./ai-evals/ticket.duplicate/cases.json";
import riskCases from "./ai-evals/review.risk/cases.json";
import placeCases from "./ai-evals/unplaced.destination/cases.json";
import catRec from "./ai-evals/ticket.category/recorded.json";
import dupRec from "./ai-evals/ticket.duplicate/recorded.json";
import riskRec from "./ai-evals/review.risk/recorded.json";
import placeRec from "./ai-evals/unplaced.destination/recorded.json";
import catRes from "./ai-evals/ticket.category/results.json";
import priRes from "./ai-evals/ticket.priority/results.json";
import dupRes from "./ai-evals/ticket.duplicate/results.json";
import riskRes from "./ai-evals/review.risk/results.json";
import placeRes from "./ai-evals/unplaced.destination/results.json";

const CASES = { "ticket.category": catCases, "ticket.priority": priCases, "ticket.duplicate": dupCases, "review.risk": riskCases, "unplaced.destination": placeCases } as unknown as Record<EvalKind, EvalFile>;
const RECORDED = { "ticket.category": catRec, "ticket.duplicate": dupRec, "review.risk": riskRec, "unplaced.destination": placeRec } as unknown as Record<string, RecordedFile>;
type Results = { accuracy: number; correct: number; n: number; decisions: Record<string, string | number | null> };
const RESULTS = { "ticket.category": catRes, "ticket.priority": priRes, "ticket.duplicate": dupRes, "review.risk": riskRes, "unplaced.destination": placeRes } as unknown as Record<EvalKind, Results>;

describe("Phase C evals: recorded Jev answers replayed, decisions pinned", () => {
  for (const kind of EVAL_KINDS) {
    it(`${kind}: every request is the recorded one, and every decision the recorded run's`, async () => {
      const file = CASES[kind];
      const rec = RECORDED[recordingOf(kind)];
      expect(file.cases.length).toBeGreaterThanOrEqual(15);
      const rows: { expected: unknown; decision: unknown }[] = [];
      for (const c of file.cases) {
        const r = rec.cases[c.id];
        expect(r, `${kind} ${c.id} is recorded`).toBeDefined();
        const req = requestFor(kind, c);
        let sent: unknown = null;
        const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
          sent = JSON.parse(String(init?.body));
          return new Response(r.response, { status: r.status, headers: { "content-type": "application/json" } });
        }) as typeof fetch;
        const a = await providerFor("ticket.category", { apiKey: "replay", fetchImpl })!.ask(req.state, req.questions);
        // The request did not drift from what Jev was asked when the set was scored.
        expect(sent, `${kind} ${c.id}: the request changed — re-run scripts/ai-evals/run.mjs record`).toEqual(r.request);
        expect(a.ok).toBe(true);
        const decision = decisionFor(kind, c, a.ok ? a.answers : {});
        expect(decision, `${kind} ${c.id}`).toEqual(RESULTS[kind].decisions[c.id]);
        rows.push({ expected: c.expected, decision });
      }
      const s = score(kind, rows);
      expect(s.correct).toBe(RESULTS[kind].correct);
      expect(s.accuracy).toBeGreaterThanOrEqual(RESULTS[kind].accuracy);
    });
  }

  it("the recorded runs are Jev's, and carry no credential", () => {
    for (const r of Object.values(RECORDED)) {
      expect(r.model).toMatch(/^jev-/);
      // A recording is the request BODY (no headers, so no key) and the response body.
      for (const c of Object.values(r.cases)) {
        expect(Object.keys(c).sort()).toEqual(["request", "response", "status"]);
        expect(Object.keys(c.request as object).sort()).toEqual(["model", "questions", "state"]);
        expect(c.response).not.toMatch(/Bearer\s+\S{20,}/);
      }
    }
  });
});

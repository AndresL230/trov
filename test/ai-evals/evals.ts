// The Phase C eval sets (test/ai-evals/<kind>/cases.json): how each case becomes EXACTLY the Jev request the pass
// sends (the card modules' own `*Request`) and how an answer becomes a decision (their own `*Decide`, at the
// module's thresholds unless a sweep passes others). Shared by the live runner (scripts/ai-evals/run.ts — run by
// hand, never in the suite) and the recorded-response test (test/ai.evals.cards.test.ts). Pure.
import type { JevAnswer } from "../../src/ai/client";
import type { JevRequest } from "../../src/ai/jobs";
import { TICKET_MINS, ticketDecide, ticketRequest, type TicketCardInput, type TicketMins } from "../../src/ai/jobs/ticket-card";
import { REVIEW_RISK_MIN, reviewDecide, reviewRequest, type ReviewCardInput } from "../../src/ai/jobs/review-card";
import { UNPLACED_DESTINATION_MIN, unplacedDecide, unplacedRequest, type UnplacedCardInput, type UnplacedDoc } from "../../src/ai/jobs/unplaced-card";

export const EVAL_KINDS = ["ticket.category", "ticket.priority", "ticket.duplicate", "review.risk", "unplaced.destination"] as const;
export type EvalKind = (typeof EVAL_KINDS)[number];

interface TicketBits { number: number; title: string; body: string }
export interface EvalCase {
  id: string;
  source: string;
  expected: string | number | null;
  rationale: string;
  ticket?: TicketBits;
  candidates?: (TicketBits | UnplacedDoc)[];
  item?: Record<string, unknown>;
}
export interface EvalFile { kind: EvalKind; source: string; cases: EvalCase[] }

/** One recorded exchange: the request body sent, and the response body Jev answered with. */
export interface Recorded { request: unknown; status: number; response: string }
export interface RecordedFile { model: string; recordedAt: string; promptVersions: Record<string, string>; cases: Record<string, Recorded> }

/** The kind whose recordings a kind replays: category and priority are ONE request per ticket (as in the pass). */
export const recordingOf = (k: EvalKind): EvalKind => (k === "ticket.priority" ? "ticket.category" : k);

/** A ticket case as the card reads it: the category and priority nobody picked (`other`, `normal`), so both are
 *  asked, and a duplicate case's candidates — exactly what the pass would send for a new ticket. */
function ticketInput(c: EvalCase): TicketCardInput {
  const t = c.ticket!;
  return {
    number: t.number, title: t.title, body: t.body, category: "other", priority: "normal", askCategory: true, askPriority: true,
    candidates: ((c.candidates ?? []) as TicketBits[]).map((x) => ({ number: x.number, title: x.title, body: x.body, snippet: null })),
  };
}
const unplacedInput = (c: EvalCase): UnplacedCardInput => {
  const it = c.item as { title: string; body: string; filedUnder: string | null };
  return { id: 0, title: it.title, body: it.body, filedUnder: it.filedUnder, docs: (c.candidates ?? []) as UnplacedDoc[] };
};

export function requestFor(kind: EvalKind, c: EvalCase): JevRequest {
  switch (kind) {
    case "ticket.category": case "ticket.priority": case "ticket.duplicate": return ticketRequest(ticketInput(c))!;
    case "review.risk": return reviewRequest(c.item as unknown as ReviewCardInput);
    case "unplaced.destination": return unplacedRequest(unplacedInput(c));
  }
}

/** The decision the card makes: the value it would suggest, or what "no suggestion" means for that kind
 *  (`none` category, `normal` priority, no duplicate, `routine` risk, no destination). `min` overrides the
 *  kind's threshold (a sweep). */
export function decisionFor(kind: EvalKind, c: EvalCase, answers: Record<string, JevAnswer | null>, min?: number): string | number | null {
  switch (kind) {
    case "ticket.category": case "ticket.priority": case "ticket.duplicate": {
      const mins: TicketMins = { ...TICKET_MINS };
      if (min !== undefined) mins[kind === "ticket.category" ? "category" : kind === "ticket.priority" ? "priority" : "duplicate"] = min;
      const s = ticketDecide(ticketInput(c), answers, mins).suggestions.find((x) => x.kind === kind);
      if (kind === "ticket.category") return (s?.value as string | undefined) ?? "none";
      if (kind === "ticket.priority") return (s?.value as string | undefined) ?? "normal";
      return (s?.value as { number: number } | undefined)?.number ?? null;
    }
    case "review.risk": return reviewDecide(c.item as unknown as ReviewCardInput, answers, min ?? REVIEW_RISK_MIN).suggestion?.value.risk ?? "routine";
    case "unplaced.destination": return unplacedDecide(unplacedInput(c), answers, min ?? UNPLACED_DESTINATION_MIN).suggestion?.value.section ?? "none";
  }
}

/** Of the cases: how many decisions match the label, and — of the suggestions the card WROTE (a decision other than
 *  "no suggestion") — how many were right. */
export function score(kind: EvalKind, decided: { expected: unknown; decision: unknown }[]): { n: number; correct: number; accuracy: number; written: number; writtenRight: number; precision: number | null } {
  const none = kind === "ticket.category" ? "none" : kind === "ticket.priority" ? "normal" : kind === "review.risk" ? "routine" : kind === "unplaced.destination" ? "none" : null;
  const correct = decided.filter((d) => d.decision === d.expected).length;
  const written = decided.filter((d) => d.decision !== none);
  const writtenRight = written.filter((d) => d.decision === d.expected).length;
  return {
    n: decided.length, correct, accuracy: decided.length ? correct / decided.length : 0,
    written: written.length, writtenRight, precision: written.length ? writtenRight / written.length : null,
  };
}

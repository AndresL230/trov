// THE TICKET CARD (Phase C, docs/architecture/ai.md › The kinds): what Jev is asked about one new ticket and what
// its answer becomes. Pure — no D1, no network — so the eval runner (scripts/ai-evals/) and the recorded-response
// test (test/ai.evals.test.ts) build EXACTLY the request the pass sends and decide exactly as it does.
//
// ONE request per ticket, carrying up to three `choice` questions:
//   • `category` — bug / request / question / access / other (`TICKET_CATEGORIES`), asked only while the ticket's
//     category is still the one nobody picked (`other`, what the form files with nothing chosen);
//   • `priority` — low / normal / high, asked only while it is still the default `normal`;
//   • `duplicate` — one of the TOP FIVE full-text hits of this org (never the ticket itself), or `none`.
// A field a person set is never asked about and never overwritten (person over AI); a kind a person already
// accepted or dismissed for this ticket is never asked again. A suggestion is written only when the answer differs
// from what the ticket has, is one of the options offered (the parser already refuses anything else), and its
// probability clears the kind's threshold (chosen on the eval set, test/ai-evals/). Its REASON is the ticket's own
// words that match the answer — a window around them, or the title — and a duplicate's is the words the two
// tickets share: Trov's evidence, never model text. A duplicate is only ever a suggestion to LINK the two; nothing
// here closes anything.
import { TICKET_CATEGORIES, TICKET_PRIORITIES, type TicketCategory, type TicketPriority } from "@shared/tickets-core";
import type { AiCite } from "@shared/ai-core";
import type { JevAnswer, JevQuestion } from "../client";
import type { JevRequest } from "../jobs";
import { excerptOf, quoted, quoteList, sharedWords, snippetEvidence, windowAround } from "./text";

export const TICKET_PROMPT_VERSION = "jev-ticket-1";
/** Write a suggestion only at or above these probabilities (chosen on the eval sets: test/ai-evals/<kind>/). */
export const TICKET_CATEGORY_MIN = 0.7;
export const TICKET_PRIORITY_MIN = 0.75;
export const TICKET_DUPLICATE_MIN = 0.9;
/** The most duplicate candidates one request offers: the top five full-text hits. */
export const DUPLICATE_CANDIDATES = 5;
const BODY_MAX = 1200;

export interface TicketCandidate { number: number; title: string; body: string; snippet: string | null }

/** What the job read about one ticket. `ask*` false = a person set it, or decided a suggestion for it. */
export interface TicketCardInput {
  number: number;
  title: string;
  body: string;
  category: TicketCategory;
  priority: TicketPriority;
  askCategory: boolean;
  askPriority: boolean;
  /** The top full-text hits, best first — already without the ticket itself and the tickets it links. */
  candidates: TicketCandidate[];
}

export const CATEGORY_CRITERIA: Record<TicketCategory, string> = {
  bug: "Something is broken, fails, or behaves wrongly",
  request: "Asks for something new or changed: a feature, an improvement, support for a case, a piece of work",
  question: "Asks how something works or for information, without asking for a change",
  access: "Asks for access, an account, an invite, a role or a permission",
  other: "None of these",
};
export const PRIORITY_CRITERIA: Record<TicketPriority, string> = {
  low: "Can wait: an idea, an exploration, a nice-to-have, polish, or something marked for later",
  normal: "Ordinary work, with no sign of urgency or of being deferred",
  high: "Urgent: something is broken for people now, blocks work, risks data or security, or is asked for as soon as possible",
};

/** The option a duplicate candidate is offered under. */
export const candidateKey = (n: number): string => `ticket_${n}`;
const NONE = "none";

/** The request the pass sends for this ticket, or null when there is nothing to ask. */
export function ticketRequest(input: TicketCardInput): JevRequest | null {
  const questions: Record<string, JevQuestion> = {};
  if (input.askCategory) {
    questions.category = { type: "choice", instructions: "What kind of ticket is this?", criteria: { ...CATEGORY_CRITERIA } };
  }
  if (input.askPriority) {
    questions.priority = { type: "choice", instructions: "How urgent is this ticket?", criteria: { ...PRIORITY_CRITERIA } };
  }
  const cands = input.candidates.slice(0, DUPLICATE_CANDIDATES);
  if (cands.length) {
    const criteria: Record<string, string> = { [NONE]: "None of them: this ticket asks for something different (related or similar work is not the same request)" };
    for (const c of cands) criteria[candidateKey(c.number)] = `#${c.number}: ${excerptOf(c.title, 120)} — ${excerptOf(c.body, 120)}`;
    questions.duplicate = { type: "choice", instructions: "Is this ticket the same request as one of these existing tickets? Pick that ticket, or none.", criteria };
  }
  if (!Object.keys(questions).length) return null;
  return { state: `Ticket #${input.number}: ${excerptOf(input.title, 300)}\n\n${excerptOf(input.body, BODY_MAX)}`.trim(), questions };
}

// ── evidence: the ticket's own words ─────────────────────────────────────────

const CATEGORY_WORDS: Record<TicketCategory, RegExp | null> = {
  bug: /\b(bugs?|broken|breaks?|crash(?:es|ed)?|errors?|fail(?:s|ed|ing|ure)?|wrong|blank|exception|regression|(?:doesn'?t|does not|isn'?t|is not|not) work(?:ing)?|can'?t|cannot|stuck|loops?|missing|fix)\b/i,
  request: /\b(add|adds|support|let|lets|allow|enable|show|feature|improve|explore|build|would like|want|wish|option|connect|offer|ordered|suggest)\b/i,
  question: /(\b(?:how (?:do|can|does|to|should)|why|what is|is there|is it possible|question)\b|\?)/i,
  access: /\b(access|permissions?|invite|role|account|sign[- ]?in|log[- ]?in|login|credentials?|admin rights)\b/i,
  other: null,
};
const PRIORITY_WORDS: Record<TicketPriority, RegExp | null> = {
  high: /\b(urgent|asap|blocking|blocker|blocks|broken|crash(?:es)?|down|outage|data loss|security|leak|production|can'?t|cannot|everyone)\b/i,
  low: /\b(later|someday|eventually|nice to have|minor|polish|cosmetic|typo|explore|exploration|experiment|idea|maybe)\b/i,
  normal: null,
};

/** "it says “…words…”": the window around the first word matching the answer, in the title first, then the body;
 *  without one, the title. "" when the ticket has no words at all (then nothing is written). */
export function wordsEvidence(input: Pick<TicketCardInput, "title" | "body">, re: RegExp | null): string {
  const w = re ? windowAround(input.title, re, 50) ?? windowAround(input.body, re, 50) : null;
  if (w) return `it says “${w}”`;
  const t = quoted(input.title, 100);
  return t ? `it says ${t}` : "";
}

// ── the decision ─────────────────────────────────────────────────────────────

export interface TicketSuggestion {
  kind: "ticket.category" | "ticket.priority" | "ticket.duplicate";
  value: unknown;
  confidence: number;
  reason: string;
  cites: AiCite[];
}

export interface TicketDecision {
  /** Every question asked came back null (malformed) — nothing could be judged; the scope fails and retries. */
  unanswered: boolean;
  suggestions: TicketSuggestion[];
}

const pOf = (a: JevAnswer | null | undefined): { choice: string; p: number } | null =>
  a && a.type === "choice" ? { choice: a.choice, p: a.probabilities[a.choice] ?? 0 } : null;

/** What Jev's answers to `ticketRequest(input)` become. */
/** The thresholds a decision uses — the module's own, unless an eval sweep passes others. */
export interface TicketMins { category: number; priority: number; duplicate: number }
export const TICKET_MINS: TicketMins = { category: TICKET_CATEGORY_MIN, priority: TICKET_PRIORITY_MIN, duplicate: TICKET_DUPLICATE_MIN };

export function ticketDecide(input: TicketCardInput, answers: Record<string, JevAnswer | null>, mins: TicketMins = TICKET_MINS): TicketDecision {
  const req = ticketRequest(input);
  const asked = req ? Object.keys(req.questions) : [];
  const unanswered = asked.length > 0 && asked.every((k) => !answers[k]);
  const out: TicketSuggestion[] = [];

  const cat = input.askCategory ? pOf(answers.category) : null;
  if (cat && (TICKET_CATEGORIES as readonly string[]).includes(cat.choice) && cat.choice !== "other" && cat.choice !== input.category && cat.p >= mins.category) {
    const reason = wordsEvidence(input, CATEGORY_WORDS[cat.choice as TicketCategory]);
    if (reason) out.push({ kind: "ticket.category", value: cat.choice, confidence: cat.p, reason, cites: [] });
  }

  const pri = input.askPriority ? pOf(answers.priority) : null;
  if (pri && (TICKET_PRIORITIES as readonly string[]).includes(pri.choice) && pri.choice !== input.priority && pri.p >= mins.priority) {
    const reason = wordsEvidence(input, PRIORITY_WORDS[pri.choice as TicketPriority]);
    if (reason) out.push({ kind: "ticket.priority", value: pri.choice, confidence: pri.p, reason, cites: [] });
  }

  const dup = pOf(answers.duplicate);
  const offered = input.candidates.slice(0, DUPLICATE_CANDIDATES);
  // Only a ticket that was OFFERED: an option outside the list is never a suggestion, whatever came back.
  const c = dup && dup.choice !== NONE ? offered.find((x) => candidateKey(x.number) === dup.choice) ?? null : null;
  if (c && dup && dup.p >= mins.duplicate) {
    const shared = sharedWords(`${input.title} ${input.body}`, `${c.title} ${c.body}`);
    const snippet = snippetEvidence(c.snippet);
    const reason = shared.length >= 2 ? `both mention ${quoteList(shared)}` : snippet ? `#${c.number} says ${snippet}` : shared.length ? `both mention ${quoteList(shared)}` : "";
    if (reason) {
      out.push({
        kind: "ticket.duplicate",
        value: { number: c.number, label: `#${c.number} ${excerptOf(c.title, 80)}` },
        confidence: dup.p,
        reason,
        cites: [{ ref: `ticket:${c.number}`, label: `#${c.number}`, href: `#tickets/${c.number}` }],
      });
    }
  }
  return { unanswered, suggestions: out };
}

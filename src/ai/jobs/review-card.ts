// THE REVIEW CARD (Phase C, `review.risk`): one Jev `choice` about a doc proposal or a drafted decision waiting in
// Review — does it change a decision, contradict a doc, change a process, or is it routine? Pure, like the ticket
// card (the eval runner and the recorded-response test build the same request and decide the same way).
//
// The answer is a SUGGESTION shown on the Review card, never an action: nothing here promotes, rejects or ratifies,
// and `routine` writes nothing at all (the card shows nothing). The reason is the item's OWN words (the lines it
// removes and adds, the decision it records) and, for "contradicts a doc" / "changes a decision", the related live
// doc or ratified decision the full-text index found — cited, never written by the model.
import type { AiCite } from "@shared/ai-core";
import type { JevAnswer } from "../client";
import type { JevRequest } from "../jobs";
import { excerptOf, quoted } from "./text";

export const REVIEW_PROMPT_VERSION = "jev-risk-1";
/** Write a risk only at or above this probability (chosen on the eval set: test/ai-evals/review.risk/). */
export const REVIEW_RISK_MIN = 0.6;

export const REVIEW_RISKS = ["decision", "contradicts", "process", "routine"] as const;
export type ReviewRisk = (typeof REVIEW_RISKS)[number];
/** What a risk reads as on the card. */
export const REVIEW_RISK_LABEL: Record<Exclude<ReviewRisk, "routine">, string> = {
  decision: "Changes a decision",
  contradicts: "Contradicts a doc",
  process: "Changes a process",
};
export const RISK_CRITERIA: Record<ReviewRisk, string> = {
  decision: "It changes, reverses or replaces a decision the team already made: a chosen approach, a rule, a ruling",
  contradicts: "It says something that contradicts what a live doc says is true, or removes what a doc relies on",
  process: "It changes how people work: a workflow, a step, a policy, who does what or when",
  routine: "Routine: it adds detail, documents something new, or fixes wording, without changing what was agreed",
};

export interface RelatedDoc { slug: string; title: string; snippet: string | null }
export interface RelatedDecision { id: number; title: string; snippet: string | null }

export type ReviewCardInput =
  | {
      type: "doc";
      ref: string; // "doc:<slug>@<version>" — Review's own id for the item
      title: string;
      section: string;
      changeKind: "new" | "edit" | "rewrite" | null;
      summary: string | null;
      removed: string[];
      added: string[];
      docs: RelatedDoc[];
      decisions: RelatedDecision[];
    }
  | {
      type: "adr";
      ref: string; // "adr:<id>"
      title: string;
      context: string;
      decision: string;
      rationale: string;
      docs: RelatedDoc[];
      decisions: RelatedDecision[];
    };

/** Lines of `b` not in `a` (as a set of trimmed, non-empty lines), in `b`'s order. */
export function linesNotIn(a: string, b: string): string[] {
  const have = new Set(a.split("\n").map((l) => l.trim()).filter(Boolean));
  return b.split("\n").map((l) => l.trim()).filter((l) => l && !have.has(l));
}

const lines = (xs: readonly string[], max: number): string => {
  const out: string[] = [];
  let n = 0;
  for (const l of xs) {
    const t = excerptOf(l, 200);
    if (!t) continue;
    if (n + t.length > max) break;
    out.push(`- ${t}`);
    n += t.length;
  }
  return out.join("\n");
};

export function reviewRequest(input: ReviewCardInput): JevRequest {
  const related = [
    ...input.docs.map((d) => `the live doc “${excerptOf(d.title, 100)}”`),
    ...input.decisions.map((d) => `the ratified decision “${excerptOf(d.title, 100)}”`),
  ];
  const parts: string[] = input.type === "doc"
    ? [
        `A proposed ${input.changeKind === "new" ? "new doc" : input.changeKind === "rewrite" ? "rewrite of the doc" : "edit to the doc"} “${excerptOf(input.title, 140)}” (section ${input.section}).`,
        input.summary ? `Summary: ${excerptOf(input.summary, 300)}` : "",
        input.removed.length ? `Removes:\n${lines(input.removed, 700)}` : "",
        input.added.length ? `Adds:\n${lines(input.added, 900)}` : "",
      ]
    : [
        `A drafted decision record “${excerptOf(input.title, 140)}”.`,
        input.context ? `Context: ${excerptOf(input.context, 500)}` : "",
        input.decision ? `Decision: ${excerptOf(input.decision, 600)}` : "",
        input.rationale ? `Rationale: ${excerptOf(input.rationale, 400)}` : "",
      ];
  if (related.length) parts.push(`Related: ${related.join("; ")}.`);
  return {
    state: parts.filter(Boolean).join("\n\n"),
    questions: { risk: { type: "choice", instructions: "What does this change do to what the team has agreed?", criteria: { ...RISK_CRITERIA } } },
  };
}

export interface ReviewSuggestion { kind: "review.risk"; value: { risk: ReviewRisk; label: string }; confidence: number; reason: string; cites: AiCite[] }
export interface ReviewDecision { unanswered: boolean; suggestion: ReviewSuggestion | null }

/** The item's own words, as evidence. */
function ownWords(input: ReviewCardInput): string {
  if (input.type === "adr") {
    const d = quoted(input.decision || input.title, 110);
    return d ? `It decides ${d}` : "";
  }
  const gone = input.removed.find((l) => excerptOf(l, 200));
  const now = input.added.find((l) => excerptOf(l, 200));
  if (gone && now) return `It replaces ${quoted(gone, 70)} with ${quoted(now, 70)}`;
  if (gone) return `It removes ${quoted(gone, 110)}`;
  if (now) return `It adds ${quoted(now, 110)}`;
  return input.summary ? `Its summary says ${quoted(input.summary, 110)}` : "";
}

export function reviewDecide(input: ReviewCardInput, answers: Record<string, JevAnswer | null>): ReviewDecision {
  const a = answers.risk;
  if (!a || a.type !== "choice") return { unanswered: true, suggestion: null };
  const risk = a.choice as ReviewRisk;
  const p = a.probabilities[a.choice] ?? 0;
  if (!(REVIEW_RISKS as readonly string[]).includes(risk) || risk === "routine" || p < REVIEW_RISK_MIN) return { unanswered: false, suggestion: null };
  const words = ownWords(input);
  if (!words) return { unanswered: false, suggestion: null };
  const cites: AiCite[] = [];
  let reason = words;
  if (risk === "decision" && input.decisions[0]) {
    const d = input.decisions[0];
    reason += `; the ratified decision “${excerptOf(d.title, 80)}” covers the same ground`;
    cites.push({ ref: `adr:${d.id}`, label: `ADR-${String(d.id).padStart(3, "0")}`, href: null });
  } else if (risk === "contradicts" && input.docs[0]) {
    const d = input.docs[0];
    reason += `; the live doc “${excerptOf(d.title, 80)}” covers the same ground`;
    cites.push({ ref: `doc:${d.slug}`, label: excerptOf(d.title, 60), href: null });
  }
  return { unanswered: false, suggestion: { kind: "review.risk", value: { risk, label: REVIEW_RISK_LABEL[risk] }, confidence: p, reason, cites } };
}

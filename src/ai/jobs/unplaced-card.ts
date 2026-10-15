// THE UNPLACED CARD (Phase C, `unplaced.destination`): where does a doc an agent could not place belong? ONE Jev
// `choice` over the CANDIDATES only — the vocabulary's sections (`SECTIONS`, never `needs-triage`) and the top
// full-text docs of this org ("next to the doc …", each standing for its own section). Pure, like the other cards.
//
// The answer is a SUGGESTION. Accepting it files the item exactly as Unplaced's "File it" does — the triage assign
// (`assign_triage`, src/tools/writes.ts: the SAME gate, as the person who pressed Accept) as a doc in the picked
// section. A doc candidate places the item in THAT DOC'S SECTION: the assign files by section, it has no "into this
// doc" (it re-runs the item under its own slug). The probability of a section is its own option's plus its docs'
// (one section, several ways to say it). The reason is Trov's evidence: the words the item shares with that doc (its
// full-text snippet), or the section the agent filed it under — never model text.
import { SECTIONS } from "@shared/vocabulary";
import type { AiCite } from "@shared/ai-core";
import type { JevAnswer } from "../client";
import type { JevRequest } from "../jobs";
import { excerptOf, quoted, snippetEvidence } from "./text";

export const UNPLACED_PROMPT_VERSION = "jev-place-1";
/** Write a destination only at or above this probability (chosen on the eval set: test/ai-evals/unplaced.destination/). */
export const UNPLACED_DESTINATION_MIN = 0.55;
/** Docs offered beside the sections: the top three full-text hits. */
export const UNPLACED_DOC_CANDIDATES = 3;

/** The sections an item may be filed in: the vocabulary's, less the queue itself. */
export const PLACEABLE_SECTIONS = SECTIONS.filter((s) => s !== "needs-triage");
export type PlaceableSection = (typeof PLACEABLE_SECTIONS)[number];

export const SECTION_CRITERIA: Record<PlaceableSection, string> = {
  reference: "Reference: how something works or how to use it — a system, an API, a setup, a runbook, a guide",
  context: "Context: background — the product, the team, the goals, the history, why things are the way they are",
  decisions: "Decisions: a decision and its reasons — what was chosen, the alternatives, the trade-offs",
};

export interface UnplacedDoc { slug: string; title: string; section: string; body: string; snippet: string | null }

export interface UnplacedCardInput {
  id: number;
  title: string;
  body: string;
  /** The section the agent sent (outside the vocabulary, or a real one sent with low confidence), or null. */
  filedUnder: string | null;
  docs: UnplacedDoc[];
}

const docKey = (i: number): string => `doc_${i + 1}`;

/** The docs offered: the top hits that sit in a placeable section. */
const offeredDocs = (input: UnplacedCardInput): UnplacedDoc[] =>
  input.docs.filter((d) => (PLACEABLE_SECTIONS as readonly string[]).includes(d.section)).slice(0, UNPLACED_DOC_CANDIDATES);

export function unplacedRequest(input: UnplacedCardInput): JevRequest {
  const criteria: Record<string, string> = { ...SECTION_CRITERIA };
  offeredDocs(input).forEach((d, i) => {
    criteria[docKey(i)] = `Next to the existing doc “${excerptOf(d.title, 100)}” (section ${d.section}): ${excerptOf(d.body, 120)}`;
  });
  const state = [
    `A doc an agent wrote: “${excerptOf(input.title, 200)}”.`,
    input.filedUnder ? `The agent filed it under “${excerptOf(input.filedUnder, 60)}”.` : "",
    excerptOf(input.body, 1200),
  ].filter(Boolean).join("\n\n");
  return { state, questions: { destination: { type: "choice", instructions: "Where does this doc belong?", criteria } } };
}

export interface UnplacedValue { type: "doc"; section: PlaceableSection; near: string | null; label: string }
export interface UnplacedSuggestion { kind: "unplaced.destination"; value: UnplacedValue; confidence: number; reason: string; cites: AiCite[] }
export interface UnplacedDecision { unanswered: boolean; suggestion: UnplacedSuggestion | null }

export function unplacedDecide(input: UnplacedCardInput, answers: Record<string, JevAnswer | null>, min: number = UNPLACED_DESTINATION_MIN): UnplacedDecision {
  const a = answers.destination;
  if (!a || a.type !== "choice") return { unanswered: true, suggestion: null };
  const docs = offeredDocs(input);
  // Each OFFERED option → its section. Anything else counts for nothing.
  const sectionOf = new Map<string, PlaceableSection>(PLACEABLE_SECTIONS.map((s) => [s, s]));
  docs.forEach((d, i) => sectionOf.set(docKey(i), d.section as PlaceableSection));
  const mass = new Map<PlaceableSection, number>();
  for (const [opt, p] of Object.entries(a.probabilities)) {
    const s = sectionOf.get(opt);
    if (s) mass.set(s, (mass.get(s) ?? 0) + p);
  }
  let best: PlaceableSection | null = null;
  let bestP = 0;
  for (const [s, p] of mass) if (p > bestP) { best = s; bestP = p; }
  if (!best || bestP < min) return { unanswered: false, suggestion: null };
  // The doc that speaks for this section most strongly, if one was offered.
  let near: UnplacedDoc | null = null;
  let nearP = 0;
  docs.forEach((d, i) => {
    const p = a.probabilities[docKey(i)] ?? 0;
    if (d.section === best && p > nearP) { near = d; nearP = p; }
  });
  const n = near as UnplacedDoc | null;
  const snippet = n ? snippetEvidence(n.snippet) : null;
  const reason = n && snippet
    ? `it mentions ${snippet}, like the doc “${excerptOf(n.title, 80)}” in ${best}`
    : input.filedUnder
      ? `the agent filed it under “${excerptOf(input.filedUnder, 60)}”${(PLACEABLE_SECTIONS as readonly string[]).includes(input.filedUnder) ? "" : " (not a section)"}; it reads ${quoted(input.title, 80)}`
      : quoted(input.title, 100) ? `it reads ${quoted(input.title, 100)}` : "";
  if (!reason) return { unanswered: false, suggestion: null };
  return {
    unanswered: false,
    suggestion: {
      kind: "unplaced.destination",
      value: { type: "doc", section: best, near: n ? n.slug : null, label: n ? `${best}, next to “${excerptOf(n.title, 60)}”` : best },
      confidence: Math.min(1, bestP),
      reason,
      cites: n ? [{ ref: `doc:${n.slug}`, label: excerptOf(n.title, 60), href: null }] : [],
    },
  };
}

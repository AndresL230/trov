// The brief's grading RULES (no model judges a model): what an answer must do, checked against the input it was
// given. `gradeAnswer` grades the MODEL's raw answer (how good the prompt is); the CI test also grades what the
// SERVER keeps of it (`briefFromAnswer`), which must pass every rule whatever the model said.
import type { AiBrief } from "@shared/ai";
import { BRIEF_LINE_MAX, BRIEF_NEXT_MAX, BRIEF_WHY_MAX, REF_IN_TEXT, briefPromptInput, numbersGrounded, oneSentence, type BriefAnswer, type BriefInput } from "../../../src/ai/brief-core";

export const RULES = [
  "cites_in_input",      // every cite of now / recently is a ref of the input
  "next_offered_only",   // every Next ref the answer names was offered
  "next_server_order",   // …and they come in the server's order
  "next_covered",        // a why for every offered item
  "numbers_grounded",    // no number the input does not have, in digits or words (now, recently, every why)
  "no_refs_in_text",     // a ref (pr:12, feed:107) only in cites, never in a sentence
  "length",              // now / recently ≤ BRIEF_LINE_MAX, a why ≤ BRIEF_WHY_MAX
  "one_shape",           // BR-OWNER-1: now / recently ONE sentence each, Next at most BRIEF_NEXT_MAX
  "null_when_nothing",   // now / recently null when the input has nothing for them
  "written_when_material", // now / recently written (with a cite) when the input has something for them
] as const;
export type Rule = (typeof RULES)[number];
export type Grade = Record<Rule, boolean>;

type Line = { text: string; cites: string[] } | null | undefined;

function grade(b: BriefInput, now: Line, recently: Line, next: { ref: string; why: string }[]): Grade {
  const input = briefPromptInput(b);
  const offered = b.next.map((o) => o.ref);
  const named = next.map((n) => n.ref);
  const lines = [now, recently].filter((l): l is { text: string; cites: string[] } => !!l);
  const nowMaterial = b.now.prs.length > 0 || !!b.now.status;
  const recentMaterial = b.recently.cards.length > 0 || b.recently.notes.length > 0;
  const order = named.filter((r) => offered.includes(r)).map((r) => offered.indexOf(r));
  const has = (l: Line) => !!l && l.text.trim().length > 0 && l.cites.some((c) => Object.hasOwn(b.cites, c));
  return {
    cites_in_input: lines.every((l) => l.cites.every((c) => Object.hasOwn(b.cites, c))),
    next_offered_only: named.every((r) => offered.includes(r)),
    next_server_order: order.every((v, i) => i === 0 || v > order[i - 1]),
    next_covered: offered.every((r) => next.some((n) => n.ref === r && n.why.trim().length > 0)),
    numbers_grounded: [...lines.map((l) => l.text), ...next.map((n) => n.why)].every((t) => numbersGrounded(t, input)),
    no_refs_in_text: [...lines.map((l) => l.text), ...next.map((n) => n.why)].every((t) => !REF_IN_TEXT.test(t)),
    length: lines.every((l) => l.text.length <= BRIEF_LINE_MAX) && next.every((n) => n.why.length <= BRIEF_WHY_MAX),
    one_shape: lines.every((l) => oneSentence(l.text.trim())) && next.length <= BRIEF_NEXT_MAX,
    null_when_nothing: (nowMaterial || !now) && (recentMaterial || !recently),
    written_when_material: (!nowMaterial || has(now)) && (!recentMaterial || has(recently)),
  };
}

/** The model's raw answer (as parsed from its JSON, before any server check). */
export function gradeAnswer(b: BriefInput, a: BriefAnswer): Grade {
  return grade(b, a.now, a.recently, (a.next ?? []).filter((n): n is { ref: string; why: string } => !!n && typeof n === "object"));
}

/** What the server stored from it. */
export function gradeKept(b: BriefInput, c: Pick<AiBrief, "now" | "recently" | "next">): Grade {
  const line = (l: AiBrief["now"]): Line => (l ? { text: l.text, cites: l.cites.map((x) => x.ref) } : null);
  return grade(b, line(c.now), line(c.recently), c.next.items.map((i) => ({ ref: i.ref, why: i.why })));
}

export const score = (g: Grade): number => RULES.filter((r) => g[r]).length / RULES.length;

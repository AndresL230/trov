// The weekly highlights' grading RULES (no model judges a model): what an answer must do, checked against the week it
// was given. `gradeAnswer` grades the MODEL's raw answer (how good the prompt is); the CI test also grades what the
// SERVER keeps of it (`weekFromAnswer`), which must pass every rule whatever the model said.
import type { AiLine } from "@shared/ai";
import { REF_IN_TEXT, numbersGrounded } from "../../../src/ai/brief-core";
import { WEEK_HIGHLIGHTS_MAX, WEEK_LINE_MAX, weekPromptInput, type WeekAnswer, type WeekInput } from "../../../src/ai/week-core";

export const RULES = [
  "cites_in_input",        // every cite is a ref of the input
  "at_most_3",             // at most WEEK_HIGHLIGHTS_MAX highlights
  "numbers_grounded",      // no number the input does not have, in digits or words
  "no_ref_in_text",        // a ref (pr:12, feed:107) only in cites, never in a sentence
  "length_ok",             // every highlight ≤ WEEK_LINE_MAX, and not empty
  "breaking_first",        // with a breaking item in the week, the first highlight cites one
  "written_when_material", // at least one highlight (with a valid cite) when the week has a notable / breaking item or a merged PR
] as const;
export type Rule = (typeof RULES)[number];
export type Grade = Record<Rule, boolean>;

interface Line { text: string; cites: string[] }

function grade(w: WeekInput, lines: Line[]): Grade {
  const input = weekPromptInput(w);
  const breaking = new Set(w.items.filter((i) => i.importance === "breaking").map((i) => i.ref));
  const material = w.items.some((i) => i.kind === "pr" || i.importance === "notable" || i.importance === "breaking");
  return {
    cites_in_input: lines.every((l) => l.cites.every((c) => Object.hasOwn(w.cites, c))),
    at_most_3: lines.length <= WEEK_HIGHLIGHTS_MAX,
    numbers_grounded: lines.every((l) => numbersGrounded(l.text, input)),
    no_ref_in_text: lines.every((l) => !REF_IN_TEXT.test(l.text)),
    length_ok: lines.every((l) => l.text.trim().length > 0 && l.text.length <= WEEK_LINE_MAX),
    breaking_first: !breaking.size || (lines.length > 0 && lines[0].cites.some((c) => breaking.has(c))),
    written_when_material: !material || lines.some((l) => l.text.trim().length > 0 && l.cites.some((c) => Object.hasOwn(w.cites, c))),
  };
}

/** The model's raw answer (as parsed from its JSON, before any server check). */
export function gradeAnswer(w: WeekInput, a: Partial<WeekAnswer>): Grade {
  return grade(w, (a.highlights ?? []).filter((h): h is Line => !!h && typeof h === "object" && typeof h.text === "string" && Array.isArray(h.cites)));
}

/** What the server stores from it. */
export function gradeKept(w: WeekInput, lines: AiLine[]): Grade {
  return grade(w, lines.map((l) => ({ text: l.text, cites: l.cites.map((c) => c.ref) })));
}

export const score = (g: Grade): number => RULES.filter((r) => g[r]).length / RULES.length;

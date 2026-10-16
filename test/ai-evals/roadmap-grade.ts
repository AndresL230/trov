// The rule grades of the Roadmap and doc-drift evals — shared by the live run (./run-live-roadmap.mjs) and the
// replay (test/ai.evals-roadmap.test.ts). They grade the model's RAW answer (before the job's own checks drop
// anything), so a score says how often the model keeps the rules, not only how often the server catches it:
//   • cites valid — every ref it named was one the server offered;
//   • numbers given — every number it wrote was one the input stated (src/ai/grounding.ts);
//   • finds exact (doc.drift) — every passage it quoted occurs in the doc exactly once.
// A case is RIGHT when the job's own rule keeps the line (notes, drift), or when the doc.drift answer agrees with
// the label and, for a disagreement, leaves a proposal the server would stage.
import type { AiCite } from "@shared/ai";
import { numbersGiven } from "../../src/ai/grounding";

interface Grounded { offered: ReadonlyMap<string, AiCite>; allowed: ReadonlySet<string> }
interface DriftEdit { find: string; replace: string; cites: string[] }
interface DriftAnswer { disagrees?: boolean; edits?: DriftEdit[]; summary?: string }

export interface DocDriftGrade {
  right: boolean;
  disagrees: boolean | null;
  proposals: number;
  edits: number;
  citesNamed: number;
  citesValid: number;
  numbersOk: number;
  findsExact: number;
  summary: string | null;
}

const once = (body: string, find: string): boolean => {
  const at = body.indexOf(find);
  return at >= 0 && body.indexOf(find, at + 1) < 0;
};

export function gradeDocDrift<I extends Grounded & { body: string }>(
  input: I,
  answer: DriftAnswer | null,
  expected: boolean,
  apply: (i: I, a: DriftAnswer) => { body: string } | null,
): DocDriftGrade {
  if (!answer) return { right: false, disagrees: null, proposals: 0, edits: 0, citesNamed: 0, citesValid: 0, numbersOk: 0, findsExact: 0, summary: null };
  const edits = answer.edits ?? [];
  const named = edits.flatMap((e) => e.cites);
  const proposal = apply(input, answer);
  const disagrees = answer.disagrees ?? null;
  return {
    right: expected ? disagrees === true && !!proposal : disagrees === false || !proposal,
    disagrees,
    proposals: proposal ? 1 : 0,
    edits: edits.length,
    citesNamed: named.length,
    citesValid: named.filter((r) => input.offered.has(String(r).trim())).length,
    numbersOk: edits.filter((e) => numbersGiven(e.replace, input.allowed)).length,
    findsExact: edits.filter((e) => once(input.body, e.find)).length,
    summary: answer.summary ?? null,
  };
}

export interface LineGrade { kept: boolean; citesNamed: number; citesValid: number; numbersOk: boolean }

export function gradeLine<I extends Grounded>(
  input: I,
  line: { text: string; cites: string[] } | null,
  check: (i: I, l: { text: string; cites: string[] }) => unknown,
): LineGrade {
  if (!line) return { kept: false, citesNamed: 0, citesValid: 0, numbersOk: false };
  return {
    kept: check(input, line) !== null,
    citesNamed: line.cites.length,
    citesValid: line.cites.filter((r) => input.offered.has(String(r).trim())).length,
    numbersOk: numbersGiven(line.text, input.allowed),
  };
}

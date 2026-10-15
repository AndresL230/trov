// THE BRIEF's eval set in CI (test/ai-evals/brief.person/): the RECORDED live answers (recorded.json, written by
// scripts/ai-evals/brief-live.ts against claude-haiku-5-5) replayed through the answer's schema and the server's
// checks — no network. The raw answers must still grade as they did live (the prompt's quality, pinned), and what
// the SERVER keeps of any answer — recorded or made worse on purpose — must keep every safety rule.
import { describe, it, expect } from "vitest";
import { BRIEF_PROMPT_VERSION, BriefAnswerSchema, briefFromAnswer, orderNext, type BriefAnswer, type BriefInput } from "../src/ai/brief-core";
import { keep } from "../src/ai/sections";
import { BRIEF_CASES } from "./ai-evals/brief.person/cases";
import { RULES, gradeAnswer, gradeKept, score, type Rule } from "./ai-evals/brief.person/grade";
import recorded from "./ai-evals/brief.person/recorded.json";

/** What the server must ALWAYS hold, whatever the model said ("written_when_material" is the model's job). */
const SAFETY: Rule[] = RULES.filter((r) => r !== "written_when_material");
const parse = (text: string): Partial<BriefAnswer> => {
  const r = BriefAnswerSchema.safeParse(JSON.parse(text));
  if (!r.success) throw new Error("schema");
  return keep(r.data).kept;
};
const full = (a: Partial<BriefAnswer>): BriefAnswer => ({ now: a.now ?? null, recently: a.recently ?? null, next: a.next ?? [] });
const cases = recorded.cases as Record<string, { stop_reason: string | null; text: string }>;

describe("brief.person eval set", () => {
  it("has at least 8 real cases, each Next already in the server's order, each recorded for this prompt version", () => {
    expect(BRIEF_CASES.length).toBeGreaterThanOrEqual(8);
    expect(recorded.promptVersion).toBe(BRIEF_PROMPT_VERSION);
    for (const c of BRIEF_CASES) {
      expect(orderNext(c.input.next).map((o) => o.ref), c.id).toEqual(c.input.next.map((o) => o.ref));
      expect(cases[c.id], c.id).toBeDefined();
    }
  });

  for (const c of BRIEF_CASES) {
    it(`${c.id}: the recorded answer grades 1.0, and what the server keeps keeps every rule`, () => {
      const rec = cases[c.id];
      expect(rec.stop_reason).toBe("end_turn");
      const a = parse(rec.text);
      expect(score(gradeAnswer(c.input, full(a)))).toBe(1);
      const kept = gradeKept(c.input, briefFromAnswer(c.input, a));
      for (const r of RULES) expect(kept[r], `${c.id} ${r}`).toBe(true);
    });
  }

  it("an answer made worse on purpose — invented cites, unoffered and reversed Next, refs and numbers in the text, too long — keeps every safety rule once the server has it", () => {
    const worsen = (b: BriefInput, a: BriefAnswer): BriefAnswer => ({
      now: { text: `You fixed 42 bugs on pr:${b.now.prs[0]?.ref ?? "1"}.`, cites: ["pr:99999", ...(a.now?.cites ?? [])] },
      recently: { text: "x".repeat(500), cites: ["feed:1"] },
      next: [{ ref: "ticket:99999", why: "Invented." }, ...[...a.next].reverse().map((n) => ({ ...n, why: `${n.why} Due in 37 days.` }))],
    });
    for (const c of BRIEF_CASES) {
      const bad = worsen(c.input, full(parse(cases[c.id].text)));
      const raw = gradeAnswer(c.input, bad);
      expect(raw.cites_in_input && raw.next_offered_only && raw.numbers_grounded, c.id).toBe(false); // it IS worse
      const kept = gradeKept(c.input, briefFromAnswer(c.input, bad));
      for (const r of SAFETY) expect(kept[r], `${c.id} ${r}`).toBe(true);
    }
  });
});

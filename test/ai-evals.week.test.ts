// THE WEEKLY HIGHLIGHTS' eval set in CI (test/ai-evals/digest.week/): the RECORDED live answers (recorded.json, written
// by scripts/ai-evals/week-live.ts against claude-haiku-5-5) replayed through the answer's schema and the server's
// checks — no network. The raw answers must still grade as they did live (the prompt's quality, pinned), and what
// the SERVER keeps of any answer — recorded or made worse on purpose — must keep every safety rule. One recorded
// answer also goes the whole way the pass reads a batch answer: a Message Batches results file stubbed at the
// `Response` level, read by THE client's `batchResults` + `answer`.
import { describe, it, expect } from "vitest";
import { WEEK_HIGHLIGHTS_MAX, WEEK_PROMPT_VERSION, WeekAnswerSchema, orderWeekItems, weekFromAnswer, type WeekAnswer, type WeekInput } from "../src/ai/week-core";
import { weekJob } from "../src/ai/week";
import { providerFor } from "../src/ai/client";
import { keep } from "../src/ai/sections";
import { WEEK_CASES } from "./ai-evals/digest.week/cases";
import { RULES, gradeAnswer, gradeKept, score, type Rule } from "./ai-evals/digest.week/grade";
import { FAKE_ANTHROPIC_KEY } from "./helpers/anthropic";
import { stubProviders, succeededLine } from "./helpers/ai-pass";
import recorded from "./ai-evals/digest.week/recorded.json";

/** What the server must ALWAYS hold, whatever the model said ("written_when_material" and "breaking_first" are the
 *  model's job: the server can drop a highlight, never write or reorder one). */
const SAFETY: Rule[] = RULES.filter((r) => r !== "written_when_material" && r !== "breaking_first");
const parse = (text: string): Partial<WeekAnswer> => {
  const r = WeekAnswerSchema.safeParse(JSON.parse(text));
  if (!r.success) throw new Error("schema");
  return keep(r.data).kept;
};
const cases = recorded.cases as Record<string, { stop_reason: string | null; text: string; usage: { inputTokens: number; outputTokens: number } | null }>;

describe("digest.week eval set", () => {
  it("has at least 15 real cases, each in the server's order, each recorded for this prompt version", () => {
    expect(WEEK_CASES.length).toBeGreaterThanOrEqual(15);
    expect(new Set(WEEK_CASES.map((c) => c.id)).size).toBe(WEEK_CASES.length);
    expect(recorded.promptVersion).toBe(WEEK_PROMPT_VERSION);
    for (const c of WEEK_CASES) {
      expect(orderWeekItems(c.input.items).map((i) => i.ref), c.id).toEqual(c.input.items.map((i) => i.ref));
      for (const i of c.input.items) expect(c.input.cites[i.ref], `${c.id} ${i.ref}`).toBeDefined();
      expect(cases[c.id], c.id).toBeDefined();
    }
  });

  for (const c of WEEK_CASES) {
    it(`${c.id}: the recorded answer grades 1.0, and what the server keeps keeps every rule`, () => {
      const rec = cases[c.id];
      expect(rec.stop_reason).toBe("end_turn");
      const a = parse(rec.text);
      expect(score(gradeAnswer(c.input, a))).toBe(1);
      const kept = gradeKept(c.input, weekFromAnswer(c.input, a));
      for (const r of RULES) expect(kept[r], `${c.id} ${r}`).toBe(true);
    });
  }

  it("an answer made worse on purpose — invented cites, refs and unknown numbers in the text, five highlights, over-long — keeps every safety rule once the server has it", () => {
    const worsen = (w: WeekInput, a: Partial<WeekAnswer>): WeekAnswer => {
      const real = Object.keys(w.cites)[0];
      return {
        highlights: [
          { text: "The team fixed 4242 bugs this week.", cites: [real] },
          { text: `Shipped ${real} to everyone.`, cites: [real] },
          { text: "Invented work landed.", cites: ["pr:99999"] },
          { text: "x".repeat(400), cites: [real] },
          ...(a.highlights ?? []),
          { text: "A sixth line.", cites: [real] },
        ],
      };
    };
    for (const c of WEEK_CASES) {
      const bad = worsen(c.input, parse(cases[c.id].text));
      const raw = gradeAnswer(c.input, bad);
      expect(raw.cites_in_input && raw.numbers_grounded && raw.no_ref_in_text && raw.at_most_3 && raw.length_ok, c.id).toBe(false); // it IS worse
      const lines = weekFromAnswer(c.input, bad);
      expect(lines.length, c.id).toBeLessThanOrEqual(WEEK_HIGHLIGHTS_MAX);
      const kept = gradeKept(c.input, lines);
      for (const r of SAFETY) expect(kept[r], `${c.id} ${r}`).toBe(true);
    }
  });

  it("a recorded answer read the way the pass reads a batch: a results file stubbed at the Response level, through THE client's batchResults + answer, then the server's checks", async () => {
    const c = WEEK_CASES.find((x) => x.id === "breaking-leads")!;
    const stub = stubProviders();
    stub.batch = { id: "msgbatch_week1", ended: true, results: [succeededLine("org_a__digest__week.1__0", cases[c.id].text)] };
    const provider = providerFor("digest.week", { apiKey: FAKE_ANTHROPIC_KEY, fetchImpl: stub.fetchImpl })!;
    const results = await provider.batchResults("msgbatch_week1");
    expect(results).toHaveLength(1);
    expect(stub.batchResults).toBe(1);
    const r = results![0];
    expect(r.type).toBe("succeeded");
    const ans = provider.answer({ kind: weekJob.kind as "digest.week", schema: weekJob.schema }, r.type === "succeeded" ? r.message : null);
    expect(ans).not.toBeNull();
    const lines = weekFromAnswer(c.input, keep(ans!.value).kept);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0].cites.map((x) => x.ref)).toContain("pr:111"); // the breaking change leads
    expect(lines.every((l) => l.cites.every((x) => x.href))).toBe(true); // every cite is the server's, with its link
    // A refusal in the same file is no answer, never a guess.
    stub.batch.results = [{ custom_id: "x", result: { type: "succeeded", message: { ...(succeededLine("x", "{}").result as { message: Record<string, unknown> }).message, stop_reason: "refusal" } } }];
    const refused = (await provider.batchResults("msgbatch_week1"))![0];
    expect(provider.answer({ kind: "digest.week", schema: weekJob.schema }, refused.type === "succeeded" ? refused.message : null)).toBeNull();
  });
});

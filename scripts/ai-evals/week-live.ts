// THE WEEKLY HIGHLIGHTS' live eval (`digest.week`): every case of test/ai-evals/digest.week/cases.ts sent to Claude
// EXACTLY as the AI pass sends it — THE client (src/ai/client.ts `providerFor`), the system prompt, the cached org
// prefix (src/ai/prefix.ts `renderPrefix`), the scope's input and the answer's schema (src/ai/week-core.ts) — then
// graded by the rules (test/ai-evals/digest.week/grade.ts). It writes the raw answers to
// test/ai-evals/digest.week/recorded.json, which the CI test replays (test/ai-evals.week.test.ts).
//
// The pass sends this job through the Message Batches API (`batch: true`): the SAME request body (`messageParams`),
// answered at half the price, read back by the same `answer` path. This runner calls it directly so a run takes
// seconds, not up to an hour; the tokens it prints are the batch's tokens (the batch halves the price, not the count).
//
// NEVER part of the suite, and it spends real money (well under $0.01 a run). Run by hand:
//   npx esbuild scripts/ai-evals/week-live.ts --bundle --platform=node --format=esm --packages=external \
//     --alias:@shared=./shared --outfile=.week-live.tmp.mjs && ANTHROPIC_API_KEY=… node .week-live.tmp.mjs; rm .week-live.tmp.mjs
// (the bundle sits in the repository so its external packages resolve from node_modules)
// The key comes from the environment only; nothing here prints or stores it.
import { writeFileSync } from "node:fs";
import { providerFor, CLAUDE_MODEL, type AiUsage } from "../../src/ai/client";
import { renderPrefix } from "../../src/ai/prefix";
import { WEEK_PROMPT_VERSION, WEEK_SYSTEM, WeekAnswerSchema, weekFromAnswer, weekPromptInput } from "../../src/ai/week-core";
import { keep } from "../../src/ai/sections";
import { WEEK_CASES } from "../../test/ai-evals/digest.week/cases";
import { EVAL_PREFIX_PARTS } from "../../test/ai-evals/brief.person/cases";
import { RULES, gradeAnswer, gradeKept, score } from "../../test/ai-evals/digest.week/grade";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) { console.error("week-live: set ANTHROPIC_API_KEY"); process.exit(1); }
const out = process.argv[2] ?? "test/ai-evals/digest.week/recorded.json";
const MAX_TOKENS = 1000; // = weekJob.maxTokens (src/ai/week.ts)

interface Recorded { stop_reason: string | null; text: string; usage: AiUsage | null }
const recorded: Record<string, Recorded> = {};
const prefix = renderPrefix(EVAL_PREFIX_PARTS);
let raw = 0, kept = 0, tin = 0, tout = 0, tcached = 0;

for (const c of WEEK_CASES) {
  let last: { stop_reason: string | null; text: string } = { stop_reason: null, text: "" };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await fetch(input, init);
    const body = await res.clone().json().catch(() => null) as { stop_reason?: string; content?: { type: string; text?: string }[] } | null;
    last = { stop_reason: body?.stop_reason ?? null, text: body?.content?.find((b) => b.type === "text")?.text ?? "" };
    return res;
  }) as typeof fetch;
  let usage: AiUsage | null = null;
  const provider = providerFor("digest.week", { apiKey, fetchImpl, timeoutMs: 60_000, onCall: (u) => { usage = u; } })!;
  const res = await provider.structured({
    kind: "digest.week", system: WEEK_SYSTEM, prefix, cache: true, input: weekPromptInput(c.input), schema: WeekAnswerSchema, maxTokens: MAX_TOKENS,
  });
  recorded[c.id] = { ...last, usage };
  const u = usage as AiUsage | null;
  tin += u?.inputTokens ?? 0; tout += u?.outputTokens ?? 0; tcached += u?.cachedTokens ?? 0;
  if (!res) { console.log(`${c.id}: NO ANSWER (stop_reason=${last.stop_reason})`, u ? `in=${u.inputTokens} cached=${u.cachedTokens} out=${u.outputTokens}` : ""); continue; }
  const answer = keep(res.value).kept;
  const gRaw = gradeAnswer(c.input, answer);
  const gKept = gradeKept(c.input, weekFromAnswer(c.input, answer));
  raw += score(gRaw);
  kept += score(gKept);
  const failed = RULES.filter((r) => !gRaw[r]);
  console.log(`${c.id}: raw ${score(gRaw).toFixed(2)}${failed.length ? ` (failed: ${failed.join(", ")})` : ""}; kept ${score(gKept).toFixed(2)}; ` +
    `highlights=${(answer.highlights ?? []).length} in=${u?.inputTokens} cached=${u?.cachedTokens} out=${u?.outputTokens}`);
}
console.log(`MEAN raw ${(raw / WEEK_CASES.length).toFixed(3)}  kept ${(kept / WEEK_CASES.length).toFixed(3)}  over ${WEEK_CASES.length} cases`);
console.log(`TOKENS in=${tin} cached=${tcached} out=${tout}  per case in=${Math.round(tin / WEEK_CASES.length)} out=${Math.round(tout / WEEK_CASES.length)}`);
writeFileSync(out, JSON.stringify({ kind: "digest.week", promptVersion: WEEK_PROMPT_VERSION, model: CLAUDE_MODEL, recordedAt: new Date().toISOString(), cases: recorded }, null, 2) + "\n");
console.log(`wrote ${out}`);

// THE BRIEF's live eval (`brief.person`): every case of test/ai-evals/brief.person/cases.ts sent to Claude EXACTLY as
// the AI pass sends it — THE client (src/ai/client.ts `providerFor`), the system prompt, the cached org prefix
// (src/ai/prefix.ts `renderPrefix`), the scope's input and the answer's schema (src/ai/brief-core.ts) — then graded by
// the rules (test/ai-evals/brief.person/grade.ts). It writes the raw answers to
// test/ai-evals/brief.person/recorded.json, which the CI test replays (test/ai-evals.brief.test.ts).
//
// NEVER part of the suite, and it spends real money (about $0.001 a case). Run by hand:
//   npx esbuild scripts/ai-evals/brief-live.ts --bundle --platform=node --format=esm --packages=external \
//     --alias:@shared=./shared --outfile=.brief-live.tmp.mjs && ANTHROPIC_API_KEY=… node .brief-live.tmp.mjs; rm .brief-live.tmp.mjs
// (the bundle sits in the repository so its external packages resolve from node_modules)
// The key comes from the environment only; nothing here prints or stores it.
import { writeFileSync } from "node:fs";
import { providerFor, type AiUsage } from "../../src/ai/client";
import { renderPrefix } from "../../src/ai/prefix";
import { BRIEF_PROMPT_VERSION, BRIEF_SYSTEM, BriefAnswerSchema, briefFromAnswer, briefPromptInput } from "../../src/ai/brief-core";
import { keep } from "../../src/ai/sections";
import { BRIEF_CASES, EVAL_PREFIX_PARTS } from "../../test/ai-evals/brief.person/cases";
import { RULES, gradeAnswer, gradeKept, score } from "../../test/ai-evals/brief.person/grade";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) { console.error("brief-live: set ANTHROPIC_API_KEY"); process.exit(1); }
const out = process.argv[2] ?? "test/ai-evals/brief.person/recorded.json";
const MAX_TOKENS = 2000; // = briefJob.maxTokens (src/ai/brief.ts)

interface Recorded { stop_reason: string | null; text: string; usage: AiUsage | null }
const recorded: Record<string, Recorded> = {};
const prefix = renderPrefix(EVAL_PREFIX_PARTS);
let raw = 0, kept = 0;

for (const c of BRIEF_CASES) {
  let last: { stop_reason: string | null; text: string } = { stop_reason: null, text: "" };
  // The answer as it came, before the SDK reads it: what the CI test replays.
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await fetch(input, init);
    const body = await res.clone().json().catch(() => null) as { stop_reason?: string; content?: { type: string; text?: string }[] } | null;
    last = { stop_reason: body?.stop_reason ?? null, text: body?.content?.find((b) => b.type === "text")?.text ?? "" };
    return res;
  }) as typeof fetch;
  let usage: AiUsage | null = null;
  const provider = providerFor("brief.person", { apiKey, fetchImpl, timeoutMs: 60_000, onCall: (u) => { usage = u; } })!;
  const res = await provider.structured({
    kind: "brief.person", system: BRIEF_SYSTEM, prefix, cache: true, input: briefPromptInput(c.input), schema: BriefAnswerSchema, maxTokens: MAX_TOKENS,
  });
  recorded[c.id] = { ...last, usage };
  const u = usage as AiUsage | null;
  if (!res) { console.log(`${c.id}: NO ANSWER (stop_reason=${last.stop_reason})`, u ? `in=${u.inputTokens} cached=${u.cachedTokens} out=${u.outputTokens}` : ""); continue; }
  const answer = keep(res.value).kept;
  const gRaw = gradeAnswer(c.input, { now: answer.now ?? null, recently: answer.recently ?? null, next: answer.next ?? [] });
  const gKept = gradeKept(c.input, briefFromAnswer(c.input, answer));
  raw += score(gRaw);
  kept += score(gKept);
  const failed = RULES.filter((r) => !gRaw[r]);
  console.log(`${c.id}: raw ${score(gRaw).toFixed(2)}${failed.length ? ` (failed: ${failed.join(", ")})` : ""}; kept ${score(gKept).toFixed(2)}; ` +
    `in=${u?.inputTokens} cached=${u?.cachedTokens} out=${u?.outputTokens}`);
}
console.log(`MEAN raw ${(raw / BRIEF_CASES.length).toFixed(3)}  kept ${(kept / BRIEF_CASES.length).toFixed(3)}  over ${BRIEF_CASES.length} cases`);
writeFileSync(out, JSON.stringify({ kind: "brief.person", promptVersion: BRIEF_PROMPT_VERSION, model: "claude-haiku-5-5", recordedAt: new Date().toISOString(), cases: recorded }, null, 2) + "\n");
console.log(`wrote ${out}`);

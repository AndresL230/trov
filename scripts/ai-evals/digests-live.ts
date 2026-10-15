// THE LIVE RUN of the Phase D digest evals — `gate.session`, `digest.session`, `gate.state`, `repo.state`
// (docs/architecture/ai.md › Evals). Every case of test/ai-evals/<kind>/cases.json goes out EXACTLY as the AI pass
// sends it: THE client (src/ai/client.ts `providerFor`), the job's own gate question (`sessionGate` / `stateGate`)
// or its system prompt, the cached org prefix and the scope's input (src/ai/digests.ts, src/ai/repo-state.ts). The
// answers are graded by test/ai-evals/digests-grade.ts; the scores and the tokens of every call are printed; the raw
// response bodies are written to <kind>/recorded.json, which the CI test (test/ai-evals.digests.test.ts) replays.
//
// NEVER part of the suite; it spends real money. Run by hand, from the repository root:
//   npx esbuild scripts/ai-evals/digests-live.ts --bundle --platform=node --format=esm --alias:@shared=./shared \
//     --outfile=<scratch>/digests-live.mjs
//   node <scratch>/digests-live.mjs <path to .dev.vars> [gate.session|digest.session|gate.state|repo.state]
// The keys are read from that file at run time; nothing here prints or stores them.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { providerFor, CLAUDE_MODEL, type AiUsage } from "../../src/ai/client";
import { DIGEST_SYSTEM, DigestSchema, digestPrompt, sessionDigestJob, sessionFallback, sessionGate, type DigestAnswer, type SessionInput } from "../../src/ai/digests";
import { STATE_SYSTEM, StateSchema, repoStateJob, stateFallback, stateGate, statePrompt, type StateAnswer, type StateInput } from "../../src/ai/repo-state";
import { JEV_MODEL } from "../../src/tools/classify";
import type { JobItem } from "../../src/ai/jobs";
import {
  DIGEST_RULES, EVAL_PREFIX, STATE_RULES, gradeDigestKept, gradeDigestRaw, gradeStateKept, gradeStateRaw, promptKey, tally,
  type Case, type GateCase, type Recording,
} from "../../test/ai-evals/digests-grade";

const DIR = "test/ai-evals";
const [varsPath, only] = process.argv.slice(2);
if (!varsPath) { console.error("usage: digests-live <path to .dev.vars> [kind]"); process.exit(1); }
const vars: Record<string, string> = Object.fromEntries(readFileSync(varsPath, "utf8").split("\n")
  .map((l) => /^([A-Z_]+)\s*=\s*"?([^"]*)"?\s*$/.exec(l)).filter((m): m is RegExpExecArray => !!m).map((m) => [m[1], m[2]]));
const load = <T>(kind: string): T[] => (JSON.parse(readFileSync(join(DIR, kind, "cases.json"), "utf8")) as { cases: T[] }).cases;
const save = (kind: string, model: string, responses: Record<string, Recording>) =>
  writeFileSync(join(DIR, kind, "recorded.json"), JSON.stringify({ model, recordedAt: new Date().toISOString(), responses }, null, 1) + "\n");
const item = <I>(scope: "session" | "repo", key: string, input: I): JobItem<I> =>
  ({ scope: { scope, key, dirtySince: "", markedAt: "", attempts: 0, urgent: false }, input }) as JobItem<I>;

/** A fetch that keeps the text of the last response it handed back. */
function recording() {
  let last: { status: number; body: string } | null = null;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await fetch(input, init);
    const body = await res.text();
    last = { status: res.status, body };
    return new Response(body, { status: res.status, headers: res.headers });
  }) as typeof fetch;
  return { fetchImpl, last: () => last };
}

async function gate<I>(kind: "gate.session" | "gate.state", cases: GateCase<I>[], g: typeof sessionGate | typeof stateGate, fallback: (i: I) => boolean, scope: "session" | "repo") {
  const key = vars.TYPESAFE_API_KEY;
  if (!key) throw new Error("no TYPESAFE_API_KEY");
  const out: Record<string, Recording> = {};
  let right = 0, fbRight = 0, tin = 0, tout = 0, calls = 0;
  for (const c of cases) {
    const it = item(scope, "eval", c.input);
    const req = (g.ask as (i: JobItem<I>) => { state: string; questions: Record<string, never> })(it);
    const rec = recording();
    const r = await providerFor(kind, { apiKey: key, fetchImpl: rec.fetchImpl, timeoutMs: 60_000 })!.ask(req.state, req.questions);
    const last = rec.last();
    if (last) out[c.id] = { ...last, key: promptKey(req.state, JSON.stringify(req.questions)) };
    calls++;
    const p = r.ok ? (Object.values(r.answers)[0] as { p?: number } | null)?.p ?? null : null;
    const got = r.ok ? (g.pass as (a: typeof r) => boolean)(r) : null;
    if (r.ok) { tin += r.usage.inputTokens; tout += r.usage.outputTokens; }
    const fb = fallback(c.input);
    if (got === c.expected) right++;
    if (fb === c.expected) fbRight++;
    console.log(`${got === c.expected ? "ok  " : "MISS"} ${c.id} expected=${c.expected} p=${p === null ? "-" : p.toFixed(3)} fallback=${fb} tokens=${r.ok ? `${r.usage.inputTokens}/${r.usage.outputTokens}` : `status ${r.status}`}`);
  }
  save(kind, JEV_MODEL, out);
  console.log(`${kind}: Jev ${right}/${cases.length} = ${(right / cases.length).toFixed(3)}; plain rule ${fbRight}/${cases.length}; ${calls} calls, Jev tokens in ${tin} (${(tin / calls).toFixed(0)}/call), out ${tout} (${(tout / calls).toFixed(0)}/call)\n`);
}

async function haiku<I, O>(kind: "digest.session" | "repo.state", cases: Case<I>[], system: string, prompt: (i: I) => string, schema: unknown, maxTokens: number,
  grade: (a: Record<string, unknown>, i: I) => Record<string, boolean>, kept: (a: Record<string, unknown>, i: I) => { written: boolean }, rules: readonly string[]) {
  const key = vars.ANTHROPIC_API_KEY;
  if (!key) throw new Error("no ANTHROPIC_API_KEY");
  const out: Record<string, Recording> = {};
  const rows: Record<string, boolean>[] = [];
  let written = 0;
  const tok = { in: 0, out: 0, cached: 0, calls: 0 };
  for (const c of cases) {
    const input = prompt(c.input);
    const rec = recording();
    let usage: AiUsage | null = null;
    const res = await providerFor(kind, { apiKey: key, fetchImpl: rec.fetchImpl, timeoutMs: 120_000, onCall: (u) => { usage = u; } })!
      .structured({ kind, system, prefix: EVAL_PREFIX, cache: true, input, schema: schema as never, maxTokens });
    const last = rec.last();
    if (last) out[c.id] = { ...last, key: promptKey(system, EVAL_PREFIX, input) };
    const u = usage as AiUsage | null;
    if (u) { tok.in += u.inputTokens; tok.out += u.outputTokens; tok.cached += u.cachedTokens; tok.calls++; }
    const a = (res?.value ?? {}) as Record<string, unknown>;
    const g = res ? grade(a, c.input) : Object.fromEntries(rules.map((r) => [r, false]));
    const k = res ? kept(a, c.input) : { written: false };
    rows.push(g);
    if (k.written) written++;
    const failed = rules.filter((r) => !g[r]);
    console.log(`${failed.length ? "MISS" : "ok  "} ${c.id} written=${k.written} ${failed.length ? `failed=${failed.join(",")}` : ""} tokens=${u ? `${u.inputTokens} in (${u.cachedTokens} cached) / ${u.outputTokens} out` : "none"}${res ? "" : " NO ANSWER"}`);
    if (res) console.log(`     ${JSON.stringify(kind === "digest.session" ? { summary: a.summary, brief: a.brief, cites: a.cites } : { headline: a.headline, shipped: a.shipped, in_flight: a.in_flight, attention: a.attention })}`);
  }
  save(kind, CLAUDE_MODEL, out);
  const t = tally(rows, rules);
  console.log(`${kind}: raw all-rules ${t.all.toFixed(3)}; written ${written}/${cases.length}; by rule ${JSON.stringify(Object.fromEntries(Object.entries(t.byRule).map(([r, v]) => [r, Number((v as number).toFixed(3))])))}`);
  console.log(`${kind}: ${tok.calls} calls, Claude tokens in ${tok.in} (${(tok.in / tok.calls).toFixed(0)}/call, cached ${tok.cached}), out ${tok.out} (${(tok.out / tok.calls).toFixed(0)}/call)\n`);
}

const want = (k: string) => !only || only === k;
if (want("gate.session")) await gate("gate.session", load<GateCase<SessionInput>>("gate.session"), sessionGate, sessionFallback, "session");
if (want("digest.session")) await haiku<SessionInput, DigestAnswer>("digest.session", load<Case<SessionInput>>("digest.session"), DIGEST_SYSTEM, digestPrompt, DigestSchema, sessionDigestJob.maxTokens, gradeDigestRaw, gradeDigestKept, DIGEST_RULES);
if (want("gate.state")) await gate("gate.state", load<GateCase<StateInput>>("gate.state"), stateGate, stateFallback, "repo");
if (want("repo.state")) await haiku<StateInput, StateAnswer>("repo.state", load<Case<StateInput>>("repo.state"), STATE_SYSTEM, statePrompt, StateSchema, repoStateJob.maxTokens, gradeStateRaw, gradeStateKept, STATE_RULES);

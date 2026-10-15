// THE LIVE EVAL RUN for Phase C's Jev cards — by hand, never in the suite (it calls TypeSafe's API and costs a few
// cents). `node scripts/ai-evals/run.mjs record` sends every case's request (built by the card modules themselves,
// test/ai-evals/evals.ts) to Jev with `TYPESAFE_API_KEY` from the environment, and writes each exchange to
// test/ai-evals/<kind>/recorded.json — what test/ai.evals.test.ts replays at the `Response` level. `score` (no
// network) prints each kind's accuracy at its thresholds and a sweep, and writes test/ai-evals/<kind>/results.json.
// Re-record whenever a card's request changes (the test fails on any drift) and choose thresholds from the sweep.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { providerFor } from "../../src/ai/client";
import { TICKET_PROMPT_VERSION } from "../../src/ai/jobs/ticket-card";
import { REVIEW_PROMPT_VERSION } from "../../src/ai/jobs/review-card";
import { UNPLACED_PROMPT_VERSION } from "../../src/ai/jobs/unplaced-card";
import { EVAL_KINDS, decisionFor, recordingOf, requestFor, score, type EvalFile, type EvalKind, type RecordedFile } from "../../test/ai-evals/evals";

const ROOT = process.env.EVAL_ROOT ?? process.cwd();
const dir = (k: EvalKind) => join(ROOT, "test", "ai-evals", k);
const casesOf = (k: EvalKind): EvalFile => JSON.parse(readFileSync(join(dir(k), "cases.json"), "utf8"));
const PROMPTS: Record<string, string> = { ticket: TICKET_PROMPT_VERSION, review: REVIEW_PROMPT_VERSION, unplaced: UNPLACED_PROMPT_VERSION };

async function record(): Promise<void> {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new Error("TYPESAFE_API_KEY is not set");
  for (const kind of EVAL_KINDS) {
    if (recordingOf(kind) !== kind) continue; // priority rides on category's requests
    const file = casesOf(kind);
    // The duplicate cases' tickets also carry category and priority questions (as the pass sends them).
    const out: RecordedFile = { model: "", recordedAt: new Date().toISOString(), promptVersions: PROMPTS, cases: {} };
    let i = 0;
    const worker = async () => {
      while (i < file.cases.length) {
        const c = file.cases[i++];
        const req = requestFor(kind, c);
        let rec: { request: unknown; status: number; response: string } | null = null;
        const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
          const res = await fetch(url, init);
          const text = await res.text();
          rec = { request: JSON.parse(String(init?.body ?? "null")), status: res.status, response: text };
          return new Response(text, { status: res.status, headers: { "content-type": "application/json" } });
        }) as typeof fetch;
        const r = await providerFor(kind === "ticket.duplicate" || kind === "ticket.category" ? "ticket.category" : kind, { apiKey: key, fetchImpl, timeoutMs: 30_000 })!.ask(req.state, req.questions);
        if (r.ok && !out.model) out.model = r.model;
        if (!rec) throw new Error(`no exchange for ${kind} ${c.id}`);
        out.cases[c.id] = rec;
        process.stdout.write(r.ok ? "." : `!${(rec as { status: number }).status}`);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    writeFileSync(join(dir(kind), "recorded.json"), JSON.stringify(out, null, 1) + "\n");
    console.log(` ${kind}: ${file.cases.length} recorded`);
  }
}

async function scoreAll(): Promise<void> {
  for (const kind of EVAL_KINDS) {
    const file = casesOf(kind);
    const recPath = join(dir(recordingOf(kind)), "recorded.json");
    if (!existsSync(recPath)) { console.log(`${kind}: not recorded`); continue; }
    const rec: RecordedFile = JSON.parse(readFileSync(recPath, "utf8"));
    // Replay through the real provider (its parser), exactly as the test does.
    const answersOf = async (id: string, c: EvalFile["cases"][number]) => {
      const r = rec.cases[id];
      const fetchImpl = (async () => new Response(r.response, { status: r.status, headers: { "content-type": "application/json" } })) as typeof fetch;
      const req = requestFor(kind, c);
      const a = await providerFor("ticket.category", { apiKey: "replay", fetchImpl })!.ask(req.state, req.questions);
      return a.ok ? a.answers : {};
    };
    const rows: { id: string; expected: unknown; decision: unknown; answers: Record<string, unknown> }[] = [];
    for (const c of file.cases) {
      const answers = await answersOf(c.id, c);
      rows.push({ id: c.id, expected: c.expected, decision: decisionFor(kind, c, answers), answers });
    }
    const s = score(kind, rows);
    console.log(`\n${kind}: accuracy ${s.correct}/${s.n} = ${(100 * s.accuracy).toFixed(0)}%; suggestions written ${s.written}, right ${s.writtenRight}${s.precision === null ? "" : ` (${(100 * s.precision).toFixed(0)}%)`}`);
    const sweep: string[] = [];
    for (let t = 0.3; t <= 0.951; t += 0.05) {
      const d = file.cases.map((c, i) => ({ expected: c.expected, decision: decisionFor(kind, c, rows[i].answers as never, t) }));
      const x = score(kind, d);
      sweep.push(`${t.toFixed(2)}: acc ${(100 * x.accuracy).toFixed(0)}% written ${x.written} right ${x.writtenRight}`);
    }
    console.log("  sweep  " + sweep.join("\n         "));
    for (const r of rows) if (r.decision !== r.expected) console.log(`  miss ${r.id}: expected ${JSON.stringify(r.expected)}, decided ${JSON.stringify(r.decision)}`);
    writeFileSync(join(dir(kind), "results.json"), JSON.stringify({
      kind, model: rec.model, recordedAt: rec.recordedAt, accuracy: s.accuracy, correct: s.correct, n: s.n, written: s.written, writtenRight: s.writtenRight,
      decisions: Object.fromEntries(rows.map((r) => [r.id, r.decision])),
    }, null, 1) + "\n");
  }
}

const mode = process.argv[2];
(mode === "record" ? record() : mode === "score" ? scoreAll() : Promise.reject(new Error("usage: run.mjs record | score")))
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

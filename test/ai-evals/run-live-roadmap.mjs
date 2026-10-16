// LIVE run of the Roadmap and doc-drift evals (docs/architecture/ai.md › Evals) — OUTSIDE the suite, by hand, with
// real keys. It builds every input with THE job code's pure builders (`buildDocDriftInput`, `buildNoteInput`,
// `buildDriftInput`), asks with the jobs' own question and prompts (`DRIFT_GATE`, `DOC_DRIFT_JOB`, `SPRINT_NOTE_JOB`,
// `PLAN_DRIFT_JOB`) through THE client (src/ai/client.ts), grades with the jobs' own rules (`applyDrift`, `checkNote`,
// `checkDrift`), prints the scores and token counts, and writes what came back to `<kind>/recorded.json` — the
// bodies test/ai.evals-roadmap.test.ts replays. Direct calls, one per case (the pass sends doc.drift through the
// Batch API; the request is the same). Never commit a key: they are read from a `.dev.vars` file at run time.
//
//   npx esbuild test/ai-evals/run-live-roadmap.mjs --bundle --platform=node --format=esm --alias:@shared=./shared \
//     --outfile=<scratch>/run-live-roadmap.bundle.mjs
//   EVAL_DIR=$PWD/test/ai-evals node <scratch>/run-live-roadmap.bundle.mjs <path to .dev.vars> [gate.drift|doc.drift|org.rollup]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { providerFor } from "../../src/ai/client";
import { renderPrefix } from "../../src/ai/prefix";
import { keep } from "../../src/ai/sections";
import { applyDrift, buildDocDriftInput, DOC_DRIFT_JOB, DRIFT_GATE } from "../../src/ai/doc-drift";
import { buildDriftInput, buildNoteInput, checkDrift, checkNote, offPlanThemes, PLAN_DRIFT_JOB, SPRINT_NOTE_JOB } from "../../src/ai/roadmap";
import { gradeDocDrift, gradeLine } from "./roadmap-grade";

const HERE = process.env.EVAL_DIR ?? dirname(fileURLToPath(import.meta.url));
const [varsPath, only] = process.argv.slice(2);
if (!varsPath) { console.error("usage: run-live-roadmap <path to .dev.vars> [gate.drift|doc.drift|org.rollup]"); process.exit(1); }
const vars = Object.fromEntries(readFileSync(varsPath, "utf8").split("\n").map((l) => /^([A-Z_]+)\s*=\s*"?([^"]*)"?\s*$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2]]));
const read = (p) => JSON.parse(readFileSync(join(HERE, p), "utf8"));
const DOCS = read("doc.drift/docs.json").docs;
const ENTRIES = new Map(read("doc.drift/entries.json").entries.map((e) => [e.id, e]));
const scope = (scope, key) => ({ scope, key, dirtySince: "", markedAt: "", attempts: 0, urgent: false });
const PREFIX = renderPrefix({ org: "Personal Dev", tags: [], themes: [], sprints: [], narrative: "" });
/** A case's drift input, exactly as the job builds it from the doc and its entries. */
const driftInputOf = (c) => {
  const d = DOCS[c.slug];
  return buildDocDriftInput({ slug: c.slug, section: d.section, title: d.title, body: d.body, current_version: 1 }, c.entries.map((id) => ENTRIES.get(id)));
};

/** A fetch that keeps the text of every response it hands back. */
function recording() {
  const bodies = [];
  const fetchImpl = async (input, init) => {
    const res = await fetch(input, init);
    const text = await res.text();
    bodies.push({ status: res.status, body: text });
    return new Response(text, { status: res.status, headers: res.headers });
  };
  return { fetchImpl, bodies };
}

function claude(kind, rec, tok) {
  const key = vars.ANTHROPIC_API_KEY;
  if (!key) throw new Error("no ANTHROPIC_API_KEY");
  return providerFor(kind, { apiKey: key, fetchImpl: rec.fetchImpl, timeoutMs: 90_000, onCall: (u) => { tok.in += u.inputTokens; tok.out += u.outputTokens; tok.cached += u.cachedTokens; } });
}

async function gate() {
  const key = vars.TYPESAFE_API_KEY;
  if (!key) throw new Error("no TYPESAFE_API_KEY");
  const { cases } = read("gate.drift/cases.json");
  const recorded = {};
  let right = 0, tp = 0, fp = 0, fn = 0, tin = 0, tout = 0;
  for (const c of cases) {
    const req = DRIFT_GATE.ask({ scope: scope("doc_drift", c.slug), input: driftInputOf(c) });
    const rec = recording();
    const r = await providerFor("gate.drift", { apiKey: key, fetchImpl: rec.fetchImpl }).ask(req.state, req.questions);
    recorded[c.id] = rec.bodies.at(-1);
    const passed = r.ok ? DRIFT_GATE.pass({ model: r.model, answers: r.answers }) : null;
    if (r.ok) { tin += r.usage.inputTokens; tout += r.usage.outputTokens; }
    if (passed === c.expected) right++;
    if (passed && c.expected) tp++; else if (passed && !c.expected) fp++; else if (!passed && c.expected) fn++;
    const p = r.ok ? r.answers.disagrees?.p : null;
    console.log(`${passed === c.expected ? "ok  " : "MISS"} ${c.id.padEnd(22)} expected=${c.expected} p=${p == null ? "-" : p.toFixed(3)} state=${req.state.length}${r.ok ? "" : ` status=${r.status}`}`);
  }
  writeFileSync(join(HERE, "gate.drift", "recorded.json"), JSON.stringify({ model: "jev-latest", recordedAt: new Date().toISOString(), responses: recorded }, null, 1) + "\n");
  console.log(`gate.drift: ${right}/${cases.length} right; passed ${tp} of ${tp + fn} disagreements, ${fp} false passes; Jev tokens in ${tin}, out ${tout}`);
}

async function docDrift() {
  const { cases } = read("doc.drift/cases.json");
  const recorded = {};
  const tok = { in: 0, out: 0, cached: 0 };
  const sum = { right: 0, proposals: 0, edits: 0, citesNamed: 0, citesValid: 0, numbersOk: 0, findsExact: 0 };
  for (const c of cases) {
    const input = driftInputOf(c);
    const p = DOC_DRIFT_JOB.prompt([{ scope: scope("doc_drift", c.slug), input }]);
    const rec = recording();
    const res = await claude("doc.drift", rec, tok).structured({ kind: "doc.drift", system: p.system, prefix: PREFIX, cache: true, input: p.input, schema: DOC_DRIFT_JOB.schema, maxTokens: DOC_DRIFT_JOB.maxTokens });
    recorded[c.id] = rec.bodies.at(-1);
    const g = gradeDocDrift(input, res ? keep(res.value).kept : null, c.expected, applyDrift);
    for (const k of Object.keys(sum)) sum[k] += g[k] ?? 0;
    console.log(`${g.right ? "ok  " : "MISS"} ${c.id.padEnd(24)} expected=${c.expected} disagrees=${g.disagrees} edits=${g.edits} citesValid=${g.citesValid}/${g.citesNamed} numbersOk=${g.numbersOk} findsExact=${g.findsExact} proposal=${g.proposals ? "yes" : "no"}${g.summary ? ` — ${g.summary}` : ""}`);
  }
  writeFileSync(join(HERE, "doc.drift", "recorded.json"), JSON.stringify({ model: "claude-haiku-5-5", recordedAt: new Date().toISOString(), responses: recorded }, null, 1) + "\n");
  console.log(`doc.drift: ${sum.right}/${cases.length} right; ${sum.proposals} proposals; edits ${sum.edits}: cites valid ${sum.citesValid}/${sum.citesNamed}, numbers given ${sum.numbersOk}/${sum.edits}, finds exact ${sum.findsExact}/${sum.edits}; Claude tokens in ${tok.in}, out ${tok.out}, cached ${tok.cached}`);
}

async function rollup() {
  const set = read("org.rollup/cases.json");
  const now = new Date(set.now);
  const recorded = {};
  const tok = { in: 0, out: 0, cached: 0 };
  let kept = 0, n = 0, citesNamed = 0, citesValid = 0, numbersOk = 0;
  const run = async (id, job, input, check, pick) => {
    const p = job.prompt([{ scope: scope(job.scope, id), input }]);
    const rec = recording();
    const res = await claude(job.kind, rec, tok).structured({ kind: job.kind, system: p.system, prefix: PREFIX, cache: true, input: p.input, schema: job.schema, maxTokens: job.maxTokens });
    recorded[id] = rec.bodies.at(-1);
    const line = res ? pick(keep(res.value).kept) : null;
    const g = gradeLine(input, line, check);
    n++; if (g.kept) kept++; citesNamed += g.citesNamed; citesValid += g.citesValid; numbersOk += g.numbersOk ? 1 : 0;
    console.log(`${g.kept ? "ok  " : "DROPPED"} ${id.padEnd(20)} cites ${g.citesValid}/${g.citesNamed} numbersGiven=${g.numbersOk} — ${line?.text ?? "(no answer)"}`);
  };
  for (const c of set.notes) {
    const input = buildNoteInput(c.sprint, now);
    await run(c.id, SPRINT_NOTE_JOB, input, checkNote, (k) => (k.notes ?? []).find((x) => x.sprint === c.sprint.sprintId) ?? null);
  }
  for (const c of set.drift) {
    const input = buildDriftInput(c.shares, offPlanThemes(c.shares), c.sprints);
    await run(c.id, PLAN_DRIFT_JOB, input, checkDrift, (k) => k.drift ?? null);
  }
  writeFileSync(join(HERE, "org.rollup", "recorded.json"), JSON.stringify({ model: "claude-haiku-5-5", recordedAt: new Date().toISOString(), responses: recorded }, null, 1) + "\n");
  console.log(`org.rollup: ${kept}/${n} kept by the rules; cites valid ${citesValid}/${citesNamed}; numbers only as given ${numbersOk}/${n}; Claude tokens in ${tok.in}, out ${tok.out}, cached ${tok.cached}`);
}

if (!only || only === "gate.drift") await gate();
if (!only || only === "doc.drift") await docDrift();
if (!only || only === "org.rollup") await rollup();

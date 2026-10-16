// LIVE run of the theme evals (docs/architecture/ai.md › Evals) — OUTSIDE the suite, by hand, with real keys. It
// uses the REAL job code (src/ai/themes.ts: the Jev question, the caption prompt and its rules) and THE client
// (src/ai/client.ts), calls the providers directly (no Batch API: one request per case), prints the scores and the
// token counts, and writes what came back to `<kind>/recorded.json` — the bodies the CI test
// (test/ai-evals.themes.test.ts) replays. Never commit a key: the keys are read from a `.dev.vars` file at run time.
//
//   npx esbuild test/ai-evals/run-live.mjs --bundle --platform=node --format=esm --alias:@shared=./shared \
//     --outfile=<scratch>/run-live.bundle.mjs
//   node <scratch>/run-live.bundle.mjs <path to .dev.vars> [pr.theme|themes.caption]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { providerFor } from "../../src/ai/client";
import { prThemeJob, prThemePick, themesCaptionJob, checkCaption, captionBasis } from "../../src/ai/themes";
import { renderPrefix } from "../../src/ai/prefix";
import { keep } from "../../src/ai/sections";

const HERE = process.env.EVAL_DIR ?? dirname(fileURLToPath(import.meta.url));
const [varsPath, only] = process.argv.slice(2);
if (!varsPath) { console.error("usage: run-live <path to .dev.vars> [pr.theme|themes.caption]"); process.exit(1); }
const vars = Object.fromEntries(readFileSync(varsPath, "utf8").split("\n").map((l) => /^([A-Z_]+)\s*=\s*"?([^"]*)"?\s*$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2]]));
const evalSet = JSON.parse(readFileSync(join(HERE, "pr.theme", "cases.json"), "utf8"));
const THEMES = evalSet.themes.map((t, i) => ({ id: i + 1, name: t.name, description: t.description }));
const scenarios = JSON.parse(readFileSync(join(HERE, "themes.caption", "scenarios.json"), "utf8"));
const CAPTION_SCENARIOS = scenarios.scenarios;
const INACTIVE_THEMES = scenarios.inactive;
/** A case as the jobs read a merged PR: its card is its title and the body's opening (cases.json). */
const caseRow = (c) => ({ number: c.number, at: c.mergedAt, title: c.title, url: c.url, card_title: c.title, what: c.what, why: null, impact: null, theme_id: null, theme_source: null, theme_set_at: null });

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

async function prTheme() {
  const key = vars.TYPESAFE_API_KEY;
  if (!key) throw new Error("no TYPESAFE_API_KEY");
  const recorded = {};
  let right = 0, tokensIn = 0, tokensOut = 0;
  const rows = [];
  for (const c of evalSet.cases) {
    const item = { scope: { scope: "card", key: `pr:${c.number}` }, input: { repo: "AndresL230/trov", pr: caseRow(c), themes: THEMES } };
    const req = prThemeJob.ask(item);
    const rec = recording();
    const r = await providerFor("pr.theme", { apiKey: key, fetchImpl: rec.fetchImpl }).ask(req.state, req.questions);
    recorded[c.number] = rec.bodies.at(-1);
    let got = null, conf = null;
    if (r.ok) {
      tokensIn += r.usage.inputTokens; tokensOut += r.usage.outputTokens;
      conf = r.answers.theme?.confidence ?? null;
      const pick = prThemePick(THEMES, r.answers.theme);
      got = pick ? THEMES.find((t) => t.id === pick.id).name : null;
    }
    const ok = got === c.expected;
    if (ok) right++;
    rows.push(`${ok ? "ok  " : "MISS"} #${c.number} expected=${c.expected ?? "none"} got=${got ?? "none"} conf=${conf === null ? "-" : conf.toFixed(2)}${r.ok ? "" : ` status=${r.status}`}`);
  }
  writeFileSync(join(HERE, "pr.theme", "recorded.json"), JSON.stringify({ model: "jev-latest", recordedAt: new Date().toISOString(), responses: recorded }, null, 2) + "\n");
  console.log(rows.join("\n"));
  console.log(`pr.theme: ${right}/${evalSet.cases.length} = ${(right / evalSet.cases.length).toFixed(3)}; Jev tokens in ${tokensIn}, out ${tokensOut}`);
}

async function caption() {
  const key = vars.ANTHROPIC_API_KEY;
  if (!key) throw new Error("no ANTHROPIC_API_KEY");
  const recorded = {};
  let pass = 0, n = 0;
  const tok = { in: 0, out: 0, cached: 0 };
  const prefix = renderPrefix({ org: "Trov", tags: [], themes: THEMES.map((t) => `${t.name}: ${t.description}`), sprints: [], narrative: "" });
  for (const sc of CAPTION_SCENARIOS) {
    const prs = evalSet.cases.filter((c) => c.expected !== null || sc.withUnthemed).map((c) => ({ ...caseRow(c), theme_id: THEMES.find((t) => t.name === c.expected)?.id ?? null }));
    const input = captionBasis("AndresL230/trov", THEMES, INACTIVE_THEMES, prs, Date.parse(sc.now));
    if (!input) continue;
    const p = themesCaptionJob.prompt([{ scope: { scope: "theme_window", key: "AndresL230/trov" }, input }]);
    const rec = recording();
    let usage = null;
    const res = await providerFor("themes.caption", { apiKey: key, fetchImpl: rec.fetchImpl, timeoutMs: 60_000, onCall: (u) => { usage = u; } })
      .structured({ kind: "themes.caption", system: p.system, prefix, cache: true, input: p.input, schema: themesCaptionJob.schema, maxTokens: themesCaptionJob.maxTokens });
    recorded[sc.id] = rec.bodies.at(-1);
    if (usage) { tok.in += usage.inputTokens; tok.out += usage.outputTokens; tok.cached += usage.cachedTokens; }
    n++;
    const k = res ? keep(res.value).kept : {};
    const ok = k.caption !== undefined && k.theme_ids !== undefined ? checkCaption(k.caption, k.theme_ids, input.active, input.inactive) : null;
    if (ok) pass++;
    console.log(`${ok ? "ok  " : "DISCARDED"} ${sc.id}: ${JSON.stringify(k.caption ?? null)} ids=${JSON.stringify(k.theme_ids ?? null)}`);
  }
  writeFileSync(join(HERE, "themes.caption", "recorded.json"), JSON.stringify({ model: "claude-haiku-5-5", recordedAt: new Date().toISOString(), responses: recorded }, null, 2) + "\n");
  console.log(`themes.caption: ${pass}/${n} kept by the rules; Claude tokens in ${tok.in}, out ${tok.out}, cached ${tok.cached}`);
}

if (!only || only === "pr.theme") await prTheme();
if (!only || only === "themes.caption") await caption();

// LIVE run of the Phase C eval sets against Jev — OUTSIDE the suite, by hand, with the platform key from a
// `.dev.vars` file (never committed, never printed). It builds every request with the jobs' OWN code (the pure text
// builders and `ask`), sends it through THE client's Jev provider, prints the accuracy per threshold, and writes the
// raw answers to `test/ai-evals/<kind>/recorded.json` — what `test/ai.evals.test.ts` replays in CI.
//
//   npx esbuild scripts/ai-evals/run-live.ts --bundle --platform=node --format=esm --alias:@shared=./shared \
//     --outfile=/tmp/run-live.mjs && node /tmp/run-live.mjs <path to .dev.vars> <repo root> [feed.importance | tag.fit]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { providerFor } from "../../src/ai/client";
import { IMPORTANCE_QUESTION, feedImportanceText, prImportanceText } from "../../src/ai/importance";
import { TAG_FIT_ITEM_JOB } from "../../src/ai/sift-items";
import { excerptOf, ITEM_TAGS_ROOM_FOR_EVALS } from "./eval-input";

const [devVars, root, only] = process.argv.slice(2);
const key = /^TYPESAFE_API_KEY=["']?([^"'\n]+)/m.exec(readFileSync(devVars, "utf8"))?.[1];
if (!key) throw new Error("no TYPESAFE_API_KEY in that file");

let lastBody = "";
const recording = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const res = await fetch(input, init);
  lastBody = await res.clone().text();
  return res;
}) as typeof fetch;

async function importance(): Promise<void> {
  const dir = join(root, "test/ai-evals/feed.importance");
  const set = JSON.parse(readFileSync(join(dir, "cases.json"), "utf8"));
  const jev = providerFor("feed.importance", { apiKey: key, fetchImpl: recording, timeoutMs: 20_000 })!;
  const recorded: Record<string, { state: string; response: unknown }> = {};
  const rows: { id: string; expected: string; choice: string | null; confidence: number }[] = [];
  for (const c of set.cases) {
    const state = c.kind === "feed" ? feedImportanceText(c.row) : prImportanceText(c.row.number, { title: c.row.title, body: c.row.body }, null);
    const r = await jev.ask(state, { importance: IMPORTANCE_QUESTION });
    if (!r.ok) { console.log(c.id, "FAILED", r.status); continue; }
    recorded[c.id] = { state, response: JSON.parse(lastBody) };
    const a = r.answers.importance;
    rows.push({ id: c.id, expected: c.expected, choice: a?.type === "choice" ? a.choice : null, confidence: a?.type === "choice" ? a.confidence : 0 });
  }
  writeFileSync(join(dir, "recorded.json"), JSON.stringify(recorded, null, 2) + "\n");
  for (const r of rows) console.log(`${r.choice === r.expected ? "ok  " : "MISS"} ${r.id.padEnd(9)} expected ${r.expected.padEnd(8)} got ${String(r.choice).padEnd(8)} ${r.confidence.toFixed(2)}`);
  for (const t of [0, 0.5, 0.6, 0.7, 0.8, 0.9]) {
    const kept = rows.filter((r) => r.confidence >= t);
    const right = kept.filter((r) => r.choice === r.expected).length;
    console.log(`threshold ${t}: stored ${kept.length}/${rows.length}, right ${right}/${kept.length} (${kept.length ? Math.round((100 * right) / kept.length) : 0}%), overall ${Math.round((100 * right) / rows.length)}%`);
  }
}

async function tagFit(): Promise<void> {
  const dir = join(root, "test/ai-evals/tag.fit");
  const set = JSON.parse(readFileSync(join(dir, "cases.json"), "utf8"));
  const jev = providerFor("tag.fit", { apiKey: key, fetchImpl: recording, timeoutMs: 20_000 })!;
  const recorded: Record<string, { state: string; response: unknown; order: string[] }> = {};
  let tp = 0, fn = 0, fp = 0, tn = 0, added = 0, addedWrong = 0;
  for (const c of set.cases) {
    // What `itemFitInput` builds (src/tools/tag-fit.ts): the title and a 400-character scrubbed excerpt. The live run
    // asks the tags by name (the production order puts the tags whose words match first; Jev answers each on its own).
    const tags = [...set.tags].sort((a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : 1)).map((t: { name: string; description: string }) => ({ ...t, evidence: null }));
    const input = { type: "doc" as const, id: c.item.id, title: excerptOf(c.item.title, 200), text: excerptOf(c.item.body), tags, room: ITEM_TAGS_ROOM_FOR_EVALS };
    const req = TAG_FIT_ITEM_JOB.ask({ scope: { scope: "card", key: `tagfit:doc:${c.item.id}`, dirtySince: "", markedAt: "", attempts: 0, urgent: false }, input });
    const r = await jev.ask(req.state, req.questions);
    if (!r.ok) { console.log(c.id, "FAILED", r.status); continue; }
    recorded[c.id] = { state: req.state, response: JSON.parse(lastBody), order: tags.map((t) => t.name) };
    const line: string[] = [];
    tags.forEach((t, k) => {
      const a = r.answers[`t${k}`];
      const p = a?.type === "noul" ? a.p : NaN;
      const band = p >= 0.85 ? "add" : p >= 0.6 ? "suggest" : "-";
      const yes = c.fits.includes(t.name), no = c.doesNotFit.includes(t.name);
      if (band === "add") { added++; if (no) addedWrong++; }
      if (yes) band === "-" ? fn++ : tp++;
      if (no) band === "-" ? tn++ : fp++;
      line.push(`${t.name}=${p.toFixed(2)}${yes ? (band === "-" ? "(MISS)" : "") : no ? (band === "-" ? "" : "(WRONG)") : "(?)"}`);
    });
    console.log(c.id.padEnd(28), line.join(" "));
  }
  writeFileSync(join(dir, "recorded.json"), JSON.stringify(recorded, null, 2) + "\n");
  console.log(`fits found ${tp}/${tp + fn}; does-not-fit kept clear ${tn}/${tn + fp}; adds ${added}, of them on a does-not-fit pair ${addedWrong}`);
}

if (!only || only === "feed.importance") await importance();
if (!only || only === "tag.fit") await tagFit();

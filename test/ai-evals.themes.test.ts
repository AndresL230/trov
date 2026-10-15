// THE THEME EVALS, replayed (docs/architecture/ai.md › Evals): `test/ai-evals/pr.theme/` (Jev — 39 of this
// repository's real merged PRs and the theme each belongs to) and `test/ai-evals/themes.caption/` (the caption
// rules over eight-week windows of the same PRs). `test/ai-evals/run-live.mjs` ran them LIVE once and recorded what
// the providers answered; this test feeds those recorded bodies back through THE client at the `Response` level and
// the REAL job code (the Jev question, `prThemePick`, the caption prompt, `checkCaption`), so a change to a prompt,
// a threshold or a rule is scored against real answers without the network. A change to a question or a prompt
// needs a new live run (the recording no longer answers it) — and must keep these floors.
import { describe, it, expect } from "vitest";
import { providerFor } from "../src/ai/client";
import { captionBasis, checkCaption, prThemeJob, prThemePick, themesCaptionJob } from "../src/ai/themes";
import { keep } from "../src/ai/sections";
import type { MergedPrRow } from "../src/data/themes";

interface Case { number: number; title: string; mergedAt: string; url: string; what: string; expected: string | null }
interface EvalSet { themes: { name: string; description: string }[]; cases: Case[] }
interface Recorded { responses: Record<string, { status: number; body: string }> }
const files = Object.fromEntries(Object.entries(import.meta.glob("./ai-evals/**/*.json", { query: "?raw", import: "default", eager: true }))
  .map(([path, text]) => [path, JSON.parse(text as string) as unknown]));
const evalSet = files["./ai-evals/pr.theme/cases.json"] as EvalSet;
const jevRec = files["./ai-evals/pr.theme/recorded.json"] as Recorded;
const capRec = files["./ai-evals/themes.caption/recorded.json"] as Recorded;
const scenarios = files["./ai-evals/themes.caption/scenarios.json"] as { inactive: string[]; scenarios: { id: string; now: string; withUnthemed: boolean }[] };
const THEMES = evalSet.themes.map((t, i) => ({ id: i + 1, name: t.name, description: t.description }));
const row = (c: Case): MergedPrRow => ({ number: c.number, at: c.mergedAt, title: c.title, url: c.url, card_title: c.title, what: c.what, why: null, impact: null, theme_id: null, theme_source: null, theme_set_at: null });
const replay = (body: { status: number; body: string }): typeof fetch =>
  (async () => new Response(body.body, { status: body.status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

/** The floors: what the live run scored (2026-10-15: pr.theme 38/39, captions 6/6), less a margin for a re-record. */
const PR_THEME_FLOOR = 0.9;
const CAPTION_FLOOR = 1;

describe("pr.theme — real PRs, Jev's recorded answers, the real question and decision", () => {
  it(`has at least 15 cases, every expected theme one of the set's (or none), and scores ≥ ${PR_THEME_FLOOR}`, async () => {
    expect(evalSet.cases.length).toBeGreaterThanOrEqual(15);
    for (const c of evalSet.cases) expect(c.expected === null || THEMES.some((t) => t.name === c.expected)).toBe(true);
    let right = 0;
    const misses: string[] = [];
    for (const c of evalSet.cases) {
      const item = { scope: { scope: "card" as const, key: `pr:${c.number}`, dirtySince: "", markedAt: "", attempts: 0, urgent: false }, input: { repo: "AndresL230/trov", pr: row(c), themes: THEMES } };
      const req = prThemeJob.ask(item);
      expect(req.state).toContain(`Pull request #${c.number}: `);
      const rec = jevRec.responses[String(c.number)];
      expect(rec, `#${c.number} has a recording`).toBeDefined();
      const r = await providerFor("pr.theme", { apiKey: "ts-FAKE", fetchImpl: replay(rec) })!.ask(req.state, req.questions);
      expect(r.ok).toBe(true);
      const pick = r.ok ? prThemePick(THEMES, r.answers.theme) : undefined;
      expect(pick).not.toBeUndefined(); // never malformed
      const got = pick ? THEMES.find((t) => t.id === pick.id)!.name : null;
      if (got === c.expected) right++; else misses.push(`#${c.number}: ${got ?? "none"} (expected ${c.expected ?? "none"})`);
    }
    expect(right / evalSet.cases.length, misses.join("; ")).toBeGreaterThanOrEqual(PR_THEME_FLOOR);
  });
});

describe("themes.caption — the server's shares in, the model's recorded sentence out, the rules", () => {
  it(`every recorded caption keeps the rules (rate ≥ ${CAPTION_FLOOR}): no digit, only active themes, 20–280 characters`, async () => {
    let kept = 0, n = 0;
    for (const sc of scenarios.scenarios) {
      const prs = evalSet.cases.filter((c) => c.expected !== null || sc.withUnthemed).map((c) => ({ ...row(c), theme_id: THEMES.find((t) => t.name === c.expected)?.id ?? null }));
      const input = captionBasis("AndresL230/trov", THEMES, scenarios.inactive, prs, Date.parse(sc.now));
      if (!input) continue;
      n++;
      const p = themesCaptionJob.prompt([{ scope: { scope: "theme_window", key: "AndresL230/trov", dirtySince: "", markedAt: "", attempts: 0, urgent: false }, input }]);
      expect(p.input).toContain("First four weeks: ");
      const res = await providerFor("themes.caption", { apiKey: "sk-ant-FAKE", fetchImpl: replay(capRec.responses[sc.id]) })!
        .structured({ kind: "themes.caption", system: p.system, input: p.input, schema: themesCaptionJob.schema, maxTokens: themesCaptionJob.maxTokens });
      const k = res ? keep(res.value).kept : {};
      const ok = k.caption !== undefined && k.theme_ids !== undefined ? checkCaption(k.caption, k.theme_ids, input.active, input.inactive) : null;
      if (ok) kept++;
    }
    expect(n).toBeGreaterThanOrEqual(5);
    expect(kept / n).toBeGreaterThanOrEqual(CAPTION_FLOOR);
  });

  it("the rules catch what a careless caption does (the eval's negative cases)", () => {
    const active = THEMES.slice(0, 3);
    const bad = [
      "Billing and plans took 40% of the merged work.",          // a digit
      "Work moved from the Repo dashboard to the Landing page.", // an inactive theme by name
      "Tickets, mostly.",                                         // too short
    ];
    for (const b of bad) expect(checkCaption(b, [1], active, scenarios.inactive)).toBeNull();
    expect(checkCaption("Most of the work went to the Repo dashboard, then to Tickets and sprints.", [1, 99], active, [])).toBeNull(); // id 99 not active
  });
});

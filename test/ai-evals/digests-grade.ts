// THE GRADING RULES of the Phase D digest evals (docs/architecture/ai.md › Evals): `gate.session`, `digest.session`,
// `gate.state` and `repo.state`. Shared by the live runner (scripts/ai-evals/digests-live.ts, by hand, real keys) and
// the CI replay (test/ai-evals.digests.test.ts, recorded bodies). Pure: no network, no D1.
//
// The cases (`<kind>/cases.json`) are REAL — this repository's own history (`git log` of merged PRs, branch bursts and
// trivial pushes to main) and the Personal Dev org's PR cards and dashboard read over the Trov MCP read tools
// (read-only). `scripts/ai-evals/digests-cases.mjs` rebuilds them.
//
// A Haiku answer is graded TWICE: the RAW answer against the rules (would the model pass on its own?) and the KEPT
// answer — what the server would actually write after `checkDigest` / `checkState` drop what breaks a rule.
import { STARTER_TAGS } from "@shared/tags-core";
import { renderPrefix } from "../../src/ai/prefix";
import { checkDigest, digestPrompt, groundedNumbers, type SessionInput } from "../../src/ai/digests";
import { checkState, statePrompt, writesRef, type StateInput } from "../../src/ai/repo-state";

/** The org prefix every eval prompt carries: Personal Dev's name and the six starter tags, nothing else. */
export const EVAL_PREFIX = renderPrefix({
  org: "Personal Dev",
  tags: STARTER_TAGS.map((t) => ({ name: t.name, description: t.description })),
  themes: [], sprints: [], narrative: "",
});

/** A short, stable hash of what a call sends, so a changed prompt fails the replay ("record again"). */
export function promptKey(...parts: string[]): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (const ch of parts.join("\u0000")) {
    const c = ch.codePointAt(0)!;
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 + c, 2246822519) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

export interface GateCase<I> { id: string; source: string; input: I; expected: boolean }
export interface Case<I> { id: string; source: string; input: I }
export interface Recording { status: number; body: string; key: string }
export interface RecordedFile { model: string; recordedAt: string; responses: Record<string, Recording> }

// ── digest.session ───────────────────────────────────────────────────────────

export const DIGEST_RULES = ["type", "prefix", "length", "brief_refs", "numbers", "cites_valid", "cites_some"] as const;
export type DigestRule = (typeof DIGEST_RULES)[number];

/** The raw answer against each rule (true = held). */
export function gradeDigestRaw(a: Record<string, unknown>, s: SessionInput): Record<DigestRule, boolean> {
  const input = digestPrompt(s);
  const str = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : "");
  const type = a.type === "Shipped" || a.type === "Status" ? a.type : null;
  // A merged PR or a push to a default branch is "Shipped"; anything else is "Status" — and the type must be the one the
  // input calls for, not merely an allowed one.
  const expected = s.shipped ? "Shipped" : "Status";
  const summary = str("summary"), brief = str("brief");
  const okShas = new Set(s.commits.map((c) => `sha:${c.sha}`));
  const okPrs = new Set(s.prs.map((p) => `pr:${p.number}`));
  const cites = Array.isArray(a.cites) ? (a.cites as unknown[]).filter((c): c is string => typeof c === "string").map((c) => c.trim().toLowerCase()) : [];
  const valid = cites.filter((c) => okShas.has(c) || okPrs.has(c));
  const fields = ["what", "why", "impact", "follow_up", "state", "blocked_on", "next"].map(str).filter(Boolean);
  return {
    type: type === expected,
    prefix: !!type && summary.startsWith(`${type}: `),
    length: summary.length > 0 && summary.length <= 100 && brief.length > 0 && brief.length <= 280,
    brief_refs: !/#\d+|\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b|\bpr:\d+|\bsha:/i.test(brief),
    numbers: [summary, brief, ...fields].every((t) => groundedNumbers(t, input)),
    cites_valid: cites.length > 0 && valid.length === cites.length,
    cites_some: valid.length > 0,
  };
}

/** What the server would write from it, and whether that is a written entry. */
export function gradeDigestKept(a: Record<string, unknown>, s: SessionInput): { written: boolean; reason: string | null; summary: string | null } {
  const d = checkDigest(a, s);
  return d.ok ? { written: true, reason: null, summary: d.summary } : { written: false, reason: d.reason, summary: null };
}

// ── repo.state ───────────────────────────────────────────────────────────────

export const STATE_RULES = ["headline", "cites_valid", "numbers", "text_refs", "list_max", "merged_shipped", "merged_left_flight", "red_attention", "deploy_attention"] as const;
export type StateRule = (typeof STATE_RULES)[number];

interface RawLine { text?: unknown; cites?: unknown }
const linesOf = (a: Record<string, unknown>, k: string): RawLine[] => (Array.isArray(a[k]) ? (a[k] as RawLine[]).filter((x) => x && typeof x === "object") : []);
const citesOf = (l: RawLine): string[] => (Array.isArray(l.cites) ? (l.cites as unknown[]).filter((c): c is string => typeof c === "string").map((c) => c.trim()) : []);

/** The raw answer against each rule (true = held). Each rule is about THIS case's input: a merged PR must be in
 *  shipped and out of in flight, a red default branch and a failed deploy must be in attention. */
export function gradeStateRaw(a: Record<string, unknown>, s: StateInput): Record<StateRule, boolean> {
  const input = statePrompt(s);
  const lists = { shipped: linesOf(a, "shipped"), in_flight: linesOf(a, "in_flight"), attention: linesOf(a, "attention") };
  const all = [...lists.shipped, ...lists.in_flight, ...lists.attention];
  const cited = (ls: RawLine[]) => new Set(ls.flatMap(citesOf));
  const headline = typeof a.headline === "string" ? a.headline : "";
  const failedDeploys = s.deploys.filter((d) => /error|fail|cancel/i.test(d.state)).map((d) => d.ref);
  return {
    headline: headline.length > 0 && headline.length <= 200,
    cites_valid: all.every((l) => { const c = citesOf(l); return c.length > 0 && c.every((x) => !!s.cites[x]); }),
    numbers: [headline, ...all.map((l) => (typeof l.text === "string" ? l.text : ""))].every((t) => groundedNumbers(t, input)),
    text_refs: ![headline, ...all.map((l) => (typeof l.text === "string" ? l.text : ""))].some(writesRef),
    list_max: Object.values(lists).every((l) => l.length <= 5),
    merged_shipped: s.merged.every((m) => cited(lists.shipped).has(m.ref)),
    merged_left_flight: s.merged.every((m) => !cited(lists.in_flight).has(m.ref)),
    red_attention: !s.redMain || s.failedRuns.some((r) => cited(lists.attention).has(r.ref)),
    deploy_attention: failedDeploys.every((ref) => cited(lists.attention).has(ref)),
  };
}

export function gradeStateKept(a: Record<string, unknown>, s: StateInput): { written: boolean; lines: number; dropped: number } {
  const c = checkState(a, s);
  return c.ok ? { written: true, lines: c.state.shipped.length + c.state.inFlight.length + c.state.attention.length, dropped: c.dropped } : { written: false, lines: 0, dropped: 0 };
}

/** The share of rules held across every case, and each rule's own share. */
export function tally<R extends string>(rows: Record<R, boolean>[], rules: readonly R[]): { all: number; byRule: Record<R, number> } {
  const byRule = Object.fromEntries(rules.map((r) => [r, rows.filter((x) => x[r]).length / Math.max(rows.length, 1)])) as Record<R, number>;
  const all = rows.filter((x) => rules.every((r) => x[r])).length / Math.max(rows.length, 1);
  return { all, byRule };
}

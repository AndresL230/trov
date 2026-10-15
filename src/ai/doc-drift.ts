// DOC DRIFT (#161; Phase D — docs/architecture/ai.md › Doc drift; docs/architecture/ingestion-gate.md): "this doc
// says deploys are manual; three recent feed entries say CI deploys". A Haiku job of the AI pass's last stage
// (`doc_drift:<slug>`, marked when a doc is promoted; weekly on Pro / Enterprise, monthly on Free / Personal —
// the scope's debounce), through the Batch API, and ONLY PAST `gate.drift`:
//
//   1. input      the live doc and the feed entries written SINCE it was last promoted (at most 30 days back) that
//                 its own full-text index matches against the doc's title — none, no call (the scope clears).
//   2. gate.drift Jev: "does this doc disagree with these entries?" — below 0.6 no Haiku call. Without Jev (no
//                 key, the allowance spent, the provider stopped, a malformed answer) the plain rule is SKIP.
//   3. Haiku      the smallest edits that make the doc agree: each an EXACT passage of the doc and its
//                 replacement, each citing the entries that show it. The server applies them (a passage that is
//                 not in the doc exactly once is dropped), checks every number against the input and every cite
//                 against the entries offered — an edit without valid evidence is dropped, and with none left
//                 nothing is written.
//   4. the gate   the result is a LOW-CONFIDENCE doc proposal through `ingestDocProposal` (invariant 1: an
//                 ingestion path goes INTO the gate), authored by the reserved system person `trov` (the
//                 documented exception to "the author is the principal"). It is STAGED and flagged like any
//                 low-confidence edit of an existing doc, and only a person promotes or rejects it (Review).
//
// An artifact's drift scope (`doc_drift:artifact:<slug>`) has no doc to propose to: its input is null (cleared,
// no call). A doc with a Trov proposal still staged is not checked again until a person answers it.
import { z } from "zod";
import { TROV_SYSTEM_HANDLE, type AiCite } from "@shared/ai";
import { all, first, type TenantContext } from "../data/sql";
import { ingestDocProposal } from "../consumer";
import { fitQuery } from "../tools/tag-fit";
import { each, keep, sections } from "./sections";
import { allowedNumbers, cleanLine, fenced, FENCE_RULE, numbersGiven, sendable, validCites } from "./grounding";
import type { ClaudeJob, JevAnswers, JobItem, JevRequest, JevGate } from "./jobs";

const DAY = 86_400_000;
/** How far back entries are compared (and never before the doc's last promote). */
export const DRIFT_LOOKBACK_DAYS = 30;
/** Entries compared per doc. */
export const DRIFT_ENTRIES_MAX = 6;
/** Below this, Jev's "does it disagree?" stops the doc before any Haiku call. */
export const DRIFT_GATE_MIN = 0.6;
/** What of the doc is sent (Haiku) and what Jev reads. */
const DOC_SENT_MAX = 8000;
const GATE_STATE_MAX = 4000;

export interface DocDriftInput {
  slug: string;
  title: string;
  section: string;
  version: number;
  /** The live body, whole — what the edits are applied to (never sent as is). */
  body: string;
  /** What is sent: no code, nothing shaped like a credential, cut to `DOC_SENT_MAX`. */
  sent: string;
  entries: { ref: string; author: string; at: string; summary: string; text: string }[];
  offered: Map<string, AiCite>;
  allowed: Set<string>;
}

/** The doc and the entries it is compared with — or null: an artifact's scope, a doc gone or never promoted, a
 *  Trov proposal still waiting on a person, or no entry since its last promote that matches it. */
export async function docDriftInput(ctx: TenantContext, key: string, now: Date = new Date()): Promise<DocDriftInput | null> {
  if (!key || key.startsWith("artifact:")) return null;
  const doc = await first<{ slug: string; section: string; title: string; body: string; current_version: number; updated_at: string | null }>(ctx,
    `SELECT slug, section, title, body, current_version, updated_at FROM docs WHERE org_id = ? AND slug = ?`, ctx.orgId, key);
  if (!doc || doc.current_version <= 0 || !doc.body.trim()) return null;
  const waiting = await first<{ n: number }>(ctx,
    `SELECT COUNT(*) AS n FROM doc_versions WHERE org_id = ? AND slug = ? AND status = 'staged' AND created_by = ?`, ctx.orgId, key, TROV_SYSTEM_HANDLE);
  if ((waiting?.n ?? 0) > 0) return null;
  const q = fitQuery(doc.title, doc.slug.replace(/[/_-]+/g, " "));
  if (!q) return null;
  const floor = new Date(now.getTime() - DRIFT_LOOKBACK_DAYS * DAY).toISOString();
  const since = doc.updated_at && doc.updated_at > floor ? doc.updated_at : floor;
  const rows = await all<{ id: number; author: string; summary: string; brief: string | null; body: string | null; created_at: string }>(ctx,
    `SELECT f.id, f.author, f.summary, f.brief, f.body, f.created_at FROM feed_fts JOIN feed f ON f.org_id = ? AND CAST(f.id AS TEXT) = feed_fts.feed_id
      WHERE feed_fts MATCH ? AND feed_fts.org_id = ? AND f.created_at > ? AND f.author != ?
      ORDER BY bm25(feed_fts, 1.0, 5.0, 1.0) LIMIT ?`, ctx.orgId, q, ctx.orgId, since, TROV_SYSTEM_HANDLE, DRIFT_ENTRIES_MAX);
  if (!rows.length) return null;
  const entries = rows.map((f) => ({
    ref: `feed:${f.id}`, author: f.author, at: f.created_at.slice(0, 10), summary: sendable(f.summary, 200), text: sendable(f.brief ?? f.body ?? "", 700),
  }));
  const offered = new Map<string, AiCite>(rows.map((f) => [`feed:${f.id}`, { ref: `feed:${f.id}`, label: f.summary.replace(/\s+/g, " ").trim().slice(0, 60) || "feed entry", href: "#feed" }]));
  const sent = sendable(doc.body, DOC_SENT_MAX);
  return {
    slug: doc.slug, title: doc.title, section: doc.section, version: doc.current_version, body: doc.body, sent, entries, offered,
    allowed: allowedNumbers(sent, doc.title, ...entries.flatMap((e) => [e.summary, e.text])),
  };
}

// ── gate.drift (Jev) ─────────────────────────────────────────────────────────

export const DRIFT_QUESTION = "Does the document state something that the recent entries contradict, or show is no longer true?";

export function gateState(i: DocDriftInput): string {
  const head = `Document "${i.title}":\n${i.sent.slice(0, GATE_STATE_MAX / 2)}`;
  const tail = `\n\nRecent entries:\n${i.entries.map((e) => `- ${e.summary}${e.text ? `: ${e.text}` : ""}`).join("\n")}`;
  return (head + tail).slice(0, GATE_STATE_MAX);
}

export const DRIFT_GATE: JevGate<DocDriftInput> = {
  kind: "gate.drift",
  ask: (item: JobItem<DocDriftInput>): JevRequest => ({
    state: gateState(item.input),
    questions: { disagrees: { type: "noul", instructions: DRIFT_QUESTION } },
  }),
  pass: (a: JevAnswers): boolean => {
    const x = a.answers.disagrees;
    return !!x && x.type === "noul" && x.p >= DRIFT_GATE_MIN;
  },
  // Without Jev, nothing is compared: a Haiku call per doc is too dear to make on a guess.
  fallback: () => false,
};

// ── Haiku ────────────────────────────────────────────────────────────────────

const Edit = z.object({
  find: z.string().min(8).max(400),
  replace: z.string().max(600),
  cites: z.array(z.string().max(80)).min(1).max(4),
});
export const DocDriftAnswer = sections({
  disagrees: z.boolean(),
  edits: z.array(each(Edit)).max(5),
  summary: z.string().min(1).max(200),
});
type DocDriftAnswer = z.infer<typeof DocDriftAnswer>;

export const DOC_DRIFT_SYSTEM = `You keep a software team's documents true in Trov. ${FENCE_RULE}
Compare the document with the recent entries. When an entry shows that something the document states is no longer true, propose the SMALLEST edits that make the document agree with the entries:
- "find": a passage copied EXACTLY, character for character, from the document (one sentence or less; never from an omitted code block).
- "replace": the corrected text, in the document's own style. Change only what the entries show.
- "cites": the entries ("feed:<id>") that show it. An edit no entry shows is not an edit.
Never invent facts, names or numbers: state only numbers that appear in the document or the entries. Prefer no edit to a doubtful one.
If nothing in the document disagrees with the entries, answer "disagrees": false with no edits. Always give a one-sentence "summary" (at most 160 characters) of what changed, or of why nothing did.`;

export function docDriftPrompt(items: readonly JobItem<DocDriftInput>[]): { system: string; input: string } {
  const i = items[0].input;
  return {
    system: DOC_DRIFT_SYSTEM,
    input: `${fenced("document", { slug: i.slug, title: i.title, section: i.section, text: i.sent })}\n\n${fenced("recent entries", i.entries)}`,
  };
}

/** The proposed body and its evidence, or null when no edit survives: each `find` must occur in the doc EXACTLY
 *  ONCE, its replacement must state no number the input did not, and it must cite an entry it was given. */
export function applyDrift(i: DocDriftInput, a: Partial<DocDriftAnswer>): { body: string; cites: AiCite[]; summary: string } | null {
  if (a.disagrees !== true) return null;
  const summary = cleanLine(a.summary, 200);
  if (!summary || !numbersGiven(summary, i.allowed)) return null;
  let body = i.body;
  const cites: AiCite[] = [];
  const touched: [number, number][] = [];
  for (const e of a.edits ?? []) {
    const evidence = validCites(e.cites, i.offered, 4);
    if (!evidence.length) continue;
    if (!e.find.trim() || e.find === e.replace || !numbersGiven(e.replace, i.allowed)) continue;
    const at = i.body.indexOf(e.find);
    if (at < 0 || i.body.indexOf(e.find, at + 1) >= 0) continue; // not in the doc, or not exactly once
    if (touched.some(([s, end]) => at < end && at + e.find.length > s)) continue; // overlaps an earlier edit
    const cur = body.indexOf(e.find);
    if (cur < 0) continue;
    body = body.slice(0, cur) + e.replace + body.slice(cur + e.find.length);
    touched.push([at, at + e.find.length]);
    for (const c of evidence) if (!cites.some((x) => x.ref === c.ref)) cites.push(c);
  }
  if (!touched.length || body === i.body) return null;
  return { body, cites, summary };
}

/** The proposal's change summary: what changed, what it was compared with, and that it is low confidence. */
export function driftChangeSummary(summary: string, cites: AiCite[]): string {
  const from = cites.map((c) => `“${c.label}”`).join(", ");
  return `Trov: ${summary} From feed entries ${from}. Low confidence: check it against them before promoting.`;
}

export const DOC_DRIFT_JOB: ClaudeJob<DocDriftInput, DocDriftAnswer> = {
  provider: "claude", kind: "doc.drift", name: "doc.drift", scope: "doc_drift", promptVersion: "drift-doc-1",
  group: 1, batch: true, gate: DRIFT_GATE, schema: DocDriftAnswer, maxTokens: 2500,
  input: (ctx, s) => docDriftInput(ctx, s.key),
  prompt: docDriftPrompt,
  async write(ctx, items, out) {
    const item = items[0];
    const kept = keep(out).kept;
    // "Nothing disagrees" is an answer: the scope is written, nothing is proposed.
    if (kept.disagrees === false) return [item.scope.key];
    const d = applyDrift(item.input, kept);
    if (!d) return [];
    // THROUGH THE GATE, at low confidence, as `trov`: staged and flagged; only a person promotes it.
    const r = await ingestDocProposal(ctx, {
      slug: item.input.slug, section: item.input.section, title: item.input.title, body: d.body,
      change_summary: driftChangeSummary(d.summary, d.cites), confidence: "low", base_version: item.input.version,
    }, TROV_SYSTEM_HANDLE);
    return r.outcome === "written" || r.outcome === "unchanged" ? [item.scope.key] : [];
  },
};

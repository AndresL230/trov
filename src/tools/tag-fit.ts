// "Which existing items fit this tag?" — the first use of instant intelligence (issues #154–#158, #166):
// when an admin creates a tag (or presses Find items), a model judges which of the org's feed entries, docs
// and decisions fit it, and the tag is ADDED to each item it judges a fit.
//
// The rules that bind it (#154), with ONE deliberate exception, the owner's call (2026-10-14):
//   • ACTIONS, FOR THIS ONE FEATURE. #154 says "suggestions, never actions"; here a confident "fits" adds the
//     tag to the item at once — no review step. It is scoped: only a run an ADMIN starts (adding a tag,
//     accepting a suggested one, Find items), only with the org's switch on, only that org's items, only ADDING
//     this one tag — it never removes or changes anything else. Every tag it adds keeps its provenance (a
//     `source = 'model'` row of `org_tag_suggestions`, `state = 'accepted'`, `resolved_by = 'jev'`, the run's
//     id), written in the SAME batch as the `entry_tags` row, and one `tag.fit` audit row per run. The way back:
//     `undoTagFit` removes exactly what a run added; a person removing the tag from one item is remembered
//     (`removed`), so no later run adds it again.
//   • NEVER ON A RENDER PATH. A run starts after a tag is added (or a suggested one accepted) and from
//     "Find items" — in the background (`waitUntil`), never while a page loads.
//   • A FIXED SET OF ANSWERS: "fits" / "does not fit", through the one classify call (./classify.ts) —
//     TypeSafe AI's Jev, a non-generative decision model: a yes/no probability per item, and no text. The
//     REASON a suggestion shows is Trov's own evidence: the full-text snippet that made the item a candidate.
//   • NEVER GUESS ON READ. Only "fits" at or above `FIT_THRESHOLD` adds the tag; anything else leaves no row.
//   • METERED. Every model call counts against the month's `jev_checks` (shared/plans.ts); past it the
//     run stops (`capped`) and the Tags tab says so.
//   • CONSENT. Nothing is sent unless an admin turned the org's switch on (`org_ai_settings`, kind
//     `tag.fit`), and the platform has a key (`TYPESAFE_API_KEY`). What is sent, one item per request: a title and an excerpt of at most
//     `EXCERPT_MAX` characters — code blocks, inline code and anything shaped like a credential removed —
//     of THIS org's items only, picked without the model first by the org's own full-text index.
import type { Env } from "../env";
import { normalizeTagName, type TagItemType, type TagRunDTO } from "@shared/tags-core";
import { planRefusal, resolveEntitlements } from "@shared/plans";
import { platform, requireRole, type TenantContext } from "../data/context";
import { METRIC_AI_SUGGEST, meter } from "../data/meter";
import { all, batch, first, nowIso, run, stmt, type Stmt } from "../data/sql";
import { planFor, suggestionsUsed } from "../plans/gate";
import { jevClassifier, type Classifier, type ClassifierOpts } from "./classify";
import { TagError } from "./tags";

export const TAG_FIT_KIND = "tag.fit";
/** Who a run's tags are recorded as resolved by: the model, never a person. A reserved word, not a handle. */
export const JEV_ACTOR = "jev";
export const FIT_ANSWERS = ["fits", "does not fit"] as const satisfies readonly [string, string];
/** Only a "fits" this sure is stored. */
export const FIT_THRESHOLD = 0.7;
/** At most this many items are pre-selected for one run (one model request each). */
export const CANDIDATE_CAP = 60;
/** When the tag's words find fewer than this, the newest other items top the list up to it — so a tag with
 *  no description (or words nothing uses) still gets the model's judgement on something. */
export const TOP_UP_TO = 20;
/** The reason of a suggestion whose item had no matching passage (a top-up): the model's score, said as
 *  such — never a quote Trov did not find. */
export const scoreReason = (confidence: number): string => `Sift rates it a fit (${Math.round(confidence * 100)}%)`;
/** The reason shown when an item's match left no usable snippet. */
export const NO_SNIPPET_REASON = "Matches the tag's description";
/** The most of an item's text that is sent (its title goes whole, up to `TITLE_MAX`). */
export const EXCERPT_MAX = 400;
const TITLE_MAX = 200;
/** A run still "running" after this long died with its Worker: the next start takes over. */
const STALE_MS = 15 * 60 * 1000;

const auditStmt = (ctx: TenantContext, action: string, target: string, detail: Record<string, unknown>, at: string): Stmt =>
  stmt(ctx, `INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at) VALUES (?, ?, ?, ?, ?, ?)`,
    ctx.orgId, ctx.userId, action, target, JSON.stringify(detail), at);

// ── the switch ───────────────────────────────────────────────────────────────

/** Is the org's switch for `kind` on? Off when there is no row. */
export async function aiEnabled(ctx: TenantContext, kind = TAG_FIT_KIND): Promise<boolean> {
  return (await first<{ enabled: number }>(ctx, `SELECT enabled FROM org_ai_settings WHERE org_id = ? AND kind = ?`, ctx.orgId, kind))?.enabled === 1;
}

/** Turn the org's switch on or off (admin+), audited. */
export async function setAiEnabled(ctx: TenantContext, on: unknown, kind = TAG_FIT_KIND): Promise<{ enabled: boolean }> {
  requireRole(ctx, "admin");
  if (typeof on !== "boolean") throw new TagError("invalid", 400, "enabled must be true or false", "enabled");
  const at = nowIso();
  await batch(ctx, [
    stmt(ctx, `INSERT INTO org_ai_settings (org_id, kind, enabled, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(org_id, kind) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      ctx.orgId, kind, on ? 1 : 0, at, ctx.userId),
    auditStmt(ctx, on ? "ai.enable" : "ai.disable", kind, {}, at),
  ]);
  return { enabled: on };
}

/** Where the month's allowance stands, and whether a call may be made now. */
export async function suggestAllowance(ctx: TenantContext): Promise<{ used: number; cap: number | null; spent: boolean }> {
  const [plan, used] = await Promise.all([planFor(ctx), suggestionsUsed(ctx)]);
  // The one question (shared/plans.ts): may this org make one more `jev_checks` call?
  return { used, cap: resolveEntitlements(plan.plan, plan.overrides).jev_checks, spent: planRefusal(plan, "jev_checks", used, 1) !== null };
}

// ── what is sent ─────────────────────────────────────────────────────────────

// Shaped like a credential: Trov's own tokens, GitHub's, Stripe's, Slack's, AWS's, a JWT, a long hex or base64 run.
const SECRETISH = /\b(?:trov_(?:mcp|oat)_\S+|canopy_(?:mcp|oat)_\S+|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|sk_(?:live|test)_\w+|rk_(?:live|test)_\w+|whsec_\w+|xox[abpr]-[\w-]+|AKIA[0-9A-Z]{16}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]+|[A-Fa-f0-9]{32,}|[A-Za-z0-9+/=_-]{40,})\b/g;

/** An item's text as it may be sent: no code (fenced, indented or inline), no markup, no image or link
 *  targets, nothing shaped like a credential; one line, at most `max` characters. */
export function excerptOf(text: string | null | undefined, max = EXCERPT_MAX): string {
  if (!text) return "";
  const t = text
    .replace(/(```|~~~)[\s\S]*?(\1|$)/g, " ")                  // fenced code, closed or not
    .replace(/^(?: {4}|\t).*$/gm, " ")                          // indented code
    .replace(/`[^`\n]*`/g, " ")                                 // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")                      // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")                    // a link: its words, not its target
    .replace(/<[^>]+>/g, " ")                                   // markup
    .replace(/https?:\/\/\S+/g, " ")                            // bare URLs
    .replace(SECRETISH, " ")
    .replace(/[*_]+/g, "")                                      // emphasis marks: the words stay
    .replace(/[#>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? t.slice(0, max) : t;
}

const STOP = new Set(["a", "an", "and", "or", "the", "of", "for", "to", "in", "on", "with", "what", "how", "is", "are", "it", "its", "by", "from", "at", "as", "be", "that", "this"]);
/** The FTS5 query that pre-selects candidates: the tag's name and its description's words, any of them,
 *  each a quoted prefix term (so no typed operator reaches FTS). null when nothing is left. */
export function fitQuery(name: string, description: string): string | null {
  const words = `${name.replace(/-/g, " ")} ${description}`.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [];
  const terms = [...new Set(words.filter((w) => !STOP.has(w)))].slice(0, 12);
  return terms.length ? terms.map((t) => `"${t}"*`).join(" OR ") : null;
}

export interface FitCandidate {
  type: TagItemType; id: string; title: string; text: string; at: string;
  /** Why it is a candidate, in Trov's words: the snippet of its text around the match — null for an item
   *  added only to top the list up (`TOP_UP_TO`). */
  evidence: string | null;
}

const SNIP = `'', '', '…', 12`;
/** The reason a suggestion shows: the words around the match, as the index found them — never invented. */
export function evidenceOf(snippet: string | null | undefined): string {
  const s = excerptOf((snippet ?? "").replace(/…/g, " … "), 160).replace(/\s*…\s*/g, "…").replace(/^…+|…+$/g, "").trim();
  return s.replace(/[^A-Za-z0-9]/g, "").length >= 3 ? `Mentions “…${s}…”` : NO_SNIPPET_REASON;
}

/**
 * The items a run looks at, without the model: THIS org's feed entries, live docs and decisions that its
 * own full-text index matches against the tag's name and description, that do not carry the tag, and on
 * which a person has not already dismissed it — newest first, at most `CANDIDATE_CAP`.
 */
export async function fitCandidates(ctx: TenantContext, tag: string, description: string): Promise<FitCandidate[]> {
  const q = fitQuery(tag, description);
  const matched = q ? await keywordCandidates(ctx, tag, q) : [];
  if (matched.length >= TOP_UP_TO) return matched;
  // Too few matched the tag's words: the newest other items, so the model still judges something.
  const more = await newestCandidates(ctx, tag, TOP_UP_TO);
  const held = new Set(matched.map((c) => `${c.type}:${c.id}`));
  return [...matched, ...more.filter((c) => !held.has(`${c.type}:${c.id}`))].slice(0, Math.max(TOP_UP_TO, matched.length));
}

/** `NOT EXISTS` clauses: the item does not carry the tag, and no one has said no to it there — a dismissed or open
 *  suggestion, a person's removal of a tag a run had added (`removed`), or an undone run (`undone`). */
const notTagged = (type: TagItemType, idExpr: string) =>
  `NOT EXISTS (SELECT 1 FROM entry_tags et WHERE et.org_id = ? AND et.entry_type = '${type}' AND et.entry_id = ${idExpr} AND et.tag = ?)
   AND NOT EXISTS (SELECT 1 FROM org_tag_suggestions s WHERE s.org_id = ? AND s.entry_type = '${type}' AND s.entry_id = ${idExpr} AND s.tag = ? AND s.state IN ('dismissed', 'open', 'removed', 'undone'))`;
const byNewest = (a: FitCandidate, b: FitCandidate): number => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0);

/** The newest feed entries, live docs and decisions of THIS org that are not tagged and not dismissed for it. */
async function newestCandidates(ctx: TenantContext, tag: string, limit: number): Promise<FitCandidate[]> {
  const o = ctx.orgId;
  const [feed, docs, adrs] = await Promise.all([
    all<{ id: number; summary: string; brief: string | null; body: string | null; created_at: string }>(ctx,
      `SELECT f.id, f.summary, f.brief, f.body, f.created_at FROM feed f WHERE f.org_id = ? AND ${notTagged("feed", "CAST(f.id AS TEXT)")}
        ORDER BY f.created_at DESC, f.id DESC LIMIT ${limit}`, o, o, tag, o, tag),
    all<{ slug: string; title: string; body: string; updated_at: string | null }>(ctx,
      `SELECT d.slug, d.title, d.body, d.updated_at FROM docs d WHERE d.org_id = ? AND d.current_version > 0 AND ${notTagged("doc", "d.slug")}
        ORDER BY d.updated_at DESC, d.slug LIMIT ${limit}`, o, o, tag, o, tag),
    all<{ id: number; title: string; decision: string | null; created_at: string }>(ctx,
      `SELECT a.id, a.title, a.decision, a.created_at FROM adrs a WHERE a.org_id = ? AND a.status != 'rejected' AND ${notTagged("adr", "CAST(a.id AS TEXT)")}
        ORDER BY a.created_at DESC, a.id DESC LIMIT ${limit}`, o, o, tag, o, tag),
  ]);
  const cut = (s: string) => excerptOf(s, TITLE_MAX);
  return [
    ...feed.map((f) => ({ type: "feed" as const, id: String(f.id), title: cut(f.summary), text: excerptOf(f.brief ?? f.body), at: f.created_at, evidence: null })),
    ...docs.map((d) => ({ type: "doc" as const, id: d.slug, title: cut(d.title), text: excerptOf(d.body), at: d.updated_at ?? "", evidence: null })),
    ...adrs.map((a) => ({ type: "adr" as const, id: String(a.id), title: cut(a.title), text: excerptOf(a.decision), at: a.created_at, evidence: null })),
  ].sort(byNewest).slice(0, limit);
}

/** The items whose text the org's full-text index matches against the tag's words. */
async function keywordCandidates(ctx: TenantContext, tag: string, q: string): Promise<FitCandidate[]> {
  const o = ctx.orgId;
  const [feed, docs, adrs] = await Promise.all([
    all<{ id: number; summary: string; brief: string | null; body: string | null; created_at: string; snip: string | null }>(ctx,
      `SELECT f.id, f.summary, f.brief, f.body, f.created_at, snippet(feed_fts, -1, ${SNIP}) AS snip FROM feed_fts JOIN feed f ON f.org_id = ? AND CAST(f.id AS TEXT) = feed_fts.feed_id
        WHERE feed_fts MATCH ? AND feed_fts.org_id = ? AND ${notTagged("feed", "CAST(f.id AS TEXT)")}
        ORDER BY f.created_at DESC, f.id DESC LIMIT ${CANDIDATE_CAP}`, o, q, o, o, tag, o, tag),
    all<{ slug: string; title: string; body: string; updated_at: string | null; snip: string | null }>(ctx,
      `SELECT d.slug, d.title, d.body, d.updated_at, snippet(docs_fts, -1, ${SNIP}) AS snip FROM docs_fts JOIN docs d ON d.org_id = ? AND d.slug = docs_fts.slug
        WHERE docs_fts MATCH ? AND docs_fts.org_id = ? AND d.current_version > 0 AND ${notTagged("doc", "d.slug")}
        ORDER BY d.updated_at DESC, d.slug LIMIT ${CANDIDATE_CAP}`, o, q, o, o, tag, o, tag),
    all<{ id: number; title: string; decision: string | null; created_at: string; snip: string | null }>(ctx,
      `SELECT a.id, a.title, a.decision, a.created_at, snippet(adrs_fts, -1, ${SNIP}) AS snip FROM adrs_fts JOIN adrs a ON a.org_id = ? AND CAST(a.id AS TEXT) = adrs_fts.adr_id
        WHERE adrs_fts MATCH ? AND adrs_fts.org_id = ? AND a.status != 'rejected' AND ${notTagged("adr", "CAST(a.id AS TEXT)")}
        ORDER BY a.created_at DESC, a.id DESC LIMIT ${CANDIDATE_CAP}`, o, q, o, o, tag, o, tag),
  ]);
  const cut = (s: string) => excerptOf(s, TITLE_MAX);
  const out: FitCandidate[] = [
    ...feed.map((f) => ({ type: "feed" as const, id: String(f.id), title: cut(f.summary), text: excerptOf(f.brief ?? f.body), at: f.created_at, evidence: evidenceOf(f.snip) })),
    ...docs.map((d) => ({ type: "doc" as const, id: d.slug, title: cut(d.title), text: excerptOf(d.body), at: d.updated_at ?? "", evidence: evidenceOf(d.snip) })),
    ...adrs.map((a) => ({ type: "adr" as const, id: String(a.id), title: cut(a.title), text: excerptOf(a.decision), at: a.created_at, evidence: evidenceOf(a.snip) })),
  ];
  return out.sort(byNewest).slice(0, CANDIDATE_CAP);
}

// ── a run ────────────────────────────────────────────────────────────────────

export type FitStart =
  | { status: "started"; run: number }
  | { status: "off" | "no_key" | "busy" | "capped" | "not_found" };

/**
 * Begin a run for `tag` — the checks a person waits on, and the run's row. Nothing is sent here; the
 * caller hands `continueTagFit` to the request's `waitUntil`. Refused (no row, no call) when the
 * platform has no key, the org's switch is off, the tag is not live, the month's allowance is spent, or
 * a run for the tag is already going.
 */
export async function startTagFit(env: Pick<Env, "TYPESAFE_API_KEY">, ctx: TenantContext, rawTag: unknown): Promise<FitStart> {
  const tag = normalizeTagName(rawTag);
  if (!tag) return { status: "not_found" };
  if (!env.TYPESAFE_API_KEY) return { status: "no_key" };
  if (!(await aiEnabled(ctx))) return { status: "off" };
  const row = await first<{ retired_at: string | null }>(ctx, `SELECT retired_at FROM org_tags WHERE org_id = ? AND name = ?`, ctx.orgId, tag);
  if (!row || row.retired_at !== null) return { status: "not_found" };
  if ((await suggestAllowance(ctx)).spent) return { status: "capped" };
  const at = nowIso();
  // A run whose Worker died is let go, so it never blocks the tag for good.
  await run(ctx, `UPDATE org_tag_runs SET status = 'failed', ended_at = ? WHERE org_id = ? AND tag = ? AND status = 'running' AND started_at < ?`,
    at, ctx.orgId, tag, new Date(Date.now() - STALE_MS).toISOString());
  try {
    const res = await run(ctx, `INSERT INTO org_tag_runs (org_id, tag, status, started_by, started_at) VALUES (?, ?, 'running', ?, ?)`, ctx.orgId, tag, ctx.userId, at);
    return { status: "started", run: res.meta.last_row_id as number };
  } catch (e) {
    if (/UNIQUE constraint failed/i.test(e instanceof Error ? e.message : String(e))) return { status: "busy" };
    throw e;
  }
}

export interface FitRunOpts {
  /** The classify call. Default: Jev with the platform key (`TYPESAFE_API_KEY`). */
  classifier?: Classifier;
  /** Test seams for the default classifier: its fetch (stubbed at the Response level), timeout, retry delay. */
  jev?: ClassifierOpts;
}

/**
 * The run itself, in the background: supersede the tag's open model suggestions, pre-select candidates,
 * then ask about each one — every request counted BEFORE it is made, and refused once the allowance is
 * spent or the switch is off — and store each confident "fits". Never throws; ends the run's row with
 * what happened (`capped` when the allowance stopped it, `failed` when the provider did).
 */
export async function continueTagFit(env: Env, ctx: TenantContext, runId: number, rawTag: string, opts: FitRunOpts = {}): Promise<TagRunDTO["status"]> {
  const tag = normalizeTagName(rawTag) ?? "";
  let calls = 0, added = 0, candidates = 0;
  let status: TagRunDTO["status"] = "done";
  try {
    const desc = (await first<{ description: string }>(ctx, `SELECT description FROM org_tags WHERE org_id = ? AND name = ?`, ctx.orgId, tag))?.description ?? "";
    await run(ctx, `UPDATE org_tag_suggestions SET state = 'superseded', resolved_at = ? WHERE org_id = ? AND tag = ? AND source = 'model' AND state = 'open'`, nowIso(), ctx.orgId, tag);
    const list = await fitCandidates(ctx, tag, desc);
    candidates = list.length;
    // The run, as it goes: what the Tags tab draws live (`GET …/tags/:name/run`).
    let checked = 0;
    const progress = (): Promise<unknown> =>
      run(ctx, `UPDATE org_tag_runs SET candidates = ?, calls = ?, checked = ?, added = ? WHERE org_id = ? AND id = ? AND status = 'running'`,
        candidates, calls, checked, added, ctx.orgId, runId).catch(() => undefined);
    await progress();
    const classifier = opts.classifier ?? (env.TYPESAFE_API_KEY ? jevClassifier(env.TYPESAFE_API_KEY, opts.jev) : null);
    if (!classifier) status = "failed";
    else if (list.length) {
      let capped = false;
      const result = await classifier.classify({
        kind: TAG_FIT_KIND,
        question: `Is this item about the tag "${tag}"${desc ? ` (${desc})` : ""}? Say yes only when the item is clearly about it.`,
        criteria: {
          true: `The item is about ${tag}${desc ? `: ${desc}` : ""}.`,
          false: `The item is not about ${tag}, or only mentions it in passing.`,
        },
        answers: FIT_ANSWERS,
        items: list.map((c, k) => ({ id: String(k), text: `${c.title}${c.text ? `\n\n${c.text}` : ""}`, evidence: c.evidence })),
      }, {
        // Before EACH request: the switch can be turned off mid-run, and the month's allowance is
        // checked — then the request is counted, before it is made.
        gate: async () => {
          if (!(await aiEnabled(ctx))) return false;
          if ((await suggestAllowance(ctx)).spent) { capped = true; return false; }
          await meter(platform(env, ctx.userId), ctx.orgId, ctx.userId, METRIC_AI_SUGGEST);
          calls++;
          return true;
        },
        // Each answer as it comes: a confident "fits" ADDS the tag to the item at once — the entry_tags row
        // and its provenance in ONE batch — and the run's counts move on.
        onItem: async (it, j) => {
          checked++;
          if (j && j.answer === FIT_ANSWERS[0] && j.confidence >= FIT_THRESHOLD) {
            const c = list[Number(it.id)];
            const at = nowIso();
            const [tagged] = await batch(ctx, [
              stmt(ctx, `INSERT OR IGNORE INTO entry_tags (org_id, tag, entry_type, entry_id) VALUES (?, ?, ?, ?)`, ctx.orgId, tag, c.type, c.id),
              stmt(ctx,
                `INSERT INTO org_tag_suggestions (org_id, entry_type, entry_id, tag, source, confidence, reason, model, prompt_version, suggested_by, suggested_at,
                                                  state, resolved_to, resolved_at, resolved_by, run_id)
                 SELECT ?, ?, ?, ?, 'model', ?, ?, ?, ?, 'system', ?, 'accepted', ?, ?, '${JEV_ACTOR}', ? WHERE changes() > 0`,
                ctx.orgId, c.type, c.id, tag, j.confidence, j.reason ?? scoreReason(j.confidence), j.model, classifier.promptVersion, at, tag, at, runId),
            ]);
            added += tagged.meta.changes ?? 0;
          }
          await progress();
        },
      });
      calls = result.calls;
      if (capped) status = "capped";
      else if (result.stopped === "provider") status = "failed";
    }
  } catch (e) {
    status = "failed";
    console.error("tag fit run failed", e instanceof Error ? e.name : "error", `org=${ctx.orgId}`);
  }
  const end = nowIso();
  // The run's end, and ONE audit row for it (counts only), in one batch.
  await batch(ctx, [
    stmt(ctx, `UPDATE org_tag_runs SET status = ?, ended_at = ?, candidates = ?, calls = ?, added = MAX(added, ?) WHERE org_id = ? AND id = ?`,
      status, end, candidates, calls, added, ctx.orgId, runId),
    auditStmt(ctx, "tag.fit", tag, { run: runId, status, candidates, calls, added }, end),
  ]).catch(() => undefined);
  return status;
}

/** Start and finish a run in one go (Find items without a `waitUntil`, and tests). */
export async function runTagFit(env: Env, ctx: TenantContext, tag: string, opts: FitRunOpts = {}): Promise<FitStart["status"] | TagRunDTO["status"]> {
  const s = await startTagFit(env, ctx, tag);
  return s.status === "started" ? continueTagFit(env, ctx, s.run, tag, opts) : s.status;
}

// ── the result, and the way back ─────────────────────────────────────────────

/** Per live tag: its latest run. */
export async function fitSummary(ctx: TenantContext): Promise<{ runs: Map<string, TagRunDTO> }> {
  const runs = await all<TagRunDTO & { tag: string }>(ctx,
    `SELECT r.tag, r.id, r.status, r.started_at, r.ended_at, r.candidates, r.checked, r.added, r.undone_at FROM org_tag_runs r
      WHERE r.org_id = ? AND r.id = (SELECT MAX(x.id) FROM org_tag_runs x WHERE x.org_id = ? AND x.tag = r.tag)`, ctx.orgId, ctx.orgId);
  return { runs: new Map(runs.map(({ tag, ...r }) => [tag, r])) };
}

/** The latest run for `tag` (admin+), live while it runs — what the Tags tab polls to draw it. null = none. */
export async function tagRun(ctx: TenantContext, rawTag: unknown): Promise<TagRunDTO | null> {
  requireRole(ctx, "admin");
  const tag = normalizeTagName(rawTag);
  if (!tag) throw new TagError("not_found", 404, "no such tag");
  return first<TagRunDTO>(ctx,
    `SELECT id, status, started_at, ended_at, candidates, checked, added, undone_at FROM org_tag_runs WHERE org_id = ? AND tag = ? ORDER BY id DESC LIMIT 1`, ctx.orgId, tag);
}

/**
 * Undo a run (admin+): remove EXACTLY the tags that run added and that are still there — nothing a person
 * added, nothing another run added — and mark those rows `undone`, so no later run adds them again.
 * `runId` omitted = the tag's latest run. Audited `tag.fit.undo`. Idempotent: a second undo removes nothing.
 */
export async function undoTagFit(ctx: TenantContext, rawTag: unknown, runId?: unknown): Promise<{ removed: number }> {
  requireRole(ctx, "admin");
  const tag = normalizeTagName(rawTag);
  if (!tag) throw new TagError("not_found", 404, "no such tag");
  if (runId !== undefined && (typeof runId !== "number" || !Number.isInteger(runId))) throw new TagError("invalid", 400, "run must be a run id", "run");
  const r = await first<{ id: number; status: string }>(ctx,
    runId === undefined
      ? `SELECT id, status FROM org_tag_runs WHERE org_id = ? AND tag = ? ORDER BY id DESC LIMIT 1`
      : `SELECT id, status FROM org_tag_runs WHERE org_id = ? AND tag = ? AND id = ?`,
    ...(runId === undefined ? [ctx.orgId, tag] : [ctx.orgId, tag, runId]));
  if (!r) throw new TagError("not_found", 404, "no such run");
  if (r.status === "running") throw new TagError("run_running", 409, "wait for the run to finish, then undo it");
  const rows = await all<{ id: number; entry_type: string; entry_id: string }>(ctx,
    `SELECT id, entry_type, entry_id FROM org_tag_suggestions WHERE org_id = ? AND tag = ? AND source = 'model' AND run_id = ? AND state = 'accepted'`, ctx.orgId, tag, r.id);
  const at = nowIso();
  await batch(ctx, [
    ...rows.flatMap((x) => [
      stmt(ctx, `DELETE FROM entry_tags WHERE org_id = ? AND tag = ? AND entry_type = ? AND entry_id = ?`, ctx.orgId, tag, x.entry_type, x.entry_id),
      stmt(ctx, `UPDATE org_tag_suggestions SET state = 'undone', resolved_at = ?, resolved_by = ? WHERE org_id = ? AND id = ? AND state = 'accepted'`, at, ctx.userId, ctx.orgId, x.id),
    ]),
    stmt(ctx, `UPDATE org_tag_runs SET undone_at = COALESCE(undone_at, ?), undone_by = COALESCE(undone_by, ?) WHERE org_id = ? AND id = ?`, at, ctx.userId, ctx.orgId, r.id),
    auditStmt(ctx, "tag.fit.undo", tag, { run: r.id, items: rows.length }, at),
  ]);
  return { removed: rows.length };
}

/** A PERSON removed `tag` from an item: if a run had added it there, remember that (`removed`), so no later
 *  run adds it again. A statement of the removal's own batch (src/tools/tags.ts `setItemTags`). */
export const rememberRemovalStmt = (ctx: TenantContext, tag: string, type: TagItemType, id: string, at: string): Stmt =>
  stmt(ctx, `UPDATE org_tag_suggestions SET state = 'removed', resolved_at = ?, resolved_by = ? WHERE org_id = ? AND tag = ? AND entry_type = ? AND entry_id = ? AND source = 'model' AND state = 'accepted'`,
    at, ctx.userId, ctx.orgId, tag, type, id);

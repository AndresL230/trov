// "Which existing items fit this tag?" — the first use of instant intelligence (issues #154–#158, #166):
// when an admin creates a tag, a model suggests which of the org's feed entries, docs and decisions should
// carry it, and an admin accepts or dismisses each suggestion.
//
// The rules that bind it (#154):
//   • SUGGESTIONS, NEVER ACTIONS. A run writes `org_tag_suggestions` rows (`source = 'model'`) and nothing
//     else; an item gets the tag only when an admin accepts (`resolveFits`, an authored write).
//   • NEVER ON A RENDER PATH. A run starts after a tag is added (or a suggested one accepted) and from
//     "Find items" — in the background (`waitUntil`), never while a page loads.
//   • A FIXED SET OF ANSWERS: "fits" / "does not fit", through the one classify call (./classify.ts).
//   • NEVER GUESS ON READ. Only "fits" at or above `FIT_THRESHOLD` is stored; anything else is no row.
//   • METERED. Every model call counts against the month's `ai_suggestions` (shared/plans.ts); past it the
//     run stops (`capped`) and the Tags tab says so.
//   • CONSENT. Nothing is sent unless an admin turned the org's switch on (`org_ai_settings`, kind
//     `tag.fit`), and the platform has a key. What is sent: an id, a title and an excerpt of at most
//     `EXCERPT_MAX` characters — code blocks, inline code and anything shaped like a credential removed —
//     of THIS org's items only, picked without the model first by the org's own full-text index.
import type { Env } from "../env";
import { isTagItemType, normalizeTagName, type TagFitDTO, type TagItemType, type TagRunDTO } from "@shared/tags-core";
import { planRefusal, resolveEntitlements } from "@shared/plans";
import { platform, requireRole, type TenantContext } from "../data/context";
import { METRIC_AI_SUGGEST, meter } from "../data/meter";
import { all, batch, first, nowIso, run, stmt, type Stmt } from "../data/sql";
import { planFor, suggestionsUsed } from "../plans/gate";
import { geminiClassifier, type Classifier, type ClassifierOpts } from "./classify";
import { TagError } from "./tags";

export const TAG_FIT_KIND = "tag.fit";
export const FIT_ANSWERS = ["fits", "does not fit"] as const;
/** Only a "fits" this sure is stored. */
export const FIT_THRESHOLD = 0.7;
/** At most this many items are pre-selected for one run… */
export const CANDIDATE_CAP = 60;
/** …and sent this many to a call. */
export const FIT_BATCH = 20;
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
  // The one question (shared/plans.ts): may this org make one more `ai_suggestions` call?
  return { used, cap: resolveEntitlements(plan.plan, plan.overrides).ai_suggestions, spent: planRefusal(plan, "ai_suggestions", used, 1) !== null };
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

export interface FitCandidate { type: TagItemType; id: string; title: string; text: string; at: string }

/**
 * The items a run looks at, without the model: THIS org's feed entries, live docs and decisions that its
 * own full-text index matches against the tag's name and description, that do not carry the tag, and on
 * which a person has not already dismissed it — newest first, at most `CANDIDATE_CAP`.
 */
export async function fitCandidates(ctx: TenantContext, tag: string, description: string): Promise<FitCandidate[]> {
  const q = fitQuery(tag, description);
  if (!q) return [];
  const notTagged = (type: TagItemType, idExpr: string) =>
    `NOT EXISTS (SELECT 1 FROM entry_tags et WHERE et.org_id = ? AND et.entry_type = '${type}' AND et.entry_id = ${idExpr} AND et.tag = ?)
     AND NOT EXISTS (SELECT 1 FROM org_tag_suggestions s WHERE s.org_id = ? AND s.entry_type = '${type}' AND s.entry_id = ${idExpr} AND s.tag = ? AND s.state IN ('dismissed', 'open'))`;
  const o = ctx.orgId;
  const [feed, docs, adrs] = await Promise.all([
    all<{ id: number; summary: string; brief: string | null; body: string | null; created_at: string }>(ctx,
      `SELECT f.id, f.summary, f.brief, f.body, f.created_at FROM feed_fts JOIN feed f ON f.org_id = ? AND CAST(f.id AS TEXT) = feed_fts.feed_id
        WHERE feed_fts MATCH ? AND feed_fts.org_id = ? AND ${notTagged("feed", "CAST(f.id AS TEXT)")}
        ORDER BY f.created_at DESC, f.id DESC LIMIT ${CANDIDATE_CAP}`, o, q, o, o, tag, o, tag),
    all<{ slug: string; title: string; body: string; updated_at: string | null }>(ctx,
      `SELECT d.slug, d.title, d.body, d.updated_at FROM docs_fts JOIN docs d ON d.org_id = ? AND d.slug = docs_fts.slug
        WHERE docs_fts MATCH ? AND docs_fts.org_id = ? AND d.current_version > 0 AND ${notTagged("doc", "d.slug")}
        ORDER BY d.updated_at DESC, d.slug LIMIT ${CANDIDATE_CAP}`, o, q, o, o, tag, o, tag),
    all<{ id: number; title: string; decision: string | null; created_at: string }>(ctx,
      `SELECT a.id, a.title, a.decision, a.created_at FROM adrs_fts JOIN adrs a ON a.org_id = ? AND CAST(a.id AS TEXT) = adrs_fts.adr_id
        WHERE adrs_fts MATCH ? AND adrs_fts.org_id = ? AND a.status != 'rejected' AND ${notTagged("adr", "CAST(a.id AS TEXT)")}
        ORDER BY a.created_at DESC, a.id DESC LIMIT ${CANDIDATE_CAP}`, o, q, o, o, tag, o, tag),
  ]);
  const cut = (s: string) => excerptOf(s, TITLE_MAX);
  const out: FitCandidate[] = [
    ...feed.map((f) => ({ type: "feed" as const, id: String(f.id), title: cut(f.summary), text: excerptOf(f.brief ?? f.body), at: f.created_at })),
    ...docs.map((d) => ({ type: "doc" as const, id: d.slug, title: cut(d.title), text: excerptOf(d.body), at: d.updated_at ?? "" })),
    ...adrs.map((a) => ({ type: "adr" as const, id: String(a.id), title: cut(a.title), text: excerptOf(a.decision), at: a.created_at })),
  ];
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, CANDIDATE_CAP);
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
export async function startTagFit(env: Pick<Env, "GEMINI_API_KEY">, ctx: TenantContext, rawTag: unknown): Promise<FitStart> {
  const tag = normalizeTagName(rawTag);
  if (!tag) return { status: "not_found" };
  if (!env.GEMINI_API_KEY) return { status: "no_key" };
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
  /** The classify call (tests inject a stub). Default: Gemini with the platform key. */
  classifier?: Classifier;
  gemini?: ClassifierOpts;
}

/**
 * The run itself, in the background: supersede the tag's open model suggestions, pre-select candidates,
 * then ask in batches — each call counted BEFORE it is made, and refused once the allowance is spent —
 * and store each confident "fits". Never throws; ends the run's row with what happened.
 */
export async function continueTagFit(env: Env, ctx: TenantContext, runId: number, rawTag: string, opts: FitRunOpts = {}): Promise<TagRunDTO["status"]> {
  const tag = normalizeTagName(rawTag) ?? "";
  let calls = 0, suggested = 0, candidates = 0;
  let status: TagRunDTO["status"] = "done";
  try {
    const desc = (await first<{ description: string }>(ctx, `SELECT description FROM org_tags WHERE org_id = ? AND name = ?`, ctx.orgId, tag))?.description ?? "";
    await run(ctx, `UPDATE org_tag_suggestions SET state = 'superseded', resolved_at = ? WHERE org_id = ? AND tag = ? AND source = 'model' AND state = 'open'`, nowIso(), ctx.orgId, tag);
    const list = await fitCandidates(ctx, tag, desc);
    candidates = list.length;
    const classifier = opts.classifier ?? (env.GEMINI_API_KEY ? geminiClassifier(env.GEMINI_API_KEY, opts.gemini) : null);
    if (!classifier) status = "failed";
    for (let i = 0; classifier && i < list.length; i += FIT_BATCH) {
      // The switch can be turned off mid-run: nothing more is sent.
      if (!(await aiEnabled(ctx))) break;
      if ((await suggestAllowance(ctx)).spent) { status = "capped"; break; }
      const chunk = list.slice(i, i + FIT_BATCH);
      await meter(platform(env, ctx.userId), ctx.orgId, ctx.userId, METRIC_AI_SUGGEST);
      calls++;
      const judged = await classifier.classify({
        kind: TAG_FIT_KIND,
        question: `Does this item belong under the tag "${tag}"${desc ? ` (${desc})` : ""}? Answer "fits" only when the item is clearly about it.`,
        answers: FIT_ANSWERS,
        items: chunk.map((c, k) => ({ id: String(k), text: `${c.title}${c.text ? ` — ${c.text}` : ""}` })),
      });
      const at = nowIso();
      const keep = (judged ?? []).filter((j) => j.answer === "fits" && j.confidence >= FIT_THRESHOLD);
      if (keep.length) {
        await batch(ctx, keep.map((j) => {
          const c = chunk[Number(j.id)];
          return stmt(ctx,
            `INSERT OR IGNORE INTO org_tag_suggestions (org_id, entry_type, entry_id, tag, source, confidence, reason, model, prompt_version, suggested_by, suggested_at)
             VALUES (?, ?, ?, ?, 'model', ?, ?, ?, ?, 'system', ?)`,
            ctx.orgId, c.type, c.id, tag, j.confidence, j.reason, classifier.model, classifier.promptVersion, at);
        }));
        suggested += keep.length;
      }
    }
  } catch (e) {
    status = "failed";
    console.error("tag fit run failed", e instanceof Error ? e.name : "error", `org=${ctx.orgId}`);
  }
  await run(ctx, `UPDATE org_tag_runs SET status = ?, ended_at = ?, candidates = ?, calls = ?, suggested = ? WHERE org_id = ? AND id = ?`,
    status, nowIso(), candidates, calls, suggested, ctx.orgId, runId).catch(() => undefined);
  return status;
}

/** Start and finish a run in one go (Find items without a `waitUntil`, and tests). */
export async function runTagFit(env: Env, ctx: TenantContext, tag: string, opts: FitRunOpts = {}): Promise<FitStart["status"] | TagRunDTO["status"]> {
  const s = await startTagFit(env, ctx, tag);
  return s.status === "started" ? continueTagFit(env, ctx, s.run, tag, opts) : s.status;
}

// ── review ───────────────────────────────────────────────────────────────────

/** Per live tag: how many open model suggestions it has, and its latest run. */
export async function fitSummary(ctx: TenantContext): Promise<{ fits: Map<string, number>; runs: Map<string, TagRunDTO> }> {
  const [counts, runs] = await Promise.all([
    all<{ tag: string; n: number }>(ctx, `SELECT tag, COUNT(*) AS n FROM org_tag_suggestions WHERE org_id = ? AND source = 'model' AND state = 'open' GROUP BY tag`, ctx.orgId),
    all<TagRunDTO & { tag: string }>(ctx,
      `SELECT r.tag, r.status, r.started_at, r.ended_at, r.suggested FROM org_tag_runs r
        WHERE r.org_id = ? AND r.id = (SELECT MAX(x.id) FROM org_tag_runs x WHERE x.org_id = ? AND x.tag = r.tag)`, ctx.orgId, ctx.orgId),
  ]);
  return {
    fits: new Map(counts.map((c) => [c.tag, c.n])),
    runs: new Map(runs.map(({ tag, ...r }) => [tag, r])),
  };
}

/** The open model suggestions for `tag` (admin+): each item's title, the reason, how sure. */
export async function listFits(ctx: TenantContext, rawTag: unknown): Promise<TagFitDTO[]> {
  requireRole(ctx, "admin");
  const tag = normalizeTagName(rawTag);
  if (!tag) throw new TagError("not_found", 404, "no such tag");
  const rows = await all<{ entry_type: string; entry_id: string; reason: string | null; confidence: number | null; suggested_at: string; title: string | null }>(ctx,
    `SELECT s.entry_type, s.entry_id, s.reason, s.confidence, s.suggested_at,
            COALESCE(
              (SELECT f.summary FROM feed f WHERE s.entry_type = 'feed' AND f.org_id = ? AND CAST(f.id AS TEXT) = s.entry_id),
              (SELECT d.title FROM docs d WHERE s.entry_type = 'doc' AND d.org_id = ? AND d.slug = s.entry_id),
              (SELECT a.title FROM adrs a WHERE s.entry_type = 'adr' AND a.org_id = ? AND CAST(a.id AS TEXT) = s.entry_id)) AS title
       FROM org_tag_suggestions s
      WHERE s.org_id = ? AND s.tag = ? AND s.source = 'model' AND s.state = 'open'
      ORDER BY s.confidence DESC, s.suggested_at DESC, s.id`, ctx.orgId, ctx.orgId, ctx.orgId, ctx.orgId, tag);
  // A suggestion with no reason, or whose item is gone, is not shown (#157).
  return rows.filter((r) => isTagItemType(r.entry_type) && r.title !== null && r.reason)
    .map((r) => ({ type: r.entry_type as TagItemType, id: r.entry_id, title: r.title as string, reason: r.reason as string, confidence: r.confidence ?? 0, suggested_at: r.suggested_at }));
}

/**
 * Accept or dismiss model suggestions for `tag` (admin+): `items` names some, or none = all of them.
 * Accept gives each item the tag — an ordinary authored write by this admin — and marks the row accepted;
 * dismiss marks it dismissed, which the next run remembers (`fitCandidates` skips it). Audited.
 */
export async function resolveFits(ctx: TenantContext, rawTag: unknown, input: { resolution?: unknown; items?: unknown }): Promise<{ resolved: number }> {
  requireRole(ctx, "admin");
  const tag = normalizeTagName(rawTag);
  if (!tag) throw new TagError("not_found", 404, "no such tag");
  if (input.resolution !== "accept" && input.resolution !== "dismiss") throw new TagError("invalid", 400, "resolution must be accept or dismiss", "resolution");
  const accept = input.resolution === "accept";
  if (accept) {
    const row = await first<{ retired_at: string | null }>(ctx, `SELECT retired_at FROM org_tags WHERE org_id = ? AND name = ?`, ctx.orgId, tag);
    if (!row || row.retired_at !== null) throw new TagError("unknown_tag", 400, "that tag is not on the list");
  }
  let picked: { type: TagItemType; id: string }[] | null = null;
  if (input.items !== undefined) {
    if (!Array.isArray(input.items) || input.items.length === 0 || input.items.length > 200) throw new TagError("invalid", 400, "items must be a list of 1–200", "items");
    picked = input.items.map((x) => {
      const o = x as { type?: unknown; id?: unknown };
      if (!isTagItemType(o?.type) || typeof o.id !== "string" || !o.id) throw new TagError("invalid", 400, "each item is { type, id }", "items");
      return { type: o.type, id: o.id };
    });
  }
  const open = await all<{ id: number; entry_type: TagItemType; entry_id: string }>(ctx,
    `SELECT id, entry_type, entry_id FROM org_tag_suggestions WHERE org_id = ? AND tag = ? AND source = 'model' AND state = 'open'`, ctx.orgId, tag);
  const chosen = picked ? open.filter((r) => picked!.some((p) => p.type === r.entry_type && p.id === r.entry_id)) : open;
  if (chosen.length === 0) throw new TagError("not_found", 404, "no such suggestion");
  const at = nowIso();
  await batch(ctx, [
    ...chosen.flatMap((r) => [
      ...(accept ? [stmt(ctx, `INSERT OR IGNORE INTO entry_tags (org_id, tag, entry_type, entry_id) VALUES (?, ?, ?, ?)`, ctx.orgId, tag, r.entry_type, r.entry_id)] : []),
      stmt(ctx, `UPDATE org_tag_suggestions SET state = ?, resolved_to = ?, resolved_at = ?, resolved_by = ? WHERE org_id = ? AND id = ? AND state = 'open'`,
        accept ? "accepted" : "dismissed", accept ? tag : null, at, ctx.userId, ctx.orgId, r.id),
    ]),
    auditStmt(ctx, accept ? "tag.fit.accept" : "tag.fit.dismiss", tag, { items: chosen.length }, at),
  ]);
  return { resolved: chosen.length };
}


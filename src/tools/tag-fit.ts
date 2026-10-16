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
//   • NEVER ON A RENDER PATH, NEVER FROM MCP. The run — the only part that calls a model — is src/ai/sift.ts:
//     it starts after a tag is added (or a suggested one accepted) and from "Find items", in the background
//     (`waitUntil`), never while a page loads. THIS file holds the rest (candidates, switches, Undo, review)
//     and imports no model client, so src/tools/tags.ts (which MCP reaches) can use it.
//   • A FIXED SET OF ANSWERS: "fits" / "does not fit", through the `tag.fit` kind's provider (src/ai/client.ts:
//     TypeSafe AI's Jev, a non-generative decision model: a yes/no probability per item, and no text). The
//     REASON a suggestion shows is Trov's own evidence: the full-text snippet that made the item a candidate.
//   • TWO BANDS (the owner's numbers, 2026-10-14). A "fits" at `FIT_APPLY` (0.85) or more ADDS the tag on its own;
//     from `FIT_SUGGEST` (0.6) up to it, the item is SUGGESTED — an `open` model row a person adds or dismisses
//     (`settleFitSuggestion`, any member: putting a tag on an item is any member's act) — and below, nothing.
//     A suggestion a person adds is theirs (`resolved_by` = them), never "added by Sift", and no Undo takes it.
//   • METERED. Every model call counts against the month's `jev_checks` (shared/plans.ts); past it the
//     run stops (`capped`) and the Tags tab says so.
//   • CONSENT. Nothing is sent unless BOTH switches are on — the organization's AI switch (`orgs.ai_automation`,
//     Org settings › AI, which gates every AI feature) and Sift's own (`org_ai_settings`, kind `tag.fit`, which
//     an admin turns on) — and the platform has a key (`TYPESAFE_API_KEY`). What is sent, one item per request: a title and an excerpt of at most
//     `EXCERPT_MAX` characters — code blocks, inline code and anything shaped like a credential removed —
//     of THIS org's items only, picked without the model first by the org's own full-text index.
import { ITEM_TAGS_MAX, isTagItemType, normalizeTagName, type TagItemType, type TagRunDTO } from "@shared/tags-core";
import { planRefusal, resolveEntitlements } from "@shared/plans";
import { requireRole, type TenantContext } from "../data/context";
import { all, batch, first, nowIso, run, stmt, type Stmt } from "../data/sql";
import { planFor, suggestionsUsed } from "../plans/gate";
import { TagError } from "./tags";

export const TAG_FIT_KIND = "tag.fit";
/** Who a run's tags are recorded as resolved by: the model, never a person. A reserved word, not a handle. */
export const JEV_ACTOR = "jev";
export const FIT_ANSWERS = ["fits", "does not fit"] as const satisfies readonly [string, string];
/** A "fits" this sure adds the tag on its own. */
export const FIT_APPLY = 0.85;
/** A "fits" this sure (and below `FIT_APPLY`) is suggested for a person to add or dismiss; below, nothing. */
export const FIT_SUGGEST = 0.6;
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
/** One row of the org's admin trail for a Sift act (its switch, a run, an Undo). */
export const fitAuditStmt = (ctx: TenantContext, action: string, target: string, detail: Record<string, unknown>, at: string): Stmt =>
  stmt(ctx, `INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at) VALUES (?, ?, ?, ?, ?, ?)`,
    ctx.orgId, ctx.userId, action, target, JSON.stringify(detail), at);

// ── the switch ───────────────────────────────────────────────────────────────

/**
 * Both switches a Sift request needs, in ONE statement: the organization's AI switch (`orgs.ai_automation`,
 * 0055_ai — Org settings › AI, which gates every AI feature) and Sift's own (`org_ai_settings`, kind
 * `tag.fit` — off when there is no row). `on` only when both are. An org that is not there reads as off.
 * What src/ai/sift.ts asks before a run and before every request, so turning either off stops a run.
 */
export async function siftSwitches(ctx: TenantContext): Promise<{ org: boolean; sift: boolean; on: boolean }> {
  const r = await first<{ org: number; sift: number | null }>(ctx,
    `SELECT o.ai_automation AS org, (SELECT s.enabled FROM org_ai_settings s WHERE s.org_id = ?1 AND s.kind = ?2) AS sift FROM orgs o WHERE o.id = ?1`,
    ctx.orgId, TAG_FIT_KIND);
  const org = !!r && Number(r.org) !== 0;
  const sift = r?.sift === 1;
  return { org, sift, on: org && sift };
}

/** Is Sift's own switch for `kind` on? Off when there is no row. (Not the org's AI switch: `siftSwitches`.) */
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
    fitAuditStmt(ctx, on ? "ai.enable" : "ai.disable", kind, {}, at),
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

/** The states of an item's suggestion that keep Sift from asking about that tag there again: a person dismissed it, it
 *  is already waiting for one (`open`), a person took off a tag a run had added (`removed`), or a run was undone
 *  (`undone`). PERSON OVER AI: what a person said no to is never added or suggested again. */
const SAID_NO = `('dismissed', 'open', 'removed', 'undone')`;

/** `NOT EXISTS` clauses: the item does not carry the tag, and no one has said no to it there (`SAID_NO`). */
const notTagged = (type: TagItemType, idExpr: string) =>
  `NOT EXISTS (SELECT 1 FROM entry_tags et WHERE et.org_id = ? AND et.entry_type = '${type}' AND et.entry_id = ${idExpr} AND et.tag = ?)
   AND NOT EXISTS (SELECT 1 FROM org_tag_suggestions s WHERE s.org_id = ? AND s.entry_type = '${type}' AND s.entry_id = ${idExpr} AND s.tag = ? AND s.state IN ${SAID_NO})`;
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

// ── the question and the bands: ONE definition for the run and for new items ─
// Sift asks the same thing two ways: a RUN asks one tag of many existing items (src/ai/sift.ts `continueTagFit`),
// and the AI pass asks one NEW item about every active tag (src/ai/sift-items.ts, `card:tagfit:<type>:<id>`). Both
// read the question, the bands and the write from here, so they can never drift apart.

/** Sift's yes/no question about one tag (Jev `noul`: `instructions` + what yes and no mean). */
export function fitQuestion(tag: string, description: string): { instructions: string; criteria: { true: string; false: string } } {
  return {
    instructions: `Is this item about the tag "${tag}"${description ? ` (${description})` : ""}? Say yes only when the item is clearly about it.`,
    criteria: {
      true: `The item is about ${tag}${description ? `: ${description}` : ""}.`,
      false: `The item is not about ${tag}, or only mentions it in passing.`,
    },
  };
}

/** The two bands (the owner's numbers): a "fits" at `FIT_APPLY` or more ADDS the tag; from `FIT_SUGGEST` up to it,
 *  the tag is SUGGESTED; below — or a "does not fit" — nothing. */
export function fitBand(fits: boolean, confidence: number): "add" | "suggest" | null {
  if (!fits || !Number.isFinite(confidence)) return null;
  if (confidence >= FIT_APPLY) return "add";
  return confidence >= FIT_SUGGEST ? "suggest" : null;
}

/** One judgement to store: the item, the tag, how sure Jev was that it FITS, the reason (Trov's own evidence —
 *  never model text; null = the score, said as such), the model and prompt version, and the run it belongs to. */
export interface FitVerdict {
  type: TagItemType; id: string; tag: string;
  fits: boolean; confidence: number; reason: string | null; model: string; promptVersion: string; runId: number;
}

/**
 * Store one judgement by its band — the ONE writer of Sift's results:
 *   • `add`: the `entry_tags` row AND its provenance (`source = 'model'`, `accepted`, `resolved_by = 'jev'`, the run)
 *     in ONE batch, the provenance written only when the tag was not already there — what Undo removes;
 *   • `suggest`: an `open` model row for a person to add or dismiss (`settleFitSuggestion`);
 *   • otherwise nothing.
 * Returns what it did (`added` only when the tag was really added).
 */
export async function storeFit(ctx: TenantContext, v: FitVerdict): Promise<"added" | "suggested" | null> {
  const band = fitBand(v.fits, v.confidence);
  if (!band) return null;
  const reason = v.reason ?? scoreReason(v.confidence);
  const at = nowIso();
  if (band === "suggest") {
    await run(ctx,
      `INSERT OR IGNORE INTO org_tag_suggestions (org_id, entry_type, entry_id, tag, source, confidence, reason, model, prompt_version, suggested_by, suggested_at, state, run_id)
       VALUES (?, ?, ?, ?, 'model', ?, ?, ?, ?, 'system', ?, 'open', ?)`,
      ctx.orgId, v.type, v.id, v.tag, v.confidence, reason, v.model, v.promptVersion, at, v.runId);
    return "suggested";
  }
  const [tagged] = await batch(ctx, [
    stmt(ctx, `INSERT OR IGNORE INTO entry_tags (org_id, tag, entry_type, entry_id) VALUES (?, ?, ?, ?)`, ctx.orgId, v.tag, v.type, v.id),
    stmt(ctx,
      `INSERT INTO org_tag_suggestions (org_id, entry_type, entry_id, tag, source, confidence, reason, model, prompt_version, suggested_by, suggested_at,
                                        state, resolved_to, resolved_at, resolved_by, run_id)
       SELECT ?, ?, ?, ?, 'model', ?, ?, ?, ?, 'system', ?, 'accepted', ?, ?, '${JEV_ACTOR}', ? WHERE changes() > 0`,
      ctx.orgId, v.type, v.id, v.tag, v.confidence, reason, v.model, v.promptVersion, at, v.tag, at, v.runId),
  ]);
  return (tagged.meta.changes ?? 0) > 0 ? "added" : null;
}

// ── a NEW item (Sift on new items: the AI pass's `tag.fit` job, src/ai/sift-items.ts) ──

/** The most tags one new item is asked about in its ONE request (Jev answered 60 `noul` questions in one request,
 *  live, 2026-10-15). With more active tags, those whose words the item's text matches go first, then by name. */
export const NEW_ITEM_TAGS_MAX = 60;

/** A tag a new item may be asked about, and Trov's evidence for it there (null = none: the score is the reason). */
export interface ItemFitTag { name: string; description: string; evidence: string | null }
/** What the new-item job sends and what it may write: the item's title and excerpt (cut and scrubbed exactly as a
 *  run's candidates are), the tags to ask about, and how many more tags the item may carry (`ITEM_TAGS_MAX`). */
export interface ItemFitInput { type: TagItemType; id: string; title: string; text: string; tags: ItemFitTag[]; room: number }

const ITEM_ROW: Record<TagItemType, string> = {
  feed: `SELECT summary AS title, COALESCE(brief, body) AS text FROM feed WHERE org_id = ? AND CAST(id AS TEXT) = ?`,
  doc: `SELECT title, body AS text FROM docs WHERE org_id = ? AND slug = ? AND current_version > 0`,
  adr: `SELECT title, decision AS text FROM adrs WHERE org_id = ? AND CAST(id AS TEXT) = ? AND status != 'rejected'`,
};
/** The FTS snippet of the item's text around the tag's words — the same evidence a run shows (`evidenceOf`). */
const ITEM_SNIPPET: Record<TagItemType, string> = {
  feed: `SELECT snippet(feed_fts, -1, ${SNIP}) AS snip FROM feed_fts WHERE feed_fts MATCH ? AND feed_fts.org_id = ? AND feed_fts.feed_id = ? LIMIT 1`,
  doc: `SELECT snippet(docs_fts, -1, ${SNIP}) AS snip FROM docs_fts WHERE docs_fts MATCH ? AND docs_fts.org_id = ? AND docs_fts.slug = ? LIMIT 1`,
  adr: `SELECT snippet(adrs_fts, -1, ${SNIP}) AS snip FROM adrs_fts WHERE adrs_fts MATCH ? AND adrs_fts.org_id = ? AND adrs_fts.adr_id = ? LIMIT 1`,
};

/**
 * A new item's input, without the model: the item (a live doc, a feed entry, a decision that was not rejected) and
 * every ACTIVE tag (not retired) that it does not carry and that nobody said no to on it (`SAID_NO` — person over AI),
 * each with its evidence from the org's own full-text index. null = nothing to ask: the item is gone or not taggable
 * (an artifact cannot carry tags yet), it already carries `ITEM_TAGS_MAX`, or no tag is left to ask about.
 */
export async function itemFitInput(ctx: TenantContext, type: string, id: string): Promise<ItemFitInput | null> {
  if (!isTagItemType(type) || !id) return null;
  const o = ctx.orgId;
  const item = await first<{ title: string | null; text: string | null }>(ctx, ITEM_ROW[type], o, id);
  if (!item) return null;
  const held = await first<{ n: number }>(ctx, `SELECT COUNT(*) AS n FROM entry_tags WHERE org_id = ? AND entry_type = ? AND entry_id = ?`, o, type, id);
  const room = ITEM_TAGS_MAX - Number(held?.n ?? 0);
  if (room <= 0) return null;
  const tags = await all<{ name: string; description: string }>(ctx,
    `SELECT t.name, t.description FROM org_tags t
      WHERE t.org_id = ? AND t.retired_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM entry_tags et WHERE et.org_id = ? AND et.entry_type = ? AND et.entry_id = ? AND et.tag = t.name)
        AND NOT EXISTS (SELECT 1 FROM org_tag_suggestions s WHERE s.org_id = ? AND s.entry_type = ? AND s.entry_id = ? AND s.tag = t.name AND s.state IN ${SAID_NO})
      ORDER BY t.name`, o, o, type, id, o, type, id);
  if (!tags.length) return null;
  // Each tag's evidence in ONE batch: the snippet around its words, where the item's text has them.
  const asked = tags.map((t) => ({ ...t, q: fitQuery(t.name, t.description) }));
  const withQ = asked.filter((t): t is typeof t & { q: string } => t.q !== null);
  const snips = withQ.length ? await batch<{ snip: string | null }>(ctx, withQ.map((t) => stmt(ctx, ITEM_SNIPPET[type], t.q, o, id))) : [];
  const evidence = new Map(withQ.map((t, k) => {
    const row = snips[k]?.results?.[0];
    return [t.name, row ? evidenceOf(row.snip) : null] as const;
  }));
  const out: ItemFitTag[] = asked.map((t) => ({ name: t.name, description: t.description, evidence: evidence.get(t.name) ?? null }));
  // Matched tags first, so a cut keeps the likeliest.
  out.sort((a, b) => Number(b.evidence !== null) - Number(a.evidence !== null) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    type, id,
    title: excerptOf(item.title ?? "", TITLE_MAX),
    text: excerptOf(item.text),
    tags: out.slice(0, NEW_ITEM_TAGS_MAX),
    room,
  };
}

/**
 * Record ONE tag's result for a new item as a RUN of that tag (`org_tag_runs`, already `done`: one item checked), so
 * the Tags tab shows it as the tag's latest run and its Undo (`undoTagFit`) takes exactly what it added, like any
 * run's. Written only for a tag that got a band; one `tag.fit` audit row per run (counts only). Returns what was done.
 */
export async function storeNewItemFit(ctx: TenantContext, v: Omit<FitVerdict, "runId">): Promise<"added" | "suggested" | null> {
  if (!fitBand(v.fits, v.confidence)) return null;
  const at = nowIso();
  const res = await run(ctx,
    `INSERT INTO org_tag_runs (org_id, tag, status, started_by, started_at, ended_at, candidates, calls, checked, added) VALUES (?, ?, 'done', ?, ?, ?, 1, 1, 1, 0)`,
    ctx.orgId, v.tag, ctx.userId, at, at);
  const runId = Number(res.meta.last_row_id);
  const did = await storeFit(ctx, { ...v, runId });
  await batch(ctx, [
    stmt(ctx, `UPDATE org_tag_runs SET added = ? WHERE org_id = ? AND id = ?`, did === "added" ? 1 : 0, ctx.orgId, runId),
    fitAuditStmt(ctx, "tag.fit", v.tag, { run: runId, status: "done", item: `${v.type}:${v.id}`, candidates: 1, calls: 1, added: did === "added" ? 1 : 0, suggested: did === "suggested" ? 1 : 0 }, at),
  ]);
  return did;
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
    `SELECT id, entry_type, entry_id FROM org_tag_suggestions WHERE org_id = ? AND tag = ? AND source = 'model' AND run_id = ? AND state = 'accepted' AND resolved_by = '${JEV_ACTOR}'`, ctx.orgId, tag, r.id);
  const at = nowIso();
  await batch(ctx, [
    ...rows.flatMap((x) => [
      stmt(ctx, `DELETE FROM entry_tags WHERE org_id = ? AND tag = ? AND entry_type = ? AND entry_id = ?`, ctx.orgId, tag, x.entry_type, x.entry_id),
      stmt(ctx, `UPDATE org_tag_suggestions SET state = 'undone', resolved_at = ?, resolved_by = ? WHERE org_id = ? AND id = ? AND state = 'accepted'`, at, ctx.userId, ctx.orgId, x.id),
    ]),
    // What the run only SUGGESTED and nobody settled goes with it.
    stmt(ctx, `UPDATE org_tag_suggestions SET state = 'undone', resolved_at = ?, resolved_by = ? WHERE org_id = ? AND tag = ? AND source = 'model' AND run_id = ? AND state = 'open'`, at, ctx.userId, ctx.orgId, tag, r.id),
    stmt(ctx, `UPDATE org_tag_runs SET undone_at = COALESCE(undone_at, ?), undone_by = COALESCE(undone_by, ?) WHERE org_id = ? AND id = ?`, at, ctx.userId, ctx.orgId, r.id),
    fitAuditStmt(ctx, "tag.fit.undo", tag, { run: r.id, items: rows.length }, at),
  ]);
  return { removed: rows.length };
}

/** A PERSON removed `tag` from an item: if a run had added it there, remember that (`removed`), so no later
 *  run adds it again. A statement of the removal's own batch (src/tools/tags.ts `setItemTags`). */
export const rememberRemovalStmt = (ctx: TenantContext, tag: string, type: TagItemType, id: string, at: string): Stmt =>
  stmt(ctx, `UPDATE org_tag_suggestions SET state = 'removed', resolved_at = ?, resolved_by = ? WHERE org_id = ? AND tag = ? AND entry_type = ? AND entry_id = ? AND source = 'model' AND state = 'accepted'`,
    at, ctx.userId, ctx.orgId, tag, type, id);

/**
 * A person settles one of Sift's suggestions (any member — putting a tag on an item is any member's act; a cookie
 * route, never MCP): ADD puts the tag on the item and marks the row `accepted` by THEM (so it is theirs, not "added
 * by Sift", and no run's Undo takes it); DISMISS marks it `dismissed`, so no later run suggests it again.
 */
export async function settleFitSuggestion(ctx: TenantContext, rawTag: unknown, type: unknown, id: unknown, add: boolean): Promise<{ ok: true; tagged: boolean }> {
  const tag = normalizeTagName(rawTag);
  if (!tag) throw new TagError("not_found", 404, "no such tag");
  if (!isTagItemType(type)) throw new TagError("invalid", 400, "type must be feed, doc or adr", "type");
  if (typeof id !== "string" || !id || id.length > 200) throw new TagError("invalid", 400, "id must be the item's id", "id");
  const row = await first<{ id: number }>(ctx,
    `SELECT id FROM org_tag_suggestions WHERE org_id = ? AND tag = ? AND entry_type = ? AND entry_id = ? AND source = 'model' AND state = 'open'`, ctx.orgId, tag, type, id);
  if (!row) throw new TagError("not_found", 404, "no such suggestion");
  const at = nowIso();
  if (!add) {
    await run(ctx, `UPDATE org_tag_suggestions SET state = 'dismissed', resolved_at = ?, resolved_by = ? WHERE org_id = ? AND id = ? AND state = 'open'`, at, ctx.userId, ctx.orgId, row.id);
    return { ok: true, tagged: false };
  }
  const liveTag = await first<{ n: number }>(ctx, `SELECT 1 AS n FROM org_tags WHERE org_id = ? AND name = ? AND retired_at IS NULL`, ctx.orgId, tag);
  if (!liveTag) throw new TagError("not_found", 404, "that tag is not on the list any more");
  const has = await first<{ n: number }>(ctx, `SELECT COUNT(*) AS n FROM entry_tags WHERE org_id = ? AND entry_type = ? AND entry_id = ?`, ctx.orgId, type, id);
  if ((has?.n ?? 0) >= ITEM_TAGS_MAX) throw new TagError("invalid", 400, `an item carries at most ${ITEM_TAGS_MAX} tags`, "tags");
  await batch(ctx, [
    stmt(ctx, `INSERT OR IGNORE INTO entry_tags (org_id, tag, entry_type, entry_id) VALUES (?, ?, ?, ?)`, ctx.orgId, tag, type, id),
    stmt(ctx, `UPDATE org_tag_suggestions SET state = 'accepted', resolved_to = ?, resolved_at = ?, resolved_by = ? WHERE org_id = ? AND id = ? AND state = 'open'`, tag, at, ctx.userId, ctx.orgId, row.id),
  ]);
  return { ok: true, tagged: true };
}

/** Per live tag: how many of Sift's suggestions wait for a person (the Tags tab's "N to review"). */
export async function reviewCounts(ctx: TenantContext): Promise<Map<string, number>> {
  const rows = await all<{ tag: string; n: number }>(ctx,
    `SELECT tag, COUNT(*) AS n FROM org_tag_suggestions WHERE org_id = ? AND source = 'model' AND state = 'open' GROUP BY tag`, ctx.orgId);
  return new Map(rows.map((r) => [r.tag, r.n]));
}

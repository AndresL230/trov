// The organization's tag list (0054_org_tags; docs/architecture/feed-and-search.md › Tags).
//
// ONE list per org (`org_tags`), starting from the six starters. Three kinds of caller:
//   • an ADMIN changes the list — add, rename, edit, merge, retire, restore, and settle what agents
//     suggested. Every one is `requireRole(ctx, "admin")`, writes its `org_admin_audit` row in the SAME
//     batch, and is reached only from the cookie routes (src/routes.ts) — never from src/mcp.ts.
//   • a MEMBER reads the list and sets the tags of one item (`setItemTags`: an authored, direct write).
//   • the GATE (src/consumer.ts) asks `sortAgentTags` which of an agent's tags are on the list and
//     hands the rest to `recordTagSuggestions`. Nothing an agent sends adds a tag to the list.
//
// A tag is stored on an item by NAME (`entry_tags.tag`), so a rename rewrites the items' rows in the
// batch that renames the tag, and a merge moves them. Nothing is hard-deleted: a retired or merged tag
// keeps its row (its name stays reserved) and can be restored.
import {
  ITEM_TAGS_MAX, STARTER_TAGS, TAG_ITEM_TYPES, TAG_PAGE_LIMIT, cleanTagDescription, isTagColor, isTagItemType, nextTagColor, normalizeTagName, similarTag,
  type OrgTagDTO, type TagAuditAction, type TagColor, type TagCounts, type TagItemType, type TagListDTO, type TagPageDTO, type TagPageItem, type TagRef, type TagSuggestionDTO,
} from "@shared/tags-core";
import { requireRole, hasRole } from "../data/context";
import { all, batch, fanOut, first, nowIso, stmt, type Stmt, type TenantContext } from "../data/sql";
import { planFor, requirePlan } from "../plans/gate";
import { resolveEntitlements } from "@shared/plans";
import { aiEnabled, fitSummary, rememberRemovalStmt, suggestAllowance } from "./tag-fit";

/** A refused tag write. `message` is fixed text: it names the rule, never more than the tag's own name. */
export class TagError extends Error {
  constructor(readonly code: string, readonly status: 400 | 404 | 409, message: string, readonly field?: string) {
    super(message);
    this.name = "TagError";
  }
}
const invalid = (field: string, message: string) => new TagError("invalid", 400, message, field);
const NAME_RULE = "a tag is 1–32 characters: lowercase letters, digits and hyphens";

interface TagRow {
  id: number; name: string; description: string; color: string; starter: number;
  retired_at: string | null; merged_into: string | null;
}
const COLS = `id, name, description, color, starter, retired_at, merged_into`;

const auditStmt = (ctx: TenantContext, action: TagAuditAction, target: string, detail: Record<string, unknown>, at: string): Stmt =>
  stmt(ctx, `INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at) VALUES (?, ?, ?, ?, ?, ?)`,
    ctx.orgId, ctx.userId, action, target, JSON.stringify(detail), at);

/** The six starters, as statements for `ctx`'s org — what src/orgs/repo.ts `createOrg` puts in the batch
 *  that creates an org (0054 did the same for the orgs that existed then). */
export function starterTagStmts(ctx: TenantContext, at: string): Stmt[] {
  return STARTER_TAGS.map((t) => stmt(ctx,
    `INSERT OR IGNORE INTO org_tags (org_id, name, description, color, starter, created_at, created_by) VALUES (?, ?, ?, ?, 1, ?, 'system')`,
    ctx.orgId, t.name, t.description, t.color, at));
}

const readRows = (ctx: TenantContext): Promise<TagRow[]> =>
  all<TagRow>(ctx, `SELECT ${COLS} FROM org_tags WHERE org_id = ? ORDER BY id`, ctx.orgId);

/**
 * Every tag row of the org, oldest first. An org with NO row at all was created by a Worker from
 * before 0054 (in the minutes between the migration and its deploy): it is given the six starters
 * here, once — a starter is never removed, so "no rows" can only mean "never seeded".
 */
async function tagRows(ctx: TenantContext): Promise<TagRow[]> {
  const rows = await readRows(ctx);
  if (rows.length > 0) return rows;
  await batch(ctx, starterTagStmts(ctx, nowIso()));
  return readRows(ctx);
}

const live = (r: TagRow): boolean => r.retired_at === null;
const colorOf = (r: TagRow): TagColor => (isTagColor(r.color) ? r.color : "slate");
const refOf = (r: TagRow): TagRef => ({ name: r.name, description: r.description, color: colorOf(r), retired: !live(r) });
const zeroCounts = (): TagCounts => ({ feed: 0, doc: 0, adr: 0 });

// ── reads ────────────────────────────────────────────────────────────────────

/** The names an item may be given now. */
export async function liveTagNames(ctx: TenantContext): Promise<string[]> {
  return (await tagRows(ctx)).filter(live).map((r) => r.name);
}

/** The list as an agent reads it (MCP `list_tags`): the live tags, each with what it is for. */
export async function listTagRefs(ctx: TenantContext): Promise<{ tags: { name: string; description: string }[] }> {
  return { tags: (await tagRows(ctx)).filter(live).map((r) => ({ name: r.name, description: r.description })) };
}

async function countsByTag(ctx: TenantContext): Promise<Map<string, TagCounts>> {
  const rows = await all<{ tag: string; entry_type: string; n: number }>(ctx,
    `SELECT tag, entry_type, COUNT(*) AS n FROM entry_tags WHERE org_id = ? GROUP BY tag, entry_type`, ctx.orgId);
  const out = new Map<string, TagCounts>();
  for (const r of rows) {
    if (!isTagItemType(r.entry_type)) continue;
    const c = out.get(r.tag) ?? zeroCounts();
    c[r.entry_type] = r.n;
    out.set(r.tag, c);
  }
  return out;
}

async function pendingSuggestions(ctx: TenantContext, liveNames: readonly string[]): Promise<TagSuggestionDTO[]> {
  const [byType, byPerson] = await Promise.all([
    all<{ name: string; entry_type: string; n: number; first_at: string; last_at: string }>(ctx,
      `SELECT tag AS name, entry_type, COUNT(*) AS n, MIN(suggested_at) AS first_at, MAX(suggested_at) AS last_at
         FROM org_tag_suggestions WHERE org_id = ? AND state = 'open' AND source = 'agent' GROUP BY tag, entry_type`, ctx.orgId),
    all<{ name: string; suggested_by: string }>(ctx,
      `SELECT tag AS name, suggested_by, MIN(suggested_at) AS first_at FROM org_tag_suggestions
        WHERE org_id = ? AND state = 'open' AND source = 'agent' GROUP BY tag, suggested_by ORDER BY first_at, suggested_by`, ctx.orgId),
  ]);
  const out = new Map<string, TagSuggestionDTO>();
  for (const r of byType) {
    // The queue is for tags that are NOT on the list. An open suggestion of a tag that is (a model's
    // "this item looks like auth", later) belongs beside its item, not here.
    if (liveNames.includes(r.name)) continue;
    const s = out.get(r.name) ?? { name: r.name, counts: zeroCounts(), uses: 0, by: [], first_at: r.first_at, last_at: r.last_at, similar: similarTag(r.name, liveNames) };
    if (isTagItemType(r.entry_type)) s.counts[r.entry_type] = r.n;
    s.uses += r.n;
    if (r.first_at < s.first_at) s.first_at = r.first_at;
    if (r.last_at > s.last_at) s.last_at = r.last_at;
    out.set(r.name, s);
  }
  for (const r of byPerson) out.get(r.name)?.by.push(r.suggested_by);
  return [...out.values()].sort((a, b) => b.uses - a.uses || (a.name < b.name ? -1 : 1));
}

/** `GET …/tags` — any member: the list (retired tags last) with how many items carry each, the plan's
 *  cap, and — for an admin only — what agents suggested. */
export async function listTags(ctx: TenantContext, opts: { aiAvailable?: boolean } = {}): Promise<TagListDTO> {
  const [rows, counts, plan] = await Promise.all([tagRows(ctx), countsByTag(ctx), planFor(ctx)]);
  const tags: OrgTagDTO[] = rows.map((r) => ({ ...refOf(r), starter: r.starter === 1, counts: counts.get(r.name) ?? zeroCounts() }));
  tags.sort((a, b) => Number(a.retired) - Number(b.retired));
  const liveNames = rows.filter(live).map((r) => r.name);
  const out: TagListDTO = { tags, used: liveNames.length, cap: resolveEntitlements(plan.plan, plan.overrides).tags, suggestions: [] };
  if (!hasRole(ctx, "admin")) return out;
  // What only an admin acts on: what agents suggested, the AI switch, and each tag's latest run (Jev tagging items).
  const [suggestions, enabled, allowance, summary] = await Promise.all([pendingSuggestions(ctx, liveNames), aiEnabled(ctx), suggestAllowance(ctx), fitSummary(ctx)]);
  out.suggestions = suggestions;
  out.ai = { enabled, available: opts.aiAvailable === true, ...allowance };
  out.runs = Object.fromEntries(liveNames.filter((n) => summary.runs.has(n)).map((n) => [n, summary.runs.get(n)!]));
  return out;
}

/** The tags of several items of one type, by item id (names in list order). */
export async function tagsOfItems(ctx: TenantContext, type: TagItemType, ids: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  const rows = await fanOut<{ entry_id: string; tag: string }>(ctx, ids,
    (ph) => `SELECT entry_id, tag FROM entry_tags WHERE org_id = ? AND entry_type = ? AND entry_id IN (${ph}) ORDER BY tag`, [ctx.orgId, type]);
  for (const r of rows) out.set(r.entry_id, [...(out.get(r.entry_id) ?? []), r.tag]);
  return out;
}

/** `GET …/tags/:name` — any member: one tag and everything that carries it, by type. null = no such tag. */
export async function tagPage(ctx: TenantContext, rawName: string): Promise<TagPageDTO | null> {
  const name = normalizeTagName(rawName);
  if (!name) return null;
  const row = (await tagRows(ctx)).find((r) => r.name === name);
  if (!row) return null;
  const [feed, docs, adrs, counts, seen, authors, byJev] = await Promise.all([
    all<{ id: number; summary: string; brief: string | null; author: string; created_at: string }>(ctx,
      `SELECT f.id, f.summary, f.brief, f.author, f.created_at FROM feed f
         JOIN entry_tags et ON et.org_id = ? AND et.entry_type = 'feed' AND et.entry_id = CAST(f.id AS TEXT) AND et.tag = ?
        WHERE f.org_id = ? ORDER BY f.created_at DESC, f.id DESC LIMIT ${TAG_PAGE_LIMIT}`, ctx.orgId, name, ctx.orgId),
    all<{ slug: string; title: string; section: string; updated_at: string | null; updated_by: string | null }>(ctx,
      `SELECT d.slug, d.title, d.section, d.updated_at, d.updated_by FROM docs d
         JOIN entry_tags et ON et.org_id = ? AND et.entry_type = 'doc' AND et.entry_id = d.slug AND et.tag = ?
        WHERE d.org_id = ? ORDER BY d.updated_at DESC, d.slug LIMIT ${TAG_PAGE_LIMIT}`, ctx.orgId, name, ctx.orgId),
    all<{ id: number; title: string; status: string; created_at: string; created_by: string }>(ctx,
      `SELECT a.id, a.title, a.status, a.created_at, a.created_by FROM adrs a
         JOIN entry_tags et ON et.org_id = ? AND et.entry_type = 'adr' AND et.entry_id = CAST(a.id AS TEXT) AND et.tag = ?
        WHERE a.org_id = ? AND a.status != 'rejected' ORDER BY a.created_at DESC, a.id DESC LIMIT ${TAG_PAGE_LIMIT}`, ctx.orgId, name, ctx.orgId),
    all<{ entry_type: string; n: number }>(ctx,
      `SELECT entry_type, COUNT(*) AS n FROM entry_tags WHERE org_id = ? AND tag = ? GROUP BY entry_type`, ctx.orgId, name),
    all<{ name: string; count: number }>(ctx,
      `SELECT o.tag AS name, COUNT(*) AS count FROM entry_tags t
         JOIN entry_tags o ON o.org_id = ? AND o.entry_type = t.entry_type AND o.entry_id = t.entry_id AND o.tag <> t.tag
        WHERE t.org_id = ? AND t.tag = ? GROUP BY o.tag ORDER BY count DESC, o.tag LIMIT 6`, ctx.orgId, ctx.orgId, name),
    // Who wrote what carries it, across the three types (a doc counts for its last editor).
    all<{ handle: string; count: number }>(ctx,
      `SELECT handle, COUNT(*) AS count FROM (
         SELECT f.author AS handle FROM feed f
           JOIN entry_tags et ON et.org_id = ? AND et.entry_type = 'feed' AND et.entry_id = CAST(f.id AS TEXT) AND et.tag = ?
          WHERE f.org_id = ?
         UNION ALL
         SELECT d.updated_by AS handle FROM docs d
           JOIN entry_tags et ON et.org_id = ? AND et.entry_type = 'doc' AND et.entry_id = d.slug AND et.tag = ?
          WHERE d.org_id = ? AND d.updated_by IS NOT NULL
         UNION ALL
         SELECT a.created_by AS handle FROM adrs a
           JOIN entry_tags et ON et.org_id = ? AND et.entry_type = 'adr' AND et.entry_id = CAST(a.id AS TEXT) AND et.tag = ?
          WHERE a.org_id = ? AND a.status != 'rejected'
       ) GROUP BY handle ORDER BY count DESC, handle LIMIT 8`,
      ctx.orgId, name, ctx.orgId, ctx.orgId, name, ctx.orgId, ctx.orgId, name, ctx.orgId),
    // The items Jev added the tag to that still have it: a run's provenance row (src/tools/tag-fit.ts).
    all<{ entry_type: string; entry_id: string; confidence: number | null; reason: string | null; at: string | null }>(ctx,
      `SELECT s.entry_type, s.entry_id, MAX(s.confidence) AS confidence, MAX(s.reason) AS reason, MAX(s.resolved_at) AS at
         FROM org_tag_suggestions s
         JOIN entry_tags et ON et.org_id = ? AND et.entry_type = s.entry_type AND et.entry_id = s.entry_id AND et.tag = ?
        WHERE s.org_id = ? AND s.tag = ? AND s.source = 'model' AND s.state = 'accepted'
        GROUP BY s.entry_type, s.entry_id`, ctx.orgId, name, ctx.orgId, name),
  ]);
  const jev = new Map(byJev.map((r) => [`${r.entry_type}:${r.entry_id}`, { confidence: r.confidence ?? 0, reason: r.reason, at: r.at ?? "" }]));
  const withJev = (it: TagPageItem): TagPageItem => {
    const j = jev.get(`${it.type}:${it.id}`);
    return j ? { ...it, jev: j } : it;
  };
  const [feedTags, docTags, adrTags] = await Promise.all([
    tagsOfItems(ctx, "feed", feed.map((f) => String(f.id))),
    tagsOfItems(ctx, "doc", docs.map((d) => d.slug)),
    tagsOfItems(ctx, "adr", adrs.map((a) => String(a.id))),
  ]);
  const others = (m: Map<string, string[]>, id: string): string[] => (m.get(id) ?? []).filter((t) => t !== name);
  const c = zeroCounts();
  for (const r of counts) if (isTagItemType(r.entry_type)) c[r.entry_type] = r.n;
  const items: Record<TagItemType, TagPageItem[]> = {
    feed: feed.map((f) => withJev({ type: "feed", id: String(f.id), title: f.summary, note: f.brief, by: f.author, at: f.created_at, tags: others(feedTags, String(f.id)) })),
    doc: docs.map((d) => withJev({ type: "doc", id: d.slug, title: d.title, note: d.section, by: d.updated_by, at: d.updated_at, tags: others(docTags, d.slug) })),
    adr: adrs.map((a) => withJev({ type: "adr", id: String(a.id), title: a.title, note: a.status, by: a.created_by, at: a.created_at, tags: others(adrTags, String(a.id)) })),
  };
  return { tag: { ...refOf(row), starter: row.starter === 1, counts: c }, items, seen_with: seen, authors, jev_added: byJev.length };
}

// ── the gate's side (src/consumer.ts) ────────────────────────────────────────

export interface SortedTags {
  /** On the org's list, live — what the item is given. A name merged into another reads as that one. */
  known: string[];
  /** Well-formed, not on the list (or retired): recorded as a suggestion for an admin. */
  suggested: string[];
  /** Not a tag at all (empty, too long, other characters): dropped. */
  ignored: string[];
}

/** Sort the tags an agent sent against the org's live list. Reads only — the gate decides what follows. */
export async function sortAgentTags(ctx: TenantContext, raw: readonly string[]): Promise<SortedTags> {
  const out: SortedTags = { known: [], suggested: [], ignored: [] };
  if (raw.length === 0) return out;
  const rows = await tagRows(ctx);
  const byName = new Map(rows.map((r) => [r.name, r]));
  const add = (list: string[], v: string) => { if (!list.includes(v)) list.push(v); };
  for (const t of raw) {
    const name = normalizeTagName(t);
    if (!name) { add(out.ignored, String(t).slice(0, 64)); continue; }
    const row = byName.get(name);
    const target = row && !live(row) && row.merged_into ? byName.get(row.merged_into) : row;
    if (target && live(target)) add(out.known, target.name);
    else add(out.suggested, name);
  }
  return out;
}

/** Record that `by`'s agent sent `names` (already normalized, none on the list) on one item: one
 *  `source = 'agent'` row per (item, tag). A second open row for the same pair is ignored (the partial
 *  unique index), so a replay of the same item records nothing new. A suggestion is never the tag. */
export async function recordTagSuggestions(ctx: TenantContext, names: readonly string[], item: { type: TagItemType; id: string }, by: string): Promise<void> {
  if (names.length === 0) return;
  const at = nowIso();
  await batch(ctx, names.map((n) => stmt(ctx,
    `INSERT OR IGNORE INTO org_tag_suggestions (org_id, tag, entry_type, entry_id, source, suggested_by, suggested_at) VALUES (?, ?, ?, ?, 'agent', ?, ?)`,
    ctx.orgId, n, item.type, item.id, by, at)));
}

// ── a member's write: one item's tags ────────────────────────────────────────

const ITEM_EXISTS: Record<TagItemType, string> = {
  feed: `SELECT 1 AS x FROM feed WHERE org_id = ? AND CAST(id AS TEXT) = ?`,
  doc: `SELECT 1 AS x FROM docs WHERE org_id = ? AND slug = ?`,
  adr: `SELECT 1 AS x FROM adrs WHERE org_id = ? AND CAST(id AS TEXT) = ?`,
};

/**
 * Replace the tags of one feed entry, doc or decision (any member; an authored write, like a prompt's
 * tags). Each must be a live tag of the org — or one the item already has, so a retired tag stays on
 * what has it until someone takes it off. Returns the item's tags.
 */
export async function setItemTags(ctx: TenantContext, type: unknown, id: unknown, tags: unknown): Promise<string[]> {
  if (!isTagItemType(type)) throw invalid("type", `type must be one of ${TAG_ITEM_TYPES.join(", ")}`);
  if (typeof id !== "string" || id.length === 0 || id.length > 200) throw invalid("id", "id is required");
  if (!Array.isArray(tags) || tags.length > ITEM_TAGS_MAX) throw invalid("tags", `tags must be a list of at most ${ITEM_TAGS_MAX}`);
  if (!(await first(ctx, ITEM_EXISTS[type], ctx.orgId, id))) throw new TagError("not_found", 404, "no such item");
  const want: string[] = [];
  for (const t of tags) {
    const n = normalizeTagName(t);
    if (!n) throw invalid("tags", NAME_RULE);
    if (!want.includes(n)) want.push(n);
  }
  const [liveNames, held] = await Promise.all([liveTagNames(ctx), tagsOfItems(ctx, type, [id])]);
  const has = held.get(id) ?? [];
  const stranger = want.find((n) => !liveNames.includes(n) && !has.includes(n));
  if (stranger) throw new TagError("unknown_tag", 400, `"${stranger}" is not one of this organization's tags`, "tags");
  const at = nowIso();
  const stmts: Stmt[] = [
    ...has.filter((n) => !want.includes(n)).flatMap((n) => [
      stmt(ctx, `DELETE FROM entry_tags WHERE org_id = ? AND tag = ? AND entry_type = ? AND entry_id = ?`, ctx.orgId, n, type, id),
      // A tag a run had added, removed by a person: no later run adds it back.
      rememberRemovalStmt(ctx, n, type, id, at),
    ]),
    ...want.filter((n) => !has.includes(n)).map((n) => stmt(ctx, `INSERT OR IGNORE INTO entry_tags (org_id, tag, entry_type, entry_id) VALUES (?, ?, ?, ?)`, ctx.orgId, n, type, id)),
  ];
  if (stmts.length > 0) await batch(ctx, stmts);
  return want;
}

// ── an admin's writes ────────────────────────────────────────────────────────

async function rowByName(ctx: TenantContext, rawName: unknown): Promise<TagRow> {
  const name = normalizeTagName(rawName);
  const row = name ? await first<TagRow>(ctx, `SELECT ${COLS} FROM org_tags WHERE org_id = ? AND name = ?`, ctx.orgId, name) : null;
  if (!row) throw new TagError("not_found", 404, "no such tag");
  return row;
}

/** Settle every OPEN suggestion of the tag `name`: give each item that carried it the tag `to` (an
 *  ordinary authored write, by the admin doing this) and mark the rows `accepted` with what they were
 *  given — or, with `to` null, mark them `dismissed` and tag nothing. */
const settleStmts = (ctx: TenantContext, name: string, to: string | null, at: string): Stmt[] => [
  ...(to === null ? [] : [stmt(ctx,
    `INSERT OR IGNORE INTO entry_tags (org_id, tag, entry_type, entry_id)
       SELECT ?, ?, s.entry_type, s.entry_id FROM org_tag_suggestions s WHERE s.org_id = ? AND s.tag = ? AND s.state = 'open' AND s.source = 'agent'`,
    ctx.orgId, to, ctx.orgId, name)]),
  stmt(ctx, `UPDATE org_tag_suggestions SET state = ?, resolved_to = ?, resolved_at = ?, resolved_by = ? WHERE org_id = ? AND tag = ? AND state = 'open' AND source = 'agent'`,
    to === null ? "dismissed" : "accepted", to, at, ctx.userId, ctx.orgId, name),
];

const pendingUses = async (ctx: TenantContext, name: string): Promise<number> =>
  (await first<{ n: number }>(ctx, `SELECT COUNT(DISTINCT entry_type || ':' || entry_id) AS n FROM org_tag_suggestions WHERE org_id = ? AND tag = ? AND state = 'open' AND source = 'agent'`, ctx.orgId, name))?.n ?? 0;

function parseColor(raw: unknown): TagColor | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isTagColor(raw)) throw invalid("color", "color must be one of the tag colours");
  return raw;
}
function parseDescription(raw: unknown): string {
  const d = cleanTagDescription(raw);
  if (d === null) throw invalid("description", "the description is one line of at most 120 characters");
  return d;
}

/** A NEW live tag, as statements: the row, and — if agents had already asked for this name — their
 *  items. The caller has checked the role, the name and the plan. */
async function addStmts(ctx: TenantContext, name: string, description: string, color: TagColor | undefined, at: string): Promise<Stmt[]> {
  const n = (await readRows(ctx)).length;
  return [
    stmt(ctx, `INSERT INTO org_tags (org_id, name, description, color, starter, created_at, created_by) VALUES (?, ?, ?, ?, 0, ?, ?)`,
      ctx.orgId, name, description, color ?? nextTagColor(n), at, ctx.userId),
    ...settleStmts(ctx, name, name, at),
  ];
}

/** Add a tag (admin+). Counts against the plan's `tags` (402 `plan_limit`). A name agents already
 *  suggested is applied to the items that carried it. */
export async function addTag(ctx: TenantContext, input: { name?: unknown; description?: unknown; color?: unknown }): Promise<{ name: string }> {
  requireRole(ctx, "admin");
  const name = normalizeTagName(input.name);
  if (!name) throw invalid("name", NAME_RULE);
  const description = parseDescription(input.description);
  const color = parseColor(input.color);
  const held = (await tagRows(ctx)).find((r) => r.name === name);
  if (held) throw live(held) ? new TagError("tag_exists", 409, "that tag is already on the list") : new TagError("tag_retired", 409, "that tag is retired: restore it instead");
  await requirePlan(ctx, "tags");
  const at = nowIso();
  await batch(ctx, [...(await addStmts(ctx, name, description, color, at)), auditStmt(ctx, "tag.add", name, {}, at)]);
  return { name };
}

/** Rename a tag and/or change its description and colour (admin+). A rename rewrites every tagged
 *  item in the same batch, so nothing loses its tag; a starter may be renamed. */
export async function editTag(ctx: TenantContext, rawName: unknown, input: { name?: unknown; description?: unknown; color?: unknown }): Promise<{ name: string }> {
  requireRole(ctx, "admin");
  const row = await rowByName(ctx, rawName);
  const at = nowIso();
  const stmts: Stmt[] = [];
  const changed: string[] = [];
  let name = row.name;
  if (input.name !== undefined) {
    const next = normalizeTagName(input.name);
    if (!next) throw invalid("name", NAME_RULE);
    if (next !== row.name) {
      if (!live(row)) throw new TagError("tag_retired", 409, "restore the tag before renaming it");
      if (await first(ctx, `SELECT 1 AS x FROM org_tags WHERE org_id = ? AND name = ?`, ctx.orgId, next)) throw new TagError("tag_exists", 409, "another tag already has that name");
      stmts.push(
        stmt(ctx, `UPDATE org_tags SET name = ?, updated_at = ?, updated_by = ? WHERE org_id = ? AND id = ?`, next, at, ctx.userId, ctx.orgId, row.id),
        stmt(ctx, `UPDATE OR IGNORE entry_tags SET tag = ? WHERE org_id = ? AND tag = ?`, next, ctx.orgId, row.name),
        stmt(ctx, `DELETE FROM entry_tags WHERE org_id = ? AND tag = ?`, ctx.orgId, row.name), // only a row the UPDATE could not move: the item already had the new name
        stmt(ctx, `UPDATE org_tags SET merged_into = ? WHERE org_id = ? AND merged_into = ?`, next, ctx.orgId, row.name),
        // What the model suggested for the tag goes with it (and so does its run history).
        stmt(ctx, `UPDATE org_tag_suggestions SET tag = ? WHERE org_id = ? AND tag = ? AND source = 'model' AND state = 'open'`, next, ctx.orgId, row.name),
        stmt(ctx, `UPDATE org_tag_runs SET tag = ? WHERE org_id = ? AND tag = ?`, next, ctx.orgId, row.name),
        // Agents that already asked for the new name were asking for this tag.
        ...settleStmts(ctx, next, next, at),
        auditStmt(ctx, "tag.rename", next, { from: row.name }, at),
      );
      name = next;
    }
  }
  const sets: string[] = [];
  const params: unknown[] = [];
  if (input.description !== undefined) {
    const d = parseDescription(input.description);
    if (d !== row.description) { sets.push("description = ?"); params.push(d); changed.push("description"); }
  }
  if (input.color !== undefined) {
    const c = parseColor(input.color);
    if (c && c !== row.color) { sets.push("color = ?"); params.push(c); changed.push("color"); }
  }
  if (sets.length > 0) {
    stmts.push(
      stmt(ctx, `UPDATE org_tags SET ${sets.join(", ")}, updated_at = ?, updated_by = ? WHERE org_id = ? AND id = ?`, ...params, at, ctx.userId, ctx.orgId, row.id),
      auditStmt(ctx, "tag.edit", name, { fields: changed }, at),
    );
  }
  if (stmts.length > 0) await batch(ctx, stmts);
  return { name };
}

/** Merge `from` into `into` (admin+): every item tagged `from` is tagged `into` instead, and `from` is
 *  retired pointing at `into`. A starter cannot be merged away; `into` must be live. */
export async function mergeTag(ctx: TenantContext, rawFrom: unknown, rawInto: unknown): Promise<{ name: string; moved: number }> {
  requireRole(ctx, "admin");
  const from = await rowByName(ctx, rawFrom);
  const intoName = normalizeTagName(rawInto);
  const into = intoName ? await first<TagRow>(ctx, `SELECT ${COLS} FROM org_tags WHERE org_id = ? AND name = ?`, ctx.orgId, intoName) : null;
  if (!into || !live(into)) throw new TagError("unknown_tag", 400, "merge into a tag that is on the list", "into");
  if (into.id === from.id) throw invalid("into", "a tag cannot be merged into itself");
  if (from.starter === 1) throw new TagError("starter_tag", 409, "a starter tag can be renamed, not merged into another");
  const moved = (await first<{ n: number }>(ctx, `SELECT COUNT(*) AS n FROM entry_tags WHERE org_id = ? AND tag = ?`, ctx.orgId, from.name))?.n ?? 0;
  const at = nowIso();
  await batch(ctx, [
    stmt(ctx, `UPDATE OR IGNORE entry_tags SET tag = ? WHERE org_id = ? AND tag = ?`, into.name, ctx.orgId, from.name),
    stmt(ctx, `DELETE FROM entry_tags WHERE org_id = ? AND tag = ?`, ctx.orgId, from.name), // items that already had both
    stmt(ctx, `UPDATE org_tags SET merged_into = ? WHERE org_id = ? AND merged_into = ?`, into.name, ctx.orgId, from.name),
    supersedeModelStmt(ctx, from.name, at),
    stmt(ctx, `UPDATE org_tags SET retired_at = COALESCE(retired_at, ?), retired_by = COALESCE(retired_by, ?), merged_into = ?, updated_at = ?, updated_by = ? WHERE org_id = ? AND id = ?`,
      at, ctx.userId, into.name, at, ctx.userId, ctx.orgId, from.id),
    auditStmt(ctx, "tag.merge", from.name, { into: into.name, moved }, at),
  ]);
  return { name: into.name, moved };
}

/** Retire a tag (admin+): it stays on what has it and can no longer be picked. Soft — `restoreTag`
 *  brings it back. A starter cannot be retired. Idempotent. */
export async function retireTag(ctx: TenantContext, rawName: unknown): Promise<{ name: string }> {
  requireRole(ctx, "admin");
  const row = await rowByName(ctx, rawName);
  if (row.starter === 1) throw new TagError("starter_tag", 409, "a starter tag can be renamed, not retired");
  if (!live(row)) return { name: row.name };
  const at = nowIso();
  await batch(ctx, [
    stmt(ctx, `UPDATE org_tags SET retired_at = ?, retired_by = ?, updated_at = ?, updated_by = ? WHERE org_id = ? AND id = ? AND retired_at IS NULL`, at, ctx.userId, at, ctx.userId, ctx.orgId, row.id),
    supersedeModelStmt(ctx, row.name, at),
    auditStmt(ctx, "tag.retire", row.name, {}, at),
  ]);
  return { name: row.name };
}

/** A tag that can no longer be picked has nothing left to suggest: its open MODEL suggestions are superseded. */
const supersedeModelStmt = (ctx: TenantContext, tag: string, at: string): Stmt =>
  stmt(ctx, `UPDATE org_tag_suggestions SET state = 'superseded', resolved_at = ? WHERE org_id = ? AND tag = ? AND source = 'model' AND state = 'open'`, at, ctx.orgId, tag);

const restoreStmt = (ctx: TenantContext, id: number, at: string): Stmt =>
  stmt(ctx, `UPDATE org_tags SET retired_at = NULL, retired_by = NULL, merged_into = NULL, updated_at = ?, updated_by = ? WHERE org_id = ? AND id = ?`, at, ctx.userId, ctx.orgId, id);

/** Put a retired (or merged) tag back on the list (admin+). It counts against the plan again. A merged
 *  tag comes back empty: its items stay with the tag they were moved to. */
export async function restoreTag(ctx: TenantContext, rawName: unknown): Promise<{ name: string }> {
  requireRole(ctx, "admin");
  const row = await rowByName(ctx, rawName);
  if (live(row)) return { name: row.name };
  await requirePlan(ctx, "tags");
  const at = nowIso();
  await batch(ctx, [restoreStmt(ctx, row.id, at), ...settleStmts(ctx, row.name, row.name, at), auditStmt(ctx, "tag.restore", row.name, {}, at)]);
  return { name: row.name };
}

/**
 * Settle what agents suggested under one name (admin+):
 *   accept  — the name joins the list (counted against the plan; a retired tag of that name is
 *             restored) and every item that carried it is given it;
 *   map     — those items are given the existing live tag `into` instead;
 *   dismiss — nothing is tagged. A later use of the name is a new suggestion.
 */
export async function resolveSuggestion(
  ctx: TenantContext, rawName: unknown, input: { resolution?: unknown; into?: unknown; description?: unknown; color?: unknown },
): Promise<{ name: string; resolution: "accept" | "map" | "dismiss"; applied_to: number; tag: string | null }> {
  requireRole(ctx, "admin");
  const name = normalizeTagName(rawName);
  const uses = name ? await pendingUses(ctx, name) : 0;
  if (!name || uses === 0) throw new TagError("not_found", 404, "no such suggestion");
  const at = nowIso();
  if (input.resolution === "dismiss") {
    await batch(ctx, [...settleStmts(ctx, name, null, at), auditStmt(ctx, "tag.suggestion.dismiss", name, { uses }, at)]);
    return { name, resolution: "dismiss", applied_to: 0, tag: null };
  }
  if (input.resolution === "map") {
    const intoName = normalizeTagName(input.into);
    const into = intoName ? (await tagRows(ctx)).find((r) => r.name === intoName) : undefined;
    if (!into || !live(into)) throw new TagError("unknown_tag", 400, "choose a tag that is on the list", "into");
    await batch(ctx, [...settleStmts(ctx, name, into.name, at), auditStmt(ctx, "tag.suggestion.map", name, { into: into.name, uses }, at)]);
    return { name, resolution: "map", applied_to: uses, tag: into.name };
  }
  if (input.resolution !== "accept") throw invalid("resolution", "resolution must be accept, map or dismiss");
  const description = parseDescription(input.description);
  const color = parseColor(input.color);
  const held = (await tagRows(ctx)).find((r) => r.name === name);
  const stmts: Stmt[] = [];
  if (!held) {
    await requirePlan(ctx, "tags");
    stmts.push(...(await addStmts(ctx, name, description, color, at)));
  } else if (!live(held)) {
    await requirePlan(ctx, "tags");
    stmts.push(restoreStmt(ctx, held.id, at), ...settleStmts(ctx, name, name, at));
  } else {
    stmts.push(...settleStmts(ctx, name, name, at));
  }
  await batch(ctx, [...stmts, auditStmt(ctx, "tag.suggestion.accept", name, { uses }, at)]);
  return { name, resolution: "accept", applied_to: uses, tag: name };
}

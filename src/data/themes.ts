// Repo themes' one repository (0064_repo_themes; docs/architecture/ai.md › Themes): the themes of a repository
// (`repo_themes`), which theme each merged PR belongs to (`pr_themes`) and the caption above the chart
// (`repo_theme_captions`). A TENANT module: every statement names `org_id = ?`, bound from the caller's context
// (test/data-layer.static.test.ts). Nothing here calls a model.
//
// THE PERSON-OVER-AI RULE lives here, in SQL: every AI write to `pr_themes` is an upsert guarded by
// `WHERE pr_themes.source <> 'person'` — a person's choice is never overwritten, whoever calls.
//
// PRs are read from `events` (`pr_merged`) by ORG, not by its `repo` column: that column still carries
// 0042_organizations' constant default (nothing writes it), and a merged PR the gate captured is always the org's
// primary repository's (the router's `pr_merged` row). Themes and PR themes ARE keyed by the repository.
import { all, batch, first, nowIso, run, stmt, type TenantContext } from "./sql";

export const THEME_STATUSES = ["proposed", "active", "removed"] as const;
export type ThemeStatus = (typeof THEME_STATUSES)[number];

export interface ThemeRow {
  id: number;
  repo: string;
  name: string;
  description: string;
  color_key: string;
  status: ThemeStatus;
  position: number;
  seed_prs: string;
  merged_into: number | null;
  model: string | null;
  prompt_version: string | null;
  created_by: string;
  created_at: string;
  decided_by: string | null;
  decided_at: string | null;
}

const THEME_COLS = `id, repo, name, description, color_key, status, position, seed_prs, merged_into, model, prompt_version, created_by, created_at, decided_by, decided_at`;

/** The suggestion kind a proposed theme is (and its `item_type`): what the accept / dismiss handlers key on. */
export const THEME_SUGGESTION_KIND = "themes.propose";
export const THEME_ITEM_TYPE = "theme";
/** A proposed theme's suggestion `item_ref`: `<repo>#<theme id>`. */
export const themeItemRef = (repo: string, id: number): string => `${repo}#${id}`;

/** The seed PR numbers a row carries (a bad value reads as none — never a guess). */
export function seedPrsOf(r: Pick<ThemeRow, "seed_prs">): number[] {
  try {
    const v = JSON.parse(r.seed_prs) as unknown;
    return Array.isArray(v) ? v.filter((n): n is number => Number.isInteger(n) && n > 0) : [];
  } catch {
    return [];
  }
}

/** A repository's themes in the given states, in lane order. */
export function repoThemes(ctx: TenantContext, repo: string, statuses: readonly ThemeStatus[] = ["active"]): Promise<ThemeRow[]> {
  const st = statuses.length ? statuses : ["active"];
  return all<ThemeRow>(ctx,
    `SELECT ${THEME_COLS} FROM repo_themes WHERE org_id = ? AND repo = ? AND status IN (${st.map(() => "?").join(", ")}) ORDER BY position, id`,
    ctx.orgId, repo, ...st);
}

/** One of the org's themes by id — another org's reads as not found. */
export function getTheme(ctx: TenantContext, id: number): Promise<ThemeRow | null> {
  return first<ThemeRow>(ctx, `SELECT ${THEME_COLS} FROM repo_themes WHERE id = ? AND org_id = ?`, id, ctx.orgId);
}

/** The org's ACTIVE themes, every repository's (the cached prefix's "# Active themes"), bounded. */
export function activeThemesOfOrg(ctx: TenantContext, limit: number): Promise<{ name: string; description: string }[]> {
  return all<{ name: string; description: string }>(ctx,
    `SELECT name, description FROM repo_themes WHERE org_id = ? AND status = 'active' ORDER BY repo, position, id LIMIT ?`, ctx.orgId, limit);
}

/** When Trov last proposed themes for the repository (any outcome), or null. */
export async function lastProposalAt(ctx: TenantContext, repo: string): Promise<string | null> {
  return (await first<{ at: string | null }>(ctx, `SELECT MAX(created_at) AS at FROM repo_themes WHERE org_id = ? AND repo = ?`, ctx.orgId, repo))?.at ?? null;
}

/** The newest acceptance of a theme still active — an AI classification older than it is re-classified. */
export async function lastActivationAt(ctx: TenantContext, repo: string): Promise<string | null> {
  return (await first<{ at: string | null }>(ctx,
    `SELECT MAX(decided_at) AS at FROM repo_themes WHERE org_id = ? AND repo = ? AND status = 'active'`, ctx.orgId, repo))?.at ?? null;
}

export interface NewTheme { name: string; description: string; colorKey: string; position: number; seedPrs: number[] }

/** Insert proposed themes, each as `proposed` by `createdBy`, in ONE batch. Returns their ids in order. */
export async function insertProposedThemes(
  ctx: TenantContext, repo: string, themes: readonly NewTheme[], meta: { createdBy: string; model: string | null; promptVersion: string | null }, at: string = nowIso(),
): Promise<number[]> {
  if (!themes.length) return [];
  const res = await batch<{ id: number }>(ctx, themes.map((t) => stmt(ctx,
    `INSERT INTO repo_themes (org_id, repo, name, description, color_key, status, position, seed_prs, model, prompt_version, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?) RETURNING id`,
    ctx.orgId, repo, t.name, t.description, t.colorKey, t.position, JSON.stringify(t.seedPrs), meta.model, meta.promptVersion, meta.createdBy, at)));
  return res.map((r) => r.results?.[0]?.id ?? 0).filter((id) => id > 0);
}

/** Make a PROPOSED theme active (with a new name, for Rename) as `by`. false = it was not proposed (or the name
 *  is taken: the unique index refuses, and the caller says so). */
export async function activateTheme(ctx: TenantContext, id: number, by: string, at: string, name?: string): Promise<boolean> {
  const res = name === undefined
    ? await run(ctx, `UPDATE repo_themes SET status = 'active', decided_by = ?, decided_at = ? WHERE id = ? AND org_id = ? AND status = 'proposed'`, by, at, id, ctx.orgId)
    : await run(ctx, `UPDATE repo_themes SET status = 'active', name = ?, decided_by = ?, decided_at = ? WHERE id = ? AND org_id = ? AND status = 'proposed'`, name, by, at, id, ctx.orgId);
  return (res.meta.changes ?? 0) > 0;
}

/** Fold PROPOSED theme `id` into theme `into` (same repository, not removed): `id` is removed, recorded as merged,
 *  and its seed PRs join `into`'s. false = either is not what it must be. */
export async function mergeTheme(ctx: TenantContext, id: number, into: number, by: string, at: string): Promise<boolean> {
  const res = await batch(ctx, [
    stmt(ctx, `UPDATE repo_themes SET seed_prs = (
                 SELECT json_group_array(n) FROM (
                   SELECT value AS n FROM json_each(repo_themes.seed_prs)
                   UNION SELECT value FROM json_each((SELECT s.seed_prs FROM repo_themes s WHERE s.id = ?1 AND s.org_id = ?2))))
                WHERE id = ?3 AND org_id = ?2 AND status <> 'removed'
                  AND EXISTS (SELECT 1 FROM repo_themes x WHERE x.id = ?1 AND x.org_id = ?2 AND x.status = 'proposed' AND x.repo = repo_themes.repo)`,
    id, ctx.orgId, into),
    stmt(ctx, `UPDATE repo_themes SET status = 'removed', merged_into = ?3, decided_by = ?4, decided_at = ?5
                WHERE id = ?1 AND org_id = ?2 AND status = 'proposed' AND ?1 <> ?3
                  AND EXISTS (SELECT 1 FROM repo_themes t WHERE t.id = ?3 AND t.org_id = ?2 AND t.status <> 'removed' AND t.repo = repo_themes.repo)`,
    id, ctx.orgId, into, by, at),
  ]);
  return (res[1].meta.changes ?? 0) > 0;
}

/** Remove a PROPOSED theme as `by`. false = it was not proposed. */
export async function removeTheme(ctx: TenantContext, id: number, by: string, at: string): Promise<boolean> {
  const res = await run(ctx, `UPDATE repo_themes SET status = 'removed', decided_by = ?, decided_at = ? WHERE id = ? AND org_id = ? AND status = 'proposed'`, by, at, id, ctx.orgId);
  return (res.meta.changes ?? 0) > 0;
}

/** The open theme suggestions, by theme id. */
export async function openThemeSuggestions(ctx: TenantContext, repo: string): Promise<Map<number, number>> {
  const rows = await all<{ id: number; item_ref: string }>(ctx,
    `SELECT id, item_ref FROM ai_suggestions WHERE org_id = ? AND kind = ? AND item_type = ? AND state = 'open' AND item_ref LIKE ? ESCAPE '\\'`,
    ctx.orgId, THEME_SUGGESTION_KIND, THEME_ITEM_TYPE, `${repo.replace(/[\\%_]/g, (c) => `\\${c}`)}#%`);
  const out = new Map<number, number>();
  for (const r of rows) {
    const themeId = Number(r.item_ref.slice(r.item_ref.lastIndexOf("#") + 1));
    if (Number.isInteger(themeId)) out.set(themeId, r.id);
  }
  return out;
}

// ── PR themes ────────────────────────────────────────────────────────────────

export interface AiPrTheme { pr: number; themeId: number; confidence: number | null; model: string | null; promptVersion: string | null }

/** Write AI classifications in ONE batch. A row a PERSON set is never touched (the guarded upsert). Returns how
 *  many rows were written. */
export async function putAiPrThemes(ctx: TenantContext, repo: string, rows: readonly AiPrTheme[], at: string = nowIso()): Promise<number> {
  if (!rows.length) return 0;
  const res = await batch(ctx, rows.map((r) => stmt(ctx,
    `INSERT INTO pr_themes (org_id, repo, pr_number, theme_id, source, confidence, model, prompt_version, set_by, set_at)
     VALUES (?, ?, ?, ?, 'ai', ?, ?, ?, NULL, ?)
     ON CONFLICT(org_id, repo, pr_number) DO UPDATE SET
       theme_id = excluded.theme_id, source = 'ai', confidence = excluded.confidence, model = excluded.model,
       prompt_version = excluded.prompt_version, set_by = NULL, set_at = excluded.set_at
     WHERE pr_themes.source <> 'person'`,
    ctx.orgId, repo, r.pr, r.themeId, r.confidence === null ? null : Math.min(1, Math.max(0, r.confidence)), r.model, r.promptVersion, at)));
  return res.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
}

/** A person's choice for a PR's theme (`themeId` null = "no theme"). It always wins over the model's. */
export async function setPersonPrTheme(ctx: TenantContext, repo: string, pr: number, themeId: number | null, by: string, at: string = nowIso()): Promise<void> {
  await run(ctx,
    `INSERT INTO pr_themes (org_id, repo, pr_number, theme_id, source, confidence, model, prompt_version, set_by, set_at)
     VALUES (?, ?, ?, ?, 'person', NULL, NULL, NULL, ?, ?)
     ON CONFLICT(org_id, repo, pr_number) DO UPDATE SET
       theme_id = excluded.theme_id, source = 'person', confidence = NULL, model = NULL, prompt_version = NULL, set_by = excluded.set_by, set_at = excluded.set_at`,
    ctx.orgId, repo, pr, themeId, by, at);
}

// ── merged PRs, with their card and theme ────────────────────────────────────

export interface MergedPrRow {
  number: number;
  at: string;
  title: string | null;
  url: string | null;
  /** The PR's card (`pr_summaries`, a structured summary): null when it has none. */
  card_title: string | null;
  what: string | null;
  why: string | null;
  impact: string | null;
  theme_id: number | null;
  theme_source: "ai" | "person" | null;
  theme_set_at: string | null;
}

const MERGED_COLS = `e.ref_number AS number, COALESCE(e.occurred_at, e.recorded_at) AS at,
  json_extract(e.raw, '$.pr.title') AS title, json_extract(e.raw, '$.pr.html_url') AS url,
  s.title AS card_title, s.what AS what, s.why AS why, s.impact AS impact,
  t.theme_id AS theme_id, t.source AS theme_source, t.set_at AS theme_set_at`;
const MERGED_FROM = `FROM events e
  LEFT JOIN pr_summaries s ON s.org_id = e.org_id AND s.semantic_key = e.semantic_key
  LEFT JOIN pr_themes t ON t.org_id = e.org_id AND t.repo = ? AND t.pr_number = e.ref_number`;

/** The org's PRs merged since `since`, newest first, with card and theme. */
export function mergedPrsSince(ctx: TenantContext, repo: string, since: string, limit = 1000): Promise<MergedPrRow[]> {
  return all<MergedPrRow>(ctx,
    `SELECT ${MERGED_COLS} ${MERGED_FROM}
      WHERE e.org_id = ? AND e.event_type = 'pr_merged' AND COALESCE(e.occurred_at, e.recorded_at) >= ?
      ORDER BY COALESCE(e.occurred_at, e.recorded_at) DESC, e.ref_number DESC LIMIT ?`,
    repo, ctx.orgId, since, limit);
}

/** One merged PR by number, or null (not merged, or not this org's). */
export function mergedPr(ctx: TenantContext, repo: string, n: number): Promise<MergedPrRow | null> {
  return first<MergedPrRow>(ctx,
    `SELECT ${MERGED_COLS} ${MERGED_FROM} WHERE e.org_id = ? AND e.event_type = 'pr_merged' AND e.ref_number = ?
      ORDER BY e.id DESC LIMIT 1`, repo, ctx.orgId, n);
}

/** How many merged PRs since `since` have a card (a structured summary) — the proposal's threshold. */
export async function cardedPrCount(ctx: TenantContext, since: string): Promise<number> {
  return (await first<{ n: number }>(ctx,
    `SELECT COUNT(DISTINCT e.ref_number) AS n FROM events e
       JOIN pr_summaries s ON s.org_id = e.org_id AND s.semantic_key = e.semantic_key AND s.what IS NOT NULL
      WHERE e.org_id = ? AND e.event_type = 'pr_merged' AND COALESCE(e.occurred_at, e.recorded_at) >= ?`, ctx.orgId, since))?.n ?? 0;
}

// ── captions ─────────────────────────────────────────────────────────────────

export interface CaptionRow { id: number; caption: string; theme_ids: string; basis_hash: string; model: string | null; prompt_version: string | null; generated_at: string }
/** Captions kept per (repo, range). */
export const CAPTIONS_KEPT = 10;

export function latestCaption(ctx: TenantContext, repo: string, range: string): Promise<CaptionRow | null> {
  return first<CaptionRow>(ctx,
    `SELECT id, caption, theme_ids, basis_hash, model, prompt_version, generated_at FROM repo_theme_captions
      WHERE org_id = ? AND repo = ? AND range = ? ORDER BY generated_at DESC, id DESC LIMIT 1`, ctx.orgId, repo, range);
}

/** Store a (checked) caption and keep only the newest `CAPTIONS_KEPT` for its (repo, range) — one batch. */
export async function insertCaption(
  ctx: TenantContext, repo: string, range: string, c: { caption: string; themeIds: number[]; basisHash: string; model: string | null; promptVersion: string | null }, at: string = nowIso(),
): Promise<void> {
  await batch(ctx, [
    stmt(ctx, `INSERT INTO repo_theme_captions (org_id, repo, range, caption, theme_ids, basis_hash, model, prompt_version, generated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ctx.orgId, repo, range, c.caption, JSON.stringify(c.themeIds), c.basisHash, c.model, c.promptVersion, at),
    stmt(ctx, `DELETE FROM repo_theme_captions WHERE org_id = ? AND repo = ? AND range = ? AND id NOT IN (
                 SELECT id FROM repo_theme_captions WHERE org_id = ? AND repo = ? AND range = ? ORDER BY generated_at DESC, id DESC LIMIT ?)`,
      ctx.orgId, repo, range, ctx.orgId, repo, range, CAPTIONS_KEPT),
  ]);
}

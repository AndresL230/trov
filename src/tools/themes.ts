// "Where the work went" (Repo › Planning; docs/architecture/ai.md › Themes, repo-dashboard.md): the READ. A D1
// aggregation on read — merged PRs per theme per UTC Monday week — feeding `RepoDashboard.themes` (the screen and
// MCP `get_repo_dashboard`'s planning tab). No model, no network: what a model wrote (the themes, each PR's theme,
// the caption) is read back from rows; every number is counted here.
//
// The field is ABSENT (undefined) when THE read rule hides it (`aiShown`: the org's AI switch off, or no Anthropic key
// on the deployment), when there is no repository, and when the
// repository has no active theme and no proposed theme waiting on an admin — never an empty or "off" state. A
// range the reading person marked "Wrong?" is left out for them (`ai_feedback`, item type `themes`).
//
// `themeShares` is the small helper Phase E's roadmap drift calls: each active theme's share of the PRs merged in
// a window, counted the same way the chart counts them.
import {
  AI_THEME_COLORS, AI_THEME_RANGES, AI_THEME_RANGE_WEEKS, aiItemRef,
  type AiCite, type AiThemeColor, type AiThemeLane, type AiThemeRange, type AiThemes,
} from "@shared/ai-core";
import {
  latestCaption, mergedPrsSince, openThemeSuggestions, repoThemes, seedPrsOf, type MergedPrRow, type ThemeRow,
} from "../data/themes";
import type { TenantContext } from "../data/sql";
import { hiddenFor } from "../data/ai";
import { aiShown } from "../plans/gate";

const DAY = 86_400_000;
/** The lanes the screen draws at most (shared/ai.ts `AiThemesSchema`). */
export const THEME_LANES_MAX = 8;
/** PRs listed under a picked lane, newest first. */
export const THEME_LANE_PRS = 8;

/** The Monday (UTC, `YYYY-MM-DD`) of the week `back` weeks before `now`'s. */
export function mondayOf(now: number, back = 0): string {
  const d = new Date(now);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const dow = (new Date(day).getUTCDay() + 6) % 7; // 0 = Monday
  return new Date(day - (dow + back * 7) * DAY).toISOString().slice(0, 10);
}

/** `n` weeks' Mondays, oldest first, ending with this week's. */
export function weeksEnding(now: number, n: number): string[] {
  return Array.from({ length: n }, (_, i) => mondayOf(now, n - 1 - i));
}

/** The index of the week an instant falls in, or -1 outside them. */
export function weekIndex(weeks: readonly string[], at: string): number {
  const t = Date.parse(at);
  if (!Number.isFinite(t) || !weeks.length) return -1;
  for (let i = weeks.length - 1; i >= 0; i--) if (t >= Date.parse(`${weeks[i]}T00:00:00Z`)) return t < Date.parse(`${weeks[i]}T00:00:00Z`) + 7 * DAY ? i : -1;
  return -1;
}

const isColor = (c: string): c is AiThemeColor => (AI_THEME_COLORS as readonly string[]).includes(c);
const prCite = (p: Pick<MergedPrRow, "number" | "title" | "url" | "card_title">): AiCite => {
  const title = p.card_title ?? p.title;
  return { ref: `pr:${p.number}`, label: title ? `#${p.number} ${title}` : `#${p.number}`, href: p.url || null };
};

/** One range of the chart from the rows already read (PURE). */
export function themesForRange(
  range: AiThemeRange, now: number, themes: readonly ThemeRow[], suggestions: ReadonlyMap<number, number>, prs: readonly MergedPrRow[],
  caption: { text: string; generatedAt: string; model: string | null } | null,
  cap: { capped: boolean; resumesOn: string | null; upgrade: boolean } = { capped: false, resumesOn: null, upgrade: false },
): AiThemes {
  const weeks = weeksEnding(now, AI_THEME_RANGE_WEEKS[range]);
  const inRange = prs.map((p) => ({ p, w: weekIndex(weeks, p.at) })).filter((x) => x.w >= 0);
  const byNumber = new Map(inRange.map((x) => [x.p.number, x]));
  const drawn = new Set<number>();
  const lanes: AiThemeLane[] = [];
  for (const t of themes) {
    if (lanes.length >= THEME_LANES_MAX) break;
    const proposed = t.status === "proposed";
    const suggestionId = proposed ? suggestions.get(t.id) ?? null : null;
    if (proposed && suggestionId === null) continue; // a proposal nobody can act on is not drawn
    if (t.status !== "active" && !proposed) continue;
    // An active lane counts the PRs classified into it; a proposed lane, the PRs its proposal cited.
    const mine = proposed
      ? seedPrsOf(t).map((n) => byNumber.get(n)).filter((x): x is NonNullable<typeof x> => !!x)
      : inRange.filter((x) => x.p.theme_id === t.id);
    const counts = weeks.map(() => 0);
    for (const x of mine) { counts[x.w]++; drawn.add(x.p.number); }
    lanes.push({
      id: String(t.id), name: t.name, description: t.description, colorKey: isColor(t.color_key) ? t.color_key : "stone",
      counts, prs: mine.slice(0, THEME_LANE_PRS).map((x) => prCite(x.p)), status: proposed ? "proposed" : "active", suggestionId,
    });
  }
  const newest = themes.reduce<ThemeRow | null>((a, t) => (!a || t.created_at > a.created_at ? t : a), null);
  return {
    // At the month's cap the chart is still the server's count, and what Trov wrote is its LAST version (Q19).
    state: cap.capped ? "capped" : "ready",
    generatedAt: caption?.generatedAt ?? newest?.created_at ?? null,
    model: caption ? caption.model : newest?.model ?? null,
    resumesOn: cap.capped ? cap.resumesOn : null,
    upgrade: cap.capped && cap.upgrade,
    caption: caption?.text ?? null,
    prCount: drawn.size,
    range,
    weeks,
    lanes,
  };
}

/** `RepoDashboard.themes`, or undefined (see the file header). D1 only; throws on a D1 failure (the dashboard
 *  then leaves the field out and says it is degraded). */
export async function readRepoThemes(ctx: TenantContext, repo: string, now: number = Date.now()): Promise<Partial<Record<AiThemeRange, AiThemes>> | undefined> {
  if (!repo) return undefined;
  const gate = await aiShown(ctx, new Date(now));
  if (!gate.shown) return undefined;
  const [themes, suggestions] = await Promise.all([repoThemes(ctx, repo, ["active", "proposed"]), openThemeSuggestions(ctx, repo)]);
  const active = themes.filter((t) => t.status === "active");
  if (!active.length && !themes.some((t) => t.status === "proposed" && suggestions.has(t.id))) return undefined;
  const since = `${weeksEnding(now, AI_THEME_RANGE_WEEKS.quarter)[0]}T00:00:00.000Z`;
  const [prs, cap] = await Promise.all([mergedPrsSince(ctx, repo, since), latestCaption(ctx, repo, "8w")]);
  // A caption is shown only while every theme it names is still active (it was checked when written; a theme
  // since merged away would make it name a theme that is not).
  const activeIds = new Set(active.map((t) => t.id));
  let caption: { text: string; generatedAt: string; model: string | null } | null = null;
  if (cap) {
    let ids: unknown = [];
    try { ids = JSON.parse(cap.theme_ids); } catch { ids = null; }
    if (Array.isArray(ids) && ids.every((i) => activeIds.has(i as number))) caption = { text: cap.caption, generatedAt: cap.generated_at, model: cap.model };
  }
  // "Wrong?" hides a range for the person who pressed it (its ref names the range and when it was written, so a
  // newer version comes back): that range is left out for them; both flagged → absent.
  const hidden = await hiddenFor(ctx, ctx.userId, "themes").catch(() => new Set<string>()); // unreadable: hide nothing
  const out: Partial<Record<AiThemeRange, AiThemes>> = {};
  for (const r of AI_THEME_RANGES) {
    const t = themesForRange(r, now, themes, suggestions, prs, r === "8w" ? caption : null, gate);
    if (!hidden.has(aiItemRef.themes(repo, r, t.generatedAt ?? "themes"))) out[r] = t;
  }
  return Object.keys(out).length ? out : undefined;
}

// ── shares (the caption's input, and Phase E's roadmap drift) ────────────────

export interface ThemeShare { id: number; name: string; count: number; share: number }
export interface ThemeShares {
  /** Merged PRs in the window (themed or not). */
  total: number;
  /** Each active theme's PRs and share of `total` (0..1), in lane order. */
  themes: ThemeShare[];
  /** PRs with no active theme. */
  unthemed: number;
}

/** PURE: shares of `prs` (already in the window) over `active` themes. `total` 0 → every share 0. */
export function sharesOf(prs: readonly Pick<MergedPrRow, "theme_id">[], active: readonly Pick<ThemeRow, "id" | "name">[]): ThemeShares {
  const total = prs.length;
  const themes = active.map((t) => {
    const count = prs.filter((p) => p.theme_id === t.id).length;
    return { id: t.id, name: t.name, count, share: total ? count / total : 0 };
  });
  return { total, themes, unthemed: total - themes.reduce((n, t) => n + t.count, 0) };
}

/**
 * Each ACTIVE theme's share of the PRs merged in `[from, to)` for the repository — the read Phase E's roadmap drift
 * calls (themes against sprint contents). Null when the repository has no active theme (unknown, never 0s).
 */
export async function themeShares(ctx: TenantContext, repo: string, from: string, to: string): Promise<ThemeShares | null> {
  const active = await repoThemes(ctx, repo, ["active"]);
  if (!active.length) return null;
  const prs = (await mergedPrsSince(ctx, repo, from)).filter((p) => p.at < to);
  return sharesOf(prs, active);
}

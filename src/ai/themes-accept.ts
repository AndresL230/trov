// A proposed theme's answers (docs/architecture/ai.md › Themes): Trov PROPOSES themes (./themes.ts, the
// `themes.propose` batch job — a `proposed` repo_themes row plus an open `ai_suggestions` row of the same kind);
// only an ADMIN decides, through the cookie suggestion routes (./routes.ts → ./suggestions.ts):
//
//   POST /ai/suggestions/:id/accept {}                      Accept — the theme becomes active as proposed
//   POST /ai/suggestions/:id/accept { value: { name } }     Rename — active under the admin's name (1–40 chars)
//   POST /ai/suggestions/:id/accept { value: { mergeInto } } Merge — folded into another live theme of the repo
//   POST /ai/suggestions/:id/dismiss                         Remove — the theme is removed (an admin's, too)
//
// Accept, Rename and a Merge into an ACTIVE theme mark `theme_backfill:<repo>` (the router's `themes_accepted`),
// so the batch backfill classifies the window's earlier PRs. Everything is written AS the admin who pressed it.
import { AI_THEME_COLORS, AI_THEME_NAME_MAX } from "@shared/ai-core";
import type { TenantContext } from "../data/context";
import type { AiSuggestionRow } from "../data/ai";
import { activateTheme, getTheme, mergeTheme, removeTheme, THEME_ITEM_TYPE, THEME_SUGGESTION_KIND } from "../data/themes";
import { nowIso } from "../data/sql";
import { routeAi } from "./router";
import { AcceptRefused, type AcceptHandler } from "./accept";

/** A theme name as stored: whitespace collapsed, 1–40 characters. */
export const THEME_NAME_MAX = AI_THEME_NAME_MAX;
export const themeName = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  // A name wrapped in parentheses is refused: it could read as Jev's "(none of these)" option (./themes.ts).
  return s.length >= 1 && s.length <= THEME_NAME_MAX && !/^\(.*\)$/.test(s) ? s : null;
};

/** Why a rename's name is refused, in the words the Repo screen shows (Q20); null when it is a good name or not a
 *  name at all. */
export function themeNameRefusal(v: unknown): string | null {
  if (!v || typeof v !== "object" || Array.isArray(v) || !("name" in v)) return null;
  const raw = (v as { name: unknown }).name;
  if (typeof raw !== "string") return null;
  const s = raw.replace(/\s+/g, " ").trim();
  if (!s) return "A theme needs a name.";
  if (s.length > THEME_NAME_MAX) return `A theme name is at most ${THEME_NAME_MAX} characters.`;
  if (/^\(.*\)$/.test(s)) return "A theme name can't be wrapped in parentheses.";
  return null;
}

/** What an accept may carry: the stored value (`{ name, description }`), a new `name`, or `mergeInto`. */
type ThemeAcceptValue = { name: string } | { mergeInto: number };
function parseValue(v: unknown): ThemeAcceptValue | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if ("mergeInto" in o) return Number.isInteger(o.mergeInto) && (o.mergeInto as number) > 0 && !("name" in o) ? { mergeInto: o.mergeInto as number } : null;
  const name = themeName(o.name);
  return name ? { name } : null;
}

/** The theme a suggestion is about (`<repo>#<id>`), or null. */
function themeIdOf(s: Pick<AiSuggestionRow, "item_type" | "item_ref">): number | null {
  if (s.item_type !== THEME_ITEM_TYPE) return null;
  const id = Number(s.item_ref.slice(s.item_ref.lastIndexOf("#") + 1));
  return Number.isInteger(id) && id > 0 ? id : null;
}

const isUniqueClash = (e: unknown): boolean => e instanceof Error && /UNIQUE/i.test(e.message);

export const themeAcceptHandler: AcceptHandler = {
  role: "admin",
  dismissRole: "admin",
  valid: (v) => parseValue(v) !== null,
  refusal: themeNameRefusal,
  async apply(ctx: TenantContext, s: AiSuggestionRow, value: unknown): Promise<void> {
    const v = parseValue(value);
    const id = themeIdOf(s);
    if (!v || id === null) throw new AcceptRefused("invalid");
    const theme = await getTheme(ctx, id);
    if (!theme || theme.status !== "proposed") throw new AcceptRefused("not_open");
    const at = nowIso();
    if ("mergeInto" in v) {
      const into = await getTheme(ctx, v.mergeInto);
      if (!into || into.id === id || into.status === "removed" || into.repo.toLowerCase() !== theme.repo.toLowerCase()) throw new AcceptRefused("invalid");
      if (!(await mergeTheme(ctx, id, into.id, ctx.userId, at))) throw new AcceptRefused("not_open");
      if (into.status === "active") await routeAi(ctx, { type: "themes_accepted" });
      return;
    }
    const rename = v.name === theme.name ? undefined : v.name;
    let ok = false;
    try {
      ok = await activateTheme(ctx, id, ctx.userId, at, rename);
    } catch (e) {
      // Another live theme has that name (merge instead): say so, in the admin's own spelling (Q20).
      if (isUniqueClash(e)) throw new AcceptRefused("invalid", `A theme named ${v.name} already exists.`);
      throw e;
    }
    if (!ok) throw new AcceptRefused("not_open");
    await routeAi(ctx, { type: "themes_accepted" });
  },
  async dismissed(ctx: TenantContext, s: AiSuggestionRow): Promise<void> {
    const id = themeIdOf(s);
    if (id !== null) await removeTheme(ctx, id, ctx.userId, nowIso());
  },
};

/** The handlers this producer registers (./suggestions.ts `AI_ACCEPT_HANDLERS`). */
export const THEME_ACCEPT_HANDLERS: Readonly<Record<string, AcceptHandler>> = { [THEME_SUGGESTION_KIND]: themeAcceptHandler };

/** The palette keys a new theme takes, in order, skipping the ones live themes already use (then reusing). */
export function freeColors(used: readonly string[], n: number): string[] {
  const free = AI_THEME_COLORS.filter((c) => !used.includes(c));
  const pool = free.length ? free : [...AI_THEME_COLORS];
  return Array.from({ length: n }, (_, i) => pool[i % pool.length]);
}

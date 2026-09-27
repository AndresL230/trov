// The "search everything" dropdown's wire DTO (GET /search/quick) — zod-free, so the
// SPA imports it freely. The Worker side is src/tools/quick-search.ts; the panel is
// web/src/quicksearch.ts.
//
// A hit carries a TITLE and a few short fields the panel composes into ONE context
// line (a snippet, a status, who, when). Never a body: the dropdown is a jump list,
// and the full Search screen (GET /search) is one keystroke away for anything more.

/** Every server-side group, in the order the panel lists them. */
export const QUICK_TYPES = ["ticket", "doc", "decision", "sprint", "artifact", "prompt", "handoff", "person", "feed"] as const;
export type QuickType = (typeof QUICK_TYPES)[number];

export interface QuickHit {
  type: QuickType;
  /** doc / artifact / prompt slug · ticket / handoff / feed / decision id as text ·
   *  `sprint:<id>` or `plan` · a person's handle. */
  id: string;
  title: string;
  /** A short plain-text excerpt around the match (no markup), or null. */
  snippet: string | null;
  /** A status word where the type has one (ticket status, sprint status, prompt/artifact status). */
  status: string | null;
  /** Who: a doc's last editor, a feed/ticket author, a handoff's sender, … */
  by: string | null;
  /** When (ISO). */
  at: string | null;
  /** A person hit's color (the avatar chip). */
  color?: string | null;
  avatar_url?: string | null;
}

export interface QuickGroup {
  type: QuickType;
  hits: QuickHit[];
}

export interface QuickSearchResult {
  q: string;
  /** Non-empty groups only, in QUICK_TYPES order. */
  groups: QuickGroup[];
}

/** Below this many characters the Worker returns no groups and never touches D1 —
 *  the panel shows only its static Screens list. */
export const QUICK_MIN_CHARS = 2;
/** Per-group hit count: default and ceiling. */
export const QUICK_LIMIT_DEFAULT = 4;
export const QUICK_LIMIT_MAX = 8;

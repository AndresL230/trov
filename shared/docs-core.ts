// The Docs Library's spaces (0076_docs_library; docs/architecture/docs-library.md) — ZOD-FREE, so the SPA
// imports it as a value and the Worker keeps one definition: the alias map the gate and the filters apply,
// the starter spaces every org begins with, the icon and color choices, the name / slug rules, the order,
// and the DTOs of the space routes (src/spaces/routes.ts).
import { BOARD_RANK_STEP, placeInColumn } from "./tickets-core";

// ── what a space is called on the wire ───────────────────────────────────────

/** The space values agents sent before spaces were the org's own (0005/0020: `technical` | `product`). ONE map,
 *  applied by the gate (src/consumer.ts) and by the `space` filters of `query` / `list_docs` / `/search`. A value
 *  that is no alias is taken as it is (a slug). `product` is a space's own slug, so it needs no entry. */
export const SPACE_ALIASES: Readonly<Record<string, string>> = Object.freeze({ technical: "engineering" });

/** A sent space value as the slug it means: trimmed, lowercased, through SPACE_ALIASES. Never guesses: an
 *  unknown value comes back as itself (the gate then finds no such space). Empty → null. */
export function resolveSpaceAlias(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  return SPACE_ALIASES[v] ?? v;
}

/** Where a NEW doc goes when its proposal names no space — only while this space exists and is live. */
export const DEFAULT_SPACE = "engineering";

// ── the choices ──────────────────────────────────────────────────────────────

/** The icons a space may have, in the Create space modal's order (the design's). */
export const SPACE_ICONS = ["braces", "compass", "pen", "shield", "flask", "rocket", "book", "users", "chart", "server", "megaphone", "lock"] as const;
export type SpaceIcon = (typeof SPACE_ICONS)[number];
export const isSpaceIcon = (v: unknown): v is SpaceIcon => typeof v === "string" && (SPACE_ICONS as readonly string[]).includes(v);

/** The colors a space may have (the design's swatches). */
export const SPACE_COLORS = ["#525cc3", "#2467af", "#2f7d57", "#607a29", "#966800", "#b4562c", "#a84a68", "#7a4f8f"] as const;
export type SpaceColor = (typeof SPACE_COLORS)[number];
export const isSpaceColor = (v: unknown): v is SpaceColor => typeof v === "string" && (SPACE_COLORS as readonly string[]).includes(v.toLowerCase());

/** What the Create space modal opens with. */
export const NEW_SPACE_ICON: SpaceIcon = "shield";
export const NEW_SPACE_COLOR: SpaceColor = "#b4562c";

/** The three spaces every org starts with — the same rows as 0076_docs_library's seed (a test compares them),
 *  and what src/orgs/repo.ts createOrg writes for a new org. */
export const STARTER_SPACES: ReadonlyArray<{ slug: string; name: string; icon: SpaceIcon; color: SpaceColor; sort_rank: number }> = [
  { slug: "engineering", name: "Engineering", icon: "braces", color: "#525cc3", sort_rank: 1024 },
  { slug: "product", name: "Product", icon: "compass", color: "#2f7d57", sort_rank: 2048 },
  { slug: "design", name: "Design", icon: "pen", color: "#a84a68", sort_rank: 3072 },
];

// ── names and slugs ──────────────────────────────────────────────────────────

export const SPACE_NAME_MAX = 40;
export const SPACE_DESCRIPTION_MAX = 140;
export const SPACE_SLUG_MAX = 40;
/** A space's slug: lowercase letters, digits and hyphens, starting with a letter or digit. */
export const SPACE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** A name as stored: whitespace collapsed and trimmed; null when empty or over SPACE_NAME_MAX. */
export function cleanSpaceName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.replace(/\s+/g, " ").trim();
  return v.length >= 1 && v.length <= SPACE_NAME_MAX ? v : null;
}

/** A description as stored: whitespace collapsed and trimmed; null when over SPACE_DESCRIPTION_MAX. */
export function cleanSpaceDescription(raw: unknown): string | null {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") return null;
  const v = raw.replace(/\s+/g, " ").trim();
  return v.length <= SPACE_DESCRIPTION_MAX ? v : null;
}

/** The slug a name gives: lowercase ASCII words joined by hyphens; "space" when nothing usable is left. */
export function spaceSlugFromName(name: string): string {
  const base = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, SPACE_SLUG_MAX - 4).replace(/-+$/g, "");
  return base || "space";
}

/** `base`, or `base-2`, `base-3` … — the first that no space of the org has EVER had (`taken` holds every slug,
 *  archived ones too: a slug is reserved forever). */
export function uniqueSpaceSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** The live space whose name equals `name` (trimmed, case-insensitive), if any — the Create space modal's
 *  "There's already a space called …" and the repository's check before the unique index. */
export function spaceNamedLike<T extends { name: string; archived?: boolean; slug?: string }>(spaces: readonly T[], name: string, except?: string): T | null {
  const key = name.replace(/\s+/g, " ").trim().toLowerCase();
  if (!key) return null;
  return spaces.find((s) => !s.archived && s.slug !== except && s.name.trim().toLowerCase() === key) ?? null;
}

// ── order ────────────────────────────────────────────────────────────────────

export interface SpaceOrderKey { slug: string; sort_rank: number | null; created_at: string }

/** The Library's order: by sort_rank (a space without one last), then oldest first, then slug. */
export function spaceOrder(a: SpaceOrderKey, b: SpaceOrderKey): number {
  const an = a.sort_rank === null, bn = b.sort_rank === null;
  if (an !== bn) return an ? 1 : -1;
  if (!an && a.sort_rank !== b.sort_rank) return (a.sort_rank as number) - (b.sort_rank as number);
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
}

/** The rank of a space after every other one (a new space goes last). */
export function rankAfterAll(spaces: readonly SpaceOrderKey[]): number {
  const ranks = spaces.map((s) => s.sort_rank).filter((r): r is number => r !== null);
  return ranks.length ? Math.max(...ranks) + BOARD_RANK_STEP : BOARD_RANK_STEP;
}

/**
 * Where `slug` goes when it is put right after `afterSlug` (null = first) among `spaces` (which may include it):
 * its new rank and, when the others had to be respaced (one had no rank, or two were too close), every other
 * space's new rank. The SAME placement as the ticket board (`placeInColumn`), keyed by slug.
 */
export function placeSpace(spaces: readonly SpaceOrderKey[], slug: string, afterSlug: string | null): { rank: number; renumber: Map<string, number> | null } {
  const others = spaces.filter((s) => s.slug !== slug).sort(spaceOrder);
  // placeInColumn reads NULL as "first"; a space without a rank sorts LAST here, so give every one a rank in
  // this order first (and write those too).
  let pre: Map<string, number> | null = null;
  if (others.some((s) => s.sort_rank === null)) pre = new Map(others.map((s, i) => [s.slug, (i + 1) * BOARD_RANK_STEP]));
  const keyed = others.map((s, i) => ({ id: i + 1, board_rank: pre ? (pre.get(s.slug) as number) : (s.sort_rank as number), updated_at: "" }));
  const afterIdx = afterSlug === null ? -1 : others.findIndex((s) => s.slug === afterSlug);
  const { rank, renumber } = placeInColumn(keyed, afterIdx < 0 ? null : afterIdx + 1);
  let out: Map<string, number> | null = pre;
  if (renumber) out = new Map(others.map((s, i) => [s.slug, (renumber as Map<number, number>).get(i + 1) as number]));
  return { rank, renumber: out };
}

// ── statuses ─────────────────────────────────────────────────────────────────

/** A page's status, from the query engine's authority flags: `live` (nothing drawn in lists), `staged_pending`
 *  ("Change pending review": a newer version waits in Review), `unpromoted` ("Not yet approved": never promoted). */
export type PageAuthority = "live" | "staged_pending" | "unpromoted";

export function pageAuthority(currentVersion: number, latestStagedVersion: number | null): PageAuthority {
  if (currentVersion <= 0) return "unpromoted";
  return latestStagedVersion !== null && latestStagedVersion > currentVersion ? "staged_pending" : "live";
}

// ── the DTOs of the space routes ─────────────────────────────────────────────

/** One space as the Library lists it. `owners` are handles (the SPA draws each through people.ts). */
export interface SpaceDTO {
  slug: string;
  name: string;
  icon: SpaceIcon;
  color: SpaceColor;
  description: string;
  sort_rank: number | null;
  created_at: string;
  created_by: string;
  archived: boolean;
  archived_at: string | null;
  owners: string[];
  /** Every page of the space: live, waiting and never-approved. */
  pages: number;
  /** Pages that are not live: a change pending review, or not yet approved. */
  waiting: number;
}

/** One page in a list (Library home's Recently updated, a Space home tab). No body. */
export interface LibraryPageDTO {
  slug: string;
  title: string;
  space: string;
  section: string;
  parent_slug: string | null;
  tree_rank: number | null;
  /** The titles of the page's ancestors, top first ([] = top level). */
  path: string[];
  authority: PageAuthority;
  current_version: number;
  updated_at: string | null;
  updated_by: string | null;
  owner: string | null;
}

/** `GET /spaces` — Library home and the sidebar's Library group. `archived` is filled for an admin only. */
export interface LibraryDTO {
  spaces: SpaceDTO[];
  archived: SpaceDTO[];
  /** The 6 most recently updated pages across the live spaces. */
  recent: LibraryPageDTO[];
  /** Pages waiting for review across the live spaces (the sum of `spaces[].waiting`). */
  waiting: number;
  /** May the reader create, rename, reorder, archive and restore spaces (an admin)? */
  can_admin: boolean;
}

/** `GET /spaces/:slug` — Space home. `pages` is every page of the space, staged-only ones included. */
export interface SpaceHomeDTO {
  space: SpaceDTO;
  pages: LibraryPageDTO[];
  /** May the reader edit the description and the owners (an admin, or an owner of this space)? */
  can_edit: boolean;
  can_admin: boolean;
}

/** `org_admin_audit.action` for a space write. */
export type SpaceAuditAction = "space.create" | "space.edit" | "space.reorder" | "space.archive" | "space.restore" | "space.owners";

/** The refusal codes of the space routes (`{ error: code, message }`). */
export type SpaceErrorCode = "invalid" | "name_taken" | "not_found" | "archived" | "forbidden" | "not_member";

// ── copy shared by the screens ───────────────────────────────────────────────

/** "1 page" / "N pages". */
export const pagesWord = (n: number): string => `${n} ${n === 1 ? "page" : "pages"}`;

/** "Owned by A", "Owned by A and B", "Owned by A, B and C". */
export function ownedBy(names: readonly string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return `Owned by ${names[0]}`;
  return `Owned by ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

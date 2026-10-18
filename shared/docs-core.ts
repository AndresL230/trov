// The Docs Library's spaces (0081_docs_library; docs/architecture/docs-library.md) — ZOD-FREE, so the SPA
// imports it as a value and the Worker keeps one definition: the alias map the gate and the filters apply,
// the starter spaces every org begins with, the icon and color choices, the name / slug rules, the order,
// and the DTOs of the space routes (src/spaces/routes.ts).
import { BOARD_RANK_STEP } from "./tickets-core";

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

/** The three spaces every org starts with — the same rows as 0081_docs_library's seed (a test compares them),
 *  and what src/orgs/repo.ts createOrg writes for a new org. */
export const STARTER_SPACES: ReadonlyArray<{ slug: string; name: string; icon: SpaceIcon; color: SpaceColor; sort_rank: number }> = [
  { slug: "design", name: "Design", icon: "pen", color: "#a84a68", sort_rank: 1024 },
  { slug: "engineering", name: "Engineering", icon: "braces", color: "#525cc3", sort_rank: 2048 },
  { slug: "product", name: "Product", icon: "compass", color: "#2f7d57", sort_rank: 3072 },
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

export interface SpaceOrderKey { slug: string; name: string; sort_rank: number | null; created_at: string }

/** The Library's order: A to Z by name (case and accents aside), then oldest first, then slug. Nobody sets an org
 *  order; each person picks their own sidebar and pins their own cards (below). */
export function spaceOrder(a: SpaceOrderKey, b: SpaceOrderKey): number {
  const n = a.name.localeCompare(b.name, "en", { sensitivity: "base" });
  if (n !== 0) return n;
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
}

/** The rank of a space after every other one. `sort_rank` no longer orders anything (the order is by name); a new or
 *  restored space still gets one, so the column stays filled. */
export function rankAfterAll(spaces: readonly SpaceOrderKey[]): number {
  const ranks = spaces.map((s) => s.sort_rank).filter((r): r is number => r !== null);
  return ranks.length ? Math.max(...ranks) + BOARD_RANK_STEP : BOARD_RANK_STEP;
}

// ── a person's own Library: the sidebar's spaces, pinned and hidden cards ─────
// Each person, in each org, shapes their own view (`library_prefs`, 0076_10_17_staging › 0084_library_prefs). The
// Library's order (A to Z) is the starting point: the sidebar shows the first
// SIDEBAR_SPACES_MAX spaces until the person picks their own, in their own order; Library home shows pinned cards
// first (in pinning order), then the rest in the Library's order, and hidden ones only under "Hidden".

export const SIDEBAR_SPACES_MAX = 5;

/** A person's Library view. `sidebar` null = the default (the first five spaces in the Library's order). Slugs only;
 *  a slug no live space has (archived since) is dropped on read. `pinned` and `hidden` never share a slug. */
export interface LibraryPrefsDTO { sidebar: string[] | null; pinned: string[]; hidden: string[] }
export const DEFAULT_LIBRARY_PREFS: LibraryPrefsDTO = { sidebar: null, pinned: [], hidden: [] };

/** The spaces the sidebar shows, at most SIDEBAR_SPACES_MAX: the person's own list, else the first in `spaces`'s
 *  order (the Library's). */
export function sidebarSpaces<T extends { slug: string }>(spaces: readonly T[], prefs: LibraryPrefsDTO | null | undefined): T[] {
  if (!prefs || prefs.sidebar === null) return spaces.slice(0, SIDEBAR_SPACES_MAX);
  const by = new Map(spaces.map((s) => [s.slug, s]));
  return prefs.sidebar.map((k) => by.get(k)).filter((s): s is T => s !== undefined).slice(0, SIDEBAR_SPACES_MAX);
}

/** The slugs the sidebar shows — what Customize starts from, and what "Show in sidebar" adds to. */
export const sidebarSlugs = (spaces: readonly { slug: string }[], prefs: LibraryPrefsDTO | null | undefined): string[] =>
  sidebarSpaces(spaces, prefs).map((s) => s.slug);

/** Library home's cards: the pinned ones in pinning order, the rest in the Library's order, the hidden ones apart. */
export function libraryCards<T extends { slug: string }>(spaces: readonly T[], prefs: LibraryPrefsDTO | null | undefined): { pinned: T[]; rest: T[]; hidden: T[] } {
  const p = prefs ?? DEFAULT_LIBRARY_PREFS;
  const by = new Map(spaces.map((s) => [s.slug, s]));
  const hidden = new Set(p.hidden);
  const pinned = p.pinned.filter((k) => !hidden.has(k)).map((k) => by.get(k)).filter((s): s is T => s !== undefined);
  const pinnedSet = new Set(pinned.map((s) => s.slug));
  return {
    pinned,
    rest: spaces.filter((s) => !pinnedSet.has(s.slug) && !hidden.has(s.slug)),
    hidden: spaces.filter((s) => hidden.has(s.slug)),
  };
}

/** Prefs as stored, read back against the org's live spaces: unknown or archived slugs dropped, duplicates dropped,
 *  the sidebar cut to its cap, a hidden space never also pinned. Never throws (a bad stored value reads as default). */
export function liveLibraryPrefs(stored: { sidebar: unknown; pinned: unknown; hidden: unknown }, live: ReadonlySet<string>): LibraryPrefsDTO {
  const list = (v: unknown): string[] => {
    let a: unknown = v;
    if (typeof v === "string") { try { a = JSON.parse(v); } catch { return []; } }
    return Array.isArray(a) ? [...new Set(a.filter((x): x is string => typeof x === "string" && live.has(x)))] : [];
  };
  const hidden = list(stored.hidden);
  const hiddenSet = new Set(hidden);
  const sidebarRaw = stored.sidebar === null || stored.sidebar === undefined ? null : list(stored.sidebar);
  return {
    sidebar: sidebarRaw === null ? null : sidebarRaw.slice(0, SIDEBAR_SPACES_MAX),
    pinned: list(stored.pinned).filter((k) => !hiddenSet.has(k)),
    hidden,
  };
}

/** Why a save of a person's Library view is refused — in words that say what to change. */
export type LibraryPrefsRefusal = { field: "sidebar" | "pinned" | "hidden"; message: string };

/** Check a save: each list given must be an array of distinct live space slugs, the sidebar at most
 *  SIDEBAR_SPACES_MAX (or null for the default), and no space both pinned and hidden. Lists left out keep `current`. */
export function checkLibraryPrefs(input: Record<string, unknown>, current: LibraryPrefsDTO, live: ReadonlySet<string>): { ok: true; prefs: LibraryPrefsDTO } | { ok: false; refusal: LibraryPrefsRefusal } {
  const read = (field: "sidebar" | "pinned" | "hidden"): string[] | LibraryPrefsRefusal => {
    const v = input[field];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) return { field, message: `${field} is a list of space slugs` };
    const a = v as string[];
    if (new Set(a).size !== a.length) return { field, message: `${field} names a space twice` };
    const unknown = a.find((k) => !live.has(k));
    if (unknown !== undefined) return { field, message: `${field} names a space this organization doesn't have` };
    return a;
  };
  const next: LibraryPrefsDTO = { ...current };
  if ("sidebar" in input) {
    if (input.sidebar === null) next.sidebar = null;
    else {
      const r = read("sidebar");
      if (!Array.isArray(r)) return { ok: false, refusal: r };
      if (r.length > SIDEBAR_SPACES_MAX) return { ok: false, refusal: { field: "sidebar", message: `the sidebar shows at most ${SIDEBAR_SPACES_MAX} spaces` } };
      next.sidebar = r;
    }
  }
  for (const field of ["pinned", "hidden"] as const) {
    if (!(field in input)) continue;
    const r = read(field);
    if (!Array.isArray(r)) return { ok: false, refusal: r };
    next[field] = r;
  }
  if (next.pinned.some((k) => next.hidden.includes(k))) return { ok: false, refusal: { field: "pinned", message: "a space can't be both pinned and hidden" } };
  return { ok: true, prefs: next };
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
  /** The reader's own view: their sidebar's spaces, their pinned and hidden cards (live slugs only). The Worker always
   *  sends it; absent reads as the default view. */
  prefs?: LibraryPrefsDTO;
  archived: SpaceDTO[];
  /** The 6 most recently updated pages across the live spaces. */
  recent: LibraryPageDTO[];
  /** Pages waiting for review across the live spaces (the sum of `spaces[].waiting`). */
  waiting: number;
  /** May the reader create, rename, archive and restore spaces (an admin)? */
  can_admin: boolean;
}

/** `GET /spaces/:slug` — Space home. `pages` is every page of the space, staged-only ones included. */
export interface SpaceHomeDTO {
  space: SpaceDTO;
  pages: LibraryPageDTO[];
  /** Each top-level page's card line (`pageSummary` of the body it shows), by slug; a page with none is left out. */
  summaries?: Record<string, string>;
  /** The space's archived pages (0083_doc_archive), newest archived first — Space home's Archived pages. */
  archived_pages?: ArchivedPageDTO[];
  /** May the reader edit the description and the owners (an admin, or an owner of this space)? */
  can_edit: boolean;
  /** May the reader archive and restore its pages (an admin, or an owner of this space; never while the space is
   *  archived)? */
  can_archive?: boolean;
  can_admin: boolean;
}

/** An archived page as its space's Archived pages lists it (0083_doc_archive). */
export interface ArchivedPageDTO {
  slug: string;
  title: string;
  archived_at: string;
  archived_by: string | null;
  current_version: number;
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

// ── the page tree and the doc page (the tree PR; docs-library.md › The page tree) ──

/** `POST /doc/:slug/move`'s body: put the page into / before / after another page of its space, or at the end of
 *  the space's top level. */
export interface DocMoveBody { target: "into" | "before" | "after" | "top"; ref?: string }

/** One page's place after a move — the move's answer carries every page of the space it touched. */
export interface DocTreePlace { slug: string; parent_slug: string | null; tree_rank: number | null }

/** `POST /doc/:slug/move`'s answer: where the page went, and the new place of every page it renumbered. */
export interface DocMoveResult { ok: true; slug: string; parent_slug: string | null; tree_rank: number; places: DocTreePlace[] }

/** The move route's refusal codes (`{ error: code, message }`): a bad body (400), no such page (404), the rules of
 *  the tree (409: `cycle`, `too_deep`, `self`, `other_space`), or a space that is archived (409). */
export type DocMoveErrorCode = "invalid" | "not_found" | "cycle" | "too_deep" | "self" | "other_space" | "archived";

/** A page another page points at (a `[[slug]]` that resolves), or one that points here (a backlink). */
export interface DocPageRef {
  slug: string;
  title: string;
  space: string;
  /** The titles above it in its space, top first ([] = top level). */
  path: string[];
  authority: PageAuthority;
}

/** The doc page's rail: who owns it, who wrote the version shown, its version, and where it was imported from. */
export interface DocPageInfo {
  /** Who proposed its first version (0035) — the page's owner. */
  owner: string | null;
  /** Who wrote the version shown (the live one; the newest staged one for a page not yet approved), and when. */
  edited_by: string | null;
  edited_at: string | null;
  /** The live version (0 = never approved). */
  version: number;
  /** The newest version waiting in Review, when it is newer than the live one. */
  pending_version: number | null;
  /** The Markdown file the version shown was imported from (an import run), else null. */
  imported_from: { path: string; file_name: string | null } | null;
}

/** `GET /doc/:slug`'s `page`: the doc's place in its tree, its links both ways, and the rail. */
export interface DocPageDTO {
  authority: PageAuthority;
  parent_slug: string | null;
  /** The pages above it, top first (the breadcrumb). */
  ancestors: { slug: string; title: string }[];
  /** The pages right under it, in tree order ("Pages under ‹Title›"). */
  children: LibraryPageDTO[];
  /** The body shown: the live body, or — for a page never approved — its newest staged version's. */
  body: string;
  /** The pages its `[[slug]]` links reach (those that exist), and the slugs of those that reach nothing. */
  links: DocPageRef[];
  broken_links: string[];
  /** The live pages whose live body links here ("Linked from"). */
  backlinks: DocPageRef[];
  info: DocPageInfo;
  /** The `[[slug]]` targets that are ARCHIVED pages (0083_doc_archive), with their titles: drawn as plain text marked
   *  "Archived". */
  archived_links?: { slug: string; title: string }[];
  /** This page is archived (0083_doc_archive): when and by whom. Read-only then, with Restore for `can_archive`. */
  archived?: { at: string; by: string | null } | null;
  /** May the reader archive (or, archived, restore) this page — an org admin or an owner of its space, while the
   *  space is live? */
  can_archive?: boolean;
}

// ── Archive page (0083_doc_archive; docs-library.md › Archiving a page) ──

/** `POST /doc/:slug/archive`'s answer: the page and every page it moved (its children, up a level, and the siblings
 *  renumbered with them). */
export interface DocArchiveResult { ok: true; slug: string; archived_at: string; parent_slug: string | null; places: DocTreePlace[] }

/** `POST /doc/:slug/restore`'s answer: where the page went back (its old parent, else the top level). */
export interface DocRestoreResult { ok: true; slug: string; parent_slug: string | null; tree_rank: number; places: DocTreePlace[] }

/** The refusals of archive / restore (`{ error: code, message }`): no such page of the org (404), not an admin or an
 *  owner of its space (403), already archived / not archived / its space is archived (409). */
export type DocArchiveErrorCode = "not_found" | "forbidden" | "archived" | "not_archived" | "space_archived";

/** The Archive page confirmation's sentence (the brief's copy). */
export function archivePageText(title: string, under: number, spaceName: string): string {
  const moved = under === 0 ? "" : under === 1 ? " The page under it moves up a level." : ` ${under} pages under it move up a level.`;
  return `${title} leaves the Library.${moved} You can restore it from ${spaceName}'s Archived pages.`;
}

// ── a page's card line (Space home's Top-level pages, E2E SH2) ────────────────

/** The longest a card line runs before it is cut on a word with "…". */
export const PAGE_SUMMARY_MAX = 140;

/** A page's card line: the first sentence of its body, derived when it is read (nothing is stored). Code blocks,
 *  headings, tables, rules and images are skipped; links keep their words (`[[slug|words]]` too); emphasis, inline
 *  code marks, HTML tags, quote and list markers go. The first block of text left is taken — a list's first item
 *  only — and cut after its first sentence (a ".", "!" or "?" before a capital, a digit or the end), then on a word
 *  at `max`. "" when the body has no such text. */
export function pageSummary(body: string, max = PAGE_SUMMARY_MAX): string {
  const lines = (body ?? "").replace(/\r\n?/g, "\n").split("\n");
  const block: string[] = [];
  let fence: string | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    const f = line.match(/^(`{3,}|~{3,})/);
    if (fence) { if (f && line.startsWith(fence)) fence = null; continue; }
    if (f) { fence = f[1]; if (block.length) break; continue; }
    const skip = line === "" || /^#{1,6}(\s|$)/.test(line) || /^\|/.test(line) || /^([-*_]\s*){3,}$/.test(line) || /^<!--/.test(line);
    if (skip) { if (block.length) break; continue; }
    const item = /^([-*+]|\d+[.)])\s+/.test(line);
    if (item && block.length) break;
    const text = inlineText(line.replace(/^(>\s*)+/, "").replace(/^([-*+]|\d+[.)])\s+/, ""));
    if (!text) continue;
    block.push(text);
    if (item) break;
  }
  const para = block.join(" ").replace(/\s+/g, " ").trim();
  if (!para) return "";
  const end = para.match(/^.*?[.!?](?=\s+["'“(]?[A-Z0-9]|$)/);
  const sentence = (end ? end[0] : para).trim();
  if (sentence.length <= max) return sentence;
  const cut = sentence.slice(0, max - 1);
  const at = cut.lastIndexOf(" ");
  return `${(at > max / 2 ? cut.slice(0, at) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

/** One line of Markdown as its words. */
function inlineText(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\((?:[^()]|\([^()]*\))*\)/g, "")          // images
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, slug: string, words?: string) => (words ?? slug).trim())
    .replace(/\[([^\]]+)\]\((?:[^()]|\([^()]*\))*\)/g, "$1")        // links keep their words (a target may hold "(…)")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?(<\/\1\s*>|$)/gi, "")      // a script or style, and what it holds
    .replace(/<[^>]+>/g, "")                                      // tags
    .replace(/`([^`]*)`/g, "$1")                                  // inline code
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

// The organization's tag list (0054_org_tags; docs/architecture/feed-and-search.md › Tags). Zod-free and
// dependency-free: the Worker, the gate and the SPA all read it.
//
// Every org has ONE list of tags. It starts as the six STARTER tags (shared/vocabulary.ts `TAGS`, the
// names 0002_seed_vocab.sql seeded) and only an org admin changes it: add, rename, merge, retire. An
// agent can only USE a tag that is on the list; a tag it sends that is not becomes a SUGGESTION an admin
// resolves. Phase 1 puts tags on feed entries, docs and decisions; tickets, artifacts and prompts follow.
import { TAGS } from "./vocabulary";

/** A tag's colour: one of the person palette's keys, drawn as `var(--p-<key>)` (web/src/trov.css) — the
 *  eight that stay apart at 8px in both themes. */
export const TAG_COLORS = ["moss", "fern", "sky", "slate", "plum", "rose", "rust", "ochre"] as const;
export type TagColor = (typeof TAG_COLORS)[number];
export const isTagColor = (v: unknown): v is TagColor => typeof v === "string" && (TAG_COLORS as readonly string[]).includes(v);
/** The colour a new tag gets when none is picked: the palette in turn, by how many tags the org has. */
export const nextTagColor = (count: number): TagColor => TAG_COLORS[((count % TAG_COLORS.length) + TAG_COLORS.length) % TAG_COLORS.length];

export const TAG_NAME_MAX = 32;
export const TAG_DESCRIPTION_MAX = 120;
const TAG_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * A tag's stored spelling: lowercase, inner spaces and underscores as one hyphen. null when what is
 * left is not a name (empty, over `TAG_NAME_MAX`, or anything but letters, digits and hyphens).
 * The gate reads an agent's tag through this, so "Auth" and " auth " are the tag `auth`.
 */
export function normalizeTagName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  return name.length > 0 && name.length <= TAG_NAME_MAX && TAG_NAME_RE.test(name) ? name : null;
}

/** One line on what a tag is for. null when it is not a string or is over `TAG_DESCRIPTION_MAX`. */
export function cleanTagDescription(raw: unknown): string | null {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") return null;
  const d = raw.replace(/\s+/g, " ").trim();
  return d.length <= TAG_DESCRIPTION_MAX ? d : null;
}

export interface StarterTag { name: (typeof TAGS)[number]; description: string; color: TagColor }
/** The six tags every organization starts with — the SAME rows 0054_org_tags seeds for the orgs that
 *  existed then (a test compares the two). They can be renamed, never retired or merged away. */
export const STARTER_TAGS: readonly StarterTag[] = [
  { name: "auth", description: "Sign-in, sessions, tokens, permissions", color: "plum" },
  { name: "architecture", description: "How the system is put together", color: "slate" },
  { name: "infra", description: "Deploys, hosting, CI", color: "rust" },
  { name: "api", description: "Routes and what they return", color: "sky" },
  { name: "ui", description: "Screens and components", color: "rose" },
  { name: "data", description: "Tables, migrations, storage", color: "fern" },
];

/** What a tag can be on, in phase 1 — `entry_tags.entry_type`. A feed entry's id is its number, a
 *  doc's its slug, a decision's its number. */
export const TAG_ITEM_TYPES = ["feed", "doc", "adr"] as const;
export type TagItemType = (typeof TAG_ITEM_TYPES)[number];
export const isTagItemType = (v: unknown): v is TagItemType => typeof v === "string" && (TAG_ITEM_TYPES as readonly string[]).includes(v);
export const TAG_ITEM_LABEL: Record<TagItemType, { one: string; many: string }> = {
  feed: { one: "feed entry", many: "feed entries" },
  doc: { one: "doc", many: "docs" },
  adr: { one: "decision", many: "decisions" },
};

/** How many tags one item may carry. */
export const ITEM_TAGS_MAX = 12;

/** How many of each type carry a tag. */
export type TagCounts = Record<TagItemType, number>;

export interface OrgTagDTO {
  name: string;
  description: string;
  color: TagColor;
  /** One of the six every org starts with: it can be renamed, not retired or merged into another. */
  starter: boolean;
  /** Retired: it stays on what already has it and can no longer be picked. */
  retired: boolean;
  counts: TagCounts;
}

/** A tag as a picker or a list draws it — what `GET …/tags` gives every member. */
export type TagRef = Pick<OrgTagDTO, "name" | "description" | "color" | "retired">;

export interface TagSuggestionDTO {
  name: string;
  /** Items that carried it and are saved without it, per type. */
  counts: TagCounts;
  uses: number;
  /** Who sent it, the earliest first. */
  by: string[];
  first_at: string;
  last_at: string;
  /** A live tag whose name is close to it ("authn" → "auth"), when there is one. */
  similar: string | null;
}

/** A run of "which existing items fit this tag?" (src/tools/tag-fit.ts). */
export interface TagRunDTO {
  status: "running" | "done" | "capped" | "failed";
  started_at: string;
  ended_at: string | null;
  /** Items picked to be checked (0 until they are picked; 0 at the end = there was nothing to check). */
  candidates: number;
  /** Items the model has answered about so far. */
  checked: number;
  /** Of those, the ones stored as "may fit". */
  suggested: number;
}

/** One open MODEL suggestion that an item fits a tag — never drawn as a tag the item has. */
export interface TagFitDTO {
  type: TagItemType;
  id: string;
  title: string;
  /** One sentence: why the model thinks it fits. */
  reason: string;
  confidence: number;
  suggested_at: string;
}

/** The org's switch for model suggestions, and where the month's allowance stands — admins only. */
export interface TagAiDTO {
  /** The org's switch (`org_ai_settings`, kind `tag.fit`). */
  enabled: boolean;
  /** The platform can call a model at all (its key is set). */
  available: boolean;
  used: number;
  /** null = unlimited. */
  cap: number | null;
  spent: boolean;
}

export interface TagListDTO {
  tags: OrgTagDTO[];
  /** Admins only (absent for a member): the AI switch and allowance. */
  ai?: TagAiDTO;
  /** Admins only: per live tag, how many items MAY fit it (open model suggestions) and its latest run. */
  fits?: Record<string, { open: number; run: TagRunDTO | null }>;
  /** Live tags, of the plan's `cap` (null = no cap). Retired tags do not count. */
  used: number;
  cap: number | null;
  /** Pending suggestions — admins only; a member gets []. */
  suggestions: TagSuggestionDTO[];
}

export interface TagPageItem {
  type: TagItemType;
  /** The feed entry's number, the doc's slug, the decision's number. */
  id: string;
  title: string;
  /** A feed entry's brief; a doc's section; a decision's status. */
  note: string | null;
  by: string | null;
  at: string | null;
  /** The item's other tags, by name. */
  tags: string[];
}

export interface TagPageDTO {
  tag: OrgTagDTO;
  /** Newest first within each type; at most `TAG_PAGE_LIMIT` of each. */
  items: Record<TagItemType, TagPageItem[]>;
  /** Tags most often on the same items, most first. */
  seen_with: { name: string; count: number }[];
  /** Who wrote the tagged feed entries, most first. */
  authors: { handle: string; count: number }[];
}
export const TAG_PAGE_LIMIT = 50;

/** How an admin settles a suggestion. */
export const SUGGESTION_RESOLUTIONS = ["accept", "map", "dismiss"] as const;
export type SuggestionResolution = (typeof SUGGESTION_RESOLUTIONS)[number];

/** `org_admin_audit.action` for the tag list (src/tools/tags.ts). */
export type TagAuditAction = "tag.add" | "tag.rename" | "tag.edit" | "tag.merge" | "tag.retire" | "tag.restore"
  | "tag.suggestion.accept" | "tag.suggestion.map" | "tag.suggestion.dismiss"
  // The model's suggestions (src/tools/tag-fit.ts): the org's switch, and an admin settling them.
  | "ai.enable" | "ai.disable" | "tag.fit.accept" | "tag.fit.dismiss";

/** A live tag one edit away from `name`, or one that `name` extends ("authn" → "auth"). */
export function similarTag(name: string, live: readonly string[]): string | null {
  for (const t of live) if (t !== name && t.length >= 3 && (name.startsWith(t) || t.startsWith(name)) && Math.abs(t.length - name.length) <= 2) return t;
  for (const t of live) if (t !== name && Math.abs(t.length - name.length) <= 1 && editDistanceAtMostOne(name, t)) return t;
  return null;
}
function editDistanceAtMostOne(a: string, b: string): boolean {
  if (a.length < b.length) [a, b] = [b, a];
  let i = 0;
  while (i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.slice(i + 1) === b.slice(i);
}

/** A list row's tags as plain words: the first three, then how many more (option C). */
export const TAG_LINE_MAX = 3;
export function tagLineParts(tags: readonly string[]): { shown: string[]; more: number } {
  return { shown: tags.slice(0, TAG_LINE_MAX), more: Math.max(0, tags.length - TAG_LINE_MAX) };
}

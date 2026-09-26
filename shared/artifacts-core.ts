// The ZOD-FREE core of the artifacts contract (issue #52; spec:
// docs/superpowers/specs/2026-09-24-artifacts-implementation.md). Every track
// codes against THIS file: the vocabulary, the caps, the status rules and the wire
// DTOs. `shared/artifacts.ts` builds the zod request schemas on top and re-exports
// all of it. No imports — the SPA reads these as values (the *-core.ts rule).

// ── vocabulary (must match the CHECK constraints in 0030_artifacts.sql; the text
//    cap's CHECK was rebuilt by 0035_artifact_text_cap.sql) ──────────────────

export const ARTIFACT_TEXT_KINDS = ["html", "markdown", "svg", "mermaid"] as const;
export const ARTIFACT_BINARY_KINDS = ["image", "pdf", "file"] as const;
export const ARTIFACT_KINDS = [...ARTIFACT_TEXT_KINDS, ...ARTIFACT_BINARY_KINDS] as const;
export const ARTIFACT_STATUSES = ["draft", "published", "ratified"] as const;
export const ARTIFACT_VISIBILITIES = ["org", "private"] as const;
export const ARTIFACT_LINK_TYPES = ["ticket", "sprint", "pr", "issue"] as const;
/** The design's areas. */
export const ARTIFACT_AREAS = ["auth", "architecture", "infra", "api", "ui", "data"] as const;

export type ArtifactTextKind = (typeof ARTIFACT_TEXT_KINDS)[number];
export type ArtifactBinaryKind = (typeof ARTIFACT_BINARY_KINDS)[number];
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number];
export type ArtifactVisibility = (typeof ARTIFACT_VISIBILITIES)[number];
export type ArtifactLinkType = (typeof ARTIFACT_LINK_TYPES)[number];
export type ArtifactArea = (typeof ARTIFACT_AREAS)[number];

export const isTextKind = (k: string): k is ArtifactTextKind => (ARTIFACT_TEXT_KINDS as readonly string[]).includes(k);
export const isBinaryKind = (k: string): k is ArtifactBinaryKind => (ARTIFACT_BINARY_KINDS as readonly string[]).includes(k);

// ── caps ─────────────────────────────────────────────────────────────────────

/** Text kinds: UTF-8 bytes of the content, stored in D1 (750 KB; the CHECK in 0035_artifact_text_cap.sql matches). */
export const ARTIFACT_TEXT_CAP = 750 * 1024;
/**
 * Agent reads (`artifact_get`, `query`) inline a text version's content only up to this many
 * UTF-8 bytes; above it the content is omitted and the agent fetches `download_url` instead
 * (or passes `include_content: true` to artifact_get when it truly needs the whole text).
 */
export const ARTIFACT_INLINE_MAX = 64 * 1024;
/** Binary kinds: bytes of the file, stored in R2 under `artifacts/<sha256>`. */
export const ARTIFACT_BINARY_CAP = 10 * 1024 * 1024;
export const artifactCap = (k: ArtifactKind): number => (isTextKind(k) ? ARTIFACT_TEXT_CAP : ARTIFACT_BINARY_CAP);
/** Title → slug: lowercase, non-alphanumerics → "-", trimmed, at most 60 chars. */
export const ARTIFACT_SLUG_MAX = 60;
/** A slug the SPA router can tell apart from `#artifacts/new`. */
export const ARTIFACT_RESERVED_SLUGS = ["new"] as const;
/** Minutes a signed upload URL stays valid. */
export const ARTIFACT_UPLOAD_TTL_MS = 5 * 60 * 1000;
/** How long an agent's signed download URL (`artifact_get`'s `download_url`) stays valid. Reusable within it. */
export const ARTIFACT_DOWNLOAD_TTL_MS = 5 * 60 * 1000;

/** A version summary's length limit (the zod schema enforces it; the SPA's input caps at it). */
export const ARTIFACT_SUMMARY_MAX = 500;

/** Warn (never reject) when text content calls into features only claude.ai has. */
export const CLAUDE_ONLY_MARKERS = ["window.claude", "window.storage", "api.anthropic.com"] as const;
export const claudeOnlyHits = (text: string): string[] => CLAUDE_ONLY_MARKERS.filter((m) => text.includes(m));

/** Warn (never reject) on a Claude Design BUNDLED export (the hi-fi clickable ones): its loader unpacks
 *  its scripts into blob: URLs and its runtime compiles code with `new Function`, both refused by the
 *  raw route's CSP, so it renders blank until flattened (every script inline, no eval). */
export const BUNDLED_EXPORT_MARKER = 'type="__bundler/manifest"';
export const isBundledExport = (text: string): boolean => text.includes(BUNDLED_EXPORT_MARKER);

// ── file-type rules ──────────────────────────────────────────────────────────

/** Extension → kind, for the file tab and the MCP binary path. Unknown → "file". */
export const ARTIFACT_EXT_KIND: Record<string, ArtifactKind> = {
  html: "html", htm: "html", md: "markdown", markdown: "markdown", svg: "svg", mmd: "mermaid", mermaid: "mermaid",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", pdf: "pdf",
};
export const kindForFilename = (name: string): ArtifactKind => ARTIFACT_EXT_KIND[(name.split(".").pop() ?? "").toLowerCase()] ?? "file";
/** Image content types accepted for `image`. Anything else under `image` is refused. */
export const ARTIFACT_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
/** Content-Type served for each TEXT kind by the raw route (binary kinds serve their stored content_type). */
export const ARTIFACT_TEXT_CONTENT_TYPE: Record<ArtifactTextKind, string> = {
  html: "text/html; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  svg: "image/svg+xml",
  mermaid: "text/plain; charset=utf-8",
};
/** Extension used for `?download=1` filenames (`<slug>-v<n>.<ext>`). Binary kinds derive it from content_type. */
export const ARTIFACT_TEXT_EXT: Record<ArtifactTextKind, string> = { html: "html", markdown: "md", svg: "svg", mermaid: "mmd" };

// ── status rules (ONE definition; the repository layer enforces them) ────────
//
//   create                 → v1, status "draft"
//   draft ⇄ published      → PATCH, by anyone who can read the page
//   published → ratified   → POST …/ratify, SESSION ONLY, only the LATEST version
//   any new version        → status "published", ratified_* cleared
//   → draft                → ratified_* cleared
//   publishing a private page (visibility → org) also moves draft → published

export const canRatify = (status: ArtifactStatus, version: number, currentVersion: number): boolean =>
  status === "published" && version === currentVersion;

// ── wire DTOs (what /api/artifacts returns; handles are person handles) ──────

export interface ArtifactLinkDTO { target_type: ArtifactLinkType; target_ref: string; /** Resolved for display; null when the target is gone. */ label: string | null; meta: string | null }
export interface ArtifactVersionDTO {
  version_no: number;
  summary: string;
  created_by: string;
  created_at: string;
  size_bytes: number;
  content_type: string;
  sha256: string;
}
/** A library card. `excerpt` only for markdown / mermaid (first ~600 chars of the latest version). */
export interface ArtifactSummaryDTO {
  id: number;
  slug: string;
  title: string;
  kind: ArtifactKind;
  area: string;
  repo: string;
  author_id: string;
  status: ArtifactStatus;
  visibility: ArtifactVisibility;
  current_version: number;
  /** created_at of the latest version — the library's sort key. */
  updated_at: string;
  size_bytes: number;
  excerpt: string | null;
  /** The ticket ids and sprint ids linked, so the library can filter/search without N+1. */
  ticket_ids: number[];
  sprint_ids: number[];
}
export interface ArtifactDetailDTO extends ArtifactSummaryDTO {
  ratified_version: number | null;
  ratified_by: string | null;
  ratified_at: string | null;
  versions: ArtifactVersionDTO[];
  links: ArtifactLinkDTO[];
  /** The requested version (`?v=`), default the latest. */
  version: ArtifactVersionDTO;
  /** Text kinds: that version's content. Binary kinds: null (read it from `raw_url`). */
  content: string | null;
  /** `/raw/a/<slug>@v<n>` for the requested version. */
  raw_url: string;
}
export interface ArtifactDiffDTO {
  kind: ArtifactKind;
  a: ArtifactVersionDTO & { content: string | null; raw_url: string };
  b: ArtifactVersionDTO & { content: string | null; raw_url: string };
}
export interface ArtifactUploadTicketDTO { id: number; slug: string; upload_url: string; expires_at: string }
export interface ArtifactFetchDTO { url: string; content: string; content_type: string; size_bytes: number; kind: ArtifactTextKind | null }

/** `slug@v3`, `slug/v3` or `slug` → parts. Both version spellings are accepted everywhere. */
export function parseSlugVersion(s: string): { slug: string; version: number | null } | null {
  const m = /^([a-z0-9]+(?:-[a-z0-9]+)*)(?:(?:@|\/)v(\d+))?$/.exec(s);
  if (!m) return null;
  const v = m[2] ? Number(m[2]) : null;
  if (v !== null && (!Number.isInteger(v) || v < 1)) return null;
  return { slug: m[1], version: v };
}

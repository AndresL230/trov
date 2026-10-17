// The Docs Library import planner — ONCE (zod-free and pure: the SPA imports it as a value). The browser
// unzips (web/src/zip-reader.ts) and runs `planImport` for the Preview; the Worker RE-RUNS the same planner
// over the manifest it is sent (paths, sizes, kinds, titles), so the browser's plan is advisory and the two
// agree byte for byte. Everything here is deterministic: the same input gives the same plan, whatever order
// the files arrive in.
//
// Planner rules (the Docs Library brief, "Import"):
//   - Top-level folders become top-level pages of the target space (never new spaces); nested folders become
//     nested pages. A folder becomes a page only when it has Markdown somewhere below it.
//   - `name.md` beside `name/` merge into ONE page: the file is its body, the folder's files its children.
//     Failing that, a folder's own `README.md` / `index.md` is its body. Else the folder page has no body.
//   - A folder named `attachments` never becomes a page: it holds images. Images anywhere are collected.
//   - A page's title is its file's first `# ` heading (removed from the body — `prepareBody`), else the file or
//     folder name made readable ("01-first-week.md" → "First week").
//   - Slugs come from the PATH (so the Worker can re-derive them before it has the text), unique against the
//     org's existing slugs and within the plan (`-2`, `-3`, …).
//   - A title that matches an existing page of the target space is a conflict: skip, add as a new version of
//     that page, or rename (`applyConflictChoices`; the default is a new version).
//   - Files that won't be imported are listed with the design's reasons (`SKIP_REASONS`).

import { ARTIFACT_BINARY_CAP, ARTIFACT_IMAGE_TYPES } from "./artifacts-core";
import { DOC_IMAGE_PATH_RE, docImageRef, scanDocImages } from "./doc-images";
import { codeSegments, extractDocLinks } from "./docs-links-core";
import { MAX_DEPTH } from "./docs-tree-core";

// ── caps ─────────────────────────────────────────────────────────────────────

/** At most this many files in one import (a zip's entries, or the files picked). */
export const MAX_FILES = 500;
/** At most this many bytes, uncompressed, in one import ("Up to 500 files or 50 MB"). */
export const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
/** At most this many bytes in one Markdown file. */
export const MAX_MD_BYTES = 1024 * 1024;
/** An image is a doc image: the same cap and types as `upload_asset` (artifacts-core). */
export const MAX_IMAGE_BYTES = ARTIFACT_BINARY_CAP;
export const IMPORT_IMAGE_TYPES = ARTIFACT_IMAGE_TYPES;
export const IMAGE_EXT_TYPE: Readonly<Record<string, (typeof ARTIFACT_IMAGE_TYPES)[number]>> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
};
export const MARKDOWN_EXTS = ["md", "markdown"] as const;

/** The file input the wizard accepts. */
export const IMPORT_ACCEPT = ".md,.markdown,.zip";

export type ImportFileKind = "md" | "image" | "other";

const extOf = (path: string): string => {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
};

/** A file's kind from its name: Markdown, a doc image (png/jpeg/gif/webp), or anything else. */
export function importKind(path: string): ImportFileKind {
  const ext = extOf(path);
  if ((MARKDOWN_EXTS as readonly string[]).includes(ext)) return "md";
  if (ext in IMAGE_EXT_TYPE) return "image";
  return "other";
}

/** The content type an image path declares, or null. */
export const imageTypeFor = (path: string): string | null => IMAGE_EXT_TYPE[extOf(path)] ?? null;

// ── why a file is not imported ───────────────────────────────────────────────

export const SKIP_REASONS = {
  not_markdown: "Not a Markdown file",
  hidden: "Hidden system file",
  empty: "The file is empty",
  too_large: "Too large: a page can be up to 1 MB, an image up to 10 MB",
  bad_path: "The file's name or folder isn't allowed",
  too_deep: "Nested more than 10 levels deep",
  in_attachments: "In an attachments folder",
  duplicate: "Another file has the same name",
  not_utf8: "The file isn't readable text",
} as const;
export type SkipCode = keyof typeof SKIP_REASONS;

export interface SkippedFile {
  path: string;
  code: SkipCode;
  /** The design's phrasing (`SKIP_REASONS[code]`). */
  reason: string;
}

const skip = (path: string, code: SkipCode, reason: string = SKIP_REASONS[code]): SkippedFile => ({ path, code, reason });
/** An over-limit file's reason names ITS limit (owner ruling IW51). */
const TOO_LARGE_PAGE = "Larger than 1 MB, the most a page can be";
const TOO_LARGE_IMAGE = "Larger than 10 MB, the most an image can be";

// ── path safety ──────────────────────────────────────────────────────────────

const SYSTEM_FILES = new Set(["__macosx", "thumbs.db", "desktop.ini"]);

export type PathCheck = { ok: true; path: string } | { ok: false; code: "bad_path" | "hidden"; path: string };

/**
 * A zip entry's or a picked file's path, made safe: `\` → `/`, `.` and empty segments dropped, NFC. Refused
 * (`bad_path`): a NUL or control character, an absolute path (`/x`, `C:\x`), a `..` segment, nothing left, or
 * a segment over 255 characters. `hidden`: any segment starting with `.` (`.DS_Store`, `.git/`), `__MACOSX/`,
 * `Thumbs.db`, `desktop.ini`. `path` on a refusal is the input with its separators normalized, for the list.
 */
export function normalizeImportPath(raw: string): PathCheck {
  const shown = String(raw ?? "").replace(/\\/g, "/");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(shown)) return { ok: false, code: "bad_path", path: shown.replace(/[\u0000-\u001f\u007f]/g, "?") };
  if (shown.startsWith("/") || /^[a-zA-Z]:/.test(shown)) return { ok: false, code: "bad_path", path: shown };
  const segs = shown.normalize("NFC").split("/").filter((s) => s !== "" && s !== ".");
  if (segs.length === 0 || segs.some((s) => s === ".." || s.length > 255)) return { ok: false, code: "bad_path", path: shown };
  if (segs.some((s) => s.startsWith(".") || SYSTEM_FILES.has(s.toLowerCase()))) return { ok: false, code: "hidden", path: segs.join("/") };
  return { ok: true, path: segs.join("/") };
}

// ── names ────────────────────────────────────────────────────────────────────

/** Codepoint order (never localeCompare: the browser's and the Worker's ICU may differ). */
const cp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Natural order, case-insensitive ("2-x" before "10-x"), deterministic everywhere. */
export function naturalCompare(a: string, b: string): number {
  const ca = a.toLowerCase().match(/\d+|\D+/g) ?? [];
  const cb = b.toLowerCase().match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(ca.length, cb.length); i++) {
    const x = ca[i], y = cb[i];
    const dx = /^\d/.test(x), dy = /^\d/.test(y);
    if (dx && dy) {
      const nx = x.replace(/^0+/, ""), ny = y.replace(/^0+/, "");
      if (nx.length !== ny.length) return nx.length - ny.length;
      if (nx !== ny) return cp(nx, ny);
    } else if (x !== y) return cp(x, y);
  }
  if (ca.length !== cb.length) return ca.length - cb.length;
  return cp(a, b);
}

const stem = (name: string): string => {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
};
const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const dirName = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** A file or folder name made readable: "01-first-week" → "First week", "code_review" → "Code review". */
export function titleFromName(name: string): string {
  let s = stem(name);
  const stripped = s.replace(/^\d+[\s._-]+/, "");
  if (stripped.trim()) s = stripped;
  s = s.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return "Untitled";
  return s[0].toUpperCase() + s.slice(1);
}

/** A slug base from a name (letters, digits, dashes; at most 60 characters). */
export function slugFromName(name: string): string {
  const s = titleFromName(name)
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, 60).replace(/-+$/g, "");
  return s || "page";
}

/** The rename the design suggests: "Local setup (handbook)" for a page of handbook.zip. */
export function renameSuggestion(title: string, sourceName?: string | null): string {
  const src = stem(baseName(String(sourceName ?? "").replace(/\\/g, "/"))).trim();
  return src ? `${title} (${src})` : `${title} (imported)`;
}

const ATX_H1 = /^ {0,3}#[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const cleanTitle = (t: string): string =>
  t.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2").replace(/\[\[([^\]]*)\]\]/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*_~]/g, "").replace(/\s+/g, " ").trim();

/** Where the first `# ` heading is (outside fences and a leading front matter block), or null. */
function findH1(lines: string[]): { index: number; title: string } | null {
  let i = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, k) => k > 0 && (l.trim() === "---" || l.trim() === "..."));
    if (end > 0) i = end + 1;
  }
  let fence: string | null = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null; continue; }
    if (f) { fence = f[1]; continue; }
    const m = ATX_H1.exec(line);
    if (m) {
      const title = cleanTitle(m[1]);
      if (title) return { index: i, title };
    }
  }
  return null;
}

/** A Markdown file's title: its first `# ` heading, cleaned of inline marks — or null when it has none. */
export function titleFromMarkdown(text: string): string | null {
  return findH1(normalizeText(text).split("\n"))?.title ?? null;
}

const normalizeText = (text: string): string => String(text ?? "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");

// ── the plan ─────────────────────────────────────────────────────────────────

export interface ImportFile {
  path: string;
  size: number;
  kind: ImportFileKind;
  /** Markdown only, once its text is read: the first `# ` heading (`titleFromMarkdown`), or null for none.
   *  Left out, the title is the file name and the page is `titlePending`. */
  title?: string | null;
}

export interface PlanOptions {
  /** The target space's existing pages: lowercased trimmed title → slug. */
  existingTitles: ReadonlyMap<string, string>;
  /** Every slug the org has (any space, archived or not — a slug is never reused). */
  existingSlugs: ReadonlySet<string>;
  /** The page everything goes under (null / absent = the space's top level). */
  parentSlug?: string | null;
  /** That page's depth in its tree (0 = top level); the import's depth limit counts from it. */
  parentDepth?: number;
}

export interface PlannedPage {
  /** Stable id within the plan: the Markdown path, or the folder path + "/" for a folder page. */
  key: string;
  /** The Markdown file that is the page's body; null for a folder page with no file of its own. */
  path: string | null;
  /** The folder whose contents are its children; null for a plain file page. */
  folder: string | null;
  title: string;
  /** True while the title is the file name only because the file's text has not been read yet. */
  titlePending: boolean;
  slug: string;
  /** The parent page's key (null = the import's top level). */
  parent: string | null;
  /** Where it goes: the parent page's slug, or the import's `parentSlug` at the top. */
  parentSlug: string | null;
  children: string[];
  /** 0 = the import's top level. */
  depth: number;
}

export interface PlannedImage {
  path: string;
  size: number;
  type: string;
}

export interface ImportConflict {
  key: string;
  path: string | null;
  title: string;
  /** The existing page with that title. */
  existingSlug: string;
}

export type ImportPlanError = "too_many_files" | "too_large" | "no_markdown";

export interface ImportPlan {
  /** Why the whole import is refused, or null. The rest of the plan is still filled in for the preview. */
  error: ImportPlanError | null;
  /** Every page, depth-first in order. */
  pages: PlannedPage[];
  /** The top-level pages' keys, in order. */
  roots: string[];
  images: PlannedImage[];
  skipped: SkippedFile[];
  conflicts: ImportConflict[];
  /** Markdown path → slug and folder path → slug, for `prepareBody`'s link rewrite. */
  pathToSlug: Map<string, string>;
  totals: { files: number; bytes: number };
}

const ATTACHMENTS = "attachments";
const isIndexFile = (name: string): boolean => /^(readme|index)\.(md|markdown)$/i.test(name);

/**
 * Plan an import. `files` are the files only (a zip's directory entries left out), in any order.
 */
export function planImport(files: readonly ImportFile[], opts: PlanOptions): ImportPlan {
  const skipped: SkippedFile[] = [];
  const totals = { files: files.length, bytes: files.reduce((s, f) => s + Math.max(0, Number(f.size) || 0), 0) };
  let error: ImportPlanError | null = null;
  if (files.length > MAX_FILES) error = "too_many_files";
  else if (totals.bytes > MAX_TOTAL_BYTES) error = "too_large";

  // Normalize, in a fixed order, so the plan never depends on the order files arrive in.
  const sorted = [...files].sort((a, b) => cp(String(a.path), String(b.path)) || cp(a.kind, b.kind) || a.size - b.size);
  const accepted = new Map<string, ImportFile>();
  let macosx = false;
  for (const f of sorted) {
    const chk = normalizeImportPath(f.path);
    if (!chk.ok) {
      if (chk.code === "hidden" && /(^|\/)__macosx(\/|$)/i.test(chk.path)) {
        if (!macosx) { macosx = true; skipped.push(skip("__MACOSX/", "hidden")); }
        continue;
      }
      skipped.push(skip(chk.path, chk.code));
      continue;
    }
    if (accepted.has(chk.path)) { skipped.push(skip(chk.path, "duplicate")); continue; }
    accepted.set(chk.path, { ...f, path: chk.path });
  }

  const md: ImportFile[] = [];
  const images: PlannedImage[] = [];
  const inAttachments = (p: string) => dirName(p).split("/").some((s) => s.toLowerCase() === ATTACHMENTS);
  for (const f of accepted.values()) {
    const size = Math.max(0, Number(f.size) || 0);
    // The name decides as much as the caller's kind: a page is a `.md` file, an image a png/jpeg/gif/webp.
    const named = importKind(f.path);
    const kind: ImportFileKind = f.kind === named ? named : "other";
    if (kind === "md") {
      if (inAttachments(f.path)) skipped.push(skip(f.path, "in_attachments"));
      else if (size === 0) skipped.push(skip(f.path, "empty"));
      else if (size > MAX_MD_BYTES) skipped.push(skip(f.path, "too_large", TOO_LARGE_PAGE));
      else md.push(f);
    } else if (kind === "image") {
      const type = imageTypeFor(f.path) as string;
      if (size === 0) skipped.push(skip(f.path, "empty"));
      else if (size > MAX_IMAGE_BYTES) skipped.push(skip(f.path, "too_large", TOO_LARGE_IMAGE));
      else images.push({ path: f.path, size, type });
    } else {
      skipped.push(skip(f.path, "not_markdown"));
    }
  }

  // Folders with Markdown below them become pages.
  const folders = new Set<string>();
  for (const f of md) {
    let d = dirName(f.path);
    while (d) { folders.add(d); d = dirName(d); }
  }
  // A folder's body: `name.md` beside it, else its own README.md / index.md.
  const folderBody = new Map<string, string>();
  const sortedFolders = [...folders].sort(cp);
  for (const dir of sortedFolders) {
    const parent = dirName(dir);
    const name = baseName(dir);
    const sibling = md
      .filter((f) => dirName(f.path) === parent && stem(baseName(f.path)).toLowerCase() === name.toLowerCase())
      .map((f) => f.path).sort(cp)[0];
    if (sibling) { folderBody.set(dir, sibling); continue; }
    const readmeFirst = (p: string) => (baseName(p).toLowerCase().startsWith("readme") ? 0 : 1);
    const index = md.filter((f) => dirName(f.path) === dir && isIndexFile(baseName(f.path))).map((f) => f.path)
      .sort((a, b) => readmeFirst(a) - readmeFirst(b) || cp(a, b))[0];
    if (index) folderBody.set(dir, index);
  }
  const bodyOf = new Set(folderBody.values());
  const mdByPath = new Map(md.map((f) => [f.path, f]));

  interface Draft { key: string; path: string | null; folder: string | null; name: string; dir: string }
  const drafts: Draft[] = [];
  for (const dir of sortedFolders) drafts.push({ key: `${dir}/`, path: folderBody.get(dir) ?? null, folder: dir, name: baseName(dir), dir: dirName(dir) });
  for (const f of md) {
    if (bodyOf.has(f.path)) continue;
    drafts.push({ key: f.path, path: f.path, folder: null, name: stem(baseName(f.path)), dir: dirName(f.path) });
  }
  const byDir = new Map<string, Draft[]>();
  for (const d of drafts) (byDir.get(d.dir) ?? byDir.set(d.dir, []).get(d.dir)!).push(d);
  for (const list of byDir.values()) list.sort((a, b) => naturalCompare(a.name, b.name) || cp(a.key, b.key));

  // Walk depth-first: depth limit, titles, slugs, conflicts.
  const baseDepth = opts.parentSlug ? Math.max(0, opts.parentDepth ?? 0) + 1 : 0;
  const used = new Set<string>();
  const uniqueSlug = (base: string): string => {
    let s = base, n = 2;
    while (opts.existingSlugs.has(s) || used.has(s)) s = `${base}-${n++}`;
    used.add(s);
    return s;
  };
  const pages: PlannedPage[] = [];
  const conflicts: ImportConflict[] = [];
  const pathToSlug = new Map<string, string>();
  const roots: string[] = [];
  const tooDeep = (d: Draft) => {
    if (d.path) skipped.push(skip(d.path, "too_deep"));
    if (d.folder) for (const k of byDir.get(d.folder) ?? []) tooDeep(k);
  };
  const walk = (dir: string, parent: PlannedPage | null, depth: number) => {
    for (const d of byDir.get(dir) ?? []) {
      if (baseDepth + depth > MAX_DEPTH - 1) { tooDeep(d); continue; }
      const file = d.path ? mdByPath.get(d.path) : undefined;
      const read = file && file.title !== undefined;
      const heading = read && typeof file!.title === "string" ? cleanTitle(file!.title) : "";
      const page: PlannedPage = {
        key: d.key, path: d.path, folder: d.folder,
        title: heading || titleFromName(d.name),
        titlePending: Boolean(file) && !read,
        slug: uniqueSlug(slugFromName(d.name)),
        parent: parent?.key ?? null,
        parentSlug: parent ? parent.slug : opts.parentSlug ?? null,
        children: [], depth,
      };
      pages.push(page);
      if (parent) parent.children.push(page.key); else roots.push(page.key);
      if (d.path) pathToSlug.set(d.path, page.slug);
      if (d.folder) pathToSlug.set(d.folder, page.slug);
      const existing = opts.existingTitles.get(page.title.trim().toLowerCase());
      if (existing !== undefined) conflicts.push({ key: page.key, path: page.path, title: page.title, existingSlug: existing });
      if (d.folder) walk(d.folder, page, depth + 1);
    }
  };
  walk("", null, 0);

  if (!error && pages.length === 0) error = "no_markdown";
  skipped.sort((a, b) => cp(a.path, b.path) || cp(a.code, b.code));
  images.sort((a, b) => cp(a.path, b.path));
  return { error, pages, roots, images, skipped, conflicts, pathToSlug, totals };
}

// ── conflicts ────────────────────────────────────────────────────────────────

export type ConflictChoice = "skip" | "version" | "rename";
export const DEFAULT_CONFLICT_CHOICE: ConflictChoice = "version";

export type ConflictResolution = { choice: "skip" } | { choice: "version" } | { choice: "rename"; title?: string };

/** What the import writes for each page, in the plan's depth-first order. */
export type ImportWrite =
  /** A new page (a renamed conflict is one too). */
  | { key: string; path: string | null; mode: "new"; slug: string; title: string; parent_slug: string | null }
  /** A new version staged on the existing page; the existing page stays where it is. */
  | { key: string; path: string; mode: "version"; slug: string; title: string }
  /** Nothing written; the page's children go under the existing page. A folder page with no file of its own
   *  that is "added as a new version" is this too — there is no body to add. */
  | { key: string; path: string | null; mode: "skip"; slug: string };

/**
 * Turn the plan and the person's conflict choices (by page key; a conflict with no choice is a new version)
 * into the writes. A skipped or versioned page's children go under the EXISTING page; a renamed one is a
 * new page with its own slug. Pure and deterministic, so the Worker can re-run it.
 */
export function applyConflictChoices(
  plan: Pick<ImportPlan, "pages" | "conflicts">,
  choices: Readonly<Record<string, ConflictResolution | ConflictChoice | undefined>>,
  sourceName?: string | null,
): ImportWrite[] {
  const conflictOf = new Map(plan.conflicts.map((c) => [c.key, c]));
  const slugOf = new Map<string, string>();   // page key → the slug its children go under
  const out: ImportWrite[] = [];
  for (const p of plan.pages) {
    const parent_slug = p.parent === null ? p.parentSlug : slugOf.get(p.parent) ?? p.parentSlug;
    const c = conflictOf.get(p.key);
    if (!c) {
      out.push({ key: p.key, path: p.path, mode: "new", slug: p.slug, title: p.title, parent_slug });
      slugOf.set(p.key, p.slug);
      continue;
    }
    const raw = choices[p.key];
    const r: ConflictResolution = typeof raw === "string" ? (raw === "rename" ? { choice: "rename" } : { choice: raw }) : raw ?? { choice: DEFAULT_CONFLICT_CHOICE };
    if (r.choice === "rename") {
      const title = (r.title ?? "").trim() || renameSuggestion(p.title, sourceName);
      out.push({ key: p.key, path: p.path, mode: "new", slug: p.slug, title, parent_slug });
      slugOf.set(p.key, p.slug);
    } else if (r.choice === "version" && p.path !== null) {
      out.push({ key: p.key, path: p.path, mode: "version", slug: c.existingSlug, title: p.title });
      slugOf.set(p.key, c.existingSlug);
    } else {
      out.push({ key: p.key, path: p.path, mode: "skip", slug: c.existingSlug });
      slugOf.set(p.key, c.existingSlug);
    }
  }
  return out;
}

/** "For all": the one choice every conflict has, or null when they differ (or there are none). */
export function commonChoice(
  plan: Pick<ImportPlan, "conflicts">, choices: Readonly<Record<string, ConflictResolution | ConflictChoice | undefined>>,
): ConflictChoice | null {
  let common: ConflictChoice | null = null;
  for (const c of plan.conflicts) {
    const raw = choices[c.key];
    const ch: ConflictChoice = typeof raw === "string" ? raw : raw?.choice ?? DEFAULT_CONFLICT_CHOICE;
    if (common === null) common = ch;
    else if (common !== ch) return null;
  }
  return common;
}

// ── a page's body ────────────────────────────────────────────────────────────

export interface BodyContext {
  /** The Markdown file's normalized path in the import. */
  path: string;
  /** `ImportPlan.pathToSlug` (plus anything else a link may point to). */
  pathToSlug: ReadonlyMap<string, string>;
  /** Image path → its sha256 once uploaded. */
  imagePathToSha: ReadonlyMap<string, string>;
}

export interface PreparedBody {
  /** The first `# ` heading (removed from the body), or null when there is none. */
  title: string | null;
  body: string;
  /** Distinct `[[slug]]` targets in the final body, in order. */
  links: string[];
  /** Distinct `/img/<sha>` images in the final body, in order. */
  images: string[];
  /** Relative link targets that matched no page or image of the import (left as plain text). */
  unmatchedLinks: string[];
  /** Image sources that could not be brought in (dropped to their alt text, or turned into a plain link
   *  when they are on the web) — Trov only shows uploaded images. */
  unmatchedImages: string[];
  /** No heading and nothing else but whitespace: "The file is empty". */
  empty: boolean;
}

type Resolved = { kind: "external"; url: string } | { kind: "anchor" } | { kind: "trov" } | { kind: "local"; path: string } | { kind: "outside" };

/** Resolve a link or image target against the file it is in. */
export function resolveImportTarget(target: string, fromPath: string): Resolved {
  let t = target.trim();
  if (t.startsWith("<") && t.endsWith(">")) t = t.slice(1, -1).trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith("//")) return { kind: "external", url: t };
  if (t.startsWith("#") || t === "") return { kind: "anchor" };
  if (DOC_IMAGE_PATH_RE.test(t)) return { kind: "trov" };
  t = t.replace(/[?#].*$/, "");
  try { t = decodeURIComponent(t); } catch { /* keep it as written */ }
  const from = t.startsWith("/") ? [] : dirName(fromPath).split("/").filter(Boolean);
  const segs = [...from];
  for (const s of t.replace(/\\/g, "/").split("/")) {
    if (s === "" || s === ".") continue;
    if (s === "..") { if (!segs.length) return { kind: "outside" }; segs.pop(); continue; }
    segs.push(s);
  }
  if (!segs.length) return { kind: "outside" };
  return { kind: "local", path: segs.join("/").normalize("NFC") };
}

const pageFor = (path: string, map: ReadonlyMap<string, string>): string | undefined =>
  map.get(path) ?? map.get(`${path}.md`) ?? map.get(`${path}.markdown`);

// A link/image target: `<…>` or a run without spaces (balanced parentheses allowed), then an optional title.
const TARGET = String.raw`(<[^<>\n]*>|(?:[^\s()<>]|\([^\s()]*\))*)(\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?`;
const LABEL = String.raw`((?:[^\[\]\\\n]|\\.|\[[^\[\]\n]*\])*)`;
const INLINE_IMAGE = new RegExp(String.raw`!\[${LABEL}\]\(\s*${TARGET}\s*\)`, "g");
const INLINE_LINK = new RegExp(String.raw`(?<![!\\])\[${LABEL}\]\(\s*${TARGET}\s*\)`, "g");
const REF_IMAGE = /!\[((?:[^\[\]\\\n]|\\.)*)\]\[([^\[\]\n]*)\]/g;
const REF_LINK = /(?<![!\]\\])\[((?:[^\[\]\\\n]|\\.)*)\]\[([^\[\]\n]*)\]/g;
const REF_DEF = /^( {0,3}\[([^\]\n]+)\]:[ \t]*)(<[^<>\n]*>|\S+)(.*)$/gm;
const IMG_TAG = /<img\b[^>]*>/gi;

const plain = (label: string): string => label.replace(/\\([\[\]\\])/g, "$1").replace(/\s+/g, " ").trim();
const wiki = (slug: string, label: string): string => {
  const l = plain(label);
  return !l || l === slug || /[\[\]]/.test(l) ? `[[${slug}]]` : `[[${slug}|${l}]]`;
};

/**
 * A Markdown file's text made into a page body: the first `# ` heading taken out as the title; relative
 * links to the import's pages rewritten to `[[slug]]` (`./`, `../`, URL-encoding resolved, `#anchors`
 * dropped); relative images rewritten to `/img/<sha256>`; links to anything else in the zip or outside it
 * left as plain text; web links kept. Code is never touched. Pure: the same text and context give the same body.
 */
export function prepareBody(text: string, ctx: BodyContext): PreparedBody {
  const lines = normalizeText(text).split("\n");
  const h1 = findH1(lines);
  if (h1) {
    lines.splice(h1.index, lines[h1.index + 1]?.trim() === "" ? 2 : 1);
  }
  const src = lines.join("\n");
  const unmatchedLinks: string[] = [];
  const unmatchedImages: string[] = [];
  const noteLink = (t: string) => { if (!unmatchedLinks.includes(t)) unmatchedLinks.push(t); };
  const noteImage = (t: string) => { if (!unmatchedImages.includes(t)) unmatchedImages.push(t); };
  const segs = codeSegments(src);

  // Reference definitions, over all prose: id → resolved target.
  const defs = new Map<string, { raw: string; r: Resolved }>();
  for (const seg of segs) {
    if (seg.code) continue;
    for (const m of seg.text.matchAll(REF_DEF)) {
      const id = m[2].trim().toLowerCase();
      if (!defs.has(id)) defs.set(id, { raw: m[3], r: resolveImportTarget(m[3], ctx.path) });
    }
  }
  const imageSha = (r: Resolved): string | undefined => (r.kind === "local" ? ctx.imagePathToSha.get(r.path) : undefined);

  const rewrite = (t: string): string => {
    // 1. inline images
    t = t.replace(INLINE_IMAGE, (all, alt: string, target: string, title: string | undefined) => {
      const r = resolveImportTarget(target, ctx.path);
      if (r.kind === "trov") return all;
      const sha = imageSha(r);
      if (sha) return `![${alt}](${docImageRef(sha)}${title ?? ""})`;
      noteImage(target.replace(/^<|>$/g, ""));
      if (r.kind === "external" && /^https?:/i.test(r.url)) return `[${plain(alt) || r.url}](${target})`;
      return plain(alt);
    });
    // 2. raw <img> tags
    t = t.replace(IMG_TAG, (tag) => {
      const m = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
      if (!m) return tag;
      const target = m[1] ?? m[2] ?? m[3] ?? "";
      const r = resolveImportTarget(target, ctx.path);
      if (r.kind === "trov") return tag;
      const sha = imageSha(r);
      if (sha) return tag.replace(m[0], ` src="${docImageRef(sha)}"`);
      noteImage(target);
      const alt = /\salt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
      return plain(alt?.[1] ?? alt?.[2] ?? "");
    });
    // 3. reference images
    t = t.replace(REF_IMAGE, (all, alt: string, id: string) => {
      const d = defs.get((id.trim() || alt.trim()).toLowerCase());
      if (!d) return all;
      if (d.r.kind === "trov" || imageSha(d.r)) return all;   // the definition is rewritten below
      noteImage(d.raw.replace(/^<|>$/g, ""));
      return plain(alt);
    });
    // 4. inline links
    t = t.replace(INLINE_LINK, (all, label: string, target: string, title: string | undefined) => {
      const r = resolveImportTarget(target, ctx.path);
      if (r.kind === "external" || r.kind === "anchor" || r.kind === "trov") return all;
      if (r.kind === "local") {
        const slug = pageFor(r.path, ctx.pathToSlug);
        if (slug) return wiki(slug, label);
        const sha = ctx.imagePathToSha.get(r.path);
        if (sha) return `[${label}](${docImageRef(sha)}${title ?? ""})`;
      }
      noteLink(target.replace(/^<|>$/g, ""));
      return plain(label);
    });
    // 5. reference links
    t = t.replace(REF_LINK, (all, label: string, id: string) => {
      const d = defs.get((id.trim() || label.trim()).toLowerCase());
      if (!d || d.r.kind === "external" || d.r.kind === "anchor" || d.r.kind === "trov") return all;
      if (d.r.kind === "local") {
        const slug = pageFor(d.r.path, ctx.pathToSlug);
        if (slug) return wiki(slug, label);
        if (ctx.imagePathToSha.has(d.r.path)) return all;
      }
      noteLink(d.raw.replace(/^<|>$/g, ""));
      return plain(label);
    });
    // 6. definitions pointing at an uploaded image
    t = t.replace(REF_DEF, (all, head: string, _id: string, target: string, rest: string) => {
      const sha = imageSha(resolveImportTarget(target, ctx.path));
      return sha ? `${head}${docImageRef(sha)}${rest}` : all;
    });
    return t;
  };

  const body = segs.map((s) => (s.code ? s.text : rewrite(s.text))).join("");
  return {
    title: h1?.title ?? null,
    body,
    links: extractDocLinks(body),
    images: scanDocImages(body).shas,
    unmatchedLinks,
    unmatchedImages,
    empty: !h1 && body.trim() === "",
  };
}

/**
 * The import's image paths a Markdown file uses (inline, reference-style and `<img>`, and links to an
 * image), in order — so the wizard uploads only the images some page shows, before it prepares the bodies.
 */
export function imagePathsUsed(text: string, path: string, imagePaths: Iterable<string>): string[] {
  const seen: string[] = [];
  class Probe extends Map<string, string> {
    override get(k: string): string | undefined {
      const v = super.get(k);
      if (v !== undefined && !seen.includes(k)) seen.push(k);
      return v;
    }
  }
  const probe = new Probe([...imagePaths].map((p) => [p, "0".repeat(64)] as [string, string]));
  prepareBody(text, { path, pathToSlug: new Map(), imagePathToSha: probe });
  return seen;
}

/** The Preview's summary strip: pages to add (a skipped conflict drops one), conflicts, skipped files, images. */
export function planSummary(
  plan: ImportPlan, choices: Readonly<Record<string, ConflictResolution | ConflictChoice | undefined>> = {},
): { pages: number; newPages: number; versions: number; conflicts: number; skipped: number; images: number } {
  const writes = applyConflictChoices(plan, choices);
  const newPages = writes.filter((w) => w.mode === "new").length;
  const versions = writes.filter((w) => w.mode === "version").length;
  return { pages: newPages + versions, newPages, versions, conflicts: plan.conflicts.length, skipped: plan.skipped.length, images: plan.images.length };
}

// ── the run, on the wire (src/imports/, docs/architecture/docs-library.md › Import) ──────────────────

/** A running import that has reported nothing for this long did not finish (the tab was closed): it stops
 *  holding the org's lock and reads as `abandoned`. The same window as a Sync GitHub run (shared/sync.ts). */
export const IMPORT_STALE_MS = 180_000;
/** The most pages one `POST /imports/:id/pages` takes. */
export const IMPORT_PAGES_PER_BATCH = 25;
/** The most pages one `POST /imports/:id/approve-all` promotes (the client repeats while `remaining` > 0). */
export const IMPORT_APPROVE_PER_CALL = 25;
/** The most pages one `POST /imports/:id/reject-all` rejects. */
export const IMPORT_REJECT_PER_CALL = 100;
/** The longest file name a run keeps. */
export const IMPORT_FILE_NAME_MAX = 255;

/** `running` · `done` (everything planned is in Review) · `partial` (done, but files were skipped or pages
 *  failed) · `failed` (nothing reached Review) · `abandoned` (never reported an end, or cancelled). */
export type ImportRunStatus = "running" | "done" | "partial" | "failed" | "abandoned";

/** One file of the manifest `POST /imports` is sent: its path in the zip (or its name), its size in bytes, and —
 *  for a Markdown file — its first `# ` heading (`titleFromMarkdown`; null for none). */
export interface ImportManifestFile { path: string; size: number; title?: string | null }

export interface ImportStartBody {
  /** A live space of the org (a slug). */
  space: string;
  /** A page of that space everything goes under; null / absent = its top level. */
  parent_slug?: string | null;
  /** What the person picked: the .zip, the one .md, or "‹N› files". */
  file_name: string;
  /** The picked file's size (a zip's compressed size); absent for several files. */
  file_size?: number | null;
  files: ImportManifestFile[];
  /** Conflict choices by page key (absent = a new version). They are fixed for the run: a skipped or versioned
   *  page's children go under the existing page, so every batch must agree on them. */
  choices?: Record<string, ConflictResolution | ConflictChoice>;
}

/** Why a page that was sent did not reach Review (fixed codes, never text). */
export const IMPORT_PAGE_FAILURES = {
  too_large: "Too large: a page can be up to 1 MB, an image up to 10 MB",
  not_utf8: "The file isn't readable text",
  empty: "The file is empty",
  changed: "The file changed after it was checked",
  slug_taken: "Another page took its place while it was imported",
  refused: "An image in it couldn't be added",
  triaged: "It went to Unplaced instead",
  failed: "It couldn't be added",
  /** Not an error: the page already says exactly this, so nothing new went to Review. */
  unchanged: "It's the same as the page already in Trov",
  /** Path null: the person stopped the run (Cancel import). */
  cancelled: "The import was cancelled",
} as const;
export type ImportPageCode = keyof typeof IMPORT_PAGE_FAILURES;

/** A file that is not in Review: skipped by the plan (`SkipCode`) or failed when it was sent (`ImportPageCode`). */
export interface ImportFailure { path: string | null; code: SkipCode | ImportPageCode }

/** The sentence for a failure's code. */
export function importFailureText(code: string): string {
  return (SKIP_REASONS as Record<string, string>)[code] ?? (IMPORT_PAGE_FAILURES as Record<string, string>)[code] ?? IMPORT_PAGE_FAILURES.failed;
}

export interface ImportCounts {
  /** What the plan writes: pages (new + versions), and of them new pages and new versions. */
  pages: number;
  new_pages: number;
  versions: number;
  /** Images found in the files. */
  images: number;
  /** Files the plan does not import, and conflicts the person chose to skip. */
  skipped_files: number;
  skipped_pages: number;
  /** What reached Review so far (read back from doc_versions, never counted twice on a retry). */
  staged: number;
  staged_new: number;
  staged_versions: number;
  /** Sent pages identical to what the page already says (nothing staged). */
  unchanged: number;
  /** Sent pages that failed (`failures`). */
  failed: number;
  images_uploaded: number;
}

export const zeroImportCounts = (): ImportCounts => ({
  pages: 0, new_pages: 0, versions: 0, images: 0, skipped_files: 0, skipped_pages: 0,
  staged: 0, staged_new: 0, staged_versions: 0, unchanged: 0, failed: 0, images_uploaded: 0,
});

export interface ImportRunView {
  id: number;
  status: ImportRunStatus;
  /** The space's slug and name (null name: the space is gone). */
  space: string;
  space_name: string | null;
  parent_slug: string | null;
  /** The parent's title and the titles above it, top first ("Runbooks" for Engineering › Runbooks). */
  parent_path: string[];
  file_name: string;
  file_size: number | null;
  /** Files in the manifest. */
  file_count: number;
  /** Who started it (a handle). */
  by: string;
  started_at: string;
  updated_at: string;
  ended_at: string | null;
  /** True when the person stopped it (Cancel import). */
  cancelled: boolean;
  counts: ImportCounts;
  failures: ImportFailure[];
  /** Pages of it still waiting in Review. */
  waiting: number;
}

/** The server's plan, as `POST /imports` answers it: what each page will be, what is skipped. */
export interface ImportPlanView {
  writes: ImportWrite[];
  skipped: SkippedFile[];
  conflicts: ImportConflict[];
  images: PlannedImage[];
}

export interface ImportStartAnswer { ok: true; run: ImportRunView; plan: ImportPlanView }

export interface ImportPagesBody { pages: { path: string; text: string }[] }
export type ImportPageOutcome = "staged" | "unchanged" | "skipped" | "failed";
export interface ImportPageResult { path: string; outcome: ImportPageOutcome; code?: ImportPageCode; slug?: string; version?: number }
export interface ImportPagesAnswer { ok: true; run: ImportRunView; results: ImportPageResult[] }
export interface ImportImageAnswer { ok: true; path: string; sha: string }
export interface ImportFinishBody { cancel?: boolean }
export interface ImportFinishAnswer { ok: true; run: ImportRunView }
/** `GET /imports`: newest first, and how many are in progress (the sidebar's badge; one at most). */
export interface ImportsDTO { imports: ImportRunView[]; running: number }
export interface ImportReviewAnswer { ok: true; done: number; remaining: number; space: string; space_name: string | null }

export type ImportErrorCode =
  | "invalid" | "too_many_files" | "too_large" | "no_markdown" | "not_found" | "archived" | "import_running"
  | "not_running" | "forbidden" | "not_in_manifest" | "not_markdown" | "bad_path" | "not_an_image" | "too_many_pages";

/** "2.4 MB" above 1 MB, else "N KB" (at least 1). */
export function fileSizeWords(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

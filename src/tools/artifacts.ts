// The artifacts repository (issue #52 · Track A; spec:
// docs/superpowers/specs/2026-09-24-artifacts-implementation.md). EVERY artifact read
// and write goes through here — the HTTP routes (Track B) and the MCP tools (Track C)
// are thin adapters that map `ArtifactError.code` onto a status.
//
// Authority: artifacts are authored writes in the promote class (like tickets) — no
// ingestion gate, nothing staged. The rules, all enforced HERE:
//
//   • VISIBILITY. A page is visible to a viewer when it is `org`, or the viewer is its
//     author. A page with `current_version = 0` (a binary page whose upload has not
//     landed) is visible to NOBODY. Missing slug, private-to-someone-else and
//     version-0 all throw the IDENTICAL `ArtifactError("not_found", NOT_FOUND)` — the
//     check is never an existence oracle. Whoever can read a page can write it (add a
//     version, draft ⇄ published, title/area/repo, links); only the AUTHOR may make it
//     private.
//   • STATUS. v1 stays `draft`; every later version → `published` with ratified_*
//     cleared; → draft/published from `ratified` clears ratified_*; ratify only a
//     `published` page's CURRENT version (`canRatify`); private → org also moves
//     draft → published.
//   • NO-OP. A version whose sha256 equals the CURRENT version's writes nothing and
//     returns `{ unchanged: true }`.
//   • ATOMICITY. Page / version / FTS / link writes for one operation go in ONE
//     `batch`; a UNIQUE collision (a racing writer) is `conflict`.
//   • FTS is kept in sync here, not by triggers: html/svg are tag-stripped, markdown /
//     mermaid indexed raw, binary kinds index no body. description = latest summary.
//   • DELETE is soft (0035 PART D): `deleted_at` / `deleted_by` mark the page; its
//     versions, links and R2 bytes all stay. `VISIBLE_SQL` carries `deleted_at IS NULL`,
//     so a deleted page is the SAME one not_found on every read and write (the upload
//     consume and the download re-check included). Its slug stays reserved —
//     `uniqueSlug` counts every row — and `restorePage` is the one way back. Only the
//     author or an admin (`deletePage` / `restorePage`), over the session cookie; there
//     is no MCP delete. A delete drops the page's FTS row; a restore re-inserts it.

import { all, batch, first, fanOut, nowIso, run, stmt, type Stmt, type TenantContext } from "../data/sql";
import {
  ARTIFACT_AREAS, ARTIFACT_BINARY_CAP, ARTIFACT_IMAGE_TYPES, ARTIFACT_KINDS, ARTIFACT_LINK_TYPES,
  ARTIFACT_RESERVED_SLUGS, ARTIFACT_SLUG_MAX, ARTIFACT_TEXT_CAP, ARTIFACT_TEXT_CONTENT_TYPE,
  ARTIFACT_UPLOAD_TTL_MS, ARTIFACT_VISIBILITIES, ARTIFACT_FILENAME_MAX, ARTIFACT_REPO_RE,
  ARTIFACT_SUMMARY_MAX, ARTIFACT_TITLE_MAX, SHA256_HEX_RE,
  canRatify, isBinaryKind, isTextKind, parseSlugVersion,
  type AddTextVersionInput, type ArtifactBinaryKind, type ArtifactDetailDTO, type ArtifactDiffDTO,
  type ArtifactKind, type ArtifactLinkDTO, type ArtifactLinkInput, type ArtifactLinkType,
  type ArtifactListFilters, type ArtifactPageFields, type ArtifactStatus, type ArtifactSummaryDTO,
  type ArtifactTextKind, type ArtifactUploadTicketDTO, type ArtifactVersionDTO, type ArtifactVisibility,
  type CreateTextArtifactInput, type PatchArtifactInput, type UploadTicketInput,
} from "@shared/artifacts";
import type { ArtifactLinkRow, ArtifactPageRow, ArtifactUploadTokenRow, ArtifactVersionRow } from "@shared/rows";

// ── errors ───────────────────────────────────────────────────────────────────

export type ArtifactErrorCode = "not_found" | "forbidden" | "bad_request" | "conflict" | "too_large" | "gone";

/** A typed failure the adapters map onto a status via `ARTIFACT_ERROR_STATUS`. */
export class ArtifactError extends Error {
  constructor(readonly code: ArtifactErrorCode, message: string) {
    super(message);
    this.name = "ArtifactError";
  }
}

export const ARTIFACT_ERROR_STATUS = {
  not_found: 404, forbidden: 403, bad_request: 400, conflict: 409, too_large: 413, gone: 410,
} as const satisfies Record<ArtifactErrorCode, number>;

/** The ONE not-found message: missing, private-to-someone-else and version-0 are indistinguishable. */
export const ARTIFACT_NOT_FOUND = "not_found";
const notFound = (): ArtifactError => new ArtifactError("not_found", ARTIFACT_NOT_FOUND);
const bad = (m: string): ArtifactError => new ArtifactError("bad_request", m);

const isUniqueViolation = (e: unknown): boolean =>
  /UNIQUE constraint failed/i.test(e instanceof Error ? e.message : String(e));

// ── small pure helpers ───────────────────────────────────────────────────────

const enc = new TextEncoder();
const utf8Bytes = (s: string): number => enc.encode(s).byteLength;

const toHex = (buf: ArrayBuffer): string =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** SHA-256 hex of a string (UTF-8) or bytes. */
export async function sha256Hex(data: string | ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  return toHex(await crypto.subtle.digest("SHA-256", bytes));
}

const r2KeyFor = (sha: string): string => `artifacts/${sha}`;
const rawUrl = (slug: string, v: number): string => `/raw/a/${slug}@v${v}`;

/**
 * Title → slug: lowercase, diacritics folded, every run of non-alphanumerics → "-",
 * trimmed of dashes, at most `ARTIFACT_SLUG_MAX` characters. An empty result is
 * `"artifact"`.
 */
export function slugify(title: string): string {
  const s = title
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, ARTIFACT_SLUG_MAX)
    .replace(/-+$/g, "");
  return s || "artifact";
}

/**
 * A slug no page of the org holds (pending version-0 AND soft-deleted pages included — a deleted
 * page's slug stays reserved for its restore) and that is not reserved (`new`). Collisions take `-2`, `-3`, … with the base cut so `base-N` fits 60.
 */
export async function uniqueSlug(ctx: TenantContext, base: string): Promise<string> {
  const root = slugify(base);
  const taken = async (s: string): Promise<boolean> =>
    (ARTIFACT_RESERVED_SLUGS as readonly string[]).includes(s) ||
    !!(await first(ctx, `SELECT 1 AS x FROM artifact_pages WHERE slug = ? AND org_id = ?`, s, ctx.orgId));
  if (!(await taken(root))) return root;
  for (let n = 2; n < 10_000; n++) {
    const suffix = `-${n}`;
    const cut = root.slice(0, ARTIFACT_SLUG_MAX - suffix.length).replace(/-+$/g, "") || "artifact";
    const cand = `${cut}${suffix}`;
    if (!(await taken(cand))) return cand;
  }
  throw new ArtifactError("conflict", "no free slug");
}

/** Visible text for the FTS body: html/svg tag-stripped, markdown/mermaid raw, binary nothing. */
export function ftsBody(kind: ArtifactKind, content: string | null): string {
  if (content === null || !isTextKind(kind)) return "";
  if (kind === "markdown" || kind === "mermaid") return content;
  return content
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"").replace(/&#39;|&apos;/gi, "'").replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// Types a browser would RENDER actively (script-bearing) — a `file` claiming one is
// stored as application/octet-stream, so it can only ever be downloaded.
const ACTIVE_TYPES = new Set([
  "text/html", "application/xhtml+xml", "image/svg+xml", "text/xml", "application/xml",
  "text/javascript", "application/javascript", "application/ecmascript", "text/ecmascript",
  "application/x-javascript", "text/xsl", "text/vtt", "multipart/x-mixed-replace",
]);
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;
const IMAGE_EXT_TYPE: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/**
 * The content_type stored for a binary version. image → one of ARTIFACT_IMAGE_TYPES
 * (inferred from the filename's extension when absent; anything else is refused);
 * pdf → application/pdf, always; file → the declared type when it is a sane,
 * non-active mime, else application/octet-stream.
 */
export function binaryContentType(kind: ArtifactBinaryKind, declared: string | null | undefined, filename: string | null): string {
  const base = (declared ?? "").split(";")[0].trim().toLowerCase();
  if (kind === "pdf") return "application/pdf";
  if (kind === "image") {
    const ext = (filename?.split(".").pop() ?? "").toLowerCase();
    const ct = base || IMAGE_EXT_TYPE[ext] || "";
    if (!(ARTIFACT_IMAGE_TYPES as readonly string[]).includes(ct)) {
      throw bad(`image content_type must be one of ${ARTIFACT_IMAGE_TYPES.join(", ")}`);
    }
    return ct;
  }
  return MIME_RE.test(base) && !ACTIVE_TYPES.has(base) ? base : "application/octet-stream";
}

/** A filename kept for display/download: last path segment, no control chars, ≤ 255. */
export function cleanFilename(name: string | null | undefined): string | null {
  if (!name) return null;
  // eslint-disable-next-line no-control-regex
  const s = (name.split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f\u007f"]/g, "").trim().slice(0, ARTIFACT_FILENAME_MAX);
  return s || null;
}

// Own copy of reads.ts's MATCH builder (Track C owns reads.ts): keep only word
// characters, quote each token as a phrase, OR them. Never feeds FTS5 its syntax.
function buildMatch(q: string): string | null {
  const cleaned = q.replace(/[^\p{L}\p{N}_]+/gu, " ").trim();
  if (!cleaned) return null;
  return cleaned.split(/\s+/).map((t) => `"${t}"`).join(" OR ");
}

// ── validation of page fields ────────────────────────────────────────────────

function checkTitle(t: unknown): string {
  const s = typeof t === "string" ? t.trim() : "";
  if (!s) throw bad("title is required");
  if (s.length > ARTIFACT_TITLE_MAX) throw bad(`title is longer than ${ARTIFACT_TITLE_MAX} characters`);
  return s;
}
function checkArea(a: unknown): string {
  if (typeof a !== "string" || !(ARTIFACT_AREAS as readonly string[]).includes(a)) throw bad(`area must be one of ${ARTIFACT_AREAS.join(", ")}`);
  return a;
}
function checkRepo(r: unknown): string {
  const s = typeof r === "string" ? r.trim() : "";
  if (s !== "" && !ARTIFACT_REPO_RE.test(s)) throw bad("repo must be owner/repo");
  return s;
}
function checkVisibility(v: unknown): ArtifactVisibility {
  const s = v ?? "org";
  if (!(ARTIFACT_VISIBILITIES as readonly string[]).includes(s as string)) throw bad("visibility must be org or private");
  return s as ArtifactVisibility;
}
function checkSummary(s: unknown): string {
  const v = typeof s === "string" ? s : "";
  if (v.length > ARTIFACT_SUMMARY_MAX) throw bad(`summary is longer than ${ARTIFACT_SUMMARY_MAX} characters`);
  return v;
}
function checkKind(k: unknown): ArtifactKind {
  if (typeof k !== "string" || !(ARTIFACT_KINDS as readonly string[]).includes(k)) throw bad(`kind must be one of ${ARTIFACT_KINDS.join(", ")}`);
  return k as ArtifactKind;
}
function checkTextContent(content: unknown): string {
  if (typeof content !== "string") throw bad("content is required");
  if (utf8Bytes(content) > ARTIFACT_TEXT_CAP) throw new ArtifactError("too_large", `content exceeds ${ARTIFACT_TEXT_CAP} bytes`);
  return content;
}
function checkBinarySize(n: number): void {
  if (!Number.isInteger(n) || n < 1) throw bad("a binary artifact cannot be empty");
  if (n > ARTIFACT_BINARY_CAP) throw new ArtifactError("too_large", `file exceeds ${ARTIFACT_BINARY_CAP} bytes`);
}
const sameHandle = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

// ── links ────────────────────────────────────────────────────────────────────

/**
 * Normalize a link ref. ticket → its per-org NUMBER, sprint → its id (a leading "#" allowed),
 * which must exist IN THIS ORG when `mustExist` — the stored `target_ref` is that same number,
 * on a row that carries its own `org_id` (src/tools/tickets.ts › a ticket's two ids); pr / issue → "owner/repo#n", from "#n" / "n"
 * (resolved against the page's repo), "owner/repo#n", or a github.com URL.
 */
export async function normalizeLinkRef(
  ctx: TenantContext, type: ArtifactLinkType, ref: string, pageRepo: string, mustExist = true
): Promise<string> {
  if (!(ARTIFACT_LINK_TYPES as readonly string[]).includes(type)) throw bad(`target_type must be one of ${ARTIFACT_LINK_TYPES.join(", ")}`);
  const s = String(ref ?? "").trim();
  if (type === "ticket" || type === "sprint") {
    const m = /^#?(\d{1,12})$/.exec(s);
    if (!m) throw bad(`${type} ref must be an id`);
    const id = Number(m[1]);
    if (mustExist) {
      const target = type === "ticket" ? "tickets WHERE number" : "sprints WHERE id";
      if (!(await first(ctx, `SELECT 1 AS x FROM ${target} = ? AND org_id = ?`, id, ctx.orgId))) throw bad(`no such ${type}: ${id}`);
    }
    return String(id);
  }
  let repo: string | null = null;
  let n: string | null = null;
  let m: RegExpExecArray | null;
  if ((m = /^#?(\d{1,10})$/.exec(s))) {
    if (!pageRepo) throw bad(`a bare ${type} number needs the page's repo`);
    repo = pageRepo; n = m[1];
  } else if ((m = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d{1,10})$/.exec(s))) {
    repo = m[1]; n = m[2];
  } else if ((m = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(?:pull|pulls|issues)\/(\d{1,10})(?:[/?#].*)?$/i.exec(s))) {
    repo = `${m[1]}/${m[2]}`; n = m[3];
  }
  if (!repo || !n || Number(n) < 1) throw bad(`${type} ref must be #n, owner/repo#n or a GitHub URL`);
  return `${repo}#${Number(n)}`;
}

async function normalizeLinks(ctx: TenantContext, links: readonly ArtifactLinkInput[] | undefined, repo: string): Promise<ArtifactLinkInput[]> {
  const out: ArtifactLinkInput[] = [];
  const seen = new Set<string>();
  for (const l of links ?? []) {
    const ref = await normalizeLinkRef(ctx, l.target_type, l.target_ref, repo);
    const k = `${l.target_type}:${ref}`;
    if (!seen.has(k)) { seen.add(k); out.push({ target_type: l.target_type, target_ref: ref }); }
  }
  return out;
}

async function resolveLinks(ctx: TenantContext, rows: ArtifactLinkRow[]): Promise<ArtifactLinkDTO[]> {
  const ticketNumbers = rows.filter((r) => r.target_type === "ticket").map((r) => Number(r.target_ref));
  const sprintIds = rows.filter((r) => r.target_type === "sprint").map((r) => Number(r.target_ref));
  const tickets = new Map(
    (await fanOut<{ number: number; title: string; status: string }>(ctx, ticketNumbers, (p) => `SELECT number, title, status FROM tickets WHERE org_id = ? AND number IN (${p})`, [ctx.orgId]))
      .map((t) => [t.number, t])
  );
  const sprints = new Map(
    (await fanOut<{ id: number; title: string; dates: string | null; status: string }>(ctx, sprintIds, (p) => `SELECT id, title, dates, status FROM sprints WHERE org_id = ? AND id IN (${p})`, [ctx.orgId]))
      .map((s) => [s.id, s])
  );
  return rows.map((r): ArtifactLinkDTO => {
    const base = { target_type: r.target_type, target_ref: r.target_ref };
    if (r.target_type === "ticket") {
      const t = tickets.get(Number(r.target_ref));
      return { ...base, label: t?.title ?? null, meta: t?.status ?? null };
    }
    if (r.target_type === "sprint") {
      const s = sprints.get(Number(r.target_ref));
      if (!s) return { ...base, label: null, meta: null };
      return { ...base, label: s.title, meta: `${s.dates ?? ""}${s.status === "in_progress" ? " · ACTIVE" : ""}`.replace(/^ · /, "") };
    }
    const [repo, n] = r.target_ref.split("#");
    return { ...base, label: `#${n}`, meta: `${r.target_type === "pr" ? "PULL REQUEST" : "ISSUE"} · ${repo}` };
  });
}

// ── page lookup (THE visibility rule) ────────────────────────────────────────

/** THE visibility rule, bound by every read and write: org or the viewer's own, and not soft-deleted.
 *  Always beside `p.org_id = ?` — "org" visibility is the page's OWN org, never every org. */
const VISIBLE_SQL = `((p.visibility = 'org' OR p.author_id = ? COLLATE NOCASE) AND p.deleted_at IS NULL)`;

/** The page, if `viewer` may see it; else the one not_found. `allowPending` lets a version-0 page through (upload paths only). */
async function loadPage(ctx: TenantContext, slug: string, viewer: string, allowPending = false): Promise<ArtifactPageRow> {
  const parsed = parseSlugVersion(String(slug ?? ""));
  if (!parsed || parsed.version !== null) throw notFound();
  const p = await first<ArtifactPageRow>(ctx, `SELECT p.* FROM artifact_pages p WHERE p.slug = ? AND p.org_id = ? AND ${VISIBLE_SQL}`, parsed.slug, ctx.orgId, viewer);
  if (!p) throw notFound();
  if (p.current_version === 0 && !(allowPending && sameHandle(p.author_id, viewer))) throw notFound();
  return p;
}

/**
 * The kind of a page `viewer` may write to, INCLUDING the author's own still-pending
 * (version-0) binary page — the MCP `artifact_update` adapter needs it to pick the text
 * or the upload path before it calls a writer. Same one not_found as every other read.
 * (Track C addition, 2026-09-23.)
 */
export async function writablePageKind(ctx: TenantContext, slug: string, viewer: string): Promise<ArtifactKind> {
  return (await loadPage(ctx, slug, viewer, true)).kind;
}

const toVersionDTO = (v: ArtifactVersionRow | Omit<ArtifactVersionRow, "content">): ArtifactVersionDTO => ({
  version_no: v.version_no, summary: v.summary, created_by: v.created_by, created_at: v.created_at,
  size_bytes: v.size_bytes, content_type: v.content_type, sha256: v.sha256,
});

const VERSION_META_COLS = `id, page_id, version_no, summary, r2_key, size_bytes, content_type, sha256, filename, created_by, created_at`;

const excerptOf = (kind: ArtifactKind, content: string | null): string | null =>
  (kind === "markdown" || kind === "mermaid") && content !== null ? content.slice(0, 600) : null;

// ── reads ────────────────────────────────────────────────────────────────────

interface SummaryRow extends ArtifactPageRow { v_size: number; v_excerpt: string | null }

async function linkIdsByPage(ctx: TenantContext, pageIds: number[]): Promise<Map<number, { ticket_ids: number[]; sprint_ids: number[] }>> {
  const rows = await fanOut<{ page_id: number; target_type: string; target_ref: string }>(
    ctx, pageIds,
    (p) => `SELECT page_id, target_type, target_ref FROM artifact_links WHERE org_id = ? AND target_type IN ('ticket','sprint') AND page_id IN (${p}) ORDER BY created_at, rowid`,
    [ctx.orgId]
  );
  const out = new Map<number, { ticket_ids: number[]; sprint_ids: number[] }>();
  for (const id of pageIds) out.set(id, { ticket_ids: [], sprint_ids: [] });
  for (const r of rows) {
    const e = out.get(r.page_id)!;
    (r.target_type === "ticket" ? e.ticket_ids : e.sprint_ids).push(Number(r.target_ref));
  }
  return out;
}

const toSummary = (r: SummaryRow, ids: { ticket_ids: number[]; sprint_ids: number[] }): ArtifactSummaryDTO => ({
  id: r.id, slug: r.slug, title: r.title, kind: r.kind, area: r.area, repo: r.repo, author_id: r.author_id,
  status: r.status, visibility: r.visibility, current_version: r.current_version, updated_at: r.updated_at,
  published_at: r.published_at ?? null,
  size_bytes: r.v_size, excerpt: r.v_excerpt, ticket_ids: ids.ticket_ids, sprint_ids: ids.sprint_ids,
});

const isFilter = (v: string | undefined): v is string => typeof v === "string" && v.trim() !== "" && v !== "all";

/**
 * The library: every page `viewer` can see, newest version first (`updated_at` desc).
 * Filters are exact (`author` case-insensitive; `sprint` / `ticket` by id); `q` matches
 * the FTS index (title / description / body) or a title/slug substring.
 */
export async function listPages(ctx: TenantContext, filters: ArtifactListFilters, viewer: string): Promise<ArtifactSummaryDTO[]> {
  const where: string[] = [`p.current_version > 0`, VISIBLE_SQL];
  const params: unknown[] = [ctx.orgId, ctx.orgId, viewer]; // the JOIN's org, then the WHERE's
  if (isFilter(filters.area)) { where.push(`p.area = ?`); params.push(filters.area); }
  if (isFilter(filters.kind)) { where.push(`p.kind = ?`); params.push(filters.kind); }
  if (isFilter(filters.status)) { where.push(`p.status = ?`); params.push(filters.status); }
  if (isFilter(filters.author)) { where.push(`p.author_id = ? COLLATE NOCASE`); params.push(filters.author.trim()); }
  for (const t of ["sprint", "ticket"] as const) {
    const v = filters[t];
    if (!isFilter(v)) continue;
    const m = /^#?(\d{1,12})$/.exec(v.trim());
    if (!m) return [];
    where.push(`EXISTS (SELECT 1 FROM artifact_links l WHERE l.page_id = p.id AND l.org_id = ? AND l.target_type = ? AND l.target_ref = ?)`);
    params.push(ctx.orgId, t, String(Number(m[1])));
  }
  if (isFilter(filters.q)) {
    const q = filters.q.trim();
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const match = buildMatch(q);
    const likes = `p.title LIKE ? ESCAPE '\\' OR p.slug LIKE ? ESCAPE '\\'`;
    if (match) {
      where.push(`(p.id IN (SELECT CAST(page_id AS INTEGER) FROM artifacts_fts WHERE artifacts_fts MATCH ? AND artifacts_fts.org_id = ?) OR ${likes})`);
      params.push(match, ctx.orgId, like, like);
    } else {
      where.push(`(${likes})`);
      params.push(like, like);
    }
  }
  const rows = await all<SummaryRow>(
    ctx,
    `SELECT p.*, v.size_bytes AS v_size,
            CASE WHEN p.kind IN ('markdown','mermaid') THEN substr(v.content, 1, 600) END AS v_excerpt
       FROM artifact_pages p
       JOIN artifact_versions v ON v.page_id = p.id AND v.version_no = p.current_version AND v.org_id = ?
      WHERE p.org_id = ? AND ${where.join(" AND ")}
      ORDER BY p.updated_at DESC, p.id DESC`,
    ...params
  );
  const ids = await linkIdsByPage(ctx, rows.map((r) => r.id));
  return rows.map((r) => toSummary(r, ids.get(r.id)!));
}

/** One page with its version list, links, and the requested version (default the latest). */
export async function getPage(ctx: TenantContext, slug: string, version: number | null, viewer: string): Promise<ArtifactDetailDTO> {
  const p = await loadPage(ctx, slug, viewer);
  return await detailOf(ctx, p, version);
}

async function detailOf(ctx: TenantContext, p: ArtifactPageRow, version: number | null): Promise<ArtifactDetailDTO> {
  const want = version ?? p.current_version;
  if (!Number.isInteger(want) || want < 1 || want > p.current_version) throw notFound();
  const versions = await all<Omit<ArtifactVersionRow, "content">>(
    ctx, `SELECT ${VERSION_META_COLS} FROM artifact_versions WHERE page_id = ? AND org_id = ? ORDER BY version_no`, p.id, ctx.orgId
  );
  const req = await first<ArtifactVersionRow>(ctx, `SELECT * FROM artifact_versions WHERE page_id = ? AND org_id = ? AND version_no = ?`, p.id, ctx.orgId, want);
  if (!req) throw notFound();
  const latest = want === p.current_version
    ? req
    : await first<ArtifactVersionRow>(ctx, `SELECT * FROM artifact_versions WHERE page_id = ? AND org_id = ? AND version_no = ?`, p.id, ctx.orgId, p.current_version);
  const linkRows = await all<ArtifactLinkRow>(ctx, `SELECT * FROM artifact_links WHERE page_id = ? AND org_id = ? ORDER BY created_at, rowid`, p.id, ctx.orgId);
  const links = await resolveLinks(ctx, linkRows);
  const summary = toSummary(
    { ...p, v_size: latest?.size_bytes ?? 0, v_excerpt: excerptOf(p.kind, latest?.content ?? null) },
    {
      ticket_ids: linkRows.filter((l) => l.target_type === "ticket").map((l) => Number(l.target_ref)),
      sprint_ids: linkRows.filter((l) => l.target_type === "sprint").map((l) => Number(l.target_ref)),
    }
  );
  return {
    ...summary,
    ratified_version: p.ratified_version, ratified_by: p.ratified_by, ratified_at: p.ratified_at,
    versions: versions.map(toVersionDTO),
    links,
    version: toVersionDTO(req),
    content: isTextKind(p.kind) ? req.content : null,
    raw_url: rawUrl(p.slug, want),
  };
}

/** Two versions of one page, for the diff view. Either missing → not_found. */
export async function getVersionPair(ctx: TenantContext, slug: string, a: number, b: number, viewer: string): Promise<ArtifactDiffDTO> {
  const p = await loadPage(ctx, slug, viewer);
  const one = async (n: number) => {
    if (!Number.isInteger(n) || n < 1 || n > p.current_version) throw notFound();
    const v = await first<ArtifactVersionRow>(ctx, `SELECT * FROM artifact_versions WHERE page_id = ? AND org_id = ? AND version_no = ?`, p.id, ctx.orgId, n);
    if (!v) throw notFound();
    return { ...toVersionDTO(v), content: isTextKind(p.kind) ? v.content : null, raw_url: rawUrl(p.slug, n) };
  };
  return { kind: p.kind, a: await one(a), b: await one(b) };
}

export interface ArtifactRaw {
  slug: string;
  kind: ArtifactKind;
  version_no: number;
  /** Text kinds: `ARTIFACT_TEXT_CONTENT_TYPE[kind]`. Binary: the stored content_type. */
  content_type: string;
  filename: string | null;
  size_bytes: number;
  sha256: string;
  /** Text kinds: the content. */
  text: string | null;
  /** Binary kinds: the R2 object (stream `object.body`). */
  object: R2ObjectBody | null;
}

/** The bytes of one version (default the latest), for the raw route. */
export async function readRaw(ctx: TenantContext, bucket: R2Bucket, slug: string, version: number | null, viewer: string): Promise<ArtifactRaw> {
  const p = await loadPage(ctx, slug, viewer);
  const want = version ?? p.current_version;
  if (!Number.isInteger(want) || want < 1 || want > p.current_version) throw notFound();
  const v = await first<ArtifactVersionRow>(ctx, `SELECT * FROM artifact_versions WHERE page_id = ? AND org_id = ? AND version_no = ?`, p.id, ctx.orgId, want);
  if (!v) throw notFound();
  const base = { slug: p.slug, kind: p.kind, version_no: v.version_no, filename: v.filename, size_bytes: v.size_bytes, sha256: v.sha256 };
  if (isTextKind(p.kind)) {
    return { ...base, content_type: ARTIFACT_TEXT_CONTENT_TYPE[p.kind], text: v.content ?? "", object: null };
  }
  const object = await bucket.get(v.r2_key!);
  if (!object) throw notFound();
  return { ...base, content_type: v.content_type, text: null, object };
}

/**
 * `readRaw` addressed by PAGE ID — for the signed agent download (src/artifacts/download.ts),
 * whose token names the page by id. Same visibility rule, same one not_found: the id is
 * resolved to its slug and `readRaw` re-checks `viewer` at download time, so a page made
 * private after the URL was minted is the one not_found. (Track F addition, 2026-09-24.)
 */
export async function readRawByPageId(ctx: TenantContext, bucket: R2Bucket, pageId: number, version: number, viewer: string): Promise<ArtifactRaw> {
  if (!Number.isInteger(pageId) || pageId < 1) throw notFound();
  const row = await first<{ slug: string }>(ctx, `SELECT slug FROM artifact_pages WHERE id = ? AND org_id = ?`, pageId, ctx.orgId);
  if (!row) throw notFound();
  return readRaw(ctx, bucket, row.slug, version, viewer);
}

/** The stored filename of one version (binary uploads keep one; text versions store NULL). Track F, 2026-09-24. */
export async function versionFilename(ctx: TenantContext, pageId: number, version: number): Promise<string | null> {
  return (await first<{ filename: string | null }>(
    ctx, `SELECT filename FROM artifact_versions WHERE page_id = ? AND org_id = ? AND version_no = ?`, pageId, ctx.orgId, version
  ))?.filename ?? null;
}

export interface ArtifactSearchHit {
  id: number;
  slug: string;
  title: string;
  kind: ArtifactKind;
  status: ArtifactStatus;
  visibility: ArtifactVisibility;
  author_id: string;
  current_version: number;
  updated_at: string;
  /** The latest version's summary (the FTS "description"). */
  description: string;
  /** bm25(artifacts_fts, 1.0, 5.0, 1.0, 1.0) — LOWER is better. */
  rank: number;
  snippet: string;
}

/** Ranked FTS over the pages `viewer` can see. Nothing matchable in `q` → []. */
export async function searchArtifacts(ctx: TenantContext, q: string, viewer: string, limit = 20): Promise<ArtifactSearchHit[]> {
  const match = buildMatch(q ?? "");
  if (!match) return [];
  const [res] = await batch<ArtifactSearchHit>(ctx, [searchArtifactsStmt(ctx, match, viewer, limit)]);
  return res.results ?? [];
}

/**
 * The same ranked, visibility-checked FTS read as ONE prepared statement, over a
 * caller-built FTS5 `match` expression — so the quick search (src/tools/quick-search.ts)
 * can put it in its single batch without re-stating the visibility rule.
 * `liveOnly` drops drafts (the human, live-only reading `/search` applies).
 */
export function searchArtifactsStmt(ctx: TenantContext, match: string, viewer: string, limit = 20, liveOnly = false): Stmt {
  const n = Math.max(1, Math.min(100, Math.floor(limit) || 20));
  return stmt(
    ctx,
    `SELECT p.id, p.slug, p.title, p.kind, p.status, p.visibility, p.author_id, p.current_version, p.updated_at,
            artifacts_fts.description AS description,
            bm25(artifacts_fts, 1.0, 5.0, 1.0, 1.0) AS rank,
            snippet(artifacts_fts, -1, '', '', '…', 12) AS snippet
       FROM artifacts_fts
       JOIN artifact_pages p ON p.id = CAST(artifacts_fts.page_id AS INTEGER) AND p.org_id = ?
      WHERE artifacts_fts MATCH ? AND artifacts_fts.org_id = ? AND p.current_version > 0 AND ${VISIBLE_SQL}${liveOnly ? ` AND p.status <> 'draft'` : ""}
      ORDER BY rank
      LIMIT ${n}`,
    ctx.orgId, match, ctx.orgId, viewer
  );
}

// ── writes ───────────────────────────────────────────────────────────────────

/** What a version write stores. Exactly one of content / r2_key is set. */
interface VersionPayload {
  content: string | null;
  r2_key: string | null;
  size_bytes: number;
  content_type: string;
  sha256: string;
  filename: string | null;
  summary: string;
}

export interface ArtifactVersionResult {
  /** true when the sha256 matched the current version — nothing was written. */
  unchanged: boolean;
  version_no: number;
  page: ArtifactDetailDTO;
}

// The search row carries its page's org (0042_organizations, D9). `pageIdSql` is `?` or `PAGE_ID_SQL`, with its params.
const ftsInsert = (ctx: TenantContext, pageIdSql: string, pageIdParams: unknown[], title: string, description: string, body: string): Stmt =>
  stmt(ctx, `INSERT INTO artifacts_fts (page_id, title, description, body, org_id) VALUES (CAST((${pageIdSql}) AS TEXT), ?, ?, ?, ?)`,
    ...pageIdParams, title, description, body, ctx.orgId);

async function textPayload(kind: ArtifactTextKind, content: string, summary: string): Promise<VersionPayload> {
  checkTextContent(content);
  return {
    content, r2_key: null, size_bytes: utf8Bytes(content), content_type: ARTIFACT_TEXT_CONTENT_TYPE[kind],
    sha256: await sha256Hex(content), filename: null, summary,
  };
}

async function currentSha(ctx: TenantContext, p: ArtifactPageRow): Promise<string | null> {
  if (p.current_version < 1) return null;
  return (await first<{ sha256: string }>(ctx, `SELECT sha256 FROM artifact_versions WHERE page_id = ? AND org_id = ? AND version_no = ?`, p.id, ctx.orgId, p.current_version))?.sha256 ?? null;
}

/**
 * Append a version to an existing page (or land v1 on a version-0 binary page), in ONE
 * batch: the version row, the page's current_version/status/updated_at, the FTS row.
 * The first real version keeps the page's status (draft); any later one publishes it,
 * clears ratified_* and stamps `published_at` (the new version IS a new publication).
 * Same sha256 as the current version → nothing written.
 */
async function writeVersion(ctx: TenantContext, p: ArtifactPageRow, v: VersionPayload, who: string): Promise<ArtifactVersionResult> {
  if ((await currentSha(ctx, p)) === v.sha256) {
    return { unchanged: true, version_no: p.current_version, page: await detailOf(ctx, p, null) };
  }
  const next = p.current_version + 1;
  const now = nowIso();
  const status: ArtifactStatus = next === 1 ? p.status : "published";
  try {
    await batch(ctx, [
      stmt(
        ctx,
        `INSERT INTO artifact_versions (org_id, page_id, version_no, summary, content, r2_key, size_bytes, content_type, sha256, filename, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ctx.orgId, p.id, next, v.summary, v.content, v.r2_key, v.size_bytes, v.content_type, v.sha256, v.filename, who, now
      ),
      stmt(
        ctx,
        `UPDATE artifact_pages SET current_version = ?, status = ?, updated_at = ?,
                ratified_version = CASE WHEN ? = 'ratified' THEN ratified_version END,
                ratified_by      = CASE WHEN ? = 'ratified' THEN ratified_by END,
                ratified_at      = CASE WHEN ? = 'ratified' THEN ratified_at END,
                published_at     = CASE WHEN ? = 'published' THEN ? ELSE published_at END
          WHERE id = ? AND org_id = ? AND current_version = ?`,
        next, status, now, status, status, status, status, now, p.id, ctx.orgId, p.current_version
      ),
      stmt(ctx, `DELETE FROM artifacts_fts WHERE page_id = ? AND org_id = ?`, String(p.id), ctx.orgId),
      ftsInsert(ctx, "?", [String(p.id)], p.title, v.summary, ftsBody(p.kind, v.content)),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) throw new ArtifactError("conflict", "another version landed first — reload and retry");
    throw e;
  }
  const fresh = (await first<ArtifactPageRow>(ctx, `SELECT * FROM artifact_pages WHERE id = ? AND org_id = ?`, p.id, ctx.orgId))!;
  return { unchanged: false, version_no: next, page: await detailOf(ctx, fresh, null) };
}

/** A page's id from its slug, inside the batch that inserts it. Binds (slug, org). */
const PAGE_ID_SQL = `SELECT id FROM artifact_pages WHERE slug = ? AND org_id = ?`;

/** Insert a NEW page (+ v1 when `version` is given; a version-0 pending page otherwise) + FTS + links, in one batch. */
async function insertPage(
  ctx: TenantContext,
  f: { title: string; kind: ArtifactKind; area: string; repo: string; visibility: ArtifactVisibility },
  links: ArtifactLinkInput[],
  version: VersionPayload | null,
  who: string,
  extra: Stmt[] = [],
  slugOverride?: string
): Promise<string> {
  const slug = slugOverride ?? (await uniqueSlug(ctx, f.title));
  const now = nowIso();
  const stmts: Stmt[] = [
    stmt(
      ctx,
      `INSERT INTO artifact_pages (org_id, slug, title, kind, area, repo, author_id, status, visibility, current_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
      ctx.orgId, slug, f.title, f.kind, f.area, f.repo, who, f.visibility, version ? 1 : 0, now, now
    ),
  ];
  if (version) {
    stmts.push(stmt(
      ctx,
      `INSERT INTO artifact_versions (org_id, page_id, version_no, summary, content, r2_key, size_bytes, content_type, sha256, filename, created_by, created_at)
       VALUES (?, (${PAGE_ID_SQL}), 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ctx.orgId, slug, ctx.orgId, version.summary, version.content, version.r2_key, version.size_bytes, version.content_type, version.sha256, version.filename, who, now
    ));
  }
  stmts.push(ftsInsert(ctx, PAGE_ID_SQL, [slug, ctx.orgId], f.title, version?.summary ?? "", version ? ftsBody(f.kind, version.content) : ""));
  for (const l of links) {
    stmts.push(stmt(
      ctx,
      `INSERT OR IGNORE INTO artifact_links (org_id, page_id, target_type, target_ref, created_by, created_at) VALUES (?, (${PAGE_ID_SQL}), ?, ?, ?, ?)`,
      ctx.orgId, slug, ctx.orgId, l.target_type, l.target_ref, who, now
    ));
  }
  try {
    await batch(ctx, [...stmts, ...extra]);
  } catch (e) {
    if (isUniqueViolation(e)) throw new ArtifactError("conflict", "that slug was just taken — retry");
    throw e;
  }
  return slug;
}

function pageFields(input: { title?: unknown; kind: unknown; area?: unknown; repo?: unknown; visibility?: unknown }) {
  return {
    title: checkTitle(input.title),
    kind: checkKind(input.kind),
    area: checkArea(input.area),
    repo: checkRepo(input.repo),
    visibility: checkVisibility(input.visibility),
  };
}

/** A binary page created with its bytes in hand (HTTP multipart). */
export type CreateBinaryArtifactInput = ArtifactPageFields & {
  kind: ArtifactBinaryKind;
  bytes: ArrayBuffer | Uint8Array;
  content_type?: string | null;
  filename?: string | null;
  summary?: string;
};
export type CreateArtifactInput = CreateTextArtifactInput | CreateBinaryArtifactInput;

/**
 * Create a page with its v1 (status `draft`). Text kinds carry `content`; binary kinds
 * carry `bytes` and need `bucket` (the bytes go to `artifacts/<sha256>` first).
 */
export async function createPage(ctx: TenantContext, input: CreateArtifactInput, author: string, bucket?: R2Bucket): Promise<ArtifactDetailDTO> {
  const f = pageFields(input);
  const summary = checkSummary(input.summary);
  const links = await normalizeLinks(ctx, input.links, f.repo);
  let payload: VersionPayload;
  if (isTextKind(f.kind)) {
    payload = await textPayload(f.kind, (input as CreateTextArtifactInput).content, summary);
  } else {
    const b = input as CreateBinaryArtifactInput;
    if (!bucket) throw new Error("createPage: a binary kind needs the R2 bucket");
    if (!b.bytes) throw bad("bytes are required");
    payload = await binaryPayload(bucket, f.kind as ArtifactBinaryKind, b.bytes, b.content_type, b.filename, summary);
  }
  const slug = await insertPage(ctx, f, links, payload, author);
  return await getPage(ctx, slug, null, author);
}

async function binaryPayload(
  bucket: R2Bucket, kind: ArtifactBinaryKind, bytes: ArrayBuffer | Uint8Array,
  declared: string | null | undefined, filename: string | null | undefined, summary: string,
  skipPutIfSha?: string | null
): Promise<VersionPayload> {
  checkBinarySize(bytes.byteLength);
  const name = cleanFilename(filename);
  const content_type = binaryContentType(kind, declared, name);
  const sha = await sha256Hex(bytes);
  if (sha !== skipPutIfSha) {
    await bucket.put(r2KeyFor(sha), bytes, { sha256: sha, httpMetadata: { contentType: content_type } });
  }
  return { content: null, r2_key: r2KeyFor(sha), size_bytes: bytes.byteLength, content_type, sha256: sha, filename: name, summary };
}

/**
 * Add a text version: the full `content`, or an `old_str` → `new_str` edit of the
 * latest content (`old_str` must occur EXACTLY once).
 */
export async function addTextVersion(ctx: TenantContext, slug: string, input: AddTextVersionInput, who: string): Promise<ArtifactVersionResult> {
  const p = await loadPage(ctx, slug, who);
  if (!isTextKind(p.kind)) throw bad(`a ${p.kind} artifact takes a file, not text`);
  const summary = checkSummary(input.summary);
  let content: string;
  if ("content" in input && typeof input.content === "string") {
    content = input.content;
  } else if ("old_str" in input && typeof input.old_str === "string" && input.old_str !== "" && typeof input.new_str === "string") {
    const cur = (await first<{ content: string }>(ctx, `SELECT content FROM artifact_versions WHERE page_id = ? AND org_id = ? AND version_no = ?`, p.id, ctx.orgId, p.current_version))?.content ?? "";
    const at = cur.indexOf(input.old_str);
    if (at < 0) throw bad("old_str does not occur in the latest version");
    if (cur.indexOf(input.old_str, at + 1) >= 0) throw bad("old_str occurs more than once in the latest version");
    content = cur.slice(0, at) + input.new_str + cur.slice(at + input.old_str.length);
  } else {
    throw bad("give content, or old_str and new_str");
  }
  return await writeVersion(ctx, p, await textPayload(p.kind, content, summary), who);
}

/** Add a binary version with the bytes in hand (HTTP multipart). */
export async function addBinaryVersion(
  ctx: TenantContext, bucket: R2Bucket, slug: string,
  input: { bytes: ArrayBuffer | Uint8Array; content_type?: string | null; filename?: string | null; summary?: string },
  who: string
): Promise<ArtifactVersionResult> {
  const p = await loadPage(ctx, slug, who);
  if (!isBinaryKind(p.kind)) throw bad(`a ${p.kind} artifact takes text, not a file`);
  const summary = checkSummary(input.summary);
  const cur = await currentSha(ctx, p);
  const payload = await binaryPayload(bucket, p.kind, input.bytes, input.content_type, input.filename, summary, cur);
  return await writeVersion(ctx, p, payload, who);
}

/**
 * PATCH a page: title / area / repo by anyone who can read it; `visibility: "private"`
 * by its AUTHOR only (else forbidden); private → org also moves draft → published;
 * `status` draft ⇄ published (from ratified, clearing ratified_*). Ratify is `ratify`.
 * `published_at` (0035): → draft clears it; a page that ends published/ratified keeps its
 * stamp, or gets `now` when it had none (draft → published).
 */
export async function patchPage(ctx: TenantContext, slug: string, input: PatchArtifactInput, who: string): Promise<ArtifactDetailDTO> {
  const p = await loadPage(ctx, slug, who);
  const title = input.title !== undefined ? checkTitle(input.title) : p.title;
  const area = input.area !== undefined ? checkArea(input.area) : p.area;
  const repo = input.repo !== undefined ? checkRepo(input.repo) : p.repo;
  let visibility = p.visibility;
  let status: ArtifactStatus = p.status;
  if (input.visibility !== undefined) {
    const v = checkVisibility(input.visibility);
    if (v === "private" && p.visibility !== "private" && !sameHandle(p.author_id, who)) {
      throw new ArtifactError("forbidden", "only the author can make an artifact private");
    }
    if (v === "org" && p.visibility === "private" && status === "draft") status = "published";
    visibility = v;
  }
  if (input.status !== undefined) {
    if (input.status !== "draft" && input.status !== "published") throw bad("status must be draft or published — ratify has its own route");
    status = input.status; // an explicit status wins over the private → org rule above
  }
  const stmts: Stmt[] = [
    stmt(
      ctx,
      `UPDATE artifact_pages SET title = ?, area = ?, repo = ?, visibility = ?, status = ?,
              ratified_version = CASE WHEN ? = 'ratified' THEN ratified_version END,
              ratified_by      = CASE WHEN ? = 'ratified' THEN ratified_by END,
              ratified_at      = CASE WHEN ? = 'ratified' THEN ratified_at END,
              published_at     = CASE WHEN ? = 'draft' THEN NULL ELSE COALESCE(published_at, ?) END
        WHERE id = ? AND org_id = ?`,
      title, area, repo, visibility, status, status, status, status, status, nowIso(), p.id, ctx.orgId
    ),
  ];
  if (title !== p.title) stmts.push(stmt(ctx, `UPDATE artifacts_fts SET title = ? WHERE page_id = ? AND org_id = ?`, title, String(p.id), ctx.orgId));
  await batch(ctx, stmts);
  return await getPage(ctx, p.slug, null, who);
}

/** draft ⇄ published (the PATCH `status` rule on its own). */
export function setStatus(ctx: TenantContext, slug: string, status: "draft" | "published", who: string): Promise<ArtifactDetailDTO> {
  return patchPage(ctx, slug, { status }, who);
}

/**
 * Ratify `version`: only a `published` page's CURRENT version (`canRatify`), else
 * conflict. SESSION ONLY — the routes decide that; there is no MCP path.
 */
export async function ratify(ctx: TenantContext, slug: string, version: number, who: string): Promise<ArtifactDetailDTO> {
  const p = await loadPage(ctx, slug, who);
  if (!canRatify(p.status, version, p.current_version)) {
    throw new ArtifactError("conflict", p.status === "draft" ? "publish before ratifying" : p.status === "ratified" ? "already ratified" : "only the latest version can be ratified");
  }
  const res = await run(
    ctx,
    `UPDATE artifact_pages SET status = 'ratified', ratified_version = ?, ratified_by = ?, ratified_at = ?
      WHERE id = ? AND org_id = ? AND status = 'published' AND current_version = ?`,
    version, who, nowIso(), p.id, ctx.orgId, version
  );
  if (!res.meta.changes) throw new ArtifactError("conflict", "the page changed — reload and retry");
  return await getPage(ctx, p.slug, null, who);
}

/** Link a page to a ticket / sprint (must exist) / PR / issue. Idempotent. */
export async function addLink(ctx: TenantContext, slug: string, link: ArtifactLinkInput, who: string): Promise<ArtifactDetailDTO> {
  const p = await loadPage(ctx, slug, who);
  const ref = await normalizeLinkRef(ctx, link.target_type, link.target_ref, p.repo);
  await run(ctx, `INSERT OR IGNORE INTO artifact_links (org_id, page_id, target_type, target_ref, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ctx.orgId, p.id, link.target_type, ref, who, nowIso());
  return await getPage(ctx, p.slug, null, who);
}

/** Unlink. Idempotent; the target need not exist any more. */
export async function removeLink(ctx: TenantContext, slug: string, link: ArtifactLinkInput, who: string): Promise<ArtifactDetailDTO> {
  const p = await loadPage(ctx, slug, who);
  const ref = await normalizeLinkRef(ctx, link.target_type, link.target_ref, p.repo, false);
  await run(ctx, `DELETE FROM artifact_links WHERE page_id = ? AND org_id = ? AND target_type = ? AND target_ref = ?`, p.id, ctx.orgId, link.target_type, ref);
  return await getPage(ctx, p.slug, null, who);
}

// ── soft delete (0035 PART D) ────────────────────────────────────────────────

/**
 * Soft-delete a page: stamp `deleted_at` / `deleted_by` and drop its FTS row, in ONE
 * batch; no version, link or R2 object is touched. The page must be visible to `who`
 * (else the one not_found — a private page of someone else's, a pending page, an
 * already-deleted one); then only its AUTHOR (case-insensitive) or an ADMIN may, else
 * `forbidden` with nothing written. Session-cookie only (`POST /api/artifacts/:slug/delete`).
 */
export async function deletePage(ctx: TenantContext, slug: string, who: string, admin: boolean): Promise<{ slug: string; title: string; versions: number }> {
  const p = await loadPage(ctx, slug, who);
  if (!admin && !sameHandle(p.author_id, who)) throw new ArtifactError("forbidden", "only the artifact's author or an admin can delete it");
  const res = await batch(ctx, [
    stmt(ctx, `UPDATE artifact_pages SET deleted_at = ?, deleted_by = ? WHERE id = ? AND org_id = ? AND deleted_at IS NULL`, nowIso(), who, p.id, ctx.orgId),
    stmt(ctx, `DELETE FROM artifacts_fts WHERE page_id = ? AND org_id = ?`, String(p.id), ctx.orgId),
  ]);
  if (!res[0].meta.changes) throw notFound(); // a racing delete won
  return { slug: p.slug, title: p.title, versions: p.current_version };
}

/**
 * Restore a soft-deleted page: clear `deleted_at` / `deleted_by` and re-insert its FTS
 * row (title, the current version's summary and body), in ONE batch — the page is back
 * exactly as it was. The same people as delete: its author or an admin, and the page
 * must otherwise be visible to them (org, or their own private page). For anyone else a
 * deleted page stays the one not_found; a LIVE page they can see is `conflict`.
 */
export async function restorePage(ctx: TenantContext, slug: string, who: string, admin: boolean): Promise<ArtifactDetailDTO> {
  const parsed = parseSlugVersion(String(slug ?? ""));
  if (!parsed || parsed.version !== null) throw notFound();
  const p = await first<ArtifactPageRow>(
    ctx, `SELECT p.* FROM artifact_pages p WHERE p.slug = ? AND p.org_id = ? AND (p.visibility = 'org' OR p.author_id = ? COLLATE NOCASE)`, parsed.slug, ctx.orgId, who
  );
  if (!p || p.current_version === 0) throw notFound();
  const mayRestore = admin || sameHandle(p.author_id, who);
  if (!p.deleted_at) throw new ArtifactError("conflict", "artifact is not deleted");
  if (!mayRestore) throw notFound();
  const cur = await first<ArtifactVersionRow>(ctx, `SELECT * FROM artifact_versions WHERE page_id = ? AND org_id = ? AND version_no = ?`, p.id, ctx.orgId, p.current_version);
  await batch(ctx, [
    stmt(ctx, `UPDATE artifact_pages SET deleted_at = NULL, deleted_by = NULL WHERE id = ? AND org_id = ?`, p.id, ctx.orgId),
    stmt(ctx, `DELETE FROM artifacts_fts WHERE page_id = ? AND org_id = ?`, String(p.id), ctx.orgId),
    ftsInsert(ctx, "?", [String(p.id)], p.title, cur?.summary ?? "", ftsBody(p.kind, cur?.content ?? null)),
  ]);
  return await getPage(ctx, p.slug, null, who);
}

// ── upload tokens (the binary PUT) ───────────────────────────────────────────

function randomToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface ArtifactUploadMint extends ArtifactUploadTicketDTO {
  /** The bearer secret — shown once; only its SHA-256 is stored. */
  token: string;
}

/**
 * Mint a single-use upload token (TTL `ARTIFACT_UPLOAD_TTL_MS`) bound to principal,
 * page, kind, size, sha256, content_type, filename and summary. With `slug`: a new
 * version of that page (its author may also target their own still-pending page). With
 * no slug: a NEW page is created with `current_version = 0` — invisible until the PUT
 * lands. `upload_url` is the relative PUT path; the adapter may prefix an origin.
 */
export async function mintUploadToken(ctx: TenantContext, input: UploadTicketInput, principal: string): Promise<ArtifactUploadMint> {
  const kind = checkKind(input.kind);
  if (!isBinaryKind(kind)) throw bad("upload tokens are for image, pdf and file kinds");
  checkBinarySize(input.size_bytes);
  const sha = String(input.sha256 ?? "").trim().toLowerCase();
  if (!SHA256_HEX_RE.test(sha)) throw bad("sha256 must be 64 hex characters");
  const filename = cleanFilename(input.filename);
  const content_type = binaryContentType(kind, input.content_type, filename);
  const summary = checkSummary(input.summary);
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  const expires_at = new Date(now + ARTIFACT_UPLOAD_TTL_MS).toISOString();
  const tokenStmt = (pageSlug: string): Stmt => stmt(
    ctx,
    `INSERT INTO artifact_upload_tokens (org_id, token_hash, principal, page_id, kind, size_bytes, sha256, content_type, filename, summary, expires_at, used_at, created_at)
     VALUES (?, ?, ?, (${PAGE_ID_SQL}), ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    ctx.orgId, tokenHash, principal, pageSlug, ctx.orgId, kind, input.size_bytes, sha, content_type, filename, summary, expires_at, new Date(now).toISOString()
  );
  let slug: string;
  if (input.slug !== undefined && input.slug !== null && input.slug !== "") {
    const p = await loadPage(ctx, input.slug, principal, true);
    if (p.kind !== kind) throw bad(`this page is a ${p.kind} artifact — its kind never changes`);
    slug = p.slug;
    await batch(ctx, [tokenStmt(slug)]);
  } else {
    const f = pageFields({ ...input, kind });
    const links = await normalizeLinks(ctx, input.links, f.repo);
    slug = await uniqueSlug(ctx, f.title);
    await insertPage(ctx, f, links, null, principal, [tokenStmt(slug)], slug);
  }
  const id = (await first<{ id: number }>(ctx, `SELECT id FROM artifact_pages WHERE slug = ? AND org_id = ?`, slug, ctx.orgId))!.id;
  return { id, slug, token, upload_url: `/api/artifacts/upload/${token}`, expires_at };
}

/**
 * The PUT: claim the token (single use, unexpired, minted in THIS org — another org's token is the
 * unknown-token not_found), re-check the page is still visible
 * to the token's principal, stream the body through `FixedLengthStream(size_bytes)`
 * into R2 at `artifacts/<sha256>` with R2's own `sha256` check — ALWAYS a put, even if
 * the key exists, so knowing a hash never attaches bytes the caller does not have —
 * then land the version. Unknown token → not_found; expired / used → gone; a length or
 * hash mismatch → bad_request (the claim is released so the same token can retry).
 */
export async function consumeUploadToken(
  ctx: TenantContext, bucket: R2Bucket, token: string, body: ReadableStream<Uint8Array> | null
): Promise<ArtifactVersionResult> {
  const hash = await sha256Hex(String(token ?? ""));
  const now = nowIso();
  const claim = await run(ctx, `UPDATE artifact_upload_tokens SET used_at = ? WHERE token_hash = ? AND org_id = ? AND used_at IS NULL AND expires_at > ?`, now, hash, ctx.orgId, now);
  if (!claim.meta.changes) {
    const exists = await first(ctx, `SELECT 1 AS x FROM artifact_upload_tokens WHERE token_hash = ? AND org_id = ?`, hash, ctx.orgId);
    if (!exists) throw notFound();
    throw new ArtifactError("gone", "this upload link has expired or was already used");
  }
  const release = () => run(ctx, `UPDATE artifact_upload_tokens SET used_at = NULL WHERE token_hash = ? AND org_id = ? AND used_at = ?`, hash, ctx.orgId, now);
  const t = (await first<ArtifactUploadTokenRow>(ctx, `SELECT * FROM artifact_upload_tokens WHERE token_hash = ? AND org_id = ?`, hash, ctx.orgId))!;
  const p = await first<ArtifactPageRow>(ctx, `SELECT p.* FROM artifact_pages p WHERE p.id = ? AND p.org_id = ? AND ${VISIBLE_SQL}`, t.page_id, ctx.orgId, t.principal);
  if (!p || p.kind !== t.kind) throw notFound();
  if (!body) {
    await release();
    throw bad("the upload body is empty");
  }
  const key = r2KeyFor(t.sha256);
  try {
    const fixed = new FixedLengthStream(t.size_bytes);
    const [piped, put] = await Promise.allSettled([
      body.pipeTo(fixed.writable),
      bucket.put(key, fixed.readable, { sha256: t.sha256, httpMetadata: { contentType: t.content_type } }),
    ]);
    if (piped.status === "rejected" || put.status === "rejected" || !put.value) throw new Error("upload stream failed");
  } catch {
    await release();
    throw bad("the upload did not match its declared size_bytes or sha256");
  }
  return await writeVersion(ctx, p, {
    content: null, r2_key: key, size_bytes: t.size_bytes, content_type: t.content_type,
    sha256: t.sha256, filename: t.filename, summary: t.summary,
  }, t.principal);
}

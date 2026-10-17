// Markdown import runs (0081_docs_library `doc_imports`, 0082_doc_import_manifest; docs/architecture/docs-library.md
// › Import). The browser unzips (web/src/zip-reader.ts) and drives the run over several requests; this module is the
// Worker's half, behind the cookie-only routes of ./routes.ts:
//   • `startImport`   — `POST /imports`: the manifest (paths, sizes, each Markdown file's first heading) and the
//                        person's conflict choices. The caps are checked and the SAME planner the Preview ran
//                        (shared/docs-import-core.ts `planImport` + `applyConflictChoices`) is re-run against the
//                        org's own pages, so the browser's plan is advisory. The run row is the org's LOCK (one
//                        running import at a time, sync_runs-style: one guarded INSERT) and holds the SERVER's plan
//                        (`manifest`), which every later request is checked against.
//   • `uploadImportImage` — `POST /imports/:id/images`: one image the manifest lists; its type sniffed from the bytes
//                        and its sha256 computed here, stored as a doc image (R2 `doc-images/<sha>` with R2's own
//                        sha256 check, `doc_images` INSERT OR IGNORE), and recorded on the run.
//   • `sendImportPages` — `POST /imports/:id/pages`: at most `IMPORT_PAGES_PER_BATCH` pages. Each is re-validated
//                        (a page of the plan, Markdown, readable text, ≤ 1 MB, the same text the manifest described),
//                        its body prepared by the shared `prepareBody` with the SERVER's path → slug map and the
//                        run's uploaded images, then sent INTO THE GATE (`ingestDocProposal`, confidence high,
//                        section `reference`, ledger `import:<id>` × the write's index — a retried batch replays).
//   • `finishImport`  — `POST /imports/:id/finish`: done / partial / failed by what reached Review; or cancelled.
//   • `approveImport` / `rejectImport` — Review's "Approve all" / "Reject all" for one import (bounded per call).
//   • `listImports` / `readImport` — Imports history.
// Nothing here is reachable from src/mcp.ts: an import is a person's, over the cookie.
import {
  IMPORT_APPROVE_PER_CALL, IMPORT_FILE_NAME_MAX, IMPORT_PAGES_PER_BATCH, IMPORT_REJECT_PER_CALL, IMPORT_STALE_MS,
  MAX_FILES, MAX_IMAGE_BYTES, MAX_MD_BYTES, MAX_TOTAL_BYTES,
  applyConflictChoices, importKind, normalizeImportPath, planImport, prepareBody, titleFromMarkdown, zeroImportCounts,
  type ConflictChoice, type ConflictResolution, type ImportCounts, type ImportErrorCode, type ImportFailure, type ImportFile,
  type ImportPageCode, type ImportPageResult, type ImportPlanView, type ImportRunStatus, type ImportRunView, type ImportWrite,
} from "@shared/docs-import-core";
import { buildTree, ancestorsOf, depthOf, type DocTreeNode } from "@shared/docs-tree-core";
import { docImageKey } from "@shared/doc-images";
import { type TenantContext, all, batch, first, run, stmt, type Stmt } from "../data/sql";
import { hasRole } from "../data/context";
import { REVIEW_ITEM, reviewRef, supersedeOpenSuggestions } from "../data/ai";
import { ingestDocProposal } from "../consumer";
import { spaceState } from "../tools/spaces";
import { promote_doc } from "../tools/writes";
import { sha256Hex } from "../tools/artifacts";
import { sniffAvatarType } from "../tools/people";

/** A refused request: a fixed code, the HTTP status, a sentence — and, for `import_running`, the run that holds the lock. */
export class ImportError extends Error {
  constructor(readonly code: ImportErrorCode, readonly status: 400 | 403 | 404 | 409 | 413, message: string, readonly run?: ImportRunView) {
    super(message);
    this.name = "ImportError";
  }
}

// ── the row ──────────────────────────────────────────────────────────────────

interface RunRow {
  id: number; space_slug: string; parent_slug: string | null; file_name: string; started_by: string; started_at: string;
  updated_at: string; ended_at: string | null; status: string; counts: string; failures: string; total: number | null;
  file_size: number | null; file_count: number | null; space_name: string | null;
}
const COLS = `i.id, i.space_slug, i.parent_slug, i.file_name, i.started_by, i.started_at, i.updated_at, i.ended_at, i.status, i.counts,
  i.failures, i.total, json_extract(i.manifest, '$.file_size') AS file_size, COALESCE(json_extract(i.manifest, '$.file_count'), json_array_length(i.manifest, '$.files')) AS file_count,
  s.name AS space_name`;
const FROM = `FROM doc_imports i LEFT JOIN doc_spaces s ON s.org_id = i.org_id AND s.slug = i.space_slug`;

/** The SERVER's plan, kept on the run (`doc_imports.manifest`) and read back by every later request. */
interface Manifest {
  file_size: number | null;
  /** The accepted files, normalized: Markdown files carry their heading (`title`). */
  files: { path: string; size: number; title?: string | null }[];
  choices: Record<string, ConflictResolution | ConflictChoice>;
  /** What each page will be, depth-first (parents first). A write's index is its ledger item index. */
  writes: ImportWrite[];
  /** Markdown path / folder path → the slug a link to it becomes. */
  links: [string, string][];
  /** The image paths the plan found. */
  images: string[];
}

const parsed = <T>(json: string | null, fallback: T): T => { try { return json ? (JSON.parse(json) as T) : fallback; } catch { return fallback; } };

const isStale = (r: Pick<RunRow, "status" | "updated_at">, now: number): boolean =>
  r.status === "running" && Date.parse(r.updated_at) <= now - IMPORT_STALE_MS;

interface Extras { parentPath: string[]; waiting: number }

function runView(r: RunRow, now: number, x: Extras): ImportRunView {
  const stale = isStale(r, now);
  const failures = parsed<ImportFailure[]>(r.failures, []);
  const list = Array.isArray(failures) ? failures : [];
  return {
    id: r.id, status: stale ? "abandoned" : (r.status as ImportRunStatus), space: r.space_slug, space_name: r.space_name,
    parent_slug: r.parent_slug, parent_path: x.parentPath, file_name: r.file_name, file_size: typeof r.file_size === "number" ? r.file_size : null,
    file_count: r.file_count ?? 0, by: r.started_by, started_at: r.started_at, updated_at: r.updated_at,
    ended_at: stale ? r.updated_at : r.ended_at, cancelled: list.some((f) => f.code === "cancelled" && f.path === null),
    counts: { ...zeroImportCounts(), ...parsed<Partial<ImportCounts>>(r.counts, {}) }, failures: list, waiting: x.waiting,
  };
}

const getRow = (ctx: TenantContext, id: number): Promise<RunRow | null> =>
  first<RunRow>(ctx, `SELECT ${COLS} ${FROM} WHERE i.org_id = ? AND i.id = ?`, ctx.orgId, id);

const liveRow = (ctx: TenantContext, now: number): Promise<RunRow | null> =>
  first<RunRow>(ctx, `SELECT ${COLS} ${FROM} WHERE i.org_id = ? AND i.status = 'running' AND i.updated_at > ? ORDER BY i.id DESC LIMIT 1`,
    ctx.orgId, new Date(now - IMPORT_STALE_MS).toISOString());

/** Pages of these runs still waiting in Review (staged, the doc's newest, newer than its live version). */
async function waitingByRun(ctx: TenantContext, ids: number[]): Promise<Map<number, number>> {
  if (!ids.length) return new Map();
  const rows = await all<{ import_id: number; n: number }>(ctx,
    `SELECT v.import_id AS import_id, COUNT(*) AS n FROM doc_versions v JOIN docs d ON d.org_id = ? AND d.slug = v.slug
      WHERE v.org_id = ? AND v.import_id IS NOT NULL AND v.status = 'staged' AND v.version > d.current_version
      GROUP BY v.import_id`, ctx.orgId, ctx.orgId);
  const want = new Set(ids);
  return new Map(rows.filter((r) => want.has(r.import_id)).map((r) => [r.import_id, r.n]));
}

/** Each parent page's path (its ancestors' titles and its own), for runs that import under a page. */
async function parentPaths(ctx: TenantContext, rows: RunRow[]): Promise<Map<string, string[]>> {
  if (!rows.some((r) => r.parent_slug)) return new Map();
  const nodes = await all<DocTreeNode>(ctx, `SELECT slug, parent_slug, tree_rank, space, title FROM docs WHERE org_id = ?`, ctx.orgId);
  const tree = buildTree(nodes);
  const out = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.parent_slug || out.has(r.parent_slug)) continue;
    const self = tree.bySlug.get(r.parent_slug);
    out.set(r.parent_slug, self ? [...ancestorsOf(tree, r.parent_slug).map((a) => a.title ?? a.slug), self.title ?? self.slug] : []);
  }
  return out;
}

async function views(ctx: TenantContext, rows: RunRow[], now: number): Promise<ImportRunView[]> {
  const [waiting, paths] = await Promise.all([waitingByRun(ctx, rows.map((r) => r.id)), parentPaths(ctx, rows)]);
  return rows.map((r) => runView(r, now, { parentPath: r.parent_slug ? paths.get(r.parent_slug) ?? [] : [], waiting: waiting.get(r.id) ?? 0 }));
}

async function viewOf(ctx: TenantContext, id: number, now: number): Promise<ImportRunView> {
  const row = await getRow(ctx, id);
  if (!row) throw new ImportError("not_found", 404, "there is no such import");
  return (await views(ctx, [row], now))[0];
}

// ── reads ────────────────────────────────────────────────────────────────────

/** The most runs Imports history lists. */
export const IMPORT_HISTORY_MAX = 100;

/** `GET /imports`: newest first, and how many are in progress (the sidebar's badge). */
export async function listImports(ctx: TenantContext, now: number = Date.now()): Promise<{ imports: ImportRunView[]; running: number }> {
  const rows = await all<RunRow>(ctx, `SELECT ${COLS} ${FROM} WHERE i.org_id = ? ORDER BY i.id DESC LIMIT ${IMPORT_HISTORY_MAX}`, ctx.orgId);
  const list = await views(ctx, rows, now);
  return { imports: list, running: list.filter((v) => v.status === "running").length };
}

/** `GET /imports/:id`. */
export const readImport = (ctx: TenantContext, id: number, now: number = Date.now()): Promise<ImportRunView> => viewOf(ctx, id, now);

// ── start ────────────────────────────────────────────────────────────────────

const bad = (message: string): ImportError => new ImportError("invalid", 400, message);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function parseChoices(raw: unknown): Record<string, ConflictResolution | ConflictChoice> {
  if (raw === undefined || raw === null) return {};
  if (!isObj(raw)) throw bad("choices is an object of page key → skip | version | rename");
  const out: Record<string, ConflictResolution | ConflictChoice> = {};
  for (const [k, v] of Object.entries(raw).slice(0, MAX_FILES)) {
    if (v === "skip" || v === "version" || v === "rename") { out[k] = v; continue; }
    if (isObj(v) && (v.choice === "skip" || v.choice === "version")) { out[k] = { choice: v.choice }; continue; }
    if (isObj(v) && v.choice === "rename") {
      const title = typeof v.title === "string" ? v.title.replace(/\s+/g, " ").trim().slice(0, 200) : "";
      out[k] = title ? { choice: "rename", title } : { choice: "rename" };
      continue;
    }
    throw bad(`the choice for ${k.slice(0, 80)} is not skip, version or rename`);
  }
  return out;
}

/** The person's manifest, checked: at most `MAX_FILES` files, `MAX_TOTAL_BYTES` together, each Markdown one with
 *  its heading. Paths are NOT refused here — the planner lists a bad one as skipped. */
function parseFiles(raw: unknown): ImportFile[] {
  if (!Array.isArray(raw) || raw.length === 0) throw bad("files is a list of { path, size, title }");
  if (raw.length > MAX_FILES) throw new ImportError("too_many_files", 413, `an import is at most ${MAX_FILES} files`);
  let total = 0;
  const files: ImportFile[] = raw.map((f, i) => {
    if (!isObj(f) || typeof f.path !== "string" || !f.path || f.path.length > 1024) throw bad(`files[${i}].path is required (at most 1024 characters)`);
    const size = f.size;
    if (typeof size !== "number" || !Number.isInteger(size) || size < 0) throw bad(`files[${i}].size is a whole number of bytes`);
    total += size;
    const kind = importKind(f.path);
    if (kind !== "md") return { path: f.path, size, kind };
    if (!("title" in f) || (f.title !== null && typeof f.title !== "string")) throw bad(`files[${i}].title is the file's first heading, or null`);
    return { path: f.path, size, kind, title: f.title === null ? null : String(f.title).slice(0, 300) };
  });
  if (total > MAX_TOTAL_BYTES) throw new ImportError("too_large", 413, `an import is at most ${MAX_TOTAL_BYTES / (1024 * 1024)} MB`);
  return files;
}

const cleanFileName = (raw: unknown): string => {
  const s = typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim() : "";
  if (!s) throw bad("file_name is required");
  return s.slice(0, IMPORT_FILE_NAME_MAX);
};

/** A run's start, checked and planned BEFORE the rate limit is taken: a refusal (invalid, the caps, no Markdown, the
 *  lock) costs the person nothing. What `startImport` writes. */
export interface StartInput {
  space: string; parent: string | null; fileName: string; fileSize: number | null; fileCount: number;
  manifest: Manifest; counts: ImportCounts; failures: ImportFailure[]; plan: ImportPlanView;
}

export async function checkStart(ctx: TenantContext, raw: unknown, now: number = Date.now()): Promise<StartInput> {
  if (!isObj(raw)) throw bad("the body is { space, parent_slug?, file_name, files, choices? }");
  const space = typeof raw.space === "string" ? raw.space.trim() : "";
  if (!space) throw bad("space is required");
  const state = await spaceState(ctx, space);
  if (state === "unknown") throw new ImportError("not_found", 404, "there is no such space");
  if (state === "archived") throw new ImportError("archived", 409, "restore the space before importing into it");
  const nodes = await all<DocTreeNode & { title: string }>(ctx, `SELECT slug, parent_slug, tree_rank, space, title FROM docs WHERE org_id = ?`, ctx.orgId);
  let parent: string | null = null;
  if (raw.parent_slug !== undefined && raw.parent_slug !== null && raw.parent_slug !== "") {
    if (typeof raw.parent_slug !== "string") throw bad("parent_slug is a page's slug");
    const p = nodes.find((n) => n.slug === (raw.parent_slug as string).trim());
    if (!p || p.space !== space) throw new ImportError("not_found", 404, "that page is not in this space");
    parent = p.slug;
  }
  const fileName = cleanFileName(raw.file_name);
  const fileSize = typeof raw.file_size === "number" && Number.isInteger(raw.file_size) && raw.file_size >= 0 ? raw.file_size : null;
  const input = parseFiles(raw.files);
  const choices = parseChoices(raw.choices);

  // The SAME planner the Preview ran, against the org's own pages: the target space's titles (conflicts) and every
  // slug of the org (a slug is never reused).
  const existingTitles = new Map<string, string>();
  for (const n of nodes) if (n.space === space && n.title) {
    const k = n.title.trim().toLowerCase();
    if (!existingTitles.has(k)) existingTitles.set(k, n.slug);
  }
  const existingSlugs = new Set(nodes.map((n) => n.slug));
  const parentDepth = parent ? depthOf(buildTree(nodes), parent) : 0;
  const plan = planImport(input, { existingTitles, existingSlugs, parentSlug: parent, parentDepth });
  if (plan.error === "too_many_files") throw new ImportError("too_many_files", 413, `an import is at most ${MAX_FILES} files`);
  if (plan.error === "too_large") throw new ImportError("too_large", 413, `an import is at most ${MAX_TOTAL_BYTES / (1024 * 1024)} MB`);
  if (plan.error === "no_markdown") throw new ImportError("no_markdown", 400, "there is no Markdown file to import");

  const writes = applyConflictChoices(plan, choices, fileName);
  const pageOf = new Map(plan.pages.map((p) => [p.key, p]));
  const links: [string, string][] = [];
  for (const w of writes) {
    const p = pageOf.get(w.key);
    if (p?.path) links.push([p.path, w.slug]);
    if (p?.folder) links.push([p.folder, w.slug]);
  }
  const accepted = new Set(plan.pages.map((p) => p.path).filter((x): x is string => !!x));
  const imagePaths = new Set(plan.images.map((i) => i.path));
  const files: Manifest["files"] = [];
  for (const f of input) {
    const chk = normalizeImportPath(f.path);
    if (!chk.ok) continue;
    if (accepted.has(chk.path)) files.push({ path: chk.path, size: f.size, title: f.title ?? null });
    else if (imagePaths.has(chk.path)) files.push({ path: chk.path, size: f.size });
  }
  const manifest: Manifest = { file_size: fileSize, files, choices, writes, links, images: [...imagePaths] };
  const counts: ImportCounts = {
    ...zeroImportCounts(),
    pages: writes.filter((w) => w.mode !== "skip").length,
    new_pages: writes.filter((w) => w.mode === "new").length,
    versions: writes.filter((w) => w.mode === "version").length,
    images: plan.images.length,
    skipped_files: plan.skipped.length,
    skipped_pages: writes.filter((w) => w.mode === "skip").length,
  };
  const failures: ImportFailure[] = plan.skipped.map((s) => ({ path: s.path, code: s.code }));

  const held = await liveRow(ctx, now);
  if (held) throw new ImportError("import_running", 409, "another import is in progress in this organization", (await views(ctx, [held], now))[0]);
  return {
    space, parent, fileName, fileSize, fileCount: input.length, manifest, counts, failures,
    plan: { writes, skipped: plan.skipped, conflicts: plan.conflicts, images: plan.images },
  };
}

/** Start the run (the route has taken the rate limit): take the lock and write the run with the server's plan. */
export async function startImport(ctx: TenantContext, by: string, input: StartInput, now: number = Date.now()): Promise<{ run: ImportRunView; plan: ImportPlanView }> {
  const at = new Date(now).toISOString();
  const staleBefore = new Date(now - IMPORT_STALE_MS).toISOString();
  // `file_count` is what the person picked, not what was accepted: kept beside `files`.
  const stored = { ...input.manifest, file_count: input.fileCount };
  const took = await run(ctx,
    `INSERT INTO doc_imports (org_id, space_slug, parent_slug, file_name, started_by, started_at, updated_at, status, counts, failures, total, manifest)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?6, 'running', ?7, ?8, ?9, ?10
      WHERE NOT EXISTS (SELECT 1 FROM doc_imports WHERE org_id = ?1 AND status = 'running' AND updated_at > ?11)`,
    ctx.orgId, input.space, input.parent, input.fileName, by, at, JSON.stringify(input.counts), JSON.stringify(input.failures), input.counts.pages,
    JSON.stringify(stored), staleBefore);
  if (!took.meta.changes) {
    const held = await liveRow(ctx, now);
    throw new ImportError("import_running", 409, "another import is in progress in this organization", held ? (await views(ctx, [held], now))[0] : undefined);
  }
  const id = Number(took.meta.last_row_id);
  // Whatever an earlier run left `running` and never finished reads as abandoned already; say so on the row.
  await run(ctx, `UPDATE doc_imports SET status = 'abandoned', ended_at = updated_at WHERE org_id = ? AND status = 'running' AND id <> ? AND updated_at <= ?`,
    ctx.orgId, id, staleBefore).catch(() => undefined);
  return { run: await viewOf(ctx, id, now), plan: input.plan };
}

// ── the run a later request continues ────────────────────────────────────────

interface LiveRun { row: RunRow; manifest: Manifest; images: Map<string, string> }

/** The run, still running and heard from, and its starter's — else the refusal. */
async function ownLiveRun(ctx: TenantContext, id: number, by: string, now: number): Promise<LiveRun> {
  const row = await first<RunRow & { manifest: string; images: string }>(ctx,
    `SELECT ${COLS}, i.manifest AS manifest, i.images AS images ${FROM} WHERE i.org_id = ? AND i.id = ?`, ctx.orgId, id);
  if (!row) throw new ImportError("not_found", 404, "there is no such import");
  if (row.status !== "running" || isStale(row, now)) throw new ImportError("not_running", 409, "this import has ended");
  if (row.started_by.toLowerCase() !== by.toLowerCase()) throw new ImportError("forbidden", 403, "only the person who started an import can add to it");
  const pairs = parsed<[string, string][]>(row.images, []);
  return { row, manifest: parsed<Manifest>(row.manifest, { file_size: null, files: [], choices: {}, writes: [], links: [], images: [] }), images: new Map(Array.isArray(pairs) ? pairs : []) };
}

/** The heartbeat (and anything else that changed). Only a `running` row is updated: an ended run is never revived. */
async function report(ctx: TenantContext, id: number, set: { counts?: ImportCounts; failures?: ImportFailure[]; status?: ImportRunStatus; ended_at?: string }, now: number): Promise<void> {
  const cols: string[] = [];
  const vals: unknown[] = [];
  if (set.counts) { cols.push("counts = ?"); vals.push(JSON.stringify(set.counts)); }
  if (set.failures) { cols.push("failures = ?"); vals.push(JSON.stringify(set.failures.slice(0, MAX_FILES + 1))); }
  if (set.status) { cols.push("status = ?"); vals.push(set.status); }
  if (set.ended_at) { cols.push("ended_at = ?"); vals.push(set.ended_at); }
  await run(ctx, `UPDATE doc_imports SET updated_at = ?${cols.map((c) => `, ${c}`).join("")} WHERE org_id = ? AND id = ? AND status = 'running'`,
    new Date(now).toISOString(), ...vals, ctx.orgId, id);
}

/** The keys page outcomes are stored under: a page's Markdown path, or a folder page's key. A plan skip is about a
 *  file that is never sent, so the two never share a path. */
const pagePaths = (m: Manifest): Set<string> => new Set(m.writes.filter((w) => w.mode !== "skip").map((w) => w.path ?? w.key));

/** What reached Review so far, read back from doc_versions (a retry never counts a page twice). */
async function freshCounts(ctx: TenantContext, id: number, base: ImportCounts, failures: ImportFailure[], images: Map<string, string>, pages: Set<string>): Promise<ImportCounts> {
  const r = await first<{ staged: number; staged_new: number | null }>(ctx,
    `SELECT COUNT(*) AS staged, SUM(CASE WHEN version = 1 THEN 1 ELSE 0 END) AS staged_new FROM doc_versions WHERE org_id = ? AND import_id = ?`, ctx.orgId, id);
  const staged = r?.staged ?? 0;
  const stagedNew = r?.staged_new ?? 0;
  const pageCodes = failures.filter((f) => f.path !== null && pages.has(f.path));
  return {
    ...base, staged, staged_new: stagedNew, staged_versions: staged - stagedNew,
    unchanged: pageCodes.filter((f) => f.code === "unchanged").length,
    failed: pageCodes.filter((f) => f.code !== "unchanged").length,
    images_uploaded: images.size,
  };
}

// ── images ───────────────────────────────────────────────────────────────────

export type UploadedImage = { size: number; arrayBuffer(): Promise<ArrayBuffer> };

/** `POST /imports/:id/images`: one image of the manifest. */
export async function uploadImportImage(
  ctx: TenantContext, bucket: R2Bucket, id: number, by: string, rawPath: unknown, file: UploadedImage | null, now: number = Date.now(),
): Promise<{ path: string; sha: string }> {
  const live = await ownLiveRun(ctx, id, by, now);
  const chk = normalizeImportPath(typeof rawPath === "string" ? rawPath : "");
  if (!chk.ok) throw new ImportError("bad_path", 400, "that path is not allowed");
  if (!live.manifest.images.includes(chk.path)) throw new ImportError("not_in_manifest", 400, "that image is not one this import listed");
  if (!file) throw bad("a `file` part is required");
  const declared = live.manifest.files.find((f) => f.path === chk.path)?.size ?? 0;
  if (file.size === 0) throw bad("the file is empty");
  if (file.size > MAX_IMAGE_BYTES || file.size > declared) throw new ImportError("too_large", 413, "the image is larger than the import said it was (or than 10 MB)");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > MAX_IMAGE_BYTES || bytes.byteLength > declared) throw new ImportError("too_large", 413, "the image is larger than the import said it was (or than 10 MB)");
  const type = sniffAvatarType(bytes);
  if (!type) throw new ImportError("not_an_image", 400, "the file is not a PNG, JPEG, GIF or WebP image");
  const sha = await sha256Hex(bytes);
  const key = docImageKey(sha);
  if (!(await bucket.head(key))) await bucket.put(key, bytes, { sha256: sha, httpMetadata: { contentType: type } });
  const at = new Date(now).toISOString();
  await batch(ctx, [
    stmt(ctx, `INSERT OR IGNORE INTO doc_images (org_id, sha256, content_type, size_bytes, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ctx.orgId, sha, type, bytes.byteLength, by, at),
    stmt(ctx, `UPDATE doc_imports SET images = json_insert(images, '$[#]', json_array(?, ?)), updated_at = ? WHERE org_id = ? AND id = ? AND status = 'running'`,
      chk.path, sha, at, ctx.orgId, id),
  ]);
  return { path: chk.path, sha };
}

// ── pages ────────────────────────────────────────────────────────────────────

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const utf8Length = (s: string): number => new TextEncoder().encode(s).byteLength;

interface SentPage { index: number; write: ImportWrite; path: string; text: string }

/** The batch, checked as a whole: every entry is a page of the plan (a Markdown path, or a folder page's key).
 *  Anything else refuses the batch and nothing is written. */
function checkBatch(raw: unknown, m: Manifest): SentPage[] {
  const list = isObj(raw) ? raw.pages : undefined;
  if (!Array.isArray(list) || list.length === 0) throw bad("pages is a list of { path, text }");
  if (list.length > IMPORT_PAGES_PER_BATCH) throw new ImportError("too_many_pages", 400, `send at most ${IMPORT_PAGES_PER_BATCH} pages at a time`);
  const byPath = new Map<string, number>();
  const byKey = new Map<string, number>();
  m.writes.forEach((w, i) => { byKey.set(w.key, i); if (w.path) byPath.set(w.path, i); });
  return list.map((p, n) => {
    if (!isObj(p) || typeof p.path !== "string" || typeof p.text !== "string") throw bad(`pages[${n}] is { path, text }`);
    if (p.path.endsWith("/")) {
      const index = byKey.get(p.path);
      if (index === undefined || m.writes[index].path !== null) throw new ImportError("not_in_manifest", 400, `${p.path.slice(0, 120)} is not a page of this import`);
      return { index, write: m.writes[index], path: p.path, text: "" };
    }
    const chk = normalizeImportPath(p.path);
    if (!chk.ok) throw new ImportError("bad_path", 400, `${chk.path.slice(0, 120)} is not an allowed path`);
    if (importKind(chk.path) !== "md") throw new ImportError("not_markdown", 400, `${chk.path.slice(0, 120)} is not a Markdown file`);
    const index = byPath.get(chk.path);
    if (index === undefined) throw new ImportError("not_in_manifest", 400, `${chk.path.slice(0, 120)} is not a page of this import`);
    return { index, write: m.writes[index], path: chk.path, text: p.text };
  });
}

/** `POST /imports/:id/pages`: each page re-validated, prepared, and sent into the gate. */
export async function sendImportPages(ctx: TenantContext, id: number, by: string, raw: unknown, now: number = Date.now()): Promise<{ run: ImportRunView; results: ImportPageResult[] }> {
  const live = await ownLiveRun(ctx, id, by, now);
  const m = live.manifest;
  const pages = checkBatch(raw, m);
  await report(ctx, id, {}, now);   // the heartbeat, before the work

  const session = `import:${id}`;
  const ledger = new Map((await all<{ item_index: number; outcome: string }>(ctx,
    `SELECT item_index, outcome FROM processed_items WHERE org_id = ? AND session_id = ?`, ctx.orgId, session)).map((r) => [r.item_index, r.outcome]));
  const spaceSlugs = new Set((await all<{ slug: string }>(ctx, `SELECT slug FROM docs WHERE org_id = ? AND space = ?`, ctx.orgId, live.row.space_slug)).map((r) => r.slug));
  const mine = new Set((await all<{ slug: string }>(ctx, `SELECT DISTINCT slug FROM doc_versions WHERE org_id = ? AND import_id = ?`, ctx.orgId, id)).map((r) => r.slug));
  const fileOf = new Map(m.files.map((f) => [f.path, f]));
  const writeBySlug = new Map(m.writes.filter((w) => w.mode === "new").map((w) => [w.slug, w]));
  const links = new Map(m.links);
  // One outcome per page, the latest: a page that failed and then went through on a retry is no longer listed.
  const planned = pagePaths(m);
  const kept = parsed<ImportFailure[]>(live.row.failures, []).filter((f) => f.path === null || !planned.has(f.path));
  const outcomes = new Map(parsed<ImportFailure[]>(live.row.failures, []).filter((f) => f.path !== null && planned.has(f.path)).map((f) => [f.path as string, f]));
  const settle = (path: string, code: ImportPageCode | null) => {
    if (code) outcomes.set(path, { path, code }); else outcomes.delete(path);
  };

  // The nearest place a page may go: its planned parent if that page exists, else the parent's own parent … else the
  // run's parent. A page whose parent failed is never stranded at the top of the space.
  const placeFor = (w: Extract<ImportWrite, { mode: "new" }>): string | null => {
    let p = w.parent_slug;
    for (let hops = 0; p && hops < 32; hops++) {
      if (spaceSlugs.has(p) || p === live.row.parent_slug) return p;
      p = writeBySlug.get(p)?.parent_slug ?? live.row.parent_slug;
    }
    return p && spaceSlugs.has(p) ? p : live.row.parent_slug;
  };

  const results: ImportPageResult[] = [];
  for (const pg of pages) {
    const w = pg.write;
    const out = (outcome: ImportPageResult["outcome"], code?: ImportPageCode, extra: Partial<ImportPageResult> = {}): void => {
      results.push({ path: pg.path, outcome, ...(code ? { code } : {}), ...extra });
      settle(pg.path, outcome === "failed" || outcome === "unchanged" ? (code ?? "unchanged") : null);
    };
    if (w.mode === "skip") { out("skipped"); continue; }

    // A retry: the gate's ledger already holds this page's outcome — say it again, write nothing.
    const done = ledger.get(pg.index);
    if (done === "staged") { out("staged", undefined, { slug: w.slug }); continue; }
    if (done === "unchanged") { out("unchanged", "unchanged", { slug: w.slug }); continue; }
    if (done === "triaged") { out("failed", "triaged"); continue; }

    let body = "";
    if (w.path !== null) {
      const file = fileOf.get(w.path);
      if (LONE_SURROGATE.test(pg.text)) { out("failed", "not_utf8"); continue; }
      const bytes = utf8Length(pg.text);
      if (bytes > MAX_MD_BYTES) { out("failed", "too_large"); continue; }
      if (!file || bytes > file.size || (titleFromMarkdown(pg.text) ?? null) !== (file.title ?? null)) { out("failed", "changed"); continue; }
      const prepared = prepareBody(pg.text, { path: w.path, pathToSlug: links, imagePathToSha: live.images });
      if (prepared.empty) { out("failed", "empty"); continue; }
      body = prepared.body;
    }
    if (w.mode === "new" && spaceSlugs.has(w.slug) && !mine.has(w.slug)) { out("failed", "slug_taken"); continue; }
    if (w.mode === "version" && !spaceSlugs.has(w.slug)) {
      // The page a new version was planned for is gone from the space (moved by a re-proposal, or never there).
      out("failed", "slug_taken");
      continue;
    }
    try {
      const parent = w.mode === "new" ? placeFor(w) : null;
      const res = await ingestDocProposal(ctx, {
        slug: w.slug, section: "reference", ...(w.mode === "new" ? { title: w.title } : {}),
        body, change_summary: `Imported from ${live.row.file_name}${w.path ? ` (${w.path})` : ""}`,
        confidence: "high", space: live.row.space_slug, ...(parent ? { parent_slug: parent } : {}),
      }, by, { sessionId: session, itemIndex: pg.index }, { importId: id, importPath: w.path ?? w.key });
      if (res.outcome === "written") {
        spaceSlugs.add(res.slug);
        mine.add(res.slug);
        out("staged", undefined, { slug: res.slug, version: res.version });
      } else if (res.outcome === "unchanged") out("unchanged", "unchanged", { slug: w.slug });
      else if (res.outcome === "triaged") out("failed", "triaged");
      else out("failed", "refused");
    } catch (e) {
      console.error("import page failed", e instanceof Error ? e.name : "error", `org=${ctx.orgId}`);
      out("failed", "failed");
    }
  }

  const list = [...kept, ...outcomes.values()];
  const base = { ...zeroImportCounts(), ...parsed<Partial<ImportCounts>>(live.row.counts, {}) };
  const counts = await freshCounts(ctx, id, base, list, live.images, planned);
  await report(ctx, id, { counts, failures: list }, Date.now() > now ? Date.now() : now);
  return { run: await viewOf(ctx, id, now), results };
}

// ── finish ───────────────────────────────────────────────────────────────────

/** `POST /imports/:id/finish`: `{ cancel: true }` stops it (the starter or an admin); else the starter ends it. */
export async function finishImport(ctx: TenantContext, id: number, by: string, raw: unknown, now: number = Date.now()): Promise<ImportRunView> {
  const cancel = isObj(raw) && raw.cancel === true;
  const row = await first<RunRow & { manifest: string; images: string }>(ctx,
    `SELECT ${COLS}, i.manifest AS manifest, i.images AS images ${FROM} WHERE i.org_id = ? AND i.id = ?`, ctx.orgId, id);
  if (!row) throw new ImportError("not_found", 404, "there is no such import");
  if (row.status !== "running" || isStale(row, now)) throw new ImportError("not_running", 409, "this import has ended");
  const starter = row.started_by.toLowerCase() === by.toLowerCase();
  if (!starter && !(cancel && hasRole(ctx, "admin"))) throw new ImportError("forbidden", 403, "only the person who started an import can end it");
  const m = parsed<Manifest>(row.manifest, { file_size: null, files: [], choices: {}, writes: [], links: [], images: [] });
  const pairs = parsed<[string, string][]>(row.images, []);
  const images = new Map(Array.isArray(pairs) ? pairs : []);
  const failures = parsed<ImportFailure[]>(row.failures, []);
  const base = { ...zeroImportCounts(), ...parsed<Partial<ImportCounts>>(row.counts, {}) };
  const at = new Date(now).toISOString();
  const pages = pagePaths(m);

  if (cancel) {
    const list = [...failures, { path: null, code: "cancelled" as const }];
    const counts = await freshCounts(ctx, id, base, list, images, pages);
    await report(ctx, id, { counts, failures: list, status: "abandoned", ended_at: at }, now);
    return viewOf(ctx, id, now);
  }

  // A page of the plan that was never sent (nor skipped) did not reach Review: it is listed as failed.
  const staged = new Set((await all<{ import_path: string }>(ctx,
    `SELECT DISTINCT import_path FROM doc_versions WHERE org_id = ? AND import_id = ?`, ctx.orgId, id)).map((r) => r.import_path));
  const told = new Set(failures.filter((f) => f.path !== null && pages.has(f.path)).map((f) => f.path as string));
  const list = [...failures];
  for (const path of pages) if (!staged.has(path) && !told.has(path)) list.push({ path, code: "failed" });
  const counts = await freshCounts(ctx, id, base, list, images, pages);
  const status: ImportRunStatus = counts.staged === 0 && counts.failed > 0 ? "failed"
    : counts.failed > 0 || counts.skipped_files > 0 ? "partial" : "done";
  await report(ctx, id, { counts, failures: list, status, ended_at: at }, now);
  return viewOf(ctx, id, now);
}

// ── Review: an import's pages all at once ────────────────────────────────────

interface Target { id: number; slug: string; version: number }

/** The import's versions still waiting: staged, the doc's newest staged one, newer than its live version — in the
 *  order they were staged (parents first). A newer change on top of one (an agent's) is what Review shows, so the
 *  import's own is left alone. */
const waitingTargets = (ctx: TenantContext, id: number, limit: number): Promise<Target[]> =>
  all<Target>(ctx,
    `SELECT v.id AS id, v.slug AS slug, v.version AS version FROM doc_versions v JOIN docs d ON d.org_id = ? AND d.slug = v.slug
      WHERE v.org_id = ? AND v.import_id = ? AND v.status = 'staged' AND v.version > d.current_version
        AND v.version = (SELECT MAX(w.version) FROM doc_versions w WHERE w.org_id = ? AND w.slug = v.slug AND w.status = 'staged')
      ORDER BY v.id LIMIT ${limit}`, ctx.orgId, ctx.orgId, id, ctx.orgId);

async function waitingCount(ctx: TenantContext, id: number): Promise<number> {
  const r = await first<{ n: number }>(ctx,
    `SELECT COUNT(*) AS n FROM doc_versions v JOIN docs d ON d.org_id = ? AND d.slug = v.slug
      WHERE v.org_id = ? AND v.import_id = ? AND v.status = 'staged' AND v.version > d.current_version
        AND v.version = (SELECT MAX(w.version) FROM doc_versions w WHERE w.org_id = ? AND w.slug = v.slug AND w.status = 'staged')`,
    ctx.orgId, ctx.orgId, id, ctx.orgId);
  return r?.n ?? 0;
}

async function runSpace(ctx: TenantContext, id: number): Promise<{ space: string; space_name: string | null }> {
  const r = await first<{ space_slug: string; name: string | null }>(ctx,
    `SELECT i.space_slug AS space_slug, s.name AS name FROM doc_imports i LEFT JOIN doc_spaces s ON s.org_id = i.org_id AND s.slug = i.space_slug
      WHERE i.org_id = ? AND i.id = ?`, ctx.orgId, id);
  if (!r) throw new ImportError("not_found", 404, "there is no such import");
  return { space: r.space_slug, space_name: r.name };
}

/** "Approve all": promote the import's waiting pages through the promote writer (links and parents apply), at most
 *  `IMPORT_APPROVE_PER_CALL` a call. Any signed-in member, like a single promote. */
export async function approveImport(ctx: TenantContext, id: number, by: string): Promise<{ done: number; remaining: number; space: string; space_name: string | null }> {
  const where = await runSpace(ctx, id);
  let done = 0;
  for (const t of await waitingTargets(ctx, id, IMPORT_APPROVE_PER_CALL)) {
    try {
      await promote_doc(ctx, t.slug, t.version, by);
      done++;
    } catch (e) {
      console.error("import approve failed", e instanceof Error ? e.name : "error", `org=${ctx.orgId}`);
    }
  }
  return { done, remaining: await waitingCount(ctx, id), ...where };
}

/** "Reject all": soft — each waiting version flips to `rejected` (restorable, its body kept), its open risk closed,
 *  at most `IMPORT_REJECT_PER_CALL` a call. */
export async function rejectImport(ctx: TenantContext, id: number): Promise<{ done: number; remaining: number; space: string; space_name: string | null }> {
  const where = await runSpace(ctx, id);
  const targets = await waitingTargets(ctx, id, IMPORT_REJECT_PER_CALL);
  if (targets.length) {
    const stmts: Stmt[] = [];
    for (const t of targets) {
      stmts.push(stmt(ctx, `UPDATE doc_versions SET status = 'rejected' WHERE org_id = ? AND id = ? AND status = 'staged'`, ctx.orgId, t.id));
      stmts.push(supersedeOpenSuggestions(ctx, REVIEW_ITEM, reviewRef.doc(t.slug, t.version)));
    }
    await batch(ctx, stmts);
  }
  return { done: targets.length, remaining: await waitingCount(ctx, id), ...where };
}


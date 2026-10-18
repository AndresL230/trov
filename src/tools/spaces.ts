// The Docs Library's spaces (0081_docs_library; docs/architecture/docs-library.md › Spaces).
//
// An org's Library is a list of SPACES (`doc_spaces`), each holding pages (`docs.space` = its slug). Callers:
//   • an ADMIN creates, renames, re-icons, archives and restores a space — `adminOnly` (`hasRole(ctx, "admin")`, refused in words that say what only an admin may do)
//     in each writer here, its `org_admin_audit` row in the SAME batch, reached only from the cookie routes
//     (src/spaces/routes.ts), never from src/mcp.ts;
//   • an admin OR AN OWNER of the space edits its description and its owners (`requireSpaceEditor`);
//   • any MEMBER reads the Library (`readLibrary`) and a space's home (`readSpaceHome`), and shapes their OWN view of
//     it — their sidebar's spaces, pinned and hidden cards (`saveLibraryPrefs`, `library_prefs`); an agent reads the live
//     spaces through MCP `list_spaces` (`listSpacesForAgent`);
//   • the GATE (src/consumer.ts `ingestDocProposal`) asks `spaceState` whether a proposal's space is a live one.
// A space is never hard-deleted: archive is soft and restorable, and a slug is reserved forever.
import {
  NEW_SPACE_COLOR, NEW_SPACE_ICON, SPACE_COLORS, SPACE_ICONS, STARTER_SPACES, checkLibraryPrefs, cleanSpaceDescription, cleanSpaceName,
  isSpaceColor, isSpaceIcon, liveLibraryPrefs, pageAuthority, pageSummary, rankAfterAll, spaceNamedLike, spaceOrder, spaceSlugFromName, uniqueSpaceSlug,
  type ArchivedPageDTO, type LibraryDTO, type LibraryPrefsDTO, type LibraryPageDTO, type SpaceAuditAction, type SpaceColor, type SpaceDTO, type SpaceErrorCode, type SpaceHomeDTO, type SpaceIcon,
} from "@shared/docs-core";
import { buildTree, childrenOf } from "@shared/docs-tree-core";
import { hasRole } from "../data/context";
import { all, batch, first, nowIso, stmt, type Stmt, type TenantContext } from "../data/sql";

/** A refused space write. `message` is fixed text: it names the rule, never more than the space's own name. */
export class SpaceError extends Error {
  constructor(readonly code: SpaceErrorCode, readonly status: 400 | 403 | 404 | 409, message: string, readonly field?: string) {
    super(message);
    this.name = "SpaceError";
  }
}

interface SpaceRow {
  slug: string; name: string; icon: string; color: string; description: string; sort_rank: number | null;
  archived_at: string | null; archived_by: string | null; created_at: string; created_by: string;
}
const COLS = `slug, name, icon, color, description, sort_rank, archived_at, archived_by, created_at, created_by`;

interface PageRow {
  slug: string; title: string; space: string; section: string; parent_slug: string | null; tree_rank: number | null;
  current_version: number; updated_at: string | null; updated_by: string | null; owner: string | null; staged: number | null;
}

const auditStmt = (ctx: TenantContext, action: SpaceAuditAction, target: string, detail: Record<string, unknown>, at: string): Stmt =>
  stmt(ctx, `INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at) VALUES (?, ?, ?, ?, ?, ?)`,
    ctx.orgId, ctx.userId, action, target, JSON.stringify(detail), at);

/** The three starter spaces, as statements for `ctx`'s org — what src/orgs/repo.ts `createOrg` puts in the batch
 *  that creates an org (0081 did the same for the orgs that existed then). */
export function starterSpaceStmts(ctx: TenantContext, at: string): Stmt[] {
  return STARTER_SPACES.map((s) => stmt(ctx,
    `INSERT OR IGNORE INTO doc_spaces (org_id, slug, name, icon, color, description, sort_rank, created_at, created_by) VALUES (?, ?, ?, ?, ?, '', ?, ?, 'system')`,
    ctx.orgId, s.slug, s.name, s.icon, s.color, s.sort_rank, at));
}

// ── reads ────────────────────────────────────────────────────────────────────

const spaceRows = async (ctx: TenantContext): Promise<SpaceRow[]> =>
  (await all<SpaceRow>(ctx, `SELECT ${COLS} FROM doc_spaces WHERE org_id = ?`, ctx.orgId)).sort(spaceOrder);

const spaceRow = (ctx: TenantContext, slug: string): Promise<SpaceRow | null> =>
  first<SpaceRow>(ctx, `SELECT ${COLS} FROM doc_spaces WHERE org_id = ? AND slug = ?`, ctx.orgId, slug);

async function ownersOf(ctx: TenantContext, slug?: string): Promise<Map<string, string[]>> {
  const rows = slug
    ? await all<{ space_slug: string; handle: string }>(ctx, `SELECT space_slug, handle FROM doc_space_owners WHERE org_id = ? AND space_slug = ? ORDER BY added_at ASC, handle ASC`, ctx.orgId, slug)
    : await all<{ space_slug: string; handle: string }>(ctx, `SELECT space_slug, handle FROM doc_space_owners WHERE org_id = ? ORDER BY added_at ASC, handle ASC`, ctx.orgId);
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.space_slug, [...(out.get(r.space_slug) ?? []), r.handle]);
  return out;
}

/** Every page of the org (or of one space) IN THE LIBRARY without its body, with its newest staged version. An
 *  archived page (0083_doc_archive) is left out: it is in no tree, no count and no list but its space's Archived pages. */
async function pageRows(ctx: TenantContext, space?: string): Promise<PageRow[]> {
  const sel = `SELECT d.slug, d.title, d.space, d.section, d.parent_slug, d.tree_rank, d.current_version, d.updated_at, d.updated_by, d.owner,
                      (SELECT MAX(v.version) FROM doc_versions v WHERE v.org_id = ? AND v.slug = d.slug AND v.status = 'staged') AS staged
                 FROM docs d WHERE d.org_id = ? AND d.archived_at IS NULL`;
  return space
    ? all<PageRow>(ctx, `${sel} AND d.space = ?`, ctx.orgId, ctx.orgId, space)
    : all<PageRow>(ctx, sel, ctx.orgId, ctx.orgId);
}

/** The titles above a page, top first, following `parent_slug` within the pages read (a missing parent or a
 *  loop ends the walk — the tree's rules are the tree PR's). */
function pathOf(page: PageRow, bySlug: Map<string, PageRow>): string[] {
  const out: string[] = [];
  const seen = new Set<string>([page.slug]);
  let at = page.parent_slug;
  while (at && !seen.has(at) && out.length < 32) {
    const p = bySlug.get(at);
    if (!p) break;
    out.unshift(p.title);
    seen.add(at);
    at = p.parent_slug;
  }
  return out;
}

function pageDto(p: PageRow, bySlug: Map<string, PageRow>): LibraryPageDTO {
  return {
    slug: p.slug, title: p.title, space: p.space, section: p.section, parent_slug: p.parent_slug, tree_rank: p.tree_rank,
    path: pathOf(p, bySlug), authority: pageAuthority(p.current_version, p.staged), current_version: p.current_version,
    updated_at: p.updated_at, updated_by: p.updated_by, owner: p.owner,
  };
}

/** Every page of the org (or of one space) as the Library lists it — metadata, place in the tree, status; never a
 *  body. The doc page's tree, links and backlinks resolve against it (src/tools/doc-tree.ts). */
export async function libraryPages(ctx: TenantContext, space?: string): Promise<LibraryPageDTO[]> {
  const pages = await pageRows(ctx, space);
  const bySlug = new Map(pages.map((p) => [p.slug, p]));
  return pages.map((p) => pageDto(p, bySlug));
}

const iconOf = (v: string): SpaceIcon => (isSpaceIcon(v) ? v : NEW_SPACE_ICON);
const colorOf = (v: string): SpaceColor => (isSpaceColor(v) ? (v.toLowerCase() as SpaceColor) : NEW_SPACE_COLOR);

function spaceDto(r: SpaceRow, owners: string[], pages: PageRow[]): SpaceDTO {
  return {
    slug: r.slug, name: r.name, icon: iconOf(r.icon), color: colorOf(r.color), description: r.description, sort_rank: r.sort_rank,
    created_at: r.created_at, created_by: r.created_by, archived: r.archived_at !== null, archived_at: r.archived_at, owners,
    pages: pages.length, waiting: pages.filter((p) => pageAuthority(p.current_version, p.staged) !== "live").length,
  };
}

const byUpdatedDesc = (a: { updated_at: string | null; slug: string }, b: { updated_at: string | null; slug: string }): number =>
  (b.updated_at ?? "").localeCompare(a.updated_at ?? "") || a.slug.localeCompare(b.slug);

/** `GET /spaces` — Library home and the sidebar's Library group. The archived spaces go to an admin only. */
export async function readLibrary(ctx: TenantContext): Promise<LibraryDTO> {
  const [rows, owners, pages, prefs] = await Promise.all([spaceRows(ctx), ownersOf(ctx), pageRows(ctx), prefsRow(ctx)]);
  const bySpace = new Map<string, PageRow[]>();
  for (const p of pages) bySpace.set(p.space, [...(bySpace.get(p.space) ?? []), p]);
  const dto = (r: SpaceRow) => spaceDto(r, owners.get(r.slug) ?? [], bySpace.get(r.slug) ?? []);
  const live = rows.filter((r) => r.archived_at === null);
  const admin = hasRole(ctx, "admin");
  const liveSlugs = new Set(live.map((r) => r.slug));
  const bySlug = new Map(pages.map((p) => [p.slug, p]));
  const spaces = live.map(dto);
  return {
    spaces,
    prefs: liveLibraryPrefs(prefs ?? { sidebar: null, pinned: "[]", hidden: "[]" }, liveSlugs),
    archived: admin ? rows.filter((r) => r.archived_at !== null).map(dto) : [],
    recent: pages.filter((p) => liveSlugs.has(p.space)).sort(byUpdatedDesc).slice(0, 6).map((p) => pageDto(p, bySlug)),
    waiting: spaces.reduce((n, s) => n + s.waiting, 0),
    can_admin: admin,
  };
}

/** `GET /spaces/:slug` — Space home: the space and EVERY page in it, staged-only ones included. Null when the
 *  org has no such space; an archived one is still read (its home offers an admin Restore). */
export async function readSpaceHome(ctx: TenantContext, slug: string): Promise<SpaceHomeDTO | null> {
  const row = await spaceRow(ctx, slug);
  if (!row) return null;
  const [owners, pages, archived] = await Promise.all([ownersOf(ctx, slug), pageRows(ctx, slug), archivedPages(ctx, slug)]);
  const bySlug = new Map(pages.map((p) => [p.slug, p]));
  const list = owners.get(slug) ?? [];
  const canEdit = hasRole(ctx, "admin") || list.some((h) => h.toLowerCase() === ctx.userId.toLowerCase());
  return {
    space: spaceDto(row, list, pages),
    pages: [...pages].sort(byUpdatedDesc).map((p) => pageDto(p, bySlug)),
    summaries: await topSummaries(ctx, slug, pages),
    archived_pages: archived,
    can_edit: canEdit,
    // Archive page / Restore (0083_doc_archive): the same people as `can_edit` — an admin or an owner of the space —
    // and never while the space itself is archived (its pages do not move).
    can_archive: canEdit && row.archived_at === null,
    can_admin: hasRole(ctx, "admin"),
  };
}

/** A space's archived pages (0083_doc_archive), the newest archived first: what its home's Archived pages list. */
async function archivedPages(ctx: TenantContext, space: string): Promise<ArchivedPageDTO[]> {
  return all<ArchivedPageDTO>(ctx,
    `SELECT slug, title, archived_at, archived_by, current_version FROM docs
      WHERE org_id = ? AND space = ? AND archived_at IS NOT NULL ORDER BY archived_at DESC, slug ASC`, ctx.orgId, space);
}

/** The card line of each page at the space's top level (as the forgiving tree draws it), from the body it shows:
 *  the live body, or — never approved — its newest staged one. Derived on read, never stored (E2E SH2). */
async function topSummaries(ctx: TenantContext, space: string, pages: PageRow[]): Promise<Record<string, string>> {
  const tops = childrenOf(buildTree(pages), null, space).map((p) => p.slug);
  if (!tops.length) return {};
  const rows = await all<{ slug: string; body: string | null }>(ctx,
    `SELECT d.slug AS slug, CASE WHEN d.current_version > 0 THEN substr(d.body, 1, 4000)
            ELSE (SELECT substr(v.body, 1, 4000) FROM doc_versions v WHERE v.org_id = d.org_id AND v.slug = d.slug AND v.status = 'staged' ORDER BY v.version DESC LIMIT 1) END AS body
       FROM docs d WHERE d.org_id = ? AND d.space = ? AND d.slug IN (SELECT value FROM json_each(?))`,
    ctx.orgId, space, JSON.stringify(tops));
  const out: Record<string, string> = {};
  for (const r of rows) { const line = pageSummary(r.body ?? ""); if (line) out[r.slug] = line; }
  return out;
}

/** MCP `list_spaces`: the LIVE spaces an agent may place a page in — slug, name, description, page count. */
export async function listSpacesForAgent(ctx: TenantContext): Promise<{ spaces: { slug: string; name: string; description: string; pages: number }[] }> {
  const [rows, counts] = await Promise.all([
    spaceRows(ctx),
    all<{ space: string; n: number }>(ctx, `SELECT space, COUNT(*) AS n FROM docs WHERE org_id = ? AND archived_at IS NULL GROUP BY space`, ctx.orgId),
  ]);
  const n = new Map(counts.map((c) => [c.space, c.n]));
  return { spaces: rows.filter((r) => r.archived_at === null).map((r) => ({ slug: r.slug, name: r.name, description: r.description, pages: n.get(r.slug) ?? 0 })) };
}

/** What the gate needs to know about a space slug: `live`, `archived`, or `unknown` (no such space). */
export async function spaceState(ctx: TenantContext, slug: string): Promise<"live" | "archived" | "unknown"> {
  const r = await first<{ archived_at: string | null }>(ctx, `SELECT archived_at FROM doc_spaces WHERE org_id = ? AND slug = ?`, ctx.orgId, slug);
  return !r ? "unknown" : r.archived_at === null ? "live" : "archived";
}

/** The org's live space slugs (Triage › Unplaced's choices are read from the Library itself). */
export async function liveSpaceSlugs(ctx: TenantContext): Promise<string[]> {
  return (await spaceRows(ctx)).filter((r) => r.archived_at === null).map((r) => r.slug);
}

// ── writes ───────────────────────────────────────────────────────────────────

const invalid = (field: string, message: string) => new SpaceError("invalid", 400, message, field);
const NAME_RULE = "a space's name is 1–40 characters";
const DESCRIPTION_RULE = "a space's description is at most 140 characters";
const ICON_RULE = `a space's icon is one of: ${SPACE_ICONS.join(", ")}`;
const COLOR_RULE = `a space's color is one of: ${SPACE_COLORS.join(", ")}`;

async function existing(ctx: TenantContext, slug: unknown): Promise<SpaceRow> {
  const row = typeof slug === "string" ? await spaceRow(ctx, slug) : null;
  if (!row) throw new SpaceError("not_found", 404, "no such space");
  return row;
}

const isUniqueViolation = (e: unknown): boolean => e instanceof Error && /UNIQUE constraint failed/i.test(e.message);
const nameTaken = (name: string) => new SpaceError("name_taken", 409, `there's already a space called ${name}`, "name");

/** An admin-only write: refused with what only an admin may do, so a space's owner is never told "an owner can". */
function adminOnly(ctx: TenantContext, what: string): void {
  if (!hasRole(ctx, "admin")) throw new SpaceError("forbidden", 403, `only an admin can ${what}`);
}

/** Admin, or an owner of this space — who may change its description and its owners. */
async function requireSpaceEditor(ctx: TenantContext, slug: string): Promise<void> {
  if (hasRole(ctx, "admin")) return;
  const own = await first(ctx, `SELECT 1 AS x FROM doc_space_owners WHERE org_id = ? AND space_slug = ? AND handle = ? COLLATE NOCASE`, ctx.orgId, slug, ctx.userId);
  if (!own) throw new SpaceError("forbidden", 403, "only an admin, or an owner of this space, can change its description and owners");
}

async function dtoOf(ctx: TenantContext, slug: string): Promise<SpaceDTO> {
  const home = await readSpaceHome(ctx, slug);
  if (!home) throw new SpaceError("not_found", 404, "no such space");
  return home.space;
}

/** Create a space (admin+). The slug comes from the name (`-2`, `-3` … when a space ever had it); the creator is
 *  its first owner; it goes last in the Library. */
export async function createSpace(ctx: TenantContext, input: { name?: unknown; icon?: unknown; color?: unknown; description?: unknown }): Promise<SpaceDTO> {
  adminOnly(ctx, "create a space");
  const name = cleanSpaceName(input.name);
  if (!name) throw invalid("name", NAME_RULE);
  const icon = input.icon === undefined ? NEW_SPACE_ICON : input.icon;
  if (!isSpaceIcon(icon)) throw invalid("icon", ICON_RULE);
  const color = input.color === undefined ? NEW_SPACE_COLOR : input.color;
  if (!isSpaceColor(color)) throw invalid("color", COLOR_RULE);
  const description = cleanSpaceDescription(input.description);
  if (description === null) throw invalid("description", DESCRIPTION_RULE);
  const rows = await spaceRows(ctx);
  const clash = spaceNamedLike(rows.map((r) => ({ ...r, archived: r.archived_at !== null })), name);
  if (clash) throw nameTaken(clash.name);
  const slug = uniqueSpaceSlug(spaceSlugFromName(name), new Set(rows.map((r) => r.slug)));
  const at = nowIso();
  try {
    await batch(ctx, [
      stmt(ctx, `INSERT INTO doc_spaces (org_id, slug, name, icon, color, description, sort_rank, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ctx.orgId, slug, name, icon, color.toLowerCase(), description, rankAfterAll(rows), at, ctx.userId),
      stmt(ctx, `INSERT INTO doc_space_owners (org_id, space_slug, handle, added_at, added_by) VALUES (?, ?, ?, ?, ?)`, ctx.orgId, slug, ctx.userId, at, ctx.userId),
      auditStmt(ctx, "space.create", slug, { name }, at),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) throw nameTaken(name); // lost a race for the name (or the slug)
    throw e;
  }
  return dtoOf(ctx, slug);
}

/** Edit a space: its name, icon and color (admin+), its description (admin+ or one of its owners). */
export async function editSpace(ctx: TenantContext, slug: unknown, input: { name?: unknown; icon?: unknown; color?: unknown; description?: unknown }): Promise<SpaceDTO> {
  const row = await existing(ctx, slug);
  const adminFields = input.name !== undefined || input.icon !== undefined || input.color !== undefined;
  if (adminFields) adminOnly(ctx, "rename a space or change its icon or color");
  else await requireSpaceEditor(ctx, row.slug);
  const sets: string[] = [];
  const params: unknown[] = [];
  const fields: string[] = [];
  let renamed = row.name;
  if (input.name !== undefined) {
    const name = cleanSpaceName(input.name);
    if (!name) throw invalid("name", NAME_RULE);
    if (name !== row.name) {
      if (row.archived_at === null) {
        const rows = await spaceRows(ctx);
        const clash = spaceNamedLike(rows.map((r) => ({ ...r, archived: r.archived_at !== null })), name, row.slug);
        if (clash) throw nameTaken(clash.name);
      }
      sets.push("name = ?"); params.push(name); fields.push("name"); renamed = name;
    }
  }
  if (input.icon !== undefined) {
    if (!isSpaceIcon(input.icon)) throw invalid("icon", ICON_RULE);
    if (input.icon !== row.icon) { sets.push("icon = ?"); params.push(input.icon); fields.push("icon"); }
  }
  if (input.color !== undefined) {
    if (!isSpaceColor(input.color)) throw invalid("color", COLOR_RULE);
    const c = input.color.toLowerCase();
    if (c !== row.color) { sets.push("color = ?"); params.push(c); fields.push("color"); }
  }
  if (input.description !== undefined) {
    const d = cleanSpaceDescription(input.description);
    if (d === null) throw invalid("description", DESCRIPTION_RULE);
    if (d !== row.description) { sets.push("description = ?"); params.push(d); fields.push("description"); }
  }
  if (sets.length > 0) {
    const at = nowIso();
    try {
      await batch(ctx, [
        stmt(ctx, `UPDATE doc_spaces SET ${sets.join(", ")} WHERE org_id = ? AND slug = ?`, ...params, ctx.orgId, row.slug),
        auditStmt(ctx, "space.edit", row.slug, { fields }, at),
      ]);
    } catch (e) {
      if (isUniqueViolation(e)) throw nameTaken(renamed);
      throw e;
    }
  }
  return dtoOf(ctx, row.slug);
}

/** Replace a space's owners (admin+ or one of its owners). Every handle must be a member of the org; the list
 *  may be empty (a space with no owner is edited by the admins). */
export async function setSpaceOwners(ctx: TenantContext, slug: unknown, owners: unknown): Promise<SpaceDTO> {
  const row = await existing(ctx, slug);
  await requireSpaceEditor(ctx, row.slug);
  if (!Array.isArray(owners) || owners.length > 50 || owners.some((h) => typeof h !== "string" || !h.trim())) throw invalid("owners", "owners is a list of member handles");
  const wanted = [...new Set((owners as string[]).map((h) => h.trim().toLowerCase()))];
  const members = await all<{ user_id: string }>(ctx, `SELECT user_id FROM memberships WHERE org_id = ?`, ctx.orgId);
  const byLower = new Map(members.map((m) => [m.user_id.toLowerCase(), m.user_id]));
  const unknown = wanted.filter((h) => !byLower.has(h));
  if (unknown.length > 0) throw new SpaceError("not_member", 400, `not a member of this organization: ${unknown.join(", ")}`, "owners");
  const handles = wanted.map((h) => byLower.get(h) as string);
  const current = (await ownersOf(ctx, row.slug)).get(row.slug) ?? [];
  const at = nowIso();
  const keep = new Set(handles.map((h) => h.toLowerCase()));
  const had = new Set(current.map((h) => h.toLowerCase()));
  const stmts: Stmt[] = [];
  for (const h of current) if (!keep.has(h.toLowerCase())) stmts.push(stmt(ctx, `DELETE FROM doc_space_owners WHERE org_id = ? AND space_slug = ? AND handle = ?`, ctx.orgId, row.slug, h));
  for (const h of handles) if (!had.has(h.toLowerCase())) stmts.push(stmt(ctx, `INSERT OR IGNORE INTO doc_space_owners (org_id, space_slug, handle, added_at, added_by) VALUES (?, ?, ?, ?, ?)`, ctx.orgId, row.slug, h, at, ctx.userId));
  if (stmts.length > 0) await batch(ctx, [...stmts, auditStmt(ctx, "space.owners", row.slug, { owners: handles }, at)]);
  return dtoOf(ctx, row.slug);
}

// ── a person's own view of the Library ──────────────────────────────────────

interface PrefsRow { sidebar: string | null; pinned: string; hidden: string }
const prefsRow = (ctx: TenantContext): Promise<PrefsRow | null> =>
  first<PrefsRow>(ctx, `SELECT sidebar, pinned, hidden FROM library_prefs WHERE org_id = ? AND handle = ? COLLATE NOCASE`, ctx.orgId, ctx.userId);

/** Save the signed-in person's OWN view (any member; never anyone else's — the row is keyed by `ctx.userId`):
 *  `{ sidebar?: slug[] | null, pinned?: slug[], hidden?: slug[] }`, each list left out keeping what was saved. Every
 *  slug must be a live space of the org; the sidebar holds at most five; a space is never both pinned and hidden.
 *  Returns the view as it now reads. */
export async function saveLibraryPrefs(ctx: TenantContext, input: Record<string, unknown>): Promise<LibraryPrefsDTO> {
  const [rows, row] = await Promise.all([spaceRows(ctx), prefsRow(ctx)]);
  const live = new Set(rows.filter((r) => r.archived_at === null).map((r) => r.slug));
  const current = liveLibraryPrefs(row ?? { sidebar: null, pinned: "[]", hidden: "[]" }, live);
  const checked = checkLibraryPrefs(input, current, live);
  if (!checked.ok) throw invalid(checked.refusal.field, checked.refusal.message);
  const p = checked.prefs;
  await batch(ctx, [stmt(ctx,
    `INSERT INTO library_prefs (org_id, handle, sidebar, pinned, hidden, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (org_id, handle) DO UPDATE SET sidebar = excluded.sidebar, pinned = excluded.pinned, hidden = excluded.hidden, updated_at = excluded.updated_at`,
    ctx.orgId, ctx.userId, p.sidebar === null ? null : JSON.stringify(p.sidebar), JSON.stringify(p.pinned), JSON.stringify(p.hidden), nowIso())]);
  return p;
}

/** Archive a space (admin+): it leaves the Library and the sidebar and takes no new page; its pages stay, readable
 *  and searchable, and an edit of one still stages. Soft — `restoreSpace` brings it back. */
export async function archiveSpace(ctx: TenantContext, slug: unknown): Promise<SpaceDTO> {
  adminOnly(ctx, "archive a space");
  const row = await existing(ctx, slug);
  if (row.archived_at === null) {
    const at = nowIso();
    await batch(ctx, [
      stmt(ctx, `UPDATE doc_spaces SET archived_at = ?, archived_by = ? WHERE org_id = ? AND slug = ?`, at, ctx.userId, ctx.orgId, row.slug),
      auditStmt(ctx, "space.archive", row.slug, {}, at),
    ]);
  }
  return dtoOf(ctx, row.slug);
}

/** Restore an archived space (admin+). Refused when a live space has taken its name meanwhile — rename one first. */
export async function restoreSpace(ctx: TenantContext, slug: unknown): Promise<SpaceDTO> {
  adminOnly(ctx, "restore a space");
  const row = await existing(ctx, slug);
  if (row.archived_at !== null) {
    const rows = await spaceRows(ctx);
    const clash = spaceNamedLike(rows.map((r) => ({ ...r, archived: r.archived_at !== null })), row.name, row.slug);
    if (clash) throw nameTaken(clash.name);
    const at = nowIso();
    try {
      await batch(ctx, [
        stmt(ctx, `UPDATE doc_spaces SET archived_at = NULL, archived_by = NULL, sort_rank = ? WHERE org_id = ? AND slug = ?`,
          rankAfterAll(rows.filter((r) => r.archived_at === null)), ctx.orgId, row.slug),
        auditStmt(ctx, "space.restore", row.slug, {}, at),
      ]);
    } catch (e) {
      if (isUniqueViolation(e)) throw nameTaken(row.name);
      throw e;
    }
  }
  return dtoOf(ctx, row.slug);
}

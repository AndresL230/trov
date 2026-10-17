// The Docs Library's page tree and links (0081_docs_library; docs/architecture/docs-library.md › The page tree).
//
// The RULES are shared/docs-tree-core.ts (`planMove`, MAX_DEPTH …) and shared/docs-links-core.ts
// (`extractDocLinks`) — the SPA runs the same functions for its optimistic drop and its rendering. This module
// applies them to D1:
//   • `moveDoc` — `POST /doc/:slug/move` (cookie only, any signed-in member, src/routes.ts): a page goes into /
//     before / after another page of its OWN space, or to the end of the space's top level. The plan's renumber
//     is written in the SAME batch. A move is a person's direct write (the promote class): no gate, no staging,
//     and it never touches `updated_at` (a move is not an edit of the page).
//   • `checkParent` — the gate (`ingestDocProposal`) asks whether a proposal's `parent_slug` is a place the page
//     may go; an invalid one is IGNORED with a note in the result, never triaged.
//   • `promoteTreeStmts` — `promote_doc` (src/tools/writes.ts) puts these in its one batch: the page's
//     `doc_links` rebuilt from the body going live, and a staged version's requested parent applied when it is
//     still valid.
//   • `readDocPage` — `GET /doc/:slug`'s `page`: ancestors, children, links both ways, the rail.
import { MAX_DEPTH, ancestorsOf, buildTree, childrenOf, planMove, type DocTreeNode, type MoveRefusal, type MoveTarget } from "@shared/docs-tree-core";
import { extractDocLinks } from "@shared/docs-links-core";
import { pageAuthority, type DocMoveErrorCode, type DocMoveResult, type DocPageDTO, type DocPageRef, type DocTreePlace, type LibraryPageDTO } from "@shared/docs-core";
import type { DocRow } from "@shared/rows";
import { all, batch, first, stmt, type Stmt, type TenantContext } from "../data/sql";
import { libraryPages, spaceState } from "./spaces";
import { hasRole } from "../data/context";

export { MAX_DEPTH };

/** May the person archive and restore pages of `space` (0083_doc_archive)? An org admin, or an owner of the space —
 *  the same people who edit the space's description — and only while the space itself is live (its pages do not
 *  move). A token never reaches here: the routes are cookie-only and no MCP tool calls it. */
export async function mayArchiveIn(ctx: TenantContext, space: string): Promise<boolean> {
  return (await spaceState(ctx, space)) === "live" && (await isPageArchiver(ctx, space));
}

/** An org admin, or an owner of `space` (the role half of `mayArchiveIn`). */
export async function isPageArchiver(ctx: TenantContext, space: string): Promise<boolean> {
  if (hasRole(ctx, "admin")) return true;
  return !!(await first(ctx, `SELECT 1 AS x FROM doc_space_owners WHERE org_id = ? AND space_slug = ? AND handle = ? COLLATE NOCASE`, ctx.orgId, space, ctx.userId));
}

/** A refused move. `message` is fixed text naming the rule. */
export class DocTreeError extends Error {
  constructor(readonly code: DocMoveErrorCode, readonly status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = "DocTreeError";
  }
}

const REFUSAL_TEXT: Record<MoveRefusal, string> = {
  not_found: "there is no such page",
  self: "a page cannot go next to or inside itself",
  cycle: "a page cannot go inside a page that is under it",
  too_deep: `pages go at most ${MAX_DEPTH} levels deep`,
  other_space: "a page moves only within its own space",
};

/** Every page of a space IN THE LIBRARY as tree nodes (slug, parent, rank, title). An archived page
 *  (0083_doc_archive) is in no tree: nothing moves next to it, under it, or is placed under it. */
export const spaceNodes = (ctx: TenantContext, space: string): Promise<DocTreeNode[]> =>
  all<DocTreeNode>(ctx, `SELECT slug, parent_slug, tree_rank, space, title FROM docs WHERE org_id = ? AND space = ? AND archived_at IS NULL`, ctx.orgId, space);

/** The space of a page in the Library (null: no such page of the org, or it is archived). */
const docSpaceOf = async (ctx: TenantContext, slug: string): Promise<string | null> =>
  (await first<{ space: string }>(ctx, `SELECT space FROM docs WHERE org_id = ? AND slug = ? AND archived_at IS NULL`, ctx.orgId, slug))?.space ?? null;

const isArchivedDoc = async (ctx: TenantContext, slug: string): Promise<boolean> =>
  !!(await first(ctx, `SELECT 1 AS x FROM docs WHERE org_id = ? AND slug = ? AND archived_at IS NOT NULL`, ctx.orgId, slug));

export const placeStmt = (ctx: TenantContext, slug: string, parent: string | null, rank: number | null): Stmt =>
  stmt(ctx, `UPDATE docs SET parent_slug = ?, tree_rank = ? WHERE org_id = ? AND slug = ?`, parent, rank, ctx.orgId, slug);

/** The move route's body, or a 400. */
function parseTarget(raw: unknown): MoveTarget {
  const b = (raw && typeof raw === "object" ? raw : {}) as { target?: unknown; ref?: unknown };
  if (b.target === "top") return { kind: "top" };
  if (b.target === "into" || b.target === "before" || b.target === "after") {
    if (typeof b.ref !== "string" || !b.ref.trim()) throw new DocTreeError("invalid", 400, "ref (a page's slug) is required for into, before and after");
    return { kind: b.target, ref: b.ref.trim() };
  }
  throw new DocTreeError("invalid", 400, "target is one of: into, before, after, top");
}

/** Move a page (any signed-in member; a cookie route). Same-space only; the plan's renumber goes in the same batch. */
export async function moveDoc(ctx: TenantContext, slug: string, raw: unknown): Promise<DocMoveResult> {
  const target = parseTarget(raw);
  const space = await docSpaceOf(ctx, slug);
  if (space === null) {
    if (await isArchivedDoc(ctx, slug)) throw new DocTreeError("archived", 409, "this page is archived: restore it before moving it");
    throw new DocTreeError("not_found", 404, "there is no such page");
  }
  if ((await spaceState(ctx, space)) === "archived") throw new DocTreeError("archived", 409, "restore the space before moving its pages");
  const nodes = await spaceNodes(ctx, space);
  if (target.kind !== "top" && !nodes.some((n) => n.slug === target.ref)) {
    // Not in this space: a page of another space is `other_space`, nothing at all is `not_found`.
    const elsewhere = await docSpaceOf(ctx, target.ref);
    throw elsewhere === null ? new DocTreeError("not_found", 404, "there is no such page to move it to") : new DocTreeError("other_space", 409, REFUSAL_TEXT.other_space);
  }
  const plan = planMove(nodes, slug, target);
  if (!plan.ok) throw new DocTreeError(plan.reason, plan.reason === "not_found" ? 404 : 409, REFUSAL_TEXT[plan.reason]);
  const places: DocTreePlace[] = [{ slug, parent_slug: plan.parent_slug, tree_rank: plan.tree_rank }];
  const stmts: Stmt[] = [placeStmt(ctx, slug, plan.parent_slug, plan.tree_rank)];
  const parentOf = new Map(nodes.map((n) => [n.slug, n.parent_slug]));
  for (const [s, r] of plan.renumber ?? []) {
    stmts.push(stmt(ctx, `UPDATE docs SET tree_rank = ? WHERE org_id = ? AND slug = ?`, r, ctx.orgId, s));
    places.push({ slug: s, parent_slug: parentOf.get(s) ?? null, tree_rank: r });
  }
  await batch(ctx, stmts);
  return { ok: true, slug, parent_slug: plan.parent_slug, tree_rank: plan.tree_rank, places };
}

// ── a proposal's parent (the gate) ───────────────────────────────────────────

/** Why a proposal's parent was not taken. */
export type ParentRefusal = MoveRefusal;

export type ParentCheck =
  | { ok: true; parent_slug: string; tree_rank: number | null }
  | { ok: false; reason: ParentRefusal };

/**
 * May `slug` (a new page, or an existing one of `space`) go under `parent`? The same rules as a move ("into":
 * appended as the parent's last child). A NEW page takes the plan's rank only when the siblings needed no renumber
 * (else it has no rank yet, and sorts after the ranked ones) — the gate never writes another page's row.
 */
export async function checkParent(ctx: TenantContext, space: string, slug: string, parent: string): Promise<ParentCheck> {
  const p = parent.trim();
  if (!p) return { ok: false, reason: "not_found" };
  const nodes = await spaceNodes(ctx, space);
  if (!nodes.some((n) => n.slug === p)) return { ok: false, reason: (await docSpaceOf(ctx, p)) === null ? "not_found" : "other_space" };
  const withSelf = nodes.some((n) => n.slug === slug) ? nodes : [...nodes, { slug, parent_slug: null, tree_rank: null, space }];
  const plan = planMove(withSelf, slug, { kind: "into", ref: p });
  if (!plan.ok) return { ok: false, reason: plan.reason };
  return { ok: true, parent_slug: p, tree_rank: plan.renumber ? null : plan.tree_rank };
}

// ── promote: links and the requested parent ──────────────────────────────────

/** The statements that rebuild a page's `doc_links` from the body going live (a link to itself is not kept). */
export function linkStmts(ctx: TenantContext, slug: string, body: string): Stmt[] {
  const out: Stmt[] = [stmt(ctx, `DELETE FROM doc_links WHERE org_id = ? AND from_slug = ?`, ctx.orgId, slug)];
  for (const to of extractDocLinks(body).filter((t) => t !== slug).slice(0, 500)) {
    out.push(stmt(ctx, `INSERT OR IGNORE INTO doc_links (org_id, from_slug, to_slug) VALUES (?, ?, ?)`, ctx.orgId, slug, to));
  }
  return out;
}

/**
 * What promoting `slug` at a version that asked for `parent` writes besides the body: its links, and — when the
 * parent is still a valid place and is not where the page already is — the move under it (with any renumber).
 * An invalid parent leaves the tree as it is.
 */
export async function promoteTreeStmts(ctx: TenantContext, doc: Pick<DocRow, "slug" | "space" | "parent_slug">, body: string, parent: string | null): Promise<Stmt[]> {
  const out = linkStmts(ctx, doc.slug, body);
  if (!parent || parent === (doc.parent_slug ?? null)) return out;
  const nodes = await spaceNodes(ctx, doc.space);
  if (!nodes.some((n) => n.slug === parent)) return out;
  const plan = planMove(nodes, doc.slug, { kind: "into", ref: parent });
  if (!plan.ok) return out;
  out.push(placeStmt(ctx, doc.slug, plan.parent_slug, plan.tree_rank));
  for (const [s, r] of plan.renumber ?? []) out.push(stmt(ctx, `UPDATE docs SET tree_rank = ? WHERE org_id = ? AND slug = ?`, r, ctx.orgId, s));
  return out;
}

// ── the doc page's read ──────────────────────────────────────────────────────

interface ShownVersion { version: number; body: string; created_by: string; created_at: string; import_id: number | null; import_path: string | null }

/** `GET /doc/:slug`'s `page` for a doc that exists. Reads every page of the org once (no body) to resolve the tree,
 *  the links and the backlinks in memory — the Library's own read does the same. */
export async function readDocPage(ctx: TenantContext, doc: DocRow): Promise<DocPageDTO> {
  const [pages, shown, staged, back] = await Promise.all([
    libraryPages(ctx),
    doc.current_version > 0
      ? first<ShownVersion>(ctx, `SELECT version, body, created_by, created_at, import_id, import_path FROM doc_versions WHERE org_id = ? AND slug = ? AND version = ?`, ctx.orgId, doc.slug, doc.current_version)
      : first<ShownVersion>(ctx, `SELECT version, body, created_by, created_at, import_id, import_path FROM doc_versions WHERE org_id = ? AND slug = ? AND status = 'staged' ORDER BY version DESC LIMIT 1`, ctx.orgId, doc.slug),
    first<{ v: number | null }>(ctx, `SELECT MAX(version) AS v FROM doc_versions WHERE org_id = ? AND slug = ? AND status = 'staged'`, ctx.orgId, doc.slug),
    all<{ from_slug: string }>(ctx, `SELECT from_slug FROM doc_links WHERE org_id = ? AND to_slug = ?`, ctx.orgId, doc.slug),
  ]);
  const tree = buildTree<LibraryPageDTO>(pages);
  const body = doc.current_version > 0 ? doc.body : shown?.body ?? "";
  const ref = (p: LibraryPageDTO): DocPageRef => ({ slug: p.slug, title: p.title, space: p.space, path: ancestorsOf(tree, p.slug).map((a) => a.title), authority: p.authority });
  const linked = extractDocLinks(body).filter((s) => s !== doc.slug);
  const links: DocPageRef[] = [];
  const missing: string[] = [];
  for (const s of linked) {
    const p = tree.bySlug.get(s);
    if (p) links.push(ref(p)); else missing.push(s);
  }
  // A target that is no page in the Library is either ARCHIVED (0083_doc_archive: drawn as text marked "Archived") or
  // broken (no such page at all).
  const archivedTitles = missing.length
    ? new Map((await all<{ slug: string; title: string }>(ctx, `SELECT slug, title FROM docs WHERE org_id = ? AND archived_at IS NOT NULL AND slug IN (SELECT value FROM json_each(?))`, ctx.orgId, JSON.stringify(missing))).map((r) => [r.slug, r.title]))
    : new Map<string, string>();
  const broken = missing.filter((s) => !archivedTitles.has(s));
  const backlinks = back
    .map((b) => tree.bySlug.get(b.from_slug))
    .filter((p): p is LibraryPageDTO => !!p && p.current_version > 0 && p.slug !== doc.slug)
    .map(ref)
    .sort((a, b) => a.title.localeCompare(b.title));
  const importName = shown?.import_id != null
    ? (await first<{ file_name: string }>(ctx, `SELECT file_name FROM doc_imports WHERE org_id = ? AND id = ?`, ctx.orgId, shown.import_id))?.file_name ?? null
    : null;
  const pending = staged?.v != null && staged.v > doc.current_version ? staged.v : null;
  return {
    authority: pageAuthority(doc.current_version, staged?.v ?? null),
    parent_slug: tree.parentOf.get(doc.slug) ?? null,
    ancestors: ancestorsOf(tree, doc.slug).map((a) => ({ slug: a.slug, title: a.title })),
    children: childrenOf(tree, doc.slug, doc.space),
    body,
    links,
    broken_links: broken,
    archived_links: missing.filter((s) => archivedTitles.has(s)).map((s) => ({ slug: s, title: archivedTitles.get(s) as string })),
    backlinks,
    info: {
      owner: doc.owner,
      edited_by: shown?.created_by ?? doc.updated_by,
      edited_at: shown?.created_at ?? doc.updated_at,
      version: doc.current_version,
      pending_version: pending,
      imported_from: shown && shown.import_id != null && shown.import_path ? { path: shown.import_path, file_name: importName } : null,
    },
    archived: doc.archived_at ? { at: doc.archived_at, by: doc.archived_by ?? null } : null,
    can_archive: await mayArchiveIn(ctx, doc.space),
  };
}

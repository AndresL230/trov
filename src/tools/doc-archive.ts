// Archive page / Restore (0083_doc_archive; docs/architecture/docs-library.md › Archiving a page).
//
// A PERSON's write (Invariant 2: agents stage, humans confirm): reached ONLY from the cookie routes
// `POST /doc/:slug/archive` and `POST /doc/:slug/restore` (src/routes.ts, under `cookieOnly`). Never an MCP tool, and
// nothing reachable from src/mcp.ts imports this module (test/secrets.mcp.test.ts pins it). Who: an org admin, or an
// owner of the page's space (`mayArchiveIn`), while the space is live.
//
// Archive is SOFT (Invariant 11): `docs.archived_at` / `archived_by` are set; the row, its body and every version stay;
// its slug stays reserved. In the SAME batch its direct children move UP to its parent, taking its place among its
// siblings in their own order (shared/docs-tree-core.ts `planArchive`). Its staged versions stay `staged` and are
// hidden from Review while it is archived (every Review read joins `d.archived_at IS NULL`); promoting one is refused.
// Restore clears the two columns and puts the page back under its old parent when that page is in the Library and the
// 6-level cap allows it, else at the end of the space's top level (`planRestore`); its old children stay where they
// went.
import { planArchive, planRestore } from "@shared/docs-tree-core";
import type { DocArchiveErrorCode, DocArchiveResult, DocRestoreResult, DocTreePlace } from "@shared/docs-core";
import { batch, first, nowIso, stmt, type Stmt, type TenantContext } from "../data/sql";
import { isPageArchiver, placeStmt, spaceNodes } from "./doc-tree";
import { spaceState } from "./spaces";

/** A refused archive or restore. `message` is fixed text naming the rule. */
export class DocArchiveError extends Error {
  constructor(readonly code: DocArchiveErrorCode, readonly status: 403 | 404 | 409, message: string) {
    super(message);
    this.name = "DocArchiveError";
  }
}

interface ArchiveRow { slug: string; space: string; parent_slug: string | null; archived_at: string | null }

async function pageFor(ctx: TenantContext, slug: string): Promise<ArchiveRow> {
  const row = await first<ArchiveRow>(ctx, `SELECT slug, space, parent_slug, archived_at FROM docs WHERE org_id = ? AND slug = ?`, ctx.orgId, slug);
  if (!row) throw new DocArchiveError("not_found", 404, "there is no such page");
  return row;
}

async function requireArchiver(ctx: TenantContext, row: ArchiveRow): Promise<void> {
  if (!(await isPageArchiver(ctx, row.space))) throw new DocArchiveError("forbidden", 403, "only an admin, or an owner of this page's space, can archive or restore its pages");
  if ((await spaceState(ctx, row.space)) !== "live") throw new DocArchiveError("space_archived", 409, "this page's space is archived: restore the space first");
}

/** Archive a page: it leaves the Library, its children move up a level — one batch. */
export async function archiveDoc(ctx: TenantContext, slug: string): Promise<DocArchiveResult> {
  const row = await pageFor(ctx, slug);
  await requireArchiver(ctx, row);
  if (row.archived_at) throw new DocArchiveError("archived", 409, "this page is already archived");
  const plan = planArchive(await spaceNodes(ctx, row.space), slug);
  const at = nowIso();
  const places: DocTreePlace[] = plan?.places ?? [];
  const stmts: Stmt[] = [
    // Guarded: a second archive racing this one changes nothing.
    stmt(ctx, `UPDATE docs SET archived_at = ?, archived_by = ? WHERE org_id = ? AND slug = ? AND archived_at IS NULL`, at, ctx.userId, ctx.orgId, slug),
    ...places.map((p) => placeStmt(ctx, p.slug, p.parent_slug, p.tree_rank)),
  ];
  await batch(ctx, stmts);
  return { ok: true, slug, archived_at: at, parent_slug: plan?.parent_slug ?? null, places };
}

/** Restore an archived page: back under its old parent if it can go there, else at the top level. */
export async function restoreDoc(ctx: TenantContext, slug: string): Promise<DocRestoreResult> {
  const row = await pageFor(ctx, slug);
  await requireArchiver(ctx, row);
  if (!row.archived_at) throw new DocArchiveError("not_archived", 409, "this page is not archived");
  const plan = planRestore(await spaceNodes(ctx, row.space), { slug, space: row.space }, row.parent_slug);
  const places: DocTreePlace[] = [{ slug, parent_slug: plan.parent_slug, tree_rank: plan.tree_rank }];
  const stmts: Stmt[] = [
    stmt(ctx, `UPDATE docs SET archived_at = NULL, archived_by = NULL, parent_slug = ?, tree_rank = ? WHERE org_id = ? AND slug = ? AND archived_at IS NOT NULL`,
      plan.parent_slug, plan.tree_rank, ctx.orgId, slug),
  ];
  for (const [s, r] of plan.renumber ?? []) {
    stmts.push(stmt(ctx, `UPDATE docs SET tree_rank = ? WHERE org_id = ? AND slug = ? AND archived_at IS NULL`, r, ctx.orgId, s));
    places.push({ slug: s, parent_slug: plan.parent_slug, tree_rank: r });
  }
  await batch(ctx, stmts);
  return { ok: true, slug, parent_slug: plan.parent_slug, tree_rank: plan.tree_rank, places };
}

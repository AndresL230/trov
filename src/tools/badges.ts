import type { SidebarBadges } from "@shared/badges";
import { OPEN_STATUS_SQL } from "@shared/tickets-core";
import { IMPORT_STALE_MS } from "@shared/docs-import-core";
import { type TenantContext, stmt, batch } from "../data/sql";
import { NOT_SUPERSEDED_IMPORT } from "./reads";

/**
 * The sidebar's counts in ONE batch (one D1 round trip), so the boot does not fetch seven lists only
 * to count them. Each COUNT is its list's own WHERE clause — the list stays the definition, and a test
 * holds every count to the length of the list it stands for:
 * proposals = `list_proposals`, decisions = `list_adrs("draft")`, unplaced = `list_needs_triage`, logins =
 * `list_identity_tasks`, tickets = `ticket_badge`, handoffs = the web's `handoffsForMe` over
 * `listHandoffs(me, "mine")`, prompts = the staged ones of `listPrompts`, imports = `listImports(…).running`.
 */
export async function sidebarBadges(ctx: TenantContext, me: string): Promise<SidebarBadges> {
  const o = ctx.orgId;
  const rows = await batch<{ n: number }>(ctx, [
    stmt(ctx, `SELECT COUNT(*) AS n FROM doc_versions v JOIN docs d ON d.slug = v.slug AND d.org_id = ?
                WHERE v.org_id = ? AND v.status = 'staged' AND v.version > d.current_version AND ${NOT_SUPERSEDED_IMPORT}`, o, o),
    stmt(ctx, `SELECT COUNT(*) AS n FROM adrs WHERE org_id = ? AND status = 'draft'`, o),
    stmt(ctx, `SELECT COUNT(*) AS n FROM needs_triage WHERE org_id = ? AND resolved = 0`, o),
    stmt(ctx, `SELECT COUNT(*) AS n FROM identity_tasks WHERE org_id = ? AND status = 'pending'`, o),
    stmt(ctx, `SELECT COUNT(*) AS n FROM tickets t
                WHERE t.org_id = ? AND t.status IN ${OPEN_STATUS_SQL} AND t.source = 'canopy'
                  AND NOT EXISTS (SELECT 1 FROM ticket_assignees a WHERE a.org_id = ? AND a.ticket_id = t.id)`, o, o),
    // `handoffsForMe`: pending, addressed to me (case-insensitive) — `anyone` is not me.
    stmt(ctx, `SELECT COUNT(*) AS n FROM handoffs WHERE org_id = ? AND status = 'pending' AND recipient = ? COLLATE NOCASE`, o, me),
    stmt(ctx, `SELECT COUNT(*) AS n FROM prompts p
                 JOIN prompt_versions v ON v.slug = p.slug AND v.version = p.current_version AND v.org_id = ?
                WHERE p.org_id = ? AND p.deleted_at IS NULL AND v.status = 'staged'`, o, o),
    // `listImports(…).running`: a run in progress that has reported within IMPORT_STALE_MS (one at most).
    stmt(ctx, `SELECT COUNT(*) AS n FROM doc_imports WHERE org_id = ? AND status = 'running' AND updated_at > ?`, o, new Date(Date.now() - IMPORT_STALE_MS).toISOString()),
  ]);
  const n = (i: number): number => rows[i]?.results[0]?.n ?? 0;
  return { proposals: n(0), decisions: n(1), unplaced: n(2), logins: n(3), tickets: n(4), handoffs: n(5), prompts: n(6), imports: n(7) };
}

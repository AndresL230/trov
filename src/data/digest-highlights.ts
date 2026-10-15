// The weekly digest's "This week" (0067_digest_email; docs/architecture/notifications.md › The weekly): at most 3
// cited highlights per organization per week, written by the AI pass's `digest.week` job (src/ai/week.ts) and read
// by the weekly e-mail (src/notifications/renderers/week-recap.ts). A TENANT module: every statement names `org_id`,
// bound from the context.
//
// PLAIN DATA — no model, no network, nothing from src/ai/.
import { first, batch, stmt, type TenantContext } from "./sql";

/** Weeks an organization keeps. */
export const WEEK_HIGHLIGHTS_KEPT = 8;

export interface DigestHighlightsRow {
  week_id: string;
  generated_at: string;
  model: string;
  prompt_version: string;
  highlights_json: string;
}

/** The highlights stored for one week, or null (none written). */
export function weekHighlights(ctx: TenantContext, weekId: string): Promise<DigestHighlightsRow | null> {
  return first<DigestHighlightsRow>(ctx,
    `SELECT week_id, generated_at, model, prompt_version, highlights_json FROM digest_highlights WHERE org_id = ? AND week_id = ?`,
    ctx.orgId, weekId);
}

/**
 * Store one week's highlights — ONCE: a week that already has a row keeps it (`INSERT OR IGNORE`), so a second answer
 * for the same week writes nothing — and drop everything older than the newest `WEEK_HIGHLIGHTS_KEPT` weeks, in ONE
 * batch. Returns whether this call wrote the week.
 */
export async function storeWeekHighlights(ctx: TenantContext, row: DigestHighlightsRow): Promise<boolean> {
  const [ins] = await batch(ctx, [
    stmt(ctx,
      `INSERT OR IGNORE INTO digest_highlights (org_id, week_id, generated_at, model, prompt_version, highlights_json) VALUES (?, ?, ?, ?, ?, ?)`,
      ctx.orgId, row.week_id, row.generated_at, row.model, row.prompt_version, row.highlights_json),
    stmt(ctx,
      `DELETE FROM digest_highlights WHERE org_id = ?1 AND week_id NOT IN
         (SELECT week_id FROM digest_highlights WHERE org_id = ?1 ORDER BY week_id DESC LIMIT ?2)`,
      ctx.orgId, WEEK_HIGHLIGHTS_KEPT),
  ]);
  return (ins?.meta?.changes ?? 0) > 0;
}

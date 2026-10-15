// My Work's "Your brief" (0063_person_brief; docs/architecture/ai.md › The brief): the stored briefs, who gets one,
// and the "last opened My Work" signal. A TENANT module: every statement names `org_id`, bound from the context.
//
// PLAIN DATA — no model, no network, nothing from src/ai/. The READ (`latestBrief`) is reached from MCP's
// `get_my_work` (src/tools/mywork.ts), and nothing reachable from src/mcp.ts may import src/ai/
// (test/secrets.mcp.test.ts); the WRITE (`storeBrief`) is the AI pass's (src/ai/brief.ts).
import { all, batch, first, run, stmt, type TenantContext } from "./sql";

/** How many versions a person keeps (the decided build: "keep the last 5"). */
export const BRIEF_VERSIONS_KEPT = 5;
/** A brief is written only for a member who opened My Work within this long, or who receives the digest. */
export const BRIEF_ACTIVE_MS = 14 * 24 * 60 * 60 * 1000;
/** `mywork_opened_at` is rewritten at most this often (one write an hour, not one per page load). */
export const MYWORK_OPENED_EVERY_MS = 60 * 60 * 1000;

export interface PersonBriefRow {
  handle: string;
  version: number;
  generated_at: string;
  model: string | null;
  prompt_version: string;
  input_hash: string;
  brief_json: string;
}

/** The person's NEWEST stored brief, or null (none written, or not a member). */
export function latestBrief(ctx: TenantContext, handle: string): Promise<PersonBriefRow | null> {
  return first<PersonBriefRow>(ctx,
    `SELECT handle, version, generated_at, model, prompt_version, input_hash, brief_json
       FROM person_brief WHERE org_id = ? AND handle = ? COLLATE NOCASE ORDER BY version DESC LIMIT 1`, ctx.orgId, handle);
}

/** Every stored version, newest first (tests and the keep-5 rule). */
export function briefVersions(ctx: TenantContext, handle: string): Promise<PersonBriefRow[]> {
  return all<PersonBriefRow>(ctx,
    `SELECT handle, version, generated_at, model, prompt_version, input_hash, brief_json
       FROM person_brief WHERE org_id = ? AND handle = ? COLLATE NOCASE ORDER BY version DESC`, ctx.orgId, handle);
}

/** Store a new version and drop everything older than the newest `BRIEF_VERSIONS_KEPT`, in ONE batch. */
export async function storeBrief(ctx: TenantContext, handle: string, b: {
  generatedAt: string; model: string | null; promptVersion: string; inputHash: string; briefJson: string;
}): Promise<void> {
  await batch(ctx, [
    stmt(ctx,
      `INSERT INTO person_brief (org_id, handle, version, generated_at, model, prompt_version, input_hash, brief_json)
       SELECT ?1, ?2, COALESCE(MAX(version), 0) + 1, ?3, ?4, ?5, ?6, ?7 FROM person_brief WHERE org_id = ?1 AND handle = ?2 COLLATE NOCASE`,
      ctx.orgId, handle, b.generatedAt, b.model, b.promptVersion, b.inputHash, b.briefJson),
    stmt(ctx,
      `DELETE FROM person_brief WHERE org_id = ?1 AND handle = ?2 COLLATE NOCASE
          AND version <= (SELECT MAX(version) FROM person_brief WHERE org_id = ?1 AND handle = ?2 COLLATE NOCASE) - ?3`,
      ctx.orgId, handle, BRIEF_VERSIONS_KEPT),
  ]);
}

/** Who a brief may be written for: a MEMBER (else nothing), when they last opened My Work here, and whether the
 *  digest e-mail goes to them — the rule of src/notifications/run.ts `digestRecipients` (a member with an address on
 *  file who has not unsubscribed), asked for one person. */
export interface BriefAudience { openedAt: string | null; digest: boolean }

export async function briefAudience(ctx: TenantContext, handle: string): Promise<BriefAudience | null> {
  const row = await first<{ opened: string | null; digest: number }>(ctx,
    `SELECT m.mywork_opened_at AS opened,
            (p.email IS NOT NULL AND p.email != '' AND p.email_unsubscribed = 0) AS digest
       FROM memberships m JOIN persons p ON p.handle = m.user_id
      WHERE m.org_id = ? AND m.user_id = ? COLLATE NOCASE`, ctx.orgId, handle);
  return row ? { openedAt: row.opened, digest: Number(row.digest) === 1 } : null;
}

/** Does this audience get a brief at `now`? Opened My Work in the last 14 days, or receives the digest. */
export function briefWanted(a: BriefAudience | null, now: Date): boolean {
  if (!a) return false;
  if (a.digest) return true;
  const at = a.openedAt ? Date.parse(a.openedAt) : NaN;
  return Number.isFinite(at) && now.getTime() - at <= BRIEF_ACTIVE_MS;
}

/** The person opened My Work: remember when — at most one write an hour (a page load inside the hour writes
 *  nothing). Rows only; never a model, never a mark. */
export async function markMyWorkOpened(ctx: TenantContext, handle: string, now: Date = new Date()): Promise<void> {
  const at = now.toISOString();
  const before = new Date(now.getTime() - MYWORK_OPENED_EVERY_MS).toISOString();
  await run(ctx,
    `UPDATE memberships SET mywork_opened_at = ?1
      WHERE org_id = ?2 AND user_id = ?3 COLLATE NOCASE AND (mywork_opened_at IS NULL OR mywork_opened_at < ?4)`,
    at, ctx.orgId, handle, before);
}

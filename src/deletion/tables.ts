// Every row an organization owns, as statements of ONE batch (docs/architecture/organizations.md › What
// deletion removes and what it keeps). A TENANT module: each statement runs on the org's own system context
// and names `org_id = ?`, bound from that context (test/data-layer.static.test.ts).
//
// `ORG_TABLES` is every table with an `org_id` column, children before their parents. It is checked against
// the live schema by test/deletion.org.test.ts — a migration that adds a table with an `org_id` column fails
// that test until the table is listed here — so an organization's deletion can never leave a new kind of row
// behind. (The batch also defers foreign keys, so the order is a courtesy, not a requirement.)
import { all, first, stmt, type Stmt, type TenantContext } from "../data/sql";

/** The R2 objects the org's rows point at (artifact bytes, doc images), read BEFORE its rows go: the
 *  candidates ./r2.ts frees after the commit if nothing else points at them. */
export async function orgObjectRefs(ctx: TenantContext): Promise<{ artifactKeys: string[]; docImages: string[] }> {
  const [versions, images] = await Promise.all([
    all<{ r2_key: string }>(ctx, `SELECT DISTINCT r2_key FROM artifact_versions WHERE org_id = ? AND r2_key IS NOT NULL`, ctx.orgId),
    all<{ sha256: string }>(ctx, `SELECT sha256 FROM doc_images WHERE org_id = ?`, ctx.orgId),
  ]);
  return { artifactKeys: versions.map((v) => v.r2_key), docImages: images.map((i) => i.sha256) };
}

/** How many repositories the org has connected — what the deletion's confirmation says it disconnects. */
export async function orgRepoCount(ctx: TenantContext): Promise<number> {
  return (await first<{ n: number }>(ctx, `SELECT COUNT(*) AS n FROM org_repos WHERE org_id = ?`, ctx.orgId))?.n ?? 0;
}

/**
 * Deleted by `org_id`, in this order. The FTS tables come after the rows their triggers index (a trigger
 * clears most of each; the explicit delete takes what no trigger does — the roadmap's `plan` row has none).
 */
export const ORG_TABLES = [
  // Agent connections INTO the org (the ones that can still reach another org were moved there first: below).
  "oauth_codes", "oauth_grant_orgs", "oauth_grants", "mcp_tokens",
  // Tickets and sprints, the roadmap.
  "ticket_events", "ticket_comments", "ticket_links", "ticket_assignees", "tickets", "tickets_fts",
  "sprint_progress", "sprint_resources", "sprints", "plan_versions", "plan", "roadmap_fts",
  // Artifacts and doc images (their R2 bytes go after the commit, if nothing else points at them: ./r2.ts).
  "artifact_upload_tokens", "artifact_links", "artifact_versions", "artifact_pages", "artifacts_fts",
  "doc_image_upload_tokens", "doc_images",
  // Knowledge: docs, decisions, the feed, triage and the ingest ledger — and the org's tag list with what agents suggested for it.
  "doc_versions", "docs", "docs_fts", "entry_tags", "org_tag_suggestions", "org_tag_runs", "org_tags", "org_ai_settings", "feed", "feed_fts", "adrs", "adrs_fts", "needs_triage", "processed_items",
  // Handoffs and the Prompt Library.
  "handoffs", "prompt_versions", "prompts", "prompts_fts",
  // What was captured from GitHub, the Repo dashboard, Sync runs.
  "pr_summaries", "issue_summaries", "events", "identity_tasks", "repo_events", "repo_snapshots", "repo_metrics", "sync_runs",
  // What the model suggested and the "Wrong?" people pressed (0055_ai).
  "ai_suggestions", "ai_feedback",
  // What the AI router marked stale for the pass (0058_ai_dirty).
  "ai_dirty",
  // Ask Trov (0066_ask): the people's threads, their messages and search rows, write cards, attachment links, Ask
  // settings, and Review's "Flagged in Ask" lines.
  "chat_actions", "chat_artifacts", "chat_messages", "chat_fts", "chat_threads", "person_ask_settings", "ask_flags",
  // Email: the outbox (and its dev-only bodies), each member's preferences, the org's policy and settings.
  "notification_outbox_bodies", "notification_outbox", "notification_prefs", "notification_policy", "notification_settings",
  // Hosting (0057_hosting_providers): the parts and their poll state and deploys, the provider connections. The
  // provider-side install (a Vercel Integration, a Netlify grant) is not revoked: its secret goes with org_secrets.
  "hosting_poll_state", "hosting_deploys", "org_hosting_connections", "org_environment_parts",
  // Configuration and credentials: the GitHub App binding, encrypted secrets and their keys, repositories, environments.
  "org_github_installation_repos", "org_github_installations",
  "org_secrets", "org_keys", "org_integration_config", "org_audit",
  "org_environments", "org_repos", "org_login_map",
  // The org's place on the platform: invitations, members, counters, metering, its admin trail.
  "org_invites", "memberships", "org_counters", "org_usage_daily", "org_admin_audit",
] as const;

/**
 * The statements, for `ctx` = the org's system tenant. First the two that are not "delete by org_id":
 *   • a MANUAL connection whose current organization is this one but which may still use another keeps working
 *     there — its current organization moves to the one it was allowed first (as `removeMember` leaves such a
 *     connection alive); every other connection into the org goes, with its tokens;
 *   • `oauth_tokens` has no `org_id`: the tokens of the connections about to be deleted go by their grant.
 */
export function orgRowDeletes(ctx: TenantContext): Stmt[] {
  return [
    stmt(ctx, `UPDATE oauth_grants SET org_id = (
                 SELECT a.org_id FROM oauth_grant_orgs a WHERE a.grant_id = oauth_grants.id AND a.org_id <> ?1 ORDER BY a.added_at, a.org_id LIMIT 1)
                WHERE org_id = ?1 AND revoked_at IS NULL
                  AND EXISTS (SELECT 1 FROM oauth_grant_orgs b WHERE b.grant_id = oauth_grants.id AND b.org_id <> ?1)`, ctx.orgId),
    stmt(ctx, `DELETE FROM oauth_tokens WHERE grant_id IN (SELECT id FROM oauth_grants WHERE org_id = ?)`, ctx.orgId),
    ...ORG_TABLES.map((t) => stmt(ctx, `DELETE FROM ${t} WHERE org_id = ?`, ctx.orgId)),
  ];
}

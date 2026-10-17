// Fixtures for the deletion suites (src/deletion/): an organization with a row in as many org-keyed tables
// as the real writers fill, and a digest of everything an organization owns — so a test can say "every row of
// the deleted org is gone, and the other org is byte-for-byte what it was".
import { env } from "cloudflare:test";
import type { Env } from "../../src/env";
import type { CapturedEvent } from "@shared/contract";
import { TicketCreate } from "@shared/tickets";
import { SprintCreate } from "@shared/sprints";
import { docImageKey } from "@shared/doc-images";
import { createOrg } from "../../src/orgs/repo";
import { resolveTenantById, systemTenant, type TenantContext } from "../../src/data/context";
import { ingestEvent } from "../../src/consumer";
import { append_feed, promote_doc, propose_doc_update, ratify_adr, route_triage, stage_adr } from "../../src/tools/writes";
import { create_ticket, add_ticket_comment, set_ticket_parent, set_ticket_sprint } from "../../src/tools/tickets";
import { create_sprint, add_sprint_resource } from "../../src/tools/sprints";
import { createHandoff } from "../../src/tools/handoffs";
import { createRequestFromWeb, sendLinkNote } from "../../src/tools/links";
import { savePrompt } from "../../src/tools/prompts";
import { createPage, sha256Hex } from "../../src/tools/artifacts";
import { mintToken } from "../../src/auth/tokens";
import { setSecret } from "../../src/data/secrets";
import { all, run } from "./db";
import { ensureMember, platformCtx } from "./tenant";

const e = env as unknown as Env;
const T = "2026-10-01T00:00:00.000Z";

/** A new organization owned by `owner` (a person who must exist), on Pro granted by hand. Returns its id. */
export async function newOrg(owner: string, slug: string): Promise<string> {
  await run(env.DB, `INSERT OR IGNORE INTO persons (handle, name, color, created_at, onboarded_at) VALUES (?, ?, 'stone', ?, ?)`, owner, owner, T, T);
  const org = await createOrg(platformCtx(owner), { slug, name: `${slug} org`, owner, plan: { id: "team", overrides: {}, source: "granted" } });
  return org.id;
}

/** `handle`'s session context in `orgId` (any org — the shared helper only knows the two seed slugs). */
export async function memberCtx(handle: string, orgId: string): Promise<TenantContext> {
  const ctx = await resolveTenantById(e, handle, orgId, "session");
  if (!ctx) throw new Error(`${handle} is not a member of ${orgId}`);
  return ctx;
}

const doc = (slug: string, text: string) =>
  ({ slug, section: "reference", title: `${text} doc title`, body: `${text} doc body`, change_summary: `${text} summary`, confidence: "high" as const });

/**
 * One of nearly everything in `orgId`, written by `author` (made its owner) through the real writers, plus
 * raw rows for what only a webhook, a cron or an integration writes. `tag` marks every text field. Returns
 * the R2 shas the org's rows point at.
 */
export async function fillOrg(orgId: string, author: string, tag: string): Promise<{ docImage: string }> {
  await ensureMember(author, "owner", orgId);
  const sys = systemTenant(platformCtx(), orgId, "system");
  const owner = await memberCtx(author, orgId);
  // Knowledge
  await propose_doc_update(sys, doc(`${tag}-doc`, tag), author);
  await promote_doc(sys, `${tag}-doc`, 1, author);
  await propose_doc_update(sys, doc(`${tag}-doc`, `${tag} staged`), author);
  await append_feed(sys, { author, summary: `${tag} feed`, body: `${tag} feed body`, tags: ["infra"] });
  const adr = { title: `${tag} adr`, context: tag, decision: tag, rationale: tag, confidence: "high" as const };
  await ratify_adr(sys, await stage_adr(sys, adr, author));
  await route_triage(sys, { raw: doc(`${tag}-triaged`, tag), reason: `${tag} reason`, source_author: author });
  const event: CapturedEvent = {
    semantic_key: `gh:pr:7:merged`, event_type: "pr_merged", ref_number: 7, subject_login: `${tag}-login`,
    raw: JSON.stringify({ pr: { number: 7, title: `${tag} pr`, body: tag } }), provenance: "webhook", occurred_at: T,
  };
  await ingestEvent(sys, platformCtx(), event, "github-webhook");
  await run(env.DB, `INSERT OR IGNORE INTO pr_summaries (org_id, repo, semantic_key, pr_number, model, created_at, title, what, why, impact)
                     SELECT org_id, repo, semantic_key, 7, 'excerpt', ?, 't', 'w', 'y', 'i' FROM events WHERE org_id = ? LIMIT 1`, T, orgId);
  await run(env.DB, `INSERT OR IGNORE INTO issue_summaries (org_id, repo, issue_number, summary, model, created_at) VALUES (?, 'o/r', 3, ?, 'excerpt', ?)`, orgId, tag, T);
  // Work
  const sprint = (await create_sprint(sys, SprintCreate.parse({ label: `${tag} sprint` }), author)).id;
  await add_sprint_resource(sys, sprint, `https://example.com/${tag}`);
  await run(env.DB, `INSERT OR IGNORE INTO sprint_progress (sprint_id, closed, total, source, computed_at, org_id) VALUES (?, 0, 1, 'recompute', ?, ?)`, sprint, T, orgId);
  const ticket = await create_ticket(sys, TicketCreate.parse({ title: `${tag} ticket`, body: tag, assignees: [author], link: `https://example.com/${tag}-link` }), author);
  await add_ticket_comment(sys, ticket, `${tag} comment`, author);
  const sub = await create_ticket(sys, TicketCreate.parse({ title: `${tag} sub` }), author);
  await set_ticket_parent(sys, ticket, sub);
  await set_ticket_sprint(sys, ticket, sprint);
  await run(env.DB, `UPDATE plan SET narrative = ? WHERE org_id = ?`, `${tag} narrative`, orgId); // the roadmap's FTS row (no trigger removes it)
  await run(env.DB, `INSERT INTO plan_versions (org_id, version, narrative, sprints_json, created_at, created_by) VALUES (?, 1, ?, '[]', ?, ?)`, orgId, tag, T, author);
  await createHandoff(sys, author, { body: `${tag} handoff`, context: { task: tag } }, { sessionId: `${tag}-session`, itemIndex: 0 });
  // An agent link with a note (0078_agent_links): a self-link, open at once from the web.
  const link = await createRequestFromWeb(owner, author, { target: { person: author }, reason: `${tag} link` });
  await sendLinkNote(owner, platformCtx(), author, { id: link.id, body: `${tag} note` }, "web");
  await savePrompt(sys, author, { slug: `${tag}-prompt`, title: `${tag} prompt`, body: tag, tags: ["review"], status: "published" }, "human");
  const page = await createPage(sys, { title: `${tag} artifact`, kind: "markdown", area: "auth", content: `# ${tag}` }, author);
  await run(env.DB, `INSERT INTO artifact_links (page_id, target_type, target_ref, created_by, created_at, org_id) SELECT id, 'pr', 'o/r#1', ?, ?, org_id FROM artifact_pages WHERE org_id = ? AND slug = ?`, author, T, orgId, page.slug);
  await run(env.DB, `INSERT INTO artifact_upload_tokens (token_hash, principal, page_id, kind, size_bytes, sha256, content_type, expires_at, created_at, org_id)
                     SELECT ?, ?, id, 'image', 1, ?, 'image/png', ?, ?, org_id FROM artifact_pages WHERE org_id = ? AND slug = ?`, `${tag}-upload`, author, "0".repeat(64), T, T, orgId, page.slug);
  // A doc image, its bytes in R2.
  const png = new TextEncoder().encode(`\x89PNG\r\n\x1a\n${tag}-image:${"x".repeat(40)}`);
  const docImage = await sha256Hex(png);
  await e.ARTIFACTS_BUCKET.put(docImageKey(docImage), png, { httpMetadata: { contentType: "image/png" } });
  await run(env.DB, `INSERT INTO doc_images (org_id, sha256, content_type, size_bytes, uploaded_by, created_at) VALUES (?, ?, 'image/png', ?, ?, ?)`, orgId, docImage, png.byteLength, author, T);
  await run(env.DB, `INSERT INTO doc_image_upload_tokens (token_hash, principal, sha256, size_bytes, content_type, expires_at, created_at, org_id) VALUES (?, ?, ?, 1, 'image/png', ?, ?, ?)`, `${tag}-img-upload`, author, docImage, T, T, orgId);
  // Configuration, credentials, the repo dashboard
  await run(env.DB, `INSERT INTO org_repos (id, org_id, repo_full_name, is_primary, created_at, created_by) VALUES (?, ?, ?, 1, ?, ?)`, `hook_${tag}`, orgId, `${tag}/repo`, T, author);
  await run(env.DB, `INSERT INTO org_environments (org_id, key, position, label, branch, created_at, updated_at, updated_by) VALUES (?, 'staging', 0, ?, 'main', ?, ?, ?)`, orgId, tag, T, T, author);
  await setSecret(owner, "github_token", "", `ghp_${tag.replace(/[^a-z0-9]/gi, "")}_stored_token_0123456789`);
  await run(env.DB, `INSERT OR IGNORE INTO org_integration_config (org_id, kind, scope, config, updated_at, updated_by) VALUES (?, 'cloudflare_analytics', '', '{}', ?, ?)`, orgId, T, author);
  await run(env.DB, `INSERT INTO org_github_installations (org_id, installation_id, account_login, account_id, account_type, repository_selection, connected_by, connected_at)
                     VALUES (?, 4242, ?, 1, 'Organization', 'selected', ?, ?)`, orgId, `${tag}-gh`, author, T);
  await run(env.DB, `INSERT INTO org_github_installation_repos (org_id, binding_id, repo_id, repo_full_name, private) SELECT org_id, id, 1, ?, 0 FROM org_github_installations WHERE org_id = ?`, `${tag}/repo`, orgId);
  await run(env.DB, `INSERT INTO org_login_map (org_id, github_login, person, mapped_at, mapped_by) VALUES (?, ?, ?, ?, ?)`, orgId, `${tag}-mapped`, author, T, author);
  await run(env.DB, `INSERT INTO repo_events (org_id, repo, semantic_key, kind, ref, raw, provenance, occurred_at, recorded_at) VALUES (?, 'o/r', ?, 'push', 'main', '{}', 'webhook', ?, ?)`, orgId, `${tag}:push`, T, T);
  await run(env.DB, `INSERT INTO repo_snapshots (org_id, kind, json, computed_at) VALUES (?, 'branches', '{}', ?)`, orgId, T);
  await run(env.DB, `INSERT INTO repo_metrics (org_id, metric, env, part, value, at) VALUES (?, 'health', 'staging', '', 1, ?)`, orgId, T);
  // A release (0074_releases).
  await run(env.DB, `INSERT INTO releases (org_id, repo, tag, published_at, author, source, content_hash, captured_at) VALUES (?, 'o/r', ?, ?, ?, 'release', 'h', ?)`, orgId, `${tag}-v1`, T, `${tag}-gh`, T);
  await run(env.DB, `INSERT INTO sync_runs (org_id, repo, started_by, started_at, updated_at, status) VALUES (?, 'o/r', ?, ?, ?, 'ok')`, orgId, author, T, T);
  // AI (0055_ai): a suggestion someone dismissed, and a "Wrong?".
  await run(env.DB, `INSERT INTO ai_suggestions (org_id, item_type, item_ref, kind, value_json, reason, state, created_at, decided_by, decided_at) VALUES (?, 'ticket', '1', 'category', '"bug"', ?, 'dismissed', ?, ?, ?)`, orgId, `${tag} reason`, T, author, T);
  await run(env.DB, `INSERT INTO ai_feedback (org_id, handle, item_type, item_ref, kind, created_at) VALUES (?, ?, 'brief', ?, 'brief', ?)`, orgId, author, `${tag}-brief`, T);
  // People and access
  await run(env.DB, `INSERT INTO org_invites (org_id, email, role, invited_by, status, created_at) VALUES (?, ?, 'member', ?, 'pending', ?)`, orgId, `${tag}-invitee@example.com`, author, T);
  await mintToken(owner);
  await run(env.DB, `INSERT INTO notification_prefs (org_id, user_id, kind, cadence, updated_at) VALUES (?, ?, 'my_work', 'daily', ?)`, orgId, author, T);
  await run(env.DB, `INSERT INTO notification_outbox (idempotency_key, user_id, cadence, window_id, kinds, status, created_at, org_id) VALUES (?, ?, 'daily', 'w1', '[]', 'sent', ?, ?)`, `${orgId}:${author}:daily:w1`, author, T, orgId);
  await run(env.DB, `INSERT INTO notification_outbox_bodies (idempotency_key, to_address, subject, html, text, created_at, org_id) VALUES (?, 'x@example.com', 's', 'h', 't', ?, ?)`, `${orgId}:${author}:daily:w1`, T, orgId);
  await run(env.DB, `INSERT INTO org_usage_daily (org_id, day, metric, actor, count, last_at) VALUES (?, '2026-10-01', 'api_read', ?, 3, ?)`, orgId, author, T);
  return { docImage };
}

let tables: string[] | null = null;
/** Every table with an `org_id` column, from the live schema (FTS tables included). */
export async function orgKeyedTables(): Promise<string[]> {
  if (tables) return tables;
  const names = await all<{ name: string }>(env.DB,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'd1_%' ORDER BY name`);
  const keyed: string[] = [];
  for (const t of names) {
    const cols = await all<{ name: string }>(env.DB, `SELECT name FROM pragma_table_info(?)`, t.name);
    if (cols.some((c) => c.name === "org_id")) keyed.push(t.name);
  }
  return (tables = keyed);
}

/** How many rows of `orgId` each org-keyed table holds. */
export async function orgRowCounts(orgId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of await orgKeyedTables()) {
    out[t] = (await all<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM "${t}" WHERE org_id = ?`, orgId))[0].n;
  }
  return out;
}

/** Every row `orgId` owns (sorted per table), its `orgs` row and its members' persons — to compare before / after. */
export async function orgDigest(orgId: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const dump = async (name: string, sql: string, ...p: unknown[]) => {
    out[name] = JSON.stringify((await all<unknown>(env.DB, sql, ...p)).map((r) => JSON.stringify(r)).sort());
  };
  for (const t of await orgKeyedTables()) await dump(t, `SELECT * FROM "${t}" WHERE org_id = ?`, orgId);
  await dump("orgs", `SELECT * FROM orgs WHERE id = ?`, orgId);
  await dump("persons", `SELECT * FROM persons WHERE handle IN (SELECT user_id FROM memberships WHERE org_id = ?)`, orgId);
  return out;
}

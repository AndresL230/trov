// THE AI ROUTER'S TABLE, `ai_dirty` (0058 + 0059; docs/architecture/ai.md › The router). A TENANT module: every
// statement names `org_id`, bound from the caller's context (test/data-layer.static.test.ts).
//
// Two sides:
//   • MARKING (`markDirty`) — what every write path calls, through the router (src/tools/ai-route.ts), AFTER its
//     own write. Rows only: no model, no network, no read the caller waits on beyond the one batch. It is
//     reachable from src/mcp.ts (the MCP writers mark too), so this file imports nothing from src/ai/.
//   • THE PASS'S SIDE (`dueScopes`, `clearScopes`, `failScopes`, `holdScopes`) — what src/ai/pass.ts reads and
//     writes back.
//
// A scope is DIRTY while it was marked after its last run: `last_run_at IS NULL OR marked_at > last_run_at`.
// Marking an already-dirty scope keeps its `dirty_since` (the FIRST mark since the last run) and moves
// `marked_at` (the LAST); marking a clean one starts a new `dirty_since`. A mark resets `attempts`, so a scope that
// failed 3 times (and waits) runs again once something marks it. Marks are written only while the org's AI
// switch is on: an org with AI off accrues nothing, and turning it on starts from the next writes.
import type { AiScope } from "@shared/ai-core";
import { all, batch, nowIso, stmt, type Stmt, type TenantContext } from "./sql";

/** What a write says is stale. Most are a literal scope and key; the rest name something the router resolves
 *  in SQL (in the same batch), so a write path never reads to mark:
 *    • `personLogin` — the member this org attributes a GitHub login to (its attribution map, else a member's
 *      own GitHub sign-in: `resolvePersonForLogin`'s rule), or nothing;
 *    • `prAuthorOfBranch` — the same, for the author of the newest PR whose head is that branch;
 *    • `ticketPeople` / `ticketSprint` — a ticket's assignees / its sprint (by ticket ROW id);
 *    • `mirroredTicket` — `card:ticket:<number>` of the ticket mirrored from that issue (`tickets.source_ref`);
 *    • `prSprints` — the sprints of the tickets that link the org's primary repo's PR `#n`;
 *    • `members` — up to `n` of the org's members (a handoff to `anyone`);
 *    • `primaryRepo` — `scope:<the org's primary repo>`;
 *    • `repoIfEnvBranch` — `repo:<the primary repo>` when `branch` is environment `env`'s branch. */
export type ScopeRef =
  | { scope: AiScope; key?: string; urgent?: boolean }
  | { personLogin: string }
  | { prAuthorOfBranch: string }
  | { ticketPeople: number }
  | { ticketSprint: number }
  | { mirroredTicket: string }
  | { prSprints: number }
  | { members: number }
  | { primaryRepo: "repo" | "theme_window" | "theme_backfill" }
  | { repoIfEnvBranch: { env: string; branch: string } };

/** One stale scope, as the pass reads it. */
export interface DirtyScope {
  scope: AiScope;
  key: string;
  dirtySince: string;
  /** The last mark (NULL in the row = `dirtySince`). */
  markedAt: string;
  attempts: number;
  urgent: boolean;
}

/** Failed runs after which a scope waits until it is marked again. */
export const AI_MAX_ATTEMPTS = 3;
/** The most due scopes one org's turn reads (oldest first). */
export const AI_DUE_READ_MAX = 500;
/** The most members a handoff to `anyone` marks. */
export const AI_ANYONE_MAX = 20;

// The upsert every mark ends with. `ai_dirty.*` on the right of SET is the row BEFORE the update (SQLite).
// CLEAN = it ran after its last mark: a new mark starts a new `dirty_since` and takes the new `urgent`.
const CLEAN = `ai_dirty.last_run_at IS NOT NULL AND COALESCE(ai_dirty.marked_at, ai_dirty.dirty_since) <= ai_dirty.last_run_at`;
const UPSERT = `ON CONFLICT(org_id, scope, scope_key) DO UPDATE SET
     dirty_since = CASE WHEN ${CLEAN} THEN excluded.dirty_since ELSE ai_dirty.dirty_since END,
     urgent = CASE WHEN ${CLEAN} THEN excluded.urgent ELSE MAX(ai_dirty.urgent, excluded.urgent) END,
     marked_at = excluded.marked_at,
     attempts = 0`;
/** The switch, in the same statement: an org with AI off is marked nothing. */
const ON = `EXISTS (SELECT 1 FROM orgs o WHERE o.id = ?1 AND o.ai_automation = 1)`;
/** A GitHub login (bound as ?5) → the member handle this org attributes it to. */
const LOGIN_HANDLE = `COALESCE(
       (SELECT l.person FROM org_login_map l JOIN memberships m ON m.user_id = l.person AND m.org_id = ?1 WHERE l.org_id = ?1 AND l.github_login = ?5),
       (SELECT i.person FROM identities i JOIN memberships m2 ON m2.user_id = i.person AND m2.org_id = ?1 WHERE i.provider = 'github' AND i.subject = ?5))`;

/** The statement for one ref: ?1 org, ?2 scope, ?3 now, ?4 urgent, ?5/?6 the ref's own values. */
function markStmt(ctx: TenantContext, ref: ScopeRef, now: string): Stmt {
  const o = ctx.orgId;
  if ("scope" in ref) {
    return stmt(ctx, `INSERT INTO ai_dirty (org_id, scope, scope_key, dirty_since, marked_at, attempts, urgent)
       SELECT ?1, ?2, ?5, ?3, ?3, 0, ?4 WHERE ${ON} ${UPSERT}`, o, ref.scope, now, ref.urgent ? 1 : 0, ref.key ?? "");
  }
  if ("personLogin" in ref) {
    return stmt(ctx, `INSERT INTO ai_dirty (org_id, scope, scope_key, dirty_since, marked_at, attempts, urgent)
       SELECT ?1, ?2, k, ?3, ?3, 0, ?4 FROM (SELECT ${LOGIN_HANDLE} AS k) WHERE k IS NOT NULL AND ${ON} ${UPSERT}`,
    o, "person", now, 0, ref.personLogin);
  }
  if ("prAuthorOfBranch" in ref) {
    // The newest PR row (repo_events, kind `pr`) whose head is the branch: its author's login, then the member.
    return stmt(ctx, `INSERT INTO ai_dirty (org_id, scope, scope_key, dirty_since, marked_at, attempts, urgent)
       SELECT ?1, ?2, k, ?3, ?3, 0, ?4 FROM (SELECT COALESCE(
           (SELECT l.person FROM org_login_map l JOIN memberships m ON m.user_id = l.person AND m.org_id = ?1 WHERE l.org_id = ?1 AND l.github_login = a.login),
           (SELECT i.person FROM identities i JOIN memberships m2 ON m2.user_id = i.person AND m2.org_id = ?1 WHERE i.provider = 'github' AND i.subject = a.login)) AS k
         FROM (SELECT actor_login AS login FROM repo_events WHERE org_id = ?1 AND kind = 'pr' AND ref = ?5 AND actor_login IS NOT NULL ORDER BY occurred_at DESC LIMIT 1) a)
       WHERE k IS NOT NULL AND ${ON} ${UPSERT}`,
    o, "person", now, 0, ref.prAuthorOfBranch);
  }
  if ("ticketPeople" in ref) {
    return stmt(ctx, `INSERT INTO ai_dirty (org_id, scope, scope_key, dirty_since, marked_at, attempts, urgent)
       SELECT ?1, ?2, login, ?3, ?3, 0, ?4 FROM ticket_assignees WHERE org_id = ?1 AND ticket_id = ?5 AND ${ON} ${UPSERT}`,
    o, "person", now, 0, ref.ticketPeople);
  }
  if ("ticketSprint" in ref) {
    return stmt(ctx, `INSERT INTO ai_dirty (org_id, scope, scope_key, dirty_since, marked_at, attempts, urgent)
       SELECT ?1, ?2, CAST(sprint_id AS TEXT), ?3, ?3, 0, ?4 FROM tickets WHERE org_id = ?1 AND id = ?5 AND sprint_id IS NOT NULL AND ${ON} ${UPSERT}`,
    o, "sprint", now, 0, ref.ticketSprint);
  }
  if ("mirroredTicket" in ref) {
    return stmt(ctx, `INSERT INTO ai_dirty (org_id, scope, scope_key, dirty_since, marked_at, attempts, urgent)
       SELECT ?1, ?2, 'ticket:' || number, ?3, ?3, 0, ?4 FROM tickets WHERE org_id = ?1 AND source_ref = ?5 AND ${ON} ${UPSERT}`,
    o, "card", now, 0, ref.mirroredTicket);
  }
  if ("prSprints" in ref) {
    // A ticket links a PR by its GitHub URL (ticket_links, kind `github`); the PR is the primary repo's.
    return stmt(ctx, `INSERT INTO ai_dirty (org_id, scope, scope_key, dirty_since, marked_at, attempts, urgent)
       SELECT DISTINCT ?1, ?2, CAST(t.sprint_id AS TEXT), ?3, ?3, 0, ?4
         FROM ticket_links tl JOIN tickets t ON t.id = tl.ticket_id AND t.org_id = ?1
         JOIN org_repos r ON r.org_id = ?1 AND r.is_primary = 1
        WHERE tl.org_id = ?1 AND tl.kind = 'github' AND t.sprint_id IS NOT NULL
          AND lower(tl.url) = lower('https://github.com/' || r.repo_full_name || '/pull/' || ?5) AND ${ON} ${UPSERT}`,
    o, "sprint", now, 0, ref.prSprints);
  }
  if ("members" in ref) {
    return stmt(ctx, `INSERT INTO ai_dirty (org_id, scope, scope_key, dirty_since, marked_at, attempts, urgent)
       SELECT ?1, ?2, k, ?3, ?3, 0, ?4 FROM (SELECT user_id AS k FROM memberships WHERE org_id = ?1 ORDER BY user_id LIMIT ?5) WHERE ${ON} ${UPSERT}`,
    o, "person", now, 0, Math.max(0, Math.min(AI_ANYONE_MAX, Math.floor(ref.members))));
  }
  if ("primaryRepo" in ref) {
    return stmt(ctx, `INSERT INTO ai_dirty (org_id, scope, scope_key, dirty_since, marked_at, attempts, urgent)
       SELECT ?1, ?2, repo_full_name, ?3, ?3, 0, ?4 FROM org_repos WHERE org_id = ?1 AND is_primary = 1 AND ${ON} ${UPSERT}`,
    o, ref.primaryRepo, now, 0);
  }
  return stmt(ctx, `INSERT INTO ai_dirty (org_id, scope, scope_key, dirty_since, marked_at, attempts, urgent)
     SELECT ?1, ?2, r.repo_full_name, ?3, ?3, 0, ?4 FROM org_repos r
      WHERE r.org_id = ?1 AND r.is_primary = 1
        AND EXISTS (SELECT 1 FROM org_environments e WHERE e.org_id = ?1 AND e.key = ?5 AND e.branch = ?6) AND ${ON} ${UPSERT}`,
  o, "repo", now, 0, ref.repoIfEnvBranch.env, ref.repoIfEnvBranch.branch);
}

/** Mark `refs` stale, in ONE batch. Rows only. Throws on a D1 failure — the router (src/tools/ai-route.ts) is
 *  what makes a mark failure-silent for the write that called it. */
export async function markDirty(ctx: TenantContext, refs: readonly ScopeRef[], now: string = nowIso()): Promise<void> {
  if (!refs.length) return;
  await batch(ctx, refs.map((r) => markStmt(ctx, r, now)));
}

// ── the pass's side ──────────────────────────────────────────────────────────

interface DirtyRow { scope: string; scope_key: string; dirty_since: string; marked_at: string | null; attempts: number; urgent: number }

/** Every DIRTY scope of the org that has not failed `AI_MAX_ATTEMPTS` times, oldest first — ONE statement. The
 *  pass applies the debounce (it needs the plan). A row whose scope this build does not know is left alone. */
export async function dueScopes(ctx: TenantContext, limit: number = AI_DUE_READ_MAX): Promise<DirtyScope[]> {
  const rows = await all<DirtyRow>(ctx,
    `SELECT scope, scope_key, dirty_since, marked_at, attempts, urgent FROM ai_dirty
      WHERE org_id = ? AND attempts < ? AND (last_run_at IS NULL OR COALESCE(marked_at, dirty_since) > last_run_at)
      ORDER BY dirty_since, scope, scope_key LIMIT ?`, ctx.orgId, AI_MAX_ATTEMPTS, limit);
  return rows.map((r) => ({
    scope: r.scope as AiScope, key: r.scope_key, dirtySince: r.dirty_since, markedAt: r.marked_at ?? r.dirty_since,
    attempts: Number(r.attempts) || 0, urgent: Number(r.urgent) === 1,
  }));
}

export interface ScopeKey { scope: AiScope; key: string }

/**
 * WRITTEN: the run that started at `runAt` wrote these scopes. A `card` scope not marked since is DELETED (a card
 * is one item's, written once; a later mark makes a fresh row); every other scope keeps its row as clean
 * (`last_run_at = runAt`). A scope marked WHILE the run was going stays dirty, its debounce counting from that
 * mark — the run did not see it.
 */
export async function clearScopes(ctx: TenantContext, keys: readonly ScopeKey[], runAt: string): Promise<void> {
  if (!keys.length) return;
  const stmts: Stmt[] = [];
  for (const k of keys) {
    if (k.scope === "card") {
      stmts.push(stmt(ctx, `DELETE FROM ai_dirty WHERE org_id = ? AND scope = ? AND scope_key = ? AND COALESCE(marked_at, dirty_since) <= ?`,
        ctx.orgId, k.scope, k.key, runAt));
    }
    stmts.push(stmt(ctx,
      `UPDATE ai_dirty SET last_run_at = ?1, attempts = 0, last_error = NULL,
              urgent = CASE WHEN COALESCE(marked_at, dirty_since) > ?1 THEN urgent ELSE 0 END,
              dirty_since = CASE WHEN COALESCE(marked_at, dirty_since) > ?1 THEN marked_at ELSE dirty_since END
        WHERE org_id = ?2 AND scope = ?3 AND scope_key = ?4`, runAt, ctx.orgId, k.scope, k.key));
  }
  await batch(ctx, stmts);
}

/** FAILED: one more attempt, and why (a fixed NAME — never a model's text, never a secret). After
 *  `AI_MAX_ATTEMPTS` the scope waits until it is marked again (`dueScopes` skips it). A scope held for a batch
 *  becomes dirty again (`last_run_at` back to NULL) so its next attempt can run. */
export async function failScopes(ctx: TenantContext, keys: readonly ScopeKey[], error: string): Promise<void> {
  if (!keys.length) return;
  const why = error.replace(/[^\w .:/-]/g, "").slice(0, 80) || "failed";
  await batch(ctx, keys.map((k) => stmt(ctx,
    `UPDATE ai_dirty SET attempts = attempts + 1, last_error = ?, last_run_at = NULL
      WHERE org_id = ? AND scope = ? AND scope_key = ?`, why, ctx.orgId, k.scope, k.key)));
}

/** HELD: handed to a Message Batch at `at`. The scope reads as clean (`last_run_at = at`) until the batch is
 *  collected, so no tick submits it twice; collecting clears it (`clearScopes` with the same `at`) or fails it. */
export async function holdScopes(ctx: TenantContext, keys: readonly ScopeKey[], at: string): Promise<void> {
  if (!keys.length) return;
  await batch(ctx, keys.map((k) => stmt(ctx, `UPDATE ai_dirty SET last_run_at = ? WHERE org_id = ? AND scope = ? AND scope_key = ?`,
    at, ctx.orgId, k.scope, k.key)));
}

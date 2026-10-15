// REPO STATE, stored and read (docs/architecture/ai.md › Repo state; repo-dashboard.md › State): `repo_state`
// (0062) is append-only — the AI pass's `repo.state` job (src/ai/repo-state.ts) appends a version and keeps the last
// 20 (`appendRepoState`) — and Repo › Overview's `state` and MCP `get_repo_dashboard`'s `state` read the newest
// (`readRepoState`). Reachable from MCP's reads, so it imports nothing from src/ai/ — and calls no model: a read
// that backs a screen only reads rows.
//
// What a read returns (`AiRepoState`, shared/ai-core.ts):
//   • ABSENT — no repository, the org's AI switch off (off is not a state), nothing written yet, the newest version
//     flagged "Wrong?" by the person reading it, a row that no longer parses, or any failed read (the dashboard
//     never fails over it);
//   • `ready` — the newest version, with when and by which model it was written and how many events it was
//     written from (counted by the server);
//   • `capped` — the same content, when the org has spent this month's `ai_runs`: `resumesOn` the 1st of next
//     month, `upgrade` on Free.
import { AiRepoStateSchema, AI_LIST_MAX, aiItemRef, nextMonthStart, type AiLine, type AiRepoState } from "@shared/ai";
import { planRefusal } from "@shared/plans";
import { FREE_PLAN } from "@shared/plans";
import { batch, first, stmt, type TenantContext } from "../data/sql";
import { hiddenFor } from "../data/ai";
import { planAndAiRuns } from "../plans/gate";

/** Versions kept per repository. */
export const REPO_STATE_KEEP = 20;

/** What a version stores: the written state, every cite already resolved by the server. */
export interface StoredRepoState {
  headline: string | null;
  shipped: AiLine[];
  inFlight: AiLine[];
  attention: AiLine[];
}

export interface RepoStateRow {
  version: number;
  generated_at: string;
  basis_until: string;
  model: string;
  prompt_version: string;
  event_count: number | null;
  state_json: string;
}

/** The newest version for `repo`, or null. */
export function latestRepoState(ctx: TenantContext, repo: string): Promise<RepoStateRow | null> {
  return first<RepoStateRow>(ctx,
    `SELECT version, generated_at, basis_until, model, prompt_version, event_count, state_json FROM repo_state
      WHERE org_id = ? AND repo = ? ORDER BY version DESC LIMIT 1`, ctx.orgId, repo);
}

/** A stored state, parsed — or null when it does not hold the shape (never a guessed part). */
export function parseStoredState(json: string): StoredRepoState | null {
  try {
    const v = JSON.parse(json) as StoredRepoState;
    const lines = (x: unknown): AiLine[] | null => (Array.isArray(x) ? (x as AiLine[]) : null);
    const s = { headline: typeof v.headline === "string" ? v.headline : null, shipped: lines(v.shipped), inFlight: lines(v.inFlight), attention: lines(v.attention) };
    if (!s.shipped || !s.inFlight || !s.attention) return null;
    return s as StoredRepoState;
  } catch {
    return null;
  }
}

/** Append version N+1 and keep the last `REPO_STATE_KEEP`, in ONE batch. A computed, direct write. */
export async function appendRepoState(ctx: TenantContext, repo: string, v: {
  state: StoredRepoState; basisUntil: string; model: string; promptVersion: string; eventCount: number | null; at: string;
}): Promise<void> {
  await batch(ctx, [
    stmt(ctx,
      `INSERT INTO repo_state (org_id, repo, version, generated_at, basis_until, model, prompt_version, event_count, state_json)
       SELECT ?1, ?2, COALESCE(MAX(version), 0) + 1, ?3, ?4, ?5, ?6, ?7, ?8 FROM repo_state WHERE org_id = ?1 AND repo = ?2`,
      ctx.orgId, repo, v.at, v.basisUntil, v.model, v.promptVersion, v.eventCount, JSON.stringify(v.state)),
    stmt(ctx,
      `DELETE FROM repo_state WHERE org_id = ?1 AND repo = ?2
         AND version <= (SELECT MAX(version) FROM repo_state WHERE org_id = ?1 AND repo = ?2) - ?3`,
      ctx.orgId, repo, REPO_STATE_KEEP),
  ]);
}

/**
 * `RepoDashboard.state` for `repo` — what the screen and `get_repo_dashboard` carry, or undefined (absent). Two
 * statements (the switch, plan and month's runs in one; the newest version), plus one for "Wrong?" when there is a
 * viewer. Never throws.
 */
export async function readRepoState(ctx: TenantContext, repo: string, opts: { viewer?: string | null; now?: Date } = {}): Promise<AiRepoState | undefined> {
  if (!repo) return undefined;
  try {
    const now = opts.now ?? new Date();
    const [gate, row] = await Promise.all([planAndAiRuns(ctx, now), latestRepoState(ctx, repo)]);
    if (!gate.enabled || !row) return undefined;
    const stored = parseStoredState(row.state_json);
    if (!stored) return undefined;
    if (opts.viewer && (await hiddenFor(ctx, opts.viewer, "repo_state")).has(aiItemRef.repoState(repo, row.generated_at))) return undefined;
    const capped = !!planRefusal(gate.plan, "ai_runs", gate.used, 1);
    const dto: AiRepoState = {
      state: capped ? "capped" : "ready",
      generatedAt: row.generated_at,
      model: row.model,
      resumesOn: capped ? nextMonthStart(now) : null,
      upgrade: capped && gate.plan.plan === FREE_PLAN,
      headline: stored.headline,
      shipped: stored.shipped.slice(0, AI_LIST_MAX),
      inFlight: stored.inFlight.slice(0, AI_LIST_MAX),
      attention: stored.attention.slice(0, AI_LIST_MAX),
      eventCount: row.event_count,
    };
    const parsed = AiRepoStateSchema.safeParse(dto);
    return parsed.success ? parsed.data : undefined;
  } catch (e) {
    console.error("repo state read failed", e instanceof Error ? e.name : "error", `org=${ctx.orgId}`);
    return undefined;
  }
}

// THE AI ROUTER (docs/architecture/ai.md › The router; docs/superpowers/specs/2026-10-15-server-ai-build.md ›
// Phase B): ONE table from a write that happened to the scopes it made stale. Plain code — no model, no
// network: `routeAi` writes `ai_dirty` rows (src/data/ai-dirty.ts) and nothing else, and the AI pass
// (src/ai/pass.ts) later works through them.
//
// WHY IT LIVES HERE AND NOT IN src/ai/: the writers that call it include the MCP writers (tickets, handoffs, the
// gate), and nothing reachable from src/mcp.ts may import src/ai/ (test/secrets.mcp.test.ts). So the table and
// its one entry point sit in src/tools/ and import nothing from src/ai/; src/ai/router.ts re-exports them, so the
// AI side names the router by its own path.
//
// THE CALL-SITE RULE: one line, AFTER the write committed — `await routeAi(ctx, { type: …, … })` — and it never
// fails the write: a D1 error is logged by NAME with the org id and swallowed.
import type { RepoEvent } from "../repo/types";
import { AI_ANYONE_MAX, markDirty, type ScopeRef } from "../data/ai-dirty";
import type { TenantContext } from "../data/sql";

/** Every event the router knows. */
export type AiEvent =
  /** A PR merged on the org's primary repo (the `events` gate: the webhook and Sync's backfill). `author` is the
   *  PR author's GitHub login. */
  | { type: "pr_merged"; number: number; author: string | null }
  /** A repo-dashboard capture written from a WEBHOOK delivery: a push, a PR opened (or updated while open), a
   *  workflow run, a check, a deploy. `defaultBranch` is the repository's, from the delivery (null = unknown). */
  | { type: "repo_activity"; repo: string; ev: Pick<RepoEvent, "kind" | "ref" | "state" | "actor_login">; defaultBranch: string | null }
  /** A hosting deploy recorded or changing state (`hosting_deploys`, the `:40` poll or a provider event). */
  | { type: "hosting_deploy"; env: string; branch: string | null; state: string }
  /** A ticket created — native or mirrored from an issue. `number` is the per-org number. */
  | { type: "ticket_created"; number: number }
  /** A ticket created by the issue mirror (its number is the trigger's: the router finds it by `source_ref`). */
  | { type: "ticket_mirrored"; sourceRef: string }
  /** A ticket assigned / unassigned, or its status or sprint changed. `ticketId` is the ROW id; `sprints` any
   *  sprint it just LEFT and `people` anyone just unassigned (the router reads the current ones itself). */
  | { type: "ticket_changed"; ticketId: number; sprints?: readonly (number | null)[]; people?: readonly string[] }
  /** A handoff sent: a handle, or `anyone`. */
  | { type: "handoff_sent"; recipient: string }
  /** An agent feed entry written through the gate. */
  | { type: "feed_ingested"; id: number; author: string }
  /** A doc proposal (`doc:<slug>:<version>`) or an ADR draft (`adr:<id>`) staged through the gate. */
  | { type: "proposal_staged"; ref: string }
  /** An item landed in Unplaced (`needs_triage`). */
  | { type: "unplaced"; id: number }
  /** A doc promoted. */
  | { type: "doc_promoted"; slug: string }
  /** An artifact created, or given a new version. */
  | { type: "artifact_saved"; slug: string }
  /** Themes accepted for the primary repo (Phase D's theme accept calls this). */
  | { type: "themes_accepted" }
  /** A digest send hour is one tick away: pre-warm the person's brief (skips the debounce). */
  | { type: "digest_prewarm"; handle: string }
  /** A weekly digest is a few hours away (Phase E): its "This week" highlights, ONE batch request per org per week.
   *  `key` is `weekScopeKey(weekId, sendAt)` (shared/ai-core.ts). */
  | { type: "digest_week"; key: string };

export type AiEventType = AiEvent["type"];

/** A failed run or check. */
const FAILED = new Set(["failure", "timed_out"]);
/** A PR row that is OPEN (`review` / `draft`) is "a PR opened"; merged and closed come through `pr_merged`. */
const OPEN_PR = new Set(["review", "draft"]);
/** Deploy states that LANDED or FAILED (`shared/hosting.ts` DeployState). */
const SETTLED_DEPLOY = new Set(["ready", "error"]);

/**
 * THE TABLE (the design's, exactly — plus the hosting-deploy row):
 *
 *   | event                               | scopes                                                                       |
 *   | PR merged                           | card:pr:<n>, repo:<repo>, person:<author>, sprint:<id> (linked tickets), theme_window:<repo> |
 *   | push, PR opened, run, check, deploy | session:<repo>:<actor>; + repo:<repo> for a default-branch push, a deploy, or a default-branch run failure; + person:<PR author> for a failure on their PR |
 *   | hosting deploy recorded / changed   | repo:<repo> when it lands ready or fails on an environment's branch; no session |
 *   | ticket created (native or mirrored) | card:ticket:<n>, org                                                         |
 *   | ticket assigned / status / sprint   | person:<assignee>, sprint:<id>, org                                          |
 *   | handoff sent                        | person:<recipient> (up to AI_ANYONE_MAX members for `anyone`)              |
 *   | agent feed entry ingested           | card:feed:<id>, person:<author>                                              |
 *   | doc proposal or ADR staged          | card:proposal:<id>                                                           |
 *   | item lands in Unplaced              | card:unplaced:<id>                                                           |
 *   | doc promoted; artifact saved        | card:tagfit:<type>:<id>, doc_drift:<slug> (`artifact:<slug>` for an artifact) |
 *   | themes accepted                     | theme_backfill:<repo>                                                        |
 *   | digest send hour one tick away      | person:<handle>, urgent                                                      |
 *   | weekly digest a few hours away      | digest:week:<YYYY-Www>:<send instant> (Phase E)                              |
 */
export const AI_ROUTES: { [T in AiEventType]: (e: Extract<AiEvent, { type: T }>) => ScopeRef[] } = {
  pr_merged: (e) => [
    { scope: "card", key: `pr:${e.number}` },
    { primaryRepo: "repo" },
    ...(e.author ? [{ personLogin: e.author }] : []),
    { prSprints: e.number },
    { primaryRepo: "theme_window" },
  ],
  repo_activity: ({ repo, ev, defaultBranch }) => {
    if (ev.kind === "review" || (ev.kind === "pr" && !OPEN_PR.has(ev.state ?? ""))) return [];
    const failed = (ev.kind === "run" || ev.kind === "check") && FAILED.has(ev.state ?? "");
    const onDefault = !!defaultBranch && !!ev.ref && ev.ref === defaultBranch;
    const out: ScopeRef[] = [];
    if (ev.actor_login) out.push({ scope: "session", key: `${repo}:${ev.actor_login}` });
    if ((ev.kind === "push" && onDefault) || ev.kind === "deploy" || (ev.kind === "run" && failed && onDefault)) out.push({ scope: "repo", key: repo });
    if (failed && ev.ref && !onDefault) out.push({ prAuthorOfBranch: ev.ref });
    return out;
  },
  hosting_deploy: (e) => (e.branch && SETTLED_DEPLOY.has(e.state) ? [{ repoIfEnvBranch: { env: e.env, branch: e.branch } }] : []),
  ticket_created: (e) => [{ scope: "card", key: `ticket:${e.number}` }, { scope: "org" }],
  ticket_mirrored: (e) => [{ mirroredTicket: e.sourceRef }, { scope: "org" }],
  ticket_changed: (e) => [
    { ticketPeople: e.ticketId },
    ...(e.people ?? []).map((h): ScopeRef => ({ scope: "person", key: h })),
    { ticketSprint: e.ticketId },
    ...(e.sprints ?? []).filter((s): s is number => typeof s === "number").map((s): ScopeRef => ({ scope: "sprint", key: String(s) })),
    { scope: "org" },
  ],
  handoff_sent: (e) => [e.recipient === "anyone" ? { members: AI_ANYONE_MAX } : { scope: "person", key: e.recipient }],
  feed_ingested: (e) => [{ scope: "card", key: `feed:${e.id}` }, { scope: "person", key: e.author }],
  proposal_staged: (e) => [{ scope: "card", key: `proposal:${e.ref}` }],
  unplaced: (e) => [{ scope: "card", key: `unplaced:${e.id}` }],
  doc_promoted: (e) => [{ scope: "card", key: `tagfit:doc:${e.slug}` }, { scope: "doc_drift", key: e.slug }],
  artifact_saved: (e) => [{ scope: "card", key: `tagfit:artifact:${e.slug}` }, { scope: "doc_drift", key: `artifact:${e.slug}` }],
  themes_accepted: () => [{ primaryRepo: "theme_backfill" }],
  digest_prewarm: (e) => [{ scope: "person", key: e.handle, urgent: true }],
  digest_week: (e) => [{ scope: "digest", key: e.key }],
};

/** The scopes one event marks (pure — what the table says). */
export function scopesFor(e: AiEvent): ScopeRef[] {
  return (AI_ROUTES[e.type] as (x: AiEvent) => ScopeRef[])(e);
}

/** Mark what `e` made stale. NEVER throws and never fails the write that called it. */
export async function routeAi(ctx: TenantContext, e: AiEvent): Promise<void> {
  try {
    await markDirty(ctx, scopesFor(e));
  } catch (err) {
    // The error's NAME only (a D1 message can quote the statement's values), with the org id.
    console.error("ai router", e.type, err instanceof Error ? err.name : "error", `org=${ctx.orgId}`);
  }
}

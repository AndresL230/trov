// The Repo dashboard, shaped for an AGENT — the read behind MCP `get_repo_dashboard`.
//
// This is a VIEW over the projection, never a second projection: every number
// comes from `getRepoDashboard` (src/tools/repo.ts — D1 only, nothing on that
// path fetches), exactly what `GET /repo/dashboard` hands the screen. All this
// file does is make it fit an agent's context:
//   · `tab`   — only the sections that tab shows (`REPO_TAB_SECTIONS`, the ONE
//               section→tab mapping, shared with web/src/repo.ts);
//   · `range` — the usage / product sections, and each provider
//               part's traffic, carry three ranges for the screen's
//               selector; an agent gets ONE;
//   · trends  — sparkline arrays are stripped, the drift breakdown is cut
//               to a bounded list of group headers, and each provider part's
//               deploy strip to its newest few, unless asked for;
//   · facts   — the Overview's facts (shared/repo-facts-core.ts) and the LAYOUT they decide
//               (`layoutOf(layoutInputOf(facts), facts.groupDefault)` — the very function the screen runs, so
//               the same facts draw the same opener here and there) travel with the overview tab (or no tab);
//               without trends a commit group carries a count instead of its commits and a part's history its
//               newest few (the drift rule below);
//   · written — what Trov WROTE about the repository is not a section, so the
//               tab filter does not name it: `state` travels with the overview
//               (it is Overview's first block), `themes` with planning (Planning's
//               first block), both with no `tab`. Absent on the dashboard = absent
//               here — nothing writes either yet, so today neither ever travels.
// A section's STATUS is never touched: `not_connected` and `empty` pass through
// as they are — unknown is never coerced into a zero or an empty list.
//
// READ-ONLY. The on-demand refresh (`POST /admin/poll`, and the narrower older
// `POST /admin/poll-usage`) and Sync GitHub stay
// session-cookie + admin routes and are never MCP tools.

import { type TenantContext, all, first } from "../data/sql";
import { emptyRepoDashboard, getRepoDashboard, type RepoDashboardEnv } from "./repo";
import type { RepoDashboard } from "@shared/repo";
import { shapeRepoDashboard, type RepoAgentOptions, type RepoAgentView } from "./repo-agent-view";

// The pure view (shaping, limits, the facts' layout) lives in ./repo-agent-view.ts; re-exported for every caller.
export {
  DEFAULT_AGENT_RANGE, DRIFT_GROUP_LIMIT, PROVIDER_DEPLOY_VIEW_LIMIT, factsView, shapeRepoDashboard,
  type RepoAgentOptions, type RepoAgentView,
} from "./repo-agent-view";

/**
 * The dashboard configuration of the context's OWN org (§7.2, D16): its primary repository and its
 * environments, read from `org_repos` / `org_environments` — the rows `GITHUB_REPO` and
 * `REPO_ENVIRONMENTS` became (0042_organizations copied org #1's, value for value). An org that has configured
 * neither gets `""` and `[]`, and every section reads `not_connected`: a bearer never sees another
 * org's repository name or environment list. A failed read is the same empty configuration — the
 * projection below then reports `degraded`, as it does for any other database failure.
 */
interface EnvRow { key: string; label: string; note: string | null; branch: string; frontend_url: string; api_url: string; health_path: string }
export async function orgRepoConfig(ctx: TenantContext): Promise<{ repo: string; envs: RepoDashboardEnv[] }> {
  try {
    // Read here, not through src/integrations/settings.ts: nothing reachable from src/mcp.ts may import
    // the Integrations API or the secrets module (D14; test/secrets.mcp.test.ts walks the import graph).
    // Only what the projection reads — an environment's hosts are its parts, which the projection reads itself.
    const [repo, rows] = await Promise.all([
      first<{ repo_full_name: string }>(ctx, `SELECT repo_full_name FROM org_repos WHERE org_id = ? AND is_primary = 1`, ctx.orgId),
      all<EnvRow>(ctx,
        `SELECT key, label, note, branch, frontend_url, api_url, health_path
           FROM org_environments WHERE org_id = ? ORDER BY position`, ctx.orgId),
    ]);
    return {
      repo: repo?.repo_full_name ?? "",
      envs: rows.map((r) => ({
        key: r.key, label: r.label, note: r.note, branch: r.branch, frontendUrl: r.frontend_url, apiUrl: r.api_url, healthPath: r.health_path,
      })),
    };
  } catch {
    return { repo: "", envs: [] };
  }
}

/** The route's behaviour, mirrored: a projection throw is the degraded empty
 *  dashboard, never an error to the caller. D1 only — nothing here may fetch. */
export async function getRepoDashboardForAgent(
  ctx: TenantContext,
  repo: string,
  envs: RepoDashboardEnv[],
  opts: RepoAgentOptions = {},
  now: number = Date.now()
): Promise<RepoAgentView> {
  let dash: RepoDashboard;
  try {
    dash = await getRepoDashboard(ctx, repo, now, envs, undefined, { app: opts.app ?? null });
  } catch {
    dash = emptyRepoDashboard(repo, true);
  }
  return shapeRepoDashboard(dash, opts);
}

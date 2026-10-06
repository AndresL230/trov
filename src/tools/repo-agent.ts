// The Repo dashboard, shaped for an AGENT — the read behind MCP `get_repo_dashboard`.
//
// This is a VIEW over the projection, never a second projection: every number
// comes from `getRepoDashboard` (src/tools/repo.ts — D1 only, nothing on that
// path fetches), exactly what `GET /repo/dashboard` hands the screen. All this
// file does is make it fit an agent's context:
//   · `tab`   — only the sections that tab shows (`REPO_TAB_SECTIONS`, the ONE
//               section→tab mapping, shared with web/src/repo.ts);
//   · `range` — the usage / cloudflare / product sections carry three ranges
//               for the screen's selector; an agent gets ONE;
//   · trends  — sparkline arrays are stripped, and the drift breakdown is cut
//               to a bounded list of group headers, unless asked for.
// A section's STATUS is never touched: `not_connected` and `empty` pass through
// as they are — unknown is never coerced into a zero or an empty list.
//
// READ-ONLY. The on-demand refresh (`POST /admin/poll`, and the narrower older
// `POST /admin/poll-usage`) and Sync GitHub stay
// session-cookie + admin routes and are never MCP tools.

import {
  REPO_TAB_SECTIONS,
  type RepoDashboard, type RepoDrift, type RepoProduct, type RepoRange, type RepoSection, type RepoSectionName, type RepoTab,
} from "@shared/repo";
import { type TenantContext, all, first } from "../data/sql";
import type { RepoEnvConfig } from "../repo/config";
import { emptyRepoDashboard, getRepoDashboard } from "./repo";

export const DEFAULT_AGENT_RANGE: RepoRange = "7d";

export interface RepoAgentOptions {
  /** Omitted → every section. */
  tab?: RepoTab;
  /** Omitted → `7d`. */
  range?: RepoRange;
  /** Omitted → false: no `trend` arrays, and drift is cut to `DRIFT_GROUP_LIMIT`
   *  groups, each carrying a count rather than its commits. */
  includeTrends?: boolean;
}

export interface RepoAgentView {
  repo: string;
  generatedAt: string;
  degraded: boolean;
  tab: RepoTab | "all";
  range: RepoRange;
  sections: Partial<Record<RepoSectionName, RepoSection<unknown>>>;
}

const ALL_SECTIONS: readonly RepoSectionName[] = Object.values(REPO_TAB_SECTIONS).flat();

/** The sections whose data is `Record<RepoRange, …>` on the wire. */
const RANGED: ReadonlySet<RepoSectionName> = new Set<RepoSectionName>(["usage", "cloudflare"]);

/** A product count carries one figure per range; an agent gets the asked one. */
function productForRange(product: RepoProduct, range: RepoRange): unknown {
  return product.map((e) => ({
    ...e,
    groups: e.groups.map((g) => ({
      ...g,
      metrics: g.metrics.map(({ values, raw, ...rest }) => ({ ...rest, value: values[range], raw: raw[range] })),
    })),
  }));
}

/** Without `include_trends`, a drift section lists at most this many groups. */
export const DRIFT_GROUP_LIMIT = 20;

/** Drift is the one section with no small bound, twice over: a compare returns
 *  up to 250 commits a side, and `computeDrift` makes one GROUP per PR among
 *  them — up to 250 groups in a squash-merge repo (~33 KB of headers alone, and
 *  drift is on the OVERVIEW tab). So without `include_trends` both are cut: a
 *  group carries `commitCount` instead of its `commits`, and only the first
 *  `DRIFT_GROUP_LIMIT` groups travel (the snapshot's own order — PRs newest
 *  first, then the PUSH / BEHIND buckets). `groupCount` is always the FULL
 *  number, beside GitHub's own `ahead` / `behind` totals, so the header stays
 *  truthful and a reader can see the list was cut. With `include_trends`: every
 *  group, with its commits. */
function driftView(drift: RepoDrift, includeTrends: boolean): unknown {
  const groups = includeTrends ? drift.groups : drift.groups.slice(0, DRIFT_GROUP_LIMIT);
  return {
    ...drift,
    groupCount: drift.groups.length,
    groups: groups.map(({ commits, ...g }) => ({ ...g, commitCount: commits.length, ...(includeTrends ? { commits } : {}) })),
  };
}

/** A copy — fresh objects and arrays all the way down — without any key named
 *  `trend`: every sparkline series in the DTO is spelled that way (usage
 *  metrics, product counts/totals, CI failures, coverage, bundle, TODOs), so a
 *  new one is stripped without a change here. */
function withoutTrends(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(withoutTrends);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (k !== "trend") out[k] = withoutTrends(x);
    return out;
  }
  return v;
}

/** PURE: the projection in, the agent's view out. It never writes into `dash`
 *  — but it is NOT a deep copy: with `includeTrends` (and for any `ok` section
 *  it does not reshape) the view SHARES arrays and objects with `dash`. That is
 *  safe because the projection is built per call and the view is only ever
 *  serialized; a caller that wants to mutate the result must clone it first. */
export function shapeRepoDashboard(dash: RepoDashboard, opts: RepoAgentOptions = {}): RepoAgentView {
  const range = opts.range ?? DEFAULT_AGENT_RANGE;
  const includeTrends = opts.includeTrends ?? false;
  const names = opts.tab ? REPO_TAB_SECTIONS[opts.tab] : ALL_SECTIONS;

  const sections: RepoAgentView["sections"] = {};
  for (const name of names) {
    const section = dash[name] as RepoSection<unknown> | undefined;
    if (!section || section.status !== "ok") {
      // Passed through untouched — and a section this payload lacks is unknown.
      sections[name] = section ? { status: section.status } : { status: "not_connected" };
      continue;
    }
    let data: unknown = section.data;
    if (RANGED.has(name)) data = (data as Record<RepoRange, unknown>)[range];
    else if (name === "product") data = productForRange(data as RepoProduct, range);
    else if (name === "drift") data = driftView(data as RepoDrift, includeTrends);
    sections[name] = { status: "ok", data: includeTrends ? data : withoutTrends(data) };
  }

  return { repo: dash.repo, generatedAt: dash.generatedAt, degraded: dash.degraded, tab: opts.tab ?? "all", range, sections };
}

/**
 * The dashboard configuration of the context's OWN org (§7.2, D16): its primary repository and its
 * environments, read from `org_repos` / `org_environments` — the rows `GITHUB_REPO` and
 * `REPO_ENVIRONMENTS` became (0037 copied org #1's, value for value). An org that has configured
 * neither gets `""` and `[]`, and every section reads `not_connected`: a bearer never sees another
 * org's repository name or environment list. A failed read is the same empty configuration — the
 * projection below then reports `degraded`, as it does for any other database failure.
 */
interface EnvRow {
  key: string; label: string; note: string | null; branch: string; railway_env: string; worker: string; worker_check: string;
  frontend_url: string; api_url: string; health_path: string; railway_environment_id: string | null; railway_service_id: string | null;
}
export async function orgRepoConfig(ctx: TenantContext): Promise<{ repo: string; envs: RepoEnvConfig[] }> {
  try {
    // Read here, not through src/integrations/settings.ts: nothing reachable from src/mcp.ts may import
    // the Integrations API or the secrets module (D14; test/secrets.mcp.test.ts walks the import graph).
    const [repo, rows] = await Promise.all([
      first<{ repo_full_name: string }>(ctx, `SELECT repo_full_name FROM org_repos WHERE org_id = ? AND is_primary = 1`, ctx.orgId),
      all<EnvRow>(ctx,
        `SELECT key, label, note, branch, railway_env, worker, worker_check, frontend_url, api_url, health_path,
                railway_environment_id, railway_service_id
           FROM org_environments WHERE org_id = ? ORDER BY position`, ctx.orgId),
    ]);
    return {
      repo: repo?.repo_full_name ?? "",
      envs: rows.map((r) => ({
        key: r.key, label: r.label, note: r.note, branch: r.branch, railwayEnv: r.railway_env, worker: r.worker,
        workerCheck: r.worker_check, frontendUrl: r.frontend_url, apiUrl: r.api_url, healthPath: r.health_path,
        ...(r.railway_environment_id ? { railwayEnvironmentId: r.railway_environment_id } : {}),
        ...(r.railway_service_id ? { railwayServiceId: r.railway_service_id } : {}),
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
  envs: RepoEnvConfig[],
  opts: RepoAgentOptions = {},
  now: number = Date.now()
): Promise<RepoAgentView> {
  let dash: RepoDashboard;
  try {
    dash = await getRepoDashboard(ctx, repo, now, envs);
  } catch {
    dash = emptyRepoDashboard(repo, true);
  }
  return shapeRepoDashboard(dash, opts);
}

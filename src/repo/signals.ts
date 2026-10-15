// Seen signals (repo setups, Phase D): the GitHub deploy signals the capture stored in the last 30 days, grouped —
// what Org settings › Repositories › a repo › Apps offers as deploy names, and what the repo scan matches to the apps
// it found (./detect/match.ts). D1 only: ONE tenant statement over `repo_events`, never a call to GitHub. Secret-free
// (the facts read, reachable from MCP, calls it through ./scan-reads.ts).
//
//   deployment  `deploy` rows with `raw.signal` 'deployment' (and rows captured before 0057, which carry none),
//               grouped by environment name + creator; counted by DISTINCT deployment (one has several statuses).
//               `provider` from the creator / link (src/hosting/detect.ts's narrow signs); `source` = the workflow
//               file of an Actions deployment.
//   status      `deploy` rows with `raw.signal` 'status' (commit statuses other than `canopy/*`), by context;
//               counted by distinct commit.
//   check       `check` rows, by app slug + name — but NOT `github-actions`' (every CI job: the workflow is the
//               signal for those); counted by distinct check run. `source` = the app slug.
//   workflow    `run` rows, by workflow file (`raw.path`); counted by distinct run. `name` = the file's name,
//               `source` = its path.
//
// The capture keeps no repository on its rows (every org captures its PRIMARY repository), so signals belong to the
// primary repository: for any other repository the answer is empty (the statement checks it).
import { HOSTING_PROVIDERS, type HostingProviderId } from "@shared/hosting";
import type { SeenSignal, SeenSignalKind } from "@shared/repo-scan-core";
import { all, type TenantContext } from "../data/sql";
import { detectProviders, type DetectRow } from "../hosting/detect";
import { PROVIDERS } from "../hosting/registry";

export const SIGNAL_WINDOW_DAYS = 30;
/** At most this many groups (the busiest first by recency). */
export const SIGNAL_LIMIT = 200;

interface SignalRow {
  kind: SeenSignalKind; name: string | null; actor_login: string | null; app: string | null; source: string | null;
  url: string | null; n: number; last_at: string;
}

const LABELS = Object.fromEntries(HOSTING_PROVIDERS.map((id) => [id, PROVIDERS[id].label])) as Record<HostingProviderId, string>;

/** The host a signal row shows signs of (src/hosting/detect.ts's narrow rules), or null. */
function providerOf(r: SignalRow): HostingProviderId | null {
  if (r.kind === "workflow") return null;
  const row: DetectRow = {
    kind: r.kind === "check" ? "check" : "deploy", signal: r.kind === "status" ? "status" : r.kind === "deployment" ? "deployment" : null,
    name: r.name, url: r.url, actor_login: r.actor_login, app: r.app, last_at: r.last_at, n: r.n,
  };
  return detectProviders([row], LABELS, new Set())[0]?.provider ?? null;
}

const fileName = (path: string) => path.replace(/^.*\//, "");

/** The repository's seen signals — ONE statement (see the header). `[]` for a repository that is not the primary. */
export async function seenSignals(ctx: TenantContext, repo: string, sinceDays = SIGNAL_WINDOW_DAYS, now: number = Date.now()): Promise<SeenSignal[]> {
  const since = new Date(now - sinceDays * 86_400_000).toISOString();
  const rows = await all<SignalRow>(ctx, `
    WITH primary_repo AS (SELECT lower(repo_full_name) AS r FROM org_repos WHERE org_id = ? ORDER BY is_primary DESC, created_at, id LIMIT 1),
    ev AS (SELECT * FROM repo_events WHERE org_id = ? AND occurred_at >= ? AND lower(?) = (SELECT r FROM primary_repo))
    SELECT 'deployment' AS kind, name, actor_login, NULL AS app, MAX(json_extract(raw, '$.workflow')) AS source, MAX(url) AS url,
           COUNT(DISTINCT number) AS n, MAX(occurred_at) AS last_at
      FROM ev WHERE kind = 'deploy' AND COALESCE(json_extract(raw, '$.signal'), 'deployment') = 'deployment' AND name IS NOT NULL
      GROUP BY name, actor_login
    UNION ALL
    SELECT 'status', name, NULL, NULL, NULL, MAX(url), COUNT(DISTINCT sha), MAX(occurred_at)
      FROM ev WHERE kind = 'deploy' AND json_extract(raw, '$.signal') = 'status' AND name IS NOT NULL
      GROUP BY name
    UNION ALL
    SELECT 'check', name, NULL, json_extract(raw, '$.app'), json_extract(raw, '$.app'), MAX(url), COUNT(DISTINCT number), MAX(occurred_at)
      FROM ev WHERE kind = 'check' AND name IS NOT NULL AND COALESCE(json_extract(raw, '$.app'), '') <> 'github-actions'
      GROUP BY name, json_extract(raw, '$.app')
    UNION ALL
    SELECT 'workflow', json_extract(raw, '$.path'), NULL, NULL, json_extract(raw, '$.path'), MAX(url), COUNT(DISTINCT number), MAX(occurred_at)
      FROM ev WHERE kind = 'run' AND json_extract(raw, '$.path') IS NOT NULL
      GROUP BY json_extract(raw, '$.path')
    ORDER BY last_at DESC LIMIT ${SIGNAL_LIMIT}`, ctx.orgId, ctx.orgId, since, repo);
  return rows.filter((r) => r.name).map((r) => ({
    kind: r.kind,
    name: r.kind === "workflow" ? fileName(r.name!) : r.name!,
    provider: providerOf(r),
    count: Number(r.n) || 0,
    lastAt: r.last_at,
    source: r.source ?? null,
  }));
}

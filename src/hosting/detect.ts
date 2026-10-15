// "Detected: Vercel" — which hosting provider an org's repository ALREADY shows signs of, read from what the
// GitHub capture has stored (`repo_events`), so Org settings › Hosting can suggest it once GitHub is connected.
//
// NOTHING here calls GitHub or a provider (invariant 7: no external read on a render path). It is one D1 read
// of rows the webhook / reconcile wrote for their own reasons:
//   check    every check run is captured (src/repo/capture.ts `fromCheckRun`) with its name, its details URL
//            and — in `raw` — the slug of the GitHub App that posted it. Vercel, Netlify and Cloudflare Workers
//            Builds post check runs as their own apps.
//   deploy   GitHub deployment statuses are NOT captured any more (an environment's deploys come from its
//            hosting provider); rows captured before 0057 — with the creator's login (`railway-app[bot]`,
//            `render[bot]`, `vercel[bot]`) — still count while they are inside the window.
// So the suggestion is exactly as good as that capture: a provider that reports to GitHub only through
// deployments (Render, Railway, Fly.io) is not seen — see docs/architecture/hosting-providers.md › Detection
// for what new capture would change that.
//
// A suggestion preselects the provider in the part editor; it connects nothing and stores nothing.
import { HOSTING_PROVIDERS, type HostingDetectionDTO, type HostingDetectionStatusDTO, type HostingProviderId } from "@shared/hosting";
import { all, first, type TenantContext } from "../data/sql";

/** How far back a sign counts: the capture's own retention is longer, but a host left months ago is not a suggestion. */
export const DETECT_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/** One group of captured rows: a check run's (app, name) or a deployment's (creator, environment). */
export interface DetectRow {
  kind: "check" | "deploy";
  name: string | null;
  url: string | null;
  actor_login: string | null;
  /** The GitHub App's slug that posted a check run (`raw.app`); null for a deployment. */
  app: string | null;
  last_at: string;
  n: number;
}

interface Sign {
  /** GitHub App slugs that post this provider's check runs. */
  apps: readonly string[];
  /** Logins that create this provider's GitHub deployments. */
  logins: readonly string[];
  /** The hosts a check run's details link (or a deployment's log link) points at. */
  host: RegExp | null;
  /** A check-run name that is this provider's own — only where the name cannot be anyone else's. */
  name: RegExp | null;
}

/** What each provider looks like from GitHub. Deliberately narrow: a false "Detected" is worse than none. */
const SIGNS: Partial<Record<HostingProviderId, Sign>> = {
  cloudflare: { apps: ["cloudflare-workers-and-pages"], logins: ["cloudflare-workers-and-pages[bot]"], host: /(^|\.)(dash\.cloudflare\.com|pages\.dev|workers\.dev)$/, name: /^(workers builds|cloudflare pages)\b/i },
  railway: { apps: ["railway-app"], logins: ["railway-app[bot]"], host: /(^|\.)railway\.(app|com)$/, name: null },
  vercel: { apps: ["vercel"], logins: ["vercel[bot]"], host: /(^|\.)vercel\.(com|app)$/, name: /^vercel\b/i },
  render: { apps: ["render"], logins: ["render[bot]"], host: /(^|\.)(render\.com|onrender\.com)$/, name: null },
  netlify: { apps: ["netlify"], logins: ["netlify[bot]"], host: /(^|\.)netlify\.(com|app)$/, name: /^netlify\// },
  fly: { apps: [], logins: [], host: /(^|\.)fly\.(io|dev)$/, name: null },
};

const hostOf = (url: string | null): string | null => {
  if (!url) return null;
  try { const u = new URL(url); return u.protocol === "https:" ? u.hostname.toLowerCase() : null; } catch { return null; }
};

/** Why a row is a sign of `provider`, as the words the screen shows — or null when it is not one. */
function evidenceOf(row: DetectRow, sign: Sign, label: string): string | null {
  const host = hostOf(row.url);
  if (row.kind === "check") {
    if (row.app && sign.apps.includes(row.app.toLowerCase())) return `GitHub check runs posted by the ${label} app`;
    if (host && sign.host?.test(host)) return `GitHub check runs that link to ${host}`;
    if (row.name && sign.name?.test(row.name)) return `a GitHub check run named ${row.name.slice(0, 80)}`;
    return null;
  }
  if (row.actor_login && sign.logins.includes(row.actor_login.toLowerCase())) return `GitHub deployments created by ${row.actor_login}`;
  if (host && sign.host?.test(host)) return `GitHub deployments that link to ${host}`;
  return null;
}

/**
 * The providers the captured rows show signs of, in picker order — one entry per provider, carrying its most
 * recent sign. `labels` names each provider (the registry's); `inUse` are the providers a part already uses
 * (still listed, flagged, so the screen can leave them out without a second rule). Pure.
 */
export function detectProviders(
  rows: readonly DetectRow[], labels: Readonly<Record<HostingProviderId, string>>, inUse: ReadonlySet<HostingProviderId>,
): HostingDetectionDTO[] {
  const best = new Map<HostingProviderId, HostingDetectionDTO>();
  for (const row of rows) {
    for (const id of HOSTING_PROVIDERS) {
      const sign = SIGNS[id];
      if (!sign) continue;
      const evidence = evidenceOf(row, sign, labels[id]);
      if (!evidence) continue;
      const held = best.get(id);
      if (!held || row.last_at > held.last_seen) best.set(id, { provider: id, evidence, last_seen: row.last_at, in_use: inUse.has(id) });
    }
  }
  return HOSTING_PROVIDERS.flatMap((id) => { const d = best.get(id); return d ? [d] : []; });
}

/** The captured check runs and deployments of the last `DETECT_WINDOW_MS`, grouped — ONE statement, this org's rows. */
export async function listDetectRows(ctx: TenantContext, now: number = Date.now()): Promise<DetectRow[]> {
  const since = new Date(now - DETECT_WINDOW_MS).toISOString();
  return await all<DetectRow>(ctx, `SELECT kind, name, url, actor_login, json_extract(raw, '$.app') AS app, MAX(occurred_at) AS last_at, COUNT(*) AS n
    FROM repo_events WHERE org_id = ? AND kind IN ('check', 'deploy') AND occurred_at >= ?
    GROUP BY kind, name, actor_login, json_extract(raw, '$.app') ORDER BY last_at DESC LIMIT 200`, ctx.orgId, since);
}

/** `HostingSetupDTO.detected`. A failed read is no suggestion — never an error on the setup screen. */
export async function readDetections(
  ctx: TenantContext, labels: Readonly<Record<HostingProviderId, string>>, inUse: ReadonlySet<HostingProviderId>, now: number = Date.now(),
): Promise<HostingDetectionDTO[]> {
  try { return detectProviders(await listDetectRows(ctx, now), labels, inUse); } catch { return []; }
}

/**
 * `HostingSetupDTO.detection` — where detection stands (shared/hosting.ts `HostingDetectionState`). Three reads, all
 * this org's rows: the primary repository, its newest sync run, and the reconcile's marker (`prs_reconciled`, the
 * last time the repository's checks were read — the reconcile reads each environment branch head's check runs).
 * `detected` is the list the screen already has. A failed read is "looking": never an error on the setup screen.
 */
export async function readDetectionStatus(
  ctx: TenantContext, detected: readonly HostingDetectionDTO[], environments: number,
): Promise<HostingDetectionStatusDTO> {
  try {
    const repo = (await first<{ repo_full_name: string }>(ctx,
      `SELECT repo_full_name FROM org_repos WHERE org_id = ? ORDER BY is_primary DESC, created_at, id LIMIT 1`, ctx.orgId))?.repo_full_name ?? null;
    if (!repo) return { state: "no_repo", repo: null, checked_at: null };
    const checked = (await first<{ computed_at: string }>(ctx,
      `SELECT computed_at FROM repo_snapshots WHERE org_id = ? AND kind = 'prs_reconciled'`, ctx.orgId))?.computed_at ?? null;
    if (detected.length) return { state: "found", repo, checked_at: checked };
    if (environments === 0) return { state: "no_environment", repo, checked_at: checked };
    const running = await first<{ id: number }>(ctx,
      `SELECT id FROM sync_runs WHERE org_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1`, ctx.orgId);
    return { state: running || !checked ? "looking" : "none", repo, checked_at: checked };
  } catch {
    return { state: "looking", repo: null, checked_at: null };
  }
}

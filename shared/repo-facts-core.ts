// The Repo Overview's facts — ONE object the server reads from D1 (`GET /repo/dashboard?repo=&app=`, MCP
// `get_repo_dashboard`) and the SPA draws from. The layout is NOT in here: `layoutOf(layoutInputOf(facts))`
// (shared/repo-layout-core.ts) decides it from these facts alone, on both sides. Zod-free (the SPA imports it).
//
// Never guess: unknown is `null`, never 0 — a `null` sha is "no provider value and no single join candidate",
// a `null` count is "not computed yet", a `null` health is "no reading". Nothing here is worded: the SPA words
// attention items, CI lines and the connect card from their kinds and refs.
import type { AppKind } from "./repo-apps-core";
import type { DeployState, DeployTarget, HostingProviderId, PartRole } from "./hosting";
import type { GroupBy, LayoutInput } from "./repo-layout-core";

/** The App menu's value for "files outside every app". */
export const REPO_WIDE = "__repo";

// ── apps, environments, parts ────────────────────────────────────────────────

export interface FactsApp {
  /** The part key every part of this app carries (`repo_apps.key`). */
  key: string;
  label: string;
  /** Its folder in the repository, "/" for the root. */
  folder: string;
  kind: AppKind;
  /** Path globs that count as this app's (default: its folder). */
  watch: string[];
  /** `implicit` = a part key with no `repo_apps` row, read as an app at the root. */
  source: "migrated" | "manual" | "suggested" | "implicit";
  /** A Package: the apps that use it (from the workspace graph), else null. */
  usedBy: string[] | null;
  /** Whether any of its parts has had a preview deploy in 30 days. */
  previews: boolean;
  /** Open PRs touching it (`null` until PR files / paths are captured for a multi-app repo). */
  openPrs: number | null;
}

export interface FactsEnv {
  key: string;
  name: string;
  branch: string | null;
  /** Promotion order (`org_environments.position`). */
  position: number;
}

export interface FactsDeploy {
  id: string;
  state: DeployState;
  target: DeployTarget;
  sha: string | null;
  /** `provider` = the host (or GitHub) reported it; `joined` = exactly one GitHub signal matched. */
  shaSource: "provider" | "joined" | null;
  branch: string | null;
  message: string | null;
  by: string | null;
  createdAt: string;
  readyAt: string | null;
  url: string | null;
  logUrl: string | null;
  /** A scrubbed failure reason (≤ 140 chars), when the deploy failed and the source said why. */
  reason: string | null;
  /** The sha this deploy rolled back from (GitHub's compare said `behind`). */
  rolledBackFrom: string | null;
  /** Where the record came from: the provider's poll, or GitHub (webhook capture). */
  source: "provider" | "github";
}

export interface FactsHealth {
  url: string;
  up: boolean;
  ms: number | null;
  at: string;
  /** Older than 30 minutes: the reading is shown as stale, never as up or down. */
  stale: boolean;
}

/** A target in the design: one app in one environment. */
export interface FactsPart {
  app: string;
  env: string;
  label: string;
  role: PartRole;
  provider: HostingProviderId;
  /** The provider's label ("Cloudflare Workers", "GitHub deployments"). */
  host: string;
  /** The workflow file or GitHub source a `github` part names ("deploy-jobs.yml"), else null. */
  via: string | null;
  /** The (provider, org-wide scope) connection status — the one status function's answer. */
  connection: "connected" | "not_connected" | "error" | "revoked";
  /** Whether its provider reports deploys at all (a capability, never a provider id). */
  reportsDeploys: boolean;
  /** Its deploys came through GitHub deployments while the host is not connected. */
  viaGithub: boolean;
  /** The newest `ready` production deploy — what is serving. */
  serving: FactsDeploy | null;
  /** The newest production deploy when it is NOT the serving one (in flight, failed, canceled). */
  latest: FactsDeploy | null;
  /** The last ≤ 20 settled production deploys, oldest first. */
  history: FactsDeploy[];
  health: FactsHealth | null;
  /** The public URL (health URL or the serving deploy's URL). */
  url: string | null;
  /** Console link for the part on its provider, https only. */
  consoleUrl: string | null;
  /** Whether its provider reports any usage metric (a capability — the registry's `capabilities.metrics` is
   *  non-empty — never a provider id). The Usage tab reads "Not available from <host>" for a part without
   *  it, and never "not connected" for a host that has nothing to connect for. */
  reportsMetrics: boolean;
}

/** One app serving an older commit than another app in the same environment. */
export interface FactsOutOfStep {
  env: string;
  app: string;
  sha: string;
  /** The app it is behind and that app's sha. */
  of: string;
  ofSha: string;
  /** Commits behind (GitHub's compare total). */
  behindBy: number;
}

export interface FactsPreview {
  app: string;
  pr: number | null;
  title: string | null;
  branch: string;
  by: string | null;
  state: DeployState;
  at: string;
  url: string | null;
  /** Consecutive failed preview deploys on this branch, newest first (0 when the newest did not fail). */
  failStreak: number;
  /** When the streak began, when failStreak > 0. */
  failingSince: string | null;
}

export interface FactsCommit { sha: string; msg: string; at: string }
export interface FactsCommitGroup {
  kind: "pr" | "direct";
  pr: number | null;
  title: string;
  /** The PR's author, or the pushers of direct commits. */
  by: string[];
  mergedAt: string | null;
  commits: FactsCommit[];
  /** Commits in the group beyond what was returned (a compare's 250 cap). */
  more: number;
  /** Phase E: commits in the group whose changed files are not known (a multi-app repository's not shipped keeps
   *  them IN — counted, never dropped by the watch-path filter). Absent = none. */
  pathsUnknown?: number;
}

/** What is merged on an environment's branch and not serving, for one app (watch paths applied). */
export interface FactsNotShipped {
  app: string;
  env: string;
  /** `null` = unknown (no serving sha, or the compare has not run). */
  count: number | null;
  oldestAt: string | null;
  groups: FactsCommitGroup[];
}

/** One step of the promotion chain: what the earlier environment's branch has that the next one lacks. */
export interface FactsDriftStep {
  fromEnv: string;
  toEnv: string;
  from: string;
  to: string;
  ahead: number;
  behind: number;
  groups: FactsCommitGroup[];
}

export interface FactsCi {
  env: string;
  sha: string | null;
  state: "pass" | "fail" | "running" | null;
  /** Checks on the head; `null` while they are still being counted (a running set has no total yet). */
  total: number | null;
  failing: number | null;
  /** Names of failing (or, when running, running) checks — at most 3. */
  names: string[];
}

export interface FactsReleaseWaiting { pr: number; title: string; by: string | null; mergedAt: string; feature: boolean }
export interface FactsRelease {
  tag: string;
  at: string;
  by: string | null;
  notes: string | null;
  since: { commits: number | null; prs: number | null };
  waiting: FactsReleaseWaiting[];
  /** Earlier releases, newest last (≤ 8), for the cadence strip. */
  cadence: { tag: string; at: string }[];
}

/** `evidence` is a sentence, as the scan words it ("from apps/web/vercel.json") — drawn as given. */
export interface FactsFoundApp { id: string; folder: string; kind: AppKind; provider: HostingProviderId | null; evidence: string }
export interface FactsSignal { name: string; provider: HostingProviderId | null; count: number }
export interface FactsFound { apps: FactsFoundApp[]; signals: FactsSignal[] }

export interface FactsUnseen {
  /** The files the scan looked for. */
  looked: string[];
  /** null = not known: the capture keeps no tags until Phase F (`release` / `create` events). */
  tags: { count: number; latest: { tag: string; at: string; by: string | null } | null; recent: { tag: string; at: string; by: string | null }[] } | null;
  prs: { open: number | null; mergedThisMonth: number | null };
  workflows: string[];
  deploymentsSeen30d: number;
}

export type WeekKey = "mergedPrs" | "deploys" | "failedDeploys" | "openPrs" | "commits" | "releases" | "ciRuns";
export interface FactsWeekFigure { key: WeekKey; value: number | null; delta: number | null }

export type AttentionKind = "down" | "failed" | "rolledBack" | "outOfStep" | "stale" | "degraded" | "waiting" | "previewFailing";
export interface FactsAttention {
  kind: AttentionKind;
  app: string | null;
  env: string | null;
  refs: {
    sha?: string; prevSha?: string; failedSha?: string; nextSha?: string;
    provider?: HostingProviderId; url?: string; since?: string; count?: number;
    pr?: number; check?: string; behindBy?: number; of?: string; reason?: string;
  };
}

/** Admin-facing hint: a part's host is not connected. */
export interface FactsConnect {
  provider: HostingProviderId;
  /** `deploys` = nothing reports deploys without it; `metrics` = deploys arrive via GitHub, CPU / memory need it. */
  need: "deploys" | "metrics";
  apps: string[];
}

export interface RepoFacts {
  repo: string;
  /** The App menu's narrowing: an app key, `REPO_WIDE`, or null for all apps. */
  app: string | null;
  /** The org's repositories, for the repository menu. */
  repos: string[];
  /** Every app of the repository (the App menu), whatever `app` narrows to. */
  allApps: FactsApp[];
  /** The apps in view (narrowed by `app`). */
  apps: FactsApp[];
  /** Environments with at least one part of the apps in view, in promotion order. */
  envs: FactsEnv[];
  parts: FactsPart[];
  previews: FactsPreview[];
  notShipped: FactsNotShipped[];
  outOfStep: FactsOutOfStep[];
  drift: FactsDriftStep[];
  ci: FactsCi[];
  release: FactsRelease | null;
  /** Suggestions not yet accepted or ignored (only drawn while no app is accepted). */
  found: FactsFound | null;
  unseen: FactsUnseen | null;
  week: FactsWeekFigure[];
  attention: FactsAttention[];
  connect: FactsConnect | null;
  /** The admin's default Group by (`repo_settings.overview_group`). */
  groupDefault: GroupBy | null;
}

/** The facts as the layout rules read them (names = keys). */
export function layoutInputOf(f: Pick<RepoFacts, "apps" | "envs" | "parts" | "found">): LayoutInput {
  return {
    apps: f.apps.map((a) => ({ name: a.key, kind: a.kind })),
    envs: f.envs.map((e) => ({ name: e.key })),
    targets: f.parts.map((p) => ({ app: p.app, env: p.env })),
    found: f.found ? { apps: f.found.apps } : null,
  };
}

// ── the App menu's narrowing ─────────────────────────────────────────────────

/** The App menu's narrowing — the design's `narrow()` (repo-data.js), one function for the server and the SPA.
 *  `f` is the repository's UNNARROWED facts (`app: null`).
 *  - `null` → all apps, unchanged.
 *  - an app key → that app's parts, previews, not-shipped, out-of-step and attention items; `apps` = [it],
 *    `allApps` unchanged, `envs` = the environments it has a part in, `connect` kept only if it names the app.
 *    Like the design, drift, CI, release, week figures and found / unseen are the repository's and stay.
 *    Attention items with no app (a branch's CI) are dropped, as the design's text filter drops them.
 *  - `REPO_WIDE` ("files outside every app") → no app rows at all (apps, envs, parts, previews, not-shipped,
 *    out-of-step, connect empty) and found / unseen null; the PR / CI-level facts (drift, CI, release, week,
 *    attention items with no app) stay. The design draws the whole repository for it; Trov draws none of the
 *    apps, so its rule reads `unseen` — the Overview for "Repo-wide only" is the SPA's to draw (Phase C / E).
 *  - an unknown key → unchanged, as in the design. */
export function narrowFacts(f: RepoFacts, app: string | null): RepoFacts {
  if (app === null) return f;
  if (app === REPO_WIDE) {
    return {
      ...f, app: REPO_WIDE, apps: [], envs: [], parts: [], previews: [], notShipped: [], outOfStep: [],
      attention: f.attention.filter((a) => a.app === null), connect: null, found: null, unseen: null,
    };
  }
  const one = f.allApps.find((a) => a.key === app);
  if (!one) return f;
  const parts = f.parts.filter((p) => p.app === app);
  const envs = f.envs.filter((e) => parts.some((p) => p.env === e.key));
  return {
    ...f, app, apps: [one], envs, parts,
    previews: f.previews.filter((p) => p.app === app),
    notShipped: f.notShipped.filter((n) => n.app === app),
    outOfStep: f.outOfStep.filter((o) => o.app === app),
    attention: f.attention.filter((a) => a.app === app),
    connect: f.connect && f.connect.apps.includes(app) ? { ...f.connect, apps: [app] } : null,
  };
}

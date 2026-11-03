// App-level detection and setup (Phase D): what the repo scan suggests, what GitHub has been seen deploying, and
// Org settings › Repositories › a repo › Apps. Detection SUGGESTS; a person decides — a suggestion changes nothing on
// the Repo screen but the found-apps card until an admin accepts it. Zod-free (the SPA imports it).
import type { AppKind, RepoApp } from "./repo-apps-core";
import type { EnvironmentPartDTO, HostingProviderId } from "./hosting";

/** A GitHub deploy signal seen in the last 30 days (untagged capture): a deployment environment, a check run, a
 *  commit status context, or a workflow run. `name` is exactly as GitHub carries it ("Production – storefront-web",
 *  "Render – api", "deploy-jobs.yml"). */
export type SeenSignalKind = "deployment" | "check" | "status" | "workflow";
export interface SeenSignal {
  kind: SeenSignalKind;
  name: string;
  /** The host it came from (creator login / check app slug / context), when known. */
  provider: HostingProviderId | null;
  count: number;
  lastAt: string;
  /** For a check run: the posting App's slug; for a workflow: the file. */
  source: string | null;
  /** A workflow only: the branches its runs ran on, each with its own count — a workflow is offered as a release
   *  signal on a branch only when it ran there (never one total claimed for every branch). */
  branches?: { name: string; count: number }[];
}

/** One piece of evidence behind a suggestion, already a sentence ("from apps/web/vercel.json"). */
export interface SuggestionEvidence { kind: "file" | "signal" | "provider" | "workspace"; text: string }

export type SuggestionState = "pending" | "accepted" | "ignored";
export interface AppSuggestionDTO {
  id: string;
  /** The proposed app key ("web"), unique within the repo. */
  key: string;
  folder: string;
  kind: AppKind;
  provider: HostingProviderId | null;
  evidence: SuggestionEvidence[];
  /** Proposed part settings per environment (provider settings, e.g. a Workers script name, D1 ids, crons). */
  parts: { env: string; provider: HostingProviderId; settings: Record<string, string> }[];
  /** The signals matched to it (by the token rules), for the deploy-signal picker's default. */
  signals: SeenSignal[];
  /** Packages: the apps that use it. */
  usedBy: string[];
  state: SuggestionState;
}

export interface RepoScanDTO {
  /** The default branch's root tree sha the last scan read; a scan with the same sha is skipped. */
  treeSha: string | null;
  scannedAt: string | null;
  /** The files it looked for (the detector registry's patterns), for the unseen card's sentence. */
  looked: string[];
  /** Why the last scan could not run (no GitHub credential, a refused read) — scrubbed, never a token. */
  error: string | null;
}

/** `GET /api/o/:slug/repos/:owner/:name/apps` — everything the Apps tab draws, in one read (admin). */
export interface RepoAppsSetupDTO {
  repo: string;
  apps: (RepoApp & { parts: EnvironmentPartDTO[] })[];
  suggestions: AppSuggestionDTO[];
  /** Signals seen in 30 days that no app's part names — "unassigned names". */
  unassigned: SeenSignal[];
  /** Every signal seen in 30 days (the deploy-signal picker offers only these). */
  signals: SeenSignal[];
  scan: RepoScanDTO;
  /** Tags seen (for the release-signal choice of a Package / mobile app). null = not read yet (no reconcile has
   *  read this repository's releases) — never "0 tags" (Phase D2: nullable, from `readTags`). */
  tags: { count: number; latest: { tag: string; at: string } | null } | null;
  // ── Phase D2 (additive): what the screen draws its target rows and host words from ──
  /** The org's environments in drift order — a target row per environment. */
  environments?: { key: string; label: string; branch: string }[];
  /** The provider catalogue's words (every provider a part can choose), so the screen names a host without branching
   *  on an id; `via_github` = its deploys come from GitHub (the deploy-signal picker applies). */
  providers?: { id: HostingProviderId; label: string; via_github: boolean }[];
  /** A sub-read failed and fell back to empty (the screen says so; never a 500). */
  degraded?: boolean;
  /** #144: the captured signals say ONE host deploys this repository — offered as "one service that does
   *  everything", a pre-filled answer the person confirms. null (or absent) when Trov cannot say so. */
  oneService?: OneServiceOfferDTO | null;
}

/**
 * "One service that does everything" (#144) — recognised from what is already captured, never from a call:
 * the org's PRIMARY repository has no app yet; exactly ONE host shows signs in GitHub's captured check runs,
 * deployments and commit statuses (the same signs "Detected" reads, src/hosting/detect.ts); and the repo scan
 * proposes at most one deployable app, on that host (or on none). Everything here is a PRE-FILL: nothing is
 * written until an admin confirms it (`POST …/repos/:owner/:name/one-service`).
 */
export interface OneServiceOfferDTO {
  /** The one host the signals name. */
  provider: HostingProviderId;
  /** What was seen, in words ("GitHub check runs posted by the Cloudflare app"). Carries GitHub text — escape it. */
  evidence: string;
  /** The pending suggestion it builds on (accepted with it), or null when the scan proposed nothing. */
  suggestion: string | null;
  /** The app key to create (the suggestion's, else one from the repository's name). */
  key: string;
  folder: string;
  kind: AppKind;
  /** The host's part settings the scan read (a Worker name, D1 ids, crons) — prefilled, the person may change them. */
  settings: Record<string, string>;
  /** The environment it goes in: the one called production, else the only one, else a new `production`. Its URL
   *  and health path prefill from what is stored ("" / "" when nothing is). */
  env: { key: string; label: string; branch: string; exists: boolean; url: string; health_path: string };
}

/** `POST /api/o/:slug/repos/:owner/:name/one-service` — the one step, confirmed. */
export interface OneServiceWrite {
  provider: HostingProviderId;
  /** The app key (also every part key of it). */
  key: string;
  /** The production URL: https, no query string. Health is read from it (plus `health_path`). */
  url: string;
  /** Optional; "" or absent = the URL itself. Starts with /. */
  health_path?: string;
  /** The branch production deploys from — used only when the environment is created. */
  branch?: string;
  /** The host's part settings (its own keys only). */
  settings: Record<string, string>;
  /** The pending suggestion this confirms, if any — marked accepted. */
  suggestion?: string | null;
}

export interface OneServiceResult {
  env: { key: string; created: boolean };
  app: RepoApp;
  part: { env: string; key: string; provider: HostingProviderId };
}

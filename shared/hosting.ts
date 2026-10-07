// Hosting providers (issues #97–#102): the ONE contract the Worker (src/hosting/) and the SPA share for
// "which host runs each part of each environment, how Trov is connected to it, and what it reported".
// Zod-free on purpose — the SPA imports the vocabularies below as VALUES (the `*-core.ts` rule).
//
// The model, in four nouns:
//   provider    a host Trov can read (Cloudflare, Railway, Vercel, Render, Netlify, Fly.io; AWS later). A
//               provider is CODE (src/hosting/providers/*), described to the SPA by `HostingProviderDTO`.
//   connection  how an ORG is connected to a provider: an installed integration, an OAuth grant, or a pasted
//               token — one per (org, provider) for every provider whose credential is org-wide. The secret
//               itself lives in `org_secrets` (write-only, src/data/secrets.ts) like every other credential.
//   part        one deployable of one environment (web, api, worker…), pointing at a provider and that
//               provider's per-part settings (project / service / site id, app name). `org_environment_parts`
//               holds them; an environment's Cloudflare frontend and Railway backend are LEGACY parts, read
//               from (and written to) the environment's own columns, so SaplingLearn changes nothing.
//   reading     what a poll brought back, NORMALISED: hourly `hx_<metric>` points in `repo_metrics`
//               (env = environment key, part = part key) and deploy rows in `hosting_deploys`.
//
// Nothing here ever carries a secret's value: the API is write-only, as for every integration.

import type { IntegrationKind } from "./integrations";
import type { RepoRange, RepoSection, RepoTone } from "./repo";

// ── vocabularies ────────────────────────────────────────────────────────────

/** Every provider Trov knows, in the order the picker lists them. `aws` is described but not pollable yet. */
export const HOSTING_PROVIDERS = ["cloudflare", "railway", "vercel", "render", "netlify", "fly", "aws"] as const;
export type HostingProviderId = (typeof HOSTING_PROVIDERS)[number];
export const isHostingProvider = (v: unknown): v is HostingProviderId =>
  typeof v === "string" && (HOSTING_PROVIDERS as readonly string[]).includes(v);

/** The `org_secrets.kind` each provider's credential is stored under. Cloudflare and Railway keep the kinds
 *  they had before providers existed, so their stored credentials are untouched. */
export const HOSTING_INTEGRATION_KIND = {
  cloudflare: "cloudflare_analytics", railway: "railway", vercel: "vercel", render: "render", netlify: "netlify", fly: "fly", aws: "aws",
} as const satisfies Record<HostingProviderId, IntegrationKind>;
export const providerOfKind = (kind: IntegrationKind): HostingProviderId | null =>
  (Object.keys(HOSTING_INTEGRATION_KIND) as HostingProviderId[]).find((p) => HOSTING_INTEGRATION_KIND[p] === kind) ?? null;

/** The providers whose part is stored in `org_environments`' own columns (one per environment, fixed key). */
export const LEGACY_PART_KEY = { cloudflare: "frontend", railway: "backend" } as const;
export type LegacyProviderId = keyof typeof LEGACY_PART_KEY;
export const isLegacyProvider = (p: HostingProviderId): p is LegacyProviderId => p === "cloudflare" || p === "railway";

/**
 * What a part IS, which decides the metric family the dashboard shows for it:
 *   web      serves HTTP to people — requests, errors, latency, bandwidth (a CDN / edge / static site / SSR app)
 *   service  a long-running process — CPU and memory (a container, a VM, a machine)
 * A provider declares which roles it can serve; a part has exactly one.
 */
export const PART_ROLES = ["web", "service"] as const;
export type PartRole = (typeof PART_ROLES)[number];
export const isPartRole = (v: unknown): v is PartRole => v === "web" || v === "service";

/** A part key: what `repo_metrics.part` / `hosting_deploys.part` store. Same alphabet as an environment key. */
export const PART_KEY_RE = /^[a-z0-9_-]{1,32}$/;
export const MAX_PARTS_PER_ENVIRONMENT = 6;

/**
 * How an org connects to a provider, BEST FIRST (#97, comment): an installable integration scoped to chosen
 * projects, then an OAuth app, then a pasted token with the narrowest scope the provider has. `assume_role`
 * is AWS's cross-account IAM role (later). A provider lists only the methods it really offers; a method that
 * needs platform configuration Trov's operator has not done (an integration's client id) is listed with
 * `available: false` and the screen falls back to the next one.
 */
export const CONNECTION_METHODS = ["install", "oauth", "token", "assume_role"] as const;
export type ConnectionMethod = (typeof CONNECTION_METHODS)[number];

/**
 * The normalised metric vocabulary — what the dashboard reads, whoever produced it. Stored as
 * `hx_<metric>` in `repo_metrics`, one point per COMPLETE UTC hour (`at` = the hour's start), first write
 * wins. `sum` metrics add across hours (a range total is their sum); `gauge` metrics do not (a range shows
 * the latest / the series). `errors` counts SERVER errors (5xx) — a 4xx is the client's.
 */
export const HOSTING_METRICS = {
  requests: { role: "web", agg: "sum", unit: "count", label: "Requests" },
  errors: { role: "web", agg: "sum", unit: "count", label: "Server errors" },
  latency_p50_ms: { role: "web", agg: "gauge", unit: "ms", label: "Latency p50" },
  latency_p95_ms: { role: "web", agg: "gauge", unit: "ms", label: "Latency p95" },
  bandwidth_bytes: { role: "web", agg: "sum", unit: "bytes", label: "Bandwidth" },
  cpu: { role: "service", agg: "gauge", unit: "vcpu", label: "CPU" },
  mem_mb: { role: "service", agg: "gauge", unit: "mb", label: "Memory" },
} as const satisfies Record<string, { role: PartRole; agg: "sum" | "gauge"; unit: "count" | "ms" | "bytes" | "vcpu" | "mb"; label: string }>;
export type HostingMetric = keyof typeof HOSTING_METRICS;
export const HOSTING_METRIC_KEYS = Object.keys(HOSTING_METRICS) as HostingMetric[];
export const isHostingMetric = (v: unknown): v is HostingMetric => typeof v === "string" && v in HOSTING_METRICS;
/** The `repo_metrics.metric` a normalised point is stored under. */
export const HOSTING_METRIC_PREFIX = "hx_";
export const hostingMetricName = (m: HostingMetric): string => `${HOSTING_METRIC_PREFIX}${m}`;
export const metricsForRole = (role: PartRole): HostingMetric[] => HOSTING_METRIC_KEYS.filter((m) => HOSTING_METRICS[m].role === role);

/**
 * A deploy's state, normalised. `queued` / `building` are in flight; `ready` landed; `error` failed;
 * `canceled` was abandoned (never counted as a failure — the Repo dashboard's one non-decisive policy).
 */
export const DEPLOY_STATES = ["queued", "building", "ready", "error", "canceled"] as const;
export type DeployState = (typeof DEPLOY_STATES)[number];
export const isDeployState = (v: unknown): v is DeployState => typeof v === "string" && (DEPLOY_STATES as readonly string[]).includes(v);
/** Where a deploy went: the provider's production target, a preview / branch deploy, or unknown. */
export type DeployTarget = "production" | "preview" | null;

// ── Org settings › Hosting: the provider catalogue ──────────────────────────

/** A non-secret field an admin fills: an org-wide provider setting (team id, org slug) or a part setting. */
export interface HostingFieldDTO {
  key: string;
  label: string;
  description: string;      // one line: what it is and where to find it
  required: boolean;
  placeholder: string | null;
  /** A JS regex source the value must match (checked again on the Worker); null = any single line. */
  pattern: string | null;
}

export interface ConnectionMethodDTO {
  method: ConnectionMethod;
  /** The button / tab label: "Connect with Vercel", "Paste an access token". */
  label: string;
  /** false: this method exists but this Trov deployment cannot offer it (e.g. no integration client id). */
  available: boolean;
  unavailable_reason: string | null;
  /** Where an admin gets the credential and the NARROWEST permission that works (token), or what the
   *  install / consent screen will ask for (install, oauth). */
  how_to: string;
  /** What the provider's consent screen grants Trov — shown before the redirect. */
  grants: string[];
}

export interface HostingProviderDTO {
  id: HostingProviderId;
  label: string;
  /** `later`: described so the picker can show it, but it cannot be chosen yet (AWS). */
  status: "available" | "later";
  /** One line for the picker. */
  summary: string;
  roles: PartRole[];
  /** What a part on this provider can show. `deploys` false = deploy status reaches Trov only through GitHub. */
  capabilities: { deploys: boolean; metrics: HostingMetric[] };
  /** A plan / add-on caveat ("Usage needs Observability Plus"), or null. */
  plan_note: string | null;
  /** The ONLY hosts the credential is ever sent to — shown under the form ("Sent only to api.vercel.com"). */
  api_hosts: string[];
  /** `org`: one credential for the whole org (scope ""); `environment`: one per environment (Railway). */
  credential_scope: "org" | "environment";
  /** Best first. The screen offers the first AVAILABLE one and lists the rest as alternatives. */
  connection_methods: ConnectionMethodDTO[];
  /** Org-wide, non-secret settings stored beside the credential (`org_integration_config`). */
  org_config_fields: HostingFieldDTO[];
  /** What a part on this provider needs (project id, service id, site id, app name…). */
  part_settings: HostingFieldDTO[];
  docs_url: string;
  /** Legacy providers live in the environment's own columns: one part per environment, fixed key. */
  legacy_part_key: string | null;
}

// ── Org settings › Hosting: an org's connections and parts ──────────────────

export type ConnectionStatus = "connected" | "not_connected" | "error" | "revoked";

/**
 * Why an install / OAuth connection ended — `org_hosting_connections.revoked_reason` (0044 CHECKs it). The row
 * stores the CODE only; the sentence a person reads is derived from it (`hostingRevokedReasonText`):
 *   disconnected  an admin disconnected it in Trov (Disconnect, or deleting the credential on Integrations)
 *   uninstalled   the provider said it was removed on its side (the verified uninstall notice)
 *   superseded    a pasted token replaced it (Integrations)
 *   refused       Test connection got a 401 for it: the grant was revoked or removed on the provider's side
 */
export const HOSTING_REVOKED_REASONS = ["disconnected", "uninstalled", "superseded", "refused"] as const;
export type HostingRevokedReason = (typeof HOSTING_REVOKED_REASONS)[number];
export const isHostingRevokedReason = (v: unknown): v is HostingRevokedReason =>
  typeof v === "string" && (HOSTING_REVOKED_REASONS as readonly string[]).includes(v);

/** The sentence `HostingConnectionDTO.revoked_reason` carries for a stored code. */
export function hostingRevokedReasonText(reason: HostingRevokedReason, providerLabel: string): string {
  switch (reason) {
    case "disconnected": return "Disconnected in Trov";
    case "uninstalled": return `Removed on ${providerLabel}`;
    case "superseded": return "Replaced by a pasted token";
    case "refused": return `${providerLabel} refused the token — the grant was revoked or removed there`;
  }
}

/**
 * How an install / OAuth return ended — `GET /hosting/:provider/callback` always redirects, to
 * `/o/<slug>/?hosting=<outcome>&provider=<id>#org` (or `/?hosting=<outcome>` when the sealed intent could not be
 * read). ONE vocabulary; the SPA words each code, and nothing from the provider ever rides along:
 *   connected            stored and bound to the org
 *   expired              no intent of ours, a state that does not match it, another provider's, or too late
 *   wrong_person         a different person is signed in than the one who started
 *   not_admin            the person is no longer an admin of that org
 *   denied               the person declined on the provider's page
 *   not_configured       this deployment has no integration for the provider (any more)
 *   exchange_failed      no code, or the provider would not exchange it for a usable credential
 *   secrets_unavailable  the platform key is missing: no credential can be stored right now
 *   taken                that installation is already connected to ANOTHER Trov org
 *   already_connected    this org got another install / OAuth connection meanwhile — disconnect it first
 *   unknown_provider     the return named a provider Trov does not know (or one with no install)
 *   failed               anything else
 */
export const HOSTING_CONNECT_OUTCOMES = [
  "connected", "expired", "wrong_person", "not_admin", "denied", "not_configured", "exchange_failed", "secrets_unavailable",
  "taken", "already_connected", "unknown_provider", "failed",
] as const;
export type HostingConnectOutcome = (typeof HOSTING_CONNECT_OUTCOMES)[number];
export const isHostingConnectOutcome = (v: unknown): v is HostingConnectOutcome =>
  typeof v === "string" && (HOSTING_CONNECT_OUTCOMES as readonly string[]).includes(v);

export interface HostingConnectionDTO {
  provider: HostingProviderId;
  /** "" for an org-wide credential; the environment key for a per-environment one (Railway). */
  scope: string;
  scope_label: string | null;
  status: ConnectionStatus;
  /** How it is connected now; null when it is not. */
  method: ConnectionMethod | null;
  /** The provider-side account the grant belongs to (a Vercel team, a Netlify user) — never a secret. */
  account: { id: string | null; label: string | null } | null;
  /** The provider-side id of the installation (Vercel `configurationId`) — needed to disconnect from Trov's side. */
  external_id: string | null;
  config: Record<string, string>;
  hint_last4: string;
  connected_by: string | null;
  connected_at: string | null;
  last_used_at: string | null;
  /** Scrubbed, ≤ 300 characters; null after a success. */
  last_error: string | null;
  /** SaplingLearn's cut-over only: a legacy Worker secret answers for it. */
  legacy_fallback: boolean;
  /** Why it was revoked, when `status` is `revoked` — display text derived from the stored code
   *  (`hostingRevokedReasonText`: "Removed on Vercel", "Disconnected in Trov"). */
  revoked_reason: string | null;
  /** Where an admin manages this grant on the provider's side (Vercel's integrations page, Netlify's
   *  applications, a token page), or null when the provider has no such page Trov can name. */
  manage_url: string | null;
  /** The parts that use this connection — an unused connection can be disconnected without breaking anything. */
  used_by: { env: string; part: string }[];
}

/** The last poll of one part (`hosting_poll_state`) — what the setup screen and the dashboard say about it. */
export interface PartPollStateDTO {
  at: string;
  status: "ok" | "failed" | "skipped";
  /** Scrubbed reason (failed), what is missing (skipped), or what was written (ok). */
  detail: string | null;
  last_ok_at: string | null;
  /** The contiguous interval the polls have covered — inside it, an hour with no point is a true zero. */
  covered: { from: string; to: string } | null;
  /** Metrics the provider could not read for this part and why ("needs Netlify Analytics"). */
  unavailable: { metric: HostingMetric; reason: string }[];
}

export interface EnvironmentPartDTO {
  env: string;
  key: string;
  label: string;
  role: PartRole;
  provider: HostingProviderId;
  settings: Record<string, string>;
  position: number;
  /** true: the environment's own Cloudflare / Railway columns hold it (`LEGACY_PART_KEY`). */
  legacy: boolean;
  /** Is the part's provider connected for this part's scope? */
  connection: ConnectionStatus;
  /** A deep link to this part in the provider's own dashboard, or null when the settings do not make one. */
  console_url: string | null;
  last_poll: PartPollStateDTO | null;
  updated_at: string | null;
  updated_by: string | null;
}

export interface HostingEnvironmentDTO {
  key: string;
  label: string;
  branch: string;
  parts: EnvironmentPartDTO[];
}

/** One line of the setup checklist — generated from the providers the org's parts actually use. */
export interface HostingChecklistItem {
  id: string;
  title: string;
  detail: string | null;
  done: boolean;
  /** What the screen's button does for this item. */
  action:
    | { kind: "add_environment" }
    | { kind: "add_part"; env: string }
    | { kind: "connect"; provider: HostingProviderId; scope: string }
    | { kind: "configure"; provider: HostingProviderId; scope: string }
    | { kind: "edit_part"; env: string; part: string }
    | { kind: "test"; provider: HostingProviderId; scope: string }
    | { kind: "none" };
}

/** `GET /api/o/:slug/hosting` — the whole Hosting setup in one read (admin). */
export interface HostingSetupDTO {
  providers: HostingProviderDTO[];
  environments: HostingEnvironmentDTO[];
  connections: HostingConnectionDTO[];
  checklist: HostingChecklistItem[];
  /** false: TROV_KEK is unusable, so no credential can be saved (every write answers 503). */
  secrets_available: boolean;
}

/** `PUT /api/o/:slug/environments/:env/parts/:part` body. */
export interface PartWrite {
  provider: HostingProviderId;
  role?: PartRole;
  label?: string;
  settings?: Record<string, string>;
}

/** `POST /api/o/:slug/hosting/:provider/connect` → where to send the admin's browser. */
export interface ConnectStartDTO { url: string; method: "install" | "oauth"; expires_at: string }

/** `POST /api/o/:slug/hosting/:provider/test` (and per part). */
export interface HostingTestDTO { ok: boolean; detail: string; connection: HostingConnectionDTO }

// ── Repo dashboard › Usage: the provider-neutral section ────────────────────

/** One deploy, as a dot in a strip and as the card's "last deploy" line. */
export interface ProviderDeployDTO {
  id: string;
  state: DeployState;
  target: DeployTarget;
  sha: string | null;
  branch: string | null;
  /** The commit message's first line, when the provider reports it. */
  message: string | null;
  /** Who triggered it on the provider (a login or a name), when reported. */
  by: string | null;
  at: string;
  ready_at: string | null;
  /** The deployment's own URL (the preview / production URL). */
  url: string | null;
  /** The provider's page for this deploy (build log). */
  inspect_url: string | null;
}

/** A traffic figure for one range. `null` = unknown in this range (see `RepoProviderPart.seen`), never 0. */
export interface ProviderTrafficRange {
  requests: number | null;
  errors: number | null;
  /** errors ÷ requests × 100, a PERCENTAGE; null when there is no request point in range. */
  error_rate: number | null;
  latency_p95_ms: number | null;
  bandwidth_bytes: number | null;
  /** Dense buckets (1h for 24h, 1 day for 7d / 30d) oldest first; zero only inside covered hours. */
  trend: { at: string; requests: number; errors: number }[];
}

export interface ProviderResources {
  /** vCPU, the latest point ≤ 3 hours old, else null. */
  cpu: number | null;
  mem_mb: number | null;
  at: string | null;
  /** Hourly points over the last 24 h, oldest first, never zero-filled. */
  trend: { at: string; cpu: number | null; mem_mb: number | null }[];
}

export interface RepoProviderPart {
  env: string;
  env_label: string;
  part: string;
  label: string;
  role: PartRole;
  provider: HostingProviderId;
  provider_label: string;
  console_url: string | null;
  /** Newest first, ≤ 10, 90 days. */
  deploys: ProviderDeployDTO[];
  /** role `web` only. null for a service part — AND for a web part whose provider reads no traffic metric at all
   *  and never reported one (Vercel, Netlify): `unavailable` then says why. */
  traffic: Record<RepoRange, ProviderTrafficRange> | null;
  /** role `service` only; null for a web part. */
  resources: ProviderResources | null;
  /** Whether each source has EVER reported for this part inside the render's own read: traffic over the 30-day
   *  read, resources over the 24-hour read, deploys over the 90-day deploy read. */
  seen: { traffic: boolean; resources: boolean; deploys: boolean };
  unavailable: { metric: HostingMetric; reason: string }[];
  /** ok = something to show; empty = polled but nothing in range / stale; not_connected = never polled. */
  status: "ok" | "empty" | "not_connected";
  tone: RepoTone;
  last_poll: { at: string; status: "ok" | "failed" | "skipped"; detail: string | null } | null;
}

/** `RepoDashboard.providers`. */
export type RepoProvidersSection = RepoSection<RepoProviderPart[]>;

// ── Poll now ────────────────────────────────────────────────────────────────

/** One part's outcome from one hosting poll — `PollOutcome`'s shape, plus which part and provider. */
export interface HostingPollOutcome {
  env: string;
  part: string;
  provider: HostingProviderId;
  status: "ok" | "failed" | "skipped";
  /** New `repo_metrics` rows + new / changed `hosting_deploys` rows. */
  written: number;
  detail?: string;
}

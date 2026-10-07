// The hosting-provider interface (#97). A provider is a plain object in src/hosting/providers/<id>.ts,
// registered once in ./registry.ts. Everything a provider does goes through what it is HANDED:
//
//   - `pc.fetch` — the fixed-host fetch (./http.ts): it refuses any URL whose host is not one of the
//     provider's own `apiHosts`, never follows a redirect (a credential never crosses one), and times out.
//     A provider never calls the global `fetch`, never reads `env`, never reads D1.
//   - `pc.credential` — the decrypted credential (src/data/secrets.ts's `Secret`, seen here only as a
//     `SecretLike`: it prints as "[secret]"; `.reveal()` only at the line that builds the header) and the
//     org's non-secret config for this provider. This layer never imports src/data/secrets.ts (./http.ts).
//   - `pc.part` — the part being polled: its environment, role and per-part settings, ALREADY validated
//     against the provider's `partSettings` patterns.
//
// A provider returns NORMALISED data (`PollResult`) and the framework (./poll.ts) stores it: metric points
// through `putMetrics` (first write wins), deploys by upsert into `hosting_deploys`, the outcome into
// `hosting_poll_state`. So a provider is pure apart from its fetches, and its tests stub only `fetch`.
//
// THE RULES every provider keeps (pinned by test/hosting.contract.test.ts for every registered provider):
//   - Every message it returns or throws is scrubbed of the credential BEFORE it is cut (./http.ts helpers).
//   - Points are for COMPLETE hours only: `at` is an hour start strictly before the current hour's floor
//     (a count for a running hour would be stored short forever — first write wins). Values are finite, ≥ 0.
//   - A metric the provider cannot read for this part (plan, add-on, not enabled) goes in `unavailable`
//     with a reason, never as a zero.
//   - `pollCost` is the worst-case number of fetches one `poll` makes — the cron budgets with it.
import type {
  ConnectionMethod, DeployState, DeployTarget, HostingMetric, HostingProviderId, PartRole,
} from "@shared/hosting";
import type { HostFetch, SecretLike } from "./http";

/** A field an admin fills (an org-wide provider setting or a part setting). `pattern` is anchored. */
export interface HostingField {
  key: string;
  label: string;
  description: string;
  required: boolean;
  placeholder?: string;
  pattern?: RegExp;
}

export interface ConnectionMethodSpec {
  method: ConnectionMethod;
  label: string;
  howTo: string;
  /** What the provider's consent screen grants (install / oauth), or what the token can do (token). */
  grants: string[];
  /** Worker vars / secrets this method needs on Trov's side (an integration's client id + secret). Absent
   *  → the method is listed `available: false` and the screen falls back to the next one. */
  requires?: string[];
}

/** The part a provider is asked about. */
export interface PartRef {
  orgId: string;
  env: string;
  envLabel: string;
  branch: string;
  key: string;
  role: PartRole;
  settings: Readonly<Record<string, string>>;
}

export interface ProviderCredential {
  /** The org's credential for this provider (token, API key, installed access token). */
  secret: SecretLike;
  /** The org's non-secret settings for this provider (team id, org slug…) — `orgConfigFields`. */
  config: Readonly<Record<string, string>>;
}

export interface ProviderContext {
  fetch: HostFetch;
  credential: ProviderCredential;
  /** The current instant (ms). Windows key on its hour floor, so a re-poll asks for the same hours. */
  now: number;
}

export interface ProbeResult {
  ok: boolean;
  detail: string;
  /** The HTTP status the provider refused with, when the failure was an upstream refusal (`probeFailure`,
   *  ./http.ts). A 401 on an install / OAuth connection ends it at Test connection (src/integrations/probe.ts). */
  status?: number;
}

export interface HostingDeploy {
  /** The provider's deploy id — `hosting_deploys` is keyed (org, provider, id). */
  id: string;
  state: DeployState;
  target: DeployTarget;
  sha: string | null;
  branch: string | null;
  message: string | null;
  by: string | null;
  /** ISO. When the deploy was created. */
  createdAt: string;
  /** ISO. When it became ready (or finished failing), if known. */
  readyAt: string | null;
  url: string | null;
  inspectUrl: string | null;
}

export interface HostingPoint {
  metric: HostingMetric;
  /** ISO hour start of a COMPLETE hour. */
  at: string;
  value: number;
}

export interface PollResult {
  deploys: HostingDeploy[];
  points: HostingPoint[];
  unavailable: { metric: HostingMetric; reason: string }[];
  /** The hours the metric read covered [from, to) — inside it an hour with no point is a true zero.
   *  null when no metric was read (deploys only, or every metric unavailable). */
  covered: { from: string; to: string } | null;
}

/** What an install / OAuth code exchange yields — stored as the org's secret + connection row. */
export interface InstallGrant {
  accessToken: string;
  /** The provider's id for this installation (Vercel `configurationId`), if it has one. */
  externalId: string | null;
  /** The provider-side account the grant reaches (a team id / user id) and its display name. */
  accountId: string | null;
  accountLabel: string | null;
  /** Non-secret org config learned from the grant (Vercel's `team_id`) — merged into the org's config. */
  config: Record<string, string>;
}

export interface InstallSpec {
  /** The URL the admin's browser is sent to. `redirectUri` is Trov's callback; `state` is opaque. `vars` holds
   *  the values of the method's `requires` Worker vars (e.g. an integration's slug) — never a secret's. */
  authorizeUrl(args: { clientId: string; redirectUri: string; state: string; vars: Readonly<Record<string, string>> }): string;
  /** Exchange the callback's `code` (+ any extra query params the provider sends) for a grant. */
  exchange(args: {
    fetch: HostFetch; code: string; clientId: string; clientSecret: string; redirectUri: string; query: Readonly<Record<string, string>>;
  }): Promise<InstallGrant>;
  /** Remove the installation on the provider's side (Disconnect from Trov; a new grant the connect callback
   *  refuses). Optional: some have no API. `externalId` null = remove only what THIS credential is, never an
   *  installation — the callback passes null when the installation is another org's live one (`taken`), so a
   *  refusal there can never uninstall a connection someone else depends on. */
  revoke?(args: { fetch: HostFetch; secret: SecretLike; externalId: string | null; config: Readonly<Record<string, string>> }): Promise<void>;
  /** The Worker var / secret names holding this integration's client id and secret. */
  clientIdVar: string;
  clientSecretVar: string;
  /** The provider-side "uninstalled" notice (#97: "can be disconnected from either side"), delivered to
   *  `POST /webhook/hosting/<provider>`. Absent: the provider sends none, and a revoked grant shows up as a
   *  401 on the next poll instead. */
  webhook?: {
    /** Verify a delivery's signature over the RAW body with the integration's client secret. */
    verify(args: { rawBody: string; headers: Headers; clientSecret: string }): Promise<boolean>;
    /** The installation id a VERIFIED delivery says was removed, or null when it is about something else. */
    removedExternalId(payload: unknown): string | null;
  };
}

export interface HostingProvider {
  id: HostingProviderId;
  label: string;
  status: "available" | "later";
  summary: string;
  roles: readonly PartRole[];
  /** Exact hostnames the credential may be sent to. https only. */
  apiHosts: readonly string[];
  docsUrl: string;
  credentialScope: "org" | "environment";
  /** Best first. */
  connectionMethods: readonly ConnectionMethodSpec[];
  orgConfigFields: readonly HostingField[];
  partSettings: readonly HostingField[];
  capabilities: { deploys: boolean; metrics: readonly HostingMetric[] };
  planNote: string | null;
  /** Worst-case fetches of one `poll`. */
  pollCost: number;
  /** A deep link to the part in the provider's dashboard, from its settings and the org config — or null. */
  consoleUrl(part: Pick<PartRef, "settings">, config: Readonly<Record<string, string>>): string | null;
  /** Where an admin manages the org's GRANT on the provider's side (an integrations page, an applications
   *  page, a token page) for a connection made by `method`, from the org config — https, or null when there
   *  is no page Trov can name. `HostingConnectionDTO.manage_url`. Absent = null. */
  manageUrl?(config: Readonly<Record<string, string>>, method: ConnectionMethod): string | null;
  /** Test connection: the cheapest authenticated read that proves the credential (and, given a part, that
   *  its settings name something the credential can see). ONE or two fetches; writes nothing. */
  probe(pc: ProviderContext, part: PartRef | null): Promise<ProbeResult>;
  /** One poll of one part: recent deploys and the last few complete hours of metrics. Never throws for an
   *  upstream refusal — it throws `HostingError` (scrubbed) and the framework records it as `failed`. */
  poll(pc: ProviderContext, part: PartRef): Promise<PollResult>;
  /** Present when `connectionMethods` offers `install` or `oauth`. */
  install?: InstallSpec;
}

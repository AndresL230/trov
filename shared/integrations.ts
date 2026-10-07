// The wire shapes of Org settings › Integrations, Repositories and Environments
// (canopy-multitenancy.md §8.7; the routes are src/integrations/routes.ts). Types and the
// kind vocabulary only — nothing here ever carries a secret's value: the API is write-only.

export const INTEGRATION_KINDS = [
  "cloudflare_analytics", "railway", "metrics_endpoint", "github_token", "github_webhook",
  // The hosting providers (0043_hosting_providers, shared/hosting.ts): one org-wide credential each, expected
  // only once a part of one of the org's environments uses that provider.
  "vercel", "render", "netlify", "fly", "aws",
] as const;
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];
export const isIntegrationKind = (v: unknown): v is IntegrationKind =>
  typeof v === "string" && (INTEGRATION_KINDS as readonly string[]).includes(v);

/** What a kind's `scope` names: nothing (one per org, scope `""`), an environment key, or an `org_repos.id`. */
export type IntegrationScopeType = "org" | "environment" | "repo";

/** A non-secret setting an integration needs beside its credential (`PUT …/config`). */
export interface IntegrationConfigField {
  key: string;
  label: string;
  description: string;
  required: boolean;
}

/** One integration the org is EXPECTED to have (derived from its environments and repos), set or not. */
export interface IntegrationDTO {
  kind: IntegrationKind;
  scope: string;                      // "" | environment key | org_repos.id
  scope_type: IntegrationScopeType;
  scope_label: string | null;         // the environment's label / the repo's full name; null for an org-wide kind
  label: string;
  description: string;                // one line: what Trov uses it for
  how_to: string;                     // where an admin gets the credential, and the permissions it needs
  configured: boolean;
  /** SaplingLearn's cut-over only (§8.7.6): not configured here, but a Worker secret still answers for it. */
  legacy_fallback: boolean;
  /** false: a stored secret whose environment / repo no longer exists — it can only be deleted. */
  expected: boolean;
  hint_last4: string;                 // "" when unset, or when the secret is too short for 4 characters to be safe
  created_by: string | null;
  created_at: string | null;
  rotated_at: string | null;
  last_used_at: string | null;
  last_error: string | null;          // scrubbed, ≤ 300 characters; null after a success
  config: Record<string, string>;
  config_fields: IntegrationConfigField[];
  webhook_url: string | null;         // github_webhook only: the Payload URL to configure in GitHub
}

export interface IntegrationsListDTO {
  integrations: IntegrationDTO[];
  /** false: the platform's key (`TROV_KEK`) is missing or malformed — every write answers 503 `secrets_unavailable`. */
  secrets_available: boolean;
  /** The org's current data-key version; null until its first secret is stored. */
  key_version: number | null;
}

export type OrgAuditAction = "secret.set" | "secret.rotate" | "secret.delete" | "integration.config" | "key.rotate";

/** The repository / environment changes recorded beside the secret trail (`org_admin_audit`, shared/orgs.ts). */
export type OrgSettingsAuditAction =
  | "repo.add" | "repo.remove" | "repo.primary" | "environment.set" | "environment.delete" | "environment.reorder"
  // Hosting (0043_hosting_providers): a part set / removed, an install or OAuth grant connected, disconnected
  // from Trov, or revoked from the provider's side.
  | "part.set" | "part.delete" | "hosting.connect" | "hosting.disconnect" | "hosting.revoked";

/** One row of `GET /api/o/:slug/integrations/audit`: the secret trail and the repository / environment
 *  trail as ONE list, newest first. `id` is unique across both: `s<n>` (secrets) or `a<n>` (settings). */
export interface OrgAuditDTO {
  id: string;
  actor: string;
  action: OrgAuditAction | OrgSettingsAuditAction;
  target: string;                     // `${kind}:${scope}` / `org_keys`; a repo's `owner/name`; an environment key
  detail: Record<string, unknown>;    // { hint_last4?, key_version?, … } — never a secret
  at: string;
}

export interface IntegrationTestDTO {
  ok: boolean;
  detail: string;                     // scrubbed
  integration: IntegrationDTO;
}

export interface OrgRepoDTO {
  /** `org_repos.id` — the webhook path id and the `github_webhook` scope. null for a non-admin viewer. */
  id: string | null;
  repo_full_name: string;
  is_primary: boolean;
  legacy_hook: boolean;
  webhook_url: string | null;         // null for a non-admin viewer
  webhook_secret_configured: boolean;
  created_at: string;
  created_by: string;
}

export interface OrgEnvironmentDTO {
  key: string;
  position: number;                   // 0 = the drift head; the last = the drift base
  label: string;
  note: string | null;
  branch: string;
  railway_env: string;
  worker: string;
  worker_check: string;
  frontend_url: string;
  api_url: string;
  health_path: string;
  railway_environment_id: string | null;
  railway_service_id: string | null;
  created_at: string;
  updated_at: string;
  updated_by: string;
}

// What Org settings › Integrations lists (canopy-multitenancy.md §8.7.2, §8.7.3): the five kinds, the
// words the page shows for each, and the org's EXPECTED integrations — one row per kind and scope its
// environments and repos call for, `configured: false` until an admin sets it. Metadata only: this
// module never touches a secret's value.
import type { IntegrationConfigField, IntegrationDTO, IntegrationKind, IntegrationScopeType, IntegrationsListDTO } from "@shared/integrations";
import type { Env } from "../env";
import {
  currentKeyVersion, hasLegacyCredential, listIntegrationConfig, listSecretMeta, secretsAvailable,
  type IntegrationConfig, type SecretMeta,
} from "../data/secrets";
import type { TenantContext } from "../data/sql";
import { listEnvironments, listRepoRows, webhookUrl } from "./settings";
import { providerOfKind, type HostingProviderId } from "@shared/hosting";
import { checkFields, providerOf } from "../hosting/registry";

interface KindInfo {
  scope: IntegrationScopeType;
  label: string;
  description: string;
  how_to: string;
  config_fields: IntegrationConfigField[];
}

/** A hosting provider's kind, described from the provider itself (src/hosting/providers/*): its best TOKEN
 *  method's how-to (an install / OAuth connection is made from Org settings › Hosting, not pasted here). */
function hostingKind(id: Exclude<HostingProviderId, "cloudflare" | "railway">): KindInfo {
  const p = providerOf(id);
  const token = p.connectionMethods.find((m) => m.method === "token") ?? p.connectionMethods[0];
  return {
    scope: p.credentialScope === "environment" ? "environment" : "org",
    label: `${p.label} ${token?.method === "token" ? "token" : "connection"}`,
    description: p.summary,
    how_to: token?.howTo ?? "",
    config_fields: p.orgConfigFields.map((f) => ({ key: f.key, label: f.label, description: f.description, required: f.required })),
  };
}

export const INTEGRATION_CATALOG: Record<IntegrationKind, KindInfo> = {
  github_token: {
    scope: "org",
    label: "GitHub token",
    description: "Reads the primary repository — deployments, check runs, workflow runs, branches, drift, open pull requests and issue progress — for Sync GitHub, the scheduled reconcile and the webhook's follow-up reads.",
    how_to: "On GitHub open Settings › Developer settings › Personal access tokens › Fine-grained tokens and generate a token. Resource owner: the account that owns the repository. Repository access: only the primary repository. Repository permissions, all Read-only: Metadata, Contents, Pull requests, Issues, Actions, Deployments and Commit statuses. A classic token with the repo scope also works. Trov only reads with it and only ever sends it to api.github.com. It is an interim credential until Trov has a GitHub App.",
    config_fields: [],
  },
  github_webhook: {
    scope: "repo",
    label: "GitHub webhook secret",
    description: "Proves that a delivery to this repository's webhook URL came from GitHub: every delivery's HMAC-SHA256 signature is checked against it before anything is read.",
    how_to: "Generate a long random value (the Generate button, or `openssl rand -hex 32`). In the repository on GitHub open Settings › Webhooks › Add webhook: Payload URL = the webhook URL shown here, Content type = application/json, Secret = that value, events = Send me everything. Then save the same value here. Trov never shows it again — to change it, rotate it here and update the webhook on GitHub.",
    config_fields: [],
  },
  cloudflare_analytics: {
    scope: "org",
    label: "Cloudflare analytics",
    description: "Requests and error rate for each environment's frontend Worker, read hourly from Cloudflare's GraphQL Analytics API.",
    how_to: "In the Cloudflare dashboard open My Profile › API Tokens › Create Token › Create Custom Token and grant ONE permission: Account › Account Analytics › Read, limited to the account your frontend Workers live under. Paste the token here and set Account ID to that account's 32-character id (Workers & Pages › Overview). The token is only ever sent to api.cloudflare.com.",
    config_fields: [
      { key: "account_id", label: "Account ID", description: "The 32-character id of the Cloudflare account the frontend Workers live under. Not a secret.", required: true },
    ],
  },
  railway: {
    scope: "environment",
    label: "Railway project token",
    description: "CPU and memory of this environment's backend service, read hourly from Railway's API.",
    how_to: "In Railway open the project › Settings › Tokens and create a PROJECT token for this environment. A project token is bound to one environment of one project, so every environment needs its own; an account or team token will not work (it is sent as Project-Access-Token, not as a bearer). Railway has no read-only scope: this token can also change that environment, and one environment of one project is the narrowest Railway offers. The environment also needs its Railway environment id and service id (Org settings › Environments). The token is only ever sent to backboard.railway.com.",
    config_fields: [],
  },
  metrics_endpoint: {
    scope: "environment",
    label: "App metrics endpoint",
    description: "Active users and product counters for this environment, read hourly from your own backend at GET <API URL>/api/internal/metrics.",
    how_to: "Generate a long random value (`openssl rand -hex 32`), make your backend require it as `Authorization: Bearer <value>` on GET /api/internal/metrics, and save the same value here. The endpoint must answer 200 with JSON holding active_users: { \"24h\", \"7d\", \"30d\" } as whole numbers. The token is sent only to this environment's API URL, over https, and never across a redirect. Pointing the environment's API URL at another host removes this token.",
    config_fields: [],
  },
  vercel: hostingKind("vercel"),
  render: hostingKind("render"),
  netlify: hostingKind("netlify"),
  fly: hostingKind("fly"),
  aws: hostingKind("aws"),
};

/** Why a submitted config is refused for `kind` (`{ field, message }` — the value is never quoted), or the cleaned config. */
export function checkIntegrationConfig(kind: IntegrationKind, config: unknown): { config: IntegrationConfig } | { field: string; message: string } {
  const provider = providerOfKind(kind);
  if (provider && provider !== "cloudflare" && provider !== "railway") {
    // A hosting provider's settings are its own fields, patterns included (src/hosting/registry.ts).
    const fields = providerOf(provider).orgConfigFields;
    if (fields.length === 0) return { field: "config", message: "this integration has no settings" };
    const checked = checkFields(fields, config, "config");
    return "field" in checked ? checked : { config: checked.values };
  }
  const fields = INTEGRATION_CATALOG[kind].config_fields;
  if (fields.length === 0) return { field: "config", message: "this integration has no settings" };
  if (!config || typeof config !== "object" || Array.isArray(config)) return { field: "config", message: "config must be an object" };
  const given = config as Record<string, unknown>;
  if (Object.keys(given).some((k) => !fields.some((f) => f.key === k))) return { field: "config", message: "config has a setting this integration does not have" };
  const out: IntegrationConfig = {};
  for (const f of fields) {
    const v = given[f.key];
    if (v === undefined || v === null || v === "") {
      if (f.required) return { field: `config.${f.key}`, message: `${f.key} is required` };
      continue;
    }
    if (typeof v !== "string") return { field: `config.${f.key}`, message: `${f.key} must be a string` };
    out[f.key] = v.trim();
  }
  if (kind === "cloudflare_analytics" && !/^[0-9a-f]{32}$/i.test(out.account_id)) {
    return { field: "config.account_id", message: "account_id must be the 32-character hexadecimal Cloudflare account id" };
  }
  if (kind === "cloudflare_analytics") out.account_id = out.account_id.toLowerCase();
  return { config: out };
}

interface Slot { kind: IntegrationKind; scope: string; scope_label: string | null; webhook_url: string | null; expected: boolean }

/** The org's expected (kind, scope) slots, in page order, then any stored secret none of them claims. */
async function slots(ctx: TenantContext, origin: string, secrets: SecretMeta[]): Promise<Slot[]> {
  const [repos, envs] = [await listRepoRows(ctx), await listEnvironments(ctx)];
  const out: Slot[] = [
    { kind: "github_token", scope: "", scope_label: null, webhook_url: null, expected: true },
    ...repos.map((r): Slot => ({ kind: "github_webhook", scope: r.id, scope_label: r.repo_full_name, webhook_url: webhookUrl(origin, r.id), expected: true })),
    { kind: "cloudflare_analytics", scope: "", scope_label: null, webhook_url: null, expected: true },
    ...envs.flatMap((e): Slot[] => [
      { kind: "railway", scope: e.key, scope_label: e.label, webhook_url: null, expected: true },
      { kind: "metrics_endpoint", scope: e.key, scope_label: e.label, webhook_url: null, expected: true },
    ]),
  ];
  for (const s of secrets) {
    if (!out.some((o) => o.kind === s.kind && o.scope === s.scope)) out.push({ kind: s.kind, scope: s.scope, scope_label: null, webhook_url: null, expected: false });
  }
  return out;
}

async function describe(ctx: TenantContext, env: Env, slot: Slot, secrets: SecretMeta[], configs: Awaited<ReturnType<typeof listIntegrationConfig>>): Promise<IntegrationDTO> {
  const info = INTEGRATION_CATALOG[slot.kind];
  const meta = secrets.find((s) => s.kind === slot.kind && s.scope === slot.scope) ?? null;
  return {
    kind: slot.kind,
    scope: slot.scope,
    scope_type: info.scope,
    scope_label: slot.scope_label,
    label: info.label,
    description: info.description,
    how_to: info.how_to,
    configured: meta !== null,
    legacy_fallback: meta === null && (await hasLegacyCredential(ctx, env, slot.kind, slot.scope)),
    expected: slot.expected,
    hint_last4: meta?.hint_last4 ?? "",
    created_by: meta?.created_by ?? null,
    created_at: meta?.created_at ?? null,
    rotated_at: meta?.rotated_at ?? null,
    last_used_at: meta?.last_used_at ?? null,
    last_error: meta?.last_error ?? null,
    config: configs.find((c) => c.kind === slot.kind && c.scope === slot.scope)?.config ?? {},
    config_fields: info.config_fields,
    webhook_url: slot.webhook_url,
  };
}

/** `GET /api/o/:slug/integrations`. */
export async function listIntegrations(ctx: TenantContext, env: Env, origin: string): Promise<IntegrationsListDTO> {
  const [secrets, configs] = [await listSecretMeta(ctx), await listIntegrationConfig(ctx)];
  const integrations: IntegrationDTO[] = [];
  for (const slot of await slots(ctx, origin, secrets)) integrations.push(await describe(ctx, env, slot, secrets, configs));
  return { integrations, secrets_available: await secretsAvailable(env), key_version: await currentKeyVersion(ctx) };
}

/** The metadata row every write answers with — also for a (kind, scope) the org no longer expects. */
export async function integrationRow(ctx: TenantContext, env: Env, origin: string, kind: IntegrationKind, scope: string): Promise<IntegrationDTO> {
  const [secrets, configs] = [await listSecretMeta(ctx), await listIntegrationConfig(ctx)];
  const slot = (await slots(ctx, origin, secrets)).find((s) => s.kind === kind && s.scope === scope)
    ?? { kind, scope, scope_label: null, webhook_url: null, expected: false };
  return describe(ctx, env, slot, secrets, configs);
}

/** Does the org have the environment / repo a scoped kind's `scope` names? (`""` for an org-wide kind.) */
export async function scopeExists(ctx: TenantContext, kind: IntegrationKind, scope: string): Promise<boolean> {
  switch (INTEGRATION_CATALOG[kind].scope) {
    case "org": return scope === "";
    case "environment": return (await listEnvironments(ctx)).some((e) => e.key === scope);
    case "repo": return (await listRepoRows(ctx)).some((r) => r.id === scope);
  }
}

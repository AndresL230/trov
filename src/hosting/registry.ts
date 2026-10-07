// THE provider registry (#97): every hosting provider Trov knows, by id. Adding a provider = one file in
// ./providers/ + one line here (+ its kind in shared/integrations.ts and 0047's org_secrets CHECK). Pure
// metadata and pure checks — this module reads no D1 and no secret, so the Repo dashboard projection (which
// is reachable from src/mcp.ts) may import it. See ./http.ts for why that matters.
import {
  HOSTING_PROVIDERS, type ConnectionMethodDTO, type HostingFieldDTO, type HostingProviderDTO, type HostingProviderId,
  LEGACY_PART_KEY, isLegacyProvider,
} from "@shared/hosting";
import type { HostingField, HostingProvider } from "./types";
import { cloudflare } from "./providers/cloudflare";
import { railway } from "./providers/railway";
import { vercel } from "./providers/vercel";
import { render } from "./providers/render";
import { netlify } from "./providers/netlify";
import { fly } from "./providers/fly";
import { aws } from "./providers/aws";

export const PROVIDERS: Readonly<Record<HostingProviderId, HostingProvider>> = { cloudflare, railway, vercel, render, netlify, fly, aws };

export const providerOf = (id: HostingProviderId): HostingProvider => PROVIDERS[id];

/** Every provider in picker order. */
export const allProviders = (): HostingProvider[] => HOSTING_PROVIDERS.map((id) => PROVIDERS[id]);

/** A Worker var / secret is set (non-empty string). The registry reads names only — never logs a value. */
const hasVar = (env: unknown, name: string): boolean => {
  const v = (env as Record<string, unknown> | null | undefined)?.[name];
  return typeof v === "string" && v.length > 0;
};

const fieldDTO = (f: HostingField): HostingFieldDTO => ({
  key: f.key, label: f.label, description: f.description, required: f.required,
  placeholder: f.placeholder ?? null, pattern: f.pattern ? f.pattern.source : null,
});

/** The wire description of a provider. `env` decides which connection methods this deployment can offer. */
export function providerDTO(p: HostingProvider, env: unknown): HostingProviderDTO {
  const methods: ConnectionMethodDTO[] = p.connectionMethods.map((m) => {
    const missing = (m.requires ?? []).filter((name) => !hasVar(env, name));
    return {
      method: m.method, label: m.label, how_to: m.howTo, grants: [...m.grants],
      available: p.status === "available" && missing.length === 0,
      unavailable_reason: p.status !== "available" ? `${p.label} is not supported yet`
        : missing.length ? `this Trov deployment has no ${p.label} integration configured` : null,
    };
  });
  return {
    id: p.id, label: p.label, status: p.status, summary: p.summary, roles: [...p.roles],
    capabilities: { deploys: p.capabilities.deploys, metrics: [...p.capabilities.metrics] },
    plan_note: p.planNote, api_hosts: [...p.apiHosts], credential_scope: p.credentialScope,
    connection_methods: methods,
    org_config_fields: p.orgConfigFields.map(fieldDTO),
    part_settings: p.partSettings.map(fieldDTO),
    docs_url: p.docsUrl,
    legacy_part_key: isLegacyProvider(p.id) ? LEGACY_PART_KEY[p.id] : null,
  };
}

export type FieldCheck = { values: Record<string, string> } | { field: string; message: string };

/**
 * Check submitted values against a field list: an object of strings, no unknown key, every required one
 * present, each trimmed, one line, ≤ 200 characters and matching its pattern. The message names the field
 * and the rule, never the value. `prefix` names the body field in the error (`settings` / `config`).
 */
export function checkFields(fields: readonly HostingField[], given: unknown, prefix: string): FieldCheck {
  if (given === undefined || given === null) given = {};
  if (typeof given !== "object" || Array.isArray(given)) return { field: prefix, message: `${prefix} must be an object` };
  const obj = given as Record<string, unknown>;
  if (Object.keys(obj).some((k) => !fields.some((f) => f.key === k))) return { field: prefix, message: `${prefix} has a key this provider does not use` };
  const values: Record<string, string> = {};
  for (const f of fields) {
    const raw = obj[f.key];
    if (raw === undefined || raw === null || raw === "") {
      if (f.required) return { field: `${prefix}.${f.key}`, message: `${f.label} is required` };
      continue;
    }
    if (typeof raw !== "string") return { field: `${prefix}.${f.key}`, message: `${f.label} must be text` };
    const v = raw.trim();
    if (v.length > 200) return { field: `${prefix}.${f.key}`, message: `${f.label} is longer than 200 characters` };
    if (/[\u0000-\u001f\u007f]/.test(v)) return { field: `${prefix}.${f.key}`, message: `${f.label} contains a control character` };
    if (f.pattern && !f.pattern.test(v)) return { field: `${prefix}.${f.key}`, message: `${f.label} is not in the expected form` };
    if (v) values[f.key] = v;
  }
  return { values };
}

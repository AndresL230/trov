// Org settings › Hosting, read in ONE request (`GET /api/o/:slug/hosting`, admin+): the provider catalogue,
// every environment with its parts (legacy and stored, each with its connection state, a console link and
// its last poll), the org's connections, and a setup CHECKLIST generated from what the parts actually use —
// so an org on Vercel alone is never asked to connect Railway.
//
// Reads only: the parts (./parts.ts), the connections (./connections.ts), the last-poll rows the hosting poll
// job writes (`hosting_poll_state` — a legacy part has none: the usage job keeps no per-part state), and the
// org's non-secret provider config (Cloudflare's account id falls back to SaplingLearn's legacy var, as the
// poller's does). Nothing here reveals a credential.
import {
  HOSTING_INTEGRATION_KIND, HOSTING_PROVIDERS, isHostingMetric,
  type ConnectionStatus, type EnvironmentPartDTO, type HostingChecklistItem, type HostingConnectionDTO, type HostingEnvironmentDTO,
  type HostingMetric, type HostingProviderId, type HostingSetupDTO, type PartPollStateDTO,
} from "@shared/hosting";
import { requireRole } from "../data/context";
import { resolveCloudflareAccountId, secretsAvailable } from "../data/secrets";
import { all, type TenantContext } from "../data/sql";
import type { Env } from "../env";
import { listEnvironments } from "../integrations/settings";
import { credentialScopeOf, listConnections, loadConnectionState, type ConnectionState } from "./connections";
import type { PartRow } from "./parts";
import type { ProviderMap } from "./part-writes";
import { PROVIDERS, providerDTO } from "./registry";
import type { HostingProvider } from "./types";

interface PollRow {
  env: string; part: string; provider: string; polled_at: string; status: "ok" | "failed" | "skipped"; detail: string | null;
  last_ok_at: string | null; covered_from: string | null; covered_to: string | null; unavailable: string;
}

const listPollRows = (ctx: TenantContext): Promise<PollRow[]> =>
  all<PollRow>(ctx, `SELECT env, part, provider, polled_at, status, detail, last_ok_at, covered_from, covered_to, unavailable
    FROM hosting_poll_state WHERE org_id = ?`, ctx.orgId);

function unavailableOf(json: string): { metric: HostingMetric; reason: string }[] {
  try {
    const v = JSON.parse(json) as unknown;
    if (!Array.isArray(v)) return [];
    return v.flatMap((x) => {
      const o = x as { metric?: unknown; reason?: unknown } | null;
      return o && isHostingMetric(o.metric) && typeof o.reason === "string" ? [{ metric: o.metric, reason: o.reason }] : [];
    });
  } catch { return []; }
}

const pollDTO = (r: PollRow): PartPollStateDTO => ({
  at: r.polled_at,
  status: r.status,
  detail: r.detail,
  last_ok_at: r.last_ok_at,
  covered: r.covered_from && r.covered_to ? { from: r.covered_from, to: r.covered_to } : null,
  unavailable: unavailableOf(r.unavailable),
});

/** The org's non-secret config per (provider, scope), as the pollers see it: Cloudflare's account id falls back
 *  to SaplingLearn's legacy Worker var (`resolveCloudflareAccountId`), exactly as the usage job's does. */
async function effectiveConfigs(ctx: TenantContext, env: Env, s: ConnectionState): Promise<(provider: HostingProviderId, scope: string) => Record<string, string>> {
  const cfAccount = await resolveCloudflareAccountId(ctx, env);
  return (provider, scope) => {
    const stored = s.configs.find((c) => c.kind === HOSTING_INTEGRATION_KIND[provider] && c.scope === scope)?.config ?? {};
    return provider === "cloudflare" && cfAccount ? { ...stored, account_id: cfAccount } : stored;
  };
}

/** A part's connection, as the part sees it: a credential stored for its (provider, scope) — or, for
 *  SaplingLearn's cut-over, a legacy Worker secret that answers for it — reads `connected`. */
function partConnection(connections: HostingConnectionDTO[], provider: HostingProvider, part: PartRow): ConnectionStatus {
  const c = connections.find((x) => x.provider === provider.id && x.scope === credentialScopeOf(provider, part));
  if (!c) return "not_connected";
  return c.status === "not_connected" && c.legacy_fallback ? "connected" : c.status;
}

function consoleUrlOf(provider: HostingProvider, part: PartRow, config: Record<string, string>): string | null {
  try {
    const url = provider.consoleUrl({ settings: part.settings }, config);
    return typeof url === "string" && url.startsWith("https://") ? url : null;
  } catch { return null; }
}

interface PartContext {
  providers: ProviderMap;
  connections: HostingConnectionDTO[];
  config: (provider: HostingProviderId, scope: string) => Record<string, string>;
  polls: PollRow[];
}

function partDTO(x: PartContext, part: PartRow): EnvironmentPartDTO {
  const provider = x.providers[part.provider];
  const poll = part.legacy ? null : x.polls.find((r) => r.env === part.env && r.part === part.key && r.provider === part.provider) ?? null;
  return {
    env: part.env,
    key: part.key,
    label: part.label,
    role: part.role,
    provider: part.provider,
    settings: { ...part.settings },
    position: part.position,
    legacy: part.legacy,
    connection: partConnection(x.connections, provider, part),
    console_url: consoleUrlOf(provider, part, x.config(part.provider, credentialScopeOf(provider, part))),
    last_poll: poll ? pollDTO(poll) : null,
    updated_at: part.updatedAt,
    updated_by: part.updatedBy,
  };
}

async function partContext(ctx: TenantContext, env: Env, providers: ProviderMap, s: ConnectionState): Promise<PartContext> {
  return { providers, connections: await listConnections(ctx, env, providers, s), config: await effectiveConfigs(ctx, env, s), polls: await listPollRows(ctx) };
}

/** Parts as the wire describes them — what a part write answers with. */
export async function describeParts(ctx: TenantContext, env: Env, parts: PartRow[], providers: ProviderMap = PROVIDERS): Promise<EnvironmentPartDTO[]> {
  const x = await partContext(ctx, env, providers, await loadConnectionState(ctx));
  return parts.map((p) => partDTO(x, p));
}

// ── the checklist ────────────────────────────────────────────────────────────

const scopeWords = (c: HostingConnectionDTO): string => (c.scope ? ` for ${c.scope_label ?? c.scope}` : "");

/**
 * The setup checklist, from what the org's parts USE (never every provider Trov knows). In order: an
 * environment; a part in each environment; each part's missing required settings; then, per (provider, scope)
 * a part uses: connect it, fill its required org-wide settings, and test it until it has answered once.
 * Ids are stable for a given step (`connect:vercel:`, `edit_part:staging/web`), so the screen can key on them.
 */
export function buildChecklist(
  envs: { key: string; label: string }[], parts: PartRow[], connections: HostingConnectionDTO[], providers: ProviderMap,
  config: (provider: HostingProviderId, scope: string) => Record<string, string>,
): HostingChecklistItem[] {
  const items: HostingChecklistItem[] = [{
    id: "add_environment", title: "Add an environment",
    detail: "An environment is a branch that deploys somewhere — staging, production. Its parts are what runs it.",
    done: envs.length > 0, action: envs.length > 0 ? { kind: "none" } : { kind: "add_environment" },
  }];
  if (envs.length === 0) return items;

  for (const e of envs) {
    const has = parts.some((p) => p.env === e.key);
    items.push({
      id: `add_part:${e.key}`, title: `Add a part to ${e.label}`,
      detail: "A part is one deployable of the environment — web, api, worker — and the host it runs on.",
      done: has, action: has ? { kind: "none" } : { kind: "add_part", env: e.key },
    });
  }

  for (const part of parts) {
    const provider = providers[part.provider];
    const missing = provider.partSettings.filter((f) => f.required && !part.settings[f.key]);
    if (missing.length === 0) continue;
    items.push({
      id: `edit_part:${part.env}/${part.key}`,
      title: `Set the ${provider.label} ${missing[0].label} for ${part.envLabel} › ${part.label}`,
      detail: missing.length > 1 ? `Also missing: ${missing.slice(1).map((f) => f.label).join(", ")}.` : missing[0].description,
      done: false, action: { kind: "edit_part", env: part.env, part: part.key },
    });
  }

  for (const c of connections) {
    if (c.used_by.length === 0) continue;
    const provider = providers[c.provider];
    const stored = c.status === "connected" || c.status === "error";
    const connected = stored || c.legacy_fallback;
    const users = c.used_by.map((u) => {
      const part = parts.find((p) => p.env === u.env && p.key === u.part);
      return part ? `${part.envLabel} › ${part.label}` : `${u.env}/${u.part}`;
    }).join(", ");
    items.push({
      id: `connect:${c.provider}:${c.scope}`, title: `Connect ${provider.label}${scopeWords(c)}`,
      detail: c.status === "revoked" ? `The last connection was revoked${c.revoked_reason ? ` (${c.revoked_reason})` : ""}. Used by ${users}.`
        : !stored && c.legacy_fallback ? "Still answered by the legacy Worker secret — store a credential here to finish the cut-over."
        : `Used by ${users}.`,
      done: connected, action: connected ? { kind: "none" } : { kind: "connect", provider: c.provider, scope: c.scope },
    });
    if (!connected) continue;
    const required = provider.orgConfigFields.filter((f) => f.required);
    if (required.length) {
      const have = config(c.provider, c.scope);
      const missing = required.filter((f) => !have[f.key]);
      items.push({
        id: `configure:${c.provider}:${c.scope}`,
        title: missing.length ? `Set the ${provider.label} ${missing[0].label}` : `Set the ${provider.label} settings`,
        detail: missing.length ? missing[0].description : null,
        done: missing.length === 0, action: missing.length ? { kind: "configure", provider: c.provider, scope: c.scope } : { kind: "none" },
      });
    }
    if (stored) {
      const ok = c.status === "connected" && c.last_used_at !== null;
      items.push({
        id: `test:${c.provider}:${c.scope}`, title: `Test the ${provider.label} connection${scopeWords(c)}`,
        detail: c.last_error ?? (ok ? null : "Not used successfully yet — test it to confirm Trov can read what the parts need."),
        done: ok, action: ok ? { kind: "none" } : { kind: "test", provider: c.provider, scope: c.scope },
      });
    }
  }
  return items;
}

// ── the one read ─────────────────────────────────────────────────────────────

/** `GET /api/o/:slug/hosting` (admin+). */
export async function getHostingSetup(ctx: TenantContext, env: Env, providers: ProviderMap = PROVIDERS): Promise<HostingSetupDTO> {
  requireRole(ctx, "admin");
  const s = await loadConnectionState(ctx);
  const envs = await listEnvironments(ctx);
  const x = await partContext(ctx, env, providers, s);
  const environments: HostingEnvironmentDTO[] = envs.map((e) => ({
    key: e.key, label: e.label, branch: e.branch,
    parts: s.parts.filter((p) => p.env === e.key).map((p) => partDTO(x, p)),
  }));
  return {
    providers: HOSTING_PROVIDERS.map((id) => providerDTO(providers[id], env)),
    environments,
    connections: x.connections,
    checklist: buildChecklist(envs, s.parts, x.connections, providers, x.config),
    secrets_available: await secretsAvailable(env),
  };
}

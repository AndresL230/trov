// An environment's PARTS (#97: "an environment has a list of parts (web, api, worker…), each pointing at
// a provider and its settings, instead of fixed columns"): `org_environment_parts` (0057_hosting_providers),
// one row per part, whoever hosts it — Cloudflare and Railway exactly like every other provider.
//
// This module reads D1 through the tenant surface only and imports nothing from src/data/secrets.ts: the
// Repo dashboard projection (reachable from src/mcp.ts) lists parts through it. The WRITE side (`putPart` /
// `deletePart`) is ./part-writes.ts.
import { isHostingProvider, isPartRole, type HostingProviderId, type PartRole } from "@shared/hosting";
import { all, type TenantContext } from "../data/sql";
import type { PartRef } from "./types";

export interface PartRow {
  env: string;
  envLabel: string;
  branch: string;
  envPosition: number;
  key: string;
  label: string;
  role: PartRole;
  provider: HostingProviderId;
  settings: Record<string, string>;
  /** Order inside the environment. */
  position: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

interface EnvRow { key: string; label: string; branch: string; position: number }
interface StoredRow {
  env_key: string; part_key: string; position: number; label: string; role: string; provider: string; settings: string;
  updated_at: string; updated_by: string;
}

const parseSettings = (json: string): Record<string, string> => {
  try {
    const v = JSON.parse(json) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch { return {}; }
};

/** Every part of every environment of the org: environments in drift order, parts by position. */
export async function listAllParts(ctx: TenantContext): Promise<PartRow[]> {
  const [envs, stored] = [
    await all<EnvRow>(ctx, `SELECT key, label, branch, position FROM org_environments WHERE org_id = ? ORDER BY position`, ctx.orgId),
    await all<StoredRow>(ctx, `SELECT env_key, part_key, position, label, role, provider, settings, updated_at, updated_by
      FROM org_environment_parts WHERE org_id = ? ORDER BY env_key, position, part_key`, ctx.orgId),
  ];
  const out: PartRow[] = [];
  for (const e of envs) {
    for (const s of stored) {
      if (s.env_key !== e.key) continue;
      // A row whose provider or role the code no longer knows is skipped, never guessed at.
      if (!isHostingProvider(s.provider) || !isPartRole(s.role)) continue;
      out.push({
        env: e.key, envLabel: e.label, branch: e.branch, envPosition: e.position, key: s.part_key, label: s.label, role: s.role,
        provider: s.provider, settings: parseSettings(s.settings), position: s.position, updatedAt: s.updated_at, updatedBy: s.updated_by,
      });
    }
  }
  return out;
}

/** A part as a provider sees it. */
export const partRef = (orgId: string, p: PartRow): PartRef => ({
  orgId, env: p.env, envLabel: p.envLabel, branch: p.branch, key: p.key, role: p.role, settings: { ...p.settings },
});

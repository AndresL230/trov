// An environment's PARTS (#97: "an environment has a list of parts (web, api, worker…), each pointing at
// a provider and its settings, instead of fixed columns"). Two sources, ONE list:
//
//   legacy   the environment's own columns — a Cloudflare frontend (`worker` / `worker_check`, key
//            `frontend`) and a Railway backend (`railway_env` / `railway_environment_id` /
//            `railway_service_id`, key `backend`). They exist when their columns are set; the usage job,
//            the webhook capture and the reconcile keep reading those columns, so SaplingLearn's dashboard
//            does not change. Writing a legacy part writes those columns (`putEnvironment`).
//   stored   `org_environment_parts` (0047_hosting_providers) — every other provider.
//
// This module reads D1 through the tenant surface only and imports nothing from src/data/secrets.ts: the
// Repo dashboard projection (reachable from src/mcp.ts) lists parts through it. The WRITE side (`putPart` /
// `deletePart`) is ./part-writes.ts — kept apart because a legacy part is written through src/integrations/,
// which nothing reachable from src/mcp.ts may import.
import {
  LEGACY_PART_KEY, isHostingProvider, isPartRole, type HostingProviderId, type PartRole,
} from "@shared/hosting";
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
  /** Order inside the environment: legacy parts first (frontend, backend), then stored parts by position. */
  position: number;
  legacy: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

interface EnvCols {
  key: string; label: string; branch: string; position: number; railway_env: string; worker: string; worker_check: string;
  railway_environment_id: string | null; railway_service_id: string | null; updated_at: string; updated_by: string;
}
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

/** The legacy parts an environment's columns describe (none, one or both). */
export function legacyParts(e: EnvCols): PartRow[] {
  const base = { env: e.key, envLabel: e.label, branch: e.branch, envPosition: e.position, legacy: true, updatedAt: e.updated_at, updatedBy: e.updated_by };
  const out: PartRow[] = [];
  if (e.worker || e.worker_check) {
    out.push({ ...base, key: LEGACY_PART_KEY.cloudflare, label: "Frontend", role: "web", provider: "cloudflare", position: -2,
      settings: { ...(e.worker ? { worker: e.worker } : {}), ...(e.worker_check ? { worker_check: e.worker_check } : {}) } });
  }
  if (e.railway_env || e.railway_environment_id || e.railway_service_id) {
    out.push({ ...base, key: LEGACY_PART_KEY.railway, label: "Backend", role: "service", provider: "railway", position: -1,
      settings: {
        ...(e.railway_env ? { railway_env: e.railway_env } : {}),
        ...(e.railway_environment_id ? { railway_environment_id: e.railway_environment_id } : {}),
        ...(e.railway_service_id ? { railway_service_id: e.railway_service_id } : {}),
      } });
  }
  return out;
}

/** Every part of every environment of the org: environments in drift order, legacy parts first. */
export async function listAllParts(ctx: TenantContext): Promise<PartRow[]> {
  const [envs, stored] = [
    await all<EnvCols>(ctx, `SELECT key, label, branch, position, railway_env, worker, worker_check, railway_environment_id, railway_service_id,
      updated_at, updated_by FROM org_environments WHERE org_id = ? ORDER BY position`, ctx.orgId),
    await all<StoredRow>(ctx, `SELECT env_key, part_key, position, label, role, provider, settings, updated_at, updated_by
      FROM org_environment_parts WHERE org_id = ? ORDER BY env_key, position, part_key`, ctx.orgId),
  ];
  const out: PartRow[] = [];
  for (const e of envs) {
    out.push(...legacyParts(e));
    for (const s of stored) {
      if (s.env_key !== e.key) continue;
      // A row whose provider or role the code no longer knows is skipped, never guessed at.
      if (!isHostingProvider(s.provider) || !isPartRole(s.role)) continue;
      out.push({
        env: e.key, envLabel: e.label, branch: e.branch, envPosition: e.position, key: s.part_key, label: s.label, role: s.role,
        provider: s.provider, settings: parseSettings(s.settings), position: s.position, legacy: false, updatedAt: s.updated_at, updatedBy: s.updated_by,
      });
    }
  }
  return out;
}

/** The STORED parts only — what the hosting poll job serves (legacy parts belong to the usage job). */
export async function listStoredParts(ctx: TenantContext): Promise<PartRow[]> {
  return (await listAllParts(ctx)).filter((p) => !p.legacy);
}

/** A part as a provider sees it. */
export const partRef = (orgId: string, p: PartRow): PartRef => ({
  orgId, env: p.env, envLabel: p.envLabel, branch: p.branch, key: p.key, role: p.role, settings: { ...p.settings },
});

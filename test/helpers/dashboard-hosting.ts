// What the hosting job stores, written straight into D1 for the Repo dashboard's projection tests
// (test/hosting.dashboard.test.ts, test/repo-dashboard.*.test.ts): an environment's parts
// (`org_environment_parts`), a part's last poll (`hosting_poll_state`), its deploys (`hosting_deploys`) and its
// hourly `hx_<metric>` points (`repo_metrics`). The projection reads nothing else about a host.
import { env } from "cloudflare:test";
import { putMetrics } from "../../src/repo/store";
import { ORG_A, systemCtx } from "./tenant";

const AT = "2026-10-01T00:00:00.000Z";

/** One part of `envKey`; its label is `<key> label` unless given. */
export async function addPart(
  orgId: string, envKey: string, key: string, provider: string, role: "web" | "service",
  settings: Record<string, string> = {}, position = 0, label = `${key} label`,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO org_environment_parts (org_id, env_key, part_key, position, label, role, provider, settings, created_at, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'test')`,
  ).bind(orgId, envKey, key, position, label, role, provider, JSON.stringify(settings), AT, AT).run();
}

/** A part's last poll, `polledAt` (default: 20 minutes before `now`). `lastOk` defaults to the poll's own time
 *  for an `ok` poll, else null. */
export async function pollState(
  orgId: string, envKey: string, part: string, provider: string, now: number,
  o: { status?: string; detail?: string | null; covered?: [string, string]; unavailable?: unknown[]; lastOk?: string | null; polledAt?: string } = {},
): Promise<void> {
  const status = o.status ?? "ok";
  const polledAt = o.polledAt ?? new Date(now - 20 * 60_000).toISOString();
  await env.DB.prepare(
    `INSERT INTO hosting_poll_state (org_id, env, part, provider, polled_at, status, detail, last_ok_at, covered_from, covered_to, unavailable)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(orgId, envKey, part, provider, polledAt, status, o.detail ?? null,
    o.lastOk !== undefined ? o.lastOk : status === "ok" ? polledAt : null,
    o.covered?.[0] ?? null, o.covered?.[1] ?? null, JSON.stringify(o.unavailable ?? [])).run();
}

/** One deploy of a part, created at `createdAt`. */
export async function deployRow(
  orgId: string, envKey: string, part: string, provider: string, id: string, state: string, createdAt: string,
  o: { sha?: string | null; branch?: string | null; actor?: string | null; readyAt?: string | null; message?: string | null } = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO hosting_deploys (org_id, env, part, provider, deploy_id, state, target, sha, branch, message, actor, url, inspect_url, created_at, ready_at, recorded_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'production', ?, ?, ?, ?, 'https://x.example', 'https://x.example/i', ?, ?, ?, ?)`,
  ).bind(orgId, envKey, part, provider, id, state, o.sha === undefined ? "abc1234" : o.sha, o.branch === undefined ? "main" : o.branch,
    o.message === undefined ? `msg ${id}` : o.message, o.actor === undefined ? "jose-a" : o.actor,
    createdAt, o.readyAt ?? null, createdAt, createdAt).run();
}

/** One hourly `hx_<metric>` point of a part. */
export const hxPoint = (metric: string, envKey: string, part: string, at: string, value: number, orgId = ORG_A) =>
  putMetrics(systemCtx(orgId), [{ metric: `hx_${metric}`, env: envKey, part, at: new Date(at).toISOString(), value }]);

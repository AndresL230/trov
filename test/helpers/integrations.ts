import { env } from "cloudflare:test";
import { app } from "../../src/routes";
import { cookieFor } from "./persons";
import { ensureMember, ORG_A } from "./tenant";

/** The repo + two environments 0042_organizations gives SaplingLearn, and the Cloudflare frontend / Railway backend
 *  parts 0057_hosting_providers made of their old columns (the per-test reset clears them all). */
export const HOOK_A = "hook_saplinglearn_sapling";
export async function seedOrgSettings(orgId: string = ORG_A, hookId: string = HOOK_A): Promise<void> {
  const at = "2026-10-06T00:00:00.000Z";
  const part = (key: string, part: string, position: number, label: string, role: string, provider: string, settings: Record<string, string>) =>
    env.DB.prepare(`INSERT INTO org_environment_parts (org_id, env_key, part_key, position, label, role, provider, settings, created_at, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'migration')`).bind(orgId, key, part, position, label, role, provider, JSON.stringify(settings), at, at);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO org_repos (id, org_id, repo_full_name, is_primary, legacy_hook, created_at, created_by) VALUES (?, ?, 'SaplingLearn/sapling', 1, 1, ?, 'migration')`).bind(hookId, orgId, at),
    env.DB.prepare(`INSERT INTO org_environments (org_id, key, position, label, note, branch, frontend_url, api_url, health_path, created_at, updated_at, updated_by) VALUES
      (?, 'staging', 0, 'staging', 'main', 'main', 'https://staging.example.com', 'https://api.staging.example.com', '/api/health', ?, ?, 'migration'),
      (?, 'production', 1, 'production', 'production', 'production', 'https://example.com', 'https://api.example.com', '/api/health', ?, ?, 'migration')`)
      .bind(orgId, at, at, orgId, at, at),
    part("staging", "frontend", 0, "Frontend", "web", "cloudflare", { worker: "frontend-staging" }),
    part("staging", "backend", 1, "Backend", "service", "railway", { environment_id: "env-staging-id", service_id: "service-id" }),
    part("production", "frontend", 0, "Frontend", "web", "cloudflare", { worker: "frontend" }),
    part("production", "backend", 1, "Backend", "service", "railway", { environment_id: "env-production-id", service_id: "service-id" }),
  ]);
}

/** The six integrations the seeded org expects, in the order the list returns them: GitHub, then each hosting
 *  provider a part uses (one org-wide credential each), then each environment's app metrics token. */
export const SLOTS: readonly (readonly [kind: string, scope: string])[] = [
  ["github_token", ""], ["github_webhook", HOOK_A], ["cloudflare_analytics", ""], ["railway", ""],
  ["metrics_endpoint", "staging"], ["metrics_endpoint", "production"],
];
export const slotPath = (kind: string, scope: string): string => `/integrations/${kind}${scope ? `/${scope}` : ""}`;

export const ownerCookie = (): Promise<string> => cookieFor("AndresL230");
export async function roleCookie(handle: string, role: "admin" | "member"): Promise<string> {
  const cookie = await cookieFor(handle);
  await ensureMember(handle, role);
  return cookie;
}

export interface CallInit { method?: string; body?: unknown; headers?: Record<string, string>; slug?: string; env?: unknown }

/** One request to `/api/o/<slug><path>` as the cookie's person. */
export function call(cookie: string | null, path: string, o: CallInit = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(cookie ? { cookie } : {}), ...(o.body !== undefined ? { "content-type": "application/json" } : {}), ...o.headers };
  return Promise.resolve(app.request(`/api/o/${o.slug ?? "saplinglearn"}${path}`, {
    method: o.method ?? "GET",
    headers,
    ...(o.body !== undefined ? { body: typeof o.body === "string" ? o.body : JSON.stringify(o.body) } : {}),
  }, (o.env ?? env) as Record<string, unknown>));
}

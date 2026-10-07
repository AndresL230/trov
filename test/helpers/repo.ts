import type { RepoEnvConfig } from "../../src/repo/config";

export const ENVS: RepoEnvConfig[] = [
  { key: "staging", label: "staging", note: "main", branch: "main", railwayEnv: "Sapling / staging", worker: "frontend-staging", workerCheck: "Workers Builds: frontend-staging", frontendUrl: "https://staging.saplinglearn.com", apiUrl: "https://api.staging.saplinglearn.com", healthPath: "/api/health" },
  { key: "production", label: "production", note: "production", branch: "production", railwayEnv: "Sapling / production", worker: "frontend", workerCheck: "Workers Builds: frontend", frontendUrl: "https://saplinglearn.com", apiUrl: "https://api.saplinglearn.com", healthPath: "/api/health" },
];

/** A 64-character stand-in for a real `SAPLING_METRICS_TOKEN` — the length
 *  `openssl rand -hex 32` produces. A short fixture token hid a real leak once:
 *  a name cut to 40 characters still contained a 12-character token WHOLE, so
 *  the scrub matched it; it could not match 40 characters of a 64-character one.
 *  Obviously fake (a fixed arithmetic pattern), so no scanner mistakes it. */
export const LONG_TOKEN = Array.from({ length: 64 }, (_, i) => "0123456789abcdef"[(i * 7 + 3) % 16]).join("");

/** The 8-character fragments of `secret` that appear in `text` — `[]` means not
 *  even a PART of the secret got out, which is the property that matters. */
export function leakedFragments(text: string, secret: string, size = 8): string[] {
  const found: string[] = [];
  for (let i = 0; i + size <= secret.length; i++) {
    const piece = secret.slice(i, i + size);
    if (text.includes(piece) && !found.includes(piece)) found.push(piece);
  }
  return found;
}

interface GraphqlCall { query: string; variables: Record<string, unknown> }

/** A fake api.github.com keyed by path prefix. Two GraphQL queries POST to the
 *  same `https://api.github.com/graphql` URL (deployments, and branches), so a
 *  graphql call is routed by its QUERY TEXT rather than the URL: the key
 *  `"graphql"` supplies the deployments response (as before), `"refsGraphql"`
 *  the branches response — each defaults to an empty-but-valid shape so a test
 *  that cares about neither doesn't have to mock either. Every call's body is
 *  parsed and recorded (a test can then assert what the query was filtered
 *  by). A `/compare/...` REST call similarly defaults to a zero-diff shape
 *  rather than the generic `"[]"`, so a test that doesn't care about drift
 *  doesn't have to mock it either.
 *
 *  Shared by `test/repo-reconcile.test.ts` and `test/repo-cron.test.ts` — never
 *  import one `.test.ts` from another, so this lives here. */
export function fakeGithub(routes: Record<string, unknown>): { fetchImpl: typeof fetch; calls: string[]; graphql: GraphqlCall[] } {
  const calls: string[] = [];
  const graphql: GraphqlCall[] = [];
  const EMPTY_REFS = { data: { repository: { refs: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } };
  const EMPTY_DEPLOYMENTS = { data: { repository: { deployments: { nodes: [] } } } };
  const EMPTY_REVIEWS = { data: { repository: { pullRequests: { nodes: [] } } } };
  const EMPTY_COMPARE = { ahead_by: 0, behind_by: 0, commits: [] };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (url.endsWith("/graphql")) {
      const call = JSON.parse(String(init?.body ?? "{}")) as GraphqlCall;
      graphql.push(call);
      const isRefs = typeof call.query === "string" && call.query.includes("refs(refPrefix");
      // The PR-reviews query (`"reviewsGraphql"`) is the third to share the URL.
      const isReviews = typeof call.query === "string" && call.query.includes("pullRequests(");
      const key = isRefs ? "refsGraphql" : isReviews ? "reviewsGraphql" : "graphql";
      const body = key in routes ? routes[key] : isRefs ? EMPTY_REFS : isReviews ? EMPTY_REVIEWS : EMPTY_DEPLOYMENTS;
      return new Response(JSON.stringify(body), { status: 200 });
    }
    const hit = Object.keys(routes).find((k) => k !== "graphql" && k !== "refsGraphql" && k !== "reviewsGraphql" && url.includes(k));
    if (hit) return new Response(JSON.stringify(routes[hit]), { status: 200 });
    return new Response(JSON.stringify(url.includes("/compare/") ? EMPTY_COMPARE : []), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, calls, graphql };
}

/** Give `orgId` a primary repository and `envs` as its environments — the `org_repos` / `org_environments`
 *  rows an org's dashboard is configured by (what 0042_organizations wrote for SaplingLearn; the per-test reset clears them). */
export async function seedOrgRepoConfig(db: D1Database, orgId: string, repo: string, envs: RepoEnvConfig[] = ENVS): Promise<void> {
  const at = "2026-10-06T00:00:00.000Z";
  await db.batch([
    db.prepare(`INSERT INTO org_repos (id, org_id, repo_full_name, is_primary, legacy_hook, created_at, created_by) VALUES (?, ?, ?, 1, 0, ?, 'seed')`)
      .bind(`hook_${orgId}`, orgId, repo, at),
    ...envs.map((e, i) => db.prepare(
      `INSERT INTO org_environments (org_id, key, position, label, note, branch, railway_env, worker, worker_check, frontend_url, api_url,
         health_path, railway_environment_id, railway_service_id, created_at, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'seed')`,
    ).bind(orgId, e.key, i, e.label, e.note, e.branch, e.railwayEnv, e.worker, e.workerCheck, e.frontendUrl, e.apiUrl, e.healthPath,
      e.railwayEnvironmentId ?? null, e.railwayServiceId ?? null, at, at)),
  ]);
}

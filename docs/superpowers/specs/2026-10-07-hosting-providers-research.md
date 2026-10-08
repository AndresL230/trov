# Hosting providers — what each one offers (research for #97–#102)

Collected 2026-10-07 for the provider interface (#97) and the four providers (#98 Vercel, #99 Render,
#100 Netlify, #101 Fly.io; #102 AWS later). **Every vendor docs host was blocked by the build session's egress
proxy**, so these facts come from the vendors' own source on GitHub (generated SDKs / OpenAPI / CLI source —
treated as authoritative: `vercel/sdk`, `vercel/vercel`, `netlify/open-api` swagger.yml, `render-oss/cli`,
`superfly/docs`, `superfly/fly-go`, `superfly/flyctl`, `boto/botocore`) and from search extracts of the
official pages. Anything marked **UNCONFIRMED** could not be confirmed either way. The issues' "Done when"
asks that the credential, its narrowest permission and the Set form's text be **verified against the live
API** — that is still an owner step (no credential was available to the build), listed per provider below.

## Summary

| | Best connection | API hosts (allowlist) | Deploys | Usage metrics |
| --- | --- | --- | --- | --- |
| Vercel | **Integration** (install, scoped to chosen projects, uninstall webhook) — else a project-scoped token | `api.vercel.com` | `GET /v7/deployments` — SHA, branch, URL, state | No documented public API; Observability Plus only (undocumented) → **unavailable** |
| Render | API key (no scopes, acts as the user in every workspace) | `api.render.com` | `GET /v1/services/{id}/deploys` — SHA, message; branch + URL from the service | `GET /v1/metrics/{cpu,memory,http-requests,http-latency,bandwidth}` |
| Netlify | **OAuth app** (no scopes) — else a personal access token | `api.netlify.com` | `GET /api/v1/sites/{id}/deploys` — SHA, branch, context, URL | No documented API → **unavailable** |
| Fly.io | **Read-only org token** (`fly tokens create readonly`) | `api.machines.dev`, `api.fly.io` | Releases (flyctl's REST, undocumented) — no SHA / branch | Prometheus at `api.fly.io/prometheus/<org>/` |
| AWS (later) | Cross-account IAM role + external id (assume-role), SigV4 | `sts.<region>.amazonaws.com`, `monitoring.<region>.amazonaws.com` | GitHub deployments, as today | CloudWatch `GetMetricData` |

## Vercel (#98)

**Connection.** Best: an **Integration** (Integration Console: Redirect URL, optional Webhook URL, permission
scopes such as `project` / `deployment` Read). Install: the user picks a personal account or a team and all or
selected projects; the Redirect URL receives `code` (single use, 30 min), `configurationId` (`icfg_…`, the
installation id — store it), `teamId` (only on a team) and `next`. Exchange: `POST
https://api.vercel.com/v2/oauth/access_token`, form-encoded `client_id`, `client_secret`, `code`,
`redirect_uri` → `access_token`, `token_type`, `installation_id`, `user_id`, `team_id` (null = personal). The
token is long-lived (expiry / refresh **UNCONFIRMED**). Every call adds `?teamId=<team_id>` when set. Finish
by redirecting to `next` (tokens reportedly go invalid when an install is not finalised — **UNCONFIRMED**).
`GET /v1/integrations/configuration/{id}` reports `projectSelection` (`all` | `selected`), `projects`,
`scopes`, `disabledAt`, `disabledReason`. Uninstall is the webhook event `integration-configuration.removed`
(payload: team id, user id, configuration id); signature header `x-vercel-signature` = hex HMAC-SHA1 of the
raw body keyed with the Client Secret (**UNCONFIRMED** against Vercel's own page). Removing the installation
from Trov's side: `DELETE /v1/integrations/configuration/{id}`.
"Sign in with Vercel" OAuth exposes only identity scopes (REST API permissions are a private beta) — not
usable for polling. **Token fallback**: Account Settings → Tokens; Full Account, one Team, or (since
2026-07-30) **one project**; 1 day – 1 year expiry; there is **no read-only token** — narrowest = project-scoped.

**Hosts / auth.** `api.vercel.com`; `Authorization: Bearer <token>`.
**Probe.** `GET /v9/projects/{idOrName}?teamId=`.
**Deploys.** `GET /v7/deployments?projectId=&target=production&limit=&since=&until=&teamId=` →
`{ deployments: [...], pagination: { count, next, prev } }`. Fields: `uid`, `name`, `url` (host, no scheme),
`inspectorUrl`, `created` / `createdAt` / `buildingAt` / `ready` (ms), `readyState` / `state`: `QUEUED` |
`INITIALIZING` | `BUILDING` | `READY` | `ERROR` | `CANCELED` | `DELETED` | `BLOCKED`, `target`: `production` |
`staging` | null (null = preview), `creator: { uid, username, email }`, `meta` (string map; SHA / branch /
message as `githubCommitSha` / `githubCommitRef` / `githubCommitMessage` and the `gitlab…` / `bitbucket…`
equivalents — key names **UNCONFIRMED**). Whether `target=preview` is accepted is **UNCONFIRMED** (filter
`target: null` client-side).
**Usage.** No documented public REST metrics API. The `vercel metrics` CLI calls `POST
/v2/observability/query` (needs **Observability Plus**, Pro / Enterprise) — undocumented, so Trov reports
requests / errors / latency as unavailable for Vercel.
**Rate limits.** `X-RateLimit-*` headers; 429 over the limit.
**Owner checks before release:** create the Integration (scopes: Projects Read, Deployments Read; Redirect URL
`<origin>/hosting/vercel/callback`; Webhook URL `<origin>/webhook/hosting/vercel`), confirm the signature
algorithm on a real `integration-configuration.removed`, and confirm the `meta` key names on a real deploy.

## Render (#99)

**Connection.** No integration, no third-party OAuth. **API key** only: Dashboard → Account Settings → API
Keys; shown once; **no scopes, not bound to a workspace** — it acts as the user in every workspace they
belong to. Narrowest available: a dedicated member account that belongs only to the target workspace (which
role suffices is **UNCONFIRMED**).
**Hosts / auth.** `api.render.com/v1`; `Authorization: Bearer <key>`.
**Probe.** `GET /v1/services/{serviceId}` (`id`, `name`, `ownerId`, `branch`, `repo`, `type`, `suspended`,
`serviceDetails.url`, `dashboardUrl`); `GET /v1/owners` checks the key alone.
**Deploys.** `GET /v1/services/{serviceId}/deploys?limit=` → `[{ cursor, deploy: { id, commit: { id, message,
createdAt }, image, status, trigger, createdAt, startedAt, finishedAt, updatedAt } }]`. `status`: `created` |
`queued` | `build_in_progress` | `update_in_progress` | `pre_deploy_in_progress` | `live` | `deactivated` |
`build_failed` | `update_failed` | `pre_deploy_failed` | `canceled`. No branch or URL on a deploy — take them
from the service.
**Usage.** `GET /v1/metrics/<kind>?resource=<serviceId>&startTime=&endTime=&resolutionSeconds=` for `cpu`,
`memory`, `http-requests` (`aggregateBy=statusCode` gives errors), `http-latency` (`quantile=0.95`),
`bandwidth`. Response `[{ labels: [{ field, value }], unit, values: [{ timestamp, value }] }]`. Time format
(epoch vs ISO) **UNCONFIRMED**; CPU / memory unit strings **UNCONFIRMED** (read `unit`). CPU / memory for all
services but static sites; HTTP metrics for web services only.
**Rate limits.** GETs 400/min; `Ratelimit-*` headers.
**Owner checks:** the time format and units on a real call; which workspace role a dedicated read account needs.

## Netlify (#100)

**Connection.** Best: an **OAuth app** (User settings → Applications → OAuth applications — path
**UNCONFIRMED**): authorize `https://app.netlify.com/authorize?client_id=&response_type=code&redirect_uri=&state=`,
token `POST https://api.netlify.com/oauth/token` (`grant_type=authorization_code`, `code`, `client_id`,
`client_secret`, `redirect_uri`). **No scopes**: the token acts as the user across their teams; no refresh /
expiry documented. Fallback: a **personal access token** (User settings → Applications → Personal access
tokens; optional SAML-team access; an expiration) — full scope. Netlify Extensions' token is only usable inside
an extension hosted on Netlify, not for an outside poller.
**Hosts / auth.** `api.netlify.com/api/v1`; `Authorization: Bearer <token>`.
**Probe.** `GET /api/v1/sites/{site_id}` (`id`, `name`, `url`, `ssl_url`, `admin_url`, `account_slug`,
`build_settings.repo_branch` — field name **UNCONFIRMED**).
**Deploys.** `GET /api/v1/sites/{site_id}/deploys?per_page=&production=true|&branch=` — fields `id`, `state`,
`commit_ref` (SHA), `branch`, `context` (`production` | `deploy-preview` | `branch-deploy` | …), `title`,
`created_at`, `published_at`, `deploy_ssl_url`, `admin_url`, `error_message`. States: `new` |
`pending_review` | `accepted` | `rejected` | `enqueued` | `building` | `uploading` | `uploaded` | `preparing` |
`prepared` | `processing` | `processed` | `ready` | `error` | `retrying`.
**Usage.** No documented API (Observability is dashboard-only; the analytics endpoints are undocumented) →
Trov reports traffic as unavailable for Netlify.
**Rate limits.** 500/min.
**Owner checks:** register the OAuth app (Redirect URI `<origin>/hosting/netlify/callback`) and confirm the
exchange on a real account.

## Fly.io (#101)

**Connection.** No integration / OAuth for API access. Best: a **read-only org token** — `fly tokens create
readonly <org> --name trov --expiry 8760h` (macaroon; default expiry 20 years, pass `--expiry`). Do not use
`fly auth token`. Header: `Authorization: FlyV1 <fm2_…>` for a macaroon (flyctl may print the token with
the `FlyV1 ` prefix already — strip it before storing).
**Hosts.** `api.machines.dev` (Machines REST), `api.fly.io` (Prometheus, GraphQL, flyctl's REST).
**Probe.** `GET https://api.machines.dev/v1/apps/{app}` → `{ id, name, status, organization: { slug } }`
(check the slug); then a Prometheus instant query `fly_instance_up{app="<app>"}` — that a read-only token may
query Prometheus is **UNCONFIRMED**.
**Deploys (releases).** Undocumented: flyctl's `GET https://api.fly.io/api/v1/apps/{app}/releases?limit=N` →
`{ releases: [{ id, version, stable, in_progress, status, strategy, user, created_at, image_ref }] }`. `status`
is a free string (`running` | `complete` | `failed` | `interrupted`). **No commit SHA, branch or URL.**
**Usage.** Prometheus (VictoriaMetrics) at `https://api.fly.io/prometheus/<org>/api/v1/query_range?query=&start=&end=&step=`.
Requests `fly_edge_http_responses_count{app,status}` (counter); latency `fly_edge_http_response_time_seconds_bucket{le}`;
bandwidth `fly_edge_data_out`; CPU `fly_instance_cpu{mode}` (counter, centiseconds); memory
`fly_instance_memory_mem_total` − `fly_instance_memory_mem_available` (bytes). Example queries:
`sum(increase(fly_edge_http_responses_count{app="X"}[1h]))`, add `status=~"5.."` for errors,
`histogram_quantile(0.95, sum(rate(fly_edge_http_response_time_seconds_bucket{app="X"}[1h])) by (le))`,
`sum(rate(fly_instance_cpu{app="X",mode!="idle"}[1h]))/100`. Retention ≈ 15 days.
**Owner checks:** that a read-only token reads Prometheus and the releases endpoint.

## AWS (#102, later)

A cross-account IAM role trusting Trov's account, with a per-org **external id** Trov generates (confused
deputy). Trov needs its own AWS identity to call `AssumeRole` (an access key held as a Worker secret, or IAM
Roles Anywhere — fit **UNCONFIRMED**). Everything is SigV4-signed (`sts`, `monitoring`). Use the REGIONAL STS
endpoint. Permission policy: `cloudwatch:GetMetricData`, `cloudwatch:ListMetrics` on `*`.
`GetMetricData` (JSON 1.0: `X-Amz-Target: GraniteServiceVersion20100801.GetMetricData`, `X-Amz-Security-Token`).
Metrics: ALB `AWS/ApplicationELB` `RequestCount`, `HTTPCode_Target_5XX_Count`, `TargetResponseTime`
(`LoadBalancer=app/<name>/<id>`); API Gateway `AWS/ApiGateway` `Count`, `5XXError`, `Latency` (`ApiName`,
`Stage`); ECS `AWS/ECS` `CPUUtilization`, `MemoryUtilization` (`ClusterName`, `ServiceName`) — percent;
Lambda `AWS/Lambda` `Invocations`, `Errors`, `Duration` (`FunctionName`). GetMetricData 50 TPS; billed per
1,000 metrics requested.

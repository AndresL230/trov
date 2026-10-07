// Org settings › Hosting — SAMPLE DATA (#97–#102). The data stubs the Hosting screens are designed and built
// against (docs/design/hosting-providers-claude-design-prompt.md), one payload per state of
// `GET /api/o/:slug/hosting` (`HostingSetupDTO`, shared/hosting.ts), plus the connect / test / poll answers.
// Like web/src/repo-sample.ts it is meant for a dynamic import (a "Preview with sample data" toggle) and must
// never be in the main bundle.
//
// HOSTING_SAMPLE_PROVIDERS is the REAL catalogue: what `providerDTO` returns for every registered provider on a
// deployment that has the Vercel integration and the Netlify OAuth app configured. test/hosting.sample.test.ts
// fails when a provider changes and this copy does not — regenerate it from src/hosting/registry.ts.
import type {
  ConnectStartDTO, HostingPollOutcome, HostingProviderDTO, HostingSetupDTO, HostingTestDTO,
} from "@shared/hosting";

export const HOSTING_SAMPLE_PROVIDERS: HostingProviderDTO[] = [
  {
    "id": "cloudflare",
    "label": "Cloudflare Workers",
    "status": "available",
    "summary": "A Worker (or Workers Builds) frontend: requests and error rate from Cloudflare's GraphQL Analytics API; deploys from the Workers Builds check run on GitHub.",
    "roles": [
      "web"
    ],
    "capabilities": {
      "deploys": true,
      "metrics": [
        "requests",
        "errors"
      ]
    },
    "plan_note": null,
    "api_hosts": [
      "api.cloudflare.com"
    ],
    "credential_scope": "org",
    "connection_methods": [
      {
        "method": "token",
        "label": "Paste an API token",
        "how_to": "In the Cloudflare dashboard open My Profile › API Tokens › Create Token › Create Custom Token and grant ONE permission: Account › Account Analytics › Read, limited to the account your frontend Workers live under. Paste the token here and set Account ID to that account's 32-character id (Workers & Pages › Overview). The token is only ever sent to api.cloudflare.com.",
        "grants": [
          "Account Analytics: Read on one account"
        ],
        "available": true,
        "unavailable_reason": null
      }
    ],
    "org_config_fields": [
      {
        "key": "account_id",
        "label": "Account ID",
        "description": "The 32-character id of the Cloudflare account the frontend Workers live under. Not a secret.",
        "required": true,
        "placeholder": "0123456789abcdef0123456789abcdef",
        "pattern": "^[0-9a-fA-F]{32}$"
      }
    ],
    "part_settings": [
      {
        "key": "worker",
        "label": "Worker name",
        "description": "The Worker script's name, as Workers & Pages lists it.",
        "required": true,
        "placeholder": "frontend-staging",
        "pattern": "^[A-Za-z0-9_-]{1,63}$"
      },
      {
        "key": "worker_check",
        "label": "Workers Builds check",
        "description": "The check run Workers Builds posts on GitHub for this Worker (its deploy record), e.g. \"Workers Builds: frontend-staging\".",
        "required": false,
        "placeholder": "Workers Builds: frontend-staging",
        "pattern": null
      }
    ],
    "docs_url": "https://developers.cloudflare.com/analytics/graphql-api/",
    "legacy_part_key": "frontend"
  },
  {
    "id": "railway",
    "label": "Railway",
    "status": "available",
    "summary": "A Railway service: CPU and memory from Railway's GraphQL API; deploys from the GitHub deployment statuses Railway posts.",
    "roles": [
      "service"
    ],
    "capabilities": {
      "deploys": true,
      "metrics": [
        "cpu",
        "mem_mb"
      ]
    },
    "plan_note": null,
    "api_hosts": [
      "backboard.railway.com"
    ],
    "credential_scope": "environment",
    "connection_methods": [
      {
        "method": "token",
        "label": "Paste a project token",
        "how_to": "In Railway open the project › Settings › Tokens and create a PROJECT token for this environment. A project token is bound to one environment of one project, so every environment needs its own; an account or team token will not work (it is sent as Project-Access-Token, not as a bearer). Railway has no read-only scope: this token can also change that environment, and one environment of one project is the narrowest Railway offers. The token is only ever sent to backboard.railway.com.",
        "grants": [
          "Full access to ONE environment of one project (Railway has no read-only token)"
        ],
        "available": true,
        "unavailable_reason": null
      }
    ],
    "org_config_fields": [],
    "part_settings": [
      {
        "key": "railway_env",
        "label": "GitHub deployment environment",
        "description": "The environment name Railway's GitHub deployments carry, e.g. \"Sapling / staging\" — how a deployment_status delivery is matched to this environment.",
        "required": true,
        "placeholder": "my-app / staging",
        "pattern": null
      },
      {
        "key": "railway_environment_id",
        "label": "Railway environment ID",
        "description": "Project › Settings › Environments, the environment's id. Needed for CPU and memory.",
        "required": false,
        "placeholder": null,
        "pattern": "^[A-Za-z0-9-]{1,100}$"
      },
      {
        "key": "railway_service_id",
        "label": "Railway service ID",
        "description": "The service's id (its Settings tab). The same in every environment.",
        "required": false,
        "placeholder": null,
        "pattern": "^[A-Za-z0-9-]{1,100}$"
      }
    ],
    "docs_url": "https://docs.railway.com/reference/public-api",
    "legacy_part_key": "backend"
  },
  {
    "id": "vercel",
    "label": "Vercel",
    "status": "available",
    "summary": "A Vercel project: its production deploys (or one branch's previews) with commit, branch, state and URL from Vercel's REST API. Vercel has no public usage API, so no traffic figures.",
    "roles": [
      "web"
    ],
    "capabilities": {
      "deploys": true,
      "metrics": []
    },
    "plan_note": "Vercel exposes no public usage API (its Observability Query needs Observability Plus and is undocumented), so a Vercel part shows deploys only.",
    "api_hosts": [
      "api.vercel.com"
    ],
    "credential_scope": "org",
    "connection_methods": [
      {
        "method": "install",
        "label": "Connect with Vercel",
        "how_to": "Vercel opens its install screen for Trov's integration: pick your personal account or the team that owns the project, choose \"Specific Projects\" and select only the projects Trov should read (\"All Projects\" works but grants more), then confirm — Vercel sends you back here. Trov asks for read access to projects and deployments only. Uninstalling the integration on Vercel (Settings › Integrations) disconnects Trov too. The access token Vercel issues is stored encrypted and only ever sent to api.vercel.com.",
        "grants": [
          "Projects: Read — on the projects you pick",
          "Deployments: Read — on the projects you pick"
        ],
        "available": true,
        "unavailable_reason": null
      },
      {
        "method": "token",
        "label": "Paste an access token",
        "how_to": "In Vercel open Account Settings › Tokens › Create Token. Scope it to the ONE project Trov should read (a project-scoped token) — or, where that is not offered, to the one team that owns it; never Full Account — and set an expiry (Vercel allows 1 day to 1 year; Trov shows a 401 when it lapses). Vercel has no read-only token: whoever holds it can also change what it reaches, which is why one project is the narrowest choice. When the project belongs to a team, also set Team ID below. The token is only ever sent to api.vercel.com.",
        "grants": [
          "Full access to ONE project (or one team) — Vercel has no read-only token"
        ],
        "available": true,
        "unavailable_reason": null
      }
    ],
    "org_config_fields": [
      {
        "key": "team_id",
        "label": "Team ID",
        "description": "The team that owns the projects (Team Settings › General › Team ID). Leave empty for a personal account. Filled in for you when you connect with Vercel.",
        "required": false,
        "placeholder": "team_a1B2c3D4e5F6g7H8i9J0k1L2",
        "pattern": "^team_[A-Za-z0-9]{1,64}$"
      },
      {
        "key": "team_slug",
        "label": "Team URL slug",
        "description": "The name in your Vercel dashboard's address (vercel.com/<slug>) — your username for a personal account. Used only for links to Vercel.",
        "required": false,
        "placeholder": "acme",
        "pattern": "^[a-z0-9-]{1,64}$"
      }
    ],
    "part_settings": [
      {
        "key": "project",
        "label": "Project",
        "description": "The Vercel project's name, or its id (prj_…, Project › Settings › General).",
        "required": true,
        "placeholder": "my-web-app",
        "pattern": "^(?!\\.{1,2}$)(?:prj_[A-Za-z0-9]{1,64}|[a-z0-9._-]{1,100})$"
      },
      {
        "key": "target",
        "label": "Deploys shown",
        "description": "production (the default): the project's production deploys. preview: its preview deploys — set Branch to narrow them to one branch (e.g. a staging environment = the previews of main).",
        "required": false,
        "placeholder": "production",
        "pattern": "^(?:production|preview)$"
      },
      {
        "key": "branch",
        "label": "Branch (previews only)",
        "description": "With preview: show only the previews of this git branch, e.g. main. Ignored for production.",
        "required": false,
        "placeholder": "main",
        "pattern": "^[A-Za-z0-9][A-Za-z0-9._\\/+-]{0,199}$"
      }
    ],
    "docs_url": "https://vercel.com/docs/rest-api",
    "legacy_part_key": null
  },
  {
    "id": "render",
    "label": "Render",
    "status": "available",
    "summary": "A Render web service, private service or background worker: deploys from Render's API, and HTTP requests, server errors, p95 latency and bandwidth (web) or CPU and memory (service) from Render's metrics API.",
    "roles": [
      "web",
      "service"
    ],
    "capabilities": {
      "deploys": true,
      "metrics": [
        "requests",
        "errors",
        "latency_p95_ms",
        "bandwidth_bytes",
        "cpu",
        "mem_mb"
      ]
    },
    "plan_note": "Render reports HTTP requests and latency for web services only, and CPU and memory for every service but static sites.",
    "api_hosts": [
      "api.render.com"
    ],
    "credential_scope": "org",
    "connection_methods": [
      {
        "method": "token",
        "label": "Paste an API key",
        "how_to": "In the Render Dashboard open Account Settings › API Keys › Create API Key, and paste the key here (Render shows it only once). Render API keys have NO scopes and no read-only mode, and are not bound to a workspace: a key acts as its user — with everything that user may do, including changing and deleting services — in EVERY workspace the user belongs to. The narrowest option Render offers is a key from a dedicated member account that belongs only to this workspace. The key is only ever sent to api.render.com.",
        "grants": [
          "Everything the key's user can do, in every workspace that user belongs to (Render API keys have no scopes and no read-only mode)"
        ],
        "available": true,
        "unavailable_reason": null
      }
    ],
    "org_config_fields": [
      {
        "key": "owner_id",
        "label": "Workspace ID",
        "description": "Optional. The Render workspace's id (tea-… for a team, usr-… for a personal workspace), from Workspace Settings. Test connection then checks that each service belongs to it. Not a secret.",
        "required": false,
        "placeholder": "tea-cn1t5h0l5elc73fk0abc",
        "pattern": "^[a-z]{3}-[a-z0-9]{10,40}$"
      }
    ],
    "part_settings": [
      {
        "key": "service_id",
        "label": "Service ID",
        "description": "The Render service's id (srv-…): its Settings page, or the last part of its dashboard URL.",
        "required": true,
        "placeholder": "srv-d3k8q1j7mgec73a1b2c0",
        "pattern": "^srv-[a-z0-9]{10,40}$"
      }
    ],
    "docs_url": "https://api-docs.render.com/reference/introduction",
    "legacy_part_key": null
  },
  {
    "id": "netlify",
    "label": "Netlify",
    "status": "available",
    "summary": "A Netlify site: its production or branch deploys (state, commit, branch, link) from Netlify's API. Netlify has no public usage API, so no traffic figures.",
    "roles": [
      "web"
    ],
    "capabilities": {
      "deploys": true,
      "metrics": []
    },
    "plan_note": "Netlify publishes no usage or analytics API (Observability is dashboard-only), so a Netlify part shows its deploys but no traffic.",
    "api_hosts": [
      "api.netlify.com"
    ],
    "credential_scope": "org",
    "connection_methods": [
      {
        "method": "oauth",
        "label": "Connect with Netlify",
        "how_to": "Connect with Netlify sends you to Netlify to approve Trov's OAuth application, then back here. Netlify OAuth has NO scopes: the token acts as the person who approves it, across every team they belong to — so approve with an account that belongs only to the team whose sites Trov should see. Trov only reads deploys. Disconnecting here deletes Trov's copy; to end the grant on Netlify's side too, revoke Trov under User settings › Applications. The token is only ever sent to api.netlify.com.",
        "grants": [
          "Everything the approving Netlify account can do, across every team it belongs to — Netlify OAuth has no scopes",
          "Trov uses it only to read sites and their deploys"
        ],
        "available": true,
        "unavailable_reason": null
      },
      {
        "method": "token",
        "label": "Paste a personal access token",
        "how_to": "In Netlify open User settings › Applications › Personal access tokens › New access token, name it \"Trov\" and set an expiration (paste a new one here when it runs out). Netlify has no scoped or read-only tokens: it has full access to your account and every team you belong to, so create it from an account that belongs only to the team whose sites Trov should see. Tick the SAML-team access box only if the site lives in a SAML-based team. The token is only ever sent to api.netlify.com.",
        "grants": [
          "Full access to the account that creates it and every team it belongs to (Netlify has no read-only or per-site token)"
        ],
        "available": true,
        "unavailable_reason": null
      }
    ],
    "org_config_fields": [],
    "part_settings": [
      {
        "key": "site_id",
        "label": "Site ID",
        "description": "The site's API id, a UUID: Site configuration › Site details › Site ID (Netlify now calls sites \"projects\", so it may read Project configuration › Project details › Project ID).",
        "required": true,
        "placeholder": "3f2a9c1e-7b4d-4e8a-9c2f-5d6e7f8a9b0c",
        "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
      },
      {
        "key": "context",
        "label": "Deploy context",
        "description": "production (the default) reads the site's production deploys; branch reads the deploys of the Branch below — its branch deploys and the deploy previews of pull requests from it.",
        "required": false,
        "placeholder": "production",
        "pattern": "^(production|branch)$"
      },
      {
        "key": "branch",
        "label": "Branch",
        "description": "The Git branch whose deploys to read. Required when Deploy context is branch; ignored for production.",
        "required": false,
        "placeholder": "staging",
        "pattern": "^[A-Za-z0-9._/+@-]{1,200}$"
      },
      {
        "key": "site_name",
        "label": "Site name",
        "description": "Optional: the site's name (its <name>.netlify.app subdomain), used only for the Open in Netlify link — Trov polls by Site ID.",
        "required": false,
        "placeholder": "my-site",
        "pattern": "^[a-z0-9-]{1,63}$"
      }
    ],
    "docs_url": "https://docs.netlify.com/api/get-started/",
    "legacy_part_key": null
  },
  {
    "id": "fly",
    "label": "Fly.io",
    "status": "available",
    "summary": "A Fly.io app: requests, server errors, p95 latency and bandwidth (web) or CPU and memory (service) from Fly's Prometheus metrics; its releases as deploys (version only — Fly reports no commit).",
    "roles": [
      "web",
      "service"
    ],
    "capabilities": {
      "deploys": true,
      "metrics": [
        "requests",
        "errors",
        "latency_p95_ms",
        "bandwidth_bytes",
        "cpu",
        "mem_mb"
      ]
    },
    "plan_note": null,
    "api_hosts": [
      "api.machines.dev",
      "api.fly.io"
    ],
    "credential_scope": "org",
    "connection_methods": [
      {
        "method": "token",
        "label": "Paste a read-only token",
        "how_to": "Run fly tokens create readonly <org-slug> --name trov --expiry 8760h (fly orgs list shows the slug) and paste the whole output — a leading \"FlyV1 \" is fine. It is a READ-ONLY token for one organization, the narrowest Fly.io offers: it can read that organization's apps, releases and metrics and change nothing. Never paste the output of fly auth token — that is your personal token, with full access to every organization you belong to. The token stops working after its --expiry (8760h is one year); create a new one before then. It is only ever sent to api.machines.dev and api.fly.io.",
        "grants": [
          "Read-only access to one Fly.io organization: its apps, releases and metrics"
        ],
        "available": true,
        "unavailable_reason": null
      }
    ],
    "org_config_fields": [
      {
        "key": "org_slug",
        "label": "Organization slug",
        "description": "The organization the read-only token was created for — fly orgs list shows it (a personal organization is \"personal\"). Metrics are read from it.",
        "required": true,
        "placeholder": "my-org",
        "pattern": "^[a-z0-9-]{1,63}$"
      }
    ],
    "part_settings": [
      {
        "key": "app",
        "label": "App name",
        "description": "The Fly.io app this part runs as — one app per environment, e.g. myapp-staging (fly apps list).",
        "required": true,
        "placeholder": "myapp-staging",
        "pattern": "^[a-z0-9-]{2,63}$"
      }
    ],
    "docs_url": "https://fly.io/docs/monitoring/metrics/",
    "legacy_part_key": null
  },
  {
    "id": "aws",
    "label": "AWS",
    "status": "later",
    "summary": "ECS, Lambda, App Runner, an ALB or API Gateway: CloudWatch metrics for one named resource through a read-only role you let Trov assume. Coming later.",
    "roles": [
      "web",
      "service"
    ],
    "capabilities": {
      "deploys": false,
      "metrics": [
        "requests",
        "errors",
        "latency_p95_ms",
        "cpu",
        "mem_mb"
      ]
    },
    "plan_note": "CloudWatch GetMetricData is billed by AWS per metric requested (a few cents a month per part at an hourly poll).",
    "api_hosts": [
      "sts.amazonaws.com"
    ],
    "credential_scope": "org",
    "connection_methods": [
      {
        "method": "assume_role",
        "label": "Grant Trov a read-only role",
        "how_to": "In IAM create a role for \"Another AWS account\" (Trov's account id, shown here), require the external id shown here, and attach a policy that allows only cloudwatch:GetMetricData (and cloudwatch:ListMetrics) — optionally limited by resource. Paste the role's ARN and pick its region. No access key is ever pasted into Trov.",
        "grants": [
          "cloudwatch:GetMetricData",
          "cloudwatch:ListMetrics"
        ],
        "available": false,
        "unavailable_reason": "AWS is not supported yet"
      }
    ],
    "org_config_fields": [
      {
        "key": "role_arn",
        "label": "Role ARN",
        "description": "The role Trov assumes: arn:aws:iam::<account>:role/<name>.",
        "required": true,
        "placeholder": "arn:aws:iam::123456789012:role/trov-readonly",
        "pattern": "^arn:aws:iam::\\d{12}:role\\/[\\w+=,.@\\/-]{1,512}$"
      },
      {
        "key": "region",
        "label": "Region",
        "description": "The region the resources live in, e.g. us-east-1.",
        "required": true,
        "placeholder": "us-east-1",
        "pattern": "^[a-z]{2}(-gov)?-[a-z]+-\\d$"
      }
    ],
    "part_settings": [
      {
        "key": "resource_type",
        "label": "Resource type",
        "description": "alb, apigateway, ecs or lambda.",
        "required": true,
        "placeholder": "ecs",
        "pattern": "^(alb|apigateway|ecs|lambda)$"
      },
      {
        "key": "resource",
        "label": "Resource",
        "description": "ALB: app/<name>/<id>. API Gateway: the API name. ECS: <cluster>/<service>. Lambda: the function name.",
        "required": true,
        "placeholder": "prod-cluster/api",
        "pattern": null
      }
    ],
    "docs_url": "https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_create_for-user_externalid.html",
    "legacy_part_key": null
  }
];

/** A mixed org, mid-setup: two environments; legacy Cloudflare + Railway parts on Staging; Vercel (installed),
 *  Render (token, now refused — 401), Fly.io (read-only token) and Netlify (not connected yet). */
export const HOSTING_SAMPLE_MIXED: HostingSetupDTO = {
  "providers": HOSTING_SAMPLE_PROVIDERS,
  "environments": [
    {
      "key": "staging",
      "label": "Staging",
      "branch": "main",
      "parts": [
        {
          "env": "staging",
          "key": "frontend",
          "label": "Frontend",
          "role": "web",
          "provider": "cloudflare",
          "settings": {
            "worker": "acme-web-staging",
            "worker_check": "Workers Builds: acme-web-staging"
          },
          "position": -2,
          "legacy": true,
          "connection": "connected",
          "console_url": "https://dash.cloudflare.com/0123456789abcdef0123456789abcdef/workers/services/view/acme-web-staging/production",
          "last_poll": null,
          "updated_at": "2026-10-06T16:20:00.000Z",
          "updated_by": "andres"
        },
        {
          "env": "staging",
          "key": "backend",
          "label": "Backend",
          "role": "service",
          "provider": "railway",
          "settings": {
            "railway_env": "acme / staging",
            "railway_environment_id": "8f2c1a9e-4b7d-4e2a-9c1f-2d3e4f5a6b7c",
            "railway_service_id": "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"
          },
          "position": -1,
          "legacy": true,
          "connection": "connected",
          "console_url": null,
          "last_poll": null,
          "updated_at": "2026-10-06T16:20:00.000Z",
          "updated_by": "andres"
        },
        {
          "env": "staging",
          "key": "web",
          "label": "Web app",
          "role": "web",
          "provider": "vercel",
          "settings": {
            "project": "acme-web",
            "target": "preview",
            "branch": "main"
          },
          "position": 0,
          "legacy": false,
          "connection": "connected",
          "console_url": "https://vercel.com/acme/acme-web",
          "last_poll": {
            "at": "2026-10-07T12:40:11.000Z",
            "status": "ok",
            "detail": null,
            "last_ok_at": "2026-10-07T12:40:11.000Z",
            "covered": null,
            "unavailable": [
              {
                "metric": "requests",
                "reason": "Vercel exposes no public usage API (its Observability Query needs Observability Plus and is undocumented)"
              },
              {
                "metric": "errors",
                "reason": "Vercel exposes no public usage API (its Observability Query needs Observability Plus and is undocumented)"
              },
              {
                "metric": "latency_p50_ms",
                "reason": "Vercel exposes no public usage API (its Observability Query needs Observability Plus and is undocumented)"
              },
              {
                "metric": "latency_p95_ms",
                "reason": "Vercel exposes no public usage API (its Observability Query needs Observability Plus and is undocumented)"
              },
              {
                "metric": "bandwidth_bytes",
                "reason": "Vercel exposes no public usage API (its Observability Query needs Observability Plus and is undocumented)"
              }
            ]
          },
          "updated_at": "2026-10-06T16:20:00.000Z",
          "updated_by": "andres"
        },
        {
          "env": "staging",
          "key": "api",
          "label": "API",
          "role": "service",
          "provider": "render",
          "settings": {
            "service_id": "srv-cn2k8h7c3k9s73a1b2c3"
          },
          "position": 1,
          "legacy": false,
          "connection": "error",
          "console_url": "https://dashboard.render.com/web/srv-cn2k8h7c3k9s73a1b2c3",
          "last_poll": {
            "at": "2026-10-07T12:40:13.000Z",
            "status": "failed",
            "detail": "render deployments 401: Unauthorized — the credential is not valid",
            "last_ok_at": "2026-10-07T09:40:12.000Z",
            "covered": {
              "from": "2026-10-06T15:00:00.000Z",
              "to": "2026-10-07T09:00:00.000Z"
            },
            "unavailable": []
          },
          "updated_at": "2026-10-06T16:20:00.000Z",
          "updated_by": "andres"
        }
      ]
    },
    {
      "key": "production",
      "label": "Production",
      "branch": "production",
      "parts": [
        {
          "env": "production",
          "key": "web",
          "label": "Web app",
          "role": "web",
          "provider": "vercel",
          "settings": {
            "project": "acme-web",
            "target": "production"
          },
          "position": 0,
          "legacy": false,
          "connection": "connected",
          "console_url": "https://vercel.com/acme/acme-web",
          "last_poll": {
            "at": "2026-10-07T12:40:15.000Z",
            "status": "ok",
            "detail": null,
            "last_ok_at": "2026-10-07T12:40:15.000Z",
            "covered": null,
            "unavailable": [
              {
                "metric": "requests",
                "reason": "Vercel exposes no public usage API (its Observability Query needs Observability Plus and is undocumented)"
              },
              {
                "metric": "errors",
                "reason": "Vercel exposes no public usage API (its Observability Query needs Observability Plus and is undocumented)"
              },
              {
                "metric": "latency_p50_ms",
                "reason": "Vercel exposes no public usage API (its Observability Query needs Observability Plus and is undocumented)"
              },
              {
                "metric": "latency_p95_ms",
                "reason": "Vercel exposes no public usage API (its Observability Query needs Observability Plus and is undocumented)"
              },
              {
                "metric": "bandwidth_bytes",
                "reason": "Vercel exposes no public usage API (its Observability Query needs Observability Plus and is undocumented)"
              }
            ]
          },
          "updated_at": "2026-10-06T16:20:00.000Z",
          "updated_by": "andres"
        },
        {
          "env": "production",
          "key": "api",
          "label": "API",
          "role": "web",
          "provider": "render",
          "settings": {
            "service_id": "srv-cp9f3l1d0j6c73d4e5f6"
          },
          "position": 1,
          "legacy": false,
          "connection": "error",
          "console_url": "https://dashboard.render.com/web/srv-cp9f3l1d0j6c73d4e5f6",
          "last_poll": {
            "at": "2026-10-07T12:40:16.000Z",
            "status": "failed",
            "detail": "render deployments 401: Unauthorized — the credential is not valid",
            "last_ok_at": "2026-10-07T09:40:15.000Z",
            "covered": {
              "from": "2026-10-06T15:00:00.000Z",
              "to": "2026-10-07T09:00:00.000Z"
            },
            "unavailable": [
              {
                "metric": "latency_p50_ms",
                "reason": "Trov reads Render's p95 latency only"
              }
            ]
          },
          "updated_at": "2026-10-06T16:20:00.000Z",
          "updated_by": "andres"
        },
        {
          "env": "production",
          "key": "worker",
          "label": "Worker",
          "role": "service",
          "provider": "fly",
          "settings": {
            "app": "acme-worker"
          },
          "position": 2,
          "legacy": false,
          "connection": "connected",
          "console_url": "https://fly.io/apps/acme-worker",
          "last_poll": {
            "at": "2026-10-07T12:40:18.000Z",
            "status": "ok",
            "detail": null,
            "last_ok_at": "2026-10-07T12:40:18.000Z",
            "covered": {
              "from": "2026-10-07T06:00:00.000Z",
              "to": "2026-10-07T12:00:00.000Z"
            },
            "unavailable": []
          },
          "updated_at": "2026-10-06T16:20:00.000Z",
          "updated_by": "andres"
        },
        {
          "env": "production",
          "key": "docs",
          "label": "Docs site",
          "role": "web",
          "provider": "netlify",
          "settings": {
            "site_id": "3f9a2c1e-7b4d-4e8a-9c2f-1d0e5a6b7c8d",
            "context": "production",
            "site_name": "acme-docs"
          },
          "position": 3,
          "legacy": false,
          "connection": "not_connected",
          "console_url": "https://app.netlify.com/sites/acme-docs/overview",
          "last_poll": null,
          "updated_at": "2026-10-06T16:20:00.000Z",
          "updated_by": "andres"
        }
      ]
    }
  ],
  "connections": [
    {
      "provider": "cloudflare",
      "scope": "",
      "scope_label": null,
      "status": "connected",
      "method": "token",
      "account": null,
      "external_id": null,
      "config": {
        "account_id": "0123456789abcdef0123456789abcdef"
      },
      "hint_last4": "9f3a",
      "connected_by": "andres",
      "connected_at": "2026-10-06T16:05:00.000Z",
      "last_used_at": "2026-10-07T12:40:11.000Z",
      "last_error": null,
      "legacy_fallback": false,
      "revoked_reason": null,
      "used_by": [
        {
          "env": "staging",
          "part": "frontend"
        }
      ]
    },
    {
      "provider": "railway",
      "scope": "staging",
      "scope_label": "Staging",
      "status": "connected",
      "method": "token",
      "account": null,
      "external_id": null,
      "config": {},
      "hint_last4": "c71e",
      "connected_by": "andres",
      "connected_at": "2026-10-06T16:05:00.000Z",
      "last_used_at": "2026-10-07T12:40:11.000Z",
      "last_error": null,
      "legacy_fallback": false,
      "revoked_reason": null,
      "used_by": [
        {
          "env": "staging",
          "part": "backend"
        }
      ]
    },
    {
      "provider": "vercel",
      "scope": "",
      "scope_label": null,
      "status": "connected",
      "method": "install",
      "account": {
        "id": "team_a1B2c3D4e5F6g7H8",
        "label": "Acme"
      },
      "external_id": "icfg_9Xy8Wv7Ut6Sr5Qp4",
      "config": {
        "team_id": "team_a1B2c3D4e5F6g7H8",
        "team_slug": "acme"
      },
      "hint_last4": "",
      "connected_by": "andres",
      "connected_at": "2026-10-06T16:05:00.000Z",
      "last_used_at": "2026-10-07T12:40:11.000Z",
      "last_error": null,
      "legacy_fallback": false,
      "revoked_reason": null,
      "used_by": [
        {
          "env": "staging",
          "part": "web"
        },
        {
          "env": "production",
          "part": "web"
        }
      ]
    },
    {
      "provider": "render",
      "scope": "",
      "scope_label": null,
      "status": "error",
      "method": "token",
      "account": null,
      "external_id": null,
      "config": {},
      "hint_last4": "b2e4",
      "connected_by": "andres",
      "connected_at": "2026-10-06T16:05:00.000Z",
      "last_used_at": "2026-10-07T09:40:15.000Z",
      "last_error": "render deployments 401: Unauthorized — the credential is not valid",
      "legacy_fallback": false,
      "revoked_reason": null,
      "used_by": [
        {
          "env": "staging",
          "part": "api"
        },
        {
          "env": "production",
          "part": "api"
        }
      ]
    },
    {
      "provider": "fly",
      "scope": "",
      "scope_label": null,
      "status": "connected",
      "method": "token",
      "account": null,
      "external_id": null,
      "config": {
        "org_slug": "acme"
      },
      "hint_last4": "Q2xk",
      "connected_by": "andres",
      "connected_at": "2026-10-06T16:05:00.000Z",
      "last_used_at": "2026-10-07T12:40:11.000Z",
      "last_error": null,
      "legacy_fallback": false,
      "revoked_reason": null,
      "used_by": [
        {
          "env": "production",
          "part": "worker"
        }
      ]
    },
    {
      "provider": "netlify",
      "scope": "",
      "scope_label": null,
      "status": "not_connected",
      "method": null,
      "account": null,
      "external_id": null,
      "config": {},
      "hint_last4": "",
      "connected_by": null,
      "connected_at": null,
      "last_used_at": null,
      "last_error": null,
      "legacy_fallback": false,
      "revoked_reason": null,
      "used_by": [
        {
          "env": "production",
          "part": "docs"
        }
      ]
    }
  ],
  "checklist": [
    {
      "id": "environments",
      "title": "Add an environment",
      "detail": null,
      "done": true,
      "action": {
        "kind": "none"
      }
    },
    {
      "id": "parts:staging",
      "title": "Add the parts Staging runs",
      "detail": null,
      "done": true,
      "action": {
        "kind": "none"
      }
    },
    {
      "id": "parts:production",
      "title": "Add the parts Production runs",
      "detail": null,
      "done": true,
      "action": {
        "kind": "none"
      }
    },
    {
      "id": "connect:vercel",
      "title": "Connect Vercel",
      "detail": "Installed for team Acme.",
      "done": true,
      "action": {
        "kind": "none"
      }
    },
    {
      "id": "connect:netlify",
      "title": "Connect Netlify",
      "detail": "Production › Docs site reads nothing until Netlify is connected.",
      "done": false,
      "action": {
        "kind": "connect",
        "provider": "netlify",
        "scope": ""
      }
    },
    {
      "id": "test:render",
      "title": "Fix the Render connection",
      "detail": "The last poll was refused: render deployments 401: Unauthorized — the credential is not valid.",
      "done": false,
      "action": {
        "kind": "test",
        "provider": "render",
        "scope": ""
      }
    },
    {
      "id": "connect:fly",
      "title": "Connect Fly.io",
      "detail": null,
      "done": true,
      "action": {
        "kind": "none"
      }
    }
  ],
  "secrets_available": true
};

/** A new org: no environment yet. */
export const HOSTING_SAMPLE_FRESH: HostingSetupDTO = {
  "providers": HOSTING_SAMPLE_PROVIDERS,
  "environments": [],
  "connections": [],
  "checklist": [
    {
      "id": "environments",
      "title": "Add an environment",
      "detail": "The Repo dashboard reports on each one — staging, production. Add one under Environments first.",
      "done": false,
      "action": {
        "kind": "add_environment"
      }
    }
  ],
  "secrets_available": true
};

/** Environments, but no parts yet. */
export const HOSTING_SAMPLE_NO_PARTS: HostingSetupDTO = {
  "providers": HOSTING_SAMPLE_PROVIDERS,
  "environments": [
    {
      "key": "staging",
      "label": "Staging",
      "branch": "main",
      "parts": []
    },
    {
      "key": "production",
      "label": "Production",
      "branch": "production",
      "parts": []
    }
  ],
  "connections": [],
  "checklist": [
    {
      "id": "environments",
      "title": "Add an environment",
      "detail": null,
      "done": true,
      "action": {
        "kind": "none"
      }
    },
    {
      "id": "parts:staging",
      "title": "Add the parts Staging runs",
      "detail": "The web app, API or worker this environment deploys.",
      "done": false,
      "action": {
        "kind": "add_part",
        "env": "staging"
      }
    },
    {
      "id": "parts:production",
      "title": "Add the parts Production runs",
      "detail": "The web app, API or worker this environment deploys.",
      "done": false,
      "action": {
        "kind": "add_part",
        "env": "production"
      }
    }
  ],
  "secrets_available": true
};

/** The mixed org after someone uninstalled the Vercel integration on Vercel's side. */
export const HOSTING_SAMPLE_REVOKED: HostingSetupDTO = {
  "providers": HOSTING_SAMPLE_PROVIDERS,
  "environments": [
    {
      "key": "staging",
      "label": "Staging",
      "branch": "main",
      "parts": [
        {
          "env": "staging",
          "key": "frontend",
          "label": "Frontend",
          "role": "web",
          "provider": "cloudflare",
          "settings": {
            "worker": "acme-web-staging",
            "worker_check": "Workers Builds: acme-web-staging"
          },
          "position": -2,
          "legacy": true,
          "connection": "connected",
          "console_url": "https://dash.cloudflare.com/0123456789abcdef0123456789abcdef/workers/services/view/acme-web-staging/production",
          "last_poll": null,
          "updated_at": "2026-10-06T16:20:00.000Z",
          "updated_by": "andres"
        },
        {
          "env": "staging",
          "key": "backend",
          "label": "Backend",
          "role": "service",
          "provider": "railway",
          "settings": {
            "railway_env": "acme / staging",
            "railway_environment_id": "8f2c1a9e-4b7d-4e2a-9c1f-2d3e4f5a6b7c",
            "railway_service_id": "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"
          },
          "position": -1,
          "legacy": true,
          "connection": "connected",
          "console_url": null,
          "last_poll": null,
          "updated_at": "2026-10-06T16:20:00.000Z",
          "updated_by": "andres"
        },
        {
          "env": "staging",
          "key": "web",
          "label": "Web app",
          "role": "web",
          "provider": "vercel",
          "settings": {
            "project": "acme-web",
            "target": "preview",
            "branch": "main"
          },
          "position": 0,
          "legacy": false,
          "connection": "revoked",
          "console_url": "https://vercel.com/acme/acme-web",
          "last_poll": {
            "at": "2026-10-07T12:40:11.000Z",
            "status": "ok",
            "detail": null,
            "last_ok_at": "2026-10-07T12:40:11.000Z",
            "covered": null,
            "unavailable": [
              {
                "metric": "requests",
                "reason": "Vercel exposes no public usage API (its Observability Query needs Observability Plus and is undocumented)"
              },
              {
                "metric": "errors",
                "reason": "Vercel exposes no public usage API (its Observability Query needs Observability Plus and is undocumented)"
              },
              {
                "metric": "latency_p50_ms",
                "reason": "Vercel exposes no public usage API (its Observability Query needs Observability Plus and is undocumented)"
              },
              {
                "metric": "latency_p95_ms",
                "reason": "Vercel exposes no public usage API (its Observability Query needs Observability Plus and is undocumented)"
              },
              {
                "metric": "bandwidth_bytes",
                "reason": "Vercel exposes no public usage API (its Observability Query needs Observability Plus and is undocumented)"
              }
            ]
          },
          "updated_at": "2026-10-06T16:20:00.000Z",
          "updated_by": "andres"
        },
        {
          "env": "staging",
          "key": "api",
          "label": "API",
          "role": "service",
          "provider": "render",
          "settings": {
            "service_id": "srv-cn2k8h7c3k9s73a1b2c3"
          },
          "position": 1,
          "legacy": false,
          "connection": "error",
          "console_url": "https://dashboard.render.com/web/srv-cn2k8h7c3k9s73a1b2c3",
          "last_poll": {
            "at": "2026-10-07T12:40:13.000Z",
            "status": "failed",
            "detail": "render deployments 401: Unauthorized — the credential is not valid",
            "last_ok_at": "2026-10-07T09:40:12.000Z",
            "covered": {
              "from": "2026-10-06T15:00:00.000Z",
              "to": "2026-10-07T09:00:00.000Z"
            },
            "unavailable": []
          },
          "updated_at": "2026-10-06T16:20:00.000Z",
          "updated_by": "andres"
        }
      ]
    },
    {
      "key": "production",
      "label": "Production",
      "branch": "production",
      "parts": [
        {
          "env": "production",
          "key": "web",
          "label": "Web app",
          "role": "web",
          "provider": "vercel",
          "settings": {
            "project": "acme-web",
            "target": "production"
          },
          "position": 0,
          "legacy": false,
          "connection": "revoked",
          "console_url": "https://vercel.com/acme/acme-web",
          "last_poll": {
            "at": "2026-10-07T12:40:15.000Z",
            "status": "ok",
            "detail": null,
            "last_ok_at": "2026-10-07T12:40:15.000Z",
            "covered": null,
            "unavailable": [
              {
                "metric": "requests",
                "reason": "Vercel exposes no public usage API (its Observability Query needs Observability Plus and is undocumented)"
              },
              {
                "metric": "errors",
                "reason": "Vercel exposes no public usage API (its Observability Query needs Observability Plus and is undocumented)"
              },
              {
                "metric": "latency_p50_ms",
                "reason": "Vercel exposes no public usage API (its Observability Query needs Observability Plus and is undocumented)"
              },
              {
                "metric": "latency_p95_ms",
                "reason": "Vercel exposes no public usage API (its Observability Query needs Observability Plus and is undocumented)"
              },
              {
                "metric": "bandwidth_bytes",
                "reason": "Vercel exposes no public usage API (its Observability Query needs Observability Plus and is undocumented)"
              }
            ]
          },
          "updated_at": "2026-10-06T16:20:00.000Z",
          "updated_by": "andres"
        },
        {
          "env": "production",
          "key": "api",
          "label": "API",
          "role": "web",
          "provider": "render",
          "settings": {
            "service_id": "srv-cp9f3l1d0j6c73d4e5f6"
          },
          "position": 1,
          "legacy": false,
          "connection": "error",
          "console_url": "https://dashboard.render.com/web/srv-cp9f3l1d0j6c73d4e5f6",
          "last_poll": {
            "at": "2026-10-07T12:40:16.000Z",
            "status": "failed",
            "detail": "render deployments 401: Unauthorized — the credential is not valid",
            "last_ok_at": "2026-10-07T09:40:15.000Z",
            "covered": {
              "from": "2026-10-06T15:00:00.000Z",
              "to": "2026-10-07T09:00:00.000Z"
            },
            "unavailable": [
              {
                "metric": "latency_p50_ms",
                "reason": "Trov reads Render's p95 latency only"
              }
            ]
          },
          "updated_at": "2026-10-06T16:20:00.000Z",
          "updated_by": "andres"
        },
        {
          "env": "production",
          "key": "worker",
          "label": "Worker",
          "role": "service",
          "provider": "fly",
          "settings": {
            "app": "acme-worker"
          },
          "position": 2,
          "legacy": false,
          "connection": "connected",
          "console_url": "https://fly.io/apps/acme-worker",
          "last_poll": {
            "at": "2026-10-07T12:40:18.000Z",
            "status": "ok",
            "detail": null,
            "last_ok_at": "2026-10-07T12:40:18.000Z",
            "covered": {
              "from": "2026-10-07T06:00:00.000Z",
              "to": "2026-10-07T12:00:00.000Z"
            },
            "unavailable": []
          },
          "updated_at": "2026-10-06T16:20:00.000Z",
          "updated_by": "andres"
        },
        {
          "env": "production",
          "key": "docs",
          "label": "Docs site",
          "role": "web",
          "provider": "netlify",
          "settings": {
            "site_id": "3f9a2c1e-7b4d-4e8a-9c2f-1d0e5a6b7c8d",
            "context": "production",
            "site_name": "acme-docs"
          },
          "position": 3,
          "legacy": false,
          "connection": "not_connected",
          "console_url": "https://app.netlify.com/sites/acme-docs/overview",
          "last_poll": null,
          "updated_at": "2026-10-06T16:20:00.000Z",
          "updated_by": "andres"
        }
      ]
    }
  ],
  "connections": [
    {
      "provider": "cloudflare",
      "scope": "",
      "scope_label": null,
      "status": "connected",
      "method": "token",
      "account": null,
      "external_id": null,
      "config": {
        "account_id": "0123456789abcdef0123456789abcdef"
      },
      "hint_last4": "9f3a",
      "connected_by": "andres",
      "connected_at": "2026-10-06T16:05:00.000Z",
      "last_used_at": "2026-10-07T12:40:11.000Z",
      "last_error": null,
      "legacy_fallback": false,
      "revoked_reason": null,
      "used_by": [
        {
          "env": "staging",
          "part": "frontend"
        }
      ]
    },
    {
      "provider": "railway",
      "scope": "staging",
      "scope_label": "Staging",
      "status": "connected",
      "method": "token",
      "account": null,
      "external_id": null,
      "config": {},
      "hint_last4": "c71e",
      "connected_by": "andres",
      "connected_at": "2026-10-06T16:05:00.000Z",
      "last_used_at": "2026-10-07T12:40:11.000Z",
      "last_error": null,
      "legacy_fallback": false,
      "revoked_reason": null,
      "used_by": [
        {
          "env": "staging",
          "part": "backend"
        }
      ]
    },
    {
      "provider": "vercel",
      "scope": "",
      "scope_label": null,
      "status": "revoked",
      "method": null,
      "account": {
        "id": "team_a1B2c3D4e5F6g7H8",
        "label": "Acme"
      },
      "external_id": "icfg_9Xy8Wv7Ut6Sr5Qp4",
      "config": {
        "team_id": "team_a1B2c3D4e5F6g7H8",
        "team_slug": "acme"
      },
      "hint_last4": "",
      "connected_by": "andres",
      "connected_at": "2026-10-06T16:05:00.000Z",
      "last_used_at": null,
      "last_error": null,
      "legacy_fallback": false,
      "revoked_reason": "Removed on Vercel",
      "used_by": [
        {
          "env": "staging",
          "part": "web"
        },
        {
          "env": "production",
          "part": "web"
        }
      ]
    },
    {
      "provider": "render",
      "scope": "",
      "scope_label": null,
      "status": "error",
      "method": "token",
      "account": null,
      "external_id": null,
      "config": {},
      "hint_last4": "b2e4",
      "connected_by": "andres",
      "connected_at": "2026-10-06T16:05:00.000Z",
      "last_used_at": "2026-10-07T09:40:15.000Z",
      "last_error": "render deployments 401: Unauthorized — the credential is not valid",
      "legacy_fallback": false,
      "revoked_reason": null,
      "used_by": [
        {
          "env": "staging",
          "part": "api"
        },
        {
          "env": "production",
          "part": "api"
        }
      ]
    },
    {
      "provider": "fly",
      "scope": "",
      "scope_label": null,
      "status": "connected",
      "method": "token",
      "account": null,
      "external_id": null,
      "config": {
        "org_slug": "acme"
      },
      "hint_last4": "Q2xk",
      "connected_by": "andres",
      "connected_at": "2026-10-06T16:05:00.000Z",
      "last_used_at": "2026-10-07T12:40:11.000Z",
      "last_error": null,
      "legacy_fallback": false,
      "revoked_reason": null,
      "used_by": [
        {
          "env": "production",
          "part": "worker"
        }
      ]
    },
    {
      "provider": "netlify",
      "scope": "",
      "scope_label": null,
      "status": "not_connected",
      "method": null,
      "account": null,
      "external_id": null,
      "config": {},
      "hint_last4": "",
      "connected_by": null,
      "connected_at": null,
      "last_used_at": null,
      "last_error": null,
      "legacy_fallback": false,
      "revoked_reason": null,
      "used_by": [
        {
          "env": "production",
          "part": "docs"
        }
      ]
    }
  ],
  "checklist": [
    {
      "id": "environments",
      "title": "Add an environment",
      "detail": null,
      "done": true,
      "action": {
        "kind": "none"
      }
    },
    {
      "id": "parts:staging",
      "title": "Add the parts Staging runs",
      "detail": null,
      "done": true,
      "action": {
        "kind": "none"
      }
    },
    {
      "id": "parts:production",
      "title": "Add the parts Production runs",
      "detail": null,
      "done": true,
      "action": {
        "kind": "none"
      }
    },
    {
      "id": "connect:vercel",
      "title": "Reconnect Vercel",
      "detail": "The integration was removed on Vercel, so Staging › Web app and Production › Web app stopped updating.",
      "done": false,
      "action": {
        "kind": "connect",
        "provider": "vercel",
        "scope": ""
      }
    },
    {
      "id": "connect:netlify",
      "title": "Connect Netlify",
      "detail": "Production › Docs site reads nothing until Netlify is connected.",
      "done": false,
      "action": {
        "kind": "connect",
        "provider": "netlify",
        "scope": ""
      }
    },
    {
      "id": "test:render",
      "title": "Fix the Render connection",
      "detail": "The last poll was refused: render deployments 401: Unauthorized — the credential is not valid.",
      "done": false,
      "action": {
        "kind": "test",
        "provider": "render",
        "scope": ""
      }
    },
    {
      "id": "connect:fly",
      "title": "Connect Fly.io",
      "detail": null,
      "done": true,
      "action": {
        "kind": "none"
      }
    }
  ],
  "secrets_available": true
};

/** The mixed org on a deployment whose platform key is missing: nothing can be saved. */
export const HOSTING_SAMPLE_SECRETS_LOCKED: HostingSetupDTO = {
  "providers": HOSTING_SAMPLE_PROVIDERS,
  "environments": [
    {
      "key": "staging",
      "label": "Staging",
      "branch": "main",
      "parts": [
        {
          "env": "staging",
          "key": "frontend",
          "label": "Frontend",
          "role": "web",
          "provider": "cloudflare",
          "settings": {
            "worker": "acme-web-staging",
            "worker_check": "Workers Builds: acme-web-staging"
          },
          "position": -2,
          "legacy": true,
          "connection": "connected",
          "console_url": "https://dash.cloudflare.com/0123456789abcdef0123456789abcdef/workers/services/view/acme-web-staging/production",
          "last_poll": null,
          "updated_at": "2026-10-06T16:20:00.000Z",
          "updated_by": "andres"
        },
        {
          "env": "staging",
          "key": "backend",
          "label": "Backend",
          "role": "service",
          "provider": "railway",
          "settings": {
            "railway_env": "acme / staging",
            "railway_environment_id": "8f2c1a9e-4b7d-4e2a-9c1f-2d3e4f5a6b7c",
            "railway_service_id": "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"
          },
          "position": -1,
          "legacy": true,
          "connection": "connected",
          "console_url": null,
          "last_poll": null,
          "updated_at": "2026-10-06T16:20:00.000Z",
          "updated_by": "andres"
        },
        {
          "env": "staging",
          "key": "web",
          "label": "Web app",
          "role": "web",
          "provider": "vercel",
          "settings": {
            "project": "acme-web",
            "target": "preview",
            "branch": "main"
          },
          "position": 0,
          "legacy": false,
          "connection": "connected",
          "console_url": "https://vercel.com/acme/acme-web",
          "last_poll": {
            "at": "2026-10-07T12:40:11.000Z",
            "status": "ok",
            "detail": null,
            "last_ok_at": "2026-10-07T12:40:11.000Z",
            "covered": null,
            "unavailable": [
              {
                "metric": "requests",
                "reason": "Vercel exposes no public usage API (its Observability Query needs Observability Plus and is undocumented)"
              },
              {
                "metric": "errors",
                "reason": "Vercel exposes no public usage API (its Observability Query needs Observability Plus and is undocumented)"
              },
              {
                "metric": "latency_p50_ms",
                "reason": "Vercel exposes no public usage API (its Observability Query needs Observability Plus and is undocumented)"
              },
              {
                "metric": "latency_p95_ms",
                "reason": "Vercel exposes no public usage API (its Observability Query needs Observability Plus and is undocumented)"
              },
              {
                "metric": "bandwidth_bytes",
                "reason": "Vercel exposes no public usage API (its Observability Query needs Observability Plus and is undocumented)"
              }
            ]
          },
          "updated_at": "2026-10-06T16:20:00.000Z",
          "updated_by": "andres"
        },
        {
          "env": "staging",
          "key": "api",
          "label": "API",
          "role": "service",
          "provider": "render",
          "settings": {
            "service_id": "srv-cn2k8h7c3k9s73a1b2c3"
          },
          "position": 1,
          "legacy": false,
          "connection": "error",
          "console_url": "https://dashboard.render.com/web/srv-cn2k8h7c3k9s73a1b2c3",
          "last_poll": {
            "at": "2026-10-07T12:40:13.000Z",
            "status": "failed",
            "detail": "render deployments 401: Unauthorized — the credential is not valid",
            "last_ok_at": "2026-10-07T09:40:12.000Z",
            "covered": {
              "from": "2026-10-06T15:00:00.000Z",
              "to": "2026-10-07T09:00:00.000Z"
            },
            "unavailable": []
          },
          "updated_at": "2026-10-06T16:20:00.000Z",
          "updated_by": "andres"
        }
      ]
    },
    {
      "key": "production",
      "label": "Production",
      "branch": "production",
      "parts": [
        {
          "env": "production",
          "key": "web",
          "label": "Web app",
          "role": "web",
          "provider": "vercel",
          "settings": {
            "project": "acme-web",
            "target": "production"
          },
          "position": 0,
          "legacy": false,
          "connection": "connected",
          "console_url": "https://vercel.com/acme/acme-web",
          "last_poll": {
            "at": "2026-10-07T12:40:15.000Z",
            "status": "ok",
            "detail": null,
            "last_ok_at": "2026-10-07T12:40:15.000Z",
            "covered": null,
            "unavailable": [
              {
                "metric": "requests",
                "reason": "Vercel exposes no public usage API (its Observability Query needs Observability Plus and is undocumented)"
              },
              {
                "metric": "errors",
                "reason": "Vercel exposes no public usage API (its Observability Query needs Observability Plus and is undocumented)"
              },
              {
                "metric": "latency_p50_ms",
                "reason": "Vercel exposes no public usage API (its Observability Query needs Observability Plus and is undocumented)"
              },
              {
                "metric": "latency_p95_ms",
                "reason": "Vercel exposes no public usage API (its Observability Query needs Observability Plus and is undocumented)"
              },
              {
                "metric": "bandwidth_bytes",
                "reason": "Vercel exposes no public usage API (its Observability Query needs Observability Plus and is undocumented)"
              }
            ]
          },
          "updated_at": "2026-10-06T16:20:00.000Z",
          "updated_by": "andres"
        },
        {
          "env": "production",
          "key": "api",
          "label": "API",
          "role": "web",
          "provider": "render",
          "settings": {
            "service_id": "srv-cp9f3l1d0j6c73d4e5f6"
          },
          "position": 1,
          "legacy": false,
          "connection": "error",
          "console_url": "https://dashboard.render.com/web/srv-cp9f3l1d0j6c73d4e5f6",
          "last_poll": {
            "at": "2026-10-07T12:40:16.000Z",
            "status": "failed",
            "detail": "render deployments 401: Unauthorized — the credential is not valid",
            "last_ok_at": "2026-10-07T09:40:15.000Z",
            "covered": {
              "from": "2026-10-06T15:00:00.000Z",
              "to": "2026-10-07T09:00:00.000Z"
            },
            "unavailable": [
              {
                "metric": "latency_p50_ms",
                "reason": "Trov reads Render's p95 latency only"
              }
            ]
          },
          "updated_at": "2026-10-06T16:20:00.000Z",
          "updated_by": "andres"
        },
        {
          "env": "production",
          "key": "worker",
          "label": "Worker",
          "role": "service",
          "provider": "fly",
          "settings": {
            "app": "acme-worker"
          },
          "position": 2,
          "legacy": false,
          "connection": "connected",
          "console_url": "https://fly.io/apps/acme-worker",
          "last_poll": {
            "at": "2026-10-07T12:40:18.000Z",
            "status": "ok",
            "detail": null,
            "last_ok_at": "2026-10-07T12:40:18.000Z",
            "covered": {
              "from": "2026-10-07T06:00:00.000Z",
              "to": "2026-10-07T12:00:00.000Z"
            },
            "unavailable": []
          },
          "updated_at": "2026-10-06T16:20:00.000Z",
          "updated_by": "andres"
        },
        {
          "env": "production",
          "key": "docs",
          "label": "Docs site",
          "role": "web",
          "provider": "netlify",
          "settings": {
            "site_id": "3f9a2c1e-7b4d-4e8a-9c2f-1d0e5a6b7c8d",
            "context": "production",
            "site_name": "acme-docs"
          },
          "position": 3,
          "legacy": false,
          "connection": "not_connected",
          "console_url": "https://app.netlify.com/sites/acme-docs/overview",
          "last_poll": null,
          "updated_at": "2026-10-06T16:20:00.000Z",
          "updated_by": "andres"
        }
      ]
    }
  ],
  "connections": [
    {
      "provider": "cloudflare",
      "scope": "",
      "scope_label": null,
      "status": "connected",
      "method": "token",
      "account": null,
      "external_id": null,
      "config": {
        "account_id": "0123456789abcdef0123456789abcdef"
      },
      "hint_last4": "9f3a",
      "connected_by": "andres",
      "connected_at": "2026-10-06T16:05:00.000Z",
      "last_used_at": "2026-10-07T12:40:11.000Z",
      "last_error": null,
      "legacy_fallback": false,
      "revoked_reason": null,
      "used_by": [
        {
          "env": "staging",
          "part": "frontend"
        }
      ]
    },
    {
      "provider": "railway",
      "scope": "staging",
      "scope_label": "Staging",
      "status": "connected",
      "method": "token",
      "account": null,
      "external_id": null,
      "config": {},
      "hint_last4": "c71e",
      "connected_by": "andres",
      "connected_at": "2026-10-06T16:05:00.000Z",
      "last_used_at": "2026-10-07T12:40:11.000Z",
      "last_error": null,
      "legacy_fallback": false,
      "revoked_reason": null,
      "used_by": [
        {
          "env": "staging",
          "part": "backend"
        }
      ]
    },
    {
      "provider": "vercel",
      "scope": "",
      "scope_label": null,
      "status": "connected",
      "method": "install",
      "account": {
        "id": "team_a1B2c3D4e5F6g7H8",
        "label": "Acme"
      },
      "external_id": "icfg_9Xy8Wv7Ut6Sr5Qp4",
      "config": {
        "team_id": "team_a1B2c3D4e5F6g7H8",
        "team_slug": "acme"
      },
      "hint_last4": "",
      "connected_by": "andres",
      "connected_at": "2026-10-06T16:05:00.000Z",
      "last_used_at": "2026-10-07T12:40:11.000Z",
      "last_error": null,
      "legacy_fallback": false,
      "revoked_reason": null,
      "used_by": [
        {
          "env": "staging",
          "part": "web"
        },
        {
          "env": "production",
          "part": "web"
        }
      ]
    },
    {
      "provider": "render",
      "scope": "",
      "scope_label": null,
      "status": "error",
      "method": "token",
      "account": null,
      "external_id": null,
      "config": {},
      "hint_last4": "b2e4",
      "connected_by": "andres",
      "connected_at": "2026-10-06T16:05:00.000Z",
      "last_used_at": "2026-10-07T09:40:15.000Z",
      "last_error": "render deployments 401: Unauthorized — the credential is not valid",
      "legacy_fallback": false,
      "revoked_reason": null,
      "used_by": [
        {
          "env": "staging",
          "part": "api"
        },
        {
          "env": "production",
          "part": "api"
        }
      ]
    },
    {
      "provider": "fly",
      "scope": "",
      "scope_label": null,
      "status": "connected",
      "method": "token",
      "account": null,
      "external_id": null,
      "config": {
        "org_slug": "acme"
      },
      "hint_last4": "Q2xk",
      "connected_by": "andres",
      "connected_at": "2026-10-06T16:05:00.000Z",
      "last_used_at": "2026-10-07T12:40:11.000Z",
      "last_error": null,
      "legacy_fallback": false,
      "revoked_reason": null,
      "used_by": [
        {
          "env": "production",
          "part": "worker"
        }
      ]
    },
    {
      "provider": "netlify",
      "scope": "",
      "scope_label": null,
      "status": "not_connected",
      "method": null,
      "account": null,
      "external_id": null,
      "config": {},
      "hint_last4": "",
      "connected_by": null,
      "connected_at": null,
      "last_used_at": null,
      "last_error": null,
      "legacy_fallback": false,
      "revoked_reason": null,
      "used_by": [
        {
          "env": "production",
          "part": "docs"
        }
      ]
    }
  ],
  "checklist": [
    {
      "id": "environments",
      "title": "Add an environment",
      "detail": null,
      "done": true,
      "action": {
        "kind": "none"
      }
    },
    {
      "id": "parts:staging",
      "title": "Add the parts Staging runs",
      "detail": null,
      "done": true,
      "action": {
        "kind": "none"
      }
    },
    {
      "id": "parts:production",
      "title": "Add the parts Production runs",
      "detail": null,
      "done": true,
      "action": {
        "kind": "none"
      }
    },
    {
      "id": "connect:vercel",
      "title": "Connect Vercel",
      "detail": "Installed for team Acme.",
      "done": true,
      "action": {
        "kind": "none"
      }
    },
    {
      "id": "connect:netlify",
      "title": "Connect Netlify",
      "detail": "Production › Docs site reads nothing until Netlify is connected.",
      "done": false,
      "action": {
        "kind": "connect",
        "provider": "netlify",
        "scope": ""
      }
    },
    {
      "id": "test:render",
      "title": "Fix the Render connection",
      "detail": "The last poll was refused: render deployments 401: Unauthorized — the credential is not valid.",
      "done": false,
      "action": {
        "kind": "test",
        "provider": "render",
        "scope": ""
      }
    },
    {
      "id": "connect:fly",
      "title": "Connect Fly.io",
      "detail": null,
      "done": true,
      "action": {
        "kind": "none"
      }
    }
  ],
  "secrets_available": false
};

/** Every state, by name — for a state picker in a design / preview build. */
export const HOSTING_SAMPLES: Record<"mixed" | "fresh" | "no_parts" | "revoked" | "secrets_locked", HostingSetupDTO> = {
  mixed: HOSTING_SAMPLE_MIXED, fresh: HOSTING_SAMPLE_FRESH, no_parts: HOSTING_SAMPLE_NO_PARTS,
  revoked: HOSTING_SAMPLE_REVOKED, secrets_locked: HOSTING_SAMPLE_SECRETS_LOCKED,
};

/** `POST /api/o/:slug/hosting/vercel/connect` — then the browser goes to `url`. */
export const HOSTING_SAMPLE_CONNECT_START: ConnectStartDTO = {
  url: "https://vercel.com/integrations/trov/new?state=eyJvIjoib3JnX2FjbWUiLCJwIjoidmVyY2VsIn0.c2lnbmF0dXJl",
  method: "install",
  expires_at: "2026-10-07T12:55:00.000Z",
};

/** `POST /api/o/:slug/hosting/:provider/test` — a pass and a refusal (details are scrubbed server-side). */
export const HOSTING_SAMPLE_TEST_OK: HostingTestDTO = {
  ok: true,
  detail: "Fly.io answered for app acme-worker (deployed).",
  connection: HOSTING_SAMPLE_MIXED.connections.find((c) => c.provider === "fly")!,
};
export const HOSTING_SAMPLE_TEST_FAILED: HostingTestDTO = {
  ok: false,
  detail: "render service 401: Unauthorized — the credential is not valid",
  connection: HOSTING_SAMPLE_MIXED.connections.find((c) => c.provider === "render")!,
};

/** The `hosting` lines of a Poll now result (`RepoRefreshResult.hosting`). */
export const HOSTING_SAMPLE_POLL: HostingPollOutcome[] = [
  { env: "staging", part: "web", provider: "vercel", status: "ok", written: 2 },
  { env: "staging", part: "api", provider: "render", status: "failed", written: 0, detail: "render deployments 401: Unauthorized — the credential is not valid" },
  { env: "production", part: "web", provider: "vercel", status: "ok", written: 0 },
  { env: "production", part: "api", provider: "render", status: "failed", written: 0, detail: "render deployments 401: Unauthorized — the credential is not valid" },
  { env: "production", part: "worker", provider: "fly", status: "ok", written: 7 },
  { env: "production", part: "docs", provider: "netlify", status: "skipped", written: 0, detail: "not connected" },
];

/** The redirect back from a provider: `#org/hosting?connected=<provider>` / `?connect_error=<code>`. */
export const HOSTING_CONNECT_ERROR_CODES = ["expired", "mismatch", "forbidden", "exchange_failed"] as const;

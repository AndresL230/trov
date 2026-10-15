// Org settings › Hosting — SAMPLE DATA (#97–#102). The data stubs the Hosting screens are designed and built
// against (docs/design/hosting-providers-claude-design-prompt.md), one payload per state of
// `GET /api/o/:slug/hosting` (`HostingSetupDTO`, shared/hosting.ts), plus the connect / test / poll answers.
// Like web/src/repo-sample.ts it is meant for a dynamic import (a "Preview with sample data" toggle) and must
// never be in the main bundle.
//
// HOSTING_SAMPLE_PROVIDERS is the REAL catalogue: what `providerDTO` returns for every registered provider on a
// deployment that has the Vercel integration and the Netlify OAuth app configured. test/hosting.sample.test.ts
// fails when a provider changes and this copy does not — regenerate it from src/hosting/registry.ts.
import {
  HOSTING_CONNECT_OUTCOMES, HOSTING_PROVIDERS, metricsForRole,
  type ConnectStartDTO, type ConnectionStatus, type EnvironmentPartDTO, type HostingChecklistItem, type HostingConnectOutcome, type HostingConnectionDTO,
  type HostingDetectionDTO, type HostingDetectionStatusDTO, type HostingEnvironmentDTO, type HostingPollOutcome, type HostingProviderDTO,
  type HostingLeftoverDTO, type HostingProviderId, type HostingSetupDTO, type HostingTestDTO, type PartRole,
} from "@shared/hosting";
import { LEFTOVER_TOKEN_LABEL, hostingStatus } from "@shared/hosting-status-core";
import type { HostingSampleKey, HostingStackKey } from "./hosting-keys";

export const HOSTING_SAMPLE_PROVIDERS: HostingProviderDTO[] = [
  {
    "id": "cloudflare",
    "label": "Cloudflare Workers",
    "status": "available",
    "summary": "A Cloudflare Worker. Trov reads its deploys, requests and errors.",
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
    "connection_methods": [
      {
        "method": "token",
        "label": "Paste an API token",
        "how_to": "1. In the Cloudflare dashboard, open My Profile › API Tokens › Create Token › Create Custom Token.\n2. Add two permissions, both read-only: Account › Account Analytics › Read, and Account › Workers Scripts › Read.\n3. Optional, for the commit behind each deploy: also add Account › Workers CI › Read (Workers Builds). Without it Trov finds the commit from GitHub when it can.\n4. Under Account Resources, pick only the account your Workers live under.\n5. Paste the token here, and set Account ID to that account's 32-character id (Workers & Pages › Overview).\nThe token is only ever sent to api.cloudflare.com.",
        "grants": [
          "Account Analytics: Read on one account",
          "Workers Scripts: Read on that account (its Workers' deployments)",
          "Optional — Workers CI: Read (the commit each deploy was built from)"
        ],
        "available": true,
        "unavailable_reason": null
      }
    ],
    "org_config_fields": [
      {
        "key": "account_id",
        "label": "Account ID",
        "description": "The 32-character id of the Cloudflare account the Workers live under. Not a secret.",
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
      }
    ],
    "docs_url": "https://developers.cloudflare.com/analytics/graphql-api/"
  },
  {
    "id": "railway",
    "label": "Railway",
    "status": "available",
    "summary": "A Railway service. Trov reads its deploys, and its traffic or CPU and memory.",
    "roles": [
      "web",
      "service"
    ],
    "capabilities": {
      "deploys": true,
      "metrics": [
        "requests",
        "errors",
        "latency_p50_ms",
        "latency_p95_ms",
        "bandwidth_bytes",
        "cpu",
        "mem_mb"
      ]
    },
    "plan_note": null,
    "api_hosts": [
      "backboard.railway.com"
    ],
    "connection_methods": [
      {
        "method": "token",
        "label": "Paste a workspace token",
        "how_to": "1. In Railway, open Account Settings › Tokens (railway.com/account/tokens) and create a token.\n2. In its Workspace dropdown, pick the workspace that owns the project.\n3. Paste the token here.\nA WORKSPACE token is the narrowest Railway offers. An account token (\"No workspace\") also works but reaches every workspace you belong to; a project token does not work, because it is bound to one environment.\nRailway has no read-only scope: the token can also change what is in its workspace. It is only ever sent to backboard.railway.com.",
        "grants": [
          "Full access to one Railway workspace — everything in it (Railway has no read-only token)"
        ],
        "available": true,
        "unavailable_reason": null
      }
    ],
    "org_config_fields": [
      {
        "key": "workspace_id",
        "label": "Workspace ID",
        "description": "Optional. The Railway workspace the token belongs to (Workspace settings). Test connection then checks the token against it. Not a secret.",
        "required": false,
        "placeholder": null,
        "pattern": "^[A-Za-z0-9-]{1,100}$"
      }
    ],
    "part_settings": [
      {
        "key": "environment_id",
        "label": "Railway environment ID",
        "description": "The environment's id: Project › Settings › Environments, or environmentId= in the service's URL.",
        "required": true,
        "placeholder": null,
        "pattern": "^[A-Za-z0-9-]{1,100}$"
      },
      {
        "key": "service_id",
        "label": "Railway service ID",
        "description": "The service's id: its Settings tab, or the part after /service/ in its URL. The same in every environment.",
        "required": true,
        "placeholder": null,
        "pattern": "^[A-Za-z0-9-]{1,100}$"
      },
      {
        "key": "project_id",
        "label": "Railway project ID",
        "description": "Optional. The project's id (Project › Settings, or the part after /project/ in its URL) — only for the Open in Railway link.",
        "required": false,
        "placeholder": null,
        "pattern": "^[A-Za-z0-9-]{1,100}$"
      }
    ],
    "docs_url": "https://docs.railway.com/reference/public-api"
  },
  {
    "id": "vercel",
    "label": "Vercel",
    "status": "available",
    "summary": "A Vercel project. Trov reads its production or preview deploys.",
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
    "connection_methods": [
      {
        "method": "install",
        "label": "Connect with Vercel",
        "how_to": "1. Vercel opens its install screen for Trov's integration.\n2. Pick your personal account, or the team that owns the project.\n3. Choose \"Specific Projects\" and select only the projects Trov should read (\"All Projects\" works but grants more).\n4. Confirm. Vercel sends you back here.\nTrov reads the projects and deployments you pick, your team's and your account's name, and its own installation (which it removes when you disconnect here). Uninstalling the integration on Vercel (Settings › Integrations) disconnects Trov too.\nThe access token Vercel issues is stored encrypted and only ever sent to api.vercel.com.",
        "grants": [
          "Projects: Read — on the projects you pick",
          "Deployments: Read — on the projects you pick",
          "Team and User: Read — the account's name, shown on this page",
          "Integration Configuration: Read / Write — its own installation, so Disconnect here uninstalls it on Vercel"
        ],
        "available": true,
        "unavailable_reason": null
      },
      {
        "method": "token",
        "label": "Paste an access token",
        "how_to": "1. In Vercel, open Account Settings › Tokens › Create Token.\n2. Scope it to the ONE project Trov should read — or, where that is not offered, to the one team that owns it. Never Full Account.\n3. Set an expiry (Vercel allows 1 day to 1 year; Trov shows a 401 when it lapses).\n4. Paste it here. When the project belongs to a team, also set Team ID.\nVercel has no read-only token: whoever holds it can also change what it reaches, which is why one project is the narrowest choice. The token is only ever sent to api.vercel.com.",
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
    "docs_url": "https://vercel.com/docs/rest-api"
  },
  {
    "id": "render",
    "label": "Render",
    "status": "available",
    "summary": "A Render service. Trov reads its deploys, and its traffic or CPU and memory.",
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
    "connection_methods": [
      {
        "method": "token",
        "label": "Paste an API key",
        "how_to": "1. In the Render Dashboard, open Account Settings › API Keys › Create API Key.\n2. Paste the key here (Render shows it only once).\nRender API keys have NO scopes and no read-only mode, and are not bound to a workspace: a key acts as its user — with everything that user may do, including changing and deleting services — in EVERY workspace the user belongs to.\nThe narrowest option is a key from a dedicated member account that belongs only to this workspace. The key is only ever sent to api.render.com.",
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
    "docs_url": "https://api-docs.render.com/reference/introduction"
  },
  {
    "id": "netlify",
    "label": "Netlify",
    "status": "available",
    "summary": "A Netlify site. Trov reads its production or branch deploys.",
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
    "connection_methods": [
      {
        "method": "oauth",
        "label": "Connect with Netlify",
        "how_to": "1. Netlify opens and asks you to approve Trov's OAuth application.\n2. Approve with an account that belongs only to the team whose sites Trov should see.\n3. Netlify sends you back here.\nNetlify OAuth has NO scopes: the token acts as the person who approves it, across every team they belong to. Trov only reads deploys.\nDisconnecting here deletes Trov's copy; to end the grant on Netlify's side too, revoke Trov under User settings › Applications. The token is only ever sent to api.netlify.com.",
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
        "how_to": "1. In Netlify, open User settings › Applications › Personal access tokens › New access token.\n2. Name it \"Trov\" and set an expiration (paste a new one here when it runs out).\n3. Tick the SAML-team access box only if the site lives in a SAML-based team.\n4. Paste the token here.\nNetlify has no scoped or read-only tokens: it has full access to your account and every team you belong to, so create it from an account that belongs only to the team whose sites Trov should see. The token is only ever sent to api.netlify.com.",
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
    "docs_url": "https://docs.netlify.com/api/get-started/"
  },
  {
    "id": "fly",
    "label": "Fly.io",
    "status": "available",
    "summary": "A Fly.io app. Trov reads its releases, and its traffic or CPU and memory.",
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
    "connection_methods": [
      {
        "method": "token",
        "label": "Paste a read-only token",
        "how_to": "1. Find your organization's slug: `fly orgs list`.\n2. Run `fly tokens create readonly <org-slug> --name trov --expiry 8760h`.\n3. Paste the whole output here — a leading \"FlyV1 \" is fine.\nIt is a READ-ONLY token for one organization, the narrowest Fly.io offers: it can read that organization's apps, releases and metrics and change nothing. Never paste the output of `fly auth token` — that is your personal token, with full access to every organization you belong to.\nThe token stops working after its --expiry (8760h is one year); create a new one before then. It is only ever sent to api.machines.dev and api.fly.io.",
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
    "docs_url": "https://fly.io/docs/monitoring/metrics/"
  },
  {
    "id": "aws",
    "label": "AWS",
    "status": "later",
    "summary": "An AWS service. Trov will read its CloudWatch metrics. Coming later.",
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
    "connection_methods": [
      {
        "method": "assume_role",
        "label": "Grant Trov a read-only role",
        "how_to": "1. In IAM, create a role for \"Another AWS account\", with Trov's account id (shown here).\n2. Require the external id shown here.\n3. Attach a policy that allows only cloudwatch:GetMetricData (and cloudwatch:ListMetrics), optionally limited by resource.\n4. Paste the role's ARN and pick its region.\nNo access key is ever pasted into Trov.",
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
    "docs_url": "https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_create_for-user_externalid.html"
  },
  {
    "id": "github",
    "label": "GitHub deployments",
    "status": "available",
    "summary": "An app deployed from GitHub. Trov reads its deploys from GitHub: a deployment environment, a check run or a workflow.",
    "roles": ["web", "service"],
    "capabilities": { "deploys": true, "metrics": [] },
    "plan_note": "GitHub reports deploys only: no traffic, CPU or memory.",
    "api_hosts": ["api.github.com"],
    "connection_methods": [],
    "org_config_fields": [],
    "part_settings": [
      {
        "key": "environment",
        "label": "Deployment environment",
        "description": "A GitHub deployment environment, exactly as GitHub names it (Repository › Deployments), e.g. Production – web.",
        "required": false,
        "placeholder": "Production – web",
        "pattern": "^[^\\u0000-\\u001f\\u007f]{1,200}$"
      },
      {
        "key": "check_app",
        "label": "Check run app",
        "description": "With Check run name: the GitHub App that posts the check (its slug), e.g. cloudflare-workers-and-pages.",
        "required": false,
        "placeholder": "cloudflare-workers-and-pages",
        "pattern": "^[a-z0-9][a-z0-9-]{0,99}$"
      },
      {
        "key": "check_name",
        "label": "Check run name",
        "description": "With Check run app: the check's name as the commit's checks list shows it.",
        "required": false,
        "placeholder": "Workers Builds: web",
        "pattern": "^[^\\u0000-\\u001f\\u007f]{1,200}$"
      },
      {
        "key": "workflow",
        "label": "Workflow file",
        "description": "A GitHub Actions workflow whose completed runs on the environment's branch are the deploys, e.g. .github/workflows/deploy.yml.",
        "required": false,
        "placeholder": ".github/workflows/deploy.yml",
        "pattern": "^(?:\\.github\\/workflows\\/)?[A-Za-z0-9._-]{1,100}\\.ya?ml$"
      }
    ],
    "docs_url": "https://docs.github.com/en/actions/deployment/about-deployments",
    "via_github": true
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
            "worker": "acme-web-staging"
          },
          "position": -2,
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
            "environment_id": "8f2c1a9e-4b7d-4e2a-9c1f-2d3e4f5a6b7c",
            "service_id": "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"
          },
          "position": -1,
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
      "manage_url": "https://dash.cloudflare.com/profile/api-tokens",
      "used_by": [
        {
          "env": "staging",
          "part": "frontend"
        }
      ]
    },
    {
      "provider": "railway",
      "scope": "",
      "scope_label": null,
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
      "manage_url": null,
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
      "manage_url": "https://vercel.com/acme/~/integrations",
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
      "manage_url": "https://dashboard.render.com/u/settings#api-keys",
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
      "manage_url": null,
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
      "manage_url": null,
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
  "detected": [],
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
  "detected": [],
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
  "detected": [
    {
      "provider": "vercel",
      "evidence": "GitHub check runs posted by the Vercel app",
      "last_seen": "2026-10-07T11:52:40.000Z",
      "in_use": false
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
            "worker": "acme-web-staging"
          },
          "position": -2,
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
            "environment_id": "8f2c1a9e-4b7d-4e2a-9c1f-2d3e4f5a6b7c",
            "service_id": "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"
          },
          "position": -1,
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
      "manage_url": "https://dash.cloudflare.com/profile/api-tokens",
      "used_by": [
        {
          "env": "staging",
          "part": "frontend"
        }
      ]
    },
    {
      "provider": "railway",
      "scope": "",
      "scope_label": null,
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
      "manage_url": null,
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
      "manage_url": "https://vercel.com/acme/~/integrations",
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
      "manage_url": "https://dashboard.render.com/u/settings#api-keys",
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
      "manage_url": null,
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
      "manage_url": null,
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
  "detected": [],
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
            "worker": "acme-web-staging"
          },
          "position": -2,
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
            "environment_id": "8f2c1a9e-4b7d-4e2a-9c1f-2d3e4f5a6b7c",
            "service_id": "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"
          },
          "position": -1,
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
      "manage_url": "https://dash.cloudflare.com/profile/api-tokens",
      "used_by": [
        {
          "env": "staging",
          "part": "frontend"
        }
      ]
    },
    {
      "provider": "railway",
      "scope": "",
      "scope_label": null,
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
      "manage_url": null,
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
      "manage_url": "https://vercel.com/acme/~/integrations",
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
      "manage_url": "https://dashboard.render.com/u/settings#api-keys",
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
      "manage_url": null,
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
      "manage_url": null,
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
  "detected": [],
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

/** The return from a provider lands on `/<slug>/?hosting=<outcome>&provider=<id>#org/hosting` (src/hosting/connections.ts
 *  `connectReturnUrl`). The vocabulary is ONE list, `HOSTING_CONNECT_OUTCOMES` (shared/hosting.ts); these are its
 *  refusals — every outcome but `connected` — each of which the UI words as a sentence. */
export const HOSTING_CONNECT_ERROR_CODES: readonly Exclude<HostingConnectOutcome, "connected">[] =
  HOSTING_CONNECT_OUTCOMES.filter((o): o is Exclude<HostingConnectOutcome, "connected"> => o !== "connected");

// ── the scenario switchers: a FLOW (where a new org stands) × a STACK (which hosts it runs on) ────────────────
//
// `hostingScenario(flow, stack)` builds a whole `HostingSetupDTO` from the catalogue above and the shapes the
// server returns (src/hosting/setup.ts) — so every combination of the two switchers is a payload the screen could
// really receive. Detection follows what Trov can really see: Cloudflare, Vercel and Netlify post GitHub check
// runs, so a stack of theirs is FOUND; Render, Railway and Fly.io do not, so a stack of only theirs finds NONE.

type EnvKey = "staging" | "production";
interface StackPart { key: string; label: string; role: PartRole; provider: HostingProviderId; settings: Readonly<Record<string, string | undefined>> }
/** The settings with no unset key (a ternary's other branch leaves some `undefined`). */
const clean = (o: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(Object.entries(o).filter((e): e is [string, string] => typeof e[1] === "string"));

const RAILWAY_ENV: Record<EnvKey, string> = { staging: "8f2c1a9e-4b7d-4e2a-9c1f-2d3e4f5a6b7c", production: "2b7d9e4f-1a3c-4d5e-8f6a-7b8c9d0e1f2a" };
const STACKS: Record<HostingStackKey, (env: EnvKey) => StackPart[]> = {
  vercel_render: (e) => [
    { key: "web", label: "Web app", role: "web", provider: "vercel", settings: e === "staging" ? { project: "acme-web", target: "preview", branch: "main" } : { project: "acme-web", target: "production" } },
    { key: "api", label: "API", role: "web", provider: "render", settings: { service_id: e === "staging" ? "srv-st4g1ngap1k8q1j7mg" : "srv-pr0dap1k8q1j7mgec7" } },
  ],
  netlify_fly: (e) => [
    { key: "site", label: "Site", role: "web", provider: "netlify", settings: e === "staging" ? { site_id: "3f2a9c1e-7b4d-4e8a-9c2f-5d6e7f8a9b0c", context: "branch", branch: "staging" } : { site_id: "3f2a9c1e-7b4d-4e8a-9c2f-5d6e7f8a9b0c", context: "production" } },
    { key: "api", label: "API", role: "web", provider: "fly", settings: { app: e === "staging" ? "acme-api-staging" : "acme-api" } },
  ],
  cloudflare_railway: (e) => [
    { key: "frontend", label: "Frontend", role: "web", provider: "cloudflare", settings: { worker: e === "staging" ? "acme-web-staging" : "acme-web" } },
    { key: "backend", label: "Backend", role: "service", provider: "railway", settings: { environment_id: RAILWAY_ENV[e], service_id: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d" } },
  ],
  render_only: (e) => [
    { key: "web", label: "Web app", role: "web", provider: "render", settings: { service_id: e === "staging" ? "srv-st4g1ngweb8q1j7mg" : "srv-pr0dweb8q1j7mgec7" } },
    { key: "worker", label: "Worker", role: "service", provider: "render", settings: { service_id: e === "staging" ? "srv-st4g1ngwrk8q1j7mg" : "srv-pr0dwrk8q1j7mgec7" } },
  ],
  railway_only: (e) => [
    { key: "web", label: "Web app", role: "web", provider: "railway", settings: { environment_id: RAILWAY_ENV[e], service_id: "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b" } },
    { key: "api", label: "API", role: "service", provider: "railway", settings: { environment_id: RAILWAY_ENV[e], service_id: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d" } },
  ],
  vercel_only: (e) => [
    { key: "web", label: "Web app", role: "web", provider: "vercel", settings: e === "staging" ? { project: "acme-web", target: "preview", branch: "main" } : { project: "acme-web", target: "production" } },
  ],
  mixed: (e) => e === "staging" ? [
    { key: "frontend", label: "Frontend", role: "web", provider: "cloudflare", settings: { worker: "acme-web-staging" } },
    { key: "backend", label: "Backend", role: "service", provider: "railway", settings: { environment_id: RAILWAY_ENV.staging, service_id: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d" } },
    { key: "web", label: "Web app", role: "web", provider: "vercel", settings: { project: "acme-web", target: "preview", branch: "main" } },
    { key: "api", label: "API", role: "web", provider: "render", settings: { service_id: "srv-st4g1ngap1k8q1j7mg" } },
  ] : [
    { key: "web", label: "Web app", role: "web", provider: "vercel", settings: { project: "acme-web", target: "production" } },
    { key: "api", label: "API", role: "web", provider: "render", settings: { service_id: "srv-pr0dap1k8q1j7mgec7" } },
    { key: "worker", label: "Queue worker", role: "service", provider: "fly", settings: { app: "acme-worker" } },
    { key: "docs", label: "Docs site", role: "web", provider: "netlify", settings: { site_id: "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f", context: "production" } },
  ],
};

/** What a CONNECTED connection of each provider looks like (the way it is usually connected). */
const CONNECTED: Record<Exclude<HostingProviderId, "aws" | "github">, Pick<HostingConnectionDTO, "method" | "account" | "external_id" | "config" | "hint_last4" | "manage_url">> = {
  vercel: { method: "install", account: { id: "team_a1B2c3D4e5F6g7H8", label: "Acme" }, external_id: "icfg_9Xy8Wv7Ut6Sr5Qp4", config: { team_id: "team_a1B2c3D4e5F6g7H8", team_slug: "acme" }, hint_last4: "", manage_url: "https://vercel.com/acme/~/integrations" },
  netlify: { method: "oauth", account: { id: "5f1a2b3c4d5e6f7a8b9c0d1e", label: "Acme" }, external_id: null, config: {}, hint_last4: "", manage_url: "https://app.netlify.com/user/applications" },
  render: { method: "token", account: null, external_id: null, config: {}, hint_last4: "b2e4", manage_url: "https://dashboard.render.com/u/settings#api-keys" },
  fly: { method: "token", account: null, external_id: null, config: { org_slug: "acme" }, hint_last4: "Q2xk", manage_url: null },
  cloudflare: { method: "token", account: null, external_id: null, config: { account_id: "0123456789abcdef0123456789abcdef" }, hint_last4: "9f3a", manage_url: "https://dash.cloudflare.com/profile/api-tokens" },
  railway: { method: "token", account: null, external_id: null, config: {}, hint_last4: "c71e", manage_url: null },
};

/** The GitHub signs `src/hosting/detect.ts` reads — check runs only, from the hosts that post them. */
const DETECTABLE: Partial<Record<HostingProviderId, string>> = {
  cloudflare: "GitHub check runs posted by the Cloudflare Workers app",
  vercel: "GitHub check runs posted by the Vercel app",
  netlify: "GitHub check runs posted by the Netlify app",
};

const AT = "2026-10-07T12:40:11.000Z";
const CHECKED = "2026-10-07T12:35:00.000Z";
const REPO = "acme/web";
const label = (id: HostingProviderId): string => HOSTING_SAMPLE_PROVIDERS.find((p) => p.id === id)?.label ?? id;

/** Railway's old per-environment PROJECT tokens, as 0057 left them in an org that had them (the "Leftover tokens" flow). */
const LEFTOVERS: HostingLeftoverDTO[] = [
  { provider: "railway", scope: "staging", scope_label: "Staging", label: LEFTOVER_TOKEN_LABEL, hint_last4: "5024", created_by: "andres", created_at: "2026-09-02T10:12:00.000Z" },
  { provider: "railway", scope: "production", scope_label: "Production", label: LEFTOVER_TOKEN_LABEL, hint_last4: "51b1", created_by: "andres", created_at: "2026-09-02T10:14:00.000Z" },
];

export function hostingScenario(flow: HostingSampleKey, stack: HostingStackKey): HostingSetupDTO {
  const envKeys: EnvKey[] = flow === "start" ? [] : ["staging", "production"];
  const withParts = !["start", "looking", "found"].includes(flow);
  const envParts = envKeys.map((e) => ({ env: e, parts: STACKS[stack](e) }));
  const used = [...new Set(envParts.flatMap((e) => e.parts.map((p) => p.provider)))].sort((a, b) => HOSTING_PROVIDERS.indexOf(a) - HOSTING_PROVIDERS.indexOf(b));
  const stackProviders = [...new Set((["staging", "production"] as EnvKey[]).flatMap((e) => STACKS[stack](e).map((p) => p.provider)))]
    .sort((a, b) => HOSTING_PROVIDERS.indexOf(a) - HOSTING_PROVIDERS.indexOf(b));
  const first = used[0];

  // Each provider's STORED connection status in this flow (what the server's `connectionStatusOf` would say).
  const statusOf = (id: HostingProviderId): ConnectionStatus => {
    if (!withParts || flow === "parts" || flow === "locked") return "not_connected";
    if (flow === "connecting") return id === first ? "connected" : "not_connected";
    if (flow === "broken" && id === first) return id === "vercel" || id === "netlify" ? "revoked" : "error";
    // Leftover tokens: Railway was never connected once for the org — only its old per-environment tokens remain.
    if (flow === "leftovers" && id === "railway") return "not_connected";
    return "connected";
  };
  const polled = (id: HostingProviderId): boolean => (flow === "live" || flow === "broken" || flow === "leftovers") && statusOf(id) === "connected";

  const ENV_LABEL: Record<EnvKey, string> = { staging: "Staging", production: "Production" };
  const usedBy = (id: HostingProviderId) => withParts ? envParts.flatMap((e) => e.parts.filter((p) => p.provider === id).map((p) => ({ env: e.env, part: p.key }))) : [];
  const connections: HostingConnectionDTO[] = (withParts ? used : []).map((id) => {
    const status = statusOf(id);
    const live = status === "connected" || status === "error";
    const c = CONNECTED[id as Exclude<HostingProviderId, "aws" | "github">];
    return {
      provider: id, scope: "", scope_label: null, status,
      method: live ? c.method : null, account: live || status === "revoked" ? c.account : null, external_id: live || status === "revoked" ? c.external_id : null,
      config: live || status === "revoked" ? { ...c.config } : {}, hint_last4: live ? c.hint_last4 : "",
      connected_by: live || status === "revoked" ? "andres" : null, connected_at: live || status === "revoked" ? "2026-10-06T16:05:00.000Z" : null,
      last_used_at: polled(id) || status === "error" ? AT : null,
      last_error: status === "error" ? `${id} deployments 401: Unauthorized — the credential is not valid` : null,
      legacy_fallback: false, revoked_reason: status === "revoked" ? `Removed on ${label(id)}` : null,
      manage_url: live || status === "revoked" ? c.manage_url : null, used_by: usedBy(id),
    };
  });
  // What every surface says about a provider — THE status function, as the server's part DTOs and checklist use it.
  const statusFor = (id: HostingProviderId) => hostingStatus(connections.find((c) => c.provider === id) ?? null, label(id));

  const environments: HostingEnvironmentDTO[] = envKeys.map((e) => ({
    key: e, label: ENV_LABEL[e], branch: e === "staging" ? "main" : "production",
    parts: withParts ? STACKS[stack](e).map((p, i): EnvironmentPartDTO => {
      const prov = HOSTING_SAMPLE_PROVIDERS.find((x) => x.id === p.provider)!;
      const unread = metricsForRole(p.role).filter((m) => !prov.capabilities.metrics.includes(m));
      return {
        env: e, key: p.key, label: p.label, role: p.role, provider: p.provider, settings: clean(p.settings), position: i,
        connection: statusFor(p.provider).state, console_url: null,
        last_poll: polled(p.provider) ? {
          at: AT, status: "ok", detail: null, last_ok_at: AT, covered: { from: "2026-10-07T09:00:00.000Z", to: "2026-10-07T12:00:00.000Z" },
          unavailable: unread.map((m) => ({ metric: m, reason: `${prov.label} does not report it through its API` })),
        } : null,
        updated_at: "2026-10-06T16:20:00.000Z", updated_by: "andres",
      };
    }) : [],
    // The app metrics token: production's is set once the org is live; staging's never is in the sample.
    app_metrics: {
      configured: e === "production" && (flow === "live" || flow === "broken" || flow === "leftovers"), legacy_fallback: false,
      hint_last4: e === "production" && (flow === "live" || flow === "broken" || flow === "leftovers") ? "7f3c" : "",
      last_used_at: e === "production" && (flow === "live" || flow === "broken" || flow === "leftovers") ? AT : null, last_error: null,
      api_url: e === "staging" ? "https://api.staging.acme.dev" : "https://api.acme.dev",
    },
  }));

  const detected: HostingDetectionDTO[] = flow === "start" || flow === "looking" ? [] : stackProviders
    .filter((id) => DETECTABLE[id])
    .map((id) => ({ provider: id, evidence: DETECTABLE[id]!, last_seen: CHECKED, in_use: withParts }));
  const detection: HostingDetectionStatusDTO = flow === "start" ? { state: "no_repo", repo: null, checked_at: null }
    : flow === "looking" ? { state: "looking", repo: REPO, checked_at: null }
    : { state: detected.length ? "found" : "none", repo: REPO, checked_at: CHECKED };

  // The checklist, as src/hosting/setup.ts `buildChecklist` words it — each connect step done exactly when THE status
  // function says the provider is live, and a failing one asking to be fixed.
  const checklist: HostingChecklistItem[] = [
    { id: "environments", title: "Add an environment", detail: envKeys.length ? null : "An environment is a branch that deploys somewhere — staging, production.", done: envKeys.length > 0, action: envKeys.length ? { kind: "none" } : { kind: "add_environment" } },
    ...environments.map((e): HostingChecklistItem => ({
      id: `parts:${e.key}`, title: `Add the parts ${e.label} runs`, detail: e.parts.length ? null : "The web app, API or worker this environment deploys.",
      done: e.parts.length > 0, action: e.parts.length ? { kind: "none" } : { kind: "add_part", env: e.key },
    })),
    ...connections.flatMap((c): HostingChecklistItem[] => {
      const users = c.used_by.map((u) => `${environments.find((e) => e.key === u.env)!.label} › ${environments.find((e) => e.key === u.env)!.parts.find((p) => p.key === u.part)!.label}`).join(", ");
      const st = statusFor(c.provider);
      const items: HostingChecklistItem[] = [{
        id: `connect:${c.provider}`, title: st.state === "revoked" ? `Reconnect ${label(c.provider)}` : `Connect ${label(c.provider)}`,
        detail: st.live ? null : st.state === "revoked" ? `${c.revoked_reason}. Used by ${users}.` : `${users} read nothing until ${label(c.provider)} is connected.`,
        done: st.live, action: st.live ? { kind: "none" } : { kind: "connect", provider: c.provider, scope: "" },
      }];
      if (st.state === "error") items.push({ id: `test:${c.provider}`, title: `Fix the ${label(c.provider)} connection`, detail: `The last poll was refused: ${c.last_error}.`, done: false, action: { kind: "test", provider: c.provider, scope: "" } });
      return items;
    }),
  ];

  return {
    providers: HOSTING_SAMPLE_PROVIDERS, environments, connections, checklist, detected, detection, secrets_available: flow !== "locked",
    leftovers: flow === "leftovers" ? LEFTOVERS.map((l) => ({ ...l })) : [],
  };
}

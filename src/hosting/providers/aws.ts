// AWS — LATER (#102). Described so the picker can show it (status `later`: it cannot be chosen yet), with the
// shape the first cut will take, so the UI and the contract do not move when it lands:
//
//   connection   a cross-account IAM ROLE the org creates and lets Trov assume (sts:AssumeRole with an
//                EXTERNAL ID Trov generates per org) — never long-lived access keys. Trov's own AWS identity
//                (a Worker secret pair, `AWS_TROV_ACCESS_KEY_ID` / `AWS_TROV_SECRET_ACCESS_KEY`) is the only
//                principal that calls STS; the org's role grants read-only CloudWatch on named resources.
//   requests     SigV4 signing in the Worker (Web Crypto HMAC-SHA256) for sts.amazonaws.com and
//                monitoring.<region>.amazonaws.com — not built yet.
//   first cut    CloudWatch `GetMetricData` for ONE named resource per part: an ALB or API Gateway (requests,
//                5xx, latency) for a web part; an ECS service or a Lambda function (CPU / memory, or
//                invocations / errors / duration) for a service part. Deploy status from GitHub deployments.
//
// `probe` / `poll` refuse with fixed words until then; the registry lists the provider `later`, so no part
// can be saved on it (src/hosting/parts.ts) and no poll is ever scheduled.
import type { HostingProvider } from "../types";
import { HostingError } from "../http";

const LATER = "AWS is not supported yet";

export const aws: HostingProvider = {
  id: "aws",
  label: "AWS",
  status: "later",
  summary: "ECS, Lambda, App Runner, an ALB or API Gateway: CloudWatch metrics for one named resource through a read-only role you let Trov assume. Coming later.",
  roles: ["web", "service"],
  apiHosts: ["sts.amazonaws.com"],
  docsUrl: "https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_create_for-user_externalid.html",
  credentialScope: "org",
  connectionMethods: [
    {
      method: "assume_role",
      label: "Grant Trov a read-only role",
      howTo: "In IAM create a role for \"Another AWS account\" (Trov's account id, shown here), require the external id shown here, and attach a policy that allows only cloudwatch:GetMetricData (and cloudwatch:ListMetrics) — optionally limited by resource. Paste the role's ARN and pick its region. No access key is ever pasted into Trov.",
      grants: ["cloudwatch:GetMetricData", "cloudwatch:ListMetrics"],
      requires: ["AWS_TROV_ACCESS_KEY_ID", "AWS_TROV_SECRET_ACCESS_KEY"],
    },
  ],
  orgConfigFields: [
    { key: "role_arn", label: "Role ARN", description: "The role Trov assumes: arn:aws:iam::<account>:role/<name>.", required: true, placeholder: "arn:aws:iam::123456789012:role/trov-readonly", pattern: /^arn:aws:iam::\d{12}:role\/[\w+=,.@\/-]{1,512}$/ },
    { key: "region", label: "Region", description: "The region the resources live in, e.g. us-east-1.", required: true, placeholder: "us-east-1", pattern: /^[a-z]{2}(-gov)?-[a-z]+-\d$/ },
  ],
  partSettings: [
    { key: "resource_type", label: "Resource type", description: "alb, apigateway, ecs or lambda.", required: true, placeholder: "ecs", pattern: /^(alb|apigateway|ecs|lambda)$/ },
    { key: "resource", label: "Resource", description: "ALB: app/<name>/<id>. API Gateway: the API name. ECS: <cluster>/<service>. Lambda: the function name.", required: true, placeholder: "prod-cluster/api" },
  ],
  capabilities: { deploys: false, metrics: ["requests", "errors", "latency_p95_ms", "cpu", "mem_mb"] },
  planNote: "CloudWatch GetMetricData is billed by AWS per metric requested (a few cents a month per part at an hourly poll).",
  pollCost: 3,
  consoleUrl(_part, config) {
    return config.region ? `https://${encodeURIComponent(config.region)}.console.aws.amazon.com/cloudwatch/home?region=${encodeURIComponent(config.region)}` : null;
  },
  async probe() { throw new HostingError(LATER); },
  async poll() { throw new HostingError(LATER); },
};

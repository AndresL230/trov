// Cloudflare — a LEGACY provider (#97: "Cloudflare and Railway become the first two providers behind the
// interface, with no change for SaplingLearn"). Its part is the environment's own `worker` / `worker_check`
// columns (key `frontend`); its credential is the `cloudflare_analytics` integration (token + account id);
// it is polled by the `:00` usage job (`pollCloudflare`, src/repo/poll.ts) and tested by the Integrations
// probe (src/integrations/probe.ts) — so `probe` / `poll` here are never reached and say so. What this
// object adds is the DESCRIPTION: the picker, the part settings, the console link.
import type { HostingProvider } from "../types";
import { HostingError } from "../http";

const NOT_HERE = "Cloudflare is polled by the hourly usage job and tested from its integration";

export const cloudflare: HostingProvider = {
  id: "cloudflare",
  label: "Cloudflare Workers",
  status: "available",
  summary: "A Worker (or Workers Builds) frontend: requests and error rate from Cloudflare's GraphQL Analytics API; deploys from the Workers Builds check run on GitHub.",
  roles: ["web"],
  apiHosts: ["api.cloudflare.com"],
  docsUrl: "https://developers.cloudflare.com/analytics/graphql-api/",
  credentialScope: "org",
  connectionMethods: [
    {
      method: "token",
      label: "Paste an API token",
      howTo: "In the Cloudflare dashboard open My Profile › API Tokens › Create Token › Create Custom Token and grant ONE permission: Account › Account Analytics › Read, limited to the account your frontend Workers live under. Paste the token here and set Account ID to that account's 32-character id (Workers & Pages › Overview). The token is only ever sent to api.cloudflare.com.",
      grants: ["Account Analytics: Read on one account"],
    },
  ],
  orgConfigFields: [
    { key: "account_id", label: "Account ID", description: "The 32-character id of the Cloudflare account the frontend Workers live under. Not a secret.", required: true, placeholder: "0123456789abcdef0123456789abcdef", pattern: /^[0-9a-fA-F]{32}$/ },
  ],
  partSettings: [
    { key: "worker", label: "Worker name", description: "The Worker script's name, as Workers & Pages lists it.", required: true, placeholder: "frontend-staging", pattern: /^[A-Za-z0-9_-]{1,63}$/ },
    { key: "worker_check", label: "Workers Builds check", description: "The check run Workers Builds posts on GitHub for this Worker (its deploy record), e.g. \"Workers Builds: frontend-staging\".", required: false, placeholder: "Workers Builds: frontend-staging" },
  ],
  capabilities: { deploys: true, metrics: ["requests", "errors"] },
  planNote: null,
  pollCost: 1,
  consoleUrl(part, config) {
    const account = config.account_id, worker = part.settings.worker;
    return account && worker ? `https://dash.cloudflare.com/${encodeURIComponent(account)}/workers/services/view/${encodeURIComponent(worker)}/production` : null;
  },
  async probe() { throw new HostingError(NOT_HERE); },
  async poll() { throw new HostingError(NOT_HERE); },
};

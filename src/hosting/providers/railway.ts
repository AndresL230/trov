// Railway — a LEGACY provider (see ./cloudflare.ts). Its part is the environment's own `railway_env` /
// `railway_environment_id` / `railway_service_id` columns (key `backend`); its credential is the
// per-environment `railway` project token; it is polled by the `:00` usage job (`pollRailway`) and its
// deploys arrive as GitHub `deployment_status` deliveries. `probe` / `poll` here are never reached.
import type { HostingProvider } from "../types";
import { HostingError } from "../http";

const NOT_HERE = "Railway is polled by the hourly usage job and tested from its integration";
const RAILWAY_ID = /^[A-Za-z0-9-]{1,100}$/;

export const railway: HostingProvider = {
  id: "railway",
  label: "Railway",
  status: "available",
  summary: "A Railway service: CPU and memory from Railway's GraphQL API; deploys from the GitHub deployment statuses Railway posts.",
  roles: ["service"],
  apiHosts: ["backboard.railway.com"],
  docsUrl: "https://docs.railway.com/reference/public-api",
  credentialScope: "environment",
  connectionMethods: [
    {
      method: "token",
      label: "Paste a project token",
      howTo: "In Railway open the project › Settings › Tokens and create a PROJECT token for this environment. A project token is bound to one environment of one project, so every environment needs its own; an account or team token will not work (it is sent as Project-Access-Token, not as a bearer). Railway has no read-only scope: this token can also change that environment, and one environment of one project is the narrowest Railway offers. The token is only ever sent to backboard.railway.com.",
      grants: ["Full access to ONE environment of one project (Railway has no read-only token)"],
    },
  ],
  orgConfigFields: [],
  partSettings: [
    { key: "railway_env", label: "GitHub deployment environment", description: "The environment name Railway's GitHub deployments carry, e.g. \"my-app / staging\" — how a deployment_status delivery is matched to this environment.", required: true, placeholder: "my-app / staging" },
    { key: "railway_environment_id", label: "Railway environment ID", description: "Project › Settings › Environments, the environment's id. Needed for CPU and memory.", required: false, pattern: RAILWAY_ID },
    { key: "railway_service_id", label: "Railway service ID", description: "The service's id (its Settings tab). The same in every environment.", required: false, pattern: RAILWAY_ID },
  ],
  capabilities: { deploys: true, metrics: ["cpu", "mem_mb"] },
  planNote: null,
  pollCost: 1,
  consoleUrl() { return null; }, // Railway's URLs need the project id, which Trov does not hold
  async probe() { throw new HostingError(NOT_HERE); },
  async poll() { throw new HostingError(NOT_HERE); },
};

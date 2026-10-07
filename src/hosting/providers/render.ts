// PLACEHOLDER — replaced by the provider's implementation (see src/hosting/types.ts for the contract).
import type { HostingProvider } from "../types";
import { HostingError } from "../http";

export const render: HostingProvider = {
  id: "render",
  label: "Render",
  status: "available",
  summary: "",
  roles: ["web"],
  apiHosts: [],
  docsUrl: "",
  credentialScope: "org",
  connectionMethods: [],
  orgConfigFields: [],
  partSettings: [],
  capabilities: { deploys: true, metrics: [] },
  planNote: null,
  pollCost: 1,
  consoleUrl() { return null; },
  async probe() { throw new HostingError("not implemented"); },
  async poll() { throw new HostingError("not implemented"); },
};

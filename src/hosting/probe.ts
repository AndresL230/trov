// Test connection for a hosting provider's credential (src/integrations/probe.ts `testConnection` calls this
// for the five hosting kinds; it scrubs, cuts and records the outcome). The provider's own `probe`, through
// its fixed-host fetch, against the FIRST part that uses the provider — so "Test connection passes" means
// the credential can see what the dashboard will read — or against the credential alone when no part uses
// it yet. One or two requests; writes nothing.
import type { IntegrationKind } from "@shared/integrations";
import { providerOfKind } from "@shared/hosting";
import { getIntegrationConfig, type Secret } from "../data/secrets";
import type { TenantContext } from "../data/sql";
import type { Env } from "../env";
import { asHostingError, hostFetch } from "./http";
import { listAllParts, partRef } from "./parts";
import { providerOf } from "./registry";
import type { ProbeResult } from "./types";

export async function probeHostingKind(
  ctx: TenantContext, _env: Env, kind: IntegrationKind, secret: Secret, now: number, fetchImpl: typeof fetch, partKey?: { env: string; part: string },
): Promise<ProbeResult> {
  const id = providerOfKind(kind);
  if (!id) return { ok: false, detail: "not a hosting provider" };
  const p = providerOf(id);
  if (p.status !== "available") return { ok: false, detail: `${p.label} is not supported yet` };
  const config = await getIntegrationConfig(ctx, kind, "");
  const parts = (await listAllParts(ctx)).filter((x) => x.provider === id);
  const part = partKey ? parts.find((x) => x.env === partKey.env && x.key === partKey.part) ?? null : parts[0] ?? null;
  try {
    return await p.probe({ fetch: hostFetch(p.apiHosts, fetchImpl), credential: { secret, config }, now }, part ? partRef(ctx.orgId, part) : null);
  } catch (e) {
    return { ok: false, detail: asHostingError(p.label.toLowerCase(), e).message };
  }
}

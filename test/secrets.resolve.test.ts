// canopy-multitenancy.md §8.7.6 — `resolveCredential`: the org's stored secret, or null. Since the Phase 7
// cleanup no Worker secret answers for any org, SaplingLearn included.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import {
  Secret, SecretAccessError, SecretsUnavailableError,
  resolveCloudflareAccountId, resolveCredential, resolveIntegrationConfig, setIntegrationConfig, setSecret,
} from "../src/data/secrets";
import { HOOK_A, seedOrgSettings } from "./helpers/integrations";
import { ORG_A, ORG_B, systemCtx, tenantCtx } from "./helpers/tenant";

const e = env as unknown as Env;
// The Worker secrets SaplingLearn's credentials once fell back to — set here to show they answer nothing.
const OLD_VARS = {
  ...e,
  GITHUB_SERVICE_TOKEN: "legacy-github-service-token",
  CF_ANALYTICS_TOKEN: "legacy-cloudflare-token",
  CF_ANALYTICS_ACCOUNT_ID: "legacy-account-id",
  SAPLING_METRICS_TOKEN: "legacy-metrics-token",
  GITHUB_WEBHOOK_SECRET: "legacy-webhook-secret",
} as unknown as Env;
const STORED = "stored-" + "0123456789abcdef".repeat(3);
const reveal = async (p: Promise<Secret | null>) => (await p)?.reveal() ?? null;
const SLOTS = [["github_token", ""], ["cloudflare_analytics", ""], ["railway", ""], ["metrics_endpoint", "staging"], ["github_webhook", HOOK_A]] as const;

describe("resolveCredential", () => {
  it("is null for every kind while nothing is stored — the old Worker secrets answer for no org", async () => {
    await seedOrgSettings();
    for (const ctx of [systemCtx(ORG_A, "system", OLD_VARS), systemCtx(ORG_B, "system", OLD_VARS)]) {
      for (const [kind, scope] of SLOTS) expect(await resolveCredential(ctx, kind, scope)).toBeNull();
      expect(await resolveCloudflareAccountId(ctx)).toBeNull();
      expect(await resolveIntegrationConfig(ctx, "cloudflare_analytics", "")).toEqual({});
    }
  });

  it("answers with the org's stored secret and config, kind and scope by kind and scope", async () => {
    await seedOrgSettings();
    const owner = await tenantCtx("AndresL230");
    await setSecret(owner, "github_token", "", STORED);
    await setSecret(owner, "cloudflare_analytics", "", STORED + "-cf");
    await setSecret(owner, "railway", "", STORED + "-rw");
    await setIntegrationConfig(owner, "cloudflare_analytics", "", { account_id: "0123456789abcdef0123456789abcdef" });
    const ctx = systemCtx(ORG_A);
    expect(await resolveCredential(ctx, "github_token", "")).toBeInstanceOf(Secret);
    expect(await reveal(resolveCredential(ctx, "github_token", ""))).toBe(STORED);
    expect(await reveal(resolveCredential(ctx, "cloudflare_analytics", ""))).toBe(STORED + "-cf");
    expect(await reveal(resolveCredential(ctx, "railway", ""))).toBe(STORED + "-rw");
    expect(await reveal(resolveCredential(ctx, "metrics_endpoint", "staging"))).toBeNull();
    expect(await reveal(resolveCredential(ctx, "github_token", "staging"))).toBeNull(); // another scope is another slot
    expect(await resolveCloudflareAccountId(ctx)).toBe("0123456789abcdef0123456789abcdef");
    expect(await resolveIntegrationConfig(ctx, "cloudflare_analytics", "")).toEqual({ account_id: "0123456789abcdef0123456789abcdef" });
    expect(await resolveIntegrationConfig(ctx, "vercel", "")).toEqual({});
    expect(await reveal(resolveCredential(owner, "github_token", ""))).toBe(STORED); // an owner session too
    // Another org sees none of it.
    expect(await resolveCredential(systemCtx(ORG_B), "github_token", "")).toBeNull();
  });

  it("refuses a bearer or member context before it looks anywhere", async () => {
    await seedOrgSettings();
    for (const ctx of [await tenantCtx("meilin", "admin", { via: "bearer" }), await tenantCtx("sanaok", "member")]) {
      await expect(resolveCredential(ctx, "github_token", "")).rejects.toBeInstanceOf(SecretAccessError);
      await expect(resolveCredential(ctx, "github_webhook", HOOK_A)).rejects.toBeInstanceOf(SecretAccessError);
    }
  });

  it("without TROV_KEK: nothing stored reads as null; a stored row fails closed", async () => {
    await seedOrgSettings();
    const noKek = { ...e, TROV_KEK: "" } as Env;
    const ctx = systemCtx(ORG_A, "system", noKek); // the KEK is read off the context's own Env
    expect(await resolveCredential(ctx, "github_token", "")).toBeNull();
    await setSecret(await tenantCtx("AndresL230"), "github_token", "", STORED);
    await expect(resolveCredential(ctx, "github_token", "")).rejects.toBeInstanceOf(SecretsUnavailableError);
  });
});

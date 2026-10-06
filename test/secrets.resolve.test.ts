// canopy-multitenancy.md §8.7.6 — `resolveCredential`, the cut-over bridge: the org's stored secret if
// there is one; otherwise, ONLY for org_saplinglearn, the matching legacy Worker secret; otherwise null.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import {
  Secret, SecretAccessError, SecretsUnavailableError,
  resolveCloudflareAccountId, resolveCredential, setIntegrationConfig, setSecret,
} from "../src/data/secrets";
import { HOOK_A, seedOrgSettings } from "./helpers/integrations";
import { ORG_A, ORG_B, systemCtx, tenantCtx } from "./helpers/tenant";

const e = env as unknown as Env;
const LEGACY = {
  ...e,
  GITHUB_SERVICE_TOKEN: "legacy-github-service-token",
  CF_ANALYTICS_TOKEN: "legacy-cloudflare-token",
  CF_ANALYTICS_ACCOUNT_ID: "legacy-account-id",
  RAILWAY_TOKEN_STAGING: "legacy-railway-staging",
  RAILWAY_TOKEN_PRODUCTION: "legacy-railway-production",
  RAILWAY_TOKEN_PRE_PROD: "legacy-railway-pre-prod",
  SAPLING_METRICS_TOKEN: "legacy-metrics-token",
  GITHUB_WEBHOOK_SECRET: "legacy-webhook-secret",
} as Env;
const STORED = "stored-" + "0123456789abcdef".repeat(3);
const reveal = async (p: Promise<Secret | null>) => (await p)?.reveal() ?? null;

describe("resolveCredential", () => {
  it("falls back to the matching legacy Worker secret for SaplingLearn, per kind and scope", async () => {
    await seedOrgSettings();
    const ctx = systemCtx(ORG_A);
    expect(await reveal(resolveCredential(ctx, LEGACY, "github_token", ""))).toBe("legacy-github-service-token");
    expect(await reveal(resolveCredential(ctx, LEGACY, "cloudflare_analytics", ""))).toBe("legacy-cloudflare-token");
    expect(await reveal(resolveCredential(ctx, LEGACY, "railway", "staging"))).toBe("legacy-railway-staging");
    expect(await reveal(resolveCredential(ctx, LEGACY, "railway", "production"))).toBe("legacy-railway-production");
    expect(await reveal(resolveCredential(ctx, LEGACY, "railway", "pre-prod"))).toBe("legacy-railway-pre-prod"); // RAILWAY_TOKEN_<KEY>, non-alphanumerics → _
    expect(await reveal(resolveCredential(ctx, LEGACY, "railway", "preview"))).toBeNull();
    expect(await reveal(resolveCredential(ctx, LEGACY, "metrics_endpoint", "staging"))).toBe("legacy-metrics-token");
    expect(await reveal(resolveCredential(ctx, LEGACY, "metrics_endpoint", "production"))).toBe("legacy-metrics-token"); // ONE token for every environment
    expect(await reveal(resolveCredential(ctx, LEGACY, "github_webhook", HOOK_A))).toBe("legacy-webhook-secret");
    expect(await resolveCredential(ctx, LEGACY, "github_token", "")).toBeInstanceOf(Secret);
    expect(await resolveCloudflareAccountId(ctx, LEGACY)).toBe("legacy-account-id");
    // A scope the kind does not take is never answered.
    expect(await reveal(resolveCredential(ctx, LEGACY, "github_token", "staging"))).toBeNull();
    expect(await reveal(resolveCredential(ctx, LEGACY, "railway", ""))).toBeNull();
    expect(await reveal(resolveCredential(ctx, LEGACY, "metrics_endpoint", ""))).toBeNull();
  });

  it("the legacy webhook secret answers only for the repo the old /webhook/github routes to", async () => {
    await seedOrgSettings();
    await env.DB.prepare(`INSERT INTO org_repos (id, org_id, repo_full_name, is_primary, legacy_hook, created_at, created_by) VALUES ('hook_second', ?, 'SaplingLearn/docs', 0, 0, 'now', 'x')`).bind(ORG_A).run();
    const ctx = systemCtx(ORG_A, "github-webhook");
    expect(await reveal(resolveCredential(ctx, LEGACY, "github_webhook", HOOK_A))).toBe("legacy-webhook-secret");
    expect(await reveal(resolveCredential(ctx, LEGACY, "github_webhook", "hook_second"))).toBeNull();
    expect(await reveal(resolveCredential(ctx, LEGACY, "github_webhook", "hook_unknown"))).toBeNull();
    expect(await reveal(resolveCredential(ctx, LEGACY, "github_webhook", ""))).toBeNull();
  });

  it("a stored secret wins over the Worker secret, kind and scope by kind and scope", async () => {
    await seedOrgSettings();
    const owner = await tenantCtx("AndresL230");
    await setSecret(owner, "github_token", "", STORED);
    await setSecret(owner, "railway", "staging", STORED + "-rw");
    await setIntegrationConfig(owner, "cloudflare_analytics", "", { account_id: "0123456789abcdef0123456789abcdef" });
    const ctx = systemCtx(ORG_A);
    expect(await reveal(resolveCredential(ctx, LEGACY, "github_token", ""))).toBe(STORED);
    expect(await reveal(resolveCredential(ctx, LEGACY, "railway", "staging"))).toBe(STORED + "-rw");
    expect(await reveal(resolveCredential(ctx, LEGACY, "railway", "production"))).toBe("legacy-railway-production");
    expect(await resolveCloudflareAccountId(ctx, LEGACY)).toBe("0123456789abcdef0123456789abcdef");
    expect(await reveal(resolveCredential(owner, LEGACY, "github_token", ""))).toBe(STORED); // an owner session too
  });

  it("no other org ever sees a Worker secret — even with a legacy-flagged repo row of its own", async () => {
    await seedOrgSettings(ORG_B, "hook_of_org_b"); // legacy_hook = 1, in the wrong org
    const ctx = systemCtx(ORG_B);
    for (const [kind, scope] of [["github_token", ""], ["cloudflare_analytics", ""], ["railway", "staging"], ["metrics_endpoint", "staging"], ["github_webhook", "hook_of_org_b"], ["github_webhook", HOOK_A]] as const) {
      expect(await resolveCredential(ctx, LEGACY, kind, scope)).toBeNull();
    }
    expect(await resolveCloudflareAccountId(ctx, LEGACY)).toBeNull();
    // Its own stored secret is what it gets.
    await setSecret(await tenantCtx("bob-b", "owner", { orgId: ORG_B }), "github_token", "", STORED);
    expect(await reveal(resolveCredential(ctx, LEGACY, "github_token", ""))).toBe(STORED);
    expect(await reveal(resolveCredential(systemCtx(ORG_A), LEGACY, "github_token", ""))).toBe("legacy-github-service-token");
  });

  it("is null when neither exists — an unset or blank Worker secret is not a credential", async () => {
    await seedOrgSettings();
    const ctx = systemCtx(ORG_A);
    const blank = { ...e, GITHUB_WEBHOOK_SECRET: "" } as Env; // the suite's pool blanks the rest
    for (const [kind, scope] of [["github_token", ""], ["cloudflare_analytics", ""], ["railway", "staging"], ["metrics_endpoint", "staging"], ["github_webhook", HOOK_A]] as const) {
      expect(await resolveCredential(ctx, blank, kind, scope)).toBeNull();
    }
    expect(await resolveCloudflareAccountId(ctx, blank)).toBeNull();
  });

  it("refuses a bearer or member context before it looks anywhere, the fallback included", async () => {
    await seedOrgSettings();
    for (const ctx of [await tenantCtx("meilin", "admin", { via: "bearer" }), await tenantCtx("sanaok", "member")]) {
      await expect(resolveCredential(ctx, LEGACY, "github_token", "")).rejects.toBeInstanceOf(SecretAccessError);
      await expect(resolveCredential(ctx, LEGACY, "github_webhook", HOOK_A)).rejects.toBeInstanceOf(SecretAccessError);
    }
  });

  it("keeps working without TROV_KEK while nothing is stored; a stored row then fails closed, never falls back", async () => {
    await seedOrgSettings();
    const noKek = { ...LEGACY, TROV_KEK: "" } as Env;
    const ctx = systemCtx(ORG_A, "system", noKek); // the KEK is read off the context's own Env
    expect(await reveal(resolveCredential(ctx, noKek, "github_token", ""))).toBe("legacy-github-service-token");
    await setSecret(await tenantCtx("AndresL230"), "github_token", "", STORED);
    await expect(resolveCredential(ctx, noKek, "github_token", "")).rejects.toBeInstanceOf(SecretsUnavailableError);
    expect(await reveal(resolveCredential(ctx, noKek, "railway", "staging"))).toBe("legacy-railway-staging"); // other kinds are unaffected
  });
});

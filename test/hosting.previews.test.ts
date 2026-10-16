/**
 * Previews (repo setups, Phase A): a production part's previews are `target = 'preview'` rows of that part, with
 * their branch (matched to open PRs at read time — Phase B). Until the facts read uses them, the dashboard's
 * deploy read leaves a production part's previews out of its strips; a part that reads ONLY previews (a staging
 * environment = the previews of main) keeps them as its deploys.
 */
import { describe, it, expect } from "vitest";
import { ORG_A, systemCtx } from "./helpers/tenant";
import { upsertDeploys, type CleanDeploy } from "../src/hosting/deploy-store";
import { hostingReads } from "../src/repo/store";
import { all } from "./helpers/db";
import { env } from "cloudflare:test";

const d = (id: string, target: CleanDeploy["target"], branch: string, createdAt: string): CleanDeploy => ({
  id, state: "ready", target, sha: null, branch, message: null, by: null, createdAt, readyAt: null, url: null, inspectUrl: null, reason: null,
});

describe("previews", () => {
  it("are stored with their branch, and left out of a production part's deploy strip — not out of a previews-only part's", async () => {
    const now = Date.parse("2026-10-15T12:00:00Z");
    await upsertDeploys(systemCtx(ORG_A), { env: "production", key: "web", provider: "vercel" }, [
      d("prod-1", "production", "main", "2026-10-15T10:00:00.000Z"),
      d("pv-1", "preview", "feat/checkout", "2026-10-15T11:00:00.000Z"),
    ], now);
    await upsertDeploys(systemCtx(ORG_A), { env: "staging", key: "web", provider: "vercel" }, [
      d("st-1", "preview", "main", "2026-10-15T09:00:00.000Z"),
    ], now);
    expect(await all(env.DB, `SELECT deploy_id, target, branch FROM hosting_deploys WHERE org_id = ? ORDER BY deploy_id`, ORG_A)).toEqual([
      { deploy_id: "prod-1", target: "production", branch: "main" },
      { deploy_id: "pv-1", target: "preview", branch: "feat/checkout" },
      { deploy_id: "st-1", target: "preview", branch: "main" },
    ]);
    const reads = await hostingReads(systemCtx(ORG_A), "2026-10-01T00:00:00.000Z", 10);
    expect(reads.deploys.map((x) => [x.env, x.id])).toEqual([["production", "prod-1"], ["staging", "st-1"]]);
  });

  it("a deploy with NO target (a GitHub-sourced one) is a deploy, never left out as a preview", async () => {
    const now = Date.parse("2026-10-15T12:00:00Z");
    await upsertDeploys(systemCtx(ORG_A), { env: "production", key: "jobs", provider: "github" }, [
      d("gh-run:1:1", null, "production", "2026-10-15T10:00:00.000Z"),
      d("gh-run:2:1", null, "production", "2026-10-15T11:00:00.000Z"),
    ], now);
    const reads = await hostingReads(systemCtx(ORG_A), "2026-10-01T00:00:00.000Z", 10);
    expect(reads.deploys.map((x) => x.id)).toEqual(["gh-run:2:1", "gh-run:1:1"]);
  });
});

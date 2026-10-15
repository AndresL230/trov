/**
 * The commit join (src/hosting/sha-join.ts) and the poll's writers after it (src/hosting/poll.ts). What matters:
 *   - THE ONE-CANDIDATE RULE: a deploy with no sha gets one only when exactly ONE distinct sha among the GitHub
 *     signals on the environment's branch finished in the 10 minutes before it — none or several leave it NULL;
 *   - a later provider sha replaces a joined one (`sha_source` follows);
 *   - after a poll: a failure reason is scrubbed and cut, the join runs, and a new production sha costs ONE
 *     GitHub compare through the org's GitHub credential (rollback), counted in the unit's cost.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { all, first } from "./helpers/db";
import { addOrgRepo, setOrgEnvironments } from "./helpers/org-config";
import { ORG_A, systemCtx, tenantCtx } from "./helpers/tenant";
import { ENVS, LONG_TOKEN } from "./helpers/repo";
import { ingestRepoEvent } from "../src/consumer";
import { setSecret } from "../src/data/secrets";
import { upsertDeploys, type CleanDeploy } from "../src/hosting/deploy-store";
import { JOIN_WINDOW_MS, joinCandidate, joinShas } from "../src/hosting/sha-join";
import { listAllParts } from "../src/hosting/parts";
import { pollPart, validatePoll, type ProviderMap } from "../src/hosting/poll";
import type { HostingProvider, PollResult } from "../src/hosting/types";
import type { RepoEvent } from "../src/repo/types";

const e = env as unknown as Env;
const SHA1 = "1".repeat(40), SHA2 = "2".repeat(40), SHA3 = "3".repeat(40);
const DEPLOY_AT = "2026-10-15T10:00:00.000Z";
const before = (min: number) => new Date(Date.parse(DEPLOY_AT) - min * 60_000).toISOString().replace(".000Z", "Z");
const ref = { env: "staging", key: "web", provider: "cloudflare", branch: "main" };

let seq = 0;
async function signal(o: Partial<RepoEvent> & { kind: RepoEvent["kind"]; sha: string; occurred_at: string; raw?: string }): Promise<void> {
  seq += 1;
  await ingestRepoEvent(systemCtx(ORG_A), { semantic_key: `sig:${seq}`, number: seq, provenance: "webhook", ref: "main", state: "success", raw: "{}", ...o });
}
const nullShaDeploy = (id = "cf-1", createdAt = DEPLOY_AT, o: Partial<CleanDeploy> = {}): CleanDeploy => ({
  id, state: "ready", target: "production", sha: null, branch: null, message: null, by: null, createdAt, readyAt: null, url: null, inspectUrl: null, reason: null, ...o,
});
const row = (id = "cf-1") => first<{ sha: string | null; sha_source: string | null }>(env.DB,
  `SELECT sha, sha_source FROM hosting_deploys WHERE org_id = ? AND deploy_id = ?`, ORG_A, id);
const NOW = Date.parse("2026-10-15T10:30:00Z");

describe("THE ONE-CANDIDATE RULE", () => {
  it("joinCandidate: exactly one distinct sha, else null", () => {
    expect(joinCandidate([SHA1])).toBe(SHA1);
    expect(joinCandidate([SHA1, SHA1.toUpperCase(), SHA1])).toBe(SHA1);
    expect(joinCandidate([])).toBeNull();
    expect(joinCandidate([SHA1, SHA2])).toBeNull();
    expect(joinCandidate([null, "not-a-sha"])).toBeNull();
  });

  it("one sha finished in the window on the branch (several checks of it count once) → joined", async () => {
    await upsertDeploys(systemCtx(ORG_A), ref, [nullShaDeploy()], NOW);
    await signal({ kind: "check", sha: SHA1, occurred_at: before(4), name: "Workers Builds: web" });
    await signal({ kind: "check", sha: SHA1, occurred_at: before(6), name: "test" });
    await signal({ kind: "run", sha: SHA1, occurred_at: before(2) });
    expect(await joinShas(systemCtx(ORG_A), ref, NOW)).toEqual(["cf-1"]);
    expect(await row()).toEqual({ sha: SHA1, sha_source: "joined" });
  });

  it("two shas in the window → NULL; none in the window → NULL", async () => {
    await upsertDeploys(systemCtx(ORG_A), ref, [nullShaDeploy("two"), nullShaDeploy("none", "2026-10-15T08:00:00.000Z")], NOW);
    await signal({ kind: "check", sha: SHA1, occurred_at: before(3) });
    await signal({ kind: "deploy", sha: SHA2, occurred_at: before(5), raw: JSON.stringify({ signal: "status", branches: ["main"] }) });
    expect(await joinShas(systemCtx(ORG_A), ref, NOW)).toEqual([]);
    expect(await row("two")).toEqual({ sha: null, sha_source: null });
    expect(await row("none")).toEqual({ sha: null, sha_source: null });
  });

  it("only signals on the environment's branch, finished (not pending), BEFORE the deploy and within 10 minutes count", async () => {
    await upsertDeploys(systemCtx(ORG_A), ref, [nullShaDeploy()], NOW);
    await signal({ kind: "check", sha: SHA2, occurred_at: before(3), ref: "feat/x" });                       // another branch
    await signal({ kind: "check", sha: SHA2, occurred_at: before(3), state: "pending" });                     // not finished
    await signal({ kind: "check", sha: SHA2, occurred_at: before(-1) });                                      // after the deploy
    await signal({ kind: "check", sha: SHA2, occurred_at: before(JOIN_WINDOW_MS / 60_000 + 1) });             // too early
    await signal({ kind: "deploy", sha: SHA2, occurred_at: before(3), ref: SHA2, raw: JSON.stringify({ signal: "deployment" }) }); // a sha ref says no branch
    await signal({ kind: "deploy", sha: SHA2, occurred_at: before(3), raw: JSON.stringify({ signal: "status", branches: ["feat/x"] }) });
    await signal({ kind: "deploy", sha: SHA3, occurred_at: before(5), raw: JSON.stringify({ signal: "status", branches: ["feat/x", "main"] }) }); // the one
    expect(await joinShas(systemCtx(ORG_A), ref, NOW)).toEqual(["cf-1"]);
    expect(await row()).toEqual({ sha: SHA3, sha_source: "joined" });
  });

  it("a preview, a deploy with a sha, and a github-source deploy are never joined; a provider sha later replaces a joined one", async () => {
    await upsertDeploys(systemCtx(ORG_A), ref, [nullShaDeploy("pv", DEPLOY_AT, { target: "preview" }), nullShaDeploy("cf-1")], NOW);
    await upsertDeploys(systemCtx(ORG_A), ref, [nullShaDeploy("gh", DEPLOY_AT)], NOW, "github");
    await signal({ kind: "check", sha: SHA1, occurred_at: before(3) });
    expect(await joinShas(systemCtx(ORG_A), ref, NOW)).toEqual(["cf-1"]);
    expect(await row("pv")).toEqual({ sha: null, sha_source: null });
    expect(await row("gh")).toEqual({ sha: null, sha_source: null });
    await upsertDeploys(systemCtx(ORG_A), ref, [nullShaDeploy("cf-1", DEPLOY_AT, { sha: SHA2 })], NOW);
    expect(await row()).toEqual({ sha: SHA2, sha_source: "provider" });
  });
});

describe("after a poll", () => {
  it("a failure reason is scrubbed BEFORE it is cut, one line, ≤ 140, and kept for a failed deploy only", () => {
    const secret = "s3cr3t-token-value-0123456789";
    const long = `Build failed: ${secret} ${"x".repeat(200)}\nsecond line`;
    const clean = validatePoll({ deploys: [
      { id: "a", state: "error", createdAt: DEPLOY_AT, reason: long },
      { id: "b", state: "ready", createdAt: DEPLOY_AT, reason: "not a failure" },
    ] }, { env: "staging", key: "web", role: "web" }, NOW, secret);
    const a = clean.deploys.find((d) => d.id === "a")!;
    expect(a.reason).not.toContain(secret);
    expect(a.reason!.length).toBeLessThanOrEqual(140);
    expect(a.reason).not.toContain("second line");
    expect(clean.deploys.find((d) => d.id === "b")!.reason).toBeNull();
  });

  /** A Cloudflare-like provider: deploys with no sha, a note about what it could not read. */
  const fake = (deploys: PollResult["deploys"]): HostingProvider => ({
    id: "cloudflare", label: "Cloudflare", status: "available", summary: "", roles: ["web"], apiHosts: ["api.cloudflare.test"], docsUrl: "",
    connectionMethods: [], orgConfigFields: [], partSettings: [], capabilities: { deploys: true, metrics: [] }, planNote: null, pollCost: 2,
    consoleUrl: () => null, probe: async () => ({ ok: true, detail: "" }),
    poll: async () => ({ deploys, points: [], unavailable: [], covered: null, notes: ["commit: the token needs Workers CI Read"] }),
  });

  async function setup() {
    await addOrgRepo("SaplingLearn/sapling", ORG_A);
    await setOrgEnvironments(ENVS, ORG_A);
    await env.DB.prepare(`INSERT INTO org_environment_parts (org_id, env_key, part_key, position, label, role, provider, settings, created_at, updated_at, updated_by)
      VALUES (?, 'staging', 'web', 0, 'Web', 'web', 'cloudflare', '{}', 'x', 'x', 'test')`).bind(ORG_A).run();
    const admin = await tenantCtx("AndresL230");
    await setSecret(admin, "cloudflare_analytics", "", LONG_TOKEN);
    await setSecret(admin, "github_token", "", "ghp_" + "a".repeat(36));
    return (await listAllParts(systemCtx(ORG_A)))[0];
  }

  it("joins the commit, notes what it could not read, and a new production sha costs ONE compare — behind → rolled back", async () => {
    const part = await setup();
    // An earlier deploy served SHA2; the provider now reports a new one with no sha, and SHA1's CI finished just before it.
    await upsertDeploys(systemCtx(ORG_A), part, [nullShaDeploy("cf-0", "2026-10-15T09:00:00.000Z", { sha: SHA2 })], NOW);
    await signal({ kind: "check", sha: SHA1, occurred_at: before(3) });
    const calls: string[] = [];
    const fetchImpl = (async (u: RequestInfo | URL) => { calls.push(String(u)); return Response.json({ status: "behind" }); }) as typeof fetch;
    const out = await pollPart(e, systemCtx(ORG_A), part, NOW, fetchImpl, { cloudflare: fake([{ ...nullShaDeploy("cf-1"), inspectUrl: null }]) } as ProviderMap);
    expect(out.status).toBe("ok");
    expect(await row("cf-1")).toEqual({ sha: SHA1, sha_source: "joined" });
    expect(calls).toEqual([`https://api.github.com/repos/SaplingLearn/sapling/compare/${SHA2}...${SHA1}?per_page=1`]);
    expect((await first<{ rolled_back_from: string | null }>(env.DB, `SELECT rolled_back_from FROM hosting_deploys WHERE org_id = ? AND deploy_id = 'cf-1'`, ORG_A))?.rolled_back_from).toBe(SHA2);
    const st = await first<{ detail: string }>(env.DB, `SELECT detail FROM hosting_poll_state WHERE org_id = ?`, ORG_A);
    expect(st?.detail).toContain("1 commit joined from GitHub");
    expect(st?.detail).toContain("commit: the token needs Workers CI Read");
    // A quiet re-poll (nothing new or changed) costs no compare.
    await pollPart(e, systemCtx(ORG_A), part, NOW + 60_000, fetchImpl, { cloudflare: fake([{ ...nullShaDeploy("cf-1"), inspectUrl: null }]) } as ProviderMap);
    expect(calls).toHaveLength(1);
    expect(await all(env.DB, `SELECT deploy_id FROM hosting_deploys WHERE org_id = ? AND rolled_back_from IS NOT NULL`, ORG_A)).toEqual([{ deploy_id: "cf-1" }]);
  });
});

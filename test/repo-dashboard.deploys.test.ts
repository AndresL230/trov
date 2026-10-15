/**
 * Environment cards and deploy strips — every PART of an environment, whoever hosts it.
 *
 * The Repo dashboard projects each environment's parts (`org_environment_parts`) and their deploys as the
 * hosting job stored them (`hosting_deploys`) into environment cards (each part's newest deploy), the
 * deploy dots per part, "CI on head" from the `check` capture, and the CI-failure list with its 7-day rate.
 * Still D1-only: nothing here fetches.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { deployDots } from "@shared/repo";
import type { ProviderDeployDTO } from "@shared/hosting";
import { systemCtx, ORG_A, ORG_B } from "./helpers/tenant";
import { run } from "./helpers/db";
import { setOrgEnvironments } from "./helpers/org-config";
import { addPart, deployRow, pollState } from "./helpers/dashboard-hosting";
import { ingestRepoEvent } from "../src/consumer";
import { getRepoDashboard } from "../src/tools/repo";
import { branchHeads, checkState } from "../src/repo/reads";
import { putSnapshot } from "../src/repo/store";
import type { RepoEvent } from "../src/repo/types";
import { ENVS } from "./helpers/repo";

const NOW = Date.parse("2026-09-20T12:00:00Z");
const at = (minsAgo: number) => new Date(NOW - minsAgo * 60_000).toISOString();
const put = async (rows: RepoEvent[]) => { for (const r of rows) await ingestRepoEvent(systemCtx(), r); };
const base = { raw: "{}", provenance: "webhook" as const };
const check = (id: number, name: string, state: string, sha: string, mins: number, over: Partial<RepoEvent> = {}): RepoEvent =>
  ({ ...base, semantic_key: `gh:check:${id}:${state === "pending" ? "created" : "completed"}`, kind: "check", number: id, name, state, sha, ref: "main", occurred_at: at(mins), ...over });
const ok = <T>(s: { status: string; data?: T }): T => { expect(s.status).toBe("ok"); return (s as { data: T }).data; };
const dash = () => getRepoDashboard(systemCtx(), "o/r", NOW, ENVS);

/** SaplingLearn's stack, as 0056 moved it into parts: a Cloudflare Workers frontend and a Railway backend per environment. */
async function stack(): Promise<void> {
  await setOrgEnvironments(ENVS, ORG_A);
  for (const e of ["staging", "production"]) {
    await addPart(ORG_A, e, "frontend", "cloudflare", "web", { worker: `frontend-${e}` }, 0, "Frontend");
    await addPart(ORG_A, e, "backend", "railway", "service", {}, 1, "Backend");
  }
}
/** A backend deploy of staging, created `mins` ago and (when settled) ready a minute later. */
const backend = (id: string, state: string, sha: string | null, mins: number, actor: string | null = "jose-a") =>
  deployRow(ORG_A, "staging", "backend", "railway", id, state, at(mins), { sha, actor, readyAt: state === "ready" || state === "error" ? at(mins - 1) : null });

describe("environment cards", () => {
  it("not_connected until an environment is configured AND something about it landed", async () => {
    expect((await dash()).environments.status).toBe("not_connected");
    await stack();
    expect((await dash()).environments.status).toBe("not_connected");   // parts alone: nothing captured yet
  });

  it("lists every part with its newest deploy, whoever hosts it, and summarises head checks", async () => {
    await stack();
    await addPart(ORG_A, "staging", "web", "vercel", "web", {}, 2, "Marketing site");
    await put([
      { ...base, semantic_key: "gh:push:abc:main", kind: "push", ref: "main", sha: "abcdef0123", actor_login: "AndresL230", count: 1, occurred_at: at(30) },
      check(11, "Backend (pytest)", "success", "abcdef0123", 24),
      check(12, "e2e", "failure", "abcdef0123", 20),
    ]);
    await backend("rw-1", "ready", "abcdef0123", 28);
    await deployRow(ORG_A, "staging", "frontend", "cloudflare", "cf-1", "ready", at(27), { sha: "abcdef0123", actor: null, readyAt: at(25) });
    await deployRow(ORG_A, "staging", "web", "vercel", "dpl-1", "building", at(5), { sha: "fedcba9876", actor: "meilin" });
    const [staging, production] = ok((await dash()).environments);
    expect(staging).toMatchObject({ key: "staging", name: "staging", note: "main", pill: "DEGRADED", tone: "warn", ci: "1 of 2 checks failing — e2e", ciTone: "bad", url: "https://staging.saplinglearn.com" });
    expect(staging.parts).toEqual([
      { part: "frontend", label: "Frontend", provider: "cloudflare", host: "Cloudflare Workers", sha: "abcdef0", deployedAt: at(25), deployedBy: null, result: "ok" },
      { part: "backend", label: "Backend", provider: "railway", host: "Railway", sha: "abcdef0", deployedAt: at(27), deployedBy: "jose-a", result: "ok" },
      // In flight: the card says so; it is not a dot yet (below).
      { part: "web", label: "Marketing site", provider: "vercel", host: "Vercel", sha: "fedcba9", deployedAt: at(5), deployedBy: "meilin", result: "running" },
    ]);
    // Production has no capture yet: the card exists, honestly empty — every part listed, nothing guessed.
    expect(production).toMatchObject({ pill: "UNKNOWN", tone: "neutral", ci: "No checks captured" });
    expect(production.parts.map((p) => [p.part, p.sha, p.deployedAt, p.result])).toEqual([["frontend", null, null, null], ["backend", null, null, null]]);
  });

  it("the deploy strips: settled deploys only, oldest first — ready landed, error failed, canceled abandoned", async () => {
    await stack();
    await backend("a", "ready", "aaaaaaa1", 300);
    await backend("b", "canceled", "bbbbbbb2", 190);
    await backend("c", "error", "ccccccc3", 100);
    await backend("d", "ready", "ddddddd4", 10, null);
    await backend("e", "building", "eeeeeee5", 2);
    const rows = ok((await dash()).deploys);
    // Only the parts that have a settled deploy get a row.
    expect(rows.map((r) => `${r.env}:${r.part}`)).toEqual(["staging:backend"]);
    expect(rows[0].label).toBe("staging · Backend");
    expect(rows[0].deploys).toEqual([
      { sha: "aaaaaaa", at: at(299), by: "jose-a", result: "ok" },
      { sha: "bbbbbbb", at: at(190), by: "jose-a", result: "cancel" },   // canceled has no ready_at: its creation
      { sha: "ccccccc", at: at(99), by: "jose-a", result: "fail" },
      { sha: "ddddddd", at: at(9), by: "unknown", result: "ok" },         // the provider named nobody
    ]);
  });

  it("a deploy still in flight is not a dot: the card says `running`, the section has nothing settled to draw", async () => {
    await stack();
    await backend("z", "building", "zzzzzzz9", 5);
    const d = await dash();
    const [staging] = ok(d.environments);
    expect(staging).toMatchObject({ pill: "UNKNOWN", tone: "neutral" });
    expect(staging.parts[1]).toMatchObject({ part: "backend", result: "running", deployedAt: at(5) });
    expect(d.deploys).toEqual({ status: "empty" });
  });

  it("a part polled successfully with no deploy in 90 days: `empty` (a poll looked and found none), and the card is connected", async () => {
    await stack();
    await pollState(ORG_A, "staging", "backend", "railway", NOW);
    const d = await dash();
    expect(d.deploys).toEqual({ status: "empty" });
    expect(d.environments.status).toBe("ok");
  });

  it("a poll that never succeeded, a check or a health ping is not deploy capture: deploys stay not_connected", async () => {
    await stack();
    await pollState(ORG_A, "staging", "backend", "railway", NOW, { status: "failed", detail: "railway 401" });
    await put([
      { ...base, semantic_key: "gh:push:abc:main", kind: "push", ref: "main", sha: "abc", actor_login: "AndresL230", count: 1, occurred_at: at(30) },
      check(11, "Backend (pytest)", "success", "abc", 18),
    ]);
    const d = await dash();
    expect(d.environments.status).toBe("ok");
    expect(d.deploys).toEqual({ status: "not_connected" });
  });

  it("a deploy older than 90 days, or one of a host the part no longer points at, is not on the card or the strip", async () => {
    await stack();
    await backend("old", "ready", "0ldold0", 91 * 24 * 60);
    await deployRow(ORG_A, "staging", "backend", "render", "former", "ready", at(60));
    await backend("new", "ready", "9e09e09", 60);
    const d = await dash();
    expect(ok(d.deploys)[0].deploys.map((x) => x.sha)).toEqual(["9e09e09"]);
    expect(ok(d.environments)[0].parts[1]).toMatchObject({ sha: "9e09e09" });
  });

  it("the deploy feed and the env card read the same history", async () => {
    await stack();
    await backend("x", "ready", "abcdef1234", 30);
    await deployRow(ORG_A, "staging", "frontend", "cloudflare", "y", "ready", at(20), { sha: null, readyAt: at(19) });
    const d = await dash();
    const [staging] = ok(d.environments);
    expect(staging.parts[1]).toMatchObject({ sha: "abcdef1", deployedBy: "jose-a" });
    const lines = ok(d.activity).filter((a) => a.kind === "deploy").map((a) => a.text);
    expect(lines).toEqual(["a deploy landed on staging · Frontend", "abcdef1 deployed to staging · Backend"]);
  });

  it("another org's parts and deploys never reach this org's cards", async () => {
    await stack();
    await setOrgEnvironments(ENVS, ORG_B);
    await addPart(ORG_B, "staging", "backend", "railway", "service");
    await deployRow(ORG_B, "staging", "backend", "railway", "theirs", "error", at(10), { sha: "b0b0b0b" });
    expect((await dash()).environments.status).toBe("not_connected");
    expect(JSON.stringify(await dash())).not.toContain("b0b0b0b");
  });
});

// M7: HEALTHY is a claim about CHECKS. A deploy that landed says the deploy
// landed; it says nothing about whether CI on that head is green.
describe("the environment pill", () => {
  it("a successful deploy with no checks captured is UNKNOWN, not HEALTHY — but the section IS connected", async () => {
    await stack();
    await backend("1", "ready", "abc", 20);
    const [staging] = ok((await dash()).environments);
    expect(staging).toMatchObject({ pill: "UNKNOWN", tone: "neutral", ci: "No checks captured" });
    expect(staging.parts[1].result).toBe("ok");
  });

  it("HEALTHY needs checks on the head, none failing and no failed part", async () => {
    await stack();
    await put([
      { ...base, semantic_key: "gh:push:abc:main", kind: "push", ref: "main", sha: "abc", actor_login: "AndresL230", count: 1, occurred_at: at(30) },
      check(11, "Backend (pytest)", "success", "abc", 18),
    ]);
    await backend("1", "ready", "abc", 20);
    const [staging] = ok((await dash()).environments);
    expect(staging).toMatchObject({ pill: "HEALTHY", tone: "good", ci: "All 1 checks passing" });
  });

  it("a failed part is FAILING even with no checks captured — a canceled one is not", async () => {
    await stack();
    await backend("1", "error", "abc", 20);
    expect(ok((await dash()).environments)[0]).toMatchObject({ pill: "FAILING", tone: "bad" });
    await backend("2", "canceled", "def", 10);
    expect(ok((await dash()).environments)[0]).toMatchObject({ pill: "UNKNOWN", tone: "neutral" });
  });

  it("checks alone, with no deploy at all, still connect the section", async () => {
    await put([
      { ...base, semantic_key: "gh:push:abc:main", kind: "push", ref: "main", sha: "abc", actor_login: "AndresL230", count: 1, occurred_at: at(30) },
      check(11, "Backend (pytest)", "success", "abc", 18),
    ]);
    expect((await dash()).environments.status).toBe("ok");
  });
});

describe("deployDots / checkState — the two pure folds", () => {
  const d = (state: ProviderDeployDTO["state"], sha: string | null, readyAt: string | null = null): ProviderDeployDTO =>
    ({ id: `${state}-${sha}`, state, target: null, sha, branch: null, message: null, by: null, at: "2026-09-20T10:00:00.000Z", ready_at: readyAt, url: null, inspect_url: null });

  it("a deploy dot: settled states only, oldest first, sha cut to 7 ('' when the provider has none)", () => {
    expect(deployDots([d("queued", "q"), d("building", "b"), d("ready", "readyreadyready", "2026-09-20T10:02:00.000Z"), d("error", null), d("canceled", "c")]))
      .toEqual([
        { sha: "c", at: "2026-09-20T10:00:00.000Z", by: "unknown", result: "cancel" },
        { sha: "", at: "2026-09-20T10:00:00.000Z", by: "unknown", result: "fail" },
        { sha: "readyre", at: "2026-09-20T10:02:00.000Z", by: "unknown", result: "ok" },
      ]);
  });

  it("neutral and skipped checks are a pass; error joins failure and timed_out as a fail", () => {
    expect(checkState([{ state: "neutral" }, { state: "success" }])).toBe("pass");
    expect(checkState([{ state: "skipped" }])).toBe("pass");
    expect(checkState([{ state: "cancelled" }])).toBe("pass");
    expect(checkState([{ state: "error" }])).toBe("fail");
    expect(checkState([{ state: "success" }, { state: "pending" }])).toBe("run");
    expect(checkState([])).toBeNull();
  });
});

// The env_heads snapshot (reconcileRepo's replacement for the synthetic head
// push rows) versus the captured pushes: the NEWER of the two wins.
describe("branchHeads — env_heads snapshot precedence", () => {
  const push = (sha: string, mins: number): RepoEvent =>
    ({ ...base, semantic_key: `gh:push:${sha}:main`, kind: "push", ref: "main", sha, count: 1, occurred_at: at(mins) });

  it("uses the captured push when no snapshot exists", async () => {
    await put([push("pushed1", 30)]);
    expect([...(await branchHeads(systemCtx(), ["main"]))]).toEqual([["main", "pushed1"]]);
  });

  it("uses the snapshot when it is newer than the branch's latest push", async () => {
    await put([push("pushed1", 60)]);
    await putSnapshot(systemCtx(), "env_heads", { main: "synced1" }, at(10));
    expect((await branchHeads(systemCtx(), ["main"])).get("main")).toBe("synced1");
  });

  it("keeps the push when the push landed after the last Sync", async () => {
    await put([push("pushed1", 10)]);
    await putSnapshot(systemCtx(), "env_heads", { main: "synced1" }, at(60));
    expect((await branchHeads(systemCtx(), ["main"])).get("main")).toBe("pushed1");
  });

  it("uses the snapshot for a branch with no captured push at all", async () => {
    await putSnapshot(systemCtx(), "env_heads", { production: "prodhead" }, at(60));
    expect((await branchHeads(systemCtx(), ["main", "production"])).get("production")).toBe("prodhead");
  });

  it("ignores a snapshot entry that is not a sha string", async () => {
    await putSnapshot(systemCtx(), "env_heads", { main: null, production: 7 }, at(10));
    expect([...(await branchHeads(systemCtx(), ["main", "production"]))]).toEqual([]);
  });

  // P1 (Task 13 parked finding): occurred_at is stored WITHOUT milliseconds
  // ("...T12:00:30Z") while a snapshot's computed_at comes from
  // `new Date().toISOString()` WITH them ("...T12:00:30.500Z"). Within the same
  // UTC second '.' < 'Z', so a STRING comparison says the snapshot lost even
  // though it is genuinely newer — production-shaped timestamps (unlike the
  // tests above, which format both sides identically) are what catch this.
  it("prefers a snapshot that is newer by milliseconds within the same UTC second, over a same-second push", async () => {
    await put([{ ...base, semantic_key: "gh:push:pushed1:main", kind: "push", ref: "main", sha: "pushed1", count: 1, occurred_at: "2026-09-20T12:00:30Z" }]);
    await putSnapshot(systemCtx(), "env_heads", { main: "synced1" }, "2026-09-20T12:00:30.500Z");
    expect((await branchHeads(systemCtx(), ["main"])).get("main")).toBe("synced1");
  });
});

describe("CI failures", () => {
  const ciRun = (id: number, state: string, mins: number, title: string | null = null): RepoEvent =>
    ({ ...base, semantic_key: `gh:run:${id}:1`, kind: "run", number: id, name: "e2e (browser lane)", ref: "main", sha: "abc", state, title, url: `https://github.com/o/r/actions/runs/${id}`, occurred_at: at(mins) });
  /** F3: a 7-day rate is only real once `run` capture had been RECORDING for the
   *  whole week — the same recording-window rule the PR/commit deltas use. */
  const backdateRecording = (iso: string) => run(env.DB, `UPDATE repo_events SET recorded_at = ? WHERE kind = 'run'`, iso);

  it("lists failed runs with their job, and a 7-day rate over decisive runs only", async () => {
    await put([ciRun(1, "success", 500), ciRun(2, "success", 400), ciRun(3, "failure", 60, "e2e · Run supabase/setup-cli@v1"), ciRun(4, "cancelled", 30), ciRun(5, "success", 20)]);
    await backdateRecording(new Date(NOW - 30 * 86_400_000).toISOString());
    const f = ok((await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS)).ciFailures);
    expect(f.rate).toBe(25);                     // 1 failure / 4 decisive (cancelled excluded)
    expect(f.trend).toHaveLength(7);
    expect(f.rows).toEqual([{ workflow: "e2e (browser lane)", branch: "main", job: "e2e · Run supabase/setup-cli@v1", at: at(60), url: "https://github.com/o/r/actions/runs/3" }]);
  });

  it("publishes no rate or trend until run capture predates the whole week — but still lists the failures", async () => {
    await put([ciRun(3, "failure", 60, "e2e · Run supabase/setup-cli@v1"), ciRun(5, "success", 20)]);
    // recorded_at is NOW (these rows just landed), so the week is not covered.
    const f = ok((await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS)).ciFailures);
    expect(f.rate).toBeNull();
    expect(f.trend).toEqual([]);
    expect(f.rows).toHaveLength(1);              // the failures themselves are facts
    expect(f.total).toBe(1);
  });

  it("`total` counts every failure in the week while `rows` stays capped at 5", async () => {
    // 7 failures + 1 timed out this week, 1 failure older than the week, 1 success.
    await put([
      ...Array.from({ length: 7 }, (_, i) => ciRun(10 + i, "failure", 30 + i * 60)),
      ciRun(20, "timed_out", 600), ciRun(21, "failure", 8 * 24 * 60), ciRun(22, "success", 5),
    ]);
    const f = ok((await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS)).ciFailures);
    expect(f.rows).toHaveLength(5);
    expect(f.total).toBe(8);
  });

  it("`total` is 0 in a week with no failures", async () => {
    await put([ciRun(22, "success", 5)]);
    const f = ok((await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS)).ciFailures);
    expect(f).toMatchObject({ rows: [], total: 0 });
  });

  it("is not_connected until a workflow run has ever been captured", async () => {
    expect((await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS)).ciFailures.status).toBe("not_connected");
  });
});

describe("reviews", () => {
  const review = (id: number, number: number, state: string, actor: string, mins: number): RepoEvent =>
    ({ ...base, semantic_key: `gh:review:${id}:submitted`, kind: "review", number, state, actor_login: actor, url: `https://github.com/o/r/pull/${number}#r${id}`, occurred_at: at(mins) });

  it("counts this week's reviews per person and puts them in the feed", async () => {
    await put([review(1, 7, "approved", "AndresL230", 30), review(2, 7, "commented", "meilin", 60)]);
    const d = await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS);
    expect(ok(d.contributors).map((c) => [c.person.login, c.reviews])).toEqual([["AndresL230", 1], ["meilin", 1]]);
    expect(ok(d.activity).map((a) => [a.kind, a.text])).toEqual([["review", "approved #7"], ["review", "commented on #7"]]);
  });
});

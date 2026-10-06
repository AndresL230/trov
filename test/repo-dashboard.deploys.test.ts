/**
 * Task 9 — two deployables per environment.
 *
 * The Repo dashboard projects the `deploy` / `check` / `run` / `review` capture
 * (Task 7) into environment cards with a Railway BACKEND half and a Cloudflare
 * FRONTEND half, deploy-history dots per half, "CI on head", and the CI-failure
 * list with its 7-day rate. Still D1-only: nothing here fetches.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { systemCtx } from "./helpers/tenant";
import { run } from "../src/db";
import { ingestRepoEvent } from "../src/consumer";
import { getRepoDashboard } from "../src/tools/repo";
import { branchHeads, checkState, deployHistories } from "../src/repo/reads";
import { putSnapshot } from "../src/repo/store";
import type { RepoEvent } from "../src/repo/types";
import { ENVS } from "./helpers/repo";

const NOW = Date.parse("2026-09-20T12:00:00Z");
const at = (minsAgo: number) => new Date(NOW - minsAgo * 60_000).toISOString();
const put = async (rows: RepoEvent[]) => { for (const r of rows) await ingestRepoEvent(systemCtx(), r); };
const base = { raw: "{}", provenance: "webhook" as const };
const deploy = (id: number, state: string, sha: string, mins: number, envKey = "staging"): RepoEvent =>
  ({ ...base, semantic_key: `gh:deploy:${id}:${state}`, kind: "deploy", number: id, env: envKey, part: "backend", sha, state, actor_login: "railway-app[bot]", occurred_at: at(mins) });
const check = (id: number, name: string, state: string, sha: string, mins: number, over: Partial<RepoEvent> = {}): RepoEvent =>
  ({ ...base, semantic_key: `gh:check:${id}:${state === "pending" ? "created" : "completed"}`, kind: "check", number: id, name, state, sha, ref: "main", occurred_at: at(mins), ...over });
const ok = <T>(s: { status: string; data?: T }): T => { expect(s.status).toBe("ok"); return (s as { data: T }).data; };

describe("environment cards", () => {
  it("not_connected until an environment is configured AND something deployed", async () => {
    expect((await getRepoDashboard(env.DB, "o/r", NOW, ENVS)).environments.status).toBe("not_connected");
  });

  it("shows both deployables, resolves the bot to the pusher, and summarises head checks", async () => {
    await put([
      { ...base, semantic_key: "gh:push:abc:main", kind: "push", ref: "main", sha: "abc", actor_login: "AndresL230", count: 1, occurred_at: at(30) },
      deploy(1, "in_progress", "abc", 28), deploy(1, "success", "abc", 26),
      check(10, "Workers Builds: frontend-staging", "success", "abc", 25, { env: "staging", part: "frontend" }),
      check(11, "Backend (pytest)", "success", "abc", 24),
      check(12, "e2e", "failure", "abc", 20),
    ]);
    const [staging, production] = ok((await getRepoDashboard(env.DB, "o/r", NOW, ENVS)).environments);
    expect(staging).toMatchObject({ key: "staging", name: "staging", note: "main", pill: "DEGRADED", tone: "warn", ci: "1 of 3 checks failing — e2e", ciTone: "bad", url: "https://staging.saplinglearn.com" });
    expect(staging.parts).toEqual([
      { part: "backend", host: "Railway", sha: "abc", deployedAt: at(26), deployedBy: "AndresL230", result: "ok" },
      { part: "frontend", host: "Cloudflare", sha: "abc", deployedAt: at(25), deployedBy: "AndresL230", result: "ok" },
    ]);
    // Production has no capture yet: the card exists, honestly empty.
    expect(production).toMatchObject({ pill: "UNKNOWN", tone: "neutral", ci: "No checks captured" });
    expect(production.parts.map((p) => p.sha)).toEqual([null, null]);
  });

  it("a superseded deploy (success → inactive) still counts as deployed; a never-succeeded one is cancelled", async () => {
    await put([deploy(1, "success", "a", 300), deploy(1, "inactive", "a", 200), deploy(2, "in_progress", "b", 190), deploy(2, "inactive", "b", 180), deploy(3, "failure", "c", 100), deploy(4, "success", "d", 10)]);
    const rows = ok((await getRepoDashboard(env.DB, "o/r", NOW, ENVS)).deploys);
    const backend = rows.find((r) => r.env === "staging" && r.part === "backend")!;
    expect(backend.label).toBe("staging · api");
    expect(backend.deploys.map((d) => [d.sha, d.result])).toEqual([["a", "ok"], ["b", "cancel"], ["c", "fail"], ["d", "ok"]]);
    // Nothing pushed those shas, so the deploy's own actor (the bot) is all there is.
    expect(backend.deploys[0].by).toBe("railway-app[bot]");
    // Only the environments that captured something get a row.
    expect(rows.map((r) => `${r.env}:${r.part}`)).toEqual(["staging:backend"]);
  });

  it("a deploy still in flight is not a dot, and leaves the card UNKNOWN", async () => {
    await put([deploy(9, "in_progress", "z", 5)]);
    const d = await getRepoDashboard(env.DB, "o/r", NOW, ENVS);
    expect(d.environments.status).toBe("not_connected");
    expect(d.deploys.status).toBe("not_connected");
  });

  it("the deploy feed and the env card read the same history", async () => {
    await put([
      { ...base, semantic_key: "gh:push:abc:main", kind: "push", ref: "main", sha: "abcdef1234", actor_login: "AndresL230", count: 1, occurred_at: at(40) },
      deploy(1, "success", "abcdef1234", 30),
    ]);
    const d = await getRepoDashboard(env.DB, "o/r", NOW, ENVS);
    const [staging] = ok(d.environments);
    expect(staging.parts[0]).toMatchObject({ sha: "abcdef1", deployedBy: "AndresL230" });
    expect(ok(d.activity).map((a) => [a.kind, a.text])).toContainEqual(["deploy", "abcdef1 deployed to staging · api"]);
  });
});

// M7: HEALTHY is a claim about CHECKS. A deploy that landed says the deploy
// landed; it says nothing about whether CI on that head is green.
describe("the environment pill", () => {
  it("a successful deploy with no checks captured is UNKNOWN, not HEALTHY — but the section IS connected", async () => {
    await put([deploy(1, "success", "abc", 20)]);
    const [staging] = ok((await getRepoDashboard(env.DB, "o/r", NOW, ENVS)).environments);
    expect(staging).toMatchObject({ pill: "UNKNOWN", tone: "neutral", ci: "No checks captured" });
    expect(staging.parts[0].result).toBe("ok");
  });

  it("HEALTHY needs checks on the head, none failing and no failed part", async () => {
    await put([
      { ...base, semantic_key: "gh:push:abc:main", kind: "push", ref: "main", sha: "abc", actor_login: "AndresL230", count: 1, occurred_at: at(30) },
      deploy(1, "success", "abc", 20), check(11, "Backend (pytest)", "success", "abc", 18),
    ]);
    const [staging] = ok((await getRepoDashboard(env.DB, "o/r", NOW, ENVS)).environments);
    expect(staging).toMatchObject({ pill: "HEALTHY", tone: "good", ci: "All 1 checks passing" });
  });

  it("a failed deploy is FAILING even with no checks captured", async () => {
    await put([deploy(1, "failure", "abc", 20)]);
    const [staging] = ok((await getRepoDashboard(env.DB, "o/r", NOW, ENVS)).environments);
    expect(staging).toMatchObject({ pill: "FAILING", tone: "bad" });
  });

  it("checks alone, with no deploy at all, still connect the section", async () => {
    await put([
      { ...base, semantic_key: "gh:push:abc:main", kind: "push", ref: "main", sha: "abc", actor_login: "AndresL230", count: 1, occurred_at: at(30) },
      check(11, "Backend (pytest)", "success", "abc", 18),
    ]);
    expect((await getRepoDashboard(env.DB, "o/r", NOW, ENVS)).environments.status).toBe("ok");
  });
});

// M6: ONE policy for a non-decisive conclusion, shared by the deploy dots and
// the checks icon (stated at foldResult / checkState in src/repo/reads.ts).
describe("non-decisive conclusions", () => {
  it("stale and action_required are a cancelled deploy; neutral and skipped are not a dot at all", async () => {
    await put([
      deploy(1, "stale", "a", 300), deploy(2, "action_required", "b", 200),
      deploy(3, "neutral", "c", 100), deploy(4, "skipped", "d", 50),
    ]);
    const strips = await deployHistories(env.DB, NOW);
    expect(strips.get("staging:backend")!.map((d) => [d.sha, d.result])).toEqual([["a", "cancel"], ["b", "cancel"]]);
  });

  // M14: `deploy` / `check`-as-deploy rows are never pruned, so the strip's
  // read needs its own bound — 90 days, like `recentPrRows`.
  it("ignores a deploy older than 90 days", async () => {
    await put([deploy(1, "success", "old", 91 * 24 * 60), deploy(2, "success", "new", 60)]);
    const strips = await deployHistories(env.DB, NOW);
    expect(strips.get("staging:backend")!.map((d) => d.sha)).toEqual(["new"]);
  });

  it("neutral and skipped checks are a pass; error joins failure and timed_out as a fail", () => {
    expect(checkState([{ state: "neutral" }, { state: "success" }])).toBe("pass");
    expect(checkState([{ state: "skipped" }])).toBe("pass");
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
    expect([...(await branchHeads(env.DB, ["main"]))]).toEqual([["main", "pushed1"]]);
  });

  it("uses the snapshot when it is newer than the branch's latest push", async () => {
    await put([push("pushed1", 60)]);
    await putSnapshot(env.DB, "env_heads", { main: "synced1" }, at(10));
    expect((await branchHeads(env.DB, ["main"])).get("main")).toBe("synced1");
  });

  it("keeps the push when the push landed after the last Sync", async () => {
    await put([push("pushed1", 10)]);
    await putSnapshot(env.DB, "env_heads", { main: "synced1" }, at(60));
    expect((await branchHeads(env.DB, ["main"])).get("main")).toBe("pushed1");
  });

  it("uses the snapshot for a branch with no captured push at all", async () => {
    await putSnapshot(env.DB, "env_heads", { production: "prodhead" }, at(60));
    expect((await branchHeads(env.DB, ["main", "production"])).get("production")).toBe("prodhead");
  });

  it("ignores a snapshot entry that is not a sha string", async () => {
    await putSnapshot(env.DB, "env_heads", { main: null, production: 7 }, at(10));
    expect([...(await branchHeads(env.DB, ["main", "production"]))]).toEqual([]);
  });

  // P1 (Task 13 parked finding): occurred_at is stored WITHOUT milliseconds
  // ("...T12:00:30Z") while a snapshot's computed_at comes from
  // `new Date().toISOString()` WITH them ("...T12:00:30.500Z"). Within the same
  // UTC second '.' < 'Z', so a STRING comparison says the snapshot lost even
  // though it is genuinely newer — production-shaped timestamps (unlike the
  // tests above, which format both sides identically) are what catch this.
  it("prefers a snapshot that is newer by milliseconds within the same UTC second, over a same-second push", async () => {
    await put([{ ...base, semantic_key: "gh:push:pushed1:main", kind: "push", ref: "main", sha: "pushed1", count: 1, occurred_at: "2026-09-20T12:00:30Z" }]);
    await putSnapshot(env.DB, "env_heads", { main: "synced1" }, "2026-09-20T12:00:30.500Z");
    expect((await branchHeads(env.DB, ["main"])).get("main")).toBe("synced1");
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
    const f = ok((await getRepoDashboard(env.DB, "o/r", NOW, ENVS)).ciFailures);
    expect(f.rate).toBe(25);                     // 1 failure / 4 decisive (cancelled excluded)
    expect(f.trend).toHaveLength(7);
    expect(f.rows).toEqual([{ workflow: "e2e (browser lane)", branch: "main", job: "e2e · Run supabase/setup-cli@v1", at: at(60), url: "https://github.com/o/r/actions/runs/3" }]);
  });

  it("publishes no rate or trend until run capture predates the whole week — but still lists the failures", async () => {
    await put([ciRun(3, "failure", 60, "e2e · Run supabase/setup-cli@v1"), ciRun(5, "success", 20)]);
    // recorded_at is NOW (these rows just landed), so the week is not covered.
    const f = ok((await getRepoDashboard(env.DB, "o/r", NOW, ENVS)).ciFailures);
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
    const f = ok((await getRepoDashboard(env.DB, "o/r", NOW, ENVS)).ciFailures);
    expect(f.rows).toHaveLength(5);
    expect(f.total).toBe(8);
  });

  it("`total` is 0 in a week with no failures", async () => {
    await put([ciRun(22, "success", 5)]);
    const f = ok((await getRepoDashboard(env.DB, "o/r", NOW, ENVS)).ciFailures);
    expect(f).toMatchObject({ rows: [], total: 0 });
  });

  it("is not_connected until a workflow run has ever been captured", async () => {
    expect((await getRepoDashboard(env.DB, "o/r", NOW, ENVS)).ciFailures.status).toBe("not_connected");
  });
});

describe("reviews", () => {
  const review = (id: number, number: number, state: string, actor: string, mins: number): RepoEvent =>
    ({ ...base, semantic_key: `gh:review:${id}:submitted`, kind: "review", number, state, actor_login: actor, url: `https://github.com/o/r/pull/${number}#r${id}`, occurred_at: at(mins) });

  it("counts this week's reviews per person and puts them in the feed", async () => {
    await put([review(1, 7, "approved", "AndresL230", 30), review(2, 7, "commented", "meilin", 60)]);
    const d = await getRepoDashboard(env.DB, "o/r", NOW, ENVS);
    expect(ok(d.contributors).map((c) => [c.person.login, c.reviews])).toEqual([["AndresL230", 1], ["meilin", 1]]);
    expect(ok(d.activity).map((a) => [a.kind, a.text])).toEqual([["review", "approved #7"], ["review", "commented on #7"]]);
  });
});

import { describe, it, expect } from "vitest";
import { repoEventsFromDelivery, metricsFromStatus } from "../src/repo/capture";
import { ENVS } from "./helpers/repo";
import push from "./fixtures/gh-push.json";
import prOpened from "./fixtures/gh-pr-opened.json";
import prMerged from "./fixtures/gh-pr-merged.json";
import deployStatus from "./fixtures/gh-deployment-status.json";
import checkRun from "./fixtures/gh-check-run.json";
import workflowRun from "./fixtures/gh-workflow-run.json";
import prReview from "./fixtures/gh-pr-review.json";


describe("repoEventsFromDelivery — push", () => {
  it("captures a branch push: distinct commit count, head subject, pusher", () => {
    const [ev, ...rest] = repoEventsFromDelivery("push", push);
    expect(rest).toEqual([]);
    expect(ev).toMatchObject({
      semantic_key: "gh:push:becdbac09eaf5d7c73b9f27019c0e43c4444dd7b:main", kind: "push", ref: "main",
      sha: "becdbac09eaf5d7c73b9f27019c0e43c4444dd7b", actor_login: "AndresL230", count: 2,
      title: "fix window math", provenance: "webhook",
      // repository.pushed_at (1789895090 unix seconds) converts to this instant —
      // NOT the head commit's own (earlier-authored) 09:04:41Z timestamp. A
      // rebase/cherry-pick would otherwise land the push in an old day bucket.
      occurred_at: "2026-09-20T09:04:50Z",
    });
    // raw keeps a slice, never the whole delivery
    expect(JSON.parse(ev.raw).commits).toHaveLength(3);
    expect(ev.raw).not.toContain("body");
  });

  it("falls back to the head commit timestamp when repository.pushed_at is absent or not a finite number", () => {
    const [noRepo] = repoEventsFromDelivery("push", { ...push, repository: undefined });
    expect(noRepo.occurred_at).toBe("2026-09-20T09:04:41Z");
    const [junkPushedAt] = repoEventsFromDelivery("push", { ...push, repository: { pushed_at: "not-a-number" } });
    expect(junkPushedAt.occurred_at).toBe("2026-09-20T09:04:41Z");
  });

  it("ignores tag pushes and branch deletions", () => {
    expect(repoEventsFromDelivery("push", { ...push, ref: "refs/tags/v1" })).toEqual([]);
    expect(repoEventsFromDelivery("push", { ...push, deleted: true })).toEqual([]);
  });
});

describe("repoEventsFromDelivery — pull_request", () => {
  it("maps open/draft/merged/closed onto one `state` column", () => {
    const state = (over: object, action = "opened") =>
      repoEventsFromDelivery("pull_request", { ...prOpened, action, pull_request: { ...prOpened.pull_request, ...over } })[0]?.state;
    expect(state({})).toBe("review");
    expect(state({ draft: true })).toBe("draft");
    expect(state({ state: "closed", merged: true }, "closed")).toBe("merged");
    expect(state({ state: "closed", merged: false }, "closed")).toBe("closed");
  });

  it("keys on action + updated_at so a redelivery collapses and a later edit does not", () => {
    const [ev] = repoEventsFromDelivery("pull_request", prOpened);
    expect(ev).toMatchObject({
      semantic_key: "gh:prs:482:opened:2026-09-20T09:10:00Z", kind: "pr", number: 482, ref: "feature/usage-rollup",
      sha: "c91d2aec91d2aec91d2aec91d2aec91d2aec91d2", actor_login: "lpcooper-arch", title: "Batch D1 reads in usage rollup",
    });
  });

  it("skips actions that change nothing the dashboard shows", () => {
    for (const action of ["labeled", "assigned", "review_requested", "locked"]) {
      expect(repoEventsFromDelivery("pull_request", { ...prOpened, action })).toEqual([]);
    }
  });

  it("returns [] for junk", () => {
    expect(repoEventsFromDelivery("pull_request", null)).toEqual([]);
    expect(repoEventsFromDelivery("ping", {})).toEqual([]);
  });

  it("falls back to merged_at / closed_at when a payload slice carries no updated_at", () => {
    const [ev] = repoEventsFromDelivery("pull_request", prMerged);
    expect(ev).toMatchObject({ kind: "pr", state: "merged" });
    expect(ev.occurred_at).toBe((prMerged as { pull_request: { merged_at: string } }).pull_request.merged_at);
  });
});

describe("repoEventsFromDelivery — GitHub deploy signals (untagged)", () => {
  it("captures a deployment status as an UNTAGGED deploy signal: creator, environment name, state, sha, ref, links", () => {
    const [ev] = repoEventsFromDelivery("deployment_status", deployStatus);
    expect(ev).toMatchObject({
      semantic_key: "gh:deploy:7001:success", kind: "deploy", number: 7001, state: "success", name: "Sapling / staging",
      sha: "becdbac09eaf5d7c73b9f27019c0e43c4444dd7b", ref: "becdbac09eaf5d7c73b9f27019c0e43c4444dd7b",
      actor_login: "railway-app[bot]", url: "https://railway.com/project/3f90b930/logs", occurred_at: "2026-09-20T09:05:34Z",
    });
    expect(ev.env ?? null).toBeNull();
    expect(ev.part ?? null).toBeNull();
    expect(JSON.parse(ev.raw)).toMatchObject({ signal: "deployment", environment: "Sapling / staging", environment_url: "https://railway.com/project/3f90b930", workflow: null, status_id: 9001 });
  });

  it("keeps the workflow file of a GitHub Actions deployment, and a deployment before any status as `created`", () => {
    const actions = { ...deployStatus, workflow: { path: ".github/workflows/deploy-jobs.yml" }, workflow_run: { id: 42 } };
    expect(JSON.parse(repoEventsFromDelivery("deployment_status", actions)[0].raw)).toMatchObject({ workflow: ".github/workflows/deploy-jobs.yml", run_id: 42 });
    const [created] = repoEventsFromDelivery("deployment", { action: "created", deployment: deployStatus.deployment });
    expect(created).toMatchObject({ semantic_key: "gh:deploy:7001:created", kind: "deploy", state: "created", name: "Sapling / staging", occurred_at: "2026-09-20T09:04:47Z" });
    expect(repoEventsFromDelivery("deployment", { action: "deleted", deployment: deployStatus.deployment })).toEqual([]);
  });

  it("captures a commit status other than canopy/* — its branches kept for the commit join; canopy/* stays a metric only", () => {
    const status = { id: 55, sha: "a".repeat(40), context: "Vercel", state: "success", description: "Deployment has completed", target_url: "https://web-x.vercel.app",
      branches: [{ name: "main" }, { name: "feat/x" }], created_at: "2026-09-20T09:07:00Z", updated_at: "2026-09-20T09:07:10Z", sender: { login: "vercel[bot]" } };
    const [ev] = repoEventsFromDelivery("status", status);
    expect(ev).toMatchObject({ semantic_key: "gh:status:55", kind: "deploy", name: "Vercel", state: "success", sha: "a".repeat(40), ref: null, actor_login: "vercel[bot]", occurred_at: "2026-09-20T09:07:10Z" });
    expect(JSON.parse(ev.raw)).toEqual({ signal: "status", context: "Vercel", description: "Deployment has completed", branches: ["main", "feat/x"] });
    expect(repoEventsFromDelivery("status", { ...status, context: "canopy/coverage" })).toEqual([]);
  });
});

describe("repoEventsFromDelivery — check_run", () => {
  it("captures every check run as it is — never tagged as an environment's deploy", () => {
    const [ev] = repoEventsFromDelivery("check_run", checkRun);
    expect(ev).toMatchObject({ semantic_key: "gh:check:5001:completed", kind: "check", number: 5001, ref: "main", name: "Workers Builds: frontend-staging", state: "success", occurred_at: "2026-09-20T09:06:32Z" });
    expect(ev.env ?? null).toBeNull();
    expect(ev.part ?? null).toBeNull();
    // The posting App's slug rides in `raw` (src/hosting/detect.ts reads it).
    expect(JSON.parse(ev.raw)).toHaveProperty("app");
  });

  it("the same check on another branch is captured the same way", () => {
    const preview = { ...checkRun, check_run: { ...checkRun.check_run, check_suite: { head_branch: "feat/x" } } };
    expect(repoEventsFromDelivery("check_run", preview)[0]).toMatchObject({ kind: "check", ref: "feat/x" });
  });

  it("created → pending; other actions are ignored", () => {
    const created = { action: "created", check_run: { ...checkRun.check_run, status: "queued", conclusion: null, completed_at: null } };
    expect(repoEventsFromDelivery("check_run", created)[0]).toMatchObject({ semantic_key: "gh:check:5001:created", state: "pending", occurred_at: "2026-09-20T09:05:00Z" });
    expect(repoEventsFromDelivery("check_run", { ...checkRun, action: "rerequested" })).toEqual([]);
  });
});

describe("repoEventsFromDelivery — workflow_run and pull_request_review", () => {
  it("captures only completed runs, keyed by run + attempt", () => {
    expect(repoEventsFromDelivery("workflow_run", workflowRun)[0]).toMatchObject({
      semantic_key: "gh:run:35501310333:1", kind: "run", number: 35501310333, name: "e2e (browser lane)", ref: "main", state: "failure", count: 1, actor_login: "AndresL230",
    });
    expect(repoEventsFromDelivery("workflow_run", { ...workflowRun, action: "requested" })).toEqual([]);
  });

  it("captures a submitted review", () => {
    expect(repoEventsFromDelivery("pull_request_review", prReview)[0]).toMatchObject({
      semantic_key: "gh:review:3001:submitted", kind: "review", number: 480, state: "approved", actor_login: "Darkest-Teddy",
    });
  });
});

describe("metricsFromStatus", () => {
  const status = (context: string, description: string, branch = "main") =>
    ({ sha: "abc", context, description, state: "success", updated_at: "2026-09-20T09:30:00Z", branches: [{ name: branch }] });

  it("reads the three trov contexts as numbers", () => {
    expect(metricsFromStatus(status("canopy/coverage", "78.4"), ENVS).metrics).toEqual([{ metric: "coverage", env: "", part: "", value: 78.4, at: "2026-09-20T09:30:00Z" }]);
    expect(metricsFromStatus(status("canopy/bundle-kb", "412"), ENVS).metrics[0]).toMatchObject({ metric: "bundle_kb", value: 412 });
    expect(metricsFromStatus(status("canopy/todo", "43"), ENVS).metrics[0]).toMatchObject({ metric: "todo_count", value: 43 });
  });

  it("ignores an unrelated context silently (no drop reason — it costs nothing)", () => {
    expect(metricsFromStatus(status("Sapling - sapling", "Success"), ENVS)).toEqual({ metrics: [], dropped: null });
  });

  it("drops a status on another branch, with a drop reason naming the context", () => {
    const out = metricsFromStatus(status("canopy/coverage", "61.0", "feat/x"), ENVS);
    expect(out.metrics).toEqual([]);
    expect(out.dropped).toMatchObject({ context: "canopy/coverage" });
  });

  it("returns [] for junk and for a status with no timestamp", () => {
    expect(metricsFromStatus(null, ENVS)).toEqual({ metrics: [], dropped: null });
    const noAt = metricsFromStatus({ context: "canopy/coverage", description: "78.4", branches: [{ name: "main" }] }, ENVS);
    expect(noAt.metrics).toEqual([]);
    expect(noAt.dropped).toMatchObject({ context: "canopy/coverage", reason: "no timestamp" });
  });

  // ENVS[0].branch is "main" here too, so this doesn't distinguish the fallback
  // from the configured value — a second case pins the fallback itself below.
  it("falls back to \"main\" when no environments are configured", () => {
    expect(metricsFromStatus(status("canopy/coverage", "61.0", "main"), []).metrics[0]).toMatchObject({ metric: "coverage", value: 61 });
    expect(metricsFromStatus(status("canopy/coverage", "61.0", "feat/x"), []).metrics).toEqual([]);
  });

  // C1 + I3: `Number(str(description))` accepted anything Number() accepts —
  // and `Number(null) === 0`, a finite number, so a `canopy/*` status with NO
  // description stored coverage = 0 forever (repo_metrics is append-only and
  // never pruned for these metrics). The description must be a strict decimal
  // (trimmed) in the metric's plausible range, or the point is dropped.
  describe("description validation (C1 + I3)", () => {
    it("drops an absent or null description", () => {
      expect(metricsFromStatus({ context: "canopy/coverage", state: "success", updated_at: "2026-09-20T09:30:00Z", branches: [{ name: "main" }] }, ENVS).metrics).toEqual([]);
      expect(metricsFromStatus({ context: "canopy/coverage", description: null, state: "success", updated_at: "2026-09-20T09:30:00Z", branches: [{ name: "main" }] }, ENVS).metrics).toEqual([]);
    });

    it("drops a blank, non-numeric, signed, exponent, hex, or unit-suffixed description", () => {
      for (const bad of ["", "  ", "n/a", "78.4%", "1e3", "0x10", "-5", "Infinity"]) {
        expect(metricsFromStatus(status("canopy/coverage", bad), ENVS).metrics, JSON.stringify(bad)).toEqual([]);
      }
    });

    it("accepts a value with surrounding whitespace, trimmed", () => {
      expect(metricsFromStatus(status("canopy/coverage", " 78.4 "), ENVS).metrics).toEqual([{ metric: "coverage", env: "", part: "", value: 78.4, at: "2026-09-20T09:30:00Z" }]);
    });

    it("range-checks coverage to 0–100", () => {
      expect(metricsFromStatus(status("canopy/coverage", "100"), ENVS).metrics[0]).toMatchObject({ value: 100 });
      expect(metricsFromStatus(status("canopy/coverage", "100.1"), ENVS).metrics).toEqual([]);
    });

    it("requires todo_count to be an integer", () => {
      expect(metricsFromStatus(status("canopy/todo", "43.5"), ENVS).metrics).toEqual([]);
      expect(metricsFromStatus(status("canopy/todo", "43"), ENVS).metrics[0]).toMatchObject({ value: 43 });
    });

    it("accepts a bundle size of 0", () => {
      expect(metricsFromStatus(status("canopy/bundle-kb", "0"), ENVS).metrics[0]).toMatchObject({ value: 0 });
    });

    it("names the dropped context and reason for an invalid description (M6)", () => {
      const out = metricsFromStatus(status("canopy/coverage", "n/a"), ENVS);
      expect(out.dropped).toMatchObject({ context: "canopy/coverage" });
      expect(out.dropped?.reason).toContain("n/a");
    });
  });
});

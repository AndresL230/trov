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
    const [ev, ...rest] = repoEventsFromDelivery("push", push, ENVS);
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
    const [noRepo] = repoEventsFromDelivery("push", { ...push, repository: undefined }, ENVS);
    expect(noRepo.occurred_at).toBe("2026-09-20T09:04:41Z");
    const [junkPushedAt] = repoEventsFromDelivery("push", { ...push, repository: { pushed_at: "not-a-number" } }, ENVS);
    expect(junkPushedAt.occurred_at).toBe("2026-09-20T09:04:41Z");
  });

  it("ignores tag pushes and branch deletions", () => {
    expect(repoEventsFromDelivery("push", { ...push, ref: "refs/tags/v1" }, ENVS)).toEqual([]);
    expect(repoEventsFromDelivery("push", { ...push, deleted: true }, ENVS)).toEqual([]);
  });
});

describe("repoEventsFromDelivery — pull_request", () => {
  it("maps open/draft/merged/closed onto one `state` column", () => {
    const state = (over: object, action = "opened") =>
      repoEventsFromDelivery("pull_request", { ...prOpened, action, pull_request: { ...prOpened.pull_request, ...over } }, ENVS)[0]?.state;
    expect(state({})).toBe("review");
    expect(state({ draft: true })).toBe("draft");
    expect(state({ state: "closed", merged: true }, "closed")).toBe("merged");
    expect(state({ state: "closed", merged: false }, "closed")).toBe("closed");
  });

  it("keys on action + updated_at so a redelivery collapses and a later edit does not", () => {
    const [ev] = repoEventsFromDelivery("pull_request", prOpened, ENVS);
    expect(ev).toMatchObject({
      semantic_key: "gh:prs:482:opened:2026-09-20T09:10:00Z", kind: "pr", number: 482, ref: "feature/usage-rollup",
      sha: "c91d2aec91d2aec91d2aec91d2aec91d2aec91d2", actor_login: "lpcooper-arch", title: "Batch D1 reads in usage rollup",
    });
  });

  it("skips actions that change nothing the dashboard shows", () => {
    for (const action of ["labeled", "assigned", "review_requested", "locked"]) {
      expect(repoEventsFromDelivery("pull_request", { ...prOpened, action }, ENVS)).toEqual([]);
    }
  });

  it("returns [] for junk", () => {
    expect(repoEventsFromDelivery("pull_request", null, ENVS)).toEqual([]);
    expect(repoEventsFromDelivery("ping", {}, ENVS)).toEqual([]);
  });

  it("falls back to merged_at / closed_at when a payload slice carries no updated_at", () => {
    const [ev] = repoEventsFromDelivery("pull_request", prMerged, ENVS);
    expect(ev).toMatchObject({ kind: "pr", state: "merged" });
    expect(ev.occurred_at).toBe((prMerged as { pull_request: { merged_at: string } }).pull_request.merged_at);
  });
});

describe("repoEventsFromDelivery — deployment_status (Railway backend)", () => {
  it("maps the GitHub environment onto the configured env key", () => {
    const [ev] = repoEventsFromDelivery("deployment_status", deployStatus, ENVS);
    expect(ev).toMatchObject({
      semantic_key: "gh:deploy:7001:success", kind: "deploy", number: 7001, env: "staging", part: "backend",
      sha: "becdbac09eaf5d7c73b9f27019c0e43c4444dd7b", state: "success", name: "Sapling / staging",
      actor_login: "railway-app[bot]", occurred_at: "2026-09-20T09:05:34Z",
    });
  });

  it("skips an environment nobody configured (a preview env is not staging)", () => {
    const other = { ...deployStatus, deployment: { ...deployStatus.deployment, environment: "Sapling / pr-482" } };
    expect(repoEventsFromDelivery("deployment_status", other, ENVS)).toEqual([]);
  });
});

describe("repoEventsFromDelivery — check_run", () => {
  it("a Workers Builds check ON THE ENV BRANCH is a frontend deploy", () => {
    const [ev] = repoEventsFromDelivery("check_run", checkRun, ENVS);
    expect(ev).toMatchObject({ semantic_key: "gh:check:5001:completed", kind: "check", number: 5001, ref: "main", name: "Workers Builds: frontend-staging", state: "success", env: "staging", part: "frontend", occurred_at: "2026-09-20T09:06:32Z" });
  });

  it("the same check on another branch is a preview build — a check, not a deploy", () => {
    const preview = { ...checkRun, check_run: { ...checkRun.check_run, check_suite: { head_branch: "feat/x" } } };
    expect(repoEventsFromDelivery("check_run", preview, ENVS)[0]).toMatchObject({ kind: "check", env: null, part: null });
  });

  it("created → pending; other actions are ignored", () => {
    const created = { action: "created", check_run: { ...checkRun.check_run, status: "queued", conclusion: null, completed_at: null } };
    expect(repoEventsFromDelivery("check_run", created, ENVS)[0]).toMatchObject({ semantic_key: "gh:check:5001:created", state: "pending", occurred_at: "2026-09-20T09:05:00Z" });
    expect(repoEventsFromDelivery("check_run", { ...checkRun, action: "rerequested" }, ENVS)).toEqual([]);
  });
});

describe("repoEventsFromDelivery — workflow_run and pull_request_review", () => {
  it("captures only completed runs, keyed by run + attempt", () => {
    expect(repoEventsFromDelivery("workflow_run", workflowRun, ENVS)[0]).toMatchObject({
      semantic_key: "gh:run:35501310333:1", kind: "run", number: 35501310333, name: "e2e (browser lane)", ref: "main", state: "failure", count: 1, actor_login: "AndresL230",
    });
    expect(repoEventsFromDelivery("workflow_run", { ...workflowRun, action: "requested" }, ENVS)).toEqual([]);
  });

  it("captures a submitted review", () => {
    expect(repoEventsFromDelivery("pull_request_review", prReview, ENVS)[0]).toMatchObject({
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

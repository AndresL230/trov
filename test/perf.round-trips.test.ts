// How many D1 round trips the hot reads cost, counted through a wrapped binding (test/helpers/d1-count.ts):
// `serial` is the chain a request waits on, `total` every statement. Pinned so a later change that puts a
// read back in series shows up here. docs/architecture/data-layer.md › Round trips.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { countingEnv } from "./helpers/d1-count";
import { systemCtx, platformCtx, ORG_A } from "./helpers/tenant";
import { run } from "./helpers/db";
import { ENVS } from "./helpers/repo";
import { setOrgEnvironments } from "./helpers/org-config";
import { addPart, deployRow, pollState } from "./helpers/dashboard-hosting";
import { ingestEvent, ingestRepoEvent } from "../src/consumer";
import { getRepoDashboard } from "../src/tools/repo";
import { putMetric, putSnapshot } from "../src/repo/store";
import { create_sprint, set_sprint_active } from "../src/tools/sprints";
import { SprintCreate } from "@shared/sprints";
import type { RepoEvent } from "../src/repo/types";
import type { CapturedEvent } from "@shared/contract";

const NOW = Date.parse("2026-10-01T12:00:00Z");
const ago = (days: number): string => new Date(NOW - days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");

const repoRow = (kind: RepoEvent["kind"], key: string, at: string, over: Partial<RepoEvent> = {}): RepoEvent => ({
  semantic_key: `gh:${kind}:${key}`, kind, raw: "{}", provenance: "webhook", occurred_at: at, actor_login: "jose-a", ...over,
});
const prEvent = (n: number, at: string): CapturedEvent => ({
  semantic_key: `gh:pr:${n}:merged`, event_type: "pr_merged", ref_number: n, subject_login: "jose-a",
  raw: JSON.stringify({ pr: { number: n, title: `PR ${n}`, html_url: `https://github.com/o/r/pull/${n}`, merged: true, user: { login: "jose-a" }, base: { ref: "main" } } }),
  provenance: "webhook", occurred_at: at,
});
const issueEvent = (n: number, at: string): CapturedEvent => ({
  semantic_key: `gh:issue:${n}:opened:${at}`, event_type: "issue", ref_number: n, subject_login: "jose-a",
  raw: JSON.stringify({ action: "opened", issue: { number: n, title: `Issue ${n}`, html_url: `https://github.com/o/r/issues/${n}`, state: "open", user: { login: "jose-a" }, labels: ["bug"], assignees: [] } }),
  provenance: "webhook", occurred_at: at,
});

/** Everything the dashboard can read, present at once: every conditional read is taken. */
async function seedBusyRepo(): Promise<void> {
  const ctx = systemCtx();
  await setOrgEnvironments(ENVS, ORG_A);
  for (const e of ENVS) {
    await addPart(ORG_A, e.key, "web", "vercel", "web");
    await pollState(ORG_A, e.key, "web", "vercel", NOW);
    await deployRow(ORG_A, e.key, "web", "vercel", `d-${e.key}`, "ready", ago(1), { readyAt: ago(1) });
  }
  const rows: RepoEvent[] = [
    ...[1, 2, 3, 4].map((n) => repoRow("pr", `${n}:review`, ago(2), { number: n, state: "review", ref: `feat/${n}`, sha: `sha${n}`, title: `PR ${n}` })),
    repoRow("review", "1:a", ago(1), { number: 1, state: "approved", actor_login: "bea" }),
    repoRow("push", "p1", ago(1), { ref: "main", sha: "headmain", count: 3 }),
    repoRow("push", "p2", ago(9), { ref: "production", sha: "headprod", count: 2 }),
    repoRow("check", "c1", ago(1), { sha: "headmain", name: "ci", state: "success" }),
    repoRow("check", "c2", ago(1), { sha: "sha1", name: "ci", state: "failure" }),
    ...[1, 2, 3, 4, 5, 6].map((n) => repoRow("run", `r${n}`, ago(1), { name: "ci", state: "failure", ref: "main", title: `job ${n}` })),
  ];
  for (const r of rows) await ingestRepoEvent(ctx, r);
  await run(env.DB, `UPDATE repo_events SET recorded_at = ?`, ago(30));
  for (const e of [prEvent(10, ago(1)), prEvent(11, ago(8)), issueEvent(20, ago(2)), issueEvent(21, ago(10))]) await ingestEvent(ctx, platformCtx(), e, "github-webhook");
  await putSnapshot(ctx, "prs_reconciled", { at: ago(0) }, ago(0));
  await putSnapshot(ctx, "branches", { active: 3, stale: 1, rows: [] });
  await putSnapshot(ctx, "drift", { ahead: 1, behind: 0, commits: [] });
  await putMetric(ctx, { metric: "coverage", env: "", part: "", value: 80, at: ago(1) });
  await putMetric(ctx, { metric: "health_up", env: "staging", part: "frontend", value: 1, at: new Date(NOW - 60_000).toISOString() });
  const sp = await create_sprint(ctx, SprintCreate.parse({ label: "Now" }), "jose-a");
  await set_sprint_active(ctx, sp.id, true);
}

const statuses = (d: object): Record<string, unknown> =>
  Object.fromEntries(Object.entries(d).filter(([, v]) => typeof v === "object" && v !== null).map(([k, v]) => [k, (v as { status: string }).status]));

describe("D1 round trips", () => {
  // Before the reads ran as a dataflow: 39 serial of 43 (busy), 28 of 32 (nothing captured). The SAME
  // statements run — only their order changed — and the answer is the same bytes (the repo-dashboard suites).
  it("the Repo dashboard, everything captured: 43 statements, a chain of 3", async () => {
    await seedBusyRepo();
    const c = countingEnv();
    const d = await getRepoDashboard(systemCtx(ORG_A, "system", c.env), "o/r", NOW, ENVS);
    // Every conditional read was taken (the seed is meant to reach them all).
    expect(statuses(d)).toMatchObject({
      prs: "ok", activity: "ok", ciFailures: "ok", environments: "ok", deploys: "ok", providers: "ok", health: "ok",
      sprint: "ok", coverage: "ok", branches: "ok", drift: "ok", contributors: "ok", bars: "ok",
    });
    expect(c.total).toBe(43);
    expect(c.serial).toBeLessThanOrEqual(3);
    // The same answer as through the plain binding.
    expect(JSON.stringify(d)).toBe(JSON.stringify(await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS)));
  });

  it("the Repo dashboard, nothing captured: 32 statements, a chain of 2", async () => {
    await setOrgEnvironments(ENVS, ORG_A);
    const c = countingEnv();
    await getRepoDashboard(systemCtx(ORG_A, "system", c.env), "o/r", NOW, ENVS);
    expect(c.total).toBe(32);
    expect(c.serial).toBeLessThanOrEqual(2);
  });
});

import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { platformCtx, systemCtx } from "./helpers/tenant";
import { app } from "../src/routes";
import { createSession } from "../src/auth/session";
import { hmacSeal } from "../src/auth/crypto";
import { ingestEvent, ingestRepoEvent } from "../src/consumer";
import { getRepoDashboard } from "../src/tools/repo";
import { putSnapshot, putMetric } from "../src/repo/store";
import { create_sprint, set_sprint_active } from "../src/tools/sprints";
import { seedPerson } from "./helpers/persons";
import { run } from "./helpers/db";
import type { CapturedEvent } from "@shared/contract";
import type { RepoDashboard } from "@shared/repo";
import type { RepoEvent } from "../src/repo/types";
import { SprintCreate } from "@shared/sprints";

const NOW = Date.parse("2026-09-20T12:00:00Z");
const ago = (days: number, hours = 0): string => new Date(NOW - days * 86_400_000 - hours * 3_600_000).toISOString();

async function cookieFor(login: string): Promise<string> {
  await seedPerson(login);
  const { id } = await createSession(platformCtx(), login);
  return `session=${await hmacSeal(id, "test-cookie-secret")}`;
}

function prEvent(number: number, login: string, at: string, merged = true): CapturedEvent {
  return {
    semantic_key: `gh:pr:${number}:${merged ? "merged" : "closed"}`,
    event_type: merged ? "pr_merged" : "pr_closed",
    ref_number: number,
    subject_login: login,
    raw: JSON.stringify({
      pr: {
        number, title: `PR ${number}`, body: "a long body that must never reach the DTO",
        html_url: `https://github.com/o/r/pull/${number}`, merged, merged_at: merged ? at : null, closed_at: at,
        user: { login }, milestone: null, base: { ref: "main" },
      },
    }),
    provenance: "webhook",
    occurred_at: at,
  };
}

function issueEvent(number: number, login: string, at: string, action: string, state: "open" | "closed", labels: string[] = []): CapturedEvent {
  return {
    semantic_key: `gh:issue:${number}:${action}:${at}`,
    event_type: "issue",
    ref_number: number,
    subject_login: login,
    raw: JSON.stringify({
      action,
      issue: {
        number, title: `Issue ${number}`, body: "body", html_url: `https://github.com/o/r/issues/${number}`,
        state, updated_at: at, user: { login }, assignees: [], labels, milestone: null,
      },
    }),
    provenance: "webhook",
    occurred_at: at,
  };
}

const ingestAll = async (events: CapturedEvent[]) => { for (const e of events) await ingestEvent(systemCtx(), platformCtx(), e, "github-webhook"); };
const data = <T>(s: { status: string; data?: T }): T => {
  expect(s.status).toBe("ok");
  return (s as { data: T }).data;
};

describe("getRepoDashboard — a D1-only projection", () => {
  it("an empty store is all `empty` / `not_connected`, never an error", async () => {
    const d = await getRepoDashboard(systemCtx(), "o/r", NOW);
    expect(d.repo).toBe("o/r");
    expect(d.degraded).toBe(false);
    expect(d.prs.status).toBe("empty");
    expect(d.activity.status).toBe("empty");
    expect(d.sprint.status).toBe("empty");
    expect(d.bars.status).toBe("empty");
    // The tiles are counts, so zero is still an answer.
    expect(data(d.stats).map((s) => s.value)).toEqual([0, 0, 0, 0]);
  });

  it("on a cold start every captured section is not_connected — never guessed", async () => {
    const d = await getRepoDashboard(systemCtx(), "o/r", NOW);
    for (const k of ["environments", "drift", "health", "branches", "deploys", "ciFailures", "coverage", "bundle", "usage", "cloudflare", "hosting", "todos"] as const) {
      expect(d[k].status, k).toBe("not_connected");
    }
  });

  it("counts merged PRs week over week and lists the latest closes", async () => {
    await seedPerson("jose-a");
    await ingestAll([
      prEvent(10, "jose-a", ago(1)), prEvent(11, "jose-a", ago(2)), prEvent(12, "meilin", ago(3)),
      prEvent(13, "meilin", ago(4), false),
      prEvent(5, "jose-a", ago(9)),
    ]);
    const d = await getRepoDashboard(systemCtx(), "o/r", NOW);
    const merged = data(d.stats)[0];
    expect(merged).toMatchObject({ label: "Merged PRs", value: 3, delta: 2 });

    const prList = data(d.prs);
    // Before the prs_reconciled marker the open count is UNKNOWN — never 0.
    expect(prList.openCount).toBeNull();
    const prs = prList.rows;
    expect(prs.map((p) => p.number)).toEqual([10, 11, 12, 13, 5]);
    expect(prs[0]).toMatchObject({ state: "merged", branch: "→ main", checks: null });
    expect(prs[3].state).toBe("closed");
    // A mapped login resolves to its person; an unmapped one keeps the bare login.
    expect(prs[0].author).toMatchObject({ login: "jose-a", handle: "jose-a" });
    expect(prs[2].author).toMatchObject({ login: "meilin", handle: null, color: null });
    expect(JSON.stringify(d)).not.toContain("a long body");

    const code = data(d.codeStats);
    expect(code[0]).toMatchObject({ label: "Closed unmerged", value: 1 });
    expect(code[1]).toMatchObject({ label: "Merged this week", value: 3, sub: "by 2 people" });
  });

  // Task 12: `refreshBranches` (src/repo/github.ts) writes a `branches`
  // snapshot; the projection only reads it back — never guessed.
  it("reads the branches snapshot back as `ok`, and swaps the 4th code tile to Active branches once one exists", async () => {
    const before = await getRepoDashboard(systemCtx(), "o/r", NOW);
    expect(before.branches.status).toBe("not_connected");
    expect(data(before.codeStats)[3]).toMatchObject({ label: "Issues closed" });

    await putSnapshot(systemCtx(), "branches", {
      active: 5, stale: 2,
      rows: [{ name: "feature/x", at: "2026-09-19T00:00:00Z", ahead: 3, behind: 1, stale: false }],
    });
    const after = await getRepoDashboard(systemCtx(), "o/r", NOW);
    expect(data(after.branches)).toEqual({
      active: 5, stale: 2,
      rows: [{ name: "feature/x", at: "2026-09-19T00:00:00Z", ahead: 3, behind: 1, stale: false }],
    });
    expect(data(after.codeStats)[3]).toEqual({ label: "Active branches", value: 5, sub: "2 stale", tone: "warn" });
  });

  it("tones the Active branches tile neutral when nothing is stale", async () => {
    await putSnapshot(systemCtx(), "branches", { active: 3, stale: 0, rows: [] });
    const d = await getRepoDashboard(systemCtx(), "o/r", NOW);
    expect(data(d.codeStats)[3]).toEqual({ label: "Active branches", value: 3, sub: "0 stale", tone: "neutral" });
  });

  it("buckets merges into 14 UTC days, oldest first", async () => {
    await ingestAll([prEvent(1, "a", ago(0, 1)), prEvent(2, "a", ago(0, 2)), prEvent(3, "a", ago(13))]);
    const bars = data((await getRepoDashboard(systemCtx(), "o/r", NOW)).bars);
    expect(bars.days).toHaveLength(14);
    expect(bars.days[13]).toEqual({ date: "2026-09-20", count: 2 });
    expect(bars.days[0]).toEqual({ date: "2026-09-07", count: 1 });
    expect(bars.note).toBe("3 merged PRs · all branches");
  });

  it("open issues are the LATEST snapshot per issue, with a week-ago delta", async () => {
    await ingestAll([
      issueEvent(1, "a", ago(10), "opened", "open", ["bug"]),
      issueEvent(2, "a", ago(9), "opened", "open", ["docs"]),
      issueEvent(2, "a", ago(2), "closed", "closed", ["docs"]),  // closed this week
      issueEvent(3, "a", ago(1), "opened", "open", ["bug", "infra"]),
      issueEvent(3, "a", ago(0, 3), "edited", "open", ["bug", "infra"]),
    ]);
    const d = await getRepoDashboard(systemCtx(), "o/r", NOW);
    const [, issues, bugs] = data(d.stats);
    expect(issues).toMatchObject({ value: 2, delta: 0, tone: "neutral" }); // was {1,2}, now {1,3}
    expect(bugs).toMatchObject({ value: 2, delta: 1, tone: "warn" });

    const labels = data(d.labels);
    expect(labels.total).toBe(2);
    expect(labels.rows).toEqual([{ name: "bug", count: 2 }, { name: "infra", count: 1 }]);
  });

  it("the feed merges PR closes and issue moves, newest first, and skips edit noise", async () => {
    await seedPerson("jose-a");
    await ingestAll([
      prEvent(10, "jose-a", ago(0, 5)),
      issueEvent(3, "jose-a", ago(0, 1), "opened", "open"),
      issueEvent(3, "jose-a", ago(0, 2), "edited", "open"),
      issueEvent(4, "jose-a", ago(0, 3), "closed", "closed"),
    ]);
    const feed = data((await getRepoDashboard(systemCtx(), "o/r", NOW)).activity);
    expect(feed.map((a) => a.kind)).toEqual(["issue", "close", "merge"]);
    expect(feed[0]).toMatchObject({ text: "opened #3 “Issue 3”", actor: { handle: "jose-a" } });
    // Nothing captured says who closed or merged — so the row never claims an actor.
    expect(feed[1].actor).toBeNull();
    expect(feed[2].text).toBe("#10 “PR 10” by @jose-a was merged");
  });

  it("contributors tally this week's merges per login, not issue closes — and reviews stay null (no review row captured)", async () => {
    await ingestAll([
      prEvent(1, "a", ago(1)), prEvent(2, "a", ago(2)), prEvent(3, "b", ago(1)),
      prEvent(4, "b", ago(12)), // outside the week
      issueEvent(9, "b", ago(1), "closed", "closed"), // has NO effect on the tally below
    ]);
    const rows = data((await getRepoDashboard(systemCtx(), "o/r", NOW)).contributors);
    expect(rows.map((r) => [r.person.login, r.pushes, r.merged, r.reviews])).toEqual([["a", 0, 2, null], ["b", 0, 1, null]]);
  });

  it("the current sprint is the one a person marked active, with the Roadmap's ticket progress", async () => {
    await seedPerson("jose-a");
    const sp = await create_sprint(systemCtx(), SprintCreate.parse({ label: "Notifications GA" }), "jose-a");
    expect((await getRepoDashboard(systemCtx(), "o/r", NOW)).sprint.status).toBe("empty");
    await set_sprint_active(systemCtx(), sp.id, true);
    const sprint = data((await getRepoDashboard(systemCtx(), "o/r", NOW)).sprint);
    expect(sprint).toMatchObject({ id: sp.id, label: "Notifications GA", closed: 0, total: 0, pct: 0 });
  });

  it("coverage, bundle and TODO read as value + trend + delta from repo_metrics", async () => {
    const pts: [string, number][] = [[ago(30), 77.2], [ago(10), 78.0], [ago(1), 78.4]];
    for (const [at, value] of pts) await putMetric(systemCtx(), { metric: "coverage", env: "", part: "", value, at });
    await putMetric(systemCtx(), { metric: "todo_count", env: "", part: "", value: 61, at: ago(40) });
    await putMetric(systemCtx(), { metric: "todo_count", env: "", part: "", value: 43, at: ago(1) });
    const d = await getRepoDashboard(systemCtx(), "o/r", NOW);
    expect(data(d.coverage)).toMatchObject({ value: "78.4%", trend: [77.2, 78, 78.4], delta: "+1.2", tone: "good" });
    expect(data(d.todos)).toMatchObject({ count: 43, delta: -18, trend: [61, 43] });
    expect(d.bundle.status).toBe("not_connected");
  });

  // Controller ruling on Task 14: a delta claims a trend only once the window
  // holds ≥2 points whose first and last are ≥7 days apart — never guess a
  // trend off a single reading or two readings a day apart.
  it("a single coverage point shows the value with no delta claim", async () => {
    await putMetric(systemCtx(), { metric: "coverage", env: "", part: "", value: 80.1, at: ago(1) });
    const cov = data((await getRepoDashboard(systemCtx(), "o/r", NOW)).coverage);
    expect(cov).toMatchObject({ value: "80.1%", trend: [80.1], delta: "", tone: "neutral" });
  });

  it("two coverage points less than 7 days apart also show no delta claim", async () => {
    await putMetric(systemCtx(), { metric: "coverage", env: "", part: "", value: 77.0, at: ago(3) });
    await putMetric(systemCtx(), { metric: "coverage", env: "", part: "", value: 77.5, at: ago(1) });
    const cov = data((await getRepoDashboard(systemCtx(), "o/r", NOW)).coverage);
    expect(cov).toMatchObject({ trend: [77, 77.5], delta: "", tone: "neutral" });
  });

  it("a single TODO point shows the count with no delta and no since text", async () => {
    await putMetric(systemCtx(), { metric: "todo_count", env: "", part: "", value: 50, at: ago(1) });
    const todos = data((await getRepoDashboard(systemCtx(), "o/r", NOW)).todos);
    expect(todos).toMatchObject({ count: 50, delta: null, trend: [50] });
  });

  // I2: a metric that goes QUIET is not the same as a metric that was never
  // connected — once something has EVER landed for it, an empty window reads
  // `empty` ("no reading in the window"), never `not_connected` ("nothing
  // scans this at all"). Only checked on the empty path (latestMetric costs
  // nothing when the window already has points).
  it("coverage reads empty, not not_connected, once a reading exists outside the 30-day window (I2)", async () => {
    await putMetric(systemCtx(), { metric: "coverage", env: "", part: "", value: 70, at: ago(40) });
    const d = await getRepoDashboard(systemCtx(), "o/r", NOW);
    expect(d.coverage.status).toBe("empty");
  });

  it("bundle reads empty, not not_connected, once a reading exists outside the 30-day window (I2)", async () => {
    await putMetric(systemCtx(), { metric: "bundle_kb", env: "", part: "", value: 400, at: ago(40) });
    const d = await getRepoDashboard(systemCtx(), "o/r", NOW);
    expect(d.bundle.status).toBe("empty");
  });

  it("todos reads empty, not not_connected, once a reading exists outside the 90-day window (I2)", async () => {
    await putMetric(systemCtx(), { metric: "todo_count", env: "", part: "", value: 50, at: ago(100) });
    const d = await getRepoDashboard(systemCtx(), "o/r", NOW);
    expect(d.todos.status).toBe("empty");
  });
});

describe("GET /repo/dashboard", () => {
  it("is session-gated", async () => {
    const res = await app.request("/repo/dashboard", {}, env);
    expect(res.status).toBe(401);
  });

  it("returns the projection for a signed-in member", async () => {
    const cookie = await cookieFor("jose-a");
    await ingestAll([prEvent(10, "jose-a", new Date().toISOString())]);
    const res = await app.request("/repo/dashboard", { headers: { cookie } }, env);
    expect(res.status).toBe(200);
    const d = (await res.json()) as RepoDashboard;
    expect(d.prs.status).toBe("ok");
    expect(d.deploys.status).toBe("not_connected");
    expect(d.sample).toBeUndefined();
  });
});

const prRow = (number: number, state: string, at: string, over: Partial<RepoEvent> = {}): RepoEvent => ({
  semantic_key: `gh:prs:${number}:${state}:${at}`, kind: "pr", number, state, ref: `feat/${number}`, sha: `sha${number}`,
  actor_login: "jose-a", title: `PR ${number}`, url: `https://github.com/o/r/pull/${number}`, raw: "{}", provenance: "webhook", occurred_at: at, ...over,
});
const pushRow = (sha: string, ref: string, count: number, at: string, actor = "jose-a", provenance: RepoEvent["provenance"] = "webhook"): RepoEvent => ({
  semantic_key: `gh:push:${sha}:${ref}`, kind: "push", ref, sha, actor_login: actor, count, title: `commit ${sha}`, raw: "{}", provenance, occurred_at: at,
});
const ingestRepo = async (rows: RepoEvent[]) => { for (const r of rows) await ingestRepoEvent(systemCtx(), r); };

// F1: getRepoDashboard's `prCaptured` gates on the `prs_reconciled` snapshot
// (written by reconcileRepo, see test/repo-reconcile.test.ts), not on "any pr
// row exists" — write it explicitly wherever a test needs the captured
// ("Open PRs") tiles rather than the merged-PR fallback.
const markPrsReconciled = async (at: string = new Date(NOW).toISOString()) => putSnapshot(systemCtx(), "prs_reconciled", { at }, at);
// F2: ingestRepoEvent always stamps `recorded_at` with the real wall clock, so
// a freshly-ingested `pr`/`push` row always looks like capture "just began" —
// backdate it to make a week-over-week delta observable in a test.
const backdateRecording = async (kind: "pr" | "push", at: string) => run(env.DB, `UPDATE repo_events SET recorded_at = ? WHERE kind = ?`, at, kind);

describe("getRepoDashboard — pushes and PR state (sources A, B)", () => {
  it("counts OPEN PRs from the latest state per PR, with a week-ago delta once capture predates the window (F1, F2)", async () => {
    await ingestRepo([
      prRow(1, "review", ago(10)),                       // open then and now
      prRow(2, "review", ago(9)), prRow(2, "merged", ago(2)), // open a week ago, merged since
      prRow(3, "draft", ago(1)),                         // new this week, draft
      prRow(4, "review", ago(1)),
    ]);
    // F1: the captured tiles only turn on once the completeness marker exists.
    await markPrsReconciled();
    // F2: and the delta only turns on once capture was recording a week ago —
    // backdate these rows' `recorded_at` (stamped "now" at ingest) to prove it.
    await backdateRecording("pr", ago(20));
    const [openPrs, awaiting] = data((await getRepoDashboard(systemCtx(), "o/r", NOW)).stats);
    expect(openPrs).toMatchObject({ label: "Open PRs", value: 3, delta: 1 });       // was {1,2}, now {1,3,4}
    expect(awaiting).toMatchObject({ label: "Awaiting review", value: 2, delta: 0 }); // non-draft open: was {1,2}, now {1,4}
  });

  it("F2: suppresses the PR deltas to 0 while capture has NOT been recording for the whole comparison window", async () => {
    // Same rows/values as the test above — {1,3,4} now vs {1,2} a week ago —
    // so the unsuppressed math WOULD show delta: 1.
    await ingestRepo([
      prRow(1, "review", ago(10)), prRow(2, "review", ago(9)), prRow(2, "merged", ago(2)),
      prRow(3, "draft", ago(1)), prRow(4, "review", ago(1)),
    ]);
    // Marked reconciled just now — recorded_at is "now", which is AFTER weekAgo,
    // so the value still reads 3, but the delta must read 0, not the spurious
    // spike attributable to when capture happened to begin.
    await markPrsReconciled();
    const [openPrs, awaiting] = data((await getRepoDashboard(systemCtx(), "o/r", NOW)).stats);
    expect(openPrs).toMatchObject({ label: "Open PRs", value: 3, delta: 0 });
    expect(awaiting).toMatchObject({ label: "Awaiting review", value: 2, delta: 0 });
  });

  it("lists open and recent PRs with their head branch and state", async () => {
    await seedPerson("jose-a");
    await ingestRepo([prRow(7, "draft", ago(3)), prRow(7, "review", ago(1)), prRow(8, "merged", ago(2))]);
    await markPrsReconciled();
    const prs = data((await getRepoDashboard(systemCtx(), "o/r", NOW)).prs).rows;
    expect(prs.map((p) => [p.number, p.state, p.branch])).toEqual([[7, "review", "feat/7"], [8, "merged", "feat/8"]]);
    expect(prs[0].author.handle).toBe("jose-a");
  });

  it("M8: drops a PR row with an unrecognized state instead of guessing 'review'", async () => {
    await seedPerson("jose-a");
    await ingestRepo([prRow(7, "review", ago(1)), prRow(9, "some-new-github-state", ago(1))]);
    await markPrsReconciled();
    const prs = data((await getRepoDashboard(systemCtx(), "o/r", NOW)).prs).rows;
    expect(prs.map((p) => p.number)).toEqual([7]);
  });

  it("draws the 14-day bars from COMMITS once pushes are captured", async () => {
    await ingestRepo([pushRow("a1", "main", 3, ago(0, 2)), pushRow("a2", "feat/x", 2, ago(0, 3)), pushRow("a3", "main", 4, ago(13))]);
    const d = await getRepoDashboard(systemCtx(), "o/r", NOW);
    const bars = data(d.bars);
    expect(bars.title).toBe("Commit activity — last 14 days");
    expect(bars.days[13].count).toBe(5);
    expect(bars.days[0].count).toBe(4);
    expect(bars.note).toBe("9 commits · all branches");
    expect(data(d.codeStats).find((s) => s.label === "Commits this week")).toMatchObject({ value: 5 });
  });

  it("F2: shows the commits week-over-week delta once push capture predates the two-week window", async () => {
    await ingestRepo([pushRow("a1", "main", 3, ago(0, 2)), pushRow("a2", "main", 2, ago(9))]);
    await backdateRecording("push", ago(20));
    const commits = data((await getRepoDashboard(systemCtx(), "o/r", NOW)).codeStats).find((s) => s.label === "Commits this week")!;
    expect(commits.sub).toBe("▲ 1 vs last week"); // 3 this week vs 2 last week
  });

  it("F2: drops the commits delta comparison until push capture predates the two-week window", async () => {
    await ingestRepo([pushRow("a1", "main", 3, ago(0, 2))]);
    // recorded_at is "now" (this run), well inside the two-week window.
    const commits = data((await getRepoDashboard(systemCtx(), "o/r", NOW)).codeStats).find((s) => s.label === "Commits this week")!;
    expect(commits.sub).toBe("this week");
  });

  it("puts pushes in the feed and in the contributor columns", async () => {
    await seedPerson("jose-a");
    await ingestRepo([pushRow("a1", "fix/sse-auth", 1, ago(0, 1)), pushRow("a2", "main", 3, ago(0, 2))]);
    const d = await getRepoDashboard(systemCtx(), "o/r", NOW);
    const feed = data(d.activity);
    expect(feed[0]).toMatchObject({ kind: "push", text: "pushed 1 commit to fix/sse-auth", actor: { handle: "jose-a" } });
    expect(feed[1].text).toBe("pushed 3 commits to main");
    // No `review` row has ever been captured, so reviews reads null, not a guessed 0.
    expect(data(d.contributors)[0]).toMatchObject({ pushes: 2, merged: 0, reviews: null });
  });

  it("M10: keeps backfilled pushes out of the feed and the contributors' pushes tally, but not commit totals or bars", async () => {
    await seedPerson("jose-a");
    await ingestRepo([
      pushRow("real1", "main", 5, ago(0, 1)), // a real webhook push
      // A backfilled 3-commit push is 3 synthetic count-1 rows, not 1 count-3 row.
      pushRow("bf1", "main", 1, ago(0, 2), "jose-a", "backfill"),
      pushRow("bf2", "main", 1, ago(0, 2), "jose-a", "backfill"),
      pushRow("bf3", "main", 1, ago(0, 2), "jose-a", "backfill"),
    ]);
    const d = await getRepoDashboard(systemCtx(), "o/r", NOW);
    // Feed: only the real push.
    const pushLines = data(d.activity).filter((a) => a.kind === "push");
    expect(pushLines).toHaveLength(1);
    expect(pushLines[0].text).toBe("pushed 5 commits to main");
    // Contributors: pushes tally counts the real push only (P=1), not P=4.
    const contributor = data(d.contributors)[0];
    expect(contributor).toMatchObject({ pushes: 1, merged: 0 });
    expect(contributor.person.login).toBe("jose-a");
    // Commit totals and bars still count every commit, backfilled or not.
    const commits = data(d.codeStats).find((s) => s.label === "Commits this week")!;
    expect(commits.value).toBe(8); // 5 + 1 + 1 + 1
    expect(data(d.bars).note).toBe("8 commits · all branches");
  });

  it("before any PR capture exists, keeps the merged-PR tiles instead of claiming 0 open PRs", async () => {
    const labels = data((await getRepoDashboard(systemCtx(), "o/r", NOW)).stats).map((s) => s.label);
    expect(labels).toEqual(["Merged PRs", "Open issues", "Open bugs", "Open tickets"]);
  });

  it("F1 pinned: a single webhook pr row never flips the tiles or the PR list until prs_reconciled exists", async () => {
    await ingestRepo([prRow(7, "review", ago(1))]);
    const before = await getRepoDashboard(systemCtx(), "o/r", NOW);
    expect(data(before.stats).map((s) => s.label)).toEqual(["Merged PRs", "Open issues", "Open bugs", "Open tickets"]);
    // The PR list must not come from repo_events either, while uncaptured —
    // nothing was ingested into `events`, so the merged/closed fallback is empty.
    expect(before.prs.status).toBe("empty");

    await markPrsReconciled();
    const after = await getRepoDashboard(systemCtx(), "o/r", NOW);
    expect(data(after.stats).map((s) => s.label)).toEqual(["Open PRs", "Awaiting review", "Open issues", "Open bugs"]);
    expect(data(after.prs).rows.map((p) => p.number)).toEqual([7]);
    expect(data(after.prs).openCount).toBe(1);
  });

  it("bounds recentPrRows to 90 days but not prStatesAsOf — a PR untouched for 120 days is still open but absent from the recent list", async () => {
    await ingestRepo([prRow(50, "review", ago(120))]);
    await markPrsReconciled();
    const d = await getRepoDashboard(systemCtx(), "o/r", NOW);
    const [openPrs] = data(d.stats);
    expect(openPrs).toMatchObject({ label: "Open PRs", value: 1 });
    // The list is empty but the count is KNOWN, so the section still carries it —
    // the same figure as the tile, not a count off the (capped, 90-day) rows.
    expect(data(d.prs)).toEqual({ rows: [], openCount: 1 });
  });

  it("openCount is the Overview's Open PRs figure, not a count of the capped list", async () => {
    // 10 open PRs + 2 merged: the list is capped at 8, the count is not.
    await ingestRepo([
      ...Array.from({ length: 10 }, (_, i) => prRow(100 + i, i % 2 ? "draft" : "review", ago(1 + i / 10))),
      prRow(200, "merged", ago(0.5)), prRow(201, "merged", ago(0.6)),
    ]);
    await markPrsReconciled();
    const d = await getRepoDashboard(systemCtx(), "o/r", NOW);
    const list = data(d.prs);
    expect(list.rows.length).toBe(8);
    expect(list.rows.filter((r) => r.state !== "merged").length).toBeLessThan(10);
    expect(list.openCount).toBe(10);
    expect(data(d.stats).find((s) => s.label === "Open PRs")?.value).toBe(list.openCount);
  });

  it("with the marker and nothing open, openCount is a real 0 (known), not null", async () => {
    await markPrsReconciled();
    expect(data((await getRepoDashboard(systemCtx(), "o/r", NOW)).prs)).toEqual({ rows: [], openCount: 0 });
  });
});

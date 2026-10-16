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
import { app } from "../src/routes";
import { createSession } from "../src/auth/session";
import { hmacSeal } from "../src/auth/crypto";
import { putMetric, putSnapshot } from "../src/repo/store";
import { create_sprint, set_sprint_active } from "../src/tools/sprints";
import { SprintCreate } from "@shared/sprints";
import type { RepoEvent } from "../src/repo/types";
import type { CapturedEvent } from "@shared/contract";
import { useAiKey } from "./helpers/ai-key";

// THE read rule (src/plans/gate.ts `aiShown`): no Anthropic key reads like the switch off, so these tests hold a fake one.
useAiKey();

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

async function cookieFor(handle: string): Promise<string> {
  const { id } = await createSession(platformCtx(), handle);
  return `session=${await hmacSeal(id, "test-cookie-secret")}`;
}
/** What the gates cost a `/api/o/:slug/*` request before its handler runs: the session and the membership, ONE statement (was 2). */
const GATE = 1;

const statuses =(d: object): Record<string, unknown> =>
  Object.fromEntries(Object.entries(d).filter(([, v]) => typeof v === "object" && v !== null).map(([k, v]) => [k, (v as { status: string }).status]));

describe("D1 round trips", () => {
  // Before the reads ran as a dataflow: 42 serial of 58 (busy), 34 of 48 (nothing captured). The SAME
  // statements run — only their order changed — and the answer is the same bytes (the repo-dashboard suites).
  it("the Repo dashboard, everything captured: 62 statements, a chain of 6", async () => {
    await seedBusyRepo();
    const c = countingEnv();
    const d = await getRepoDashboard(systemCtx(ORG_A, "system", c.env), "o/r", NOW, ENVS);
    // Every conditional read was taken (the seed is meant to reach them all).
    expect(statuses(d)).toMatchObject({
      prs: "ok", activity: "ok", ciFailures: "ok", environments: "ok", deploys: "ok", providers: "ok", health: "ok",
      sprint: "ok", coverage: "ok", branches: "ok", drift: "ok", contributors: "ok", bars: "ok",
    });
    // 58 before #178: + Trov's themes (THE AI read rule's statement, the themes and their suggestions, the merged PRs and the caption,
    // what the viewer hid — src/tools/themes.ts), read beside the rest, so the chain is unchanged.
    expect(c.total).toBe(62);
    expect(c.serial).toBeLessThanOrEqual(6);
    // The same answer as through the plain binding.
    expect(JSON.stringify(d)).toBe(JSON.stringify(await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS)));
  });

  // Was 5 serial of 8: getPerson, listIdentities and the title each waited on the one before.
  it("GET /auth/me: the session, then every read at once", async () => {
    const cookie = await cookieFor("AndresL230");
    const c = countingEnv();
    const res = await app.request("/auth/me", { headers: { cookie } }, c.env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ handle: "AndresL230", orgs: [{ slug: "saplinglearn" }] });
    expect({ serial: c.serial, total: c.total }).toEqual({ serial: 2, total: 8 });
  });

  it("GET /api/o/:slug/repo/dashboard: the session gate, the org's repo + environments, the dashboard", async () => {
    await seedBusyRepo();
    const cookie = await cookieFor("AndresL230");
    const c = countingEnv();
    const res = await app.request("/api/o/saplinglearn/repo/dashboard", { headers: { cookie } }, c.env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ degraded: false, prs: { status: "ok" }, environments: { status: "ok" } });
    // Was 40 of 54 before the dashboard's reads ran as a dataflow and the session gate read the membership in its own statement.
    // + 1 since #178: Trov's written state for the repository (src/tools/repo-state.ts), read beside the dashboard.
    expect(c.total).toBe(54);
    expect(c.serial).toBe(GATE + 1 + 5);
  });

  it("the Repo dashboard, nothing captured: 51 statements, a chain of 7", async () => {
    await setOrgEnvironments(ENVS, ORG_A);
    const c = countingEnv();
    await getRepoDashboard(systemCtx(ORG_A, "system", c.env), "o/r", NOW, ENVS);
    // 48 before #178: + the themes read (./themes.ts), beside the rest.
    expect(c.total).toBe(51);
    expect(c.serial).toBeLessThanOrEqual(7);
  });
});

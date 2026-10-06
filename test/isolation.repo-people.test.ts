/**
 * Tenant isolation — the Repo dashboard's capture and the people an org sees (Multitenancy Phase 3).
 *
 * Everything here is written under ONE org and read back from BOTH: repo events, snapshots, metrics,
 * drift and the `events` rows the dashboard also reads must be invisible from the neighbour — through
 * each repository read, the whole dashboard projection, and the agent's view of it (MCP
 * `get_repo_dashboard`). The people list is an org's MEMBERS, with the title each holds THERE, and
 * `requireMember` refuses a real person from another org exactly as it refuses a handle nobody has.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { RepoDrift } from "@shared/repo";
import type { PersonForAgents } from "@shared/people";
import type { Env } from "../src/env";
import type { TenantContext } from "../src/data/context";
import { all, first } from "./helpers/db";
import { buildTrovMcpServer } from "../src/mcp";
import { PersonError, listPersons, memberHandle, requireMember } from "../src/auth/persons";
import { fillFailedJob } from "../src/repo/github";
import {
  approvedPrs, branchHeads, ciDailyRates, ciFailureRows, commitsByDay, deployHistories, hasCaptured, latestChecks,
  prStatesAsOf, pushRowsSince, recentPrRows, recordingSince, reviewRowsSince, untitledFailedRuns,
} from "../src/repo/reads";
import {
  getSnapshot, latestHealth, latestMetric, metricSeries, metricsEver, metricsSince, productReadings, pruneRepoCapture,
  putMetric, putMetrics, putSnapshot,
} from "../src/repo/store";
import type { RepoEvent } from "../src/repo/types";
import { PeopleError, getPersonProfile, listPeopleForAgents, writePersonProfile } from "../src/tools/people";
import { getRepoDashboard } from "../src/tools/repo";
import { getRepoDashboardForAgent, type RepoAgentView } from "../src/tools/repo-agent";
import { seedPerson } from "./helpers/persons";
import { ENVS } from "./helpers/repo";
import { ORG_A, ORG_B, ensureMember, platformCtx, systemCtx, tenantCtx } from "./helpers/tenant";

const NOW = Date.parse("2026-09-20T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (days: number, hours = 0): string => new Date(NOW - days * DAY - hours * HOUR).toISOString();
const REPO = "acme/widgets";
const A = (): TenantContext => systemCtx(ORG_A);
const B = (): TenantContext => systemCtx(ORG_B);

/** A captured repo event under `orgId`. Spelled out (not `ingestRepoEvent`) because the row must name its org. */
async function putEvent(orgId: string, ev: RepoEvent): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO repo_events (org_id, repo, semantic_key, kind, ref, sha, number, env, part, state, name, actor_login, title, url, count, raw, provenance, occurred_at, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(orgId, REPO, ev.semantic_key, ev.kind, ev.ref ?? null, ev.sha ?? null, ev.number ?? null, ev.env ?? null, ev.part ?? null,
    ev.state ?? null, ev.name ?? null, ev.actor_login ?? null, ev.title ?? null, ev.url ?? null, ev.count ?? null,
    ev.raw, ev.provenance, ev.occurred_at, ev.occurred_at).run();
}

const DRIFT: RepoDrift = {
  head: "main", base: "production", ahead: 2, behind: 0,
  groups: [{ tag: "#77", kind: "pr", title: "Acme-only change", meta: "acme-dev · 2 commits", commits: [{ sha: "abc1234", msg: "Acme-only change (#77)", at: ago(1) }] }],
};

const SHA = "b".repeat(40);
const ev = (o: Partial<RepoEvent> & Pick<RepoEvent, "semantic_key" | "kind" | "occurred_at">): RepoEvent =>
  ({ raw: "{}", provenance: "webhook", ...o });

/** One org's worth of capture: every kind of repo event, the snapshots, the metrics, and an issue + a
 *  merged PR in `events` (the dashboard reads those too). */
async function seedCapture(orgId: string): Promise<void> {
  const ctx = systemCtx(orgId);
  await putEvent(orgId, ev({ semantic_key: "gh:push:1", kind: "push", ref: "main", sha: SHA, actor_login: "acme-dev", count: 3, title: "Acme push", occurred_at: ago(1) }));
  await putEvent(orgId, ev({ semantic_key: "gh:prs:77:opened", kind: "pr", number: 77, state: "review", ref: "feat/acme", sha: SHA, actor_login: "acme-dev", title: "Acme-only change", url: "https://github.com/acme/widgets/pull/77", occurred_at: ago(2) }));
  await putEvent(orgId, ev({ semantic_key: "gh:review:9:submitted", kind: "review", number: 77, state: "approved", actor_login: "acme-lead", occurred_at: ago(1, 2) }));
  await putEvent(orgId, ev({ semantic_key: "gh:check:5:completed", kind: "check", number: 5, sha: SHA, ref: "main", name: "ci / test", state: "success", occurred_at: ago(1) }));
  await putEvent(orgId, ev({ semantic_key: "gh:deploy:6:success", kind: "deploy", number: 6, env: "staging", part: "backend", sha: SHA, state: "success", name: "Sapling / staging", actor_login: "railway", occurred_at: ago(1) }));
  await putEvent(orgId, ev({ semantic_key: "gh:run:8:1", kind: "run", number: 8, name: "CI", ref: "main", sha: SHA, state: "failure", count: 1, url: "https://github.com/acme/widgets/actions/runs/8", occurred_at: ago(1) }));
  await putSnapshot(ctx, "drift", DRIFT);
  await putSnapshot(ctx, "prs_reconciled", { at: ago(0, 1) }, ago(0, 1));
  await putSnapshot(ctx, "branches", { total: 1, stale: 0, unmerged: 1, oldest: [] });
  await putMetrics(ctx, [
    { metric: "health_up", env: "staging", part: "backend", value: 1, at: ago(0, 1) },
    { metric: "health_ms", env: "staging", part: "backend", value: 88, at: ago(0, 1) },
    { metric: "coverage", env: "", part: "", value: 81.5, at: ago(3) },
    { metric: "cf_requests", env: "staging", part: "frontend", value: 4242, at: ago(0, 2) },
    { metric: "sap_c_signups_24h", env: "staging", part: "", value: 17, at: ago(0, 1) },
  ]);
  for (const [key, type, raw] of [
    ["gh:pr:77:merged", "pr_merged", { pr: { number: 77, title: "Acme-only change", html_url: "https://github.com/acme/widgets/pull/77", merged: true, merged_at: ago(1), closed_at: ago(1), user: { login: "acme-dev" }, base: { ref: "main" } } }],
    ["gh:issue:12:opened", "issue", { action: "opened", issue: { number: 12, title: "Acme-only bug", html_url: "https://github.com/acme/widgets/issues/12", state: "open", updated_at: ago(1), user: { login: "acme-dev" }, assignees: [], labels: ["bug"] } }],
  ] as const) {
    await env.DB.prepare(
      `INSERT INTO events (org_id, repo, semantic_key, event_type, ref_number, subject_login, raw, provenance, occurred_at, recorded_at, recorded_by)
       VALUES (?, ?, ?, ?, ?, 'acme-dev', ?, 'webhook', ?, ?, 'github-webhook')`
    ).bind(orgId, REPO, key, type, type === "issue" ? 12 : 77, JSON.stringify(raw), ago(1), ago(1)).run();
  }
}

describe("repo capture is per org", () => {
  it("every repository read over repo_events sees its own org's rows and none of the neighbour's", async () => {
    await seedCapture(ORG_B);
    const since = ago(14);
    const reads: Array<[string, (ctx: TenantContext) => Promise<unknown>, unknown]> = [
      ["hasCaptured", (c) => hasCaptured(c, "push"), false],
      ["hasCaptured(webhook)", (c) => hasCaptured(c, "review", "webhook"), false],
      ["recordingSince", (c) => recordingSince(c, "pr"), null],
      ["prStatesAsOf", (c) => prStatesAsOf(c, ago(0)), []],
      ["recentPrRows", (c) => recentPrRows(c, 10, since), []],
      ["commitsByDay", async (c) => [...(await commitsByDay(c, since))], []],
      ["pushRowsSince", (c) => pushRowsSince(c, since), []],
      ["deployHistories", async (c) => [...(await deployHistories(c, NOW))], []],
      ["branchHeads", async (c) => [...(await branchHeads(c, ["main"]))], []],
      ["latestChecks", async (c) => [...(await latestChecks(c, [SHA]))], []],
      ["approvedPrs", async (c) => [...(await approvedPrs(c, [77]))], []],
      ["ciFailureRows", (c) => ciFailureRows(c, since, 10), []],
      ["untitledFailedRuns", (c) => untitledFailedRuns(c, since, 10), []],
      ["ciDailyRates", async (c) => (await ciDailyRates(c, NOW)).rate, 0],
      ["reviewRowsSince", (c) => reviewRowsSince(c, since), []],
    ];
    for (const [name, read, nothing] of reads) {
      expect(await read(A()), `${name} from the neighbour`).toEqual(nothing);
      expect(await read(B()), `${name} from its own org`).not.toEqual(nothing);
    }
  });

  it("snapshots and metrics are keyed by org: the same key holds a different value in each", async () => {
    await seedCapture(ORG_B);
    expect(await getSnapshot(A(), "drift")).toBeNull();
    expect((await getSnapshot<RepoDrift>(B(), "drift"))?.data).toEqual(DRIFT);
    expect(await latestMetric(A(), "coverage", "", "")).toBeNull();
    expect(await metricSeries(A(), "coverage", "", "", ago(30))).toEqual([]);
    expect(await metricsSince(A(), [{ metrics: ["cf_requests", "coverage"], since: ago(30) }])).toEqual([]);
    expect([...(await metricsEver(A(), ["coverage", "cf_requests"], ["sap_"]))]).toEqual([]);
    expect(await productReadings(A(), ["staging"], ago(0, 3), ago(30))).toEqual([]);
    expect((await latestHealth(A())).size).toBe(0);

    expect((await latestMetric(B(), "coverage", "", ""))?.value).toBe(81.5);
    expect([...(await metricsEver(B(), ["coverage", "cf_requests"], ["sap_"]))].sort()).toEqual(["cf_requests", "coverage", "sap_*"]);
    expect(await productReadings(B(), ["staging"], ago(0, 3), ago(30))).toHaveLength(1);
    expect((await latestHealth(B())).size).toBe(2);

    // The same snapshot kind and the same (metric, env, part, at) in the other org: a second row, not a conflict.
    await putSnapshot(A(), "drift", { ...DRIFT, ahead: 9 });
    expect(await putMetric(A(), { metric: "coverage", env: "", part: "", value: 12, at: ago(3) })).toBe(true);
    expect((await getSnapshot<RepoDrift>(A(), "drift"))?.data.ahead).toBe(9);
    expect((await getSnapshot<RepoDrift>(B(), "drift"))?.data.ahead).toBe(2);
    expect((await latestMetric(A(), "coverage", "", ""))?.value).toBe(12);
    expect((await latestMetric(B(), "coverage", "", ""))?.value).toBe(81.5);
  });

  it("the dashboard projection of one org does not move when the neighbour captures", async () => {
    const before = await getRepoDashboard(A(), "SaplingLearn/sapling", NOW, ENVS);
    await seedCapture(ORG_B);
    // A native ticket filed and resolved in the neighbour: the Open tickets tile counts tickets and their moves.
    const t = await env.DB.prepare(`INSERT INTO tickets (org_id, title, requester, created_at, updated_at) VALUES (?, 'Acme-only ticket', 'meilin', ?, ?)`).bind(ORG_B, ago(1), ago(1)).run();
    await env.DB.prepare(`INSERT INTO ticket_events (org_id, ticket_id, actor, from_status, to_status, created_at) VALUES (?, ?, 'meilin', 'submitted', 'done', ?)`).bind(ORG_B, t.meta.last_row_id, ago(1)).run();
    expect(await getRepoDashboard(A(), "SaplingLearn/sapling", NOW, ENVS)).toEqual(before);
    expect(before.drift.status).not.toBe("ok");

    const theirs = await getRepoDashboard(B(), REPO, NOW, ENVS);
    expect(theirs.drift).toEqual({ status: "ok", data: DRIFT });
    expect(JSON.stringify(theirs)).toContain("Acme-only change");
    expect(JSON.stringify(before)).not.toContain("Acme-only");
  });

  it("a GitHub login is attributed to a person only inside an org that person belongs to, or that mapped it", async () => {
    await seedPerson("acme-dev", { member: false }); // signs in with GitHub as `acme-dev`
    await ensureMember("acme-dev", "member", ORG_B);
    await env.DB.prepare(`INSERT INTO org_login_map (org_id, github_login, person, mapped_at, mapped_by) VALUES (?, 'acme-lead', 'meilin', ?, 'seed')`).bind(ORG_A, ago(9)).run();
    for (const org of [ORG_A, ORG_B]) {
      await putEvent(org, ev({ semantic_key: "gh:prs:77:opened", kind: "pr", number: 77, state: "review", actor_login: "acme-dev", title: "By acme-dev", occurred_at: ago(2) }));
      await putEvent(org, ev({ semantic_key: "gh:prs:78:opened", kind: "pr", number: 78, state: "review", actor_login: "acme-lead", title: "By acme-lead", occurred_at: ago(1) }));
      await putSnapshot(systemCtx(org), "prs_reconciled", { at: ago(0, 1) }, ago(0, 1));
    }
    const authors = async (ctx: TenantContext) => {
      const prs = (await getRepoDashboard(ctx, REPO, NOW, ENVS)).prs;
      if (prs.status !== "ok") throw new Error("expected the PR list");
      return Object.fromEntries(prs.data.rows.map((r) => [r.author.login, r.author.handle]));
    };
    expect(await authors(A())).toEqual({ "acme-dev": null, "acme-lead": "meilin" });
    expect(await authors(B())).toEqual({ "acme-dev": "acme-dev", "acme-lead": null });
  });

  it("the agent's view (MCP get_repo_dashboard) is the caller's org only", async () => {
    await seedCapture(ORG_B);
    await seedPerson("acme-dev", { member: false });
    const e = { ...(env as unknown as Env), GITHUB_REPO: REPO, REPO_ENVIRONMENTS: JSON.stringify(ENVS) } as Env;
    const tool = async (handle: string, orgId: string): Promise<RepoAgentView> => {
      const server = buildTrovMcpServer(e, await tenantCtx(handle, "member", { via: "bearer", orgId, env: e }));
      const client = new Client({ name: "test", version: "1.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const res = (await client.callTool({ name: "get_repo_dashboard", arguments: { include_trends: true } })) as { content: Array<{ text: string }>; isError?: boolean };
        expect(res.isError).toBeFalsy();
        return JSON.parse(res.content[0].text) as RepoAgentView;
      } finally {
        await client.close();
        await server.close();
      }
    };
    const mine = await tool("acme-dev", ORG_B);
    expect(mine.sections.drift?.status).toBe("ok");
    expect(JSON.stringify(mine)).toContain("Acme-only change");
    const neighbour = await tool("meilin", ORG_A);
    expect(neighbour.sections.drift?.status).not.toBe("ok");
    expect(JSON.stringify(neighbour)).not.toContain("Acme-only");

    // The function behind the tool, on a fixed clock.
    expect(JSON.stringify(await getRepoDashboardForAgent(A(), REPO, ENVS, {}, NOW))).not.toContain("Acme-only");
    expect(JSON.stringify(await getRepoDashboardForAgent(B(), REPO, ENVS, {}, NOW))).toContain("Acme-only change");
  });

  it("an enrichment write names its org: the neighbour's run with the same key is not touched", async () => {
    await seedCapture(ORG_B);
    const jobs = { jobs: [{ name: "test", conclusion: "failure", steps: [{ name: "vitest", conclusion: "failure" }] }] };
    const fetchImpl = (async () => new Response(JSON.stringify(jobs), { status: 200 })) as typeof fetch;
    const title = async () => (await first<{ title: string | null }>(env.DB, `SELECT title FROM repo_events WHERE org_id = ? AND semantic_key = 'gh:run:8:1'`, ORG_B))?.title;

    await fillFailedJob(A(), { token: "t", repo: REPO, fetchImpl }, 8, "gh:run:8:1");
    expect(await title()).toBeNull();
    await fillFailedJob(B(), { token: "t", repo: REPO, fetchImpl }, 8, "gh:run:8:1");
    expect(await title()).toBe("test · vitest");
  });

  it("the retention sweep is the one cross-org writer: it prunes every org's old rows in one pass", async () => {
    const old = new Date(NOW - 60 * DAY).toISOString();
    for (const ctx of [A(), B()]) {
      await putMetric(ctx, { metric: "health_up", env: "staging", part: "backend", value: 1, at: old });
      await putMetric(ctx, { metric: "health_up", env: "staging", part: "backend", value: 1, at: ago(1) });
    }
    await pruneRepoCapture(platformCtx("system"), NOW);
    expect(await all(env.DB, `SELECT org_id, at FROM repo_metrics WHERE metric = 'health_up' ORDER BY org_id`)).toEqual([
      { org_id: ORG_B, at: ago(1) }, { org_id: ORG_A, at: ago(1) },
    ]);
  });
});

describe("people are an org's members", () => {
  /** `acme-only` is a real person in Acme and nowhere else; `meilin` is in both, with a title in each. */
  async function seedPeople(): Promise<void> {
    await seedPerson("acme-only", { name: "Acme Only", member: false });
    await ensureMember("acme-only", "member", ORG_B);
    await ensureMember("meilin", "member", ORG_B);
    await env.DB.batch([
      env.DB.prepare(`UPDATE memberships SET title = 'Widget engineer', responsibilities = 'Widgets.' WHERE org_id = ? AND user_id = 'acme-only'`).bind(ORG_B),
      env.DB.prepare(`UPDATE memberships SET title = 'Advisor', responsibilities = 'Acme strategy.' WHERE org_id = ? AND user_id = 'meilin'`).bind(ORG_B),
    ]);
  }
  const byHandle = (rows: PersonForAgents[], handle: string) => rows.find((r) => r.handle === handle);
  const isAdmin = (h: string) => h === "AndresL230";

  it("the directory and the agents' list hold the org's members only, with the title held in THAT org", async () => {
    await seedPeople();
    const a = await listPersons(A());
    const b = await listPersons(B());
    expect(a.map((p) => p.handle)).not.toContain("acme-only");
    expect(a.map((p) => p.handle)).toContain("sanaok");
    expect(b.map((p) => p.handle).sort()).toEqual(["acme-only", "meilin"]);
    expect(a.find((p) => p.handle === "meilin")?.role).toBe("Product manager");
    expect(b.find((p) => p.handle === "meilin")?.role).toBe("Advisor");

    const forA = await listPeopleForAgents(A());
    const forB = await listPeopleForAgents(B());
    expect(byHandle(forA, "acme-only")).toBeUndefined();
    expect(forB.map((p) => p.handle).sort()).toEqual(["acme-only", "meilin"]);
    expect(byHandle(forA, "meilin")).toMatchObject({ role: "Product manager" });
    expect(byHandle(forA, "meilin")?.responsibilities).toMatch(/roadmap/);
    expect(byHandle(forB, "meilin")).toMatchObject({ role: "Advisor", responsibilities: "Acme strategy." });
    expect(JSON.stringify(forA)).not.toContain("Acme strategy");
  });

  it("a person card is not_found from an org they are not in, and a profile write lands on that org's membership", async () => {
    await seedPeople();
    await expect(getPersonProfile(A(), "acme-only", "AndresL230", isAdmin)).rejects.toMatchObject({ code: "not_found" });
    await expect(getPersonProfile(A(), "no-such-person", "AndresL230", isAdmin)).rejects.toMatchObject({ code: "not_found" });
    await expect(writePersonProfile(A(), "acme-only", "AndresL230", isAdmin, { role: "Intruder" })).rejects.toBeInstanceOf(PeopleError);
    expect((await getPersonProfile(B(), "acme-only", "AndresL230", isAdmin)).role).toBe("Widget engineer");

    await writePersonProfile(B(), "meilin", "AndresL230", isAdmin, { role: "Board member" });
    expect((await getPersonProfile(B(), "meilin", "AndresL230", isAdmin)).role).toBe("Board member");
    expect((await getPersonProfile(A(), "meilin", "AndresL230", isAdmin)).role).toBe("Product manager");
  });

  it("requireMember: a real person from another org is refused exactly like a handle nobody has", async () => {
    await seedPeople();
    const refusal = async (ctx: TenantContext, handle: string) => {
      const e = await requireMember(ctx, handle).then(() => null, (err: unknown) => err);
      expect(e, handle).toBeInstanceOf(PersonError);
      const err = e as PersonError;
      return { code: err.code, message: err.message.replace(handle, "<handle>") };
    };
    const unknown = await refusal(A(), "nobody-at-all");
    expect(unknown).toEqual({ code: "bad_request", message: "no such person: <handle>" });
    expect(await refusal(A(), "acme-only")).toEqual(unknown);        // a real person, not a member here
    expect(await refusal(A(), "github-webhook")).toEqual(unknown);   // reserved: a system principal
    expect(await refusal(B(), "sanaok")).toEqual(unknown);           // and the other way round

    expect(await requireMember(B(), "ACME-ONLY")).toBe("acme-only"); // canonical spelling
    expect(await requireMember(A(), "meilin")).toBe("meilin");
    expect(await requireMember(B(), "meilin")).toBe("meilin");
    expect(await memberHandle(A(), "acme-only")).toBeNull();
  });
});

// THE AI ROUTER (src/tools/ai-route.ts, src/data/ai-dirty.ts; docs/architecture/ai.md › The router) and the
// DEBOUNCE (shared/ai-core.ts): the one table from a write to the scopes it made stale — pure, then against real
// D1 rows — what a mark keeps and resets, the switch, the derived scopes, and every write path that calls it
// (one line after its write; a mark that fails never fails the write).
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { AI_ROUTES, routeAi, scopesFor, type AiEvent } from "../src/tools/ai-route";
import { markDirty } from "../src/data/ai-dirty";
import { debounceFrom, debounceMs, AI_SCOPES } from "@shared/ai";
import { isDue } from "../src/ai/pass";
import { create_ticket, set_ticket_sprint, toggle_assignee, transition_ticket } from "../src/tools/tickets";
import { createHandoff } from "../src/tools/handoffs";
import { ingestAdrDraft, ingestDocProposal, ingestEvent, ingestFeedEntry } from "../src/consumer";
import { promote_doc, route_triage } from "../src/tools/writes";
import { addTextVersion, createPage } from "../src/tools/artifacts";
import { mirrorIssue } from "../src/tools/ticket-mirror";
import { captureDelivery } from "../src/webhook";
import { prewarmDigests } from "../src/notifications/cron";
import { listAllParts } from "../src/hosting/parts";
import { pollPart, type ProviderMap } from "../src/hosting/poll";
import type { HostingProvider } from "../src/hosting/types";
import { setIntegrationConfig, setSecret } from "../src/data/secrets";
import { all, run } from "./helpers/db";
import { ORG_A, ORG_B, platformCtx, systemCtx, tenantCtx } from "./helpers/tenant";
import { addOrgRepo, setOrgEnvironments } from "./helpers/org-config";
import { ENVS, LONG_TOKEN } from "./helpers/repo";

const e = env as unknown as Env;
const REPO = "SaplingLearn/sapling";
const T0 = "2026-10-14T10:00:00.000Z";
const T1 = "2026-10-14T10:05:00.000Z";
const T2 = "2026-10-14T10:20:00.000Z";

interface Row { scope: string; scope_key: string; dirty_since: string; marked_at: string | null; last_run_at: string | null; attempts: number; urgent: number }
const rows = (orgId: string = ORG_A) => all<Row>(env.DB,
  `SELECT scope, scope_key, dirty_since, marked_at, last_run_at, attempts, urgent FROM ai_dirty WHERE org_id = ? ORDER BY scope, scope_key`, orgId);
const scopes = async (orgId: string = ORG_A) => (await rows(orgId)).map((r) => `${r.scope}:${r.scope_key}`);
const clean = () => run(env.DB, `DELETE FROM ai_dirty`);

describe("THE TABLE (pure): each event → exactly the design's scopes", () => {
  it("every row of the design's table, plus the hosting-deploy row", () => {
    expect(Object.keys(AI_ROUTES).sort()).toEqual([
      "artifact_saved", "digest_prewarm", "digest_week", "doc_promoted", "feed_ingested", "handoff_sent", "hosting_deploy", "pr_merged", "proposal_staged",
      "repo_activity", "themes_accepted", "ticket_changed", "ticket_created", "ticket_mirrored", "unplaced",
    ]);
    expect(scopesFor({ type: "pr_merged", number: 173, author: "AndresL230" })).toEqual([
      { scope: "card", key: "pr:173" }, { primaryRepo: "repo" }, { personLogin: "AndresL230" }, { prSprints: 173 }, { primaryRepo: "theme_window" },
    ]);
    const act = (kind: string, o: Record<string, unknown> = {}): AiEvent =>
      ({ type: "repo_activity", repo: REPO, defaultBranch: "main", ev: { kind, ref: "main", state: null, actor_login: "jose", ...o } } as AiEvent);
    // A push: the session always; the repo only on the default branch.
    expect(scopesFor(act("push"))).toEqual([{ scope: "session", key: `${REPO}:jose` }, { scope: "repo", key: REPO }]);
    expect(scopesFor(act("push", { ref: "feat/x" }))).toEqual([{ scope: "session", key: `${REPO}:jose` }]);
    // A PR opened (open states) is a session event; a merged / closed PR row is not (that is `pr_merged`).
    expect(scopesFor(act("pr", { state: "review", ref: "feat/x" }))).toEqual([{ scope: "session", key: `${REPO}:jose` }]);
    expect(scopesFor(act("pr", { state: "merged" }))).toEqual([]);
    expect(scopesFor(act("review", { state: "approved" }))).toEqual([]);
    // A run: a default-branch failure is the repo's; a failure on a PR branch is its author's.
    expect(scopesFor(act("run", { state: "failure" }))).toEqual([{ scope: "session", key: `${REPO}:jose` }, { scope: "repo", key: REPO }]);
    expect(scopesFor(act("run", { state: "success" }))).toEqual([{ scope: "session", key: `${REPO}:jose` }]);
    expect(scopesFor(act("run", { state: "failure", ref: "feat/x" }))).toEqual([{ scope: "session", key: `${REPO}:jose` }, { prAuthorOfBranch: "feat/x" }]);
    expect(scopesFor(act("check", { state: "failure", ref: "feat/x" }))).toEqual([{ scope: "session", key: `${REPO}:jose` }, { prAuthorOfBranch: "feat/x" }]);
    // A deploy is always the repo's. No actor → no session (never a guessed one).
    expect(scopesFor(act("deploy", { actor_login: null, ref: "production" }))).toEqual([{ scope: "repo", key: REPO }]);
    // Unknown default branch: nothing is "on the default branch".
    expect(scopesFor({ ...act("push"), defaultBranch: null } as AiEvent)).toEqual([{ scope: "session", key: `${REPO}:jose` }]);
    // A hosting deploy: only when it LANDED or FAILED, and only with a branch; never a session.
    expect(scopesFor({ type: "hosting_deploy", env: "staging", branch: "main", state: "ready" })).toEqual([{ repoIfEnvBranch: { env: "staging", branch: "main" } }]);
    expect(scopesFor({ type: "hosting_deploy", env: "staging", branch: "main", state: "error" })).toEqual([{ repoIfEnvBranch: { env: "staging", branch: "main" } }]);
    expect(scopesFor({ type: "hosting_deploy", env: "staging", branch: "main", state: "building" })).toEqual([]);
    expect(scopesFor({ type: "hosting_deploy", env: "staging", branch: null, state: "ready" })).toEqual([]);
    expect(scopesFor({ type: "ticket_created", number: 14 })).toEqual([{ scope: "card", key: "ticket:14" }, { scope: "org" }]);
    expect(scopesFor({ type: "ticket_mirrored", sourceRef: `${REPO}#9` })).toEqual([{ mirroredTicket: `${REPO}#9` }, { scope: "org" }]);
    expect(scopesFor({ type: "ticket_changed", ticketId: 5, sprints: [3, null], people: ["meilin"] })).toEqual([
      { ticketPeople: 5 }, { scope: "person", key: "meilin" }, { ticketSprint: 5 }, { scope: "sprint", key: "3" }, { scope: "org" },
    ]);
    expect(scopesFor({ type: "handoff_sent", recipient: "meilin" })).toEqual([{ scope: "person", key: "meilin" }]);
    expect(scopesFor({ type: "handoff_sent", recipient: "anyone" })).toEqual([{ members: 20 }]);
    expect(scopesFor({ type: "feed_ingested", id: 7, author: "AndresL230" })).toEqual([{ scope: "card", key: "feed:7" }, { scope: "person", key: "AndresL230" }]);
    expect(scopesFor({ type: "proposal_staged", ref: "doc:auth:2" })).toEqual([{ scope: "card", key: "proposal:doc:auth:2" }]);
    expect(scopesFor({ type: "unplaced", id: 4 })).toEqual([{ scope: "card", key: "unplaced:4" }]);
    expect(scopesFor({ type: "doc_promoted", slug: "auth" })).toEqual([{ scope: "card", key: "tagfit:doc:auth" }, { scope: "doc_drift", key: "auth" }]);
    expect(scopesFor({ type: "artifact_saved", slug: "logo" })).toEqual([{ scope: "card", key: "tagfit:artifact:logo" }, { scope: "doc_drift", key: "artifact:logo" }]);
    expect(scopesFor({ type: "themes_accepted" })).toEqual([{ primaryRepo: "theme_backfill" }]);
    expect(scopesFor({ type: "digest_prewarm", handle: "meilin" })).toEqual([{ scope: "person", key: "meilin", urgent: true }]);
    // Phase E: the weekly e-mail's "This week", one scope per org per week.
    expect(scopesFor({ type: "digest_week", key: "week:2026-W38:2026-09-14T12:00:00.000Z" })).toEqual([{ scope: "digest", key: "week:2026-W38:2026-09-14T12:00:00.000Z" }]);
  });
});

describe("markDirty: rows only, keeping the first mark", () => {
  it("a new mark; a re-mark keeps dirty_since, moves marked_at and resets attempts; a mark after a run starts over", async () => {
    const ctx = systemCtx(ORG_A);
    await markDirty(ctx, [{ scope: "repo", key: REPO }], T0);
    expect(await rows()).toEqual([{ scope: "repo", scope_key: REPO, dirty_since: T0, marked_at: T0, last_run_at: null, attempts: 0, urgent: 0 }]);
    await run(env.DB, `UPDATE ai_dirty SET attempts = 3, last_error = 'no_answer'`);
    await markDirty(ctx, [{ scope: "repo", key: REPO }], T1);
    expect((await rows())[0]).toMatchObject({ dirty_since: T0, marked_at: T1, attempts: 0 });
    // Written at T1 (clean), marked again at T2: a NEW dirty_since.
    await run(env.DB, `UPDATE ai_dirty SET last_run_at = ?`, T1);
    await markDirty(ctx, [{ scope: "repo", key: REPO, urgent: true }], T2);
    expect((await rows())[0]).toMatchObject({ dirty_since: T2, marked_at: T2, urgent: 1 });
    // While dirty, urgent is kept (the max) by a plain re-mark.
    await markDirty(ctx, [{ scope: "repo", key: REPO }], T2);
    expect((await rows())[0].urgent).toBe(1);
  });

  it("THE SWITCH: an org with AI off is marked nothing; another org's marks are its own", async () => {
    await run(env.DB, `UPDATE orgs SET ai_automation = 0 WHERE id = ?`, ORG_B);
    await markDirty(systemCtx(ORG_B), [{ scope: "org" }, { members: 20 }], T0);
    expect(await rows(ORG_B)).toEqual([]);
    await markDirty(systemCtx(ORG_A), [{ scope: "org" }], T0);
    expect(await scopes(ORG_A)).toEqual(["org:"]);
    expect(await rows(ORG_B)).toEqual([]);
  });

  it("the derived scopes resolve in SQL, in the org's own rows", async () => {
    const ctx = systemCtx(ORG_A);
    await addOrgRepo(REPO, ORG_A);
    await setOrgEnvironments(ENVS, ORG_A);
    await markDirty(ctx, [
      { personLogin: "Jose-Gael-Cruz-Lopez" }, { personLogin: "a-stranger" },
      { primaryRepo: "repo" }, { primaryRepo: "theme_window" },
      { repoIfEnvBranch: { env: "staging", branch: "main" } }, { repoIfEnvBranch: { env: "staging", branch: "feat/x" } },
      { members: 3 },
    ], T0);
    expect(await scopes()).toEqual([
      "person:AndresL230", "person:Darkest-Teddy", "person:Jose-Gael-Cruz-Lopez", `repo:${REPO}`, `theme_window:${REPO}`,
    ]);
    // A PR's author by its head branch (repo_events), the sprints of the tickets that link the PR.
    await run(env.DB, `INSERT INTO repo_events (org_id, semantic_key, kind, ref, number, state, actor_login, raw, provenance, occurred_at, recorded_at)
      VALUES (?, 'gh:pr:9', 'pr', 'feat/x', 9, 'review', 'lpcooper-arch', '{}', 'webhook', ?, ?)`, ORG_A, T0, T0);
    await run(env.DB, `INSERT INTO sprints (id, org_id, title, target_date, status, created_at, created_by) VALUES (41, ?, 'S', '2026-10-30', 'in_progress', ?, 'AndresL230')`, ORG_A, T0);
    const n = await create_ticket(ctx, { title: "T", body: "", category: "other", priority: "normal", assignees: ["meilin"], sprint_id: 41, link: `https://github.com/${REPO}/pull/9` }, "AndresL230");
    await clean();
    const id = (await all<{ id: number }>(env.DB, `SELECT id FROM tickets WHERE org_id = ? AND number = ?`, ORG_A, n))[0].id;
    await markDirty(ctx, [{ prAuthorOfBranch: "feat/x" }, { prSprints: 9 }, { ticketPeople: id }, { ticketSprint: id }], T0);
    expect(await scopes()).toEqual(["person:lpcooper-arch", "person:meilin", "sprint:41"]);
  });
});

describe("THE DEBOUNCE (shared/ai-core.ts)", () => {
  const M = 60_000, H = 60 * M, D = 24 * H;
  it("is the design's table, per plan", () => {
    const pro = (s: (typeof AI_SCOPES)[number], o = {}) => debounceMs(s, "team", o);
    const free = (s: (typeof AI_SCOPES)[number], o = {}) => debounceMs(s, "free", o);
    expect([pro("session"), free("session")]).toEqual([45 * M, 45 * M]);
    expect([pro("card"), free("card")]).toEqual([0, 0]);
    expect([pro("person"), free("person"), debounceMs("person", "personal")]).toEqual([30 * M, 2 * H, 2 * H]);
    expect([pro("repo"), free("repo"), debounceMs("repo", "enterprise")]).toEqual([H, 6 * H, H]);
    expect([pro("org"), pro("sprint"), free("org"), free("sprint")]).toEqual([6 * H, 6 * H, D, D]);
    expect([pro("theme_window"), free("theme_window")]).toEqual([D, 7 * D]);
    expect([pro("doc_drift"), free("doc_drift")]).toEqual([7 * D, 30 * D]);
    expect([pro("theme_backfill"), free("theme_backfill")]).toEqual([0, 0]);
    expect([pro("digest"), free("digest")]).toEqual([0, 0]); // Phase E: marked hours before the weekly send
    // A breaking change skips the repo's wait on Pro / Enterprise only; the pre-warm skips a person's on every plan.
    expect([pro("repo", { urgent: true }), free("repo", { urgent: true })]).toEqual([0, 6 * H]);
    expect([pro("person", { urgent: true }), free("person", { urgent: true })]).toEqual([0, 0]);
    expect(pro("org", { urgent: true })).toBe(6 * H);
    expect(AI_SCOPES.filter((s) => debounceFrom(s) === "last")).toEqual(["session"]);
  });

  it("isDue: a session closes 45 min after its LAST event; every other scope counts from its FIRST mark", () => {
    const at = (iso: string) => Date.parse(iso);
    const s = { scope: "session" as const, key: "r:a", dirtySince: "2026-10-14T10:00:00.000Z", markedAt: "2026-10-14T10:40:00.000Z", attempts: 0, urgent: false };
    expect(isDue(s, "team", at("2026-10-14T11:00:00.000Z"))).toBe(false); // 20 min after the last push
    expect(isDue(s, "team", at("2026-10-14T11:25:00.000Z"))).toBe(true);
    const r = { ...s, scope: "repo" as const };
    expect(isDue(r, "team", at("2026-10-14T11:00:00.000Z"))).toBe(true); // 60 min after the FIRST mark
    expect(isDue(r, "free", at("2026-10-14T11:00:00.000Z"))).toBe(false);
    expect(isDue({ ...r, urgent: true }, "team", at("2026-10-14T10:00:00.000Z"))).toBe(true);
  });
});

describe("the write paths mark (one line, after the write)", () => {
  it("tickets: created → its card + org; status / assignee / sprint → people, sprints (old and new), org", async () => {
    const ctx = systemCtx(ORG_A);
    await run(env.DB, `INSERT INTO sprints (id, org_id, title, target_date, status, created_at, created_by) VALUES (51, ?, 'A', '2026-10-30', 'in_progress', ?, 'AndresL230'), (52, ?, 'B', '2026-11-30', 'upcoming', ?, 'AndresL230')`, ORG_A, T0, ORG_A, T0);
    const n = await create_ticket(ctx, { title: "T", body: "", category: "other", priority: "normal", assignees: ["meilin"], sprint_id: 51 }, "AndresL230");
    expect(await scopes()).toEqual([`card:ticket:${n}`, "org:"]);
    await clean();
    await transition_ticket(ctx, n, "in_progress", "AndresL230");
    expect(await scopes()).toEqual(["org:", "person:meilin", "sprint:51"]);
    await clean();
    await toggle_assignee(ctx, n, "meilin", false);
    expect(await scopes()).toEqual(["org:", "person:meilin", "sprint:51"]); // the one just unassigned too
    await clean();
    await set_ticket_sprint(ctx, n, 52);
    expect(await scopes()).toEqual(["org:", "sprint:51", "sprint:52"]);
  });

  it("the issue mirror: a mirrored ticket's card by its number; a forced status change", async () => {
    const ctx = systemCtx(ORG_A, "github-webhook");
    const issue = (action: string, state: string) => ({
      action, repository: { full_name: REPO },
      issue: { number: 9, title: "Broken", body: "", state, html_url: `https://github.com/${REPO}/issues/9`, user: { login: "AndresL230" }, assignees: [], labels: [], updated_at: action === "opened" ? T0 : T1 },
    });
    await mirrorIssue(ctx, platformCtx(), REPO, issue("opened", "open"));
    const n = (await all<{ number: number }>(env.DB, `SELECT number FROM tickets WHERE org_id = ? AND source_ref = ?`, ORG_A, `${REPO}#9`))[0].number;
    expect(await scopes()).toEqual([`card:ticket:${n}`, "org:"]);
    await clean();
    await mirrorIssue(ctx, platformCtx(), REPO, { ...issue("closed", "closed"), issue: { ...issue("closed", "closed").issue, state_reason: "completed" } });
    expect(await scopes()).toEqual(["org:"]);
  });

  it("the gate: a feed entry, a doc proposal, an ADR draft, Unplaced; a promote; artifacts", async () => {
    const ctx = systemCtx(ORG_A);
    const f = await ingestFeedEntry(ctx, { summary: "Shipped the thing", tags: [] } as never, "AndresL230");
    expect(f.outcome).toBe("written");
    const d = await ingestDocProposal(ctx, { slug: "auth", section: "reference", body: "how auth works", change_summary: "v1", confidence: "high" } as never, "AndresL230");
    const a = await ingestAdrDraft(ctx, { title: "Use D1", context: "c", decision: "d", rationale: "r", confidence: "high" } as never, "AndresL230");
    const u = await route_triage(ctx, { raw: { x: 1 }, reason: "test" });
    expect(await scopes()).toEqual([
      `card:feed:${(f as { id: number }).id}`, `card:proposal:adr:${(a as { id: number }).id}`, `card:proposal:doc:auth:${(d as { version: number }).version}`,
      `card:unplaced:${u}`, "person:AndresL230",
    ]);
    await clean();
    await promote_doc(ctx, "auth", (d as { version: number }).version, "AndresL230");
    expect(await scopes()).toEqual(["card:tagfit:doc:auth", "doc_drift:auth"]);
    await clean();
    const page = await createPage(ctx, { title: "Plan doc", kind: "markdown", content: "one", area: "ui" }, "AndresL230");
    expect(await scopes()).toEqual([`card:tagfit:artifact:${page.slug}`, `doc_drift:artifact:${page.slug}`]);
    await clean();
    await addTextVersion(ctx, page.slug, { content: "two", summary: "second" }, "AndresL230");
    expect(await scopes()).toEqual([`card:tagfit:artifact:${page.slug}`, `doc_drift:artifact:${page.slug}`]);
    await clean();
    await addTextVersion(ctx, page.slug, { content: "two", summary: "same" }, "AndresL230"); // unchanged: no write, no mark
    expect(await scopes()).toEqual([]);
  });

  it("a handoff: its recipient, or (to anyone) the org's members, capped", async () => {
    const ctx = await tenantCtx("AndresL230");
    await createHandoff(ctx, "AndresL230", { recipient: "meilin", body: "over to you" });
    expect(await scopes()).toEqual(["person:meilin"]);
    await clean();
    await createHandoff(ctx, "AndresL230", { recipient: "anyone", body: "anyone?" });
    expect((await scopes()).length).toBe(6); // the seed org's six members (cap 20)
  });

  it("GitHub: a merged PR (the events gate) and the webhook's repo capture", async () => {
    await addOrgRepo(REPO, ORG_A);
    const ctx = systemCtx(ORG_A, "github-webhook");
    await ingestEvent(ctx, platformCtx(), { semantic_key: "gh:pr:12:merged", event_type: "pr_merged", ref_number: 12, subject_login: "Darkest-Teddy", raw: "{}", provenance: "webhook" } as never, "github-webhook");
    expect(await scopes()).toEqual(["card:pr:12", "person:Darkest-Teddy", `repo:${REPO}`, `theme_window:${REPO}`]);
    await clean();
    // A redelivery writes nothing — and marks nothing.
    await ingestEvent(ctx, platformCtx(), { semantic_key: "gh:pr:12:merged", event_type: "pr_merged", ref_number: 12, subject_login: "Darkest-Teddy", raw: "{}", provenance: "webhook" } as never, "github-webhook");
    expect(await scopes()).toEqual([]);
    const push = (after: string, ref = "refs/heads/main") => JSON.stringify({
      ref, after, before: "0".repeat(40), repository: { full_name: REPO, default_branch: "main", pushed_at: 1_760_000_000 }, sender: { login: "jose" },
      head_commit: { id: after, message: "fix it", timestamp: T0 }, commits: [{ id: after, distinct: true, message: "fix it", timestamp: T0 }],
    });
    await captureDelivery(ctx, e, { repo: REPO, githubToken: async () => null }, "push", push("a".repeat(40)));
    expect(await scopes()).toEqual([`repo:${REPO}`, `session:${REPO}:jose`]);
    await clean();
    await captureDelivery(ctx, e, { repo: REPO, githubToken: async () => null }, "push", push("b".repeat(40), "refs/heads/feat/x"));
    expect(await scopes()).toEqual([`session:${REPO}:jose`]);
  });

  it("a hosting deploy landing on an environment's branch marks the repo (and a building one nothing)", async () => {
    await addOrgRepo(REPO, ORG_A);
    await setOrgEnvironments(ENVS, ORG_A);
    await env.DB.prepare(`INSERT INTO org_environment_parts (org_id, env_key, part_key, position, label, role, provider, settings, created_at, updated_at, updated_by)
      VALUES (?, 'staging', 'web', 0, 'web', 'web', 'vercel', ?, ?, ?, 'test')`).bind(ORG_A, JSON.stringify({ project_id: "prj_abc123" }), T0, T0).run();
    const admin = await tenantCtx("AndresL230");
    await setSecret(admin, "vercel", "", LONG_TOKEN);
    await setIntegrationConfig(admin, "vercel", "", { team: "acme" });
    const [part] = await listAllParts(systemCtx(ORG_A));
    const deploy = (state: string) => ({ id: "dpl_1", state, target: "production", sha: "ABCDEF1234567", branch: "main", message: "ship", by: "jose-a",
      createdAt: "2026-10-14T10:15:00Z", readyAt: state === "ready" ? "2026-10-14T10:17:30Z" : null, url: null, inspectUrl: null });
    const provider = (state: string): HostingProvider => ({
      id: "vercel", label: "Vercel", status: "available", summary: "", roles: ["web"], apiHosts: ["api.vercel.test"], docsUrl: "", connectionMethods: [],
      orgConfigFields: [{ key: "team", label: "Team", description: "", required: false, pattern: /^[a-z-]+$/ }],
      partSettings: [{ key: "project_id", label: "Project ID", description: "", required: true, pattern: /^prj_[A-Za-z0-9]+$/ }],
      capabilities: { deploys: true, metrics: [] }, planNote: null, pollCost: 1, consoleUrl: () => null, probe: async () => ({ ok: true, detail: "" }),
      poll: async () => ({ deploys: [deploy(state)], points: [], unavailable: [], covered: null }),
    } as unknown as HostingProvider);
    const NOW = Date.parse("2026-10-14T12:40:00Z");
    await pollPart(e, systemCtx(ORG_A), part, NOW, (async () => Response.json({})) as unknown as typeof fetch, { vercel: provider("building") } as ProviderMap);
    expect(await scopes()).toEqual([]);
    await pollPart(e, systemCtx(ORG_A), part, NOW + 60_000, (async () => Response.json({})) as unknown as typeof fetch, { vercel: provider("ready") } as ProviderMap);
    expect(await scopes()).toEqual([`repo:${REPO}`]);
  });

  it("the digest pre-warm: one tick before an org's send hour, its recipients' briefs are marked URGENT", async () => {
    // SaplingLearn sends at 08:00 America/New_York (the seed): 11:50 UTC on a Wednesday is one tick before.
    await run(env.DB, `UPDATE persons SET email = handle || '@example.test'`);
    expect(await prewarmDigests(e, new Date("2026-10-14T10:50:00.000Z"))).toBe(0);
    expect(await prewarmDigests(e, new Date("2026-10-14T11:50:00.000Z"))).toBe(6);
    const r = await rows();
    expect(r.every((x) => x.scope === "person" && x.urgent === 1)).toBe(true);
    expect(r.map((x) => x.scope_key).sort()).toEqual(["AndresL230", "Darkest-Teddy", "Jose-Gael-Cruz-Lopez", "lpcooper-arch", "meilin", "sanaok"]);
  });

  it("a mark that FAILS never fails the write that called it", async () => {
    await run(env.DB, `ALTER TABLE ai_dirty RENAME TO ai_dirty_away`);
    try {
      const n = await create_ticket(systemCtx(ORG_A), { title: "Still created", body: "", category: "other", priority: "normal", assignees: [] }, "AndresL230");
      expect(n).toBeGreaterThan(0);
      await routeAi(systemCtx(ORG_A), { type: "ticket_created", number: n }); // and routeAi itself never throws
    } finally {
      await run(env.DB, `ALTER TABLE ai_dirty_away RENAME TO ai_dirty`);
    }
  });
});

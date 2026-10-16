// REPO STATE (src/ai/repo-state.ts, src/tools/repo-state.ts; docs/architecture/ai.md › Repo state): the `repo` scope
// becomes a new `repo_state` version — incrementally, from the previous one plus merged PR cards, digests, the
// default branches' runs and every environment part's hosting status and deploys — past `gate.state`; Repo ›
// Overview and `get_repo_dashboard` read the newest. Providers stubbed at the `Response` level and counted.
// The guards: the gate and its plain rule, cite validation, refusal / max_tokens, keep-20, the switch, absent when
// none, capped, "Wrong?".
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { runAiPass, type AiPassResult } from "../src/ai/pass";
import { checkState, repoStateJob, statePrompt, stateInput, stateFallback, type StateInput } from "../src/ai/repo-state";
import { appendRepoState, readRepoState, REPO_STATE_KEEP } from "../src/tools/repo-state";
import { getRepoDashboardForAgent } from "../src/tools/repo-agent";
import { newBudget, CRON_SUBREQUEST_BUDGET } from "../src/repo/dispatch";
import { captureDelivery } from "../src/webhook";
import { recordFeedback } from "../src/data/ai";
import { all, first, run } from "./helpers/db";
import { ORG_A, systemCtx, tenantCtx } from "./helpers/tenant";
import { addOrgRepo, setOrgEnvironments } from "./helpers/org-config";
import { ENVS } from "./helpers/repo";
import { addPart, deployRow, pollState } from "./helpers/dashboard-hosting";
import { dirtyRow, keyedEnv, markRow, stubProviders, type ClaudeReply, type Stub } from "./helpers/ai-pass";
import { useAiKey } from "./helpers/ai-key";

// THE read rule (src/plans/gate.ts `aiShown`): no Anthropic key reads like the switch off, so these tests hold a fake one.
useAiKey();

const e = env as unknown as Env;
const REPO = "SaplingLearn/sapling";
const MIN = 60_000;
const later = (ms: number) => new Date(Date.now() + ms);
const pass = (s: Stub, now: Date, o: { env?: Env } = {}): Promise<AiPassResult> =>
  runAiPass(o.env ?? keyedEnv(), newBudget(s.fetchImpl, CRON_SUBREQUEST_BUDGET), { jobs: [repoStateJob], now });
const deliver = (event: string, payload: unknown) =>
  captureDelivery(systemCtx(ORG_A, "github-webhook"), e, { repo: REPO, githubToken: async () => null }, event, JSON.stringify(payload), { summarizer: null, issueSummarizer: null });
const merge = (n: number, title = `PR ${n}`) => ({
  action: "closed", repository: { full_name: REPO, default_branch: "main" },
  pull_request: { number: n, title, body: "SECRET BODY", html_url: `https://github.com/${REPO}/pull/${n}`, state: "closed", merged: true,
    merged_at: "2026-10-14T10:30:00Z", closed_at: "2026-10-14T10:30:00Z", updated_at: "2026-10-14T10:30:00Z", user: { login: "AndresL230" },
    head: { ref: "feat/x", sha: "f".repeat(40) }, base: { ref: "main" }, milestone: null },
});
/** The summary seam's card for a merged PR (what the webhook writes with a summarizer). */
async function card(n: number, what: string): Promise<void> {
  const ev = await first<{ semantic_key: string }>(env.DB, `SELECT semantic_key FROM events WHERE org_id = ? AND ref_number = ? AND event_type = 'pr_merged'`, ORG_A, n);
  await run(env.DB, `INSERT OR REPLACE INTO pr_summaries (org_id, repo, semantic_key, pr_number, model, created_at, title, what, why, impact) VALUES (?, ?, ?, ?, 'claude-haiku-5-5', ?, ?, ?, 'Because.', 'Everyone.')`,
    ORG_A, REPO, ev!.semantic_key, n, new Date().toISOString(), `Card title ${n}`, what);
}
const stale = () => markRow(ORG_A, "repo", REPO, new Date(Date.now() - 2 * 3600_000).toISOString());

/** A state citing what the input offers: every ref of the given kinds found in the prompt. */
const stateReply = (o: { headline?: string | null; extra?: string[]; only?: string[] } = {}): ClaudeReply => (body) => {
  const input = body.messages[0].content.at(-1)!.text;
  const refs = [...new Set([...input.matchAll(/\b((?:pr|run|feed):\d+|deploy:[a-z0-9_-]+\/[a-z0-9_-]+)/g)].map((m) => m[1]))];
  const pr = refs.filter((r) => r.startsWith("pr:"));
  const dep = refs.filter((r) => r.startsWith("deploy:"));
  return JSON.stringify({
    headline: o.headline === undefined ? "Hosting landed; production is deploying." : o.headline,
    shipped: pr.length ? [{ text: "Hosting screens shipped.", cites: o.only ?? [...pr.slice(0, 1), ...(o.extra ?? [])] }] : [],
    in_flight: [],
    attention: dep.length ? [{ text: "A production deploy failed.", cites: o.only ?? dep.slice(0, 1) }] : [],
  });
};
const versions = () => all<{ version: number; event_count: number | null; model: string }>(env.DB, `SELECT version, event_count, model FROM repo_state WHERE org_id = ? AND repo = ? ORDER BY version`, ORG_A, REPO);

describe("THE GATE: gate.state before any state call", () => {
  it("a merged PR and a failed deploy, past the gate: ONE call, a version the screen and MCP read, cites resolved by the server", async () => {
    await addOrgRepo(REPO, ORG_A);
    await setOrgEnvironments(ENVS);
    await deliver("pull_request", merge(77, "Hosting screens"));
    await card(77, "Adds the Vercel and Netlify connect screens.");
    await addPart(ORG_A, "production", "web", "vercel", "web");
    await deployRow(ORG_A, "production", "web", "vercel", "dpl_1", "error", new Date().toISOString(), { branch: "production" });
    await pollState(ORG_A, "production", "web", "vercel", Date.now(), { status: "failed" });
    expect(await dirtyRow(ORG_A, "repo", REPO)).not.toBeNull(); // the merge marked it (the router)
    const s = stubProviders({ jev: () => 0.9, claude: stateReply() });
    await pass(s, later(30 * MIN)); // SaplingLearn is Enterprise: 60 minutes
    expect(s.jev + s.haiku).toBe(0);
    await pass(s, later(61 * MIN));
    expect([s.jev, s.haiku]).toEqual([1, 1]);
    const sent = (s.haikuBodies[0] as { messages: { content: { text: string }[] }[] }).messages[0].content.at(-1)!.text;
    expect(sent).toContain("- pr:77 Card title 77\n  what: Adds the Vercel and Netlify connect screens.");
    expect(sent).toContain("- deploy:production/web production web label: error from production");
    // (b) A part is named by its label, never the provider id (#186).
    expect(sent).toContain("- deploy:production/web production web label: last deploy error, last read failed");
    expect(sent).not.toMatch(/\bon vercel\b/); // the provider id is never how a part is named (the PR card may say "Vercel")
    expect(sent).not.toContain("SECRET BODY");
    expect(await versions()).toEqual([{ version: 1, event_count: 2, model: "claude-haiku-5-5" }]);
    expect(await dirtyRow(ORG_A, "repo", REPO)).toMatchObject({ attempts: 0, last_error: null });

    const st = await readRepoState(systemCtx(), REPO);
    expect(st).toMatchObject({
      state: "ready", model: "claude-haiku-5-5", resumesOn: null, upgrade: false, eventCount: 2,
      headline: "Hosting landed; production is deploying.",
      shipped: [{ text: "Hosting screens shipped.", cites: [{ ref: "pr:77", label: "#77", href: `https://github.com/${REPO}/pull/77` }] }],
      inFlight: [],
      attention: [{ text: "A production deploy failed.", cites: [{ ref: "deploy:production/web", label: "production web label", href: "https://x.example/i" }] }],
    });
    // get_repo_dashboard: with the overview tab (or none), never with another tab.
    expect((await getRepoDashboardForAgent(systemCtx(), REPO, ENVS, { tab: "overview" })).state).toEqual(st);
    expect((await getRepoDashboardForAgent(systemCtx(), REPO, ENVS, { tab: "usage" })).state).toBeUndefined();
  });

  it("below 0.5: no state call, nothing written, the scope clean", async () => {
    await stale();
    const s = stubProviders({ jev: () => 0.1, claude: stateReply() });
    await pass(s, later(0));
    expect([s.jev, s.haiku]).toEqual([1, 0]);
    expect(await versions()).toEqual([]);
    expect(await dirtyRow(ORG_A, "repo", REPO)).toMatchObject({ attempts: 0, last_error: null });
  });

  it("without Jev the plain rule decides: nothing merged, deployed or red is skipped; a merged PR is written", async () => {
    await addOrgRepo(REPO, ORG_A);
    const noJev = keyedEnv({ TYPESAFE_API_KEY: undefined });
    await stale();
    const s = stubProviders({ claude: stateReply() });
    await pass(s, later(0), { env: noJev });
    expect([s.jev, s.haiku]).toEqual([0, 0]);
    await deliver("pull_request", merge(78));
    await run(env.DB, `UPDATE ai_dirty SET last_run_at = NULL, dirty_since = ? WHERE org_id = ? AND scope = 'repo'`, new Date(Date.now() - 2 * 3600_000).toISOString(), ORG_A);
    await pass(s, later(0), { env: noJev });
    expect([s.jev, s.haiku]).toEqual([0, 1]);
    expect(await versions()).toHaveLength(1);
    // The rule itself.
    const inp = (o: Partial<StateInput>) => ({ merged: [], deploys: [], redMain: false, ...o }) as unknown as StateInput;
    expect([stateFallback(inp({})), stateFallback(inp({ merged: [{} as never] })), stateFallback(inp({ deploys: [{} as never] })), stateFallback(inp({ redMain: true }))])
      .toEqual([false, true, true, true]);
  });
});

describe("INCREMENTAL, and keep 20", () => {
  it("the next run reads the previous version's lines and only what happened after it", async () => {
    await addOrgRepo(REPO, ORG_A);
    await deliver("pull_request", merge(80, "First change"));
    await stale();
    const s = stubProviders({ jev: () => 0.9, claude: stateReply() });
    await pass(s, later(0));
    await deliver("pull_request", merge(81, "Second change"));
    await run(env.DB, `UPDATE ai_dirty SET last_run_at = NULL, dirty_since = ? WHERE org_id = ? AND scope = 'repo'`, new Date(Date.now() - 2 * 3600_000).toISOString(), ORG_A);
    await pass(s, later(0));
    expect(s.haiku).toBe(2);
    const second = (s.haikuBodies[1] as { messages: { content: { text: string }[] }[] }).messages[0].content.at(-1)!.text;
    expect(second).toContain("<previous>");
    expect(second).toContain("- Hosting screens shipped. [pr:80]");
    expect(second).toContain("- pr:81 Second change");
    expect(second).not.toContain("- pr:80 First change"); // read before: it is the previous state's now
    expect((await versions()).map((v) => v.version)).toEqual([1, 2]);
  });

  it(`appends and keeps the last ${REPO_STATE_KEEP} versions`, async () => {
    const st = { headline: "h", shipped: [], inFlight: [], attention: [] };
    for (let i = 0; i < 25; i++) await appendRepoState(systemCtx(), REPO, { state: st, basisUntil: "2026-10-15T00:00:00Z", model: "m", promptVersion: "p", eventCount: i, at: "2026-10-15T00:00:00Z" });
    const v = (await versions()).map((x) => x.version);
    expect(v).toHaveLength(REPO_STATE_KEEP);
    expect([v[0], v.at(-1)]).toEqual([6, 25]);
  });
});

describe("NEVER GUESS", () => {
  const input = (): StateInput => ({
    repo: REPO, readAt: "2026-10-15T12:00:00Z", since: "2026-10-15T00:00:00Z", previous: null,
    merged: [{ ref: "pr:5", title: "Retry indexing 3 times", what: null, why: null, impact: null }], digests: [], openPrs: [], failedRuns: [], parts: [], deploys: [],
    cites: { "pr:5": { ref: "pr:5", label: "#5", href: "https://github.com/x/y/pull/5" } }, eventCount: 1, redMain: false,
  });
  it("a line whose cites are all invented is dropped; one with an invented number is dropped; at most 5 per list", () => {
    const line = (text: string, cites: string[]) => ({ text, cites });
    const c = checkState({
      headline: "Indexing retries landed.",
      shipped: [line("Retries ship.", ["pr:5", "pr:999"]), line("Mystery work.", ["pr:999"]), line("Retries 3 times.", ["pr:5"]), line("40% faster.", ["pr:5"]),
        ...Array.from({ length: 5 }, () => line("Retries.", ["pr:5"]))],
      in_flight: [], attention: [],
    }, input());
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.state.shipped).toHaveLength(5);
    expect(c.state.shipped[0]).toEqual({ text: "Retries ship.", cites: [{ ref: "pr:5", label: "#5", href: "https://github.com/x/y/pull/5" }] });
    expect(c.state.shipped.map((l) => l.text)).not.toContain("Mystery work.");
    expect(c.state.shipped.map((l) => l.text)).not.toContain("40% faster.");
    expect(c.state.shipped.map((l) => l.text)).toContain("Retries 3 times.");
    // No headline and no valid line: nothing to write.
    expect(checkState({ headline: "", shipped: [line("x", ["pr:9"])], in_flight: [], attention: [] }, input())).toEqual({ ok: false, reason: "empty" });
    expect(statePrompt(input())).toContain("No previous picture.");
  });

  it("all cites invented and no headline: nothing written, the scope fails", async () => {
    await addOrgRepo(REPO, ORG_A);
    await deliver("pull_request", merge(90));
    await stale();
    const s = stubProviders({ jev: () => 0.9, claude: stateReply({ headline: null, only: ["pr:999"] }) });
    await pass(s, later(0));
    expect(s.haiku).toBe(1);
    expect(await versions()).toEqual([]);
    expect(await dirtyRow(ORG_A, "repo", REPO)).toMatchObject({ attempts: 1, last_error: "not_written" });
  });

  for (const stop of ["refusal", "max_tokens"] as const) {
    it(`a ${stop} writes nothing`, async () => {
      await addOrgRepo(REPO, ORG_A);
      await deliver("pull_request", merge(91));
      await stale();
      const s = stubProviders({ jev: () => 0.9, claude: () => ({ stop, text: JSON.stringify({ headline: "x", shipped: [], in_flight: [], attention: [] }) }) });
      await pass(s, later(0));
      expect(await versions()).toEqual([]);
      expect(await dirtyRow(ORG_A, "repo", REPO)).toMatchObject({ attempts: 1, last_error: "no_answer" });
    });
  }
});

describe("THE READ: absent unless there is a state to show", () => {
  const write = () => appendRepoState(systemCtx(), REPO, {
    state: { headline: "All green.", shipped: [{ text: "Shipped.", cites: [{ ref: "pr:1", label: "#1", href: null }] }], inFlight: [], attention: [] },
    basisUntil: "2026-10-15T00:00:00Z", model: "claude-haiku-5-5", promptVersion: "state-1", eventCount: 3, at: "2026-10-15T01:00:00Z",
  });

  it("none written → absent (the screen renders nothing, MCP carries nothing)", async () => {
    expect(await readRepoState(systemCtx(), REPO)).toBeUndefined();
    expect(await readRepoState(systemCtx(), "")).toBeUndefined();
    await addOrgRepo(REPO, ORG_A);
    expect("state" in (await getRepoDashboardForAgent(systemCtx(), REPO, []))).toBe(false);
  });

  it("the switch off → absent, though a version exists; on again → it is back", async () => {
    await write();
    await run(env.DB, `UPDATE orgs SET ai_automation = 0 WHERE id = ?`, ORG_A);
    expect(await readRepoState(systemCtx(), REPO)).toBeUndefined();
    await run(env.DB, `UPDATE orgs SET ai_automation = 1 WHERE id = ?`, ORG_A);
    expect(await readRepoState(systemCtx(), REPO)).toMatchObject({ state: "ready", eventCount: 3, headline: "All green." });
  });

  it("an old state STAYS and says its age plainly (Q25): `ageDays`, the server's whole days since it was written", async () => {
    await write(); // written 2026-10-15T01:00Z
    expect(await readRepoState(systemCtx(), REPO, { now: new Date("2026-10-15T20:00:00Z") })).toMatchObject({ state: "ready", ageDays: 0 });
    expect(await readRepoState(systemCtx(), REPO, { now: new Date("2026-10-24T02:00:00Z") })).toMatchObject({ state: "ready", ageDays: 9, headline: "All green." });
    expect(await readRepoState(systemCtx(), REPO, { now: new Date("2026-11-14T02:00:00Z") })).toMatchObject({ ageDays: 30 });
  });

  it("the month's runs spent → capped, with the last state, when it resumes, and Upgrade on Free", async () => {
    await write();
    await run(env.DB, `UPDATE orgs SET plan = 'free' WHERE id = ?`, ORG_A);
    await run(env.DB, `INSERT INTO org_usage_daily (org_id, day, actor, metric, count, last_at) VALUES (?, ?, 'ai-pass', 'ai_run:repo.state', 250, ?)`, ORG_A, new Date().toISOString().slice(0, 10), new Date().toISOString());
    expect(await readRepoState(systemCtx(), REPO)).toMatchObject({ state: "capped", upgrade: true, headline: "All green." });
  });

  it("\"Wrong?\" hides that version for the person who pressed it, and only them", async () => {
    await write();
    await recordFeedback(systemCtx(), "meilin", { itemType: "repo_state", itemRef: `${REPO}@2026-10-15T01:00:00Z`, kind: "repo_state", model: "claude-haiku-5-5", promptVersion: null });
    expect(await readRepoState(systemCtx(), REPO, { viewer: "meilin" })).toBeUndefined();
    expect(await readRepoState(systemCtx(), REPO, { viewer: "sanaok" })).toMatchObject({ state: "ready" });
    expect((await getRepoDashboardForAgent(await tenantCtx("meilin"), REPO, [])).state).toBeUndefined();
  });

  it("a deploy of a part no longer configured is left out — no cite named by a bare key or a provider (Q62)", async () => {
    await setOrgEnvironments(ENVS);
    await addPart(ORG_A, "staging", "api", "railway", "service");
    await deployRow(ORG_A, "production", "gone", "vercel", "dpl_9", "ready", new Date().toISOString(), { branch: "main" });
    const inp = await stateInput(systemCtx(), { scope: "repo", key: REPO, dirtySince: new Date(Date.now() - 60_000).toISOString(), markedAt: new Date().toISOString(), attempts: 0, urgent: false });
    expect(inp!.deploys).toEqual([]);
    expect(Object.keys(inp!.cites).filter((r) => r.startsWith("deploy:"))).toEqual(["deploy:staging/api"]);
    expect(Object.values(inp!.cites).map((c) => c.label)).not.toContain("production gone");
  });

  it("the input reads hosting for every part, from D1 only", async () => {
    await setOrgEnvironments(ENVS);
    await addPart(ORG_A, "staging", "api", "railway", "service");
    const inp = await stateInput(systemCtx(), { scope: "repo", key: REPO, dirtySince: new Date().toISOString(), markedAt: new Date().toISOString(), attempts: 0, urgent: false });
    expect(inp!.parts).toEqual([{ ref: "deploy:staging/api", label: "staging api label", provider: "railway", latest: null, poll: null }]);
    expect(inp!.previous).toBeNull();
  });
});

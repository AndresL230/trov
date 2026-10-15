// SESSION DIGESTS (src/ai/digests.ts; docs/architecture/ai.md › Session digests): a burst of one person's pushes
// and PRs, captured by the REAL webhook path, becomes ONE `Shipped:` / `Status:` feed entry written by Trov through
// the gate — or nothing. Both providers stubbed at the `Response` level and counted; real D1 rows asserted.
// The guards: the gate (Jev, and its plain rule without Jev), dedupe with ZERO model calls, cite validation,
// refusal / max_tokens writing nothing, the gate path (`ingestFeedEntry`, its ledger and its router mark), the
// `trov` author exception, and the feed's `ai` field built by the server.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { runAiPass, type AiPassResult } from "../src/ai/pass";
import { checkDigest, digestPrompt, sessionDigestJob, sessionFallback, type SessionInput } from "../src/ai/digests";
import { newBudget, CRON_SUBREQUEST_BUDGET } from "../src/repo/dispatch";
import { captureDelivery } from "../src/webhook";
import { ingestFeedEntry } from "../src/consumer";
import { get_feed } from "../src/tools/reads";
import { all, first, run } from "./helpers/db";
import { ORG_A, systemCtx } from "./helpers/tenant";
import { addOrgRepo } from "./helpers/org-config";
import { dirtyRow, keyedEnv, stubProviders, type ClaudeReply, type Stub } from "./helpers/ai-pass";

const e = env as unknown as Env;
const REPO = "SaplingLearn/sapling";
const JOSE = "Jose-Gael-Cruz-Lopez";
const MIN = 60_000;
const later = (ms: number) => new Date(Date.now() + ms);
const pass = (s: Stub, now: Date, o: { env?: Env } = {}): Promise<AiPassResult> =>
  runAiPass(o.env ?? keyedEnv(), newBudget(s.fetchImpl, CRON_SUBREQUEST_BUDGET), { jobs: [sessionDigestJob], now });
const count = async (sql: string, ...p: unknown[]) => (await first<{ n: number }>(env.DB, sql, ...p))!.n;

const deliver = (event: string, payload: unknown) =>
  captureDelivery(systemCtx(ORG_A, "github-webhook"), e, { repo: REPO, githubToken: async () => null }, event, JSON.stringify(payload), { summarizer: null, issueSummarizer: null });
/** A hex sha for commit `i`.`k`. */
const sha = (i: number, k = 0) => `${(i * 16 + k).toString(16).padStart(4, "0")}abc${"0".repeat(33)}`;
const push = (i: number, o: { ref?: string; actor?: string; subjects?: string[] } = {}) => {
  const subjects = o.subjects ?? [`Add the thing ${i}`];
  return {
    ref: `refs/heads/${o.ref ?? "feat/hosting"}`, after: sha(i, 15), before: "0".repeat(40), compare: "https://github.com/x",
    repository: { full_name: REPO, default_branch: "main", pushed_at: 1_760_000_000 + i }, sender: { login: o.actor ?? JOSE },
    head_commit: { id: sha(i, subjects.length - 1), message: subjects.at(-1), timestamp: "2026-10-14T10:00:00Z" },
    commits: subjects.map((m, k) => ({ id: sha(i, k), distinct: true, message: m, timestamp: "2026-10-14T10:00:00Z" })),
  };
};
const openPr = (n: number, actor = JOSE) => ({
  action: "opened", repository: { full_name: REPO, default_branch: "main" },
  pull_request: { number: n, title: `Hosting screens for Vercel`, body: "SECRET BODY never sent", html_url: `https://github.com/${REPO}/pull/${n}`, state: "open", merged: false, draft: false,
    updated_at: "2026-10-14T10:20:00Z", user: { login: actor }, head: { ref: "feat/hosting", sha: sha(9) }, base: { ref: "main" } },
});
const short = (i: number, k = 0) => sha(i, k).slice(0, 7);

/** A Haiku answer: a valid digest citing what the stub is told to (default: every sha in the request's input). */
const digestReply = (o: { type?: "Shipped" | "Status"; cites?: (input: string) => string[]; brief?: string; summary?: string } = {}): ClaudeReply => (body) => {
  const input = body.messages[0].content.at(-1)!.text;
  const shas = [...input.matchAll(/sha:([0-9a-f]{7})/g)].map((m) => `sha:${m[1]}`);
  const type = o.type ?? "Status";
  return JSON.stringify({
    type, summary: o.summary ?? `${type}: hosting screens are partway`, brief: o.brief ?? "Teams can see where their hosting setup stands before it ships.",
    what: "The Vercel connect screen is drafted.", why: null, impact: null, follow_up: null,
    state: "Drafted on a branch.", blocked_on: null, next: null, tags: ["ui", "not-a-tag"],
    cites: o.cites ? o.cites(input) : shas,
  });
};

const feedRows = () => all<{ id: number; author: string; origin: string; model: string | null; subject: string | null; summary: string; artifacts: string; body: string }>(env.DB,
  `SELECT id, author, origin, model, subject, summary, artifacts, body FROM feed WHERE org_id = ? ORDER BY id`, ORG_A);
const sessions = () => all<{ status: string; reason: string | null; feed_id: number | null; shas: string }>(env.DB,
  `SELECT status, reason, feed_id, shas FROM ai_sessions WHERE org_id = ? ORDER BY started_at`, ORG_A);
const KEY = `${REPO}:${JOSE}`;
/** The pass runs at a FUTURE clock (the debounce), but the webhook marks at the real one: move the runs back. */
const rewind = () => run(env.DB, `UPDATE ai_dirty SET last_run_at = ? WHERE last_run_at IS NOT NULL`, new Date(Date.now() - 1000).toISOString());

describe("THE GATE: gate.session before any digest", () => {
  it("a substantive burst: one Jev request, one Haiku call, one entry by `trov` for its subject, through the gate", async () => {
    await addOrgRepo(REPO, ORG_A);
    await deliver("push", push(1, { subjects: ["Draft the Vercel connect screen", "Wire the Netlify connect test"] }));
    await deliver("pull_request", openPr(41));
    const s = stubProviders({ jev: () => 0.9, claude: digestReply() });
    await pass(s, later(30 * MIN)); // the session is still open
    expect(s.jev + s.haiku).toBe(0);
    await pass(s, later(46 * MIN));
    expect([s.jev, s.haiku]).toEqual([1, 1]);
    // What Jev read: subjects and titles only. What Haiku read: never the PR's body.
    const sent = JSON.stringify(s.haikuBodies[0]);
    expect(sent).not.toContain("SECRET BODY");
    expect(sent).toContain("pr:41 (open) Hosting screens for Vercel");

    const [row] = (await feedRows()).filter((r) => r.origin === "ai");
    expect(row).toMatchObject({ author: "trov", origin: "ai", model: "claude-haiku-5-5", subject: JOSE, summary: "Status: hosting screens are partway" });
    expect(JSON.parse(row.artifacts)).toEqual({ prs: [], commits: [short(1, 1), short(1, 0)], issues: [] });
    expect(row.body).toContain("**State** Drafted on a branch.");
    expect(row.body).toContain("Written by Trov from 2 commits in SaplingLearn/sapling");
    // The org's own tag is kept; a tag not on its list is DROPPED — Trov never sends a suggestion to the admins.
    expect(await all(env.DB, `SELECT tag FROM entry_tags WHERE org_id = ? AND entry_id = ?`, ORG_A, String(row.id))).toEqual([{ tag: "ui" }]);
    expect(await count(`SELECT COUNT(*) AS n FROM org_tag_suggestions WHERE org_id = ?`, ORG_A)).toBe(0);
    // THE GATE PATH: the ledger row `ingestFeedEntry` writes, and the router's marks for the entry and its SUBJECT.
    expect(await first(env.DB, `SELECT item_type, outcome, ref FROM processed_items WHERE org_id = ? AND session_id LIKE 'ai:session:%'`, ORG_A))
      .toEqual({ item_type: "feed", outcome: "written", ref: String(row.id) });
    expect(await dirtyRow(ORG_A, "card", `feed:${row.id}`)).not.toBeNull();
    expect(await dirtyRow(ORG_A, "person", JOSE)).not.toBeNull();
    expect(await dirtyRow(ORG_A, "person", "trov")).toBeNull();
    expect(await sessions()).toEqual([{ status: "done", reason: null, feed_id: row.id, shas: JSON.stringify([short(1, 1), short(1, 0)]) }]);
    // Metered as one Haiku run of its own kind and one Jev check.
    expect(await count(`SELECT COALESCE(SUM(count), 0) AS n FROM org_usage_daily WHERE org_id = ? AND metric = 'ai_run:digest.session'`, ORG_A)).toBe(1);
    expect(await count(`SELECT COALESCE(SUM(count), 0) AS n FROM org_usage_daily WHERE org_id = ? AND metric = 'ai_suggest'`, ORG_A)).toBe(1);

    // The feed's `ai`: built by the server from the entry's artifacts, linked to the digest's repository.
    const feed = await get_feed(systemCtx(), {});
    const mine = feed.find((f) => f.id === row.id)!;
    expect(mine.ai).toEqual({
      origin: "ai", subject: JOSE, moreCount: 0, generatedAt: mine.created_at, model: "claude-haiku-5-5",
      sources: [
        { ref: `sha:${short(1, 1)}`, label: short(1, 1), href: `https://github.com/${REPO}/commit/${short(1, 1)}` },
        { ref: `sha:${short(1, 0)}`, label: short(1, 0), href: `https://github.com/${REPO}/commit/${short(1, 0)}` },
      ],
    });
    expect(mine).not.toHaveProperty("origin");
    expect(feed.filter((f) => f.id !== row.id).every((f) => f.ai === undefined)).toBe(true);
  });

  it("below 0.5: no digest, the session is `skipped` (not_substantive), the scope clean — one Jev call, no Haiku", async () => {
    await deliver("push", push(2, { subjects: ["typo", "fmt", "wip"] }));
    const s = stubProviders({ jev: () => 0.2, claude: digestReply() });
    await pass(s, later(46 * MIN));
    expect([s.jev, s.haiku]).toEqual([1, 0]);
    expect((await feedRows()).filter((r) => r.origin === "ai")).toEqual([]);
    expect(await sessions()).toMatchObject([{ status: "skipped", reason: "not_substantive", feed_id: null }]);
    expect(await dirtyRow(ORG_A, "session", KEY)).toMatchObject({ attempts: 0, last_error: null });
  });

  it("without Jev the plain rule decides: 2 commits and no PR is skipped; 3 commits, or a PR, is digested", async () => {
    const noJev = keyedEnv({ TYPESAFE_API_KEY: undefined });
    await deliver("push", push(3, { subjects: ["one", "two"] }));
    const s = stubProviders({ claude: digestReply() });
    await pass(s, later(46 * MIN), { env: noJev });
    expect([s.jev, s.haiku]).toEqual([0, 0]);
    expect(await sessions()).toMatchObject([{ status: "skipped", reason: "not_substantive" }]);
    await deliver("push", push(4, { subjects: ["one", "two", "three"], actor: "AndresL230" }));
    await pass(s, later(46 * MIN), { env: noJev });
    expect([s.jev, s.haiku]).toEqual([0, 1]);
    expect((await feedRows()).filter((r) => r.origin === "ai")).toHaveLength(1);
    // The rule itself.
    const burst = (commits: number, prs: number) => ({ commits: Array.from({ length: commits }, () => ({})), prs: Array.from({ length: prs }, () => ({})) }) as unknown as SessionInput;
    expect([sessionFallback(burst(2, 0)), sessionFallback(burst(3, 0)), sessionFallback(burst(0, 1))]).toEqual([false, true, true]);
  });

  it("a second burst reads only what came after the first one's digest", async () => {
    await deliver("push", push(5, { subjects: ["First burst work"] }));
    const s = stubProviders({ jev: () => 0.9, claude: digestReply() });
    await pass(s, later(46 * MIN));
    await rewind(); // the pass ran at a future clock; put its run in the past so the next mark makes it dirty again
    await deliver("push", push(6, { subjects: ["Second burst work"] }));
    await pass(s, later(46 * MIN));
    expect(s.haiku).toBe(2);
    const second = (s.haikuBodies[1] as { messages: { content: { text: string }[] }[] }).messages[0].content.at(-1)!.text;
    expect(second).toContain("Second burst work");
    expect(second).not.toContain("First burst work");
    expect(await sessions()).toHaveLength(2);
  });
});

describe("DEDUPE: an agent's record of the work skips the digest with ZERO model calls", () => {
  it("an agent entry citing one of the burst's commits (any sha length) covers it: no Jev, no Haiku, `skipped` agent_recorded", async () => {
    await deliver("push", push(7, { subjects: ["Ship the hosting screens", "Fix the Netlify test", "Docs"] }));
    await ingestFeedEntry(systemCtx(), { summary: "Shipped: hosting screens", body: "", tags: [], artifacts: { prs: [], commits: [sha(7, 1)], issues: [] } }, "AndresL230");
    const s = stubProviders({ jev: () => 0.9, claude: digestReply() });
    await pass(s, later(46 * MIN));
    expect(s.jev + s.haiku + s.other).toBe(0);
    expect(await sessions()).toMatchObject([{ status: "skipped", reason: "agent_recorded" }]);
    expect((await feedRows()).filter((r) => r.origin === "ai")).toEqual([]);
    expect(await dirtyRow(ORG_A, "session", KEY)).toMatchObject({ attempts: 0 }); // written as it is: clean
  });

  it("an agent PR citation covers it too; a Decision / Finding / Incident citing the same commits does NOT (it is not a record of what shipped)", async () => {
    await deliver("pull_request", openPr(52));
    await ingestFeedEntry(systemCtx(), { summary: "Status: hosting", body: "", tags: [], artifacts: { prs: ["#52"], commits: [], issues: [] } }, "AndresL230");
    const s = stubProviders({ jev: () => 0.9, claude: digestReply() });
    await pass(s, later(46 * MIN));
    expect(s.jev + s.haiku).toBe(0);

    await deliver("push", push(8, { subjects: ["Pick Railway for the API"], actor: "lpcooper-arch" }));
    await ingestFeedEntry(systemCtx(), { summary: "Decision: Railway hosts the API", body: "", tags: [], artifacts: { prs: [], commits: [sha(8)], issues: [] } }, "AndresL230");
    await pass(s, later(46 * MIN));
    expect([s.jev, s.haiku]).toEqual([1, 1]);
  });
});

describe("NEVER GUESS: cites, refusals and the digest's own rules", () => {
  it("a cite not in the input is dropped; the entry keeps the valid ones", async () => {
    await deliver("push", push(10, { subjects: ["Real work"] }));
    const s = stubProviders({ jev: () => 0.9, claude: digestReply({ cites: (inp) => [`sha:${/sha:([0-9a-f]{7})/.exec(inp)![1]}`, "sha:deadbee", "pr:999"] }) });
    await pass(s, later(46 * MIN));
    const [row] = (await feedRows()).filter((r) => r.origin === "ai");
    expect(JSON.parse(row.artifacts)).toEqual({ prs: [], commits: [short(10)], issues: [] });
  });

  it("ALL cites invented: nothing is written, the scope fails (attempts + 1)", async () => {
    await deliver("push", push(11, { subjects: ["Real work", "More", "And more"] }));
    const s = stubProviders({ jev: () => 0.9, claude: digestReply({ cites: () => ["sha:deadbee", "pr:999"] }) });
    await pass(s, later(46 * MIN));
    expect(s.haiku).toBe(1);
    expect((await feedRows()).filter((r) => r.origin === "ai")).toEqual([]);
    expect(await sessions()).toEqual([]);
    expect(await dirtyRow(ORG_A, "session", KEY)).toMatchObject({ attempts: 1, last_error: "not_written" });
  });

  for (const stop of ["refusal", "max_tokens"] as const) {
    it(`a ${stop} writes nothing and fails the scope`, async () => {
      await deliver("push", push(12, { subjects: ["Real work", "More", "And more"] }));
      const s = stubProviders({ jev: () => 0.9, claude: () => ({ stop, text: digestReply()({ system: [], messages: [{ content: [{ text: "sha:abcdef1" }] }] }) as string }) });
      await pass(s, later(46 * MIN));
      expect(s.haiku).toBe(1);
      expect((await feedRows()).filter((r) => r.origin === "ai")).toEqual([]);
      expect(await dirtyRow(ORG_A, "session", KEY)).toMatchObject({ attempts: 1, last_error: "no_answer" });
    });
  }

  it("checkDigest: Shipped only when something shipped, the prefix, a brief with no refs, no invented number", () => {
    const input: SessionInput = {
      repo: REPO, login: JOSE, subject: JOSE, startedAt: "2026-10-14T10:00:00Z", endedAt: "2026-10-14T10:30:00Z", shipped: false,
      commits: [{ sha: "abc1234", subject: "Retry indexing 3 times", branch: "feat/x" }], prs: [{ number: 7, title: "Indexing", state: "open", card: null }],
    };
    const ok = { type: "Status", summary: "Status: indexing retries are drafted", brief: "Uploads that fail to index will retry on their own.", what: "Retries 3 times.", tags: [], cites: ["sha:abc1234", "pr:7"] };
    expect(checkDigest(ok, input)).toMatchObject({ ok: true, cites: { prs: [7], shas: ["abc1234"] } });
    expect(checkDigest({ ...ok, type: "Shipped", summary: "Shipped: indexing retries" }, input)).toEqual({ ok: false, reason: "type" });
    expect(checkDigest({ ...ok, type: "Shipped", summary: "Shipped: indexing retries" }, { ...input, shipped: true })).toMatchObject({ ok: true, type: "Shipped" });
    expect(checkDigest({ ...ok, summary: "Indexing retries" }, input)).toEqual({ ok: false, reason: "prefix" });
    expect(checkDigest({ ...ok, summary: `Status: ${"x".repeat(100)}` }, input)).toEqual({ ok: false, reason: "prefix" }); // over 100: discarded, never cut
    expect(checkDigest({ ...ok, brief: "Fixed in #7." }, input)).toEqual({ ok: false, reason: "brief_refs" });
    expect(checkDigest({ ...ok, brief: "Fixed in abc1234." }, input)).toEqual({ ok: false, reason: "brief_refs" });
    expect(checkDigest({ ...ok, brief: "Uploads defaced by errors now retry." }, input)).toMatchObject({ ok: true }); // a hex-looking WORD is not a sha
    expect(checkDigest({ ...ok, summary: "Status: indexing is 40% faster" }, input)).toEqual({ ok: false, reason: "invented_number" });
    // A number in an optional field that the input lacks drops that field only; one the input has stays.
    const d = checkDigest({ ...ok, state: "Retries 3 times.", next: "Ship by day 12." }, input);
    expect(d.ok && d.body).toContain("**State** Retries 3 times.");
    expect(d.ok && d.body).not.toContain("day 12");
    expect(checkDigest({ ...ok, cites: [] }, input)).toEqual({ ok: false, reason: "no_cite" });
    // A sha's digits do not ground a number.
    expect(checkDigest({ ...ok, summary: "Status: 1234 uploads retried" }, input)).toEqual({ ok: false, reason: "invented_number" });
    expect(digestPrompt(input)).toContain("- sha:abc1234 [feat/x] Retry indexing 3 times");
  });
});

describe("THE ONE AUTHOR EXCEPTION: `trov`", () => {
  it("only an entry carrying Trov's provenance may be authored by `trov`, and Trov's provenance only by `trov`", async () => {
    const entry = { summary: "Status: x", body: "", tags: [], artifacts: { prs: [], commits: [], issues: [] } };
    await expect(ingestFeedEntry(systemCtx(), entry, "trov")).rejects.toThrow(/go together/);
    await expect(ingestFeedEntry(systemCtx(), entry, "AndresL230", undefined, { model: "m", subject: null })).rejects.toThrow(/go together/);
    expect(await count(`SELECT COUNT(*) AS n FROM feed WHERE org_id = ? AND (author = 'trov' OR origin = 'ai')`, ORG_A)).toBe(0);
  });

  it("`trov` is a person row, never a member, never listed", async () => {
    expect(await first(env.DB, `SELECT handle, name FROM persons WHERE handle = 'trov'`)).toEqual({ handle: "trov", name: "Trov" });
    expect(await count(`SELECT COUNT(*) AS n FROM memberships WHERE user_id = 'trov'`)).toBe(0);
    await run(env.DB, `INSERT INTO memberships (org_id, user_id, role, created_at, created_by) VALUES (?, 'trov', 'member', '2026-10-15T00:00:00Z', 'test')`, ORG_A);
    const { listPersons } = await import("../src/auth/persons");
    expect((await listPersons(systemCtx())).map((p) => p.handle)).not.toContain("trov"); // reserved: never listed even as a member
  });
});

describe("DELETION: the system person stays; a person's digests keep their content, not their name", () => {
  it("`trov` cannot be deleted (not found, from either caller); deleting a person drops their sessions' bookkeeping and tombstones the digests' subject", async () => {
    const { accountDeletionPreview, deleteAccount } = await import("../src/deletion/person");
    const { platformCtx } = await import("./helpers/tenant");
    expect(await accountDeletionPreview(platformCtx("AndresL230"), "trov", { by: "platform", actor: "AndresL230" })).toBeNull();
    expect(await accountDeletionPreview(platformCtx("trov"), "trov", { by: "self", actor: "trov" })).toBeNull();

    await deliver("push", push(20, { subjects: ["Real work", "More", "And more"] }));
    const s = stubProviders({ jev: () => 0.9, claude: digestReply() });
    await pass(s, later(46 * MIN));
    const [row] = (await feedRows()).filter((r) => r.origin === "ai");
    expect(row.subject).toBe(JOSE);
    await deleteAccount(e, platformCtx(JOSE), JOSE, { by: "self", actor: JOSE });
    const after = (await feedRows()).find((r) => r.id === row.id)!;
    expect(after.author).toBe("trov");
    expect(after.subject).toMatch(/^deleted-/);
    expect(await sessions()).toEqual([]);
    expect(await first(env.DB, `SELECT handle FROM persons WHERE handle = 'trov'`)).toEqual({ handle: "trov" });
  });
});

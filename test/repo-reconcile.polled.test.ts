/**
 * reconcileRepo's two arms for what used to be WEBHOOK-ONLY:
 *
 *  - `statuses` — the `canopy/*` commit statuses on the first environment's
 *    head, rebuilt as the webhook's `status` payload and put through the
 *    unchanged `metricsFromStatus` → `putMetric`;
 *  - `reviews`  — PR reviews over ONE GraphQL request, rebuilt as the webhook's
 *    `pull_request_review` payload and put through the unchanged `fromReview`.
 *
 * Both must produce rows that COLLIDE with the webhook's own (same metric key /
 * same semantic key), so a poll and a delivery of the same fact never double.
 * GitHub is stubbed at the Response level; rows are asserted in real D1.
 */
import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import { systemCtx } from "./helpers/tenant";
import { all } from "./helpers/db";
import { ingestRepoEvent } from "../src/consumer";
import { reconcileRepo } from "../src/repo/github";
import { repoEventsFromDelivery } from "../src/repo/capture";
import { hasCaptured } from "../src/repo/reads";
import { getRepoDashboard } from "../src/tools/repo";
import { handleGithubWebhook } from "../src/webhook";
import { ENVS, LONG_TOKEN, fakeGithub, leakedFragments } from "./helpers/repo";
import statusFixture from "./fixtures/gh-status.json";
import reviewFixture from "./fixtures/gh-pr-review.json";
import type { Env } from "../src/env";

const NOW = Date.parse("2026-09-20T12:00:00Z");
const HEAD = "becdbac09eaf5d7c73b9f27019c0e43c4444dd7b";
const headCommit = { sha: HEAD, commit: { message: "head", committer: { date: "2026-09-20T09:00:00Z" } }, author: { login: "AndresL230" } };
const OPTS = (fetchImpl: typeof fetch, token = "t") => ({ token, repo: "o/r", fetchImpl });

const status = (context: string, description: string | null, at: string, over: Record<string, unknown> = {}) =>
  ({ id: 1, context, description, state: "success", created_at: at, updated_at: at, target_url: null, ...over });
const metrics = () => all<{ metric: string; value: number; at: string }>(env.DB,
  `SELECT metric, value, at FROM repo_metrics WHERE metric IN ('coverage', 'bundle_kb', 'todo_count') ORDER BY metric, at`);

const reviewNode = (over: Record<string, unknown> = {}) => ({
  databaseId: 3001, state: "APPROVED", submittedAt: "2026-09-20T10:00:00Z",
  url: "https://github.com/SaplingLearn/sapling/pull/480#pullrequestreview-3001",
  author: { login: "Darkest-Teddy", __typename: "User" }, ...over,
});
const reviews = (...prs: { number: number; nodes: unknown[] }[]) =>
  ({ data: { repository: { pullRequests: { nodes: prs.map((p) => ({ number: p.number, reviews: { nodes: p.nodes } })) } } } });
const reviewRows = () => all<{ semantic_key: string; number: number; state: string; actor_login: string; url: string; provenance: string; occurred_at: string }>(env.DB,
  `SELECT semantic_key, number, state, actor_login, url, provenance, occurred_at FROM repo_events WHERE kind = 'review' ORDER BY semantic_key`);

const quietly = async <T>(fn: () => Promise<T>): Promise<{ out: T; logged: string }> => {
  const spies = (["error", "warn"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => undefined));
  try {
    const out = await fn();
    return { out, logged: JSON.stringify(spies.flatMap((s) => s.mock.calls).map((c) => c.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : a)))) };
  } finally { for (const s of spies) s.mockRestore(); }
};

// GitHub's own signing recipe — a correctly-signed `status` / review delivery.
const SECRET = "test-webhook-secret"; // matches vitest.config.ts binding
async function deliver(eventName: string, payload: unknown, e: Env): Promise<Response> {
  const body = JSON.stringify(payload);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return handleGithubWebhook(new Request("https://x/webhook/github", {
    method: "POST", body, headers: { "x-github-event": eventName, "x-hub-signature-256": `sha256=${hex}`, "content-type": "application/json" },
  }), e);
}
const withEnvs = { ...env, REPO_ENVIRONMENTS: JSON.stringify(ENVS) } as Env;

describe("reconcileRepo — the statuses arm (coverage / bundle / TODO)", () => {
  it("stores the three canopy/* metrics from ONE request on the head sha, and ignores every other context", async () => {
    const gh = fakeGithub({
      "/commits?sha=main&per_page=1": [headCommit],
      "/statuses": [
        status("Sapling - sapling", "Success - api.staging.saplinglearn.com", "2026-09-20T09:09:00Z"),
        status("canopy/coverage", "82.3", "2026-09-20T09:08:00Z"),
        status("canopy/bundle-kb", "412", "2026-09-20T09:07:30Z"),
        status("CodeRabbit", "Review completed", "2026-09-20T09:07:10Z"),
        status("canopy/todo", "2", "2026-09-20T09:07:00Z"),
      ],
    });
    const res = await reconcileRepo(systemCtx(), OPTS(gh.fetchImpl), ENVS, NOW);
    expect(res.failed).toEqual([]);
    expect(res.written).toBe(3);
    expect(await metrics()).toEqual([
      { metric: "bundle_kb", value: 412, at: "2026-09-20T09:07:30.000Z" },
      { metric: "coverage", value: 82.3, at: "2026-09-20T09:08:00.000Z" },
      { metric: "todo_count", value: 2, at: "2026-09-20T09:07:00.000Z" },
    ]);
    const asked = gh.calls.filter((c) => c.includes("/statuses"));
    expect(asked).toEqual([`https://api.github.com/repos/o/r/commits/${HEAD}/statuses?per_page=100`]);

    // A second reconcile re-reads the same statuses: nothing new, all unchanged.
    const again = await reconcileRepo(systemCtx(), OPTS(gh.fetchImpl), ENVS, NOW);
    expect(again.written).toBe(0);
    expect(again.unchanged).toBe(3);
    expect(await metrics()).toHaveLength(3);
  });

  it("falls back to the branch NAME when the head read failed, and to main with no environment", async () => {
    const noHead = fakeGithub({ "/statuses": [] });
    const failHead = (async (u: RequestInfo | URL, init?: RequestInit) =>
      String(u).endsWith("&per_page=1") ? new Response("", { status: 500 }) : noHead.fetchImpl(u, init)) as typeof fetch;
    const { out } = await quietly(() => reconcileRepo(systemCtx(), OPTS(failHead), ENVS, NOW));
    expect(out.failed).toEqual(["env_heads"]);
    expect(noHead.calls.filter((c) => c.includes("/statuses"))).toEqual(["https://api.github.com/repos/o/r/commits/main/statuses?per_page=100"]);

    const bare = fakeGithub({ "/statuses": [status("canopy/todo", "7", "2026-09-20T09:07:00Z")] });
    await reconcileRepo(systemCtx(), OPTS(bare.fetchImpl), [], NOW);
    expect(bare.calls.filter((c) => c.includes("/statuses"))).toEqual(["https://api.github.com/repos/o/r/commits/main/statuses?per_page=100"]);
    expect(await metrics()).toEqual([{ metric: "todo_count", value: 7, at: "2026-09-20T09:07:00.000Z" }]);
  });

  // The webhook stores `updated_at` (else `created_at`) through putMetric, which
  // normalises it; the arm rebuilds the SAME payload, so the two collide on
  // (metric, env, part, at) — whichever lands first, and however GitHub spells
  // the instant (`…Z` in the REST list, `…+00:00` in some deliveries).
  it("dedupes against a webhook-delivered point for the same status, in either order", async () => {
    expect((await deliver("status", statusFixture, withEnvs)).status).toBe(200);
    expect(await metrics()).toEqual([{ metric: "coverage", value: 78.4, at: "2026-09-20T09:07:00.000Z" }]);

    const gh = fakeGithub({
      "/commits?sha=main&per_page=1": [headCommit],
      "/statuses": [status("canopy/coverage", "78.4", "2026-09-20T09:07:00+00:00"), status("canopy/todo", "5", "2026-09-20T09:06:00Z")],
    });
    const res = await reconcileRepo(systemCtx(), OPTS(gh.fetchImpl), ENVS, NOW);
    expect(res.written).toBe(1); // the TODO count is new
    expect(res.unchanged).toBe(1); // the coverage point is the webhook's own
    expect(await metrics()).toEqual([
      { metric: "coverage", value: 78.4, at: "2026-09-20T09:07:00.000Z" },
      { metric: "todo_count", value: 5, at: "2026-09-20T09:06:00.000Z" },
    ]);

    // …and the other way round: a delivery of a status the poll already stored.
    const late = await deliver("status", { ...statusFixture, context: "canopy/todo", description: "5", created_at: "2026-09-20T09:06:00Z", updated_at: "2026-09-20T09:06:00Z" }, withEnvs);
    expect(await late.json()).toMatchObject({ repo: { captured: 0, unchanged: 1 } });
    expect(await metrics()).toHaveLength(2);
  });

  it("drops an invalid description through the EXISTING validator — nothing stored, not a failure", async () => {
    const gh = fakeGithub({
      "/commits?sha=main&per_page=1": [headCommit],
      "/statuses": [
        status("canopy/coverage", "500", "2026-09-20T09:08:00Z"), // out of range
        status("canopy/bundle-kb", null, "2026-09-20T09:07:30Z"), // Number(null) === 0 — the bug the validator guards
        status("canopy/todo", "1e3", "2026-09-20T09:07:00Z"), // not a strict decimal
      ],
    });
    const { out, logged } = await quietly(() => reconcileRepo(systemCtx(), OPTS(gh.fetchImpl), ENVS, NOW));
    expect(out.failed).toEqual([]);
    expect(out.written).toBe(0);
    expect(await metrics()).toEqual([]);
    expect(logged).toContain("dropped status");
    expect(logged).toContain("canopy/coverage");
  });

  it("keeps at most the newest 10 per context", async () => {
    const many = Array.from({ length: 14 }, (_, i) => status("canopy/todo", String(40 - i), new Date(NOW - i * 60_000).toISOString()));
    const gh = fakeGithub({ "/commits?sha=main&per_page=1": [headCommit], "/statuses": [...many, status("canopy/coverage", "80", "2026-09-20T08:00:00Z")] });
    const res = await reconcileRepo(systemCtx(), OPTS(gh.fetchImpl), ENVS, NOW);
    expect(res.written).toBe(11);
    const todo = (await metrics()).filter((m) => m.metric === "todo_count");
    expect(todo).toHaveLength(10);
    expect(todo.map((m) => m.value).sort((a, b) => a - b)).toEqual([31, 32, 33, 34, 35, 36, 37, 38, 39, 40]); // the newest ten
  });

  it("a 404 and an empty list are not failures", async () => {
    const empty = fakeGithub({ "/commits?sha=main&per_page=1": [headCommit], "/statuses": [] });
    expect((await reconcileRepo(systemCtx(), OPTS(empty.fetchImpl), ENVS, NOW)).failed).toEqual([]);

    const base = fakeGithub({ "/commits?sha=main&per_page=1": [headCommit] });
    const notFound = (async (u: RequestInfo | URL, init?: RequestInit) =>
      String(u).includes("/statuses") ? new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }) : base.fetchImpl(u, init)) as typeof fetch;
    expect((await reconcileRepo(systemCtx(), OPTS(notFound), ENVS, NOW)).failed).toEqual([]);
    expect(await metrics()).toEqual([]);
  });

  it("any other failure is named in `failed` and stops nothing after it", async () => {
    const base = fakeGithub({ "/commits?sha=main&per_page=1": [headCommit], reviewsGraphql: reviews({ number: 480, nodes: [reviewNode()] }) });
    const broken = (async (u: RequestInfo | URL, init?: RequestInit) =>
      String(u).includes("/statuses") ? new Response("boom", { status: 502 }) : base.fetchImpl(u, init)) as typeof fetch;
    const { out } = await quietly(() => reconcileRepo(systemCtx(), OPTS(broken), ENVS, NOW));
    expect(out.failed).toEqual(["statuses"]);
    expect(await reviewRows()).toHaveLength(1); // the reviews arm, right after it, still ran
    expect((await all(env.DB, `SELECT kind FROM repo_snapshots WHERE kind = 'branches'`))).toHaveLength(1);
  });
});

describe("reconcileRepo — every GitHub read is bounded", () => {
  it("sends an abort signal with every request, and a timeout is that arm's failure by name", async () => {
    const base = fakeGithub({ "/commits?sha=main&per_page=1": [headCommit] });
    const signals: unknown[] = [];
    const hanging = (async (u: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal);
      if (String(u).includes("/statuses")) throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
      if (String(u).endsWith("/graphql") && String(init?.body ?? "").includes("pullRequests(")) throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
      return base.fetchImpl(u, init);
    }) as typeof fetch;
    const { out } = await quietly(() => reconcileRepo(systemCtx(), OPTS(hanging), ENVS, NOW));
    expect(out.failed).toEqual(["statuses", "reviews"]);
    expect(signals.length).toBeGreaterThan(10);
    for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal);
    expect((await all(env.DB, `SELECT kind FROM repo_snapshots WHERE kind = 'branches'`))).toHaveLength(1); // the arms after them ran
  });
});

describe("reconcileRepo — the reviews arm", () => {
  // THE parity test: the polled row's key is what the webhook's own derivation
  // yields for the same review id — so whichever lands first, the other drops.
  it("writes the row the webhook fixture would have written for the same review — same semantic key, same fields", async () => {
    const [fromWebhook] = repoEventsFromDelivery("pull_request_review", reviewFixture, ENVS);
    expect(fromWebhook.semantic_key).toBe("gh:review:3001:submitted");

    const gh = fakeGithub({ reviewsGraphql: reviews({ number: 480, nodes: [reviewNode()] }) });
    const res = await reconcileRepo(systemCtx(), OPTS(gh.fetchImpl), ENVS, NOW);
    expect(res.failed).toEqual([]);
    expect(await reviewRows()).toEqual([{
      semantic_key: fromWebhook.semantic_key, number: fromWebhook.number, state: fromWebhook.state,
      actor_login: fromWebhook.actor_login, url: fromWebhook.url, occurred_at: fromWebhook.occurred_at,
      provenance: "backfill",
    }]);

    // The real delivery arriving afterwards is a redelivery of the same fact.
    const late = await deliver("pull_request_review", reviewFixture, withEnvs);
    expect(await late.json()).toMatchObject({ repo: { captured: 0, unchanged: 1 } });
    expect(await reviewRows()).toHaveLength(1);
  });

  it("a review the webhook captured first drops as unchanged", async () => {
    await deliver("pull_request_review", reviewFixture, withEnvs);
    const gh = fakeGithub({ reviewsGraphql: reviews({ number: 480, nodes: [reviewNode()] }) });
    const before = (await reviewRows())[0];
    const res = await reconcileRepo(systemCtx(), OPTS(gh.fetchImpl), ENVS, NOW);
    expect(res.written).toBe(0);
    expect(await reviewRows()).toEqual([before]); // still the webhook's row, provenance and all
    expect(before.provenance).toBe("webhook");
  });

  it("asks ONE GraphQL question: the 30 most recently updated open PRs, their last 10 reviews", async () => {
    const gh = fakeGithub({});
    await reconcileRepo(systemCtx(), OPTS(gh.fetchImpl), ENVS, NOW);
    const asked = gh.graphql.filter((c) => c.query.includes("pullRequests("));
    expect(asked).toHaveLength(1);
    expect(asked[0].variables).toEqual({ owner: "o", name: "r" });
    expect(asked[0].query).toMatch(/pullRequests\(states:OPEN, first:30, orderBy:\{field:UPDATED_AT,direction:DESC\}\)/);
    expect(asked[0].query).toMatch(/reviews\(last:10\)\{ nodes\{ databaseId state submittedAt url author\{ login __typename \} \} \}/);
  });

  it("lower-cases the state, re-suffixes a Bot, wraps a dismissal as the webhook's `dismissed`, and skips what was never submitted", async () => {
    const gh = fakeGithub({ reviewsGraphql: reviews(
      { number: 658, nodes: [
        reviewNode({ databaseId: 5264246626, state: "COMMENTED", submittedAt: "2026-09-20T07:58:05Z", url: "https://github.com/o/r/pull/658#pullrequestreview-5264246626", author: { login: "github-code-quality", __typename: "Bot" } }),
        reviewNode({ databaseId: 11, state: "CHANGES_REQUESTED", author: { login: "meilin", __typename: "User" } }),
        reviewNode({ databaseId: 12, state: "DISMISSED", author: { login: "AndresL230", __typename: "User" } }),
        reviewNode({ databaseId: 13, state: "PENDING" }), // a draft review — never submitted
        reviewNode({ databaseId: 14, submittedAt: null }),
        reviewNode({ databaseId: 15, author: null }), // a deleted account
        reviewNode({ databaseId: null }),
        null,
      ] },
      { number: 659, nodes: [reviewNode({ databaseId: 16, author: { login: "already[bot]", __typename: "Bot" } })] },
    ) });
    const res = await reconcileRepo(systemCtx(), OPTS(gh.fetchImpl), ENVS, NOW);
    expect(res.failed).toEqual([]);
    expect((await reviewRows()).map((r) => [r.semantic_key, r.number, r.state, r.actor_login])).toEqual([
      ["gh:review:11:submitted", 658, "changes_requested", "meilin"],
      ["gh:review:12:dismissed", 658, "dismissed", "AndresL230"],
      ["gh:review:16:submitted", 659, "approved", "already[bot]"],
      ["gh:review:5264246626:submitted", 658, "commented", "github-code-quality[bot]"],
    ]);
    // The dismissal's key is the one the webhook's `dismissed` delivery writes.
    const [dismissed] = repoEventsFromDelivery("pull_request_review", { action: "dismissed", review: { id: 12, state: "dismissed", submitted_at: "2026-09-20T10:00:00Z", user: { login: "AndresL230" } }, pull_request: { number: 658 } }, ENVS);
    expect(dismissed.semantic_key).toBe("gh:review:12:dismissed");
  });

  // The review's M2. A polled row proves a review HAPPENED; it can never prove
  // one did not (open PRs only, the last 10 each) — so it must not turn the
  // contributors' `R` from "—" (unknown) into a number, where everyone the arm
  // could not see would read a hard 0.
  const contributors = async () => {
    const d = await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS);
    return d.contributors.status === "ok"
      ? (d.contributors as { data: { person: { login: string }; pushes: number; reviews: number | null }[] }).data.map((r) => [r.person.login, r.reviews])
      : d.contributors.status;
  };
  const aPush = (login: string) => ingestRepoEvent(systemCtx(), {
    semantic_key: `gh:push:${login}`, kind: "push", ref: "main", sha: `sha-${login}`, actor_login: login, count: 1, title: "work",
    raw: "{}", provenance: "webhook", occurred_at: "2026-09-20T08:00:00Z",
  });

  it("polled-only reviews: captured, but `R` stays null for EVERYONE — never a hard 0 off an incomplete source", async () => {
    await aPush("alice"); // reviewed a PR that was merged before the poll — the arm can never see it
    await aPush("Darkest-Teddy");
    const gh = fakeGithub({ reviewsGraphql: reviews({ number: 480, nodes: [reviewNode()] }) });
    await reconcileRepo(systemCtx(), OPTS(gh.fetchImpl), ENVS, NOW);
    expect(await hasCaptured(systemCtx(), "review")).toBe(true);
    expect(await hasCaptured(systemCtx(), "review", "backfill")).toBe(true);
    expect(await hasCaptured(systemCtx(), "review", "webhook")).toBe(false);
    expect(await contributors()).toEqual([["alice", null], ["Darkest-Teddy", null]]);
  });

  it("one WEBHOOK review row opens the gate — and the numbers then include the polled rows", async () => {
    await aPush("alice");
    const gh = fakeGithub({ reviewsGraphql: reviews({ number: 480, nodes: [
      reviewNode(),
      reviewNode({ databaseId: 3002, state: "COMMENTED", author: { login: "meilin", __typename: "User" } }),
    ] }) });
    await reconcileRepo(systemCtx(), OPTS(gh.fetchImpl), ENVS, NOW);
    // Gate closed: a hidden tally neither orders the list nor adds a row for
    // someone known only by a polled review.
    expect(await contributors()).toEqual([["alice", null]]);

    // The hook gets subscribed: a delivery for a review the poll already stored
    // is `unchanged` — it must NOT open the gate (no webhook row was written)…
    await deliver("pull_request_review", reviewFixture, withEnvs);
    expect(await hasCaptured(systemCtx(), "review", "webhook")).toBe(false);
    // …a NEW review's delivery does.
    await deliver("pull_request_review", { ...reviewFixture, review: { ...reviewFixture.review, id: 3003, user: { login: "alice" } } }, withEnvs);
    expect(await hasCaptured(systemCtx(), "review", "webhook")).toBe(true);
    expect(await contributors()).toEqual([["alice", 1], ["Darkest-Teddy", 1], ["meilin", 1]]); // two of them polled rows
  });

  // "Awaiting review" and APPROVED are NOT gated: they are about OPEN PRs, the
  // set the arm reads, and they act on an approval that EXISTS.
  it("Awaiting review reacts to a polled approval at once", async () => {
    const pr = (number: number) => ({ number, title: `PR ${number}`, html_url: `https://github.com/o/r/pull/${number}`, state: "open", draft: false, merged_at: null, updated_at: "2026-09-20T09:10:00Z", user: { login: "lpcooper-arch" }, head: { ref: `b${number}`, sha: `s${number}` }, base: { ref: "main" } });
    const awaiting = async () => {
      const d = await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS);
      return (d.stats as { data: { label: string; value: number }[] }).data.find((t) => t.label === "Awaiting review")?.value;
    };
    const prsOnly = fakeGithub({ "/pulls?state=open": [pr(480), pr(481)] });
    await reconcileRepo(systemCtx(), OPTS(prsOnly.fetchImpl), ENVS, NOW);
    expect(await awaiting()).toBe(2);

    const withApproval = fakeGithub({ "/pulls?state=open": [pr(480), pr(481)], reviewsGraphql: reviews({ number: 480, nodes: [reviewNode()] }) });
    await reconcileRepo(systemCtx(), OPTS(withApproval.fetchImpl), ENVS, NOW);
    expect(await hasCaptured(systemCtx(), "review", "webhook")).toBe(false);
    expect(await awaiting()).toBe(1);
    const d = await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS);
    expect((d.prs as { data: { rows: { number: number; state: string }[] } }).data.rows.map((r) => [r.number, r.state]).sort()).toEqual([[480, "approved"], [481, "review"]]);
  });

  it("a failing reviews query is named in `failed`, stops nothing, and never logs the token", async () => {
    const token = `ghs_${LONG_TOKEN}`;
    const base = fakeGithub({ "/commits?sha=main&per_page=1": [headCommit], "/statuses": [status("canopy/todo", "3", "2026-09-20T09:07:00Z")] });
    const broken = (async (u: RequestInfo | URL, init?: RequestInit) => {
      const isReviews = String(u).endsWith("/graphql") && String(init?.body ?? "").includes("pullRequests(");
      return isReviews
        ? new Response(JSON.stringify({ errors: [{ message: `denied ${JSON.stringify(init?.headers)}` }] }), { status: 200 })
        : base.fetchImpl(u, init);
    }) as typeof fetch;
    const { out, logged } = await quietly(() => reconcileRepo(systemCtx(), OPTS(broken, token), ENVS, NOW));
    expect(out.failed).toEqual(["reviews"]);
    expect(await metrics()).toHaveLength(1); // the statuses arm before it ran
    expect((await all(env.DB, `SELECT kind FROM repo_snapshots WHERE kind IN ('branches', 'drift') ORDER BY kind`)).map((r) => (r as { kind: string }).kind)).toEqual(["branches", "drift"]);
    expect(logged).toContain("[redacted]");
    expect(leakedFragments(logged, token)).toEqual([]);
    expect(await hasCaptured(systemCtx(), "review")).toBe(false);
  });
});

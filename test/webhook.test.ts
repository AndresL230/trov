import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import { all, run, nowIso } from "../src/db";
import type { EventRow } from "@shared/rows";
import type { Env } from "../src/env";
import worker from "../src/index";
import {
  verifyGithubSignature,
  eventsFromDelivery,
  progressFromIssueEvent,
  handleGithubWebhook,
} from "../src/webhook";
import prMerged from "./fixtures/gh-pr-merged.json";
import issueAssigned from "./fixtures/gh-issue-assigned.json";
import issueClosed from "./fixtures/gh-issue-closed.json";
import pushFixture from "./fixtures/gh-push.json";
import prOpened from "./fixtures/gh-pr-opened.json";
import workflowRun from "./fixtures/gh-workflow-run.json";
import statusFixture from "./fixtures/gh-status.json";
import type { Summarizer, PrSummary, IssueSummary } from "../src/tools/summarize";
import type { IssueSummaryRow } from "@shared/rows";
import type { RepoEventRow } from "../src/repo/types";
import { getSnapshot } from "../src/repo/store";
import type { RepoDrift } from "@shared/repo";
import { ENVS } from "./helpers/repo";

const SECRET = "test-webhook-secret"; // matches vitest.config.ts binding

// GitHub's own signing recipe — HMAC-SHA256 hex, prefixed `sha256=`.
async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return "sha256=" + [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function req(body: string, headers: Record<string, string>): Request {
  return new Request("https://x/webhook/github", { method: "POST", headers, body });
}

// A correctly-signed delivery to the handler (the common happy path).
async function postWebhook(
  eventName: string,
  payload: unknown,
  e: Env = env,
  opts?: { summarizer?: Summarizer<PrSummary> | null; issueSummarizer?: Summarizer<IssueSummary> | null; fetchImpl?: typeof fetch }
): Promise<Response> {
  const body = JSON.stringify(payload);
  const sig = await sign(SECRET, body);
  return handleGithubWebhook(
    req(body, { "x-github-event": eventName, "x-hub-signature-256": sig, "content-type": "application/json" }),
    e,
    opts
  );
}

describe("handleGithubWebhook — the third auth class", () => {
  it("valid signature + pr-merged → 200, one events row; redelivery → captured:0 unchanged:1", async () => {
    const res = await postWebhook("pull_request", prMerged);
    expect(res.status).toBe(200);
    // pull_request is also a REPO_EVENT_NAMES entry: the same verified delivery
    // independently reaches repo_events (a closed+merged PR → one "pr"/"merged" row).
    expect(await res.json()).toEqual({ ok: true, captured: 1, unchanged: 0, repo: { captured: 1, unchanged: 0 } });

    let rows = await all<EventRow>(env.DB, `SELECT * FROM events`);
    expect(rows.length).toBe(1);
    expect(rows[0].event_type).toBe("pr_merged");
    expect(rows[0].subject_login).toBe("AndresL230");
    expect(rows[0].recorded_by).toBe("github-webhook"); // fixed writer principal
    expect(rows[0].semantic_key).toBe("gh:pr:42:merged");

    // Redelivery of the SAME body: the UNIQUE semantic_key dedupes (INSERT OR IGNORE).
    const res2 = await postWebhook("pull_request", prMerged);
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ ok: true, captured: 0, unchanged: 1, repo: { captured: 0, unchanged: 1 } });
    rows = await all<EventRow>(env.DB, `SELECT * FROM events`);
    expect(rows.length).toBe(1); // still exactly one row
  });

  it("bad signature → 401 and zero rows written", async () => {
    const body = JSON.stringify(prMerged);
    const res = await handleGithubWebhook(
      req(body, { "x-github-event": "pull_request", "x-hub-signature-256": "sha256=deadbeef" }),
      env
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect((await all<EventRow>(env.DB, `SELECT * FROM events`)).length).toBe(0);
  });

  it("missing signature header → 401", async () => {
    const body = JSON.stringify(prMerged);
    const res = await handleGithubWebhook(req(body, { "x-github-event": "pull_request" }), env);
    expect(res.status).toBe(401);
  });

  it("secret unset → 401 (never trusts an unsigned surface)", async () => {
    const body = JSON.stringify(prMerged);
    const sig = await sign(SECRET, body);
    const noSecret = { ...env, GITHUB_WEBHOOK_SECRET: undefined } as Env;
    const res = await handleGithubWebhook(
      req(body, { "x-github-event": "pull_request", "x-hub-signature-256": sig }),
      noSecret
    );
    expect(res.status).toBe(401);
  });

  it("unhandled event name → 200 {ok:true, ignored:true} AFTER signature verification", async () => {
    const body = JSON.stringify({ zen: "Keep it simple." });
    const sig = await sign(SECRET, body);
    const res = await handleGithubWebhook(
      req(body, { "x-github-event": "ping", "x-hub-signature-256": sig }),
      env
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect((await all<EventRow>(env.DB, `SELECT * FROM events`)).length).toBe(0);
  });

  it("default export routes POST /webhook/github to the handler", async () => {
    const body = JSON.stringify(prMerged);
    const sig = await sign(SECRET, body);
    const ctx = { waitUntil() {}, passThroughException() {} } as unknown as ExecutionContext;
    const res = await worker.fetch(
      req(body, { "x-github-event": "pull_request", "x-hub-signature-256": sig }),
      env,
      ctx
    );
    expect(res.status).toBe(200);
    const rows = await all<EventRow>(env.DB, `SELECT * FROM events`);
    expect(rows.length).toBe(1);
    expect(rows[0].event_type).toBe("pr_merged");
  });

  it("captures the PR base branch in raw (footer 'into <base>' source)", async () => {
    await postWebhook("pull_request", prMerged, env);
    const rows = await all<EventRow>(env.DB, `SELECT * FROM events WHERE semantic_key = 'gh:pr:42:merged'`);
    const raw = JSON.parse(rows[0].raw) as { pr: { base: { ref: string } | null } };
    expect(raw.pr.base).toEqual({ ref: "main" });
  });

  it("captures the issue GROUP's number, title and due date in raw (the Sprint row's source)", async () => {
    await postWebhook("issues", issueAssigned, env);
    const rows = await all<EventRow>(env.DB, `SELECT * FROM events WHERE event_type = 'issue'`);
    // `milestone` is GitHub's own key — not Trov vocabulary (the stored raw mirrors it).
    const raw = JSON.parse(rows[0].raw) as { issue: { milestone: { number: number; title: string | null; due_on: string | null } } };
    expect(raw.issue.milestone).toMatchObject({ number: 3, title: "Reliable event capture", due_on: "2026-07-20T07:00:00Z" });
  });
});

describe("verifyGithubSignature", () => {
  it("true for a good sig; false for malformed/absent/tampered (never throws)", async () => {
    const body = "the raw delivery bytes";
    const good = await sign(SECRET, body);
    expect(await verifyGithubSignature(SECRET, body, good)).toBe(true);
    expect(await verifyGithubSignature(SECRET, body, "sha256=zzzz")).toBe(false); // non-hex
    expect(await verifyGithubSignature(SECRET, body, "sha256=abc")).toBe(false); // odd length
    expect(await verifyGithubSignature(SECRET, body, "garbage")).toBe(false); // no prefix
    expect(await verifyGithubSignature(SECRET, body, null)).toBe(false); // absent
    expect(await verifyGithubSignature(SECRET, "tampered body", good)).toBe(false); // body changed
  });
});

describe("eventsFromDelivery — pure derivation", () => {
  it("issues/assigned → subject is the assignee; key embeds action+assignee+updated_at", () => {
    const events = eventsFromDelivery("issues", issueAssigned);
    expect(events.length).toBe(1);
    const e = events[0];
    expect(e.event_type).toBe("issue");
    expect(e.subject_login).toBe("Jose-Gael-Cruz-Lopez");
    expect(e.ref_number).toBe(17);
    expect(e.semantic_key).toBe("gh:issue:17:assigned:Jose-Gael-Cruz-Lopez:2026-07-01T17:05:00Z");
    expect(e.occurred_at).toBe("2026-07-01T17:05:00Z");
    expect(e.provenance).toBe("webhook");
    const raw = JSON.parse(e.raw);
    expect(raw.action).toBe("assigned");
    expect(raw.issue.labels).toEqual(["P1", "backend"]); // label objects flattened to names
    // `milestone` is GitHub's own key — not Trov vocabulary.
    expect(raw.issue.milestone).toEqual({
      number: 3,
      title: "Reliable event capture",
      due_on: "2026-07-20T07:00:00Z",
      open_issues: 2,
      closed_issues: 4,
    });
    expect(raw.issue.body).toBe("Full description of what needs wiring."); // NEW: needed by the issue summarizer
  });

  it("pr closed+merged → pr_merged with the merged key and merged_at as occurred_at", () => {
    const events = eventsFromDelivery("pull_request", prMerged);
    expect(events.length).toBe(1);
    const e = events[0];
    expect(e.event_type).toBe("pr_merged");
    expect(e.semantic_key).toBe("gh:pr:42:merged");
    expect(e.subject_login).toBe("AndresL230");
    expect(e.ref_number).toBe(42);
    expect(e.occurred_at).toBe("2026-07-01T18:24:00Z");
    const raw = JSON.parse(e.raw);
    expect(raw.pr.merged).toBe(true);
    // `milestone` is GitHub's own key — not Trov vocabulary; the PR slice is number-only.
    expect(raw.pr.milestone).toEqual({ number: 3 });
  });

  it("returns [] for a PR masquerading as an issue and for unknown/unhandled actions", () => {
    expect(eventsFromDelivery("issues", { action: "assigned", issue: { number: 1, pull_request: { url: "x" } } })).toEqual([]);
    expect(eventsFromDelivery("issues", { action: "labeled", issue: { number: 1, updated_at: "t", user: { login: "x" }, assignees: [] } })).toEqual([]);
    expect(eventsFromDelivery("pull_request", { action: "opened", pull_request: { number: 1 } })).toEqual([]);
    expect(eventsFromDelivery("push", {})).toEqual([]);
    expect(eventsFromDelivery("issues", null)).toEqual([]);
  });
});

describe("progressFromIssueEvent — pure derivation", () => {
  it("reads the issue GROUP's counts (total = open + closed)", () => {
    expect(progressFromIssueEvent(issueClosed)).toEqual({ groupNumber: 3, closed: 5, total: 6 });
  });

  it("null when the issue belongs to no group", () => {
    expect(progressFromIssueEvent({ issue: { number: 1 } })).toBeNull();
    expect(progressFromIssueEvent(null)).toBeNull();
  });
});

describe("webhook → issue summarize wiring", () => {
  it("an assigned issue event → one issue_summaries row keyed by issue number", async () => {
    const stub: Summarizer<IssueSummary> = { model: "stub", summarize: async () => ({ title: "Humanized", summary: "What it is and what to do.", next_step: null }) };
    const res = await postWebhook("issues", issueAssigned, env, { issueSummarizer: stub });
    expect(res.status).toBe(200);
    const rows = await all<IssueSummaryRow>(env.DB, `SELECT * FROM issue_summaries WHERE issue_number = ?`, 17);
    expect(rows.length).toBe(1);
    expect(rows[0].summary).toBe("What it is and what to do.");
  });

  it("a non-assigned issue action (closed) never reaches storeIssueSummary — zero issue_summaries rows", async () => {
    const stub: Summarizer<IssueSummary> = { model: "stub", summarize: async () => ({ title: "Humanized", summary: "should never be called", next_step: null }) };
    const res = await postWebhook("issues", issueClosed, env, { issueSummarizer: stub });
    expect(res.status).toBe(200);
    const rows = await all(env.DB, `SELECT * FROM issue_summaries`);
    expect(rows.length).toBe(0);
  });

  it("still runs progressSeam for an assigned issue event (both seams fire, not either/or)", async () => {
    // progressSeam only writes a sprint_progress row for a sprint that
    // already exists with a matching github_ref (see test/progress.test.ts's
    // seedSprint pattern) — seed one matching issueAssigned's GitHub group
    // number (3) so the assertion below actually exercises applyEventProgress.
    await run(
      env.DB,
      `INSERT INTO sprints (title, target_date, status, github_ref, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)`,
      "M",
      "2026-08-01",
      "in_progress",
      "3",
      nowIso(),
      "andres"
    );
    const stub: Summarizer<IssueSummary> = { model: "stub", summarize: async () => ({ title: "Humanized", summary: "summary", next_step: null }) };
    await postWebhook("issues", issueAssigned, env, { issueSummarizer: stub });
    const progress = await all(env.DB, `SELECT * FROM sprint_progress`);
    expect(progress.length).toBe(1); // issueAssigned carries a GitHub group — progressSeam still wrote it
  });
});

describe("handleGithubWebhook — repo capture runs beside the My Work capture", () => {
  it("a push is captured into repo_events and writes nothing to events", async () => {
    const res = await postWebhook("push", pushFixture);
    expect(await res.json()).toMatchObject({ ok: true, captured: 0, repo: { captured: 1, unchanged: 0 } });
    expect(await all<EventRow>(env.DB, `SELECT * FROM events`)).toHaveLength(0);
    expect(await all<RepoEventRow>(env.DB, `SELECT * FROM repo_events`)).toHaveLength(1);
    const again = await postWebhook("push", pushFixture);
    expect(await again.json()).toMatchObject({ repo: { captured: 0, unchanged: 1 } });
  });

  it("an opened PR reaches repo_events only; a merged PR reaches BOTH", async () => {
    await postWebhook("pull_request", prOpened);
    expect(await all(env.DB, `SELECT * FROM events`)).toHaveLength(0);
    await postWebhook("pull_request", prMerged, env, { summarizer: null });
    expect(await all<EventRow>(env.DB, `SELECT event_type FROM events`)).toEqual([{ event_type: "pr_merged" }]);
    const kinds = await all<{ state: string }>(env.DB, `SELECT state FROM repo_events WHERE kind = 'pr' ORDER BY id`);
    expect(kinds.map((k) => k.state)).toEqual(["review", "merged"]);
  });

  // P5-1: `??` skips null as well as undefined, so an explicit `summarizer: null`
  // used to fall through to the env-resolved (network) summarizer. The global
  // fetch is stubbed so a regression fails HERE instead of reaching Google.
  it("an explicit summarizer: null means NO summarizer, even with GEMINI_API_KEY set", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { status: 500 }));
    try {
      const keyed = { ...env, GEMINI_API_KEY: "test-key" } as unknown as Env;
      await postWebhook("pull_request", prMerged, keyed, { summarizer: null });
      await postWebhook("issues", issueAssigned, keyed, { issueSummarizer: null });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
    expect(await all<{ model: string }>(env.DB, `SELECT model FROM pr_summaries`)).toEqual([{ model: "excerpt" }]);
    expect(await all<{ model: string }>(env.DB, `SELECT model FROM issue_summaries`)).toEqual([{ model: "excerpt" }]);
  });

  it("the pool blanks GEMINI_API_KEY, so a default delivery resolves no summarizer", async () => {
    expect(env.GEMINI_API_KEY ?? "").toBe("");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { status: 500 }));
    try {
      await postWebhook("pull_request", prMerged);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("a push never reaches the issue summarizer", async () => {
    let called = 0;
    const spy: Summarizer<IssueSummary> = {
      model: "spy",
      summarize: async () => { called++; throw new Error("must not run"); },
    };
    await postWebhook("push", pushFixture, env, { issueSummarizer: spy });
    expect(called).toBe(0);
  });

  it("an unhandled event name is still verified-then-ignored", async () => {
    const res = await postWebhook("star", { action: "created" });
    expect(await res.json()).toEqual({ ok: true, ignored: true });
  });

  it("a failed workflow_run is enriched with the failing job title (service token + repo present)", async () => {
    const jobs = { jobs: [
      { name: "lint", conclusion: "success", steps: [] },
      { name: "e2e (browser lane)", conclusion: "failure", steps: [{ name: "Checkout", conclusion: "success" }, { name: "Run e2e suite", conclusion: "failure" }] },
    ] };
    const fetchImpl = (async (u: RequestInfo | URL) => {
      expect(String(u)).toBe("https://api.github.com/repos/o/r/actions/runs/35501310333/jobs?filter=latest&per_page=100");
      return new Response(JSON.stringify(jobs), { status: 200 });
    }) as typeof fetch;
    await postWebhook("workflow_run", workflowRun, { ...env, GITHUB_SERVICE_TOKEN: "t", GITHUB_REPO: "o/r" }, { fetchImpl });
    const row = await all<{ title: string | null }>(env.DB, `SELECT title FROM repo_events WHERE kind = 'run'`);
    expect(row).toEqual([{ title: "e2e (browser lane) · Run e2e suite" }]);
  });

  it("a TIMED_OUT workflow_run is also enriched with the failing job title — not just `failure`", async () => {
    const jobs = { jobs: [
      { name: "e2e (browser lane)", conclusion: "failure", steps: [{ name: "Run e2e suite", conclusion: "failure" }] },
    ] };
    const fetchImpl = (async () => new Response(JSON.stringify(jobs), { status: 200 })) as typeof fetch;
    const timedOut = { ...workflowRun, workflow_run: { ...workflowRun.workflow_run, conclusion: "timed_out" } };
    await postWebhook("workflow_run", timedOut, { ...env, GITHUB_SERVICE_TOKEN: "t", GITHUB_REPO: "o/r" }, { fetchImpl });
    const row = await all<{ title: string | null }>(env.DB, `SELECT title FROM repo_events WHERE kind = 'run'`);
    expect(row).toEqual([{ title: "e2e (browser lane) · Run e2e suite" }]);
  });

  it("without GITHUB_SERVICE_TOKEN, a failed run row lands with no title and no fetch is attempted", async () => {
    let calls = 0;
    const fetchImpl = (async () => { calls++; throw new Error("must not be called"); }) as typeof fetch;
    await postWebhook("workflow_run", workflowRun, env, { fetchImpl });
    expect(calls).toBe(0);
    const row = await all<{ title: string | null }>(env.DB, `SELECT title FROM repo_events WHERE kind = 'run'`);
    expect(row).toEqual([{ title: null }]);
  });
});

// Task 14: `status` deliveries feed `repo_metrics` directly — never
// `repoEventsFromDelivery`'s row path, and never `events`.
describe("handleGithubWebhook — status capture (coverage/bundle/TODO metrics)", () => {
  // M13: exercise these against a CONFIGURED REPO_ENVIRONMENTS (as the drift
  // tests below do), not the bare test env's implicit fallback — the branch
  // match must be pinned to the actual config, not to "main" by coincidence.
  const withEnvs = { ...env, REPO_ENVIRONMENTS: JSON.stringify(ENVS) } as Env;

  it("a canopy/coverage status writes one repo_metrics row, counted in repo.captured; redelivery → unchanged", async () => {
    const res = await postWebhook("status", statusFixture, withEnvs);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, captured: 0, unchanged: 0, repo: { captured: 1, unchanged: 0 } });
    expect(await all<EventRow>(env.DB, `SELECT * FROM events`)).toHaveLength(0);
    expect(await all(env.DB, `SELECT * FROM repo_events`)).toHaveLength(0);
    const rows = await all<{ metric: string; value: number }>(env.DB, `SELECT metric, value FROM repo_metrics`);
    expect(rows).toEqual([{ metric: "coverage", value: 78.4 }]);

    const again = await postWebhook("status", statusFixture, withEnvs);
    expect(await again.json()).toEqual({ ok: true, captured: 0, unchanged: 0, repo: { captured: 0, unchanged: 1 } });
    expect(await all(env.DB, `SELECT * FROM repo_metrics`)).toHaveLength(1);
  });

  // Commit statuses from other apps (Railway, CodeRabbit) arrive constantly
  // once the webhook is subscribed to Statuses — an unrelated context must
  // cost nothing beyond one cheap parse: zero repo_metrics rows written.
  it("a status with an unrelated context writes nothing", async () => {
    const other = { ...statusFixture, context: "Railway", description: "Deploy succeeded" };
    const res = await postWebhook("status", other, withEnvs);
    expect(await res.json()).toEqual({ ok: true, captured: 0, unchanged: 0, repo: { captured: 0, unchanged: 0 } });
    expect(await all(env.DB, `SELECT * FROM repo_metrics`)).toHaveLength(0);
    expect(await all(env.DB, `SELECT * FROM repo_events`)).toHaveLength(0);
  });

  // M13: "main" only counts when it IS the first configured environment's
  // branch. When the first environment ships from a different branch, a
  // status naming "main" is just another off-branch status — dropped.
  it("a status on main is dropped when the first configured environment's branch is not main", async () => {
    const otherFirst = { ...env, REPO_ENVIRONMENTS: JSON.stringify([{ ...ENVS[0], branch: "release" }, ENVS[1]]) } as Env;
    const res = await postWebhook("status", statusFixture, otherFirst);
    expect(await res.json()).toEqual({ ok: true, captured: 0, unchanged: 0, repo: { captured: 0, unchanged: 0 } });
    expect(await all(env.DB, `SELECT * FROM repo_metrics`)).toHaveLength(0);
  });
});

describe("handleGithubWebhook — drift snapshot on a push to an environment branch", () => {
  const withRepoConfig = { ...env, GITHUB_SERVICE_TOKEN: "t", GITHUB_REPO: "o/r", REPO_ENVIRONMENTS: JSON.stringify(ENVS) } as Env;

  it("a push to main (an environment branch) refreshes the drift snapshot", async () => {
    const fetchImpl = (async (u: RequestInfo | URL) => {
      const url = String(u);
      if (url.endsWith("/compare/production...main")) {
        return new Response(JSON.stringify({
          ahead_by: 2, behind_by: 0,
          commits: [{ sha: "c91d2aeXXXX", commit: { message: "rollup: batch D1 reads", committer: { date: "2026-09-20T09:00:00Z" } }, author: { login: "AndresL230" } }],
        }), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    }) as typeof fetch;
    const res = await postWebhook("push", pushFixture, withRepoConfig, { fetchImpl });
    expect(res.status).toBe(200);
    const snap = await getSnapshot<RepoDrift>(env.DB, "drift");
    expect(snap?.data).toMatchObject({ head: "main", base: "production", ahead: 2, behind: 0 });
  });

  it("a push to a non-environment branch attempts no compare", async () => {
    let calls = 0;
    const fetchImpl = (async () => { calls++; return new Response("[]", { status: 200 }); }) as typeof fetch;
    const offBranchPush = { ...pushFixture, ref: "refs/heads/feature/off-environment" };
    await postWebhook("push", offBranchPush, withRepoConfig, { fetchImpl });
    expect(calls).toBe(0);
    expect(await getSnapshot(env.DB, "drift")).toBeNull();
  });

  it("with no GITHUB_SERVICE_TOKEN, no fetch is attempted and no snapshot is written", async () => {
    let calls = 0;
    const fetchImpl = (async () => { calls++; return new Response("[]", { status: 200 }); }) as typeof fetch;
    const noToken = { ...env, GITHUB_REPO: "o/r", REPO_ENVIRONMENTS: JSON.stringify(ENVS) } as Env;
    await postWebhook("push", pushFixture, noToken, { fetchImpl });
    expect(calls).toBe(0);
    expect(await getSnapshot(env.DB, "drift")).toBeNull();
  });
});

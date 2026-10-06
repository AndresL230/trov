import type { CapturedEvent } from "@shared/contract";
import type { Env } from "./env";
import { platform, type TenantContext } from "./data/context";
import { ingestEvent, ingestRepoEvent } from "./consumer";
import { type Summarizer, type PrSummary, type IssueSummary, geminiPrSummarizer, geminiIssueSummarizer, storePrSummary, storeIssueSummary } from "./tools/summarize";
import { applyEventProgress } from "./tools/progress";
import { repoEventsFromDelivery, metricsFromStatus } from "./repo/capture";
import { orgEnvironments } from "./repo/config";
import { putMetric } from "./repo/store";
import { fillFailedJob, refreshDrift, scrubbedMessage } from "./repo/github";
import { mirrorIssue } from "./tools/ticket-mirror";

// The GitHub webhook is Trov's THIRD auth class. Unlike the session cookie
// (humans) and the bearer token (agents), a delivery authenticates itself by an
// HMAC-SHA256 signature over the raw body against the `github_webhook` secret of the
// repo its URL names. Once the HMAC verifies, the delivery's own claims (subject_login,
// issue-group counts) are trusted and captured verbatim through ingestEvent. The writer
// principal is the fixed string "github-webhook" — the webhook owner, not any OAuth identity.
//
// TWO HALVES. Resolving the hook's org, reading its secret and verifying the signature
// is src/github-hook.ts (`handleGithubWebhook`). THIS module is the capture that follows
// (`captureDelivery`) plus the pure derivations — it is reachable from src/mcp.ts
// (tools/sprints → tools/progress → here), so it may never import src/data/secrets.ts:
// the one credential it uses, the org's GitHub token, is handed in by the entry point.

// ---------------------------------------------------------------------------
// HMAC verification. GitHub sends `X-Hub-Signature-256: sha256=<hex>`. We decode
// the hex back to bytes and use crypto.subtle.verify (constant-time comparison).
// Any malformed/absent header returns false; nothing here ever throws.
// ---------------------------------------------------------------------------
export async function verifyGithubSignature(
  secret: string,
  rawBody: string,
  sigHeader: string | null
): Promise<boolean> {
  if (!sigHeader || !sigHeader.startsWith("sha256=")) return false;
  const hex = sigHeader.slice("sha256=".length);
  // A valid hex digest is a non-empty, even-length run of hex digits.
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return false;

  const sigBytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < sigBytes.length; i++) {
    sigBytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    return await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(rawBody));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Minimal typed views over the (post-HMAC, trusted) GitHub payloads. Only the
// fields the derivation reads are modeled; everything else is ignored.
// ---------------------------------------------------------------------------
interface GhUser {
  login: string;
}
/** GitHub's issue GROUP object (its own `milestone` payload key). */
interface GhGroup {
  number: number;
  title?: string | null;
  due_on?: string | null;
  open_issues?: number;
  closed_issues?: number;
}
interface GhLabel {
  name: string;
}
interface GhPullRequest {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  merged: boolean;
  merged_at: string | null;
  closed_at: string | null;
  user: GhUser;
  milestone?: GhGroup | null; // GitHub's own key — not Trov vocabulary
  base?: { ref: string } | null;
}
interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: string;
  state_reason?: string | null; // completed / not_planned / duplicate / reopened — GitHub's own values
  updated_at: string;
  user: GhUser;
  assignees?: GhUser[];
  labels?: (string | GhLabel)[];
  milestone?: GhGroup | null; // GitHub's own key — not Trov vocabulary
  pull_request?: unknown; // present only when the "issue" is really a PR
}
interface PrPayload {
  action?: string;
  pull_request?: GhPullRequest;
}
interface IssuePayload {
  action?: string;
  issue?: GhIssue;
  assignee?: GhUser;
  repository?: { full_name?: string } | null; // scopes the ticket mirror to GITHUB_REPO
}

const ISSUE_ACTIONS = [
  "opened",
  "edited",
  "assigned",
  "unassigned",
  "closed",
  "reopened",
  // GitHub's own action names — not Trov vocabulary.
  "milestoned",
  "demilestoned",
  // The issue LEFT the repo. Its snapshot still reads state "open", so every
  // open-issue reader checks the action too (src/tools/issue-gone.ts).
  "deleted",
  "transferred",
];

// ---------------------------------------------------------------------------
// PURE: derive the CapturedEvent(s) a single delivery produces. Returns [] for
// anything we do not capture (non-close PRs, PRs masquerading as issues, unknown
// issue actions, unhandled event names, or a non-object payload).
// ---------------------------------------------------------------------------
export function eventsFromDelivery(eventName: string, payload: unknown): CapturedEvent[] {
  if (payload === null || typeof payload !== "object") return [];

  if (eventName === "pull_request") {
    const p = payload as PrPayload;
    if (p.action !== "closed") return [];
    const pr = p.pull_request;
    if (!pr) return [];

    const merged = pr.merged === true;
    const raw = JSON.stringify({
      pr: {
        number: pr.number,
        title: pr.title,
        body: pr.body,
        html_url: pr.html_url,
        merged,
        merged_at: pr.merged_at,
        closed_at: pr.closed_at,
        user: { login: pr.user.login },
        // GitHub's own key — not Trov vocabulary (the raw snapshot mirrors it).
        milestone: pr.milestone ? { number: pr.milestone.number } : null,
        base: pr.base ? { ref: pr.base.ref } : null,
      },
    });
    return [
      {
        semantic_key: `gh:pr:${pr.number}:${merged ? "merged" : "closed"}`,
        event_type: merged ? "pr_merged" : "pr_closed",
        ref_number: pr.number,
        subject_login: pr.user.login,
        raw,
        provenance: "webhook",
        occurred_at: pr.merged_at ?? pr.closed_at ?? undefined,
      },
    ];
  }

  if (eventName === "issues") {
    const p = payload as IssuePayload;
    const issue = p.issue;
    if (!issue) return [];
    if (issue.pull_request) return []; // a PR delivered on the issues event — not our surface
    const action = p.action ?? "";
    if (!ISSUE_ACTIONS.includes(action)) return [];

    const updatedAt = issue.updated_at;
    const isAssign = action === "assigned" || action === "unassigned";
    const assigneeLogin = p.assignee?.login;
    const assignees = issue.assignees ?? [];

    // assigned/unassigned are ABOUT the assignee; every other action is about the
    // issue's current owner (first assignee, else the author).
    const subjectLogin = isAssign
      ? assigneeLogin ?? issue.user.login
      : assignees[0]?.login ?? issue.user.login;

    // The semantic key carries updated_at so a genuine later edit is a new event,
    // while a redelivery of the same snapshot collapses. assigned/unassigned also
    // embed the assignee so two people assigned in the same tick stay distinct.
    const semanticKey = isAssign
      ? `gh:issue:${issue.number}:${action}:${assigneeLogin}:${updatedAt}`
      : `gh:issue:${issue.number}:${action}:${updatedAt}`;

    const raw = JSON.stringify({
      action,
      issue: {
        number: issue.number,
        title: issue.title,
        body: issue.body,
        html_url: issue.html_url,
        state: issue.state,
        state_reason: issue.state_reason ?? null,
        updated_at: updatedAt,
        user: { login: issue.user.login },
        assignees: assignees.map((a) => ({ login: a.login })),
        labels: (issue.labels ?? [])
          .map((l) => (typeof l === "string" ? l : l.name))
          .filter(Boolean),
        // GitHub's own key — not Trov vocabulary (the raw snapshot mirrors it).
        milestone: issue.milestone
          ? {
              number: issue.milestone.number,
              title: issue.milestone.title ?? null,
              due_on: issue.milestone.due_on ?? null,
              open_issues: issue.milestone.open_issues,
              closed_issues: issue.milestone.closed_issues,
            }
          : null,
      },
    });

    return [
      {
        semantic_key: semanticKey,
        event_type: "issue",
        ref_number: issue.number,
        subject_login: subjectLogin,
        raw,
        provenance: "webhook",
        occurred_at: updatedAt,
      },
    ];
  }

  return [];
}

// ---------------------------------------------------------------------------
// PURE: the absolute progress this issue event implies for its GitHub issue
// GROUP — `groupNumber` is the number on the group the issue belongs to, which a
// sprint's `github_ref` may point at — or null when the issue is in no group.
// total = open + closed (GitHub's own counts), so ordering of deliveries is
// irrelevant — later writes just overwrite.
// ---------------------------------------------------------------------------
export function progressFromIssueEvent(
  payload: unknown
): { groupNumber: number; closed: number; total: number } | null {
  if (payload === null || typeof payload !== "object") return null;
  const issue = (payload as IssuePayload).issue;
  const m = issue?.milestone; // GitHub's own key — not Trov vocabulary
  if (!m || m.open_issues == null || m.closed_issues == null) return null;
  return {
    groupNumber: m.number,
    closed: m.closed_issues,
    total: m.open_issues + m.closed_issues,
  };
}

// ---------------------------------------------------------------------------
// Downstream projections, hung off each NEWLY-WRITTEN event. Both seams are
// filled: summarizePrSeam (Task 4) and progressSeam (Task 5). Issue events
// never reach storePrSummary, and PR events never reach progressSeam — the
// branch in handleGithubWebhook keeps them disjoint.
// ---------------------------------------------------------------------------

// Task 4: parse the PR event's own `raw` (its title/body — nothing else) and
// store a capture-time summary. `summarizer` is already resolved by the
// caller (an explicit `opts.summarizer` — null included — else the env's Gemini one, else null);
// storePrSummary itself never throws, so a summary failure never fails capture.
async function summarizePrSeam(ctx: TenantContext, summarizer: Summarizer<PrSummary> | null, event: CapturedEvent): Promise<void> {
  const parsed = JSON.parse(event.raw) as { pr: { number: number; title: string; body: string | null } };
  await storePrSummary(ctx, summarizer, {
    semantic_key: event.semantic_key,
    pr_number: parsed.pr.number,
    title: parsed.pr.title,
    body: parsed.pr.body ?? "",
  });
}

// Task 4: mirror summarizePrSeam for issues, but ONLY on the "assigned" action —
// unassigned/opened/closed issue events never need a summary (they never
// appear in anyone's to-do). Action isn't distinguishable from event_type
// alone (every issue action is captured as event_type:"issue"), so it's read
// back off the event's own raw JSON.
async function summarizeIssueSeam(ctx: TenantContext, summarizer: Summarizer<IssueSummary> | null, event: CapturedEvent): Promise<void> {
  const parsed = JSON.parse(event.raw) as { action: string; issue: { number: number; title: string; body: string | null } };
  if (parsed.action !== "assigned") return;
  await storeIssueSummary(ctx, summarizer, {
    issue_number: parsed.issue.number,
    title: parsed.issue.title,
    body: parsed.issue.body ?? "",
  });
}

// Task 5: apply this newly-captured issue event's implication(s) to the
// sprint_progress cache (absolute overwrite — see applyEventProgress).
async function progressSeam(ctx: TenantContext, payload: unknown): Promise<void> {
  await applyEventProgress(ctx, payload);
}

/** Deliveries the My Work capture (`events`) reads. */
const WORK_EVENT_NAMES = ["pull_request", "issues"];
/** Deliveries the repo dashboard capture (`repo_events`) reads. `status` (Task
 *  14) is a sibling arm: it feeds `repo_metrics`, not `repo_events` — see the
 *  branch below. The list is complete for the five-phase capture plan; GitHub
 *  only delivers the ones the repo's webhook is SUBSCRIBED to. */
export const REPO_EVENT_NAMES: readonly string[] = ["pull_request", "push", "pull_request_review", "deployment_status", "check_run", "workflow_run", "status"];

// ---------------------------------------------------------------------------
// The capture of ONE VERIFIED delivery, for the org it was verified for. The
// entry point (src/github-hook.ts) has already checked the HMAC against that
// repo's secret and that the payload names that repo; `ctx` is the org's
// "github-webhook" system tenant. Derive events, capture each through the single
// gate, and hang the summary/progress seams off the newly-written ones. The SAME
// delivery is also read a second, independent time for the repo dashboard's
// capture (`repo_events`) — a failure there must never cost the My Work capture.
// ---------------------------------------------------------------------------
export interface DeliveryScope {
  /** The org's PRIMARY repo, `owner/repo` — the hook's own: what the ticket mirror is scoped to and
   *  what the failed-job lookup and the drift refresh read. */
  repo: string;
  /** The org's GitHub token, revealed — or null when it has none. LAZY: only a failed run or a push
   *  to an environment branch needs it, so most deliveries never resolve it. */
  githubToken: () => Promise<string | null>;
}

export interface DeliveryOpts {
  summarizer?: Summarizer<PrSummary> | null;
  issueSummarizer?: Summarizer<IssueSummary> | null;
  // Live from Task 8: the failed-job lookup below reads fetchImpl and, when
  // given, schedules itself via waitUntil so the webhook response isn't held
  // up (GitHub gives a hook 10s). Task 11 adds a second use: the branch-drift
  // snapshot refresh on a push to an environment branch.
  fetchImpl?: typeof fetch;
  waitUntil?: (p: Promise<unknown>) => void;
  /** The ticket mirror (injectable so a test can make it throw). */
  mirror?: typeof mirrorIssue;
}

export async function captureDelivery(
  ctx: TenantContext,
  env: Env,
  scope: DeliveryScope,
  eventName: string,
  rawBody: string,
  opts?: DeliveryOpts
): Promise<Response> {
  const forWork = WORK_EVENT_NAMES.includes(eventName);
  const forRepo = REPO_EVENT_NAMES.includes(eventName);
  if (!forWork && !forRepo) {
    // Verified, but not a surface we capture (ping, star, …).
    return json({ ok: true, ignored: true });
  }

  let payload: unknown = null;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    payload = null; // both derivations treat a non-object payload as []
  }

  let captured = 0;
  let unchanged = 0;
  if (forWork) {
    for (const ev of eventsFromDelivery(eventName, payload)) {
      const res = await ingestEvent(ctx, platform(env, "github-webhook"), ev, "github-webhook");
      if (res.outcome !== "written") { unchanged++; continue; }
      captured++;
      if (ev.event_type === "pr_merged" || ev.event_type === "pr_closed") {
        // `!== undefined`, not `??`: an EXPLICIT `summarizer: null` means "no
        // summarizer" — `??` skips null as well and fell through to the env one.
        const summarizer = opts?.summarizer !== undefined
          ? opts.summarizer
          : env.GEMINI_API_KEY ? geminiPrSummarizer(env.GEMINI_API_KEY) : null;
        await summarizePrSeam(ctx, summarizer, ev);
      } else if (ev.event_type === "issue") {
        await progressSeam(ctx, payload);
        const issueSummarizer = opts?.issueSummarizer !== undefined
          ? opts.issueSummarizer
          : env.GEMINI_API_KEY ? geminiIssueSummarizer(env.GEMINI_API_KEY) : null;
        await summarizeIssueSeam(ctx, issueSummarizer, ev);
      }
    }

    // The ticket mirror (src/tools/ticket-mirror.ts): every GitHub issue of
    // the org's primary repo is a ticket. It runs on EVERY verified `issues` delivery, not
    // only when ingestEvent wrote — a redelivery is how a half-failed mirror
    // heals, and the mirror is idempotent on its own (source_ref + the
    // updated_at ordering guard). A computed write from a verified delivery, so
    // no consume(); and a failure here must never cost the events capture above.
    if (eventName === "issues") {
      try {
        await (opts?.mirror ?? mirrorIssue)(ctx, platform(env, "github-webhook"), scope.repo, payload);
      } catch (e) {
        console.error("ticket mirror failed", e instanceof Error ? e.message : String(e));
      }
    }
  }

  // The repo dashboard's capture: a second, independent reading of the SAME
  // verified delivery. A failure here must never cost the My Work capture above.
  const repo = { captured: 0, unchanged: 0 };
  if (forRepo) {
    // The org's GitHub token, once it has been asked for — kept so the log line below can scrub it.
    let token: string | null = null;
    const gh = async (): Promise<{ token: string; repo: string; fetchImpl?: typeof fetch } | null> => {
      token = await scope.githubToken();
      return token ? { token, repo: scope.repo, fetchImpl: opts?.fetchImpl } : null;
    };
    try {
      // Read once per delivery, not per event — reused below for the
      // drift-refresh trigger as well as the event derivation itself.
      const cfgs = await orgEnvironments(ctx);
      if (eventName === "status") {
        // A SIBLING arm, not a row through repoEventsFromDelivery/ingestRepoEvent:
        // a status produces repo_metrics points, never a repo_events row. Most
        // statuses (Railway's, CodeRabbit's) carry no canopy/* context and cost
        // one cheap parse in metricsFromStatus, which returns no metrics AND no
        // drop reason for them. metricsFromStatus stays PURE (no console) — it
        // only reports WHY a canopy/* status was dropped; this is the one place
        // that logs it, once, naming the context and reason (never the raw
        // description beyond ~40 chars — metricsFromStatus already truncates it).
        const outcome = metricsFromStatus(payload, cfgs);
        if (outcome.dropped) {
          console.warn("repo capture: dropped status", outcome.dropped.context, "-", outcome.dropped.reason);
        }
        for (const m of outcome.metrics) {
          if (await putMetric(ctx, m)) repo.captured++; else repo.unchanged++;
        }
      } else {
        for (const ev of repoEventsFromDelivery(eventName, payload, cfgs)) {
          const res = await ingestRepoEvent(ctx, ev);
          if (res.outcome !== "written") { repo.unchanged++; continue; }
          repo.captured++;
          if (ev.kind === "run" && (ev.state === "failure" || ev.state === "timed_out") && ev.number) {
            const ghOpts = await gh();
            if (ghOpts) {
              const job = fillFailedJob(ctx, ghOpts, ev.number, ev.semantic_key);
              // Off the response path when the runtime allows; GitHub gives a hook 10s.
              if (opts?.waitUntil) opts.waitUntil(job); else await job;
            }
          }
          if (ev.kind === "push" && cfgs.some((c) => c.branch === ev.ref)) {
            const ghOpts = await gh();
            if (ghOpts) {
              const drift = refreshDrift(ctx, ghOpts, cfgs);
              if (opts?.waitUntil) opts.waitUntil(drift); else await drift;
            }
          }
        }
      }
    } catch (e) {
      // The message only, scrubbed of the token if one was revealed — never the Error object.
      console.error("repo capture failed", eventName, scrubbedMessage(e, token ?? ""), `org=${ctx.orgId}`);
    }
  }

  return json({ ok: true, captured, unchanged, repo });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

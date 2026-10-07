// Backfill Trov's captured `events` table from GitHub REST by synthesizing
// signed webhook deliveries and POSTing them through the SAME gate
// (/webhook/github, src/webhook.ts handleGithubWebhook) that live deliveries
// go through — there is no second write path here, only a client that
// reconstructs history as if GitHub had delivered it.
//
// Fetches from REPO:
//   (a) PRs closed in the last 14 days       → one `pull_request` "closed" delivery each
//   (b) all open issues (PRs excluded)       → one `issues` "assigned" (has an
//                                               assignee) or "opened" (no assignee)
//                                               delivery each
// The synthesized bodies use the same raw slice shape as test/fixtures/*.json;
// the worker only reads the fields eventsFromDelivery models, so anything
// GitHub-shaped works.
//
// Idempotent by construction: the worker derives its semantic_key from each
// delivery's own content (number + action + timestamp), and the gate does
// INSERT OR IGNORE on that key — so re-running this script against the same
// GitHub state reports everything "unchanged" the second time.
//
// Usage:
//   WEBHOOK_URL=http://localhost:8787/webhook/github \
//   GITHUB_WEBHOOK_SECRET=dev-webhook-secret \
//   REPO=SaplingLearn/sapling \
//   GITHUB_TOKEN=$(gh auth token) \
//   node scripts/backfill-events.mjs [--dry]
//
// Env:
//   WEBHOOK_URL            default http://localhost:8787/webhook/github
//   GITHUB_WEBHOOK_SECRET  required unless --dry (must match the worker's secret)
//   REPO                   default SaplingLearn/sapling ("owner/repo")
//   GITHUB_TOKEN           falls back to `gh auth token` if unset
//
// --dry   fetch from GitHub and print the deliveries that WOULD be posted
//         (event name, semantic identity, subject) without posting any of them.

import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";

const WEBHOOK_URL = process.env.WEBHOOK_URL ?? "http://localhost:8787/webhook/github";
const SECRET = process.env.GITHUB_WEBHOOK_SECRET;
const REPO = process.env.REPO ?? "SaplingLearn/sapling";
const DRY = process.argv.includes("--dry");
const DAYS_BACK = 14;

function resolveToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

const TOKEN = resolveToken();

if (!DRY && !SECRET) {
  console.error("GITHUB_WEBHOOK_SECRET is required to POST deliveries (or pass --dry).");
  process.exit(1);
}
if (!TOKEN) {
  console.error("No GitHub token: set GITHUB_TOKEN, or authenticate the gh CLI (`gh auth login`).");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// GitHub REST — minimal paginated GET, following the Link header.
// ---------------------------------------------------------------------------
async function ghGet(path) {
  const results = [];
  let url = `https://api.github.com${path}`;
  while (url) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "trov-backfill-script",
      },
    });
    if (!res.ok) {
      throw new Error(`GitHub API ${path} -> HTTP ${res.status}: ${await res.text()}`);
    }
    results.push(...(await res.json()));
    const link = res.headers.get("link");
    const next = link?.split(",").find((part) => part.includes('rel="next"'));
    url = next ? (next.match(/<([^>]+)>/)?.[1] ?? null) : null;
  }
  return results;
}

// ---------------------------------------------------------------------------
// Synthesize delivery bodies — same raw slice shapes as test/fixtures/*.json.
// Only fields eventsFromDelivery (src/webhook.ts) reads need to be present;
// everything else is ignored by the worker.
// ---------------------------------------------------------------------------
function prClosedDelivery(pr) {
  return {
    action: "closed",
    number: pr.number,
    pull_request: {
      number: pr.number,
      title: pr.title,
      body: pr.body,
      html_url: pr.html_url,
      // The pulls-list endpoint has no `merged` boolean (that's single-PR-fetch
      // only); merged_at is set iff the PR was merged, which is equivalent.
      merged: pr.merged_at != null,
      merged_at: pr.merged_at,
      closed_at: pr.closed_at,
      user: { login: pr.user.login },
      milestone: pr.milestone
        ? {
            number: pr.milestone.number,
            open_issues: pr.milestone.open_issues,
            closed_issues: pr.milestone.closed_issues,
          }
        : null,
    },
  };
}

function issueDelivery(issue) {
  const assignee = issue.assignees?.[0] ?? issue.assignee ?? null;
  const action = assignee ? "assigned" : "opened";
  return {
    action,
    // The ticket mirror scopes on repository.full_name (== GITHUB_REPO); a list
    // item carries no repository object, so the reconstruction adds it.
    repository: { full_name: REPO },
    ...(assignee ? { assignee: { login: assignee.login } } : {}),
    issue: {
      number: issue.number,
      title: issue.title,
      body: issue.body ?? null,
      html_url: issue.html_url,
      state: issue.state,
      state_reason: issue.state_reason ?? null,
      updated_at: issue.updated_at,
      user: { login: issue.user.login },
      assignees: (issue.assignees ?? []).map((a) => ({ login: a.login })),
      labels: issue.labels ?? [],
      milestone: issue.milestone
        ? {
            number: issue.milestone.number,
            open_issues: issue.milestone.open_issues,
            closed_issues: issue.milestone.closed_issues,
          }
        : null,
    },
  };
}

// Mirrors the semantic_key derivation in eventsFromDelivery (src/webhook.ts)
// for logging only — the worker recomputes its own, this is not sent over the
// wire and never needs to match byte-for-byte, just be a useful log label.
function semanticIdentity(eventName, body) {
  if (eventName === "pull_request") {
    const pr = body.pull_request;
    return `gh:pr:${pr.number}:${pr.merged ? "merged" : "closed"}`;
  }
  const issue = body.issue;
  return body.action === "assigned"
    ? `gh:issue:${issue.number}:assigned:${body.assignee.login}:${issue.updated_at}`
    : `gh:issue:${issue.number}:opened:${issue.updated_at}`;
}

function subjectOf(body) {
  return body.pull_request?.user.login ?? body.assignee?.login ?? body.issue?.user.login;
}

function sign(rawBody) {
  return "sha256=" + createHmac("sha256", SECRET).update(rawBody).digest("hex");
}

async function postDelivery(eventName, body) {
  const identity = semanticIdentity(eventName, body);
  const subject = subjectOf(body);

  if (DRY) {
    console.log(`[dry] ${eventName} ${identity} subject=${subject}`);
    return "dry";
  }

  const raw = JSON.stringify(body);
  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": eventName,
      "x-hub-signature-256": sign(raw),
    },
    body: raw,
  });
  if (!res.ok) {
    console.error(`  ! ${eventName} ${identity} subject=${subject} -> HTTP ${res.status}`);
    return "error";
  }
  const json = await res.json();
  const outcome = json.captured > 0 ? "captured" : "unchanged";
  console.log(`  ${eventName} ${identity} subject=${subject} -> ${outcome}`);
  return outcome;
}

async function main() {
  const [owner, repo] = REPO.split("/");
  if (!owner || !repo) throw new Error(`REPO must be "owner/repo", got: ${REPO}`);

  const since = new Date(Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000);
  console.log(
    `Backfilling ${REPO}: PRs closed since ${since.toISOString()}, all open issues.` +
      (DRY ? " (--dry, not posting)" : ` -> ${WEBHOOK_URL}`)
  );

  const closedPrs = (
    await ghGet(`/repos/${owner}/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100`)
  ).filter((pr) => pr.closed_at && new Date(pr.closed_at) >= since);

  const openIssues = (await ghGet(`/repos/${owner}/${repo}/issues?state=open&per_page=100`)).filter(
    (issue) => !issue.pull_request // the issues endpoint also returns PRs; those aren't our surface here
  );

  const counts = { captured: 0, unchanged: 0, error: 0, dry: 0 };

  console.log(`\n${closedPrs.length} closed PR(s):`);
  for (const pr of closedPrs) {
    counts[await postDelivery("pull_request", prClosedDelivery(pr))]++;
  }

  console.log(`\n${openIssues.length} open issue(s):`);
  for (const issue of openIssues) {
    counts[await postDelivery("issues", issueDelivery(issue))]++;
  }

  console.log(
    `\nDone. ${closedPrs.length + openIssues.length} delivery(ies). ` +
      (DRY
        ? `${counts.dry} would-post.`
        : `captured=${counts.captured} unchanged=${counts.unchanged} error=${counts.error}`)
  );
  if (counts.error > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.stack ?? String(err));
  process.exit(1);
});

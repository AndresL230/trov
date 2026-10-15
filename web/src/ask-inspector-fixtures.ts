// Ask Trov — the inspector's sample data (DEV REPLAY + TESTS ONLY; loaded on demand, never on a real read).
//
// What `GET /ask/item/:ref` answers (`AskItem.detail`, src/ai/ask/routes.ts) for the design's items
// (ask-trov.dc.html L1117–1146), keyed by the refs of shared/ai-fixtures.ts `askRefFixtures`, so the dev replay's
// `insp:<type>` scenarios show what the design shows. The replay's `getItem` reads `inspectorDetailFixture`
// (web/src/ask-replay.ts); the render tests read it too.
//
// CONTRACT GAP (reported): `upload` and `chart` have no RefView fixture — an upload is a question's attachment and a
// chart an answer's block, so neither is a ref the server resolves. `INSPECTOR_LOCAL_FIXTURES` holds the design's
// ci-failure.png and merged-PR chart for the `insp:upload` / `insp:chart` scenarios and the tests.

import type { AiRepoState } from "@shared/ai-core";
import type { AskAttachment, AskChart, RefView } from "@shared/ai-ask-core";
import type { AskCtx } from "./ask-state";
import type { InspectorLocal } from "./ask-inspector";

const H = 3_600_000;
const D = 24 * H;

/** A ticket row with the fields a fixture does not care about filled in. */
function ticketRow(id: number, title: string, status: string, assignees: string[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, title, body: "", category: "request", priority: "normal", status, requester: "andres", parent_id: null, sprint_id: 7,
    created_at: "2026-10-01T09:00:00Z", updated_at: "2026-10-14T09:00:00Z", source: "canopy", source_ref: null, source_author: null,
    source_updated_at: null, board_rank: null, depth: 0, assignees, ...over,
  };
}

/** The design's item details, as `/ask/item/:ref` answers them; null for a ref with none. `views` are the ref fixtures
 *  (the ticket's linked pull requests arrive as RefViews, as the route sends them). */
export function inspectorDetailFixture(ref: string, nowMs: number = Date.now(), views: Readonly<Record<string, RefView>> = {}): Record<string, unknown> | null {
  const ago = (ms: number): string => new Date(nowMs - ms).toISOString();
  switch (ref) {
    case "ticket:14":
      return {
        ticket: {
          ...ticketRow(14, "Guided repository setup", "in_progress", ["maya", "andres"], { category: "request", priority: "high", requester: "jon", created_at: ago(17 * D), updated_at: ago(2 * H) }),
          body: "Take a new org from \"no repository\" to a connected repo and a first deploy, one step at a time. Each step says what it needs and checks it before moving on.",
          links: [], events: [], parent: null,
          children: [
            { id: 21, title: "Detect the framework from package.json", status: "done" },
            { id: 22, title: "Connect step for Netlify", status: "in_progress" },
            { id: 23, title: "Empty state when the org has no repositories", status: "submitted" },
          ],
          comments: [
            { id: 1, ticket_id: 14, author: "maya", body: "Netlify step works locally. It is blocked on the connect test going green on main.", created_at: ago(3 * H) },
            { id: 2, ticket_id: 14, author: "andres", body: "The test still asserts on the old pill markup. I will fix it today.", created_at: ago(H) },
          ],
          sprint: { id: 7, label: "Hosting" },
        },
        artifacts: [],
        prs: ["pr:176", "pr:171"].flatMap((r) => (views[r] ? [views[r]] : [])),
      };
    case "pr:176":
      return {
        what: "Adds the Netlify step to guided setup: pick a site, confirm the build command, save the connection.",
        why: "Ticket #14 needs a hosting step before a new org can see its first deploy.",
        impact: "Unblocks most of #14. It can merge once the connect test passes on main.",
        linkedTo: ["ticket:14"], files: null, additions: null, deletions: null,
      };
    case "pr:173":
      return {
        what: "Replaces the bordered uppercase status pills with marks: a ring that fills for a ticket, signal bars for priority, and a shape with a word for other states.",
        why: "A pill on every row was noise and read as a control. Marks carry the same state with less weight, and read without colour.",
        impact: "Every board, table and rail changes. Tests that matched pill markup need updating; netlify-connect.test.ts is one of them.",
        linkedTo: ["ticket:24"], files: null, additions: null, deletions: null,
      };
    case "pr:171":
      return {
        what: "The first step of guided setup: pick a repository from the GitHub App installation.",
        why: "New orgs could not find where to connect a repository.",
        impact: "Setup starts from one screen. Later steps read the picked repository.",
        linkedTo: ["ticket:14"], files: null, additions: null, deletions: null,
      };
    case "doc:release-0-30-notes":
      return {
        body: "## What is new in 0.30\n\n- Status marks replace pills on every board, table and rail.\n- Guided setup starts with a repository picker.\n- Vercel deploys show on the Repo dashboard.\n\n## Fixed\n\nSprint forecasts no longer count declined tickets.",
        versions: [
          { version: 1, status: "promoted", created_by: "priya", created_at: ago(9 * D) },
          { version: 2, status: "staged", created_by: "priya", created_at: ago(2 * H) },
        ],
      };
    case "doc:hosting-connections":
      return {
        body: "## How a connection works\n\nAn org connects a hosting account once, in Org settings › Hosting. Trov keeps the token encrypted and polls the provider for deploys every 10 minutes.\n\n- Netlify and Vercel are supported.\n- Each environment maps to one site or project.\n- Deploys show on the Repo dashboard within one poll.",
        versions: [{ version: 4, status: "promoted", created_by: "andres", created_at: ago(3 * D) }],
      };
    case "sprint:7":
      return {
        sprint: {
          id: 7, label: "Hosting", summary: "Any org can connect Netlify or Vercel and see its deploys in Trov.", description: null, phase: null, dates: null,
          start: "2026-10-05", due: "2026-10-30", status: "in_progress", active: true, urgency: "normal", lead: "andres", domain: null, github_ref: null,
          created_at: "2026-10-01T09:00:00Z", created_by: "andres", updated_at: ago(H), progress: { closed: 7, total: 12, pct: 58 }, issues: null,
          members: ["andres", "maya", "jon", "priya"],
          tickets: [
            ticketRow(14, "Guided repository setup", "in_progress", ["maya"]),
            ticketRow(18, "Hosting connections: Netlify and Vercel", "in_progress", ["andres"]),
            ticketRow(22, "Connect step for Netlify", "in_progress", ["maya"]),
            ticketRow(26, "Vercel deploy webhooks", "testing", ["andres"]),
            ticketRow(19, "Reconnect expired hosting tokens", "submitted", []),
            ticketRow(23, "Empty state when the org has no repositories", "submitted", ["jon"]),
            ticketRow(21, "Detect the framework from package.json", "done", ["maya"]),
            ticketRow(17, "Encrypt hosting tokens at rest", "done", ["andres"]),
            ticketRow(16, "Integrations tab in Org settings", "done", ["priya"]),
            ticketRow(15, "Hosting provider registry", "done", ["andres"]),
            ticketRow(13, "Poll deploys every 10 minutes", "done", ["andres"]),
            ticketRow(12, "Token refresh before expiry", "done", ["maya"]),
            ticketRow(11, "Deploy rows on the Repo dashboard", "done", ["priya"]),
          ],
          resources: [],
        },
      };
    case "handoff:11":
      return {
        handoff: {
          id: 11, sender: "andres", recipient: "anyone", status: "pending", created_at: ago(3 * H), claimed_at: null, claimed_by: null, claimed_by_session: null, prompt: null,
          body: "Carry the performance plan forward",
          context: {
            repo: "AndresL230/trov", branch: "main",
            task: "Pick up the performance plan where the last session stopped: batch the D1 reads in the usage rollup, then measure the Repo dashboard again.",
            done: ["Profiled the Repo dashboard read: 38 D1 queries per load", "Wrote the plan up in Performance plan v3"],
            next: ["Batch the usage rollup reads into one query", "Re-measure the dashboard and record the numbers", "Propose the result as an edit to Performance plan"],
            files: ["src/tools/repo.ts", "src/data/usage.ts", "docs/architecture/repo-dashboard.md"],
          },
        },
      };
    case "feed:41":
      return {
        entry: {
          id: 41, author: "priya", summary: "Status marks replace pills", brief: "Every board, table and rail now shows state as a mark instead of a pill.",
          body: "Tickets show a ring that fills as they move along, and priority is signal bars. Other states are a small shape and a sentence-case word.\n\nTwo tests that matched pill markup were updated. netlify-connect.test.ts was missed and fails on main.",
          artifacts: JSON.stringify({ prs: ["173"], commits: ["a1c9e2f4b"], issues: [] }), created_at: ago(2 * D),
        },
      };
    case "person:maya": return { recentPrs: ["pr:176", "pr:171", "pr:173"] };
    case "person:andres": return { recentPrs: ["pr:178"] };
    case "artifact:hosting-status-oct-15":
      // No raw page in the replay's database: the viewer shows its "no preview" frame rather than a 404 page.
      return { kind: "html", version: 1, visibility: "private", status: "draft", raw_url: null };
    case "repo:AndresL230/trov": return {};
    default: return null;
  }
}

/** The design's repository State (L1140), as the Repo dashboard's `state` (AiRepoState) carries it. */
export function repoStateFixture(nowMs: number = Date.now()): AiRepoState {
  const line = (text: string) => ({ text, cites: [] });
  return {
    state: "ready", generatedAt: new Date(nowMs - 2 * H).toISOString(), model: "claude-haiku-5-5", resumesOn: null, upgrade: false,
    headline: "Hosting is close. One test is red on main, and it holds up the Netlify step.",
    shipped: [line("Status marks replace pills"), line("Repository picker in guided setup"), line("Encrypted hosting tokens")],
    inFlight: [line("Netlify connect step, PR #176"), line("Vercel deploy webhooks, in testing"), line("Release 0.30")],
    attention: [line("netlify-connect.test.ts fails on main"), line("Hosting sprint forecast 3 days late")],
    eventCount: 6,
  };
}

/** The design's upload (ci-failure.png, 412 KB) and chart (merged PRs by week). */
export const UPLOAD_FIXTURE: AskAttachment = {
  id: 901, slug: "ci-failure-png", title: "ci-failure.png", kind: "image", contentType: "image/png", size: 421_888, sha256: "",
};
export const CHART_FIXTURE: AskChart = {
  title: "Merged PRs by week", total: 48, unit: "merged pull requests", query: "merged_prs_by_week", params: { weeks: 8, repo: "AndresL230/trov" },
  rows: ([["Aug 24", 4], ["Aug 31", 6], ["Sep 7", 5], ["Sep 14", 8], ["Sep 21", 7], ["Sep 28", 3], ["Oct 5", 9], ["Oct 12", 6]] as [string, number][])
    .map(([label, value]) => ({ label, value })),
};
export const INSPECTOR_LOCAL_FIXTURES: Record<"upload" | "chart", { ref: string; item: InspectorLocal }> = {
  // `askcv:` refs like the conversation's own (ask-cvref.ts), on a message key no conversation has: `local` answers them.
  upload: { ref: `askcv:page:replay:upload:${UPLOAD_FIXTURE.id}`, item: { kind: "upload", att: UPLOAD_FIXTURE } },
  chart: { ref: "askcv:page:replay:chart:0", item: { kind: "chart", chart: CHART_FIXTURE } },
};

/** The replay's `insp:upload` / `insp:chart`: register the item and open it. */
export function openLocalFixture(ctx: AskCtx, type: "upload" | "chart"): void {
  const f = INSPECTOR_LOCAL_FIXTURES[type];
  ctx.ui.inspectorUi.local = { ...ctx.ui.inspectorUi.local, [f.ref]: f.item };
  ctx.openRef(f.ref);
}

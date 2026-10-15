/**
 * Field ABSENT renders exactly what it rendered before the AI screens existed.
 *
 * Production omits every AI field (`DashboardData.brief`, `RepoDashboard.state` / `themes`,
 * `FeedRow.ai`, `OrgUsage.ai` / `PlatformUsageResponse.ai`) until a producer exists, so with the
 * field absent each screen must paint byte-for-byte what it painted before: no State or "Where the
 * work went" section, no brief card, no Source switch, no first-run note, no AI usage line.
 *
 * The snapshots in `__snapshots__/render.ai-absent.test.ts.snap` were written by THIS file against
 * main's code, which has no AI screens (commit 45bf29a, `origin/main`; Repo re-pinned at 6c965ac5 after #185's hosting), at a fixed clock —
 * so a change to any of these screens' field-absent markup fails here.
 * One deliberate change since: My Work's header (the date top right, the stat line under the greeting), so
 * "My Work (no `brief`)" was re-pinned with it — the brief is still absent from it. Re-pinned again for the review
 * tile's sentence (no count repeated under the number) and the `mw-scroll` class on the tiles' lists, which only
 * the layout with a brief styles.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// marked + DOMPurify cannot run in this pool (no DOM) — the render tests' usual mock.
const mdMock = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
vi.mock("../web/src/markdown", () => ({
  renderMarkdown: (body: string) => `<div class="mock-live-md">${mdMock(body)}</div>`,
  renderMarkdownInline: (text: string) => mdMock(text),
}));
import { render, initialState, type AppState } from "../web/src/render";
import { usageView, orgUsageBlock } from "../web/src/platform-usage";
import { repoSample } from "../web/src/repo-sample";
import type { DashboardData, MyWorkTicket } from "@shared/dashboard";
import type { FeedRow } from "@shared/rows";
import type { OrgUsage, PlatformUsageResponse } from "@shared/orgs";

const NOW = new Date("2026-10-14T12:00:00.000Z");
beforeAll(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterAll(() => { vi.useRealTimers(); });

const iso = (msAgo: number): string => new Date(NOW.getTime() - msAgo).toISOString();
const ME = { handle: "alice", name: "Alice", avatar_url: null, color: "moss" as const, identities: [], orgs: [{ slug: "saplinglearn", name: "SaplingLearn", role: "admin" as const }], superadmin: false, pending_invites: 0 };

function app(o: Partial<AppState>): AppState {
  return {
    ...initialState(), view: "app", me: ME, orgSlug: "saplinglearn",
    persons: { status: "ok", data: [{ handle: "alice", name: "Alice", color: "moss", avatar_url: null, role: null }, { handle: "andres", name: "Andres", color: "sky", avatar_url: null, role: null }] },
    ...o,
  };
}

const ticket = (o: Partial<MyWorkTicket> = {}): MyWorkTicket => ({
  id: 12, title: "SSO login loops on Safari", body: "It bounces me back.", category: "bug", priority: "high", status: "submitted",
  source: "canopy", requester: "alice", sprint: { id: 3, label: "Sprint 13" }, updatedAt: iso(3_600_000), createdAt: iso(7_200_000), ...o,
});
export const absentDashboard = (): DashboardData => ({ person: "alice", previousActivity: [], todo: [], tickets: [ticket(), ticket({ id: 14, title: "Guided repository setup", priority: "normal" })], ticketsTotal: 2, degraded: false });

export const absentFeed = (): FeedRow[] => [
  { id: 2, author: "andres", summary: "Decision: hosting connections stay read-only", brief: "Trov reads deployments but never changes anything there.", body: "The **body**.", artifacts: JSON.stringify({ prs: ["173"], commits: ["65b9f1f"], issues: [] }), created_at: iso(3 * 3_600_000) },
  { id: 1, author: "alice", summary: "Shipped the colored-handle change", brief: null, body: null, artifacts: null, created_at: iso(26 * 3_600_000) },
];

describe("field absent — each screen renders exactly what it did before the AI kit", () => {
  it("My Work (no `brief`)", () => {
    expect(render(app({ screen: "mywork", mywork: { status: "ok", data: absentDashboard() } }))).toMatchSnapshot();
  });
  it("Feed, both views (no entry carries `ai`)", () => {
    for (const feedView of ["reading", "agents"] as const) {
      const rows = absentFeed();
      expect(render(app({ screen: "feed", feedView, feed: { status: "ok", data: rows }, feedAuthors: [...new Set(rows.map((r) => r.author))] }))).toMatchSnapshot(feedView);
    }
  });
  it("Repo › Overview and › Planning (no `state`, no `themes`)", () => {
    const data = repoSample(NOW.getTime());
    for (const repoTab of ["overview", "planning"] as const) {
      expect(render(app({ screen: "repo", repoTab, repo: { status: "ok", data }, repoFetchedAt: NOW.getTime() }))).toMatchSnapshot(repoTab);
    }
  });
  it("Platform › Usage and an organization's usage (no `ai`)", () => {
    const org: OrgUsage = {
      slug: "acme", name: "Acme", status: "active", created_at: "2026-09-01T10:00:00.000Z", last_activity_at: "2026-10-05T10:00:00.000Z",
      sizes: { members: 4, docs: 12, feed_entries: 3, tickets_open: 3, tickets_total: 9, sprints: 1, prompts: 0, handoffs: 1, artifacts: 2, artifact_bytes: 3 * 1024 * 1024, repo_events: 40, mcp_tokens: 1, oauth_grants: 1 },
      activity: {
        api_requests: 420, api_reads: 380, api_writes: 40, mcp_requests: 90, mcp_tool_calls: 64, active_people: 3,
        created: { feed_entries: 5, tickets: 2, doc_versions: 1, sprints: 0, prompts: 0, handoffs: 1, artifacts: 2 },
        emails_sent: 2, top_tools: [{ tool: "get_feed", count: 40 }],
      },
      series: [{ day: "2026-10-13", requests: 10, mcp_calls: 2 }, { day: "2026-10-14", requests: 30, mcp_calls: 5 }],
      summaries: { attempted: 4, succeeded: 3, failed: 1, capped: 0, fell_back: 1, chars_in: 900, chars_out: 200, tokens_in: 300, tokens_out: 60, month_used: 4, cap: 300 },
    };
    const usage: PlatformUsageResponse = {
      days: 7, since: "2026-10-08", until: "2026-10-14", generated_at: NOW.toISOString(), summaries_enabled: true,
      summaries: { attempted: 4, succeeded: 3, failed: 1, capped: 0, fell_back: 1, chars_in: 900, chars_out: 200, tokens_in: 300, tokens_out: 60 },
      totals: { orgs: 1, suspended_orgs: 0, persons: 4, last_activity_at: null, sizes: org.sizes, activity: org.activity, series: org.series },
      orgs: [org],
    };
    expect(usageView({ status: "ok", usage, days: 7, open: "acme" })).toMatchSnapshot("usage");
    expect(orgUsageBlock(org, 7)).toMatchSnapshot("org");
  });
});

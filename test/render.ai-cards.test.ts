/**
 * Phase C's three screens — the ticket detail, Unplaced and Review — with Trov's suggestions on them
 * (`ticket.category` / `ticket.priority` / `ticket.duplicate`, `unplaced.destination`, `review.risk`).
 *
 * FIELD ABSENT renders exactly what it rendered before: the snapshots under "field absent" were written by
 * THIS file against `ai/screens` at 15b639ef (before any of these screens drew a suggestion), at a fixed
 * clock — so a change to these screens' field-absent markup fails here.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

const mdMock = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
vi.mock("../web/src/markdown", () => ({
  renderMarkdown: (body: string) => `<div class="mock-live-md">${mdMock(body)}</div>`,
  renderMarkdownInline: (text: string) => mdMock(text),
}));
import { render, initialState, type AppState } from "../web/src/render";
import type { TicketDetail } from "@shared/tickets";
import type { AdrRow, NeedsTriageRow } from "@shared/rows";
import type { StagedProposal } from "../web/src/api";

const NOW = new Date("2026-10-15T12:00:00.000Z");
beforeAll(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterAll(() => { vi.useRealTimers(); });

const iso = (msAgo: number): string => new Date(NOW.getTime() - msAgo).toISOString();
const H = 3_600_000;
const ME = { handle: "alice", name: "Alice", avatar_url: null, color: "moss" as const, identities: [], orgs: [{ slug: "saplinglearn", name: "SaplingLearn", role: "admin" as const }], superadmin: false, pending_invites: 0 };

export function app(o: Partial<AppState>): AppState {
  return {
    ...initialState(), view: "app", me: ME, orgSlug: "saplinglearn",
    persons: { status: "ok", data: [{ handle: "alice", name: "Alice", color: "moss", avatar_url: null, role: null }, { handle: "andres", name: "Andres", color: "sky", avatar_url: null, role: null }] },
    ...o,
  };
}

export const ticketDetail = (o: Partial<TicketDetail> = {}): TicketDetail => ({
  id: 14, title: "Login page shows a blank screen on Safari", body: "Since this morning the login page is blank on Safari 18. Chrome works.",
  category: "other", priority: "normal", status: "submitted", requester: "alice", parent_id: null, sprint_id: null,
  created_at: iso(2 * H), updated_at: iso(H), source: "canopy", source_ref: null, source_author: null, source_updated_at: null, board_rank: null,
  assignees: [], links: [], comments: [], events: [{ id: 1, ticket_id: 14, actor: "alice", from_status: null, to_status: "submitted", created_at: iso(2 * H) }],
  parent: null, children: [], sprint: null,
  ...o,
});

export const triageRow = (o: Partial<NeedsTriageRow> = {}): NeedsTriageRow => ({
  id: 7, raw: JSON.stringify({ slug: "deploy-checklist", section: "runbooks", title: "Deploy checklist", body: "Before a deploy, run the migrations, then check the health endpoint.", change_summary: "New checklist", confidence: "high" }),
  reason: "section 'runbooks' is not in the vocabulary", source_author: "andres", resolved: 0, created_at: iso(3 * H),
  resolved_at: null, resolved_by: null, resolution: null, assigned_ref: null,
  ...o,
});

export const proposal = (o: Partial<StagedProposal> = {}): StagedProposal => ({
  slug: "auth-flow", version: 3, title: "Auth flow", section: "reference", space: "technical", summary: "Sessions now last 30 days",
  author: "andres", confidence: "high", status: "staged", change_kind: "edit", low_confidence: 0, base_version: 2, current_version: 2,
  created_at: iso(4 * H), stagedBody: "# Auth flow\n\nA session lasts 30 days.\n", promotedBody: "# Auth flow\n\nA session lasts 7 days.\n",
  ...o,
});

export const adr = (o: Partial<AdrRow> = {}): AdrRow => ({
  id: 5, title: "Use D1 for the search index", context: "Search needs an index.", decision: "Use D1's FTS5.", rationale: "One store.",
  status: "draft", confidence: "high", created_at: iso(5 * H), created_by: "andres", content_hash: null,
  ...o,
});

describe("field absent — each screen renders exactly what it did before Phase C", () => {
  it("ticket detail (no `ai`)", () => {
    expect(render(app({ screen: "ticketdetail", ticketId: 14, ticketDetail: { status: "ok", data: ticketDetail() } }))).toMatchSnapshot();
  });
  it("Unplaced (no row carries `ai`)", () => {
    expect(render(app({ screen: "maintenance", needsTriage: { status: "ok", data: [triageRow(), triageRow({ id: 8, raw: "a free-form note", reason: "Flagged by an agent" })] } }))).toMatchSnapshot();
  });
  it("Review (no row carries `ai`)", () => {
    expect(render(app({ screen: "review", proposals: { status: "ok", data: [proposal()] }, draftAdrs: { status: "ok", data: [adr()] } }))).toMatchSnapshot();
  });
});

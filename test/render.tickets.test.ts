/**
 * Phase 5a render tests — the SPA's ticket screens.
 *
 * Pure functions + `render()` over a hand-built AppState (no D1, no DOM), the
 * same idiom as test/render.review.test.ts and test/render.mywork.test.ts:
 *  • the sidebar entry + badge (design call #2)
 *  • queueView — grouping/order, hidden empty groups, the ACTIVE label, the
 *    needs-attention rule (call #6), the exact footer count, board columns per
 *    segment, the tinted pills (call #5) and the relation text
 *  • newTicketView — the inert Submit button and the design's defaults
 *  • ticketDetailView — legal moves only (call #7), link field ↔ "Linked to
 *    engineering work" (call #8), the sub-ticket candidate filter, the merged
 *    thread with "opened this ticket", the sprint menu's tick, assignee controls
 */
import { describe, it, expect, vi } from "vitest";

// marked + DOMPurify cannot run in this pool (no DOM) — same mock as
// render.sprints.test.ts: escapes, then turns **x** into <strong>, so a
// `<strong>` proves the body went through the markdown fn and an escaped
// `<script>` proves it never reached the DOM raw.
vi.mock("../web/src/markdown", () => ({
  renderMarkdownInline: (text: string) =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>"),
  renderMarkdown: (body: string) =>
    `<div class="mock-live-md">${body
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")}</div>`,
}));
import { render, initialState, type AppState } from "../web/src/render";
import {
  queueView, queueRows, newTicketView, ticketDetailView, ticketDeleteModal, relCandidates, queueGroups,
  ticketPill, priorityChip, age, avatarStack, SEG_STATUSES,
  type QueueProps, type NewTicketProps, type TicketDetailProps,
} from "../web/src/tickets";
import type { TicketListItem, TicketDetail, TicketLinkRow, TicketCommentRow, TicketEventRow } from "@shared/tickets";
import { TICKET_STATUS_LABEL, TICKET_STATUSES, type TicketStatus } from "@shared/tickets";
import type { SprintView } from "@shared/sprints";
import type { PersonSummary } from "../web/src/api";
import { WORK_SHELL, DETAIL_SHELL } from "../web/src/ui";

/** The one `.cnpy-sfbar` (search + Filter) element in `html`, balanced by its divs — or null. */
function sfbar(html: string): string | null {
  const start = html.indexOf('<div class="cnpy-sfbar"');
  if (start < 0 || html.indexOf('<div class="cnpy-sfbar"', start + 1) >= 0) return null;
  const re = /<div\b|<\/div>/g;
  re.lastIndex = start;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[0] === "</div>" ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + 6);
  }
  return null;
}

// ── fixtures ─────────────────────────────────────────────────────────────────

const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const H = 3600_000;
const D = 86_400_000;

const PERSONS: PersonSummary[] = [
  { handle: "meilin", name: "Meilin Zhao", color: "rose", avatar_url: null },
  { handle: "sanaok", name: "Sana Okafor", color: "ochre", avatar_url: null },
  { handle: "jose-a", name: "Jose Alvarez", color: "moss", avatar_url: null },
];

function sprint(o: Partial<SprintView> & { id: number; label: string }): SprintView {
  return {
    summary: null, description: null, phase: "Phase 2", dates: "SEP 8 – 19", start: null, due: "2026-09-26",
    status: "upcoming", active: false, urgency: "normal", lead: null, domain: null,
    github_ref: null, created_at: ago(30 * D), created_by: "jose-a", updated_at: null,
    progress: { closed: 0, total: 0, pct: 0 },
    issues: null, members: [],
    ...o,
  };
}

function ticket(o: Partial<TicketListItem> & { id: number; title: string }): TicketListItem {
  return {
    body: "", category: "bug", priority: "normal", status: "submitted", requester: "meilin",
    parent_id: null, sprint_id: null, created_at: ago(2 * H), updated_at: ago(1 * H),
    source: "canopy", source_ref: null, source_author: null, source_updated_at: null, board_rank: null,
    assignees: [], link_count: 0, sub_count: 0, sprint_label: null,
    ...o,
  };
}

function detail(o: Partial<TicketDetail> & { id: number; title: string }): TicketDetail {
  return {
    body: "Something is broken.", category: "bug", priority: "normal", status: "submitted",
    requester: "meilin", parent_id: null, sprint_id: null,
    created_at: ago(2 * H), updated_at: ago(1 * H),
    source: "canopy", source_ref: null, source_author: null, source_updated_at: null, board_rank: null,
    assignees: [], links: [], comments: [], events: [], parent: null, children: [], sprint: null,
    ...o,
  };
}

const link = (o: Partial<TicketLinkRow> = {}): TicketLinkRow => ({
  id: 1, ticket_id: 1, url: "https://github.com/SaplingLearn/sapling/issues/214",
  kind: "github", label: "sapling #214", meta: "GITHUB · ISSUE",
  created_by: "jose-a", created_at: ago(1 * H), locked: 0, ...o,
});
const comment = (o: Partial<TicketCommentRow> = {}): TicketCommentRow => ({
  id: 1, ticket_id: 1, author: "jose-a", body: "On it.", created_at: ago(1 * H), ...o,
});
const event = (o: Partial<TicketEventRow> = {}): TicketEventRow => ({
  id: 1, ticket_id: 1, actor: "meilin", from_status: null, to_status: "submitted",
  created_at: ago(3 * H), ...o,
});

function queueProps(o: Partial<QueueProps> = {}): QueueProps {
  return {
    tickets: [], sprints: [], persons: PERSONS,
    seg: "open", assignee: "anyone", category: "all", view: "table", unassignedCount: 0,
    ...o,
  };
}
function formProps(o: Partial<NewTicketProps> = {}): NewTicketProps {
  return {
    title: "", category: null, priority: "normal", description: "", assignees: [],
    link: "", sprintId: null, sprints: [], persons: PERSONS, sprMenu: false,
    ...o,
  };
}
function detailProps(t: TicketDetail, o: Partial<TicketDetailProps> = {}): TicketDetailProps {
  return {
    ticket: t, allTickets: [], sprints: [], persons: PERSONS,
    commentDraft: "", mention: null, commentHeight: null, linkDraft: "", linkOpen: false,
    asgMenu: false, sprMenu: false, relMenu: false, lkMenu: null, stMenu: null,
    ...o,
  };
}

/** An app-view AppState positioned on a ticket screen. */
function appState(o: Partial<AppState> = {}): AppState {
  const s = initialState();
  s.view = "app";
  s.me = { handle: "jose-a", name: "Jose Alvarez", avatar_url: null, color: "moss", identities: [], org: "SaplingLearn", admin: false };
  s.persons = { status: "ok", data: PERSONS };
  return Object.assign(s, o);
}

// ── atoms ────────────────────────────────────────────────────────────────────

describe("ticketPill / priorityChip / age (design call #5)", () => {
  it("tints Triage blue, In progress accent, Done muted, Declined red at reduced opacity", () => {
    expect(ticketPill("submitted")).toContain("var(--blue)");
    expect(ticketPill("submitted")).toContain("TRIAGE");
    expect(ticketPill("in_progress")).toContain("var(--accent)");
    expect(ticketPill("in_progress")).toContain("IN PROGRESS");
    expect(ticketPill("done")).toContain("color:var(--fg-55);border:1px solid var(--border-strong)");
    expect(ticketPill("done")).not.toContain("var(--blue)");
    expect(ticketPill("declined")).toContain("var(--red)");
    expect(ticketPill("declined")).toContain("opacity:.75");
  });

  it("keeps priority chips MONOCHROME — no accent/blue/red/amber anywhere", () => {
    for (const p of ["low", "normal", "high"] as const) {
      const html = priorityChip(p);
      expect(html).toContain(p.toUpperCase());
      expect(html).not.toMatch(/var\(--accent\)|var\(--blue\)|var\(--red\)|var\(--amber\)|var\(--green\)/);
    }
    // ...and they are distinguishable from one another by weight alone.
    expect(priorityChip("high")).toContain("color:var(--fg);");
    expect(priorityChip("normal")).toContain("color:var(--fg-55);");
    expect(priorityChip("low")).toContain("color:var(--fg-40);");
  });

  it("renders the design's short age form", () => {
    expect(age(ago(42 * 60_000))).toBe("42m");
    expect(age(ago(6 * H))).toBe("6h");
    expect(age(ago(3 * D))).toBe("3d");
    expect(age("not-a-date")).toBe("");
  });

  it("overlaps stacked avatars by -7px from the second one on", () => {
    const html = avatarStack(["meilin", "sanaok"], PERSONS);
    expect(html.match(/margin-left:-7px/g)?.length).toBe(1);
    expect(avatarStack(["meilin"], PERSONS)).not.toContain("margin-left:-7px");
  });
});

// ── sidebar ──────────────────────────────────────────────────────────────────

describe("sidebar — the Tickets entry (design call #2)", () => {
  it("sits in Workspace, after My Work and before Roadmap", () => {
    const html = render(appState({ screen: "tickets" }));
    const mywork = html.indexOf('data-act="goMyWork"');
    const tickets = html.indexOf('data-act="goTickets"');
    const roadmap = html.indexOf('data-act="goRoadmap"');
    expect(mywork).toBeGreaterThan(-1);
    expect(tickets).toBeGreaterThan(mywork);
    expect(roadmap).toBeGreaterThan(tickets);
  });

  // The badge is ALWAYS emitted (the rail is patched in place, so its structure
  // never changes); `data-n="0"` is what canopy.css hides.
  const ticketsRow = (html: string): string => html.slice(html.indexOf("cnpy-navrow n-tickets"), html.indexOf("cnpy-navrow n-roadmap"));

  it("hides the badge at 0 and shows the count in an accent pill above it", () => {
    const zero = ticketsRow(render(appState({ screen: "feed", ticketBadge: 0 })));
    expect(zero).toContain('<span class="cnpy-lbl cnpy-badge" data-n="0">0</span>');

    const some = ticketsRow(render(appState({ screen: "feed", ticketBadge: 4 })));
    expect(some).toContain('<span class="cnpy-lbl cnpy-badge" data-n="4">4</span>');
  });

  it("carries the collapsed rail's accent dot beside the count", () => {
    const html = render(appState({ screen: "feed", ticketBadge: 4, collapsed: true }));
    expect(html).toContain('data-collapsed="1"');
    expect(ticketsRow(html)).toContain('<span class="cnpy-dot" data-n="4"></span>');
    // review/maintenance counts are 0 here, so theirs stay hidden
    expect(html.match(/class="cnpy-dot" data-n="0"/g)?.length).toBe(12);
  });

  it("lights Tickets on all three ticket screens", () => {
    for (const screen of ["tickets", "ticketdetail", "newticket"] as const) {
      const html = render(appState({ screen }));
      expect(html).toContain(`data-screen="${screen}"`);
      expect(html).toContain('class="cnpy-navrow n-tickets is-active"');
    }
  });
});

// ── header ───────────────────────────────────────────────────────────────────

describe("header — titles, breadcrumb, queue chrome", () => {
  it("titles the three ticket screens Tickets and a sprint Roadmap", () => {
    expect(render(appState({ screen: "tickets" }))).toContain(">Tickets</h1>");
    expect(render(appState({ screen: "newticket" }))).toContain(">Tickets</button>");
    expect(render(appState({ screen: "sprint", sprintId: 3 }))).toContain(">Roadmap</button>");
  });

  it("turns the title into a back button plus a › crumb on a child screen", () => {
    const html = render(appState({ screen: "newticket" }));
    expect(html).toContain('data-act="ticketsBack"');
    expect(html).toContain("›");
    expect(html).toContain("New ticket");
  });

  it("names the open ticket in the crumb", () => {
    const html = render(appState({
      screen: "ticketdetail", ticketId: 5,
      ticketDetail: { status: "ok", data: detail({ id: 5, title: "CSV export fails" }) },
    }));
    expect(html).toContain("CSV export fails");
  });

  it("says so when the sprints fetch failed, and still renders every ticket", () => {
    // `GET /sprints` is a separate fetch from `GET /tickets`. When it fails the
    // queue must still render (everything folds into BACKLOG) AND admit that the
    // sprint grouping is missing, rather than looking like a filter swallowed rows.
    const html = render(appState({
      screen: "tickets", qView: "table",
      tickets: { status: "ok", data: [ticket({ id: 1, title: "Orphaned row", sprint_id: 12, sprint_label: "Sprint 12" })] },
      sprints: { status: "error", data: [], error: "boom" },
    }));
    expect(html).toContain("Couldn't load sprints");
    expect(html).toContain("Orphaned row");
    expect(html).toContain("BACKLOG");
    // …and a healthy sprints slice says nothing.
    const ok = render(appState({
      screen: "tickets",
      tickets: { status: "ok", data: [ticket({ id: 1, title: "Orphaned row" })] },
    }));
    expect(ok).not.toContain("Couldn't load sprints");
  });

  it("has no back button and no crumb on the queue itself", () => {
    const html = render(appState({ screen: "tickets" }));
    expect(html).not.toContain('data-act="ticketsBack"');
  });

  it("shows the Table/Board toggle and the submit button ONLY on the queue", () => {
    const queue = render(appState({ screen: "tickets" }));
    expect(queue).toContain('data-act="queueTable"');
    expect(queue).toContain('data-act="queueBoard"');
    expect(queue).toContain('data-act="newTicket"');
    for (const screen of ["newticket", "ticketdetail", "feed"] as const) {
      const other = render(appState({ screen }));
      expect(other).not.toContain('data-act="queueTable"');
      expect(other).not.toContain('data-act="newTicket"');
    }
  });
});

// ── queue ────────────────────────────────────────────────────────────────────

describe("queueView — table grouping", () => {
  const s12 = sprint({ id: 12, label: "Sprint 12 — Notifications GA", dates: "SEP 8 – 19", active: true, status: "in_progress" });
  const s13 = sprint({ id: 13, label: "Sprint 13 — Tickets", dates: "SEP 22 – OCT 3" });
  const s14 = sprint({ id: 14, label: "Sprint 14 — Empty", dates: "OCT 6 – 17" });

  const rows = [
    ticket({ id: 1, title: "In sprint 12", sprint_id: 12, sprint_label: s12.label }),
    ticket({ id: 2, title: "In sprint 13", sprint_id: 13, sprint_label: s13.label, assignees: ["jose-a"] }),
    ticket({ id: 3, title: "In the backlog", assignees: ["meilin"] }),
  ];

  it("groups in sprint order with BACKLOG last and drops empty groups", () => {
    const groups = queueGroups(rows, [s12, s13, s14]);
    expect(groups.map((g) => g.label)).toEqual([
      "SPRINT 12 — NOTIFICATIONS GA",
      "SPRINT 13 — TICKETS",
      "BACKLOG",
    ]);
    // Sprint 14 has no rows — hidden, not rendered as an empty group.
    const html = queueView(queueProps({ tickets: rows, sprints: [s12, s13, s14] }));
    expect(html).not.toContain("SPRINT 14 — EMPTY");
    expect(html.indexOf("SPRINT 12")).toBeLessThan(html.indexOf("SPRINT 13"));
    expect(html.indexOf("SPRINT 13")).toBeLessThan(html.indexOf("BACKLOG"));
  });

  it("labels the active sprint ACTIVE in accent and gives every sprint an Open sprint link", () => {
    const html = queueView(queueProps({ tickets: rows, sprints: [s12, s13] }));
    expect(html).toContain('<span style="color:var(--accent)"> · ACTIVE</span>');
    expect(html.match(/ · ACTIVE/g)?.length).toBe(1);        // only the active one
    expect(html).toContain('data-act="openSprint" data-arg="12"');
    expect(html).toContain('data-act="openSprint" data-arg="13"');
    // BACKLOG has no sprint to open, and reads "NO SPRINT".
    expect(html).toContain("NO SPRINT");
    expect(html).not.toContain('data-act="openSprint" data-arg=""');
  });

  it("counts each group's rows with the right singular/plural", () => {
    const html = queueView(queueProps({ tickets: rows, sprints: [s12, s13] }));
    expect(html).toContain("1 ticket<");
    const two = queueView(queueProps({
      tickets: [rows[0], ticket({ id: 9, title: "Also 12", sprint_id: 12 })],
      sprints: [s12],
    }));
    expect(two).toContain("2 tickets<");
  });

  it("opens the detail from a row", () => {
    const html = queueView(queueProps({ tickets: rows, sprints: [s12] }));
    expect(html).toContain('data-act="openTicket" data-arg="1"');
  });

  // GET /sprints is a SEPARATE fetch from GET /tickets: it can fail, or simply
  // land later. If a ticket whose sprint is missing fell out of every group it
  // would vanish from the table while the footer kept counting it — silent, and
  // it looks like a filter bug because Board view (grouped by status) is fine.
  it("folds a ticket whose sprint is not loaded into BACKLOG rather than dropping it", () => {
    const orphan = ticket({ id: 7, title: "Sprint went missing", sprint_id: 999, sprint_label: "Gone" });
    const groups = queueGroups([...rows, orphan], []);
    expect(groups.map((g) => g.label)).toEqual(["BACKLOG"]);
    expect(groups[0].rows.map((t) => t.id)).toEqual([1, 2, 3, 7]);   // every row, nothing dropped

    const html = queueView(queueProps({ tickets: [...rows, orphan], sprints: [] }));
    expect(html).toContain("Sprint went missing");
    expect(html).toContain("4 shown · 0 unassigned");                // the footer and the table agree
  });

  it("still folds an unknown sprint_id into BACKLOG when OTHER sprints did load", () => {
    const orphan = ticket({ id: 7, title: "Stale sprint ref", sprint_id: 999 });
    const groups = queueGroups([...rows, orphan], [s12, s13]);
    expect(groups.map((g) => g.label)).toEqual([
      "SPRINT 12 — NOTIFICATIONS GA", "SPRINT 13 — TICKETS", "BACKLOG",
    ]);
    expect(groups[2].rows.map((t) => t.id)).toEqual([3, 7]);
  });
});

describe("queueView — the needs-attention rule (design call #6)", () => {
  const cases: [string, TicketListItem, boolean][] = [
    ["unassigned + submitted", ticket({ id: 1, title: "A" }), true],
    ["assigned + submitted", ticket({ id: 2, title: "B", assignees: ["jose-a"] }), false],
    ["unassigned + in progress", ticket({ id: 3, title: "C", status: "in_progress" }), false],
    ["unassigned + done", ticket({ id: 4, title: "D", status: "done" }), false],
    ["unassigned + declined", ticket({ id: 5, title: "E", status: "declined" }), false],
  ];
  for (const [name, t, want] of cases) {
    it(`${want ? "marks" : "leaves plain"}: ${name}`, () => {
      const html = queueView(queueProps({ tickets: [t], seg: "all" }));
      // The marker is the faint `.cnpy-attn` fill and NOTHING else.
      expect(html.includes("cnpy-attn")).toBe(want);
    });
  }

  it("marks exactly the unassigned submitted rows in a mixed queue", () => {
    const html = queueView(queueProps({ tickets: cases.map(([, t]) => t), seg: "all" }));
    expect(html.match(/cnpy-attn/g)?.length).toBe(1);
  });

  it("marks the board CARD the same way, fill only", () => {
    const board = queueView(queueProps({ tickets: cases.map(([, t]) => t), seg: "all", view: "board" }));
    expect(board.match(/cnpy-attn/g)?.length).toBe(1);
    expect(board).toContain("cnpy-card cnpy-attn");
  });

  it("carries NO inset left rule — owner request: the fill alone marks it", () => {
    // Table rows and board cards both: the 2px accent edge must not come back,
    // in any form, while the faint fill stays.
    for (const view of ["table", "board"] as const) {
      const html = queueView(queueProps({ tickets: cases.map(([, t]) => t), seg: "all", view }));
      expect(html).toContain("cnpy-attn");                     // the fill survives
      expect(html).not.toContain("box-shadow:inset 2px 0 0 var(--accent)");
      expect(html).not.toMatch(/box-shadow:inset/);
      expect(html).not.toMatch(/border-left:\s*2px/);
    }
  });
});

describe("queueView — the footer count", () => {
  it("is 'N shown · M unassigned' where M is the org-wide badge, not the page", () => {
    const html = queueView(queueProps({
      tickets: [ticket({ id: 1, title: "A" }), ticket({ id: 2, title: "B" }), ticket({ id: 3, title: "C" })],
      unassignedCount: 7,
    }));
    expect(html).toContain("3 shown · 7 unassigned");
  });

  it("reads 0 shown on an empty queue", () => {
    expect(queueView(queueProps({ unassignedCount: 0 }))).toContain("0 shown · 0 unassigned");
  });
});

describe("queueView — the toolbar", () => {
  it("renders the search box, the Filter menu and the All / Open / Closed switch — no native selects", () => {
    const html = queueView(queueProps({ seg: "closed", assignee: "me", category: "bug" }));
    for (const k of ["all", "open", "closed"]) expect(html).toContain(`data-act="queueSeg" data-arg="${k}"`);
    expect(html.indexOf('data-arg="all"')).toBeLessThan(html.indexOf('data-arg="open"'));   // All leads
    expect(html).not.toContain("<select");
    expect(html).toContain('data-act="queueQ" data-field="queueQ"');
    expect(html).toContain('data-act="fmToggle" data-arg="queue"');
    // Two server-side filters are set: the badge on the Filter button says so.
    expect(html).toMatch(/Filter\s*<span[^>]*>2<\/span>/);
    expect(html).not.toContain('role="dialog"');
  });

  it("search and Filter are ONE combined control: the input and the Filter toggle inside a single .cnpy-sfbar", () => {
    const bar = sfbar(queueView(queueProps({ q: "login" })));
    expect(bar).not.toBeNull();
    expect(bar).toContain('data-act="queueQ" data-field="queueQ"');
    expect(bar).toContain('placeholder="Search by title, #number or person"');
    expect(bar).toContain('data-act="queueClearQ"');
    expect(bar).toContain('data-act="fmToggle" data-arg="queue"');
    expect(bar).toContain('class="cnpy-sfbar-div"');
    expect(bar!.indexOf('data-act="queueQ"')).toBeLessThan(bar!.indexOf('data-act="fmToggle"'));
    expect(bar).toMatch(/^<div class="cnpy-sfbar" data-hover-blur>/);   // the queue's mouse-leave blur survives
    // The Filter button draws no box of its own inside the bar.
    expect(bar).toMatch(/class="cnpy-ghostbtn fm-btn" style="[^"]*border:none/);
    expect(bar).not.toContain('class="cnpy-search"');
  });

  it("the open menu offers Assignee, Category, Priority and Sprint, and checks the current values", () => {
    const html = queueView(queueProps({
      assignee: "me", category: "bug", filterOpen: true, filterCat: "assignee",
      sprints: [sprint({ id: 12, label: "Sprint 12" })],
    }));
    expect(html).toContain('role="dialog" aria-label="Filter tickets"');
    for (const k of ["assignee", "category", "priority", "sprint"]) expect(html).toContain(`data-fm-cat="${k}"`);
    for (const [v, l] of [["anyone", "Any assignee"], ["me", "Assigned to me"], ["unassigned", "Unassigned"]]) {
      expect(html).toMatch(new RegExp(`data-act="queueAssignee" data-arg="${v}"[^>]*>[\\s\\S]*?${l}`));
    }
    for (const c of ["all", "bug", "request", "question", "access", "other"]) {
      expect(html).toContain(`data-act="queueCategory" data-arg="${c}"`);
    }
    expect(html).toContain('data-act="queueSprint" data-arg="12"');
    expect(html).toContain('data-act="queueSprint" data-arg="backlog"');
    expect(html).toContain('data-act="queuePriority" data-arg="high"');
    expect(html).toContain('data-act="fmClose" data-arg="queue"');           // the backdrop
  });

  it("search narrows by title, #number and person; priority and sprint narrow client-side", () => {
    const rows = [
      ticket({ id: 7, title: "Fix login", priority: "high", sprint_id: 12, sprint_label: "Sprint 12" }),
      ticket({ id: 8, title: "Add export", assignees: ["andres"] }),
      ticket({ id: 9, title: "Other thing", priority: "low" }),
    ];
    const titles = (o: Partial<QueueProps>) => queueRows(queueProps({ tickets: rows, ...o })).map((t) => t.id);
    expect(titles({ q: "login" })).toEqual([7]);
    expect(titles({ q: "#8" })).toEqual([8]);
    expect(titles({ q: "andres" })).toEqual([8]);
    expect(titles({ priority: "low" })).toEqual([9]);
    expect(titles({ sprint: "12" })).toEqual([7]);
    expect(titles({ sprint: "backlog" })).toEqual([8, 9]);
    expect(queueView(queueProps({ tickets: rows, q: "login" }))).toContain("1 shown · 0 unassigned");
  });
});

describe("queueView — the Assignee filter names people", () => {
  const rows = [
    ticket({ id: 1, title: "A", assignees: ["meilin"] }),
    ticket({ id: 2, title: "B", assignees: ["meilin", "jose-a"] }),
    ticket({ id: 3, title: "C" }),
  ];

  it("lists every person after the three modes, sorted by name, with their counts", () => {
    const html = queueView(queueProps({ tickets: rows, filterOpen: true, filterCat: "assignee" }));
    const order = ["anyone", "me", "unassigned", "@jose-a", "@meilin", "@sanaok"]
      .map((v) => html.indexOf(`data-act="queueAssignee" data-arg="${v}"`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toMatch(/data-arg="@meilin"[\s\S]*?Meilin Zhao[\s\S]*?>2<\/span>/);
  });

  it("a picked person narrows the rows, checks their row and lights the Filter badge", () => {
    expect(queueRows(queueProps({ tickets: rows, person: "jose-a" })).map((t) => t.id)).toEqual([2]);
    const html = queueView(queueProps({ tickets: rows, person: "meilin", filterOpen: true, filterCat: "assignee" }));
    expect(html).toContain("2 shown");
    expect(html).toMatch(/Filter\s*<span[^>]*>1<\/span>/);
    expect(html).toMatch(/data-arg="@meilin"[^>]*style="[^"]*color:var\(--fg\)"/);
  });

  it("hides the per-person counts when the fetch is not `anyone` (they would undercount)", () => {
    const html = queueView(queueProps({ tickets: rows, assignee: "me", filterOpen: true, filterCat: "assignee" }));
    expect(html).not.toMatch(/data-arg="@meilin"[\s\S]*?Meilin Zhao<\/span>\s*<span[^>]*>\d+<\/span>/);
  });
});

describe("queueView — the board card drags", () => {
  it("every card is draggable with its status — a resolved one too", () => {
    const html = queueView(queueProps({
      view: "board", seg: "all",
      tickets: [ticket({ id: 1, title: "S" }), ticket({ id: 2, title: "D", status: "done" })],
    }));
    expect(html).toContain('data-tdrag="1" data-status="submitted"');
    expect(html).not.toContain('draggable="true"');   // pointer-driven, never the browser's drag image
    expect(html).toContain('data-tdrag="2" data-status="done"');
    for (const st of ["submitted", "in_progress", "done", "declined"]) expect(html).toContain(`data-tdrop="${st}"`);
  });
});

describe("tickets — cards are the shared surface", () => {
  const OLD_FILL = "color-mix(in srgb,var(--fg) 2.5%";
  it("a board card is a clickable surface with no inline border, radius or fill", () => {
    const html = queueView(queueProps({ view: "board", seg: "all", tickets: [ticket({ id: 1, title: "S" })] }));
    const card = html.slice(html.indexOf('data-tdrag="1"'));
    expect(card).toContain('class="cnpy-tcard cnpy-surface cnpy-card');
    expect(card.slice(0, card.indexOf(">"))).not.toContain("border:1px solid var(--border)");
    expect(card.slice(0, card.indexOf(">"))).not.toContain("border-radius");
    expect(html).not.toContain(OLD_FILL);
  });
  it("the table is ONE surface: 20px sides, no row hairlines, plain category and priority", () => {
    const rows = [ticket({ id: 1, title: "A" }), ticket({ id: 2, title: "B" })];
    const html = queueView(queueProps({ view: "table", seg: "all", tickets: rows }));
    expect(html.match(/cnpy-surface/g)).toHaveLength(1);
    expect(html).toContain('class="cnpy-surface cnpy-ttable" style="margin-top:8px;overflow:hidden"');
    const trows = html.match(/class="cnpy-trow[^"]*" style="[^"]*"/g) ?? [];
    expect(trows).toHaveLength(2);
    for (const r of trows) {
      expect(r).toContain("padding:11px 20px");
      expect(r).not.toContain("border-bottom");
    }
    expect(html).toContain('class="cnpy-thead"');
    expect(html).toMatch(/class="cnpy-thead" style="[^"]*padding:14px 20px 10px/);
    expect(html).toMatch(/class="cnpy-tgrp" style="[^"]*padding:18px 20px 6px/);
    expect(html).toContain("cnpy-stagger cnpy-tgroup"); // canopy.css draws the one hairline between groups
    // Only the status pill is boxed; category and priority are plain text.
    const row = html.slice(html.indexOf('class="cnpy-trow'), html.indexOf("</button>", html.indexOf('class="cnpy-trow')));
    expect((row.match(/border:1px solid/g) ?? []).length).toBe(1);
    expect(html).not.toContain(OLD_FILL);
  });
  it("the new-ticket form card and the comment composer are surfaces", () => {
    const form = newTicketView(formProps());
    expect(form).toContain('class="cnpy-surface" style="padding:26px 28px;display:flex;flex-direction:column;min-height:calc(100vh - 210px)"');
    expect(form).not.toContain("border-radius:13px");
    const d = ticketDetailView(detailProps(detail({ id: 1, title: "T" })));
    expect(d).toContain("cnpy-surface");
    expect(d).not.toContain("border-radius:11px;padding:12px");
  });
});

describe("queueView — board columns follow the segment", () => {
  const rows = [
    ticket({ id: 1, title: "S", status: "submitted" }),
    ticket({ id: 2, title: "P", status: "in_progress" }),
    ticket({ id: 3, title: "D", status: "done" }),
    ticket({ id: 4, title: "X", status: "declined" }),
  ];
  const columnLabels = (html: string) =>
    (html.match(/letter-spacing:\.08em;white-space:nowrap;color:var\(--(?:accent|blue|amber|fg-40)\)">([A-Z ]+)</g) ?? [])
      .map((m) => m.replace(/.*">/, "").replace(/<$/, ""));

  it("open → TRIAGE + IN PROGRESS + TESTING", () => {
    const html = queueView(queueProps({ tickets: rows, view: "board", seg: "open" }));
    expect(columnLabels(html)).toEqual(["TRIAGE", "IN PROGRESS", "TESTING"]);
    expect(SEG_STATUSES.open).toEqual(["submitted", "in_progress", "testing"]);
  });

  it("closed → DONE + DECLINED", () => {
    const html = queueView(queueProps({ tickets: rows, view: "board", seg: "closed" }));
    expect(columnLabels(html)).toEqual(["DONE", "DECLINED"]);
  });

  it("all → five columns in status order, Testing between In progress and Done", () => {
    const html = queueView(queueProps({ tickets: rows, view: "board", seg: "all" }));
    expect(columnLabels(html)).toEqual(["TRIAGE", "IN PROGRESS", "TESTING", "DONE", "DECLINED"]);
    expect(html).toContain("grid-template-columns:repeat(5,minmax(0,1fr))");
  });

  it("orders a column by saved position: unpositioned (newest first) on top, then by rank", () => {
    const col = [
      ticket({ id: 11, title: "Ranked 2", status: "testing", board_rank: 2048 }),
      ticket({ id: 12, title: "Loose old", status: "testing", updated_at: "2026-09-01T00:00:00Z" }),
      ticket({ id: 13, title: "Ranked 1", status: "testing", board_rank: 1024 }),
      ticket({ id: 14, title: "Loose new", status: "testing", updated_at: "2026-09-20T00:00:00Z" }),
    ];
    const html = queueView(queueProps({ tickets: col, view: "board", seg: "all" }));
    const order = [...html.matchAll(/data-tdrag="(\d+)"/g)].map((m) => Number(m[1]));
    expect(order).toEqual([14, 12, 13, 11]);
  });

  it("colors the headers per the design and shows a dashed placeholder for an empty column", () => {
    const html = queueView(queueProps({ tickets: [rows[0]], view: "board", seg: "open" }));
    expect(html).toContain("color:var(--blue)\">TRIAGE");
    expect(html).toContain("color:var(--accent)\">IN PROGRESS");
    expect(html).toContain("border:1px dashed var(--border)");
    expect(html).toContain("Nothing here");
    expect(html.match(/Nothing here/g)?.length).toBe(2);   // IN PROGRESS and TESTING are empty
  });

  it("renders no table header in board mode (and vice versa)", () => {
    const board = queueView(queueProps({ tickets: rows, view: "board", seg: "all" }));
    expect(board).not.toContain("<div>OPENED BY</div>");
    const table = queueView(queueProps({ tickets: rows, view: "table", seg: "all" }));
    expect(table).toContain("<div>OPENED BY</div>");
  });
});

describe("queueView — the row", () => {
  it("shows N sub on a parent and ↳ sub-ticket on a child, nothing otherwise", () => {
    const html = queueView(queueProps({
      tickets: [
        ticket({ id: 1, title: "Parent", sub_count: 2 }),
        ticket({ id: 2, title: "Child", parent_id: 1 }),
        ticket({ id: 3, title: "Lonely" }),
      ],
      seg: "all",
    }));
    expect(html).toContain("2 sub");
    expect(html).toContain("↳ sub-ticket");
    // Three rows, two relation chips.
    expect(html.match(/data-act="openTicket"/g)?.length).toBe(3);
    expect(html.match(/font-size:9\.5px/g)?.length).toBe(2);
  });

  it("writes the assignee cell as italic Unassigned, a full name, or First +N", () => {
    const html = queueView(queueProps({
      tickets: [
        ticket({ id: 1, title: "None" }),
        ticket({ id: 2, title: "One", assignees: ["meilin"] }),
        ticket({ id: 3, title: "Two", assignees: ["meilin", "sanaok"] }),
      ],
      seg: "all",
    }));
    expect(html).toContain("font-style:italic\">Unassigned<");
    expect(html).toContain(">Meilin Zhao<");
    expect(html).toContain(">Meilin +1<");
  });

  it("escapes hostile ticket titles", () => {
    const html = queueView(queueProps({ tickets: [ticket({ id: 1, title: `<img src=x onerror="alert(1)">` })] }));
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });
});

// ── new ticket ───────────────────────────────────────────────────────────────

describe("the ticket screens' frame", () => {
  it("gives the queue and the form the full-width work shell", () => {
    for (const html of [queueView(queueProps()), newTicketView(formProps())]) {
      expect(html).toContain(WORK_SHELL);
      // Neither is capped at the old narrow measures.
      expect(html).not.toContain("max-width:960px");
      expect(html).not.toContain("max-width:1000px");
      expect(html).not.toContain("max-width:1080px");
    }
  });

  it("centres a single ticket in the narrower detail shell", () => {
    const html = ticketDetailView(detailProps(detail({ id: 1, title: "T" })));
    expect(html).toContain(DETAIL_SHELL);
    expect(html).not.toContain(WORK_SHELL);
  });

  it("keeps the form's rail a rail — fixed, so a wide window grows the fields", () => {
    expect(newTicketView(formProps())).toContain("grid-template-columns:minmax(0,1fr) 288px");
  });

  it("lets the thread absorb the leftover height so the composer rides the bottom", () => {
    const html = ticketDetailView(detailProps(detail({ id: 1, title: "T" })));
    // The main column is a flex column whose thread block grows...
    expect(html).toContain("min-width:0;display:flex;flex-direction:column");
    expect(html).toContain("display:flex;flex-direction:column;flex:1;min-height:0");
    // ...and the composer is the one part that does not.
    const box = html.slice(html.indexOf('data-act="ticketComment"'));
    // The composer box is a surface (the class carries border, radius and fill).
    expect(html.slice(0, html.indexOf('data-act="ticketComment"'))).toContain('class="cnpy-surface" style="position:relative;padding:12px;margin-top:16px;flex:none"');
    expect(box).toContain('data-act="ticketCommentPost"');
  });

  it("runs the form's card and the detail's columns down the window", () => {
    expect(newTicketView(formProps())).toContain("min-height:calc(100vh - 210px)");
    // The title now sits inside the grid, so the grid itself takes the full height.
    expect(ticketDetailView(detailProps(detail({ id: 1, title: "T" })))).toContain("gap:34px;min-height:calc(100vh - 210px)");
  });
});

describe("newTicketView", () => {
  it("keeps Submit inert until the title is non-empty", () => {
    const empty = newTicketView(formProps({ title: "   " }));
    expect(empty).toContain('data-act="ntSubmit"');
    expect(empty).toContain("color:var(--fg-40);border:1px solid var(--border);cursor:default");
    expect(empty).not.toContain("background:var(--accent);color:var(--accent-fg)");

    const typed = newTicketView(formProps({ title: "Export is broken" }));
    expect(typed).toContain("background:var(--accent);color:var(--accent-fg)");
  });

  it("opens with the design's defaults: no category, Normal, Backlog, Unassigned", () => {
    const html = newTicketView(formProps({ sprints: [sprint({ id: 12, label: "Sprint 12" })] }));
    const on = "border:1px solid var(--accent);color:var(--accent);background:var(--accent-soft)";
    // No category chip is selected (none selected = `other` on submit).
    for (const c of ["bug", "request", "question", "access", "other"]) {
      expect(html).toContain(`data-act="ntCategory" data-arg="${c}"`);
      const chip = html.slice(html.indexOf(`data-arg="${c}"`), html.indexOf(`>${c}<`));
      expect(chip).not.toContain(on);
    }
    // Normal is the selected priority segment.
    expect(html).toContain('class="cnpy-seg-btn is-on" data-act="ntPriority" data-arg="normal" aria-pressed="true"');
    expect(html).toContain('class="cnpy-seg-btn" data-act="ntPriority" data-arg="low" aria-pressed="false"');
    // The sprint picker reads Backlog; Unassigned is the selected assignee chip.
    expect(html).toContain('data-act="ntSprintMenu"');
    expect(html).toContain(">Backlog</span>");
    const unassigned = html.slice(html.indexOf('data-act="ntAssignee" data-arg=""'), html.indexOf("Unassigned</button>"));
    expect(unassigned).toContain(on);
  });

  it("carries the design's placeholders verbatim", () => {
    const html = newTicketView(formProps());
    expect(html).toContain('placeholder="One line: what do you need?"');
    expect(html).toContain(`placeholder="What's happening, and what would good look like?"`);
    expect(html).toContain('placeholder="GitHub or Figma URL, or #issue-number"');
  });

  it("offers Backlog plus every sprint, and Unassigned plus every person", () => {
    const html = newTicketView(formProps({
      sprints: [sprint({ id: 12, label: "Sprint 12" }), sprint({ id: 13, label: "Sprint 13" })],
      sprintId: 13,
      assignees: ["meilin", "sanaok"],
      sprMenu: true,
    }));
    expect(html.match(/data-act="ntSprint" /g)?.length).toBe(3);
    expect(html.match(/data-act="ntAssignee"/g)?.length).toBe(4);
    const from13 = html.slice(html.indexOf('data-act="ntSprint" data-arg="13"'));
    const s13 = from13.slice(0, from13.indexOf("</button>"));
    expect(s13).toContain("color:var(--accent)");                   // the tick sits on the pick
    const from12 = html.slice(html.indexOf('data-act="ntSprint" data-arg="12"'));
    expect(from12.slice(0, from12.indexOf("</button>"))).toContain("visibility:hidden");
  });

  it("echoes the typed values back into the fields", () => {
    const html = newTicketView(formProps({ title: "A & B", description: "line one", link: "#214" }));
    expect(html).toContain('value="A &amp; B"');
    expect(html).toContain(">line one</textarea>");
    expect(html).toContain('value="#214"');
  });

  it("picks a sprint through a menu, not a chip per sprint, so a long label can't spill out of the rail", () => {
    const label = "E2E Chapter 2 — agent explorer (epic #403)";
    const sprints = [sprint({ id: 12, label }), sprint({ id: 13, label: "Sprint 13" })];

    // Closed: one trigger showing the pick, and no sprint rows at all.
    const closed = newTicketView(formProps({ sprints, sprintId: 12 }));
    expect(closed).toContain('data-act="ntSprintMenu"');
    expect(closed).not.toContain('data-act="ntSprint"');
    expect(closed).toContain("text-overflow:ellipsis");
    expect(closed).toContain(`>${label}</span>`);

    // Open: Backlog plus every sprint, the pick ticked, inside the SAME fixed-
    // width box (with a backdrop) the detail rail's picker uses.
    const open = newTicketView(formProps({ sprints, sprintId: 12, sprMenu: true }));
    expect(open.match(/data-act="ntSprint" /g)?.length).toBe(3);
    expect(open).toContain('data-act="closeTicketMenus"');
    expect(open).toContain("width:230px");
    const row = open.slice(open.indexOf('data-act="ntSprint" data-arg="12"'), open.indexOf(">Sprint 13<"));
    expect(row).toContain("color:var(--accent)");                  // the tick
    expect(row).toContain("text-overflow:ellipsis");
  });

  it("cancels back to the queue with the same act the breadcrumb uses", () => {
    expect(newTicketView(formProps())).toContain('data-act="ticketsBack"');
  });
});

// ── ticket detail ────────────────────────────────────────────────────────────

describe("ticketDetailView — the body is markdown", () => {
  it("renders the body through the markdown fn, inside the md container", () => {
    const html = ticketDetailView(detailProps(detail({ id: 1, title: "T", body: "1. **Handling handoff prompts** (#51)" })));
    expect(html).toContain('class="cnpy-md cnpy-td-body"');
    expect(html).toContain("mock-live-md");
    expect(html).toContain("<strong>Handling handoff prompts</strong>");
    expect(html).not.toContain("**Handling");
    expect(html).not.toContain("white-space:pre-wrap");
  });

  it("XSS: the body reaches the DOM ONLY through the markdown fn", () => {
    const html = ticketDetailView(detailProps(detail({ id: 1, title: "T", body: "<script>alert(1)</script>" })));
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("an empty body renders no container at all", () => {
    const html = ticketDetailView(detailProps(detail({ id: 1, title: "T", body: "  " })));
    expect(html).not.toContain("cnpy-td-body");
  });
});

describe("ticketDetailView — the status control (design call #7)", () => {
  it("the trigger IS the pill — no outlined box around it", () => {
    const html = ticketDetailView(detailProps(detail({ id: 1, title: "T", status: "submitted" }), { stMenu: null }));
    const triggers = html.match(/<button data-act="ticketStatusMenu"[^>]*>/g) ?? [];
    expect(triggers).toHaveLength(1);
    for (const t of triggers) {
      expect(t).toContain('class="cnpy-statusbtn"');
      expect(t).not.toContain("cnpy-outlinebtn");
      expect(t).not.toContain("var(--border-strong)"); // the old box's border
      expect(t).toContain("var(--blue)"); // tinted as the status itself
      expect(t).toContain('aria-expanded="false"');
    }
    const open = ticketDetailView(detailProps(detail({ id: 1, title: "T", status: "submitted" }), { stMenu: "rail" }));
    expect(open).toContain('data-arg="rail" title="Set status" aria-haspopup="menu" aria-expanded="true"');
  });

  const props = (status: TicketStatus, stMenu: "rail" | null = null) =>
    detailProps(detail({ id: 1, title: "T", status }), { stMenu });

  it("shows the status as a pill you click — no accept/reject action buttons", () => {
    const html = ticketDetailView(props("submitted"));
    // ONE control, in the rail's STATUS row — the header's duplicate is gone.
    expect(html.match(/data-act="ticketStatusMenu"/g)?.length).toBe(1);
    expect(html).toContain('data-act="ticketStatusMenu" data-arg="rail"');
    // Nothing is settable until a menu is open, and the old copy is gone.
    expect(html).not.toContain('data-act="ticketStatus"');
    expect(html).not.toContain(">Start<");
    expect(html).not.toContain(">Decline<");
    expect(html).not.toContain("Back to submitted");
  });

  it("offers every other status from Triage — straight to Done included — with the current one ticked", () => {
    const html = ticketDetailView(props("submitted", "rail"));
    for (const st of ["in_progress", "testing", "done", "declined"]) expect(html).toContain(`data-act="ticketStatus" data-arg="${st}"`);
    // The current status is listed but inert (a ticked row, not a button).
    expect(html).not.toContain('data-act="ticketStatus" data-arg="submitted"');
    expect(html).toContain("color:var(--accent)");
    expect(html.match(/data-act="ticketStatus" /g)?.length).toBe(4);
  });

  it("offers Testing from In progress, and every other status from Testing", () => {
    const prog = ticketDetailView(props("in_progress", "rail"));
    for (const st of ["testing", "done", "declined", "submitted"]) expect(prog).toContain(`data-act="ticketStatus" data-arg="${st}"`);
    const test = ticketDetailView(props("testing", "rail"));
    for (const st of ["done", "in_progress", "declined", "submitted"]) expect(test).toContain(`data-act="ticketStatus" data-arg="${st}"`);
    expect(test).toContain("TESTING");
  });

  it("a resolved status is still a control — every other status can be set from it", () => {
    for (const status of ["done", "declined"] as const) {
      const html = ticketDetailView(props(status, "rail"));
      expect(html).toContain('data-act="ticketStatusMenu"');
      for (const st of TICKET_STATUSES.filter((s) => s !== status)) expect(html).toContain(`data-act="ticketStatus" data-arg="${st}"`);
      expect(html).toContain(TICKET_STATUS_LABEL[status].toUpperCase());
    }
  });

  it("dismisses the open menu with the shared backdrop", () => {
    expect(ticketDetailView(props("submitted", "rail"))).toContain('data-act="closeTicketMenus"');
  });

  it("is laid out like the sprint page: the title heads the left column, the rail starts at the top", () => {
    const html = ticketDetailView(props("submitted"));
    const grid = html.indexOf('class="cnpy-td-grid"');
    expect(grid).toBeGreaterThan(-1);
    expect(html.indexOf("<h2")).toBeGreaterThan(grid); // the title sits INSIDE the grid
  });

  it("puts who filed it and when in the rail — nothing under the title", () => {
    const html = ticketDetailView(props("submitted"));
    expect(html).toContain(">REQUESTER<");
    expect(html).toContain(">OPENED<");
    expect(html).not.toContain(">opened ");
    // The left column goes straight from the title to the body: no chip, no meta line.
    const left = html.slice(html.indexOf("<h2"), html.indexOf(">Properties<"));
    expect(left.includes("cnpy-av")).toBe(false);
  });
});

describe("ticketDetailView — linked work (design call #8)", () => {
  it("shows the link field, and no 'Linked to engineering work' line, while there are no links", () => {
    const html = ticketDetailView(detailProps(detail({ id: 1, title: "T" })));
    expect(html).toContain('data-field="ticketLinkDraft"');
    expect(html).toContain('data-act="ticketLinkAdd"');
    expect(html).not.toContain("Linked to engineering work");
    expect(html).not.toContain('data-act="ticketLinkToggle"');
  });

  it("replaces it with the plain line once a link exists", () => {
    const html = ticketDetailView(detailProps(detail({ id: 1, title: "T", links: [link()] })));
    expect(html).toContain("Linked to engineering work");
    expect(html).not.toContain('data-field="ticketLinkDraft"');
    expect(html).toContain('data-act="ticketLinkToggle"');     // the escape hatch for a second link
    expect(html).toContain("sapling #214");
    expect(html).toContain("GITHUB · ISSUE");
    expect(html).toContain('href="https://github.com/SaplingLearn/sapling/issues/214"');
  });

  it("gives each link a ⋯ menu trigger outside the <a>, and a right-click hook on the chip", () => {
    const html = ticketDetailView(detailProps(detail({ id: 1, title: "T", links: [link({ id: 42 })] })));
    expect(html).toMatch(/<\/a>\s*<button data-act="ticketLinkMenu" data-arg="42"/);
    expect(html).toContain('data-ctx="ticketLinkMenuOpen" data-arg="42"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('data-act="ticketLinkRemove"');        // closed: no remove anywhere
  });

  it("opens that chip's menu with Copy link and Remove link", () => {
    const html = ticketDetailView(detailProps(
      detail({ id: 1, title: "T", links: [link({ id: 42 }), link({ id: 43, label: "other" })] }),
      { lkMenu: 42 },
    ));
    expect(html).toContain('data-act="ticketLinkCopy" data-arg="42"');
    expect(html).toContain('data-act="ticketLinkRemove" data-arg="42"');
    expect(html).not.toContain('data-act="ticketLinkRemove" data-arg="43"');
    expect(html).toContain('data-act="closeTicketMenus"');
  });

  it("re-opens the field through the toggle", () => {
    const html = ticketDetailView(detailProps(detail({ id: 1, title: "T", links: [link()] }), { linkOpen: true }));
    expect(html).toContain('data-field="ticketLinkDraft"');
  });

  it("never dereferences a non-http(s) stored url", () => {
    const html = ticketDetailView(detailProps(detail({
      id: 1, title: "T", links: [link({ url: "javascript:alert(1)", kind: "plain", label: "bad" })],
    })));
    expect(html).not.toContain("javascript:alert(1)");
    expect(html).toContain('href="#"');
  });
});

describe("relCandidates — the sub-ticket add menu's filter", () => {
  const self = detail({ id: 1, title: "Self", parent_id: 4 });
  const all: TicketListItem[] = [
    ticket({ id: 1, title: "Self" }),                                  // excluded: self
    ticket({ id: 4, title: "My parent", sub_count: 1 }),               // excluded: is the parent
    ticket({ id: 5, title: "Has a parent", parent_id: 9 }),            // excluded: already nested
    ticket({ id: 6, title: "Has children", sub_count: 3 }),            // excluded: is a parent
    ticket({ id: 7, title: "Closed done", status: "done" }),           // excluded: closed
    ticket({ id: 8, title: "Closed declined", status: "declined" }),   // excluded: closed
    ticket({ id: 10, title: "Eligible submitted" }),
    ticket({ id: 11, title: "Eligible in progress", status: "in_progress" }),
  ];

  it("keeps only free, open tickets", () => {
    expect(relCandidates(all, self).map((t) => t.id)).toEqual([10, 11]);
  });

  it("drops each exclusion independently", () => {
    for (const id of [1, 4, 5, 6, 7, 8]) {
      expect(relCandidates(all, self).some((t) => t.id === id)).toBe(false);
    }
  });

  it("offers the menu on a root ticket and hides it on one that already has a parent", () => {
    const root = detail({ id: 1, title: "Root" });
    const open = ticketDetailView(detailProps(root, { allTickets: all, relMenu: true }));
    expect(open).toContain('data-act="ticketRelMenu"');
    expect(open).toContain("LINK A TICKET AS A SUB-TICKET");
    expect(open).toContain('data-act="ticketRelAdd" data-arg="10"');

    // A ticket that already has a parent can never become one (one level).
    const nested = ticketDetailView(detailProps(self, { allTickets: all, relMenu: true }));
    expect(nested).not.toContain('data-act="ticketRelMenu"');
    expect(nested).not.toContain('data-act="ticketRelAdd"');
  });

  it("shows the parent line, the children, and an empty state when there is neither", () => {
    const withRel = ticketDetailView(detailProps(detail({
      id: 1, title: "T",
      parent: { id: 4, title: "Parent ticket", status: "in_progress" },
      children: [{ id: 5, title: "Child ticket", status: "submitted" }],
    })));
    expect(withRel).toContain("PARENT TICKET");
    expect(withRel).toContain("Parent ticket");
    expect(withRel).toContain("SUB-TICKET · TRIAGE");
    expect(withRel).toContain('data-act="openTicket" data-arg="4"');
    expect(withRel).toContain('data-act="openTicket" data-arg="5"');
    expect(withRel).not.toContain("No linked tickets");

    expect(ticketDetailView(detailProps(detail({ id: 1, title: "T" })))).toContain("No linked tickets");
  });
});

describe("ticketDetailView — the thread", () => {
  it("renders the opening event as 'opened this ticket' and later ones as from → to", () => {
    const html = ticketDetailView(detailProps(detail({
      id: 1, title: "T", status: "in_progress",
      events: [
        event({ id: 1, actor: "meilin", from_status: null, to_status: "submitted", created_at: ago(3 * H) }),
        event({ id: 2, actor: "jose-a", from_status: "submitted", to_status: "in_progress", created_at: ago(1 * H) }),
      ],
    })));
    expect(html).toContain("opened this ticket");
    expect(html).not.toContain("opened · TRIAGE");
    expect(html).toContain("Triage → In progress");
    expect(html.indexOf("opened this ticket")).toBeLessThan(html.indexOf("Triage → In progress"));
  });

  it("merges comments and history ascending by time", () => {
    const html = ticketDetailView(detailProps(detail({
      id: 1, title: "T",
      comments: [comment({ id: 1, author: "meilin", body: "SECOND", created_at: ago(2 * H) })],
      events: [
        event({ id: 1, from_status: null, to_status: "submitted", created_at: ago(3 * H) }),
        event({ id: 2, from_status: "submitted", to_status: "in_progress", created_at: ago(1 * H) }),
      ],
    })));
    expect(html.indexOf("opened this ticket")).toBeLessThan(html.indexOf("SECOND"));
    expect(html.indexOf("SECOND")).toBeLessThan(html.indexOf("Triage → In progress"));
    expect(html).toContain("1 comment<");
  });

  it("keeps Post inert until the draft is non-empty", () => {
    const empty = ticketDetailView(detailProps(detail({ id: 1, title: "T" }), { commentDraft: "  " }));
    expect(empty).toContain('data-act="ticketCommentPost"');
    expect(empty).toContain("color:var(--fg-40);border:1px solid var(--border);cursor:default");
    const typed = ticketDetailView(detailProps(detail({ id: 1, title: "T" }), { commentDraft: "hi" }));
    expect(typed).toContain("background:var(--accent);color:var(--accent-fg)");
    expect(typed).toContain(">hi</textarea>");
  });

  it("escapes comment bodies and paints known @mentions (handle AND first-name form)", () => {
    const html = ticketDetailView(detailProps(detail({
      id: 1, title: "T",
      // @meilin = the handle form, @Sana = the first-name form, @nobody = not an
      // org member, so it must survive as plain text (design's `mention()`).
      comments: [comment({ body: "<b>hi</b> @meilin and @Sana and @nobody" })],
    })));
    expect(html).not.toContain("<b>hi</b>");
    expect(html).toContain("&lt;b&gt;hi&lt;/b&gt;");
    // Both resolving forms become the accent chip carrying the person's FIRST name.
    const chip = (first: string) =>
      `<span style="color:var(--accent);font-weight:600;background:var(--accent-soft);border-radius:4px;padding:0 4px">@${first}</span>`;
    expect(html).toContain(chip("Meilin"));   // @meilin → handle match
    expect(html).toContain(chip("Sana"));     // @Sana   → first-name match
    // A non-member stays plain: the literal text is there and it is NOT chipped.
    expect(html).toContain("@nobody");
    expect(html).not.toContain(chip("nobody"));
    expect(html).not.toContain(">@nobody</span>");
  });
});

describe("ticketDetailView — the @mention picker", () => {
  const d = detail({ id: 1, title: "T" });
  const open = (query: string, index = 0, start = 0, line = 0) =>
    ticketDetailView(detailProps(d, { commentDraft: `@${query}`, mention: { query, start, index, line } }));

  it("is hidden when nothing is being mentioned", () => {
    const html = ticketDetailView(detailProps(d, { commentDraft: "hello", mention: null }));
    expect(html).not.toContain('data-act="mentionPick"');
    expect(html).not.toContain('role="listbox"');
  });

  it("renders a listbox of candidate rows under the comment box", () => {
    const html = open("sa");
    expect(html).toContain('role="listbox"');
    expect(html).toContain('data-act="mentionPick" data-arg="sanaok"');
    expect(html).toContain('role="option"');
    // Each row carries the name and the @handle, and the picker is anchored.
    expect(html).toContain("Sana Okafor");
    expect(html).toContain("@sanaok</span>");
    // Anchored to the caret's line (line 0 → padTop 2 + 21.6 + gap 4), NOT to
    // the bottom of the whole textarea.
    expect(html).toContain("position:absolute;top:27.6px");
    expect(html).not.toContain("top:calc(100% + 6px)");
    // It sits INSIDE the comment box, right after the textarea.
    expect(html).toMatch(/<\/textarea>\s*<div role="listbox"/);
  });

  it("follows the caret DOWN the box: one line-height per line", () => {
    // 13.5px × 1.6 = 21.6px per line, off a 2px top padding, 4px of gap.
    expect(open("sa", 0, 0, 0)).toContain("top:27.6px");
    expect(open("sa", 0, 0, 1)).toContain("top:49.2px");
    expect(open("sa", 0, 0, 2)).toContain("top:70.8px");
    expect(open("sa", 0, 0, 3)).toContain("top:92.4px");
  });

  it("falls back to the bottom anchor once the line is past the box", () => {
    // The 96px resting box + 4px gap — never below the textarea's own bottom.
    expect(open("sa", 0, 0, 9)).toContain("top:100px");
    // A box the grip has grown pushes that cap down with it.
    const tall = ticketDetailView(detailProps(d, {
      commentDraft: "@sa", mention: { query: "sa", start: 0, index: 0, line: 9 }, commentHeight: 300,
    }));
    expect(tall).toContain("top:222px");
    expect(tall).toContain("height:300px");
  });

  it("lists every person on an empty query (the @ was just typed)", () => {
    const html = open("");
    for (const p of PERSONS) expect(html).toContain(`data-arg="${p.handle}"`);
  });

  it("matches a first name, not just a handle", () => {
    const html = open("Meil");
    expect(html).toContain('data-arg="meilin"');
    expect(html).not.toContain('data-arg="sanaok"');
  });

  it("is hidden when the query matches nobody", () => {
    const html = open("zzzz");
    expect(html).not.toContain('data-act="mentionPick"');
    expect(html).not.toContain('role="listbox"');
  });

  it("marks only the active row, and moves it with the index", () => {
    const first = open("", 0);
    const second = open("", 1);
    // The fill is the shared hover class (`.cnpy-menurow.is-active`), never an
    // inline background — that is what makes hover and keyboard-active identical.
    const hits = (h: string) => h.split('class="cnpy-menurow is-active"').length - 1;
    expect(first).not.toContain("background:var(--hover)");
    expect(hits(first)).toBe(1);
    expect(hits(second)).toBe(1);
    // index 0 → jose-a (names ascending); index 1 → meilin.
    expect(first).toContain('data-arg="jose-a" role="option" aria-selected="true" class="cnpy-menurow is-active"');
    expect(first).toContain('data-arg="meilin" role="option" aria-selected="false" class="cnpy-menurow"');
    expect(second).toContain('data-arg="meilin" role="option" aria-selected="true" class="cnpy-menurow is-active"');
    expect(second).toContain('data-arg="jose-a" role="option" aria-selected="false" class="cnpy-menurow"');
  });

  it("wraps a stale index rather than marking no row at all", () => {
    // The query narrowed to one candidate while the index was still on row 2.
    const html = open("sana", 2);
    expect(html.split('class="cnpy-menurow is-active"').length - 1).toBe(1);
    expect(html).toContain('data-arg="sanaok" role="option" aria-selected="true"');
  });

  it("carries the keyboard hint", () => {
    expect(open("sa")).toContain("↑↓ to move · Enter to mention · Esc to close");
  });
});

// ── the hover layer (canopy.css) ─────────────────────────────────────────────
// Inline styles cannot express `:hover`, so every row/chip/segment we added has
// to carry the shared class that CAN. These assert the hook is on the markup;
// the rules themselves live in web/src/canopy.css.

describe("hover classes — menu rows, pick chips, segments", () => {
  const s12 = sprint({ id: 12, label: "Sprint 12" });

  it("hangs .cnpy-menurow on every ticket-detail popover row", () => {
    const asg = ticketDetailView(detailProps(detail({ id: 1, title: "T" }), { asgMenu: true }));
    expect(asg).toContain('data-act="ticketAsgAdd" data-arg="meilin" class="cnpy-menurow"');

    const spr = ticketDetailView(detailProps(detail({ id: 1, title: "T" }), { sprints: [s12], sprMenu: true }));
    expect(spr).toContain('data-act="ticketSprintSet" data-arg="" class="cnpy-menurow"');
    expect(spr).toContain('data-act="ticketSprintSet" data-arg="12" class="cnpy-menurow"');

    const rel = ticketDetailView(detailProps(detail({ id: 1, title: "T" }), {
      allTickets: [ticket({ id: 9, title: "Candidate" })], relMenu: true,
    }));
    expect(rel).toContain('data-act="ticketRelAdd" data-arg="9" class="cnpy-menurow"');
  });

  it("gives the ticket-detail icon buttons .cnpy-iconbtn", () => {
    const html = ticketDetailView(detailProps(detail({ id: 1, title: "T", assignees: ["meilin"] }), {
      sprints: [s12], allTickets: [ticket({ id: 9, title: "Candidate" })],
    }));
    for (const act of ["ticketEdit", "ticketAsgMenu", "ticketSprintMenu", "ticketRelMenu"]) {
      expect(html).toContain(`data-act="${act}"`);
    }
    expect(html).toContain('data-act="ticketAsgRemove" data-arg="meilin" title="Remove" class="cnpy-iconbtn"');
    expect(html.match(/class="cnpy-iconbtn"/g)?.length).toBe(5);   // the edit pencil + 3 menu openers + the remove
  });

  it("marks the queue's segment buttons and its Open sprint link", () => {
    const html = queueView(queueProps({
      tickets: [ticket({ id: 1, title: "Row", sprint_id: 12 })], sprints: [s12], seg: "open",
    }));
    expect(html).toContain('data-seg="queue-seg"');
    expect(html).toContain('class="cnpy-seg-btn is-on" data-act="queueSeg" data-arg="open" aria-pressed="true"');
    expect(html).toContain('class="cnpy-seg-btn" data-act="queueSeg" data-arg="closed" aria-pressed="false"');
    expect(html).toContain('data-act="openSprint" data-arg="12" title="Open sprint screen" class="cnpy-grouplink"');
  });

  it("marks the new-ticket chips, with is-on only on the current pick", () => {
    const html = newTicketView(formProps({ category: "bug", sprintId: 12, assignees: ["meilin"], sprints: [s12] }));
    expect(html).toContain('data-act="ntCategory" data-arg="bug" class="cnpy-pickchip is-on"');
    expect(html).toContain('data-act="ntCategory" data-arg="access" class="cnpy-pickchip"');
    expect(html).toContain('class="cnpy-seg-btn is-on" data-act="ntPriority" data-arg="normal"');
    expect(html).toContain('class="cnpy-seg-btn" data-act="ntPriority" data-arg="high"');
    // Sprint is picked from the shared menu now, so its rows carry the menu-row
    // hover class rather than the chip one.
    const open = newTicketView(formProps({ category: "bug", sprintId: 12, assignees: ["meilin"], sprints: [s12], sprMenu: true }));
    expect(open).toContain('data-act="ntSprint" data-arg="12" class="cnpy-menurow"');
    expect(open).toContain('data-act="ntSprint" data-arg="" class="cnpy-menurow"');
    expect(html).toContain('data-act="ntAssignee" data-arg="meilin" class="cnpy-pickchip is-on"');
    expect(html).toContain('data-act="ntAssignee" data-arg="" class="cnpy-pickchip"');
  });
});

describe("ticketDetailView — the comment box's two corners", () => {
  const html = ticketDetailView(detailProps(detail({ id: 1, title: "T" })));

  it("parks Comment in the bottom-right, inside the box", () => {
    expect(html).toContain('data-act="ticketCommentPost"');
    const btn = html.slice(html.indexOf('data-act="ticketCommentPost"'));
    expect(btn.slice(0, btn.indexOf(">"))).toContain("position:absolute;right:8px;bottom:8px");
    // The old right-aligned footer row under the textarea is gone.
    expect(html).not.toContain("display:flex;justify-content:flex-end;margin-top:8px");
  });

  it("puts our own resize grip in the bottom-left and drops the native one", () => {
    expect(html).toContain('data-act="commentGrip"');
    const grip = html.slice(html.indexOf('data-act="commentGrip"'));
    expect(grip.slice(0, grip.indexOf(">"))).toContain("position:absolute;left:10px;bottom:10px");
    expect(html).toContain("resize:none");
    expect(html).not.toContain("resize:vertical");
  });

  it("keeps the text clear of the button, and honours a dragged height", () => {
    // 36px of bottom padding = the button's own footprint plus air.
    expect(html).toContain("padding:2px 0 36px");
    expect(html).toContain("height:96px;min-height:60px");       // the resting height
    const dragged = ticketDetailView(detailProps(detail({ id: 1, title: "T" }), { commentHeight: 220 }));
    expect(dragged).toContain("height:220px;min-height:60px");
    // Never below the floor, whatever state says.
    const tiny = ticketDetailView(detailProps(detail({ id: 1, title: "T" }), { commentHeight: 10 }));
    expect(tiny).toContain("height:60px;min-height:60px");
  });
});

describe("ticketDetailView — the rails", () => {
  const s12 = sprint({ id: 12, label: "Sprint 12", dates: "SEP 8 – 19", active: true, status: "in_progress" });
  const s13 = sprint({ id: 13, label: "Sprint 13", dates: "SEP 22 – OCT 3" });

  it("ticks the current sprint in the menu and leaves the others unticked", () => {
    const html = ticketDetailView(detailProps(
      detail({ id: 1, title: "T", sprint_id: 13, sprint: { id: 13, label: "Sprint 13" } }),
      { sprints: [s12, s13], sprMenu: true }
    ));
    expect(html).toContain('data-act="ticketSprintSet" data-arg=""');       // Backlog
    expect(html).toContain('data-act="ticketSprintSet" data-arg="12"');
    expect(html).toContain('data-act="ticketSprintSet" data-arg="13"');
    // Exactly one accent tick, and it belongs to Sprint 13.
    expect(html.match(/style="flex:none;color:var\(--accent\)"/g)?.length).toBe(1);
    expect(html.match(/style="flex:none;visibility:hidden"/g)?.length).toBe(2);
    const row13 = html.slice(html.indexOf('data-arg="13"'), html.indexOf('data-arg="13"') + 600);
    expect(row13).toContain("flex:none;color:var(--accent)");
  });

  it("links the rail to the sprint screen when set, and reads Backlog / NO SPRINT when not", () => {
    const set = ticketDetailView(detailProps(
      detail({ id: 1, title: "T", sprint_id: 12, sprint: { id: 12, label: "Sprint 12" } }),
      { sprints: [s12] }
    ));
    expect(set).toContain('data-act="openSprint" data-arg="12"');
    expect(set).toContain("SEP 8 – 19");

    const unset = ticketDetailView(detailProps(detail({ id: 1, title: "T" }), { sprints: [s12] }));
    expect(unset).toContain(">Backlog<");
    expect(unset).toContain(">NO SPRINT<");
    expect(unset).not.toContain('data-act="openSprint"');
  });

  it("offers remove on each assignee and add for everyone else", () => {
    const html = ticketDetailView(detailProps(
      detail({ id: 1, title: "T", assignees: ["meilin"] }),
      { asgMenu: true }
    ));
    expect(html).toContain('data-act="ticketAsgRemove" data-arg="meilin"');
    expect(html).toContain('data-act="ticketAsgMenu"');
    expect(html).toContain('data-act="ticketAsgAdd" data-arg="sanaok"');
    expect(html).toContain('data-act="ticketAsgAdd" data-arg="jose-a"');
    expect(html).not.toContain('data-act="ticketAsgAdd" data-arg="meilin"');
    expect(html).toContain('data-act="closeTicketMenus"');
  });

  it("shows the italic Unassigned placeholder with no assignees", () => {
    const html = ticketDetailView(detailProps(detail({ id: 1, title: "T" })));
    expect(html).toContain("font-style:italic\">Unassigned<");
    expect(html).not.toContain('data-act="ticketAsgRemove"');
  });

  it("repeats status / category / priority in the Properties rail", () => {
    const html = ticketDetailView(detailProps(detail({ id: 1, title: "T", status: "in_progress", category: "access", priority: "high" })));
    expect(html).toContain(">STATUS</div>");
    expect(html).toContain(">CATEGORY</div>");
    expect(html).toContain(">PRIORITY</div>");
    expect(html).toContain(">access</span>");
    expect(html).toContain(">HIGH</span>");
  });
});

// ── screen routing through render() ──────────────────────────────────────────

describe("render — the ticket screens", () => {
  it("paints the queue from the tickets slice", () => {
    const html = render(appState({
      screen: "tickets",
      tickets: { status: "ok", data: [ticket({ id: 1, title: "Queue row" })] },
      ticketBadge: 1,
    }));
    expect(html).toContain("Queue row");
    expect(html).toContain("1 shown · 1 unassigned");
  });

  it("shows a loading notice before the queue arrives", () => {
    expect(render(appState({ screen: "tickets" }))).toContain("Loading the queue");
  });

  it("paints the detail from the ticketDetail slice, and says so when it is missing", () => {
    const ok = render(appState({
      screen: "ticketdetail", ticketId: 3,
      ticketDetail: { status: "ok", data: detail({ id: 3, title: "Detail row" }) },
    }));
    expect(ok).toContain("Detail row");

    const gone = render(appState({ screen: "ticketdetail", ticketId: 3, ticketDetail: { status: "ok", data: null } }));
    expect(gone).toContain("That ticket doesn't exist.");
  });

  it("paints the new-ticket form", () => {
    expect(render(appState({ screen: "newticket" }))).toContain('data-act="ntSubmit"');
  });
});

// ── mirrored tickets (0032): source chip, the locked link, the editor ─────────

describe("mirrored tickets", () => {
  const SRC = { source: "github" as const, source_ref: "SaplingLearn/sapling#214", source_author: "outsider", source_updated_at: ago(H) };

  it("the queue row and board card carry a GitHub #n chip; a native row carries none", () => {
    const rows = [ticket({ id: 1, title: "Mirrored", ...SRC }), ticket({ id: 2, title: "Native" })];
    const table = queueView(queueProps({ tickets: rows }));
    expect(table.match(/GitHub #214/g)).toHaveLength(1);
    const board = queueView(queueProps({ tickets: rows, view: "board" } as Partial<QueueProps>));
    expect(board).toContain("GitHub #214");
  });

  it("the detail shows a SOURCE row, names an unmapped author, and locks the source link", () => {
    const d = detail({
      id: 1, title: "Mirrored", ...SRC, requester: "github-webhook",
      links: [link({ id: 5, locked: 1 }), link({ id: 6, url: "https://www.figma.com/file/x/Checkout", kind: "figma", label: "Checkout", meta: "FIGMA · DESIGN" })],
    });
    const html = ticketDetailView(detailProps(d, { lkMenu: 5 }));
    expect(html).toContain("SOURCE");
    expect(html).toContain("GitHub #214");
    expect(html).toContain("@outsider");
    expect(html).toContain("GITHUB · ISSUE · SOURCE");
    // The locked link's menu: Copy only, and the reason in place of Remove.
    expect(html).not.toContain('data-act="ticketLinkRemove" data-arg="5"');
    expect(html).toContain("Source issue — locked");
    // The unlocked extra link still offers Remove.
    const other = ticketDetailView(detailProps(d, { lkMenu: 6 }));
    expect(other).toContain('data-act="ticketLinkRemove" data-arg="6"');
  });

  it("status and assignee controls stay live on a mirrored ticket (only the link is locked)", () => {
    const html = ticketDetailView(detailProps(detail({ id: 1, title: "Mirrored", ...SRC })));
    expect(html).not.toContain("Managed on GitHub");
    expect(html).toContain('data-act="ticketAsgMenu"');
  });

  it("the pencil opens the title/description editor; Save arms only on a non-empty title", () => {
    const d = detail({ id: 1, title: "T", body: "B" });
    expect(ticketDetailView(detailProps(d))).toContain('data-act="ticketEdit"');
    const editing = ticketDetailView(detailProps(d, { edit: { title: "New", body: "Body" } }));
    expect(editing).toContain('data-act="ticketEditTitle"');
    expect(editing).toContain('data-act="ticketEditBody"');
    expect(editing).toContain('data-act="ticketEditSave"');
    // primaryBtn arms by class (main.ts also refuses a blank title on Save).
    expect(editing).toMatch(/data-act="ticketEditSave"[^>]*class="cnpy-accentbtn"/);
    const blank = ticketDetailView(detailProps(d, { edit: { title: "  ", body: "" } }));
    expect(blank).toMatch(/data-act="ticketEditSave"[^>]*class=""/);
  });
});

describe("mirrored ticket history", () => {
  it("names the github-webhook actor 'GitHub' in the history", () => {
    const d = detail({ id: 1, title: "T", events: [{ id: 1, ticket_id: 1, actor: "github-webhook", from_status: null, to_status: "submitted", created_at: ago(H) }] });
    const html = ticketDetailView(detailProps(d));
    expect(html).toContain(">GitHub</span>");
    expect(html).not.toContain(">github-webhook</span>");
  });
});

describe("ticketDetailView — delete", () => {
  it("offers Delete ticket on a native ticket, never on one mirrored from GitHub", () => {
    const native = ticketDetailView(detailProps(detail({ id: 1, title: "T" })));
    expect(native).toContain('data-act="ticketDeleteArm"');
    expect(native).toContain('aria-controls="ticket-delete-confirm"');
    const mirrored = ticketDetailView(detailProps(detail({ id: 2, title: "M", source: "github", source_ref: "SaplingLearn/sapling#666" })));
    expect(mirrored).not.toContain("ticketDeleteArm");
  });

  it("the confirm names the ticket, says it can't be undone, and mentions sub-tickets that stay", () => {
    const html = ticketDeleteModal(detail({ id: 7, title: "Old idea", children: [{ id: 8, title: "k", status: "submitted" }] as TicketDetail["children"] }), false);
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain("Delete #7 “Old idea”?");
    expect(html).toContain("can&#39;t be undone");
    expect(html).toContain("sub-ticket stays");
    expect(html).toContain('data-confirm-act="ticketDelete"');
  });
});

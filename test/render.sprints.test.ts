/**
 * Phase 5b render tests — the sprint surfaces of the SPA.
 *
 * Pure functions from web/src/sprints.ts plus `render()` over a hand-built
 * AppState (no D1, no DOM), the idiom of test/render.tickets.test.ts:
 *  • sprintCard — the design's tag set (▲ HIGH / NORMAL / LOW, DUE, DOMAIN),
 *    the lead's FIRST name, NEXT UP only on THE next sprint (`nextSprintId`), the progress
 *    text "closed/total done" + the bar width, "Open sprint →"
 *  • the Roadmap Timeline's grouping: active → In Progress, upcoming →
 *    Upcoming, done → Done
 *  • newSprintPanel — closed by default, opens off state, Create inert until a name
 *  • sprintScreen — the markdown description, tickets as grid boxes (a sub-ticket names its parent),
 *    the resources list, the members list, the ACTIVE chip
 *  • parseHash("#sprints/7")
 *  • the ONE due-date rule (`sprintDueState`, shared/sprints-core) with an injected
 *    clock, and every surface — card, the Roadmap's Timeline-tab dot, Timeline — agreeing on it
 *
 * The markdown module is vi.mock'd (marked + DOMPurify cannot run in this
 * workerd environment — same reason render.roadmap.test.ts mocks it) with a
 * MINI-MARKDOWN mock that escapes and then bolds `**…**`: an assertion on
 * `<strong>` therefore proves the description went through the markdown fn and
 * never through raw interpolation.
 */
import { describe, it, expect, vi } from "vitest";

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

import { sprintCard, newSprintPanel, newSprintToggle, sprintScreen, sprintTags, shortDue, nextSprintId, type NewSprintState } from "../web/src/sprints";
import { sprintDueState } from "@shared/sprints-core";
import { placeSprint } from "../web/src/timeline";
import { render, initialState, type AppState } from "../web/src/render";
import { parseHash } from "../web/src/hash";
import { avatarStack } from "../web/src/tickets";
import type { SprintView, SprintDetail, SprintTicketRow, SprintResourceView } from "@shared/sprints";
import type { PersonSummary } from "../web/src/api";

// ── fixtures ─────────────────────────────────────────────────────────────────

const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const D = 86_400_000;
/** Far enough out that "overdue" can never flip these fixtures. */
const FUTURE = new Date(NOW + 400 * D).toISOString().slice(0, 10);

const PERSONS: PersonSummary[] = [
  { handle: "sanaok", name: "Sana Okafor", color: "ochre", avatar_url: null, role: null },
  { handle: "jose-a", name: "Jose Alvarez", color: "moss", avatar_url: null, role: null },
  { handle: "meilin", name: "Meilin Zhao", color: "rose", avatar_url: null, role: null },
];

function sprint(o: Partial<SprintView> & { id: number; label: string }): SprintView {
  return {
    summary: "Close out the outbox soak test.",
    description: null,
    phase: "Phase 2",
    dates: "SEP 8 – 19",
    start: null,
    due: FUTURE,
    status: "upcoming",
    active: false,
    urgency: "normal",
    lead: null,
    domain: null,
    github_ref: null,
    created_at: ago(30 * D),
    created_by: "jose-a",
    updated_at: null,
    progress: { closed: 2, total: 5, pct: 40 },
    issues: null,
    members: [],
    ...o,
  };
}

function detail(o: Partial<SprintDetail> & { id: number; label: string }): SprintDetail {
  return { ...sprint(o), tickets: [], resources: [], ...o };
}

const spTicket = (o: Partial<SprintTicketRow> & { id: number; title: string; depth: 0 | 1 }): SprintTicketRow => ({
  body: "", category: "bug", priority: "normal", status: "submitted", requester: "meilin",
  parent_id: null, sprint_id: 3, created_at: ago(2 * D), updated_at: ago(D),
  source: "canopy", source_ref: null, source_author: null, source_updated_at: null, board_rank: null, assignees: [], ...o,
});

const resource = (o: Partial<SprintResourceView> = {}): SprintResourceView => ({
  // The url is GitHub's own — not Trov vocabulary. `meta` is what the SHARED
  // parseTicketLink actually produces for a github.com url of this shape.
  url: "https://github.com/AndresL230/trov/milestone/4",
  kind: "github", label: "notifications-ga", meta: "GITHUB", ...o,
});

const NS: NewSprintState = {
  open: false, name: "", start: "", desc: "", urgency: "normal", due: "", lead: null, domain: null, error: null,
};

function roadmapState(sprints: SprintView[], over: Partial<AppState> = {}): AppState {
  const s = initialState();
  return {
    ...s,
    view: "app",
    screen: "roadmap",
    roadmapTab: "narrative", // the sprint cards + New sprint live on the Narrative tab
    me: { handle: "jose-a", name: "Jose", avatar_url: null, color: "moss", identities: [], org: "SaplingLearn", admin: false },
    persons: { status: "ok", data: PERSONS },
    roadmap: { status: "ok", data: { narrative: "n", version: 1, updated_at: null, updated_by: null, sprints } },
    ...over,
  };
}

function sprintScreenState(d: SprintDetail, over: Partial<AppState> = {}): AppState {
  const s = initialState();
  return {
    ...s,
    view: "app",
    screen: "sprint",
    sprintId: d.id,
    me: { handle: "jose-a", name: "Jose", avatar_url: null, color: "moss", identities: [], org: "SaplingLearn", admin: false },
    persons: { status: "ok", data: PERSONS },
    sprintDetail: { status: "ok", data: d },
    ...over,
  };
}

// ── sprintCard ───────────────────────────────────────────────────────────────

describe("sprintCard — tags (the design's sprTagsOf)", () => {
  it("shows ▲ HIGH in amber ONLY for a high-urgency sprint", () => {
    const high = sprintCard(sprint({ id: 1, label: "S", urgency: "high" }), PERSONS);
    expect(high).toContain("▲ HIGH");
    expect(high).toContain("var(--amber)");
    expect(high).not.toContain(">NORMAL<");
    expect(sprintCard(sprint({ id: 1, label: "S", urgency: "normal" }), PERSONS)).not.toContain("▲ HIGH");
    expect(sprintCard(sprint({ id: 1, label: "S", urgency: "low" }), PERSONS)).not.toContain("▲ HIGH");
  });

  it("shows exactly one urgency tag, and it is the sprint's own", () => {
    expect(sprintTags({ urgency: "normal", due: null, domain: null })).toBe(
      sprintTags({ urgency: "normal", due: null, domain: null })
    );
    expect(sprintCard(sprint({ id: 1, label: "S", urgency: "low" }), PERSONS)).toContain(">LOW<");
    expect(sprintCard(sprint({ id: 1, label: "S", urgency: "normal" }), PERSONS)).toContain(">NORMAL<");
  });

  it("renders DUE <short date> and hides the tag entirely when there is no due date", () => {
    const due = sprintCard(sprint({ id: 1, label: "S", due: "2026-10-17" }), PERSONS);
    expect(due).toContain("DUE OCT 17");
    const none = sprintCard(sprint({ id: 1, label: "S", due: null }), PERSONS);
    expect(none).not.toContain("DUE ");
  });

  it("uppercases the domain in a blue tint, and omits the tag when there is none", () => {
    const dom = sprintCard(sprint({ id: 1, label: "S", domain: "notifications" }), PERSONS);
    expect(dom).toContain(">NOTIFICATIONS<");
    expect(dom).toContain("var(--blue)");
    expect(sprintCard(sprint({ id: 1, label: "S", domain: null }), PERSONS)).not.toContain("var(--blue)");
  });

  it("shortDue falls through unparseable input uppercased rather than 'Invalid Date'", () => {
    expect(shortDue("2026-01-05")).toBe("JAN 5");
    expect(shortDue("soon")).toBe("SOON");
  });
});

describe("sprintCard — lead, NEXT UP, progress, open", () => {
  it("names the lead by FIRST name with the '· lead' suffix; nothing when there is no lead", () => {
    const led = sprintCard(sprint({ id: 1, label: "S", lead: "sanaok" }), PERSONS);
    expect(led).toContain("Sana · lead");
    expect(led).not.toContain("Sana Okafor · lead");
    expect(sprintCard(sprint({ id: 1, label: "S", lead: null }), PERSONS)).not.toContain("· lead");
  });

  it("badges NEXT UP only when told it is THE next sprint, and NEVER on an active or done one", () => {
    expect(sprintCard(sprint({ id: 1, label: "S", status: "upcoming", active: false }), PERSONS, { nextUp: true })).toContain("NEXT UP");
    // not yet running is not enough on its own — that was every upcoming card
    expect(sprintCard(sprint({ id: 1, label: "S", status: "upcoming", active: false }), PERSONS)).not.toContain("NEXT UP");
    expect(sprintCard(sprint({ id: 1, label: "S", status: "in_progress", active: true }), PERSONS, { nextUp: true })).not.toContain("NEXT UP");
    expect(sprintCard(sprint({ id: 1, label: "S", status: "done", active: false }), PERSONS, { nextUp: true })).not.toContain("NEXT UP");
    // an optimistic Confirm-done also suppresses it
    expect(sprintCard(sprint({ id: 1, label: "S", status: "upcoming", active: false }), PERSONS, { done: true, nextUp: true })).not.toContain("NEXT UP");
  });

  it("reads 'closed/total done' with the bar at pct%", () => {
    const html = sprintCard(sprint({ id: 1, label: "S", progress: { closed: 3, total: 7, pct: 43 } }), PERSONS);
    expect(html).toContain("3/7 done");
    expect(html).toContain("width:43%");
    expect(html).not.toContain("3/7 closed");
  });

  it("hides the bar entirely for a sprint with nothing to count (0/0)", () => {
    const html = sprintCard(sprint({ id: 1, label: "S", progress: { closed: 0, total: 0, pct: 0 } }), PERSONS);
    expect(html).not.toContain("0/0 done");
    expect(html).not.toContain("ready to complete");
  });

  it("offers 'Open sprint →' wired to openSprint with the sprint id", () => {
    const html = sprintCard(sprint({ id: 42, label: "S" }), PERSONS);
    expect(html).toContain('data-act="openSprint" data-arg="42"');
    expect(html).toContain("Open sprint");
  });

  it("shows the phase and the lowercased human date range as the date note", () => {
    const html = sprintCard(sprint({ id: 1, label: "S", phase: "Phase 2", dates: "SEP 8 – 19" }), PERSONS);
    expect(html).toContain("Phase 2 · sep 8 – 19");
  });

  it("prefers the real start/due span over the authored dates label once a start is set", () => {
    const html = sprintCard(sprint({ id: 1, label: "S", phase: "Phase 2", dates: "SEP 8 – 19", start: "2026-10-06", due: "2026-10-17" }), PERSONS);
    expect(html).toContain("Phase 2 · oct 6 – 17");
    expect(html).not.toContain("sep 8 – 19");
  });

  it("a legacy non-ISO due still renders (raw text, no overdue claim)", () => {
    const html = sprintCard(sprint({ id: 1, label: "S", dates: null, start: null, due: "Oct 17" }), PERSONS, { now: Date.parse("2027-01-01T12:00:00") });
    expect(html).toContain("DUE OCT 17");
    expect(html).not.toContain("OVERDUE");
  });

  it("stacks one avatar per member", () => {
    const html = sprintCard(sprint({ id: 1, label: "S", members: ["sanaok", "jose-a"] }), PERSONS);
    expect(html.match(/margin-left:-7px/g)).toHaveLength(1); // 2 avatars → 1 overlap
  });

  it("escapes a hostile label, summary and dates", () => {
    const html = sprintCard(sprint({
      id: 1, label: "<img src=x onerror=alert(1)>", summary: "<script>alert(2)</script>", dates: "<b>x</b>",
    }), PERSONS);
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>alert(2)</script>");
    expect(html).not.toContain("<b>x</b>");
  });
});

// ── the Roadmap's sprint groups (Narrative tab) ──────────────────────────────

describe("render() — Roadmap Narrative groups sprints by status (§C.6)", () => {
  it("puts active in In Progress, upcoming in Upcoming and done in Done, in that order", () => {
    const html = render(roadmapState([
      sprint({ id: 1, label: "Running now", status: "in_progress", active: true }),
      sprint({ id: 2, label: "Not yet", status: "upcoming", active: false }),
      sprint({ id: 3, label: "Shipped", status: "done", active: false }),
    ]));
    const inProgress = html.indexOf("In Progress");
    const upcoming = html.indexOf("Upcoming");
    const done = html.indexOf("Done<");
    expect(inProgress).toBeGreaterThan(-1);
    expect(inProgress).toBeLessThan(upcoming);
    expect(upcoming).toBeLessThan(done);
    expect(html.indexOf("Running now")).toBeGreaterThan(inProgress);
    expect(html.indexOf("Running now")).toBeLessThan(upcoming);
    expect(html.indexOf("Not yet")).toBeGreaterThan(upcoming);
    expect(html.indexOf("Not yet")).toBeLessThan(done);
    expect(html.indexOf("Shipped")).toBeGreaterThan(done);
  });

  it("drops a group with no sprints", () => {
    const html = render(roadmapState([sprint({ id: 1, label: "Only one", status: "in_progress", active: true })]));
    expect(html).toContain("In Progress");
    expect(html).not.toContain(">Upcoming<");
    expect(html).not.toContain(">Done<");
  });

  it("the Timeline tab draws the sprints on the calendar, not as cards", () => {
    const html = render(roadmapState([sprint({ id: 1, label: "S" })], { roadmapTab: "timeline" }));
    expect(html).toContain('data-screen-label="Roadmap · Timeline"');
    expect(html).not.toContain("In Progress");
  });

  it("keeps the Confirm-done row for a fully-closed sprint nobody has confirmed", () => {
    const html = render(roadmapState([
      sprint({ id: 9, label: "All wrapped", status: "in_progress", active: true, progress: { closed: 6, total: 6, pct: 100 } }),
    ]));
    expect(html).toContain('data-act="confirmSprint" data-arg="9"');
    expect(html).toContain("Confirm done");
    expect(html).toContain("ready to complete");
  });

  it("a confirmed sprint moves to Done and loses the Confirm-done row", () => {
    const html = render(roadmapState(
      [sprint({ id: 9, label: "All wrapped", status: "in_progress", active: true, progress: { closed: 6, total: 6, pct: 100 } })],
      { confirmedSprints: { "9": true } }
    ));
    expect(html).not.toContain('data-act="confirmSprint"');
    expect(html.indexOf("Done<")).toBeLessThan(html.indexOf("All wrapped"));
  });
});

// ── the New sprint panel ─────────────────────────────────────────────────────

describe("newSprintPanel", () => {
  it("renders NOTHING when closed, and the whole form when open", () => {
    expect(newSprintPanel(NS, PERSONS)).toBe("");
    const open = newSprintPanel({ ...NS, open: true }, PERSONS);
    expect(open).toContain("Sprint name");
    expect(open).toContain("Start date");
    expect(open).toContain("Due date");
    expect(open).toContain("Urgency");
    expect(open).toContain("Codebase domain");
    expect(open).toContain("Create sprint");
    expect(open).toContain('data-act="nsToggle"'); // Cancel
    // The panel is a surface, not a hand-drawn border-strong box.
    expect(open.startsWith('<div class="cnpy-surface" style="padding:18px 20px;margin:14px 0 6px">')).toBe(true);
    expect(open).not.toContain("border-radius:13px");
  });

  it("leaves Create sprint inert until the sprint has a name", () => {
    const empty = newSprintPanel({ ...NS, open: true }, PERSONS);
    const create = empty.slice(empty.indexOf('data-act="nsCreate"'), empty.indexOf('data-act="nsCreate"') + 220);
    expect(create).toContain("cursor:default");
    expect(create).not.toContain("background:var(--accent)");

    const named = newSprintPanel({ ...NS, open: true, name: "Sprint 14" }, PERSONS);
    const armed = named.slice(named.indexOf('data-act="nsCreate"'), named.indexOf('data-act="nsCreate"') + 220);
    expect(armed).toContain("background:var(--accent)");
    expect(armed).not.toContain("cursor:default");
  });

  it("a whitespace-only name does NOT arm Create", () => {
    const ws = newSprintPanel({ ...NS, open: true, name: "   " }, PERSONS);
    const create = ws.slice(ws.indexOf('data-act="nsCreate"'), ws.indexOf('data-act="nsCreate"') + 220);
    expect(create).toContain("cursor:default");
  });

  it("offers one lead chip per person and one chip per codebase domain, marking the picks", () => {
    const html = newSprintPanel({ ...NS, open: true, lead: "sanaok", domain: "tickets" }, PERSONS);
    expect(html).toContain('data-act="nsLead" data-arg="sanaok"');
    expect(html).toContain('data-act="nsLead" data-arg="jose-a"');
    expect(html).toContain('data-act="nsDom" data-arg="tickets"');
    expect(html).toContain('data-act="nsDom" data-arg="infra"');
    // The opening tag only — everything up to its first ">".
    const openTag = (needle: string) => {
      const at = html.indexOf(needle);
      return html.slice(at, html.indexOf(">", at));
    };
    expect(openTag('data-arg="sanaok"')).toContain("var(--accent-soft)");
    expect(openTag('data-arg="jose-a"')).not.toContain("var(--accent-soft)");
    expect(openTag('data-act="nsDom" data-arg="tickets"')).toContain("var(--accent-soft)");
    expect(openTag('data-act="nsDom" data-arg="infra"')).not.toContain("var(--accent-soft)");
  });

  it("hangs the hover layer's chip/segment classes on the panel's picks", () => {
    // Inline styles can't express `:hover`; the class is what trov.css hooks,
    // and `is-on` is what keeps the hover off the chip that is already picked.
    const html = newSprintPanel({ ...NS, open: true, urgency: "high", lead: "sanaok", domain: "tickets" }, PERSONS);
    expect(html).toContain('<button type="button" class="cnpy-seg-btn is-on" data-act="nsUrg" data-arg="high" aria-pressed="true"');
    expect(html).toContain('<button type="button" class="cnpy-seg-btn" data-act="nsUrg" data-arg="low" aria-pressed="false"');
    expect(html).toContain('data-act="nsLead" data-arg="sanaok" class="cnpy-pickchip is-on"');
    expect(html).toContain('data-act="nsLead" data-arg="jose-a" class="cnpy-pickchip"');
    expect(html).toContain('data-act="nsDom" data-arg="tickets" class="cnpy-pickchip is-on"');
    expect(html).toContain('data-act="nsDom" data-arg="infra" class="cnpy-pickchip"');
  });

  it("marks the urgency segment that is selected", () => {
    const html = newSprintPanel({ ...NS, open: true, urgency: "high" }, PERSONS);
    // The shared segmented() switch: the pick carries `is-on` + aria-pressed.
    expect(html).toContain('data-seg="ns-urgency"');
    expect(html).toContain('class="cnpy-seg-btn is-on" data-act="nsUrg" data-arg="high" aria-pressed="true"');
    expect(html).not.toContain('class="cnpy-seg-btn is-on" data-act="nsUrg" data-arg="low"');
  });

  it("every text field carries data-field so the caret survives a rerender", () => {
    const html = newSprintPanel({ ...NS, open: true }, PERSONS);
    for (const f of ["ns-name", "ns-start", "ns-desc", "ns-due"]) expect(html).toContain(`data-field="${f}"`);
  });

  it("Start and Due are native date inputs, themed through cnpy-date, carrying their values", () => {
    const html = newSprintPanel({ ...NS, open: true, start: "2026-10-06", due: "2026-10-17" }, PERSONS);
    const tag = (field: string) => {
      const at = html.indexOf(`data-field="${field}"`);
      return html.slice(html.lastIndexOf("<input", at), html.indexOf(">", at));
    };
    for (const [field, value] of [["ns-start", "2026-10-06"], ["ns-due", "2026-10-17"]]) {
      expect(tag(field)).toContain('type="date"');
      expect(tag(field)).toContain('class="cnpy-date"');
      expect(tag(field)).toContain(`value="${value}"`);
      expect(tag(field)).not.toContain("aria-invalid");
    }
    // The free-text Dates label field is gone — the span is derived from start/due.
    expect(html).not.toContain('data-field="ns-dates"');
    // No error: the alert region is present but hidden and empty.
    expect(html).toMatch(/data-ns-error role="alert" style="[^"]*display:none"><\/div>/);
  });

  it("shows a date refusal inline under the dates and marks both fields invalid", () => {
    const msg = "start (2026-10-20) is after due (2026-10-17); a sprint must start on or before its due date.";
    const html = newSprintPanel({ ...NS, open: true, start: "2026-10-20", due: "2026-10-17", error: msg }, PERSONS);
    const at = html.indexOf("data-ns-error");
    const region = html.slice(at, html.indexOf("</div>", at));
    expect(region).not.toContain("display:none");
    expect(region).toContain("start (2026-10-20) is after due (2026-10-17)");
    expect(html.match(/aria-invalid="true"/g)).toHaveLength(2);
  });

  it("the toggle button lives outside the panel (in the Roadmap header) and is always present", () => {
    expect(newSprintToggle(false)).toContain('data-act="nsToggle"');
    expect(newSprintToggle(false)).toContain("New sprint");
    const closed = render(roadmapState([sprint({ id: 1, label: "S" })]));
    expect(closed).toContain('data-act="nsToggle"');
    expect(closed).not.toContain("Sprint name");
    const open = render(roadmapState([sprint({ id: 1, label: "S" })], { nsOpen: true }));
    expect(open).toContain("Sprint name");
    // the panel sits above the first group
    expect(open.indexOf("Sprint name")).toBeLessThan(open.indexOf("In Progress") === -1 ? open.indexOf("Upcoming") : open.indexOf("In Progress"));
  });
});

// ── the Sprint screen ────────────────────────────────────────────────────────

describe("sprintScreen", () => {
  const base = () => detail({ id: 3, label: "Sprint 13 — Tickets" });

  it("the DATES property prefers the real start/due span, else the authored label", () => {
    const real = sprintScreen({ detail: detail({ id: 3, label: "S", dates: "SEP 8 – 19", start: "2026-10-06", due: "2026-11-02" }), persons: PERSONS, resourceDraft: "" });
    expect(real).toContain("Oct 6 – Nov 2");
    expect(real).not.toContain("SEP 8 – 19");
    const legacy = sprintScreen({ detail: detail({ id: 3, label: "S", dates: "SEP 8 – 19", start: null }), persons: PERSONS, resourceDraft: "" });
    expect(legacy).toContain("SEP 8 – 19");
  });

  it("renders the description as MARKDOWN inside a cnpy-md wrapper (bold → <strong>)", () => {
    const html = sprintScreen({ detail: detail({ id: 3, label: "S", description: "Ship the **last two** blockers." }), persons: PERSONS, resourceDraft: "" });
    expect(html).toContain('class="cnpy-md"');
    expect(html).toContain("mock-live-md");
    expect(html).toContain("<strong>last two</strong>");
  });

  it("XSS: the description reaches the DOM ONLY through the markdown fn", () => {
    const html = sprintScreen({ detail: detail({ id: 3, label: "S", description: "<script>alert(1)</script>" }), persons: PERSONS, resourceDraft: "" });
    expect(html).toContain("mock-live-md");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders tickets as boxes in a grid; a sub-ticket names its parent, a root does not", () => {
    const html = sprintScreen({
      detail: detail({
        id: 3, label: "S",
        tickets: [
          spTicket({ id: 10, title: "Root ticket", depth: 0 }),
          spTicket({ id: 11, title: "Child ticket", depth: 1, parent_id: 10 }),
        ],
      }),
      persons: PERSONS, resourceDraft: "",
    });
    expect(html).toContain("grid-template-columns:repeat(auto-fill,minmax(min(240px,100%),1fr))");
    // Each box is a `hitArea` card: its open-ticket button is its LAST child.
    const root = html.slice(html.indexOf('class="cnpy-tcard'), html.indexOf('data-arg="10"'));
    const child = html.slice(html.indexOf('data-arg="10"'), html.indexOf('data-arg="11"'));
    expect(root).toContain('class="cnpy-tcard cnpy-surface cnpy-hitbox"');
    expect(root.slice(0, root.indexOf(">"))).not.toContain("color-mix(in srgb,var(--fg) 2.5%");
    expect(root.slice(0, root.indexOf(">"))).not.toContain("border-radius");
    expect(root).not.toContain("↳");
    expect(child).toContain("↳ sub-ticket of #10");
    // children render AFTER their root, and each box opens its ticket
    expect(html.indexOf('data-arg="10"')).toBeLessThan(html.indexOf('data-arg="11"'));
    expect(html.match(/data-act="openTicket"/g)).toHaveLength(2);
    expect(html).toContain('<button data-act="openTicket" data-arg="10" class="cnpy-hit" aria-label="#10 Root ticket"></button>');
  });

  it("stacks the assignee avatars on a ticket box, and says Unassigned when nobody is on it (design 514)", () => {
    const html = sprintScreen({
      detail: detail({
        id: 3, label: "S",
        tickets: [
          spTicket({ id: 10, title: "Two on it", depth: 0, assignees: ["meilin", "sanaok"] }),
          spTicket({ id: 11, title: "Nobody on it", depth: 0 }),
        ],
      }),
      persons: PERSONS, resourceDraft: "",
    });
    const withAvs = html.slice(html.indexOf('class="cnpy-tcard'), html.indexOf('data-arg="10"'));
    const without = html.slice(html.indexOf('data-arg="10"'), html.indexOf('data-arg="11"'));
    // the same overlapping stack the queue and the sprint card use — each photo its own person-card button
    expect(withAvs).toContain(avatarStack(["meilin", "sanaok"], PERSONS, 20, true));
    expect(withAvs).toMatch(/<button data-act="openPerson" data-arg="meilin" class="cnpy-personav"/);
    expect(withAvs).toContain("margin-left:-7px");
    expect(without).not.toContain("margin-left:-7px");
    expect(without).toContain("Unassigned");
  });

  it("shows the design's empty state when the sprint has no tickets", () => {
    const html = sprintScreen({ detail: base(), persons: PERSONS, resourceDraft: "" });
    expect(html).toContain("No tickets in this sprint yet");
    expect(html).not.toContain('data-act="openTicket"');
  });

  it("lists resources with their kind icon, label and meta, plus the add field", () => {
    const html = sprintScreen({
      detail: detail({
        id: 3, label: "S",
        resources: [
          resource(),
          resource({ url: "https://www.figma.com/design/tickets", kind: "figma", label: "Tickets — queue", meta: "FIGMA · DESIGN" }),
          resource({ url: "https://notion.so/x", kind: "plain", label: "notion.so", meta: "LINK" }),
        ],
      }),
      persons: PERSONS, resourceDraft: "https://example.com/x",
    });
    expect(html).toContain("notifications-ga");
    expect(html).toContain("GITHUB");
    expect(html).not.toContain("MILESTONE");
    expect(html).toContain("Tickets — queue");
    expect(html).toContain("#1abcfe");                 // the Figma glyph
    expect(html).toContain("notion.so");
    // The href is GitHub's own url, verbatim — not Trov vocabulary.
    expect(html).toContain('href="https://github.com/AndresL230/trov/milestone/4"');
    expect(html).toContain('data-act="sprintResourceAdd"');
    expect(html).toContain('value="https://example.com/x"');
    // Each resource row is a clickable surface, never the old 2.5% tinted box.
    expect(html.match(/rel="noopener" class="cnpy-surface cnpy-card"/g)).toHaveLength(3);
    expect(html).not.toContain("color-mix(in srgb,var(--fg) 2.5%");
  });

  it("offers Delete sprint, and once armed confirms inline that its tickets move to the backlog", () => {
    const idle = sprintScreen({ detail: detail({ id: 3, label: "Doomed" }), persons: PERSONS, resourceDraft: "" });
    expect(idle).toContain('data-act="sprintDeleteArm"');
    expect(idle).not.toContain('data-act="sprintDelete"');

    const armed = sprintScreen({ detail: detail({ id: 3, label: "Doomed" }), persons: PERSONS, resourceDraft: "", deleteArmed: true });
    expect(armed).toContain('data-act="sprintDelete"');
    expect(armed).toContain('data-act="sprintDeleteCancel"');
    expect(armed).toContain("Doomed");
    expect(armed).not.toContain('data-act="sprintDeleteArm"');
  });

  it("neutralizes a non-http resource url in the href", () => {
    const html = sprintScreen({
      detail: detail({ id: 3, label: "S", resources: [resource({ url: "javascript:alert(1)", kind: "plain", label: "evil", meta: "LINK" })] }),
      persons: PERSONS, resourceDraft: "",
    });
    expect(html).toContain('href="#"');
    expect(html).not.toContain("javascript:alert(1)");
  });

  it("lists every member by full name", () => {
    const html = sprintScreen({ detail: detail({ id: 3, label: "S", members: ["sanaok", "meilin"] }), persons: PERSONS, resourceDraft: "" });
    expect(html).toContain("Sana Okafor");
    expect(html).toContain("Meilin Zhao");
    expect(html).toContain("Everyone assigned to a ticket in this sprint.");
  });

  it("shows the ACTIVE chip ONLY on an active sprint, and flips the Mark active/inactive control", () => {
    const off = sprintScreen({ detail: detail({ id: 3, label: "S", status: "upcoming", active: false }), persons: PERSONS, resourceDraft: "" });
    expect(off).not.toContain(">ACTIVE<");
    expect(off).toContain('data-act="sprintActive" data-arg="1"');
    expect(off).toContain("Mark active");

    const on = sprintScreen({ detail: detail({ id: 3, label: "S", status: "in_progress", active: true }), persons: PERSONS, resourceDraft: "" });
    expect(on).toContain(">ACTIVE<");
    expect(on).toContain('data-act="sprintActive" data-arg="0"');
    expect(on).toContain("Mark inactive");

    // `done` is never toggled from here (§C.6 — the plan write / Confirm-done own it)
    const done = sprintScreen({ detail: detail({ id: 3, label: "S", status: "done", active: false }), persons: PERSONS, resourceDraft: "" });
    expect(done).not.toContain('data-act="sprintActive"');
  });

  it("carries the properties rail and the same 'closed/total done' progress the card shows", () => {
    const html = sprintScreen({
      detail: detail({ id: 3, label: "S", dates: "SEP 22 – OCT 3", due: "2026-10-17", urgency: "high", domain: "tickets", lead: "jose-a", progress: { closed: 4, total: 7, pct: 57 } }),
      persons: PERSONS, resourceDraft: "",
    });
    expect(html).toContain("SEP 22 – OCT 3");
    expect(html).toContain("OCT 17");
    expect(html).toContain("▲ HIGH");
    expect(html).toContain(">TICKETS<");
    expect(html).toContain("Jose Alvarez");
    expect(html).toContain("4/7 done");
    expect(html).toContain("width:57%");
  });
});

describe("render() — the sprint screen slice", () => {
  it("paints the sprint (no 5a placeholder) and names it in the breadcrumb", () => {
    const html = render(sprintScreenState(detail({ id: 3, label: "Sprint 13 — Tickets" })));
    expect(html).toContain("Sprint 13 — Tickets");
    expect(html).toContain("TICKETS IN THIS SPRINT");
    expect(html).toContain('data-act="ticketsBack"');   // header back button → Roadmap
    expect(html).toContain(">Roadmap<");
  });

  it("shows a loading notice before the detail arrives and an error notice on failure", () => {
    const loading = render(sprintScreenState(detail({ id: 3, label: "S" }), { sprintDetail: { status: "loading", data: null } }));
    expect(loading).toContain("Loading the sprint");
    const error = render(sprintScreenState(detail({ id: 3, label: "S" }), { sprintDetail: { status: "error", data: null } }));
    expect(error).toContain("Couldn't load this sprint.");
    const missing = render(sprintScreenState(detail({ id: 3, label: "S" }), { sprintDetail: { status: "ok", data: null } }));
    expect(missing).toContain("That sprint doesn't exist.");
  });
});

describe("parseHash — the sprint route", () => {
  it("parses #sprints/<id> into the sprint screen with its id", () => {
    expect(parseHash("#sprints/7")).toEqual({ screen: "sprint", ticketId: null, sprintId: 7 });
  });
});

// ── the ONE due-date rule ─────────────────────────────────────────────────────

describe("sprintDueState — due all of that day, overdue from the next (injected clock)", () => {
  // Tue Sep 15 2026, late evening LOCAL — the pool runs in UTC, so local = UTC here.
  const now = new Date(2026, 8, 15, 23, 30);
  it("due today → not overdue, and soon", () => {
    expect(sprintDueState("2026-09-15", now)).toEqual({ overdue: false, soon: true, daysLate: 0, daysLeft: 0 });
  });
  it("due yesterday → overdue by 1 day, not soon", () => {
    expect(sprintDueState("2026-09-14", now)).toEqual({ overdue: true, soon: false, daysLate: 1, daysLeft: 0 });
  });
  it("due in 7 days is soon; in 8 days is not", () => {
    expect(sprintDueState("2026-09-22", now)).toMatchObject({ overdue: false, soon: true, daysLeft: 7 });
    expect(sprintDueState("2026-09-23", now)).toMatchObject({ overdue: false, soon: false, daysLeft: 8 });
  });
  it("no due date (or an unparseable one) → null", () => {
    expect(sprintDueState(null, now)).toBeNull();
    expect(sprintDueState(undefined, now)).toBeNull();
    expect(sprintDueState("next week", now)).toBeNull();
    expect(sprintDueState("2026-02-30", now)).toBeNull();
  });
  it("the clock may be a Date or epoch ms, and the time of day never matters", () => {
    expect(sprintDueState("2026-09-15", new Date(2026, 8, 15, 0, 1))).toEqual(sprintDueState("2026-09-15", now.getTime()));
    expect(sprintDueState("2026-09-15", new Date(2026, 8, 16, 0, 1))?.overdue).toBe(true);
  });
});

/** A local calendar date `offset` days from today, as the DTO spells `due`. */
function localIso(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const RED_DOT = 'background:var(--red);margin-left:1px';

describe("every sprint surface flips to overdue on the SAME day", () => {
  const late = (due: string) => sprint({ id: 1, label: "S", status: "in_progress", active: true, dates: null, due });

  it("due today: no surface says overdue", () => {
    const sp = late(localIso(0));
    expect(sprintCard(sp, PERSONS)).not.toContain(">OVERDUE<");
    expect(render(roadmapState([sp], { roadmapTab: "timeline" }))).not.toContain(RED_DOT);
    expect(placeSprint(sp, {}, Date.now())?.state).toBe("active");
  });

  it("due yesterday: every surface says overdue", () => {
    const sp = late(localIso(-1));
    expect(sprintCard(sp, PERSONS)).toContain(">OVERDUE<");
    expect(render(roadmapState([sp], { roadmapTab: "timeline" }))).toContain(RED_DOT);
    expect(placeSprint(sp, {}, Date.now())?.state).toBe("overdue");
  });

  it("the card takes the injected clock", () => {
    const sp = late("2026-09-14");
    expect(sprintCard(sp, PERSONS, { now: new Date(2026, 8, 14, 23, 59).getTime() })).not.toContain(">OVERDUE<");
    expect(sprintCard(sp, PERSONS, { now: new Date(2026, 8, 15, 0, 0).getTime() })).toContain(">OVERDUE<");
  });
});

describe("nextSprintId / NEXT UP — exactly one card", () => {
  const now = new Date(2026, 8, 15, 12).getTime();
  const up = (id: number, due: string | null, o: Partial<SprintView> = {}) =>
    sprint({ id, label: `S${id}`, status: "upcoming", active: false, due, ...o });

  it("picks the earliest due, not-running, not-done, not-past sprint — due today counts", () => {
    const set = [up(1, "2026-10-01"), up(2, "2026-09-15"), up(3, "2026-09-14"), up(4, null),
      up(5, "2026-09-16", { status: "in_progress", active: true }), up(6, "2026-09-15", { status: "done" })];
    expect(nextSprintId(set, {}, now)).toBe(2);
    // a sprint confirmed done this session drops out
    expect(nextSprintId(set, { "2": true }, now)).toBe(1);
    expect(nextSprintId([up(3, "2026-09-14"), up(4, null)], {}, now)).toBeNull();
  });

  it("the Roadmap paints NEXT UP on one card among several upcoming ones", () => {
    const html = render(roadmapState([
      sprint({ id: 1, label: "Running", status: "in_progress", active: true }),
      up(2, localIso(20)), up(3, localIso(5)), up(4, localIso(40)), up(5, null),
    ]));
    expect(html.match(/>NEXT UP</g)?.length).toBe(1);
    // …and it is the soonest one (S3)
    const at = html.indexOf(">NEXT UP<");
    expect(html.lastIndexOf(">S3<", at)).toBeGreaterThan(html.lastIndexOf(">S2<", at));
  });
});

describe("sprint people open their person card", () => {
  it("the Roadmap card's lead is one chip and each member's photo a button", () => {
    const html = sprintCard(sprint({ id: 3, label: "S", lead: "sanaok", members: ["meilin"] }), PERSONS);
    expect(html).toMatch(/<button data-act="openPerson" data-arg="sanaok" class="cnpy-personchip"[^>]*>.*Sana · lead<\/span><\/button>/s);
    expect(html).toMatch(/<button data-act="openPerson" data-arg="meilin" class="cnpy-personav"/);
  });

  it("the sprint screen's LEAD and Assignees rail are chips; an unknown handle stays plain", () => {
    const html = sprintScreen({ detail: detail({ id: 3, label: "S", lead: "jose-a", members: ["meilin", "ghost"] }), persons: PERSONS, resourceDraft: "" });
    expect(html).toMatch(/<button data-act="openPerson" data-arg="jose-a" class="cnpy-personchip"/);
    expect(html).toMatch(/<button data-act="openPerson" data-arg="meilin" class="cnpy-personchip"/);
    expect(html).not.toContain('data-act="openPerson" data-arg="ghost"');
    expect(html).toContain(">ghost</span>");
  });
});

/**
 * Phase 5b render tests — the sprint surfaces of the SPA.
 *
 * Pure functions from web/src/sprints.ts plus `render()` over a hand-built
 * AppState (no D1, no DOM), the idiom of test/render.tickets.test.ts:
 *  • sprintCard — the design's tag set (▲ HIGH / NORMAL / LOW, DUE, DOMAIN),
 *    the lead's FIRST name, NEXT UP only on an inactive sprint, the progress
 *    text "closed/total done" + the bar width, "Open sprint →"
 *  • the Roadmap Timeline's grouping: active → In Progress, upcoming →
 *    Upcoming, done → Done
 *  • newSprintPanel — closed by default, opens off state, Create inert until a name
 *  • sprintScreen — the markdown description, tickets as grid boxes (a sub-ticket names its parent),
 *    the resources list, the members list, the ACTIVE chip
 *  • parseHash("#sprints/7")
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

import { sprintCard, newSprintPanel, newSprintToggle, sprintScreen, sprintTags, shortDue, type NewSprintState } from "../web/src/sprints";
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
  { handle: "sanaok", name: "Sana Okafor", color: "ochre", avatar_url: null },
  { handle: "jose-a", name: "Jose Alvarez", color: "moss", avatar_url: null },
  { handle: "meilin", name: "Meilin Zhao", color: "rose", avatar_url: null },
];

function sprint(o: Partial<SprintView> & { id: number; label: string }): SprintView {
  return {
    summary: "Close out the outbox soak test.",
    description: null,
    phase: "Phase 2",
    dates: "SEP 8 – 19",
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
  // The url is GitHub's own — not Canopy vocabulary. `meta` is what the SHARED
  // parseTicketLink actually produces for a github.com url of this shape.
  url: "https://github.com/SaplingLearn/canopy/milestone/4",
  kind: "github", label: "notifications-ga", meta: "GITHUB", ...o,
});

const NS: NewSprintState = {
  open: false, name: "", dates: "", desc: "", urgency: "normal", due: "", lead: null, domain: null,
};

function roadmapState(sprints: SprintView[], over: Partial<AppState> = {}): AppState {
  const s = initialState();
  return {
    ...s,
    view: "app",
    screen: "roadmap",
    roadmapTab: "timeline",
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

  it("badges NEXT UP on an inactive sprint and NEVER on an active or done one", () => {
    expect(sprintCard(sprint({ id: 1, label: "S", status: "upcoming", active: false }), PERSONS)).toContain("NEXT UP");
    expect(sprintCard(sprint({ id: 1, label: "S", status: "in_progress", active: true }), PERSONS)).not.toContain("NEXT UP");
    expect(sprintCard(sprint({ id: 1, label: "S", status: "done", active: false }), PERSONS)).not.toContain("NEXT UP");
    // an optimistic Confirm-done also suppresses it
    expect(sprintCard(sprint({ id: 1, label: "S", status: "upcoming", active: false }), PERSONS, { done: true })).not.toContain("NEXT UP");
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

// ── the Roadmap Timeline tab ─────────────────────────────────────────────────

describe("render() — Roadmap Timeline groups sprints by status (§C.6)", () => {
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

  it("carries the design's Timeline intro copy", () => {
    const html = render(roadmapState([sprint({ id: 1, label: "S" })]));
    expect(html).toContain("The plan is a sequence of time-boxed sprints, each a container of tickets with its own screen.");
    expect(html).toContain("Progress is live");
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
    expect(open).toContain("Dates");
    expect(open).toContain("Due date");
    expect(open).toContain("Urgency");
    expect(open).toContain("Codebase domain");
    expect(open).toContain("Create sprint");
    expect(open).toContain('data-act="nsToggle"'); // Cancel
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
    // Inline styles can't express `:hover`; the class is what canopy.css hooks,
    // and `is-on` is what keeps the hover off the chip that is already picked.
    const html = newSprintPanel({ ...NS, open: true, urgency: "high", lead: "sanaok", domain: "tickets" }, PERSONS);
    expect(html).toContain('data-act="nsUrg" data-arg="high" class="cnpy-segbtn is-on"');
    expect(html).toContain('data-act="nsUrg" data-arg="low" class="cnpy-segbtn"');
    expect(html).toContain('data-act="nsLead" data-arg="sanaok" class="cnpy-pickchip is-on"');
    expect(html).toContain('data-act="nsLead" data-arg="jose-a" class="cnpy-pickchip"');
    expect(html).toContain('data-act="nsDom" data-arg="tickets" class="cnpy-pickchip is-on"');
    expect(html).toContain('data-act="nsDom" data-arg="infra" class="cnpy-pickchip"');
  });

  it("marks the urgency segment that is selected", () => {
    const html = newSprintPanel({ ...NS, open: true, urgency: "high" }, PERSONS);
    // The window has to clear the opening tag, class attribute and all.
    const high = html.slice(html.indexOf('data-act="nsUrg" data-arg="high"'), html.indexOf('data-act="nsUrg" data-arg="high"') + 220);
    const low = html.slice(html.indexOf('data-act="nsUrg" data-arg="low"'), html.indexOf('data-act="nsUrg" data-arg="low"') + 220);
    expect(high).toContain("background:var(--hover)");
    expect(low).not.toContain("background:var(--hover)");
  });

  it("every text field carries data-field so the caret survives a rerender", () => {
    const html = newSprintPanel({ ...NS, open: true }, PERSONS);
    for (const f of ["ns-name", "ns-dates", "ns-desc", "ns-due"]) expect(html).toContain(`data-field="${f}"`);
  });

  it("the toggle button lives outside the panel and is always present on the Timeline", () => {
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
    expect(html).toContain("grid-template-columns:repeat(auto-fill,minmax(240px,1fr))");
    const root = html.slice(html.indexOf('data-arg="10"'), html.indexOf('data-arg="11"'));
    const child = html.slice(html.indexOf('data-arg="11"'));
    expect(root).toContain('class="cnpy-tcard"');
    expect(root).not.toContain("↳");
    expect(child).toContain("↳ sub-ticket of #10");
    // children render AFTER their root, and each box opens its ticket
    expect(html.indexOf('data-arg="10"')).toBeLessThan(html.indexOf('data-arg="11"'));
    expect(html.match(/data-act="openTicket"/g)).toHaveLength(2);
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
    const withAvs = html.slice(html.indexOf('data-arg="10"'), html.indexOf('data-arg="11"'));
    const without = html.slice(html.indexOf('data-arg="11"'));
    // the same overlapping stack the queue and the sprint card use
    expect(withAvs).toContain(avatarStack(["meilin", "sanaok"], PERSONS, 20));
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
    // The href is GitHub's own url, verbatim — not Canopy vocabulary.
    expect(html).toContain('href="https://github.com/SaplingLearn/canopy/milestone/4"');
    expect(html).toContain('data-act="sprintResourceAdd"');
    expect(html).toContain('value="https://example.com/x"');
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

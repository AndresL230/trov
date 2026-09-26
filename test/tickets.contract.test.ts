import { describe, it, expect } from "vitest";
import {
  TICKET_TRANSITIONS, TICKET_STATUS_LABEL, TICKET_STATUSES,
  canTransition, legalMoves, isOpenStatus, parseTicketLink, placeInColumn, boardOrder, BOARD_RANK_STEP,
  TicketCreate, TicketTransition, TicketAssigneeToggle, TicketLinkAdd,
  TicketSprintSet, TicketParentSet, TicketCommentAdd,
  TicketSeg, TicketAssigneeFilter, TicketRow, TicketEventRow,
  type TicketStatus,
} from "@shared/tickets";

// The contract layer: the status machine, the list-filter vocabulary, the
// payload schemas, and the link parser. Pure — no D1, no routes.

// ── the transition table, written out literally ──────────────────────────────
// Deliberately NOT derived from TICKET_TRANSITIONS: this table is the spec, and
// a test that reads the constant it is checking cannot fail when the constant
// changes. All 4x4 = 16 ordered pairs, including every self-transition.
// The board moves freely (2026-09-26): every OPEN status → every other status;
// done and declined stay terminal. Written out pair by pair on purpose.
const OPEN = ["submitted", "in_progress", "testing"] as const;
const EXPECTED_TRANSITIONS: ReadonlyArray<readonly [TicketStatus, TicketStatus, boolean]> =
  (["submitted", "in_progress", "testing", "done", "declined"] as const).flatMap((from) =>
    (["submitted", "in_progress", "testing", "done", "declined"] as const).map((to) =>
      [from, to, (OPEN as readonly string[]).includes(from) && from !== to] as const));

describe("ticket status machine", () => {
  it("canTransition matches the spec for all 25 from→to pairs", () => {
    // The table must actually be exhaustive over the status vocabulary.
    expect(EXPECTED_TRANSITIONS.length).toBe(25);
    expect(TICKET_STATUSES.length).toBe(5);
    // The two moves the owner asked for by name.
    expect(canTransition("submitted", "done")).toBe(true);
    expect(canTransition("in_progress", "testing")).toBe(true);
    const covered = new Set(EXPECTED_TRANSITIONS.map(([f, t]) => `${f}>${t}`));
    for (const from of TICKET_STATUSES) {
      for (const to of TICKET_STATUSES) {
        expect(covered.has(`${from}>${to}`), `pair ${from}→${to} missing from the table`).toBe(true);
      }
    }

    for (const [from, to, allowed] of EXPECTED_TRANSITIONS) {
      expect(canTransition(from, to), `${from} → ${to}`).toBe(allowed);
    }
  });

  it("legalMoves returns exactly the allowed targets per status, in pipeline order", () => {
    expect(legalMoves("submitted")).toEqual(["in_progress", "testing", "done", "declined"]);
    expect(legalMoves("in_progress")).toEqual(["testing", "done", "declined", "submitted"]);
    expect(legalMoves("testing")).toEqual(["done", "in_progress", "declined", "submitted"]);
    expect(legalMoves("done")).toEqual([]);
    expect(legalMoves("declined")).toEqual([]);
  });

  it("legalMoves hands back a copy — a caller cannot mutate the transition table", () => {
    const moves = legalMoves("done");
    moves.push("submitted");
    expect(legalMoves("done")).toEqual([]);
    expect(TICKET_TRANSITIONS.done).toEqual([]);
    expect(canTransition("done", "submitted")).toBe(false);
  });

  it("isOpenStatus splits the queue into open (submitted, in_progress, testing) and closed", () => {
    expect(isOpenStatus("submitted")).toBe(true);
    expect(isOpenStatus("in_progress")).toBe(true);
    expect(isOpenStatus("testing")).toBe(true);
    expect(isOpenStatus("done")).toBe(false);
    expect(isOpenStatus("declined")).toBe(false);
  });

  it("TICKET_STATUS_LABEL is the design's display vocabulary — `submitted` reads Triage", () => {
    expect(TICKET_STATUS_LABEL).toEqual({
      submitted: "Triage",
      in_progress: "In progress",
      testing: "Testing",
      done: "Done",
      declined: "Declined",
    });
  });
});

// ── the board's saved order ──────────────────────────────────────────────────
describe("placeInColumn / boardOrder", () => {
  const k = (id: number, board_rank: number | null, updated_at = "2026-09-01T00:00:00Z") => ({ id, board_rank, updated_at });

  it("puts unpositioned cards first (newest first), then ranked cards by rank", () => {
    const col = [k(1, 2048), k(2, null, "2026-09-01T00:00:00Z"), k(3, 1024), k(4, null, "2026-09-05T00:00:00Z")];
    expect([...col].sort(boardOrder).map((t) => t.id)).toEqual([4, 2, 3, 1]);
  });

  it("splits the gap between two ranked neighbours, with no renumbering", () => {
    const r = placeInColumn([k(1, 1024), k(2, 2048)], 1);
    expect(r).toEqual({ rank: 1536, renumber: null });
    expect(placeInColumn([k(1, 1024), k(2, 2048)], null).rank).toBe(0);          // the top
    expect(placeInColumn([k(1, 1024), k(2, 2048)], 2).rank).toBe(3072);          // the end
    expect(placeInColumn([], null)).toEqual({ rank: BOARD_RANK_STEP, renumber: null });
  });

  it("renumbers a column holding unpositioned cards in its CURRENT visible order first", () => {
    const col = [k(1, 1024), k(2, null, "2026-09-01T00:00:00Z"), k(3, null, "2026-09-09T00:00:00Z")];
    const { rank, renumber } = placeInColumn(col, 2);                             // visible: 3, 2, 1
    expect(renumber && Object.fromEntries(renumber)).toEqual({ 3: 1024, 2: 2048, 1: 3072 });
    expect(rank).toBe(2560);                                                     // between 2 and 1
  });

  it("renumbers when two neighbours are too close to split", () => {
    const { rank, renumber } = placeInColumn([k(1, 1), k(2, 1 + 1e-9)], 1);
    expect(renumber && Object.fromEntries(renumber)).toEqual({ 1: 1024, 2: 2048 });
    expect(rank).toBe(1536);
  });

  it("an after id that is not in the column means the top", () => {
    expect(placeInColumn([k(1, 1024)], 999).rank).toBe(0);
  });
});

// ── the link parser ──────────────────────────────────────────────────────────
describe("parseTicketLink", () => {
  it("resolves a bare issue number and a #-prefixed one to the same repo issue URL", () => {
    const bare = parseTicketLink("214");
    const hashed = parseTicketLink("#214");
    expect(bare).toEqual({
      url: "https://github.com/SaplingLearn/sapling/issues/214",
      kind: "github",
      label: "sapling #214",
      meta: "GITHUB · ISSUE",
    });
    expect(hashed).toEqual(bare);
  });

  it("honours a non-default repo for bare refs", () => {
    expect(parseTicketLink("#7", "SaplingLearn/canopy")).toEqual({
      url: "https://github.com/SaplingLearn/canopy/issues/7",
      kind: "github",
      label: "canopy #7",
      meta: "GITHUB · ISSUE",
    });
  });

  it("shape 1 — a GitHub issue URL", () => {
    expect(parseTicketLink("https://github.com/SaplingLearn/sapling/issues/214")).toEqual({
      url: "https://github.com/SaplingLearn/sapling/issues/214",
      kind: "github",
      label: "sapling #214",
      meta: "GITHUB · ISSUE",
    });
  });

  it("shape 2 — a GitHub pull request URL", () => {
    expect(parseTicketLink("https://github.com/SaplingLearn/canopy/pull/43")).toEqual({
      url: "https://github.com/SaplingLearn/canopy/pull/43",
      kind: "github",
      label: "canopy #43",
      meta: "GITHUB · PULL REQUEST",
    });
  });

  it("shape 3 — any other github.com URL keeps kind github with the path as label (40 chars)", () => {
    // A GitHub url, verbatim — not Canopy vocabulary.
    expect(parseTicketLink("https://github.com/SaplingLearn/canopy/milestone/4")).toEqual({
      url: "https://github.com/SaplingLearn/canopy/milestone/4",
      kind: "github",
      label: "SaplingLearn/canopy/milestone/4",
      meta: "GITHUB",
    });

    const long = parseTicketLink("https://github.com/SaplingLearn/canopy/tree/feat/tickets/some/deep/path/that/keeps/going");
    expect(long!.kind).toBe("github");
    expect(long!.meta).toBe("GITHUB");
    expect(long!.label.length).toBe(40);
    expect(long!.label).toBe("SaplingLearn/canopy/tree/feat/tickets/so");

    // Bare github.com with nothing after it → the "GitHub" fallback label.
    expect(parseTicketLink("https://github.com/")).toEqual({
      url: "https://github.com/",
      kind: "github",
      label: "GitHub",
      meta: "GITHUB",
    });
  });

  it("shape 4 — a Figma URL humanizes the last path segment", () => {
    expect(parseTicketLink("https://www.figma.com/design/abc123/canopy-tickets_queue?node-id=1-2")).toEqual({
      url: "https://www.figma.com/design/abc123/canopy-tickets_queue?node-id=1-2",
      kind: "figma",
      label: "Canopy tickets queue",
      meta: "FIGMA · DESIGN",
    });
  });

  it("shape 5 — anything else is a plain link labeled with the hostname sans www.", () => {
    expect(parseTicketLink("https://www.notion.so/team/spec-page")).toEqual({
      url: "https://www.notion.so/team/spec-page",
      kind: "plain",
      label: "notion.so",
      meta: "LINK",
    });
    expect(parseTicketLink("http://example.com/x")!.label).toBe("example.com");
  });

  it("trims, and treats an empty/whitespace-only input as no link", () => {
    expect(parseTicketLink("  https://github.com/SaplingLearn/sapling/issues/9  ")).toEqual({
      url: "https://github.com/SaplingLearn/sapling/issues/9",
      kind: "github",
      label: "sapling #9",
      meta: "GITHUB · ISSUE",
    });
    expect(parseTicketLink("  #12\n")!.url).toBe("https://github.com/SaplingLearn/sapling/issues/12");
    expect(parseTicketLink("")).toBeNull();
    expect(parseTicketLink("   ")).toBeNull();
  });

  it("refuses a non-http(s) scheme instead of pasting it into an issue URL", () => {
    expect(parseTicketLink("javascript:alert(1)")).toBeNull();
    expect(parseTicketLink("  JavaScript:alert(1)  ")).toBeNull();
    expect(parseTicketLink("data:text/html,<script>x</script>")).toBeNull();
    expect(parseTicketLink("mailto:someone@example.com")).toBeNull();
    // …while an uppercase http(s) scheme is still just a URL.
    expect(parseTicketLink("HTTPS://example.com/x")!.kind).toBe("plain");
  });
});

// ── payload schemas ──────────────────────────────────────────────────────────
describe("ticket payload schemas", () => {
  it("TicketCreate requires only a title and fills the design's defaults", () => {
    expect(TicketCreate.parse({ title: "Laptop won't sleep" })).toEqual({
      title: "Laptop won't sleep",
      body: "",
      category: "other",
      priority: "normal",
      assignees: [],
    });

    const full = TicketCreate.parse({
      title: "Access to the billing dashboard",
      body: "Need read access.",
      category: "access",
      priority: "high",
      assignees: ["andres", "luke"],
      sprint_id: 3,
      link: "#214",
    });
    expect(full.category).toBe("access");
    expect(full.sprint_id).toBe(3);
    expect(full.link).toBe("#214");

    expect(TicketCreate.safeParse({ title: "" }).success).toBe(false);
    expect(TicketCreate.safeParse({ body: "no title" }).success).toBe(false);
    expect(TicketCreate.safeParse({ title: "t", category: "chore" }).success).toBe(false);
    expect(TicketCreate.safeParse({ title: "t", priority: "urgent" }).success).toBe(false);
    expect(TicketCreate.parse({ title: "t", sprint_id: null }).sprint_id).toBeNull();
  });

  it("the small payloads validate their one field", () => {
    expect(TicketTransition.parse({ to: "in_progress" })).toEqual({ to: "in_progress" });
    expect(TicketTransition.safeParse({ to: "archived" }).success).toBe(false);

    expect(TicketAssigneeToggle.parse({ login: "andres", on: true })).toEqual({ login: "andres", on: true });
    expect(TicketAssigneeToggle.safeParse({ login: "andres" }).success).toBe(false);
    expect(TicketAssigneeToggle.safeParse({ login: "", on: false }).success).toBe(false);

    expect(TicketLinkAdd.parse({ raw: "#214" })).toEqual({ raw: "#214" });
    expect(TicketLinkAdd.safeParse({ raw: "" }).success).toBe(false);

    expect(TicketSprintSet.parse({ sprint_id: null })).toEqual({ sprint_id: null });
    expect(TicketSprintSet.parse({ sprint_id: 2 })).toEqual({ sprint_id: 2 });
    expect(TicketSprintSet.safeParse({}).success).toBe(false);

    expect(TicketParentSet.parse({ child_id: 5 })).toEqual({ child_id: 5 });
    expect(TicketParentSet.safeParse({ child_id: "5" }).success).toBe(false);

    // Comments are trimmed, and whitespace alone is not a comment.
    expect(TicketCommentAdd.parse({ body: "  looking into it  " })).toEqual({ body: "looking into it" });
    expect(TicketCommentAdd.safeParse({ body: "   " }).success).toBe(false);
  });

  it("the list filters are closed vocabularies", () => {
    expect(TicketSeg.options).toEqual(["open", "closed", "all"]);
    expect(TicketAssigneeFilter.options).toEqual(["anyone", "me", "unassigned"]);
    expect(TicketSeg.safeParse("mine").success).toBe(false);
    expect(TicketAssigneeFilter.safeParse("everyone").success).toBe(false);
  });

  it("row schemas accept a D1 row and reject a wrong-shaped one", () => {
    const row = {
      id: 1, title: "t", body: "b", category: "bug", priority: "high", status: "in_progress",
      requester: "meilin", parent_id: null, sprint_id: null,
      created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-02T00:00:00Z",
      source: "canopy", source_ref: null, source_author: null, source_updated_at: null, board_rank: null,
    };
    expect(TicketRow.parse(row)).toEqual(row);
    expect(TicketRow.safeParse({ ...row, source: "jira" }).success).toBe(false);
    expect(TicketRow.safeParse({ ...row, status: "closed" }).success).toBe(false);
    expect(TicketRow.safeParse({ ...row, parent_id: undefined }).success).toBe(false);

    // The opening history row: from_status NULL, to_status submitted.
    const opening = { id: 1, ticket_id: 1, actor: "meilin", from_status: null, to_status: "submitted", created_at: "2026-09-01T00:00:00Z" };
    expect(TicketEventRow.parse(opening)).toEqual(opening);
    expect(TicketEventRow.safeParse({ ...opening, to_status: null }).success).toBe(false);
  });
});

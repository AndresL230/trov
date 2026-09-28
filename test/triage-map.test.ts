/**
 * Mapping-layer tests — backend read shapes → the props the presentational
 * triage components expect (web/src/triage-map.ts). Pure functions, no DOM.
 */
import { describe, it, expect } from "vitest";
import {
  proposalReviewItem, adrReviewItem, reviewItemsFromReads, decodeReviewId, diffEntries,
  unplacedFromRow, identityFromTask, peopleFromPersons, ASSIGN_OPTIONS,
} from "../web/src/triage-map";
import type { StagedProposal, AdrRow, IdentityTask, PersonSummary } from "../web/src/api";
import type { NeedsTriageRow } from "@shared/rows";

function makeProposal(overrides: Partial<StagedProposal> = {}): StagedProposal {
  return {
    slug: "deploy-runbook", version: 7, title: "Deployment Runbook",
    section: "reference", space: "technical", summary: "Rollback rewritten.",
    author: "octo-agent", confidence: "high", status: "staged",
    change_kind: "edit", low_confidence: 0, base_version: 6, current_version: 6,
    created_at: "2026-07-01T10:00:00Z",
    stagedBody: "line one\nline two", promotedBody: "line one\nold line two",
    ...overrides,
  };
}

function makeAdr(overrides: Partial<AdrRow> = {}): AdrRow {
  return {
    id: 14, title: "Adopt outbox pattern",
    context: "Events diverge silently.",
    decision: "Write events to an outbox table. A relay publishes them.",
    rationale: "One hop of latency is acceptable.",
    status: "draft", confidence: "high",
    created_at: "2026-07-02T10:00:00Z", created_by: "octo-agent", content_hash: null,
    ...overrides,
  };
}

describe("proposalReviewItem", () => {
  it("synthesizes the doc id and decodeReviewId round-trips it", () => {
    const item = proposalReviewItem(makeProposal());
    expect(item.id).toBe("doc:deploy-runbook@7");
    expect(decodeReviewId(item.id)).toEqual({ kind: "doc", slug: "deploy-runbook", version: 7 });
  });

  it("derives the eyebrow from real space/section and fixes kind/badge", () => {
    const item = proposalReviewItem(makeProposal());
    expect(item.kind).toBe("proposal");
    expect(item.eyebrow).toBe("PROPOSAL · TECHNICAL / REFERENCE");
    expect(item.badge).toBe("STAGED");
    expect(item.liveVersion).toBe("LIVE (v6)");
  });

  it("derives agent fields from the author (no session id) and time from created_at", () => {
    const item = proposalReviewItem(makeProposal());
    expect(item.agent).toBe("octo-agent");
    expect(item.agentInitials).toBe("OC");
    expect(item.agent).not.toContain("session");
  });

  it("marks stale only when base_version < current_version, with a note naming both", () => {
    const stale = proposalReviewItem(makeProposal({ base_version: 5, current_version: 6 }));
    expect(stale.stale).toBe(true);
    expect(stale.staleNote).toContain("v5");
    expect(stale.staleNote).toContain("v6");
    expect(proposalReviewItem(makeProposal({ base_version: 6, current_version: 6 })).stale).toBe(false);
    expect(proposalReviewItem(makeProposal({ base_version: null })).stale).toBe(false);
  });

  it("falls back to a staged-body excerpt when summary is null", () => {
    const item = proposalReviewItem(makeProposal({ summary: null, stagedBody: "\n\nFirst real line.\nmore" }));
    expect(item.summary).toBe("First real line.");
  });

  it("flags low_confidence proposals", () => {
    expect(proposalReviewItem(makeProposal({ low_confidence: 1 })).flagged).toBe(true);
    expect(proposalReviewItem(makeProposal()).flagged).toBe(false);
  });

  it("computes the diff from the two raw bodies", () => {
    const item = proposalReviewItem(makeProposal());
    expect(item.diff!.some((e) => e.t === "del" && e.s === "old line two")).toBe(true);
    expect(item.diff!.some((e) => e.t === "add" && e.s === "line two")).toBe(true);
  });
});

describe("diffEntries — real-size bodies", () => {
  it("collapses a multi-hundred-line body to hunks + ellipsis rows", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i}`);
    const oldBody = lines.join("\n");
    const newLines = [...lines];
    newLines[50] = "changed A";
    newLines[200] = "changed B";
    const rows = diffEntries(oldBody, newLines.join("\n"));
    expect(rows.length).toBeLessThan(50);
    const ellipses = rows.filter((r) => r.t === "ellipsis");
    expect(ellipses.length).toBeGreaterThanOrEqual(2);
    expect(ellipses[0].s).toMatch(/\d+ unchanged lines/);
  });
});

describe("adrReviewItem", () => {
  it("synthesizes the adr id and decodeReviewId round-trips it", () => {
    const item = adrReviewItem(makeAdr());
    expect(item.id).toBe("adr:14");
    expect(decodeReviewId(item.id)).toEqual({ kind: "adr", id: 14 });
  });

  it("formats the eyebrow from the numeric id and fixes kind/badge", () => {
    const item = adrReviewItem(makeAdr());
    expect(item.kind).toBe("decision");
    expect(item.eyebrow).toBe("DECISION · ADR-014");
    expect(item.badge).toBe("DRAFT");
  });

  it("builds Context / Decision / Rationale sections, skipping nulls", () => {
    const item = adrReviewItem(makeAdr());
    expect(item.adr!.map((s) => s.h)).toEqual(["Context", "Decision", "Rationale"]);
    const noRationale = adrReviewItem(makeAdr({ rationale: null }));
    expect(noRationale.adr!.map((s) => s.h)).toEqual(["Context", "Decision"]);
  });

  it("derives the card summary from the first sentence of decision", () => {
    expect(adrReviewItem(makeAdr()).summary).toBe("Write events to an outbox table.");
    expect(adrReviewItem(makeAdr({ decision: null })).summary).toBe("");
  });
});

describe("reviewItemsFromReads", () => {
  it("merges the two reads newest-first by created_at", () => {
    const items = reviewItemsFromReads(
      [makeProposal({ created_at: "2026-07-01T10:00:00Z" })],
      [makeAdr({ created_at: "2026-07-02T10:00:00Z" })],
    );
    expect(items.map((i) => i.id)).toEqual(["adr:14", "doc:deploy-runbook@7"]);
  });
});

describe("decodeReviewId — invalid inputs", () => {
  it("returns null for unknown prefixes and malformed ids", () => {
    expect(decodeReviewId("p1")).toBeNull();
    expect(decodeReviewId("doc:no-version")).toBeNull();
    expect(decodeReviewId("doc:slug@abc")).toBeNull();
    expect(decodeReviewId("doc:slug@")).toBeNull();
    expect(decodeReviewId("adr:abc")).toBeNull();
  });
});

function makeTriageRow(overrides: Partial<NeedsTriageRow> = {}): NeedsTriageRow {
  return {
    id: 7,
    raw: JSON.stringify({ slug: "pool-sizing", title: "Notes on connection pool sizing", body: "Pool exhaustion under load traces to the reporting service.", section: "runbooks" }),
    reason: "out-of-vocab section: runbooks",
    source_author: "octo-agent",
    resolved: 0, created_at: "2026-07-03T10:00:00Z",
    resolved_at: null, resolved_by: null, resolution: null, assigned_ref: null,
    ...overrides,
  };
}

describe("unplacedFromRow", () => {
  it("derives title and snippet from JSON raw and keeps the verbatim reason in the note", () => {
    const u = unplacedFromRow(makeTriageRow());
    expect(u.id).toBe("7");
    expect(u.title).toBe("Notes on connection pool sizing");
    expect(u.snippet).toContain("Pool exhaustion");
    expect(u.reason).toBe("AGENT FLAGGED");
    expect(u.reasonNote).toBe("out-of-vocab section: runbooks");
  });

  it("buckets low-confidence gate reasons into the LOW CONFIDENCE chip", () => {
    const u = unplacedFromRow(makeTriageRow({ reason: "low confidence doc proposal" }));
    expect(u.reason).toBe("LOW CONFIDENCE");
    expect(u.reasonNote).toBe("low confidence doc proposal");
  });

  it("falls back to the raw string itself for free-form items", () => {
    const u = unplacedFromRow(makeTriageRow({ raw: "remember to cap per-service pools" }));
    expect(u.title).toBe("remember to cap per-service pools");
    expect(u.snippet).toBe("remember to cap per-service pools");
  });

  it("builds meta from source_author + relative time, with an unknown fallback", () => {
    expect(unplacedFromRow(makeTriageRow()).meta).toContain("octo-agent");
    expect(unplacedFromRow(makeTriageRow({ source_author: null })).meta).toContain("unknown");
  });
});

function makeIdentityTask(overrides: Partial<IdentityTask> = {}): IdentityTask {
  return {
    login: "mk-dev2", first_seen: "2026-06-15T10:00:00Z",
    status: "pending", resolved_at: null, resolved_by: null,
    sample: [
      { semantic_key: "gh:pr:412:merged", event_type: "pr_merged", ref_number: 412, title: "Fix pagination", occurred_at: "2026-07-01T10:00:00Z" },
      { semantic_key: "gh:issue:398", event_type: "issue", ref_number: 398, title: null, occurred_at: null },
    ],
    ...overrides,
  };
}

describe("identityFromTask", () => {
  it("keys the group by login and uses the no-count copy", () => {
    const g = identityFromTask(makeIdentityTask());
    expect(g.id).toBe("mk-dev2");
    expect(g.login).toBe("mk-dev2");
    expect(g.countLabel).toBe("recent activity");
    expect(g.meta).toContain("first seen");
  });

  it("maps event kinds (pr_* → PR, issue → ISSUE) and composes #ref + title with a null fallback", () => {
    const g = identityFromTask(makeIdentityTask());
    expect(g.sample[0]).toMatchObject({ kind: "PR", text: "#412 Fix pagination" });
    expect(g.sample[1]).toMatchObject({ kind: "ISSUE", text: "#398 (no title)" });
  });
});

describe("ASSIGN_OPTIONS", () => {
  it("offers the three gate kinds and only real assignable sections", () => {
    // The roadmap kind went with the retired proposal queue: nothing agent-proposed
    // can become a sprint any more — sprints are authored writes only.
    expect(ASSIGN_OPTIONS.kinds.map((k) => k.key)).toEqual(["doc", "adr", "feed"]);
    expect(ASSIGN_OPTIONS.sections).toEqual(["reference", "context", "decisions"]); // never needs-triage
    expect(ASSIGN_OPTIONS.spaces).toEqual(["technical", "product"]);
    expect(ASSIGN_OPTIONS.tags).toContain("auth");
  });
});

describe("peopleFromPersons", () => {
  it("maps a directory row to a picker entry keyed by handle", () => {
    const directory: PersonSummary[] = [{ handle: "maya-k", name: "Maya Kim", color: "sky", avatar_url: null, role: null }];
    expect(peopleFromPersons(directory)).toEqual([{ id: "maya-k", name: "Maya Kim", initials: "MK", color: "sky", avatar_url: null }]);
  });
});

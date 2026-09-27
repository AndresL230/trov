/**
 * Phase 5a — the SPA's hash router (`web/src/hash.ts`).
 *
 * `parseHash` / `hashForRoute` are pure (no `location`, no DOM), which is the
 * whole reason they live in their own module: main.ts is the only place that
 * touches the real URL, and the ROUTING RULE is unit-tested here.
 *
 * Runs in the same Vitest pool-workers harness as everything else; nothing here
 * needs D1.
 */
import { describe, it, expect } from "vitest";
import { parseHash, hashForRoute } from "../web/src/hash";

describe("parseHash", () => {
  it("parses the four ticket/sprint routes (§C.11)", () => {
    expect(parseHash("#tickets")).toEqual({ screen: "tickets", ticketId: null, sprintId: null });
    expect(parseHash("#tickets/new")).toEqual({ screen: "newticket", ticketId: null, sprintId: null });
    expect(parseHash("#tickets/42")).toEqual({ screen: "ticketdetail", ticketId: 42, sprintId: null });
    expect(parseHash("#sprints/7")).toEqual({ screen: "sprint", ticketId: null, sprintId: 7 });
  });

  it("accepts a hash with or without the leading #", () => {
    expect(parseHash("tickets/42")).toEqual({ screen: "ticketdetail", ticketId: 42, sprintId: null });
  });

  it("still parses every pre-existing plain screen", () => {
    for (const s of ["mywork", "feed", "docs", "review", "search", "settings", "guide", "unsubscribe", "handoffs", "prompts"]) {
      expect(parseHash(`#${s}`)).toEqual({ screen: s, ticketId: null, sprintId: null });
    }
    // Maintenance now names its sub-page (Unplaced is the bare hash).
    expect(parseHash("#roadmap")).toEqual({ screen: "roadmap", ticketId: null, sprintId: null, roadmapTab: "narrative" });
    expect(parseHash("#maintenance")).toEqual({ screen: "maintenance", ticketId: null, sprintId: null, maintTab: "unplaced" });
  });

  it("keeps the Roadmap tab in the hash, so a reload stays on it", () => {
    const base = { screen: "roadmap" as const, ticketId: null, sprintId: null };
    expect(parseHash("#roadmap/timeline")).toEqual({ ...base, roadmapTab: "timeline" });
    expect(parseHash("#roadmap/narrative")).toEqual({ ...base, roadmapTab: "narrative" });
    expect(parseHash("#roadmap/gantt").screen).toBe("mywork");
    expect(hashForRoute({ ...base, roadmapTab: "timeline" })).toBe("#roadmap/timeline");
    expect(hashForRoute({ ...base, roadmapTab: "narrative" })).toBe("#roadmap");
    expect(hashForRoute(base)).toBe("#roadmap");
    for (const tab of ["narrative", "timeline"] as const) expect(parseHash(hashForRoute({ ...base, roadmapTab: tab }))).toEqual({ ...base, roadmapTab: tab });
  });

  it("parses the handoff, prompt, new-doc and maintenance sub-routes, and round-trips them", () => {
    const base = { ticketId: null, sprintId: null };
    const cases: [string, object][] = [
      ["#handoffs/new", { screen: "newhandoff", ...base }],
      ["#handoffs/12", { screen: "handoff", ...base, handoffId: 12 }],
      ["#prompts/new", { screen: "promptedit", ...base, promptMode: "new" }],
      ["#prompts/adr-draft", { screen: "prompt", ...base, promptSlug: "adr-draft" }],
      ["#prompts/adr-draft/edit", { screen: "promptedit", ...base, promptSlug: "adr-draft", promptMode: "edit" }],
      ["#prompts/adr-draft/version", { screen: "promptedit", ...base, promptSlug: "adr-draft", promptMode: "version" }],
      ["#docs/new", { screen: "newdoc", ...base }],
      ["#maintenance/identity", { screen: "maintenance", ...base, maintTab: "identity" }],
      ["#maintenance/people", { screen: "maintenance", ...base, maintTab: "people" }],
    ];
    for (const [hash, route] of cases) {
      expect(parseHash(hash), hash).toEqual(route);
      expect(hashForRoute(parseHash(hash)), hash).toBe(hash);
    }
    const none = { screen: "mywork", ticketId: null, sprintId: null };
    expect(parseHash("#prompts/adr-draft/delete")).toEqual(none);
    expect(parseHash("#maintenance/nope")).toEqual(none);
    expect(parseHash("#handoffs/%E0%A4%A")).toEqual(none); // malformed escape
    expect(parseHash("#handoffs/h_8d05")).toEqual(none);    // ids are numbers
    expect(parseHash("#handoffs/0")).toEqual(none);
  });

  it("falls back to My Work for junk, empty, and malformed ids", () => {
    const none = { screen: "mywork", ticketId: null, sprintId: null };
    expect(parseHash("")).toEqual(none);
    expect(parseHash("#")).toEqual(none);
    expect(parseHash("#nope")).toEqual(none);
    expect(parseHash("#tickets/abc")).toEqual(none);        // not an id, not "new"
    expect(parseHash("#tickets/1/2")).toEqual(none);        // too deep
    expect(parseHash("#tickets/0")).toEqual(none);          // ids are positive
    expect(parseHash("#tickets/-3")).toEqual(none);
    expect(parseHash("#sprints")).toEqual(none);            // a sprint route needs an id
    expect(parseHash("#sprints/x")).toEqual(none);
    expect(parseHash("#onboard")).toEqual(none);            // handled by boot, never a Screen
  });

  it("does not treat a numeric-looking id with junk as an id", () => {
    expect(parseHash("#tickets/42x")).toEqual({ screen: "mywork", ticketId: null, sprintId: null });
  });
});

describe("hashForRoute", () => {
  it("writes back exactly the forms parseHash reads", () => {
    expect(hashForRoute({ screen: "tickets", ticketId: null, sprintId: null })).toBe("#tickets");
    expect(hashForRoute({ screen: "newticket", ticketId: null, sprintId: null })).toBe("#tickets/new");
    expect(hashForRoute({ screen: "ticketdetail", ticketId: 42, sprintId: null })).toBe("#tickets/42");
    expect(hashForRoute({ screen: "sprint", ticketId: null, sprintId: 7 })).toBe("#sprints/7");
    expect(hashForRoute({ screen: "feed", ticketId: null, sprintId: null })).toBe("#feed");
  });

  it("round-trips every route through parseHash", () => {
    const routes = [
      { screen: "tickets", ticketId: null, sprintId: null },
      { screen: "newticket", ticketId: null, sprintId: null },
      { screen: "ticketdetail", ticketId: 9, sprintId: null },
      { screen: "sprint", ticketId: null, sprintId: 3 },
      { screen: "mywork", ticketId: null, sprintId: null },
      { screen: "settings", ticketId: null, sprintId: null },
      { screen: "site", ticketId: null, sprintId: null }, // the landing page, reopened from the sidebar logo
      { screen: "repo", ticketId: null, sprintId: null, repoTab: "overview" },
      { screen: "repo", ticketId: null, sprintId: null, repoTab: "ci" },
    ] as const;
    for (const r of routes) expect(parseHash(hashForRoute(r))).toEqual(r);
  });

  it("routes the Repo dashboard's tabs, with the bare #repo as Overview", () => {
    expect(parseHash("#repo")).toEqual({ screen: "repo", ticketId: null, sprintId: null, repoTab: "overview" });
    expect(parseHash("#repo/planning")).toEqual({ screen: "repo", ticketId: null, sprintId: null, repoTab: "planning" });
    expect(parseHash("#repo/overview").repoTab).toBe("overview");
    expect(hashForRoute({ screen: "repo", ticketId: null, sprintId: null, repoTab: "overview" })).toBe("#repo");
    expect(hashForRoute({ screen: "repo", ticketId: null, sprintId: null, repoTab: "usage" })).toBe("#repo/usage");
    // An unknown tab is a junk hash like any other.
    expect(parseHash("#repo/nope").screen).toBe("mywork");
    expect(parseHash("#repo/ci/extra").screen).toBe("mywork");
  });

  it("routes the Artifacts library, form, viewer, a version and a diff — and round-trips each", () => {
    const base = { ticketId: null, sprintId: null };
    expect(parseHash("#artifacts")).toEqual({ screen: "artifacts", ...base });
    expect(parseHash("#artifacts/new")).toEqual({ screen: "artifactnew", ...base });
    expect(parseHash("#artifacts/auth-audit")).toEqual({ screen: "artifact", ...base, art: { slug: "auth-audit", v: null, diff: null } });
    expect(parseHash("#artifacts/auth-audit/v2")).toEqual({ screen: "artifact", ...base, art: { slug: "auth-audit", v: 2, diff: null } });
    expect(parseHash("#artifacts/auth-audit/diff/1..3")).toEqual({ screen: "artifact", ...base, art: { slug: "auth-audit", v: null, diff: { a: 1, b: 3 } } });
    for (const h of ["#artifacts", "#artifacts/new", "#artifacts/auth-audit", "#artifacts/auth-audit/v2", "#artifacts/auth-audit/diff/1..3"]) {
      expect(hashForRoute(parseHash(h)), h).toBe(h);
    }
    for (const junk of ["#artifacts/Bad_Slug", "#artifacts/x/v0", "#artifacts/x/vx", "#artifacts/x/diff/1", "#artifacts/x/diff/a..b", "#artifacts/x/y/z/w"]) {
      expect(parseHash(junk).screen, junk).toBe("mywork");
    }
    expect(hashForRoute({ screen: "artifact", ...base })).toBe("#artifacts");
    // The raw route's `slug@v<n>` spelling is accepted; `/v<n>` is what gets written back.
    expect(parseHash("#artifacts/auth-audit@v2")).toEqual({ screen: "artifact", ...base, art: { slug: "auth-audit", v: 2, diff: null } });
    expect(hashForRoute(parseHash("#artifacts/auth-audit@v2"))).toBe("#artifacts/auth-audit/v2");
    for (const junk of ["#artifacts/auth-audit@v0", "#artifacts/auth-audit@2", "#artifacts/new@v1", "#artifacts/x@v2/diff/1..2"]) {
      expect(parseHash(junk).screen, junk).toBe("mywork");
    }
  });

  it("degrades to the parent screen when the id is missing", () => {
    expect(hashForRoute({ screen: "ticketdetail", ticketId: null, sprintId: null })).toBe("#tickets");
    expect(hashForRoute({ screen: "sprint", ticketId: null, sprintId: null })).toBe("#roadmap");
  });
});

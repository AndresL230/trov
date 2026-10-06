/**
 * The sidebar (web/src/sidebar.ts) — ported from the Claude Design
 * `Canopy Repo Dashboard.dc.html`.
 *
 * The rule under test: the structure is STABLE. The <aside> is patched in place
 * across rerenders (web/src/morph.ts) so that its transitions can run, which only
 * works if collapsing the rail, opening a sub-page list or changing screens alters
 * ATTRIBUTES and never the element tree.
 */
import { describe, it, expect } from "vitest";
import { sidebarView, navGroupOf, navKeyOf, NAV_CLOSED, type SidebarProps } from "../web/src/sidebar";
import { render, initialState } from "../web/src/render";

function props(over: Partial<SidebarProps> = {}): SidebarProps {
  return {
    screen: "mywork", collapsed: false, navOpen: { ...NAV_CLOSED },
    qView: "table", roadmapTab: "timeline", docSpace: "technical",
    docSpaces: [{ key: "technical", label: "Technical" }, { key: "product", label: "Product" }],
    counts: { review: 0, maintenance: 0, tickets: 0, handoffs: 0, prompts: 0 },
    me: { handle: "jose-a", name: "Jose Alvarez", color: "moss" }, displayName: "Jose Alvarez", logo: "<svg></svg>",
    ...over,
  };
}

/** The element skeleton: every tag in order, with text and attribute values dropped. */
const skeleton = (html: string): string => (html.match(/<\/?[a-z][a-z0-9]*/gi) ?? []).join(" ");

describe("sidebar — structure is stable across every state", () => {
  it("emits the same element tree collapsed, expanded, open, closed and on any screen", () => {
    const base = skeleton(sidebarView(props()));
    const variants: Partial<SidebarProps>[] = [
      { collapsed: true },
      { navOpen: { docs: true } },
      { screen: "repo" },
      { screen: "docs", docSpace: "product" },
      { screen: "ticketdetail" },
      { counts: { review: 3, maintenance: 2, tickets: 9, handoffs: 2, prompts: 1 } },
      { screen: "settings" },
      { screen: "handoff" },
      { screen: "maintenance" },
      { screen: "releases" },
    ];
    for (const v of variants) expect(skeleton(sidebarView(props(v))), JSON.stringify(v)).toBe(base);
  });

  it("keeps the person chip's tree when nobody is loaded yet", () => {
    // personChip draws initials either way, so a late /auth/me patches rather than rebuilds.
    expect(skeleton(sidebarView(props({ me: null, displayName: "" })))).toBe(skeleton(sidebarView(props())));
  });
});

describe("sidebar — groups and order (the design's five sections)", () => {
  it("orders Workspace · Monitor · Knowledge · Triage · Help, with Repo in Monitor", () => {
    const html = sidebarView(props());
    const at = (needle: string) => html.indexOf(needle);
    const order = [">Workspace<", "goMyWork", "goTickets", "goRoadmap", "goHandoffs", ">Monitor<", "goRepo", "goFeed", ">Knowledge<", "goDocs", "goArtifacts", "goPrompts", ">Triage<", "goReview", "goMaintenance", ">Help<", "goGuide", "goReleases"];
    for (let i = 1; i < order.length; i++) expect(at(order[i]), order[i]).toBeGreaterThan(at(order[i - 1]));
  });

  it("offers only sub-pages that go somewhere", () => {
    const html = sidebarView(props());
    for (const arg of ["docs:technical", "docs:product"]) {
      expect(html).toContain(`data-act="navSub" data-arg="${arg}"`);
    }
    expect((html.match(/data-act="navSub"/g) ?? []).length).toBe(2);
    // Roadmap, Tickets, Maintenance and Repo have no sub-pages in the rail (their switches
    // are on the screen itself) — and no chevron.
    for (const g of ["roadmap", "tickets", "maintenance", "repo"]) {
      expect(html).not.toContain(`data-arg="${g}:`);
      expect(html).not.toContain(`data-act="navToggle" data-arg="${g}"`);
    }
  });

  it("Maintenance is a plain row with its count badge — no chevron, no sub-page list", () => {
    const html = sidebarView(props({ screen: "maintenance", counts: { review: 0, maintenance: 4, tickets: 0, handoffs: 0, prompts: 0 } }));
    const row = html.slice(html.indexOf('class="cnpy-navrow n-maintenance'), html.indexOf(">Help<"));
    expect(row).toContain('class="cnpy-navrow n-maintenance is-active"');
    expect(row).toContain('<span class="cnpy-lbl cnpy-badge" data-n="4">4</span>');
    expect(row).not.toContain("cnpy-chev");
    expect(row).not.toContain("cnpy-sub");
    // Only Docs still owns a sub-page list.
    expect((html.match(/class="cnpy-sub" /g) ?? []).length).toBe(1);
  });

  it("Repo is a plain row — its five tabs head the page body, not the rail", () => {
    const html = sidebarView(props({ screen: "repo" }));
    const row = html.slice(html.indexOf('class="cnpy-navrow n-repo'), html.indexOf('class="cnpy-navrow n-feed'));
    expect(row).toContain('class="cnpy-navrow n-repo is-active"');
    expect(row).toContain('<button data-act="goRepo" class="cnpy-nav-i" aria-label="Repo" aria-current="page">');
    expect(row).not.toContain("cnpy-chev");
    expect(row).not.toContain("cnpy-sub");
    for (const tab of ["Overview", "Code", "Usage"]) expect(html).not.toContain(`>${tab}</button>`);
  });

  it("has no Search nav row — search is the box at the top of the rail", () => {
    const html = sidebarView(props());
    expect(html).not.toContain('data-act="goSearch"');
    expect(html).toContain('data-field="sideSearch"');
    expect(html).toContain('placeholder="Search Trov"');
  });
});

describe("sidebar — active state", () => {
  it("lights the owning entry for child screens", () => {
    expect(navKeyOf("ticketdetail")).toBe("tickets");
    expect(navKeyOf("sprint")).toBe("roadmap");
    expect(navKeyOf("settings")).toBeNull();
    expect(navKeyOf("artifact")).toBe("artifacts");
    expect(navKeyOf("artifactnew")).toBe("artifacts");
    expect(navKeyOf("handoff")).toBe("handoffs");
    expect(navKeyOf("promptedit")).toBe("prompts");
    expect(navKeyOf("newdoc")).toBe("docs");
    expect(navKeyOf("releases")).toBe("releases");
    expect(sidebarView(props({ screen: "sprint" }))).toContain('class="cnpy-navrow n-roadmap is-active"');
  });

  it("marks the sub-page in view, and none on a child screen", () => {
    const docs = sidebarView(props({ screen: "docs", docSpace: "product" }));
    expect(docs).toContain('data-arg="docs:product" class="cnpy-sub-i is-active" aria-current="page"');
    expect(docs).not.toContain('data-arg="docs:technical" class="cnpy-sub-i is-active"');
    // Tickets, Maintenance and Repo have no rail sub-pages, so none of their screens lights one up.
    for (const screen of ["tickets", "ticketdetail", "newticket", "maintenance", "repo"]) {
      expect(sidebarView(props({ screen }))).not.toContain("cnpy-sub-i is-active");
    }

    // Roadmap has no rail sub-pages, so its tab never lights one up.
    expect(sidebarView(props({ screen: "roadmap", roadmapTab: "timeline" }))).not.toContain("cnpy-sub-i is-active");
  });

  it("navGroupOf names the group a screen's pages belong to", () => {
    expect(navGroupOf("newticket")).toBeNull();
    expect(navGroupOf("docs")).toBe("docs");
    expect(navGroupOf("newdoc")).toBe("docs");
    expect(navGroupOf("repo")).toBeNull();
    expect(navGroupOf("maintenance")).toBeNull();
    expect(navGroupOf("feed")).toBeNull();
  });
});

describe("sidebar — open/closed and collapsed are attributes", () => {
  it("opens a sub-page list with data-open and keeps closed pages out of the tab order", () => {
    const closed = sidebarView(props());
    expect(closed).toContain('<div class="cnpy-sub" data-open="0">');
    expect(closed).toContain('data-arg="docs:product" class="cnpy-sub-i" tabindex="-1"');

    const open = sidebarView(props({ navOpen: { ...NAV_CLOSED, docs: true } }));
    expect(open).toContain('data-arg="docs:product" class="cnpy-sub-i" tabindex="0"');
    expect(open).toContain('data-act="navToggle" data-arg="docs" class="cnpy-chev" aria-label="Hide Docs pages" aria-expanded="true"');
  });

  it("collapsed: pages and chevrons leave the tab order; every row still names itself", () => {
    const html = sidebarView(props({ collapsed: true, navOpen: { ...NAV_CLOSED, docs: true } }));
    expect(html).toContain('data-arg="docs:product" class="cnpy-sub-i" tabindex="-1"');
    expect(html).toContain('aria-label="Expand sidebar" aria-expanded="false"');
    for (const tip of ["My Work", "Tickets", "Roadmap", "Handoffs", "Repo", "Feed", "Docs", "Artifacts", "Prompt Library", "Review", "Maintenance", "Get Started", "What&#39;s new", "Search", "Settings"]) {
      expect(html).toContain(`data-tip="${tip}"`);
    }
  });

  it("a narrow viewport renders the rail collapsed without touching the preference", () => {
    const s = { ...initialState(), view: "app" as const, narrow: true, collapsed: false };
    const html = render(s);
    expect(html).toContain('data-collapsed="1"');
    expect(html).toContain('data-narrow="1"');
  });

  it("the shell exposes the seam the DOM patcher looks for", () => {
    const html = render({ ...initialState(), view: "app" as const });
    expect(html).toContain('class="cnpy-shell"');
    expect(html).toContain('<div class="cnpy-tip" role="tooltip" data-keep></div>');
  });
});

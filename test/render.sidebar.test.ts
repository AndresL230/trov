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
    qView: "table", roadmapTab: "timeline", librarySpace: null,
    spaces: [{ key: "engineering", label: "Engineering", icon: "braces", color: "#525cc3" }, { key: "product", label: "Product", icon: "compass", color: "#2f7d57" }],
    spacesLoaded: true, canAdmin: false,
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
      { navOpen: { library: true } },
      { screen: "repo" },
      { screen: "space", librarySpace: "product" },
      { screen: "docs", librarySpace: "engineering" },
      { screen: "library" },
      // The spaces read answering, an admin's "+ New space": attributes on nodes that are always there.
      { spacesLoaded: false },
      { canAdmin: true },
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
    const order = [">Workspace<", "goMyWork", "goTickets", "goRoadmap", "goHandoffs", ">Monitor<", "goRepo", "goFeed", ">Knowledge<", "goLibrary", "goArtifacts", "goPrompts", ">Triage<", "goReview", "goMaintenance", ">Help<", "goGuide", "goReleases"];
    for (let i = 1; i < order.length; i++) expect(at(order[i]), order[i]).toBeGreaterThan(at(order[i - 1]));
  });

  it("offers only sub-pages that go somewhere: one row per live space, each with its tile", () => {
    const html = sidebarView(props());
    for (const arg of ["library:engineering", "library:product"]) {
      expect(html).toContain(`data-act="navSub" data-arg="${arg}"`);
    }
    expect((html.match(/data-act="navSub"/g) ?? []).length).toBe(2);
    expect((html.match(/class="cnpy-spt"/g) ?? []).length).toBe(2);
    expect(html).toContain('<span class="cnpy-sub-n">Engineering</span>');
    // Roadmap, Tickets, Unplaced (`maintenance`) and Repo have no sub-pages in the rail (their switches
    // are on the screen itself) — and no chevron.
    for (const g of ["roadmap", "tickets", "maintenance", "repo"]) {
      expect(html).not.toContain(`data-arg="${g}:`);
      expect(html).not.toContain(`data-act="navToggle" data-arg="${g}"`);
    }
  });

  it("Unplaced (the `maintenance` key) is a plain row with its count badge — no chevron, no sub-page list", () => {
    const html = sidebarView(props({ screen: "maintenance", counts: { review: 0, maintenance: 4, tickets: 0, handoffs: 0, prompts: 0 } }));
    const row = html.slice(html.indexOf('class="cnpy-navrow n-maintenance'), html.indexOf(">Help<"));
    expect(row).toContain('class="cnpy-navrow n-maintenance is-active"');
    expect(row).toContain('<span class="cnpy-lbl cnpy-badge" data-n="4">4</span>');
    expect(row).not.toContain("cnpy-chev");
    expect(row).not.toContain("cnpy-sub");
    // Only the Library still owns a sub-page list.
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
    expect(navKeyOf("newdoc")).toBe("library");
    expect(navKeyOf("docs")).toBe("library");
    expect(navKeyOf("space")).toBe("library");
    expect(navKeyOf("library")).toBe("library");
    expect(navKeyOf("releases")).toBe("releases");
    expect(sidebarView(props({ screen: "sprint" }))).toContain('class="cnpy-navrow n-roadmap is-active"');
  });

  it("marks the sub-page in view, and none on a child screen", () => {
    // A space's home, a doc in it and New page in it light the space; Library home lights none.
    for (const screen of ["space", "docs", "newdoc"]) {
      const html = sidebarView(props({ screen, librarySpace: "product" }));
      expect(html, screen).toContain('data-arg="library:product" class="cnpy-sub-i cnpy-sub-sp is-active" aria-current="page"');
      expect(html, screen).not.toContain('data-arg="library:engineering" class="cnpy-sub-i cnpy-sub-sp is-active"');
      expect(html, screen).toContain('class="cnpy-navrow n-library is-active"');
    }
    expect(sidebarView(props({ screen: "library", librarySpace: "product" }))).not.toContain("cnpy-sub-i cnpy-sub-sp is-active");
    // Tickets, Unplaced and Repo have no rail sub-pages, so none of their screens lights one up.
    for (const screen of ["tickets", "ticketdetail", "newticket", "maintenance", "repo"]) {
      expect(sidebarView(props({ screen }))).not.toContain("cnpy-sub-i is-active");
    }

    // Roadmap has no rail sub-pages, so its tab never lights one up.
    expect(sidebarView(props({ screen: "roadmap", roadmapTab: "timeline" }))).not.toContain("cnpy-sub-i is-active");
  });

  it("navGroupOf names the group a screen's pages belong to", () => {
    expect(navGroupOf("newticket")).toBeNull();
    expect(navGroupOf("docs")).toBe("library");
    expect(navGroupOf("newdoc")).toBe("library");
    expect(navGroupOf("space")).toBe("library");
    expect(navGroupOf("repo")).toBeNull();
    expect(navGroupOf("maintenance")).toBeNull();
    expect(navGroupOf("feed")).toBeNull();
  });
});

describe("sidebar — open/closed and collapsed are attributes", () => {
  it("opens a sub-page list with data-open and keeps closed pages out of the tab order", () => {
    const closed = sidebarView(props());
    expect(closed).toContain('<div class="cnpy-sub" data-open="0">');
    expect(closed).toContain('data-arg="library:product" class="cnpy-sub-i cnpy-sub-sp" tabindex="-1"');

    const open = sidebarView(props({ navOpen: { ...NAV_CLOSED, library: true } }));
    expect(open).toContain('data-arg="library:product" class="cnpy-sub-i cnpy-sub-sp" tabindex="0"');
    expect(open).toContain('data-act="navToggle" data-arg="library" class="cnpy-chev" aria-label="Hide spaces" aria-expanded="true"');
    // The label is its own button: it goes to Library home; the chevron only folds the group.
    expect(open).toContain('<button data-act="goLibrary" class="cnpy-nav-i" aria-label="Library">');
  });

  it("collapsed: pages and chevrons leave the tab order; every row still names itself", () => {
    const html = sidebarView(props({ collapsed: true, navOpen: { ...NAV_CLOSED, library: true } }));
    expect(html).toContain('data-arg="library:product" class="cnpy-sub-i cnpy-sub-sp" tabindex="-1"');
    expect(html).toContain('aria-label="Expand sidebar" aria-expanded="false"');
    for (const tip of ["My Work", "Tickets", "Roadmap", "Handoffs", "Repo", "Feed", "Library", "Artifacts", "Prompt Library", "Review", "Unplaced", "Guide", "What&#39;s new", "Search", "Settings"]) {
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

describe("sidebar — the Library group", () => {
  it("with no spaces (the read answered with none): \"No spaces yet\" and one hollow row, no space rows", () => {
    const html = sidebarView(props({ spaces: [] }));
    expect(html).toContain('<div class="cnpy-sub-none">No spaces yet<div class="cnpy-sub-ghost" aria-hidden="true"><span></span><span></span></div></div>');
    expect(html).not.toContain('data-act="navSub"');
    // While the read is out the same node is there, hidden: "No spaces yet" is never said before it is known.
    expect(sidebarView(props({ spaces: [], spacesLoaded: false }))).toContain('<div class="cnpy-sub-none" hidden>');
    expect(sidebarView(props())).toContain('<div class="cnpy-sub-none" hidden>');
  });

  it("\"+ New space\" is an admin's: always emitted, hidden for a member", () => {
    const member = sidebarView(props());
    expect(member).toMatch(/<button data-act="libNew" class="cnpy-sub-i cnpy-sub-new" hidden /);
    const admin = sidebarView(props({ canAdmin: true }));
    expect(admin).toMatch(/<button data-act="libNew" class="cnpy-sub-i cnpy-sub-new" tabindex="-1">/);
    expect(admin).toContain("New space</button>");
  });

  it("render() feeds the group from the Library read, and the active space from the screen", () => {
    const space = { slug: "design", name: "Design", icon: "pen", color: "#a84a68", description: "", sort_rank: 1, created_at: "2026-10-01T00:00:00Z", created_by: "system", archived: false, archived_at: null, owners: [], pages: 0, waiting: 0 };
    const s = { ...initialState(), view: "app" as const, screen: "space" as const, spaceSlug: "design",
      library: { status: "ok" as const, data: { spaces: [space as never], archived: [], recent: [], waiting: 0, can_admin: false } } };
    const html = render(s);
    const aside = html.slice(html.indexOf("<aside"), html.indexOf("</aside>"));
    expect(aside).toContain('data-arg="library:design" class="cnpy-sub-i cnpy-sub-sp is-active" aria-current="page"');
    expect(aside).toContain('<div class="cnpy-sub-none" hidden>');
  });
});

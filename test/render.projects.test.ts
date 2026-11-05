/**
 * Projects — the list (`#projects`, web/src/projects.ts; docs/superpowers/specs/2026-11-05-projects.md › The screen),
 * drawn from shared/projects-fixtures.ts in every state the spec names for it:
 *   • with data: the header's New project, the title and line, the search bar with Sort (a `dropdown()`), the
 *     All · Mine · Shared with me switch (`segmented()`), the count line, Recent (three Library cards, only with no
 *     search and All), the rows (Project, Who can see it, Owner, Chats, Pinned, Updated, ⋯) and Archived · N;
 *   • search filters the LOADED list on the client; Mine and Shared with me narrow it; Sort by name;
 *   • empty (the empty layout, New project), Free at the cap (owner: Upgrade to Pro; member: "An owner can upgrade,
 *     or archive one"), loading (the skeleton), a failed read ("Couldn't load this." and Try again);
 *   • the route, the sidebar row lit, the page patched in place (`data-morph`).
 * Pure: HTML-string assertions over real render() passes.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../web/src/markdown", () => ({ renderMarkdown: (b: string) => b, renderMarkdownInline: (t: string) => t }));
import { render, initialState, type AppState } from "../web/src/render";
import { projectsListView, shownProjects, capText, atProjectCap, sortDropdown, PROJECTS_EMPTY, type ProjectsListProps } from "../web/src/projects";
import { parseHash, hashForRoute } from "../web/src/hash";
import { PROJECT_LIST, PROJECT_LIST_EMPTY, PROJECT_LIST_FREE_CAP, PROJECT_FIXTURE_PEOPLE, PROJECT_HOSTING } from "@shared/projects-fixtures";
import type { PersonSummary } from "@shared/people";
import { initialDropdownUi } from "../web/src/dropdown";
import { esc } from "../web/src/ui";

const PERSONS = PROJECT_FIXTURE_PEOPLE as unknown as PersonSummary[];
const ME = (role: "owner" | "admin" | "member") => ({ handle: "AndresL230", name: "Andres", avatar_url: null, color: "moss" as const, identities: [], orgs: [{ slug: "saplinglearn", name: "SaplingLearn", role, plan: "free" as const }], superadmin: false, pending_invites: 0 });

function app(over: Partial<AppState["projects"]> = {}, role: "owner" | "admin" | "member" = "owner"): AppState {
  const s = initialState();
  s.view = "app"; s.screen = "projects"; s.orgSlug = "saplinglearn";
  (s as { me: unknown }).me = ME(role);
  s.persons = { status: "ok", data: PERSONS } as AppState["persons"];
  s.projects = { ...s.projects, list: { status: "ok", data: PROJECT_LIST }, ...over };
  return s;
}
const props = (over: Partial<ProjectsListProps> = {}): ProjectsListProps => ({
  list: { status: "ok", data: PROJECT_LIST }, ui: { q: "", filter: "all", sort: "updated", archivedOpen: false, rowMenu: null, restoring: null },
  me: "AndresL230", persons: PERSONS, org: "SaplingLearn", role: "owner", plan: "Pro", dd: initialDropdownUi(), ...over,
});
const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("Projects — the route and the shell", () => {
  it("routes #projects and #project/<slug>, both ways", () => {
    expect(parseHash("#projects")).toMatchObject({ screen: "projects" });
    expect(parseHash("#project/hosting-providers")).toMatchObject({ screen: "project", projectSlug: "hosting-providers" });
    expect(parseHash("#project/Not A Slug")).toMatchObject({ screen: "home" });
    expect(hashForRoute({ screen: "project", ticketId: null, sprintId: null, projectSlug: "hosting-providers" })).toBe("#project/hosting-providers");
    expect(hashForRoute({ screen: "projects", ticketId: null, sprintId: null })).toBe("#projects");
  });

  it("lights the sidebar's Projects row, puts New project in the header and patches the page in place", () => {
    const html = render(app());
    expect(html).toMatch(/class="cnpy-navrow n-projects is-active"/);
    expect(html).toContain('data-act="projNew"');
    expect(html).toContain('data-morph="projects"');
    expect(html).toMatch(/<h1[^>]*>Projects<\/h1>/);
  });
});

describe("Projects — the list with data", () => {
  const html = projectsListView(props());

  it("draws the title, the search bar with Sort as a dropdown, the switch and the count line", () => {
    expect(html).toContain("One place for a piece of work: its instructions, the tickets and docs it&#39;s about");
    expect(html).toContain('class="cnpy-sfbar pj-sfbar"');
    expect(html).toContain('data-act="projQ"');
    expect(html).toContain('id="pj-sort"');
    expect(html).toContain("Sort: Recently updated");
    expect(html).toContain('data-seg="pj-filter"');
    for (const w of [">All<", ">Mine<", ">Shared with me<"]) expect(html).toContain(w);
    expect(html).toContain("4 shown · 4 total");
    expect(html).not.toContain("<select");
  });

  it("shows Recent as three Library cards, and every live project as a row with its columns", () => {
    expect(count(html, "cnpy-lib-card")).toBe(3);
    expect(count(html, "data-project-row=")).toBe(4);
    for (const col of ["Project", "Who can see it", "Owner", "Chats", "Pinned", "Updated"]) expect(html).toContain(`>${col}<`);
    // Who can see it: N members, the org's name, Private.
    expect(html).toContain("3 members");
    expect(html).toContain(">SaplingLearn<");
    expect(html).toContain(">Private<");
    // The owner: "You" for the reader's own.
    expect(html).toMatch(/data-project-row="hosting-providers"[\s\S]*?>You</);
    // Each row opens its project through one hit area; its ⋯ is a control above it.
    expect(html).toContain('data-act="projOpen" data-arg="hosting-providers"');
    expect(html).toContain('data-act="projRowMenu" data-arg="hosting-providers"');
    // No pill: the visibility is a fact (plain words), never a bordered tag.
    expect(html).not.toMatch(/text-transform:uppercase/);
  });

  it("has Archived · N, opening to the archived rows with Restore", () => {
    expect(html).toContain("Archived · 1");
    expect(html).not.toContain('data-project-archived="streak-features"');
    const open = projectsListView(props({ ui: { ...props().ui, archivedOpen: true } }));
    expect(open).toContain('data-project-archived="streak-features"');
    expect(open).toMatch(/Archived Oct 12 by Luke · 3 chats · 5 pinned/);
    expect(open).toContain('data-act="projRestore" data-arg="streak-features"');
  });

  it("the row's ⋯ menu offers what the reader may do", () => {
    const menu = projectsListView(props({ ui: { ...props().ui, rowMenu: "teacher-dashboard-pilot" } }));
    expect(menu).toContain('class="cnpy-dp-menu pj-rowmenu"');
    expect(menu).toContain('data-act="projEdit" data-arg="teacher-dashboard-pilot"');
    expect(menu).toContain('data-act="projArchive" data-arg="teacher-dashboard-pilot"');
    // An editor who is not an org admin may not delete it.
    const asMember = projectsListView(props({ role: "member", ui: { ...props().ui, rowMenu: "teacher-dashboard-pilot" } }));
    expect(asMember).not.toContain('data-act="projDelete" data-arg="teacher-dashboard-pilot"');
    expect(menu).toContain('data-act="projDelete" data-arg="teacher-dashboard-pilot"');
  });
});

describe("Projects — search, the switch and Sort narrow the loaded list", () => {
  it("search matches the name and the description, hides Recent, and says when nothing matches", () => {
    const html = projectsListView(props({ ui: { ...props().ui, q: "railway" } }));
    expect(count(html, "data-project-row=")).toBe(1);
    expect(html).toContain("Matching projects");
    expect(html).toContain("1 shown · 4 total");
    expect(html).not.toContain("cnpy-lib-card");
    const none = projectsListView(props({ ui: { ...props().ui, q: "zzz" } }));
    expect(none).toContain("No projects match “zzz”.");
  });
  it("Mine is the reader's own; Shared with me is everyone else's", () => {
    const mine = shownProjects(PROJECT_LIST.projects, { q: "", filter: "mine", sort: "updated" }, "AndresL230");
    expect(mine.map((p) => p.slug)).toEqual(["hosting-providers", "exam-week-incident"]);
    const shared = shownProjects(PROJECT_LIST.projects, { q: "", filter: "shared", sort: "updated" }, "AndresL230");
    expect(shared.map((p) => p.slug)).toEqual(["teacher-dashboard-pilot", "gradebook-export-rework"]);
    expect(projectsListView(props({ ui: { ...props().ui, filter: "mine" } }))).toContain("Projects you own");
  });
  it("Sort: Name orders the rows by name; the dropdown carries both choices", () => {
    expect(shownProjects(PROJECT_LIST.projects, { q: "", filter: "all", sort: "name" }, "x").map((p) => p.name))
      .toEqual(["Exam week incident", "Gradebook export rework", "Hosting providers", "Teacher dashboard pilot"]);
    expect(sortDropdown("name").options.map((o) => o.label)).toEqual(["Recently updated", "Name"]);
  });
});

describe("Projects — the states", () => {
  it("empty: the screen's own shape drawn empty, with New project", () => {
    const html = projectsListView(props({ list: { status: "ok", data: { ...PROJECT_LIST_EMPTY, limit: { used: 0, cap: null } } } }));
    expect(html).toContain('data-empty="projects"');
    expect(html).toContain(esc(PROJECTS_EMPTY));
    expect(html).toContain('data-act="projNew"');
    expect(html).not.toContain("data-project-row=");
  });

  it("Free at the cap: the owner is offered Upgrade to Pro; a member is told an owner can upgrade, or archive one", () => {
    expect(atProjectCap(PROJECT_LIST_FREE_CAP.limit)).toBe(true);
    const owner = projectsListView(props({ list: { status: "ok", data: PROJECT_LIST_FREE_CAP }, plan: "Free" }));
    expect(owner).toContain(esc("You've used the 2 projects Free includes. Archive one, or upgrade to Pro for unlimited projects."));
    expect(owner).toContain('data-act="projUpgrade"');
    const member = projectsListView(props({ list: { status: "ok", data: PROJECT_LIST_FREE_CAP }, plan: "Free", role: "member" }));
    expect(member).toContain("An owner can upgrade, or archive one.");
    expect(member).not.toContain('data-act="projUpgrade"');
    expect(capText({ used: 2, cap: 2 }, false, "Free")).toBe("This organization has used the 2 projects Free includes. An owner can upgrade, or archive one.");
    // Not at the cap: no notice.
    expect(projectsListView(props())).not.toContain("pj-cap");
  });

  it("loading: a skeleton in the real frame, never the empty layout early", () => {
    const html = projectsListView(props({ list: { status: "loading", data: null } }));
    expect(html).toContain('data-skel="pj-cards"');
    expect(html).toContain('data-skel="pj-rows"');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("data-empty=");
  });

  it("a failed read says so in place, with Try again", () => {
    const html = projectsListView(props({ list: { status: "error", data: null } }));
    expect(html).toContain("Couldn&#39;t load this.");
    expect(html).toContain('data-act="projRetry"');
  });

  it("the state preview: ?preview=empty draws the empty layout, ?preview=loading the skeleton — never the real list", () => {
    const empty = render({ ...app(), preview: "empty" });
    expect(empty).toContain('data-empty="projects"');
    expect(empty).not.toContain("data-project-row=");
    const loading = render({ ...app(), preview: "loading" });
    expect(loading).toContain('data-skel="pj-rows"');
  });

  it("a card is the Library's card: the tile, the name, the line, the people, chats and pins, who can see it", () => {
    const html = projectsListView(props());
    expect(html).toMatch(/class="cnpy-spt" style="--spt-r:4\.8px;width:32px;height:32px;background:#525cc3"/);
    expect(html).toContain("4 chats · 9 pinned");
    expect(html).toContain(PROJECT_HOSTING.description);
  });
});

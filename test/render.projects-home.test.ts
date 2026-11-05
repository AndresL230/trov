/**
 * Projects — a project's home (`#project/<slug>`, web/src/projects.ts; docs/superpowers/specs/2026-11-05-projects.md ›
 * The screen), drawn from shared/projects-fixtures.ts in every state the spec names:
 *   • the owner's page: the tile, name, description, the avatar stack and the visibility line; Share and the ⋯ menu;
 *     Ask's composer at the FULL width of the column (its `.ask-co-in` max-width lifted under `.pj-home`); the
 *     Chats · Artifacts tab bar with counts; Instructions (Edit in place, the counter, Save / Cancel) and Knowledge
 *     (pins grouped by type with their live marks, remove, Add, "N of 200 pinned", Upload files);
 *   • a hidden pin ("An item you don't have access to"), an empty project (the empty layouts and their copy), a
 *     viewer (no Edit, no Add, no remove, no Share), an archived project (the line with Restore, no composer),
 *     loading (the skeleton), a failed read (Try again) and no such project.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../web/src/markdown", () => ({ renderMarkdown: (b: string) => b, renderMarkdownInline: (t: string) => t }));
import { render, initialState, type AppState } from "../web/src/render";
import {
  projectHomeView, groupPins, visiblePins, visLine, deleteProjectText, PROJECT_CHATS_EMPTY, PROJECT_PINS_EMPTY, PROJECT_HIDDEN_PIN,
  PROJECT_ARTS_EMPTY, type ProjectHomeProps,
} from "../web/src/projects";
import { emptyConvo } from "../web/src/ask-stream";
import { esc } from "../web/src/ui";
import { HOSTING_DETAIL, EMPTY_DETAIL, VIEWER_DETAIL, ARCHIVED_DETAIL, PROJECT_FIXTURE_PEOPLE, HOSTING_INSTRUCTIONS } from "@shared/projects-fixtures";
import { askStateFixture } from "@shared/ai-fixtures";
import type { PersonSummary } from "@shared/people";
import type { ProjectDetail } from "@shared/projects-core";
import css from "../web/src/trov.css?raw";

const PERSONS = PROJECT_FIXTURE_PEOPLE as unknown as PersonSummary[];
const ME = { handle: "AndresL230", name: "Andres", avatar_url: null, color: "moss" as const, identities: [], orgs: [{ slug: "saplinglearn", name: "SaplingLearn", role: "member" as const }], superadmin: false, pending_invites: 0 };

const props = (d: ProjectDetail | null, over: Partial<ProjectHomeProps> = {}): ProjectHomeProps => ({
  slug: d?.project.slug ?? "hosting-providers", detail: { status: "ok", data: d },
  ui: { headMenu: false, tab: "chats", instr: null, instrBusy: false, restoring: null, unpinning: null },
  me: "AndresL230", persons: PERSONS, org: "SaplingLearn", admin: false, composer: "<!--composer-->", ...over,
});
const home = (d: ProjectDetail | null, over: Partial<ProjectHomeProps> = {}) => projectHomeView(props(d, over));

/** The app on a project's page, Ask's page conversation prepared as a new thread in it (projects-actions.ts). */
function app(d: ProjectDetail): AppState {
  const s = initialState();
  s.view = "app"; s.screen = "project"; s.orgSlug = "saplinglearn";
  (s as { me: unknown }).me = ME;
  s.persons = { status: "ok", data: PERSONS } as AppState["persons"];
  s.projects = { ...s.projects, slug: d.project.slug, detail: { status: "ok", data: d } };
  s.ask.vw = 1440;
  s.ask.state = { status: "ok", data: askStateFixture("pro", new Date("2026-11-05T22:30:00Z")) };
  s.ask.page = { ...emptyConvo(), project: { slug: d.project.slug, name: d.project.name, icon: d.project.icon, color: d.project.color } };
  return s;
}

describe("a project's home — the owner's page", () => {
  const html = home(HOSTING_DETAIL);

  it("heads the page with the tile, name, description, people and the visibility line; Share and the ⋯ menu", () => {
    expect(html).toMatch(/class="cnpy-spt" style="--spt-r:4\.8px;width:40px;height:40px;background:#525cc3"/);
    expect(html).toContain(">Hosting providers</h1>");
    expect(html).toContain("Vercel, Render, Netlify and Fly.io behind one interface");
    expect(html).toContain('class="cnpy-avstack"');
    expect(html).toContain("3 members · owned by you");
    expect(html).toContain('data-act="projShare"');
    expect(html).toContain('data-act="projHeadMenu"');
    const menu = home(HOSTING_DETAIL, { ui: { ...props(HOSTING_DETAIL).ui, headMenu: true } });
    for (const w of ["Edit details", "Members and visibility", "Archive", "Delete project"]) expect(menu).toContain(`>${w}<`);
  });

  it("puts Ask's composer first in the column, then Chats · Artifacts with their counts", () => {
    expect(html.indexOf("<!--composer-->")).toBeLessThan(html.indexOf('data-tabs="pj-tab"'));
    expect(html).toMatch(/role="tab"[^>]*>Chats<span class="cnpy-badge" data-n="4">4<\/span>/);
    expect(html).toMatch(/role="tab"[^>]*>Artifacts<span class="cnpy-badge" data-n="2">2<\/span>/);
  });

  it("lists the chats: the person's own, and one shared with them (who, how, can read), each opening on Ask", () => {
    expect(html).toContain('data-act="projChat" data-arg="301"');
    expect(html).toContain("Where hosting stands this week");
    expect(html).toContain(">Pinned<");
    expect(html).toContain("Jose · Shared with SaplingLearn, can read");
    expect(html).toContain("Your chats here are yours. Share one from its menu to show it to the project.");
  });

  it("shows the instructions with Edit; editing has the counter, Cancel and Save", () => {
    expect(html).toContain(esc(HOSTING_INSTRUCTIONS));
    expect(html).toContain('data-act="projInstrEdit"');
    expect(html).toContain("Trov reads these in every chat in this project.");
    const editing = home(HOSTING_DETAIL, { ui: { ...props(HOSTING_DETAIL).ui, instr: "Short." } });
    expect(editing).toContain('data-act="projInstrInput"');
    expect(editing).toContain("6/2000");
    expect(editing).toContain('data-act="projInstrCancel"');
    expect(editing).toContain('data-act="projInstrSave"');
    expect(editing).not.toContain('data-act="projInstrEdit"');
  });

  it("groups Knowledge by type with each pin's live mark, remove on each, Add, the count and Upload files", () => {
    expect(groupPins(HOSTING_DETAIL.pins).map((g) => g.label)).toEqual(["Sprint", "Tickets", "Pull request", "Docs", "Repository", "Artifact"]);
    expect(html).toContain("In progress");
    expect(html).toContain("Merged");
    expect(html).toContain('<span style="color:var(--fg-55)">#87</span> Production backend deploy fails on Railway');
    expect(html).toContain('data-act="projUnpin" data-arg="ticket:87"');
    expect(html).toContain('data-act="projAdd"');
    expect(html).toContain("10 of 200 pinned");
    expect(html).toContain('data-act="projUploadPick"');
    expect(html).toContain('data-proj-file="page"');
    // A pin opens its item.
    expect(html).toContain('data-act="projPinOpen" data-arg="ticket:87"');
    // A state is a mark, never a pill.
    expect(html).not.toMatch(/text-transform:uppercase/);
  });

  it("a hidden pin reads “An item you don't have access to”, with no title, no mark, no link — still removable by an editor", () => {
    expect(html).toContain(esc(PROJECT_HIDDEN_PIN));
    expect(html).not.toContain("security-review\" data-act");
    expect(html).not.toContain('data-act="projPinOpen" data-arg="doc:security-review"');
    expect(html).toContain('data-act="projUnpin" data-arg="doc:security-review"');
    expect(visiblePins(HOSTING_DETAIL)).toBe(9);
  });

  it("the Artifacts tab draws a card per artifact; empty, its sentence", () => {
    const arts = home(HOSTING_DETAIL, { ui: { ...props(HOSTING_DETAIL).ui, tab: "artifacts" } });
    expect(arts).toContain('data-act="projArtifact" data-arg="where-hosting-stands-nov-5"');
    expect(arts).toContain("railway-build-log.png");
    expect(arts).toContain('id="pj-tab-panel"');
    const none = home(EMPTY_DETAIL, { ui: { ...props(EMPTY_DETAIL).ui, tab: "artifacts" } });
    expect(none).toContain('data-empty="pj-arts"');
    expect(none).toContain(esc(PROJECT_ARTS_EMPTY));
  });
});

describe("a project's home — the states", () => {
  it("an empty project: the chats' and Knowledge's sentences, the instructions' prompt", () => {
    const html = home(EMPTY_DETAIL);
    expect(html).toContain('data-empty="pj-chats"');
    expect(html).toContain(esc(PROJECT_CHATS_EMPTY));
    expect(html).toContain(esc(PROJECT_PINS_EMPTY));
    expect(html).toContain("No instructions yet. Tell Trov what this work is and how to answer.");
    expect(html).toContain("0 of 20 pinned");
  });

  it("a viewer: no Edit, no Add, no remove, no Upload, no Share — and still the composer (viewers start chats)", () => {
    const html = home(VIEWER_DETAIL);
    expect(html).not.toContain('data-act="projInstrEdit"');
    expect(html).not.toContain('data-act="projAdd"');
    expect(html).not.toContain('data-act="projUnpin"');
    expect(html).not.toContain('data-act="projUploadPick"');
    expect(html).not.toContain('data-act="projShare"');
    expect(html).toContain("<!--composer-->");
    expect(html).toContain("Everyone in SaplingLearn · 2 editors");
    expect(html).toContain("Change pending review");
    // A viewer who is an org admin may still archive or delete it.
    const admin = home(VIEWER_DETAIL, { admin: true, ui: { ...props(VIEWER_DETAIL).ui, headMenu: true } });
    expect(admin).toContain('data-act="projArchive"');
    expect(admin).toContain('data-act="projDelete"');
    expect(admin).not.toContain('data-act="projEdit"');
  });

  it("archived: the read-only line with Restore in the composer's place; nothing editable", () => {
    const html = home(ARCHIVED_DETAIL);
    expect(html).toContain("pj-archived");
    expect(html).toMatch(/Archived Oct 12 by Luke\. It&#39;s read-only/);
    expect(html).toContain('data-act="projRestore" data-arg="streak-features"');
    expect(html).not.toContain("<!--composer-->");
    expect(html).not.toContain('data-act="projInstrEdit"');
    expect(html).not.toContain('data-act="projAdd"');
    expect(html).not.toContain('data-act="projShare"');
  });

  it("loading: the skeleton in the page's own frame (the tab bar is there)", () => {
    const html = home(null, { detail: { status: "loading", data: null } });
    for (const k of ["pj-head", "pj-composer", "pj-panel", "pj-instr", "pj-know"]) expect(html).toContain(`data-skel="${k}"`);
    expect(html).toContain('data-tabs="pj-tab"');
  });

  it("a failed read says so in place, with Try again for this project; a project that isn't there says so", () => {
    const failed = home(null, { detail: { status: "error", data: null } });
    expect(failed).toContain("Couldn&#39;t load this.");
    expect(failed).toContain('data-act="projRetry" data-arg="hosting-providers"');
    const gone = home(null, { detail: { status: "ok", data: null } });
    expect(gone).toContain("There is no project here.");
    expect(gone).toContain('data-act="goProjects"');
  });

  it("words: the visibility line and the delete copy", () => {
    expect(visLine(EMPTY_DETAIL, "AndresL230", PERSONS, "SaplingLearn")).toBe("1 member · owned by you");
    expect(deleteProjectText(4, 2)).toBe("Its 4 chats are deleted, including any shared with the project. Its 2 artifacts stay in Artifacts. The tickets, docs and PRs it pinned aren't touched.");
  });
});

describe("a project's home — inside the app", () => {
  it("renders Ask's real composer at the column's full width, sending a new thread in the project", () => {
    const html = render(app(HOSTING_DETAIL));
    expect(html).toContain('data-morph="project:hosting-providers"');
    expect(html).toMatch(/class="pj-ask"><div class="ask-composer" data-ask-composer="page"/);
    expect(html).toContain('placeholder="Ask about Hosting providers"');
    expect(html).toContain('data-act="askCoSend" data-arg="page"');
    // The chip and the foot line say what every turn here reads.
    expect(html).toContain(">In this project<");
    expect(html).toContain("Uses Hosting providers&#39;s instructions and 9 pinned items");
    // trov.css lifts the composer's max-width under the project page.
    expect(css).toMatch(/\.pj-home \.ask-co-in \{ max-width:none; margin:0; padding-bottom:0; \}/);
    expect(css).toMatch(/\.pj-home \.ask-composer \{ padding:0; \}/);
  });

  it("the header names the project after Projects (a link back), and the sidebar lights Projects", () => {
    const html = render(app(HOSTING_DETAIL));
    expect(html).toContain('data-act="goProjects"');
    expect(html).toMatch(/›<\/span><span[^>]*>Hosting providers<\/span>/);
    expect(html).toMatch(/class="cnpy-navrow n-projects is-active"/);
  });

  it("an archived project's page has no composer, whatever the conversation", () => {
    const html = render(app(ARCHIVED_DETAIL));
    expect(html).not.toContain('data-ask-composer="page"');
  });
});

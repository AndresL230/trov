/**
 * The Docs Library's screens (web/src/library.ts; docs/architecture/docs-library.md › The screens): Library home,
 * a space's home, the Create / Edit space dialog, the owners and Archive dialogs, and the space tile.
 *
 * What is pinned here:
 *   • who sees what: "New space" (the header, the dashed card, the empty layout, the sidebar) is an admin's only;
 *     a space's description and owners are editable by `can_edit`; Edit / Archive / Restore are an admin's;
 *   • the Create space dialog's validation: an empty or duplicate name disables the CTA, the duplicate says so;
 *   • an archived space's home: the state mark, no New page, Restore for an admin;
 *   • the tabs: All pages carries the count, A to Z its letter groups, and a page's status is a mark only when
 *     it is not live.
 *
 * Pure (no D1 / Miniflare, no DOM): HTML-string assertions over real render() passes.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../web/src/markdown", () => ({
  renderMarkdown: (body: string) => `<div class="mock-md">${body}</div>`,
  renderMarkdownInline: (text: string) => text,
  sanitizeSvg: (svg: string) => svg,
}));
import { render, initialState, type AppState } from "../web/src/render";
import {
  spaceTile, spaceDialog, spaceHomeView, libraryHomeView, libraryWhen, blankSpaceDraft, duplicateOf, spacePositionDropdown,
  SPACE_ICON_PATHS, FIRST, type SpaceHomeProps,
} from "../web/src/library";
import { initialDropdownUi } from "../web/src/dropdown";
import { SPACE_ICONS, type SpaceDTO, type LibraryPageDTO, type LibraryDTO } from "@shared/docs-core";
import { AUTHORITY_MARK } from "../web/src/marks";
import { spaceErrorText, createLibraryController } from "../web/src/library-actions";
import { OrgApiError } from "../web/src/api";

const T0 = "2026-10-10T10:00:00Z";
const sp = (slug: string, name: string, over: Partial<SpaceDTO> = {}): SpaceDTO => ({
  slug, name, icon: "braces", color: "#525cc3", description: "", sort_rank: 1024, created_at: T0, created_by: "system",
  archived: false, archived_at: null, owners: [], pages: 0, waiting: 0, ...over,
});
const ENG = sp("engineering", "Engineering", { owners: ["priya", "andres"], pages: 3, waiting: 1, description: "How we build, run and fix Trov." });
const PROD = sp("product", "Product", { icon: "compass", color: "#2f7d57" });
const pg = (slug: string, title: string, over: Partial<LibraryPageDTO> = {}): LibraryPageDTO => ({
  slug, title, space: "engineering", section: "reference", parent_slug: null, tree_rank: null, path: [], authority: "live",
  current_version: 1, updated_at: T0, updated_by: "priya", owner: "priya", ...over,
});
const PAGES = [pg("auth", "Authentication"), pg("api", "API reference", { authority: "staged_pending", updated_at: "2026-10-12T10:00:00Z" }), pg("brand", "Brand voice", { authority: "unpromoted", updated_at: "2026-09-01T10:00:00Z" })];
const PERSONS = [
  { handle: "priya", name: "Priya Natarajan", color: "plum", avatar_url: null, role: null },
  { handle: "andres", name: "Andres L.", color: "moss", avatar_url: null, role: null },
] as never[];
const lib = (over: Partial<LibraryDTO> = {}): LibraryDTO => ({ spaces: [ENG, PROD], archived: [], recent: PAGES, waiting: 1, can_admin: false, ...over });

const app = (screen: AppState["screen"], role: "member" | "admin", over: Partial<AppState> = {}): AppState => ({
  ...initialState(), view: "app", screen, orgSlug: "acme",
  me: { handle: "alice", name: "Alice", avatar_url: null, color: "stone", identities: [], orgs: [{ slug: "acme", name: "Acme", role }], superadmin: false, pending_invites: 0 } as AppState["me"],
  persons: { status: "ok", data: PERSONS },
  library: { status: "ok", data: lib({ can_admin: role === "admin" }) },
  ...over,
});
/** A visible `libNew` trigger (the sidebar's is always emitted, hidden for a member). */
const newSpaceShown = (html: string): boolean => /data-act="libNew"(?![^>]*\bhidden\b)[^>]*>/.test(html);

describe("the space tile", () => {
  it("is the space's colour with its white icon at 62%, its corner min(4.8px, size × .25) for the corners block", () => {
    const t14 = spaceTile({ icon: "shield", color: "#b4562c" }, 14);
    expect(t14).toContain('class="cnpy-spt" style="--spt-r:3.5px;width:14px;height:14px;background:#b4562c"');
    expect(t14).toContain('width="9" height="9"');
    expect(t14).toContain('stroke="#fff" stroke-width="2.3"');
    expect(spaceTile({ icon: "shield", color: "#b4562c" }, 40)).toContain("--spt-r:4.8px");
    expect(spaceTile({ icon: "shield", color: "#b4562c" }, 40)).toContain('stroke-width="1.9"');
    // Never an inline radius: the corners block scales `--spt-r`.
    expect(t14).not.toContain("border-radius");
  });
  it("has a path set for every icon choice, and draws the first colour for one that is not a choice", () => {
    for (const ic of SPACE_ICONS) expect(SPACE_ICON_PATHS[ic].length, ic).toBeGreaterThan(0);
    expect(spaceTile({ icon: "nope", color: "red;x" }, 20)).toContain("background:#525cc3");
  });
});

describe("words", () => {
  it("libraryWhen speaks the design's phrasing; unknown is a dash", () => {
    const now = Date.parse(T0);
    const ago = (d: number) => new Date(now - d * 86_400_000).toISOString();
    expect(libraryWhen(ago(0.001), now)).toBe("just now");
    expect(libraryWhen(ago(0.03), now)).toBe("45 minutes ago");
    expect(libraryWhen(ago(0.05), now)).toBe("70 minutes ago");
    expect(libraryWhen(ago(0.07), now)).toBe("2 hours ago");
    expect(libraryWhen(ago(0.065), now)).toBe("2 hours ago");
    expect(libraryWhen(ago(1.5), now)).toBe("yesterday");
    expect(libraryWhen(ago(3), now)).toBe("3 days ago");
    expect(libraryWhen(ago(8), now)).toBe("a week ago");
    expect(libraryWhen(ago(70), now)).toBe("2 months ago");
    expect(libraryWhen(ago(400), now)).toBe("over a year ago");
    expect(libraryWhen(null, now)).toBe("—");
  });
  it("a page's status: nothing for live; the design's words and tooltips otherwise", () => {
    expect(AUTHORITY_MARK.live).toBeNull();
    expect(AUTHORITY_MARK.staged_pending).toMatchObject({ word: "Change pending review", shape: "ring", hint: "Everyone still reads the live version. A newer change is waiting in Review." });
    expect(AUTHORITY_MARK.unpromoted).toMatchObject({ word: "Not yet approved", shape: "dashed", hint: "Nobody has approved this page yet. It goes live once someone approves it in Review." });
  });
  it("a refusal is a sentence: the server's own when it has one", () => {
    expect(spaceErrorText(new OrgApiError(409, "name_taken", "A space called Product already exists", "name"), "x")).toBe("A space called Product already exists.");
    // Case LH8: the restore route's own words start lower-case; the toast is still a sentence.
    expect(spaceErrorText(new OrgApiError(409, "name_taken", "there's already a space called Design", null), "x")).toBe("There's already a space called Design.");
    expect(spaceErrorText(new OrgApiError(400, "not_member", "an owner must be a member", "owners"), "x")).toBe("An owner must be a member.");
    expect(spaceErrorText(new OrgApiError(403, "forbidden", null, null), "x")).toBe("Only an admin, or an owner of this space, can change that.");
  });
});

describe("Library home", () => {
  it("a member: the spaces and the pages changed last, the waiting link — and no New space anywhere", () => {
    const html = render(app("library", "member"));
    expect(html).toContain(">Engineering</span>");
    expect(html).toContain("How we build, run and fix Trov.");
    expect(html).toContain("No description yet.");
    expect(html).toContain("3 pages");
    expect(html).toContain("1 waiting");
    expect(html).toContain("1 page is waiting for review");
    expect(html).toContain('data-act="libOpenSpace" data-arg="engineering"');
    expect(html).toContain('data-act="libOpenDoc" data-arg="api"');
    // Status: nothing for a live page, the words for the others.
    expect(html).toContain("Change pending review");
    expect(html).toContain("Not yet approved");
    expect(html).toContain("Engineering"); // the row's path starts with its space
    expect(newSpaceShown(html)).toBe(false);
    expect(html).not.toContain("cnpy-lib-newcard");
    expect(html).not.toContain("Archived spaces");
  });
  it("an admin: New space in the header, the dashed card, and the archived spaces with Restore", () => {
    const html = render(app("library", "admin", { library: { status: "ok", data: lib({ can_admin: true, archived: [sp("old", "Old stuff", { archived: true, pages: 2 })] }) } }));
    expect(newSpaceShown(html)).toBe(true);
    expect(html).toContain("cnpy-lib-newcard");
    expect(html).toContain("For a team or a topic. Only admins can create spaces.");
    expect(html).toContain("Archived spaces");
    expect(html).toContain('data-act="libRestore" data-arg="old"');
  });
  it("no waiting link when nothing waits", () => {
    expect(libraryHomeView({ library: { status: "ok", data: lib({ waiting: 0 }) }, admin: false, persons: [], restoring: null })).not.toContain("waiting for review");
  });
  it("spaces but no page: the recent list says how it fills", () => {
    const html = libraryHomeView({ library: { status: "ok", data: lib({ recent: [] }) }, admin: false, persons: [], restoring: null });
    expect(html).toContain('data-empty="lib-recent"');
  });
});

describe("a space's home", () => {
  const home = (over: Partial<SpaceHomeProps> = {}, dto: Partial<{ space: SpaceDTO; pages: LibraryPageDTO[]; can_edit: boolean; can_admin: boolean; summaries: Record<string, string> }> = {}): string =>
    spaceHomeView({ slug: "engineering", tab: "overview", admin: false, persons: PERSONS, descDraft: null, home: { status: "ok", data: { space: ENG, pages: PAGES, can_edit: false, can_admin: false, ...dto } }, ...over });

  it("a reader who cannot edit: the description as text, owners by full name, New page — no edit or admin action", () => {
    const html = home();
    expect(html).toContain('<p style="font-size:13.5px;line-height:1.45;color:var(--fg-70);max-width:600px;margin:6px 0 0">How we build, run and fix Trov.</p>');
    expect(html).toContain("Owned by Priya Natarajan and Andres L.");
    expect(html).toContain("3 pages");
    expect(html).toContain("2 waiting for review");
    expect(html).toContain('data-act="libNewPage" data-arg="engineering"');
    for (const act of ["libDescEdit", "libOwners", "libEdit", "libArchive", "libRestore"]) expect(html, act).not.toContain(`data-act="${act}"`);
  });
  it("an owner (can_edit): the description is a button, and Edit owners; still no admin action", () => {
    const html = home({}, { can_edit: true });
    expect(html).toContain('data-act="libDescEdit"');
    expect(html).toContain('data-act="libOwners"');
    expect(html).not.toContain('data-act="libEdit"');
    expect(html).not.toContain('data-act="libArchive"');
    // Editing: the field, its limit and its keys.
    const editing = home({ descDraft: "New words" }, { can_edit: true });
    expect(editing).toContain('data-lib-desc value="New words" maxlength="140" placeholder="What is this space for?"');
    expect(editing).toContain("Enter to save · Esc to cancel");
    expect(editing).toContain("9/140");
    // No description yet: the prompt to add one.
    expect(home({}, { can_edit: true, space: { ...ENG, description: "" } })).toContain("Add a short description");
  });
  it("an admin: Edit space and Archive beside New page", () => {
    const html = home({ admin: true }, { can_edit: true, can_admin: true });
    expect(html).toContain('data-act="libEdit"');
    expect(html).toContain('data-act="libArchive"');
  });
  it("the header's actions wrap inside the column: four buttons never push a phone's page sideways (case ENV13)", () => {
    const html = home({ admin: true }, { can_edit: true, can_admin: true });
    // The box holding Edit space / Archive / Import / New page: no wider than the header, so its own wrap applies.
    const box = html.match(/<div style="([^"]*)">(?:(?!<\/div>)[\s\S])*data-act="libEdit"/)?.[1] ?? "";
    expect(box).toContain("flex-wrap:wrap");
    expect(box).toContain("max-width:100%");
  });
  it("archived: the state mark; no New page and nothing to edit; Restore for an admin only", () => {
    const space = { ...ENG, archived: true, archived_at: T0 };
    const member = home({}, { space, can_edit: true });
    expect(member).toContain("Archived</span>");
    expect(member).toContain('data-mtip="Archived: it is out of the sidebar and the Library. An admin can restore it."');
    expect(member).not.toContain('data-act="libNewPage"');
    expect(member).not.toContain('data-act="libDescEdit"');
    expect(member).not.toContain('data-act="libRestore"');
    expect(home({ admin: true }, { space, can_edit: true, can_admin: true })).toContain('data-act="libRestore" data-arg="engineering"');
  });
  it("a top-level card carries the page's first sentence under its title; a page with none has no line (E2E SH2)", () => {
    const html = home({}, { summaries: { auth: "How a person signs in, and <how> an agent gets a token." } });
    const card = html.slice(html.indexOf('data-arg="auth"') - 1200, html.indexOf('data-arg="auth"'));
    expect(card).toContain('<p class="cnpy-lib-sum">How a person signs in, and &lt;how&gt; an agent gets a token.</p>');
    expect(html.match(/class="cnpy-lib-sum"/g)).toHaveLength(1);
    expect(home()).not.toContain("cnpy-lib-sum");
  });

  it("the tabs: All pages carries the count; each tab lists the pages its way", () => {
    const over = home();
    expect(over).toContain('data-tabs="space-tab"');
    expect(over).toContain('All pages<span class="cnpy-badge" data-n="3">3</span>');
    expect(over).toContain(">Top-level pages</h2>");
    expect(over).toContain("No pages inside");
    const all = home({ tab: "all" });
    expect(all).toContain("<div>Page</div><div>Status</div><div>Last updated</div>");
    // The page tree: All pages is the whole tree flattened in tree order, each level indented 18px; the Overview's
    // top-level cards count every page under them.
    const nested = [pg("api", "API reference", { tree_rank: 1024 }), pg("auth", "Authentication", { parent_slug: "api", tree_rank: 1024 }), pg("sso", "Single sign-on", { parent_slug: "auth" })];
    const tree = home({ tab: "all" }, { pages: nested });
    expect(tree.indexOf("API reference")).toBeLessThan(tree.indexOf("Authentication"));
    expect(tree.indexOf("Authentication")).toBeLessThan(tree.indexOf("Single sign-on"));
    expect(tree).toContain("padding-left:36px");
    expect(home({}, { pages: nested })).toContain("2 pages inside");
    const recent = home({ tab: "recent" });
    expect(recent.indexOf("API reference")).toBeLessThan(recent.indexOf("Brand voice"));
    const oldest = home({ tab: "oldest" });
    expect(oldest.indexOf("Brand voice")).toBeLessThan(oldest.indexOf("API reference"));
    const az = home({ tab: "az" });
    for (const letter of ["A", "B"]) expect(az).toContain(`>${letter}</div>`);
    expect(az.indexOf("API reference")).toBeLessThan(az.indexOf("Authentication"));
    expect(recent).toContain("Top level");
  });
  it("A to Z (owner ruling SH6): an accented title sits under its base letter, symbols and digits in ONE \"#\" group first", () => {
    const pages = [pg("u1", "Ünïcödé page"), pg("u2", "Upgrades"), pg("x", "<img src=x> title"), pg("n", "2026 plan"), pg("a", "Alpha"), pg("z", "Zeta")];
    const az = home({ tab: "az" }, { pages });
    const labels = [...az.matchAll(/class="cnpy-lib-letter"[^>]*>([^<]*)<\/div>/g)].map((m) => m[1]);
    expect(labels).toEqual(["#", "A", "U", "Z"]);
    // Both "#" titles sit before "Alpha"; both U titles sit after the U label.
    expect(az.indexOf("2026 plan")).toBeLessThan(az.indexOf("Alpha"));
    expect(az.indexOf("&lt;img src=x&gt; title")).toBeLessThan(az.indexOf("Alpha"));
    expect(az.indexOf(">U</div>")).toBeLessThan(az.indexOf("Ünïcödé page"));
    expect(az.indexOf("Ünïcödé page")).toBeLessThan(az.indexOf("Zeta"));
  });
  it("render(): the header crumb names the space, and the page is patched in place per space", () => {
    const s = app("space", "member", { spaceSlug: "engineering", spaceHome: { status: "ok", data: { space: ENG, pages: PAGES, can_edit: false, can_admin: false } } });
    const html = render(s);
    expect(html).toContain('data-morph="lib:engineering"');
    expect(html).toMatch(/›<\/span><span[^>]*>Engineering<\/span>/);
    expect(render(app("library", "member"))).toContain('data-morph="library"');
  });
  it("an unknown space says so; a failed read keeps its error", () => {
    const none = render(app("space", "member", { spaceSlug: "nope", spaceHome: { status: "ok", data: null } }));
    expect(none).toContain("There is no space here.");
    // Case SH23: no space, no page tree — never a pane that says "Loading pages…" forever.
    expect(none).not.toContain("cnpy-dpane");
    expect(none).not.toContain("Loading pages…");
    expect(render(app("space", "member", { spaceSlug: "nope", spaceHome: { status: "error", data: null } }))).toContain("Couldn't load this space.");
  });
});

describe("the Create space dialog", () => {
  const dd = initialDropdownUi();
  const draft = (over: Partial<ReturnType<typeof blankSpaceDraft>> = {}) => ({ ...blankSpaceDraft(), ...over });
  it("opens empty on shield and rust, with the design's copy, the 12 icons and 8 swatches", () => {
    const html = spaceDialog(draft(), [ENG, PROD], dd);
    expect(html).toContain(">New space</div>");
    expect(html).toContain("A space holds the pages for one team or topic. Only admins can create one.");
    expect(html).toContain('placeholder="Like Security or Onboarding"');
    expect(html).toContain('maxlength="40"');
    expect(html).toContain('placeholder="What goes in this space?"');
    expect(html).toContain("0/140");
    expect((html.match(/data-act="libIcon"/g) ?? []).length).toBe(12);
    expect((html.match(/data-act="libColor"/g) ?? []).length).toBe(8);
    expect(html).toContain('aria-checked="true" aria-label="Shield"');
    expect(html).toContain('aria-checked="true" aria-label="Rust"');
    expect(html).toContain("In the sidebar");
    expect(html).toMatch(/>New space<\/span><\/span><\/div>/); // the preview, before a name is typed
    // No name yet: the CTA is disabled; no error is said.
    expect(html).toMatch(/data-act="libSave"[^>]*disabled/);
    expect(html).toContain('<div id="lib-sp-name-e" role="alert" class="cnpy-libm-err" hidden>');
    expect(html).not.toContain("lib-sp-pos");
  });
  it("a name another live space has (any case, any spaces) is refused in words, and the CTA stays off", () => {
    const d = draft({ name: "  engineering " });
    expect(duplicateOf(d, [ENG, PROD])?.slug).toBe("engineering");
    const html = spaceDialog(d, [ENG, PROD], dd);
    expect(html).toContain("There&#39;s already a space called Engineering. Pick another name.");
    expect(html).toContain('aria-invalid="true" aria-describedby="lib-sp-name-e"');
    expect(html).toMatch(/data-act="libSave"[^>]*disabled/);
    // An archived space's name is free.
    expect(duplicateOf(d, [{ ...ENG, archived: true }])).toBeNull();
  });
  it("a fresh name arms Create space and shows in the sidebar preview", () => {
    const html = spaceDialog(draft({ name: "Security", description: "Threat models" }), [ENG, PROD], dd);
    expect(html).not.toMatch(/data-act="libSave"[^>]*disabled/);
    expect(html).toContain(">Create space</button>");
    expect(html).toMatch(/>Security<\/span><\/span><\/div>/);
    expect(html).toContain("13/140");
  });
  it("Edit: its own name is no duplicate; Position is a dropdown of First and After ‹Space›", () => {
    const d = draft({ mode: "edit", slug: "product", name: "Product", after: "engineering" });
    const html = spaceDialog(d, [ENG, PROD], dd);
    expect(html).toContain(">Edit space</div>");
    expect(html).not.toMatch(/data-act="libSave"[^>]*disabled/);
    expect(html).toContain('data-dd="lib-sp-pos"');
    expect(html).not.toContain("<select");
    const pos = spacePositionDropdown(d, [ENG, PROD]);
    expect(pos.options.map((o) => o.label)).toEqual(["First", "After Engineering"]);
    expect(pos.value).toBe("engineering");
    expect(spacePositionDropdown({ ...d, after: null }, [ENG, PROD]).value).toBe(FIRST);
  });
  it("render(): only an admin gets the dialog, over Library home", () => {
    const open = { ...initialState().libUi, space: blankSpaceDraft() };
    expect(render(app("library", "admin", { libUi: open }))).toContain('data-overlay="confirm-lib-space"');
    expect(render(app("library", "member", { libUi: open }))).not.toContain("confirm-lib-space");
  });
});

describe("the owners and Archive dialogs", () => {
  const s = (role: "member" | "admin", libUi: Partial<AppState["libUi"]>) => app("space", role, {
    spaceSlug: "engineering", spaceHome: { status: "ok", data: { space: ENG, pages: PAGES, can_edit: true, can_admin: role === "admin" } },
    libUi: { ...initialState().libUi, ...libUi },
  });
  it("owners: every member as a checkbox row, the current owners ticked", () => {
    const html = render(s("member", { owners: { picks: ["priya"], busy: false, error: null } }));
    expect(html).toContain("Owners of Engineering");
    expect(html).toContain('role="checkbox" aria-checked="true" data-act="libOwnerToggle" data-arg="priya"');
    expect(html).toContain('role="checkbox" aria-checked="false" data-act="libOwnerToggle" data-arg="andres"');
    expect(html).not.toContain("<select");
  });
  it("archive: a red confirmation, an admin's only", () => {
    const html = render(s("admin", { archive: { busy: false, error: null } }));
    expect(html).toContain("Archive Engineering?");
    expect(html).toContain('data-confirm-tone="danger"');
    expect(render(s("member", { archive: { busy: false, error: null } }))).not.toContain("Archive Engineering?");
  });
});

describe("the Create space dialog's focus (case CS1)", () => {
  it("New space opens the dialog with Name focused at once — no animation frame (a hidden tab never paints one)", () => {
    const focused: string[] = [];
    const mount = { querySelector: (sel: string) => ({ focus: () => focused.push(sel), value: "", setSelectionRange: () => {} }) } as unknown as HTMLElement;
    const state = app("library", "admin");
    const ctl = createLibraryController({
      state, mount, rerender: () => {}, rerenderSoon: () => {}, flash: () => {}, unauth: () => {}, confirmOut: (f) => f(), openDoc: () => {}, newPage: () => {},
    });
    ctl.act("libNew", null, null);
    expect(state.libUi.space?.mode).toBe("create");
    expect(focused).toEqual(["#lib-sp-name"]);
  });

  it("Edit space, Edit owners and Archive opened from the keyboard move the focus into their dialog (Batch B finding)", () => {
    const focused: string[] = [];
    const mount = { ownerDocument: { activeElement: null }, querySelector: (sel: string) => ({ focus: () => focused.push(sel), value: "", setSelectionRange: () => {} }) } as unknown as HTMLElement;
    const state = app("space", "admin", { spaceSlug: "engineering" } as Partial<AppState>);
    state.spaceHome = { status: "ok", data: { space: ENG, pages: PAGES, can_edit: true, can_admin: true } } as unknown as AppState["spaceHome"];
    const ctl = createLibraryController({
      state, mount, rerender: () => {}, rerenderSoon: () => {}, flash: () => {}, unauth: () => {}, confirmOut: (f) => f(), openDoc: () => {}, newPage: () => {},
    });
    ctl.act("libEdit", null, null);
    expect(focused.at(-1)).toBe("#lib-sp-name");
    ctl.act("libSpaceClose", null, null);
    ctl.act("libOwners", null, null);
    expect(focused.at(-1)).toBe("#lib-owners .cnpy-libm-person, #lib-owners [data-confirm-focus]");
    ctl.act("libOwnersClose", null, null);
    ctl.act("libArchive", null, null);
    expect(focused.at(-1)).toBe("[data-confirm-focus]");
  });

  it("closing a space dialog (Cancel, Escape, the backdrop) gives the focus back to what opened it (case ENV12)", () => {
    const focused: string[] = [];
    const opener = (name: string) => ({ isConnected: true, focus: () => focused.push(name) });
    const doc = { activeElement: null as unknown };
    const mount = { ownerDocument: doc, querySelector: () => ({ focus: () => {}, value: "", setSelectionRange: () => {} }) } as unknown as HTMLElement;
    const state = app("space", "admin", { spaceSlug: "engineering" } as Partial<AppState>);
    state.spaceHome = { status: "ok", data: { space: ENG, pages: PAGES, can_edit: true, can_admin: true } } as unknown as AppState["spaceHome"];
    const ctl = createLibraryController({
      state, mount, rerender: () => {}, rerenderSoon: () => {}, flash: () => {}, unauth: () => {}, confirmOut: (f) => f(), openDoc: () => {}, newPage: () => {},
    });
    for (const [open, close, name] of [["libNew", "libSpaceClose", "new"], ["libOwners", "libOwnersClose", "owners"], ["libArchive", "libArchiveClose", "archive"]] as const) {
      doc.activeElement = opener(name);
      ctl.act(open, null, null);
      ctl.act(close, null, null);
      expect(focused.at(-1), close).toBe(name);
    }
  });
});

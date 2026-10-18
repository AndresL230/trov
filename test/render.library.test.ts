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
  spaceTile, spaceDialog, spaceHomeView, libraryHomeView, LIBRARY_ALL_HIDDEN, libraryWhen, blankSpaceDraft, duplicateOf,
  archiveDialog, SPACE_ICON_PATHS, type SpaceHomeProps,
} from "../web/src/library";
import { SPACE_ICONS, archivePageText, type SpaceDTO, type LibraryPageDTO, type LibraryDTO } from "@shared/docs-core";
import { AUTHORITY_MARK } from "../web/src/marks";
import { spaceErrorText, createLibraryController, pageArchiveErrorText } from "../web/src/library-actions";
import css from "../web/src/trov.css?raw";
import pointerDragSrc from "../web/src/pointer-drag.ts?raw";
import customizeDragSrc from "../web/src/customize-drag.ts?raw";
import libraryActionsSrc from "../web/src/library-actions.ts?raw";
import mainSrc from "../web/src/main.ts?raw";
import morphSrc from "../web/src/morph.ts?raw";
import { OrgApiError, ApiError, setApiOrg } from "../web/src/api";

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
    expect(html).toContain('<p style="font-size:13.5px;line-height:1.45;color:var(--fg-70);max-width:600px;margin:2px 0 0">How we build, run and fix Trov.</p>');
    expect(html).toContain("Owned by Priya Natarajan and Andres L.");
    expect(html).toContain("3 pages");
    expect(html).toContain("2 waiting for review");
    expect(html).toContain('data-act="libNewPage" data-arg="engineering"');
    for (const act of ["libDescEdit", "libOwners", "libEdit", "libArchive", "libRestore"]) expect(html, act).not.toContain(`data-act="${act}"`);
  });
  it("an owner (can_edit): the header's … menu offers the description and the owners; still no admin action", () => {
    // Closed: plain text, one "…" and New page — no pencil, no Edit owners link.
    const closed = home({}, { can_edit: true });
    expect(closed).toMatch(/<button type="button" class="cnpy-outlinebtn cnpy-lib-headmore" data-act="libHeadMenu" aria-label="More for Engineering" aria-haspopup="menu" aria-expanded="false"/);
    for (const act of ["libDescEdit", "libOwners", "libEdit", "libArchive"]) expect(closed, act).not.toContain(`data-act="${act}"`);
    const html = home({ headMenu: true }, { can_edit: true });
    expect(html).toContain('class="cnpy-dp-menu cnpy-lib-headmenu" role="menu"');
    expect(html).toContain('data-act="libDescEdit" data-arg="engineering" class="cnpy-dp-mi">Edit description</button>');
    expect(html).toContain('data-act="libOwners"');
    expect(html).toContain('data-act="goImport" data-arg="engineering"');
    expect(html).not.toContain('data-act="libEdit"');
    expect(html).not.toContain('data-act="libArchive"');
    // Editing: the field, its limit and its keys.
    const editing = home({ descDraft: "New words" }, { can_edit: true });
    expect(editing).toContain('data-lib-desc value="New words" maxlength="140" placeholder="What is this space for?"');
    expect(editing).toContain("Enter to save · Esc to cancel");
    expect(editing).toContain("9/140");
    // No description yet: the menu offers to add one.
    expect(home({ headMenu: true }, { can_edit: true, space: { ...ENG, description: "" } })).toContain(">Add a description</button>");
  });
  it("an admin: Edit space and Archive space in the header's … menu, beside New page — and no Edit description (Edit space has it)", () => {
    const html = home({ admin: true, headMenu: true }, { can_edit: true, can_admin: true });
    expect(html).not.toContain('data-act="libDescEdit"');
    expect(html).toContain('data-act="libEdit"');
    expect(html).toContain('data-act="libArchive"');
  });
  it("the header's actions wrap inside the column: they never push a phone's page sideways (case ENV13)", () => {
    const html = home({ admin: true }, { can_edit: true, can_admin: true });
    // The box holding the "…" and New page: no wider than the header, so its own wrap applies.
    const box = html.match(/<div class="cnpy-lib-shead-acts" style="([^"]*)">(?:(?!<\/div>)[\s\S])*data-act="libHeadMenu"/)?.[1] ?? "";
    // …and the header is a grid that puts them on their own row on a phone.
    expect(css).toMatch(/@media \(max-width:640px\) \{ \.cnpy-lib-shead \{ grid-template-columns:auto minmax\(0,1fr\); \} \.cnpy-lib-shead-acts \{ grid-column:1 \/ -1; \} \}/);
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

  it("the header's meta: each item draws its own \"·\" in the gap before it, clipped at a line's start, so a wrapped line never starts or ends with one (Batch B finding)", () => {
    const html = home({}, { can_edit: true });
    const meta = html.slice(html.indexOf('class="cnpy-lib-meta"'), html.indexOf("</div></div>", html.indexOf('class="cnpy-lib-meta"')));
    expect(meta).not.toContain("·");
    expect(meta.match(/class="cnpy-lib-mi"/g)?.length).toBe(3);   // owners, pages, waiting (Edit owners is in the … menu)
    const rule = (sel: string) => css.match(new RegExp(`${sel.replace(/[.:()]/g, "\\$&")} \\{([^}]*)\\}`))?.[1] ?? "";
    expect(rule(".cnpy-lib-meta")).toContain("overflow:hidden");
    expect(rule(".cnpy-lib-mi::before")).toContain('content:"·"');
    expect(rule(".cnpy-lib-mi::before")).toContain("position:absolute");
  });

  it("the tabs: All pages carries the count; each tab lists the pages its way", () => {
    const over = home();
    expect(over).toContain('data-tabs="space-tab"');
    expect(over).toContain('All pages<span class="cnpy-badge" data-n="3">3</span>');
    expect(over).toContain(">Top-level pages</h2>");
    expect(over).toContain("No pages inside");
    const all = home({ tab: "all" });
    // A list, not a table: no column headers; each page an item with its status by the title and who / when under it.
    expect(all).not.toContain("<div>Page</div><div>Status</div><div>Last updated</div>");
    expect(all).toMatch(/class="cnpy-lib-item cnpy-hitbox"/);
    expect(all).toMatch(/API reference<\/span><span style="display:inline-flex;flex:none">[\s\S]*?Change pending review/);
    // The page tree: All pages is the whole tree flattened in tree order, each level indented 18px; the Overview's
    // top-level cards count every page under them.
    const nested = [pg("api", "API reference", { tree_rank: 1024 }), pg("auth", "Authentication", { parent_slug: "api", tree_rank: 1024 }), pg("sso", "Single sign-on", { parent_slug: "auth" })];
    const tree = home({ tab: "all" }, { pages: nested });
    expect(tree.indexOf("API reference")).toBeLessThan(tree.indexOf("Authentication"));
    expect(tree.indexOf("Authentication")).toBeLessThan(tree.indexOf("Single sign-on"));
    expect(tree).toContain("padding:11px 16px 11px 52px"); // depth 2: 16px + 2 × 18px
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
  const draft = (over: Partial<ReturnType<typeof blankSpaceDraft>> = {}) => ({ ...blankSpaceDraft(), ...over });
  it("opens empty on shield and rust, with the design's copy, the 12 icons and 8 swatches", () => {
    const html = spaceDialog(draft(), [ENG, PROD]);
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
    // No Position and no sidebar preview (the order is A to Z; each person picks their own sidebar).
    expect(html).not.toContain("In the sidebar");
    // No name yet: the CTA is disabled; no error is said.
    expect(html).toMatch(/data-act="libSave"[^>]*disabled/);
    expect(html).toContain('<div id="lib-sp-name-e" role="alert" class="cnpy-libm-err" hidden>');
    expect(html).not.toContain("lib-sp-pos");
  });
  it("a name another live space has (any case, any spaces) is refused in words, and the CTA stays off", () => {
    const d = draft({ name: "  engineering " });
    expect(duplicateOf(d, [ENG, PROD])?.slug).toBe("engineering");
    const html = spaceDialog(d, [ENG, PROD]);
    expect(html).toContain("There&#39;s already a space called Engineering. Pick another name.");
    expect(html).toContain('aria-invalid="true" aria-describedby="lib-sp-name-e"');
    expect(html).toMatch(/data-act="libSave"[^>]*disabled/);
    // An archived space's name is free.
    expect(duplicateOf(d, [{ ...ENG, archived: true }])).toBeNull();
  });
  it("a fresh name arms Create space", () => {
    const html = spaceDialog(draft({ name: "Security", description: "Threat models" }), [ENG, PROD]);
    expect(html).not.toMatch(/data-act="libSave"[^>]*disabled/);
    expect(html).toContain(">Create space</button>");
    expect(html).toContain("13/140");
  });
  it("Edit: its own name is no duplicate; no Position field and no sidebar preview", () => {
    const d = draft({ mode: "edit", slug: "product", name: "Product" });
    const html = spaceDialog(d, [ENG, PROD]);
    expect(html).toContain(">Edit space</div>");
    expect(html).not.toMatch(/data-act="libSave"[^>]*disabled/);
    expect(html).not.toContain("lib-sp-pos");
    expect(html).not.toContain("Position");
    expect(html).not.toContain("In the sidebar");
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
  it("archive: the sentence agrees with the page count — one page stays as it is (case SH21, Batch C)", () => {
    const ask = { busy: false, error: null };
    expect(archiveDialog({ ...ENG, pages: 1 }, ask)).toContain("Its 1 page stays as it is, and an admin can restore it from the Library.");
    expect(archiveDialog({ ...ENG, pages: 3 }, ask)).toContain("Its 3 pages stay as they are, and an admin can restore it from the Library.");
  });
});

describe("the Create space dialog's focus (case CS1)", () => {
  it("Create / Edit space is the design's 480 px dialog; the owners and archive dialogs keep the confirm's 420 (case CS1, Batch C)", () => {
    const rule = (sel: string) => css.match(new RegExp(`${sel.replace(/[.:()#]/g, "\\$&")} \\{([^}]*)\\}`))?.[1] ?? "";
    expect(rule("#lib-space.cnpy-cmodal-box")).toContain("width:min(480px, 100%)");
    expect(rule(".cnpy-cmodal-box")).toContain("width:min(420px, 100%)");
    expect(css).not.toMatch(/#lib-(owners|archive)\.cnpy-cmodal-box \{[^}]*width/);
  });

  it("New space opens the dialog with Name focused at once — no animation frame (a hidden tab never paints one)", () => {
    const focused: string[] = [];
    const mount = { querySelector: (sel: string) => ({ focus: () => focused.push(sel), value: "", setSelectionRange: () => {} }) } as unknown as HTMLElement;
    const state = app("library", "admin");
    const ctl = createLibraryController({
      state, mount, rerender: () => {}, rerenderSoon: () => {}, flash: () => {}, unauth: () => {}, confirmOut: (f) => f(), openDoc: () => {}, newPage: () => {}, pageChanged: () => {}, treeChanged: () => {},
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
      state, mount, rerender: () => {}, rerenderSoon: () => {}, flash: () => {}, unauth: () => {}, confirmOut: (f) => f(), openDoc: () => {}, newPage: () => {}, pageChanged: () => {}, treeChanged: () => {},
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
      state, mount, rerender: () => {}, rerenderSoon: () => {}, flash: () => {}, unauth: () => {}, confirmOut: (f) => f(), openDoc: () => {}, newPage: () => {}, pageChanged: () => {}, treeChanged: () => {},
    });
    for (const [open, close, name] of [["libNew", "libSpaceClose", "new"], ["libOwners", "libOwnersClose", "owners"], ["libArchive", "libArchiveClose", "archive"]] as const) {
      doc.activeElement = opener(name);
      ctl.act(open, null, null);
      ctl.act(close, null, null);
      expect(focused.at(-1), close).toBe(name);
    }
  });
});

describe("Archive page (0083_doc_archive): Space home's Archived pages, the confirmation, the controller", () => {
  const ARCH = [{ slug: "old-runbook", title: "Old runbook", archived_at: T0, archived_by: "priya", current_version: 2 }];
  const home = (canArchive: boolean, archived = ARCH, over: Partial<SpaceHomeProps> = {}): string =>
    spaceHomeView({ slug: "engineering", tab: "archived", admin: false, persons: PERSONS, descDraft: null,
      home: { status: "ok", data: { space: ENG, pages: PAGES, can_edit: canArchive, can_archive: canArchive, can_admin: false, archived_pages: archived } }, ...over });

  it("is the last tab, with its count; each page says who archived it and when, and opens by its link", () => {
    const html = home(false);
    expect(html).toMatch(/id="space-tab-archived"[^>]*>Archived pages<span class="cnpy-badge" data-n="1">1<\/span><\/button><\/div>/);
    expect(html).toContain('data-archived-page="old-runbook"');
    expect(html).toContain("Old runbook");
    expect(html).toMatch(/Priya · /);
    expect(html).toContain('data-act="libOpenDoc" data-arg="old-runbook"');
  });
  it("Restore for an admin or an owner of the space (can_archive) only; busy while it is out", () => {
    expect(home(false)).not.toContain("libPageRestore");
    expect(home(true)).toContain('data-act="libPageRestore" data-arg="old-runbook"');
    expect(home(true, ARCH, { restoring: "old-runbook" })).toContain("Restoring…");
  });
  it("no archived page: the empty layout, the tab still there (stable), with 0", () => {
    const html = home(true, []);
    expect(html).toContain('data-empty="space-archived"');
    expect(html).toContain("No archived pages.");
    expect(html).toContain('<span class="cnpy-badge" data-n="0">0</span>');
    // A space with no live page still shows its Archived pages, not the "No pages yet" layout.
    const onlyArchived = spaceHomeView({ slug: "engineering", tab: "archived", admin: false, persons: PERSONS, descDraft: null,
      home: { status: "ok", data: { space: ENG, pages: [], can_edit: true, can_archive: true, can_admin: false, archived_pages: ARCH } } });
    expect(onlyArchived).toContain('data-archived-page="old-runbook"');
    expect(onlyArchived).not.toContain('data-empty="space"');
  });
  it("the confirmation says what happens, in red, over a doc page or a space's home", () => {
    const state = app("docs", "member", { docSlug: "auth", libUi: { ...initialState().libUi, pageArchive: { slug: "auth", title: "Authentication", under: 2, spaceName: "Engineering", busy: false, error: null } } });
    const html = render(state);
    expect(html).toContain("Archive Authentication?");
    expect(html).toMatch(/Authentication leaves the Library\. 2 pages under it move up a level\. You can restore it from Engineering(&#39;|')s Archived pages\./);
    expect(html).toContain('data-confirm-tone="danger"');
    expect(html).toContain('data-act="libPageArchiveGo"');
    expect(archivePageText("Guide", 1, "Ops")).toBe("Guide leaves the Library. The page under it moves up a level. You can restore it from Ops's Archived pages.");
    expect(archivePageText("Guide", 0, "Ops")).toBe("Guide leaves the Library. You can restore it from Ops's Archived pages.");
  });
  it("the controller opens it from a pane row with the page's title and the pages right under it, focused; closing gives the focus back", () => {
    const focused: string[] = [];
    const doc = { activeElement: { isConnected: true, focus: () => focused.push("opener") } as unknown };
    const mount = { ownerDocument: doc, querySelector: (sel: string) => ({ focus: () => focused.push(sel), value: "", setSelectionRange: () => {} }) } as unknown as HTMLElement;
    const state = app("space", "admin", { spaceSlug: "engineering", treeMenu: "auth" } as Partial<AppState>);
    const tree = [...PAGES, { ...PAGES[0], slug: "auth-kid", title: "Kid", parent_slug: "auth" }, { ...PAGES[0], slug: "auth-kid2", title: "Kid 2", parent_slug: "auth" }];
    state.spaceHome = { status: "ok", data: { space: ENG, pages: tree, can_edit: true, can_archive: true, can_admin: true } } as unknown as AppState["spaceHome"];
    const ctl = createLibraryController({
      state, mount, rerender: () => {}, rerenderSoon: () => {}, flash: () => {}, unauth: () => {}, confirmOut: (f) => f(), openDoc: () => {}, newPage: () => {}, pageChanged: () => {}, treeChanged: () => {},
    });
    ctl.act("libPageArchive", "auth", null);
    expect(state.treeMenu).toBeNull();
    expect(state.libUi.pageArchive).toMatchObject({ slug: "auth", title: "Authentication", under: 2, spaceName: "Engineering" });
    expect(focused.at(-1)).toBe("#lib-page-archive [data-confirm-focus]");
    ctl.act("libPageArchiveClose", null, null);
    expect(state.libUi.pageArchive).toBeNull();
    expect(focused.at(-1)).toBe("opener");
  });
  it("an archive or a restore reads the open doc page again — the archived page's parent lists its children (e2e AR1)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, places: [], parent_slug: null }), { status: 200, headers: { "content-type": "application/json" } })));
    setApiOrg("acme");
    try {
      const doc = { activeElement: null };
      const mount = { ownerDocument: doc, querySelector: () => ({ focus: () => {}, value: "", setSelectionRange: () => {} }) } as unknown as HTMLElement;
      const state = app("docs", "admin", { spaceSlug: "engineering", docSlug: "api" } as Partial<AppState>);
      state.spaceHome = { status: "ok", data: { space: ENG, pages: PAGES, can_edit: true, can_archive: true, can_admin: true } } as unknown as AppState["spaceHome"];
      const reread: string[] = [];
      const ctl = createLibraryController({
        state, mount, rerender: () => {}, rerenderSoon: () => {}, flash: () => {}, unauth: () => {}, confirmOut: (f) => f(), openDoc: () => {}, newPage: () => {},
        pageChanged: () => {}, treeChanged: () => reread.push("tree"),
      });
      ctl.act("libPageArchive", "auth", null);
      ctl.act("libPageArchiveGo", null, null);
      expect(reread).toEqual([]);                            // not before the Worker has it
      await new Promise((r) => setTimeout(r, 0));
      expect(reread).toEqual(["tree"]);
      // (the stubbed reads answered the space's read with a bare object; put the space back for the restore)
      state.spaceHome = { status: "ok", data: { space: ENG, pages: PAGES, can_edit: true, can_archive: true, can_admin: true } } as unknown as AppState["spaceHome"];
      ctl.act("libPageRestore", "auth", null);
      await new Promise((r) => setTimeout(r, 0));
      expect(reread).toEqual(["tree", "tree"]);
    } finally {
      setApiOrg(null);
      vi.unstubAllGlobals();
    }
  });
  it("opened from the pane row's \"…\" menu, closing it gives the focus to that row's \"…\" — the menu item is gone (e2e AR16)", () => {
    const focused: string[] = [];
    const item = { isConnected: true, focus: () => focused.push("menu item") };
    const doc = { activeElement: item as unknown };
    const mount = { ownerDocument: doc, querySelector: (sel: string) => ({ focus: () => focused.push(sel), value: "", setSelectionRange: () => {} }) } as unknown as HTMLElement;
    const state = app("docs", "admin", { spaceSlug: "engineering", treeMenu: "auth" } as Partial<AppState>);
    state.spaceHome = { status: "ok", data: { space: ENG, pages: PAGES, can_edit: true, can_archive: true, can_admin: true } } as unknown as AppState["spaceHome"];
    const ctl = createLibraryController({
      state, mount, rerender: () => { item.isConnected = state.treeMenu !== null; }, rerenderSoon: () => {}, flash: () => {}, unauth: () => {}, confirmOut: (f) => f(), openDoc: () => {}, newPage: () => {}, pageChanged: () => {}, treeChanged: () => {},
    });
    ctl.act("libPageArchive", "auth", null);
    ctl.act("libPageArchiveClose", null, null);
    expect(focused.at(-1)).toBe('.cnpy-dp-row[data-dtree="auth"] [data-act="treeMenu"]');
  });
  it("a refusal is said in words", () => {
    const err = (code: string) => pageArchiveErrorText(new ApiError(409, code), "Couldn't archive the page.");
    expect(err("forbidden")).toBe("Only an admin, or an owner of this space, can archive or restore its pages.");
    expect(err("space_archived")).toBe("This space is archived. Restore the space first.");
    expect(pageArchiveErrorText(new Error("x"), "Couldn't archive the page.")).toBe("Couldn't archive the page. Check your connection and try again.");
  });
});

// ── your own Library: the sidebar's five, pinned and hidden cards, Customize sidebar ──────────────────────────────

describe("your own Library view (0084_library_prefs)", () => {
  const SIX = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"].map((k) => sp(k, k[0].toUpperCase() + k.slice(1)));
  const withPrefs = (prefs: LibraryDTO["prefs"], over: Partial<AppState> = {}) =>
    app("library", "member", { library: { status: "ok", data: lib({ spaces: SIX, prefs }) }, ...over });
  const sidebarSpaceRows = (html: string) => [...html.matchAll(/data-act="navSub" data-arg="library:([a-z]+)"/g)].map((m) => m[1]);

  it("the sidebar shows the first five in the Library's order and nothing after them (Customize is Library home's)", () => {
    const html = render(withPrefs(undefined));
    expect(sidebarSpaceRows(html)).toEqual(["alpha", "bravo", "charlie", "delta", "echo"]);
    for (const cls of ["cnpy-sub-morerow", "cnpy-sub-more", "cnpy-sub-custom"]) expect(html, cls).not.toContain(cls);
    expect(html.match(/data-act="libCustomize"/g)?.length).toBe(1); // Library home's "Customize sidebar" only
  });

  it("…or the person's own pick, in their order", () => {
    expect(sidebarSpaceRows(render(withPrefs({ sidebar: ["foxtrot", "alpha"], pinned: [], hidden: [] })))).toEqual(["foxtrot", "alpha"]);
  });

  it("Library home: pinned cards first under Pinned, the rest under All spaces, hidden ones behind a toggle", () => {
    const html = libraryHomeView({ library: { status: "ok", data: lib({ spaces: SIX, prefs: { sidebar: null, pinned: ["echo"], hidden: ["bravo"] } }) }, admin: false, persons: PERSONS, restoring: null });
    const at = (k: string) => html.indexOf(`data-space="${k}"`);
    expect(html).toMatch(/<h2[^>]*>Pinned<\/h2>/);
    expect(html).toMatch(/<h2[^>]*>All spaces<\/h2>/);
    expect(at("echo")).toBeLessThan(at("alpha"));
    expect(at("bravo")).toBe(-1);
    expect(html).toContain('data-act="libHiddenToggle"');
    expect(html).toContain("Show hidden spaces · 1");
    const shown = libraryHomeView({ library: { status: "ok", data: lib({ spaces: SIX, prefs: { sidebar: null, pinned: [], hidden: ["bravo"] } }) }, admin: false, persons: PERSONS, restoring: null, showHidden: true });
    expect(shown).toMatch(/class="cnpy-surface[^"]*cnpy-lib-card is-hidden[^"]*"[^>]*data-space="bravo"/);
  });

  it("a member who hides every space keeps the heading and Customize sidebar, with a line saying why", () => {
    const all = SIX.map((x) => x.slug);
    const html = libraryHomeView({ library: { status: "ok", data: lib({ spaces: SIX, prefs: { sidebar: null, pinned: [], hidden: all } }) }, admin: false, persons: PERSONS, restoring: null });
    expect(html).toMatch(/<h2[^>]*>Spaces<\/h2>/);
    expect(html).toContain('data-act="libCustomize"');
    expect(html).toContain('data-empty="lib-all-hidden"');
    expect(html).toContain(LIBRARY_ALL_HIDDEN.slice(LIBRARY_ALL_HIDDEN.indexOf("hidden every")));
    expect(html).toContain("Show hidden spaces · 6");
    // Some cards still shown, or an admin's New space card: no such line.
    expect(libraryHomeView({ library: { status: "ok", data: lib({ spaces: SIX, prefs: { sidebar: null, pinned: [], hidden: all } }) }, admin: true, persons: PERSONS, restoring: null })).not.toContain("lib-all-hidden");
  });

  it("each card's \"…\" is a control beside the hit area (never inside a button); its menu pins, sidebars and hides", () => {
    const view = (prefs: LibraryDTO["prefs"]) => libraryHomeView({ library: { status: "ok", data: lib({ spaces: SIX, prefs }) }, admin: false, persons: PERSONS, restoring: null, cardMenu: "foxtrot" });
    const html = view(undefined);
    const card = html.slice(html.indexOf('data-space="foxtrot"'));
    expect(card).toMatch(/<button type="button" class="cnpy-iconbtn cnpy-hitctl cnpy-lib-more" data-act="libCardMenu" data-arg="foxtrot" aria-label="Options for Foxtrot" aria-haspopup="menu" aria-expanded="true">/);
    for (const act of ["libPin", "libSidebarAdd", "libHide"]) expect(card).toContain(`data-act="${act}" data-arg="foxtrot"`);
    // The default sidebar is full (five): Show in sidebar says why it can't, rather than doing nothing.
    expect(card).toMatch(/data-act="libSidebarAdd" data-arg="foxtrot" class="cnpy-dp-mi" aria-disabled="true" data-mtip="Your sidebar shows 5 spaces/);
    const pinned = view({ sidebar: ["foxtrot"], pinned: ["foxtrot"], hidden: [] });
    expect(pinned).toContain('data-act="libUnpin" data-arg="foxtrot"');
    expect(pinned).toContain('data-act="libSidebarRemove" data-arg="foxtrot"');
  });

  it("Customize sidebar: the picks in order, dragged (a grip, Alt+arrows on a focused row) with remove; the others with Add until five; a reset", () => {
    const s = withPrefs({ sidebar: ["charlie", "alpha"], pinned: [], hidden: [] });
    s.libUi = { ...s.libUi, customize: { list: ["charlie", "alpha"], dflt: false, busy: false, error: null } };
    const html = render(s);
    expect(html).toContain('id="lib-customize"');
    expect(html).toContain("2 of 5");
    expect([...html.matchAll(/<li class="cnpy-libc-row is-picked" data-cdrag="([a-z]+)" data-libc="\1" data-morph-key="libc:\1" tabindex="0" aria-label="[^"]+: drag, or press Alt\+Up or Alt\+Down, to move it"/g)].map((m) => m[1])).toEqual(["charlie", "alpha"]);
    expect(html).toContain('class="cnpy-libc-grip"');
    expect(html).not.toContain('data-act="libCustomizeUp"');
    expect(html).toContain('data-act="libCustomizeRemove" data-arg="alpha"');
    expect(html).toMatch(/data-act="libCustomizeAdd" data-arg="bravo"(?![^>]*disabled)/);
    expect(html).toMatch(/data-act="libCustomizeReset"(?![^>]*disabled)/);
    // On any screen: the dialog opens from the sidebar too.
    s.screen = "tickets";
    expect(render(s)).toContain('id="lib-customize"');
  });

  it("dragging a row never selects its text or starts the browser's own drag (pointer-drag.ts, every list)", () => {
    // A real mouse pressed on a row's name used to select the text as it dragged, and a second try dragged that
    // selection natively, which cancelled the drag. The engine refuses both while a press it claimed is live.
    expect(pointerDragSrc).toMatch(/addEventListener\("selectstart", \(e\) => \{ if \(live\) e\.preventDefault\(\); \}\)/);
    expect(pointerDragSrc).toMatch(/addEventListener\("dragstart", \(e\) => \{ if \(live\) e\.preventDefault\(\); \}\)/);
    expect(pointerDragSrc).toContain("getSelection()?.removeAllRanges()");
  });

  it("a drag lifts the row as the board lifts a card, the others slide, and Escape cancels only the drag", () => {
    // The row leaves the list, a slot of its height holds its place, a ghost follows the pointer (customize-drag.ts).
    expect(customizeDragSrc).toContain('ghost.classList.add("cnpy-libc-ghost")');
    expect(customizeDragSrc).toContain('slot.className = "cnpy-libc-slot"');
    expect(customizeDragSrc).toContain("slideRows(p.list, () => p.list.insertBefore(slot, ref)");
    expect(css).toMatch(/\.cnpy-libc-row\.is-lifted \{ display:none !important; \}/);
    expect(css, "the gap draws nothing").not.toMatch(/\.cnpy-libc-slot\s*\{/);
    // Rows give way once the ghost is a third into them, only on the side it heads for, and quickly.
    expect(customizeDragSrc).toContain("const OVERLAP = 0.33;");
    expect(customizeDragSrc).toContain("const DRAG_SLIDE_MS = 110;");
    expect(css).toMatch(/\.cnpy-libc-ghost \{ position:fixed !important; z-index:1000;/);
    // Escape mid-drag is the drag's alone: the dialog the list sits in stays open.
    expect(pointerDragSrc).toMatch(/e\.key === "Escape" && live\?\.begun\) \{ e\.preventDefault\(\); e\.stopImmediatePropagation\(\); end\(false\); \} \}, true\);/);
  });

  it("Save closes the dialog smoothly: the toast's repaint never strips the exit (confirmOut keeps the leaving layer)", () => {
    // Save closes with confirmOut and puts up "Sidebar saved" at once; that repaint used to drop `data-closing`, so
    // the dialog popped back in and then vanished. A leaving layer is `data-keep`, which morph never patches.
    expect(libraryActionsSrc).toMatch(/setPrefs\(prefs\); host\.confirmOut\(.*\); host\.flash\("Sidebar saved"\)/);
    const out = mainSrc.slice(mainSrc.indexOf("function confirmOut("), mainSrc.indexOf("setTimeout(then, CONFIRM_OUT_MS)"));
    expect(out).toContain('layer.setAttribute("data-keep", "");');
    expect(out.indexOf('"data-keep"')).toBeLessThan(out.indexOf('layer.setAttribute("data-closing"'));
    expect(morphSrc).toContain('if (live.hasAttribute("data-keep")) return;');
  });

  it("Reset, Add, remove and Alt+arrows slide every row to its new place: keyed rows, the repaint run inside slideRows", () => {
    const s = withPrefs(undefined);
    s.libUi = { ...s.libUi, customize: { list: ["bravo", "alpha"], dflt: false, busy: false, error: null } };
    const html = render(s);
    expect(html).toContain('<ol data-morph-list');
    expect(html).toContain('<ul data-morph-list');
    expect(html).toMatch(/data-cdrag="bravo" data-libc="bravo" data-morph-key="libc:bravo"/);
    expect(html).toMatch(/<li class="cnpy-libc-row" data-libc="charlie" data-morph-key="libc:charlie"/);
    for (const act of ["libCustomizeUp", "libCustomizeRemove", "libCustomizeAdd", "libCustomizeReset"]) {
      const at = libraryActionsSrc.indexOf(`case "${act}"`);
      const body = libraryActionsSrc.slice(at, libraryActionsSrc.indexOf("return;", libraryActionsSrc.indexOf("c.dflt", at)));
      expect(body, act).toContain("slide();");
    }
  });

  it("the controller: Customize adds, moves and saves the person's own list (sidebar only)", async () => {
    const s = withPrefs(undefined);
    const sent: unknown[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true, prefs: { sidebar: ["foxtrot", "alpha"], pinned: [], hidden: [] } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      setApiOrg("acme");
      const ctl = createLibraryController({ state: s, mount: { querySelector: () => null } as unknown as HTMLElement, rerender() {}, rerenderSoon() {}, flash() {}, unauth() {}, pageChanged() {}, treeChanged() {}, confirmOut: (then) => then(), openDoc() {}, newPage() {} });
      ctl.act("libCustomize", null, null);
      expect(s.libUi.customize?.list).toEqual(["alpha", "bravo", "charlie", "delta", "echo"]);
      for (const k of ["bravo", "charlie", "delta", "echo"]) ctl.act("libCustomizeRemove", k, null);
      ctl.act("libCustomizeAdd", "foxtrot", null);
      // A drop hands the new order; one naming a slug that isn't picked is ignored.
      ctl.act("libCustomizeOrder", "foxtrot,bravo", null);
      expect(s.libUi.customize?.list).toEqual(["alpha", "foxtrot"]);
      ctl.act("libCustomizeOrder", "foxtrot,alpha", null);
      expect(s.libUi.customize?.list).toEqual(["foxtrot", "alpha"]);
      ctl.act("libCustomizeDown", "foxtrot", null); // the keyboard's Alt+↓
      ctl.act("libCustomizeUp", "foxtrot", null);   // …and Alt+↑
      ctl.act("libCustomizeSave", null, null);
      await new Promise((r) => setTimeout(r, 0));
      expect(sent).toEqual([{ sidebar: ["foxtrot", "alpha"] }]);
      expect(s.library.data?.prefs?.sidebar).toEqual(["foxtrot", "alpha"]);
      expect(s.libUi.customize).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

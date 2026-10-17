/**
 * The Docs Library's Markdown import, its screens (web/src/import.ts, web/src/import-drop.ts, the import groups of
 * web/src/review.ts; docs/architecture/docs-library.md › The import screens).
 *
 * What is pinned here:
 *   • the wizard: the stepper, each step a keyed part (`imp:<step>`) of a page patched in place (`data-morph`), the
 *     Where step's space cards and tree picker, the Files step's hidden input and drop zone, the Preview built from
 *     the SHARED planner (conflicts with their per-item and "For all" switches, a rename's field, the skipped files,
 *     the images and links in words, the footer's count), the progress and done cards;
 *   • Imports history: the always-shown column header, the skeleton's six rows, the empty layout, a status as a mark
 *     (never a pill), one row open at a time with its details, Cancel import for its starter only;
 *   • Review grouped by import: one card per import in the import's tree order, the filter's counts, the page bar,
 *     Reject all's confirmation in the design's words;
 *   • the sidebar's Imports row (stable DOM, its badge hidden at 0) and its Import action;
 *   • drop to import: what a drag may carry, and what a drop says.
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
  importWizardView, importsHistoryView, importStepper, initialImportUi, importPlanFor, importChoices, linkWords, imageWords, runWhen,
  type ImportUi, type ImportWizardProps, type ImportsHistoryProps, type ImportDriverView,
} from "../web/src/import";
import { reviewView, importGroups, type ReviewItem, type ReviewProps } from "../web/src/review";
import { sidebarView, NAV_CLOSED, navKeyOf, type SidebarProps } from "../web/src/sidebar";
import { dragFiles, splitDropped, dropSub, dropTitle, DROP_TYPES } from "../web/src/import-drop";
import { IMPORT_MARK, importRunMark } from "../web/src/marks";
import { importErrorText } from "../web/src/import-actions";
import { OrgApiError, PreviewBlocked } from "../web/src/api";
import type { LibraryDTO, LibraryPageDTO, SpaceDTO } from "@shared/docs-core";
import type { ImportRunView, ImportFile } from "@shared/docs-import-core";

const T0 = "2026-10-15T10:00:00Z";
const sp = (slug: string, name: string, pages = 0): SpaceDTO => ({
  slug, name, icon: "braces", color: "#525cc3", description: "", sort_rank: 1024, created_at: T0, created_by: "system",
  archived: false, archived_at: null, owners: [], pages, waiting: 0,
});
const ENG = sp("engineering", "Engineering", 2);
const LIB: LibraryDTO = { spaces: [ENG, sp("product", "Product")], archived: [], recent: [], waiting: 0, can_admin: false };
const page = (slug: string, title: string, over: Partial<LibraryPageDTO> = {}): LibraryPageDTO => ({
  slug, title, space: "engineering", section: "reference", parent_slug: null, tree_rank: null, path: [], authority: "live",
  current_version: 1, updated_at: T0, updated_by: "andres", owner: null, ...over,
});
const PAGES = [page("getting-started", "Getting started"), page("local-setup", "Local setup", { parent_slug: "getting-started", path: ["Getting started"] })];
const FILES: ImportFile[] = [
  { path: "handbook/README.md", size: 120, kind: "md", title: "Engineering handbook" },
  { path: "handbook/onboarding/first-week.md", size: 80, kind: "md", title: "Your first week" },
  { path: "handbook/onboarding/local-setup.md", size: 80, kind: "md", title: "Local setup" },
  { path: "handbook/design/logo.sketch", size: 900, kind: "other" },
  { path: "handbook/img/arch.png", size: 400, kind: "image" },
];
const ui = (over: Partial<ImportUi> = {}): ImportUi => ({ ...initialImportUi(), space: "engineering", ...over });
const wiz = (u: Partial<ImportUi>, over: Partial<ImportWizardProps> = {}): string =>
  importWizardView({ ui: ui(u), library: { status: "ok", data: LIB }, pages: PAGES, ...over });
const zipPick = { id: 1, name: "handbook.zip", size: 2_400_000, kind: "zip" as const, state: "ready" as const, error: null, inside: 5 };

describe("the import wizard (`#import`)", () => {
  it("is ONE page patched in place, its step a keyed part, under a four-step stepper", () => {
    const s: AppState = { ...initialState(), view: "app", screen: "import", library: { status: "ok", data: LIB }, imp: ui() };
    const html = render(s);
    expect(html).toContain('<main data-morph="import"');
    expect(html).toContain('data-morph-key="imp:where"');
    // The header: Library › Import, the title a way back.
    expect(html).toMatch(/data-act="goLibrary"[^>]*>Library<\/button>/);
    expect(html).toContain(">Import</span>");
    const st = importStepper("preview", false);
    expect(st.match(/data-s="done"/g)?.length).toBe(4);   // two steps and the two lines after them
    expect(st).toContain('data-s="now" aria-current="step"');
    expect(st.indexOf(">Where<")).toBeLessThan(st.indexOf(">Import<"));
    expect(importStepper("run", true)).not.toContain('data-s="now"');
  });

  it("Where: the space cards (the picked one checked) and the tree picker, with the footer's words", () => {
    const html = wiz({ parent: "local-setup" });
    expect(html).toContain("Where should the pages go?");
    expect(html).toMatch(/role="radio" aria-checked="true" data-act="impSpace" data-arg="engineering"/);
    expect(html).toContain("Top level of Engineering");
    expect(html).toMatch(/data-act="impWhereToggle" data-arg="getting-started"/);
    expect(html).toContain("Engineering › Getting started › Local setup");
    expect(html).toMatch(/data-act="impStep" data-arg="files"|data-arg="files"[^>]*data-act="impStep"/);
    // No space picked: no tree, and Continue is off.
    const none = wiz({ space: null });
    expect(none).not.toContain("Inside a page");
    expect(none).toContain("Pick a space first.");
    expect(none).not.toContain('data-act="impStep"');
  });

  it("with no space in the org, an empty layout (New space for an admin), never a picker", () => {
    const html = importWizardView({ ui: ui({ space: null }), library: { status: "ok", data: { ...LIB, spaces: [] } }, pages: null, admin: true });
    expect(html).toContain('data-empty="import"');
    expect(html).toContain('data-act="libNew"');
    expect(html).not.toContain("impSpace");
  });

  it("Files: a hidden multi-file input that takes .md, .markdown and .zip, the drop zone, the caps, each file's state", () => {
    const html = wiz({ step: "files", picks: [zipPick, { id: 2, name: "notes.md", size: 900, kind: "md", state: "reading", error: null, inside: null }, { id: 3, name: "q3.pdf", size: 10, kind: "other", state: "bad", error: "Not a Markdown file. Use .md files, or a .zip of them.", inside: null }] });
    expect(html).toContain('data-morph-key="imp:files"');
    expect(html).toMatch(/<input type="file" multiple accept="\.md,\.markdown,\.zip" data-imp-file hidden/);
    expect(html).toContain('data-imp-drop data-over="0"');
    expect(html).toContain("Up to 500 files or 50 MB");
    expect(html).toContain("2.3 MB · 5 files inside");
    expect(html).toContain("Reading…");
    expect(html).toContain("Not a Markdown file.");
    expect(html).toMatch(/data-act="impRemove" data-arg="1" class="cnpy-iconbtn" aria-label="Remove handbook.zip"/);
    // A file still being read keeps "Check the files" off.
    expect(html).not.toMatch(/data-act="impStep"[^>]*data-arg="preview"/);
    expect(wiz({ step: "files", picks: [zipPick] })).toMatch(/data-act="impStep" data-arg="preview"/);
  });

  it("Preview: the shared planner's pages, conflicts and skipped files, in the design's words", () => {
    const u = { step: "preview" as const, picks: [zipPick], files: FILES, links: { total: 5, inImport: 3, existing: 1, unmatched: 1, imagesUsed: 1 } };
    const html = wiz(u);
    expect(html).toContain('data-morph-key="imp:preview"');
    expect(html).toContain("From <strong");
    expect(html).toContain("handbook.zip");
    // Pages: the folder page (README is its body), its folder page Onboarding, and the two files in it.
    for (const t of ["Engineering handbook", "Onboarding", "Your first week", "Local setup"]) expect(html).toContain(`<span class="cnpy-imp-pt">${t}</span>`);
    // "Local setup" is already in the space: a conflict, a New version by default, flagged and tinted.
    expect(html).toContain("Already in Engineering");
    expect(html).toContain("Already at Getting started › Local setup");
    expect(html).toContain('class="cnpy-imp-prow is-conflict"');
    expect(html).toContain(">New version</span>");
    expect(html).toMatch(/data-seg="imp-all"/);
    expect(html).toMatch(/data-act="impChoice" data-arg="skip:handbook\/onboarding\/local-setup\.md"/);
    // Won't be imported: the .sketch, with the design's reason.
    expect(html).toContain("handbook/design/logo.sketch");
    expect(html).toContain("Not a Markdown file");
    // Images and links, said in words.
    expect(html).toContain("1 image is uploaded with the pages that use them.");
    expect(html).toContain("5 links: 3 point to pages in this import, 1 to a page already in Trov, and 1 to a file that isn&#39;t in the zip. That one stays as plain text.");
    // The footer: four pages (three new, one new version), the button that starts the run.
    expect(html).toMatch(/data-act="impStart"[^>]*>Add 4 pages to Review<\/button>/);
    expect(html).toContain("Pages go to Review first. Nothing is live until someone approves it.");
  });

  it("Preview: Skip strikes the page and drops it from the count; Rename shows its field, prefilled", () => {
    const base = { step: "preview" as const, picks: [zipPick], files: FILES };
    const skip = wiz({ ...base, choices: { "handbook/onboarding/local-setup.md": "skip" } });
    expect(skip).toContain('class="cnpy-imp-prow is-conflict is-skip"');
    expect(skip).toContain(">Skipped</span>");
    expect(skip).toMatch(/>Add 3 pages to Review</);
    const rename = wiz({ ...base, choices: { "handbook/onboarding/local-setup.md": "rename" } });
    expect(rename).toContain(">Renamed</span>");
    expect(rename).toMatch(/data-act="impRename" data-arg="handbook\/onboarding\/local-setup\.md" data-field="imp-rn:handbook\/onboarding\/local-setup\.md" value="Local setup \(handbook\)"/);
    expect(rename).toContain('<span class="cnpy-imp-pt">Local setup (handbook)</span>');
    // The run is sent the same choices, a rename with its title.
    const plan = importPlanFor(ui(base), PAGES);
    expect(importChoices(ui({ choices: { "handbook/onboarding/local-setup.md": "rename" } }), plan, "handbook.zip"))
      .toEqual({ "handbook/onboarding/local-setup.md": { choice: "rename", title: "Local setup (handbook)" } });
  });

  it("Preview: a refused plan says why and keeps the button off; a refused start is an alert", () => {
    const empty = wiz({ step: "preview", picks: [zipPick], files: [{ path: "a.png", size: 3, kind: "image" }] });
    expect(empty).toContain("There&#39;s no Markdown file to import here.");
    expect(empty).not.toContain('data-act="impStart"');
    const refused = wiz({ step: "preview", picks: [zipPick], files: FILES, error: "Another import is running in this organization." });
    expect(refused).toMatch(/role="alert"[^>]*>.*Another import is running/s);
    // The space's pages not in yet: the Preview's skeleton, never a plan without the conflicts.
    expect(wiz({ step: "preview", picks: [zipPick], files: FILES }, { pages: null })).toContain('data-skel="imp-preview"');
  });

  const driver = (over: Partial<ImportDriverView> = {}): ImportDriverView => ({
    id: 9, phase: "pages", source: "handbook.zip", space: "engineering", spaceName: "Engineering", pages: 24, pagesDone: 12, images: 14, imagesDone: 14,
    current: "handbook/onboarding/first-week.md", error: null, run: null, ...over,
  });

  it("Import: the progress card — the percent, pages and images, the current file, leaving is fine, Cancel import", () => {
    const html = wiz({ step: "run", run: driver() });
    expect(html).toContain('data-morph-key="imp:progress"');
    expect(html).toContain(">68%</span>");
    expect(html).toContain("12 of 24 pages");
    expect(html).toContain("14 of 14 images");
    expect(html).toContain("Adding handbook/onboarding/first-week.md");
    expect(html).toContain("You can leave this page. The import keeps going.");
    expect(html).toContain('data-act="impCancel"');
    expect(html).toContain('role="progressbar"');
    // A batch that did not get through: Retry, which resends it.
    const stalled = wiz({ step: "run", run: driver({ phase: "stalled", error: "The connection dropped." }) });
    expect(stalled).toContain('data-act="impRetry"');
    expect(stalled).toMatch(/role="alert"/);
  });

  it("Import: the done card — what went to Review, what was skipped, and the three ways on", () => {
    const run = { counts: { pages: 24, new_pages: 21, versions: 3, images: 14, skipped_files: 3, skipped_pages: 0, staged: 24, staged_new: 21, staged_versions: 3, unchanged: 0, failed: 0, images_uploaded: 14 } } as ImportRunView;
    const html = wiz({ step: "run", run: driver({ phase: "done", run }) });
    expect(html).toContain('data-morph-key="imp:done"');
    expect(html).toContain("24 pages added to Review");
    expect(html).toContain("Nothing is live yet. Once someone approves them in Review, they show up in Engineering. 3 files were skipped.");
    expect(html).toContain("new versions of existing pages");
    for (const act of ["goReview", "goImports", "impMore"]) expect(html).toContain(`data-act="${act}"`);
    // Every step is done once the run is.
    expect(html).not.toContain('data-s="now"');
  });

  it("words: the links and images sentences say only the parts that are there", () => {
    expect(linkWords({ total: 0, inImport: 0, existing: 0, unmatched: 0, imagesUsed: 0 }, true)).toBe("No page links to another.");
    expect(linkWords({ total: 38, inImport: 31, existing: 5, unmatched: 2, imagesUsed: 0 }, true))
      .toBe("38 links: 31 point to pages in this import, 5 to pages already in Trov, and 2 to files that aren't in the zip. Those 2 stay as plain text.");
    expect(imageWords(14, 14)).toBe("14 images are uploaded with the pages that use them.");
    expect(imageWords(0, 0)).toBe("There are no images.");
    expect(imageWords(3, 2)).toBe("2 images are uploaded with the pages that use them. 1 image no page uses is left out.");
  });

  it("a refusal is a sentence that says what to do (the preview says nothing is changed)", () => {
    expect(importErrorText(new OrgApiError(409, "import_running", null, null), "x")).toContain("Another import is running");
    expect(importErrorText(new PreviewBlocked(), "x")).toContain("This is a preview: nothing is changed.");
    expect(importErrorText(new TypeError("fetch failed"), "Couldn't start the import.")).toBe("Couldn't start the import. Check your connection and try again.");
  });
});

// ── Imports history ──────────────────────────────────────────────────────────

const run = (id: number, over: Partial<ImportRunView> = {}): ImportRunView => ({
  id, status: "done", space: "engineering", space_name: "Engineering", parent_slug: null, parent_path: [], file_name: `run-${id}.zip`, file_size: 2_400_000, file_count: 44,
  by: "andres", started_at: new Date(Date.now() - 2 * 3_600_000).toISOString(), updated_at: T0, ended_at: T0, cancelled: false, failures: [], waiting: 0,
  counts: { pages: 24, new_pages: 21, versions: 3, images: 0, skipped_files: 0, skipped_pages: 0, staged: 24, staged_new: 21, staged_versions: 3, unchanged: 0, failed: 0, images_uploaded: 0 },
  ...over,
});
const hist = (runs: ImportRunView[], over: Partial<ImportsHistoryProps> = {}, u: Partial<ImportUi> = {}): string =>
  importsHistoryView({ runs: { status: "ok", data: runs }, ui: ui(u), persons: [{ handle: "andres", name: "Andres L.", color: "moss", avatar_url: null, role: null } as never], me: "andres", spaces: [ENG], driver: null, ...over });

describe("Imports history (`#imports`)", () => {
  it("keeps its column header in every state: six skeleton rows while it is read, the empty layout once it answers none", () => {
    const loading = importsHistoryView({ runs: { status: "loading", data: [] }, ui: ui(), persons: [], me: null, spaces: [], driver: null });
    expect(loading).toContain('data-skel="imports"');
    expect((loading.match(/class="cnpy-imph-row" style/g) ?? []).length).toBe(6);
    expect(loading).toContain("<div>File</div><div>Into</div><div>Status</div><div>Pages</div><div>Run by</div><div>When</div>");
    expect(loading).not.toContain("cnpy-seg-n");
    const empty = hist([]);
    expect(empty).toContain('data-empty="imports"');
    expect(empty).toContain("No imports yet");
    expect(empty).toContain("<div>File</div>");
  });

  it("each run's status is a mark, never a pill, and the filter counts Done with skipped files as Done", () => {
    const html = hist([run(1, { status: "running", counts: { ...run(1).counts, staged: 12, pages: 40 } }), run(2, { status: "partial" }), run(3), run(4, { status: "failed", counts: { ...run(4).counts, staged: 0 } }), run(5, { status: "abandoned", cancelled: true })]);
    for (const m of ["In progress", "Done with skipped files", "Done", "Failed", "Cancelled"]) expect(html).toContain(`${m}</span>`);
    expect(html).not.toMatch(/text-transform:uppercase/);
    expect(html).toMatch(/>All<span class="cnpy-seg-n">5<\/span>/);
    expect(html).toMatch(/>In progress<span class="cnpy-seg-n">1<\/span>/);
    expect(html).toMatch(/>Done<span class="cnpy-seg-n">2<\/span>/);
    expect(html).toMatch(/>Failed<span class="cnpy-seg-n">1<\/span>/);
    expect(html).toContain(">12 of 40</div>");
    expect(html).toContain(">None</div>");
    expect(html).toContain("2.3 MB · 44 files");
    expect(html).toContain("Engineering");
    // Only the filter's runs are listed.
    expect(hist([run(1, { status: "failed" }), run(2)], {}, { filter: "failed" })).not.toContain("run-2.zip");
    expect(IMPORT_MARK.partial.word).toBe("Done with skipped files");
    expect(importRunMark("failed")).toContain("<path d=\"M5 .3 9.7 5 5 9.7.3 5Z\"");   // the red diamond
  });

  it("one row opens at a time: a skipped run lists its files with their reasons; a running one offers its starter Cancel", () => {
    const partial = run(2, { status: "partial", failures: [{ path: "design/logo.sketch", code: "not_markdown" }, { path: "notes/x.md", code: "changed" }] });
    const html = hist([partial, run(3)], {}, { open: 2 });
    expect(html).toContain('class="cnpy-imph-item is-open" data-morph-key="imph:2"');
    expect(html).toContain("24 pages went to Review. 2 files were skipped:");
    expect(html).toContain("Not a Markdown file");
    expect(html).toContain("The file changed after it was checked");
    expect(html).toMatch(/data-morph-key="imph:3"[\s\S]*?class="cnpy-imph-detail" hidden><\/div>/);
    const running = run(1, { status: "running" });
    expect(hist([running], {}, { open: 1 })).toContain('data-act="impHistCancel" data-arg="1"');
    expect(hist([running], { me: "priya" }, { open: 1 })).not.toContain("impHistCancel");
    // Owner ruling IH12: an admin may stop someone else's run (the server allows it), so the button shows.
    expect(hist([running], { me: "priya", admin: true }, { open: 1 })).toContain('data-act="impHistCancel" data-arg="1"');
    expect(hist([run(4, { status: "failed", counts: { ...run(4).counts, staged: 0 } })], {}, { open: 4 })).toContain('data-act="impTryAgain" data-arg="engineering"');
  });

  it("When: relative within a week, a date after", () => {
    const now = Date.parse("2026-10-17T12:00:00Z");
    expect(runWhen("2026-10-17T10:00:00Z", now)).toBe("2 hours ago");
    expect(runWhen("2026-10-16T09:00:00Z", now)).toBe("Yesterday");
    expect(runWhen("2026-10-02T09:00:00Z", now)).toBe("Oct 2");
  });
});

// ── Review, grouped by import ────────────────────────────────────────────────

const item = (id: string, title: string, over: Partial<ReviewItem> = {}): ReviewItem => ({
  id, kind: "proposal", eyebrow: "PROPOSAL · ENGINEERING / REFERENCE", title, summary: "", agent: "andres", agentInitials: "AN", time: "1h ago", diff: [], ...over,
});
// The queue lists newest first; the import staged the parent first, so its pages arrive child first.
const imported = [
  item("doc:first-week@1", "Your first week", { importId: 7, importFile: "handbook.zip", importBy: "andres", importAt: T0, importPath: "handbook/onboarding/first-week.md", slug: "first-week", parentSlug: "handbook", space: "engineering", isNew: true }),
  item("doc:handbook@1", "Engineering handbook", { importId: 7, importFile: "handbook.zip", importBy: "andres", importAt: T0, importPath: "handbook/README.md", slug: "handbook", parentSlug: null, space: "engineering", isNew: true }),
];
const agent = item("doc:rate-limits@3", "Rate limits");
const rv = (over: Partial<ReviewProps> = {}): ReviewProps => ({ items: [...imported, agent], filter: "all", selectedId: null, diffView: "unified", spaceNames: { engineering: "Engineering" }, ...over });

describe("Review — an import's pages are one group", () => {
  it("groups by import, in the import's tree order with each page's depth", () => {
    const g = importGroups(rv().items).get(7)!;
    expect(g.items.map((it) => it.title)).toEqual(["Engineering handbook", "Your first week"]);
    expect(g.depth).toEqual({ "doc:handbook@1": 0, "doc:first-week@1": 1 });
  });

  it("is one keyed card with the design's header and actions; the agent's proposal stays a card of its own", () => {
    const html = reviewView(rv());
    expect(html).toContain('data-morph-key="rvg:7"');
    expect(html).toContain("Import from handbook.zip");
    expect(html).toContain("2 pages · into Engineering · by andres");
    expect(html).toMatch(/data-act="reviewGroupToggle" data-arg="7"[^>]*aria-expanded="false"/);
    expect(html).toContain("Review one by one");
    expect(html).toMatch(/data-act="reviewGroupApprove" data-arg="7"[^>]*>Approve all 2</);
    expect(html).toContain('data-act="reviewGroupReject" data-arg="7"');
    expect(html).toContain('data-morph-key="rv:doc:rate-limits@3"');
    // The agent's proposal is the default selection; an import's page is opened from its group by hand.
    expect(html).toContain('data-morph-key="rvd:doc:rate-limits@3"');
    expect(html).toMatch(/>Imports<span class="cnpy-seg-n">2<\/span>/);
    expect(html).toMatch(/>Written by agents<span class="cnpy-seg-n">1<\/span>/);
  });

  it("opened, its pages are rows indented by depth; a page picked shows Page i of N, the arrows and where it came from", () => {
    const html = reviewView(rv({ groupsOpen: { 7: true }, selectedId: "doc:first-week@1", groupTotals: { 7: 24 } }));
    expect(html).toContain("Hide pages");
    expect(html).toMatch(/data-morph-key="rvp:doc:handbook@1"[\s\S]*?padding-left:16px/);
    expect(html).toMatch(/data-arg="doc:first-week@1" class="cnpy-rvg-pg" aria-current="true" style="padding-left:32px"/);
    expect(html).toContain("22 of 24 reviewed");
    expect(html).toContain(">Approve 2 left<");
    expect(html).toContain("Page 24 of 24 · handbook.zip");
    expect(html).toMatch(/aria-label="Previous page"/);
    expect(html).toContain("from handbook/onboarding/first-week.md");
    expect(html).toContain(">New page</span>");
  });

  it("decided whole, the card wears the verdict and leaves by the queue's one exit", () => {
    const html = reviewView(rv({ leaving: { "doc:first-week@1": "promoted", "doc:handbook@1": "promoted" } }));
    expect(html).toMatch(/data-morph-key="rvg:7" data-verdict="promoted" inert/);
    expect(html).toMatch(/>All<span class="cnpy-seg-n">1<\/span>/);
  });

  it("with groups waiting and nothing picked, the detail says how to start", () => {
    const html = reviewView(rv({ items: imported }));
    expect(html).toContain("Open a group and pick a page to read it here. Or approve a whole group at once.");
  });

  it("Reject all asks first, in the design's words, with a red button", () => {
    const p = (slug: string, version: number) => ({
      slug, version, title: slug, section: "reference", space: "engineering", summary: null, author: "andres", confidence: "high", status: "staged", change_kind: "new" as const,
      low_confidence: 0, base_version: null, current_version: 0, created_at: T0, stagedBody: "x", promotedBody: "", parent_slug: null,
      import_id: 7, import_path: `${slug}.md`, import_file_name: "handbook.zip", import_by: "andres", import_at: T0,
    });
    const s: AppState = { ...initialState(), view: "app", screen: "review", proposals: { status: "ok", data: [p("a", 1), p("b", 1)] }, draftAdrs: { status: "ok", data: [] },
      library: { status: "ok", data: LIB }, reviewGroupReject: { id: 7, busy: false } };
    const html = render(s);
    expect(html).toContain("Reject 2 pages from handbook.zip?");
    expect(html).toContain("They won&#39;t be added to Engineering. The import stays in Imports, so you can run it again later.");
    expect(html).toMatch(/data-act="reviewGroupRejectGo" data-arg="7"[^>]*>Reject 2 pages</);
  });
});

// ── the sidebar ──────────────────────────────────────────────────────────────

const sideProps = (over: Partial<SidebarProps> = {}): SidebarProps => ({
  screen: "mywork", collapsed: false, navOpen: { ...NAV_CLOSED, library: true }, qView: "table", roadmapTab: "timeline", librarySpace: null,
  spaces: [{ key: "engineering", label: "Engineering", icon: "braces", color: "#525cc3" }], spacesLoaded: true, canAdmin: false,
  counts: { review: 0, maintenance: 0, tickets: 0, handoffs: 0, prompts: 0 }, me: null, displayName: "", logo: "<svg></svg>", ...over,
});
const tree = (html: string): string => (html.match(/<\/?[a-z][a-z0-9]*/gi) ?? []).join(" ");

describe("the sidebar's Imports row and Import action", () => {
  it("are always emitted: a running import, the Imports screen and the import wizard change attributes only", () => {
    const base = tree(sidebarView(sideProps()));
    for (const v of [{ counts: { ...sideProps().counts, imports: 1 } }, { screen: "imports" }, { screen: "import" }, { screen: "space", librarySpace: "engineering" }] as Partial<SidebarProps>[]) {
      expect(tree(sidebarView(sideProps(v))), JSON.stringify(v)).toBe(base);
    }
  });
  it("the badge is the accent count of imports in progress, hidden at 0; the row lights on Imports history", () => {
    expect(sidebarView(sideProps())).toContain('<span class="cnpy-sub-badge" data-n="0"');
    const on = sidebarView(sideProps({ screen: "imports", counts: { ...sideProps().counts, imports: 1 } }));
    expect(on).toContain('<button data-act="goImports" class="cnpy-sub-i cnpy-sub-imp is-active" aria-current="page"');
    expect(on).toContain('data-n="1" aria-label="1 in progress">1</span>');
    expect(on).toContain('class="cnpy-navrow n-library is-active"');
    expect(navKeyOf("import")).toBe("library");
    expect(navKeyOf("imports")).toBe("library");
  });
  it("Import is everyone's and presets the space on screen; a space row is a drop target", () => {
    expect(sidebarView(sideProps())).toMatch(/data-act="goImport" data-arg="" class="cnpy-sub-i cnpy-sub-new cnpy-sub-impgo"/);
    expect(sidebarView(sideProps({ screen: "docs", librarySpace: "engineering" }))).toMatch(/data-act="goImport" data-arg="engineering"/);
    expect(sidebarView(sideProps())).toContain('data-drop-space="engineering"');
  });
  it("render() counts the run this tab drives even before the badges read says so", () => {
    const s: AppState = { ...initialState(), view: "app", imp: { ...initialImportUi(), run: { id: 1, phase: "pages", source: "a.zip", space: "e", spaceName: "E", pages: 1, pagesDone: 0, images: 0, imagesDone: 0, current: null, error: null, run: null } } };
    expect(render(s)).toContain('class="cnpy-sub-badge" data-n="1"');
  });
});

// ── a space's home and Library home offer Import ─────────────────────────────

describe("Import from the Library's own screens", () => {
  it("Library home has Import for everyone; a space's home has it beside New page, and in its empty layout", () => {
    const lib: AppState = { ...initialState(), view: "app", screen: "library", library: { status: "ok", data: LIB } };
    expect(render(lib)).toMatch(/data-act="goImport" data-arg="" class="cnpy-outlinebtn"/);
    const home: AppState = { ...initialState(), view: "app", screen: "space", spaceSlug: "engineering", library: { status: "ok", data: LIB },
      spaceHome: { status: "ok", data: { space: ENG, pages: [], can_edit: false, can_admin: false } } };
    const html = render(home);
    expect(html).toContain("Write the first page, or import Markdown files you already have. Imported pages wait in Review until someone approves them.");
    // The header's, the empty layout's, and the sidebar's Import (the space on screen preset).
    expect((html.match(/data-act="goImport" data-arg="engineering"/g) ?? []).length).toBe(3);
  });
});

// ── drop to import ───────────────────────────────────────────────────────────

describe("drop to import (import-drop.ts)", () => {
  const dt = (types: string[]) => ({ types: ["Files"], items: types.map((type) => ({ kind: "file", type })) as unknown as DataTransferItemList });
  it("a drag is files, and is bad when one of them is a type that cannot be Markdown or a zip", () => {
    expect(dragFiles(null)).toBeNull();
    expect(dragFiles({ types: ["text/plain"], items: [] as unknown as DataTransferItemList })).toBeNull();
    expect(dragFiles(dt(["text/markdown", "application/zip", ""]))).toEqual({ n: 3, bad: false });
    expect(dragFiles(dt(["application/pdf"]))).toEqual({ n: 1, bad: true });
    for (const t of ["", "text/markdown", "text/x-markdown", "text/plain", "application/zip", "application/x-zip-compressed", "application/x-zip", "application/octet-stream"]) expect(DROP_TYPES.has(t)).toBe(true);
  });
  it("a drop is taken whole only when every file is .md, .markdown or .zip", () => {
    const f = (name: string) => ({ name }) as File;
    expect(splitDropped([f("a.md"), f("b.zip")]).bad).toBeNull();
    expect(splitDropped([f("a.md"), f("q3-report.pdf")]).bad?.name).toBe("q3-report.pdf");
    expect(dropTitle("Product")).toBe("Drop to import into Product");
    expect(dropSub(1)).toBe("1 file. You can check everything before it goes to Review.");
    expect(dropSub(3)).toBe("3 Markdown files. You can check everything before it goes to Review.");
  });
});

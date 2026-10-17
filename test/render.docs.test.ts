/**
 * The doc page and the docs pane (docs/architecture/docs-library.md › The page tree, The doc page): `#doc/<slug>` beside
 * its space's page tree — the pane's rows (indent, guides, chevrons, status shapes, the hover actions and the "…" menu),
 * the breadcrumb, the status mark and banners, the body's `[[slug]]` links, the rail (On this page, Owner, Last edited
 * by, Version, Imported from, Linked from) and "Pages under ‹Title›" — plus the drag's pure rules (hit zones, hints,
 * the keyboard's moves, Undo's way back). New page has its own file (render.newdoc.test.ts).
 *
 * Pure (no D1 / Miniflare); assertions are HTML-string based. markdown is mocked (DOMPurify needs DOM globals): the
 * mock shows what reaches the renderer.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../web/src/markdown", () => ({
  renderMarkdownInline: (text: string) => text,
  renderMarkdown: (body: string) => `<div class="mock-live-md">${body}</div>`,
}));

import { render, initialState, spaceName } from "../web/src/render";
import { docsPane, expandedSet } from "../web/src/docs-pane";
import { linkedBody, brokenLinkTip } from "../web/src/doc-page";
import { dropHint, rowZone, treeKeyTarget } from "../web/src/tree-drag";
import { placeOf, moveRefusalText, createTreeController } from "../web/src/tree-actions";
import { setApiOrg } from "../web/src/api";
import { AUTHORITY_MARK } from "../web/src/marks";
import type { DocRow } from "@shared/rows";
import css from "../web/src/trov.css?raw";
import type { DocPageDTO, LibraryPageDTO, SpaceDTO } from "@shared/docs-core";

const T0 = "2026-10-10T00:00:00Z";
function doc(over: Partial<DocRow> = {}): DocRow {
  return { slug: "auth", section: "reference", title: "Authentication", body: "body", current_version: 3, updated_at: T0, updated_by: "jordan", space: "engineering", owner: "priya", parent_slug: "api", tree_rank: null, ...over } as DocRow;
}
const space = (slug: string, name: string, over: Partial<SpaceDTO> = {}): SpaceDTO => ({
  slug, name, icon: "braces", color: "#525cc3", description: "", sort_rank: 1024, created_at: T0, created_by: "system",
  archived: false, archived_at: null, owners: [], pages: 0, waiting: 0, ...over,
});
const SPACES = [space("engineering", "Engineering"), space("product", "Product", { icon: "compass", color: "#2f7d57" }), space("security", "Security", { icon: "shield", color: "#b4562c" })];
const pg = (slug: string, title: string, parent: string | null, rank: number | null, over: Partial<LibraryPageDTO> = {}): LibraryPageDTO =>
  ({ slug, title, space: "engineering", section: "reference", parent_slug: parent, tree_rank: rank, path: [], authority: "live", current_version: 1, updated_at: T0, updated_by: "jordan", owner: "priya", ...over });
/** Engineering › Architecture › API › Authentication (the design's sample), plus a long title and two non-live pages. */
const PAGES = [
  pg("start", "Getting started", null, 1024),
  pg("arch", "Architecture", null, 2048),
  pg("api", "API", "arch", 1024),
  pg("auth", "Authentication", "api", 1024),
  pg("sso", "Single sign-on", "auth", 1024),
  pg("rate", "Rate limits", "api", 2048, { authority: "staged_pending" }),
  pg("first", "Your first change", "start", 1024, { authority: "unpromoted", current_version: 0 }),
  pg("long", "Checklist for the on-call engineer during a regional failover", null, 3072),
];
const PAGE: DocPageDTO = {
  authority: "live", parent_slug: "api",
  ancestors: [{ slug: "arch", title: "Architecture" }, { slug: "api", title: "API" }],
  children: [PAGES[4]],
  body: "Intro.\n\n## How sign-in works\n\nSee [[rate]] and [[gone|the old page]].\n\n### Sessions\n\n`[[in-code]]`\n",
  links: [{ slug: "rate", title: "Rate limits", space: "engineering", path: ["Architecture", "API"], authority: "staged_pending" }],
  broken_links: ["gone"],
  backlinks: [{ slug: "start", title: "Getting started", space: "engineering", path: [], authority: "live" }],
  info: { owner: "priya", edited_by: "jordan", edited_at: T0, version: 3, pending_version: null, imported_from: null },
};
const PERSONS = [
  { handle: "priya", name: "Priya Natarajan", color: "plum" as const, avatar_url: null, role: null },
  { handle: "jordan", name: "Jordan Lee", color: "moss" as const, avatar_url: null, role: null },
];

function docState(over: Partial<ReturnType<typeof initialState>> = {}): ReturnType<typeof initialState> {
  const s = initialState();
  return {
    ...s, view: "app", screen: "docs", docSlug: "auth",
    me: { handle: "alice", name: "Alice", avatar_url: null, color: "moss", identities: [], orgs: [{ slug: "acme", name: "Acme", role: "member" as const }], superadmin: false, pending_invites: 0 },
    persons: { status: "ok", data: PERSONS as never },
    library: { status: "ok", data: { spaces: SPACES, archived: [], recent: [], waiting: 0, can_admin: false } },
    spaceHome: { status: "ok", data: { space: SPACES[0], pages: PAGES, can_edit: false, can_admin: false } },
    docDetail: { status: "ok", data: { doc: doc(), versions: [], page: PAGE } },
    ...over,
  };
}
const pane = (html: string) => html.slice(html.indexOf('<nav class="cnpy-dpane'), html.indexOf("</nav>", html.indexOf('<nav class="cnpy-dpane')));

describe("spaces — the org's own, from the Library read", () => {
  it("the sidebar's Library group lists every live space the read has, in its order — never a page", () => {
    const html = render(docState());
    const aside = html.slice(html.indexOf("<aside"), html.indexOf("</aside>"));
    expect([...aside.matchAll(/data-act="navSub" data-arg="library:([^"]+)"/g)].map((m) => m[1])).toEqual(["engineering", "product", "security"]);
    expect(aside).not.toContain("Authentication");
  });
  it("a space the read does not list is named by its slug, never guessed", () => {
    expect(spaceName({ library: { status: "ok", data: { spaces: [], archived: [], recent: [], waiting: 0, can_admin: false } } }, "ops")).toBe("Ops");
  });
});

describe("the docs pane", () => {
  it("draws the space's tree in order: indented rows, guides, chevrons, the active page and its ancestors open", () => {
    const html = pane(render(docState()));
    // The head row is the space (its home, and "+" for a page at its top level).
    expect(html).toContain('data-dtree-head="engineering"');
    expect(html).toContain('data-act="libOpenSpace" data-arg="engineering"');
    expect(html).toContain('data-act="libNewPage" data-arg="engineering" aria-label="New page"');
    expect(html).toMatch(/<span>Pages<\/span><span class="cnpy-dp-n"[^>]*>8<\/span>/);
    // Tree order; Architecture › API › Authentication open (above the active page), Getting started closed.
    const order = [...html.matchAll(/data-dtree="([^"]+)" data-depth="(\d)"/g)].map((m) => `${m[1]}:${m[2]}`);
    expect(order).toEqual(["start:0", "arch:0", "api:1", "auth:2", "sso:3", "rate:2", "long:0"]);
    expect(html).toContain('style="padding-left:34px;--dp-in:32px"');      // depth 2: 6 + 28; the tint starts at the indent
    expect(html.match(/class="cnpy-dp-guide"/g)?.length).toBe(1 + 2 + 3 + 2);
    expect(html).toMatch(/class="cnpy-dp-row cnpy-hitbox is-active"[^>]*data-dtree="auth"/);
    expect(html).toContain('data-act="openDoc" data-arg="auth" class="cnpy-hit" aria-label="Authentication" aria-current="page"');
    expect(html).toContain('class="cnpy-dp-chev is-open" data-act="treeToggle" data-arg="api"');
    expect(html).toContain('class="cnpy-dp-chev" data-act="treeToggle" data-arg="start" aria-expanded="false"');
  });
  it("a page that is not live has its shape and no word; a long title its tooltip; hover offers + and …", () => {
    const html = pane(render(docState()));
    expect(html).toMatch(/data-dtree="rate"[\s\S]*?class="cnpy-dp-st" role="img" aria-label="Change pending review"/);
    expect(html).not.toContain(">Change pending review<");
    expect(html).toContain('data-mtip="Checklist for the on-call engineer during a regional failover"');
    expect(html).not.toContain('data-mtip="Authentication"');
    expect(html).toContain('data-act="treeNew" data-arg="auth" aria-label="New page inside"');
    expect(html).toContain('data-act="treeMenu" data-arg="auth" aria-label="More"');
    expect(html).not.toContain('role="menu"');
  });
  it("the hidden + and … take no room: out of the flow, over the title's end, on the row's tint over the page", () => {
    const rule = (sel: string) => css.match(new RegExp(`(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`))?.[1] ?? "";
    const acts = rule(".cnpy-dp-acts");
    expect(acts).toContain("position:absolute");
    expect(acts).toContain("right:6px");
    expect(acts).not.toContain("flex:none");                                          // nothing reserved in the row
    expect(acts).toContain("opacity:0");
    expect(acts).toMatch(/background:linear-gradient\(var\(--dp-tint, transparent\), var\(--dp-tint, transparent\)\), var\(--bg\)/);   // opaque: no text through
    expect(acts).toContain("mask-image:linear-gradient(to right, transparent, #000 12px)");
    // left of the status shape (8px + the row's 4px gap), which keeps its place in the flow
    expect(rule(".cnpy-dp-row:has(> .cnpy-dp-st) .cnpy-dp-acts")).toContain("right:18px");
    expect(rule(".cnpy-dp-st")).toContain("flex:none");
    expect(css).toContain(".cnpy-dp-row:hover .cnpy-dp-acts, .cnpy-dp-row:focus-within .cnpy-dp-acts, .cnpy-dp-row.has-menu .cnpy-dp-acts { opacity:1; }");
    // the tint is one value per state, drawn by ::before from the row's indent (d967d8e1) and reused by the actions
    expect(rule(".cnpy-dp-row::before")).toContain("left:var(--dp-in, 0px)");
    expect(rule(".cnpy-dp-row::before")).toContain("background:var(--dp-tint, transparent)");
    expect(rule(".cnpy-dp-row:not(.is-shape):hover")).toContain("--dp-tint:var(--hover)");
    expect(rule(".cnpy-dp-row.is-active, .cnpy-dp-row.is-active:hover")).toContain("--dp-tint:var(--accent-soft)");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.cnpy-dp-chev, \.cnpy-dp-acts \{ transition:none; \} \}/);
    // each row isolates its own stacking (the tint under its content), so the row whose "…" menu is open must sit
    // over the rows after it, or they paint over its menu (e2e HL5)
    expect(css).toContain(".cnpy-dp-row { isolation:isolate; }");
    expect(rule(".cnpy-dp-row.has-menu")).toMatch(/z-index:[1-9]/);
    // the actions' mask clips whatever is drawn outside their box, so a focused + / … draws its ring INSIDE the
    // button (a negative offset), never the 1px-out ring that showed only as a bar on its left (e2e HL5)
    expect(rule(".cnpy-dp-acts .cnpy-dp-act:focus-visible")).toMatch(/outline-offset:-\d+px/);
    // the shape is the row's own child, right after the title (the :has selector's premise)
    const html = pane(render(docState()));
    expect(html).toMatch(/<span class="cnpy-dp-t">Rate limits<\/span><span class="cnpy-dp-st"/);
  });
  it("the … menu: Copy link, and Move to the top level for a page that is not there", () => {
    const html = pane(render(docState({ treeMenu: "api" })));
    expect(html).toContain('data-act="treeCopyLink" data-arg="api"');
    expect(html).toContain('data-act="treeMoveTop" data-arg="api"');
    expect(pane(render(docState({ treeMenu: "arch" })))).not.toContain("treeMoveTop");
  });
  it("owner ruling DP8: the … menu is Copy link, Move to the top level, New page inside — no Rename", () => {
    const menu = pane(render(docState({ treeMenu: "api" }))).match(/<div class="cnpy-dp-menu"[\s\S]*?<\/div>/)![0];
    const items = [...menu.matchAll(/role="menuitem" data-act="(\w+)"[^>]*>([^<]*)</g)].map((m) => `${m[1]}:${m[2]}`);
    expect(items).toEqual(["treeCopyLink:Copy link", "treeMoveTop:Move to the top level", "treeNew:New page inside"]);
    expect(menu).not.toMatch(/Rename/);
  });
  it("the person's choice wins over the open-above-the-page default", () => {
    expect(expandedSet(PAGES, "auth", {}).has("api")).toBe(true);
    expect(expandedSet(PAGES, "auth", { api: false }).has("api")).toBe(false);
    expect(expandedSet(PAGES, null, { start: true })).toEqual(new Set(["start"]));
  });
  it("loading is nine skeleton rows; an empty space the hollow tree", () => {
    const loading = docsPane({ space: SPACES[0], pages: null, activeSlug: null, headActive: false, open: {}, menu: null });
    expect(loading).toContain('data-skel="docs-tree"');
    expect(loading.match(/class="cnpy-dp-row is-shape"/g)?.length).toBe(9);
    const empty = docsPane({ space: SPACES[0], pages: [], activeSlug: null, headActive: true, open: {}, menu: null });
    expect(empty).toContain('data-empty="docs-tree"');
    expect(empty).toMatch(/<span class="cnpy-dp-n"[^>]*>0<\/span>/);
    expect(empty).toContain("cnpy-dp-head cnpy-hitbox is-active");
  });
  it("is the same element on a space's home, a doc page and New page (one page per space)", () => {
    const keyOf = (html: string) => /<main data-morph="([^"]+)"/.exec(html)?.[1];
    expect(keyOf(render(docState()))).toBe("lib:engineering");
    expect(keyOf(render(docState({ screen: "space", spaceSlug: "engineering" })))).toBe("lib:engineering");
    expect(render(docState({ screen: "space", spaceSlug: "engineering" }))).toContain('data-morph-key="dpane:engineering"');
  });
});

describe("the doc page", () => {
  it("the breadcrumb (space, ancestors, the page), the title, Live, and who wrote it", () => {
    const html = render(docState());
    expect(html).toMatch(/data-act="libOpenSpace" data-arg="engineering" class="cnpy-dpg-crumb">[\s\S]*?<span>Engineering<\/span>/);
    expect(html).toContain('data-act="openDoc" data-arg="arch" class="cnpy-dpg-crumb"><span>Architecture</span>');
    expect(html).toContain('<span class="cnpy-dpg-here" aria-current="page">Authentication</span>');
    expect(html).toContain('<h1 class="cnpy-dpg-title">Authentication</h1>');
    expect(html).toContain('data-mtip="This is the version everyone reads."');
    expect(html).toContain("by Jordan</span>");
    // Header: "Library › Engineering".
    expect(html).toMatch(/›<\/span><span[^>]*>Engineering<\/span>/);
  });
  it("a change pending review, and a page never approved, each carry their banner", () => {
    const pending = render(docState({ docDetail: { status: "ok", data: { doc: doc(), versions: [], page: { ...PAGE, authority: "staged_pending", info: { ...PAGE.info, pending_version: 4 } } } } }));
    expect(pending).toContain("You're reading the <strong");
    expect(pending).toContain("Version 4 is waiting for review");
    expect(pending).toContain('data-act="goReview"');
    const staged = render(docState({ docDetail: { status: "ok", data: { doc: doc({ current_version: 0 }), versions: [], page: { ...PAGE, authority: "unpromoted", backlinks: [], info: { ...PAGE.info, version: 0, pending_version: 1, imported_from: { path: "api/authentication.md", file_name: "api-reference.zip" } } } } } }));
    expect(staged).toContain("This page isn't live yet. It was imported");
    expect(staged).toContain("api/authentication.md");
    expect(staged).toContain("in api-reference.zip");
    expect(staged).toContain("Not approved yet");
    expect(staged).toContain("Links from other pages show up once this one is approved.");
    // A page never approved lists no children (its children wait under it in the tree).
    expect(staged).not.toContain("Pages under Authentication");
  });
  it("owner rulings DP14 / DOC13: an agent's never-approved page has its own banner, and nothing says only reviewers see it", () => {
    const agent = render(docState({ docDetail: { status: "ok", data: { doc: doc({ current_version: 0 }), versions: [], page: { ...PAGE, authority: "unpromoted", backlinks: [], info: { ...PAGE.info, version: 0, pending_version: 1, imported_from: null } } } } }));
    expect(agent).toContain("This page isn't live yet. It is waiting for someone to approve it.</div>");
    const imported = render(docState({ docDetail: { status: "ok", data: { doc: doc({ current_version: 0 }), versions: [], page: { ...PAGE, authority: "unpromoted", backlinks: [], info: { ...PAGE.info, version: 0, pending_version: 1, imported_from: { path: "a.md", file_name: "a.zip" } } } } } }));
    expect(imported).toContain("This page isn't live yet. It was imported and is waiting for someone to approve it.</div>");
    // Every member may review (CLAUDE.md invariant 2): no banner, mark or tooltip says otherwise.
    for (const html of [agent, imported]) expect(html).not.toContain("Only people who can review");
    expect(AUTHORITY_MARK.unpromoted!.hint).not.toContain("Only people who can review");
  });
  it("the rail: On this page with Pages under, Owner, Last edited by, Version, Linked from", () => {
    const html = render(docState());
    expect(html).toContain('data-act="docToc" data-arg="how-sign-in-works" class="cnpy-toc-i" data-toc="how-sign-in-works">How sign-in works');
    expect(html).toContain('class="cnpy-toc-i is-sub" data-toc="sessions"');
    expect(html).toContain('data-toc="pages-under">Pages under Authentication');
    expect(html).toMatch(/Owner<\/div><div class="cnpy-rail-v"><button data-act="openPerson" data-arg="priya"/);
    expect(html).toContain("Priya Natarajan");
    expect(html).toContain("<span>Version 3</span>");
    expect(html).toContain('data-act="openDoc" data-arg="start" class="cnpy-rail-link"><span class="cnpy-rail-lt">Getting started</span><span class="cnpy-rail-lp">Top level</span>');
    expect(html).toContain('<h2 id="pages-under" class="cnpy-dpg-kh">Pages under Authentication</h2>');
    expect(html).toContain('data-act="openDoc" data-arg="sso"');
  });
  it("History lists the versions newest first; a rejected one is muted with its Rejected mark (owner ruling DOC2)", () => {
    const v = (version: number, status: "promoted" | "staged" | "rejected", by = "jordan") => ({ id: version, slug: "auth", version, summary: `v${version} words`, status, confidence: null, created_at: T0, created_by: by, content_hash: null, base_version: null, change_kind: null, low_confidence: 0 });
    const html = render(docState({ showHistory: true, docDetail: { status: "ok", data: { doc: doc(), versions: [v(1, "promoted", "priya"), v(2, "rejected"), v(3, "promoted"), v(4, "staged")], page: PAGE } } }));
    const rows = [...html.matchAll(/class="cnpy-dpg-hv">v(\d)</g)].map((m) => m[1]);
    expect(rows).toEqual(["4", "3", "2", "1"]);
    expect(html).toMatch(/class="cnpy-dpg-hrow is-rejected">\s*<span class="cnpy-dpg-hv">v2</);
    expect(html).toContain(">Rejected</span>");
    expect(html).toContain('aria-pressed="true"');
  });
  it("[[slug]] links become page links; one to no page is flagged text; code is left as written", () => {
    const out = linkedBody(PAGE.body, PAGE);
    expect(out).toContain('<a class="cnpy-doclink" href="#doc/rate" data-mtip="Architecture › API › Rate limits">Rate limits</a>');
    expect(out).toContain('<span class="cnpy-doclink is-broken" data-mtip="');
    expect(out).toContain(">the old page</span>");
    expect(brokenLinkTip("gone")).toContain("“gone”");
    expect(out).toContain("`[[in-code]]`");
    // What reaches the renderer is the linked body.
    expect(render(docState())).toContain('href="#doc/rate"');
  });
  it("a doc that is not there says so; one being read is the page's skeleton", () => {
    expect(render(docState({ docDetail: { status: "ok", data: null } }))).toContain("There is no page here.");
    const loading = render(docState({ docSlug: "x", docDetail: { status: "loading", data: null } }));
    expect(loading).toContain('data-skel="doc"');
  });
});

describe("a move reads the open doc page again (tree-actions.ts; e2e Batch D, the open bug Batch C recorded)", () => {
  it("after the Worker takes a move — and after its Undo — the open page is read again, so its \"Pages under\" and breadcrumb follow", async () => {
    const places = [{ slug: "rate", parent_slug: "api", tree_rank: 512 }];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, places }), { status: 200, headers: { "content-type": "application/json" } })));
    vi.stubGlobal("CSS", { escape: (s: string) => s });
    setApiOrg("acme");
    try {
      const state = docState({ docSlug: "api" });
      const changed: number[] = [];
      const ctl = createTreeController({
        state, mount: {} as HTMLElement, rerender: () => {}, flash: () => {}, unauth: () => {}, flashNext: () => {}, newPage: () => {},
        reducedMotion: () => true, treeChanged: () => changed.push(1),
      });
      ctl.move("rate", { kind: "before", ref: "auth" });
      expect(changed).toHaveLength(0);                       // not before the Worker has it
      await new Promise((r) => setTimeout(r, 0));
      expect(changed).toHaveLength(1);
      ctl.act("treeUndo", "rate", null);
      await new Promise((r) => setTimeout(r, 0));
      expect(changed).toHaveLength(2);
    } finally {
      setApiOrg(null);
      vi.unstubAllGlobals();
    }
  });
});

describe("the drag's rules (tree-drag.ts, tree-actions.ts)", () => {
  it("hit zones: the top 30% of a row is before, the bottom 30% after, the middle into", () => {
    expect(rowZone(102, 100, 28)).toBe("before");
    expect(rowZone(114, 100, 28)).toBe("into");
    expect(rowZone(126, 100, 28)).toBe("after");
  });
  it("the ghost's hint says where the page goes", () => {
    const t = (s: string) => ({ api: "API", auth: "Authentication" } as Record<string, string>)[s] ?? s;
    expect(dropHint(null, t, "Engineering")).toBe("Drag onto a page to put it inside");
    expect(dropHint({ kind: "into", ref: "api" }, t, "Engineering")).toBe("Put inside API");
    expect(dropHint({ kind: "before", ref: "auth" }, t, "Engineering")).toBe("Move above Authentication");
    expect(dropHint({ kind: "after", ref: "auth" }, t, "Engineering")).toBe("Move below Authentication");
    expect(dropHint({ kind: "top" }, t, "Engineering")).toBe("Move to the top level of Engineering");
  });
  it("the keyboard: Alt+↑/↓ among siblings, Alt+→ into the page before, Alt+← out to the parent's level", () => {
    expect(treeKeyTarget(PAGES, "rate", "ArrowUp")).toEqual({ kind: "before", ref: "auth" });
    expect(treeKeyTarget(PAGES, "auth", "ArrowDown")).toEqual({ kind: "after", ref: "rate" });
    expect(treeKeyTarget(PAGES, "rate", "ArrowRight")).toEqual({ kind: "into", ref: "auth" });
    expect(treeKeyTarget(PAGES, "auth", "ArrowLeft")).toEqual({ kind: "after", ref: "api" });
    expect(treeKeyTarget(PAGES, "start", "ArrowUp")).toBeNull();
    expect(treeKeyTarget(PAGES, "start", "ArrowLeft")).toBeNull();
  });
  it("Undo's way back: before the next sibling, else after the previous one, else into the parent / the top", () => {
    expect(placeOf(PAGES, "auth")).toEqual({ kind: "before", ref: "rate" });
    expect(placeOf(PAGES, "rate")).toEqual({ kind: "after", ref: "auth" });
    expect(placeOf(PAGES, "sso")).toEqual({ kind: "into", ref: "auth" });
    expect(placeOf([PAGES[0]], "start")).toEqual({ kind: "top" });
  });
  it("a refusal is said in words", () => {
    expect(moveRefusalText("cycle")).toBe("A page can't go inside a page that is under it.");
    expect(moveRefusalText("too_deep")).toBe("Pages go at most 6 levels deep.");
    expect(moveRefusalText("weird")).toBe("Couldn't move the page. Try again.");
  });
});

describe("Archive page (0083_doc_archive): who sees it, the archived page, links to one", () => {
  const archivedPage: DocPageDTO = { ...PAGE, archived: { at: T0, by: "priya" }, can_archive: true, children: [], ancestors: [] };
  it("the … menu offers Archive page only to an admin or an owner of the space (can_archive), after the others", () => {
    const canState = (can: boolean) => docState({ treeMenu: "api", spaceHome: { status: "ok", data: { space: SPACES[0], pages: PAGES, can_edit: can, can_archive: can, can_admin: false } } });
    const menu = pane(render(canState(true))).match(/<div class="cnpy-dp-menu"[\s\S]*?<\/div>/)![0];
    const items = [...menu.matchAll(/role="menuitem" data-act="(\w+)"[^>]*>([^<]*)</g)].map((m) => `${m[1]}:${m[2]}`);
    expect(items).toEqual(["treeCopyLink:Copy link", "treeMoveTop:Move to the top level", "treeNew:New page inside", "libPageArchive:Archive page"]);
    expect(pane(render(canState(false)))).not.toContain("libPageArchive");
  });
  it("the doc page header's Archive page, for can_archive only", () => {
    expect(render(docState({ docDetail: { status: "ok", data: { doc: doc(), versions: [], page: { ...PAGE, can_archive: true } } } }))).toMatch(/data-act="libPageArchive" data-arg="auth"[^>]*>[\s\S]*?Archive page<\/button>/);
    expect(render(docState())).not.toContain("libPageArchive");
  });
  it("an archived page, opened by its link: read-only with the banner, the Archived mark, Restore for those allowed; no Tags row, no Archive", () => {
    const html = render(docState({ docDetail: { status: "ok", data: { doc: doc(), versions: [], tags: ["auth"], page: archivedPage } } }));
    expect(html).toContain("This page is archived.");
    expect(html).toContain("by Priya Natarajan.");
    expect(html).toContain('data-act="libPageRestore" data-arg="auth"');
    expect(html).toMatch(/data-mtip="This page was archived\. It(&#39;|')s out of the Library until someone restores it\."[^>]*>[\s\S]*?Archived<\/span>/);
    expect(html).not.toContain('data-act="libPageArchive"');
    expect(html).not.toContain("data-item-tags");
    expect(render(docState({ docDetail: { status: "ok", data: { doc: doc(), versions: [], tags: ["auth"], page: PAGE } } }))).toContain("data-item-tags");
    const notMine = render(docState({ docDetail: { status: "ok", data: { doc: doc(), versions: [], page: { ...archivedPage, can_archive: false } } } }));
    expect(notMine).toContain("This page is archived.");
    expect(notMine).not.toContain("libPageRestore");
  });
  it("a [[link]] to an archived page is plain text with the Archived mark — no link to follow", () => {
    const out = linkedBody("See [[old]] and [[old|the old one]].", { links: [], broken_links: [], archived_links: [{ slug: "old", title: "Old runbook" }] });
    expect(out).toContain('<span class="cnpy-doclink-arch">Old runbook <span data-mtip="This page was archived.');
    expect(out).toContain('<span class="cnpy-doclink-arch">the old one ');
    expect(out).toContain("Archived</span>");
    expect(out).not.toContain('href="#doc/old"');
    expect(out).not.toContain("is-broken");
  });
});

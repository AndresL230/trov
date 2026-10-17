// The docs pane (docs/architecture/docs-library.md › The page tree) — a space's PAGE TREE, 252px beside the content
// on a space's home, a doc page and New page (the app sidebar lists spaces only; pages never). Design spec §1.2:
// the head row (the space: its home, and "+" for a page at its top level; while dragging it is "the top level"),
// "PAGES" and the space's page count, then one 28px row per page — indented by `indentPx(depth)`, a guide line per
// ancestor level, a chevron when it has children, the status shape for a page that is not live (never a word), and
// on hover "+" (a page inside) and "…" (Copy link / Move to the top level / New page inside). The tree's ORDER and rules are
// shared/docs-tree-core.ts; the pointer drag over these rows is web/src/tree-drag.ts (rows carry `data-dtree`).
// Pure: props in, markup out. Every row is stable markup (`data-morph-key` per page) so a paint patches it in place:
// a chevron's turn and the pane's own scroll survive every repaint.
import { buildTree, ancestorsOf, flattenTree, indentPx } from "@shared/docs-tree-core";
import { pagesWord, type LibraryPageDTO, type SpaceDTO } from "@shared/docs-core";
import { esc, attr, hitArea, HITBOX } from "./ui";
import { markShape, AUTHORITY_MARK } from "./marks";
import { skeleton, skBar, emptyLayout } from "./skeleton";
import { spaceTile } from "./library";

export interface DocsPaneProps {
  /** The space whose tree this is (null while the Library's read is out). */
  space: SpaceDTO | null;
  /** Its pages, staged-only ones included; null while they are read. */
  pages: LibraryPageDTO[] | null;
  /** The read failed and there is nothing to show. */
  error?: boolean;
  /** The page being read (the active row). */
  activeSlug: string | null;
  /** On the space's home: the head row is the active one. */
  headActive: boolean;
  /** Pages the person opened or closed; a page not named here is open when it is the active page or above it. */
  open: Readonly<Record<string, boolean>>;
  /** The row whose "…" menu is open. */
  menu: string | null;
}

/** The longest title the row shows without its tooltip (the design's 24 characters). */
export const LONG_TITLE = 24;

const CHEV = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg>`;
const PLUS = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>`;
const DOTS = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7"></circle><circle cx="12" cy="12" r="1.7"></circle><circle cx="19" cy="12" r="1.7"></circle></svg>`;

/** Which pages show their children: what the person chose, else open when above the active page. */
export function expandedSet(pages: readonly LibraryPageDTO[], activeSlug: string | null, open: Readonly<Record<string, boolean>>): Set<string> {
  const tree = buildTree(pages);
  const out = new Set<string>();
  // The page being read and every page above it start open (the design opens Architecture, API and Authentication).
  const above = activeSlug && tree.bySlug.has(activeSlug) ? new Set([...ancestorsOf(tree, activeSlug).map((a) => a.slug), activeSlug]) : new Set<string>();
  for (const p of pages) {
    const want = open[p.slug];
    if (want === true || (want === undefined && above.has(p.slug))) out.add(p.slug);
  }
  return out;
}

/** The status shape of a page that is not live (8px, no word; its meaning is the row's tooltip). */
function statusShape(pg: LibraryPageDTO): string {
  const m = AUTHORITY_MARK[pg.authority];
  if (!m) return "";
  return `<span class="cnpy-dp-st" role="img" aria-label="${attr(m.word)}" data-mtip="${attr(`${m.word}. ${m.hint}`)}">${markShape(m.shape, m.tone, 8)}</span>`;
}

function row(pg: LibraryPageDTO, depth: number, hasKids: boolean, isOpen: boolean, p: DocsPaneProps): string {
  const active = pg.slug === p.activeSlug;
  const pad = 6 + indentPx(depth);
  const guides = Array.from({ length: depth }, (_, l) => `<span class="cnpy-dp-guide" style="left:${6 + indentPx(l) + 8}px"></span>`).join("");
  const chev = hasKids
    ? `<button type="button" class="cnpy-dp-chev${isOpen ? " is-open" : ""}" data-act="treeToggle" data-arg="${attr(pg.slug)}" aria-expanded="${isOpen}" aria-label="${attr(`${isOpen ? "Hide" : "Show"} the pages under ${pg.title}`)}">${CHEV}</button>`
    : `<span class="cnpy-dp-chev is-empty" aria-hidden="true"></span>`;
  const long = pg.title.length > LONG_TITLE;
  const menuOpen = p.menu === pg.slug;
  const menu = menuOpen
    ? `<div class="cnpy-dp-menu" role="menu" aria-label="${attr(pg.title)}">
        <button type="button" role="menuitem" data-act="treeCopyLink" data-arg="${attr(pg.slug)}" class="cnpy-dp-mi">Copy link</button>
        ${pg.parent_slug !== null ? `<button type="button" role="menuitem" data-act="treeMoveTop" data-arg="${attr(pg.slug)}" class="cnpy-dp-mi">Move to the top level</button>` : ""}
        <button type="button" role="menuitem" data-act="treeNew" data-arg="${attr(pg.slug)}" class="cnpy-dp-mi">New page inside</button>
      </div>`
    : "";
  return `<div class="cnpy-dp-row ${HITBOX}${active ? " is-active" : ""}${depth === 0 ? " is-top" : ""}${menuOpen ? " has-menu" : ""}" data-morph-key="dp:${attr(pg.slug)}" data-dtree="${attr(pg.slug)}" data-depth="${depth}" style="padding-left:${pad}px">
    ${guides}${chev}
    <span class="cnpy-dp-t">${esc(pg.title)}</span>${statusShape(pg)}
    <span class="cnpy-dp-acts">
      <button type="button" class="cnpy-dp-act" data-act="treeNew" data-arg="${attr(pg.slug)}" aria-label="New page inside" data-mtip="New page inside">${PLUS}</button>
      <button type="button" class="cnpy-dp-act" data-act="treeMenu" data-arg="${attr(pg.slug)}" aria-label="More" aria-haspopup="menu" aria-expanded="${menuOpen}">${DOTS}</button>
    </span>${menu}
    <button data-act="openDoc" data-arg="${attr(pg.slug)}" class="cnpy-hit" aria-label="${attr(pg.title)}"${active ? ` aria-current="page"` : ""}${long ? ` data-mtip="${attr(pg.title)}"` : ""}></button>
  </div>`;
}

/** The tree while its read is out: nine rows of bars (the design's pads and widths). */
const PADS = [6, 20, 20, 6, 20, 34, 34, 6, 6];
const WIDTHS = ["58%", "66%", "48%", "52%", "70%", "54%", "62%", "44%", "60%"];
export const paneRowsShape = (): string =>
  PADS.map((pad, i) => `<div class="cnpy-dp-row is-shape" style="padding-left:${pad + 16}px">${skBar(WIDTHS[i], 9)}</div>`).join("");

/** The empty tree: "No pages yet", then three hollow rows (depth 0 at 64%, depth 1 at 48%, depth 0 at 56%). */
const hollowRows = (): string =>
  [[0, "64%"], [1, "48%"], [0, "56%"]].map(([d, w]) => `<div class="cnpy-dp-row is-shape" style="padding-left:${6 + indentPx(d as number) + 16}px">${skBar(w as string, 9)}</div>`).join("");

/** The pane's markup. Its root is the same element on every screen of the space (`data-morph-key`). */
export function docsPane(p: DocsPaneProps): string {
  const sp = p.space;
  const head = sp
    ? `<div class="cnpy-dp-head ${HITBOX}${p.headActive ? " is-active" : ""}" data-dtree-head="${attr(sp.slug)}">
        ${spaceTile(sp, 20)}<span class="cnpy-dp-name">${esc(sp.name)}</span>
        ${sp.archived ? "" : `<button type="button" class="cnpy-dp-act is-head" data-act="libNewPage" data-arg="${attr(sp.slug)}" aria-label="New page" data-mtip="New page">${PLUS}</button>`}
        ${hitArea("libOpenSpace", sp.slug, `${sp.name}: the space's home`)}
      </div>`
    : `<div class="cnpy-dp-head is-shape">${skBar(20, 20)}${skBar("52%", 11)}</div>`;
  let body: string;
  let count = "";
  if (p.pages === null) {
    body = p.error ? `<p class="cnpy-dp-note">Couldn't load the pages. Reload to try again.</p>` : skeleton("docs-tree", "Loading pages…", paneRowsShape());
  } else if (p.pages.length === 0) {
    count = "0";
    body = emptyLayout("docs-tree", { text: "No pages yet. A new page goes here once someone writes it.", plain: true, sayStyle: "padding:2px 8px 6px", shapes: hollowRows() });
  } else {
    count = String(p.pages.length);
    const tree = buildTree(p.pages);
    const open = expandedSet(p.pages, p.activeSlug, p.open);
    const rows = flattenTree(tree, sp?.slug ?? p.pages[0].space, open);
    body = `<div class="cnpy-dp-rows" role="list" data-morph-list>${rows.map((r) => row(r.node, r.depth, r.hasChildren, open.has(r.node.slug), p)).join("")}</div>`;
  }
  return `<nav class="cnpy-dpane cnpy-scroll" data-morph-key="dpane:${attr(sp?.slug ?? "")}" aria-label="${attr(sp ? `Pages in ${sp.name}` : "Pages")}">
    ${head}
    <div class="cnpy-dp-label"><span>Pages</span>${count ? `<span class="cnpy-dp-n" aria-label="${attr(pagesWord(Number(count)))}">${count}</span>` : ""}</div>
    ${body}
  </nav>`;
}

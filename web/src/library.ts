// The Docs Library's screens (docs/architecture/docs-library.md › The screens) — Library home (`#library`),
// a space's home (`#library/<space>`), and the space dialogs (Create / Edit space, the owners, Archive). Ported
// from the Claude Design Library prototype, built from Trov's own pieces: `tabBar()` for the space's tabs,
// `dropdown()` for a space's position, `confirmModal` for every dialog, `emptyLayout` / `skeleton` for the two
// states, `authorityMark` for a page's status, people.ts for every person. Pure: props in, markup out; the
// reads and writes are web/src/library-actions.ts.
import {
  SPACE_ICONS, SPACE_COLORS, SPACE_NAME_MAX, SPACE_DESCRIPTION_MAX, NEW_SPACE_ICON, NEW_SPACE_COLOR,
  isSpaceColor, isSpaceIcon, spaceNamedLike, cleanSpaceName, pagesWord, ownedBy, archivePageText,
  type SpaceIcon, type SpaceColor, type SpaceDTO, type LibraryDTO, type LibraryPageDTO, type SpaceHomeDTO,
} from "@shared/docs-core";
import type { PersonSummary } from "@shared/people";
import { esc, attr, surface, hitArea, HITBOX } from "./ui";
import { personChip, personAvatarLink } from "./people";
import { avatarStack } from "./tickets";
import { authorityMark, markShape, kindMark } from "./marks";
import { tabBar, tabPanelAttrs } from "./tabs";
import { dropdown, type DropdownProps, type DropdownUi } from "./dropdown";
import { confirmModal } from "./confirm";
import { skeleton, skBar, skBox, skLine, skList, skCard, skW, emptyLayout, emptyShapes } from "./skeleton";
import { buildTree, childrenOf, descendantsOf, flattenTree } from "@shared/docs-tree-core";

// ── the space tile ───────────────────────────────────────────────────────────

/** The icons' line paths (24×24, stroked) — the design's `IC` set, one entry per `SPACE_ICONS` choice. */
export const SPACE_ICON_PATHS: Record<SpaceIcon, readonly string[]> = {
  braces: ["M8 4H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1", "M16 4h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-1"],
  compass: ["M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z", "M15.5 8.5l-2 5-5 2 2-5z"],
  pen: ["M4 20l4-1 11-11a2.1 2.1 0 0 0-3-3L5 16z", "M14 7l3 3"],
  shield: ["M12 3l7 3v6c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6z"],
  flask: ["M9 3h6", "M10 3v6l-5.5 9.5A1.6 1.6 0 0 0 5.9 21h12.2a1.6 1.6 0 0 0 1.4-2.5L14 9V3", "M7.5 15h9"],
  rocket: ["M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2", "M9 15l-3-3c1-4 4.5-8.5 12-9-.5 7.5-5 11-9 12z", "M14.5 8a1.5 1.5 0 1 0 0 3a1.5 1.5 0 1 0 0-3z"],
  book: ["M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z", "M5 19.5A1.5 1.5 0 0 0 6.5 21H19v-3"],
  users: ["M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2", "M9 3a4 4 0 1 0 0 8a4 4 0 1 0 0-8z", "M22 21v-2a4 4 0 0 0-3-3.87", "M16 3.13a4 4 0 0 1 0 7.75"],
  chart: ["M4 20V11", "M10 20V5", "M16 20v-6", "M21 20H3"],
  server: ["M4 4h16v6H4z", "M4 14h16v6H4z", "M8 7h.01", "M8 17h.01"],
  megaphone: ["M3 10v4h3l6 4V6L6 10z", "M16 9a3.5 3.5 0 0 1 0 6", "M19 6a8 8 0 0 1 0 12"],
  lock: ["M5 11h14v10H5z", "M8 11V7a4 4 0 0 1 8 0v4"],
};
/** The words an icon is called by (the Create space dialog's buttons). */
const ICON_WORD: Record<SpaceIcon, string> = {
  braces: "Code", compass: "Compass", pen: "Pen", shield: "Shield", flask: "Flask", rocket: "Rocket",
  book: "Book", users: "People", chart: "Chart", server: "Server", megaphone: "Megaphone", lock: "Lock",
};
const COLOR_WORD: Record<SpaceColor, string> = {
  "#525cc3": "Indigo", "#2467af": "Blue", "#2f7d57": "Green", "#607a29": "Olive",
  "#966800": "Ochre", "#b4562c": "Rust", "#a84a68": "Rose", "#7a4f8f": "Plum",
};

const PAGE_PATHS = ["M6 3h7l5 5v13H6z", "M13 3v5h5"];
const lineIcon = (paths: readonly string[], size: number, stroke: number, color = "currentColor"): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths.map((d) => `<path d="${d}"></path>`).join("")}</svg>`;
/** A page's icon (the design's `page`). */
export const pageIcon = (size = 14): string => lineIcon(PAGE_PATHS, size, 1.8);
/** A space's icon alone, in `color` (the icon picker draws it in the text colour). */
export const spaceIconSvg = (icon: string, size: number, color = "currentColor", stroke?: number): string =>
  lineIcon(SPACE_ICON_PATHS[isSpaceIcon(icon) ? icon : NEW_SPACE_ICON], size, stroke ?? (size < 12 ? 2.3 : 1.9), color);

/**
 * A space's tile: a square in the space's colour holding its white line icon (62% of the tile; a heavier stroke
 * under 20px). Its corner is `min(4.8px, size × .25)`, passed as `--spt-r` and scaled in trov.css's corners block
 * (`.cnpy-spt`) like every other radius. A colour that is not one of the choices draws the first one.
 */
export function spaceTile(sp: { icon: string; color: string }, size: number): string {
  const color = isSpaceColor(sp.color) ? sp.color.toLowerCase() : SPACE_COLORS[0];
  const r = Math.min(4.8, size * 0.25);
  return `<span class="cnpy-spt" style="--spt-r:${+r.toFixed(2)}px;width:${size}px;height:${size}px;background:${color}" aria-hidden="true">${spaceIconSvg(sp.icon, Math.round(size * 0.62), "#fff", size < 20 ? 2.3 : 1.9)}</span>`;
}

// ── words ────────────────────────────────────────────────────────────────────

/** How long ago, in the Library's words (the design's `when()`): "just now", "25 minutes ago", "an hour ago",
 *  "yesterday", "3 days ago", "a week ago", "2 months ago", "over a year ago". Unknown → "—". */
export function libraryWhen(iso: string | null, now = Date.now()): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const d = Math.max(0, (now - t) / 86_400_000);
  if (d < 0.02) return "just now";
  if (d < 0.06) return `${Math.max(5, Math.round((d * 1440) / 5) * 5)} minutes ago`;
  if (d < 1) { const h = Math.max(1, Math.round(d * 24)); return h === 1 ? "an hour ago" : `${h} hours ago`; }
  if (d < 2) return "yesterday";
  if (d < 7) return `${Math.floor(d)} days ago`;
  if (d < 30) { const w = Math.floor(d / 7); return w === 1 ? "a week ago" : `${w} weeks ago`; }
  if (d < 365) { const m = Math.max(1, Math.floor(d / 30)); return m === 1 ? "a month ago" : `${m} months ago`; }
  return "over a year ago";
}

/** "N pages are waiting for review" / "1 page is waiting for review". */
export const waitingWords = (n: number): string => `${n} ${n === 1 ? "page is" : "pages are"} waiting for review`;
/** A top-level card's line: "No pages inside" / "1 page inside" / "N pages inside". */
const insideWords = (n: number): string => (n === 0 ? "No pages inside" : `${n} ${n === 1 ? "page" : "pages"} inside`);

const findPerson = (persons: readonly PersonSummary[], handle: string | null): PersonSummary | null =>
  handle ? persons.find((p) => p.handle.toLowerCase() === handle.toLowerCase()) ?? null : null;
/** A person's full name (the "Owned by" line), else their handle. */
const fullName = (persons: readonly PersonSummary[], handle: string): string => findPerson(persons, handle)?.name || handle;
/** A person's short name (a "By" cell): their first name, else their handle. */
const shortName = (persons: readonly PersonSummary[], handle: string): string => (findPerson(persons, handle)?.name || handle).split(/\s+/)[0];

/** "Library home: the subtitle under the title". */
export const LIBRARY_SUBTITLE = "Guides, runbooks, specs and decisions for the whole team, grouped into spaces.";
/** Library home with no space (the design's copy). */
export const LIBRARY_EMPTY = "A space holds the pages for one team or topic, like Engineering or Onboarding. Create one, then write pages in it or import Markdown files you already have.";
/** Library home with spaces but no page yet. */
export const LIBRARY_RECENT_EMPTY = "The pages changed last show here, from every space. Write one from a space's New page.";
/** A space's home with no page (the design's sentence). */
export const SPACE_EMPTY = "Write the first page, or import Markdown files you already have. Imported pages wait in Review until someone approves them.";
/** The Create space dialog's intro. */
export const CREATE_SPACE_INTRO = "A space holds the pages for one team or topic. Only admins can create one.";
const ARCHIVED_TIP = "Archived: it is out of the sidebar and the Library. An admin can restore it.";

// ── shared bits ──────────────────────────────────────────────────────────────

const PLUS = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>`;
const PENCIL = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20l4-1 11-11a2.1 2.1 0 0 0-3-3L5 16z"></path></svg>`;
const ALERT = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7.5v5.5M12 16.5h.01"></path></svg>`;
const accentBtn = (act: string, arg: string | null, label: string, icon = PLUS): string =>
  `<button type="button" data-act="${attr(act)}"${arg !== null ? ` data-arg="${attr(arg)}"` : ""} class="cnpy-accentbtn" style="display:inline-flex;align-items:center;gap:7px;padding:7px 14px;border-radius:8px;background:var(--accent);color:var(--accent-fg);font-size:12.5px;font-weight:600;white-space:nowrap">${icon}${esc(label)}</button>`;
const outlineBtn = (act: string, arg: string | null, label: string, extra = ""): string =>
  `<button type="button" data-act="${attr(act)}"${arg !== null ? ` data-arg="${attr(arg)}"` : ""}${extra} class="cnpy-outlinebtn" style="display:inline-flex;align-items:center;gap:7px;padding:7px 13px;border-radius:8px;border:1px solid var(--border-strong);font-size:12.5px;font-weight:500;color:var(--fg-70);white-space:nowrap">${esc(label)}</button>`;
const H2 = "font-size:14px;font-weight:500;letter-spacing:-0.005em;color:var(--fg);margin:0";
const UPLOAD = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V4"></path><path d="m7 9 5-5 5 5"></path><path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"></path></svg>`;
/** The secondary Import button (Library home, a space's home): opens the import wizard, `space` preset. */
const importBtn = (space: string | null): string =>
  `<button type="button" data-act="goImport" data-arg="${attr(space ?? "")}" class="cnpy-outlinebtn" style="display:inline-flex;align-items:center;gap:7px;padding:7px 13px;border-radius:8px;border:1px solid var(--border-strong);font-size:12.5px;font-weight:500;color:var(--fg-70);white-space:nowrap">${UPLOAD}Import</button>`;

/** A "By" cell: an 18px avatar and "Short name · when" (the design's), or "—" when nobody is known. */
function byCell(persons: readonly PersonSummary[], handle: string | null, at: string | null): string {
  if (!handle) return `<span style="font-size:12px;color:var(--fg-40)">—</span>`;
  return `<span style="display:inline-flex;align-items:center;gap:7px;min-width:0;font-size:12px;color:var(--fg-55)">${personAvatarLink(findPerson(persons, handle), handle, 18)}<span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(shortName(persons, handle))} · ${esc(libraryWhen(at))}</span></span>`;
}

// ── Library home (`#library`) ────────────────────────────────────────────────

export interface LibraryHomeProps {
  library: { status: string; data: LibraryDTO | null };
  /** An admin of the org: New space, the dashed card, the archived spaces. */
  admin: boolean;
  persons: readonly PersonSummary[];
  /** The archived space whose Restore is in flight. */
  restoring: string | null;
}

const LIB_FRAME = "max-width:1120px;margin:0 auto;padding:28px 40px 90px";
/** One space card as shapes: the tile, the name, two lines of description, the footer — the loading skeleton and
 *  the empty layout's hollow cards. */
const spaceCardShape = (i: number): string => skCard(`<div style="display:flex;align-items:center;gap:11px">${skBox(32, 32)}${skLine(skW(i, ["48%", "62%", "40%"]), 15, 1.3)}</div>
    <div style="margin-top:12px">${skLine("92%", 12.5, 1.5)}${skLine(skW(i + 1, ["66%", "54%", "72%"]), 12.5, 1.5)}</div>
    <div style="display:flex;align-items:center;gap:8px;margin-top:auto;padding-top:14px">${skBox(18, 18)}${skBar(90, 9)}</div>`, "min-height:150px;padding:16px 18px;display:flex;flex-direction:column");
const LIB_GRID = "display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px";
/** One "Recently updated" row as shapes, in the row's own grid. */
const recentRowShape = (i: number, cols = "1fr 210px 200px", first = false): string =>
  `<div class="cnpy-lib-row" style="grid-template-columns:${cols};min-height:52px;padding:8px 16px${first ? "" : ";border-top:1px solid var(--border)"}"><div style="display:flex;align-items:center;gap:10px">${skBox(14, 14)}<div style="flex:1">${skLine(skW(i), 13.5, 1.3)}${skLine(skW(i + 2, ["34%", "42%", "28%"]), 12, 1.4)}</div></div><div></div><div style="display:flex;align-items:center;gap:7px">${skBox(18, 18)}${skBar(110, 9)}</div></div>`;
const recentRowsShape = (n: number, cols?: string): string => skCard(skList(n, (i) => recentRowShape(i, cols, i === 0)), "padding:0;overflow:hidden");

function libraryTitle(p: LibraryHomeProps): string {
  return `<div class="cnpy-lib-head" style="display:flex;align-items:flex-start;justify-content:space-between;gap:20px;flex-wrap:wrap">
    <div style="min-width:0">
      <h1 style="font-size:24px;font-weight:650;letter-spacing:-0.02em;margin:0;line-height:1.2">Library</h1>
      <p style="font-size:13.5px;line-height:1.5;color:var(--fg-70);max-width:560px;margin:6px 0 0">${esc(LIBRARY_SUBTITLE)}</p>
    </div>
    <div style="display:flex;gap:8px;flex:none">${importBtn(null)}${p.admin ? accentBtn("libNew", null, "New space") : ""}</div>
  </div>`;
}

function spaceCard(sp: SpaceDTO, persons: readonly PersonSummary[]): string {
  const pages = sp.pages === 0 ? "No pages yet" : pagesWord(sp.pages);
  const waiting = sp.waiting > 0 ? `<span style="color:var(--border-strong)">·</span><span style="display:inline-flex;align-items:center;gap:5px">${markShape("ring", "var(--amber)", 8)}${sp.waiting} waiting</span>` : "";
  return `<div${surface("min-height:150px;padding:16px 18px;display:flex;flex-direction:column", { hover: true, cls: `${HITBOX} cnpy-lib-card` })} data-space="${attr(sp.slug)}">
    <div style="display:flex;align-items:center;gap:11px;min-width:0">${spaceTile(sp, 32)}<span style="font-size:15px;font-weight:500;letter-spacing:-0.01em;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(sp.name)}</span></div>
    <p style="font-size:12.5px;line-height:1.5;margin:10px 0 0;color:${sp.description ? "var(--fg-55)" : "var(--fg-40)"}">${esc(sp.description || "No description yet.")}</p>
    <div style="display:flex;align-items:center;gap:8px;margin-top:auto;padding-top:14px;font-size:12px;color:var(--fg-55);flex-wrap:wrap">${sp.owners.length ? avatarStack(sp.owners, persons as PersonSummary[], 18) : ""}<span>${esc(pages)}</span>${waiting}</div>
    ${hitArea("libOpenSpace", sp.slug, `Open ${sp.name}`)}
  </div>`;
}

const newSpaceCard = (): string =>
  `<button type="button" data-act="libNew" class="cnpy-lib-newcard" style="min-height:150px;padding:16px 18px;border-radius:10px;border:1px dashed var(--border-strong);display:flex;flex-direction:column;align-items:flex-start;text-align:left;color:var(--fg-70)">
    <span style="width:32px;height:32px;border-radius:8px;border:1px solid var(--border-strong);display:grid;place-items:center;color:var(--fg-55)">${PLUS}</span>
    <span style="font-size:13.5px;font-weight:500;color:var(--fg);margin-top:12px">New space</span>
    <span style="font-size:12.5px;line-height:1.5;color:var(--fg-55);margin-top:4px">For a team or a topic. Only admins can create spaces.</span>
  </button>`;

/** A page row of a list: title and path in the first column, its status, then who changed it last and when. */
function pageRow(pg: LibraryPageDTO, o: { persons: readonly PersonSummary[]; lead: string; path: string; cols: string; first: boolean; minH: number; indent?: number; bold?: boolean; noPath?: boolean }): string {
  return `<div class="cnpy-lib-row ${HITBOX}" style="grid-template-columns:${o.cols};min-height:${o.minH}px;padding:${o.noPath ? "0" : "8px"} 16px${o.first ? "" : ";border-top:1px solid var(--border)"}">
    <div style="display:flex;align-items:center;gap:10px;min-width:0${o.indent ? `;padding-left:${o.indent}px` : ""}">${o.lead}<div style="min-width:0">
      <div style="font-size:13.5px;${o.bold ? "font-weight:500;" : ""}color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(pg.title)}</div>
      ${o.noPath ? "" : `<div style="font-size:12px;color:var(--fg-55);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(o.path)}</div>`}
    </div></div>
    <div style="display:flex;align-items:center;min-width:0">${authorityMark(pg.authority, 12)}</div>
    <div style="display:flex;align-items:center;min-width:0">${byCell(o.persons, pg.updated_by, pg.updated_at)}</div>
    ${hitArea("libOpenDoc", pg.slug, `Open ${pg.title}`)}
  </div>`;
}

function archivedList(p: LibraryHomeProps, archived: SpaceDTO[]): string {
  if (!p.admin || archived.length === 0) return "";
  const rows = archived.map((sp, i) => {
    const busy = p.restoring === sp.slug;
    return `<div style="display:flex;align-items:center;gap:12px;padding:10px 16px${i ? ";border-top:1px solid var(--border)" : ""}">
      ${spaceTile(sp, 14)}<span style="flex:1;min-width:0;font-size:13px;color:var(--fg-70);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(sp.name)}</span>
      <span style="font-size:12px;color:var(--fg-55);white-space:nowrap">${esc(pagesWord(sp.pages))}</span>
      <button type="button" data-act="libRestore" data-arg="${attr(sp.slug)}" class="cnpy-outlinebtn"${busy ? " disabled aria-busy=\"true\"" : ""} style="padding:5px 11px;border-radius:7px;border:1px solid var(--border-strong);font-size:12px;font-weight:500;color:var(--fg-70);white-space:nowrap">${busy ? "Restoring…" : "Restore"}</button>
    </div>`;
  }).join("");
  return `<section style="margin-top:34px"><h2 style="${H2};margin-bottom:4px">Archived spaces</h2>
    <p style="font-size:12.5px;color:var(--fg-55);margin:0 0 10px">Out of the sidebar and the Library. Their pages are kept; restore one to bring it back.</p>
    <div${surface("padding:0;overflow:hidden")}>${rows}</div></section>`;
}

export function libraryHomeView(p: LibraryHomeProps): string {
  const lib = p.library;
  const pending = (lib.status === "idle" || lib.status === "loading") && !lib.data;
  const head = libraryTitle(p);
  const recentHead = `<h2 style="${H2};margin:34px 0 10px">Recently updated</h2>`;
  if (pending) {
    return `<div class="cnpy-lib" data-screen-label="Library" style="${LIB_FRAME}">${head}
      <h2 style="${H2};margin:26px 0 10px">Spaces</h2>
      ${skeleton("lib-spaces", "Loading spaces…", `<div class="cnpy-lib-grid" style="${LIB_GRID}">${skList(3, spaceCardShape)}</div>`)}
      ${recentHead}${skeleton("lib-recent", "Loading pages…", recentRowsShape(5))}
    </div>`;
  }
  const data = lib.data ?? { spaces: [], archived: [], recent: [], waiting: 0, can_admin: false };
  if (data.spaces.length === 0) {
    return `<div class="cnpy-lib" data-screen-label="Library" style="${LIB_FRAME}">${head}
      <div style="margin-top:26px">${emptyLayout("library", { title: "No spaces yet", text: LIBRARY_EMPTY, action: p.admin ? { label: "New space", act: "libNew" } : null, shapes: `<div class="cnpy-lib-grid" style="${LIB_GRID}">${skList(3, spaceCardShape)}</div>`, shapesStyle: "margin-top:12px" })}</div>
      ${recentHead}${emptyShapes(recentRowsShape(3))}
      ${archivedList(p, data.archived)}
    </div>`;
  }
  const byslug = new Map(data.spaces.map((s) => [s.slug, s]));
  const waiting = data.waiting > 0
    ? `<button type="button" data-act="goReview" class="cnpy-lib-wait" style="display:inline-flex;align-items:center;gap:7px;margin-top:14px;padding:0;font-size:12.5px;color:var(--fg-70)">${markShape("ring", "var(--amber)", 8)}${esc(waitingWords(data.waiting))}</button>`
    : "";
  const cards = data.spaces.map((sp) => spaceCard(sp, p.persons)).join("") + (p.admin ? newSpaceCard() : "");
  const recent = data.recent.length
    ? `<div${surface("padding:0;overflow:hidden")}>${data.recent.map((pg, i) => {
        const sp = byslug.get(pg.space);
        return pageRow(pg, { persons: p.persons, lead: sp ? spaceTile(sp, 14) : pageIcon(14), path: [sp?.name ?? pg.space, ...pg.path].join(" › "), cols: "1fr 210px 200px", first: i === 0, minH: 52 });
      }).join("")}</div>`
    : emptyLayout("lib-recent", { text: LIBRARY_RECENT_EMPTY, shapes: recentRowsShape(3), shapesStyle: "margin-top:12px" });
  return `<div class="cnpy-lib" data-screen-label="Library" style="${LIB_FRAME}">${head}${waiting}
    <h2 style="${H2};margin:26px 0 10px">Spaces</h2>
    <div class="cnpy-lib-grid cnpy-stagger" style="${LIB_GRID}">${cards}</div>
    ${recentHead}${recent}
    ${archivedList(p, data.archived)}
  </div>`;
}

// ── a space's home (`#library/<space>`) ──────────────────────────────────────

export const SPACE_TABS = ["overview", "all", "recent", "oldest", "az", "archived"] as const;
export type SpaceTab = (typeof SPACE_TABS)[number];
export const isSpaceTab = (v: unknown): v is SpaceTab => typeof v === "string" && (SPACE_TABS as readonly string[]).includes(v);
const TAB_LABEL: Record<SpaceTab, string> = { overview: "Overview", all: "All pages", recent: "Recently updated", oldest: "Least recently updated", az: "A to Z", archived: "Archived pages" };

export interface SpaceHomeProps {
  slug: string | null;
  home: { status: string; data: SpaceHomeDTO | null };
  tab: SpaceTab;
  /** An admin of the org: Edit space, Archive, Restore. */
  admin: boolean;
  persons: readonly PersonSummary[];
  /** The description being edited in place (null = not editing), and whether its save is out. */
  descDraft: string | null;
  /** The archived page whose Restore is out (0083_doc_archive). */
  restoring?: string | null;
}

const SPACE_FRAME = "max-width:1080px;margin:0 auto;padding:28px 36px 90px";
const ROW_COLS = "1fr 190px 190px";

const byUpdated = (a: LibraryPageDTO, b: LibraryPageDTO): number => (b.updated_at ?? "").localeCompare(a.updated_at ?? "");

function spaceTabs(tab: SpaceTab, count: number | null, archived: number | null = null): string {
  const badge = (n: number | null) => (n !== null ? `<span class="cnpy-badge" data-n="${n}">${n}</span>` : undefined);
  return tabBar({
    id: "space-tab", ariaLabel: "Pages", value: tab, act: "libTab",
    tabs: SPACE_TABS.map((t) => ({ value: t, label: TAB_LABEL[t], trail: t === "all" ? badge(count) : t === "archived" ? badge(archived) : undefined })),
  });
}

/** Space home's Archived pages, empty (0083_doc_archive). */
export const ARCHIVED_PAGES_EMPTY = "No archived pages. A page someone archives leaves the tree and waits here, so it can be restored.";
/** What Archived pages is, above the list. */
export const ARCHIVED_PAGES_NOTE = "Out of the tree, search and agents' reads. Restore one to put it back in the tree.";

/** The Archived pages tab: each page with who archived it and when, and Restore for an admin or an owner. */
function archivedPanel(p: SpaceHomeProps, d: SpaceHomeDTO): string {
  const list = d.archived_pages ?? [];
  if (!list.length) return emptyLayout("space-archived", { text: ARCHIVED_PAGES_EMPTY, shapes: recentRowsShape(2, ARCHIVED_COLS), shapesStyle: "margin-top:12px" });
  const rows = list.map((a, i) => {
    const busy = p.restoring === a.slug;
    const restore = d.can_archive
      ? `<button type="button" data-act="libPageRestore" data-arg="${attr(a.slug)}" class="cnpy-outlinebtn"${busy ? ` disabled aria-busy="true"` : ""} style="position:relative;z-index:2;padding:5px 11px;border-radius:7px;border:1px solid var(--border-strong);font-size:12px;font-weight:500;color:var(--fg-70);white-space:nowrap">${busy ? "Restoring…" : "Restore"}</button>`
      : "";
    return `<div class="cnpy-lib-row ${HITBOX}" data-archived-page="${attr(a.slug)}" style="grid-template-columns:${ARCHIVED_COLS};min-height:52px;padding:8px 16px${i ? ";border-top:1px solid var(--border)" : ""}">
      <div style="display:flex;align-items:center;gap:10px;min-width:0">${pageIcon(14)}<span style="min-width:0;font-size:13.5px;color:var(--fg-70);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.title)}</span></div>
      <div style="display:flex;align-items:center;min-width:0">${byCell(p.persons, a.archived_by, a.archived_at)}</div>
      <div style="display:flex;align-items:center;justify-content:flex-end">${restore}</div>
      ${hitArea("libOpenDoc", a.slug, `Open ${a.title}`)}
    </div>`;
  }).join("");
  return `<p style="font-size:12.5px;color:var(--fg-55);margin:0 0 10px">${esc(ARCHIVED_PAGES_NOTE)}</p>
    <div${surface("padding:0;overflow:hidden")}><div class="cnpy-lib-row cnpy-lib-th" style="grid-template-columns:${ARCHIVED_COLS};min-height:34px;padding:0 16px;font-size:12px;color:var(--fg-55);border-bottom:1px solid var(--border)"><div>Page</div><div>Archived</div><div></div></div>${rows}</div>`;
}
const ARCHIVED_COLS = "1fr 220px 110px";

/** A top-level page card as shapes (the loading skeleton and the empty layout's hollow cards). */
const pageCardShape = (i: number): string => skCard(`${skLine(skW(i, ["44%", "52%", "38%"]), 11.5, 1.4)}<div style="margin-top:8px">${skLine(skW(i + 1), 14, 1.35)}</div><div style="margin-top:6px">${skLine("88%", 12.5, 1.5)}</div><div style="display:flex;align-items:center;gap:7px;margin-top:auto;padding-top:12px">${skBox(16, 16)}${skBar(96, 8)}</div>`, "min-height:136px;padding:14px 16px;display:flex;flex-direction:column");
const PAGE_GRID = "display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px";

function spaceHeaderSkeleton(): string {
  return skeleton("space-head", "Loading the space…", `<div style="display:flex;align-items:flex-start;gap:16px">
    ${skBox(40, 40)}
    <div style="flex:1;min-width:0">${skBox(200, 20)}<div style="margin-top:10px">${skBar(400, 10)}</div>
      <div style="display:flex;align-items:center;gap:8px;margin-top:12px">${skBox(20, 20)}${skBox(20, 20)}${skBar(220, 9)}</div></div>
    <div style="display:flex;gap:8px;flex:none">${skBox(84, 32)}${skBox(104, 32)}</div>
  </div>`);
}

/** The Overview and list panels while the read is out. */
const spaceBodyShapes = (): string =>
  `${skBar(120, 11)}<div style="${PAGE_GRID};margin-top:12px">${skList(3, pageCardShape)}</div><div style="margin-top:30px">${skBar(130, 11)}</div><div style="margin-top:12px">${recentRowsShape(5, ROW_COLS)}</div>`;

function descriptionBlock(sp: SpaceDTO, canEdit: boolean, draft: string | null): string {
  if (canEdit && !sp.archived && draft !== null) {
    return `<div class="cnpy-lib-desc" style="max-width:600px;margin-top:6px">
      <input data-act="libDescInput" data-field="lib-desc" data-lib-desc value="${attr(draft)}" maxlength="${SPACE_DESCRIPTION_MAX}" placeholder="What is this space for?" aria-label="Description" autocomplete="off" class="cnpy-input cnpy-lib-in" style="display:block;width:100%;box-sizing:border-box;height:31px;padding:0 10px;border:1px solid var(--accent);border-radius:7px;background:var(--surface);color:var(--fg);font-size:13.5px" />
      <div style="display:flex;justify-content:space-between;gap:12px;margin-top:5px;font-size:11.5px;color:var(--fg-40)"><span>Enter to save · Esc to cancel</span><span style="font-variant-numeric:tabular-nums">${draft.length}/${SPACE_DESCRIPTION_MAX}</span></div>
    </div>`;
  }
  if (canEdit && !sp.archived) {
    return `<button type="button" data-act="libDescEdit" class="cnpy-ghostbtn cnpy-lib-descbtn" style="display:inline-flex;align-items:center;gap:7px;max-width:600px;margin:3px 0 0 -7px;padding:3px 7px;border-radius:6px;font-size:13.5px;line-height:1.45;text-align:left;color:${sp.description ? "var(--fg-70)" : "var(--fg-40)"}"><span style="min-width:0">${esc(sp.description || "Add a short description")}</span><span style="flex:none;color:var(--fg-40)">${PENCIL}</span></button>`;
  }
  return sp.description ? `<p style="font-size:13.5px;line-height:1.45;color:var(--fg-70);max-width:600px;margin:6px 0 0">${esc(sp.description)}</p>` : "";
}

function spaceHeader(p: SpaceHomeProps, d: SpaceHomeDTO): string {
  const sp = d.space;
  const names = sp.owners.map((h) => fullName(p.persons, h));
  const waiting = d.pages.filter((pg) => pg.authority !== "live").length;
  const meta = [
    sp.owners.length ? `<span style="display:inline-flex;align-items:center;gap:8px">${avatarStack(sp.owners, p.persons as PersonSummary[], 20, true)}<span>${esc(ownedBy(names))}</span></span>` : `<span>No owner yet</span>`,
    `<span>${esc(pagesWord(d.pages.length))}</span>`,
    ...(waiting > 0 ? [`<button type="button" data-act="goReview" class="cnpy-lib-wait" style="display:inline-flex;align-items:center;gap:6px;padding:0;font-size:12.5px;color:var(--fg-55)">${markShape("ring", "var(--amber)", 8)}${waiting} waiting for review</button>`] : []),
    ...(d.can_edit && !sp.archived ? [`<button type="button" data-act="libOwners" data-confirm-trigger class="cnpy-link" style="padding:0;font-size:12.5px;font-weight:500;color:var(--accent)">Edit owners</button>`] : []),
  ].map((item) => `<span class="cnpy-lib-mi">${item}</span>`).join("");
  const actions = sp.archived
    ? (p.admin ? accentBtn("libRestore", sp.slug, "Restore space", "") : "")
    : `${p.admin ? `${outlineBtn("libEdit", null, "Edit space", " data-confirm-trigger")}${outlineBtn("libArchive", null, "Archive", " data-confirm-trigger")}` : ""}${importBtn(sp.slug)}${accentBtn("libNewPage", sp.slug, "New page")}`;
  return `<div class="cnpy-lib-shead" style="display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap">
    ${spaceTile(sp, 40)}
    <div style="flex:1;min-width:240px">
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap"><h1 style="font-size:24px;font-weight:650;letter-spacing:-0.02em;line-height:1.25;margin:0;overflow-wrap:anywhere">${esc(sp.name)}</h1>${sp.archived ? kindMark("Archived", "off", 12, ARCHIVED_TIP) : ""}</div>
      ${descriptionBlock(sp, d.can_edit, p.descDraft)}
      <div class="cnpy-lib-meta"><div class="cnpy-lib-meta-in">${meta}</div></div>
    </div>
    <div style="display:flex;align-items:center;gap:8px;flex:none;flex-wrap:wrap;max-width:100%">${actions}</div>
  </div>`;
}

function topCard(pg: LibraryPageDTO, inside: number, persons: readonly PersonSummary[], summary = ""): string {
  return `<div${surface("min-height:136px;padding:14px 16px;display:flex;flex-direction:column", { hover: true, cls: HITBOX })}>
    <div style="display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--fg-40)">${pageIcon(13)}${esc(insideWords(inside))}</div>
    <div style="display:flex;align-items:center;gap:8px;margin-top:8px;min-width:0"><span style="font-size:14px;font-weight:500;letter-spacing:-0.005em;color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0">${esc(pg.title)}</span></div>
    ${summary ? `<p class="cnpy-lib-sum">${esc(summary)}</p>` : ""}
    ${pg.authority !== "live" ? `<div style="margin-top:6px">${authorityMark(pg.authority, 11.5)}</div>` : ""}
    <div style="display:flex;align-items:center;gap:7px;margin-top:auto;padding-top:12px;font-size:11.5px;color:var(--fg-40)">${pg.updated_by ? personChip(findPerson(persons, pg.updated_by), 16, pg.updated_by) : ""}<span>Updated ${esc(libraryWhen(pg.updated_at))}</span></div>
    ${hitArea("libOpenDoc", pg.slug, `Open ${pg.title}`)}
  </div>`;
}

const tableHead = (): string =>
  `<div class="cnpy-lib-row cnpy-lib-th" style="grid-template-columns:${ROW_COLS};min-height:34px;padding:0 16px;font-size:12px;color:var(--fg-55);border-bottom:1px solid var(--border)"><div>Page</div><div>Status</div><div>Last updated</div></div>`;

function spacePanel(p: SpaceHomeProps, d: SpaceHomeDTO): string {
  if (p.tab === "archived") return archivedPanel(p, d);
  const pages = d.pages;
  const lead = pageIcon(14);
  const pathOf = (pg: LibraryPageDTO): string => (pg.path.length ? pg.path.join(" › ") : "Top level");
  const row = (pg: LibraryPageDTO, i: number, o: { noPath?: boolean; bold?: boolean; indent?: number } = {}) =>
    pageRow(pg, { persons: p.persons, lead, path: pathOf(pg), cols: ROW_COLS, first: i === 0, minH: o.noPath ? 40 : 52, noPath: o.noPath, bold: o.bold, indent: o.indent });
  // The page tree (shared/docs-tree-core.ts): the top level and each page's children in their saved order.
  const tree = buildTree(pages);
  if (p.tab === "overview") {
    const top = childrenOf(tree, null, d.space.slug);
    const inside = (slug: string): number => descendantsOf(tree, slug).length;
    return `<div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:12px"><h2 style="${H2}">Top-level pages</h2><button type="button" data-act="libTab" data-arg="all" class="cnpy-link" style="padding:0;font-size:12.5px;color:var(--fg-55)">All pages ›</button></div>
      <div class="cnpy-stagger" style="${PAGE_GRID}">${top.map((pg) => topCard(pg, inside(pg.slug), p.persons, d.summaries?.[pg.slug])).join("")}</div>
      <h2 style="${H2};margin:30px 0 12px">Recently updated</h2>
      <div${surface("padding:0;overflow:hidden")}>${[...pages].sort(byUpdated).slice(0, 5).map((pg, i) => row(pg, i)).join("")}</div>`;
  }
  if (p.tab === "all") {
    // The whole tree, every page open, in tree order; each row indented 18px a level.
    const rows = flattenTree(tree, d.space.slug);
    return `<div${surface("padding:0;overflow:hidden")}>${tableHead()}${rows.map((r, i) => row(r.node, i, { noPath: true, bold: r.depth === 0, indent: r.depth * 18 })).join("")}</div>`;
  }
  // A to Z's group: the first letter without its accents (Ü under U); a symbol or a digit is "#", sorted first.
  const letterOf = (title: string): string => {
    const ch = title.trim().charAt(0).normalize("NFD").charAt(0).toUpperCase();
    return /\p{L}/u.test(ch) ? ch : "#";
  };
  const sorted = p.tab === "recent" ? [...pages].sort(byUpdated)
    : p.tab === "oldest" ? [...pages].sort((a, b) => byUpdated(b, a))
    : [...pages].sort((a, b) => Number(letterOf(a.title) !== "#") - Number(letterOf(b.title) !== "#") || a.title.localeCompare(b.title));
  let last = "";
  const rows = sorted.map((pg, i) => {
    if (p.tab !== "az") return row(pg, i);
    const letter = letterOf(pg.title);
    const label = letter !== last ? `<div class="cnpy-lib-letter" style="font-size:11.5px;color:var(--fg-40);padding:12px 16px 4px${i ? ";border-top:1px solid var(--border)" : ""}">${esc(letter)}</div>` : "";
    const first = letter !== last;
    last = letter;
    return label + row(pg, first ? 0 : i);
  }).join("");
  return `<div${surface("padding:0;overflow:hidden")}>${tableHead()}${rows}</div>`;
}

export function spaceHomeView(p: SpaceHomeProps): string {
  const d = p.home.data && p.home.data.space.slug === p.slug ? p.home.data : null;
  if (!d) {
    return `<div class="cnpy-lib" data-screen-label="Space" style="${SPACE_FRAME}">${spaceHeaderSkeleton()}
      <div style="margin-top:22px">${spaceTabs(p.tab, null)}</div>
      <div${tabPanelAttrs("space-tab", p.tab)} style="padding-top:22px">${skeleton("space", "Loading pages…", spaceBodyShapes())}</div>
    </div>`;
  }
  const body = d.pages.length === 0 && p.tab !== "archived"
    ? `${emptyLayout("space", { title: "No pages yet", text: SPACE_EMPTY, actionHtml: d.space.archived ? undefined : `<button type="button" data-act="libNewPage" data-arg="${attr(d.space.slug)}" class="cnpy-empty-act">New page</button><button type="button" data-act="goImport" data-arg="${attr(d.space.slug)}" class="cnpy-empty-act">Import</button>` })}
      <h2 style="${H2};color:var(--fg-70);margin:26px 0 12px">Top-level pages</h2>${emptyShapes(`<div style="${PAGE_GRID}">${skList(3, pageCardShape)}</div>`)}
      <h2 style="${H2};color:var(--fg-70);margin:30px 0 12px">Recently updated</h2>${emptyShapes(recentRowsShape(3, ROW_COLS))}`
    : spacePanel(p, d);
  return `<div class="cnpy-lib" data-screen-label="Space" style="${SPACE_FRAME}">${spaceHeader(p, d)}
    <div style="margin-top:22px">${spaceTabs(p.tab, d.pages.length, (d.archived_pages ?? []).length)}</div>
    <div${tabPanelAttrs("space-tab", p.tab)} style="padding-top:22px">${body}</div>
  </div>`;
}

// ── the dialogs ──────────────────────────────────────────────────────────────

/** The Create / Edit space dialog's draft. `after` (Edit only) is the space it sits right after (null = first). */
export interface SpaceDraft {
  mode: "create" | "edit";
  /** The space being edited (Edit only). */
  slug: string | null;
  name: string;
  icon: SpaceIcon;
  color: SpaceColor;
  description: string;
  after: string | null;
  busy: boolean;
  error: string | null;
}
export const blankSpaceDraft = (): SpaceDraft =>
  ({ mode: "create", slug: null, name: "", icon: NEW_SPACE_ICON, color: NEW_SPACE_COLOR, description: "", after: null, busy: false, error: null });

/** The Library screens' own state (`state.libUi`). */
export interface LibraryUi {
  space: SpaceDraft | null;
  /** The owners dialog: the handles picked so far. */
  owners: { picks: string[]; busy: boolean; error: string | null } | null;
  archive: { busy: boolean; error: string | null } | null;
  /** The description being edited in place on a space's home (null = not editing). */
  desc: string | null;
  /** The archived space whose Restore is out. */
  restoring: string | null;
  /** Archive page's confirmation (0083_doc_archive): the page, its title, how many pages sit right under it, its
   *  space's name. */
  pageArchive: { slug: string; title: string; under: number; spaceName: string; busy: boolean; error: string | null } | null;
  /** The archived page whose Restore is out. */
  pageRestoring: string | null;
}
export const initialLibraryUi = (): LibraryUi => ({ space: null, owners: null, archive: null, desc: null, restoring: null, pageArchive: null, pageRestoring: null });

/** The Position dropdown's value for "first". */
export const FIRST = "__first";

/** The live space whose name the draft repeats (another one, when editing), or null. */
export function duplicateOf(d: SpaceDraft, spaces: readonly SpaceDTO[]): SpaceDTO | null {
  return spaceNamedLike(spaces, d.name, d.slug ?? undefined);
}

/** The Position dropdown of the Edit space dialog: First, then "After ‹Space›" for every other live space. */
export function spacePositionDropdown(d: SpaceDraft, spaces: readonly SpaceDTO[]): DropdownProps {
  const others = spaces.filter((s) => s.slug !== d.slug);
  return {
    id: "lib-sp-pos", act: "libAfter", value: d.after ?? FIRST, labelledBy: "lib-sp-pos-l", fill: true,
    options: [{ value: FIRST, label: "First" }, ...others.map((s) => ({ value: s.slug, label: `After ${s.name}` }))],
  };
}

export function spaceDialog(d: SpaceDraft, spaces: readonly SpaceDTO[], dd: DropdownUi): string {
  const dup = duplicateOf(d, spaces);
  const named = cleanSpaceName(d.name);
  const create = d.mode === "create";
  const errId = "lib-sp-name-e";
  const icons = SPACE_ICONS.map((ic) => {
    const on = ic === d.icon;
    return `<button type="button" role="radio" aria-checked="${on}" aria-label="${attr(ICON_WORD[ic])}" title="${attr(ICON_WORD[ic])}" data-act="libIcon" data-arg="${ic}" class="cnpy-libm-ic${on ? " is-on" : ""}"${d.busy ? " disabled" : ""}>${spaceIconSvg(ic, 16)}</button>`;
  }).join("");
  const colors = SPACE_COLORS.map((c) => {
    const on = c === d.color;
    return `<button type="button" role="radio" aria-checked="${on}" aria-label="${attr(COLOR_WORD[c])}" title="${attr(COLOR_WORD[c])}" data-act="libColor" data-arg="${c}" class="cnpy-libm-sw${on ? " is-on" : ""}"${d.busy ? " disabled" : ""} style="--sw:${c};background:${c}"></button>`;
  }).join("");
  const label = (forId: string, text: string, trail = "") => `<div class="cnpy-libm-l"><label for="${forId}" id="${forId}-l">${esc(text)}</label>${trail}</div>`;
  const detail = `<div class="cnpy-libm">
    <div>${label("lib-sp-name", "Name")}
      <input id="lib-sp-name" data-act="libField" data-arg="name" data-field="lib-sp-name" data-confirm-focus value="${attr(d.name)}" maxlength="${SPACE_NAME_MAX}" placeholder="Like Security or Onboarding" autocomplete="off" spellcheck="false"${dup ? ` aria-invalid="true" aria-describedby="${errId}"` : ""}${d.busy ? " disabled" : ""} class="cnpy-input cnpy-libm-in" style="border-radius:8px" />
      <div id="${errId}" role="alert" class="cnpy-libm-err"${dup ? "" : " hidden"}>${ALERT}<span>${dup ? esc(`There's already a space called ${dup.name}. Pick another name.`) : ""}</span></div>
    </div>
    <div><div class="cnpy-libm-l"><span id="lib-sp-icon-l">Icon</span></div><div role="radiogroup" aria-labelledby="lib-sp-icon-l" class="cnpy-libm-icons">${icons}</div></div>
    <div><div class="cnpy-libm-l"><span id="lib-sp-color-l">Color</span></div><div role="radiogroup" aria-label="Color" class="cnpy-libm-sws">${colors}</div></div>
    <div>${label("lib-sp-desc", "Short description", `<span class="cnpy-libm-opt">Optional</span><span class="cnpy-libm-n">${d.description.length}/${SPACE_DESCRIPTION_MAX}</span>`)}
      <textarea id="lib-sp-desc" data-act="libField" data-arg="description" data-field="lib-sp-desc" rows="2" maxlength="${SPACE_DESCRIPTION_MAX}" placeholder="What goes in this space?"${d.busy ? " disabled" : ""} class="cnpy-input cnpy-libm-in cnpy-libm-ta" style="border-radius:8px">${esc(d.description)}</textarea>
    </div>
    ${create ? "" : `<div><div class="cnpy-libm-l"><span id="lib-sp-pos-l">Position</span></div>${dropdown(spacePositionDropdown(d, spaces), dd)}</div>`}
    <div class="cnpy-libm-prev" style="border-radius:8px"><span>In the sidebar</span><span style="display:inline-flex;align-items:center;gap:8px;min-width:0;color:var(--fg)">${spaceTile({ icon: d.icon, color: d.color }, 14)}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(named ?? "New space")}</span></span></div>
  </div>`;
  return confirmModal({
    id: "lib-space", title: create ? "New space" : "Edit space",
    body: create ? CREATE_SPACE_INTRO : "Its name, icon and colour show in the sidebar and the Library for everyone.",
    detail, confirmAct: "libSave", cancelAct: "libSpaceClose", tone: "neutral", busy: d.busy,
    confirmLabel: create ? "Create space" : "Save changes", busyLabel: create ? "Creating…" : "Saving…",
    confirmDisabled: !named || dup !== null, error: d.error,
  });
}

export function ownersDialog(sp: SpaceDTO, o: NonNullable<LibraryUi["owners"]>, persons: readonly PersonSummary[]): string {
  const known = new Set(persons.map((p) => p.handle.toLowerCase()));
  // Every member, then any owner the directory does not know (so nobody is dropped by not being listed).
  const rows = [...persons.map((p) => ({ handle: p.handle, person: p as PersonSummary | null })), ...sp.owners.filter((h) => !known.has(h.toLowerCase())).map((h) => ({ handle: h, person: null }))];
  const list = rows.map(({ handle, person }) => {
    const on = o.picks.some((h) => h.toLowerCase() === handle.toLowerCase());
    return `<button type="button" role="checkbox" aria-checked="${on}" data-act="libOwnerToggle" data-arg="${attr(handle)}" class="cnpy-libm-person${on ? " is-on" : ""}"${o.busy ? " disabled" : ""} style="border-radius:7px">${personChip(person, 22, handle)}<span class="cnpy-libm-pn">${esc(person?.name || handle)}</span><span class="cnpy-libm-ph">@${esc(handle)}</span><span class="cnpy-libm-ck" aria-hidden="true"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg></span></button>`;
  }).join("");
  return confirmModal({
    id: "lib-owners", title: `Owners of ${sp.name}`,
    body: "Owners can change the space's description and its owners. Admins always can.",
    detail: `<div class="cnpy-libm-people cnpy-scroll" data-scroll-keep="lib-owners">${list}</div>`,
    confirmAct: "libOwnersSave", cancelAct: "libOwnersClose", tone: "neutral", busy: o.busy,
    confirmLabel: "Save owners", busyLabel: "Saving…", error: o.error,
  });
}

export function archiveDialog(sp: SpaceDTO, a: NonNullable<LibraryUi["archive"]>): string {
  return confirmModal({
    id: "lib-archive", title: `Archive ${sp.name}?`,
    body: `It leaves the sidebar and the Library for everyone. Its ${pagesWord(sp.pages)} stay as they are, and an admin can restore it from the Library.`,
    confirmAct: "libArchiveGo", cancelAct: "libArchiveClose", busy: a.busy,
    confirmLabel: "Archive space", busyLabel: "Archiving…", error: a.error,
  });
}

/** Archive page's confirmation (0083_doc_archive): what happens, in the brief's words; red, like Archive space. */
export function archivePageDialog(a: NonNullable<LibraryUi["pageArchive"]>): string {
  return confirmModal({
    id: "lib-page-archive", title: `Archive ${a.title}?`,
    body: archivePageText(a.title, a.under, a.spaceName),
    confirmAct: "libPageArchiveGo", cancelAct: "libPageArchiveClose", busy: a.busy,
    confirmLabel: "Archive page", busyLabel: "Archiving…", error: a.error,
  });
}

// The filter menu: a Filter button and a two-column popover (options on the left,
// the categories on the right, under the button). Ported from the Artifacts design's
// filter popover and shared by the Artifacts library and the Prompt Library.
//
// Motion is the point of its structure:
//  • It opens on hover (main.ts's hover-menu listeners) or click, with a scale-in
//    entrance and staggered rows — played ONLY on the render that opens it
//    (`opening`), so a later rerender (picking an option) never replays it.
//  • Switching category does NOT rerender. EVERY category's option panel is always
//    rendered (the others `hidden`), and main.ts's `switchFilterCat` flips which one
//    shows, moves the highlight (`.fm-ind`, a transform transition) and plays the new
//    panel's options in from the direction you moved. A rerender would rebuild the
//    popover and kill all three.
//  • Closing plays a short exit before the state flips (main.ts `closeFilterMenu`).
// Pure markup here; the behavior lives in main.ts, the keyframes in canopy.css.

import { esc, attr } from "./ui";

export interface FilterMenuOption {
  /** The option's value (compared with the group's `value`). */
  v: string;
  l: string;
  /** Count shown at the right; omitted for options that don't count (a sort). */
  n?: number;
  /** Pre-rendered leading markup (an avatar). */
  lead?: string;
  mono?: boolean;
  /** What a click does: `data-act` / `data-arg`. */
  act: string;
  arg: string;
}
export interface FilterMenuGroup {
  key: string;
  label: string;
  /** The currently chosen value in this group. */
  value: string;
  /** The value that means "no filter" — anything else lights the group's dot. */
  none: string;
  options: FilterMenuOption[];
}
export interface FilterMenuProps {
  /** The menu's name in main.ts's registry (`data-hover-menu`, `data-fm`). */
  id: string;
  open: boolean;
  /** This render opens it: play the entrance. */
  opening: boolean;
  groups: FilterMenuGroup[];
  /** The category shown on the right. */
  cat: string;
  /** How many groups differ from `none` (the badge on the button). */
  activeCount: number;
  /** The footer's primary button text ("Show 4 artifacts"). */
  showLabel: string;
  clearAct: string;
  /** Popover anchoring: stretch across the positioned parent, or hang from the right edge. */
  align: "stretch" | "right";
  ariaLabel: string;
  /** A Filter button on its own (the Feed): its own border and full corners. Without it
   *  the button is the right half of `searchFilterBar` — borderless, the bar draws the box. */
  standalone?: boolean;
}

const ROW_H = 32;
const ROW_GAP = 1;
/** The popover grows to fit this many rows before its option list scrolls. */
const MAX_ROWS = 9;
const FILTER_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 6h16"></path><path d="M7 12h10"></path><path d="M10 18h4"></path></svg>`;
const CARET = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" aria-hidden="true" style="opacity:.7"><path d="m6 9 6 6 6-6"></path></svg>`;
const SEARCH_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true" style="flex:none"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.2-3.2"></path></svg>`;
const CLEAR_ICON = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"></path></svg>`;
const CHECK = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.6" aria-hidden="true"><path d="M20 6 9 17l-5-5"></path></svg>`;

/**
 * The click-outside backdrop. Render it OUTSIDE the element that holds
 * `filterMenu(...)`: the hover wrapper must not contain it, or the pointer would
 * never "leave" the menu and the hover close could not run.
 */
export function filterMenuBackdrop(p: Pick<FilterMenuProps, "id" | "open">): string {
  return p.open ? `<div data-act="fmClose" data-arg="${attr(p.id)}" style="position:fixed;inset:0;z-index:29"></div>` : "";
}

/** The trigger button + popover, wrapped as one hover target. Place it inside a
 *  `position:relative` container — the popover anchors to that. */
export function filterMenu(p: FilterMenuProps): string {
  const cat = p.groups.find((g) => g.key === p.cat) ?? p.groups[0];
  const ci = Math.max(0, p.groups.indexOf(cat));
  // Tall enough for the longest list (options or categories) so nothing scrolls; a
  // very long one (many authors) is capped and scrolls with its scrollbar hidden.
  const rows = Math.min(MAX_ROWS, Math.max(p.groups.length, ...p.groups.map((g) => g.options.length)));
  const bodyH = rows * ROW_H + (rows - 1) * ROW_GAP + 12;
  const anyFilter = p.activeCount > 0;
  const rowBase = "display:flex;align-items:center;gap:9px;width:100%;text-align:left;padding:0 10px;border-radius:7px;font-size:12.5px;font-weight:500;";

  const button = `<button data-act="fmToggle" data-arg="${attr(p.id)}" aria-haspopup="dialog" aria-expanded="${p.open}" class="cnpy-ghostbtn fm-btn" style="display:inline-flex;align-items:center;gap:7px;font-size:12.5px;font-weight:500;${p.standalone ? "border-radius:7px;border:1px solid var(--border-strong)" : "border-radius:0 7px 7px 0;border:none"};height:100%;padding:0 11px 0 12px;white-space:nowrap;${p.open ? "color:var(--fg);background:var(--hover)" : "color:var(--fg-70)"}">
    ${FILTER_ICON}Filter
    ${p.activeCount ? `<span style="font-family:var(--label);font-size:10.5px;font-weight:600;min-width:18px;height:18px;line-height:18px;padding:0 5px;border-radius:6px;text-align:center;color:var(--accent-fg);background:var(--accent)">${p.activeCount}</span>` : ""}
    ${CARET}
  </button>`;

  if (!p.open) return `<div data-hover-menu="${attr(p.id)}" style="display:flex">${button}</div>`;

  const cats = p.groups.map((g, i) => {
    const on = g.key === cat.key;
    return `<button data-act="fmCat" data-hover="fmCat" data-arg="${attr(`${p.id}:${g.key}`)}" data-fm-cat="${attr(g.key)}" class="cnpy-menurow fm-cat${on ? " is-on" : ""}" style="--i:${i};${rowBase}height:${ROW_H}px">
      <span style="flex:1;min-width:0">${esc(g.label)}</span>${g.value !== g.none ? `<span style="width:6px;height:6px;border-radius:4px;background:var(--accent);flex:none"></span>` : ""}
    </button>`;
  }).join("");

  const panels = p.groups.map((g) => `<div data-fm-panel="${attr(g.key)}" class="fm-panel"${g.key === cat.key ? "" : " hidden"}>${g.options.map((o, i) => {
    const on = g.value === o.v;
    return `<button data-act="${attr(o.act)}" data-arg="${attr(o.arg)}" class="cnpy-menurow fm-opt" style="--i:${i};${rowBase}height:${ROW_H}px;${on ? "color:var(--fg)" : "color:var(--fg-70)"}">
      <span style="width:14px;flex:none;display:grid;place-items:center">${on ? CHECK : ""}</span>
      ${o.lead ?? ""}
      <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;${o.mono ? "font-family:var(--label)" : ""}">${esc(o.l)}</span>
      ${o.n !== undefined ? `<span style="font-family:var(--label);font-size:10.5px;font-weight:600;color:var(--fg-40);flex:none">${o.n}</span>` : ""}
    </button>`;
  }).join("")}</div>`).join("");

  const anchor = p.align === "right" ? "right:0;width:340px;max-width:calc(100vw - 32px)" : "left:0;right:0;min-width:300px";
  const pop = `<div role="dialog" aria-label="${attr(p.ariaLabel)}" data-fm-pop="${attr(p.id)}" class="fm-pop${p.align === "right" ? " is-right" : ""}${p.opening ? " is-opening" : ""}" style="position:absolute;top:calc(100% + 6px);${anchor};z-index:30;background:var(--bg);border:1px solid var(--border-strong);border-radius:11px;box-shadow:0 14px 38px rgba(0,0,0,.3);display:flex;flex-direction:column;overflow:hidden">
    <div style="display:grid;grid-template-columns:minmax(0,1fr) 136px;height:${bodyH}px">
      <div class="fm-scroll" style="overflow-y:auto;padding:6px;min-width:0">${panels}</div>
      <div style="position:relative;border-left:1px solid var(--border);padding:6px;display:flex;flex-direction:column;gap:${ROW_GAP}px">
        <span class="fm-ind" aria-hidden="true" style="--ci:${ci};border-radius:7px"></span>
        ${cats}
      </div>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;border-top:1px solid var(--border)">
      <button data-act="${attr(p.clearAct)}" class="cnpy-mutelink" style="font-size:12px;font-weight:500;padding:2px 0;color:${anyFilter ? "var(--fg-55)" : "var(--fg-40);opacity:.5"}">Clear all</button>
      <button data-act="fmClose" data-arg="${attr(p.id)}" class="cnpy-accentbtn" style="padding:6px 14px;border-radius:8px;background:var(--accent);color:var(--accent-fg);font-size:12.5px;font-weight:600;white-space:nowrap">${esc(p.showLabel)}</button>
    </div>
  </div>`;

  return `<div data-hover-menu="${attr(p.id)}" style="display:flex">${button}${pop}</div>`;
}

export interface SearchFilterBarProps {
  search: {
    /** The input's `data-act` and `data-field` (rerender() restores focus + caret by the field). */
    act: string;
    field: string;
    value: string;
    placeholder: string;
    ariaLabel?: string;
    /** A clear (×) button's `data-act`, shown while there is a query. Omit for none. */
    clearAct?: string;
  };
  /** The Filter menu on the right. Rendered NOT `standalone`. */
  menu: FilterMenuProps;
  /** `data-hover-blur`: a mouse leaving the bar drops the input's focus (main.ts). */
  hoverBlur?: boolean;
}

/**
 * Search + Filter as ONE control: one bordered field (`.cnpy-sfbar`) holding the
 * search icon and input on the left and the Filter button on the right, split by a
 * hairline. Every screen with the pair (the ticket queue, the Artifacts library, the
 * Prompt Library) renders it through here, so they cannot drift apart. The bar is the
 * popover's positioned parent, so a `stretch` menu spans the whole control; the
 * click-outside backdrop sits beside the hover wrapper, never inside it.
 */
export function searchFilterBar(p: SearchFilterBarProps): string {
  const q = p.search;
  const menu = { ...p.menu, standalone: false };
  return `<div class="cnpy-sfbar"${p.hoverBlur ? " data-hover-blur" : ""}>
      <div class="cnpy-sfbar-q">
        ${SEARCH_ICON}
        <input data-act="${attr(q.act)}" data-field="${attr(q.field)}" class="cnpy-search-in" style="font-size:12.5px" placeholder="${attr(q.placeholder)}"${q.ariaLabel ? ` aria-label="${attr(q.ariaLabel)}"` : ""} value="${attr(q.value)}" autocomplete="off" spellcheck="false">
        ${q.clearAct && q.value ? `<button data-act="${attr(q.clearAct)}" aria-label="Clear search" class="cnpy-xbtn" style="width:16px;height:16px;display:grid;place-items:center;color:var(--fg-40);flex:none">${CLEAR_ICON}</button>` : ""}
      </div>
      <span class="cnpy-sfbar-div" aria-hidden="true"></span>
      ${filterMenuBackdrop(menu)}
      ${filterMenu(menu)}
    </div>`;
}

/** Row pitch the highlight moves by (canopy.css reads it as `--fm-step`). */
export const FILTER_MENU_STEP = ROW_H + ROW_GAP;

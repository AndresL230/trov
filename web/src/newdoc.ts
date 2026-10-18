// Library › New page (the screen `newdoc`, `#docs/new`; docs/architecture/docs-library.md › New page and templates).
// TWO STEPS, one centered column each (the owner's call): 1 · Pick a template — the template cards, each listing its
// sections (shared/docs-templates-core.ts — a template only SEEDS the body and the section; it is not stored);
// picking one moves on. 2 · Details — the template picked (with "Change template" back to step 1), "Goes in" (a space,
// then a page of its tree to put it under), the title, section and body, and Create page. A person's page is staged
// exactly as an agent's is — POST /api/docs/propose, the gate — and waits in Review. A handoff's "Promote to doc"
// opens step 2 directly, prefilled on Blank, with a FROM HANDOFF banner. Pure: props in, markup out; the acts are
// web/src/newdoc-actions.ts.
// This is the CONTENT column only: render.ts draws it beside the docs pane, in a scroller keyed `newdoc`, on a page
// that is `data-morph`ed (so a field keeps its focus and caret across paints).
import {
  DOC_TEMPLATES, DEFAULT_DOC_TEMPLATE, docTemplate, templateBody, untitledTitle,
  type DocTemplate, type DocTemplateId,
} from "@shared/docs-templates-core";
import { buildTree, flattenTree, ancestorsOf } from "@shared/docs-tree-core";
import type { LibraryPageDTO, SpaceDTO } from "@shared/docs-core";
import { esc, attr } from "./ui";
import { primaryStyle } from "./handoffs";
import { segmented } from "./segmented";
import { dropdown, type DropdownProps, type DropdownUi } from "./dropdown";
import { spaceTile } from "./library";
import { authorityMark } from "./marks";
import { skLine, skList, skW, emptyLayout } from "./skeleton";

/** Up to this many spaces the space picker is a switch; past it, a dropdown (render.ts draws its menu). */
export const NEW_DOC_SPACE_SWITCH_MAX = 4;

/** Which step New page is on: picking the template, or the page's details. */
export type NewDocStep = "template" | "details";

export interface NewDocDraft {
  step: NewDocStep;
  /** Which way the last step change went (the step slides in from that side); absent = no move yet. */
  dir?: "fwd" | "back";
  template: DocTemplateId;
  title: string;
  body: string;
  /** The person edited the body (a template switch then keeps it). */
  bodyTouched: boolean;
  space: string;
  /** The page it goes under (null = the space's top level). */
  parent: string | null;
  section: string;
  summary: string;
  /** The handoff this draft was promoted from (null = a blank New page). */
  from: number | null;
  /** The "Goes in" picker is open. */
  where: boolean;
  /** The picker's rows that are expanded, by slug. */
  whereOpen: Record<string, boolean>;
  busy: boolean;
  error: string | null;
}

/** A fresh draft on step 1, the default template (Runbook) — its body and its section — preselected, in `space`
 *  under `parent`. */
export function blankDoc(space: string, parent: string | null = null): NewDocDraft {
  const t = docTemplate(DEFAULT_DOC_TEMPLATE) as DocTemplate;
  return {
    step: "template", template: t.id, title: "", body: templateBody(t), bodyTouched: false, space, parent, section: t.section, summary: "",
    from: null, where: false, whereOpen: {}, busy: false, error: null,
  };
}

export interface NewDocProps {
  draft: NewDocDraft;
  /** The org's live spaces, in the Library's order. */
  spaces: SpaceDTO[];
  /** The draft space's pages; null while that read is out. */
  pages: LibraryPageDTO[] | null;
  /** The sections the gate accepts (@shared/vocabulary SECTIONS, minus needs-triage). */
  sections: string[];
  /** The open dropdown (the space picker, past NEW_DOC_SPACE_SWITCH_MAX spaces). */
  dd: DropdownUi;
  /** An admin of the org: with no space yet, the empty layout offers New space (owner ruling NP19). */
  admin?: boolean;
}

/** The sentence when the org has no live space to put a page in. */
export const NEW_DOC_NO_SPACE = "A page lives in a space, and this organization has none yet. An admin creates one from the Library.";

// ── the template icons (24×24, stroked; the design's line set) ──────────────
const TEMPLATE_ICON_PATHS: Record<string, readonly string[]> = {
  book: ["M4 5.5A1.5 1.5 0 0 1 5.5 4H11v15H5.5A1.5 1.5 0 0 0 4 20.5z", "M20 5.5A1.5 1.5 0 0 0 18.5 4H13v15h5.5a1.5 1.5 0 0 1 1.5 1.5z"],
  checklist: ["M10 6h10", "M10 12h10", "M10 18h10", "M3.5 6l1.5 1.5L7.5 5", "M3.5 12l1.5 1.5 2.5-2.5", "M3.5 18l1.5 1.5 2.5-2.5"],
  table: ["M4 4h16v16H4z", "M4 10h16", "M4 15h16", "M10 4v16"],
  "life-ring": ["M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z", "M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8z", "M5.6 5.6l3.6 3.6", "M14.8 14.8l3.6 3.6", "M18.4 5.6l-3.6 3.6", "M9.2 14.8l-3.6 3.6"],
  ruler: ["M3 17L17 3l4 4L7 21z", "M7 13l2 2", "M10 10l2 2", "M13 7l2 2"],
  target: ["M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z", "M12 7a5 5 0 1 0 0 10a5 5 0 1 0 0-10z", "M12 11a1 1 0 1 0 0 2a1 1 0 1 0 0-2z"],
  scales: ["M12 4v16", "M7 20h10", "M5 7h14", "M5 7l-3 6a3 3 0 0 0 6 0z", "M19 7l-3 6a3 3 0 0 0 6 0z"],
  sprout: ["M12 21v-9", "M12 12C12 8 9 6 4 6c0 4 3 6 8 6z", "M12 14c0-3 2.5-5 7-5 0 3.5-2.5 5-7 5z"],
  page: ["M6 3h7l5 5v13H6z", "M13 3v5h5"],
};
const svg = (paths: readonly string[], size: number, stroke = 1.8): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths.map((d) => `<path d="${d}"></path>`).join("")}</svg>`;
/** A template's line icon. */
export const templateIcon = (icon: string, size = 16): string => svg(TEMPLATE_ICON_PATHS[icon] ?? TEMPLATE_ICON_PATHS.page, size);

const CHEV = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg>`;
const CARET = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>`;
const CHECK = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"></path></svg>`;

// ── "Goes in" ────────────────────────────────────────────────────────────────

/** "Space › Ancestor › Parent" — where the page goes, in words. A parent not in the read (yet) is left out. */
export function whereLabel(d: NewDocDraft, spaces: readonly SpaceDTO[], pages: readonly LibraryPageDTO[] | null): string {
  const sp = spaces.find((s) => s.slug === d.space);
  const name = sp?.name ?? d.space;
  if (!d.parent || !pages) return name;
  const tree = buildTree(pages);
  const parent = tree.bySlug.get(d.parent);
  if (!parent) return name;
  return [name, ...ancestorsOf(tree, d.parent).map((a) => a.title), parent.title].join(" › ");
}

/** The space picker past NEW_DOC_SPACE_SWITCH_MAX spaces (render.ts adds its menu to the root overlays). */
export function newDocSpaceDropdown(d: NewDocDraft, spaces: readonly SpaceDTO[]): DropdownProps {
  const opts = spaces.map((s) => ({ value: s.slug, label: s.name }));
  if (d.space && !spaces.some((s) => s.slug === d.space)) opts.push({ value: d.space, label: d.space });
  return { id: "nd-space", act: "ndWhereSpace", value: d.space, ariaLabel: "Space", fill: true, options: opts };
}

function spacePicker(p: NewDocProps): string {
  const d = p.draft;
  if (p.spaces.length <= NEW_DOC_SPACE_SWITCH_MAX) {
    return segmented({ id: "nd-space", ariaLabel: "Space", act: "ndWhereSpace", value: d.space, size: "sm", fill: true, options: p.spaces.map((s) => ({ value: s.slug, label: s.name })) });
  }
  return dropdown(newDocSpaceDropdown(d, p.spaces), p.dd);
}

function pickerRow(d: NewDocDraft, o: { slug: string | null; label: string; depth: number; chev: string; mark?: string }): string {
  const on = o.slug === d.parent;
  return `<div class="cnpy-nd-wrow${on ? " is-on" : ""}" style="padding-left:${10 + o.depth * 16}px;border-radius:6px">
      ${o.chev}<button type="button" role="option" aria-selected="${on}" data-act="ndWhereParent" data-arg="${attr(o.slug ?? "")}" class="cnpy-nd-wpick"><span class="cnpy-nd-wt">${esc(o.label)}</span>${o.mark ?? ""}</button><span class="cnpy-nd-wck" aria-hidden="true">${on ? CHECK : ""}</span>
    </div>`;
}

function pickerRows(p: NewDocProps): string {
  const d = p.draft;
  const sp = p.spaces.find((s) => s.slug === d.space);
  const empty = `<span class="cnpy-nd-wchev is-empty"></span>`;
  const top = pickerRow(d, { slug: null, label: `Top level of ${sp?.name ?? d.space}`, depth: 0, chev: empty });
  if (p.pages === null) {
    return top + skList(4, (i) => `<div class="cnpy-nd-wrow" style="padding-left:${26 + (i % 2) * 16}px;border-radius:6px">${empty}${skLine(skW(i, ["58%", "44%", "62%", "50%"]), 12.5, 1.5, "flex:1")}</div>`);
  }
  const tree = buildTree(p.pages);
  const open = new Set(Object.keys(d.whereOpen).filter((k) => d.whereOpen[k]));
  const rows = flattenTree(tree, d.space, open).map((r) => {
    const exp = open.has(r.node.slug);
    const chev = r.hasChildren
      ? `<button type="button" data-act="ndWhereToggle" data-arg="${attr(r.node.slug)}" class="cnpy-nd-wchev${exp ? " is-open" : ""}" aria-expanded="${exp}" aria-label="${exp ? "Hide" : "Show"} the pages under ${attr(r.node.title)}">${CHEV}</button>`
      : empty;
    const mark = r.node.authority !== "live" ? `<span class="cnpy-nd-wmark">${authorityMark(r.node.authority, 11)}</span>` : "";
    return pickerRow(d, { slug: r.node.slug, label: r.node.title, depth: r.depth + 1, chev, mark });
  }).join("");
  return top + rows;
}

function wherePicker(p: NewDocProps): string {
  return `<div class="cnpy-nd-where" role="dialog" aria-label="Where the page goes" style="border-radius:10px">
    <div style="padding:10px 10px 8px">${spacePicker(p)}</div>
    <div class="cnpy-nd-wlist cnpy-scroll" role="listbox" aria-label="Put it inside" data-scroll-keep="nd-where">${pickerRows(p)}</div>
    <div class="cnpy-nd-wfoot"><button type="button" data-act="ndWhereDone" class="cnpy-accentbtn" style="padding:5px 12px;border-radius:7px;background:var(--accent);color:var(--accent-fg);font-size:12px;font-weight:600">Done</button></div>
  </div>`;
}

function goesIn(p: NewDocProps): string {
  const d = p.draft;
  const sp = p.spaces.find((s) => s.slug === d.space);
  return `<div class="cnpy-nd-goes">
    <span style="font-size:13px;color:var(--fg-55)">Goes in</span>
    <div class="cnpy-nd-anchor">
      <button type="button" data-act="ndWhere" data-field="nd-where" class="cnpy-nd-loc" aria-haspopup="dialog" aria-expanded="${d.where}" style="border-radius:7px">${sp ? spaceTile(sp, 16) : ""}<span class="cnpy-nd-locl">${esc(whereLabel(d, p.spaces, p.pages))}</span><span style="color:var(--fg-40);flex:none;display:inline-flex">${CARET}</span></button>
      ${d.where ? wherePicker(p) : ""}
    </div>
  </div>`;
}

// ── the templates ────────────────────────────────────────────────────────────

/** One template: its icon, name and description, and the sections it starts the page with. Picking it moves on. */
function templateCard(t: DocTemplate, on: boolean): string {
  const secs = t.sections.length ? t.sections.join(" · ") : "No sections: start from an empty page.";
  return `<button type="button" role="radio" aria-checked="${on}" data-act="ndTemplate" data-arg="${t.id}" data-tpl="${t.id}" class="cnpy-nd-tpl${on ? " is-on" : ""}${t.id === "blank" ? " is-blank" : ""}" style="border-radius:10px">
    <span class="cnpy-nd-tpli" style="border-radius:8px">${templateIcon(t.icon, 16)}</span>
    <span class="cnpy-nd-tpln">${esc(t.name)}</span>
    <span class="cnpy-nd-tpld">${esc(t.description)}</span>
    <span class="cnpy-nd-tplsec">${esc(secs)}</span>
  </button>`;
}

// ── the screen ───────────────────────────────────────────────────────────────

/** ONE frame for both steps, so the page keeps its width when the step changes. */
const FRAME = "max-width:880px;margin:0 auto;padding:28px 36px 90px";
const FIELD = "display:block;width:100%;box-sizing:border-box;border:1px solid var(--border-strong);border-radius:7px;background:var(--surface);color:var(--fg);outline:none";
const LABEL = "display:block;font-size:12.5px;font-weight:500;color:var(--fg-70);margin:18px 0 6px";

const fromBanner = (d: NewDocDraft): string =>
  d.from !== null
    ? `<div class="cnpy-surface" style="border-left:2px solid var(--accent);padding:11px 15px;margin-top:16px;display:flex;gap:10px;align-items:baseline;flex-wrap:wrap">
      <div style="font-family:var(--label);font-size:10px;font-weight:600;letter-spacing:.06em;color:var(--accent);flex:none">FROM HANDOFF</div>
      <div style="font-size:12.5px;color:var(--fg-70);flex:1">Prefilled from handoff #${d.from}. Edit anything before staging.</div>
      <button data-act="openHandoff" data-arg="${d.from}" class="cnpy-link" style="font-size:12.5px;font-weight:500;color:var(--accent)">Open handoff</button>
    </div>`
    : "";

/** The step count at the top of both steps: "Step 1 of 2 · Template", and two bars that fill as the person moves
 *  on. Template is a way back from step 2. Stays in place across the steps (only the step's block is swapped). */
function stepCount(n: 1 | 2, busy: boolean): string {
  const name = n === 1 ? "Template" : "Details";
  const back = n === 2
    ? `<button type="button" data-act="ndStep" data-arg="template" class="cnpy-nd-bar is-done" aria-label="Step 1: Template — go back"${busy ? " disabled" : ""}></button>`
    : `<span class="cnpy-nd-bar is-on" aria-hidden="true"></span>`;
  return `<div class="cnpy-nd-count">
    <p class="cnpy-nd-countl" aria-live="polite"><span style="color:var(--fg)">Step ${n} of 2</span> · ${name}</p>
    <div class="cnpy-nd-bars">${back}<span class="cnpy-nd-bar${n === 2 ? " is-on" : ""}" aria-hidden="true"></span></div>
  </div>`;
}

/** Step 1: the template cards, the whole page. */
function templateStep(t: DocTemplate): string {
  const cards = DOC_TEMPLATES.map((x) => templateCard(x, x.id === t.id)).join("");
  return `<div class="cnpy-nd-step cnpy-nd-s1" data-morph-key="nd-step:template">
  <h1 id="nd-tpl-l" style="font-size:22px;font-weight:650;letter-spacing:-0.02em;line-height:1.25;margin:0">Pick a template</h1>
  <p style="font-size:13px;line-height:1.5;color:var(--fg-55);margin:6px 0 0">It starts the page with its sections. You write the page next.</p>
  <div class="cnpy-nd-tpls" role="radiogroup" aria-labelledby="nd-tpl-l">${cards}</div>
</div>`;
}

/** Step 2: the template picked, where the page goes, its title, section and body, and Create page. */
function detailsStep(p: NewDocProps, t: DocTemplate): string {
  const d = p.draft;
  const sections = p.sections.includes(d.section) || !d.section ? p.sections : [...p.sections, d.section];
  const err = d.error ? `<p role="alert" class="cnpy-nd-err">${esc(d.error)}</p>` : "";
  return `<div class="cnpy-nd-step cnpy-nd-s2" data-morph-key="nd-step:details">
  <h1 style="font-size:22px;font-weight:650;letter-spacing:-0.02em;line-height:1.25;margin:0">New page</h1>
  ${fromBanner(d)}
  <div class="cnpy-nd-chosen" style="border-radius:10px">
    <span class="cnpy-nd-tpli" style="border-radius:8px;margin:0">${templateIcon(t.icon, 16)}</span>
    <span style="min-width:0;flex:1"><span class="cnpy-nd-tpln" style="display:block">${esc(t.name)}</span><span class="cnpy-nd-tpld" style="display:block">${esc(t.description)}</span></span>
    <button type="button" data-act="ndStep" data-arg="template" class="cnpy-link" style="flex:none;padding:0;font-size:12.5px;font-weight:500;color:var(--accent)"${d.busy ? " disabled" : ""}>Change template</button>
  </div>
  ${goesIn(p)}
  <label for="nd-title" style="${LABEL}">Title</label>
  <input id="nd-title" data-act="ndField" data-arg="title" data-field="nd-title" value="${attr(d.title)}" class="cnpy-input" placeholder="${attr(untitledTitle(t))}" autocomplete="off" maxlength="200"${d.busy ? " disabled" : ""} style="${FIELD};height:38px;padding:0 12px;font-size:14px">
  <div style="${LABEL}">Section</div>
  ${segmented({ id: "nd-section", ariaLabel: "Section", act: "ndSection", value: d.section, size: "sm", options: sections.map((s) => ({ value: s, label: s })) })}
  <label for="nd-body" style="${LABEL}">Body <span style="font-weight:400;color:var(--fg-40)">Markdown</span></label>
  <textarea id="nd-body" data-act="ndField" data-arg="body" data-field="nd-body" rows="16"${d.busy ? " disabled" : ""} style="${FIELD};padding:10px 12px;font-size:12.5px;line-height:1.6;resize:vertical;font-family:var(--code)">${esc(d.body)}</textarea>
  ${err}
  <div class="cnpy-nd-foot">
    <span style="font-size:12px;line-height:1.5;color:var(--fg-40)">It waits in Review, like an agent's change. Nothing is live until someone approves it.</span>
    <button type="button" data-act="ndSubmit" class="${d.busy ? "" : "cnpy-accentbtn"}"${d.busy ? ' disabled aria-busy="true"' : ""} style="${primaryStyle(!d.busy)};flex:none">${d.busy ? "Creating…" : "Create page"}</button>
  </div>
</div>`;
}

export function newDocView(p: NewDocProps): string {
  if (p.spaces.length === 0) {
    return `<div class="cnpy-nd" data-screen-label="New page" style="${FRAME}"><h1 style="font-size:22px;font-weight:650;letter-spacing:-0.02em;line-height:1.25;margin:0">New page</h1>
      <div style="margin-top:22px">${emptyLayout("newdoc", { title: "No spaces yet", text: NEW_DOC_NO_SPACE, action: p.admin ? { label: "New space", act: "libNew" } : null })}</div>
    </div>`;
  }
  const t = docTemplate(p.draft.template) ?? (docTemplate(DEFAULT_DOC_TEMPLATE) as DocTemplate);
  const two = p.draft.step === "details";
  // The frame and the step count stay; only the step's own block is swapped, and it slides in from the side the
  // person moved toward (trov.css `.cnpy-nd-step[data-dir]`; off under reduced motion).
  return `<div class="cnpy-nd" data-screen-label="New page" data-step="${two ? 2 : 1}" style="${FRAME}">
  ${stepCount(two ? 2 : 1, p.draft.busy)}
  <div class="cnpy-nd-stage"${p.draft.dir ? ` data-dir="${p.draft.dir}"` : ""}>${two ? detailsStep(p, t) : templateStep(t)}</div>
</div>`;
}

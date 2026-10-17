// The Docs Library's Markdown import — its two screens (docs/architecture/docs-library.md › The import screens):
// the wizard (`#import`, the screen `import`: Where → Files → Preview → Import) and Imports history (`#imports`, the
// screen `imports`). Ported from the Claude Design Library prototype (spec §8 and §11), built from Trov's own pieces:
// `segmented()` for every pick-one, `emptyLayout` / `skeleton` for the two states, the run marks of marks.ts,
// people.ts for every person, `hitArea` for a row that opens. Pure: props in, markup out; the reads, the file reading
// and the run itself are web/src/import-actions.ts.
//
// The plan the Preview shows is the SHARED planner's (shared/docs-import-core.ts `planImport`), run here over the
// files' manifest (paths, sizes, kinds, first headings — never their text) and the space's pages; the Worker runs
// the same planner again over what it is sent, so this one is advisory.
import {
  planImport, planSummary, applyConflictChoices, commonChoice, renameSuggestion, fileSizeWords, importFailureText,
  SKIP_REASONS, IMPORT_ACCEPT, DEFAULT_CONFLICT_CHOICE,
  type ImportFile, type ImportPlan, type PlanOptions, type ConflictChoice, type ConflictResolution, type ImportRunView,
  type SkippedFile, type PlannedPage, type ImportWrite,
} from "@shared/docs-import-core";
import { buildTree, ancestorsOf, flattenTree } from "@shared/docs-tree-core";
import { pagesWord, type LibraryDTO, type LibraryPageDTO, type SpaceDTO } from "@shared/docs-core";
import type { PersonSummary } from "@shared/people";
import { esc, attr, surface, hitArea, HITBOX } from "./ui";
import { segmented } from "./segmented";
import { spaceTile, pageIcon, libraryWhen } from "./library";
import { importRunMark, importFlagMark, authorityMark, glyph, type ImportMarkKey } from "./marks";
import { personAvatarLink } from "./people";
import { skeleton, skBar, skBox, skLine, skList, skW, emptyLayout } from "./skeleton";

// ── state ────────────────────────────────────────────────────────────────────

export type ImportStep = "where" | "files" | "preview" | "run";
export const IMPORT_STEPS: readonly ImportStep[] = ["where", "files", "preview", "run"];
const STEP_LABEL: Record<ImportStep, string> = { where: "Where", files: "Files", preview: "Preview", run: "Import" };

/** One thing the person picked or dropped: a Markdown file, or a .zip of them. */
export interface ImportPick {
  id: number;
  name: string;
  size: number;
  kind: "md" | "zip" | "other";
  /** Being read, read, or refused (`error` says why). */
  state: "reading" | "ready" | "bad";
  error: string | null;
  /** A zip's files (directory entries left out), once its index is read. */
  inside: number | null;
}

/** The links and images the files hold, counted once they are read (import-actions.ts `countLinks`). */
export interface ImportLinks {
  total: number;
  /** Relative links that land on a page of this import. */
  inImport: number;
  /** `[[slug]]` links the files already carry: to pages in Trov. */
  existing: number;
  /** `[[slug]]` links to no page of the organization (yet): they stay links, and work once that page exists. */
  missing: number;
  /** Relative links to files the import does not have (they stay as plain text). */
  unmatched: number;
  /** Images some page uses (only those are uploaded). */
  imagesUsed: number;
}

/** The run this tab drives (import-actions.ts): where it is, and the server's last word on it. */
export interface ImportDriverView {
  id: number | null;
  phase: "starting" | "images" | "pages" | "finishing" | "stalled" | "done" | "stopped";
  source: string;
  space: string;
  spaceName: string;
  pages: number;
  pagesDone: number;
  images: number;
  imagesDone: number;
  /** The file being sent now. */
  current: string | null;
  /** Why it stalled (a batch that did not get through: Retry resends it) or stopped. */
  error: string | null;
  run: ImportRunView | null;
}

export type ImportsFilter = "all" | "running" | "done" | "failed";

/** The import screens' own state (`state.imp`). Never a file's text: that stays in import-actions.ts. */
export interface ImportUi {
  step: ImportStep;
  space: string | null;
  /** The page everything goes under (null = the space's top level). */
  parent: string | null;
  /** The "Inside a page" rows that are open, by slug. */
  whereOpen: Record<string, boolean>;
  picks: ImportPick[];
  /** What was read from the picks: every file's path, size, kind and — for Markdown — first heading. */
  files: ImportFile[];
  /** Markdown files that are not readable text: left out of `files`, listed as "won't be imported". */
  unreadable: string[];
  links: ImportLinks | null;
  /** Files are dragged over the Files step's drop zone. */
  dragOver: boolean;
  /** The conflict choices by page key (none = a new version), and the renames typed. */
  choices: Record<string, ConflictChoice>;
  renames: Record<string, string>;
  /** The start is out. */
  busy: boolean;
  /** Why the start was refused. */
  error: string | null;
  run: ImportDriverView | null;
  // Imports history
  filter: ImportsFilter;
  /** The run whose details are open (one at a time). */
  open: number | null;
  /** The run whose Cancel import is out. */
  cancelling: number | null;
}

export const initialImportUi = (): ImportUi => ({
  step: "where", space: null, parent: null, whereOpen: {}, picks: [], files: [], unreadable: [], links: null, dragOver: false,
  choices: {}, renames: {}, busy: false, error: null, run: null, filter: "all", open: null, cancelling: null,
});

/** The run is still going (a later step is not reached until it ends). */
export const driverActive = (r: ImportDriverView | null): boolean =>
  r !== null && r.phase !== "done" && r.phase !== "stopped";

// ── the plan ─────────────────────────────────────────────────────────────────

/** The space's existing pages, as the planner reads them. */
export function importPlanOptions(ui: Pick<ImportUi, "parent">, pages: readonly LibraryPageDTO[]): PlanOptions {
  const existingTitles = new Map<string, string>();
  for (const pg of pages) {
    const k = pg.title.trim().toLowerCase();
    if (!existingTitles.has(k)) existingTitles.set(k, pg.slug);
  }
  const tree = buildTree(pages);
  const parent = ui.parent && tree.bySlug.has(ui.parent) ? ui.parent : null;
  return { existingTitles, existingSlugs: new Set(pages.map((p) => p.slug)), parentSlug: parent, parentDepth: parent ? ancestorsOf(tree, parent).length : 0 };
}

export function importPlanFor(ui: Pick<ImportUi, "files" | "parent">, pages: readonly LibraryPageDTO[]): ImportPlan {
  return planImport(ui.files, importPlanOptions(ui, pages));
}

/** The conflict choices as `POST /imports` takes them: every conflict's, a rename with its title. */
export function importChoices(ui: Pick<ImportUi, "choices" | "renames">, plan: Pick<ImportPlan, "conflicts">, source: string): Record<string, ConflictResolution> {
  const out: Record<string, ConflictResolution> = {};
  for (const c of plan.conflicts) {
    const ch = ui.choices[c.key] ?? DEFAULT_CONFLICT_CHOICE;
    out[c.key] = ch === "rename" ? { choice: "rename", title: (ui.renames[c.key] ?? "").trim() || renameSuggestion(c.title, source) } : { choice: ch };
  }
  return out;
}

/** What the person picked, in words: the one file's name, else "‹N› files". */
export function importSourceName(picks: readonly ImportPick[]): string {
  const ok = picks.filter((p) => p.state !== "bad");
  return ok.length === 1 ? ok[0].name : `${ok.length} files`;
}

/** The files' skipped list, with the unreadable Markdown files the browser left out. */
export function importSkipped(plan: Pick<ImportPlan, "skipped">, unreadable: readonly string[]): SkippedFile[] {
  return [...plan.skipped, ...unreadable.map((path) => ({ path, code: "not_utf8" as const, reason: SKIP_REASONS.not_utf8 }))];
}

// ── words ────────────────────────────────────────────────────────────────────

/** The caps, as the design says them. */
export const IMPORT_CAPS = "Up to 500 files or 50 MB";
/** Why the whole plan is refused. */
export const PLAN_ERROR_TEXT: Record<NonNullable<ImportPlan["error"]>, string> = {
  too_many_files: "That's more than 500 files. Up to 500 files or 50 MB can be imported at once.",
  too_large: "Those files are over 50 MB. Up to 500 files or 50 MB can be imported at once.",
  no_markdown: "There's no Markdown file to import here. Add .md files, or a .zip that has them.",
};
export const IMPORT_NO_SPACE = "Pages are imported into a space, and this organization has none yet. An admin creates one from the Library.";
export const IMPORTS_EMPTY = "Import Markdown files or a .zip of them, and each run is listed here with what was added and what was skipped.";
const IMPORTS_SUB = "Every Markdown import into the library, newest first.";
const LEAVE_OK = "You can leave this page. The import keeps going.";
/** A stalled run waits for the person: nothing goes on until Retry. */
const STALLED_NOTE = "Nothing more is sent until you press Retry.";

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const pagesN = (n: number): string => plural(n, "page", "pages");

/** "38 links: 31 point to pages in this import, 5 to pages already in Trov, and 2 to files that aren't in the zip.
 *  Those 2 stay as plain text." — the parts that are not zero. */
export function linkWords(l: ImportLinks, zip: boolean): string {
  if (l.total === 0) return "No page links to another.";
  const parts: string[] = [];
  if (l.inImport) parts.push(`${l.inImport} ${parts.length ? "" : `${l.inImport === 1 ? "points" : "point"} `}to ${l.inImport === 1 ? "a page" : "pages"} in this import`);
  if (l.existing) parts.push(`${l.existing} ${parts.length ? "" : `${l.existing === 1 ? "points" : "point"} `}to ${l.existing === 1 ? "a page" : "pages"} already in Trov`);
  if (l.missing) parts.push(`${l.missing} ${parts.length ? "" : `${l.missing === 1 ? "points" : "point"} `}to ${l.missing === 1 ? "a page that isn't" : "pages that aren't"} in Trov yet`);
  if (l.unmatched) parts.push(`${l.unmatched} ${parts.length ? "" : `${l.unmatched === 1 ? "points" : "point"} `}to ${l.unmatched === 1 ? "a file that isn't" : "files that aren't"} in the ${zip ? "zip" : "files"}`);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}` : parts[0];
  const tail = l.unmatched ? ` ${l.unmatched === 1 ? "That one stays" : `Those ${l.unmatched} stay`} as plain text.` : "";
  return `${plural(l.total, "link", "links")}: ${list.replace(/ {2,}/g, " ")}.${tail}`;
}

/** "14 images are uploaded with the pages that use them." */
export function imageWords(found: number, used: number): string {
  if (found === 0) return "There are no images.";
  const left = found - used;
  const head = used === 0 ? "No page uses an image, so none is uploaded." : `${plural(used, "image is", "images are")} uploaded with the pages that use them.`;
  return left > 0 && used > 0 ? `${head} ${plural(left, "image no page uses is", "images no page uses are")} left out.` : head;
}

// ── icons ────────────────────────────────────────────────────────────────────

const ic = (d: string, size = 14, stroke = 1.8): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
/** The upload arrow (the sidebar's Import, the drop zone, the review group). */
export const UPLOAD_ICON = (size = 14): string => ic(`<path d="M12 15V4"></path><path d="m7 9 5-5 5 5"></path><path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"></path>`, size);
/** The clock-with-a-back-arrow: Imports history. */
export const HISTORY_ICON = (size = 14): string => ic(`<path d="M3 12a9 9 0 1 0 3-6.7L3 8"></path><path d="M3 3v5h5"></path><path d="M12 7v5l3 2"></path>`, size);
const ZIP_ICON = (size = 16): string => ic(`<path d="M6 3h7l5 5v13H6z"></path><path d="M13 3v5h5"></path><path d="M10 7h1M10 10h1M10 13h1M10 16v2h1v-2z"></path>`, size);
const FOLDER_ICON = (size = 14): string => ic(`<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>`, size);
const INFO_ICON = ic(`<circle cx="12" cy="12" r="9"></circle><path d="M12 11v5M12 8h.01"></path>`, 14, 2);
const CHECK = ic(`<path d="M20 6 9 17l-5-5"></path>`, 12, 2.8);
const X_ICON = ic(`<path d="M18 6 6 18M6 6l12 12"></path>`, 13, 2.2);
const CHEV = ic(`<path d="M9 6l6 6-6 6"></path>`, 10, 2.6);
const ALERT = ic(`<circle cx="12" cy="12" r="9"></circle><path d="M12 7.5v5.5M12 16.5h.01"></path>`, 13, 2);
/** A small spinner; still under reduced motion (trov.css `.cnpy-imp-spin`). */
const SPIN = `<svg class="cnpy-imp-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.6" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9" stroke-linecap="round"></path></svg>`;

const btnPrimary = (act: string, label: string, enabled = true, extra = ""): string =>
  `<button type="button"${enabled ? ` data-act="${attr(act)}"` : " disabled"}${extra} class="${enabled ? "cnpy-accentbtn" : "cnpy-imp-off"}" style="display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border-radius:8px;border:1px solid ${enabled ? "transparent" : "var(--border)"};background:${enabled ? "var(--accent)" : "transparent"};color:${enabled ? "var(--accent-fg)" : "var(--fg-40)"};font-size:12.5px;font-weight:600;white-space:nowrap">${label}</button>`;
const btnOutline = (act: string, label: string, arg: string | null = null, extra = ""): string =>
  `<button type="button" data-act="${attr(act)}"${arg !== null ? ` data-arg="${attr(arg)}"` : ""}${extra} class="cnpy-outlinebtn" style="display:inline-flex;align-items:center;gap:6px;padding:7px 13px;border-radius:8px;border:1px solid var(--border-strong);background:var(--surface);font-size:12.5px;font-weight:500;color:var(--fg-70);white-space:nowrap">${label}</button>`;
const btnQuiet = (act: string, label: string, arg: string | null = null): string =>
  `<button type="button" data-act="${attr(act)}"${arg !== null ? ` data-arg="${attr(arg)}"` : ""} class="cnpy-link" style="padding:7px 4px;font-size:12.5px;font-weight:500;color:var(--fg-55);white-space:nowrap">${label}</button>`;
const H2 = "font-size:19px;font-weight:600;letter-spacing:-0.015em;line-height:1.3;margin:0";
const SUB = "font-size:13.5px;line-height:1.5;color:var(--fg-70);margin:6px 0 0";
const LABEL = "font-size:13px;font-weight:500;color:var(--fg);margin:22px 0 10px;display:flex;align-items:baseline;gap:8px";

// ── the wizard (`#import`) ───────────────────────────────────────────────────

export interface ImportWizardProps {
  ui: ImportUi;
  library: { status: string; data: LibraryDTO | null };
  /** The picked space's pages; null while that read is out (or no space is picked). */
  pages: LibraryPageDTO[] | null;
  /** An admin of the org: with no space yet, the empty layout offers New space. */
  admin?: boolean;
}

/** The four steps: done ones a check, the current one the accent number, later ones quiet. The progress and done
 *  cards both sit on the fourth; once the run is done all four are done. */
export function importStepper(step: ImportStep, allDone: boolean): string {
  const at = IMPORT_STEPS.indexOf(step);
  const items = IMPORT_STEPS.map((s, i) => {
    const state = allDone || i < at ? "done" : i === at ? "now" : "next";
    const dot = state === "done" ? CHECK : String(i + 1);
    const line = i < IMPORT_STEPS.length - 1 ? `<span class="cnpy-imp-line" data-s="${allDone || i < at ? "done" : "next"}" aria-hidden="true"></span>` : "";
    return `<li class="cnpy-imp-step" data-s="${state}"${state === "now" ? ' aria-current="step"' : ""}><span class="cnpy-imp-dot" style="border-radius:50%" aria-hidden="true">${dot}</span><span class="cnpy-imp-sl">${esc(STEP_LABEL[s])}</span>${state === "done" ? '<span class="cnpy-sr">, done</span>' : ""}</li>${line}`;
  }).join("");
  return `<ol class="cnpy-imp-steps" aria-label="Import steps">${items}</ol>`;
}

const FRAME = "max-width:1040px;margin:0 auto;padding:28px 40px 120px";
const NARROW = "max-width:720px";

/** "Space › Ancestor › Parent". */
function whereWords(ui: ImportUi, spaces: readonly SpaceDTO[], pages: readonly LibraryPageDTO[] | null): string {
  const name = spaces.find((s) => s.slug === ui.space)?.name ?? ui.space ?? "";
  if (!ui.parent || !pages) return name;
  const tree = buildTree(pages);
  const parent = tree.bySlug.get(ui.parent);
  return parent ? [name, ...ancestorsOf(tree, ui.parent).map((a) => a.title), parent.title].join(" › ") : name;
}

function whereStep(p: ImportWizardProps, spaces: SpaceDTO[]): string {
  const ui = p.ui;
  const cards = spaces.map((sp) => {
    const on = sp.slug === ui.space;
    return `<button type="button" role="radio" aria-checked="${on}" data-act="impSpace" data-arg="${attr(sp.slug)}" class="cnpy-imp-sp${on ? " is-on" : ""}" style="border-radius:8px">
      ${spaceTile(sp, 24)}<span class="cnpy-imp-spt"><span class="cnpy-imp-spn">${esc(sp.name)}</span><span class="cnpy-imp-spc">${esc(pagesWord(sp.pages))}</span></span><span class="cnpy-imp-ck" aria-hidden="true">${on ? CHECK : ""}</span>
    </button>`;
  }).join("");
  const sp = spaces.find((s) => s.slug === ui.space) ?? null;
  const empty = `<span class="cnpy-nd-wchev is-empty"></span>`;
  const row = (slug: string | null, label: string, depth: number, chev: string, mark = ""): string => {
    const on = slug === ui.parent;
    return `<div class="cnpy-nd-wrow${on ? " is-on" : ""}" style="padding-left:${10 + depth * 16}px;border-radius:6px">${chev}<button type="button" role="option" aria-selected="${on}" data-act="impParent" data-arg="${attr(slug ?? "")}" class="cnpy-nd-wpick"><span class="cnpy-nd-wt">${esc(label)}</span>${mark}</button><span class="cnpy-nd-wck" aria-hidden="true">${on ? CHECK : ""}</span></div>`;
  };
  let tree = "";
  if (sp) {
    const top = row(null, `Top level of ${sp.name}`, 0, empty);
    if (p.pages === null) {
      tree = top + skList(4, (i) => `<div class="cnpy-nd-wrow" style="padding-left:${26 + (i % 2) * 16}px;border-radius:6px">${empty}${skLine(skW(i, ["58%", "44%", "62%", "50%"]), 12.5, 1.5, "flex:1")}</div>`);
    } else {
      const t = buildTree(p.pages);
      const open = new Set(Object.keys(ui.whereOpen).filter((k) => ui.whereOpen[k]));
      tree = top + flattenTree(t, sp.slug, open).map((r) => {
        const exp = open.has(r.node.slug);
        const chev = r.hasChildren
          ? `<button type="button" data-act="impWhereToggle" data-arg="${attr(r.node.slug)}" class="cnpy-nd-wchev${exp ? " is-open" : ""}" aria-expanded="${exp}" aria-label="${exp ? "Hide" : "Show"} the pages under ${attr(r.node.title)}">${CHEV}</button>`
          : empty;
        const mark = r.node.authority !== "live" ? `<span class="cnpy-nd-wmark">${authorityMark(r.node.authority, 11)}</span>` : "";
        return row(r.node.slug, r.node.title, r.depth + 1, chev, mark);
      }).join("");
    }
  }
  return `<div data-morph-key="imp:where" style="${NARROW}">
    <h2 class="cnpy-imp-h" tabindex="-1" style="${H2}">Where should the pages go?</h2>
    <p style="${SUB}">Pick a space. You can also put everything inside a page that already exists.</p>
    <div id="imp-space-l" style="${LABEL}">Space</div>
    <div class="cnpy-imp-sps" role="radiogroup" aria-labelledby="imp-space-l">${cards}</div>
    ${sp ? `<div style="${LABEL}"><span id="imp-parent-l">Inside a page</span><span style="font-size:12px;font-weight:400;color:var(--fg-40)">Optional</span></div>
    <div${surface("padding:6px")}><div class="cnpy-imp-tree cnpy-scroll" role="listbox" aria-labelledby="imp-parent-l" data-scroll-keep="imp-where">${tree}</div></div>` : ""}
    <div class="cnpy-imp-stepfoot">
      <span style="font-size:12.5px;color:var(--fg-55);min-width:0">${sp ? `Pages will go in <strong style="font-weight:600;color:var(--fg)">${esc(whereWords(ui, spaces, p.pages))}</strong>` : "Pick a space first."}</span>
      <span style="display:flex;gap:8px;flex:none">${btnQuiet("goLibrary", "Cancel")}${btnPrimary("impStep", "Continue ›", sp !== null, ' data-arg="files"')}</span>
    </div>
  </div>`;
}

function pickRow(pk: ImportPick): string {
  const meta = pk.kind === "zip"
    ? `${fileSizeWords(pk.size)}${pk.inside !== null ? ` · ${plural(pk.inside, "file", "files")} inside` : " · zip"}`
    : `${fileSizeWords(pk.size)} · ${pk.kind === "md" ? "Markdown" : "not Markdown"}`;
  const state = pk.state === "reading"
    ? `<span class="cnpy-imp-rs">${SPIN}Reading…</span>`
    : pk.state === "ready"
      ? `<span class="cnpy-imp-rs" style="color:var(--green)">${glyph("done", "var(--green)", 13)}Ready</span>`
      : `<span class="cnpy-imp-rs" style="color:var(--red)">${ALERT}<span style="color:var(--fg-70)">${esc(pk.error ?? "This file can't be imported.")}</span></span>`;
  return `<div class="cnpy-imp-file" data-pick="${pk.id}">
    <span style="color:var(--fg-55);flex:none;display:inline-flex">${pk.kind === "zip" ? ZIP_ICON(18) : pageIcon(18)}</span>
    <span style="flex:1;min-width:0"><span style="display:block;font-size:13.5px;color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(pk.name)}</span><span style="display:block;font-size:12px;color:var(--fg-55)">${esc(meta)}</span></span>
    ${state}
    <button type="button" data-act="impRemove" data-arg="${pk.id}" class="cnpy-iconbtn" aria-label="Remove ${attr(pk.name)}" style="width:28px;height:28px;border-radius:7px;display:grid;place-items:center;color:var(--fg-40);flex:none">${X_ICON}</button>
  </div>`;
}

function filesStep(p: ImportWizardProps, spaces: SpaceDTO[]): string {
  const ui = p.ui;
  const ready = ui.picks.some((x) => x.state === "ready") && !ui.picks.some((x) => x.state === "reading");
  const list = ui.picks.length ? `<div${surface("padding:0;overflow:hidden;margin-top:14px")}>${ui.picks.map(pickRow).join("")}</div>` : "";
  const name = spaces.find((s) => s.slug === ui.space)?.name ?? ui.space ?? "";
  return `<div data-morph-key="imp:files" style="${NARROW}">
    <h2 class="cnpy-imp-h" tabindex="-1" style="${H2}">Add your files</h2>
    <p style="${SUB}">Markdown files (.md), or one .zip of Markdown files. Folders inside a zip become pages with the files nested under them.</p>
    <input type="file" multiple accept="${attr(IMPORT_ACCEPT)}" data-imp-file hidden tabindex="-1" aria-hidden="true">
    <div class="cnpy-imp-drop" data-imp-drop data-over="${ui.dragOver ? "1" : "0"}" style="border-radius:10px">
      <span class="cnpy-imp-dropic" style="border-radius:10px">${UPLOAD_ICON(20)}</span>
      <span style="font-size:14px;font-weight:500;color:var(--fg)">Drop files here</span>
      <span style="display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--fg-55)">or ${btnOutline("impChoose", "Choose files")}</span>
      <span style="font-size:11.5px;color:var(--fg-40)"><strong style="font-weight:600">${esc(IMPORT_CAPS)}</strong></span>
    </div>
    ${list}
    <div class="cnpy-imp-stepfoot">
      <span style="font-size:12.5px;color:var(--fg-55)">Going to <strong style="font-weight:600;color:var(--fg)">${esc(name)}</strong></span>
      <span style="display:flex;gap:8px;flex:none">${btnQuiet("impStep", "Back", "where")}${btnPrimary("impStep", "Check the files ›", ready, ' data-arg="preview"')}</span>
    </div>
  </div>`;
}

/** The Preview's pages tree, its conflicts, what won't be imported, the images and links, and the footer. */
function previewStep(p: ImportWizardProps, spaces: SpaceDTO[]): string {
  const ui = p.ui;
  const sp = spaces.find((s) => s.slug === ui.space) ?? null;
  const source = importSourceName(ui.picks);
  const head = `<h2 class="cnpy-imp-h" tabindex="-1" style="${H2}">Check what will be added</h2>
    <p style="${SUB}">From <strong style="font-weight:600;color:var(--fg)">${esc(source)}</strong> into <strong style="font-weight:600;color:var(--fg)">${esc(whereWords(ui, spaces, p.pages))}</strong>. Nothing is added until you confirm.</p>`;
  if (p.pages === null) {
    return `<div data-morph-key="imp:preview">${head}${skeleton("imp-preview", "Checking the files…", `<div style="margin-top:20px">${skBox("100%", 64)}</div><div class="cnpy-imp-pgrid" style="margin-top:14px"><div>${skList(8, (i) => `<div style="display:flex;align-items:center;gap:8px;height:32px;padding-left:${12 + (i % 3) * 18}px">${skBox(14, 14)}${skLine(skW(i), 13, 1.4, "flex:1")}</div>`)}</div><div>${skBox("100%", 180)}</div></div>`)}</div>`;
  }
  const plan = importPlanFor(ui, p.pages);
  const choices = ui.choices;
  const sum = planSummary(plan, choices);
  const writes = new Map<string, ImportWrite>(applyConflictChoices(plan, importChoices(ui, plan, source), source).map((w) => [w.key, w]));
  const conflictKeys = new Set(plan.conflicts.map((c) => c.key));
  const skipped = importSkipped(plan, ui.unreadable);
  // Each figure's words agree with it: "1 page to add", "2 pages to add" (an unknown count, "—", reads as many).
  const words = (n: number | string, one: string, many: string): [number | string, string] => [n, n === 1 ? one : many];
  const strip = [
    words(sum.pages, "page to add", "pages to add"), words(sum.conflicts, "title already exists", "titles already exist"),
    words(skipped.length, "file won't be imported", "files won't be imported"), words(sum.images, "image found", "images found"),
    words(ui.links ? ui.links.total : "—", "link found", "links found"),
  ].map(([n, l]) => `<div class="cnpy-imp-stat"><div style="font-size:20px;font-weight:600;letter-spacing:-0.01em;font-variant-numeric:tabular-nums">${esc(String(n))}</div><div style="font-size:12px;color:var(--fg-55)">${esc(String(l))}</div></div>`).join("");

  const rows = plan.pages.map((pg: PlannedPage) => {
    const w = writes.get(pg.key);
    const conflict = conflictKeys.has(pg.key);
    const choice: ConflictChoice | null = conflict ? choices[pg.key] ?? DEFAULT_CONFLICT_CHOICE : null;
    const flagKey = choice === "version" && w?.mode === "skip" ? "skip" : choice;
    const title = w && w.mode !== "skip" ? w.title : pg.title;
    return `<div class="cnpy-imp-prow${conflict ? " is-conflict" : ""}${flagKey === "skip" ? " is-skip" : ""}" style="padding-left:${12 + pg.depth * 18}px">
      <span style="color:var(--fg-40);flex:none;display:inline-flex">${pg.folder !== null ? FOLDER_ICON(14) : pageIcon(14)}</span>
      <span class="cnpy-imp-pt">${esc(title)}</span>
      <span class="cnpy-imp-pp">${esc(pg.path ?? `${pg.folder ?? ""}/`)}</span>
      ${flagKey ? `<span style="flex:none;margin-left:auto">${importFlagMark(flagKey, 11.5)}</span>` : ""}
    </div>`;
  }).join("");

  const pageBy = new Map(p.pages.map((pg) => [pg.slug, pg]));
  const existingPath = (slug: string): string => { const pg = pageBy.get(slug); return pg ? [...pg.path, pg.title].join(" › ") : slug; };
  const all = commonChoice(plan, choices);
  const conflictCard = plan.conflicts.length ? `<div${surface("padding:14px 16px")}>
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px"><h3 class="cnpy-imp-h3">Already in ${esc(sp?.name ?? ui.space ?? "")}</h3><span style="font-size:12px;color:var(--fg-55);font-variant-numeric:tabular-nums">${plan.conflicts.length}</span></div>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:10px;font-size:12px;color:var(--fg-55)">For all
        ${segmented({ id: "imp-all", ariaLabel: "For every title that already exists", act: "impAll", value: all === "skip" || all === "version" ? all : "", size: "xs", options: [{ value: "skip", label: "Skip all" }, { value: "version", label: "New version for all" }] })}
      </div>
      ${plan.conflicts.map((c, i) => {
        const ch = choices[c.key] ?? DEFAULT_CONFLICT_CHOICE;
        const rename = ch === "rename" ? `<input data-act="impRename" data-arg="${attr(c.key)}" data-field="imp-rn:${attr(c.key)}" value="${attr(ui.renames[c.key] ?? renameSuggestion(c.title, source))}" aria-label="New title for ${attr(c.title)}" maxlength="200" autocomplete="off" class="cnpy-input" style="display:block;width:100%;box-sizing:border-box;height:30px;margin-top:8px;padding:0 10px;border:1px solid var(--border-strong);border-radius:7px;background:var(--surface);color:var(--fg);font-size:12.5px">` : "";
        return `<div class="cnpy-imp-conf">
          <div style="display:flex;align-items:center;gap:7px;font-size:13px;color:var(--fg);min-width:0">${glyph("warn", "var(--amber)", 13)}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.title)}</span></div>
          <div style="font-size:12px;color:var(--fg-55);margin:3px 0 8px">Already at ${esc(existingPath(c.existingSlug))}</div>
          ${segmented({ id: `imp-c-${i}`, ariaLabel: `What to do with ${c.title}`, act: "impChoice", value: ch, size: "xs", fill: true, options: (["skip", "version", "rename"] as const).map((v) => ({ value: v, label: v === "skip" ? "Skip" : v === "version" ? "Add as new version" : "Rename", arg: `${v}:${c.key}`, tone: "accent" as const })) })}
          ${rename}
        </div>`;
      }).join("")}
    </div>` : "";
  const skippedCard = skipped.length ? `<div${surface("padding:14px 16px")}>
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px"><h3 class="cnpy-imp-h3">Won't be imported</h3><span style="font-size:12px;color:var(--fg-55);font-variant-numeric:tabular-nums">${skipped.length}</span></div>
      ${skipped.map((s) => `<div class="cnpy-imp-skip">${glyph("declined", "var(--fg-40)", 12)}<span style="min-width:0"><span style="display:block;font-size:11.5px;color:var(--fg);overflow-wrap:anywhere">${esc(s.path)}</span><span style="display:block;font-size:12px;color:var(--fg-55)">${esc(s.reason)}</span></span></div>`).join("")}
    </div>` : "";
  const zip = ui.picks.some((x) => x.kind === "zip" && x.state === "ready");
  const linksCard = `<div${surface("padding:14px 16px")}>
      <h3 class="cnpy-imp-h3">Images and links</h3>
      <p style="font-size:12.5px;line-height:1.55;color:var(--fg-70);margin:8px 0 0">${esc(imageWords(plan.images.length, ui.links?.imagesUsed ?? 0))}</p>
      <p style="font-size:12.5px;line-height:1.55;color:var(--fg-70);margin:6px 0 0">${esc(ui.links ? linkWords(ui.links, zip) : "Counting the links…")}</p>
    </div>`;
  const problem = plan.error ? PLAN_ERROR_TEXT[plan.error] : null;
  const canGo = !problem && sum.pages > 0 && !ui.busy;
  const label = ui.busy ? "Starting…" : `Add ${pagesN(sum.pages)} to Review`;
  const alert = problem || ui.error ? `<p role="alert" class="cnpy-imp-alert">${ALERT}<span>${esc(ui.error ?? problem ?? "")}</span></p>` : "";
  return `<div data-morph-key="imp:preview">
    ${head}
    <div${surface("padding:0;margin-top:20px", { cls: "cnpy-imp-strip" })}>${strip}</div>
    <div class="cnpy-imp-pgrid">
      <div${surface("padding:14px 0 10px")}>
        <h3 class="cnpy-imp-h3" style="padding:0 16px">Pages to add</h3>
        <p style="font-size:12px;color:var(--fg-55);margin:4px 0 8px;padding:0 16px">Each folder becomes a page, with its files nested under it. Titles come from each file's first heading.</p>
        <div class="cnpy-imp-prows">${rows || `<p style="font-size:12.5px;color:var(--fg-55);padding:6px 16px;margin:0">No page.</p>`}</div>
      </div>
      <div class="cnpy-imp-side">${conflictCard}${skippedCard}${linksCard}</div>
    </div>
    ${alert}
    <div class="cnpy-imp-foot" style="border-radius:10px">
      <span style="display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--fg-70);min-width:0"><span style="color:var(--fg-40);display:inline-flex;flex:none">${INFO_ICON}</span>Pages go to Review first. Nothing is live until someone approves it.</span>
      <span style="display:flex;gap:8px;flex:none">${btnQuiet("impStep", "Back", "files")}${btnPrimary("impStart", esc(label), canGo, ui.busy ? ' aria-busy="true"' : "")}</span>
    </div>
  </div>`;
}

/** The progress card, or the done card once the run ended. */
function runStep(p: ImportWizardProps): string {
  const r = p.ui.run;
  if (!r) {
    return `<div data-morph-key="imp:none" style="max-width:560px">${emptyLayout("import-run", { text: "No import is running from this page.", action: { label: "Import more", act: "impMore" } })}</div>`;
  }
  if (r.phase === "done" || r.phase === "stopped") return doneCard(r);
  const total = r.pages + r.images;
  const pct = total > 0 ? Math.min(100, Math.round(((r.pagesDone + r.imagesDone) / total) * 100)) : 0;
  const stalled = r.phase === "stalled";
  const now = r.phase === "starting" ? "Starting the import…" : r.phase === "finishing" ? "Finishing…" : r.current ? `${r.phase === "images" ? "Uploading" : "Adding"} ${r.current}` : "Adding pages…";
  return `<div data-morph-key="imp:progress"${surface("max-width:560px;padding:24px 26px 22px", { cls: "cnpy-imp-card" })}>
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px"><h2 class="cnpy-imp-h" tabindex="-1" style="font-size:16px;font-weight:600;margin:0">Adding pages to Review</h2><span style="font-size:16px;font-weight:600;color:var(--accent);font-variant-numeric:tabular-nums">${pct}%</span></div>
    <div style="font-size:12.5px;color:var(--fg-55);margin-top:3px">${esc(r.source)} into ${esc(r.spaceName)}</div>
    <div class="cnpy-imp-bar" role="progressbar" aria-label="Import progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></div>
    <div style="display:flex;justify-content:space-between;gap:12px;font-size:12.5px;color:var(--fg-70);font-variant-numeric:tabular-nums"><span>${r.pagesDone} of ${pagesN(r.pages)}</span><span>${r.images ? `${r.imagesDone} of ${plural(r.images, "image", "images")}` : "No images"}</span></div>
    ${stalled
      ? `<p role="alert" class="cnpy-imp-alert" style="margin:14px 0 0">${ALERT}<span>${esc(r.error ?? "The connection dropped.")}</span></p>`
      : `<div class="cnpy-imp-now" style="border-radius:6px">${SPIN}<span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(now)}</span></div>`}
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:16px;flex-wrap:wrap">
      <span style="font-size:12px;color:var(--fg-55)">${esc(stalled ? STALLED_NOTE : LEAVE_OK)}</span>
      <span style="display:flex;gap:8px">${stalled ? btnPrimary("impRetry", "Retry") : ""}${btnOutline("impCancel", "Cancel import", null, r.id === null ? " disabled" : "")}</span>
    </div>
  </div>`;
}

function doneCard(r: ImportDriverView): string {
  const c = r.run?.counts;
  const staged = c?.staged ?? r.pagesDone;
  const skippedFiles = c?.skipped_files ?? 0;
  const failed = c?.failed ?? 0;
  const stopped = r.phase === "stopped";
  const title = stopped ? "The import stopped" : staged === 0 ? "Nothing was added to Review" : `${pagesN(staged)} added to Review`;
  const lines: string[] = [];
  if (stopped) lines.push(r.error ?? "It stopped before it finished.");
  if (staged > 0) lines.push(`Nothing is live yet. Once someone approves ${staged === 1 ? "it" : "them"} in Review, ${staged === 1 ? "it shows" : "they show"} up in ${r.spaceName}.`);
  if (skippedFiles > 0) lines.push(`${plural(skippedFiles, "file was", "files were")} skipped.`);
  if (failed > 0) lines.push(`${plural(failed, "page", "pages")} couldn't be added. The import's details say why.`);
  if (staged === 0 && !stopped && failed === 0 && (c?.unchanged ?? 0) > 0) lines.push("Every page is the same as the one already in Trov.");
  const tile = staged > 0
    ? `<span style="width:40px;height:40px;border-radius:10px;background:var(--accent);color:var(--accent-fg);display:grid;place-items:center">${ic(`<path d="M20 6 9 17l-5-5"></path>`, 20, 2.6)}</span>`
    : `<span style="width:40px;height:40px;border-radius:10px;border:1px solid var(--border-strong);color:var(--fg-55);display:grid;place-items:center">${ALERT}</span>`;
  const cols = staged > 0 ? `<div class="cnpy-imp-break">${[[c?.staged_new ?? staged, "new page", "new pages"], [c?.staged_versions ?? 0, "new version of an existing page", "new versions of existing pages"], [c?.images_uploaded ?? r.imagesDone, "image", "images"]]
    .map(([n, one, many]) => `<div><div style="font-size:16px;font-weight:600;font-variant-numeric:tabular-nums">${n}</div><div style="font-size:12px;color:var(--fg-55)">${esc(String(n === 1 ? one : many))}</div></div>`).join("")}</div>` : "";
  return `<div data-morph-key="imp:done"${surface("max-width:560px;padding:24px 26px 22px", { cls: "cnpy-imp-card" })}>
    ${tile}
    <h2 class="cnpy-imp-h" tabindex="-1" style="font-size:20px;font-weight:600;letter-spacing:-0.015em;margin:14px 0 0">${esc(title)}</h2>
    <p style="font-size:13px;line-height:1.55;color:var(--fg-70);margin:6px 0 0">${esc(lines.join(" "))}</p>
    ${cols}
    <div style="display:flex;align-items:center;gap:8px;margin-top:20px;flex-wrap:wrap">${staged > 0 ? btnPrimary("goReview", "Open Review ›") : ""}${btnOutline("goImports", "See import details")}${btnQuiet("impMore", "Import more")}</div>
  </div>`;
}

export function importWizardView(p: ImportWizardProps): string {
  const ui = p.ui;
  const lib = p.library;
  const spaces = lib.data?.spaces ?? [];
  const done = ui.step === "run" && ui.run !== null && (ui.run.phase === "done" || ui.run.phase === "stopped");
  const steps = importStepper(ui.step, done);
  let body: string;
  const cards = `<div class="cnpy-imp-sps">${skList(3, (i) => `<div${surface("padding:12px;display:flex;align-items:center;gap:10px")}>${skBox(24, 24)}<div style="flex:1">${skLine(skW(i, ["60%", "52%", "66%"]), 13.5, 1.3)}${skLine("40%", 12, 1.4)}</div></div>`)}</div>`;
  if ((lib.status === "idle" || lib.status === "loading") && !lib.data) {
    body = skeleton("imp-where", "Loading the spaces…", `<div style="${NARROW}">${skLine(260, 19, 1.3)}${skLine(380, 13.5, 1.5)}<div style="margin-top:36px">${cards}</div></div>`);
  } else if (spaces.length === 0 && ui.step !== "run") {
    body = `<div data-morph-key="imp:nospace" style="${NARROW}">${emptyLayout("import", { title: "No spaces yet", text: IMPORT_NO_SPACE, action: p.admin ? { label: "New space", act: "libNew" } : null, shapes: cards, shapesStyle: "margin-top:12px" })}</div>`;
  } else {
    body = ui.step === "where" ? whereStep(p, spaces)
      : ui.step === "files" ? filesStep(p, spaces)
      : ui.step === "preview" ? previewStep(p, spaces)
      : runStep(p);
  }
  return `<div class="cnpy-imp" data-screen-label="Import" data-step="${ui.step}" style="${FRAME}">
    ${steps}
    <div class="cnpy-imp-body">${body}</div>
  </div>`;
}

// ── Imports history (`#imports`) ─────────────────────────────────────────────

export interface ImportsHistoryProps {
  runs: { status: string; data: ImportRunView[] };
  ui: ImportUi;
  persons: readonly PersonSummary[];
  /** Who is looking (a run's starter may cancel it). */
  me: string | null;
  /** An admin of the org: may cancel anyone's run (owner ruling IH12; the server's finish allows it). */
  admin?: boolean;
  /** The live spaces (each row's tile). */
  spaces: readonly SpaceDTO[];
  /** The run this tab drives, if any (its current file). */
  driver: ImportDriverView | null;
}

/** A run's mark key: its status, with a cancelled one told apart from one that was left. */
export const runMarkKey = (r: Pick<ImportRunView, "status" | "cancelled">): ImportMarkKey =>
  r.status === "abandoned" ? (r.cancelled ? "cancelled" : "abandoned") : r.status;
const inFilter = (r: ImportRunView, f: ImportsFilter): boolean =>
  f === "all" || (f === "running" ? r.status === "running" : f === "done" ? r.status === "done" || r.status === "partial" : r.status === "failed");

const HIST_COLS = "minmax(0,1.5fr) minmax(0,1.3fr) 190px 90px 120px 110px 24px";
const HIST_FRAME = "max-width:1120px;margin:0 auto;padding:28px 40px 90px";

/** "Just now", "2 hours ago", "Yesterday", "Oct 12". */
export function runWhen(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  if (now - t < 7 * 86_400_000) { const w = libraryWhen(iso, now); return w.charAt(0).toUpperCase() + w.slice(1); }
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const histHead = (): string =>
  `<div class="cnpy-imph-row cnpy-imph-th" style="grid-template-columns:${HIST_COLS}"><div>File</div><div>Into</div><div>Status</div><div>Pages</div><div>Run by</div><div>When</div><div></div></div>`;
const histRowShape = (i: number): string =>
  `<div class="cnpy-imph-row" style="grid-template-columns:${HIST_COLS}"><div style="display:flex;align-items:center;gap:9px">${skBox(16, 16)}<div style="flex:1">${skLine(skW(i), 13.5, 1.3)}${skLine(skW(i + 2, ["34%", "42%", "28%"]), 12, 1.4)}</div></div><div style="display:flex;align-items:center;gap:7px">${skBox(14, 14)}${skBar(skW(i + 1, ["60%", "48%", "70%"]), 9)}</div><div>${skBar(110, 9)}</div><div>${skBar(36, 9)}</div><div style="display:flex;align-items:center;gap:7px">${skBox(18, 18)}${skBar(50, 9)}</div><div>${skBar(70, 9)}</div><div></div></div>`;
/** The rows as shapes (the loading skeleton's six, the empty layout's three hollow ones), under the real header. */
const histShapes = (n: number): string => `<div${surface("padding:0;overflow:hidden")}>${skList(n, histRowShape)}</div>`;
/** The column header, always shown: over the rows, the skeleton and the empty layout alike. */
const histHeadCard = (): string => `<div${surface("padding:0;overflow:hidden;margin-bottom:8px")}>${histHead()}</div>`;

const findPerson = (persons: readonly PersonSummary[], h: string): PersonSummary | null => persons.find((p) => p.handle.toLowerCase() === h.toLowerCase()) ?? null;

function runDetail(r: ImportRunView, p: ImportsHistoryProps): string {
  const into = [r.space_name ?? r.space, ...r.parent_path].join(" › ");
  const listed = r.failures.filter((f) => f.code !== "cancelled");
  const failList = listed.length ? `<div class="cnpy-imph-fails" style="border-radius:8px">${listed.map((f) => `<div class="cnpy-imph-fail"><span style="font-size:11.5px;color:var(--fg);overflow-wrap:anywhere">${esc(f.path ?? "—")}</span><span style="font-size:12px;color:var(--fg-55)">${esc(importFailureText(f.code))}</span></div>`).join("")}</div>` : "";
  const link = (act: string, label: string, arg: string | null = null) =>
    `<button type="button" data-act="${act}"${arg !== null ? ` data-arg="${attr(arg)}"` : ""} class="cnpy-link" style="padding:0;margin-top:10px;font-size:12.5px;font-weight:500;color:var(--accent)">${esc(label)}</button>`;
  const staged = r.counts.staged;
  switch (runMarkKey(r)) {
    case "running": {
      const pct = r.counts.pages > 0 ? Math.min(100, Math.round((staged / r.counts.pages) * 100)) : 0;
      const mine = (p.me !== null && r.by.toLowerCase() === p.me.toLowerCase()) || p.admin === true;
      const current = p.driver && p.driver.id === r.id && p.driver.current ? `Adding ${p.driver.current}` : `${staged} of ${pagesN(r.counts.pages)} in Review so far`;
      const busy = p.ui.cancelling === r.id;
      return `<p>Adding pages to ${esc(into)}. You can leave this page; the import keeps going.</p>
        <div class="cnpy-imp-bar" style="max-width:420px;height:5px" role="progressbar" aria-label="Import progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></div>
        <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap"><span style="font-size:11.5px;color:var(--fg-55)">${esc(current)}</span>${mine ? `<button type="button" data-act="impHistCancel" data-arg="${r.id}" class="cnpy-link"${busy ? ' disabled aria-busy="true"' : ""} style="padding:0;font-size:12.5px;font-weight:500;color:var(--fg-55)">${busy ? "Cancelling…" : "Cancel import"}</button>` : ""}</div>`;
    }
    case "partial":
      return `<p>${esc(`${pagesN(staged)} went to Review. ${listed.length === 1 ? "1 file was skipped:" : `${listed.length} files were skipped:`}`)}</p>${failList}${link("goReview", "Open in Review ›")}`;
    case "done":
      return r.waiting > 0
        ? `<p>${esc(`${pagesN(staged)} went to Review; ${r.waiting} ${r.waiting === 1 ? "is" : "are"} still waiting there.`)}</p>${link("goReview", "Open in Review ›")}`
        : `<p>${esc(`${staged === 1 ? "1 page was" : `${staged} pages were`} added. Nothing from it is waiting in Review.`)}</p>${link("libOpenSpace", "Open in the library", r.space)}`;
    case "failed":
      return `<p>Nothing was added.${listed.length ? " What went wrong:" : ""}</p>${failList}<div style="margin-top:10px">${btnOutline("impTryAgain", "Try another file", r.space)}</div>`;
    case "cancelled":
      return `<p>${esc(`It was cancelled. ${staged ? `${pagesN(staged)} already added ${staged === 1 ? "stays" : "stay"} in Review.` : "Nothing was added."}`)}</p>${staged ? link("goReview", "Open in Review ›") : ""}`;
    case "abandoned":
      return `<p>${esc(`It stopped before it finished: the page that ran it was closed. ${staged ? `${pagesN(staged)} already added ${staged === 1 ? "stays" : "stay"} in Review.` : "Nothing was added."}`)}</p>${staged ? link("goReview", "Open in Review ›") : ""}`;
  }
}

function runRow(r: ImportRunView, p: ImportsHistoryProps, first: boolean): string {
  const open = p.ui.open === r.id;
  const sp = p.spaces.find((s) => s.slug === r.space);
  const size = [r.file_size !== null ? fileSizeWords(r.file_size) : "", r.file_count > 1 ? plural(r.file_count, "file", "files") : ""].filter(Boolean).join(" · ");
  const zip = /\.zip$/i.test(r.file_name);
  const pages = r.status === "running" ? `${r.counts.staged} of ${r.counts.pages}` : r.counts.staged === 0 ? "None" : String(r.counts.staged);
  const person = findPerson(p.persons, r.by);
  const short = (person?.name || r.by).split(/\s+/)[0];
  return `<div class="cnpy-imph-item${open ? " is-open" : ""}" data-morph-key="imph:${r.id}"${first ? "" : ' style="border-top:1px solid var(--border)"'}>
    <div class="cnpy-imph-row ${HITBOX}" style="grid-template-columns:${HIST_COLS}">
      <div style="display:flex;align-items:center;gap:9px;min-width:0"><span style="color:var(--fg-55);flex:none;display:inline-flex">${zip ? ZIP_ICON(16) : pageIcon(16)}</span><span style="min-width:0"><span style="display:block;font-size:13.5px;color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.file_name)}</span>${size ? `<span style="display:block;font-size:12px;color:var(--fg-55)">${esc(size)}</span>` : ""}</span></div>
      <div style="display:flex;align-items:center;gap:7px;min-width:0">${sp ? spaceTile(sp, 14) : `<span style="color:var(--fg-40);display:inline-flex">${pageIcon(14)}</span>`}<span style="font-size:12.5px;color:var(--fg-70);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc([r.space_name ?? r.space, ...r.parent_path].join(" › "))}</span></div>
      <div style="display:flex;align-items:center;min-width:0">${importRunMark(runMarkKey(r), 12.5)}</div>
      <div style="font-size:12.5px;color:var(--fg-70);font-variant-numeric:tabular-nums">${esc(pages)}</div>
      <div style="display:flex;align-items:center;gap:7px;min-width:0;font-size:12.5px;color:var(--fg-70)">${personAvatarLink(person, r.by, 18)}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(short)}</span></div>
      <div style="font-size:12.5px;color:var(--fg-55);white-space:nowrap">${esc(runWhen(r.started_at))}</div>
      <div class="cnpy-imph-chev" aria-hidden="true">${CHEV}</div>
      ${hitArea("impOpen", String(r.id), `${open ? "Hide" : "Show"} the details of ${r.file_name}`).replace("<button ", `<button aria-expanded="${open}" `)}
    </div>
    <div class="cnpy-imph-detail"${open ? "" : " hidden"}>${open ? runDetail(r, p) : ""}</div>
  </div>`;
}

export function importsHistoryView(p: ImportsHistoryProps): string {
  const list = p.runs;
  const pending = (list.status === "idle" || list.status === "loading") && list.data.length === 0;
  const runs = list.data;
  const counts = pending || runs.length === 0 ? null : {
    all: runs.length, running: runs.filter((r) => inFilter(r, "running")).length,
    done: runs.filter((r) => inFilter(r, "done")).length, failed: runs.filter((r) => inFilter(r, "failed")).length,
  };
  const n = (k: ImportsFilter) => (counts ? `<span class="cnpy-seg-n">${counts[k]}</span>` : "");
  const filter = segmented({
    id: "imports-filter", ariaLabel: "Show", act: "impFilter", value: p.ui.filter, size: "sm", inertOn: true,
    options: [{ value: "all", label: "All", trail: n("all") }, { value: "running", label: "In progress", trail: n("running") }, { value: "done", label: "Done", trail: n("done") }, { value: "failed", label: "Failed", trail: n("failed") }],
  });
  const head = `<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:20px;flex-wrap:wrap">
      <div style="min-width:0"><h1 style="font-size:22px;font-weight:650;letter-spacing:-0.02em;margin:0;line-height:1.2">Imports</h1><p style="font-size:13.5px;line-height:1.5;color:var(--fg-70);margin:6px 0 0">${esc(IMPORTS_SUB)}</p></div>
      ${btnPrimary("goImport", `${UPLOAD_ICON(14)}Import`)}
    </div>
    <div style="margin:18px 0 12px">${filter}</div>`;
  let body: string;
  if (pending) body = `${histHeadCard()}${skeleton("imports", "Loading imports…", histShapes(6))}`;
  else if (list.status === "error" && runs.length === 0) body = `<p style="font-size:13px;color:var(--fg-55)">Couldn't load the imports. Reload the page to try again.</p>`;
  else if (runs.length === 0) body = histHeadCard() + emptyLayout("imports", { title: "No imports yet", text: IMPORTS_EMPTY, action: { label: "Import", act: "goImport" }, shapes: histShapes(3), shapesStyle: "margin-top:12px" });
  else {
    const shown = runs.filter((r) => inFilter(r, p.ui.filter));
    body = `<div${surface("padding:0;overflow:hidden")}>${histHead()}<div data-morph-list>${shown.length ? shown.map((r, i) => runRow(r, p, i === 0)).join("") : `<div data-morph-key="imph-none" style="padding:18px 16px;font-size:12.5px;color:var(--fg-55)">No imports match this filter.</div>`}</div></div>`;
  }
  return `<div class="cnpy-imph" data-screen-label="Imports" style="${HIST_FRAME}">${head}${body}</div>`;
}

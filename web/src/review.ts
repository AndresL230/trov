// Review surface — componentized from Canopy Triage.dc.html (the static design
// output). One queue for everything agent-produced that needs a human verdict:
// doc proposals (diff against live) and drafted decisions (ADR record).
//
// Every component here is purely presentational: data arrives through props
// and renders to an HTML string in the app's template-string idiom.
// Interactions dispatch via data-act / data-arg handled in main.ts. No fetching,
// no inline data.

import { esc, attr, MONO_LABEL, surface, SURFACE, HITBOX, hitArea } from "./ui";
import { LOW_CONFIDENCE, kindMark, stateMark, markShape, glyph } from "./marks";
import { segmented } from "./segmented";
import { renderedDoc } from "./review-rendered";
import { personChip, personLink, personAvatarLink, handleTag } from "./people";
import type { PersonColor } from "@shared/rows";
import { emptyLayout, emptyShapes, skeleton, skBar, skBox, skLine, skLines, skList, skW, skProse } from "./skeleton";
import type { AiSuggestion } from "@shared/ai-core";
import { ASK_WRONG_LABELS, type AskFlag } from "@shared/ai-ask-core";
import { reviewRiskLine, type AiChipUi } from "./ai-cards";
import { libraryWhen } from "./library";
import { renderMarkdown } from "./markdown";
import { replaceDocLinks } from "@shared/docs-links-core";

const NO_AI_UI: AiChipUi = { busy: [], unavailable: [], reasonOpen: null };

// ── prop shapes (loose for now — reshaped at wire time) ──────────────────────
export type ReviewKind = "proposal" | "decision";
/** All / Imports / Written by agents: an import's pages, or everything else (an agent's or a person's proposals and
 *  drafted decisions). */
export type ReviewFilter = "all" | "imports" | "agents";
export const REVIEW_FILTERS: readonly ReviewFilter[] = ["all", "imports", "agents"];
/** Whether an item shows under a filter. */
export const inReviewFilter = (it: Pick<ReviewItem, "importId">, f: ReviewFilter): boolean =>
  f === "all" || (f === "imports" ? it.importId != null : it.importId == null);
export type DiffViewMode = "unified" | "split" | "rendered";
/** What a person just decided about an item — the word its card wears while it leaves the queue. */
export type ReviewVerdict = "promoted" | "ratified" | "rejected";
export const VERDICT_LABEL: Record<ReviewVerdict, string> = { promoted: "Promoted", ratified: "Ratified", rejected: "Rejected" };
/** How long a card takes to leave the list: its verdict held for .13s, then the collapse over
 *  `--fx-fast` (.18s). trov.css `.cnpy-rv-row[data-verdict]` is the other half — keep the two in
 *  step (test/render.review.test.ts reads both). */
export const REVIEW_EXIT_MS = 310;

/** One line of a proposal's diff: ctx / add / del, `h` = heading context, `gap` = hunk separator. */
export type DiffEntryKind = "ctx" | "add" | "del" | "gap" | "h" | "ellipsis";
export interface DiffEntry { t: DiffEntryKind; s?: string }

export interface AdrSection { h: string; p: string }

export interface ReviewItem {
  id: string;
  kind: ReviewKind;
  eyebrow: string;
  title: string;
  summary: string;
  agent: string;
  agentInitials: string;
  /** The agent's mapped-person color/avatar — set by the mapping layer via personFor.
   *  Undefined → unmapped login, rendered as a muted handleTag. */
  agentColor?: PersonColor;
  agentAvatar?: string | null;
  /** The mapped person's handle and name, set with the color — whose card the byline opens. */
  agentHandle?: string;
  agentName?: string | null;
  time: string;
  /** Gate's scrutinize signal: staged with low_confidence = 1. The one state a card names
   *  ("Low confidence", `LOW_CONFIDENCE`): everything in the queue is waiting, and the
   *  Promote / Ratify and Reject buttons already say so, so there is no state tag. */
  flagged?: boolean;
  stale?: boolean;
  staleNote?: string;
  liveVersion?: string; // split-view left header, e.g. "LIVE (v8)"
  diff?: DiffEntry[]; // proposals
  /** A proposal's two bodies, whole — what Rendered renders (the diff above is line-cut source). */
  liveBody?: string;
  proposedBody?: string;
  /** Nothing is live under this slug yet: the proposal is the doc's first version. */
  isNew?: boolean;
  adr?: AdrSection[]; // decisions
  /** Trov's open `review.risk` for it (src/ai/attach.ts); absent when there is none — the card draws nothing then. */
  ai?: AiSuggestion[];
  /** "Flagged in Ask" (handoff #12 § 2.14): the reasons people gave on Ask answers that cited it, and how often —
   *  never the question, the answer or who asked. Absent when nobody did. */
  askFlags?: AskFlag[];
  /** A page of a Markdown import (Review groups by it): the run, the file's path in it, the run's file name, who
   *  ran it and when. Absent for everything an agent or a person wrote. */
  importId?: number | null;
  importPath?: string | null;
  importFile?: string | null;
  importBy?: string | null;
  importAt?: string | null;
  /** The page's slug, space and requested parent (an import group's tree). */
  slug?: string;
  space?: string;
  parentSlug?: string | null;
  /** When it was staged (ISO) — an agent group's "‹when›". */
  at?: string;
  /** The titles above the page in its space's tree, top first — the page pane's crumb. */
  path?: string[];
}

export interface ReviewProps {
  /** Items still pending a verdict (unfiltered). */
  items: ReviewItem[];
  /** Import groups opened with "Review one by one", by import id. */
  groupsOpen?: Record<string, boolean>;
  /** How many pages each import group has held this session — its "‹d› of ‹N› reviewed". */
  groupTotals?: Record<string, number>;
  /** Every page each group has held this session, in the group's order, by group key — a page's "Page i of N"
   *  is its place there, so it does not shift when another page of the group is decided and leaves. */
  groupPages?: Record<string, string[]>;
  /** A space's name by slug (a group's "into ‹Space›"). */
  spaceNames?: Record<string, string>;
  /** Who ran each import, by handle: the person (their avatar and short name). */
  people?: readonly { handle: string; name: string | null; color: PersonColor; avatar_url?: string | null }[];
  filter: ReviewFilter;
  /** null → default to the first visible item. */
  selectedId: string | null;
  diffView: DiffViewMode;
  /** Items a verdict was just given to, still on screen: each card wears its verdict and
   *  collapses (web-ui.md › A row leaving a list). They are out of the counts, never selected. */
  leaving?: Record<string, ReviewVerdict>;
  /** The queue's first read is still out: the frame and filter are real, the list and
   *  the detail pane hold skeletons (never "Queue is clear" before it is known). */
  loading?: boolean;
  /** Trov's risk line's state (`state.ai`): only read when an item carries `ai`. */
  aiUi?: AiChipUi;
}

// ── list pane ────────────────────────────────────────────────────────────────
/** All / Imports / Written by agents: ONE list, three views of it — a pick-one, so `segmented()`
 *  (not a tab bar: the page below does not change section, the list narrows). Each option
 *  carries how many are waiting; a zero stays, so the switch never changes width. */
export function reviewFilterSwitch(filter: ReviewFilter, counts: Record<ReviewFilter, number> | null): string {
  const n = (k: ReviewFilter) => (counts ? `<span class="cnpy-seg-n">${counts[k]}</span>` : "");
  return `<div style="margin:12px 0 12px">${segmented({
    id: "review-filter", ariaLabel: "Show", act: "reviewFilter", value: filter, size: "sm", inertOn: true,
    options: [
      { value: "all", label: "All", trail: n("all") },
      { value: "imports", label: "Imports", trail: n("imports") },
      { value: "agents", label: "Written by agents", trail: n("agents") },
    ],
  })}</div>`;
}

/** One review queue row — mirrors the detail header: title first, the low-confidence mark
 *  up-right on the title row when the gate set it (nothing otherwise: every row here is
 *  waiting), 2-line summary, then a byline that folds the record type · identifier
 *  (label-face) into the author · date. */
export function reviewCard(it: ReviewItem, selected: boolean, verdict: ReviewVerdict | null = null): string {
  const { type, id } = splitEyebrow(it.eyebrow);
  const dot = `<span style="color:var(--fg-40)">·</span>`;
  // The row is the list's KEYED child (`data-morph-key`): a repaint patches it in place, so a card
  // that leaves can collapse and the cards under it glide up as the same elements. Its structure is
  // the same in every state — the selection bar and the verdict label are always emitted and shown
  // by attribute. A row with a verdict is `inert`: it is on its way out.
  return `<div class="cnpy-rv-row" data-morph-key="rv:${attr(it.id)}"${verdict ? ` data-verdict="${verdict}" inert` : ""}><div class="cnpy-rv-row-in"><div class="cnpy-titem ${SURFACE} cnpy-card ${HITBOX}" data-rv-card="${attr(it.id)}"${selected ? ` aria-current="true"` : ""}>
    ${hitArea("reviewSelect", it.id, it.title).replace("<button ", `<button${selected ? ` aria-current="true"` : ""} `)}
    <span class="cnpy-selbar"></span>
    <div class="cnpy-rv-card-in" style="position:relative">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
        <div style="flex:1 1 auto;font-size:14px;font-weight:600;letter-spacing:-0.005em;color:var(--fg);min-width:0">${esc(it.title)}</div>
        ${it.flagged ? `<div class="cnpy-rv-marks" style="flex:none;margin-top:1px">${LOW_CONFIDENCE(12)}</div>` : ""}
      </div>
      <div style="font-size:12.5px;color:var(--fg-55);margin-top:5px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(it.summary)}</div>
      ${reviewMetaRow(it, type, id, dot)}
    </div>
    <span class="cnpy-rv-verdict" aria-hidden="true">${verdict ? `${verdict === "rejected" ? X_ICON : CHECK_ICON}${VERDICT_LABEL[verdict]}` : ""}</span>
  </div></div></div>`;
}
/** A card's meta row (the owner's layout, e2e RV-OWNER-1): ONE line, the same slots in the same order on every card —
 *  the author's avatar alone (its handle in the tooltip and its accessible name; a button that opens their card when
 *  they are a known person), then kind, where (the section path in sentence case, or the ADR number) and time. Only
 *  "where" gives way: it ends in an ellipsis, the whole path in its tooltip. Nothing else joins the row, so a card with
 *  a risk and one without stand the same height. */
function reviewMetaRow(it: ReviewItem, type: string, id: string, dot: string): string {
  const isAdr = /^ADR-/i.test(id);
  return `<div class="cnpy-rv-meta" style="display:flex;align-items:center;flex-wrap:nowrap;white-space:nowrap;overflow:hidden;gap:6px;margin-top:10px;height:20px;font-size:11.5px;line-height:20px;color:var(--fg-55);min-width:0">
        <span data-slot="author" data-mtip="@${attr(it.agent)}" style="flex:none;display:inline-flex;align-items:center">${agentAvatar(it, 18)}</span>
        <span data-slot="kind" style="flex:none">${esc(type)}</span>${dot}
        <span data-slot="where"${id ? ` data-mtip="${attr(id)}"` : ""} style="flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis${isAdr ? ";font-family:var(--label);font-size:11px" : ""}">${esc(id)}</span>${dot}
        <span data-slot="time" style="flex:none;color:var(--fg-40)">${esc(it.time)}</span>
      </div>`;
}
/** The author as their avatar alone: the button to their card for a known person (people.ts), else the chip with
 *  the handle as its accessible name. */
function agentAvatar(it: ReviewItem, size: number): string {
  const p = it.agentColor && it.agentHandle ? { handle: it.agentHandle, name: it.agentName, color: it.agentColor, avatar_url: it.agentAvatar } : null;
  if (p) return personAvatarLink(p, it.agent, size).replace(/aria-label="[^"]*"/, `aria-label="${attr(`@${it.agent}${it.agentName ? ` (${it.agentName})` : ""} — person card`)}"`);
  const chip = it.agentColor ? { handle: it.agent, color: it.agentColor, avatar_url: it.agentAvatar } : null;
  return `<span role="img" aria-label="${attr(`@${it.agent}`)}" style="display:inline-flex">${personChip(chip, size, it.agent)}</span>`;
}
const CHECK_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg>`;
const X_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"></path></svg>`;

/** The chip and handle as ONE button that opens the person's card — the detail header's byline (the list card shows
 *  the avatar alone, `agentAvatar`). Plain when unmapped. */
function agentLink(it: ReviewItem, chipSize: number): string {
  const p = it.agentColor ? { handle: it.agent, color: it.agentColor, avatar_url: it.agentAvatar } : null;
  const person = p && it.agentHandle ? { handle: it.agentHandle, name: it.agentName, color: p.color, avatar_url: p.avatar_url } : null;
  return personLink(person, it.agent, chipSize, { html: handleTag(p, it.agent) }, "", 6);
}

/** Review's empty words — the design's (owner ruling, E2E RV18): a title and what the queue holds. Nothing here is
 *  made by hand, and a clear queue is a normal state, so no action. */
export const REVIEW_EMPTY_TITLE = "Nothing to review";
export const REVIEW_EMPTY = "Pages that are imported or written by agents wait here until someone approves them. You'll see each import as one group.";
/** The list pane with nothing in it: the words, then the queue's cards drawn empty. `all` =
 *  no filter is on; under the Imports / Written by agents filter the other kind may still be waiting. */
export function reviewListEmpty(all = true): string {
  return all
    ? emptyLayout("review-list", { title: REVIEW_EMPTY_TITLE, text: REVIEW_EMPTY, sayStyle: "margin:4px 0 10px", shapes: skList(2, reviewCardShape) })
    : emptyLayout("review-list", { text: "Nothing of this kind is waiting for review.", sayStyle: "margin:4px 0 10px", shapes: "" });
}

// ── detail pane pieces ───────────────────────────────────────────────────────
export function staleBaseWarning(note: string): string {
  return `<div${surface("padding:11px 15px;margin-top:18px;display:flex;gap:6px 12px;align-items:baseline;flex-wrap:wrap")}>
    <div style="flex:none">${kindMark("Stale base", "warn", 12.5, "The live doc changed after this proposal was written.")}</div>
    <div style="font-size:12.5px;color:var(--fg-70);min-width:0">${esc(note)}</div>
  </div>`;
}

// ── diff viewer ──────────────────────────────────────────────────────────────
function diffLineStyle(t: DiffEntryKind): string {
  const base = "font-family:var(--code);font-size:12.5px;line-height:1.75;padding:2px 16px 2px 12px;white-space:pre-wrap;color:var(--fg-55);border-left:2px solid transparent";
  if (t === "del") return `${base};border-left:2px solid var(--red);background:color-mix(in srgb,var(--red) 7%,transparent)`;
  if (t === "add") return `${base};border-left:2px solid var(--green);background:color-mix(in srgb,var(--green) 7%,transparent);color:var(--fg-70)`;
  if (t === "h") return `${base};color:var(--fg);font-weight:600`;
  return base;
}
const GAP_STYLE = "height:14px;border-bottom:1px solid var(--border);margin-bottom:14px";
const ELLIPSIS_STYLE = "font-family:var(--label);font-size:11px;letter-spacing:.04em;color:var(--fg-40);text-align:center;padding:6px 16px;border-top:1px dashed var(--border);border-bottom:1px dashed var(--border);margin:6px 0";

function diffPrefix(t: DiffEntryKind): string {
  const color = t === "del" ? "var(--red)" : t === "add" ? "var(--green)" : "var(--fg-40)";
  const ch = t === "del" ? "−" : t === "add" ? "+" : " ";
  return `<span style="display:inline-block;width:18px;flex:none;color:${color}">${ch}</span>`;
}

export function unifiedDiff(entries: DiffEntry[]): string {
  const lines = entries.map((e) => {
    if (e.t === "gap") return `<div style="${GAP_STYLE}"></div>`;
    if (e.t === "ellipsis") return `<div style="${ELLIPSIS_STYLE}">${esc(e.s ?? "")}</div>`;
    return `<div style="${diffLineStyle(e.t)}">${diffPrefix(e.t)}${esc(e.s ?? "")}</div>`;
  }).join("");
  return `<div${surface("overflow:hidden;padding:8px 0")}>${lines}</div>`;
}

type SplitCell = { t: DiffEntryKind | "empty"; text: string };

/** Pair del-runs with add-runs so old and new sit side by side; ctx/h span both columns. */
export function splitDiffRows(entries: DiffEntry[]): { left: SplitCell; right: SplitCell }[] {
  const rows: { left: SplitCell; right: SplitCell }[] = [];
  let i = 0;
  while (i < entries.length) {
    const e = entries[i];
    if (e.t === "gap") { rows.push({ left: { t: "gap", text: "" }, right: { t: "gap", text: "" } }); i++; continue; }
    if (e.t === "ctx" || e.t === "h" || e.t === "ellipsis") {
      const text = e.s ?? "";
      rows.push({ left: { t: e.t, text }, right: { t: e.t, text } });
      i++; continue;
    }
    const dels: string[] = [];
    const adds: string[] = [];
    while (i < entries.length && entries[i].t === "del") { dels.push(entries[i].s ?? ""); i++; }
    while (i < entries.length && entries[i].t === "add") { adds.push(entries[i].s ?? ""); i++; }
    for (let j = 0; j < Math.max(dels.length, adds.length); j++) {
      rows.push({
        left: j < dels.length ? { t: "del", text: dels[j] } : { t: "empty", text: "·" },
        right: j < adds.length ? { t: "add", text: adds[j] } : { t: "empty", text: "·" },
      });
    }
  }
  return rows;
}

function splitCellHtml(c: SplitCell, isLeft: boolean): string {
  const borderRight = isLeft ? ";border-right:1px solid var(--border)" : "";
  if (c.t === "gap") return `<div style="${GAP_STYLE}${borderRight}"></div>`;
  if (c.t === "ellipsis") return `<div style="${ELLIPSIS_STYLE}${borderRight}">${esc(c.text)}</div>`;
  if (c.t === "empty") return `<div style="font-family:var(--label);font-size:12.5px;line-height:1.75;padding:2px 16px 2px 12px;border-left:2px solid transparent;color:transparent${borderRight}">·</div>`;
  return `<div style="${diffLineStyle(c.t)}${borderRight}">${esc(c.text)}</div>`;
}

export function splitDiff(entries: DiffEntry[], liveLabel: string): string {
  const rows = splitDiffRows(entries).map((r) =>
    `<div style="display:grid;grid-template-columns:1fr 1fr">${splitCellHtml(r.left, true)}${splitCellHtml(r.right, false)}</div>`
  ).join("");
  return `<div${surface("overflow:hidden")}>
    <div style="display:grid;grid-template-columns:1fr 1fr;border-bottom:1px solid var(--border)">
      <div style="padding:8px 14px;font-family:var(--label);font-size:10px;font-weight:600;letter-spacing:.08em;color:var(--fg-40);border-right:1px solid var(--border)">${esc(liveLabel)}</div>
      <div style="padding:8px 14px;font-family:var(--label);font-size:10px;font-weight:600;letter-spacing:.08em;color:var(--accent)">PROPOSED</div>
    </div>
    <div style="padding:8px 0">${rows}</div>
  </div>`;
}

/** "WHAT CHANGED", the Unified / Side by side / Rendered switch, and the picked mode's body.
 *  Unified and Side by side show the SOURCE, cut by line; Rendered shows the document as the Docs
 *  reader will (review-rendered.ts). The body is a keyed part: changing the mode replaces it alone. */
export function diffViewer(it: Pick<ReviewItem, "diff" | "liveVersion" | "liveBody" | "proposedBody" | "isNew">, view: DiffViewMode): string {
  const entries = it.diff ?? [];
  const body = view === "split" ? splitDiff(entries, it.liveVersion ?? "LIVE")
    : view === "rendered" ? renderedDoc(it.liveBody ?? "", it.proposedBody ?? "", it.isNew === true)
    : unifiedDiff(entries);
  return `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:22px 0 10px">
    <div style="${MONO_LABEL}">WHAT CHANGED</div>
    ${segmented({
      id: "review-diff", ariaLabel: "How to show the change", act: "reviewDiffView", value: view, size: "sm", inertOn: true,
      options: [{ value: "unified", label: "Unified" }, { value: "split", label: "Side by side" }, { value: "rendered", label: "Rendered" }],
    })}
  </div>
  <div class="cnpy-rv-diff" data-morph-key="diff:${view}">${body}</div>`;
}

/** Drafted decision: the proposed ADR record (Context / Decision / Consequences). */
export function adrRecord(sections: AdrSection[]): string {
  const body = sections.map((s) => `<div style="margin-bottom:18px">
      <div style="font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--fg-55);margin-bottom:6px">${esc(s.h)}</div>
      <div style="font-size:14.5px;line-height:1.7;color:var(--fg-70)">${esc(s.p)}</div>
    </div>`).join("");
  return `<div style="display:flex;align-items:center;gap:10px;margin:22px 0 10px">
    <div style="${MONO_LABEL}">PROPOSED RECORD</div>
    <div style="font-size:11.5px;color:var(--fg-40)">new document — no prior version</div>
  </div>
  <div${surface("padding:24px 28px 26px")}>${body}</div>`;
}

/** Detail pane for the selected item: header + verdict actions + content. */
/** Split the mapper's "TYPE · IDENTIFIER" eyebrow into a title-cased record
 *  type and its identifier — e.g. "DECISION · ADR-005" → {type:"Decision",
 *  id:"ADR-005"}; "PROPOSAL · TROV / REFERENCE" → {type:"Proposal", id:"TROV / REFERENCE"}. */
function splitEyebrow(eyebrow: string): { type: string; id: string } {
  const at = eyebrow.indexOf(" · ");
  const rawType = at === -1 ? eyebrow : eyebrow.slice(0, at);
  const rawId = at === -1 ? "" : eyebrow.slice(at + 3);
  const type = rawType ? rawType.charAt(0) + rawType.slice(1).toLowerCase() : "";
  // The section path is a fact: plain text, each part in sentence case ("Technical / Architecture"), never the
  // mapper's UPPERCASE. An ADR number stays as it is ("ADR-005").
  const id = /^ADR-/i.test(rawId) ? rawId : rawId.split(" / ").map((p) => (p ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : p)).join(" / ");
  return { type, id };
}

// The header's status chips and its two buttons are ONE height, so the row reads as a set.
const HEAD_BTN = "box-sizing:border-box;height:34px;display:inline-flex;align-items:center;border-radius:8px;font-size:12.5px";

export function reviewDetail(it: ReviewItem, diffView: DiffViewMode, aiUi: AiChipUi = NO_AI_UI): string {
  const acceptLabel = it.kind === "decision" ? "Ratify" : "Promote";
  const content = it.kind === "decision"
    ? adrRecord(it.adr ?? [])
    : diffViewer(it, diffView);
  const { type, id } = splitEyebrow(it.eyebrow);
  // Byline: record type · identifier (label-face, reads as a reference) · author · date.
  const dot = `<span style="color:var(--fg-40)">·</span>`;
  // Keyed by the item: another item REPLACES the body (never patched into it), a repaint of the same one patches.
  return `<div class="cnpy-rv-body" data-morph-key="rvd:${attr(it.id)}" style="max-width:920px;padding:24px 32px 100px">
    <div class="cnpy-rv-head" style="display:flex;align-items:flex-start;justify-content:space-between;gap:20px">
      <div style="min-width:0">
        <h2 style="margin:0;font-size:22px;font-weight:600;letter-spacing:-0.02em">${esc(it.title)}</h2>
        <div style="display:flex;align-items:center;flex-wrap:wrap;gap:7px;margin-top:8px;font-size:12px;color:var(--fg-55)">
          ${type ? `<span>${esc(type)}</span>` : ""}
          ${id ? `${dot}<span style="font-family:var(--label);font-size:11.5px;color:var(--fg-55)">${esc(id)}</span>` : ""}
          ${dot}<span style="display:inline-flex;align-items:center;gap:6px">${agentLink(it, 18)}</span>
          ${dot}<span style="color:var(--fg-40)">${esc(it.time)}</span>
        </div>${it.importId != null ? `<div class="cnpy-rv-from" style="display:flex;align-items:center;gap:6px;margin-top:6px;font-size:12px;color:var(--fg-55)">${stateMark(it.isNew ? "New page" : "New version", "var(--fg-55)", "dashed", 12, it.isNew ? "A page the import adds. Nothing is live until it is approved." : "A new version of a page that is live. Everyone reads the live one until this is approved.")}${it.importPath ? `<span style="font-size:11.5px;color:var(--fg-40);overflow-wrap:anywhere">from ${esc(it.importPath)}</span>` : ""}</div>` : ""}
      </div>
      <div style="display:flex;align-items:center;gap:10px;flex:none;padding-top:2px">
        ${it.flagged ? `<span style="margin-right:4px">${LOW_CONFIDENCE()}</span>` : ""}
        <button data-act="reviewReject" data-arg="${attr(it.id)}" class="cnpy-rejectbtn" style="${HEAD_BTN};background:transparent;border:1px solid var(--border-strong);padding:0 14px;font-weight:500;color:var(--fg-70);transition:all .12s ease">Reject</button>
        <button data-act="reviewAccept" data-arg="${attr(it.id)}" class="cnpy-accentbtn" style="${HEAD_BTN};background:var(--accent);color:var(--accent-fg);border:1px solid var(--accent);padding:0 17px;font-weight:600">${acceptLabel}</button>
      </div>
    </div>
    ${it.ai ? reviewRiskLine(it.ai, aiUi) : ""}${it.askFlags?.length ? askFlagsLine(it.askFlags) : ""}${it.stale && it.staleNote ? staleBaseWarning(it.staleNote) : ""}
    ${content}
  </div>`;
}

/** "Flagged in Ask: A source is wrong (2) · It is out of date (1)" — most flagged first; the reason words are Ask's
 *  own (`ASK_WRONG_LABELS`). Nothing from the thread is ever here. */
export function askFlagsLine(flags: AskFlag[]): string {
  const sorted = [...flags].sort((a, b) => b.count - a.count);
  const words = sorted.map((f) => `${esc(ASK_WRONG_LABELS[f.reason] ?? f.reason)} (${f.count})`).join(" &middot; ");
  return `<p class="cnpy-rv-askflags" style="margin:14px 0 0;font-size:12.5px;line-height:1.5;color:var(--fg-55)">Flagged in Ask: <span style="color:var(--fg-70)">${words}</span></p>`;
}

/** The list pane while the queue's first read is out: cards in the review card's box. */
/** One queue card as a shape — the list pane's loading skeleton and its empty layout. */
function reviewCardShape(i: number): string {
  return `<div class="cnpy-titem ${SURFACE}">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">${skLine(skW(i), 14, 1.5)}${skBox(48, 18)}</div>
    <div style="margin-top:5px">${skLines(["96%", skW(i + 1, ["54%", "70%"])], 12.5, 1.5)}</div>
    <div style="display:flex;align-items:center;gap:8px;margin-top:10px">${skBox(18, 18)}${skLine(150, 11.5, 1.5)}</div>
  </div>`;
}
function reviewListSkeleton(): string {
  return skeleton("review-list", "Loading review queue&hellip;", skList(4, reviewCardShape));
}

const DETAIL_FRAME = "max-width:920px;padding:24px 32px 100px";
/** The detail pane as shapes: the title, byline and verdict buttons' row, then the record's card. */
function reviewDetailShapes(paras: number): string {
  return `<div class="cnpy-rv-head" style="display:flex;align-items:flex-start;justify-content:space-between;gap:20px">
      <div style="min-width:0;flex:1">${skLine("62%", 22, 1.3)}<div style="margin-top:8px">${skLine(220, 12, 1.5)}</div></div>
      <div style="display:flex;align-items:center;gap:10px;flex:none;padding-top:2px">${skBox(70, 32)}${skBox(86, 32)}</div>
    </div>
    <div${surface("padding:24px 28px 26px;margin-top:22px")}>${skBar(120, 8)}<div style="margin-top:18px">${skProse(paras)}</div></div>`;
}
function reviewDetailSkeleton(): string {
  return skeleton("review-detail", "Loading review queue&hellip;", reviewDetailShapes(3), DETAIL_FRAME);
}

/** The detail pane with nothing picked because nothing is waiting: the record's page, drawn empty.
 *  A picture only — the list pane beside it carries the sentence. */
export function reviewQueueClear(): string {
  return emptyShapes(reviewDetailShapes(2), { style: DETAIL_FRAME });
}

// ── composed surface ─────────────────────────────────────────────────────────
const BACK_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M15 18l-6-6 6-6"></path></svg>`;
/** The one line under the header's title: what the queue is. The screen's name is the app
 *  header's — nothing in the page repeats it (org-ui.ts rule 1; Unplaced does the same). */
export const REVIEW_INTRO = "Agent-produced changes waiting for a verdict.";

// ── a group: an import's pages, or one agent's ───────────────────────────────

/** A group of waiting pages, decided page by page or whole: one Markdown import's (keyed by its run id, "7") or the
 *  doc changes one person's agent staged (keyed "agent:<handle>"). An import's pages are in the import's tree order
 *  (the queue lists them newest first, so a group's order is the queue's REVERSED — parents were staged first), each
 *  with its depth (from the `parent_slug` chain inside the group); an agent's are in the queue's order, all at depth 0.
 *  Drafted decisions are never in a group (they are ratified one by one). */
export interface ReviewGroup {
  key: string;
  kind: "import" | "agent";
  /** The import's run id; 0 for an agent's group. */
  id: number;
  items: ReviewItem[];
  depth: Record<string, number>;
  /** The design's ‹short›: the import's file name, or "‹Name›'s agent". */
  file: string;
  by: string | null;
  at: string | null;
  /** The space every page is in ("" when an agent's pages span spaces). */
  space: string;
}

/** The group an item belongs to: its import's, else — a doc change — its author's agent's; null for a decision. */
export function groupKeyOf(it: Pick<ReviewItem, "importId" | "kind" | "agent">): string | null {
  if (it.importId != null) return String(it.importId);
  return it.kind === "proposal" ? `agent:${it.agent}` : null;
}

/** "Pia's agent" — the author's first name (their handle when unknown). */
const agentShort = (it: Pick<ReviewItem, "agent" | "agentName">): string => `${(it.agentName || it.agent).trim().split(/\s+/)[0]}'s agent`;

/** Every group among `items`, keyed by `groupKeyOf`, in the order their first page appears in the queue. */
export function reviewGroups(items: readonly ReviewItem[]): Map<string, ReviewGroup> {
  const out = new Map<string, ReviewGroup>();
  for (const it of items) {
    const key = groupKeyOf(it);
    if (key === null) continue;
    let g = out.get(key);
    if (!g) {
      g = it.importId != null
        ? { key, kind: "import", id: it.importId, items: [], depth: {}, file: it.importFile ?? "an import", by: it.importBy ?? null, at: it.importAt ?? null, space: it.space ?? "" }
        : { key, kind: "agent", id: 0, items: [], depth: {}, file: agentShort(it), by: it.agent, at: it.at ?? null, space: it.space ?? "" };
      out.set(key, g);
    }
    if (g.kind === "agent" && g.space !== (it.space ?? "")) g.space = "";
    g.items.push(it);
  }
  for (const g of out.values()) {
    if (g.kind === "agent") { for (const it of g.items) g.depth[it.id] = 0; continue; }
    g.items.reverse();
    const bySlug = new Map(g.items.filter((it) => it.slug).map((it) => [it.slug as string, it]));
    for (const it of g.items) {
      let d = 0;
      let cur = it.parentSlug ? bySlug.get(it.parentSlug) : undefined;
      while (cur && d < 12) { d++; cur = cur.parentSlug ? bySlug.get(cur.parentSlug) : undefined; }
      g.depth[it.id] = d;
    }
  }
  return out;
}

/** The import groups among `items`, keyed by import id. */
export function importGroups(items: readonly ReviewItem[]): Map<number, ReviewGroup> {
  return new Map([...reviewGroups(items).values()].filter((g) => g.kind === "import").map((g) => [g.id, g]));
}

/** The group's name without "Import from " / "Written by " (the design's ‹short›: "handbook.zip", "Pia's agent"). */
export const groupShort = (g: Pick<ReviewGroup, "file">): string => g.file;
/** The group card's title (the design's). */
export const groupTitle = (g: Pick<ReviewGroup, "kind" | "file">): string => g.kind === "agent" ? `Written by ${g.file}` : `Import from ${g.file}`;
/** A page's kind, in its group's row: an import adds a page or a new version of one; an agent a page or a change. */
export const groupPageKind = (it: Pick<ReviewItem, "isNew">, kind: ReviewGroup["kind"]): string =>
  it.isNew ? "New page" : kind === "agent" ? "Change" : "New version";

const UPLOAD = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V4"></path><path d="m7 9 5-5 5 5"></path><path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"></path></svg>`;
/** The design's agent mark: a spark (an agent group's icon on slate, and the 16px avatar of its meta line). */
const SPARK = (n: number, sw = 1.9) => `<svg width="${n}" height="${n}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"></path><path d="M19 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"></path></svg>`;
const CHEV_R = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg>`;

/** One page row inside an open group: a 2px selection bar, its state's shape, the title, its kind. A keyed row of the
 *  group's own list, so a page decided on its own leaves with the queue's one exit. */
function groupPageRow(it: ReviewItem, kind: ReviewGroup["kind"], depth: number, selected: boolean, verdict: ReviewVerdict | null): string {
  const shape = verdict === "rejected" ? glyph("declined", "var(--fg-40)", 11) : verdict ? glyph("done", "var(--accent)", 11) : markShape("dashed", "var(--fg-55)", 10);
  return `<div class="cnpy-rv-row" data-morph-key="rvp:${attr(it.id)}"${verdict ? ` data-verdict="${verdict}" inert` : ""}><div class="cnpy-rv-row-in"><button type="button" data-act="reviewSelect" data-arg="${attr(it.id)}" class="cnpy-rvg-pg"${selected ? ' aria-current="true"' : ""} style="padding-left:${16 + depth * 16}px">
    <span class="cnpy-rvg-bar" aria-hidden="true"></span><span style="flex:none;display:inline-flex">${shape}</span><span class="cnpy-rvg-pt">${esc(it.title)}</span><span class="cnpy-rvg-pk">${groupPageKind(it, kind)}</span>
  </button></div></div>`;
}

function groupCard(g: ReviewGroup, p: ReviewProps, sel: ReviewItem | null, leaving: Record<string, ReviewVerdict>): string {
  const waiting = g.items.filter((it) => !leaving[it.id]);
  const total = Math.max(p.groupTotals?.[g.key] ?? 0, g.items.length);
  const decided = total - waiting.length;
  const open = p.groupsOpen?.[g.key] === true;
  // Every page of it has a verdict (Approve all, Reject all, or the last one decided): the card wears it and leaves.
  const verdicts = new Set(g.items.map((it) => leaving[it.id]).filter(Boolean));
  const groupVerdict = waiting.length === 0 && verdicts.size > 0 ? (verdicts.size === 1 ? [...verdicts][0] as ReviewVerdict : "promoted") : null;
  const person = p.people?.find((x) => x.handle.toLowerCase() === (g.by ?? "").toLowerCase()) ?? null;
  const by = g.by ? (person?.name || g.by).split(/\s+/)[0] : null;
  const space = p.spaceNames?.[g.space] ?? g.space;
  const meta = (g.kind === "agent"
    ? [pagesN(waiting.length || g.items.length), g.at ? libraryWhen(g.at) : ""]
    : [pagesN(waiting.length || g.items.length), space ? `into ${space}` : "", by ? `by ${by}` : "", g.at ? libraryWhen(g.at) : ""]).filter(Boolean).join(" · ");
  const selIn = sel !== null && g.items.some((it) => it.id === sel.id);
  const approve = decided > 0 ? `Approve ${waiting.length} left` : `Approve all ${waiting.length}`;
  const rows = g.items.map((it) => groupPageRow(it, g.kind, g.depth[it.id] ?? 0, sel !== null && it.id === sel.id, leaving[it.id] ?? null)).join("");
  // The meta line's 16px avatar: who ran the import, or — an agent's group — the design's spark on slate.
  const av = g.kind === "agent"
    ? `<span class="cnpy-rvg-agav" role="img" aria-label="${attr(`@${g.by ?? ""}'s agent`)}" style="border-radius:5px">${SPARK(11, 2.2)}</span>`
    : g.by ? personChip(person ? { handle: person.handle, name: person.name, color: person.color, avatar_url: person.avatar_url } : null, 16, g.by) : "";
  const arg = attr(g.key);
  return `<div class="cnpy-rv-row" data-morph-key="rvg:${arg}"${groupVerdict ? ` data-verdict="${groupVerdict}" inert` : ""}><div class="cnpy-rv-row-in"><div class="cnpy-rvg ${SURFACE}"${selIn ? ' data-sel="1"' : ""} data-rv-group="${arg}" data-kind="${g.kind}">
    <div class="cnpy-rvg-in">
      <div class="cnpy-rvg-head">
        <span class="cnpy-rvg-ic" style="border-radius:7px">${g.kind === "agent" ? SPARK(16) : UPLOAD}</span>
        <div style="min-width:0;flex:1">
          <div style="font-size:14px;font-weight:600;letter-spacing:-0.005em;color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(groupTitle(g))}</div>
          <div style="display:flex;align-items:center;gap:6px;margin-top:3px;font-size:12px;color:var(--fg-55);min-width:0">${av ? `<span style="flex:none;display:inline-flex">${av}</span>` : ""}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(meta)}</span></div>
        </div>
      </div>
      <div class="cnpy-rvg-acts">
        <button type="button" data-act="reviewGroupToggle" data-arg="${arg}" class="cnpy-rvg-tog" aria-expanded="${open}"><span class="cnpy-rvg-chev" aria-hidden="true">${CHEV_R}</span>${open ? "Hide pages" : "Review one by one"}</button>
        <span class="cnpy-rvg-done"${decided > 0 ? "" : " hidden"}>${decided} of ${total} reviewed</span>
        <span style="flex:1"></span>
        <button type="button" data-act="reviewGroupReject" data-arg="${arg}" data-confirm-trigger class="cnpy-rejectbtn" style="height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--border-strong);font-size:12.5px;font-weight:500;color:var(--fg-70)">Reject all</button>
        <button type="button" data-act="reviewGroupApprove" data-arg="${arg}" class="cnpy-accentbtn" style="height:30px;padding:0 13px;border-radius:8px;background:var(--accent);color:var(--accent-fg);font-size:12.5px;font-weight:600;white-space:nowrap">${approve}</button>
      </div>
      <div class="cnpy-rvg-list" data-open="${open ? "1" : "0"}"><div class="cnpy-rvg-clip"><div data-morph-list>${open ? rows : ""}</div></div></div>
    </div>
    <span class="cnpy-rv-verdict" aria-hidden="true">${groupVerdict ? `${groupVerdict === "rejected" ? X_ICON : CHECK_ICON}${VERDICT_LABEL[groupVerdict === "rejected" ? "rejected" : "promoted"]}` : ""}</span>
  </div></div></div>`;
}

const pagesN = (n: number): string => `${n} ${n === 1 ? "page" : "pages"}`;
const ARROW_L = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"></path></svg>`;
const ARROW_R = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg>`;

/** The detail pane's bar for a page of an import: "Page 3 of 24 · handbook.zip", and the arrows to the page before
 *  and after it in the group (wrapping). */
export function importPageBar(it: ReviewItem, g: ReviewGroup, leaving: Record<string, ReviewVerdict>, total: number, order?: readonly string[]): string {
  const waiting = g.items.filter((x) => !leaving[x.id] || x.id === it.id);
  const at = waiting.findIndex((x) => x.id === it.id);
  const prev = waiting[(at - 1 + waiting.length) % waiting.length];
  const next = waiting[(at + 1) % waiting.length];
  // Its place among every page the group has held (decided ones keep theirs); without that record, among those left.
  const kept = order?.indexOf(it.id) ?? -1;
  const pos = kept >= 0 ? kept + 1 : g.items.findIndex((x) => x.id === it.id) + 1 + Math.max(0, total - g.items.length);
  total = kept >= 0 ? Math.max(total, order!.length) : total;
  const arrow = (to: ReviewItem | undefined, label: string, icon: string) =>
    `<button type="button" data-act="reviewSelect" data-arg="${attr(to?.id ?? it.id)}" class="cnpy-iconbtn" aria-label="${label}"${waiting.length < 2 ? " disabled" : ""} style="width:28px;height:28px;border-radius:7px;border:1px solid var(--border);display:grid;place-items:center;color:var(--fg-55)">${icon}</button>`;
  return `<div class="cnpy-rvg-bar-top" data-morph-key="rvb:${attr(it.id)}"><span style="font-size:12.5px;color:var(--fg-55);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Page ${pos} of ${total} · ${esc(g.file)}</span><span style="display:flex;gap:6px;flex:none">${arrow(prev, "Previous page", ARROW_L)}${arrow(next, "Next page", ARROW_R)}</span></div>`;
}

// ── the page pane: a group's page, as the design draws it ──────────────────────

/** The footer's sentence while the page is undecided (the design's). */
export const APPROVE_NOTE = "Approving makes this page live for everyone.";

/** "3 lines added, 1 removed" — what the diff box's header says, from the diff's own rows. */
export function changedLinesText(diff: readonly DiffEntry[]): string {
  const added = diff.filter((e) => e.t === "add").length, removed = diff.filter((e) => e.t === "del").length;
  const n = (k: number, w: string) => `${k} ${k === 1 ? "line" : "lines"} ${w}`;
  if (added && removed) return `${n(added, "added")}, ${removed} removed`;
  if (added) return n(added, "added");
  if (removed) return n(removed, "removed");
  return "No line changes";
}

/** The page's kind, as the pane's mark says it (the design's): a new page, an import's new version of a live page,
 *  or an agent's change to one. */
export function pageKindWord(it: Pick<ReviewItem, "isNew" | "title">, kind: ReviewGroup["kind"]): string {
  return it.isNew ? "New page" : kind === "import" ? `New version of ${it.title}` : "Change to a live page";
}
const PAGE_KIND_TIP = {
  new: "A page nothing is live under yet. Nobody reads it until it is approved.",
  version: "A new version of a page that is live. Everyone reads the live one until this is approved.",
} as const;

/** "What changes" and the lines: removals red with a "−", additions green with a "+", the context between quiet. */
function changeBox(diff: readonly DiffEntry[]): string {
  const rows = diff.map((e) => {
    if (e.t === "gap") return "";
    if (e.t === "ellipsis") return `<div class="cnpy-rvp-dl" data-t="gap">${esc(e.s ?? "")}</div>`;
    const ch = e.t === "del" ? "−" : e.t === "add" ? "+" : " ";
    return `<div class="cnpy-rvp-dl" data-t="${e.t === "del" || e.t === "add" ? e.t : "ctx"}"><span class="cnpy-rvp-dp" aria-hidden="true">${ch}</span>${esc(e.s ?? "")}</div>`;
  }).join("");
  return `<div class="cnpy-rvp-diff" style="border-radius:4px">
      <div class="cnpy-rvp-dh"><span style="font-weight:600;color:var(--fg)">What changes</span><span>${esc(changedLinesText(diff))}</span></div>
      <div class="cnpy-rvp-dls">${rows}</div>
    </div>`;
}

/** The page as it will read: the reader's renderer, each `[[slug]]` as its words (where it goes is the doc page's). */
function pagePreview(body: string): string {
  return body.trim()
    ? `<div class="cnpy-md cnpy-rvp-md">${renderMarkdown(replaceDocLinks(body, (l) => esc(l.label ?? l.slug)))}</div>`
    : `<p class="cnpy-rvp-none">This page has no text yet.</p>`;
}

/** A group's page, picked (the design's right pane): "Page i of N · ‹short›" with the arrows, the crumb (its own
 *  space, then the pages above it), the title, its kind ("New page" / "New version of ‹Title›" / "Change to a live
 *  page", and "from ‹file›" for an import), Trov's own notes on it (the risk, Ask's flags, a stale base), the diff
 *  box for a change, then the page rendered — and the footer: "Approving makes this page live for everyone.",
 *  Reject, ✓ Approve (the queue's own verdict acts, cookie routes). The body is keyed by the page: another page
 *  REPLACES it. */
export function reviewPagePane(it: ReviewItem, g: ReviewGroup, total: number, leaving: Record<string, ReviewVerdict>, spaceName: string, aiUi: AiChipUi = NO_AI_UI, order?: readonly string[]): string {
  const crumb = [spaceName, ...(it.path ?? [])].filter(Boolean).join(" › ");
  const kind = stateMark(pageKindWord(it, g.kind), "var(--fg-55)", "dashed", 12.5, it.isNew ? PAGE_KIND_TIP.new : PAGE_KIND_TIP.version);
  const id = attr(it.id);
  return `<div class="cnpy-rvp">
    ${importPageBar(it, g, leaving, total, order)}
    <div class="cnpy-rv-body cnpy-rvp-body" data-morph-key="rvd:${id}">
      ${crumb ? `<div class="cnpy-rvp-crumb">${esc(crumb)}</div>` : ""}
      <h2 class="cnpy-rvp-h">${esc(it.title)}</h2>
      <div class="cnpy-rvp-kind">${kind}${g.kind === "import" && it.importPath ? `<span class="cnpy-rvp-file">from ${esc(it.importPath)}</span>` : ""}${it.flagged ? LOW_CONFIDENCE(12) : ""}</div>
      ${it.ai ? reviewRiskLine(it.ai, aiUi) : ""}${it.askFlags?.length ? askFlagsLine(it.askFlags) : ""}${it.stale && it.staleNote ? staleBaseWarning(it.staleNote) : ""}
      ${it.isNew ? "" : changeBox(it.diff ?? [])}
      <div class="cnpy-rvp-page">${pagePreview(it.proposedBody ?? "")}</div>
    </div>
    <div class="cnpy-rvp-foot" data-morph-key="rvf:${id}">
      <span class="cnpy-rvp-note">${esc(APPROVE_NOTE)}</span>
      <button type="button" data-act="reviewReject" data-arg="${id}" class="cnpy-rejectbtn cnpy-rvp-btn" style="border-radius:8px;border:1px solid var(--border-strong);color:var(--fg-70);background:transparent">Reject</button>
      <button type="button" data-act="reviewAccept" data-arg="${id}" class="cnpy-accentbtn cnpy-rvp-btn" style="border-radius:8px;padding:0 14px;font-weight:600;background:var(--accent);color:var(--accent-fg);border:1px solid var(--accent)">${CHECK_ICON}Approve</button>
    </div>
  </div>`;
}

/** The detail pane with groups waiting but no page picked. */
export const REVIEW_PICK = "Open a group and pick a page to read it here. Or approve a whole group at once.";

export function reviewView(p: ReviewProps): string {
  const leaving = p.leaving ?? {};
  const waiting = p.items.filter((it) => !leaving[it.id]);
  const inFilter = (it: ReviewItem) => inReviewFilter(it, p.filter);
  const visible = p.items.filter(inFilter);            // the rows on screen, the leaving ones among them
  const visibleWaiting = waiting.filter(inFilter);
  const groups = reviewGroups(p.items);
  // Selection survives a filter that hides it (the detail keeps showing it); with nothing explicitly selected, the
  // first visible item still waiting that is in NO group — a drafted decision (a group's pages are opened from it).
  const sel = (p.selectedId !== null ? waiting.find((it) => it.id === p.selectedId) : undefined) ?? visibleWaiting.find((it) => groupKeyOf(it) === null) ?? null;
  const counts: Record<ReviewFilter, number> | null = p.loading ? null : {
    all: waiting.length,
    imports: waiting.filter((it) => it.importId != null).length,
    agents: waiting.filter((it) => it.importId == null).length,
  };

  // The list is KEYED (`data-morph-list`): rows pair by `data-morph-key`, so a filter or a verdict
  // inserts and removes rows and leaves every other row the element it was. When the last row is
  // leaving, the empty layout is already under it and rises as the row collapses — no jump. A group's pages (an
  // import's, an agent's) are ONE row: its group card, where its newest page would be.
  const seen = new Set<string>();
  const rows = visible.map((it) => {
    const key = groupKeyOf(it);
    if (key === null) return reviewCard(it, sel !== null && it.id === sel.id, leaving[it.id] ?? null);
    if (seen.has(key)) return "";
    seen.add(key);
    const g = groups.get(key);
    return g ? groupCard(g, p, sel, leaving) : "";
  }).join("");
  const list = p.loading ? `<div data-morph-key="rv-skel">${reviewListSkeleton()}</div>`
    : `${rows}${visibleWaiting.length === 0 ? `<div data-morph-key="rv-empty">${reviewListEmpty(p.filter === "all")}</div>` : ""}`;

  const selKey = sel ? groupKeyOf(sel) : null;
  const g = selKey !== null ? groups.get(selKey) ?? null : null;
  const detail = p.loading ? reviewDetailSkeleton()
    : sel ? (g ? reviewPagePane(sel, g, Math.max(p.groupTotals?.[g.key] ?? 0, g.items.length), leaving, p.spaceNames?.[sel.space ?? ""] ?? sel.space ?? "", p.aiUi, p.groupPages?.[g.key]) : reviewDetail(sel, p.diffView, p.aiUi))
    : waiting.length > 0 ? `<div style="${DETAIL_FRAME}"><p style="font-size:13px;line-height:1.5;color:var(--fg-55);max-width:52ch;margin:0 0 18px">${esc(REVIEW_PICK)}</p>${emptyShapes(reviewDetailShapes(2))}</div>`
    : reviewQueueClear();
  // Under a tablet's width the two panes take turns (trov.css `.cnpy-rv`): the list, or —
  // once an item is picked by hand — its detail, with a back button to the list.
  const pane = p.selectedId !== null && sel ? "detail" : "list";
  return `<div class="cnpy-rv" data-pane="${pane}" style="display:flex;height:100%;min-width:0">
    <div class="cnpy-rv-list" style="flex:.95 1 0;min-width:420px;border-right:1px solid var(--border);display:flex;flex-direction:column;min-height:0">
      <div style="padding:16px 20px 0">
        <div style="font-size:12.5px;color:var(--fg-55)">${esc(REVIEW_INTRO)}</div>
        ${reviewFilterSwitch(p.filter, counts)}
      </div>
      <div class="cnpy-scroll cnpy-stagger cnpy-rv-rows" data-morph-list style="flex:1;overflow-y:auto;padding:2px 14px 80px">${list}</div>
    </div>
    <div class="cnpy-scroll cnpy-rv-detail" style="flex:1.05 1 0;min-width:0;overflow-y:auto">
      <button data-act="reviewBack" class="cnpy-rv-back">${BACK_ICON}All items</button>
      ${detail}
    </div>
  </div>`;
}

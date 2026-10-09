// Review surface — componentized from Canopy Triage.dc.html (the static design
// output). One queue for everything agent-produced that needs a human verdict:
// doc proposals (diff against live) and drafted decisions (ADR record).
//
// Every component here is purely presentational: data arrives through props
// and renders to an HTML string in the app's template-string idiom.
// Interactions dispatch via data-act / data-arg handled in main.ts. No fetching,
// no inline data.

import { esc, attr, statusBadge, MONO_LABEL, surface, SURFACE } from "./ui";
import { segmented } from "./segmented";
import { renderedDoc } from "./review-rendered";
import { personChip, personLink, handleTag } from "./people";
import type { PersonColor } from "@shared/rows";
import { emptyLayout, emptyShapes, skeleton, skBar, skBox, skLine, skLines, skList, skW, skProse } from "./skeleton";

// ── prop shapes (loose for now — reshaped at wire time) ──────────────────────
export type ReviewKind = "proposal" | "decision";
export type ReviewFilter = "all" | ReviewKind;
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
  badge: string;
  badgeColor: string; // CSS var expression, e.g. "var(--amber)"
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
  /** Gate's scrutinize signal: staged with low_confidence = 1. Rendered as a small marker. */
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
}

export interface ReviewProps {
  /** Items still pending a verdict (unfiltered). */
  items: ReviewItem[];
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
}

// ── list pane ────────────────────────────────────────────────────────────────
/** All / Proposals / Decisions: ONE list, three views of it — a pick-one, so `segmented()`
 *  (not a tab bar: the page below does not change section, the list narrows). Each option
 *  carries how many are waiting; a zero stays, so the switch never changes width. */
export function reviewFilterSwitch(filter: ReviewFilter, counts: Record<ReviewFilter, number> | null): string {
  const n = (k: ReviewFilter) => (counts ? `<span class="cnpy-seg-n">${counts[k]}</span>` : "");
  return `<div style="margin:12px 0 12px">${segmented({
    id: "review-filter", ariaLabel: "Show", act: "reviewFilter", value: filter, size: "sm", inertOn: true,
    options: [
      { value: "all", label: "All", trail: n("all") },
      { value: "proposal", label: "Proposals", trail: n("proposal") },
      { value: "decision", label: "Decisions", trail: n("decision") },
    ],
  })}</div>`;
}

/** One review queue row — mirrors the detail header: title first, status badge
 *  up-right on the title row, 2-line summary, then a byline that folds the
 *  record type · identifier (label-face) into the author · date. */
export function reviewCard(it: ReviewItem, selected: boolean, verdict: ReviewVerdict | null = null): string {
  const { type, id } = splitEyebrow(it.eyebrow);
  const dot = `<span style="color:var(--fg-40)">·</span>`;
  // The row is the list's KEYED child (`data-morph-key`): a repaint patches it in place, so a card
  // that leaves can collapse and the cards under it glide up as the same elements. Its structure is
  // the same in every state — the selection bar and the verdict label are always emitted and shown
  // by attribute. A row with a verdict is `inert`: it is on its way out.
  return `<div class="cnpy-rv-row" data-morph-key="rv:${attr(it.id)}"${verdict ? ` data-verdict="${verdict}" inert` : ""}><div class="cnpy-rv-row-in"><button data-act="reviewSelect" data-arg="${attr(it.id)}" class="cnpy-titem ${SURFACE} cnpy-card"${selected ? ` aria-current="true"` : ""}>
    <span class="cnpy-selbar"></span>
    <div class="cnpy-rv-card-in" style="position:relative">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
        <div style="font-size:14px;font-weight:600;letter-spacing:-0.005em;color:var(--fg);min-width:0">${esc(it.title)}</div>
        <div style="display:flex;align-items:center;gap:6px;flex:none">${statusBadge(it.badge, it.badgeColor)}${it.flagged ? statusBadge("FLAGGED", "var(--amber)") : ""}</div>
      </div>
      <div style="font-size:12.5px;color:var(--fg-55);margin-top:5px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(it.summary)}</div>
      <div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-top:10px;font-size:11.5px;color:var(--fg-55)">
        ${type ? `<span>${esc(type)}</span>` : ""}
        ${id ? `${dot}<span style="font-family:var(--label);font-size:11px;color:var(--fg-55)">${esc(id)}</span>` : ""}
        ${dot}<span style="display:inline-flex;align-items:center;gap:6px">${agentBit(it, 18)}</span>
        ${dot}<span style="color:var(--fg-40)">${esc(it.time)}</span>
      </div>
    </div>
    <span class="cnpy-rv-verdict" aria-hidden="true">${verdict ? `${verdict === "rejected" ? X_ICON : CHECK_ICON}${VERDICT_LABEL[verdict]}` : ""}</span>
  </button></div></div>`;
}
const CHECK_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg>`;
const X_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"></path></svg>`;

/** The agent byline piece: a colored chip + handleTag when mapped to a person,
 *  else a bare muted handleTag (personChip falls back to initials). */
function agentBit(it: ReviewItem, chipSize: number): string {
  const p = it.agentColor ? { handle: it.agent, color: it.agentColor, avatar_url: it.agentAvatar } : null;
  return `${personChip(p, chipSize, it.agent)}${handleTag(p, it.agent)}`;
}
/** The same pair as ONE chip that opens the person's card — the detail header's byline (the
 *  list card is itself a button that selects, so it keeps `agentBit`). Plain when unmapped. */
function agentLink(it: ReviewItem, chipSize: number): string {
  const p = it.agentColor ? { handle: it.agent, color: it.agentColor, avatar_url: it.agentAvatar } : null;
  const person = p && it.agentHandle ? { handle: it.agentHandle, name: it.agentName, color: p.color, avatar_url: p.avatar_url } : null;
  return personLink(person, it.agent, chipSize, { html: handleTag(p, it.agent) }, "", 6);
}

/** Review's empty sentence: what the queue holds and what a person does with it (the Guide ›
 *  Review). Nothing here is made by hand, and a clear queue is a normal state, so no action. */
export const REVIEW_EMPTY = "Nothing is waiting for review. A doc change or a decision an agent stages shows here, to promote, ratify or reject.";
/** The list pane with nothing in it: the sentence, then the queue's cards drawn empty. `all` =
 *  no filter is on; under the Proposals / Decisions filter the other kind may still be waiting. */
export function reviewListEmpty(all = true): string {
  return emptyLayout("review-list", { text: all ? REVIEW_EMPTY : "Nothing of this kind is waiting for review.", sayStyle: "margin:4px 0 10px", shapes: all ? skList(2, reviewCardShape) : "" });
}

// ── detail pane pieces ───────────────────────────────────────────────────────
export function staleBaseWarning(note: string): string {
  return `<div${surface("border-left:2px solid var(--amber);padding:11px 15px;margin-top:18px;display:flex;gap:10px;align-items:baseline")}>
    <div style="font-family:var(--label);font-size:10px;font-weight:600;letter-spacing:.06em;color:var(--amber);flex:none">STALE BASE</div>
    <div style="font-size:12.5px;color:var(--fg-70)">${esc(note)}</div>
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
  const id = at === -1 ? "" : eyebrow.slice(at + 3);
  const type = rawType ? rawType.charAt(0) + rawType.slice(1).toLowerCase() : "";
  return { type, id };
}

// The header's status chips and its two buttons are ONE height, so the row reads as a set.
const HEAD_BTN = "box-sizing:border-box;height:34px;display:inline-flex;align-items:center;border-radius:8px;font-size:12.5px";
const HEAD_CHIP = "box-sizing:border-box;height:34px;display:inline-flex;align-items:center;border-radius:8px;padding:0 12px;font-size:11.5px";

export function reviewDetail(it: ReviewItem, diffView: DiffViewMode): string {
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
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;flex:none;padding-top:2px">
        ${statusBadge(it.badge, it.badgeColor, HEAD_CHIP)}${it.flagged ? statusBadge("FLAGGED FOR REVIEW", "var(--amber)", HEAD_CHIP) : ""}
        <button data-act="reviewReject" data-arg="${attr(it.id)}" class="cnpy-rejectbtn" style="${HEAD_BTN};background:transparent;border:1px solid var(--border-strong);padding:0 14px;font-weight:500;color:var(--fg-70);transition:all .12s ease">Reject</button>
        <button data-act="reviewAccept" data-arg="${attr(it.id)}" class="cnpy-accentbtn" style="${HEAD_BTN};background:var(--accent);color:var(--accent-fg);border:1px solid var(--accent);padding:0 17px;font-weight:600">${acceptLabel}</button>
      </div>
    </div>
    ${it.stale && it.staleNote ? staleBaseWarning(it.staleNote) : ""}
    ${content}
  </div>`;
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

export function reviewView(p: ReviewProps): string {
  const leaving = p.leaving ?? {};
  const waiting = p.items.filter((it) => !leaving[it.id]);
  const inFilter = (it: ReviewItem) => p.filter === "all" || it.kind === p.filter;
  const visible = p.items.filter(inFilter);            // the rows on screen, the leaving ones among them
  const visibleWaiting = waiting.filter(inFilter);
  // Selection survives a filter that hides it (the detail keeps showing it);
  // with nothing explicitly selected, default to the first visible item still waiting.
  const sel = (p.selectedId !== null ? waiting.find((it) => it.id === p.selectedId) : undefined) ?? visibleWaiting[0] ?? null;
  const counts: Record<ReviewFilter, number> | null = p.loading ? null : {
    all: waiting.length,
    proposal: waiting.filter((it) => it.kind === "proposal").length,
    decision: waiting.filter((it) => it.kind === "decision").length,
  };

  // The list is KEYED (`data-morph-list`): rows pair by `data-morph-key`, so a filter or a verdict
  // inserts and removes rows and leaves every other row the element it was. When the last row is
  // leaving, the empty layout is already under it and rises as the row collapses — no jump.
  const list = p.loading ? `<div data-morph-key="rv-skel">${reviewListSkeleton()}</div>`
    : `${visible.map((it) => reviewCard(it, sel !== null && it.id === sel.id, leaving[it.id] ?? null)).join("")}${visibleWaiting.length === 0 ? `<div data-morph-key="rv-empty">${reviewListEmpty(p.filter === "all")}</div>` : ""}`;

  // Under a tablet's width the two panes take turns (trov.css `.cnpy-rv`): the list, or —
  // once an item is picked by hand — its detail, with a back button to the list.
  const pane = p.selectedId !== null && sel ? "detail" : "list";
  return `<div class="cnpy-rv" data-pane="${pane}" style="display:flex;height:100%;min-width:0">
    <div class="cnpy-rv-list" style="width:376px;flex:none;border-right:1px solid var(--border);display:flex;flex-direction:column;min-height:0">
      <div style="padding:16px 20px 0">
        <div style="font-size:12.5px;color:var(--fg-55)">${esc(REVIEW_INTRO)}</div>
        ${reviewFilterSwitch(p.filter, counts)}
      </div>
      <div class="cnpy-scroll cnpy-stagger cnpy-rv-rows" data-morph-list style="flex:1;overflow-y:auto;padding:2px 14px 80px">${list}</div>
    </div>
    <div class="cnpy-scroll cnpy-rv-detail" style="flex:1;min-width:0;overflow-y:auto">
      <button data-act="reviewBack" class="cnpy-rv-back">${BACK_ICON}All items</button>
      ${p.loading ? reviewDetailSkeleton() : sel ? reviewDetail(sel, p.diffView) : reviewQueueClear()}
    </div>
  </div>`;
}

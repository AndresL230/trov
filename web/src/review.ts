// Review surface — componentized from Canopy Triage.dc.html (the static design
// output). One queue for everything agent-produced that needs a human verdict:
// doc proposals (diff against live) and drafted decisions (ADR record).
//
// Every component here is purely presentational: data arrives through props
// and renders to an HTML string in the app's template-string idiom.
// Interactions dispatch via data-act / data-arg handled in main.ts. No fetching,
// no inline data.

import { esc, attr, statusBadge, selectChip, dashedCard, MONO_LABEL, surface, SURFACE } from "./ui";
import { personChip, personLink, handleTag } from "./people";
import type { PersonColor } from "@shared/rows";

// ── prop shapes (loose for now — reshaped at wire time) ──────────────────────
export type ReviewKind = "proposal" | "decision";
export type ReviewFilter = "all" | ReviewKind;
export type DiffViewMode = "unified" | "split" | "rendered";

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
  adr?: AdrSection[]; // decisions
}

export interface ReviewProps {
  /** Items still pending a verdict (unfiltered). */
  items: ReviewItem[];
  filter: ReviewFilter;
  /** null → default to the first visible item. */
  selectedId: string | null;
  diffView: DiffViewMode;
}

// ── list pane ────────────────────────────────────────────────────────────────
export function reviewFilterChips(filter: ReviewFilter): string {
  const chips: [ReviewFilter, string][] = [["all", "All"], ["proposal", "Proposals"], ["decision", "Decisions"]];
  return `<div style="display:flex;gap:6px;margin:14px 0 12px">${chips
    .map(([key, label]) => selectChip(label, filter === key, "reviewFilter", key))
    .join("")}</div>`;
}

/** One review queue row — mirrors the detail header: title first, status badge
 *  up-right on the title row, 2-line summary, then a byline that folds the
 *  record type · identifier (label-face) into the author · date. */
export function reviewCard(it: ReviewItem, selected: boolean): string {
  const { type, id } = splitEyebrow(it.eyebrow);
  const dot = `<span style="color:var(--fg-40)">·</span>`;
  return `<button data-act="reviewSelect" data-arg="${attr(it.id)}" class="cnpy-titem ${SURFACE} cnpy-card">
    ${selected ? `<span class="cnpy-selbar"></span>` : ""}
    <div style="position:relative">
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
  </button>`;
}

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

export function reviewListEmpty(): string {
  return dashedCard("All clear", "Nothing is waiting for review.");
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

/** `![alt](/img/<sha256>)` — an uploaded doc image in a markdown line. */
const IMG_MD = /!\[([^\]]*)\]\(\s*<?\/img\/([0-9a-f]{64})>?\s*\)/g;

/** A line's doc images as the pictures themselves, outlined by what the proposal does
 *  to them (added / removed), each opening the lightbox. Empty when the line has none. */
function lineImages(text: string, t: DiffEntry["t"]): string {
  const imgs = [...text.matchAll(IMG_MD)];
  if (!imgs.length) return "";
  const edge = t === "add" ? "var(--green)" : t === "del" ? "var(--red)" : "var(--border)";
  return imgs.map((m) => `<figure style="margin:4px 0 14px">
      <button type="button" class="cnpy-md-img" data-act="docImgZoom" data-arg="${m[2]}" aria-label="Expand image${m[1] ? `: ${esc(m[1])}` : ""}" style="border-color:${edge}${t === "del" ? ";opacity:.55" : ""}"><img src="/img/${m[2]}" alt="${esc(m[1])}" loading="lazy" decoding="async" /></button>
      ${m[1] ? `<figcaption style="font-size:12px;color:var(--fg-40);margin-top:6px${t === "del" ? ";text-decoration:line-through" : ""}">${esc(m[1])}</figcaption>` : ""}
    </figure>`).join("");
}

export function renderedPreview(entries: DiffEntry[]): string {
  const blocks = entries.filter((e) => e.t !== "gap").map((e) => {
    const raw = e.s ?? "";
    const pics = e.t === "ellipsis" ? "" : lineImages(raw, e.t);
    const text = pics ? raw.replace(IMG_MD, "").trim() : raw;
    if (pics && !text) return pics;
    const line = renderedLine(e, text);
    return pics ? line + pics : line;
  }).join("");
  return renderedFrame(blocks);
}

function renderedLine(e: DiffEntry, text: string): string {
  if (e.t === "ellipsis") return `<div style="border-top:1px dashed var(--border);margin:16px 0"></div>`;
  if (e.t === "h") return `<div style="font-size:18px;font-weight:600;letter-spacing:-0.01em;color:var(--fg);margin:18px 0 10px">${esc(text.replace(/^#+\s*/, ""))}</div>`;
  const base = "font-size:15px;line-height:1.72;margin:0 0 10px";
  if (e.t === "del") return `<div style="${base};text-decoration:line-through;color:color-mix(in srgb,var(--red) 75%,transparent);background:color-mix(in srgb,var(--red) 6%,transparent);border-radius:4px;padding:2px 6px">${esc(text)}</div>`;
  if (e.t === "add") return `<div style="${base};color:var(--fg);background:color-mix(in srgb,var(--green) 9%,transparent);border-radius:4px;padding:2px 6px">${esc(text)}</div>`;
  return `<div style="${base};color:var(--fg-70)">${esc(text)}</div>`;
}

function renderedFrame(blocks: string): string {
  return `<div${surface("padding:22px 28px 26px")}>
    ${blocks}
    <div style="display:flex;gap:16px;margin-top:20px;padding-top:14px;border-top:1px solid var(--border)">
      <div style="font-size:11px;color:var(--fg-40)"><span style="color:var(--green)">■</span> added in this proposal</div>
      <div style="font-size:11px;color:var(--fg-40)"><span style="color:var(--red)">■</span> removed (struck)</div>
    </div>
  </div>`;
}

/** "WHAT CHANGED" header + Unified / Side by side / Rendered toggle + the active mode. */
export function diffViewer(entries: DiffEntry[], view: DiffViewMode, liveLabel: string): string {
  const chips: [DiffViewMode, string][] = [["unified", "Unified"], ["split", "Side by side"], ["rendered", "Rendered"]];
  const toggle = chips.map(([key, label]) => selectChip(label, view === key, "reviewDiffView", key, true)).join("");
  const body = view === "split" ? splitDiff(entries, liveLabel)
    : view === "rendered" ? renderedPreview(entries)
    : unifiedDiff(entries);
  return `<div style="display:flex;align-items:center;justify-content:space-between;margin:22px 0 10px">
    <div style="${MONO_LABEL}">WHAT CHANGED</div>
    <div style="display:flex;gap:5px">${toggle}</div>
  </div>
  ${body}`;
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
    : diffViewer(it.diff ?? [], diffView, it.liveVersion ?? "LIVE");
  const { type, id } = splitEyebrow(it.eyebrow);
  // Byline: record type · identifier (label-face, reads as a reference) · author · date.
  const dot = `<span style="color:var(--fg-40)">·</span>`;
  return `<div class="cnpy-rv-body" style="max-width:920px;padding:24px 32px 100px">
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

export function reviewQueueClear(): string {
  return `<div style="height:100%;display:flex;align-items:center;justify-content:center;padding:40px">
    ${dashedCard("Queue is clear", "Everything an agent produced has been reviewed. New proposals will appear here as sessions finish.", true)}
  </div>`;
}

// ── composed surface ─────────────────────────────────────────────────────────
const BACK_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M15 18l-6-6 6-6"></path></svg>`;
export function reviewView(p: ReviewProps): string {
  const visible = p.items.filter((it) => p.filter === "all" || it.kind === p.filter);
  // Selection survives a filter that hides it (the detail keeps showing it);
  // with nothing explicitly selected, default to the first visible item.
  const sel = (p.selectedId !== null ? p.items.find((it) => it.id === p.selectedId) : undefined) ?? visible[0] ?? null;

  const list = visible.length > 0
    ? visible.map((it) => reviewCard(it, sel !== null && it.id === sel.id)).join("")
    : reviewListEmpty();

  // Under a tablet's width the two panes take turns (trov.css `.cnpy-rv`): the list, or —
  // once an item is picked by hand — its detail, with a back button to the list.
  const pane = p.selectedId !== null && sel ? "detail" : "list";
  return `<div class="cnpy-rv" data-pane="${pane}" style="display:flex;height:100%;min-width:0">
    <div class="cnpy-rv-list" style="width:376px;flex:none;border-right:1px solid var(--border);display:flex;flex-direction:column;min-height:0">
      <div style="padding:22px 20px 0">
        <h1 style="margin:0;font-size:22px;font-weight:600;letter-spacing:-0.02em">Review</h1>
        <div style="font-size:12.5px;color:var(--fg-55);margin-top:3px">Agent-produced changes waiting for a verdict.</div>
        ${reviewFilterChips(p.filter)}
      </div>
      <div class="cnpy-scroll cnpy-stagger" style="flex:1;overflow-y:auto;padding:2px 14px 80px">${list}</div>
    </div>
    <div class="cnpy-scroll cnpy-rv-detail" style="flex:1;min-width:0;overflow-y:auto">
      <button data-act="reviewBack" class="cnpy-rv-back">${BACK_ICON}All items</button>
      ${sel ? reviewDetail(sel, p.diffView) : reviewQueueClear()}
    </div>
  </div>`;
}

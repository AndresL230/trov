// Status marks — how a state is shown without a tag (the 2026-10 tag audit, `web-ui.md` › Status marks).
//
// Trov used to paint every state as a small bordered, tinted, letter-spaced UPPERCASE pill. A pill on
// every row is noise, its border reads as a control, and the recipe is the stock look of generated UI.
// The lightest treatment that does the job wins:
//   1. Nothing for the normal state — and nothing where the screen already says it (a "Needs your
//      review" heading, a Promote button).
//   2. A glyph whose SHAPE carries the meaning: a ticket's status (a ring that fills as the ticket
//      moves along) and its priority (signal bars). The word is the glyph's name: beside it
//      (`ticketStatusMark`, `priorityMark`) or, alone, its tooltip and accessible name.
//   3. A small shape and a sentence-case word (`stateMark`) for an exception worth flagging
//      ("Low confidence"). Each tone has its own shape, so it reads without colour.
// Never a pill, never `text-transform:uppercase`. Every mark here is an inline SVG ELEMENT (never a
// `●` character) with no border-radius, so the corners block leaves it alone.

import { TICKET_STATUS_LABEL, type TicketStatus, type TicketPriority } from "@shared/tickets-core";
import { esc } from "./ui";
import type { Authority } from "./api";
import type { HandoffStatus } from "@shared/handoffs";
import type { ArtifactStatus } from "@shared/artifacts-core";

const svg = (size: number, body: string, label: string | null, color: string, viewBox = "0 0 14 14"): string =>
  `<svg width="${size}" height="${size}" viewBox="${viewBox}" fill="none" style="flex:none;display:block;color:${color}"${
    label === null ? ` aria-hidden="true"` : ` role="img" aria-label="${label}"`}>${label === null ? "" : `<title>${label}</title>`}${body}</svg>`;

// ── ticket status ────────────────────────────────────────────────────────────

/** One colour per status — the ONE table (the board, the table, the rail, sprint cards, My Work, the
 *  attach picker and the tour's mock all read it). Triage is quiet; work in flight is the accent,
 *  testing amber; done the accent's filled check; declined faded. */
export const TICKET_STATUS_TONE: Record<TicketStatus, string> = {
  submitted: "var(--fg-55)",
  in_progress: "var(--accent)",
  testing: "var(--amber)",
  done: "var(--accent)",
  declined: "var(--fg-40)",
};

const RING = `<circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.5"/>`;
/** The knock-out inside a filled glyph: the surface's colour, set by `style` (a presentation
 *  attribute does not take `var()`). */
const KNOCK = `fill="none" style="stroke:var(--surface)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"`;
/** The progress glyphs: a ring that fills as work moves along, a check when it is settled, a cross
 *  when it was turned down, a triangle when it is late. Tickets and sprints both read them, so a
 *  shape means the same thing on every screen. */
export type Glyph = "todo" | "half" | "most" | "done" | "declined" | "warn";
const GLYPH: Record<Glyph, string> = {
  // Not started: a dashed ring.
  todo: `<circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.4 1.9"/>`,
  // Half full.
  half: `${RING}<path d="M7 7V3.5A3.5 3.5 0 0 1 7 10.5Z" fill="currentColor"/>`,
  // Three quarters full.
  most: `${RING}<path d="M7 7V3.5A3.5 3.5 0 1 1 3.5 7Z" fill="currentColor"/>`,
  done: `<circle cx="7" cy="7" r="6.25" fill="currentColor"/><path d="M4.3 7.2l1.9 1.9 3.6-3.8" ${KNOCK}/>`,
  declined: `<circle cx="7" cy="7" r="6.25" fill="currentColor"/><path d="M5 5l4 4M9 5l-4 4" ${KNOCK}/>`,
  // Late: a warning triangle with its mark knocked out.
  warn: `<path d="M7 1.4 13 12.2H1Z" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/><path d="M7 5.6v2.8" ${KNOCK} stroke-width="1.5"/><circle cx="7" cy="10.3" r=".8" style="fill:var(--surface)"/>`,
};
/** A progress glyph in `tone`. `label` names it (a tooltip and an accessible name) when it stands
 *  alone; leave it null when the word sits beside it. */
export function glyph(g: Glyph, tone: string, size = 14, label: string | null = null): string {
  return svg(size, GLYPH[g], label === null ? null : esc(label), tone);
}
/** A glyph and its word in sentence case; `size` is the word's font size. */
export function glyphMark(g: Glyph, tone: string, word: string, size = 12.5): string {
  return mark(glyph(g, tone, glyphFor(size)), word, size);
}

const TICKET_GLYPH: Record<TicketStatus, Glyph> = { submitted: "todo", in_progress: "half", testing: "most", done: "done", declined: "declined" };

/** A ticket status as its glyph. `labelled` (the default) names it — a tooltip and an accessible
 *  name — for a glyph that stands alone; pass false when the word sits beside it. */
export function ticketStatusIcon(status: TicketStatus, size = 14, labelled = true): string {
  return glyph(TICKET_GLYPH[status], TICKET_STATUS_TONE[status], size, labelled ? TICKET_STATUS_LABEL[status] : null);
}

/** The glyph and the status's word, in sentence case. `size` is the word's font size. */
export function ticketStatusMark(status: TicketStatus, size = 12.5): string {
  return mark(ticketStatusIcon(status, glyphFor(size), false), TICKET_STATUS_LABEL[status], size);
}

/** A glyph's box for a word of `size`px: a little taller than the word's x-height reads as level. */
const glyphFor = (size: number): number => Math.round(size + 1.5);
const mark = (glyph: string, word: string, size: number): string =>
  `<span style="display:inline-flex;align-items:center;gap:${size < 12 ? 5 : 6}px;font-size:${size}px;color:var(--fg-70);white-space:nowrap">${glyph}${esc(word)}</span>`;

// ── priority ─────────────────────────────────────────────────────────────────

/** Priority's word. MONOCHROME, like it always was (design call #5): the bars carry it, not a hue. */
export const PRIORITY_LABEL: Record<TicketPriority, string> = { high: "High", normal: "Normal", low: "Low" };
const BAR_ON = [true, true, true];
const BARS: Record<TicketPriority, boolean[]> = { high: BAR_ON, normal: [true, true, false], low: [true, false, false] };

/** Priority as three signal bars, as many lit as the priority is high. */
export function priorityIcon(p: TicketPriority, size = 14, labelled = true, color = "var(--fg-70)"): string {
  const bars = BARS[p].map((on, i) =>
    `<rect x="${1.5 + i * 4.2}" y="${8 - i * 3}" width="2.6" height="${4.5 + i * 3}" rx=".6" fill="currentColor"${on ? "" : ` opacity=".25"`}/>`).join("");
  return svg(size, bars, labelled ? `${PRIORITY_LABEL[p]} priority` : null, color);
}

/** The bars and the priority's word. `size` is the word's font size. */
export function priorityMark(p: TicketPriority, size = 12.5): string {
  return mark(priorityIcon(p, glyphFor(size), false), PRIORITY_LABEL[p], size);
}

// ── a state worth flagging ───────────────────────────────────────────────────

/** A shape per meaning, so a mark reads without its colour (Carbon's shape indicators):
 *  dot = fine, ring = waiting, triangle = a warning, diamond = failing, square = stopped,
 *  check = settled by a person. */
export type MarkShape = "dot" | "ring" | "triangle" | "diamond" | "square" | "check";
const SHAPE: Record<MarkShape, string> = {
  dot: `<circle cx="5" cy="5" r="4" fill="currentColor"/>`,
  ring: `<circle cx="5" cy="5" r="3.6" stroke="currentColor" stroke-width="1.6"/>`,
  triangle: `<path d="M5 .8 9.5 9H.5Z" fill="currentColor"/>`,
  diamond: `<path d="M5 .3 9.7 5 5 9.7.3 5Z" fill="currentColor"/>`,
  square: `<rect x=".8" y=".8" width="8.4" height="8.4" rx="1.2" fill="currentColor"/>`,
  // Settled by a person: a filled disc with the check knocked out.
  check: `<circle cx="5" cy="5" r="4.7" fill="currentColor"/><path d="M2.9 5.2l1.4 1.4 2.8-2.9" fill="none" style="stroke:var(--surface)" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>`,
};

/** The shape alone, for a line whose sentence already names the state (a notice: "A newer
 *  proposal is awaiting review."). `size` is the shape's box. */
export function markShape(shape: MarkShape, tone: string, size = 9): string {
  return svg(size, SHAPE[shape], null, tone, "0 0 10 10");
}

/** A small shape in `tone` and a sentence-case word in the text colour (the word keeps its
 *  contrast; the shape carries the hue). `size` is the word's font size. */
export function stateMark(word: string, tone: string, shape: MarkShape, size = 12.5): string {
  return mark(svg(Math.round(size * 0.72), SHAPE[shape], null, tone, "0 0 10 10"), word, size);
}

/** The gate's low-confidence flag on a proposal: an amber triangle and the words. The Review
 *  queue's one per-item mark (everything in it is waiting; its buttons say so). */
export const LOW_CONFIDENCE = (size = 12.5): string => stateMark("Low confidence", "var(--amber)", "triangle", size);

// ── a handoff ────────────────────────────────────────────────────────────────

/** A handoff's state, as a mark: waiting (an open ring), claimed (a quiet dot), expired (a square —
 *  it stopped). The ONE table: the inbox, a handoff's page and the tour's mock read it. */
export const HANDOFF_MARK: Record<HandoffStatus, { word: string; tone: string; shape: MarkShape }> = {
  pending: { word: "Pending", tone: "var(--blue)", shape: "ring" },
  claimed: { word: "Claimed", tone: "var(--fg-40)", shape: "dot" },
  expired: { word: "Expired", tone: "var(--red)", shape: "square" },
};
export function handoffMark(status: HandoffStatus, size = 12.5): string {
  const m = HANDOFF_MARK[status];
  return stateMark(m.word, m.tone, m.shape, size);
}

// ── an artifact ──────────────────────────────────────────────────────────────

/** An artifact's status, as a mark: a draft is not out yet (open ring), published is out (dot),
 *  ratified is settled by a person (check). The ONE table: the ticket's Artifacts block and the
 *  site's teaser read it (the viewer's own control is the Draft / Published / Ratified switch). */
export const ARTIFACT_MARK: Record<ArtifactStatus, { word: string; tone: string; shape: MarkShape }> = {
  draft: { word: "Draft", tone: "var(--fg-55)", shape: "ring" },
  published: { word: "Published", tone: "var(--blue)", shape: "dot" },
  ratified: { word: "Ratified", tone: "var(--accent)", shape: "check" },
};
export function artifactStatusMark(status: ArtifactStatus, size = 12): string {
  const m = ARTIFACT_MARK[status];
  return stateMark(m.word, m.tone, m.shape, size);
}

// ── who wrote it ─────────────────────────────────────────────────────────────

const BOT = `<rect x="4" y="8" width="16" height="11" rx="2" stroke="currentColor" stroke-width="2"/><path d="M12 8V4M8.5 13h.01M15.5 13h.01" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>`;

/** "An agent wrote this" in a byline: the robot glyph and the word, muted, on no box — the
 *  feed's entries and the tour's mocks. `size` is the word's font size. */
export function agentMark(size = 12): string {
  return `<span style="display:inline-flex;align-items:center;gap:4px;font-size:${size}px;color:var(--fg-55);white-space:nowrap">${svg(Math.round(size), BOT, null, "currentColor", "0 0 24 24")}agent</span>`;
}

// ── search authority ─────────────────────────────────────────────────────────

/** A search hit's authority. Live is the normal state, so it has no mark; the rest are not
 *  settled yet and say so in words, after an open ring (waiting) — never a LIVE / PENDING tag. */
export const AUTHORITY_MARK: Record<Authority, { word: string; tone: string } | null> = {
  live: null,
  staged_pending: { word: "Awaiting review", tone: "var(--amber)" },
  unpromoted: { word: "Not yet promoted", tone: "var(--amber)" },
  draft: { word: "Draft", tone: "var(--blue)" },
};
export function authorityMark(a: Authority, size = 12): string {
  const m = AUTHORITY_MARK[a];
  return m ? stateMark(m.word, m.tone, "ring", size) : "";
}

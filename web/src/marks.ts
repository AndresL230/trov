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
//
// Tooltips: a mark carries `data-mtip`, a sentence on what its state MEANS (not the word again), shown
// in the one styled bubble `tip.ts` places. A glyph alone puts its name first ("Testing. Built, and
// being checked before it is done."); its accessible name stays `aria-label` — never a native <title>,
// whose unstyled box would show beside the bubble.

import { TICKET_STATUS_LABEL, type TicketStatus, type TicketPriority } from "@shared/tickets-core";
import { esc, attr } from "./ui";
import type { Authority } from "./api";
import type { HandoffStatus } from "@shared/handoffs";
import type { ArtifactStatus } from "@shared/artifacts-core";
import { tagLineParts, type TagColor } from "@shared/tags-core";
import { TROV_MARK_PATH } from "@shared/mark";
import type { FeedImportance } from "@shared/ai-core";

/** `label` and `tip` arrive escaped. */
const svg = (size: number, body: string, label: string | null, color: string, viewBox = "0 0 14 14", tip: string | null = null): string =>
  `<svg width="${size}" height="${size}" viewBox="${viewBox}" fill="none" style="flex:none;display:block;color:${color}"${
    label === null ? ` aria-hidden="true"` : ` role="img" aria-label="${label}"`}${tip ? ` data-mtip="${tip}"` : ""}>${body}</svg>`;

// ── ticket status ────────────────────────────────────────────────────────────

/** What each status means — the tooltip on its mark. */
export const TICKET_STATUS_HINT: Record<TicketStatus, string> = {
  submitted: "Filed, and waiting for someone to pick it up or decline it.",
  in_progress: "Someone is working on it.",
  testing: "Built, and being checked before it is done.",
  done: "Closed as done.",
  declined: "Closed without doing it.",
};

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
/** A progress glyph in `tone`. `label` names it (its accessible name) when it stands alone, and
 *  `tip` (else the label) is its tooltip; leave both null when the word sits beside it. */
export function glyph(g: Glyph, tone: string, size = 14, label: string | null = null, tip: string | null = null): string {
  const t = tip ?? label;
  return svg(size, GLYPH[g], label === null ? null : esc(label), tone, undefined, t === null ? null : esc(t));
}
/** A glyph and its word in sentence case; `size` is the word's font size, `tip` what the state means. */
export function glyphMark(g: Glyph, tone: string, word: string, size = 12.5, tip: string | null = null): string {
  return mark(glyph(g, tone, glyphFor(size)), word, size, tip);
}

const TICKET_GLYPH: Record<TicketStatus, Glyph> = { submitted: "todo", in_progress: "half", testing: "most", done: "done", declined: "declined" };

/** A ticket status as its glyph. `labelled` (the default) names it — a tooltip and an accessible
 *  name — for a glyph that stands alone; pass false when the word sits beside it. */
export function ticketStatusIcon(status: TicketStatus, size = 14, labelled = true): string {
  const word = TICKET_STATUS_LABEL[status];
  return glyph(TICKET_GLYPH[status], TICKET_STATUS_TONE[status], size, labelled ? word : null, labelled ? `${word}. ${TICKET_STATUS_HINT[status]}` : null);
}

/** The glyph and the status's word, in sentence case. `size` is the word's font size. */
export function ticketStatusMark(status: TicketStatus, size = 12.5): string {
  return mark(ticketStatusIcon(status, glyphFor(size), false), TICKET_STATUS_LABEL[status], size, TICKET_STATUS_HINT[status]);
}

/** A glyph's box for a word of `size`px: a little taller than the word's x-height reads as level. */
const glyphFor = (size: number): number => Math.round(size + 1.5);
const mark = (glyph: string, word: string, size: number, tip: string | null = null): string =>
  `<span${tip ? ` data-mtip="${esc(tip)}"` : ""} style="display:inline-flex;align-items:center;gap:${size < 12 ? 5 : 6}px;font-size:${size}px;color:var(--fg-70);white-space:nowrap">${glyph}${esc(word)}</span>`;

// ── priority ─────────────────────────────────────────────────────────────────

/** Priority's word. MONOCHROME, like it always was (design call #5): the bars carry it, not a hue. */
export const PRIORITY_LABEL: Record<TicketPriority, string> = { high: "High", normal: "Normal", low: "Low" };
const BAR_ON = [true, true, true];
const BARS: Record<TicketPriority, boolean[]> = { high: BAR_ON, normal: [true, true, false], low: [true, false, false] };

/** Priority as three signal bars, as many lit as the priority is high. */
export function priorityIcon(p: TicketPriority, size = 14, labelled = true, color = "var(--fg-70)"): string {
  const bars = BARS[p].map((on, i) =>
    `<rect x="${1.5 + i * 4.2}" y="${8 - i * 3}" width="2.6" height="${4.5 + i * 3}" rx=".6" fill="currentColor"${on ? "" : ` opacity=".25"`}/>`).join("");
  const name = `${PRIORITY_LABEL[p]} priority`;
  return svg(size, bars, labelled ? name : null, color, undefined, labelled ? name : null);
}

/** The bars and the priority's word. `size` is the word's font size; `tip` says what the bars rank
 *  (a ticket's priority by default — a sprint passes its urgency). */
export function priorityMark(p: TicketPriority, size = 12.5, tip = `${PRIORITY_LABEL[p]} priority`): string {
  return mark(priorityIcon(p, glyphFor(size), false), PRIORITY_LABEL[p], size, tip);
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
export function stateMark(word: string, tone: string, shape: MarkShape, size = 12.5, tip: string | null = null): string {
  return mark(svg(Math.round(size * 0.72), SHAPE[shape], null, tone, "0 0 10 10"), word, size, tip);
}

/** What a state MEANS, for the screens whose states are not a workflow (settings, connections,
 *  billing, the platform pages): each kind is one tone and one shape, so "Error" looks the same
 *  on every page and a page never picks its own colour. */
export type StateKind = "good" | "waiting" | "warn" | "bad" | "stopped" | "done" | "off";
export const STATE_KIND: Record<StateKind, { tone: string; shape: MarkShape }> = {
  good: { tone: "var(--green)", shape: "dot" },        // connected, sent, active
  waiting: { tone: "var(--fg-55)", shape: "ring" },     // not set yet, queued, pending, unused
  warn: { tone: "var(--amber)", shape: "triangle" },    // needs attention: past due, suspended, cancelling
  bad: { tone: "var(--red)", shape: "diamond" },        // failed, an error
  stopped: { tone: "var(--red)", shape: "square" },     // ended, a suspended org
  done: { tone: "var(--accent)", shape: "check" },      // settled: used, resolved
  off: { tone: "var(--fg-40)", shape: "square" },       // revoked, expired, no longer used
};
/** A state by what it means: its kind's shape and tone, and the word. */
export function kindMark(word: string, kind: StateKind, size = 12, tip: string | null = null): string {
  const k = STATE_KIND[kind];
  return stateMark(word, k.tone, k.shape, size, tip);
}

/** The gate's low-confidence flag on a proposal: an amber triangle and the words. The Review
 *  queue's one per-item mark (everything in it is waiting; its buttons say so). */
export const LOW_CONFIDENCE = (size = 12.5): string =>
  stateMark("Low confidence", "var(--amber)", "triangle", size, "The agent was not sure of this change. Read it closely before you promote it.");

// ── a handoff ────────────────────────────────────────────────────────────────

/** A handoff's state, as a mark: waiting (an open ring), claimed (a quiet dot), expired (a square —
 *  it stopped). The ONE table: the inbox, a handoff's page and the tour's mock read it. */
export const HANDOFF_MARK: Record<HandoffStatus, { word: string; tone: string; shape: MarkShape; hint: string }> = {
  pending: { word: "Pending", tone: "var(--blue)", shape: "ring", hint: "Waiting for a session to claim it. Unclaimed handoffs expire after 7 days." },
  claimed: { word: "Claimed", tone: "var(--fg-40)", shape: "dot", hint: "A session picked it up." },
  expired: { word: "Expired", tone: "var(--red)", shape: "square", hint: "Nobody claimed it in time." },
};
export function handoffMark(status: HandoffStatus, size = 12.5): string {
  const m = HANDOFF_MARK[status];
  return stateMark(m.word, m.tone, m.shape, size, m.hint);
}

// ── an artifact ──────────────────────────────────────────────────────────────

/** An artifact's status, as a mark: a draft is not out yet (open ring), published is out (dot),
 *  ratified is settled by a person (check). The ONE table: the ticket's Artifacts block and the
 *  site's teaser read it (the viewer's own control is the Draft / Published / Ratified switch). */
export const ARTIFACT_MARK: Record<ArtifactStatus, { word: string; tone: string; shape: MarkShape; hint: string }> = {
  draft: { word: "Draft", tone: "var(--fg-55)", shape: "ring", hint: "Not published yet." },
  published: { word: "Published", tone: "var(--blue)", shape: "dot", hint: "Out for everyone who can see it. Not ratified yet." },
  ratified: { word: "Ratified", tone: "var(--accent)", shape: "check", hint: "A person ratified this version." },
};
export function artifactStatusMark(status: ArtifactStatus, size = 12): string {
  const m = ARTIFACT_MARK[status];
  return stateMark(m.word, m.tone, m.shape, size, m.hint);
}

// ── how much it matters (feed.importance) ────────────────────────────────────

/** Sift's rating of a feed entry (0060, `feed.importance`): notable is a quiet accent dot, breaking an amber
 *  triangle (a warning). Routine — the normal state — and an unrated entry draw NOTHING. The ONE table. */
export const IMPORTANCE_MARK: Record<Exclude<FeedImportance, "routine">, { word: string; tone: string; shape: MarkShape; hint: string }> = {
  notable: { word: "Notable", tone: "var(--accent)", shape: "dot", hint: "Sift rates this worth knowing about: a new feature or a visible change. A rating, not official." },
  breaking: { word: "Breaking", tone: "var(--amber)", shape: "triangle", hint: "Sift rates this a breaking change: something people or agents rely on works differently now. A rating, not official." },
};
/** The mark for a rating, or "" for routine and for none. */
export function importanceMark(i: FeedImportance | null | undefined, size = 12): string {
  const m = i && i !== "routine" ? IMPORTANCE_MARK[i] : undefined;
  return m ? stateMark(m.word, m.tone, m.shape, size, m.hint) : "";
}

// ── who wrote it ─────────────────────────────────────────────────────────────

const BOT = `<rect x="4" y="8" width="16" height="11" rx="2" stroke="currentColor" stroke-width="2"/><path d="M12 8V4M8.5 13h.01M15.5 13h.01" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>`;

/** "An agent wrote this" in a byline: the robot glyph and the word, muted, on no box — the
 *  feed's entries and the tour's mocks. `size` is the word's font size. */
export function agentMark(size = 12): string {
  return `<span data-mtip="Written by an agent session, recorded as this person." style="display:inline-flex;align-items:center;gap:4px;font-size:${size}px;color:var(--fg-55);white-space:nowrap">${svg(Math.round(size), BOT, null, "currentColor", "0 0 24 24")}agent</span>`;
}

/** The Trov AI glyph: the brand logo (`shared/mark.ts` `TROV_MARK_PATH`), filled in the accent, so "Written by
 *  Trov" carries Trov's own mark — the way the robot marks a thing an agent wrote. */
export const AI_GLYPH = `<path d="${TROV_MARK_PATH}" fill="currentColor"/>`;
/** The sentence every written thing's tooltip ends with. */
export const AI_NOT_OFFICIAL = "Not official; check the sources.";

/** "Trov wrote this": the AI glyph in the accent. `tip` (escaped here) says what it was written from —
 *  "Written by Trov from your sessions, … Not official; check the sources." — and is the mark's
 *  tooltip; `label` names it when it stands alone with no words beside it. */
export function aiMark(size = 12, tip: string | null = null, label: string | null = null): string {
  return svg(size, AI_GLYPH, label === null ? null : esc(label), "var(--accent)", "0 0 100 100", tip === null ? null : esc(tip));
}

// ── a shared Ask conversation ────────────────────────────────────────────────

const PEOPLE = `<circle cx="9" cy="8" r="3.2" stroke="currentColor" stroke-width="2"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0M16 5.2a3.2 3.2 0 0 1 0 5.6M17.6 14.6A5.5 5.5 0 0 1 20.5 20" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`;

/** An Ask conversation shared with the org or with people by name (0076 / 0077_ask_sharing): two people, muted — private is the normal state and
 *  has no mark. `tip` (escaped here) says who can read it. `word` false: the glyph alone, named by its label (a
 *  thread row, where the title takes the room). */
export function sharedMark(tip: string, size = 12, word = true): string {
  return word
    ? `<span data-mtip="${esc(tip)}" style="display:inline-flex;align-items:center;gap:5px;font-size:${size}px;color:var(--fg-55);white-space:nowrap">${svg(Math.round(size), PEOPLE, null, "currentColor", "0 0 24 24")}Shared</span>`
    : svg(Math.round(size), PEOPLE, "Shared", "var(--fg-40)", "0 0 24 24", esc(tip));
}

// ── search authority ─────────────────────────────────────────────────────────

/** A search hit's authority. Live is the normal state, so it has no mark; the rest are not
 *  settled yet and say so in words, after an open ring (waiting) — never a LIVE / PENDING tag. */
export const AUTHORITY_MARK: Record<Authority, { word: string; tone: string; hint: string } | null> = {
  live: null,
  staged_pending: { word: "Awaiting review", tone: "var(--amber)", hint: "An agent proposed a change. A person has not promoted it yet." },
  unpromoted: { word: "Not yet promoted", tone: "var(--amber)", hint: "Nothing here is live yet: no version has been promoted." },
  draft: { word: "Draft", tone: "var(--blue)", hint: "A drafted decision. Nobody has ratified it yet." },
};
export function authorityMark(a: Authority, size = 12): string {
  const m = AUTHORITY_MARK[a];
  return m ? stateMark(m.word, m.tone, "ring", size, m.hint) : "";
}

// ── tags ─────────────────────────────────────────────────────────────────────
// A tag is a FACT about an item, not a state, and it is drawn in exactly two ways (the "option C"
// ruling; `web-ui.md` › Tags), both here — the ONE place a tag is drawn:
//   • in a LIST, an item's tags are plain muted words joined by " · " — at most three, then
//     "and N more" (`tagWords`). No colour, no shape: a row never grows because of its tags.
//   • on the item's OWN page, in a tag picker and in Org settings, a tag is a small coloured SQUARE
//     and the word (`tagMark`): 8px, square corners, in the tag's own colour.
// Never a pill, never uppercase, never a circle, ring or triangle (those mean a state, above). A tag's
// word opens the tag's page (`tagOpen`) unless `link` is false.

/** The CSS colour of a tag colour key: the person palette's variable (trov.css `--p-*`), tuned for both themes. */
export const tagTone = (color: TagColor | string): string => `var(--p-${/^[a-z]+$/.test(color) ? color : "slate"})`;

/** The square alone: 8px, no radius. An SVG element (never a character), `aria-hidden` — the word says it. */
export function tagSquare(color: TagColor | string, size = 8): string {
  return `<svg class="cnpy-tagsq" width="${size}" height="${size}" viewBox="0 0 8 8" aria-hidden="true" style="flex:none;display:block;color:${tagTone(color)}"><rect width="8" height="8" fill="currentColor"/></svg>`;
}

const tagWord = (name: string, link: boolean): string => link
  ? `<button type="button" data-act="tagOpen" data-arg="${attr(name)}" class="cnpy-taglink" title="${attr(`Everything tagged ${name}`)}">${esc(name)}</button>`
  : `<span>${esc(name)}</span>`;

export interface TagMarkOpts { size?: number; link?: boolean; retired?: boolean }
/** A tag on its own page, in a picker, in Org settings: the square in the tag's colour and the word. */
export function tagMark(tag: { name: string; color: TagColor | string }, o: TagMarkOpts = {}): string {
  return `<span class="cnpy-tagmark" data-tag="${attr(tag.name)}"${o.retired ? ` data-retired="1"` : ""} style="display:inline-flex;align-items:center;gap:6px;font-size:${o.size ?? 13}px;color:${o.retired ? "var(--fg-40)" : "var(--fg)"};white-space:nowrap">${tagSquare(tag.color)}${tagWord(tag.name, o.link !== false)}</span>`;
}

/** An item's tags in a LIST: plain muted words joined by " · ", the first three, then "and N more".
 *  "" when it has none. */
export function tagWords(tags: readonly string[], o: { size?: number; link?: boolean } = {}): string {
  if (tags.length === 0) return "";
  const { shown, more } = tagLineParts(tags);
  const words = shown.map((t) => tagWord(t, o.link !== false)).join(`<span aria-hidden="true"> · </span>`);
  return `<span class="cnpy-tagwords" style="font-size:${o.size ?? 12}px;color:var(--fg-40);overflow-wrap:anywhere">${words}${more ? `<span style="white-space:nowrap"> and ${more} more</span>` : ""}</span>`;
}

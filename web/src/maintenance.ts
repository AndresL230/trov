// Unplaced — the Triage queue of loose things an agent produced but couldn't place: the queue on the left, the item
// on screen on the right; read one, then place it or discard it. Empty is its normal state — and, since the gate
// stopped sending things here (2026-10-18: it refuses what it cannot place, naming what is valid, and stages what an
// agent was unsure of, flagged), the queue holds only what came before and what an older plugin still sends.
//
// It is a VIEW of Review (2026-10-18): ONE screen, `review`, its view in `state.reviewView` ("unplaced",
// `#review/unplaced`). The header's To review / Unplaced switch (render.ts `triageSwitch`) moves between the two IN
// PLACE — the page is `data-morph="review"` in both, so only the two columns are replaced — the header says Review on
// both, and the sidebar has no Unplaced row: Review's badge counts both queues.
// It is drawn in Review's own frame (review.ts `reviewFrame`: the two columns, taking turns under a tablet's width), the
// queue a KEYED list of Review's surface cards (`.cnpy-rv-row`, so an item placed or discarded leaves by the app's one
// row exit — web-ui.md › A row leaving a list), and the item in Review's reading pane, on Review's colours: the pane's
// own background (`--bg`, as To review's), the item and the Place it as panel each in a white surface card (as To
// review's proposed record is), and Review's page-pane footer, which stays in view, with Discard and Place.
//
// This screen was "Maintenance" until 2026-10-06, with two more tabs — Identity and People. Those are org
// administration, and an org is administered in ONE place, Org settings: matching an unknown login to a person is on
// its Members tab (web/src/identity.ts), the member directory IS that tab, and the e-mail digest policy / schedule /
// outbox are its Notifications tab (web/src/notifications.ts). The module and its `maint…` acts keep the old name; the
// screen is `review` (there is no `maintenance` screen any more). Its address is `#review/unplaced`, and the old
// `#unplaced`, `#maintenance` and `#maintenance/unplaced` links still resolve to it (hash.ts).
//
// Purely presentational: data arrives through props and renders to HTML strings; interactions dispatch via data-act /
// data-arg handled in main.ts.

import { esc, attr, surface, SURFACE, HITBOX, hitArea, MONO_LABEL } from "./ui";
import { personChip, personLink, personAvatarLink } from "./people";
import type { PersonColor } from "@shared/rows";
import { emptyLayout, emptyShapes, skeleton, skBar, skBox, skLine, skLines, skList, skW, skProse } from "./skeleton";
import { LOW_CONFIDENCE, tagMark } from "./marks";
import { segmented } from "./segmented";
import { dropdown, initialDropdownUi, type DropdownProps, type DropdownUi } from "./dropdown";
import type { AiSuggestion } from "@shared/ai-core";
import { unplacedChip, unplacedRowMark, type AiChipUi } from "./ai-cards";
import { REVIEW_EXIT_MS, reviewFrame } from "./review";
import { renderMarkdown } from "./markdown";
import { replaceDocLinks } from "@shared/docs-links-core";
import { DEFAULT_SPACE } from "@shared/docs-core";

const NO_AI_UI: AiChipUi = { busy: [], unavailable: [], reasonOpen: null };

// ── prop shapes ──────────────────────────────────────────────────────────────
/** What the stored item is: a doc proposal, a drafted decision, a feed entry — or a note (free text an agent sent,
 *  which cannot be placed: read, then discarded). */
export type UnplacedKind = "doc" | "decision" | "feed" | "note";

export interface UnplacedItem {
  id: string;
  title: string;
  snippet: string;
  /** Why it is here, in a few words ("Low confidence", "Unknown section", "Agent wasn't sure") — a fact, plain text. */
  reason: string;
  meta: string; // e.g. "AndresL230 · 2h ago"
  /** The gate's (or the agent's) reason, verbatim. */
  reasonNote: string;
  /** The handle that produced it (null when the gate recorded none). */
  author?: string | null;
  /** Relative time it landed, e.g. "2h ago". */
  when?: string;
  /** Trov's open `unplaced.destination` for it (src/ai/attach.ts); absent when there is none. */
  ai?: AiSuggestion[];
  /** What it is (absent → a note). */
  kind?: UnplacedKind;
  /** It was sent with low confidence: the Low confidence mark, as on Review. */
  lowConfidence?: boolean;
  /** Its whole text: a doc's body, a feed entry's body, a note. */
  body?: string;
  /** A drafted decision's parts, in order. */
  adr?: { h: string; p: string }[];
  /** What the agent sent for it, so the picks can start there: the section, the space, the tags. */
  section?: string | null;
  space?: string | null;
  tags?: string[];
}

export type AssignKind = "doc" | "adr" | "feed";
/** How an item left the queue — the word its card wears while it goes. */
export type UnplacedVerdict = "placed" | "discarded";
export const UNPLACED_VERDICT_LABEL: Record<UnplacedVerdict, string> = { placed: "Placed", discarded: "Discarded" };
/** How long a card takes to leave: Review's own exit (the verdict held .13s, then the collapse over `--fx-fast`),
 *  the same CSS (`.cnpy-rv-row[data-verdict]`) — so the two can never drift. */
export const UNPLACED_EXIT_MS = REVIEW_EXIT_MS;

/** The assign flow's REAL vocabulary: the three gate types, and the targets each accepts (doc → section + space;
 *  feed → optional tags; adr → no target). Values come from @shared/vocabulary via the mapping layer — components
 *  never hardcode them. */
export interface AssignOptions {
  kinds: { key: AssignKind; label: string }[];
  sections: string[];
  /** The org's live spaces (the Library's), filled in by render.ts — there is no fixed set any more. */
  spaces: { key: string; label: string }[];
  /** The org's live tags (name and colour), filled in by render.ts. */
  tags: { name: string; color: string }[];
}

export interface Person { id: string; name: string; initials: string; color?: PersonColor; avatar_url?: string | null }

export interface MaintenanceProps {
  /** The queue as it stands — a card on its way out among them (`leaving`). */
  unplaced: UnplacedItem[];
  assign: AssignOptions;
  /** The item picked by hand (null = the first one waiting; under a tablet's width, the list is on screen). */
  assignOpen: string | null;
  /** The person's picks for the item on screen; null = the item's own (what the agent sent, when it is valid). */
  assignKind: AssignKind | null;
  assignSection: string | null;
  assignSpace: string | null;
  assignTags: string[];
  /** The persons directory: an item's author gets their own chip and colour. */
  people: Person[];
  /** Trov's suggestion chip's state (`state.ai`): only read when an item carries `ai`. */
  aiUi?: AiChipUi;
  /** Items just placed or discarded, still on screen: each card wears its verdict and collapses. Out of the
   *  counts, never on screen in the detail. */
  leaving?: Record<string, UnplacedVerdict>;
  /** The open dropdown (the Space picker past four spaces). */
  dd?: DropdownUi;
  /** The queue's first read is still out: the frame is real, the panes hold skeletons. */
  loading?: boolean;
}

// ── shared atoms ─────────────────────────────────────────────────────────────
export const EYEBROW = "font-family:var(--label);font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--fg-40);white-space:nowrap";

const person = (people: Person[], id: string | null | undefined): Person | null =>
  id ? people.find((p) => p.id.toLowerCase() === id.toLowerCase()) ?? null : null;
/** A Person as the chip helpers take it — null (plain, initials) without a color. */
export const chipPerson = (p: Person | null) => (p?.color ? { handle: p.id, name: p.name, color: p.color, avatar_url: p.avatar_url } : null);
export const chipOf = (p: Person | null, size: number, fallback: string) => personChip(chipPerson(p), size, fallback);

const KIND_WORD: Record<UnplacedKind, string> = { doc: "Doc proposal", decision: "Decision", feed: "Feed entry", note: "Note" };
const kindOf = (it: UnplacedItem): UnplacedKind => it.kind ?? "note";
/** A section in sentence case ("Reference") — a fact, never the vocabulary's lowercase or an UPPERCASE label. */
export const sectionLabel = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const ASSIGN_OF: Record<Exclude<UnplacedKind, "note">, AssignKind> = { doc: "doc", decision: "adr", feed: "feed" };

/** Where the item will go if the person presses Place now: their picks, else what the agent sent when the
 *  organization has it (a section of the vocabulary, a live space), else the default space while it is live, else
 *  the Library's first. main.ts files with exactly this, so what the hint says is what is sent. */
export function effectivePicks(it: UnplacedItem, p: Pick<MaintenanceProps, "assign" | "assignKind" | "assignSection" | "assignSpace" | "assignTags">, picked: boolean): {
  kind: AssignKind | null; section: string | null; space: string | null; tags: string[];
} {
  const own = kindOf(it);
  const kind = picked && p.assignKind ? p.assignKind : own === "note" ? null : ASSIGN_OF[own];
  const sentSection = it.section && p.assign.sections.includes(it.section) ? it.section : null;
  // The picks belong to the item on screen: another item's (or none) starts again from what was sent.
  const section = kind === "doc" ? (picked && p.assignSection) || sentSection : null;
  const has = (k: string | null | undefined) => (k ? p.assign.spaces.some((s) => s.key === k) : false);
  const space = kind !== "doc" ? null
    : picked && has(p.assignSpace) ? p.assignSpace
    : has(it.space) ? it.space!
    : has(DEFAULT_SPACE) ? DEFAULT_SPACE
    : p.assign.spaces[0]?.key ?? null;
  return { kind, section, space, tags: kind === "feed" && picked ? p.assignTags : [] };
}

/** The hint beside Place: what placing will do, or what is still missing. */
export function fileHint(kind: AssignKind | null, section: string | null, spaceLabel: string | null = null): string {
  if (!kind) return "Pick what it is first";
  if (kind === "doc") return section ? `Stages a proposal in ${sectionLabel(section)}${spaceLabel ? ` · ${spaceLabel}` : ""}, for Review` : "Pick a section";
  return kind === "adr" ? "Stages a draft decision, for Review" : "Posts it to the feed";
}

/** The Unplaced item on screen: the one `assignOpen` names, else the first. */
export function selectedUnplacedId(items: { id: string }[], assignOpen: string | null): string | null {
  return items.find((u) => u.id === assignOpen)?.id ?? items[0]?.id ?? null;
}

// ── list pane ────────────────────────────────────────────────────────────────
const CHECK_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg>`;
const X_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"></path></svg>`;
const DOT = `<span style="color:var(--fg-40)">·</span>`;

/** One queue card — Review's card (`reviewCard`): the title with the Low confidence mark up-right when it was sent
 *  unsure, two lines of it, then ONE meta line: the author's avatar, what it is, why it is here, when. The card is the
 *  list's KEYED child, its structure the same in every state (the selection bar and the verdict label are always
 *  there, shown by attribute); a card with a verdict is `inert` — it is on its way out. */
export function unplacedCard(u: UnplacedItem, selected: boolean, people: Person[], aiUi: AiChipUi | undefined, verdict: UnplacedVerdict | null = null): string {
  const au = person(people, u.author);
  const cp = chipPerson(au);
  const who = u.author ?? "unknown";
  const avatar = cp ? personAvatarLink(cp, who, 18) : `<span role="img" aria-label="${attr(`@${who}`)}" style="display:inline-flex">${personChip(null, 18, who)}</span>`;
  return `<div class="cnpy-rv-row cnpy-up-row" data-morph-key="up:${attr(u.id)}"${verdict ? ` data-verdict="${verdict}" inert` : ""}><div class="cnpy-rv-row-in"><div class="cnpy-titem ${SURFACE} cnpy-card ${HITBOX}" data-up-card="${attr(u.id)}"${selected ? ` aria-current="true"` : ""}>
    ${hitArea("maintSelect", u.id, u.title).replace("<button ", `<button${selected ? ` aria-current="true"` : ""} `)}
    <span class="cnpy-selbar"></span>
    <div class="cnpy-rv-card-in" style="position:relative">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
        <div style="flex:1 1 auto;font-size:14px;font-weight:600;letter-spacing:-0.005em;color:var(--fg);min-width:0;overflow-wrap:anywhere">${esc(u.title)}</div>
        ${u.lowConfidence ? `<div class="cnpy-rv-marks" style="flex:none;margin-top:1px">${LOW_CONFIDENCE(12)}</div>` : ""}
      </div>
      ${u.snippet && u.snippet !== u.title ? `<div style="font-size:12.5px;color:var(--fg-55);margin-top:5px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere">${esc(u.snippet)}</div>` : ""}
      <div class="cnpy-rv-meta" style="display:flex;align-items:center;flex-wrap:nowrap;white-space:nowrap;overflow:hidden;gap:6px;margin-top:10px;height:20px;font-size:11.5px;line-height:20px;color:var(--fg-55);min-width:0">
        <span data-slot="author" data-mtip="@${attr(who)}" style="flex:none;display:inline-flex;align-items:center">${avatar}</span>
        <span data-slot="kind" style="flex:none">${esc(KIND_WORD[kindOf(u)])}</span>${DOT}
        <span data-slot="why" data-mtip="${attr(u.reasonNote)}" style="flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis">${esc(u.reason)}</span>${DOT}
        <span data-slot="time" style="flex:none;color:var(--fg-40)">${esc(u.when ?? "")}</span>${u.ai ? unplacedRowMark(u.ai, aiUi?.leaving) : ""}
      </div>
    </div>
    <span class="cnpy-rv-verdict" aria-hidden="true">${verdict ? `${verdict === "discarded" ? X_ICON : CHECK_ICON}${UNPLACED_VERDICT_LABEL[verdict]}` : ""}</span>
  </div></div></div>`;
}

/** One card as a shape — the list's loading skeleton and its empty layout. */
function unplacedCardShape(i: number): string {
  return `<div class="cnpy-titem ${SURFACE}">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">${skLine(skW(i), 14, 1.5)}</div>
    <div style="margin-top:5px">${skLines(["94%", skW(i + 1, ["58%", "40%", "72%"])], 12.5, 1.5)}</div>
    <div style="display:flex;align-items:center;gap:8px;margin-top:10px">${skBox(18, 18)}${skLine(150, 11.5, 1.5)}</div>
  </div>`;
}

// ── detail pane ──────────────────────────────────────────────────────────────
const DETAIL_FRAME = "max-width:var(--frame-reader);padding:24px 32px 100px";

function unplacedDetailShapes(paras: number): string {
  return `<div>${skLine(110, 12, 1.5)}<div style="margin-top:8px">${skLine("58%", 25, 1.2)}</div><div style="margin-top:10px">${skLine(220, 12, 1.5)}</div></div>
    <div${surface("padding:14px 16px;margin-top:18px")}>${skBar(120, 8)}<div style="margin-top:10px">${skLines(["86%"], 12.5, 1.5)}</div></div>
    <div${surface(`${CARD_PAD};margin-top:22px`)}>${skProse(paras)}</div>`;
}

/** A card's label row above it — To review's ("PROPOSED RECORD" over the decision's card, review.ts `adrRecord`). */
const CARD_PAD = "padding:24px 28px 26px";
function cardLabel(label: string, note = ""): string {
  return `<div class="cnpy-up-cardlabel" style="display:flex;align-items:center;gap:10px;margin:22px 0 10px">
      <div style="${MONO_LABEL}">${esc(label)}</div>${note ? `<div style="font-size:11.5px;color:var(--fg-40)">${esc(note)}</div>` : ""}
    </div>`;
}

/** The item's text as it will read: a doc's body through the reader's renderer (each `[[slug]]` as its words), a
 *  decision's parts, a feed entry's or a note's text as written. */
function itemContent(it: UnplacedItem): string {
  const k = kindOf(it);
  if (k === "decision" && it.adr?.length) {
    return `<div class="cnpy-up-adr">${it.adr.map((s) => `<div style="margin-bottom:16px">
        <div style="font-size:12px;font-weight:600;color:var(--fg-55);margin-bottom:5px">${esc(s.h)}</div>
        <div style="font-size:14px;line-height:1.65;color:var(--fg-70);overflow-wrap:anywhere">${esc(s.p)}</div>
      </div>`).join("")}</div>`;
  }
  const text = (it.body ?? it.snippet).trim();
  if (!text) return `<p class="cnpy-rvp-none">There is nothing more to it than its title.</p>`;
  if (k === "doc") return `<div class="cnpy-md cnpy-rvp-md">${renderMarkdown(replaceDocLinks(text, (l) => esc(l.label ?? l.slug)))}</div>`;
  return `<p class="cnpy-up-text">${esc(text)}</p>`;
}

/** The Space picker: a switch while the Library has four spaces or fewer, a dropdown past that (New page's rule,
 *  `NEW_DOC_SPACE_SWITCH_MAX`). */
export function unplacedSpaceDropdown(assign: AssignOptions, value: string | null): DropdownProps {
  return { id: "up-space", act: "maintAssignSpace", value: value ?? "", ariaLabel: "Space", size: "sm", options: assign.spaces.map((s) => ({ value: s.key, label: s.label })) };
}

/** "Place it as": what it is, then where (a doc's section and space, a feed entry's tags). The item's own kind and
 *  section are already picked when the agent sent valid ones, so a well-formed item is one press away. A note cannot
 *  be placed: it says so instead. */
export function assignPanel(it: UnplacedItem, p: MaintenanceProps, picked: boolean): string {
  if (kindOf(it) === "note") {
    return `${cardLabel("Place it as")}<div${surface(CARD_PAD, { cls: "cnpy-up-place" })}><p class="cnpy-up-note">This is a note, not a doc, a decision or a feed entry, so there is nowhere to place it. Read it, then discard it.</p></div>`;
  }
  const e = effectivePicks(it, p, picked);
  const kinds = segmented({
    id: "up-kind", ariaLabel: "Place it as", act: "maintAssignKind", value: e.kind ?? "", size: "sm",
    options: p.assign.kinds.map((k) => ({ value: k.key, label: k.label })),
  });
  let target = "";
  if (e.kind === "doc") {
    const sections = segmented({
      id: "up-section", ariaLabel: "Section", act: "maintAssignSection", value: e.section ?? "", size: "sm",
      options: p.assign.sections.map((s) => ({ value: s, label: sectionLabel(s) })),
    });
    const spaces = p.assign.spaces.length === 0 ? `<span style="font-size:12.5px;color:var(--fg-55)">No live space: a person creates or restores one in the Library.</span>`
      : p.assign.spaces.length <= 4 ? segmented({ id: "up-space", ariaLabel: "Space", act: "maintAssignSpace", value: e.space ?? "", size: "sm", options: p.assign.spaces.map((s) => ({ value: s.key, label: s.label })) })
      : dropdown(unplacedSpaceDropdown(p.assign, e.space), p.dd ?? initialDropdownUi());
    target = `<div class="cnpy-up-field"><div class="cnpy-up-label" id="up-section-l">Section</div>${sections}</div>
      <div class="cnpy-up-field"><div class="cnpy-up-label" id="up-space-l">Space</div>${spaces}</div>`;
  } else if (e.kind === "feed") {
    const chips = p.assign.tags.map((t) => {
      const on = p.assignTags.includes(t.name);
      return `<button type="button" data-act="maintAssignTag" data-arg="${attr(t.name)}" class="cnpy-up-tag${on ? " is-on" : ""}" aria-pressed="${on}" style="border-radius:7px">${tagMark(t, { size: 12.5, link: false })}</button>`;
    }).join("");
    target = `<div class="cnpy-up-field"><div class="cnpy-up-label">Tags <span class="cnpy-up-opt">optional — with none picked it keeps the tags it came with that are on your list</span></div>
      <div class="cnpy-up-tags">${chips || `<span style="font-size:12.5px;color:var(--fg-55)">Your organization has no tags yet.</span>`}</div></div>`;
  }
  return `${cardLabel("Place it as")}<div${surface(CARD_PAD, { cls: "cnpy-up-place" })} data-item="${attr(it.id)}">
    ${kinds}
    ${target}
  </div>`;
}

/** The item on screen (Review's page pane, `reviewPagePane`, on To review's colours — `.cnpy-rvp--bg`): where it
 *  stands in the queue, its title, what it is, who sent it and when; why it is here, verbatim; Trov's suggestion; the
 *  item itself in a white card; then "Place it as" in another — and the footer that stays in view: what Place will do,
 *  Discard, Place. The body and the footer are keyed by the item, so another item REPLACES them. */
export function unplacedDetail(it: UnplacedItem, p: MaintenanceProps, idx: number, total: number, picked: boolean): string {
  const au = person(p.people, it.author);
  const e = effectivePicks(it, p, picked);
  const canPlace = kindOf(it) !== "note" && e.kind !== null && (e.kind !== "doc" || (e.section !== null && e.space !== null));
  const spaceLabel = e.space ? p.assign.spaces.find((s) => s.key === e.space)?.label ?? e.space : null;
  const id = attr(it.id);
  return `<div class="cnpy-rvp cnpy-rvp--bg cnpy-up">
    <div class="cnpy-rv-body cnpy-rvp-body" data-morph-key="upd:${id}">
      <div class="cnpy-rvp-crumb">${idx + 1} of ${total} unplaced</div>
      <h2 class="cnpy-rvp-h">${esc(it.title)}</h2>
      <div class="cnpy-rvp-kind">
        <span>${esc(KIND_WORD[kindOf(it)])}</span>${DOT}
        <span style="display:inline-flex;align-items:center;min-width:0">${personLink(chipPerson(au), it.author ?? "?", 18, au?.name ?? it.author ?? "unknown", "min-width:0;overflow:hidden;text-overflow:ellipsis;font-size:12.5px", 6)}</span>${DOT}
        <span style="font-size:12.5px;color:var(--fg-40)">${esc(it.when ?? "")}</span>
        ${it.lowConfidence ? LOW_CONFIDENCE(12) : ""}
      </div>
      <div${surface("padding:12px 15px;margin-top:18px", { cls: "cnpy-up-why" })}>
        <div style="font-size:12px;font-weight:600;color:var(--fg-70)">Why it wasn't placed</div>
        <div style="font-size:12.5px;line-height:1.55;color:var(--fg-55);margin-top:4px;overflow-wrap:anywhere">${esc(it.reasonNote)}</div>
      </div>
      ${it.ai ? unplacedChip(it.ai, p.aiUi ?? NO_AI_UI) : ""}
      ${cardLabel("What the agent sent")}
      <div${surface(CARD_PAD, { cls: "cnpy-up-item" })}>${itemContent(it)}</div>
      ${assignPanel(it, p, picked)}
    </div>
    <div class="cnpy-rvp-foot" data-morph-key="upf:${id}">
      <span class="cnpy-rvp-note">${esc(kindOf(it) === "note" ? "Discarding takes it out of the queue. You can undo it." : fileHint(e.kind, e.section, spaceLabel))}</span>
      <button type="button" data-act="maintDiscard" data-arg="${id}" class="cnpy-rejectbtn cnpy-rvp-btn" style="border-radius:8px;border:1px solid var(--border-strong);color:var(--fg-70);background:transparent">Discard</button>
      ${kindOf(it) === "note" ? "" : `<button type="button"${canPlace ? ` data-act="maintFile" data-arg="${id}"` : " disabled"} class="${canPlace ? "cnpy-accentbtn " : ""}cnpy-rvp-btn cnpy-up-place-btn" style="border-radius:8px;padding:0 14px;font-weight:600;${canPlace ? "background:var(--accent);color:var(--accent-fg);border:1px solid var(--accent)" : "background:transparent;color:var(--fg-40);border:1px solid var(--border)"}">${CHECK_ICON}Place</button>`}
    </div>
  </div>`;
}

// ── composed surface ─────────────────────────────────────────────────────────
export const UNPLACED_INTRO = "Things an agent produced but couldn't place. Place each where it belongs, or discard it.";
/** Unplaced's empty words: empty is this queue's normal state (the Guide › Review says so) — and, now that agents
 *  are told what is valid instead, the usual one. */
export const UNPLACED_EMPTY_TITLE = "Nothing unplaced";
export const UNPLACED_EMPTY = "This is the queue's normal state. When an agent sends something Trov can't place, Trov tells the agent what is valid, so very little ever waits here.";

/** The Unplaced screen while its queue's first read is out: the frame and intro are real, the panes skeletons (never
 *  "Nothing unplaced" before it is known). */
export function maintenanceSkeleton(): string {
  return maintenanceView({
    unplaced: [], assign: { kinds: [], sections: [], spaces: [], tags: [] }, assignOpen: null, assignKind: null,
    assignSection: null, assignSpace: null, assignTags: [], people: [], loading: true,
  });
}

/** The page: Review's two panes — the intro and the queue, the item on screen. A degraded `hint` above. How many
 *  wait is the count on the header's To review / Unplaced switch (render.ts `triageSwitch`), as Review's are on its. */
export function maintenanceView(p: MaintenanceProps, hint = ""): string {
  const leaving = p.leaving ?? {};
  const waiting = p.unplaced.filter((u) => !leaving[u.id]);
  const sel = waiting.find((u) => u.id === p.assignOpen) ?? waiting[0] ?? null;
  const picked = sel !== null && sel.id === p.assignOpen;
  const idx = sel ? waiting.indexOf(sel) : -1;

  // The list is KEYED (`data-morph-list`): rows pair by `data-morph-key`, so a card that leaves collapses and the
  // cards under it glide up as the same elements. When the last one is leaving, the empty layout is already under
  // it and rises as the card collapses — no jump.
  const rows = p.unplaced.map((u) => unplacedCard(u, sel !== null && u.id === sel.id, p.people, p.aiUi, leaving[u.id] ?? null)).join("");
  const list = p.loading
    ? `<div data-morph-key="up-skel">${skeleton("unplaced", "Loading the queue&hellip;", skList(4, unplacedCardShape))}</div>`
    : `${rows}${waiting.length === 0 ? `<div data-morph-key="up-empty">${emptyLayout("unplaced", { title: UNPLACED_EMPTY_TITLE, text: UNPLACED_EMPTY, sayStyle: "margin:4px 0 10px", shapes: skList(2, unplacedCardShape) })}</div>` : ""}`;
  const detail = p.loading ? skeleton("unplaced-detail", "Loading the queue&hellip;", unplacedDetailShapes(3), DETAIL_FRAME)
    : sel ? unplacedDetail(sel, p, idx, waiting.length, picked)
    : emptyShapes(unplacedDetailShapes(2), { style: DETAIL_FRAME });
  // Under a tablet's width the two panes take turns (trov.css `.cnpy-rv`): the list, or — once an item is picked by
  // hand — the item, with a back button to the list. The frame is Review's own (`reviewFrame`), keyed by the view.
  const pane = picked ? "detail" : "list";
  return `${hint}${reviewFrame({
    view: "unplaced", pane, backAct: "maintBack", cls: "cnpy-up-screen", label: "Unplaced",
    // Review's list head: the intro, then (where Review has its filter) the same 12px before the first card.
    head: `<div style="font-size:12.5px;color:var(--fg-55);margin-bottom:12px">${esc(UNPLACED_INTRO)}</div>`,
    list, detail,
  })}`;
}

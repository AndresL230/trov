// The Trov AI kit — what every screen that shows something Trov WROTE is built from (web-ui.md › The
// AI kit). Pure markup over the trov.css tokens; the acts it emits (`ai…`) are ai-actions.ts's.
//
//   • `aiByline` — the AI mark (marks.ts `aiMark`), "Written by Trov, 12m ago", and the not-official
//     tooltip. Every written item carries one; nothing Trov wrote is ever shown without it.
//   • `aiCite` / `aiCites` — a written line's sources (`AiCite`): a link when the source has a page
//     (GitHub opens in a new tab, like the app's other GitHub links; an in-app route stays here),
//     plain text when it has none. The server builds them; the model never writes a URL.
//   • `aiWrongBtn` — "Wrong?": POSTs `/ai/feedback` and hides the item for the person who pressed it
//     (optimistic; back on a failure).
//   • `aiSuggestionChip` — "Suggested: X, because …" with Accept and Dismiss (#157): a value Trov
//     proposes, drawn so it is never mistaken for one a person set (a dashed outline, the mark, muted
//     text), its reason one tap away (a real disclosure button, so it works on touch).
//   • `aiCapped` / `AI_EMPTY` — the allowance-used line ("Upgrade to Pro" only when the org is on Free)
//     and each screen's empty sentence, in the mock's words.
//
// OFF IS NOT A STATE: a screen whose field is absent renders exactly what it rendered before
// (test/render.ai-absent.test.ts). Nothing here is called unless the field is present.

import type { AiCite, AiFeedbackBody, AiItemType, AiMeta, AiThemeRange } from "@shared/ai-core";
import { aiMark, AI_NOT_OFFICIAL } from "./marks";
import { esc, attr, relTime } from "./ui";

// ── state ────────────────────────────────────────────────────────────────────

/** The Feed's Source switch: every entry, the agents' (no `ai`, or `origin: "agent"`), or Trov's. */
export type AiFeedSource = "all" | "agents" | "trov";
export const AI_FEED_SOURCES: readonly AiFeedSource[] = ["all", "agents", "trov"];

/** Everything the AI screens keep in AppState (`state.ai`). Session-only, except `noteSeen`. */
export interface AiUi {
  /** Items this person pressed "Wrong?" on (`aiHiddenKey`): hidden at once, before the server
   *  answers; a failed write takes the key out again. */
  hidden: string[];
  feedSource: AiFeedSource;
  /** Handles that pressed "Got it" on the Feed's note, on this browser (`trov.aiFeedNote`). */
  noteSeen: string[];
  /** Repo › Planning › Where the work went: the range on screen and the lane picked. */
  themesRange: AiThemeRange;
  themesLane: string | null;
  /** A proposed theme being renamed: its suggestion and the typed name. */
  rename: { id: number; draft: string } | null;
  /** Suggestions with an Accept / Dismiss out. */
  busy: number[];
  /** Suggestions whose Accept / Dismiss answered 409 `not_available`. */
  unavailable: number[];
  /** The suggestion chip whose reason is open (its key), or null. */
  reasonOpen: string | null;
  /** Items on their way out (`aiHiddenKey`, or `AI_NOTE_LEAVING` for the Feed's note) and when they
   *  started: drawn collapsing for `AI_EXIT_MS`, then gone (`aiLeavingT`). Never under reduced motion. */
  leaving: { key: string; at: number }[];
}
export function initialAiUi(): AiUi {
  return { hidden: [], feedSource: "all", noteSeen: [], themesRange: "8w", themesLane: null, rename: null, busy: [], unavailable: [], reasonOpen: null, leaving: [] };
}
/** The localStorage key "Got it" is remembered under: a JSON list of handles (per person, per browser). */
export const AI_NOTE_KEY = "trov.aiFeedNote";

/** What `hidden` holds for one item. */
export const aiHiddenKey = (itemType: AiItemType, itemRef: string): string => `${itemType}:${itemRef}`;
export const aiIsHidden = (ui: Pick<AiUi, "hidden">, itemType: AiItemType, itemRef: string): boolean =>
  ui.hidden.includes(aiHiddenKey(itemType, itemRef));

// ── Leaving: "Wrong?" and the note's "Got it" (web-ui.md › A row leaving a list) ──
// The item is hidden at once in state (`hidden`, `noteSeen`) — every count already leaves it out — but
// is still DRAWN for `AI_EXIT_MS`: `inert`, dimmed for .13s, then collapsed (a one-track grid, `1fr` →
// `0fr`) and faded over `--fx-fast`, Review's timing. The Feed and the Repo screen are rebuilt on a
// paint, so the motion is a keyframe whose clock is a NEGATIVE delay (`--leave-t`, elapsed ms) — the
// same trick as `--enter-t`: a rerender mid-exit joins it where it was, never replays it.
export const AI_EXIT_MS = 310;
/** The Feed's one-time note, while it leaves after "Got it". */
export const AI_NOTE_LEAVING = "note:feed";
/** How far into its exit an item is (ms), or null when it is not leaving (or done leaving). */
export function aiLeavingT(ui: Pick<AiUi, "leaving">, key: string, now = Date.now()): number | null {
  const l = ui.leaving.find((x) => x.key === key);
  if (!l) return null;
  const t = Math.max(0, now - l.at);
  return t < AI_EXIT_MS ? t : null;
}
/** An item drawn on its way out. */
export const aiLeave = (html: string, t: number): string =>
  `<div class="cnpy-ai-leave" data-ai-leaving inert style="--leave-t:-${Math.round(t)}ms"><div class="cnpy-ai-leave-in">${html}</div></div>`;

// ── words ────────────────────────────────────────────────────────────────────

/** Each screen's tooltip on its mark: what it was written from, then that it is not official. */
export const AI_TIP = {
  brief: `Written by Trov from your sessions, pull requests, tickets and handoffs. ${AI_NOT_OFFICIAL}`,
  state: `Written by Trov from captured events, tickets and the plan. ${AI_NOT_OFFICIAL}`,
  themes: `Themes and caption written by Trov from this repository's merged pull requests. ${AI_NOT_OFFICIAL}`,
  suggestion: `Suggested by Trov. Nothing changes until a person accepts it. ${AI_NOT_OFFICIAL}`,
} as const;
/** A feed entry's tooltip names its own sources. */
export const aiFeedTip = (sources: AiCite[], more: number): string =>
  `Written by Trov from ${listWords(sources.map((c) => c.label), more)}. ${AI_NOT_OFFICIAL}`;

/** What each screen says when nothing has been written yet (the mock's words). */
export const AI_EMPTY = {
  brief: "Trov writes your brief after your next push or when something is assigned to you. It reads your sessions, pull requests, tickets and handoffs.",
  state: "Trov writes this after your next merge: what shipped, what is in flight, and what needs attention, each linked to its source.",
  themes: "Themes appear once this repo has 15 merged pull requests.",
} as const;

/** "Nov 1" for a `YYYY-MM-DD` day (UTC, as the allowance's month is). "" when it is not a day. */
export function aiDay(day: string | null): string {
  if (!day) return "";
  const d = new Date(`${day.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** "a, b and c", or "a, b, c and 2 more". */
function listWords(words: string[], more = 0): string {
  const all = more > 0 ? [...words, `${more} more`] : words;
  if (all.length <= 1) return all.join("");
  return `${all.slice(0, -1).join(", ")} and ${all[all.length - 1]}`;
}

// ── the pieces ───────────────────────────────────────────────────────────────

const LINK = "color:var(--accent);text-decoration:none";
/** One source: a link when it has a page, plain text when it has none. A GitHub URL opens in a new
 *  tab (`rel="noopener"`, as the app's other GitHub links); an in-app route (`#tickets/14`) stays in
 *  the app. Anything else the server could send is shown as text, never as a link. */
export function aiCite(c: AiCite, style = ""): string {
  const href = c.href ?? "";
  const s = `${LINK}${style ? `;${style}` : ""}`;
  if (/^https?:\/\//i.test(href)) return `<a href="${attr(href)}" target="_blank" rel="noopener" class="cnpy-ai-cite" style="${s}">${esc(c.label)}</a>`;
  if (/^#[A-Za-z]/.test(href)) return `<a href="${attr(href)}" class="cnpy-ai-cite" style="${s}">${esc(c.label)}</a>`;
  return `<span style="color:var(--fg-55)${style ? `;${style}` : ""}">${esc(c.label)}</span>`;
}
/** A line's sources, separated by a muted dot (the mock's "#173 · #172 · #171"). */
export function aiCites(cites: AiCite[], sep = `<span aria-hidden="true" style="color:var(--fg-40)">·</span>`): string {
  return cites.map((c) => aiCite(c)).join(sep);
}
/** A feed entry's "From #173, 65b9f1f, a1c04e2 and 2 more". */
export function aiFromLine(sources: AiCite[], more: number): string {
  if (!sources.length) return "";
  const links = sources.map((c) => aiCite(c));
  const tail = more > 0 ? `${links.join(", ")} and ${more} more` : links.length > 1 ? `${links.slice(0, -1).join(", ")} and ${links[links.length - 1]}` : links[0];
  return `<span>From ${tail}</span>`;
}

/** The mark and "Written by Trov, 12m ago" (`from` adds "from 6 events" before the time), with
 *  `tip` as the tooltip on the whole line. With nothing written yet it is the mark and "Trov". */
export function aiByline(generatedAt: string | null, tip: string, o: { from?: string; size?: number; lead?: string } = {}): string {
  const size = o.size ?? 12.5;
  const when = generatedAt ? relTime(generatedAt) : "";
  const words = generatedAt
    ? `${esc(o.lead ?? "Written by Trov")}${o.from ? ` from ${esc(o.from)}` : ""}${when ? `, ${esc(when)}` : ""}`
    : esc(o.lead ?? "Written by Trov");
  return `<span data-mtip="${attr(tip)}" class="cnpy-ai-by" style="display:inline-flex;align-items:center;gap:6px;color:var(--fg-55);font-size:${size}px;min-width:0">${aiMark(Math.round(size - 0.5))}${words}</span>`;
}

/** What "Wrong?" sends: the item and how it was written. `promptVersion` is the server's to know. */
export function aiFeedback(itemType: AiItemType, itemRef: string, kind: string, model: string | null): AiFeedbackBody {
  return { itemType, itemRef, kind, model, promptVersion: null };
}
/** "Wrong?" as a thumbs-down icon button — hides the item for the person who pressed it, and tells Trov.
 *  It sits at the bottom right of what it judges. `size` is the icon's size in px. */
const THUMBS_DOWN = (size: number): string => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 14V2"></path><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"></path></svg>`;
export function aiWrongBtn(body: AiFeedbackBody, size = 14): string {
  return `<button type="button" data-act="aiWrong" data-arg="${attr(JSON.stringify(body))}" class="cnpy-ghostbtn cnpy-ai-wrong" aria-label="Wrong? Hide this and tell Trov it is wrong" data-mtip="Wrong? Hides this for you and tells Trov." style="display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;padding:0;color:var(--fg-55);border:1px solid var(--border-strong);border-radius:6px;background:transparent">${THUMBS_DOWN(size)}</button>`;
}

/** "Monthly AI allowance used; <clause>." — `clause` says what resumes when ("your brief resumes
 *  Nov 1"). "Upgrade to Pro" only when the org is on Free (`upgrade`); it opens Org settings ›
 *  General, where the plan is changed by whoever may change it. */
export function aiCapped(meta: Pick<AiMeta, "upgrade">, clause: string): string {
  const up = meta.upgrade
    ? ` <button type="button" data-act="orgGo" data-arg="general" class="cnpy-mutelink" style="padding:0;font:inherit;font-weight:500;${LINK}">Upgrade to Pro</button>`
    : "";
  return `<p class="cnpy-ai-capped" style="margin:0;font-size:13px;line-height:1.5;color:var(--amber)">Monthly AI allowance used; ${esc(clause)}.${up}</p>`;
}
/** A screen's sentence for "nothing written yet". */
export const aiEmpty = (text: string): string =>
  `<p class="cnpy-ai-empty" style="margin:0;color:var(--fg-70);line-height:1.55">${esc(text)}</p>`;

// ── the suggestion chip (#157) ───────────────────────────────────────────────

export interface AiChip {
  /** Unique on the page: the reason's disclosure. */
  key: string;
  /** The suggestion behind it (its accept / dismiss routes). */
  id: number;
  label: string;
  reason: string;
  cites?: AiCite[];
}
export interface AiChipOpts {
  open: boolean;
  busy: boolean;
  /** The last Accept / Dismiss answered `not_available`. */
  unavailable: boolean;
  /** The person may act on it (else it reads, and says who can). */
  canAct: boolean;
  /** Words for Dismiss ("Remove" on a theme) and markup for any action between the two (Rename). */
  dismissLabel?: string;
  extra?: string;
  /** What a person who cannot act is told. */
  waiting?: string;
}

const CHIP_BTN = "font-size:12px;font-weight:500;border-radius:6px;padding:2px 9px;min-height:26px;white-space:nowrap";
/** A value Trov proposes: "Suggested: X," and a "because…" disclosure, Accept and Dismiss. Never
 *  styled like a value a person set: a dashed outline, the AI mark, the label muted. It is a
 *  container of buttons, never a button itself, so it sits in a row, a card, a detail pane or a
 *  phone's column (it wraps). */
export function aiSuggestionChip(c: AiChip, o: AiChipOpts): string {
  const rid = `ai-why-${c.key.replace(/[^A-Za-z0-9_-]/g, "-")}`;
  const why = `<button type="button" data-act="aiReason" data-arg="${attr(c.key)}" aria-expanded="${o.open}" aria-controls="${attr(rid)}" class="cnpy-mutelink" style="padding:0;font:inherit;color:var(--fg-55);text-decoration:underline dotted;text-underline-offset:3px">because&hellip;</button>`;
  const acts = o.unavailable
    ? `<span role="status" style="font-size:12px;color:var(--fg-55);white-space:nowrap">Not available yet</span>`
    : o.canAct
      ? `<button type="button" data-act="aiAccept" data-arg="${c.id}"${o.busy ? ' disabled aria-busy="true"' : ""} class="cnpy-ghostbtn" style="${CHIP_BTN};border:1px solid var(--border-strong);color:var(--fg)">Accept</button>${o.extra ?? ""}<button type="button" data-act="aiDismiss" data-arg="${c.id}"${o.busy ? " disabled" : ""} class="cnpy-mutelink" style="${CHIP_BTN};color:var(--fg-55)">${esc(o.dismissLabel ?? "Dismiss")}</button>`
      : o.waiting ? `<span style="font-size:12px;color:var(--fg-55)">${esc(o.waiting)}</span>` : "";
  return `<div class="cnpy-ai-chip" data-ai-chip="${attr(c.key)}" style="display:flex;flex-direction:column;gap:6px;border:1px dashed var(--border-strong);border-radius:8px;padding:6px 8px 6px 10px;color:var(--fg-55);font-size:12.5px;min-width:0;max-width:100%">
    <div style="display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;min-width:0">
      <span data-mtip="${attr(AI_TIP.suggestion)}" style="display:inline-flex;align-items:center;gap:6px;min-width:0">${aiMark(12)}<span style="min-width:0;overflow-wrap:anywhere">Suggested: <span style="color:var(--fg-70);font-weight:500">${esc(c.label)}</span>,</span></span>${why}
      <span style="display:inline-flex;align-items:center;gap:6px;margin-left:auto">${acts}</span>
    </div>
    <div id="${attr(rid)}" class="cnpy-ai-why"${o.open ? "" : " hidden"} style="color:var(--fg-70);line-height:1.5;overflow-wrap:anywhere">because ${esc(c.reason)}${c.cites?.length ? ` <span style="display:inline-flex;flex-wrap:wrap;gap:6px;margin-left:4px">${aiCites(c.cites)}</span>` : ""}</div>
  </div>`;
}

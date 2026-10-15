// The plain-language filter (#162) — its box on Tickets, the Feed and Artifacts (docs/architecture/ai.md ›
// The plain-language filter; the acts are ai-filter-actions.ts's). One field — "Describe a filter: my open
// high-priority bugs" — whose answer is applied to the screen's OWN filter controls, as if the person had
// set them by hand: they show in the Filter menu, each can be changed there, and Undo puts back what the
// screen had before. Never results, and nothing here calls a model: the server does, on Enter.
//
// Drawn only when the org's AI switch is on (`AiFilterUi.on`, from `GET /ai/settings` once per org) — off
// is no box at all, never a disabled one. Pure markup over the trov.css tokens.

import {
  AI_FILTER_PLACEHOLDER, AI_FILTER_TEXT_MAX,
  type AiFilterByScreen, type AiFilterScreen, type ArtifactsAiFilter, type FeedAiFilter, type TicketsAiFilter,
} from "@shared/ai-filter-core";
import { artifactKindLabel } from "@shared/artifacts-core";
import { aiMark } from "./marks";
import { AI_EXIT_MS, aiLeave } from "./ai-ui";
import { anchoredField, fieldError } from "./org-ui";
import { esc, attr } from "./ui";

/** What the screens' filter state held before a filter was applied — Undo restores it. Opaque here. */
export type AiFilterSnapshot = Record<string, unknown>;

export interface AiFilterApplied {
  /** The filter as applied, in words ("Assigned to me", "High priority"). */
  labels: string[];
  /** The request's words this screen cannot filter by. */
  unmatched: string[];
  undo: AiFilterSnapshot;
  /** When it was applied (Date.now()): the line rises in once from then (`appliedLine`). */
  at?: number;
}

/** How long the applied line's rise lasts (the app's one-shot `.cnpy-flash`, .3 s). */
export const AI_FILTER_RISE_MS = 300;

export interface AiFilterUi {
  /** The org the switch was read for, and whether the box is shown there (`enabled`, and a key). */
  org: string | null;
  on: boolean;
  drafts: Record<AiFilterScreen, string>;
  busy: AiFilterScreen | null;
  error: Partial<Record<AiFilterScreen, string>>;
  applied: Partial<Record<AiFilterScreen, AiFilterApplied>>;
  /** A line Undo took, on its way out (the AI kit's one exit, `aiLeave`) — gone after `AI_EXIT_MS`. */
  leaving?: Partial<Record<AiFilterScreen, { applied: AiFilterApplied; at: number }>>;
}

export function initialAiFilterUi(): AiFilterUi {
  return { org: null, on: false, drafts: { tickets: "", feed: "", artifacts: "" }, busy: null, error: {}, applied: {}, leaving: {} };
}

/** The app screen a filter box serves, or null. */
export function aiFilterScreenOf(screen: string): AiFilterScreen | null {
  return screen === "tickets" || screen === "feed" || screen === "artifacts" ? screen : null;
}

const SEND_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 12h14"></path><path d="m13 6 6 6-6 6"></path></svg>`;

/** The box: the field (Enter applies), its Apply button, a floating error, and — once applied — what was set,
 *  what was not a filter here, and Undo. Empty when the org's AI is off. */
export function aiFilterBox(screen: AiFilterScreen, ui: AiFilterUi, now: number = Date.now()): string {
  if (!ui.on) return "";
  const busy = ui.busy === screen;
  const err = ui.error[screen] ?? null;
  const applied = ui.applied[screen];
  const id = `ai-filter-${screen}`;
  const field = `<div class="cnpy-sfbar cnpy-aifilter">
      <label class="cnpy-sfbar-q" for="${id}">
        ${aiMark(13, "Trov turns what you type into this screen's filters. Nothing is searched for you: you see and can change each filter.")}
        <input id="${id}" data-act="aiFilterDraft" data-arg="${screen}" data-field="aiFilter:${screen}" data-enter="aiFilterRun" class="cnpy-search-in" style="font-size:12.5px" placeholder="${attr(AI_FILTER_PLACEHOLDER[screen])}" aria-label="Describe a filter in your own words" maxlength="${AI_FILTER_TEXT_MAX}" value="${attr(ui.drafts[screen])}" autocomplete="off" spellcheck="false"${err ? ` aria-invalid="true" aria-describedby="${id}-e"` : ""}>
      </label>
      <span class="cnpy-sfbar-div" aria-hidden="true"></span>
      <button data-act="aiFilterRun" data-arg="${screen}" class="cnpy-ghostbtn fm-btn" style="display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:500;border:none;height:100%;padding:0 12px;white-space:nowrap;color:var(--fg-70)"${busy ? ' disabled aria-busy="true"' : ""}>${busy ? "Reading&hellip;" : `Apply${SEND_ICON}`}</button>
    </div>`;
  // The screens are rebuilt per repaint, so both motions are clocked (a negative delay): a repaint inside one
  // joins it where the last left off, and none after it moves. Off under reduced motion (trov.css).
  const gone = ui.leaving?.[screen];
  const goneT = gone ? now - gone.at : null;
  const note = applied ? appliedLine(applied, now)
    : gone && goneT !== null && goneT >= 0 && goneT < AI_EXIT_MS ? aiLeave(appliedLine(gone.applied, null), goneT) : "";
  return `<div class="cnpy-aifilter-row" data-ai-filter="${screen}" style="margin:0 0 10px">
    ${anchoredField(field, err ? fieldError(`${id}-e`, err) : "")}
    ${note}
  </div>`;
}

function appliedLine(a: AiFilterApplied, now: number | null): string {
  const set = a.labels.length ? `Filtered: ${a.labels.map(esc).join(" · ")}.` : "";
  const not = a.unmatched.length ? ` Not a filter here: ${a.unmatched.map((u) => `“${esc(u)}”`).join(", ")}.` : "";
  const t = now !== null && a.at !== undefined ? now - a.at : null;
  const rise = t !== null && t >= 0 && t < AI_FILTER_RISE_MS ? ` class="cnpy-flash" style="animation-delay:-${Math.round(t)}ms;` : ` style="`;
  return `<div role="status"${rise}display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 10px;margin-top:7px;font-size:12px;line-height:1.5;color:var(--fg-55)">
    <span>${set}${not}</span>
    <button data-act="aiFilterUndo" class="cnpy-mutelink" style="font-size:12px;font-weight:500;padding:0">Undo</button>
  </div>`;
}

// ── the words of an applied filter ───────────────────────────────────────────

export interface AiFilterNames {
  me: string;
  /** A handle → the name to show. */
  person(handle: string): string;
  /** A sprint id → its label. */
  sprint(id: string): string;
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const searched = (t: string | undefined): string[] => (t ? [`search “${t}”`] : []);
const by = (h: string, n: AiFilterNames): string => (h.toLowerCase() === n.me.toLowerCase() ? "By you" : `By ${n.person(h)}`);

/** What a filter sets, in the screen's words, in its controls' order. */
export function aiFilterLabels<S extends AiFilterScreen>(screen: S, filter: AiFilterByScreen[S], n: AiFilterNames): string[] {
  if (screen === "tickets") {
    const f = filter as TicketsAiFilter;
    const status = f.status === "all" ? "Open and closed" : f.status ? cap(f.status) : null;
    const who = f.person ? `Assigned to ${f.person.toLowerCase() === n.me.toLowerCase() ? "you" : n.person(f.person)}`
      : f.assignee === "me" ? "Assigned to you" : f.assignee === "unassigned" ? "Unassigned" : null;
    return [
      ...(status ? [status] : []), ...(who ? [who] : []), ...(f.category ? [cap(f.category)] : []),
      ...(f.priority ? [`${cap(f.priority)} priority`] : []),
      ...(f.sprint ? [f.sprint === "backlog" ? "Backlog" : n.sprint(f.sprint)] : []), ...searched(f.text),
    ];
  }
  if (screen === "feed") {
    const f = filter as FeedAiFilter;
    return [
      ...(f.author ? [by(f.author, n)] : []), ...(f.tag ? [`Tagged ${f.tag}`] : []),
      ...(f.range === "24h" ? ["Last 24 hours"] : f.range === "7d" ? ["Last 7 days"] : f.range === "all" ? ["All time"] : []),
    ];
  }
  const f = filter as ArtifactsAiFilter;
  return [
    ...(f.area ? [`Area ${f.area}`] : []), ...(f.kind ? [artifactKindLabel(f.kind)] : []), ...(f.author ? [by(f.author, n)] : []),
    ...(f.status ? [cap(f.status)] : []), ...(f.sprint ? [n.sprint(f.sprint)] : []), ...searched(f.text),
  ];
}

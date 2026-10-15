// The plain-language filter (#162) — a typed filter INSIDE each screen's Filter menu on Tickets, the Feed and
// Artifacts (docs/architecture/ai.md › The plain-language filter; the acts are ai-filter-actions.ts's). The menu's
// first row, "Describe a filter", opens a field in place ("my open high-priority bugs"); its answer is applied to
// the screen's OWN filter controls, as if the person had set them by hand: each shows in the same menu and can be
// changed there, and Undo puts back what the screen had before. Never results, and nothing here calls a model: the
// server does, on Enter.
//
// Drawn only when the org's AI switch is on (`AiFilterUi.on`, from `GET /ai/settings` once per org) — off is no
// row at all, never a disabled one, and the menu is byte-for-byte what it was. Pure markup over the trov.css tokens.

import {
  AI_FILTER_PLACEHOLDER, AI_FILTER_TEXT_MAX,
  type AiFilterByScreen, type AiFilterScreen, type ArtifactsAiFilter, type FeedAiFilter, type TicketsAiFilter,
} from "@shared/ai-filter-core";
import { artifactKindLabel } from "@shared/artifacts-core";
import { aiLeave, aiLeavingT, type AiUi } from "./ai-ui";
import { aiMark } from "./marks";
import { esc, attr } from "./ui";

/** What the screens' filter state held before a filter was applied — Undo restores it. Opaque here. */
export type AiFilterSnapshot = Record<string, unknown>;

export interface AiFilterApplied {
  /** The filter as applied, in words ("Assigned to me", "High priority"). */
  labels: string[];
  /** The request's words this screen cannot filter by. */
  unmatched: string[];
  undo: AiFilterSnapshot;
  /** When it was applied (`Date.now()`): the line rises in once from then (`.cnpy-flash` at a negative delay). */
  at?: number;
}

/** How long the applied line's rise lasts (the app's one-shot `.cnpy-flash`, .3 s). */
export const AI_FILTER_RISE_MS = 300;

export interface AiFilterUi {
  /** The org the switch was read for, and whether the row is shown there (`enabled`, and a key). */
  org: string | null;
  on: boolean;
  drafts: Record<AiFilterScreen, string>;
  busy: AiFilterScreen | null;
  error: Partial<Record<AiFilterScreen, string>>;
  applied: Partial<Record<AiFilterScreen, AiFilterApplied>>;
  /** The applied line Undo took, drawn on its way out (the AI kit's one exit, `aiFilterLeaveKey`). */
  undone: Partial<Record<AiFilterScreen, AiFilterApplied>>;
  /** The screen whose Filter menu shows the field open ("Describe a filter" chosen). A menu opens with it shut. */
  reveal: AiFilterScreen | null;
}

export function initialAiFilterUi(): AiFilterUi {
  return { org: null, on: false, drafts: { tickets: "", feed: "", artifacts: "" }, busy: null, error: {}, applied: {}, undone: {}, reveal: null };
}

/** The app screen a typed filter serves, or null. */
export function aiFilterScreenOf(screen: string): AiFilterScreen | null {
  return screen === "tickets" || screen === "feed" || screen === "artifacts" ? screen : null;
}

/** `AiUi.leaving`'s key for a screen's applied line on its way out after Undo. */
export const aiFilterLeaveKey = (screen: AiFilterScreen): string => `filter:${screen}`;

const SEND_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 12h14"></path><path d="m13 6 6 6-6 6"></path></svg>`;
const CHEVRON = `<svg class="fm-ai-chev" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="m9 6 6 6-6 6"></path></svg>`;

/** The Filter menu's top section (filter-menu.ts `top`): the "Describe a filter" row and the field it opens —
 *  Enter or Apply runs it, a refusal shows under it. "" when the org's AI is off. The field's box is always drawn
 *  (collapsed and `inert` until chosen) so the controller opens it on the live popover without a repaint, and it
 *  grows open on the app's clock (trov.css `.fm-ai`). */
export function aiFilterMenuTop(screen: AiFilterScreen, ui: AiFilterUi): string {
  if (!ui.on) return "";
  const open = ui.reveal === screen;
  const busy = ui.busy === screen;
  const err = ui.error[screen] ?? null;
  const id = `ai-filter-${screen}`;
  return `<div class="fm-ai" data-ai-filter="${screen}" data-open="${open ? "1" : "0"}">
    <button data-act="aiFilterReveal" data-arg="${screen}" data-field="aiFilterOpt:${screen}" class="cnpy-menurow fm-ai-opt" aria-expanded="${open}" aria-controls="${id}-box">
      <span style="width:14px;flex:none;display:grid;place-items:center">${aiMark(13)}</span>
      <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Describe a filter</span>
      ${CHEVRON}
    </button>
    <div class="fm-ai-box" id="${id}-box"${open ? "" : " inert"}><div class="fm-ai-box-in">
      <div class="fm-ai-field">
        <input id="${id}" data-act="aiFilterDraft" data-arg="${screen}" data-field="aiFilter:${screen}" data-enter="aiFilterRun" class="cnpy-search-in" style="font-size:12.5px" placeholder="${attr(AI_FILTER_PLACEHOLDER[screen])}" aria-label="Describe a filter in your own words" maxlength="${AI_FILTER_TEXT_MAX}" value="${attr(ui.drafts[screen])}" autocomplete="off" spellcheck="false"${err ? ` aria-invalid="true" aria-describedby="${id}-e"` : ""}>
        <button data-act="aiFilterRun" data-arg="${screen}" class="cnpy-ghostbtn fm-ai-run"${busy ? ' disabled aria-busy="true"' : ""}>${busy ? "Reading&hellip;" : `Apply${SEND_ICON}`}</button>
      </div>
      ${err ? `<p id="${id}-e" role="alert" class="fm-ai-err">${esc(err)}</p>` : ""}
      <p class="fm-ai-note">Trov sets this menu's filters from what you type. Nothing is searched for you.</p>
    </div></div>
  </div>`;
}

/** The line above the screen's toolbar once a typed filter is applied: what was set, what was not a filter here,
 *  and Undo — and, after Undo, the same line on its way out (the AI kit's one exit). "" otherwise. */
export function aiFilterLine(screen: AiFilterScreen, ui: AiFilterUi, ai: Partial<Pick<AiUi, "leaving">>, now = Date.now()): string {
  if (!ui.on) return "";
  const applied = ui.applied[screen];
  if (applied) return appliedLine(screen, applied, now);
  const undone = ui.undone[screen];
  if (!undone) return "";
  const t = aiLeavingT(ai, aiFilterLeaveKey(screen), now);
  return t === null ? "" : aiLeave(appliedLine(screen, undone, null), t);
}

/** The line; `now` given, it rises in once from when it was applied — clocked by a negative delay, so a repaint
 *  inside the rise joins it and none after it moves (off under reduced motion: `.cnpy-flash`'s own rule). */
function appliedLine(screen: AiFilterScreen, a: AiFilterApplied, now: number | null): string {
  const set = a.labels.length ? `Filtered: ${a.labels.map(esc).join(" · ")}.` : "";
  const not = a.unmatched.length ? ` Not a filter here: ${a.unmatched.map((u) => `“${esc(u)}”`).join(", ")}.` : "";
  const t = now !== null && a.at !== undefined ? now - a.at : null;
  const rise = t !== null && t >= 0 && t < AI_FILTER_RISE_MS;
  return `<div class="cnpy-aifilter-line${rise ? " cnpy-flash" : ""}" data-ai-filter-line="${screen}" role="status" style="${rise ? `animation-delay:-${Math.round(t!)}ms;` : ""}display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px;padding:0 0 10px;font-size:12px;line-height:1.5;color:var(--fg-55)">
    ${aiMark(12, "Set from what you typed in the Filter menu. Each filter shows there and can be changed by hand.")}
    <span>${set}${not}</span>
    <button data-act="aiFilterUndo" data-arg="${screen}" class="cnpy-mutelink" style="font-size:12px;font-weight:500;padding:0">Undo</button>
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

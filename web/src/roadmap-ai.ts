// The Roadmap's AI pieces (roadmap-my-work.md › Roadmap intelligence; web-ui.md › The AI kit): each sprint card's
// forecast and note, the drift line above the sprints, and an admin's suggestion cards at the top. Pure markup over
// the AI kit (./ai-ui.ts) and the trov.css tokens; the acts are ai-actions.ts's (`aiWrong`, `aiAccept`,
// `aiDismiss`, `aiReason`).
//
//   • The FORECAST is arithmetic the server did (`SprintView.forecast`), never a model: no AI mark, a tooltip that
//     says how it is counted. Absent or null → nothing.
//   • A NOTE and the DRIFT are what Trov wrote: the AI mark, "Written by Trov", their sources, "Wrong?".
//   • A SUGGESTION is the kit's chip ("Suggested: 3 sprints from 10 backlog tickets, because…" — Accept, Dismiss)
//     over what it proposes. Accepting runs the existing writers as the admin who pressed it.
//
// OFF IS NOT A STATE: with a field absent each piece renders nothing, and the Roadmap is exactly what it was
// (test/render.ai-absent.test.ts).
//
// MOTION (web-ui.md › Sidebar & motion, › A row leaving a list — the app's own, nothing new): the drift line and the
// suggestion cards rise with the screen's entrance (`.cnpy-rise`, `.cnpy-stagger`), the forecast and the note with
// their sprint card's; none of it replays on a rerender (`[data-enter]` belongs to the route). Leaving is Review's
// exit: the Roadmap's Narrative tab is `data-morph`ed, the cards are a keyed list (`data-morph-list`), and a card an
// Accept / Dismiss took — or a note / the drift "Wrong?" took — is a `.cnpy-rv-row` that collapses (`data-verdict`,
// `inert`) for `AI_EXIT_MS`, then goes (ai-actions.ts holds the state). Under reduced motion it goes at once.

import type { SprintForecast, SprintView } from "@shared/sprints";
import { aiItemRef, type AiPlanDrift, type AiSprintDraftValue, type AiPlanNarrativeValue, type AiSprintNote, type AiSuggestion } from "@shared/ai-core";
import { AI_NOT_OFFICIAL, aiMark } from "./marks";
import { aiByline, aiCites, aiFeedback, aiHiddenKey, aiIsLeaving, aiLeaveKey, aiSuggestionChip, aiWrongBtn, type AiUi } from "./ai-ui";
import { esc, attr } from "./ui";
import { renderMarkdown } from "./markdown";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (iso: string): string => {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}` : iso;
};
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Review's leaving row (`.cnpy-rv-row`, a one-track grid that collapses to nothing) around one piece; `pad` is the
 *  space above or below it, INSIDE the row so it collapses with it. */
const exitRow = (cls: string, leaving: boolean, pad: string, body: string, key?: string): string =>
  `<div class="cnpy-rv-row ${cls}"${key ? ` data-morph-key="${attr(key)}"` : ""}${leaving ? ' data-verdict="out" inert' : ""}><div class="cnpy-rv-row-in"><div style="${pad}">${body}</div></div></div>`;

type LeaveUi = Pick<AiUi, "hidden"> & Partial<Pick<AiUi, "leaving">>;
/** "" = not drawn (hidden, and its exit is over); otherwise whether it is still drawn, leaving. */
const shown = (ui: LeaveUi | null, key: string): "no" | "yes" | "leaving" =>
  !ui?.hidden.includes(key) ? "yes" : aiIsLeaving(ui, key) ? "leaving" : "no";

export const ROADMAP_TIP = {
  forecast: "Arithmetic, not a prediction: the tickets closed so far per day since the sprint started, carried over the ones still open.",
  note: `Written by Trov from this sprint's tickets, the pull requests they link and the feed. ${AI_NOT_OFFICIAL}`,
  drift: `Written by Trov from the themes of the merged pull requests (counted by Trov) and the active sprints. ${AI_NOT_OFFICIAL}`,
} as const;

/** "At this pace, done Nov 2, 3 days late" — words for the server's forecast. */
export function forecastWords(f: SprintForecast): { lead: string; delta: string | null; late: boolean } {
  const lead = `At this pace, done ${day(f.projected)}`;
  if (f.daysLate === null) return { lead, delta: null, late: false };
  if (f.daysLate > 0) return { lead, delta: plural(f.daysLate, "day late", "days late"), late: true };
  if (f.daysLate < 0) return { lead, delta: plural(-f.daysLate, "day early", "days early"), late: false };
  return { lead, delta: "on the due day", late: false };
}

/** The forecast line on an active sprint's card, or "" (no forecast: not active, no start, nothing closed yet). */
export function forecastLine(f: SprintForecast | null | undefined): string {
  if (!f) return "";
  const w = forecastWords(f);
  const delta = w.delta ? `, <span style="color:${w.late ? "var(--amber)" : "var(--fg-55)"}">${esc(w.delta)}</span>` : "";
  return `<div class="rm-forecast" data-mtip="${attr(ROADMAP_TIP.forecast)}" style="margin-top:6px;font-size:12px;color:var(--fg-55)">${esc(w.lead)}${delta}</div>`;
}

/** The note on an active sprint's card: Trov's line, its sources, the byline and "Wrong?". "" without one, or when
 *  this person pressed "Wrong?" on it. */
export function sprintNoteBlock(sp: Pick<SprintView, "id">, note: AiSprintNote | undefined, ui: LeaveUi | null): string {
  if (!note) return "";
  const ref = aiItemRef.sprintNote(sp.id, note.generatedAt);
  const show = shown(ui, aiHiddenKey("sprint_note", ref));
  if (show === "no") return "";
  return exitRow("rm-note-row", show === "leaving", "padding-top:10px", `<div class="rm-note" data-screen-label="Sprint note" style="display:flex;flex-direction:column;gap:6px">
      <p style="margin:0;font-size:13px;line-height:1.55;color:var(--fg-70)">${esc(note.text)}</p>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;min-width:0">
        ${aiByline(note.generatedAt, ROADMAP_TIP.note, { size: 12 })}
        ${note.cites.length ? `<span style="display:inline-flex;flex-wrap:wrap;gap:6px;min-width:0">${aiCites(note.cites)}</span>` : ""}
        <span style="flex:1"></span>
        ${aiWrongBtn(aiFeedback("sprint_note", ref, "sprint_note", note.model), 12.5)}
      </div>
    </div>`);
}

/** The drift line above the sprints: Trov's sentence, the server's shares, sources, byline and "Wrong?". "" without
 *  a drift, or when this person pressed "Wrong?" on it. */
export function driftLine(drift: AiPlanDrift | undefined, ui: LeaveUi): string {
  if (!drift) return "";
  const ref = aiItemRef.planDrift(drift.generatedAt);
  const show = shown(ui, aiHiddenKey("plan_drift", ref));
  if (show === "no") return "";
  const shares = drift.shares.length
    ? `<div style="font-size:12px;color:var(--fg-55);line-height:1.5">${drift.shares.map((s) =>
      `<span style="white-space:nowrap">${esc(s.theme)} ${s.pct}%${s.inSprint ? "" : ` <span style="color:var(--fg-40)">(in no sprint)</span>`}</span>`).join(`<span aria-hidden="true" style="color:var(--fg-40)"> · </span>`)}</div>`
    : "";
  return exitRow("rm-drift-row cnpy-rise", show === "leaving", "padding-top:14px", `<section class="rm-drift" data-screen-label="Roadmap · Drift" style="padding:12px 14px;border:1px dashed var(--border-strong);border-radius:10px;display:flex;flex-direction:column;gap:7px;min-width:0">
    <div style="display:flex;align-items:flex-start;gap:8px;min-width:0">${aiMark(13, ROADMAP_TIP.drift)}<p style="margin:0;font-size:13.5px;line-height:1.5;color:var(--fg)">${esc(drift.text)}</p></div>
    ${shares}
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;min-width:0">
      ${aiByline(drift.generatedAt, ROADMAP_TIP.drift, { size: 12, from: `the last ${drift.windowDays} days` })}
      ${drift.cites.length ? `<span style="display:inline-flex;flex-wrap:wrap;gap:6px">${aiCites(drift.cites)}</span>` : ""}
      <span style="flex:1"></span>
      ${aiWrongBtn(aiFeedback("plan_drift", ref, "plan_drift", drift.model), 12.5)}
    </div>
  </section>`);
}

const TICKET_LINK = "color:var(--accent);text-decoration:none;font-family:var(--label);font-size:12px";

/** What a sprint draft proposes: each sprint's name, goal and tickets. */
function draftBody(v: AiSprintDraftValue): string {
  return `<ol style="margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px">${v.sprints.map((s) =>
    `<li style="min-width:0"><div style="font-size:13px;font-weight:600;color:var(--fg)">${esc(s.name)}</div>
      ${s.goal ? `<div style="font-size:12.5px;color:var(--fg-70);line-height:1.5">${esc(s.goal)}</div>` : ""}
      <div style="display:flex;flex-wrap:wrap;gap:4px 8px;margin-top:3px">${s.tickets.map((n) => `<a href="#tickets/${n}" style="${TICKET_LINK}">#${n}</a>`).join("")}</div></li>`).join("")}</ol>`;
}

/** What a narrative proposal would write. Rendered through the app's sanitizing markdown, like the narrative. */
function narrativeBody(v: AiPlanNarrativeValue): string {
  return `<div class="cnpy-md" style="font-size:13px;color:var(--fg-70);border-left:2px solid var(--border-strong);padding-left:10px">${renderMarkdown(v.narrative)}</div>`;
}

const isDraft = (v: unknown): v is AiSprintDraftValue =>
  !!v && typeof v === "object" && Array.isArray((v as AiSprintDraftValue).sprints)
  && (v as AiSprintDraftValue).sprints.every((s) => s && typeof s.name === "string" && Array.isArray(s.tickets));
const isNarrative = (v: unknown): v is AiPlanNarrativeValue => !!v && typeof v === "object" && typeof (v as AiPlanNarrativeValue).narrative === "string";

/** An admin's suggestion cards, at the top of the Roadmap: one per open suggestion, the kit's chip over what it
 *  proposes. "" with none (everyone but an admin gets none from the server). A keyed list: a card an Accept /
 *  Dismiss took collapses out of it while the others stay the elements they were. */
export function roadmapSuggestionCards(list: AiSuggestion[] | undefined, ui: Pick<AiUi, "busy" | "unavailable" | "reasonOpen"> & Partial<Pick<AiUi, "leaving" | "decided">>): string {
  const cards = (list ?? []).filter((s) => s.state === "open" && s.reason && (!ui.decided?.includes(s.id) || aiIsLeaving(ui, aiLeaveKey.suggestion(s.id)))).map((s) => {
    const body = s.kind === "sprint_draft" && isDraft(s.value) ? draftBody(s.value)
      : s.kind === "plan_narrative" && isNarrative(s.value) ? narrativeBody(s.value) : "";
    if (!body) return "";
    const key = `roadmap-${s.id}`;
    const chip = aiSuggestionChip({ key, id: s.id, label: s.label, reason: s.reason, cites: s.cites }, {
      open: ui.reasonOpen === key, busy: ui.busy.includes(s.id), unavailable: ui.unavailable.includes(s.id), canAct: true,
    });
    const card = `<div class="rm-suggestion" data-suggestion="${s.id}" style="display:flex;flex-direction:column;gap:10px;min-width:0">${chip}<div style="padding:0 4px 0 10px">${body}</div></div>`;
    return exitRow("rm-suggestion-row", aiIsLeaving(ui, aiLeaveKey.suggestion(s.id)), "padding-bottom:16px", card, `s:${s.id}`);
  }).filter(Boolean);
  if (!cards.length) return "";
  // Children joined with nothing between them: the list is keyed (morph.ts `morphList`).
  return `<section class="rm-suggestions cnpy-stagger" data-screen-label="Roadmap · Suggestions" data-morph-list style="display:flex;flex-direction:column;margin-bottom:2px">${cards.join("")}</section>`;
}

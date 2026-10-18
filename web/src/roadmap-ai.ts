// The Roadmap's AI pieces (roadmap-my-work.md › Roadmap intelligence; web-ui.md › The AI kit): each sprint card's
// forecast and note, the drift line above the sprints, and an admin's suggestion cards at the top. Pure markup over
// the AI kit (./ai-ui.ts) and the trov.css tokens; the acts are ai-actions.ts's (`aiWrong`, `aiAccept`,
// `aiDismiss`, `aiReason`).
//
//   • The FORECAST is arithmetic the server did (`SprintView.forecast`), never a model: no AI mark, a tooltip that
//     says how it is counted. Absent or null → nothing.
//   • A NOTE and the DRIFT are what Trov wrote: the AI mark, "Written by Trov", their sources, "Wrong?".
//   • A SUGGESTION is the kit's chip ("Trov suggests 3 sprints from 10 backlog tickets", Why?, Accept, Dismiss)
//     with what it proposes inside it. Accepting runs the existing writers as the admin who pressed it.
//   • WHERE (the owner's call, 2026-10-18): the suggestions and the drift are NOT in the page's flow — they pushed
//     the narrative and the sprints around. The narrative card's head carries a Trov button (`roadmapTrovButton`:
//     the mark, "Suggestions", their count, a dot while a suggestion waits for a decision) that opens them in a
//     dialog (`roadmapTrovDialog`). A sprint card's note stays on its card.
//
// OFF IS NOT A STATE: with a field absent each piece renders nothing, and the Roadmap is exactly what it was
// (test/render.ai-absent.test.ts).
//
// MOTION (web-ui.md › The AI kit): the drift line and the suggestion cards rise with the screen's entrance
// (`.cnpy-rise`, `.cnpy-stagger`), the forecast and the note with their sprint card's; none of it replays on a
// rerender (`[data-enter]` belongs to the route). Leaving is the AI kit's ONE exit (ai-ui.ts › Leaving, `aiLeaving`):
// a note or the drift "Wrong?" took, and a card an Accept / Dismiss took (held collapsed until the Roadmap's re-read,
// which waits `AI_EXIT_MS`). The cards stay a keyed list (`data-morph-list`, each row's key on a stable wrapper).
// Under reduced motion it goes at once.

import type { SprintForecast, SprintView } from "@shared/sprints";
import { aiItemRef, type AiPlanDrift, type AiSprintDraftValue, type AiPlanNarrativeValue, type AiSprintNote, type AiSuggestion } from "@shared/ai-core";
import { AI_NOT_OFFICIAL, aiMark, markShape } from "./marks";
import { aiByline, aiCapped, aiCites, aiDay, aiFeedback, aiHiddenKey, aiLeaving, aiLeavingT, aiSuggestionChip, aiSuggestionKey, aiWrongBtn, type AiUi } from "./ai-ui";
import { esc, attr } from "./ui";
import { renderMarkdown } from "./markdown";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (iso: string): string => {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}` : iso;
};
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
/** At the month's cap the line is Trov's LAST version and says so (the server's `state: "capped"`, Q19). */
const cappedLine = (l: AiSprintNote, what: string): string =>
  l.state === "capped" ? aiCapped({ upgrade: !!l.upgrade }, `${what} resume${l.resumesOn ? ` ${aiDay(l.resumesOn)}` : " next month"}`) : "";

/** One piece in its row: a stable wrapper (`cls`, and its morph key in a keyed list) around the piece, drawn through
 *  the AI kit's exit while `leaveKey` leaves. `pad` is the space above or below it, INSIDE the exit's clip so it
 *  collapses with it. */
const exitRow = (ui: LeaveUi | null, leaveKey: string, cls: string, pad: string, body: string, o: { hold?: boolean; key?: string } = {}): string =>
  `<div class="${cls}"${o.key ? ` data-morph-key="${attr(o.key)}"` : ""}>${aiLeaving(ui ?? {}, leaveKey, `<div style="${pad}">${body}</div>`, { hold: o.hold })}</div>`;

type LeaveUi = Pick<AiUi, "hidden"> & Partial<Pick<AiUi, "leaving">>;
/** Not drawn: this person hid it ("Wrong?") and its exit is over. */
const gone = (ui: LeaveUi | null, key: string): boolean => !!ui?.hidden.includes(key) && aiLeavingT(ui, key) === null;

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
  const key = aiHiddenKey("sprint_note", ref);
  if (gone(ui, key)) return "";
  return exitRow(ui, key, "rm-note-row", "padding-top:10px", `<div class="rm-note" data-screen-label="Sprint note" style="display:flex;flex-direction:column;gap:6px">
      <p style="margin:0;font-size:13px;line-height:1.55;color:var(--fg-70)">${esc(note.text)}</p>
      ${cappedLine(note, "notes")}
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
  const key = aiHiddenKey("plan_drift", ref);
  if (gone(ui, key)) return "";
  const shares = drift.shares.length
    ? `<div style="font-size:12px;color:var(--fg-55);line-height:1.5">${drift.shares.map((s) =>
      `<span style="white-space:nowrap">${esc(s.theme)} ${s.pct}%${s.inSprint ? "" : ` <span style="color:var(--fg-40)">(in no sprint)</span>`}</span>`).join(`<span aria-hidden="true" style="color:var(--fg-40)"> · </span>`)}</div>`
    : "";
  return exitRow(ui, key, "rm-drift-row", "padding-top:14px", `<section class="rm-drift" data-screen-label="Roadmap · Drift">
    <div style="display:flex;align-items:flex-start;gap:8px;min-width:0">${aiMark(13, ROADMAP_TIP.drift)}<p style="margin:0;font-size:13.5px;line-height:1.5;color:var(--fg)">${esc(drift.text)}</p></div>
    ${shares}
    ${cappedLine(drift, "notes")}
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

/** An admin's suggestion cards, at the top of the Roadmap: one per open suggestion, the kit's box with what it
 *  proposes inside it and an Accept that says what it does ("Create 2 sprints", "Use this narrative"). "" with none (everyone but an admin gets none from the server). A keyed list: a card an Accept /
 *  Dismiss took collapses out of it while the others stay the elements they were. */
export function roadmapSuggestionCards(list: AiSuggestion[] | undefined, ui: Pick<AiUi, "busy" | "unavailable" | "reasonOpen"> & Partial<Pick<AiUi, "leaving">>): string {
  const cards = (list ?? []).filter((s) => s.state === "open" && s.reason).map((s) => {
    const body = s.kind === "sprint_draft" && isDraft(s.value) ? draftBody(s.value)
      : s.kind === "plan_narrative" && isNarrative(s.value) ? narrativeBody(s.value) : "";
    if (!body) return "";
    const key = `roadmap-${s.id}`;
    // Accept says what it does; what it would write sits inside the box, never loose below it.
    const acceptLabel = s.kind === "sprint_draft" && isDraft(s.value)
      ? `Create ${s.value.sprints.length === 1 ? "this sprint" : `${s.value.sprints.length} sprints`}` : "Use this narrative";
    const chip = aiSuggestionChip({ key, id: s.id, label: s.label, reason: s.reason, cites: s.cites }, {
      open: ui.reasonOpen === key, busy: ui.busy.includes(s.id), unavailable: ui.unavailable.includes(s.id), canAct: true, acceptLabel, body,
    });
    const card = `<div class="rm-suggestion" data-suggestion="${s.id}" style="min-width:0">${chip}</div>`;
    return exitRow({ hidden: [], leaving: ui.leaving }, aiSuggestionKey(s.id), "rm-suggestion-row", "padding-bottom:16px", card, { hold: true, key: `s:${s.id}` });
  }).filter(Boolean);
  if (!cards.length) return "";
  // Children joined with nothing between them: the list is keyed (morph.ts `morphList`).
  return `<section class="rm-suggestions cnpy-stagger" data-screen-label="Roadmap · Suggestions" data-morph-list style="display:flex;flex-direction:column;margin-bottom:2px">${cards.join("")}</section>`;
}

// ── the Trov button and its dialog ───────────────────────────────────────────

/** What the Trov button counts: the open suggestions shown, and the drift when there is one (not ones this person
 *  sent away). `waiting` is whether a suggestion waits for a decision — the button's dot. */
export function roadmapTrovCount(list: AiSuggestion[] | undefined, drift: AiPlanDrift | undefined, ui: LeaveUi): { n: number; waiting: boolean } {
  const open = (list ?? []).filter((s) => s.state === "open" && s.reason && !gone(ui, aiSuggestionKey(s.id))).length;
  const d = drift && !gone(ui, aiHiddenKey("plan_drift", aiItemRef.planDrift(drift.generatedAt))) ? 1 : 0;
  return { n: open + d, waiting: open > 0 };
}

/** The narrative card's Trov button: "" with nothing to show. */
export function roadmapTrovButton(c: { n: number; waiting: boolean }): string {
  if (!c.n) return "";
  return `<button type="button" data-act="rmTrov" data-confirm-trigger aria-haspopup="dialog" class="rm-trov-btn" aria-label="${attr(`Trov's suggestions for the roadmap: ${c.n}`)}">${aiMark(12)}<span>Suggestions</span><span class="rm-trov-n">${c.n}</span>${c.waiting ? `<span class="rm-trov-dot" aria-hidden="true">${markShape("dot", "var(--accent)", 7)}</span>` : ""}</button>`;
}

/** The dialog the button opens: the suggestions (each the kit's box, Accept / Dismiss working in place) and the
 *  drift, then Done. Escape, ×, the backdrop and a route change close it. */
export function roadmapTrovDialog(list: AiSuggestion[] | undefined, drift: AiPlanDrift | undefined, ui: AiUi): string {
  const cards = roadmapSuggestionCards(list, ui);
  const d = driftLine(drift, ui);
  const close = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg>`;
  return `<div data-overlay="rm-trov" data-confirm-layer data-confirm-tone="neutral" class="cnpy-cmodal">
    <div data-act="rmTrov" class="cnpy-cmodal-back" aria-hidden="true"></div>
    <div class="cnpy-cmodal-wrap">
      <div id="rm-trov" role="dialog" aria-modal="true" aria-labelledby="rm-trov-t" tabindex="-1" data-confirm-dialog data-confirm-act="rmTrov" data-confirm-cancel="rmTrov" class="cnpy-surface cnpy-cmodal-box cnpy-cmodal-box--wide rm-trov-dlg">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
          <div style="min-width:0">
            <div id="rm-trov-t" style="display:flex;align-items:center;gap:8px;font-size:16px;font-weight:600;letter-spacing:-0.01em;color:var(--fg);line-height:1.35">${aiMark(14)}Suggestions from Trov</div>
            <div style="font-size:12.5px;line-height:1.5;color:var(--fg-55);margin-top:4px">Nothing changes until you accept one.</div>
          </div>
          <button type="button" data-act="rmTrov" class="cnpy-iconbtn" aria-label="Close" style="width:28px;height:28px;border-radius:7px;display:grid;place-items:center;color:var(--fg-55);flex:none">${close}</button>
        </div>
        <div class="rm-trov-body">${cards}${d}${cards || d ? "" : `<p style="margin:0;font-size:13px;color:var(--fg-55)">Nothing waiting.</p>`}</div>
        <div style="display:flex;justify-content:flex-end;margin-top:16px"><button type="button" data-act="rmTrov" data-confirm-focus class="cnpy-outlinebtn" style="padding:8px 14px;border-radius:8px;border:1px solid var(--border-strong);font-size:13px;font-weight:500;color:var(--fg-70)">Done</button></div>
      </div>
    </div>
  </div>`;
}

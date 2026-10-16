// Trov's Phase C suggestions on three screens (web-ui.md › The AI kit; docs/architecture/ai.md › The kinds), built
// from the AI kit (ai-ui.ts `aiSuggestionChip`, the Trov mark) — and NOTHING when the read carries no `ai`, so each
// screen paints exactly what it did before (test/render.ai-cards.test.ts):
//
//   • the ticket detail — a chip under Properties for a suggested category and priority, and one above Linked work
//     for a possible duplicate; Accept writes the field / adds the link as the person, Dismiss is remembered;
//   • Unplaced — a chip above "File it as" with the suggested destination; Accept files it exactly as "File it";
//   • Review — a quiet line: the mark and the risk in words on the list card (it is a button: no button inside it),
//     and in the detail pane the same with its reason and Dismiss. A risk never promotes, rejects or ratifies.
//
// Acts are ai-actions.ts's (`aiAccept`, `aiDismiss`, `aiReason`). Pure markup over the trov.css tokens.
//
// MOTION (web-ui.md › The AI kit): each chip / risk line ENTERS with its screen (`.cnpy-rise` + `--i` under
// `[data-enter]`, joined mid-way on a rerender through `--enter-t`), and LEAVES by the kit's one exit once Accept /
// Dismiss answered — `aiLeaving` with `aiSuggestionKey(id)` and `hold` (ai-ui.ts › Leaving): the controller starts
// it, and main.ts's `decided` holds the screen's re-read for `AI_EXIT_MS` so the read never pulls it out mid-exit.
import type { AiSuggestion } from "@shared/ai-core";
import { AI_TIP, aiCites, aiLeaving, aiSuggestionChip, aiSuggestionKey, type AiUi } from "./ai-ui";
import { aiMark } from "./marks";
import { esc, attr } from "./ui";

/** The bit of `state.ai` a chip needs, with which items are leaving (ai-ui.ts › Leaving). */
export type AiChipUi = Pick<AiUi, "busy" | "unavailable" | "reasonOpen"> & Partial<Pick<AiUi, "leaving">>;

/** A chip / risk line as it enters (with its screen, `.cnpy-rise`) and leaves (the kit's exit). `pad` is the space
 *  above / below it, kept INSIDE the leaving clip so the box collapses to nothing. */
function leaveBox(id: number, ui: AiChipUi, i: number, pad: string, inner: string, cls = ""): string {
  return aiLeaving(ui, aiSuggestionKey(id), `<div class="cnpy-rise${cls ? ` ${cls}` : ""}" style="--i:${i};${pad}">${inner}</div>`, { hold: true });
}

const chip = (s: AiSuggestion, label: string, ui: AiChipUi): string =>
  aiSuggestionChip(
    { key: `${s.kind}-${s.id}`, id: s.id, label, reason: s.reason, cites: s.cites },
    { open: ui.reasonOpen === `${s.kind}-${s.id}`, busy: ui.busy.includes(s.id), unavailable: ui.unavailable.includes(s.id), canAct: true },
  );

const ofKind = (ai: AiSuggestion[] | undefined, kind: string): AiSuggestion | null => ai?.find((s) => s.kind === kind && s.state === "open") ?? null;

/** The rail's chips: a suggested category and priority (""; nothing when there is neither). */
export function ticketFieldChips(ai: AiSuggestion[] | undefined, ui: AiChipUi): string {
  const cat = ofKind(ai, "ticket.category");
  const pri = ofKind(ai, "ticket.priority");
  if (!cat && !pri) return "";
  return `<div class="cnpy-ai-td-fields" style="display:flex;flex-direction:column;padding-top:2px">
    ${cat ? leaveBox(cat.id, ui, 2, "padding-top:8px", chip(cat, `${cat.label} category`, ui)) : ""}${pri ? leaveBox(pri.id, ui, 3, "padding-top:8px", chip(pri, `${pri.label} priority`, ui)) : ""}
  </div>`;
}

/** The left column's chip: a possible duplicate ("" when there is none). Accepting LINKS the two; nothing closes. */
export function ticketDuplicateChip(ai: AiSuggestion[] | undefined, ui: AiChipUi): string {
  const dup = ofKind(ai, "ticket.duplicate");
  return dup ? leaveBox(dup.id, ui, 1, "padding-bottom:18px", chip(dup, `possible duplicate of ${dup.label}`, ui), "cnpy-ai-td-dup") : "";
}

/** Unplaced's chip: where the item could be filed ("" when there is no suggestion). */
export function unplacedChip(ai: AiSuggestion[] | undefined, ui: AiChipUi): string {
  const d = ofKind(ai, "unplaced.destination");
  return d ? leaveBox(d.id, ui, 1, "padding-top:18px", chip(d, `file it as a doc in ${d.label}`, ui), "cnpy-ai-unplaced") : "";
}

/** An Unplaced LIST row that has a suggested destination: the mark and "Suggested", nothing to press (the row is a
 *  button). "" when there is none. */
export function unplacedRowMark(ai: AiSuggestion[] | undefined, leaving?: AiUi["leaving"]): string {
  const d = ofKind(ai, "unplaced.destination");
  return d
    ? aiLeaving({ leaving }, aiSuggestionKey(d.id), `<span class="cnpy-ai-row-mark" data-mtip="${attr(`${AI_TIP.suggestion} Suggested: ${d.label}.`)}" style="display:inline-flex;align-items:center;gap:4px;flex:0 1 auto;min-width:0;margin-left:2px;color:var(--fg-55)">&middot; ${aiMark(11)}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0">${esc(d.label)}</span></span>`, { hold: true, inline: true })
    : "";
}

// The risk is NOT drawn on a Review LIST card (the owner, RV-OWNER-2): only in the item's detail (`reviewRiskLine`).

/** The risk in the Review DETAIL pane: a quiet line — the mark, the risk, its reason one tap away, and Dismiss. */
export function reviewRiskLine(ai: AiSuggestion[] | undefined, ui: AiChipUi): string {
  const r = ofKind(ai, "review.risk");
  if (!r) return "";
  const key = `${r.kind}-${r.id}`;
  const open = ui.reasonOpen === key;
  const rid = `ai-why-${key.replace(/[^A-Za-z0-9_-]/g, "-")}`;
  const busy = ui.busy.includes(r.id);
  return leaveBox(r.id, ui, 1, "padding-top:14px", `<div class="cnpy-ai-risk-line" style="display:flex;flex-direction:column;gap:6px;font-size:12.5px;color:var(--fg-55)">
    <div style="display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px">
      <span data-mtip="${attr(AI_TIP.suggestion)}" style="display:inline-flex;align-items:center;gap:6px">${aiMark(12)}<span>Trov: <span style="color:var(--fg-70);font-weight:500">${esc(r.label)}</span>,</span></span>
      <button type="button" data-act="aiReason" data-arg="${attr(key)}" aria-expanded="${open}" aria-controls="${attr(rid)}" class="cnpy-mutelink" style="padding:0;font:inherit;color:var(--fg-55);text-decoration:underline dotted;text-underline-offset:3px">because&hellip;</button>
      ${ui.unavailable.includes(r.id) ? "" : `<button type="button" data-act="aiDismiss" data-arg="${r.id}"${busy ? " disabled" : ""} class="cnpy-mutelink" style="font-size:12px;font-weight:500;color:var(--fg-55);padding:2px 6px;min-height:26px">Dismiss</button>`}
    </div>
    <div id="${attr(rid)}" class="cnpy-ai-why"${open ? "" : " hidden"} style="color:var(--fg-70);line-height:1.5;overflow-wrap:anywhere">because ${esc(r.reason)}${r.cites.length ? ` <span style="display:inline-flex;flex-wrap:wrap;gap:6px;margin-left:4px">${aiCites(r.cites)}</span>` : ""}</div>
  </div>`);
}

// Ask Trov — write cards, Save as artifact and "Wrong?" (SEAM: a sibling agent replaces this stub; inventory
// §3, §4, §2f › Wrong?; scenarios `actions-ask`, `actions-auto`, `artifact`, `artifact-saved`).
//
// TODO(actions): build to the design — the ticket / handoff / doc_edit / publish cards (eyebrow, the "Draft, not
// created yet" / "Waiting for you" mark, the body per kind, inline Edit of `editable` fields only — confirm `{
// args }` re-validates server-side —, Cancel / Confirm; Publish shows "Open in Review" when `canPublish` is false),
// the done / cancelled / undone lines (linked result, time, Undo; one card and one Undo per `groupId`; Undo's
// 409 `changed` → "Changed since. Undo it by hand." with a link), the Save as artifact form (Title, Kind and Who
// can see it as `segmented()`, Save) and its saved line (Open → the inspector), and the Wrong? row (three
// reasons → `ctx.api.markWrong`, toast "Thanks. The team can see this in Review.").
//
// THE INTERFACE (keep it; the conversation calls these):
//   ActionsUi / initialActionsUi()                  your state, at `AppState.ask.actions`
//   actionGroupView(v, answer, ids)                 one card / line for consecutive actions of one group
//   saveFormView(v, answer, block, index)           a `save_form` block (form, or the saved line)
//   feedbackView(v, answer)                         under the footer: the Wrong? reasons row when open
//   actionsPart                                     your acts (`askAc…`)
// Apply a decision with `applyResults` below (it folds `AskActionAnswer.results` into the right answer).
// CSS: your block in trov.css is `/* ── Ask: actions ── */`.

import { esc, attr } from "./ui";
import type { AskCtx, AskPart, AskView, AskWhere } from "./ask-state";
import { applyActionResult, withTurnOfAction, type AskAnswer } from "./ask-stream";
import type { AskActionAnswer, AskBlock } from "@shared/ai-ask-core";

export interface ActionsUi {
  /** Cards with a decision in flight (no double Confirm). */
  busy: Record<number, boolean>;
  /** Answers whose Wrong? row is open (by answer key). */
  wrongOpen: Record<string, boolean>;
}
export const initialActionsUi = (): ActionsUi => ({ busy: {}, wrongOpen: {} });

/** Fold a Confirm / Cancel / Undo answer into whichever conversation holds those cards. */
export function applyResults(ctx: AskCtx, ans: AskActionAnswer): void {
  for (const where of ["page", "panel"] as AskWhere[]) {
    let c = ctx.ui[where];
    for (const r of ans.results) c = withTurnOfAction(c, r.id, (t) => applyActionResult(t, r));
    ctx.ui[where] = c;
  }
  ctx.paint();
}

/** STUB: each card as its preview title with Confirm / Cancel, or its decision as a line with Undo. */
export function actionGroupView(v: AskView, a: AskAnswer, ids: number[]): string {
  return ids.map((id) => {
    const x = a.turn.actions[id];
    if (!x) return "";
    const busy = v.ui.actions.busy[id] === true;
    if (x.state === "proposed" || x.state === "waiting") {
      return `<div class="ask-card" data-morph-key="act:${id}">
        <div class="ask-card-t">${esc(x.preview?.title ?? x.tool ?? "Change")}</div>
        ${x.note ? `<div class="ask-card-note">${esc(x.note)}</div>` : ""}
        <div class="ask-card-bar"><span style="flex:1"></span>
          <button type="button" class="ask-btn" data-act="askAcCancel" data-arg="${id}"${busy ? " disabled" : ""}>Cancel</button>
          <button type="button" class="ask-btn ask-btn--accent" data-act="askAcConfirm" data-arg="${id}"${busy ? " disabled" : ""}>Confirm</button>
        </div>
      </div>`;
    }
    const word = x.state === "cancelled" ? "Cancelled" : x.state === "undone" ? "Undone" : x.state === "failed" ? "Failed" : x.state === "expired" ? "Expired" : "Done";
    return `<div class="ask-line" data-morph-key="act:${id}"><span>${esc(word)}: ${esc(x.preview?.title ?? x.ref ?? x.tool ?? "change")}</span><span style="flex:1"></span>${x.undo && (x.state === "confirmed" || x.state === "auto")
      ? `<button type="button" class="ask-btn" data-act="askAcUndo" data-arg="${id}"${busy ? " disabled" : ""}>Undo</button>` : ""}</div>`;
  }).join("");
}

/** STUB: the form's title and a Save button, or the saved line. */
export function saveFormView(_v: AskView, a: AskAnswer, block: Extract<AskBlock, { kind: "save_form" }>, index: number): string {
  const f = block.form;
  if (f.saved) return `<div class="ask-line"><span>Saved as artifact: ${esc(f.saved.title)}</span><span style="color:var(--fg-55)">· ${f.saved.visibility === "org" ? "Org" : "Private"}</span></div>`;
  return `<div class="ask-card" data-morph-key="save:${attr(a.key)}:${index}"><div class="ask-card-t">Save as artifact: ${esc(f.title || "Untitled")}</div>
    <div class="ask-card-bar"><span style="flex:1"></span><button type="button" class="ask-btn ask-btn--accent" data-act="askAcSave" data-arg="${attr(`${a.key}:${index}`)}">Save</button></div></div>`;
}

/** STUB: nothing until Wrong? is built. */
export function feedbackView(_v: AskView, _a: AskAnswer): string {
  return "";
}

function decide(ctx: AskCtx, id: number, run: () => Promise<AskActionAnswer>, fallback: string): void {
  if (ctx.ui.actions.busy[id]) return;
  ctx.ui.actions.busy = { ...ctx.ui.actions.busy, [id]: true };
  ctx.paint();
  run().then((ans) => applyResults(ctx, ans)).catch((e) => ctx.fail(e, fallback)).finally(() => {
    const { [id]: _, ...rest } = ctx.ui.actions.busy;
    ctx.ui.actions.busy = rest;
    ctx.paint();
  });
}

export const actionsPart: AskPart = {
  code: "Ac",
  act(ctx, name, arg) {
    const id = Number(arg);
    if (name === "askAcConfirm" && id > 0) decide(ctx, id, () => ctx.api.confirmAction(id), "Couldn't make that change.");
    else if (name === "askAcCancel" && id > 0) decide(ctx, id, () => ctx.api.cancelAction(id), "Couldn't cancel that.");
    else if (name === "askAcUndo" && id > 0) decide(ctx, id, () => ctx.api.undoAction(id), "Couldn't undo that.");
    // TODO(actions): askAcSave (ctx.api.saveThread), askAcEdit…, askAcWrong… — see the header.
  },
};

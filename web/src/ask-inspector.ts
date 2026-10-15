// Ask Trov — the inspector's per-type views (SEAM: a sibling agent replaces this stub; inventory §6,
// scenarios `answer-pr`, `phone-insp`, every `insp:<type>`).
//
// TODO(inspector): build each type's body to the design — ticket, pr, doc, sprint, repo, handoff, feed, person,
// artifact (the app's sandboxed artifact viewer, never a mock; Publish to org), upload (an attachment: preview,
// size, "Attached to this thread. Trov reads it only when you ask about it."), chart (bigger, with a Chart / Table
// `segmented()`). The frame — Back, the type word, "from #14 › #176", Open in page, Close, the resize edge, the
// phone sheet — is the shell's (ask-screen.ts `inspectorFrame`); you render what is under the header.
//
// THE INTERFACE (keep it; the shell calls these):
//   InspectorUi / initialInspectorUi()   your state, at `AppState.ask.inspectorUi` (the stack itself is the shell's:
//                                        `ui.inspector { stack, idx, width, where }`, `inspectorRef(ui)`)
//   inspectorBody(v, ref)                the body for one ref
//   inspectorPart                        your acts (`askIn…`) and afterPaint
// Data: the header's `RefView` is `viewOf(v.look, ref)`; the rest comes from `ctx.api.getItem(ref)` (`AskItem {
// view, detail }`, src/ai/ask/routes.ts) or the app's existing per-type read routes — loaded in `afterPaint` /
// an act, NEVER on the render path. Open another item with `ctx.openRef(ref)` (pushes the stack).
// CSS: your block in trov.css is `/* ── Ask: inspector ── */`.

import { esc } from "./ui";
import type { AskItem } from "@shared/ai-ask-core";
import type { AskLoad, AskPart, AskView } from "./ask-state";
import { inspectorRef } from "./ask-state";
import { refStatusMark, viewOf } from "./ask-refs";

export interface InspectorUi {
  /** `GET /ask/item/:ref` per ref (the stub's only read). */
  items: Record<string, AskLoad<AskItem | null>>;
}
export const initialInspectorUi = (): InspectorUi => ({ items: {} });

/** STUB: the item's title and status from its RefView, and its detail's keys once read. */
export function inspectorBody(v: AskView, ref: string): string {
  const view = viewOf(v.look, ref);
  const item = v.ui.inspectorUi.items[ref];
  return `<div class="ask-insp-stub">
    <h2 class="ask-insp-title">${esc(view?.title ?? ref)}</h2>
    ${view?.status ? refStatusMark(view.status) : ""}
    ${item?.status === "loading" ? `<p class="ask-insp-note">Loading…</p>` : ""}
    ${item?.status === "error" ? `<p class="ask-insp-note">Couldn't read this item.</p>` : ""}
    ${item?.data ? `<p class="ask-insp-note">${esc(Object.keys(item.data.detail).join(" · ") || "No more detail.")}</p>` : ""}
  </div>`;
}

export const inspectorPart: AskPart = {
  code: "In",
  afterPaint(ctx) {
    // The stub reads the open item once (outside the render path).
    const ref = inspectorRef(ctx.ui);
    if (!ref || ctx.ui.inspectorUi.items[ref]) return;
    ctx.ui.inspectorUi.items = { ...ctx.ui.inspectorUi.items, [ref]: { status: "loading", data: null } };
    ctx.api.getItem(ref)
      .then((it) => { ctx.ui.inspectorUi.items = { ...ctx.ui.inspectorUi.items, [ref]: { status: "ok", data: it } }; })
      .catch(() => { ctx.ui.inspectorUi.items = { ...ctx.ui.inspectorUi.items, [ref]: { status: "error", data: null } }; })
      .finally(() => ctx.paint());
  },
};

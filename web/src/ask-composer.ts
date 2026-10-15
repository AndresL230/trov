// Ask Trov — the composer (SEAM: a sibling agent replaces this stub; inventory §5, every `composer:*` scenario).
//
// TODO(composer): build to the design — the growing input (Enter sends, Shift+Enter a new line), file and
// context chips with the context line ("About ticket #14 · 1 file") and its clear, attaching (the button, drag
// with the "Drop files to attach" overlay, paste; upload ON ATTACH via `ctx.api.uploadAttachments`), the @ picker
// grouped by type and the / commands (keyboard paths; Escape layer "picker"), the mode menu (Pro only: `modes`
// from `ask/state`), the Ask before changes / Auto `segmented()` (disabled with its tip when `autoAllowed` is
// false), Send ↔ Stop, the usage line under 20% left, the blocked states (quota, off), the too-large note and the
// error note. Every limit and flag from `v.ui.state.data` (AskState) — never a UI constant.
//
// THE INTERFACE (keep it; the shell and the ⌘J panel call these):
//   ComposerUi / initialComposerUi()   your state, one per conversation: `AppState.ask.composer.page | .panel`
//   composerView(v)                    the composer for `v.where` (under the conversation)
//   composerPart                       your acts (`askCo…`), Escape layers, keydown / paste / drop hooks
//   composerFocus(mount, where)        focus the box (⌘J on the Ask screen; a new thread)
// `forced` is the dev replay's `composer:<state>` (ask-replay.ts) — show that state whatever the data says.
// The phone's + menu (ask-phone.ts) reuses your controls; agree on helpers there rather than copying them.
// CSS: your block in trov.css is `/* ── Ask: composer ── */`.

import { esc, attr } from "./ui";
import type { AskCtx, AskPart, AskView, AskWhere } from "./ask-state";
import { convoOf } from "./ask-state";
import { askIcon } from "./ask-icons";
import type { AskAttachment, AskMode } from "@shared/ai-ask-core";

export const COMPOSER_STATES = ["quota", "off", "autoOff", "error", "tooLarge", "at", "slash", "files", "drag", "free", "low", "busy"] as const;
export type ComposerForced = (typeof COMPOSER_STATES)[number];

export interface ComposerUi {
  text: string;
  /** Context chips (`ticket:14`). */
  context: string[];
  /** Uploaded attachments, not sent yet. */
  attachments: AskAttachment[];
  /** The mode / switch picked here; null = the thread's, else `ask/state.defaultMode` / off. */
  mode: AskMode | null;
  auto: boolean | null;
  /** The dev replay's `composer:<state>`. */
  forced: ComposerForced | null;
}
export const initialComposerUi = (): ComposerUi => ({ text: "", context: [], attachments: [], mode: null, auto: null, forced: null });

const fieldOf = (where: AskWhere): string => `askText-${where}`;

/** The composer for `v.where`. */
export function composerView(v: AskView): string {
  const ui = v.ui.composer[v.where];
  const st = v.ui.state.data;
  const busy = convoOf(v).busy;
  const empty = convoOf(v).messages.length === 0;
  if (st && !st.enabled) {
    return `<div class="ask-composer"><div class="ask-blocked"><b>Ask Trov is off for this org.</b><span>An admin can turn it on in Org settings › AI.</span></div></div>`;
  }
  const can = !busy && ui.text.trim().length > 0;
  const placeholder = v.where === "panel" ? "Ask about this ticket…" : busy ? "Trov is answering…" : empty ? "Ask about tickets, docs, PRs or sprints" : "Ask a follow-up";
  return `<div class="ask-composer" data-ask-composer="${v.where}">
    <div class="ask-box">
      <textarea rows="1" class="ask-input" data-act="askCoText" data-arg="${v.where}" data-field="${fieldOf(v.where)}" data-ask-input="${v.where}" placeholder="${attr(placeholder)}" aria-label="Message Ask Trov">${esc(ui.text)}</textarea>
      <div class="ask-box-bar">
        <span style="flex:1"></span>
        <button type="button" class="ask-send${busy ? " is-busy" : can ? " is-on" : ""}" data-act="${busy ? "askCoStop" : "askCoSend"}" data-arg="${v.where}" aria-label="${busy ? "Stop answering" : "Send"}">${busy
          ? `<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="1" y="1" width="10" height="10" rx="2" fill="currentColor"></rect></svg>`
          : askIcon("send", 16, null, 2.2)}</button>
      </div>
    </div>
    ${v.app.phone ? "" : `<div class="ask-hint">Enter to send · Shift+Enter for a new line</div>`}
    ${empty && v.where === "page" ? `<p class="ask-disclaimer">Answers come from what you can see in Trov, with sources. Trov asks before it changes anything.</p>` : ""}
  </div>`;
}

/** Focus the box (and put the caret at the end). */
export function composerFocus(mount: ParentNode, where: AskWhere): void {
  const el = mount.querySelector<HTMLTextAreaElement>(`[data-ask-input="${where}"]`);
  if (!el) return;
  el.focus();
  el.setSelectionRange(el.value.length, el.value.length);
}

function sendFrom(ctx: AskCtx, where: AskWhere): void {
  const ui = ctx.ui.composer[where];
  const text = ui.text.trim();
  if (!text || ctx.ui[where].busy) return;
  ctx.send({ text, where, context: ui.context, attachments: ui.attachments.map((a) => a.id), mode: ui.mode ?? undefined, auto: ui.auto ?? undefined });
  ctx.ui.composer[where] = { ...ui, text: "", context: [], attachments: [] };
  ctx.paint();
}

const whereOf = (arg: string | null): AskWhere => (arg === "panel" ? "panel" : "page");

export const composerPart: AskPart = {
  code: "Co",
  act(ctx, name, arg, value) {
    const where = whereOf(arg);
    if (name === "askCoText") { ctx.ui.composer[where].text = value ?? ""; ctx.paint(); return; }
    if (name === "askCoSend") { sendFrom(ctx, where); return; }
    if (name === "askCoStop") { ctx.stop(where); return; }
  },
  onKeyDown(ctx, e) {
    const el = (e.target as Element | null)?.closest?.<HTMLTextAreaElement>("[data-ask-input]");
    if (!el || e.key !== "Enter" || e.shiftKey || e.isComposing) return false;
    e.preventDefault();
    const where = whereOf(el.dataset.askInput ?? null);
    ctx.ui.composer[where].text = el.value;
    sendFrom(ctx, where);
    return true;
  },
};

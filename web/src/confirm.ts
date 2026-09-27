// The in-app confirm for a destructive action — ONE component, never `window.confirm`.
// A quiet trigger (`dangerTrigger`, red on hover / focus / while open) and a CONFIRMATION
// MODAL (`confirmModal`): a centered `.cnpy-surface` dialog over a dimmed backdrop
// (role="alertdialog", aria-modal, labelled by its title, described by its explanation)
// with Cancel and a red Delete — at phone width a bottom sheet (the modal/sheet rule in
// canopy.css) clear of the home indicator. Purely presentational: the caller holds the
// "armed" / "busy" flags in state and renders the modal at the app ROOT as a
// `data-overlay` (web/src/morph.ts keeps it — and its focus — across rerenders).
//
// main.ts owns the keyboard, generically for any `[data-confirm-dialog]`: the destructive
// button (`[data-confirm-focus]`) is focused on open, so Enter / Space press it, and Enter
// anywhere else in the page confirms too (the dialog names its acts in
// `data-confirm-act` / `data-confirm-cancel`); Escape and a backdrop click cancel and
// return focus to `[data-confirm-trigger]`; Tab is trapped inside the dialog. While the
// write runs the button reads "Deleting…", both buttons are disabled and the dialog
// carries `data-busy`, so a repeated Enter confirms nothing twice. Open and close are a
// short fade/scale (`data-closing` plays the exit), off under prefers-reduced-motion.

import { esc, attr } from "./ui";

export interface DangerTriggerProps {
  label: string;
  /** Opens the confirm modal. */
  act: string;
  arg?: string;
  armed: boolean;
  /** The modal dialog's DOM id, for aria-controls. */
  controls: string;
}

const TRASH = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 14H6L5 6"></path><path d="M10 11v6M14 11v6"></path></svg>`;

/** The quiet destructive button: muted until hovered / focused / open, then red. */
export function dangerTrigger(p: DangerTriggerProps): string {
  return `<button type="button" data-act="${attr(p.act)}"${p.arg !== undefined ? ` data-arg="${attr(p.arg)}"` : ""} data-confirm-trigger class="cnpy-dangerbtn" aria-haspopup="dialog" aria-expanded="${p.armed ? "true" : "false"}" aria-controls="${attr(p.controls)}" style="display:inline-flex;align-items:center;gap:6px;padding:8px 12px;border-radius:8px;border:1px solid var(--border-strong);font-size:12.5px;font-weight:500;color:var(--fg-55);white-space:nowrap">${TRASH}${esc(p.label)}</button>`;
}

export interface ConfirmModalProps {
  /** DOM id of the dialog (the trigger's aria-controls). */
  id: string;
  /** The question, e.g. `Delete “Review an SSE endpoint”?`. Plain text. */
  title: string;
  /** What happens, in one or two plain sentences. */
  body: string;
  /** The destructive button's label (default "Delete"). */
  confirmLabel?: string;
  /** Its label while the write runs (default "Deleting…"). */
  busyLabel?: string;
  confirmAct: string;
  cancelAct: string;
  arg?: string;
  /** True while the write is in flight: both buttons disabled, the label says so. */
  busy?: boolean;
}

/** The modal: a root-level `data-overlay` — backdrop (a click cancels) + the centered dialog. */
export function confirmModal(p: ConfirmModalProps): string {
  const argA = p.arg !== undefined ? ` data-arg="${attr(p.arg)}"` : "";
  const dis = p.busy ? " disabled" : "";
  return `<div data-overlay="confirm-${attr(p.id)}" data-confirm-layer class="cnpy-cmodal">
    <div data-act="${attr(p.cancelAct)}"${argA} class="cnpy-cmodal-back" aria-hidden="true"></div>
    <div class="cnpy-cmodal-wrap">
      <div id="${attr(p.id)}" role="alertdialog" aria-modal="true" aria-labelledby="${attr(p.id)}-t" aria-describedby="${attr(p.id)}-d" tabindex="-1" data-confirm-dialog data-confirm-act="${attr(p.confirmAct)}" data-confirm-cancel="${attr(p.cancelAct)}"${argA}${p.busy ? " data-busy" : ""} class="cnpy-surface cnpy-cmodal-box">
        <div id="${attr(p.id)}-t" style="font-size:16px;font-weight:600;letter-spacing:-0.01em;color:var(--fg);line-height:1.35;overflow-wrap:anywhere">${esc(p.title)}</div>
        <div id="${attr(p.id)}-d" style="font-size:13px;line-height:1.55;color:var(--fg-70);margin-top:7px">${esc(p.body)}</div>
        <div class="cnpy-cmodal-btns" style="display:flex;justify-content:flex-end;gap:8px;margin-top:18px">
          <button type="button" data-act="${attr(p.cancelAct)}"${argA} class="cnpy-outlinebtn"${dis} style="padding:8px 14px;border-radius:8px;border:1px solid var(--border-strong);font-size:13px;font-weight:500;color:var(--fg-70)">Cancel</button>
          <button type="button" data-act="${attr(p.confirmAct)}"${argA} data-confirm-focus class="cnpy-confirm-go"${dis}${p.busy ? ' aria-busy="true"' : ""} style="padding:8px 16px;border-radius:8px;background:var(--red);color:#fff;font-size:13px;font-weight:600;white-space:nowrap">${esc(p.busy ? p.busyLabel ?? "Deleting…" : p.confirmLabel ?? "Delete")}</button>
        </div>
      </div>
    </div>
  </div>`;
}

/** What a keydown does while a confirmation modal is open — main.ts's one listener acts on it. */
export type ConfirmKeyAction =
  /** Dispatch the dialog's `data-confirm-act`. */
  | "confirm"
  /** Dispatch its `data-confirm-cancel`. */
  | "cancel"
  /** Leave it to the focused button's own click (Enter on Delete confirms, on Cancel cancels). */
  | "native"
  /** Move focus within the dialog (Tab / Shift+Tab). */
  | "trap"
  /** Swallow it: a write is in flight, or a held key repeating. */
  | "swallow"
  /** Not the modal's key. */
  | null;

/**
 * The keyboard contract, pure. Enter confirms — through the focused Delete button's own
 * click, or directly from anywhere else (the dialog itself, the page if focus fell out) —
 * but never while busy and never on a key repeat, so it deletes ONCE. Escape cancels
 * (not while busy). Tab is trapped.
 */
export function confirmKeyAction(key: string, o: { onDialogButton: boolean; busy: boolean; repeat: boolean }): ConfirmKeyAction {
  if (key === "Tab") return "trap";
  if (key === "Escape") return o.busy ? "swallow" : "cancel";
  if (key !== "Enter") return null;
  if (o.busy) return "swallow";
  if (o.onDialogButton) return "native";
  return o.repeat ? "swallow" : "confirm";
}

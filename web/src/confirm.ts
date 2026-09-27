// The in-app confirm for a destructive action — ONE component, never `window.confirm`.
// A quiet trigger (`dangerTrigger`, red on hover / focus / while open) and a small
// popover anchored under it (`confirmPopover`, role="alertdialog") with Cancel and a red
// confirm button. Purely presentational: the caller holds the "armed" flag in state and
// dispatches the three acts in main.ts. main.ts moves focus to `[data-confirm-focus]`
// (Cancel — the safe default) when a confirm opens, and Escape closes it back to
// `[data-confirm-trigger]`. The trigger and the popover must sit in one
// `position:relative` wrapper (`confirmAnchor`).

import { esc, attr } from "./ui";

export interface DangerTriggerProps {
  label: string;
  /** Arms the confirm (and, while armed, disarms it — a second click closes). */
  act: string;
  arg?: string;
  armed: boolean;
  /** The popover's DOM id, for aria-controls. */
  controls: string;
}

const TRASH = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 14H6L5 6"></path><path d="M10 11v6M14 11v6"></path></svg>`;

/** The quiet destructive button: muted until hovered / focused / open, then red. */
export function dangerTrigger(p: DangerTriggerProps): string {
  return `<button type="button" data-act="${attr(p.act)}"${p.arg !== undefined ? ` data-arg="${attr(p.arg)}"` : ""} data-confirm-trigger class="cnpy-dangerbtn" aria-haspopup="dialog" aria-expanded="${p.armed ? "true" : "false"}" aria-controls="${attr(p.controls)}" style="display:inline-flex;align-items:center;gap:6px;padding:8px 12px;border-radius:8px;border:1px solid var(--border-strong);font-size:12.5px;font-weight:500;color:var(--fg-55);white-space:nowrap">${TRASH}${esc(p.label)}</button>`;
}

export interface ConfirmPopoverProps {
  /** DOM id of the popover (the trigger's aria-controls). */
  id: string;
  /** The question, e.g. `Delete “Review an SSE endpoint”?`. Plain text. */
  title: string;
  /** What happens, in one or two plain sentences. */
  body: string;
  confirmLabel: string;
  confirmAct: string;
  cancelAct: string;
  arg?: string;
  /** Which edge of the anchor the popover lines up with (default right). */
  align?: "left" | "right";
  /** True while the write is in flight: both buttons disabled, the label says so. */
  busy?: boolean;
}

/** The popover itself, plus a transparent click-away layer that cancels. */
export function confirmPopover(p: ConfirmPopoverProps): string {
  const argA = p.arg !== undefined ? ` data-arg="${attr(p.arg)}"` : "";
  const edge = p.align === "left" ? "left:0" : "right:0";
  const dis = p.busy ? " disabled" : "";
  return `<div data-act="${attr(p.cancelAct)}" aria-hidden="true" style="position:fixed;inset:0;z-index:29"></div>
    <div id="${attr(p.id)}" role="alertdialog" aria-modal="false" aria-labelledby="${attr(p.id)}-t" aria-describedby="${attr(p.id)}-d" class="cnpy-confirm" style="position:absolute;top:calc(100% + 6px);${edge};z-index:30;width:min(300px,calc(100vw - 32px));box-sizing:border-box;background:var(--bg);border:1px solid var(--border-strong);border-radius:11px;padding:14px 14px 12px;box-shadow:0 14px 38px rgba(0,0,0,.38);text-align:left;animation:cnpy-pop .16s ease both">
      <div id="${attr(p.id)}-t" style="font-size:13px;font-weight:600;color:var(--fg);line-height:1.4">${esc(p.title)}</div>
      <div id="${attr(p.id)}-d" style="font-size:12px;line-height:1.5;color:var(--fg-55);margin-top:5px">${esc(p.body)}</div>
      <div style="display:flex;justify-content:flex-end;gap:7px;margin-top:12px">
        <button type="button" data-act="${attr(p.cancelAct)}"${argA} data-confirm-focus class="cnpy-outlinebtn"${dis} style="padding:6px 12px;border-radius:7px;border:1px solid var(--border-strong);font-size:12px;font-weight:500;color:var(--fg-70)">Cancel</button>
        <button type="button" data-act="${attr(p.confirmAct)}"${argA} class="cnpy-confirm-go"${dis} style="padding:6px 12px;border-radius:7px;background:var(--red);color:#fff;font-size:12px;font-weight:600;white-space:nowrap">${esc(p.busy ? "Deleting…" : p.confirmLabel)}</button>
      </div>
    </div>`;
}

/** The trigger with its popover (when armed), in the one `position:relative` wrapper. */
export function confirmAnchor(trigger: DangerTriggerProps, pop: ConfirmPopoverProps | null): string {
  return `<div style="position:relative;display:inline-flex">${dangerTrigger(trigger)}${trigger.armed && pop ? confirmPopover(pop) : ""}</div>`;
}

// The prompt box — ONE component for a prompt wherever it shows: a handoff's
// inline prompt and a Prompt Library prompt. A bordered panel (PROMPT eyebrow,
// the title, a Raw / Rendered switch, copy + expand icons) over the body — the
// markdown source in a scrolling monospace block, or rendered — and the expand modal
// that renders the same body as markdown. Purely
// presentational: the caller names the acts its buttons dispatch.

import { esc, attr } from "./ui";
import { renderMarkdown } from "./markdown";
import { segmented } from "./segmented";

const MONO_EYEBROW = "font-family:var(--label);font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--fg-40);white-space:nowrap";
export const COPY_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15V5a2 2 0 0 1 2-2h10"></path></svg>`;
const EXPAND_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6"></path><path d="M9 21H3v-6"></path><path d="M21 3l-7 7"></path><path d="M3 21l7-7"></path></svg>`;
const ICON_BTN = "width:26px;height:26px;display:grid;place-items:center;border-radius:6px;color:var(--fg-55);flex:none";

export interface PromptBoxProps {
  title: string;
  body: string;
  /** The act (and optional arg) the copy icon and the modal's Copy button dispatch. */
  copyAct: string;
  copyArg?: string;
  /** The act the expand icon dispatches (the caller opens promptModal). */
  expandAct: string;
  /** Space above the box (the handoff drops it when the box is the first thing). */
  marginTop?: number;
  /** Raw markdown (the monospace source) or rendered markdown. One setting app-wide. */
  view: PromptView;
}

export type PromptView = "raw" | "rendered";
/** The act the Raw / Rendered switch dispatches (arg: the view). */
export const PROMPT_VIEW_ACT = "promptBoxView";

function viewSwitch(view: PromptView): string {
  return segmented({
    id: "prompt-view", ariaLabel: "Prompt view", act: PROMPT_VIEW_ACT, value: view, size: "xs",
    options: [{ value: "raw", label: "Raw" }, { value: "rendered", label: "Rendered" }],
  });
}

const argAttr = (arg?: string) => (arg === undefined ? "" : ` data-arg="${attr(arg)}"`);

/** The box. It grows to fill a flex column (`flex:1`) and never drops below 180px of body.
 *  Raw shows the markdown source (scrolls sideways, nothing wraps); Rendered shows it formatted. */
export function promptBox(p: PromptBoxProps): string {
  return `<div class="cnpy-promptbox" style="position:relative;flex:1;display:flex;flex-direction:column;margin-top:${p.marginTop ?? 0}px;border:1px solid var(--border);border-radius:11px;overflow:hidden">
    <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border)">
      <div style="${MONO_EYEBROW}">Prompt</div>
      <div style="flex:1;min-width:0;font-size:12.5px;font-weight:500;color:var(--fg-70);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.title)}</div>
      ${viewSwitch(p.view)}
      <div style="display:flex;align-items:center;gap:2px;flex:none;margin-right:-6px">
        <button data-act="${attr(p.copyAct)}"${argAttr(p.copyArg)} class="cnpy-iconbtn" title="Copy prompt" aria-label="Copy prompt" style="${ICON_BTN}">${COPY_ICON}</button>
        <button data-act="${attr(p.expandAct)}" class="cnpy-iconbtn" title="Expand" aria-label="Expand" style="${ICON_BTN}">${EXPAND_ICON}</button>
      </div>
    </div>
    <div class="cnpy-scroll" style="flex:1 1 0;min-height:180px;min-width:0;overflow:auto;background:color-mix(in srgb,var(--fg) 2.5%,transparent)">
      ${p.view === "rendered"
        ? `<div class="cnpy-md" style="padding:14px 18px;font-size:13.5px;line-height:1.65;color:var(--fg-70)">${renderMarkdown(p.body)}</div>`
        : `<pre style="margin:0;padding:14px 16px;font-family:var(--code);font-size:12px;line-height:1.65;color:var(--fg-70);white-space:pre;width:max-content;min-width:100%;box-sizing:border-box">${esc(p.body)}</pre>`}
    </div>
  </div>`;
}

export interface PromptModalProps {
  title: string;
  body: string;
  copyAct: string;
  copyArg?: string;
  /** The act the backdrop, the ✕ and Close dispatch. */
  closeAct: string;
}

/** The expanded prompt, over everything (render it at the root, like the connect modal). */
export function promptModal(p: PromptModalProps): string {
  return `<div data-act="${attr(p.closeAct)}" style="position:fixed;inset:0;z-index:40;background:rgba(0,0,0,.5);display:grid;place-items:center;padding:24px">
    <div data-act="stop" role="dialog" aria-modal="true" aria-label="${attr(p.title)}" style="width:100%;max-width:620px;max-height:calc(100vh - 48px);display:flex;flex-direction:column;background:var(--bg);border:1px solid var(--border-strong);border-radius:13px;box-shadow:0 14px 38px rgba(0,0,0,.38);animation:cnpy-pop .2s ease both">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 18px;border-bottom:1px solid var(--border)">
        <div style="flex:1;font-size:14px;font-weight:600;letter-spacing:-0.005em;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.title)}</div>
        <button data-act="${attr(p.closeAct)}" class="cnpy-xbtn" aria-label="Close" style="width:28px;height:28px;display:grid;place-items:center;border-radius:7px;color:var(--fg-55);flex:none"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M5 5l14 14M19 5 5 19"></path></svg></button>
      </div>
      <div class="cnpy-scroll cnpy-md" style="overflow-y:auto;overflow-x:hidden;padding:18px;font-size:13.5px;line-height:1.65;color:var(--fg-70)">${renderMarkdown(p.body)}</div>
      <div style="display:flex;justify-content:flex-end;gap:10px;padding:12px 18px;border-top:1px solid var(--border)">
        <button data-act="${attr(p.closeAct)}" class="cnpy-outlinebtn" style="padding:7px 14px;border-radius:8px;border:1px solid var(--border-strong);font-size:12.5px;font-weight:500;color:var(--fg-70);white-space:nowrap">Close</button>
        <button data-act="${attr(p.copyAct)}"${argAttr(p.copyArg)} class="cnpy-accentbtn" style="display:inline-flex;align-items:center;gap:7px;background:var(--accent);color:var(--accent-fg);border-radius:8px;padding:7px 15px;font-size:12.5px;font-weight:600;white-space:nowrap">${COPY_ICON}Copy prompt</button>
      </div>
    </div>
  </div>`;
}

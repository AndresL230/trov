// Ask Trov — the three columns' rules (FOUNDATION; #12 §3 › Ask screen, ask-trov.dc.html L1488–1504, L1807–1830).
// Pure, so the breakpoints are unit-tested (test/render.ask-shell.test.ts):
//   • thread list 260px — hidden under 1180px of window width, and while the inspector is open under 1640px;
//     the header's toggle overrides either way (`threadsForced`), and opening the inspector drops the override
//   • conversation max 720px (the column, not the section)
//   • inspector 480px, resizable 380–720, closed by default; a full-height sheet on a phone
//   • on a phone the thread list is a drawer (ask-phone.ts) instead of a column

export const ASK_THREADS_W = 260;
export const ASK_COLUMN_MAX = 720;
export const ASK_INSPECTOR = { width: 480, min: 380, max: 720 } as const;
export const ASK_BREAK = { threads: 1180, threadsWithInspector: 1640 } as const;

export interface AskLayoutIn {
  /** The window's width (px). */
  vw: number;
  phone: boolean;
  /** The header toggle's override: true shown, false hidden, null = the rules. */
  threadsForced: boolean | null;
  inspectorOpen: boolean;
}
export interface AskLayout {
  threads: "column" | "hidden";
  inspector: "column" | "sheet" | "closed";
}

export function askLayout(i: AskLayoutIn): AskLayout {
  const inspector = !i.inspectorOpen ? "closed" : i.phone ? "sheet" : "column";
  if (i.phone) return { threads: "hidden", inspector };
  const auto = i.vw >= ASK_BREAK.threads && !(i.inspectorOpen && i.vw < ASK_BREAK.threadsWithInspector);
  return { threads: (i.threadsForced ?? auto) ? "column" : "hidden", inspector };
}

/** The inspector's width after a drag, clamped to 380–720. */
export const clampInspector = (w: number): number => Math.round(Math.max(ASK_INSPECTOR.min, Math.min(ASK_INSPECTOR.max, w)));

/** The width buckets a resize must cross to change the layout (the controller repaints only then). */
export const layoutBucket = (vw: number): number => (vw < ASK_BREAK.threads ? 0 : vw < ASK_BREAK.threadsWithInspector ? 1 : 2);

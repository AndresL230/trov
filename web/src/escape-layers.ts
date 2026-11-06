// Escape closes ONE layer — the topmost one open — never two at once (web-ui.md › Escape: one layer per press).
//
// The layers that sit above everything take the key first, in the capture phase, and stop it there: a confirmation
// (main.ts, confirm.ts), an open dropdown (dropdown.ts), a drag (pointer-drag.ts), the lightbox, Ask's own stack
// (ask-escape.ts). A field that handles Escape itself (the quick search box, a description edited in place) stops it
// or calls `preventDefault()`. Every other Escape listener follows one rule: a press whose default was prevented is
// SPENT — it closes nothing more — and a listener that closes something on Escape prevents its default. main.ts's own
// layers are one ordered list (`ESCAPE_LAYERS`, topmost first) read by `escapeTop`, so among them the order is explicit
// rather than the order the listeners happened to be added in.

export interface EscapeLayer {
  /** Is this layer on screen now? */
  open(): boolean;
  /** Close it (and hand focus back to what opened it). */
  close(): void;
}

/** The key event's parts this reads (a KeyboardEvent, or a test's stand-in). */
export interface EscapeKey { key: string; defaultPrevented: boolean; preventDefault(): void }

/** The topmost open layer of `layers` (ordered topmost first), or null. */
export function topLayer(layers: readonly EscapeLayer[]): EscapeLayer | null {
  return layers.find((l) => l.open()) ?? null;
}

/** One key press against an ordered list of layers: an Escape nobody has spent closes the topmost open layer and is
 *  spent (`preventDefault`). Returns whether a layer closed. */
export function escapeTop(e: EscapeKey, layers: readonly EscapeLayer[]): boolean {
  if (e.key !== "Escape" || e.defaultPrevented) return false;
  const top = topLayer(layers);
  if (!top) return false;
  e.preventDefault();
  top.close();
  return true;
}

// Ask Trov — the Escape stack (FOUNDATION; ask-trov.dc.html L1460–1467). Escape closes ONE thing, the
// topmost of: the @ / slash picker → any menu (mode, regenerate, a thread's ⋯, the phone + menu, Wrong?) → the
// hover card → the ⌘J panel → the inspector. Each part registers the layers it owns (ask-controller.ts
// `PARTS` › `escape`); the controller asks `closeTop` on every Escape keydown and stops there if it closed one.

export const ESC_LAYERS = ["picker", "menu", "hovercard", "cmdj", "inspector"] as const;
export type EscLayer = (typeof ESC_LAYERS)[number];

export interface EscEntry<C> {
  layer: EscLayer;
  /** Open right now? */
  isOpen(ctx: C): boolean;
  /** Close it (and repaint). */
  close(ctx: C): void;
}

/** The open layer Escape closes first, or null. */
export function topLayer<C>(entries: readonly EscEntry<C>[], ctx: C): EscLayer | null {
  for (const layer of ESC_LAYERS) if (entries.some((e) => e.layer === layer && e.isOpen(ctx))) return layer;
  return null;
}

/** Close the topmost open layer (every entry of that layer that is open). True when something closed. */
export function closeTop<C>(entries: readonly EscEntry<C>[], ctx: C): boolean {
  const top = topLayer(entries, ctx);
  if (!top) return false;
  for (const e of entries) if (e.layer === top && e.isOpen(ctx)) e.close(ctx);
  return true;
}

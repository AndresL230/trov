/**
 * The board drag's one reading of a card's id (main.ts's pointer-driven drag, tickets.md › the board).
 *
 * A board card (`boardCard` in tickets.ts) is a `hitArea` container: its `openTicket` button carries the
 * `data-arg`, the card itself does not. The id the drag needs is the card's `data-tdrag` (the ticket's per-org
 * number), so the card LIFTED and the card the slot lands AFTER are read the same way, here. A drop used to read
 * the neighbour's `data-arg`, which the card lost when it became a hitArea, so every drop sent `after_id: null`
 * and landed at the top of its column.
 */
type CardLike = { dataset: Record<string, string | undefined> } | null | undefined;

/** The ticket number a board card carries, or null when it is not a draggable card. */
export function boardCardId(card: CardLike): number | null {
  const v = card?.dataset.tdrag;
  if (!v) return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** `queueDrop`'s argument: `<id>:<status>:<after id or "">`, `after` = the card the slot follows (none = the top). */
export function boardDropArg(id: number, to: string, after: CardLike): string {
  return `${id}:${to}:${boardCardId(after) ?? ""}`;
}

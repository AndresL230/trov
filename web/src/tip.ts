// Mark tooltips (web-ui.md › Status marks): a mark carries `data-mtip`, a sentence on what its state
// means, and ONE styled bubble shows it on hover (after a short pause) or keyboard focus. The bubble is
// placed by script and fixed to the viewport, so no scroll container or overflow:hidden surface clips it
// — a CSS ::after on the mark would be cut off inside the ticket table, a tile or a dialog. It lives on
// <body> (a repaint never touches it) and takes the theme of the mark it explains.
//
// Off for a touch (a tap is a click, not a hover), inside an aria-hidden picture (the site's tour
// mocks), and without its fade under reduced motion (trov.css `.cnpy-mtip`).

export interface TipBox { top: number; left: number; width: number; height: number }

/** Where the bubble goes: centred above the mark, below it when there is no room above, and kept
 *  `edge` px inside the viewport on both sides. Pure, so it is tested without a DOM. */
export function placeTip(
  target: TipBox, tip: { width: number; height: number }, view: { width: number; height: number }, gap = 8, edge = 8,
): { top: number; left: number; below: boolean } {
  const below = target.top - gap - tip.height < edge;
  const top = below ? target.top + target.height + gap : target.top - gap - tip.height;
  const centred = target.left + target.width / 2 - tip.width / 2;
  const left = Math.max(edge, Math.min(centred, view.width - edge - tip.width));
  return { top: Math.round(top), left: Math.round(left), below };
}

/** How long a pointer rests on a mark before its bubble shows: long enough that sweeping across
 *  a table never flickers bubbles, short enough to feel like an answer. */
export const TIP_DELAY_MS = 300;

/** `el`'s mark, or null (none, or inside an aria-hidden picture). */
function markAt(el: Element | null): HTMLElement | null {
  const t = el?.closest?.<HTMLElement>("[data-mtip]") ?? null;
  return t && !t.closest('[aria-hidden="true"]') ? t : null;
}
/** The mark a pointer is over. A `hitArea` row or card lays its button over the whole row, so the
 *  pointer is on that button, not on the mark under it: look through it (the click still goes to
 *  the row — raising the mark above the button would steal it). */
function markUnder(e: PointerEvent, doc: Document): HTMLElement | null {
  const direct = markAt(e.target as Element | null);
  if (direct || !(e.target as Element | null)?.classList?.contains("cnpy-hit")) return direct;
  for (const el of doc.elementsFromPoint(e.clientX, e.clientY)) {
    const m = markAt(el);
    if (m) return m;
  }
  return null;
}

/** Wire the bubble to every `[data-mtip]` under `root` (event delegation: marks come and go with
 *  every repaint, the listeners do not). Call once. */
export function installMarkTips(root: HTMLElement, doc: Document = document): void {
  let bubble: HTMLElement | null = null;
  let current: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const el = (): HTMLElement => {
    if (bubble?.isConnected) return bubble;
    bubble = doc.createElement("div");
    bubble.className = "cnpy-mtip";
    bubble.id = "cnpy-mtip";
    bubble.setAttribute("role", "tooltip");
    doc.body.appendChild(bubble);
    return bubble;
  };
  const hide = (): void => {
    clearTimeout(timer);
    current?.removeAttribute("aria-describedby");
    current = null;
    bubble?.removeAttribute("data-on");
  };
  const show = (mark: HTMLElement): void => {
    const text = mark.getAttribute("data-mtip");
    if (!text || !mark.isConnected) return;
    const b = el();
    b.textContent = text;
    const theme = mark.closest("[data-cnpy-theme]")?.getAttribute("data-cnpy-theme");
    if (theme) b.setAttribute("data-cnpy-theme", theme);
    // Measured where it is (hidden, but laid out), then moved into place.
    const p = placeTip(mark.getBoundingClientRect(), b.getBoundingClientRect(),
      { width: doc.documentElement.clientWidth, height: doc.documentElement.clientHeight });
    b.style.left = `${p.left}px`;
    b.style.top = `${p.top}px`;
    b.setAttribute("data-below", p.below ? "1" : "0");
    b.setAttribute("data-on", "1");
    mark.setAttribute("aria-describedby", b.id);
  };

  // `pointermove`, not `pointerover`: under a hitArea button the pointer stays on ONE element while
  // it crosses the marks beneath, so only its position says which mark it is on.
  root.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch") return;
    const mark = markUnder(e, doc);
    if (mark === current) return;
    hide();
    if (!mark) return;
    current = mark;
    timer = setTimeout(() => { if (current === mark) show(mark); }, TIP_DELAY_MS);
  });
  root.addEventListener("pointerleave", hide);
  root.addEventListener("focusin", (e) => {
    const mark = markAt(e.target as Element | null);
    hide();
    if (mark) { current = mark; show(mark); }
  });
  root.addEventListener("focusout", hide);
  // A press acts (and usually repaints): the bubble goes first, never left over a moved mark.
  root.addEventListener("pointerdown", hide, true);
  doc.addEventListener("scroll", hide, true);
  doc.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); });
}

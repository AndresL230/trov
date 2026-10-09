// The Questions accordion on the signed-out site (pricing.ts `questions`, `.site-faq`).
//
// Each question is a native <details>, so it opens and closes with no script at all. What script adds
// is the MOTION, and it has to: a <details> shows or hides its content in one step, and the CSS route
// to animating that (`::details-content` + `interpolate-size`) is missing or partial in most browsers,
// which is why the first version simply snapped. So a click is taken over here:
//
//   • the answer's box (`.site-faq-a`) is animated between 0 and its measured height with the Web
//     Animations API — the same duration and curve for the one that opens and the one that closes, so
//     the two move as one;
//   • only one is open at a time (opening one closes the open one, both animated);
//   • `data-open` on the <details> flips at once, so the chevron turns WITH the box and not after it;
//   • a second click mid-flight reverses from where the box is, never from the start;
//   • under reduced motion, or with no Web Animations, it just opens and closes.
//
// One delegated listener on the document serves every `.site-faq` on the page, and survives the page
// being repainted (the SPA's landing page; the standalone pricing page).

const DURATION = 380;
const EASING = "cubic-bezier(.4, 0, .2, 1)";
const running = new WeakMap<HTMLElement, Animation>();
let installed = false;

const still = (): boolean => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function move(d: HTMLDetailsElement, open: boolean): void {
  const box = d.querySelector<HTMLElement>(":scope > .site-faq-a");
  d.dataset.open = open ? "1" : "0";
  if (!box || still() || typeof box.animate !== "function") { running.get(box as HTMLElement)?.cancel(); d.open = open; return; }
  // Where the box is now: mid-flight if a click interrupts it, else closed (0) or open (its full height).
  const from = d.open ? box.getBoundingClientRect().height : 0;
  running.get(box)?.cancel();
  d.open = true; // the content must be laid out to be measured, and to be seen while it closes
  const full = box.scrollHeight;
  const to = open ? full : 0;
  const a = box.animate(
    [{ height: `${from}px`, opacity: from === 0 ? 0 : 1 }, { height: `${to}px`, opacity: open ? 1 : 0 }],
    { duration: Math.max(120, DURATION * (Math.abs(to - from) / Math.max(1, full))), easing: EASING },
  );
  running.set(box, a);
  // `finished` (a promise) and not `onfinish` (an event): events are delivered with frames, and a tab in
  // the background has none — the question would stay half-closed until the visitor came back.
  a.finished.then(() => { if (running.get(box) === a) { running.delete(box); d.open = open; } }, () => { /* cancelled: the next move owns the box */ });
}

/** Install the accordion's motion (once per document; safe to call from every entry point). */
export function initFaqAccordion(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.addEventListener("click", (ev) => {
    const summary = (ev.target as Element | null)?.closest?.(".site-faq > details > summary");
    const d = summary?.parentElement;
    if (!(d instanceof HTMLDetailsElement)) return;
    ev.preventDefault(); // the open/close is ours to time
    const opening = d.dataset.open !== "1";
    if (opening) for (const other of Array.from(d.parentElement?.querySelectorAll<HTMLDetailsElement>(':scope > details[data-open="1"]') ?? [])) if (other !== d) move(other, false);
    move(d, opening);
  });
}

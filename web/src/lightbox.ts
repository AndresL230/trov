// ── Lightbox: click a screenshot to see it at a size worth reading ───────────
// Ported from Sapling's companion Lightbox (frontend/src/components/companion/
// Lightbox.tsx): the same backdrop, panel, contain-never-cover image, caption
// block, inset close button, keyframe entrance and timed exit. Trov's deltas:
//   • Vanilla DOM on <body>, OUTSIDE the app root: rerender() swaps the app
//     wholesale, and an overlay inside it would vanish on the next background load.
//     The root carries the app's own `data-cnpy-theme`, so the palette tokens and
//     the corners layer (trov.css) apply to it exactly as to the app — every
//     radius renders at --corner-scale, and the round close button becomes the
//     app's small rounded square.
//   • Trov's type (Geist / Archivo Narrow), not the companion serif.
// Everything modal is here too: scroll lock on the element that actually scrolls
// (#cnpy-main, longhands only, so its inline overflow-y round-trips), Escape, focus
// kept inside, and focus returned to whatever opened it.

/** Exit animation length. MUST match .cnpy-lightbox--closing in trov.css. */
const EXIT_MS = 180;

export interface LightboxOptions {
  src: string;
  alt: string;
  title: string;
  /** Trusted markup (our own figcaptions), shown under the image. */
  captionHtml?: string;
  eyebrow?: string;
}

let current: { close: () => void } | null = null;

const CLOSE_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M5 5 19 19M19 5 5 19"></path></svg>`;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function openLightbox(o: LightboxOptions): void {
  current?.close();
  const opener = document.activeElement as HTMLElement | null;
  const theme = document.querySelector("[data-cnpy-theme]")?.getAttribute("data-cnpy-theme") ?? "light";

  const root = document.createElement("div");
  root.className = "cnpy-lightbox";
  root.setAttribute("data-cnpy-theme", theme);
  root.innerHTML = `<div class="cnpy-lightbox-panel" role="dialog" aria-modal="true" aria-label="${esc(o.title)}" tabindex="-1">
      <div class="cnpy-lightbox-frame"><img src="${esc(o.src)}" alt="${esc(o.alt)}" /></div>
      <div class="cnpy-lightbox-cap">
        ${o.eyebrow ? `<span class="cnpy-lightbox-eyebrow">${esc(o.eyebrow)}</span>` : ""}
        <span class="cnpy-lightbox-title">${esc(o.title)}</span>
        ${o.captionHtml ? `<span class="cnpy-lightbox-text">${o.captionHtml}</span>` : ""}
      </div>
      <button type="button" class="cnpy-lightbox-close" aria-label="Close">${CLOSE_ICON}</button>
    </div>`;
  const panel = root.querySelector<HTMLElement>(".cnpy-lightbox-panel")!;
  const closeBtn = root.querySelector<HTMLButtonElement>(".cnpy-lightbox-close")!;

  // The frame takes the image's OWN proportions once it loads (a doc image can be any
  // shape; the guide's captures are 16:10, the CSS default), and the panel is as wide as
  // both budgets allow at that ratio — so the frame never letterboxes or overflows.
  const img = root.querySelector<HTMLImageElement>(".cnpy-lightbox-frame img")!;
  const fit = (): void => {
    if (!img.naturalWidth || !img.naturalHeight) return;
    const ratio = img.naturalWidth / img.naturalHeight;
    root.querySelector<HTMLElement>(".cnpy-lightbox-frame")!.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
    panel.style.width = `min(1400px, 100%, calc((100vh - 170px) * ${ratio.toFixed(4)}))`;
  };
  if (img.complete) fit(); else img.addEventListener("load", fit, { once: true });

  // Scroll lock: the app's scroller is #cnpy-main, not <body>.
  const scroller = document.getElementById("cnpy-main") ?? document.body;
  const prevX = scroller.style.getPropertyValue("overflow-x");
  const prevY = scroller.style.getPropertyValue("overflow-y");
  scroller.style.setProperty("overflow-x", "hidden");
  scroller.style.setProperty("overflow-y", "hidden");
  const restore = (prop: string, v: string) => (v ? scroller.style.setProperty(prop, v) : scroller.style.removeProperty(prop));

  let closing = false;
  const close = (): void => {
    if (closing) return;
    closing = true;
    root.classList.add("cnpy-lightbox--closing");
    document.removeEventListener("keydown", onKey, true);
    // A timer, not animationend: an animation that never runs (a backgrounded tab,
    // reduced motion) emits no event and would leave the viewer unclosable.
    setTimeout(() => {
      root.remove();
      restore("overflow-x", prevX);
      restore("overflow-y", prevY);
      if (current?.close === close) current = null;
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    }, EXIT_MS);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    // The close button is the one focusable thing inside: keep Tab on it.
    else if (e.key === "Tab") { e.preventDefault(); closeBtn.focus(); }
  };

  // pointerdown, not click: a drag that starts on the image and ends on the backdrop
  // is not a click-out.
  root.addEventListener("pointerdown", (e) => { if (e.target === root) close(); });
  closeBtn.addEventListener("click", close);
  document.addEventListener("keydown", onKey, true);

  document.body.appendChild(root);
  current = { close };
  panel.focus({ preventScroll: true });
}

/** Close whatever lightbox is open (e.g. on navigation). */
export function closeLightbox(): void {
  current?.close();
}

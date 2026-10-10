// ── The on-screen keyboard and the site's sheets ─────────────────────────────
// On a phone the site's dialogs are sheets along the bottom edge (trov.css). The on-screen keyboard
// does not shrink the layout viewport on iOS, nor on current Android Chrome: it covers the bottom of
// it, and a sheet pinned there would sit under the keys with its Send button out of reach. The part
// of the window the keyboard (or any other browser UI) covers is what `visualViewport` reports, so:
//
//   • `--site-kb` on <html> is the height covered at the bottom, in px (0 with no keyboard). trov.css
//     lifts the sheets by it and takes it off their height, so a sheet ends where the keyboard begins.
//   • when it changes while a field in a sheet has focus, that field is scrolled into view INSIDE the
//     sheet (`block:"nearest"`), since the sheet just became shorter.
//
// One listener for the page's lifetime; a no-op where `visualViewport` does not exist. Nothing reads
// the variable above 640px.

/** The height of the window's bottom that the visual viewport does not show (the keyboard), in px. */
export function coveredBottom(layoutHeight: number, visualHeight: number, visualTop: number): number {
  const px = Math.round(layoutHeight - visualHeight - visualTop);
  // A few px of difference is rounding or a collapsing URL bar, not a keyboard.
  return px > 40 ? px : 0;
}

let installed = false;
export function initSiteViewport(): void {
  if (installed || typeof window === "undefined" || !window.visualViewport) return;
  installed = true;
  const vv = window.visualViewport;
  let last = -1;
  const sync = (): void => {
    const kb = coveredBottom(window.innerHeight, vv.height, vv.offsetTop);
    if (kb === last) return;
    last = kb;
    document.documentElement.style.setProperty("--site-kb", `${kb}px`);
    const el = document.activeElement;
    if (kb > 0 && el instanceof HTMLElement && el.matches("input, textarea") && el.closest(".site-signin-card")) {
      // After the sheet has taken its new height.
      requestAnimationFrame(() => el.scrollIntoView({ block: "nearest" }));
    }
  };
  vv.addEventListener("resize", sync);
  vv.addEventListener("scroll", sync);
  sync();
}

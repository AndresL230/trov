// ── The big-screen zoom (docs/architecture/web-ui.md › Big screens) ─────────
// On a 4K monitor at 100% scaling (a 3840px window) a UI drawn for laptops is tiny, so past ~3000px Trov
// enlarges itself: CSS `zoom` on <html>, growing linearly from 1 at a 3000px window to 1.3 at 3840 and
// capped there (and never so far that fewer than 900 CSS px of height are left). At or under 3000px nothing
// is set at all — the page is exactly what it was. This module is the ONE place that decides and applies it.
//
// `zoom` (not a transform, not the root font-size: nearly every size is a px value) has three consequences,
// each handled once:
// 1. The browser zooms viewport units too (Chromium 153: a `100vh` box is 1.3 × the window). trov.css's
//    `--vw` / `--vh` / `--dvh` divide by `--vu`, which `applyZoom` sets to the inflation it MEASURES.
// 2. getBoundingClientRect(), a pointer's clientX / clientY and innerWidth / innerHeight are in SCREEN px,
//    but a `left` / `top` / `width` / `height` / `translate` / `scrollTop` written back is in CSS px and gets
//    zoomed again (a dropdown opened ~550px right of its trigger). Every rect → style site reads through
//    `rectOf` / `pointOf` / `viewportOf` (CSS px). The factor is measured too (`uiScale`), so if a browser
//    ever reports rects unzoomed, the helpers become the identity instead of wrong.
// 3. `elementFromPoint` / `elementsFromPoint` take SCREEN px: pass them a raw clientX / clientY, never a
//    `pointOf` value. `offset*` and an element's own `scrollTop` are CSS px already; the ROOT's
//    `clientWidth` / `clientHeight` are not (screen px, in Chromium's standards mode): read them via `clientOf`.

export const UI_ZOOM = {
  /** A window this wide (CSS px at the OS's scaling) or narrower is never zoomed. */
  from: 3000,
  /** …and this wide reaches `max`. */
  to: 3840,
  max: 1.3,
  /** The zoom never leaves the page less than this much CSS height (a laptop's). */
  minHeight: 900,
} as const;

/** The zoom for a window `width` × `height` (innerWidth / innerHeight). 1 up to `from`; 3 decimals. Pure. */
export function zoomFor(width: number, height: number): number {
  const { from, to, max, minHeight } = UI_ZOOM;
  const z = Math.round(Math.min(max, 1 + ((max - 1) * (width - from)) / (to - from), height / minHeight) * 1000) / 1000;
  return z > 1 ? z : 1;
}

/** The same rule, inline in every document's <head> (site-prerender.ts), so a prerendered page paints at its
 *  zoom from the first frame. It assumes viewport units are inflated by the zoom (true in Chromium today);
 *  `installUiZoom` measures and corrects that as soon as the page's script runs. */
export const ZOOM_BOOT = `<script>(function(){var z=Math.round(Math.min(${UI_ZOOM.max},1+(${UI_ZOOM.max}-1)*(innerWidth-${UI_ZOOM.from})/${UI_ZOOM.to - UI_ZOOM.from},innerHeight/${UI_ZOOM.minHeight})*1000)/1000;if(z>1){var s=document.documentElement.style;s.zoom=String(z);s.setProperty("--vu",String(z))}})()</script>`;

/** Screen px per CSS px, as measured at the last apply (1 when not zoomed, or with no DOM). */
let scale = 1;
/** The zoom last applied (1: none). */
let applied = 1;
/** No apply yet (ZOOM_BOOT may have set the same zoom; it is re-measured here). */
let first = true;

/** Screen px per CSS px for the page's content — 1 at or under 3000px. */
export function uiScale(): number {
  return scale;
}

/** A screen-px length (a rect's, a pointer's) as CSS px, for writing into a style. */
export function cssPx(screen: number): number {
  return scale === 1 ? screen : screen / scale;
}

export interface CssRect { top: number; left: number; right: number; bottom: number; width: number; height: number }

/** `el.getBoundingClientRect()` in CSS px: what a `position:fixed` `left` / `top` / `width` must be to cover it. */
export function rectOf(el: Element): CssRect {
  const r = el.getBoundingClientRect();
  if (scale === 1) return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  const k = 1 / scale;
  return { top: r.top * k, left: r.left * k, right: r.right * k, bottom: r.bottom * k, width: r.width * k, height: r.height * k };
}

/** A pointer's position in CSS px. (`elementFromPoint` wants the RAW clientX / clientY.) */
export function pointOf(e: { clientX: number; clientY: number }): { x: number; y: number } {
  return { x: cssPx(e.clientX), y: cssPx(e.clientY) };
}

/** The window (innerWidth × innerHeight, scrollbars included) in CSS px. */
export function viewportOf(win: Window = window): { width: number; height: number } {
  return { width: cssPx(win.innerWidth), height: cssPx(win.innerHeight) };
}

/** The root's client box (the window minus its scrollbars) in CSS px. Chromium 153 reports
 *  `documentElement.clientWidth` / `clientHeight` in SCREEN px under the zoom in standards mode (CSS px in quirks
 *  mode), so which one it is is read off the window: the value nearer `innerWidth` is screen px. */
export function clientOf(doc: Document = document): { width: number; height: number } {
  const root = doc.documentElement;
  const win = doc.defaultView;
  const w = root.clientWidth, h = root.clientHeight;
  if (scale === 1 || !win) return { width: w, height: h };
  const screen = Math.abs(w - win.innerWidth) < Math.abs(w - win.innerWidth / scale);
  return screen ? { width: w / scale, height: h / scale } : { width: w, height: h };
}

/** Apply the zoom for the window's size now, and measure what it did. */
function applyZoom(win: Window): void {
  const doc = win.document;
  const root = doc.documentElement;
  const z = zoomFor(win.innerWidth, win.innerHeight);
  // Nothing to do at or under 3000px on boot (ZOOM_BOOT used the same rule): not even an attribute is touched.
  if (z === applied && (!first || z === 1)) { first = false; return; }
  first = false;
  // No transition plays a zoom change (a width or padding transition would otherwise run on every resize step).
  root.setAttribute("data-zooming", "");
  if (z === 1) {
    root.style.removeProperty("zoom");
    root.style.removeProperty("--vu");
    scale = 1;
  } else {
    root.style.setProperty("zoom", String(z));
    // Measure, never assume: a fixed box 1000px wide and 100vh tall says how the browser treats both.
    const probe = doc.createElement("div");
    probe.style.cssText = "position:fixed;left:0;top:0;width:1000px;height:100vh;visibility:hidden;pointer-events:none;contain:strict";
    (doc.body ?? root).appendChild(probe);
    const r = probe.getBoundingClientRect();
    probe.remove();
    scale = r.width > 0 ? r.width / 1000 : 1;
    const vu = r.height > 0 && win.innerHeight > 0 ? r.height / win.innerHeight : 1;
    if (Math.abs(vu - 1) < 0.0005) root.style.removeProperty("--vu");
    else root.style.setProperty("--vu", String(Math.round(vu * 10000) / 10000));
  }
  applied = z;
  void root.offsetWidth;                   // commit the new size before transitions come back
  win.requestAnimationFrame(() => root.removeAttribute("data-zooming"));
}

let installed = false;
/** Apply the zoom and keep it right as the window changes. Call FIRST in a page's boot script, before anything
 *  else listens to `resize`, so every other resize handler reads the new scale. Safe to call twice. */
export function installUiZoom(win: Window = window): void {
  if (installed || typeof win === "undefined" || !win.document) return;
  installed = true;
  applyZoom(win);
  win.addEventListener("resize", () => applyZoom(win));
}

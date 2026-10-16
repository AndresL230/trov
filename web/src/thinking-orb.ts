// The thinking orb — a dotted 3D orb that says what Trov is doing while it works (Ask's steps, its thinking, the
// wait before the first word). The engine is thinking-orbs by Jakub Antalik (MIT, ./orbs/LICENSE;
// github.com/RareFormLabs/thinking-orbs @ e09bfa60), vendored without its Vue wrapper: `./orbs/` is the upstream
// engine and presets as they ship; this file is the framework-free wrapper in its place.
//
//   thinkingOrb(state, size)  the markup: a <canvas data-orb> sized for the device's pixels IN the template, so a
//                             morph never touches its width / height (setting either clears a canvas).
//   the loop                  ONE requestAnimationFrame loop paints every canvas[data-orb] in the document, on the
//                             shared clock (so two orbs never drift apart), and stops itself when none is left.
//                             Rendering an orb starts it. A canvas that is not laid out is skipped; a hidden tab
//                             pauses it (rAF does).
//   the theme                 read on every frame from the nearest [data-cnpy-theme]: light ink on dark, dark on light.
//   reduced motion            one static frame per paint and no loop (the upstream's frame at 0.6s).
//   a tour                    `thinkingOrbTour(states, …)`: one orb that shows each state in turn (TOUR_SECONDS each),
//                             on the same clock — a preview of "it changes with what it does" (Settings › Trov).

import { MODE_DRAWS } from "./orbs/engine/registry";
import { resolvePreset } from "./orbs/presets";
import type { OrbSize, OrbState } from "./orbs/types";

export type { OrbSize, OrbState };

const LABEL: Record<OrbState, string> = {
  working: "Working…", searching: "Searching…", solving: "Thinking…", listening: "Listening…", composing: "Writing…", shaping: "Shaping…",
};

const STATES = new Set<string>(Object.keys(LABEL));
const browser = typeof window !== "undefined" && typeof document !== "undefined";
const dpr = (): number => (browser ? Math.min(2, window.devicePixelRatio || 1) : 1);
const reduced = (): boolean => browser && typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

let raf = 0;

/** How long a tour shows each of its states. */
export const TOUR_SECONDS = 2.4;

/** A tour's state at `tSec` (its first one under reduced motion, where the clock stands at 0.6s). */
export function tourState(states: readonly string[], tSec: number): string | undefined {
  return states.length ? states[Math.floor(tSec / TOUR_SECONDS) % states.length] : undefined;
}

function paint(c: HTMLCanvasElement, tSec: number): void {
  const state = c.dataset.orb === "tour" ? tourState((c.dataset.orbTour ?? "").split(" ").filter(Boolean), tSec) : c.dataset.orb;
  if (!state || !STATES.has(state)) return;
  const size: OrbSize = c.dataset.orbSize === "64" ? 64 : 20;
  const ratio = dpr();
  const px = Math.round(size * ratio);
  if (c.width !== px) c.width = px;
  if (c.height !== px) c.height = px;
  const ctx = c.getContext("2d");
  if (!ctx) return;
  const { mode, speed, opts } = resolvePreset(state as OrbState, size);
  const dark = c.closest("[data-cnpy-theme]")?.getAttribute("data-cnpy-theme") === "dark";
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, size, size);
  MODE_DRAWS[mode](ctx, size, tSec * speed, dark, opts);
}

function tick(): void {
  raf = 0;
  const orbs = document.querySelectorAll<HTMLCanvasElement>("canvas[data-orb]");
  if (!orbs.length) return;
  const still = reduced();
  const t = still ? 0.6 : performance.now() / 1000;
  for (const c of orbs) if (c.getClientRects().length) paint(c, t);
  if (!still) raf = requestAnimationFrame(tick);
}

/** Paint on the next frame (the markup is in the DOM by then), and keep painting while an orb is on the page. */
function schedule(): void {
  if (browser && !raf) raf = requestAnimationFrame(tick);
}

/** A thinking orb: `state` is what it is doing, `size` one of the two tuned presets. Purely decorative when the
 *  words beside it say the same (`label: null`); otherwise an image named for its state. */
export function thinkingOrb(state: OrbState, size: OrbSize = 20, label: string | null = LABEL[state]): string {
  schedule();
  const px = Math.round(size * dpr());
  const a11y = label === null ? `aria-hidden="true"` : `role="img" aria-label="${label.replace(/"/g, "&quot;")}"`;
  return `<canvas class="cnpy-orb" data-orb="${state}" data-orb-size="${size}" width="${px}" height="${px}" ${a11y} style="width:${size}px;height:${size}px"></canvas>`;
}

/** One orb that shows `states` in turn — the same canvas, sizes and loop as `thinkingOrb`. */
export function thinkingOrbTour(states: readonly OrbState[], size: OrbSize = 20, label: string | null = null): string {
  return thinkingOrb(states[0] ?? "working", size, label).replace(/data-orb="\w+"/, `data-orb="tour" data-orb-tour="${states.join(" ")}"`);
}

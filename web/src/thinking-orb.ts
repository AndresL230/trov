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
//   the theme                 read on every frame from the nearest [data-cnpy-theme]; the ink is that theme's
//                             --purple (purple = "Trov is working"), a dot's depth its opacity (orbs/engine/core.ts setInk).
//   reduced motion            one static frame per paint and no loop (the upstream's frame at 0.6s).

import { MODE_DRAWS } from "./orbs/engine/registry";
import { setInk } from "./orbs/engine/core";
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

/** The orb's ink: its theme's `--purple` (#rgb / #rrggbb / rgb()), read off the canvas; null when it has none. */
const inks = new Map<string, readonly [number, number, number] | null>();
function inkOf(c: HTMLCanvasElement): readonly [number, number, number] | null {
  const raw = getComputedStyle(c).getPropertyValue("--purple").trim();
  if (inks.has(raw)) return inks.get(raw) ?? null;
  let rgb: [number, number, number] | null = null;
  const hex = raw.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
  if (hex) {
    const h = hex.length === 3 ? hex.split("").map((x) => x + x).join("") : hex;
    rgb = [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  } else {
    const m = raw.match(/^rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/i);
    if (m) rgb = [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  inks.set(raw, rgb);
  return rgb;
}

function paint(c: HTMLCanvasElement, tSec: number): void {
  const state = c.dataset.orb;
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
  // Purple means "Trov is working" (the owner): the orb draws in the theme's --purple, depth as its opacity.
  setInk(inkOf(c));
  MODE_DRAWS[mode](ctx, size, tSec * speed, dark, opts);
  setInk(null);
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


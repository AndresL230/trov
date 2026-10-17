// The link line — two orbs and the particles between them (Relay › Links: the "Start a link" card and the head of a
// link's page; docs/architecture/handoffs-prompts.md › Agent links › Web). The requester's orb is on the LEFT, the
// recipient's on the RIGHT, and one canvas draws both and the stream that runs between them. It is decoration: the
// canvas is aria-hidden, and the words under it (each side's person and session, the state's mark) carry every
// meaning — the picture only shows the same thing moving.
//
//   the markup   `linkLine(spec)`: a <canvas data-linkline> whose WIDTH / HEIGHT are fixed in the template (a morph
//                never resets them; setting either clears a canvas), scaled by CSS to its column (420 × 104 at 1×; down on a phone) — the orbs
//                shrink with it. What it shows is data attributes only (`data-ll-left`, `-right`, `-flow`, `-notes`,
//                `-last`, `-rate`), so a morph that patches the page keeps the SAME canvas and its particles in
//                flight, and the composer beside it keeps its focus.
//   the loop     the thinking orb's (thinking-orb.ts `addOrbPainter`): one requestAnimationFrame loop and one clock for
//                every orb on the page. A line with nothing moving (an ended link) is painted once per look and asks
//                for no more frames; a line scrolled out of view is not painted; a hidden tab pauses rAF.
//   the ink      the theme's --accent only (the owner: colour carries meaning only), read per frame, both themes.
//   reduced      `prefers-reduced-motion`: one still frame — the orbs at the orb engine's still time and a fixed
//                scatter of particles that shows the direction of the flow — and no loop.
//
// What moves, by state (`linkLineState`):
//   draft      a flicker on the requester's side (a few particles that die before they get far); the recipient asleep.
//   requested  a slow one-way trickle, requester → recipient; the recipient's orb "listening" (it is being asked).
//   open       flowing both ways; a side with no session yet is a hollow ring that sends little.
//   a note     a pulse — a tight cluster — travelling from its author's side; the other orb flares as it lands.
//   ended      (declined / cancelled / expired / closed) the particles stop, both orbs dim: one still frame.
// The start card adds: `preview` (the stream reaches further as the card is filled in), `burst` (Send), and `none`.

import type { LinkView, LinkSideView, LinkSideName } from "@shared/links";
import { LINK_LIVE_STATES } from "@shared/links";
import { addOrbPainter, scheduleOrbs, inkOf } from "./thinking-orb";
import { MODE_DRAWS } from "./orbs/engine/registry";
import { setInk, paint as paintDots, makeProj, hashD, type Dot } from "./orbs/engine/core";
import { resolvePreset } from "./orbs/presets";
import type { OrbState } from "./orbs/types";

/** One orb's look. awake: a session is on it (orbiting dots) · hollow: no session yet (a quiet dotted ring) ·
 *  calling: asked, not answered (the listening wave) · asleep: not asked yet (a faint ring) · seeking: Trov will find
 *  who (the searching globe) · named: a person picked, their photo inside a bright ring · dim / dimhollow: ended. */
export type LineOrb = "awake" | "hollow" | "calling" | "asleep" | "seeking" | "named" | "dim" | "dimhollow";
/** What the particles do (see the header). */
export type LineFlow = "none" | "flicker" | "trickle" | "flow" | "preview" | "burst" | "stopped";

export interface LineSpec {
  left: LineOrb;
  right: LineOrb;
  flow: LineFlow;
  /** The notes so far and whose side wrote the last one: a count that grows sends a pulse from that side. */
  notes?: number;
  last?: LinkSideName | null;
  /** `preview` only: how much of the start card is filled in, 0..1 — how far the stream reaches. */
  rate?: number;
}

const ORBS: readonly LineOrb[] = ["awake", "hollow", "calling", "asleep", "seeking", "named", "dim", "dimhollow"];
const FLOWS: readonly LineFlow[] = ["none", "flicker", "trickle", "flow", "preview", "burst", "stopped"];
/** Orbs and flows that never move: a line made only of these is one still frame. */
const STILL_ORBS = new Set<LineOrb>(["asleep", "dim", "dimhollow"]);
const STILL_FLOWS = new Set<LineFlow>(["none", "stopped"]);

// The canvas, in CSS px (the template scales it down on a narrow screen; the drawing never changes its own size).
export const LINE_W = 420;
export const LINE_H = 104;
const ORB = 84;
const CX_L = 46;
const CX_R = LINE_W - 46;
const CY = LINE_H / 2;
/** Where the stream leaves and lands: just inside each orb's rim. */
const X0 = CX_L + 28;
const X1 = CX_R - 28;
/** At most this many particles in flight on one line. */
const MAX_PARTICLES = 220;

const browser = typeof window !== "undefined" && typeof document !== "undefined";
const dpr = (): number => (browser ? Math.min(2, window.devicePixelRatio || 1) : 1);

/** A link's line as its state reads (pure; the link page and the tests use it). */
export function linkLineState(l: Pick<LinkView, "state" | "requester" | "recipient"> & { notes?: { side: LinkSideName }[] }): LineSpec {
  const ended = !LINK_LIVE_STATES.includes(l.state);
  const sideOrb = (s: LinkSideView): LineOrb => (ended ? (s.kind ? "dim" : "dimhollow") : s.kind ? "awake" : "hollow");
  const left = sideOrb(l.requester);
  const right: LineOrb = l.state === "draft" ? "asleep" : l.state === "requested" ? "calling" : sideOrb(l.recipient);
  const flow: LineFlow = l.state === "draft" ? "flicker" : l.state === "requested" ? "trickle" : l.state === "open" ? "flow" : "stopped";
  const notes = l.notes ?? [];
  return { left, right, flow, notes: notes.length, last: notes.length ? notes[notes.length - 1].side : null };
}

/** The canvas (and, in the start card, a photo inside either orb). `faces` are pre-rendered avatars (people.ts
 *  `personChip`); both slots are always emitted, so the structure is the same whatever is picked. */
export function linkLine(spec: LineSpec, faces: { left?: string; right?: string } = {}): string {
  scheduleOrbs();
  const r = dpr();
  const rate = Math.max(0, Math.min(1, spec.rate ?? 0));
  const face = (side: "left" | "right", html: string | undefined) =>
    `<div class="cnpy-ll-face" data-ll-face="${side}"${html ? "" : " hidden"}>${html ?? ""}</div>`;
  return `<div class="cnpy-ll" data-ll-flow="${spec.flow}"><canvas class="cnpy-ll-cv" data-linkline data-ll-left="${spec.left}" data-ll-right="${spec.right}" data-ll-flow="${spec.flow}" data-ll-notes="${spec.notes ?? 0}" data-ll-last="${spec.last ?? ""}" data-ll-rate="${rate.toFixed(2)}" width="${Math.round(LINE_W * r)}" height="${Math.round(LINE_H * r)}" aria-hidden="true"></canvas>${face("left", faces.left)}${face("right", faces.right)}</div>`;
}

// ── the painter ──────────────────────────────────────────────────────────────

interface Particle {
  /** Progress 0..1 along the line FROM its own side; `reach` is where it dies (a flicker stops short). */
  p: number; dir: 1 | -1; lane: number; speed: number; r: number; seed: number; a: number; reach: number; pulse: boolean;
}
interface Sim {
  ps: Particle[];
  last: number;
  accL: number;
  accR: number;
  notes: number | null;
  left: LineOrb | null;
  right: LineOrb | null;
  flashL: number;
  flashR: number;
  /** The look last painted while nothing moved (skip an identical repaint). */
  painted: string;
  n: number;
}
const sims = new WeakMap<HTMLCanvasElement, Sim>();
const simOf = (c: HTMLCanvasElement): Sim => {
  let s = sims.get(c);
  if (!s) { s = { ps: [], last: 0, accL: 0, accR: 0, notes: null, left: null, right: null, flashL: 0, flashR: 0, painted: "", n: 0 }; sims.set(c, s); }
  return s;
};

const pick = <T extends string>(v: string | undefined, all: readonly T[], dflt: T): T => (all as readonly string[]).includes(v ?? "") ? (v as T) : dflt;
const ease = (x: number): number => x * x * (3 - 2 * x);
const smooth = (a: number, b: number, x: number): number => ease(Math.max(0, Math.min(1, (x - a) / (b - a))));

/** Per-side spawn rates (particles a second) and how they travel, by flow. */
function rates(flow: LineFlow, left: LineOrb, right: LineOrb, rate: number): { l: number; r: number; speed: [number, number]; reach: number } {
  const sends = (o: LineOrb) => (o === "awake" ? 1 : o === "hollow" ? 0.25 : 0);
  switch (flow) {
    case "flicker": return { l: 2.5, r: 0, speed: [0.1, 0.16], reach: 0.16 };
    case "trickle": return { l: 4.5, r: 0, speed: [0.12, 0.18], reach: 1 };
    case "flow": return { l: 1.5 + 13 * sends(left), r: 1.5 + 13 * sends(right), speed: [0.2, 0.3], reach: 1 };
    case "preview": return { l: 2 + 9 * rate, r: 0, speed: [0.16, 0.24], reach: 0.22 + 0.78 * rate };
    case "burst": return { l: 70, r: 0, speed: [0.75, 1.05], reach: 1 };
    default: return { l: 0, r: 0, speed: [0, 0], reach: 0 };
  }
}

function spawn(s: Sim, dir: 1 | -1, speed: [number, number], reach: number, pulse = false, lane?: number): void {
  if (s.ps.length >= MAX_PARTICLES) return;
  const k = s.n++;
  const h1 = hashD(k, 1.3), h2 = hashD(k, 4.7), h3 = hashD(k, 9.1);
  // Two-way flows braid: requester → recipient rides a little above the axis, the reply a little below.
  const ln = lane ?? (dir === 1 ? -1 + 1.25 * h1 : -0.25 + 1.25 * h1);
  s.ps.push({
    p: 0, dir, lane: ln, speed: speed[0] + (speed[1] - speed[0]) * h2, r: pulse ? 1.7 + 0.8 * h3 : 0.7 + 1.3 * h3,
    seed: h3, a: pulse ? 1 : 0.4 + 0.6 * h2, reach: Math.min(1, reach * (0.75 + 0.25 * h3)), pulse,
  });
}

/** A particle's place and ink on the canvas at time t. */
function placed(q: Particle, t: number): [number, number, number] {
  const pos = q.dir === 1 ? q.p : 1 - q.p;
  const arc = Math.sin(Math.PI * pos);
  const x = X0 + (X1 - X0) * pos;
  const y = CY + q.lane * 18 * arc + Math.sin(t * 1.9 + q.seed * 6.283) * 1.6 * arc;
  const env = smooth(0, 0.07, q.p) * (1 - smooth(q.reach - (q.reach < 1 ? 0.12 : 0.06), q.reach, q.p));
  return [x, y, q.a * env];
}

/** The still frame's particles: a fixed scatter that still shows which way the line runs. */
function stillParticles(flow: LineFlow, left: LineOrb, right: LineOrb, rate: number): Particle[] {
  const out: Particle[] = [];
  const add = (n: number, dir: 1 | -1, reach: number, a: number) => {
    for (let i = 0; i < n; i++) {
      const h = hashD(i + (dir === 1 ? 0 : 50), 2.2), g = hashD(i, 7.7);
      const lane = dir === 1 ? -1 + 1.25 * h : -0.25 + 1.25 * h;
      out.push({ p: Math.min(reach - 0.04, ((i + 0.5) / n) * reach), dir, lane, speed: 0, r: 0.7 + 0.9 * g, seed: g, a, reach, pulse: false });
    }
  };
  const r = rates(flow, left, right, rate);
  if (flow === "stopped") { add(9, 1, 1, 0.2); return out; }
  if (r.l > 0) add(Math.min(26, Math.max(3, Math.round(r.l * 3))), 1, r.reach, 0.85);
  if (r.r > 0) add(Math.min(26, Math.max(3, Math.round(r.r * 3))), -1, r.reach, 0.85);
  return out;
}

/** A dotted ring, tilted in 3D and turning slowly: an orb with no session in it. */
function ring(ctx: CanvasRenderingContext2D, cx: number, t: number, dark: boolean): void {
  const R = ORB * 0.4;
  const pt = makeProj(t * 0.35, 1.05, cx, CY, 1);
  const dots: Dot[] = [];
  const n = 46;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const [x, y, z] = pt(Math.cos(a) * R, 0, Math.sin(a) * R);
    const depth = (z / R + 1) / 2;
    dots.push({ x, y, z, r: 0.75 + 0.75 * depth, white: 0.5 - 0.35 * depth, a: 0.45 + 0.55 * depth });
  }
  paintDots(ctx, dots, dark, 0.3);
}

const ORB_MODE: Partial<Record<LineOrb, OrbState>> = { awake: "working", calling: "listening", seeking: "searching", dim: "working" };

function drawOrb(ctx: CanvasRenderingContext2D, cx: number, o: LineOrb, t: number, still: boolean, flash: number, dark: boolean): void {
  const state = ORB_MODE[o];
  // ended orbs are a still frame at the orb engine's own still time; a ring breathes unless it is still.
  const tt = o === "dim" || o === "dimhollow" || still ? 0.6 : t;
  const alpha: Record<LineOrb, number> = {
    awake: 1, calling: 0.8, seeking: 0.72, named: 0.95, hollow: 0.5 + (still ? 0 : 0.12 * Math.sin(t * 1.6)), asleep: 0.22, dim: 0.26, dimhollow: 0.18,
  };
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha[o] + 0.35 * flash));
  if (state) {
    const { mode, speed, opts } = resolvePreset(state, 64);
    ctx.translate(cx - ORB / 2, CY - ORB / 2);
    MODE_DRAWS[mode](ctx, ORB, tt * speed, dark, opts);
  } else {
    ring(ctx, cx, tt, dark);
  }
  ctx.restore();
  if (flash > 0.01) {
    // A landing: one dotted ring that widens and fades round the orb.
    ctx.save();
    ctx.globalAlpha = 0.55 * flash;
    const R = ORB * (0.46 + 0.2 * (1 - flash));
    const dots: Dot[] = [];
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      dots.push({ x: cx + Math.cos(a) * R, y: CY + Math.sin(a) * R, z: 0, r: 0.9, white: 0.2 });
    }
    paintDots(ctx, dots, dark, 0.3);
    ctx.restore();
  }
}

function paintLine(c: HTMLCanvasElement, t: number, still: boolean): boolean {
  const d = c.dataset;
  const left = pick(d.llLeft, ORBS, "hollow");
  const right = pick(d.llRight, ORBS, "hollow");
  const flow = pick(d.llFlow, FLOWS, "none");
  const rate = Math.max(0, Math.min(1, Number(d.llRate) || 0));
  const notes = Number(d.llNotes) || 0;
  const lastSide = d.llLast === "requester" || d.llLast === "recipient" ? d.llLast : null;
  const s = simOf(c);

  // A line out of view is not painted (its clock still advances, so it resumes without a jump).
  const box = c.getBoundingClientRect();
  if (!still && (box.bottom < 0 || box.top > window.innerHeight)) { s.last = t; return true; }

  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const pxW = Math.round(LINE_W * ratio), pxH = Math.round(LINE_H * ratio);
  const dark = c.closest("[data-cnpy-theme]")?.getAttribute("data-cnpy-theme") === "dark";
  const ink = inkOf(c);

  // What changed since the last frame: a note that landed (a pulse from its side), an orb that lit up (a flare).
  const lit = (o: LineOrb | null) => o === "awake" || o === "calling";
  if (!still) {
    if (s.notes !== null && notes > s.notes && lastSide && (flow === "flow" || flow === "trickle")) {
      const dir: 1 | -1 = lastSide === "requester" ? 1 : -1;
      for (let i = 0; i < 16; i++) spawn(s, dir, [0.5, 0.56], 1, true, (dir === 1 ? -0.35 : 0.35) + (hashD(i, 3.3) - 0.5) * 0.5);
    }
    if (s.right !== null && !lit(s.right) && lit(right)) s.flashR = 1;
    if (s.left !== null && !lit(s.left) && lit(left)) s.flashL = 1;
  }
  s.notes = notes; s.left = left; s.right = right;

  const moving = !still && (!STILL_FLOWS.has(flow) || s.ps.length > 0 || !STILL_ORBS.has(left) || !STILL_ORBS.has(right) || s.flashL > 0.01 || s.flashR > 0.01);
  const look = `${left}|${right}|${flow}|${rate}|${pxW}|${dark}|${ink?.join(",") ?? ""}|${still}`;
  if (!moving && s.painted === look && c.width === pxW) return false;

  if (c.width !== pxW) c.width = pxW;
  if (c.height !== pxH) c.height = pxH;
  const ctx = c.getContext("2d");
  if (!ctx) return false;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, LINE_W, LINE_H);
  setInk(ink);

  let ps: Particle[];
  if (still) {
    ps = stillParticles(flow, left, right, rate);
  } else {
    // A slow or paused frame (a busy page, a tab coming back) moves the stream at most a quarter second.
    const dt = s.last ? Math.max(0, Math.min(0.25, t - s.last)) : 0;
    s.last = t;
    const r = rates(flow, left, right, rate);
    s.accL += r.l * dt; s.accR += r.r * dt;
    while (s.accL >= 1) { s.accL -= 1; spawn(s, 1, r.speed, r.reach); }
    while (s.accR >= 1) { s.accR -= 1; spawn(s, -1, r.speed, r.reach); }
    if (r.l === 0) s.accL = 0;
    if (r.r === 0) s.accR = 0;
    // A line that stops lets what is in flight fade out where it is.
    const fade = STILL_FLOWS.has(flow);
    const next: Particle[] = [];
    for (const q of s.ps) {
      q.p += q.speed * dt;
      if (fade) q.a -= dt * 2.2;
      if (q.p >= q.reach || q.a <= 0.02) {
        if (q.p >= 1 && q.reach >= 1) {
          // Landing: a pulse (or the burst of a Send) makes the orb it reaches flare.
          const bump = q.pulse ? 0.18 : flow === "burst" ? 0.03 : 0;
          if (q.dir === 1) s.flashR = Math.min(1, s.flashR + bump); else s.flashL = Math.min(1, s.flashL + bump);
        }
        continue;
      }
      next.push(q);
    }
    s.ps = next;
    s.flashL = Math.max(0, s.flashL - dt * 1.1);
    s.flashR = Math.max(0, s.flashR - dt * 1.1);
    ps = s.ps;
    if (flow === "stopped" && !ps.length) ps = stillParticles("stopped", left, right, rate);
  }

  drawOrb(ctx, CX_L, left, t, still, still ? 0 : s.flashL, dark);
  drawOrb(ctx, CX_R, right, t, still, still ? 0 : s.flashR, dark);

  // The stream, in the same ink: a particle's weight is its alpha (no second colour, no glow).
  const rgb = ink ?? (dark ? [230, 230, 230] : [40, 40, 40]);
  for (const q of ps) {
    const [x, y, a] = placed(q, t);
    if (a < 0.02) continue;
    ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${Math.min(1, a)})`;
    ctx.beginPath();
    ctx.arc(x, y, q.r, 0, Math.PI * 2);
    ctx.fill();
  }
  setInk(null);
  s.painted = look;
  return moving;
}

addOrbPainter({ selector: "canvas[data-linkline]", paint: paintLine });

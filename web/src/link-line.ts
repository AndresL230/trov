// The link line — orbs and the particles between them (Relay › Links: the arc diagram at the top of the tab, the
// "Start a link" card and the head of a link's page; docs/architecture/handoffs-prompts.md › Agent links › Web).
// It is decoration: every canvas is aria-hidden, and the words around it (each side's person and session, the
// state's mark, the hit areas' labels) carry every meaning — the picture only shows the same thing moving.
//
//   the markup   `linkLine(spec)` (two orbs: the requester's on the LEFT, the recipient's on the RIGHT) and
//                `linkHeroCanvas(orbs, segs, base)` (the arc diagram: your client kinds as stations on a line). Each is a
//                <canvas> whose WIDTH / HEIGHT are fixed in the template (a morph never resets them; setting either
//                clears a canvas), scaled by CSS to its column. What it shows is data attributes only, so a morph
//                that patches the page keeps the SAME canvas and its particles in flight, and a form beside it keeps
//                its focus.
//   the loop     the thinking orb's (thinking-orb.ts `addOrbPainter`): one requestAnimationFrame loop and one clock for
//                every orb on the page. A canvas with nothing moving is painted once per look and asks for no more
//                frames; one scrolled out of view is not painted; a hidden tab pauses rAF.
//   the ink      the theme's --accent only (the owner: colour carries meaning only), read per frame; on the dark
//                theme the dots are drawn larger and fuller so the olive accent does not wash out.
//   reduced      `prefers-reduced-motion`: one still frame — the orbs at the orb engine's still time and a fixed
//                scatter of particles that shows which way each line runs — and no loop.
//
// What moves, by state (`linkLineState`):
//   draft      a flicker on the requester's side (a few particles that die before they get far); the recipient asleep.
//   requested  a slow one-way trickle, requester → recipient; the recipient's orb "listening" (it is being asked).
//   open       flowing both ways; a side with no session yet is a hollow ring that sends little.
//   a note     a pulse — a tight cluster — travelling from its author's side; the other orb flares as it lands.
//   ended      (declined / cancelled / expired / closed) the particles stop, both orbs dim: one still frame.
// The start card adds `preview` (the stream reaches further as the card is filled in), `burst` (Send) and `none`;
// the arc diagram adds `pulse` (a request waiting for YOU: a cluster travels up toward you every few seconds) and
// `hub` (where your photo sits: no orb drawn).

import type { LinkView, LinkSideView, LinkSideName } from "@shared/links";
import { LINK_LIVE_STATES } from "@shared/links";
import { addOrbPainter, scheduleOrbs, inkOf } from "./thinking-orb";
import { MODE_DRAWS } from "./orbs/engine/registry";
import { setInk, paint as paintDots, makeProj, hashD, type Dot } from "./orbs/engine/core";
import { resolvePreset } from "./orbs/presets";
import { scaleRadii } from "./orbs/engine/profiles";
import type { ModeOpts } from "./orbs/engine/profiles";
import type { OrbState } from "./orbs/types";

/** One orb's look. awake: a session is on it (orbiting dots) · hollow: no session yet (a quiet dotted ring) ·
 *  calling: asked, not answered (the listening wave) · asleep: not asked yet (a faint ring) · seeking: Trov will find
 *  who (the searching globe) · named: a person picked, their photo inside a bright ring · dim / dimhollow: ended. */
export type LineOrb = "awake" | "hollow" | "calling" | "asleep" | "seeking" | "named" | "dim" | "dimhollow" | "hub";
/** What the particles do (see the header). */
export type LineFlow = "none" | "flicker" | "trickle" | "flow" | "preview" | "burst" | "stopped" | "pulse";

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

const ORBS: readonly LineOrb[] = ["awake", "hollow", "calling", "asleep", "seeking", "named", "dim", "dimhollow", "hub"];
const FLOWS: readonly LineFlow[] = ["none", "flicker", "trickle", "flow", "preview", "burst", "stopped", "pulse"];
/** Orbs and flows that never move: a line made only of these is one still frame. */
const STILL_ORBS = new Set<LineOrb>(["asleep", "dim", "dimhollow"]);
const STILL_FLOWS = new Set<LineFlow>(["none", "stopped"]);

// The two-orb line, in CSS px (the template scales it to its column; the drawing never changes its own size).
export const LINE_W = 420;
export const LINE_H = 110;
const ORB = 92;
const CX_L = 50;
const CX_R = LINE_W - 50;
const CY = LINE_H / 2;
/** At most this many particles in flight on one canvas. */
const MAX_PARTICLES = 300;

const browser = typeof window !== "undefined" && typeof document !== "undefined";
const dpr = (): number => (browser ? Math.min(2, window.devicePixelRatio || 1) : 1);

/** A link's line as its state reads (pure; the link page, the arc diagram and the tests use it). */
export function linkLineState(l: Pick<LinkView, "state" | "requester" | "recipient"> & { notes?: { side: LinkSideName }[] }): LineSpec {
  const ended = !LINK_LIVE_STATES.includes(l.state);
  const sideOrb = (s: LinkSideView): LineOrb => (ended ? (s.kind ? "dim" : "dimhollow") : s.kind ? "awake" : "hollow");
  const left = sideOrb(l.requester);
  const right: LineOrb = l.state === "draft" ? "asleep" : l.state === "requested" ? "calling" : sideOrb(l.recipient);
  const flow: LineFlow = l.state === "draft" ? "flicker" : l.state === "requested" ? "trickle" : l.state === "open" ? "flow" : "stopped";
  const notes = l.notes ?? [];
  return { left, right, flow, notes: notes.length, last: notes.length ? notes[notes.length - 1].side : null };
}

/** The two-orb canvas (and, in the start card, a photo inside either orb). `faces` are pre-rendered avatars
 *  (people.ts `personChip`); both slots are always emitted, so the structure is the same whatever is picked. */
export function linkLine(spec: LineSpec, faces: { left?: string; right?: string } = {}): string {
  scheduleOrbs();
  const r = dpr();
  const rate = Math.max(0, Math.min(1, spec.rate ?? 0));
  const face = (side: "left" | "right", html: string | undefined) =>
    `<div class="cnpy-ll-face" data-ll-face="${side}"${html ? "" : " hidden"}>${html ?? ""}</div>`;
  return `<div class="cnpy-ll" data-ll-flow="${spec.flow}"><canvas class="cnpy-ll-cv" data-linkline data-ll-left="${spec.left}" data-ll-right="${spec.right}" data-ll-flow="${spec.flow}" data-ll-notes="${spec.notes ?? 0}" data-ll-last="${spec.last ?? ""}" data-ll-rate="${rate.toFixed(2)}" width="${Math.round(LINE_W * r)}" height="${Math.round(LINE_H * r)}" aria-hidden="true"></canvas>${face("left", faces.left)}${face("right", faces.right)}</div>`;
}

// ── the arc diagram (the top of the Links tab) ───────────────────────────────
// Your client kinds are stations along a gentle horizontal wave, your photo where the line starts on the left. A
// link between two of your sessions is an arc ABOVE the line between their stations (a small loop over a station
// when both sides are the same kind); a teammate sits BELOW, an arc dropping to them from the station that holds the
// link (or from your photo). links.ts `heroModel` places everything; the canvas only draws what it is told: orbs as
// `x,y,size,look`, segments as `link,a,b,flow,quiet,notes,last,count,shape` (a = the requester's end; shape u = an
// arc over the line, d = an arc down to a teammate, o = a loop), and the line as `data-lh-base="x0,x1,y"`.

export const HERO_W = 720;
export const HERO_H = 330;

export type HeroShape = "u" | "d" | "o";
export interface HeroOrb { x: number; y: number; size: number; look: LineOrb }
export interface HeroSeg { id: number; a: number; b: number; flow: LineFlow; quiet: boolean; notes: number; last: LinkSideName | null; n: number; shape: HeroShape }

/** The diagram's canvas. */
export function linkHeroCanvas(orbs: HeroOrb[], segs: HeroSeg[], base: readonly [number, number, number]): string {
  scheduleOrbs();
  const r = dpr();
  const o = orbs.map((x) => [Math.round(x.x), Math.round(x.y), x.size, x.look].join(",")).join(";");
  const g = segs.map((x) => [x.id, x.a, x.b, x.flow, x.quiet ? 1 : 0, x.notes, x.last ?? "", x.n, x.shape].join(",")).join(";");
  return `<canvas class="cnpy-lh-cv" data-linkhero data-lh-base="${base.map(Math.round).join(",")}" data-lh-orbs="${o}" data-lh-segs="${g}" width="${Math.round(HERO_W * r)}" height="${Math.round(HERO_H * r)}" aria-hidden="true"></canvas>`;
}

/** The canvas's attributes back into orbs and segments (the inverse of `linkHeroCanvas`). */
export function parseHero(orbsRaw: string, segsRaw: string): { orbs: HeroOrb[]; segs: HeroSeg[] } {
  const orbs = orbsRaw ? orbsRaw.split(";").map((p) => { const [x, y, size, look] = p.split(","); return { x: Number(x) || 0, y: Number(y) || 0, size: Number(size) || 40, look: pick(look, ORBS, "hollow") }; }) : [];
  const segs = segsRaw ? segsRaw.split(";").map((p) => {
    const [id, a, b, flow, quiet, notes, last, n, shape] = p.split(",");
    return {
      id: Number(id) || 0, a: Number(a) || 0, b: Number(b) || 0, flow: pick(flow, FLOWS, "none"), quiet: quiet === "1", notes: Number(notes) || 0,
      last: (last === "requester" || last === "recipient" ? last : null) as LinkSideName | null, n: Math.max(1, Number(n) || 1), shape: (shape === "d" || shape === "o" ? shape : "u") as HeroShape,
    };
  }).filter((g) => g.id > 0 && g.a < orbs.length && g.b < orbs.length) : [];
  return { orbs, segs };
}

// ── the engine: particles on a segment ───────────────────────────────────────

interface Particle {
  /** Progress 0..1 along the segment FROM its own end; `reach` is where it dies (a flicker stops short). */
  p: number; dir: 1 | -1; lane: number; speed: number; r: number; seed: number; a: number; reach: number; pulse: boolean;
}
/** One segment's moving parts: its particles, the spawn accumulators, the note count it last saw, a pulse clock. */
interface Seg { ps: Particle[]; accA: number; accB: number; notes: number | null; n: number; pulseT: number; lookB: LineOrb | null; lookA: LineOrb | null }
const newSeg = (): Seg => ({ ps: [], accA: 0, accB: 0, notes: null, n: 0, pulseT: 1.8, lookA: null, lookB: null });

const pick = <T extends string>(v: string | undefined, all: readonly T[], dflt: T): T => (all as readonly string[]).includes(v ?? "") ? (v as T) : dflt;
const ease = (x: number): number => x * x * (3 - 2 * x);
const smooth = (a: number, b: number, x: number): number => ease(Math.max(0, Math.min(1, (x - a) / (b - a))));

/** Per-end spawn rates (particles a second) and how they travel, by flow. A = the requester's end. */
function rates(flow: LineFlow, a: LineOrb, b: LineOrb, rate: number): { a: number; b: number; speed: [number, number]; reach: number } {
  const sends = (o: LineOrb) => (o === "awake" ? 1 : o === "hollow" ? 0.25 : 0);
  switch (flow) {
    case "flicker": return { a: 2.5, b: 0, speed: [0.1, 0.16], reach: 0.16 };
    case "trickle": return { a: 4.5, b: 0, speed: [0.12, 0.18], reach: 1 };
    case "flow": return { a: 1.5 + 13 * sends(a), b: 1.5 + 13 * sends(b), speed: [0.2, 0.3], reach: 1 };
    case "preview": return { a: 2 + 9 * rate, b: 0, speed: [0.16, 0.24], reach: 0.22 + 0.78 * rate };
    case "burst": return { a: 70, b: 0, speed: [0.75, 1.05], reach: 1 };
    case "pulse": return { a: 0.6, b: 0, speed: [0.12, 0.18], reach: 1 };
    default: return { a: 0, b: 0, speed: [0, 0], reach: 0 };
  }
}

function spawn(s: Seg, cap: number, dir: 1 | -1, speed: [number, number], reach: number, pulse = false, lane?: number): void {
  if (s.ps.length >= cap) return;
  const k = s.n++;
  const h1 = hashD(k, 1.3), h2 = hashD(k, 4.7), h3 = hashD(k, 9.1);
  // Two-way flows braid: requester → recipient rides a little to one side of the axis, the reply to the other.
  const ln = lane ?? (dir === 1 ? -1 + 1.25 * h1 : -0.25 + 1.25 * h1);
  s.ps.push({
    p: 0, dir, lane: ln, speed: speed[0] + (speed[1] - speed[0]) * h2, r: pulse ? 1.7 + 0.8 * h3 : 0.7 + 1.3 * h3,
    seed: h3, a: pulse ? 1 : 0.4 + 0.6 * h2, reach: Math.min(1, reach * (0.75 + 0.25 * h3)), pulse,
  });
}
const pulseCluster = (s: Seg, cap: number, dir: 1 | -1, n: number, speed: [number, number]) => {
  for (let i = 0; i < n; i++) spawn(s, cap, dir, speed, 1, true, (dir === 1 ? -0.35 : 0.35) + (hashD(s.n + i, 3.3) - 0.5) * 0.5);
};

/** Advance a segment by dt: spawn what the flow spawns, move, retire; returns which ends were reached by a pulse. */
function stepSeg(s: Seg, flow: LineFlow, a: LineOrb, b: LineOrb, rate: number, dt: number, cap: number, rateMul = 1): { hitA: number; hitB: number } {
  const r = rates(flow, a, b, rate);
  s.accA += r.a * rateMul * dt; s.accB += r.b * rateMul * dt;
  while (s.accA >= 1) { s.accA -= 1; spawn(s, cap, 1, r.speed, r.reach); }
  while (s.accB >= 1) { s.accB -= 1; spawn(s, cap, -1, r.speed, r.reach); }
  if (r.a === 0) s.accA = 0;
  if (r.b === 0) s.accB = 0;
  if (flow === "pulse") {
    s.pulseT += dt;
    if (s.pulseT >= 2.6) { s.pulseT = 0; pulseCluster(s, cap, 1, 10, [0.42, 0.5]); }
  }
  const fade = STILL_FLOWS.has(flow);
  let hitA = 0, hitB = 0;
  const next: Particle[] = [];
  for (const q of s.ps) {
    q.p += q.speed * dt;
    if (fade) q.a -= dt * 2.2;
    if (q.p >= q.reach || q.a <= 0.02) {
      if (q.p >= 1 && q.reach >= 1) {
        const bump = q.pulse ? 0.18 : flow === "burst" ? 0.03 : 0;
        if (q.dir === 1) hitB += bump; else hitA += bump;
      }
      continue;
    }
    next.push(q);
  }
  s.ps = next;
  return { hitA, hitB };
}

/** The still frame's particles: a fixed scatter that still shows which way the line runs. */
function stillParticles(flow: LineFlow, a: LineOrb, b: LineOrb, rate: number): Particle[] {
  const out: Particle[] = [];
  const add = (n: number, dir: 1 | -1, reach: number, alpha: number, pulse = false) => {
    for (let i = 0; i < n; i++) {
      const h = hashD(i + (dir === 1 ? 0 : 50), 2.2), g = hashD(i, 7.7);
      const lane = pulse ? (hashD(i, 3.3) - 0.5) * 0.5 : dir === 1 ? -1 + 1.25 * h : -0.25 + 1.25 * h;
      const p = pulse ? 0.5 + (g - 0.5) * 0.08 : Math.min(reach - 0.04, ((i + 0.5) / n) * reach);
      out.push({ p, dir, lane, speed: 0, r: pulse ? 1.8 : 0.7 + 0.9 * g, seed: g, a: alpha, reach, pulse });
    }
  };
  const r = rates(flow, a, b, rate);
  if (flow === "stopped") { add(9, 1, 1, 0.2); return out; }
  if (flow === "pulse") { add(8, 1, 1, 1, true); return out; }
  if (r.a > 0) add(Math.min(26, Math.max(3, Math.round(r.a * 3))), 1, r.reach, 0.85);
  if (r.b > 0) add(Math.min(26, Math.max(3, Math.round(r.b * 3))), -1, r.reach, 0.85);
  return out;
}

/** A point on a path at 0..1, with the unit normal there (lanes stray along it). */
type PathFn = (u: number) => [number, number];
function along(path: PathFn, u: number): [number, number, number, number] {
  const [x, y] = path(u);
  const [x2, y2] = path(Math.min(1, u + 0.01)), [x1, y1] = path(Math.max(0, u - 0.01));
  const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
  return [x, y, -dy / len, dx / len];
}
/** Draw a segment's particles along a path (0 = the requester's end), faded in and out at the ends. `amp` is how
 *  far a lane strays from the path. */
function drawPath(ctx: CanvasRenderingContext2D, ps: Particle[], t: number, path: PathFn, amp: number, rgb: readonly number[], dark: boolean): void {
  const boost = dark ? 1.35 : 1, grow = dark ? 1.18 : 1;
  for (const q of ps) {
    const pos = q.dir === 1 ? q.p : 1 - q.p;
    const arc = Math.sin(Math.PI * pos);
    const off = q.lane * amp * arc + Math.sin(t * 1.9 + q.seed * 6.283) * 1.6 * arc;
    const env = smooth(0, 0.07, q.p) * (1 - smooth(q.reach - (q.reach < 1 ? 0.12 : 0.06), q.reach, q.p));
    const a = Math.min(1, q.a * env * boost);
    if (a < 0.02) continue;
    const [x, y, nx, ny] = along(path, pos);
    ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;
    ctx.beginPath();
    ctx.arc(x + nx * off, y + ny * off, q.r * grow, 0, Math.PI * 2);
    ctx.fill();
  }
}
/** The same along a straight segment (the two-orb line). */
function drawSeg(ctx: CanvasRenderingContext2D, ps: Particle[], t: number, ax: number, ay: number, bx: number, by: number, amp: number, rgb: readonly number[], dark: boolean): void {
  drawPath(ctx, ps, t, (u) => [ax + (bx - ax) * u, ay + (by - ay) * u], amp, rgb, dark);
}
const cubic = (p0: number, p1: number, p2: number, p3: number, u: number): number => {
  const v = 1 - u;
  return v * v * v * p0 + 3 * v * v * u * p1 + 3 * v * u * u * p2 + u * u * u * p3;
};

// ── the orbs ─────────────────────────────────────────────────────────────────

/** A dotted ring, tilted in 3D and turning slowly: an orb with no session in it. */
function ring(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number, t: number, dark: boolean, bold: number): void {
  const R = size * 0.4;
  const pt = makeProj(t * 0.35, 1.05, cx, cy, 1);
  const dots: Dot[] = [];
  const n = Math.round(size * 0.52);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const [x, y, z] = pt(Math.cos(a) * R, 0, Math.sin(a) * R);
    const depth = (z / R + 1) / 2;
    dots.push({ x, y, z, r: (0.75 + 0.75 * depth) * bold, white: 0.5 - 0.35 * depth, a: 0.45 + 0.55 * depth });
  }
  paintDots(ctx, dots, dark, 0.3);
}

const ORB_MODE: Partial<Record<LineOrb, OrbState>> = { awake: "working", calling: "listening", seeking: "searching", dim: "working" };
/** The engine's 64px tunings, dots made a little bolder (bolder still on the dark theme). */
const bolded = new Map<string, ModeOpts>();
function boldOpts(state: OrbState, dark: boolean): { mode: ReturnType<typeof resolvePreset>["mode"]; speed: number; opts: ModeOpts } {
  const base = resolvePreset(state, 64);
  const key = `${state}-${dark}`;
  let opts = bolded.get(key);
  if (!opts) { opts = scaleRadii(base.opts, dark ? 1.45 : 1.22); bolded.set(key, opts); }
  return { mode: base.mode, speed: base.speed, opts };
}

function drawOrb(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number, o: LineOrb, t: number, still: boolean, flash: number, dark: boolean): void {
  const state = ORB_MODE[o];
  // ended orbs are a still frame at the orb engine's own still time; a ring breathes unless it is still.
  const tt = o === "dim" || o === "dimhollow" || still ? 0.6 : t;
  const alpha: Record<LineOrb, number> = {
    awake: 1, calling: 0.85, seeking: 0.75, named: 0.95, hollow: 0.55 + (still ? 0 : 0.12 * Math.sin(t * 1.6)), asleep: 0.24, dim: 0.28, dimhollow: 0.2,
    hub: 0,
  };
  if (o === "hub") return;
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha[o] * (dark ? 1.15 : 1) + 0.35 * flash));
  if (state) {
    const { mode, speed, opts } = boldOpts(state, dark);
    ctx.translate(cx - size / 2, cy - size / 2);
    MODE_DRAWS[mode](ctx, size, tt * speed, dark, opts);
  } else {
    ring(ctx, cx, cy, size, tt, dark, dark ? 1.35 : 1.1);
  }
  ctx.restore();
  if (flash > 0.01) {
    // A landing: one dotted ring that widens and fades round the orb.
    ctx.save();
    ctx.globalAlpha = 0.55 * flash;
    const R = size * (0.46 + 0.2 * (1 - flash));
    const dots: Dot[] = [];
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      dots.push({ x: cx + Math.cos(a) * R, y: cy + Math.sin(a) * R, z: 0, r: dark ? 1.2 : 0.9, white: 0.2 });
    }
    paintDots(ctx, dots, dark, 0.3);
    ctx.restore();
  }
}

// ── the painters ─────────────────────────────────────────────────────────────

/** Common frame set-up: size the backing store, clear, set the ink; null when the canvas cannot be drawn. */
function begin(c: HTMLCanvasElement, w: number, h: number): { ctx: CanvasRenderingContext2D; dark: boolean; ink: readonly [number, number, number] | null; rgb: readonly number[] } | null {
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const pxW = Math.round(w * ratio), pxH = Math.round(h * ratio);
  if (c.width !== pxW) c.width = pxW;
  if (c.height !== pxH) c.height = pxH;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  const dark = c.closest("[data-cnpy-theme]")?.getAttribute("data-cnpy-theme") === "dark";
  const ink = inkOf(c);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, w, h);
  setInk(ink);
  return { ctx, dark, ink, rgb: ink ?? (dark ? [230, 230, 230] : [40, 40, 40]) };
}
const offscreen = (c: HTMLCanvasElement): boolean => { const b = c.getBoundingClientRect(); return b.bottom < 0 || b.top > window.innerHeight; };
const lit = (o: LineOrb | null) => o === "awake" || o === "calling";

interface LineSim { seg: Seg; last: number; flashL: number; flashR: number; painted: string }
const lineSims = new WeakMap<HTMLCanvasElement, LineSim>();

function paintLine(c: HTMLCanvasElement, t: number, still: boolean): boolean {
  const d = c.dataset;
  const left = pick(d.llLeft, ORBS, "hollow");
  const right = pick(d.llRight, ORBS, "hollow");
  const flow = pick(d.llFlow, FLOWS, "none");
  const rate = Math.max(0, Math.min(1, Number(d.llRate) || 0));
  const notes = Number(d.llNotes) || 0;
  const lastSide = d.llLast === "requester" || d.llLast === "recipient" ? d.llLast : null;
  let s = lineSims.get(c);
  if (!s) { s = { seg: newSeg(), last: 0, flashL: 0, flashR: 0, painted: "" }; lineSims.set(c, s); }
  if (!still && offscreen(c)) { s.last = t; return true; }

  // What changed since the last frame: a note that landed (a pulse from its side), an orb that lit up (a flare).
  if (!still) {
    if (s.seg.notes !== null && notes > s.seg.notes && lastSide && (flow === "flow" || flow === "trickle")) pulseCluster(s.seg, MAX_PARTICLES, lastSide === "requester" ? 1 : -1, 16, [0.5, 0.56]);
    if (s.seg.lookB !== null && !lit(s.seg.lookB) && lit(right)) s.flashR = 1;
    if (s.seg.lookA !== null && !lit(s.seg.lookA) && lit(left)) s.flashL = 1;
  }
  s.seg.notes = notes; s.seg.lookA = left; s.seg.lookB = right;

  const moving = !still && (!STILL_FLOWS.has(flow) || s.seg.ps.length > 0 || !STILL_ORBS.has(left) || !STILL_ORBS.has(right) || s.flashL > 0.01 || s.flashR > 0.01);
  const ratioNow = Math.min(2, window.devicePixelRatio || 1);
  const dark0 = c.closest("[data-cnpy-theme]")?.getAttribute("data-cnpy-theme") === "dark";
  const look = `${left}|${right}|${flow}|${rate}|${ratioNow}|${dark0}|${inkOf(c)?.join(",") ?? ""}|${still}`;
  if (!moving && s.painted === look) return false;
  const f = begin(c, LINE_W, LINE_H);
  if (!f) return false;

  let ps: Particle[];
  if (still) ps = stillParticles(flow, left, right, rate);
  else {
    // A slow or paused frame (a busy page, a tab coming back) moves the stream at most a quarter second.
    const dt = s.last ? Math.max(0, Math.min(0.25, t - s.last)) : 0;
    s.last = t;
    const hit = stepSeg(s.seg, flow, left, right, rate, dt, MAX_PARTICLES);
    s.flashL = Math.max(0, Math.min(1, s.flashL + hit.hitA) - dt * 1.1);
    s.flashR = Math.max(0, Math.min(1, s.flashR + hit.hitB) - dt * 1.1);
    ps = s.seg.ps;
    if (flow === "stopped" && !ps.length) ps = stillParticles("stopped", left, right, rate);
  }
  drawOrb(f.ctx, CX_L, CY, ORB, left, t, still, still ? 0 : s.flashL, f.dark);
  drawOrb(f.ctx, CX_R, CY, ORB, right, t, still, still ? 0 : s.flashR, f.dark);
  drawSeg(f.ctx, ps, t, CX_L + 30, CY, CX_R - 30, CY, 18, f.rgb, f.dark);
  setInk(null);
  s.painted = look;
  return moving;
}

interface HeroSim { segs: Map<string, Seg>; flash: number[]; last: number; parsed: string; orbs: HeroOrb[]; list: HeroSeg[] }
const heroSims = new WeakMap<HTMLCanvasElement, HeroSim>();

/** The height of an arc over the line, by how far apart its two stations are. */
export const arcHeight = (span: number): number => 34 + 0.24 * span;

/** A segment's path, from its requester's end (`a`) to its recipient's (`b`). */
function heroPath(g: HeroSeg, A: HeroOrb, B: HeroOrb): PathFn {
  const rA = A.look === "hub" ? 15 : A.size * 0.38, rB = B.look === "hub" ? 15 : B.size * 0.38;
  if (g.shape === "o") {
    // A small loop over the station: from its top, round, and back.
    const R = 17, cx = A.x, cy = A.y - rA - R + 2;
    return (u) => [cx + Math.cos(Math.PI / 2 + u * Math.PI * 2) * R, cy + Math.sin(Math.PI / 2 + u * Math.PI * 2) * R];
  }
  if (g.shape === "u") {
    const h = arcHeight(Math.abs(B.x - A.x));
    const x0 = A.x, y0 = A.y - rA, x3 = B.x, y3 = B.y - rB;
    return (u) => [cubic(x0, x0, x3, x3, u), cubic(y0, y0 - h, y3 - h, y3, u)];
  }
  // Down to a teammate: from the upper orb's lower shoulder, out and down to the top of the lower one.
  const upperIsA = A.y <= B.y;
  const U = upperIsA ? A : B, L = upperIsA ? B : A;
  const rU = upperIsA ? rA : rB, rL = upperIsA ? rB : rA;
  const side = Math.sign(L.x - U.x) || 1;
  const x0 = U.x + side * rU * 0.75, y0 = U.y + rU * 0.7, x3 = L.x, y3 = L.y - rL;
  const down: PathFn = (u) => [cubic(x0, x0 + side * 34, x3, x3, u), cubic(y0, y0 + 46, y3 - 52, y3, u)];
  return upperIsA ? down : (u) => down(1 - u);
}

function paintHero(c: HTMLCanvasElement, t: number, still: boolean): boolean {
  let s = heroSims.get(c);
  if (!s) { s = { segs: new Map(), flash: [], last: 0, parsed: "", orbs: [], list: [] }; heroSims.set(c, s); }
  const raw = `${c.dataset.lhOrbs ?? ""}|${c.dataset.lhSegs ?? ""}`;
  if (raw !== s.parsed) { const h = parseHero(c.dataset.lhOrbs ?? "", c.dataset.lhSegs ?? ""); s.orbs = h.orbs; s.list = h.segs; s.parsed = raw; }
  if (!still && offscreen(c)) { s.last = t; return true; }
  const dt = !still && s.last ? Math.max(0, Math.min(0.25, t - s.last)) : 0;
  if (!still) s.last = t;
  const f = begin(c, HERO_W, HERO_H);
  if (!f) return false;
  const { orbs, list } = s;
  const cap = Math.max(24, Math.floor(MAX_PARTICLES / Math.max(1, list.length)));
  while (s.flash.length < orbs.length) s.flash.push(0);

  // The line: a faint dotted wave from your photo along the stations, its phase drifting slowly.
  const [bx0, bx1, by] = (c.dataset.lhBase ?? "").split(",").map(Number);
  if (bx1 > bx0) {
    const ph = still ? 0 : t * 0.5;
    f.ctx.fillStyle = `rgba(${f.rgb[0]},${f.rgb[1]},${f.rgb[2]},${f.dark ? 0.32 : 0.22})`;
    for (let x = bx0; x <= bx1; x += 7) {
      const fade = Math.min(1, (bx1 - x) / 60);
      f.ctx.globalAlpha = fade;
      f.ctx.beginPath();
      f.ctx.arc(x, by + Math.sin(x / 46 + ph) * 3, f.dark ? 1.05 : 0.9, 0, Math.PI * 2);
      f.ctx.fill();
    }
    f.ctx.globalAlpha = 1;
  }
  // Nothing linked: a quiet halo round your photo.
  if (!list.length && orbs[0]) ring(f.ctx, orbs[0].x, orbs[0].y, 110, still ? 0.6 : t * 0.6, f.dark, f.dark ? 1.2 : 1);

  const seen = new Set<string>();
  for (const g of [...list].sort((x, y) => Number(y.quiet) - Number(x.quiet))) {
    const A = orbs[g.a], B = orbs[g.b];
    const key = `${g.id}:${g.a}:${g.b}:${g.shape}`;
    seen.add(key);
    const la = A.look === "hub" ? "hollow" : A.look, lb = B.look === "hub" ? "hollow" : B.look;
    let seg = s.segs.get(key);
    if (!seg) { seg = newSeg(); s.segs.set(key, seg); }
    let ps: Particle[];
    if (still) ps = stillParticles(g.flow, la, lb, 0);
    else {
      if (seg.notes !== null && g.notes > seg.notes && g.last && (g.flow === "flow" || g.flow === "trickle")) pulseCluster(seg, cap, g.last === "requester" ? 1 : -1, 12, [0.5, 0.58]);
      seg.notes = g.notes;
      const more = 1 + 0.5 * (g.n - 1);
      const hit = stepSeg(seg, g.flow, la, lb, 0, dt, cap, (g.quiet ? 0.45 : g.shape === "o" ? 0.6 : 1.1) * more);
      s.flash[g.a] = Math.min(1, s.flash[g.a] + hit.hitA);
      s.flash[g.b] = Math.min(1, s.flash[g.b] + hit.hitB);
      ps = seg.ps;
      if (g.flow === "stopped" && !ps.length) ps = stillParticles("stopped", la, lb, 0);
    }
    f.ctx.save();
    if (g.quiet) f.ctx.globalAlpha = 0.55;
    drawPath(f.ctx, ps, t, heroPath(g, A, B), g.shape === "o" ? 3 : g.quiet ? 5 : 8, f.rgb, f.dark);
    f.ctx.restore();
  }
  for (const k of [...s.segs.keys()]) if (!seen.has(k)) s.segs.delete(k);
  orbs.forEach((o, i) => {
    drawOrb(f.ctx, o.x, o.y, o.size, o.look, t, still, still ? 0 : s.flash[i] ?? 0, f.dark);
    if (!still) s.flash[i] = Math.max(0, (s.flash[i] ?? 0) - dt * 1.1);
  });
  setInk(null);
  return !still;
}

addOrbPainter({ selector: "canvas[data-linkline]", paint: paintLine });
addOrbPainter({ selector: "canvas[data-linkhero]", paint: paintHero });

// The link line — orbs and the particles between them (Relay › Links: the constellation at the top of the tab, the
// "Start a link" card and the head of a link's page; docs/architecture/handoffs-prompts.md › Agent links › Web).
// It is decoration: every canvas is aria-hidden, and the words around it (each side's person and session, the
// state's mark, the hit areas' labels) carry every meaning — the picture only shows the same thing moving.
//
//   the markup   `linkLine(spec)` (two orbs: the requester's on the LEFT, the recipient's on the RIGHT) and
//                `linkHeroCanvas(nodes)` (YOU in the centre, a line out to each live link's other person). Each is a
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
// the constellation adds `pulse` (a request waiting for YOU: a cluster travels inward every few seconds).

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
export type LineOrb = "awake" | "hollow" | "calling" | "asleep" | "seeking" | "named" | "dim" | "dimhollow";
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

const ORBS: readonly LineOrb[] = ["awake", "hollow", "calling", "asleep", "seeking", "named", "dim", "dimhollow"];
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

/** A link's line as its state reads (pure; the link page, the constellation and the tests use it). */
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

// ── the constellation (the top of the Links tab) ─────────────────────────────
// You in the centre; each live link a line out to the other person's orb, in one of HERO_SLOTS (filled in link
// order, so a new link takes the next free place and nothing already there moves).

export const HERO_W = 600;
export const HERO_H = 300;
const HERO_CX = HERO_W / 2;
const HERO_CY = HERO_H / 2;
const HERO_ME = 104;
const HERO_NODE = 72;
/** The places round you, as [x, y] in canvas px: right, left, then the four diagonals, then the two farther out. */
export const HERO_SLOTS: readonly (readonly [number, number])[] = [
  [516, 120], [84, 180], [446, 228], [154, 72], [446, 64], [154, 236], [560, 214], [40, 86],
];
export const HERO_MAX = HERO_SLOTS.length;

/** One line of the constellation: the link's number, its place, the other orb's look, what flows, and which way.
 *  `out`: the line runs from you (you are the requester); else from them. `mine`: your end's look — a hollow ring
 *  sits where the line meets you when your side has no session. `last` is whose side wrote the newest note. */
export interface HeroNode {
  id: number; slot: number; look: LineOrb; flow: LineFlow; out: boolean; mine: LineOrb; notes: number; last: LinkSideName | null;
}

/** The constellation's canvas. Nodes go in `data-lh` as `id,slot,look,flow,out,mine,notes,last;…`. */
export function linkHeroCanvas(nodes: HeroNode[]): string {
  scheduleOrbs();
  const r = dpr();
  const data = nodes.map((n) => [n.id, n.slot, n.look, n.flow, n.out ? 1 : 0, n.mine, n.notes, n.last ?? ""].join(",")).join(";");
  return `<canvas class="cnpy-lh-cv" data-linkhero data-lh="${data}" width="${Math.round(HERO_W * r)}" height="${Math.round(HERO_H * r)}" aria-hidden="true"></canvas>`;
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

/** Draw a segment's particles between (ax, ay) and (bx, by): a gentle bow off the axis, faded in and out at the
 *  ends. `amp` is how far a lane strays from the axis. */
function drawSeg(ctx: CanvasRenderingContext2D, ps: Particle[], t: number, ax: number, ay: number, bx: number, by: number, amp: number, rgb: readonly number[], dark: boolean): void {
  const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;
  const boost = dark ? 1.35 : 1, grow = dark ? 1.18 : 1;
  for (const q of ps) {
    const pos = q.dir === 1 ? q.p : 1 - q.p;
    const arc = Math.sin(Math.PI * pos);
    const off = q.lane * amp * arc + Math.sin(t * 1.9 + q.seed * 6.283) * 1.6 * arc;
    const env = smooth(0, 0.07, q.p) * (1 - smooth(q.reach - (q.reach < 1 ? 0.12 : 0.06), q.reach, q.p));
    const a = Math.min(1, q.a * env * boost);
    if (a < 0.02) continue;
    ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;
    ctx.beginPath();
    ctx.arc(ax + dx * pos + nx * off, ay + dy * pos + ny * off, q.r * grow, 0, Math.PI * 2);
    ctx.fill();
  }
}

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
  };
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

/** A small hollow socket where a line meets an orb whose side has no session yet (the constellation's centre). */
function socket(ctx: CanvasRenderingContext2D, x: number, y: number, rgb: readonly number[], dark: boolean): void {
  ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${dark ? 0.7 : 0.55})`;
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(x + Math.cos(a) * 5, y + Math.sin(a) * 5, dark ? 0.9 : 0.75, 0, Math.PI * 2);
    ctx.fill();
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

interface HeroSim { segs: Map<number, Seg>; flash: Map<number, number>; last: number; painted: string; parsed: string; nodes: HeroNode[] }
const heroSims = new WeakMap<HTMLCanvasElement, HeroSim>();

/** The `data-lh` string back into nodes (the inverse of `linkHeroCanvas`). */
export function parseHeroNodes(raw: string): HeroNode[] {
  if (!raw) return [];
  return raw.split(";").map((part) => {
    const [id, slot, look, flow, out, mine, notes, last] = part.split(",");
    return {
      id: Number(id) || 0, slot: Math.max(0, Math.min(HERO_MAX - 1, Number(slot) || 0)), look: pick(look, ORBS, "hollow"), flow: pick(flow, FLOWS, "none"),
      out: out === "1", mine: pick(mine, ORBS, "awake"), notes: Number(notes) || 0, last: (last === "requester" || last === "recipient" ? last : null) as LinkSideName | null,
    };
  }).filter((n) => n.id > 0);
}

function paintHero(c: HTMLCanvasElement, t: number, still: boolean): boolean {
  let s = heroSims.get(c);
  if (!s) { s = { segs: new Map(), flash: new Map(), last: 0, painted: "", parsed: "", nodes: [] }; heroSims.set(c, s); }
  const raw = c.dataset.lh ?? "";
  if (raw !== s.parsed) { s.nodes = parseHeroNodes(raw); s.parsed = raw; }
  if (!still && offscreen(c)) { s.last = t; return true; }
  const nodes = s.nodes;
  const dt = !still && s.last ? Math.max(0, Math.min(0.25, t - s.last)) : 0;
  if (!still) s.last = t;
  const f = begin(c, HERO_W, HERO_H);
  if (!f) return false;
  const cap = Math.max(24, Math.floor(MAX_PARTICLES / Math.max(1, nodes.length)));

  // You: a quiet halo when there is nothing to link to; awake otherwise.
  if (!nodes.length) {
    ring(f.ctx, HERO_CX, HERO_CY, HERO_ME * 1.5, still ? 0.6 : t * 0.6, f.dark, f.dark ? 1.2 : 1);
  }
  drawOrb(f.ctx, HERO_CX, HERO_CY, HERO_ME, "awake", t, still, still ? 0 : (s.flash.get(0) ?? 0), f.dark);

  const seen = new Set<number>();
  for (const n of nodes) {
    seen.add(n.id);
    const [nx, ny] = HERO_SLOTS[n.slot];
    // The segment runs requester → recipient: from you when `out`, else from them.
    const len = Math.hypot(nx - HERO_CX, ny - HERO_CY) || 1;
    const ux = (nx - HERO_CX) / len, uy = (ny - HERO_CY) / len;
    const meX = HERO_CX + ux * HERO_ME * 0.36, meY = HERO_CY + uy * HERO_ME * 0.36;
    const thX = nx - ux * HERO_NODE * 0.36, thY = ny - uy * HERO_NODE * 0.36;
    const [ax, ay, bx, by] = n.out ? [meX, meY, thX, thY] : [thX, thY, meX, meY];
    const a = n.out ? n.mine : n.look, b = n.out ? n.look : n.mine;
    let seg = s.segs.get(n.id);
    if (!seg) { seg = newSeg(); s.segs.set(n.id, seg); }
    let ps: Particle[];
    if (still) ps = stillParticles(n.flow, a, b, 0);
    else {
      if (seg.notes !== null && n.notes > seg.notes && n.last && (n.flow === "flow" || n.flow === "trickle")) pulseCluster(seg, cap, n.last === "requester" ? 1 : -1, 12, [0.55, 0.62]);
      if (seg.lookB !== null && !lit(seg.lookB) && lit(n.look)) s.flash.set(n.id, 1);
      seg.notes = n.notes; seg.lookB = n.look;
      const hit = stepSeg(seg, n.flow, a, b, 0, dt, cap, 0.7);
      const toThem = n.out ? hit.hitB : hit.hitA, toMe = n.out ? hit.hitA : hit.hitB;
      s.flash.set(n.id, Math.max(0, Math.min(1, (s.flash.get(n.id) ?? 0) + toThem) - dt * 1.1));
      s.flash.set(0, Math.max(0, Math.min(1, (s.flash.get(0) ?? 0) + toMe * 0.5) - dt * 1.1));
      ps = seg.ps;
      if (n.flow === "stopped" && !ps.length) ps = stillParticles("stopped", a, b, 0);
    }
    drawOrb(f.ctx, nx, ny, HERO_NODE, n.look, t, still, still ? 0 : (s.flash.get(n.id) ?? 0), f.dark);
    if (n.mine === "hollow") socket(f.ctx, meX, meY, f.rgb, f.dark);
    drawSeg(f.ctx, ps, t, ax, ay, bx, by, 9, f.rgb, f.dark);
  }
  for (const id of [...s.segs.keys()]) if (!seen.has(id)) s.segs.delete(id);
  setInk(null);
  // You are always awake: the constellation moves while it is on screen (and stops under reduced motion).
  return !still;
}

addOrbPainter({ selector: "canvas[data-linkline]", paint: paintLine });
addOrbPainter({ selector: "canvas[data-linkhero]", paint: paintHero });

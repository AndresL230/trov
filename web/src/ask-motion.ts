// Ask Trov — motion (FOUNDATION). Every Ask part moves through THESE hooks, built on the app's own motion system
// (docs/architecture/web-ui.md › "Sidebar & motion", "A row leaving a list", "Loading skeletons"; the `--fx-*` clock
// on :root). Two rules hold everywhere: nothing replays on a rerender, and all of it is off under
// `prefers-reduced-motion`. The page is `data-morph="ask"`, so an element whose key does not change is PATCHED, never
// re-inserted — which is what makes rules 1–2 below play exactly once.
//
//   1. ENTRANCE of an element: a CSS animation on its class (trov.css `/* ── Ask: … ── */`), which plays when the
//      element is INSERTED. To make a thing enter again when it becomes another thing, give it a different
//      `data-morph-key` (morph then replaces it). The screen itself enters with the app's `[data-enter]`
//      (main.ts `markEnter`; `.cnpy-rise` + `--i` for staggered pieces) — once per arrival at Ask, never per thread
//      (hash.ts `pageKey` leaves the thread out).
//   2. NEW CHILDREN of a keyed list: put `data-morph-list` + `data-ask-enter="rise" | "fade" | "pop"` on the container
//      and a `data-morph-key` on every child. `askEnterNew` (run after every paint) animates ONLY children whose key
//      that container has not shown before; a container's first paint animates nothing (it arrived with its parent,
//      or replaced a skeleton — which gets the skeleton's settle fade instead). Used by: the messages, an answer's
//      parts (streamed blocks), activity steps, thread rows. Web Animations, so no class for morph to strip.
//   3. EXIT: state says it is leaving. `ctx.exit(key, apply)` sets `ui.closing[key]`, the renderer emits
//      `data-closing` (see `closingAttr`), CSS plays the out animation / transition, and after `ASK_FX.exit` ms
//      `apply()` runs (the state change that removes it) and the flag goes. Reduced motion: `apply()` at once.
//      `ctx.cancelExit(key)` keeps it (a hover card hovered again). Keys in use: "inspector", "cmdj", "hover",
//      "menu" (any open menu or picker), "drawer", "plus", `th:<id>` (a deleted thread's row). A part adds its own.
//   4. HEIGHT TWEEN: `data-ask-tween` on an element whose CONTENT is swapped (an action card collapsing to its done /
//      cancelled line, a save form to its saved line): `askTweenHeights` animates its height from the last paint's to
//      this paint's, so the conversation under it glides instead of jumping. Heights are NATURAL ones (a glide's own
//      height is never read as the content's): a paint mid-glide with the same target leaves the glide running.
//      `askHoldScroll` (before the paint) / `askKeepScroll` (after the glides start) undo the clamp the measuring
//      layout puts on a scroller near its end, so a shrinking card never jumps the view.
//   5. SKELETON → CONTENT: skeleton.ts `skeleton(key, …)` for anything still being read (the thread list, a thread);
//      main.ts `syncSkeletons` gives what replaces it the settle fade.
//   8. THE COMPOSER'S PLACE: `data-ask-dock="center" | "dock"` on the composer; `askGlideDock` glides it between the
//      empty conversation's centre and its docked foot when that flips (below).
//   6. SMOOTH OPEN / CLOSE of the columns: the thread list's width and the inspector's margin are CSS transitions /
//      keyframes on attributes the shell sets (`data-threads`, `data-closing`, `data-dragging`), in trov.css.
//   7. THE BOTTOM: only the CONVERSATION moves the view (the owner): an answer streaming, a message sent, an answer
//      finishing EASE a scroller (`data-ask-scroll`) to its bottom frame by frame (no line-by-line jumps); a thread
//      opening or its history landing JUMPS there. What a person opens themselves (Wrong?, the sources, a step's
//      results) never moves it — the new rows push down. The controller decides per paint (`AskBottomMove`) and
//      `askFollowBottom` runs LAST, after rules 2 and 4 started their animations. All of it only while `stick` holds:
//      the conversation part's `stickAfterScroll` — a person scrolling UP lets go, back at the bottom holds on.

/** The app's motion clock in ms (trov.css `:root` `--fx-fast` / `--fx-base` / `--fx-slow`), and the exit's wait. */
export const ASK_FX = { fast: 180, base: 240, slow: 300, exit: 200 } as const;
/** The app's curves: `--fx-ease`, and the entrance's rise (`[data-enter] .cnpy-rise`). */
export const ASK_EASE = { fx: "cubic-bezier(0.4, 0, 0.2, 1)", rise: "cubic-bezier(.2,.7,.2,1)", pop: "cubic-bezier(.2,.9,.3,1.2)" } as const;

export type AskEnterKind = "rise" | "fade" | "pop";
const ENTER: Record<AskEnterKind, { frames: Keyframe[]; ms: number; easing: string }> = {
  rise: { frames: [{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }], ms: 360, easing: ASK_EASE.rise },
  fade: { frames: [{ opacity: 0 }, { opacity: 1 }], ms: ASK_FX.base, easing: ASK_EASE.fx },
  pop: { frames: [{ opacity: 0, transform: "scale(.96)" }, { opacity: 1, transform: "none" }], ms: 160, easing: ASK_EASE.pop },
};

/** The person asked for less motion (false where there is no window: tests, the build). */
export function reducedMotion(): boolean {
  try { return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
}

/** ` data-closing="1"` while `key` is leaving, else "" (renderers add it to the element that animates out). */
export const closingAttr = (closing: Record<string, true>, key: string): string => (closing[key] ? ` data-closing="1"` : "");

const seen = new WeakMap<Element, Set<string>>();
const keysOf = (el: Element): string[] => Array.from(el.children).map((c) => c.getAttribute("data-morph-key") ?? "").filter(Boolean);

/** Rule 2: animate the children new to each `[data-ask-enter]` list under `root`. Returns how many it animated. */
export function askEnterNew(root: ParentNode, reduce = reducedMotion()): number {
  let n = 0;
  for (const list of Array.from(root.querySelectorAll<HTMLElement>("[data-ask-enter]"))) {
    const keys = keysOf(list);
    const before = seen.get(list);
    seen.set(list, new Set(keys));
    if (!before || reduce) continue;
    const kind = (list.getAttribute("data-ask-enter") as AskEnterKind) in ENTER ? (list.getAttribute("data-ask-enter") as AskEnterKind) : "rise";
    const fx = ENTER[kind];
    let i = 0;
    for (const child of Array.from(list.children)) {
      const k = child.getAttribute("data-morph-key");
      if (!k || before.has(k) || typeof (child as HTMLElement).animate !== "function") continue;
      // Several at once (a batch of rows) step 28ms apart, like `.cnpy-stagger`.
      (child as HTMLElement).animate(fx.frames, { duration: fx.ms, easing: fx.easing, delay: Math.min(i++, 8) * 28, fill: "backwards" });
      n++;
    }
  }
  return n;
}

const docks = new WeakMap<Element, { top: number; at: string }>();
/** Rule 8: the composer's place. It sits centred under an empty conversation (the design's `live`) and docks at the
 *  foot once the first question is sent; when its `data-ask-dock` flips (either way: a new or re-opened empty thread
 *  centres it again) it GLIDES from where it was to where it is, on the app's clock. Reduced motion: it just moves. */
export function askGlideDock(root: ParentNode, reduce = reducedMotion()): number {
  let n = 0;
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("[data-ask-dock]"))) {
    const at = el.getAttribute("data-ask-dock") ?? "";
    const top = el.getBoundingClientRect().top;
    const was = docks.get(el);
    docks.set(el, { top, at });
    if (!was || was.at === at || reduce || Math.abs(was.top - top) < 2 || typeof el.animate !== "function") continue;
    el.animate([{ transform: `translateY(${Math.round(was.top - top)}px)` }, { transform: "none" }], { duration: ASK_FX.slow, easing: ASK_EASE.fx });
    n++;
  }
  return n;
}

/** Rule 4's decision for one element: the height its glide starts from, or null for no new glide. `was` is the height
 *  it settled to at the last paint (its NATURAL height then — never a mid-glide one), `now` its natural height this
 *  paint, `shown` the height on screen this instant (mid-glide; null when nothing runs). The same target is no new
 *  glide: a paint mid-glide (the confirm's own paints, every streamed word) leaves the running one alone. A new target
 *  starts from where the eye is, not from where the last glide began. */
export function tweenStart(was: number | undefined, now: number, shown: number | null): number | null {
  if (was === undefined || Math.abs(was - now) < 2) return null;
  const from = shown ?? was;
  return Math.abs(from - now) < 2 ? null : from;
}

const heights = new WeakMap<Element, number>();
const tweens = new WeakMap<Element, Animation>();
const runningTween = (el: Element): Animation | null => {
  const an = tweens.get(el);
  return an && an.playState === "running" ? an : null;
};
/** Rule 4: tween each `[data-ask-tween]` element's height from the last paint's to this one's.
 *
 *  Its heights are NATURAL heights. A glide animates `height`, so an element's offsetHeight mid-glide is the glide's,
 *  not its content's: reading that as "this paint's height" (as this once did) made every paint during a glide — the
 *  Confirm's second paint, a toast, each streamed word — start a glide BACK towards the old height, and the card under
 *  a Confirm swung between its old and new heights for as long as the answer was writing (measured: 48 ↔ 336px, the
 *  text under it jumping ~290px a frame). So the running glides are stepped past their end for the measurement (no
 *  effect: the content's own height) and put back, all within this task. */
export function askTweenHeights(root: ParentNode, reduce = reducedMotion()): number {
  const els = Array.from(root.querySelectorAll<HTMLElement>("[data-ask-tween]"));
  // Where each running glide has it now (nested glides: an outer one's height includes the inner one's).
  const shown = els.map((el) => (runningTween(el) ? el.offsetHeight : null));
  const live = els.map(runningTween).filter((an): an is Animation => an !== null);
  const at = live.map((an) => an.currentTime);
  for (const an of live) an.currentTime = ASK_FX.base + 1;
  const natural = els.map((el) => el.offsetHeight);
  live.forEach((an, i) => { an.currentTime = at[i]; });
  let n = 0;
  els.forEach((el, i) => {
    const h = natural[i];
    const was = heights.get(el);
    heights.set(el, h);
    if (reduce) { runningTween(el)?.cancel(); return; }
    const from = tweenStart(was, h, shown[i]);
    if (from === null || typeof el.animate !== "function") return;
    runningTween(el)?.cancel();
    // `clip`, not `hidden`: hidden makes the box a block formatting context, so its first child's top margin (the
    // footer's 8px) stopped collapsing through it for the glide and the row snapped up 8px when the glide ended. And
    // only the Y axis: clipping X cut what overhangs the column's left edge (the footer's mark, a step's hover
    // background) for the glide and showed it again after.
    const an = el.animate([{ height: `${from}px`, overflowY: "clip" }, { height: `${h}px`, overflowY: "clip" }], { duration: ASK_FX.base, easing: ASK_EASE.fx });
    if (an) tweens.set(el, an);
    n++;
  });
  return n;
}

const tops = new WeakMap<Element, number>();
/** Before a paint: where each `[data-ask-scroll]` is (main.ts `rerender`, the ⌘J panel's own repaint). */
export function askHoldScroll(root: ParentNode): void {
  for (const sc of Array.from(root.querySelectorAll<HTMLElement>("[data-ask-scroll]"))) tops.set(sc, sc.scrollTop);
}
/** After a paint, once its glides started (rule 4) and before the bottom (rule 7): a scroller this paint pulled UP
 *  goes back to where it was. A swapped card is shorter for the one layout that measures it, before its glide holds
 *  the old height again, and a scroller near its end is clamped up at that instant — the view jumped by the whole
 *  difference (measured: 143px in a frame) and the clamp's scroll event let go of `stick`, so the answer still writing
 *  stopped being followed. Put back, the browser clamps it only as the glide really shrinks the conversation. A paint
 *  never moves a view up on purpose (a thread opening jumps DOWN, after this). Returns how many it put back. */
export function askKeepScroll(root: ParentNode): number {
  let n = 0;
  for (const sc of Array.from(root.querySelectorAll<HTMLElement>("[data-ask-scroll]"))) {
    const was = tops.get(sc);
    tops.delete(sc);
    if (was === undefined || sc.scrollTop >= was - 0.5) continue;
    sc.scrollTop = was;
    n++;
  }
  return n;
}

/** Within this many px of the end a scroller counts as AT its bottom (sub-pixel layout, a rounding scrollTop). */
export const ASK_BOTTOM_SLACK = 4;

/** Rule 7's `stick` after a scroll event: a person scrolling UP (the top went down and the bottom is out of reach)
 *  lets go; reaching the bottom again holds on; anything else keeps it. A glide shrinking the conversation clamps the
 *  top down too, but it lands AT the bottom, so it never lets go — and the pins' own scrolls only ever go down. */
export function stickAfterScroll(stick: boolean, prevTop: number, s: { top: number; height: number; client: number }): boolean {
  if (s.height - s.top - s.client <= ASK_BOTTOM_SLACK) return true;
  if (s.top < prevTop) return false;
  return stick;
}

/** A Web Animation (`Animation`: rule 2's entrances, rule 4's glides) still running under `el` — not a CSS one (the
 *  cursor's blink never ends). */
const gliding = (el: Element): boolean =>
  typeof Animation === "function" && el.getAnimations({ subtree: true }).some((an) => an.constructor === Animation && an.playState === "running");

/** How a scroller reaches its bottom this paint: at once (a thread opened, its history landed), easing (the
 *  conversation grew: an answer streams, a message was sent, an answer finished), or not at all. */
export type AskBottomMove = "jump" | "ease" | null;
/** The ease: each frame covers `1 - e^(-dt/BOTTOM_TAU)` of the way, so a line of streamed text glides in. */
const BOTTOM_TAU = 110;
/** Keep easing this long after the last paint that asked (the gaps between streamed frames). */
const BOTTOM_HOLD = 450;
const easing = new WeakMap<Element, { until: number; last: number }>();

/** Rule 7: bring each `[data-ask-scroll]` under `root` to its bottom as `move(scroller)` says, and keep easing it
 *  there while the conversation grows or a glide runs, as long as `stick()` holds (a person scrolling up lets go).
 *  Run AFTER `askEnterNew` / `askTweenHeights` in the same paint. Returns how many it moved. */
export function askFollowBottom(root: ParentNode, move: (sc: HTMLElement) => AskBottomMove, stick: () => boolean, reduce = reducedMotion()): number {
  let n = 0;
  for (const sc of Array.from(root.querySelectorAll<HTMLElement>("[data-ask-scroll]"))) {
    const m = move(sc);
    if (!m) continue;
    n++;
    if (m === "jump" || reduce || typeof requestAnimationFrame !== "function" || typeof sc.getAnimations !== "function") {
      sc.scrollTop = sc.scrollHeight;
      continue;
    }
    const now = performance.now();
    const st = easing.get(sc);
    if (st) { st.until = now + BOTTOM_HOLD; continue; }
    const state = { until: now + BOTTOM_HOLD, last: now };
    easing.set(sc, state);
    const step = (): void => {
      if (!sc.isConnected || !stick()) { easing.delete(sc); return; }
      const t = performance.now();
      const dt = Math.min(Math.max(t - state.last, 0), 64);
      state.last = t;
      const gap = sc.scrollHeight - sc.clientHeight - sc.scrollTop;
      if (gap > 0.5) sc.scrollTop += Math.max(1, gap * (1 - Math.exp(-dt / BOTTOM_TAU)));
      if (t < state.until || gap > 0.5 || gliding(sc)) requestAnimationFrame(step);
      else easing.delete(sc);
    };
    requestAnimationFrame(step);
  }
  return n;
}

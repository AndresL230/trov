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
//      this paint's, so the conversation under it glides instead of jumping.
//   5. SKELETON → CONTENT: skeleton.ts `skeleton(key, …)` for anything still being read (the thread list, a thread);
//      main.ts `syncSkeletons` gives what replaces it the settle fade.
//   8. THE COMPOSER'S PLACE: `data-ask-dock="center" | "dock"` on the composer; `askGlideDock` glides it between the
//      empty conversation's centre and its docked foot when that flips (below).
//   6. SMOOTH OPEN / CLOSE of the columns: the thread list's width and the inspector's margin are CSS transitions /
//      keyframes on attributes the shell sets (`data-threads`, `data-closing`, `data-dragging`), in trov.css.
//   7. THE BOTTOM: a conversation scroller (`data-ask-scroll`) stays at its bottom while `stick` holds (an answer
//      streams, a footer opens Wrong? or its sources). `askFollowBottom` runs LAST in a paint — after rules 2 and 4
//      started their animations, so the height it reads is the glide's FIRST frame, not its last — and then follows
//      the bottom frame by frame while a glide runs in the scroller. Pinning before the glides started is what
//      jumped the thread: pinned to the final height, then the glide restored the old one under it. `stick` is the
//      conversation part's (`stickAfterScroll`): only a person scrolling UP clears it; back at the bottom sets it.

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

const heights = new WeakMap<Element, number>();
/** Rule 4: tween each `[data-ask-tween]` element's height from the last paint's to this one's. */
export function askTweenHeights(root: ParentNode, reduce = reducedMotion()): number {
  let n = 0;
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("[data-ask-tween]"))) {
    const h = el.offsetHeight;
    const was = heights.get(el);
    heights.set(el, h);
    if (was === undefined || reduce || Math.abs(was - h) < 2 || typeof el.animate !== "function") continue;
    // `clip`, not `hidden`: hidden makes the box a block formatting context, so its first child's top margin (the
    // footer's 8px) stopped collapsing through it for the glide and the row snapped up 8px when the glide ended.
    el.animate([{ height: `${was}px`, overflow: "clip" }, { height: `${h}px`, overflow: "clip" }], { duration: ASK_FX.base, easing: ASK_EASE.fx });
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

const following = new WeakSet<Element>();
/** A Web Animation (`Animation`: rule 2's entrances, rule 4's glides) still running under `el` — not a CSS one (the
 *  cursor's blink never ends). */
const gliding = (el: Element): boolean =>
  typeof Animation === "function" && el.getAnimations({ subtree: true }).some((an) => an.constructor === Animation && an.playState === "running");
/** Rule 7: pin each `[data-ask-scroll]` under `root` to its bottom while `stick(scroller)`, and keep following it
 *  while a glide runs in it. Run AFTER `askEnterNew` / `askTweenHeights` in the same paint. Returns how many it pinned. */
export function askFollowBottom(root: ParentNode, stick: (sc: HTMLElement) => boolean, reduce = reducedMotion()): number {
  let n = 0;
  for (const sc of Array.from(root.querySelectorAll<HTMLElement>("[data-ask-scroll]"))) {
    if (!stick(sc)) continue;
    sc.scrollTop = sc.scrollHeight;
    n++;
    if (reduce || following.has(sc) || typeof requestAnimationFrame !== "function" || typeof sc.getAnimations !== "function") continue;
    following.add(sc);
    const follow = (): void => {
      if (!sc.isConnected) { following.delete(sc); return; }
      if (stick(sc)) sc.scrollTop = sc.scrollHeight;
      if (stick(sc) && gliding(sc)) requestAnimationFrame(follow);
      else following.delete(sc);
    };
    requestAnimationFrame(follow);
  }
  return n;
}

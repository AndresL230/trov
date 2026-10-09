// ── Landing motion: the DOM half of the landing's choreography ───────────────
// landing.ts renders every revealable element with `data-rv`, hidden. This
// module plays each one (`is-play`) as it scrolls into view — the CSS in
// trov.css runs the rest — and records its key in the caller's `seen` set,
// which landing.ts reads so a rerender renders it settled instead of replaying.
// Reduced motion: everything settles immediately, nothing is observed.

import { mountPricing } from "./pricing-dom";

let observer: IntersectionObserver | null = null;

// A nav jump (`siteJump`) smooth-scrolls the page past whole sections. Reveals that fire on the way
// would all be animating at once and the target would still be sliding in when the scroll stops, which
// reads as the page overshooting. So while a jump is in flight, what comes into view is settled with
// no motion. The flight ends just after `scrollend`, or after JUMP_MS where that event does not exist.
const JUMP_MS = 1200;
const JUMP_GRACE_MS = 150;
let jumpUntil = 0;
/** main.ts calls this just before a nav jump scrolls the page. */
export function noteJump(now: number = performance.now()): void {
  jumpUntil = now + JUMP_MS;
  // The observer reports the last position a frame AFTER the scroll ends, so the flight outlives it a little.
  if (typeof window !== "undefined") window.addEventListener("scrollend", () => { jumpUntil = performance.now() + JUMP_GRACE_MS; }, { once: true });
}
/** Is a nav jump carrying the page right now? (exported for the test) */
export const jumping = (now: number = performance.now()): boolean => now < jumpUntil;
/** How a reveal that just came into view is shown: played, or settled when the page is being carried. */
export const revealClass = (inFlight: boolean): "is-play" | "is-done" => (inFlight ? "is-done" : "is-play");

/** Run after every landing render (the innerHTML swap made fresh elements). */
export function mountLandingMotion(root: ParentNode, seen: Set<string>): void {
  unmountLandingMotion();
  syncNav(true);
  mountPricing(root); // the pricing section's Monthly / Yearly choice survives the rerender
  const pending = [...root.querySelectorAll<HTMLElement>("[data-rv]:not(.is-done)")];
  if (!pending.length) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || typeof IntersectionObserver === "undefined") {
    for (const el of pending) { el.classList.add("is-done"); seen.add(el.dataset.rv ?? ""); }
    return;
  }
  observer = new IntersectionObserver((entries, obs) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const el = e.target as HTMLElement;
      obs.unobserve(el);
      seen.add(el.dataset.rv ?? "");
      el.classList.add(revealClass(jumping()));
    }
    // Played ONCE (unobserved above), a little before the element enters, so it is in place when read.
  }, { rootMargin: "0px 0px 6% 0px", threshold: 0 });
  for (const el of pending) observer.observe(el);
}

/** Leaving the landing (signed in, or another auth step): stop observing. */
export function unmountLandingMotion(): void {
  observer?.disconnect();
  observer = null;
}

// The nav gains its hairline + shadow once the page scrolls under it. One
// passive, rAF-throttled listener for the page's lifetime; a no-op off the landing.
// `instant` is for a fresh render: the new nav must arrive in its state, not fade to it.
function syncNav(instant = false): void {
  const nav = document.querySelector<HTMLElement>(".site-nav");
  if (!nav) return;
  if (instant) nav.style.transition = "none";
  nav.toggleAttribute("data-scrolled", window.scrollY > 4);
  if (instant) { void nav.offsetHeight; nav.style.transition = ""; }
}
let navQueued = false;
if (typeof window !== "undefined") window.addEventListener("scroll", () => {
  if (navQueued) return;
  navQueued = true;
  requestAnimationFrame(() => { navQueued = false; syncNav(); });
}, { passive: true });

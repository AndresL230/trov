// ── Landing motion: the DOM half of the landing's choreography ───────────────
// landing.ts renders every revealable element with `data-rv`, hidden. This
// module plays each one (`is-play`) as it scrolls into view — the CSS in
// trov.css runs the rest — and records its key in the caller's `seen` set,
// which landing.ts reads so a rerender renders it settled instead of replaying.
// Reduced motion: everything settles immediately, nothing is observed.

import { mountPricing } from "./pricing-dom";

let observer: IntersectionObserver | null = null;

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
      el.classList.add("is-play");
    }
  }, { rootMargin: "0px 0px -8% 0px", threshold: 0.12 });
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
window.addEventListener("scroll", () => {
  if (navQueued) return;
  navQueued = true;
  requestAnimationFrame(() => { navQueued = false; syncNav(); });
}, { passive: true });

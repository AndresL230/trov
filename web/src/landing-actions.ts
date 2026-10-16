// The landing page's controller: the Sign in dialog, the tour's dialog, the menu under 900px and the
// in-page jumps — every act the site's own markup dispatches, and their keyboard. ONE definition for
// both places the landing is drawn: the signed-out page's own boot (landing-page.ts, `/` without a
// session) and the app (main.ts: a signed-out visit to an app address, and the landing reopened from
// inside the app by the sidebar logo, `#site`). web-ui.md › The app's bundles.
//
// The jumps scroll instead of setting location.hash — the hash is the app's route and the sign-in
// return-to, and must survive a browse of the landing page.
import { createFeatureCtl } from "./site-feature";
import { TOUR_KEYS, type FeatureState } from "./site-feature-core";
import { createMenuCtl } from "./site-menu";
import { initSiteViewport } from "./site-viewport";
import { noteJump } from "./landing-motion";
import { RETURN_HASH_KEY, RETURN_ORG_KEY, orgSlugFromPath } from "./org-context";

/** The part of the page's state the landing reads and writes (main.ts's AppState is one). */
export interface LandingState {
  view: string;
  /** Signed in (the landing reopened from inside the app). */
  me: unknown;
  signInOpen: boolean;
  signInMode: "signin" | "signup";
  signInPlan: "free" | "team";
  siteFeature: FeatureState | null;
  siteMenu: boolean;
}

export interface LandingHost {
  state: LandingState;
  mount: HTMLElement;
  rerender(): void;
  /** Signed in, "Get started" opens the Guide (main.ts routes it). */
  guide(): void;
  /** Signed in, the nav's way back to where the logo was clicked from (main.ts routes it). */
  back(): void;
}

/** Sign in: the hash never reaches the server, so it is stashed for the boot after the callback lands on
 *  "/" (an e-mail deep link survives sign-in) — not #site, which IS the landing page and would strand them
 *  outside the app. The org they were on (`/<slug>/`) is stashed the same way. */
function stashReturn(): void {
  try {
    if (location.hash && location.hash !== "#site") sessionStorage.setItem(RETURN_HASH_KEY, location.hash);
    const from = orgSlugFromPath(location.pathname);
    if (from) sessionStorage.setItem(RETURN_ORG_KEY, from);
  } catch { /* ignore */ }
}

export function createLandingController(h: LandingHost) {
  const { state, mount } = h;

  // The tour's dialog: Escape, ← / →, and Tab kept inside it.
  const featureCtl = createFeatureCtl({ mount, keys: TOUR_KEYS, get: () => state.siteFeature, set: (v) => { state.siteFeature = v; }, rerender: () => h.rerender() });
  document.addEventListener("keydown", (e) => featureCtl.onKey(e));
  // A phone steps through the tour's dialog by swiping it left or right (site-feature.ts `onSwipe*`).
  mount.addEventListener("pointerdown", (e) => featureCtl.onPointerDown(e));
  mount.addEventListener("pointerup", (e) => featureCtl.onPointerUp(e));
  mount.addEventListener("pointercancel", () => featureCtl.onPointerCancel());

  // The landing's menu (under 900px): Escape, Tab kept inside it, and gone when the window outgrows it.
  const menuCtl = createMenuCtl({ mount, get: () => state.siteMenu, set: (v) => { state.siteMenu = v; }, rerender: () => h.rerender() });
  document.addEventListener("keydown", (e) => menuCtl.onKey(e));
  window.addEventListener("resize", () => menuCtl.onResize());
  // The on-screen keyboard: the site's sheets stay above it (site-viewport.ts sets `--site-kb`).
  initSiteViewport();

  // Escape closes the landing page's sign-in dialog, wherever focus is.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !state.signInOpen || state.view !== "auth") return;
    state.signInOpen = false;
    h.rerender();
  });
  // …and Tab stays inside it (it is `aria-modal`): from the last stop — the consent's links — back to the
  // first, and the reverse, so a keyboard never wanders onto the page behind (the compliance pass's keyboard check).
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Tab" || !state.signInOpen || state.view !== "auth") return;
    const dialog = document.querySelector<HTMLElement>('[data-overlay="signin"] [role="dialog"]');
    if (!dialog) return;
    const stops = [...dialog.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (!stops.length) return;
    const first = stops[0], last = stops[stops.length - 1];
    const at = document.activeElement as HTMLElement | null;
    if (!at || !dialog.contains(at)) { e.preventDefault(); first.focus(); return; }
    if (e.shiftKey && at === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
  });

  /** Run one of the landing's acts; false when `act` is not one of them. */
  function run(act: string, arg: string | null): boolean {
    switch (act) {
      case "signIn": stashReturn(); window.location.href = "/auth/login"; return true;
      case "signInGoogle": stashReturn(); window.location.href = "/auth/google/login"; return true;
      case "openSignIn": {
        // `arg` says what the visitor came to do ("signup" from a Start-for-free button, or the dialog's own
        // switch); anything else is the nav's Sign in. Switching inside the open dialog keeps focus on the switch.
        const switching = state.signInOpen;
        menuCtl.close({ instant: true, refocus: false }); // opened from the menu: the sign-in sheet takes its place
        state.signInMode = arg === "signup" ? "signup" : "signin";
        state.signInOpen = true;
        h.rerender();
        mount.querySelector<HTMLElement>(switching ? '[role="dialog"] [data-field="signInSwitch"]' : '[role="dialog"] [data-act="signIn"]')?.focus();
        return true;
      }
      case "signInPlan": state.signInPlan = arg === "team" ? "team" : "free"; h.rerender(); return true;
      case "closeSignIn": state.signInOpen = false; h.rerender(); return true;
      // The menu the nav offers under 900px (site-menu.ts).
      case "openSiteMenu": menuCtl.open(); return true;
      case "closeSiteMenu": menuCtl.close(); return true;
      // The tour's dialog (site-feature.ts): a card grows into it, ← / → step through the features.
      case "openFeature": if (arg) featureCtl.open(arg); return true;
      case "closeFeature": featureCtl.close(); return true;
      case "stepFeature": featureCtl.step(arg === "prev" ? -1 : 1); return true;
      // "Get started": signed in, straight to the guide; signed out, the guide becomes the sign-in
      // return-to (replaceState: no hashchange, no route) and the Sign in dialog opens.
      case "siteGuide":
        if (state.me) { h.guide(); return true; }
        history.replaceState(null, "", `${location.pathname}#guide`);
        return run("openSignIn", null);
      case "siteJump": {
        const behavior: ScrollBehavior = matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
        // ONE scroll per click; where it lands is the target's `scroll-margin-top` (trov.css). Sections
        // passed on the way settle without their entrance (landing-motion.ts).
        // From the menu: it closes (unlocking the page's scroll at once) and the page scrolls under it as it leaves.
        menuCtl.close({ refocus: false });
        noteJump();
        if (arg === "top") window.scrollTo({ top: 0, behavior });
        else document.getElementById(`site-${arg}`)?.scrollIntoView({ behavior, block: "start" });
        return true;
      }
      // Reopened from inside the app: back to where the logo was clicked from.
      case "siteBack": menuCtl.close({ instant: true, refocus: false }); h.back(); return true;
      default: return false;
    }
  }

  return { act: run };
}

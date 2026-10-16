// The signed-out landing page as its own boot paints it (landing-page.ts): the app's root element
// (app-root.ts) around the landing, its toast and the Contact form — the same markup render.ts paints for
// a signed-out visitor (render(initialState()) is what the build prerenders), so the boot's first paint
// morphs the prerendered page in place. test/render.landing-page.test.ts holds the two to each other.
import { appRoot, resolvedTheme, toastBlock, type RootState, type ToastAction } from "./app-root";
import { landingView } from "./landing";
import { supportDialog, type SupportDraft } from "./support";
import type { LandingState } from "./landing-actions";

/** Everything the signed-out page holds: a slice of main.ts's AppState, the same fields. */
export interface SiteState extends RootState, LandingState {
  landingSeen: Set<string>;
  support: SupportDraft;
  toast: string | null;
  toastAction: ToastAction | null;
  toastAt: number;
  toastMs: number;
}

export function landingPageHtml(s: SiteState, now: number = Date.now()): string {
  return appRoot(s, `
    ${landingView({ dark: resolvedTheme(s) !== "light", signInOpen: s.signInOpen, signInMode: s.signInMode, signInPlan: s.signInPlan, seen: s.landingSeen, feature: s.siteFeature, menuOpen: s.siteMenu })}
    ${s.toast ? toastBlock(s.toast, Math.max(0, now - s.toastAt), s.toastMs, s.toastAction) : ""}
    ${supportDialog(s.support)}
  `);
}

// The app's root element and its toast — shared by the app's paint (render.ts `render`) and the signed-out
// landing page's own boot (landing-page.ts), so the two draw the page from one definition and the
// landing's first paint morphs the prerendered markup (made by render.ts) in place.
import { esc, attr } from "./ui";

/** What the root element says about the page: its theme, the screen, the rail and the phone layout. */
export interface RootState {
  theme: "dark" | "light" | "system";
  systemDark: boolean;
  screen: string;
  collapsed: boolean;
  narrow: boolean;
  phone: boolean;
  drawer: boolean;
  feedAuthor: string;
}

/** The theme on screen: the stored choice, or the OS's for "system". */
export const resolvedTheme = (s: Pick<RootState, "theme" | "systemDark">): "dark" | "light" =>
  s.theme === "system" ? (s.systemDark ? "dark" : "light") : s.theme;

/** Below 900px the rail renders collapsed (the person's preference is untouched); on a phone it is a drawer. */
export const railCollapsed = (s: Pick<RootState, "phone" | "collapsed" | "narrow">): boolean => !s.phone && (s.collapsed || s.narrow);

/** The root element around `inner`: everything the app paints is inside it. */
export function appRoot(s: RootState, inner: string): string {
  return `<div data-cnpy-theme="${resolvedTheme(s)}" data-screen="${s.screen}" data-collapsed="${railCollapsed(s) ? "1" : "0"}" data-narrow="${s.narrow ? "1" : "0"}" data-phone="${s.phone ? "1" : "0"}" data-drawer="${s.phone && s.drawer ? "1" : "0"}" data-author="${s.feedAuthor}" style="background:var(--bg);color:var(--fg);min-height:calc(100 * var(--vh));font-family:'Geist','Geist Fallback',system-ui,-apple-system,sans-serif;font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased">${inner}</div>`;
}

// The toast pops in, then fades out over its last 400ms. Both delays are offset by the time
// already elapsed (negative = joined mid-way), so a rerender while it is up never replays the pop.
// Centered with auto margins, not translateX(-50%): cnpy-pop animates `transform` to none.
const TOAST_FADE_MS = 400;
/** A toast's one button: `Undo` on a delete. Dispatched like any `data-act`. */
export interface ToastAction { label: string; act: string; arg: string }

export function toastBlock(msg: string, elapsed: number, ms: number, action: ToastAction | null = null): string {
  return `<div class="cnpy-toast" role="status" aria-live="polite" style="position:fixed;bottom:22px;left:0;right:0;margin:0 auto;width:max-content;max-width:min(520px,calc(100 * var(--vw) - 32px));z-index:50;display:flex;align-items:flex-start;gap:9px;padding:10px 16px;border:1px solid var(--border-strong);border-radius:10px;background:var(--bg);box-shadow:0 8px 30px rgba(0,0,0,.35);font-size:13px;line-height:1.45;animation-delay:${-elapsed}ms,${ms - TOAST_FADE_MS - elapsed}ms">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.4" style="flex:none;margin-top:2px"><path d="M20 6 9 17l-5-5"></path></svg><span>${esc(msg)}</span>${action ? `<span aria-hidden="true" style="color:var(--fg-40)">·</span><button type="button" data-act="${attr(action.act)}" data-arg="${attr(action.arg)}" class="cnpy-toast-act" style="font-size:13px;font-weight:600;color:var(--accent);white-space:nowrap">${esc(action.label)}</button>` : ""}
  </div>`;
}

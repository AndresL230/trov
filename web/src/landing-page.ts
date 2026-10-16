// The signed-out landing page's own boot (web-ui.md › The app's bundles). The Worker sends the
// prerendered landing (index.html) for `/` only to a request with no session cookie (src/site.ts), so
// there is nobody to ask about: this page needs none of the app — no screens, no /auth/me — and its
// bundle is the landing, its dialogs and the Contact form. It paints what the app paints for a
// signed-out visitor (landing-root.ts; the acts are landing-actions.ts, shared with main.ts), so its
// first paint MORPHS the prerendered markup in place: nothing is rebuilt or flashes, and the reveals play.
//
// What only the app answers — a refused sign-in (`?denied=`), a new account's `#onboard`, a page that
// came without the prerendered landing — is handed to the app's own boot (main.ts), loaded then.
import "./trov.css";
import { migrateBrowserStorage } from "./storage-migrate";
import { installMarkTips } from "./tip";
import { initFaqAccordion } from "./site-faq";
import { syncSegments } from "./segmented";
import { syncFavicon } from "./favicon";
import { paint } from "./morph";
import { followSkipLink, syncPageBackground } from "./site-chrome";
import { mountLandingMotion } from "./landing-motion";
import { resolvedTheme } from "./app-root";
import { createLandingController } from "./landing-actions";
import { landingPageHtml, type SiteState } from "./landing-root";
import { initialSupport } from "./support";
import type { SupportKind } from "@shared/support-core";
import { DELETED_PARAM, DELETED_SENTENCE } from "./deletion-notice";

const mount = document.getElementById("app");
const params = new URLSearchParams(location.search);
const appOnly = !mount || !mount.querySelector(':scope > * > [data-morph="landing"]') || params.has("denied") || location.hash === "#onboard";
if (appOnly) void import("./main");
else bootLanding(mount);

function bootLanding(mount: HTMLElement): void {
  const state: SiteState = {
    view: "auth", me: null,
    signInOpen: false, signInMode: "signin", signInPlan: "free", siteFeature: null, siteMenu: false, landingSeen: new Set(),
    theme: "light", systemDark: true, screen: "mywork", collapsed: false, narrow: false, phone: false, drawer: false, feedAuthor: "all",
    support: initialSupport(),
    toast: null, toastAction: null, toastAt: 0, toastMs: 0,
  };

  // The stored preferences, read as main.ts reads them (the theme; the rail's, for the root's attributes).
  migrateBrowserStorage(); // canopy.* → trov.* (the rename) before the first read
  initFaqAccordion();      // the Questions accordion (site-faq.ts): one delegated listener
  try {
    const t = localStorage.getItem("trov.theme");
    if (t === "dark" || t === "light" || t === "system") state.theme = t;
    else if (t === "midnight") state.theme = "dark"; // Midnight was retired (2026-09-26) — its closest theme
    const c = localStorage.getItem("trov.collapsed");
    if (c) state.collapsed = c === "1";
  } catch { /* localStorage unavailable */ }

  function paintPage(): void {
    const active = document.activeElement as HTMLElement | null;
    const field = active?.getAttribute?.("data-field") ?? null;
    let selStart = 0, selEnd = 0;
    if (field && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)) {
      selStart = active.selectionStart ?? 0;
      selEnd = active.selectionEnd ?? 0;
    }
    const theme = resolvedTheme(state);
    paint(mount, landingPageHtml(state));
    syncSegments(mount);
    // The tab icon and the page behind the app follow the theme (the build's theme boot set the first).
    syncFavicon(theme, mount.querySelector("[data-cnpy-theme]"));
    syncPageBackground(document.documentElement, theme);
    mountLandingMotion(mount, state.landingSeen);
    if (field) {
      const el = mount.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-field="${field}"]`);
      if (el && el !== document.activeElement) {
        el.focus();
        try { el.setSelectionRange(selStart, selEnd); } catch { /* not a text input */ }
      }
    }
  }
  const rerender = paintPage;

  if (window.matchMedia) {
    const watch = (query: string, set: (on: boolean) => void): void => {
      const mq = window.matchMedia(query);
      set(mq.matches);
      const on = (ev: MediaQueryListEvent) => { set(ev.matches); rerender(); };
      if (mq.addEventListener) mq.addEventListener("change", on);
      else mq.addListener(on);
    };
    watch("(prefers-color-scheme: dark)", (on) => { state.systemDark = on; });
    watch("(max-width: 900px)", (on) => { state.narrow = on; });
    watch("(max-width: 640px)", (on) => { state.phone = on; state.drawer = false; });
  }

  /** A toast (the account deletion's "done"). */
  function flash(msg: string, ms: number): void {
    const at = Date.now();
    state.toast = msg; state.toastAction = null; state.toastAt = at; state.toastMs = ms;
    rerender();
    setTimeout(() => { if (state.toastAt === at) { state.toast = null; rerender(); } }, ms);
  }

  const landing = createLandingController({
    state, mount, rerender,
    // Nobody is signed in on this page: the signed-in acts never come.
    guide: () => undefined, back: () => undefined,
  });
  // The site's Contact form: the support dialog in its anonymous setting (support-actions.ts). Its controller
  // (and the API client it sends with) is loaded when the form is first opened — most visits never do.
  type SupportCtl = ReturnType<typeof import("./support-actions").createSupport>;
  let supportCtl: Promise<SupportCtl> | null = null;
  const support = (): Promise<SupportCtl> => (supportCtl ??= import("./support-actions").then((m) => m.createSupport({
    state, mount, rerender, unauth: () => undefined, signedIn: () => false,
    context: () => ({ route: `${location.pathname}${location.hash}`, org: null, version: "", userAgent: navigator.userAgent }),
  }), (e: unknown) => { supportCtl = null; throw e; }));
  const openSupport = (kind: SupportKind): void => { void support().then((c) => c.open(kind), () => undefined); };

  function dispatch(act: string, arg: string | null, value: string | null): void {
    if (landing.act(act, arg)) return;
    if (act.startsWith("support")) { void support().then((c) => c.act(act, arg, value), () => undefined); return; }
    if (act === "cycleTheme") {
      // The nav's toggle flips between the two concrete themes, and the app reads the same key.
      state.theme = resolvedTheme(state) === "light" ? "dark" : "light";
      try { localStorage.setItem("trov.theme", state.theme); } catch { /* ignore */ }
      rerender();
    }
  }

  mount.addEventListener("click", (e) => {
    // The skip link (site-chrome.ts `skipLink`): focus the main content without writing the hash, which is
    // the sign-in return-to.
    if (followSkipLink(e)) return;
    const target = e.target as Element;
    if (target.closest("input, select, textarea, a[href]")) return;
    const el = target.closest<HTMLElement>("[data-act]");
    if (!el) return;
    // The Contact form returns focus to the trigger that opened it: its controller may not be loaded yet to
    // see the click land, so the trigger takes focus (a click does not focus a button in every browser).
    if (el.hasAttribute("data-support-trigger")) el.focus();
    dispatch(el.dataset.act ?? "", el.dataset.arg ?? null, null);
  });
  mount.addEventListener("input", (e) => {
    const el = e.target as HTMLElement;
    if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.dataset.act) dispatch(el.dataset.act, el.dataset.arg ?? null, el.value);
  });
  mount.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const el = (e.target as Element | null)?.closest?.<HTMLInputElement>("input[data-enter]");
    if (!el) return;
    e.preventDefault();
    dispatch(el.dataset.enter ?? "", null, null);
  });
  // A status mark's tooltip (`data-mtip`, marks.ts): one styled bubble on <body>, placed by tip.ts.
  installMarkTips(mount);
  // A switch's option widths change with the viewport and once the web fonts land.
  const syncIndicators = () => { syncSegments(mount, { instant: true }); };
  window.addEventListener("resize", syncIndicators);
  void document.fonts?.ready.then(syncIndicators);

  // What a link to the page asked for — read once, and it leaves the address bar.
  // `/?start=team` (the pricing page's "Choose Pro"): Get started opens on that plan, so the two provider
  // buttons carry on to payment.
  if (params.get("start") === "team") {
    state.signInOpen = true; state.signInMode = "signup"; state.signInPlan = "team";
    history.replaceState(null, "", `/${location.hash}`);
  }
  // The first paint morphs the prerendered page (`data-morph="landing"`, morph.ts).
  rerender();
  // Sent here by deleting one's own account (deletion-actions.ts): told so once.
  if (params.get(DELETED_PARAM) === "account") {
    history.replaceState(null, "", "/");
    flash(DELETED_SENTENCE.account, 8000);
  }
  // Contact in the footer of a static page (site-chrome.ts `CONTACT_HREF`): the form opens over the page.
  if (params.get("contact") === "1") {
    history.replaceState(null, "", `/${location.hash}`);
    openSupport("question");
  }
}

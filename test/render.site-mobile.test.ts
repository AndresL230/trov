/**
 * The signed-out site on a phone (docs/architecture/web-ui.md › "The site on a phone").
 *
 * What a narrow or touch screen changes lives in ONE block of web/src/trov.css, keyed on classes the
 * templates carry; a wide screen must see none of it. These tests pin the hooks (the menu overlay and its
 * acts, the hero's unified diff, the legal contents disclosure, the footer), the rules that use them, that
 * every one of those rules sits behind a width or hover query, and the pure decisions around them (what
 * counts as a swipe, how much of the window the keyboard covers).
 */
import { describe, it, expect } from "vitest";
import css from "../web/src/trov.css?raw";
import mainSrc from "../web/src/main.ts?raw";
import menuSrc from "../web/src/site-menu.ts?raw";
import legalPageSrc from "../web/src/legal-page.ts?raw";
import { landingView } from "../web/src/landing";
import { initialState, render } from "../web/src/render";
import { TERMS, PRIVACY, legalView } from "../web/src/legal";
import { pricingView } from "../web/src/pricing";
import { siteFooter } from "../web/src/site-chrome";
import { featureMock } from "../web/src/landing-mocks";
import { FX_EXIT_MS, SWIPE_MAX_MS, SWIPE_MIN_PX, swipeStep } from "../web/src/site-feature-core";
import { MENU_EXIT_MS, MENU_MAX_WIDTH } from "../web/src/site-menu";
import { coveredBottom } from "../web/src/site-viewport";

const page = (over: Partial<Parameters<typeof landingView>[0]> = {}) =>
  landingView({ dark: false, signInOpen: false, seen: new Set(), ...over });
/** trov.css with comments stripped and whitespace collapsed. */
const rules = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");
/** The phone block: from its header to the corners block. */
const block = css.slice(css.indexOf("/* ── the site on a phone"), css.indexOf("/* ── corners: tightened")).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");

/** The block's top-level statements: [prelude, body] for each rule or at-rule. */
function topLevel(src: string): [string, string][] {
  const out: [string, string][] = [];
  let depth = 0, start = 0, open = 0;
  for (let i = 0; i < src.length; i++) {
    if (src[i] === "{") { if (depth === 0) open = i; depth++; }
    else if (src[i] === "}") { depth--; if (depth === 0) { out.push([src.slice(start, open).trim(), src.slice(open + 1, i).trim()]); start = i + 1; } }
  }
  return out;
}
/** The body of the block's `@media <query>` rule (the first one with that prelude). */
const media = (query: string): string => topLevel(block).find(([p]) => p === `@media ${query}`)?.[1] ?? "";

describe("the site's menu — what the bar drops under 900px", () => {
  it("the bar always carries the menu button (a stable nav), closed by default, and marks what leaves it", () => {
    const html = page();
    expect(html).toMatch(/<button type="button" data-act="openSiteMenu" data-field="siteMenuBtn" aria-haspopup="dialog" aria-expanded="false" aria-controls="site-menu" aria-label="Menu" class="site-iconbtn site-menubtn"/);
    expect(html).not.toContain('data-overlay="sitemenu"');
    // GitHub, the theme toggle and Sign in leave the bar; the accent button stays.
    expect(html.match(/class="[^"]*\bsite-nav-x\b[^"]*"/g)).toHaveLength(3);
    expect(html).toMatch(/data-field="navStart" class="cnpy-accentbtn site-nav-cta"/);
    expect(page({ menuOpen: true })).toContain('aria-expanded="true" aria-controls="site-menu"');
    // Reopened from inside the app the same button is there, beside the way back.
    expect(page({ signedIn: true })).toContain('data-act="openSiteMenu"');
  });

  it("opens as ONE root-level overlay beside the page: a modal dialog with the five sections, the theme, GitHub and both ways in", () => {
    const html = page({ menuOpen: true });
    const at = html.indexOf('<div data-overlay="sitemenu" class="site-menu">');
    expect(at).toBeGreaterThan(html.indexOf("</footer>")); // after the page, not inside it
    expect(html.match(/data-overlay="sitemenu"/g)).toHaveLength(1);
    expect(html).toContain('data-morph="landing"');
    const menu = html.slice(at);
    expect(menu).toContain('<div id="site-menu" role="dialog" aria-modal="true" aria-labelledby="site-menu-t" class="site-menu-sheet"');
    expect(menu).toContain('<div data-act="closeSiteMenu" class="site-menu-back"></div>');
    expect(menu).toMatch(/<button type="button" data-act="closeSiteMenu" aria-label="Close menu" class="site-menu-x"/);
    expect([...menu.matchAll(/<button type="button" data-act="siteJump" data-arg="(\w+)" class="site-menu-link"[^>]*><span>([^<]+)<\/span>/g)].map((m) => `${m[1]}:${m[2]}`))
      .toEqual(["how:How it works", "tour:Tour", "agents:For agents", "security:Security", "pricing:Pricing"]);
    expect(menu).toMatch(/data-act="cycleTheme" data-field="menuTheme" class="site-menu-tool"[^>]*><span>Theme<\/span><span class="site-menu-val">Light</);
    expect(page({ menuOpen: true, dark: true })).toMatch(/<span class="site-menu-val">Dark</);
    expect(menu).toMatch(/<a href="https:\/\/github\.com\/AndresL230\/trov" target="_blank" rel="noopener" class="site-menu-tool"/);
    expect(menu).toMatch(/data-act="openSignIn" data-field="menuSignIn"[^>]*>Sign in<\/button>\s*<button type="button" data-act="openSignIn" data-arg="signup" data-field="menuStart"[^>]*>Get started<\/button>/);
    // No control inside another, and nothing hand-rolled as a switch.
    expect(menu).not.toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*<button/);
    expect(menu).not.toContain("<select");
  });

  it("signed in, the menu's way out is Back to the app, and it offers no sign-in", () => {
    const menu = page({ menuOpen: true, signedIn: true });
    const sheet = menu.slice(menu.indexOf('data-overlay="sitemenu"'));
    expect(sheet).toContain('<button type="button" data-act="siteBack" class="site-btn site-btn-accent">Back to the app</button>');
    expect(sheet).not.toContain("openSignIn");
  });

  it("is drawn from state.siteMenu, on the signed-out page and on the page reopened from the app", () => {
    expect(initialState().siteMenu).toBe(false);
    expect(render({ ...initialState(), view: "auth", authStep: "login", siteMenu: true })).toContain('data-overlay="sitemenu"');
    expect(render({ ...initialState(), view: "auth", authStep: "login" })).not.toContain('data-overlay="sitemenu"');
    expect(render({ ...initialState(), view: "app", screen: "site", siteMenu: true })).toContain('data-overlay="sitemenu"');
  });

  it("its acts: open, close, a section link closes it before the ONE scroll, and Sign in takes its place", () => {
    expect(mainSrc).toContain('case "openSiteMenu": menuCtl.open(); return;');
    expect(mainSrc).toContain('case "closeSiteMenu": menuCtl.close(); return;');
    const jump = mainSrc.slice(mainSrc.indexOf('case "siteJump": {'), mainSrc.indexOf('case "backToLogin":'));
    expect(jump.indexOf("menuCtl.close({ refocus: false })")).toBeGreaterThan(0);
    expect(jump.indexOf("menuCtl.close({ refocus: false })")).toBeLessThan(jump.indexOf("scrollIntoView"));
    const signIn = mainSrc.slice(mainSrc.indexOf('case "openSignIn": {'), mainSrc.indexOf('case "signInPlan":'));
    expect(signIn).toContain("menuCtl.close({ instant: true, refocus: false })");
    expect(mainSrc).toContain('document.addEventListener("keydown", (e) => menuCtl.onKey(e));');
    expect(mainSrc).toContain('window.addEventListener("resize", () => menuCtl.onResize());');
  });

  it("the controller: Esc, a Tab trap, a scroll lock undone at once on close, focus back on the button, an exit on the site's clock", () => {
    expect(menuSrc).toContain('if (e.key === "Escape") { e.preventDefault(); close(); return; }');
    expect(menuSrc).toContain("trapIndex(list.length, list.indexOf(document.activeElement as HTMLElement), e.shiftKey)");
    expect(menuSrc).toContain('root.style.overflow = "hidden";');
    expect(menuSrc).toContain("button()?.focus({ preventScroll: true })");
    expect(menuSrc).toContain('overlay()?.setAttribute("data-closing", "")');
    expect(menuSrc).toContain("if (opts.instant || reduced()) { hide(); return; }");
    expect(MENU_EXIT_MS).toBe(FX_EXIT_MS);
    expect(rules).toContain(`--fx-fast:${FX_EXIT_MS / 1000}s;`.replace(":0.", ":."));
    expect(MENU_MAX_WIDTH).toBe(900);
  });

  it("the CSS: hidden on a wide screen, a card under the button on a tablet, the app's sheet on a phone, still under reduced motion", () => {
    expect(block).toContain(".site-iconbtn.site-menubtn, .site-hero-tabs-ph, .site-legal-tocb, .site-foot-lic { display:none; }");
    expect(block).toContain("@media (min-width:901px) { .site-menu { display:none; } }");
    const tablet = media("(max-width:900px)");
    expect(tablet).toContain(".site-nav-x { display:none; }");
    expect(tablet).toContain(".site-iconbtn.site-menubtn { display:grid; }");
    expect(tablet).toContain(".site-nav .site-iconbtn { width:44px; height:44px; }");
    expect(block).toMatch(/\.site-menu-wrap \{ position:fixed; inset:0; z-index:65; display:grid; place-items:start end;/);
    expect(block).toMatch(/\.site-menu-link \{[^}]*min-height:52px;/);
    expect(block).toMatch(/\.site-menu-tool \{[^}]*min-height:48px;/);
    expect(block).toMatch(/\.site-menu-sheet :is\(button, a\):focus-visible \{ outline:2px solid/);
    expect(block).toContain(".site-menu[data-closing] .site-menu-sheet { animation:site-menu-out var(--fx-fast) var(--fx-ease) both; }");
    expect(block).toContain("@media (prefers-reduced-motion: reduce) { .site-menu, .site-menu * { animation:none !important; transition:none !important; } }");
    // On a phone it is a sheet through the app's one rule for modals (a full-screen wrapper whose child is the dialog).
    expect(rules).toMatch(/@media \(max-width:640px\) \{ \[data-cnpy-theme\] :has\(> \[role="dialog"\]\[aria-modal="true"\]\),/);
    const phone = media("(max-width:640px)");
    expect(phone).toContain(".site-menu-sheet { animation:site-sheet-up var(--fx-slow) var(--fx-ease) both; }");
    expect(phone).toContain(".site-menu[data-closing] .site-menu-sheet { animation:site-sheet-down var(--fx-fast) var(--fx-ease) both; }");
  });
});

describe("the phone block — nothing in it reaches a wide screen", () => {
  it("every rule is behind a width or hover query, or is the menu's own (which a wide screen never displays), a hide, or a keyframe", () => {
    const allowed = /^(@media \((max-width:(900|640|480)px|min-width:901px|hover:none|prefers-reduced-motion: reduce)\)|@keyframes site-(menu-in|menu-out|sheet-up|sheet-down)|(\[data-cnpy-theme="dark"\] )?\.site-menu[\w-]*.*)$/;
    const top = topLevel(block);
    expect(top.length).toBeGreaterThan(20);
    for (const [prelude, body] of top) {
      if (prelude === ".site-iconbtn.site-menubtn, .site-hero-tabs-ph, .site-legal-tocb, .site-foot-lic") { expect(body).toBe("display:none;"); continue; }
      expect(prelude, `unguarded rule in the phone block: ${prelude}`).toMatch(allowed);
    }
  });

  it("changes no font size at 961px and up: the block's width queries stop at 900px", () => {
    for (const m of block.matchAll(/@media \(max-width:\s*(\d+)px\)/g)) expect(Number(m[1])).toBeLessThanOrEqual(900);
    expect(block).not.toMatch(/@media \(min-width:(?!901px)/);
  });
});

describe("the hero on a phone", () => {
  const html = page();
  const phone = media("(max-width:640px)");

  it("the Review mockup carries the hooks for ONE unified diff: the left pane's twin lines, both panes, a phone's own tabs", () => {
    expect(html.match(/class="site-hero-twin"/g)).toHaveLength(5);
    expect(html).toContain('class="site-hero-cur"');
    expect(html).toContain('class="site-hero-new"');
    expect(html.match(/class="site-hero-lines"/g)).toHaveLength(2);
    expect(html).toMatch(/<span class="site-hero-tabs-ph" aria-hidden="true">/);
    expect(html).toContain('class="site-hero-win" style="display:flex;height:568px;overflow:hidden"'); // the wide screen's fixed window is untouched
  });

  it("the rules: a stacked headline block with 50px buttons, the window as tall as its content, removed line over added lines", () => {
    expect(phone).toContain(".site-hero-h { font-size:clamp(32px, 9.4vw, 40px); line-height:1.07; }");
    expect(phone).toMatch(/\.site-hero-cta > \.site-btn \{[^}]*min-height:50px;/);
    expect(media("(max-width:480px)")).toContain(".site-hero-cta { grid-template-columns:minmax(0, 1fr); }");
    expect(phone).toContain(".site-hero-win { height:auto !important; }");
    expect(phone).toContain(".site-hero-cur, .site-hero-new, .site-hero-lines { display:contents; }");
    expect(phone).toContain(".site-hero-ph, .site-hero-twin { display:none; }");
    expect(phone).toContain(".site-hero-cur .site-hl { order:2; }");
    expect(phone).toContain(".site-hero-new .site-hl { order:3; }");
    // The banner's art is placed for the narrow canvas, not left where the wide one put it.
    expect(phone).toMatch(/\.site-hero-band > \.site-banner-art \{ width:330px; right:-118px; top:auto; bottom:-64px;/);
    expect(phone).toMatch(/\.site-hero-band::after \{[^}]*mask-image:linear-gradient\(180deg, transparent 42%, #000 100%\); \}/);
  });
});

describe("mockups on a phone — the most telling pane, at a readable size", () => {
  const phone = media("(max-width:640px)");

  it("no type a mockup shows renders under 11px: every smaller inline size in use has a key in the floor rule", () => {
    const floor = phone.match(/:is\(([^)]*)\) :is\(([^{]*)\) \{ font-size:11px !important; \}/);
    expect(floor).not.toBeNull();
    for (const scope of [".site-hero-mock", ".site-stage", ".site-how-grid", ".site-fx-mock"]) expect(floor![1]).toContain(scope);
    const used = new Set<string>();
    const sources = [page(), ...(["docs", "feed", "tickets", "roadmap", "mywork", "handoffs", "artifacts"] as const).map(featureMock)];
    for (const src of sources) for (const m of src.matchAll(/font-size:([\d.]+)px/g)) if (Number(m[1]) < 11) used.add(m[1]);
    expect(used.size).toBeGreaterThan(3);
    for (const size of used) expect(floor![2], `a mockup uses ${size}px and the floor has no key for it`).toContain(`[style*="font-size:${size}px"]`);
  });

  it("the tour's teasers and the dialog's screens drop a pane instead of shrinking it", () => {
    const html = page();
    expect(html).toContain('class="site-hide-ph"'); // the board's Testing column
    expect(phone).toContain(".site-hide-ph { display:none !important; }");
    expect(phone).toContain(".site-tk-board { grid-template-columns:minmax(0, 1fr) minmax(0, 1fr) !important; }");
    expect(phone).toContain(".site-art-grid { grid-template-columns:minmax(0, 1fr) !important; }");
    expect(rules).toContain(".fxm-wide { display:none !important; }");
    expect(featureMock("handoffs")).toContain('class="fxm-hrow"');
    expect(featureMock("docs")).toContain('class="fxm-staged"');
    expect(featureMock("roadmap")).toContain('class="fxm-stats"');
    expect(phone).toContain(".fxm-hrow > :first-child { grid-column:1 / -1; }");
  });

  it("a tour row is copy then mockup, and Explore is a 44px bordered button", () => {
    expect(page().match(/class="site-tour-row"/g)).toHaveLength(7);
    expect(phone).toContain(".site-tour-row > * { flex-basis:100% !important; }");
    expect(phone).toMatch(/\.site-explore \{[^}]*min-height:44px;[^}]*border:1px solid/);
  });
});

describe("sheets on a phone — the tour's dialog, sign-in, Contact", () => {
  const phone = media("(max-width:640px)");

  it("the tour's dialog: full height in dvh, 48px Previous / Next clear of the home indicator, a 44px close", () => {
    expect(rules).toContain(".site-fx-panel { height:100dvh; }");
    expect(phone).toMatch(/\.site-fx-foot \{[^}]*padding:10px 12px calc\(10px \+ env\(safe-area-inset-bottom\)\); \}/);
    expect(phone).toMatch(/\.site-fx-nav \{[^}]*min-height:48px;/);
    expect(phone).toContain(".site-fx-x { top:8px; right:8px; width:44px; height:44px; }");
  });

  it("a swipe steps it: pan-y on the panel AND its scroller, pointer events in the controller, a scroll never a step", () => {
    expect(phone).toContain(".site-fx-panel, .site-fx-main { touch-action:pan-y; }");
    expect(mainSrc).toContain('mount.addEventListener("pointerdown", (e) => featureCtl.onPointerDown(e));');
    expect(mainSrc).toContain('mount.addEventListener("pointerup", (e) => featureCtl.onPointerUp(e));');
    expect(mainSrc).toContain('mount.addEventListener("pointercancel", () => featureCtl.onPointerCancel());');
    expect(swipeStep(-SWIPE_MIN_PX, 0, 200)).toBe(1);    // left: the next feature comes in from the right
    expect(swipeStep(SWIPE_MIN_PX, 10, 200)).toBe(-1);   // right: the previous one
    expect(swipeStep(-(SWIPE_MIN_PX - 1), 0, 200)).toBe(0); // too short
    expect(swipeStep(-120, 61, 200)).toBe(0);            // not sideways enough: that was a scroll
    expect(swipeStep(0, -300, 200)).toBe(0);
    expect(swipeStep(-200, 0, SWIPE_MAX_MS + 1)).toBe(0); // too slow: a drag, not a swipe
  });

  it("sign-in and Contact rise from the bottom edge and end where the keyboard begins", () => {
    expect(phone).toContain('[data-cnpy-theme] .site-signin-wrap:has(> [role="dialog"][aria-modal="true"]) { padding-bottom:var(--site-kb, 0px) !important; }');
    expect(phone).toContain('[data-cnpy-theme] .site-signin-card[role="dialog"][aria-modal="true"] { max-height:calc(100dvh - 20px - env(safe-area-inset-top) - var(--site-kb, 0px)) !important; }');
    expect(phone).toMatch(/\.site-signin-card \{[^}]*animation:site-sheet-up var\(--fx-slow\) var\(--fx-ease\) both; \}/);
    expect(phone).toMatch(/\.site-signin-btn \{[^}]*min-height:50px;/);
    expect(phone).toMatch(/\.site-signin-plans \.cnpy-seg-btn, \.site-contact-card \.cnpy-seg-btn \{ min-height:44px;/);
    expect(phone).toMatch(/\.site-contact-card \.cnpy-cmodal-btns \{ position:sticky; bottom:0;/);
    expect(phone).toMatch(/\.site-contact-card \{[^}]*scroll-padding-bottom:88px; \}/);
    // The app's own phone rules still do their part: 16px fields (no zoom on focus) and the safe area under a sheet.
    expect(rules).toMatch(/@media \(max-width:640px\) \{ input:not\(\[type="checkbox"\]\)[^{]*, textarea, select \{ font-size:16px !important; \} \}/);
    expect(rules).toContain("border-bottom:env(safe-area-inset-bottom, 0px) solid transparent !important;");
    expect(rules).toContain("@media (prefers-reduced-motion: reduce) { .site-signin-back, .site-signin-card, .site-signin-x, .site-signin-btn { animation:none !important; transition:none !important; } }");
  });

  it("the keyboard's height is what the visual viewport does not show; a few pixels are not a keyboard", () => {
    expect(coveredBottom(844, 508, 0)).toBe(336);
    expect(coveredBottom(844, 508, 20)).toBe(316); // the page was panned: less of the bottom is covered
    expect(coveredBottom(844, 844, 0)).toBe(0);
    expect(coveredBottom(844, 820, 0)).toBe(0);
    expect(mainSrc).toContain("initSiteViewport();");
  });
});

describe("pricing, the plugin card and the footer on a phone", () => {
  const phone = media("(max-width:640px)");

  it("pricing: finger-sized interval switch and plan buttons, roomier limits, questions in one column", () => {
    expect(phone).toMatch(/\.site-interval label \{ flex:1 1 0; padding:11px 14px;/);
    expect(phone).toMatch(/\.site-plan-cta \{[^}]*min-height:48px;/);
    expect(phone).toMatch(/\.site-plan-limits \{[^}]*font-size:14\.5px; \}/);
    expect(phone).toMatch(/\.site-faq summary \{ min-height:56px;/);
    expect(rules).toContain("@media (max-width:960px) { .site-plans { grid-template-columns:minmax(0, 1fr); } }");
    expect(rules).toContain("@media (max-width:860px) { .site-faq-wrap { grid-template-columns:minmax(0, 1fr); } .site-faq-side { position:static; } }");
    expect(pricingView(false)).toContain('class="site-faq" data-keep'); // the same accordion (site-faq.ts)
  });

  it("an install command keeps to its line inside its own box, and Copy is a labelled 44px button", () => {
    expect(phone).toMatch(/\.cnpy-site :has\(> \.cnpy-copybtn\) > pre \{ white-space:pre !important; overflow-wrap:normal !important; overflow-x:auto;/);
    expect(phone).toMatch(/\.cnpy-site \.cnpy-copybtn \{ position:static !important;[^}]*height:44px !important;/);
    expect(phone).toContain('.cnpy-site .cnpy-copybtn::after { content:"Copy"; }');
    expect(page()).toMatch(/<button data-act="copyPluginInstall" class="cnpy-copybtn" title="Copy" aria-label="Copy the install commands"/);
  });

  it("a finger has no hover: nothing stays lifted after a tap, and a press answers", () => {
    const touch = media("(hover:none)");
    expect(touch).toContain(".site-card:hover { transform:none; box-shadow:none; }");
    expect(touch).toContain(".site-plan:hover { translate:none; }");
    expect(touch).toContain(".site-fxcard:active::after { opacity:1; }");
  });

  it("the footer: the wide line is unchanged; a phone drops its bare text, lists the links as 44px rows and says the licence after the copyright", () => {
    for (const html of [siteFooter(), siteFooter("dialog")]) {
      expect(html).toContain(' · <a href="/pricing">Pricing</a> · <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a> · ');
      expect(html).toContain('</a> · Licensed under AGPL-3.0</span>');
      expect(html).toContain('<span>© 2026 TrovLabs, Inc.<span class="site-foot-lic"> · Licensed under AGPL-3.0</span></span>');
    }
    expect(phone).toMatch(/\.site-foot-links \{ display:flex; flex-wrap:wrap;[^}]*font-size:0; \}/);
    expect(phone).toMatch(/\.site-foot-links > a, \.site-foot-links > button \{ flex:0 0 50%;[^}]*min-height:44px;/);
    expect(phone).toContain(".site-foot-lic { display:inline; }");
    expect(phone).toMatch(/\.site-foot-r \{[^}]*text-align:left !important;/);
  });
});

describe("terms and privacy on a phone", () => {
  it("the contents are a disclosure: a button that names what it opens, folded by default, drawn open when asked", () => {
    for (const doc of [TERMS, PRIVACY]) {
      const html = legalView(doc, false);
      expect(html).toContain('<nav aria-label="Contents" class="site-legal-toc" data-open="0">');
      expect(html).toContain(`<button type="button" data-legal-tocb aria-expanded="false" aria-controls="site-legal-toc-list" class="site-legal-tocb"><span class="site-legal-toc-h">Contents</span><span class="site-legal-tocb-n">${doc.sections.length} sections</span>`);
      expect(html).toContain('<div class="site-legal-tocw"><ol id="site-legal-toc-list">');
      expect(html.match(/data-legal-toc="/g)).toHaveLength(doc.sections.length);
      const open = legalView(doc, false, true);
      expect(open).toContain('class="site-legal-toc" data-open="1"');
      expect(open).toContain('data-legal-tocb aria-expanded="true"');
    }
  });

  it("the rules: the heading becomes the button under 900px, the list folds with no layout left behind, links are 44px rows", () => {
    const tablet = media("(max-width:900px)");
    expect(tablet).toContain(".site-legal-toc > .site-legal-toc-h { display:none; }");
    expect(tablet).toMatch(/\.site-legal-tocb \{ display:flex;[^}]*min-height:52px;/);
    expect(tablet).toContain(".site-legal-tocw { display:grid; grid-template-rows:0fr; transition:grid-template-rows var(--fx-slow) var(--fx-ease); }");
    expect(tablet).toContain('.site-legal-toc[data-open="1"] .site-legal-tocw { grid-template-rows:1fr; }');
    expect(tablet).toMatch(/\.site-legal-toc \.site-legal-tocw > ol \{ min-height:0; margin:0; overflow:hidden; visibility:hidden;/); // folded links leave the tab order
    const phone = media("(max-width:640px)");
    expect(phone).toMatch(/\.site-legal-toc a \{ align-items:center; min-height:44px;/);
    expect(phone).toContain(".site-legal-sec p, .site-legal-sec li { font-size:16px; line-height:1.72; }");
    expect(phone).toMatch(/\.site-legal-tab \{ flex:1 1 0; padding:12px 10px;/);
    // Motion is off under reduced motion through the site's one rule.
    expect(rules).toContain(".cnpy-site *, .cnpy-site *::before, .cnpy-site *::after { transition:none !important; animation:none !important; }");
  });

  it("the page script opens and closes it, keeps it across the theme toggle, and folds it AT ONCE before a contents link scrolls", () => {
    expect(legalPageSrc).toContain('if ((e.target as Element).closest("[data-legal-tocb]")) { setToc(!tocOpen); return; }');
    expect(legalPageSrc).toContain("legalView(doc, t === \"dark\", tocOpen)");
    expect(legalPageSrc.indexOf("if (tocOpen) setToc(false, true);")).toBeGreaterThan(0);
    expect(legalPageSrc.indexOf("if (tocOpen) setToc(false, true);")).toBeLessThan(legalPageSrc.indexOf("sec.scrollIntoView({ behavior:"));
  });
});

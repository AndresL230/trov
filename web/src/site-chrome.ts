// The site chrome the landing page (web/src/landing.ts) and the legal pages
// (web/src/legal.ts) share: the Trov mark and the footer. Its own module so the
// legal pages load this, not the landing and its mockups.

import { trovMark } from "@shared/mark";
import { LEGAL_EMAIL, NOTICES_PATH, PRIVACY_PATH, REFUNDS_PATH, SOURCE_PATH, TERMS_PATH, TROV_SOURCE_REPO, copyrightLine } from "@shared/legal-core";

/** The Trov source repo (the site's "Read the code"). Not ./github's REPO_URL —
 *  that one is the product repo whose issues the app links to. */
export const TROV_REPO = TROV_SOURCE_REPO;

/** Where the site's questions go — the address Trov sends its mail from. Here, not in
 *  legal.ts, so the landing's pricing section does not pull the legal texts into the app. */
export const SITE_CONTACT = LEGAL_EMAIL;

/** The Trov mark. */
export function siteMark(size: number): string {
  return trovMark(size);
}

/** The page's own background (`<html>`, behind every root) in a theme's `--bg`, so an overscroll or the
 *  instant before a paint is never a white band. Set only when it changes. */
export const PAGE_BG = { light: "#f6f6f7", dark: "#1c1a16" } as const;
let pageBg: "light" | "dark" | null = null;
export function syncPageBackground(html: HTMLElement, theme: "light" | "dark"): void {
  if (pageBg === theme) return;
  pageBg = theme;
  html.style.background = PAGE_BG[theme];
}

/** The themed root a static page paints into its mount (pricing-page.ts, legal-page.ts) — and what the
 *  build prerenders there (site-prerender.ts), so the boot script repaints the same markup. */
export function siteRoot(theme: "light" | "dark", inner: string): string {
  return `<div data-cnpy-theme="${theme}" style="background:var(--bg);color:var(--fg);min-height:calc(100 * var(--vh));font-family:'Geist','Geist Fallback',system-ui,-apple-system,sans-serif;font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased">${inner}</div>`;
}

/** The first thing a keyboard reaches on every page (the site's and the app's): a link that jumps over the
 *  nav to the page's main content, hidden until it has focus (trov.css `.site-skip`). `href` names the
 *  target for a browser with no script; main.ts and the static pages' boots move the focus there WITHOUT
 *  writing the hash (`[data-skip]`) — on the app and the landing the hash is the route and the sign-in
 *  return-to. The target is a `tabindex="-1"` element with that id. */
export const SKIP_TARGET = "site-main";
export function skipLink(target: string = SKIP_TARGET): string {
  return `<a href="#${target}" class="site-skip" data-skip="${target}" style="border-radius:8px">Skip to content</a>`;
}
/** A click (or Enter) on a skip link: focus its target and leave the URL alone. true when it handled it.
 *  The boots call it from their click handlers (main.ts, legal-page.ts, pricing-page.ts, docs-page.ts). */
export function followSkipLink(e: Event): boolean {
  const link = (e.target as Element | null)?.closest?.("[data-skip]");
  const target = link ? document.getElementById(link.getAttribute("data-skip") ?? "") : null;
  if (!target) return false;
  e.preventDefault();
  target.focus();
  return true;
}

// Shared with the legal pages (web/src/legal.ts), the docs and the pricing page (web/src/pricing.ts).
// Pricing, Terms, Privacy and Refunds are PATHS (/pricing, /terms, /privacy, /refunds — static pages,
// readable signed out), never hash routes. Source is `/source` (shared/legal-core.ts `SOURCE_PATH`), which
// the build points at the deployed commit on GitHub (AGPL-3.0 §13); Licenses is the third-party notices.
//
// `contact`: the landing page opens the Contact form in place (`"dialog"` — the support dialog, signed
// out or in); the static pages (pricing, the legal pages, the docs) have no app behind them, so their link
// goes to `/?contact=1`, which opens it on the landing page (main.ts reads the parameter once).
export const CONTACT_HREF = "/?contact=1";
export function siteFooter(contact: "dialog" | "link" = "link"): string {
  const link = contact === "dialog"
    ? `<button type="button" data-act="supportOpen" data-arg="question" data-support-trigger="question" data-field="supportOpen:question" aria-haspopup="dialog" style="padding:0;font:inherit;color:inherit;text-decoration:underline;text-underline-offset:3px;text-decoration-color:var(--border-strong);cursor:pointer">Contact</button>`
    : `<a href="${CONTACT_HREF}">Contact</a>`;
  // A phone stacks the links as a tappable list, two to a row (trov.css `.site-foot*`): the line's
  // separators are bare text, which the list drops (`font-size:0` on the line, restored on each link).
  // The business details — who runs Trov, and where — are the last line; the address to write to is a link.
  return `<footer class="site-foot" style="margin-top:150px;border-top:1px solid var(--border)">
    <div class="site-foot-in" style="max-width:1120px;margin:0 auto;padding:44px 24px 56px;display:flex;gap:24px;align-items:flex-start;flex-wrap:wrap">
      <div style="display:flex;align-items:center;gap:9px">
        ${siteMark(18)}
        <span style="font-size:14.5px;font-weight:650">Trov</span>
      </div>
      <div class="site-foot-r" style="margin-left:auto;display:flex;flex-direction:column;gap:6px;text-align:right;font-size:13px;color:var(--fg-55)">
        <span>A shared working memory for teams and their coding agents.</span>
        <span class="site-foot-links">${link} · <a href="mailto:${LEGAL_EMAIL}">${LEGAL_EMAIL}</a> · <a href="/pricing">Pricing</a> · <a href="${TERMS_PATH}">Terms</a> · <a href="${PRIVACY_PATH}">Privacy</a> · <a href="${REFUNDS_PATH}">Refunds</a> · <a href="${SOURCE_PATH}">Source (AGPL-3.0)</a> · <a href="${NOTICES_PATH}">Licenses</a></span>
        <span class="site-foot-biz">${copyrightLine()}</span>
      </div>
    </div>
  </footer>`;
}


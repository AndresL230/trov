// ── Page not found: what the Worker answers an unknown address with ─────────
// The `not-found` page of shared/site-pages.ts: built and prerendered like the other public pages
// (web/src/site-prerender.ts) and served by src/site.ts `notFound` with status 404 and `noindex`. It
// has NO script — a 404 is read once and left — so it carries no theme toggle; the build's theme boot
// still paints it in the visitor's stored theme. The site's own look: the legal pages' banner header
// (`.site-legal-band`, trov.css) and the shared footer.
import { trovMark } from "@shared/mark";
import { siteFooter, siteMark, skipLink } from "./site-chrome";

export const NOT_FOUND_TITLE = "Page not found";
export const NOT_FOUND_LEDE = "There is no page at this address. The link may be mistyped, or the page may have moved.";

const BANNER_ART = `<span class="site-banner-art" aria-hidden="true">${trovMark(100, "currentColor")}</span>`;

export function notFoundView(): string {
  return `<div class="cnpy-site">
    ${skipLink()}
    <nav class="site-nav" aria-label="Site" style="position:sticky;top:0;z-index:50;background:color-mix(in srgb, var(--bg) 86%, transparent);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)">
      <div class="site-navin" style="max-width:1120px;margin:0 auto;padding:0 24px;height:60px;display:flex;align-items:center;gap:28px">
        <a href="/" aria-label="Trov home" style="display:flex;align-items:center;gap:9px;color:var(--fg);text-decoration:none">
          ${siteMark(20)}
          <span style="font-size:16.5px;font-weight:650;letter-spacing:-0.01em">Trov</span>
        </a>
        <div style="margin-left:auto;display:flex;align-items:center;gap:10px">
          <a href="/pricing" class="site-navlink site-hide-sm">Pricing</a>
          <a href="/" class="cnpy-accentbtn" style="padding:7px 16px;border-radius:8px;background:var(--accent);color:var(--accent-fg);font-size:13.5px;font-weight:600;white-space:nowrap;text-decoration:none">Open Trov</a>
        </div>
      </div>
    </nav>
    <main id="site-main" tabindex="-1" class="site-hero">
      <div class="site-banner site-legal-band" style="border-radius:16px">
        ${BANNER_ART}
        <div class="site-legal-band-in">
          <div class="site-legal-date">Error 404</div>
          <h1 class="site-legal-h">${NOT_FOUND_TITLE}</h1>
          <p class="site-legal-lede">${NOT_FOUND_LEDE}</p>
          <div class="site-hero-cta">
            <a href="/" class="site-btn site-btn-onb">Go to the home page</a>
            <a href="/pricing" class="site-btn site-btn-onb-line">See pricing</a>
          </div>
        </div>
      </div>
    </main>
    ${siteFooter()}
  </div>`;
}

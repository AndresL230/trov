// The site chrome the landing page (web/src/landing.ts) and the legal pages
// (web/src/legal.ts) share: the Trov mark and the footer. Its own module so the
// legal pages load this, not the landing and its mockups.

import { trovMark } from "@shared/mark";

/** The Trov source repo (the site's "Read the code"). Not ./github's REPO_URL —
 *  that one is the product repo whose issues the app links to. */
export const TROV_REPO = "https://github.com/AndresL230/trov";

/** The Trov mark. */
export function siteMark(size: number): string {
  return trovMark(size);
}

// Shared with the legal pages (web/src/legal.ts). Terms and Privacy are PATHS
// (/terms, /privacy — static pages, readable signed out), never hash routes.
export function siteFooter(): string {
  return `<footer style="margin-top:150px;border-top:1px solid var(--border)">
    <div style="max-width:1120px;margin:0 auto;padding:44px 24px 56px;display:flex;gap:24px;align-items:flex-start;flex-wrap:wrap">
      <div style="display:flex;align-items:center;gap:9px">
        ${siteMark(18)}
        <span style="font-size:14.5px;font-weight:650">Trov</span>
      </div>
      <div style="margin-left:auto;display:flex;flex-direction:column;gap:6px;text-align:right;font-size:13px;color:var(--fg-55)">
        <span>Built for the Sapling team. Currently limited to SaplingLearn members.</span>
        <span><a href="/terms">Terms</a> · <a href="/privacy">Privacy</a> · <a href="${TROV_REPO}" target="_blank" rel="noopener">GitHub</a> · Licensed under AGPL-3.0</span>
        <span>© 2026 Andres Lopez</span>
      </div>
    </div>
  </footer>`;
}


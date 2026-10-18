// The brand banner the site's own pages open with (/terms, /privacy, /refunds and the public docs — `.site-banner` in
// trov.css), for the app's reading pages: What's new (releases.ts) and the Guide (render.ts `guideView`). The owner's
// call (2026-10-18): one brand across the site and these pages. A purple card with the faint Trov mark, then an
// optional row above the title (a page's tabs, which trov.css draws as the site's white pills), the title, the lede,
// and a quiet line under it. Pure markup: the title is escaped here; `lede`, `above` and `below` are markup the
// caller built (and escaped).
import { trovMark } from "@shared/mark";
import { attr, esc } from "./ui";

export interface BrandBanner {
  title: string;
  /** The title's id (an anchor the page's contents link to). */
  titleId?: string;
  /** More classes on the title (the Guide's anchor class). */
  titleCls?: string;
  lede?: string;
  above?: string;
  below?: string;
}

export function brandBanner(o: BrandBanner): string {
  return `<header class="cnpy-brandband site-banner" style="border-radius:16px">
    <span class="site-banner-art" aria-hidden="true">${trovMark(100, "currentColor")}</span>
    <div class="cnpy-brandband-in">
      ${o.above ? `<div class="cnpy-brandband-above">${o.above}</div>` : ""}
      <h1${o.titleId ? ` id="${attr(o.titleId)}"` : ""} class="cnpy-brandband-h${o.titleCls ? ` ${attr(o.titleCls)}` : ""}">${esc(o.title)}</h1>
      ${o.lede ? `<p class="cnpy-brandband-lede">${o.lede}</p>` : ""}
      ${o.below ? `<div class="cnpy-brandband-below">${o.below}</div>` : ""}
    </div>
  </header>`;
}

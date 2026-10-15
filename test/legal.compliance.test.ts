/**
 * The compliance pass (2026-10-12) across every surface, not one page: the consent sentence wherever an
 * account can be made, the refund policy as a public page, the footer's business details, the price math a
 * buyer sees before paying, the AGPL source link in the app, on the Worker's own pages and in the MCP server,
 * the onboarding form's labels, and the third-party notices. The legal texts themselves: render.legal.test.ts;
 * the Worker's side (OAuth pages, billing notices, the paid mail, MCP, /source, the sitemap): legal.worker.test.ts.
 */
import { describe, it, expect } from "vitest";
import {
  CONSENT_TEXT, LEGAL_ENTITY, LEGAL_STATE, MIN_AGE, NOTICES_PATH, REFUNDS_PATH, SOURCE_PATH, TROV_SOURCE_REPO,
  agreeHtml, consentHtml, copyrightLine, sourceUrl,
} from "../shared/legal-core";
import { PRICING, seatMath, CHECKOUT_TAX, RENEWAL_TERMS } from "../shared/pricing";
import { SITE_PAGES, assetRedirects, assetHeaders } from "../shared/site-pages";
import { RESERVED_ORG_SLUGS } from "../shared/orgs";
import { landingView } from "../web/src/landing";
import { siteFooter, skipLink } from "../web/src/site-chrome";
import { legalTabs, LEGAL_DOCS } from "../web/src/legal";
import { initialOnboard, onboardView } from "../web/src/people";
import { render, initialState, helpSection, legalLinksRow, GUIDE_ALT } from "../web/src/render";
import { releasesIndex } from "../web/src/releases";
import notices from "../THIRD-PARTY-NOTICES.txt?raw";

const CONSENT = 'By continuing you agree to the <a href="/terms">Terms of Service</a> and <a href="/privacy">Privacy Policy</a>, and confirm you are 16 or older.';

describe("consent — said wherever an account can be made, never pre-ticked", () => {
  it("one sentence, one age: 16", () => {
    expect(MIN_AGE).toBe(16);
    expect(consentHtml()).toBe(CONSENT);
    expect(CONSENT_TEXT).toBe(CONSENT.replace(/<[^>]+>/g, ""));
  });

  it("the landing's sign-in / get-started dialog, every mode and plan", () => {
    for (const [mode, plan] of [["signin", "free"], ["signup", "free"], ["signup", "team"]] as const) {
      const html = landingView({ dark: false, signInOpen: true, signInMode: mode, signInPlan: plan, seen: new Set() });
      const dialog = html.slice(html.indexOf('data-overlay="signin"'));
      expect(dialog, `${mode}/${plan}`).toContain(CONSENT);
    }
  });

  it("the app's auth view: the sign-in card a refused Google sign-in shows", () => {
    const html = render({ ...initialState(), view: "auth", authStep: "unverified", deniedEmail: "kim@example.com" });
    expect(html).toContain(CONSENT);
  });

  it("onboarding, where the account is created: an unchecked, required box, and Continue waits for it", () => {
    const o = { ...initialOnboard(), handle: "kim", check: "available" as const };
    const html = onboardView(o);
    expect(html).toMatch(/<input type="checkbox" id="onb-agree" data-act="onbAgree" data-field="onbAgree" required style=/);
    expect(html).not.toMatch(/id="onb-agree"[^>]*checked/);
    expect(html).toContain(agreeHtml('style="color:var(--fg)"'));
    expect(agreeHtml()).toContain("I agree to the");
    expect(html).toMatch(/data-act="onbSubmit"[^>]*disabled/);
    expect(onboardView({ ...o, agreed: true })).toMatch(/id="onb-agree"[^>]*checked/);
    expect(onboardView({ ...o, agreed: true })).not.toMatch(/data-act="onbSubmit"[^>]*disabled/);
    // Coming back to edit an account that exists asks nothing again.
    expect(onboardView({ ...o, edit: { current: "kim" } })).not.toContain("onb-agree");
  });

});

describe("the onboarding form names every field", () => {
  it("Handle and Display name are labelled inputs; the help and the availability describe the handle; the colors are a named group", () => {
    const html = onboardView({ ...initialOnboard(), handle: "kim" });
    expect(html).toContain('<label for="onb-handle"');
    expect(html).toContain('<input id="onb-handle" aria-describedby="onb-handle-help onb-handle-status"');
    expect(html).toContain('<div id="onb-handle-help"');
    expect(html).toContain('<span id="onb-handle-status" aria-live="polite"');
    expect(html).toContain('<label for="onb-name"');
    expect(html).toContain('<input id="onb-name"');
    expect(html).toContain('<div id="onb-color-l"');
    expect(html).toContain('role="radiogroup" aria-labelledby="onb-color-l"');
  });
});

describe("the Refund and Cancellation Policy is a public page like the others", () => {
  it("is a page of SITE_PAGES, in the sitemap, with its card, its reserved slug and its tab", () => {
    const p = SITE_PAGES.find((x) => x.path === REFUNDS_PATH)!;
    expect(p).toMatchObject({ key: "refunds", kind: "legal", indexed: true, image: { path: "/og/refunds.png" } });
    expect(LEGAL_DOCS.refunds.title).toBe("Refund and Cancellation Policy");
    expect(RESERVED_ORG_SLUGS).toContain("refunds");
    expect(legalTabs("terms")).toContain('<a href="/refunds" class="site-legal-tab"');
    expect(assetRedirects()).toContain("\n/refunds.html /refunds 301\n");
  });
});

describe("the footer — who runs Trov, where, how to write, and the source", () => {
  it("names TrovLabs, Inc. of New Jersey, links hello@trov.dev, and every legal page and the source", () => {
    expect(copyrightLine(2026)).toBe("© 2026 TrovLabs, Inc. · New Jersey");
    expect(LEGAL_ENTITY).toBe("TrovLabs, Inc.");
    expect(LEGAL_STATE).toBe("New Jersey");
    for (const html of [siteFooter(), siteFooter("dialog")]) {
      expect(html).toContain(`<span class="site-foot-biz">${copyrightLine()}</span>`);
      expect(html).toContain('<a href="mailto:hello@trov.dev">hello@trov.dev</a>');
      for (const path of ["/terms", "/privacy", "/refunds", SOURCE_PATH, NOTICES_PATH]) expect(html).toContain(`href="${path}"`);
      expect(html).toContain(">Source (AGPL-3.0)</a>");
      expect(html).toMatch(/>Contact</); // the Contact form stays
    }
  });

  it("every public page starts with a skip link to its main content", () => {
    expect(skipLink()).toBe('<a href="#site-main" class="site-skip" data-skip="site-main" style="border-radius:8px">Skip to content</a>');
    const landing = landingView({ dark: false, signInOpen: false, seen: new Set() });
    expect(landing.indexOf(skipLink())).toBeLessThan(landing.indexOf("<nav"));
    expect(landing).toContain('<main id="site-main" tabindex="-1">');
  });
});

describe("before paying: the price, the math, tax, renewal and the policy", () => {
  it("seatMath: seats × the per-seat price, per month, at least one seat", () => {
    expect(seatMath(3)).toBe("3 seats × $10 = $30 per month");
    expect(seatMath(1)).toBe("1 seat × $10 = $10 per month");
    expect(seatMath(0)).toBe("1 seat × $10 = $10 per month");
    expect(seatMath(2.7)).toBe("2 seats × $10 = $20 per month");
    expect(seatMath(3, { ...PRICING.team, price: 12.5 })).toBe("3 seats × $12.50 = $37.50 per month");
    expect(seatMath(3, PRICING.free)).toBeNull(); // Free is never bought
    expect(seatMath(3, PRICING.enterprise)).toBeNull(); // nor is a plan with no price
  });

  it("the words are one copy: tax at checkout, monthly renewal, cancel from Billing", () => {
    expect(CHECKOUT_TAX).toBe("Plus applicable tax, calculated at checkout.");
    expect(RENEWAL_TERMS).toBe("Renews monthly until you cancel; cancel any time from Billing.");
  });

});

describe("AGPL-3.0 §13 — the source of the running version, offered wherever Trov is used", () => {
  it("/source goes to the deployed commit (or the repository), from the build's own _redirects; the slug is reserved", () => {
    expect(sourceUrl(null)).toBe(TROV_SOURCE_REPO);
    expect(sourceUrl("ABCDEF1")).toBe(`${TROV_SOURCE_REPO}/tree/abcdef1`);
    expect(sourceUrl("main; drop")).toBe(TROV_SOURCE_REPO);
    expect(RESERVED_ORG_SLUGS).toContain("source");
    expect(assetHeaders()).toContain(`${NOTICES_PATH}\n  Content-Type: text/plain; charset=utf-8`);
  });

  it("the signed-in app: Settings › Help and Help › What's new", () => {
    expect(helpSection()).toContain(legalLinksRow());
    for (const href of ["/terms", "/privacy", "/refunds", SOURCE_PATH, NOTICES_PATH]) expect(legalLinksRow()).toContain(`href="${href}"`);
    expect(legalLinksRow()).toContain(">Source code (AGPL-3.0)</a>");
    expect(releasesIndex()).toMatch(/href="\/source"[^>]*data-source-link>the source code of the version you are using<\/a>/);
  });

});

describe("the third-party notices", () => {
  it("lists what the browser and the Worker ship, with licences — the fonts, the icons, and the libraries named in the pass", () => {
    for (const name of ["dompurify@", "marked@", "mermaid@", "katex@", "hono@", "zod@", "@modelcontextprotocol/sdk@", "agents@"]) expect(notices, name).toContain(name);
    expect(notices).toMatch(/Geist \(font\)\s+—\s+OFL-1\.1/);
    expect(notices).toMatch(/ArchivoNarrow \(font\)\s+—\s+OFL-1\.1/);
    expect(notices).toContain("SIL OPEN FONT LICENSE Version 1.1");
    expect(notices).toContain("Lucide icons");
    expect(notices).toMatch(/dompurify@[\d.]+\nLicence: \(MPL-2\.0 OR Apache-2\.0\) — used under Apache-2\.0/);
    expect(notices).not.toMatch(/Licence: UNKNOWN/);
  });

  it("the guide's screenshots each have a text alternative", () => {
    for (const [name, alt] of Object.entries(GUIDE_ALT)) expect(alt.length, name).toBeGreaterThan(10);
  });
});

/**
 * The legal pages (web/src/legal.ts): public paths, linked from the landing footer,
 * rendered from one pure function with a section anchor per heading.
 */
import { describe, it, expect } from "vitest";
import { LEGAL_DOCS, TERMS, PRIVACY, LEGAL_CONTACT, legalDate, legalView } from "../web/src/legal";
import { landingView } from "../web/src/landing";
import { siteFooter } from "../web/src/site-chrome";

describe("legal pages", () => {
  it("the landing footer links Terms and Privacy as paths, never hash routes", () => {
    const html = landingView({ dark: false, signInOpen: false, seen: new Set() });
    expect(html).toContain('<a href="/terms">Terms</a>');
    expect(html).toContain('<a href="/privacy">Privacy</a>');
    expect(html).not.toMatch(/href="#(terms|privacy)"/);
  });

  for (const doc of [TERMS, PRIVACY]) {
    describe(doc.title, () => {
      const html = legalView(doc, false);

      it("renders the title, the date, a contents list and every section with its anchor", () => {
        expect(html).toContain(`>${doc.title}</h1>`);
        expect(html).toContain(`Last updated ${legalDate(doc.updated)}`);
        for (const s of doc.sections) {
          expect(html).toContain(`<section id="${s.id}" class="site-legal-sec">`);
          expect(html).toContain(`<a href="#${s.id}" data-legal-toc="${s.id}">`);
        }
      });

      it("has unique section ids, a contact section and the shared footer", () => {
        const ids = doc.sections.map((s) => s.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(html).toContain(`mailto:${LEGAL_CONTACT}`);
        expect(html).toContain(siteFooter());
      });

      it("links across to the other document and back home", () => {
        const other = doc.kind === "terms" ? "privacy" : "terms";
        expect(html).toContain(`href="/${other}"`);
        expect(html).toContain('<a href="/"');
      });

      it("the toggle icon follows the theme", () => {
        expect(legalView(doc, true)).not.toBe(html);
        expect(html).toContain("data-legal-theme");
      });
    });
  }

  it("names every processor that receives personal data", () => {
    const text = PRIVACY.sections.map((s) => s.body.join(" ")).join(" ");
    for (const name of ["Cloudflare", "Stripe", "Gemini", "Resend", "Google Fonts", "GitHub"]) expect(text).toContain(name);
  });

  it("the terms say how a paid plan is billed, changed, cancelled and ended, in the pricing data's own numbers", () => {
    const plans = TERMS.sections.find((s) => s.id === "plans")!.body.join(" ");
    expect(plans).toContain("$10 per seat / month, for up to 50 people");
    expect(plans).toContain("holds up to 3 people");
    for (const word of ["Stripe", "Cancelling", "Refunds", "Seats", "moves to Free", "Nothing is deleted"]) expect(plans).toContain(word);
    // Sections are numbered in order, and the ones the text cites by number are the ones it means.
    TERMS.sections.forEach((s, i) => expect(s.title.startsWith(`${i + 1}. `)).toBe(true));
    PRIVACY.sections.forEach((s, i) => expect(s.title.startsWith(`${i + 1}. `)).toBe(true));
    expect(TERMS.sections[3].id).toBe("content");
    expect(TERMS.sections[9].id).toBe("disclaimer");
    expect(TERMS.sections[11].id).toBe("changes");
  });

  it("opens on the site's banner, with both documents one click apart and a short summary first", () => {
    const html = legalView(TERMS, false);
    expect(html).toContain('class="site-banner site-legal-band"');
    expect(html).toContain('<span class="site-legal-tab" aria-current="page" style="border-radius:8px">Terms of Service</span>');
    expect(html).toContain('<a href="/privacy" class="site-legal-tab" style="border-radius:8px">Privacy Policy</a>');
    for (const b of TERMS.brief) expect(html).toContain(`<li>${b}</li>`);
    expect(html).toContain('<span class="site-legal-n" style="border-radius:7px">3</span>Plans, payment and cancellation</h2>');
  });

  it("dates read in fixed English", () => {
    expect(legalDate("2026-10-06")).toBe("October 6, 2026");
    expect(Object.keys(LEGAL_DOCS).sort()).toEqual(["privacy", "terms"]);
  });
});

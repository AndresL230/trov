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
          expect(html).toContain(`<a href="#${s.id}">`);
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
    for (const name of ["Cloudflare", "Gemini", "Resend", "Google Fonts", "GitHub"]) expect(text).toContain(name);
  });

  it("dates read in fixed English", () => {
    expect(legalDate("2026-10-06")).toBe("October 6, 2026");
    expect(Object.keys(LEGAL_DOCS).sort()).toEqual(["privacy", "terms"]);
  });
});

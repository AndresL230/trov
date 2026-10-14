/**
 * The legal pages (web/src/legal.ts): the Terms of Service, the Privacy Policy and the Refund and
 * Cancellation Policy — public paths, linked from every footer, rendered from one pure function with a
 * section anchor per heading, and written from what the code does (the compliance pass, 2026-10-12).
 */
import { describe, it, expect } from "vitest";
import { LEGAL_DOCS, LEGAL_ORDER, TERMS, PRIVACY, REFUNDS, LEGAL_CONTACT, LEGAL_OPERATOR, legalDate, legalTabs, legalView, type LegalDoc } from "../web/src/legal";
import { landingView } from "../web/src/landing";
import { siteFooter } from "../web/src/site-chrome";

const text = (doc: LegalDoc): string => [doc.lede, ...doc.brief, ...doc.sections.flatMap((s) => [s.title, ...s.body])].join(" ");
const section = (doc: LegalDoc, id: string): string => doc.sections.find((s) => s.id === id)!.body.join(" ");
const ALL = [TERMS, PRIVACY, REFUNDS];

describe("legal pages", () => {
  it("the landing footer links Terms, Privacy and Refunds as paths, never hash routes", () => {
    const html = landingView({ dark: false, signInOpen: false, seen: new Set() });
    expect(html).toContain('<a href="/terms">Terms</a>');
    expect(html).toContain('<a href="/privacy">Privacy</a>');
    expect(html).toContain('<a href="/refunds">Refunds</a>');
    expect(html).not.toMatch(/href="#(terms|privacy|refunds)"/);
  });

  for (const doc of ALL) {
    describe(doc.title, () => {
      const html = legalView(doc, false);

      it("renders the title, the effective date, a contents list and every section with its anchor", () => {
        expect(html).toContain(`>${doc.title}</h1>`);
        expect(html).toContain(`Effective and last updated ${legalDate(doc.updated)}`);
        // Terms and Privacy were updated when summaries moved to Anthropic; Refunds is as rewritten.
        expect(doc.updated).toBe(doc.kind === "refunds" ? "2026-10-12" : "2026-10-14");
        for (const s of doc.sections) {
          expect(html).toContain(`<section id="${s.id}" class="site-legal-sec">`);
          expect(html).toContain(`<a href="#${s.id}" data-legal-toc="${s.id}"><span class="site-legal-toc-n">`);
        }
      });

      it("has unique section ids numbered in order, a contact section and the shared footer", () => {
        const ids = doc.sections.map((s) => s.id);
        expect(new Set(ids).size).toBe(ids.length);
        doc.sections.forEach((s, i) => expect(s.title.startsWith(`${i + 1}. `), s.title).toBe(true));
        expect(ids[ids.length - 1]).toBe("contact");
        expect(html).toContain(`mailto:${LEGAL_CONTACT}`);
        expect(section(doc, "contact")).toContain(`${LEGAL_OPERATOR}, New Jersey, United States.`);
        expect(html).toContain(siteFooter());
      });

      it("links across to the other two documents and back home, and starts with a skip link to its main content", () => {
        for (const other of LEGAL_ORDER.filter((k) => k !== doc.kind)) expect(html).toContain(`href="/${other}"`);
        expect(html).toContain('<a href="/"');
        expect(html.indexOf('class="site-skip"')).toBeLessThan(html.indexOf("<nav"));
        expect(html).toContain('<main id="site-main" tabindex="-1" class="site-legal">');
      });

      it("the toggle icon follows the theme", () => {
        expect(legalView(doc, true)).not.toBe(html);
        expect(html).toContain("data-legal-theme");
      });
    });
  }

  it("the tab row names every document, the current one marked: links a keyboard reaches, in a labelled nav", () => {
    const row = legalTabs("refunds");
    expect(row).toBe('<nav class="site-legal-tabs" aria-label="Legal documents"><a href="/terms" class="site-legal-tab" style="border-radius:8px">Terms</a><a href="/privacy" class="site-legal-tab" style="border-radius:8px">Privacy</a><span class="site-legal-tab" aria-current="page" style="border-radius:8px">Refunds</span></nav>');
    for (const doc of ALL) expect(legalView(doc, false)).toContain(legalTabs(doc.kind));
    expect(Object.keys(LEGAL_DOCS)).toEqual(["terms", "privacy", "refunds"]);
    expect(LEGAL_ORDER).toEqual(["terms", "privacy", "refunds"]);
  });

  it("names the operator: TrovLabs, Inc., a New Jersey corporation, and the age rule (16) the same way everywhere", () => {
    expect(section(TERMS, "about")).toContain("<b>TrovLabs, Inc.</b>, a New Jersey corporation");
    expect(section(PRIVACY, "who")).toContain("TrovLabs, Inc., a New Jersey corporation");
    expect(section(TERMS, "accounts")).toContain("You must be at least 16 years old to use Trov.");
    expect(section(PRIVACY, "children")).toContain("is not for anyone under 16");
    expect(section(TERMS, "law")).toContain("the laws of the State of New Jersey");
  });

  it("names every processor that receives personal data, and no service Trov does not use", () => {
    const privacy = text(PRIVACY);
    for (const name of ["Cloudflare", "Stripe", "Anthropic", "Resend", "GitHub", "Google", "Railway", "Cloudflare Analytics"]) expect(privacy).toContain(name);
    // Not integrated: never named in any legal text.
    for (const doc of ALL) expect(text(doc)).not.toMatch(/Vercel|Netlify/i);
  });

  it("the terms say how Pro is billed, renewed, cancelled and refunded, in the pricing data's own numbers", () => {
    const plans = section(TERMS, "plans");
    expect(plans).toContain("$10 per seat / month — $10 for each seat, each month — for up to 50 seats");
    expect(plans).toContain("holds up to 3 people");
    expect(plans).toContain("on the same day of the month (the subscription's anniversary)");
    expect(plans).toContain("<b>until you cancel</b>");
    expect(plans).toContain("Stripe calculates it at checkout");
    const cancel = section(TERMS, "cancel");
    expect(cancel).toContain("as easily as subscribing");
    expect(cancel).toContain("<b>No refunds for partial periods</b>, except where the law requires one");
    expect(cancel).toContain('href="/refunds"');
    expect(cancel).toContain("cancels its subscription at once, with no refund");
    expect(section(TERMS, "open-source")).toContain('href="/source"');
    expect(section(TERMS, "open-source")).toContain('href="/third-party-notices.txt"');
  });

  it("no longer says what the code does not do", () => {
    const all = ALL.map(text).join(" ");
    expect(all).not.toContain("read:org"); // GitHub sign-in asks for read:user and user:email only
    expect(all).not.toMatch(/Seats cannot be reduced below/);
    expect(all).not.toMatch(/at the start of each month/);
    expect(all).not.toMatch(/expired and revoked tokens are cleared/);
    expect(all).not.toMatch(/and to nobody else/);
    expect(all).not.toMatch(/Google Fonts — the site's typefaces/);
    expect(all).not.toMatch(/every digest has a one-click unsubscribe/);
  });

  it("the privacy policy lists every cookie with its lifetime, the browser storage, and says why there is no banner", () => {
    const cookies = section(PRIVACY, "cookies");
    for (const [name, life] of [["session", "30 days"], ["oauth_tx", "10 minutes"], ["onboard", "10 minutes"], ["oauth_pending", "10 minutes"], ["return_to", "10 minutes"], ["gh_install", "15 minutes"]]) {
      expect(cookies).toMatch(new RegExp(`<td><code>${name}</code></td><td>[^<]*(<code>[^<]*</code>[^<]*)?</td><td>${life}</td>`));
    }
    expect(cookies).toContain("no cookie banner");
    for (const key of ["trov.theme", "trov.org", "trov.returnHash", "trov.welcomeReturn", "trov:first-run"]) expect(cookies).toContain(key);
  });

  it("the privacy policy states the retention it used to leave out, and what deletion keeps", () => {
    const retention = section(PRIVACY, "retention");
    for (const phrase of ["400 days", "2 days", "admin history", "Bug reports and support messages", "Email send log", "an expired one is kept until your account is deleted", "a revoked pasted token", "Up to 30 days of point-in-time history"]) {
      expect(retention).toContain(phrase);
    }
    const deletion = section(PRIVACY, "deletion");
    expect(deletion).toContain("Settings › Delete account");
    expect(deletion).toContain("Org settings › General › Delete organization");
    expect(deletion).toContain("\"Deleted user\"");
    expect(deletion).toContain("Stripe keeps its records");
  });

  it("the privacy policy is honest about operators, what the browser loads from others, and email", () => {
    const sharing = section(PRIVACY, "sharing");
    expect(sharing).toContain("Their tools do not show an organization's content");
    expect(sharing).toContain("only for support, security or legal reasons");
    const browser = section(PRIVACY, "browser");
    expect(browser).toContain("opening the site or the app sends nothing to Google Fonts or a script CDN");
    expect(browser).toContain("<b>Profile pictures</b> from GitHub or Google");
    const email = section(PRIVACY, "email");
    expect(email).toContain("on by default");
    expect(email).toContain("works without signing in");
    expect(email).toContain("does not expire");
    expect(email).toContain("Resend");
  });

  it("the refund policy is the owner's: cancel any time, Pro to the end of the period, no partial refunds but where the law requires, deletion cancels at once", () => {
    const all = text(REFUNDS);
    expect(section(REFUNDS, "cancel")).toContain("Org settings › General › Plan › Cancel plan");
    expect(section(REFUNDS, "after")).toContain("stays active until the end of the period already paid");
    expect(section(REFUNDS, "refunds")).toContain("<b>except where the law requires a refund</b>");
    expect(section(REFUNDS, "refunds")).toContain(`mailto:${LEGAL_CONTACT}`);
    expect(section(REFUNDS, "delete")).toContain("<b>immediately</b>, with no refund");
    expect(section(REFUNDS, "billing")).toContain("3 seats × $10 = $30 a month");
    expect(all).not.toMatch(/money.back|full refund|guarantee/i);
  });

  it("opens on the site's banner with a short summary first", () => {
    const html = legalView(TERMS, false);
    expect(html).toContain('class="site-banner site-legal-band"');
    for (const b of TERMS.brief) expect(html).toContain(`<li>${b}</li>`);
    expect(html).toContain('<span class="site-legal-n">5.</span>Plans, payment and renewal</h2>');
    expect(html).toContain('Also see the <a href="/privacy">Privacy Policy</a> and the <a href="/refunds">Refund and Cancellation Policy</a>.');
  });

  it("dates read in fixed English", () => {
    expect(legalDate("2026-10-06")).toBe("October 6, 2026");
  });
});

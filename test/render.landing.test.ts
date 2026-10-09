/**
 * The signed-out landing page (web/src/landing.ts): what it must keep saying, and the
 * banner it carries through the page (the first-run card's, one definition in trov.css).
 */
import { describe, it, expect } from "vitest";
import { landingView } from "../web/src/landing";
import { initialState, render } from "../web/src/render";
import css from "../web/src/trov.css?raw";

const out = (signInOpen = false, signedIn = false, seen: string[] = []) =>
  landingView({ dark: false, signInOpen, signedIn, seen: new Set(seen) });
const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("landing — the facts it states", () => {
  it("sign-up is open: GitHub or Google, no invitation, wherever sign-in is mentioned", () => {
    const html = out(true);
    expect(html).toContain("Sign up with GitHub or Google. No invitation needed");
    expect(html).toContain("Anyone can sign up with GitHub or Google.");
    expect(html).toContain("New to Trov? Either one creates your account. No invitation needed.");
    for (const gone of ["restricted to your org", "needs an invitation", "invite-only", "by invitation"]) expect(html).not.toContain(gone);
  });

  it("the help page is the Guide, never Get Started", () => {
    for (const html of [out(), out(false, true)]) {
      expect(html).not.toMatch(/Get started|Get Started/);
      expect(html).toContain("How Trov works, in the Guide");
    }
    // Signed out, the hero's first button opens Sign in; reopened from the app, it opens the Guide.
    expect(out()).toContain('<button data-act="openSignIn" class="site-btn site-btn-onb" style="border-radius:9px">Sign up free</button>');
    expect(out(false, true)).toContain('<button data-act="siteGuide" class="site-btn site-btn-onb" style="border-radius:9px">Open the Guide</button>');
  });

  it("links pricing as a path and restates no price in the hero", () => {
    const hero = out().slice(out().indexOf('id="site-top"'), out().indexOf("</header>"));
    expect(hero).toContain('<a href="/pricing">See pricing</a>');
    expect(hero).not.toMatch(/\$\d/);
  });

  it("keeps every section and its jump target", () => {
    const html = out();
    for (const id of ["site-top", "site-how", "site-tour", "site-agents", "site-security", "site-pricing"]) expect(html).toContain(`id="${id}"`);
    for (const h of ["Orient, work, record.", "Agents propose, people decide.", "One place for what the team knows.", "For agents", "Security, in plain terms"]) expect(html).toContain(h);
  });
});

describe("landing — the banner carried through the page", () => {
  it("the hero, the authority card and the sign-in dialog are the same banner, each with the mark behind its text", () => {
    const html = out(true);
    expect(html.match(/class="site-banner /g)?.length).toBe(3);
    expect(html.match(/class="site-banner-art" aria-hidden="true"/g)?.length).toBe(3);
    expect(html).toContain('class="site-banner site-hero-band"');
    expect(html).toContain('class="site-banner site-split-banner"');
    expect(html).toContain('class="site-banner site-signin-banner"');
    expect(out().match(/class="site-banner /g)?.length).toBe(2);
  });

  it("is ONE definition with the first-run card's banner", () => {
    expect(rules).toMatch(/\.cnpy-orgs-banner, \.site-banner \{[^}]*linear-gradient\(135deg, #6c75d8 0%, #5a64cc 48%, #454fb2 100%\)/);
    expect(rules).toMatch(/\.cnpy-orgs-banner::after, \.site-banner::after \{[^}]*background-size:16px 16px/);
  });

  it("every tour mockup stands on a dot field, flipped with its row", () => {
    const html = out();
    expect(html.match(/site-stage/g)?.length).toBe(7);
    expect(html.match(/is-flip site-stage/g)?.length).toBe(3);
  });

  it("paints with no blur: nothing in the site's banner rules filters the page", () => {
    const from = rules.indexOf(".site-banner > * {");
    const block = rules.slice(from, rules.indexOf(".site-nav {", from));
    expect(from).toBeGreaterThan(0);
    expect(block).not.toMatch(/filter\s*:\s*blur|backdrop-filter/);
  });
});

describe("landing — a rerender replays nothing", () => {
  it("the page names itself for morph.ts and the dialog is one root-level overlay beside it", () => {
    const closed = render({ ...initialState(), view: "auth", authStep: "login", signInOpen: false });
    const open = render({ ...initialState(), view: "auth", authStep: "login", signInOpen: true });
    expect(closed).toContain('<div class="cnpy-site" data-morph="landing">');
    expect(closed).not.toContain('data-overlay="signin"');
    expect(open).toContain('<div data-overlay="signin">');
    // The page is the same markup whether the dialog is open or not: morph patches nothing in it.
    const page = (html: string) => html.slice(html.indexOf('<div class="cnpy-site"'), html.indexOf("</footer>"));
    expect(page(open)).toBe(page(closed));
  });

  it("a reveal that already played renders settled", () => {
    const html = out(false, false, ["hero-mock", "authority"]);
    expect(html).toMatch(/data-rv="hero-mock" class="site-rv rv-lift site-hero-mock is-done"/);
    expect(html).toMatch(/data-rv="authority" class="site-rv site-split is-done"/);
    expect(html).toMatch(/data-rv="docs-mock" class="site-rv rv-r site-stage"/);
  });

  it("the dialog keeps its focus target and both providers", () => {
    const html = out(true);
    expect(html).toMatch(/role="dialog" aria-modal="true" aria-labelledby="signin-title"/);
    expect(html).toMatch(/<button data-act="signIn" [^>]*>.*Continue with GitHub<\/button>/s);
    expect(html).toMatch(/<button data-act="signInGoogle" [^>]*>.*Continue with Google<\/button>/s);
    expect(html).not.toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*<button/);
  });
});

describe("landing — motion is off under prefers-reduced-motion", () => {
  it("the page: every reveal is settled and nothing transitions or animates", () => {
    expect(rules).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.site-rv, \.site-st \{ opacity:1 !important; translate:none !important; scale:none !important; \}\s*\.cnpy-site \*, \.cnpy-site \*::before, \.cnpy-site \*::after \{ transition:none !important; animation:none !important; \}/);
  });
  it("the sign-in dialog, which sits outside the page", () => {
    expect(rules).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.site-signin-back, \.site-signin-card, \.site-signin-x, \.site-signin-btn \{ animation:none !important; transition:none !important; \} \}/);
  });
});

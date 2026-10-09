/**
 * The signed-out landing page (web/src/landing.ts): what it must keep saying, and the
 * banner it carries through the page (the first-run card's, one definition in trov.css).
 */
import { describe, it, expect } from "vitest";
import { landingView } from "../web/src/landing";
import { initialState, render } from "../web/src/render";
import css from "../web/src/trov.css?raw";
import motionSrc from "../web/src/landing-motion.ts?raw";
import mainSrc from "../web/src/main.ts?raw";
import featureSrc from "../web/src/site-feature.ts?raw";
import { jumping, noteJump, revealClass } from "../web/src/landing-motion";

const out = (signInOpen = false, signedIn = false, seen: string[] = []) =>
  landingView({ dark: false, signInOpen, signedIn, seen: new Set(seen) });
const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("landing — the facts it states", () => {
  it("sign-up is open: GitHub or Google, no invitation — said once, and nothing on the page contradicts it", () => {
    const html = out(true);
    expect(html).toContain("Sign up with GitHub or Google. No invitation needed.</p>");
    expect(html.match(/No invitation needed/g)?.length).toBe(1);
    expect(html).toContain("New to Trov? Either one creates your account.</div>");
    for (const gone of ["restricted to your org", "needs an invitation", "invite-only", "by invitation"]) expect(html).not.toContain(gone);
  });

  it("the help page is the Guide, never Get Started", () => {
    for (const html of [out(), out(false, true)]) {
      expect(html).not.toMatch(/Get started|Get Started/);
      expect(html).toContain("How Trov works, in the Guide");
    }
    // Signed out, the hero's first button opens Sign in; reopened from the app, it opens the Guide.
    expect(out()).toContain('<button data-act="openSignIn" class="site-btn site-btn-onb">Start for free</button>');
    expect(out(false, true)).toContain('<button data-act="siteGuide" class="site-btn site-btn-onb">Open the Guide</button>');
  });

  it("links the pricing page as a path, and restates no price outside the pricing section", () => {
    const html = out();
    expect(html).toContain('<a href="/pricing">Pricing</a>');
    expect(html.slice(0, html.indexOf('id="site-pricing"'))).not.toMatch(/\$\d/);
  });

  it("says each thing once: the page above the plans is not repeated under them", () => {
    const html = out(true);
    // Who may confirm what: the rule on the authority card, the list of person-only verdicts in Security.
    expect(html.match(/Only a person can ratify/g)?.length).toBe(1);
    expect(html).toContain("Only a person can ratify a decision or an artifact, or publish a prompt.");
    expect(html.match(/only exist in the signed-in web app/g)?.length).toBe(1);
    expect(html).not.toContain("Only a signed-in person sees these buttons");
    // Whose data it is: the pricing Questions answer it, so Security does not.
    expect(html.match(/only its members and the agents they connect can read it/g)?.length).toBe(1);
    const security = html.slice(html.indexOf('id="site-security"'), html.indexOf('id="site-pricing"'));
    expect(security).not.toMatch(/its members|sign up|Sign-in with/i);
    expect(security.match(/class="site-check"/g)?.length).toBe(7);
    // No section restates its own heading, and no card its own title.
    expect(html).not.toContain("The loop that keeps the store current");
    expect(html).not.toContain("Two themes, or follow your system");
    expect(html).not.toContain("installed in two commands");
    // The install commands: once, in the plugin card.
    expect(html.match(/\/plugin marketplace add/g)?.length).toBe(1);
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
    // Dark: the banner follows the theme's accent (the green mark), on the site AND the first-run cards — one rule.
    expect(rules).toMatch(/\[data-cnpy-theme="dark"\] \.site-banner, \[data-cnpy-theme="dark"\] \.cnpy-orgs-banner \{[^}]*linear-gradient\(135deg, #73844a 0%, #5d6d37 48%, #485628 100%\)/);
    // …and the glows behind the cards take the mark's colour from the theme, not a fixed purple.
    expect(rules).not.toMatch(/color-mix\(in srgb, #616acb /);
    expect(rules.match(/color-mix\(in srgb, var\(--mark, #616acb\) /g)?.length).toBeGreaterThanOrEqual(3);
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
    // The two buttons are a narrow centred pair with the "or" rule between them (not full-width bars).
    expect(html).toMatch(/Continue with GitHub<\/button>\s*<div class="site-signin-or" aria-hidden="true"><span><\/span>or<span><\/span><\/div>\s*<button data-act="signInGoogle"/);
    expect(rules).toContain(".site-signin-body > * { width:100%; max-width:280px; }");
    // A bannered card has no border (it showed as a pale frame round the banner): its edge is a ring in the shadow.
    expect(rules).toMatch(/\.site-signin-card \{[^}]*border:0;[^}]*box-shadow:0 0 0 1px rgba\(20,22,60,\.07\),/);
    expect(rules).toMatch(/\.site-split \{[^}]*border:0;/);
    expect(rules).toContain(".cnpy-surface.cnpy-orgs-card { border:0; }");
    expect(html).not.toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*<button/);
  });
});

describe("landing — moving through the page", () => {
  it("a reveal is short and small, on the site's one clock", () => {
    expect(rules).toContain(".site-rv { opacity:0; --from:0 10px; translate:var(--from); }");
    expect(rules).toContain(".site-rv.rv-l { --from:-12px 0; }");
    expect(rules).toContain(".site-rv.rv-lift { --from:0 14px; scale:.99; }");
    expect(rules).toContain(".site-st { opacity:0; --from:0 6px; translate:var(--from); }");
    expect(rules).toMatch(/\.site-rv\.is-play, \.is-play \.site-st \{\s*transition: opacity var\(--fx-slow\) var\(--fx-ease\) var\(--d, 0ms\), translate var\(--fx-slow\) var\(--fx-ease\) var\(--d, 0ms\), scale var\(--fx-slow\) var\(--fx-ease\) var\(--d, 0ms\),/);
    // No reveal travels further than 14px.
    for (const m of rules.matchAll(/\.site-(?:rv|st)[.\w-]* \{[^}]*--from:([^;]+);/g)) for (const px of m[1].matchAll(/(-?\d+)px/g)) expect(Math.abs(Number(px[1])), m[0]).toBeLessThanOrEqual(14);
  });
  it("is played once, a little before it enters, and settled with no motion while a nav jump carries the page", () => {
    expect(motionSrc).toContain('{ rootMargin: "0px 0px 6% 0px", threshold: 0 }');
    expect(motionSrc).toContain("obs.unobserve(el);");
    expect(revealClass(false)).toBe("is-play");
    expect(revealClass(true)).toBe("is-done");
    noteJump(1000);
    expect(jumping(1000)).toBe(true);
    expect(jumping(2199)).toBe(true);
    expect(jumping(2200)).toBe(false);
  });
  it("a nav jump is ONE scroll that lands its heading under the sticky nav, instant under reduced motion", () => {
    expect(rules).toContain('.cnpy-site section[id^="site-"] { scroll-margin-top:-58px; }');
    const jump = mainSrc.slice(mainSrc.indexOf('case "siteJump"'), mainSrc.indexOf('case "backToLogin"'));
    expect(jump).toContain('matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"');
    expect(jump).toContain("noteJump();");
    expect(jump.match(/scrollTo\(|scrollIntoView\(/g)?.length).toBe(2); // top, or one target: never both
    expect(rules).not.toMatch(/scroll-behavior\s*:\s*smooth/);
  });
  it("nothing else moves the page: the dialogs take focus without scrolling", () => {
    expect(featureSrc.match(/\.focus\(/g)?.length).toBe(featureSrc.match(/\.focus\(\{ preventScroll: true \}\)|to\.focus\(\)/g)?.length);
    expect(featureSrc).not.toMatch(/scrollTo|scrollIntoView/);
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

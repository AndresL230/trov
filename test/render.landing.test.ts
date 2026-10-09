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
    expect(html).toMatch(/New to Trov\? <button type="button" data-act="openSignIn" data-arg="signup"[^>]*>Create an account<\/button>/);
    for (const gone of ["restricted to your org", "needs an invitation", "invite-only", "by invitation"]) expect(html).not.toContain(gone);
  });

  it("the help page is the Guide: nothing calls it Get Started; \"Get started\" is the sign-up button's label only", () => {
    for (const html of [out(), out(false, true)]) {
      expect(html).not.toContain("Get Started"); // the help page's old name
      expect(html).toContain("How Trov works, in the Guide");
    }
    // Signed out, "Get started" is exactly the two buttons that open the dialog's plan choice (nav, hero);
    // reopened from the app there is none, and the hero opens the Guide.
    expect(out().match(/Get started/g)).toHaveLength(2);
    expect(out().match(/data-act="openSignIn" data-arg="signup"[^>]*>Get started</g)).toHaveLength(2);
    expect(out(false, true)).not.toContain("Get started");
    expect(out()).toContain('<button data-act="openSignIn" data-arg="signup" class="site-btn site-btn-onb">Get started</button>');
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
  it("the hero and the authority card are the same banner, each with the mark behind its text; the sign-in dialog has none", () => {
    const html = out(true);
    expect(html.match(/class="site-banner /g)?.length).toBe(2);
    expect(html.match(/class="site-banner-art" aria-hidden="true"/g)?.length).toBe(2);
    expect(html).toContain('class="site-banner site-hero-band"');
    expect(html).toContain('class="site-banner site-split-banner"');
    // The dialog opens over the hero, which IS the banner: a plain card, not the same slab twice.
    expect(html).not.toContain("site-signin-banner");
    expect(html).toMatch(/<div class="site-signin-head">[\s\S]*?<h2 id="signin-title"[^>]*>Sign in to Trov<\/h2>/);
    // ONE dialog for both, but it says what the visitor came to do: the nav's Sign in, or a Start-for-free button.
    expect(html).toContain('data-overlay="signin" data-signin-mode="signin"');
    expect(html).toMatch(/<button data-act="openSignIn" data-arg="signup" class="site-btn site-btn-onb">Get started<\/button>/);
    const signup = landingView({ dark: false, signInOpen: true, signInMode: "signup", seen: new Set() });
    expect(signup).toContain('data-signin-mode="signup"');
    expect(signup).toMatch(/<h2 id="signin-title"[^>]*>Get started with Trov<\/h2>/);
    // Getting started is a choice of plan first: Free (the two providers) or Pro (the billing route). The
    // numbers are the pricing data's own.
    expect(signup).toContain('data-signin-plan="free"');
    expect(signup).toMatch(/data-seg="signin-plan"[\s\S]*?>Free<[\s\S]*?>Pro</);
    expect(signup).toMatch(/<p class="site-signin-plan-what"><b>Free<\/b> &middot; up to 3 people\. <a href="\/pricing">Compare plans<\/a><\/p>/);
    const pro = landingView({ dark: false, signInOpen: true, signInMode: "signup", signInPlan: "team", seen: new Set() });
    expect(pro).toMatch(/<p class="site-signin-plan-what"><b>\$10 per seat \/ month<\/b> &middot; up to 50 people\./);
    // Pro is the same two buttons: each is the billing route with the provider already picked, so signing in
    // carries straight on to payment.
    expect(pro).toMatch(/<a href="\/billing\/start\?plan=team&via=github" data-field="signInProGithub"[^>]*>[\s\S]*?Continue with GitHub<\/a>/);
    expect(pro).toMatch(/<a href="\/billing\/start\?plan=team&via=google" data-field="signInProGoogle"[^>]*>[\s\S]*?Continue with Google<\/a>/);
    expect(pro).not.toContain("Continue with Pro");
    // A signed-out buyer the billing route sends back (`/?start=team`) lands on this same dialog, on Pro.
    expect(mainSrc).toContain('if (params.get("start") === "team") {');
    expect(pro).not.toContain('data-act="signIn"'); // not the plain sign-in: that would lose the purchase
    expect(html).not.toContain("site-signin-plans");   // signing in: nothing to choose
    expect(signup).not.toContain(">Sign in to Trov<");
    expect(signup).toMatch(/Already have an account\? <button type="button" data-act="openSignIn" data-arg="signin"[^>]*>Sign in<\/button>/);
    // The nav says the two apart as well: a quiet Sign in, and the accent Get started (the hero's label).
    expect(out()).toMatch(/<button data-act="openSignIn" data-field="navSignIn" class="site-nav-signin"[^>]*>Sign in<\/button>\s*<button data-act="openSignIn" data-arg="signup" data-field="navStart" class="cnpy-accentbtn"[^>]*>Get started<\/button>/);
    expect(out(false, true)).not.toContain("navStart"); // reopened from inside the app: only the way back
    expect(out(false, true)).toContain(">Back to the app</button>");
    // The same two providers either way.
    for (const d of [html, signup]) expect(d).toMatch(/Continue with GitHub<\/button>[\s\S]*Continue with Google<\/button>/);
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
    expect(open).toContain('<div data-overlay="signin" data-signin-mode="signin">');
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
